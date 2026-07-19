'use strict';

/**
 * FOUNDATION Slice 14R — Live reconcile decision (occupancy + drift grouping)
 *
 * Read-only proof on the confirmed active Sunset staging DB: capture safe occupancy
 * aggregates, group observer drift, and deterministically recommend
 * clean_canonical_rebuild_cutover vs in_place_targeted_repair (zero mutation).
 *
 * Mirrors Slice 14Q ARM→KV→PG authority sequence with application_name
 * wh-sunset-reconcile-decision and reconcile-specific capture.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  ENV_LIVE_READONLY,
  ENV_LIVE_PREFLIGHT,
  ENV_SUBSCRIPTION,
  ENV_CREDENTIAL_SOURCE,
  CLI_CREDENTIAL_SOURCE,
  CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  redactSecrets,
  redactDeep,
  REDACTED,
} = require('./phase-d-live-readonly-boundary');
const {
  MI_LOADER_LOCKS,
  PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED,
  buildOfflineProofSunsetDatabaseUrl,
  zeroPrivateCredentialRefs,
  parseSunsetDatabaseUrlSecretInMemory,
} = require('./phase-d-managed-identity-credential-loader');
const {
  buildVerifiedTlsSslConfig,
} = require('./phase-d-live-readonly-pg-adapter');
const {
  MIGRATIONS_DIR,
  forwardEntries,
  loadManifest,
  MANIFEST_PATH,
} = require('./migration-integrity');
const {
  parseDatabaseUrl,
  introspectProductSchema,
  fingerprintProductSchema,
  compareSnapshots,
  NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
  EXPECTED_HOST,
  EXPECTED_DATABASE,
  LEDGER_TABLE,
  INTROSPECTION_SQL,
  assertSqlAllowed,
} = require('./sunset-schema-observer');
const {
  AUTHORITY_LOCKS: BASE_AUTHORITY_LOCKS,
  FORBIDDEN_ARGV_FLAGS: BASE_FORBIDDEN_ARGV_FLAGS,
  CLI_PROVE_TARGET_AUTHORITY,
  createInjectedTargetAuthorityHttp,
  normalizeKeyVaultSecretUrl,
  extractActiveRevision,
  extractDbEnvSecretRef,
  compareDsnAuthorityInMemory,
  compareKeyVaultRefAuthority,
} = require('./phase-d-active-db-target-authority');

/** Live HTTP activated for Slice 14R behind exact env+argv gates. */
const PHASE_D_RECONCILE_DECISION_LIVE_ENABLED = true;

const ENV_RECONCILE_DECISION = 'SUNSET_PHASE_D_RECONCILE_DECISION';
const CLI_PROVE_RECONCILE_DECISION = '--prove-reconcile-decision';

const APPLICATION_NAME = 'wh-sunset-reconcile-decision';

const RECONCILE_LOCKS = Object.freeze({
  ...BASE_AUTHORITY_LOCKS,
  applicationName: APPLICATION_NAME,
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  ...BASE_FORBIDDEN_ARGV_FLAGS,
  CLI_PROVE_TARGET_AUTHORITY,
  '--execute-count-only',
  '--apply-phase-d-constraints',
  '--apply-firewall-rule',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_PROVE_RECONCILE_DECISION,
  '--subscription',
  '--resource-group',
  '--container-app',
  '--postgres-server',
  '--database',
  CLI_CREDENTIAL_SOURCE,
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'sameTarget',
  'sameTargetReason',
  'blocker',
  'liveMutation',
  'schemaMutation',
  'dataMutation',
  'ledgerWritten',
  'kvMutation',
  'rbacMutation',
  'networkMutation',
  'firewallAction',
  'usedLiveHttp',
  'realImdsCall',
  'realArmCall',
  'realKeyVaultCall',
  'realPostgresCall',
  'httpRequestCount',
  'imdsRequestCount',
  'armGetCount',
  'armPostCount',
  'listSecretsCount',
  'keyVaultRequestCount',
  'clientsInstantiated',
  'connectCalls',
  'queryCalls',
  'endCalls',
  'subscriptionId',
  'resourceGroup',
  'containerAppName',
  'activeRevisionName',
  'activeRevisionCount',
  'dbEnvName',
  'secretRefName',
  'secretRefAmbiguous',
  'appSecretKeyVaultUrlMatchesLocked',
  'listSecretsUsed',
  'kvSecretName',
  'keyVaultName',
  'postgresHost',
  'database',
  'port',
  'sslmode',
  'applicationName',
  'managedIdentityName',
  'credentialSource',
  'hostMatch',
  'portMatch',
  'databaseMatch',
  'usernameEqual',
  'passwordEqual',
  'tlsSemanticsMatch',
  'kvTargetValid',
  'appTargetValid',
  'comparisonMode',
  'sessionReadOnly',
  'transactionReadOnly',
  'schemaInventory',
  'ledgerSummary',
  'occupancy',
  'groupedDrift',
  'migrationOwnership',
  'decision',
  'recommendation',
  'occupancySummary',
  'errors',
  'closed',
  'committed',
  'rolledBack',
]);

const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/i;

let httpRequestCount = 0;
let imdsRequestCount = 0;
let armGetCount = 0;
let armPostCount = 0;
let listSecretsCount = 0;
let keyVaultRequestCount = 0;
let clientsInstantiated = 0;
let connectCalls = 0;
let queryCalls = 0;
let endCalls = 0;

function getReconcileDecisionCounters() {
  return {
    httpRequestCount,
    imdsRequestCount,
    armGetCount,
    armPostCount,
    listSecretsCount,
    keyVaultRequestCount,
    clientsInstantiated,
    connectCalls,
    queryCalls,
    endCalls,
  };
}

function resetReconcileDecisionCounters() {
  httpRequestCount = 0;
  imdsRequestCount = 0;
  armGetCount = 0;
  armPostCount = 0;
  listSecretsCount = 0;
  keyVaultRequestCount = 0;
  clientsInstantiated = 0;
  connectCalls = 0;
  queryCalls = 0;
  endCalls = 0;
}

function pickSafe(obj) {
  const out = {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function sanitizeReconcileError(err, secrets) {
  const list = (secrets || []).filter(Boolean).map(String);
  let message = String((err && err.message) || err || 'reconcile_decision_failed').slice(0, 240);
  message = redactSecrets(message, list)
    .replace(/postgres(?:ql)?:\/\/[^:\s/@]+:[^@\s/]+@/gi, `postgresql://${REDACTED}:`)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, REDACTED);
  return {
    code: (err && err.code) || 'reconcile_decision_failed',
    message,
  };
}

function parseArgvPairs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const flags = new Set();
  const values = {};
  const unknown = [];
  const forbidden = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let flag = a;
    let val = null;
    if (eq > 0) {
      flag = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    if (FORBIDDEN_ARGV_FLAGS.includes(flag)) {
      forbidden.push(flag);
      if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (flag === CLI_PROVE_RECONCILE_DECISION || flag === '--help' || flag === '-h') {
      flags.add(flag);
      continue;
    }
    if (ALLOWED_ARGV_FLAGS.includes(flag)) {
      if (val == null) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          unknown.push(flag);
          continue;
        }
        val = args[i + 1];
        i += 1;
      }
      values[flag] = val;
      flags.add(flag);
      continue;
    }
    unknown.push(flag);
    if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
  }
  return { flags, values, unknown, forbidden, argv: args };
}

function exactReconcileDecisionArgv() {
  return [
    CLI_PROVE_RECONCILE_DECISION,
    '--subscription', RECONCILE_LOCKS.subscriptionId,
    '--resource-group', RECONCILE_LOCKS.resourceGroup,
    '--container-app', RECONCILE_LOCKS.containerAppName,
    '--postgres-server', RECONCILE_LOCKS.postgresServer,
    '--database', RECONCILE_LOCKS.database,
    CLI_CREDENTIAL_SOURCE, CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  ];
}

function reconcileDecisionEnv() {
  return {
    [ENV_LIVE_READONLY]: '1',
    [ENV_LIVE_PREFLIGHT]: '1',
    [ENV_RECONCILE_DECISION]: '1',
    [ENV_SUBSCRIPTION]: RECONCILE_LOCKS.subscriptionId,
    [ENV_CREDENTIAL_SOURCE]: CREDENTIAL_SOURCE_MANAGED_IDENTITY,
  };
}

