'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, 'lib');
const txPath = path.join(LIB, 'email-microsoft-phase-b-reauthorization-transaction-service.js');
const callbackPath = path.join(LIB, 'email-microsoft-phase-b-oauth-callback-completion.js');
const operationPath = path.join(LIB, 'email-microsoft-phase-b-oauth-operation-composition.js');
const replacerPath = path.join(LIB, 'email-microsoft-phase-b-verified-grant-replacer.js');
const tx = require(txPath);

assert(!Reflect.ownKeys(tx).some((key) => /policy|registry|operation/i.test(String(key))), 'public Phase-B exports must not expose policy selection');
for (const file of [txPath, callbackPath, operationPath, replacerPath]) {
  assert(fs.readFileSync(file, 'utf8').includes("require('./email-microsoft-reauthorization-transition-policy')"), `${path.basename(file)} must use the private transition policy`);
}

const validDeps = () => ({
  repository: Object.freeze({ async create() { throw new Error('must_not_run'); } }),
  env: Object.freeze({
    LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_OAUTH_CLIENT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }),
  randomBytes: () => Buffer.alloc(32, 7),
  now: () => new Date('2026-08-13T00:00:00.000Z'),
});
const hostile = [
  { policy: Object.freeze({}) }, { registry: Object.freeze({}) }, { operation: 'phase_b' },
  { intent: 'phase_b_reauthorization' }, { sourceScopeVersion: 'phase_a_v2' },
  { targetScopeVersion: 'phase_b_v1' }, { scopes: Object.freeze([]) },
  { validators: Object.freeze([]) }, { sql: 'SELECT 1' }, { callbackPredicate: () => true },
  { casPredicate: () => true }, { [Symbol('policy')]: Object.freeze({}) },
];
for (const extra of hostile) {
  let calls = 0;
  const deps = validDeps();
  deps.repository = Object.freeze({ async create() { calls += 1; } });
  Object.assign(deps, extra);
  const service = tx.createMicrosoftPhaseBReauthorizationTransactionService(deps);
  assert(service && typeof service.start === 'function');
  assert.strictEqual(calls, 0);
}
let getterHits = 0;
const accessorDeps = validDeps();
Object.defineProperty(accessorDeps, 'policy', { enumerable: true, get() { getterHits += 1; return {}; } });
assert(tx.createMicrosoftPhaseBReauthorizationTransactionService(accessorDeps));
assert.strictEqual(getterHits, 0);
const proxyDeps = new Proxy(validDeps(), { ownKeys() { throw new Error('trap'); } });
assert.throws(() => tx.createMicrosoftPhaseBReauthorizationTransactionService(proxyDeps));
const policySource = fs.readFileSync(path.join(LIB, 'email-microsoft-reauthorization-transition-policy.js'), 'utf8');
for (const governedFact of [
  'transactionStatement', 'callbackConsumeStatement', 'replacerLockStatement',
  'replacerCasStatement', 'verifiedMicrosoftDelegatedConnector', 'ownUserMailbox',
  'activeCleanUnleased', 'priorGenerationPredicate',
]) assert(policySource.includes(governedFact), `private policy must govern ${governedFact}`);
console.log('PASS: Microsoft Phase-B transition policy is private, closed, and non-injectable');
