#!/usr/bin/env node
'use strict';
// Offline only: real handoff owners, fake SQL boundary/clock, no sockets or sends.
const assert = require('node:assert/strict');
const denyNetwork = () => { throw new Error('network_forbidden'); };
global.fetch = denyNetwork;
for (const name of ['node:net', 'node:tls', 'node:http', 'node:https']) {
  const mod = require(name);
  for (const key of ['connect', 'createConnection', 'request', 'get']) {
    if (typeof mod[key] === 'function') mod[key] = denyNetwork;
  }
}
require('node:net').Socket.prototype.connect = denyNetwork;
const { markConversationNeedsHuman } = require('./lib/luna-guest-handoff-persist');
const { handoffWarmNoteText } = require('./lib/luna-guest-handoff-warm-note');
const ID = '11111111-1111-4111-8111-111111111111';
function fixture(options = {}) {
  const events = [];
  const row = { conversation_id: ID, phone: '+34600000000', language: 'es',
    needs_human: false, metadata: {}, ...options.row };
  let released = false;
  const sqlCalls = [];
  const query = async (sql, params = []) => {
    sqlCalls.push({ sql, params });
    if (sql.includes('WITH scoped AS')) {
      events.push('staff-report');
      return { rows: [{ id: ID }] };
    }
    if (/UPDATE conversations[\s\S]*SET needs_human = TRUE/.test(sql)) {
      events.push('flag'); row.needs_human = true;
      row.metadata.needs_human_reason = params[2];
      return { rows: [{ ...row }] };
    }
    if (/SELECT[\s\S]*FROM conversations conv/.test(sql)) {
      events.push('preread');
      assert.match(sql, /c.slug = \$1/);
      assert.match(sql, /conv.id = \$2::uuid/);
      return { rows: options.notFound ? [] : [{ ...row,
        language: /conv.language/.test(sql) ? row.language : undefined }] };
    }
    if (/INSERT INTO bot_pause_states/.test(sql)) {
      events.push('pause'); return { rows: [{ id: 'pause', paused: true, conversation_id: ID }] };
    }
    if (/INSERT INTO staff_handoffs/.test(sql)) {
      events.push('handoff');
      if (options.handoffFails) throw Error('offline upsert failure');
      return { rows: [{ id: 'handoff', status: 'open' }] };
    }
    if (/FROM messages/.test(sql)) return { rows: options.history || [] };
    if (/staff_member_name/.test(sql)) return { rows: [{ staff_member_name: 'Ana' }] };
    if (/luna_handoff_guest_note/.test(sql)) {
      events.push('evidence'); row.metadata.luna_handoff_guest_note = JSON.parse(params[2]);
      return { rows: [{ conversation_id: ID }] };
    }
    return { rows: [] };
  };
  const pg = { query: async (...args) => { assert.equal(released, false, 'no released PG reuse'); return query(...args); } };
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    schedule: (fn, delay) => {
      assert.ok(events.includes('handoff'), 'arm retry only after the handoff callback work');
      const timer = { fn, at: now + delay, unref() {} }; timers.push(timer); return timer;
    },
    advance: async (ms) => {
      now += ms;
      for (const t of timers) if (!t.ran && t.at <= now) { t.ran = true; await t.fn(); }
    },
  };
  const run = async (opts = {}) => {
    released = false;
    const out = await markConversationNeedsHuman(pg, {
      conversation_id: ID, client_slug: options.clientSlug || 'wolfhouse-somo', reason: 'staff_manual_handoff',
    }, { env: {}, skip_notify: true, handoff_source: 'staff_manual_handoff',
      scheduleHandoffNoteRetry: clock.schedule, now: clock.now,
      withPgClient: async (fn) => { assert.equal(released, true); events.push('fresh-pg'); return fn({ query }); },
      ...opts });
    released = true;
    return out;
  };
  return { run, row, events, clock, timers, sqlCalls };
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
test('handoff row failure still arms the already-flagged conversation retry', async () => {
  const f = fixture({ handoffFails: true });
  const out = await f.run({ sendGuestNote: async () => ({ok:false, sent:false}) });
  assert.equal(f.row.needs_human, true);
  assert.equal(out.ok, false);
  assert.equal(f.timers.length, 1);
  await f.clock.advance(60000);
  assert.equal(f.row.metadata.luna_handoff_guest_note.status, 'failed');
  assert.ok(f.events.includes('staff-report'));
});
test('first warm note succeeds before flag/pause in stored guest language', async () => {
  const f = fixture();
  const out = await f.run({ sendGuestNote: async (payload) => {
    f.events.push('send');
    assert.equal(payload.text, handoffWarmNoteText('es', 'Ana'));
    return { ok: true, sent: true };
  } });
  assert.equal(out.needs_human, true);
  assert.equal(out.conversation_paused, true);
  assert.ok(f.events.indexOf('send') < f.events.indexOf('flag'), f.events.join(','));
  assert.equal(f.timers.length, 0);
});
test('failed first send flags immediately, retries once at 60s using fresh PG and records delivery', async () => {
  const f = fixture();
  let sends = 0;
  const out = await f.run({ sendGuestNote: async () => {
    f.events.push('send'); sends++;
    return { ok: sends === 2, sent: sends === 2 };
  } });
  assert.equal(out.needs_human, true);
  assert.equal(out.conversation_paused, true);
  assert.equal(sends, 1);
  assert.equal(f.timers.length, 1);
  assert.equal(f.row.metadata.luna_handoff_guest_note.status, 'retry_scheduled');
  await f.clock.advance(59999);
  assert.equal(sends, 1);
  await f.clock.advance(1);
  assert.equal(sends, 2);
  assert.equal(f.row.metadata.luna_handoff_guest_note.status, 'sent');
  assert.equal(f.row.metadata.luna_handoff_guest_note.attempts, 2);
  assert.ok(f.events.indexOf('pause') < f.events.lastIndexOf('send'));
  assert.ok(f.events.includes('fresh-pg'));
  await f.clock.advance(60000);
  assert.equal(sends, 2);
});
for (const failure of ['status', 'throw']) {
  test(`${failure} failure on both sends never blocks flag and records Staff-visible final failure`, async () => {
    const f = fixture(); let sends = 0;
    const out = await f.run({ sendGuestNote: async () => {
      sends++; if (failure === 'throw') throw new Error('secret-provider-token');
      return { ok: false, sent: false, blocked_reason: 'secret-provider-token' };
    } });
    assert.equal(out.needs_human, true);
    assert.equal(out.conversation_paused, true);
    await f.clock.advance(60000);
    assert.equal(sends, 2);
    assert.equal(f.row.metadata.luna_handoff_guest_note.status, 'failed');
    assert.equal(f.row.metadata.luna_handoff_guest_note.staff_action_required, true);
    assert.equal(JSON.stringify(f.row.metadata).includes('secret-provider-token'), false);
    await f.clock.advance(60000);
    assert.equal(sends, 2);
  });
}
test('default provider never uses Wolfhouse credentials for another tenant', async () => {
  const provider = require('./lib/luna-whatsapp-provider');
  const original = provider.sendLunaWhatsAppMessage;
  let calls = 0;
  provider.sendLunaWhatsAppMessage = async () => { calls++; return { success: true, send_performed: true }; };
  try {
    const f = fixture({ clientSlug: 'other-tenant' });
    const out = await f.run({ env: { WHATSAPP_DRY_RUN: 'false', LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo' } });
    assert.equal(out.needs_human, true);
    await f.clock.advance(60000);
    assert.equal(calls, 0, 'tenant mismatch must block before provider');
  } finally { provider.sendLunaWhatsAppMessage = original; }
});
test('wrong conversation scope cannot send or mutate; preread preserves simulator predicates', async () => {
  const f = fixture({ notFound: true }); let sends = 0;
  const out = await f.run({ sendGuestNote: async () => { sends++; return { ok: true }; } });
  assert.equal(out.ok, false);
  assert.equal(sends, 0);
  assert.equal(f.events.includes('flag'), false);
  const query = f.sqlCalls[0].sql;
  assert.ok(query.includes(String.raw`'\D'`), 'SQL must retain regexp non-digit escape');
  assert.match(query, /source_owner.*crowsnest-guest-door/);
  assert.match(query, /simulator_synthetic.*true/);
  assert.match(query, /conv.phone = \$3/);
});
test('synthetic handoff still flags but never sends or schedules even with injected sender', async () => {
  const f = fixture({ row: { phone: '+999000000000001', metadata: { simulator_synthetic: true, source_owner: 'crowsnest-guest-door' } } });
  let sends = 0;
  const out = await f.run({ exact_simulator_phone: f.row.phone,
    sendGuestNote: async () => { sends++; return { ok: true }; } });
  assert.equal(out.needs_human, true);
  assert.equal(sends, 0);
  assert.equal(f.timers.length, 0);
});
for (const success of [true, false]) {
  test(`repeated flag preserves ${success ? 'delivered' : 'pending retry'} note without duplicate send`, async () => {
    const f = fixture(); let sends = 0;
    const opts = { sendGuestNote: async () => { sends++; return { ok: success, sent: success }; } };
    await f.run(opts);
    await f.run(opts);
    assert.equal(sends, 1);
    assert.equal(f.timers.length, success ? 0 : 1);
    await f.clock.advance(60000);
    assert.equal(sends, success ? 1 : 2);
    await f.run(opts);
    assert.equal(sends, success ? 1 : 2, 'exhausted retry is not restarted');
  });
}
test('existing successful outbound warm note suppresses automatic duplicate', async () => {
  const f = fixture({ history: [{ message_text: handoffWarmNoteText('de') }] });
  let sends = 0;
  const out = await f.run({ sendGuestNote: async () => { sends++; return { ok: true }; } });
  assert.equal(out.guest_note.skipped, 'already_sent');
  assert.equal(sends, 0);
  assert.equal(f.timers.length, 0);
});
test('unconfirmed/failed provider results are failures, not successful delivery', async () => {
  const { sendHandoffWarmNoteIfNeeded } = require('./lib/luna-guest-handoff-warm-note');
  for (const result of [{}, { status: 'failed' }, { ok: true, send_performed: false }, { ok: true, status: 503 }]) {
    const out = await sendHandoffWarmNoteIfNeeded({ sendGuestNote: async () => result });
    assert.equal(out.sent, false, JSON.stringify(result));
  }
});
test('ordinary Python-owned path never starts a competing retry or false failure report', async () => {
  const provider = require('./lib/luna-whatsapp-provider');
  const original = provider.sendLunaWhatsAppMessage;
  let calls = 0;
  provider.sendLunaWhatsAppMessage = async () => { calls++; return { success: true, send_performed: true }; };
  try {
    const f = fixture();
    const out = await f.run({ handoff_source: 'luna_flag_needs_human' });
    assert.equal(out.needs_human, true);
    assert.equal(out.conversation_paused, true);
    assert.equal(out.guest_note.skipped, 'external_note_owner');
    await f.clock.advance(60000);
    assert.equal(calls, 0);
    assert.equal(f.timers.length, 0);
    assert.equal(f.row.metadata.luna_handoff_guest_note, undefined);
    assert.equal(f.events.includes('staff-report'), false);
  } finally { provider.sendLunaWhatsAppMessage = original; }
});
test('manual/supervisor default sender preserves dry-run and all five languages', async () => {
  for (const source of ['staff_manual_handoff', 'supervisor_dispatch']) {
    const f = fixture();
    const out = await f.run({ handoff_source: source, env: { WHATSAPP_DRY_RUN: 'true' } });
    assert.equal(out.needs_human, true);
    assert.equal(out.guest_note.sent, false);
    assert.equal(out.guest_note.skipped, 'whatsapp_dry_run_active');
    await f.clock.advance(60000);
    assert.equal(f.row.metadata.luna_handoff_guest_note.status, 'failed');
  }
  for (const language of ['en', 'es', 'it', 'de', 'fr']) {
    const f = fixture({ row: { language } });
    await f.run({ sendGuestNote: async (payload) => {
      assert.equal(payload.text, handoffWarmNoteText(language, 'Ana')); return { ok: true };
    } });
  }
});
test('retry revalidates tenant/simulator scope and skips a note already delivered meanwhile', async () => {
  for (const change of ['not-found', 'synthetic', 'already-sent', 'resolved']) {
    const options = {};
    const f = fixture(options); let sends = 0;
    await f.run({ sendGuestNote: async () => { sends++; return { ok: false }; } });
    if (change === 'not-found') options.notFound = true;
    if (change === 'synthetic') f.row.metadata.simulator_synthetic = true;
    if (change === 'already-sent') options.history = [{ message_text: handoffWarmNoteText('es') }];
    if (change === 'resolved') f.row.needs_human = false;
    await f.clock.advance(60000);
    assert.equal(sends, 1, change);
  }
});
test('default sender requires both literal kill-switch permissions on every attempt', async () => {
  const { createHandoffWarmNoteSender } = require('./lib/luna-guest-handoff-warm-note');
  const provider = require('./lib/luna-whatsapp-provider');
  const original = provider.sendLunaWhatsAppMessage;
  let calls = 0;
  provider.sendLunaWhatsAppMessage = async () => { calls++; return { success: true, send_performed: true }; };
  try {
    const env = { WHATSAPP_DRY_RUN: 'false' };
    const sender = createHandoffWarmNoteSender(env, 'wolfhouse-somo');
    assert.equal((await sender({})).sent, false);
    assert.equal(calls, 0);
    env.LUNA_AUTO_SEND_ENABLED = 'true';
    assert.equal((await sender({})).sent, true);
    env.WHATSAPP_DRY_RUN = 'true';
    assert.equal((await sender({})).sent, false);
    assert.equal(calls, 1);
  } finally { provider.sendLunaWhatsAppMessage = original; }
});
(async () => {
  let failures = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`PASS ${t.name}`); }
    catch (err) { failures++; console.error(`FAIL ${t.name}: ${err.stack}`); }
  }
  assert.equal(failures, 0, `${failures} offline handoff regressions`);
  console.log(`PASS ${tests.length} offline handoff note tests; network blocked`);
})().catch(() => { process.exitCode = 1; });
