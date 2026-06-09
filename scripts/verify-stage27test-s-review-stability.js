/**
 * Stage 27test-s — Verifier for review dry-run stability diagnostics.
 *
 * Usage:
 *   npm run verify:stage27test-s-review-stability
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(__dirname, 'staff-query-api.js');
const RUNNER = path.join(__dirname, 'run-luna-guest-torture-tests.js');
const ERROR_LOG = path.join(__dirname, 'lib', 'luna-review-dry-run-error-log.js');
const RETRY_LIB = path.join(__dirname, 'lib', 'luna-torture-endpoint-retry.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-27TEST-S-REVIEW-STABILITY.md');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27test-s-review-stability';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27test-s-review-stability.js  (Stage 27test-s)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Structured error logging');

for (const [id, file] of [['A1', ERROR_LOG], ['A2', STAFF_API]]) {
  if (fs.existsSync(file)) pass(`${id}a`, `${path.basename(file)} exists`);
  else fail(`${id}a`, `${path.basename(file)} missing`);
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
    pass(`${id}b`, `${path.basename(file)} passes node --check`);
  } catch {
    fail(`${id}b`, `${path.basename(file)} syntax error`);
  }
}

const errorLogSrc = fs.existsSync(ERROR_LOG) ? fs.readFileSync(ERROR_LOG, 'utf8') : '';
const staffSrc = fs.existsSync(STAFF_API) ? fs.readFileSync(STAFF_API, 'utf8') : '';

if (errorLogSrc.includes('LUNA_REVIEW_DRY_RUN_ERROR')) {
  pass('A3', 'error marker LUNA_REVIEW_DRY_RUN_ERROR defined');
} else {
  fail('A3', 'error marker missing');
}

if (errorLogSrc.includes('error_stack') && errorLogSrc.includes('console.error')) {
  pass('A4', 'stack logged server-side via console.error');
} else {
  fail('A4', 'server-side stack logging missing');
}

if (errorLogSrc.includes('maskGuestPhone') || errorLogSrc.includes('guest_phone_masked')) {
  pass('A5', 'guest phone masked in logs');
} else {
  fail('A5', 'phone masking missing');
}

const safeBody = require('./lib/luna-review-dry-run-error-log.js').buildSafeReviewDryRun500Body({
  error: 'guest inbound review dry-run failed',
  auth_mode: 'token',
  elapsed_ms: 12,
});
if (!safeBody.error_stack && !safeBody.stack && safeBody.success === false) {
  pass('A6', 'client 500 body has no stack trace');
} else {
  fail('A6', 'client 500 body exposes stack');
}

if (staffSrc.includes('logReviewDryRunError') && staffSrc.includes('guest-automation-review-dry-run')) {
  pass('A7', 'automation review handler logs structured errors');
} else {
  fail('A7', 'automation handler logging missing');
}

if (staffSrc.includes('guest-inbound-review-dry-run') && staffSrc.includes('buildSafeReviewDryRun500Body')) {
  pass('A8', 'inbound review handler uses safe 500 body');
} else {
  fail('A8', 'inbound handler safe 500 missing');
}

section('B. Torture runner retry-on-500');

const runnerSrc = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
const retrySrc = fs.existsSync(RETRY_LIB) ? fs.readFileSync(RETRY_LIB, 'utf8') : '';
const runnerCode = runnerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

if (runnerSrc.includes('--retry-500')) pass('B1', 'runner documents --retry-500 flag');
else fail('B1', '--retry-500 flag missing');

if (runnerSrc.includes('retry500: 0')) pass('B2', 'default retry count is 0');
else fail('B2', 'default retry not 0');

if (runnerSrc.includes('initial_http_500_count') && runnerSrc.includes('recovered_http_500_count') && runnerSrc.includes('unrecovered_http_500_count')) {
  pass('B3', 'report includes 500 retry counters');
} else {
  fail('B3', '500 retry counters missing from report');
}

if (retrySrc.includes('isRetryableHttpStatus') && retrySrc.includes('500')) {
  pass('B4', 'retry helper targets HTTP 500 class');
} else {
  fail('B4', 'HTTP 500 retry filter missing');
}

if (retrySrc.includes('isRetryableNetworkError') && retrySrc.includes('ECONNRESET')) {
  pass('B5', 'retry helper handles network reset');
} else {
  fail('B5', 'network retry missing');
}

if (retrySrc.includes('500') && retrySrc.includes('1500')) {
  pass('B6', 'backoff schedule includes 500ms and 1500ms');
} else {
  fail('B6', 'backoff schedule missing');
}

if (runnerSrc.includes('X-Luna-Run-Id') || runnerSrc.includes('buildTortureCorrelationHeaders')) {
  pass('B7', 'runner sends correlation headers');
} else {
  fail('B7', 'correlation headers missing');
}

if (runnerSrc.includes('torture_run_id') || runnerSrc.includes('enrichTorturePayload')) {
  pass('B8', 'runner sends run_id/fixture_id in payload');
} else {
  fail('B8', 'payload correlation missing');
}

const { isRetryableHttpStatus, isRetryableNetworkError } = require('./lib/luna-torture-endpoint-retry.js');
if (isRetryableHttpStatus(500) && !isRetryableHttpStatus(400) && !isRetryableHttpStatus(422)) {
  pass('B9', 'retry applies only to server/network errors, not 4xx');
} else {
  fail('B9', 'retry status filter incorrect');
}
if (isRetryableNetworkError({ code: 'ECONNRESET' }) && !isRetryableNetworkError({ code: 'EINVAL' })) {
  pass('B10', 'network retry filter correct');
} else {
  fail('B10', 'network retry filter incorrect');
}

section('C. Safety — no live sends');

const forbidden = [
  ['C1', 'sendWhatsApp', 'WhatsApp send'],
  ['C2', 'runGuestHoldPaymentDraftWriteDryRunApproved', 'hold/payment write'],
  ['C3', 'runGuestStripeTestLinkCreateApproved', 'Stripe link'],
  ['C4', 'handleBotGuestReplySend', 'guest reply send'],
];
for (const [id, sym, label] of forbidden) {
  if (!runnerCode.includes(sym)) pass(id, `runner does not call ${label}`);
  else fail(id, `runner calls ${label}`);
}

if (!errorLogSrc.includes('fetch(') && !retrySrc.includes('fetch(')) {
  pass('C5', 'new libs have no external fetch');
} else {
  fail('C5', 'new libs call fetch');
}

section('D. Docs and npm script');

if (fs.existsSync(DOC)) pass('D1', 'STAGE-27TEST-S-REVIEW-STABILITY.md exists');
else fail('D1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (/LUNA_REVIEW_DRY_RUN_ERROR/.test(doc)) pass('D2', 'doc explains log marker');
  else fail('D2', 'log marker not documented');
  if (/--retry-500/.test(doc)) pass('D3', 'doc explains --retry-500');
  else fail('D3', '--retry-500 not documented');
  if (/565\/565|unrecovered/.test(doc)) pass('D4', 'doc defines demo gate thresholds');
  else fail('D4', 'demo gate thresholds missing');
}

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D5', `${SCRIPT} registered`);
else fail('D5', `${SCRIPT} npm script missing`);

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
