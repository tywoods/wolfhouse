'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C: closed draft-only token loan
 * and one-shot live-proof harness. Offline fakes only. No live Graph/OAuth.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createEmailLunaControlledDraftingTokenLoan,
  createEmailLunaControlledDraftingFakeClosedTokenLoan,
  isClosedControlledDraftingTokenLoan,
  bindControlledDraftingTokenLoanKillSwitch,
  readTrustedControlledDraftingTokenLoanFailure,
  ERROR_CODE,
  SUNSET_DEPLOYMENT,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  SERVICE_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED,
} = require('./lib/email-luna-controlled-drafting-token-loan');
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
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  CONTROLLED_DRAFTING_REQUEST_SCOPE,
} = require('./lib/email-microsoft-refresh-token-request');
const {
  parseArgs,
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

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENDPOINT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MAILBOX = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const TID = '01234567-89ab-4def-8123-456789abcdef';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';
const NOW = 1_900_000_000;
const DRAFT_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite';
const SEND_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';

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

function jwt(header, claims, signature = Buffer.from([0, 1, 2, 254, 255])) {
  return `${b64(header)}.${b64(claims)}.${Buffer.from(signature).toString('base64url')}`;
}

function baseClaims(patch = {}) {
  return {
    tid: TID,
    oid: MAILBOX,
    aud: '00000003-0000-0000-c000-000000000000',
    iss: `https://login.microsoftonline.com/${TID}/v2.0`,
    azp: APP_ID,
    scp: 'User.Read Mail.ReadWrite',
    exp: NOW + 600,
    iat: NOW - 10,
    nbf: NOW - 10,
    ...patch,
  };
}

function goodJwt(patch) {
  return jwt({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }, baseClaims(patch));
}

function liveJwt(patch) {
  const now = Math.floor(Date.now() / 1000);
  return jwt({ alg: 'RS256', kid: 'key-1', typ: 'JWT' }, baseClaims({
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    ...patch,
  }));
}

function verifier(spec = {}) {
  return Object.freeze({
    async verify(request) {
      if (spec.throw) throw new Error(`${PLANTED} verifier`);
      if (spec.ack !== undefined) return spec.ack;
      return Object.seal({ verified: true });
    },
  });
}

function inspector(spec) {
  return createControlledDraftingAccessTokenClaimsInspector({
    signatureVerifier: verifier(spec),
  });
}

function inspectInput(token = goodJwt(), patch = {}) {
  return {
    accessToken: token,
    expectedTenantId: TID,
    expectedClientId: APP_ID,
    expectedPrincipalOid: MAILBOX,
    nowEpochSeconds: NOW,
    ...patch,
  };
}

function mockGrantLifecycle({
  sealed, opId, onCommit, failCommit, priorStatus, noGrant, scopeVersion, failLease,
  bindingRow,
}) {
  let leaseTok = null;
  const scopeVer = scopeVersion === undefined ? 'phase_b_v1' : scopeVersion;
  const prior = priorStatus || {
    client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
    grant_lease_token: null,
    scope_version: scopeVer,
  };
  return createMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t)
        && !/tenant_channel_endpoints/i.test(t),
      run: () => (noGrant ? empty() : rows(prior)),
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
        provider_principal_oid: MAILBOX,
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
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
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
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: 1, grant_status: 'lease_held',
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
        grant_generation: 1, grant_status: 'lease_held',
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
        if (failCommit) return empty();
        if (typeof onCommit === 'function') onCommit(Number(p[2]));
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: Number(p[2]), grant_status: 'active',
          reconcile_state: 'clean',
          scope_version: scopeVer,
        });
      },
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        reconcile_state: 'ms_response_uncertain',
        scope_version: scopeVer,
      }),
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active',
        reconcile_state: 'ms_response_uncertain',
        scope_version: scopeVer,
      }),
    },
    {
      match: (t) => /reauthorization_required/i.test(t),
      run: () => rows({ grant_generation: 1, grant_status: 'reauthorization_required' }),
    },
    {
      match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
      run: () => rows({ id: ENDPOINT }),
    },
    { match: () => true, run: () => empty() },
  ]);
}

function successTransport(accessToken, scope = DRAFT_SCOPE) {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: accessToken,
      refresh_token: NEW_RT,
      scope,
    }),
  }));
}

