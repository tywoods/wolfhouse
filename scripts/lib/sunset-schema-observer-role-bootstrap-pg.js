'use strict';

/**
 * Transactional observer-role bootstrap (CREATE + GRANT CONNECT + ALTER readonly).
 * Used by live container worker path and injected RED→GREEN tests.
 *
 * PostgreSQL supports these role ops inside an explicit transaction; on any error
 * we ROLLBACK and prove the role does not remain. Never DROP OWNED / broad cleanup.
 * Never returns password-bearing SQL.
 */

const {
  TARGETS,
  redactSecrets,
  rollbackNewlyCreatedObserverRole,
} = require('./sunset-schema-observer-role-provision');

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildCreateRoleSqlText(password, targets) {
  const t = targets || TARGETS;
  return (
    `CREATE ROLE ${t.roleName} LOGIN PASSWORD ${sqlStringLiteral(password)}`
    + ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'
  );
}

/**
 * @param {object} client - { query(sql, params?) }
 * @param {object} options
 * @param {string} options.password
 * @param {object} [options.targets]
 * @param {'create'|'grant'|null} [options.injectFailAfter] - test hook only
 * @returns {Promise<object>} secret-free progress result
 */
async function bootstrapCreateTransactional(client, options) {
  const opts = options || {};
  const t = opts.targets || TARGETS;
  const password = String(opts.password || '');
  const progress = {
    ok: false,
    transactional: true,
    createSucceeded: false,
    grantSucceeded: false,
    alterSucceeded: false,
    committed: false,
    rolledBack: false,
    roleRemains: null,
    hasConnect: null,
    hasReadonlySetting: null,
    failedStep: null,
    error: null,
  };

  if (!password || !/^[A-Za-z0-9_-]{40,128}$/.test(password)) {
    progress.failedStep = 'password';
    progress.error = 'password_format_invalid';
    return progress;
  }

  const createSql = buildCreateRoleSqlText(password, t);
  const grantSql = `GRANT CONNECT ON DATABASE ${t.database} TO ${t.roleName}`;
  const alterSql = `ALTER ROLE ${t.roleName} SET default_transaction_read_only = on`;

  try {
    await client.query('BEGIN');
    await client.query(createSql);
    progress.createSucceeded = true;

    if (opts.injectFailAfter === 'create') {
      throw Object.assign(new Error('injected_fail_after_create'), { code: 'injected_fail_after_create' });
    }

    await client.query(grantSql);
    progress.grantSucceeded = true;

    if (opts.injectFailAfter === 'grant') {
      throw Object.assign(new Error('injected_fail_after_grant'), { code: 'injected_fail_after_grant' });
    }

    await client.query(alterSql);
    progress.alterSucceeded = true;

    await client.query('COMMIT');
    progress.committed = true;
    progress.ok = true;
    progress.roleRemains = true;
    progress.hasConnect = true;
    progress.hasReadonlySetting = true;
    return progress;
  } catch (err) {
    progress.failedStep = progress.alterSucceeded
      ? 'commit'
      : (progress.grantSucceeded ? 'alter' : (progress.createSucceeded ? 'grant' : 'create'));
    progress.error = redactSecrets(String(err && err.message ? err.message : err), [password]);
    try {
      await client.query('ROLLBACK');
      progress.rolledBack = true;
    } catch (rbErr) {
      progress.rolledBack = false;
      progress.error = redactSecrets(
        `${progress.error}; rollback_failed:${String(rbErr && rbErr.message ? rbErr.message : rbErr)}`,
        [password],
      );
    }

    const proof = await proveRoleAbsent(client, t);
    progress.roleRemains = proof.roleRemains;
    progress.hasConnect = proof.hasConnect;
    progress.hasReadonlySetting = proof.hasReadonlySetting;
    progress.ok = false;
    return progress;
  }
}

