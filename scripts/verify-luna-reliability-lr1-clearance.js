#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const planPath = path.join(root, 'LUNA-RELIABILITY.md');
const APPROVED_LR1_SHA256 = '508254f497e9a2dc773134018be2737943327a771dd2de5ce27634b598f96934';
let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log(`PASS ${label}`);
    passed += 1;
  } else {
    console.error(`FAIL ${label}`);
    failed += 1;
  }
}

function section(text, heading, nextHeading) {
  const startMarker = `${heading}\n`;
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const bodyStart = start + startMarker.length;
  const end = nextHeading ? text.indexOf(`\n${nextHeading}\n`, bodyStart) : text.length;
  return text.slice(bodyStart, end < 0 ? text.length : end);
}

function hasEvery(text, exactLines) {
  return exactLines.every((line) => text.split('\n').includes(line));
}

function lr1ContractText(text) {
  const nextChapter = text.indexOf('\n## LR2.');
  return nextChapter < 0 ? text : text.slice(0, nextChapter);
}

function contractFailures(text) {
  const failures = [];
  const require = (condition, label) => { if (!condition) failures.push(label); };
  const lr1Text = lr1ContractText(text);
  const lr11 = section(lr1Text, '## LR1.1 — Booking promise', '## LR1.2 — Authority, limits and budget');
  const lr12 = section(lr1Text, '## LR1.2 — Authority, limits and budget', '## LR1.3 — Safe test path');
  const target = section(lr1Text, '### Exact target', '### Synthetic identifiers');
  const identifiers = section(lr1Text, '### Synthetic identifiers', '### Permitted-effects allowlist');
  const effects = section(lr1Text, '### Permitted-effects allowlist', '### Pause, timeout and cleanup');
  const cleanup = section(lr1Text, '### Pause, timeout and cleanup', '## LR1.4 — Test contract with Seadog');
  const success = section(lr1Text, '### Success', '### Fail');
  const fail = section(lr1Text, '### Fail', '### Blocked');
  const blocked = section(lr1Text, '### Blocked', '### Demo');
  const demo = section(lr1Text, '### Demo', '### LR1 exit evidence');

  require(crypto.createHash('sha256').update(lr1Text).digest('hex') === APPROVED_LR1_SHA256, 'complete approved LR1 contract digest');
  require(lr1Text.startsWith('# Luna Reliability — plan of record\n'), 'plan heading');
  require(hasEvery(lr1Text, [
    '**Project state:** LR1 CLEARANCE complete as a scope and admission contract. This document does not authorize a guest send, booking write, payment-link write, production operation, `/sethome`, or an Owner Lab build.',
    '**Mandatory status bar:** `Phase/chapter LRx.y | Status Not started|Ready|Active|Blocked|Done | Evidence/blocker one line | Next gate`.',
  ]), 'top-level exclusions and status bar');
  require(lr11.includes('**Sunset Somo group lessons in English and Spanish**'), 'EN/ES group-lesson scope');
  require(lr11.includes('does not redefine products, prices, schedules, capacities, inclusions, age policy, or service names'), 'service contract is referenced, not redefined');
  require(hasEvery(lr12, [
    '- **Skipper:** runtime ownership, exact artifact admission, execution ledger and safety stop authority.',
    '- **Seadog:** QA contract review and independent scoring; reports PASS/FAIL/BLOCKED with evidence. Seadog does not alter runtime.',
    '- **Deckhand:** UI-only. No runtime, prompt, fixture, Staff API, data or deployment ownership.',
    '- **Captain:** not used for routine LR1 review.',
    '- Diagnostic subset: fixtures 03/08/09; run 09 first because it already has executable coverage.',
    '- One case at a time; one retry maximum after a classified transient failure.',
    '- Maximum model wall time: 180 seconds per case, matching the existing bounded runtime convention.',
  ]), 'owners, subset and budgets');
  require(hasEvery(target, [
    '- Runtime: `hermes-sunset-luna-http` only.',
    '- Exclusion: exited send-enabled `hermes-sunset-luna` is excluded.',
    '- Environment: Lunabox Sunset staging.',
    '- Staff origin: `https://sunset-staging.lunafrontdesk.com`.',
    '- `tenant_id = sunset`.',
    '- `location_id = sunset-somo`.',
    '- Model: serving readiness must declare `gpt-5.6-sol`; a config-file default alone is not consumed-model evidence.',
  ]), 'exact target and model');
  require(identifiers.includes('`wamid.lr1.<case-id>.<nonce>`') && identifiers.includes('never caller-supplied guest text'), 'synthetic closed identity');
  require(hasEvery(effects, [
    '- authenticated readiness GET only;',
    '- in-memory readiness capture, bounded counters and redacted artifact writing.',
    '- `create_sunset_booking` — CLOSED;',
    '- `create_sunset_payment_link` and Stripe checkout — CLOSED;',
    '- WhatsApp send — CLOSED;',
    '- email send — CLOSED;',
    '- arbitrary Staff POST/mutation — CLOSED;',
    '- production and cross-tenant access — CLOSED.',
  ]), 'readiness-only allowlist and closed effects');
  require(effects.includes('No model inference is currently permitted by LR1.') && effects.includes('only a closed `03`/`08`/`09`-derived Sunset group-lesson case'), 'group-lesson inference remains blocked');
  require(!/(?:WhatsApp send|email send|create_sunset_booking|create_sunset_payment_link|production and cross-tenant access)\s*[—:-]+\s*(?:OPEN|ALLOWED|PERMITTED|AUTHORIZED)/i.test(text), 'no contradictory effect authorization');
  require(!/allow_writes\s*=\s*true/i.test(text), 'allow_writes is never enabled');
  require(!/Booking and payment writes are permitted\./i.test(text), 'no appended booking/payment authorization');
  require(!/Production access is enabled\./i.test(text), 'no appended production authorization');
  require(!/Arbitrary guest text may be submitted\./i.test(text), 'no appended arbitrary guest-text authorization');
  require(!/Model inference is currently permitted for personality\/truth cases\./i.test(text), 'no appended personality inference authorization');
  require(!/Model inference is currently permitted for case 10\./i.test(text), 'no appended out-of-subset inference authorization');
  require(cleanup.includes('180 seconds maximum') && cleanup.includes('completed counters are zero') && cleanup.includes('Unknown is not zero.'), 'timeout, zero counters and unknown handling');
  require(success.includes('all prohibited-effect completed counters are numeric zero') && success.includes('Seadog can reproduce'), 'substantive Success contract');
  require(fail.includes('completes safely and deterministically') && fail.includes('Any side-effect leak is also Fail'), 'substantive Fail contract');
  require(blocked.includes('unknown counters') && blocked.includes('Blocked is never reported as PASS.'), 'substantive Blocked contract');
  require(demo.includes('It is not a real WhatsApp message and must not contact a guest.'), 'substantive no-send Demo contract');
  require(lr1Text.includes('Live group-lesson execution remains **Blocked by design**'), 'LR1 conclusion remains readiness-only');
  return failures;
}

