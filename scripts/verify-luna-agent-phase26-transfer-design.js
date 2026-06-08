/**
 * Phase 26 — Design-lock verifier for Airport Transfers.
 *
 * Static doc checks only — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-26-AIRPORT-TRANSFERS-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-design';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-luna-agent-phase26-transfer-design.js  (Phase 26 design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-26-AIRPORT-TRANSFERS-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Product scope');

docMatches(doc, /Stage 26.*airport transfer|airport transfer.*Stage 26/i, 'B1', 'Stage 26 airport transfers');
docMatches(doc, /Stage 27.*guest AI|guest AI.*Stage 27|Guest AI intake.*Stage 27/i, 'B2', 'Stage 27 guest AI intake deferred');
docMatches(doc, /arrival.*departure|departure.*arrival/i, 'B3', 'arrival and departure transfers');
docMatches(doc, /flight number.*optional|optional.*flight number/i, 'B4', 'flight number optional');
docMatches(doc, /flight number alone does not|does not uniquely identify the flight date|does not determine date alone/i, 'B5', 'flight number does not determine date alone');
docMatches(doc, /lookup_date.*check-in|check-in.*arrival|arrival.*check-in/i, 'B6', 'lookup date defaults from check-in for arrival');
docMatches(doc, /lookup_date.*check-out|check-out.*departure|departure.*check-out/i, 'B7', 'lookup date defaults from check-out for departure');
docMatches(doc, /no staff review gate|No staff review gate/i, 'B8', 'no staff review gate for MVP lookup/autofill');

section('C. Data model');

docIncludes(doc, 'booking_transfers', 'C1', 'booking_transfers table');
docMatches(doc, /UNIQUE\s*\(\s*booking_id\s*,\s*direction\s*\)/i, 'C2', 'unique booking_id + direction decision');

section('D. Wolfhouse transfer rules');

docMatches(doc, /Santander|SDR/i, 'D1', 'Santander for Wolfhouse');
docMatches(doc, /Bilbao|BIO/i, 'D2', 'Bilbao for Wolfhouse');
docMatches(doc, /package.*included|included.*package|Santander.*included/i, 'D3', 'Santander package included');
docMatches(doc, /€25|2500/, 'D4', 'Santander non-package €25');
docMatches(doc, /package required|requires_package/i, 'D5', 'Bilbao package required');
docMatches(doc, /4|min_guest_count.*4|groups of 4/i, 'D6', 'Bilbao groups 4+');
docMatches(doc, /€15|1500|15\/person|per_person_price/i, 'D7', 'Bilbao €15/person extra');
docMatches(doc, /recommend.*bus|bus.*recommend/i, 'D8', 'no package/no Bilbao, recommend bus');
docMatches(doc, /no generic non-package Bilbao|No generic non-package Bilbao/i, 'D9', 'no generic non-package Bilbao price');

section('E. Multi-client config');

docMatches(doc, /client.config|client config|client-configurable|not hard-coded Wolfhouse|Do not hard-code Wolfhouse/i, 'E1', 'client-configurable airports and transfer pricing rules');

section('F. Aviationstack');

docMatches(doc, /Aviationstack|aviationstack/i, 'F1', 'Aviationstack integration');

section('G. Staff Portal UI');

docMatches(doc, /light-purple|light purple/i, 'G1', 'booking calendar light-purple Transfer pebble');
docIncludes(doc, 'Transfer', 'G2', 'Transfer pebble text');
docMatches(doc, /Flight \/ Transfer Details|Flight\/Transfer Details/i, 'G3', 'transfer details under Package');
docMatches(doc, /Add-ons.*Move Bed|Move Bed.*Add-ons|below Move Bed/i, 'G4', 'Add-ons below Move Bed');
docMatches(doc, /flight number.*edit|editable.*flight|all fields remain manually editable|all editable/i, 'G5', 'editable flight number and fields');
docMatches(doc, /lookup date.*edit|editable.*lookup|lookup_date.*editable/i, 'G6', 'editable lookup date');
docMatches(doc, /datetime-local|scheduled_at|date.time.*edit/i, 'G7', 'editable date-time');
docMatches(doc, /status.*edit|editable.*status|status.*dropdown/i, 'G8', 'editable status');
docMatches(doc, /notes.*edit|editable.*notes|Notes.*Textarea/i, 'G9', 'editable notes');

section('H. Safety rails');

docMatches(doc, /No Stripe|no Stripe|Stripe.*forbidden|Forbidden.*Stripe/i, 'H1', 'no Stripe');
docMatches(doc, /no n8n|No n8n|n8n.*forbidden|Forbidden.*n8n/i, 'H2', 'no n8n');
docMatches(doc, /live WhatsApp|Live WhatsApp|no production messaging/i, 'H3', 'no live WhatsApp');
docMatches(doc, /no guest AI intake|Guest AI intake.*Stage 27|guest AI intake.*deferred|NOT guest-facing AI/i, 'H4', 'no guest AI intake');

section('I. Roadmap 26b–26j');

for (const slice of ['26b', '26c', '26d', '26e', '26f', '26g', '26h', '26i', '26j']) {
  docIncludes(doc, slice, `I.${slice}`, `roadmap mentions ${slice}`);
}

section('J. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase26-transfer-design.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('J1', `${SCRIPT} registered`);
} else {
  fail('J1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, rel))) pass('J2', 'design verifier file exists');
else fail('J2', 'design verifier file missing');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
