'use strict';
/**
 * Gate 3 Phase B PR B1 — dormant authority + atomic replacement offline verifier.
 * Schema (PGlite optional; stock-PG optional SKIP), scopes, reauth TX, custody/replacer.
 * Never claims multi-session race on single-session PGlite without explicit SKIP.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const UP071 = fs.readFileSync(path.join(ROOT, 'database/migrations/071_tenant_email_phase_b_authority.sql'), 'utf8');
const DOWN071 = fs.readFileSync(path.join(ROOT, 'database/migrations/071_tenant_email_phase_b_authority_down.sql'), 'utf8');
const {
  validateAndNormalizePhaseBTokenResponseScope,
  PHASE_B_REQUIRED_RESOURCE_SCOPES,
  PHASE_B_TOKEN_SCOPE_ORDER,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./lib/email-microsoft-phase-b-token-response-scope');
const {
  AUTHORIZATION_INTENT,
  SCOPE_VERSION,
  PHASE_B_SCOPES,
  INPUT_KEYS,
  START_ENABLED_ENV,
  SQL_CREATE_PHASE_B_REAUTH,
  isStartEnabled,
  createPostgresPhaseBReauthTransactionRepository,
  createMicrosoftPhaseBReauthorizationTransactionService,
  asCanonGen,
} = require('./lib/email-microsoft-phase-b-reauthorization-transaction-service');
const {
  createMicrosoftPhaseBVerifiedGrantReplacer,
  createMicrosoftPhaseBVerifiedGrantCustodyAdapter,
  ERROR_CODE: REPLACER_ERR,
  CUSTODY_ERROR_CODE: CUSTODY_ERR,
  REPLACED_STATUS,
  OUTCOME_UNKNOWN,
  REPLACE_KEYS,
  ACK_KEYS,
  envelopeFingerprintEqual,
  fingerprintEnvelopeFromRow,
  SQL_CAS_UPDATE,
  SQL_LOCK,
  SEALED_ACK,
  CONFIG_KEYS,
  asCanonGen: asGen,
  genPlus1,
  GEN_MAX,
} = require('./lib/email-microsoft-phase-b-verified-grant-replacer');
const {
  createFakeEmailGrantEnvelopeProvider,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  buildGrantEnvelopeAadV1,
} = require('./lib/email-grant-envelope-provider-contract');
const CONTRACT = require('./lib/email-microsoft-delegated-oauth-contract');
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OP = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OP2 = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const MAIL = 'front@sunset.example';
const TENANT2 = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL2 = '66666666-6666-4666-8666-666666666666';
const REFRESH_OLD = 'rt-OLD-NEVER_LEAK-phase-b-verify-aaaaaaaa';
const REFRESH_NEW = 'rt-NEW-NEVER_LEAK-phase-b-verify-bbbbbbbb';
const ACCESS = 'at-NEVER_LEAK-phase-b-verify-cccccccc';
const IDTOK = 'id.' + 'x'.repeat(80);
const PLANTED = 'NEVER_LEAK_secret_material';
const HUGE_N = '9007199254740992';
const HUGE_N1 = '9007199254740993';
let pass = 0;
let fail = 0;
let skips = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function skip(name, reason) {
  skips.push(`${name}: ${reason}`);
  console.log(`  SKIP  ${name} — ${reason}`);
}
function noLeak(v) {
  if (v == null) return true;
  let t;
  if (typeof v === 'string') t = v;
  else if (Buffer.isBuffer(v)) t = v.toString('utf8');
  else {
    try { t = JSON.stringify(v); } catch { t = String(v); }
  }
  if (typeof t !== 'string') t = String(t);
  return !t.includes(REFRESH_OLD) && !t.includes(REFRESH_NEW) && !t.includes(ACCESS)
    && !t.includes(PLANTED) && !/rt-OLD|rt-NEW|at-NEVER/.test(t);
}
function freezeExact(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return Object.freeze(o);
}
function buf12() { return crypto.randomBytes(12); }
function buf16() { return crypto.randomBytes(16); }
function bufN(n) { return crypto.randomBytes(n); }
function tryLoadPglite() {
  try { return require('@electric-sql/pglite').PGlite; } catch (_) { /* fall through */ }
  try {
    const Module = require('module');
    const paths = Module._nodeModulePaths(ROOT).concat([
      '/opt/data/wolfhouse-agent/node_modules',
      path.join(ROOT, 'node_modules'),
    ]);
    const resolved = require.resolve('@electric-sql/pglite', { paths });
    return require(resolved).PGlite;
  } catch (_) {
    return null;
  }
}
function stockPgAvailable() {
  return !!(process.env.DATABASE_URL || process.env.PGHOST || process.env.WH_DISPOSABLE_PG);
}
function makeIdentity(over) {
  return Object.freeze({
    providerTenantId: TENANT, providerPrincipalId: PRINCIPAL,
    mailboxAddress: MAIL, displayName: 'Front Desk', ...over,
  });
}
async function makeEnvelope(operationId, refreshToken, generation) {
  const provider = createFakeEmailGrantEnvelopeProvider();
  const aad = buildGrantEnvelopeAadV1({
    clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: generation, operationId,
  });
  return provider.sealGrantPayload({
    refresh_token: refreshToken, aad, operation_id: operationId,
  });
}
function cloneEnvRow(row) {
  return {
    envelope_version: row.envelope_version, aead_alg: row.aead_alg,
    kek_wrap_alg: row.kek_wrap_alg, kek_key_name: row.kek_key_name,
    kek_key_version: row.kek_key_version,
    nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext),
    auth_tag: Buffer.from(row.auth_tag), wrapped_dek: Buffer.from(row.wrapped_dek),
  };
}
function makeGrantState(overrides) {
  return {
    id: ENDPOINT, client_id: CLIENT, provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code', connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: TENANT, provider_principal_oid: PRINCIPAL,
    provider_resource_id: PRINCIPAL, public_address: MAIL,
    mailbox_kind: 'user', mailbox_access_kind: 'own_user',
    grant_generation: 3, grant_status: 'active', reconcile_state: 'clean',
    scope_version: 'phase_a_v2', grant_lease_token: null, grant_lease_owner: null,
    grant_lease_until: null, last_operation_id: OP,
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'fake-luna-grant-kek', kek_key_version: 'v1-test-0001',
    nonce: buf12(), ciphertext: bufN(48), auth_tag: buf16(), wrapped_dek: bufN(40),
    ...overrides,
  };
}
const LOCK_COLS = [
  'id', 'client_id', 'provider', 'auth_mode', 'connector_mode', 'binding_status',
  'provider_tenant_id', 'provider_principal_oid', 'provider_resource_id', 'public_address',
  'mailbox_kind', 'mailbox_access_kind',
  'grant_generation', 'grant_status', 'reconcile_state', 'scope_version',
  'grant_lease_token', 'last_operation_id',
  'envelope_version', 'aead_alg', 'kek_wrap_alg', 'kek_key_name', 'kek_key_version',
  'nonce', 'ciphertext', 'auth_tag', 'wrapped_dek',
];
const RET_COLS = [
  'client_id', 'endpoint_id', 'grant_generation', 'grant_status', 'reconcile_state',
  'scope_version', 'last_operation_id',
];
const SNAP_COLS = [
  'grant_generation', 'grant_status', 'reconcile_state', 'scope_version',
  'last_operation_id', 'grant_lease_token', 'grant_lease_owner', 'grant_lease_until',
  'binding_status', 'provider_tenant_id', 'provider_principal_oid', 'provider_resource_id',
  'public_address',
  'envelope_version', 'aead_alg', 'kek_wrap_alg', 'kek_key_name', 'kek_key_version',
  'nonce', 'ciphertext', 'auth_tag', 'wrapped_dek',
];
function ownDataRow(keys, values) {
  return Object.assign(Object.create(Object.prototype), Object.fromEntries(
    keys.map((k) => [k, values[k]]),
  ));
}
function createFakeReplacerClient(opts) {
  const state = opts.state || makeGrantState();
  const log = [];
  let commitFail = !!opts.commitFail;
  let updateFail = !!opts.updateFail;
  let lockMismatch = !!opts.lockMismatch;
  let returnMismatch = !!opts.returnMismatch;
  let rollbackThrows = !!opts.rollbackThrows;
  let began = false;
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: s, params });
      if (s === 'BEGIN') {
        began = true;
        if (opts.gateBegin) await opts.gateBegin();
        return { rows: [] };
      }
      if (s === 'COMMIT') {
        if (commitFail) { commitFail = false; throw new Error('forced_commit_failure'); }
        began = false; return { rows: [] };
      }
      if (s === 'ROLLBACK') {
        if (rollbackThrows) throw new Error('forced_rollback_failure');
        began = false; return { rows: [] };
      }
      if (s.includes('FOR UPDATE OF e, g')) {
        const row = { ...state, grant_generation: lockMismatch ? 999 : state.grant_generation };
        return { rows: [ownDataRow(LOCK_COLS, row)] };
      }
      if (s.startsWith('UPDATE tenant_email_delegated_grants')) {
        if (updateFail) return { rows: [] };
        const nextGen = params[2];
        const opId = params[3];
        const priorGen = params[14];
        if (asGen(state.grant_generation) !== asGen(priorGen)
            || state.scope_version !== 'phase_a_v2'
            || state.grant_status !== 'active'
            || state.reconcile_state !== 'clean'
            || state.grant_lease_token != null) {
          return { rows: [] };
        }
        state.grant_generation = nextGen;
        state.last_operation_id = opId;
        state.scope_version = 'phase_b_v1';
        state.envelope_version = params[4]; state.aead_alg = params[5];
        state.kek_wrap_alg = params[6]; state.kek_key_name = params[7];
        state.kek_key_version = params[8]; state.nonce = params[9];
        state.ciphertext = params[10]; state.auth_tag = params[11];
        state.wrapped_dek = params[12];
        const ret = {
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: returnMismatch ? genPlus1(nextGen) : nextGen,
          grant_status: 'active', reconcile_state: 'clean',
          scope_version: 'phase_b_v1', last_operation_id: opId,
        };
        return { rows: [ownDataRow(RET_COLS, ret)] };
      }
      if (s.includes('FROM tenant_email_delegated_grants g INNER JOIN')
          || s.startsWith('SELECT g.grant_generation')) {
        return { rows: [ownDataRow(SNAP_COLS, state)] };
      }
      throw new Error(`unexpected sql: ${s.slice(0, 80)}`);
    },
  };
  return { client, state, log, getBegan: () => began };
}
function createTxnAwareClient(opts) {
  const durable = opts.state || makeGrantState();
  let pending = null;
  let began = false;
  let commitFail = !!opts.commitFail;
  let updateEmpty = !!opts.updateEmpty;
  let returnBad = !!opts.returnBad;
  let rollbackThrows = !!opts.rollbackThrows;
  const log = [];
  const client = {
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ s, params });
      if (s === 'BEGIN') { began = true; pending = null; return { rows: [] }; }
      if (s === 'COMMIT') {
        if (commitFail) throw new Error('forced_commit_failure');
        if (pending) Object.assign(durable, pending);
        pending = null; began = false; return { rows: [] };
      }
      if (s === 'ROLLBACK') {
        if (rollbackThrows) throw new Error('forced_rollback_failure');
        pending = null; began = false; return { rows: [] };
      }
      if (s.includes('FOR UPDATE OF e, g')) {
        return { rows: [ownDataRow(LOCK_COLS, pending || durable)] };
      }
      if (s.startsWith('UPDATE tenant_email_delegated_grants')) {
        if (updateEmpty) return { rows: [] };
        const src = pending || durable;
        if (asGen(src.grant_generation) !== asGen(params[14])
            || src.scope_version !== 'phase_a_v2'
            || src.grant_status !== 'active'
            || src.reconcile_state !== 'clean'
            || src.grant_lease_token != null) {
          return { rows: [] };
        }
        pending = {
          ...src,
          grant_generation: params[2], last_operation_id: params[3],
          scope_version: 'phase_b_v1',
          envelope_version: params[4], aead_alg: params[5], kek_wrap_alg: params[6],
          kek_key_name: params[7], kek_key_version: params[8],
          nonce: params[9], ciphertext: params[10], auth_tag: params[11],
          wrapped_dek: params[12],
        };
        const ret = {
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: returnBad ? '999' : params[2],
          grant_status: 'active', reconcile_state: 'clean',
          scope_version: 'phase_b_v1', last_operation_id: params[3],
        };
        return { rows: [ownDataRow(RET_COLS, ret)] };
      }
      if (s.includes('FROM tenant_email_delegated_grants g INNER JOIN')
          || s.startsWith('SELECT g.grant_generation')) {
        return { rows: [ownDataRow(SNAP_COLS, durable)] };
      }
      throw new Error('unexpected');
    },
  };
  return { client, durable, log };
}
async function main() {
  console.log('verify:email-phase-b-authority — Gate 3 Phase B PR B1 offline\n');
  ok('071 up adds oauth intent/scope/prior + grant scope',
    /ADD COLUMN authorization_intent TEXT NULL/.test(UP071)
    && /ADD COLUMN scope_version TEXT NULL/.test(UP071)
    && /prior_grant_generation/.test(UP071)
    && /initial_connect/.test(UP071)
    && /phase_a_v2/.test(UP071)
    && /phase_b_reauthorization/.test(UP071)
    && /phase_b_v1/.test(UP071)
    && /tenant_email_oauth_transactions_intent_scope_coupling/.test(UP071)
    && /tenant_email_delegated_grants_scope_version_values/.test(UP071)
    && /SET DEFAULT 'initial_connect'/.test(UP071)
    && /SET DEFAULT 'phase_a_v2'/.test(UP071)
    && !/INSERT INTO tenant_email/.test(UP071));
  ok('071 down fail-closed Phase B facts',
    /071_down_refused: Phase B oauth/.test(DOWN071)
    && /071_down_refused: Phase B grant/.test(DOWN071)
    && /DROP COLUMN IF EXISTS authorization_intent/.test(DOWN071)
    && /DROP COLUMN IF EXISTS scope_version/.test(DOWN071)
    && /DROP COLUMN IF EXISTS prior_grant_generation/.test(DOWN071));
  ok('required resources exact contract',
    PHASE_B_REQUIRED_RESOURCE_SCOPES.join(' ') === 'User.Read Mail.ReadWrite Mail.Send'
    && EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION === 'phase_b_v1'
    && CONTRACT.EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.join(' ')
      === PHASE_B_REQUIRED_RESOURCE_SCOPES.join(' '));
  const norm = validateAndNormalizePhaseBTokenResponseScope(
    'Mail.Send openid User.Read Mail.ReadWrite profile offline_access',
  );
  ok('normalize any provider order',
    norm === 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send');
  const withEmail = validateAndNormalizePhaseBTokenResponseScope(
    'email User.Read Mail.Send Mail.ReadWrite openid',
  );
  ok('optional OIDC email normalized',
    withEmail === 'openid email User.Read Mail.ReadWrite Mail.Send');
  const rejects = [
    'User.Read Mail.ReadWrite',
    'User.Read Mail.ReadBasic Mail.ReadWrite Mail.Send',
    'User.Read Mail.Read Mail.ReadWrite Mail.Send',
    'User.Read Mail.ReadWrite Mail.Send Calendars.Read',
    'User.Read Mail.ReadWrite.Shared Mail.Send',
    'User.Read Mail.ReadWrite Mail.Send /.default',
    'User.Read Mail.ReadWrite Mail.Send Mail.ReadWrite',
    'User.Read Mail.ReadWrite Mail.Send Directory.Read.All',
    '', null, 1,
  ];
  ok('reject omissions/PhaseA/mixed/unknown/extras/dupes/dangerous',
    rejects.every((s) => validateAndNormalizePhaseBTokenResponseScope(s) === null));
  ok('scope order constant includes resources',
    PHASE_B_TOKEN_SCOPE_ORDER.includes('Mail.Send')
    && PHASE_B_TOKEN_SCOPE_ORDER.includes('User.Read'));
  ok('boundary gens exact: N+1≠N and 2^53 neighbor distinct',
    asGen(HUGE_N) === HUGE_N
    && asGen(HUGE_N1) === HUGE_N1
    && genPlus1(HUGE_N) === HUGE_N1
    && HUGE_N1 !== HUGE_N
    && asGen(9007199254740993) == null // Number unsafe/collapsed → reject
    && asGen(Number.MAX_SAFE_INTEGER) === String(Number.MAX_SAFE_INTEGER)
    && asGen('0') == null && asGen('01') == null && asGen(-1) == null
    && asGen(0) == null && asGen((GEN_MAX + 1n).toString()) == null
    && genPlus1(GEN_MAX.toString()) == null
    && asCanonGen(5n) === '5' && asCanonGen('5') === '5');
  ok('Phase B scopes for authorize',
    PHASE_B_SCOPES === 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send'
    && AUTHORIZATION_INTENT === 'phase_b_reauthorization'
    && SCOPE_VERSION === 'phase_b_v1');
  ok('start disabled by default',
    isStartEnabled({}) === false
    && isStartEnabled({ [START_ENABLED_ENV]: 'true' }) === true
    && isStartEnabled(process.env) === false);
  ok('SQL binds verified phase_a_v2 grant only',
    /binding_status\s*=\s*'verified'/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /g\.scope_version\s*=\s*'phase_a_v2'/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /g\.grant_status\s*=\s*'active'/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /g\.reconcile_state\s*=\s*'clean'/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /g\.grant_lease_token IS NULL/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /g\.grant_generation\s*=\s*\$11/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /'phase_b_reauthorization'/.test(SQL_CREATE_PHASE_B_REAUTH)
    && /'phase_b_v1'/.test(SQL_CREATE_PHASE_B_REAUTH));
  {
    const rows = [];
    const endpoints = [{
      id: ENDPOINT, client_id: CLIENT, location_id: 'sunset-somo',
      provider: 'microsoft_graph', auth_mode: 'delegated_authorization_code',
      connector_mode: 'microsoft_delegated_oauth', binding_status: 'verified',
    }];
    const locations = [{ id: LOCATION, client_id: CLIENT, location_id: 'sunset-somo' }];
    const grants = [{
      client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: 5,
      grant_status: 'active', reconcile_state: 'clean', scope_version: 'phase_a_v2',
      grant_lease_token: null, grant_lease_owner: null, grant_lease_until: null,
    }];
    const db = {
      async query(sql, params) {
        const normSql = String(sql).replace(/\s+/g, ' ').trim();
        if (normSql !== SQL_CREATE_PHASE_B_REAUTH) throw new Error('unexpected sql');
        const [clientId, locationId, , , endpointId, , , , , , priorGen] = params;
        const ep = endpoints.find((e) => e.id === endpointId && e.client_id === clientId
          && e.binding_status === 'verified');
        const tl = locations.find((l) => l.id === locationId && l.client_id === clientId
          && ep && l.location_id === ep.location_id);
        const g = grants.find((x) => x.endpoint_id === endpointId && x.client_id === clientId
          && x.scope_version === 'phase_a_v2' && x.grant_status === 'active'
          && x.reconcile_state === 'clean' && x.grant_lease_token == null
          && asCanonGen(x.grant_generation) === asCanonGen(priorGen));
        if (!ep || !tl || !g) return { rows: [] };
        const row = {
          expires_at: params[9],
          prior_grant_generation: String(g.grant_generation),
          authorization_intent: 'phase_b_reauthorization',
          scope_version: 'phase_b_v1',
        };
        rows.push(row);
        return { rows: [row] };
      },
    };
    const repo = createPostgresPhaseBReauthTransactionRepository(db);
    const env = {
      LUNA_DEPLOYMENT: 'sunset-staging',
      LUNA_EMAIL_OAUTH_CLIENT_ID: APP,
      [START_ENABLED_ENV]: 'true',
    };
    const svc = createMicrosoftPhaseBReauthorizationTransactionService({
      repository: repo, env, randomBytes: (n) => crypto.randomBytes(n),
      now: () => new Date('2026-08-08T12:00:00Z'),
    });
    const startInput = freezeExact({
      clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
      staffUserId: STAFF, authSessionId: SESSION, expectedPriorGrantGeneration: 5,
    }, INPUT_KEYS);
    const out = await svc.start(startInput);
    ok('reauth start durable fields',
      out.authorization_intent === AUTHORIZATION_INTENT
      && out.scope_version === SCOPE_VERSION
      && out.prior_grant_generation === '5'
      && typeof out.authorization_url === 'string'
      && out.authorization_url.includes('Mail.Send')
      && out.authorization_url.includes('prompt=consent')
      && rows.length === 1);
    let stale = false;
    try {
      await svc.start(freezeExact({
        clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
        staffUserId: STAFF, authSessionId: SESSION, expectedPriorGrantGeneration: 4,
      }, INPUT_KEYS));
    } catch (e) { stale = e.message === 'phase_b_reauth_start_endpoint_unavailable'; }
    ok('stale generation rejected', stale);
    grants[0].endpoint_id = '99999999-9999-4999-8999-999999999999';
    let cross = false;
    try {
      await svc.start(freezeExact({
        clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT,
        staffUserId: STAFF, authSessionId: SESSION, expectedPriorGrantGeneration: 5,
      }, INPUT_KEYS));
    } catch (e) { cross = e.message === 'phase_b_reauth_start_endpoint_unavailable'; }
    grants[0].endpoint_id = ENDPOINT;
    ok('cross endpoint rejected', cross);
    let disabled = false;
    try {
      await createMicrosoftPhaseBReauthorizationTransactionService({
        repository: repo, env: { ...env, [START_ENABLED_ENV]: undefined },
      }).start(startInput);
    } catch (e) { disabled = /phase_b_reauth_start_disabled/.test(e.message); }
    ok('start requires enable flag', disabled);
    const hostile = {};
    Object.defineProperty(hostile, 'clientId', { get() { throw new Error(PLANTED); }, enumerable: true });
    let hostFail = false;
    try { await svc.start(hostile); } catch (e) {
      hostFail = e.message === 'phase_b_reauth_start_invalid_request' && noLeak(e.message);
    }
    ok('hostile accessor fail-closed secret-free', hostFail);
  }
  {
    const priorGen = 3;
    const envNew = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const state = makeGrantState({ grant_generation: priorGen });
    const oldFp = fingerprintEnvelopeFromRow(state);
    const { client, state: st, log } = createFakeReplacerClient({ state });
    const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
    const identity = makeIdentity();
    const replaceInput = Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      actorStaffUserId: STAFF, expectedPriorGrantGeneration: priorGen,
      identity, envelope: envNew,
    });
    let rawReject = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(
        Object.freeze({ client: createFakeReplacerClient({ state: makeGrantState({ grant_generation: priorGen }) }).client }),
      ).replaceVerifiedGrant(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        actorStaffUserId: STAFF, expectedPriorGrantGeneration: priorGen,
        identity, envelope: envNew, refreshToken: REFRESH_NEW,
      }));
    } catch (e) { rawReject = e.code === REPLACER_ERR && noLeak(e); }
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(
        Object.freeze({ client: createFakeReplacerClient({ state: makeGrantState({ grant_generation: priorGen }) }).client }),
      ).replaceVerifiedGrant(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        actorStaffUserId: STAFF, expectedPriorGrantGeneration: priorGen,
        identity, envelope: envNew, refresh_token: REFRESH_NEW,
      }));
    } catch (e) { rawReject = rawReject && e.code === REPLACER_ERR && noLeak(e); }
    ok('replacer rejects raw token keys', rawReject);
    const result = await replacer.replaceVerifiedGrant(replaceInput);
    ok('CAS replace advances to phase_b_v1 N+1',
      result.status === REPLACED_STATUS
      && result.grantGeneration === '4'
      && result.scopeVersion === 'phase_b_v1'
      && result.operationId === OP
      && Object.isFrozen(result)
      && ACK_KEYS.every((k) => Object.prototype.hasOwnProperty.call(result, k))
      && Reflect.ownKeys(result).length === 4
      && st.scope_version === 'phase_b_v1'
      && asGen(st.grant_generation) === '4'
      && !envelopeFingerprintEqual(oldFp, fingerprintEnvelopeFromRow(st)));
    ok('SQL never contains raw refresh',
      log.every((e) => noLeak(e.params) && noLeak(e.sql))
      && !SQL_CAS_UPDATE.includes('refresh_token')
      && /provider_tenant_id/.test(SQL_LOCK)
      && /provider_principal_oid/.test(SQL_LOCK)
      && /provider_resource_id/.test(SQL_LOCK)
      && /public_address/.test(SQL_LOCK));
    const recon = await createMicrosoftPhaseBVerifiedGrantReplacer(
      Object.freeze({ client: createFakeReplacerClient({ state: st }).client }),
    ).reconcileReplacement(Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      expectedPriorGrantGeneration: priorGen,
    }));
    ok('reconcile exact generation/op advanced',
      recon.advanced === true
      && recon.grantGeneration === '4'
      && recon.lastOperationId === OP
      && recon.scopeVersion === 'phase_b_v1');
  }
  {
    const priorGen = 3;
    const envNew = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const cases = [
      makeIdentity({ providerTenantId: TENANT2 }),
      makeIdentity({ providerPrincipalId: PRINCIPAL2 }),
      makeIdentity({ mailboxAddress: 'other@sunset.example' }),
    ];
    let allFail = true;
    for (const id of cases) {
      const { client, state } = createFakeReplacerClient({
        state: makeGrantState({ grant_generation: priorGen }),
      });
      const oldGen = state.grant_generation;
      try {
        await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }))
          .replaceVerifiedGrant(Object.freeze({
            clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
            actorStaffUserId: null, expectedPriorGrantGeneration: priorGen,
            identity: id, envelope: envNew,
          }));
        allFail = false;
      } catch (e) {
        allFail = allFail && e.code === REPLACER_ERR && asGen(state.grant_generation) === asGen(oldGen);
      }
    }
    ok('cross-tenant/principal/mailbox substitution zero replacement', allFail);
  }
  {
    const envHuge = await makeEnvelope(OP, REFRESH_NEW, HUGE_N1);
    const { client, state } = createFakeReplacerClient({
      state: makeGrantState({ grant_generation: HUGE_N }),
    });
    const out = await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }))
      .replaceVerifiedGrant(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        actorStaffUserId: null, expectedPriorGrantGeneration: HUGE_N,
        identity: makeIdentity(), envelope: envHuge,
      }));
    ok('huge boundary generation CAS N→N+1 exact strings',
      out.status === REPLACED_STATUS
      && out.grantGeneration === HUGE_N1
      && out.grantGeneration !== HUGE_N
      && asGen(state.grant_generation) === HUGE_N1
      && Number(HUGE_N1) === Number(HUGE_N) // demonstrates Number trap
      && out.grantGeneration !== String(Number(HUGE_N1)));
  }
  {
    const priorGen = 2;
    const envNew = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const mkInput = () => Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      actorStaffUserId: null, expectedPriorGrantGeneration: priorGen,
      identity: makeIdentity(), envelope: envNew,
    });
    const lockCase = createFakeReplacerClient({
      state: makeGrantState({ grant_generation: priorGen }), lockMismatch: true,
    });
    const oldLock = cloneEnvRow(lockCase.state);
    let lockFail = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: lockCase.client }))
        .replaceVerifiedGrant(mkInput());
    } catch (e) { lockFail = e.code === REPLACER_ERR && noLeak(e); }
    ok('lock generation mismatch fails + preserves',
      lockFail
      && asGen(lockCase.state.grant_generation) === String(priorGen)
      && envelopeFingerprintEqual(fingerprintEnvelopeFromRow(oldLock), fingerprintEnvelopeFromRow(lockCase.state)));
    const updCase = createFakeReplacerClient({
      state: makeGrantState({ grant_generation: priorGen }), updateFail: true,
    });
    const oldUpd = cloneEnvRow(updCase.state);
    let updFail = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: updCase.client }))
        .replaceVerifiedGrant(mkInput());
    } catch (e) { updFail = e.code === REPLACER_ERR && noLeak(e); }
    ok('UPDATE zero-row rollback preserves old byte-identical',
      updFail
      && asGen(updCase.state.grant_generation) === String(priorGen)
      && envelopeFingerprintEqual(fingerprintEnvelopeFromRow(oldUpd), fingerprintEnvelopeFromRow(updCase.state)));
  }
  {
    const priorGen = 7;
    const envNew = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const input = Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      actorStaffUserId: STAFF, expectedPriorGrantGeneration: priorGen,
      identity: makeIdentity(), envelope: envNew,
    });
    const retBad = createTxnAwareClient({
      state: makeGrantState({ grant_generation: priorGen }), returnBad: true,
    });
    const oldFp = fingerprintEnvelopeFromRow(retBad.durable);
    let retFail = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: retBad.client }))
        .replaceVerifiedGrant(input);
    } catch (e) { retFail = e.code === REPLACER_ERR && noLeak(e); }
    ok('RETURN mismatch rollback preserves old byte-identical',
      retFail
      && asGen(retBad.durable.grant_generation) === String(priorGen)
      && retBad.durable.scope_version === 'phase_a_v2'
      && envelopeFingerprintEqual(oldFp, fingerprintEnvelopeFromRow(retBad.durable)));
    const rbThrow = createTxnAwareClient({
      state: makeGrantState({ grant_generation: priorGen }),
      updateEmpty: true, rollbackThrows: true,
    });
    let rbSanitized = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: rbThrow.client }))
        .replaceVerifiedGrant(Object.freeze({
          ...input, operationId: OP2,
          envelope: await makeEnvelope(OP2, REFRESH_NEW, priorGen + 1),
        }));
    } catch (e) {
      rbSanitized = e.code === REPLACER_ERR && noLeak(e) && !String(e.message).includes('forced_rollback');
    }
    ok('rollback failure sanitized', rbSanitized);
    const commitCase = createTxnAwareClient({
      state: makeGrantState({ grant_generation: priorGen }), commitFail: true,
    });
    const commitOut = await createMicrosoftPhaseBVerifiedGrantReplacer(
      Object.freeze({ client: commitCase.client }),
    ).replaceVerifiedGrant(Object.freeze({
      ...input, operationId: OP2,
      envelope: await makeEnvelope(OP2, REFRESH_NEW, priorGen + 1),
    }));
    ok('COMMIT failure → outcome_unknown no rollback claim',
      commitOut.status === OUTCOME_UNKNOWN
      && !('preserved' in commitOut)
      && Reflect.ownKeys(commitOut).length === 1
      && noLeak(commitOut));
    const recon = await createMicrosoftPhaseBVerifiedGrantReplacer(
      Object.freeze({ client: createTxnAwareClient({ state: commitCase.durable }).client }),
    ).reconcileReplacement(Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP2,
      expectedPriorGrantGeneration: priorGen,
    }));
    ok('reconcile after uncertainty reads durable gen/op',
      typeof recon.grantGeneration === 'string'
      && (recon.stillPrior === true || recon.advanced === true || asGen(recon.grantGeneration) != null)
      && noLeak(recon));
  }
  {
    const priorGen = 4;
    const base = makeGrantState({
      grant_generation: priorGen + 1, scope_version: 'phase_b_v1', last_operation_id: OP,
    });
    const dirtyCases = [
      { ...base, grant_status: 'revoked' },
      { ...base, reconcile_state: 'dirty' },
      { ...base, grant_lease_token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
      { ...base, grant_lease_owner: 'worker-1' },
      { ...base, grant_lease_until: new Date().toISOString() },
      { ...base, binding_status: 'reauthorization_required' },
    ];
    let allBlocked = true;
    for (const st of dirtyCases) {
      const recon = await createMicrosoftPhaseBVerifiedGrantReplacer(
        Object.freeze({ client: createFakeReplacerClient({ state: st }).client }),
      ).reconcileReplacement(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        expectedPriorGrantGeneration: priorGen,
      }));
      allBlocked = allBlocked && recon.advanced === false && recon.stillPrior === false;
    }
    ok('dirty/revoked/leased reconcile cannot advanced', allBlocked);
  }
  {
    const priorGen = 4;
    let durable = makeGrantState({ grant_generation: priorGen });
    function createRacingClient() {
      let pending = null;
      return {
        async query(sql, params) {
          const s = String(sql).replace(/\s+/g, ' ').trim();
          if (s === 'BEGIN') { pending = null; return { rows: [] }; }
          if (s === 'COMMIT') {
            if (pending) durable = { ...durable, ...pending };
            pending = null; return { rows: [] };
          }
          if (s === 'ROLLBACK') { pending = null; return { rows: [] }; }
          if (s.includes('FOR UPDATE')) {
            return { rows: [ownDataRow(LOCK_COLS, durable)] };
          }
          if (s.startsWith('UPDATE')) {
            if (asGen(durable.grant_generation) !== asGen(params[14])
                || durable.scope_version !== 'phase_a_v2') {
              return { rows: [] };
            }
            pending = {
              ...durable, grant_generation: params[2], last_operation_id: params[3],
              scope_version: 'phase_b_v1',
              envelope_version: params[4], aead_alg: params[5], kek_wrap_alg: params[6],
              kek_key_name: params[7], kek_key_version: params[8],
              nonce: params[9], ciphertext: params[10], auth_tag: params[11],
              wrapped_dek: params[12],
            };
            return {
              rows: [ownDataRow(RET_COLS, {
                client_id: CLIENT, endpoint_id: ENDPOINT, grant_generation: params[2],
                grant_status: 'active', reconcile_state: 'clean', scope_version: 'phase_b_v1',
                last_operation_id: params[3],
              })],
            };
          }
          throw new Error('unexpected');
        },
      };
    }
    const envA = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const envB = await makeEnvelope(OP2, REFRESH_NEW + 'x', priorGen + 1);
    const r1 = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: createRacingClient() }));
    const out1 = await r1.replaceVerifiedGrant(Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP, actorStaffUserId: null,
      expectedPriorGrantGeneration: priorGen, identity: makeIdentity(), envelope: envA,
    }));
    let out2Fail = false;
    try {
      const r2 = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: createRacingClient() }));
      await r2.replaceVerifiedGrant(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP2, actorStaffUserId: null,
        expectedPriorGrantGeneration: priorGen, identity: makeIdentity(), envelope: envB,
      }));
    } catch (e) { out2Fail = e.code === REPLACER_ERR; }
    ok('serial stale replacements: at most one advances',
      out1.status === REPLACED_STATUS
      && out2Fail
      && asGen(durable.grant_generation) === String(priorGen + 1)
      && durable.last_operation_id === OP);
  }
  {
    let releaseBegin;
    const gate = new Promise((r) => { releaseBegin = r; });
    let queryCount = 0;
    const priorGen = 5;
    const state = makeGrantState({ grant_generation: priorGen });
    const base = createFakeReplacerClient({ state, gateBegin: () => gate });
    const client = {
      async query(sql, params) {
        queryCount += 1;
        return base.client.query(sql, params);
      },
    };
    const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
    const envNew = await makeEnvelope(OP, REFRESH_NEW, priorGen + 1);
    const replaceP = replacer.replaceVerifiedGrant(Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP, actorStaffUserId: null,
      expectedPriorGrantGeneration: priorGen, identity: makeIdentity(), envelope: envNew,
    }));
    await new Promise((r) => setImmediate(r));
    const qBefore = queryCount;
    let reconFail = false;
    try {
      await replacer.reconcileReplacement(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        expectedPriorGrantGeneration: priorGen,
      }));
    } catch (e) { reconFail = e.code === REPLACER_ERR; }
    ok('reconcile overlap during replace: fail closed zero extra SQL',
      reconFail && queryCount === qBefore);
    releaseBegin();
    const replaceOut = await replaceP;
    ok('replace completes after overlap reject',
      replaceOut.status === REPLACED_STATUS && replaceOut.grantGeneration === '6');
  }
  {
    const priorGen = 6;
    const provider = createFakeEmailGrantEnvelopeProvider();
    let replaceCalls = 0;
    const { client, state } = createFakeReplacerClient({
      state: makeGrantState({ grant_generation: priorGen }),
    });
    const realReplacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
    const countingReplacer = Object.freeze({
      async replaceVerifiedGrant(input) {
        replaceCalls += 1;
        for (const k of Reflect.ownKeys(input)) {
          if (String(k).toLowerCase().includes('token') || k === 'aad' || k === 'refresh_token') {
            throw new Error('raw_token_leak_into_replacer');
          }
        }
        if (!input.identity || input.identity.providerTenantId !== TENANT) {
          throw new Error('identity_not_bound');
        }
        return realReplacer.replaceVerifiedGrant(input);
      },
    });
    const identity = Object.freeze({
      async verifyIdentity() { return makeIdentity(); },
    });
    const clock = Object.freeze({ nowEpochSeconds: () => 1_700_000_000 });
    const cfg = Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      actorStaffUserId: STAFF, expectedNonce: 'n'.repeat(43),
      expectedClientId: APP, expectedPriorGrantGeneration: priorGen,
    });
    ok('custody config keys include prior generation',
      CONFIG_KEYS.includes('expectedPriorGrantGeneration') && CONFIG_KEYS.length === 7
      && REPLACE_KEYS.includes('identity'));
    const custody = createMicrosoftPhaseBVerifiedGrantCustodyAdapter(
      cfg,
      Object.freeze({
        verifiedIdentity: identity, envelopeProvider: provider, clock, replacer: countingReplacer,
      }),
    );
    const selected = Object.freeze({
      accessToken: ACCESS, refreshToken: REFRESH_NEW, tokenType: 'Bearer',
      expiresIn: 3600,
      scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
      idToken: IDTOK,
    });
    const ack = await custody.acceptValidatedTokens(selected);
    ok('custody seals + replaces → accepted',
      ack.status === SEALED_ACK.status
      && replaceCalls === 1
      && asGen(state.grant_generation) === String(priorGen + 1)
      && state.scope_version === 'phase_b_v1'
      && noLeak(ack));
    const next = String(priorGen + 1);
    const hostileAcks = [
      Object.freeze({ status: 'replaced' }), // missing keys
      Object.freeze({
        status: 'replaced', grantGeneration: next, operationId: OP, scopeVersion: 'phase_b_v1',
        extra: true,
      }),
      Object.freeze({
        status: 'replaced', grantGeneration: Number(next), operationId: OP, scopeVersion: 'phase_b_v1',
      }),
      Object.freeze({
        status: 'replaced', grantGeneration: String(priorGen), operationId: OP, scopeVersion: 'phase_b_v1',
      }),
      Object.freeze({
        status: 'replaced', grantGeneration: next, operationId: OP2, scopeVersion: 'phase_b_v1',
      }),
      Object.freeze({
        status: 'replaced', grantGeneration: next, operationId: OP, scopeVersion: 'phase_a_v2',
      }),
      Object.freeze({ status: 'installed' }),
      (() => {
        const o = {};
        Object.defineProperty(o, 'status', { get() { return 'replaced'; }, enumerable: true });
        Object.defineProperty(o, 'grantGeneration', { value: next, enumerable: true });
        Object.defineProperty(o, 'operationId', { value: OP, enumerable: true });
        Object.defineProperty(o, 'scopeVersion', { value: 'phase_b_v1', enumerable: true });
        return Object.freeze(o);
      })(),
    ];
    let hostileOk = true;
    for (const badAck of hostileAcks) {
      let rejected = false;
      const fake = Object.freeze({
        async replaceVerifiedGrant() { return badAck; },
      });
      try {
        const c = createMicrosoftPhaseBVerifiedGrantCustodyAdapter(
          Object.freeze({
            clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
            actorStaffUserId: STAFF, expectedNonce: 'n'.repeat(43),
            expectedClientId: APP, expectedPriorGrantGeneration: priorGen,
          }),
          Object.freeze({
            verifiedIdentity: identity, envelopeProvider: provider, clock, replacer: fake,
          }),
        );
                await c.acceptValidatedTokens(selected);
      } catch (e) {
        rejected = e.code === CUSTODY_ERR && noLeak(e);
      }
      hostileOk = hostileOk && rejected;
    }
    ok('hostile acknowledgements zero false accepted', hostileOk);
    const failProvider = {
      async sealGrantPayload() { throw new Error(PLANTED); },
      async openGrantPayload() { throw new Error('no'); },
      async rewrapGrantDek() { throw new Error('no'); },
    };
    let sealCalls = 0;
    const noReplace = Object.freeze({
      async replaceVerifiedGrant() { sealCalls += 1; throw new Error('should_not_run'); },
    });
    const { state: st2 } = createFakeReplacerClient({
      state: makeGrantState({ grant_generation: priorGen }),
    });
    let sealFail = false;
    try {
      const c = createMicrosoftPhaseBVerifiedGrantCustodyAdapter(
        Object.freeze({ ...cfg, operationId: OP2 }),
        Object.freeze({
          verifiedIdentity: identity, envelopeProvider: failProvider, clock, replacer: noReplace,
        }),
      );
      await c.acceptValidatedTokens(Object.freeze({ ...selected }));
    } catch (e) {
      sealFail = e.code === CUSTODY_ERR && noLeak(e) && !String(e.stack || e.message).includes(PLANTED);
    }
    ok('forced seal failure zero replacement secret-free',
      sealFail && sealCalls === 0 && asGen(st2.grant_generation) === String(priorGen));
    let phaseAReject = false;
    try {
      const c = createMicrosoftPhaseBVerifiedGrantCustodyAdapter(
        Object.freeze({ ...cfg, operationId: '55555555-5555-4555-8555-555555555555' }),
        Object.freeze({
          verifiedIdentity: identity, envelopeProvider: provider, clock, replacer: noReplace,
        }),
      );
      await c.acceptValidatedTokens(Object.freeze({
        ...selected, scope: 'openid profile offline_access User.Read Mail.ReadBasic',
      }));
    } catch (e) { phaseAReject = e.code === CUSTODY_ERR && noLeak(e); }
    ok('custody rejects Phase A token scopes', phaseAReject && sealCalls === 0);
    let burned = false;
    try { await custody.acceptValidatedTokens(selected); } catch (e) {
      burned = e.code === CUSTODY_ERR;
    }
    ok('custody single-use burn', burned);
  }
  {
    let bad = false;
    try {
      createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: null }));
    } catch (e) { bad = e.code === REPLACER_ERR && noLeak(e); }
    try {
      createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({
        client: { query: async () => ({}), connect: async () => {}, totalCount: 1 },
      }));
    } catch (e) { bad = bad && e.code === REPLACER_ERR; }
    try {
      createMicrosoftPhaseBVerifiedGrantCustodyAdapter(
        Object.freeze({ evil: true }), Object.freeze({ a: 1 }),
      );
    } catch (e) { bad = bad && e.code === CUSTODY_ERR && noLeak(e); }
    ok('hostile deps fail closed secret-free', bad);
  }
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    skip('schema_pglite_constraints', 'PGlite unavailable');
  } else {
    try {
      const db = new PGlite();
      await db.exec(`
        CREATE TABLE staff_users (id UUID PRIMARY KEY, client_id UUID NOT NULL);
        CREATE TABLE auth_sessions (id UUID PRIMARY KEY, client_id UUID NOT NULL, staff_user_id UUID NOT NULL);
        CREATE TABLE tenant_locations (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL);
        CREATE TABLE tenant_channel_endpoints (
          id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL,
          provider TEXT, auth_mode TEXT, connector_mode TEXT, binding_status TEXT
        );
        CREATE TABLE tenant_email_oauth_transactions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          client_id UUID NOT NULL, location_id UUID NOT NULL, staff_user_id UUID NOT NULL,
          auth_session_id UUID NOT NULL, endpoint_id UUID NOT NULL,
          state_hash BYTEA NOT NULL UNIQUE, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL,
          issued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
          expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ NULL
        );
        CREATE TABLE tenant_email_delegated_grants (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          client_id UUID NOT NULL, endpoint_id UUID NOT NULL,
          grant_generation BIGINT NOT NULL, grant_status TEXT NOT NULL,
          grant_lease_owner TEXT NULL, grant_lease_token UUID NULL, grant_lease_until TIMESTAMPTZ NULL,
          last_operation_id UUID NOT NULL, reconcile_state TEXT NOT NULL DEFAULT 'clean',
          reconcile_detail_code TEXT NULL,
          envelope_version TEXT NOT NULL, aead_alg TEXT NOT NULL, kek_wrap_alg TEXT NOT NULL,
          kek_key_name TEXT NOT NULL, kek_key_version TEXT NOT NULL,
          nonce BYTEA NOT NULL, ciphertext BYTEA NOT NULL, auth_tag BYTEA NOT NULL, wrapped_dek BYTEA NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await db.query(
        `INSERT INTO tenant_email_oauth_transactions
          (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
           state_hash, code_verifier, nonce, issued_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds')`,
        [crypto.randomUUID(), CLIENT, LOCATION, STAFF, SESSION, ENDPOINT,
          crypto.randomBytes(32), 'v'.repeat(43), 'n'.repeat(43)],
      );
      await db.query(
        `INSERT INTO tenant_email_delegated_grants
          (client_id, endpoint_id, grant_generation, grant_status, last_operation_id,
           envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version,
           nonce, ciphertext, auth_tag, wrapped_dek)
         VALUES ($1,$2,1,'active',$3,'v1','AES-256-GCM','A256KW','k','v1',
                 $4,$5,$6,$7)`,
        [CLIENT, ENDPOINT, OP, buf12(), bufN(32), buf16(), bufN(40)],
      );
      await db.exec(UP071);
      const tx = await db.query(
        `SELECT authorization_intent, scope_version, prior_grant_generation
           FROM tenant_email_oauth_transactions LIMIT 1`,
      );
      const gr = await db.query(`SELECT scope_version FROM tenant_email_delegated_grants LIMIT 1`);
      ok('pglite backfill initial_connect/phase_a_v2/NULL',
        tx.rows[0].authorization_intent === 'initial_connect'
        && tx.rows[0].scope_version === 'phase_a_v2'
        && tx.rows[0].prior_grant_generation == null
        && gr.rows[0].scope_version === 'phase_a_v2');
      await db.query(
        `INSERT INTO tenant_email_oauth_transactions
          (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
           state_hash, code_verifier, nonce, issued_at, expires_at,
           authorization_intent, scope_version, prior_grant_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds',
                 'phase_b_reauthorization','phase_b_v1',3)`,
        [crypto.randomUUID(), CLIENT, LOCATION, STAFF, SESSION, ENDPOINT,
          crypto.randomBytes(32), 'v'.repeat(43), 'n'.repeat(43)],
      );
      await db.query(
        `INSERT INTO tenant_email_oauth_transactions
          (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
           state_hash, code_verifier, nonce, issued_at, expires_at,
           authorization_intent, scope_version, prior_grant_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds',
                 'phase_b_reauthorization','phase_b_v1',$10::bigint)`,
        [crypto.randomUUID(), CLIENT, LOCATION, STAFF, SESSION, ENDPOINT,
          crypto.randomBytes(32), 'v'.repeat(43), 'n'.repeat(43), HUGE_N1],
      );
      const big = await db.query(
        `SELECT prior_grant_generation::text AS g FROM tenant_email_oauth_transactions
          WHERE prior_grant_generation = $1::bigint`,
        [HUGE_N1],
      );
      ok('pglite BIGINT 2^53+1 roundtrip exact',
        big.rows.length === 1 && String(big.rows[0].g) === HUGE_N1
        && String(big.rows[0].g) !== HUGE_N);
      let coupleFail = false;
      try {
        await db.query(
          `INSERT INTO tenant_email_oauth_transactions
            (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
             state_hash, code_verifier, nonce, issued_at, expires_at,
             authorization_intent, scope_version, prior_grant_generation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds',
                   'phase_b_reauthorization','phase_a_v2',3)`,
          [crypto.randomUUID(), CLIENT, LOCATION, STAFF, SESSION, ENDPOINT,
            crypto.randomBytes(32), 'v'.repeat(43), 'n'.repeat(43)],
        );
      } catch { coupleFail = true; }
      ok('pglite intent/scope coupling enforced', coupleFail);
      let downRefused = false;
      try { await db.exec(DOWN071); } catch (e) {
        downRefused = /071_down_refused/.test(String(e.message || e));
      }
      ok('pglite down refuses Phase B facts', downRefused);
      try { await db.exec('ROLLBACK'); } catch { /* ignore */ }
      await db.query(`DELETE FROM tenant_email_oauth_transactions WHERE authorization_intent = 'phase_b_reauthorization'`);
      await db.query(`UPDATE tenant_email_delegated_grants SET scope_version = 'phase_a_v2'`);
      await db.exec(DOWN071);
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'tenant_email_oauth_transactions'
            AND column_name IN ('authorization_intent','scope_version','prior_grant_generation')`,
      );
      ok('pglite down drops columns when Phase A only', cols.rows.length === 0);
      await db.close();
    } catch (e) {
      ok('pglite schema suite', false, String(e && e.message || e));
    }
  }
  if (!stockPgAvailable()) {
    skip('schema_stock_pg_concurrency',
      'stock PG env not configured — multi-session race activation blocker (dormant merge SKIP)');
  } else {
    skip('schema_stock_pg_concurrency',
      'stock PG present but multi-session race deferred — activation blocker before live merge');
  }
  {
    const probe = spawnSync(process.execPath, ['-e', `
      const fs = require('fs');
      const path = require('path');
      const root = ${JSON.stringify(ROOT)};
      const flag = ${JSON.stringify(START_ENABLED_ENV)};
      if (process.env[flag] === 'true') { console.log('ENABLED'); process.exit(2); }
      const { isStartEnabled } = require(path.join(root, 'scripts/lib/email-microsoft-phase-b-reauthorization-transaction-service.js'));
      if (isStartEnabled(process.env)) { console.log('ENABLED_FN'); process.exit(3); }
      const cfgDir = path.join(root, 'config');
      function walk(d, acc) {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p, acc);
          else if (/\\.(json|env|yml|yaml|example)$/.test(ent.name)) acc.push(p);
        }
        return acc;
      }
      let files = [];
      try { files = walk(cfgDir, []); } catch {}
      for (const f of files) {
        const t = fs.readFileSync(f, 'utf8');
        if (t.includes(flag + '=true') || t.includes('"' + flag + '": true') || t.includes("'" + flag + "': true")) {
          console.log('CONFIG', f); process.exit(4);
        }
      }
      console.log('OK');
    `], { encoding: 'utf8', env: { ...process.env, [START_ENABLED_ENV]: undefined } });
    ok('fresh-process: Phase B reauth flag not enabled in defaults',
      probe.status === 0 && /OK/.test(probe.stdout || ''));
  }
  {
    const phaseA = [
      'scripts/lib/email-microsoft-token-response-scope.js',
      'scripts/lib/email-microsoft-verified-grant-custody.js',
      'scripts/lib/email-microsoft-verified-grant-installer.js',
      'scripts/lib/email-microsoft-oauth-transaction-service.js',
      'scripts/lib/email-microsoft-delegated-oauth-contract.js',
    ];
    const base = 'c08a4d7b9275def16f98f870e124f823393ca4a5';
    let allSame = true;
    for (const f of phaseA) {
      const r = spawnSync('git', ['diff', '--quiet', base, '--', f], { cwd: ROOT });
      if (r.status !== 0) allSame = false;
    }
    ok('Phase A owners byte-identical vs base', allSame);
  }
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package has verify:email-phase-b-authority',
      pkg.scripts['verify:email-phase-b-authority'] === 'node scripts/verify-email-phase-b-authority.js');
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skips.length} skipped`);
  if (skips.length) {
    for (const s of skips) console.log(`  · ${s}`);
  }
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
