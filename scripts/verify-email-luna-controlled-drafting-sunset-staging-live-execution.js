'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I.
 * Source/offline one-shot Sunset staging live-execution verifier.
 * Does not execute live proof. Local fake 4H/KV/token/JWKS/PG adapters only.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  executeOnceSunsetStagingLiveProof,
  parseArgs,
  runCli,
  validateExactInvocation,
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  MACHINE_RECORD_KEYS,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EXPECTED_LIVE_TARGET,
  AZURE_OWNER,
  SUNSET_DEPLOYMENT,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner');
const publicOwner = require('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner');
const {
  createSunsetStagingLiveExecutionOwnerForTests,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support');
const ownedCore = require('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned');
const readerOwner = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  createSunsetStagingLivePreflightReaderForTests,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.test-support');
const {
  inspectIndependentLivePreflight,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: PROVER_EXECUTE,
  CONFIRMATION_PHRASE: PROVER_CONFIRM,
  runCli: proverRunCli,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER: TARGET_EXECUTE,
  composeSunsetStagingLiveDownscopeProverDependencies,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
const {
  consumeChapter4ISunsetStagingOneShotAuthority,
  isActiveChapter4ISunsetStagingOneShotAuthority,
  readChapter4IOneShotPhase,
} = require('./lib/email-luna-controlled-drafting-chapter-4i-one-shot-authority');
const {
  createMicrosoftOidcJwksSignatureVerifier,
} = require('./lib/email-microsoft-oidc-jwks-verifier');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  EIGHT_FLAGS,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEPLOYED_SHA = EXPECTED_LIVE_TARGET.deployedSha;
const REVISION = EXPECTED_LIVE_TARGET.revision;
const DIGEST = EXPECTED_LIVE_TARGET.digest;
const SOURCE_SHA = 'c'.repeat(40);
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PRINCIPAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const NEW_RT_2 = 'rt-new2-NEVER_LEAK';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';
const ISSUED = '2026-08-26T12:00:00.000Z';
const NOW_MS = Date.parse(ISSUED);
const DRAFT_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite';
const SEND_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const PRODUCER_FP = 'aa'.repeat(32);
const WORKER_FP = 'bb'.repeat(32);
const IMAGE = `whstagingacr.azurecr.io/luna-sunset-staff-api:${DEPLOYED_SHA}`;
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });
const KID = 'key-1';

function noLeak(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    try { text = String(value); } catch (__) { return false; }
  }
  return !String(text).includes('NEVER_LEAK')
    && !String(text).includes(PLANTED)
    && !String(text).includes(OLD_RT)
    && !String(text).includes('eyJ')
    && !String(text).includes('postgres://');
}

function childEnv(patch = {}) {
  const extra = '/opt/data/calendar-inventory-bridge-bf/node_modules';
  const nodePath = [extra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return Object.assign({}, process.env, { NODE_PATH: nodePath }, patch);
}

function nonce() {
  return crypto.randomBytes(32).toString('hex');
}

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }

function b64(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function signJwt(header, claims) {
  const encodedHeader = b64(header);
  const encodedClaims = b64(claims);
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function baseClaims(patch = {}) {
  return {
    tid: TID,
    oid: PRINCIPAL,
    aud: '00000003-0000-0000-c000-000000000000',
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    azp: APP_ID,
    scp: 'User.Read Mail.ReadWrite',
    ver: '2.0',
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000) - 10,
    nbf: Math.floor(Date.now() / 1000) - 10,
    ...patch,
  };
}

function liveJwt(patch) {
  return signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, baseClaims(patch));
}

function validJwks() {
  return JSON.stringify({
    keys: [{ ...exportedJwk, kid: KID, use: 'sig', alg: 'RS256' }],
  });
}

function makeJwksHarness() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headers = { 'content-type': 'application/json' };
  response.destroy = function destroyResponse() {};
  const request = new EventEmitter();
  let onResponse = null;
  request.destroy = function destroyRequest() {};
  request.end = function endRequest() {
    if (typeof onResponse === 'function') onResponse(response);
    response.emit('data', Buffer.from(validJwks()));
    response.emit('end');
    response.emit('close');
  };
  return Object.freeze({
    dependencies: Object.freeze({
      https: Object.freeze({
        request(options, callback) {
          onResponse = callback;
          return request;
        },
      }),
      crypto: Object.freeze({
        createPublicKey(input) { return crypto.createPublicKey(input); },
        verify(...args) { return crypto.verify(...args); },
      }),
      timers: Object.freeze({
        setTimeout() { return Object.freeze({ id: 1 }); },
        clearTimeout() {},
      }),
    }),
  });
}

