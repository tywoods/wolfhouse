'use strict';
/** Gate 3 B2b offline verifier. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const {
  createMicrosoftPhaseBOauthOperationComposition, COMPLETION_KEYS: OP_KEYS,
  OUTCOME_UNKNOWN_ACK, DEPENDENCY_KEYS: OP_DEPS,
} = require('./lib/email-microsoft-phase-b-oauth-operation-composition');
const {
  createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime,
  EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED, EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION,
  EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE, CALLBACK_ENABLED_ENV, DEPENDENCY_KEYS: RT_DEPS,
  SUNSET_DEPLOYMENT, isCallbackEnabled,
} = require('./lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition');
const {
  SQL_CONSUME_PHASE_B_TRANSACTION, AUTHORIZATION_INTENT, SCOPE_VERSION, COMPLETION_KEYS: B2A_KEYS,
  PUBLIC_STATUS_RECEIVED, PUBLIC_STATUS_OUTCOME_UNKNOWN,
} = require('./lib/email-microsoft-phase-b-oauth-callback-completion');
const {
  createMicrosoftPhaseBVerifiedGrantReplacer, SQL_CAS_UPDATE: SQL_CAS,
} = require('./lib/email-microsoft-phase-b-verified-grant-replacer');
const {
  validateAndNormalizePhaseBTokenResponseScope, PHASE_B_REQUIRED_RESOURCE_SCOPES,
} = require('./lib/email-microsoft-phase-b-token-response-scope');
const { COMPLETION_KEYS: A_OP_KEYS } = require('./lib/email-microsoft-oauth-operation-composition');
const { SQL_CONSUME_TRANSACTION: PHASE_A_SQL, SCOPES: PHASE_A_SCOPES } = require('./lib/email-microsoft-oauth-transaction-service');
const {
  SUNSET_STAGING_TRUSTED_HOST, SUNSET_STAGING_VERSIONED_KEY_ID,
  ENV_COMPOSITION_ENABLED, ENV_TRUSTED_HOST, ENV_VERSIONED_KEY_ID,
} = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { createFakeEmailGrantEnvelopeProvider } = require('./lib/email-grant-envelope-fake-provider');
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TX = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TX2 = 'ffffffff-ffff-4fff-8fff-fffffffffffe';
const PRIOR_OP = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const MAIL = 'front@sunset.example';
const STATE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const VERIFIER = STATE; const NONCE = STATE;
const CODE = 'AuthCode-printable-1';
const REFRESH = 'rt-NEVER_LEAK-phase-b-b2b-aaaaaaaa';
const ACCESS = 'at-NEVER_LEAK-phase-b-b2b-bbbbbbbb';
const SECRET = 'client-secret-NEVER_LEAK-b2b';
const PHASE_B_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const PHASE_A_SCOPE = 'openid profile offline_access User.Read Mail.ReadBasic';
const KID = 'b2b-runtime-kid-1';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noLeak(v) {
  if (v == null) return true;
  let t; if (typeof v === 'string') t = v; else { try { t = JSON.stringify(v); } catch { t = String(v); } }
  return !t.includes(REFRESH) && !t.includes(ACCESS) && !t.includes(SECRET) && !t.includes(CODE);
}
function freezeExact(obj, keys) { const o = {}; for (const k of keys) o[k] = obj[k]; return Object.freeze(o); }
function b64(v) { return Buffer.from(JSON.stringify(v)).toString('base64url'); }
function createIdToken(patch = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { tid: TENANT, oid: PRINCIPAL, sub: 'subject-1', aud: APP, nonce: NONCE,
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, exp: now + 600, iat: now - 1, nbf: now - 1, ...patch };
  const si = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64(claims)}`;
  return `${si}.${crypto.sign('RSA-SHA256', Buffer.from(si), pair.privateKey).toString('base64url')}`;
}
function tokenBody(patch = {}) {
  return { token_type: 'Bearer', expires_in: 3600, scope: PHASE_B_SCOPE,
    access_token: ACCESS, refresh_token: REFRESH, id_token: createIdToken(), ...patch };
}
function azureEnv() {
  return { [ENV_COMPOSITION_ENABLED]: 'true', [ENV_TRUSTED_HOST]: SUNSET_STAGING_TRUSTED_HOST,
    [ENV_VERSIONED_KEY_ID]: SUNSET_STAGING_VERSIONED_KEY_ID };
}
function goodEnv(over = {}) {
  return { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, [CALLBACK_ENABLED_ENV]: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...azureEnv(), ...over };
}
function owner() { return freezeExact({ clientId: CLIENT, authSessionId: SESSION }, ['clientId', 'authSessionId']); }
function codeInput() { return freezeExact({ state: STATE, code: CODE }, ['state', 'code']); }
function phaseBRow(over = {}) {
  return { id: TX, location_id: LOCATION, staff_user_id: STAFF, code_verifier: VERIFIER, nonce: NONCE,
    endpoint_id: ENDPOINT, authorization_intent: AUTHORIZATION_INTENT, scope_version: SCOPE_VERSION,
    prior_grant_generation: '7', ...over };
}
function makeIncoming(statusCode, headers, body) {
  const incoming = new EventEmitter();
  incoming.statusCode = statusCode; incoming.headers = headers; incoming.destroy = () => {};
  queueMicrotask(() => { incoming.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))); incoming.emit('end'); });
  return incoming;
}
function installAzureSdkSpies() {
  const counters = { wrap: 0, unwrap: 0, mic: 0, idLoad: 0, kvLoad: 0, cc: 0 };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pad = crypto.constants.RSA_PKCS1_OAEP_PADDING;
  const wo = { key: publicKey, padding: pad, oaepHash: 'sha256' };
  const uo = { key: privateKey, padding: pad, oaepHash: 'sha256' };
  function makeClient(keyId) {
    return {
      keyId,
      async wrapKey(algorithm, key) {
        counters.wrap += 1;
        return { result: crypto.publicEncrypt(wo, Buffer.isBuffer(key) ? key : Buffer.from(key)), algorithm, keyID: keyId };
      },
      async unwrapKey(algorithm, encryptedKey) {
        counters.unwrap += 1;
        return { result: crypto.privateDecrypt(uo, Buffer.isBuffer(encryptedKey) ? encryptedKey : Buffer.from(encryptedKey)), algorithm, keyID: keyId };
      },
    };
  }
  function ManagedIdentityCredential(clientId) { counters.mic += 1; return Object.freeze({ kind: 'spy-mic', clientId }); }
  function CryptographyClient(keyId) { counters.cc += 1; return makeClient(keyId); }
  const realLoad = Module._load;
  Module._load = function interceptAzure(request, parent, isMain) {
    if (request === '@azure/identity') { counters.idLoad += 1; return { ManagedIdentityCredential, DefaultAzureCredential() { throw new Error('DAC'); } }; }
    if (request === '@azure/keyvault-keys') { counters.kvLoad += 1; return { CryptographyClient, KeyClient() { throw new Error('KC'); } }; }
    if (typeof request === 'string' && request.startsWith('@azure/')) throw new Error(`unexpected ${request}`);
    return realLoad(request, parent, isMain);
  };
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}@azure${path.sep}`) || key.includes('/@azure/')) delete require.cache[key];
  }
  return { counters, restore() { Module._load = realLoad; } };
}
/** B1-compatible durable row: canonical identity + contract-valid sealed envelope. */
function makeGrant(over = {}) {
  return {
    id: ENDPOINT, client_id: CLIENT, provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth', binding_status: 'verified', provider_tenant_id: TENANT,
    provider_principal_oid: PRINCIPAL, provider_resource_id: PRINCIPAL, public_address: MAIL,
    mailbox_kind: 'user', mailbox_access_kind: 'own_user', grant_generation: '7', grant_status: 'active',
    reconcile_state: 'clean', scope_version: 'phase_a_v2', grant_lease_token: null, grant_lease_owner: null,
    grant_lease_until: null, last_operation_id: PRIOR_OP, envelope_version: 'v1', aead_alg: 'AES-256-GCM',
    kek_wrap_alg: 'A256KW', kek_key_name: 'fake-luna-grant-kek', kek_key_version: 'v1-test-0001',
    nonce: crypto.randomBytes(12), ciphertext: crypto.randomBytes(48), auth_tag: crypto.randomBytes(16),
    wrapped_dek: crypto.randomBytes(40), ...over,
  };
}
const LOCK_K = ['id','client_id','provider','auth_mode','connector_mode','binding_status','provider_tenant_id','provider_principal_oid','provider_resource_id','public_address','mailbox_kind','mailbox_access_kind','grant_generation','grant_status','reconcile_state','scope_version','grant_lease_token','last_operation_id','envelope_version','aead_alg','kek_wrap_alg','kek_key_name','kek_key_version','nonce','ciphertext','auth_tag','wrapped_dek'];
const SNAP_K = ['grant_generation','grant_status','reconcile_state','scope_version','last_operation_id','grant_lease_token','grant_lease_owner','grant_lease_until','binding_status','provider_tenant_id','provider_principal_oid','provider_resource_id','public_address','envelope_version','aead_alg','kek_wrap_alg','kek_key_name','kek_key_version','nonce','ciphertext','auth_tag','wrapped_dek'];
const BUF = new Set(['nonce', 'ciphertext', 'auth_tag', 'wrapped_dek']);
function proj(src, keys) {
  const o = {}; for (const k of keys) o[k] = BUF.has(k) && Buffer.isBuffer(src[k]) ? Buffer.from(src[k]) : src[k]; return o;
}
function casPredicatesOk(src, params) {
  if (!params || params.length !== 15 || params[0] !== CLIENT || params[1] !== ENDPOINT) return false;
  if (String(params[14]) !== String(src.grant_generation)) return false;
  if (src.scope_version !== 'phase_a_v2' || src.grant_status !== 'active' || src.reconcile_state !== 'clean') return false;
  return src.grant_lease_token == null && src.grant_lease_owner == null && src.grant_lease_until == null;
}
function createPg(spec = {}) {
  const grant = makeGrant(spec.grantOver || {}); const row = phaseBRow(spec.rowOver || {});
  const counts = { query: 0, consume: 0, begin: 0, commit: 0, rollback: 0, lock: 0, cas: 0, snap: 0, casApplied: 0, sql: [], casSql: [], casParams: [] };
  let pending = null; const commitMode = spec.commitMode || 'ok';
  const client = {
    async query(sql, params) {
      counts.query += 1; const s = String(sql); counts.sql.push(s);
      if (s.includes("authorization_intent='phase_b_reauthorization'")) { counts.consume += 1; return { rows: spec.noRow ? [] : [row] }; }
      if (s === 'BEGIN') { counts.begin += 1; pending = null; return { rows: [] }; }
      if (s === 'ROLLBACK') { counts.rollback += 1; pending = null; return { rows: [] }; }
      if (s === 'COMMIT') {
        counts.commit += 1;
        if (commitMode === 'throw_no_apply') throw new Error('commit_ambiguous');
        if (pending) Object.assign(grant, pending); pending = null;
        if (commitMode === 'apply_then_throw') throw new Error('commit_ambiguous');
        return { rows: [] };
      }
      if (/FOR UPDATE/.test(s)) { counts.lock += 1; return { rows: [proj(pending || grant, LOCK_K)] }; }
      if (/UPDATE tenant_email_delegated_grants/.test(s)) {
        counts.cas += 1; counts.casSql.push(s); counts.casParams.push(params);
        const src = pending || grant;
        if (s !== SQL_CAS || !casPredicatesOk(src, params)) return { rows: [] };
        const b = (v) => (Buffer.isBuffer(v) ? Buffer.from(v) : v);
        pending = {
          ...src, grant_generation: String(params[2]), last_operation_id: params[3], scope_version: 'phase_b_v1',
          grant_status: 'active', reconcile_state: 'clean', grant_lease_token: null, grant_lease_owner: null, grant_lease_until: null,
          envelope_version: params[4], aead_alg: params[5], kek_wrap_alg: params[6], kek_key_name: params[7], kek_key_version: params[8],
          nonce: b(params[9]), ciphertext: b(params[10]), auth_tag: b(params[11]), wrapped_dek: b(params[12]),
        };
        counts.casApplied += 1;
        return { rows: [{ client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: pending.grant_generation,
          grant_status: 'active', reconcile_state: 'clean', scope_version: 'phase_b_v1', last_operation_id: params[3] }] };
      }
      if (/FROM tenant_email_delegated_grants g INNER JOIN/.test(s) || /g\.grant_generation/.test(s)) {
        counts.snap += 1; return { rows: [proj(grant, SNAP_K)] };
      }
      return { rows: [] };
    },
  };
  return { client, grant, counts, row };
}
function createHttps(spec = {}) {
  const calls = { token: 0, jwks: 0, graph: 0 };
  const httpsImpl = Object.freeze({
    request(opts, cb) {
      const host = (opts && (opts.hostname || opts.host)) || '';
      const method = (opts && opts.method) || 'GET'; const pth = (opts && opts.path) || '';
      const req = new EventEmitter();
      req.destroy = () => {}; req.setTimeout = () => {}; req.write = () => {};
      req.end = () => {
        queueMicrotask(() => {
          try {
            if (host.includes('login.microsoftonline.com') && method === 'POST' && /token/.test(pth)) {
              calls.token += 1;
              cb(makeIncoming(200, { 'content-type': 'application/json' },
                spec.tokenBody !== undefined ? spec.tokenBody : tokenBody(spec.tokenPatch || {})));
              return;
            }
            if (host.includes('login.microsoftonline.com') && /keys/.test(pth)) {
              calls.jwks += 1;
              cb(makeIncoming(200, { 'content-type': 'application/json' },
                JSON.stringify({ keys: [{ ...exportedJwk, kid: KID, use: 'sig', alg: 'RS256' }] })));
              return;
            }
            if (host === 'graph.microsoft.com') {
              calls.graph += 1;
              cb(makeIncoming(200, { 'content-type': 'application/json' },
                spec.graphBody || { id: PRINCIPAL, displayName: 'Front Desk', mail: MAIL, userPrincipalName: MAIL }));
              return;
            }
            req.emit('error', new Error(`unexpected ${host}`));
          } catch (err) { req.emit('error', err); }
        });
      };
      return req;
    },
  });
  return {
    httpsImpl,
    timers: Object.freeze({ setTimeout: (fn, ms) => setTimeout(fn, ms || 0), clearTimeout: (id) => clearTimeout(id) }),
    cryptoBound: Object.freeze({ createPublicKey: (...a) => crypto.createPublicKey(...a), verify: (...a) => crypto.verify(...a) }),
    calls,
  };
}
function stageCounter() {
  const stages = []; return { stages, stageTelemetry: Object.freeze({ emit(stage) { stages.push(stage); } }) };
}
function factoryDeps(env, pg, bundle, stageTelemetry) {
  const base = { env, pgClient: pg, https: bundle.httpsImpl, crypto: bundle.cryptoBound, timers: bundle.timers };
  if (stageTelemetry) base.stageTelemetry = stageTelemetry; return Object.freeze(base);
}
function snapWork(pg, bundle, azure, stages) {
  return { t: bundle.calls.token, j: bundle.calls.jwks, g: bundle.calls.graph,
    w: azure.counters.wrap, c: pg.counts.cas, l: pg.counts.lock, s: stages ? stages.length : 0 };
}
function sameWork(a, b) { return a.t === b.t && a.j === b.j && a.g === b.g && a.w === b.w && a.c === b.c && a.l === b.l && a.s === b.s; }
function goodCasParams(over = {}) {
  const p = [CLIENT, ENDPOINT, '8', TX, 'v1', 'AES-256-GCM', 'A256KW', 'fake-luna-grant-kek', 'v1-test-0001',
    crypto.randomBytes(12), crypto.randomBytes(48), crypto.randomBytes(16), crypto.randomBytes(40), STAFF, '7'];
  for (const [i, v] of Object.entries(over)) p[Number(i)] = v; return p;
}
async function casNeg(sql, params, grantOver) {
  const p = createPg({ grantOver }); const res = await p.client.query(sql, params);
  const gen = grantOver && grantOver.grant_generation != null ? String(grantOver.grant_generation) : '7';
  return res.rows.length === 0 && p.counts.casApplied === 0 && p.grant.grant_generation === gen;
}
(async function main() {
  ok('hard-false activation constants', EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED === false
    && EMAIL_MS_PHASE_B_CALLBACK_DEFERRED_ACTIVATION === true && EMAIL_MS_PHASE_B_CALLBACK_SAFE_FOR_RUNTIME_ROUTE === false);
  ok('runtime deps exact ordered natives only', [...RT_DEPS].join(',') === 'env,pgClient,https,crypto,timers');
  ok('op deps use replacer not installer', [...OP_DEPS].includes('replacer') && ![...OP_DEPS].includes('installer'));
  ok('B2a/op COMPLETION_KEYS exact 10 aligned', OP_KEYS.length === 10 && B2A_KEYS.length === 10 && OP_KEYS.join(',') === B2A_KEYS.join(','));
  ok('Phase B resources exact', PHASE_B_REQUIRED_RESOURCE_SCOPES.join(' ') === 'User.Read Mail.ReadWrite Mail.Send'
    && validateAndNormalizePhaseBTokenResponseScope(PHASE_B_SCOPE) !== null && validateAndNormalizePhaseBTokenResponseScope(PHASE_A_SCOPE) === null);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package verify script registered', pkg.scripts['verify:email-microsoft-phase-b-oauth-runtime-composition']
    === 'node scripts/verify-email-microsoft-phase-b-oauth-runtime-composition.js');
  {
    const probe = spawnSync(process.execPath, ['-e', `
      const path=require('path'); const root=${JSON.stringify(ROOT)};
      delete process.env.LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED;
      const rt=require(path.join(root,'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js'));
      const op=require(path.join(root,'scripts/lib/email-microsoft-phase-b-oauth-operation-composition.js'));
      if(rt.isCallbackEnabled(process.env)||rt.EMAIL_MS_PHASE_B_CALLBACK_RUNTIME_WIRED!==false) process.exit(2);
      if(typeof rt.createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime!=='function') process.exit(3);
      if(typeof op.createMicrosoftPhaseBOauthOperationComposition!=='function') process.exit(4);
      console.log('OK');
    `], { encoding: 'utf8', env: { ...process.env, LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: undefined } });
    ok('fresh-process import inert', probe.status === 0 && /OK/.test(probe.stdout || ''), (probe.stdout||'')+(probe.stderr||''));
  }

  {
    const bundle = createHttps(); const pg = createPg(); const azure = installAzureSdkSpies();
    try {
      let threw = false;
      try { createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv({ [CALLBACK_ENABLED_ENV]: 'false' }), pg.client, bundle)); }
      catch { threw = true; }
      ok('B flag false → fails closed', threw && pg.counts.query === 0 && bundle.calls.token === 0 && azure.counters.wrap === 0);
      threw = false;
      try { createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv({ LUNA_DEPLOYMENT: 'production' }), pg.client, bundle)); }
      catch { threw = true; }
      ok('wrong deployment → fails closed', threw && pg.counts.query === 0);
      threw = false;
      try {
        createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps({
          LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
          LUNA_EMAIL_OAUTH_CLIENT_ID: APP, LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET, ...azureEnv(),
        }, pg.client, bundle));
      } catch { threw = true; }
      ok('Phase A flag alone cannot construct B', threw && pg.counts.query === 0);
      threw = false;
      try {
        createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(Object.freeze({
          env: goodEnv(), pgClient: pg.client, https: bundle.httpsImpl, crypto: bundle.cryptoBag,
          timers: bundle.timers, completion: Object.freeze({ completeAuthorization: async () => ({ status: 'completed' }) }),
        }));
      } catch { threw = true; }
      ok('mutant completion DI rejected', threw);
      threw = false;
      try { createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(new Proxy(factoryDeps(goodEnv(), pg.client, bundle), {})); }
      catch { threw = true; }
      ok('proxy deps bag rejected', threw && pg.counts.cas === 0);
      const hits = { query: 0, request: 0, setT: 0, clearT: 0, cpk: 0, verify: 0 };
      function acc(o, k, n) { Object.defineProperty(o, k, { enumerable: true, get() { hits[n] += 1; return () => {}; } }); }
      const hPg = {}; acc(hPg, 'query', 'query');
      const hHttps = {}; acc(hHttps, 'request', 'request');
      const hT = {}; acc(hT, 'setTimeout', 'setT'); acc(hT, 'clearTimeout', 'clearT');
      const hC = {}; acc(hC, 'createPublicKey', 'cpk'); acc(hC, 'verify', 'verify');
      threw = false;
      try {
        createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(Object.freeze({
          env: goodEnv(), pgClient: hPg, https: Object.freeze(hHttps),
          crypto: Object.freeze(hC), timers: Object.freeze(hT),
        }));
      } catch { threw = true; }
      ok('hostile accessors zero execution', threw && hits.query === 0 && hits.request === 0
        && hits.setT === 0 && hits.clearT === 0 && hits.cpk === 0 && hits.verify === 0);
      let protoHits = 0;
      function ProtoHttps() {}
      ProtoHttps.prototype.request = function () { protoHits += 1; };
      threw = false;
      try {
        createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(Object.freeze({
          env: goodEnv(), pgClient: pg.client, https: new ProtoHttps(),
          crypto: bundle.cryptoBag, timers: bundle.timers,
        }));
      } catch { threw = true; }
      ok('inherited https.request rejected zero calls', threw && protoHits === 0);
      const gK = ['LUNA_DEPLOYMENT','LUNA_EMAIL_OAUTH_CLIENT_ID',CALLBACK_ENABLED_ENV,ENV_COMPOSITION_ENABLED,ENV_TRUSTED_HOST,ENV_VERSIONED_KEY_ID];
      let eH = 0; const oG = goodEnv();
      for (const k of gK) { const v = oG[k]; Object.defineProperty(oG, k, { enumerable: true, configurable: true, get() { eH += 1; return v; } }); }
      threw = false; try { createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(oG, pg.client, bundle)); } catch { threw = true; }
      ok('env own getters gate keys hits=0', threw && eH === 0 && pg.counts.query === 0 && bundle.calls.token === 0 && azure.counters.wrap === 0);
      eH = 0; const eP = {}; for (const k of gK) Object.defineProperty(eP, k, { enumerable: true, get() { eH += 1; return goodEnv()[k]; } });
      const iE = Object.create(eP); iE.LUNA_EMAIL_OAUTH_CLIENT_SECRET = SECRET;
      threw = false; try { createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(iE, pg.client, bundle)); } catch { threw = true; }
      ok('env inherited getters gate keys hits=0', threw && eH === 0 && pg.counts.query === 0);
    } finally { azure.restore(); }
  }

  {
    const pg = createPg(); const bundle = createHttps(); const azure = installAzureSdkSpies();
    const st = stageCounter();
    try {
      const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle, st.stageTelemetry));
      ok('construct without I/O', typeof runtime.accept === 'function' && pg.counts.query === 0
        && bundle.calls.token === 0 && azure.counters.wrap === 0);
      const ack = await runtime.accept(codeInput(), owner());
      ok('accept → authorization_received status-only',
        ack && ack.status === PUBLIC_STATUS_RECEIVED.status && Reflect.ownKeys(ack).length === 1 && noLeak(ack));
      ok('exact one consume/lock/CAS/commit', pg.counts.consume === 1 && pg.counts.cas === 1 && pg.counts.lock === 1
        && pg.counts.commit === 1 && pg.counts.rollback === 0 && pg.counts.casApplied === 1);
      ok('exact one token+JWKS+Graph identity seam', bundle.calls.token === 1 && bundle.calls.jwks === 1 && bundle.calls.graph === 1);
      ok('identity stage owner once (oidc+graph_identity)',
        st.stages.includes('oidc_verified') && st.stages.filter((s) => s === 'graph_identity_verified').length === 1);
      ok('KV seal once; N→N+1 phase_b_v1 op-bound', azure.counters.wrap === 1 && pg.grant.grant_generation === '8'
        && pg.grant.scope_version === 'phase_b_v1' && pg.grant.last_operation_id === TX);
      ok('B consume SQL intent present', SQL_CONSUME_PHASE_B_TRANSACTION.includes("authorization_intent='phase_b_reauthorization'")
        && pg.counts.sql.some((s) => s.includes('phase_b_reauthorization')));
      const cp = pg.counts.casParams[0];
      ok('CAS observed exact production SQL + param positions', pg.counts.casSql[0] === SQL_CAS && cp && cp.length === 15
        && cp[0] === CLIENT && cp[1] === ENDPOINT && String(cp[2]) === '8' && cp[3] === TX && String(cp[14]) === '7' && cp[13] === STAFF);
    } finally { azure.restore(); }
  }

  {
    const pg = createPg();
    const base = goodCasParams();
    const r = await pg.client.query(SQL_CAS, base);
    ok('CAS authentic SQL+state stages once', r.rows.length === 1 && pg.counts.casApplied === 1);
    ok('CAS wrong SQL (no generation WHERE) zero apply', await casNeg(SQL_CAS.replace(' AND grant_generation=$15::bigint', ''), base));
    ok('CAS wrong prior-gen param position zero apply', await casNeg(SQL_CAS, goodCasParams({ 14: '6' })));
    ok('CAS wrong client param zero apply', await casNeg(SQL_CAS, goodCasParams({ 0: ENDPOINT })));
    ok('CAS current state scope mismatch zero apply', await casNeg(SQL_CAS, base, { scope_version: 'phase_b_v1' }));
    ok('CAS leased state zero apply', await casNeg(SQL_CAS, base, { grant_lease_token: 'tok' }));
  }

  {
    {
      const pg = createPg(); const bundle = createHttps({ tokenPatch: { scope: PHASE_A_SCOPE } });
      const azure = installAzureSdkSpies();
      try {
        const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle));
        let failed = false; try { await runtime.accept(codeInput(), owner()); } catch { failed = true; }
        ok('Phase A scope → fail closed zero CAS', failed && pg.counts.cas === 0 && azure.counters.wrap === 0);
      } finally { azure.restore(); }
    }
    {
      const pg = createPg();
      const bundle = createHttps({ graphBody: { id: '99999999-9999-4999-8999-999999999999', displayName: 'X', mail: MAIL, userPrincipalName: MAIL } });
      const azure = installAzureSdkSpies();
      try {
        const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle));
        let failed = false; try { await runtime.accept(codeInput(), owner()); } catch { failed = true; }
        ok('principal mismatch → zero CAS', failed && pg.counts.cas === 0);
      } finally { azure.restore(); }
    }
    {
      const pg = createPg({ grantOver: { public_address: 'other@sunset.example' } });
      const bundle = createHttps(); const azure = installAzureSdkSpies();
      try {
        const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle));
        let failed = false; try { await runtime.accept(codeInput(), owner()); } catch { failed = true; }
        ok('mailbox mismatch → zero CAS no rebind', failed && pg.counts.cas === 0 && pg.grant.grant_generation === '7');
      } finally { azure.restore(); }
    }
    {
      const pg = createPg({ commitMode: 'apply_then_throw' });
      const bundle = createHttps(); const azure = installAzureSdkSpies(); const st = stageCounter();
      try {
        const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle, st.stageTelemetry));
        const ack = await runtime.accept(codeInput(), owner());
        ok('A apply+loss → outcome_unknown',
          ack && ack.status === PUBLIC_STATUS_OUTCOME_UNKNOWN.status && Reflect.ownKeys(ack).length === 1 && noLeak(ack));
        ok('A no rollback post-COMMIT; one seal/CAS/token/identity', pg.counts.rollback === 0 && pg.counts.commit === 1
          && pg.counts.cas === 1 && bundle.calls.token === 1 && bundle.calls.jwks === 1 && bundle.calls.graph === 1
          && azure.counters.wrap === 1 && st.stages.filter((s) => s === 'graph_identity_verified').length === 1);
        const before = snapWork(pg, bundle, azure, st.stages);
        const rec = await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: pg.client }))
          .reconcileReplacement(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT, operationId: TX, expectedPriorGrantGeneration: '7' }));
        const after = snapWork(pg, bundle, azure, st.stages);
        ok('A recon advanced N+1; no second token/JWKS/Graph/seal/CAS', rec.advanced === true && rec.grantGeneration === '8'
          && rec.lastOperationId === TX && rec.scopeVersion === 'phase_b_v1' && rec.grantStatus === 'active'
          && rec.reconcileState === 'clean' && sameWork(before, after) && after.t === 1 && after.j === 1 && after.g === 1 && after.w === 1 && after.c === 1);
      } finally { azure.restore(); }
    }
    {
      const pg = createPg({ commitMode: 'throw_no_apply' });
      const bundle = createHttps(); const azure = installAzureSdkSpies(); const st = stageCounter();
      try {
        const runtime = createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(factoryDeps(goodEnv(), pg.client, bundle, st.stageTelemetry));
        const ack = await runtime.accept(codeInput(), owner());
        ok('B no-apply+loss → outcome_unknown', ack && ack.status === PUBLIC_STATUS_OUTCOME_UNKNOWN.status && noLeak(ack));
        ok('B durable prior; no rollback post-COMMIT', pg.grant.grant_generation === '7' && pg.grant.scope_version === 'phase_a_v2'
          && pg.grant.last_operation_id === PRIOR_OP && pg.counts.rollback === 0 && pg.counts.commit === 1);
        const before = snapWork(pg, bundle, azure, st.stages);
        const rec = await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: pg.client }))
          .reconcileReplacement(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT, operationId: TX, expectedPriorGrantGeneration: '7' }));
        const after = snapWork(pg, bundle, azure, st.stages);
        ok('B recon stillPrior not advanced; no second work', rec.advanced === false && rec.stillPrior === true
          && rec.grantGeneration === '7' && sameWork(before, after) && ack.status !== PUBLIC_STATUS_RECEIVED.status);
      } finally { azure.restore(); }
    }
    {
      const recG = await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({
        client: createPg({ grantOver: { grant_generation: '9', scope_version: 'phase_b_v1', last_operation_id: TX } }).client,
      })).reconcileReplacement(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT, operationId: TX, expectedPriorGrantGeneration: '7' }));
      ok('conflicting generation does not advance', recG.advanced === false && recG.grantGeneration === '9');
      const recO = await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({
        client: createPg({ grantOver: { grant_generation: '8', scope_version: 'phase_b_v1', last_operation_id: TX2 } }).client,
      })).reconcileReplacement(Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT, operationId: TX, expectedPriorGrantGeneration: '7' }));
      ok('conflicting operation does not advance', recO.advanced === false && recO.lastOperationId === TX2);
    }
    {
      let failed = false;
      try {
        createMicrosoftPhaseBOauthOperationComposition(new Proxy(Object.freeze({
          verifiedIdentity: Object.freeze({ async verifyIdentity() { return null; } }),
          envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
          clock: Object.freeze({ nowEpochSeconds() { return 1; } }),
          replacer: Object.freeze({ async replaceVerifiedGrant() { return OUTCOME_UNKNOWN_ACK; } }),
          transportDeps: Object.freeze({ httpsImpl: Object.freeze({ request() {} }), timers: Object.freeze({ setTimeout, clearTimeout }) }),
          secretProvider: Object.freeze({ async getClientSecret() { return SECRET; } }),
        }), {}));
      } catch (e) { failed = true; ok('op proxy failure sanitized', noLeak(e) && e && e.code); }
      ok('proxy deps rejected at op factory', failed);
      {
        const ch = { s: 0, r: 0, x: 0, v: 0 };
        const mk = (secretFn, reqFn) => createMicrosoftPhaseBOauthOperationComposition(Object.freeze({
          verifiedIdentity: Object.freeze({ async verifyIdentity() { ch.v += 1; return null; } }),
          envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
          clock: Object.freeze({ nowEpochSeconds() { return 1; } }),
          replacer: Object.freeze({ async replaceVerifiedGrant() { ch.x += 1; return OUTCOME_UNKNOWN_ACK; } }),
          transportDeps: Object.freeze({ httpsImpl: Object.freeze({ request: reqFn || (() => { ch.r += 1; throw new Error('n'); }) }),
            timers: Object.freeze({ setTimeout, clearTimeout }) }),
          secretProvider: Object.freeze({ getClientSecret: secretFn || (async () => { ch.s += 1; return SECRET; }) }),
        }));
        const vals = { authorizationCode: CODE, transactionId: TX, clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
          staffUserId: STAFF, codeVerifier: VERIFIER, nonce: NONCE, applicationClientId: APP, expectedPriorGrantGeneration: '7' };
        const mutable = {}; for (const k of OP_KEYS) mutable[k] = vals[k];
        let f = false; try { await mk().completeAuthorization(mutable); } catch (e) { f = true; ok('mutable completion sanitized', noLeak(e) && e.code); }
        ok('mutable completion zero child calls', f && ch.s === 0 && ch.r === 0 && ch.x === 0 && ch.v === 0);
        let cH = 0; const boom = new Error('planted');
        Object.defineProperty(boom, 'code', { enumerable: true, get() { cH += 1; return 'PLANTED_LEAK'; } });
        const fin = Object.freeze({ ...vals }); let c = null;
        try { await mk(async () => { throw boom; }).completeAuthorization(fin); } catch (e) { c = e; }
        ok('thrown error code getter zero access/leak', c && cH === 0 && noLeak(c) && c.code === 'MICROSOFT_PHASE_B_OAUTH_OPERATION_COMPOSITION_INVALID'
          && !String(c.message || '').includes('PLANTED'));
        let pH = 0; const pErr = new Proxy(new Error('px'), { get(t, p, r) { pH += 1; return Reflect.get(t, p, r); } });
        c = null; try { await mk(async () => { throw pErr; }).completeAuthorization(fin); } catch (e) { c = e; }
        ok('thrown proxy error zero traps/leak', c && pH === 0 && noLeak(c) && c.code === 'MICROSOFT_PHASE_B_OAUTH_OPERATION_COMPOSITION_INVALID');
      }
    }
  }