function evaluateReconcileDecisionGates(opts) {
  const options = opts || {};
  const env = options.env || {};
  const parsed = parseArgvPairs(options.argv || []);
  const errors = [];

  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
    errors.push({ code: 'connect_not_enabled', message: 'PHASE_D_LIVE_READONLY_CONNECT_ENABLED must be true' });
  }
  if (PHASE_D_LIVE_APPLY_ENABLED !== false) {
    errors.push({ code: 'global_apply_must_remain_false', message: 'PHASE_D_LIVE_APPLY_ENABLED must remain false' });
  }
  if (PHASE_D_RECONCILE_DECISION_LIVE_ENABLED !== true) {
    errors.push({ code: 'reconcile_decision_capability_disabled', message: 'reconcile decision live capability disabled' });
  }
  if (String(env[ENV_LIVE_READONLY] || '') !== '1') {
    errors.push({ code: 'live_readonly_flag_required', message: `${ENV_LIVE_READONLY}=1 required` });
  }
  if (String(env[ENV_LIVE_PREFLIGHT] || '') !== '1') {
    errors.push({ code: 'live_preflight_flag_required', message: `${ENV_LIVE_PREFLIGHT}=1 required` });
  }
  if (String(env[ENV_RECONCILE_DECISION] || '') !== '1') {
    errors.push({ code: 'reconcile_decision_env_required', message: `${ENV_RECONCILE_DECISION}=1 required` });
  }
  if (String(env[ENV_SUBSCRIPTION] || '') !== RECONCILE_LOCKS.subscriptionId) {
    errors.push({ code: 'subscription_env_mismatch', message: 'AZURE_SUBSCRIPTION_ID must match locked subscription' });
  }
  if (String(env[ENV_CREDENTIAL_SOURCE] || '') !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `env ${ENV_CREDENTIAL_SOURCE}=managed-identity required`,
    });
  }
  if (!parsed.flags.has(CLI_PROVE_RECONCILE_DECISION)) {
    errors.push({ code: 'reconcile_decision_flag_required', message: `${CLI_PROVE_RECONCILE_DECISION} required` });
  }
  if (parsed.values[CLI_CREDENTIAL_SOURCE] !== CREDENTIAL_SOURCE_MANAGED_IDENTITY) {
    errors.push({
      code: 'managed_identity_credential_source_flag_required',
      message: `argv ${CLI_CREDENTIAL_SOURCE} managed-identity required`,
    });
  }
  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden argv: ${parsed.forbidden.join(',')}`,
    });
  }
  if (parsed.unknown.length > 0) {
    errors.push({
      code: 'unknown_argv',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
    });
  }

  const expect = {
    '--subscription': RECONCILE_LOCKS.subscriptionId,
    '--resource-group': RECONCILE_LOCKS.resourceGroup,
    '--container-app': RECONCILE_LOCKS.containerAppName,
    '--postgres-server': RECONCILE_LOCKS.postgresServer,
    '--database': RECONCILE_LOCKS.database,
  };
  for (const [flag, want] of Object.entries(expect)) {
    if (String(parsed.values[flag] || '') !== want) {
      errors.push({
        code: 'exact_target_mismatch',
        message: `${flag} must equal locked ${want}`,
      });
    }
  }

  return { ok: errors.length === 0, errors, parsed };
}

function lockedKeyVaultSecretUrlNormalized() {
  return normalizeKeyVaultSecretUrl(
    `${RECONCILE_LOCKS.keyVaultHttpsUrl}/secrets/${RECONCILE_LOCKS.secretName}`,
  );
}

function buildLockedImdsArmTokenUrl() {
  const q = new URLSearchParams({
    'api-version': RECONCILE_LOCKS.imdsApiVersion,
    resource: RECONCILE_LOCKS.armResourceAudience,
    client_id: RECONCILE_LOCKS.managedIdentityClientId,
  });
  return `http://${RECONCILE_LOCKS.imdsHost}${RECONCILE_LOCKS.imdsPath}?${q.toString()}`;
}

function buildLockedImdsVaultTokenUrl() {
  const q = new URLSearchParams({
    'api-version': RECONCILE_LOCKS.imdsApiVersion,
    resource: MI_LOADER_LOCKS.vaultResourceAudience,
    client_id: RECONCILE_LOCKS.managedIdentityClientId,
  });
  return `http://${RECONCILE_LOCKS.imdsHost}${RECONCILE_LOCKS.imdsPath}?${q.toString()}`;
}

function buildLockedArmContainerAppPath() {
  return (
    `/subscriptions/${RECONCILE_LOCKS.subscriptionId}`
    + `/resourceGroups/${RECONCILE_LOCKS.resourceGroup}`
    + `/providers/Microsoft.App/containerApps/${RECONCILE_LOCKS.containerAppName}`
    + `?api-version=${RECONCILE_LOCKS.armApiVersion}`
  );
}

function buildLockedArmListSecretsPath() {
  return (
    `/subscriptions/${RECONCILE_LOCKS.subscriptionId}`
    + `/resourceGroups/${RECONCILE_LOCKS.resourceGroup}`
    + `/providers/Microsoft.App/containerApps/${RECONCILE_LOCKS.containerAppName}`
    + `/listSecrets?api-version=${RECONCILE_LOCKS.armApiVersion}`
  );
}

function buildLockedKeyVaultSecretUrl() {
  return (
    `${RECONCILE_LOCKS.keyVaultHttpsUrl}/secrets/`
    + `${encodeURIComponent(RECONCILE_LOCKS.secretName)}`
    + `?api-version=${RECONCILE_LOCKS.keyVaultApiVersion}`
  );
}

function extractSecretMetaFromAppConfig(appBody, secretRefName) {
  const props = (appBody && appBody.properties) || {};
  const secrets = Array.isArray(props.configuration && props.configuration.secrets)
    ? props.configuration.secrets
    : [];
  const matches = secrets.filter((s) => String((s && s.name) || '') === secretRefName);
  if (matches.length === 0) {
    return { found: false, keyVaultUrl: null, hasValueField: false, needListSecrets: true };
  }
  if (matches.length > 1) {
    return { found: false, keyVaultUrl: null, hasValueField: false, needListSecrets: false, ambiguous: true };
  }
  const s = matches[0];
  const keyVaultUrl = s.keyVaultUrl != null ? String(s.keyVaultUrl) : null;
  const hasValueField = Object.prototype.hasOwnProperty.call(s, 'value')
    && s.value != null
    && String(s.value) !== '';
  return {
    found: true,
    keyVaultUrl,
    hasValueField,
    needListSecrets: !keyVaultUrl,
    ambiguous: false,
  };
}

function parseListSecretsForRef(listBody, secretRefName) {
  const bag = { _appSecretValue: null, keyVaultUrl: null, found: false, ambiguous: false };
  const items = Array.isArray(listBody && listBody.value)
    ? listBody.value
    : (Array.isArray(listBody) ? listBody : []);
  const matches = items.filter((s) => String((s && s.name) || '') === secretRefName);
  if (matches.length === 0) return bag;
  if (matches.length > 1) {
    bag.ambiguous = true;
    return bag;
  }
  const s = matches[0];
  bag.found = true;
  if (s.keyVaultUrl != null) bag.keyVaultUrl = String(s.keyVaultUrl);
  if (s.value != null && String(s.value) !== '') bag._appSecretValue = String(s.value);
  for (const item of items) {
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'value')) {
      try { item.value = null; } catch (_) { /* ignore */ }
    }
  }
  return bag;
}

function zeroListSecretsValues(listBody) {
  const items = Array.isArray(listBody && listBody.value)
    ? listBody.value
    : (Array.isArray(listBody) ? listBody : []);
  for (const item of items) {
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, 'value')) {
      try { item.value = null; } catch (_) { /* ignore */ }
    }
  }
}

function createLiveReconcileDecisionHttpRequest() {
  async function httpRequest(req) {
    const request = req || {};
    const method = String(request.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      throw Object.assign(new Error(`http method ${method} forbidden`), { code: 'http_method_forbidden' });
    }
    if (method === 'POST' && request.purpose !== 'arm_list_secrets') {
      throw Object.assign(new Error('POST only allowed for listSecrets'), { code: 'http_method_forbidden' });
    }
    const protocol = String(request.protocol || '');
    const lib = protocol === 'https:' ? https : http;
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw Object.assign(new Error('http protocol rejected'), { code: 'http_protocol_rejected' });
    }
    const headers = { ...(request.headers || {}) };
    const body = request.body != null ? String(request.body) : null;
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };
      const nodeReq = lib.request({
        hostname: request.hostname,
        port: request.port,
        path: request.path,
        method,
        headers,
        timeout: 30000,
      }, (res) => {
        const statusCode = Number(res.statusCode);
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          finish(Object.assign(new Error('http redirect rejected'), { code: 'http_redirect_rejected' }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); });
        res.on('end', () => {
          finish(null, { statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => {
          finish(Object.assign(
            new Error(String((err && err.message) || err || 'http response failed').slice(0, 240)),
            { code: 'http_request_failed' },
          ));
        });
      });
      nodeReq.on('timeout', () => {
        nodeReq.destroy();
        finish(Object.assign(new Error('http request timeout'), { code: 'http_request_failed' }));
      });
      nodeReq.on('error', (err) => {
        finish(Object.assign(
          new Error(String((err && err.message) || err || 'http request failed').slice(0, 240)),
          { code: 'http_request_failed' },
        ));
      });
      if (body != null) nodeReq.write(body);
      nodeReq.end();
    });
  }
  return httpRequest;
}

function createInjectedReconcileDecisionHttp(script) {
  return createInjectedTargetAuthorityHttp(script);
}

async function invokeReconcileHttp(httpRequest, request) {
  httpRequestCount += 1;
  const res = await httpRequest(request);
  if (!res || typeof res !== 'object') {
    throw Object.assign(new Error('http returned no response'), { code: 'http_response_invalid' });
  }
  const statusCode = Number(res.statusCode);
  if (!Number.isFinite(statusCode)) {
    throw Object.assign(new Error('http missing statusCode'), { code: 'http_status_invalid' });
  }
  if (statusCode >= 300 && statusCode < 400) {
    throw Object.assign(new Error('http redirect rejected'), { code: 'http_redirect_rejected' });
  }
  if (statusCode !== 200) {
    throw Object.assign(new Error(`http status ${statusCode} rejected`), { code: 'http_status_rejected' });
  }
  return res;
}

