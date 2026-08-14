#!/usr/bin/env node
'use strict';

/*
 * Focused regression gate for Slice 1 Inbox selection safety.
 * Exercises the real selection-token helper and asserts the detail/filter owners
 * cannot let a stale conversation write after a newer selection wins.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const src = fs.readFileSync(THREAD, 'utf8');
let pass = 0;
let fail = 0;
function ok(name, condition, detail) {
  if (condition) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`);
  const end = src.indexOf('\nfunction ', start + 1);
  return start < 0 ? '' : src.slice(start, end < 0 ? src.length : end);
}

console.log('\nverify-inbox-selection-safety\n');
const helper = sliceFn('inboxSelectionIsCurrent');
ok('selection-current helper exists', !!helper);
if (helper) {
  const sandbox = { selectedConvId: 'A', inboxSelectionGeneration: 7 };
  vm.createContext(sandbox);
  vm.runInContext(`${helper}; this.current = inboxSelectionIsCurrent;`, sandbox);
  ok('A is current for its own generation', sandbox.current('A', 7) === true);
  sandbox.selectedConvId = 'B';
  sandbox.inboxSelectionGeneration = 8;
  ok('delayed A cannot write after B becomes selected', sandbox.current('A', 7) === false);
  ok('B is current only for B generation', sandbox.current('B', 8) === true);
}

const detail = sliceFn('loadConvDetail');
ok('detail starts a fresh selection generation', /var selectionGeneration\s*=\s*\+\+inboxSelectionGeneration/.test(detail));
ok('detail completion rejects stale A before detail/context/draft writes',
  /\.then\(function\(composite\)\{\s*if \(!inboxSelectionIsCurrent\(convId, selectionGeneration\)\) return;/.test(detail));
ok('detail error path rejects stale A loading/error writes',
  /\.catch\(function\(err\)\{\s*if \(!inboxSelectionIsCurrent\(convId, selectionGeneration\)\) return;/.test(detail));

const render = sliceFn('renderInbox');
ok('filter detects when its selected conversation is absent', /selectedConvId && !convs\.some/.test(render));
ok('filter clears the canonical selected ID through the selection owner', /clearInboxSelection\(\)/.test(render));
ok('filter does not auto-select the first result after clearing a hidden selection',
  /if \(!selectionDropped\)\{[\s\S]*?pickId = convs\[0\]\.conversation_id;/.test(render));
ok('neutral clear replaces both thread and Guest because detail-content is reset',
  /function clearInboxSelection\([\s\S]*?detail-content[\s\S]*?inboxEmptyDetailHtml/.test(src));

console.log(`\n── verify-inbox-selection-safety: ${pass} passed, ${fail} failed ──`);
process.exitCode = fail ? 1 : 0;
