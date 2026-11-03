#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { normalizeSupervisorLease, createStaffSupervisorRoutes } = require('./lib/staff-supervisor-routes');
const { shapeSimulatorResponse } = require('./lib/crowsnest/crowsnest-live-simulator');

assert.deepStrictEqual(normalizeSupervisorLease({ headers: { 'x-supervisor-lease-token': 'abc' } }, {}), { ok: true, token: 'abc' });
assert.deepStrictEqual(normalizeSupervisorLease({}, { lease_token: 'abc' }), { ok: true, token: 'abc' });
assert.deepStrictEqual(normalizeSupervisorLease({}, { lease: { token: 'abc' } }), { ok: true, token: 'abc' });
assert.deepStrictEqual(normalizeSupervisorLease({}, { supervisor_leases: [{ lease_token: 'abc' }] }), { ok: true, token: 'abc' });
assert.strictEqual(normalizeSupervisorLease({ headers: { 'x-supervisor-lease-token': 'abc' } }, { lease_token: 'xyz' }).error, 'lease_token_conflict');
assert.strictEqual(normalizeSupervisorLease({}, {}).error, 'lease_token_required');

const request = { tenant: 'wolfhouse', phone: { e164: '+491701234567' }, runtime: { id: 'wolfhouse', label: 'Wolfhouse', origin: 'http://127.0.0.1:8090' }, limitation: {} };
const delivered = shapeSimulatorResponse({ request, upstream: { ok: true, status: 200, body: { ok: true, reply_text: 'Final answer', reply_delivery: { message_id: 'wamid.crowsnest.sim.req.outbound.abc', delivered: true, external_delivery: false }, tool_calls: [{ name: 'read', result_summary: 'ok' }], whatsapp_suppressed: true } } });
assert.strictEqual(delivered.reply_delivery.message_id, 'wamid.crowsnest.sim.req.outbound.abc');
assert.strictEqual(delivered.reply_delivery.external_delivery, false);
assert.strictEqual(delivered.reply_delivery.accepted, true);
assert.strictEqual(delivered.reply_delivery.delivered, false);
assert.strictEqual(delivered.reply_delivery.pending_consumer_receipt, true);
const receipted = shapeSimulatorResponse({ request, upstream: { ok: true, status: 200, body: { ok: true, reply_text: 'Final answer', reply_delivery: { message_id: 'actual-row-id', accepted: true, consumer_receipt: true }, whatsapp_suppressed: true } } });
assert.strictEqual(receipted.reply_delivery.delivered, true);
const empty = shapeSimulatorResponse({ request, upstream: { ok: true, status: 200, body: { ok: false, error: 'empty_reply', reply_text: '', whatsapp_suppressed: true } } });
assert.strictEqual(empty.ok, false);
assert.strictEqual(empty.reply_delivery.delivered, false);
assert.strictEqual(empty.reply_delivery.external_delivery, false);

(async () => {
  let sqlValues;
  let response;
  const routes = createStaffSupervisorRoutes({
    sendJSON: (_res, status, body) => { response = { status, body }; return response; },
    withPgClient: async (fn) => fn({ query: async (sql, values) => {
      assert.match(sql, /JOIN conversations/);
      assert.match(sql, /JOIN clients/);
      sqlValues = values;
      return { rows: [{ id: 'event-1', metadata: { reason: 'diagnostic', lease_token: 'secret' } }] };
    } }),
  });
  await routes.handleEventRead({}, {}, { role: 'viewer', client_slug: 'wolfhouse-somo' }, null, { limit: 200 });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.events[0].metadata.reason, 'diagnostic');
  assert.strictEqual(response.body.events[0].metadata.lease_token, undefined);
  assert.deepStrictEqual(sqlValues, ['', 'wolfhouse-somo', 101]);
  assert.strictEqual(response.body.has_more, false);
  assert.strictEqual(response.body.next_cursor, null);
  await routes.handleEventRead({}, {}, { role: 'viewer', client_slug: 'wolfhouse-somo' }, null, { cursor: 'not-a-cursor' });
  assert.strictEqual(response.status, 400);
  await routes.handleEventRead({}, {}, { role: 'viewer' }, null, {});
  assert.strictEqual(response.status, 403);

  // True keyset pagination: the owner asks for limit+1, propagates the valid
  // cursor, and neither loses nor repeats stable (created_at,id) rows.
  const ids = [
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ];
  const all = ids.map((id, i) => ({ id, created_at: new Date(`2026-01-0${3 - i}T00:00:00Z`), metadata: { lease_token: 'redact', visible: id } }));
  let pageCall = 0;
  const paged = createStaffSupervisorRoutes({
    sendJSON: (_res, status, body) => { response = { status, body }; return response; },
    withPgClient: async (fn) => fn({ query: async (_sql, values) => {
      pageCall += 1;
      if (pageCall === 1) { assert.deepStrictEqual(values, ['', 'wolfhouse-somo', 3]); return { rows: all }; }
      assert.strictEqual(values[2], all[1].created_at.toISOString());
      assert.strictEqual(values[3], all[1].id);
      return { rows: [all[2]] };
    } }),
  });
  await paged.handleEventRead({}, {}, { role: 'viewer', client_slug: 'wolfhouse-somo' }, null, { limit: 2 });
  const first = response.body;
  assert.deepStrictEqual(first.events.map((e) => e.id), ids.slice(0, 2));
  assert.strictEqual(first.has_more, true);
  assert.ok(first.next_cursor);
  assert.ok(first.events.every((e) => e.metadata.lease_token === undefined));
  await paged.handleEventRead({}, {}, { role: 'viewer', client_slug: 'wolfhouse-somo' }, null, { limit: 2, cursor: first.next_cursor });
  const second = response.body;
  assert.deepStrictEqual(second.events.map((e) => e.id), ids.slice(2));
  assert.strictEqual(second.has_more, false);
  assert.strictEqual(second.next_cursor, null);
  assert.deepStrictEqual([...first.events, ...second.events].map((e) => e.id), ids, 'no duplicate or loss');
  console.log('PASS slice 1C authoritative tenant reads, lease normalization, and simulator delivery contract');
})().catch((err) => { console.error(err); process.exitCode = 1; });
