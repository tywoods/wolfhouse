'use strict';

/**
 * Hostile-path gate for Microsoft refresh-token response classification.
 * Tokens/provider bodies must never appear in thrown errors or return values.
 */

const assert = require('node:assert/strict');
const {
  classifyMicrosoftRefreshTokenResponse,
  FAILURE_CODE,
} = require('./lib/email-microsoft-refresh-token-response');

const PLANTED_RT = 'rt-NEVER_LEAK_planted_refresh';
const PLANTED_AT = 'at-NEVER_LEAK_planted_access';
const PLANTED_ERR = 'error_description_NEVER_LEAK_raw';

function successBody(patch = {}) {
  const base = {
    token_type: 'Bearer',
    expires_in: 3600,
    access_token: PLANTED_AT,
    refresh_token: PLANTED_RT,
    scope: 'User.Read Mail.ReadWrite Mail.Send openid profile',
  };
  return JSON.stringify({ ...base, ...patch });
}

function response(statusCode, body, contentType = 'application/json') {
  return Object.freeze({ statusCode, contentType, body });
}

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(PLANTED_RT)
    && !text.includes(PLANTED_AT)
    && !text.includes(PLANTED_ERR);
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    const ok = classifyMicrosoftRefreshTokenResponse(response(200, successBody()));
    assert.equal(ok.kind, 'success');
    assert.equal(ok.selected.refreshToken, PLANTED_RT);
    assert.equal(ok.selected.refreshTokenOmitted, false);
    assert.equal(ok.selected.accessToken, PLANTED_AT);
    assert.equal(ok.selected.tokenType, 'Bearer');
    assert.equal(ok.selected.scope.includes('User.Read'), true);
    assert.equal(Object.isFrozen(ok), true);
    assert.equal(Object.isFrozen(ok.selected), true);

    // Microsoft may omit refresh_token on success — carry-forward signal only.
    const omittedBody = JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: PLANTED_AT,
      scope: 'User.Read Mail.ReadWrite Mail.Send openid profile',
    });
    const omitted = classifyMicrosoftRefreshTokenResponse(response(200, omittedBody));
    assert.equal(omitted.kind, 'success', 'absent refresh_token must be valid omission');
    assert.equal(omitted.selected.refreshTokenOmitted, true);
    assert.equal(Object.prototype.hasOwnProperty.call(omitted.selected, 'refreshToken'), false);
    // Carry-forward signal must not embed any refresh material (access stays internal-only).
    assert.equal(JSON.stringify(omitted).includes(PLANTED_RT), false);
    assert.equal(JSON.stringify(omitted).includes('refresh_token'), false);

    const withId = classifyMicrosoftRefreshTokenResponse(response(200, successBody({
      id_token: 'x'.repeat(40),
    })));
    assert.equal(withId.kind, 'success');
    assert.equal(withId.selected.idToken, undefined);
    assert.equal(withId.selected.refreshTokenOmitted, false);

    const invalidGrant = classifyMicrosoftRefreshTokenResponse(response(400, JSON.stringify({
      error: 'invalid_grant',
      error_description: PLANTED_ERR,
      error_codes: [70000],
    })));
    assert.equal(invalidGrant.kind, 'invalid_grant');
    assert.equal(invalidGrant.selected, undefined);
    assert.equal(noLeak(invalidGrant), true);

    // Present but empty/malformed/hostile refresh_token → uncertain (never carry-forward).
    const hostilePresentCases = [
      ['empty refresh', response(200, successBody({ refresh_token: '' }))],
      ['null refresh', response(200, JSON.stringify({
        token_type: 'Bearer', expires_in: 3600, access_token: PLANTED_AT,
        refresh_token: null, scope: 'User.Read Mail.ReadWrite',
      }))],
      ['number refresh', response(200, JSON.stringify({
        token_type: 'Bearer', expires_in: 3600, access_token: PLANTED_AT,
        refresh_token: 12345, scope: 'User.Read Mail.ReadWrite',
      }))],
      ['object refresh', response(200, JSON.stringify({
        token_type: 'Bearer', expires_in: 3600, access_token: PLANTED_AT,
        refresh_token: { nested: PLANTED_RT }, scope: 'User.Read Mail.ReadWrite',
      }))],
      ['newline refresh', response(200, successBody({ refresh_token: 'bad\n' + PLANTED_RT }))],
      ['oversized refresh', response(200, successBody({ refresh_token: 'x'.repeat(8193) }))],
    ];
    for (const [name, resp] of hostilePresentCases) {
      const classified = classifyMicrosoftRefreshTokenResponse(resp);
      assert.equal(classified.kind, 'uncertain', name);
      assert.equal(classified.selected, undefined, name);
      assert.equal(noLeak(classified), true, name);
    }

    const uncertainCases = [
      ['transport null', null],
      ['non-200 without body', response(500, '')],
      ['malformed json', response(200, '{')],
      ['missing access', response(200, JSON.stringify({
        token_type: 'Bearer', expires_in: 3600, refresh_token: PLANTED_RT,
        scope: 'User.Read Mail.ReadWrite',
      }))],
      ['bad scope privilege', response(200, successBody({ scope: 'User.Read Mail.ReadWrite' }))],
      ['unknown error code', response(400, JSON.stringify({
        error: 'temporarily_unavailable',
        error_description: PLANTED_ERR,
      }))],
      ['200 with error field', response(200, JSON.stringify({
        error: 'invalid_grant', error_description: PLANTED_ERR,
      }))],
      ['empty body 401', response(401, '')],
    ];
    for (const [name, resp] of uncertainCases) {
      const classified = classifyMicrosoftRefreshTokenResponse(resp);
      assert.equal(classified.kind, 'uncertain', name);
      assert.equal(noLeak(classified), true, name);
      assert.equal(classified.selected, undefined, name);
    }

    const planted = classifyMicrosoftRefreshTokenResponse(response(400, JSON.stringify({
      error: 'server_error',
      error_description: PLANTED_ERR,
      correlation_id: PLANTED_ERR,
    })));
    assert.equal(planted.kind, 'uncertain');
    assert.equal(noLeak(planted), true);
    assert.equal(typeof FAILURE_CODE, 'string');
    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-microsoft-refresh-token-response: ok');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
