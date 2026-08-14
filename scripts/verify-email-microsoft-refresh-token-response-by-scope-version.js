'use strict';

/**
 * RED/GREEN gate: phase-aware Microsoft refresh-token response classification.
 *
 * Scope policy is keyed only by trusted persisted scope_version:
 *   phase_a_v2 → single-consent validator (User.Read + Mail.ReadWrite + Mail.Send)
 *   phase_b_v1 → legacy Phase B validator (same resource set)
 *   unknown / missing / hostile → fail-closed uncertain
 *
 * Never broadens beyond single-consent scopes; rejects legacy Mail.ReadBasic.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./lib/email-microsoft-delegated-oauth-contract');
const {
  classifyMicrosoftRefreshTokenResponseForScopeVersion,
} = require('./lib/email-microsoft-refresh-token-response-by-scope-version');
// Existing Phase A-only entry must remain byte-compatible.
const {
  classifyMicrosoftRefreshTokenResponse,
} = require('./lib/email-microsoft-refresh-token-response');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const MOD_REL = 'scripts/lib/email-microsoft-refresh-token-response-by-scope-version.js';

const PLANTED_RT = 'rt-NEVER_LEAK_phase_aware_refresh';
const PLANTED_AT = 'at-NEVER_LEAK_phase_aware_access';
const PLANTED_ERR = 'error_description_NEVER_LEAK_phase_aware';

const SINGLE_CONSENT_SCOPE = 'openid profile offline_access User.Read Mail.ReadWrite Mail.Send';
const PHASE_A_SCOPE = SINGLE_CONSENT_SCOPE;
const PHASE_B_SCOPE = SINGLE_CONSENT_SCOPE;
const PHASE_B_MINIMAL = 'User.Read Mail.ReadWrite Mail.Send';
const MIXED_SCOPE = 'openid profile User.Read Mail.ReadWrite Mail.SendWrite Mail.Send';

function successBody(scope, patch = {}) {
  return JSON.stringify({
    token_type: 'Bearer',
    expires_in: 3600,
    access_token: PLANTED_AT,
    refresh_token: PLANTED_RT,
    scope,
    ...patch,
  });
}

function response(statusCode, body, contentType = 'application/json') {
  return Object.freeze({ statusCode, contentType, body });
}

function noLeak(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(PLANTED_RT)
    && !text.includes(PLANTED_AT)
    && !text.includes(PLANTED_ERR)
    && !text.includes('error_description');
}

function assertUncertain(label, scopeVersion, resp) {
  const classified = classifyMicrosoftRefreshTokenResponseForScopeVersion(scopeVersion, resp);
  assert.equal(classified.kind, 'uncertain', label);
  assert.equal(classified.selected, undefined, label);
  assert.equal(Object.isFrozen(classified), true, label);
  assert.equal(noLeak(classified), true, label);
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = console.error = (...v) => logged.push(v);
  try {
    assert.equal(EMAIL_MS_DELEGATED_SCOPE_VERSION, 'phase_a_v2');
    assert.equal(EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION, 'phase_b_v1');

    // ── Phase A grant + Phase A token scope → success (unchanged) ─────
    {
      const ok = classifyMicrosoftRefreshTokenResponseForScopeVersion(
        'phase_a_v2',
        response(200, successBody(PHASE_A_SCOPE)),
      );
      assert.equal(ok.kind, 'success');
      assert.equal(ok.selected.accessToken, PLANTED_AT);
      assert.equal(ok.selected.refreshToken, PLANTED_RT);
      assert.equal(ok.selected.refreshTokenOmitted, false);
      assert.equal(ok.selected.scope.includes('User.Read'), true);
      assert.equal(ok.selected.scope.includes('Mail.ReadWrite'), true);
      assert.equal(ok.selected.scope.includes('Mail.Send'), true);
      assert.equal(ok.selected.scope.includes('Mail.ReadBasic'), false);
      assert.equal(Object.isFrozen(ok), true);
      assert.equal(Object.isFrozen(ok.selected), true);

      // Phase-aware Phase A path must match legacy Phase A classifier.
      const legacy = classifyMicrosoftRefreshTokenResponse(
        response(200, successBody(PHASE_A_SCOPE)),
      );
      assert.equal(legacy.kind, 'success');
      assert.equal(legacy.selected.scope, ok.selected.scope);
    }

    // ── Phase B grant + Phase B token scope → success (the defect RED) ─
    {
      const ok = classifyMicrosoftRefreshTokenResponseForScopeVersion(
        'phase_b_v1',
        response(200, successBody(PHASE_B_SCOPE)),
      );
      assert.equal(ok.kind, 'success', 'Phase B grant must accept Phase B MS 200 scopes');
      assert.equal(ok.selected.accessToken, PLANTED_AT);
      assert.equal(ok.selected.refreshToken, PLANTED_RT);
      assert.equal(ok.selected.scope.includes('User.Read'), true);
      assert.equal(ok.selected.scope.includes('Mail.ReadWrite'), true);
      assert.equal(ok.selected.scope.includes('Mail.Send'), true);
      assert.equal(ok.selected.scope.includes('Mail.ReadBasic'), false);
      assert.equal(Object.isFrozen(ok), true);
      assert.equal(noLeak({ kind: ok.kind, scope: ok.selected.scope }), true);
    }

    {
      const ok = classifyMicrosoftRefreshTokenResponseForScopeVersion(
        'phase_b_v1',
        response(200, successBody(PHASE_B_MINIMAL)),
      );
      assert.equal(ok.kind, 'success', 'minimal Phase B resource set');
      assert.equal(ok.selected.scope, 'User.Read Mail.ReadWrite Mail.Send');
    }

    // Omission still valid under Phase B.
    {
      const omitted = classifyMicrosoftRefreshTokenResponseForScopeVersion(
        'phase_b_v1',
        response(200, JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: PLANTED_AT,
          scope: PHASE_B_SCOPE,
        })),
      );
      assert.equal(omitted.kind, 'success');
      assert.equal(omitted.selected.refreshTokenOmitted, true);
      assert.equal(Object.prototype.hasOwnProperty.call(omitted.selected, 'refreshToken'), false);
    }

    // ── Legacy / incomplete scopes → uncertain ─────────────────────────
    const LEGACY_SCOPE = 'openid profile offline_access User.Read Mail.ReadBasic';
    const INCOMPLETE_SCOPE = 'openid profile User.Read Mail.ReadWrite';
    assertUncertain(
      'Phase A grant + legacy Mail.ReadBasic scopes',
      'phase_a_v2',
      response(200, successBody(LEGACY_SCOPE)),
    );
    assertUncertain(
      'Phase B grant + legacy Mail.ReadBasic scopes',
      'phase_b_v1',
      response(200, successBody(LEGACY_SCOPE)),
    );
    assertUncertain(
      'Phase A grant + incomplete scopes (missing Mail.Send)',
      'phase_a_v2',
      response(200, successBody(INCOMPLETE_SCOPE)),
    );
    assertUncertain(
      'Phase A grant + mixed A/B scopes',
      'phase_a_v2',
      response(200, successBody(MIXED_SCOPE)),
    );
    assertUncertain(
      'Phase B grant + mixed A/B scopes (phase_a_mixed)',
      'phase_b_v1',
      response(200, successBody(MIXED_SCOPE)),
    );

    // ── Unknown / missing / hostile scope_version → uncertain ─────────
    for (const bad of [
      null, undefined, '', 'phase_a_v1', 'phase_b_v2', 'PHASE_B_V1',
      'phase_a_v2\n', ' phase_b_v1', 7, {}, [], true, 'phase_a_v2;phase_b_v1',
    ]) {
      assertUncertain(
        `hostile scope_version=${String(bad)}`,
        bad,
        response(200, successBody(PHASE_B_SCOPE)),
      );
      assertUncertain(
        `hostile scope_version=${String(bad)} phase A body`,
        bad,
        response(200, successBody(PHASE_A_SCOPE)),
      );
    }

    // ── Terminal invalid_grant still terminal under both phases ───────
    for (const ver of ['phase_a_v2', 'phase_b_v1']) {
      const ig = classifyMicrosoftRefreshTokenResponseForScopeVersion(
        ver,
        response(400, JSON.stringify({
          error: 'invalid_grant',
          error_description: PLANTED_ERR,
        })),
      );
      assert.equal(ig.kind, 'invalid_grant', ver);
      assert.equal(ig.selected, undefined, ver);
      assert.equal(noLeak(ig), true, ver);
    }

    // ── Transport / malformed still uncertain; no leakage ─────────────
    for (const ver of ['phase_a_v2', 'phase_b_v1']) {
      assertUncertain(ver + ' 503', ver, response(503, PLANTED_ERR, 'text/plain'));
      assertUncertain(ver + ' bad json', ver, response(200, '{'));
    }

    // Exact arity: scopeVersion first, response second. No free-form options bag.
    assert.equal(classifyMicrosoftRefreshTokenResponseForScopeVersion.length, 2);

    // Source: must key only on trusted scope_version constants; no env/browser.
    const src = fs.readFileSync(path.join(ROOT, MOD_REL), 'utf8');
    assert.match(src, /phase_a_v2|EMAIL_MS_DELEGATED_SCOPE_VERSION/);
    assert.match(src, /phase_b_v1|EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION/);
    assert.match(src, /validateAndNormalizeTokenResponseScope|classifyMicrosoftRefreshTokenResponse/);
    assert.match(src, /validateAndNormalizePhaseBTokenResponseScope/);
    assert.doesNotMatch(src, /process\.env|LUNA_EMAIL|window\.|localStorage/);
    // Executable policy must not union Phase A + Phase B resource sets.
    assert.doesNotMatch(src, /ALLOWED_TOKEN_RESPONSE_SCOPES|Mail\.ReadBasic.*Mail\.ReadWrite/);

    // Legacy Phase A entry accepts single-consent scopes; rejects legacy Mail.ReadBasic.
    const legacyOk = classifyMicrosoftRefreshTokenResponse(
      response(200, successBody(PHASE_A_SCOPE)),
    );
    assert.equal(legacyOk.kind, 'success', 'Phase A classifier accepts single-consent scopes');
    const legacyBasic = classifyMicrosoftRefreshTokenResponse(
      response(200, successBody('openid profile offline_access User.Read Mail.ReadBasic')),
    );
    assert.equal(legacyBasic.kind, 'uncertain', 'Phase A classifier rejects legacy Mail.ReadBasic');

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    assert.equal(
      pkg.scripts['verify:email-microsoft-refresh-token-response-by-scope-version'],
      'node scripts/verify-email-microsoft-refresh-token-response-by-scope-version.js',
    );

    assert.deepEqual(logged, []);
  } finally {
    console.log = log;
    console.error = error;
  }
  log('verify:email-microsoft-refresh-token-response-by-scope-version: ok');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
