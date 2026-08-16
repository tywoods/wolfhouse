'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
// Deliberately assembled so the retired exact URI remains absent from scripts.
const OLD = `https://${'staff-staging.lunafrontdesk.com'}/staff/email/google/callback`;
const EXPECTED = 'https://sunset-staging.lunafrontdesk.com/staff/email/google/callback';
const OWNERS = [
  'lib/email-google-oauth-sunset-staging-runtime-composition.js',
  'browser/sunset-admin-email-settings-ui.js',
  'lib/email-google-onboarding-runtime-assembly.js',
  'lib/email-google-state-first-callback-runtime.js',
  'lib/email-google-state-first-runtime-composition.js',
];
const REAL_OWNER_VERIFIERS = [
  'verify-email-google-oauth-sunset-staging-runtime-composition.js',
  'verify-email-google-onboarding-runtime-assembly.js',
  'verify-email-google-state-first-callback-runtime.js',
  'verify-email-google-state-first-runtime-composition.js',
];

for (const verifier of REAL_OWNER_VERIFIERS) {
  const result = spawnSync(process.execPath, [path.join(ROOT, verifier)], {
    cwd: path.dirname(ROOT), env: process.env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${verifier} failed:\n${result.stdout}${result.stderr}`);
}

for (const owner of OWNERS) {
  const source = fs.readFileSync(path.join(ROOT, owner), 'utf8');
  assert.equal(source.includes(EXPECTED), true, `${owner} does not own the canonical Sunset redirect URI`);
  assert.equal(source.includes(OLD), false, `${owner} still owns the staff-staging redirect URI`);
}

const browserSource = fs.readFileSync(path.join(ROOT, OWNERS[1]), 'utf8');
const sandbox = { URL, Object, Reflect, console };
vm.runInNewContext(browserSource, sandbox, { filename: OWNERS[1] });
function authorizationUrl(redirectUri) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of [
    ['client_id', '9876543210-web.apps.googleusercontent.com'], ['response_type', 'code'],
    ['redirect_uri', redirectUri], ['response_mode', 'query'],
    ['scope', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'],
    ['state', 'a'.repeat(43)], ['nonce', 'b'.repeat(43)], ['code_challenge', 'c'.repeat(43)],
    ['code_challenge_method', 'S256'], ['prompt', 'consent'],
  ]) url.searchParams.append(key, value);
  return url.toString();
}
const canonical = authorizationUrl(EXPECTED);
assert.equal(sandbox.validateGoogleAuthorizationUrl(canonical), canonical);
assert.equal(sandbox.validateGoogleAuthorizationUrl(authorizationUrl(OLD)), null);
assert.equal(new URL(EXPECTED).pathname, '/staff/email/google/callback');
assert.equal(new URL(EXPECTED).hostname, 'sunset-staging.lunafrontdesk.com');
assert.notEqual(new URL(EXPECTED).hostname, 'staff-staging.lunafrontdesk.com');

console.log('EMAIL-GMAIL-REDIRECT-001 PASS: production OAuth owners, start composition, and browser validator pin the Sunset callback host; staff-staging is rejected.');
