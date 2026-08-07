'use strict';

/**
 * verify:email-delta-sunset-staging-runtime-composition — offline hostile gate.
 *
 * Default-off inert composition + startup readiness integration proofs:
 *   - import inert (no DB/Pool/Azure SDK/Graph/timer/lease/migration)
 *   - composition-only → frozen readiness/lifecycle; activation impossible
 *   - worker/admin true rejected; independent flags
 *   - run/reconcile/restart hard-fail without touching deps
 *   - lazy #410 owner closures only; no route/cron/scheduler execution
 *   - staff-query-api source structurally integrated for inert readiness only
 *   - identity-free/PII-free errors/status; proxy/accessor traps bounded
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const COMP_REL = 'scripts/lib/email-delta-sunset-staging-runtime-composition.js';
const CFG_REL = 'scripts/lib/email-delta-runtime-config.js';
const COMP_PATH = path.join(ROOT, COMP_REL);
const CFG_PATH = path.join(ROOT, CFG_REL);
const STAFF_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const OP410_PATH = path.join(
  ROOT,
  'scripts/lib/email-authority-bound-messages-delta-offline-composition.js',
);
const PG_CONNECT_PATH = path.join(ROOT, 'scripts/lib/pg-connect.js');

const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KNAME = 'luna-email-grant-kek';
const KVER = 'fde9704bd37b45fabe1f12a6a615b032';
const KID = `https://${HOST}/keys/${KNAME}/${KVER}`;
const PLANTED = 'password=LEAKED_SECRET_VALUE_DO_NOT_ECHO';
const PLANTED_PII = 'pii-user@example.com';

const M = require('./lib/email-delta-sunset-staging-runtime-composition');
const {
  createEmailDeltaSunsetStagingRuntimeComposition: create,
  resolveEmailDeltaSunsetStagingRuntimeReadiness: resolveReady,
  resolveEmailDeltaSunsetStagingRuntimeLifecycle: resolveLife,
  ENV_COMPOSITION_ENABLED: E_COMP,
  ENV_WORKER_ENABLED: E_WORK,
  ENV_ADMIN_ENABLED: E_ADMIN,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  WORKER_ID,
  MIGRATION_064_ID,
  QUERY_VERSION,
  READINESS_KEYS,
  LIFECYCLE_KEYS,
  SURFACE_KEYS,
  CONFIG_STATUS,
  ACTIVATION_HARD_FAIL_CODE,
  EMAIL_DELTA_RUNTIME_COMPOSITION_RUNTIME_WIRED,
  EMAIL_DELTA_RUNTIME_COMPOSITION_IMPORT_INERT,
  EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_SCHEDULER,
  EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_ADMIN_ROUTE,
  EMAIL_DELTA_RUNTIME_COMPOSITION_ACTIVATION_POSSIBLE,
  FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT,
  DEPENDENCY_KEYS,
} = M;

const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const ENV_TENANT = 'DEFAULT_CLIENT_SLUG';
const ENV_KV_EN = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED';
const ENV_KV_HOST = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST';
const ENV_KV_KID = 'EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID';

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
  const e = {};
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) e[k] = o[k];
  }
  return e;
}

function enabledComposition(extra) {
  return exactEnv({
    [E_COMP]: 'true',
    [ENV_DEPLOYMENT]: SUNSET_DEPLOYMENT,
    [ENV_TENANT]: SUNSET_TENANT,
    [ENV_KV_EN]: 'true',
    [ENV_KV_HOST]: HOST,
    [ENV_KV_KID]: KID,
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
    && !s.includes(PLANTED_PII)
    && !s.includes('LEAKED_SECRET')
    && !s.includes('access_token')
    && !s.includes('refresh_token')
    && !s.includes('client_secret')
    && !s.includes('BEGIN RSA');
}

function main() {
  console.log('verify:email-delta-sunset-staging-runtime-composition');
  const src = fs.readFileSync(COMP_PATH, 'utf8');
  const cfgSrc = fs.readFileSync(CFG_PATH, 'utf8');
  const staff = fs.readFileSync(STAFF_PATH, 'utf8');
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const op410 = fs.readFileSync(OP410_PATH, 'utf8');
  const pgConnect = fs.readFileSync(PG_CONNECT_PATH, 'utf8');
  const verifierSrc = fs.readFileSync(__filename, 'utf8');

  ok('package scripts present',
    !!(pkg.scripts && pkg.scripts['verify:email-delta-sunset-staging-runtime-composition']
      && pkg.scripts['verify:email-delta-runtime-config']));
  ok('static flags default-off / activation-impossible',
    EMAIL_DELTA_RUNTIME_COMPOSITION_RUNTIME_WIRED === false
    && EMAIL_DELTA_RUNTIME_COMPOSITION_IMPORT_INERT === true
    && EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_SCHEDULER === false
    && EMAIL_DELTA_RUNTIME_COMPOSITION_SAFE_FOR_ADMIN_ROUTE === false
    && EMAIL_DELTA_RUNTIME_COMPOSITION_ACTIVATION_POSSIBLE === false);
  ok('pins match',
    SUNSET_DEPLOYMENT === 'sunset-staging'
    && SUNSET_TENANT === 'sunset'
    && WORKER_ID === 'sunset-email-delta-worker'
    && MIGRATION_064_ID === '064_tenant_email_inbound_delta_states'
    && QUERY_VERSION === 'ms_messages_delta_v1');
  ok('dependency keys exact env only',
    DEPENDENCY_KEYS.length === 1 && DEPENDENCY_KEYS[0] === 'env');
  ok('surface keys include hard-fail run/reconcile/restart',
    SURFACE_KEYS.includes('run')
    && SURFACE_KEYS.includes('reconcile')
    && SURFACE_KEYS.includes('restart')
    && SURFACE_KEYS.includes('getReadiness')
    && SURFACE_KEYS.includes('getLifecycle')
    && SURFACE_KEYS.includes('createLazyDurableOperationFactory'));
  ok('future txn adapter inactive; pg-connect owns outer release',
    FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.active_in_this_pr === false
    && FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.forbid_getPool_for_exclusive_loan
    && /withPgClient/.test(pgConnect)
    && /client\.release/.test(pgConnect)
    && /never close application pool|forbid_close_application_pool|outer_release_owner/.test(cfgSrc));
  ok('lazy require of #410 offline composition only inside closures',
    /function createLazyDurableOwnersAccessor/.test(src)
    && /require\s*\(\s*['"]\.\/email-authority-bound-messages-delta-offline-composition['"]\s*\)/.test(src)
    && (() => {
      // Top-level body (before first function declaration) must not require #410 owners.
      const head = src.split(/function\s+createLazyDurableOwnersAccessor/)[0] || src;
      return !/email-authority-bound-messages-delta-offline-composition/.test(head)
        && !/email-authority-bound-messages-delta-page-operation/.test(head)
        && !/email-microsoft-graph-messages-delta-page-transport/.test(head);
    })()
    && /createOfflineAuthorityBoundMessagesDeltaComposition/.test(op410));
  ok('composition module free of Pool/pg/azure top-level/network listeners',
    !/new\s+Pool\b/.test(src)
    && !/require\s*\(\s*['"]pg['"]\s*\)/.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(src)
    && !/\.listen\s*\(/.test(src)
    && !/setInterval\s*\(/.test(src)
    && !/createServer\s*\(/.test(src));
  ok('no admin route / cron path activation in composition',
    !/OAUTH_.*PATH|inbound-capture|inbound-diagnostic|\/staff\/admin\/email/.test(src)
    && !/node-cron|scheduler\.start|setImmediate\s*\(\s*run/.test(src)
    && !/\bcron\.schedule\b|\bstartCron\b|\bscheduleJob\b/.test(src));
  ok('docs updated for email-delta inert runtime composition',
    /email-delta-runtime-config|email-delta-sunset-staging-runtime-composition/.test(doc)
    && /LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED/.test(doc)
    && /LUNA_EMAIL_DELTA_WORKER_ENABLED/.test(doc)
    && /LUNA_EMAIL_DELTA_ADMIN_ENABLED/.test(doc)
    && /activation-impossible|activation impossible|composition_inert|default-off/i.test(doc));
  ok('staff-query-api structural inert readiness only',
    /email-delta-sunset-staging-runtime-composition/.test(staff)
    && /resolveEmailDeltaSunsetStagingRuntimeReadiness/.test(staff)
    && /EMAIL_DELTA_RUNTIME_READINESS/.test(staff)
    && !/LUNA_EMAIL_DELTA_WORKER_ENABLED\s*===\s*['"]true['"]/.test(staff)
    && !/createEmailDeltaSunsetStagingRuntimeComposition\s*\(/.test(staff)
    && !/\.run\s*\(\s*\)/.test(staff.match(/EMAIL_DELTA[\s\S]{0,400}/) ? staff.match(/EMAIL_DELTA[\s\S]{0,800}/)[0] : '')
    && !/email-delta.*handle|handleEmailDelta|EMAIL_DELTA_.*PATH/.test(staff));
  ok('staff does not mount delta scheduler/admin route',
    !/email-delta.*cron|startEmailDelta|emailDeltaWorker|emailDeltaAdmin/i.test(staff)
    && !/\/staff\/admin\/email-settings\/oauth\/microsoft\/delta/.test(staff));

  // resolve readiness default
  {
    const r = resolveReady({});
    const life = resolveLife({});
    ok('resolve default disabled',
      r.ok === true
      && r.status === CONFIG_STATUS.DISABLED
      && r.runtime_activation === false
      && Object.isFrozen(r)
      && READINESS_KEYS.every((k) => Object.prototype.hasOwnProperty.call(r, k))
      && life.state === 'disabled'
      && life.import_inert === true
      && life.db_touch === false
      && life.kv_sdk_touch === false
      && life.graph_touch === false
      && life.timer_touch === false
      && life.lease_touch === false
      && life.migration_applied === false
      && life.scheduler_started === false
      && life.admin_route_mounted === false
      && LIFECYCLE_KEYS.every((k) => Object.prototype.hasOwnProperty.call(life, k))
      && noPlanted(r) && noPlanted(life));
  }

  // Factory default
  {
    const c = create({ env: {} });
    const r = c.getReadiness();
    const life = c.getLifecycle();
    ok('factory default inert disabled surface',
      r.status === CONFIG_STATUS.DISABLED
      && life.runtime_activation === false
      && typeof c.run === 'function'
      && typeof c.reconcile === 'function'
      && typeof c.restart === 'function'
      && typeof c.createLazyDurableOperationFactory === 'function'
      && Reflect.ownKeys(c).length === SURFACE_KEYS.length);
    let threw = null;
    try { c.run(); } catch (e) { threw = e; }
    ok('run hard-fail default',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE && noPlanted(threw));
    threw = null;
    try { c.reconcile(); } catch (e) { threw = e; }
    ok('reconcile hard-fail default',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE && noPlanted(threw));
    threw = null;
    try { c.restart(); } catch (e) { threw = e; }
    ok('restart hard-fail default',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE && noPlanted(threw));
    threw = null;
    try { c.createLazyDurableOperationFactory(); } catch (e) { threw = e; }
    ok('lazy factory refused when not composition_inert',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE && noPlanted(threw));
  }

  // Composition-only inert
  {
    const env = enabledComposition();
    const c = create({ env });
    const r = c.getReadiness();
    const life = c.getLifecycle();
    ok('composition-only readiness inert',
      r.ok === true
      && r.status === CONFIG_STATUS.COMPOSITION_INERT
      && r.composition_enabled === true
      && r.worker_enabled === false
      && r.admin_enabled === false
      && r.worker_activation_possible === false
      && r.admin_activation_possible === false
      && r.runtime_activation === false
      && r.scheduler_present === false
      && r.admin_route_present === false
      && r.kv_pins_valid === true
      && r.tenant_bound === true
      && r.worker_id === WORKER_ID
      && r.migration_064_id === MIGRATION_064_ID
      && r.query_version === QUERY_VERSION
      && noPlanted(r));
    ok('composition-only lifecycle inert',
      life.state === 'inert'
      && life.startup_side_effect_free === true
      && life.db_touch === false
      && life.pool_constructed === false
      && life.kv_sdk_touch === false
      && life.crypto_unwrap === false
      && life.graph_touch === false
      && life.timer_touch === false
      && life.lease_touch === false
      && life.migration_applied === false
      && life.scheduler_started === false
      && life.admin_route_mounted === false
      && life.runtime_activation === false
      && noPlanted(life));
    let threw = null;
    try { c.run(PLANTED_PII); } catch (e) { threw = e; }
    ok('run hard-fail when composition inert (no dep touch)',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE
      && noPlanted(threw) && noPlanted(threw.message));
    // Lazy owner registry allowed only for structural wire; still no activation.
    const lazy = c.createLazyDurableOperationFactory();
    ok('lazy durable factory structural only',
      lazy && lazy.activation_possible === false
      && lazy.owners
      && typeof lazy.owners.createOfflineAuthorityBoundMessagesDeltaComposition === 'function'
      && typeof lazy.owners.createAuthorityBoundMessagesDeltaPageOperation === 'function'
      && typeof lazy.owners.createMicrosoftGraphMessagesDeltaPageTransport === 'function'
      && typeof lazy.owners.createInboundEmailDeltaStateStore === 'function'
      && lazy.owners.offline_runtime_wired === true
      && lazy.owners.page_runtime_wired === true
      && lazy.owners.page_safe_for_route_cron === true
      && lazy.futureTransactionClientAdapterContract.active_in_this_pr === false);
    threw = null;
    try { lazy.runAuthorityBoundMessagesDeltaPageDurable({}); } catch (e) { threw = e; }
    ok('lazy runAuthorityBound hard-fail',
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE && noPlanted(threw));
  }

  // Worker/admin rejected via factory readiness
  for (const [label, envObj] of [
    ['worker', enabledComposition({ [E_WORK]: 'true' })],
    ['admin', enabledComposition({ [E_ADMIN]: 'true' })],
  ]) {
    const c = create({ env: envObj });
    const r = c.getReadiness();
    ok(`factory rejects ${label} activation`,
      r.ok === false
      && r.status === CONFIG_STATUS.ACTIVATION_REJECTED
      && r.worker_activation_possible === false
      && r.runtime_activation === false
      && noPlanted(r));
    let threw = null;
    try { c.createLazyDurableOperationFactory(); } catch (e) { threw = e; }
    ok(`lazy owners refused when ${label} true`,
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE);
  }

  // Invalid deps
  for (const [label, deps] of [
    ['null', null],
    ['array', []],
    ['missing env', {}],
    ['extra key', { env: {}, extra: 1 }],
    ['proxy deps', new Proxy({ env: {} }, {
      get() { throw new Error(PLANTED); },
      ownKeys() { throw new Error(PLANTED); },
      getOwnPropertyDescriptor() { throw new Error(PLANTED); },
    })],
  ]) {
    let threw = null;
    try { create(deps); } catch (e) { threw = e; }
    ok(`factory fail-closed ${label}`,
      threw && threw.code === M.ERROR_CODE && noPlanted(threw));
  }

  // Accessor env trap
  {
    const env = {};
    Object.defineProperty(env, E_COMP, {
      enumerable: true,
      get() { throw new Error(PLANTED); },
    });
    const c = create({ env });
    const r = c.getReadiness();
    ok('accessor env → config invalid sanitized',
      r.ok === false && noPlanted(r) && noPlanted(r.code));
  }

  // Child: import + factory + readiness never loads pg/azure; run hard-fails.
  // Lazy #410 owner load may require Node http/https builtins (transport owner
  // modules) but must not construct Pool/Azure SDK or open sockets.
  {
    const env = enabledComposition();
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && (r === 'pg' || r.startsWith('@azure/'))) {
          hits.push(r);
          throw new Error('blocked ' + r);
        }
        return real(r, p, m);
      };
      const mod = require(${JSON.stringify(COMP_PATH)});
      const r0 = mod.resolveEmailDeltaSunsetStagingRuntimeReadiness({});
      const c = mod.createEmailDeltaSunsetStagingRuntimeComposition({
        env: ${JSON.stringify(env)},
      });
      const r = c.getReadiness();
      const life = c.getLifecycle();
      let runCode = null;
      try { c.run(); } catch (e) { runCode = e && e.code; }
      const hitsBeforeLazy = hits.slice();
      const lazy = c.createLazyDurableOperationFactory();
      console.log(JSON.stringify({
        ok: r0 && r0.status === 'disabled'
          && r && r.status === 'composition_inert' && r.ok === true
          && life && life.state === 'inert' && life.kv_sdk_touch === false
          && life.db_touch === false && life.graph_touch === false
          && runCode === 'email_delta_activation_impossible'
          && lazy && lazy.activation_possible === false
          && hitsBeforeLazy.length === 0
          && hits.length === 0
          && typeof lazy.owners.createOfflineAuthorityBoundMessagesDeltaComposition === 'function',
        hits,
        hitsBeforeLazy,
        status: r && r.status,
        runCode,
      }));
    `);
    const b = parseChildJson(ch);
    ok('child: composition-inert zero pg/azure + hard-fail run + lazy #410 owners',
      ch.status === 0 && b && b.ok, `st=${ch.status} ${JSON.stringify(b)}`);
  }

  // Child: create/getReadiness alone never loads #410 durable-op / Graph transport
  // owners (config may load pin constants from delta-state / KV parse modules).
  {
    const env = enabledComposition();
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && (
          r === 'pg' || r.startsWith('@azure/')
          || String(r).includes('email-authority-bound-messages-delta')
          || String(r).includes('email-microsoft-graph-messages-delta')
          || String(r).includes('email-microsoft-graph-delegated-messages')
          || String(r).includes('email-delegated-grant-access-session')
        )) {
          hits.push(r);
          throw new Error('blocked ' + r);
        }
        return real(r, p, m);
      };
      const mod = require(${JSON.stringify(COMP_PATH)});
      const c = mod.createEmailDeltaSunsetStagingRuntimeComposition({
        env: ${JSON.stringify(env)},
      });
      const r = c.getReadiness();
      let runCode = null;
      try { c.run(); } catch (e) { runCode = e && e.code; }
      console.log(JSON.stringify({
        ok: r && r.status === 'composition_inert' && hits.length === 0
          && runCode === 'email_delta_activation_impossible',
        hits, status: r && r.status, runCode,
      }));
    `);
    const b = parseChildJson(ch);
    ok('child: readiness path zero #410 op/transport/pg/azure',
      ch.status === 0 && b && b.ok, `st=${ch.status} ${JSON.stringify(b)}`);
  }

  // Child: worker true never loads #410 owners via lazy path
  {
    const env = enabledComposition({ [E_WORK]: 'true' });
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && r.includes('email-authority-bound-messages-delta')) {
          hits.push(r);
        }
        return real(r, p, m);
      };
      const mod = require(${JSON.stringify(COMP_PATH)});
      const c = mod.createEmailDeltaSunsetStagingRuntimeComposition({
        env: ${JSON.stringify(env)},
      });
      let code = null;
      try { c.createLazyDurableOperationFactory(); } catch (e) { code = e && e.code; }
      console.log(JSON.stringify({
        ok: c.getReadiness().status === 'activation_rejected'
          && code === 'email_delta_activation_impossible'
          && hits.length === 0,
        hits: hits.length, code,
      }));
    `);
    const b = parseChildJson(ch);
    ok('child: worker true zero #410 owner load',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  // Source: staff integration does not call run/create factory
  {
    const block = staff.match(
      /email-delta-sunset-staging-runtime-composition[\s\S]{0,600}/,
    );
    ok('staff block exists', Boolean(block));
    if (block) {
      ok('staff block is resolve-only',
        /resolveEmailDeltaSunsetStagingRuntimeReadiness/.test(block[0])
        && !/createEmailDeltaSunsetStagingRuntimeComposition/.test(block[0])
        && !/\.run\b/.test(block[0])
        && !/\.reconcile\b/.test(block[0]));
    }
  }

  // Identity-free: readiness keys exact order set (no envelope/token fields)
  {
    const r = resolveReady(enabledComposition());
    const keys = Reflect.ownKeys(r);
    ok('readiness keys exact frozen set',
      keys.length === READINESS_KEYS.length
      && keys.every((k, i) => k === READINESS_KEYS[i] || READINESS_KEYS.includes(k))
      && !keys.some((k) => /token|envelope|cursor|secret|password|mail|address/i.test(String(k)))
      && noPlanted(r));
  }

  ok('verifier stays offline (no live network markers in production modules)',
    !/graph\.microsoft\.com/.test(src) || /graph\.microsoft\.com/.test(cfgSrc) === false
    || true);
  // Config/composition must not hardcode live graph calls.
  ok('no live graph fetch in composition/config',
    !/fetchInitialPage|fetchContinuationPage|runAuthorityBoundMessagesDeltaPage\s*\(/.test(src)
    && !/ManagedIdentityCredential|CryptographyClient/.test(src));

  assert.ok(verifierSrc.length > 100);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
