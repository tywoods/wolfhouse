'use strict';

/**
 * verify:email-delta-sunset-staging-runtime-composition — offline hostile gate.
 *
 * Fresh-process behavioral probes prove:
 *   - import inert (no #410/KV/state/crypto/pg/Azure/https/timers/DB)
 *   - composition-only → frozen readiness/lifecycle; activation impossible
 *   - worker/admin true rejected; independent flags
 *   - run/reconcile/restart hard-fail without touching deps
 *   - no returned/exported nested callable owner capability
 *   - staff-query-api resolve-only structural integration
 *   - ambient intrinsic monkeypatch resistance; hostile env fail-closed
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const COMP_REL = 'scripts/lib/email-delta-sunset-staging-runtime-composition.js';
const CFG_REL = 'scripts/lib/email-delta-runtime-config.js';
const COMP_PATH = path.join(ROOT, COMP_REL);
const CFG_PATH = path.join(ROOT, CFG_REL);
const STAFF_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const DOC_PATH = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
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

const FORBIDDEN_LOAD_SNIPS = [
  'email-authority-bound-messages-delta',
  'email-microsoft-graph-messages-delta',
  'email-microsoft-graph-delegated-messages',
  'email-delegated-grant-access-session',
  'email-inbound-delta-state-store',
  'email-grant-envelope-azure-kv',
  'email-grant-envelope-provider',
  'pg-connect',
];
const FORBIDDEN_BUILTINS = ['pg', 'https', 'http', 'net', 'tls', 'dns'];

/**
 * Fresh-process probe: instrument Module._load, timers; monkeypatch intrinsics
 * after require; exercise import/readiness/run/reconcile/restart under env.
 */
