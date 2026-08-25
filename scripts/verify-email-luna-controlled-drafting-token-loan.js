'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C: Graph-bound draft-only
 * token assembly and offline simulation. Offline fakes only. No live Graph/OAuth.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  createEmailLunaControlledDraftingGraphProvider,
  isClosedControlledDraftingGraphProvider,
  bindControlledDraftingTokenLoanKillSwitch,
  readTrustedControlledDraftingTokenLoanFailure,
  isTrustedControlledDraftingTokenLoanNoProviderPostFailure,
  TOKEN_LOAN_NO_PROVIDER_POST_STAGES,
  TOKEN_LOAN_STAGES,
  ERROR_CODE,
  SUNSET_DEPLOYMENT,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  ATTESTATION_KIND,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  SERVICE_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED,
} = require('./lib/email-luna-controlled-drafting-token-loan');
const {
  createEmailLunaControlledDraftingProvider,
  pickEmailLunaControlledDraftingTransportMethods,
  ERROR_CODE: PROVIDER_INVALID_CODE,
} = require('./lib/email-luna-controlled-drafting-provider-contract');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeComposition,
  bindProducerWithTransactionClient,
  bindWorkerWithTransactionClient,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-composition');
const {
  createEmailLunaControlledDraftingOperationStore,
} = require('./lib/email-luna-controlled-drafting-operation-store');
const {
  createControlledDraftingAccessTokenClaimsInspector,
  GRAPH_AUDIENCES,
  REQUIRED_SCP,
  ERROR_CODE: CLAIMS_CODE,
} = require('./lib/email-luna-controlled-drafting-access-token-claims');
const {
  createEmailLunaControlledDraftingGraphDraftTransport,
} = require('./lib/email-luna-controlled-drafting-graph-draft-transport');
const {
  createMicrosoftOidcJwksSignatureVerifier,
  isCanonicalMicrosoftOidcJwksSignatureVerifier,
} = require('./lib/email-microsoft-oidc-jwks-verifier');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  CONTROLLED_DRAFTING_REQUEST_SCOPE,
} = require('./lib/email-microsoft-refresh-token-request');
const {
  parseArgs,
  runOfflineSimulation,
  runOneShotLiveProof,
  createFakeHarnessState,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  COMMANDS,
  ACTIVATION_ORDER,
  refusedProduction,
} = require('./lib/email-luna-controlled-drafting-one-shot-live-proof');
const {
  createEmailLunaControlledDraftingSunsetStagingRuntimeActivation,
  ENV_LIVE_PROVIDER_DRAFT_ENABLED,
} = require('./lib/email-luna-controlled-drafting-sunset-staging-runtime-activation');

const ROOT = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const LOAN_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-token-loan'),
  'utf8',
);
const REFRESH_SRC = fs.readFileSync(
  require.resolve('./lib/email-microsoft-refresh-token-request'),
  'utf8',
);
const GRAPH_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-graph-draft-transport'),
  'utf8',
);
const STAFF_API_SRC = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const LIVE_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-sunset-staging-token-loan'),
  'utf8',
);
const HARNESS_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-one-shot-live-proof'),
  'utf8',
);
const DOC_SRC = fs.readFileSync(
  path.join(ROOT, 'docs/EMAIL-LUNA-CONTROLLED-DRAFTING-TOKEN-LOAN.md'),
  'utf8',
);
const TEST_SUPPORT_REL = 'scripts/lib/email-luna-controlled-drafting-token-loan.test-support.js';
const TEST_SUPPORT_SRC = fs.readFileSync(path.join(ROOT, TEST_SUPPORT_REL), 'utf8');
const CLAIMS_SRC = fs.readFileSync(
  require.resolve('./lib/email-luna-controlled-drafting-access-token-claims'),
  'utf8',
);
const CUSTODIAN_SRC = fs.readFileSync(
  require.resolve('./lib/email-delegated-grant-custodian'),
  'utf8',
);

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_MAILBOX = 'abababab-abab-4bbb-8ccc-dddddddddddd';
const AUDIT = '77777777-7777-4777-8777-777777777777';
const CONVERSATION = '88888888-8888-4888-8888-888888888888';
const INBOUND_EVENT = '99999999-9999-4999-8999-999999999999';
const ISSUANCE = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const PRINCIPAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';
const NOW = 1_900_000_000;
const DRAFT_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite';
const SEND_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const SUBJECT = 'Lesson availability';
const BODY = 'Yes.';
const SUBJECT_DIGEST = crypto.createHash('sha256').update(SUBJECT, 'utf8').digest('hex');
const BODY_DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const SOURCE_MSG = 'AAMkAGI2-SRC';
const THREAD = 'AAQkAGI2-THREAD';
const DRAFT_ID = 'AAMkAGI2-LIVE-DRAFT';
const RECIPIENT = 'operator-test@example.test';
const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const exportedJwk = pair.publicKey.export({ format: 'jwk' });
const KID = 'key-1';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(OLD_RT)
    && !text.includes(NEW_RT)
    && !text.includes(SECRET)
    && !text.includes(PLANTED)
    && !text.includes('ya29.');
}

function rows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}
function empty() { return { rows: [], rowCount: 0 }; }

function createMockPg(handlers) {
  return {
    async query(text, params) {
      const t = String(text);
      for (const h of handlers) {
        if (h.match(t, params)) return h.run(t, params);
      }
      throw new Error(`unmatched_sql:${t.slice(0, 80)}`);
    },
  };
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
  const httpsBag = Object.freeze({
    request(options, callback) {
      onResponse = callback;
      return request;
    },
  });
  const cryptoBag = Object.freeze({
    createPublicKey(input) { return crypto.createPublicKey(input); },
    verify(...args) { return crypto.verify(...args); },
  });
  const timersBag = Object.freeze({
    setTimeout() { return Object.freeze({ id: 1 }); },
    clearTimeout() {},
  });
  return Object.freeze({
    dependencies: Object.freeze({
      https: httpsBag,
      crypto: cryptoBag,
      timers: timersBag,
    }),
  });
}

function canonicalVerifier() {
  return createMicrosoftOidcJwksSignatureVerifier(makeJwksHarness().dependencies);
}

function inspector() {
  return createControlledDraftingAccessTokenClaimsInspector({
    signatureVerifier: canonicalVerifier(),
  });
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

function graphMessage() {
  return {
    id: DRAFT_ID,
    isDraft: true,
    subject: SUBJECT,
    body: { contentType: 'text', content: BODY },
    toRecipients: [{ emailAddress: { address: RECIPIENT, name: 'Elena' } }],
    conversationId: THREAD,
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#messages/$entity',
  };
}

function mockGraphHttps(state) {
  const captured = [];
  function request(options, onResponse) {
    captured.push({
      method: options.method,
      path: options.path,
      hostname: options.hostname,
      headers: options.headers,
    });
    const n = captured.length;
    let planned;
    if (n === 1) {
      planned = { statusCode: 201, body: JSON.stringify({ id: DRAFT_ID, isDraft: true }) };
    } else if (n === 2) {
      planned = { statusCode: 200, body: JSON.stringify({ id: DRAFT_ID }) };
    } else {
      planned = { statusCode: 200, body: JSON.stringify(graphMessage()) };
    }
    const response = new EventEmitter();
    response.statusCode = planned.statusCode;
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': 'application/json' },
      enumerable: true,
      configurable: true,
    });
    const req = new EventEmitter();
    req.end = (body) => {
      captured[captured.length - 1].body = body || null;
      queueMicrotask(() => {
        onResponse(response);
        if (planned.body) response.emit('data', Buffer.from(planned.body, 'utf8'));
        response.emit('end');
      });
    };
    req.destroy = () => {};
    response.destroy = () => {};
    response.on = response.on.bind(response);
    response.once = response.once.bind(response);
    return req;
  }
  request.captured = captured;
  if (state) state.captured = captured;
  return request;
}