async function fetchImdsToken(httpRequest, purpose) {
  const url = new URL(
    purpose === 'imds_arm_token' ? buildLockedImdsArmTokenUrl() : buildLockedImdsVaultTokenUrl(),
  );
  imdsRequestCount += 1;
  const res = await invokeReconcileHttp(httpRequest, {
    purpose,
    protocol: 'http:',
    hostname: url.hostname,
    port: 80,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze({ Metadata: 'true' }),
  });
  let body;
  try {
    body = JSON.parse(res.body);
  } catch (_) {
    throw Object.assign(new Error('IMDS JSON invalid'), { code: 'imds_json_invalid' });
  }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw Object.assign(new Error('IMDS token missing'), { code: 'imds_token_missing' });
  }
  if (body.client_id != null && String(body.client_id) !== RECONCILE_LOCKS.managedIdentityClientId) {
    throw Object.assign(new Error('IMDS token identity mismatch'), { code: 'imds_token_identity_mismatch' });
  }
  return body.access_token;
}

function buildLockedPgClientConfig(user, password) {
  return {
    host: RECONCILE_LOCKS.postgresHost,
    port: RECONCILE_LOCKS.port,
    database: RECONCILE_LOCKS.database,
    user: String(user),
    password: String(password),
    application_name: APPLICATION_NAME,
    options: [
      '-c default_transaction_read_only=on',
      '-c statement_timeout=30000',
      '-c lock_timeout=5000',
    ].join(' '),
    connectionTimeoutMillis: 20000,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

function quoteIdent(name) {
  if (!TABLE_NAME_RE.test(name)) {
    throw Object.assign(new Error(`invalid table identifier: ${name}`), { code: 'invalid_table_name' });
  }
  return `"${String(name).replace(/"/g, '""')}"`;
}

function summarizeOccupancy(occupancy) {
  const occ = occupancy || {};
  return {
    canonicalPublicTableCount: occ.canonicalPublicTableCount,
    livePublicTableCount: occ.livePublicTableCount,
    emptyApprovedTableCount: occ.emptyApprovedTableCount,
    nonemptyApprovedTableCount: occ.nonemptyApprovedTableCount,
    totalApprovedRowCount: occ.totalApprovedRowCount,
    countAmbiguous: occ.countAmbiguous === true,
    publicSequenceCount: occ.publicSequenceCount,
    noncanonicalPublicTableCount: Array.isArray(occ.noncanonicalPublicTables)
      ? occ.noncanonicalPublicTables.length
      : 0,
    missingApprovedTableCount: Array.isArray(occ.missingApprovedTables)
      ? occ.missingApprovedTables.length
      : 0,
    noncanonicalDataBearingObjectExists: occ.noncanonicalDataBearingObjectExists === true,
    dataBearingTableOmittedByCanonical: occ.dataBearingTableOmittedByCanonical === true,
    tableSetMismatch: occ.tableSetMismatch === true,
  };
}

function buildFutureRebuildCutoverPlan() {
  return {
    steps: [
      {
        id: 'snapshot_backup_proof',
        title: 'Prove logical snapshot/backup of current DB before any cutover',
        execute: false,
      },
      {
        id: 'provision_empty_sibling',
        title: 'Provision empty sibling DB or truncate-free rebuild path (no DML on active until cutover)',
        execute: false,
      },
      {
        id: 'apply_canonical_forward_migrations',
        title: 'Apply canonical forward migrations to empty target; observer must reach match',
        execute: false,
      },
      {
        id: 'observer_match_proof',
        title: 'Observer compare against expected-product-schema must match before cutover',
        execute: false,
      },
      {
        id: 'cutover_staff_api_dsn',
        title: 'Repoint Staff API Container App secretRef to new DB authority',
        execute: false,
      },
    ],
    rollback: [
      {
        id: 'repoint_dsn_to_prior',
        title: 'Repoint Staff API DSN back to prior DB authority',
        execute: false,
      },
      {
        id: 'retain_old_db',
        title: 'Retain old DB read-only for forensic recovery; do not drop',
        execute: false,
      },
    ],
  };
}

const PHASE_SEQUENCE_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G']);

const NON_TABLE_SECTIONS = Object.freeze([
  'functions',
  'triggers',
  'rlsFlags',
  'ownership',
  'acls',
  'extensions',
]);

const CONSTRAINT_TYPE_PHASE = Object.freeze({
  NOT_NULL: 'C',
  'PRIMARY KEY': 'D',
  UNIQUE: 'D',
  'FOREIGN KEY': 'D',
  CHECK: 'already_cleared',
  other: 'unowned',
});

function notNullMismatchCount(drift) {
  const ctd = (drift && drift.constraintTypeDrift) || {};
  return Number(ctd.NOT_NULL) || 0;
}

function checkConstraintMismatchCount(drift) {
  const ctd = (drift && drift.constraintTypeDrift) || {};
  return Number(ctd.CHECK) || 0;
}

/**
 * Partition observer drift into phase-owned / already_cleared / unowned buckets.
 * Covers every expected_only + definition_mismatch item exactly once by
 * section / constraint-type (constraints section is split by type, not double-counted).
 */
function buildPhaseDriftCoverage(drift) {
  const dr = drift || {};
  const sections = dr.mismatchSections || {};
  const ctd = dr.constraintTypeDrift || {};
  const counts = dr.counts || {};
  const expectedOnly = Number(counts.expected_only) || 0;
  const definitionMismatch = Number(counts.definition_mismatch) || 0;
  const liveOnly = Number(counts.live_only) || 0;
  const totalOwnedScope = expectedOnly + definitionMismatch;

  const categories = [];
  const pushCat = (key, count, owner) => {
    categories.push({
      key,
      count: Number(count) || 0,
      owner,
    });
  };

  pushCat('tables', sections.tables, 'B');
  pushCat('columns', sections.columns, 'B');
  pushCat('constraints.NOT_NULL', ctd.NOT_NULL, 'C');
  pushCat('constraints.PRIMARY KEY', ctd['PRIMARY KEY'], 'D');
  pushCat('constraints.UNIQUE', ctd.UNIQUE, 'D');
  pushCat('constraints.FOREIGN KEY', ctd['FOREIGN KEY'], 'D');
  const checkCount = Number(ctd.CHECK) || 0;
  pushCat(
    'constraints.CHECK',
    checkCount,
    checkCount === 0 ? 'already_cleared' : 'unowned',
  );
  pushCat('constraints.other', ctd.other, 'unowned');
  pushCat('indexes', sections.indexes, 'D');
  for (const section of NON_TABLE_SECTIONS) {
    pushCat(section, sections[section], 'E');
  }

  // Any unexpected mismatchSections keys are unowned (constraints already partitioned).
  const knownSections = new Set([
    'tables',
    'columns',
    'constraints',
    'indexes',
    ...NON_TABLE_SECTIONS,
  ]);
  for (const [section, count] of Object.entries(sections)) {
    if (!knownSections.has(section) && Number(count) > 0) {
      pushCat(`section.${section}`, count, 'unowned');
    }
  }

  const constraintTypeSum = ['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK', 'NOT_NULL', 'other']
    .reduce((sum, typ) => sum + (Number(ctd[typ]) || 0), 0);
  const constraintsSection = Number(sections.constraints) || 0;
  const constraintPartitionOk = constraintTypeSum === constraintsSection;

  const categorizedCount = categories.reduce((sum, c) => sum + c.count, 0);
  // constraints section is represented only via constraint-type categories
  const coveredExactlyOnce = constraintPartitionOk
    && categorizedCount === totalOwnedScope
    && liveOnly === 0;

  const byOwner = Object.create(null);
  const unowned = [];
  const alreadyCleared = [];
  for (const cat of categories) {
    if (cat.owner === 'unowned') {
      if (cat.count > 0) unowned.push(cat);
      continue;
    }
    if (cat.owner === 'already_cleared') {
      alreadyCleared.push(cat);
      continue;
    }
    if (!byOwner[cat.owner]) byOwner[cat.owner] = [];
    byOwner[cat.owner].push(cat);
  }

  return {
    expectedOnly,
    definitionMismatch,
    liveOnly,
    totalOwnedScope,
    categorizedCount,
    constraintPartitionOk,
    coveredExactlyOnce,
    checkConstraintsStatus: checkCount === 0 ? 'already_cleared' : 'unowned_nonzero_check',
    checkMismatchCount: checkCount,
    notNullMismatchCount: Number(ctd.NOT_NULL) || 0,
    categories,
    byOwner,
    unowned,
    alreadyCleared,
  };
}

function reconcileCompletionAllowed(drift) {
  return notNullMismatchCount(drift) === 0;
}

function buildOrderedReconciliationPhases(occupancy, drift, riskLevel) {
  const occ = occupancy || {};
  const dr = drift || {};
  const risk = riskLevel || 'medium';
  const notNullCount = notNullMismatchCount(dr);
  const checkCount = checkConstraintMismatchCount(dr);
  const coverage = buildPhaseDriftCoverage(dr);
  const completionAllowed = reconcileCompletionAllowed(dr);

  const phases = [
    {
      id: 'A',
      title: 'Validate observer normalization and exact target authority',
      risk: 'low',
      owns: [],
      actions: [
        'Confirm normalization profile azure_flexible_server_v1 before interpreting drift',
        'Confirm locked exact target authority (Staff API ↔ KV ↔ PG) before any repair design',
        'Re-run observer after normalization; abort if observation defect persists',
      ],
      execute: false,
    },
    {
      id: 'B',
      title: 'Add missing canonical tables and columns in migration dependency order',
      risk: (dr.missingCounts && (dr.missingCounts.tables > 0 || dr.missingCounts.columns > 0))
        ? 'medium'
        : 'low',
      owns: ['tables', 'columns'],
      actions: [
        'Apply only forward migrations owning missing expected tables/columns in manifest dependency order',
        'Do not invent columns outside canonical migration ownership',
        'Validate Staff API compatibility after each additive batch',
      ],
      execute: false,
    },
    {
      id: 'C',
      title: 'NOT NULL preflight and bounded application design',
      risk: notNullCount > 0 ? 'high' : 'low',
      owns: ['constraints.NOT_NULL'],
      actions: [
        `Preflight COUNT nulls per expected NOT NULL column only (expected NOT_NULL mismatches=${notNullCount})`,
        'Abort on any null row, count ambiguity, or ownership ambiguity — no DML/backfill',
        'Use exact canonical migration ownership for each NOT NULL column',
        'Apply SET NOT NULL only in bounded table batches with explicit locks; verify after each batch',
      ],
      execute: false,
    },
    {
      id: 'D',
      title: 'Indexes then PRIMARY KEY / FOREIGN KEY dependency validation and application',
      risk: 'medium',
      owns: ['indexes', 'constraints.PRIMARY KEY', 'constraints.UNIQUE', 'constraints.FOREIGN KEY'],
      actions: [
        'Create missing indexes from canonical migration ownership map before PK/FK apply',
        'Validate then apply PRIMARY KEY / UNIQUE / FOREIGN KEY only after dependency proof',
        'No orphan-row repair DML; abort on FK parent/child dependency failure',
        checkCount === 0
          ? 'CHECK constraints already cleared on live (Phase D CHECK status=already_cleared); no fictional CHECK work'
          : 'Unexpected nonzero CHECK mismatches remain unclassified for this plan — abort',
      ],
      execute: false,
    },
    {
      id: 'E',
      title: 'Reconcile functions, triggers, RLS, ownership, ACL, and extensions',
      risk: 'medium',
      owns: NON_TABLE_SECTIONS.slice(),
      actions: [
        'Reconcile remaining canonical functions/triggers/RLS flags with exact definitions',
        'Reconcile ownership and ACLs to least privilege matching canonical expected schema',
        'Reconcile extensions to exact canonical set — no extra privileges or opportunistic grants',
      ],
      execute: false,
    },
    {
      id: 'F',
      title: 'Migration-ledger bootstrap only after schema matches',
      risk: dr.migrationLedgerAbsent === true ? 'medium' : 'low',
      owns: [],
      actions: [
        'Bootstrap schema_migration_ledger from manifest checksums only after schema matches expected',
        'Second apply of ledger bootstrap design must be a no-op',
        'Never backfill ledger without operator sign-off',
      ],
      execute: false,
    },
    {
      id: 'G',
      title: 'Canonical observer zero-drift and idempotent rerun',
      risk,
      owns: [],
      actions: [
        'Observer must report zero drift before declaring reconcile complete',
        'Idempotent rerun must remain a no-op',
        completionAllowed
          ? 'NOT_NULL count is zero — completion may be considered after zero-drift proof'
          : `Do not recommend completion while NOT_NULL count=${notNullCount} > 0`,
      ],
      execute: false,
      reconcileCompletionAllowed: completionAllowed,
    },
  ];

  if (occ.noncanonicalDataBearingObjectExists === true) {
    phases.unshift({
      id: 'EXPORT',
      title: 'Controlled export of noncanonical data-bearing objects',
      risk: 'high',
      owns: [],
      actions: [
        'Export rows from noncanonical tables omitted by canonical rebuild',
        'Map to approved tables or operator-approved archive before any destructive step',
      ],
      execute: false,
    });
  }

  return phases.map((phase) => ({
    ...phase,
    phaseDriftCoverageRef: coverage.coveredExactlyOnce,
  }));
}

/**
 * Validate design-only A–G phase plan: ordering, NOT_NULL + non-table ownership,
 * CHECK already-cleared honesty, and completion gate while NOT_NULL > 0.
 */
function validateOrderedReconciliationPhases(phases, drift) {
  const dr = drift || {};
  const list = Array.isArray(phases) ? phases : [];
  const core = list.filter((p) => p && PHASE_SEQUENCE_IDS.includes(p.id));
  const ids = core.map((p) => p.id);
  const coverage = buildPhaseDriftCoverage(dr);
  const notNullCount = notNullMismatchCount(dr);
  const checkCount = checkConstraintMismatchCount(dr);

  if (ids.join('') !== PHASE_SEQUENCE_IDS.join('')) {
    return {
      ok: false,
      code: 'unsafe_phase_ordering',
      detail: `expected core sequence ${PHASE_SEQUENCE_IDS.join('-')}, got ${ids.join('-') || '(empty)'}`,
      coverage,
    };
  }

  if (list.some((p) => p && p.execute !== false)) {
    return {
      ok: false,
      code: 'execute_not_false',
      detail: 'every phase must remain execute=false',
      coverage,
    };
  }

  const byId = Object.create(null);
  for (const p of core) byId[p.id] = p;

  const phaseCText = `${byId.C.title}\n${(byId.C.actions || []).join('\n')}`;
  const phaseEText = `${byId.E.title}\n${(byId.E.actions || []).join('\n')}`;
  const phaseDText = `${byId.D.title}\n${(byId.D.actions || []).join('\n')}`;
  const phaseGText = `${byId.G.title}\n${(byId.G.actions || []).join('\n')}`;

  if (notNullCount > 0 && !/NOT\s*NULL/i.test(phaseCText)) {
    return {
      ok: false,
      code: 'omitted_not_null_or_non_table_section',
      detail: 'Phase C must explicitly own NOT NULL when NOT_NULL mismatches exist',
      coverage,
    };
  }

  const nonTableOwned = /function/i.test(phaseEText)
    && /trigger/i.test(phaseEText)
    && /\bRLS\b/i.test(phaseEText)
    && /ownership/i.test(phaseEText)
    && /\bACL/i.test(phaseEText)
    && /extension/i.test(phaseEText);
  if (!nonTableOwned) {
    return {
      ok: false,
      code: 'omitted_not_null_or_non_table_section',
      detail: 'Phase E must explicitly own functions/triggers/RLS/ownership/ACL/extensions',
      coverage,
    };
  }

  if (checkCount === 0
    && /missing CHECK|apply CHECK|CHECK preflight on live data before apply/i.test(phaseDText)) {
    return {
      ok: false,
      code: 'fictional_check_work',
      detail: 'CHECK already cleared on live; plan must not invent missing CHECK work',
      coverage,
    };
  }

  if (notNullCount > 0) {
    if (byId.G.reconcileCompletionAllowed === true) {
      return {
        ok: false,
        code: 'completion_while_not_null',
        detail: `reconcileCompletionAllowed must be false while NOT_NULL=${notNullCount}`,
        coverage,
      };
    }
    if (!/NOT_NULL count/i.test(phaseGText) && !/while NOT_NULL/i.test(phaseGText)) {
      return {
        ok: false,
        code: 'completion_while_not_null',
        detail: 'Phase G must refuse completion while NOT_NULL count > 0',
        coverage,
      };
    }
  }

  if (!coverage.coveredExactlyOnce && totalDriftScope(dr) > 0) {
    return {
      ok: false,
      code: 'drift_coverage_incomplete',
      detail: 'phase drift coverage must classify every expected_only + definition_mismatch exactly once',
      coverage,
    };
  }

  const idx = (id) => ids.indexOf(id);
  if (!(idx('C') < idx('D') && idx('E') < idx('F') && idx('F') < idx('G') && idx('B') < idx('C'))) {
    return {
      ok: false,
      code: 'unsafe_phase_ordering',
      detail: 'require B→C→D and E→F→G dependency order',
      coverage,
    };
  }

  return {
    ok: true,
    code: 'complete_a_to_g_coverage',
    detail: 'A–G coverage with NOT_NULL + non-table ownership and CHECK already_cleared',
    coverage,
  };
}

function totalDriftScope(drift) {
  const counts = (drift && drift.counts) || {};
  return (Number(counts.expected_only) || 0) + (Number(counts.definition_mismatch) || 0);
}

/** Deliberately unsafe / incomplete plans for RED proofs (never used as live recommendation). */
function buildDefectiveReconciliationPhases(kind, occupancy, drift) {
  const base = buildOrderedReconciliationPhases(occupancy, drift, 'high').filter(
    (p) => PHASE_SEQUENCE_IDS.includes(p.id),
  );
  if (kind === 'omitted_not_null_or_non_table_section') {
    return base.map((p) => {
      if (p.id === 'C') {
        return {
          ...p,
          title: 'Skip dominant column nullability mismatches (defective)',
          owns: [],
          actions: ['Intentionally omit nullability ownership'],
          execute: false,
        };
      }
      if (p.id === 'E') {
        return {
          ...p,
          title: 'Skip non-table catalog sections (defective)',
          owns: [],
          actions: ['Intentionally omit remaining catalog sections'],
          execute: false,
        };
      }
      return p;
    });
  }
  if (kind === 'unsafe_phase_ordering') {
    // Put ledger bootstrap (F) before NOT NULL (C) and swap D before C.
    const byId = Object.create(null);
    for (const p of base) byId[p.id] = p;
    return [byId.A, byId.B, byId.F, byId.D, byId.C, byId.E, byId.G];
  }
  return base;
}

/**
 * Pure deterministic reconcile strategy decision (unit-testable).
 * Clean canonical rebuild/cutover recommended ONLY IF sameTarget and all approved
 * existing tables have row count === 0 (no count ambiguity, no noncanonical data-bearing
 * objects, no missing approved tables). Never recommend destructive rebuild when data exists.
 */
function attachPhasePlan(decision, occupancy, drift, riskLevel) {
  const phases = buildOrderedReconciliationPhases(occupancy, drift, riskLevel);
  const coverage = buildPhaseDriftCoverage(drift);
  const completionAllowed = reconcileCompletionAllowed(drift);
  const validation = validateOrderedReconciliationPhases(phases, drift);
  return {
    ...decision,
    orderedReconciliationPhases: phases,
    phaseDriftCoverage: coverage,
    reconcileCompletionAllowed: completionAllowed,
    checkConstraintsStatus: coverage.checkConstraintsStatus,
    phasePlanValidation: {
      ok: validation.ok === true,
      code: validation.code,
    },
  };
}

function decideReconcileStrategy(occupancy, drift, sameTarget) {
  const occ = occupancy || {};
  const dr = drift || {};
  const base = {
    destructiveRebuildForbidden: true,
    executed: false,
    occupancySummary: summarizeOccupancy(occ),
    reconcileCompletionAllowed: false,
    checkConstraintsStatus: buildPhaseDriftCoverage(dr).checkConstraintsStatus,
    phaseDriftCoverage: null,
    phasePlanValidation: null,
  };

  if (sameTarget !== true) {
    return {
      ...base,
      recommendation: 'blocked_wrong_target',
      rationale: 'Staff API and/or KV admin path do not share locked exact authority; reconcile blocked',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      orderedReconciliationPhases: null,
      dependencyValidationRisk: null,
    };
  }

  if (occ.countAmbiguous === true || occ.tableSetMismatch === true) {
    return {
      ...base,
      recommendation: 'blocked_count_ambiguity',
      rationale: occ.tableSetMismatch === true
        ? 'Table inventory mismatch prevents safe occupancy enumeration'
        : 'Row count ambiguity or overflow prevents safe rebuild recommendation',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      orderedReconciliationPhases: null,
      dependencyValidationRisk: null,
    };
  }

  if (Array.isArray(occ.countFailures) && occ.countFailures.length > 0) {
    return {
      ...base,
      recommendation: 'blocked_count_ambiguity',
      rationale: 'One or more approved table COUNT(*) queries failed',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      orderedReconciliationPhases: null,
      dependencyValidationRisk: null,
    };
  }

  const perCounts = occ.perTableRowCounts || {};
  const approvedExisting = Object.keys(perCounts);
  const allApprovedEmpty = approvedExisting.length === 0
    || approvedExisting.every((t) => Number(perCounts[t]) === 0);
  const missing = Array.isArray(occ.missingApprovedTables) ? occ.missingApprovedTables : [];
  const missingWithUnknownCount = missing.length > 0 && occ.enumerationComplete !== true;

  if (missingWithUnknownCount) {
    return {
      ...base,
      recommendation: 'blocked_count_ambiguity',
      rationale: 'Missing approved tables prevent complete occupancy proof',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      orderedReconciliationPhases: null,
      dependencyValidationRisk: null,
    };
  }

  const noNoncanonicalData = occ.noncanonicalDataBearingObjectExists !== true;
  const noOmittedData = occ.dataBearingTableOmittedByCanonical !== true;
  const hasApprovedData = Number(occ.nonemptyApprovedTableCount) > 0
    || Number(occ.totalApprovedRowCount) > 0;

  if (allApprovedEmpty && noNoncanonicalData && noOmittedData && missing.length === 0) {
    return {
      ...base,
      recommendation: 'clean_canonical_rebuild_cutover',
      rationale: 'sameTarget with zero rows in all approved tables and no noncanonical data-bearing objects; clean canonical rebuild/cutover is safest',
      rebuildAllowed: true,
      futureRebuildCutoverPlan: buildFutureRebuildCutoverPlan(),
      orderedReconciliationPhases: null,
      dependencyValidationRisk: 'none',
      reconcileCompletionAllowed: false,
    };
  }

  if (hasApprovedData && allApprovedEmpty) {
    return {
      ...base,
      recommendation: 'blocked_unsafe',
      rationale: 'Inconsistent occupancy signals; refusing unsafe rebuild recommendation',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      orderedReconciliationPhases: null,
      dependencyValidationRisk: 'high',
    };
  }

  if (occ.noncanonicalDataBearingObjectExists === true) {
    return attachPhasePlan({
      ...base,
      recommendation: 'controlled_export_import',
      rationale: 'Noncanonical public tables contain rows that would be omitted by canonical rebuild; controlled export/import required',
      rebuildAllowed: false,
      futureRebuildCutoverPlan: null,
      dependencyValidationRisk: 'high',
    }, occ, dr, 'high');
  }

  const depRisk = hasApprovedData ? 'high' : (
    (dr.missingCounts && (dr.missingCounts.tables > 0 || dr.missingCounts.columns > 0))
      ? 'medium'
      : 'low'
  );

  return attachPhasePlan({
    ...base,
    recommendation: 'in_place_targeted_repair',
    rationale: hasApprovedData
      ? 'Approved tables contain data; in-place targeted repair is required — destructive rebuild forbidden'
      : 'Schema drift present without empty-db rebuild preconditions; in-place targeted repair recommended',
    rebuildAllowed: false,
    futureRebuildCutoverPlan: null,
    dependencyValidationRisk: depRisk,
  }, occ, dr, depRisk);
}

function parseConstraintTypeFromKey(key) {
  const parts = String(key || '').split('.');
  if (parts.length < 3) return 'other';
  const raw = parts[parts.length - 1];
  if (raw === 'n') return 'NOT_NULL';
  if (raw === 'PRIMARY KEY' || raw === 'UNIQUE' || raw === 'FOREIGN KEY' || raw === 'CHECK') return raw;
  return 'other';
}

function buildMigrationOwnershipIndex(migrationsDir, forward) {
  const index = Object.create(null);
  for (const entry of forward) {
    const filePath = path.join(migrationsDir, entry.filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const owned = {
      tables: new Set(),
      columns: new Set(),
      indexes: new Set(),
      constraints: new Set(),
    };

    const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi;
    let m;
    while ((m = tableRe.exec(sql)) !== null) owned.tables.add(m[1].toLowerCase());

    const colRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = colRe.exec(sql)) !== null) {
      owned.columns.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
    }

    const idxRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
    while ((m = idxRe.exec(sql)) !== null) owned.indexes.add(m[1].toLowerCase());

    index[entry.id] = owned;
  }
  return index;
}

function mapMissingToMigrationOwnership(drifts, ownershipIndex) {
  const agg = Object.create(null);
  let unownedMissingCount = 0;

  for (const d of drifts || []) {
    if (!d || d.kind !== 'expected_only') continue;
    const section = String(d.section || '');
    const key = String(d.key || '');
    let matched = false;

    for (const [migrationId, owned] of Object.entries(ownershipIndex)) {
      let hit = false;
      if (section === 'tables' && owned.tables.has(key.toLowerCase())) hit = true;
      else if (section === 'columns' && owned.columns.has(key.toLowerCase())) hit = true;
      else if (section === 'indexes') {
        const idxName = key.includes('.') ? key.split('.').pop() : key;
        if (owned.indexes.has(String(idxName).toLowerCase())) hit = true;
      } else if (section === 'constraints') {
        const table = key.split('.')[0];
        if (owned.tables.has(String(table).toLowerCase())) hit = true;
      }

      if (hit) {
        if (!agg[migrationId]) {
          agg[migrationId] = { tables: 0, columns: 0, indexes: 0, constraints: 0 };
        }
        if (section === 'tables') agg[migrationId].tables += 1;
        else if (section === 'columns') agg[migrationId].columns += 1;
        else if (section === 'indexes') agg[migrationId].indexes += 1;
        else if (section === 'constraints') agg[migrationId].constraints += 1;
        matched = true;
      }
    }
    if (!matched) unownedMissingCount += 1;
  }

  return { migrationOwnershipByManifestEntry: agg, unownedMissingCount };
}

function groupDrift(compareResult, ownershipIndex, ledgerAbsent) {
  const drifts = (compareResult && compareResult.drifts) || [];
  const counts = (compareResult && compareResult.counts) || {
    expected_only: 0,
    live_only: 0,
    definition_mismatch: 0,
  };

  const mismatchSections = {};
  const constraintTypeDrift = {
    'PRIMARY KEY': 0,
    UNIQUE: 0,
    'FOREIGN KEY': 0,
    CHECK: 0,
    NOT_NULL: 0,
    other: 0,
  };

  const missingCounts = { tables: 0, columns: 0, indexes: 0 };

  for (const d of drifts) {
    const section = String(d.section || d.kind || 'unknown');
    mismatchSections[section] = (mismatchSections[section] || 0) + 1;
    if (d.kind === 'expected_only') {
      if (section === 'tables') missingCounts.tables += 1;
      if (section === 'columns') missingCounts.columns += 1;
      if (section === 'indexes') missingCounts.indexes += 1;
    }
    if (section === 'constraints') {
      const typ = parseConstraintTypeFromKey(d.key);
      constraintTypeDrift[typ] = (constraintTypeDrift[typ] || 0) + 1;
    }
  }

  const ownership = mapMissingToMigrationOwnership(drifts, ownershipIndex);

  return {
    counts,
    mismatchSections,
    constraintTypeDrift,
    missingCounts,
    migrationOwnershipByManifestEntry: ownership.migrationOwnershipByManifestEntry,
    unownedMissingCount: ownership.unownedMissingCount,
    migrationLedgerAbsent: ledgerAbsent === true,
  };
}

async function captureSchemaInventory(client) {
  queryCalls += 1;
  const res = await client.query(`
    SELECT n.nspname AS schema_name,
           CASE c.relkind
             WHEN 'r' THEN 'table'
             WHEN 'v' THEN 'view'
             WHEN 'm' THEN 'materialized_view'
             WHEN 'S' THEN 'sequence'
             WHEN 'i' THEN 'index'
             ELSE c.relkind::text
           END AS object_type,
           COUNT(*)::int AS object_count
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
      AND c.relkind IN ('r', 'v', 'm', 'S', 'i')
    GROUP BY n.nspname, object_type
    ORDER BY n.nspname, object_type
  `);
  const bySchema = {};
  let totalObjects = 0;
  let publicTables = 0;
  for (const row of res.rows || []) {
    const schema = String(row.schema_name);
    const typ = String(row.object_type);
    const count = Number(row.object_count) || 0;
    if (!bySchema[schema]) bySchema[schema] = {};
    bySchema[schema][typ] = count;
    totalObjects += count;
    if (schema === 'public' && typ === 'table') publicTables = count;
  }
  return { bySchema, totalObjects, publicTables, schemas: Object.keys(bySchema).sort() };
}

async function captureLedgerSummary(client) {
  queryCalls += 1;
  const existsRes = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND c.relkind = 'r'
    ) AS present
  `, [LEDGER_TABLE]);
  const present = Boolean(existsRes.rows[0] && existsRes.rows[0].present);
  if (!present) {
    return {
      present: false,
      tableName: LEDGER_TABLE,
      rowCount: 0,
      note: 'ledger_table_absent',
    };
  }
  queryCalls += 1;
  const countRes = await client.query(`SELECT COUNT(*)::int AS n FROM public.${LEDGER_TABLE}`);
  return {
    present: true,
    tableName: LEDGER_TABLE,
    rowCount: Number(countRes.rows[0] && countRes.rows[0].n) || 0,
    note: null,
  };
}

async function captureOccupancy(client, approvedTableNames) {
  const approved = [...approvedTableNames].sort();
  const canonicalPublicTableCount = approved.length;

  queryCalls += 1;
  const tablesRes = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const liveTables = (tablesRes.rows || []).map((r) => String(r.table_name));
  const livePublicTableCount = liveTables.length;
  const approvedSet = new Set(approved);
  const liveSet = new Set(liveTables);
  const noncanonicalPublicTables = liveTables.filter((t) => !approvedSet.has(t)).sort();
  const missingApprovedTables = approved.filter((t) => !liveSet.has(t)).sort();

  const perTableRowCounts = {};
  const countFailures = [];
  let countAmbiguous = false;
  let totalApprovedRowCount = 0;
  let emptyApprovedTableCount = 0;
  let nonemptyApprovedTableCount = 0;

  for (const name of approved) {
    if (!liveSet.has(name)) continue;
    try {
      queryCalls += 1;
      const res = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.${quoteIdent(name)}`);
      const raw = res.rows[0] && res.rows[0].n;
      const cnt = typeof raw === 'string' ? BigInt(raw) : BigInt(Number(raw) || 0);
      if (cnt > BigInt(Number.MAX_SAFE_INTEGER)) countAmbiguous = true;
      const num = Number(cnt);
      perTableRowCounts[name] = num;
      if (num === 0) emptyApprovedTableCount += 1;
      else nonemptyApprovedTableCount += 1;
      const next = totalApprovedRowCount + num;
      if (!Number.isSafeInteger(next)) countAmbiguous = true;
      totalApprovedRowCount = next;
    } catch (_) {
      countFailures.push(name);
    }
  }

  let noncanonicalDataBearingObjectExists = false;
  for (const name of noncanonicalPublicTables) {
    try {
      queryCalls += 1;
      const res = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.${quoteIdent(name)}`);
      const raw = res.rows[0] && res.rows[0].n;
      const cnt = typeof raw === 'string' ? BigInt(raw) : BigInt(Number(raw) || 0);
      if (cnt > BigInt(0)) noncanonicalDataBearingObjectExists = true;
    } catch (_) {
      countFailures.push(name);
    }
  }

  queryCalls += 1;
  const seqRes = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  `);
  const publicSequenceCount = Number(seqRes.rows[0] && seqRes.rows[0].n) || 0;

  return {
    canonicalPublicTableCount,
    livePublicTableCount,
    perTableRowCounts,
    emptyApprovedTableCount,
    nonemptyApprovedTableCount,
    totalApprovedRowCount,
    countAmbiguous,
    countFailures,
    publicSequenceCount,
    noncanonicalPublicTables,
    noncanonicalDataBearingObjectExists,
    dataBearingTableOmittedByCanonical: noncanonicalDataBearingObjectExists,
    missingApprovedTables,
    enumerationComplete: countFailures.length === 0,
    tableSetMismatch: false,
  };
}

