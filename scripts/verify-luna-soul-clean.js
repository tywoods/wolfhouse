'use strict';

/**
 * verify:luna-soul-clean — fail the build if the Luna SOUL contains invisible
 * unicode (zero-width joiners/spaces, BOM, directional marks).
 *
 * Why this exists: Hermes' prompt-builder has an `invisible_unicode` guard that
 * blocks the ENTIRE SOUL file when it sees one of these chars — Luna then runs
 * with NO persona and NO guardrails (silent, only a log warning). This bit us
 * hard: a "surfer-girl voice" change added ZWJ emoji (🏄‍♀️, 🧑‍🏫) and
 * disabled the whole SOUL for ~5 hours. Single-codepoint emoji (🏄, 🎓) are fine.
 */

const fs = require('fs');
const path = require('path');

const SOUL = path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md');

// Zero-width / invisible / directional chars that trip the prompt-builder guard.
// NOTE: U+FE0F (emoji variation selector) is intentionally allowed — it's common
// in normal emoji (❤️) and is not what the guard blocks.
const BAD = /[​‌‍‎‏⁠﻿­]/g;

function codeLabel(ch) {
  return 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

const text = fs.readFileSync(SOUL, 'utf8');
const hits = [];
text.split('\n').forEach((line, i) => {
  const m = line.match(BAD);
  if (m) hits.push({ line: i + 1, chars: [...new Set(m.map(codeLabel))] });
});

if (hits.length) {
  console.error('FAIL — docker/hermes-staging/SOUL.md contains invisible unicode that the');
  console.error('Hermes prompt-builder blocks. This silently disables the ENTIRE SOUL (no');
  console.error('persona, no guardrails). Offending lines:');
  hits.forEach((h) => console.error(`  line ${h.line}: ${h.chars.join(', ')}`));
  console.error('Fix: replace ZWJ emoji (e.g. 🏄‍♀️, 🧑‍🏫) with single-codepoint emoji (🏄, 🎓).');
  process.exit(1);
}

console.log('verify:luna-soul-clean PASSED — no invisible unicode in SOUL.md');
process.exit(0);
