#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const i18n = fs.readFileSync(path.join(root, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(root, 'scripts/lib/staff-portal-i18n-es.js'), 'utf8');
const esFill = fs.readFileSync(path.join(root, 'scripts/lib/staff-portal-i18n-es-fill.js'), 'utf8');
const itFill = fs.readFileSync(path.join(root, 'scripts/lib/staff-portal-i18n-it-fill.js'), 'utf8');
const thread = fs.readFileSync(path.join(root, 'scripts/browser/inbox-thread.js'), 'utf8');

function packSlice(src, startMark) {
  const start = src.indexOf(startMark);
  assert.ok(start >= 0, startMark);
  return src.slice(start, start + 2200);
}

const en = packSlice(i18n, "'inbox.detail.clearThread.button'");
assert.match(en, /'inbox\.detail\.clearThread\.button': 'Reset'/);
assert.match(en, /'inbox\.detail\.clearThread\.confirm': 'Reset'/);
assert.match(en, /'inbox\.detail\.clearThread\.title': 'Reset Luna session\?'/);
assert.doesNotMatch(en, /'inbox\.detail\.clearThread\.button': 'Clear'/);

const it = packSlice(i18n, "'inbox.detail.clearThread.button': 'Reimposta'");
assert.match(it, /'inbox\.detail\.clearThread\.button': 'Reimposta'/);
assert.match(it, /'inbox\.detail\.clearThread\.confirm': 'Reimposta'/);

assert.match(es, /"inbox\.detail\.clearThread\.button": "Restablecer"/);
assert.match(es, /"inbox\.detail\.clearThread\.confirm": "Restablecer"/);
assert.match(esFill, /"inbox\.detail\.clearThread\.button": "Restablecer"/);
assert.match(esFill, /"inbox\.detail\.clearThread\.confirm": "Restablecer"/);
assert.match(itFill, /"inbox\.detail\.clearThread\.button": "Reimposta"/);
assert.match(itFill, /"inbox\.detail\.clearThread\.confirm": "Reimposta"/);

assert.match(thread, /\|\| 'Reset'/);
assert.match(thread, /\|\| 'Reset Luna session\?'/);
assert.doesNotMatch(thread, /\|\| 'Clear'/);

console.log('ok inbox Clear renamed to Reset');