async function verifyReconcileSession(client) {
  const errors = [];
  const show = {};
  async function showOne(key, sql) {
    const gate = assertSqlAllowed(sql);
    if (!gate.ok) throw Object.assign(new Error(gate.message), { code: gate.code });
    queryCalls += 1;
    const res = await client.query(sql);
    const row = (res.rows && res.rows[0]) || {};
    const val = row[key] != null ? row[key] : Object.values(row)[0];
    show[key] = val;
    return val;
  }
  const tro = String(await showOne(
    'transaction_read_only',
    INTROSPECTION_SQL.show_transaction_read_only,
  )).toLowerCase();
  if (tro !== 'on') {
    errors.push({ code: 'non_read_only_session', message: `transaction_read_only=${tro || 'unset'}` });
  }
  const app = String(await showOne('application_name', INTROSPECTION_SQL.show_application_name));
  if (app !== APPLICATION_NAME) {
    errors.push({ code: 'wrong_application_name', message: `application_name must be ${APPLICATION_NAME}` });
  }
  const st = String(await showOne('statement_timeout', INTROSPECTION_SQL.show_statement_timeout));
  if (!(st === '30s' || st === '30000ms' || st === '30000')) {
    errors.push({ code: 'bad_statement_timeout', message: st });
  }
  const lt = String(await showOne('lock_timeout', INTROSPECTION_SQL.show_lock_timeout));
  if (!(lt === '5s' || lt === '5000ms' || lt === '5000')) {
    errors.push({ code: 'bad_lock_timeout', message: lt });
  }
  return { ok: errors.length === 0, errors, show };
}

