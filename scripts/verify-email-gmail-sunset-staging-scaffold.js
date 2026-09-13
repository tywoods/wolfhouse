'use strict';

/**
 * EMAIL-GMAIL-001 scaffold verifier.
 *
 * Offline fixture gates for Sunset-staging Gmail OAuth contract + history poll helpers.
 * Live Gmail is never exercised here; when OAuth env credentials are absent the live
 * section is explicitly SKIPPED (not silently passed).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OAUTH_CONTRACT_PATH = path.join(ROOT, 'scripts/lib/email-gmail-sunset-staging-oauth-contract.js');
const HISTORY_POLL_PATH = path.join(ROOT, 'scripts/lib/email-gmail-sunset-staging-history-poll.js');

const VALID_SECRET_REF = 'kv:sunset-gmail-delegated-grant-refresh';
const LUNA_CLIENT = '33333333-3333-3333-3333-333333333333';
const ENTROPY_32 = 'abcdefghijklmnopqrstuvwxyz012345';
const PKCE_VERIFIER = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const PKCE_CHALLENGE = crypto.createHash('sha256').update(PKCE_VERIFIER, 'ascii').digest('base64url');
const FIXTURE_CLIENT_ID = 'sunset-fixture.apps.googleusercontent.com';
const FIXTURE_CLIENT_SECRET = 'fixture-client-secret-value';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function skipped(name, reason) {
  skip += 1;
  console.log(`  SKIP  ${name} — ${reason}`);
}

function ser(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function baseDeclaration(overrides = {}) {
  return {
    provider: 'gmail_api',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'google_delegated_oauth',
    redirect_uri_id: 'sunset_gmail_oauth_callback_v1',
    scope_plan: {
      single_consent: true,
      access_type: 'offline',
      include_granted_scopes: false,
      oidc_scopes: ['openid', 'email'],
      gmail_scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
    },
    grant_secret_package: { secret_ref: VALID_SECRET_REF },
    network_enabled: false,
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: 'off',
    ...overrides,
  };
}

function baseCallbackState(overrides = {}) {
  const issued = 1_700_000_000;
  return {
    state: ENTROPY_32,
    nonce: ENTROPY_32,
    pkce_verifier: PKCE_VERIFIER,
    pkce_challenge: PKCE_CHALLENGE,
    pkce_method: 'S256',
    redirect_uri_id: 'sunset_gmail_oauth_callback_v1',
    luna_client_id: LUNA_CLIENT,
    location_id: 'sunset-somo',
    staff_session_id: 'staffsess01',
    connector_mode: 'google_delegated_oauth',
    auth_mode: 'delegated_authorization_code',
    issued_at: issued,
    expires_at: issued + 600,
    now_at: issued + 10,
    prior_consumed: false,
    consume: true,
    expected_luna_client_id: LUNA_CLIENT,
    expected_location_id: 'sunset-somo',
    expected_staff_session_id: 'staffsess01',
    ...overrides,
  };
}

const HISTORY_FIXTURE_PAGE = Object.freeze({
  historyId: '2002',
  history: Object.freeze([
    Object.freeze({
      id: '2001',
      messagesAdded: Object.freeze([
        Object.freeze({
          message: Object.freeze({
            id: '18f3a91b2c4d5e6f',
            labelIds: Object.freeze(['INBOX', 'UNREAD']),
          }),
        }),
        Object.freeze({
          message: Object.freeze({
            id: '18f3a91b2c4d5e70',
            labelIds: Object.freeze(['SENT']),
          }),
        }),
      ]),
    }),
    Object.freeze({
      id: '2002',
      messagesAdded: Object.freeze([
        Object.freeze({
          message: Object.freeze({
            id: '18f3a91b2c4d5e6f',
            labelIds: Object.freeze(['INBOX']),
          }),
        }),
        Object.freeze({
          message: Object.freeze({
            id: '18f3a91b2c4d5e71',
            labelIds: Object.freeze(['INBOX', 'CATEGORY_PERSONAL']),
          }),
        }),
      ]),
    }),
  ]),
});

function main() {
  console.log('verify:email-gmail-sunset-staging-scaffold — EMAIL-GMAIL-001\n');

  ok('paths: oauth contract + history poll exist',
    fs.existsSync(OAUTH_CONTRACT_PATH) && fs.existsSync(HISTORY_POLL_PATH));

  let oauth = null;
  let history = null;
  let loadError = null;
  try {
    delete require.cache[require.resolve(OAUTH_CONTRACT_PATH)];
    delete require.cache[require.resolve(HISTORY_POLL_PATH)];
    oauth = require(OAUTH_CONTRACT_PATH);
    history = require(HISTORY_POLL_PATH);
  } catch (error) {
    loadError = error;
  }

  ok('modules load', oauth != null && history != null, loadError && String(loadError.message || loadError));
  if (!oauth || !history) {
    console.log(`\n── verify:email-gmail-sunset-staging-scaffold FAILED (${pass} pass, ${fail} fail, ${skip} skip) ──`);
    process.exit(1);
    return;
  }

  ok('oauth profile: provider/auth/connector/env keys',
    oauth.GMAIL_SUNSET_PROVIDER === 'gmail_api'
    && oauth.GMAIL_SUNSET_AUTH_MODE === 'delegated_authorization_code'
    && oauth.GMAIL_SUNSET_CONNECTOR_MODE === 'google_delegated_oauth'
    && oauth.GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV === 'GMAIL_OAUTH_CLIENT_ID'
    && oauth.GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV === 'GMAIL_OAUTH_CLIENT_SECRET'
    && oauth.GMAIL_SUNSET_AUTOMATION_MODE === 'off');

  ok('oauth profile: read+send+offline single-consent scopes',
    oauth.GMAIL_SUNSET_OIDC_SCOPES.includes('openid')
    && oauth.GMAIL_SUNSET_OIDC_SCOPES.includes('email')
    && oauth.GMAIL_SUNSET_GMAIL_SCOPES.includes('https://www.googleapis.com/auth/gmail.readonly')
    && oauth.GMAIL_SUNSET_GMAIL_SCOPES.includes('https://www.googleapis.com/auth/gmail.send')
    && !oauth.GMAIL_SUNSET_GMAIL_SCOPES.includes('https://www.googleapis.com/auth/gmail.compose')
    && oauth.buildGmailSunsetStagingScopePlan().single_consent === true
    && oauth.buildGmailSunsetStagingScopePlan().access_type === 'offline');

  const readiness = oauth.evaluateGmailSunsetStagingOAuthReadiness(baseDeclaration());
  ok('oauth readiness: complete-valid fixture',
    readiness.ok === true
    && readiness.value.ready_for_human_authorized_live_prerequisite_check === true
    && readiness.value.ready_for_live_oauth === false
    && readiness.value.network_enabled === false
    && readiness.value.inbound_enabled === false
    && readiness.value.outbound_enabled === false
    && readiness.value.default_automation_mode === 'off'
    && readiness.value.luna_send_capability === false
    && readiness.value.staff_approval_required === true, ser(readiness));

  ok('oauth readiness: rejects network/inbound/outbound true',
    !oauth.evaluateGmailSunsetStagingOAuthReadiness(baseDeclaration({ network_enabled: true })).ok
    && !oauth.evaluateGmailSunsetStagingOAuthReadiness(baseDeclaration({ inbound_enabled: true })).ok
    && !oauth.evaluateGmailSunsetStagingOAuthReadiness(baseDeclaration({ outbound_enabled: true })).ok);

  const callback = oauth.validateGmailSunsetStagingCallbackState(baseCallbackState());
  ok('oauth callback state: valid consume fixture',
    callback.ok === true
    && callback.value.status === 'consumed'
    && callback.value.pkce_s256_verified === true
    && callback.value.replay_rejected === true, ser(callback));

  ok('oauth callback state: rejects replay',
    !oauth.validateGmailSunsetStagingCallbackState(baseCallbackState({ prior_consumed: true })).ok);

  const authUrl = oauth.buildGmailSunsetStagingAuthorizationUrl({
    client_id: FIXTURE_CLIENT_ID,
    redirect_uri: 'https://staff-staging.lunafrontdesk.com/staff/email/oauth/google/callback',
    state: ENTROPY_32,
    code_challenge: PKCE_CHALLENGE,
  });
  ok('oauth authorization url: single-consent offline shape',
    authUrl.ok === true
    && authUrl.value.authorization_url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')
    && authUrl.value.authorization_url.includes('access_type=offline')
    && authUrl.value.authorization_url.includes('prompt=consent')
    && authUrl.value.authorization_url.includes('gmail.readonly')
    && authUrl.value.authorization_url.includes('gmail.send')
    && authUrl.value.single_consent === true, ser(authUrl));

  const revokeBody = oauth.buildGmailSunsetStagingRevokeRequestBody({
    client_id: FIXTURE_CLIENT_ID,
    client_secret: FIXTURE_CLIENT_SECRET,
    token: 'fixture-refresh-token',
  });
  ok('oauth revoke: request body builder ok',
    revokeBody.ok === true
    && revokeBody.value.token_origin === 'https://oauth2.googleapis.com'
    && revokeBody.value.revoke_path === '/revoke'
    && revokeBody.value.public_body_includes_token_value === false);

  ok('oauth env: fail closed when missing',
    !oauth.readGmailSunsetStagingOAuthEnv({}).ok
    && !oauth.readGmailSunsetStagingOAuthEnv({ GMAIL_OAUTH_CLIENT_ID: FIXTURE_CLIENT_ID }).ok
    && !oauth.readGmailSunsetStagingOAuthEnv({
      GMAIL_OAUTH_CLIENT_SECRET: FIXTURE_CLIENT_SECRET,
    }).ok
    && !oauth.hasGmailSunsetStagingOAuthLiveCredentials({}));

  const envOk = oauth.readGmailSunsetStagingOAuthEnv({
    GMAIL_OAUTH_CLIENT_ID: FIXTURE_CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: FIXTURE_CLIENT_SECRET,
  });
  ok('oauth env: accepts valid fixture env without exposing secret',
    envOk.ok === true
    && envOk.value.client_id_present === true
    && envOk.value.client_secret_present === true
    && envOk.value.public_client_secret_forbidden === true
    && !ser(envOk).includes(FIXTURE_CLIENT_SECRET));

  const historyRequest = history.buildGmailSunsetStagingHistoryListRequest({ startHistoryId: '1000' });
  ok('history poll: request pins history.list incremental path',
    historyRequest.ok === true
    && historyRequest.value.host === 'gmail.googleapis.com'
    && historyRequest.value.path === '/gmail/v1/users/me/history'
    && historyRequest.value.query.includes('startHistoryId=1000')
    && historyRequest.value.query.includes('historyTypes=messageAdded')
    && historyRequest.value.inbound_only === true
    && historyRequest.value.full_mailbox_scrape === false, ser(historyRequest));

  const parsed = history.parseGmailSunsetStagingHistoryListPage(HISTORY_FIXTURE_PAGE);
  ok('history poll: fixture page parses',
    parsed.ok === true && parsed.value.historyId === '2002', ser(parsed));

  const applied = history.applyGmailSunsetStagingHistoryPollPage({
    page: HISTORY_FIXTURE_PAGE,
    seenMessageIds: [],
    startHistoryId: '1000',
  });
  ok('history poll: inbound-only idempotent by message id',
    applied.ok === true
    && applied.value.inbound_count === 2
    && applied.value.inbound_message_ids.join(',') === '18f3a91b2c4d5e6f,18f3a91b2c4d5e71'
    && applied.value.duplicates_skipped === 1
    && applied.value.outbound_skipped === 1
    && applied.value.successor_history_id === '2002'
    && applied.value.idempotent_by_gmail_message_id === true, ser(applied));

  const replay = history.applyGmailSunsetStagingHistoryPollPage({
    page: HISTORY_FIXTURE_PAGE,
    seenMessageIds: ['18f3a91b2c4d5e6f', '18f3a91b2c4d5e71'],
    startHistoryId: '1000',
  });
  ok('history poll: replay fixture yields zero new inbound',
    replay.ok === true && replay.value.inbound_count === 0 && replay.value.duplicates_skipped === 3, ser(replay));

  console.log('\n── live Gmail section (scaffolding; no connect) ──');
  const liveEnv = {
    GMAIL_OAUTH_CLIENT_ID: process.env.GMAIL_OAUTH_CLIENT_ID,
    GMAIL_OAUTH_CLIENT_SECRET: process.env.GMAIL_OAUTH_CLIENT_SECRET,
  };
  if (!oauth.hasGmailSunsetStagingOAuthLiveCredentials(liveEnv)) {
    skipped('live Gmail OAuth + history.list',
      `missing ${oauth.GMAIL_SUNSET_OAUTH_CLIENT_ID_ENV} and/or ${oauth.GMAIL_SUNSET_OAUTH_CLIENT_SECRET_ENV}`);
  } else {
    skipped('live Gmail OAuth + history.list',
      'credentials present but EMAIL-GMAIL-001 scaffolding forbids live connect');
  }

  const liveSectionSkipped = skip > 0;
  ok('live section: explicit skip recorded (no false-pass)',
    liveSectionSkipped === true, `skip count=${skip}`);

  console.log(`\n── verify:email-gmail-sunset-staging-scaffold ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail, ${skip} skip) ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
