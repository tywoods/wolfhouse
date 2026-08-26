'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E: operator downscope prover.
 * Offline fakes and local stock-PG only. No live Graph/OAuth/Azure.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  createEmailLunaControlledDraftingLiveDownscopeProver,
  readTrustedLiveDownscopeProverFailure,
  parseArgs,
  runCli,
  refusedProduction,
  liveModeAllowed,
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_RUNTIME_WIRED,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  EXPECTED_DOWNSCOPE_SCP,
  EXPECTED_STAFF_SEND_SCP,
  CONFIRMATION_PHRASE,
  COMMANDS,
  EIGHT_FLAGS,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  SERVICE_KEYS,
  ATTESTATION_KIND,
} = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
const {
  createControlledDraftingAccessTokenClaimsInspector,
  createStaffSendPhaseBAccessTokenClaimsInspector,
  ERROR_CODE: CLAIMS_CODE,
  OIDC_SCOPES_IN_SCP,
} = require('./lib/email-luna-controlled-drafting-access-token-claims');
const {
  createMicrosoftOidcJwksSignatureVerifier,
} = require('./lib/email-microsoft-oidc-jwks-verifier');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  MIGRATION_097_ID,
  MIGRATION_097_SHA256,
  MIGRATION_098_ID,
  MIGRATION_098_SHA256,
  EXPECTED_CHECKSUM_MODE,
} = require('./lib/email-luna-controlled-drafting-session-proof');
const {
  REQUESTED_SCOPE: LOAN_SCOPE,
} = require('./lib/email-luna-controlled-drafting-token-loan');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PROVER_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-live-downscope-prover'),
  'utf8',
);
const CLI_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts/email-luna-controlled-drafting-live-downscope-prover.js'),
  'utf8',
);
const DOC_SRC = fs.readFileSync(
  path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-LIVE-DOWNSCOPE-PROVER.md'),
  'utf8',
);
const LOAN_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-token-loan'),
  'utf8',
);
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

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
const NOW = 1_900_000_000;
const DRAFT_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite';
const SEND_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const PRODUCER_FP = 'aa'.repeat(32);
const WORKER_FP = 'bb'.repeat(32);
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });
const KID = 'key-1';

function noLeak(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    return false;
  }
  return !text.includes('NEVER_LEAK')
    && !text.includes(OLD_RT)
    && !text.includes(NEW_RT)
    && !text.includes(NEW_RT_2)
    && !text.includes(SECRET)
    && !text.includes(PLANTED)
    && !text.includes('eyJ')
    && !text.includes('postgres://')
    && !text.includes(PRINCIPAL);
}

function rows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}
function empty() { return { rows: [], rowCount: 0 }; }

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
    exp: NOW + 600,
    iat: NOW - 10,
    nbf: NOW - 10,
    ...patch,
  };
}

function goodJwt(patch) {
  return signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, baseClaims(patch));
}

function liveJwt(patch) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, baseClaims({
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    ...patch,
  }));
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

function inspectInput(token = goodJwt(), patch = {}) {
  return {
    accessToken: token,
    expectedTenantId: TID,
    expectedClientId: APP_ID,
    expectedPrincipalOid: PRINCIPAL,
    nowEpochSeconds: NOW,
    ...patch,
  };
}

function disabledEnv(patch = {}) {
  return Object.assign({
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'false',
    STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED: 'false',
    EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
  }, patch);
}

function ledgerRow() {
  return {
    current_database: 'sunset_staging',
    ledger_097_id: MIGRATION_097_ID,
    ledger_097_checksum: MIGRATION_097_SHA256,
    ledger_097_mode: EXPECTED_CHECKSUM_MODE,
    ledger_098_id: MIGRATION_098_ID,
    ledger_098_checksum: MIGRATION_098_SHA256,
    ledger_098_mode: EXPECTED_CHECKSUM_MODE,
  };
}