function canonicalVerifier() {
  return createMicrosoftOidcJwksSignatureVerifier(makeJwksHarness().dependencies);
}

function eightEnv() {
  const env = [
    { name: 'LUNA_DEPLOYMENT', value: 'sunset-staging' },
    { name: 'DEFAULT_CLIENT_SLUG', value: 'sunset' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY', value: 'sunset-somo' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT', value: '1' },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID', value: CLIENT },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID', value: LOCATION },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID', value: ENDPOINT },
    { name: 'EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID', value: MAILBOX },
  ];
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    env.push({ name: EIGHT_FLAGS[i], value: 'false' });
  }
  return env;
}

function appFacts(patch = {}) {
  return Object.assign({
    subscriptionId: AZURE_OWNER.subscriptionId,
    resourceGroup: AZURE_OWNER.resourceGroup,
    name: AZURE_OWNER.appName,
    location: AZURE_OWNER.location,
    tenantTag: 'sunset',
    latestRevisionName: REVISION,
    latestReadyRevisionName: REVISION,
    runningStatus: 'Running',
    provisioningState: 'Succeeded',
    minReplicas: 1,
    maxReplicas: 1,
    traffic: [{ revisionName: REVISION, weight: 100 }],
    env: eightEnv(),
    image: IMAGE,
  }, patch);
}

function revisionFacts(patch = {}) {
  return Object.assign({
    name: REVISION,
    runningState: 'Running',
    healthState: 'Healthy',
    provisioningState: 'Provisioned',
    replicas: 1,
    image: IMAGE,
    imageDigest: DIGEST,
  }, patch);
}

function identityRow(kind) {
  const fp = kind === 'producer' ? PRODUCER_FP : WORKER_FP;
  return {
    session_matches_current: true,
    current_database: 'sunset_staging',
    ssl: 'on',
    session_fingerprint: fp,
    current_fingerprint: fp,
  };
}

function attestRow(kind) {
  const user = kind === 'producer' ? 'luna_cd_producer' : 'luna_cd_worker';
  return {
    session_user: user,
    current_user: user,
    table_owner: 'wolfhouse_admin',
    session_distinct_from_owner: true,
    session_matches_current: true,
    mapping_ok: true,
    login_contract_ok: true,
    execute_ok: true,
  };
}

function makePg(hits, overrides = {}) {
  function clientFor(kind) {
    return {
      async query(sql) {
        if (hits) {
          hits.queries.push(sql);
          if (/INSERT|UPDATE|DELETE|SET\s+ROLE/i.test(sql)) hits.writes += 1;
        }
        if (/ops_097/.test(sql)) {
          return { rows: [Object.assign({ ops_097: 0, transitions_097: 0, authorizations_098: 0 }, overrides.counts)] };
        }
        if (/session_fingerprint/.test(sql)) return { rows: [identityRow(kind)] };
        if (/grant_status/.test(sql) && /tenant_email_delegated_grants/.test(sql)) {
          return { rows: [Object.assign({
            grant_generation: 4, grant_status: 'active', reconcile_state: 'clean', has_active_lease: false,
          }, overrides.grant)] };
        }
        if (/binding_ok/.test(sql)) {
          return { rows: [{ binding_ok: true, own_user: true, mailbox_ready: true, has_active_operation: false }] };
        }
        if (/'producer'/.test(sql)) return { rows: [attestRow('producer')] };
        if (/'worker'/.test(sql)) return { rows: [attestRow('worker')] };
        throw new Error(`unexpected sql ${PLANTED}`);
      },
    };
  }
  return {
    async withProducerClient(work) {
      if (hits) hits.producer += 1;
      return work(clientFor('producer'));
    },
    async withWorkerClient(work) {
      if (hits) hits.worker += 1;
      return work(clientFor('worker'));
    },
  };
}

function makeReaderAdapters(hits, patch = {}) {
  return {
    azure: {
      async readApp() {
        if (hits) hits.app += 1;
        return appFacts(patch.app);
      },
      async listRevisions() {
        if (hits) hits.list += 1;
        return [revisionFacts(patch.revision)];
      },
      async readRevision(name) {
        if (hits) hits.rev += 1;
        return Object.assign({}, revisionFacts(patch.revision), { name });
      },
    },
    acr: {
      async readManifestDigest() {
        if (hits) hits.acr += 1;
        return patch.digest || DIGEST;
      },
    },
    pg: patch.pg || makePg(hits, patch),
    clock: patch.clock || { nowMs() { return NOW_MS; } },
  };
}

