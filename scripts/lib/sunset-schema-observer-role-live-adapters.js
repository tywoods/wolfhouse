'use strict';

/**
 * Live Azure / PostgreSQL / Key Vault adapters for Sunset schema-observer
 * role provision (FOUNDATION Slice 9).
 *
 * Fail-closed to locked TARGETS only. Never prints credentials or DSN values.
 * Never mutates firewall/network, schema/data, images, or Container Apps jobs.
 */

const { execSync } = require('child_process');
const {
  TARGETS,
  ENV_PG_ADMIN_USER,
  ENV_PG_ADMIN_PASSWORD,
  ALLOWED_GRANTS,
  assertRoleAuthorityContract,
  assertObserverDsnShape,
  redactSecrets,
  writeKeyVaultSecretSecure,
  REDACTED,
  rollbackNewlyCreatedObserverRole,
} = require('./sunset-schema-observer-role-provision');
const { parseDatabaseUrl: parseDsn } = require('./sunset-schema-observer');
const {
  TEMP_BOOTSTRAP_SECRET,
  runContainerWorker,
  secretIsActive,
} = require('./sunset-schema-observer-role-container-pg');
const {
  handleBootstrapCreateResult,
} = require('./sunset-schema-observer-role-bootstrap-pg');

/** Process-local proof that container reached sunset_staging (avoids extra execs). */
let connectedDbProof = null;
/** True after bootstrap_create bundled CREATE+GRANT+ALTER in this process. */
let bootstrapCreateFlushed = false;

function azPath() {
  if (process.platform === 'win32') {
    return '"C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd"';
  }
  return 'az';
}

