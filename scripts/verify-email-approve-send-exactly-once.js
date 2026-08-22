#!/usr/bin/env node
'use strict';

/**
 * EMAIL-SEND-COMPLETION vertical 4.
 *
 * Exactly-once Approve & send with a fake provider:
 *  - approval commit before dispatch
 *  - immutable journal operation
 *  - duplicate click / retry / rerender / lost response cannot send twice
 *  - outcome-unknown is reconciliation-only
 *  - staff_email_reply mirror is at-most-once
 */

const crypto = require('crypto');
const http = require('http');
const {
  createStaffEmailInboxRoutes,
  snapshotGateEnv,
  SQL_RESOLVE,
  SQL_JOURNAL_EXISTS,
  SQL_APPROVE,
} = require('./lib/staff-email-inbox-routes');

const ORIGIN = 'https://staff.sunset.test';
const C = '11111111-1111-4111-8111-111111111111';
const A = '55555555-5555-4555-8555-555555555555';
const V = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444';
const EV = '77777777-7777-4777-8777-777777777777';
const MAIL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SRC = 'graph-src-1';
const BODY = 'Exactly-once staff reply.';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function user() {
  return {
    staff_user_id: A, email: 'op@t', role: 'operator', status: 'active',
    display_name: 'Op', client_id: C, client_slug: 'sunset', session_id: 's1',
  };
}
function sendEnv() {
  return {
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'true',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: ORIGIN,
  };
}
function mockReq(body) {
  const { EventEmitter } = require('node:events');
  const ee = new EventEmitter();
  const payload = JSON.stringify(body);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }),
    enumerable: true, writable: true,
  });
  process.nextTick(() => { ee.emit('data', Buffer.from(payload, 'utf8')); ee.emit('end'); });
  return ee;
}
function captureSend() {
  const calls = [];
  return { calls, sendJSON(_res, status, body) { calls.push({ status, body }); } };
}
function dto(o) {
  return Object.assign({ conversation_id: V, message_text: BODY, approval_id: null }, o || {});
}

function createFakeWorld() {
  const durable = new Map();
  const journal = new Set();
  const mirrors = [];
  const locks = new Map();
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (/UNION ALL/i.test(n) && /staff_email_reply/.test(n)) return { rows: [] };
      if (n === SQL_RESOLVE || /FROM clients cl/.test(n)) {
        return {
          rows: [{
            conversation_id: V, client_id: C, location_id: L, location_key: 'sunset-somo',
            endpoint_id: E, source_inbound_event_id: EV, provider: 'microsoft_graph',
            provider_mailbox_id: MAIL, provider_source_message_id: SRC,
            endpoint_outbound_enabled: true, public_address: 'support@example.test',
            actor_staff_user_id: A,
          }],
        };
      }
      if (/c\.phone ~ '\^\(emailv1\|email\):'/.test(n) && /LIMIT 1/.test(n)) return { rows: [] };
      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const row = {
          approval_id: String(params[0]).toLowerCase(),
          operation_id: String(params[1]).toLowerCase(),
          client_id: String(params[2]).toLowerCase(),
          location_id: String(params[3]).toLowerCase(),
          location_key: String(params[4]),
          endpoint_id: String(params[5]).toLowerCase(),
          conversation_id: String(params[6]).toLowerCase(),
          source_inbound_event_id: String(params[7]).toLowerCase(),
          provider: 'microsoft_graph',
          provider_mailbox_id: String(params[8]),
          provider_source_message_id: String(params[9]),
          message_text: String(params[11]),
          body_digest: String(params[12]),
          subject: params[13] == null ? null : String(params[13]),
          state: 'draft',
        };
        durable.set(row.approval_id, row);
        return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id, subject: row.subject }] };
      }
      if (/SET message_text/.test(n)) return { rows: [] };
      if (/FOR UPDATE/.test(n)) {
        const id = String(params[0]).toLowerCase();
        while (locks.has(id)) await new Promise((r) => setImmediate(r));
        locks.set(id, 1); client._lk = id;
        const row = durable.get(id);
        if (!row || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
        return { rows: [{ ...row }] };
      }
      if (n === SQL_JOURNAL_EXISTS) {
        return { rows: journal.has(String(params[2]).toLowerCase()) ? [{ journal_exists: 1 }] : [] };
      }
      if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.state !== 'draft') return { rows: [] };
        if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
        if (row.message_text !== String(params[5])) return { rows: [] };
        row.state = 'approved';
        return { rows: [{ approval_id: row.approval_id, conversation_id: row.conversation_id, message_text: row.message_text, subject: row.subject, state: row.state }] };
      }
      if (/INSERT INTO messages/.test(n) && /staff_email_reply/.test(n)) {
        const approvalId = (() => {
          try {
            const meta = JSON.parse(params[3]);
            return meta && meta.approval_id;
          } catch { return null; }
        })();
        if (mirrors.some((m) => m.approval_id === approvalId)) return { rows: [] };
        mirrors.push({ approval_id: approvalId, conversation_id: String(params[1]).toLowerCase(), body: params[2] });
        return { rows: [{ id: crypto.randomUUID() }] };
      }
      if (/UPDATE conversations/.test(n) || /last_message/.test(n)) return { rows: [] };
      throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
    },
  };
  return {
    durable, journal, mirrors,
    withPgClient: async (fn) => {
      try { return await fn(client); }
      finally { if (client._lk) { locks.delete(client._lk); client._lk = null; } }
    },
  };
}

