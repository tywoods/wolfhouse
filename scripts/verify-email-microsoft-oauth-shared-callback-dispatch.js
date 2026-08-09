'use strict';
/** Gate 3 B3a1 — offline verifier for intent-disjoint shared OAuth callback dispatch. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const {
  createMicrosoftOauthSharedCallbackDispatch: createDispatch,
  DEPENDENCY_KEYS, OWNER_KEYS, PHASE_A_CALLBACK_ENABLED_ENV, PHASE_B_CALLBACK_ENABLED_ENV,
  SUNSET_DEPLOYMENT, PUBLIC_STATUS_INVALID, PUBLIC_STATUS_DECLINED, PUBLIC_STATUS_RECEIVED,
  PUBLIC_STATUS_UNAVAILABLE, PUBLIC_STATUS_OUTCOME_UNKNOWN,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE, ERROR_CODE,
} = require('./lib/email-microsoft-oauth-shared-callback-dispatch');
const {
  SQL_CONSUME_TRANSACTION: PHASE_A_SQL, SCOPES: PHASE_A_SCOPES,
  createPostgresOAuthTransactionRepository, createMicrosoftOAuthCallbackService,
} = require('./lib/email-microsoft-oauth-transaction-service');
const {
  SQL_CONSUME_PHASE_B_TRANSACTION: PHASE_B_SQL, createPostgresPhaseBOauthTransactionConsumer,
  createMicrosoftPhaseBOauthCallbackCompletionService,
  AUTHORIZATION_INTENT: PHASE_B_INTENT, SCOPE_VERSION: PHASE_B_SCOPE,
} = require('./lib/email-microsoft-phase-b-oauth-callback-completion');
const {
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
} = require('./lib/email-microsoft-delegated-oauth-contract');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const CODE = 'AuthCode-printable-1';
const SECRET = 'NEVER_LEAK_secret_material_xyz';
let pass = 0; let fail = 0;
function ok(n, c, d) {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); return true; }
  fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); return false;
}
function fr(o, keys) { const x = {}; for (const k of keys) x[k] = o[k]; return Object.freeze(x); }
function owner(over) { return fr({ clientId: CLIENT, authSessionId: SESSION, ...over }, ['clientId', 'authSessionId']); }
function q() { return fr({ state: STATE, code: CODE }, ['state', 'code']); }
function env(a, b, over) {
  return {
    LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    [PHASE_A_CALLBACK_ENABLED_ENV]: a ? 'true' : 'false',
    [PHASE_B_CALLBACK_ENABLED_ENV]: b ? 'true' : 'false', ...over,
  };
}
function so(r, s) {
  return r && Object.isFrozen(r) && Reflect.ownKeys(r).length === 1 && r.status === s
    && !JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(CODE);
}
function svc(impl) { return Object.freeze({ async accept(i, o) { return impl(i, o); } }); }
function dispatch(opts) {
  const c = { a: 0, b: 0, aC: 0, bC: 0 };
  const s = createDispatch(Object.freeze({
    env: opts.env || env(true, true),
    createPhaseACallback: () => {
      c.aC += 1;
      if (opts.aFactory) return opts.aFactory(c);
      return svc(async () => {
        c.a += 1;
        if (opts.aThrow) throw new Error(SECRET);
        return opts.aResult !== undefined ? opts.aResult : Object.freeze({ status: 'authorization_received' });
      });
    },
    createPhaseBCallback: () => {
      c.bC += 1;
      if (opts.bFactory) return opts.bFactory(c);
      return svc(async () => {
        c.b += 1;
        if (opts.bThrow) throw new Error(SECRET);
        return opts.bResult !== undefined ? opts.bResult : Object.freeze({ status: 'authorization_received' });
      });
    },
  }));
  return { s, c };
}
function bag(e) {
  return Object.freeze({
    env: e,
    createPhaseACallback: () => svc(async () => PUBLIC_STATUS_RECEIVED),
    createPhaseBCallback: () => svc(async () => PUBLIC_STATUS_RECEIVED),
  });
}
async function expectFail(fn) {
  try { await fn(); return false; } catch (e) { return e && e.code === ERROR_CODE; }
}

(async function main() {
  console.log('\n== B3a1 shared callback dispatch ==');
  ok('readiness wired/safe + deferred/inert (B3a2b route invokes; flags default-off)',
    EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION === true
    && EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE === true
    && DEPENDENCY_KEYS.join(',') === 'env,createPhaseACallback,createPhaseBCallback'
    && OWNER_KEYS.join(',') === 'clientId,authSessionId');

  {
    const n = dispatch({ env: env(false, false) });
    ok('neither → unavailable zero construct',
      so(await n.s.accept(q(), owner()), 'authorization_unavailable')
      && n.c.aC === 0 && n.c.bC === 0);
    const a = dispatch({ env: env(true, false) });
    ok('A-only', so(await a.s.accept(q(), owner()), 'authorization_received') && a.c.aC === 1 && a.c.bC === 0);
    const b = dispatch({ env: env(false, true) });
    ok('B-only', so(await b.s.accept(q(), owner()), 'authorization_received') && b.c.aC === 0 && b.c.bC === 1);
    const bothA = dispatch({ env: env(true, true), aResult: Object.freeze({ status: 'authorization_received' }) });
    ok('both A-received → no B', so(await bothA.s.accept(q(), owner()), 'authorization_received') && bothA.c.bC === 0);
    const bothB = dispatch({
      env: env(true, true),
      aResult: Object.freeze({ status: 'invalid_or_expired' }),
      bResult: Object.freeze({ status: 'authorization_received' }),
    });
    const rB = await bothB.s.accept(q(), owner());
    ok('both A-invalid → B consumes', so(rB, 'authorization_received')
      && bothB.c.aC === 1 && bothB.c.bC === 1 && JSON.stringify(rB) === JSON.stringify(PUBLIC_STATUS_RECEIVED));
  }
  for (const [lab, st, pub] of [
    ['declined', 'authorization_declined', PUBLIC_STATUS_DECLINED],
    ['received', 'authorization_received', PUBLIC_STATUS_RECEIVED],
    ['unavailable', 'authorization_unavailable', PUBLIC_STATUS_UNAVAILABLE],
    ['outcome_unknown', 'outcome_unknown', PUBLIC_STATUS_OUTCOME_UNKNOWN],
  ]) {
    const d = dispatch({
      env: env(true, true), aResult: Object.freeze({ status: st }),
      bResult: Object.freeze({ status: 'authorization_received' }),
    });
    const r = await d.s.accept(q(), owner());
    ok(`A ${lab} → no B`, so(r, st) && d.c.bC === 0 && JSON.stringify(r) === JSON.stringify(pub));
  }
  {
    const d = dispatch({ env: env(true, true), aThrow: true });
    ok('A throw sanitized no B', await expectFail(() => d.s.accept(q(), owner())) && d.c.bC === 0);
    const m = dispatch({
      env: env(true, true), aResult: Object.freeze({ status: 'invalid_or_expired', extra: SECRET }),
    });
    ok('malformed result no B', await expectFail(() => m.s.accept(q(), owner())) && m.c.bC === 0);
    const n = dispatch({ env: env(true, true), aResult: Object.freeze({ status: 'nope' }) });
    ok('non-allowlist status', await expectFail(() => n.s.accept(q(), owner())));
  }
  {
    const d = dispatch({ env: env(true, false) });
    await d.s.accept(q(), owner());
    ok('reentrancy', await expectFail(() => d.s.accept(q(), owner())) && d.c.aC === 1 && d.c.a === 1);
  }
  {
    let go; const gate = new Promise((r) => { go = r; });
    const d = dispatch({
      env: env(true, false),
      aFactory: (c) => svc(async () => {
        c.a += 1; await gate; return Object.freeze({ status: 'authorization_received' });
      }),
    });
    const p1 = d.s.accept(q(), owner());
    const e2 = await expectFail(() => d.s.accept(q(), owner()));
    go();
    ok('concurrent second rejected', so(await p1, 'authorization_received') && e2 && d.c.a === 1);
  }
  {
    const d = dispatch({
      env: env(true, true), aResult: Object.freeze({ status: 'invalid_or_expired' }), bThrow: true,
    });
    ok('B fail after A invalid no retry',
      await expectFail(() => d.s.accept(q(), owner())) && d.c.aC === 1 && d.c.bC === 1 && d.c.b === 1);
  }

  // Hostile surfaces
  {
    let hits = 0;
    const bad = {};
    for (const k of ['LUNA_DEPLOYMENT', PHASE_A_CALLBACK_ENABLED_ENV, PHASE_B_CALLBACK_ENABLED_ENV]) {
      Object.defineProperty(bad, k, { get() { hits += 1; return 'true'; }, enumerable: true });
    }
    ok('env accessors zero getters', await expectFail(async () => createDispatch(bag(bad))) && hits === 0);
    hits = 0;
    const pe = new Proxy(env(true, true), {
      get(t, p, r) { hits += 1; return Reflect.get(t, p, r); },
      getOwnPropertyDescriptor(t, p) { hits += 1; return Reflect.getOwnPropertyDescriptor(t, p); },
      ownKeys(t) { hits += 1; return Reflect.ownKeys(t); },
    });
    ok('env Proxy zero traps', await expectFail(async () => createDispatch(bag(pe))) && hits === 0);
    const eSym = env(true, true); eSym[Symbol('x')] = 'z';
    ok('env symbol rejected', await expectFail(async () => createDispatch(bag(eSym))));
    ok('non-sunset pin rejected', await expectFail(async () => createDispatch(bag({
      LUNA_DEPLOYMENT: 'production',
      [PHASE_A_CALLBACK_ENABLED_ENV]: 'true', [PHASE_B_CALLBACK_ENABLED_ENV]: 'true',
    }))));
    const d = createDispatch(bag({
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      [PHASE_A_CALLBACK_ENABLED_ENV]: true, [PHASE_B_CALLBACK_ENABLED_ENV]: 'TRUE',
    }));
    ok('boolean/TRUE → unavailable', so(await d.accept(q(), owner()), 'authorization_unavailable'));
  }
  {
    let hits = 0;
    const d = dispatch({ env: env(true, false) });
    ok('query Proxy', await expectFail(() => d.s.accept(
      new Proxy(q(), { get(t, p, r) { hits += 1; return Reflect.get(t, p, r); } }), owner(),
    )) && hits === 0 && d.c.aC === 0);
    hits = 0;
    const d2 = dispatch({ env: env(true, false) });
    ok('owner Proxy', await expectFail(() => d2.s.accept(
      q(), new Proxy(owner(), { get(t, p, r) { hits += 1; return Reflect.get(t, p, r); } }),
    )) && hits === 0 && d2.c.aC === 0);
    const d3 = dispatch({ env: env(false, false) });
    hits = 0;
    ok('neither before proxy touch', so(await d3.s.accept(new Proxy({ state: STATE, code: CODE }, {
      get(t, p, r) { hits += 1; return Reflect.get(t, p, r); },
    }), owner()), 'authorization_unavailable') && hits === 0);
    const d4 = dispatch({
      env: env(true, false),
      aResult: new Proxy(Object.freeze({ status: 'authorization_received' }), {
        get(t, p, r) { return p === 'then' ? undefined : Reflect.get(t, p, r); },
      }),
    });
    ok('result Proxy rejected', await expectFail(() => d4.s.accept(q(), owner())));
    let saw = null;
    const d5 = dispatch({
      env: env(true, false),
      aFactory: (c) => svc(async (_i, o) => {
        c.a += 1; saw = o; return Object.freeze({ status: 'invalid_or_expired' });
      }),
    });
    const r = await d5.s.accept(q(), owner({ clientId: OTHER }));
    ok('wrong client status-only', so(r, 'invalid_or_expired') && saw.clientId === OTHER
      && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_INVALID) && Object.isFrozen(saw));
  }
  // Review hostiles: pre-child snap + sync Proxy result trap0 + order variants
  {
    function acc(keys, vals) {
      const o = {}; let h = 0;
      keys.forEach((k, i) => Object.defineProperty(o, k, { get() { h += 1; return vals[i]; }, enumerable: true }));
      return { o, hits: () => h };
    }
    const qa = acc(['state', 'code'], [STATE, CODE]); const dQ = dispatch({ env: env(true, false) });
    ok('query accessor getter hits0 child0',
      await expectFail(() => dQ.s.accept(qa.o, owner())) && qa.hits() === 0 && dQ.c.aC === 0);
    const oa = acc(['clientId', 'authSessionId'], [CLIENT, SESSION]); const dO = dispatch({ env: env(true, false) });
    ok('owner accessor hits0 child0',
      await expectFail(() => dO.s.accept(q(), oa.o)) && oa.hits() === 0 && dO.c.aC === 0);
    const qSym = { state: STATE, code: CODE }; qSym[Symbol('x')] = 'z';
    const oSym = { clientId: CLIENT, authSessionId: SESSION }; oSym[Symbol('y')] = 'z';
    const dSq = dispatch({ env: env(true, false) }); const dSo = dispatch({ env: env(true, false) });
    ok('symbol query/owner child0',
      await expectFail(() => dSq.s.accept(qSym, owner())) && dSq.c.aC === 0
      && await expectFail(() => dSo.s.accept(q(), oSym)) && dSo.c.aC === 0);
    let traps = 0;
    const dSync = dispatch({
      env: env(true, false),
      aFactory: (c) => Object.freeze({
        accept() { c.a += 1; return new Proxy({}, { get() { traps += 1; }, ownKeys() { traps += 1; return []; } }); },
      }),
    });
    ok('sync transparent Proxy result trap0',
      await expectFail(() => dSync.s.accept(q(), owner())) && traps === 0 && dSync.c.aC === 1);
    const dEx = dispatch({ env: env(true, false) }); const dHy = dispatch({ env: env(true, false) });
    ok('query extras/hybrid child0',
      await expectFail(() => dEx.s.accept(Object.freeze({ state: STATE, code: CODE, extra: SECRET }), owner()))
      && await expectFail(() => dHy.s.accept(
        Object.freeze({ state: STATE, code: CODE, error: 'access_denied' }), owner()))
      && dEx.c.aC === 0 && dHy.c.aC === 0);
    ok('valid order variants',
      so(await dispatch({ env: env(true, false) }).s.accept(Object.freeze({ code: CODE, state: STATE }), owner()), 'authorization_received')
      && so(await dispatch({ env: env(true, false) }).s.accept(
        Object.freeze({ state: STATE, code: CODE, session_state: 'ss-1' }), owner()), 'authorization_received')
      && so(await dispatch({ env: env(true, false) }).s.accept(
        Object.freeze({ error: 'access_denied', state: STATE }), owner()), 'authorization_received'));
    // Unavoidable: Promise.resolve(Proxy) may [[Get]] then during resolution.
    const dResP = dispatch({
      env: env(true, false),
      aFactory: (c) => Object.freeze({
        accept() {
          c.a += 1;
          return Promise.resolve(new Proxy(Object.freeze({ status: 'authorization_received' }), {
            get(t, p, r) { return p === 'then' ? undefined : Reflect.get(t, p, r); },
          }));
        },
      }),
    });
    ok('Promise-resolved Proxy rejected post-await',
      await expectFail(() => dResP.s.accept(q(), owner())) && dResP.c.aC === 1);
  }

  console.log('\n== Intent-disjoint SQL / scopes ==');
  ok('A/B SQL intent-disjoint + scopes',
    /authorization_intent='initial_connect'/.test(PHASE_A_SQL)
    && /scope_version='phase_a_v2'/.test(PHASE_A_SQL) && /prior_grant_generation IS NULL/.test(PHASE_A_SQL)
    && /authorization_intent='phase_b_reauthorization'/.test(PHASE_B_SQL)
    && /scope_version='phase_b_v1'/.test(PHASE_B_SQL) && PHASE_A_SQL !== PHASE_B_SQL
    && PHASE_B_INTENT === 'phase_b_reauthorization' && PHASE_B_SCOPE === 'phase_b_v1'
    && PHASE_A_SCOPES === 'openid profile offline_access User.Read Mail.ReadBasic'
    && EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.join(',') === 'User.Read,Mail.ReadWrite,Mail.Send');
  {
    const rows = [];
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const db = {
      async query(sql, params) {
        const s = norm(sql); const isA = s === norm(PHASE_A_SQL); const isB = s === norm(PHASE_B_SQL);
        if (!isA && !isB) throw new Error('unexpected_sql');
        const [stateHash, clientId, authSessionId, now] = params;
        const hit = rows.find((r) => r.state_hash.equals(stateHash) && r.client_id === clientId
          && r.auth_session_id === authSessionId && r.consumed_at == null && r.expires_at > now
          && (isA
            ? r.authorization_intent === 'initial_connect' && r.scope_version === 'phase_a_v2' && r.prior_grant_generation == null
            : r.authorization_intent === 'phase_b_reauthorization' && r.scope_version === 'phase_b_v1' && r.prior_grant_generation != null));
        if (!hit) return { rows: [] };
        hit.consumed_at = now;
        const base = {
          id: hit.id, location_id: hit.location_id, staff_user_id: hit.staff_user_id,
          code_verifier: hit.code_verifier, nonce: hit.nonce, endpoint_id: hit.endpoint_id,
        };
        return isA ? { rows: [base] } : {
          rows: [{
            ...base, authorization_intent: hit.authorization_intent,
            scope_version: hit.scope_version, prior_grant_generation: hit.prior_grant_generation,
          }],
        };
      },
    };
    const aRepo = createPostgresOAuthTransactionRepository(db);
    const bRepo = createPostgresPhaseBOauthTransactionConsumer(db);
    const plant = (hash, intent, scope, prior) => rows.push({
      id: crypto.randomUUID(), client_id: CLIENT, location_id: CLIENT, staff_user_id: CLIENT,
      auth_session_id: SESSION, endpoint_id: CLIENT, state_hash: hash, code_verifier: 'v'.repeat(43),
      nonce: 'n'.repeat(43), expires_at: new Date('2099-01-01T00:00:00Z'), consumed_at: null,
      authorization_intent: intent, scope_version: scope, prior_grant_generation: prior,
    });
    const aH = Buffer.alloc(32, 1); const bH = Buffer.alloc(32, 2); const aH2 = Buffer.alloc(32, 3);
    plant(aH, 'initial_connect', 'phase_a_v2', null); plant(bH, 'phase_b_reauthorization', 'phase_b_v1', 7);
    plant(aH2, 'initial_connect', 'phase_a_v2', null);
    const now = new Date();
    ok('A takes A / rejects B; B takes B / rejects A',
      Boolean(await aRepo.consume({ stateHash: aH, clientId: CLIENT, authSessionId: SESSION, now }))
      && (await aRepo.consume({ stateHash: bH, clientId: CLIENT, authSessionId: SESSION, now })) == null
      && Boolean(await bRepo.consume({ stateHash: bH, clientId: CLIENT, authSessionId: SESSION, now }))
      && (await bRepo.consume({ stateHash: aH2, clientId: CLIENT, authSessionId: SESSION, now })) == null);
  }

  console.log('\n== Source / package / budget ==');
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js'), 'utf8');
    ok('source pure composition (no route/DB require)',
      !/require\([^)]*staff-query-api/.test(src) && !/require\([^)]*staff-email-oauth-routes/.test(src)
      && !/require\([^)]*oauth-callback-completion/.test(src) && !/require\([^)]*oauth-transaction-service/.test(src)
      && !/\.query\s*\(/.test(src) && !/\bexpress\b/.test(src) && !/createServer/.test(src)
      && /util\.types/.test(src) && /isProxy/.test(src));
    const probe = spawnSync(process.execPath, ['-e', `
      const m=require(${JSON.stringify(path.join(ROOT, 'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js'))});
      if(m.EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED!==true) process.exit(2);
      if(m.EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE!==true) process.exit(3);
      if(m.EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT!==true) process.exit(4);
      if(m.EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION!==true) process.exit(5);
      console.log('OK');
    `], { encoding: 'utf8', env: { ...process.env, LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: undefined,
      LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: undefined } });
    ok('import inert; wired/safe; deferred (flags still default-off)', probe.status === 0 && /OK/.test(probe.stdout || ''));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package script', pkg.scripts['verify:email-microsoft-oauth-shared-callback-dispatch']
      === 'node scripts/verify-email-microsoft-oauth-shared-callback-dispatch.js');
    const dLoc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-microsoft-oauth-shared-callback-dispatch.js'), 'utf8').split(/\r?\n/).length;
    const vLoc = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).length;
    const sliceBase = '58b92a51ed6b2b97959d167d1e29c2c467338af4';
    const td = spawnSync('git', ['diff', '--numstat', `${sliceBase}..HEAD`, '--',
      'scripts/lib/email-microsoft-oauth-transaction-service.js'], { cwd: ROOT, encoding: 'utf8' });
    const m = (td.stdout || '').trim().match(/^(\d+)\s+(\d+)/);
    const txnNet = m ? Number(m[1]) - Number(m[2]) : Number.NaN;
    const implNet = dLoc + txnNet;
    ok(`budget impl=${implNet} ver=${vLoc} total=${implNet + vLoc}`,
      Number.isSafeInteger(txnNet) && implNet <= 280 && vLoc <= 385 && implNet + vLoc <= 665);
    ok('A/B factories present', typeof createMicrosoftOAuthCallbackService === 'function'
      && typeof createMicrosoftPhaseBOauthCallbackCompletionService === 'function');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
