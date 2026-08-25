'use strict';

/**
 * Hostile-path gate for Microsoft refresh_token request form + classification.
 */

const assert = require('node:assert/strict');
const { REQUEST_LIMIT_BYTES } = require('./lib/email-microsoft-token-http-transport');
const {
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  createMicrosoftRefreshTokenRequestService,
  REFRESH_TOKEN_REQUEST_INTERNAL_STAGES,
  readTrustedMicrosoftRefreshTokenRequestStage,
} = require('./lib/email-microsoft-refresh-token-request');

const CLIENT_ID = '12345678-1234-4234-8234-123456789abc';
const REFRESH = 'rt+/%?=&NEVER_LEAK';
const SECRET = 'secret+/%?=&NEVER_LEAK';
const PLANTED_AT = 'at-NEVER_LEAK';

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }
function deps(provider, transport, patch = {}) {
  return {
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: CLIENT_ID,
    secretProvider: provider,
    transport,
    ...patch,
  };
}
function input(patch = {}) {
  return { refreshToken: REFRESH, scopeVersion: 'phase_a_v2', ...patch };
}
function successResponse() {
  return Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: PLANTED_AT,
      refresh_token: 'rt-rotated-NEVER_LEAK',
      scope: 'openid profile User.Read Mail.ReadWrite Mail.Send',
    }),
  });
}

