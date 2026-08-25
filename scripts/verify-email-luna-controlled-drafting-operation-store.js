'use strict';

/** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 2: durable provider-draft state machine. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingOperationStore,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_STATES,
  STORE_DEPENDENCY_KEYS,
  RESERVE_KEYS,
  ACK_KEYS,
  PUBLIC_KEYS,
} = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT,
  FUNCTION_SIGNATURES,
  executeFunctionsFor,
} = require('./lib/email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
} = require('./lib/email-luna-controlled-drafting-provider-contract');

const ROOT = path.join(__dirname, '..');
const SQL_097 = fs.readFileSync(path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'), 'utf8');
const DOWN_097 = fs.readFileSync(path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations_down.sql'), 'utf8');
const STORE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-controlled-drafting-operation-store'), 'utf8');
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(require.resolve('./lib/email-luna-sunset-staging-runtime-composition'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DOC_SRC = fs.readFileSync(path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-OPERATION-STORE.md'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'database/migrations/canonical-manifest.json'), 'utf8'));
const CONTRACT_SRC = fs.readFileSync(require.resolve('./lib/email-luna-controlled-drafting-provider-contract'), 'utf8');

console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 2 operation store verifier');

assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER, 'microsoft_graph');
assert.deepEqual(STORE_DEPENDENCY_KEYS.slice(), ['withTransactionClient']);
assert.deepEqual(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_STATES.slice(), [
  'reserved',
  'create_dispatched_outcome_unknown',
  'provider_draft_reconciled_exact',
  'provider_draft_modified_by_staff',
  'provider_draft_removed_by_staff',
  'provider_mismatch_blocked',
]);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_grant_in_097, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_create_role_in_097, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_send_phase, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_send_counter, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_send_authorization, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT.no_outbound_journal_handoff, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_grant_in_097, true);
assert.equal(EMAIL_LUNA_AUTOMATION_PRINCIPAL_CONTRACT.no_create_role_in_097, true);
assert.equal(
  executeFunctionsFor('worker').includes(FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_claim_create),
  false,
  '088 worker grant list stays 088-only; 097 claim is optional-when-present',
);
assert.equal(
  executeFunctionsFor('producer').includes(FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_reserve),
  false,
  '088 producer grant list stays persist_and_enqueue; 097 reserve is optional-when-present',
);
assert.equal(
  FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_reserve,
  'tenant_email_luna_controlled_draft_reserve(uuid, uuid, text, text, text, text, text, text)',
);
assert.equal(
  FUNCTION_SIGNATURES.tenant_email_luna_controlled_draft_record_create,
  'tenant_email_luna_controlled_draft_record_create(uuid, uuid, integer, jsonb)',
);
console.log('  PASS  unwired grant contract; 097 functions are optional-when-present');

assert.equal(/^\s*CREATE ROLE/m.test(SQL_097), false);
assert.equal(/^\s*GRANT /m.test(SQL_097), false);
assert.equal(/current_setting\s*\(/.test(SQL_097), false);
assert.match(SQL_097, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_controlled_draft_operations/);
assert.match(SQL_097, /CREATE TABLE IF NOT EXISTS public\.tenant_email_luna_controlled_draft_transitions/);
assert.match(SQL_097, /SET search_path TO pg_catalog, public/);
assert.match(SQL_097, /SECURITY DEFINER/);
assert.match(SQL_097, /principal_authorized/);
assert.match(SQL_097, /p_id IS DISTINCT FROM '\.'/);
assert.match(SQL_097, /p_id IS DISTINCT FROM '\.\.'/);
assert.match(SQL_097, /create_dispatched_outcome_unknown/);
assert.match(SQL_097, /unknown outcome is reconcile-only/);
assert.match(SQL_097, /provider_draft_id replacement refused/);
assert.equal(/send_invocation_count/.test(SQL_097), false);
assert.equal(/send_dispatched/.test(SQL_097), false);
assert.equal(/authorize_send/.test(SQL_097), false);
assert.match(DOWN_097, /097_down_refused/);
assert.match(DOWN_097, /refuse silent provider-draft identity loss/);
console.log('  PASS  dedicated 097 table; no send phases/counters; down refuses evidence loss');

const fwd = MANIFEST.entries.find((entry) => entry.id === '097_tenant_email_luna_controlled_draft_operations');
const down = MANIFEST.entries.find((entry) => entry.id === '097_tenant_email_luna_controlled_draft_operations_down');
assert.equal(fwd.filename, '097_tenant_email_luna_controlled_draft_operations.sql');
assert.equal(fwd.order, 93);
assert.equal(fwd.inForwardChain, true);
assert.equal(down.classification, 'rollback_down');
assert.equal(down.pairsWith, '097_tenant_email_luna_controlled_draft_operations.sql');
console.log('  PASS  canonical manifest registers 097 pair after 096');

assert.equal(RESERVE_KEYS.includes('client_id'), false);
assert.equal(RESERVE_KEYS.includes('mailbox_id'), false);
assert.equal(RESERVE_KEYS.includes('inbound_provider_message_id'), false);
assert.equal(ACK_KEYS.includes('access_token'), false);
assert.equal(PUBLIC_KEYS.includes('send_invocation_count'), false);
assert.doesNotMatch(
  STORE_SRC.replace(/const FORBIDDEN_STORE_METHODS[\s\S]*?\];/, ''),
  /graph\.microsoft|googleapis|Mail\.Send/,
);
assert.match(STORE_SRC, /FORBIDDEN_STORE_METHODS[\s\S]*sendDraft[\s\S]*sendMail/);
assert.equal(/function sendDraft|async sendDraft|\.sendDraft\s*=/.test(STORE_SRC), false);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-operation-store/);
assert.doesNotMatch(COMPOSE_SRC, /email-luna-controlled-drafting-operation-store|controlled_draft_reserve/);
assert.match(CONTRACT_SRC, /isGraphId/);
assert.match(STORE_SRC, /value !== '\.'/);
assert.match(STORE_SRC, /value !== '\.\.'/);
console.log('  PASS  store does not accept request-selected tenant/mailbox; Chapter 1 remains unwired');

const store = createEmailLunaControlledDraftingOperationStore({
  async withTransactionClient(work) {
    return work({
      async query() { return { rows: [] }; },
    });
  },
});
assert.equal(typeof store.reserveControlledDraft, 'function');
assert.equal(typeof store.claimCreateDispatch, 'function');
assert.equal(typeof store.recordProviderCreate, 'function');
assert.equal(typeof store.reconcileProviderDraft, 'function');
assert.equal(typeof store.loadControlledDraft, 'function');
assert.equal(Object.prototype.hasOwnProperty.call(store, 'send'), false);
assert.equal(Object.prototype.hasOwnProperty.call(store, 'sendDraft'), false);
assert.equal(Object.prototype.hasOwnProperty.call(store, 'sendMail'), false);
assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-operation-store'],
  'node scripts/verify-email-luna-controlled-drafting-operation-store.js');
assert.equal(PKG.scripts['prove:email-luna-controlled-drafting-operation-store-pglite'],
  'node scripts/prove-email-luna-controlled-drafting-operation-store-pglite.js');
assert.equal(PKG.scripts['prove:email-luna-controlled-drafting-operation-store-stock-pg'],
  'node scripts/prove-email-luna-controlled-drafting-operation-store-stock-pg.js');
assert.match(DOC_SRC, /Chapter 2/);
assert.match(DOC_SRC, /cannot send/);
assert.match(DOC_SRC, /Non-goals/);
assert.match(DOC_SRC, /097_tenant_email_luna_controlled_draft_operations/);
console.log('  PASS  package surface, docs, and scripts are registered; no send methods');

const proof = spawnSync(process.execPath, [
  path.join(ROOT, 'scripts/prove-email-luna-controlled-drafting-operation-store-pglite.js'),
], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (proof.stdout) process.stdout.write(proof.stdout);
if (proof.stderr) process.stderr.write(proof.stderr);
assert.equal(proof.status, 0, 'pglite proof must pass or SKIP after static contract');
console.log('ALL OK — Stage 2 Chapter 2 controlled-drafting operation store');
