'use strict';

/**
 * Prebuild/CI guard — fail loudly if SOUL (or other prompt files) contain invisible
 * unicode that Hermes' prompt-builder blocks (ZWJ emoji, ZWSP, BOM, etc.).
 * Without this, Luna runs with NO persona and NO guardrails — silently.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = ['docker/hermes-staging/SOUL.md'];
const BAD = /[\u200b-\u200f\u2060\ufeff]/g;

let bad = false;
for (const f of FILES) {
  const abs = path.join(ROOT, f);
  const hits = [
    ...new Set(
      [...fs.readFileSync(abs, 'utf8').matchAll(BAD)].map(
        (m) => 'U+' + m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
      ),
    ),
  ];
  if (hits.length) {
    console.error(`✗ ${f}: invisible unicode ${hits.join(', ')} — Hermes will BLOCK the whole file`);
    bad = true;
  } else {
    console.log(`✓ ${f}: clean`);
  }
}
process.exit(bad ? 1 : 0);