async function proveRoleAbsent(client, targets) {
  const t = targets || TARGETS;
  const existsR = await client.query('SELECT 1 AS ok FROM pg_roles WHERE rolname=$1', [t.roleName]);
  const roleRemains = Boolean(existsR && (existsR.rowCount > 0 || (existsR.rows && existsR.rows.length)));
  if (!roleRemains) {
    return { roleRemains: false, hasConnect: false, hasReadonlySetting: false };
  }
  let hasConnect = false;
  let hasReadonlySetting = false;
  try {
    const c = await client.query(
      'SELECT has_database_privilege($1,$2,\'CONNECT\') AS c',
      [t.roleName, t.database],
    );
    hasConnect = Boolean(c.rows && c.rows[0] && c.rows[0].c === true);
  } catch (_) {
    hasConnect = null;
  }
  try {
    const s = await client.query(
      'SELECT unnest(COALESCE(rolconfig,ARRAY[]::text[])) AS cfg FROM pg_roles WHERE rolname=$1',
      [t.roleName],
    );
    for (const row of (s.rows || [])) {
      const cfg = String(row.cfg || '');
      if (cfg.toLowerCase().startsWith('default_transaction_read_only=')) {
        hasReadonlySetting = true;
      }
    }
  } catch (_) {
    hasReadonlySetting = null;
  }
  return { roleRemains: true, hasConnect, hasReadonlySetting };
}

/**
 * In-memory transactional client for RED→GREEN partial-bootstrap tests.
 * @param {object} options
 * @param {'create'|'grant'|null} [options.injectFailAfter]
 */
function createSimulatedBootstrapClient(options) {
  const opts = options || {};
  const state = {
    inTx: false,
    snap: null,
    roles: new Map(), // rolname -> { hasConnect, readonly }
  };

  function cloneRoles() {
    const m = new Map();
    for (const [k, v] of state.roles.entries()) {
      m.set(k, { hasConnect: v.hasConnect, readonly: v.readonly });
    }
    return m;
  }

  return {
    state,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN') {
        state.inTx = true;
        state.snap = cloneRoles();
        return { rowCount: 0, rows: [] };
      }
      if (s === 'COMMIT') {
        state.inTx = false;
        state.snap = null;
        return { rowCount: 0, rows: [] };
      }
      if (s === 'ROLLBACK') {
        if (state.snap) state.roles = state.snap;
        state.inTx = false;
        state.snap = null;
        return { rowCount: 0, rows: [] };
      }
      if (/^CREATE ROLE\s+(\w+)/i.test(s)) {
        const role = RegExp.$1;
        if (state.roles.has(role)) throw new Error(`role "${role}" already exists`);
        state.roles.set(role, { hasConnect: false, readonly: false });
        if (opts.injectFailAfter === 'create') {
          // Failure is injected by bootstrapCreateTransactional after CREATE returns.
        }
        return { rowCount: 0, rows: [] };
      }
      if (/^GRANT CONNECT ON DATABASE\s+(\w+)\s+TO\s+(\w+)/i.test(s)) {
        const db = RegExp.$1;
        const role = RegExp.$2;
        void db;
        if (!state.roles.has(role)) throw new Error(`role "${role}" does not exist`);
        state.roles.get(role).hasConnect = true;
        return { rowCount: 0, rows: [] };
      }
      if (/^ALTER ROLE\s+(\w+)\s+SET default_transaction_read_only\s*=\s*on/i.test(s)) {
        const role = RegExp.$1;
        if (!state.roles.has(role)) throw new Error(`role "${role}" does not exist`);
        state.roles.get(role).readonly = true;
        return { rowCount: 0, rows: [] };
      }
      if (/^SELECT 1 AS ok FROM pg_roles WHERE rolname=\$1/i.test(s)) {
        const role = params && params[0];
        const ok = state.roles.has(role);
        return { rowCount: ok ? 1 : 0, rows: ok ? [{ ok: 1 }] : [] };
      }
      if (/has_database_privilege/i.test(s)) {
        const role = params && params[0];
        const r = state.roles.get(role);
        return { rowCount: 1, rows: [{ c: Boolean(r && r.hasConnect) }] };
      }
      if (/unnest\(COALESCE\(rolconfig/i.test(s)) {
        const role = params && params[0];
        const r = state.roles.get(role);
        const rows = r && r.readonly
          ? [{ cfg: 'default_transaction_read_only=on' }]
          : [];
        return { rowCount: rows.length, rows };
      }
      if (/^REVOKE CONNECT/i.test(s)) {
        const m = s.match(/FROM\s+(\w+)/i);
        const role = m && m[1];
        if (!state.roles.has(role)) throw new Error(`role "${role}" does not exist`);
        state.roles.get(role).hasConnect = false;
        return { rowCount: 0, rows: [] };
      }
      if (/^ALTER ROLE\s+(\w+)\s+RESET default_transaction_read_only/i.test(s)) {
        const role = RegExp.$1;
        if (!state.roles.has(role)) throw new Error(`role "${role}" does not exist`);
        state.roles.get(role).readonly = false;
        return { rowCount: 0, rows: [] };
      }
      if (/^DROP ROLE\s+(\w+)/i.test(s)) {
        const role = RegExp.$1;
        if (!state.roles.has(role)) throw new Error(`role "${role}" does not exist`);
        const r = state.roles.get(role);
        if (r.hasConnect || r.readonly) {
          throw Object.assign(new Error('cannot drop role: still has privileges or settings'), {
            code: 'dependent_objects',
          });
        }
        state.roles.delete(role);
        return { rowCount: 0, rows: [] };
      }
      if (/DROP OWNED|PASSWORD/i.test(s)) {
        throw new Error(`forbidden SQL in sim: ${s.slice(0, 60)}`);
      }
      throw new Error(`unhandled sim SQL: ${s.slice(0, 80)}`);
    },
  };
}

