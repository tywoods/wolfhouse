'use strict';

/** FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 3: runtime composition. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_SEND_ALLOWED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_JOURNAL_HANDOFF,
  EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY,
  ENV_COMPOSITION_ENABLED,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  CONTROLLED_DRAFTING_MODE,
  ERROR_CODE,
  DISABLED_CODE,
  CRASH_SEAM_KEYS,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
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

function dummyLoaner() {
  return async (work) => work({ async query() { return { rows: [] }; } });
}

function brandedPair() {
  return {
    producer: bindProducerWithTransactionClient(dummyLoaner()),
    worker: bindWorkerWithTransactionClient(dummyLoaner()),
  };
}

function dummyIssuance() {
  return {
    assertAuthenticLoadedMaterial() { throw Object.freeze(Object.assign(new Error('unused'), { code: ERROR_CODE })); },
    recoverAutomationIssuance() { throw Object.freeze(Object.assign(new Error('unused'), { code: ERROR_CODE })); },
  };
}

function makeProvider() {
  const fake = createEmailLunaControlledDraftingFakeTransport({ classify: true });
  return createEmailLunaControlledDraftingProvider({
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
}

function expectDisabled(fn) {
  assert.throws(fn, (error) => error && error.code === DISABLED_CODE);
}
function expectInvalid(fn) {
  assert.throws(fn, (error) => error && error.code === ERROR_CODE);
}

function runChild(script) {
  const proof = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (proof.stdout) process.stdout.write(proof.stdout);
  if (proof.stderr) process.stderr.write(proof.stderr);
  assert.equal(proof.status, 0, `${script} must stay green`);
}

async function proveClosedAttestParsing(provider, issuanceStore) {
  async function expectGetterReject(loanerFactory, flag) {
    const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: bindProducerWithTransactionClient(loanerFactory),
      workerWithTransactionClient: brandedPair().worker,
      provider,
      issuanceStore,
    });
    let rejected = false;
    try {
      await runtime.reserveControlledDraft({ material: Object.freeze({}) });
    } catch (error) {
      rejected = error && error.code === ERROR_CODE;
    }
    assert.equal(rejected, true);
    assert.equal(flag.ran, false);
  }

  const resultFlag = { ran: false };
  await expectGetterReject(async (work) => work({
    async query() {
      const result = {};
      Object.defineProperty(result, 'rows', {
        enumerable: true,
        configurable: true,
        get() {
          resultFlag.ran = true;
          return [{}];
        },
      });
      return result;
    },
  }), resultFlag);

  const rowFlag = { ran: false };
  await expectGetterReject(async (work) => work({
    async query() {
      const rows = [];
      Object.defineProperty(rows, '0', {
        enumerable: true,
        configurable: true,
        get() {
          rowFlag.ran = true;
          return {
            session_user: 'luna',
            current_user: 'luna',
            table_owner: 'postgres',
            session_distinct_from_owner: true,
            session_matches_current: true,
            mapping_ok: true,
            login_contract_ok: true,
            execute_ok: true,
          };
        },
      });
      Object.defineProperty(rows, 'length', {
        value: 1, enumerable: false, writable: true, configurable: true,
      });
      const result = {};
      Object.defineProperty(result, 'rows', {
        value: rows, enumerable: true, writable: true, configurable: true,
      });
      return result;
    },
  }), rowFlag);

  const extraFlag = { ran: false };
  await expectGetterReject(async (work) => work({
    async query() {
      extraFlag.ran = true;
      const row = {
        session_user: 'luna',
        current_user: 'luna',
        table_owner: 'postgres',
        session_distinct_from_owner: true,
        session_matches_current: true,
        mapping_ok: true,
        login_contract_ok: true,
        execute_ok: true,
        extra: true,
      };
      return { rows: [row] };
    },
  }), { ran: false });
  assert.equal(extraFlag.ran, true, 'exact extra-column row is read via ownData then refused');

  const proxyFlag = { ran: false };
  await expectGetterReject(async (work) => work({
    async query() {
      const row = new Proxy({
        session_user: 'luna',
        current_user: 'luna',
        table_owner: 'postgres',
        session_distinct_from_owner: true,
        session_matches_current: true,
        mapping_ok: true,
        login_contract_ok: true,
        execute_ok: true,
      }, {
        get(target, prop, receiver) {
          proxyFlag.ran = true;
          return Reflect.get(target, prop, receiver);
        },
      });
      const result = {};
      Object.defineProperty(result, 'rows', {
        value: [row], enumerable: true, writable: true, configurable: true,
      });
      return result;
    },
  }), proxyFlag);

  console.log('  PASS  getter/proxy/extra attest rows fail closed without inherited accessors');
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
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.lost_create_response_observable, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.unknown_without_draft_id_recreate, false);
  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_UNKNOWN_CREATE_POLICY.disablement_provider_calls, false);
  assert.deepEqual([...CRASH_SEAM_KEYS], [
    'before_claim', 'after_claim_before_provider', 'during_provider',
    'after_provider_before_record', 'after_record',
  ]);
  assert.match(RUNTIME_SRC, /isTrustedControlledDraftingTokenLoanNoProviderPostFailure/);
  assert.match(RUNTIME_SRC, /token_loan_failed_after_claim_no_provider_post/);
  assert.match(DOC_SRC, /uncertainty_persistence/);
  assert.match(DOC_SRC, /provider_create_unknown/);
  console.log('  PASS  composition wired, activation default-off, unknown-create policy is fail-closed');

  assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness({}).runtime_activation, false);
  assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(process.env).runtime_activation, false);
  const ready = resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(enabledEnv());
  assert.equal(ready.runtime_activation, true);
  for (const env of [
    enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: undefined }),
    enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'TRUE' }),
    enabledEnv({ EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: '1' }),
    { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true' },
    enabledEnv({ LUNA_DEPLOYMENT: 'production' }),
    enabledEnv({ DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' }),
    enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' }),
  ]) {
    assert.equal(resolveEmailLunaControlledDraftingSunsetStagingRuntimeReadiness(env).runtime_activation, false);
  }
  console.log('  PASS  disabled default and every near-miss env/config combination; exact Sunset only');

  const provider = makeProvider();
  const pair = brandedPair();
  const issuanceStore = dummyIssuance();
  expectDisabled(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: {},
    producerWithTransactionClient: pair.producer,
    workerWithTransactionClient: pair.worker,
    provider,
    issuanceStore,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: pair.producer,
    workerWithTransactionClient: pair.worker,
    provider,
    issuanceStore,
    send: true,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: pair.producer,
    workerWithTransactionClient: pair.worker,
    provider: createMicrosoftGraphReplyDraftTransport(),
    issuanceStore,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: pair.producer,
    workerWithTransactionClient: pair.worker,
    issuanceStore,
    provider: {
      attest() { return { capabilities: { send: true, create_reply_draft: true } }; },
      createReplyDraft() { return Promise.resolve({}); },
      reconcileDraft() { return Promise.resolve({}); },
      sendMail() { return Promise.resolve({}); },
    },
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: new Proxy(dummyLoaner(), { apply: Reflect.apply }),
    workerWithTransactionClient: brandedPair().worker,
    provider,
    issuanceStore,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: dummyLoaner(),
    workerWithTransactionClient: dummyLoaner(),
    provider,
    issuanceStore,
  }));
  const shared = dummyLoaner();
  expectInvalid(() => {
    const producer = bindProducerWithTransactionClient(shared);
    const worker = bindWorkerWithTransactionClient(shared);
    return createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
      env: enabledEnv(),
      producerWithTransactionClient: producer,
      workerWithTransactionClient: worker,
      provider,
      issuanceStore,
    });
  });
  const same = bindProducerWithTransactionClient(dummyLoaner());
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: same,
    workerWithTransactionClient: same,
    provider,
    issuanceStore,
  }));
  expectInvalid(() => createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: bindWorkerWithTransactionClient(dummyLoaner()),
    workerWithTransactionClient: bindProducerWithTransactionClient(dummyLoaner()),
    provider,
    issuanceStore,
  }));
  const composed = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    producerWithTransactionClient: brandedPair().producer,
    workerWithTransactionClient: brandedPair().worker,
    provider,
    issuanceStore,
  });
  assert.equal(typeof composed.reserveControlledDraft, 'function');
  assert.equal(typeof composed.tick, 'function');
  assert.equal(typeof composed.claimCreateDispatch, 'undefined');
  console.log('  PASS  create is default-off; Graph adapter/send/proxy/alias/swapped loaners fail closed');

  assert.doesNotMatch(RUNTIME_SRC, /email-microsoft-graph-adapter/);
  assert.doesNotMatch(RUNTIME_SRC, /email-microsoft-graph-reply-draft-transport/);
  assert.doesNotMatch(RUNTIME_SRC, /createMicrosoftGraphReplyDraftTransport/);
  assert.doesNotMatch(RUNTIME_SRC, /createMemoryLoaner/);
  const runtimeNoDenyLists = RUNTIME_SRC
    .replace(/FORBIDDEN_PROVIDER_KEYS[\s\S]*?\];/, '')
    .replace(/FORBIDDEN_CREATE_KEYS[\s\S]*?\];/, '')
    .replace(/FORBIDDEN_FIELD_NAMES[\s\S]*?\];/, '');
  assert.doesNotMatch(runtimeNoDenyLists, /sendMail|sendDraft/);
  assert.doesNotMatch(runtimeNoDenyLists, /handoffToJournal|outbound_send_journal|authorize_send\s*:/);
  assert.match(RUNTIME_SRC, /unknown_create_unobservable/);
  assert.match(RUNTIME_SRC, /bindProducerWithTransactionClient/);
  assert.match(RUNTIME_SRC, /producerFacade/);
  assert.match(RUNTIME_SRC, /attestMappedPrincipal/);
  assert.match(RUNTIME_SRC, /PRODUCER_ATTEST_SQL = attestSql\('producer'/);
  assert.match(RUNTIME_SRC, /WORKER_ATTEST_SQL = attestSql\('worker'/);
  assert.match(RUNTIME_SRC, /has_function_privilege/);
  assert.match(RUNTIME_SRC, /tenant_email_luna_automation_principal_authorized\('\$\{kindLiteral\}'/);
  assert.match(RUNTIME_SRC, /expectedKind === 'producer'/);
  assert.match(RUNTIME_SRC, /expectedKind === 'worker'/);
  assert.match(RUNTIME_SRC, /session_user::text IS DISTINCT FROM owner\.rolname::text/);
  assert.match(RUNTIME_SRC, /session_user::text IS NOT DISTINCT FROM current_user::text/);
  assert.match(RUNTIME_SRC, /ownData\(result, 'rows'\)/);
  assert.match(RUNTIME_SRC, /ownData\(rows, 0\)/);
  assert.match(RUNTIME_SRC, /exactOwnData\(row, ATTEST_KEYS\)/);
  assert.equal(RUNTIME_SRC.includes('|| result.rows'), false);
  assert.equal(RUNTIME_SRC.includes('rows = result.rows'), false);
  assert.equal(RUNTIME_SRC.includes('|| row.session_user'), false);
  assert.match(DOC_SRC, /has_function_privilege\(session_user/);
  assert.match(DOC_SRC, /principal_authorized/);
  assert.match(DOC_SRC, /SET ROLE/);
  assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-sunset-staging-runtime-composition/);
  assert.doesNotMatch(COMPOSE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED/);
  assert.doesNotMatch(DOCKERFILE_SRC, /EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED/);
  assert.equal(RUNTIME_SRC.includes('console.log'), false);
  assert.match(DOC_SRC, /not\*\* idempotent|not idempotent/);
  assert.match(DOC_SRC, /unknown_create_unobservable/);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-runtime-composition'],
    'node scripts/verify-email-luna-controlled-drafting-runtime-composition.js');
  assert.equal(SHADOW_SRC.includes('email-luna-controlled-drafting-sunset-staging-runtime-composition'), false);
  assert.equal(CONTRACT_SRC.includes('createEmailLunaControlledDraftingSunsetStagingRuntimeComposition'), false);
  assert.equal(STORE_SRC.includes('createEmailLunaControlledDraftingSunsetStagingRuntimeComposition'), false);
  console.log('  PASS  mutation isolation: no send/journal/raw Graph; no memory SQL clone; not deployed');

  await proveClosedAttestParsing(provider, issuanceStore);

  console.log('  … Chapter 1 provider contract (Graph mapping truth)');
  runChild('verify-email-luna-controlled-drafting-provider-contract.js');
  console.log('  … Chapter 3 PGlite runtime composition');
  runChild('prove-email-luna-controlled-drafting-runtime-composition-pglite.js');
  console.log('  … Chapter 3 stock-PG runtime composition');
  runChild('prove-email-luna-controlled-drafting-runtime-composition-stock-pg.js');

  console.log('ALL OK — Stage 2 Chapter 3 controlled-drafting runtime composition');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
