'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const packPath = path.join(ROOT, 'docs/LUNA-RELIABILITY-LR2-MESSY-GUEST-PACK.md');
const pack = fs.readFileSync(packPath, 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function sectionFor(caseId, nextCaseId) {
  const start = pack.indexOf(`**${caseId} `);
  const end = nextCaseId ? pack.indexOf(`**${nextCaseId} `, start + 1) : pack.indexOf('## Per-case evidence receipt', start + 1);
  return start >= 0 && end > start ? pack.slice(start, end) : '';
}

check('pack is Sunset Somo EN/ES group-lesson scoped',
  pack.includes('ordinary fixtures 03/08/09 plus the 12-case EN/ES messy group-lesson pack')
  && pack.includes('tenant `sunset`')
  && pack.includes('location `sunset-somo`'));

check('execution requires Healthy exact runtime and Chief LR2-start',
  pack.includes('`hermes-sunset-luna-http` revision is **Healthy**')
  && pack.includes('Chief must issue an explicit **LR2-start** signal'));

for (const boundary of [
  'no live WhatsApp turns',
  '`create_sunset_booking`',
  'payment-link/Stripe',
  'waiver mutation',
  'handoff mutation',
  'production',
  '`/sethome`',
]) {
  check(`closed boundary documented: ${boundary}`, pack.includes(boundary));
}

for (const route of [
  '/staff/bot/sunset/catalog',
  '/staff/bot/sunset/lesson-availability',
  '/staff/bot/sunset/offering-quote',
]) {
  check(`read-back route documented: ${route}`, pack.includes(route));
}

for (const family of [
  'F1 — corrections',
  'F2 — out-of-order details',
  'F3 — side questions',
  'F4 — unavailable options',
  'F5 — language switches',
  'F6 — repeated confirmations',
]) {
  check(`behavior family documented: ${family}`, pack.includes(family));
}

const messyCaseIds = Array.from({ length: 12 }, (_, i) => `LR2-M${String(i + 1).padStart(2, '0')}`);
const foundMessyIds = [...pack.matchAll(/^\*\*(LR2-M\d{2})\b/gm)].map((match) => match[1]);
check('exactly M01-M12 uniquely numbered closed cases',
  foundMessyIds.length === 12
  && new Set(foundMessyIds).size === 12
  && foundMessyIds.join(',') === messyCaseIds.join(','));

const ordinaryIds = [...pack.matchAll(/^\*\*LR2-O(03|08|09)\b/gm)].map((match) => match[1]);
check('ordinary 03/08/09 cases are exact and unique',
  ordinaryIds.length === 3
  && new Set(ordinaryIds).size === 3
  && ordinaryIds.join(',') === '03,08,09');

check('every case has explicit PASS assertions', (pack.match(/^PASS assertions:/gm) || []).length === 15);
check('every case has explicit FAIL criteria', (pack.match(/^FAIL if /gm) || []).length === 15);
check('global PASS FAIL BLOCKED classifications are explicit',
  pack.includes('### PASS — every item required')
  && pack.includes('### FAIL')
  && pack.includes('### BLOCKED'));
check('Staff facts bind dynamically rather than hard-coded values',
  pack.includes('Do not place current prices, capacity, offering IDs, course IDs, or inclusions')
  && pack.includes('Every factual claim equals its captured Staff read-back'));

for (let i = 0; i < messyCaseIds.length; i += 1) {
  const caseId = messyCaseIds[i];
  const section = sectionFor(caseId, messyCaseIds[i + 1]);
  check(`${caseId} has explicit PASS and FAIL acceptance`,
    section.includes('PASS assertions:') && section.includes('FAIL if '));
}

check('M01-M12 require one sanitized receipt each',
  pack.includes('Required receipt IDs: `LR2-M01` through `LR2-M12`, one receipt per admitted case')
  && pack.includes('A missing, duplicate, or unparseable M01–M12 receipt classifies the pack BLOCKED'));

const zeroEffectKeys = [
  'whatsapp_send',
  'email_send',
  'booking_write',
  'payment_write',
  'waiver_write',
  'handoff_write',
  'other_staff_write',
  'journal',
  'persistence',
];
for (const key of zeroEffectKeys) {
  check(`receipt requires numeric zero ${key}`, pack.includes(`"${key}":0`));
}
check('unknown or nonzero effect classification is fail closed',
  pack.includes('Any nonzero completed effect is FAIL')
  && pack.includes('Any missing, nonnumeric, negative, or otherwise unknown effect counter is BLOCKED'));

check('sealed case-09 receipt is cross-linked without overclaiming PASS',
  pack.includes('`LR3-CASE09-EVIDENCE-001`')
  && pack.includes('Discord source tip `1547676734076362963`')
  && pack.includes('SHA-256 `d0d996046112c94533e79aa5f360e25e4ade91648d0d3c695cd3f76372660e15`')
  && pack.includes('classified **BLOCKED** (`required_tool_sequence_incomplete`)')
  && pack.includes('not an LR2 PASS receipt'));

check('pack-level denominator and halt rules are defined',
  pack.includes('all 15 cases (O03/O08/O09 plus M01..M12) PASS individually')
  && pack.includes('Run O09 first, then O03/O08, then M01..M12')
  && pack.includes('One FAIL makes the pack FAIL')
  && pack.includes('Any BLOCKED case makes the pack BLOCKED'));
check('execution blockers and next gate are explicit',
  pack.includes('## Pack-level acceptance and blockers')
  && pack.includes('Current blockers to execution')
  && pack.includes('Next gate: corpus PR reviewed + Healthy hermes-sunset-luna-http + Chief LR2-start'));

console.log(`\nLR2.1/LR2.2 Seadog corpus QA contract: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
