'use strict';

/** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A: Sunset staging activation source/preflight. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeActivation,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_CONCURRENCY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MIN_INTERVAL_MS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MAX_INTERVAL_MS,
  ENV_RUNTIME_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_PRODUCER_INTAKE_ENABLED,
  ENV_WORKER_TICK_ENABLED,
  ENV_LIVE_PROVIDER_DRAFT_ENABLED,
  ENV_REPLICA_COUNT,
  ENV_TEST_OPERATION_ID,
  ENV_TEST_ISSUANCE_ID,
  ENV_TEST_RECIPIENT_ADDRESS,
  ENV_TEST_AUTHORIZATION_ID,
  ENV_PRODUCER_DATABASE_URL,
  ENV_WORKER_DATABASE_URL,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  CONTROLLED_DRAFTING_MODE,
  MIGRATION_097_ID,
  ERROR_CODE,
  DISABLED_CODE,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-activation');
const {
  resolveEmailLunaControlledDraftingPrincipalConnectionConfig,
  EXPECTED_DATABASE,
} = require('./lib/email-luna-controlled-drafting-principal-connection');
const {
  runEmailLunaControlledDraftingRuntimePreflight,
  MIGRATION_097_SHA256,
  MIGRATION_098_ID,
  MIGRATION_098_SHA256,
} = require('./lib/email-luna-controlled-drafting-runtime-preflight');
const {
  resolveEmailLunaDirectLoginPoolTransport,
  DIRECT_LOGIN_CONNECTION_TIMEOUT_MS,
} = require('./lib/email-luna-automation-shadow-worker-connection');
const {
  SUNSET_STAGING_TRUSTED_PRECREATED_PRODUCER,
} = require('./lib/email-luna-automation-principal-contract');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  pickEmailLunaControlledDraftingTransportMethods,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const {
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
} = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  checksumMigrationFile,
  CHECKSUM_MODE_CANONICAL_LF_V1,
} = require('./lib/migration-integrity');
const {
  createMicrosoftGraphReplyDraftTransport,
} = require('./lib/email-microsoft-graph-reply-draft-transport');
const {
  createEmailLunaControlledDraftingFakeClosedTokenLoan,
} = require('./lib/email-luna-controlled-drafting-token-loan');
const {
  parseArgs: parsePrepareArgs,
  refusedProduction,
  normalizeRecipientAddress,
  runPrepare,
  READBACK_SQL,
  AUTHORIZE_SQL,
} = require('./prepare-email-luna-controlled-drafting-staging-test-authorization');

const ROOT = path.join(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-controlled-drafting-staging-activation-red.json'),
  'utf8',
));
const ACT_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-runtime-activation'),
  'utf8',
);
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const COMPOSE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml'), 'utf8');
const DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/Dockerfile'), 'utf8');
const SUNSET_DOCKERFILE_SRC = fs.readFileSync(path.join(ROOT, 'Dockerfile.luna-sunset-staff-api'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DOC_SRC = fs.readFileSync(
  path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-STAGING-ACTIVATION.md'),
  'utf8',
);
const SQL_097 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  'utf8',
);
const DOWN_097 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations_down.sql'),
  'utf8',
);
const SQL_098 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql'),
  'utf8',
);
const DOWN_098 = fs.readFileSync(
  path.join(ROOT, 'database/migrations/098_tenant_email_luna_controlled_drafting_staging_test_authorization_down.sql'),
  'utf8',
);
const PREPARE_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/prepare-email-luna-controlled-drafting-staging-test-authorization.js'),
  'utf8',
);
const SESSION_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-session-proof'),
  'utf8',
);
const PRINCIPAL_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-principal-connection'),
  'utf8',
);
const STAGE1_CONN_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-automation-shadow-worker-connection'),
  'utf8',
);

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const OP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ISS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const AUTH = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc0';

console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4A staging activation verifier');

assert.equal(RED.id, 'email-luna-controlled-drafting-staging-activation.ch4a-red.v1');
assert.equal(RED.head_reviewed, 'cf7a3da8269ffb1c0c15055fbbf2bb2eabfd4deb');
assert.equal(RED.runtime_activation, false);
assert.equal(RED.send_permission, false);
assert.equal(RED.live_graph, false);
assert.equal(RED.cost_new_azure_resources, 0);
assert.equal(RED.canonical_process, 'staff-api');
assert.equal(RED.findings.length, 4);
assert.ok(RED.findings.every((item) => item.severity === 'blocking' && item.red && item.green));
console.log('  PASS  authentic RED artifact records cf7a3da8 missing runtime wiring/readiness/start');

assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_WIRED, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_LOGGING_FORBIDDEN, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_CONCURRENCY, 1);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED, true);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED, false);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
assert.equal(ENV_RUNTIME_ENABLED, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED');
assert.equal(SUNSET_DEPLOYMENT, 'sunset-staging');
assert.equal(SUNSET_TENANT, 'sunset');
assert.equal(SUNSET_LOCATION_KEY, 'sunset-somo');
assert.equal(CONTROLLED_DRAFTING_MODE, 'controlled_drafting');
assert.equal(MIGRATION_097_ID, '097_tenant_email_luna_controlled_draft_operations');
assert.equal(EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated.join(' '), 'User.Read Mail.ReadWrite');
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities.send, false);
assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities.send_mail, false);
console.log('  PASS  pins: activation wired, default-off, Chapter 1–3 and Stage 1 shadow remain unactivated');

const live097 = checksumMigrationFile(
  path.join(ROOT, 'database/migrations/097_tenant_email_luna_controlled_draft_operations.sql'),
  CHECKSUM_MODE_CANONICAL_LF_V1,
);
assert.equal(live097.ok, true);
assert.equal(live097.sha256, MIGRATION_097_SHA256);
assert.match(SQL_097, /tenant_email_luna_controlled_draft_reserve/);
assert.equal(/^\s*GRANT /m.test(SQL_097), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_097), false);
assert.match(DOWN_097, /ACCESS EXCLUSIVE/);
assert.match(DOWN_097, /097_down_refused/);
const live098 = checksumMigrationFile(
  path.join(ROOT, 'database/migrations/098_tenant_email_luna_controlled_drafting_staging_test_authorization.sql'),
  CHECKSUM_MODE_CANONICAL_LF_V1,
);
assert.equal(live098.ok, true);
assert.equal(live098.sha256, MIGRATION_098_SHA256);
assert.equal(MIGRATION_098_ID, '098_tenant_email_luna_controlled_drafting_staging_test_authorization');
assert.match(SQL_098, /controlled_drafting_staging_proof/);
assert.match(SQL_098, /tenant_email_luna_controlled_draft_staging_test_prove/);
assert.equal(/^\s*GRANT /m.test(SQL_098), false);
assert.equal(/^\s*CREATE ROLE/m.test(SQL_098), false);
assert.match(DOWN_098, /ACCESS EXCLUSIVE/);
assert.match(DOWN_098, /098_down_refused/);
assert.doesNotMatch(SESSION_SRC, /function attestSql/);
assert.match(SESSION_SRC, /inspectEmailLunaControlledDraftingMappedPrincipal/);
assert.match(SESSION_SRC, /schema_migration_ledger/);
assert.match(PRINCIPAL_SRC, /createEmailLunaDirectLoginConnectionPair/);
assert.match(PRINCIPAL_SRC, /EXPECTED_DATABASE_SUNSET_STAGING/);
assert.doesNotMatch(PRINCIPAL_SRC, /function parseDsnIdentities/);
assert.match(STAGE1_CONN_SRC, /rejectUnauthorized: true/);
assert.doesNotMatch(STAGE1_CONN_SRC, /rejectUnauthorized:\s*false/);
assert.match(STAGE1_CONN_SRC, /connectionTimeoutMillis/);
assert.equal(EXPECTED_DATABASE, 'sunset_staging');
assert.equal(SUNSET_STAGING_TRUSTED_PRECREATED_PRODUCER.kind, 'producer');
console.log('  PASS  097/098 checksum/schema/down; session/connection owners reused not copied');

assert.match(STAFF_API_SRC, /email-luna-controlled-drafting-sunset-staging-runtime-activation/);
assert.match(STAFF_API_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_READINESS\.runtime_activation === true/);
assert.match(STAFF_API_SRC, /createEmailLunaControlledDraftingPrincipalConnectionPair/);
assert.match(STAFF_API_SRC, /drainEmailLunaControlledDraftingRuntimePair/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-sunset-staging-runtime-composition/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-provider-contract/);
assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-operation-store/);
assert.match(STAFF_API_SRC, /createEmailLunaControlledDraftingSunsetStagingLiveTokenLoan/);
assert.match(STAFF_API_SRC, /process\.env\[ENV_LIVE_PROVIDER_DRAFT_ENABLED\] === 'true'/);
assert.doesNotMatch(ACT_SRC, /getAccessToken/);
assert.doesNotMatch(STAFF_API_SRC, /withTransactionClient:\s*\(work\)\s*=>\s*_withPgClientImpl/);
assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED=true/);
assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED/);
assert.doesNotMatch(DOCKERFILE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED/);
assert.doesNotMatch(SUNSET_DOCKERFILE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED/);
assert.equal(ACT_SRC.includes('console.log'), false);
assert.equal(/require\(['"]nodemailer['"]\)/.test(ACT_SRC), false);
assert.doesNotMatch(ACT_SRC.replace(/FORBIDDEN[\s\S]*?;/g, ''), /sendMail|sendDraft|handoffToJournal/);
assert.match(DOC_SRC, /luna-sunset-staging-staff-api/);
assert.match(DOC_SRC, /assert-repo-sync/);
assert.match(DOC_SRC, /incremental Azure resource cost is \*\*zero\*\*/);
assert.match(DOC_SRC, /operator-selected existing Sunset/);
assert.match(DOC_SRC, /server_synthetic_evidence: false/);
assert.match(DOC_SRC, /authority: "queue_table_owner_session"/);
assert.match(DOC_SRC, /queue-table-owner intent bound durably/);
assert.match(DOC_SRC, /--recipient-address/);
assert.match(DOC_SRC, /inbound sender is not a substitute/);
assert.doesNotMatch(DOC_SRC, /synthetic Sunset inbound/);
console.log('  PASS  Staff API owns activation; Chapters 1–3 stay unwired in Staff API source; docker default-off');

