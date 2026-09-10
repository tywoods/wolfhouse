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

const caseIds = [...pack.matchAll(/^\*\*LR2-M(\d{2})\b/gm)].map((m) => m[1]);
check('exactly 12 uniquely numbered closed cases',
  caseIds.length === 12
  && new Set(caseIds).size === 12
  && caseIds.join(',') === '01,02,03,04,05,06,07,08,09,10,11,12');

const ordinaryIds = [...pack.matchAll(/^\*\*LR2-O(03|08|09)\b/gm)].map((m) => m[1]);
check('ordinary 03/08/09 cases are exact and unique',
  ordinaryIds.length === 3
  && new Set(ordinaryIds).size === 3
  && ordinaryIds.join(',') === '03,08,09');

check('every case has explicit PASS assertions',
  (pack.match(/^PASS assertions:/gm) || []).length === 15);
check('every case has explicit FAIL criteria',
  (pack.match(/^FAIL if /gm) || []).length === 15);
check('global PASS FAIL BLOCKED classifications are explicit',
  pack.includes('### PASS — every item required')
  && pack.includes('### FAIL')
  && pack.includes('### BLOCKED'));
check('Staff facts bind dynamically rather than hard-coded values',
  pack.includes('Do not place current prices, capacity, offering IDs, course IDs, or inclusions')
  && pack.includes('Every factual claim equals its captured Staff read-back'));
check('per-case sanitized receipt is defined',
  pack.includes('## Per-case evidence receipt')
  && pack.includes('"classification": "PASS|FAIL|BLOCKED"')
  && pack.includes('"booking_write":0')
  && pack.includes('"whatsapp_send":0'));
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
