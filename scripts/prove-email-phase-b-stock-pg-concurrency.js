'use strict';
/**
 * Gate 3 Phase B stock-PostgreSQL multi-session concurrency activation proof.
 *
 * Reviewer workspace (explicit path): /opt/data/sunset-email-gate3-stock-pg
 *
 * Disposable stock PG only. Explicit dual-gate required:
 *   SUNSET_EMAIL_PHASE_B_STOCK_PG_URL=<connection string>
 *   SUNSET_EMAIL_PHASE_B_STOCK_PG_PROOF_ENABLED=true
 *
 * Never uses DATABASE_URL / PGHOST / WH_DISPOSABLE_PG.
 * Never logs URL, credentials, host, secret-bearing errors, tokens, or provider identities.
 * Temp schema only; always DROP SCHEMA CASCADE with verified absence; cleanup failures terminal.
 *
 * Architecture:
 *   Supervisor owns unguessable run token + schema name, async-spawns worker with cooperative
 *   cancel file + SIGTERM + SIGKILL lifecycle (never sync-spawn hard timeout). Worker installs
 *   external-traffic traps before importing pg/production modules, runs proof, never hard-exits.
 *   Cleanup requires worker process exit first, then identity-bound cancel→terminate of
 *   registered backends (PID + application_name + backend_start + database + run-token), then
 *   schema drop only after every registered backend is absent. Registry is atomically persisted
 *   (temp+fsync+rename+dir fsync) with monotonic revision. Staging dual-gate requires exact
 *   target/host/database envs (Azure PG FQDN only). Server identity pin is the authenticated
 *   bootstrap session's inet_server_addr (TLS verify-full + expected-host SNI), not public DNS
 *   A/AAAA membership (Azure may report an internal backend address). PASS stdout is an exact
 *   bounded transcript.
 *
 * Authentic overlap: independent blocker locks the exact target row; observer requires
 * pg_blocking_pids(worker) contains the exact blocker PID, plus exact application_name and
 * database identity per worker. Unrelated lock waits fail the proof.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const { spawn } = require('child_process');

/** Explicit path for future reviewers / offline path assertions. */
const REVIEWER_WORKSPACE = '/opt/data/sunset-email-gate3-stock-pg';

const ROOT = path.resolve(__dirname, '..');
const URL_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_URL';
const GUARD_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_PROOF_ENABLED';
const WORKER_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_WORKER';
const RUN_TOKEN_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_RUN_TOKEN';
const SCHEMA_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_SCHEMA';
const REGISTRY_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_REGISTRY_FILE';
const CANCEL_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_CANCEL_FILE';
const TARGET_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_TARGET';
const EXPECTED_DATABASE_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_EXPECTED_DATABASE';
const EXPECTED_HOST_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_EXPECTED_HOST';
/** Legacy address-set env (single authenticated bootstrap addr only; not public DNS). */
const PINNED_ADDRS_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_PINNED_ADDRS';
/** Immutable authenticated server identity from supervisor bootstrap (JSON, no host logging). */
const PINNED_SERVER_IDENTITY_ENV = 'SUNSET_EMAIL_PHASE_B_STOCK_PG_PINNED_SERVER_IDENTITY';

const REQUIRED_TARGET = 'sunset-staging';
const REQUIRED_DATABASE = 'sunset_staging';
const REQUIRED_HOST = 'luna-sunset-staging-pg-app.postgres.database.azure.com';
const AZURE_PG_HOST_SUFFIX = '.postgres.database.azure.com';
const REGISTRY_DOC_SCHEMA = 'stock_pg_registry_v1';
const WORKER_EVIDENCE_SCHEMA = 'stock_pg_worker_evidence_v1';
const REQUIRED_SSLMODE = 'verify-full';

const CONNECT_MS = 3_000;
const STATEMENT_MS = 2_000;
const LOCK_MS = 1_000;
const RACE_STATEMENT_MS = 12_000;
const RACE_LOCK_MS = 10_000;
const OVERLAP_POLL_MS = 6_000;
const OVERLAP_POLL_INTERVAL_MS = 40;
const CLEANUP_MS = 12_000;
const CLEANUP_STEP_MS = 3_000;
const OVERALL_MS = 75_000;
const WORKER_TIMEOUT_MS = OVERALL_MS + CLEANUP_MS + 5_000;
const SUPERVISOR_CLEANUP_MS = CLEANUP_MS + 4_000;
const COOPERATIVE_CANCEL_MS = 3_000;
const SIGTERM_WAIT_MS = 3_000;
const SIGKILL_WAIT_MS = 2_000;
const BACKEND_ABSENCE_MS = 4_000;
const BACKEND_ABSENCE_POLL_MS = 50;
const SETTLE_AFTER_RELEASE_MS = 3_000;
const SETTLE_AFTER_CANCEL_MS = 100;
const MAX_CHILD_STDOUT = 512 * 1024;
const MAX_CHILD_STDERR = 64 * 1024;
const POOL_MAX = 8;

const HUGE_N = '9007199254740992';
const HUGE_N1 = '9007199254740993';

/** Fixed ordered check names — PASS transcript must emit exactly these in order. */
const CHECK_NAMES = Object.freeze([
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
const EXPECTED_CHECK_COUNT = CHECK_NAMES.length;
/** Worker emits ordered evidence for all checks except supervisor-owned finals. */
const WORKER_CHECK_NAMES = Object.freeze(CHECK_NAMES.slice(0, -2));
const SUPERVISOR_CHECK_NAMES = Object.freeze(CHECK_NAMES.slice(-2));
const PASS_SCRIPT = 'prove-email-phase-b-stock-pg-concurrency';
const PASS_JSON_KEYS = Object.freeze([
  'ok', 'result', 'script', 'checks', 'schema',
  'supervisor_cleanup_verified', 'supervisor_zero_token_backends', 'supervisor_schema_absent',
]);
const PASS_JSON_SCHEMA = 'stock_pg_pass_v1';

const ROLE = Object.freeze({
  boot: 'boot',
  seed: 'seed',
  blocker: 'blocker',
  worker1: 'w1',
  worker2: 'w2',
  observer: 'obs',
  cleanup: 'cleanup',
  verify: 'verify',
});

const IDS = Object.freeze({
  client: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  location: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  staff: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  session: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  endpoint: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  endpointB: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  opA: '11111111-1111-4111-8111-111111111111',
  opB: '22222222-2222-4222-8222-222222222222',
  opC: '33333333-3333-4333-8333-333333333333',
  tenant: '44444444-4444-4444-8444-444444444444',
  principal: '55555555-5555-4555-8555-555555555555',
});
const MAIL = 'front@sunset.example';
const LOCATION_SLUG = 'stock-pg-proof';
const CAPS_J = JSON.stringify({
  push_notifications: false, provider_threads: false, remote_drafts: false,
  reply: false, reply_all: false, forward: false,
  attachments_metadata: false, delivery_events: false,
});

/** Local failure codes only — never read/print raw caught `.message`/`.code`/stack. */
const LOCAL = new WeakMap();
function localFail(code) {
  const e = new Error('stock_pg_proof');
  e.name = 'StockPgProofLocal';
  LOCAL.set(e, code);
  return e;
}
function localCode(e) {
  if (e && LOCAL.has(e)) return LOCAL.get(e);
  return null;
}
function rethrowLocalOr(code, e) {
  if (localCode(e)) throw e;
  throw localFail(code);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(localFail('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(localFail('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(localFail(code || 'step_timeout')), ms);
    }),
  ]);
}

/**
 * Active cleanup/control client for outer AbortController cancellation.
 * Timeout must destroy this exact socket — never leave the underlying query running.
 * @type {{client: any, identity: object|null}|null}
 */
let activeCleanupControl = null;

function trackActiveCleanupControl(client, identity) {
  activeCleanupControl = { client: client || null, identity: identity || null };
}

function untrackActiveCleanupControl(client) {
  if (activeCleanupControl && activeCleanupControl.client === client) {
    activeCleanupControl = null;
  }
}

/** Destroy the exact active cleanup control client socket (if any). */
function abortActiveCleanupControl() {
  const cur = activeCleanupControl;
  if (!cur || !cur.client) return false;
  forceDestroyClient(cur.client);
  return true;
}

/**
 * Pure identity match: PID + application_name + backend_start + DB identity.
 * Never match by role/application_name alone.
 */
function sameBackendIdentity(a, b) {
  if (!a || !b) return false;
  if (Number(a.pid) !== Number(b.pid)) return false;
  if (String(a.application_name || '') !== String(b.application_name || '')) return false;
  if (String(a.backend_start || '') !== String(b.backend_start || '')) return false;
  if (String(a.datname || '') !== String(b.datname || '')) return false;
  const ad = a.datid == null ? null : Number(a.datid);
  const bd = b.datid == null ? null : Number(b.datid);
  if (ad != null && bd != null && ad !== bd) return false;
  return true;
}

/**
 * Exclude only the exact current control connection identity from a backend list.
 * A leaked second cleanup/verify/observer role with the same app_name must remain.
 */
function excludeExactControlIdentity(backends, controlIdentity) {
  const list = Array.isArray(backends) ? backends : [];
  if (!controlIdentity) return list.slice();
  return list.filter((b) => !sameBackendIdentity(b, controlIdentity));
}

/**
 * Active fails regardless of wait_event_type (including NULL).
 * Any non-null wait_event_type indicates a wait and fails.
 */
function tokenBackendIsActiveOrWaiting(b) {
  if (!b) return true;
  if (String(b.state || '') === 'active') return true;
  if (b.wait_event_type != null && String(b.wait_event_type) !== '') return true;
  return false;
}

/**
 * Pure evaluation over enumerated expected-database token backends.
 * Excludes only exact control identity — never broad role/application_name.
 * @returns {boolean} true when none of the non-control backends are active/waiting
 */
function evaluateNoExpectedDatabaseRunTokenBackendsActiveOrWaiting(live, controlIdentity) {
  const residual = excludeExactControlIdentity(live, controlIdentity);
  for (const b of residual) {
    if (tokenBackendIsActiveOrWaiting(b)) return false;
  }
  return true;
}

/**
 * Artifact disposition: delete registry/cancel only after verified cleanup.
 * Unverified / worker-exit-unverified / failed → preserve for operator recovery.
 */
function decideCleanupArtifactDisposition(opts) {
  const o = opts || {};
  if (o.workerExitUnverified === true) {
    return Object.freeze({
      deleteArtifacts: false,
      preserve: true,
      code: 'cleanup_unverified',
      mutate: false,
    });
  }
  if (o.cleanupVerified === true
      && o.schemaAbsent === true
      && o.zeroTokenBackends === true) {
    return Object.freeze({
      deleteArtifacts: true,
      preserve: false,
      code: null,
      mutate: true,
    });
  }
  return Object.freeze({
    deleteArtifacts: false,
    preserve: true,
    code: o.cleanupCode || 'cleanup_unverified',
    mutate: false,
  });
}

/** Public recovery line: basename IDs only — never host/URL/secrets. */
function formatRecoveryArtifactLine(registryPath, cancelPath) {
  const regId = registryPath ? path.basename(String(registryPath)) : '';
  const cancelId = cancelPath ? path.basename(String(cancelPath)) : '';
  return `RECOVERY  artifact_id=${regId} cancel_id=${cancelId}`;
}

/**
 * Bound a control-client operation: on timeout, destroy that exact client socket so the
 * underlying query cannot continue on the connection; then await bounded settlement.
 * Do not merely reject Promise.race while the operation keeps running.
 *
 * @param {any} client control client whose socket must die on timeout
 * @param {Promise<any>|function(): Promise<any>} promiseOrFactory
 * @param {number} ms
 * @param {string} code
 * @param {number} [settleMs]
 */