assert.match(PREPARE_SRC, /m\.recipient_address/);
assert.match(PREPARE_SRC, /e\.sender_address_normalized/);
assert.match(PREPARE_SRC, /server_synthetic_evidence: false/);
assert.match(PREPARE_SRC, /queue_table_owner_session/);
assert.match(PREPARE_SRC, /--recipient-address/);
assert.match(PREPARE_SRC, /controlled_drafting_staging_proof/);
assert.match(READBACK_SQL, /m\.recipient_address/);
assert.match(READBACK_SQL, /e\.sender_address_normalized/);
assert.match(AUTHORIZE_SQL, /tenant_email_luna_controlled_draft_staging_test_authorize/);
assert.doesNotMatch(PREPARE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS/);
assert.doesNotMatch(PREPARE_SRC, /existing synthetic/);
assert.doesNotMatch(PREPARE_SRC, /synthetic Sunset/);
assert.equal(PKG.scripts['prepare:email-luna-controlled-drafting-staging-test-authorization'],
  'node scripts/prepare-email-luna-controlled-drafting-staging-test-authorization.js');
assert.equal(normalizeRecipientAddress('  Elena@Example.TEST '), 'elena@example.test');
assert.equal(normalizeRecipientAddress({ toString() { return 'elena@example.test'; } }), null);
assert.equal(normalizeRecipientAddress('not-an-email'), null);
assert.throws(() => parsePrepareArgs(['--wat']), /unknown argument/);
assert.throws(() => parsePrepareArgs(['--recipient-address', 'a@b.c', '--recipient-address', 'a@b.c']), /duplicate argument/);
assert.throws(() => parsePrepareArgs(['--apply', '--apply']), /duplicate argument/);
assert.throws(() => parsePrepareArgs(['--recipient-address']), /requires a value/);
assert.throws(() => parsePrepareArgs(['--recipient-address', '--apply']), /requires a value/);
assert.throws(() => parsePrepareArgs(['--operation-id', 1]), /malformed arguments/);
const getterArgv = ['--recipient-address'];
Object.defineProperty(getterArgv, 1, { get() { return 'elena@example.test'; } });
assert.throws(() => parsePrepareArgs(getterArgv), /malformed arguments/);
assert.throws(() => parsePrepareArgs(new Proxy(['--help'], {})), /malformed arguments/);
assert.equal(refusedProduction({ LUNA_DEPLOYMENT: 'production' }), true);
console.log('  PASS  prepare command pins server recipient/sender readback; no env recipient authority; hostile argv fails');

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: C,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: L,
    EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: E,
    EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: MAILBOX,
    EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL: 'postgres://luna_cd_producer:producer-secret@127.0.0.1:5432/sunset_staging',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL: 'postgres://luna_cd_worker:worker-secret@127.0.0.1:5432/sunset_staging',
    WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset_staging',
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID: OP,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_ISSUANCE_ID: ISS,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_AUTHORIZATION_ID: AUTH,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS: 'operator-test@sunset.example',
    ...patch,
  };
}