function draftCommand() {
  return {
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    subject: SUBJECT,
    body_text: BODY,
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    issuance_id: ISSUANCE,
    operation_id: OPERATION,
  };
}

function mockGrantLifecycle({
  sealed, opId, onCommit, failCommit, priorStatus, noGrant, scopeVersion, failLease,
  bindingRow, events, failAbort, generation, failMark, staleLease, failReauth,
}) {
  let leaseTok = null;
  const scopeVer = scopeVersion === undefined ? 'phase_b_v1' : scopeVersion;
  const log = events || [];
  let currentGeneration = generation || 1;
  let reconcileState = 'clean';
  const prior = priorStatus || {
    client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: currentGeneration, grant_status: 'active', reconcile_state: 'clean',
    grant_lease_token: null,
    scope_version: scopeVer,
  };
  return createMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t)
        && !/tenant_channel_endpoints/i.test(t),
      run: () => (noGrant ? empty() : rows({ ...prior, grant_generation: currentGeneration })),
    },
    {
      match: (t) => /tenant_channel_endpoints/i.test(t) && /tenant_locations/i.test(t),
      run: () => rows(bindingRow || {
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
      }),
    },
    {
      match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: currentGeneration, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null, grant_lease_until: null,
        last_operation_id: opId,
        scope_version: scopeVer,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
        endpoint_binding_status: 'verified',
      }),
    },
    {
      match: (t) => /SET grant_status='lease_held'/i.test(t),
      run: (_t, p) => {
        if (failLease) return empty();
        leaseTok = p[3];
        log.push({ type: 'lease', generation: currentGeneration });
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: 'lease_held',
          grant_lease_token: leaseTok,
          grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: opId,
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
        && /envelope_version/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: currentGeneration, grant_status: 'lease_held',
        grant_lease_token: leaseTok,
        grant_lease_until: new Date(Date.now() + 60000).toISOString(),
        last_operation_id: opId,
        scope_version: scopeVer,
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
      }),
    },
    {
      match: (t) => /SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t),
      run: (_t, p) => {
        if (failCommit) {
          log.push({ type: 'commit_fail', generation: currentGeneration });
          return empty();
        }
        currentGeneration = Number(p[2]);
        if (typeof onCommit === 'function') onCommit(currentGeneration);
        log.push({ type: 'commit', generation: currentGeneration });
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: 'active',
          reconcile_state: 'clean',
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: (_t, p) => {
        if (failMark === true || failMark === 'empty' || staleLease === true) {
          log.push({
            type: 'uncertain_fail',
            generation: currentGeneration,
            state: p && p[2],
            detail: p && p[3],
          });
          return empty();
        }
        if (failMark === 'throw') {
          log.push({ type: 'uncertain_throw', generation: currentGeneration });
          throw new Error('mark_threw');
        }
        reconcileState = p && p[2] ? p[2] : 'ms_response_uncertain';
        log.push({
          type: 'uncertain',
          generation: currentGeneration,
          state: reconcileState,
          detail: p && p[3],
        });
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: 'lease_held',
          reconcile_state: reconcileState,
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t)
        && !/SET grant_generation=/i.test(t),
      run: () => {
        if (failAbort) return empty();
        log.push({
          type: 'abort',
          generation: currentGeneration,
          reconcile_state: reconcileState,
        });
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: currentGeneration, grant_status: 'active',
          reconcile_state: reconcileState,
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /SET grant_status='reauthorization_required'/i.test(t),
      run: () => {
        if (failReauth === true || failReauth === 'empty') {
          log.push({ type: 'reauth_fail', generation: currentGeneration });
          return empty();
        }
        if (failReauth === 'throw') {
          log.push({ type: 'reauth_throw', generation: currentGeneration });
          throw new Error('reauth_threw');
        }
        log.push({ type: 'reauth', generation: currentGeneration });
        return rows({
          grant_generation: currentGeneration,
          grant_status: 'reauthorization_required',
        });
      },
    },
    {
      match: (t) => /reauthorization_required/i.test(t),
      run: () => rows({ grant_generation: currentGeneration, grant_status: 'reauthorization_required' }),
    },
    {
      match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
      run: () => rows({ id: ENDPOINT }),
    },
    { match: () => true, run: () => empty() },
  ]);
}

function successTransport(accessToken, scope = DRAFT_SCOPE, refreshToken = NEW_RT) {
  const body = {
    token_type: 'Bearer',
    expires_in: 3600,
    access_token: accessToken,
    scope,
  };
  if (refreshToken !== null) body.refresh_token = refreshToken;
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }));
}

function loanDeps(overrides = {}) {
  const graphState = overrides.graphState || {};
  return {
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: overrides.withPgClient,
    envelopeProvider: overrides.envelopeProvider,
    createSecretProvider: overrides.createSecretProvider
      || (() => frozenMethod('getClientSecret', async () => SECRET)),
    transport: overrides.transport,
    workerId: 'email-luna-controlled-drafting-token-loan',
    createSignatureVerifier: overrides.createSignatureVerifier || (() => canonicalVerifier()),
    binding: {
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      mailboxId: MAILBOX,
    },
    httpsImpl: overrides.httpsImpl || mockGraphHttps(graphState),
    timers: overrides.timers || {
      setTimeout(fn) { return setTimeout(fn, 10_000); },
      clearTimeout(handle) { clearTimeout(handle); },
    },
  };
}

async function rejectedClaims(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, CLAIMS_CODE);
    assert.equal(noLeak(error), true);
    return true;
  });
}

function runChild(name) {
  const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.status, 0, name);
}

function chapter1Authority() {
  return {
    client_id: CLIENT,
    location_id: LOCATION,
    location_key: 'sunset-somo',
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
  };
}

function chapter1CreateRequest() {
  return {
    ...chapter1Authority(),
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    subject: SUBJECT,
    body_text: BODY,
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    issuance_id: ISSUANCE,
    operation_id: OPERATION,
  };
}

function wrapChapter1(graphProvider) {
  return createEmailLunaControlledDraftingProvider({
    authority: chapter1Authority(),
    transport: pickEmailLunaControlledDraftingTransportMethods({
      createReplyDraft: graphProvider.createReplyDraft,
      reconcileDraft: graphProvider.reconcileDraft,
    }),
  });
}

function attestRow() {
  return {
    session_user: 'luna_cd_worker',
    current_user: 'luna_cd_worker',
    table_owner: 'postgres',
    session_distinct_from_owner: true,
    session_matches_current: true,
    mapping_ok: true,
    login_contract_ok: true,
    execute_ok: true,
  };
}

function compositionOperationRow(patch = {}) {
  return {
    status: patch.status || 'loaded',
    operation_id: OPERATION,
    issuance_id: ISSUANCE,
    audit_operation_id: AUDIT,
    client_id: CLIENT,
    location_id: LOCATION,
    location_key: 'sunset-somo',
    endpoint_id: ENDPOINT,
    conversation_id: CONVERSATION,
    inbound_event_id: INBOUND_EVENT,
    provider: 'microsoft_graph',
    mailbox_id: MAILBOX,
    inbound_provider_message_id: SOURCE_MSG,
    inbound_provider_thread_id: THREAD,
    recipient_address: RECIPIENT,
    canonical_subject: SUBJECT,
    canonical_body: BODY,
    subject_digest: SUBJECT_DIGEST,
    body_digest: BODY_DIGEST,
    draft_digest: SUBJECT_DIGEST,
    policy_version: 'email-luna-draft-policy.v1',
    eligibility_policy_version: 'email-luna-autonomous-eligibility-policy.v1',
    validator_version: 'email-luna-draft-validator.v1',
    state: patch.state || 'reserved',
    create_dispatch_claimed: patch.create_dispatch_claimed === true,
    provider_draft_id: patch.provider_draft_id == null ? null : patch.provider_draft_id,
    is_draft: patch.is_draft == null ? null : patch.is_draft,
    state_generation: patch.state_generation || 1,
  };
}

