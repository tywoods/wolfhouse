'use strict';

/**
 * FOUNDATION Slice 14C — Phase D live read-only PostgreSQL adapter
 *
 * Real pg Client wiring behind the merged Slice 14B boundary. Builds client
 * config only from locked TARGETS + protected admin env credentials. Reuses
 * verified TLS (rejectUnauthorized + servername) and statement_timeout from
 * the observer client-config contract. Never accepts DSN, argv credentials,
 * or caller-supplied host/database/query values.
 *
 * Live execution remains hard-disabled
 * (PHASE_D_LIVE_READONLY_CONNECT_ENABLED=false). Offline proof injects a
 * scripted fake Client factory — default and live-disabled paths instantiate
 * zero Clients.
 */

const {
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  PHASE_D_LIVE_APPLY_ENABLED,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  SCHEMA,
  TABLE,
  OUTPUT_COUNT_KEYS,
  evaluateLiveReadonlyBoundary,
  resolveProtectedAdminCredentials,
  assertLockedConnectConfig,
  authorizeLiveReadonlySql,
  shapeCountOnlyResult,
  sanitizeError,
  redactDeep,
  redactSecrets,
  normalizeSql,
} = require('./phase-d-live-readonly-boundary');
const {
  REQUIRED_COLUMNS,
  EXPECTED_028_SHA256,
  assertMigration028ByteIntegrity,
  assertNoLiveApply,
} = require('./phase-d-check-preflight');

/** Same session timeouts as verified observer clientConfigFromDsn. */
const STATEMENT_TIMEOUT_MS = 30000;
const LOCK_TIMEOUT_MS = 5000;
const CONNECTION_TIMEOUT_MS = 20000;

/**
 * Exact authorized step order for the merged 14A count-only sequence
 * (COMMIT on success; ROLLBACK replaces COMMIT on failure).
 */
const AUTHORIZED_SEQUENCE = Object.freeze([
  'BEGIN READ ONLY',
  'SHOW transaction_read_only',
  'catalog_table',
  'catalog_columns',
  'aggregate',
  'COMMIT',
]);

const AUTHORIZED_SEQUENCE_ON_FAILURE = Object.freeze([
  'BEGIN READ ONLY',
  'SHOW transaction_read_only',
  'catalog_table',
  'catalog_columns',
  'aggregate',
  'ROLLBACK',
]);

/** Process-local counter — proves default/disabled paths create zero Clients. */
let pgClientInstantiateCount = 0;

function getPgClientInstantiateCount() {
  return pgClientInstantiateCount;
}

function resetPgClientInstantiateCount() {
  pgClientInstantiateCount = 0;
}

/**
 * Verified TLS for Azure Flexible Server FQDN — same contract as
 * sunset-schema-observer clientConfigFromDsn (rejectUnauthorized + servername).
 * System CA trust (ca-certificates) is relied on by rejectUnauthorized:true.
 */
function buildVerifiedTlsSslConfig() {
  return Object.freeze({
    rejectUnauthorized: true,
    servername: TARGETS.postgresHost,
  });
}

/**
 * Build pg Client config from a locked admin connect config only.
 * Host/database/port/ssl/application_name are never caller-supplied.
 * Never accepts connectionString / DSN fields.
 */
function buildLockedPgClientConfig(lockedConnectConfig, opts) {
  const options = opts || {};
  if (options.connectionString != null
    || options.dsn != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.port != null
    || options.sslmode != null
    || options.user != null
    || options.password != null
    || options.query != null
    || options.sql != null) {
    throw Object.assign(
      new Error('caller-supplied DSN / host / database / credentials / query forbidden'),
      { code: 'caller_supplied_connect_forbidden' },
    );
  }

  const gate = assertLockedConnectConfig(lockedConnectConfig);
  if (!gate.ok) {
    throw Object.assign(
      new Error('locked admin connect config rejected'),
      { code: 'credential_target_rejected', errors: gate.errors },
    );
  }

  const c = lockedConnectConfig;
  // Public fields only — never copy _user/_password into returned evidence.
  return {
    host: TARGETS.postgresHost,
    port: TARGETS.port,
    database: TARGETS.database,
    user: String(c._user),
    password: String(c._password),
    application_name: TARGETS.applicationName,
    options: [
      '-c default_transaction_read_only=on',
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
    ].join(' '),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    ssl: buildVerifiedTlsSslConfig(),
  };
}

