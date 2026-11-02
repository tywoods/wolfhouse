#!/usr/bin/env node
'use strict';

/**
 * Lookout lane detectors — France Wolfhouse staging.
 *
 * Covers PLAN.md section 11 proofs that this lane can lock in code:
 *   1 Kathi-shape owed hint (not a resend)
 *   3 silence when Luna is down
 *   4 send-failed capture
 *   6 90s Luna reply is not silence
 *   11 owed hint never owed-only resend; confirmation stays a hint
 *   14 repeated scans after capture are duplicates, not new work
 *   15 duplicate scans / two workers; crash between source and capture
 *   17 revision: new failure identity is captured once; A>B>A is three occurrences
 *   18 old uncaptured (>24h) recovered from checkpoint, not abandoned
 *
 * Cap FAIL d4385b6a: pin wolfhouse-somo; authoritative bindings; lossless cursor;
 * durable occurrence keys; cause_incident_id provenance; durable capture ack.
 *
 * Offline. No Staff host, no webhook, no guest send.
 *
 *   node scripts/verify-luna-supervisor-lookout-detectors.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DETECTOR_PATH = path.join(ROOT, 'scripts/lib/luna-supervisor-lookout-detectors.js');
const d = require('./lib/luna-supervisor-lookout-detectors');

const PIN = { environment: 'staging', runtime: 'wolfhouse', client_slug: 'wolfhouse-somo' };
const NOW = new Date('2026-11-01T22:00:00.000Z');
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
        return { inserted: false, duplicate: true, id: existing.id, row: existing };
      }
      seq += 1;
      const row = { id: `evt-${seq}`, ...event };
      byKey.set(event.source_key, row);
      return { inserted: true, duplicate: false, id: row.id, row };
    },
  };
}

function makeStoreInbox() {
  const rows = [];
  const byKey = new Map();
  let seq = 0;
  return {
    rows,
    byKey,
    async capture(event) {
      if (!event || !event.source_key || !event.kind || !event.obligation) {
        return { error: 'supervisor_capture_missing_source_key' };
      }
      if (byKey.has(event.source_key)) {
        return { ok: true, inserted: false, row: byKey.get(event.source_key) };
      }
      const stored = {
        id: `evt-${++seq}`,
        source_key: event.source_key,
        kind: event.kind,
        obligation: event.obligation,
        reason: event.reason || null,
        client_id: event.client_id || null,
        conversation_id: event.conversation_id || null,
        booking_id: event.booking_id || null,
        booking_code: event.booking_code || null,
        cause_incident_id: event.cause_incident_id || null,
        metadata: event.metadata && typeof event.metadata === 'object' ? { ...event.metadata } : {},
      };
      rows.push(stored);
      byKey.set(event.source_key, stored);
      return { ok: true, inserted: true, row: stored };
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

function bindings(extra) {
  return {
    client_id: CLIENT_ID,
    conversation_id: CONV_ID,
    client_slug: 'wolfhouse-somo',
    ...extra,
  };
}

function emptySources(overrides) {
  return {
    silence: async () => [],
    owedHint: async () => [],
    sendFailed: async () => [],
    waFailed: async () => [],
    ...overrides,
  };
}

function baseCtx(overrides) {
  return {
    pin: PIN,
    now: NOW,
    batchSize: 50,
    eventInbox: makeInbox(),
    checkpoints: makeCheckpoints(),
    sendReply: sendSpy(),
    sources: emptySources(),
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
  ok('owed SQL does not use bookings.conversation_id', !/b\.conversation_id/.test(d.OWED_HINT_SQL));
  ok('owed SQL binds conversation via phone or current_hold_booking_id',
    /current_hold_booking_id/.test(d.OWED_HINT_SQL) && /regexp_replace/.test(d.OWED_HINT_SQL));
  ok('send SQL joins clients for tenant UUID', /INNER JOIN clients c/.test(d.SEND_FAILED_SQL));
  ok('send SQL resolves conversation by phone digits', /regexp_replace/.test(d.SEND_FAILED_SQL) && /g\.to_phone/.test(d.SEND_FAILED_SQL));
  ok('send SQL does not guess a booking by phone', !/FROM bookings/.test(d.SEND_FAILED_SQL));
  ok('send SQL skips empty acknowledged ledgers', /jsonb_array_length/.test(d.SEND_FAILED_SQL));
  ok('WA SQL does not MIN an unrelated booking', !/MIN\(b\.id/.test(d.WA_FAILED_SQL) && !/b\.conversation_id/.test(d.WA_FAILED_SQL));
  ok('WA SQL takes booking from the failed send', /g\.provider_response->>'booking_id'/.test(d.WA_FAILED_SQL));
  ok('SQL cursors are lossless to_char microseconds', /HH24:MI:SS\.US/.test(d.SILENCE_SQL) && /HH24:MI:SS\.US/.test(d.SEND_FAILED_SQL));
  ok('prod pin refused', d.pinOrRefuse({ environment: 'prod', runtime: 'wolfhouse', client_slug: 'wolfhouse-somo' }).reason === 'prod_refused');
  ok('unpinned runtime refused', d.pinOrRefuse({ environment: 'staging', runtime: 'sunset', client_slug: 'sunset' }).ok === false);
  ok('sunset runtime refused even with wolfhouse-somo slug',
    d.pinOrRefuse({ environment: 'staging', runtime: 'sunset', client_slug: 'wolfhouse-somo' }).reason === 'sunset_refused');
  ok('legacy wolfhouse slug refused',
    d.pinOrRefuse({ environment: 'staging', runtime: 'wolfhouse', client_slug: 'wolfhouse' }).reason === 'runtime_not_france_wolfhouse_staging');
  ok('canonical pin accepted', d.pinOrRefuse(PIN).ok === true && d.pinOrRefuse(PIN).client_slug === 'wolfhouse-somo');

  console.log('\n[1] Silence — 2 min unanswered captures once; 90s does not');
  {
    const ctx = baseCtx({
      sources: emptySources({
        silence: async () => [bindings({
          guest_message_id: 'm-guest-1',
          guest_created_at: minutesAgo(3, NOW),
        })],
      }),
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
      sources: emptySources({
        silence: async () => [bindings({
          guest_message_id: 'm-young',
          guest_created_at: minutesAgo(1.5, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('90s guest does not capture silence', out.events.length === 0);
    ok('checkpoint not advanced past not-due silence', (await ctx.checkpoints.get(d.SOURCE_SILENCE)) == null);
  }

  console.log('\n[2] Owed hint — 60s open row wakes as hint; never resends; store mapping');
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        owedHint: async () => [bindings({
          booking_id: BOOKING_ID,
          booking_code: 'WH-KATHI-1',
          owed_at: minutesAgo(2, NOW),
          provider_message_id: null,
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('one owed hint', out.events.length === 1 && ev.kind === d.KIND_OWED_HINT);
    ok('hint_only true', ev.hint_only === true && ev.payload.hint_only === true);
    ok('automatic_resend false', ev.automatic_resend === false && ev.payload.automatic_resend === false);
    ok('open row does not prove nothing was sent', ev.payload.open_row_does_not_prove_nothing_was_sent === true);
    ok('booking_code on detector event', ev.booking_code === 'WH-KATHI-1');
    ok('reason forbids owed-only resend', /no automatic resend/i.test(ev.reason));
    ok('sendReply unused on owed hint', ctx.sendReply.calls.length === 0);
    ok('automatic_resends counter is 0', out.automatic_resends === 0);
    const persisted = store.rows[0];
    ok('persisted booking_code not booking_ref', persisted.booking_code === 'WH-KATHI-1' && !Object.hasOwn(persisted, 'booking_ref'));
    ok('persisted metadata not payload', persisted.metadata && persisted.metadata.hint_only === true && !Object.hasOwn(persisted, 'payload'));
    ok('persisted conversation_id and client_id', persisted.conversation_id === CONV_ID && persisted.client_id === CLIENT_ID);
  }
  {
    ok('30s owed is not due', d.isOwedHintDue(minutesAgo(0.5, NOW), NOW) === false);
    const ctx = baseCtx({
      sources: emptySources({
        owedHint: async () => [bindings({
          booking_id: 'b-early',
          booking_code: 'WH-EARLY',
          owed_at: minutesAgo(0.5, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('30s owed does not capture', out.events.length === 0);
    ok('sendReply still unused', ctx.sendReply.calls.length === 0);
  }
  {
    const ctx = baseCtx({
      sources: emptySources({
        owedHint: async () => [{
          booking_id: BOOKING_ID,
          client_id: CLIENT_ID,
          client_slug: 'wolfhouse-somo',
          booking_code: 'WH-NO-CONV',
          owed_at: minutesAgo(2, NOW),
        }],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('owed without conversation is capture_gap, not a weak claim',
      out.events[0].kind === d.KIND_CAPTURE_GAP && /unresolved_conversation_id/.test(out.events[0].reason));
    ok('gap does not wake', out.events[0].wake_supervisor === false);
  }

  console.log('\n[3] Undelivered — blocked/failed sends; supervisor descendant does not re-wake');
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        sendFailed: async () => [bindings({
          send_id: 's-fail-1',
          status: 'sent',
          blocked_reasons: [],
          idempotency_key: 'luna:turn:99',
          send_kind: 'confirmation',
          source: 'hermes_luna',
          to_phone: '+346****0001',
          provider_message_id: null,
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          provider_response: {
            luna_supervisor_event_obligations: [{
              kind: 'luna_send_failed',
              row_id: 's-fail-1',
              revision: 'rev-1',
              send_kind: 'confirmation',
              booking_id: BOOKING_ID,
              booking_code: 'WH-1',
              blocked_reasons: ['whatsapp_send_failed'],
              failure_stage: 'provider',
            }],
          },
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('send-failed kind matches Skip luna_send_failed', ev.kind === d.KIND_LUNA_SEND_FAILED);
    ok('Skip source_key', ev.source_key === `${d.SKIP_ENVIRONMENT}:${d.SKIP_RUNTIME}:${d.KIND_LUNA_SEND_FAILED}:s-fail-1:rev-1`);
    ok('occurrence facts not current sent row', ev.reason.includes('whatsapp_send_failed') && !/ sent:/.test(ev.reason));
    ok('confirmation obligation', ev.obligation === 'confirmation');
    ok('wakes supervisor', ev.wake_supervisor === true);
    ok('never auto resend', ev.automatic_resend === false);
    ok('store kept booking_code and conversation', store.rows[0].booking_code === 'WH-1' && store.rows[0].conversation_id === CONV_ID);
  }
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        sendFailed: async () => [bindings({
          send_id: 's-sup-1',
          status: 'failed',
          blocked_reasons: ['supervisor send failed'],
          idempotency_key: 'supervisor:inc-42:send-1',
          send_kind: 'confirmation',
          source: 'hermes_luna',
          booking_id: BOOKING_ID,
          booking_code: 'WH-1',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('supervisor descendant does not wake', ev.wake_supervisor === false);
    ok('cause_incident_id from key even when source is not Supervisor', ev.cause_incident_id === 'inc-42');
    ok('persisted cause_incident_id (dispatcher stop)', store.rows[0].cause_incident_id === 'inc-42');
  }
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        sendFailed: async () => [bindings({
          send_id: 's-cause-1',
          status: 'failed',
          blocked_reasons: ['provider'],
          idempotency_key: 'luna:1',
          send_kind: 'reply',
          source: 'hermes_luna',
          cause_incident_id: 'inc-explicit',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('explicit cause is kept without Supervisor source', out.events[0].cause_incident_id === 'inc-explicit');
    ok('explicit cause does not wake', out.events[0].wake_supervisor === false);
    ok('store cause_incident_id is the dispatch signal', store.rows[0].cause_incident_id === 'inc-explicit');
  }
  {
    const ctx = baseCtx({
      sources: emptySources({
        sendFailed: async () => [bindings({
          send_id: 's-inbox-1',
          status: 'failed',
          blocked_reasons: ['provider'],
          idempotency_key: 'inbox:1',
          send_kind: 'reply',
          source: 'staff_inbox_reply',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('inbox send-reply failures without a ledger are a diagnostic gap', out.events[0].kind === d.KIND_CAPTURE_GAP);
    ok('inbox gap does not wake', out.events[0].wake_supervisor === false);
  }
  {
    const ctx = baseCtx({
      sources: emptySources({
        sendFailed: async () => [{
          send_id: 's-unbound',
          client_slug: 'wolfhouse-somo',
          status: 'failed',
          blocked_reasons: ['provider'],
          idempotency_key: 'luna:x',
          send_kind: 'confirmation',
          source: 'hermes_luna',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
        }],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('unbound confirmation send is a visible gap, not a weak claim',
      out.events[0].kind === d.KIND_CAPTURE_GAP && out.events[0].wake_supervisor === false);
  }

  console.log('\n[4] Duplicate scans / two workers share source_key (proof 14, 15)');
  {
    const silenceRow = bindings({
      guest_message_id: 'm-dup',
      guest_created_at: minutesAgo(5, NOW),
    });
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sources = emptySources({ silence: async () => [silenceRow] });
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('first insert', first.events.length === 1);
    ok('second scan still emits the same source_key', second.events.length === 1 && second.events[0].source_key === first.events[0].source_key);
    ok('inbox stored one row', inbox.byKey.size === 1);
    ok('second capture was duplicate', second.sources.silence.results[0].duplicate === true);
  }
  {
    const row = bindings({
      guest_message_id: 'm-race',
      guest_created_at: minutesAgo(5, NOW),
    });
    const inbox = makeInbox();
    const sources = emptySources({ silence: async () => [row] });
    const [a, b] = await Promise.all([
      d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints: makeCheckpoints(), sources })),
      d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints: makeCheckpoints(), sources })),
    ]);
    ok('two workers one inbox row', inbox.byKey.size === 1);
    ok('same source_key both workers', a.events[0].source_key === b.events[0].source_key);
  }

  console.log('\n[5] Crash between source write and capture; checkpoint only after durable ack (proof 15)');
  {
    const row = bindings({
      guest_message_id: 'm-crash',
      guest_created_at: minutesAgo(8, NOW),
    });
    const checkpoints = makeCheckpoints();
    let captures = 0;
    const inbox = {
      byKey: new Map(),
      async capture(event) {
        captures += 1;
        if (captures === 1) return { error: 'boom' };
        this.byKey.set(event.source_key, event);
        return { inserted: true, duplicate: false, id: 'evt-after-crash', row: event };
      },
    };
    const sources = emptySources({ silence: async () => [row] });
    const failed = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('first scan does not claim success', failed.ok === false);
    ok('checkpoint not advanced on capture failure', (await checkpoints.get(d.SOURCE_SILENCE)) == null);
    const recovered = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('catch-up captures after crash', recovered.ok === true && inbox.byKey.size === 1);
    ok('checkpoint advances only after capture', (await checkpoints.get(d.SOURCE_SILENCE)).id === 'm-crash');
  }
  {
    const checkpoints = makeCheckpoints();
    const inbox = {
      async capture() { return { error: 'gap-write-failed' }; },
    };
    const ctx = baseCtx({
      eventInbox: inbox,
      checkpoints,
      sources: emptySources({
        silence: async () => {
          const err = new Error('relation "messages" does not exist');
          err.code = '42P01';
          throw err;
        },
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('failed gap capture is not ok', out.ok === false);
    ok('unconfirmed gap does not advance checkpoint', (await checkpoints.get(d.SOURCE_SILENCE)) == null);
    ok('claimed_coverage stays false', out.sources.silence.claimed_coverage === false);
  }

  console.log('\n[6] Batch size bounds catch-up; lossless sub-ms cursor (14.4)');
  {
    const rows = [
      bindings({ guest_message_id: 'm-batch-1', guest_created_at: '2026-11-01T21:50:00.000400Z', cursor_ts: '2026-11-01T21:50:00.000400Z' }),
      bindings({ guest_message_id: 'm-batch-2', guest_created_at: '2026-11-01T21:50:00.000800Z', cursor_ts: '2026-11-01T21:50:00.000800Z' }),
      bindings({ guest_message_id: 'm-batch-3', guest_created_at: '2026-11-01T21:50:00.001200Z', cursor_ts: '2026-11-01T21:50:00.001200Z' }),
    ];
    let seenCursor = null;
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sources = emptySources({
      silence: async ({ cursor }) => {
        seenCursor = cursor;
        const start = cursor && cursor.id
          ? rows.findIndex((r) => r.guest_message_id === cursor.id) + 1
          : 0;
        return rows.slice(Math.max(0, start), Math.max(0, start) + 1);
      },
    });
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('batch 1 captured one', first.events.length === 1 && first.events[0].cause_id === 'm-batch-1');
    const cp = await checkpoints.get(d.SOURCE_SILENCE);
    ok('checkpoint keeps microsecond cursor, not JS Date', cp.ts === '2026-11-01T21:50:00.000400Z' && !(cp.ts instanceof Date));
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('next batch resumes after lossless checkpoint', second.events[0].cause_id === 'm-batch-2');
    ok('cursor was supplied on second scan', seenCursor && seenCursor.id === 'm-batch-1' && seenCursor.ts === '2026-11-01T21:50:00.000400Z');
  }

  console.log('\n[7] Old uncaptured event is not abandoned after 24h (proof 18)');
  {
    const ctx = baseCtx({
      sources: emptySources({
        silence: async () => [bindings({
          guest_message_id: 'm-old-36h',
          guest_created_at: minutesAgo(36 * 60, NOW),
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('36h unanswered guest is still captured', out.events.length === 1 && out.events[0].cause_id === 'm-old-36h');
    ok('SQL has no 24h recovery WHERE', !/24 hours|interval '24/i.test(d.SILENCE_SQL + d.OWED_HINT_SQL + d.SEND_FAILED_SQL));
  }

  console.log('\n[8] Missing tables: required source is a visible gap; optional WA is not needs-human spam (proof 18)');
  {
    const ctx = baseCtx({
      sources: emptySources({
        waFailed: async () => {
          const err = new Error('relation "whatsapp_status_events" does not exist');
          err.code = '42P01';
          throw err;
        },
      }),
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
      sources: emptySources({
        silence: async () => {
          const err = new Error('relation "messages" does not exist');
          err.code = '42P01';
          throw err;
        },
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const gap = out.events.find((e) => e.kind === d.KIND_CAPTURE_GAP);
    ok('required silence table missing posts capture_gap', !!gap && gap.payload.source_name === d.SOURCE_SILENCE);
    ok('gap does not wake supervisor', gap.wake_supervisor === false);
    ok('claimed_coverage is false', out.sources.silence.claimed_coverage === false);
    ok('successful gap capture is still a durable ack', out.ok === true);
  }

  console.log('\n[9] Occurrence identity — A>B>A is three keys; same ts+row is duplicate (proof 17)');
  {
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sendId = 's-rev';
    const withLedger = (items) => bindings({
      send_id: sendId,
      status: 'sent',
      blocked_reasons: [],
      idempotency_key: 'luna:1',
      send_kind: 'reply',
      source: 'hermes_luna',
      updated_at: '2026-11-01T21:59:00.000300Z',
      cursor_ts: '2026-11-01T21:59:00.000300Z',
      provider_response: { luna_supervisor_event_obligations: items },
    });
    const a = { kind: 'luna_send_failed', row_id: sendId, revision: 't1', send_kind: 'reply', blocked_reasons: ['needs_human:missing_fact'] };
    const b = { kind: 'luna_send_failed', row_id: sendId, revision: 't2', send_kind: 'reply', blocked_reasons: ['needs_human:payment_failed'] };
    const a2 = { kind: 'luna_send_failed', row_id: sendId, revision: 't3', send_kind: 'reply', blocked_reasons: ['needs_human:missing_fact'] };
    const scan = (row) => d.runLookoutDetectorScan(baseCtx({
      eventInbox: inbox,
      checkpoints,
      sources: emptySources({ sendFailed: async () => [row] }),
    }));
    const first = await scan(withLedger([a]));
    const second = await scan(withLedger([a]));
    const third = await scan(withLedger([a, b]));
    const fourth = await scan(withLedger([a, b, a2]));
    ok('first revision inserted', first.sources.send_failed.results[0].duplicate !== true);
    ok('repeat same occurrence is duplicate', second.sources.send_failed.results[0].duplicate === true);
    ok('new occurrence is a new source_key', third.events.some((ev) => ev.source_key !== first.events[0].source_key));
    ok('A>B>A third A is a new occurrence, not collapsed',
      fourth.events.map((ev) => ev.source_key).filter((k, i, all) => all.indexOf(k) === i).length === 3);
    ok('three inbox rows for A>B>A', inbox.byKey.size === 3);
  }

  console.log('\n[10] WA failed status captures without granting resend; keeps cause provenance');
  {
    const ctx = baseCtx({
      sources: emptySources({
        waFailed: async () => [bindings({
          status_id: 'wa-1',
          provider_message_id: 'wamid.ABC',
          status: 'failed',
          received_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          send_kind: 'reply',
          callback_revision: 'cb-1',
          provider_response: {
            luna_supervisor_event_obligations: [{
              kind: 'luna_send_failed',
              row_id: 'wa:wamid.ABC',
              revision: 'cb-1',
              send_kind: 'reply',
              blocked_reasons: ['provider_delivery_failed'],
            }],
          },
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    const ev = out.events[0];
    ok('wa failed kind matches Skip luna_send_failed', ev.kind === d.KIND_LUNA_SEND_FAILED);
    ok('WA Skip row_id', ev.source_key.includes(':wa:wamid.ABC:'));
    ok('ordinary reply is not fabricated confirmation', ev.obligation === 'handoff');
    ok('no correlation never permission to resend', ev.payload.no_correlation_never_permission_to_resend === true);
    ok('automatic_resend false', ev.automatic_resend === false);
  }
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        waFailed: async () => [bindings({
          status_id: 'wa-sup',
          provider_message_id: 'wamid.SUP',
          status: 'failed',
          received_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          send_kind: 'confirmation',
          callback_revision: 'cb-sup',
          provider_response: {
            luna_supervisor_event_obligations: [{
              kind: 'luna_send_failed',
              row_id: 'wa:wamid.SUP',
              revision: 'cb-sup',
              send_kind: 'confirmation',
              cause_incident_id: 'inc-99',
              booking_id: BOOKING_ID,
              booking_code: 'WH-1',
            }],
          },
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('WA of supervisor send does not wake', out.events[0].wake_supervisor === false);
    ok('WA persists cause_incident_id for dispatcher', store.rows[0].cause_incident_id === 'inc-99');
  }

  console.log('\n[11] Missing inbox/checkpoints refuse visibly; no silent skip');
  {
    const noInbox = await d.runLookoutDetectorScan({ pin: PIN, checkpoints: makeCheckpoints(), now: NOW });
    ok('missing inbox is visible', noInbox.ok === false && noInbox.reason === 'event_inbox_required');
    const noCp = await d.runLookoutDetectorScan({ pin: PIN, eventInbox: makeInbox(), now: NOW });
    ok('missing checkpoint store is visible', noCp.ok === false && noCp.reason === 'checkpoint_store_required');
  }

  console.log('\n[12] Cap FAIL 7fe701ea — duplicate ack, Skip keys, obligation identity, gap ancestry');
  {
    ok('{inserted:false,row} is durable ack', d.isDurableCaptureAck({ inserted: false, row: { id: 'evt-1' } }) === true);
    ok('{inserted:false,error} is not ack', d.isDurableCaptureAck({ inserted: false, error: 'nope' }) === false);
    const checkpoints = makeCheckpoints();
    const row = bindings({
      guest_message_id: 'm-store-dup',
      guest_created_at: minutesAgo(5, NOW),
    });
    const inbox = {
      stored: null,
      async capture(event) {
        if (this.stored) return { inserted: false, row: this.stored };
        this.stored = { id: 'evt-store', ...event };
        return { inserted: true, row: this.stored };
      },
    };
    const sources = emptySources({ silence: async () => [row] });
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources }));
    ok('first store insert ok', first.ok === true);
    ok('duplicate {inserted:false,row} does not stall catch-up', second.ok === true && second.sources.silence.results[0].duplicate === true);
    ok('checkpoint advanced after duplicate store reply', (await checkpoints.get(d.SOURCE_SILENCE)).id === 'm-store-dup');
  }
  {
    const inbox = makeInbox();
    const checkpoints = makeCheckpoints();
    const sendId = '33333333-3333-4333-8333-333333333333';
    const obligations = [
      {
        kind: 'luna_send_failed', row_id: sendId, revision: 't1', send_kind: 'confirmation',
        booking_id: 'book-a', booking_code: 'WH-A', blocked_reasons: ['needs_human:missing_fact'], failure_stage: 'send_route',
      },
      {
        kind: 'luna_send_failed', row_id: sendId, revision: 't2', send_kind: 'confirmation',
        booking_id: 'book-b', booking_code: 'WH-B', blocked_reasons: ['provider_delivery_failed'], failure_stage: 'provider',
      },
      {
        kind: 'luna_send_failed', row_id: sendId, revision: 't1-again', send_kind: 'confirmation',
        booking_id: 'book-a', booking_code: 'WH-A', blocked_reasons: ['needs_human:missing_fact'], failure_stage: 'send_route',
      },
    ];
    const row = bindings({
      send_id: sendId,
      status: 'sent',
      blocked_reasons: [],
      send_kind: 'confirmation',
      source: 'hermes_luna',
      updated_at: '2026-11-01T22:59:00.000Z',
      cursor_ts: '2026-11-01T22:59:00.000Z',
      provider_response: { luna_supervisor_event_obligations: obligations },
    });
    const out = await d.runLookoutDetectorScan(baseCtx({
      eventInbox: inbox,
      checkpoints,
      sources: emptySources({ sendFailed: async () => [row] }),
    }));
    ok('obligations emit three occurrences from one mutable row', out.events.length === 3 && inbox.byKey.size === 3);
    ok('keys match Skip producer', out.events.every((ev) => (
      ev.source_key.startsWith(`${d.SKIP_ENVIRONMENT}:${d.SKIP_RUNTIME}:${d.KIND_LUNA_SEND_FAILED}:${sendId}:`)
    )));
    ok('A>B>A overwritten failures are three keys',
      out.events[0].source_key.endsWith(':t1')
      && out.events[1].source_key.endsWith(':t2')
      && out.events[2].source_key.endsWith(':t1-again'));
    ok('each occurrence keeps its own booking and reason',
      out.events[0].booking_code === 'WH-A' && out.events[0].reason.includes('missing_fact')
      && out.events[1].booking_code === 'WH-B' && out.events[1].reason.includes('provider_delivery_failed')
      && !/ sent:/.test(out.events[0].reason));
  }
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        sendFailed: async () => [{
          send_id: 's-gap-cause',
          client_id: CLIENT_ID,
          client_slug: 'wolfhouse-somo',
          status: 'failed',
          send_kind: 'confirmation',
          source: 'hermes_luna',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          provider_response: {
            luna_supervisor_event_obligations: [{
              kind: 'luna_send_failed',
              row_id: 'ob-gap',
              revision: 'r1',
              send_kind: 'confirmation',
              cause_incident_id: 'inc-keep',
              booking_id: BOOKING_ID,
              booking_code: 'WH-1',
            }],
          },
        }],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('unresolved conversation is a gap', out.events[0].kind === d.KIND_CAPTURE_GAP);
    ok('gap keeps causal ancestry for dispatcher', out.events[0].cause_incident_id === 'inc-keep' && store.rows[0].cause_incident_id === 'inc-keep');
    ok('gap does not rely on wake_supervisor metadata', store.rows[0].cause_incident_id === 'inc-keep' && out.events[0].wake_supervisor === false);
  }
  {
    const store = makeStoreInbox();
    const ctx = baseCtx({
      eventInbox: store,
      sources: emptySources({
        waFailed: async () => [bindings({
          status_id: 'wa-own-booking',
          provider_message_id: 'wamid.OWN',
          status: 'failed',
          received_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          send_kind: 'confirmation',
          callback_revision: 'cb-own',
          provider_response: {
            luna_supervisor_event_obligations: [{
              kind: 'luna_send_failed',
              row_id: 'wa:wamid.OWN',
              revision: 'cb-own',
              send_kind: 'confirmation',
              booking_id: BOOKING_ID,
              booking_code: 'WH-OWN',
            }],
          },
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('WA uses the failed send booking, not MIN of conversation bookings',
      out.events[0].booking_id === BOOKING_ID && store.rows[0].booking_code === 'WH-OWN');
  }
  {
    const checkpoints = makeCheckpoints();
    const inbox = makeInbox();
    const emptyLedger = bindings({
      send_id: 's-empty-ledger',
      status: 'sent',
      blocked_reasons: [],
      send_kind: 'confirmation',
      updated_at: '2026-11-01T21:50:00.000100Z',
      cursor_ts: '2026-11-01T21:50:00.000100Z',
      provider_response: { luna_supervisor_event_obligations: [] },
    });
    const pending = bindings({
      send_id: 's-later-fail',
      status: 'sent',
      blocked_reasons: [],
      send_kind: 'confirmation',
      updated_at: '2026-11-01T21:50:00.000800Z',
      cursor_ts: '2026-11-01T21:50:00.000800Z',
      provider_response: {
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed',
          row_id: 'later-ob',
          revision: 'r-later',
          send_kind: 'confirmation',
          booking_id: BOOKING_ID,
          booking_code: 'WH-1',
          blocked_reasons: ['still_failed'],
        }],
      },
    });
    const pages = [[emptyLedger], [pending]];
    let page = 0;
    const sources = emptySources({
      sendFailed: async ({ cursor }) => {
        if (!cursor) return pages[0];
        page = 1;
        return pages[1];
      },
    });
    const first = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('empty ledger page emits no false failure', first.ok === true && !first.events.some((ev) => ev.kind === d.KIND_LUNA_SEND_FAILED));
    ok('empty ledger still advances checkpoint', (await checkpoints.get(d.SOURCE_SEND_FAILED)).id === 's-empty-ledger');
    const second = await d.runLookoutDetectorScan(baseCtx({ eventInbox: inbox, checkpoints, sources, batchSize: 1 }));
    ok('later outstanding failure is reached', second.events.some((ev) => ev.source_key.endsWith(':later-ob:r-later')));
  }
  {
    const mixed = d.occurrenceBooking(
      { booking_id: 'id-a', booking_code: null, provider_response: {} },
      { canonical: true, booking_id: 'id-a' },
    );
    ok('booking pair is not filled from a different phone booking', mixed.booking_id === 'id-a' && mixed.booking_code == null);
    const guessed = d.occurrenceBooking(
      { booking_id: 'phone-b', booking_code: 'WH-B', provider_response: {} },
      { canonical: true, booking_id: 'id-a' },
    );
    ok('obligation booking is not mixed with a later phone match', guessed.booking_id === 'id-a' && guessed.booking_code == null);
  }
  {
    const inbox = makeInbox();
    const ctx = baseCtx({
      eventInbox: inbox,
      sources: emptySources({
        waFailed: async () => [bindings({
          status_id: 'wa-multi',
          provider_message_id: 'wamid.MULTI',
          status: 'failed',
          send_kind: 'reply',
          callback_revision: 'cb-2',
          received_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          provider_response: {
            luna_supervisor_event_obligations: [
              { kind: 'luna_send_failed', row_id: 'unrelated', revision: 'other', send_kind: 'confirmation' },
              { kind: 'luna_send_failed', row_id: 'wa:wamid.MULTI', revision: 'cb-1', send_kind: 'reply' },
              { kind: 'luna_send_failed', row_id: 'wa:wamid.MULTI', revision: 'cb-2', send_kind: 'reply', booking_code: 'WH-WA' },
            ],
          },
        })],
      }),
    });
    const out = await d.runLookoutDetectorScan(ctx);
    ok('WA matches exact callback revision, not first obligation', out.events[0].source_key.endsWith(':cb-2') && out.events[0].obligation === 'handoff');
  }
  {
    const uncorrelated = await d.runLookoutDetectorScan(baseCtx({
      sources: emptySources({
        waFailed: async () => [bindings({
          status_id: 'wa-none',
          provider_message_id: 'wamid.NONE',
          status: 'failed',
          send_kind: 'reply',
          received_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
        })],
      }),
    }));
    ok('uncorrelated WA is reconciliation evidence, not confirmation work',
      uncorrelated.events[0].kind === d.KIND_CAPTURE_GAP && /uncorrelated_wa_status/.test(uncorrelated.events[0].reason));
  }
  {
    const blocked = { status: 'failed' };
    const missingCol = new Error('column "conversation_id" does not exist');
    missingCol.code = '42703';
    const missingTable = new Error('relation "whatsapp_status_events" does not exist');
    missingTable.code = '42P01';
    ok('undefined column is not table_missing', d.isUndefinedTableError(missingCol) === false);
    ok('missing relation is table_missing', d.isUndefinedTableError(missingTable) === true);
    ok('blocked without ledger is a diagnostic gap, not a Skip identity',
      d.sendFailedEventsFromRow({
        send_id: 'legacy-1', client_id: CLIENT_ID, conversation_id: CONV_ID, status: 'failed',
        send_kind: 'reply', blocked_reasons: ['x'],
      }, PIN)[0].kind === d.KIND_CAPTURE_GAP);
  }
  {
    const cleaned = await d.runLookoutDetectorScan(baseCtx({
      sources: emptySources({
        sendFailed: async () => [bindings({
          send_id: 's-cleaned',
          status: 'blocked',
          blocked_reasons: ['still_blocked'],
          send_kind: 'confirmation',
          booking_id: BOOKING_ID,
          booking_code: 'WH-1',
          updated_at: minutesAgo(1, NOW),
          cursor_ts: minutesAgo(1, NOW),
          provider_response: { luna_supervisor_event_obligations: [] },
        })],
      }),
    }));
    ok('exhausted ledger does not invent a second identity',
      !cleaned.events.some((ev) => ev.kind === d.KIND_LUNA_SEND_FAILED) && cleaned.ok === true);
  }

  console.log('\n[13] Cap FAIL 1a722821 — occurrence unknowns, no unkeyed wake, placeholder, mixed ledger');
  {
    const laterEnvelope = {
      send_id: 's-unknown-booking',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'sent',
      send_kind: 'confirmation',
      source: 'later-success',
      provider_message_id: 'wamid.LATER',
      provider_response: {
        booking_id: 'book-later',
        booking_code: 'WH-LATER',
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed',
          row_id: 'ob-unknown',
          revision: 'r-unknown',
          send_kind: 'confirmation',
          booking_id: null,
          booking_code: null,
          blocked_reasons: ['needs_human:missing_fact'],
        }],
      },
    };
    const ev = d.sendFailedEventsFromRow(laterEnvelope, PIN)[0];
    ok('unknown occurrence booking is not filled from later envelope',
      ev.kind === d.KIND_CAPTURE_GAP && /unresolved_booking/.test(ev.reason));
    ok('occurrence send_kind/source are not borrowed from the current row',
      ev.payload && ev.payload.source !== 'later-success');
  }
  {
    const ev = d.sendFailedEventsFromRow({
      send_id: 'legacy-1', client_id: CLIENT_ID, conversation_id: CONV_ID, status: 'failed',
      send_kind: 'reply', blocked_reasons: ['x'],
    }, PIN)[0];
    ok('legacy no-ledger is a non-dispatchable gap, not luna_send_failed',
      ev.kind === d.KIND_CAPTURE_GAP && /legacy_unkeyed_send_failure/.test(ev.reason) && ev.wake_supervisor === false);
    const inbox = d.toSupervisorInboxEvent(ev);
    ok('gap persisted as diagnostic for #1563 dispatch exclusion',
      inbox.kind === d.KIND_CAPTURE_GAP && inbox.metadata.wake_supervisor === false
      && inbox.delivery_status === 'diagnostic');
  }
  {
    const placeholder = d.sendFailedEventsFromRow({
      send_id: 's-placeholder',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'failed',
      send_kind: 'delivery_status_pending',
      source: 'meta_failed_status_callback_pending',
      provider_response: {
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed', row_id: 'wa:wamid.EARLY', revision: '1700000000', send_kind: 'delivery_status_pending',
        }],
      },
    }, PIN)[0];
    ok('unmatched callback placeholder is not wakeable handoff',
      placeholder.kind === d.KIND_CAPTURE_GAP
      && /unmatched_callback_placeholder/.test(placeholder.reason)
      && placeholder.wake_supervisor === false
      && placeholder.obligation !== 'confirmation');
  }
  {
    const mixed = d.sendFailedEventsFromRow({
      send_id: 's-mixed',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'failed',
      send_kind: 'reply',
      provider_response: {
        luna_supervisor_event_obligations: [
          { kind: 'luna_send_failed', row_id: 'good', revision: 'r1', send_kind: 'reply', blocked_reasons: ['x'] },
          { kind: 'luna_send_failed', row_id: 'bad' },
        ],
      },
    }, PIN);
    ok('mixed ledger keeps the valid occurrence and a diagnostic for dropped evidence',
      mixed.some((ev) => ev.kind === d.KIND_LUNA_SEND_FAILED && ev.source_key.endsWith(':good:r1'))
      && mixed.some((ev) => ev.kind === d.KIND_CAPTURE_GAP && /malformed_ledger_entries/.test(ev.reason)));
  }
  {
    const blockedEmpty = d.sendFailedEventsFromRow({
      send_id: 's-blocked-empty',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'blocked',
      send_kind: 'confirmation',
      provider_response: { luna_supervisor_event_obligations: [] },
    }, PIN)[0];
    ok('blocked empty ledger is a diagnostic gap, not a Skip/unkeyed wake',
      blockedEmpty.kind === d.KIND_CAPTURE_GAP && /empty_ledger_while_blocked/.test(blockedEmpty.reason)
      && blockedEmpty.wake_supervisor === false);
  }
  {
    ok('WA without callback_revision does not borrow a lone ledger item',
      d.matchingWaObligation({
        provider_message_id: 'wamid.MULTI',
        provider_response: {
          luna_supervisor_event_obligations: [
            { kind: 'luna_send_failed', row_id: 'wa:wamid.MULTI', revision: 'cb-1', send_kind: 'reply' },
          ],
        },
      }) == null);
    ok('WA exact revision still matches',
      d.matchingWaObligation({
        provider_message_id: 'wamid.MULTI',
        callback_revision: 'cb-2',
        provider_response: {
          luna_supervisor_event_obligations: [
            { kind: 'luna_send_failed', row_id: 'unrelated', revision: 'other', send_kind: 'confirmation' },
            { kind: 'luna_send_failed', row_id: 'wa:wamid.MULTI', revision: 'cb-2', send_kind: 'reply' },
          ],
        },
      }).revision === 'cb-2');
  }

  console.log('\n[14] Cap FAIL 7b9cc789 — unknown send_kind is diagnostic, not a wakeable handoff');
  {
    const events = d.sendFailedEventsFromRow({
      send_id: 's-unk-kind',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'failed',
      send_kind: 'confirmation',
      booking_id: BOOKING_ID,
      booking_code: 'WH-1',
      provider_response: {
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed',
          row_id: 's-unk-kind',
          revision: 'r-unk',
          blocked_reasons: ['provider'],
        }],
      },
    }, PIN);
    const ev = events[0];
    ok('missing occurrence send_kind is capture_gap, not luna_send_failed',
      ev.kind === d.KIND_CAPTURE_GAP && /unknown_send_kind/.test(ev.reason));
    ok('unknown classification does not wake as handoff',
      ev.kind === d.KIND_CAPTURE_GAP && ev.wake_supervisor === false);
    ok('unknown send_kind is not skipped as confirmation booking work',
      !events.some((item) => item.kind === d.KIND_LUNA_SEND_FAILED));
  }
  {
    const known = d.sendFailedEventsFromRow({
      send_id: 's-reply-kind',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      status: 'failed',
      provider_response: {
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed',
          row_id: 's-reply-kind',
          revision: 'r-reply',
          send_kind: 'reply',
          blocked_reasons: ['provider'],
        }],
      },
    }, PIN)[0];
    ok('known reply send_kind remains a classified handoff occurrence',
      known.kind === d.KIND_LUNA_SEND_FAILED && known.obligation === 'handoff' && known.wake_supervisor === true);
  }
  {
    const waUnknown = d.waFailedEventFromRow({
      status_id: 'wa-unk',
      client_id: CLIENT_ID,
      conversation_id: CONV_ID,
      provider_message_id: 'wamid.UNK',
      callback_revision: 'cb-unk',
      status: 'failed',
      provider_response: {
        luna_supervisor_event_obligations: [{
          kind: 'luna_send_failed',
          row_id: 'wa:wamid.UNK',
          revision: 'cb-unk',
        }],
      },
    }, PIN);
    ok('WA occurrence without send_kind is diagnostic, not fabricated confirmation/handoff',
      waUnknown.kind === d.KIND_CAPTURE_GAP && /unknown_send_kind/.test(waUnknown.reason)
      && waUnknown.wake_supervisor === false);
  }

  console.log('\nAll Lookout detector proofs passed.');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