async function runReconcileCapture(client, expectedContract, ownershipIndex) {
  const session = await verifyReconcileSession(client);
  if (!session.ok) {
    return {
      sessionReadOnly: false,
      transactionReadOnly: false,
      schemaInventory: null,
      ledgerSummary: null,
      occupancy: null,
      groupedDrift: null,
      decision: decideReconcileStrategy(null, null, true),
    };
  }

  const tro = String((session.show && session.show.transaction_read_only) || '').toLowerCase();
  const transactionReadOnly = tro === 'on';
  const schemaInventory = await captureSchemaInventory(client);
  const ledgerSummary = await captureLedgerSummary(client);

  const approvedNames = (expectedContract.snapshot.tables || [])
    .map((t) => (typeof t === 'string' ? t : t.name))
    .filter(Boolean)
    .sort();
  const occupancy = await captureOccupancy(client, approvedNames);

  const product = await introspectProductSchema(client);
  queryCalls += Array.isArray(product.usedAllowlist) ? product.usedAllowlist.length : 20;
  const productFingerprintLive = fingerprintProductSchema(product.snapshot);
  const cmp = compareSnapshots(expectedContract.snapshot, product.snapshot, {
    normalizationProfile: NORMALIZATION_PROFILE_AZURE_FLEXIBLE_SERVER_V1,
    azureContext: { verified: true, host: EXPECTED_HOST, database: EXPECTED_DATABASE },
  });

  const groupedDrift = groupDrift(
    cmp,
    ownershipIndex,
    ledgerSummary.present !== true,
  );

  const decision = decideReconcileStrategy(occupancy, groupedDrift, true);

  return {
    sessionReadOnly: true,
    transactionReadOnly,
    schemaInventory,
    ledgerSummary,
    occupancy,
    groupedDrift,
    decision,
    observerOutcome: {
      ok: cmp.ok === true,
      match: cmp.ok === true,
      code: cmp.ok === true ? 'observer_match' : 'observer_drift',
      mismatchCount: Array.isArray(cmp.drifts) ? cmp.drifts.length : null,
      counts: cmp.counts,
      productFingerprintLive,
      blocker: cmp.ok === true ? null : 'observer_drift',
    },
  };
}

