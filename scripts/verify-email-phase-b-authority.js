'use strict';
/**
 * Gate 3 Phase B PR B1 — dormant authority + atomic replacement offline verifier.
 * Schema (PGlite optional; stock-PG multi-session via dedicated dual-gate proof),
 * scopes, reauth TX, custody/replacer.
 * Never claims multi-session race on single-session PGlite without explicit SKIP.
 * Stock PG: only SUNSET_EMAIL_PHASE_B_STOCK_PG_URL + PROOF_ENABLED=true runs real proof.
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
const STOCK_PG_URL_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_URL';
const STOCK_PG_GUARD_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_PROOF_ENABLED';
const STOCK_PG_TARGET_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_TARGET';
const STOCK_PG_EXPECTED_DB_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_EXPECTED_DATABASE';
const STOCK_PG_EXPECTED_HOST_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_EXPECTED_HOST';
const STOCK_PG_SCRIPT_REL = 'scripts/prove-email-phase-b-stock-pg-concurrency.js';
const STOCK_PG_NPM = 'prove:email-phase-b-stock-pg-concurrency';
// Child must outlive proof OVERALL_MS (75s) + cleanup bound; keep B1 wait bounded.
const STOCK_PG_CHILD_TIMEOUT_MS = 100_000;

// Exact PASS transcript helpers from the proof module (offline; no live PG).
// eslint-disable-next-line import/no-dynamic-require, global-require
const stockPgProofMeta = require(path.join(ROOT, STOCK_PG_SCRIPT_REL));
// Candidate exports (builder + claimed names). Immutable expected digest is separate —
// B1 must not self-fulfill by importing both builder and expected array only from candidate.
const stockPgTranscriptPassed = stockPgProofMeta.stockPgTranscriptPassed;
const buildPassTranscript = stockPgProofMeta.buildPassTranscript;
const STOCK_PG_AZURE_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const STOCK_PG_STAGING_URL = `postgresql://${STOCK_PG_AZURE_HOST}:5432/sunset_staging?sslmode=verify-full`;

/**
 * Immutable expected check digest — hardcoded in B1, not imported from the candidate.
 * Candidate CHECK_NAMES / EXPECTED_CHECK_COUNT must match this digest exactly.
 * Offline B1 proves wiring/shape only; runtime stock-PG semantics still require a real run.
 */
const STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT = 58;
const STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES = Object.freeze([
  'schema_isolated_temp_migrations_060_061_071',
  'phase_a_blocking_pids_exact',
  'phase_a_worker_identity_verified',
  'phase_a_race_exactly_one_winner',
  'phase_a_loser_genuine_invalid',
  'phase_a_race_one_row_consumed',
  'phase_a_no_preliminary_select',
  'phase_a_replay_after_winner_invalid',
  'phase_b_blocking_pids_exact',
  'phase_b_worker_identity_verified',
  'phase_b_race_exactly_one_winner',
  'phase_b_loser_genuine_invalid',
  'phase_b_race_prior_generation_canonical',
  'phase_b_race_one_row_consumed',
  'phase_b_no_preliminary_select',
  'phase_b_replay_after_winner_invalid',
  'cross_intent_phase_a_match_blocked_by_blocker',
  'cross_intent_phase_a_wrong_invalid_before_release',
  'cross_intent_phase_a_wrong_full_row_identical_while_match_blocked',
  'cross_intent_phase_a_match_accepted_after_release',
  'cross_intent_phase_b_match_blocked_by_blocker',
  'cross_intent_phase_b_wrong_invalid_before_release',
  'cross_intent_phase_b_wrong_full_row_identical_while_match_blocked',
  'cross_intent_phase_b_match_accepted_after_release',
  'grant_cas_blocking_pids_exact',
  'grant_cas_race_exactly_one_winner',
  'grant_cas_loser_production_stale',
  'grant_cas_single_advanced_generation',
  'huge_boundary_canon_no_number_coercion',
  'grant_cas_huge_blocking_pids_exact',
  'grant_cas_huge_boundary_one_winner',
  'grant_cas_huge_loser_production_stale',
  'grant_cas_huge_stored_exact_decimal',
  'grant_cas_max_blocking_pids_exact',
  'grant_cas_max_bigint_one_winner',
  'grant_cas_max_loser_production_stale',
  'grant_cas_max_bigint_stored_exact',
  'reconcile_still_prior_high_bigint',
  'reconcile_pre_advanced_replace_ok',
  'reconcile_advanced_high_bigint',
  'reconcile_after_precommit_failure_still_prior',
  'reconcile_after_postcommit_ack_loss_outcome_unknown',
  'reconcile_after_postcommit_ack_loss_advanced',
  'lock_wait_bounded_timeout',
  'workers_settle_after_blocker_release',
  'no_expected_database_run_token_backends_active_or_waiting_after_settle',
  'isolation_uncommitted_cas_not_visible',
  'isolation_rollback_restores_prior',
  'replacer_mid_tx_failure_no_partial_mutation',
  'multi_session_distinct_backends',
  'no_provider_azure_http_graph_static',
  'no_provider_seal_only_local_envelope',
  'no_provider_network_tripwire_zero',
  'provider_no_other_methods_invoked',
  'require_cache_production_after_traps',
  'reviewer_workspace_path_documented',
  'temp_schema_cleaned',
  'supervisor_zero_run_token_backends_after_cleanup',
]);
// Candidate-claimed names — compared against immutable digest (not used as sole expected source).
const STOCK_PG_CANDIDATE_CHECK_NAMES = stockPgProofMeta.CHECK_NAMES;
const STOCK_PG_CANDIDATE_EXPECTED_CHECKS = stockPgProofMeta.EXPECTED_CHECK_COUNT;
// B1 transcript tests use the immutable digest as the expected side.
const STOCK_PG_EXPECTED_CHECKS = STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT;
const STOCK_PG_CHECK_NAMES = STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES;

function stockPgAvailable() {
  return !!(process.env.DATABASE_URL || process.env.PGHOST || process.env.WH_DISPOSABLE_PG);
}

/**
 * Dual-gate stock-PG activation (never treats generic DATABASE_URL/PGHOST as consent).
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveStockPgActivation(env) {
  const e = env || process.env;
  const raw = e[STOCK_PG_URL_ENV];
  const hasDedicatedUrl = typeof raw === 'string' && raw.trim().length > 0;
  const guardOn = e[STOCK_PG_GUARD_ENV] === 'true';
  const genericPg = !!(e.DATABASE_URL || e.PGHOST || e.WH_DISPOSABLE_PG);
  if (hasDedicatedUrl && guardOn) {
    return { action: 'run', hasDedicatedUrl, guardOn, genericPg };
  }
  if (hasDedicatedUrl && !guardOn) {
    return { action: 'refuse_no_guard', hasDedicatedUrl, guardOn, genericPg };
  }
  if (genericPg) {
    return { action: 'refuse_generic_only', hasDedicatedUrl, guardOn, genericPg };
  }
  return { action: 'skip_absent', hasDedicatedUrl, guardOn, genericPg };
}

/**
 * Run the dedicated stock-PG proof child. Never fabricates PASS.
 * @param {{spawnImpl?: typeof spawnSync, env?: NodeJS.ProcessEnv, scriptPath?: string}} [opts]
 */
