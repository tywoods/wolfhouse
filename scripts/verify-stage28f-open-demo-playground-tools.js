/**
 * Stage 28f — Static verifier for open-demo playground report + cleanup CLIs.
 *
 * Usage:
 *   npm run verify:stage28f-open-demo-playground-tools
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT = path.join(__dirname, 'report-open-demo-playground-state.js');
const CLEANUP = path.join(__dirname, 'cleanup-open-demo-staging-booking.js');
const COMMON = path.join(__dirname, 'lib', 'open-demo-playground-common.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-28F-OPEN-DEMO-PLAYGROUND-TOOLS.md');
const DOC28E = path.join(ROOT, 'docs', 'STAGE-28E-STAGING-GUEST-PLAYGROUND.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28f-open-demo-playground-tools';

const FORBIDDEN_IMPORTS = [
  ['sendLunaWhatsAppMessage', 'WhatsApp send helper'],
  ['runGuestStripeTestLinkCreateApproved', 'Stripe checkout create helper'],
  ['guest-simulator-create-stripe-test-link', 'Stripe link route'],
  ['runGuestConfirmationSend', 'confirmation send helper'],
  ['send-confirmation', 'confirmation send route'],
  ['workflow_entity.*SET.*active', 'n8n activation'],
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage28f-open-demo-playground-tools.js  (Stage 28f)\n`);

for (const file of [REPORT, CLEANUP, COMMON, __filename]) {
  try {
    execSync(`node --check "${file}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(file)} passes node --check`);
  } catch {
    fail('0', `${path.basename(file)} syntax error`);
  }
}

section('A. Files exist');

if (fs.existsSync(REPORT)) pass('A1', 'report script exists');
else fail('A1', 'report script missing');

if (fs.existsSync(CLEANUP)) pass('A2', 'cleanup script exists');
else fail('A2', 'cleanup script missing');

if (fs.existsSync(COMMON)) pass('A3', 'shared common lib exists');
else fail('A3', 'common lib missing');

if (fs.existsSync(DOC) || (fs.existsSync(DOC28E) && fs.readFileSync(DOC28E, 'utf8').includes('report:open-demo-playground'))) {
  pass('A4', 'docs reference playground tools');
} else {
  fail('A4', 'docs missing for playground tools');
}

const reportSrc = fs.existsSync(REPORT) ? fs.readFileSync(REPORT, 'utf8') : '';
const cleanupSrc = fs.existsSync(CLEANUP) ? fs.readFileSync(CLEANUP, 'utf8') : '';
const commonSrc = fs.existsSync(COMMON) ? fs.readFileSync(COMMON, 'utf8') : '';
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

section('B. package.json scripts');

if (pkg.scripts['report:open-demo-playground']) pass('B1', 'report:open-demo-playground registered');
else fail('B1', 'report:open-demo-playground missing');

if (pkg.scripts['cleanup:open-demo-booking']) pass('B2', 'cleanup:open-demo-booking registered');
else fail('B2', 'cleanup:open-demo-booking missing');

if (pkg.scripts[SCRIPT]) pass('B3', 'verify:stage28f-open-demo-playground-tools registered');
else fail('B3', 'verifier script missing from package.json');

section('C. Cleanup safety defaults');

if (/dryRun:\s*true/.test(commonSrc) || /dry_run:\s*flags\.dryRun/.test(cleanupSrc)) {
  pass('C1', 'cleanup defaults to dry-run');
} else fail('C1', 'dry-run default missing');

if (cleanupSrc.includes('--confirm-cleanup') && cleanupSrc.includes('confirmCleanup')) {
  pass('C2', 'cleanup requires --confirm-cleanup for writes');
} else fail('C2', '--confirm-cleanup gate missing');

if (commonSrc.includes('assertNotProductionDb') && cleanupSrc.includes('assertNotProductionDb')) {
  pass('C3', 'production DB guard wired in cleanup');
} else fail('C3', 'production guard missing');

if (reportSrc.includes('assertNotProductionDb')) pass('C4', 'production DB guard wired in report');
else fail('C4', 'report production guard missing');

if (commonSrc.includes('paid_cleanup_not_implemented') || cleanupSrc.includes('paid_cleanup_not_implemented')) {
  pass('C5', 'paid cleanup refused / not implemented');
} else fail('C5', 'paid cleanup refusal missing');

if (commonSrc.includes('deposit_paid') && commonSrc.includes('assessCleanupEligibility')) {
  pass('C6', 'deposit_paid eligibility check present');
} else fail('C6', 'deposit_paid check missing');

section('D. Report read-only');

if (!reportSrc.includes('INSERT ') && !reportSrc.includes('UPDATE ') && !reportSrc.includes('DELETE ')) {
  pass('D1', 'report script has no SQL writes');
} else fail('D1', 'report script may perform writes');

if (reportSrc.includes('read_only: true')) pass('D2', 'report marks read_only in output');
else fail('D2', 'read_only flag missing');

section('E. Forbidden side effects');

const combined = `${reportSrc}\n${cleanupSrc}\n${commonSrc}`;
for (const [pattern, label] of FORBIDDEN_IMPORTS) {
  const re = new RegExp(pattern, 'i');
  if (!re.test(combined)) pass('E', `no ${label}`);
  else fail('E', `forbidden ${label} referenced`);
}

section('F. Cleanup behavior');

if (cleanupSrc.includes("status = 'cancelled'") && cleanupSrc.includes('DELETE FROM booking_beds')) {
  pass('F1', 'cleanup cancels booking and releases beds');
} else fail('F1', 'cancel + bed release missing');

if (cleanupSrc.includes("status = 'cancelled'") && cleanupSrc.includes('payments')) {
  pass('F2', 'cleanup cancels unpaid payment rows');
} else fail('F2', 'payment cancel missing');

if (!cleanupSrc.includes('guest_message_sends')) pass('F3', 'cleanup does not touch guest_message_sends');
else fail('F3', 'guest_message_sends touched');

section('G. Report coverage');

for (const needle of [
  'fetchStaffApiGates',
  'fetchMetaCallback',
  'fetchN8nWorkflowStatus',
  'staff_phone_access',
  'demo_calendar_blocks',
  'WHATSAPP_DRY_RUN',
]) {
  if (reportSrc.includes(needle) || commonSrc.includes(needle)) {
    pass('G', `report covers ${needle}`);
  } else {
    fail('G', `report missing ${needle}`);
  }
}

console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