function loanDeps(overrides = {}) {
  return {
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    withPgClient: overrides.withPgClient,
    envelopeProvider: overrides.envelopeProvider,
    createSecretProvider: overrides.createSecretProvider
      || (() => frozenMethod('getClientSecret', async () => SECRET)),
    transport: overrides.transport,
    workerId: 'email-luna-controlled-drafting-token-loan',
    createSignatureVerifier: overrides.createSignatureVerifier || (() => verifier()),
    binding: {
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      mailboxId: MAILBOX,
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

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C token loan verifier');

  assert.equal(EMAIL_LUNA_CONTROLLED_DRAFTING_TOKEN_LOAN_RUNTIME_WIRED, false);
  assert.equal(SCOPE_PROFILE_ID, 'controlled_drafting_v1');
  assert.equal(REQUESTED_SCOPE, CONTROLLED_DRAFTING_REQUEST_SCOPE);
  assert.equal(REQUESTED_SCOPE.includes('Mail.Send'), false);
  assert.deepEqual([...DEPENDENCY_KEYS], [
    'deployment', 'applicationClientId', 'withPgClient', 'envelopeProvider',
    'createSecretProvider', 'transport', 'workerId', 'createSignatureVerifier', 'binding',
  ]);
  assert.deepEqual([...BINDING_KEYS], ['clientId', 'locationId', 'endpointId', 'mailboxId']);
  assert.deepEqual([...SERVICE_KEYS], ['attest', 'runClosed']);
  assert.deepEqual([...REQUIRED_SCP], ['User.Read', 'Mail.ReadWrite']);
  assert.ok(GRAPH_AUDIENCES.includes('00000003-0000-0000-c000-000000000000'));
  assert.equal(LIVE_DEPLOY_SHA_ALLOWLIST.length, 0);
  assert.equal(PKG.scripts['verify:email-luna-controlled-drafting-token-loan'],
    'node scripts/verify-email-luna-controlled-drafting-token-loan.js');

  assert.match(LOAN_SRC, /controlled_drafting_v1/);
  assert.match(LOAN_SRC, /tryAcquireDelegatedGrantLease/);
  assert.doesNotMatch(LOAN_SRC, /getAccessToken\b/);
  assert.doesNotMatch(LOAN_SRC, /sendMail|sendDraft/);
  assert.match(REFRESH_SRC, /CONTROLLED_DRAFTING_REQUEST_SCOPE/);
  assert.match(GRAPH_SRC, /tokenLoan/);
  assert.doesNotMatch(GRAPH_SRC, /getAccessToken/);
  assert.doesNotMatch(GRAPH_SRC, /\/send/);
  assert.match(STAFF_API_SRC, /createEmailLunaControlledDraftingSunsetStagingLiveTokenLoan/);
  assert.match(STAFF_API_SRC, /process\.env\[ENV_LIVE_PROVIDER_DRAFT_ENABLED\] === 'true'/);
  assert.doesNotMatch(LIVE_SRC, /createMicrosoftGraphReplyDraftTransport/);
  assert.doesNotMatch(LIVE_SRC, /sendDraft|sendMail/);
  assert.match(HARNESS_SRC, /live_mode_structurally_absent_until_reviewed_sha/);
  assert.match(HARNESS_SRC, /server_synthetic_evidence/);
  assert.match(DOC_SRC, /Mail\.ReadWrite/);
  assert.match(DOC_SRC, /does \*\*not\*\* include permission to send/);
  console.log('  PASS  static surface; no generic token callback; no send paths');

  assert.throws(
    () => createEmailLunaControlledDraftingGraphDraftTransport({
      httpsImpl() {},
      getAccessToken: () => PLANTED,
    }),
    (error) => error && error.code === 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID',
  );
  console.log('  PASS  RED missing closed loan / getAccessToken refused');

  const fake = createEmailLunaControlledDraftingFakeClosedTokenLoan({ accessToken: 'tok' });
  assert.equal(isClosedControlledDraftingTokenLoan(fake), true);
  const att = fake.attest();
  assert.equal(att.ok, true);
  assert.equal(att.send_capable, false);
  assert.equal(att.mail_send, false);
  assert.equal(JSON.stringify(att).includes('tok'), false);
  let seen = null;
  await fake.runClosed(async (loan) => { seen = loan.accessToken; });
  assert.equal(seen, 'tok');

  const missing = createEmailLunaControlledDraftingFakeClosedTokenLoan({ failRun: true });
  await assert.rejects(
    () => missing.runClosed(async () => {}),
    (error) => readTrustedControlledDraftingTokenLoanFailure(error)
      && noLeak(error),
  );
  console.log('  PASS  fake closed loan attest/runClosed; failure branded without secrets');

  {
    const good = inspector();
    const result = await good.inspect(inspectInput());
    assert.equal(result.ok, true);
    assert.equal(result.mail_send, false);
    assert.equal(result.scp, 'User.Read Mail.ReadWrite');
    assert.equal(JSON.stringify(result).includes(PLANTED), false);
  }
  await rejectedClaims(inspector().inspect(inspectInput('opaque-token')));
  await rejectedClaims(inspector().inspect(inspectInput(jwt({ alg: 'none', kid: 'k' }, baseClaims()))));
  await rejectedClaims(inspector().inspect(inspectInput(`${goodJwt()}.extra.part`)));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ roles: ['Mail.Send'] }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ aud: APP_ID }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ tid: APP_ID }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ azp: MAILBOX, appid: MAILBOX }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ oid: APP_ID }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ exp: NOW - 1000 }))));
  await rejectedClaims(inspector().inspect(inspectInput(goodJwt({ nbf: NOW + 1000 }))));
  await rejectedClaims(inspector({ ack: Object.seal({ verified: false }) }).inspect(inspectInput()));
  await rejectedClaims(inspector({ throw: true }).inspect(inspectInput()));
  console.log('  PASS  JWT claims: scp Mail.ReadWrite accepted; Mail.Send/roles/aud/tid/azp/oid/exp/nbf/alg none/opaque/unsigned refuse');

  const envelope = createFakeEmailGrantEnvelopeProvider();
  const op = crypto.randomUUID();
  const sealed = await fakeSealRefreshToken(envelope, {
    refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
    grantGeneration: 1, operationId: op,
  });
  const accessJwt = liveJwt();
  let capturedBody;
  const loan = createEmailLunaControlledDraftingTokenLoan(loanDeps({
    withPgClient: async (work) => work(mockGrantLifecycle({ sealed, opId: op })),
    envelopeProvider: envelope,
    transport: frozenMethod('postTokenForm', async (arg) => {
      capturedBody = arg.body;
      return Object.freeze({
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: accessJwt,
          refresh_token: NEW_RT,
          scope: DRAFT_SCOPE,
        }),
      });
    }),
  }));
  const status = loan.attest();
  assert.equal(status.ok, true);
  assert.equal(status.scope_profile_id, SCOPE_PROFILE_ID);
  assert.doesNotMatch(JSON.stringify(status), /NEVER_LEAK|access_token|refresh_token/);
  let consumed = null;
  const value = await loan.runClosed(async (inner) => {
    consumed = inner.accessToken;
    return { used: true };
  });
  assert.equal(value.used, true);
  assert.equal(consumed, accessJwt);
  assert.equal(new URLSearchParams(capturedBody).get('scope'), REQUESTED_SCOPE);
  assert.equal(new URLSearchParams(capturedBody).get('scope').includes('Mail.Send'), false);
  console.log('  PASS  exact downscope requested; closed consumer sees token only inside runClosed');

  {
    const env2 = createFakeEmailGrantEnvelopeProvider();
    const op2 = crypto.randomUUID();
    const sealed2 = await fakeSealRefreshToken(env2, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op2,
    });
    const broader = createEmailLunaControlledDraftingTokenLoan(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed2, opId: op2 })),
      envelopeProvider: env2,
      transport: successTransport(liveJwt(), SEND_SCOPE),
    }));
    await assert.rejects(
      () => broader.runClosed(async () => { throw new Error('graph-must-not-run'); }),
      (error) => readTrustedControlledDraftingTokenLoanFailure(error) && noLeak(error),
    );
  }
  console.log('  PASS  broader Mail.Send token response refuses before Graph');

  {
    const env3 = createFakeEmailGrantEnvelopeProvider();
    const op3 = crypto.randomUUID();
    const sealed3 = await fakeSealRefreshToken(env3, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op3,
    });
    const sendJwt = liveJwt({ scp: 'User.Read Mail.ReadWrite Mail.Send' });
    const claimsFail = createEmailLunaControlledDraftingTokenLoan(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed3, opId: op3 })),
      envelopeProvider: env3,
      transport: successTransport(sendJwt, DRAFT_SCOPE),
    }));
    await assert.rejects(
      () => claimsFail.runClosed(async () => { throw new Error('graph-must-not-run'); }),
      (error) => {
        const note = readTrustedControlledDraftingTokenLoanFailure(error);
        return note && note.stage === 'claims' && noLeak(error);
      },
    );
  }
  console.log('  PASS  response scope clean but JWT scp has Mail.Send → claims refuse, zero Graph');

  {
    const env4 = createFakeEmailGrantEnvelopeProvider();
    const op4 = crypto.randomUUID();
    const sealed4 = await fakeSealRefreshToken(env4, {
      refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
      grantGeneration: 1, operationId: op4,
    });
    const killed = createEmailLunaControlledDraftingTokenLoan(loanDeps({
      withPgClient: async (work) => work(mockGrantLifecycle({ sealed: sealed4, opId: op4 })),
      envelopeProvider: env4,
      transport: successTransport(liveJwt(), DRAFT_SCOPE),
    }));
    bindControlledDraftingTokenLoanKillSwitch(killed, () => true);
    await assert.rejects(
      () => killed.runClosed(async () => { throw new Error('graph-must-not-run'); }),
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
    const sequential = createEmailLunaControlledDraftingTokenLoan(loanDeps({
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
      sequential.runClosed(async () => 1).catch(() => 0),
      sequential.runClosed(async () => 2).catch(() => 0),
    ]);
    assert.equal(max, 1);
  }
  console.log('  PASS  single-flight refresh');

  const parsed = parseArgs(['preflight']);
  assert.equal(parsed.command, 'preflight');
  assert.equal(parsed.apply, false);
  const prod = runOneShotLiveProof({ parsed, env: { LUNA_DEPLOYMENT: 'production' } });
  assert.equal(prod.ok, false);
  assert.equal(prod.reason, 'production_or_wolfhouse_refused');
  const live = runOneShotLiveProof({
    parsed: parseArgs(['preflight', '--target', 'live']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
  });
  assert.equal(live.ok, false);
  assert.equal(live.reason, 'live_mode_structurally_absent_until_reviewed_sha');
  const pf = runOneShotLiveProof({
    parsed,
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState(),
  });
  assert.equal(pf.ok, true);
  assert.equal(pf.token_returned, false);
  assert.equal(pf.server_synthetic_evidence, false);
  const plan = runOneShotLiveProof({
    parsed: parseArgs(['plan-activation']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.combined_irreversible, false);
  assert.deepEqual([...plan.order], [...ACTIVATION_ORDER]);
  const mismatch = runOneShotLiveProof({
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
  const missing098 = runOneShotLiveProof({
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
  const replica = runOneShotLiveProof({
    parsed: parseArgs(['enable-runtime', '--apply']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ replica: 2 }),
  });
  assert.equal(replica.reason, 'replica_not_1');
  const stale = runOneShotLiveProof({
    parsed: parseArgs(['enable-runtime', '--apply']),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ revision: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    expectedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.equal(stale.reason, 'stale_revision');
  const journal = runOneShotLiveProof({
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
  const notDraft = runOneShotLiveProof({
    parsed: parseArgs([
      'capture-evidence', '--apply',
      '--authorization-id', CLIENT,
      '--operation-id', LOCATION,
      '--issuance-id', ENDPOINT,
      '--recipient-address', 'a@b.co',
      '--confirm-recipient', 'a@b.co',
    ]),
    env: { LUNA_DEPLOYMENT: 'sunset-staging' },
    state: createFakeHarnessState({ providerIsDraft: false, authorizationPresent: true }),
  });
  assert.equal(notDraft.reason, 'provider_is_draft_false');
  const guest = runOneShotLiveProof({
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
  assert.equal(refusedProduction({ DEFAULT_CLIENT_SLUG: 'wolfhouse' }), true);
  assert.equal(COMMANDS.includes('preflight'), true);
  console.log('  PASS  one-shot harness: dry-run default, live absent, recipient/098/replica/revision/journal/isDraft/guest refuse');

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
  console.log('  PASS  live flag without closed loan refuses');

  console.log('  … Chapter 4A (includes Chapters 1–3, Staff API smoke, stock-PG)');
  runChild('verify-email-luna-controlled-drafting-staging-activation.js');
  runChild('verify-email-microsoft-refresh-token-request.js');
  runChild('verify-email-microsoft-refresh-token-response-by-scope-version.js');
  runChild('verify-staff-query-api-startup-smoke.js');
  runChild('prove-email-luna-controlled-drafting-token-loan-stock-pg.js');
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (diffCheck.stdout) process.stdout.write(diffCheck.stdout);
  if (diffCheck.stderr) process.stderr.write(diffCheck.stderr);
  assert.equal(diffCheck.status, 0, 'git diff --check must stay green');
  console.log('ALL OK — Stage 2 Chapter 4C token loan and one-shot live-proof source');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