/** Secret-free view of a client config (never user/password). */
function secretFreeClientConfigView(cfg) {
  const c = cfg || {};
  return {
    host: c.host,
    port: c.port,
    database: c.database,
    application_name: c.application_name,
    options: c.options,
    connectionTimeoutMillis: c.connectionTimeoutMillis,
    ssl: c.ssl
      ? {
        rejectUnauthorized: c.ssl.rejectUnauthorized === true,
        servername: c.ssl.servername,
      }
      : null,
    hasUser: Boolean(c.user),
    hasPassword: Boolean(c.password),
    hasConnectionString: false,
  };
}

function classifyAuthorizedStep(sql) {
  const auth = authorizeLiveReadonlySql(sql);
  if (auth.kind === 'session') {
    const n = normalizeSql(auth.sql);
    if (n === normalizeSql('BEGIN READ ONLY')) return 'BEGIN READ ONLY';
    if (n === normalizeSql('SHOW transaction_read_only')) return 'SHOW transaction_read_only';
    if (n === normalizeSql('COMMIT')) return 'COMMIT';
    if (n === normalizeSql('ROLLBACK')) return 'ROLLBACK';
  }
  if (auth.kind === 'catalog_table') return 'catalog_table';
  if (auth.kind === 'catalog_columns') return 'catalog_columns';
  if (auth.kind === 'aggregate') return 'aggregate';
  throw Object.assign(new Error('unauthorized SQL rejected'), { code: 'unauthorized_sql' });
}

/**
 * Authorize then query. Rejects wrong/extra SQL before the driver sees it.
 */
async function authorizedQuery(client, sql, params) {
  authorizeLiveReadonlySql(sql);
  if (params === undefined) return client.query(sql);
  return client.query(sql, params);
}

function validateCatalogColumns(rows) {
  const byName = new Map((rows || []).map((r) => [r.name, r]));
  for (const expected of REQUIRED_COLUMNS) {
    const row = byName.get(expected.name);
    if (!row) {
      throw Object.assign(
        new Error(`phase-d live readonly: missing column ${expected.name}`),
        { code: 'column_missing', column: expected.name },
      );
    }
    if (row.udt_name !== expected.udt) {
      throw Object.assign(
        new Error(
          `phase-d live readonly: column ${expected.name} incompatible type (udt=${row.udt_name})`,
        ),
        { code: 'column_type_mismatch', column: expected.name },
      );
    }
    if (Boolean(row.is_nullable) !== Boolean(expected.nullable)) {
      throw Object.assign(
        new Error(
          `phase-d live readonly: column ${expected.name} incompatible nullability`,
        ),
        { code: 'column_nullability_mismatch', column: expected.name },
      );
    }
  }
  return {
    ok: true,
    table: `${SCHEMA}.${TABLE}`,
    columns: REQUIRED_COLUMNS.map((c) => ({ ...c })),
  };
}

/**
 * Exact 14A sequence on an already-connected client:
 * BEGIN READ ONLY → SHOW transaction_read_only → catalog table → catalog
 * columns → exact aggregate → COMMIT (or ROLLBACK on failure).
 */
