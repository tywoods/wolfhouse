#!/usr/bin/env node
'use strict';

/**
 * Lookout lane detectors — France Wolfhouse staging.
 *
 * Covers PLAN.md section 11 proofs that this lane can lock in code (the rest
 * are Bug Finder / Deckhand / Skip):
 *   1 Kathi-shape owed hint (not a resend)
 *   3 silence when Luna is down
 *   4 send-failed capture
 *   6 90s Luna reply is not silence
 *   11 owed hint never owed-only resend; confirmation stays a hint
 *   14 repeated scans after capture are duplicates, not new work
 *   15 duplicate scans / two workers; crash between source and capture
 *   17 revision: new failure identity is captured once
 *   18 old uncaptured (>24h) recovered from checkpoint, not abandoned
 *
 * Offline. No Staff host, no webhook, no guest send.
 *
 *   node scripts/verify-luna-supervisor-lookout-detectors.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const DETECTOR_PATH = path.join(ROOT, 'scripts/lib/luna-supervisor-lookout-detectors.js');
const d = require('./lib/luna-supervisor-lookout-detectors');

const PIN = { environment: 'staging', runtime: 'wolfhouse', client_slug: 'wolfhouse' };
const NOW = new Date('2026-11-01T22:00:00.000Z');

function ok(name, cond, extra) {
  if (cond) {
    console.log(`  PASS  ${name}`);
    return;
  }
  const detail = extra ? ` :: ${extra}` : '';
  throw new Error(`FAIL  ${name}${detail}`);
}

function minutesAgo(n, now) {
  return new Date(now.getTime() - n * 60 * 1000).toISOString();
}

function makeInbox() {
  const byKey = new Map();
  let seq = 0;
  return {
    byKey,
    async capture(event) {
      if (!event || !event.source_key) return { error: 'missing_source_key' };
      if (byKey.has(event.source_key)) {
        const existing = byKey.get(event.source_key);
        return { inserted: false, duplicate: true, id: existing.id };
      }
      seq += 1;
      const row = { id: `evt-${seq}`, ...event };
      byKey.set(event.source_key, row);
      return { inserted: true, duplicate: false, id: row.id };
    },
  };
}

function makeCheckpoints() {
  const m = new Map();
  return {
    m,
    async get(name) { return m.has(name) ? m.get(name) : null; },
    async set(name, value) { m.set(name, value); },
  };
}

function sendSpy() {
  const spy = async function sendReply() {
    spy.calls.push(Array.from(arguments));
    throw new Error('owed-only resend is forbidden');
  };
  spy.calls = [];
  return spy;
}

function baseCtx(overrides) {
  return {
    pin: PIN,
    now: NOW,
    batchSize: 50,
    eventInbox: makeInbox(),
    checkpoints: makeCheckpoints(),
    sendReply: sendSpy(),
    sources: {
      silence: async () => [],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    },
    ...overrides,
  };
}

async function run() {
  const src = fs.readFileSync(DETECTOR_PATH, 'utf8');

  console.log('[0] File ownership and no-send invariants');
  ok('detector module exists', fs.existsSync(DETECTOR_PATH));
  ok('does not require staff-query-api', !/staff-query-api/.test(src));
  ok('does not POST a webhook', !/https?:\/\//.test(src) && !/\bfetch\(/.test(src) && !/\bhttp\.request/.test(src));
  ok('does not call inbox send-reply', !/inbox\/send-reply/.test(src));
  ok('does not generate payment links', !/generate-payment-link/.test(src));
  ok('does not UPDATE/INSERT owed rows', !/UPDATE booking_confirmation_owed/i.test(src) && !/INSERT INTO booking_confirmation_owed/i.test(src));
  ok('silence SQL is SELECT-only', d.sqlIsSelectOnly(d.SILENCE_SQL));
  ok('owed SQL is SELECT-only', d.sqlIsSelectOnly(d.OWED_HINT_SQL));
  ok('send-failed SQL is SELECT-only', d.sqlIsSelectOnly(d.SEND_FAILED_SQL));
  ok('silence SQL uses 2 minutes, not a 24h recovery bound',
    /created_at <= \$2/i.test(d.SILENCE_SQL) && !/24 hours|interval '24/i.test(d.SILENCE_SQL));
  ok('owed SQL requires open row (cleared_at IS NULL) and 60s due stamp',
    /cleared_at IS NULL/.test(d.OWED_HINT_SQL) && /owed_at <= \$2/.test(d.OWED_HINT_SQL));
  ok('owed SQL never orders a resend', !/resend/i.test(d.OWED_HINT_SQL));
  ok('prod pin refused', d.pinOrRefuse({ environment: 'prod', runtime: 'wolfhouse', client_slug: 'wolfhouse' }).reason === 'prod_refused');
  ok('unpinned runtime refused', d.pinOrRefuse({ environment: 'staging', runtime: 'sunset', client_slug: 'sunset' }).ok === false);

  console.log('\n[1] Silence — 2 min unanswered captures once; 90s does not');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [{
          conversation_id: 'c1',
          client_id: 'cl1',
          client_slug: 'wolfhouse',
          guest_message_id: 'm-guest-1',
          guest_created_at: minutesAgo(3, NOW),
        }],
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('scan ok', out.ok === true);
    ok('one silence event', out.events.length === 1 && out.events[0].kind === d.KIND_SILENCE);
    ok('wake supervisor', out.events[0].wake_supervisor === true);
    ok('obligation silence', out.events[0].obligation === 'silence');
    ok('source_key pinned to staging:wolfhouse', out.events[0].source_key.startsWith('staging:wolfhouse:silence:m-guest-1:'));
    ok('no webhook posts', out.webhook_posts === 0);
    ok('sendReply unused', ctx.sendReply.calls.length === 0);
  }
  {
    ok('90s is not due', d.isSilenceDue(minutesAgo(1.5, NOW), NOW) === false);
    ok('2 min is due', d.isSilenceDue(minutesAgo(2, NOW), NOW) === true);
    const ctx = baseCtx({
      sources: {
        silence: async () => [{
          conversation_id: 'c1',
          client_id: 'cl1',
          client_slug: 'wolfhouse',
          guest_message_id: 'm-young',
          guest_created_at: minutesAgo(1.5, NOW),
        }],
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('90s guest does not capture silence', out.events.length === 0);
    ok('checkpoint not advanced past not-due silence', (await ctx.checkpoints.get(d.SOURCE_SILENCE)) == null);
  }

  console.log('\n[2] Owed hint — 60s open row wakes as hint; never resends');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [{
          booking_id: 'b-owed-1',
          client_id: 'cl1',
          client_slug: 'wolfhouse',
          booking_code: 'WH-KATHI-1',
          owed_at: minutesAgo(2, NOW),
          provider_message_id: null,
        }],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('one owed hint', out.events.length === 1 && ev.kind === d.KIND_OWED_HINT);
    ok('hint_only true', ev.hint_only === true && ev.payload.hint_only === true);
    ok('automatic_resend false', ev.automatic_resend === false && ev.payload.automatic_resend === false);
    ok('open row does not prove nothing was sent', ev.payload.open_row_does_not_prove_nothing_was_sent === true);
    ok('booking ref present', ev.booking_ref === 'WH-KATHI-1');
    ok('reason forbids owed-only resend', /no automatic resend/i.test(ev.reason));
    ok('sendReply unused on owed hint', ctx.sendReply.calls.length === 0);
    ok('automatic_resends counter is 0', out.automatic_resends === 0);
  }
  {
    ok('30s owed is not due', d.isOwedHintDue(minutesAgo(0.5, NOW), NOW) === false);
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [{
          booking_id: 'b-early',
          client_id: 'cl1',
          client_slug: 'wolfhouse',
          booking_code: 'WH-EARLY',
          owed_at: minutesAgo(0.5, NOW),
        }],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('30s owed does not capture', out.events.length === 0);
    ok('sendReply still unused', ctx.sendReply.calls.length === 0);
  }

  console.log('\n[3] Undelivered — blocked/failed sends; supervisor descendant does not re-wake');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [{
          send_id: 's-fail-1',
          client_slug: 'wolfhouse',
          status: 'blocked',
          blocked_reasons: ['whatsapp_send_failed'],
          idempotency_key: 'luna:turn:99',
          send_kind: 'confirmation',
          source: 'hermes_luna',
          to_phone: '+34600000001',
          provider_message_id: null,
          updated_at: minutesAgo(1, NOW),
        }],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('send-failed kind', ev.kind === d.KIND_SEND_FAILED_GUEST_MESSAGE_SENDS);
    ok('confirmation obligation', ev.obligation === 'confirmation');
    ok('wakes supervisor', ev.wake_supervisor === true);
    ok('never auto resend', ev.automatic_resend === false);
  }
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [{
          send_id: 's-sup-1',
          client_slug: 'wolfhouse',
          status: 'failed',
          blocked_reasons: ['supervisor send failed'],
          idempotency_key: 'supervisor:inc-42:send-1',
          send_kind: 'confirmation',
          source: 'supervisor',
          updated_at: minutesAgo(1, NOW),
        }],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('supervisor descendant does not wake', ev.wake_supervisor === false);
    ok('cause_incident_id from key', ev.cause_incident_id === 'inc-42');
  }
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [{
          send_id: 's-inbox-1',
          client_slug: 'wolfhouse',
          status: 'failed',
          blocked_reasons: ['provider'],
          idempotency_key: 'inbox:1',
          send_kind: 'reply',
          source: 'staff_inbox_reply',
          updated_at: minutesAgo(1, NOW),
        }],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('inbox send-reply failures get their own kind', out.events[0].kind === d.KIND_SEND_FAILED_INBOX_REPLY);
  }

  console.log('\n[4] Duplicate scans / two workers share source_key (proof 14, 15)');
  {
    const silenceRow = {
      conversation_id: 'c1',
      client_id: 'cl1',
      client_slug: 'wolfhouse',
      guest_message_id: 'm-dup',
      guest_created_at: minutesAgo(5, NOW),
    };
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sources = {
      silence: async () => [silenceRow],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    };
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('first insert', first.events.length === 1);
    ok('second scan still emits the same source_key', second.events.length === 1 && second.events[0].source_key === first.events[0].source_key);
    ok('inbox stored one row', inbox.byKey.size === 1);
    ok('second capture was duplicate', second.sources.silence.results[0].duplicate === true);
  }
  {
    const row = {
      conversation_id: 'c2',
      client_id: 'cl1',
      client_slug: 'wolfhouse',
      guest_message_id: 'm-race',
      guest_created_at: minutesAgo(5, NOW),
    };
    const inbox = makeInbox();
    const sources = {
      silence: async () => [row],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    };
    const [a, b] = await Promise.all([
      d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints: makeCheckpoints(), sources })),
      d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints: makeCheckpoints(), sources })),
    ]);
    ok('two workers one inbox row', inbox.byKey.size === 1);
    ok('same source_key both workers', a.events[0].source_key === b.events[0].source_key);
  }

  console.log('\n[5] Crash between source write and capture; checkpoint only after capture (proof 15)');
  {
    const row = {
      conversation_id: 'c3',
      client_id: 'cl1',
      client_slug: 'wolfhouse',
      guest_message_id: 'm-crash',
      guest_created_at: minutesAgo(8, NOW),
    };
    const checkpoints = makeCheckpoints();
    let captures = 0;
    const inbox = {
      byKey: new Map(),
      async capture(event) {
        captures += 1;
        if (captures === 1) return { error: 'boom' };
        this.byKey.set(event.source_key, event);
        return { inserted: true, duplicate: false, id: 'evt-after-crash' };
      },
    };
    const sources = {
      silence: async () => [row],
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    };
    const failed = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('first scan does not claim success', failed.ok === false);
    ok('checkpoint not advanced on capture failure', (await checkpoints.get(d.SOURCE_SILENCE)) == null);
    const recovered = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('catch-up captures after crash', recovered.ok === true && inbox.byKey.size === 1);
    ok('checkpoint advances only after capture', (await checkpoints.get(d.SOURCE_SILENCE)).id === 'm-crash');
  }

  console.log('\n[6] Batch size bounds catch-up; remaining rows stay (14.4)');
  {
    const rows = [1, 2, 3].map((n) => ({
      conversation_id: 'c-batch',
      client_id: 'cl1',
      client_slug: 'wolfhouse',
      guest_message_id: `m-batch-${n}`,
      guest_created_at: minutesAgo(10 - n, NOW),
    }));
    let seenCursor = null;
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sources = {
      silence: async ({ cursor }) => {
        seenCursor = cursor;
        const start = cursor && cursor.id
          ? rows.findIndex((r) => r.guest_message_id === cursor.id) + 1
          : 0;
        return rows.slice(Math.max(0, start), Math.max(0, start) + 1);
      },
      owedHint: async () => [],
      sendFailed: async () => [],
      waFailed: async () => [],
    };
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('batch 1 captured one', first.events.length === 1 && first.events[0].cause_id === 'm-batch-1');
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('next batch resumes after checkpoint', second.events[0].cause_id === 'm-batch-2');
    ok('cursor was supplied on second scan', seenCursor && seenCursor.id === 'm-batch-1');
  }

  console.log('\n[7] Old uncaptured event is not abandoned after 24h (proof 18)');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [{
          conversation_id: 'c-old',
          client_id: 'cl1',
          client_slug: 'wolfhouse',
          guest_message_id: 'm-old-36h',
          guest_created_at: minutesAgo(36 * 60, NOW),
        }],
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('36h unanswered guest is still captured', out.events.length === 1 && out.events[0].cause_id === 'm-old-36h');
    ok('SQL has no 24h recovery WHERE', !/24 hours|interval '24/i.test(d.SILENCE_SQL + d.OWED_HINT_SQL + d.SEND_FAILED_SQL));
  }

  console.log('\n[8] Missing tables: required source is a visible gap; optional WA is not needs-human spam (proof 18)');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => {
          const err = new Error('relation "whatsapp_status_events" does not exist');
          err.code = '42P01';
          throw err;
        },
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('wa table missing is unavailable, not claimed coverage',
      out.sources.wa_status.unavailable === true && out.sources.wa_status.claimed_coverage === false);
    ok('optional WA missing does not post capture_gap',
      !out.events.some((e) => e.kind === d.KIND_CAPTURE_GAP));
    ok('other sources still ran', out.sources.silence.ok === true && out.sources.send_failed.ok === true);
  }
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => {
          const err = new Error('relation "messages" does not exist');
          err.code = '42P01';
          throw err;
        },
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => [],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const gap = out.events.find((e) => e.kind === d.KIND_CAPTURE_GAP);
    ok('required silence table missing posts capture_gap', !!gap && gap.payload.source_name === d.SOURCE_SILENCE);
    ok('gap does not wake supervisor', gap.wake_supervisor === false);
    ok('claimed_coverage is false', out.sources.silence.claimed_coverage === false);
  }

  console.log('\n[9] Revision identity — same row new failure is new work; repeat is not (proof 17)');
  {
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const v1 = {
      send_id: 's-rev',
      client_slug: 'wolfhouse',
      status: 'blocked',
      blocked_reasons: ['needs_human:missing_fact'],
      idempotency_key: 'luna:1',
      send_kind: 'reply',
      source: 'hermes_luna',
      updated_at: minutesAgo(3, NOW),
    };
    const v2 = {
      ...v1,
      blocked_reasons: ['needs_human:payment_failed'],
      updated_at: minutesAgo(1, NOW),
    };
    const scan = (row) => d.runLookoutDetectorScan(baseCtx({
      eventInbox: inbox,
      checkpoints,
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [row],
        waFailed: async () => [],
      },
    }));
    const first = await scan(v1);
    const second = await scan(v1);
    const third = await scan(v2);
    ok('first revision inserted', first.sources.send_failed.results[0].duplicate !== true);
    ok('repeat same revision is duplicate', second.sources.send_failed.results[0].duplicate === true);
    ok('new reason is a new source_key', third.events[0].source_key !== first.events[0].source_key);
    ok('two inbox rows for two revisions', inbox.byKey.size === 2);
  }

  console.log('\n[10] WA failed status captures without granting resend');
  {
    const ctx = baseCtx({
      sources: {
        silence: async () => [],
        owedHint: async () => [],
        sendFailed: async () => [],
        waFailed: async () => [{
          status_id: 'wa-1',
          provider_message_id: 'wamid.ABC',
          status: 'failed',
          received_at: minutesAgo(1, NOW),
          conversation_id: 'c-wa',
          client_id: 'cl1',
        }],
      },
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('wa failed kind', ev.kind === d.KIND_SEND_FAILED_WA_STATUS);
    ok('no correlation never permission to resend', ev.payload.no_correlation_never_permission_to_resend === true);
    ok('automatic_resend false', ev.automatic_resend === false);
  }

  console.log('\n[11] Missing inbox/checkpoints refuse visibly; no silent skip');
  {
    const noInbox = await d.runLookoutDetectorScan({ pin: PIN, checkpoints: makeCheckpoints(), now: NOW });
    ok('missing inbox is visible', noInbox.ok === false && noInbox.reason === 'event_inbox_required');
    const noCp = await d.runLookoutDetectorScan({ pin: PIN, eventInbox: makeInbox(), now: NOW });
    ok('missing checkpoint store is visible', noCp.ok === false && noCp.reason === 'checkpoint_store_required');
  }

  console.log('\nAll Lookout detector proofs passed.');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
