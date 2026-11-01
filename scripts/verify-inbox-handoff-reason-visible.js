#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');

function extractFunction(name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, name);
  let brace = 0;
  let started = false;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') {
      brace += 1;
      started = true;
    } else if (ch === '}') {
      brace -= 1;
      if (started && brace === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(extractFunction('handoffLabel') + '\nthis.handoffLabel = handoffLabel;\n', sandbox);

assert.equal(sandbox.handoffLabel('human_requested'), 'Guest asked for a human');
assert.equal(
  sandbox.handoffLabel('saved_booking_confirmation_blocked:confirmation_delivery_blocked'),
  'saved_booking_confirmation_blocked:confirmation_delivery_blocked',
);
assert.notEqual(sandbox.handoffLabel('whatsapp_send_failed:WH-20270310-13389959'), 'Needs review');
assert.match(src, /handoffStaffVisibleText|booking_code/);

console.log('ok inbox shows real needs-human reason and booking ref');