async function mustFail(action) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE
    && error.message === FAILURE_CODE
    && !String(error).includes('NEVER_LEAK')
    && !JSON.stringify(error).includes('NEVER_LEAK'));
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    let captured;
    const provider = { getClientSecret: async function getClientSecret() { return SECRET; } };
    const transport = frozenMethod('postTokenForm', async function postTokenForm(arg) {
      captured = arg;
      return successResponse();
    });
    const result = await createMicrosoftRefreshTokenRequestService(deps(provider, transport))
      .exchangeRefreshToken(input());
    assert.equal(result.kind, 'success');
    assert.equal(result.selected.refreshToken, 'rt-rotated-NEVER_LEAK');
    assert.equal(result.selected.refreshTokenOmitted, false);
    assert.deepEqual(Reflect.ownKeys(captured), ['body']);
    assert.deepEqual([...new URLSearchParams(captured.body)], [
      ['client_id', CLIENT_ID],
      ['client_secret', SECRET],
      ['grant_type', 'refresh_token'],
      ['refresh_token', REFRESH],
    ]);
    assert.equal(new URLSearchParams(captured.body).has('scope'), false);
    assert.equal(new URLSearchParams(captured.body).has('redirect_uri'), false);

    let draftCaptured;
    const draftBody = Object.freeze({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: PLANTED_AT,
        refresh_token: 'rt-rotated-NEVER_LEAK',
        scope: 'openid profile offline_access User.Read Mail.ReadWrite',
      }),
    });
    const draft = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async function postTokenForm(arg) {
        draftCaptured = arg;
        return draftBody;
      }),
    )).exchangeRefreshToken(input({ scopeVersion: 'controlled_drafting_v1' }));
    assert.equal(draft.kind, 'success');
    assert.equal(draft.selected.scope.includes('Mail.ReadWrite'), true);
    assert.equal(draft.selected.scope.includes('Mail.Send'), false);
    assert.equal(new URLSearchParams(draftCaptured.body).get('scope'),
      'openid profile offline_access User.Read Mail.ReadWrite');
    const broader = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: PLANTED_AT,
          refresh_token: 'rt-rotated-NEVER_LEAK',
          scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
        }),
      })),
    )).exchangeRefreshToken(input({ scopeVersion: 'controlled_drafting_v1' }));
    assert.equal(broader.kind, 'uncertain');

    // Phase B scope_version + Phase B MS body → success (phase-aware owner).
    const phaseBBody = Object.freeze({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token_type: 'Bearer',
        expires_in: 3600,
        access_token: PLANTED_AT,
        refresh_token: 'rt-rotated-NEVER_LEAK',
        scope: 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send',
      }),
    });
    const phaseB = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => phaseBBody),
    )).exchangeRefreshToken(input({ scopeVersion: 'phase_b_v1' }));
    assert.equal(phaseB.kind, 'success');
    assert.equal(phaseB.selected.scope.includes('Mail.ReadWrite'), true);

    // Phase A scope_version + legacy ReadBasic body stays uncertain.
    const cross = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: PLANTED_AT,
          refresh_token: 'rt-rotated-NEVER_LEAK',
          scope: 'openid profile User.Read Mail.ReadBasic',
        }),
      })),
    )).exchangeRefreshToken(input({ scopeVersion: 'phase_a_v2' }));
    assert.equal(cross.kind, 'uncertain');

    const invalid = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'NEVER_LEAK_desc',
        }),
      })),
    )).exchangeRefreshToken(input());
    assert.equal(invalid.kind, 'invalid_grant');
    assert.equal(JSON.stringify(invalid).includes('NEVER_LEAK'), false);

    const uncertain = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporarily_unavailable', error_description: 'NEVER_LEAK' }),
      })),
    )).exchangeRefreshToken(input());
    assert.equal(uncertain.kind, 'uncertain');
    assert.equal(JSON.stringify(uncertain).includes('NEVER_LEAK'), false);

    for (const bad of [
      null, [], {}, { ...input(), extra: true }, Object.create(null),
      { refreshToken: '' }, { refreshToken: 'bad\n' },
      // Missing scopeVersion (legacy shape) must not exchange.
      { refreshToken: REFRESH },
      // Non-string / oversized scopeVersion is input-invalid.
      { refreshToken: REFRESH, scopeVersion: 7 },
      { refreshToken: REFRESH, scopeVersion: 'x'.repeat(33) },
    ]) {
      await mustFail(() => createMicrosoftRefreshTokenRequestService(deps(
        frozenMethod('getClientSecret', async () => SECRET),
        frozenMethod('postTokenForm', async () => successResponse()),
      )).exchangeRefreshToken(bad));
    }

    // Unknown scopeVersion is accepted as input but classifies uncertain.
    const unknownVer = await createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => successResponse()),
    )).exchangeRefreshToken(input({ scopeVersion: 'phase_b_v2' }));
    assert.equal(unknownVer.kind, 'uncertain');

    for (const hostile of [
      null, {}, deps(provider, transport, { deployment: 'production' }),
      deps(provider, { postTokenForm: async () => successResponse() }),
    ]) {
      assert.throws(
        () => createMicrosoftRefreshTokenRequestService(hostile),
        (e) => e.code === FAILURE_CODE && !String(e).includes('NEVER_LEAK'),
      );
    }

    const single = createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => successResponse()),
    ));
    await single.exchangeRefreshToken(input());
    await mustFail(() => single.exchangeRefreshToken(input()));

    assert.ok(REQUEST_LIMIT_BYTES > 0);
    assert.deepEqual([...REFRESH_TOKEN_REQUEST_INTERNAL_STAGES], ['secret', 'token', 'response']);
    assert.equal(typeof readTrustedMicrosoftRefreshTokenRequestStage, 'function');
    assert.equal(
      readTrustedMicrosoftRefreshTokenRequestStage(Object.freeze({
        code: FAILURE_CODE,
        stage: 'secret',
        message: 'NEVER_LEAK',
      })),
      null,
    );

    async function mustFailAt(action, stage) {
      let thrown = null;
      try {
        await action();
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown);
      assert.equal(thrown.code, FAILURE_CODE);
      assert.equal(thrown.message, FAILURE_CODE);
      assert.equal(String(thrown).includes('NEVER_LEAK'), false);
      const note = readTrustedMicrosoftRefreshTokenRequestStage(thrown);
      assert.ok(note);
      assert.equal(note.stage, stage);
      assert.equal(note.code, stage);
      assert.deepEqual(Reflect.ownKeys(note), ['stage', 'code']);
      assert.equal(Object.isFrozen(note), true);
    }

    await mustFailAt(() => createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => { throw new Error('NEVER_LEAK'); }),
      frozenMethod('postTokenForm', async () => successResponse()),
    )).exchangeRefreshToken(input()), 'secret');

    await mustFailAt(() => createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => ''),
      frozenMethod('postTokenForm', async () => successResponse()),
    )).exchangeRefreshToken(input()), 'secret');

    await mustFailAt(() => createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => { throw new Error('NEVER_LEAK'); }),
    )).exchangeRefreshToken(input()), 'token');

    await mustFailAt(() => createMicrosoftRefreshTokenRequestService(deps(
      frozenMethod('getClientSecret', async () => SECRET),
      frozenMethod('postTokenForm', async () => successResponse()),
    )).exchangeRefreshToken({ refreshToken: '', scopeVersion: 'phase_a_v2' }), 'token');

    assert.deepEqual(
      logged.filter((entry) => !String(entry).includes('NO_COLOR')),
      [],
    );
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-microsoft-refresh-token-request: ok');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