async function withClientOpTimeout(client, promiseOrFactory, ms, code, settleMs) {
  const settle = settleMs != null ? settleMs : SETTLE_AFTER_CANCEL_MS;
  const failCode = code || 'step_timeout';
  let timer = null;
  let finished = false;
  let aborted = false;
  const promise = typeof promiseOrFactory === 'function'
    ? promiseOrFactory()
    : promiseOrFactory;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (finished) return;
      aborted = true;
      try { forceDestroyClient(client); } catch { /* ignore */ }
      reject(localFail(failCode));
    }, ms);
  });
  try {
    const result = await Promise.race([
      Promise.resolve(promise).finally(() => {
        finished = true;
        if (timer) clearTimeout(timer);
      }),
      timeoutPromise,
    ]);
    return result;
  } catch (e) {
    if (aborted || localCode(e) === failCode) {
      try { forceDestroyClient(client); } catch { /* ignore */ }
      try {
        await sleep(settle);
      } catch { /* ignore */ }
      // Surface fixed local code (not driver secrets).
      throw localFail(failCode);
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve activation mode without reading connection secrets into logs.
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveStockPgProofMode(env) {
  const e = env || process.env;
  const raw = e[URL_ENV];
  const hasUrl = typeof raw === 'string' && raw.trim().length > 0;
  const guardOn = e[GUARD_ENV] === 'true';
  const genericPg = !!(e.DATABASE_URL || e.PGHOST || e.WH_DISPOSABLE_PG);
  if (hasUrl && guardOn) return { mode: 'run', hasUrl, guardOn, genericPg };
  if (hasUrl && !guardOn) return { mode: 'refuse_no_guard', hasUrl, guardOn, genericPg };
  if (genericPg) return { mode: 'refuse_generic_only', hasUrl, guardOn, genericPg };
  return { mode: 'skip_absent', hasUrl, guardOn, genericPg };
}

function makeSchemaName() {
  const suffix = crypto.randomBytes(10).toString('hex');
  const name = `pb_stock_${suffix}`;
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw localFail('schema_name_invalid');
  return name;
}

function makeRunToken() {
  const token = `r${crypto.randomBytes(16).toString('hex')}`;
  if (!/^r[a-f0-9]{32}$/.test(token)) throw localFail('run_token_invalid');
  return token;
}

function appNameFor(runToken, role) {
  if (typeof runToken !== 'string' || !/^r[a-f0-9]{32}$/.test(runToken)) {
    throw localFail('run_token_invalid');
  }
  if (typeof role !== 'string' || !/^[a-z][a-z0-9_]*$/.test(role)) {
    throw localFail('app_role_invalid');
  }
  return `${runToken}_${role}`;
}

function appNameHasRunToken(applicationName, runToken) {
  return typeof applicationName === 'string'
    && typeof runToken === 'string'
    && applicationName.startsWith(`${runToken}_`);
}

/**
 * Dedicated URL parsing — rejects multi-host, unix sockets, query options that alter
 * search_path/application_name, and SSL file options.
 * Requires exact sslmode=verify-full (rejects disable/allow/prefer/require/verify-ca/absent).
 * application_name is set only via startup parameters (never from URL).
 * @param {string} raw
 */
function parseDedicatedStockPgUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw localFail('url_missing');
  const trimmed = raw.trim();
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    throw localFail('url_parse_failed');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw localFail('url_protocol');
  }
  // Multi-host libpq form: host1,host2 in authority.
  const authority = trimmed.replace(/^(postgres|postgresql):\/\//i, '').split('/')[0].split('?')[0];
  const hostAuthority = authority.includes('@') ? authority.split('@').pop() : authority;
  if (hostAuthority.includes(',')) throw localFail('url_multi_host');
  if (!u.hostname) throw localFail('url_unix_socket_or_empty_host');
  if (u.hostname.startsWith('/') || u.hostname.includes('/')) throw localFail('url_unix_socket');
  if (trimmed.includes('?host=/') || /[?&]host=%2F/i.test(trimmed)) throw localFail('url_unix_socket');

  let sslmodeSeen = false;
  for (const key of u.searchParams.keys()) {
    const k = String(key).toLowerCase();
    if (
      k === 'options'
      || k === 'search_path'
      || k === 'application_name'
      || k === 'fallback_application_name'
      || k === 'uselibpqcompat'
      || k.includes('search_path')
    ) {
      throw localFail('url_forbidden_query');
    }
    if (k === 'sslmode') {
      sslmodeSeen = true;
      const v = String(u.searchParams.get(key) || '').toLowerCase();
      // Reject disable/allow/prefer/require/verify-ca/no-verify/absent — only verify-full.
      if (v !== REQUIRED_SSLMODE) throw localFail('url_sslmode_not_verify_full');
    }
    if (['sslrootcert', 'sslcert', 'sslkey', 'sslcrl', 'sslpassword', 'sslcompression', 'ssl'].includes(k)) {
      throw localFail('url_ssl_file_opts_unsupported');
    }
  }
  if (!sslmodeSeen) throw localFail('url_sslmode_required');

  const port = u.port ? Number(u.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw localFail('url_port');
  const dbPath = (u.pathname || '').replace(/^\//, '');
  const database = dbPath.split('/')[0] || '';
  if (!database || database.includes(',')) throw localFail('url_database_missing');

  return Object.freeze({
    connectionString: trimmed,
    host: u.hostname.toLowerCase(),
    port,
    database,
    user: decodeURIComponent(u.username || ''),
    // Password retained only for client construction; never logged.
    password: decodeURIComponent(u.password || ''),
  });
}

/**
 * Build pg Client config that preserves verify-full semantics.
 * Discrete fields (not connectionString) so node-pg cannot clobber ssl with weaker modes.
 * application_name is a startup parameter (eliminates post-connect SET race).
 */
function buildPgClientConfig(parsedUrl, opts) {
  const applicationName = opts && opts.applicationName;
  const expectedHost = opts && opts.expectedHost;
  const connectionTimeoutMillis = (opts && opts.connectionTimeoutMillis) != null
    ? opts.connectionTimeoutMillis
    : CONNECT_MS;
  if (!parsedUrl || typeof parsedUrl.host !== 'string') throw localFail('url_missing');
  if (typeof applicationName !== 'string' || !applicationName) throw localFail('app_role_invalid');
  if (typeof expectedHost !== 'string' || !expectedHost) throw localFail('expected_host_missing_or_wrong');
  return {
    host: parsedUrl.host,
    port: parsedUrl.port,
    database: parsedUrl.database,
    user: parsedUrl.user,
    password: parsedUrl.password,
    application_name: applicationName,
    connectionTimeoutMillis,
    ssl: Object.freeze({
      rejectUnauthorized: true,
      servername: expectedHost,
    }),
  };
}

/**
 * Staging dual-gate target identity. Never logs host/URL. Refuse before schema create.
 * @param {NodeJS.ProcessEnv} env
 * @param {{host: string, database: string}} parsedUrl
 */
function resolveStagingTargetIdentity(env, parsedUrl) {
  const e = env || process.env;
  const target = e[TARGET_ENV];
  const expectedDatabase = e[EXPECTED_DATABASE_ENV];
  const expectedHostRaw = e[EXPECTED_HOST_ENV];
  if (target !== REQUIRED_TARGET) throw localFail('target_env_missing_or_wrong');
  if (expectedDatabase !== REQUIRED_DATABASE) throw localFail('expected_database_missing_or_wrong');
  if (typeof expectedHostRaw !== 'string' || !expectedHostRaw.trim()) {
    throw localFail('expected_host_missing_or_wrong');
  }
  const expectedHost = expectedHostRaw.trim().toLowerCase();
  // Canonical Azure PostgreSQL FQDN only — no IP/localhost/private aliases.
  if (
    expectedHost === 'localhost'
    || expectedHost === '127.0.0.1'
    || expectedHost === '::1'
    || expectedHost === '0.0.0.0'
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(expectedHost)
    || expectedHost.includes(':')
    || expectedHost.endsWith('.local')
    || expectedHost.endsWith('.internal')
    || /^(10|127|192\.168|169\.254)\./.test(expectedHost)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(expectedHost)
  ) {
    throw localFail('expected_host_not_azure_fqdn');
  }
  if (!expectedHost.endsWith(AZURE_PG_HOST_SUFFIX)) {
    throw localFail('expected_host_not_azure_fqdn');
  }
  const label = expectedHost.slice(0, -AZURE_PG_HOST_SUFFIX.length);
  if (!label || label.includes('/') || label.includes(' ') || label.startsWith('.') || label.endsWith('.')) {
    throw localFail('expected_host_not_azure_fqdn');
  }
  if (expectedHost !== REQUIRED_HOST) {
    throw localFail('expected_host_missing_or_wrong');
  }
  if (parsedUrl.host !== expectedHost) throw localFail('url_host_target_mismatch');
  if (parsedUrl.database !== expectedDatabase) throw localFail('url_database_target_mismatch');
  return Object.freeze({
    target: REQUIRED_TARGET,
    expectedDatabase: REQUIRED_DATABASE,
    expectedHost,
  });
}

function canonicalizeIp(addr) {
  if (typeof addr !== 'string' || !addr) return '';
  let a = addr.trim().toLowerCase();
  // Strip IPv4-mapped IPv6 prefix.
  if (a.startsWith('::ffff:')) a = a.slice(7);
  // Strip zone id if present.
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  return a;
}

/**
 * Resolve expected host to a set of canonical IP strings (IPv4 + IPv6).
 * DNS is used only for connecting to the expected FQDN; pin membership is NOT derived
 * from this set (Azure inet_server_addr may be an internal address absent from public DNS).
 * @param {string} hostname
 * @returns {Promise<Set<string>>}
 */
async function resolveHostAddressSet(hostname) {
  const set = new Set();
  const lookup = dns.promises.lookup;
  const resolve4 = dns.promises.resolve4;
  const resolve6 = dns.promises.resolve6;
  try {
    const all = await lookup(hostname, { all: true });
    for (const e of all || []) {
      if (e && e.address) set.add(canonicalizeIp(e.address));
    }
  } catch {
    // continue with resolve*
  }
  try {
    for (const a of await resolve4(hostname)) set.add(canonicalizeIp(a));
  } catch { /* no A */ }
  try {
    for (const a of await resolve6(hostname)) set.add(canonicalizeIp(a));
  } catch { /* no AAAA */ }
  if (set.size === 0) throw localFail('expected_host_dns_unresolved');
  return set;
}

/**
 * Freeze a set of canonical addresses (utility / offline seam). Not the sole pin source.
 * @param {Iterable<string>} addrs
 * @returns {ReadonlySet<string>}
 */
function freezePinnedAddressSet(addrs) {
  const set = new Set();
  for (const a of addrs || []) {
    const c = canonicalizeIp(String(a));
    if (c) set.add(c);
  }
  if (set.size === 0) throw localFail('pinned_addrs_empty');
  return set;
}

function serializePinnedAddressSet(pinnedSet) {
  return JSON.stringify([...pinnedSet].sort());
}

function parsePinnedAddressSet(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw localFail('pinned_addrs_missing');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw localFail('pinned_addrs_invalid');
  }
  if (!Array.isArray(arr) || arr.length === 0) throw localFail('pinned_addrs_invalid');
  return freezePinnedAddressSet(arr);
}

/**
 * Freeze immutable authenticated server identity pin (no hostnames; fixed fields only).
 * server_addr is the canonicalized inet_server_addr from the TLS-authenticated bootstrap.
 * @param {object} raw
 * @returns {Readonly<{server_addr: string, database: string, datid: number, server_version_num: number|null, system_identifier: string|null}>}
 */
function freezePinnedServerIdentity(raw) {
  if (!raw || typeof raw !== 'object') throw localFail('pinned_identity_invalid');
  const server_addr = canonicalizeIp(String(raw.server_addr || ''));
  if (!server_addr) throw localFail('pinned_identity_invalid');
  const database = String(raw.database || '');
  if (database !== REQUIRED_DATABASE) throw localFail('pinned_identity_invalid');
  const datidNum = raw.datid == null ? NaN : Number(raw.datid);
  if (!Number.isInteger(datidNum) || datidNum <= 0 || !Number.isSafeInteger(datidNum)) {
    throw localFail('pinned_identity_invalid');
  }
  let server_version_num = null;
  if (raw.server_version_num != null && raw.server_version_num !== '') {
    const v = Number(raw.server_version_num);
    if (!Number.isInteger(v) || v <= 0 || !Number.isSafeInteger(v)) {
      throw localFail('pinned_identity_invalid');
    }
    server_version_num = v;
  }
  let system_identifier = null;
  if (raw.system_identifier != null && raw.system_identifier !== '') {
    const s = String(raw.system_identifier);
    // Numeric text only — never log; reject free-form.
    if (!/^\d{1,30}$/.test(s)) throw localFail('pinned_identity_invalid');
    system_identifier = s;
  }
  return Object.freeze({
    server_addr,
    database,
    datid: datidNum,
    server_version_num,
    system_identifier,
  });
}

function serializePinnedServerIdentity(id) {
  if (!id || typeof id.server_addr !== 'string') throw localFail('pinned_identity_invalid');
  return JSON.stringify({
    server_addr: id.server_addr,
    database: id.database,
    datid: id.datid,
    server_version_num: id.server_version_num,
    system_identifier: id.system_identifier,
  });
}

function parsePinnedServerIdentity(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw localFail('pinned_identity_missing');
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw localFail('pinned_identity_invalid');
  }
  return freezePinnedServerIdentity(obj);
}

/**
 * Pure observation-vs-pin check (no client). Used online after query and offline seams.
 * @param {object} observed
 * @param {object} pin freezePinnedServerIdentity result
 * @param {{expectedDatabase: string}} target
 */
function assertObservedServerIdentity(observed, pin, target) {
  if (!pin || typeof pin.server_addr !== 'string' || !pin.server_addr) {
    throw localFail('pinned_identity_missing');
  }
  if (!observed || typeof observed !== 'object') throw localFail('server_identity_query_failed');
  const expectedDb = target && target.expectedDatabase;
  const db = observed.database != null ? String(observed.database) : '';
  if (
    !expectedDb
    || db !== expectedDb
    || db !== pin.database
    || db !== REQUIRED_DATABASE
  ) {
    throw localFail('database_identity_mismatch');
  }
  const serverAddr = canonicalizeIp(String(observed.server_addr || ''));
  if (!serverAddr) throw localFail('server_addr_missing');
  // Exact equality to authenticated bootstrap pin — not public-DNS membership.
  if (serverAddr !== pin.server_addr) throw localFail('server_addr_not_in_pinned_set');
  const datid = observed.datid == null ? null : Number(observed.datid);
  if (datid !== pin.datid) throw localFail('database_oid_mismatch');
  if (pin.server_version_num != null) {
    const v = observed.server_version_num == null ? null : Number(observed.server_version_num);
    if (v !== pin.server_version_num) throw localFail('server_version_mismatch');
  }
  if (pin.system_identifier != null) {
    if (String(observed.system_identifier || '') !== pin.system_identifier) {
      throw localFail('system_identifier_mismatch');
    }
  }
}

/**
 * Require node-postgres TLS socket: encrypted + authorized (verify-full already enforced at connect).
 * @param {any} client
 */
function assertTlsSessionAuthorized(client) {
  const stream = client && client.connection && client.connection.stream;
  if (!stream) throw localFail('tls_stream_missing');
  if (stream.encrypted !== true) throw localFail('tls_not_encrypted');
  if (stream.authorized !== true) throw localFail('tls_not_authorized');
}

/**
 * Read server identity observation from an authenticated session (no extensions).
 * system_identifier is optional when unavailable.
 * @param {any} client
 */
async function queryServerIdentityObservation(client) {
  let row;
  try {
    const r = await withClientOpTimeout(
      client,
      () => client.query(
        `SELECT current_database()::text AS database,
                inet_server_addr()::text AS server_addr,
                (SELECT oid FROM pg_database WHERE datname = current_database())::bigint AS datid,
                current_setting('server_version_num')::int AS server_version_num`,
      ),
      CLEANUP_STEP_MS,
      'server_identity_query_timeout',
    );
    row = r && r.rows && r.rows[0];
  } catch (e) {
    if (localCode(e)) throw e;
    throw localFail('server_identity_query_failed');
  }
  if (!row) throw localFail('server_identity_query_failed');
  let system_identifier = null;
  try {
    const r2 = await withClientOpTimeout(
      client,
      () => client.query('SELECT system_identifier::text AS sid FROM pg_control_system()'),
      CLEANUP_STEP_MS,
      'server_identity_query_timeout',
    );
    const sid = r2 && r2.rows && r2.rows[0] && r2.rows[0].sid;
    if (sid != null && String(sid) !== '') {
      const s = String(sid);
      if (/^\d{1,30}$/.test(s)) system_identifier = s;
    }
  } catch (e) {
    if (localCode(e) === 'server_identity_query_timeout') throw e;
    // Optional without extensions/privileges — leave null.
    system_identifier = null;
  }
  return {
    database: row.database,
    server_addr: row.server_addr,
    datid: row.datid,
    server_version_num: row.server_version_num,
    system_identifier,
  };
}

/**
 * After connect: TLS authorized + current_database exact + inet_server_addr exact pin equality
 * (+ datid / optional version / system_identifier). Never re-resolve DNS for membership.
 * @param {any} client
 * @param {{expectedDatabase: string, expectedHost: string}} target
 * @param {object} pinnedIdentity freezePinnedServerIdentity result
 */
async function assertConnectedServerIdentity(client, target, pinnedIdentity) {
  if (!pinnedIdentity || typeof pinnedIdentity.server_addr !== 'string') {
    throw localFail('pinned_identity_missing');
  }
  assertTlsSessionAuthorized(client);
  const observed = await queryServerIdentityObservation(client);
  assertObservedServerIdentity(observed, pinnedIdentity, target);
}

/**
 * Supervisor bootstrap: one Client to exact URL host/database with TLS verify-full + expected-host
 * SNI (traps must already allow nested net + existing-socket TLS wrap). Pin authenticated
 * inet_server_addr — do not require it to appear in public DNS. Bounded close; no registry.
 * @param {{Client: any, parsedUrl: object, stagingTarget: object, runToken: string}} opts
 * @returns {Promise<object>} freezePinnedServerIdentity result
 */
async function bootstrapAuthenticatedServerPin(opts) {
  const Client = opts && opts.Client;
  const parsedUrl = opts && opts.parsedUrl;
  const stagingTarget = opts && opts.stagingTarget;
  const runToken = opts && opts.runToken;
  if (!Client || !parsedUrl || !stagingTarget || !runToken) {
    throw localFail('bootstrap_failed');
  }
  if (!trapsInstalled) throw localFail('traps_not_installed_before_bootstrap');
  const name = appNameFor(runToken, ROLE.boot);
  const client = new Client(buildPgClientConfig(parsedUrl, {
    applicationName: name,
    expectedHost: stagingTarget.expectedHost,
    connectionTimeoutMillis: CONNECT_MS,
  }));
  try {
    try {
      await withClientOpTimeout(
        client,
        () => client.connect(),
        CONNECT_MS + 500,
        'bootstrap_connect_timeout',
      );
    } catch (e) {
      await safeEndUnregisteredClient(client);
      if (localCode(e)) throw e;
      throw localFail('bootstrap_connect_failed');
    }
    let pin;
    try {
      assertTlsSessionAuthorized(client);
      const observed = await queryServerIdentityObservation(client);
      if (String(observed.database || '') !== stagingTarget.expectedDatabase) {
        throw localFail('database_identity_mismatch');
      }
      if (observed.server_addr == null || observed.server_addr === '') {
        throw localFail('server_addr_missing');
      }
      pin = freezePinnedServerIdentity({
        server_addr: observed.server_addr,
        database: observed.database,
        datid: observed.datid,
        server_version_num: observed.server_version_num,
        system_identifier: observed.system_identifier,
      });
      assertObservedServerIdentity(observed, pin, stagingTarget);
    } catch (e) {
      try { await safeEndUnregisteredClient(client); } catch { forceDestroyClient(client); }
      if (localCode(e)) throw e;
      throw localFail('bootstrap_identity_failed');
    }
    // Bounded close; bootstrap backend must not remain open for workers.
    try {
      await safeEndUnregisteredClient(client);
    } catch {
      forceDestroyClient(client);
      throw localFail('bootstrap_close_failed');
    }
    // Local backend-absence: connection stream destroyed / client ended.
    const stream = client.connection && client.connection.stream;
    if (stream && stream.destroyed !== true && stream.readable !== false) {
      forceDestroyClient(client);
    }
    return pin;
  } catch (e) {
    try { await safeEndUnregisteredClient(client); } catch { forceDestroyClient(client); }
    if (localCode(e)) throw e;
    throw localFail('bootstrap_failed');
  }
}

/**
 * Offline pure seam: authenticated bootstrap internal address may differ from public DNS and
 * still becomes the pin; cleanup/worker mismatch against that pin rejects.
 * Never logs hosts/addresses (returns only boolean/fixed codes).
 * @param {{
 *   bootstrap_observation: object,
 *   dns_addrs?: string[],
 *   mismatch_server_addr?: string,
 * }} opts
 * @returns {Readonly<object>}
 */
function offlineAuthenticatedBootstrapPinSeam(opts) {
  const o = opts || {};
  const dnsAddrs = Array.isArray(o.dns_addrs) ? o.dns_addrs : [];
  const dnsSet = new Set();
  for (const a of dnsAddrs) {
    const c = canonicalizeIp(String(a));
    if (c) dnsSet.add(c);
  }
  let pin;
  try {
    pin = freezePinnedServerIdentity(o.bootstrap_observation);
  } catch (e) {
    return Object.freeze({
      ok: false,
      code: localCode(e) || 'pinned_identity_invalid',
      pin_from_bootstrap_not_dns: false,
      authenticated_addr_may_differ_from_dns: false,
      exact_pin_match_accepts: false,
      cleanup_mismatch_rejects: false,
    });
  }
  const bootstrapAddr = pin.server_addr;
  const inDns = dnsSet.has(bootstrapAddr);
  let matchOk = false;
  try {
    assertObservedServerIdentity(
      {
        database: pin.database,
        server_addr: pin.server_addr,
        datid: pin.datid,
        server_version_num: pin.server_version_num,
        system_identifier: pin.system_identifier,
      },
      pin,
      { expectedDatabase: REQUIRED_DATABASE },
    );
    matchOk = true;
  } catch {
    matchOk = false;
  }
  let mismatchCode = null;
  try {
    assertObservedServerIdentity(
      {
        database: pin.database,
        server_addr: o.mismatch_server_addr || '203.0.113.9',
        datid: pin.datid,
        server_version_num: pin.server_version_num,
        system_identifier: pin.system_identifier,
      },
      pin,
      { expectedDatabase: REQUIRED_DATABASE },
    );
  } catch (e) {
    mismatchCode = localCode(e);
  }
  return Object.freeze({
    ok: true,
    // Pin is bootstrap observation even when that address is absent from public DNS.
    pin_from_bootstrap_not_dns: true,
    authenticated_addr_may_differ_from_dns: true,
    authenticated_addr_in_public_dns: inDns === true,
    // Azure-shaped case: internal addr not in DNS is allowed as pin.
    azure_internal_addr_pin_ok_when_absent_from_dns: inDns === false,
    exact_pin_match_accepts: matchOk === true,
    cleanup_mismatch_rejects: mismatchCode === 'server_addr_not_in_pinned_set',
    mismatch_code: mismatchCode,
  });
}

/**
 * Build exact PASS transcript. Requires supervisor cleanup evidence fields — a worker-only
 * or self-authored transcript without supervisor verification cannot PASS.
 * @param {string[]} passNames ordered check names that passed
 * @param {{supervisorCleanupVerified?: boolean, zeroTokenBackends?: boolean, schemaAbsent?: boolean}} [supervisorEvidence]
 */
function buildPassTranscript(passNames, supervisorEvidence) {
  if (!Array.isArray(passNames) || passNames.length !== EXPECTED_CHECK_COUNT) return null;
  for (let i = 0; i < EXPECTED_CHECK_COUNT; i += 1) {
    if (passNames[i] !== CHECK_NAMES[i]) return null;
  }
  const se = supervisorEvidence || {};
  if (se.supervisorCleanupVerified !== true) return null;
  if (se.zeroTokenBackends !== true) return null;
  if (se.schemaAbsent !== true) return null;
  const lines = passNames.map((n) => `PASS  ${n}`);
  lines.push('');
  lines.push(`PASS ${PASS_SCRIPT} (${EXPECTED_CHECK_COUNT} checks)`);
  lines.push(JSON.stringify({
    ok: true,
    result: 'PASS',
    script: PASS_SCRIPT,
    checks: EXPECTED_CHECK_COUNT,
    schema: PASS_JSON_SCHEMA,
    supervisor_cleanup_verified: true,
    supervisor_zero_token_backends: true,
    supervisor_schema_absent: true,
  }));
  lines.push('');
  return lines.join('\n');
}

/**
 * Build worker evidence payload (never a final PASS transcript).
 * @param {string[]} passNames
 */
function buildWorkerEvidence(passNames) {
  if (!Array.isArray(passNames) || passNames.length !== WORKER_CHECK_NAMES.length) return null;
  for (let i = 0; i < WORKER_CHECK_NAMES.length; i += 1) {
    if (passNames[i] !== WORKER_CHECK_NAMES[i]) return null;
  }
  return Object.freeze({
    schema: WORKER_EVIDENCE_SCHEMA,
    ok: true,
    checks: passNames.slice(),
    check_count: passNames.length,
  });
}

/**
 * Parse worker evidence from child stdout. Rejects PASS transcripts / self-authored PASS.
 */
function parseWorkerEvidenceStdout(stdout) {
  const out = String(stdout || '');
  if (!out || out.length > 256 * 1024) return null;
  // Worker must not emit final PASS transcript.
  if (/^PASS\s/m.test(out) || out.includes(PASS_JSON_SCHEMA)) return null;
  const lines = out.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  if (!lines[0].startsWith('WORKER_EVIDENCE ')) return null;
  let body;
  try {
    body = JSON.parse(lines[0].slice('WORKER_EVIDENCE '.length));
  } catch {
    return null;
  }
  if (!body || body.schema !== WORKER_EVIDENCE_SCHEMA || body.ok !== true) return null;
  if (!Array.isArray(body.checks) || body.checks.length !== WORKER_CHECK_NAMES.length) return null;
  for (let i = 0; i < WORKER_CHECK_NAMES.length; i += 1) {
    if (body.checks[i] !== WORKER_CHECK_NAMES[i]) return null;
  }
  return body;
}

/**
 * Exact PASS parser: full stdout must match bounded transcript schema.
 * Rejects prefix/suffix, duplicate JSON, arbitrary check counts, non-empty stderr.
 * @param {{status?: number|null, exitCode?: number|null, stdout?: string, stderr?: string, error?: Error|null}} result
 */
function stockPgTranscriptPassed(result) {
  if (!result || result.error) return false;
  const code = result.status != null ? result.status : result.exitCode;
  if (code !== 0) return false;
  const err = String(result.stderr || '');
  if (err.length > 0) {
    // Forbid any stderr on PASS (including Node warnings).
    return false;
  }
  const out = String(result.stdout || '');
  if (out.length > 256 * 1024) return false;
  const expected = buildPassTranscript(CHECK_NAMES.slice(), {
    supervisorCleanupVerified: true,
    zeroTokenBackends: true,
    schemaAbsent: true,
  });
  if (!expected) return false;
  if (out !== expected) return false;
  // Extra hard checks on the JSON object shape — supervisor evidence required.
  const jsonLine = out.trim().split('\n').filter((l) => l.startsWith('{'));
  if (jsonLine.length !== 1) return false;
  try {
    const body = JSON.parse(jsonLine[0]);
    const keys = Object.keys(body).sort();
    const want = PASS_JSON_KEYS.slice().sort();
    if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return false;
    if (body.ok !== true || body.result !== 'PASS') return false;
    if (body.script !== PASS_SCRIPT) return false;
    if (body.checks !== EXPECTED_CHECK_COUNT) return false;
    if (body.schema !== PASS_JSON_SCHEMA) return false;
    if (body.supervisor_cleanup_verified !== true) return false;
    if (body.supervisor_zero_token_backends !== true) return false;
    if (body.supervisor_schema_absent !== true) return false;
  } catch {
    return false;
  }
  return true;
}

function sanitizePublic(v) {
  let t = typeof v === 'string' ? v : String(v);
  t = t.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '[redacted-url]');
  t = t.replace(/password=[^\s&'"]+/gi, 'password=[redacted]');
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-mail]');
  t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted-uuid]');
  if (t.length > 180) t = `${t.slice(0, 180)}…`;
  return t;
}

// ---------------------------------------------------------------------------
// Network / external-traffic instrumentation (installed before pg/production).
// ---------------------------------------------------------------------------

const networkTouch = {
  http: 0,
  https: 0,
  fetch: 0,
  net: 0,
  tls: 0,
  rejected: 0,
};
let trapsInstalled = false;
let allowTarget = null; // { host, port } lowercase host

function hostAllowed(hostname, port) {
  if (!allowTarget) return false;
  if (typeof hostname !== 'string') return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const p = Number(port);
  if (h === allowTarget.host && p === allowTarget.port) return true;
  // Local DNS: allow loopback literals only when dedicated host is loopback/localhost.
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (loopbackHosts.has(allowTarget.host) && loopbackHosts.has(h) && p === allowTarget.port) {
    return true;
  }
  return false;
}

function parseConnectArgs(args) {
  // net.connect(options) | net.connect(port, host) | net.connect(path)
  if (!args || args.length === 0) return { kind: 'unknown' };
  const a0 = args[0];
  // Node's internal Socket.connect normalizer may pass the original argument
  // list as a single nested array when both net.createConnection and the
  // prototype are instrumented. Parse that canonical nested form rather than
  // misclassifying it as localhost.
  if (Array.isArray(a0)) return parseConnectArgs(a0);
  if (typeof a0 === 'object' && a0 !== null) {
    if (typeof a0.path === 'string' && a0.path) return { kind: 'path', path: a0.path };
    return {
      kind: 'tcp',
      host: a0.host || a0.hostname || 'localhost',
      port: a0.port,
    };
  }
  if (typeof a0 === 'number') {
    return { kind: 'tcp', port: a0, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  }
  if (typeof a0 === 'string') {
    // path form
    return { kind: 'path', path: a0 };
  }
  return { kind: 'unknown' };
}

function installExternalTrafficTraps(parsedUrl) {
  if (trapsInstalled) return;
  allowTarget = Object.freeze({ host: parsedUrl.host, port: parsedUrl.port });

  // fetch
  if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function stockPgFetchTripwire(..._args) {
      networkTouch.fetch += 1;
      networkTouch.rejected += 1;
      throw localFail('fetch_blocked');
    };
    globalThis.fetch._stockReal = realFetch;
  }

  // http / https
  // eslint-disable-next-line global-require
  const http = require('http');
  // eslint-disable-next-line global-require
  const https = require('https');
  function wrapHttp(mod, counterKey) {
    if (typeof mod.request === 'function') {
      const real = mod.request.bind(mod);
      mod.request = function stockPgRequestTripwire(..._args) {
        networkTouch[counterKey] += 1;
        networkTouch.rejected += 1;
        throw localFail(`${counterKey}_blocked`);
      };
      mod.request._stockReal = real;
    }
    if (typeof mod.get === 'function') {
      const realGet = mod.get.bind(mod);
      mod.get = function stockPgGetTripwire(..._args) {
        networkTouch[counterKey] += 1;
        networkTouch.rejected += 1;
        throw localFail(`${counterKey}_get_blocked`);
      };
      mod.get._stockReal = realGet;
    }
  }
  wrapHttp(http, 'http');
  wrapHttp(https, 'https');

  // net / tls — allow only exact dedicated PostgreSQL host:port
  // eslint-disable-next-line global-require
  const net = require('net');
  // eslint-disable-next-line global-require
  const tls = require('tls');

  function guardConnect(kind, realFn, args, ctx) {
    const parsed = parseConnectArgs(args);
    if (parsed.kind === 'path') {
      networkTouch[kind] += 1;
      networkTouch.rejected += 1;
      throw localFail(`${kind}_unix_blocked`);
    }
    if (parsed.kind !== 'tcp' || !hostAllowed(parsed.host, parsed.port)) {
      networkTouch[kind] += 1;
      networkTouch.rejected += 1;
      throw localFail(`${kind}_dst_blocked`);
    }
    return realFn.apply(ctx, args);
  }

  if (typeof net.connect === 'function') {
    const realNetConnect = net.connect.bind(net);
    net.connect = function stockPgNetConnect(...args) {
      return guardConnect('net', realNetConnect, args, this);
    };
    net.connect._stockReal = realNetConnect;
  }
  if (typeof net.createConnection === 'function') {
    const realCreate = net.createConnection.bind(net);
    net.createConnection = function stockPgNetCreate(...args) {
      return guardConnect('net', realCreate, args, this);
    };
    net.createConnection._stockReal = realCreate;
  }
  if (net.Socket && typeof net.Socket.prototype.connect === 'function') {
    const realSock = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function stockPgSockConnect(...args) {
      return guardConnect('net', realSock, args, this);
    };
  }
  if (typeof tls.connect === 'function') {
    const realTls = tls.connect.bind(tls);
    tls.connect = function stockPgTlsConnect(...args) {
      const options = args[0] && typeof args[0] === 'object' ? args[0] : null;
      // node-postgres upgrades its already-connected, destination-guarded TCP
      // socket with tls.connect({ socket, servername }). There is no host/port
      // in this TLS call, so bind it to the exact existing socket destination
      // and expected SNI instead of treating it as a fresh unknown endpoint.
      if (options && options.socket) {
        const socket = options.socket;
        const remotePort = Number(socket.remotePort);
        const remoteAddress = socket.remoteAddress
          ? canonicalizeIp(String(socket.remoteAddress))
          : '';
        const servername = String(options.servername || '').toLowerCase();
        if (
          !Number.isInteger(remotePort)
          || remotePort !== allowTarget.port
          || !remoteAddress
          || servername !== allowTarget.host
        ) {
          networkTouch.tls += 1;
          networkTouch.rejected += 1;
          throw localFail('tls_socket_dst_blocked');
        }
        return realTls.apply(this, args);
      }
      return guardConnect('tls', realTls, args, this);
    };
    tls.connect._stockReal = realTls;
  }

  trapsInstalled = true;
}

