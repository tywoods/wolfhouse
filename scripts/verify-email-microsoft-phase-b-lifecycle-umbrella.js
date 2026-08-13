'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, 'lib');
const umbrellaPath = path.join(LIB, 'email-microsoft-reauthorization-lifecycle.js');
const txPath = path.join(LIB, 'email-microsoft-phase-b-reauthorization-transaction-service.js');
const callbackPath = path.join(LIB, 'email-microsoft-phase-b-oauth-callback-completion.js');
const tx = require(txPath);
const callback = require(callbackPath);
assert.deepStrictEqual(Reflect.ownKeys(tx), [
  'AUTHORITY','REDIRECT_URI','PHASE_B_SCOPES','TTL_SECONDS','INPUT_KEYS','AUTHORIZATION_INTENT',
  'SCOPE_VERSION','START_ENABLED_ENV','SQL_CREATE_PHASE_B_REAUTH','asCanonGen','isStartEnabled',
  'validateRuntime','createPostgresPhaseBReauthTransactionRepository',
  'createMicrosoftPhaseBReauthorizationTransactionService',
]);
assert.deepStrictEqual(Reflect.ownKeys(callback), [
  'ERROR_CODE','ERROR_MESSAGE','ACCEPT_METHOD','COMPLETION_METHOD','COMPLETION_ACK_STATUS','OUTCOME_UNKNOWN',
  'CALLBACK_ENABLED_ENV','SUNSET_DEPLOYMENT','PUBLIC_STATUS_INVALID','PUBLIC_STATUS_DECLINED',
  'PUBLIC_STATUS_RECEIVED','PUBLIC_STATUS_UNAVAILABLE','PUBLIC_STATUS_OUTCOME_UNKNOWN','DEPENDENCY_KEYS',
  'CONSUME_ROW_KEYS','COMPLETION_KEYS','OWNER_KEYS','CALLBACK_CODE_KEYS','CALLBACK_ERROR_KEYS',
  'SQL_CONSUME_PHASE_B_TRANSACTION','AUTHORIZATION_INTENT','SCOPE_VERSION','isCallbackEnabled',
  'createPostgresPhaseBOauthTransactionConsumer','createMicrosoftPhaseBOauthCallbackCompletionService',
]);
assert(fs.existsSync(umbrellaPath), 'umbrella lifecycle owner must exist');
const umbrellaSource = fs.readFileSync(umbrellaPath, 'utf8');
const txSource = fs.readFileSync(txPath, 'utf8');
const callbackSource = fs.readFileSync(callbackPath, 'utf8');
assert(!txSource.includes('transition-policy'), 'transaction facade must not select transition policy');
assert(!callbackSource.includes('transition-policy'), 'callback facade must not select transition policy');
assert(umbrellaSource.includes('Symbol('), 'umbrella must own an unforgeable operation token');
assert(umbrellaSource.includes('transactionStatement') && umbrellaSource.includes('callbackConsumeStatement'));
assert.deepStrictEqual(Reflect.ownKeys(require(umbrellaPath)), ['phaseBReauthorizationTransactionService', 'phaseBOauthCallbackCompletion']);
for (const mod of [tx, callback]) assert(!Reflect.ownKeys(mod).some((k) => /registry|policy|operation|selector|engine|validator|predicate/i.test(String(k))));
console.log('PASS: Phase-B transaction and callback are compatibility facades over private umbrella lifecycle authority');