async function runAuthorizedReadOnlySequence(client, opts) {
  const options = opts || {};
  const secrets = (options.secrets || []).filter(Boolean);
  const steps = [];
  let began = false;
  let committed = false;
  let rolledBack = false;

  assertNoLiveApply();
  if (PHASE_D_LIVE_APPLY_ENABLED === true) {
    throw Object.assign(new Error('live apply must remain disabled'), {
      code: 'live_apply_forbidden',
    });
  }

  // Never accept caller SQL / host / database.
  if (options.sql != null
    || options.query != null
    || options.host != null
    || options.database != null
    || options.dsn != null
    || options.connectionString != null) {
    throw Object.assign(
      new Error('caller-supplied SQL / host / database / DSN forbidden'),
      { code: 'caller_supplied_query_forbidden' },
    );
  }

  const sha = assertMigration028ByteIntegrity();

  try {
    await authorizedQuery(client, 'BEGIN READ ONLY');
    began = true;
    steps.push('BEGIN READ ONLY');

    const tro = await authorizedQuery(client, 'SHOW transaction_read_only');
    steps.push('SHOW transaction_read_only');
    const flag = tro && tro.rows && tro.rows[0]
      ? String(tro.rows[0].transaction_read_only).toLowerCase()
      : '';
    if (flag !== 'on') {
      throw Object.assign(new Error('transaction is not read-only'), {
        code: 'not_read_only',
      });
    }

    const tableRes = await authorizedQuery(
      client,
      AUTHORIZED_TABLE_EXISTS_SQL,
      [SCHEMA, TABLE],
    );
    steps.push('catalog_table');
    if (!tableRes || tableRes.rowCount !== 1) {
      throw Object.assign(
        new Error('public.tenant_services table missing'),
        { code: 'table_missing' },
      );
    }

    const colRes = await authorizedQuery(
      client,
      AUTHORIZED_COLUMN_CATALOG_SQL,
      [SCHEMA, TABLE, REQUIRED_COLUMNS.map((c) => c.name)],
    );
    steps.push('catalog_columns');
    const schema = validateCatalogColumns(colRes.rows);

    const aggRes = await authorizedQuery(client, AUTHORIZED_AGGREGATE_SQL);
    steps.push('aggregate');
    if (!aggRes.rows || aggRes.rows.length !== 1) {
      throw Object.assign(new Error('aggregate must return exactly one row'), {
        code: 'aggregate_shape_error',
      });
    }
    const raw = aggRes.rows[0];
    const keys = Object.keys(raw).sort();
    const expectedKeys = OUTPUT_COUNT_KEYS.slice().sort();
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      throw Object.assign(new Error('unexpected aggregate columns'), {
        code: 'aggregate_column_leak',
      });
    }
    const counts = shapeCountOnlyResult(raw);

    await authorizedQuery(client, 'COMMIT');
    committed = true;
    steps.push('COMMIT');

    return redactDeep({
      ok: true,
      counts,
      schema,
      steps: steps.slice(),
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      migration028Sha256CanonicalLfV1: sha,
      outputKeys: OUTPUT_COUNT_KEYS.slice(),
      readOnly: true,
      mutates: false,
      appliesConstraints: false,
      writesLedger: false,
      liveApplyEnabled: false,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true,
      liveQueryExecution: false,
    }, secrets);
  } catch (e) {
    if (began && !committed) {
      try {
        await authorizedQuery(client, 'ROLLBACK');
        rolledBack = true;
        steps.push('ROLLBACK');
      } catch (_) {
        /* ignore rollback failure — still sanitize */
      }
    }
    const known = new Set([
      'unauthorized_sql',
      'caller_supplied_query_forbidden',
      'caller_supplied_connect_forbidden',
      'not_read_only',
      'table_missing',
      'column_missing',
      'column_type_mismatch',
      'column_nullability_mismatch',
      'aggregate_shape_error',
      'aggregate_column_leak',
      'invalid_aggregate_count',
      'output_shape_drift',
      'live_apply_forbidden',
      'migration_028_checksum_mismatch',
      'live_readonly_connect_disabled',
      'live_readonly_flags_required',
      'credential_source_rejected',
      'connect_failed',
      'query_failed',
      'commit_failed',
      'close_failed',
    ]);
    let err = e;
    if (!(e && e.code && known.has(e.code))) {
      err = sanitizeError(e, (e && e.code) || 'query_failed');
    }
    const safe = redactDeep({
      ok: false,
      code: err.code || 'query_failed',
      message: redactSecrets(String(err.message || 'phase-d pg adapter failed'), secrets),
      steps: steps.slice(),
      rolledBack,
      committed: false,
      mutates: false,
      appliesConstraints: false,
      writesLedger: false,
      liveApplyEnabled: false,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true,
      liveQueryExecution: false,
    }, secrets);
    const wrapped = Object.assign(new Error(safe.message), {
      code: safe.code,
      result: safe,
    });
    throw wrapped;
  }
}

