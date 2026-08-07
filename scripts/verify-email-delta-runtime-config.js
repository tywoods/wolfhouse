'use strict';

/**
 * verify:email-delta-runtime-config — offline hostile gate (fresh-process probes).
 *
 * Default-off independent flags; worker/admin true rejected; composition-only
 * pin validation; raw byte-exact KV enabled gate; pinned-intrinsic resistance;
 * zero #410/KV/state/crypto owner load on import/disabled/rejected/composition.
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

function runChild(body, envExtra) {
  return spawnSync(process.execPath, ['-e', body], {
    encoding: 'utf8',
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: '', ...(envExtra || {}) },
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

/** Forbidden module id substrings for inert config paths. */
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

function probeBody(actionJson) {
  // Shared fresh-process harness: instrument Module._load + fake timers/pg methods.
  return `
    'use strict';
    const Module = require('module');
    const hits = [];
    const dbMethodHits = [];
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
    // Fake timer/DB ambient after require of config would still be free to call;
    // wrap global timers to detect accidental scheduling.
    const _setTimeout = global.setTimeout;
    const _setInterval = global.setInterval;
    global.setTimeout = function(...a) { timerHits.push('setTimeout'); return _setTimeout(...a); };
    global.setInterval = function(...a) { timerHits.push('setInterval'); return _setInterval(...a); };

    const action = ${JSON.stringify(actionJson)};
    const mod = require(${JSON.stringify(CFG_PATH)});

    // Save genuine freeze/isFrozen BEFORE ambient poison (post-require).
    const realIsFrozen = Object.isFrozen;
    const realFreeze = Object.freeze;

    // Ambient intrinsic monkeypatch AFTER require — pins must resist.
    const poison = function() { throw new Error(${JSON.stringify(PLANTED)}); };
    Object.getOwnPropertyDescriptor = poison;
    Object.getPrototypeOf = poison;
    Reflect.ownKeys = poison;
    Object.freeze = poison;
    Object.isFrozen = function() { return false; };
    if (utilTypesAvailable()) {
      try { require('util').types.isProxy = function() { return false; }; } catch (_) {}
    }
    function utilTypesAvailable() {
      try { return !!(require('util').types); } catch { return false; }
    }

    let result = null;
    let errCode = null;
    try {
      if (action.kind === 'parse') {
        result = mod.parseEmailDeltaRuntimeConfig(action.env || {});
      } else if (action.kind === 'flag') {
        result = { flag: mod.isEmailDeltaCompositionFlagEnabled(action.env || {}) };
      }
    } catch (e) {
      errCode = e && e.code;
    }

    // Nested callable capability escape: exports must not expose owner factories.
    const exportKeys = Object.keys(mod);
    const nestedCallables = [];
    for (const k of exportKeys) {
      const v = mod[k];
      if (typeof v === 'function' && /create|withPg|Factory|Owner|Transport|Store|Session|Provider/i.test(k)
          && k !== 'parseEmailDeltaRuntimeConfig'
          && k !== 'isEmailDeltaCompositionFlagEnabled'
          && k !== 'failure') {
        nestedCallables.push(k);
      }
    }
    for (const k of exportKeys) {
      const v = mod[k];
      if (v && typeof v === 'object') {
        for (const sk of Object.keys(v)) {
          if (typeof v[sk] === 'function' && /create|withPg|Factory/i.test(sk)) {
            nestedCallables.push(k + '.' + sk);
          }
        }
      }
    }

    // Genuine freeze under poisoned ambient freeze/isFrozen.
    let genuinelyFrozen = false;
    let assignRejected = false;
    if (result && typeof result === 'object') {
      genuinelyFrozen = realIsFrozen(result) === true;
      const beforeOk = result.ok;
      const beforeStatus = result.status;
      let threw = false;
      try { result.ok = 'hostile'; result.status = 'hostile'; } catch (_) { threw = true; }
      assignRejected = threw
        || (result.ok === beforeOk && result.status === beforeStatus);
    }

    // failure() error remains frozen under ambient freeze poison.
    let failFrozen = false;
    let failAssignRejected = false;
    try {
      const err = mod.failure();
      failFrozen = realIsFrozen(err) === true;
      const beforeCode = err.code;
      let threw = false;
      try { err.code = 'hostile'; } catch (_) { threw = true; }
      failAssignRejected = threw || err.code === beforeCode;
    } catch (_) {}

    console.log(JSON.stringify({
      hits,
      timerHits,
      dbMethodHits,
      errCode,
      status: result && result.status,
      ok: result && result.ok,
      code: result && result.code,
      flag: result && result.flag,
      composition_enabled: result && result.composition_enabled,
      kv_pins_valid: result && result.kv_pins_valid,
      worker_activation_possible: result && result.worker_activation_possible,
      nestedCallables,
      exportHasCreate: typeof mod.createEmailDeltaSunsetStagingRuntimeComposition === 'function'
        || typeof mod.createLazyDurableOperationFactory === 'function'
        || typeof mod.createInboundEmailDeltaStateStore === 'function'
        || typeof mod.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition === 'function'
        || typeof mod.withPgClient === 'function',
      genuinelyFrozen,
      assignRejected,
      failFrozen,
      failAssignRejected,
      exportsFrozen: realIsFrozen(mod) === true,
    }));
  `;
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
    && mig.includes('ms_messages_delta_v1'));
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
  ok('module pins freeze + security-critical intrinsics at init',
    /PINNED_OBJECT_FREEZE/.test(src)
    && /PINNED_IS_FROZEN/.test(src)
    && /PINNED_GET_OWN_PROPERTY_DESCRIPTOR/.test(src)
    && /PINNED_GET_PROTOTYPE_OF/.test(src)
    && /PINNED_REFLECT_OWN_KEYS/.test(src)
    && /PINNED_HAS_OWN|safeHasOwn/.test(src)
    && /PINNED_IS_PROXY/.test(src)
    && /envOwnKeyDescriptorSurfaceAccepted|pinnedFreeze/.test(src)
    && !/\bObject\.freeze\s*\(/.test(src.replace(/typeof Object\.freeze/g, '')));
  ok('no top-level require of #410/KV/state owner graph',
    !/require\s*\(\s*['"]\.\/email-grant-envelope-azure-kv/.test(src)
    && !/require\s*\(\s*['"]\.\/email-inbound-delta-state-store['"]/.test(src)
    && !/require\s*\(\s*['"]\.\/email-authority-bound/.test(src)
    && !/require\s*\(\s*['"]\.\/email-delegated-grant/.test(src)
    && !/require\s*\(\s*['"]\.\/email-microsoft-graph/.test(src)
    && !/require\s*\(\s*['"]pg['"]\s*\)/.test(src)
    && !/require\s*\(\s*['"]@azure\//.test(src));
  ok('no public owner-loader / createLazy / withPgClient export',
    !/createLazyDurable|createLazyDurableOwnersAccessor|getLazyDurableOwners/.test(src)
    && !/module\.exports[\s\S]*withPgClient/.test(src)
    && typeof M.createLazyDurableOperationFactory !== 'function'
    && typeof M.withPgClient !== 'function'
    && typeof M.createInboundEmailDeltaStateStore !== 'function'
    && typeof M.createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition !== 'function');

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

  // Exact KV raw booleans: only byte-exact 'true' accepted when composition on.
  for (const [label, val] of [
    ['TRUE', 'TRUE'],
    ['True', 'True'],
    ['1', '1'],
    ['yes', 'yes'],
    [' true', ' true'],
    ['true ', 'true '],
    ['true\\n', 'true\n'],
    ['false', 'false'],
    ['', ''],
  ]) {
    const r = parseCfg(enabledComposition({ [ENV_KV_COMPOSITION_ENABLED]: val }));
    ok(`kv raw ${label} rejected (zero-loose)`,
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && r.code === 'email_delta_kv_pins_invalid'
      && r.kv_pins_valid === false
      && noPlanted(r),
      `got ${r && r.status}/${r && r.code}`);
  }
  {
    const r = parseCfg(enabledComposition({ [ENV_KV_COMPOSITION_ENABLED]: 'true' }));
    ok('kv raw exact true accepted with pins',
      r.ok === true && r.status === CONFIG_STATUS.COMPOSITION_INERT && r.kv_pins_valid === true);
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

  // Proxy / accessor / symbol / nonenumerable complete-surface traps (fail closed)
  {
    const proxyEnv = new Proxy({ [E_COMP]: 'true' }, {
      get() { throw new Error(PLANTED); },
      getOwnPropertyDescriptor() { throw new Error(PLANTED); },
      ownKeys() { throw new Error(PLANTED); },
    });
    const r = parseCfg(proxyEnv);
    ok('proxy env fail closed + no planted',
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && noPlanted(r) && noPlanted(r.code));
  }
  {
    const env = {};
    Object.defineProperty(env, E_COMP, {
      enumerable: true,
      get() { throw new Error(PLANTED); },
    });
    const r = parseCfg(env);
    ok('accessor flag fail closed',
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && noPlanted(r));
  }

  // Complete env own-key/descriptor surface: symbol / nonenumerable / accessor
  // planted under composition-enabled AND disabled — all fail closed.
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
      const r = parseCfg(env);
      ok(`symbol own key fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r)
        && isEmailDeltaCompositionFlagEnabled(env) === false,
        `got ${r && r.status}`);
    }
    {
      const env = exactEnv(baseEnv);
      Object.defineProperty(env, 'UNRELATED_HOSTILE_NONENUM', {
        enumerable: false,
        value: PLANTED,
      });
      const r = parseCfg(env);
      ok(`unrelated nonenumerable fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r)
        && isEmailDeltaCompositionFlagEnabled(env) === false,
        `got ${r && r.status}`);
    }
    {
      const env = exactEnv(baseEnv);
      Object.defineProperty(env, 'UNRELATED_HOSTILE_ACCESSOR', {
        enumerable: true,
        get() { throw new Error(PLANTED); },
      });
      const r = parseCfg(env);
      ok(`unrelated accessor fail closed (${label})`,
        r.ok === false
        && r.status === CONFIG_STATUS.CONFIG_INVALID
        && noPlanted(r)
        && isEmailDeltaCompositionFlagEnabled(env) === false,
        `got ${r && r.status}`);
    }
  }

  // Nonenumerable selected flag fails closed on complete surface (before reads).
  {
    const env = enabledComposition();
    Object.defineProperty(env, E_WORK, {
      enumerable: false,
      value: 'true',
    });
    const r = parseCfg(env);
    ok('nonenumerable worker true fail closed before selected reads',
      r.ok === false
      && r.status === CONFIG_STATUS.CONFIG_INVALID
      && r.worker_enabled === false
      && noPlanted(r));
  }

  // Unknown ordinary string env vars remain allowed.
  {
    const r = parseCfg(enabledComposition({ UNRELATED_ORDINARY_STRING: 'hello' }));
    ok('unknown ordinary string env var allowed',
      r.ok === true
      && r.status === CONFIG_STATUS.COMPOSITION_INERT
      && noPlanted(r));
  }

  // Ambient process.env not mutated
  {
    const before = process.env[E_COMP];
    const r = parseCfg(undefined);
    ok('undefined env uses process.env safely',
      r && typeof r.status === 'string' && noPlanted(r)
      && process.env[E_COMP] === before);
  }

  // ── Fresh-process behavioral probes ────────────────────────────────────
  const probeCases = [
    {
      name: 'import+disabled: zero owner/pg/azure/https load',
      action: { kind: 'parse', env: {} },
      expect: (b) => b
        && b.status === 'disabled'
        && b.ok === true
        && Array.isArray(b.hits) && b.hits.length === 0
        && Array.isArray(b.timerHits) && b.timerHits.length === 0
        && b.exportHasCreate === false
        && Array.isArray(b.nestedCallables) && b.nestedCallables.length === 0,
    },
    {
      name: 'composition-only: zero owner/pg/azure/https load + inert',
      action: { kind: 'parse', env: enabledComposition() },
      expect: (b) => b
        && b.status === 'composition_inert'
        && b.ok === true
        && b.kv_pins_valid === true
        && Array.isArray(b.hits) && b.hits.length === 0
        && Array.isArray(b.timerHits) && b.timerHits.length === 0
        && b.exportHasCreate === false
        && Array.isArray(b.nestedCallables) && b.nestedCallables.length === 0,
    },
    {
      name: 'worker rejected: zero owner load',
      action: { kind: 'parse', env: enabledComposition({ [E_WORK]: 'true' }) },
      expect: (b) => b
        && b.status === 'activation_rejected'
        && b.ok === false
        && b.worker_activation_possible === false
        && Array.isArray(b.hits) && b.hits.length === 0
        && b.exportHasCreate === false,
    },
    {
      name: 'admin rejected: zero owner load',
      action: { kind: 'parse', env: enabledComposition({ [E_ADMIN]: 'true' }) },
      expect: (b) => b
        && b.status === 'activation_rejected'
        && b.ok === false
        && Array.isArray(b.hits) && b.hits.length === 0,
    },
    {
      name: 'kv TRUE rejected: zero owner load',
      action: {
        kind: 'parse',
        env: enabledComposition({ [ENV_KV_COMPOSITION_ENABLED]: 'TRUE' }),
      },
      expect: (b) => b
        && b.status === 'config_invalid'
        && b.code === 'email_delta_kv_pins_invalid'
        && Array.isArray(b.hits) && b.hits.length === 0,
    },
    {
      name: 'kv 1 rejected: zero owner load',
      action: {
        kind: 'parse',
        env: enabledComposition({ [ENV_KV_COMPOSITION_ENABLED]: '1' }),
      },
      expect: (b) => b
        && b.status === 'config_invalid'
        && b.code === 'email_delta_kv_pins_invalid'
        && Array.isArray(b.hits) && b.hits.length === 0,
    },
  ];

  for (const tc of probeCases) {
    const ch = runChild(probeBody(tc.action));
    const b = parseChildJson(ch);
    ok(`probe: ${tc.name}`,
      ch.status === 0 && b && tc.expect(b)
      && b.genuinelyFrozen === true
      && b.assignRejected === true
      && b.failFrozen === true
      && b.failAssignRejected === true
      && b.exportsFrozen === true,
      `st=${ch.status} ${JSON.stringify(b)} err=${(ch.stderr || '').slice(0, 200)}`);
  }

  // Hostile proxy env under ambient monkeypatch still fail-closed
  {
    const ch = runChild(`
      'use strict';
      const realIsFrozen = Object.isFrozen;
      const mod = require(${JSON.stringify(CFG_PATH)});
      Object.getOwnPropertyDescriptor = () => { throw new Error(${JSON.stringify(PLANTED)}); };
      Object.getPrototypeOf = () => { throw new Error(${JSON.stringify(PLANTED)}); };
      Reflect.ownKeys = () => { throw new Error(${JSON.stringify(PLANTED)}); };
      Object.freeze = () => { throw new Error(${JSON.stringify(PLANTED)}); };
      Object.isFrozen = () => false;
      const proxyEnv = new Proxy({ ${JSON.stringify(E_COMP)}: 'true' }, {
        get() { throw new Error(${JSON.stringify(PLANTED)}); },
        getOwnPropertyDescriptor() { throw new Error(${JSON.stringify(PLANTED)}); },
        ownKeys() { throw new Error(${JSON.stringify(PLANTED)}); },
      });
      const r = mod.parseEmailDeltaRuntimeConfig(proxyEnv);
      const s = JSON.stringify(r);
      let assignRejected = false;
      try { r.ok = 'hostile'; assignRejected = r.ok === false; } catch (_) { assignRejected = true; }
      console.log(JSON.stringify({
        ok: r && r.ok === false && !s.includes(${JSON.stringify(PLANTED)}),
        status: r && r.status,
        genuinelyFrozen: realIsFrozen(r) === true,
        assignRejected,
      }));
    `);
    const b = parseChildJson(ch);
    ok('probe: hostile proxy + ambient freeze/intrinsic poison fail-closed',
      ch.status === 0 && b && b.ok && b.genuinelyFrozen && b.assignRejected,
      JSON.stringify(b));
  }

  // Post-require ambient Object.freeze / Object.isFrozen replacement:
  // returned readiness remains genuinely frozen; assignments rejected.
  {
    const ch = runChild(`
      'use strict';
      const realIsFrozen = Object.isFrozen;
      const mod = require(${JSON.stringify(CFG_PATH)});
      Object.freeze = function() { throw new Error(${JSON.stringify(PLANTED)}); };
      Object.isFrozen = function() { return false; };
      const disabled = mod.parseEmailDeltaRuntimeConfig({});
      const inertEnv = ${JSON.stringify(enabledComposition())};
      const inert = mod.parseEmailDeltaRuntimeConfig(inertEnv);
      const err = mod.failure();
      function assignHard(obj, key, val) {
        const before = obj[key];
        let threw = false;
        try { obj[key] = val; } catch (_) { threw = true; }
        return threw || obj[key] === before;
      }
      console.log(JSON.stringify({
        disabledFrozen: realIsFrozen(disabled) === true,
        disabledAssign: assignHard(disabled, 'status', 'hostile'),
        disabledStatus: disabled && disabled.status,
        inertFrozen: realIsFrozen(inert) === true,
        inertAssign: assignHard(inert, 'ok', 'hostile'),
        inertStatus: inert && inert.status,
        errFrozen: realIsFrozen(err) === true,
        errAssign: assignHard(err, 'code', 'hostile'),
        exportsFrozen: realIsFrozen(mod) === true,
        ambientIsFrozenLies: Object.isFrozen(disabled) === false,
      }));
    `);
    const b = parseChildJson(ch);
    ok('probe: post-require freeze/isFrozen poison — surfaces genuinely frozen',
      ch.status === 0 && b
      && b.disabledFrozen && b.disabledAssign && b.disabledStatus === 'disabled'
      && b.inertFrozen && b.inertAssign && b.inertStatus === 'composition_inert'
      && b.errFrozen && b.errAssign
      && b.exportsFrozen
      && b.ambientIsFrozenLies === true,
      JSON.stringify(b));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
