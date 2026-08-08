'use strict'; /** Offline RED→GREEN: outbound send-journal store (068). Fake + PGlite + optional stock-PG. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const UP_068 = fs.readFileSync(path.join(ROOT, 'database/migrations/068_tenant_email_outbound_send_journal.sql'), 'utf8');
const {
  FAILURE_CODE, EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED, EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN,
  EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER, STORE_DEPENDENCY_KEYS, AUTHORITY_KEYS, OPERATION_RESULT_KEYS,
  createEmailOutboundSendJournalStore,
} = require('./lib/email-outbound-send-journal-store');
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const K = 'sunset-somo';
const DIGEST = crypto.createHash('sha256').update('approved-body', 'utf8').digest('hex');
const DRAFT = 'AAMkAGI2-OUTBOUND-STORE-DRAFT-001';
const PLANTED = 'NEVER_LEAK_body_token_address';
const TOKEN = 'atok-NEVER_LEAK-outbound-journal-store';
const STOCK_PG_ENV = 'EMAIL_OUTBOUND_SEND_JOURNAL_PG_POOL_URL';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return !t.includes(TOKEN) && !t.includes(PLANTED) && !t.includes('access_token') && !t.includes('refresh_token');
}
function authority(o = {}) {
  return { clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V, actorStaffUserId: A, ...o };
}
function resultShape(r) {
  return !!(r && r.ok === true && r.value && Object.isFrozen(r.value)
    && Object.keys(r.value).length === OPERATION_RESULT_KEYS.length
    && OPERATION_RESULT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r.value, k)) && noLeak(r.value));
}
function pub(row) {
  return {
    operation_id: row.operation_id, approval_id: row.approval_id, phase: row.phase, outcome: row.outcome,
    immutable_draft_id: row.immutable_draft_id, body_digest: row.body_digest,
    send_invocation_count: row.send_invocation_count, provider: row.provider,
  };
}
function createFakeTxnHarness() {
  const durable = new Map(); const log = [];
  let releaseCalls = 0; let failOn = null; let commitReject = false; let loanSeq = 0; let rowMutator = null;
  const rowLocks = new Map();
  const clone = (r) => ({ ...r });
  function lockState(op) {
    let s = rowLocks.get(op); if (!s) { s = { owner: null, wait: [] }; rowLocks.set(op, s); } return s;
  }
  function acquire(op, loanId) {
    const s = lockState(op); if (s.owner == null || s.owner === loanId) { s.owner = loanId; return Promise.resolve(); }
    return new Promise((resolve) => { s.wait.push(resolve); }).then(() => { s.owner = loanId; });
  }
  function releaseLocks(loanId) {
    for (const [, s] of rowLocks) {
      if (s.owner !== loanId) continue; s.owner = null; const n = s.wait.shift(); if (n) n();
    }
  }
  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1); let inTx = false; const staged = new Map();
    const visible = (op) => (staged.has(op) ? staged.get(op) : (durable.has(op) ? clone(durable.get(op)) : null));
    const byApproval = (cid, ap) => {
      for (const row of staged.values()) if (row.client_id === cid && row.approval_id === ap) return row;
      for (const row of durable.values()) if (row.client_id === cid && row.approval_id === ap) return clone(row); return null;
    };
    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim(); log.push({ loanId, sql: norm, params: params ? params.slice() : null });
        if (failOn && failOn(norm, params)) throw new Error('planted_db_failure');
        if (norm === 'BEGIN') { if (inTx) throw new Error('nested_begin'); inTx = true; staged.clear(); return { rows: [] }; }
        if (norm === 'COMMIT') {
          if (!inTx) throw new Error('commit_without_begin'); if (commitReject) throw new Error('planted_commit_reject'); for (const [k, row] of staged) durable.set(k, clone(row));
          staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] };
        }
        if (norm === 'ROLLBACK') { staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] }; }
        if (/FOR UPDATE/.test(norm) && /tenant_email_outbound_send_journal/.test(norm) && /operation_id = \$1::uuid/.test(norm)) {
          const op = String(params[0]).toLowerCase(); await acquire(op, loanId);
          const row = visible(op); return { rows: row ? [rowMutator ? rowMutator(clone(row)) : clone(row)] : [] };
        }
        if (/FOR UPDATE/.test(norm) && /approval_id = \$2::uuid/.test(norm)) {
          const ap = String(params[1]).toLowerCase(); await acquire(`approval:${ap}`, loanId);
          const row = byApproval(String(params[0]).toLowerCase(), ap); return { rows: row ? [{ operation_id: row.operation_id }] : [] };
        }
        if (/^INSERT INTO tenant_email_outbound_send_journal/.test(norm)) {
          const op = String(params[0]).toLowerCase(); if (visible(op)) return { rows: [] };
          const ap = String(params[6]).toLowerCase();
          const existingAp = byApproval(String(params[1]).toLowerCase(), ap); if (existingAp && existingAp.operation_id !== op) {
            const err = new Error('duplicate key approval'); err.code = '23505'; throw err;
          }
          const row = {
            operation_id: op, client_id: String(params[1]).toLowerCase(), location_id: String(params[2]).toLowerCase(),
            location_key: String(params[3]), endpoint_id: String(params[4]).toLowerCase(),
            conversation_id: String(params[5]).toLowerCase(), approval_id: ap,
            actor_staff_user_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
            immutable_draft_id: null, body_digest: String(params[8]), phase: 'claimed', outcome: 'claimed',
            send_invocation_count: 0,
          }; staged.set(op, row); return { rows: [pub(row)] };
        }
        const pm = /UPDATE tenant_email_outbound_send_journal SET phase='([^']+)'/.exec(norm); if (pm) {
          const phase = pm[1]; const op = String(params[0]).toLowerCase(); const row = visible(op); if (!row) return { rows: [] }; if (phase === 'draft_created') {
            if (row.phase !== 'claimed' || row.immutable_draft_id != null || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'not_committed'; row.immutable_draft_id = String(params[1]);
          } else if (phase === 'draft_updated') {
            if (row.phase !== 'draft_created' || !row.immutable_draft_id || row.send_invocation_count !== 0) return { rows: [] }; row.phase = phase; row.outcome = 'not_committed';
          } else if (phase === 'send_dispatched') {
            if (row.phase !== 'draft_updated' || !row.immutable_draft_id || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.send_invocation_count = 1;
          } else if (phase === 'reconciled_sent') {
            if (row.phase !== 'send_dispatched' || row.send_invocation_count !== 1 || row.immutable_draft_id !== String(params[1])) return { rows: [] }; row.phase = phase; row.outcome = 'committed';
          } else if (phase === 'terminal') {
            if (row.phase !== String(params[2]) || Number(row.send_invocation_count) !== Number(params[3])) return { rows: [] }; row.phase = phase; row.outcome = String(params[1]);
          } else return { rows: [] }; staged.set(op, row); return { rows: [pub(row)] };
        }
        throw new Error(`unexpected_sql:${norm.slice(0, 80)}`);
      },
      release() { releaseCalls += 1; },
    }; try { return await work(client); } finally { releaseLocks(loanId); }
  }
  return {
    withTransactionClient, durable, log, getReleaseCalls: () => releaseCalls,
    setFailOn(fn) { failOn = fn; }, setCommitReject(v) { commitReject = v; }, setRowMutator(fn) { rowMutator = fn; },
  };
}
function makeStore(h, auth = authority()) {
  return createEmailOutboundSendJournalStore({ withTransactionClient: h.withTransactionClient, authority: auth });
}
async function toDraftUpdated(store, op, ap) {
  await store.claim({ operationId: op, approvalId: ap, bodyDigest: DIGEST }); await store.persistDraftCreated({ operationId: op, immutableDraftId: DRAFT });
  await store.markDraftUpdated({ operationId: op });
}
async function proveFake() {
  console.log('\n[fake exclusive-client harness]');
  const h = createFakeTxnHarness(); const store = makeStore(h);
  const op1 = crypto.randomUUID(); const ap1 = crypto.randomUUID();
  const c1 = await store.claim({ operationId: op1, approvalId: ap1, bodyDigest: DIGEST }); ok('claim/replay/conflicts', resultShape(c1) && c1.value.phase === 'claimed' && !c1.value.authorize_dispatch
    && (await store.claim({ operationId: op1, approvalId: ap1, bodyDigest: DIGEST })).value.replayed
    && (await store.claim({ operationId: op1, approvalId: crypto.randomUUID(), bodyDigest: DIGEST })).error === 'operation_id_conflict'
    && (await store.claim({ operationId: crypto.randomUUID(), approvalId: ap1, bodyDigest: DIGEST })).error === 'approval_id_conflict');
  const h2 = createFakeTxnHarness(); let inserts = 0; h2.setFailOn((sql) => { if (/^INSERT INTO tenant_email_outbound_send_journal/.test(sql)) { inserts += 1; return inserts === 1; } return false; });
  const failClaim = await makeStore(h2).claim({ operationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  ok('failed query rolls back + release caller-owned', failClaim.error === 'email_outbound_send_journal_write_failed'
    && h2.durable.size === 0 && h2.log.some((e) => e.sql === 'ROLLBACK') && noLeak(failClaim)
    && h.getReleaseCalls() === 0 && h2.getReleaseCalls() === 0);
  const h3 = createFakeTxnHarness(); const s3 = makeStore(h3);
  const op = crypto.randomUUID(); const ap = crypto.randomUUID(); await s3.claim({ operationId: op, approvalId: ap, bodyDigest: DIGEST });
  const d1 = await s3.persistDraftCreated({ operationId: op, immutableDraftId: DRAFT });
  const dReplay = await s3.persistDraftCreated({ operationId: op, immutableDraftId: DRAFT });
  const dConflict = await s3.persistDraftCreated({ operationId: op, immutableDraftId: `${DRAFT}-X` });
  await s3.markDraftUpdated({ operationId: op });
  const disp1 = await s3.claimDispatch({ operationId: op });
  const disp2 = await s3.claimDispatch({ operationId: op }); ok('draft/dispatch/reconcile/terminal', resultShape(d1) && d1.value.immutable_draft_id === DRAFT
    && dReplay.value.replayed && dConflict.error === 'immutable_draft_id_conflict'
    && resultShape(disp1) && disp1.value.authorize_dispatch && disp1.value.send_invocation_count === 1
    && resultShape(disp2) && !disp2.value.authorize_dispatch && disp2.value.replayed
    && resultShape(await s3.reconcileSent({ operationId: op, immutableDraftId: DRAFT }))
    && (await s3.reconcileSent({ operationId: op, immutableDraftId: DRAFT })).value.replayed
    && !(await s3.claimDispatch({ operationId: op })).value.authorize_dispatch
    && (await s3.markTerminal({ operationId: op, outcome: 'not_committed' })).error === 'phase_conflict');
  const h4 = createFakeTxnHarness(); const s4 = makeStore(h4); const opT = crypto.randomUUID(); await s4.claim({ operationId: opT, approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  ok('terminal sealed', resultShape(await s4.markTerminal({ operationId: opT, outcome: 'not_committed' }))
    && (await s4.markDraftUpdated({ operationId: opT })).error === 'phase_conflict');
  const h5 = createFakeTxnHarness(); h5.setCommitReject(true);
  const commitR = await makeStore(h5).claim({ operationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  ok('COMMIT reject → rollback + commit_outcome_unknown', commitR.error === 'commit_outcome_unknown'
    && h5.log.some((e) => e.sql === 'COMMIT') && h5.log.some((e) => e.sql === 'ROLLBACK')
    && noLeak(commitR) && Object.isFrozen(commitR));
  let loans = 0;
  const loanCount = async (work) => { loans += 1; return work({ async query() { return { rows: [] }; } }); };
  try { createEmailOutboundSendJournalStore({ withTransactionClient: loanCount, authority: authority({ clientId: 'x' }) }); ok('hostile authority', false); }
  catch (e) { ok('hostile authority', e.code === FAILURE_CODE && loans === 0); }
  try {
    createEmailOutboundSendJournalStore({ withTransactionClient: loanCount, authority: Object.assign(Object.create({ clientId: C }), authority()) }); ok('inherited authority', false);
  } catch (e) { ok('inherited authority', e.code === FAILURE_CODE && loans === 0); }
  const sH = createEmailOutboundSendJournalStore({ withTransactionClient: loanCount, authority: authority() });
  const before = loans; const acc = {}; Object.defineProperty(acc, 'operationId', { get() { return op1; }, enumerable: true });
  Object.defineProperty(acc, 'approvalId', { value: ap1, enumerable: true }); Object.defineProperty(acc, 'bodyDigest', { value: DIGEST, enumerable: true });
  ok('hostile input before DB', (await sH.claim({ operationId: op1, approvalId: ap1, bodyDigest: 'nope' })).error === 'body_digest_invalid'
    && (await sH.claim(acc)).error === 'input_invalid' && loans === before);
  const h6 = createFakeTxnHarness(); const s6 = makeStore(h6); const opC = crypto.randomUUID(); await toDraftUpdated(s6, opC, crypto.randomUUID());
  const [a, b] = await Promise.all([s6.claimDispatch({ operationId: opC }), s6.claimDispatch({ operationId: opC })]);
  ok('parallel contenders one authorize', [a, b].filter((r) => r.ok && r.value.authorize_dispatch).length === 1
    && [a, b].filter((r) => r.ok && !r.value.authorize_dispatch).length === 1
    && Number(h6.durable.get(opC).send_invocation_count) === 1); console.log('\n[hostile regressions]');
  async function throwMapped(setFail) {
    const hx = createFakeTxnHarness(); setFail(hx); return makeStore(hx).claim({ operationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  }
  const proxyR = await throwMapped((hx) => hx.setFailOn(() => {
    throw new Proxy({}, { get(_t, p) {
      if (p === 'code') throw new Error(PLANTED); if (p === 'message') return PLANTED; if (p === 'toString') return () => PLANTED; return undefined;
    } });
  }));
  const primR = await throwMapped((hx) => hx.setFailOn(() => { throw PLANTED; }));
  const accR = await throwMapped((hx) => hx.setFailOn(() => {
    const err = {}; Object.defineProperty(err, 'code', { get() { throw new Error(PLANTED); }, enumerable: true }); throw err;
  })); ok('Proxy/accessor/primitive code → sanitized',
    [proxyR, primR, accR].every((r) => !r.ok && r.error === 'email_outbound_send_journal_write_failed' && noLeak(r) && Object.isFrozen(r)));
  async function badRow(mut) {
    const hx = createFakeTxnHarness(); const sx = makeStore(hx); const opx = crypto.randomUUID(); await sx.claim({ operationId: opx, approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
    hx.setRowMutator(mut); return sx.load({ operationId: opx });
  }
  const rows = await Promise.all([ badRow((row) => { const o = { ...row }; Object.defineProperty(o, 'body_digest', { get() { return DIGEST; }, enumerable: true }); return o; }),
    badRow((row) => ({ ...row, send_invocation_count: { valueOf() { return 0; }, [Symbol.toPrimitive]() { return 0; } } })),
    badRow((row) => ({ ...row, phase: 'draft_created', outcome: 'not_committed', immutable_draft_id: `${PLANTED}-${'x'.repeat(100000)}` })),
    badRow((row) => ({ ...row, phase: 'draft_created', outcome: 'not_committed', immutable_draft_id: `user@evil.example/${TOKEN}` })),
  ]); ok('hostile DB rows → db_result_invalid no reflect', rows.every((r) => r.error === 'db_result_invalid' && noLeak(r)));
  const realFreeze = Object.freeze; const hFr = createFakeTxnHarness(); const sFr = makeStore(hFr); Object.freeze = function poison() { throw new Error(PLANTED); };
  let freezeR; try { freezeR = await sFr.claim({ operationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), bodyDigest: DIGEST }); }
  finally { Object.freeze = realFreeze; }
  ok('ambient Object.freeze replacement', resultShape(freezeR) && Object.isFrozen(freezeR)
    && Object.isFrozen(freezeR.value) && Object.isFrozen(sFr) && noLeak(freezeR));
  const realCreate = Object.create; const hCr = createFakeTxnHarness(); const sCr = makeStore(hCr);
  Object.create = function poison() { throw new Error(PLANTED); };
  let createValid; let createInvalid; try {
    createValid = await sCr.claim({ operationId: crypto.randomUUID(), approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
    createInvalid = await sCr.claim({ operationId: 'nope', approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  } finally { Object.create = realCreate; }
  ok('ambient Object.create replacement', resultShape(createValid) && createInvalid && createInvalid.ok === false
    && createInvalid.error === 'operation_id_invalid' && Object.isFrozen(createValid) && Object.isFrozen(createInvalid)
    && Object.isFrozen(createValid.value) && noLeak(createValid) && noLeak(createInvalid));
}
function tryLoadPglite() {
  for (const base of [process.env.NODE_PATH, '/opt/data/wolfhouse-agent/node_modules', path.join(ROOT, 'node_modules')].filter(Boolean)) {
    try { const m = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite')); if (m && m.PGlite) return m.PGlite; } catch { /* */ }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch { return null; }
}
function shellSql() {
  return `CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE clients (id uuid PRIMARY KEY); CREATE TABLE staff_users (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id));
ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
CREATE TABLE tenant_locations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), location_id text NOT NULL, display_name text NOT NULL DEFAULT 'loc', active boolean NOT NULL DEFAULT true);
ALTER TABLE tenant_locations ADD CONSTRAINT tenant_locations_client_id_id_uq UNIQUE (client_id, id);
ALTER TABLE tenant_locations ADD CONSTRAINT tenant_locations_client_location_uq UNIQUE (client_id, location_id);
CREATE TABLE tenant_channel_endpoints (id uuid PRIMARY KEY, client_id uuid NOT NULL, location_id text NOT NULL, channel text NOT NULL DEFAULT 'email', provider text NOT NULL DEFAULT 'microsoft_graph', public_address text NOT NULL DEFAULT 'a@b.co', secret_ref text, capabilities jsonb NOT NULL DEFAULT '{}'::jsonb);
ALTER TABLE tenant_channel_endpoints ADD CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id);
CREATE TABLE conversations (id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id), phone text);
ALTER TABLE conversations ADD CONSTRAINT conversations_client_id_id_uq UNIQUE (client_id, id); INSERT INTO clients VALUES ('${C}'); INSERT INTO staff_users (id, client_id) VALUES ('${A}', '${C}');
INSERT INTO tenant_locations (id, client_id, location_id) VALUES ('${L}', '${C}', '${K}'); INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ('${E}', '${C}', '${K}');
INSERT INTO conversations (id, client_id, phone) VALUES ('${V}', '${C}', 'emailv1:x');`;
}
function pgliteLoaner(db) {
  let chain = Promise.resolve(); let releaseCalls = 0; return Object.freeze({
    async withTransactionClient(work) {
      const run = chain.then(async () => work({
        async query(sql, params) { return db.query(sql, params || []); },
        release() { releaseCalls += 1; },
      })); chain = run.then(() => undefined, () => undefined); return run;
    },
    getReleaseCalls: () => releaseCalls,
  });
}
async function provePglite(PGlite) {
  console.log('\n[PGlite schema/transaction evidence]');
  const db = new PGlite(); await db.exec(shellSql()); await db.exec(UP_068);
  const loaner = pgliteLoaner(db);
  const store = createEmailOutboundSendJournalStore({ withTransactionClient: loaner.withTransactionClient, authority: authority() });
  const op = crypto.randomUUID(); const ap = crypto.randomUUID(); ok('pglite claim/replay/conflicts', resultShape(await store.claim({ operationId: op, approvalId: ap, bodyDigest: DIGEST }))
    && (await store.claim({ operationId: op, approvalId: ap, bodyDigest: DIGEST })).value.replayed
    && (await store.claim({ operationId: op, approvalId: crypto.randomUUID(), bodyDigest: DIGEST })).error === 'operation_id_conflict'
    && (await store.claim({ operationId: crypto.randomUUID(), approvalId: ap, bodyDigest: DIGEST })).error === 'approval_id_conflict');
  const opFail = crypto.randomUUID(); await store.claim({ operationId: opFail, approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  let failOnce = true;
  const mid = await createEmailOutboundSendJournalStore({
    withTransactionClient: async (work) => loaner.withTransactionClient(async (client) => work({
      async query(sql, params) {
        if (failOnce && /phase='draft_created'/.test(String(sql))) { failOnce = false; throw new Error('planted_mid_tx'); }
        return client.query(sql, params);
      },
    })),
    authority: authority(),
  }).persistDraftCreated({ operationId: opFail, immutableDraftId: `${DRAFT}-FAIL` });
  const still = await db.query('SELECT phase, immutable_draft_id FROM tenant_email_outbound_send_journal WHERE operation_id=$1', [opFail]);
  ok('pglite mid-tx rollback', mid.ok === false && still.rows[0].phase === 'claimed' && still.rows[0].immutable_draft_id == null);
  await store.persistDraftCreated({ operationId: op, immutableDraftId: DRAFT }); await store.markDraftUpdated({ operationId: op });
  const d1 = await store.claimDispatch({ operationId: op });
  const d2 = await store.claimDispatch({ operationId: op });
  const row = await db.query('SELECT phase, send_invocation_count FROM tenant_email_outbound_send_journal WHERE operation_id=$1', [op]);
  ok('pglite dispatch once + durable count', d1.value.authorize_dispatch && !d2.value.authorize_dispatch && d2.value.replayed
    && row.rows[0].phase === 'send_dispatched' && Number(row.rows[0].send_invocation_count) === 1); await store.reconcileSent({ operationId: op, immutableDraftId: DRAFT });
  const opT = crypto.randomUUID(); const opS = crypto.randomUUID(); await store.claim({ operationId: opT, approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  await store.markTerminal({ operationId: opT, outcome: 'rejected' }); await store.claim({ operationId: opS, approvalId: crypto.randomUUID(), bodyDigest: DIGEST });
  ok('pglite sealed/release/authority', !(await store.claimDispatch({ operationId: op })).value.authorize_dispatch
    && (await store.persistDraftCreated({ operationId: opT, immutableDraftId: `${DRAFT}-T` })).error === 'phase_conflict'
    && (await store.claimDispatch({ operationId: opS })).error === 'phase_conflict' && loaner.getReleaseCalls() === 0
    && (await createEmailOutboundSendJournalStore({
      withTransactionClient: loaner.withTransactionClient,
      authority: authority({ actorStaffUserId: '66666666-6666-4666-8666-666666666666' }),
    }).load({ operationId: op })).error === 'operation_id_conflict');
}
async function proveStockPostgres(url) {
  let Pool; try { ({ Pool } = require('pg')); }
  catch (e) { fail += 1; console.log(`  FAIL  stock-PG requires pg — ${e && e.message ? e.message : e}`); return; }
  const schema = `ob_sj_${process.pid}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) { fail += 1; console.log('  FAIL  stock-PG unsafe schema'); return; }
  const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
  const pids = []; let releaseCount = 0; let maxConc = 0; let active = 0;
  // Rendezvous off for sequential schema/setup + toDraftUpdated; enable only for parallel claimDispatch.
  const rz = { enabled: false, waiters: 0, gate: null, release: null };
  function resetRz() { rz.waiters = 0; rz.gate = new Promise((r) => { rz.release = r; }); }
  resetRz();
  async function withTransactionClient(work) {
    const client = await pool.connect(); active += 1; if (active > maxConc) maxConc = active; try {
      await client.query(`SET search_path TO ${schema}, public`);
      pids.push(Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      if (rz.enabled) { rz.waiters += 1; if (rz.waiters >= 2) rz.release(); await rz.gate; }
      return await work(client);
    } finally { active -= 1; client.release(); releaseCount += 1; }
  }
  const STOCK_PG_PROOF_MS = 30000;
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const setup = await pool.connect();
    try { await setup.query(`SET search_path TO ${schema}, public`); await setup.query(shellSql()); await setup.query(UP_068); }
    finally { setup.release(); }
    const store = createEmailOutboundSendJournalStore({ withTransactionClient, authority: authority() });
    const op = crypto.randomUUID();
    // Sequential setup must not join the two-client rendezvous (would deadlock on single waiter).
    rz.enabled = false; await toDraftUpdated(store, op, crypto.randomUUID());
    pids.length = 0; releaseCount = 0; maxConc = 0; active = 0; resetRz(); rz.enabled = true;
    let timeoutHandle = null; let d1; let d2;
    const contenders = Promise.all([store.claimDispatch({ operationId: op }), store.claimDispatch({ operationId: op })]);
    const timed = new Promise((_, rej) => {
      timeoutHandle = setTimeout(() => rej(new Error(`stock-PG proof timeout after ${STOCK_PG_PROOF_MS}ms (deadlock or hang)`)), STOCK_PG_PROOF_MS);
    });
    try { [d1, d2] = await Promise.race([contenders, timed]); }
    finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
    const auths = [d1, d2].filter((r) => r.ok && r.value && r.value.authorize_dispatch);
    const reps = [d1, d2].filter((r) => r.ok && r.value && !r.value.authorize_dispatch);
    const cnt = await pool.connect(); let durable; try {
      await cnt.query(`SET search_path TO ${schema}, public`);
      durable = (await cnt.query( 'SELECT send_invocation_count, phase FROM tenant_email_outbound_send_journal WHERE operation_id=$1::uuid', [op],
      )).rows[0];
    } finally { cnt.release(); }
    ok('stock-PG distinct pids + release + one authorize + count=1',
      new Set(pids).size === 2 && releaseCount >= 2 && maxConc >= 2
      && auths.length === 1 && reps.length === 1 && auths[0].value.send_invocation_count === 1
      && durable && Number(durable.send_invocation_count) === 1 && durable.phase === 'send_dispatched'
      && !auths[0].value.replayed && reps[0].value.replayed && d1.ok && d2.ok && noLeak(d1) && noLeak(d2));
  } catch (e) {
    fail += 1; console.log(`  FAIL  stock-PG proof — ${e && e.message ? e.message : e}`);
  } finally {
    rz.enabled = false;
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* */ }
    try { await pool.end(); } catch { /* */ }
  }
}
async function main() {
  console.log('verify:email-outbound-send-journal-store — Gate 3 offline journal store\n');
  const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-outbound-send-journal-store.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); ok('static contract', EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED === false
    && EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN === true && EMAIL_OUTBOUND_SEND_JOURNAL_PROVIDER === 'microsoft_graph'
    && STORE_DEPENDENCY_KEYS.join(',') === 'withTransactionClient,authority' && AUTHORITY_KEYS.includes('locationKey')
    && /PINNED_OBJECT_FREEZE/.test(src) && /PINNED_OBJECT_CREATE/.test(src) && /PINNED_DEFINE_PROPERTY/.test(src)
    && /PINNED_GOPD|PINNED_GET_OWN_PROPERTY_DESCRIPTOR/.test(src)
    && !/\bObject\.create\s*\(/.test(src.replace(/typeof Object\.create/g, ''))
    && !/\bObject\.defineProperty\s*\(/.test(src.replace(/typeof Object\.defineProperty/g, ''))
    && /ownErrorCode/.test(src) && /db_result_invalid/.test(src) && /commit_outcome_unknown/.test(src)
    && !/require\(['"]pg['"]\)/.test(src) && !/require\(['"]https['"]\)/.test(src) && !/getPool\s*\(/.test(src)
    && !/access_token|refresh_token|message_body/i.test(src) && !/console\.(log|info|debug|warn|error)/.test(src)
    && !/\bsetTimeout\b|\bsetInterval\b/.test(src) && !!(pkg.scripts && pkg.scripts['verify:email-outbound-send-journal-store'])
    && !fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8').includes('email-outbound-send-journal-store')
    && /tenant_email_outbound_send_journal/.test(UP_068)); await proveFake();
  const PGlite = tryLoadPglite(); if (!PGlite) ok('PGlite mandatory', false, 'NODE_PATH=/opt/data/wolfhouse-agent/node_modules');
  else await provePglite(PGlite); console.log('\n[optional stock-Postgres multi-client]');
  if (!process.env[STOCK_PG_ENV]) console.log(`  SKIP  stock-PG UNAVAILABLE (${STOCK_PG_ENV} unset) — not counted as PASS`);
  else await proveStockPostgres(process.env[STOCK_PG_ENV]);
  console.log(`\n── verify:email-outbound-send-journal-store ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