async function draftThen(routes, gate, world) {
  const send = captureSend();
  const r = createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON,
    withPgClient: world.withPgClient,
    runtimeEnv: sendEnv(),
    outboundDispatch: routes.outboundDispatch,
  });
  await r.handleDraft(mockReq(dto()), {}, user(), snapshotGateEnv(sendEnv()));
  const approvalId = send.calls[0].body.approval_id;
  return { routes: r, send, approvalId };
}

async function main() {
  console.log('verify:email-approve-send-exactly-once\n');

  const world = createFakeWorld();
  const providerCalls = [];
  let dispatchPhase = 'commit';
  const outboundDispatch = async (sealed) => {
    providerCalls.push({ operation_id: sealed.operation_id, approval_id: sealed.approval_id, conversation_id: sealed.conversation_id });
    world.journal.add(sealed.operation_id);
    if (dispatchPhase === 'unknown') {
      return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
    }
    return Object.freeze({ ok: true, code: 'email_send_committed' });
  };

  const first = await draftThen({ outboundDispatch }, snapshotGateEnv(sendEnv()), world);
  ok('draft stored as draft before any provider call',
    world.durable.get(first.approvalId).state === 'draft' && providerCalls.length === 0);

  first.send.calls.length = 0;
  await first.routes.handleApproveSend(
    mockReq(dto({ approval_id: first.approvalId })),
    {},
    user(),
    snapshotGateEnv(sendEnv()),
  );
  ok('approval committed before dispatch; one fake provider invocation; 200',
    world.durable.get(first.approvalId).state === 'approved'
    && providerCalls.length === 1
    && first.send.calls[0].status === 200
    && first.send.calls[0].body.success === true
    && world.journal.size === 1);
  ok('staff_email_reply mirror at most once after commit',
    world.mirrors.length === 1 && world.mirrors[0].approval_id === first.approvalId);

  first.send.calls.length = 0;
  await first.routes.handleApproveSend(
    mockReq(dto({ approval_id: first.approvalId })),
    {},
    user(),
    snapshotGateEnv(sendEnv()),
  );
  await first.routes.handleApproveSend(
    mockReq(dto({ approval_id: first.approvalId })),
    {},
    user(),
    snapshotGateEnv(sendEnv()),
  );
  ok('duplicate click / retry / lost-response replay cannot send twice',
    providerCalls.length === 1
    && world.journal.size === 1
    && world.mirrors.length === 1
    && first.send.calls.every((c) => c.status === 409 && c.body.error === 'approval_conflict'));

  const world2 = createFakeWorld();
  dispatchPhase = 'unknown';
  const unknownCalls = [];
  const unknownDispatch = async (sealed) => {
    unknownCalls.push(sealed.operation_id);
    world2.journal.add(sealed.operation_id);
    return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
  };
  const second = await draftThen({ outboundDispatch: unknownDispatch }, snapshotGateEnv(sendEnv()), world2);
  second.send.calls.length = 0;
  await second.routes.handleApproveSend(
    mockReq(dto({ approval_id: second.approvalId })),
    {},
    user(),
    snapshotGateEnv(sendEnv()),
  );
  ok('outcome-unknown: approved, one invocation, journal claimed, no mirror',
    world2.durable.get(second.approvalId).state === 'approved'
    && unknownCalls.length === 1
    && world2.journal.size === 1
    && world2.mirrors.length === 0
    && second.send.calls[0].status === 503
    && second.send.calls[0].body.error === 'email_send_outcome_unknown');

  second.send.calls.length = 0;
  await second.routes.handleApproveSend(
    mockReq(dto({ approval_id: second.approvalId })),
    {},
    user(),
    snapshotGateEnv(sendEnv()),
  );
  ok('outcome-unknown retry is reconciliation-only: no second provider send',
    unknownCalls.length === 1
    && second.send.calls[0].status === 409
    && second.send.calls[0].body.error === 'approval_conflict');
  ok('immutable operation id reused; no second operation minted',
    world2.durable.get(second.approvalId).operation_id === unknownCalls[0]);

  console.log(`\n── verify:email-approve-send-exactly-once ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