/**
 * Instantiate a pg Client only after config is locked.
 * deps.Client may be injected for offline proof; real require('pg') is used
 * only when live connect is enabled (still false in Slice 14C).
 */
function instantiatePgClient(clientConfig, deps) {
  const d = deps || {};
  pgClientInstantiateCount += 1;
  let ClientCtor = d.Client;
  if (!ClientCtor) {
    if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true) {
      // Should never reach here on the live-disabled path without injection.
      throw Object.assign(
        new Error(
          'live pg Client instantiation hard-disabled (PHASE_D_LIVE_READONLY_CONNECT_ENABLED=false)',
        ),
        { code: 'live_readonly_connect_disabled' },
      );
    }
    // Live path reserved — still gated by PHASE_D_LIVE_READONLY_CONNECT_ENABLED.
    // eslint-disable-next-line global-require
    ClientCtor = require('pg').Client;
  }
  return new ClientCtor(clientConfig);
}

async function closeClientQuietly(client, secrets) {
  if (!client || typeof client.end !== 'function') {
    return { closed: false, closeError: null, attempted: false };
  }
  try {
    await client.end();
    return { closed: true, closeError: null, attempted: true };
  } catch (e) {
    return {
      closed: false,
      attempted: true,
      closeError: redactSecrets(
        String((e && e.message) || e || 'close failed').slice(0, 240),
        secrets || [],
      ),
    };
  }
}

/**
 * Apply fail-closed close semantics onto an adapter outcome.
 * - Primary close failure (otherwise ok): ok:false, code close_failed, closed:false.
 * - Secondary close failure: retain primary code; set closeFailure=true + closeError.
 * Never claims a successful completed adapter run when end/close failed.
 */
function applyCloseOutcome(outcome, closeMeta) {
  const next = outcome || {};
  next.closed = closeMeta && closeMeta.closed === true;
  if (!(closeMeta && closeMeta.closeError)) {
    next.closeError = null;
    return next;
  }

  const sanitized = closeMeta.closeError;
  next.closed = false;
  next.closeError = sanitized;

  if (next.ok === true) {
    // Preserve count-only data (counts/schema/steps) when the sequence completed,
    // but never claim a successful completed adapter run.
    next.ok = false;
    next.code = 'close_failed';
    next.message = sanitized;
  } else {
    // Do not mask an earlier primary connect/query/commit error.
    next.closeFailure = true;
  }
  return next;
}

/**
 * Full adapter entry: 14B gates → build locked client config → instantiate
 * Client → connect → exact sequence → close in finally.
 *
 * Live path refuses while PHASE_D_LIVE_READONLY_CONNECT_ENABLED is false
 * unless opts.Client is provided for offline proof (never opens network).
 */