console.log('\n== Mutant owner seam ==');
  {
    const mutant = spawnSync(process.execPath, ['-e', `
      const path=require('path'),Module=require('module'),crypto=require('crypto'),root=${JSON.stringify(ROOT)};
      let load=0,exportHit=0,factory=0; const real=Module._load;
      const {publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
      const wo={key:publicKey,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'};
      function MIC(id){return Object.freeze({kind:'spy',clientId:id});}
      function CC(keyId){return {keyId,async wrapKey(a,k){return {result:crypto.publicEncrypt(wo,Buffer.isBuffer(k)?k:Buffer.from(k)),algorithm:a,keyID:keyId};},async unwrapKey(){throw new Error('u');}};}
      Module._load=function(req,p,m){
        if(req==='@azure/identity') return {ManagedIdentityCredential:MIC,DefaultAzureCredential(){throw new Error('DAC');}};
        if(req==='@azure/keyvault-keys') return {CryptographyClient:CC,KeyClient(){throw new Error('KC');}};
        if(String(req||'').includes('email-microsoft-phase-b-verified-grant-replacer')){
          load+=1;
          const factoryFn=function(){factory+=1;throw new Error('sentinel');};
          const custodyFn=function(){throw new Error('sentinel');};
          return {
            get createMicrosoftPhaseBVerifiedGrantReplacer(){exportHit+=1;return factoryFn;},
            get createMicrosoftPhaseBVerifiedGrantCustodyAdapter(){exportHit+=1;return custodyFn;},
            OUTCOME_UNKNOWN:'outcome_unknown',SEALED_ACK:Object.freeze({status:'accepted'}),
            CONFIG_KEYS:Object.freeze(['clientId','endpointId','operationId','actorStaffUserId',
              'expectedNonce','expectedClientId','expectedPriorGrantGeneration']),
          };
        }
        return real(req,p,m);
      };
      const rt=require(path.join(root,'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js'));
      const kv=require(path.join(root,'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js'));
      if(factory!==0){console.log('FAIL import_invoked_factory');process.exit(3);}
      const env={LUNA_DEPLOYMENT:'sunset-staging',LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED:'true',
        LUNA_EMAIL_OAUTH_CLIENT_ID:${JSON.stringify(APP)},LUNA_EMAIL_OAUTH_CLIENT_SECRET:'x'};
      env[kv.ENV_COMPOSITION_ENABLED]='true';env[kv.ENV_TRUSTED_HOST]=kv.SUNSET_STAGING_TRUSTED_HOST;
      env[kv.ENV_VERSIONED_KEY_ID]=kv.SUNSET_STAGING_VERSIONED_KEY_ID;
      let threw=false;
      try{
        rt.createSunsetStagingMicrosoftPhaseBOauthCallbackRuntime(Object.freeze({
          env,pgClient:Object.freeze({query:async()=>({rows:[]})}),
          https:Object.freeze({request(){throw new Error('x');}}),
          crypto:Object.freeze({createPublicKey(){},verify(){}}),
          timers:Object.freeze({setTimeout(){},clearTimeout(){}}),
        }));
      }catch{threw=true;}
      if(!threw||factory!==1||load<1){console.log('FAIL load='+load+' exportHit='+exportHit+' factory='+factory);process.exit(2);}
      console.log('OK load='+load+' exportHit='+exportHit+' factory='+factory);
    `], { encoding: 'utf8' });
    ok('mutant factoryInvocation===1; import alone insufficient',
      mutant.status === 0 && /OK load=\d+ exportHit=\d+ factory=1/.test(mutant.stdout || ''), (mutant.stdout||'')+(mutant.stderr||''));
  }

  ok('Phase A SCOPES Mail.ReadBasic', /Mail\.ReadBasic/.test(PHASE_A_SCOPES) && !/Mail\.Send/.test(PHASE_A_SCOPES));
  ok('Phase A completion keys 9', A_OP_KEYS.length === 9 && !A_OP_KEYS.includes('expectedPriorGrantGeneration'));
  ok('B consume SQL distinct from Phase A', SQL_CONSUME_PHASE_B_TRANSACTION !== PHASE_A_SQL && !PHASE_A_SQL.includes('phase_b_reauthorization'));
  ok('isCallbackEnabled exact B flag', isCallbackEnabled({ [CALLBACK_ENABLED_ENV]: 'true' }) === true
    && isCallbackEnabled({ [CALLBACK_ENABLED_ENV]: 'TRUE' }) === false
    && isCallbackEnabled({ LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true' }) === false);
  {
    // Non-txn Phase A owners byte-identical; txn is intent-hardened (B3a1) — semantic only.
    const phaseAFiles = [
      'scripts/lib/email-microsoft-oauth-callback-completion.js',
      'scripts/lib/email-microsoft-oauth-operation-composition.js',
      'scripts/lib/email-microsoft-oauth-sunset-staging-runtime-composition.js',
    ];
    let allSame = true;
    for (const f of phaseAFiles) {
      if (spawnSync('git', ['diff', '--quiet', '7fbaf613981c5fccb0d02193cb7f4f41c0fd8dda', '--', f], { cwd: ROOT }).status !== 0) allSame = false;
    }
    const txn = require('./lib/email-microsoft-oauth-transaction-service');
    const sql = PHASE_A_SQL;
    const txnSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-microsoft-oauth-transaction-service.js'), 'utf8');
    ok('Phase A non-txn byte-identical; txn scopes/API/SQL intent/no-B',
      allSame
      && PHASE_A_SCOPES === 'openid profile offline_access User.Read Mail.ReadBasic'
      && !/Mail\.Send|Mail\.ReadWrite/.test(PHASE_A_SCOPES)
      && typeof txn.createMicrosoftOAuthTransactionService === 'function'
      && typeof txn.createMicrosoftOAuthCallbackService === 'function'
      && typeof txn.createPostgresOAuthTransactionRepository === 'function'
      && typeof txn.isStartEnabled === 'function' && typeof txn.isCallbackEnabled === 'function'
      && /RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id\s*$/.test(sql)
      && !/RETURNING[^;]*(authorization_intent|scope_version|prior_grant_generation)/.test(sql)
      && /state_hash=\$1::bytea/.test(sql) && /client_id=\$2::uuid/.test(sql)
      && /auth_session_id=\$3::uuid/.test(sql) && /consumed_at IS NULL/.test(sql)
      && /expires_at>\$4/.test(sql) && /authorization_intent='initial_connect'/.test(sql)
      && /scope_version='phase_a_v2'/.test(sql) && /prior_grant_generation IS NULL/.test(sql)
      && !/phase_b_reauthorization|phase_b_v1/.test(sql)
      && !/phase-b-verified-grant-replacer|phase-b-oauth|staff-email-oauth-routes|staff-query-api/.test(txnSrc)
      && !/require\([^)]*phase-b/.test(txnSrc) && !/\bexpress\b|\bcreateServer\b|\blisten\s*\(/.test(txnSrc)
      && Object.keys(txn).sort().join(',') === 'AUTHORITY,CALLBACK_CODE_KEYS,CALLBACK_ERROR_KEYS,INPUT_KEYS,OWNER_KEYS,REDIRECT_URI,SCOPES,SQL_CONSUME_TRANSACTION,SQL_CREATE_TRANSACTION,START_ENDPOINT_ID_KEY_INDEX,TTL_SECONDS,createMicrosoftOAuthCallbackService,createMicrosoftOAuthTransactionService,createPostgresOAuthTransactionRepository,isCallbackEnabled,isStartEnabled,validateRuntime');
    const sfs = ['scripts/lib/email-microsoft-phase-b-oauth-operation-composition.js',
      'scripts/lib/email-microsoft-phase-b-oauth-sunset-staging-runtime-composition.js'];
    const vf = 'scripts/verify-email-microsoft-phase-b-oauth-runtime-composition.js';
    const srcLoc = sfs.reduce((n, f) => n + fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).length, 0);
    const verLoc = fs.readFileSync(path.join(ROOT, vf), 'utf8').split(/\r?\n/).length;
    ok(`budget source=${srcLoc} <=450`, srcLoc <= 450);
    ok(`budget verifier=${verLoc} <=630`, verLoc <= 630);
    ok(`budget total=${srcLoc + verLoc} <=1080`, srcLoc + verLoc <= 1080);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