function compositionProbeBody(scenario) {
  return `
    'use strict';
    const Module = require('module');
    const hits = [];
    const timerHits = [];
    const real = Module._load;
    const forbiddenSnips = ${JSON.stringify(FORBIDDEN_LOAD_SNIPS)};
    const forbiddenBuiltins = ${JSON.stringify(FORBIDDEN_BUILTINS)};
    Module._load = function(r, p, m) {
      if (typeof r === 'string') {
        const s = r;
        if (forbiddenBuiltins.includes(s) || s.startsWith('@azure/')) {
          hits.push(s);
          throw new Error('blocked ' + s);
        }
        for (const sn of forbiddenSnips) {
          if (s.includes(sn)) {
            hits.push(s);
            throw new Error('blocked ' + s);
          }
        }
      }
      return real(r, p, m);
    };
    const _st = global.setTimeout;
    const _si = global.setInterval;
    global.setTimeout = function(...a) { timerHits.push('setTimeout'); return _st(...a); };
    global.setInterval = function(...a) { timerHits.push('setInterval'); return _si(...a); };

    const scenario = ${JSON.stringify(scenario)};
    const realIsFrozen = Object.isFrozen;
    const mod = require(${JSON.stringify(COMP_PATH)});

    // Ambient intrinsic monkeypatch AFTER require — pins must resist.
    const poison = function() { throw new Error(${JSON.stringify(PLANTED)}); };
    Object.getOwnPropertyDescriptor = poison;
    Object.getPrototypeOf = poison;
    Reflect.ownKeys = poison;
    Object.freeze = poison;
    Object.isFrozen = function() { return false; };
    try { require('util').types.isProxy = function() { return false; }; } catch (_) {}

    function assignHard(obj, key, val) {
      if (!obj || typeof obj !== 'object') return false;
      const before = obj[key];
      let threw = false;
      try { obj[key] = val; } catch (_) { threw = true; }
      return threw || obj[key] === before;
    }

    const r0 = mod.resolveEmailDeltaSunsetStagingRuntimeReadiness(scenario.env || {});
    const life0 = mod.resolveEmailDeltaSunsetStagingRuntimeLifecycle(scenario.env || {});
    let c = null;
    let factoryErr = null;
    try {
      c = mod.createEmailDeltaSunsetStagingRuntimeComposition({ env: scenario.env || {} });
    } catch (e) {
      factoryErr = e && e.code;
    }

    let runCode = null, reconcileCode = null, restartCode = null;
    let readiness = null, life = null;
    let surfaceKeys = null;
    let nestedCallables = [];
    let surfaceHasOwnerLoader = false;
    let surfaceFrozen = false;
    let readinessFrozen = false;
    let lifeFrozen = false;
    let surfaceAssignRejected = false;
    let readinessAssignRejected = false;
    let lifeAssignRejected = false;
    let hardFailFrozen = false;
    let hardFailAssignRejected = false;

    if (c) {
      readiness = c.getReadiness();
      life = c.getLifecycle();
      try { surfaceKeys = Object.keys(c); } catch (_) { surfaceKeys = []; }
      surfaceFrozen = realIsFrozen(c) === true;
      readinessFrozen = realIsFrozen(readiness) === true;
      lifeFrozen = realIsFrozen(life) === true;
      surfaceAssignRejected = assignHard(c, 'run', null);
      readinessAssignRejected = assignHard(readiness, 'status', 'hostile');
      lifeAssignRejected = assignHard(life, 'state', 'hostile');
      try { c.run(${JSON.stringify(PLANTED_PII)}); } catch (e) {
        runCode = e && e.code;
        hardFailFrozen = realIsFrozen(e) === true;
        hardFailAssignRejected = assignHard(e, 'code', 'hostile');
      }
      try { c.reconcile(); } catch (e) { reconcileCode = e && e.code; }
      try { c.restart(); } catch (e) { restartCode = e && e.code; }

      surfaceHasOwnerLoader =
        typeof c.createLazyDurableOperationFactory === 'function'
        || typeof c.createOfflineAuthorityBoundMessagesDeltaComposition === 'function'
        || typeof c.withPgClient === 'function'
        || typeof c.getLazyDurableOwners === 'function'
        || typeof c.owners === 'object';

      for (const k of (surfaceKeys || [])) {
        const v = c[k];
        if (typeof v === 'function' && /create|Owner|Factory|withPg|Transport|Store|Session|Provider/i.test(k)
            && !['getReadiness','getLifecycle','run','reconcile','restart'].includes(k)) {
          nestedCallables.push(k);
        }
      }
    }

    // Module exports must not expose owner constructors.
    const exportOwnerEscape = (
      typeof mod.createLazyDurableOperationFactory === 'function'
      || typeof mod.createOfflineAuthorityBoundMessagesDeltaComposition === 'function'
      || typeof mod.createAuthorityBoundMessagesDeltaPageOperation === 'function'
      || typeof mod.createMicrosoftGraphMessagesDeltaPageTransport === 'function'
      || typeof mod.createInboundEmailDeltaStateStore === 'function'
      || typeof mod.createDelegatedGrantAccessSession === 'function'
      || typeof mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition === 'function'
      || typeof mod.withPgClient === 'function'
      || typeof mod.createAzureKvEmailGrantEnvelopeProvider === 'function'
    );

    console.log(JSON.stringify({
      hits,
      timerHits,
      r0Status: r0 && r0.status,
      r0Ok: r0 && r0.ok,
      r0Frozen: realIsFrozen(r0) === true,
      r0AssignRejected: assignHard(r0, 'status', 'hostile'),
      life0State: life0 && life0.state,
      life0Db: life0 && life0.db_touch,
      life0Kv: life0 && life0.kv_sdk_touch,
      life0Graph: life0 && life0.graph_touch,
      life0Timer: life0 && life0.timer_touch,
      life0Runtime: life0 && life0.runtime_activation,
      life0Frozen: realIsFrozen(life0) === true,
      life0AssignRejected: assignHard(life0, 'state', 'hostile'),
      factoryErr,
      status: readiness && readiness.status,
      ok: readiness && readiness.ok,
      lifeState: life && life.state,
      runCode, reconcileCode, restartCode,
      surfaceKeys,
      surfaceHasOwnerLoader,
      nestedCallables,
      exportOwnerEscape,
      worker_activation_possible: readiness && readiness.worker_activation_possible,
      admin_activation_possible: readiness && readiness.admin_activation_possible,
      runtime_activation: readiness && readiness.runtime_activation,
      kv_pins_valid: readiness && readiness.kv_pins_valid,
      code: readiness && readiness.code,
      surfaceFrozen,
      readinessFrozen,
      lifeFrozen,
      surfaceAssignRejected,
      readinessAssignRejected,
      lifeAssignRejected,
      hardFailFrozen,
      hardFailAssignRejected,
      exportsFrozen: realIsFrozen(mod) === true,
    }));
  `;
}