function attestRow(kind, overlay = {}) {
  const user = kind === 'worker' ? 'luna_cd_worker' : 'luna_cd_producer';
  return Object.assign({
    session_user: user,
    current_user: user,
    table_owner: 'postgres',
    session_distinct_from_owner: true,
    session_matches_current: true,
    mapping_ok: true,
    login_contract_ok: true,
    execute_ok: true,
  }, overlay);
}

function fakeLoginClient(kind, overlay = {}) {
  const fp = kind === 'worker' ? WORKER_FP : PRODUCER_FP;
  const attest = attestRow(kind, overlay.attest || {});
  const identity = Object.assign({
    session_matches_current: overlay.session_matches_current !== false,
    current_database: overlay.current_database || 'sunset_staging',
    ssl: overlay.ssl === undefined ? 'on' : overlay.ssl,
    session_fingerprint: overlay.session_fingerprint || fp,
    current_fingerprint: overlay.current_fingerprint || fp,
  }, overlay.identity || {});
  return {
    async query(text) {
      const t = String(text);
      if (/tenant_email_luna_controlled_draft_staging_schema_ready/.test(t)) {
        return rows(ledgerRow());
      }
      if (/principal_authorized/.test(t)) {
        return rows(attest);
      }
      if (/session_fingerprint/.test(t)) {
        return rows(identity);
      }
      return empty();
    },
  };
}

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