function compositionSqlClient(state) {
  return {
    async query(text) {
      const t = String(text);
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [] };
      if (/session_user::text AS session_user/.test(t)) {
        return { rows: [attestRow()] };
      }
      if (/tenant_email_luna_controlled_draft_load/.test(t)) {
        if (state.claimed) {
          return { rows: [compositionOperationRow({
            status: 'loaded',
            state: 'create_dispatched_outcome_unknown',
            create_dispatch_claimed: true,
            state_generation: 2,
          })] };
        }
        return { rows: [compositionOperationRow({ status: 'loaded', state: 'reserved' })] };
      }
      if (/tenant_email_luna_controlled_draft_claim_create/.test(t)) {
        state.claimed = true;
        state.claims += 1;
        return { rows: [compositionOperationRow({
          status: 'create_dispatched_outcome_unknown',
          state: 'create_dispatched_outcome_unknown',
          create_dispatch_claimed: true,
          state_generation: 2,
        })] };
      }
      throw new Error(`unmatched_composition_sql:${t.slice(0, 80)}`);
    },
  };
}

async function tickThroughComposition(graphProvider) {
  const wrapped = wrapChapter1(graphProvider);
  const state = { claimed: false, claims: 0 };
  const producerFn = async (work) => work(compositionSqlClient(state));
  const workerFn = async (work) => work(compositionSqlClient(state));
  const runtime = createEmailLunaControlledDraftingSunsetStagingRuntimeComposition({
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      DEFAULT_CLIENT_SLUG: 'sunset',
      EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
      EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: CLIENT,
      EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: LOCATION,
      EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
      EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: ENDPOINT,
      EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: MAILBOX,
      EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
    },
    producerWithTransactionClient: bindProducerWithTransactionClient(producerFn),
    workerWithTransactionClient: bindWorkerWithTransactionClient(workerFn),
    provider: wrapped,
    issuanceStore: {
      assertAuthenticLoadedMaterial() {
        throw Object.freeze(Object.assign(new Error('unused'), { code: 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_INVALID' }));
      },
      recoverAutomationIssuance() {
        throw Object.freeze(Object.assign(new Error('unused'), { code: 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_INVALID' }));
      },
    },
  });
  const store = createEmailLunaControlledDraftingOperationStore({
    withTransactionClient: bindWorkerWithTransactionClient(async (work) => work(compositionSqlClient(state))),
  });
  const loaded = await store.loadControlledDraft({
    operation_id: OPERATION,
    issuance_id: ISSUANCE,
  });
  const first = await runtime.tick({ operation: loaded.record });
  const loadedAgain = await store.loadControlledDraft({
    operation_id: OPERATION,
    issuance_id: ISSUANCE,
  });
  const second = await runtime.tick({ operation: loadedAgain.record });
  return { first, second, claims: state.claims, wrapped };
}

function sealFailingEnvelope(inner) {
  return Object.freeze({
    async sealGrantPayload() { throw new Error('seal-fail'); },
    openGrantPayload(...args) { return inner.openGrantPayload(...args); },
    rewrapGrantDek(...args) { return inner.rewrapGrantDek(...args); },
  });
}

function invalidSealEnvelope(inner) {
  return Object.freeze({
    async sealGrantPayload() { return { envelope_version: 'nope' }; },
    openGrantPayload(...args) { return inner.openGrantPayload(...args); },
    rewrapGrantDek(...args) { return inner.rewrapGrantDek(...args); },
  });
}

async function makeProvider(overrides = {}) {
  const envelope = overrides.envelopeProvider || createFakeEmailGrantEnvelopeProvider();
  const op = overrides.opId || crypto.randomUUID();
  const sealed = overrides.sealed || await fakeSealRefreshToken(envelope, {
    refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
    grantGeneration: 1, operationId: op,
  });
  const events = overrides.events || [];
  const graphState = overrides.graphState || {};
  const provider = createEmailLunaControlledDraftingGraphProvider(loanDeps({
    withPgClient: overrides.withPgClient
      || (async (work) => work(mockGrantLifecycle({
        sealed, opId: op, events, failCommit: overrides.failCommit,
        bindingRow: overrides.bindingRow, failAbort: overrides.failAbort,
        failMark: overrides.failMark, staleLease: overrides.staleLease,
        failReauth: overrides.failReauth,
      }))),
    envelopeProvider: envelope,
    transport: overrides.transport || successTransport(overrides.accessJwt || liveJwt()),
    httpsImpl: overrides.httpsImpl || mockGraphHttps(graphState),
    createSignatureVerifier: overrides.createSignatureVerifier,
    createSecretProvider: overrides.createSecretProvider,
    graphState,
  }));
  return { provider, graphState, events, envelope };
}

function throwingTokenTransport() {
  return frozenMethod('postTokenForm', async () => {
    throw new Error('token-http-timeout');
  });
}

function unparseableTokenTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: '{not-json',
  }));
}

function broaderScopeWithNewRtTransport() {
  return successTransport(liveJwt(), SEND_SCOPE, NEW_RT);
}

function missingAccessTokenTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: NEW_RT,
      scope: DRAFT_SCOPE,
    }),
  }));
}

function invalidGrantTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 400,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'invalid_grant' }),
  }));
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C token loan verifier');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED, false);
  assert.equal(SCOPE_PROFILE_ID, 'controlled_drafting_v1');
  assert.equal(REQUESTED_SCOPE, CONTROLLED_DRAFTING_REQUEST_SCOPE);
  assert.equal(ATTESTATION_KIND, 'configured_contract_only');
  assert.equal(REQUESTED_SCOPE.includes('Mail.Send'), false);
  assert.deepEqual([...DEPENDENCY_KEYS], [
    'deployment', 'applicationClientId', 'withPgClient', 'envelopeProvider',
    'createSecretProvider', 'transport', 'workerId', 'createSignatureVerifier', 'binding',
    'httpsImpl', 'timers',
  ]);
  assert.deepEqual([...BINDING_KEYS], ['clientId', 'locationId', 'endpointId', 'mailboxId']);
  assert.deepEqual([...SERVICE_KEYS], ['attest', 'createReplyDraft', 'reconcileDraft']);
  assert.deepEqual([...TOKEN_LOAN_NO_PROVIDER_POST_STAGES], [
    'kill_switch', 'status', 'lease', 'open', 'grant_scope', 'secret', 'token',
    'response', 'claims', 'binding', 'dead_grant', 'reseal', 'commit',
    'uncertainty_persistence',
  ]);
  assert.equal(TOKEN_LOAN_STAGES.includes('release'), true);
  assert.equal(TOKEN_LOAN_NO_PROVIDER_POST_STAGES.includes('release'), false);
  assert.deepEqual([...REQUIRED_SCP], ['User.Read', 'Mail.ReadWrite']);
  assert.ok(GRAPH_AUDIENCES.includes('00000003-0000-0000-c000-000000000000'));
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 0);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-token-loan'],
    'node scripts/verify-email-luna-controlled-drafting-token-loan.js');
  assert.equal(PKG.scripts['prove:email-luna-controlled-drafting-token-loan-offline-simulation'],
    'node scripts/prove-email-luna-controlled-drafting-token-loan-offline-simulation.js');
  assert.equal(PKG.scripts['prove:email-luna-controlled-drafting-token-loan-stock-pg'],
    'node scripts/prove-email-luna-controlled-drafting-token-loan-stock-pg.js');

  const loanModule = require('./lib/email-luna-controlled-drafting-token-loan');
  assert.equal(loanModule.createEmailLunaControlledDraftingTokenLoan, undefined);
  assert.equal(loanModule.createEmailLunaControlledDraftingFakeClosedTokenLoan, undefined);
  assert.equal(loanModule.runClosed, undefined);
  assert.equal(loanModule.withToken, undefined);
  assert.equal(loanModule.getAccessToken, undefined);
  assert.doesNotMatch(LOAN_SRC, /function runClosed|runClosed\s*\(/);
  assert.doesNotMatch(LOAN_SRC, /function withToken|withToken\s*\(/);
  assert.doesNotMatch(LOAN_SRC, /function getAccessToken|getAccessToken\s*\(/);
  assert.doesNotMatch(LOAN_SRC, /createEmailLunaControlledDraftingFakeClosedTokenLoan/);
  assert.doesNotMatch(GRAPH_SRC, /function getAccessToken|getAccessToken\s*\(/);
  assert.doesNotMatch(GRAPH_SRC, /\/send/);
  assert.doesNotMatch(GRAPH_SRC, /tokenLoan\.runClosed/);
  assert.match(LOAN_SRC, /controlled_drafting_v1/);
  assert.match(LOAN_SRC, /tryAcquireDelegatedGrantLease/);
  assert.match(LOAN_SRC, /createEmailLunaControlledDraftingGraphDraftHttpConsumer/);
  assert.match(REFRESH_SRC, /CONTROLLED_DRAFTING_REQUEST_SCOPE/);
  assert.match(STAFF_API_SRC, /createEmailLunaControlledDraftingSunsetStagingLiveGraphProvider/);
  assert.doesNotMatch(
    STAFF_API_SRC,
    new RegExp(TEST_SUPPORT_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.doesNotMatch(STAFF_API_SRC, /createEmailLunaControlledDraftingGraphDraftHttpConsumer/);
  assert.match(STAFF_API_SRC, /process\.env\[ENV_LIVE_PROVIDER_DRAFT_ENABLED\] === 'true'/);
  assert.doesNotMatch(LIVE_SRC, /createMicrosoftGraphReplyDraftTransport/);
  assert.doesNotMatch(LIVE_SRC, /sendDraft|sendMail/);
  assert.match(HARNESS_SRC, /live_mode_structurally_absent_until_reviewed_sha/);
  assert.match(HARNESS_SRC, /simulation/);
  assert.match(HARNESS_SRC, /live_evidence/);
  assert.doesNotMatch(HARNESS_SRC, /consumed_098:\s*true/);
  assert.doesNotMatch(HARNESS_SRC, /provider_is_draft:\s*true/);
  assert.doesNotMatch(HARNESS_SRC, /graph_called:\s*true/);
  assert.match(DOC_SRC, /Mail\.ReadWrite/);
  assert.match(DOC_SRC, /does \*\*not\*\* include permission to send/);
  assert.match(DOC_SRC, /configured_contract_only/);
  assert.match(DOC_SRC, /unproven/);
  assert.match(DOC_SRC, /simulation/);
  assert.match(DOC_SRC, /claim-before-refresh|claims create authority before/);
  assert.match(DOC_SRC, /Mark-success → abort-preserve/);
  assert.match(DOC_SRC, /persistence_unproven|persistence is unproven|Leave the lease/);
  assert.match(DOC_SRC, /uncertainty_persistence/);
  assert.match(DOC_SRC, /not a PostgreSQL proof/);
  assert.match(DOC_SRC, /token_loan_failed_after_claim_no_provider_post/);
  assert.match(DOC_SRC, /kill_switch.*status.*lease.*open.*grant_scope.*secret.*token.*response.*claims.*binding.*dead_grant.*reseal.*commit.*uncertainty_persistence/s);
  assert.match(LOAN_SRC, /refuseAfterRotatingMicrosoftResponse/);
  assert.match(LOAN_SRC, /potentially rotating or unknown Microsoft/);
  assert.match(LOAN_SRC, /persistence_unproven/);
  {
    const helperStart = LOAN_SRC.indexOf('async function refuseAfterRotatingMicrosoftResponse');
    const helperEnd = LOAN_SRC.indexOf('async function refuseBeforeCommit');
    assert.ok(helperStart > 0 && helperEnd > helperStart);
    const helperSrc = LOAN_SRC.slice(helperStart, helperEnd);
    const outsideHelper = LOAN_SRC.slice(0, helperStart) + LOAN_SRC.slice(helperEnd);
    assert.match(helperSrc, /suppressLeaseAbort = true/);
    assert.ok(helperSrc.indexOf('suppressLeaseAbort = true') < helperSrc.indexOf('markDelegatedGrantReconciliation'));
    assert.equal((helperSrc.match(/markDelegatedGrantReconciliation/g) || []).length, 1);
    assert.equal((LOAN_SRC.match(/markDelegatedGrantReconciliation/g) || []).length, 2);
    assert.doesNotMatch(outsideHelper, /await markDelegatedGrantReconciliation/);
    assert.doesNotMatch(
      LOAN_SRC,
      /await markDelegatedGrantReconciliation\([\s\S]{0,400}?await safeAbort/,
    );
    const postMs = LOAN_SRC.slice(LOAN_SRC.indexOf('exchange.exchangeRefreshToken'));
    assert.match(postMs, /refuseAfterRotatingMicrosoftResponse\('token', 'ms_refresh_transport'\)/);
    assert.match(postMs, /refuseAfterRotatingMicrosoftResponse\('response', 'ms_refresh_uncertain'\)/);
    assert.doesNotMatch(
      postMs,
      /await markDelegatedGrantReconciliation\([\s\S]{0,400}?await safeAbort/,
    );
    assert.match(LOAN_SRC, /if \(!suppressLeaseAbort\) await safeAbort/);
  }
  {
    const secretAssign = REFRESH_SRC.indexOf("stage = 'secret'");
    const tokenAfterSecret = REFRESH_SRC.indexOf("stage = 'token'", secretAssign);
    const postTokenForm = REFRESH_SRC.indexOf('postTokenForm', tokenAfterSecret);
    const responseAssign = REFRESH_SRC.indexOf("stage = 'response'");
    assert.ok(secretAssign > 0);
    assert.ok(tokenAfterSecret > secretAssign);
    assert.ok(postTokenForm > tokenAfterSecret);
    assert.ok(responseAssign > postTokenForm);
  }
  assert.match(DOC_SRC, /Token HTTP timeout/);
  assert.match(DOC_SRC, /unparseable body/);
  assert.match(DOC_SRC, /classification failure/);
  assert.match(DOC_SRC, /mark-first/);
  assert.doesNotMatch(LOAN_SRC, /brandTokenLoanFailure,/);
  assert.match(TEST_SUPPORT_SRC, /TEST-ONLY/);
  assert.match(CLAIMS_SRC, /isCanonicalMicrosoftOidcJwksSignatureVerifier/);
  assert.match(CUSTODIAN_SRC, /providerPrincipalOid/);
  console.log('  PASS  static surface; no generic token callback; no send paths');

  assert.throws(
    () => createEmailLunaControlledDraftingGraphDraftTransport({
      httpsImpl() {},
      getAccessToken: () => PLANTED,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID',
  );
  assert.throws(
    () => createEmailLunaControlledDraftingGraphDraftTransport({
      httpsImpl() {},
      tokenLoan: { runClosed() {} },
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID',
  );
  console.log('  PASS  RED missing closed loan / getAccessToken / runClosed refused');

  {
    const { provider, graphState } = await makeProvider();
    assert.equal(isClosedControlledDraftingGraphProvider(provider), true);
    const att = provider.attest();
    assert.equal(att.ok, true);
    assert.equal(att.attestation_kind, 'configured_contract_only');
    assert.equal(att.send_capable, false);
    assert.equal(att.mail_send, false);
    assert.equal(typeof provider.runClosed, 'undefined');
    assert.equal(typeof provider.withToken, 'undefined');
    assert.equal(typeof provider.getAccessToken, 'undefined');
    assert.deepEqual([...Reflect.ownKeys(provider)].sort(), [
      'attest', 'createReplyDraft', 'reconcileDraft',
    ]);
    assert.equal(Object.getPrototypeOf(provider), Object.prototype);
    for (const key of Reflect.ownKeys(provider)) {
      assert.equal(typeof key, 'string');
    }
    assert.equal(Object.getOwnPropertySymbols(provider).length, 0);
    assert.throws(() => provider.runClosed(async (token) => token));
    const created = await provider.createReplyDraft(draftCommand());
    assert.equal(created.is_draft, true);
    assert.equal(created.provider_draft_id, DRAFT_ID);
    assert.equal(JSON.stringify(created).includes(PLANTED), false);
    assert.equal(noLeak(created), true);
    assert.equal(JSON.stringify(att).includes('eyJ'), false);
    const auth = graphState.captured[0].headers.Authorization;
    assert.match(auth, /^Bearer /);
    assert.equal(JSON.stringify(created).includes(auth.slice(7)), false);
    assert.throws(() => createEmailLunaControlledDraftingGraphProvider({
      ...loanDeps({
        withPgClient: async (work) => work({ async query() { return empty(); } }),
        envelopeProvider: createFakeEmailGrantEnvelopeProvider(),
        transport: successTransport(liveJwt()),
      }),
      consumer: async (token) => token,
    }));
    console.log('  PASS  H1 independent reproduction: no token escape via callback/own/symbol/prototype');
  }

  {
    const structural = Object.freeze({
      async verify() { return Object.seal({ verified: true }); },
    });
    assert.equal(isCanonicalMicrosoftOidcJwksSignatureVerifier(structural), false);
    assert.throws(
      () => createControlledDraftingAccessTokenClaimsInspector({
        signatureVerifier: structural,
      }),
      (error) => error && error.code === CLAIMS_CODE,
    );
    const good = inspector();
    const result = await good.inspect(inspectInput());
    assert.equal(result.ok, true);
    assert.equal(result.mail_send, false);
    assert.equal(result.scp, 'User.Read Mail.ReadWrite');
    assert.equal(result.kid, KID);
    assert.equal(result.alg, 'RS256');
    assert.equal(result.ver_matches, true);
    assert.equal(result.oid_matches, true);
    const badSig = signJwt({ alg: 'RS256', kid: KID, typ: 'JWT' }, baseClaims());
    const tampered = `${badSig.slice(0, -4)}abcd`;
    await rejectedClaims(inspector().inspect(inspectInput(tampered)));
    await rejectedClaims(inspector().inspect(inspectInput('opaque-token')));
    await rejectedClaims(inspector().inspect(inspectInput(
      signJwt({ alg: 'none', kid: KID }, baseClaims()),
    )));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ roles: ['Mail.Send'] }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ aud: APP_ID }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ tid: APP_ID }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ azp: MAILBOX, appid: MAILBOX }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ oid: MAILBOX }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ oid: APP_ID }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ exp: NOW - 1000 }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ nbf: NOW + 1000 }))));
    await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ ver: '1.0' }))));
    const cloned = { ...canonicalVerifier() };
    assert.throws(() => createControlledDraftingAccessTokenClaimsInspector({
      signatureVerifier: Object.freeze(cloned),
    }));
    console.log('  PASS  M1 canonical JWKS brand; real RS256 good/bad; oid≠mailbox refuse');
  }

  {
    const events = [];
    const { provider } = await makeProvider({
      events,
      accessJwt: liveJwt(),
      bindingRow: {
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
        provider_principal_oid: null,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: 'operator-test@example.test',
        grant_client_id: CLIENT,
        grant_endpoint_id: ENDPOINT,
      },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'binding' && noLeak(error);
      },
    );
  }
  {
    const { provider } = await makeProvider({
      accessJwt: liveJwt({ oid: MAILBOX }),
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'claims' && noLeak(error);
      },
    );
  }
  console.log('  PASS  M2 null principal oid and mailbox-as-oid refuse; no PII in errors');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      accessJwt: liveJwt(),
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      bindingRow: {
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
        provider_principal_oid: null,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: 'operator-test@example.test',
        grant_client_id: CLIENT,
        grant_endpoint_id: ENDPOINT,
      },
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'binding' && noLeak(error);
      },
    );
    const uncertain = events.filter((row) => row.type === 'uncertain');
    const abort = events.filter((row) => row.type === 'abort');
    assert.equal(uncertain.length, 1, 'RED: rotating response + binding fail must mark ms_response_uncertain');
    assert.equal(uncertain[0].state, 'ms_response_uncertain');
    assert.equal(uncertain[0].detail, 'post_ms_binding');
    assert.equal(abort.length, 1, 'mark success must abort');
    assert.equal(abort[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(graphCalls, 0);
    assert.equal(events.some((row) => row.type === 'commit'), false);
  }
  console.log('  PASS  M1 RED reproduction: new RT + binding fail marks uncertain then abort; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      accessJwt: liveJwt({ oid: MAILBOX }),
      transport: successTransport(liveJwt({ oid: MAILBOX }), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'claims' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'post_ms_claims');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 claims/JWKS fail after rotating response marks then abort; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    let refreshed = false;
    const { provider } = await makeProvider({
      events,
      transport: frozenMethod('postTokenForm', async () => {
        const body = JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: liveJwt(),
          refresh_token: NEW_RT,
          scope: DRAFT_SCOPE,
        });
        refreshed = true;
        return Object.freeze({
          statusCode: 200,
          contentType: 'application/json',
          body,
        });
      }),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    bindControlledDraftingTokenLoanKillSwitch(provider, () => refreshed);
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'kill_switch' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'post_ms_kill_switch');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 kill after claims on rotating response marks then abort; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const inner = createFakeEmailGrantEnvelopeProvider();
    const opSeal = crypto.randomUUID();
    const sealedSeal = await fakeSealRefreshToken(inner, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: opSeal,
    });
    const provider = createEmailLunaControlledDraftingGraphProvider(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({
        sealed: sealedSeal, opId: opSeal, events,
      })),
      envelopeProvider: sealFailingEnvelope(inner),
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    }));
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'reseal' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'post_ms_pre_seal');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    const inner = createFakeEmailGrantEnvelopeProvider();
    const opInv = crypto.randomUUID();
    const sealedInv = await fakeSealRefreshToken(inner, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: opInv,
    });
    const provider = createEmailLunaControlledDraftingGraphProvider(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({
        sealed: sealedInv, opId: opInv, events,
      })),
      envelopeProvider: invalidSealEnvelope(inner),
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    }));
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'reseal' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'post_ms_pre_commit');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 AAD/seal/validate fail after rotating response marks then abort; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failCommit: true,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'commit' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'post_ms_cas_conflict');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(events.some((row) => row.type === 'commit'), false);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 CAS fail after rotating response marks then abort; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failMark: true,
      accessJwt: liveJwt(),
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      bindingRow: {
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
        provider_principal_oid: null,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: 'operator-test@example.test',
        grant_client_id: CLIENT,
        grant_endpoint_id: ENDPOINT,
      },
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain_fail').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(events.some((row) => row.type === 'commit'), false);
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      staleLease: true,
      failCommit: true,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'uncertainty_persistence' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 mark fail/fenced/expired does not abort; persistence unproven; Graph=0');

  async function assertFailMarkLeavesLease(transport, expectedDetail) {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failMark: true,
      transport,
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    const failed = events.filter((row) => row.type === 'uncertain_fail' || row.type === 'uncertain_throw');
    assert.equal(failed.length, 1);
    if (expectedDetail && failed[0].type === 'uncertain_fail') {
      assert.equal(failed[0].detail, expectedDetail);
    }
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(events.some((row) => row.type === 'abort' && row.reconcile_state === 'clean'), false);
    assert.equal(events.some((row) => row.type === 'commit'), false);
    assert.equal(graphCalls, 0);
    return events;
  }

  {
    await assertFailMarkLeavesLease(throwingTokenTransport(), 'ms_refresh_transport');
  }
  {
    await assertFailMarkLeavesLease(unparseableTokenTransport(), 'ms_refresh_uncertain');
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failMark: 'throw',
      transport: unparseableTokenTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'uncertainty_persistence' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain_throw').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(graphCalls, 0);
  }
  {
    await assertFailMarkLeavesLease(broaderScopeWithNewRtTransport(), 'ms_refresh_uncertain');
  }
  {
    await assertFailMarkLeavesLease(missingAccessTokenTransport(), 'ms_refresh_uncertain');
  }
  console.log('  PASS  RED failMark after MS exchange/timeout/parse/classify/missing-token does not abort; Graph=0');

  {
    const igIdx = LOAN_SRC.indexOf("classified.kind === 'invalid_grant'");
    assert.ok(igIdx > 0);
    const igBlock = LOAN_SRC.slice(igIdx, igIdx + 1200);
    assert.match(igBlock, /markDelegatedGrantReauthorizationRequired/);
    assert.match(igBlock, /reauth\.ok/);
    assert.match(igBlock, /uncertainty_persistence/);
    assert.match(igBlock, /persistence_unproven/);
    assert.match(igBlock, /suppressLeaseAbort/);
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      transport: invalidGrantTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'dead_grant' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'reauth').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failReauth: true,
      transport: invalidGrantTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'reauth_fail').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(events.filter((row) => row.type === 'reauth').length, 0);
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failReauth: 'throw',
      transport: invalidGrantTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note
          && note.stage === 'uncertainty_persistence'
          && note.code === 'persistence_unproven'
          && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'reauth_throw').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  RED invalid_grant mark fail/fenced leaves lease; persistence unproven not dead_grant; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      failAbort: true,
      transport: throwingTokenTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'token' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'ms_refresh_transport');
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
    assert.equal(events.some((row) => row.type === 'abort' && row.reconcile_state === 'clean'), false);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  mark success + abort fail on token timeout leaves uncertain; no active/clean; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      transport: throwingTokenTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'token' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'ms_refresh_transport');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      transport: broaderScopeWithNewRtTransport(),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'response' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
    assert.equal(events.filter((row) => row.type === 'uncertain')[0].detail, 'ms_refresh_uncertain');
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'ms_response_uncertain');
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  mark success + abort success after MS timeout/broader scope is active+uncertain; Graph=0');

  {
    const events = [];
    let graphCalls = 0;
    let oauthCalls = 0;
    const { provider } = await makeProvider({
      events,
      createSecretProvider: () => null,
      transport: frozenMethod('postTokenForm', async () => {
        oauthCalls += 1;
        throw new Error('oauth-must-not-run');
      }),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'secret' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 0);
    assert.equal(events.filter((row) => row.type === 'uncertain_fail').length, 0);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.filter((row) => row.type === 'abort')[0].reconcile_state, 'clean');
    assert.equal(oauthCalls, 0);
    assert.equal(graphCalls, 0);
  }
  {
    const events = [];
    let graphCalls = 0;
    let oauthCalls = 0;
    const { provider } = await makeProvider({
      events,
      createSecretProvider: () => frozenMethod('getClientSecret', async () => {
        throw new Error('kv-secret-fail');
      }),
      transport: frozenMethod('postTokenForm', async () => {
        oauthCalls += 1;
        throw new Error('oauth-must-not-run');
      }),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'secret' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 0);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(oauthCalls, 0);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  authentic pre-HTTP secret fail stays abort-only; timeout is not secret');

  {
    const events = [];
    let graphCalls = 0;
    const { provider } = await makeProvider({
      events,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, null),
      bindingRow: {
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
        provider_principal_oid: null,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: 'operator-test@example.test',
        grant_client_id: CLIENT,
        grant_endpoint_id: ENDPOINT,
      },
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    await assert.rejects(
      () => provider.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'binding' && noLeak(error);
      },
    );
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 0);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events.some((row) => row.type === 'commit'), false);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  M1 omitted refresh stays abort-only; no uncertainty mark; Graph=0');

  {
    let oauthCalls = 0;
    let graphCalls = 0;
    const { provider } = await makeProvider({
      transport: frozenMethod('postTokenForm', async () => {
        oauthCalls += 1;
        throw new Error('oauth-must-not-run');
      }),
      httpsImpl() { graphCalls += 1; throw new Error('graph-must-not-run'); },
    });
    const wrong = { ...draftCommand(), mailbox_id: OTHER_MAILBOX };
    await assert.rejects(
      () => provider.createReplyDraft(wrong),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'binding' && noLeak(error);
      },
    );
    assert.equal(oauthCalls, 0);
    assert.equal(graphCalls, 0);
  }
  console.log('  PASS  LOW-1 direct-factory wrong mailbox refuses before OAuth/Graph');

  {
    const events = [];
    const { provider } = await makeProvider({
      events,
      accessJwt: liveJwt({ oid: MAILBOX }),
      transport: successTransport(liveJwt({ oid: MAILBOX }), DRAFT_SCOPE, NEW_RT),
      httpsImpl() { throw new Error('graph-must-not-run'); },
    });
    const wrapped = wrapChapter1(provider);
    let wrappedErr;
    await assert.rejects(
      () => wrapped.createReplyDraft(chapter1CreateRequest()),
      (error) => {
        wrappedErr = error;
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'claims' && error.code === ERROR_CODE && noLeak(error);
      },
    );
    assert.equal(isTrustedControlledDraftingTokenLoanNoProviderPostFailure(wrappedErr), true);
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
  }
  console.log('  PASS  M2 Chapter 1 wrap preserves trusted token-loan brand');

  {
    const events = [];
    const graphState = { captured: [] };
    const { provider } = await makeProvider({
      events,
      accessJwt: liveJwt({ oid: MAILBOX }),
      transport: successTransport(liveJwt({ oid: MAILBOX }), DRAFT_SCOPE, NEW_RT),
      graphState,
      httpsImpl() { throw new Error('graph-must-not-run'); },
    });
    const { first, second, claims } = await tickThroughComposition(provider);
    assert.equal(first.reason, 'token_loan_failed_after_claim_no_provider_post');
    assert.equal(first.provider_invoked, false);
    assert.equal(first.create_invoked, false);
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(second.provider_invoked, false);
    assert.equal(claims, 1);
    assert.equal(graphState.captured.length, 0);
    assert.equal(events.filter((row) => row.type === 'uncertain').length, 1);
  }
  console.log('  PASS  M2 pre-POST claims failure through wrap/composition is no-post; no second POST');

  {
    const events = [];
    const graphState = { captured: [] };
    const { provider } = await makeProvider({
      events,
      failCommit: true,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
      graphState,
      httpsImpl() { throw new Error('graph-must-not-run'); },
    });
    const { first, second } = await tickThroughComposition(provider);
    assert.equal(first.reason, 'token_loan_failed_after_claim_no_provider_post');
    assert.equal(first.provider_invoked, false);
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(graphState.captured.length, 0);
  }
  console.log('  PASS  M2 rotating uncertainty failure through wrap/composition is no-post; Graph=0');

  {
    const events = [];
    const graphState = { captured: [] };
    const { provider } = await makeProvider({
      events,
      failMark: true,
      transport: throwingTokenTransport(),
      graphState,
      httpsImpl() { throw new Error('graph-must-not-run'); },
    });
    const wrapped = wrapChapter1(provider);
    let wrappedErr;
    await assert.rejects(
      () => wrapped.createReplyDraft(chapter1CreateRequest()),
      (error) => {
        wrappedErr = error;
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'uncertainty_persistence' && error.code === ERROR_CODE && noLeak(error);
      },
    );
    assert.equal(isTrustedControlledDraftingTokenLoanNoProviderPostFailure(wrappedErr), true);
    const { first, second, claims } = await tickThroughComposition(provider);
    assert.equal(first.reason, 'token_loan_failed_after_claim_no_provider_post');
    assert.equal(first.provider_invoked, false);
    assert.equal(first.create_invoked, false);
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(second.provider_invoked, false);
    assert.equal(claims, 1);
    assert.equal(graphState.captured.length, 0);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
  }
  {
    const events = [];
    const graphState = { captured: [] };
    const { provider } = await makeProvider({
      events,
      failMark: true,
      transport: broaderScopeWithNewRtTransport(),
      graphState,
      httpsImpl() { throw new Error('graph-must-not-run'); },
    });
    const { first, second, claims } = await tickThroughComposition(provider);
    assert.equal(first.reason, 'token_loan_failed_after_claim_no_provider_post');
    assert.equal(first.provider_invoked, false);
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(claims, 1);
    assert.equal(graphState.captured.length, 0);
    assert.equal(events.filter((row) => row.type === 'abort').length, 0);
  }
  console.log('  PASS  wrap/composition MS timeout/classify failMark is no-post; provider_invoked=false; no second POST');

  {
    const graphState = { captured: [] };
    const { provider: postTimeoutProvider } = await makeProvider({
      graphState,
      httpsImpl() {
        const req = new EventEmitter();
        req.end = () => {};
        req.destroy = () => {};
        return req;
      },
      timers: {
        setTimeout(fn) { fn(); return 1; },
        clearTimeout() {},
      },
    });
    const wrapped = wrapChapter1(postTimeoutProvider);
    await assert.rejects(
      () => wrapped.createReplyDraft(chapter1CreateRequest()),
      (error) => error && error.code === PROVIDER_INVALID_CODE
        && !readTrustedControlledDraftingTokenLoanFailure(error)
        && noLeak(error),
    );
    const { first, second, claims } = await tickThroughComposition(postTimeoutProvider);
    assert.equal(first.reason, 'provider_create_unknown');
    assert.equal(first.provider_invoked, true);
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(second.provider_invoked, false);
    assert.equal(claims, 1);
  }
  {
    const graphState = { captured: [] };
    const original = mockGraphHttps(graphState);
    function afterPostHang(options, onResponse) {
      if (!graphState.captured || graphState.captured.length === 0) {
        return original(options, onResponse);
      }
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = () => {};
      return req;
    }
    const { provider } = await makeProvider({
      httpsImpl: afterPostHang,
      graphState,
      timers: {
        setTimeout(fn) { fn(); return 1; },
        clearTimeout() {},
      },
    });
    const { first, second } = await tickThroughComposition(provider);
    assert.equal(first.provider_invoked, true);
    assert.notEqual(first.reason, 'token_loan_failed_after_claim_no_provider_post');
    assert.equal(second.reason, 'unknown_create_unobservable');
    assert.equal(second.provider_invoked, false);
  }
  console.log('  PASS  M2 Graph POST/PATCH timeout through wrap/composition is invoked/ambiguous; no second POST');

  {
    const { provider: leakProvider } = await makeProvider({
      httpsImpl(options) {
        const header = options && options.headers && options.headers.Authorization;
        throw new Error(`graph failed ${PLANTED} ${header || ''}`);
      },
    });
    const wrapped = wrapChapter1(leakProvider);
    await assert.rejects(
      () => wrapped.createReplyDraft(chapter1CreateRequest()),
      (error) => error
        && error.code === PROVIDER_INVALID_CODE
        && !readTrustedControlledDraftingTokenLoanFailure(error)
        && noLeak(error),
    );
    const { provider: leakTick } = await makeProvider({
      httpsImpl(options) {
        const header = options && options.headers && options.headers.Authorization;
        throw new Error(`graph failed ${PLANTED} ${header || ''}`);
      },
    });
    const { first } = await tickThroughComposition(leakTick);
    assert.equal(first.reason, 'provider_create_unknown');
    assert.equal(first.provider_invoked, true);
  }
  console.log('  PASS  M2 planted token / Graph consumer errors sanitize without false no-post');

  {
    const events = [];
    let capturedBody;
    const { provider } = await makeProvider({
      events,
      transport: frozenMethod('postTokenForm', async (arg) => {
        capturedBody = arg.body;
        return Object.freeze({
          statusCode: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token_type: 'Bearer',
            expires_in: 3600,
            access_token: liveJwt(),
            scope: DRAFT_SCOPE,
          }),
        });
      }),
    });
    await provider.createReplyDraft(draftCommand());
    assert.equal(new URLSearchParams(capturedBody).get('scope'), REQUESTED_SCOPE);
    assert.equal(events.some((row) => row.type === 'commit'), false);
    assert.equal(events.filter((row) => row.type === 'abort').length, 1);
    assert.equal(events[events.length - 1].generation, 1);
    console.log('  PASS  M3 omitted refresh token: no generation bump; lease released');
  }

  {
    const events = [];
    const { provider } = await makeProvider({
      events,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
    });
    await provider.createReplyDraft(draftCommand());
    const commits = events.filter((row) => row.type === 'commit');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].generation, 2);
    console.log('  PASS  M3 new refresh token: exactly one generation bump');
  }

  {
    const events = [];
    const { provider } = await makeProvider({
      events,
      failCommit: true,
      transport: successTransport(liveJwt(), DRAFT_SCOPE, NEW_RT),
    });
    await assert.rejects(() => provider.createReplyDraft(draftCommand()));
    assert.equal(events.some((row) => row.type === 'uncertain'), true);
    assert.equal(events.some((row) => row.type === 'commit'), false);
    console.log('  PASS  M3 CAS failure after rotating response marks ms_response_uncertain');
  }

  {
    const env2 = createFakeEmailGrantEnvelopeProvider();
    const op2 = crypto.randomUUID();
    const sealed2 = await fakeSealRefreshToken(env2, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2,
    });
    const broader = createEmailLunaControlledDraftingGraphProvider(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed2, opId: op2 })),
      envelopeProvider: env2,
      transport: successTransport(liveJwt(), SEND_SCOPE),
      httpsImpl() { throw new Error('graph-must-not-run'); },
    }));
    await assert.rejects(
      () => broader.createReplyDraft(draftCommand()),
      (error) => readTrustedControlledDraftingTokenLoanFailure(error) && noLeak(error),
    );
  }
  console.log('  PASS  broader Mail.Send token response refuses before Graph');

  {
    const env4 = createFakeEmailGrantEnvelopeProvider();
    const op4 = crypto.randomUUID();
    const sealed4 = await fakeSealRefreshToken(env4, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op4,
    });
    const killed = createEmailLunaControlledDraftingGraphProvider(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed4, opId: op4 })),
      envelopeProvider: env4,
      transport: successTransport(liveJwt(), DRAFT_SCOPE),
      httpsImpl() { throw new Error('graph-must-not-run'); },
    }));
    bindControlledDraftingTokenLoanKillSwitch(killed, () => true);
    await assert.rejects(
      () => killed.createReplyDraft(draftCommand()),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'kill_switch' && noLeak(error);
      },
    );
  }
  console.log('  PASS  kill switch before refresh refuses with zero Graph');

  {
    const env5 = createFakeEmailGrantEnvelopeProvider();
    const op5 = crypto.randomUUID();
    const sealed5 = await fakeSealRefreshToken(env5, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op5,
    });
    let inFlight = 0;
    let max = 0;
    const sequential = createEmailLunaControlledDraftingGraphProvider(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed5, opId: op5 })),
      envelopeProvider: env5,
      transport: frozenMethod('postTokenForm', async () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        inFlight -= 1;
        return Object.freeze({
          statusCode: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token_type: 'Bearer',
            expires_in: 3600,
            access_token: liveJwt(),
            refresh_token: NEW_RT,
            scope: DRAFT_SCOPE,
          }),
        });
      }),
    }));
    await Promise.all([
      sequential.createReplyDraft(draftCommand()).catch(() => 0),
      sequential.createReplyDraft(draftCommand()).catch(() => 0),
    ]);
    assert.equal(max, 1);
  }
  console.log('  PASS  single-flight refresh');

  const parsed = parseArgs(['preflight']);
  assert.equal(parsed.command, 'preflight');
  assert.equal(parsed.apply, false);
  const prod = runOfflineSimulation({ parsed, env: { LUNA_DEPLOYMENT: 'production' } });
  assert.equal(prod.ok, false);
  assert.equal(prod.reason, 'production_or_wolfhouse_refused');
  const live = runOfflineSimulation({
    parsed: parseArgs(['preflight', '--target', 'live']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
  });
  assert.equal(live.ok, false);
  assert.equal(live.reason, 'live_mode_structurally_absent_until_reviewed_sha');
  const hostile = parseArgs(['preflight', '--wat']);
  assert.equal(hostile.invalid, true);
  const duplicate = parseArgs(['--target', 'fake', '--target', 'stock-pg']);
  assert.equal(duplicate.invalid, true);
  const eqLive = parseArgs(['--target=live']);
  assert.equal(eqLive.invalid, true);
  const pf = runOfflineSimulation({
    parsed,
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState(),
  });
  assert.equal(pf.ok, true);
  assert.equal(pf.token_returned, false);
  assert.equal(pf.simulation, true);
  assert.equal(pf.live_evidence, false);
  assert.equal(pf.configured_contract_only, true);
  assert.equal(Object.hasOwn(pf, 'graph_called'), false);
  assert.equal(Object.hasOwn(pf, 'consumed_098'), false);
  const plan = runOfflineSimulation({
    parsed: parseArgs(['plan-activation']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.combined_irreversible, false);
  assert.deepEqual([...plan.order], [...ACTIVATION_ORDER]);
  const mismatch = runOfflineSimulation({
    parsed: parseArgs([
      'enable-live-provider',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'other@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ replica: 1 }),
  });
  assert.equal(mismatch.reason, 'recipient_mismatch');
  const missing098 = runOfflineSimulation({
    parsed: parseArgs([
      'enable-live-provider', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({
      flags: {
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
      },
      authorizationPresent: false,
    }),
  });
  assert.equal(missing098.reason, 'missing_098');
  const replica = runOfflineSimulation({
    parsed: parseArgs(['enable-runtime', '--apply']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ replica: 2 }),
  });
  assert.equal(replica.reason, 'replica_not_1');
  const stale = runOfflineSimulation({
    parsed: parseArgs(['enable-runtime', '--apply']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    expectedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(stale.reason, 'stale_revision');
  const journal = runOfflineSimulation({
    parsed: parseArgs([
      'capture-evidence', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ journalUnchanged: false, authorizationPresent: true }),
  });
  assert.equal(journal.reason, 'journal_changed');
  const notDraft = runOfflineSimulation({
    parsed: parseArgs([
      'capture-evidence', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({
      wouldRequireProviderIsDraft: false,
      authorizationPresent: true,
    }),
  });
  assert.equal(notDraft.reason, 'provider_is_draft_false');
  const guest = runOfflineSimulation({
    parsed: parseArgs([
      'prepare-authorization', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ guestWithoutMarker: true, authorizationPresent: false }),
  });
  assert.equal(guest.reason, 'guest_row_without_098_marker');
  const applied = runOfflineSimulation({
    parsed: parseArgs([
      'enable-live-provider', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({
      flags: {
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
      },
      authorizationPresent: true,
    }),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.simulated_transition, true);
  assert.equal(applied.would_consume_098, true);
  assert.equal(applied.would_require_provider_is_draft, true);
  assert.equal(applied.live_evidence, false);
  assert.equal(Object.hasOwn(applied, 'consumed_098'), false);
  assert.equal(Object.hasOwn(applied, 'provider_is_draft'), false);
  assert.equal(runOneShotLiveProof({ parsed, env: { LUNA_DEPLOYMENT: 'sunset-staging' } }).simulation, true);
  assert.equal(refusedProduction({ DEFAULT_CLIENT_SLUG: 'wolfhouse' }), true);
  assert.equal(COMMANDS.includes('preflight'), true);
  console.log('  PASS  M4 offline simulation: no live-looking fields; unknown/duplicate/hostile args fail');

  const dummyLoaner = async (work) => work({ async query() { return { rows: [] }; } });
  assert.throws(
    () => createEmailLunaControlledDraftingSunsetStagingRuntimeActivation({
      env: {
        LUNA_DEPLOYMENT: 'sunset-staging',
        DEFAULT_CLIENT_SLUG: 'sunset',
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
        EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT: '1',
        EMAIL_LUNA_CONTROLLED_DRAFTING_CLIENT_ID: CLIENT,
        EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_ID: LOCATION,
        EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY: 'sunset-somo',
        EMAIL_LUNA_CONTROLLED_DRAFTING_ENDPOINT_ID: ENDPOINT,
        EMAIL_LUNA_CONTROLLED_DRAFTING_MAILBOX_ID: MAILBOX,
        EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER: 'microsoft_graph',
        EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_DATABASE_URL: 'postgres://luna_cd_producer:x@127.0.0.1:5432/sunset_staging',
        EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_DATABASE_URL: 'postgres://luna_cd_worker:y@127.0.0.1:5432/sunset_staging',
        WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:z@127.0.0.1:5432/sunset_staging',
        [ENV_LIVE_PROVIDER_DRAFT_ENABLED]: 'true',
      },
      producerWithTransactionClient: dummyLoaner,
      workerWithTransactionClient: dummyLoaner,
      timers: { setTimeout() { return 1; }, clearTimeout() {} },
      intervalMs: 60000,
    }),
    (error) => error && (error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_DISABLED'
      || error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ACTIVATION_INVALID'),
  );
  console.log('  PASS  live flag without closed graph provider refuses');

  console.log('  … Chapter 4A (includes Chapters 1–3, Staff API smoke, stock-PG)');
  runChild('verify-email-luna-controlled-drafting-staging-activation.js');
  runChild('verify-email-microsoft-refresh-token-request.js');
  runChild('verify-email-microsoft-refresh-token-response-by-scope-version.js');
  runChild('verify-staff-query-api-startup-smoke.js');
  runChild('prove-email-luna-controlled-drafting-token-loan-offline-simulation.js');
  const stockPg = spawnSync(process.execPath, [
    path.join(__dirname, 'prove-email-luna-controlled-drafting-token-loan-stock-pg.js'),
  ], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (stockPg.stdout) process.stdout.write(stockPg.stdout);
  if (stockPg.stderr) process.stderr.write(stockPg.stderr);
  assert.equal(stockPg.status, 0, 'prove-email-luna-controlled-drafting-token-loan-stock-pg.js');
  assert.match(stockPg.stdout, /not a PostgreSQL proof/);
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (diffCheck.stdout) process.stdout.write(diffCheck.stdout);
  if (diffCheck.stderr) process.stderr.write(diffCheck.stderr);
  assert.equal(diffCheck.status, 0, 'git diff --check must stay green');
  console.log('ALL OK — Stage 2 Chapter 4C Graph-bound token assembly and offline simulation');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
