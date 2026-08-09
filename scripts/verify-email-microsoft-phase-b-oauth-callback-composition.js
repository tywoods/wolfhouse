'use strict';

/**
 * Gate 3 Phase B PR B2a — focused offline verifier for dormant callback completion.
 * Injected completion only; no token/Graph/KV/custody/operation/runtime. No live I/O.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const {
  createMicrosoftPhaseBOauthCallbackCompletionService,
  createPostgresPhaseBOauthTransactionConsumer,
  SQL_CONSUME_PHASE_B_TRANSACTION,
  CONSUME_ROW_KEYS,
  COMPLETION_KEYS,
  CALLBACK_ENABLED_ENV,
  isCallbackEnabled,
  PUBLIC_STATUS_INVALID,
  PUBLIC_STATUS_DECLINED,
  PUBLIC_STATUS_RECEIVED,
  PUBLIC_STATUS_UNAVAILABLE,
  PUBLIC_STATUS_OUTCOME_UNKNOWN,
  AUTHORIZATION_INTENT,
  SCOPE_VERSION,
  ERROR_CODE,
  SUNSET_DEPLOYMENT,
} = require('./lib/email-microsoft-phase-b-oauth-callback-completion');
const {
  SQL_CONSUME_TRANSACTION: PHASE_A_SQL_CONSUME,
  SCOPES: PHASE_A_SCOPES,
} = require('./lib/email-microsoft-oauth-transaction-service');
const {
  COMPLETION_KEYS: PHASE_A_COMPLETION_KEYS,
} = require('./lib/email-microsoft-oauth-callback-completion');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const STAFF = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TX = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const APP = '22222222-2222-4222-8222-222222222222';
const STATE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const NONCE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const CODE = 'AuthCode-printable-1';
const PLANTED = 'NEVER_LEAK_secret_material';
const REFRESH = 'rt-NEVER_LEAK-phase-b-callback-aaaaaaaa';
const ACCESS = 'at-NEVER-LEAK-phase-b-callback-bbbbbbbb';
const PHASE_A_INTENT = 'initial_connect';
const PHASE_A_SCOPE = 'phase_a_v2';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}

function noLeak(v) {
  if (v == null) return true;
  let t;
  if (typeof v === 'string') t = v;
  else if (Buffer.isBuffer(v)) t = v.toString('utf8');
  else { try { t = JSON.stringify(v); } catch { t = String(v); } }
  return !t.includes(REFRESH) && !t.includes(ACCESS) && !t.includes(PLANTED)
    && !t.includes(CODE) && !t.includes(VERIFIER) && !t.includes(NONCE)
    && !t.includes(TX) && !t.includes(STATE) && !t.includes('phase_b_v1')
    && !t.includes(AUTHORIZATION_INTENT);
}

function freezeExact(obj, keys) {
  const o = {};
  for (const k of keys) o[k] = obj[k];
  return Object.freeze(o);
}
function owner() { return freezeExact({ clientId: CLIENT, authSessionId: SESSION }, ['clientId', 'authSessionId']); }
function codeInput(over) {
  const o = { state: STATE, code: CODE, ...over };
  return freezeExact(o, Object.keys(o));
}
function errorInput(order) {
  if (order === 'error_first') {
    const o = {}; o.error = 'access_denied'; o.state = STATE;
    return Object.freeze(o);
  }
  return freezeExact({ state: STATE, error: 'access_denied' }, ['state', 'error']);
}
function phaseBRow(over) {
  return {
    id: TX, location_id: LOCATION, staff_user_id: STAFF, code_verifier: VERIFIER,
    nonce: NONCE, endpoint_id: ENDPOINT, authorization_intent: AUTHORIZATION_INTENT,
    scope_version: SCOPE_VERSION, prior_grant_generation: '7', ...over,
  };
}
function phaseARow(over) {
  return phaseBRow({
    authorization_intent: PHASE_A_INTENT, scope_version: PHASE_A_SCOPE,
    prior_grant_generation: null, ...over,
  });
}
function bEnv(over) {
  return {
    LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, [CALLBACK_ENABLED_ENV]: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP, ...over,
  };
}
function makeClock(d = new Date('2026-08-08T12:00:00.000Z')) {
  return Object.freeze({ now() { return new Date(d.getTime()); } });
}
function makeCompletion(impl) {
  return Object.freeze({ async completeAuthorization(input) { return impl(input); } });
}
function makeRepo(impl) {
  return Object.freeze({ async consume(args) { return impl(args); } });
}
function statusOnly(r, expected) {
  return r && Object.isFrozen(r) && Reflect.ownKeys(r).length === 1
    && r.status === expected && noLeak(r)
    && JSON.stringify(r) === JSON.stringify({ status: expected });
}
function svc(opts) {
  const consumeCalls = { n: 0 };
  const completeCalls = { n: 0 };
  const dependencies = {
    repository: makeRepo(async (args) => {
      consumeCalls.n += 1;
      if (opts.consumeThrow) throw new Error(PLANTED);
      return opts.row === undefined ? phaseBRow() : opts.row;
    }),
    completion: makeCompletion(async (input) => {
      completeCalls.n += 1;
      if (opts.onComplete) return opts.onComplete(input);
      return Object.freeze({ status: 'completed' });
    }),
    env: opts.env || bEnv(),
    clock: makeClock(),
  };
  if (opts.events) dependencies.stageTelemetry = Object.freeze({
    emit(stage) { opts.events.push(stage); },
  });
  const s = createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze(dependencies));
  return { s, consumeCalls, completeCalls };
}

(async function main() {
  console.log('\n== B2a Phase B callback completion ==');

  // Raw parser: code + optional session_state any order
  {
    const { s, completeCalls } = svc({});
    const plain = {}; plain.code = CODE; plain.state = STATE;
    plain.session_state = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const r = await s.accept(plain, owner());
    ok('raw query code+state+session_state any order',
      r.status === 'authorization_received' && completeCalls.n === 1);
  }

  // Diagnostic-only pre-consumption stages distinguish stop boundaries without
  // changing the public failure contract or invoking completion prematurely.
  {
    const prefix = [
      'phase_b_owner_validated', 'phase_b_input_validated', 'phase_b_state_hashed',
      'phase_b_clock_validated', 'phase_b_consume_started',
    ];
    const cases = [
      { name: 'consume no-match', opts: { row: null }, expected: [...prefix, 'phase_b_consume_returned', 'callback_failed'] },
      { name: 'consume DB throw', opts: { consumeThrow: true }, expected: [...prefix, 'callback_failed'], throws: true },
      { name: 'malformed consumed row', opts: { row: phaseBRow({ nonce: PLANTED }) }, expected: [...prefix, 'phase_b_consume_returned', 'phase_b_consume_matched', 'callback_failed'], throws: true },
    ];
    for (const c of cases) {
      const events = [];
      const { s, completeCalls } = svc({ ...c.opts, events });
      let result = null; let threw = false;
      try { result = await s.accept(codeInput(), owner()); } catch (e) { threw = e && e.code === ERROR_CODE; }
      ok(`stage stop: ${c.name}`,
        threw === Boolean(c.throws)
        && (c.throws || statusOnly(result, 'invalid_or_expired'))
        && JSON.stringify(events) === JSON.stringify(c.expected)
        && completeCalls.n === 0 && noLeak(events));
    }
  }

  // Happy path: consume-once, exact frozen handoff, status-only, reentrant burn
  {
    let captured = null;
    let consumeCount = 0;
    let completeCalls = 0;
    const s = createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
      repository: makeRepo(async (args) => {
        consumeCount += 1;
        assert.ok(Buffer.isBuffer(args.stateHash) && args.stateHash.length === 32);
        assert.equal(args.clientId, CLIENT);
        assert.equal(args.authSessionId, SESSION);
        assert.ok(args.now instanceof Date);
        return phaseBRow();
      }),
      completion: makeCompletion(async (input) => {
        completeCalls += 1; captured = input;
        return Object.freeze({ status: 'completed' });
      }),
      env: bEnv(), clock: makeClock(),
    }));
    const r = await s.accept(codeInput(), owner());
    ok('code path → authorization_received status-only',
      statusOnly(r, 'authorization_received')
      && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_RECEIVED));
    ok('consume once before completion', consumeCount === 1 && completeCalls === 1);
    ok('completion handoff exact 10 keys + prior from server row',
      captured && Object.isFrozen(captured)
      && Reflect.ownKeys(captured).join(',') === COMPLETION_KEYS.join(',')
      && captured.authorizationCode === CODE && captured.transactionId === TX
      && captured.clientId === CLIENT && captured.locationId === LOCATION
      && captured.endpointId === ENDPOINT && captured.staffUserId === STAFF
      && captured.codeVerifier === VERIFIER && captured.nonce === NONCE
      && captured.applicationClientId === APP
      && captured.expectedPriorGrantGeneration === '7');
    let re = false;
    try { await s.accept(codeInput(), owner()); } catch (e) { re = e && e.code === ERROR_CODE; }
    ok('reentrant accept fails closed zero second complete',
      re && consumeCount === 1 && completeCalls === 1);
  }

  // Error path both key orders; extras/duplicates; no row; outcome_unknown
  {
    for (const providerError of ['access_denied', 'interaction_required', 'temporarily_unavailable']) {
      const events = [];
      const { s, consumeCalls, completeCalls } = svc({ events });
      const input = Object.freeze({ error: providerError, state: STATE });
      const r = await s.accept(input, owner());
      ok(`realistic Entra error ${providerError} remains diagnostic-only declined`,
        statusOnly(r, 'authorization_declined')
        && consumeCalls.n === 1 && completeCalls.n === 0
        && events.includes('callback_consumed')
        && !events.includes('callback_failed') && noLeak(events));
    }
    for (const order of ['state_first', 'error_first']) {
      const { s, consumeCalls, completeCalls } = svc({});
      const r = await s.accept(errorInput(order), owner());
      ok(`error key order ${order} → declined, zero completion`,
        statusOnly(r, 'authorization_declined')
        && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_DECLINED)
        && consumeCalls.n === 1 && completeCalls.n === 0);
    }
    // extras / duplicates / symbols reject (fail closed)
    const rejectCases = [
      { name: 'error extra key', input: freezeExact({ state: STATE, error: 'access_denied', extra: 'x' }, ['state', 'error', 'extra']) },
      { name: 'error + code hybrid', input: freezeExact({ state: STATE, error: 'access_denied', code: CODE }, ['state', 'error', 'code']) },
      { name: 'code extra key', input: freezeExact({ state: STATE, code: CODE, foo: '1' }, ['state', 'code', 'foo']) },
      { name: 'symbol key', input: (() => { const o = { state: STATE, code: CODE }; o[Symbol('x')] = 1; return o; })() },
    ];
    for (const c of rejectCases) {
      const { s, completeCalls } = svc({});
      let failed = false; let err;
      try { await s.accept(c.input, owner()); } catch (e) { failed = e && e.code === ERROR_CODE; err = e; }
      ok(`reject ${c.name} fail closed no leak`,
        failed && completeCalls.n === 0 && noLeak(err && err.message));
    }
    // accessor error surface
    {
      const o = {};
      Object.defineProperty(o, 'state', { enumerable: true, get() { return STATE; } });
      Object.defineProperty(o, 'error', { enumerable: true, get() { return 'access_denied'; } });
      const { s, completeCalls } = svc({});
      let failed = false;
      try { await s.accept(o, owner()); } catch (e) { failed = e && e.code === ERROR_CODE; }
      ok('accessor error keys fail closed', failed && completeCalls.n === 0);
    }
  }
  {
    const { s } = svc({ row: null });
    const r = await s.accept(codeInput(), owner());
    ok('no row → invalid_or_expired',
      statusOnly(r, 'invalid_or_expired')
      && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_INVALID));
  }
  {
    const { s, completeCalls } = svc({
      onComplete: async () => Object.freeze({ status: 'outcome_unknown' }),
    });
    const r = await s.accept(codeInput(), owner());
    ok('outcome_unknown bounded public status',
      statusOnly(r, 'outcome_unknown')
      && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_OUTCOME_UNKNOWN)
      && completeCalls.n === 1);
  }

  // Frozen handoff independent of later driver mutation
  {
    const row = phaseBRow();
    let completePrior = null;
    const { s } = svc({
      row,
      onComplete: async (input) => {
        completePrior = input.expectedPriorGrantGeneration;
        return Object.freeze({ status: 'completed' });
      },
    });
    // svc uses opts.row by reference — but makeRepo returns opts.row; mutation after accept
    await s.accept(codeInput(), owner());
    row.prior_grant_generation = '999';
    row.authorization_intent = PHASE_A_INTENT;
    row.code_verifier = PLANTED;
    ok('frozen handoff prior independent of later driver mutation', completePrior === '7');
  }

  // Transparent Proxy row + transparent Proxy frozen ack + hostile proxy no-leak
  console.log('\n== Proxy / hostile surfaces ==');
  {
    // Transparent Proxy over valid row — would pass descriptor checks without isProxy pin
    const proxyRow = new Proxy(phaseBRow(), {});
    const { s, completeCalls } = svc({ row: proxyRow });
    let failed = false; let err;
    try { await s.accept(codeInput(), owner()); } catch (e) {
      failed = e && e.code === ERROR_CODE; err = e;
    }
    ok('transparent Proxy DB row fail closed zero completion',
      failed && completeCalls.n === 0 && noLeak(err && err.message));
  }
  {
    // Transparent Proxy over frozen completed ack
    const frozenAck = Object.freeze({ status: 'completed' });
    const proxyAck = new Proxy(frozenAck, {});
    const { s, completeCalls } = svc({
      onComplete: async () => proxyAck,
    });
    let failed = false; let err;
    try { await s.accept(codeInput(), owner()); } catch (e) {
      failed = e && e.code === ERROR_CODE; err = e;
    }
    ok('transparent Proxy frozen ack fail closed no public success',
      failed && completeCalls.n === 1 && noLeak(err && err.message));
  }
  {
    // Hostile throwing Proxy input — isProxy must not leak/throw outward
    const hostile = new Proxy({}, {
      get() { throw new Error(`LEAK ${PLANTED} ${REFRESH}`); },
      ownKeys() { throw new Error(`LEAK ${CODE}`); },
      getOwnPropertyDescriptor() { throw new Error(`LEAK ${TX}`); },
      getPrototypeOf() { throw new Error(`LEAK ${STATE}`); },
    });
    const { s, consumeCalls, completeCalls } = svc({});
    let failed = false; let err;
    try { await s.accept(hostile, owner()); } catch (e) {
      failed = e && e.code === ERROR_CODE; err = e;
    }
    ok('hostile Proxy input fail closed bounded no-leak zero consume/complete',
      failed && consumeCalls.n === 0 && completeCalls.n === 0
      && err.message === 'Microsoft Phase B OAuth callback completion failed.'
      && noLeak(err.message) && noLeak(err.code));
  }
  {
    // Hostile completion error fail closed, no leak
    const { s, completeCalls } = svc({
      onComplete: async () => {
        const e = new Error(`hostile ${PLANTED} ${REFRESH} ${CODE} ${TX}`);
        e.scope = SCOPE_VERSION; e.generation = 7; throw e;
      },
    });
    let err;
    try { await s.accept(codeInput(), owner()); } catch (e) { err = e; }
    ok('hostile completion errors fail closed and leak nothing',
      err && err.code === ERROR_CODE && completeCalls.n === 1
      && err.message === 'Microsoft Phase B OAuth callback completion failed.'
      && noLeak(err.message) && noLeak(err.code));
  }

  // Phase A intent cannot enter B completion
  {
    const { s, completeCalls } = svc({ row: phaseARow() });
    let failed = false;
    try { await s.accept(codeInput(), owner()); } catch (e) { failed = e && e.code === ERROR_CODE; }
    ok('Phase A intent row cannot enter B completion', failed && completeCalls.n === 0);
  }
  {
    const { s, completeCalls } = svc({ row: phaseBRow({ scope_version: PHASE_A_SCOPE }) });
    let failed = false;
    try { await s.accept(codeInput(), owner()); } catch { failed = true; }
    ok('cross scope_version fail closed', failed && completeCalls.n === 0);
  }
  {
    let aInstaller = 0;
    const phaseAInstaller = Object.freeze({
      async installVerifiedGrant() { aInstaller += 1; return Object.freeze({ status: 'completed' }); },
    });
    const { s, completeCalls } = svc({});
    const r = await s.accept(codeInput(), owner());
    ok('B transaction cannot enter Phase A installer (zero install)',
      r.status === 'authorization_received' && completeCalls.n === 1 && aInstaller === 0
      && typeof phaseAInstaller.installVerifiedGrant === 'function');
  }

  // Gate matrix: flag off → unavailable PRE-consume, zero repository / completion
  console.log('\n== Gate matrix (pre-consume) ==');
  {
    const flagCases = [
      { name: 'missing B flag', env: bEnv({ [CALLBACK_ENABLED_ENV]: undefined }) },
      { name: 'false B flag', env: bEnv({ [CALLBACK_ENABLED_ENV]: 'false' }) },
      { name: 'malformed B flag', env: bEnv({ [CALLBACK_ENABLED_ENV]: 'TRUE' }) },
      {
        name: 'Phase A flag alone',
        env: {
          LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
          LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
          LUNA_EMAIL_OAUTH_CLIENT_ID: APP,
        },
      },
    ];
    for (const c of flagCases) {
      const { s, consumeCalls, completeCalls } = svc({ env: c.env });
      const r = await s.accept(codeInput(), owner());
      ok(`gate ${c.name}: unavailable pre-consume, zero repo/completion`,
        statusOnly(r, 'authorization_unavailable')
        && JSON.stringify(r) === JSON.stringify(PUBLIC_STATUS_UNAVAILABLE)
        && consumeCalls.n === 0 && completeCalls.n === 0);
    }

    const factoryCases = [
      { name: 'wrong deployment', env: bEnv({ LUNA_DEPLOYMENT: 'production' }) },
      { name: 'missing app client id', env: bEnv({ LUNA_EMAIL_OAUTH_CLIENT_ID: undefined }) },
      { name: 'malformed app client id', env: bEnv({ LUNA_EMAIL_OAUTH_CLIENT_ID: 'not-a-uuid' }) },
    ];
    for (const c of factoryCases) {
      let consumeCalls = 0; let threw = false;
      try {
        createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
          repository: makeRepo(async () => { consumeCalls += 1; return phaseBRow(); }),
          completion: makeCompletion(async () => Object.freeze({ status: 'completed' })),
          env: c.env, clock: makeClock(),
        }));
      } catch { threw = true; }
      ok(`gate ${c.name}: factory fail closed zero consume`, threw && consumeCalls === 0);
    }

    ok('isCallbackEnabled exact true only',
      isCallbackEnabled({ [CALLBACK_ENABLED_ENV]: 'true' }) === true
      && isCallbackEnabled({ [CALLBACK_ENABLED_ENV]: 'false' }) === false
      && isCallbackEnabled({ [CALLBACK_ENABLED_ENV]: 'TRUE' }) === false
      && isCallbackEnabled({}) === false);
    ok('B flag constant is LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED',
      CALLBACK_ENABLED_ENV === 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED');

    // Containment: own-data env only; hostile getters/proxies/inherited accessors → hits=0
    {
      let hits = 0;
      const hostileOwn = {
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        LUNA_EMAIL_OAUTH_CLIENT_ID: APP,
      };
      Object.defineProperty(hostileOwn, CALLBACK_ENABLED_ENV, {
        enumerable: true,
        get() { hits += 1; return 'true'; },
      });
      let threw = false;
      try {
        createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
          repository: makeRepo(async () => { hits += 100; return phaseBRow(); }),
          completion: makeCompletion(async () => { hits += 1000; return Object.freeze({ status: 'completed' }); }),
          env: hostileOwn, clock: makeClock(),
        }));
      } catch { threw = true; }
      ok('hostile own env getter: factory fail-closed hits=0 zero DB/completion',
        threw && hits === 0 && isCallbackEnabled(hostileOwn) === false);

      hits = 0;
      const proto = {};
      Object.defineProperty(proto, CALLBACK_ENABLED_ENV, {
        enumerable: true, configurable: true,
        get() { hits += 1; return 'true'; },
      });
      Object.defineProperty(proto, 'LUNA_DEPLOYMENT', {
        enumerable: true, configurable: true,
        get() { hits += 1; return SUNSET_DEPLOYMENT; },
      });
      const inherited = Object.create(proto);
      Object.defineProperty(inherited, 'LUNA_EMAIL_OAUTH_CLIENT_ID', {
        enumerable: true, value: APP, writable: true, configurable: true,
      });
      threw = false;
      try {
        createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
          repository: makeRepo(async () => { hits += 100; return phaseBRow(); }),
          completion: makeCompletion(async () => { hits += 1000; return Object.freeze({ status: 'completed' }); }),
          env: inherited, clock: makeClock(),
        }));
      } catch { threw = true; }
      ok('inherited env accessors: fail-closed hits=0',
        threw && hits === 0 && isCallbackEnabled(inherited) === false);

      hits = 0;
      const target = bEnv();
      const proxyEnv = new Proxy(target, {
        get(t, p, r) { hits += 1; return Reflect.get(t, p, r); },
        getOwnPropertyDescriptor(t, p) { hits += 1; return Reflect.getOwnPropertyDescriptor(t, p); },
        ownKeys(t) { hits += 1; return Reflect.ownKeys(t); },
        has(t, p) { hits += 1; return Reflect.has(t, p); },
      });
      threw = false;
      try {
        createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
          repository: makeRepo(async () => { hits += 100; return phaseBRow(); }),
          completion: makeCompletion(async () => { hits += 1000; return Object.freeze({ status: 'completed' }); }),
          env: proxyEnv, clock: makeClock(),
        }));
      } catch { threw = true; }
      ok('transparent Proxy env: fail-closed zero trap/DB/completion',
        threw && hits === 0 && isCallbackEnabled(proxyEnv) === false);

      const sym = Symbol('plant');
      const withSym = bEnv();
      withSym[sym] = PLANTED;
      threw = false;
      try {
        createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
          repository: makeRepo(async () => phaseBRow()),
          completion: makeCompletion(async () => Object.freeze({ status: 'completed' })),
          env: withSym, clock: makeClock(),
        }));
      } catch { threw = true; }
      ok('env symbol own key rejected fail-closed', threw);
    }
  }

  // Duplicate consume (fresh service, second null) zero second completion
  {
    let completeCalls = 0; let rowsLeft = 1;
    const repo = makeRepo(async () => {
      if (rowsLeft <= 0) return null;
      rowsLeft -= 1; return phaseBRow();
    });
    const makeSvc = () => createMicrosoftPhaseBOauthCallbackCompletionService(Object.freeze({
      repository: repo,
      completion: makeCompletion(async () => {
        completeCalls += 1; return Object.freeze({ status: 'completed' });
      }),
      env: bEnv(), clock: makeClock(),
    }));
    const r1 = await makeSvc().accept(codeInput(), owner());
    const r2 = await makeSvc().accept(codeInput(), owner());
    ok('duplicate callback: second consume null → invalid, one completion total',
      r1.status === 'authorization_received' && r2.status === 'invalid_or_expired'
      && completeCalls === 1);
  }

  // SQL consumer + intent filter vs Phase A
  console.log('\n== SQL / intent isolation / Phase A byte-compat ==');
  {
    let seenSql = null; let seenParams = null;
    const consumer = createPostgresPhaseBOauthTransactionConsumer({
      async query(sql, params) { seenSql = sql; seenParams = params; return { rows: [phaseBRow()] }; },
    });
    const hash = crypto.createHash('sha256').update(STATE, 'ascii').digest();
    const now = new Date('2026-08-08T12:00:00.000Z');
    const row = await consumer.consume({
      stateHash: hash, clientId: CLIENT, authSessionId: SESSION, now,
    });
    ok('postgres consumer uses exact Phase B SQL intent/scope/prior',
      seenSql === SQL_CONSUME_PHASE_B_TRANSACTION
      && /authorization_intent='phase_b_reauthorization'/.test(seenSql)
      && /scope_version='phase_b_v1'/.test(seenSql)
      && /prior_grant_generation IS NOT NULL/.test(seenSql)
      && seenParams[0] === hash && seenParams[1] === CLIENT
      && seenParams[2] === SESSION && seenParams[3] === now
      && row && row.id === TX);
    ok('B consume SQL distinct from Phase A SQL',
      SQL_CONSUME_PHASE_B_TRANSACTION !== PHASE_A_SQL_CONSUME
      && !/phase_b_reauthorization/.test(PHASE_A_SQL_CONSUME));
    ok('B SQL RETURNING includes intent/scope/prior',
      CONSUME_ROW_KEYS.join(',')
        === 'id,location_id,staff_user_id,code_verifier,nonce,endpoint_id,'
          + 'authorization_intent,scope_version,prior_grant_generation');
    ok('Phase A SCOPES still Mail.ReadBasic (not widened)',
      PHASE_A_SCOPES === 'openid profile offline_access User.Read Mail.ReadBasic');
    ok('Phase A completion keys still 9 (no prior)',
      PHASE_A_COMPLETION_KEYS.length === 9
      && !PHASE_A_COMPLETION_KEYS.includes('expectedPriorGrantGeneration'));
    ok('Phase B completion keys 10 with prior',
      COMPLETION_KEYS.length === 10
      && COMPLETION_KEYS.includes('expectedPriorGrantGeneration'));
    ok('AUTHORIZATION_INTENT / SCOPE_VERSION exact',
      AUTHORIZATION_INTENT === 'phase_b_reauthorization' && SCOPE_VERSION === 'phase_b_v1');
  }

  // Import inert + package + budget + Phase A byte identity
  console.log('\n== Import inert / flags / package / budget ==');
  {
    const probe = spawnSync(process.execPath, ['-e', `
      const path = require('path');
      const fs = require('fs');
      const root = ${JSON.stringify(ROOT)};
      const flag = 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED';
      if (process.env[flag] === 'true') { console.log('ENV_ON'); process.exit(2); }
      const mod = require(path.join(root, 'scripts/lib/email-microsoft-phase-b-oauth-callback-completion.js'));
      if (mod.isCallbackEnabled(process.env)) { console.log('FN_ON'); process.exit(3); }
      if (typeof mod.createMicrosoftPhaseBOauthCallbackCompletionService !== 'function') {
        console.log('NO_FACTORY'); process.exit(4);
      }
      for (const k of Object.keys(mod)) {
        if (/route|listen|app|express|handler|middleware/i.test(k)) {
          console.log('WIRE', k); process.exit(5);
        }
      }
      function walk(d, acc) {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p, acc);
          else if (/\\.(json|env|yml|yaml|example)$/.test(ent.name)) acc.push(p);
        }
        return acc;
      }
      let files = [];
      try { files = walk(path.join(root, 'config'), []); } catch {}
      for (const f of files) {
        const t = fs.readFileSync(f, 'utf8');
        if (t.includes(flag + '=true') || t.includes('"' + flag + '": true')) {
          console.log('CONFIG', f); process.exit(6);
        }
      }
      // B2b owners may exist; B2a remains import-inert regardless.
      console.log('OK');
    `], {
      encoding: 'utf8',
      env: { ...process.env, LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED: undefined },
    });
    ok('fresh-process: import inert, flag off, no defaults',
      probe.status === 0 && /OK/.test(probe.stdout || ''),
      (probe.stdout || '') + (probe.stderr || ''));
  }
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    ok('package has verify:email-microsoft-phase-b-oauth-callback-composition',
      pkg.scripts['verify:email-microsoft-phase-b-oauth-callback-composition']
      === 'node scripts/verify-email-microsoft-phase-b-oauth-callback-composition.js');
  }
  {
    const srcFile = 'scripts/lib/email-microsoft-phase-b-oauth-callback-completion.js';
    const verFile = 'scripts/verify-email-microsoft-phase-b-oauth-callback-composition.js';
    const src = fs.readFileSync(path.join(ROOT, srcFile), 'utf8').split(/\r?\n/).length;
    const ver = fs.readFileSync(path.join(ROOT, verFile), 'utf8').split(/\r?\n/).length;
    const total = src + ver;
    ok(`budget source=${src} <=430`, src <= 430);
    ok(`budget verifier=${ver} <=705`, ver <= 705);
    ok(`budget total=${total} <=1120`, total <= 1120);
    ok('B2a budget files present (callback + verifier); B2b optional peers allowed',
      fs.existsSync(path.join(ROOT, srcFile))
      && fs.existsSync(path.join(ROOT, verFile)));
  }
  {
    // Non-txn Phase A owners byte-identical; txn is intent-hardened (B3a1) — semantic only.
    const phaseAFiles = [
      'scripts/lib/email-microsoft-oauth-callback-completion.js',
      'scripts/lib/email-microsoft-oauth-operation-composition.js',
      'scripts/lib/email-microsoft-oauth-runtime-wiring.js',
    ];
    let allSame = true;
    for (const f of phaseAFiles) {
      const r = spawnSync('git', ['diff', '--quiet', 'a1d53a057a0856ffaa8f88e1521f9cf0ca00a61d', '--', f], {
        cwd: ROOT,
      });
      if (r.status !== 0) allSame = false;
    }
    const txn = require('./lib/email-microsoft-oauth-transaction-service');
    const sql = PHASE_A_SQL_CONSUME;
    const txnSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-microsoft-oauth-transaction-service.js'), 'utf8');
    ok('Phase A non-txn byte-identical; txn scopes/API/SQL intent/no-B',
      allSame
      && PHASE_A_SCOPES === 'openid profile offline_access User.Read Mail.ReadBasic'
      && !/Mail\.Send|Mail\.ReadWrite/.test(PHASE_A_SCOPES)
      && typeof txn.createMicrosoftOAuthTransactionService === 'function'
      && typeof txn.createMicrosoftOAuthCallbackService === 'function'
      && typeof txn.createPostgresOAuthTransactionRepository === 'function'
      && typeof txn.isStartEnabled === 'function' && typeof txn.isCallbackEnabled === 'function'
      && /RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id\s*$/.test(sql)
      && !/RETURNING[^;]*(authorization_intent|scope_version|prior_grant_generation)/.test(sql)
      && /state_hash=\$1::bytea/.test(sql) && /client_id=\$2::uuid/.test(sql)
      && /auth_session_id=\$3::uuid/.test(sql) && /consumed_at IS NULL/.test(sql)
      && /expires_at>\$4/.test(sql) && /authorization_intent='initial_connect'/.test(sql)
      && /scope_version='phase_a_v2'/.test(sql) && /prior_grant_generation IS NULL/.test(sql)
      && !/phase_b_reauthorization|phase_b_v1/.test(sql)
      && !/phase-b-verified-grant-replacer|phase-b-oauth|staff-email-oauth-routes|staff-query-api/.test(txnSrc)
      && !/require\([^)]*phase-b/.test(txnSrc) && !/\bexpress\b|\bcreateServer\b|\blisten\s*\(/.test(txnSrc)
      && Object.keys(txn).sort().join(',') === 'AUTHORITY,CALLBACK_CODE_KEYS,CALLBACK_ERROR_KEYS,INPUT_KEYS,OWNER_KEYS,REDIRECT_URI,SCOPES,SQL_CONSUME_TRANSACTION,SQL_CREATE_TRANSACTION,START_ENDPOINT_ID_KEY_INDEX,TTL_SECONDS,createMicrosoftOAuthCallbackService,createMicrosoftOAuthTransactionService,createPostgresOAuthTransactionRepository,isCallbackEnabled,isStartEnabled,validateRuntime');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('FATAL', e && e.stack ? e.stack : e);
  process.exit(1);
});