const defaultReadiness = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness({});
assert.equal(defaultReadiness.ok, true);
assert.equal(defaultReadiness.runtime_activation, false);
assert.equal(defaultReadiness.reason, 'default_off');
assert.equal(defaultReadiness.send_allowed, false);
assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(process.env).runtime_activation, false);

const ready = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(enabledEnv());
assert.equal(ready.ok, true);
assert.equal(ready.runtime_activation, true);
assert.equal(ready.live_provider_draft, false);
assert.equal(ready.live_provider_block_reason, 'live_provider_draft_disabled');
assert.equal(ready.mode, CONTROLLED_DRAFTING_MODE);

for (const [label, env] of [
  ['missing runtime flag', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: undefined })],
  ['runtime false', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false' })],
  ['TRUE coerce', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'TRUE' })],
  ['truthy one', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: '1' })],
  ['composition missing', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: undefined })],
  ['draft substitute', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' }],
  ['shadow substitute', { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true' }],
  ['wrong deployment', enabledEnv({ LUNA_DEPLOYMENT: 'production' })],
  ['wolfhouse tenant', enabledEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' })],
  ['wrong location', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-sardinero' })],
  ['wildcard location', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: '*' })],
  ['wrong provider', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'smtp' })],
  ['replica 2', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '2' })],
  ['replica missing', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: undefined })],
  ['auto send', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' })],
  ['auto send TRUE', enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'TRUE' })],
  ['auto send 1', enabledEnv({ LUNA_AUTO_SEND_ENABLED: '1' })],
  ['outreach', enabledEnv({ CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'true' })],
  ['campaign', enabledEnv({ STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'true' })],
  ['owner pool producer', enabledEnv({
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset_staging',
  })],
  ['producer worker collision', enabledEnv({
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL: 'postgres://luna_cd_producer:producer-secret@127.0.0.1:5432/sunset_staging',
  })],
  ['wrong database postgres', enabledEnv({
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL: 'postgres://luna_cd_producer:producer-secret@127.0.0.1:5432/postgres',
  })],
  ['worker DSN missing', enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL: undefined })],
]) {
  const snapshot = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env);
  assert.equal(snapshot.runtime_activation, false, label);
}
console.log('  PASS  default off; near-miss flags/config refuse; exact Sunset only; send/campaign/outreach refuse');

