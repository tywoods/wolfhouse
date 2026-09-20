'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(source, /STAFF_API_RUNTIME_START_TIMEOUT_MS \|\| 90000/);
assert.match(source, /Promise\.race\(\[/);
for (const [stage, runtime] of [['email_delta','EMAIL_DELTA_RUNTIME'],['email_imap','EMAIL_IMAP_RUNTIME'],['email_luna_shadow','EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME'],['email_luna_drafting','EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME']]) {
  assert.ok(source.includes(`startWithDeadline('${stage}', () => ${runtime}.start())`), `${runtime} must have a bounded pre-listen start`);
}
assert.match(source, /event: 'staff_api_runtime_start_failed'/);
console.log('PASS staff API runtime starts are bounded before socket admission');
