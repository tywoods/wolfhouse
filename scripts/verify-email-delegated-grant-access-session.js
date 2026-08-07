'use strict';

/**
 * Hostile-path gate for delegated grant access-session (callback-scoped one-shot).
 *
 * Proves lease → open → MS refresh → refresh-token selection → AAD → reseal →
 * envelope validate → confirmed CAS, then exactly-once callback with mutable
 * loan. Pre-CAS / CAS conflict / zero-row paths never invoke the callback.
 * Scrubs loan.accessToken + local owners; planted secrets never leak.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  createDelegatedGrantAccessSession,
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  DEPENDENCY_KEYS,
  SERVICE_KEYS,
  INPUT_KEYS,
  LOAN_KEYS,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
  EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED,
} = require('./lib/email-delegated-grant-access-session');

const ROOT = path.join(__dirname, '..');
const MOD_REL = 'scripts/lib/email-delegated-grant-access-session.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const WORKER = 'sunset-email-access-session-test';
const OLD_RT = 'rt-old-NEVER_LEAK';
const NEW_RT = 'rt-new-NEVER_LEAK';
const ACCESS = 'at-NEVER_LEAK-access';
const SECRET = 'app-secret-NEVER_LEAK';
const PLANTED = 'planted-NEVER_LEAK-secret';

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(OLD_RT)
    && !text.includes(NEW_RT)
    && !text.includes(ACCESS)
    && !text.includes(SECRET)
    && !text.includes(PLANTED)
    && !text.includes('refresh_token')
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

function successTransport(bodyPatch = {}) {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: ACCESS,
      refresh_token: NEW_RT,
      scope: 'openid profile User.Read Mail.ReadBasic',
      ...bodyPatch,
    }),
  }));
}

function omitRefreshTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: ACCESS,
      scope: 'openid profile User.Read Mail.ReadBasic',
    }),
  }));
}

function emptyRefreshTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: ACCESS,
      refresh_token: '',
      scope: 'openid profile User.Read Mail.ReadBasic',
    }),
  }));
}

function invalidGrantTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 400,
    contentType: 'application/json',
    body: JSON.stringify({
      error: 'invalid_grant',
      error_description: PLANTED,
    }),
  }));
}

function uncertainTransport() {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 503,
    contentType: 'text/plain',
    body: PLANTED,
  }));
}

function mockGrantLifecycle({ sealed, opId, onCommit, failCommit, priorStatus, noGrant }) {
  let leaseTok = null;
  const prior = priorStatus || {
    client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
    grant_lease_token: null,
  };
  return createMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t),
      run: () => (noGrant ? empty() : rows(prior)),
    },
    {
      match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null, grant_lease_until: null,
        last_operation_id: opId,
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
        leaseTok = p[3];
        return rows({
          client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: 1, grant_status: 'lease_held',
          grant_lease_token: leaseTok,
          grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: opId,
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
        });
      },
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'lease_held',
        reconcile_state: 'ms_response_uncertain',
      }),
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t),
      run: () => rows({
        client_id: CLIENT, endpoint_id: ENDPOINT,
        grant_generation: 1, grant_status: 'active',
        reconcile_state: 'ms_response_uncertain',
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

function wrapSealSpy(provider) {
  const sealedTokens = [];
  return {
    provider: Object.freeze({
      sealGrantPayload: async (input) => {
        sealedTokens.push(input && input.refresh_token);
        return provider.sealGrantPayload(input);
      },
      openGrantPayload: (...a) => provider.openGrantPayload(...a),
      rewrapGrantDek: (...a) => provider.rewrapGrantDek(...a),
    }),
    sealedTokens,
  };
}

function baseDeps(overrides = {}) {
  return Object.freeze({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: APP_ID,
    client: overrides.client,
    envelopeProvider: overrides.envelopeProvider,
    secretProvider: overrides.secretProvider
      || frozenMethod('getClientSecret', async () => SECRET),
    transport: overrides.transport || successTransport(),
    workerId: overrides.workerId || WORKER,
  });
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    // ── static surface ────────────────────────────────────────────────
    assert.equal(EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED, false);
    assert.deepEqual([...DEPENDENCY_KEYS], [
      'deployment', 'applicationClientId', 'client', 'envelopeProvider',
      'secretProvider', 'transport', 'workerId',
    ]);
    assert.deepEqual([...SERVICE_KEYS], ['runWithAccessTokenOnce']);
    assert.deepEqual([...INPUT_KEYS], ['clientId', 'endpointId']);
    assert.deepEqual([...LOAN_KEYS], ['accessToken']);
    assert.equal(STATUS_REAUTH, 'reauthorization_required');
    assert.equal(STATUS_UNCERTAIN, 'uncertain');
    assert.equal(STATUS_UNAVAILABLE, 'unavailable');

    const src = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
    assert.match(src, /runWithAccessTokenOnce/);
    assert.match(src, /tryAcquireDelegatedGrantLease/);
    assert.match(src, /commitDelegatedGrantRotation/);
    assert.match(src, /markDelegatedGrantReauthorizationRequired/);
    assert.match(src, /markDelegatedGrantReconciliation/);
    assert.match(src, /abortDelegatedGrantLease/);
    // Never a generic token-return API / obtain-once export.
    assert.doesNotMatch(src, /obtainAccessTokenOnce/);
    assert.doesNotMatch(src, /getAccessToken\b/);
    assert.doesNotMatch(src, /return\s*\{\s*accessToken/);

    // Lifetime: nullable token-owner lets released by reference nulling in outer
    // finally. Opened result is a let owner; sealed/selected/refresh/access too.
    // accessCandidate is also a nullable outer owner (never a long-lived const
    // token alias); assign only when needed, null in inner + outer finally.
    // Do not claim immutable JS strings are overwritten — only references released.
    assert.match(src, /let\s+openedOwner\s*=\s*null/);
    assert.match(src, /let\s+accessCandidate\s*=\s*null/);
    assert.match(src, /let\s+accessTokenOwner\s*=\s*null/);
    assert.match(src, /let\s+refreshToken\s*=\s*null/);
    assert.match(src, /let\s+refreshToSeal\s*=\s*null/);
    assert.match(src, /let\s+selectedOwner\s*=\s*null/);
    assert.match(src, /let\s+sealedOwner\s*=\s*null/);
    assert.match(src, /let\s+classified\s*=\s*null/);
    assert.match(src, /openedOwner\s*=\s*null/);
    assert.match(src, /sealedOwner\s*=\s*null/);
    assert.match(src, /selectedOwner\s*=\s*null/);
    assert.match(src, /accessCandidate\s*=\s*null/);
    assert.match(src, /accessTokenOwner\s*=\s*null/);
    // No immutable long-lived token alias for the selected access token.
    assert.doesNotMatch(src, /const\s+accessCandidate\b/);
    // Outer finally must release opened + sealed + accessCandidate owners
    // (not only mid-path). accessCandidate nulling is before/with accessTokenOwner.
    {
      const finallyIdx = src.lastIndexOf('} finally {');
      assert.ok(finallyIdx > 0, 'outer finally present');
      const finallyBody = src.slice(finallyIdx, finallyIdx + 900);
      assert.match(finallyBody, /openedOwner\s*=\s*null/);
      assert.match(finallyBody, /sealedOwner\s*=\s*null/);
      assert.match(finallyBody, /selectedOwner\s*=\s*null/);
      assert.match(finallyBody, /accessCandidate\s*=\s*null/);
      assert.match(finallyBody, /accessTokenOwner\s*=\s*null/);
      assert.match(finallyBody, /refreshToken\s*=\s*null/);
      assert.match(finallyBody, /refreshToSeal\s*=\s*null/);
      assert.match(finallyBody, /classified\s*=\s*null/);
      // accessCandidate released before or with accessTokenOwner in outer finally.
      const acIdx = finallyBody.search(/accessCandidate\s*=\s*null/);
      const atoIdx = finallyBody.search(/accessTokenOwner\s*=\s*null/);
      assert.ok(acIdx >= 0 && atoIdx >= 0 && acIdx <= atoIdx,
        'outer finally nulls accessCandidate before/with accessTokenOwner');
    }
    // Inner selection finally must also null accessCandidate (async paths may
    // await after mid-path release of accessTokenOwner).
    {
      const selectFinallyRe =
        /} finally \{\s*classified\s*=\s*null;\s*selectedOwner\s*=\s*null;\s*accessCandidate\s*=\s*null;/;
      assert.match(src, selectFinallyRe);
    }
    // No string-mutation / zero-fill patterns (reference nulling only).
    assert.doesNotMatch(src, /zero[\s-]?fill|fill\(0\)|\.fill\(|string\.length\s*=\s*0|Buffer\.from\([^)]*\)\.fill/i);

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    assert.equal(
      pkg.scripts['verify:email-delegated-grant-access-session'],
      'node scripts/verify-email-delegated-grant-access-session.js',
    );

    assert.throws(
      () => createDelegatedGrantAccessSession(null),
      (e) => e && e.code === FAILURE_CODE && noLeak(e),
    );

    // ── happy path: CAS then callback once with access token ──────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      let seenToken = null;
      let retainedLoan = null;
      const service = createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
      }));
      const out = await service.runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async (loan) => {
          cbCalls += 1;
          retainedLoan = loan;
          seenToken = loan.accessToken;
          assert.equal(Object.isFrozen(loan), false, 'loan must stay mutable for scrub');
          assert.deepEqual(Object.keys(loan), ['accessToken']);
          return Object.freeze({ consumed: true, n: 7 });
        },
      );
      assert.equal(out.ok, true);
      assert.equal(out.grant_generation, 2);
      assert.deepEqual(out.value, { consumed: true, n: 7 });
      assert.equal(cbCalls, 1);
      assert.equal(seenToken, ACCESS);
      assert.ok(retainedLoan);
      assert.equal(retainedLoan.accessToken, null, 'retained loan scrubbed in finally');
      assert.equal(noLeak(out), true);
      assert.deepEqual(Reflect.ownKeys(out), ['ok', 'grant_generation', 'value']);
      // one-shot
      await assert.rejects(
        () => service.runWithAccessTokenOnce(
          Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
          async () => ({ x: 1 }),
        ),
        (e) => e && e.code === FAILURE_CODE,
      );
      assert.equal(cbCalls, 1, 'second use must not invoke callback');
    }

    // ── omitted refresh_token reseals opened prior + CAS + callback ───
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fake);
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: spy.provider,
        transport: omitRefreshTransport(),
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async (loan) => {
          cbCalls += 1;
          assert.equal(loan.accessToken, ACCESS);
          return 'omit-ok';
        },
      );
      assert.equal(out.ok, true);
      assert.equal(out.value, 'omit-ok');
      assert.equal(cbCalls, 1);
      assert.equal(spy.sealedTokens.length, 1);
      assert.equal(spy.sealedTokens[0], OLD_RT, 'omission must reseal opened prior token');
      assert.equal(noLeak(out), true);
    }

    // ── new refresh_token reseals rotation token ──────────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fake);
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: spy.provider,
        transport: successTransport(),
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'rot-ok';
        },
      );
      assert.equal(out.ok, true);
      assert.equal(cbCalls, 1);
      assert.equal(spy.sealedTokens[0], NEW_RT);
      assert.notEqual(spy.sealedTokens[0], OLD_RT);
      assert.equal(noLeak(out), true);
    }

    // ── empty present refresh_token → uncertain, zero callback ────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const spy = wrapSealSpy(fake);
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: spy.provider,
        transport: emptyRefreshTransport(),
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'should-not-run';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_UNCERTAIN);
      assert.equal(cbCalls, 0);
      assert.equal(spy.sealedTokens.length, 0);
      assert.equal(noLeak(out), true);
    }

    // ── CAS conflict / zero row → uncertain, zero callback ────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op, failCommit: true }),
        envelopeProvider: fake,
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_UNCERTAIN);
      assert.equal(out.grant_generation, 1);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── invalid_grant → reauth, zero callback ─────────────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
        transport: invalidGrantTransport(),
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_REAUTH);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── MS transport uncertain → reconcile/abort path, zero callback ──
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
        transport: uncertainTransport(),
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_UNCERTAIN);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── no grant present → unavailable, zero callback ─────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op, noGrant: true }),
        envelopeProvider: fake,
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_UNAVAILABLE);
      assert.equal(out.grant_generation, null);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── prior reauth status → reauth early, zero callback ─────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let cbCalls = 0;
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({
          sealed,
          opId: op,
          priorStatus: {
            client_id: CLIENT, endpoint_id: ENDPOINT,
            grant_generation: 3, grant_status: 'reauthorization_required',
            reconcile_state: 'needs_operator', grant_lease_token: null,
          },
        }),
        envelopeProvider: fake,
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_REAUTH);
      assert.equal(out.grant_generation, 3);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── seal failure → uncertain, zero callback, no CAS ───────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let commitSeen = false;
      let cbCalls = 0;
      const failingProvider = Object.freeze({
        sealGrantPayload: async () => { throw new Error(PLANTED); },
        openGrantPayload: (...a) => fake.openGrantPayload(...a),
        rewrapGrantDek: (...a) => fake.rewrapGrantDek(...a),
      });
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({
          sealed, opId: op, onCommit: () => { commitSeen = true; },
        }),
        envelopeProvider: failingProvider,
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async () => {
          cbCalls += 1;
          return 'nope';
        },
      );
      assert.equal(out.ok, false);
      assert.equal(out.status, STATUS_UNCERTAIN);
      assert.equal(commitSeen, false);
      assert.equal(cbCalls, 0);
      assert.equal(noLeak(out), true);
    }

    // ── consumer throw → scrub loan, sanitize error (no planted leak) ─
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let retainedLoan = null;
      let cbCalls = 0;
      const service = createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
      }));
      await assert.rejects(
        () => service.runWithAccessTokenOnce(
          Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
          async (loan) => {
            cbCalls += 1;
            retainedLoan = loan;
            throw new Error(PLANTED);
          },
        ),
        (e) => e && e.code === FAILURE_CODE && noLeak(e),
      );
      assert.equal(cbCalls, 1, 'callback ran after CAS before throw');
      assert.ok(retainedLoan);
      assert.equal(retainedLoan.accessToken, null, 'throw path scrubs loan');
    }

    // ── consumer reject (async) → scrub + sanitized ───────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let retainedLoan = null;
      const service = createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
      }));
      await assert.rejects(
        () => service.runWithAccessTokenOnce(
          Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
          async (loan) => {
            retainedLoan = loan;
            return Promise.reject(new Error(PLANTED));
          },
        ),
        (e) => e && e.code === FAILURE_CODE && noLeak(e),
      );
      assert.equal(retainedLoan.accessToken, null);
    }

    // ── non-function consumer → throw, zero lease ─────────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      let queries = 0;
      const client = mockGrantLifecycle({ sealed, opId: op });
      const orig = client.query.bind(client);
      client.query = async (...a) => {
        queries += 1;
        return orig(...a);
      };
      const service = createDelegatedGrantAccessSession(baseDeps({
        client,
        envelopeProvider: fake,
      }));
      await assert.rejects(
        () => service.runWithAccessTokenOnce(
          Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
          null,
        ),
        (e) => e && e.code === FAILURE_CODE && noLeak(e),
      );
      assert.equal(queries, 0, 'malformed consumer must not touch DB');
    }

    // ── service result never contains token material ──────────────────
    {
      const fake = createFakeEmailGrantEnvelopeProvider();
      const op = crypto.randomUUID();
      const sealed = await fakeSealRefreshToken(fake, {
        refreshToken: OLD_RT, clientId: CLIENT, endpointId: ENDPOINT,
        grantGeneration: 1, operationId: op,
      });
      const out = await createDelegatedGrantAccessSession(baseDeps({
        client: mockGrantLifecycle({ sealed, opId: op }),
        envelopeProvider: fake,
      })).runWithAccessTokenOnce(
        Object.freeze({ clientId: CLIENT, endpointId: ENDPOINT }),
        async (loan) => {
          // Callback may see token transiently; return value must not echo it.
          assert.equal(typeof loan.accessToken, 'string');
          return Object.freeze({ status: 'ok' });
        },
      );
      assert.equal(noLeak(out), true);
      assert.equal(JSON.stringify(out).includes(ACCESS), false);
    }

    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-delegated-grant-access-session: ok');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
