'use strict';

/**
 * verify:email-delta-operator-recovery-config — offline hostile gate.
 *
 * Fresh-process / intrinsic probes:
 *   - default-off; independent LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED
 *   - full gate only (composition + admin + worker not true + sunset pins)
 *   - composition alone / admin alone / operator alone rejected
 *   - worker true impossible
 *   - wrong tenant/deployment/malformed/hostile → fail closed
 *   - zero #410 / recovery store / route / DB / KV SDK load on import/gate
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG_REL = 'scripts/lib/email-delta-operator-recovery-config.js';
const CFG_PATH = path.join(ROOT, CFG_REL);
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const STAFF_PATH = path.join(ROOT, 'scripts/staff-query-api.js');

const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KNAME = 'luna-email-grant-kek';
const KVER = 'fde9704bd37b45fabe1f12a6a615b032';
const KID = `https://${HOST}/keys/${KNAME}/${KVER}`;

const M = require('./lib/email-delta-operator-recovery-config');
const {
  parseEmailDeltaOperatorRecoveryConfig: parseCfg,
  isEmailDeltaOperatorRecoveryEnabled: isEnabled,
  ENV_OPERATOR_RECOVERY_ENABLED: E_OP,
  ENV_COMPOSITION_ENABLED: E_COMP,
  ENV_WORKER_ENABLED: E_WORK,
  ENV_ADMIN_ENABLED: E_ADMIN,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  MIGRATION_065_ID,
  MIGRATION_064_ID,
  QUERY_VERSION,
  READINESS_KEYS,
  CONFIG_STATUS,
  ENV_KV_COMPOSITION_ENABLED,
  ENV_KV_TRUSTED_HOST,
  ENV_KV_VERSIONED_KEY_ID,
} = M;

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function exactEnv(o) {
  const e = Object.create(null);
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') e[k] = v;
  }
  return e;
}

function fullEnabledEnv(extra) {
  return exactEnv({
    [E_OP]: 'true',
    [E_COMP]: 'true',
    [E_ADMIN]: 'true',
    [E_WORK]: 'false',
    [ENV_DEPLOYMENT]: SUNSET_DEPLOYMENT,
    [ENV_TENANT]: SUNSET_TENANT,
    [ENV_KV_COMPOSITION_ENABLED]: 'true',
    [ENV_KV_TRUSTED_HOST]: HOST,
    [ENV_KV_VERSIONED_KEY_ID]: KID,
    ...(extra || {}),
  });
}

function main() {
  console.log('verify:email-delta-operator-recovery-config');

  ok('flag name exact', E_OP === 'LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED');
  ok('migration pins',
    MIGRATION_065_ID === '065_tenant_email_delta_recovery_operations'
    && MIGRATION_064_ID === '064_tenant_email_inbound_delta_states'
    && QUERY_VERSION === 'ms_messages_delta_v1');
  ok('docs mention operator recovery flag + routes',
    /LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED/.test(fs.readFileSync(DOC_PATH, 'utf8'))
    && /delta\/recovery/.test(fs.readFileSync(DOC_PATH, 'utf8')));
  ok('package script present',
    /verify:email-delta-operator-recovery-config/.test(fs.readFileSync(PKG_PATH, 'utf8')));
  ok('staff integrates once',
    (fs.readFileSync(STAFF_PATH, 'utf8').match(/staff-email-delta-operator-recovery-routes/g) || []).length === 1
    || (fs.readFileSync(STAFF_PATH, 'utf8').match(/createStaffEmailDeltaOperatorRecoveryRoutes/g) || []).length === 1);

  // default disabled
  {
    const r = parseCfg({});
    ok('default disabled',
      r.ok === true
      && r.status === CONFIG_STATUS.DISABLED
      && r.admin_recovery_activation_possible === false
      && r.routes_present === false
      && r.worker_activation_possible === false
      && r.scheduler_present === false
      && Object.isFrozen(r)
      && READINESS_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r, k)));
    ok('default isEnabled false', isEnabled({}) === false);
  }

  // full gate enabled
  {
    const env = fullEnabledEnv();
    const r = parseCfg(env);
    ok('full gate enabled',
      r.ok === true
      && r.status === CONFIG_STATUS.ENABLED
      && r.operator_recovery_enabled === true
      && r.composition_enabled === true
      && r.admin_enabled === true
      && r.worker_enabled === false
      && r.admin_recovery_activation_possible === true
      && r.routes_present === true
      && r.scheduler_present === false
      && r.worker_activation_possible === false
      && r.kv_pins_valid === true
      && r.tenant_bound === true);
    ok('full gate isEnabled true', isEnabled(env) === true);
  }

  // composition alone rejected/inert
  {
    const env = fullEnabledEnv({ [E_OP]: 'false', [E_ADMIN]: 'false' });
    // composition true alone
    const env2 = exactEnv({
      [E_COMP]: 'true',
      [ENV_DEPLOYMENT]: SUNSET_DEPLOYMENT,
      [ENV_TENANT]: SUNSET_TENANT,
      [ENV_KV_COMPOSITION_ENABLED]: 'true',
      [ENV_KV_TRUSTED_HOST]: HOST,
      [ENV_KV_VERSIONED_KEY_ID]: KID,
    });
    const r = parseCfg(env2);
    ok('composition alone rejected',
      r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && r.admin_recovery_activation_possible === false
      && isEnabled(env2) === false);
  }

  // admin alone rejected
  {
    const env = exactEnv({ [E_ADMIN]: 'true' });
    const r = parseCfg(env);
    ok('admin alone rejected',
      r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && isEnabled(env) === false);
  }

  // operator alone rejected
  {
    const env = exactEnv({ [E_OP]: 'true' });
    const r = parseCfg(env);
    ok('operator alone rejected',
      r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && isEnabled(env) === false);
  }

  // worker true impossible
  {
    const env = fullEnabledEnv({ [E_WORK]: 'true' });
    const r = parseCfg(env);
    ok('worker true impossible',
      r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && r.worker_activation_possible === false
      && isEnabled(env) === false);
  }

  // wrong deployment
  {
    const env = fullEnabledEnv({ [ENV_DEPLOYMENT]: 'wolfhouse-prod' });
    ok('wrong deployment fail closed',
      parseCfg(env).status === CONFIG_STATUS.CONFIG_INVALID
      && isEnabled(env) === false);
  }

  // wrong tenant
  {
    const env = fullEnabledEnv({ [ENV_TENANT]: 'other' });
    ok('wrong tenant fail closed',
      parseCfg(env).status === CONFIG_STATUS.CONFIG_INVALID
      && isEnabled(env) === false);
  }

  // non-exact true flags
  {
    for (const bad of ['TRUE', '1', 'yes', ' true ', 'True']) {
      const env = fullEnabledEnv({ [E_OP]: bad });
      if (isEnabled(env) !== false) {
        ok(`non-exact operator flag rejected (${bad})`, false);
        return;
      }
    }
    ok('non-exact operator flag variants rejected', true);
  }

  // loose KV enabled rejected
  {
    const env = fullEnabledEnv({ [ENV_KV_COMPOSITION_ENABLED]: 'TRUE' });
    ok('loose KV enabled rejected', isEnabled(env) === false);
  }

  // hostile symbol key
  {
    const env = fullEnabledEnv();
    const sym = Symbol('x');
    Object.defineProperty(env, sym, { value: 'true', enumerable: true });
    ok('symbol own key fail closed', isEnabled(env) === false);
  }

  // nonenumerable own prop
  {
    const env = fullEnabledEnv();
    Object.defineProperty(env, 'HIDDEN', { value: 'x', enumerable: false });
    ok('nonenumerable fail closed', isEnabled(env) === false);
  }

  // accessor fail closed
  {
    const env = fullEnabledEnv();
    Object.defineProperty(env, 'TRAP', {
      get() { return 'true'; },
      enumerable: true,
    });
    ok('accessor fail closed', isEnabled(env) === false);
  }

  // source: no owner load
  {
    const src = fs.readFileSync(CFG_PATH, 'utf8');
    ok('config free of owner graph requires',
      !/email-delta-recovery-operation-store/.test(src)
      && !/email-inbound-delta-state-store/.test(src)
      && !/withPgClient|getPool|@azure/.test(src)
      && !/staff-email-delta-operator-recovery-routes/.test(src));
  }

  // fresh process: disabled zero auth/body/DB
  {
    const probe = `
      const m = require(${JSON.stringify(CFG_PATH)});
      const r = m.parseEmailDeltaOperatorRecoveryConfig({});
      if (r.status !== 'disabled') process.exit(2);
      if (m.isEmailDeltaOperatorRecoveryEnabled({}) !== false) process.exit(3);
      console.log('ok');
    `;
    const out = spawnSync(process.execPath, ['-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' },
    });
    ok('fresh-process disabled', out.status === 0 && /ok/.test(out.stdout), out.stderr);
  }

  // fresh process: enabled under full gate
  {
    const probe = `
      const m = require(${JSON.stringify(CFG_PATH)});
      const env = Object.create(null);
      env.LUNA_EMAIL_DELTA_OPERATOR_RECOVERY_ENABLED = 'true';
      env.LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED = 'true';
      env.LUNA_EMAIL_DELTA_ADMIN_ENABLED = 'true';
      env.LUNA_EMAIL_DELTA_WORKER_ENABLED = 'false';
      env.LUNA_DEPLOYMENT = 'sunset-staging';
      env.DEFAULT_CLIENT_SLUG = 'sunset';
      env.EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED = 'true';
      env.EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST = ${JSON.stringify(HOST)};
      env.EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID = ${JSON.stringify(KID)};
      if (!m.isEmailDeltaOperatorRecoveryEnabled(env)) process.exit(2);
      const r = m.parseEmailDeltaOperatorRecoveryConfig(env);
      if (r.status !== 'enabled') process.exit(3);
      console.log('ok');
    `;
    const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
    ok('fresh-process full gate enabled', out.status === 0 && /ok/.test(out.stdout), out.stderr);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
