'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-rows.js'), 'utf8');

const sandbox = {
  window: {},
  document: {
    getElementById() { return null; },
    createElement() { return { textContent: '', appendChild() {} }; },
    head: { appendChild() {} },
    getElementsByTagName() { return [{ appendChild() {} }]; },
  },
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'inbox-rows.js' });

const rows = sandbox.window.__inboxRows;
assert(rows && typeof rows.ownerLabChipHtml === 'function', 'inbox rows test API is exported');

for (const row of [
  { open_phone_testing: true, guest_tester_class: 'Simulator' },
  { open_phone_testing: false, guest_tester_class: 'OWNER LAB · SIMULATOR' },
  { open_phone_testing: false, guest_tester_class: 'owner lab simulator' },
]) {
  assert.equal(rows.isOwnerLab(row), true, 'Owner Lab* / simulator row is detected');
  assert.equal(
    rows.ownerLabChipHtml(row),
    '<div class="inbox-owner-lab-chip">Owner Lab</div>',
    'Owner Lab chip label is normalized exactly',
  );
}

assert.equal(rows.ownerLabChipHtml({ open_phone_testing: false, guest_tester_class: '' }), '');

const css = rows.CSS;
assert.match(css, /\.conv-card\.inbox-row-owner-lab\{border-color:rgba\(63,146,142,\.45\)\}/,
  'Owner Lab row border is soft teal, not orange');
assert.match(css, /\.inbox-owner-lab-chip\{[^}]*background:rgba\(63,146,142,\.14\);color:#256C68[^}]*text-transform:none/s,
  'Owner Lab chip uses soft teal fill/text and preserves title case');
assert.match(css, /html\.theme-dark \.inbox-owner-lab-chip\{[^}]*rgba\(78,178,173,\.20\)[^}]*#8ED6D1/s,
  'Owner Lab chip has dark-mode teal styling');
assert.doesNotMatch(css, /\.inbox-owner-lab-chip\{[^}]*232,137,58/s,
  'Owner Lab chip no longer uses the old orange fill/border');

console.log('PASS verify-inbox-owner-lab-chip: Owner Lab* chips render exact label with soft teal light/dark styling');