function createScriptedReconcileDecisionFakeClientFactory(script) {
  const s = script || {};
  const approved = Array.isArray(s.approvedTableNames)
    ? s.approvedTableNames.slice().sort()
    : null;
  const perCounts = s.perTableRowCounts || {};
  const noncanonical = Array.isArray(s.noncanonicalTables)
    ? s.noncanonicalTables.slice().sort()
    : [];
  const noncanonicalCounts = s.noncanonicalRowCounts || {};
  const liveTables = approved
    ? [...approved.filter((t) => perCounts[t] !== 'missing'), ...noncanonical].sort()
    : (s.livePublicTables || ['slice14r_proof_a', 'slice14r_proof_b']).sort();

  function FakeClient() {
    this._ended = false;
    this.query = async (sql, params) => {
      const q = String(sql || '');
      if (/^BEGIN\s+READ\s+ONLY/i.test(q)) return { rows: [] };
      if (/^COMMIT/i.test(q) || /^ROLLBACK/i.test(q)) return { rows: [] };
      if (/transaction_read_only/i.test(q)) {
        return { rows: [{ transaction_read_only: s.transactionReadOnly === false ? 'off' : 'on' }] };
      }
      if (/statement_timeout/i.test(q)) return { rows: [{ statement_timeout: '30s' }] };
      if (/lock_timeout/i.test(q)) return { rows: [{ lock_timeout: '5s' }] };
      if (/application_name/i.test(q)) {
        return { rows: [{ application_name: APPLICATION_NAME }] };
      }
      if (/object_type/i.test(q) && /pg_catalog\.pg_class/i.test(q) && /GROUP BY/i.test(q)) {
        return {
          rows: s.inventoryRows || [
            { schema_name: 'public', object_type: 'table', object_count: liveTables.length },
          ],
        };
      }
      if (/relkind\s*=\s*'r'/i.test(q) && /relname AS table_name/i.test(q)) {
        return { rows: liveTables.map((table_name) => ({ table_name })) };
      }
      if (/relkind\s*=\s*'S'/i.test(q)) {
        return { rows: [{ n: s.publicSequenceCount != null ? s.publicSequenceCount : 0 }] };
      }
      if (/EXISTS/i.test(q) && /relname\s*=\s*\$1/i.test(q)) {
        const tableName = Array.isArray(params) ? String(params[0] || '') : '';
        if (!tableName || tableName === LEDGER_TABLE) {
          return { rows: [{ present: s.ledgerPresent === true }] };
        }
      }
      if (/COUNT\(\*\)/i.test(q) && /schema_migration_ledger/i.test(q)) {
        return { rows: [{ n: s.ledgerRowCount != null ? s.ledgerRowCount : 0 }] };
      }
      if (/COUNT\(\*\)/i.test(q) && /FROM\s+public\./i.test(q)) {
        const m = q.match(/FROM\s+public\.(?:"([^"]+)"|([a-z_][a-z0-9_]*))/i);
        const table = m ? (m[1] || m[2]) : null;
        if (table && Object.prototype.hasOwnProperty.call(perCounts, table)) {
          if (perCounts[table] === 'fail') throw new Error('count failed');
          return { rows: [{ n: String(perCounts[table]) }] };
        }
        if (table && Object.prototype.hasOwnProperty.call(noncanonicalCounts, table)) {
          return { rows: [{ n: String(noncanonicalCounts[table]) }] };
        }
        if (table && noncanonical.includes(table)) {
          return { rows: [{ n: '0' }] };
        }
        if (table && approved && approved.includes(table)) {
          return { rows: [{ n: '0' }] };
        }
        return { rows: [{ n: '0' }] };
      }
      return { rows: s.introspectionRows || [] };
    };
    this.connect = async () => {};
    this.end = async () => { this._ended = true; };
  }
  return FakeClient;
}