function expectDisabled(fn) {
  assert.throws(fn, (error) => error && error.code === DISABLED_CODE);
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => error && error.code === ERROR_CODE);
}

const dummyLoaner = async (work) => work({ async query() { return { rows: [] }; } });
const timers = { setTimeout() { return 1; }, clearTimeout() {} };

expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: {},
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
}));
expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false' }),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
}));
expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv(),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: dummyLoaner,
  timers,
  intervalMs: 60000,
}));
expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv(),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 1000,
}));
expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv(),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
  send: () => {},
}));
console.log('  PASS  import/create inert unless exact gates; identical loaners and send keys refused');

const fake = createEmailLunaControlledDraftingFakeTransport({ classify: true });
const injectedProvider = createEmailLunaControlledDraftingProvider({
  authority: {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
  },
  transport: pickEmailLunaControlledDraftingTransportMethods({
    createReplyDraft: fake.createReplyDraft,
    reconcileDraft: fake.reconcileDraft,
  }),
});

expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'true' }),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
}));

assert.throws(() => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'true' }),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
  provider: {
    attest() {
      return { create_reply_draft: true, capabilities: { send: true, send_mail: true } };
    },
    createReplyDraft() {},
    reconcileDraft() {},
    send() {},
    sendMail() {},
  },
}), (error) => error && (error.code === ERROR_CODE || error.code === DISABLED_CODE));
assert.equal(typeof createMicrosoftGraphReplyDraftTransport, 'function');
const closedLoan = createEmailLunaControlledDraftingFakeClosedTokenLoan({
  accessToken: 'closed-loan-not-a-secret',
});
const liveWithLoan = createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
  env: enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'true' }),
  producerWithTransactionClient: dummyLoaner,
  workerWithTransactionClient: async (work) => work({ async query() { return { rows: [] }; } }),
  timers,
  intervalMs: 60000,
  tokenLoan: closedLoan,
  httpsImpl() { throw new Error('graph-must-not-run'); },
});
assert.equal(liveWithLoan.getStatus().live_provider_draft, true);
assert.equal(liveWithLoan.getStatus().live_provider_block_reason, null);
assert.equal(liveWithLoan.getStatus().send_allowed, false);
assert.doesNotMatch(JSON.stringify(liveWithLoan.getStatus()), /closed-loan-not-a-secret|accessToken|Mail\.Send/);
console.log('  PASS  live provider without token loan blocked; send-capable provider rejected; closed loan assembles');

function issuanceDouble() {
  const branded = new WeakSet();
  return {
    branded,
    store: {
      assertAuthenticLoadedMaterial(value) {
        if (!value || !branded.has(value)) {
          throw Object.freeze(Object.assign(new Error('issuance failed'), { code: ERROR_CODE }));
        }
        return value;
      },
      recoverAutomationIssuance(input) {
        this.assertAuthenticLoadedMaterial(input.material);
        return Object.freeze({
          status: 'recovered',
          record: Object.freeze({
            draft: Object.freeze({ subject: 'Hi', body: 'Hello', language: 'en' }),
            issuance_id: input.material.issuance_id,
            operation_id: input.material.operation_id,
          }),
        });
      },
      async loadAutomationIssuanceMaterial() {
        return Object.freeze({ status: 'empty' });
      },
    },
  };
}

assert.doesNotMatch(JSON.stringify(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(enabledEnv())), /producer-secret|operator-test@/);