function runStockPgConcurrencyProofChild(opts) {
  const o = opts || {};
  const spawnImpl = o.spawnImpl || spawnSync;
  const env = o.env || process.env;
  const scriptPath = o.scriptPath || path.join(ROOT, STOCK_PG_SCRIPT_REL);
  const childEnv = { ...env };
  // Child must only honor dedicated dual-gate; strip accidental generic consent noise
  // is unnecessary (child ignores them) but keep guard/url exact.
  return spawnImpl(process.execPath, [scriptPath], {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: STOCK_PG_CHILD_TIMEOUT_MS,
    env: childEnv,
    maxBuffer: 2 * 1024 * 1024,
  });
}

/**
 * Exact PASS parser: full stdout must match one bounded transcript schema with the
 * known check count and one frozen JSON object; stderr must be empty; no prefix/suffix.
 */
function stockPgChildPassed(result) {
  return stockPgTranscriptPassed(result);
}

/** Minimal PATH/HOME env for hostile offline child spawns (no PG consent). */
function offlineChildEnv(extra) {
  const env = { PATH: process.env.PATH || '/usr/bin', HOME: process.env.HOME || '/tmp' };
  if (extra) Object.assign(env, extra);
  return env;
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
  // Containment: advanced requires canonical identity + usable sealed envelope metadata
  {
    const priorGen = 4;
    const baseAdv = makeGrantState({
      grant_generation: priorGen + 1, scope_version: 'phase_b_v1', last_operation_id: OP,
    });
    const corruptCases = [
      { ...baseAdv, provider_tenant_id: 'NOT-A-UUID' },
      { ...baseAdv, provider_principal_oid: 'gggggggg-gggg-4ggg-8ggg-gggggggggggg' },
      { ...baseAdv, provider_resource_id: 'resource-not-uuid' },
      { ...baseAdv, public_address: 'Not-Lowercase@Sunset.Example' },
      { ...baseAdv, public_address: 'bad..mailbox@sunset.example' },
      { ...baseAdv, envelope_version: 'v2' },
      { ...baseAdv, aead_alg: 'AES-128-GCM' },
      { ...baseAdv, kek_key_version: 'latest' },
      { ...baseAdv, nonce: bufN(8) },
      { ...baseAdv, auth_tag: bufN(8) },
      { ...baseAdv, ciphertext: Buffer.alloc(0) },
      { ...baseAdv, wrapped_dek: bufN(8) },
    ];
    let allFalse = true;
    for (const st of corruptCases) {
      const recon = await createMicrosoftPhaseBVerifiedGrantReplacer(
        Object.freeze({ client: createFakeReplacerClient({ state: st }).client }),
      ).reconcileReplacement(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        expectedPriorGrantGeneration: priorGen,
      }));
      allFalse = allFalse && recon.advanced === false && recon.stillPrior === false
        && noLeak(recon);
    }
    ok('reconcile corrupt UUID/mailbox/resource/envelope never advanced', allFalse);

    const accessorState = makeGrantState({
      grant_generation: priorGen + 1, scope_version: 'phase_b_v1', last_operation_id: OP,
    });
    const accessorRow = ownDataRow(SNAP_COLS, accessorState);
    Object.defineProperty(accessorRow, 'provider_tenant_id', {
      enumerable: true, get() { return TENANT; },
    });
    let accessorFail = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({
        client: {
          async query() { return { rows: [accessorRow] }; },
        },
      })).reconcileReplacement(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        expectedPriorGrantGeneration: priorGen,
      }));
    } catch (e) {
      accessorFail = e && e.code === REPLACER_ERR && noLeak(e);
    }
    ok('reconcile accessor row fail-closed never advanced', accessorFail);

    let proxyHits = 0;
    const proxyTarget = ownDataRow(SNAP_COLS, baseAdv);
    const proxyRow = new Proxy(proxyTarget, {
      get(t, p, r) { proxyHits += 1; return Reflect.get(t, p, r); },
    });
    let proxyFail = false;
    try {
      await createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({
        client: {
          async query() { return { rows: [proxyRow] }; },
        },
      })).reconcileReplacement(Object.freeze({
        clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
        expectedPriorGrantGeneration: priorGen,
      }));
    } catch (e) {
      proxyFail = e && e.code === REPLACER_ERR && noLeak(e) && proxyHits === 0;
    }
    ok('reconcile transparent Proxy row fail-closed zero trap', proxyFail);

    const validRecon = await createMicrosoftPhaseBVerifiedGrantReplacer(
      Object.freeze({ client: createFakeReplacerClient({ state: baseAdv }).client }),
    ).reconcileReplacement(Object.freeze({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: OP,
      expectedPriorGrantGeneration: priorGen,
    }));
    ok('reconcile valid exact row still advanced=true secret-free',
      validRecon.advanced === true
      && validRecon.grantGeneration === String(priorGen + 1)
      && validRecon.lastOperationId === OP
      && validRecon.scopeVersion === 'phase_b_v1'
      && noLeak(validRecon));
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
  // Stock-PG multi-session activation: dedicated dual-gate only (never generic PG env).
  {
    const stockMode = resolveStockPgActivation(process.env);
    if (stockMode.action === 'run') {
      const child = runStockPgConcurrencyProofChild();
      const timedOut = !!(child.error && /ETIMEDOUT|TIMEOUT/i.test(String(child.error)));
      ok('schema_stock_pg_concurrency',
        !timedOut && stockPgChildPassed(child),
        timedOut ? 'child_timeout' : `status=${child && child.status}`);
    } else if (stockMode.action === 'refuse_no_guard') {
      skip('schema_stock_pg_concurrency',
        'dedicated stock PG URL present but SUNSET_EMAIL_PHASE_B_STOCK_PG_PROOF_ENABLED≠true — refuse mutate');
    } else if (stockMode.action === 'refuse_generic_only') {
      skip('schema_stock_pg_concurrency',
        'generic PG env without dedicated SUNSET_EMAIL_PHASE_B_STOCK_PG_URL+guard — refuse mutate');
    } else {
      skip('schema_stock_pg_concurrency',
        'stock PG env not configured — multi-session race activation blocker (dormant merge SKIP)');
    }
  }
  // Hostile dual-gate self-tests (local fake spawn / offline process). Never invent stock-PG PASS.
  {
    ok('stock_pg_mode_absent_is_skip',
      resolveStockPgActivation({}).action === 'skip_absent');
    ok('stock_pg_mode_generic_only_refuses',
      resolveStockPgActivation({ DATABASE_URL: 'postgresql://x', PGHOST: 'h' }).action
        === 'refuse_generic_only'
      && resolveStockPgActivation({ WH_DISPOSABLE_PG: '1' }).action === 'refuse_generic_only');
    ok('stock_pg_mode_url_without_guard_refuses',
      resolveStockPgActivation({ [STOCK_PG_URL_ENV]: 'postgresql://disposable/local' }).action
        === 'refuse_no_guard');
    ok('stock_pg_mode_dual_gate_runs',
      resolveStockPgActivation({
        [STOCK_PG_URL_ENV]: 'postgresql://disposable/local',
        [STOCK_PG_GUARD_ENV]: 'true',
      }).action === 'run');
    ok('stock_pg_mode_guard_false_string_refuses',
      resolveStockPgActivation({
        [STOCK_PG_URL_ENV]: 'postgresql://disposable/local',
        [STOCK_PG_GUARD_ENV]: '1',
      }).action === 'refuse_no_guard');

    // Live child gate: no env → REFUSE exit≠0, never PASS overall line.
    const refuseChild = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15_000,
      env: offlineChildEnv(),
    });
    ok('stock_pg_script_refuses_without_dual_gate',
      refuseChild.status !== 0
      && /REFUSE/.test(String(refuseChild.stdout || ''))
      && !stockPgChildPassed(refuseChild));

    // Guard without URL
    const guardOnly = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15_000,
      env: offlineChildEnv({ [STOCK_PG_GUARD_ENV]: 'true' }),
    });
    ok('stock_pg_script_refuses_guard_without_url',
      guardOnly.status !== 0
      && /REFUSE/.test(String(guardOnly.stdout || ''))
      && !stockPgChildPassed(guardOnly));

    // URL without guard
    const urlOnly = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15_000,
      env: offlineChildEnv({
        [STOCK_PG_URL_ENV]: 'postgresql://127.0.0.1:1/should-not-connect',
      }),
    });
    ok('stock_pg_script_refuses_url_without_guard',
      urlOnly.status !== 0
      && /REFUSE/.test(String(urlOnly.stdout || ''))
      && !stockPgChildPassed(urlOnly));

    // Generic PG env alone must not be treated as dual-gate run by the child.
    const genericOnly = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15_000,
      env: offlineChildEnv({
        DATABASE_URL: 'postgresql://127.0.0.1:1/generic',
        PGHOST: '127.0.0.1',
      }),
    });
    ok('stock_pg_script_ignores_generic_pg_env',
      genericOnly.status !== 0
      && /REFUSE/.test(String(genericOnly.stdout || ''))
      && !stockPgChildPassed(genericOnly));

    // Hostile near-miss PASS outputs must be rejected (never celebrate synthetic fake PASS).
    // Final PASS requires supervisor cleanup evidence fields — worker-only cannot PASS.
    const exactTranscript = buildPassTranscript(STOCK_PG_CHECK_NAMES.slice(), {
      supervisorCleanupVerified: true,
      zeroTokenBackends: true,
      schemaAbsent: true,
    });
    ok('stock_pg_exact_transcript_builder_shape',
      typeof exactTranscript === 'string'
      && exactTranscript.includes(`(${STOCK_PG_EXPECTED_CHECKS} checks)`)
      && stockPgChildPassed({ status: 0, stdout: exactTranscript, stderr: '', error: null }) === true);
    ok('stock_pg_transcript_rejects_absent_supervisor_evidence',
      buildPassTranscript(STOCK_PG_CHECK_NAMES.slice()) === null
      && buildPassTranscript(STOCK_PG_CHECK_NAMES.slice(), {
        supervisorCleanupVerified: false,
        zeroTokenBackends: true,
        schemaAbsent: true,
      }) === null
      && buildPassTranscript(STOCK_PG_CHECK_NAMES.slice(), {
        supervisorCleanupVerified: true,
        zeroTokenBackends: false,
        schemaAbsent: true,
      }) === null
      && stockPgChildPassed({
        status: 0,
        stdout: [
          ...STOCK_PG_CHECK_NAMES.map((n) => `PASS  ${n}`),
          '',
          `PASS prove-email-phase-b-stock-pg-concurrency (${STOCK_PG_EXPECTED_CHECKS} checks)`,
          JSON.stringify({
            ok: true, result: 'PASS', script: 'prove-email-phase-b-stock-pg-concurrency',
            checks: STOCK_PG_EXPECTED_CHECKS, schema: 'stock_pg_pass_v1',
          }),
          '',
        ].join('\n'),
        stderr: '',
      }) === false);
    const workerOnlyEvidence = stockPgProofMeta.buildWorkerEvidence(
      stockPgProofMeta.WORKER_CHECK_NAMES.slice(),
    );
    ok('stock_pg_worker_evidence_is_not_pass_transcript',
      !!workerOnlyEvidence
      && stockPgChildPassed({
        status: 0,
        stdout: `WORKER_EVIDENCE ${JSON.stringify(workerOnlyEvidence)}\n`,
        stderr: '',
      }) === false
      && stockPgProofMeta.parseWorkerEvidenceStdout(
        `WORKER_EVIDENCE ${JSON.stringify(workerOnlyEvidence)}\n`,
      ) != null);

    ok('stock_pg_child_passed_rejects_fail_status',
      stockPgChildPassed({
        status: 1,
        stdout: exactTranscript,
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_refuse',
      stockPgChildPassed({ status: 2, stdout: 'REFUSE  stock_pg_proof_not_configured\n', stderr: '' })
        === false);
    ok('stock_pg_child_passed_rejects_pass_line_without_json',
      stockPgChildPassed({
        status: 0,
        stdout: `PASS prove-email-phase-b-stock-pg-concurrency (${STOCK_PG_EXPECTED_CHECKS} checks)\n`,
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_arbitrary_check_count',
      stockPgChildPassed({
        status: 0,
        stdout: [
          'PASS  schema_isolated_temp_migrations_060_061_071',
          '',
          'PASS prove-email-phase-b-stock-pg-concurrency (1 checks)',
          JSON.stringify({
            ok: true, result: 'PASS', script: 'prove-email-phase-b-stock-pg-concurrency',
            checks: 1, schema: 'stock_pg_pass_v1',
          }),
          '',
        ].join('\n'),
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_prefix',
      stockPgChildPassed({
        status: 0,
        stdout: `noise\n${exactTranscript}`,
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_suffix',
      stockPgChildPassed({
        status: 0,
        stdout: `${exactTranscript}extra\n`,
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_duplicate_json',
      stockPgChildPassed({
        status: 0,
        stdout: exactTranscript.replace(/\n$/, '')
          + JSON.stringify({
            ok: true, result: 'PASS', script: 'prove-email-phase-b-stock-pg-concurrency',
            checks: STOCK_PG_EXPECTED_CHECKS, schema: 'stock_pg_pass_v1',
          }) + '\n',
        stderr: '',
      }) === false);
    ok('stock_pg_child_passed_rejects_nonempty_stderr',
      stockPgChildPassed({
        status: 0,
        stdout: exactTranscript,
        stderr: 'warning\n',
      }) === false);
    ok('stock_pg_child_passed_rejects_fake_spawn_wrong_checks',
      stockPgChildPassed(runStockPgConcurrencyProofChild({
        spawnImpl: () => ({
          status: 0,
          stdout: [
            'PASS prove-email-phase-b-stock-pg-concurrency (99 checks)',
            JSON.stringify({
              ok: true, result: 'PASS', script: 'prove-email-phase-b-stock-pg-concurrency',
              checks: 99, schema: 'stock_pg_pass_v1',
            }),
            '',
          ].join('\n'),
          stderr: '',
          error: null,
        }),
      })) === false);
    ok('stock_pg_activation_never_auto_pass_without_env',
      resolveStockPgActivation({}).action !== 'run'
      && resolveStockPgActivation({ DATABASE_URL: 'x' }).action !== 'run');

    // URL parser offline invariants (no live connect).
    {
      const parse = stockPgProofMeta.parseDedicatedStockPgUrl;
      let multiHostRejected = false;
      try {
        parse('postgresql://h1:5432,h2:5432/db');
      } catch (e) {
        multiHostRejected = stockPgProofMeta.localCode(e) === 'url_multi_host'
          || stockPgProofMeta.localCode(e) === 'url_parse_failed'
          || stockPgProofMeta.localCode(e) != null;
      }
      let unixRejected = false;
      try {
        parse('postgresql:///dbname');
      } catch (e) {
        unixRejected = stockPgProofMeta.localCode(e) != null;
      }
      let optionsRejected = false;
      try {
        parse('postgresql://127.0.0.1:5432/db?options=-csearch_path%3Dother');
      } catch (e) {
        optionsRejected = stockPgProofMeta.localCode(e) === 'url_forbidden_query';
      }
      let appNameQRejected = false;
      try {
        parse('postgresql://127.0.0.1:5432/db?application_name=evil');
      } catch (e) {
        appNameQRejected = stockPgProofMeta.localCode(e) === 'url_forbidden_query';
      }
      let sslFileRejected = false;
      try {
        parse('postgresql://127.0.0.1:5432/db?sslmode=verify-full&sslrootcert=/tmp/x');
      } catch (e) {
        sslFileRejected = stockPgProofMeta.localCode(e) === 'url_ssl_file_opts_unsupported';
      }
      let sslRequireRejected = false;
      try {
        parse('postgresql://127.0.0.1:5432/db?sslmode=require');
      } catch (e) {
        sslRequireRejected = stockPgProofMeta.localCode(e) === 'url_sslmode_not_verify_full';
      }
      let sslAbsentRejected = false;
      try {
        parse('postgresql://127.0.0.1:5432/stock_db');
      } catch (e) {
        sslAbsentRejected = stockPgProofMeta.localCode(e) === 'url_sslmode_required';
      }
      let okUrl = null;
      try {
        okUrl = parse('postgresql://127.0.0.1:5432/stock_db?sslmode=verify-full');
      } catch {
        okUrl = null;
      }
      const clientCfg = okUrl
        ? stockPgProofMeta.buildPgClientConfig(okUrl, {
          applicationName: 'r' + 'ab'.repeat(16) + '_boot',
          expectedHost: '127.0.0.1',
        })
        : null;
      ok('stock_pg_url_parser_rejects_multi_host_unix_options',
        multiHostRejected && unixRejected && optionsRejected && appNameQRejected
        && sslFileRejected && sslRequireRejected && sslAbsentRejected
        && okUrl && okUrl.host === '127.0.0.1' && okUrl.port === 5432
        && okUrl.database === 'stock_db'
        && clientCfg && clientCfg.ssl && clientCfg.ssl.rejectUnauthorized === true
        && clientCfg.ssl.servername === '127.0.0.1'
        && clientCfg.application_name
        && clientCfg.connectionString == null);
    }

    // Staging target identity offline (no live connect; never log expected host).
    {
      const resolveTarget = stockPgProofMeta.resolveStagingTargetIdentity;
      const parse = stockPgProofMeta.parseDedicatedStockPgUrl;
      const azureUrl = STOCK_PG_STAGING_URL;
      let parsedAzure = null;
      try { parsedAzure = parse(azureUrl); } catch { parsedAzure = null; }

      function targetCatch(env, urlParsed) {
        try {
          resolveTarget(env, urlParsed);
          return null;
        } catch (e) {
          return stockPgProofMeta.localCode(e);
        }
      }

      ok('stock_pg_target_requires_exact_envs',
        !!parsedAzure
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: STOCK_PG_AZURE_HOST,
        }, parsedAzure) === null
        && targetCatch({}, parsedAzure) === 'target_env_missing_or_wrong'
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
        }, parsedAzure) === 'expected_database_missing_or_wrong'
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
        }, parsedAzure) === 'expected_host_missing_or_wrong'
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: 'another-staging.postgres.database.azure.com',
        }, parsedAzure) === 'expected_host_missing_or_wrong');

      ok('stock_pg_target_rejects_wrong_database',
        !!parsedAzure
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_production',
          [STOCK_PG_EXPECTED_HOST_ENV]: STOCK_PG_AZURE_HOST,
        }, parsedAzure) === 'expected_database_missing_or_wrong');

      let prodLikeUrl = null;
      try {
        prodLikeUrl = parse(
          `postgresql://${STOCK_PG_AZURE_HOST}:5432/sunset_production?sslmode=verify-full`,
        );
      } catch { prodLikeUrl = null; }
      ok('stock_pg_target_rejects_production_like_db_in_url',
        !!prodLikeUrl
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: STOCK_PG_AZURE_HOST,
        }, prodLikeUrl) === 'url_database_target_mismatch');

      ok('stock_pg_target_rejects_non_azure_host_suffix',
        targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: 'sunset-staging.example.com',
        }, parsedAzure) === 'expected_host_not_azure_fqdn'
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: '127.0.0.1',
        }, parsedAzure) === 'expected_host_not_azure_fqdn'
        && targetCatch({
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: 'localhost',
        }, parsedAzure) === 'expected_host_not_azure_fqdn');

      // Dual-gate child without target envs must refuse/fail before connect (no PASS).
      const dualNoTarget = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
        encoding: 'utf8',
        cwd: ROOT,
        timeout: 15_000,
        env: offlineChildEnv({
          [STOCK_PG_URL_ENV]: STOCK_PG_STAGING_URL,
          [STOCK_PG_GUARD_ENV]: 'true',
        }),
      });
      ok('stock_pg_script_dual_gate_missing_target_refuses',
        dualNoTarget.status !== 0
        && !stockPgChildPassed(dualNoTarget)
        && /FAIL|REFUSE/.test(String(dualNoTarget.stdout || '')));

      const dualWrongDb = spawnSync(process.execPath, [path.join(ROOT, STOCK_PG_SCRIPT_REL)], {
        encoding: 'utf8',
        cwd: ROOT,
        timeout: 15_000,
        env: offlineChildEnv({
          [STOCK_PG_URL_ENV]:
            `postgresql://${STOCK_PG_AZURE_HOST}:5432/postgres?sslmode=verify-full`,
          [STOCK_PG_GUARD_ENV]: 'true',
          [STOCK_PG_TARGET_ENV]: 'sunset-staging',
          [STOCK_PG_EXPECTED_DB_ENV]: 'sunset_staging',
          [STOCK_PG_EXPECTED_HOST_ENV]: STOCK_PG_AZURE_HOST,
        }),
      });
      ok('stock_pg_script_dual_gate_wrong_url_db_refuses',
        dualWrongDb.status !== 0
        && !stockPgChildPassed(dualWrongDb)
        && /url_database_target_mismatch|FAIL/.test(String(dualWrongDb.stdout || '')));

      // Stdout must never echo expected host.
      ok('stock_pg_script_never_logs_expected_host',
        !String(dualNoTarget.stdout || '').includes(STOCK_PG_AZURE_HOST)
        && !String(dualWrongDb.stdout || '').includes(STOCK_PG_AZURE_HOST)
        && !String(dualNoTarget.stderr || '').includes(STOCK_PG_AZURE_HOST));
    }

    // Registry malformed / missing → cleanup_unverified (never silent empty list).
    {
      const load = stockPgProofMeta.loadRegistryForCleanup;
      const token = 'r' + 'ab'.repeat(16);
      const schema = 'pb_stock_testhost';
      ok('stock_pg_registry_missing_is_unverified',
        load('/tmp/pb_stock_reg_does_not_exist_xyz.json', token, schema, 0).ok === false
        && load('/tmp/pb_stock_reg_does_not_exist_xyz.json', token, schema, 0).code
          === 'cleanup_unverified');
      const badPath = path.join(require('os').tmpdir(), `pb_stock_reg_bad_${Date.now()}.json`);
      fs.writeFileSync(badPath, '{"truncated', 'utf8');
      ok('stock_pg_registry_malformed_is_unverified',
        load(badPath, token, schema, 0).ok === false);
      fs.writeFileSync(badPath, JSON.stringify({
        schema: stockPgProofMeta.REGISTRY_DOC_SCHEMA,
        revision: 1,
        run_token: 'r' + '00'.repeat(16),
        schema_name: schema,
        entries: [],
      }), 'utf8');
      ok('stock_pg_registry_wrong_token_is_unverified',
        load(badPath, token, schema, 0).ok === false);
      fs.writeFileSync(badPath, JSON.stringify({
        schema: stockPgProofMeta.REGISTRY_DOC_SCHEMA,
        revision: 0,
        run_token: token,
        schema_name: schema,
        entries: [],
      }), 'utf8');
      const goodEmpty = load(badPath, token, schema, 0);
      ok('stock_pg_registry_valid_empty_ok',
        goodEmpty.ok === true && Array.isArray(goodEmpty.entries) && goodEmpty.entries.length === 0);
      // Non-monotonic: require minRevision higher than file revision.
      ok('stock_pg_registry_non_monotonic_unverified',
        load(badPath, token, schema, 5).ok === false);
      try { fs.unlinkSync(badPath); } catch { /* ignore */ }
    }

    // Source wiring: dedicated script exists, exports dual-gate, npm command registered.
    const stockSrc = fs.readFileSync(path.join(ROOT, STOCK_PG_SCRIPT_REL), 'utf8');
    ok('stock_pg_script_dual_gate_source',
      stockSrc.includes(STOCK_PG_URL_ENV)
      && stockSrc.includes(STOCK_PG_GUARD_ENV)
      && stockSrc.includes(STOCK_PG_TARGET_ENV)
      && stockSrc.includes(STOCK_PG_EXPECTED_DB_ENV)
      && stockSrc.includes(STOCK_PG_EXPECTED_HOST_ENV)
      && /PROOF_ENABLED/.test(stockSrc)
      && /DATABASE_URL/.test(stockSrc)
      && /createPostgresOAuthTransactionRepository/.test(stockSrc)
      && /createPostgresPhaseBOauthTransactionConsumer/.test(stockSrc)
      && /createMicrosoftPhaseBVerifiedGrantReplacer/.test(stockSrc)
      && /reconcileReplacement/.test(stockSrc)
      && /DROP SCHEMA IF EXISTS/.test(stockSrc)
      && /lock_timeout/.test(stockSrc)
      && /statement_timeout/.test(stockSrc)
      && /pg_stat_activity/.test(stockSrc)
      && /pg_locks/.test(stockSrc)
      && /pg_blocking_pids/.test(stockSrc)
      && /application_name/.test(stockSrc)
      && /backend_start/.test(stockSrc)
      && /pg_cancel_backend/.test(stockSrc)
      && /pg_terminate_backend/.test(stockSrc)
      && /AbortController/.test(stockSrc)
      && /synthetic_commit_ack_loss/.test(stockSrc)
      && /cleanup_unverified/.test(stockSrc)
      && /unexpected_error/.test(stockSrc)
      && /installExternalTrafficTraps/.test(stockSrc)
      && /workers_settle_after_blocker_release/.test(stockSrc)
      && /supervisor_zero_run_token_backends_after_cleanup/.test(stockSrc)
      && /WORKER_EVIDENCE|buildWorkerEvidence/.test(stockSrc)
      && /supervisor_cleanup_verified/.test(stockSrc)
      && /enumerateLiveTokenBackends/.test(stockSrc)
      && /PINNED_ADDRS|pinnedIdentity|freezePinnedAddressSet|PINNED_SERVER_IDENTITY/.test(stockSrc)
      && /bootstrapAuthenticatedServerPin|offlineAuthenticatedBootstrapPinSeam/.test(stockSrc)
      && /assertTlsSessionAuthorized|tls_not_authorized|tls_not_encrypted/.test(stockSrc)
      && /assertObservedServerIdentity|freezePinnedServerIdentity/.test(stockSrc)
      && /inet_server_addr/.test(stockSrc)
      && /sslmode=verify-full|url_sslmode_not_verify_full|REQUIRED_SSLMODE/.test(stockSrc)
      && /cross_intent_phase_a_wrong_full_row_identical_while_match_blocked/.test(stockSrc)
      // Pin from authenticated bootstrap, not public-DNS membership alone.
      && /bootstrapAuthenticatedServerPin/.test(stockSrc)
      && !/pinnedAddrs = freezePinnedAddressSet\(await resolveHostAddressSet/.test(stockSrc)
      && !/no_deadlock/.test(stockSrc)
      && !/registry_backends_absent_after_cleanup/.test(stockSrc)
      && !/graph\.microsoft\.com/.test(stockSrc)
      && !/login\.microsoftonline\.com/.test(stockSrc));
    ok('stock_pg_script_no_create_extension',
      !/CREATE\s+EXTENSION/i.test(stockSrc));
    ok('stock_pg_script_no_hard_process_exit',
      // Worker/supervisor must not hard-exit; only process.exitCode assignment.
      !/\bprocess\.exit\s*\(/.test(stockSrc)
      && /AbortController/.test(stockSrc)
      && /ac\.abort\s*\(/.test(stockSrc));
    ok('stock_pg_script_no_sync_spawn_timeout',
      // Supervisor must use async spawn lifecycle — no spawnSync worker timeout.
      !/\bspawnSync\b/.test(stockSrc)
      && /spawnSupervisedWorker/.test(stockSrc)
      && /SIGTERM/.test(stockSrc)
      && /SIGKILL/.test(stockSrc)
      && /COOPERATIVE_CANCEL|cancelPath|CANCEL_ENV/.test(stockSrc));
    ok('stock_pg_script_no_raw_error_property_reads',
      // No printing/reading caught driver error .message/.code/.stack in handlers.
      !/catch\s*\(\s*e\s*\)\s*\{[^}]*e\.message/s.test(stockSrc)
      && !/catch\s*\(\s*e\s*\)\s*\{[^}]*e\.code/s.test(stockSrc)
      && !/catch\s*\(\s*err\s*\)\s*\{[^}]*err\.message/s.test(stockSrc)
      && !/\be\.stack\b/.test(stockSrc));
    ok('stock_pg_script_cleanup_terminal',
      /cleanup_failed|cleanup_schema_still_present|pool_end_failed|cleanup_unverified/.test(stockSrc)
      && /CLEANUP_MS/.test(stockSrc)
      && /DROP SCHEMA IF EXISTS/.test(stockSrc)
      && /pg_namespace/.test(stockSrc)
      && /cleanup_unverified/.test(stockSrc)
      && /pg_terminate_backend/.test(stockSrc)
      && /writeRegistryAtomic|fsyncSync/.test(stockSrc));
    ok('stock_pg_script_reviewer_workspace_path',
      stockSrc.includes('/opt/data/sunset-email-gate3-stock-pg')
      && /REVIEWER_WORKSPACE/.test(stockSrc));
    ok('stock_pg_script_blocker_overlap_primitives',
      /waitForExactBlockerOverlap|pg_blocking_pids/.test(stockSrc)
      && /pg_stat_activity/.test(stockSrc)
      && /FOR UPDATE/.test(stockSrc)
      && /runBlockedPair/.test(stockSrc)
      && /runCrossIntentSameRow/.test(stockSrc));
    ok('stock_pg_script_supervisor_worker_mode',
      /runSupervisor|runWorkerProof|STOCK_PG_WORKER|RUN_TOKEN/.test(stockSrc)
      && /makeRunToken/.test(stockSrc));
    ok('stock_pg_script_postcommit_ack_loss',
      /synthetic_commit_ack_loss/.test(stockSrc)
      && /OUTCOME_UNKNOWN/.test(stockSrc)
      && /reconcile_after_postcommit_ack_loss_advanced/.test(stockSrc)
      && /reconcile_after_precommit_failure_still_prior/.test(stockSrc));
    // Immutable expected digest (hardcoded) vs candidate exports — anti self-fulfillment.
    ok('stock_pg_expected_check_count_positive_frozen',
      Number.isInteger(STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT)
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT === STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.length
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT >= 40
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT === 58
      && Object.isFrozen(STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES)
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes('workers_settle_after_blocker_release')
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes(
        'no_expected_database_run_token_backends_active_or_waiting_after_settle',
      )
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes(
        'supervisor_zero_run_token_backends_after_cleanup',
      )
      && STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes(
        'cross_intent_phase_a_wrong_full_row_identical_while_match_blocked',
      )
      && !STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes('registry_backends_absent_after_cleanup')
      && !STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes('no_deadlock')
      && !STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES.includes(
        'no_run_backends_waiting_active_after_settle',
      )
      && STOCK_PG_CANDIDATE_EXPECTED_CHECKS === STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT
      && Array.isArray(STOCK_PG_CANDIDATE_CHECK_NAMES)
      && STOCK_PG_CANDIDATE_CHECK_NAMES.length === STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT
      && STOCK_PG_CANDIDATE_CHECK_NAMES.every(
        (n, i) => n === STOCK_PG_IMMUTABLE_EXPECTED_CHECK_NAMES[i],
      )
      && stockPgProofMeta.WORKER_CHECK_NAMES.length
        === STOCK_PG_IMMUTABLE_EXPECTED_CHECK_COUNT
          - stockPgProofMeta.SUPERVISOR_CHECK_NAMES.length
      && stockPgProofMeta.SUPERVISOR_CHECK_NAMES.includes('temp_schema_cleaned')
      && stockPgProofMeta.SUPERVISOR_CHECK_NAMES.includes(
        'supervisor_zero_run_token_backends_after_cleanup',
      ));

    // Hostile injectable fs: directory open/fsync/close failures are terminal (not accepted).
    {
      const token = 'r' + 'cd'.repeat(16);
      const schema = 'pb_stock_hostilefs';
      const regPath = path.join(require('os').tmpdir(), `pb_stock_reg_hostile_${Date.now()}.json`);
      const realFs = fs;
      function hostileWrite(kind) {
        const io = {
          openSync(...args) {
            if (kind === 'dir_open' && args[1] === 'r') throw new Error('hostile dir open');
            return realFs.openSync(...args);
          },
          writeFileSync: realFs.writeFileSync.bind(realFs),
          fsyncSync(fd) {
            // Detect directory fsync: after rename, dir open is 'r' — track via side channel.
            if (kind === 'dir_fsync' && io._lastOpenWasDir) throw new Error('hostile dir fsync');
            return realFs.fsyncSync(fd);
          },
          closeSync(fd) {
            if (kind === 'dir_close' && io._lastOpenWasDir) throw new Error('hostile dir close');
            const out = realFs.closeSync(fd);
            io._lastOpenWasDir = false;
            return out;
          },
          renameSync: realFs.renameSync.bind(realFs),
          unlinkSync: realFs.unlinkSync.bind(realFs),
          _lastOpenWasDir: false,
        };
        const origOpen = io.openSync;
        io.openSync = function openTracked(...args) {
          io._lastOpenWasDir = args[1] === 'r';
          return origOpen.apply(this, args);
        };
        try {
          stockPgProofMeta.writeRegistryAtomic(regPath, {
            schema: stockPgProofMeta.REGISTRY_DOC_SCHEMA,
            revision: 0,
            run_token: token,
            schema_name: schema,
            entries: [],
          }, io);
          return null;
        } catch (e) {
          return stockPgProofMeta.localCode(e);
        }
      }
      const openFail = hostileWrite('dir_open');
      const fsyncFail = hostileWrite('dir_fsync');
      const closeFail = hostileWrite('dir_close');
      ok('stock_pg_registry_hostile_fs_dir_failures_terminal',
        openFail === 'registry_dir_open_failed'
        && fsyncFail === 'registry_dir_fsync_failed'
        && closeFail === 'registry_dir_close_failed');
      try { fs.unlinkSync(regPath); } catch { /* ignore */ }
    }

    // Hostile unit seams: exact-identity exclusion, active+NULL wait, timeout abort,
    // worker-exit unverified registry retention (offline pure — not live runtime proof).
    {
      const control = {
        pid: 100,
        application_name: 'r' + 'ab'.repeat(16) + '_cleanup',
        backend_start: '2026-01-01 00:00:00+00',
        datname: 'sunset_staging',
        datid: 1,
      };
      // Duplicate same-role backend (same app_name, different PID) must NOT be excluded.
      const leakedSameRole = {
        pid: 101,
        application_name: control.application_name,
        backend_start: '2026-01-01 00:00:01+00',
        datname: 'sunset_staging',
        datid: 1,
        state: 'idle',
        wait_event_type: 'Client',
      };
      const liveDup = [control, leakedSameRole];
      const residualDup = stockPgProofMeta.excludeExactControlIdentity(liveDup, control);
      ok('stock_pg_hostile_duplicate_same_role_backend_included',
        residualDup.length === 1
        && residualDup[0].pid === 101
        && stockPgProofMeta.evaluateNoExpectedDatabaseRunTokenBackendsActiveOrWaiting(
          liveDup, control,
        ) === false);

      // state=active with wait_event_type NULL must fail (not only Lock waits).
      const activeNullWait = {
        pid: 200,
        application_name: 'r' + 'ab'.repeat(16) + '_w1',
        backend_start: '2026-01-01 00:00:02+00',
        datname: 'sunset_staging',
        datid: 1,
        state: 'active',
        wait_event_type: null,
      };
      ok('stock_pg_hostile_active_null_wait_rejected',
        stockPgProofMeta.tokenBackendIsActiveOrWaiting(activeNullWait) === true
        && stockPgProofMeta.evaluateNoExpectedDatabaseRunTokenBackendsActiveOrWaiting(
          [control, activeNullWait], control,
        ) === false);

      // Worker-exit unverified / cleanup unverified → preserve registry+cancel (no mutation).
      const exitUnverified = stockPgProofMeta.decideCleanupArtifactDisposition({
        workerExitUnverified: true,
      });
      const cleanupFail = stockPgProofMeta.decideCleanupArtifactDisposition({
        workerExitUnverified: false,
        cleanupVerified: false,
        schemaAbsent: false,
        zeroTokenBackends: false,
        cleanupCode: 'cleanup_unverified',
      });
      const cleanupOk = stockPgProofMeta.decideCleanupArtifactDisposition({
        workerExitUnverified: false,
        cleanupVerified: true,
        schemaAbsent: true,
        zeroTokenBackends: true,
      });
      const regArt = path.join(require('os').tmpdir(), `pb_stock_reg_retain_${Date.now()}.json`);
      const cancelArt = path.join(require('os').tmpdir(), `pb_stock_cancel_retain_${Date.now()}`);
      fs.writeFileSync(regArt, '{"schema":"stock_pg_registry_v1","revision":0,"entries":[]}\n', 'utf8');
      fs.writeFileSync(cancelArt, '1', 'utf8');
      // Prove disposition does not authorize delete when unverified; artifacts still on disk.
      ok('stock_pg_hostile_worker_exit_unverified_preserves_artifacts',
        exitUnverified.preserve === true
        && exitUnverified.deleteArtifacts === false
        && exitUnverified.mutate === false
        && exitUnverified.code === 'cleanup_unverified'
        && cleanupFail.preserve === true
        && cleanupFail.deleteArtifacts === false
        && cleanupOk.deleteArtifacts === true
        && cleanupOk.preserve === false
        && fs.existsSync(regArt)
        && fs.existsSync(cancelArt)
        && /artifact_id=pb_stock_reg_retain_/.test(
          stockPgProofMeta.formatRecoveryArtifactLine(regArt, cancelArt),
        )
        && !stockPgProofMeta.formatRecoveryArtifactLine(regArt, cancelArt).includes('password')
        && !stockPgProofMeta.formatRecoveryArtifactLine(regArt, cancelArt).includes('://'));
      // Do not delete when disposition says preserve (hostile proof artifacts remain).
      if (exitUnverified.preserve) {
        ok('stock_pg_hostile_unverified_artifacts_remain_on_disk',
          fs.existsSync(regArt) && fs.existsSync(cancelArt));
      } else {
        ok('stock_pg_hostile_unverified_artifacts_remain_on_disk', false);
      }
      try { fs.unlinkSync(regArt); } catch { /* ignore */ }
      try { fs.unlinkSync(cancelArt); } catch { /* ignore */ }

      // Timeout abort must destroy the exact control client socket (not mere Promise.race reject).
      {
        const child = spawnSync(process.execPath, ['-e', `
          const m = require(${JSON.stringify(path.join(ROOT, STOCK_PG_SCRIPT_REL))});
          let destroyed = 0;
          const fakeClient = {
            connection: { stream: { destroy() { destroyed += 1; } } },
            end(cb) { if (typeof cb === 'function') cb(); },
          };
          const hang = new Promise(() => {});
          m.withClientOpTimeout(fakeClient, hang, 40, 'hostile_op_timeout', 10)
            .then(() => { console.log(JSON.stringify({ ok: false, destroyed })); process.exit(0); })
            .catch((e) => {
              console.log(JSON.stringify({
                ok: m.localCode(e) === 'hostile_op_timeout' && destroyed >= 1,
                code: m.localCode(e),
                destroyed,
              }));
              process.exit(0);
            });
        `], { encoding: 'utf8', cwd: ROOT, timeout: 5_000, env: offlineChildEnv() });
        let body = null;
        try {
          const lines = String(child.stdout || '').trim().split('\n').filter(Boolean);
          body = JSON.parse(lines[lines.length - 1] || 'null');
        } catch { body = null; }
        ok('stock_pg_hostile_timeout_abort_destroys_control_client',
          child.status === 0 && body && body.ok === true && body.destroyed >= 1,
          JSON.stringify(body));
      }

      // Source must wire exact-identity exclusion + outer abort + recovery artifact path.
      ok('stock_pg_source_exact_control_identity_and_abort_wiring',
        /excludeExactControlIdentity/.test(stockSrc)
        && /sameBackendIdentity/.test(stockSrc)
        && /withClientOpTimeout/.test(stockSrc)
        && /abortActiveCleanupControl/.test(stockSrc)
        && /supervisorCleanupWithOuterTimeout/.test(stockSrc)
        && /decideCleanupArtifactDisposition/.test(stockSrc)
        && /formatRecoveryArtifactLine/.test(stockSrc)
        && /no_expected_database_run_token_backends_active_or_waiting_after_settle/.test(stockSrc)
        && !/idleOkRoles/.test(stockSrc)
        && !/no_run_backends_waiting_active_after_settle/.test(stockSrc));

      // Offline seam: authenticated bootstrap internal addr may differ from public DNS and
      // becomes the pin; cleanup mismatch against that pin rejects (fixed code only).
      {
        const seam = stockPgProofMeta.offlineAuthenticatedBootstrapPinSeam({
          bootstrap_observation: {
            server_addr: '10.33.0.4',
            database: 'sunset_staging',
            datid: 16384,
            server_version_num: 160003,
            system_identifier: '1234567890123456789',
          },
          // Public DNS A/AAAA results do not include Azure's internal backend address.
          dns_addrs: ['20.61.0.10', '20.61.0.11'],
          mismatch_server_addr: '203.0.113.9',
        });
        ok('stock_pg_offline_bootstrap_pin_may_differ_from_dns',
          seam
          && seam.ok === true
          && seam.pin_from_bootstrap_not_dns === true
          && seam.authenticated_addr_may_differ_from_dns === true
          && seam.authenticated_addr_in_public_dns === false
          && seam.azure_internal_addr_pin_ok_when_absent_from_dns === true
          && seam.exact_pin_match_accepts === true
          && seam.cleanup_mismatch_rejects === true
          && seam.mismatch_code === 'server_addr_not_in_pinned_set'
          // Fixed outputs only — seam must not embed host/address strings.
          && !JSON.stringify(seam).includes('10.33.0.4')
          && !JSON.stringify(seam).includes('20.61.0.10')
          && !JSON.stringify(seam).includes('203.0.113.9'));

        const pin = stockPgProofMeta.freezePinnedServerIdentity({
          server_addr: '10.33.0.4',
          database: 'sunset_staging',
          datid: 16384,
          server_version_num: 160003,
          system_identifier: '1234567890123456789',
        });
        let matchCode = null;
        try {
          stockPgProofMeta.assertObservedServerIdentity(
            {
              database: 'sunset_staging',
              server_addr: '10.33.0.4',
              datid: 16384,
              server_version_num: 160003,
              system_identifier: '1234567890123456789',
            },
            pin,
            { expectedDatabase: 'sunset_staging' },
          );
        } catch (e) {
          matchCode = stockPgProofMeta.localCode(e);
        }
        let mismatchCode = null;
        try {
          stockPgProofMeta.assertObservedServerIdentity(
            {
              database: 'sunset_staging',
              server_addr: '203.0.113.9',
              datid: 16384,
              server_version_num: 160003,
              system_identifier: '1234567890123456789',
            },
            pin,
            { expectedDatabase: 'sunset_staging' },
          );
        } catch (e) {
          mismatchCode = stockPgProofMeta.localCode(e);
        }
        ok('stock_pg_offline_cleanup_mismatch_refuses_wrong_server_addr',
          matchCode === null
          && mismatchCode === 'server_addr_not_in_pinned_set'
          && typeof stockPgProofMeta.bootstrapAuthenticatedServerPin === 'function'
          && typeof stockPgProofMeta.assertTlsSessionAuthorized === 'function'
          && stockPgProofMeta.PINNED_SERVER_IDENTITY_ENV
            === 'SUNSET_EMAIL_PHASE_B_STOCK_PG_PINNED_SERVER_IDENTITY');
      }
    }
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
    // Non-txn Phase A owners stay byte-identical. Transaction-service is intentionally
    // intent-hardened (B3a1); semantic isolation asserted by B2a/B2b + txn verifiers.
    const phaseA = [
      'scripts/lib/email-microsoft-token-response-scope.js',
      'scripts/lib/email-microsoft-verified-grant-custody.js',
      'scripts/lib/email-microsoft-verified-grant-installer.js',
      'scripts/lib/email-microsoft-delegated-oauth-contract.js',
    ];
    const base = 'c08a4d7b9275def16f98f870e124f823393ca4a5';
    let allSame = true;
    for (const f of phaseA) {
      const r = spawnSync('git', ['diff', '--quiet', base, '--', f], { cwd: ROOT });
      if (r.status !== 0) allSame = false;
    }
    ok('Phase A owners (non-txn) byte-identical vs base', allSame);
  }
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package has verify:email-phase-b-authority',
      pkg.scripts['verify:email-phase-b-authority'] === 'node scripts/verify-email-phase-b-authority.js');
    ok('package has prove:email-phase-b-stock-pg-concurrency',
      pkg.scripts[STOCK_PG_NPM]
        === `node ${STOCK_PG_SCRIPT_REL}`);
  }
  // Shared Azure SDK composition containment (export getters/proxies → zero hits)
  {
    const COMP = path.join(ROOT, 'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js');
    const src = fs.readFileSync(COMP, 'utf8');
    ok('loadAzureSdks own-data pin (no direct SDK property get)',
      /function readOwnDataExport\b/.test(src)
      && /getOwnPropertyDescriptor/.test(src)
      && /PINNED_IS_PROXY|isProxy/.test(src)
      && !/identity\.ManagedIdentityCredential/.test(src)
      && !/keys\.CryptographyClient/.test(src));
    const az = require('./lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
    const E_EN = az.ENV_COMPOSITION_ENABLED;
    const E_HOST = az.ENV_TRUSTED_HOST;
    const E_KID = az.ENV_VERSIONED_KEY_ID;
    const HOST = az.SUNSET_STAGING_TRUSTED_HOST;
    const KID = az.SUNSET_STAGING_VERSIONED_KEY_ID;
    const PRE = `
'use strict';
const Module=require('module');
const COMP=${JSON.stringify(COMP)};
const E_EN=${JSON.stringify(E_EN)},E_HOST=${JSON.stringify(E_HOST)},E_KID=${JSON.stringify(E_KID)};
const HOST=${JSON.stringify(HOST)},KID=${JSON.stringify(KID)};
const realLoad=Module._load;
function out(o){console.log(JSON.stringify(o));}
function enabled(){return {[E_EN]:'true',[E_HOST]:HOST,[E_KID]:KID};}
`;
    const getterChild = spawnSync(process.execPath, ['-e', PRE + `
      const expHits={micGet:0,ccGet:0,mic:0,cc:0};
      function ManagedIdentityCredential(){expHits.mic++;}
      function CryptographyClient(){expHits.cc++;}
      Module._load=function(r,p,m){
        if(r==='@azure/identity'){
          const o={}; Object.defineProperty(o,'ManagedIdentityCredential',{enumerable:true,get(){
            expHits.micGet++;return ManagedIdentityCredential;}}); return o;}
        if(r==='@azure/keyvault-keys'){
          const o={}; Object.defineProperty(o,'CryptographyClient',{enumerable:true,get(){
            expHits.ccGet++;return CryptographyClient;}}); return o;}
        if(typeof r==='string'&&r.startsWith('@azure/'))throw new Error('unexpected');
        return realLoad(r,p,m);};
      const mod=require(COMP); let code=null;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){code=e&&e.code;}
      out({ok:code==='envelope_azure_kv_sdk_unavailable'&&expHits.micGet===0&&expHits.ccGet===0
        &&expHits.mic===0&&expHits.cc===0,hits:expHits,code});
    `], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
    let getterBody = null;
    try {
      const lines = String(getterChild.stdout || '').trim().split('\n').filter(Boolean);
      getterBody = JSON.parse(lines[lines.length - 1] || 'null');
    } catch { getterBody = null; }
    ok('Azure export getters hits=0 construction fails closed',
      getterChild.status === 0 && getterBody && getterBody.ok, JSON.stringify(getterBody));
    const proxyChild = spawnSync(process.execPath, ['-e', PRE + `
      const expHits={get:0,mic:0,cc:0};
      function ManagedIdentityCredential(){expHits.mic++;}
      function CryptographyClient(){expHits.cc++;}
      Module._load=function(r,p,m){
        if(r==='@azure/identity'){
          return new Proxy({ManagedIdentityCredential},{get(t,k,rc){expHits.get++;return Reflect.get(t,k,rc);}});}
        if(r==='@azure/keyvault-keys'){
          return new Proxy({CryptographyClient},{get(t,k,rc){expHits.get++;return Reflect.get(t,k,rc);}});}
        if(typeof r==='string'&&r.startsWith('@azure/'))throw new Error('unexpected');
        return realLoad(r,p,m);};
      const mod=require(COMP); let code=null;
      try{mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(enabled());}
      catch(e){code=e&&e.code;}
      out({ok:code==='envelope_azure_kv_sdk_unavailable'&&expHits.get===0&&expHits.mic===0&&expHits.cc===0,
        hits:expHits,code});
    `], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
    let proxyBody = null;
    try {
      const lines = String(proxyChild.stdout || '').trim().split('\n').filter(Boolean);
      proxyBody = JSON.parse(lines[lines.length - 1] || 'null');
    } catch { proxyBody = null; }
    ok('Azure transparent Proxy module exports fail-closed zero get/construct',
      proxyChild.status === 0 && proxyBody && proxyBody.ok, JSON.stringify(proxyBody));
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
