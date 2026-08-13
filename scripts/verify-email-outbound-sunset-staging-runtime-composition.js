'use strict';
/** Offline Gate 3 outbound runtime-composition verifier. Production owners; fake DB/KV/token/HTTPS. */
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Socket } = require('node:net');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const COMP_ABS = path.join(ROOT, 'scripts/lib/email-outbound-sunset-staging-runtime-composition.js');
const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'secret-NEVER_LEAK-outbound-runtime';
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const M = '22222222-2222-4222-8222-2222222222ab';
const K = 'sunset-somo'; const SRC = 'AAMkAGI2-SRC-OUTBOUND-RUNTIME';
const DRAFT = 'AAMkAGI2-DRAFT-OUTBOUND-RUNTIME';
const TOKEN = 'atok-NEVER_LEAK-outbound-runtime-token';
const RT = 'rt-NEVER_LEAK-outbound-runtime-refresh';
const PLANTED = 'NEVER_LEAK_body_or_address_or_token';
const BODY = 'Approved staff reply body for Gate3 runtime composition.';
const ORIGIN = 'https://staff.sunset.test';
const TOKEN_HOST = 'login.microsoftonline.com';
const GRAPH_HOST = 'graph.microsoft.com';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return !t.includes(TOKEN) && !t.includes(RT) && !t.includes(PLANTED) && !t.includes(BODY) && !t.includes(SECRET)
    && !t.includes(DRAFT) && !t.includes('access_token') && !t.includes('refresh_token') && !t.includes('Bearer ');
}
function enabledEnv(p = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST, EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID, ...p,
  };
}
function installAzureRsa(stats) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const wrapOpts = { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
  const unwrapOpts = { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
  const orig = Module._load;
  function interceptedExport(request, parent, exports) {
    const mod = new Module(request, parent);
    mod.filename = request;
    mod.paths = [];
    mod.exports = exports;
    mod.loaded = true;
    require.cache[request] = mod;
    return exports;
  }
  Module._load = function (request, parent, isMain) {
    if (request === '@azure/identity'
        || (typeof request === 'string' && request.includes('managedIdentityCredential') && request.endsWith('index.js'))) {
      if (stats) stats.kv += 1;
      const exports = { ManagedIdentityCredential: class { constructor(id) { assert.equal(id, MI); } getToken() { return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 }); } } };
      return typeof request === 'string' && path.isAbsolute(request)
        ? interceptedExport(request, parent, exports) : exports;
    }
    if (request === '@azure/keyvault-keys'
        || (typeof request === 'string' && request.includes('keyvault-keys') && request.endsWith('cryptographyClient.js'))) {
      if (stats) stats.kv += 1;
      const exports = {
        CryptographyClient: class {
          constructor(id) { assert.equal(id, KEY_ID); }
          async wrapKey(_a, key) {
            return { result: crypto.publicEncrypt(wrapOpts, Buffer.isBuffer(key) ? key : Buffer.from(key)) };
          }
          async unwrapKey(_a, wrapped) {
            return { result: crypto.privateDecrypt(unwrapOpts, Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped)) };
          }
        },
      };
      return typeof request === 'string' && path.isAbsolute(request)
        ? interceptedExport(request, parent, exports) : exports;
    }
    return orig.call(this, request, parent, isMain);
  };
  return () => { Module._load = orig; };
}
function sealed(o = {}) {
  return {
    operation_id: crypto.randomUUID(), approval_id: crypto.randomUUID(), message_text: BODY,
    client_id: C, location_id: L, location_key: K, endpoint_id: E, conversation_id: V,
    actor_staff_user_id: A, provider_mailbox_id: M, provider_source_message_id: SRC, ...o,
  };
}
function im(status, body) {
  const res = new http.IncomingMessage(new Socket());
  res.statusCode = status; res.headers = { 'content-type': 'application/json' };
  queueMicrotask(() => { if (body != null) res.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); res.emit('end'); });
  return res;
}
function fakeHttpsRouted(graphSeq) {
  let gi = 0; const calls = []; let tokenHits = 0; let accessLoanHeaders = 0;
  const request = (opts, cb) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => {
      const host = opts && (opts.hostname || opts.host);
      const pathStr = opts && opts.path;
      const auth = opts && opts.headers && (opts.headers.Authorization || opts.headers.authorization);
      calls.push({ method: opts.method, path: pathStr, host });
      if (host === TOKEN_HOST || (typeof pathStr === 'string' && pathStr.includes('/oauth2/'))) {
        tokenHits += 1;
        queueMicrotask(() => cb(im(200, {
          token_type: 'Bearer', expires_in: 3600, access_token: TOKEN,
          scope: 'User.Read Mail.ReadWrite Mail.Send',
        })));
        return;
      }
      if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length > 7) accessLoanHeaders += 1;
      const step = graphSeq[gi] !== undefined ? graphSeq[gi] : graphSeq[graphSeq.length - 1]; gi += 1;
      queueMicrotask(() => {
        if (step && step.loss) { req.emit('error', new Error(PLANTED + '_https_loss')); return; }
        if (typeof step === 'function') cb(step(opts)); else cb(im(202, null));
      });
    };
    return req;
  };
  return {
    httpsObj: Object.freeze({ request }), calls: () => calls, tokenHits: () => tokenHits,
    accessLoanHeaders: () => accessLoanHeaders,
    count: (re) => calls.filter((c) => c.host === GRAPH_HOST && re.test(c.path || '')).length,
    graphSends: () => calls.filter((c) => c.host === GRAPH_HOST && /\/send$/.test(c.path || '')).length,
  };
}
/** Same caller-owned client for journal short-TX + grant lifecycle (production loan shape). */
function createPinnedClientHarness(grantEnvelope) {
  const durable = new Map(); let inTx = false; const staged = new Map();
  let leaseTok = null; let grantGen = 1; let grantStatus = 'active';
  let lastOp = String(grantEnvelope.operation_id || crypto.randomUUID()).toLowerCase();
  let envRow = { ...grantEnvelope }; let releaseHits = 0;
  const clone = (r) => ({ ...r });
  const pub = (row) => ({
    operation_id: row.operation_id, approval_id: row.approval_id, phase: row.phase, outcome: row.outcome,
    immutable_draft_id: row.immutable_draft_id, body_digest: row.body_digest,
    create_invocation_count: row.create_invocation_count, update_invocation_count: row.update_invocation_count,
    send_invocation_count: row.send_invocation_count, provider: row.provider,
  });
  const visible = (op) => (staged.has(op) ? staged.get(op) : (durable.has(op) ? clone(durable.get(op)) : null));
  const byAp = (cid, ap) => {
    for (const row of staged.values()) if (row.client_id === cid && row.approval_id === ap) return row;
    for (const row of durable.values()) if (row.client_id === cid && row.approval_id === ap) return clone(row);
    return null;
  };
  const grantPublic = () => ({
    client_id: C, endpoint_id: E, grant_generation: grantGen, grant_status: grantStatus,
    reconcile_state: 'clean', grant_lease_token: leaseTok, scope_version: 'phase_b_v1',
  });
  const grantOpenRow = () => ({
    client_id: C, endpoint_id: E, grant_generation: grantGen, grant_status: grantStatus,
    grant_lease_token: leaseTok, grant_lease_until: new Date(Date.now() + 60000).toISOString(),
    last_operation_id: lastOp, scope_version: 'phase_b_v1', envelope_version: envRow.envelope_version, aead_alg: envRow.aead_alg,
    kek_wrap_alg: envRow.kek_wrap_alg, kek_key_name: envRow.kek_key_name, kek_key_version: envRow.kek_key_version,
    nonce: envRow.nonce, ciphertext: envRow.ciphertext, auth_tag: envRow.auth_tag, wrapped_dek: envRow.wrapped_dek,
    endpoint_binding_status: 'verified',
  });
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN') { if (inTx) throw new Error('nested'); inTx = true; staged.clear(); return { rows: [] }; }
      if (n === 'COMMIT') { for (const [k, row] of staged) durable.set(k, clone(row)); staged.clear(); inTx = false; return { rows: [] }; }
      if (n === 'ROLLBACK') { staged.clear(); inTx = false; return { rows: [] }; }
      if (/FOR UPDATE/.test(n) && /operation_id = \$1::uuid/.test(n) && /tenant_email_outbound_send_journal/.test(n)) {
        const op = String(params[0]).toLowerCase(); const row = visible(op); return { rows: row ? [clone(row)] : [] };
      }
      if (/FOR UPDATE/.test(n) && /approval_id = \$2::uuid/.test(n) && /tenant_email_outbound_send_journal/.test(n)) {
        const row = byAp(String(params[0]).toLowerCase(), String(params[1]).toLowerCase());
        return { rows: row ? [{ operation_id: row.operation_id }] : [] };
      }
      if (/^INSERT INTO tenant_email_outbound_send_journal/.test(n)) {
        const op = String(params[0]).toLowerCase(); if (visible(op)) return { rows: [] };
        const ap = String(params[6]).toLowerCase(); const ex = byAp(String(params[1]).toLowerCase(), ap);
        if (ex && ex.operation_id !== op) { const e = new Error('dup'); e.code = '23505'; throw e; }
        const row = {
          operation_id: op, client_id: String(params[1]).toLowerCase(), location_id: String(params[2]).toLowerCase(),
          location_key: String(params[3]), endpoint_id: String(params[4]).toLowerCase(),
          conversation_id: String(params[5]).toLowerCase(), approval_id: ap,
          actor_staff_user_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
          immutable_draft_id: null, body_digest: String(params[8]), phase: 'claimed', outcome: 'claimed',
          create_invocation_count: 0, update_invocation_count: 0, send_invocation_count: 0,
        };
        staged.set(op, row); return { rows: [pub(row)] };
      }
      const pm = /UPDATE tenant_email_outbound_send_journal SET phase='([^']+)'/.exec(n);
      if (pm) {
        const phase = pm[1]; const op = String(params[0]).toLowerCase(); const row = visible(op); if (!row) return { rows: [] };
        const cc = row.create_invocation_count, uc = row.update_invocation_count, sc = row.send_invocation_count, id = row.immutable_draft_id;
        if (phase === 'create_dispatched') { if (row.phase !== 'claimed' || id != null || cc || uc || sc) return { rows: [] }; row.phase = phase; row.outcome = 'outcome_unknown'; row.create_invocation_count = 1; }
        else if (phase === 'draft_created') { if (row.phase !== 'create_dispatched' || id != null || cc !== 1 || uc || sc) return { rows: [] }; row.phase = phase; row.outcome = 'not_committed'; row.immutable_draft_id = String(params[1]); }
        else if (phase === 'update_dispatched') { if (row.phase !== 'draft_created' || !id || id !== String(params[1]) || cc !== 1 || uc || sc) return { rows: [] }; row.phase = phase; row.outcome = 'outcome_unknown'; row.update_invocation_count = 1; }
        else if (phase === 'draft_updated') { if (row.phase !== 'update_dispatched' || !id || cc !== 1 || uc !== 1 || sc) return { rows: [] }; row.phase = phase; row.outcome = 'not_committed'; }
        else if (phase === 'send_dispatched') { if (row.phase !== 'draft_updated' || !id || cc !== 1 || uc !== 1 || sc) return { rows: [] }; row.phase = phase; row.outcome = 'outcome_unknown'; row.send_invocation_count = 1; }
        else if (phase === 'reconciled_sent') { if (row.phase !== 'send_dispatched' || sc !== 1 || id !== String(params[1])) return { rows: [] }; row.phase = phase; row.outcome = 'committed'; }
        else return { rows: [] };
        staged.set(op, row); return { rows: [pub(row)] };
      }
      if (/FROM tenant_email_delegated_grants/i.test(n) && !/FOR UPDATE/i.test(n) && !/UPDATE/i.test(n) && !/INSERT/i.test(n)) return { rows: [grantPublic()] };
      if (/FOR UPDATE OF g/i.test(n) || (/SELECT g\.\*/i.test(n) && /FOR UPDATE/i.test(n))) return { rows: [grantOpenRow()] };
      if (/SET grant_status='lease_held'/i.test(n)) {
        leaseTok = params[3]; grantStatus = 'lease_held';
        return { rows: [{ ...grantPublic(), grant_lease_token: leaseTok, grant_lease_until: new Date(Date.now() + 60000).toISOString(), last_operation_id: lastOp }] };
      }
      if (/grant_lease_token/i.test(n) && /FOR UPDATE/i.test(n) && /envelope_version/i.test(n)) return { rows: [grantOpenRow()] };
      if (/SET grant_generation=/i.test(n) && /grant_status='active'/i.test(n)) {
        grantGen = Number(params[2]); grantStatus = 'active'; leaseTok = null; lastOp = String(params[3]).toLowerCase();
        envRow = {
          envelope_version: params[4], aead_alg: params[5], kek_wrap_alg: params[6], kek_key_name: params[7],
          kek_key_version: params[8], nonce: params[9], ciphertext: params[10], auth_tag: params[11], wrapped_dek: params[12],
          operation_id: lastOp,
        };
        return { rows: [{ client_id: C, endpoint_id: E, grant_generation: grantGen, grant_status: 'active', reconcile_state: 'clean' }] };
      }
      if (/SET reconcile_state=/i.test(n)) return { rows: [{ client_id: C, endpoint_id: E, grant_generation: grantGen, grant_status: grantStatus, reconcile_state: 'ms_response_uncertain' }] };
      if (/SET grant_status='active'/i.test(n) && /grant_lease_owner=NULL/i.test(n)) { grantStatus = 'active'; leaseTok = null; return { rows: [grantPublic()] }; }
      if (/reauthorization_required/i.test(n)) { grantStatus = 'reauthorization_required'; return { rows: [{ grant_generation: grantGen, grant_status: 'reauthorization_required' }] }; }
      if (/UPDATE tenant_channel_endpoints/i.test(n)) return { rows: [{ id: E }] };
      throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
    },
  };
  Object.defineProperty(client, 'release', { value() { releaseHits += 1; }, enumerable: false });
  return {
    client,
    withTransactionClient: async (work) => work(client),
    durable, releaseHits: () => releaseHits,
  };
}
async function sealGrantEnvelope(env) {
  const { createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition } = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
  const { buildGrantEnvelopeAadV1 } = require('./lib/email-grant-envelope-provider-contract');
  const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
  assert.equal(composition.ok, true);
  const opId = crypto.randomUUID();
  const sealedEnv = await composition.provider.sealGrantPayload({
    refresh_token: RT,
    aad: buildGrantEnvelopeAadV1({ clientId: C, endpointId: E, grantGeneration: 1, operationId: opId }),
    operation_id: opId,
  });
  return { ...sealedEnv, operation_id: opId };
}
/** Decisive: instantiate createSunsetStagingEmailOutboundDispatch → dispatchApprovedOutbound only. */
async function runProductionCompositionForcedLoss(createDispatch) {
  const env = enabledEnv();
  const harness = createPinnedClientHarness(await sealGrantEnvelope(env));
  const lossHttps = fakeHttpsRouted([
    () => im(201, { id: DRAFT, isDraft: true }), () => im(200, { id: DRAFT }), { loss: true },
  ]);
  const surface = createDispatch(Object.freeze({
    env, pgClient: harness.client, withTransactionClient: harness.withTransactionClient,
    https: lossHttps.httpsObj, timers: Object.freeze({ setTimeout, clearTimeout }),
  }));
  const req = sealed();
  const lost = await surface.dispatchApprovedOutbound(req);
  const rowAfterLoss = harness.durable.get(req.operation_id);
  const reconHttps = fakeHttpsRouted([() => im(200, { id: DRAFT, isDraft: false })]);
  const surface2 = createDispatch(Object.freeze({
    env, pgClient: harness.client, withTransactionClient: harness.withTransactionClient,
    https: reconHttps.httpsObj, timers: Object.freeze({ setTimeout, clearTimeout }),
  }));
  const committed = await surface2.dispatchApprovedOutbound(req);
  const rowFinal = harness.durable.get(req.operation_id);
  const d = {
    lost, committed, rowAfterLoss, rowFinal,
    lossCreates: lossHttps.count(/createReply/),
    lossUpdates: lossHttps.calls().filter((c) => c.host === GRAPH_HOST && c.method === 'PATCH').length,
    lossSends: lossHttps.graphSends(), reconSends: reconHttps.graphSends(),
    reconCreates: reconHttps.count(/createReply/),
    reconGets: reconHttps.calls().filter((c) => c.host === GRAPH_HOST && c.method === 'GET').length,
    tokenHits: lossHttps.tokenHits() + reconHttps.tokenHits(),
    accessLoanHeaders: lossHttps.accessLoanHeaders() + reconHttps.accessLoanHeaders(),
    releaseHits: harness.releaseHits(),
    poolShape: typeof harness.client.connect === 'function' || typeof harness.client.totalCount === 'number',
  };
  const okShape = lost && lost.ok === false && lost.code === 'email_send_outcome_unknown'
    && committed && committed.ok === true && committed.code === 'email_send_committed'
    && rowAfterLoss && rowAfterLoss.phase === 'send_dispatched' && rowAfterLoss.immutable_draft_id === DRAFT
    && rowAfterLoss.send_invocation_count === 1
    && rowFinal && rowFinal.phase === 'reconciled_sent' && rowFinal.outcome === 'committed'
    && rowFinal.immutable_draft_id === DRAFT
    && d.lossCreates === 1 && d.lossUpdates === 1 && d.lossSends === 1
    && d.reconSends === 0 && d.reconCreates === 0 && d.reconGets === 1
    && d.tokenHits >= 2 && d.accessLoanHeaders >= 1 && d.releaseHits === 0 && d.poolShape === false
    && noLeak(lost) && noLeak(committed);
  return { ok: okShape === true, detail: d };
}