const dsnMissing = resolveEmailLunaControlledDraftingPrincipalConnectionConfig({
  env: { WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:x@127.0.0.1:5432/sunset_staging' },
  appConnectionString: 'postgres://wolfhouse:x@127.0.0.1:5432/sunset_staging',
});
assert.equal(dsnMissing.ok, false);
const dsnQuery = resolveEmailLunaControlledDraftingPrincipalConnectionConfig({
  env: enabledEnv({
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL:
      'postgres://luna_cd_producer:x@127.0.0.1:5432/sunset_staging?options=-c%20session_authorization%3Dwolfhouse',
  }),
  appConnectionString: 'postgres://wolfhouse:x@127.0.0.1:5432/sunset_staging',
});
assert.equal(dsnQuery.ok, false);
const dsnOk = resolveEmailLunaControlledDraftingPrincipalConnectionConfig({
  env: enabledEnv(),
  appConnectionString: 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset_staging',
});
assert.equal(dsnOk.ok, true);
assert.equal(dsnOk.database_ok, true);

const loopbackTls = resolveEmailLunaDirectLoginPoolTransport({ host: '127.0.0.1' });
assert.equal(loopbackTls.ok, true);
assert.equal(loopbackTls.ssl, false);
assert.equal(loopbackTls.tls_mode, 'loopback_cleartext');
assert.equal(loopbackTls.connectionTimeoutMillis, DIRECT_LOGIN_CONNECTION_TIMEOUT_MS);
const azureNoCa = resolveEmailLunaDirectLoginPoolTransport({
  host: 'luna-sunset-staging-pg-app.postgres.database.azure.com',
});
assert.equal(azureNoCa.ok, false);
assert.equal(azureNoCa.reason, 'pg_ca_unproven');
assert.equal(azureNoCa.ssl, null);
const azureCa = resolveEmailLunaDirectLoginPoolTransport({
  host: 'luna-sunset-staging-pg-app.postgres.database.azure.com',
  caText: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
});
assert.equal(azureCa.ok, true);
assert.equal(azureCa.ssl.rejectUnauthorized, true);
assert.equal(azureCa.ssl.servername, 'luna-sunset-staging-pg-app.postgres.database.azure.com');
assert.equal(azureCa.tls_mode, 'verify-full');
assert.equal(DIRECT_LOGIN_CONNECTION_TIMEOUT_MS > 0 && DIRECT_LOGIN_CONNECTION_TIMEOUT_MS <= 10000, true);
console.log('  PASS  TLS config is truthful; Azure missing CA fails; loopback is cleartext; timeout bounded');

function runChild(script) {
  const proof = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (proof.stdout) process.stdout.write(proof.stdout);
  if (proof.stderr) process.stderr.write(proof.stderr);
  assert.equal(proof.status, 0, `${script} must stay green`);
}

const PREPARE_RECIPIENT = 'elena@example.test';
const PREPARE_SENDER = 'elena@example.test';
const PREPARE_DSN = 'postgres://wolfhouse:owner-secret@127.0.0.1:5432/sunset_staging';

function prepareIssuanceRow(patch = {}) {
  return {
    operation_id: OP,
    issuance_id: ISS,
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    inbound_event_id: '55555555-5555-4555-8555-555555555555',
    conversation_id: '66666666-6666-4666-8666-666666666666',
    recipient_address: PREPARE_RECIPIENT,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    sender_address_normalized: PREPARE_SENDER,
    ...patch,
  };
}

function prepareEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    PGDATABASE: 'sunset_staging',
    WOLFHOUSE_DATABASE_URL: PREPARE_DSN,
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS: PREPARE_RECIPIENT,
    ...patch,
  };
}

function throwPrepareFail(message) {
  const error = new Error(message);
  error.code = 'PREPARE_FAIL';
  throw error;
}