function main() {
  console.log('verify:email-delta-sunset-staging-runtime-composition');
  const src = fs.readFileSync(COMP_PATH, 'utf8');
  const cfgSrc = fs.readFileSync(CFG_PATH, 'utf8');
  const staff = fs.readFileSync(STAFF_PATH, 'utf8');
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const pgConnect = fs.readFileSync(PG_CONNECT_PATH, 'utf8');

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
  ok('surface keys hard-fail only (no owner-loader)',
    SURFACE_KEYS.includes('run')
    && SURFACE_KEYS.includes('reconcile')
    && SURFACE_KEYS.includes('restart')
    && SURFACE_KEYS.includes('getReadiness')
    && SURFACE_KEYS.includes('getLifecycle')
    && !SURFACE_KEYS.includes('createLazyDurableOperationFactory')
    && SURFACE_KEYS.length === 5);
  ok('future txn adapter inactive; pg-connect owns outer release',
    FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.active_in_this_pr === false
    && FUTURE_PINNED_TRANSACTION_CLIENT_ADAPTER_CONTRACT.forbid_getPool_for_exclusive_loan
    && /withPgClient/.test(pgConnect)
    && /client\.release/.test(pgConnect)
    && /never close application pool|forbid_close_application_pool|outer_release_owner/.test(cfgSrc));
  ok('composition pins freeze + security-critical intrinsics',
    /PINNED_OBJECT_FREEZE/.test(src)
    && /PINNED_IS_FROZEN/.test(src)
    && /PINNED_GET_OWN_PROPERTY_DESCRIPTOR/.test(src)
    && /PINNED_GET_PROTOTYPE_OF/.test(src)
    && /PINNED_REFLECT_OWN_KEYS/.test(src)
    && /PINNED_HAS_OWN|safeHasOwn/.test(src)
    && /PINNED_IS_PROXY/.test(src)
    && /pinnedFreeze/.test(src)
    && !/\bObject\.freeze\s*\(/.test(src.replace(/typeof Object\.freeze/g, '')));
  ok('no owner-loader / #410 require / lazy factory in composition',
    !/createLazyDurableOwnersAccessor|createLazyDurableOperationFactory|getLazyDurableOwners/.test(src)
    && !/email-authority-bound-messages-delta-offline-composition/.test(src)
    && !/email-authority-bound-messages-delta-page-operation/.test(src)
    && !/email-microsoft-graph-messages-delta-page-transport/.test(src)
    && !/email-delegated-grant-access-session/.test(src)
    && !/email-inbound-delta-state-store/.test(src)
    && !/email-grant-envelope-azure-kv/.test(src)
    && !/require\s*\(\s*['"]pg['"]\s*\)/.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(src));
  ok('composition free of Pool/network listeners/timers',
    !/new\s+Pool\b/.test(src)
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
      && typeof c.createLazyDurableOperationFactory !== 'function'
      && Reflect.ownKeys(c).length === SURFACE_KEYS.length
      && SURFACE_KEYS.every((k) => typeof c[k] === 'function'));
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
    // No owner-loader capability on surface.
    ok('no createLazyDurableOperationFactory on surface',
      typeof c.createLazyDurableOperationFactory !== 'function'
      && !Object.prototype.hasOwnProperty.call(c, 'createLazyDurableOperationFactory')
      && !Object.prototype.hasOwnProperty.call(c, 'owners'));
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
    try { c.run(); } catch (e) { threw = e; }
    ok(`run hard-fail when ${label} true`,
      threw && threw.code === ACTIVATION_HARD_FAIL_CODE);
  }

  // Exact KV raw booleans via composition surface
  for (const [label, val] of [
    ['TRUE', 'TRUE'], ['1', '1'], ['yes', 'yes'], ['true ', 'true '],
  ]) {
    const c = create({ env: enabledComposition({ [ENV_KV_EN]: val }) });
    const r = c.getReadiness();
    ok(`composition surface kv raw ${label} invalid`,
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && r.code === 'email_delta_kv_pins_invalid'
      && noPlanted(r));
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
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && noPlanted(r) && noPlanted(r.code));
  }

  // Complete env own-key/descriptor surface under composition-enabled + disabled.
  for (const [label, baseEnv] of [
    ['composition-enabled', enabledComposition()],
    ['disabled', exactEnv({})],
  ]) {
    {
      const env = exactEnv(baseEnv);
      Object.defineProperty(env, Symbol('secret'), {
        enumerable: false,
        value: PLANTED,
      });
      const c = create({ env });
      const r = c.getReadiness();
      ok(`composition symbol own key fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r),
        `got ${r && r.status}`);
    }
    {
      const env = exactEnv(baseEnv);
      Object.defineProperty(env, 'UNRELATED_HOSTILE_NONENUM', {
        enumerable: false,
        value: PLANTED,
      });
      const c = create({ env });
      const r = c.getReadiness();
      ok(`composition unrelated nonenumerable fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r),
        `got ${r && r.status}`);
    }
    {
      const env = exactEnv(baseEnv);
      Object.defineProperty(env, 'UNRELATED_HOSTILE_ACCESSOR', {
        enumerable: true,
        get() { throw new Error(PLANTED); },
      });
      const c = create({ env });
      const r = c.getReadiness();
      ok(`composition unrelated accessor fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r),
        `got ${r && r.status}`);
    }
  }

  // Unknown ordinary string env vars remain allowed on composition path.
  {
    const c = create({ env: enabledComposition({ UNRELATED_ORDINARY_STRING: 'hello' }) });
    const r = c.getReadiness();
    ok('composition unknown ordinary string env var allowed',
      r.ok === true
      && r.status === CONFIG_STATUS.COMPOSITION_INERT
      && noPlanted(r));
  }

  // ── Fresh-process behavioral probes ────────────────────────────────────
  const probeScenarios = [
    {
      name: 'disabled import/readiness/run/reconcile/restart zero owner load',
      env: {},
      expect: (b) => b
        && b.r0Status === 'disabled' && b.r0Ok === true
        && b.status === 'disabled'
        && b.runCode === 'email_delta_activation_impossible'
        && b.reconcileCode === 'email_delta_activation_impossible'
        && b.restartCode === 'email_delta_activation_impossible'
        && Array.isArray(b.hits) && b.hits.length === 0
        && Array.isArray(b.timerHits) && b.timerHits.length === 0
        && b.exportOwnerEscape === false
        && b.surfaceHasOwnerLoader === false
        && Array.isArray(b.nestedCallables) && b.nestedCallables.length === 0
        && Array.isArray(b.surfaceKeys) && b.surfaceKeys.length === 5
        && b.life0Db === false && b.life0Kv === false && b.life0Graph === false,
    },
    {
      name: 'composition-only import/readiness/run zero owner load',
      env: enabledComposition(),
      expect: (b) => b
        && b.r0Status === 'composition_inert' && b.r0Ok === true
        && b.status === 'composition_inert' && b.ok === true
        && b.kv_pins_valid === true
        && b.lifeState === 'inert'
        && b.runCode === 'email_delta_activation_impossible'
        && b.reconcileCode === 'email_delta_activation_impossible'
        && b.restartCode === 'email_delta_activation_impossible'
        && Array.isArray(b.hits) && b.hits.length === 0
        && Array.isArray(b.timerHits) && b.timerHits.length === 0
        && b.exportOwnerEscape === false
        && b.surfaceHasOwnerLoader === false
        && Array.isArray(b.nestedCallables) && b.nestedCallables.length === 0
        && b.worker_activation_possible === false
        && b.admin_activation_possible === false
        && b.runtime_activation === false,
    },
    {
      name: 'worker true rejected zero owner load',
      env: enabledComposition({ [E_WORK]: 'true' }),
      expect: (b) => b
        && b.status === 'activation_rejected' && b.ok === false
        && b.runCode === 'email_delta_activation_impossible'
        && Array.isArray(b.hits) && b.hits.length === 0
        && b.exportOwnerEscape === false
        && b.surfaceHasOwnerLoader === false
        && b.worker_activation_possible === false,
    },
    {
      name: 'admin true rejected zero owner load',
      env: enabledComposition({ [E_ADMIN]: 'true' }),
      expect: (b) => b
        && b.status === 'activation_rejected' && b.ok === false
        && b.runCode === 'email_delta_activation_impossible'
        && Array.isArray(b.hits) && b.hits.length === 0
        && b.exportOwnerEscape === false,
    },
    {
      name: 'worker+admin both rejected zero owner load',
      env: enabledComposition({ [E_WORK]: 'true', [E_ADMIN]: 'true' }),
      expect: (b) => b
        && b.status === 'activation_rejected'
        && Array.isArray(b.hits) && b.hits.length === 0
        && b.surfaceHasOwnerLoader === false,
    },
    {
      name: 'kv TRUE rejected zero owner load',
      env: enabledComposition({ [ENV_KV_EN]: 'TRUE' }),
      expect: (b) => b
        && b.status === 'config_invalid'
        && b.code === 'email_delta_kv_pins_invalid'
        && Array.isArray(b.hits) && b.hits.length === 0
        && b.runCode === 'email_delta_activation_impossible',
    },
    {
      name: 'kv 1 rejected zero owner load',
      env: enabledComposition({ [ENV_KV_EN]: '1' }),
      expect: (b) => b
        && b.status === 'config_invalid'
        && b.code === 'email_delta_kv_pins_invalid'
        && Array.isArray(b.hits) && b.hits.length === 0,
    },
  ];

  for (const sc of probeScenarios) {
    const ch = runChild(compositionProbeBody({ env: sc.env }));
    const b = parseChildJson(ch);
    ok(`probe: ${sc.name}`,
      ch.status === 0 && b && sc.expect(b)
      && b.r0Frozen === true && b.r0AssignRejected === true
      && b.life0Frozen === true && b.life0AssignRejected === true
      && b.surfaceFrozen === true && b.surfaceAssignRejected === true
      && b.readinessFrozen === true && b.readinessAssignRejected === true
      && b.lifeFrozen === true && b.lifeAssignRejected === true
      && b.hardFailFrozen === true && b.hardFailAssignRejected === true
      && b.exportsFrozen === true,
      `st=${ch.status} ${JSON.stringify(b)} err=${(ch.stderr || '').slice(0, 240)}`);
  }

  // Post-require ambient Object.freeze / Object.isFrozen replacement.
  {
    const ch = runChild(`
      'use strict';
      const realIsFrozen = Object.isFrozen;
      const mod = require(${JSON.stringify(COMP_PATH)});
      Object.freeze = function() { throw new Error(${JSON.stringify(PLANTED)}); };
      Object.isFrozen = function() { return false; };
      const c = mod.createEmailDeltaSunsetStagingRuntimeComposition({
        env: ${JSON.stringify(enabledComposition())},
      });
      const r = c.getReadiness();
      const life = c.getLifecycle();
      function assignHard(obj, key, val) {
        const before = obj[key];
        let threw = false;
        try { obj[key] = val; } catch (_) { threw = true; }
        return threw || obj[key] === before;
      }
      let hardFail = null;
      try { c.run(); } catch (e) { hardFail = e; }
      console.log(JSON.stringify({
        surfaceFrozen: realIsFrozen(c) === true,
        readinessFrozen: realIsFrozen(r) === true,
        lifeFrozen: realIsFrozen(life) === true,
        hardFailFrozen: hardFail && realIsFrozen(hardFail) === true,
        surfaceAssign: assignHard(c, 'run', null),
        readinessAssign: assignHard(r, 'status', 'hostile'),
        lifeAssign: assignHard(life, 'state', 'hostile'),
        hardFailAssign: hardFail ? assignHard(hardFail, 'code', 'hostile') : false,
        status: r && r.status,
        lifeState: life && life.state,
        hardFailCode: hardFail && hardFail.code,
        ambientLies: Object.isFrozen(c) === false,
        exportsFrozen: realIsFrozen(mod) === true,
      }));
    `);
    const b = parseChildJson(ch);
    ok('probe: post-require freeze/isFrozen poison — composition surfaces frozen',
      ch.status === 0 && b
      && b.surfaceFrozen && b.readinessFrozen && b.lifeFrozen && b.hardFailFrozen
      && b.surfaceAssign && b.readinessAssign && b.lifeAssign && b.hardFailAssign
      && b.status === 'composition_inert' && b.lifeState === 'inert'
      && b.hardFailCode === 'email_delta_activation_impossible'
      && b.ambientLies === true && b.exportsFrozen === true,
      JSON.stringify(b));
  }

  // Staff integration resolve-only block
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

  // Identity-free: readiness keys exact set (no envelope/token fields)
  {
    const r = resolveReady(enabledComposition());
    const keys = Reflect.ownKeys(r);
    ok('readiness keys exact frozen set',
      keys.length === READINESS_KEYS.length
      && keys.every((k) => READINESS_KEYS.includes(k))
      && !keys.some((k) => /token|envelope|cursor|secret|password|mail|address/i.test(String(k)))
      && noPlanted(r));
  }

  ok('no live graph fetch in composition/config',
    !/fetchInitialPage|fetchContinuationPage|runAuthorityBoundMessagesDeltaPage\s*\(/.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(cfgSrc)
    && !/new\s+ManagedIdentityCredential|new\s+CryptographyClient/.test(src + cfgSrc));

  // Ordinary Staff startup: requiring composition module under default env must not throw
  // and must leave readiness disabled (staff integration path).
  {
    const ch = runChild(`
      'use strict';
      const Module = require('module');
      const hits = [];
      const real = Module._load;
      Module._load = function(r, p, m) {
        if (typeof r === 'string' && (
          r === 'pg' || r.startsWith('@azure/') || r === 'https'
          || String(r).includes('email-authority-bound-messages-delta')
          || String(r).includes('email-grant-envelope-azure-kv')
          || String(r).includes('email-inbound-delta-state-store')
        )) {
          hits.push(r);
          throw new Error('blocked ' + r);
        }
        return real(r, p, m);
      };
      // Simulate ordinary Staff startup: no email-delta flags set.
      delete process.env.LUNA_EMAIL_DELTA_RUNTIME_COMPOSITION_ENABLED;
      delete process.env.LUNA_EMAIL_DELTA_WORKER_ENABLED;
      delete process.env.LUNA_EMAIL_DELTA_ADMIN_ENABLED;
      const mod = require(${JSON.stringify(COMP_PATH)});
      const r = mod.resolveEmailDeltaSunsetStagingRuntimeReadiness(process.env);
      console.log(JSON.stringify({
        ok: r && r.status === 'disabled' && r.ok === true && hits.length === 0,
        status: r && r.status,
        hits,
      }));
    `);
    const b = parseChildJson(ch);
    ok('probe: ordinary Staff startup path disabled + zero owner load',
      ch.status === 0 && b && b.ok, JSON.stringify(b));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