async function brandedPreflight(hits, patch) {
  const reader = createSunsetStagingLivePreflightReaderForTests(makeReaderAdapters(hits, patch));
  return reader.read();
}

function rows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}
function empty() { return { rows: [], rowCount: 0 }; }

function bindingRow(overlay = {}) {
  return Object.assign({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: TID,
    provider_resource_id: MAILBOX,
    provider_principal_oid: PRINCIPAL,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: 'operator-test@example.test',
    grant_client_id: CLIENT,
    grant_endpoint_id: ENDPOINT,
  }, overlay);
}

function createGrantMock({ sealed, opId, events, generation }) {
  const log = events || [];
  let currentGeneration = generation || 4;
  let currentSealed = sealed;
  let lastOpId = opId;
  let leaseTok = null;
  let reconcileState = 'clean';
  let grantStatus = 'active';
  const scopeVer = 'phase_b_v1';
  const bound = bindingRow();

  function statusRow() {
    return {
      client_id: CLIENT, endpoint_id: ENDPOINT,
      grant_generation: currentGeneration, grant_status: grantStatus,
      reconcile_state: reconcileState, grant_lease_token: leaseTok,
      scope_version: scopeVer,
    };
  }

  const client = {
    async query(text, params) {
      const t = String(text);
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(t)) return empty();
      if (/FROM tenant_email_delegated_grants/i.test(t)
          && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t)
          && !/tenant_channel_endpoints/i.test(t)) {
        return rows(statusRow());
      }
      if (/tenant_channel_endpoints/i.test(t) && /tenant_locations/i.test(t)) {
        return rows(bound);
      }
      if (/FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t))) {
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: grantStatus, reconcile_state: reconcileState,
          grant_lease_token: leaseTok, grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: lastOpId, scope_version: scopeVer,
          envelope_version: currentSealed.envelope_version, aead_alg: currentSealed.aead_alg,
          kek_wrap_alg: currentSealed.kek_wrap_alg, kek_key_name: currentSealed.kek_key_name,
          kek_key_version: currentSealed.kek_key_version, nonce: currentSealed.nonce,
          ciphertext: currentSealed.ciphertext, auth_tag: currentSealed.auth_tag,
          wrapped_dek: currentSealed.wrapped_dek,
          endpoint_binding_status: 'verified',
        });
      }
      if (/SET grant_status='lease_held'/i.test(t)) {
        leaseTok = params[3];
        grantStatus = 'lease_held';
        log.push({ type: 'lease', generation: currentGeneration });
        return rows(statusRow());
      }
      if (/grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t) && /envelope_version/i.test(t)) {
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: 'lease_held',
          grant_lease_token: leaseTok,
          grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: lastOpId, scope_version: scopeVer,
          envelope_version: currentSealed.envelope_version, aead_alg: currentSealed.aead_alg,
          kek_wrap_alg: currentSealed.kek_wrap_alg, kek_key_name: currentSealed.kek_key_name,
          kek_key_version: currentSealed.kek_key_version, nonce: currentSealed.nonce,
          ciphertext: currentSealed.ciphertext, auth_tag: currentSealed.auth_tag,
          wrapped_dek: currentSealed.wrapped_dek,
        });
      }
      if (/SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t)) {
        currentGeneration = Number(params[2]);
        lastOpId = params[3];
        grantStatus = 'active';
        leaseTok = null;
        reconcileState = 'clean';
        log.push({ type: 'commit', generation: currentGeneration });
        return rows(statusRow());
      }
      if (/SET reconcile_state=/i.test(t)) {
        reconcileState = params && params[2] ? params[2] : 'ms_response_uncertain';
        log.push({ type: 'uncertain', generation: currentGeneration });
        return rows(statusRow());
      }
      if (/SET grant_status='reauthorization_required'/i.test(t)) {
        grantStatus = 'reauthorization_required';
        leaseTok = null;
        log.push({ type: 'reauth' });
        return rows({ grant_generation: currentGeneration, grant_status: grantStatus });
      }
      if (/SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t)
          && !/SET grant_generation=/i.test(t)) {
        grantStatus = 'active';
        leaseTok = null;
        log.push({ type: 'abort', generation: currentGeneration });
        return rows(statusRow());
      }
      return empty();
    },
  };
  return {
    client,
    events: log,
    bag: {
      get generation() { return currentGeneration; },
      setSealed(next) { currentSealed = next; },
    },
  };
}