async function executePhaseDLiveReadonlyPgAdapter(opts) {
  const options = opts || {};
  const secrets = [];
  let client = null;
  let closeMeta = { closed: false, closeError: null, attempted: false };
  let closeAttempted = false;
  const counters = {
    clientsInstantiated: 0,
    connectCalls: 0,
    queryCalls: 0,
    endCalls: 0,
  };

  assertNoLiveApply();

  // Hard refuse caller DSN / host / database / query at the outer boundary.
  if (options.dsn != null
    || options.connectionString != null
    || options.databaseUrl != null
    || options.host != null
    || options.database != null
    || options.sql != null
    || options.query != null) {
    return redactDeep({
      ok: false,
      code: 'caller_supplied_connect_forbidden',
      errors: [{
        code: 'caller_supplied_connect_forbidden',
        message: 'DSN / host / database / query must not be caller-supplied',
      }],
      counters,
      clientsInstantiated: getPgClientInstantiateCount(),
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
    }, []);
  }

  const boundary = await evaluateLiveReadonlyBoundary({
    env: options.env,
    argv: options.argv || ['node', 'phase-d-live-readonly-pg-adapter'],
    targets: options.targets || TARGETS,
    azureAdapters: options.azureAdapters,
    dbAdapters: options.dbAdapters,
    plannedCommands: options.plannedCommands,
  });

  if (!boundary.ok || !boundary.accepted) {
    return redactDeep({
      ok: false,
      code: boundary.code || 'live_readonly_boundary_rejected',
      errors: boundary.errors || [],
      counters: {
        ...counters,
        azureCalls: boundary.counters ? boundary.counters.azureCalls : 0,
        connectInfoCalls: boundary.counters ? boundary.counters.connectInfoCalls : 0,
      },
      clientsInstantiated: 0,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true,
      liveQueryExecution: false,
      liveMutation: false,
      note: '14B gates failed — zero pg Clients instantiated',
    }, []);
  }

  // Live connect still hard-disabled: without an injected Client factory,
  // instantiate zero Clients even when the exact target was accepted.
  const offlineProofClient = typeof options.Client === 'function';
  if (PHASE_D_LIVE_READONLY_CONNECT_ENABLED !== true && !offlineProofClient) {
    return redactDeep({
      ok: true,
      accepted: true,
      code: 'target_accepted_pg_adapter_hard_disabled',
      counters: {
        ...counters,
        azureCalls: boundary.counters ? boundary.counters.azureCalls : 0,
        connectInfoCalls: boundary.counters ? boundary.counters.connectInfoCalls : 0,
      },
      clientsInstantiated: 0,
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
      appliesConstraints: false,
      writesLedger: false,
      note: 'Exact target accepted; Slice 14C pg adapter remains hard-disabled (no Client)',
    }, []);
  }

  const creds = resolveProtectedAdminCredentials({
    env: options.env,
    argv: options.argv || ['node', 'phase-d-live-readonly-pg-adapter'],
  });
  if (!creds.ok) {
    return redactDeep({
      ok: false,
      code: 'credential_source_rejected',
      errors: creds.errors,
      counters,
      clientsInstantiated: 0,
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
    }, []);
  }
  secrets.push(creds._user, creds._password);

  let clientConfig;
  try {
    clientConfig = buildLockedPgClientConfig(creds._connectConfig);
  } catch (e) {
    return redactDeep({
      ok: false,
      code: e.code || 'credential_target_rejected',
      errors: e.errors || [{ code: e.code, message: e.message }],
      counters,
      clientsInstantiated: 0,
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
    }, secrets);
  }

  const before = getPgClientInstantiateCount();
  let outcome;
  try {
    client = instantiatePgClient(clientConfig, { Client: options.Client });
    counters.clientsInstantiated = getPgClientInstantiateCount() - before;

    try {
      counters.connectCalls += 1;
      await client.connect();
    } catch (e) {
      const msg = redactSecrets(
        String((e && e.message) || e || 'connect failed').slice(0, 240),
        secrets,
      );
      throw Object.assign(new Error(msg), { code: 'connect_failed' });
    }

    let sequence;
    try {
      sequence = await runAuthorizedReadOnlySequence(client, { secrets });
    } catch (e) {
      // runAuthorizedReadOnlySequence already sanitized; rethrow with code.
      if (e && e.result) throw e;
      const msg = redactSecrets(
        String((e && e.message) || e || 'query failed').slice(0, 240),
        secrets,
      );
      throw Object.assign(new Error(msg), {
        code: (e && e.code) || 'query_failed',
      });
    }

    outcome = {
      ok: true,
      accepted: true,
      code: 'phase_d_live_readonly_pg_sequence_ok',
      counts: sequence.counts,
      schema: sequence.schema,
      steps: sequence.steps,
      authorizedSequence: AUTHORIZED_SEQUENCE.slice(),
      clientConfig: secretFreeClientConfigView(clientConfig),
      counters: {
        ...counters,
        azureCalls: boundary.counters ? boundary.counters.azureCalls : 0,
        connectInfoCalls: boundary.counters ? boundary.counters.connectInfoCalls : 0,
      },
      clientsInstantiated: counters.clientsInstantiated,
      liveReadonlyConnectEnabled: PHASE_D_LIVE_READONLY_CONNECT_ENABLED === true,
      liveQueryExecution: false,
      liveMutation: false,
      appliesConstraints: false,
      writesLedger: false,
      migration028Sha256CanonicalLfV1: sequence.migration028Sha256CanonicalLfV1,
      outputKeys: OUTPUT_COUNT_KEYS.slice(),
      offlineProof: offlineProofClient,
    };
  } catch (e) {
    const code = (e && e.code) || (e && e.result && e.result.code) || 'query_failed';
    const result = e && e.result ? e.result : null;
    outcome = {
      ok: false,
      code,
      message: redactSecrets(String((e && e.message) || 'adapter failed'), secrets),
      steps: result ? result.steps : [],
      rolledBack: result ? result.rolledBack : false,
      counters: {
        ...counters,
        azureCalls: boundary.counters ? boundary.counters.azureCalls : 0,
        connectInfoCalls: boundary.counters ? boundary.counters.connectInfoCalls : 0,
      },
      clientsInstantiated: counters.clientsInstantiated,
      clientConfig: secretFreeClientConfigView(clientConfig),
      liveReadonlyConnectEnabled: false,
      liveQueryExecution: false,
      liveMutation: false,
      appliesConstraints: false,
      writesLedger: false,
    };
  } finally {
    // Close exactly once after connect success/failure and query success/failure.
    if (!closeAttempted) {
      closeAttempted = true;
      closeMeta = await closeClientQuietly(client, secrets);
      if (closeMeta.attempted) {
        counters.endCalls += 1;
      }
    }
  }

  outcome = applyCloseOutcome(outcome, closeMeta);
  outcome.counters = {
    ...(outcome.counters || {}),
    endCalls: counters.endCalls,
    connectCalls: counters.connectCalls,
    clientsInstantiated: counters.clientsInstantiated,
  };
  return redactDeep(outcome, secrets);
}

