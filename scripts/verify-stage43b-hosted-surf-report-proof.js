'use strict';

/**
 * Stage 43b — Verifier for hosted surf report proof script/docs.
 *
 * Usage:
 *   npm run verify:stage43b-hosted-surf-report-proof
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROOF_SCRIPT = path.join(__dirname, 'run-stage43b-hosted-surf-report-proof.js');
const DOCS = path.join(ROOT, 'docs', 'STAGE-43B-HOSTED-SURF-REPORT-PROOF.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const REPORT_JSON = path.join(ROOT, 'tmp', 'stage43b-hosted-surf-report-proof.json');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage43b-hosted-surf-report-proof.js  (Stage 43b)\n');

section('A. Files');
check('A1', fs.existsSync(PROOF_SCRIPT), 'hosted proof script exists');
check('A2', fs.existsSync(DOCS), 'stage 43b docs exist');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts['proof:stage43b-hosted-surf-report'] === 'node scripts/run-stage43b-hosted-surf-report-proof.js', 'proof package script');
check('A4', pkg.scripts['verify:stage43b-hosted-surf-report-proof'] === 'node scripts/verify-stage43b-hosted-surf-report-proof.js', 'verify package script');

try {
  execSync(`node --check "${PROOF_SCRIPT}"`, { stdio: 'ignore' });
  pass('A5', 'proof script passes node --check');
} catch (_) {
  fail('A5', 'proof script passes node --check');
}

const src = fs.readFileSync(PROOF_SCRIPT, 'utf8');

section('B. Hosted dry-run safety');
check('B1', src.includes('/staff/bot/guest-inbound-review-dry-run'), 'uses hosted review endpoint');
check('B2', src.includes('whatsapp_dry_run: true'), 'whatsapp dry-run in payload');
check('B3', src.includes('live_send_allowed: false'), 'live send blocked in payload');
check('B4', !src.includes('sendWhatsApp'), 'no WhatsApp send path');
check('B5', !src.includes('stripe.com') || src.includes('checkout\\.stripe\\.com'), 'no Stripe create path');
check('B6', !src.includes('confirmation_send'), 'no confirmation send path');
check('B7', !src.includes('n8n activate'), 'no n8n activation');

section('C. Secret safety');
check('C1', !src.includes('STORMGLASS_API_KEY'), 'script does not read API key');
check('C2', src.includes('SECRET_RE') || src.includes('secret_leak'), 'secret leak check in proof');
check('C3', !src.match(/sg_[a-z0-9]{8,}/i), 'no API key pattern in script');

section('D. Proof coverage');
for (const id of ['A_en_surf', 'B_it_surf', 'C_es_surf', 'D_de_surf', 'E_mid_booking_context']) {
  check(`D-${id}`, src.includes(id), `proof ${id}`);
}
check('D-lang-it', src.includes('Come sono le onde'), 'Italian message');
check('D-lang-es', src.includes('Qué tal las olas'), 'Spanish message');
check('D-lang-de', src.includes('Wie sind die Wellen'), 'German message');
check('D-mid', src.includes('July 1-5 for 1'), 'mid-booking turn');

section('E. Latest proof report (if run)');
if (fs.existsSync(REPORT_JSON)) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  } catch (_) {
    report = null;
  }
  if (report) {
    check('E1', report.overall === 'PASS' || report.overall === 'PARTIAL', `report overall ${report.overall}`);
    check('E2', report.safety && report.safety.secret_leak !== true, 'no secret leak in report');
    check('E3', report.safety && report.safety.whatsapp_send !== true, 'no whatsapp send in report');
    if (report.proofs) {
      for (const p of report.proofs) {
        check(`E-proof-${p.id}`, p.pass === true, `${p.id} passed hosted proof`);
      }
    }
  } else {
    fail('E0', 'report JSON unreadable');
  }
} else {
  pass('E-skip', 'no report JSON yet — run npm run proof:stage43b-hosted-surf-report');
}

console.log(`\n── Summary ──\n  PASS: ${passes}\n  FAIL: ${failures}\n`);
process.exit(failures > 0 ? 1 : 0);