/**
 * Adapter-boundary handler: if worker reported createSucceeded with role still present
 * (non-transactional fallback), run ordered narrow rollback. Never DROP OWNED.
 */
async function handleBootstrapCreateResult(result, deps) {
  const r = result || {};
  const runExec = deps && deps.postgresExec;
  const rollbackFn = (deps && deps.rollbackNewlyCreatedObserverRole) || rollbackNewlyCreatedObserverRole;
  const targets = (deps && deps.targets) || TARGETS;
  const counters = (deps && deps.counters) || null;
  const kvSetCalls = (deps && deps.kvSetCalls) || null;

  if (r.ok === true && r.committed === true) {
    return { ok: true, result: r, rolledBack: false, secretWritten: false };
  }

  let rolledBack = Boolean(r.rolledBack && r.roleRemains === false);
  let rollback = null;

  if (r.createSucceeded && r.roleRemains) {
    if (typeof runExec !== 'function') {
      throw Object.assign(
        new Error('bootstrap partial create left role but no postgresExec for rollback'),
        { code: 'bootstrap_partial_no_rollback_adapter' },
      );
    }
    rollback = await rollbackFn(runExec, targets, counters);
    rolledBack = Boolean(rollback && rollback.ok);
  }

  const clean = r.roleRemains === false
    || (rolledBack && rollback && rollback.ok);

  if (kvSetCalls && kvSetCalls.length) {
    throw Object.assign(new Error('observer secret must not be written after bootstrap failure'), {
      code: 'secret_written_after_bootstrap_failure',
    });
  }

  const err = Object.assign(
    new Error(redactSecrets(r.error || 'bootstrap_create failed', [])),
    {
      code: clean ? 'bootstrap_create_failed_clean' : 'bootstrap_create_failed_dirty',
      createSucceeded: Boolean(r.createSucceeded),
      roleRemains: Boolean(r.roleRemains),
      rolledBack,
      failedStep: r.failedStep || null,
      transactional: Boolean(r.transactional),
    },
  );
  throw err;
}

module.exports = {
  bootstrapCreateTransactional,
  proveRoleAbsent,
  createSimulatedBootstrapClient,
  handleBootstrapCreateResult,
  buildCreateRoleSqlText,
  sqlStringLiteral,
};
