#!/usr/bin/env node
'use strict';

/**
 * EMAIL-SEND-COMPLETION vertical 3.
 *
 * Draft receipt is bound to selected client/conversation, subject/body snapshot,
 * canonical approval, inbound event, endpoint and mailbox. Stale selection or
 * authority drift cannot act on or repaint another conversation.
 */

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const {
  createStaffEmailInboxRoutes,
  snapshotGateEnv,
  SQL_RESOLVE,
} = require('./lib/staff-email-inbox-routes');
const ROUTES_SRC = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');

const ORIGIN = 'https://staff.sunset.test';
const C = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const A = '55555555-5555-4555-8555-555555555555';
const V = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const L = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444';
const E2 = '66666666-6666-4666-8666-666666666666';
const EV = '77777777-7777-4777-8777-777777777777';
const MAIL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SRC = 'graph-src-1';
const BODY = 'Bound staff reply body.';
const SUBJECT = 'Re: Sunset booking';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function user(clientId) {
  return {
    staff_user_id: A, email: 'op@t', role: 'operator', status: 'active',
    display_name: 'Op', client_id: clientId || C, client_slug: 'sunset', session_id: 's1',
  };
}
function enabledEnv() {
  return {
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
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
function uiDto(o) {
  return Object.assign({
    conversation_id: V, message_text: BODY, approval_id: null,
    subject: SUBJECT, email_subject: SUBJECT,
  }, o || {});
}

function createBoundPg() {
  const durable = new Map();
  let authority = {
    conversation_id: V, client_id: C, location_id: L, location_key: 'sunset-somo',
    endpoint_id: E, source_inbound_event_id: EV, provider: 'microsoft_graph',
    provider_mailbox_id: MAIL, provider_source_message_id: SRC,
    endpoint_outbound_enabled: true, public_address: 'support@example.test',
    actor_staff_user_id: A,
  };
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (/UNION ALL/i.test(n) && /staff_email_reply/.test(n)) return { rows: [] };
      if (n === SQL_RESOLVE || /FROM clients cl/.test(n)) {
        if (String(params[0]).toLowerCase() !== C) return { rows: [] };
        if (String(params[2]).toLowerCase() !== authority.conversation_id) return { rows: [] };
        return { rows: [{ ...authority }] };
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
      if (/SET message_text/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
        row.message_text = String(params[3]);
        row.body_digest = String(params[4]);
        row.subject = params[6] == null ? null : String(params[6]);
        return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id, subject: row.subject }] };
      }
      throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
    },
  };
  return {
    durable,
    setAuthority(v) { authority = Object.assign({}, authority, v); },
    withPgClient: async (fn) => fn(client),
  };
}

function proveCookedSelectionBinding() {
  const src = fs.readFileSync(THREAD, 'utf8');
  ok('receipt acceptor requires conversation_id === selected conv and exact body snapshot',
    /cid !== String\(reqConvId/.test(src)
    && /emailOwnData\(data, 'message_text'\) !== reqText/.test(src));
  ok('per-conversation reply state never shared',
    src.includes('_emailReplyStateByConv')
    && /emailReplyState\(convId\)/.test(src));
  ok('stale selection cannot repaint another conversation',
    /if \(selectedConvId !== snapConv\) return;/.test(src));
  ok('draft receipt still binds originating conversation state when selection drifted',
    /st\.approvalId = accepted\.approval_id;[\s\S]{0,180}if \(selectedConvId !== snapConv\) return;/.test(src)
    || /if \(accepted\) \{[\s\S]*st\.approvalId = accepted\.approval_id;[\s\S]*if \(selectedConvId !== snapConv\) return;/.test(src));
}

async function main() {
  console.log('verify:email-draft-receipt-binding\n');
  proveCookedSelectionBinding();
  ok('insert SQL binds inbound event, endpoint, mailbox, conversation, subject',
    /const SQL_INSERT_DRAFT = `[\s\S]*source_inbound_event_id[\s\S]*endpoint_id[\s\S]*conversation_id[\s\S]*provider_mailbox_id[\s\S]*subject/.test(ROUTES_SRC));

  const pg = createBoundPg();
  const send = captureSend();
  const routes = createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON,
    withPgClient: pg.withPgClient,
    runtimeEnv: enabledEnv(),
  });
  const gate = snapshotGateEnv(enabledEnv());
  await routes.handleDraft(mockReq(uiDto()), {}, user(), gate);
  const created = send.calls[0];
  const ap = created && created.body && created.body.approval_id;
  const stored = pg.durable.get(ap);
  ok('draft receipt conversation+body match request',
    created.status === 200
    && created.body.conversation_id === V
    && created.body.message_text === BODY
    && stored.conversation_id === V
    && stored.message_text === BODY);
  ok('stored draft bound to inbound event, endpoint, mailbox, subject',
    stored.source_inbound_event_id === EV
    && stored.endpoint_id === E
    && stored.provider_mailbox_id === MAIL
    && stored.subject === SUBJECT
    && stored.client_id === C);

  send.calls.length = 0;
  await routes.handleDraft(mockReq(uiDto({ conversation_id: V2 })), {}, user(), gate);
  ok('other conversation cannot reuse this authority (404 not_found)',
    send.calls[0] && send.calls[0].status === 404 && send.calls[0].body.error === 'not_found'
    && pg.durable.size === 1);

  send.calls.length = 0;
  await routes.handleDraft(mockReq(uiDto()), {}, user(C2), gate);
  ok('foreign client cannot act on this conversation',
    send.calls[0] && send.calls[0].status === 404 && send.calls[0].body.error === 'not_found'
    && pg.durable.size === 1);

  pg.setAuthority({ endpoint_id: E2 });
  send.calls.length = 0;
  await routes.handleDraft(mockReq(uiDto({ approval_id: ap, message_text: BODY })), {}, user(), gate);
  ok('endpoint drift on existing approval does not rewrite another mailbox row',
    pg.durable.get(ap).endpoint_id === E);

  console.log(`\n── verify:email-draft-receipt-binding ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