async function executeReconcileDecision(opts) {
  const options = opts || {};
  const secrets = [];
  const gate = evaluateReconcileDecisionGates(options);
  if (!gate.ok) {
    return pickSafe(redactDeep({
      ok: false,
      code: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      sameTarget: false,
      sameTargetReason: 'gates_rejected',
      blocker: (gate.errors[0] && gate.errors[0].code) || 'gates_rejected',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp: false,
      ...getReconcileDecisionCounters(),
      applicationName: APPLICATION_NAME,
      errors: gate.errors,
      closed: true,
      committed: false,
      rolledBack: false,
    }, secrets));
  }

  const usedLiveHttp = typeof options.httpRequest !== 'function'
    && PHASE_D_RECONCILE_DECISION_LIVE_ENABLED === true
    && PHASE_D_MANAGED_IDENTITY_LIVE_HTTP_ENABLED === true;
  const httpRequest = typeof options.httpRequest === 'function'
    ? options.httpRequest
    : (usedLiveHttp ? createLiveReconcileDecisionHttpRequest() : null);

  if (typeof httpRequest !== 'function') {
    return pickSafe({
      ok: false,
      code: 'http_disabled',
      sameTarget: false,
      blocker: 'http_disabled',
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      ...getReconcileDecisionCounters(),
      errors: [{ code: 'http_disabled', message: 'inject httpRequest for offline proof' }],
      closed: true,
      committed: false,
      rolledBack: false,
    });
  }

  let armToken = null;
  let vaultToken = null;
  let kvSecretValue = null;
  let appSecretValue = null;
  let client = null;
  let closed = true;
  let committed = false;
  let rolledBack = false;

  const manifest = options.manifest || loadManifest(MANIFEST_PATH);
  const forward = options.forward || forwardEntries(manifest);
  const ownershipIndex = options.ownershipIndex
    || buildMigrationOwnershipIndex(options.migrationsDir || MIGRATIONS_DIR, forward);

  const fail = (code, message, extra) => {
    zeroPrivateCredentialRefs({
      _token: armToken,
      _accessToken: vaultToken,
      _secretValue: kvSecretValue,
      _dsn: appSecretValue,
    });
    armToken = null;
    vaultToken = null;
    kvSecretValue = null;
    appSecretValue = null;
    return pickSafe(redactDeep({
      ok: false,
      code,
      sameTarget: false,
      sameTargetReason: code,
      blocker: code,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realImdsCall: imdsRequestCount > 0,
      realArmCall: armGetCount + armPostCount > 0,
      realKeyVaultCall: keyVaultRequestCount > 0,
      realPostgresCall: clientsInstantiated > 0,
      ...getReconcileDecisionCounters(),
      applicationName: APPLICATION_NAME,
      errors: [{ code, message: String(message || code).slice(0, 240) }],
      closed: true,
      committed,
      rolledBack,
      ...(extra || {}),
    }, secrets));
  };

  try {
    armToken = await fetchImdsToken(httpRequest, 'imds_arm_token');
    secrets.push(armToken);

    armGetCount += 1;
    const appRes = await invokeReconcileHttp(httpRequest, {
      purpose: 'arm_container_app_get',
      protocol: 'https:',
      hostname: RECONCILE_LOCKS.managementHostname,
      port: 443,
      method: 'GET',
      path: buildLockedArmContainerAppPath(),
      headers: Object.freeze({ Authorization: `Bearer ${armToken}` }),
    });
    let appBody;
    try {
      appBody = JSON.parse(appRes.body);
    } catch (_) {
      return fail('arm_json_invalid', 'container app GET JSON invalid');
    }

    const rev = extractActiveRevision(appBody);
    if (!rev.ok) {
      return fail(rev.code, rev.errors[0] && rev.errors[0].message, {
        activeRevisionCount: rev.activeRevisionCount,
        activeRevisionName: rev.activeRevisionName,
      });
    }

    const envRef = extractDbEnvSecretRef(appBody);
    if (!envRef.ok) {
      return fail(envRef.code, envRef.errors[0] && envRef.errors[0].message, {
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
      });
    }

    let secretMeta = extractSecretMetaFromAppConfig(appBody, envRef.secretRefName);
    if (secretMeta.ambiguous) {
      return fail('secret_ref_ambiguous', 'multiple secret config entries for secretRef');
    }

    let listSecretsUsed = false;
    let appKeyVaultUrl = secretMeta.keyVaultUrl || null;

    if (secretMeta.needListSecrets || options.forceListSecrets === true) {
      listSecretsUsed = true;
      armPostCount += 1;
      listSecretsCount += 1;
      const listRes = await invokeReconcileHttp(httpRequest, {
        purpose: 'arm_list_secrets',
        protocol: 'https:',
        hostname: RECONCILE_LOCKS.managementHostname,
        port: 443,
        method: 'POST',
        path: buildLockedArmListSecretsPath(),
        headers: Object.freeze({
          Authorization: `Bearer ${armToken}`,
          'Content-Length': '0',
        }),
        body: '',
      });
      let listBody;
      try {
        listBody = JSON.parse(listRes.body);
      } catch (_) {
        return fail('list_secrets_json_invalid', 'listSecrets JSON invalid');
      }
      const parsed = parseListSecretsForRef(listBody, envRef.secretRefName);
      zeroListSecretsValues(listBody);
      if (parsed.ambiguous || !parsed.found) {
        parsed._appSecretValue = null;
        return fail(parsed.ambiguous ? 'secret_ref_ambiguous' : 'secret_ref_missing', 'listSecrets secretRef issue');
      }
      if (parsed.keyVaultUrl) appKeyVaultUrl = parsed.keyVaultUrl;
      if (parsed._appSecretValue) {
        appSecretValue = parsed._appSecretValue;
        secrets.push(appSecretValue);
      }
      parsed._appSecretValue = null;
    }

    vaultToken = await fetchImdsToken(httpRequest, 'imds_vault_token');
    secrets.push(vaultToken);
    const kvUrl = new URL(buildLockedKeyVaultSecretUrl());
    keyVaultRequestCount += 1;
    const kvRes = await invokeReconcileHttp(httpRequest, {
      purpose: 'keyvault_secret',
      protocol: 'https:',
      hostname: kvUrl.hostname,
      port: 443,
      method: 'GET',
      path: `${kvUrl.pathname}${kvUrl.search}`,
      headers: Object.freeze({ Authorization: `Bearer ${vaultToken}` }),
    });
    let kvBody;
    try {
      kvBody = JSON.parse(kvRes.body);
    } catch (_) {
      return fail('kv_json_invalid', 'Key Vault JSON invalid');
    }
    if (!kvBody || typeof kvBody.value !== 'string' || !kvBody.value) {
      return fail('kv_secret_missing', 'Key Vault secret value missing');
    }
    kvSecretValue = kvBody.value;
    secrets.push(kvSecretValue);
    try { kvBody.value = null; } catch (_) { /* ignore */ }

    let comparison;
    const appKvUrlMatch = Boolean(
      appKeyVaultUrl
      && normalizeKeyVaultSecretUrl(appKeyVaultUrl) === lockedKeyVaultSecretUrlNormalized(),
    );

    if (appSecretValue) {
      comparison = compareDsnAuthorityInMemory(appSecretValue, kvSecretValue);
    } else if (appKeyVaultUrl) {
      comparison = compareKeyVaultRefAuthority(appKeyVaultUrl, kvSecretValue);
    } else if (envRef.secretRefName === RECONCILE_LOCKS.secretName) {
      return fail('secret_ref_ambiguity', 'secretRef name matches but resolved authority unproven');
    } else {
      return fail('secret_ref_mismatch', 'cannot resolve app secret authority');
    }
    appSecretValue = null;

    if (comparison.sameTarget !== true) {
      kvSecretValue = null;
      const blockedDecision = decideReconcileStrategy(null, null, false);
      return pickSafe(redactDeep({
        ok: false,
        code: 'mismatched_app_kv_target',
        sameTarget: false,
        sameTargetReason: comparison.sameTargetReason,
        blocker: 'mismatched_app_kv_target',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        usedLiveHttp,
        realImdsCall: true,
        realArmCall: true,
        realKeyVaultCall: true,
        realPostgresCall: false,
        ...getReconcileDecisionCounters(),
        applicationName: APPLICATION_NAME,
        decision: blockedDecision,
        recommendation: blockedDecision.recommendation,
        occupancySummary: blockedDecision.occupancySummary,
        errors: comparison.errors || [],
        closed: true,
        committed: false,
        rolledBack: false,
      }, secrets));
    }

    if (options.skipPostgres === true) {
      kvSecretValue = null;
      armToken = null;
      vaultToken = null;
      return pickSafe({
        ok: true,
        code: 'same_target_authority_ok',
        sameTarget: true,
        sameTargetReason: comparison.sameTargetReason,
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        usedLiveHttp,
        realImdsCall: true,
        realArmCall: true,
        realKeyVaultCall: true,
        realPostgresCall: false,
        ...getReconcileDecisionCounters(),
        applicationName: APPLICATION_NAME,
        listSecretsUsed,
        appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
        activeRevisionName: rev.activeRevisionName,
        dbEnvName: envRef.dbEnvName,
        secretRefName: envRef.secretRefName,
        errors: [],
        closed: true,
        committed: false,
        rolledBack: false,
      });
    }

    if (!options.expectedContract || !options.expectedContract.snapshot) {
      kvSecretValue = null;
      return fail('expected_contract_required', 'expectedContract.snapshot required for PG session', {
        sameTarget: true,
      });
    }

    const creds = parseSunsetDatabaseUrlSecretInMemory(kvSecretValue);
    if (!creds.ok) {
      kvSecretValue = null;
      return fail('kv_target_invalid', 'KV DSN failed locked target parse', { sameTarget: true });
    }
    const user = creds._user;
    const password = creds._password;
    secrets.push(user, password);
    zeroPrivateCredentialRefs(creds);
    kvSecretValue = null;
    armToken = null;
    vaultToken = null;

    const ClientFactory = options.ClientFactory || Client;
    const cfg = buildLockedPgClientConfig(user, password);
    let _u = user;
    let _p = password;
    _u = null;
    _p = null;

    clientsInstantiated += 1;
    client = new ClientFactory(cfg);
    try {
      cfg.password = undefined;
      cfg.user = undefined;
    } catch (_) { /* ignore */ }

    closed = false;
    connectCalls += 1;
    await client.connect();
    queryCalls += 1;
    await client.query('BEGIN READ ONLY');

    const capture = await runReconcileCapture(client, options.expectedContract, ownershipIndex);

    if (!capture.sessionReadOnly || !capture.transactionReadOnly) {
      queryCalls += 1;
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
      return pickSafe({
        ok: false,
        code: 'session_not_read_only',
        sameTarget: true,
        blocker: 'session_not_read_only',
        liveMutation: false,
        schemaMutation: false,
        dataMutation: false,
        ledgerWritten: false,
        kvMutation: false,
        usedLiveHttp,
        realPostgresCall: true,
        ...getReconcileDecisionCounters(),
        applicationName: APPLICATION_NAME,
        schemaInventory: capture.schemaInventory,
        ledgerSummary: capture.ledgerSummary,
        occupancy: capture.occupancy,
        groupedDrift: capture.groupedDrift,
        decision: capture.decision,
        recommendation: capture.decision && capture.decision.recommendation,
        errors: [{ code: 'session_not_read_only', message: 'BEGIN READ ONLY session gate failed' }],
        closed: false,
        committed: false,
        rolledBack: true,
      });
    }

    queryCalls += 1;
    await client.query('COMMIT');
    committed = true;

    try {
      endCalls += 1;
      await client.end();
      closed = true;
      client = null;
    } catch (_) {
      closed = true;
      client = null;
    }

    return pickSafe({
      ok: true,
      code: 'reconcile_decision_captured',
      sameTarget: true,
      sameTargetReason: comparison.sameTargetReason,
      blocker: null,
      liveMutation: false,
      schemaMutation: false,
      dataMutation: false,
      ledgerWritten: false,
      kvMutation: false,
      rbacMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp,
      realImdsCall: true,
      realArmCall: true,
      realKeyVaultCall: true,
      realPostgresCall: true,
      ...getReconcileDecisionCounters(),
      applicationName: APPLICATION_NAME,
      activeRevisionName: rev.activeRevisionName,
      dbEnvName: envRef.dbEnvName,
      secretRefName: envRef.secretRefName,
      listSecretsUsed,
      appSecretKeyVaultUrlMatchesLocked: appKvUrlMatch,
      sessionReadOnly: true,
      transactionReadOnly: true,
      schemaInventory: capture.schemaInventory,
      ledgerSummary: capture.ledgerSummary,
      occupancy: capture.occupancy,
      groupedDrift: capture.groupedDrift,
      migrationOwnership: capture.groupedDrift
        ? capture.groupedDrift.migrationOwnershipByManifestEntry
        : null,
      decision: capture.decision,
      recommendation: capture.decision && capture.decision.recommendation,
      occupancySummary: capture.decision && capture.decision.occupancySummary,
      errors: [],
      closed: true,
      committed: true,
      rolledBack: false,
    });
  } catch (err) {
    const sanitized = sanitizeReconcileError(err, secrets);
    if (client && !closed) {
      try {
        await client.query('ROLLBACK');
        rolledBack = true;
      } catch (_) { /* ignore */ }
    }
    return fail(sanitized.code, sanitized.message);
  } finally {
    zeroPrivateCredentialRefs({
      _token: armToken,
      _accessToken: vaultToken,
      _secretValue: kvSecretValue,
      _dsn: appSecretValue,
    });
    armToken = null;
    vaultToken = null;
    kvSecretValue = null;
    appSecretValue = null;
    if (client && !closed) {
      try {
        endCalls += 1;
        await client.end();
        closed = true;
      } catch (_) {
        closed = true;
      }
    }
  }
}