function successBody(accessToken, scope, refreshToken) {
  const body = {
    token_type: 'Bearer',
    expires_in: 3600,
    access_token: accessToken,
    scope,
  };
  if (refreshToken !== null && refreshToken !== undefined) body.refresh_token = refreshToken;
  return JSON.stringify(body);
}

function sequenceTransport(steps, captured) {
  let i = 0;
  return Object.freeze({
    async postTokenForm(arg) {
      if (captured) captured.push(arg && arg.body);
      const step = steps[i];
      i += 1;
      if (typeof step === 'function') return step(arg);
      if (step && step.throw) throw new Error(step.throw);
      if (step && step.raw) return step.raw;
      return Object.freeze({
        statusCode: step && step.statusCode ? step.statusCode : 200,
        contentType: step && step.contentType ? step.contentType : 'application/json',
        body: step && step.body ? step.body : successBody(step.token, step.scope, step.refreshToken),
      });
    },
  });
}

function completeArgs(patch = {}) {
  return {
    command: COMMAND,
    deployment: SUNSET_DEPLOYMENT,
    tenant: 'sunset',
    database: 'sunset_staging',
    resourceGroup: EXPECTED_LIVE_TARGET.resourceGroup,
    appName: EXPECTED_LIVE_TARGET.appName,
    revision: REVISION,
    deploySha: DEPLOYED_SHA,
    digest: DIGEST,
    sourceSha: SOURCE_SHA,
    confirm: CONFIRMATION_PHRASE,
    operatorNonce: nonce(),
    confirmIssuedAt: ISSUED,
    invalid: false,
    invalidReason: null,
    ...patch,
  };
}

function exactCliArgs(parsed) {
  return [
    'execute-once',
    '--deployment', parsed.deployment,
    '--tenant', parsed.tenant,
    '--database', parsed.database,
    '--resource-group', parsed.resourceGroup,
    '--app', parsed.appName,
    '--revision', parsed.revision,
    '--deploy-sha', parsed.deploySha,
    '--digest', parsed.digest,
    '--source-sha', parsed.sourceSha,
    '--confirm', parsed.confirm,
    '--operator-nonce', parsed.operatorNonce,
    '--confirm-issued-at', parsed.confirmIssuedAt,
  ];
}

async function makeOwner(overrides = {}) {
  const hits = overrides.hits || { app: 0, list: 0, rev: 0, acr: 0, producer: 0, worker: 0, writes: 0, queries: [] };
  const envelope = overrides.envelopeProvider || createFakeEmailGrantEnvelopeProvider();
  const op = overrides.opId || crypto.randomUUID();
  const sealed = overrides.sealed || await fakeSealRefreshToken(envelope, {
    refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
    grantGeneration: 4, operationId: op,
  });
  const events = overrides.events || [];
  const mock = overrides.mock || createGrantMock({
    sealed, opId: op, events, generation: 4,
  });
  const wrappingEnvelope = overrides.wrappingEnvelope || Object.freeze({
    async sealGrantPayload(input) {
      const next = await envelope.sealGrantPayload(input);
      mock.bag.setSealed(next);
      return next;
    },
    openGrantPayload(...args) { return envelope.openGrantPayload(...args); },
    rewrapGrantDek(...args) { return envelope.rewrapGrantDek(...args); },
  });
  const bodies = overrides.bodies || [];
  const transport = overrides.transport || sequenceTransport([
    { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
    {
      token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }),
      scope: SEND_SCOPE,
      refreshToken: NEW_RT_2,
    },
  ], bodies);
  const readerHits = overrides.readerHits || hits;
  const readIndependentLivePreflight = overrides.readIndependentLivePreflight
    || (async () => brandedPreflight(readerHits, overrides.readerPatch));
  const owner = createSunsetStagingLiveExecutionOwnerForTests({
    readIndependentLivePreflight,
    envelopeProvider: wrappingEnvelope,
    createSecretProvider: overrides.createSecretProvider
      || (() => frozenMethod('getClientSecret', async () => SECRET)),
    transport,
    createSignatureVerifier: overrides.createSignatureVerifier || (() => canonicalVerifier()),
    withPgClient: overrides.withPgClient || (async (work) => work(mock.client)),
    binding: {
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      mailboxId: MAILBOX,
    },
    applicationClientId: APP_ID,
    clock: overrides.clock || { nowMs() { return NOW_MS; } },
  });
  return { owner, mock, events, bodies, hits: readerHits };
}