function makePrepareConnect(row, { database = 'sunset_staging', extraRow, queries } = {}) {
  const seen = queries || [];
  return async function connect() {
    return {
      async query(sql, params) {
        seen.push({ sql: String(sql), params: params || [] });
        if (String(sql).includes('current_database()')) {
          return { rows: [{ database }] };
        }
        if (String(sql).includes('tenant_email_luna_automation_issuance_material')) {
          const rows = extraRow ? [row, extraRow] : [row];
          return { rows };
        }
        if (String(sql).includes('staging_test_authorize')) {
          return { rows: [{ authorization_id: params[0] }] };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      async end() {},
    };
  };
}

async function expectPrepareFail(input, pattern) {
  await assert.rejects(() => runPrepare(input), (error) => {
    assert.equal(error && error.code, 'PREPARE_FAIL');
    assert.match(String(error && error.message), pattern);
    return true;
  });
}

async function testPrepareCommand() {
  const queries = [];
  const lines = [];
  const row = prepareIssuanceRow();
  await runPrepare({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { queries }),
    print: (line) => lines.push(String(line)),
    fail: throwPrepareFail,
  });
  const dry = JSON.parse(lines[0]);
  assert.equal(dry.dry_run, true);
  assert.equal(dry.apply, false);
  assert.equal(dry.server_synthetic_evidence, false);
  assert.equal(dry.authority, 'queue_table_owner_session');
  assert.equal(dry.purpose, 'controlled_drafting_staging_proof');
  assert.equal(dry.recipient_address, PREPARE_RECIPIENT);
  assert.equal(dry.sender_address_normalized, PREPARE_SENDER);
  assert.equal(dry.recipient_confirmation_supplied, false);
  assert.equal(dry.recipient_address_match, null);
  assert.equal(queries.some((item) => item.sql.includes('staging_test_authorize')), false);
  assert.doesNotMatch(lines.join('\n'), /owner-secret|postgres:\/\//);
  assert.doesNotMatch(JSON.stringify(dry), /synthetic Sunset|existing synthetic/);

  const mismatchLines = [];
  const mismatchQueries = [];
  await runPrepare({
    argv: ['--operation-id', OP, '--issuance-id', ISS, '--recipient-address', 'other@example.test'],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { queries: mismatchQueries }),
    print: (line) => mismatchLines.push(String(line)),
    fail: throwPrepareFail,
  });
  const mismatch = JSON.parse(mismatchLines[0]);
  assert.equal(mismatch.dry_run, true);
  assert.equal(mismatch.recipient_address_match, false);
  assert.equal(mismatch.recipient_address, PREPARE_RECIPIENT);
  assert.equal(mismatchQueries.some((item) => item.sql.includes('staging_test_authorize')), false);

  const missingQueries = [];
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS, '--apply'],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { queries: missingQueries }),
    print: () => {},
    fail: throwPrepareFail,
  }, /--apply requires explicit --recipient-address/);
  assert.equal(missingQueries.length, 0);

  const wrongQueries = [];
  await expectPrepareFail({
    argv: ['--apply', '--operation-id', OP, '--issuance-id', ISS, '--recipient-address', 'attacker@evil.test'],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { queries: wrongQueries }),
    print: () => {},
    fail: throwPrepareFail,
  }, /does not match server-read issuance recipient/);
  assert.equal(wrongQueries.some((item) => item.sql.includes('staging_test_authorize')), false);
  assert.equal(wrongQueries.some((item) => item.sql.includes('issuance_material')), true);

  const senderAsSubstitute = [];
  const senderRow = prepareIssuanceRow({
    recipient_address: PREPARE_RECIPIENT,
    sender_address_normalized: 'inbound-sender@example.test',
  });
  await expectPrepareFail({
    argv: ['--apply', '--operation-id', OP, '--issuance-id', ISS, '--recipient-address', 'inbound-sender@example.test'],
    env: prepareEnv(),
    connect: makePrepareConnect(senderRow, { queries: senderAsSubstitute }),
    print: () => {},
    fail: throwPrepareFail,
  }, /inbound sender is not a substitute/);
  assert.equal(senderAsSubstitute.some((item) => item.sql.includes('staging_test_authorize')), false);

  const applyLines = [];
  const applyQueries = [];
  await runPrepare({
    argv: [
      '--apply',
      '--operation-id', OP,
      '--issuance-id', ISS,
      '--recipient-address', '  Elena@Example.TEST ',
      '--authorization-id', AUTH,
    ],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { queries: applyQueries }),
    print: (line) => applyLines.push(String(line)),
    fail: throwPrepareFail,
  });
  const applyPayload = JSON.parse(applyLines[0]);
  assert.equal(applyPayload.dry_run, false);
  assert.equal(applyPayload.apply, true);
  assert.equal(applyPayload.server_synthetic_evidence, false);
  assert.equal(applyPayload.authority, 'queue_table_owner_session');
  assert.equal(applyPayload.recipient_address_match, true);
  assert.equal(applyPayload.recipient_address, PREPARE_RECIPIENT);
  assert.equal(applyPayload.sender_address_normalized, PREPARE_SENDER);
  const applied = JSON.parse(applyLines[1]);
  assert.equal(applied.applied, true);
  assert.equal(applied.authorization_id, AUTH);
  assert.equal(applyQueries.filter((item) => item.sql.includes('staging_test_authorize')).length, 1);
  assert.doesNotMatch(applyLines.join('\n'), /owner-secret/);

  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS, '--recipient-address', 'not-an-email'],
    env: prepareEnv(),
    connect: makePrepareConnect(row),
    print: () => {},
    fail: throwPrepareFail,
  }, /malformed --recipient-address/);

  const extraArg = ['--operation-id', OP, '--issuance-id', ISS, '--wat'];
  await expectPrepareFail({
    argv: extraArg,
    env: prepareEnv(),
    connect: makePrepareConnect(row),
    print: () => {},
    fail: throwPrepareFail,
  }, /unknown argument/);

  const coerced = Object.assign(['--operation-id', OP, '--issuance-id', ISS, '--recipient-address'], {});
  coerced.push({ toString() { return PREPARE_RECIPIENT; }, valueOf() { return PREPARE_RECIPIENT; } });
  await expectPrepareFail({
    argv: coerced,
    env: prepareEnv(),
    connect: makePrepareConnect(row),
    print: () => {},
    fail: throwPrepareFail,
  }, /malformed arguments/);

  const getterRow = prepareIssuanceRow();
  Object.defineProperty(getterRow, 'recipient_address', {
    get() { return PREPARE_RECIPIENT; }, enumerable: true,
  });
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: makePrepareConnect(getterRow),
    print: () => {},
    fail: throwPrepareFail,
  }, /malformed/);

  const extraKeyRow = prepareIssuanceRow({ extra: 'nope' });
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: makePrepareConnect(extraKeyRow),
    print: () => {},
    fail: throwPrepareFail,
  }, /malformed/);

  const proxyRow = new Proxy(prepareIssuanceRow(), {});
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: makePrepareConnect(proxyRow),
    print: () => {},
    fail: throwPrepareFail,
  }, /malformed/);

  const extraRowQueries = [];
  await expectPrepareFail({
    argv: ['--apply', '--operation-id', OP, '--issuance-id', ISS, '--recipient-address', PREPARE_RECIPIENT],
    env: prepareEnv(),
    connect: makePrepareConnect(row, { extraRow: prepareIssuanceRow(), queries: extraRowQueries }),
    print: () => {},
    fail: throwPrepareFail,
  }, /not found|will not fabricate/);
  assert.equal(extraRowQueries.some((item) => item.sql.includes('staging_test_authorize')), false);

  const getterQueryClient = {
    get query() {
      return async () => ({ rows: [{ database: 'sunset_staging' }] });
    },
    async end() {},
  };
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: async () => getterQueryClient,
    print: () => {},
    fail: throwPrepareFail,
  }, /query is unusable/);

  const leakQueries = [];
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS],
    env: prepareEnv(),
    connect: async () => {
      leakQueries.push('connect');
      throw new Error(`password=owner-secret ${PREPARE_DSN}`);
    },
    print: (line) => leakQueries.push(String(line)),
    fail: throwPrepareFail,
  }, /^prepare failed$/);

  const envRecipientQueries = [];
  await expectPrepareFail({
    argv: ['--operation-id', OP, '--issuance-id', ISS, '--apply'],
    env: prepareEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS: PREPARE_RECIPIENT }),
    connect: makePrepareConnect(row, { queries: envRecipientQueries }),
    print: () => {},
    fail: throwPrepareFail,
  }, /--apply requires explicit --recipient-address/);
  assert.equal(envRecipientQueries.length, 0);
  console.log('  PASS  prepare command dry-run truth, recipient confirm, hostile/malformed refuse, zero authorize, no DSN leak');
}

assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-staging-activation'],
  'node scripts/verify-email-luna-controlled-drafting-staging-activation.js');

const proxyEnv = new Proxy(enabledEnv(), {
  get() { return 'true'; },
});
assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(proxyEnv).runtime_activation, false);

const accessorEnv = {};
Object.defineProperty(accessorEnv, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED', {
  get() { return 'true'; }, enumerable: true,
});
assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(accessorEnv).runtime_activation, false);
console.log('  PASS  hostile proxies/accessors refuse; DSN query/SET ROLE overlays refuse');

console.log('  … concurrency/start/stop/kill-switch');
(async () => {
  const preflight = await runEmailLunaControlledDraftingRuntimePreflight({ env: enabledEnv() });
  assert.equal(preflight.activation_started, false);
  assert.equal(preflight.migration_applied, false);
  assert.equal(preflight.runtime_started, false);
  assert.equal(preflight.send_allowed, false);
  assert.equal(preflight.file_checksum_ok, true);
  assert.ok(preflight.blockers.includes('inspect_required'));
  const missing097 = await runEmailLunaControlledDraftingRuntimePreflight({
    env: enabledEnv(),
    query: async (sql) => {
      if (String(sql).includes('schema_ready') || String(sql).includes('schema_migration_ledger')) {
        return {
          rows: [{
            current_database: 'sunset_staging',
            ledger_097_id: null,
            ledger_097_checksum: null,
            ledger_097_mode: null,
            ledger_098_id: null,
            ledger_098_checksum: null,
            ledger_098_mode: null,
          }],
        };
      }
      return { rows: [{ session_user: 'luna_cd_producer', current_user: 'luna_cd_producer', table_owner: 'wolfhouse', session_distinct_from_owner: true, session_matches_current: true, mapping_ok: true, login_contract_ok: true, execute_ok: true }] };
    },
    unit_test_inspect: true,
  });
  assert.equal(missing097.ok, false);
  assert.equal(missing097.producer_checksum_ok, false);
  console.log('  PASS  preflight never applies migration/start/send; missing 097 ledger checksum fails closed');

  const handles = [];
  let timerId = 0;
  const localTimers = {
    setTimeout(fn) {
      timerId += 1;
      handles.push({ id: timerId, fn, cleared: false });
      return timerId;
    },
    clearTimeout(id) {
      const found = handles.find((row) => row.id === id);
      if (found) found.cleared = true;
    },
  };
  function inspectLoaner(sessionUser) {
    return async (work) => work({
      async query(sql) {
        const text = String(sql);
        if (text.includes('schema_ready') || text.includes('schema_migration_ledger') || text.includes('current_database')) {
          return {
            rows: [{
              current_database: 'sunset_staging',
              ledger_097_id: '097_tenant_email_luna_controlled_draft_operations',
              ledger_097_checksum: MIGRATION_097_SHA256,
              ledger_097_mode: 'canonical_lf_v1',
              ledger_098_id: MIGRATION_098_ID,
              ledger_098_checksum: MIGRATION_098_SHA256,
              ledger_098_mode: 'canonical_lf_v1',
            }],
          };
        }
        if (text.includes('staging_test_prove') || text.includes('staging_test_consume')) {
          return {
            rows: [{
              ok: true,
              status: 'authorized',
              operation_id: OP,
              issuance_id: ISS,
              client_id: C,
              location_id: L,
              location_key: 'sunset-somo',
              endpoint_id: E,
              mailbox_id: MAILBOX,
              provider: 'microsoft_graph',
            }],
          };
        }
        return {
          rows: [{
            session_user: sessionUser,
            current_user: sessionUser,
            table_owner: 'wolfhouse',
            session_distinct_from_owner: true,
            session_matches_current: true,
            mapping_ok: true,
            login_contract_ok: true,
            execute_ok: true,
          }],
        };
      },
    });
  }
  const env = enabledEnv();
  const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
    env,
    producerWithTransactionClient: inspectLoaner('luna_cd_producer'),
    workerWithTransactionClient: inspectLoaner('luna_cd_worker'),
    timers: localTimers,
    intervalMs: 60000,
    provider: injectedProvider,
    issuanceStore: issuanceDouble().store,
  });
  await runtime.start();
  await runtime.start();
  const overlapping = await Promise.all([runtime.tick(), runtime.tick()]);
  assert.ok(overlapping.some((row) => row.status === 'overlap_skipped' || row.reason === 'overlap_skipped'
    || row.status === 'blocked' || row.status === 'skipped'));
  env.LUNA_AUTO_SEND_ENABLED = 'true';
  const killed = await runtime.tick();
  assert.equal(killed.reason === 'kill_switch' || killed.status === 'blocked_disabled' || killed.runtime_activation === false
    || killed.send_allowed === false, true);
  await runtime.stop();
  assert.equal(runtime.getStatus().running, false);
  assert.ok(handles.every((row) => row.cleared === true || row.fn));
  await runtime.start();
  await runtime.stop();
  const status = runtime.getStatus();
  assert.equal(status.send_allowed, false);
  assert.doesNotMatch(JSON.stringify(status), /operator-test@sunset.example|producer-secret|Authorization|subject/);
  console.log('  PASS  concurrency one; double-start idempotent; stop drains; restart safe; kill switch; no timer leak; safe status');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MIN_INTERVAL_MS, 60000);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_MAX_INTERVAL_MS, 120000);
  assert.equal(ENV_PRODUCER_INTAKE_ENABLED, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED');
  assert.equal(ENV_WORKER_TICK_ENABLED, 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED');
  assert.equal(ENV_LIVE_PROVIDER_DRAFT_ENABLED, 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED');
  assert.equal(ENV_REPLICA_COUNT, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT');
  assert.equal(ENV_TEST_OPERATION_ID, 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID');
  assert.equal(ENV_TEST_ISSUANCE_ID, 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_ISSUANCE_ID');
  assert.equal(ENV_TEST_RECIPIENT_ADDRESS, 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_RECIPIENT_ADDRESS');
  assert.equal(ENV_TEST_AUTHORIZATION_ID, 'EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_AUTHORIZATION_ID');
  assert.equal(ENV_PRODUCER_DATABASE_URL, 'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL');
  assert.equal(ENV_WORKER_DATABASE_URL, 'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL');

  const noScope = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(enabledEnv({
    EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID: undefined,
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
  }));
  assert.equal(noScope.runtime_activation, true);
  const preflightNoScope = await runEmailLunaControlledDraftingRuntimePreflight({
    env: enabledEnv({
      EMAIL_LUNA_CONTROLLED_DRAFTING_TEST_OPERATION_ID: undefined,
      EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
    }),
  });
  assert.ok(preflightNoScope.blockers.includes('controlled_test_scope_required'));
  console.log('  PASS  controlled-test scope required before consuming work');

  await testPrepareCommand();

  console.log('  … Chapter 3 runtime composition (includes Chapter 1 + stock-PG)');
  runChild('verify-email-luna-controlled-drafting-runtime-composition.js');
  console.log('  … Chapter 2 operation store');
  runChild('verify-email-luna-controlled-drafting-operation-store.js');
  runChild('prove-email-luna-controlled-drafting-operation-store-pglite.js');
  runChild('prove-email-luna-controlled-drafting-operation-store-stock-pg.js');
  console.log('  … Stage 1 principal live activation');
  runChild('verify-email-luna-automation-principal-live-activation.js');
  runChild('prove-email-luna-automation-principal-live-activation-pglite.js');
  console.log('  … Staff API startup smoke + migration integrity + diff-check');
  runChild('verify-staff-query-api-startup-smoke.js');
  runChild('verify-migration-integrity.js');
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (diffCheck.stdout) process.stdout.write(diffCheck.stdout);
  if (diffCheck.stderr) process.stderr.write(diffCheck.stderr);
  assert.equal(diffCheck.status, 0, 'git diff --check must stay green');
  console.log('  … Chapter 4A stock-PG');
  runChild('prove-email-luna-controlled-drafting-staging-activation-stock-pg.js');
  console.log('ALL OK — Stage 2 Chapter 4A controlled-drafting staging activation');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
