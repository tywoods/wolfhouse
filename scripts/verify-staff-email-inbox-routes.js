'use strict';
/** Offline Gate 3 email draft/approve-send verifier. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const {
  createStaffEmailInboxRoutes, EMAIL_DRAFT_PATH, EMAIL_APPROVE_SEND_PATH, EMAIL_INBOX_MIN_ROLE,
  BODY_KEYS, SUCCESS_DTO_KEYS, BODY_MAX_BYTES, MESSAGE_MAX_BYTES, SQL_RESOLVE, SQL_APPROVE, SQL_JOURNAL_EXISTS,
  isEmailStaffDraftsEnabled, isEmailStaffOutboundEnabled, isEmailOutboundSendEnabled,
  snapshotGateEnv, snapshotEmailReplyBody, validateJsonContentType, validateSameOrigin,
  isExactApplicationJson, bodyDigestOf, exactOriginSerialization, normalizeConfiguredOrigin,
  ENV_DRAFTS_ENABLED, ENV_OUTBOUND_ENABLED, ENV_SEND_ENABLED, ENV_COMPOSITION_ENABLED, ENV_PORTAL_ORIGIN,
} = require('./lib/staff-email-inbox-routes');
const {
  EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED, EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
} = require('./lib/email-authority-bound-outbound-operation');
const C='11111111-1111-4111-8111-111111111111',L='22222222-2222-4222-8222-222222222222',E='33333333-3333-4333-8333-333333333333',E2='33333333-3333-4333-8333-333333333334';
const V='44444444-4444-4444-8444-444444444444',A='55555555-5555-4555-8555-555555555555',EV='66666666-6666-4666-8666-666666666666',EV2='66666666-6666-4666-8666-666666666667';
const K='sunset-somo',MAIL='desk@sunset.test',SRC='AAMkAGI2-SRC-EMAIL-INBOX-ROUTE',SRC2='AAMkAGI2-SRC-EMAIL-INBOX-ROUTE-E2';
const BODY='Staff email draft body for Gate3 approve path.',DIGEST=crypto.createHash('sha256').update(BODY,'utf8').digest('hex');
const ORIGIN='https://staff.sunset.test',TOKEN='atok-NEVER_LEAK-email-inbox',PLANTED='NEVER_LEAK_planted';
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,BASE='0334a323';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return ![TOKEN, PLANTED, MAIL, 'access_token', 'refresh_token', 'body too large'].some((s) => t.includes(s));
}
function enabledEnv(extra = {}) {
  return Object.freeze(Object.assign(Object.create(null), {
    [ENV_DRAFTS_ENABLED]: 'true', [ENV_OUTBOUND_ENABLED]: 'true', [ENV_SEND_ENABLED]: 'false', [ENV_PORTAL_ORIGIN]: ORIGIN,
  }, extra));
}
function user(o = {}) { return { staff_user_id: A, client_id: C, client_slug: 'sunset', role: 'operator', status: 'active', ...o }; }
function captureSend() {
  const calls = [];
  return { calls, sendJSON(_r, status, body) { calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body }); return body; } };
}
function mockReq(bodyObj, headers = {}) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }, headers),
    enumerable: true, writable: true,
  });
  ee.destroy = function destroy(err) { ee.emit('error', err || new Error('destroyed')); };
  process.nextTick(() => { if (payload) ee.emit('data', Buffer.from(payload, 'utf8')); ee.emit('end'); });
  return ee;
}
function dto(o = {}) { return { conversation_id: V, message_text: BODY, approval_id: null, ...o }; }
function authRow(o = {}) {
  return {
    conversation_id: V, client_id: C, location_id: L, location_key: K, endpoint_id: E,
    source_inbound_event_id: EV, provider: 'microsoft_graph', provider_mailbox_id: MAIL,
    provider_source_message_id: SRC, endpoint_outbound_enabled: true, public_address: MAIL,
    actor_staff_user_id: A, ...o,
  };
}
function createFakePg(opts = {}) {
  const durable = new Map();
  const journal = new Set();
  let endpointOutbound = opts.endpointOutbound !== false; // default on; kill-switch tests set false
  let authorityPresent = opts.authorityPresent !== false;
  let foreign = opts.foreign === true;
  let peMismatch = opts.peMismatch === true;
  let authOverride = null;
  const locks = new Map();
  const client = { async query(sql, params) {
    const n = String(sql).replace(/\s+/g, ' ').trim();
    if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
    if (/FROM clients cl/.test(n) || n === SQL_RESOLVE) {
      if (peMismatch || foreign || !authorityPresent || String(params[0]).toLowerCase() !== C
          || String(params[1]).toLowerCase() !== A || String(params[2]).toLowerCase() !== V) return { rows: [] };
      const base = authOverride || authRow({ endpoint_outbound_enabled: endpointOutbound });
      return { rows: [{ ...base, endpoint_outbound_enabled: endpointOutbound }] };
    }
    if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
      const approvalId = String(params[0]).toLowerCase(); const operationId = String(params[1]).toLowerCase();
      for (const r of durable.values()) if (r.operation_id === operationId) { const e = new Error('dup'); e.code = '23505'; throw e; }
      const row = {
        approval_id: approvalId, operation_id: operationId, client_id: String(params[2]).toLowerCase(),
        location_id: String(params[3]).toLowerCase(), location_key: String(params[4]),
        endpoint_id: String(params[5]).toLowerCase(), conversation_id: String(params[6]).toLowerCase(),
        source_inbound_event_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
        provider_mailbox_id: String(params[8]), provider_source_message_id: String(params[9]),
        draft_actor_staff_user_id: String(params[10]).toLowerCase(), approved_actor_staff_user_id: null,
        message_text: String(params[11]), body_digest: String(params[12]), state: 'draft',
      };
      durable.set(approvalId, row);
      return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id }] };
    }
    if (/SET message_text/.test(n) && /state='draft'/.test(n)) {
      const row = durable.get(String(params[0]).toLowerCase());
      if (!row || row.client_id !== String(params[1]).toLowerCase() || row.conversation_id !== String(params[2]).toLowerCase() || row.state !== 'draft') return { rows: [] };
      row.message_text = String(params[3]); row.body_digest = String(params[4]);
      row.draft_actor_staff_user_id = String(params[5]).toLowerCase();
      return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id }] };
    }
    if (/FOR UPDATE/.test(n)) {
      const id = String(params[0]).toLowerCase();
      while (locks.has(id)) await new Promise((r) => setImmediate(r));
      locks.set(id, 1); client._lk = id;
      const row = durable.get(id);
      if (!row || row.client_id !== String(params[1]).toLowerCase() || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
      return { rows: [{ ...row }] };
    }
    if (n === SQL_JOURNAL_EXISTS) {
      return { rows: journal.has(String(params[2]).toLowerCase()) ? [{ journal_exists: 1 }] : [] };
    }
    if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
      // params: approval_id, client_id, conversation_id, operation_id, actor, message_text, body_digest
      const row = durable.get(String(params[0]).toLowerCase());
      if (!row || row.client_id !== String(params[1]).toLowerCase() || row.conversation_id !== String(params[2]).toLowerCase() || row.state !== 'draft') return { rows: [] };
      if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
      if (row.message_text !== String(params[5]) || row.body_digest !== String(params[6])) return { rows: [] };
      row.state = 'approved'; row.approved_actor_staff_user_id = String(params[4]).toLowerCase();
      return { rows: [{ approval_id: row.approval_id, conversation_id: row.conversation_id, message_text: row.message_text, state: row.state }] };
    }
    throw new Error(`unexpected_sql:${n.slice(0, 60)}`);
  } };
  return {
    durable, journal, client,
    setEndpointOutbound(v) { endpointOutbound = v === true; },
    setAuthorityPresent(v) { authorityPresent = v === true; },
    setForeign(v) { foreign = v === true; },
    setPeMismatch(v) { peMismatch = v === true; },
    setAuthOverride(v) { authOverride = v; },
    withPgClient: async (fn) => { try { return await fn(client); } finally { if (client._lk) { locks.delete(client._lk); client._lk = null; } } },
  };
}
function productionReadBody(req) {
  if (req._cachedBody !== undefined) return Promise.resolve(req._cachedBody);
  return new Promise((resolve, reject) => {
    const chunks = []; let done = false;
    const fail = (err) => { if (done) return; done = true; reject(err); };
    req.on('data', (chunk) => {
      if (done) return;
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 10240) {
        const err = new Error('body too large');
        if (typeof req.destroy === 'function') req.destroy(err);
        fail(err);
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      req._cachedBody = Buffer.concat(chunks).toString('utf8');
      resolve(req._cachedBody);
    });
    req.on('error', fail);
  });
}
async function main() {
  console.log('verify:staff-email-inbox-routes');
  ok('contract paths/keys/body caps', EMAIL_DRAFT_PATH === '/staff/inbox/email/draft'
    && EMAIL_APPROVE_SEND_PATH === '/staff/inbox/email/approve-send' && EMAIL_INBOX_MIN_ROLE === 'operator'
    && BODY_KEYS.join(',') === 'conversation_id,message_text,approval_id'
    && SUCCESS_DTO_KEYS.join(',') === 'success,conversation_id,message_text,approval_id'
    && BODY_MAX_BYTES === 10240 && MESSAGE_MAX_BYTES === 8000
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY === false
    && bodyDigestOf(BODY) === DIGEST);
  ok('SQL_RESOLVE from ev + p↔ev equality + endpoint provider_resource_id',
    /ev\.provider AS provider/.test(SQL_RESOLVE) && /ev\.provider_mailbox_id AS provider_mailbox_id/.test(SQL_RESOLVE)
    && /ev\.provider_message_id AS provider_source_message_id/.test(SQL_RESOLVE)
    && /ev\.location_id = p\.location_id/.test(SQL_RESOLVE) && /ev\.endpoint_id = p\.endpoint_id/.test(SQL_RESOLVE)
    && /ev\.provider = p\.provider/.test(SQL_RESOLVE) && /ev\.provider_mailbox_id = p\.provider_mailbox_id/.test(SQL_RESOLVE)
    && /ev\.provider_message_id = p\.provider_message_id/.test(SQL_RESOLVE)
    && /ev\.provider_mailbox_id = ep\.provider_resource_id/.test(SQL_RESOLVE)
    && /ep\.provider_resource_id IS NOT NULL/.test(SQL_RESOLVE)
    && /btrim\(ep\.provider_resource_id\) <> ''/.test(SQL_RESOLVE)
    && /ep\.provider_resource_id ~ '\^\[0-9a-f\]\{8\}/.test(SQL_RESOLVE)
    && !/tenant_email_inbound_delta_states/.test(SQL_RESOLVE)
    && /ep\.public_address IS NOT NULL/.test(SQL_RESOLVE)
    && !/public_address\s*=\s*.*provider_mailbox_id/.test(SQL_RESOLVE)
    && /ORDER BY ev\.received_at DESC, ev\.id DESC/.test(SQL_RESOLVE)
    && !/p\.provider AS provider/.test(SQL_RESOLVE));
  ok('SQL_APPROVE binds locked operation_id CAS', /operation_id=\$4::uuid/.test(SQL_APPROVE)
    && /state='draft'/.test(SQL_APPROVE) && /message_text=\$6/.test(SQL_APPROVE)
    && /body_digest=\$7/.test(SQL_APPROVE) && /approved_actor_staff_user_id=\$5::uuid/.test(SQL_APPROVE));
  ok('approved initial dispatch uses exact journal absence query', /SELECT 1 AS journal_exists/.test(SQL_JOURNAL_EXISTS)
    && /client_id=\$1::uuid/.test(SQL_JOURNAL_EXISTS) && /approval_id=\$2::uuid/.test(SQL_JOURNAL_EXISTS)
    && /operation_id=\$3::uuid/.test(SQL_JOURNAL_EXISTS) && /conversation_id=\$4::uuid/.test(SQL_JOURNAL_EXISTS));
  ok('default-off flags exact true only', !isEmailStaffDraftsEnabled({})
    && !isEmailStaffDraftsEnabled({ [ENV_DRAFTS_ENABLED]: 'TRUE' })
    && isEmailStaffDraftsEnabled({ [ENV_DRAFTS_ENABLED]: 'true' })
    && !isEmailStaffOutboundEnabled({}) && isEmailStaffOutboundEnabled({ [ENV_OUTBOUND_ENABLED]: 'true' })
    && !isEmailOutboundSendEnabled({}) && isEmailOutboundSendEnabled({ [ENV_SEND_ENABLED]: 'true' }));
  const multi = 'é'.repeat(4000);
  ok('exact DTO + UTF-8 byte message max', !!snapshotEmailReplyBody(dto())
    && snapshotEmailReplyBody(dto()).approval_id === null
    && !!snapshotEmailReplyBody(dto({ approval_id: crypto.randomUUID() }))
    && snapshotEmailReplyBody({ ...dto(), endpoint_id: E }) === null
    && snapshotEmailReplyBody(dto({ message_text: '' })) === null
    && snapshotEmailReplyBody(dto({ message_text: 'x'.repeat(MESSAGE_MAX_BYTES + 1) })) === null
    && snapshotEmailReplyBody(dto({ message_text: multi })) !== null
    && snapshotEmailReplyBody(dto({ message_text: multi + 'y' })) === null
    && (() => { const o = dto(); Object.defineProperty(o, 'message_text', { get() { return BODY; }, enumerable: true }); return snapshotEmailReplyBody(o) === null; })());
  ok('origin exact; hostile path rejected',
    exactOriginSerialization(ORIGIN) === ORIGIN
    && exactOriginSerialization(`${ORIGIN}/evil/path`) === null
    && exactOriginSerialization(`${ORIGIN}?q=1`) === null
    && exactOriginSerialization(`${ORIGIN}#frag`) === null
    && exactOriginSerialization('https://user:pass@staff.sunset.test') === null
    && normalizeConfiguredOrigin(`${ORIGIN}/cfg`) === ORIGIN
    && validateSameOrigin(mockReq(dto()), enabledEnv()).ok
    && !validateSameOrigin(mockReq(dto(), { origin: 'https://evil.test' }), enabledEnv()).ok
    && !validateSameOrigin(mockReq(dto(), { origin: `${ORIGIN}/hostile` }), enabledEnv()).ok
    && validateSameOrigin(mockReq(dto(), { origin: undefined, referer: `${ORIGIN}/staff/ui` }), enabledEnv()).ok
    && isExactApplicationJson('application/json') && !isExactApplicationJson('text/plain')
    && validateJsonContentType(mockReq(dto())).ok);
  let dbHits = 0;
  const sendOff = captureSend();
  await createStaffEmailInboxRoutes({
    sendJSON: sendOff.sendJSON, withPgClient: async () => { dbHits += 1; throw new Error('no db'); }, runtimeEnv: {},
  }).handleDraft(mockReq(dto()), {}, user(), snapshotGateEnv({}));
  await createStaffEmailInboxRoutes({
    sendJSON: sendOff.sendJSON, withPgClient: async () => { dbHits += 1; throw new Error('no db'); }, runtimeEnv: {},
  }).handleApproveSend(mockReq(dto({ approval_id: crypto.randomUUID() })), {}, user(), snapshotGateEnv({}));
  ok('disabled 404 zero DB', sendOff.calls.length === 2 && sendOff.calls.every((c) => c.status === 404 && c.body.error === 'not_found') && dbHits === 0);
  let ownerConstruct=0,ownerInvoke=0,dispatchHits=0;
  const pg = createFakePg();
  const send = captureSend();
  const routes = createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON, withPgClient: pg.withPgClient,
    outboundDispatch: async () => { dispatchHits += 1; ownerInvoke += 1; }, runtimeEnv: enabledEnv(),
  });
  const gate = snapshotGateEnv(enabledEnv());
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap1 = send.calls[0].body.approval_id;
  ok('draft create DTO + one op', send.calls[0].status === 200 && send.calls[0].body.success === true
    && send.calls[0].body.conversation_id === V && send.calls[0].body.message_text === BODY
    && UUID_RE.test(ap1) && !('operation_id' in send.calls[0].body) && pg.durable.get(ap1).body_digest === DIGEST && noLeak(send.calls[0].body));
  const op1 = pg.durable.get(ap1).operation_id;
  const body2 = 'Updated staff email draft body.';
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto({ approval_id: ap1, message_text: body2 })), {}, user(), gate);
  ok('draft CAS update', send.calls[0].status === 200 && send.calls[0].body.message_text === body2
    && pg.durable.get(ap1).operation_id === op1 && pg.durable.get(ap1).body_digest === bodyDigestOf(body2));
  send.calls.length = 0; pg.setForeign(true);
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const foreignBody = send.calls[0] && send.calls[0].body;
  ok('foreign tenant wire-equivalent 404', send.calls[0].status === 404 && foreignBody.error === 'not_found' && noLeak(foreignBody));
  pg.setForeign(false); pg.setAuthorityPresent(false); send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  ok('missing authority wire-equivalent 404', send.calls[0].status === 404 && send.calls[0].body.error === 'not_found'
    && JSON.stringify(send.calls[0].body) === JSON.stringify(foreignBody));
  pg.setAuthorityPresent(true);
  pg.setPeMismatch(true); send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  ok('p↔ev mismatch 404', send.calls[0].status === 404 && send.calls[0].body.error === 'not_found');
  pg.setPeMismatch(false);
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto({ approval_id: crypto.randomUUID() })), {}, user(), gate);
  ok('CAS miss 404', send.calls[0].status === 404);
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap2 = send.calls[0].body.approval_id; send.calls.length = 0;
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap2, message_text: 'different body text' })), {}, user(), gate);
  ok('body mismatch 409 no dispatch', send.calls[0].status === 409 && send.calls[0].body.error === 'body_mismatch'
    && pg.durable.get(ap2).state === 'draft' && dispatchHits === 0);
  send.calls.length = 0;
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap2, message_text: BODY })), {}, user(), gate);
  ok('approve→503 email_send_disabled durable', send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_disabled' && send.calls[0].body.approval_id === ap2
    && pg.durable.get(ap2).state === 'approved' && pg.durable.get(ap2).approved_actor_staff_user_id === A
    && dispatchHits === 0 && noLeak(send.calls[0].body));
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const apDrift = send.calls[0].body.approval_id;
  ok('draft stored E1', pg.durable.get(apDrift).endpoint_id === E && pg.durable.get(apDrift).source_inbound_event_id === EV);
  pg.setAuthOverride(authRow({ endpoint_id: E2, source_inbound_event_id: EV2, provider_source_message_id: SRC2 }));
  send.calls.length = 0;
  await routes.handleApproveSend(mockReq(dto({ approval_id: apDrift, message_text: BODY })), {}, user(), gate);
  ok('E1→E2 authority drift 409 no approve', send.calls[0].status === 409 && send.calls[0].body.error === 'approval_conflict'
    && pg.durable.get(apDrift).state === 'draft' && dispatchHits === 0);
  pg.setAuthOverride(null);
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const apOpMiss = send.calls[0].body.approval_id;
  const wrongOp = crypto.randomUUID();
  const casMiss = await pg.withPgClient((c) => c.query(SQL_APPROVE, [
    apOpMiss, C, V, wrongOp, A, BODY, DIGEST,
  ]));
  ok('operation_id CAS mismatch zero approval', Array.isArray(casMiss.rows) && casMiss.rows.length === 0
    && pg.durable.get(apOpMiss).state === 'draft' && !('operation_id' in dto()) && dispatchHits === 0);
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap3 = send.calls[0].body.approval_id; send.calls.length = 0;
  await Promise.all([
    routes.handleApproveSend(mockReq(dto({ approval_id: ap3 })), {}, user(), gate),
    routes.handleApproveSend(mockReq(dto({ approval_id: ap3 })), {}, user(), gate),
  ]);
  const st = send.calls.map((c) => c.status).sort();
  ok('concurrent approved record remains retryable while journal absent', pg.durable.get(ap3).state === 'approved'
    && st.join(',') === '503,503' && dispatchHits === 0);
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap4 = send.calls[0].body.approval_id; send.calls.length = 0;
  pg.setEndpointOutbound(true);
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap4 })), {}, user(),
    snapshotGateEnv(enabledEnv({ [ENV_SEND_ENABLED]: 'true' })));
  ok('runtime offline endpoint true durable approved 503', send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_disabled' && pg.durable.get(ap4).state === 'approved'
    && dispatchHits === 0 && noLeak(send.calls[0].body));
  const initialEnv = snapshotGateEnv(enabledEnv({ [ENV_SEND_ENABLED]: 'true', [ENV_COMPOSITION_ENABLED]: 'true' }));
  const initialPg = createFakePg(); const initialSend = captureSend(); let initialDispatches = 0;
  const initialRoutes = createStaffEmailInboxRoutes({
    sendJSON: initialSend.sendJSON, withPgClient: initialPg.withPgClient, runtimeEnv: enabledEnv(),
    outboundDispatch: async (sealed) => {
      initialDispatches += 1; initialPg.journal.add(sealed.operation_id);
      return Object.freeze({ ok: true, code: 'email_send_committed' });
    },
  });
  await initialRoutes.handleDraft(mockReq(dto()), {}, user(), gate);
  const initialApproval = initialSend.calls[0].body.approval_id;
  initialPg.durable.get(initialApproval).state = 'approved'; initialSend.calls.length = 0;
  await initialRoutes.handleApproveSend(mockReq(dto({ approval_id: initialApproval })), {}, user(), initialEnv);
  await initialRoutes.handleApproveSend(mockReq(dto({ approval_id: initialApproval })), {}, user(), initialEnv);
  ok('approved exact-authority journal-absent initial dispatch once; replay zero-call', initialDispatches === 1
    && initialSend.calls[0].status === 200 && initialSend.calls[1].status === 409
    && initialSend.calls[1].body.error === 'approval_conflict');
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap5 = send.calls[0].body.approval_id; send.calls.length = 0;
  pg.setEndpointOutbound(false);
  await routes.handleApproveSend(mockReq(dto({ approval_id: ap5 })), {}, user(),
    snapshotGateEnv(enabledEnv({ [ENV_SEND_ENABLED]: 'true' })));
  ok('endpoint outbound false zero approval 503', send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_disabled' && pg.durable.get(ap5).state === 'draft'
    && dispatchHits === 0 && noLeak(send.calls[0].body));
  ok('no runtime owner construction/invocation', ownerConstruct===0 && ownerInvoke===0 && dispatchHits===0);
  dbHits = 0; const send2 = captureSend();
  const routes2 = createStaffEmailInboxRoutes({
    sendJSON: send2.sendJSON, withPgClient: async (fn) => { dbHits += 1; return pg.withPgClient(fn); }, runtimeEnv: enabledEnv(),
  });
  const g2 = snapshotGateEnv(enabledEnv());
  await routes2.handleDraft(mockReq(dto(), { origin: 'https://evil.example' }), {}, user(), g2);
  await routes2.handleDraft(mockReq(dto(), { 'content-type': 'text/plain' }), {}, user(), g2);
  await routes2.handleDraft(mockReq(dto()), {}, null, g2);
  ok('origin/ct/actor reject before DB', send2.calls.map((c) => c.status).join(',') === '403,415,403' && dbHits === 0);
  const audits = [];
  const sendH = captureSend();
  await createStaffEmailInboxRoutes({
    sendJSON: sendH.sendJSON, appendAuditLog: (e) => audits.push(e),
    withPgClient: async () => { throw new Error(`db boom ${TOKEN} ${PLANTED} access_token=xyz`); },
    runtimeEnv: enabledEnv(),
  }).handleDraft(mockReq(dto()), {}, user(), snapshotGateEnv(enabledEnv()));
  const proxyRow = new Proxy(authRow(), { get(t, p) { if (p === 'provider_mailbox_id') throw new Error(TOKEN); return t[p]; } });
  const sendP = captureSend();
  await createStaffEmailInboxRoutes({
    sendJSON: sendP.sendJSON, appendAuditLog: (e) => audits.push(e),
    withPgClient: async (fn) => fn({ async query() { return { rows: [proxyRow] }; } }),
    runtimeEnv: enabledEnv(),
  }).handleDraft(mockReq(dto()), {}, user(), snapshotGateEnv(enabledEnv()));
  ok('hostile DB/proxy bounded + audit clean', sendH.calls[0].status === 500 && sendH.calls[0].body.error === 'draft_failed'
    && noLeak(sendH.calls[0].body) && noLeak(sendP.calls[0]) && audits.every((a) => noLeak(a)));
  ok('oversized JSON exceeds production 10240', Buffer.byteLength(JSON.stringify(dto({ message_text: 'Z'.repeat(12000) })), 'utf8') > 10240);
  const sendB = captureSend();
  await createStaffEmailInboxRoutes({
    sendJSON: sendB.sendJSON, readBody: productionReadBody,
    withPgClient: async () => { throw new Error('no'); }, runtimeEnv: enabledEnv(),
  }).handleDraft(mockReq(dto({ message_text: 'Z'.repeat(12000) })), {}, user(), snapshotGateEnv(enabledEnv()));
  ok('production reader body limit bounded', sendB.calls.length === 1 && sendB.calls[0].status === 400
    && sendB.calls[0].body.error === 'invalid_request' && noLeak(sendB.calls[0].body));
  const wa = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-inbox-routes.js'));
  const waBase = spawnSync('git', ['show', `${BASE}:scripts/lib/staff-inbox-routes.js`], { cwd: ROOT, encoding: 'buffer', maxBuffer: 20 << 20 });
  ok('WhatsApp owner files byte-diff unchanged vs base', waBase.status === 0 && Buffer.compare(wa, waBase.stdout) === 0);
  const inbox105 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-staff-inbox-routes.js')], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: process.env,
  });
  ok('staff inbox 105 suite', inbox105.status === 0 && /pass=105/.test(inbox105.stdout + inbox105.stderr));
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const di = apiSrc.indexOf('pathname === EMAIL_DRAFT_PATH');
  const ai = apiSrc.indexOf('pathname === EMAIL_APPROVE_SEND_PATH');
  const inbox = require('./lib/staff-inbox-routes');
  ok('router wiring + WhatsApp path intact', di > 0 && ai > 0
    && apiSrc.slice(di, di + 500).indexOf('isEmailStaffDraftsEnabled') < apiSrc.slice(di, di + 500).indexOf("requireAuth(req, res, 'operator')")
    && apiSrc.includes('handleInboxSendReply') && inbox.INBOX_SEND_REPLY_PATH === '/staff/inbox/send-reply'
    && !inbox.INBOX_ROUTE_TABLE.some((r) => /email/.test(r.path || '')));
  const up = fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8');
  const down = fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals_down.sql'), 'utf8');
  ok('070 schema + down refuse', /CREATE TABLE tenant_email_reply_approvals/.test(up)
    && /UNIQUE \(operation_id\)/.test(up) && /body_digest/.test(up)
    && /state IN \('draft', 'approved', 'terminal'\)/.test(up)
    && /source_inbound_event_id/.test(up) && /tenant_email_reply_approvals_protect/.test(up)
    && /070_down_refused/.test(down));
  let PGlite = null;
  try { PGlite = require('@electric-sql/pglite').PGlite; } catch {
    try { PGlite = require('/opt/data/wolfhouse-agent/node_modules/@electric-sql/pglite').PGlite; } catch { PGlite = null; }
  }
  if (!PGlite) ok('PGlite required', false, 'unavailable');
  else await provePglite(PGlite);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package script present', !!pkg.scripts['verify:staff-email-inbox-routes']);
  await proveRealRouter();
  console.log(`\n── verify:staff-email-inbox-routes ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}
async function provePglite(PGlite) {
  const db = new PGlite();
  await db.exec(`CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE clients (id UUID PRIMARY KEY, slug TEXT);
CREATE TABLE staff_users (id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), email TEXT, role TEXT, status TEXT, UNIQUE (client_id, id));
CREATE TABLE conversations (id UUID PRIMARY KEY, client_id UUID NOT NULL, phone TEXT, UNIQUE (client_id, id));
CREATE TABLE tenant_locations (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
CREATE TABLE tenant_channel_endpoints (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
CREATE TABLE tenant_email_inbound_events (id UUID PRIMARY KEY, client_id UUID NOT NULL, UNIQUE (client_id, id));`);
  await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8'));
  await db.query('INSERT INTO clients (id, slug) VALUES ($1,$2)', [C,'sunset']);
  await db.query('INSERT INTO staff_users (id, client_id, email, role, status) VALUES ($1,$2,$3,$4,$5)', [A,C,'op@t','operator','active']);
  await db.query('INSERT INTO conversations (id, client_id, phone) VALUES ($1,$2,$3)', [V,C,'emailv1:x']);
  await db.query('INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)', [L,C,K]);
  await db.query('INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ($1,$2,$3)', [E,C,K]);
  await db.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [EV,C]);
  const ap = crypto.randomUUID(); const op = crypto.randomUUID();
  const ins = `INSERT INTO tenant_email_reply_approvals (
    approval_id, operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
    source_inbound_event_id, provider, provider_mailbox_id, provider_source_message_id,
    draft_actor_staff_user_id, message_text, body_digest, state
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'microsoft_graph',$9,$10,$11,$12,$13,'draft')`;
  await db.query(ins, [ap, op, C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST]);
  let dupOp = false;
  try { await db.query(ins, [crypto.randomUUID(), op, C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST]); } catch { dupOp = true; }
  const b2 = 'pglite cas'; const d2 = crypto.createHash('sha256').update(b2, 'utf8').digest('hex');
  await db.query(`UPDATE tenant_email_reply_approvals SET message_text=$2, body_digest=$3 WHERE approval_id=$1 AND state='draft'`, [ap, b2, d2]);
  await db.query(`UPDATE tenant_email_reply_approvals SET state='approved', approved_actor_staff_user_id=$2, approved_at=NOW() WHERE approval_id=$1 AND state='draft'`, [ap, A]);
  let bodyMut = false, idMut = false, actorDec = false;
  try { await db.query(`UPDATE tenant_email_reply_approvals SET message_text=$2 WHERE approval_id=$1`, [ap, 'mut']); } catch { bodyMut = true; }
  try { await db.query(`UPDATE tenant_email_reply_approvals SET operation_id=$2 WHERE approval_id=$1`, [ap, crypto.randomUUID()]); } catch { idMut = true; }
  try { await db.query(`UPDATE tenant_email_reply_approvals SET approved_actor_staff_user_id=NULL WHERE approval_id=$1`, [ap]); } catch { actorDec = true; }
  let downRefused = false;
  try { await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals_down.sql'), 'utf8')); }
  catch (e) { downRefused = /070_down_refused/.test(String(e && e.message || e)); }
  try { await db.query('ROLLBACK'); } catch { /* */ }
  await db.query('DELETE FROM tenant_email_reply_approvals');
  let downOk = false;
  try { await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals_down.sql'), 'utf8')); downOk = true; } catch { downOk = false; }
  ok('070 pglite constraints/down', dupOp && bodyMut && idMut && actorDec && downRefused && downOk);
  await db.close();
}
async function proveRealRouter() {
  const apprId = crypto.randomUUID();
  const script = `'use strict';
const assert=require('node:assert/strict');const http=require('node:http');const path=require('node:path');
const fs=require('node:fs');const Module=require('node:module');
const ROOT=${JSON.stringify(ROOT)};const ORIGIN=${JSON.stringify(ORIGIN)};
const C=${JSON.stringify(C)};const A=${JSON.stringify(A)};const V=${JSON.stringify(V)};const BODY=${JSON.stringify(BODY)};
const DRAFT=${JSON.stringify(EMAIL_DRAFT_PATH)};const APPROVE=${JSON.stringify(EMAIL_APPROVE_SEND_PATH)};
const STAFF=path.join(ROOT,'scripts/staff-query-api.js');const SESSION='email-inbox-offline-session-token';
try{require.resolve('dotenv')}catch{const c=['/opt/data/wolfhouse-agent/node_modules',path.join(ROOT,'node_modules')].find(x=>fs.existsSync(path.join(x,'dotenv')));if(c){process.env.NODE_PATH=c+(process.env.NODE_PATH?path.delimiter+process.env.NODE_PATH:'');Module._initPaths()}}
function clear(){for(const k of Object.keys(require.cache)){if(/staff-query-api\\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-inbox-routes/.test(k))delete require.cache[k]}}
function listen(s){return new Promise((r,j)=>{s.listen(0,'127.0.0.1',()=>r(s.address().port));s.on('error',j)})}
function close(s){return new Promise(r=>s.close(()=>r()))}
function request(port,o){return new Promise((resolve,reject)=>{const payload=o.body==null?null:Buffer.from(o.body);const hdrs=Object.assign({},o.headers||{});if(payload)hdrs['content-length']=payload.length;const req=http.request({hostname:'127.0.0.1',port,path:o.path,method:o.method,headers:hdrs},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>{const raw=Buffer.concat(c).toString('utf8');let body=raw;try{body=JSON.parse(raw)}catch{}resolve({status:res.statusCode,body,raw})})});req.on('error',reject);if(payload)req.write(payload);req.end()})}
(async()=>{
process.env.NODE_ENV='test';process.env.STAFF_RUNTIME_PROFILE='test';process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER='1';
process.env.STAFF_AUTH_REQUIRED='true';process.env.STAFF_AUTH_HTTPS='false';process.env.STAFF_QUERY_API_HOST='127.0.0.1';
process.env.STAFF_PORTAL_ORIGIN=ORIGIN;delete process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED;delete process.env.EMAIL_STAFF_OUTBOUND_ENABLED;
clear();const api=require(STAFF);assert.equal(typeof api.createStaffQueryApiHttpServer,'function');
let dbCalls=0;api.setFortress15j3OfflineSeams({withPgClient:async fn=>{dbCalls+=1;return fn({async query(){return{rows:[]}}})},
resolveSessionUser(req){const raw=String((req.headers&&req.headers.cookie)||'');if(raw.includes(SESSION))return{staff_user_id:A,email:'op@t',role:'operator',status:'active',display_name:'Op',client_id:C,client_slug:'sunset',session_id:'s1'};return null},
canAccessClient(u,s){return !!(u&&u.client_slug==='sunset'&&s==='sunset')}});
const server=api.createStaffQueryApiHttpServer();const port=await listen(server);
try{
let r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:null})});
assert.equal(r.status,404);assert.equal(r.body.error,'not_found');assert.equal(dbCalls,0);assert.equal(String(r.raw).includes('Authentication required'),false);
process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED='true';process.env.EMAIL_STAFF_OUTBOUND_ENABLED='true';
r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:null})});
assert.ok(r.status===401||r.status===403);assert.equal(dbCalls,0);
r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'text/plain',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:null})});
assert.equal(r.status,415);assert.equal(dbCalls,0);
r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'application/json',origin:ORIGIN+'/evil',cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:null})});
assert.equal(r.status,403);assert.equal(dbCalls,0);
const huge=JSON.stringify({conversation_id:V,message_text:'Q'.repeat(12000),approval_id:null});assert.ok(Buffer.byteLength(huge)>10240);
let bodyLimitOk=false;try{r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:huge});bodyLimitOk=r.status>=400&&!String(r.raw||'').includes('atok-')}catch(e){bodyLimitOk=/socket hang up|ECONNRESET|body too large/i.test(String(e&&e.message||e))}assert.ok(bodyLimitOk);
dbCalls=0;r=await request(port,{method:'POST',path:DRAFT,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:null})});
assert.equal(r.status,404);assert.equal(r.body&&r.body.error,'not_found');assert.ok(dbCalls>=1);
r=await request(port,{method:'POST',path:APPROVE,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,message_text:BODY,approval_id:${JSON.stringify(apprId)}})});
assert.ok(r.status===404||r.status===400||r.status===409||r.status===500);
console.log('real_router_ok');
}finally{await close(server);api.setFortress15j3OfflineSeams(null);clear()}
})().catch(e=>{console.error(e);process.exit(1)});`;
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '/opt/data/wolfhouse-agent/node_modules' },
  });
  ok('real-router offline integration', out.status === 0 && /real_router_ok/.test(out.stdout),
    (out.stderr || out.stdout || '').slice(0, 400));
}
main().catch((e) => { console.error(e); process.exit(1); });
