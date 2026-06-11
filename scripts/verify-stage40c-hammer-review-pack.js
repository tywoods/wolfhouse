/**
 * Stage 40c — Hammer review pack verifier.
 *
 * Usage:
 *   npm run verify:stage40c-hammer-review-pack
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REVIEW_DOC = path.join(ROOT, 'docs', 'STAGE-40C-HAMMER-REVIEW-PACK.md');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'luna-conversation-state-machine', 'generated-hammer-failures');
const MANIFEST = path.join(FIXTURE_DIR, 'manifest.json');
const RUNNER = path.join(__dirname, 'run-luna-random-hammer-test.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage40c-hammer-review-pack';
const TMP_REPORT = path.join(ROOT, 'tmp', 'luna-hammer-report-40402.json');

const { execSync } = require('child_process');
const { CURATED_FAIL_CAP, CURATED_PARTIAL_CAP } = require('./run-luna-random-hammer-test');

function isGitTracked(relPath) {
  try {
    return execSync(`git ls-files -- "${relPath}"`, { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage40c-hammer-review-pack.js  (Stage 40c)\n`);

section('A. Review pack doc');

check('A1', fs.existsSync(REVIEW_DOC), 'STAGE-40C-HAMMER-REVIEW-PACK.md exists');
const doc = fs.existsSync(REVIEW_DOC) ? fs.readFileSync(REVIEW_DOC, 'utf8') : '';
check('A2', /74\s+PASS|74 \| \*\*16\*\*|74 \| \*\*16\*\* \| \*\*10\*\*/.test(doc) || doc.includes('**74**'), 'includes current 40402 PASS score (74)');
check('A3', doc.includes('10') && (doc.includes('FAIL') || doc.includes('Fail rate')), 'includes fail breakdown');
check('A4', /Top failure categories|failure categories/i.test(doc), 'includes top failure categories');
check('A5', /What to tell Ale\/Cami|Ale\/Cami/i.test(doc), 'includes owner-facing summary');
check('A6', /test manually|manual/i.test(doc), 'includes manual testing suggestions');
check('A7', /What the hammer test does/i.test(doc), 'explains hammer test');

section('B. Exported fixtures');

check('B1', fs.existsSync(FIXTURE_DIR), 'generated-hammer-failures directory exists');
check('B2', fs.existsSync(MANIFEST), 'manifest.json exists');

let manifest = null;
let fixtureFiles = [];
if (fs.existsSync(FIXTURE_DIR)) {
  fixtureFiles = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
}
if (fs.existsSync(MANIFEST)) {
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) { manifest = null; }
}

const failExported = manifest ? manifest.fail_exported : fixtureFiles.length;
const partialExported = manifest ? manifest.partial_exported : 0;
const totalExported = fixtureFiles.length;

check('B3', totalExported <= CURATED_FAIL_CAP + CURATED_PARTIAL_CAP, `exported fixtures capped (${totalExported} ≤ ${CURATED_FAIL_CAP + CURATED_PARTIAL_CAP})`);
check('B4', (manifest ? manifest.fail_exported : 0) <= CURATED_FAIL_CAP, `FAIL exports ≤ ${CURATED_FAIL_CAP}`);
check('B5', (manifest ? manifest.partial_exported : 0) <= CURATED_PARTIAL_CAP, `PARTIAL exports ≤ ${CURATED_PARTIAL_CAP}`);

if (fixtureFiles.length > 0) {
  const sample = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, fixtureFiles[0]), 'utf8'));
  const hr = sample.hammer_review || {};
  check('B6', hr.source_seed != null, 'fixture has source_seed metadata');
  check('B7', hr.scenario_id && hr.language && hr.scenario_type, 'fixture has scenario/language metadata');
  check('B8', Array.isArray(hr.failure_categories), 'fixture has failure_categories');
  check('B9', hr.expected_issue_summary && hr.suggested_fix_area !== undefined, 'fixture has issue summary + fix area');
  check('B10', Array.isArray(hr.generated_turns) && hr.final_extracted_facts, 'fixture has turns + final facts');
} else {
  fail('B6', 'no fixture files to inspect metadata');
}

section('C. No huge raw JSON committed');

const tmpExists = fs.existsSync(TMP_REPORT);
check('C1', !tmpExists || fs.statSync(TMP_REPORT).size < 500000, 'tmp hammer report size OK if present');
check('C2', !isGitTracked('tmp/luna-hammer-report-40402.json'), 'raw hammer JSON not git-tracked');

section('D. Package + safety');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('D1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');
check('D2', !runnerSrc.match(/sends_whatsapp:\s*true|graph\.facebook\.com/i), 'no WhatsApp send path');
check('D3', !runnerSrc.includes('checkout.sessions.create'), 'no Stripe path');
check('D4', !runnerSrc.includes('sendConfirmation'), 'no confirmation send path');
check('D5', !runnerSrc.includes('n8n.activate'), 'no n8n activation');

console.log(`\n${'─'.repeat(60)}`);
console.log(`Stage 40c verifier: ${failures === 0 ? 'PASS' : 'FAIL'} (${passes} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
