'use strict';

/**
 * verify:email-delta-runtime-config — offline hostile gate.
 *
 * Default-off independent flags; worker/admin true rejected; composition-only
 * pin validation; no DB/Pool/Azure SDK/Graph/timer/lease/migration.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG_REL = 'scripts/lib/email-delta-runtime-config.js';
const CFG_PATH = path.join(ROOT, CFG_REL);
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MIG_PATH = path.join(
  ROOT,
  'database/migrations/064_tenant_email_inbound_delta_states.sql',
);
const MANIFEST_PATH = path.join(
  ROOT,
  'database/migrations/canonical-manifest.json',
);

const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KNAME = 'luna-email-grant-kek';
const KVER = 'fde9704bd37b45fabe1f12a6a615b032';
const KID = `https://${HOST}/keys/${KNAME}/${KVER}`;
const PLANTED = 'password=LEAKED_SECRET_VALUE_DO_NOT_ECHO';

const M = require('./lib/email-delta-runtime-config');
const {
  parseEmailDeltaRuntimeConfig: parseCfg,
  isEmailDeltaCompositionFlagEnabled,
  ENV_COMPOSITION_ENABLED: E_COMP,
  ENV_WORKER_ENABLED: E_WORK,
  ENV_ADMIN_ENABLED: E_ADMIN,
  ENV_DEPLOYMENT,
  ENV_TENANT,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  WORKER_ID,
  MIGRATION_064_ID,
  QUERY_VERSION,
  READINESS_KEYS,
  CONFIG_STATUS,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  MIGRATION_064_READINESS_CONTRACT,
  CANONICAL_WORKER_CONFIG,
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
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) e[k] = o[k];
  }
  // Convert null-prototype to plain object with own enumerable data for parse.
  return Object.assign({}, e);
}

function enabledComposition(extra) {
  return exactEnv({
    [E_COMP]: 'true',
    [E_WORK]: 'false',
    [E_ADMIN]: 'false',
    [ENV_DEPLOYMENT]: SUNSET_DEPLOYMENT,
    [ENV_TENANT]: SUNSET_TENANT,
    [ENV_KV_COMPOSITION_ENABLED]: 'true',
    [ENV_KV_TRUSTED_HOST]: HOST,
    [ENV_KV_VERSIONED_KEY_ID]: KID,
    ...(extra || {}),
  });
}

function runChild(body) {
  return spawnSync(process.execPath, ['-e', body], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
    maxBuffer: 4 * 1024 * 1024,
  });
}

function parseChildJson(child) {
  try {
    const lines = String(child.stdout || '').trim().split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1] || 'null');
  } catch {
    return null;
  }
}

function noPlanted(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return !s.includes(PLANTED)
    && !s.includes('LEAKED_SECRET')
    && !s.includes('BEGIN RSA')
    && !s.includes('access_token')
    && !s.includes('refresh_token')
    && !s.includes('client_secret');
}

function main() {
  console.log('verify:email-delta-runtime-config');
  const src = fs.readFileSync(CFG_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const mig = fs.readFileSync(MIG_PATH, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  ok('package script present',
    !!(pkg.scripts && pkg.scripts['verify:email-delta-runtime-config']));
  ok('exports exact flag names',
    E_COMP === 'LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED'
    && E_WORK === 'LUNA_EMAIL_DELTA_WORKER_ENABLED'
    && E_ADMIN === 'LUNA_EMAIL_DELTA_ADMIN_ENABLED');
  ok('deployment/tenant pins',
    SUNSET_DEPLOYMENT === 'sunset-staging' && SUNSET_TENANT === 'sunset');
  ok('worker id bounded canonical',
    WORKER_ID === 'sunset-email-delta-worker'
    && CANONICAL_WORKER_CONFIG.worker_id === WORKER_ID
    && WORKER_ID.length >= 1 && WORKER_ID.length <= 128
    && !/\s/.test(WORKER_ID));
  ok('migration064 + query_version pins',
    MIGRATION_064_ID === '064_tenant_email_inbound_delta_states'
    && QUERY_VERSION === 'ms_messages_delta_v1'
    && MIGRATION_064_READINESS_CONTRACT.applied_by_this_module === false
    && MIGRATION_064_READINESS_CONTRACT.ddl_allowed === false
    && mig.includes('tenant_email_inbound_delta_states')
    && mig.includes('ms_messages_delta_v1')
    && (manifest.migrations || manifest.entries || []).some
      ? true
      : JSON.stringify(manifest).includes('064_tenant_email_inbound_delta_states'));
  ok('manifest includes 064',
    JSON.stringify(manifest).includes('064_tenant_email_inbound_delta_states'));
  ok('future txn adapter documented + inactive',
    FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.active_in_this_pr === false
    && FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.forbid_getPool_for_exclusive_loan === true
    && FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.outer_release_owner
      === 'pg-connect.withPgClient'
    && /withPgClient|exclusive|getPool|closePgPool|release/.test(src));
  ok('docs mention email-delta runtime composition inert',
    /email-delta-runtime|email-delta-sunset-staging-runtime-composition|LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED/.test(doc));
  ok('no Pool/pg construction / no azure require at top level',
    !/new\s+Pool\b/.test(src)
    && !/require\s*\(\s*['"]pg['"]\s*\)/.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(src)
    && !/setInterval|setTimeout|createServer|listen\s*\(/.test(src));

  // Default-off
  {
    const r = parseCfg({});
    ok('default disabled',
      r.ok === true
      && r.status === CONFIG_STATUS.DISABLED
      && r.composition_enabled === false
      && r.worker_enabled === false
      && r.admin_enabled === false
      && r.worker_activation_possible === false
      && r.admin_activation_possible === false
      && r.runtime_activation === false
      && r.scheduler_present === false
      && r.admin_route_present === false
      && Object.isFrozen(r)
      && READINESS_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r, k))
      && noPlanted(r));
    ok('isEmailDeltaCompositionFlagEnabled default false',
      isEmailDeltaCompositionFlagEnabled({}) === false);
  }

  // Independent flag: composition alone → inert when pins valid
  {
    const r = parseCfg(enabledComposition());
    ok('composition-only inert ready',
      r.ok === true
      && r.status === CONFIG_STATUS.COMPOSITION_INERT
      && r.composition_enabled === true
      && r.worker_enabled === false
      && r.admin_enabled === false
      && r.worker_activation_possible === false
      && r.kv_pins_valid === true
      && r.tenant_bound === true
      && r.code === 'email_delta_composition_inert'
      && noPlanted(r));
    ok('isEmailDeltaCompositionFlagEnabled true when composition only',
      isEmailDeltaCompositionFlagEnabled(enabledComposition()) === true);
  }

  // Non-true composition values stay disabled
  for (const [label, val] of [
    ['false', 'false'], ['1', '1'], ['TRUE', 'TRUE'], ['yes', 'yes'], ['', ''],
  ]) {
    const r = parseCfg(exactEnv({ [E_COMP]: val }));
    ok(`composition ${label} disabled`,
      r.ok === true && r.status === CONFIG_STATUS.DISABLED && r.composition_enabled === false);
  }

  // Worker/admin true → activation rejected (independent of composition)
  for (const [label, envObj] of [
    ['worker only', exactEnv({ [E_WORK]: 'true' })],
    ['admin only', exactEnv({ [E_ADMIN]: 'true' })],
    ['both', exactEnv({ [E_WORK]: 'true', [E_ADMIN]: 'true' })],
    ['composition+worker', enabledComposition({ [E_WORK]: 'true' })],
    ['composition+admin', enabledComposition({ [E_ADMIN]: 'true' })],
    ['all three', enabledComposition({ [E_WORK]: 'true', [E_ADMIN]: 'true' })],
  ]) {
    const r = parseCfg(envObj);
    ok(`activation rejected: ${label}`,
      r.ok === false
      && r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && r.worker_activation_possible === false
      && r.admin_activation_possible === false
      && r.runtime_activation === false
      && r.scheduler_present === false
      && r.admin_route_present === false
      && r.code === 'email_delta_activation_rejected'
      && noPlanted(r));
    ok(`flag helper false when activation rejected: ${label}`,
      isEmailDeltaCompositionFlagEnabled(envObj) === false);
  }

  // Fail-closed invalid deployment/tenant/KV
  for (const [label, envObj, code] of [
    ['bad deployment', enabledComposition({ [ENV_DEPLOYMENT]: 'production' }),
      'email_delta_deployment_mismatch'],
    ['wolfhouse deployment', enabledComposition({ [ENV_DEPLOYMENT]: 'wolfhouse-staging' }),
      'email_delta_deployment_mismatch'],
    ['missing deployment', exactEnv({
      [E_COMP]: 'true',
      [ENV_TENANT]: SUNSET_TENANT,
      [ENV_KV_COMPOSITION_ENABLED]: 'true',
      [ENV_KV_TRUSTED_HOST]: HOST,
      [ENV_KV_VERSIONED_KEY_ID]: KID,
    }), 'email_delta_deployment_mismatch'],
    ['bad tenant', enabledComposition({ [ENV_TENANT]: 'wolfhouse-somo' }),
      'email_delta_tenant_mismatch'],
    ['missing tenant', exactEnv({
      [E_COMP]: 'true',
      [ENV_DEPLOYMENT]: SUNSET_DEPLOYMENT,
      [ENV_KV_COMPOSITION_ENABLED]: 'true',
      [ENV_KV_TRUSTED_HOST]: HOST,
      [ENV_KV_VERSIONED_KEY_ID]: KID,
    }), 'email_delta_tenant_mismatch'],
    ['kv disabled', enabledComposition({ [ENV_KV_COMPOSITION_ENABLED]: 'false' }),
      'email_delta_kv_pins_invalid'],
    ['foreign kv host', enabledComposition({
      [ENV_KV_TRUSTED_HOST]: 'wh-staging-kv.vault.azure.net',
    }), 'email_delta_kv_pins_invalid'],
    ['latest key', enabledComposition({
      [ENV_KV_VERSIONED_KEY_ID]: `https://${HOST}/keys/${KNAME}/latest`,
    }), 'email_delta_kv_pins_invalid'],
  ]) {
    const r = parseCfg(envObj);
    ok(`fail-closed ${label}`,
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && r.code === code
      && r.runtime_activation === false
      && noPlanted(r),
      `got ${r && r.code}`);
  }

  // Proxy / accessor / symbol / nonenumerable traps
  {
    const proxyEnv = new Proxy({ [E_COMP]: 'true' }, {
      get() { throw new Error(PLANTED); },
      getOwnPropertyDescriptor() { throw new Error(PLANTED); },
      ownKeys() { throw new Error(PLANTED); },
    });
    const r = parseCfg(proxyEnv);
    ok('proxy env fail closed + no planted',
      r.ok === false && noPlanted(r) && noPlanted(r.code));
  }
  {
    const env = {};
    Object.defineProperty(env, E_COMP, {
      enumerable: true,
      get() { throw new Error(PLANTED); },
    });
    const r = parseCfg(env);
    ok('accessor flag fail closed',
      r.ok === false && noPlanted(r));
  }
  {
    const env = enabledComposition();
    Object.defineProperty(env, Symbol('secret'), {
      enumerable: false,
      value: PLANTED,
    });
    // Symbol extra on env object — parse should still succeed if own string keys ok
    // (readEnvString only touches known keys). Ensure status not leak planted.
    const r = parseCfg(env);
    ok('symbol nonenumerable does not leak',
      noPlanted(r)
      && (r.status === CONFIG_STATUS.COMPOSITION_INERT || r.ok === false));
  }
  {
    const env = enabledComposition();
    Object.defineProperty(env, E_WORK, {
      enumerable: false,
      value: 'true',
    });
    // Nonenumerable own data — hasOwnProperty true; reject worker true.
    const r = parseCfg(env);
    ok('nonenumerable worker true still rejected',
      r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && r.worker_enabled === true
      && noPlanted(r));
  }

  // Ambient process.env not mutated / default path
  {
    const before = process.env[E_COMP];
    const r = parseCfg(undefined);
    ok('undefined env uses process.env safely',
      r && typeof r.status === 'string' && noPlanted(r)
      && process.env[E_COMP] === before);
  }

  // Child: require config never loads azure/pg
  {
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && (r === 'pg' || r.startsWith('@azure/')
            || r === 'https' || r === 'http')) {
          hits.push(r);
          throw new Error('blocked ' + r);
        }
        return real(r, p, m);
      };
      const mod = require(${JSON.stringify(CFG_PATH)});
      const r = mod.parseEmailDeltaRuntimeConfig({});
      console.log(JSON.stringify({
        ok: r && r.status === 'disabled' && hits.length === 0,
        hits: hits.length,
        status: r && r.status,
      }));
    `);
    const b = parseChildJson(ch);
    ok('fresh require: zero pg/azure/http',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // Child: composition inert still zero azure (parse only)
  {
    const env = enabledComposition();
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && r.startsWith('@azure/')) {
          hits.push(r); throw new Error('blocked');
        }
        return real(r, p, m);
      };
      const mod = require(${JSON.stringify(CFG_PATH)});
      const r = mod.parseEmailDeltaRuntimeConfig(${JSON.stringify(env)});
      console.log(JSON.stringify({
        ok: r && r.status === 'composition_inert' && r.ok === true && hits.length === 0,
        hits: hits.length, status: r && r.status,
      }));
    `);
    const b = parseChildJson(ch);
    ok('composition-inert parse: zero azure SDK',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