function printCliHelp() {
  return [
    'phase-d:reconcile-decision — FOUNDATION Slice 14R',
    'DEFAULT: refused (zero ARM / zero KV / zero PostgreSQL).',
    '',
    'Prove read-only occupancy + drift grouping to choose clean rebuild vs in-place repair.',
    'Requires dual Phase D flags + SUNSET_PHASE_D_RECONCILE_DECISION=1 + managed-identity',
    'credential source + exact locked targets.',
    '',
    'One ARM GET + optional listSecrets POST + KV GET + one BEGIN READ ONLY pg session.',
    'Never prints/persists DSN, passwords, tokens, or secret versions.',
  ].join('\n');
}

module.exports = {
  PHASE_D_RECONCILE_DECISION_LIVE_ENABLED,
  ENV_RECONCILE_DECISION,
  CLI_PROVE_RECONCILE_DECISION,
  APPLICATION_NAME,
  RECONCILE_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  evaluateReconcileDecisionGates,
  exactReconcileDecisionArgv,
  reconcileDecisionEnv,
  parseArgvPairs,
  decideReconcileStrategy,
  buildMigrationOwnershipIndex,
  groupDrift,
  captureOccupancy,
  buildFutureRebuildCutoverPlan,
  buildOrderedReconciliationPhases,
  buildPhaseDriftCoverage,
  validateOrderedReconciliationPhases,
  buildDefectiveReconciliationPhases,
  reconcileCompletionAllowed,
  PHASE_SEQUENCE_IDS,
  NON_TABLE_SECTIONS,
  createInjectedReconcileDecisionHttp,
  createLiveReconcileDecisionHttpRequest,
  createScriptedReconcileDecisionFakeClientFactory,
  executeReconcileDecision,
  getReconcileDecisionCounters,
  resetReconcileDecisionCounters,
  printCliHelp,
  buildOfflineProofSunsetDatabaseUrl,
  buildLockedArmContainerAppPath,
  buildLockedArmListSecretsPath,
  buildLockedImdsArmTokenUrl,
  buildLockedKeyVaultSecretUrl,
};