// ---------------------------------------------------------------------------
// Worker-only runtime (lazy production imports after traps).
// ---------------------------------------------------------------------------

function loadProductionModules() {
  /* eslint-disable global-require */
  const {
    createPostgresOAuthTransactionRepository,
  } = require('./lib/email-microsoft-oauth-transaction-service');
  const {
    createPostgresPhaseBOauthTransactionConsumer,
  } = require('./lib/email-microsoft-phase-b-oauth-callback-completion');
  const {
    createMicrosoftPhaseBVerifiedGrantReplacer,
    REPLACED_STATUS,
    OUTCOME_UNKNOWN,
    GEN_MAX,
    ERROR_CODE: REPLACER_ERROR_CODE,
    asCanonGen,
    genPlus1,
    SQL_LOCK,
  } = require('./lib/email-microsoft-phase-b-verified-grant-replacer');
  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');
  const {
    buildGrantEnvelopeAadV1,
  } = require('./lib/email-grant-envelope-provider-contract');
  const { prepareMigrationBody } = require('./lib/migration-integrity');
  const pg = require('pg');
  /* eslint-enable global-require */
  return {
    createPostgresOAuthTransactionRepository,
    createPostgresPhaseBOauthTransactionConsumer,
    createMicrosoftPhaseBVerifiedGrantReplacer,
    REPLACED_STATUS,
    OUTCOME_UNKNOWN,
    GEN_MAX,
    REPLACER_ERROR_CODE,
    asCanonGen,
    genPlus1,
    SQL_LOCK,
    createFakeEmailGrantEnvelopeProvider,
    buildGrantEnvelopeAadV1,
    prepareMigrationBody,
    Pool: pg.Pool,
    Client: pg.Client,
  };
}

function assertProductionRequireGraph() {
  const cache = require.cache || {};
  const keys = Object.keys(cache);
  const need = [
    'email-microsoft-oauth-transaction-service',
    'email-microsoft-phase-b-oauth-callback-completion',
    'email-microsoft-phase-b-verified-grant-replacer',
    'email-grant-envelope-fake-provider',
    path.join('node_modules', 'pg'),
  ];
  for (const frag of need) {
    if (!keys.some((k) => k.includes(frag))) throw localFail('require_cache_missing_production');
  }
  // Production proof path must not load Azure SDKs.
  if (keys.some((k) => /@azure[\\/]/.test(k))) throw localFail('require_cache_azure_present');
  if (!trapsInstalled) throw localFail('traps_not_installed_before_production');
}

/**
 * Atomic registry persistence: temp file mode 0600 → fsync → rename → fsync directory.
 * Document includes monotonic revision, run token, schema, complete identity entries.
 * Directory open/fsync/close failures are terminal (no catch-ignore).
 * Optional `io` injects fs methods for hostile offline regression tests.
 * @param {string} registryPath
 * @param {object} doc
 * @param {typeof fs} [io]
 */
function writeRegistryAtomic(registryPath, doc, io) {
  if (!registryPath || typeof registryPath !== 'string') throw localFail('registry_path_missing');
  const fsys = io || fs;
  const dir = path.dirname(registryPath);
  const base = path.basename(registryPath);
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(doc)}\n`;
  let fd;
  try {
    fd = fsys.openSync(tmp, 'w', 0o600);
    fsys.writeFileSync(fd, payload, 'utf8');
    fsys.fsyncSync(fd);
  } catch {
    try { if (fd != null) fsys.closeSync(fd); } catch { /* best-effort */ }
    try { fsys.unlinkSync(tmp); } catch { /* best-effort */ }
    throw localFail('registry_write_failed');
  }
  try {
    fsys.closeSync(fd);
  } catch {
    try { fsys.unlinkSync(tmp); } catch { /* best-effort */ }
    throw localFail('registry_write_failed');
  }
  try {
    fsys.renameSync(tmp, registryPath);
  } catch {
    try { fsys.unlinkSync(tmp); } catch { /* best-effort */ }
    throw localFail('registry_write_failed');
  }
  // Directory open/fsync/close — terminal on any failure (no catch-ignore).
  let dirFd;
  try {
    dirFd = fsys.openSync(dir, 'r');
  } catch {
    throw localFail('registry_dir_open_failed');
  }
  try {
    fsys.fsyncSync(dirFd);
  } catch {
    try { fsys.closeSync(dirFd); } catch { /* still terminal */ }
    throw localFail('registry_dir_fsync_failed');
  }
  try {
    fsys.closeSync(dirFd);
  } catch {
    throw localFail('registry_dir_close_failed');
  }
}

function identityEntryFromRec(r) {
  return {
    pid: r.pid,
    application_name: r.application_name,
    backend_start: r.backend_start,
    datname: r.datname,
    datid: r.datid,
    role: r.role,
  };
}

/**
 * Load registry for cleanup. Missing/malformed/truncated/wrong token/non-monotonic →
 * cleanup_unverified (never a silent empty list that authorizes "no backends").
 * @returns {{ok: true, revision: number, entries: object[]}|{ok: false, code: string}}
 */
function loadRegistryForCleanup(registryPath, expectedRunToken, expectedSchema, minRevision) {
  if (!registryPath || typeof registryPath !== 'string') {
    return { ok: false, code: 'cleanup_unverified' };
  }
  let raw;
  try {
    if (!fs.existsSync(registryPath)) return { ok: false, code: 'cleanup_unverified' };
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'cleanup_unverified' };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (parsed.schema !== REGISTRY_DOC_SCHEMA) return { ok: false, code: 'cleanup_unverified' };
  if (parsed.run_token !== expectedRunToken) return { ok: false, code: 'cleanup_unverified' };
  if (expectedSchema && parsed.schema_name !== expectedSchema) {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (minRevision != null && parsed.revision < minRevision) {
    return { ok: false, code: 'cleanup_unverified' };
  }
  if (!Array.isArray(parsed.entries)) return { ok: false, code: 'cleanup_unverified' };
  const entries = [];
  for (const r of parsed.entries) {
    if (!r || typeof r !== 'object') return { ok: false, code: 'cleanup_unverified' };
    if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) {
      return { ok: false, code: 'cleanup_unverified' };
    }
    if (typeof r.application_name !== 'string' || !r.application_name) {
      return { ok: false, code: 'cleanup_unverified' };
    }
    if (typeof r.backend_start !== 'string' || !r.backend_start) {
      return { ok: false, code: 'cleanup_unverified' };
    }
    if (typeof r.datname !== 'string') return { ok: false, code: 'cleanup_unverified' };
    if (!(r.datid == null || typeof r.datid === 'number')) {
      return { ok: false, code: 'cleanup_unverified' };
    }
    if (!appNameHasRunToken(r.application_name, expectedRunToken)) {
      return { ok: false, code: 'cleanup_unverified' };
    }
    entries.push({
      pid: r.pid,
      application_name: r.application_name,
      backend_start: r.backend_start,
      datname: r.datname,
      datid: r.datid == null ? null : Number(r.datid),
      role: typeof r.role === 'string' ? r.role : '',
    });
  }
  return { ok: true, revision: parsed.revision, entries, schema_name: parsed.schema_name };
}

/** Initial valid empty registry (revision 0) — must exist before worker spawn. */
function writeInitialEmptyRegistry(registryPath, runToken, schemaName) {
  writeRegistryAtomic(registryPath, {
    schema: REGISTRY_DOC_SCHEMA,
    revision: 0,
    run_token: runToken,
    schema_name: schemaName,
    entries: [],
  });
}

/**
 * Ownership registry: every connection acquisition immediately enters tracking.
 * Persists serially under an in-process queue (no concurrent overwrite).
 * Partial acquisition failure closes only the partial client.
 */
function createOwnershipRegistry(runToken, schemaName, registryPath) {
  /** @type {Array<{client: any, pid: number, application_name: string, backend_start: string, datname: string, datid: number|null, role: string}>} */
  const owned = [];
  let revision = 0;
  /** @type {Promise<void>} */
  let writeQueue = Promise.resolve();

  /**
   * Serialize registry revisions correctly: allocate revision + snapshot inside the
   * queued callback after the prior write completes. Strictly increasing.
   */
  function enqueuePersist() {
    const job = writeQueue.then(() => {
      // Snapshot + revision allocation only after prior write has completed.
      const snapshot = owned.map(identityEntryFromRec);
      const nextRev = revision + 1;
      if (!(nextRev > revision)) throw localFail('registry_revision_not_increasing');
      const doc = {
        schema: REGISTRY_DOC_SCHEMA,
        revision: nextRev,
        run_token: runToken,
        schema_name: schemaName,
        entries: snapshot,
      };
      writeRegistryAtomic(registryPath, doc);
      revision = nextRev;
    });
    // Keep queue chain alive after failure, but surface the failure to the caller.
    writeQueue = job.then(() => {}, () => {});
    return job;
  }

  return {
    list() { return owned.slice(); },
    revision() { return revision; },
    async register(client, role) {
      let row;
      try {
        const r = await withTimeout(
          client.query(
            `SELECT a.pid::int AS pid,
                    a.application_name::text AS application_name,
                    a.backend_start::text AS backend_start,
                    a.datname::text AS datname,
                    a.datid::oid AS datid
               FROM pg_stat_activity a
              WHERE a.pid = pg_backend_pid()`,
          ),
          CLEANUP_STEP_MS,
          'identity_query_timeout',
        );
        row = r.rows && r.rows[0];
      } catch (e) {
        if (localCode(e)) throw e;
        throw localFail('identity_query_failed');
      }
      if (!row || typeof row.pid !== 'number') throw localFail('identity_missing');
      const applicationName = String(row.application_name || '');
      if (!appNameHasRunToken(applicationName, runToken)) {
        throw localFail('identity_app_name_mismatch');
      }
      const rec = {
        client,
        pid: row.pid,
        application_name: applicationName,
        backend_start: String(row.backend_start),
        datname: String(row.datname || ''),
        datid: row.datid != null ? Number(row.datid) : null,
        role,
      };
      owned.push(rec);
      try {
        await enqueuePersist();
      } catch (e) {
        // Roll back in-memory entry if durable persist fails.
        const idx = owned.indexOf(rec);
        if (idx >= 0) owned.splice(idx, 1);
        if (localCode(e)) throw e;
        throw localFail('registry_write_failed');
      }
      return rec;
    },
    /**
     * Close clients cooperatively. Failures/timeouts are terminal (no silent ignore).
     * Does not force-destroy; caller must escalate backends then force-destroy.
     */
    async closeAll() {
      const errors = [];
      const remaining = owned.slice();
      for (const rec of remaining) {
        try {
          await safeEndClient(rec.client);
          const idx = owned.indexOf(rec);
          if (idx >= 0) owned.splice(idx, 1);
        } catch {
          errors.push(1);
        }
      }
      try {
        await enqueuePersist();
      } catch {
        errors.push(1);
      }
      if (errors.length) throw localFail('owned_close_failed');
    },
    /** Socket destroy only after identity-bound backend termination (safe lifecycle). */
    forceDestroyAll() {
      for (const rec of owned) forceDestroyClient(rec.client);
      owned.length = 0;
    },
    async persistForceEmpty() {
      owned.length = 0;
      await enqueuePersist();
    },
  };
}

function forceDestroyClient(client) {
  if (!client) return;
  try {
    const stream = client.connection && (client.connection.stream || client.connection);
    if (stream && typeof stream.destroy === 'function') stream.destroy();
  } catch { /* ignore */ }
  try {
    if (typeof client.end === 'function') client.end(() => {});
  } catch { /* ignore */ }
}

/**
 * Bound ROLLBACK and end. No unbounded query/end.
 * On uncertainty: throw (caller maps to cleanup_unverified). Force-destroy only under
 * safe lifecycle (after identity-bound terminate), not here.
 */
async function safeEndClient(client) {
  if (!client) return;
  try {
    await withClientOpTimeout(
      client,
      () => client.query('ROLLBACK'),
      CLEANUP_STEP_MS,
      'rollback_timeout',
    );
  } catch (e) {
    if (localCode(e) === 'rollback_timeout') throw localFail('cleanup_unverified');
    // No open transaction is fine; other errors still attempt end.
  }
  try {
    await withClientOpTimeout(
      client,
      () => client.end(),
      CLEANUP_STEP_MS,
      'client_end_timeout',
    );
  } catch (e) {
    // Do not force-destroy here — uncertainty is terminal for cooperative close.
    if (localCode(e)) throw e;
    throw localFail('client_end_failed');
  }
}

/**
 * Bounded end on connect-failure paths (never-registered sockets).
 * Force-destroy only after bounded end fails — client never entered registry.
 */
async function safeEndUnregisteredClient(client) {
  if (!client) return;
  try {
    await withClientOpTimeout(
      client,
      () => client.end(),
      CLEANUP_STEP_MS,
      'client_end_timeout',
    );
  } catch {
    forceDestroyClient(client);
  }
}

async function openTrackedClient(opts) {
  const {
    Client, parsedUrl, runToken, role, schema, timeouts, registry, expectedDatabase,
    stagingTarget, pinnedIdentity, verifyServerIdentity,
  } = opts;
  const statementMs = timeouts && timeouts.statement != null ? timeouts.statement : STATEMENT_MS;
  const lockMs = timeouts && timeouts.lock != null ? timeouts.lock : LOCK_MS;
  const name = appNameFor(runToken, role);
  const expectedHost = stagingTarget && stagingTarget.expectedHost;
  const client = new Client(buildPgClientConfig(parsedUrl, {
    applicationName: name,
    expectedHost,
    connectionTimeoutMillis: CONNECT_MS,
  }));
  try {
    await withTimeout(client.connect(), CONNECT_MS + 500, 'connect_timeout');
  } catch {
    await safeEndUnregisteredClient(client);
    throw localFail('connect_failed');
  }
  // First query/operation after connect: durable identity registration (startup app_name already set).
  let identity;
  try {
    identity = await registry.register(client, role);
    // Server-verify application_name matches startup parameter (never trust client-only).
    const verify = await withTimeout(
      client.query('SHOW application_name'),
      CLEANUP_STEP_MS,
      'app_name_verify_timeout',
    );
    const shown = verify.rows && verify.rows[0] && verify.rows[0].application_name;
    if (shown !== name || shown !== identity.application_name) {
      throw localFail('application_name_not_server_verified');
    }
    if (schema) {
      await withTimeout(
        client.query(`SET search_path TO ${schema}`),
        CLEANUP_STEP_MS,
        'session_setup_timeout',
      );
    }
    await withTimeout(
      client.query(`SET statement_timeout = ${statementMs}`),
      CLEANUP_STEP_MS,
      'session_setup_timeout',
    );
    await withTimeout(
      client.query(`SET lock_timeout = ${lockMs}`),
      CLEANUP_STEP_MS,
      'session_setup_timeout',
    );
    const dbExpected = (stagingTarget && stagingTarget.expectedDatabase) || expectedDatabase;
    if (dbExpected) {
      const db = await withTimeout(
        client.query('SELECT current_database()::text AS d'),
        CLEANUP_STEP_MS,
        'session_setup_timeout',
      );
      if (!db.rows || db.rows[0].d !== dbExpected) {
        throw localFail('database_identity_mismatch');
      }
    }
    // Authenticated bootstrap pin (exact inet_server_addr + DB identity). No DNS re-resolve.
    if (stagingTarget) {
      if (verifyServerIdentity || pinnedIdentity) {
        await assertConnectedServerIdentity(client, stagingTarget, pinnedIdentity);
      }
    }
  } catch (e) {
    // Do not close unrelated owned clients; only this partial acquisition.
    // Never force-destroy registered client here — escalate via cancel/terminate.
    try { await safeEndClient(client); } catch { /* owned_close / cleanup path */ }
    rethrowLocalOr('session_setup_failed', e);
  }
  return { client, identity, appName: name };
}

/**
 * Acquire several named clients sequentially; on any failure close all already acquired.
 */
async function openTrackedClientsSequential(specs, shared) {
  const opened = [];
  try {
    for (const spec of specs) {
      const h = await openTrackedClient({ ...shared, ...spec });
      opened.push(h);
    }
    return opened;
  } catch (e) {
    for (const h of opened) {
      try { await safeEndClient(h.client); } catch { forceDestroyClient(h.client); }
    }
    throw e;
  }
}

function instrumentClient(client) {
  const stats = { select: 0, update: 0, other: 0, statements: [] };
  const orig = client.query.bind(client);
  client.query = function instrumentedQuery(config, values, cb) {
    const text = typeof config === 'string' ? config
      : (config && typeof config === 'object' && typeof config.text === 'string' ? config.text : '');
    const norm = String(text).replace(/\s+/g, ' ').trim();
    if (norm) {
      stats.statements.push(norm.slice(0, 120));
      if (/^\s*SELECT\b/i.test(norm)) stats.select += 1;
      else if (/^\s*UPDATE\b/i.test(norm)) stats.update += 1;
      else stats.other += 1;
    }
    return orig(config, values, cb);
  };
  return { client, stats, restore() { client.query = orig; } };
}

/** Frozen classified worker outcomes — never swallow unexpected errors. */
function freezeOutcome(kind, payload) {
  return Object.freeze({ kind, ...payload });
}

function isProductionReplacerStale(err, REPLACER_ERROR_CODE) {
  return !!(err
    && err.code === REPLACER_ERROR_CODE
    && err.name === 'MicrosoftPhaseBVerifiedGrantReplacerError'
    && !localCode(err));
}

/**
 * Classify consume result: accepted row, legitimate invalid (null), or unexpected_error.
 * Unexpected fails the entire proof (thrown as localFail).
 */
function classifyConsumeResult(value, err, stats) {
  if (err) {
    return freezeOutcome(localCode(err) === 'aborted' ? 'aborted' : 'unexpected', {
      value: null, stats,
    });
  }
  if (value == null) {
    return freezeOutcome('invalid', { value: null, stats });
  }
  return freezeOutcome('accepted', { value, stats });
}

/**
 * Classify CAS result: accepted replaced ack, legitimate production stale, or unexpected.
 */
function classifyCasResult(value, err, stats, REPLACED_STATUS, REPLACER_ERROR_CODE) {
  if (err) {
    if (isProductionReplacerStale(err, REPLACER_ERROR_CODE)) {
      return freezeOutcome('stale', { value: null, stats, errorCode: REPLACER_ERROR_CODE });
    }
    return freezeOutcome(localCode(err) === 'aborted' ? 'aborted' : 'unexpected', {
      value: null, stats,
    });
  }
  if (value && value.status === REPLACED_STATUS) {
    return freezeOutcome('accepted', { value, stats });
  }
  // Production maps post-commit ack loss to outcome_unknown (returned, not thrown).
  if (value && value.status) {
    return freezeOutcome('returned', { value, stats });
  }
  return freezeOutcome('unexpected', { value, stats });
}

const SHELL_DDL = `
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TABLE clients (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE staff_users (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY,
  staff_user_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id),
  session_token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tenant_locations (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id),
  location_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT 'Proof',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_locations_client_location_uq UNIQUE (client_id, location_id)
);

CREATE TABLE tenant_channel_endpoints (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  location_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  provider TEXT NOT NULL,
  public_address TEXT NOT NULL,
  secret_ref TEXT NOT NULL DEFAULT 'kv:stock-pg-proof-label',
  provider_resource_id TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  outbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_automation_mode TEXT NOT NULL DEFAULT 'off',
  active BOOLEAN NOT NULL DEFAULT FALSE,
  auth_mode TEXT,
  connector_mode TEXT,
  provider_tenant_id TEXT,
  provider_principal_oid TEXT,
  mailbox_kind TEXT,
  mailbox_access_kind TEXT,
  binding_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tenant_channel_endpoints_client_id_id_uq UNIQUE (client_id, id)
);

