'use strict';
/**
 * RED/GREEN Gate 3 staff-safe email outbound recovery/reconcile route.
 * Authority-neutral browser input: conversation_id + approval_id only.
 * Reconcile-only for send_dispatched; never second create/update/send.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const ROUTES_REL = 'scripts/lib/staff-email-inbox-routes.js';
const ROUTES_ABS = path.join(ROOT, ROUTES_REL);
const STAFF_ABS = path.join(ROOT, 'scripts/staff-query-api.js');
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const EV = '66666666-6666-4666-8666-666666666666';
const OP = '77777777-7777-4777-8777-777777777777';
const AP = '88888888-8888-4888-8888-888888888888';
const K = 'sunset-somo';
const MAIL = 'desk@sunset.test';
const SRC = 'AAMkAGI2-SRC-EMAIL-RECOVERY';
const DRAFT = 'AAMkAGI2-DRAFT-RECOVERY-ID';
const BODY = 'Approved staff recovery body for Gate3.';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const ORIGIN = 'https://staff.sunset.test';
const TOKEN = 'atok-NEVER_LEAK-recovery';
const PLANTED = 'NEVER_LEAK_planted_recovery';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return ![TOKEN, PLANTED, MAIL, BODY, DRAFT, 'access_token', 'refresh_token', 'immutable_draft', '@sunset'].some((s) => t.includes(s));
}
function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(_r, status, body) {
      calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body });
      return body;
    },
  };
}
function mockReq(bodyObj, headers = {}) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }, headers),
    enumerable: true, writable: true,
  });
  process.nextTick(() => { if (payload) ee.emit('data', Buffer.from(payload, 'utf8')); ee.emit('end'); });
  return ee;
}
function user(o = {}) {
  return { staff_user_id: A, client_id: C, client_slug: 'sunset', role: 'operator', status: 'active', ...o };
}
function recoveryDto(o = {}) {
  return { conversation_id: V, approval_id: AP, ...o };
}
function authRow(o = {}) {
  return {
    conversation_id: V, client_id: C, location_id: L, location_key: K, endpoint_id: E,
    source_inbound_event_id: EV, provider: 'microsoft_graph', provider_mailbox_id: MAIL,
    provider_source_message_id: SRC, endpoint_outbound_enabled: true, public_address: MAIL,
    actor_staff_user_id: A, ...o,
  };
}
function enabledEnv(extra = {}) {
  return Object.freeze(Object.assign(Object.create(null), {
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'true',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: ORIGIN,
  }, extra));
}
function createFakePg(opts = {}) {
  const approvals = new Map();
  const journals = new Map();
  let endpointOutbound = opts.endpointOutbound !== false;
  let authorityPresent = opts.authorityPresent !== false;
  let foreign = false;
  if (opts.seedApproval !== false) {
    approvals.set(AP, {
      approval_id: AP, operation_id: OP, client_id: C, location_id: L, location_key: K,
      endpoint_id: E, conversation_id: V, source_inbound_event_id: EV, provider: 'microsoft_graph',
      provider_mailbox_id: MAIL, provider_source_message_id: SRC, message_text: BODY,
      body_digest: DIGEST, state: opts.approvalState || 'approved',
      approved_actor_staff_user_id: A,
    });
  }
  if (opts.seedJournal !== false) {
    journals.set(OP, {
      operation_id: OP, approval_id: AP, client_id: C, conversation_id: V,
      phase: opts.journalPhase || 'send_dispatched',
      outcome: opts.journalOutcome || 'outcome_unknown',
      create_invocation_count: opts.createC != null ? opts.createC : 1,
      update_invocation_count: opts.updateC != null ? opts.updateC : 1,
      send_invocation_count: opts.sendC != null ? opts.sendC : 1,
      immutable_draft_id: opts.draftId !== undefined ? opts.draftId : DRAFT,
    });
  }
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (/FROM clients cl/.test(n) || /tenant_email_inbound_inbox_projections/.test(n)) {
        if (foreign || !authorityPresent || String(params[0]).toLowerCase() !== C
            || String(params[1]).toLowerCase() !== A || String(params[2]).toLowerCase() !== V) {
          return { rows: [] };
        }
        return { rows: [authRow({ endpoint_outbound_enabled: endpointOutbound })] };
      }
      if (/FROM tenant_email_reply_approvals/.test(n)) {
        const row = approvals.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
        return { rows: [{ ...row }] };
      }
      if (/FROM tenant_email_outbound_send_journal/.test(n)) {
        const row = journals.get(String(params[2]).toLowerCase()) || journals.get(String(params[1]).toLowerCase());
        // params: client_id, approval_id, operation_id, conversation_id
        const byOp = journals.get(String(params[2] || params[0]).toLowerCase());
        const j = byOp || [...journals.values()].find((x) => x.approval_id === String(params[1]).toLowerCase());
        if (!j) return { rows: [] };
        if (String(params[0]).toLowerCase() !== j.client_id) return { rows: [] };
        if (params[1] && String(params[1]).toLowerCase() !== j.approval_id) return { rows: [] };
        if (params[2] && String(params[2]).toLowerCase() !== j.operation_id) return { rows: [] };
        if (params[3] && String(params[3]).toLowerCase() !== j.conversation_id) return { rows: [] };
        return {
          rows: [{
            phase: j.phase,
            outcome: j.outcome,
            create_invocation_count: String(j.create_invocation_count),
            update_invocation_count: String(j.update_invocation_count),
            send_invocation_count: String(j.send_invocation_count),
          }],
        };
      }
      throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
    },
  };
  return {
    approvals, journals, client,
    setEndpointOutbound(v) { endpointOutbound = v === true; },
    setAuthorityPresent(v) { authorityPresent = v === true; },
    setForeign(v) { foreign = v === true; },
    setJournal(phase, outcome, counts = {}) {
      const j = journals.get(OP) || {
        operation_id: OP, approval_id: AP, client_id: C, conversation_id: V, immutable_draft_id: DRAFT,
      };
      j.phase = phase; j.outcome = outcome;
      j.create_invocation_count = counts.createC != null ? counts.createC : j.create_invocation_count;
      j.update_invocation_count = counts.updateC != null ? counts.updateC : j.update_invocation_count;
      j.send_invocation_count = counts.sendC != null ? counts.sendC : j.send_invocation_count;
      journals.set(OP, j);
    },
    withPgClient: async (fn) => fn(client),
  };
}

async function main() {
  console.log('verify:staff-email-outbound-recovery-route — Gate 3 recovery/reconcile\n');

  ok('routes module present', fs.existsSync(ROUTES_ABS));
  let mod;
  try {
    delete require.cache[ROUTES_ABS];
    mod = require(ROUTES_ABS);
  } catch (e) {
    ok('routes module loads', false, String(e && e.message || e));
    console.log(`\n── verify:staff-email-outbound-recovery-route FAILED (${pass} pass, ${fail} fail) ──`);
    process.exit(1);
  }

  ok('EMAIL_RECOVER_SEND_PATH exact',
    mod.EMAIL_RECOVER_SEND_PATH === '/staff/inbox/email/recover-send');
  ok('RECOVERY_BODY_KEYS authority-neutral only',
    Array.isArray(mod.RECOVERY_BODY_KEYS)
    && mod.RECOVERY_BODY_KEYS.join(',') === 'conversation_id,approval_id'
    && !mod.RECOVERY_BODY_KEYS.includes('message_text')
    && !mod.RECOVERY_BODY_KEYS.includes('operation_id')
    && !mod.RECOVERY_BODY_KEYS.includes('endpoint_id')
    && !mod.RECOVERY_BODY_KEYS.includes('provider_mailbox_id')
    && !mod.RECOVERY_BODY_KEYS.includes('immutable_draft_id'));
  ok('snapshotRecoveryBody export', typeof mod.snapshotRecoveryBody === 'function');
  ok('handleRecoverSend on surface', typeof mod.createStaffEmailInboxRoutes === 'function');

  const src = fs.readFileSync(ROUTES_ABS, 'utf8');
  const recoveryKeysDecl = src.match(/RECOVERY_BODY_KEYS\s*=\s*Object\.freeze\(\[([^\]]+)\]\)/);
  ok('recovery never accepts provider/authority browser fields',
    !!recoveryKeysDecl
    && recoveryKeysDecl[1].includes("'conversation_id'")
    && recoveryKeysDecl[1].includes("'approval_id'")
    && !recoveryKeysDecl[1].includes('message_text')
    && !recoveryKeysDecl[1].includes('operation_id')
    && !recoveryKeysDecl[1].includes('endpoint_id')
    && !recoveryKeysDecl[1].includes('provider_mailbox')
    && !recoveryKeysDecl[1].includes('immutable_draft')
    && /send_dispatched/.test(src)
    && /create_dispatched/.test(src)
    && /update_dispatched/.test(src));
  ok('recovery uses BIGINT-safe journal count text casts',
    /create_invocation_count::text/.test(src)
    && /update_invocation_count::text/.test(src)
    && /send_invocation_count::text/.test(src));
  ok('recovery does not log secrets/bodies/draft ids',
    !/console\.(log|error|info|warn)\([^)]*message_text/.test(src)
    && !/appendAuditLog[\s\S]{0,200}immutable_draft/.test(src)
    && !/appendAuditLog[\s\S]{0,200}operation_id/.test(src));

  // Body snapshot unit tests
  if (typeof mod.snapshotRecoveryBody === 'function') {
    ok('recovery body exact keys', !!mod.snapshotRecoveryBody(recoveryDto())
      && mod.snapshotRecoveryBody(recoveryDto()).conversation_id === V
      && mod.snapshotRecoveryBody(recoveryDto()).approval_id === AP);
    ok('recovery rejects message_text extra',
      mod.snapshotRecoveryBody({ conversation_id: V, approval_id: AP, message_text: BODY }) === null);
    ok('recovery rejects operation_id extra',
      mod.snapshotRecoveryBody({ conversation_id: V, approval_id: AP, operation_id: OP }) === null);
    ok('recovery rejects mailbox extra',
      mod.snapshotRecoveryBody({ conversation_id: V, approval_id: AP, provider_mailbox_id: MAIL }) === null);
    ok('recovery rejects accessor props', (() => {
      const o = {};
      Object.defineProperty(o, 'conversation_id', { get() { return V; }, enumerable: true });
      o.approval_id = AP;
      return mod.snapshotRecoveryBody(o) === null;
    })());
    ok('recovery rejects wrong key order extras / missing',
      mod.snapshotRecoveryBody({ approval_id: AP }) === null
      && mod.snapshotRecoveryBody({ conversation_id: V }) === null
      && mod.snapshotRecoveryBody({ conversation_id: V, approval_id: 'not-uuid' }) === null);
  } else {
    ok('recovery body exact keys', false);
    ok('recovery rejects message_text extra', false);
    ok('recovery rejects operation_id extra', false);
    ok('recovery rejects mailbox extra', false);
    ok('recovery rejects accessor props', false);
    ok('recovery rejects wrong key order extras / missing', false);
  }

  const send = captureSend();
  let dispatchHits = 0;
  let lastSealed = null;
  const sealedBodies = [];
  const pg = createFakePg();
  let routes;
  try {
    routes = mod.createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      appendAuditLog() {},
      createOutboundDispatch() {
        return Object.freeze({
          async dispatchApprovedOutbound(sealed) {
            dispatchHits += 1;
            lastSealed = sealed && typeof sealed === 'object' ? { ...sealed } : sealed;
            sealedBodies.push(lastSealed);
            return Object.freeze({ ok: true, code: 'email_send_committed' });
          },
        });
      },
      runtimeEnv: enabledEnv(),
    });
  } catch (e) {
    ok('create routes with recovery', false, String(e && e.message || e));
    console.log(`\n── verify:staff-email-outbound-recovery-route FAILED (${pass} pass, ${fail} fail) ──`);
    process.exit(1);
  }

  ok('surface exposes handleRecoverSend', typeof routes.handleRecoverSend === 'function'
    && routes.EMAIL_RECOVER_SEND_PATH === '/staff/inbox/email/recover-send');

  const gateOff = mod.snapshotGateEnv({});
  send.calls.length = 0; dispatchHits = 0;
  if (typeof routes.handleRecoverSend === 'function') {
    await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gateOff);
  }
  ok('gate-off recover → 404 zero dispatch',
    send.calls.length === 1 && send.calls[0].status === 404
    && send.calls[0].body.error === 'not_found' && dispatchHits === 0);

  const gate = mod.snapshotGateEnv(enabledEnv());
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto(), { origin: 'https://evil.test' }), {}, user(), gate);
  ok('cross-origin recover → 403 zero dispatch',
    send.calls[0].status === 403 && send.calls[0].body.error === 'origin_forbidden' && dispatchHits === 0 && noLeak(send.calls[0].body));

  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto(), { 'content-type': 'text/plain' }), {}, user(), gate);
  ok('non-json recover → 415 zero dispatch',
    send.calls[0].status === 415 && dispatchHits === 0);

  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user({ role: 'viewer' }), gate);
  ok('viewer recover → 403 zero dispatch',
    send.calls[0].status === 403 && dispatchHits === 0);

  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(
    mockReq({ conversation_id: V, approval_id: AP, message_text: BODY }),
    {}, user(), gate,
  );
  ok('message_text body rejected 400',
    send.calls[0].status === 400 && send.calls[0].body.error === 'invalid_request' && dispatchHits === 0);

  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(
    mockReq({ conversation_id: V, approval_id: AP, operation_id: OP }),
    {}, user(), gate,
  );
  ok('operation_id body rejected 400',
    send.calls[0].status === 400 && dispatchHits === 0);

  // Happy path send_dispatched → dispatch reconcile → committed
  send.calls.length = 0; dispatchHits = 0; sealedBodies.length = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('send_dispatched recovery → 200 committed',
    send.calls[0].status === 200
    && send.calls[0].body.success === true
    && send.calls[0].body.conversation_id === V
    && send.calls[0].body.approval_id === AP
    && send.calls[0].body.status === 'committed'
    && Object.keys(send.calls[0].body).sort().join(',') === 'approval_id,conversation_id,status,success'
    && dispatchHits === 1
    && noLeak(send.calls[0].body));
  ok('sealed dispatch owns server-derived authority only',
    sealedBodies.length === 1
    && sealedBodies[0].operation_id === OP
    && sealedBodies[0].approval_id === AP
    && sealedBodies[0].conversation_id === V
    && sealedBodies[0].message_text === BODY
    && sealedBodies[0].endpoint_id === E
    && sealedBodies[0].provider_mailbox_id === MAIL
    && sealedBodies[0].actor_staff_user_id === A
    && !('immutable_draft_id' in sealedBodies[0]));

  // Replay concurrent: second recovery also allowed (reconcile-only path)
  send.calls.length = 0; dispatchHits = 0;
  await Promise.all([
    routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate),
    routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate),
  ]);
  ok('concurrent duplicate recovery both invoke dispatch once each (zero second send is owner duty)',
    send.calls.length === 2 && dispatchHits === 2
    && send.calls.every((c) => c.status === 200 && c.body.success === true));

  // Already reconciled_sent → committed without requiring journal mutation; may skip dispatch
  pg.setJournal('reconciled_sent', 'committed', { createC: 1, updateC: 1, sendC: 1 });
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('reconciled_sent → 200 committed (no second send path)',
    send.calls[0].status === 200 && send.calls[0].body.success === true
    && send.calls[0].body.status === 'committed' && noLeak(send.calls[0].body));

  // create_dispatched frozen — no dispatch
  pg.setJournal('create_dispatched', 'outcome_unknown', { createC: 1, updateC: 0, sendC: 0 });
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('create_dispatched frozen → recovery status zero dispatch',
    send.calls[0].status === 503
    && send.calls[0].body.success === false
    && send.calls[0].body.error === 'email_send_recovery'
    && dispatchHits === 0
    && noLeak(send.calls[0].body));

  // update_dispatched frozen
  pg.setJournal('update_dispatched', 'outcome_unknown', { createC: 1, updateC: 1, sendC: 0 });
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('update_dispatched frozen → recovery status zero dispatch',
    send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_recovery'
    && dispatchHits === 0);

  // draft_created / claimed not eligible
  pg.setJournal('draft_created', 'not_committed', { createC: 1, updateC: 0, sendC: 0 });
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('draft_created not eligible → no dispatch',
    send.calls[0].status === 503 && dispatchHits === 0 && noLeak(send.calls[0].body));

  // Wrong conversation / approval
  pg.setJournal('send_dispatched', 'outcome_unknown', { createC: 1, updateC: 1, sendC: 1 });
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(
    mockReq({ conversation_id: '99999999-9999-4999-8999-999999999999', approval_id: AP }),
    {}, user(), gate,
  );
  ok('wrong conversation → 404 zero dispatch',
    send.calls[0].status === 404 && dispatchHits === 0 && noLeak(send.calls[0].body));

  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(
    mockReq({ conversation_id: V, approval_id: '99999999-9999-4999-8999-999999999999' }),
    {}, user(), gate,
  );
  ok('wrong approval → 404 zero dispatch',
    send.calls[0].status === 404 && dispatchHits === 0);

  // Foreign tenant / missing authority
  pg.setForeign(true);
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('foreign tenant → 404 zero dispatch', send.calls[0].status === 404 && dispatchHits === 0);
  pg.setForeign(false);

  // Endpoint kill switch
  pg.setEndpointOutbound(false);
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('endpoint outbound false → 503 disabled zero dispatch',
    send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_disabled'
    && dispatchHits === 0);
  pg.setEndpointOutbound(true);

  // Send/composition flags off after approval exists
  const gateNoSend = mod.snapshotGateEnv(enabledEnv({ EMAIL_OUTBOUND_SEND_ENABLED: 'false' }));
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gateNoSend);
  ok('send flag off → 503 disabled zero construct/dispatch',
    send.calls[0].status === 503
    && send.calls[0].body.error === 'email_send_disabled'
    && dispatchHits === 0);

  // Draft approval not recoverable
  pg.approvals.get(AP).state = 'draft';
  send.calls.length = 0; dispatchHits = 0;
  await routes.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('draft approval not recoverable → 409',
    send.calls[0].status === 409 && dispatchHits === 0 && noLeak(send.calls[0].body));
  pg.approvals.get(AP).state = 'approved';

  // Outcome unknown public mapping
  const routesUnk = mod.createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON,
    withPgClient: pg.withPgClient,
    appendAuditLog() {},
    createOutboundDispatch() {
      return Object.freeze({
        async dispatchApprovedOutbound() {
          dispatchHits += 1;
          return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
        },
      });
    },
    runtimeEnv: enabledEnv(),
  });
  send.calls.length = 0; dispatchHits = 0;
  await routesUnk.handleRecoverSend(mockReq(recoveryDto()), {}, user(), gate);
  ok('outcome_unknown public sanitized 503',
    send.calls[0].status === 503
    && send.calls[0].body.success === false
    && send.calls[0].body.error === 'email_send_outcome_unknown'
    && send.calls[0].body.conversation_id === V
    && send.calls[0].body.approval_id === AP
    && !('operation_id' in send.calls[0].body)
    && !('message_text' in send.calls[0].body)
    && noLeak(send.calls[0].body));

  // Router wiring offline integration
  const routerScript = `'use strict';
const assert=require('node:assert/strict');const http=require('node:http');const path=require('node:path');
const fs=require('node:fs');const Module=require('node:module');
const ROOT=${JSON.stringify(ROOT)};const ORIGIN=${JSON.stringify(ORIGIN)};
const C=${JSON.stringify(C)};const A=${JSON.stringify(A)};const V=${JSON.stringify(V)};const AP=${JSON.stringify(AP)};
const RECOVER='/staff/inbox/email/recover-send';
const STAFF=path.join(ROOT,'scripts/staff-query-api.js');const SESSION='email-recovery-offline-session';
try{require.resolve('dotenv')}catch{const c=['/opt/data/wolfhouse-agent/node_modules',path.join(ROOT,'node_modules')].find(x=>fs.existsSync(path.join(x,'dotenv')));if(c){process.env.NODE_PATH=c+(process.env.NODE_PATH?path.delimiter+process.env.NODE_PATH:'');Module._initPaths()}}
function clear(){for(const k of Object.keys(require.cache)){if(/staff-query-api\\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-inbox-routes/.test(k))delete require.cache[k]}}
function listen(s){return new Promise((r,j)=>{s.listen(0,'127.0.0.1',()=>r(s.address().port));s.on('error',j)})}
function close(s){return new Promise(r=>s.close(()=>r()))}
function request(port,o){return new Promise((resolve,reject)=>{const payload=o.body==null?null:Buffer.from(o.body);const hdrs=Object.assign({},o.headers||{});if(payload)hdrs['content-length']=payload.length;const req=http.request({hostname:'127.0.0.1',port,path:o.path,method:o.method,headers:hdrs},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>{const raw=Buffer.concat(c).toString('utf8');let body=raw;try{body=JSON.parse(raw)}catch{}resolve({status:res.statusCode,body,raw})})});req.on('error',reject);if(payload)req.write(payload);req.end()})}
(async()=>{
process.env.NODE_ENV='test';process.env.STAFF_RUNTIME_PROFILE='test';process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER='1';
process.env.STAFF_AUTH_REQUIRED='true';process.env.STAFF_AUTH_HTTPS='false';process.env.STAFF_QUERY_API_HOST='127.0.0.1';
process.env.STAFF_PORTAL_ORIGIN=ORIGIN;delete process.env.EMAIL_STAFF_OUTBOUND_ENABLED;
clear();const api=require(STAFF);assert.equal(typeof api.createStaffQueryApiHttpServer,'function');
let dbCalls=0;api.setFortress15j3OfflineSeams({withPgClient:async fn=>{dbCalls+=1;return fn({async query(){return{rows:[]}}})},
resolveSessionUser(req){const raw=String((req.headers&&req.headers.cookie)||'');if(raw.includes(SESSION))return{staff_user_id:A,email:null,role:'operator',status:'active',display_name:'Op',client_id:C,client_slug:'sunset',session_id:'s1'};return null},
canAccessClient(u,s){return !!(u&&u.client_slug==='sunset'&&s==='sunset')}});
const server=api.createStaffQueryApiHttpServer();const port=await listen(server);
try{
let r=await request(port,{method:'POST',path:RECOVER,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,approval_id:AP})});
assert.equal(r.status,404);assert.equal(r.body.error,'not_found');assert.equal(dbCalls,0);
process.env.EMAIL_STAFF_OUTBOUND_ENABLED='true';
r=await request(port,{method:'POST',path:RECOVER,headers:{'content-type':'application/json',origin:ORIGIN},body:JSON.stringify({conversation_id:V,approval_id:AP})});
assert.ok(r.status===401||r.status===403);assert.equal(dbCalls,0);
r=await request(port,{method:'POST',path:RECOVER,headers:{'content-type':'application/json',origin:'https://evil.test',cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,approval_id:AP})});
assert.equal(r.status,403);assert.equal(dbCalls,0);
r=await request(port,{method:'POST',path:RECOVER,headers:{'content-type':'text/plain',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,approval_id:AP})});
assert.equal(r.status,415);assert.equal(dbCalls,0);
r=await request(port,{method:'POST',path:RECOVER,headers:{'content-type':'application/json',origin:ORIGIN,cookie:'luna_staff_session='+SESSION},body:JSON.stringify({conversation_id:V,approval_id:AP,message_text:'x'})});
assert.equal(r.status,400);assert.ok(dbCalls===0||r.status===400);
// WhatsApp path remains distinct — recover path must not equal send-reply
assert.notEqual(RECOVER,'/staff/inbox/send-reply');
console.log('recovery_router_ok');
}finally{await close(server);api.setFortress15j3OfflineSeams(null);clear()}
})().catch(e=>{console.error(e);process.exit(1)});`;
  const out = spawnSync(process.execPath, ['-e', routerScript], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '/opt/data/wolfhouse-agent/node_modules' },
  });
  ok('real-router recovery wiring', out.status === 0 && /recovery_router_ok/.test(out.stdout),
    (out.stderr || out.stdout || '').slice(0, 400));

  // Staff UI does not add recovery authority inputs
  const uiHtml = fs.readFileSync(STAFF_ABS, 'utf8');
  ok('UI retains no recovery authority inputs',
    !/id="email-(recipient|sender|mailbox|operation|idempotency|immutable)/.test(uiHtml));
  ok('WhatsApp send-reply containment still present',
    uiHtml.includes('/staff/inbox/send-reply') && uiHtml.includes('function wireInboxSendReply'));

  console.log(`\n── verify:staff-email-outbound-recovery-route ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
