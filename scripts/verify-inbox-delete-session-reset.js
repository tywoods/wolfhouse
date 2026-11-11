#!/usr/bin/env node
'use strict';

// Offline regression: execute the real DELETE handler, DB helper and Hermes
// session-key client. Only PostgreSQL and HTTP transport are fixture doubles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const writes = require('./lib/staff-conversation-writes');
const { resetHermesConversationSession } = require('./lib/luna-hermes-guest-session-reset');
const { mapInboxClearThreadHttpStatus } = require('./lib/staff-inbox-clear-thread');

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE = '+34600000000'; // Synthetic offline fixture; never sent.
const ENV = { WOLFHOUSE_HERMES_BASE_URL: 'https://hermes.invalid', LUNA_BOT_INTERNAL_TOKEN: 'offline-fixture' };
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const start = api.indexOf('async function handleConversationDelete(');
const end = api.indexOf('\nfunction inboxGuestPanelFromMetadata', start);
assert.ok(start >= 0 && end > start, 'real DELETE handler found');
const handlerSource = api.slice(start, end);

async function exercise(options = {}) {
  const calls = [];
  const row = { conversation_id: ID, phone: options.email ? 'emailv1:guest@example.invalid' : PHONE,
    client_id: 'fixture-client', needs_human: false, display_name: 'Guest' };
  const pg = { async query(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();
    calls.push({ kind: 'sql', sql: q, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(q)) return { rows: [], rowCount: 0 };
    if (/^SELECT conv.id::text AS conversation_id/.test(q)) {
      if (q.includes('regexp_replace')) return { rows: options.shared ? [{ conversation_id: 'sibling' }] : [] };
      assert.deepEqual(Array.from(params), [options.client || 'wolfhouse-somo', ID]);
      return { rows: options.missing || options.client === 'other-tenant' ? [] : [row] };
    }
    if (q.startsWith('SELECT to_regclass')) return { rows: [{ regclass: null }] };
    if (q.startsWith('DELETE FROM bot_pause_states')) return { rows: [], rowCount: 1 };
    if (q.startsWith('DELETE FROM conversations')) {
      if (options.deleteFails) throw new Error('fixture DB failure');
      return { rows: [{ conversation_id: ID }], rowCount: 1 };
    }
    throw new Error('Unexpected SQL: ' + q);
  } };
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://hermes.invalid/wolfhouse/guest-session-key-reset');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-Luna-Bot-Token'], 'offline-fixture');
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { guest_phone: PHONE, conversation_id: ID });
    calls.push({ kind: 'reset', body });
    if (options.resetFails) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    return { ok: true, status: 200, json: async () => ({ ok: true, reset: true, scope: 'session_key' }) };
  };
  let response;
  try {
    const context = {
      ...writes, Date, DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[;'"\\]/,
      assertStaffClientAccess: () => options.allowed !== false,
      appendAuditLog: (entry) => calls.push({ kind: 'audit', entry }),
      sendJSON: (_res, status, body) => { response = { status, body }; },
      send400: () => { response = { status: 400 }; },
      send404: () => { response = { status: 404 }; },
      withPgClient: (fn) => fn(pg), mapInboxClearThreadHttpStatus,
      resetHermesConversationSession: (phone, opts) => resetHermesConversationSession(phone, {
        ...opts, env: options.unconfigured ? {} : ENV,
      }),
    };
    vm.createContext(context);
    vm.runInContext(handlerSource, context);
    await context.handleConversationDelete(ID, { client: options.client || 'wolfhouse-somo' }, {}, { staff_user_id: 'fixture-staff' });
    assert.ok(!calls.some(c => c.kind === 'sql' && /^(DELETE FROM|UPDATE|INSERT INTO) (bookings|booking_guests|payments|customers|contacts)\b/i.test(c.sql)),
      'no booking, payment or contact mutation');
    return { calls, response };
  } finally {
    global.fetch = originalFetch;
  }
}

(async () => {
  const { calls, response } = await exercise();
  const resetIndex = calls.findIndex(c => c.kind === 'reset');
  const firstDelete = calls.findIndex(c => c.kind === 'sql' && c.sql.startsWith('DELETE'));
  assert.ok(resetIndex >= 0 && resetIndex < firstDelete,
    'DELETE must reset the live Hermes session key before removing the Staff thread');
  assert.equal(calls.filter(c => c.kind === 'reset').length, 1);
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted, true);
  assert.equal(response.body.hermes_session_reset.ok, true);
  assert.equal(response.body.hermes_session_reset.hard_delete, false);
  assert.ok(calls.some(c => c.kind === 'sql' && c.sql === 'COMMIT'));
  console.log('PASS DELETE resets only the live session before deleting the thread; commercial/contact data untouched');

  for (const [options, status, reason] of [
    [{ resetFails: true }, 503, 'luna_unreachable'],
    [{ unconfigured: true }, 503, 'missing_session_key_url'],
    [{ shared: true }, 409, 'shared_session_binding'],
  ]) {
    const result = await exercise(options);
    assert.equal(result.response.status, status);
    assert.equal(result.response.body.success, false);
    assert.equal(result.response.body.deleted, false);
    assert.equal(result.response.body.error, reason);
    assert.ok(!result.calls.some(c => c.kind === 'sql' && /^(BEGIN|DELETE|UPDATE|INSERT)/.test(c.sql)),
      'failed or ambiguous reset keeps the thread and all database state intact');
    assert.ok(!result.calls.some(c => c.kind === 'audit' && c.entry.success === true));
    if (options.shared || options.unconfigured) {
      assert.ok(!result.calls.some(c => c.kind === 'reset'));
    }
    console.log(`PASS ${reason}: deletion refused and thread retained`);
  }

  for (const options of [{ missing: true }, { client: 'other-tenant' }]) {
    const result = await exercise(options);
    assert.equal(result.response.status, 404);
    assert.ok(!result.calls.some(c => c.kind === 'reset'
      || (c.kind === 'sql' && /^(BEGIN|DELETE|UPDATE|INSERT)/.test(c.sql))));
  }
  const denied = await exercise({ allowed: false });
  assert.equal(denied.calls.length, 0, 'client access denial reaches neither DB nor Hermes');
  console.log('PASS missing/cross-tenant/access-denied threads cannot reset or delete');

  const email = await exercise({ email: true });
  assert.equal(email.response.status, 200);
  assert.equal(email.response.body.deleted, true);
  assert.ok(!email.calls.some(c => c.kind === 'reset'), 'email deletion never resets a WhatsApp session');
  console.log('PASS email deletion keeps its existing non-WhatsApp behavior');

  const dbFailure = await exercise({ deleteFails: true });
  assert.equal(dbFailure.response.status, 500);
  assert.equal(dbFailure.response.body.success, false);
  assert.ok(dbFailure.calls.some(c => c.kind === 'sql' && c.sql === 'ROLLBACK'));
  assert.ok(!dbFailure.calls.some(c => c.kind === 'sql' && c.sql === 'COMMIT'));
  assert.ok(!dbFailure.calls.some(c => c.kind === 'audit' && c.entry.success === true));
  console.log('PASS post-reset database failure rolls back deletion and never reports success');
})().catch(err => { console.error(err.stack); process.exitCode = 1; });
