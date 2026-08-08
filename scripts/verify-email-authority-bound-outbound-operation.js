'use strict';
/** Gate 3 authority-bound outbound composition verifier. Production journal + Graph transport; no real DB/network. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Socket } = require('node:net');
const ROOT = path.join(__dirname, '..');
const {
  FAILURE_CODE, EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED, EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN, EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND, EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_CREATE_AFTER_DRAFT,
  DEPENDENCY_KEYS, AUTHORITY_KEYS, INPUT_KEYS, JOURNAL_KEYS, TRANSPORT_KEYS, ACCESS_SESSION_KEYS, RESULT_KEYS,
  createAuthorityBoundOutboundOperation,
} = require('./lib/email-authority-bound-outbound-operation');
const { createEmailOutboundSendJournalStore } = require('./lib/email-outbound-send-journal-store');
const { createMicrosoftGraphReplyDraftTransport } = require('./lib/email-microsoft-graph-reply-draft-transport');
const C = '11111111-1111-4111-8111-111111111111'; const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333'; const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555'; const M = '22222222-2222-4222-8222-2222222222ab';
const K = 'sunset-somo'; const SRC = 'AAMkAGI2-SRC-OUTBOUND-COMPOSITION'; const DRAFT = 'AAMkAGI2-DRAFT-OUTBOUND-COMPOSITION';
const TOKEN = 'atok-NEVER_LEAK-outbound-composition-token'; const PLANTED = 'NEVER_LEAK_body_or_address_or_token';
const BODY = 'Approved staff reply body for Gate3 composition.';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const ADDR = 'planted-leak@evil.example';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return !t.includes(TOKEN) && !t.includes(PLANTED) && !t.includes(BODY) && !t.includes(ADDR)
    && !t.includes('access_token') && !t.includes('refresh_token') && !t.includes('Bearer ');
}
function authority(o = {}) {
  return { clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V,
    actorStaffUserId: A, providerMailboxId: M, sourceMessageId: SRC, ...o };
}
function resultShape(r) {
  const t = (() => { try { return JSON.stringify(r); } catch { return String(r); } })();
  return !!(r && r.ok === true && r.value && Object.isFrozen(r) && Object.isFrozen(r.value)
    && Object.keys(r.value).length === RESULT_KEYS.length
    && RESULT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r.value, k))
    && !Object.prototype.hasOwnProperty.call(r.value, 'immutable_draft_id')
    && !t.includes(DRAFT) && !t.includes('immutable_draft_id') && noLeak(r));
}
function failShape(r) { return !!(r && r.ok === false && typeof r.error === 'string' && Object.isFrozen(r) && noLeak(r)); }
function uid() { return crypto.randomUUID(); }
function inp(opId, apId, text = BODY) { return { operationId: opId, approvalId: apId, messageText: text }; }
function createFakeTxnHarness() {
  const durable = new Map(); let loanSeq = 0; let commitReject = false; const rowLocks = new Map();
  const clone = (r) => ({ ...r });
  const lockState = (op) => { let s = rowLocks.get(op); if (!s) { s = { owner: null, wait: [] }; rowLocks.set(op, s); } return s; };
  const acquire = (op, loanId) => {
    const s = lockState(op);
    if (s.owner == null || s.owner === loanId) { s.owner = loanId; return Promise.resolve(); }
    return new Promise((r) => s.wait.push(r)).then(() => { s.owner = loanId; });
  };
  const releaseLocks = (loanId) => {
    for (const [, s] of rowLocks) {
      if (s.owner !== loanId) continue; s.owner = null; const n = s.wait.shift(); if (n) n();
    }
  };
  const pub = (row) => ({
    operation_id: row.operation_id, approval_id: row.approval_id, phase: row.phase, outcome: row.outcome,
    immutable_draft_id: row.immutable_draft_id, body_digest: row.body_digest,
    create_invocation_count: row.create_invocation_count, update_invocation_count: row.update_invocation_count,
    send_invocation_count: row.send_invocation_count, provider: row.provider,
  });
  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1); let inTx = false; const staged = new Map();
    const visible = (op) => (staged.has(op) ? staged.get(op) : (durable.has(op) ? clone(durable.get(op)) : null));
    const byApproval = (cid, ap) => {
      for (const row of staged.values()) if (row.client_id === cid && row.approval_id === ap) return row;
      for (const row of durable.values()) if (row.client_id === cid && row.approval_id === ap) return clone(row);
      return null;
    };
    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm === 'BEGIN') { if (inTx) throw new Error('nested'); inTx = true; staged.clear(); return { rows: [] }; }
        if (norm === 'COMMIT') {
          if (commitReject && staged.size > 0) throw new Error('planted_commit_reject');
          for (const [k, row] of staged) durable.set(k, clone(row));
          staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] };
        }
        if (norm === 'ROLLBACK') { staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] }; }
        if (/FOR UPDATE/.test(norm) && /operation_id = \$1::uuid/.test(norm)) {
          const op = String(params[0]).toLowerCase(); await acquire(op, loanId);
          const row = visible(op); return { rows: row ? [clone(row)] : [] };
        }
        if (/FOR UPDATE/.test(norm) && /approval_id = \$2::uuid/.test(norm)) {
          const ap = String(params[1]).toLowerCase(); await acquire(`approval:${ap}`, loanId);
          const row = byApproval(String(params[0]).toLowerCase(), ap);
          return { rows: row ? [{ operation_id: row.operation_id }] : [] };
        }
        if (/^INSERT INTO tenant_email_outbound_send_journal/.test(norm)) {
          const op = String(params[0]).toLowerCase(); if (visible(op)) return { rows: [] };
          const ap = String(params[6]).toLowerCase();
          const existingAp = byApproval(String(params[1]).toLowerCase(), ap);
          if (existingAp && existingAp.operation_id !== op) { const err = new Error('dup'); err.code = '23505'; throw err; }
          const row = {
            operation_id: op, client_id: String(params[1]).toLowerCase(), location_id: String(params[2]).toLowerCase(),
            location_key: String(params[3]), endpoint_id: String(params[4]).toLowerCase(),
            conversation_id: String(params[5]).toLowerCase(), approval_id: ap,
            actor_staff_user_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
            immutable_draft_id: null, body_digest: String(params[8]), phase: 'claimed', outcome: 'claimed',
            create_invocation_count: 0, update_invocation_count: 0, send_invocation_count: 0,
            created_at: new Date(), updated_at: new Date(),
          };
          staged.set(op, row); return { rows: [pub(row)] };
        }
        const pm = /UPDATE tenant_email_outbound_send_journal SET phase='([^']+)'/.exec(norm);
        if (pm) {
          const phase = pm[1]; const op = String(params[0]).toLowerCase(); const row = visible(op);
          if (!row) return { rows: [] };
          const cc=row.create_invocation_count,uc=row.update_invocation_count,sc=row.send_invocation_count,id=row.immutable_draft_id;
          if (phase === 'create_dispatched') {
            if (row.phase!=='claimed'||id!=null||cc||uc||sc) return { rows: [] };
            row.phase=phase; row.outcome='outcome_unknown'; row.create_invocation_count=1;
          } else if (phase === 'draft_created') {
            if (row.phase!=='create_dispatched'||id!=null||cc!==1||uc||sc) return { rows: [] };
            row.phase=phase; row.outcome='not_committed'; row.immutable_draft_id=String(params[1]);
          } else if (phase === 'update_dispatched') {
            if (row.phase!=='draft_created'||!id||id!==String(params[1])||cc!==1||uc||sc) return { rows: [] };
            row.phase=phase; row.outcome='outcome_unknown'; row.update_invocation_count=1;
          } else if (phase === 'draft_updated') {
            if (row.phase!=='update_dispatched'||!id||cc!==1||uc!==1||sc) return { rows: [] };
            row.phase=phase; row.outcome='not_committed';
          } else if (phase === 'send_dispatched') {
            if (row.phase!=='draft_updated'||!id||cc!==1||uc!==1||sc) return { rows: [] };
            row.phase=phase; row.outcome='outcome_unknown'; row.send_invocation_count=1;
          } else if (phase === 'reconciled_sent') {
            if (row.phase!=='send_dispatched'||sc!==1||id!==String(params[1])) return { rows: [] };
            row.phase=phase; row.outcome='committed';
          } else if (phase === 'terminal') {
            if (row.phase!==String(params[2])||Number(cc)!==Number(params[3])||Number(uc)!==Number(params[4])||Number(sc)!==Number(params[5])) return { rows: [] };
            row.phase=phase; row.outcome=String(params[1]);
          } else return { rows: [] };
          staged.set(op, row); return { rows: [pub(row)] };
        }
        throw new Error(`unexpected_sql:${norm.slice(0, 60)}`);
      },
    };
    try { return await work(client); } finally { releaseLocks(loanId); }
  }
  return { withTransactionClient, durable, setCommitReject(v) { commitReject = v; } };
}
function makeJournal(h) {
  return createEmailOutboundSendJournalStore({ withTransactionClient: h.withTransactionClient,
    authority: { clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V, actorStaffUserId: A } });
}
function makeAccessFactory(opts = {}) {
  let sessions = 0;
  return {
    sessions: () => sessions,
    createAccessSession: () => {
      sessions += 1; let used = false;
      return Object.freeze({
        async runWithAccessTokenOnce(input, consumer) {
          if (used) throw new Error('session reused'); used = true;
          if (!input || input.clientId !== C || input.endpointId !== E) {
            return Object.freeze({ ok: false, status: 'unavailable', grant_generation: null });
          }
          if (opts.status) return Object.freeze({ ok: false, status: opts.status, grant_generation: 1 });
          if (opts.throwSecret) throw new Error(PLANTED + '_access_session');
          const loan = { accessToken: TOKEN };
          try { return Object.freeze({ ok: true, grant_generation: 2, value: await consumer(loan) }); }
          finally { try { loan.accessToken = null; } catch { /* */ } }
        },
      });
    },
  };
}
function countingTransport(c, opts = {}) {
  c.create=0; c.update=0; c.send=0; c.reconcile=0; c.bodies=[];
  const scrub=(i)=>{ try{i.accessToken=null;}catch{} };
  return Object.freeze({
    async createReply(input) {
      c.create+=1; scrub(input);
      if (opts.failCreate||opts.createAcceptThenLoss) {
        const e=new Error(PLANTED+(opts.createAcceptThenLoss?'_create_loss':'_create'));
        if (opts.failCreate) e.code='microsoft_graph_reply_draft_failed'; throw e;
      }
      return Object.freeze({ outcome:'draft_created', immutable_draft_id:DRAFT, isDraft:true });
    },
    async updateApprovedDraft(input) {
      c.update+=1; c.bodies.push(input&&input.body_content); try{input.accessToken=null;input.body_content=null;}catch{}
      if (opts.failUpdate||opts.updateAcceptThenLoss) {
        const e=new Error(PLANTED+(opts.updateAcceptThenLoss?'_update_loss':'_update'));
        if (opts.failUpdate) e.code='microsoft_graph_reply_draft_failed'; throw e;
      }
      return Object.freeze({ outcome:'draft_updated', immutable_draft_id:DRAFT });
    },
    async sendDraft(input) {
      c.send+=1; scrub(input); if (opts.sendAcceptThenLoss) throw new Error(PLANTED+'_send_loss');
      return Object.freeze({ outcome:'send_accepted', immutable_draft_id:DRAFT, delivery_claimed:false, http_status:202, requires_reconcile:true });
    },
    async reconcileDraft(input) {
      c.reconcile+=1; scrub(input);
      if (opts.stillDraft) return Object.freeze({ outcome:'outcome_unknown', immutable_draft_id:DRAFT, isDraft:true, authorize_automatic_resend:false, authorize_automatic_create_reply:false });
      if (opts.reconThrow) throw new Error(PLANTED+'_recon');
      return Object.freeze({ outcome:'sent', immutable_draft_id:DRAFT, isDraft:false, authorize_automatic_resend:false });
    },
  });
}
function compose(h, counters, tOpts = {}, aOpts = {}) {
  const access = makeAccessFactory(aOpts);
  return { op: createAuthorityBoundOutboundOperation({ journalStore: makeJournal(h), createAccessSession: access.createAccessSession,
    replyDraftTransport: countingTransport(counters, tOpts), authority: authority() }), access, h };
}
function im(status, body, headers) {
  const res = new http.IncomingMessage(new Socket());
  res.statusCode = status; res.headers = headers || { 'content-type': 'application/json' };
  queueMicrotask(() => {
    if (body != null) res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    res.emit('end');
  });
  return res;
}
function fakeHttps(seq) {
  let i = 0; const calls = [];
  const httpsImpl = (opts, cb) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => {
      calls.push({ method: opts.method, path: opts.path });
      const step = seq[i] !== undefined ? seq[i] : seq[seq.length - 1]; i += 1;
      queueMicrotask(() => {
        if (step && step.loss) { req.emit('error', new Error(PLANTED + '_https_loss')); return; }
        if (typeof step === 'function') cb(step(opts));
        else if (!(step && step.deadline)) cb(im(202, null, {}));
      });
    };
    return req;
  };
  return { httpsImpl, calls: () => calls, count: (re) => calls.filter((c) => re.test(c.path)).length };
}
function mkOp(h, transport, aOpts) {
  return createAuthorityBoundOutboundOperation({ journalStore: makeJournal(h),
    createAccessSession: makeAccessFactory(aOpts || {}).createAccessSession, replyDraftTransport: transport, authority: authority() });
}
function jVal(phase, outcome, draft, counts, auth, err, ids) {
  if (err) return Object.freeze({ ok: false, error: err });
  const [cc, uc, sc] = counts; const id = ids || {};
  return Object.freeze({ ok: true, value: Object.freeze({
    operation_id: id.op || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    approval_id: id.ap || 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    phase, outcome, immutable_draft_id: draft,
    body_digest: id.digest || DIGEST, provider: id.provider || 'microsoft_graph',
    create_invocation_count: cc, update_invocation_count: uc, send_invocation_count: sc,
    replayed: id.replayed === true, authorize_create: auth[0], authorize_update: auth[1], authorize_dispatch: auth[2],
  }) });
}
function hostileJournal(overrides) {
  const z = [false, false, false]; const base = {
    claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z),
    load: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z),
    claimCreate: async () => jVal('create_dispatched', 'outcome_unknown', null, [1, 0, 0], [true, false, false]),
    persistDraftCreated: async () => jVal('draft_created', 'not_committed', DRAFT, [1, 0, 0], z),
    claimUpdate: async () => jVal('update_dispatched', 'outcome_unknown', DRAFT, [1, 1, 0], [false, true, false]),
    markDraftUpdated: async () => jVal('draft_updated', 'not_committed', DRAFT, [1, 1, 0], z),
    claimDispatch: async () => jVal('send_dispatched', 'outcome_unknown', DRAFT, [1, 1, 1], [false, false, true]),
    reconcileSent: async () => jVal('reconciled_sent', 'committed', DRAFT, [1, 1, 1], z),
    markTerminal: async () => jVal('terminal', 'rejected', null, [0, 0, 0], z),
  };
  return Object.freeze({ ...base, ...overrides });
}
async function advanceToDraftUpdated(j, op, ap) {
  await j.claim({ operationId: op, approvalId: ap, bodyDigest: DIGEST });
  await j.claimCreate({ operationId: op }); await j.persistDraftCreated({ operationId: op, immutableDraftId: DRAFT });
  await j.claimUpdate({ operationId: op, immutableDraftId: DRAFT }); await j.markDraftUpdated({ operationId: op });
}
async function runHostile(overrides) {
  return createAuthorityBoundOutboundOperation({
    journalStore: hostileJournal(overrides), createAccessSession: makeAccessFactory().createAccessSession,
    replyDraftTransport: countingTransport({}), authority: authority(),
  }).runAuthorityBoundOutbound(inp(uid(), uid()));
}
async function main() {
  console.log('verify:email-authority-bound-outbound-operation — Gate 3 composition (provider intents)\n');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-authority-bound-outbound-operation.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const staff = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  ok('static default-off + keys',
    EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED === false && EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN === true && EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND === false && EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_CREATE_AFTER_DRAFT === false
    && DEPENDENCY_KEYS.join(',') === 'journalStore,createAccessSession,replyDraftTransport,authority'
    && AUTHORITY_KEYS.includes('providerMailboxId') && INPUT_KEYS.join(',') === 'operationId,approvalId,messageText'
    && JOURNAL_KEYS.includes('claimCreate') && JOURNAL_KEYS.includes('claimUpdate') && JOURNAL_KEYS.includes('claimDispatch')
    && TRANSPORT_KEYS.includes('sendDraft') && ACCESS_SESSION_KEYS.join(',') === 'runWithAccessTokenOnce'
    && RESULT_KEYS.includes('create_invocation_count') && RESULT_KEYS.includes('update_invocation_count')
    && !RESULT_KEYS.includes('immutable_draft_id') && RESULT_KEYS.includes('status'));
  ok('unwired / pin / no leak surface', !/console\.(log|info|debug|warn|error)/.test(src) && !/require\(['"]https['"]\)/.test(src)
    && !/require\(['"]pg['"]\)/.test(src) && !staff.includes('email-authority-bound-outbound-operation')
    && !!pkg.scripts['verify:email-authority-bound-outbound-operation']
    && /claimCreate/.test(src) && /claimUpdate/.test(src) && /authorize_create/.test(src) && /authorize_update/.test(src)
    && /PINNED_HASH_UPDATE/.test(src) && /JOURNAL_ERR/.test(src) && /create_dispatched/.test(src) && /update_dispatched/.test(src)
    && /phaseCouplingOk/.test(src) && /authCouplingOk/.test(src) && /function toPublic\(/.test(src)
    && /expectedDraftId/.test(src) && !/function toPublic\([^)]*\)\s*\{[^}]*immutable_draft_id/.test(src));
  const hashProto = crypto.Hash && crypto.Hash.prototype ? crypto.Hash.prototype : Object.getPrototypeOf(crypto.createHash('sha256'));
  const origU = hashProto.update; const origD = hashProto.digest; let capturedBody = null;
  hashProto.update = function (data, enc) { capturedBody = typeof data === 'string' ? data : String(data); return origU.call(this, data, enc); };
  hashProto.digest = function () { return '0'.repeat(64); };
  let hashOk = false;
  try {
    const rH = await compose(createFakeTxnHarness(), {}).op.runAuthorityBoundOutbound(inp(uid(), uid()));
    hashOk = resultShape(rH) && rH.value.body_digest === DIGEST && capturedBody === null && rH.value.status === 'committed';
  } finally { hashProto.update = origU; hashProto.digest = origD; }
  ok('hash pin survives Hash.prototype monkeypatch', hashOk);
  const idleJ = makeJournal(createFakeTxnHarness()); let accessCalls = 0;
  const idleA = () => { accessCalls += 1; return Object.freeze({ runWithAccessTokenOnce: async () => Object.freeze({ ok: true, grant_generation: 1, value: null }) }); };
  const idleT = Object.freeze({
    createReply: async () => { throw new Error('x'); }, updateApprovedDraft: async () => { throw new Error('x'); },
    sendDraft: async () => { throw new Error('x'); }, reconcileDraft: async () => { throw new Error('x'); },
  });
  let authRejects = 0;
  for (const auth of [
    authority({ clientId: 'bad' }),
    (() => { const acc = {}; for (const k of AUTHORITY_KEYS) Object.defineProperty(acc, k, { get() { return authority()[k]; }, enumerable: true }); return acc; })(),
    Object.assign(Object.create({ clientId: C }), authority()),
  ]) {
    try { createAuthorityBoundOutboundOperation({ journalStore: idleJ, createAccessSession: idleA, replyDraftTransport: idleT, authority: auth }); }
    catch (e) { if (e.code === FAILURE_CODE) authRejects += 1; }
  }
  ok('hostile/accessor/inherited authority rejected', authRejects === 3 && accessCalls === 0);
  const h0 = createFakeTxnHarness(); const b0 = compose(h0, {}); const before = b0.access.sessions();
  const accIn = {}; Object.defineProperty(accIn, 'operationId', { get() { return uid(); }, enumerable: true });
  Object.defineProperty(accIn, 'approvalId', { value: uid(), enumerable: true });
  Object.defineProperty(accIn, 'messageText', { value: BODY, enumerable: true });
  ok('accessor/alias input rejected pre-token', failShape(await b0.op.runAuthorityBoundOutbound(accIn))
    && failShape(await b0.op.runAuthorityBoundOutbound({ operationId: uid(), approvalId: uid(), messageText: BODY, recipient: 'evil@x.com' }))
    && failShape(await b0.op.runAuthorityBoundOutbound({
      operationId: uid(), approvalId: uid(), messageText: BODY, provider: 'microsoft_graph', mailbox: M, accessToken: TOKEN, threadId: SRC, idempotencyKey: 'x',
    })) && failShape(await b0.op.runAuthorityBoundOutbound(new Proxy({ operationId: uid(), approvalId: uid(), messageText: BODY }, {})))
    && b0.access.sessions() === before);
  const h1 = createFakeTxnHarness(); const c1 = {}; const op1 = uid(); const ap1 = uid();
  const happy = await compose(h1, c1).op.runAuthorityBoundOutbound(inp(op1, ap1));
  ok('happy path committed once', resultShape(happy) && happy.value.status === 'committed'
    && happy.value.phase === 'reconciled_sent' && happy.value.send_invocation_count === 1
    && happy.value.create_invocation_count === 1 && happy.value.update_invocation_count === 1
    && happy.value.body_digest === DIGEST && !('immutable_draft_id' in happy.value)
    && c1.create === 1 && c1.update === 1 && c1.send === 1 && c1.reconcile === 1 && c1.bodies[0] === BODY
    && h1.durable.get(op1).immutable_draft_id === DRAFT);
  const row1 = h1.durable.get(op1);
  ok('journal digest only + intent counts', row1 && row1.body_digest === DIGEST && row1.create_invocation_count === 1
    && row1.update_invocation_count === 1 && !JSON.stringify(row1).includes(BODY) && !JSON.stringify(row1).includes(TOKEN));
  const c1b = {}; const rep = await mkOp(h1, countingTransport(c1b)).runAuthorityBoundOutbound(inp(op1, ap1));
  ok('committed replay no network', resultShape(rep) && rep.value.status === 'committed' && rep.value.replayed
    && c1b.create === 0 && c1b.update === 0 && c1b.send === 0 && c1b.reconcile === 0);
  const hCc = createFakeTxnHarness(); const jCc = makeJournal(hCc); const opCc = uid(); const apCc = uid();
  await jCc.claim({ operationId: opCc, approvalId: apCc, bodyDigest: DIGEST });
  hCc.setCommitReject(true);
  const cCc = {}; const rCc = await mkOp(hCc, countingTransport(cCc)).runAuthorityBoundOutbound(inp(opCc, apCc));
  hCc.setCommitReject(false);
  ok('claimCreate COMMIT unknown → zero create', resultShape(rCc) && rCc.value.status === 'outcome_unknown'
    && rCc.value.phase === 'claimed' && cCc.create === 0 && cCc.update === 0 && cCc.send === 0
    && (!hCc.durable.get(opCc) || hCc.durable.get(opCc).create_invocation_count === 0) && noLeak(rCc));
  const hCd = createFakeTxnHarness(); const jCd = makeJournal(hCd); const opCd = uid(); const apCd = uid();
  await jCd.claim({ operationId: opCd, approvalId: apCd, bodyDigest: DIGEST });
  const crAuth = await jCd.claimCreate({ operationId: opCd });
  const cCd = {}; const rCd = await mkOp(hCd, countingTransport(cCd)).runAuthorityBoundOutbound(inp(opCd, apCd));
  ok('create_dispatched replay zero create', resultShape(rCd) && rCd.value.status === 'outcome_unknown'
    && rCd.value.phase === 'create_dispatched' && rCd.value.create_invocation_count === 1
    && crAuth.value.authorize_create === true && cCd.create === 0 && cCd.update === 0 && cCd.send === 0 && noLeak(rCd));
  const hCr = createFakeTxnHarness(); const cCr = {}; const opCr = uid(); const apCr = uid();
  const fCreate = await compose(hCr, cCr, { createAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(opCr, apCr));
  const cCr2 = {}; const fCreate2 = await compose(hCr, cCr2, { createAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(opCr, apCr));
  ok('create accept/loss + replay zero create', resultShape(fCreate) && fCreate.value.phase === 'create_dispatched'
    && fCreate.value.create_invocation_count === 1 && cCr.create === 1 && cCr.send === 0 && noLeak(fCreate)
    && resultShape(fCreate2) && fCreate2.value.phase === 'create_dispatched' && cCr2.create === 0 && cCr2.update === 0 && cCr2.send === 0);
  const hUc = createFakeTxnHarness(); const jUc = makeJournal(hUc); const opUc = uid(); const apUc = uid();
  await jUc.claim({ operationId: opUc, approvalId: apUc, bodyDigest: DIGEST });
  await jUc.claimCreate({ operationId: opUc });
  await jUc.persistDraftCreated({ operationId: opUc, immutableDraftId: DRAFT });
  hUc.setCommitReject(true);
  const cUc = {}; const rUc = await mkOp(hUc, countingTransport(cUc)).runAuthorityBoundOutbound(inp(opUc, apUc));
  hUc.setCommitReject(false);
  ok('claimUpdate COMMIT unknown → zero PATCH', resultShape(rUc) && rUc.value.status === 'outcome_unknown'
    && rUc.value.phase === 'draft_created' && cUc.create === 0 && cUc.update === 0 && cUc.send === 0
    && Number(hUc.durable.get(opUc).update_invocation_count) === 0 && noLeak(rUc));
  const hUd = createFakeTxnHarness(); const jUd = makeJournal(hUd); const opUd = uid(); const apUd = uid();
  await jUd.claim({ operationId: opUd, approvalId: apUd, bodyDigest: DIGEST });
  await jUd.claimCreate({ operationId: opUd });
  await jUd.persistDraftCreated({ operationId: opUd, immutableDraftId: DRAFT });
  const upAuth = await jUd.claimUpdate({ operationId: opUd, immutableDraftId: DRAFT });
  const cUd = {}; const rUd = await mkOp(hUd, countingTransport(cUd)).runAuthorityBoundOutbound(inp(opUd, apUd));
  ok('update_dispatched replay zero PATCH', resultShape(rUd) && rUd.value.status === 'outcome_unknown'
    && rUd.value.phase === 'update_dispatched' && rUd.value.update_invocation_count === 1
    && upAuth.value.authorize_update === true && cUd.create === 0 && cUd.update === 0 && cUd.send === 0 && noLeak(rUd));
  const h5 = createFakeTxnHarness(); const c5 = {}; const opD = uid(); const apD = uid();
  const mid = await compose(h5, c5, { updateAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(opD, apD));
  const c5b = {}; const mid2 = await compose(h5, c5b, { updateAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(opD, apD));
  ok('update accept/loss + replay zero PATCH', resultShape(mid) && mid.value.phase === 'update_dispatched'
    && h5.durable.get(opD).immutable_draft_id === DRAFT && c5.create === 1 && c5.update === 1 && c5.send === 0 && noLeak(mid)
    && resultShape(mid2) && mid2.value.phase === 'update_dispatched' && c5b.create === 0 && c5b.update === 0 && c5b.send === 0);
  const hSend = createFakeTxnHarness(); const cSend = {}; const opS = uid(); const apS = uid();
  const lostSend = await compose(hSend, cSend, { sendAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(opS, apS));
  const cSendR = {}; const recoverSend = await mkOp(hSend, countingTransport(cSendR)).runAuthorityBoundOutbound(inp(opS, apS));
  ok('send accept/loss then reconcile once', resultShape(lostSend) && lostSend.value.phase === 'send_dispatched'
    && lostSend.value.send_invocation_count === 1 && cSend.send === 1 && cSend.reconcile === 0 && noLeak(lostSend)
    && resultShape(recoverSend) && recoverSend.value.status === 'committed'
    && cSendR.create === 0 && cSendR.update === 0 && cSendR.send === 0 && cSendR.reconcile === 1 && cSend.send === 1);
  const h2b = createFakeTxnHarness(); const c2a = {}; const opU = uid(); const apU = uid();
  const lost2 = await compose(h2b, c2a, { reconThrow: true }).op.runAuthorityBoundOutbound(inp(opU, apU));
  const c2r = {}; const recovered = await mkOp(h2b, countingTransport(c2r)).runAuthorityBoundOutbound(inp(opU, apU));
  ok('recon uncertainty + replay zero second send', resultShape(lost2) && lost2.value.phase === 'send_dispatched'
    && c2a.send === 1 && c2a.reconcile === 1 && resultShape(recovered) && recovered.value.status === 'committed'
    && c2r.create === 0 && c2r.update === 0 && c2r.send === 0 && c2r.reconcile === 1);
  const h3 = createFakeTxnHarness(); const j3 = makeJournal(h3); const op3 = uid(); const ap3 = uid();
  await advanceToDraftUpdated(j3, op3, ap3);
  const d3 = await j3.claimDispatch({ operationId: op3 });
  const still = await mkOp(h3, countingTransport({}, { stillDraft: true })).runAuthorityBoundOutbound(inp(op3, ap3));
  ok('still-draft outcome_unknown + dispatch sealed', resultShape(still) && still.value.phase === 'send_dispatched'
    && d3.value.authorize_dispatch === true && (await j3.claimDispatch({ operationId: op3 })).value.authorize_dispatch === false);
  const hDc = createFakeTxnHarness(); const jDc = makeJournal(hDc); const opDc = uid(); const apDc = uid();
  await advanceToDraftUpdated(jDc, opDc, apDc); hDc.setCommitReject(true);
  const cDc = {}; const rDc = await mkOp(hDc, countingTransport(cDc)).runAuthorityBoundOutbound(inp(opDc, apDc));
  hDc.setCommitReject(false);
  ok('claimDispatch COMMIT unknown → zero Graph send', resultShape(rDc) && rDc.value.status === 'outcome_unknown'
    && rDc.value.phase === 'draft_updated' && cDc.create === 0 && cDc.update === 0 && cDc.send === 0 && cDc.reconcile === 0
    && Number(hDc.durable.get(opDc).send_invocation_count) === 0 && noLeak(rDc));
  const reauth = await compose(createFakeTxnHarness(), {}, {}, { status: 'reauthorization_required' }).op.runAuthorityBoundOutbound(inp(uid(), uid()));
  ok('access reauth bounded', resultShape(reauth) && reauth.value.status === 'reauthorization_required'
    && reauth.value.phase === 'create_dispatched');
  const plantClaim = await runHostile({ claim: async () => jVal(PLANTED + '_phase', 'claimed', null, [0, 0, 0], [false, false, false]) });
  const plantOut = await runHostile({ claim: async () => jVal('claimed', PLANTED + '_outcome', null, [0, 0, 0], [false, false, false]) });
  const plantDraft = await runHostile({ claim: async () => jVal('draft_created', 'not_committed', ADDR, [1, 0, 0], [false, false, false]) });
  const plantErr = await runHostile({
    claim: async () => jVal(null, null, null, null, null, PLANTED + '_journal_error'),
    load: async () => jVal(null, null, null, null, null, PLANTED + '_load'),
    claimCreate: async () => jVal(null, null, null, null, null, PLANTED + '_mut'),
  });
  const plantMut = await runHostile({
    claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], [false, false, false]),
    claimCreate: async () => jVal(PLANTED + '_create_phase', 'outcome_unknown', null, [1, 0, 0], [true, false, false]),
  });
  ok('hostile journal secrets → bounded fail, no planted bytes',
    [plantClaim, plantOut, plantDraft, plantErr, plantMut].every((r) => failShape(r) && r.error === FAILURE_CODE && noLeak(r)));
  const z = [false, false, false]; const badDig = 'a'.repeat(64); const wrongDraft = 'AAMkAGI2-WRONG-DRAFT-HOSTILE';
  async function plantBound(mk) {
    const op = uid(); const ap = uid(); const c = {};
    const r = await createAuthorityBoundOutboundOperation({
      journalStore: hostileJournal(mk(op, ap)), createAccessSession: makeAccessFactory().createAccessSession,
      replyDraftTransport: countingTransport(c), authority: authority(),
    }).runAuthorityBoundOutbound(inp(op, ap));
    return { r, c };
  }
  const plants = await Promise.all([
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z, null, { op: uid(), ap }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z, null, { op, ap: uid() }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z, null, { op, ap, digest: badDig }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z, null, { op, ap, provider: 'smtp' }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('draft_created', 'not_committed', DRAFT, [1, 0, 0], z, null, { op, ap }),
      claimUpdate: async () => jVal('update_dispatched', 'outcome_unknown', wrongDraft, [1, 1, 0], [false, true, false], null, { op, ap }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('terminal', 'rejected', null, [0, 0, 0], [true, true, true], null, { op, ap }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], z, null, { op, ap }),
      claimCreate: async () => jVal('create_dispatched', 'outcome_unknown', null, [1, 0, 0], [true, true, false], null, { op, ap }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('claimed', 'claimed', null, [0, 0, 0], [true, false, false], null, { op, ap }) })),
    plantBound((op, ap) => ({ claim: async () => jVal('create_dispatched', 'outcome_unknown', null, [1, 0, 0], [true, false, false], null, { op, ap, replayed: true }) })),
  ]);
  ok('hostile exact-shape binding: op/ap/digest/provider/draft/auth → frozen fail, zero Graph',
    plants.every(({ r, c }) => failShape(r) && r.error === FAILURE_CODE && noLeak(r)
      && (c.create || 0) === 0 && (c.update || 0) === 0 && (c.send || 0) === 0 && (c.reconcile || 0) === 0));
  const aSecret = await compose(createFakeTxnHarness(), {}, {}, { throwSecret: true }).op.runAuthorityBoundOutbound(inp(uid(), uid()));
  const tSecret = await compose(createFakeTxnHarness(), {}, { createAcceptThenLoss: true }).op.runAuthorityBoundOutbound(inp(uid(), uid()));
  ok('planted secrets sanitized (access/transport)', failShape(aSecret) && aSecret.error === FAILURE_CODE
    && resultShape(tSecret) && tSecret.value.phase === 'create_dispatched' && noLeak(aSecret) && noLeak(tSecret));
  const h9 = createFakeTxnHarness(); const j9 = makeJournal(h9); const op9 = uid(); const ap9 = uid();
  await advanceToDraftUpdated(j9, op9, ap9); let sends = 0;
  const sendT = Object.freeze({
    async createReply() { throw new Error('n'); }, async updateApprovedDraft() { throw new Error('n'); },
    async sendDraft(input) { sends += 1; try { input.accessToken = null; } catch {}
      return Object.freeze({ outcome: 'send_accepted', immutable_draft_id: DRAFT, delivery_claimed: false, http_status: 202, requires_reconcile: true }); },
    async reconcileDraft(input) { try { input.accessToken = null; } catch {}
      return Object.freeze({ outcome: 'sent', immutable_draft_id: DRAFT, isDraft: false, authorize_automatic_resend: false }); },
  });
  const r9a = await mkOp(h9, sendT).runAuthorityBoundOutbound(inp(op9, ap9));
  const r9b = await mkOp(h9, sendT).runAuthorityBoundOutbound(inp(op9, ap9));
  ok('send ≤1 across draft_updated runs', resultShape(r9a) && resultShape(r9b) && r9a.value.status === 'committed' && r9b.value.status === 'committed' && sends === 1);
  const fake = fakeHttps([
    () => im(201, { id: DRAFT, isDraft: true }), () => im(200, { id: DRAFT }),
    () => im(202, null, {}), () => im(200, { id: DRAFT, isDraft: false }),
  ]);
  const hProd = createFakeTxnHarness(); const opP = uid(); const apP = uid();
  const prodR = await mkOp(hProd, createMicrosoftGraphReplyDraftTransport({ httpsImpl: fake.httpsImpl })).runAuthorityBoundOutbound(inp(opP, apP));
  ok('production transport create/update/send/reconcile fake HTTPS', resultShape(prodR) && prodR.value.status === 'committed'
    && hProd.durable.get(opP).immutable_draft_id === DRAFT && fake.calls().length === 4
    && fake.calls()[0].method === 'POST' && /createReply/.test(fake.calls()[0].path)
    && fake.calls()[2].method === 'POST' && /\/send$/.test(fake.calls()[2].path) && noLeak(prodR));
  const fakeLoss = fakeHttps([() => im(201, { id: DRAFT, isDraft: true }), () => im(200, { id: DRAFT }), { loss: true }]);
  const hPl = createFakeTxnHarness(); const opPl = uid(); const apPl = uid();
  const lostProd = await mkOp(hPl, createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeLoss.httpsImpl })).runAuthorityBoundOutbound(inp(opPl, apPl));
  const rowPl = hPl.durable.get(opPl);
  const fakeRecon = fakeHttps([() => im(200, { id: DRAFT, isDraft: false })]);
  const recProd = await mkOp(hPl, createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeRecon.httpsImpl })).runAuthorityBoundOutbound(inp(opPl, apPl));
  const hSd = createFakeTxnHarness(); const jSd = makeJournal(hSd); const opSd = uid(); const apSd = uid();
  await advanceToDraftUpdated(jSd, opSd, apSd); await jSd.claimDispatch({ operationId: opSd });
  const stillProd = await mkOp(hSd, createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeHttps([() => im(200, { id: DRAFT, isDraft: true })]).httpsImpl }))
    .runAuthorityBoundOutbound(inp(opSd, apSd));
  ok('prod journal+Graph send-loss: one send, reconcile same draft, isDraft=false only',
    resultShape(lostProd) && lostProd.value.phase === 'send_dispatched' && lostProd.value.status === 'outcome_unknown'
    && rowPl && rowPl.phase === 'send_dispatched' && rowPl.immutable_draft_id === DRAFT && rowPl.send_invocation_count === 1
    && fakeLoss.count(/createReply/) === 1 && fakeLoss.count(/\/send$/) === 1
    && resultShape(recProd) && recProd.value.status === 'committed' && recProd.value.phase === 'reconciled_sent'
    && hPl.durable.get(opPl).immutable_draft_id === DRAFT && hPl.durable.get(opPl).phase === 'reconciled_sent'
    && fakeRecon.calls().length === 1 && fakeRecon.calls()[0].method === 'GET' && /messages\//.test(fakeRecon.calls()[0].path)
    && fakeRecon.count(/\/send$/) === 0 && fakeRecon.count(/createReply/) === 0
    && resultShape(stillProd) && stillProd.value.phase === 'send_dispatched' && stillProd.value.status === 'outcome_unknown'
    && hSd.durable.get(opSd).phase === 'send_dispatched' && noLeak(lostProd) && noLeak(recProd) && noLeak(stillProd));
  let edge404Ok=false, deadlineOk=false;
  try { await createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeHttps([() => im(404, { error: PLANTED })]).httpsImpl })
    .reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT }); }
  catch (e) { edge404Ok = e && e.code === 'microsoft_graph_reply_draft_failed' && noLeak(e); }
  const stillOut = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeHttps([() => im(200, { id: DRAFT, isDraft: true })]).httpsImpl })
    .reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT });
  const s202 = await createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeHttps([() => im(202, null, {})]).httpsImpl })
    .sendDraft({ accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT });
  try { await createMicrosoftGraphReplyDraftTransport({ httpsImpl: fakeHttps([{ deadline: true }]).httpsImpl,
    timers: { setTimeout: (cb) => { queueMicrotask(cb); return 1; }, clearTimeout: () => {} },
  }).createReply({ accessToken: TOKEN, provider_mailbox_id: M, source_message_id: SRC }); }
  catch (e) { deadlineOk = e && e.code === 'microsoft_graph_reply_draft_failed' && noLeak(e); }
  ok('production transport 404/still-draft/202/deadline', edge404Ok && deadlineOk && stillOut.outcome === 'outcome_unknown'
    && stillOut.isDraft === true && s202.outcome === 'send_accepted' && s202.http_status === 202
    && s202.delivery_claimed === false && s202.requires_reconcile === true && noLeak(stillOut) && noLeak(s202));
  const b10 = compose(createFakeTxnHarness(), {});
  ok('messageText bounds + no leaks', failShape(await b10.op.runAuthorityBoundOutbound(inp(uid(), uid(), '')))
    && failShape(await b10.op.runAuthorityBoundOutbound(inp(uid(), uid(), 'x'.repeat(64001))))
    && noLeak(happy) && noLeak(recovered) && noLeak(lost2) && noLeak(still) && noLeak(lostSend));
  console.log(`\n── verify:email-authority-bound-outbound-operation ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
