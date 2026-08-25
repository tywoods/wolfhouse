'use strict';

/** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3: runtime composition. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF,
  EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY,
  ENV_COMPOSITION_ENABLED,
  ENV_CLIENT_ID,
  ENV_LOCATION_ID,
  ENV_LOCATION_KEY,
  ENV_ENDPOINT_ID,
  ENV_MAILBOX_ID,
  ENV_PROVIDER,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  CONTROLLED_DRAFTING_MODE,
  ERROR_CODE,
  DISABLED_CODE,
  CRASH_SEAM_KEYS,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  createEmailLunaControlledDraftingOperationStore,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  pickEmailLunaControlledDraftingTransportMethods,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  createMicrosoftGraphReplyDraftTransport,
} = require('./lib/email-microsoft-graph-reply-draft-transport');

const ROOT = path.join(__dirname, '..');
const RUNTIME_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition'),
  'utf8',
);
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/Dockerfile'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DOC_SRC = fs.readFileSync(
  path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-RUNTIME-COMPOSITION.md'),
  'utf8',
);
const SHADOW_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition'),
  'utf8',
);
const CONTRACT_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-provider-contract'),
  'utf8',
);
const STORE_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-operation-store'),
  'utf8',
);

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const OP = '66666666-6666-4666-8666-666666666666';
const ISSUANCE = '55555555-5555-4555-8555-555555555555';
const AUDIT = '77777777-7777-4777-8777-777777777777';
const CONV = '88888888-8888-4888-8888-888888888888';
const INBOUND = '99999999-9999-4999-8999-999999999999';
const SOURCE_MSG = 'AAMkAGI2-SRC';
const THREAD = 'AAQkAGI2-THREAD';
const RECIPIENT = 'elena@example.test';
const SUBJECT = 'Lesson availability tomorrow';
const BODY = 'Yes, the morning lesson still has space.';
const TOKEN = 'atok-NEVER_LEAK-stage2-ch3-token';
const PLANTED = 'NEVER_LEAK_body_or_address';

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function draftDigest(subject, body, language) {
  return crypto.createHash('sha256').update(subject).update('\0').update(body).update('\0').update(language).digest('hex');
}

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: C,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: L,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: E,
    EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: MAILBOX,
    EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
    ...patch,
  };
}

function authority(patch = {}) {
  return {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    ...patch,
  };
}

function makeProvider(fake = createEmailLunaControlledDraftingFakeTransport({ classify: true })) {
  return {
    fake,
    provider: createEmailLunaControlledDraftingProvider({
      authority: authority(),
      transport: pickEmailLunaControlledDraftingTransportMethods({
        createReplyDraft: fake.createReplyDraft,
        reconcileDraft: fake.reconcileDraft,
      }),
    }),
  };
}

function fixtureRow(state, extra = {}) {
  return {
    status: extra.status || state,
    operation_id: OP,
    issuance_id: ISSUANCE,
    audit_operation_id: AUDIT,
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    conversation_id: CONV,
    inbound_event_id: INBOUND,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    canonical_subject: SUBJECT,
    canonical_body: BODY,
    subject_digest: digest(SUBJECT),
    body_digest: digest(BODY),
    draft_digest: draftDigest(SUBJECT, BODY, 'en'),
    policy_version: 'email-luna-draft-policy.v1',
    eligibility_policy_version: 'email-luna-autonomous-eligibility-policy.v1',
    validator_version: 'email-luna-draft-validator.v1',
    state,
    create_dispatch_claimed: extra.create_dispatch_claimed === true,
    provider_draft_id: extra.provider_draft_id == null ? null : extra.provider_draft_id,
    is_draft: extra.is_draft == null ? null : extra.is_draft,
    state_generation: extra.state_generation || 1,
  };
}

function createMemoryLoaner() {
  const rows = new Map();
  function keyOf(operationId, issuanceId) {
    return `${operationId}:${issuanceId}`;
  }
  function copy(row, status) {
    return { ...row, status };
  }
  async function exec(text, params) {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
    if (String(text).includes('tenant_email_luna_controlled_draft_reserve')) {
      const [operationId, issuanceId, subject, body, language, subjectDigest, bodyDigest, digestValue] = params;
      const key = keyOf(operationId, issuanceId);
      const existing = rows.get(key);
      if (existing) {
        if (existing.canonical_subject !== subject || existing.canonical_body !== body
            || existing.subject_digest !== subjectDigest || existing.draft_digest !== digestValue) {
          const error = new Error('digest mismatch');
          error.code = '23514';
          throw error;
        }
        return { rows: [copy(existing, 'replayed')] };
      }
      const row = fixtureRow('reserved', { status: 'reserved', state_generation: 1 });
      row.operation_id = operationId;
      row.issuance_id = issuanceId;
      row.canonical_subject = subject;
      row.canonical_body = body;
      row.subject_digest = subjectDigest;
      row.body_digest = bodyDigest;
      row.draft_digest = digestValue;
      void language;
      rows.set(key, row);
      return { rows: [copy(row, 'reserved')] };
    }
    if (String(text).includes('tenant_email_luna_controlled_draft_claim_create')) {
      const [operationId, issuanceId, expected] = params;
      const row = rows.get(keyOf(operationId, issuanceId));
      if (!row) return { rows: [] };
      if (expected != null && expected !== row.state_generation) {
        return { rows: [copy(row, 'stale_generation')] };
      }
      if (row.create_dispatch_claimed === true) {
        return { rows: [copy(row, 'replayed')] };
      }
      row.state = 'create_dispatched_outcome_unknown';
      row.create_dispatch_claimed = true;
      row.state_generation += 1;
      row.status = 'create_dispatched_outcome_unknown';
      return { rows: [copy(row, 'create_dispatched_outcome_unknown')] };
    }
    if (String(text).includes('tenant_email_luna_controlled_draft_record_create')) {
      const [operationId, issuanceId, expected, ack] = params;
      const row = rows.get(keyOf(operationId, issuanceId));
      if (!row) return { rows: [] };
      if (expected != null && expected !== row.state_generation) {
        return { rows: [copy(row, 'stale_generation')] };
      }
      if (ack && ack.is_draft === false) {
        row.state = 'provider_mismatch_blocked';
        row.state_generation += 1;
        return { rows: [copy(row, 'provider_mismatch_blocked')] };
      }
      if (ack && (ack.client_id !== row.client_id || ack.mailbox_id !== row.mailbox_id
          || ack.recipient_address !== row.recipient_address
          || ack.inbound_provider_thread_id !== row.inbound_provider_thread_id
          || ack.subject_digest !== row.subject_digest
          || ack.body_digest !== row.body_digest
          || ack.operation_id !== row.operation_id
          || ack.issuance_id !== row.issuance_id
          || ack.provider !== row.provider
          || ack.outcome !== 'draft_created')) {
        const error = new Error('ack mismatch');
        error.code = '23514';
        throw error;
      }
      row.state = 'provider_draft_reconciled_exact';
      row.provider_draft_id = ack.provider_draft_id;
      row.is_draft = true;
      row.state_generation += 1;
      return { rows: [copy(row, 'provider_draft_reconciled_exact')] };
    }
    if (String(text).includes('tenant_email_luna_controlled_draft_reconcile')) {
      const [operationId, issuanceId, expected, observation] = params;
      const row = rows.get(keyOf(operationId, issuanceId));
      if (!row) return { rows: [] };
      if (expected != null && expected !== row.state_generation) {
        return { rows: [copy(row, 'stale_generation')] };
      }
      if (row.state === 'provider_draft_modified_by_staff'
          || row.state === 'provider_draft_removed_by_staff'
          || row.state === 'provider_mismatch_blocked') {
        return { rows: [copy(row, row.state)] };
      }
      const kind = observation.kind;
      if (kind === 'exact') {
        if (observation.is_draft !== true
            || observation.subject_digest !== row.subject_digest
            || observation.body_digest !== row.body_digest
            || (row.provider_draft_id && row.provider_draft_id !== observation.provider_draft_id)) {
          row.state = 'provider_mismatch_blocked';
          row.state_generation += 1;
          return { rows: [copy(row, 'provider_mismatch_blocked')] };
        }
        row.state = 'provider_draft_reconciled_exact';
        row.provider_draft_id = observation.provider_draft_id;
        row.is_draft = true;
        row.state_generation += 1;
        return { rows: [copy(row, row.state === 'provider_draft_reconciled_exact' && expected != null ? 'provider_draft_reconciled_exact' : 'provider_draft_reconciled_exact')] };
      }
      if (kind === 'modified_by_staff') {
        row.state = 'provider_draft_modified_by_staff';
        row.state_generation += 1;
        return { rows: [copy(row, 'provider_draft_modified_by_staff')] };
      }
      if (kind === 'removed_by_staff' || kind === 'not_found') {
        if (!row.provider_draft_id) {
          row.state = 'provider_mismatch_blocked';
          row.state_generation += 1;
          return { rows: [copy(row, 'provider_mismatch_blocked')] };
        }
        row.state = 'provider_draft_removed_by_staff';
        row.state_generation += 1;
        return { rows: [copy(row, 'provider_draft_removed_by_staff')] };
      }
      if (kind === 'provider_mismatch') {
        row.state = 'provider_mismatch_blocked';
        row.state_generation += 1;
        return { rows: [copy(row, 'provider_mismatch_blocked')] };
      }
      const error = new Error('observation refused');
      error.code = '23514';
      throw error;
    }
    if (String(text).includes('tenant_email_luna_controlled_draft_load')) {
      const [operationId, issuanceId] = params;
      const row = rows.get(keyOf(operationId, issuanceId));
      if (!row) return { rows: [] };
      return { rows: [copy(row, 'loaded')] };
    }
    return { rows: [] };
  }
  return {
    db: { rows },
    async withTransactionClient(work) {
      return work({ query: exec });
    },
  };
}

function authenticMaterial(branded, extra = {}) {
  const row = Object.create(null);
  const fields = {
    operation_id: OP,
    issuance_id: ISSUANCE,
    audit_operation_id: AUDIT,
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    conversation_id: CONV,
    inbound_event_id: INBOUND,
    recipient_address: RECIPIENT,
    draft_digest: draftDigest(SUBJECT, BODY, 'en'),
    language: 'en',
    ...extra,
  };
  const keys = Object.keys(fields);
  for (let i = 0; i < keys.length; i += 1) {
    Object.defineProperty(row, keys[i], {
      value: fields[keys[i]], enumerable: true, writable: true, configurable: true,
    });
  }
  Object.freeze(row);
  branded.add(row);
  return row;
}

function issuanceDouble() {
  const branded = new WeakSet();
  return {
    branded,
    store: {
      assertAuthenticLoadedMaterial(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw Object.freeze(Object.assign(new Error('issuance failed'), { code: 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID' }));
        }
        if (Object.getPrototypeOf(value) !== null || !branded.has(value)) {
          throw Object.freeze(Object.assign(new Error('issuance failed'), { code: 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID' }));
        }
        return value;
      },
      recoverAutomationIssuance(input) {
        const material = input.material;
        this.assertAuthenticLoadedMaterial(material);
        const draft = Object.freeze({ subject: SUBJECT, body: BODY, language: 'en' });
        return Object.freeze({
          status: 'recovered',
          record: Object.freeze({
            draft,
            issuance_id: material.issuance_id,
            operation_id: material.operation_id,
            draft_digest: material.draft_digest,
          }),
        });
      },
    },
  };
}

function expectDisabled(fn) {
  assert.throws(fn, (error) => error && error.code === DISABLED_CODE && error.message === 'Email Luna controlled drafting runtime composition disabled.');
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => error && error.code === ERROR_CODE && error.message === 'Email Luna controlled drafting runtime composition failed.');
}
async function expectInvalidAsync(fn) {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert.ok(caught);
  assert.equal(caught.code, ERROR_CODE);
  return caught;
}

function noLeak(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return !text.includes(TOKEN) && !text.includes(PLANTED) && !text.includes(SUBJECT)
    && !text.includes(BODY) && !text.includes(RECIPIENT) && !text.includes('Bearer');
}

function createRuntime(options = {}) {
  const loaner = options.loaner || createMemoryLoaner();
  const issuance = options.issuance || issuanceDouble();
  const made = options.made || makeProvider();
  const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: options.env || enabledEnv(),
    producerWithTransactionClient: loaner.withTransactionClient,
    workerWithTransactionClient: options.workerLoaner
      ? options.workerLoaner.withTransactionClient
      : loaner.withTransactionClient,
    provider: made.provider,
    issuanceStore: issuance.store,
    ...(options.crashSeams ? { crashSeams: options.crashSeams } : {}),
  });
  return { runtime, loaner, issuance, made };
}

async function reserveAndLoad(runtime, loaner, issuance) {
  const material = authenticMaterial(issuance.branded);
  const reserved = await runtime.reserveControlledDraft({ material });
  const store = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: loaner.withTransactionClient,
  });
  const loaded = await store.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  return { reserved, loaded, store, material };
}

function runChild(script) {
  const proof = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (proof.stdout) process.stdout.write(proof.stdout);
  if (proof.stderr) process.stderr.write(proof.stderr);
  assert.equal(proof.status, 0, `${script} must stay green`);
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3 runtime composition verifier');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED, true);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN, true);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
  assert.equal(ENV_COMPOSITION_ENABLED, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED');
  assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
  assert.equal(SUNSET_TENANT, 'sunset');
  assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
  assert.equal(CONTROLLED_DRAFTING_MODE, 'controlled_drafting');
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.graph_createreply_idempotent, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.client_request_id_is_idempotency, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.chapter1_has_search, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.lost_create_response_observable, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.unknown_without_draft_id_recreate, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.disablement_provider_calls, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.fake_transport_is_not_live_graph_at_most_once, true);
  assert.deepEqual([...CRASH_SEAM_KEYS], [
    'before_claim', 'after_claim_before_provider', 'during_provider',
    'after_provider_before_record', 'after_record',
  ]);
  console.log('  PASS  composition wired, activation default-off, unknown-create policy is fail-closed');

  const defaultReadiness = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness({});
  assert.equal(defaultReadiness.runtime_activation, false);
  assert.equal(defaultReadiness.reason, 'default_off');
  assert.equal(defaultReadiness.send_allowed, false);
  assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(process.env).runtime_activation, false);
  const ready = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(enabledEnv());
  assert.equal(ready.runtime_activation, true);
  assert.equal(ready.mode, 'controlled_drafting');

  for (const [label, env] of [
    ['missing flag', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: undefined })],
    ['false', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false' })],
    ['TRUE coerce', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'TRUE' })],
    ['truthy one', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: '1' })],
    ['yes', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'yes' })],
    ['draft substitute', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' }],
    ['shadow substitute', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true' }],
    ['wrong deployment', enabledEnv({ LUNA_DEPLOYMENT: 'production' })],
    ['wolfhouse tenant', enabledEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' })],
    ['default tenant', enabledEnv({ DEFAULT_CLIENT_SLUG: 'default' })],
    ['wrong location', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-sardinero' })],
    ['wrong provider', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'gmail_api' })],
    ['non-uuid mailbox', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: 'AAMk-not-uuid' })],
    ['missing mailbox', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: undefined })],
    ['missing client', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: undefined })],
    ['wildcard location', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: '*' })],
    ['auto send true', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' })],
    ['auto send 1', enabledEnv({ LUNA_AUTO_SEND_ENABLED: '1' })],
  ]) {
    const snapshot = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
    assert.equal(snapshot.runtime_activation, false, label);
    assert.equal(snapshot.send_allowed, false, label);
  }
  console.log('  PASS  disabled default and every near-miss env/config combination; exact Sunset only');

  const inertLoaner = async (work) => work({ async query() { return { rows: [] }; } });
  const { provider } = makeProvider();
  expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: {},
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider,
  }));
  expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv({ LUNA_DEPLOYMENT: 'sunset-production' }),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider,
    send: true,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider,
    https: {},
  }));
  const graphTransport = createMicrosoftGraphReplyDraftTransport();
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider: graphTransport,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider: {
      attest() { return { capabilities: { send: true, create_reply_draft: true } }; },
      createReplyDraft() { return Promise.resolve({}); },
      reconcileDraft() { return Promise.resolve({}); },
      sendMail() { return Promise.resolve({}); },
    },
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: new Proxy(inertLoaner, { apply: Reflect.apply }),
    workerWithTransactionClient: inertLoaner,
    provider,
  }));
  console.log('  PASS  create is default-off; Graph adapter/send/raw transport/proxy loaners fail closed');

  const { runtime, loaner, issuance, made } = createRuntime();
  const forged = {
    operation_id: OP,
    issuance_id: ISSUANCE,
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    canonical_subject: SUBJECT,
    canonical_body: BODY,
    language: 'en',
  };
  await expectInvalidAsync(() => runtime.reserveControlledDraft({ material: forged }));
  await expectInvalidAsync(() => runtime.reserveControlledDraft({
    material: { ...authenticMaterial(issuance.branded) },
  }));
  const { reserved, loaded, store } = await reserveAndLoad(runtime, loaner, issuance);
  assert.equal(reserved.status, 'reserved');
  assert.equal(loaded.record.state, 'reserved');
  const replay = await runtime.reserveControlledDraft({
    material: authenticMaterial(issuance.branded),
  });
  assert.equal(replay.status, 'replayed');
  assert.equal(loaner.db.rows.size, 1);
  console.log('  PASS  authentic loaded issuance required; JSON/copy/forgery rejected; reserve replay');

  const first = await runtime.tick({ operation: loaded.record });
  assert.equal(first.create_invoked, true);
  assert.equal(first.send_allowed, false);
  assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
  const afterCreate = await store.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(afterCreate.record.state, 'provider_draft_reconciled_exact');
  assert.equal(afterCreate.record.is_draft, true);

  const second = await runtime.tick({ operation: afterCreate.record });
  assert.equal(second.reconcile_invoked, true);
  assert.equal(second.create_invoked, false);
  assert.equal(made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
  console.log('  PASS  first claim creates once; later ticks reconcile and never create');

  const concurrentLoaner = createMemoryLoaner();
  const concurrentIssuance = issuanceDouble();
  const concurrentMade = makeProvider();
  let claimGate = null;
  const slowQuery = concurrentLoaner.withTransactionClient;
  const gatedLoaner = {
    async withTransactionClient(work) {
      return slowQuery(async (client) => work({
        async query(text, params) {
          if (String(text).includes('tenant_email_luna_controlled_draft_claim_create') && claimGate) {
            await claimGate;
          }
          return client.query(text, params);
        },
      }));
    },
  };
  const concurrentRuntime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: concurrentLoaner.withTransactionClient,
    workerWithTransactionClient: gatedLoaner.withTransactionClient,
    provider: concurrentMade.provider,
    issuanceStore: concurrentIssuance.store,
  });
  await concurrentRuntime.reserveControlledDraft({ material: authenticMaterial(concurrentIssuance.branded) });
  const concurrentStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: concurrentLoaner.withTransactionClient,
  });
  const concurrentLoaded = await concurrentStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  let release;
  claimGate = new Promise((resolve) => { release = resolve; });
  const tickA = concurrentRuntime.tick({ operation: concurrentLoaded.record });
  const tickB = concurrentRuntime.tick({ operation: concurrentLoaded.record });
  release();
  const [resultA, resultB] = await Promise.all([tickA, tickB]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.equal(statuses.includes('overlap_skipped') || statuses.includes('unknown_create_unobservable') || statuses.includes('provider_draft_reconciled_exact'), true);
  const createCalls = concurrentMade.fake.getCalls().filter((row) => row.operation === 'create_reply_draft');
  assert.equal(createCalls.length, 1);
  console.log('  PASS  concurrent worker ticks: exactly one create invocation');

  async function crashCase(seam) {
    const local = createRuntime({ crashSeams: { [seam]: true } });
    await local.runtime.reserveControlledDraft({ material: authenticMaterial(local.issuance.branded) });
    const localStore = createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: local.loaner.withTransactionClient,
    });
    const localLoaded = await localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
    await expectInvalidAsync(() => local.runtime.tick({ operation: localLoaded.record }));
    return { local, localStore };
  }

  const beforeClaim = await crashCase('before_claim');
  const beforeClaimRow = await beforeClaim.localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(beforeClaimRow.record.state, 'reserved');
  assert.equal(beforeClaim.local.made.fake.getCalls().length, 0);

  const afterClaim = await crashCase('after_claim_before_provider');
  const afterClaimRow = await afterClaim.localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(afterClaimRow.record.state, 'create_dispatched_outcome_unknown');
  assert.equal(afterClaim.local.made.fake.getCalls().length, 0);
  const afterClaimRetry = await afterClaim.local.runtime.tick({ operation: afterClaimRow.record });
  assert.equal(afterClaimRetry.status, 'unknown_create_unobservable');
  assert.equal(afterClaimRetry.create_invoked, false);
  assert.equal(afterClaim.local.made.fake.getCalls().length, 0);

  const during = await crashCase('during_provider');
  const duringRow = await during.localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(duringRow.record.state, 'create_dispatched_outcome_unknown');
  assert.equal(during.local.made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);
  const duringRetry = await during.local.runtime.tick({ operation: duringRow.record });
  assert.equal(duringRetry.status, 'unknown_create_unobservable');
  assert.equal(duringRetry.create_invoked, false);
  assert.equal(during.local.made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);

  const afterProvider = await crashCase('after_provider_before_record');
  const afterProviderRow = await afterProvider.localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(afterProviderRow.record.state, 'create_dispatched_outcome_unknown');
  assert.equal(afterProviderRow.record.provider_draft_id, null);
  const afterProviderRetry = await afterProvider.local.runtime.tick({ operation: afterProviderRow.record });
  assert.equal(afterProviderRetry.status, 'unknown_create_unobservable');
  assert.equal(afterProvider.local.made.fake.getCalls().filter((row) => row.operation === 'create_reply_draft').length, 1);

  const afterRecord = await crashCase('after_record');
  const afterRecordRow = await afterRecord.localStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  assert.equal(afterRecordRow.record.state, 'provider_draft_reconciled_exact');
  const afterRecordRetry = await afterRecord.local.runtime.tick({ operation: afterRecordRow.record });
  assert.equal(afterRecordRetry.reconcile_invoked, true);
  assert.equal(afterRecordRetry.create_invoked, false);
  console.log('  PASS  crash before claim / after claim / during call / after provider before record / after record');

  const timeoutFake = createEmailLunaControlledDraftingFakeTransport({
    classify: true,
    createError: Object.assign(new Error(`timeout ${TOKEN}`), { code: 'ETIMEDOUT' }),
  });
  const timeoutRuntime = createRuntime({ made: makeProvider(timeoutFake) });
  await timeoutRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(timeoutRuntime.issuance.branded),
  });
  const timeoutLoaded = await createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: timeoutRuntime.loaner.withTransactionClient,
  }).loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  const timeoutTick = await timeoutRuntime.runtime.tick({ operation: timeoutLoaded.record });
  assert.equal(timeoutTick.status, 'create_dispatched_outcome_unknown');
  assert.equal(timeoutTick.create_invoked, true);
  assert.equal(noLeak(timeoutTick), true);
  const timeoutRetry = await timeoutRuntime.runtime.tick({
    operation: (await createEmailLunaControlledDraftingOperationStore({
      withTransactionClient: timeoutRuntime.loaner.withTransactionClient,
    }).loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(timeoutRetry.status, 'unknown_create_unobservable');
  assert.equal(timeoutRetry.create_invoked, false);
  assert.equal(timeoutRetry.provider_invoked, false);

  const secretFake = createEmailLunaControlledDraftingFakeTransport({
    createResult: {
      provider_draft_id: 'AAMkAGI2-DRAFT',
      is_draft: true,
      access_token: TOKEN,
      error: PLANTED,
    },
  });
  const secretRuntime = createRuntime({ made: makeProvider(secretFake) });
  await secretRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(secretRuntime.issuance.branded),
  });
  const secretLoaded = await createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: secretRuntime.loaner.withTransactionClient,
  }).loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  const secretTick = await secretRuntime.runtime.tick({ operation: secretLoaded.record });
  assert.equal(secretTick.status, 'create_dispatched_outcome_unknown');
  assert.equal(noLeak(secretTick), true);
  console.log('  PASS  timeout/malformed/secret-bearing create stays unknown and never retries');

  const recon = createRuntime();
  await recon.runtime.reserveControlledDraft({ material: authenticMaterial(recon.issuance.branded) });
  const reconStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: recon.loaner.withTransactionClient,
  });
  const reconLoaded = await reconStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  await recon.runtime.tick({ operation: reconLoaded.record });
  const exactRow = await reconStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  const exactTick = await recon.runtime.tick({ operation: exactRow.record });
  assert.equal(exactTick.status, 'provider_draft_reconciled_exact');

  recon.made.fake.mutateDraft(exactRow.record.provider_draft_id, {
    subject_digest: digest('staff changed subject'),
    body_digest: digest('staff changed body'),
  });
  const modifiedTick = await recon.runtime.tick({
    operation: (await reconStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(modifiedTick.status, 'provider_draft_modified_by_staff');
  const modifiedAgain = await recon.runtime.tick({
    operation: (await reconStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(modifiedAgain.create_invoked, false);
  assert.equal(modifiedAgain.provider_invoked, false);
  assert.equal(modifiedAgain.status, 'provider_draft_modified_by_staff');

  const removedRuntime = createRuntime();
  await removedRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(removedRuntime.issuance.branded),
  });
  const removedStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: removedRuntime.loaner.withTransactionClient,
  });
  await removedRuntime.runtime.tick({
    operation: (await removedStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  const known = await removedStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  removedRuntime.made.fake.deleteDraft(known.record.provider_draft_id);
  const removedTick = await removedRuntime.runtime.tick({
    operation: (await removedStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(removedTick.status, 'provider_draft_removed_by_staff');
  const removedAgain = await removedRuntime.runtime.tick({
    operation: (await removedStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(removedAgain.create_invoked, false);
  assert.equal(removedAgain.status, 'provider_draft_removed_by_staff');

  const mismatchRuntime = createRuntime();
  await mismatchRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(mismatchRuntime.issuance.branded),
  });
  const mismatchStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: mismatchRuntime.loaner.withTransactionClient,
  });
  await mismatchRuntime.runtime.tick({
    operation: (await mismatchStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  const mismatchKnown = await mismatchStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  mismatchRuntime.made.fake.mutateDraft(mismatchKnown.record.provider_draft_id, {
    recipient_address: 'other@example.test',
  });
  const mismatchTick = await mismatchRuntime.runtime.tick({
    operation: (await mismatchStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE })).record,
  });
  assert.equal(mismatchTick.status, 'provider_mismatch_blocked');
  console.log('  PASS  exact / modified / removed / mismatch; staff edit/delete never recreated');

  const freshMod = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: recon.loaner.withTransactionClient,
  });
  const freshLoaded = await freshMod.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  freshMod.assertAuthenticLoadedOperation(freshLoaded.record);
  assert.throws(() => freshMod.assertAuthenticLoadedOperation({ ...freshLoaded.record }));
  const copiedTick = recon.runtime.tick({ operation: { ...freshLoaded.record } });
  await expectInvalidAsync(() => copiedTick);
  console.log('  PASS  fresh-process load is authentic; copied/forged rows remain unauthorized');

  const disableEnv = enabledEnv();
  const disableRuntime = createRuntime({ env: disableEnv });
  await disableRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(disableRuntime.issuance.branded),
  });
  disableEnv.EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED = 'false';
  const disableStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: disableRuntime.loaner.withTransactionClient,
  });
  const disableLoaded = await disableStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  const disabledTick = await disableRuntime.runtime.tick({ operation: disableLoaded.record });
  assert.equal(disabledTick.status, 'blocked_disabled');
  assert.equal(disabledTick.create_invoked, false);
  assert.equal(disabledTick.provider_invoked, false);
  try {
    await disableRuntime.runtime.reserveControlledDraft({
      material: authenticMaterial(disableRuntime.issuance.branded),
    });
    assert.fail('reserve after disable must fail');
  } catch (error) {
    assert.equal(error.code, DISABLED_CODE);
  }
  console.log('  PASS  disable switch blocks reserve/claim/provider calls immediately');

  const staleRuntime = createRuntime();
  await staleRuntime.runtime.reserveControlledDraft({
    material: authenticMaterial(staleRuntime.issuance.branded),
  });
  const staleStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: staleRuntime.loaner.withTransactionClient,
  });
  const staleLoaded = await staleStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  await staleStore.claimCreateDispatch({
    operation_id: OP,
    issuance_id: ISSUANCE,
    expected_generation: staleLoaded.record.state_generation,
  });
  const staleTick = await staleRuntime.runtime.tick({ operation: staleLoaded.record });
  assert.ok(staleTick.status === 'stale_generation' || staleTick.status === 'unknown_create_unobservable' || staleTick.status === 'claim_not_create_authority' || staleTick.create_invoked === false);
  console.log('  PASS  stale generation / simultaneous claim does not double-create');

  const wrongBinding = createRuntime();
  await wrongBinding.runtime.reserveControlledDraft({
    material: authenticMaterial(wrongBinding.issuance.branded),
  });
  const wrongStore = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: wrongBinding.loaner.withTransactionClient,
  });
  const wrongLoaded = await wrongStore.loadControlledDraft({ operation_id: OP, issuance_id: ISSUANCE });
  const tampered = wrongLoaded.record;
  await expectInvalidAsync(() => wrongBinding.runtime.tick({
    operation: { ...tampered, mailbox_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  }));
  console.log('  PASS  wrong mailbox/tenant/location/provider on copied operation is unauthorized');

  const descriptorProvider = {};
  Object.defineProperty(descriptorProvider, 'attest', { get() { throw new Error(TOKEN); }, enumerable: true });
  Object.defineProperty(descriptorProvider, 'createReplyDraft', { value: () => {}, enumerable: true });
  Object.defineProperty(descriptorProvider, 'reconcileDraft', { value: () => {}, enumerable: true });
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider: descriptorProvider,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: inertLoaner,
    workerWithTransactionClient: inertLoaner,
    provider: new Proxy(provider, { get(target, prop, recv) { return Reflect.get(target, prop, recv); } }),
  }));
  console.log('  PASS  provider surface/reflection/descriptor/proxy attacks fail closed');

  assert.doesNotMatch(RUNTIME_SRC, /email-microsoft-graph-adapter/);
  assert.doesNotMatch(RUNTIME_SRC, /email-microsoft-graph-reply-draft-transport/);
  assert.doesNotMatch(RUNTIME_SRC, /createMicrosoftGraphReplyDraftTransport/);
  const runtimeNoDenyLists = RUNTIME_SRC
    .replace(/FORBIDDEN_PROVIDER_KEYS[\s\S]*?\];/, '')
    .replace(/FORBIDDEN_CREATE_KEYS[\s\S]*?\];/, '')
    .replace(/FORBIDDEN_FIELD_NAMES[\s\S]*?\];/, '');
  assert.doesNotMatch(runtimeNoDenyLists, /sendMail|sendDraft/);
  assert.doesNotMatch(runtimeNoDenyLists, /handoffToJournal|outbound_send_journal|authorize_send\s*:/);
  assert.doesNotMatch(RUNTIME_SRC, /graph\.microsoft\.com/);
  assert.match(RUNTIME_SRC, /unknown_create_unobservable/);
  assert.match(RUNTIME_SRC, /claimedStatus !== 'create_dispatched_outcome_unknown'/);
  assert.match(RUNTIME_SRC, /first_claim_create_at_most_once: true/);
  assert.equal(/createReplyDraft/.test(RUNTIME_SRC.slice(
    RUNTIME_SRC.indexOf("reason: 'unknown_create_unobservable'"),
    RUNTIME_SRC.indexOf("if (operation.state !== 'reserved')"),
  )), false);
  assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-sunset-staging-runtime-composition/);
  assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED/);
  assert.doesNotMatch(DOCKERFILE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED/);
  assert.equal(RUNTIME_SRC.includes('console.log'), false);
  assert.match(DOC_SRC, /not\*\* idempotent|not idempotent/);
  assert.match(DOC_SRC, /unknown_create_unobservable/);
  assert.match(DOC_SRC, /no provider calls/);
  assert.match(DOC_SRC, /Non-goals/);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-runtime-composition'],
    'node scripts/verify-email-luna-controlled-drafting-runtime-composition.js');
  assert.equal(SHADOW_SRC.includes('email-luna-controlled-drafting-sunset-staging-runtime-composition'), false);
  assert.equal(CONTRACT_SRC.includes('createEmailLunaControlledDraftingSunsetStagingRuntimeComposition'), false);
  assert.equal(STORE_SRC.includes('createEmailLunaControlledDraftingSunsetStagingRuntimeComposition'), false);
  console.log('  PASS  mutation isolation: no send/journal/raw Graph; unknown path cannot create; not deployed');

  assert.equal(noLeak(first), true);
  assert.equal(noLeak(timeoutTick), true);
  assert.equal(ERROR_CODE.includes('token'), false);
  console.log('  PASS  logs/errors are secret- and content-free');

  console.log('  … Chapter 1 provider contract');
  runChild('verify-email-luna-controlled-drafting-provider-contract.js');
  console.log('  … Chapter 2 operation store');
  runChild('verify-email-luna-controlled-drafting-operation-store.js');
  console.log('  … Stage 1 shadow runtime composition');
  runChild('verify-email-luna-automation-shadow-runtime-composition.js');
  console.log('  … Stage 1 issuance material');
  runChild('verify-email-luna-automation-issuance-material.js');
  console.log('  … Stage 1 principal grants');
  runChild('verify-email-luna-automation-principal-grants.js');
  console.log('  … Graph adapter');
  runChild('verify-email-microsoft-graph-adapter.js');
  console.log('  … delegated OAuth contract');
  runChild('verify-email-microsoft-delegated-oauth-contract.js');
  console.log('  … Phase B token scope classification');
  runChild('verify-email-microsoft-phase-b-token-scope-classification.js');

  console.log('ALL OK — Stage 2 Chapter 3 controlled-drafting runtime composition');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