CREATE TABLE tenant_email_delegated_grants (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  grant_generation BIGINT NOT NULL,
  grant_status TEXT NOT NULL,
  grant_lease_owner TEXT NULL,
  grant_lease_token UUID NULL,
  grant_lease_until TIMESTAMPTZ NULL,
  last_operation_id UUID NOT NULL,
  reconcile_state TEXT NOT NULL DEFAULT 'clean',
  reconcile_detail_code TEXT NULL,
  envelope_version TEXT NOT NULL,
  aead_alg TEXT NOT NULL,
  kek_wrap_alg TEXT NOT NULL,
  kek_key_name TEXT NOT NULL,
  kek_key_version TEXT NOT NULL,
  nonce BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  wrapped_dek BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NULL,
  updated_by UUID NULL,
  CONSTRAINT tenant_email_delegated_grants_client_endpoint_uq UNIQUE (client_id, endpoint_id),
  CONSTRAINT tenant_email_delegated_grants_endpoint_uq UNIQUE (endpoint_id),
  CONSTRAINT tenant_email_delegated_grants_generation_min CHECK (grant_generation >= 1)
);
`;

/**
 * Poll until each worker PID is blocked by exact blockerPid via pg_blocking_pids,
 * with exact application_name + database identity. Correlates ungranted relation/transaction
 * locks when present. Unrelated waits (blocked by other PIDs only) fail.
 */
async function waitForExactBlockerOverlap(opts) {
  const {
    observer, workers, blockerPid, expectedDatabase, signal, maxMs, requireRelationLock,
  } = opts;
  if (!Array.isArray(workers) || workers.length < 1) throw localFail('overlap_workers_missing');
  if (typeof blockerPid !== 'number' || blockerPid <= 0) throw localFail('overlap_blocker_missing');
  const start = Date.now();
  let last = null;
  let lastReason = 'none';
  while (Date.now() - start < maxMs) {
    if (signal && signal.aborted) throw localFail('aborted');
    const pids = workers.map((w) => w.pid);
    let activity;
    let locks;
    let blocking;
    try {
      activity = await observer.query(
        `SELECT pid, application_name, wait_event_type, wait_event, state, datname, datid
           FROM pg_stat_activity
          WHERE pid = ANY($1::int[])`,
        [pids],
      );
      locks = await observer.query(
        `SELECT pid, locktype, mode, granted, relation, transactionid, page, tuple, classid, objid
           FROM pg_locks
          WHERE pid = ANY($1::int[]) AND NOT granted`,
        [pids],
      );
      blocking = await observer.query(
        `SELECT w.pid AS worker_pid, pg_blocking_pids(w.pid) AS blockers
           FROM unnest($1::int[]) AS w(pid)`,
        [[...pids, blockerPid]],
      );
    } catch {
      throw localFail('overlap_poll_query_failed');
    }

    const actByPid = new Map();
    for (const row of activity.rows || []) actByPid.set(row.pid, row);
    const blockersByPid = new Map();
    for (const row of blocking.rows || []) {
      const arr = Array.isArray(row.blockers) ? row.blockers.map(Number) : [];
      blockersByPid.set(row.worker_pid, arr);
    }
    const ungrantedByPid = new Map();
    for (const row of locks.rows || []) {
      if (!ungrantedByPid.has(row.pid)) ungrantedByPid.set(row.pid, []);
      ungrantedByPid.get(row.pid).push(row);
    }

    function pathToExactBlocker(startPid, seen) {
      const visited = seen || new Set();
      if (visited.has(startPid)) return null;
      visited.add(startPid);
      for (const direct of blockersByPid.get(startPid) || []) {
        if (direct === blockerPid) return [startPid, blockerPid];
        const tail = pathToExactBlocker(direct, visited);
        if (tail) return [startPid, ...tail];
      }
      return null;
    }

    let allOk = true;
    const evidence = [];
    for (const w of workers) {
      const act = actByPid.get(w.pid);
      if (!act) { lastReason = 'activity_missing'; allOk = false; break; }
      if (String(act.application_name) !== w.application_name) { lastReason = 'application_name'; allOk = false; break; }
      if (expectedDatabase && String(act.datname) !== expectedDatabase) { lastReason = 'database'; allOk = false; break; }
      const blockers = blockersByPid.get(w.pid) || [];
      const blockerPath = pathToExactBlocker(w.pid);
      if (!blockerPath) {
        lastReason = blockers.length === 0 ? 'blockers_empty' : 'different_blocker';
        allOk = false;
        break;
      }
      // Reject if waiting only on unrelated PIDs without our blocker (already covered),
      // and require Lock wait_event or ungranted lock evidence.
      const ungranted = ungrantedByPid.get(w.pid) || [];
      const lockWait = act.wait_event_type === 'Lock' || ungranted.length > 0;
      if (!lockWait) { lastReason = 'lock_wait_absent'; allOk = false; break; }
      if (requireRelationLock) {
        const hasRelOrTx = ungranted.some(
          (l) => l.locktype === 'relation' || l.locktype === 'transactionid' || l.locktype === 'tuple',
        );
        // Prefer relation/transaction correlation; if only Lock wait_event visible, still require blockers.
        if (!hasRelOrTx && act.wait_event_type !== 'Lock') { lastReason = 'lock_evidence_absent'; allOk = false; break; }
      }
      evidence.push({
        pid: w.pid,
        application_name: act.application_name,
        datname: act.datname,
        blockers,
        blocker_path: blockerPath,
        ungranted: ungranted.map((l) => ({ locktype: l.locktype, mode: l.mode })),
      });
    }
    last = { evidence, at: Date.now() - start };
    if (allOk && evidence.length === workers.length) {
      return Object.freeze({ ok: true, evidence: last.evidence, blockerPid });
    }
    await sleep(OVERLAP_POLL_INTERVAL_MS, signal);
  }
  throw localFail(`overlap_wait_timeout_${lastReason}`);
}

async function runBlockedPair(opts) {
  const {
    Client, parsedUrl, schema, signal, runToken, registry, expectedDatabase, stagingTarget,
    pinnedIdentity, lockSql, lockParams, workerFn, classifyFn, label, prod,
  } = opts;
  const raceTimeouts = { statement: RACE_STATEMENT_MS, lock: RACE_LOCK_MS };
  const shared = {
    Client, parsedUrl, runToken, schema, timeouts: raceTimeouts, registry, expectedDatabase,
    stagingTarget, pinnedIdentity,
  };
  const [blocker, w1, w2, obs] = await openTrackedClientsSequential([
    { role: ROLE.blocker },
    { role: ROLE.worker1 },
    { role: ROLE.worker2 },
    { role: ROLE.observer, timeouts: raceTimeouts },
  ], shared);

  const pids = [blocker.identity.pid, w1.identity.pid, w2.identity.pid, obs.identity.pid];
  if (new Set(pids).size < 4) {
    await Promise.all([
      safeEndClient(blocker.client), safeEndClient(w1.client),
      safeEndClient(w2.client), safeEndClient(obs.client),
    ].map((p) => p.catch(() => {})));
    throw localFail(`${label}_pids_not_distinct`);
  }

  let released = false;
  /** @type {any[]} */
  const outcomes = [];
  try {
    await blocker.client.query('BEGIN');
    const blockerLock = await blocker.client.query(lockSql, lockParams);
    if (!blockerLock || blockerLock.rowCount !== 1) {
      throw localFail(`${label}_blocker_target_missing`);
    }

    const i1 = instrumentClient(w1.client);
    const i2 = instrumentClient(w2.client);
    let p1Settled = false;
    let p2Settled = false;
    // Production promises stay pending until after blocker release (real settle evidence).
    const p1 = Promise.resolve()
      .then(() => workerFn(i1.client, 0))
      .then((r) => { outcomes[0] = classifyFn(r, null, i1.stats); return r; })
      .catch((err) => { outcomes[0] = classifyFn(null, err, i1.stats); return null; })
      .finally(() => { p1Settled = true; i1.restore(); });
    const p2 = Promise.resolve()
      .then(() => workerFn(i2.client, 1))
      .then((r) => { outcomes[1] = classifyFn(r, null, i2.stats); return r; })
      .catch((err) => { outcomes[1] = classifyFn(null, err, i2.stats); return null; })
      .finally(() => { p2Settled = true; i2.restore(); });

    await sleep(30, signal);
    if (p1Settled || p2Settled) {
      const idx = p1Settled ? 0 : 1;
      const earlyKind = outcomes[idx] && /^[a-z]+$/.test(outcomes[idx].kind)
        ? outcomes[idx].kind : 'missing';
      throw localFail(`${label}_worker${idx + 1}_settled_${earlyKind}_before_overlap`);
    }
    const overlap = await waitForExactBlockerOverlap({
      observer: obs.client,
      workers: [
        { pid: w1.identity.pid, application_name: w1.appName },
        { pid: w2.identity.pid, application_name: w2.appName },
      ],
      blockerPid: blocker.identity.pid,
      expectedDatabase,
      signal,
      maxMs: OVERLAP_POLL_MS,
      // PostgreSQL row-lock waiters commonly wait on the blocker transaction ID;
      // an ungranted relation lock is not required. Exact pg_blocking_pids
      // correlation to the blocker PID remains mandatory.
      requireRelationLock: false,
    });

    // Both blocked observed — release blocker, then independently await BOTH still-pending
    // production promises with bounded deadlines (real release settlement, not self-fulfilling).
    await blocker.client.query('ROLLBACK');
    released = true;
    await Promise.all([
      withTimeout(p1, SETTLE_AFTER_RELEASE_MS, `${label}_settle_w1_timeout`),
      withTimeout(p2, SETTLE_AFTER_RELEASE_MS, `${label}_settle_w2_timeout`),
    ]);

    // classifyFn throws localFail('unexpected_error') for bad errors — rethrow if settled wrong.
    for (const o of outcomes) {
      if (!o || (o.kind !== 'accepted' && o.kind !== 'invalid' && o.kind !== 'stale' && o.kind !== 'returned')) {
        throw localFail(`${label}_outcome_unclassified`);
      }
    }

    return Object.freeze({
      outcomes: Object.freeze(outcomes.slice()),
      workerIdentities: Object.freeze([
        Object.freeze({ ...w1.identity, client: undefined }),
        Object.freeze({ ...w2.identity, client: undefined }),
      ]),
      blockerPid: blocker.identity.pid,
      observerPid: obs.identity.pid,
      overlap,
      settleAfterRelease: true,
      distinctPidCount: new Set(pids).size,
      prod,
    });
  } catch (e) {
    if (!released) {
      try { await blocker.client.query('ROLLBACK'); } catch { /* release attempt */ }
    }
    rethrowLocalOr(`${label}_blocked_pair_failed`, e);
  } finally {
    await Promise.all([
      safeEndClient(blocker.client),
      safeEndClient(w1.client),
      safeEndClient(w2.client),
      safeEndClient(obs.client),
    ]);
  }
}

/**
 * Snapshot every column of the oauth transaction row for byte/value-identical compare.
 * Uses observer (not matching owner) so we do not disturb the blocked session.
 */
async function snapshotOauthTxnFullRow(client, stateHash) {
  // All columns of tenant_email_oauth_transactions (060+061+071) — not only consumed_at.
  const r = await withTimeout(
    client.query(
      `SELECT id::text AS id,
              client_id::text AS client_id,
              location_id::text AS location_id,
              staff_user_id::text AS staff_user_id,
              auth_session_id::text AS auth_session_id,
              endpoint_id::text AS endpoint_id,
              encode(state_hash, 'hex') AS state_hash_hex,
              code_verifier,
              nonce,
              issued_at::text AS issued_at,
              expires_at::text AS expires_at,
              consumed_at::text AS consumed_at,
              authorization_intent,
              scope_version,
              prior_grant_generation::text AS prior_grant_generation
         FROM tenant_email_oauth_transactions
        WHERE state_hash = $1::bytea`,
      [stateHash],
    ),
    CLEANUP_STEP_MS,
    'row_snapshot_timeout',
  );
  if (!r.rows || r.rows.length !== 1) throw localFail('row_snapshot_missing');
  // Stable key order for byte/value-identical compare of all columns.
  const row = r.rows[0];
  const keys = Object.keys(row).sort();
  const out = {};
  for (const k of keys) out[k] = row[k] == null ? null : String(row[k]);
  return Object.freeze(out);
}

function fullRowsByteIdentical(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}

/**
 * Cross-intent same row: matching owner blocked by exact blocker; wrong returns invalid
 * while match remains blocked; full row byte-identical to pre-launch fixture before release.
 * Never claims wrong-intent lock contention.
 */
async function runCrossIntentSameRow(opts) {
  const {
    Client, parsedUrl, schema, signal, runToken, registry, expectedDatabase, stagingTarget,
    pinnedIdentity, stateHash, matchingKind, prod, preLaunchRowFixture,
  } = opts;
  const raceTimeouts = { statement: RACE_STATEMENT_MS, lock: RACE_LOCK_MS };
  const shared = {
    Client, parsedUrl, runToken, schema, timeouts: raceTimeouts, registry, expectedDatabase,
    stagingTarget, pinnedIdentity,
  };
  const [blocker, matchW, wrongW, obs] = await openTrackedClientsSequential([
    { role: ROLE.blocker },
    { role: ROLE.worker1 },
    { role: ROLE.worker2 },
    { role: ROLE.observer },
  ], shared);

  if (new Set([
    blocker.identity.pid, matchW.identity.pid, wrongW.identity.pid, obs.identity.pid,
  ]).size < 4) {
    await Promise.all([
      safeEndClient(blocker.client), safeEndClient(matchW.client),
      safeEndClient(wrongW.client), safeEndClient(obs.client),
    ].map((p) => p.catch(() => {})));
    throw localFail('cross_intent_pids_not_distinct');
  }

  const now = new Date(Date.now() + 2_000);
  let matchOutcome = null;
  let wrongOutcome = null;
  let matchErr = null;
  let wrongErr = null;
  let wrongSettled = false;
  let wrongFinishedWhileMatchBlocked = false;
  let matchBlockedEvidence = null;
  let fullRowIdenticalWhileMatchBlocked = false;
  let midBlockedRow = null;
  let released = false;

  try {
    await blocker.client.query('BEGIN');
    await blocker.client.query(
      `SELECT id FROM tenant_email_oauth_transactions WHERE state_hash=$1::bytea FOR UPDATE`,
      [stateHash],
    );

    const matchPromise = (async () => {
      const repo = matchingKind === 'phase_a'
        ? prod.createPostgresOAuthTransactionRepository(matchW.client)
        : prod.createPostgresPhaseBOauthTransactionConsumer(matchW.client);
      try {
        matchOutcome = await repo.consume({
          stateHash, clientId: IDS.client, authSessionId: IDS.session, now,
        });
      } catch (e) {
        matchErr = e;
      }
    })();

    const wrongPromise = (async () => {
      const repo = matchingKind === 'phase_a'
        ? prod.createPostgresPhaseBOauthTransactionConsumer(wrongW.client)
        : prod.createPostgresOAuthTransactionRepository(wrongW.client);
      try {
        wrongOutcome = await repo.consume({
          stateHash, clientId: IDS.client, authSessionId: IDS.session, now,
        });
      } catch (e) {
        wrongErr = e;
      } finally {
        wrongSettled = true;
      }
    })();

    await sleep(30, signal);

    const start = Date.now();
    while (Date.now() - start < OVERLAP_POLL_MS) {
      if (signal && signal.aborted) throw localFail('aborted');
      try {
        const act = await obs.client.query(
          `SELECT pid, application_name, wait_event_type, datname
             FROM pg_stat_activity WHERE pid = $1`,
          [matchW.identity.pid],
        );
        const blk = await obs.client.query(
          `SELECT pg_blocking_pids($1::int) AS blockers`,
          [matchW.identity.pid],
        );
        const row = act.rows && act.rows[0];
        const blockers = (blk.rows && blk.rows[0] && Array.isArray(blk.rows[0].blockers))
          ? blk.rows[0].blockers.map(Number) : [];
        const matchBlocked = !!(row
          && String(row.application_name) === matchW.appName
          && (!expectedDatabase || String(row.datname) === expectedDatabase)
          && blockers.includes(blocker.identity.pid));
        if (matchBlocked) {
          matchBlockedEvidence = Object.freeze({
            pid: matchW.identity.pid,
            blockers,
            blocker_path: Object.freeze([matchW.identity.pid, blocker.identity.pid]),
            application_name: row.application_name,
          });
        }
        // Ordering: wrong must settle invalid while matching remains blocked — no wrong lock claim.
        if (matchBlocked && wrongSettled) {
          wrongFinishedWhileMatchBlocked = true;
          break;
        }
      } catch {
        throw localFail('cross_intent_poll_failed');
      }
      await sleep(OVERLAP_POLL_INTERVAL_MS, signal);
    }

    if (!matchBlockedEvidence) throw localFail('cross_intent_match_not_blocked_by_blocker');
    if (!wrongSettled || !wrongFinishedWhileMatchBlocked) {
      throw localFail('cross_intent_wrong_did_not_finish_while_match_blocked');
    }
    // Wrong must be legitimate invalid (null), not a thrown error.
    if (wrongErr) throw localFail('unexpected_error');
    if (wrongOutcome != null) throw localFail('cross_intent_wrong_not_invalid');

    // While matching owner remains demonstrably blocked and wrong already invalid:
    // snapshot exact row fields and compare byte/value-identical to pre-launch fixture (all columns).
    midBlockedRow = await snapshotOauthTxnFullRow(obs.client, stateHash);
    // Re-confirm match still blocked by exact blocker before accepting zero-mutation evidence.
    {
      const blk2 = await obs.client.query(
        `SELECT pg_blocking_pids($1::int) AS blockers`,
        [matchW.identity.pid],
      );
      const blockers2 = (blk2.rows && blk2.rows[0] && Array.isArray(blk2.rows[0].blockers))
        ? blk2.rows[0].blockers.map(Number) : [];
      if (!blockers2.includes(blocker.identity.pid)) {
        throw localFail('cross_intent_match_not_blocked_at_snapshot');
      }
    }
    fullRowIdenticalWhileMatchBlocked = fullRowsByteIdentical(preLaunchRowFixture, midBlockedRow);
    if (!fullRowIdenticalWhileMatchBlocked) throw localFail('cross_intent_row_mutated_before_release');

    // Only then release matching owner.
    await blocker.client.query('ROLLBACK');
    released = true;
    await Promise.all([
      withTimeout(matchPromise, SETTLE_AFTER_RELEASE_MS, 'cross_intent_match_settle_timeout'),
      withTimeout(wrongPromise, SETTLE_AFTER_RELEASE_MS, 'cross_intent_wrong_settle_timeout'),
    ]);

    if (matchErr) throw localFail('unexpected_error');
    if (matchOutcome == null) throw localFail('cross_intent_match_not_accepted');

    return Object.freeze({
      matchOutcome,
      wrongOutcome,
      wrongFinishedWhileMatchBlocked,
      fullRowIdenticalWhileMatchBlocked,
      preLaunchRowFixture,
      midBlockedRow,
      matchBlockedEvidence,
      matchPid: matchW.identity.pid,
      wrongPid: wrongW.identity.pid,
      blockerPid: blocker.identity.pid,
    });
  } catch (e) {
    if (!released) {
      try { await blocker.client.query('ROLLBACK'); } catch { /* release */ }
    }
    rethrowLocalOr('cross_intent_failed', e);
  } finally {
    await Promise.all([
      safeEndClient(blocker.client),
      safeEndClient(matchW.client),
      safeEndClient(wrongW.client),
      safeEndClient(obs.client),
    ]);
  }
}

/**
 * Revalidate identity tuple against pg_stat_activity.
 * @returns {'absent'|'match'|'mismatch'|'uncertain'}
 */
async function revalidateBackendIdentity(client, rec, runToken, expectedDatabase) {
  if (!rec || typeof rec.pid !== 'number' || rec.pid <= 0) return 'mismatch';
  let live;
  try {
    const r = await withClientOpTimeout(
      client,
      () => client.query(
        `SELECT pid::int AS pid,
                application_name::text AS application_name,
                backend_start::text AS backend_start,
                datname::text AS datname,
                datid::oid AS datid
           FROM pg_stat_activity
          WHERE pid = $1`,
        [rec.pid],
      ),
      CLEANUP_STEP_MS,
      'cancel_identity_query_timeout',
    );
    live = r.rows && r.rows[0];
  } catch (e) {
    if (localCode(e) === 'cancel_identity_query_timeout') return 'uncertain';
    return 'uncertain';
  }
  if (!live) return 'absent';
  const appOk = appNameHasRunToken(String(live.application_name || ''), runToken)
    && String(live.application_name) === rec.application_name;
  const startOk = String(live.backend_start) === rec.backend_start;
  const dbOk = String(live.datname || '') === rec.datname
    && (expectedDatabase ? String(live.datname) === expectedDatabase : true)
    && (rec.datid == null || Number(live.datid) === Number(rec.datid));
  if (!appOk || !startOk || !dbOk) return 'mismatch';
  return 'match';
}

async function waitBackendAbsent(client, rec, runToken, expectedDatabase, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const st = await revalidateBackendIdentity(client, rec, runToken, expectedDatabase);
    if (st === 'absent') return 'absent';
    if (st === 'mismatch') return 'mismatch';
    if (st === 'uncertain') return 'uncertain';
    await sleep(BACKEND_ABSENCE_POLL_MS);
  }
  const final = await revalidateBackendIdentity(client, rec, runToken, expectedDatabase);
  return final;
}

/**
 * Enumerate ALL live backends whose application_name has the exact unguessable run-token prefix.
 * Independent of the durable registry (covers connect→registry gap survivors).
 */
async function enumerateLiveTokenBackends(client, runToken, expectedDatabase) {
  const prefix = `${runToken}_`;
  let r;
  try {
    r = await withClientOpTimeout(
      client,
      () => client.query(
        `SELECT pid::int AS pid,
                application_name::text AS application_name,
                backend_start::text AS backend_start,
                datname::text AS datname,
                datid::oid AS datid,
                state::text AS state,
                wait_event_type::text AS wait_event_type
           FROM pg_stat_activity
          WHERE left(application_name, length($1::text)) = $1::text
            AND ($2::text IS NULL OR datname = $2::text)`,
        [prefix, expectedDatabase || null],
      ),
      CLEANUP_STEP_MS,
      'enumerate_token_backends_timeout',
    );
  } catch (e) {
    if (localCode(e)) throw e;
    throw localFail('cleanup_unverified');
  }
  const out = [];
  for (const row of r.rows || []) {
    if (!row || typeof row.pid !== 'number') continue;
    if (!appNameHasRunToken(String(row.application_name || ''), runToken)) continue;
    out.push({
      pid: row.pid,
      application_name: String(row.application_name),
      backend_start: String(row.backend_start),
      datname: String(row.datname || ''),
      datid: row.datid != null ? Number(row.datid) : null,
      state: row.state != null ? String(row.state) : null,
      wait_event_type: row.wait_event_type != null ? String(row.wait_event_type) : null,
    });
  }
  return out;
}

/**
 * Merge registry entries with live exact-token backends. Unregistered token backends are
 * captured with full server identity for cleanup only after exact target server validation.
 */
function mergeRegistryWithLiveTokenBackends(registered, live) {
  const byKey = new Map();
  function keyOf(r) {
    return `${r.pid}|${r.application_name}|${r.backend_start}|${r.datname}`;
  }
  for (const r of registered || []) {
    byKey.set(keyOf(r), {
      pid: r.pid,
      application_name: r.application_name,
      backend_start: r.backend_start,
      datname: r.datname,
      datid: r.datid == null ? null : r.datid,
      from_registry: true,
    });
  }
  for (const l of live || []) {
    const k = keyOf(l);
    if (!byKey.has(k)) {
      byKey.set(k, {
        pid: l.pid,
        application_name: l.application_name,
        backend_start: l.backend_start,
        datname: l.datname,
        datid: l.datid == null ? null : l.datid,
        from_registry: false,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Read exact control-connection identity (PID + app_name + backend_start + DB).
 * Used to exclude only this connection from token-backend zero/activity checks.
 */
async function readControlBackendIdentity(client) {
  if (!client) throw localFail('cleanup_unverified');
  let r;
  try {
    r = await withClientOpTimeout(
      client,
      () => client.query(
        `SELECT a.pid::int AS pid,
                a.application_name::text AS application_name,
                a.backend_start::text AS backend_start,
                a.datname::text AS datname,
                a.datid::oid AS datid
           FROM pg_stat_activity a
          WHERE a.pid = pg_backend_pid()`,
      ),
      CLEANUP_STEP_MS,
      'identity_query_timeout',
    );
  } catch (e) {
    if (localCode(e)) throw e;
    throw localFail('identity_query_failed');
  }
  const row = r && r.rows && r.rows[0];
  if (!row || typeof row.pid !== 'number') throw localFail('identity_missing');
  return {
    pid: row.pid,
    application_name: String(row.application_name || ''),
    backend_start: String(row.backend_start || ''),
    datname: String(row.datname || ''),
    datid: row.datid != null ? Number(row.datid) : null,
  };
}

/**
 * Open cleanup/cancel/drop/verify client: exact app name, pinned server identity, TLS verify-full.
 * Every connection re-runs current_database + exact inet_server_addr against the authenticated
 * bootstrap pin (no DNS re-resolve; mismatch refuses cleanup).
 * Returns { client, identity } — identity is the exact control exclusion key.
 * Tracks the client as active cleanup control for outer AbortController cancellation.
 */
async function openCleanupClient(Client, opts) {
  const {
    parsedUrl, runToken, role, stagingTarget, pinnedIdentity, signal,
  } = opts;
  if (signal && signal.aborted) throw localFail('aborted');
  const name = appNameFor(runToken, role);
  const c = new Client(buildPgClientConfig(parsedUrl, {
    applicationName: name,
    expectedHost: stagingTarget.expectedHost,
    connectionTimeoutMillis: CONNECT_MS,
  }));
  trackActiveCleanupControl(c, null);
  const onAbort = () => {
    try { forceDestroyClient(c); } catch { /* ignore */ }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      await withClientOpTimeout(
        c,
        () => c.connect(),
        CONNECT_MS + 500,
        'cleanup_connect_timeout',
      );
    } catch {
      await safeEndUnregisteredClient(c);
      throw localFail('cleanup_unverified');
    }
    let identity;
    try {
      await assertConnectedServerIdentity(c, stagingTarget, pinnedIdentity);
      // Confirm token app name on the cleanup session itself.
      const shown = await withClientOpTimeout(
        c,
        () => c.query('SHOW application_name'),
        CLEANUP_STEP_MS,
        'app_name_verify_timeout',
      );
      const app = shown.rows && shown.rows[0] && shown.rows[0].application_name;
      if (app !== name || !appNameHasRunToken(String(app || ''), runToken)) {
        throw localFail('cleanup_unverified');
      }
      await withClientOpTimeout(
        c,
        () => c.query(`SET statement_timeout = ${STATEMENT_MS}`),
        CLEANUP_STEP_MS,
        'session_setup_timeout',
      );
      identity = await readControlBackendIdentity(c);
      if (identity.application_name !== name) throw localFail('cleanup_unverified');
      trackActiveCleanupControl(c, identity);
    } catch (e) {
      try { await safeEndClient(c); } catch { forceDestroyClient(c); }
      if (localCode(e)) throw localFail('cleanup_unverified');
      throw localFail('cleanup_unverified');
    }
    if (signal && signal.aborted) {
      forceDestroyClient(c);
      throw localFail('aborted');
    }
    return { client: c, identity };
  } catch (e) {
    untrackActiveCleanupControl(c);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw e;
  }
}

async function endCleanupClient(handle) {
  const c = handle && handle.client;
  if (!c) return;
  try {
    await withClientOpTimeout(c, () => c.end(), CLEANUP_STEP_MS, 'cleanup_client_end_timeout');
  } catch {
    forceDestroyClient(c);
    throw localFail('cleanup_unverified');
  } finally {
    untrackActiveCleanupControl(c);
  }
}

/**
 * Identity-bound cancel → bounded wait → revalidate → terminate → absence verification.
 * Before any signal: exact DB identity + token app name already verified on cleanup client;
 * records merged from registry + live exact-token enumeration.
 * Mismatch / PID reuse → do not signal → cleanup_unverified.
 */
async function cancelAndTerminateOwnedBackends(Client, opts) {
  const {
    parsedUrl, runToken, records, stagingTarget, pinnedIdentity, signal,
  } = opts;
  if (signal && signal.aborted) throw localFail('aborted');
  const expectedDatabase = stagingTarget.expectedDatabase;
  const opened = await openCleanupClient(Client, {
    parsedUrl, runToken, role: ROLE.cleanup, stagingTarget, pinnedIdentity, signal,
  });
  const c = opened.client;
  const controlIdentity = opened.identity;
  let closeUncertain = false;
  try {
    if (signal && signal.aborted) throw localFail('aborted');
    // Enumerate exact token prefix and merge with provided records before any signal.
    const live = await enumerateLiveTokenBackends(c, runToken, expectedDatabase);
    const merged = mergeRegistryWithLiveTokenBackends(records || [], live);

    for (const rec of merged) {
      if (signal && signal.aborted) throw localFail('aborted');
      // Never cancel/terminate the exact current control connection.
      if (sameBackendIdentity(rec, controlIdentity)) continue;

      const before = await revalidateBackendIdentity(c, rec, runToken, expectedDatabase);
      if (before === 'absent') continue;
      if (before === 'mismatch') throw localFail('cleanup_unverified');
      if (before === 'uncertain') throw localFail('cleanup_unverified');

      // Cooperative cancel only after exact identity match.
      try {
        await withClientOpTimeout(
          c,
          () => c.query('SELECT pg_cancel_backend($1)', [rec.pid]),
          CLEANUP_STEP_MS,
          'cancel_backend_timeout',
        );
      } catch (e) {
        if (localCode(e) === 'cancel_backend_timeout') throw localFail('cleanup_unverified');
        throw localFail('cleanup_unverified');
      }

      let afterCancel = await waitBackendAbsent(
        c, rec, runToken, expectedDatabase, BACKEND_ABSENCE_MS,
      );
      if (afterCancel === 'absent') continue;
      if (afterCancel === 'mismatch') throw localFail('cleanup_unverified');
      if (afterCancel === 'uncertain') throw localFail('cleanup_unverified');

      const beforeTerm = await revalidateBackendIdentity(c, rec, runToken, expectedDatabase);
      if (beforeTerm === 'absent') continue;
      if (beforeTerm === 'mismatch' || beforeTerm === 'uncertain') {
        throw localFail('cleanup_unverified');
      }
      try {
        await withClientOpTimeout(
          c,
          () => c.query('SELECT pg_terminate_backend($1)', [rec.pid]),
          CLEANUP_STEP_MS,
          'terminate_backend_timeout',
        );
      } catch (e) {
        if (localCode(e) === 'terminate_backend_timeout') throw localFail('cleanup_unverified');
        throw localFail('cleanup_unverified');
      }

      const afterTerm = await waitBackendAbsent(
        c, rec, runToken, expectedDatabase, BACKEND_ABSENCE_MS,
      );
      if (afterTerm === 'absent') continue;
      if (afterTerm === 'mismatch' || afterTerm === 'uncertain') {
        throw localFail('cleanup_unverified');
      }
      throw localFail('cleanup_failed');
    }

    // Before schema drop: zero registered identities and zero live exact-token backends.
    for (const rec of merged) {
      if (sameBackendIdentity(rec, controlIdentity)) continue;
      const st = await revalidateBackendIdentity(c, rec, runToken, expectedDatabase);
      if (st === 'absent') continue;
      if (st === 'match') throw localFail('cleanup_failed');
      throw localFail('cleanup_unverified');
    }
    const liveAfter = await enumerateLiveTokenBackends(c, runToken, expectedDatabase);
    // Exclude only the exact current control identity (never broad role/app_name).
    const residual = excludeExactControlIdentity(liveAfter, controlIdentity);
    if (residual.length !== 0) throw localFail('cleanup_failed');
  } finally {
    try {
      await endCleanupClient(opened);
    } catch {
      closeUncertain = true;
      forceDestroyClient(c);
      untrackActiveCleanupControl(c);
    }
  }
  if (closeUncertain) throw localFail('cleanup_unverified');
}

async function dropAndVerifySchema(Client, opts) {
  const {
    parsedUrl, runToken, schema, stagingTarget, pinnedIdentity, signal,
  } = opts;
  if (signal && signal.aborted) throw localFail('aborted');
  const expectedDatabase = stagingTarget.expectedDatabase;
  const opened = await openCleanupClient(Client, {
    parsedUrl, runToken, role: ROLE.verify, stagingTarget, pinnedIdentity, signal,
  });
  const c = opened.client;
  const controlIdentity = opened.identity;
  let closeUncertain = false;
  try {
    if (signal && signal.aborted) throw localFail('aborted');
    // Before drop: zero live exact-token backends (exclude only exact verify control identity).
    const liveBefore = await enumerateLiveTokenBackends(c, runToken, expectedDatabase);
    const residualBefore = excludeExactControlIdentity(liveBefore, controlIdentity);
    if (residualBefore.length !== 0) throw localFail('cleanup_failed');

    // DROP timeout: destroy exact control client, preserve registry (caller), report
    // cleanup_unverified — do not start a concurrent conflicting drop/cleanup on another client.
    try {
      await withClientOpTimeout(
        c,
        () => c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
        CLEANUP_STEP_MS,
        'drop_schema_timeout',
      );
    } catch (e) {
      // Socket already destroyed by withClientOpTimeout; do not race a second cleanup client.
      if (localCode(e) === 'drop_schema_timeout') throw localFail('cleanup_unverified');
      throw localFail('cleanup_unverified');
    }
    if (signal && signal.aborted) throw localFail('aborted');
    let check;
    try {
      check = await withClientOpTimeout(
        c,
        () => c.query(`SELECT 1 AS x FROM pg_namespace WHERE nspname = $1`, [schema]),
        CLEANUP_STEP_MS,
        'verify_schema_timeout',
      );
    } catch (e) {
      if (localCode(e) === 'verify_schema_timeout') throw localFail('cleanup_unverified');
      throw localFail('cleanup_unverified');
    }
    if (check.rows.length !== 0) throw localFail('cleanup_failed');

    // After schema drop: zero token backends (exact control exclusion only) and absent schema.
    const liveAfter = await enumerateLiveTokenBackends(c, runToken, expectedDatabase);
    const residualAfter = excludeExactControlIdentity(liveAfter, controlIdentity);
    if (residualAfter.length !== 0) throw localFail('cleanup_failed');
  } finally {
    try {
      await endCleanupClient(opened);
    } catch {
      closeUncertain = true;
      forceDestroyClient(c);
      untrackActiveCleanupControl(c);
    }
  }
  if (closeUncertain) throw localFail('cleanup_unverified');
}

/**
 * cleanup_unverified: registry loss/corruption, worker termination uncertainty,
 * cancel/terminate uncertainty, close uncertainty, cleanup timeout, DB connection/
 * verification uncertainty. cleanup_failed: authoritatively known unsuccessful.
 * Neither may PASS.
 */
function isCleanupUnverified(code) {
  return code === 'cleanup_unverified'
    || code === 'connect_failed'
    || code === 'cleanup_connect_timeout'
    || code === 'cleanup_timeout'
    || code === 'registry_close_timeout'
    || code === 'owned_close_failed'
    || code === 'client_end_timeout'
    || code === 'client_end_failed'
    || code === 'rollback_timeout'
    || code === 'pool_end_timeout'
    || code === 'pool_end_failed'
    || code === 'cancel_backend_timeout'
    || code === 'terminate_backend_timeout'
    || code === 'cancel_identity_query_timeout'
    || code === 'cancel_identity_query_failed'
    || code === 'drop_schema_timeout'
    || code === 'verify_schema_timeout'
    || code === 'cleanup_ownership_mismatch'
    || code === 'worker_exit_unverified'
    || code === 'cleanup_child_timeout'
    || code === 'registry_load_unverified'
    || code === 'identity_query_timeout'
    || code === 'enumerate_token_backends_timeout'
    || code === 'server_identity_query_timeout'
    || code === 'registry_dir_open_failed'
    || code === 'registry_dir_fsync_failed'
    || code === 'registry_dir_close_failed';
}

/**
 * Supervisor post-cleanup evidence: zero live exact-token backends in the expected
 * database (excluding only the exact verify control identity) and schema absence.
 * Mismatch/uncertain → cleanup_unverified. Does not claim server-global zero backends.
 * @returns {{zeroTokenBackends: boolean, schemaAbsent: boolean}}
 */
async function verifySupervisorCleanupEvidence(Client, opts) {
  const {
    parsedUrl, runToken, schema, stagingTarget, pinnedIdentity, signal,
  } = opts;
  if (signal && signal.aborted) throw localFail('aborted');
  const expectedDatabase = stagingTarget.expectedDatabase;
  const opened = await openCleanupClient(Client, {
    parsedUrl, runToken, role: ROLE.verify, stagingTarget, pinnedIdentity, signal,
  });
  const c = opened.client;
  const controlIdentity = opened.identity;
  let closeUncertain = false;
  let zeroTokenBackends = false;
  let schemaAbsent = false;
  try {
    if (signal && signal.aborted) throw localFail('aborted');
    const live = await enumerateLiveTokenBackends(c, runToken, expectedDatabase);
    const residual = excludeExactControlIdentity(live, controlIdentity);
    zeroTokenBackends = residual.length === 0;
    const check = await withClientOpTimeout(
      c,
      () => c.query(`SELECT 1 AS x FROM pg_namespace WHERE nspname = $1`, [schema]),
      CLEANUP_STEP_MS,
      'verify_schema_timeout',
    );
    schemaAbsent = !check.rows || check.rows.length === 0;
  } finally {
    try {
      await endCleanupClient(opened);
    } catch {
      closeUncertain = true;
      forceDestroyClient(c);
      untrackActiveCleanupControl(c);
    }
  }
  if (closeUncertain) throw localFail('cleanup_unverified');
  return { zeroTokenBackends, schemaAbsent };
}

/**
 * Assert no expected-database run-token backends are active/waiting after settle.
 * Queries ALL exact run-token backends in the expected database (not selected PIDs).
 * Excludes only the exact current control connection identity (PID+app_name+backend_start+DB).
 * - state='active' fails regardless of wait_event_type (including NULL)
 * - any non-null wait_event_type fails
 * Never broad role/application_name exclusion.
 * Optional controlIdentity: when omitted, reads exact identity from the control client.
 */
async function assertNoRunTokenBackendsWaitingActive(
  client, runToken, expectedDatabase, controlIdentity,
) {
  if (!expectedDatabase || typeof expectedDatabase !== 'string') return false;
  let control = controlIdentity || null;
  if (!control) {
    try {
      control = await readControlBackendIdentity(client);
    } catch {
      return false;
    }
  }
  const live = await enumerateLiveTokenBackends(client, runToken, expectedDatabase);
  for (const b of live) {
    if (!appNameHasRunToken(String(b.application_name || ''), runToken)) return false;
  }
  if (!evaluateNoExpectedDatabaseRunTokenBackendsActiveOrWaiting(live, control)) {
    return false;
  }
  // Also reject ungranted locks held by any exact-token residual backend (not control).
  const residual = excludeExactControlIdentity(live, control);
  const pids = residual.map((b) => b.pid);
  if (pids.length) {
    const ungranted = await withClientOpTimeout(
      client,
      () => client.query(
        `SELECT pid FROM pg_locks WHERE pid = ANY($1::int[]) AND NOT granted`,
        [pids],
      ),
      CLEANUP_STEP_MS,
      'ungranted_locks_query_timeout',
    );
    if ((ungranted.rows || []).length > 0) return false;
  }
  return true;
}

/**
 * Outer supervisor cleanup with cooperative AbortController.
 * On timeout: abort signal + destroy exact active cleanup client, then await
 * bounded cleanup settlement. Never merely races a reject while cleanup continues.
 */
async function supervisorCleanupWithOuterTimeout(opts, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ac.abort(); } catch { /* ignore */ }
    try { abortActiveCleanupControl(); } catch { /* ignore */ }
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const cleanupPromise = supervisorCleanup({ ...opts, signal: ac.signal });
  let settlement;
  try {
    settlement = await cleanupPromise;
    if (timedOut) throw localFail('cleanup_unverified');
    return settlement;
  } catch (e) {
    // Ensure cleanup promise has been observed; if timeout fired mid-flight,
    // await bounded settlement so the operation cannot continue unobserved.
    if (timedOut) {
      try {
        await Promise.race([
          Promise.resolve(cleanupPromise).catch(() => null),
          sleep(CLEANUP_STEP_MS),
        ]);
      } catch { /* ignore */ }
      throw localFail('cleanup_unverified');
    }
    const code = localCode(e) || 'cleanup_failed';
    if (code === 'aborted') throw localFail('cleanup_unverified');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function supervisorCleanup(opts) {
  const {
    Client, parsedUrl, runToken, schema, stagingTarget, pinnedIdentity, registered, registry,
    signal,
  } = opts;
  if (!stagingTarget || !pinnedIdentity) throw localFail('cleanup_unverified');
  if (signal && signal.aborted) throw localFail('aborted');
  const deadline = Date.now() + SUPERVISOR_CLEANUP_MS;
  let closeUncertain = false;
  try {
    // Snapshot identity entries before close mutates in-memory registry.
    let recs;
    if (Array.isArray(registered)) {
      recs = registered.slice();
    } else if (registry) {
      recs = registry.list().map((r) => ({
        pid: r.pid,
        application_name: r.application_name,
        backend_start: r.backend_start,
        datname: r.datname,
        datid: r.datid,
      }));
    } else {
      // No authoritative registry → cannot verify cleanup completeness.
      throw localFail('cleanup_unverified');
    }

    if (registry) {
      try {
        await withTimeout(registry.closeAll(), CLEANUP_STEP_MS, 'registry_close_timeout');
      } catch {
        // Close failure/timeout is terminal uncertainty — still escalate backends first.
        closeUncertain = true;
      }
    }
    if (Date.now() > deadline) throw localFail('cleanup_unverified');
    if (signal && signal.aborted) throw localFail('aborted');

    try {
      await cancelAndTerminateOwnedBackends(Client, {
        parsedUrl, runToken, records: recs, stagingTarget, pinnedIdentity, signal,
      });
    } catch (e) {
      const code = localCode(e) || 'cleanup_failed';
      // After backend escalation attempt, force-destroy only post-terminate path.
      if (registry) registry.forceDestroyAll();
      if (code === 'aborted' || isCleanupUnverified(code) || code === 'cleanup_unverified') {
        throw localFail('cleanup_unverified');
      }
      throw localFail(code === 'cleanup_failed' ? 'cleanup_failed' : code);
    }

    // Force-destroy sockets only after identity-bound backend termination.
    if (registry) registry.forceDestroyAll();
    if (closeUncertain) throw localFail('cleanup_unverified');
    if (signal && signal.aborted) throw localFail('aborted');

    if (Date.now() > deadline) throw localFail('cleanup_unverified');
    // Schema DROP timeout inside dropAndVerifySchema: cleanup_unverified, no concurrent
    // conflicting cleanup, registry preserved by outer disposition logic.
    await dropAndVerifySchema(Client, {
      parsedUrl, runToken, schema, stagingTarget, pinnedIdentity, signal,
    });
    if (signal && signal.aborted) throw localFail('aborted');
    const evidence = await verifySupervisorCleanupEvidence(Client, {
      parsedUrl, runToken, schema, stagingTarget, pinnedIdentity, signal,
    });
    if (!evidence.zeroTokenBackends || !evidence.schemaAbsent) {
      throw localFail('cleanup_failed');
    }
    return evidence;
  } catch (e) {
    const code = localCode(e) || 'cleanup_failed';
    if (code === 'aborted') throw localFail('cleanup_unverified');
    if (isCleanupUnverified(code)) throw localFail('cleanup_unverified');
    if (code === 'cleanup_failed' || code === 'cleanup_schema_still_present') {
      throw localFail('cleanup_failed');
    }
    if (code === 'cleanup_database_mismatch') throw localFail('cleanup_failed');
    throw localFail(isCleanupUnverified(code) ? 'cleanup_unverified' : code);
  }
}

async function runWorkerProof(env) {
  const urlRaw = env[URL_ENV];
  const runToken = env[RUN_TOKEN_ENV];
  const schema = env[SCHEMA_ENV];
  if (!runToken || !schema) throw localFail('worker_env_missing');
  if (!/^pb_stock_[a-z0-9]+$/.test(schema)) throw localFail('schema_name_invalid');

  const parsedUrl = parseDedicatedStockPgUrl(urlRaw);
  const stagingTarget = resolveStagingTargetIdentity(env, parsedUrl);
  // Immutable authenticated bootstrap pin from supervisor — never re-resolve / never DNS-only.
  const pinnedIdentity = parsePinnedServerIdentity(env[PINNED_SERVER_IDENTITY_ENV]);
  const pinnedAddrSet = parsePinnedAddressSet(env[PINNED_ADDRS_ENV]);
  if (pinnedAddrSet.size !== 1 || !pinnedAddrSet.has(pinnedIdentity.server_addr)) {
    throw localFail('pinned_identity_invalid');
  }
  installExternalTrafficTraps(parsedUrl);
  const prod = loadProductionModules();
  assertProductionRequireGraph();

  const {
    Client, Pool,
    createPostgresOAuthTransactionRepository,
    createPostgresPhaseBOauthTransactionConsumer,
    createMicrosoftPhaseBVerifiedGrantReplacer,
    REPLACED_STATUS,
    OUTCOME_UNKNOWN,
    GEN_MAX,
    REPLACER_ERROR_CODE,
    asCanonGen,
    genPlus1,
    SQL_LOCK,
    createFakeEmailGrantEnvelopeProvider,
    buildGrantEnvelopeAadV1,
    prepareMigrationBody,
  } = prod;

  const GEN_MAX_STR = GEN_MAX.toString(10);
  const GEN_MAX_MINUS_1 = (GEN_MAX - 1n).toString(10);

  const UP060 = fs.readFileSync(
    path.join(ROOT, 'database/migrations/060_tenant_email_oauth_transactions.sql'), 'utf8',
  );
  const UP061 = fs.readFileSync(
    path.join(ROOT, 'database/migrations/061_tenant_email_oauth_transaction_endpoint_binding.sql'), 'utf8',
  );
  const UP071 = fs.readFileSync(
    path.join(ROOT, 'database/migrations/071_tenant_email_phase_b_authority.sql'), 'utf8',
  );

  const providerCounters = { seal: 0, open: 0, rewrap: 0, other: 0 };
  function createCountingEnvelopeProvider() {
    const base = createFakeEmailGrantEnvelopeProvider();
    return Object.freeze({
      async sealGrantPayload(input) {
        providerCounters.seal += 1;
        return base.sealGrantPayload(input);
      },
      async openGrantPayload(input) {
        providerCounters.open += 1;
        throw localFail('envelope_open_forbidden_in_proof');
      },
      async rewrapGrantDek(input) {
        providerCounters.rewrap += 1;
        throw localFail('envelope_rewrap_forbidden_in_proof');
      },
    });
  }

  async function applyPrepared(client, sqlText, label) {
    const prepared = prepareMigrationBody(sqlText);
    if (!prepared.ok || !prepared.body) throw localFail(`migration_prepare_${label}`);
    await client.query(prepared.body);
  }

  async function seedParents(client) {
    await client.query(
      `INSERT INTO clients (id, slug, name) VALUES ($1,'stock-pg-client','Stock PG')`,
      [IDS.client],
    );
    await client.query(
      `INSERT INTO staff_users (id, client_id, email) VALUES ($1,$2,'staff@example.test')`,
      [IDS.staff, IDS.client],
    );
    await client.query(
      `INSERT INTO auth_sessions (id, staff_user_id, client_id, session_token_hash, expires_at)
       VALUES ($1,$2,$3,'hash-proof-only', NOW() + interval '1 hour')`,
      [IDS.session, IDS.staff, IDS.client],
    );
    await client.query(
      `INSERT INTO tenant_locations (id, client_id, location_id, display_name)
       VALUES ($1,$2,$3,'Stock')`,
      [IDS.location, IDS.client, LOCATION_SLUG],
    );
    await client.query(
      `INSERT INTO tenant_channel_endpoints (
         id, client_id, location_id, provider, public_address, capabilities,
         auth_mode, connector_mode, provider_tenant_id, provider_principal_oid,
         provider_resource_id, mailbox_kind, mailbox_access_kind, binding_status
       ) VALUES (
         $1,$2,$3,'microsoft_graph',$4,$5::jsonb,
         'delegated_authorization_code','microsoft_delegated_oauth',$6,$7,
         $7,'user','own_user','verified'
       )`,
      [IDS.endpoint, IDS.client, LOCATION_SLUG, MAIL, CAPS_J, IDS.tenant, IDS.principal],
    );
    await client.query(
      `INSERT INTO tenant_channel_endpoints (
         id, client_id, location_id, provider, public_address, capabilities,
         auth_mode, connector_mode, binding_status
       ) VALUES (
         $1,$2,$3,'microsoft_graph','phase-a@example.test',$4::jsonb,
         'delegated_authorization_code','microsoft_delegated_oauth','unverified_offline'
       )`,
      [IDS.endpointB, IDS.client, LOCATION_SLUG, CAPS_J],
    );
  }

  async function insertOauthTxn(client, insertOpts) {
    const { stateHash, intent, priorGen, endpointId } = insertOpts;
    const id = crypto.randomUUID();
    if (intent === 'phase_b_reauthorization') {
      await client.query(
        `INSERT INTO tenant_email_oauth_transactions
          (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
           state_hash, code_verifier, nonce, issued_at, expires_at,
           authorization_intent, scope_version, prior_grant_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds',
                 'phase_b_reauthorization','phase_b_v1',$10::bigint)`,
        [
          id, IDS.client, IDS.location, IDS.staff, IDS.session, endpointId || IDS.endpoint,
          stateHash, 'v'.repeat(43), 'n'.repeat(43), String(priorGen),
        ],
      );
    } else {
      await client.query(
        `INSERT INTO tenant_email_oauth_transactions
          (id, client_id, location_id, staff_user_id, auth_session_id, endpoint_id,
           state_hash, code_verifier, nonce, issued_at, expires_at,
           authorization_intent, scope_version, prior_grant_generation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()+interval '60 seconds',
                 'initial_connect','phase_a_v2',NULL)`,
        [
          id, IDS.client, IDS.location, IDS.staff, IDS.session, endpointId || IDS.endpointB,
          stateHash, 'v'.repeat(43), 'n'.repeat(43),
        ],
      );
    }
  }

  async function countConsumed(client, stateHash) {
    const r = await client.query(
      `SELECT count(*)::int AS n FROM tenant_email_oauth_transactions
        WHERE state_hash=$1::bytea AND consumed_at IS NOT NULL`,
      [stateHash],
    );
    return r.rows[0].n;
  }

  async function makeEnvelope(operationId, generation, refreshToken, provider) {
    const p = provider || createCountingEnvelopeProvider();
    const aad = buildGrantEnvelopeAadV1({
      clientId: IDS.client,
      endpointId: IDS.endpoint,
      grantGeneration: generation,
      operationId,
    });
    return p.sealGrantPayload({
      refresh_token: refreshToken || `rt-proof-${operationId.slice(0, 8)}`,
      aad,
      operation_id: operationId,
    });
  }

  function identity() {
    return Object.freeze({
      providerTenantId: IDS.tenant,
      providerPrincipalId: IDS.principal,
      mailboxAddress: MAIL,
      displayName: 'Front Desk',
    });
  }

  async function seedGrant(client, generation, scopeVersion, operationId) {
    const envl = await makeEnvelope(operationId, generation, `rt-seed-${String(generation).slice(0, 8)}`);
    await client.query(
      `DELETE FROM tenant_email_delegated_grants WHERE client_id=$1 AND endpoint_id=$2`,
      [IDS.client, IDS.endpoint],
    );
    await client.query(
      `INSERT INTO tenant_email_delegated_grants (
         id, client_id, endpoint_id, grant_generation, grant_status, last_operation_id,
         reconcile_state, scope_version,
         envelope_version, aead_alg, kek_wrap_alg, kek_key_name, kek_key_version,
         nonce, ciphertext, auth_tag, wrapped_dek
       ) VALUES (
         $1,$2,$3,$4::bigint,'active',$5,'clean',$6,
         $7,$8,$9,$10,$11,$12,$13,$14,$15
       )`,
      [
        crypto.randomUUID(), IDS.client, IDS.endpoint, String(generation), operationId, scopeVersion,
        envl.envelope_version, envl.aead_alg, envl.kek_wrap_alg, envl.kek_key_name, envl.kek_key_version,
        envl.nonce, envl.ciphertext, envl.auth_tag, envl.wrapped_dek,
      ],
    );
  }

  async function readGrantGen(client) {
    const r = await client.query(
      `SELECT grant_generation::text AS g, scope_version, grant_status, last_operation_id::text AS op
         FROM tenant_email_delegated_grants
        WHERE client_id=$1 AND endpoint_id=$2`,
      [IDS.client, IDS.endpoint],
    );
    return r.rows[0] || null;
  }

  const expectedDatabase = stagingTarget.expectedDatabase;
  const registryPath = env[REGISTRY_ENV] || null;
  if (!registryPath) throw localFail('registry_path_missing');
  const registry = createOwnershipRegistry(runToken, schema, registryPath);
  /** Snapshotted at worker-local cleanup for supervisor handoff. */
  let cleanupRegistrySnapshot = [];
  const pool = new Pool(Object.assign(
    buildPgClientConfig(parsedUrl, {
      applicationName: appNameFor(runToken, ROLE.seed),
      expectedHost: stagingTarget.expectedHost,
      connectionTimeoutMillis: CONNECT_MS,
    }),
    { max: POOL_MAX, idleTimeoutMillis: 5_000 },
  ));
  if (pool.options.max < 2) throw localFail('pool_max_lt_2');

  const passed = [];
  let failCount = 0;
  function ok(name, cond) {
    // Worker only owns WORKER_CHECK_NAMES; supervisor owns final cleanup checks.
    const expected = WORKER_CHECK_NAMES[passed.length + failCount];
    if (name !== expected) {
      failCount += 1;
      throw localFail('check_order_mismatch');
    }
    if (cond) {
      passed.push(name);
      return true;
    }
    failCount += 1;
    throw localFail(`check_failed_${name}`);
  }

  async function withSeedClient(fn) {
    const h = await openTrackedClient({
      Client, parsedUrl, runToken, role: ROLE.seed, schema,
      timeouts: { statement: STATEMENT_MS, lock: LOCK_MS },
      registry, expectedDatabase, stagingTarget, pinnedIdentity,
    });
    try {
      return await fn(h.client);
    } finally {
      await safeEndClient(h.client);
    }
  }

  let cleaned = false;
  let cleanupCode = null;

  /**
   * Worker-local cooperative close + best-effort backend/schema cleanup.
   * Does NOT claim supervisor final cleanup checks or emit PASS transcript.
   */
  async function cleanupBounded() {
    if (cleaned) return cleanupCode;
    cleaned = true;
    const deadline = Date.now() + CLEANUP_MS;
    try {
      cleanupRegistrySnapshot = registry.list().map((r) => ({
        pid: r.pid,
        application_name: r.application_name,
        backend_start: r.backend_start,
        datname: r.datname,
        datid: r.datid,
      }));
      await supervisorCleanup({
        Client,
        parsedUrl,
        runToken,
        schema,
        stagingTarget,
        pinnedIdentity,
        registered: cleanupRegistrySnapshot,
        registry,
      });
      if (Date.now() > deadline) throw localFail('cleanup_unverified');
      try {
        await withTimeout(pool.end(), CLEANUP_STEP_MS, 'pool_end_timeout');
      } catch {
        throw localFail('cleanup_unverified');
      }
      cleanupCode = null;
      return null;
    } catch (e) {
      const code = localCode(e) || 'cleanup_failed';
      cleanupCode = isCleanupUnverified(code) ? 'cleanup_unverified' : code;
      try {
        await withTimeout(pool.end(), CLEANUP_STEP_MS, 'pool_end_timeout');
      } catch {
        if (cleanupCode !== 'cleanup_failed') cleanupCode = 'cleanup_unverified';
      }
      // Force-destroy only after terminate path inside supervisorCleanup; best-effort here.
      try { registry.forceDestroyAll(); } catch { /* terminal */ }
      throw localFail(cleanupCode);
    }
  }

  const ac = new AbortController();
  const cancelPath = env[CANCEL_ENV] || null;
  let cancelPoll = null;
  if (cancelPath) {
    cancelPoll = setInterval(() => {
      try {
        if (fs.existsSync(cancelPath)) ac.abort();
      } catch { /* ignore */ }
    }, 100);
    if (typeof cancelPoll.unref === 'function') cancelPoll.unref();
  }
  const overallTimer = setTimeout(() => {
    try { ac.abort(); } catch { /* ignore */ }
  }, OVERALL_MS);
  if (typeof overallTimer.unref === 'function') overallTimer.unref();

  let proofError = null;
  try {
    if (ac.signal.aborted) throw localFail('aborted');

    const boot = await openTrackedClient({
      Client, parsedUrl, runToken, role: ROLE.boot, schema: null,
      timeouts: { statement: 10_000, lock: LOCK_MS },
      registry, expectedDatabase, stagingTarget, pinnedIdentity, verifyServerIdentity: true,
    });
    try {
      async function bootStep(label, fn) {
        try { return await fn(); } catch { throw localFail(`boot_${label}_failed`); }
      }
      // No database-global extension DDL. Random bytes/UUIDs from Node only.
      // Server identity already verified — only then create temp schema.
      await bootStep('create_schema', () => boot.client.query(`CREATE SCHEMA ${schema}`));
      await bootStep('set_search_path', () => boot.client.query(`SET search_path TO ${schema}`));
      await bootStep('shell_ddl', () => boot.client.query(SHELL_DDL));
      await bootStep('migration_060', () => applyPrepared(boot.client, UP060, '060'));
      await bootStep('migration_061', () => applyPrepared(boot.client, UP061, '061'));
      await bootStep('migration_071', () => applyPrepared(boot.client, UP071, '071'));
      await bootStep('seed_parents', () => seedParents(boot.client));
      ok('schema_isolated_temp_migrations_060_061_071', true);
    } finally {
      await safeEndClient(boot.client);
    }

    const now = new Date(Date.now() + 2_000);
    const oauthLockSql = `SELECT id FROM tenant_email_oauth_transactions WHERE state_hash=$1::bytea FOR UPDATE`;
    const pairBase = {
      Client, parsedUrl, schema, signal: ac.signal, runToken, registry, expectedDatabase,
      stagingTarget, pinnedIdentity, prod,
    };

    // --- Phase A concurrent consume ---
    const aHash = crypto.randomBytes(32);
    await withSeedClient((c) => insertOauthTxn(c, { stateHash: aHash, intent: 'initial_connect' }));
    const aRace = await runBlockedPair({
      ...pairBase,
      lockSql: oauthLockSql, lockParams: [aHash],
      label: 'phase_a',
      classifyFn: (value, err, stats) => classifyConsumeResult(value, err, stats),
      workerFn: async (client) => {
        const repo = createPostgresOAuthTransactionRepository(client);
        return repo.consume({
          stateHash: aHash, clientId: IDS.client, authSessionId: IDS.session, now,
        });
      },
    });
    const aWins = aRace.outcomes.filter((o) => o && o.kind === 'accepted');
    const aLoss = aRace.outcomes.filter((o) => o && o.kind === 'invalid');
    ok('phase_a_blocking_pids_exact',
      !!(aRace.overlap && aRace.overlap.ok
        && aRace.overlap.blockerPid === aRace.blockerPid
        && aRace.overlap.evidence.length === 2
        && aRace.overlap.evidence.every((e) => e.blocker_path.includes(aRace.blockerPid))));
    ok('phase_a_worker_identity_verified',
      aRace.workerIdentities.every((w) => appNameHasRunToken(w.application_name, runToken)
        && w.datname === expectedDatabase));
    ok('phase_a_race_exactly_one_winner', aWins.length === 1 && aLoss.length === 1);
    ok('phase_a_loser_genuine_invalid', aLoss.length === 1 && aLoss[0].value == null);
    ok('phase_a_race_one_row_consumed',
      (await withSeedClient((c) => countConsumed(c, aHash))) === 1);
    ok('phase_a_no_preliminary_select',
      aRace.outcomes.every((o) => o && o.stats && o.stats.select === 0));
    const aReplay = await withSeedClient(async (client) => {
      const repo = createPostgresOAuthTransactionRepository(client);
      return repo.consume({
        stateHash: aHash, clientId: IDS.client, authSessionId: IDS.session, now,
      });
    });
    ok('phase_a_replay_after_winner_invalid', aReplay == null);

    // --- Phase B concurrent consume ---
    const bHash = crypto.randomBytes(32);
    await withSeedClient((c) => insertOauthTxn(c, {
      stateHash: bHash, intent: 'phase_b_reauthorization', priorGen: 3,
    }));
    const bNow = new Date(Date.now() + 2_000);
    const bPredicateCount = await withSeedClient(async (c) => {
      const r = await c.query(
        `SELECT count(*)::int AS n FROM tenant_email_oauth_transactions
          WHERE state_hash=$1::bytea AND client_id=$2::uuid AND auth_session_id=$3::uuid
            AND consumed_at IS NULL AND expires_at>$4
            AND authorization_intent='phase_b_reauthorization'
            AND scope_version='phase_b_v1'
            AND prior_grant_generation IS NOT NULL AND prior_grant_generation >= 1`,
        [bHash, IDS.client, IDS.session, bNow],
      );
      return r.rows[0].n;
    });
    if (bPredicateCount !== 1) throw localFail('phase_b_seed_predicate_mismatch');
    await withSeedClient(async (c) => {
      await c.query('BEGIN');
      try {
        const probe = createPostgresPhaseBOauthTransactionConsumer(c);
        const row = await probe.consume({
          stateHash: bHash, clientId: IDS.client, authSessionId: IDS.session, now: bNow,
        });
        if (!row) throw localFail('phase_b_direct_probe_null');
      } catch (e) {
        if (localCode(e)) throw e;
        const codeDesc = e && Object.getOwnPropertyDescriptor(e, 'code');
        const pgCode = codeDesc && typeof codeDesc.value === 'string' ? codeDesc.value : '';
        const constraintDesc = e && Object.getOwnPropertyDescriptor(e, 'constraint');
        const constraintName = constraintDesc && typeof constraintDesc.value === 'string'
          ? constraintDesc.value : '';
        const knownConstraint = constraintName === 'tenant_email_oauth_transactions_consumed_time_valid'
          ? 'consumed_time'
          : (constraintName === 'tenant_email_oauth_transactions_intent_scope_coupling'
            ? 'intent_scope' : 'constraint');
        const safeClass = /^23/.test(pgCode) ? knownConstraint
          : (pgCode === '42703' ? 'undefined_column'
            : (pgCode === '42883' ? 'undefined_operator'
              : (pgCode === '42P01' ? 'undefined_table' : 'database_error')));
        throw localFail(`phase_b_direct_probe_${safeClass}`);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const bRace = await runBlockedPair({
      ...pairBase,
      lockSql: oauthLockSql, lockParams: [bHash],
      label: 'phase_b',
      classifyFn: (value, err, stats) => classifyConsumeResult(value, err, stats),
      workerFn: async (client) => {
        const repo = createPostgresPhaseBOauthTransactionConsumer(client);
        return repo.consume({
          stateHash: bHash, clientId: IDS.client, authSessionId: IDS.session, now: bNow,
        });
      },
    });
    const bWins = bRace.outcomes.filter((o) => o && o.kind === 'accepted');
    const bLoss = bRace.outcomes.filter((o) => o && o.kind === 'invalid');
    ok('phase_b_blocking_pids_exact',
      !!(bRace.overlap && bRace.overlap.ok
        && bRace.overlap.evidence.every((e) => e.blocker_path.includes(bRace.blockerPid))));
    ok('phase_b_worker_identity_verified',
      bRace.workerIdentities.every((w) => appNameHasRunToken(w.application_name, runToken)
        && w.datname === expectedDatabase));
    ok('phase_b_race_exactly_one_winner', bWins.length === 1 && bLoss.length === 1);
    ok('phase_b_loser_genuine_invalid', bLoss.length === 1 && bLoss[0].value == null);
    ok('phase_b_race_prior_generation_canonical',
      bWins[0] && bWins[0].value
      && String(bWins[0].value.prior_grant_generation) === '3'
      && bWins[0].value.authorization_intent === 'phase_b_reauthorization');
    ok('phase_b_race_one_row_consumed',
      (await withSeedClient((c) => countConsumed(c, bHash))) === 1);
    ok('phase_b_no_preliminary_select',
      bRace.outcomes.every((o) => o && o.stats && o.stats.select === 0));
    const bReplay = await withSeedClient(async (client) => {
      const repo = createPostgresPhaseBOauthTransactionConsumer(client);
      return repo.consume({
        stateHash: bHash, clientId: IDS.client, authSessionId: IDS.session, now: bNow,
      });
    });
    ok('phase_b_replay_after_winner_invalid', bReplay == null);

    // --- Cross-intent Phase A row ---
    const xA = crypto.randomBytes(32);
    await withSeedClient((c) => insertOauthTxn(c, { stateHash: xA, intent: 'initial_connect' }));
    const preXA = await withSeedClient((c) => snapshotOauthTxnFullRow(c, xA));
    const crossA = await runCrossIntentSameRow({
      ...pairBase, stateHash: xA, matchingKind: 'phase_a', preLaunchRowFixture: preXA,
    });
    ok('cross_intent_phase_a_match_blocked_by_blocker',
      !!(crossA.matchBlockedEvidence
        && crossA.matchBlockedEvidence.blocker_path.includes(crossA.blockerPid)));
    ok('cross_intent_phase_a_wrong_invalid_before_release',
      crossA.wrongFinishedWhileMatchBlocked && crossA.wrongOutcome == null);
    ok('cross_intent_phase_a_wrong_full_row_identical_while_match_blocked',
      crossA.fullRowIdenticalWhileMatchBlocked === true
      && fullRowsByteIdentical(crossA.preLaunchRowFixture, crossA.midBlockedRow));
    // After release matching accepted.
    ok('cross_intent_phase_a_match_accepted_after_release',
      crossA.matchOutcome != null
      && (await withSeedClient((c) => countConsumed(c, xA))) === 1);

    // --- Cross-intent Phase B row ---
    const xB = crypto.randomBytes(32);
    await withSeedClient((c) => insertOauthTxn(c, {
      stateHash: xB, intent: 'phase_b_reauthorization', priorGen: 5,
    }));
    const preXB = await withSeedClient((c) => snapshotOauthTxnFullRow(c, xB));
    const crossB = await runCrossIntentSameRow({
      ...pairBase, stateHash: xB, matchingKind: 'phase_b', preLaunchRowFixture: preXB,
    });
    ok('cross_intent_phase_b_match_blocked_by_blocker',
      !!(crossB.matchBlockedEvidence
        && crossB.matchBlockedEvidence.blocker_path.includes(crossB.blockerPid)));
    ok('cross_intent_phase_b_wrong_invalid_before_release',
      crossB.wrongFinishedWhileMatchBlocked && crossB.wrongOutcome == null);
    ok('cross_intent_phase_b_wrong_full_row_identical_while_match_blocked',
      crossB.fullRowIdenticalWhileMatchBlocked === true
      && fullRowsByteIdentical(crossB.preLaunchRowFixture, crossB.midBlockedRow));
    ok('cross_intent_phase_b_match_accepted_after_release',
      crossB.matchOutcome != null
      && (await withSeedClient((c) => countConsumed(c, xB))) === 1);

    // --- Concurrent Phase B grant CAS ---
    await withSeedClient((c) => seedGrant(c, 3, 'phase_a_v2', IDS.opA));
    const env4 = await makeEnvelope(IDS.opB, '4', 'rt-new-cas-normal');
    const env4b = await makeEnvelope(IDS.opC, '4', 'rt-new-cas-other');
    const envelopesNormal = [env4, env4b];
    const opIdsNormal = [IDS.opB, IDS.opC];
    const casRace = await runBlockedPair({
      ...pairBase,
      lockSql: SQL_LOCK, lockParams: [IDS.client, IDS.endpoint],
      label: 'grant_cas',
      classifyFn: (value, err, stats) => classifyCasResult(
        value, err, stats, REPLACED_STATUS, REPLACER_ERROR_CODE,
      ),
      workerFn: async (client, idx) => {
        const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(
          Object.freeze({ client }),
        );
        return replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: opIdsNormal[idx],
          actorStaffUserId: null,
          expectedPriorGrantGeneration: '3',
          identity: identity(),
          envelope: envelopesNormal[idx],
        }));
      },
    });
    const casWins = casRace.outcomes.filter((o) => o && o.kind === 'accepted');
    const casStale = casRace.outcomes.filter((o) => o && o.kind === 'stale');
    ok('grant_cas_blocking_pids_exact',
      !!(casRace.overlap && casRace.overlap.ok
        && casRace.overlap.evidence.every((e) => e.blocker_path.includes(casRace.blockerPid))));
    ok('grant_cas_race_exactly_one_winner', casWins.length === 1 && casStale.length === 1);
    ok('grant_cas_loser_production_stale',
      casStale.length === 1 && casStale[0].errorCode === REPLACER_ERROR_CODE);
    const gAfter = await withSeedClient(readGrantGen);
    ok('grant_cas_single_advanced_generation',
      gAfter && gAfter.g === '4' && gAfter.scope_version === 'phase_b_v1'
      && (gAfter.op === IDS.opB || gAfter.op === IDS.opC));

    // --- Huge boundary CAS ---
    await withSeedClient((c) => seedGrant(c, HUGE_N, 'phase_a_v2', IDS.opA));
    const envHuge1 = await makeEnvelope(IDS.opB, HUGE_N1, 'rt-huge-a');
    const envHuge2 = await makeEnvelope(IDS.opC, HUGE_N1, 'rt-huge-b');
    ok('huge_boundary_canon_no_number_coercion',
      asCanonGen(HUGE_N) === HUGE_N && genPlus1(HUGE_N) === HUGE_N1
      && HUGE_N1 !== HUGE_N
      && Number(HUGE_N1) === Number(HUGE_N)
      && String(Number(HUGE_N1)) !== HUGE_N1);
    const hugeEnvs = [envHuge1, envHuge2];
    const hugeOps = [IDS.opB, IDS.opC];
    const hugeRace = await runBlockedPair({
      ...pairBase,
      lockSql: SQL_LOCK, lockParams: [IDS.client, IDS.endpoint],
      label: 'grant_cas_huge',
      classifyFn: (value, err, stats) => classifyCasResult(
        value, err, stats, REPLACED_STATUS, REPLACER_ERROR_CODE,
      ),
      workerFn: async (client, idx) => {
        const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(
          Object.freeze({ client }),
        );
        return replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: hugeOps[idx],
          actorStaffUserId: null,
          expectedPriorGrantGeneration: HUGE_N,
          identity: identity(),
          envelope: hugeEnvs[idx],
        }));
      },
    });
    const hugeWins = hugeRace.outcomes.filter((o) => o && o.kind === 'accepted');
    const hugeStale = hugeRace.outcomes.filter((o) => o && o.kind === 'stale');
    ok('grant_cas_huge_blocking_pids_exact',
      !!(hugeRace.overlap && hugeRace.overlap.ok
        && hugeRace.overlap.evidence.every((e) => e.blocker_path.includes(hugeRace.blockerPid))));
    ok('grant_cas_huge_boundary_one_winner',
      hugeWins.length === 1 && hugeWins[0].value.grantGeneration === HUGE_N1
      && hugeStale.length === 1);
    ok('grant_cas_huge_loser_production_stale',
      hugeStale.length === 1 && hugeStale[0].errorCode === REPLACER_ERROR_CODE);
    const gHuge = await withSeedClient(readGrantGen);
    ok('grant_cas_huge_stored_exact_decimal',
      gHuge && gHuge.g === HUGE_N1 && gHuge.g !== HUGE_N
      && gHuge.g !== String(Number(HUGE_N1)));

    // --- Max BIGINT CAS ---
    await withSeedClient((c) => seedGrant(c, GEN_MAX_MINUS_1, 'phase_a_v2', IDS.opA));
    const envMax1 = await makeEnvelope(IDS.opB, GEN_MAX_STR, 'rt-max-a');
    const envMax2 = await makeEnvelope(IDS.opC, GEN_MAX_STR, 'rt-max-b');
    const maxEnvs = [envMax1, envMax2];
    const maxOps = [IDS.opB, IDS.opC];
    const maxRace = await runBlockedPair({
      ...pairBase,
      lockSql: SQL_LOCK, lockParams: [IDS.client, IDS.endpoint],
      label: 'grant_cas_max',
      classifyFn: (value, err, stats) => classifyCasResult(
        value, err, stats, REPLACED_STATUS, REPLACER_ERROR_CODE,
      ),
      workerFn: async (client, idx) => {
        const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(
          Object.freeze({ client }),
        );
        return replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: maxOps[idx],
          actorStaffUserId: null,
          expectedPriorGrantGeneration: GEN_MAX_MINUS_1,
          identity: identity(),
          envelope: maxEnvs[idx],
        }));
      },
    });
    const maxWins = maxRace.outcomes.filter((o) => o && o.kind === 'accepted');
    const maxStale = maxRace.outcomes.filter((o) => o && o.kind === 'stale');
    ok('grant_cas_max_blocking_pids_exact',
      !!(maxRace.overlap && maxRace.overlap.ok
        && maxRace.overlap.evidence.every((e) => e.blocker_path.includes(maxRace.blockerPid))));
    ok('grant_cas_max_bigint_one_winner',
      maxWins.length === 1 && maxWins[0].value.grantGeneration === GEN_MAX_STR
      && maxStale.length === 1);
    ok('grant_cas_max_loser_production_stale',
      maxStale.length === 1 && maxStale[0].errorCode === REPLACER_ERROR_CODE);
    const gMax = await withSeedClient(readGrantGen);
    ok('grant_cas_max_bigint_stored_exact', gMax && gMax.g === GEN_MAX_STR);

    // --- Production reconcileReplacement at high BIGINT ---
    const reconPrior = HUGE_N;
    const reconNext = HUGE_N1;
    await withSeedClient((c) => seedGrant(c, reconPrior, 'phase_a_v2', IDS.opA));
    await withSeedClient(async (client) => {
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
      const snap = await replacer.reconcileReplacement(Object.freeze({
        clientId: IDS.client,
        endpointId: IDS.endpoint,
        operationId: IDS.opB,
        expectedPriorGrantGeneration: reconPrior,
      }));
      ok('reconcile_still_prior_high_bigint',
        snap && snap.stillPrior === true && snap.advanced === false
        && snap.grantGeneration === reconPrior
        && snap.scopeVersion === 'phase_a_v2');
    });
    const envRecon = await makeEnvelope(IDS.opB, reconNext, 'rt-recon-adv');
    await withSeedClient(async (client) => {
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
      const ack = await replacer.replaceVerifiedGrant(Object.freeze({
        clientId: IDS.client,
        endpointId: IDS.endpoint,
        operationId: IDS.opB,
        actorStaffUserId: null,
        expectedPriorGrantGeneration: reconPrior,
        identity: identity(),
        envelope: envRecon,
      }));
      ok('reconcile_pre_advanced_replace_ok',
        ack && ack.status === REPLACED_STATUS && ack.grantGeneration === reconNext);
    });
    await withSeedClient(async (client) => {
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client }));
      const snap = await replacer.reconcileReplacement(Object.freeze({
        clientId: IDS.client,
        endpointId: IDS.endpoint,
        operationId: IDS.opB,
        expectedPriorGrantGeneration: reconPrior,
      }));
      ok('reconcile_advanced_high_bigint',
        snap && snap.advanced === true && snap.stillPrior === false
        && snap.grantGeneration === reconNext
        && snap.lastOperationId === IDS.opB
        && snap.scopeVersion === 'phase_b_v1');
    });

    // Pre-COMMIT failure/rollback → stillPrior via production reconcileReplacement
    await withSeedClient((c) => seedGrant(c, '40', 'phase_a_v2', IDS.opA));
    const env41 = await makeEnvelope(IDS.opB, '41', 'rt-recon-fail');
    await withSeedClient(async (raw) => {
      const orig = raw.query.bind(raw);
      raw.query = async function wrapped(config, values, cb) {
        const text = typeof config === 'string' ? config
          : (config && config.text) || '';
        const result = await orig(config, values, cb);
        if (/UPDATE\s+tenant_email_delegated_grants/i.test(String(text))
            && /RETURNING/i.test(String(text))) {
          throw localFail('forced_mid_tx_failure');
        }
        return result;
      };
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: raw }));
      let failed = false;
      try {
        await replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: IDS.opB,
          actorStaffUserId: null,
          expectedPriorGrantGeneration: '40',
          identity: identity(),
          envelope: env41,
        }));
      } catch {
        failed = true;
      }
      raw.query = orig;
      const recon = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: raw }));
      const snap = await recon.reconcileReplacement(Object.freeze({
        clientId: IDS.client,
        endpointId: IDS.endpoint,
        operationId: IDS.opB,
        expectedPriorGrantGeneration: '40',
      }));
      ok('reconcile_after_precommit_failure_still_prior',
        failed
        && snap && snap.stillPrior === true && snap.advanced === false
        && snap.grantGeneration === '40'
        && snap.scopeVersion === 'phase_a_v2');
    });

    // Genuine post-COMMIT acknowledgement-loss: real COMMIT reaches PG and completes,
    // then throw fixed synthetic ack-loss. No rollback after known server commit.
    // Production maps commit-ack loss to outcome_unknown; reconcile requires advanced.
    await withSeedClient((c) => seedGrant(c, '50', 'phase_a_v2', IDS.opA));
    const env51 = await makeEnvelope(IDS.opB, '51', 'rt-recon-ack-loss');
    await withSeedClient(async (raw) => {
      const orig = raw.query.bind(raw);
      raw.query = async function wrapped(config, values, cb) {
        const text = typeof config === 'string' ? config
          : (config && config.text) || '';
        const norm = String(text).replace(/\s+/g, ' ').trim();
        if (norm === 'COMMIT') {
          // Actual COMMIT reaches PostgreSQL and completes first.
          const result = await orig(config, values, cb);
          // Fixed synthetic acknowledgement-loss after server commit.
          throw localFail('synthetic_commit_ack_loss');
        }
        return orig(config, values, cb);
      };
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: raw }));
      let outcome = null;
      try {
        outcome = await replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: IDS.opB,
          actorStaffUserId: null,
          expectedPriorGrantGeneration: '50',
          identity: identity(),
          envelope: env51,
        }));
      } catch {
        // Production should map post-commit failure to outcome_unknown (return, not throw).
        outcome = null;
      }
      raw.query = orig;
      // Do not issue ROLLBACK after known server commit.
      const recon = createMicrosoftPhaseBVerifiedGrantReplacer(Object.freeze({ client: raw }));
      const snap = await recon.reconcileReplacement(Object.freeze({
        clientId: IDS.client,
        endpointId: IDS.endpoint,
        operationId: IDS.opB,
        expectedPriorGrantGeneration: '50',
      }));
      ok('reconcile_after_postcommit_ack_loss_outcome_unknown',
        outcome
        && outcome.status === OUTCOME_UNKNOWN
        && Object.isFrozen(outcome)
        && Object.keys(outcome).length === 1);
      ok('reconcile_after_postcommit_ack_loss_advanced',
        snap && snap.advanced === true && snap.stillPrior === false
        && snap.grantGeneration === '51'
        && snap.lastOperationId === IDS.opB
        && snap.scopeVersion === 'phase_b_v1');
    });

    // Real release-settlement evidence from production consume/CAS races (not lock_timeout probe).
    // After both blocked: release + independently await both still-pending promises with deadline.
    const settleAfterReleaseOk = !!(
      aRace.settleAfterRelease
      && bRace.settleAfterRelease
      && casRace.settleAfterRelease
      && aWins.length === 1 && aLoss.length === 1
      && bWins.length === 1 && bLoss.length === 1
      && casWins.length === 1 && casStale.length === 1
    );

    // --- Lock wait bounded only (does NOT count as release-settle evidence) ---
    await withSeedClient((c) => seedGrant(c, 10, 'phase_a_v2', IDS.opA));
    let lockTimeoutHit = false;
    const lockHolder = await openTrackedClient({
      Client, parsedUrl, runToken, role: ROLE.blocker, schema,
      timeouts: { statement: STATEMENT_MS, lock: LOCK_MS },
      registry, expectedDatabase, stagingTarget, pinnedIdentity,
    });
    try {
      await lockHolder.client.query('BEGIN');
      await lockHolder.client.query(SQL_LOCK, [IDS.client, IDS.endpoint]);
      const contender = await openTrackedClient({
        Client, parsedUrl, runToken, role: ROLE.worker1, schema,
        timeouts: { statement: STATEMENT_MS, lock: LOCK_MS },
        registry, expectedDatabase, stagingTarget, pinnedIdentity,
      });
      try {
        const t0 = Date.now();
        await contender.client.query('BEGIN');
        let contenderFailed = false;
        try {
          await contender.client.query(SQL_LOCK, [IDS.client, IDS.endpoint]);
          await contender.client.query('ROLLBACK');
        } catch {
          contenderFailed = true;
          try { await contender.client.query('ROLLBACK'); } catch { /* ignore */ }
        }
        const elapsed = Date.now() - t0;
        // Probe asserts only bounded lock timeout — not release-settle evidence.
        lockTimeoutHit = contenderFailed && elapsed < LOCK_MS + 2_000 && elapsed >= 0;
        await lockHolder.client.query('ROLLBACK');
      } finally {
        await safeEndClient(contender.client);
      }
    } finally {
      try { await lockHolder.client.query('ROLLBACK'); } catch { /* may already be closed */ }
      await safeEndClient(lockHolder.client);
    }
    ok('lock_wait_bounded_timeout', lockTimeoutHit);
    ok('workers_settle_after_blocker_release', settleAfterReleaseOk);

    // Query ALL exact run-token backends in the expected database (not selected PIDs).
    // Exclude only this observer's exact control identity — never broad role names.
    let noRunWaitersAfterSettle = false;
    const settleObs = await openTrackedClient({
      Client, parsedUrl, runToken, role: ROLE.observer, schema,
      timeouts: { statement: STATEMENT_MS, lock: LOCK_MS },
      registry, expectedDatabase, stagingTarget, pinnedIdentity,
    });
    try {
      const controlId = {
        pid: settleObs.identity.pid,
        application_name: settleObs.identity.application_name,
        backend_start: settleObs.identity.backend_start,
        datname: settleObs.identity.datname,
        datid: settleObs.identity.datid,
      };
      noRunWaitersAfterSettle = await assertNoRunTokenBackendsWaitingActive(
        settleObs.client, runToken, expectedDatabase, controlId,
      ) && settleAfterReleaseOk;
    } finally {
      await safeEndClient(settleObs.client);
    }
    ok(
      'no_expected_database_run_token_backends_active_or_waiting_after_settle',
      noRunWaitersAfterSettle,
    );

    // --- Isolation visibility ---
    await withSeedClient((c) => seedGrant(c, 20, 'phase_a_v2', IDS.opA));
    const isoHolder = await openTrackedClient({
      Client, parsedUrl, runToken, role: ROLE.blocker, schema,
      timeouts: { statement: STATEMENT_MS, lock: LOCK_MS },
      registry, expectedDatabase, stagingTarget, pinnedIdentity,
    });
    try {
      await isoHolder.client.query('BEGIN');
      await isoHolder.client.query(
        `UPDATE tenant_email_delegated_grants
            SET grant_generation = 21, scope_version = 'phase_b_v1'
          WHERE client_id = $1 AND endpoint_id = $2 AND grant_generation = 20`,
        [IDS.client, IDS.endpoint],
      );
      const outsider = await withSeedClient(readGrantGen);
      ok('isolation_uncommitted_cas_not_visible',
        outsider && outsider.g === '20' && outsider.scope_version === 'phase_a_v2');
      await isoHolder.client.query('ROLLBACK');
      const afterRb = await withSeedClient(readGrantGen);
      ok('isolation_rollback_restores_prior',
        afterRb && afterRb.g === '20' && afterRb.scope_version === 'phase_a_v2');
    } finally {
      try { await isoHolder.client.query('ROLLBACK'); } catch { /* ignore */ }
      await safeEndClient(isoHolder.client);
    }

    // --- Production replacer rollback: throw after UPDATE before COMMIT ---
    await withSeedClient((c) => seedGrant(c, 30, 'phase_a_v2', IDS.opA));
    const env31 = await makeEnvelope(IDS.opB, '31', 'rt-rollback-proof');
    await withSeedClient(async (raw) => {
      let updateSeen = false;
      const orig = raw.query.bind(raw);
      raw.query = async function wrapped(config, values, cb) {
        const text = typeof config === 'string' ? config
          : (config && config.text) || '';
        const result = await orig(config, values, cb);
        if (/UPDATE\s+tenant_email_delegated_grants/i.test(String(text))
            && /RETURNING/i.test(String(text))) {
          updateSeen = true;
          throw localFail('forced_mid_tx_failure');
        }
        return result;
      };
      const replacer = createMicrosoftPhaseBVerifiedGrantReplacer(
        Object.freeze({ client: raw }),
      );
      let failed = false;
      try {
        await replacer.replaceVerifiedGrant(Object.freeze({
          clientId: IDS.client,
          endpointId: IDS.endpoint,
          operationId: IDS.opB,
          actorStaffUserId: null,
          expectedPriorGrantGeneration: '30',
          identity: identity(),
          envelope: env31,
        }));
      } catch {
        failed = true;
      }
      raw.query = orig;
      const g = await readGrantGen(raw);
      ok('replacer_mid_tx_failure_no_partial_mutation',
        failed && updateSeen
        && g && g.g === '30' && g.scope_version === 'phase_a_v2');
    });

    ok('multi_session_distinct_backends',
      new Set(registry.list().map((r) => r.pid)).size >= 4);

    const proofSrc = fs.readFileSync(__filename, 'utf8');
    const staticClean = !/require\(['"]@azure\//.test(proofSrc)
      && !/graph\.microsoft\.com/.test(proofSrc)
      && !/login\.microsoftonline\.com/.test(proofSrc)
      && !/CREATE\s+EXTENSION/i.test(proofSrc)
      && !/@azure\/identity/.test(proofSrc)
      && !/@azure\/keyvault/.test(proofSrc);
    ok('no_provider_azure_http_graph_static', staticClean);
    ok('no_provider_seal_only_local_envelope',
      providerCounters.seal >= 1
      && providerCounters.open === 0
      && providerCounters.rewrap === 0);
    ok('no_provider_network_tripwire_zero',
      networkTouch.http === 0
      && networkTouch.https === 0
      && networkTouch.fetch === 0
      && networkTouch.rejected === 0);
    ok('provider_no_other_methods_invoked',
      providerCounters.open === 0 && providerCounters.rewrap === 0 && providerCounters.other === 0);
    ok('require_cache_production_after_traps', trapsInstalled === true);
    ok('reviewer_workspace_path_documented',
      proofSrc.includes(REVIEWER_WORKSPACE)
      && path.resolve(ROOT) === path.resolve(REVIEWER_WORKSPACE));
  } catch (e) {
    proofError = e;
  } finally {
    clearTimeout(overallTimer);
    if (cancelPoll) clearInterval(cancelPoll);
    // Worker-local cleanup is best-effort hygiene; supervisor owns final PASS cleanup evidence.
    try {
      await cleanupBounded();
    } catch {
      // Surface via cleanupCode path below if needed; worker still emits evidence only when
      // all worker checks already passed before cleanup.
    }
  }

  if (proofError) {
    const fixed = localCode(proofError);
    throw localFail(fixed || `proof_error_after_${passed.length}_checks`);
  }

  if (passed.length !== WORKER_CHECK_NAMES.length || failCount !== 0) {
    throw localFail('check_count_mismatch');
  }
  if (cleanupCode != null) {
    // Worker-local cleanup failure is terminal (cannot hand ambiguous state to supervisor).
    throw localFail(cleanupCode);
  }
  const evidence = buildWorkerEvidence(passed);
  if (!evidence) throw localFail('worker_evidence_build_failed');
  // Worker emits structured evidence only — never a final PASS transcript.
  // Supervisor constructs the exact PASS after verified cleanup.
  process.stdout.write(`WORKER_EVIDENCE ${JSON.stringify(evidence)}\n`);
  return { pass: passed.length, evidence };
}

// ---------------------------------------------------------------------------
// Supervisor / entrypoints
// ---------------------------------------------------------------------------

function scrubWorkerEnv(env, extra) {
  const out = { ...env, ...extra };
  // Ensure empty stderr on PASS: no color / warning noise from Node.
  out.NODE_NO_WARNINGS = '1';
  out.FORCE_COLOR = '0';
  out.NO_COLOR = '1';
  if (typeof out.NODE_OPTIONS === 'string' && out.NODE_OPTIONS.trim()) {
    out.NODE_OPTIONS = `${out.NODE_OPTIONS} --no-warnings`;
  } else {
    out.NODE_OPTIONS = '--no-warnings';
  }
  // Strip generic PG consent noise from worker.
  out.DATABASE_URL = '';
  out.PGHOST = '';
  out.WH_DISPOSABLE_PG = '';
  return out;
}

/**
 * Bounded stdout/stderr capture for async child (no sync-spawn hard timeout).
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string, exited: boolean, timedOut: boolean, exitUnverified: boolean}>}
 */
function spawnSupervisedWorker(args, opts) {
  const {
    cwd, env, timeoutMs, cancelPath,
    maxStdout = MAX_CHILD_STDOUT,
    maxStderr = MAX_CHILD_STDERR,
    cooperativeMs = COOPERATIVE_CANCEL_MS,
    termMs = SIGTERM_WAIT_MS,
    killMs = SIGKILL_WAIT_MS,
  } = opts;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let exitUnverified = false;
    let status = null;
    let signal = null;
    let exited = false;
    /** @type {import('child_process').ChildProcessWithoutNullStreams} */
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    function finish() {
      if (settled) return;
      settled = true;
      resolve({
        status,
        signal,
        stdout,
        stderr,
        exited,
        timedOut,
        exitUnverified,
      });
    }

    child.stdout.on('data', (buf) => {
      if (stdout.length >= maxStdout) return;
      stdout += buf.toString('utf8', 0, maxStdout - stdout.length);
    });
    child.stderr.on('data', (buf) => {
      if (stderr.length >= maxStderr) return;
      stderr += buf.toString('utf8', 0, maxStderr - stderr.length);
    });

    child.on('error', () => {
      exitUnverified = true;
      exited = false;
      finish();
    });

    child.on('exit', (code, sig) => {
      exited = true;
      status = code;
      signal = sig;
      finish();
    });

    const waitExit = (ms) => new Promise((res) => {
      if (exited) {
        res(true);
        return;
      }
      const t = setTimeout(() => res(exited), ms);
      child.once('exit', () => {
        clearTimeout(t);
        res(true);
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      (async () => {
        // 1) Cooperative cancel signal (file) + bounded wait.
        if (cancelPath) {
          try {
            fs.writeFileSync(cancelPath, '1', { encoding: 'utf8', mode: 0o600 });
          } catch { /* still escalate */ }
        }
        if (await waitExit(cooperativeMs)) return;
        // 2) SIGTERM + bounded wait.
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        if (await waitExit(termMs)) return;
        // 3) SIGKILL last resort.
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        if (await waitExit(killMs)) return;
        // Process did not exit — termination uncertainty.
        exitUnverified = true;
        finish();
      })().catch(() => {
        exitUnverified = true;
        finish();
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // Clear timeout when child exits early.
    child.once('exit', () => {
      clearTimeout(timer);
    });
  });
}

async function runSupervisor(env) {
  let parsedUrl;
  let stagingTarget;
  let pinnedIdentity;
  let runToken;
  let schema;
  // Bootstrap must succeed before any registry write / worker spawn / schema creation.
  // Failures here create no registry artifacts and emit fixed codes only (no host/addr logs).
  try {
    parsedUrl = parseDedicatedStockPgUrl(env[URL_ENV]);
    stagingTarget = resolveStagingTargetIdentity(env, parsedUrl);
    runToken = makeRunToken();
    schema = makeSchemaName();
    // Traps before pg import so nested net + existing-socket TLS wrap is preserved.
    installExternalTrafficTraps(parsedUrl);
    // eslint-disable-next-line global-require
    const pg = require('pg');
    pinnedIdentity = await bootstrapAuthenticatedServerPin({
      Client: pg.Client,
      parsedUrl,
      stagingTarget,
      runToken,
    });
  } catch (e) {
    const code = localCode(e) || 'url_invalid';
    process.stdout.write(`FAIL  stock_pg_proof — ${code}\n`);
    process.exitCode = 1;
    return;
  }

  const tmpDir = require('os').tmpdir();
  const registryPath = path.join(tmpDir, `pb_stock_reg_${runToken}.json`);
  const cancelPath = path.join(tmpDir, `pb_stock_cancel_${runToken}`);

  try {
    writeInitialEmptyRegistry(registryPath, runToken, schema);
  } catch (e) {
    const code = localCode(e) || 'registry_write_failed';
    process.stdout.write(`FAIL  stock_pg_proof — ${code}\n`);
    process.exitCode = 1;
    return;
  }

  const workerEnv = scrubWorkerEnv(env, {
    [WORKER_ENV]: '1',
    [RUN_TOKEN_ENV]: runToken,
    [SCHEMA_ENV]: schema,
    [REGISTRY_ENV]: registryPath,
    [CANCEL_ENV]: cancelPath,
    // Pass-through exact staging target envs (already validated).
    [TARGET_ENV]: env[TARGET_ENV],
    [EXPECTED_DATABASE_ENV]: env[EXPECTED_DATABASE_ENV],
    [EXPECTED_HOST_ENV]: env[EXPECTED_HOST_ENV],
    // Immutable authenticated bootstrap pin — worker/cleanup must not re-resolve for membership.
    [PINNED_SERVER_IDENTITY_ENV]: serializePinnedServerIdentity(pinnedIdentity),
    [PINNED_ADDRS_ENV]: serializePinnedAddressSet(
      freezePinnedAddressSet([pinnedIdentity.server_addr]),
    ),
  });

  const child = await spawnSupervisedWorker([__filename], {
    cwd: ROOT,
    env: workerEnv,
    timeoutMs: WORKER_TIMEOUT_MS,
    cancelPath,
  });

  // Worker-exit unverified: fixed cleanup_unverified, preserve registry + cancel file,
  // no mutation, print recovery artifact IDs only (no secrets).
  if (!child.exited || child.exitUnverified) {
    const disp = decideCleanupArtifactDisposition({ workerExitUnverified: true });
    process.stdout.write('FAIL  stock_pg_proof — cleanup_unverified\n');
    process.stdout.write(`${formatRecoveryArtifactLine(registryPath, cancelPath)}\n`);
    process.exitCode = 1;
    // Explicitly do not delete registry/cancel when preserve=true.
    if (disp.preserve !== true || disp.deleteArtifacts === true || disp.mutate === true) {
      process.exitCode = 1;
    }
    return;
  }

  // Always perform identity-bound supervisor cleanup after worker exit, then construct PASS
  // only when worker evidence is valid AND cleanup is supervisor-verified.
  // Never delete registry/cancel until cleanup is settled AND schema absence + zero token
  // backends are verified. Unverified → preserve artifacts for operator recovery.
  let cleanupCode = null;
  let cleanupEvidence = null;
  try {
    const loaded = loadRegistryForCleanup(registryPath, runToken, schema, 0);
    if (!loaded.ok) {
      cleanupCode = 'cleanup_unverified';
    } else {
      installExternalTrafficTraps(parsedUrl);
      // eslint-disable-next-line global-require
      const pg = require('pg');
      try {
        // Cooperative outer timeout: aborts exact cleanup client then awaits settlement.
        cleanupEvidence = await supervisorCleanupWithOuterTimeout({
          Client: pg.Client,
          parsedUrl,
          runToken,
          schema,
          stagingTarget,
          pinnedIdentity,
          registered: loaded.entries,
          registry: null,
        }, SUPERVISOR_CLEANUP_MS);
      } catch (e) {
        const code = localCode(e) || 'cleanup_failed';
        if (isCleanupUnverified(code) || code === 'cleanup_child_timeout') {
          cleanupCode = 'cleanup_unverified';
        } else {
          cleanupCode = code === 'cleanup_failed' ? 'cleanup_failed' : code;
        }
      }
    }
  } catch {
    cleanupCode = 'cleanup_unverified';
  }

  const verified = !cleanupCode
    && cleanupEvidence
    && cleanupEvidence.zeroTokenBackends === true
    && cleanupEvidence.schemaAbsent === true;
  const disposition = decideCleanupArtifactDisposition({
    workerExitUnverified: false,
    cleanupVerified: verified === true,
    schemaAbsent: !!(cleanupEvidence && cleanupEvidence.schemaAbsent),
    zeroTokenBackends: !!(cleanupEvidence && cleanupEvidence.zeroTokenBackends),
    cleanupCode: cleanupCode || null,
  });

  if (!disposition.deleteArtifacts) {
    // Preserve registry/cancel metadata for operator recovery (no secrets in output).
    process.stdout.write(
      `FAIL  stock_pg_proof — ${cleanupCode || disposition.code || 'cleanup_unverified'}\n`,
    );
    process.stdout.write(`${formatRecoveryArtifactLine(registryPath, cancelPath)}\n`);
    process.exitCode = 1;
    return;
  }

  // Successful verified cleanup only: delete registry/cancel/temp metadata.
  // Deletion failure is terminal (must not PASS with residual recovery artifacts).
  try {
    fs.unlinkSync(registryPath);
  } catch {
    process.stdout.write('FAIL  stock_pg_proof — cleanup_metadata_delete_failed\n');
    process.stdout.write(`${formatRecoveryArtifactLine(registryPath, cancelPath)}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    if (fs.existsSync(cancelPath)) fs.unlinkSync(cancelPath);
  } catch {
    process.stdout.write('FAIL  stock_pg_proof — cleanup_metadata_delete_failed\n');
    process.stdout.write(`${formatRecoveryArtifactLine(registryPath, cancelPath)}\n`);
    process.exitCode = 1;
    return;
  }

  if (child.timedOut) {
    process.stdout.write('FAIL  stock_pg_proof — worker_timeout\n');
    process.exitCode = 1;
    return;
  }
  if (child.status !== 0 || (child.stderr && String(child.stderr).length > 0)) {
    const fixedWorkerFailure = /^FAIL  stock_pg_proof — ([a-z0-9_;]+)\n$/.exec(String(child.stdout || ''));
    const stderrText = String(child.stderr || '');
    const stderrKind = /\b(TypeError|ReferenceError|RangeError|Error):/.exec(stderrText);
    const stderrLines = [...stderrText.matchAll(/prove-email-phase-b-stock-pg-concurrency\.js:(\d+):\d+/g)];
    const stderrLine = stderrLines.length > 1 ? stderrLines[1][1]
      : (stderrLines.length === 1 ? stderrLines[0][1] : null);
    const workerCode = fixedWorkerFailure
      ? fixedWorkerFailure[1]
      : (stderrText.length > 0
        ? `stderr_${stderrKind ? stderrKind[1].toLowerCase() : 'other'}_${stderrLine || 'noline'}`
        : (child.signal ? 'signal_exit' : `status_${String(child.status)}`));
    process.stdout.write(`FAIL  stock_pg_proof — worker_failed_${workerCode}\n`);
    process.exitCode = 1;
    return;
  }

  // Worker evidence payload only — never accept a self-authored PASS from the child.
  const workerEvidence = parseWorkerEvidenceStdout(child.stdout);
  if (!workerEvidence) {
    process.stdout.write('FAIL  stock_pg_proof — worker_evidence_invalid\n');
    process.exitCode = 1;
    return;
  }
  if (!cleanupEvidence
      || cleanupEvidence.zeroTokenBackends !== true
      || cleanupEvidence.schemaAbsent !== true) {
    process.stdout.write('FAIL  stock_pg_proof — cleanup_failed\n');
    process.exitCode = 1;
    return;
  }

  // Supervisor constructs the final exact PASS transcript after verified cleanup.
  const allChecks = workerEvidence.checks.concat(SUPERVISOR_CHECK_NAMES.slice());
  const transcript = buildPassTranscript(allChecks, {
    supervisorCleanupVerified: true,
    zeroTokenBackends: true,
    schemaAbsent: true,
  });
  if (!transcript || !stockPgTranscriptPassed({
    status: 0, stdout: transcript, stderr: '', error: null,
  })) {
    process.stdout.write('FAIL  stock_pg_proof — transcript_build_failed\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(transcript);
  process.exitCode = 0;
}

async function runCleanupOnly(env) {
  const runToken = env[RUN_TOKEN_ENV];
  const schema = env[SCHEMA_ENV];
  const registryPath = env[REGISTRY_ENV];
  let parsedUrl;
  let stagingTarget;
  let pinnedIdentity;
  try {
    parsedUrl = parseDedicatedStockPgUrl(env[URL_ENV]);
    stagingTarget = resolveStagingTargetIdentity(env, parsedUrl);
    if (env[PINNED_SERVER_IDENTITY_ENV]) {
      pinnedIdentity = parsePinnedServerIdentity(env[PINNED_SERVER_IDENTITY_ENV]);
    } else {
      // Recovery path: re-bootstrap pin via authenticated TLS session (not public DNS).
      installExternalTrafficTraps(parsedUrl);
      // eslint-disable-next-line global-require
      const pgBoot = require('pg');
      pinnedIdentity = await bootstrapAuthenticatedServerPin({
        Client: pgBoot.Client,
        parsedUrl,
        stagingTarget,
        runToken: runToken || makeRunToken(),
      });
    }
  } catch (e) {
    const code = localCode(e) || 'url_invalid';
    process.stdout.write(`FAIL  ${code}\n`);
    process.exitCode = 1;
    return;
  }
  installExternalTrafficTraps(parsedUrl);
  // eslint-disable-next-line global-require
  const pg = require('pg');
  const loaded = loadRegistryForCleanup(registryPath, runToken, schema, 0);
  if (!loaded.ok) {
    process.stdout.write('FAIL  cleanup_unverified\n');
    process.exitCode = 1;
    return;
  }
  try {
    await supervisorCleanup({
      Client: pg.Client,
      parsedUrl,
      runToken,
      schema,
      stagingTarget,
      pinnedIdentity,
      registered: loaded.entries,
      registry: null,
    });
    process.stdout.write('OK  cleanup\n');
    process.exitCode = 0;
  } catch (e) {
    const code = localCode(e) || 'cleanup_failed';
    const out = isCleanupUnverified(code) ? 'cleanup_unverified' : code;
    process.stdout.write(`FAIL  ${out}\n`);
    process.exitCode = 1;
  }
}

async function main() {
  const modeInfo = resolveStockPgProofMode(process.env);
  if (modeInfo.mode === 'skip_absent') {
    process.stdout.write('REFUSE  stock_pg_proof_not_configured\n');
    process.stdout.write('prove-email-phase-b-stock-pg-concurrency: REFUSE (no dedicated env)\n');
    process.exitCode = 2;
    return;
  }
  if (modeInfo.mode === 'refuse_no_guard') {
    process.stdout.write('REFUSE  stock_pg_proof_guard_required\n');
    process.stdout.write('prove-email-phase-b-stock-pg-concurrency: REFUSE (guard not true)\n');
    process.exitCode = 2;
    return;
  }
  if (modeInfo.mode === 'refuse_generic_only') {
    process.stdout.write('REFUSE  stock_pg_proof_generic_pg_env_ignored\n');
    process.stdout.write('prove-email-phase-b-stock-pg-concurrency: REFUSE (generic PG env ignored)\n');
    process.exitCode = 2;
    return;
  }

  const workerMode = process.env[WORKER_ENV];
  if (workerMode === 'cleanup') {
    await runCleanupOnly(process.env);
    return;
  }
  if (workerMode === '1') {
    try {
      await runWorkerProof(process.env);
      process.exitCode = 0;
    } catch (e) {
      const code = localCode(e) || 'proof_error';
      // On worker failure attempt local cleanup if token/schema/registry present.
      // Never treat missing registry as empty successful list.
      try {
        if (
          process.env[RUN_TOKEN_ENV]
          && process.env[SCHEMA_ENV]
          && process.env[URL_ENV]
          && process.env[REGISTRY_ENV]
        ) {
          const parsedUrl = parseDedicatedStockPgUrl(process.env[URL_ENV]);
          const stagingTarget = resolveStagingTargetIdentity(process.env, parsedUrl);
          const loaded = loadRegistryForCleanup(
            process.env[REGISTRY_ENV],
            process.env[RUN_TOKEN_ENV],
            process.env[SCHEMA_ENV],
            0,
          );
          if (!loaded.ok) throw localFail('cleanup_unverified');
          const pinnedIdentity = parsePinnedServerIdentity(
            process.env[PINNED_SERVER_IDENTITY_ENV],
          );
          // eslint-disable-next-line global-require
          const pg = require('pg');
          await supervisorCleanup({
            Client: pg.Client,
            parsedUrl,
            runToken: process.env[RUN_TOKEN_ENV],
            schema: process.env[SCHEMA_ENV],
            stagingTarget,
            pinnedIdentity,
            registered: loaded.entries,
            registry: null,
          });
        }
      } catch (ce) {
        const ccode = localCode(ce) || 'cleanup_failed';
        const mapped = isCleanupUnverified(ccode) ? 'cleanup_unverified' : ccode;
        process.stdout.write(`FAIL  stock_pg_proof — ${code};${mapped}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`FAIL  stock_pg_proof — ${code}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Supervisor mode (no hard process.exit).
  await runSupervisor(process.env);
}

module.exports = Object.freeze({
  URL_ENV,
  GUARD_ENV,
  WORKER_ENV,
  RUN_TOKEN_ENV,
  SCHEMA_ENV,
  REGISTRY_ENV,
  CANCEL_ENV,
  TARGET_ENV,
  EXPECTED_DATABASE_ENV,
  EXPECTED_HOST_ENV,
  PINNED_ADDRS_ENV,
  PINNED_SERVER_IDENTITY_ENV,
  REQUIRED_TARGET,
  REQUIRED_DATABASE,
  AZURE_PG_HOST_SUFFIX,
  REGISTRY_DOC_SCHEMA,
  WORKER_EVIDENCE_SCHEMA,
  REQUIRED_SSLMODE,
  CONNECT_MS,
  STATEMENT_MS,
  LOCK_MS,
  OVERALL_MS,
  CLEANUP_MS,
  SETTLE_AFTER_CANCEL_MS,
  REVIEWER_WORKSPACE,
  CHECK_NAMES,
  WORKER_CHECK_NAMES,
  SUPERVISOR_CHECK_NAMES,
  EXPECTED_CHECK_COUNT,
  PASS_SCRIPT,
  PASS_JSON_SCHEMA,
  PASS_JSON_KEYS,
  resolveStockPgProofMode,
  resolveStagingTargetIdentity,
  parseDedicatedStockPgUrl,
  buildPgClientConfig,
  makeSchemaName,
  makeRunToken,
  appNameFor,
  buildPassTranscript,
  buildWorkerEvidence,
  parseWorkerEvidenceStdout,
  stockPgTranscriptPassed,
  writeRegistryAtomic,
  writeInitialEmptyRegistry,
  loadRegistryForCleanup,
  freezePinnedAddressSet,
  serializePinnedAddressSet,
  parsePinnedAddressSet,
  freezePinnedServerIdentity,
  serializePinnedServerIdentity,
  parsePinnedServerIdentity,
  assertObservedServerIdentity,
  assertTlsSessionAuthorized,
  bootstrapAuthenticatedServerPin,
  offlineAuthenticatedBootstrapPinSeam,
  canonicalizeIp,
  sanitizePublic,
  localFail,
  localCode,
  isCleanupUnverified,
  // Hostile offline unit seams (pure; no live PG).
  sameBackendIdentity,
  excludeExactControlIdentity,
  tokenBackendIsActiveOrWaiting,
  evaluateNoExpectedDatabaseRunTokenBackendsActiveOrWaiting,
  decideCleanupArtifactDisposition,
  formatRecoveryArtifactLine,
  withClientOpTimeout,
  forceDestroyClient,
  abortActiveCleanupControl,
  trackActiveCleanupControl,
  untrackActiveCleanupControl,
});

if (require.main === module) {
  main().catch(() => {
    process.stdout.write('FAIL  stock_pg_proof — unhandled\n');
    process.exitCode = 1;
  });
}