function shellQuote(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function azArgsToString(args) {
  if (typeof args === 'string') return args;
  return (args || []).map(shellQuote).join(' ');
}

function azJson(args, opts) {
  const options = opts || {};
  const argStr = azArgsToString(args);
  const low = String(argStr).toLowerCase();
  const forbid = options.allowSecretSet === true
    ? []
    : ['keyvault secret set', 'keyvault secret delete', 'firewall-rule', 'deployment group create', 'group delete'];
  for (const bad of forbid) {
    if (low.includes(bad)) {
      throw Object.assign(new Error(`refusing az invocation: ${bad}`), { code: 'forbidden_az' });
    }
  }
  let out;
  try {
    out = execSync(`${azPath()} ${argStr}`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const errText = redactSecrets(
      String((err && err.stderr) || (err && err.message) || 'az failed').slice(0, 400),
      options.secrets || [],
    );
    throw Object.assign(new Error(errText), { code: 'az_failed' });
  }
  const s = String(out || '').replace(/^\uFEFF/, '').trim();
  if (options.rawStdout) return s;
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) {
    if (options.allowEmpty) return null;
    throw Object.assign(new Error('az returned no JSON'), { code: 'az_no_json' });
  }
  return JSON.parse(s.slice(i));
}

function requireAdminEnv(env) {
  const e = env || process.env;
  // Admin env still required as operator attestation even though PG runs in-container
  // via WOLFHOUSE_DATABASE_URL. Values must be set (loaded from sunset-database-url).
  const user = String(e[ENV_PG_ADMIN_USER] || '');
  const password = String(e[ENV_PG_ADMIN_PASSWORD] || '');
  if (!user || !password) {
    throw Object.assign(
      new Error(`${ENV_PG_ADMIN_USER} and ${ENV_PG_ADMIN_PASSWORD} required`),
      { code: 'missing_pg_admin_env' },
    );
  }
  return { user, password };
}

function createLiveAzureAdapters() {
  return {
    async getAccount() {
      const a = azJson(['account', 'show', '-o', 'json']);
      return { id: a.id, subscriptionId: a.id, name: a.name };
    },
    async getResourceGroup(name, subscriptionId) {
      const g = azJson([
        'group', 'show', '-n', name, '--subscription', subscriptionId, '-o', 'json',
      ]);
      return { name: g.name };
    },
    async getPostgresServer(rg, name, subscriptionId) {
      const p = azJson([
        'postgres', 'flexible-server', 'show',
        '-g', rg, '-n', name, '--subscription', subscriptionId, '-o', 'json',
      ]);
      return {
        name: p.name,
        fullyQualifiedDomainName: p.fullyQualifiedDomainName,
        administratorLogin: p.administratorLogin,
      };
    },
    async getKeyVault(rg, name, subscriptionId) {
      const k = azJson([
        'keyvault', 'show', '-g', rg, '-n', name, '--subscription', subscriptionId, '-o', 'json',
      ]);
      return { name: k.name };
    },
  };
}

function createLiveDbAdapters() {
  return {
    async connectInfo() {
      return { host: TARGETS.postgresHost, sslmode: 'verify-full' };
    },
    async query() {
      if (connectedDbProof && connectedDbProof.db === TARGETS.database) {
        return { db: connectedDbProof.db };
      }
      const r = runContainerWorker('ping');
      if (!r || r.ok === false) {
        throw Object.assign(new Error((r && r.error) || 'db ping failed'), { code: 'db_ping_failed' });
      }
      connectedDbProof = { db: r.db, host: r.host };
      return { db: r.db };
    },
  };
}

async function inspectPgViaContainer() {
  const pg = runContainerWorker('inspect');
  if (!pg || pg.error) {
    throw Object.assign(new Error((pg && pg.error) || 'inspect failed'), { code: 'inspect_failed' });
  }
  if (pg.roleExists != null) {
    connectedDbProof = { db: TARGETS.database, host: TARGETS.postgresHost };
  }
  return pg;
}

async function inspectRoleAndSecret(env) {
  void env;
  const pg = await inspectPgViaContainer();

  let secretExists = false;
  let secretValid = false;
  try {
    const show = azJson([
      'keyvault', 'secret', 'show',
      '--vault-name', TARGETS.keyVault,
      '--name', TARGETS.secretName,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ]);
    secretExists = Boolean(show && show.name === TARGETS.secretName);
    const value = show && show.value != null ? String(show.value) : '';
    const shape = assertObserverDsnShape(value);
    const parsed = parseDsn(value);
    secretValid = secretExists
      && shape.ok
      && parsed.ok
      && parsed.parsed.user === TARGETS.roleName
      && parsed.parsed.host === TARGETS.postgresHost
      && parsed.parsed.database === TARGETS.database
      && parsed.parsed.sslmode === 'verify-full';
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/SecretNotFound|was not found|Secret Disabled/i.test(msg)) {
      secretExists = false;
      secretValid = false;
    } else {
      throw err;
    }
  }

  let roleValid = false;
  if (pg.roleExists) {
    const authority = assertRoleAuthorityContract({
      attributes: pg.attributes,
      memberships: pg.memberships,
      ownedObjects: pg.ownedObjects,
      grants: pg.grants,
      roleSettings: pg.roleSettings,
      databaseSettings: pg.databaseSettings,
    });
    roleValid = authority.ok;
  }

  return {
    roleExists: pg.roleExists,
    secretExists,
    roleValid,
    secretValid,
    attributes: pg.attributes,
    memberships: pg.memberships,
    ownedObjects: pg.ownedObjects,
    grants: pg.grants,
    roleSettings: pg.roleSettings,
    databaseSettings: pg.databaseSettings,
    inspection: {
      attributes: pg.attributes,
      memberships: pg.memberships,
      ownedObjects: pg.ownedObjects,
      grants: pg.grants,
      roleSettings: pg.roleSettings,
      databaseSettings: pg.databaseSettings,
    },
  };
}

function extractPasswordLiteral(sql) {
  const m = String(sql).match(/PASSWORD\s+'([^']*)'/i);
  return m ? m[1].replace(/''/g, "'") : null;
}