const text = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
const failures = contractFailures(text);
check('LR1 contract is exact and internally safe', failures.length === 0);
if (failures.length) console.error(`  Missing/unsafe: ${failures.join('; ')}`);

const mutants = [
  ['opens WhatsApp sending', text.replace('- WhatsApp send — CLOSED;', '- WhatsApp send — OPEN;')],
  ['appends WhatsApp authorization', `${text}\n- WhatsApp send — AUTHORIZED;\n`],
  ['enables booking writes', `${text}\nallow_writes=true\n`],
  ['appends booking authorization', `${text}\nBooking and payment writes are permitted.\n`],
  ['appends production authorization', `${text}\nProduction access is enabled.\n`],
  ['appends arbitrary guest-text authorization', `${text}\nArbitrary guest text may be submitted.\n`],
  ['appends personality inference authorization', `${text}\nModel inference is currently permitted for personality/truth cases.\n`],
  ['appends out-of-subset inference authorization', `${text}\nModel inference is currently permitted for case 10.\n`],
  ['changes runtime target', text.replace('- Runtime: `hermes-sunset-luna-http` only.', '- Runtime: `hermes-sunset-luna` only.')],
  ['assigns Deckhand runtime ownership', text.replace('- **Deckhand:** UI-only. No runtime, prompt, fixture, Staff API, data or deployment ownership.', '- **Deckhand:** runtime ownership.')],
  ['admits model inference now', text.replace('No model inference is currently permitted by LR1.', 'Model inference is currently permitted by LR1.')],
  ['weakens unknown-counter rule', text.replace('Unknown is not zero.', 'Unknown may be treated as zero.')],
];
for (const [label, mutant] of mutants) {
  check(`rejects mutant: ${label}`, contractFailures(mutant).length > 0);
}

console.log(`\nverify-luna-reliability-lr1-clearance: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
