#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const planPath = path.join(root, 'LUNA-RELIABILITY.md');
const text = fs.readFileSync(planPath, 'utf8');
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

function section(heading, nextHeading) {
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) return '';
  const bodyStart = start + heading.length + 1;
  const end = nextHeading ? text.indexOf(`\n${nextHeading}\n`, bodyStart) : text.length;
  return text.slice(bodyStart, end < 0 ? text.length : end);
}

const map = section('## LR2.4 — Failure map: Closed-fixture contract / abort observability');

check('LR2.4 failure map section exists', map.length > 0);
check('LR3.2 status bar records #953 adapter landing without claiming PASS',
  map.includes('LR3.2 | Status Active')
  && map.includes('#953 Responses adapter tool_choice wire + empty_tool_calls classification merged at master tip 0deceb93')
  && map.includes('case-09 live retest remains Chief-gated')
  && map.includes('case-09 remains BLOCKED')
  && !/full LR3\.2 PASS/i.test(map.replace('not** a full LR3.2 PASS', '')));
check('master-tip metadata and adapter evidence are named',
  map.includes('#949 added metadata-first capture instrumentation at master tip `0ee15c4d`')
  && map.includes('#948 hardened the LR2 messy-pack receipt contract')
  && map.includes('#953 merged the Responses adapter `tool_choice` wire plus `empty_tool_calls` classification at master tip `0deceb93`'));
check('03/08 live execution remains held behind Chief-gated live retest',
  map.includes('03/08 live execution stays on HOLD')
  && map.includes('Next gate: Chief-gated admitted live retest before 03/08'));
check('owner boundaries keep Deckhand out of live re-QA collision',
  map.includes('Seadog owns live capture re-QA/classification')
  && map.includes('Deckhand may keep this map current and babysit fixture/doc/harness-only PRs'));

for (const closed of [
  'no `hermes-sunset-luna-http` deploy',
  'no live-eval scope expansion by Deckhand',
  'no capture-image rerun by Deckhand',
  'no `inbox-thread.js`',
  'no email inbound/poller work',
  'no Skipper-owned adapter code',
  'no `/sethome`',
  'no production',
  'no merge by Deckhand',
]) {
  check(`closed boundary retained: ${closed}`, map.includes(closed));
}

for (const unsafe of [
  /case-09\s+(?:is\s+)?PASS/i,
  /03\/08 live execution\s+(?:is\s+)?(?:clear|cleared|unblocked|ready)/i,
  /Deckhand owns .*case-09/i,
  /capture-image rerun by Deckhand\s+(?:is\s+)?(?:allowed|permitted|authorized)/i,
  /hermes-sunset-luna-http deploy\s+(?:is\s+)?(?:allowed|permitted|authorized)/i,
]) {
  check(`rejects unsafe wording: ${unsafe}`, !unsafe.test(map));
}

console.log(`\nverify-luna-reliability-lr2-failure-map: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