async function main() {
  console.log('verify:email-outbound-sunset-staging-runtime-composition — Gate 3 dormant runtime\n');
  const kvStats = { kv: 0 }; const restore = installAzureRsa(kvStats);
  try {
    const fresh = spawnSync(process.execPath, ['-e', `
      const m=require(${JSON.stringify(COMP_ABS)});
      if(m.ENV_COMPOSITION_ENABLED!=='EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED') process.exit(2);
      if(m.isEmailOutboundRuntimeCompositionEnabled({})) process.exit(3);
      if(m.isEmailOutboundRuntimeCompositionEnabled({EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED:'true'})) process.exit(4);
      if(m.isEmailOutboundRuntimeCompositionEnabled({LUNA_DEPLOYMENT:'sunset-staging',EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED:'TRUE'})) process.exit(5);
      if(!m.isEmailOutboundRuntimeCompositionEnabled({LUNA_DEPLOYMENT:'sunset-staging',EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED:'true'})) process.exit(6);
      console.log('import_ok');
    `], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: process.env });
    ok('fresh-process import inert + flag matrix', fresh.status === 0 && /import_ok/.test(fresh.stdout), (fresh.stderr || '').slice(0, 160));

    delete require.cache[COMP_ABS];
    const mod = require('./lib/email-outbound-sunset-staging-runtime-composition');
    const {
      ERROR_CODE, ENV_COMPOSITION_ENABLED, SUNSET_DEPLOYMENT, WORKER_ID, DEPENDENCY_KEYS, REQUEST_KEYS,
      PUBLIC_CODES, SURFACE_KEYS, createSunsetStagingEmailOutboundDispatch, EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
      EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
    } = mod;
    const {
      EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED, EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
      EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
    } = require('./lib/email-authority-bound-outbound-operation');
    const { EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED } = require('./lib/email-outbound-send-journal-store');
    const { EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED } = require('./lib/email-delegated-grant-access-session');
    const {
      EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202,
    } = require('./lib/email-microsoft-graph-reply-draft-transport');
    ok('constants + Phase B + hard-false safety', ENV_COMPOSITION_ENABLED === 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED'
      && SUNSET_DEPLOYMENT === 'sunset-staging' && WORKER_ID === 'sunset-email-outbound-dispatch'
      && EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION === 'phase_b_v1'
      && EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.join(' ') === 'User.Read Mail.ReadWrite Mail.Send'
      && DEPENDENCY_KEYS.join(',') === 'env,pgClient,withTransactionClient,https,timers'
      && SURFACE_KEYS.join(',') === 'dispatchApprovedOutbound' && REQUEST_KEYS.includes('operation_id')
      && PUBLIC_CODES.includes('email_send_committed')
      && EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED === false
      && EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE === false
      && EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY === false
      && EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED === false
      && EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED === false
      && EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED === false
      && EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202 === false);

    const beforeKv = kvStats.kv; let disabledThrows = 0;
    for (const env of [
      {}, { LUNA_DEPLOYMENT: 'sunset-staging' },
      { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'TRUE' },
      { LUNA_DEPLOYMENT: 'production', EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true' },
      enabledEnv({ EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'false' }),
      enabledEnv({ EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'false' }),
    ]) {
      try {
        createSunsetStagingEmailOutboundDispatch(Object.freeze({
          env, pgClient: { query: async () => ({ rows: [] }) },
          withTransactionClient: async (w) => w({ query: async () => ({ rows: [] }) }),
          https: { request() {} }, timers: { setTimeout, clearTimeout },
        }));
      } catch (e) { if (e && e.code === ERROR_CODE && noLeak(e)) disabledThrows += 1; }
    }
    let poolReject = false;
    try {
      createSunsetStagingEmailOutboundDispatch(Object.freeze({
        env: enabledEnv(), pgClient: { query: async () => ({ rows: [] }), connect: async () => {}, totalCount: 1, idleCount: 0 },
        withTransactionClient: async (w) => w({ query: async () => ({ rows: [] }) }),
        https: { request() {} }, timers: { setTimeout, clearTimeout },
      }));
    } catch (e) { poolReject = e && e.code === ERROR_CODE; }
    ok('disabled/malformed/pool zero construction', disabledThrows === 6 && kvStats.kv === beforeKv && poolReject);

    const deadEnv = {
      operation_id: crypto.randomUUID(), envelope_version: 'v1', aead_alg: 'A256GCM', kek_wrap_alg: 'RSA-OAEP-256',
      kek_key_name: 'luna-email-grant-kek', kek_key_version: 'fde9704bd37b45fabe1f12a6a615b032',
      nonce: Buffer.alloc(12), ciphertext: Buffer.alloc(8), auth_tag: Buffer.alloc(16), wrapped_dek: Buffer.alloc(256),
    };
    const h0 = createPinnedClientHarness(deadEnv); const g0 = fakeHttpsRouted([]);
    const surface0 = createSunsetStagingEmailOutboundDispatch(Object.freeze({
      env: enabledEnv(), pgClient: h0.client, withTransactionClient: h0.withTransactionClient,
      https: g0.httpsObj, timers: Object.freeze({ setTimeout, clearTimeout }),
    }));
    ok('surface frozen single key', Object.isFrozen(surface0) && Reflect.ownKeys(surface0).join(',') === 'dispatchApprovedOutbound');
    const r0 = await surface0.dispatchApprovedOutbound(sealed());
    ok('broken grant material → unavailable zero Graph', r0 && r0.ok === false && r0.code === 'email_send_unavailable' && g0.count(/createReply/) === 0 && noLeak(r0));

    const gBad = fakeHttpsRouted([]);
    const sBad = createSunsetStagingEmailOutboundDispatch(Object.freeze({
      env: enabledEnv(), pgClient: h0.client, withTransactionClient: h0.withTransactionClient,
      https: gBad.httpsObj, timers: Object.freeze({ setTimeout, clearTimeout }),
    }));
    const badR = [];
    for (const b of [
      sealed({ extra: true }),
      (() => { const o = sealed(); Object.defineProperty(o, 'message_text', { get() { return BODY; }, enumerable: true }); return o; })(),
      new Proxy(sealed(), {}), sealed({ provider_mailbox_id: 'desk@sunset.test' }), sealed({ message_text: '' }),
    ]) badR.push(await sBad.dispatchApprovedOutbound(b));
    ok('malformed/accessor/proxy/email-mailbox pre-token reject', badR.every((r) => r && r.ok === false && r.code === 'email_send_unavailable') && gBad.calls().length === 0 && badR.every(noLeak));

    // Decisive production-composition forced-loss (real owners; fake boundaries only)
    const prodProof = await runProductionCompositionForcedLoss(createSunsetStagingEmailOutboundDispatch);
    ok('production composition forced-loss: Phase B, access loan, one create/update/send, reconcile isDraft=false, committed after reconcile',
      prodProof.ok === true, prodProof.ok ? '' : JSON.stringify(prodProof.detail && {
        lost: prodProof.detail.lost, committed: prodProof.detail.committed,
        creates: prodProof.detail.lossCreates, sends: prodProof.detail.lossSends,
        tokens: prodProof.detail.tokenHits, loans: prodProof.detail.accessLoanHeaders,
      }).slice(0, 240));

    // Mutant: Module._load swaps access-session factory before composition binds → decisive fails
    const accessAbs = require.resolve('./lib/email-delegated-grant-access-session');
    let sentinelHits = 0; let mutantCaught = false; const loadOrig = Module._load;
    try {
      delete require.cache[accessAbs]; delete require.cache[COMP_ABS];
      Module._load = function mutantLoad(request, parent, isMain) {
        const exp = loadOrig.call(this, request, parent, isMain);
        try {
          if (Module._resolveFilename(request, parent, isMain) === accessAbs
              && exp && typeof exp.createDelegatedGrantAccessSession === 'function') {
            return Object.freeze({
              ...exp,
              createDelegatedGrantAccessSession() {
                sentinelHits += 1;
                return Object.freeze({
                  async runWithAccessTokenOnce(_i, consumer) {
                    const loan = { accessToken: TOKEN };
                    try { return Object.freeze({ ok: true, grant_generation: 1, value: await consumer(loan) }); }
                    finally { try { loan.accessToken = null; } catch { /* */ } }
                  },
                });
              },
            });
          }
        } catch { /* */ }
        return exp;
      };
      const mutantComp = require('./lib/email-outbound-sunset-staging-runtime-composition');
      const mutantProof = await runProductionCompositionForcedLoss(mutantComp.createSunsetStagingEmailOutboundDispatch);
      mutantCaught = mutantProof.ok === false && sentinelHits > 0;
    } catch { mutantCaught = sentinelHits > 0; }
    finally { Module._load = loadOrig; delete require.cache[accessAbs]; delete require.cache[COMP_ABS]; }
    const modClean = require('./lib/email-outbound-sunset-staging-runtime-composition');
    ok('mutant owner-path resistance: decisive proof rejects sentinel access-session path',
      mutantCaught === true && typeof modClean.createSunsetStagingEmailOutboundDispatch === 'function');
    ok('post-mutant restore production composition',
      (await runProductionCompositionForcedLoss(modClean.createSunsetStagingEmailOutboundDispatch)).ok === true);

    // Route gates + audit truth
    const {
      createStaffEmailInboxRoutes, ENV_DRAFTS_ENABLED, ENV_OUTBOUND_ENABLED, ENV_SEND_ENABLED,
      ENV_COMPOSITION_ENABLED: ENV_COMP, ENV_PORTAL_ORIGIN, snapshotGateEnv, mapDispatchToRoute,
      isEmailOutboundRuntimeCompositionEnabled: routeCompFlag, SEND_PUBLIC_CODES,
    } = require('./lib/staff-email-inbox-routes');
    const routeEnv = (extra = {}) => Object.freeze(Object.assign(Object.create(null), {
      [ENV_DRAFTS_ENABLED]: 'true', [ENV_OUTBOUND_ENABLED]: 'true', [ENV_SEND_ENABLED]: 'false',
      [ENV_COMP]: 'false', [ENV_PORTAL_ORIGIN]: ORIGIN,
    }, extra));
    ok('route composition flag exact', !routeCompFlag({}) && !routeCompFlag({ [ENV_COMP]: 'TRUE' }) && routeCompFlag({ [ENV_COMP]: 'true' }));

    let mapOk = SEND_PUBLIC_CODES.length === 5;
    for (const c of [
      { result: { ok: true, code: 'email_send_committed' }, status: 200, bodySuccess: true, audit: true },
      { result: { ok: false, code: 'email_send_outcome_unknown' }, status: 503, bodySuccess: false, audit: false },
      { result: { ok: false, code: 'email_send_recovery' }, status: 503, bodySuccess: false, audit: false },
      { result: { ok: false, code: 'email_send_reauthorization_required' }, status: 503, bodySuccess: false, audit: false },
      { result: { ok: false, code: 'email_send_unavailable' }, status: 503, bodySuccess: false, audit: false },
      { result: { ok: true, code: 'email_send_outcome_unknown' }, status: 503, bodySuccess: false, audit: false },
      { result: { ok: false, code: 'not_a_public_code' }, status: 503, bodySuccess: false, audit: false, code: 'email_send_unavailable' },
    ]) {
      const m = mapDispatchToRoute(c.result, V, A);
      const expectCode = c.code || c.result.code;
      const deliveryCommitted = m.code === 'email_send_committed' && m.status === 200 && m.body && m.body.success === true;
      if (m.status !== c.status || m.body.success !== c.bodySuccess || m.code !== expectCode
          || deliveryCommitted !== c.audit || m.approved !== true || !noLeak(m.body)) mapOk = false;
    }
    ok('mapDispatchToRoute every public code + audit-commit rule', mapOk);

    const durableAppr = new Map();
    let endpointOutbound = true; let commitReject = false; let constructHits = 0; let dispatchHits = 0;
    let outerLoans = 0; let outerReleases = 0; const audits = [];
    function makePg() {
      return async function withPgClient(fn) {
        outerLoans += 1;
        const client = { async query(sql, params) {
          const n = String(sql).replace(/\s+/g, ' ').trim();
          if (n === 'BEGIN' || n === 'ROLLBACK') return { rows: [] };
          if (n === 'COMMIT') { if (commitReject) throw new Error(PLANTED + '_commit'); return { rows: [] }; }
          if (/FROM clients cl/.test(n)) {
            return { rows: [{
              conversation_id: V, client_id: C, location_id: L, location_key: K, endpoint_id: E,
              source_inbound_event_id: '66666666-6666-4666-8666-666666666666', provider: 'microsoft_graph',
              provider_mailbox_id: M, provider_source_message_id: SRC, endpoint_outbound_enabled: endpointOutbound,
              public_address: M, actor_staff_user_id: A,
            }] };
          }
          if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
            const approvalId = String(params[0]).toLowerCase();
            const row = {
              approval_id: approvalId, operation_id: String(params[1]).toLowerCase(), client_id: C, location_id: L,
              location_key: K, endpoint_id: E, conversation_id: V,
              source_inbound_event_id: '66666666-6666-4666-8666-666666666666', provider: 'microsoft_graph',
              provider_mailbox_id: M, provider_source_message_id: SRC,
              message_text: String(params[11]), body_digest: String(params[12]), state: 'draft',
            };
            durableAppr.set(approvalId, row);
            return { rows: [{ approval_id: approvalId, message_text: row.message_text, conversation_id: V }] };
          }
          if (/FOR UPDATE/.test(n)) {
            const row = durableAppr.get(String(params[0]).toLowerCase());
            return row ? { rows: [{ ...row }] } : { rows: [] };
          }
          if (/state='approved'/.test(n)) {
            const row = durableAppr.get(String(params[0]).toLowerCase());
            if (!row || row.state !== 'draft' || row.message_text !== String(params[5])) return { rows: [] };
            row.state = 'approved';
            return { rows: [{ approval_id: row.approval_id, conversation_id: V, message_text: row.message_text, state: 'approved' }] };
          }
          return { rows: [] };
        } };
        try { return await fn(client); } finally { outerReleases += 1; }
      };
    }
    const capture = () => { const calls = []; return { calls, sendJSON(_r, s, b) { calls.push({ status: s, body: b }); return b; } }; };
    const mockReq = (body) => {
      const ee = new EventEmitter();
      Object.defineProperty(ee, 'headers', { value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }), enumerable: true });
      process.nextTick(() => { ee.emit('data', Buffer.from(JSON.stringify(body))); ee.emit('end'); });
      return ee;
    };
    const user = { staff_user_id: A, client_id: C, role: 'operator', status: 'active' };
    const send = capture();
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON, withPgClient: makePg(), appendAuditLog: (e) => audits.push(e),
      createOutboundDispatch() { constructHits += 1; throw new Error('no'); },
      outboundDispatch: async () => { dispatchHits += 1; return { ok: false, code: 'email_send_unavailable' }; },
      runtimeEnv: routeEnv(),
    });
    async function draftApprove(envExtra, hooks = {}) {
      const gate = snapshotGateEnv(routeEnv(envExtra));
      send.calls.length = 0;
      await routes.handleDraft(mockReq({ conversation_id: V, message_text: BODY, approval_id: null }), {}, user, gate);
      const ap = send.calls[0].body.approval_id; send.calls.length = 0;
      if (hooks.beforeApprove) hooks.beforeApprove();
      await routes.handleApproveSend(mockReq({ conversation_id: V, message_text: BODY, approval_id: ap }), {}, user, gate);
      return ap;
    }
    await draftApprove({});
    const aDis = audits.filter((a) => a.category === 'email_inbox_approve_send').slice(-1)[0];
    ok('flags off → approved disabled; audit success false',
      send.calls[0].status === 503 && send.calls[0].body.error === 'email_send_disabled'
      && send.calls[0].body.approval_state === 'approved' && constructHits === 0 && dispatchHits === 0
      && aDis && aDis.success === false && aDis.code === 'email_send_disabled' && noLeak(aDis));
    await draftApprove({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'false' });
    ok('send true composition false → zero construct', send.calls[0].body.error === 'email_send_disabled' && constructHits === 0);
    await draftApprove({ [ENV_SEND_ENABLED]: 'false', [ENV_COMP]: 'true' });
    ok('composition true send false → zero construct', send.calls[0].body.error === 'email_send_disabled' && constructHits === 0);
    await draftApprove({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' }, { beforeApprove() { commitReject = true; } });
    commitReject = false;
    ok('COMMIT reject → zero dispatch', (send.calls[0].status === 500 || send.calls[0].status === 503) && constructHits === 0 && noLeak(send.calls[0]));
    endpointOutbound = false;
    const apEp = await draftApprove({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' });
    endpointOutbound = true;
    ok('endpoint false → no CAS zero construct', send.calls[0].body.error === 'email_send_disabled' && durableAppr.get(apEp).state === 'draft' && constructHits === 0);

    let routeAuditOk = true;
    for (const ac of [
      { dispatch: { ok: true, code: 'email_send_committed' }, auditSuccess: true, http: 200 },
      { dispatch: { ok: false, code: 'email_send_outcome_unknown' }, auditSuccess: false, http: 503 },
      { dispatch: { ok: false, code: 'email_send_recovery' }, auditSuccess: false, http: 503 },
      { dispatch: { ok: false, code: 'email_send_reauthorization_required' }, auditSuccess: false, http: 503 },
      { dispatch: { ok: false, code: 'email_send_unavailable' }, auditSuccess: false, http: 503 },
    ]) {
      const sendA = capture(); const auditsA = [];
      const routesA = createStaffEmailInboxRoutes({
        sendJSON: sendA.sendJSON, withPgClient: makePg(), appendAuditLog: (e) => auditsA.push(e),
        outboundDispatch: async () => Object.freeze({ ...ac.dispatch }),
        runtimeEnv: routeEnv({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' }),
      });
      const gateA = snapshotGateEnv(routeEnv({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' }));
      await routesA.handleDraft(mockReq({ conversation_id: V, message_text: BODY, approval_id: null }), {}, user, gateA);
      const apA = sendA.calls[0].body.approval_id; sendA.calls.length = 0; auditsA.length = 0;
      await routesA.handleApproveSend(mockReq({ conversation_id: V, message_text: BODY, approval_id: apA }), {}, user, gateA);
      const a = auditsA.find((x) => x.category === 'email_inbox_approve_send');
      if (!a || a.success !== ac.auditSuccess || a.code !== ac.dispatch.code
          || sendA.calls[0].status !== ac.http || durableAppr.get(apA).state !== 'approved'
          || !noLeak(a) || !noLeak(sendA.calls[0].body)) routeAuditOk = false;
    }
    ok('route audit success only for email_send_committed; other codes success=false; approval may persist', routeAuditOk);

    let loanDuring = false;
    const send2 = capture();
    const routes2 = createStaffEmailInboxRoutes({
      sendJSON: send2.sendJSON, withPgClient: makePg(),
      outboundDispatch: async (s) => {
        loanDuring = outerLoans > outerReleases;
        assert.equal(s.provider_source_message_id, SRC);
        assert.equal(s.message_text, BODY);
        assert.equal('accessToken' in s, false);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
      runtimeEnv: routeEnv({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' }),
    });
    const gate2 = snapshotGateEnv(routeEnv({ [ENV_SEND_ENABLED]: 'true', [ENV_COMP]: 'true' }));
    await routes2.handleDraft(mockReq({ conversation_id: V, message_text: BODY, approval_id: null }), {}, user, gate2);
    const ap6 = send2.calls[0].body.approval_id; send2.calls.length = 0;
    const lb = outerLoans; const rb = outerReleases;
    await routes2.handleApproveSend(mockReq({ conversation_id: V, message_text: BODY, approval_id: ap6 }), {}, user, gate2);
    ok('dispatch under outer loan; committed sanitized 200; mirror uses one later loan',
      loanDuring && send2.calls[0].status === 200 && send2.calls[0].body.success === true
      && send2.calls[0].body.approval_state === 'approved' && !('body_digest' in send2.calls[0].body)
      && !('immutable_draft_id' in send2.calls[0].body) && outerLoans === lb + 2 && outerReleases === rb + 2
      && noLeak(send2.calls[0].body));

    const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
    const routeSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');
    const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    const commitIdx = routeSrc.indexOf("await pg.query('COMMIT')");
    const invokeIdx = routeSrc.indexOf('createOutboundDispatch(pg');
    const orderOk = /createEmailOutboundSendJournalStore/.test(compSrc)
      && /createDelegatedGrantAccessSession/.test(compSrc)
      && /createMicrosoftGraphReplyDraftTransport/.test(compSrc)
      && /createAuthorityBoundOutboundOperation/.test(compSrc)
      && /runAuthorityBoundOutbound/.test(compSrc)
      && commitIdx > 0 && invokeIdx > commitIdx
      && /createSunsetStagingEmailOutboundDispatch/.test(apiSrc)
      && /deliveryCommitted/.test(routeSrc)
      && !/EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED\s*=\s*true/.test(compSrc)
      && !/EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED\s*=\s*true/.test(compSrc);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('architecture order: post-COMMIT gates then lazy composition; owners journal→access→Graph→authority; hard-false preserved',
      orderOk && !!pkg.scripts['verify:email-outbound-sunset-staging-runtime-composition']
      && compSrc.split('\n').length <= 241);
  } finally { restore(); }
  console.log(`\n── verify:email-outbound-sunset-staging-runtime-composition ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