function assertOwnerFailure(err, detail) {
  return err
    && err.code === ERROR_CODE
    && err.message === ERROR_MESSAGE
    && err.detail === detail
    && noLeak(err);
}

function assertAllowlisted(record) {
  const keys = Reflect.ownKeys(record);
  assert.deepEqual([...keys].sort(), [...MACHINE_RECORD_KEYS].sort());
  assert.equal(noLeak(record), true);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'scp'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(record, 'reason'), false);
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I live execution verifier');
  console.log('Live proof is NOT EXECUTED. Local fake adapters only.');

  const ownerSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner'),
    'utf8',
  );
  const ownedSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned'),
    'utf8',
  );
  const testSupportSrc = fs.readFileSync(
    require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.test-support'),
    'utf8',
  );
  const staffSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const fullSail = fs.readFileSync(path.join(ROOT, 'docs/FULL-SAIL.md'), 'utf8');
  const runbook = fs.readFileSync(
    path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-DOWNSCOPE-PROVER.md'),
    'utf8',
  );
  const ch4iDoc = fs.readFileSync(
    path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-SUNSET-STAGING-LIVE-EXECUTION.md'),
    'utf8',
  );

  assert.equal(LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(PROVER_EXECUTE, false);
  assert.equal(TARGET_EXECUTE, false);
  assert.equal(readerOwner.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(publicOwner.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER, false);
  assert.equal(typeof publicOwner.createOwnedSunsetStagingLiveExecutionOwner, 'undefined');
  assert.equal(typeof publicOwner.createSunsetStagingLiveExecutionOwnerForTests, 'undefined');
  assert.equal(typeof ownedCore.createOwnedSunsetStagingLiveExecutionOwner, 'function');
  assert.equal(PROOF_VERSION, 'chapter_4i_v1');
  assert.equal(CONFIRMATION_PHRASE, 'I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF');
  assert.notEqual(CONFIRMATION_PHRASE, PROVER_CONFIRM);
  assert.equal(readChapter4IOneShotPhase(), 'idle');
  assert.equal(isActiveChapter4ISunsetStagingOneShotAuthority(), false);
  assert.doesNotMatch(staffSrc, /sunset-staging-live-execution/);
  assert.doesNotMatch(staffSrc, /chapter-4i-one-shot-authority/);
  assert.doesNotMatch(ownerSrc, /createOwnedSunsetStagingLiveExecutionOwner,/);
  assert.match(testSupportSrc, /TEST-ONLY/);
  assert.doesNotMatch(ownedSrc, /graph\.microsoft\.com/);
  assert.doesNotMatch(ownedSrc, /function getAccessToken|getAccessToken\s*\(/);
  assert.doesNotMatch(ownedSrc, /function sendMail|sendMail\s*\(/);
  assert.match(ownedSrc, /'createReplyDraft'/);
  assert.match(ownedSrc, /'sendMail'/);
  assert.doesNotMatch(ownedSrc, /LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = true/);
  assert.match(ownedSrc, /inspectIndependentLivePreflight\(liveOwner, independent\)/);
  assert.match(ownedSrc, /readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg/);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-sunset-staging-live-execution'],
    'node scripts/verify-email-luna-controlled-drafting-sunset-staging-live-execution.js');
  console.log('  PASS  RED/GREEN: production owner exports executeOnce, not closed constructor; Staff API inert');

  assert.match(fullSail, /Chapter 4I/);
  assert.match(fullSail, /#735/);
  assert.match(fullSail, /82a9eb9ae647d13e7ef11629fc87a44b94d067c6/);
  assert.match(fullSail, /does not authorize OAuth consent/);
  assert.doesNotMatch(fullSail, /live proof PASS/);
  assert.match(runbook, /Chapter 4I/);
  assert.match(ch4iDoc, /execute-once/);
  assert.match(ch4iDoc, /I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF/);
  assert.match(ch4iDoc, /chapter_4g_operator_cli_may_differ_from_deployed_app_sha/);
  console.log('  PASS  docs name Chapter 4H PR #735 and Chapter 4I states without live PASS');

  const parsed = parseArgs(['execute-once', '--target', 'sunset-staging']);
  assert.equal(parsed.invalid, true);
  assert.equal(parsed.invalidReason, 'target_refused');
  const equals = parseArgs(['execute-once', '--deployment=sunset-staging']);
  assert.equal(equals.invalidReason, 'equals_form_refused');
  const extra = parseArgs(['execute-once', '--deployment', 'sunset-staging', '--extra', '1']);
  assert.equal(extra.invalidReason, 'unknown_or_hostile_arg');
  console.log('  PASS  generic --target / equals-form / extra args refuse');

  const refusedProd = await runCli(exactCliArgs(completeArgs()), {
    LUNA_DEPLOYMENT: 'production',
  });
  assert.equal(refusedProd.ok, false);
  assert.equal(refusedProd.status, 'refused');
  assert.equal(refusedProd.refresh_call_count, 0);
  assertAllowlisted(refusedProd);
  const refusedWolf = await runCli(exactCliArgs(completeArgs()), {
    DEFAULT_CLIENT_SLUG: 'wolfhouse',
  });
  assert.equal(refusedWolf.ok, false);
  const refusedAlias = await runCli(exactCliArgs(completeArgs()), {
    CHAPTER_4I_TARGET: 'sunset-staging',
  });
  assert.equal(refusedAlias.ok, false);
  const refusedDb = validateExactInvocation(completeArgs({ database: 'wolfhouse' }));
  assert.equal(refusedDb, 'database_mismatch');
  const refusedApp = validateExactInvocation(completeArgs({ appName: 'other-app' }));
  assert.equal(refusedApp, 'azure_owner_mismatch');
  console.log('  PASS  production / Wolfhouse / env aliases / other app/DB refuse');

  {
    const cli = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js'),
      'execute-once',
    ], { cwd: ROOT, encoding: 'utf8', env: childEnv(), timeout: 10000 });
    assert.equal(cli.status, 1);
    const record = JSON.parse(cli.stdout);
    assert.equal(record.ok, false);
    assert.equal(record.refresh_call_count, 0);
    assert.equal(record.graph_call_count, 0);
    assertAllowlisted(record);
  }
  console.log('  PASS  CLI without exact one-shot authorization refuses nonzero before adapters');

  await assert.rejects(
    () => executeOnceSunsetStagingLiveProof({ parsed: completeArgs(), env: {} }),
    (err) => assertOwnerFailure(err, 'source_test_cannot_consume_live_attempt'),
  );
  assert.equal(isActiveChapter4ISunsetStagingOneShotAuthority(), false);
  console.log('  PASS  production execute from verifier filename refuses before one-shot/adapters');

  assert.throws(
    () => composeSunsetStagingLiveDownscopeProverDependencies({ env: {} }),
    (err) => err && err.detail === 'live_execute_not_authorized_in_this_chapter',
  );
  const proverCli = proverRunCli([
    'prove', '--target', 'sunset-staging',
    '--deploy-sha', DEPLOYED_SHA, '--revision', REVISION, '--digest', DIGEST,
    '--confirm', PROVER_CONFIRM, '--operator-nonce', nonce(),
    '--confirm-issued-at', new Date().toISOString(), '--execute-once',
  ], { LUNA_DEPLOYMENT: 'sunset-staging' });
  assert.equal(proverCli.live_execution_authorized_in_this_chapter, false);
  assert.equal(proverCli.reason, 'live_execute_not_authorized_in_this_chapter');
  console.log('  PASS  4E/4G live execute remains disabled; compose still refuses');

  {
    const { owner } = await makeOwner({
      readIndependentLivePreflight: async () => ({
        ok: true, independent_read: true, live_authority: true,
        deploy_sha: DEPLOYED_SHA, revision: REVISION, digest: DIGEST, replica: 1,
        ops_097: 0, transitions_097: 0, authorizations_098: 0,
        grant_status: 'active', reconcile_state: 'clean', has_active_lease: false,
        flags_all_literal_false: true,
      }),
    });
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => assertOwnerFailure(err, 'live_preflight_unproven')
        && owner.counters.kv === 0
        && owner.counters.token === 0
        && owner.counters.jwks === 0
        && owner.counters.custodyPg === 0,
    );
  }
  console.log('  PASS  perfect snapshot / fake brand cannot mint 4H evidence; zero sensitive calls');

  {
    const evidence = await brandedPreflight({
      app: 0, list: 0, rev: 0, acr: 0, producer: 0, worker: 0, writes: 0, queries: [],
    });
    assert.equal(inspectIndependentLivePreflight(readerOwner, evidence).ok, true);
    const stubOwner = {
      isIndependentLivePreflight() { return true; },
      readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg: async () => evidence,
    };
    assert.equal(inspectIndependentLivePreflight(stubOwner, {
      ok: true, independent_read: true,
    }).ok, true);
    const { owner } = await makeOwner({
      readIndependentLivePreflight: async () => ({ ok: true, independent_read: true }),
    });
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => assertOwnerFailure(err, 'live_preflight_unproven') && owner.counters.token === 0,
    );
    const id = require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
    const original = require.cache[id];
    require.cache[id] = {
      id, filename: id, loaded: true, exports: stubOwner, children: [], paths: [],
    };
    const { owner: owner2 } = await makeOwner({
      readIndependentLivePreflight: async () => ({ ok: true, independent_read: true }),
    });
    await assert.rejects(
      () => owner2.executeOnce(completeArgs()),
      (err) => assertOwnerFailure(err, 'live_preflight_unproven'),
    );
    require.cache[id] = original;
  }
  console.log('  PASS  stub predicates / module-cache attacks fail closed');

  {
    const { owner, bodies } = await makeOwner();
    const record = await owner.executeOnce(completeArgs());
    assertAllowlisted(record);
    assert.equal(record.ok, true);
    assert.equal(record.status, 'offline_fake_pass');
    assert.equal(record.proof_version, PROOF_VERSION);
    assert.equal(record.deploy_sha, DEPLOYED_SHA);
    assert.equal(record.revision, REVISION);
    assert.equal(record.digest, DIGEST);
    assert.equal(record.source_sha, SOURCE_SHA);
    assert.equal(record.downscope_mail_send_absent, true);
    assert.equal(record.continuity_expected_scope_present, true);
    assert.equal(record.refresh_call_count, 2);
    assert.equal(record.graph_call_count, 0);
    assert.equal(record.send_call_count, 0);
    assert.equal(record.write_count, 0);
    assert.equal(owner.counters.token, 2);
    assert.ok(owner.counters.reader >= 2);
    assert.ok(owner.counters.kv >= 1);
    assert.ok(owner.counters.jwks >= 2);
    assert.ok(owner.counters.custodyPg >= 1);
    assert.equal(bodies.length, 2);
    assert.match(String(bodies[0]), /User\.Read/);
    assert.doesNotMatch(String(bodies[0]), /Mail\.Send/);
    const before = {
      reader: owner.counters.reader,
      kv: owner.counters.kv,
      token: owner.counters.token,
      jwks: owner.counters.jwks,
      custodyPg: owner.counters.custodyPg,
    };
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => assertOwnerFailure(err, 'one_shot_already_consumed')
        && owner.counters.reader === before.reader
        && owner.counters.kv === before.kv
        && owner.counters.token === before.token
        && owner.counters.jwks === before.jwks
        && owner.counters.custodyPg === before.custodyPg,
    );
  }
  console.log('  PASS  success is two signed refreshes, downscope then continuity; second call is inert');

  {
    const { owner } = await makeOwner({
      readerPatch: { counts: { ops_097: 1, transitions_097: 0, authorizations_098: 0 } },
    });
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => (assertOwnerFailure(err, 'counts_nonzero') || assertOwnerFailure(err, 'live_preflight_unproven'))
        && owner.counters.token === 0 && owner.counters.kv === 0,
    );
  }
  {
    const { owner } = await makeOwner({
      readerPatch: { grant: { grant_status: 'reauthorization_required', grant_generation: 4, reconcile_state: 'needs_operator', has_active_lease: false } },
    });
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => (assertOwnerFailure(err, 'grant_ineligible') || assertOwnerFailure(err, 'live_preflight_unproven'))
        && owner.counters.token === 0,
    );
  }
  console.log('  PASS  count / grant ineligible fail closed before token');

  {
    const { owner } = await makeOwner({
      transport: sequenceTransport([
        { throw: `timeout ${PLANTED}` },
        { token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }), scope: SEND_SCOPE, refreshToken: NEW_RT_2 },
      ]),
    });
    const record = await owner.executeOnce(completeArgs());
    assert.equal(record.ok, false);
    assert.equal(record.status, 'outcome_unknown');
    assert.equal(record.refresh_call_count, 1);
    assert.equal(record.continuity_expected_scope_present, null);
    assert.equal(owner.counters.token, 1);
    assert.equal(noLeak(record), true);
  }
  console.log('  PASS  outcome-unknown after first refresh records count=1 and does not continue');

  {
    const { owner } = await makeOwner({
      createSecretProvider: () => frozenMethod('getClientSecret', async () => {
        throw new Error(`kv boom ${PLANTED} postgres://wolfhouse_admin:secret@x/db eyJabc`);
      }),
    });
    await assert.rejects(
      () => owner.executeOnce(completeArgs()),
      (err) => noLeak(err) && err.code === ERROR_CODE && owner.counters.token === 0,
    );
  }
  {
    const getter = {};
    Object.defineProperty(getter, 'postTokenForm', {
      get() { throw new Error(PLANTED); }, enumerable: true,
    });
    assert.throws(
      () => createSunsetStagingLiveExecutionOwnerForTests({
        readIndependentLivePreflight: async () => brandedPreflight({
          app: 0, list: 0, rev: 0, acr: 0, producer: 0, worker: 0, writes: 0, queries: [],
        }),
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        createSecretProvider: () => frozenMethod('getClientSecret', async () => SECRET),
        transport: getter,
        createSignatureVerifier: () => canonicalVerifier(),
        withPgClient: async (work) => work({ query: async () => empty() }),
        binding: { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX },
        applicationClientId: APP_ID,
        clock: { nowMs() { return NOW_MS; } },
      }),
      (err) => noLeak(err) && err.code === ERROR_CODE,
    );
  }
  {
    const proxyTransport = new Proxy(Object.freeze({
      async postTokenForm() { return {}; },
    }), { get(t, k) { return t[k]; } });
    assert.throws(
      () => createSunsetStagingLiveExecutionOwnerForTests({
        readIndependentLivePreflight: async () => ({}),
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        createSecretProvider: () => frozenMethod('getClientSecret', async () => SECRET),
        transport: proxyTransport,
        createSignatureVerifier: () => canonicalVerifier(),
        withPgClient: async (work) => work({ query: async () => empty() }),
        binding: { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX },
        applicationClientId: APP_ID,
        clock: { nowMs() { return NOW_MS; } },
      }),
      (err) => noLeak(err) && err.code === ERROR_CODE,
    );
  }
  console.log('  PASS  planted-secret / getter / proxy errors sanitize and never retry');

  {
    const child = spawnSync(process.execPath, ['-e', `
      'use strict';
      const http = require('node:http');
      const https = require('node:https');
      const path = require('node:path');
      let network = 0;
      function wrap(obj, name) {
        const orig = obj[name];
        if (typeof orig !== 'function') return;
        obj[name] = function wrapped() {
          network += 1;
          const err = new Error('network_must_not_run');
          try {
            const req = orig.apply(this, arguments);
            try { req.destroy(err); } catch (_) { /* intercepted */ }
            return req;
          } catch (_) {
            throw err;
          }
        };
      }
      wrap(http, 'request'); wrap(http, 'get');
      wrap(https, 'request'); wrap(https, 'get');
      const root = ${JSON.stringify(ROOT)};
      const owner = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-sunset-staging-live-execution-owner.js'));
      const authority = require(path.join(root, 'scripts/lib/email-luna-controlled-drafting-chapter-4i-one-shot-authority.js'));
      if (authority.isActiveChapter4ISunsetStagingOneShotAuthority() !== false) process.exit(2);
      if (owner.LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) process.exit(3);
      const parsed = owner.parseArgs([]);
      if (parsed.invalid !== true) process.exit(4);
      Promise.resolve(owner.runCli([], {})).then((record) => {
        const ok = record && record.ok === false && record.refresh_call_count === 0 && network === 0;
        process.stdout.write(ok ? 'import-inert\\n' : ('import-fail network=' + network + '\\n'));
        process.exit(ok ? 0 : 5);
      }).catch(() => process.exit(6));
    `], { cwd: ROOT, encoding: 'utf8', env: childEnv(), timeout: 10000 });
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, 'ordinary import must be inert');
    assert.match(child.stdout, /import-inert/);
  }
  console.log('  PASS  ordinary import inert with zero network');

  {
    const child = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/email-luna-controlled-drafting-sunset-staging-live-execution.js'),
      ...exactCliArgs(completeArgs()),
    ], { cwd: ROOT, encoding: 'utf8', env: childEnv(), timeout: 10000 });
    assert.equal(child.status, 1);
    const record = JSON.parse(child.stdout);
    assert.equal(record.ok, false);
    assert.equal(record.refresh_call_count, 0);
    assertAllowlisted(record);
  }
  console.log('  PASS  complete CLI from verifier parent refuses live attempt with zero refresh');

  void consumeChapter4ISunsetStagingOneShotAuthority;
  console.log('Chapter 4I live execution verifier passed.');
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