/**
 * Default operator path: process.env, no Client injection → zero Clients
 * when flags unset or live-disabled.
 */
async function defaultPhaseDLiveReadonlyPgAdapterPath(opts) {
  return executePhaseDLiveReadonlyPgAdapter({
    ...(opts || {}),
    env: (opts && opts.env) || process.env,
    argv: (opts && opts.argv) || process.argv.slice(0, 2),
  });
}

/**
 * Scripted fake pg Client for offline Slice 14C proof.
 * Enforces exact SQL sequence when strictSequence is true (default).
 */
function createScriptedFakePgClient(script) {
  const s = script || {};
  const expected = (s.expectedSteps || AUTHORIZED_SEQUENCE).slice();
  const calls = [];
  let stepIndex = 0;
  let connected = false;
  let ended = false;
  const responses = s.responses || {};

  function nextExpected() {
    return expected[stepIndex] || null;
  }

  const client = {
    calls,
    get connected() { return connected; },
    get ended() { return ended; },
    get stepIndex() { return stepIndex; },
    async connect() {
      calls.push({ method: 'connect' });
      if (s.connectError) {
        const err = s.connectError instanceof Error
          ? s.connectError
          : Object.assign(new Error(String(s.connectError)), { code: 'connect_failed' });
        throw err;
      }
      connected = true;
    },
    async query(sql, params) {
      calls.push({
        method: 'query',
        sql: String(sql),
        params: params === undefined ? null : params,
      });
      if (!connected) {
        throw Object.assign(new Error('not connected'), { code: 'query_failed' });
      }
      if (ended) {
        throw Object.assign(new Error('client ended'), { code: 'query_failed' });
      }

      const kind = classifyAuthorizedStep(sql);

      if (s.strictSequence !== false) {
        const exp = nextExpected();
        // ROLLBACK may replace COMMIT (commit failure) or follow a mid-sequence error.
        if (kind === 'ROLLBACK') {
          if (exp === 'COMMIT') stepIndex += 1;
        } else if (kind !== exp) {
          throw Object.assign(
            new Error(
              `wrong/reordered/extra SQL rejected: got ${kind}, expected ${exp}`,
            ),
            { code: 'unauthorized_sql' },
          );
        } else {
          stepIndex += 1;
        }
      }

      if (s.queryErrorAt && s.queryErrorAt[kind]) {
        const qe = s.queryErrorAt[kind];
        throw qe instanceof Error
          ? qe
          : Object.assign(new Error(String(qe)), { code: 'query_failed' });
      }
      if (s.commitError && kind === 'COMMIT') {
        throw s.commitError instanceof Error
          ? s.commitError
          : Object.assign(new Error(String(s.commitError)), { code: 'commit_failed' });
      }

      if (kind === 'BEGIN READ ONLY' || kind === 'COMMIT' || kind === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (kind === 'SHOW transaction_read_only') {
        return responses.showReadOnly || {
          rows: [{ transaction_read_only: 'on' }],
          rowCount: 1,
        };
      }
      if (kind === 'catalog_table') {
        return responses.catalogTable || { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (kind === 'catalog_columns') {
        return responses.catalogColumns || {
          rows: REQUIRED_COLUMNS.map((c) => ({
            name: c.name,
            udt_name: c.udt,
            is_nullable: c.nullable,
          })),
          rowCount: REQUIRED_COLUMNS.length,
        };
      }
      if (kind === 'aggregate') {
        return responses.aggregate || {
          rows: [{
            total_rows: 3,
            date_window_violations: 1,
            price_unit_violations: 0,
          }],
          rowCount: 1,
        };
      }
      throw Object.assign(new Error('unauthorized SQL rejected'), {
        code: 'unauthorized_sql',
      });
    },
    async end() {
      calls.push({ method: 'end' });
      if (s.closeError) {
        ended = true;
        throw s.closeError instanceof Error
          ? s.closeError
          : Object.assign(new Error(String(s.closeError)), { code: 'close_failed' });
      }
      ended = true;
      connected = false;
    },
  };

  // Never expose password via util.inspect defaults.
  Object.defineProperty(client, 'password', {
    enumerable: false,
    configurable: true,
    writable: true,
    value: undefined,
  });

  return client;
}

/**
 * Fake Client constructor that records configs (secret-free) and returns
 * scripted instances. Used as `options.Client` for offline proof.
 */
function createScriptedFakePgClientFactory(script) {
  const s = script || {};
  const instances = [];
  function FakeClient(config) {
    // Capture secret-free view only — never retain raw password on the factory log.
    const safeView = secretFreeClientConfigView(config);
    const instance = createScriptedFakePgClient(s);
    instance._safeConfig = safeView;
    // Ensure raw password from driver config is not enumerable on the instance.
    if (config && config.password) {
      Object.defineProperty(instance, '_redactedPasswordPresent', {
        value: true,
        enumerable: false,
      });
    }
    instances.push(instance);
    return instance;
  }
  FakeClient.instances = instances;
  FakeClient.reset = () => { instances.length = 0; };
  return FakeClient;
}

module.exports = {
  STATEMENT_TIMEOUT_MS,
  LOCK_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  AUTHORIZED_SEQUENCE,
  AUTHORIZED_SEQUENCE_ON_FAILURE,
  buildVerifiedTlsSslConfig,
  buildLockedPgClientConfig,
  secretFreeClientConfigView,
  classifyAuthorizedStep,
  authorizedQuery,
  runAuthorizedReadOnlySequence,
  instantiatePgClient,
  closeClientQuietly,
  applyCloseOutcome,
  executePhaseDLiveReadonlyPgAdapter,
  defaultPhaseDLiveReadonlyPgAdapterPath,
  createScriptedFakePgClient,
  createScriptedFakePgClientFactory,
  getPgClientInstantiateCount,
  resetPgClientInstantiateCount,
  AUTHORIZED_AGGREGATE_SQL,
  AUTHORIZED_TABLE_EXISTS_SQL,
  AUTHORIZED_COLUMN_CATALOG_SQL,
  REQUIRED_COLUMNS,
  OUTPUT_COUNT_KEYS,
  TARGETS,
  PHASE_D_LIVE_READONLY_CONNECT_ENABLED,
  EXPECTED_028_SHA256,
};
