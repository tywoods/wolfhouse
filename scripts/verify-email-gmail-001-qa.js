'use strict';

/**
 * EMAIL-GMAIL-001 independent QA gate.
 *
 * Validates the PR #594 Gmail scaffold without a Gmail connection. It runs the
 * scaffold verifier twice: once with OAuth variables absent and once with safe
 * fixture values. Both runs must explicitly SKIP the live section; neither is
 * evidence of a live Gmail call.
 */

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAFFOLD_VERIFIER = path.join(ROOT, 'scripts/verify-email-gmail-sunset-staging-scaffold.js');
const OAUTH = path.join(ROOT, 'scripts/lib/email-gmail-sunset-staging-oauth-contract.js');
const HISTORY = path.join(ROOT, 'scripts/lib/email-gmail-sunset-staging-history-poll.js');
const FIXTURE_ENV = Object.freeze({
  GMAIL_OAUTH_CLIENT_ID: 'qa-fixture.apps.googleusercontent.com',
  GMAIL_OAUTH_CLIENT_SECRET: 'qa-fixture-secret-not-live',
});

let passed = 0;
function ok(name, check) {
  try {
    check();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name} — ${error.message}`);
    throw error;
  }
}

function scrubbedEnv(overrides) {
  const env = { ...process.env, ...overrides };
  delete env.GMAIL_OAUTH_CLIENT_ID;
  delete env.GMAIL_OAUTH_CLIENT_SECRET;
  return { ...env, ...overrides };
}

function runScaffold(label, env) {
  const result = childProcess.spawnSync(process.execPath, [SCAFFOLD_VERIFIER], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.strictEqual(result.error, undefined, `${label}: verifier process error`);
  assert.strictEqual(result.status, 0, `${label}: verifier must exit 0\n${result.stdout}\n${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /SKIP  live Gmail OAuth \+ history\.list/, `${label}: live section must explicitly skip`);
  assert.match(output, /live section: explicit skip recorded \(no false-pass\)/, `${label}: skip accounting must be asserted`);
  assert.doesNotMatch(output, /LIVE CONNECTED|live Gmail.*PASS/i, `${label}: must not report a live Gmail pass`);
  return output;
}

function main() {
  console.log('verify:email-gmail-001-qa — independent test-only scaffold gates\n');

  ok('PR scaffold and independent QA gate exist', () => {
    assert.ok(fs.existsSync(SCAFFOLD_VERIFIER));
    assert.ok(fs.existsSync(OAUTH));
    assert.ok(fs.existsSync(HISTORY));
  });

  const oauth = require(OAUTH);
  const history = require(HISTORY);
  ok('OAuth is one delegated consent: read + send + offline', () => {
    const scope = oauth.buildGmailSunsetStagingScopePlan();
    assert.strictEqual(scope.single_consent, true);
    assert.strictEqual(scope.access_type, 'offline');
    assert.deepStrictEqual(scope.gmail_scopes, [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });

  ok('OAuth environment fails closed with no secrets', () => {
    const missing = oauth.readGmailSunsetStagingOAuthEnv({});
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.error, 'gmail_oauth_env_missing');
    assert.strictEqual(oauth.hasGmailSunsetStagingOAuthLiveCredentials({}), false);
  });

  ok('history.list is incremental and inbound-only', () => {
    const request = history.buildGmailSunsetStagingHistoryListRequest({ startHistoryId: '42' });
    assert.strictEqual(request.ok, true);
    assert.strictEqual(request.value.path, '/gmail/v1/users/me/history');
    assert.match(request.value.query, /startHistoryId=42/);
    assert.match(request.value.query, /historyTypes=messageAdded/);
    assert.strictEqual(request.value.inbound_only, true);
    assert.strictEqual(request.value.full_mailbox_scrape, false);
  });

  ok('history applies Gmail IDs idempotently and excludes SENT', () => {
    const page = { historyId: '44', history: [{ id: '44', messagesAdded: [
      { message: { id: 'abcdef0123', labelIds: ['INBOX'] } },
      { message: { id: 'abcdef0124', labelIds: ['SENT'] } },
      { message: { id: 'abcdef0123', labelIds: ['INBOX'] } },
    ] }] };
    const applied = history.applyGmailSunsetStagingHistoryPollPage({
      page, startHistoryId: '42', seenMessageIds: [],
    });
    assert.strictEqual(applied.ok, true);
    assert.deepStrictEqual(applied.value.inbound_message_ids, ['abcdef0123']);
    assert.strictEqual(applied.value.duplicates_skipped, 1);
    assert.strictEqual(applied.value.outbound_skipped, 1);
    assert.strictEqual(applied.value.successor_history_id, '44');
    assert.strictEqual(applied.value.idempotent_by_gmail_message_id, true);
  });

  ok('no credentials: run explicitly skips live Gmail, not passes it', () => {
    const output = runScaffold('credentials absent', scrubbedEnv({}));
    assert.match(output, /missing GMAIL_OAUTH_CLIENT_ID and\/or GMAIL_OAUTH_CLIENT_SECRET/);
  });

  ok('fixture credentials: run still skips live Gmail', () => {
    const output = runScaffold('fixture credentials', scrubbedEnv(FIXTURE_ENV));
    assert.match(output, /credentials present but EMAIL-GMAIL-001 scaffolding forbids live connect/);
  });

  ok('scaffold helpers do not import a direct live HTTP client', () => {
    const source = `${fs.readFileSync(OAUTH, 'utf8')}\n${fs.readFileSync(HISTORY, 'utf8')}`;
    assert.doesNotMatch(source, /require\(['"](?:https|http|axios|node-fetch)['"]\)/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  });

  console.log(`\n── verify:email-gmail-001-qa PASSED (${passed} pass, 0 fail, 0 skip) ──`);
}

main();