async function setTempBootstrapPassword(password) {
  try {
    execSync(
      `${azPath()} keyvault secret purge --vault-name ${TARGETS.keyVault} --name ${TEMP_BOOTSTRAP_SECRET} --subscription ${TARGETS.subscriptionId}`,
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (_) {
    /* ignore */
  }
  await writeKeyVaultSecretSecure({
    vaultName: TARGETS.keyVault,
    secretName: TEMP_BOOTSTRAP_SECRET,
    subscriptionId: TARGETS.subscriptionId,
    value: password,
    secretsToRedact: [password],
    runAz: async (args) => {
      const result = azJson(args, { allowSecretSet: true, secrets: [password] });
      if (result && typeof result === 'object') {
        const safe = { ...result };
        if (Object.prototype.hasOwnProperty.call(safe, 'value')) safe.value = REDACTED;
        return safe;
      }
      return { ok: true };
    },
  });
}

function deleteTempBootstrapPassword() {
  const name = TEMP_BOOTSTRAP_SECRET;
  const errors = [];
  try {
    azJson([
      'keyvault', 'secret', 'delete',
      '--vault-name', TARGETS.keyVault,
      '--name', name,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ], { allowSecretSet: true });
  } catch (err) {
    errors.push(`delete:${String(err && err.message ? err.message : err).slice(0, 120)}`);
  }
  try {
    execSync(
      `${azPath()} keyvault secret purge --vault-name ${TARGETS.keyVault} --name ${name} --subscription ${TARGETS.subscriptionId}`,
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    errors.push(`purge:${String(err && err.message ? err.message : err).slice(0, 120)}`);
  }

  let stillActive = false;
  try {
    stillActive = secretIsActive(name);
  } catch (_) {
    // Fall back to direct show via azJson
    try {
      azJson([
        'keyvault', 'secret', 'show',
        '--vault-name', TARGETS.keyVault,
        '--name', name,
        '--subscription', TARGETS.subscriptionId,
        '-o', 'json',
      ]);
      stillActive = true;
    } catch (showErr) {
      const msg = String(showErr && showErr.message ? showErr.message : showErr);
      stillActive = !/SecretNotFound|was not found|404/i.test(msg);
    }
  }

  if (stillActive) {
    throw Object.assign(
      new Error(redactSecrets(
        `temp_bootstrap_secret_still_active name=${name}${errors.length ? ` detail=${errors.join(';')}` : ''}`,
        [],
      )),
      { code: 'temp_bootstrap_secret_still_active', secretName: name },
    );
  }
  return { ok: true, secretName: name, active: false };
}

function createLivePostgresExec(deps) {
  const d = deps || {};
  const runWorker = d.runContainerWorker || runContainerWorker;
  const rollbackFn = d.rollbackNewlyCreatedObserverRole || rollbackNewlyCreatedObserverRole;
  const handleResult = d.handleBootstrapCreateResult || handleBootstrapCreateResult;

  return async function postgresExec(sql, _params, meta) {
    const stepId = meta && meta.stepId;
    if (stepId === 'create_role_if_absent') {
      const password = extractPasswordLiteral(sql);
      if (!password) {
        throw Object.assign(new Error('create_role sql missing password literal'), { code: 'missing_password' });
      }
      let cleanupError = null;
      try {
        await setTempBootstrapPassword(password);
        const r = runWorker('bootstrap_create');
        // Transactional success path
        if (r && r.ok === true && r.committed === true) {
          bootstrapCreateFlushed = true;
          return { ok: true, stepId, bundled: true, transactional: true };
        }
        // Partial / failed bootstrap — rollback if role remains; never write observer secret here.
        await handleResult(r, {
          targets: TARGETS,
          rollbackNewlyCreatedObserverRole: rollbackFn,
          postgresExec: async (rbSql) => {
            if (/PASSWORD/i.test(String(rbSql))) {
              throw Object.assign(new Error('password sql forbidden via rollback exec'), {
                code: 'password_sql_forbidden',
              });
            }
            const rb = runWorker('exec', { WH_OBS_SQL: rbSql });
            if (!rb || rb.ok === false) {
              throw Object.assign(new Error((rb && rb.error) || 'rollback exec failed'), {
                code: 'pg_exec_failed',
              });
            }
            return { ok: true };
          },
          kvSetCalls: [],
        });
        // handleResult throws on failure; unreachable
        return { ok: false, stepId };
      } finally {
        try {
          deleteTempBootstrapPassword();
        } catch (err) {
          cleanupError = err;
        }
        if (cleanupError) {
          // Surface after try body; do not claim success with active temp secret.
          throw Object.assign(
            new Error(redactSecrets(
              `temp_bootstrap_secret_cleanup_failed name=${TEMP_BOOTSTRAP_SECRET}`,
              [password],
            )),
            { code: 'temp_bootstrap_secret_still_active' },
          );
        }
      }
    }
    if (stepId === 'grant_connect' || stepId === 'role_readonly_default') {
      if (bootstrapCreateFlushed) {
        return { ok: true, stepId, alreadyBundled: true };
      }
      const r = runWorker('exec', { WH_OBS_SQL: sql });
      if (!r || r.ok === false) {
        throw Object.assign(new Error((r && r.error) || 'exec failed'), { code: 'pg_exec_failed' });
      }
      return { ok: true, stepId };
    }
    if (/PASSWORD/i.test(String(sql))) {
      throw Object.assign(new Error('password sql forbidden via generic exec'), { code: 'password_sql_forbidden' });
    }
    const r = runWorker('exec', { WH_OBS_SQL: sql });
    if (!r || r.ok === false) {
      throw Object.assign(new Error((r && r.error) || 'exec failed'), { code: 'pg_exec_failed' });
    }
    return { ok: true, stepId };
  };
}

function createLiveKeyVaultSet() {
  return async function keyVaultSecretSetSecure(opts) {
    return writeKeyVaultSecretSecure({
      ...opts,
      runAz: async (args) => {
        const result = azJson(args, {
          allowSecretSet: true,
          secrets: opts.secretsToRedact || [],
        });
        // az keyvault secret set echoes the secret value — strip before leak gate.
        if (result && typeof result === 'object') {
          const safe = { ...result };
          if (Object.prototype.hasOwnProperty.call(safe, 'value')) {
            safe.value = REDACTED;
          }
          return safe;
        }
        return { ok: true };
      },
    });
  };
}

/**
 * Build the full adapter bundle for executeConvergentBootstrap / runProvision.
 * PostgreSQL runs inside the Sunset staff-api container (firewall-allowed egress).
 * Key Vault mutations run from the operator laptop (Secrets Officer).
 */
function buildLiveProvisionAdapters(env) {
  const e = env || process.env;
  requireAdminEnv(e);
  bootstrapCreateFlushed = false;
  return {
    azure: createLiveAzureAdapters(),
    db: createLiveDbAdapters(),
    inspectState: async () => inspectRoleAndSecret(e),
    postgresExec: createLivePostgresExec(),
    keyVaultSecretSetSecure: createLiveKeyVaultSet(),
  };
}

/**
 * Secret-free post-state verification summary (no DSN/password).
 */
async function verifyLivePostState(env) {
  const state = await inspectRoleAndSecret(env);
  const authority = state.roleExists
    ? assertRoleAuthorityContract(state.inspection)
    : { ok: false, errors: [{ code: 'role_missing', message: 'role absent' }] };
  return {
    roleExists: state.roleExists,
    secretExists: state.secretExists,
    roleValid: state.roleValid,
    secretValid: state.secretValid,
    attributes: state.attributes,
    memberships: state.memberships,
    ownedObjectCount: (state.ownedObjects || []).length,
    grants: state.grants,
    roleSettings: state.roleSettings,
    authorityOk: authority.ok,
    authorityErrors: authority.errors,
    secretTargets: {
      host: TARGETS.postgresHost,
      database: TARGETS.database,
      role: TARGETS.roleName,
      sslmode: 'verify-full',
      valueExposed: false,
    },
  };
}

module.exports = {
  azPath,
  azJson,
  buildLiveProvisionAdapters,
  inspectRoleAndSecret,
  verifyLivePostState,
  createLiveAzureAdapters,
  createLivePostgresExec,
  deleteTempBootstrapPassword,
  requireAdminEnv,
};
