'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const soul = fs.readFileSync(path.join(ROOT, 'docker/hermes-staging/SOUL.md'), 'utf8');
const spec = fs.readFileSync(path.join(ROOT, 'docs/HERMES-LUNA-FRONTDESK-AGENT-SPEC.md'), 'utf8');
const regression = fs.readFileSync(path.join(ROOT, 'scripts/verify-per-guest-dates-deposit.js'), 'utf8');

for (const [name, text] of [['SOUL', soul], ['agent spec', spec]]) {
  assert.doesNotMatch(text, /(?:deposit[^\n]{0,80}(?:€100|€200)|(?:€100|€200)[^\n]{0,80}deposit)/i, `${name} must not hard-code deposit prices`);
  assert.match(text, /Staff Pricing/i, `${name} must name Staff Pricing as authority`);
  assert.match(text, /returned[^\n]*(?:quote|payment-link)/i, `${name} must require returned tool facts`);
}
assert.match(regression, /long_stay_cents:\s*31000/);
assert.match(regression, /short_stay_cents:\s*14000/);
assert.match(regression, /assert\.equal\([^\n]*93000\)/, 'non-default Staff Pricing long-stay amount must be authoritative');
assert.match(regression, /assert\.equal\([^\n]*42000\)/, 'non-default Staff Pricing short-stay amount must be authoritative');
console.log('deposit instruction authority: PASS');