function createGrantMock({
  sealed, opId, events, failCommit, failMark, failAbort, failReauth, failLease,
  priorStatus, binding, generation, scopeVersion, staleLease,
}) {
  const log = events || [];
  let currentGeneration = generation || 1;
  let currentSealed = sealed;
  let lastOpId = opId;
  let leaseTok = null;
  let reconcileState = (priorStatus && priorStatus.reconcile_state) || 'clean';
  let grantStatus = (priorStatus && priorStatus.grant_status) || 'active';
  const scopeVer = scopeVersion === undefined ? 'phase_b_v1' : scopeVersion;
  const bound = binding || bindingRow();
  const prior = priorStatus || {
    client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: currentGeneration, grant_status: grantStatus, reconcile_state: reconcileState,
    grant_lease_token: null, scope_version: scopeVer,
  };

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
        if (failLease) return empty();
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
        if (failCommit) {
          log.push({ type: 'commit_fail', generation: currentGeneration });
          return empty();
        }
        currentGeneration = Number(params[2]);
        lastOpId = params[3];
        grantStatus = 'active';
        leaseTok = null;
        reconcileState = 'clean';
        log.push({ type: 'commit', generation: currentGeneration });
        return rows(statusRow());
      }
      if (/SET reconcile_state=/i.test(t)) {
        if (failMark === true || failMark === 'empty' || staleLease === true) {
          log.push({
            type: 'uncertain_fail', generation: currentGeneration,
            state: params && params[2], detail: params && params[3],
          });
          return empty();
        }
        if (failMark === 'throw') {
          log.push({ type: 'uncertain_throw', generation: currentGeneration });
          throw new Error('mark_threw');
        }
        reconcileState = params && params[2] ? params[2] : 'ms_response_uncertain';
        log.push({
          type: 'uncertain', generation: currentGeneration,
          state: reconcileState, detail: params && params[3],
        });
        return rows(statusRow());
      }
      if (/SET grant_status='reauthorization_required'/i.test(t)) {
        if (failReauth === true || failReauth === 'empty') {
          log.push({ type: 'reauth_fail', generation: currentGeneration });
          return empty();
        }
        if (failReauth === 'throw') {
          log.push({ type: 'reauth_throw', generation: currentGeneration });
          throw new Error('reauth_threw');
        }
        grantStatus = 'reauthorization_required';
        leaseTok = null;
        reconcileState = 'needs_operator';
        log.push({ type: 'reauth', generation: currentGeneration });
        return rows({ grant_generation: currentGeneration, grant_status: grantStatus });
      }
      if (/SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t)
          && !/SET grant_generation=/i.test(t)) {
        if (failAbort) return empty();
        grantStatus = 'active';
        leaseTok = null;
        log.push({ type: 'abort', generation: currentGeneration, reconcile_state: reconcileState });
        return rows(statusRow());
      }
      if (/UPDATE tenant_channel_endpoints/i.test(t)) return rows({ id: ENDPOINT });
      if (/reauthorization_required/i.test(t)) {
        return rows({ grant_generation: currentGeneration, grant_status: 'reauthorization_required' });
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

async function makeProver(overrides = {}) {
  const envelope = overrides.envelopeProvider || createFakeEmailGrantEnvelopeProvider();
  const op = overrides.opId || crypto.randomUUID();
  const sealed = overrides.sealed || await fakeSealRefreshToken(envelope, {
    refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
    grantGeneration: 1, operationId: op,
  });
  const events = overrides.events || [];
  const mock = overrides.mock || createGrantMock({
    sealed, opId: op, events,
    failCommit: overrides.failCommit,
    failMark: overrides.failMark,
    failAbort: overrides.failAbort,
    failReauth: overrides.failReauth,
    failLease: overrides.failLease,
    priorStatus: overrides.priorStatus,
    binding: overrides.bindingRow,
    generation: overrides.generation,
    scopeVersion: overrides.scopeVersion,
    staleLease: overrides.staleLease,
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
  const transport = overrides.transport || sequenceTransport([
    { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
    {
      token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }),
      scope: SEND_SCOPE,
      refreshToken: NEW_RT_2,
    },
  ]);
  const prover = createEmailLunaControlledDraftingLiveDownscopeProver({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: overrides.withPgClient || (async (work) => work(mock.client)),
    envelopeProvider: wrappingEnvelope,
    createSecretProvider: overrides.createSecretProvider
      || (() => frozenMethod('getClientSecret', async () => SECRET)),
    transport,
    createSignatureVerifier: overrides.createSignatureVerifier || (() => canonicalVerifier()),
    binding: {
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      mailboxId: MAILBOX,
    },
    workerId: 'email-luna-controlled-drafting-live-downscope-prover',
    login: overrides.login || {
      producerClient: fakeLoginClient('producer'),
      workerClient: fakeLoginClient('worker'),
    },
    preflight: Object.assign({
      ops097: 0,
      rows098: 0,
      replica: 1,
      sourceSha: 'b'.repeat(40),
      deploySha: 'b'.repeat(40),
    }, overrides.preflight || {}),
  });
  return { prover, mock, events, envelope };
}

function proveArgs(patch = {}) {
  return {
    parsed: Object.assign({
      target: 'fake',
      command: 'prove',
      confirm: CONFIRMATION_PHRASE,
      deploySha: 'b'.repeat(40),
      sourceSha: 'b'.repeat(40),
      invalid: false,
      invalidReason: null,
    }, patch),
    env: disabledEnv(),
  };
}

function childEnv() {
  const extra = '/opt/data/calendar-inventory-bridge-bf/node_modules';
  const nodePath = [extra, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  return Object.assign({}, process.env, { NODE_PATH: nodePath });
}

function runChild(name) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv(),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, name);
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E live-downscope prover verifier');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_RUNTIME_WIRED, false);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 1);
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST[0], 'f6ee511273160cb46c72e345137800878d4c6512');
  assert.equal(SCOPE_PROFILE_ID, 'controlled_drafting_v1');
  assert.equal(REQUESTED_SCOPE, LOAN_SCOPE);
  assert.equal(REQUESTED_SCOPE.includes('Mail.Send'), false);
  assert.equal(EXPECTED_DOWNSCOPE_SCP, 'User.Read Mail.ReadWrite');
  assert.equal(EXPECTED_STAFF_SEND_SCP, 'User.Read Mail.ReadWrite Mail.Send');
  assert.equal(OIDC_SCOPES_IN_SCP.accepted_in_scp, false);
  assert.equal(ATTESTATION_KIND, 'configured_contract_only');
  assert.equal(EIGHT_FLAGS.length, 8);
  assert.deepEqual([...SERVICE_KEYS], ['attest', 'simulate', 'runProof']);
  assert.deepEqual([...COMMANDS], ['simulate', 'prove']);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-live-downscope-prover'],
    'node scripts/verify-email-luna-controlled-drafting-live-downscope-prover.js');
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-live-downscope-prover-live-target'],
    'node scripts/verify-email-luna-controlled-drafting-live-downscope-prover-live-target.js');
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader'],
    'node scripts/verify-email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader.js');
  assert.equal(typeof createEmailLunaControlledDraftingLiveDownscopeProver, 'function');

  const ownerMod = require('./lib/email-luna-controlled-drafting-live-downscope-prover');
  assert.equal(ownerMod.getAccessToken, undefined);
  assert.equal(ownerMod.runClosed, undefined);
  assert.equal(ownerMod.withToken, undefined);
  assert.equal(ownerMod.createEmailLunaControlledDraftingGraphProvider, undefined);
  assert.doesNotMatch(PROVER_SRC, /function getAccessToken|getAccessToken\s*\(/);
  assert.doesNotMatch(PROVER_SRC, /function runClosed|runClosed\s*\(/);
  assert.doesNotMatch(PROVER_SRC, /function withToken|withToken\s*\(/);
  assert.doesNotMatch(PROVER_SRC, /createEmailLunaControlledDraftingGraph/);
  assert.doesNotMatch(PROVER_SRC, /sendMail\s*\(|createReply\s*\(/);
  assert.doesNotMatch(PROVER_SRC, /graph\.microsoft\.com/);
  assert.doesNotMatch(PROVER_SRC, /tenant_email_luna_controlled_draft_staging_test_consume/);
  assert.doesNotMatch(PROVER_SRC, /['"`]\/send(?:Mail)?['"`]/);
  assert.match(PROVER_SRC, /'createReplyDraft'/);
  assert.match(PROVER_SRC, /'sendMail'/);
  assert.doesNotMatch(CLI_SRC, /\baz\s+(login|account|rest|keyvault)/i);
  assert.doesNotMatch(CLI_SRC, /require\(['"][^'"]*(azure|keyvault|jwks)/i);
  assert.doesNotMatch(STAFF_API_SRC, /email-luna-controlled-drafting-live-downscope-prover/);
  assert.match(PROVER_SRC, /tryAcquireDelegatedGrantLease/);
  assert.match(PROVER_SRC, /createDelegatedGrantAccessSession/);
  assert.match(PROVER_SRC, /createControlledDraftingAccessTokenClaimsInspector/);
  assert.match(PROVER_SRC, /createStaffSendPhaseBAccessTokenClaimsInspector/);
  assert.match(PROVER_SRC, /LIVE_DEPLOY_SHA_ALLOWLIST = objectFreeze\(\['f6ee511273160cb46c72e345137800878d4c6512'\]\)/);
  assert.match(PROVER_SRC, /I_UNDERSTAND_SUNSET_STAGING_DOWNSCOPE_PROOF/);
  assert.match(DOC_SRC, /Threat model/i);
  assert.match(DOC_SRC, /runbook/i);
  assert.match(DOC_SRC, /Truth table/i);
  assert.match(DOC_SRC, /Abort/i);
  assert.match(DOC_SRC, /Mail\.Send/);
  assert.match(DOC_SRC, /openid profile offline_access/);
  assert.match(DOC_SRC, /do not appear/i);
  assert.match(DOC_SRC, /Graph access-token `scp`/);
  assert.match(LOAN_SRC, /reauth\.ok/);
  assert.match(LOAN_SRC, /classified\.kind === 'invalid_grant'/);
  {
    const ig = LOAN_SRC.slice(LOAN_SRC.indexOf("classified.kind === 'invalid_grant'"),
      LOAN_SRC.indexOf("classified.kind === 'invalid_grant'") + 1200);
    assert.match(ig, /uncertainty_persistence/);
    assert.match(ig, /persistence_unproven/);
  }
  console.log('  PASS  static surface; no Graph/send/098/token export; singleton live allowlist');

  assert.equal(liveModeAllowed('a'.repeat(40)), false);
  assert.equal(liveModeAllowed('f6ee511273160cb46c72e345137800878d4c6512'), true);
  assert.equal(refusedProduction({ DEFAULT_CLIENT_SLUG: 'wolfhouse' }), true);
  assert.equal(parseArgs(['prove', '--target', 'live']).target, 'live');
  const liveCli = runCli(['prove', '--target', 'live', '--deploy-sha', 'a'.repeat(40)], disabledEnv());
  assert.equal(liveCli.ok, false);
  assert.equal(liveCli.simulation, true);
  assert.equal(liveCli.live_evidence, false);
  assert.equal(liveCli.reason, 'target_live_alias_refused');
  assert.equal(runCli(['prove', '--target', 'sunset-staging'], disabledEnv()).reason,
    'deploy_sha_not_allowlisted');
  assert.equal(runCli(['simulate', '--target', 'fake', '--target', 'fake'], disabledEnv()).reason,
    'duplicate_arg');
  assert.equal(runCli(['simulate', '--nope'], disabledEnv()).reason, 'unknown_or_hostile_arg');
  assert.equal(runCli(['simulate'], { LUNA_DEPLOYMENT: 'production' }).reason,
    'production_or_wolfhouse_refused');
  assert.equal(runCli(['simulate'], { HTTPS_PROXY: 'http://127.0.0.1:1' }).reason, 'proxy_refused');
  assert.equal(runCli(['simulate'], disabledEnv()).ok, true);
  assert.equal(runCli(['simulate'], disabledEnv()).token_verified, false);
  assert.equal(runCli(['simulate'], disabledEnv()).login_proven, false);
  assert.equal(runCli(['simulate'], disabledEnv()).custody_proven, false);
  console.log('  PASS  live aliases refused; singleton SHA; hostile args/env/proxy fail; simulation unlabeled as proof');

  {
    const { prover } = await makeProver();
    const att = prover.attest();
    assert.equal(att.ok, true);
    assert.equal(att.graph_provider, false);
    assert.equal(att.mail_send, false);
    assert.equal(att.live_mode_structurally_absent, false);
    assert.equal(att.allowlist_size, 1);
    assert.equal(att.live_execution_gated, true);
    assert.deepEqual([...Reflect.ownKeys(prover)].sort(), ['attest', 'runProof', 'simulate']);
    assert.equal(typeof prover.getAccessToken, 'undefined');
    assert.equal(typeof prover.runClosed, 'undefined');
    assert.throws(() => prover.runClosed(async (token) => token));
    assert.equal(noLeak(att), true);
  }
  assert.throws(() => createEmailLunaControlledDraftingLiveDownscopeProver({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: async (work) => work({ async query() { return empty(); } }),
    envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
    createSecretProvider: () => frozenMethod('getClientSecret', async () => SECRET),
    transport: frozenMethod('postTokenForm', async () => ({})),
    createSignatureVerifier: () => canonicalVerifier(),
    binding: {
      clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, mailboxId: MAILBOX,
    },
    workerId: 'email-luna-controlled-drafting-live-downscope-prover',
    login: { producerClient: fakeLoginClient('producer'), workerClient: fakeLoginClient('worker') },
    preflight: {},
    consumer: async (token) => token,
  }));
  console.log('  PASS  attest/public surface; generic consumer rejected');

  {
    const captured = [];
    const { prover, events } = await makeProver({
      transport: sequenceTransport([
        { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
        {
          token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }),
          scope: SEND_SCOPE,
          refreshToken: NEW_RT_2,
        },
      ], captured),
    });
    const logs = [];
    const orig = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let evidence;
    try {
      evidence = await prover.runProof(proveArgs());
    } finally {
      console.log = orig;
    }
    assert.equal(evidence.ok, true);
    assert.equal(evidence.live_evidence, false);
    assert.equal(evidence.offline_fake_proof, true);
    assert.equal(evidence.token_returned, false);
    assert.equal(evidence.graph_called, false);
    assert.equal(evidence.send_called, false);
    assert.equal(evidence.mutated_098, false);
    assert.equal(evidence.downscope_mail_send, false);
    assert.equal(evidence.downscope_scp, EXPECTED_DOWNSCOPE_SCP);
    assert.equal(evidence.continuity_mail_send, true);
    assert.equal(evidence.continuity_scp, EXPECTED_STAFF_SEND_SCP);
    assert.equal(evidence.downscope_generation, 2);
    assert.equal(evidence.continuity_generation, 3);
    assert.equal(evidence.grant_generation, 3);
    assert.equal(evidence.grant_status, 'active');
    assert.equal(evidence.reconcile_state, 'clean');
    assert.equal(evidence.logins_distinct, true);
    assert.equal(evidence.producer_login_ok, true);
    assert.equal(evidence.worker_login_ok, true);
    assert.equal(evidence.kid, KID);
    assert.equal(evidence.alg, 'RS256');
    assert.equal(noLeak(evidence), true);
    assert.equal(new URLSearchParams(captured[0]).get('scope'), REQUESTED_SCOPE);
    assert.equal(new URLSearchParams(captured[1]).get('scope'), null);
    assert.equal(events.filter((row) => row.type === 'commit').length, 2);
    assert.equal(logs.join('\n').includes(OLD_RT), false);
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note && note.stage === 'confirmation' && noLeak(error);
      },
    );
  }
  console.log('  PASS  positive fake downscope then staff-send continuity; generations 1→2→3; no Graph/send/098');

  {
    const { prover } = await makeProver({
      transport: sequenceTransport([
        { token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
        {
          token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }),
          scope: SEND_SCOPE,
          refreshToken: NEW_RT_2,
        },
      ]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note && (note.stage === 'claims' || note.stage === 'response') && noLeak(error);
      },
    );
  }
  {
    const { prover } = await makeProver({
      transport: sequenceTransport([
        { token: liveJwt(), scope: SEND_SCOPE, refreshToken: NEW_RT },
      ]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note && note.stage === 'response' && noLeak(error);
      },
    );
  }
  console.log('  PASS  adversarial Mail.Send JWT and token-endpoint scope lie fail closed');

  const draftInspector = () => createControlledDraftingAccessTokenClaimsInspector({
    signatureVerifier: canonicalVerifier(),
  });
  const sendInspector = () => createStaffSendPhaseBAccessTokenClaimsInspector({
    signatureVerifier: canonicalVerifier(),
  });
  async function rejectedClaims(promise) {
    await assert.rejects(promise, (error) => error && error.code === CLAIMS_CODE && noLeak(error));
  }
  {
    const okDraft = await draftInspector().inspect(inspectInput());
    assert.equal(okDraft.mail_send, false);
    const okSend = await sendInspector().inspect(inspectInput(goodJwt({
      scp: 'User.Read Mail.ReadWrite Mail.Send',
    })));
    assert.equal(okSend.mail_send, true);
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({
      scp: 'User.Read Mail.ReadWrite Mail.Send',
    }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ roles: ['Mail.Send'] }))));
    await rejectedClaims(sendInspector().inspect(inspectInput(goodJwt({ roles: ['Mail.Send'] }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ oid: MAILBOX }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ tid: APP_ID }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ aud: APP_ID }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({
      iss: 'https://login.microsoftonline.com/00000000-0000-4000-8000-000000000000/v2.0',
    }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ ver: '1.0' }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ exp: NOW - 1000 }))));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ nbf: NOW + 1000 }))));
    await rejectedClaims(draftInspector().inspect(inspectInput('opaque-token')));
    const badSig = signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, baseClaims());
    await rejectedClaims(draftInspector().inspect(inspectInput(`${badSig.slice(0, -4)}abcd`)));
    await rejectedClaims(draftInspector().inspect(inspectInput(
      signJwt({ alg: 'none', kid: KID }, baseClaims()),
    )));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({
      scp: 'openid User.Read Mail.ReadWrite',
    }))));
    await rejectedClaims(sendInspector().inspect(inspectInput(goodJwt())));
    await rejectedClaims(draftInspector().inspect(inspectInput(goodJwt({ oid: MAILBOX }))));
  }
  console.log('  PASS  adversarial oid/tid/aud/iss/ver/exp/nbf/roles/unsigned/OIDC-in-scp');

  {
    const events = [];
    const { prover } = await makeProver({
      events,
      transport: sequenceTransport([
        { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: null },
        {
          token: liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }),
          scope: SEND_SCOPE,
          refreshToken: NEW_RT,
        },
      ]),
    });
    const evidence = await prover.runProof(proveArgs());
    assert.equal(evidence.downscope_generation, 1);
    assert.equal(evidence.downscope_rotated, false);
    assert.equal(evidence.continuity_generation, 2);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'commit').length, 1);
    assert.equal(noLeak(evidence), true);
  }
  console.log('  PASS  omitted downscope RT: no generation bump; continuity still rotates once');

  {
    const events = [];
    const { prover } = await makeProver({
      events,
      failMark: true,
      transport: sequenceTransport([
        { throw: 'token-http-timeout' },
      ]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(events.filter((row) => row.type === 'commit').length, 0);
  }
  {
    const events = [];
    const { prover } = await makeProver({
      events,
      failReauth: true,
      transport: sequenceTransport([{
        statusCode: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant' }),
      }]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'reauth_fail').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
  }
  {
    const events = [];
    const { prover } = await makeProver({
      events,
      failCommit: true,
      transport: sequenceTransport([
        { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
      ]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note && note.stage === 'commit' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'commit').length, 0);
    assert.equal(events.filter((row) => row.type === 'commit_fail').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
  }
  {
    const events = [];
    const { prover } = await makeProver({
      events,
      failMark: true,
      failCommit: true,
      transport: sequenceTransport([
        { token: liveJwt(), scope: DRAFT_SCOPE, refreshToken: NEW_RT },
      ]),
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
  }
  console.log('  PASS  rotation/uncertain/fenced mark and invalid_grant mark-fail leave lease; no dead_grant lie');

  {
    const { prover } = await makeProver({
      login: {
        producerClient: fakeLoginClient('producer'),
        workerClient: fakeLoginClient('producer'),
      },
    });
    await assert.rejects(
      () => prover.runProof(proveArgs()),
      (error) => {
        const note = readTrustedLiveDownscopeProverFailure(error);
        return note && note.stage === 'login' && noLeak(error);
      },
    );
  }
  {
    const { prover } = await makeProver({
      login: {
        producerClient: fakeLoginClient('producer', { attest: { session_matches_current: false, login_contract_ok: false } }),
        workerClient: fakeLoginClient('worker'),
      },
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'login';
    });
  }
  {
    const { prover } = await makeProver({
      login: {
        producerClient: fakeLoginClient('producer', { attest: { session_distinct_from_owner: false } }),
        workerClient: fakeLoginClient('worker'),
      },
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'login';
    });
  }
  {
    const { prover } = await makeProver({
      login: {
        producerClient: fakeLoginClient('producer', { attest: { mapping_ok: false } }),
        workerClient: fakeLoginClient('worker'),
      },
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'login';
    });
  }
  {
    const { prover } = await makeProver({
      login: {
        producerClient: fakeLoginClient('producer', { attest: { execute_ok: false } }),
        workerClient: fakeLoginClient('worker'),
      },
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'login';
    });
  }
  console.log('  PASS  LOGIN fakes: distinct required; SET ROLE/owner/unmapped/ACL fail');

  {
    const { prover } = await makeProver({ preflight: { ops097: 1 } });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'counts';
    });
  }
  {
    const { prover } = await makeProver({
      priorStatus: {
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'ms_response_uncertain',
        grant_lease_token: null, scope_version: 'phase_b_v1',
      },
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'status';
    });
  }
  {
    const cyclic = { token: PLANTED };
    cyclic.self = cyclic;
    const err = new Error('planted');
    err.cause = { get secret() { return PLANTED; } };
    Object.defineProperty(err, 'then', { get() { return PLANTED; } });
    const { prover } = await makeProver({
      transport: sequenceTransport([{ throw: PLANTED }]),
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => noLeak(error) && error.code === ERROR_CODE);
  }
  {
    const { prover } = await makeProver({
      bindingRow: bindingRow({ provider_tenant_id: APP_ID }),
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && (note.stage === 'binding' || note.stage === 'claims') && noLeak(error);
    });
  }
  {
    const { prover } = await makeProver({
      bindingRow: bindingRow({ location_id: APP_ID }),
    });
    await assert.rejects(() => prover.runProof(proveArgs()), (error) => {
      const note = readTrustedLiveDownscopeProverFailure(error);
      return note && note.stage === 'binding' && noLeak(error);
    });
  }
  {
    function inspectLeak(value) {
      const util = require('node:util');
      const seen = new Set();
      function walk(node, depth) {
        if (node == null || depth > 6 || seen.has(node)) return true;
        if (typeof node === 'string') return noLeak(node);
        if (typeof node !== 'object' && typeof node !== 'function') return true;
        seen.add(node);
        try { if (!noLeak(util.inspect(node, { depth: 4, getters: true, showHidden: true }))) return false; } catch (_) { /* */ }
        try { if (!noLeak(JSON.stringify(node))) return false; } catch (_) { /* cyclic */ }
        try {
          if (typeof node.toJSON === 'function' && !noLeak(node.toJSON())) return false;
        } catch (_) { /* */ }
        const keys = [...Object.getOwnPropertyNames(node), ...Object.getOwnPropertySymbols(node)];
        for (const key of keys) {
          let desc;
          try { desc = Object.getOwnPropertyDescriptor(node, key); } catch (_) { continue; }
          if (!desc) continue;
          if (typeof desc.get === 'function') {
            try { if (!noLeak(desc.get.call(node))) return false; } catch (_) { /* */ }
          }
          if (Object.prototype.hasOwnProperty.call(desc, 'value') && !walk(desc.value, depth + 1)) return false;
        }
        return true;
      }
      return walk(value, 0);
    }
    const { prover } = await makeProver();
    const evidence = await prover.runProof(proveArgs());
    assert.equal(inspectLeak(evidence), true);
    assert.equal(evidence.token_returned, false);
    const getterErr = Object.defineProperty(new Error(ERROR_MESSAGE), 'token', {
      get() { return OLD_RT; }, enumerable: true,
    });
    assert.equal(noLeak({ code: ERROR_CODE, message: ERROR_MESSAGE }), true);
    assert.equal(typeof getterErr.token, 'string');
  }
  console.log('  PASS  active ops/uncertain grant refused; planted-secret errors sanitized');

  const stockPg = spawnSync(process.execPath, [
    path.join(__dirname, 'prove-email-luna-controlled-drafting-live-downscope-prover-stock-pg.js'),
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv() });
  if (stockPg.stdout) process.stdout.write(stockPg.stdout);
  if (stockPg.stderr) process.stderr.write(stockPg.stderr);
  assert.equal(stockPg.status, 0, 'stock-pg prove must pass or SKIP');

  console.log('  … Chapter 4C cumulative + custody/JWKS/Staff API/migration integrity');
  runChild('verify-email-luna-controlled-drafting-token-loan.js');
  runChild('verify-email-delegated-grant-custodian.js');
  runChild('verify-email-delegated-grant-access-session.js');
  runChild('verify-email-delegated-grant-refresh-rotation.js');
  runChild('verify-email-microsoft-oidc-jwks-verifier.js');
  runChild('verify-email-microsoft-graph-adapter.js');
  runChild('verify-staff-query-api-startup-smoke.js');
  runChild('verify-migration-integrity.js');
  runChild('prove-email-luna-controlled-drafting-live-downscope-prover-offline-simulation.js');
  runChild('verify-email-luna-controlled-drafting-live-downscope-prover-live-target.js');
  runChild('verify-email-luna-controlled-drafting-live-downscope-prover-live-preflight-reader.js');
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (diffCheck.stdout) process.stdout.write(diffCheck.stdout);
  if (diffCheck.stderr) process.stderr.write(diffCheck.stderr);
  assert.equal(diffCheck.status, 0, 'git diff --check must stay green');
  console.log('ALL OK — Stage 2 Chapter 4E source-only live-downscope prover (zero live actions)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
