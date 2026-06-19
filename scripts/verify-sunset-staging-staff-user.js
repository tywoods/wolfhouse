'use strict';

/**
 * verify:sunset-staging-staff-user
 *
 * Offline static checks for scripts/fixtures/sunset-staging-staff-user.js
 * No DB, no network.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fixtures', 'sunset-staging-staff-user.js');

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

if (!fs.existsSync(SCRIPT)) {
  console.error(`Missing ${SCRIPT}`);
  process.exit(1);
}

const src = fs.readFileSync(SCRIPT, 'utf8');

console.log('\nverify:sunset-staging-staff-user — offline staff user helper checks\n');

console.log('[1] Approved Sunset staging DB guards');
check('approved host constant present', src.includes('luna-sunset-staging-pg-app.postgres.database.azure.com'));
check('approved database constant present', src.includes('sunset_staging'));
check('rejects wolfhouse in URL', /wolfhouse/i.test(src) && src.includes('BLOCKED_URL_PATTERNS'));
check('rejects wh-staging in URL', src.includes('wh-staging'));
check('rejects production/prod in URL', src.includes('production') && src.includes('prod'));

console.log('\n[2] Explicit env gates');
check('requires ALLOW_SUNSET_STAFF_USER_SEED', src.includes('ALLOW_SUNSET_STAFF_USER_SEED'));
check('requires SUNSET_STAFF_EMAIL', src.includes('SUNSET_STAFF_EMAIL'));
check('requires SUNSET_STAFF_PASSWORD', src.includes('SUNSET_STAFF_PASSWORD'));

console.log('\n[3] Secret hygiene');
check('does not console.log password', !/console\.log\([^\)]*password/i.test(src));
check('does not console.log password_hash', !/console\.log\([^\)]*password_hash/i.test(src));
check('uses scrypt hash format', src.includes('scrypt$'));

console.log('\n[4] Sunset-only scope');
check('scopes to client slug sunset', src.includes("CLIENT_SLUG = 'sunset'") || src.includes('sunset'));
check('does not reference all_clients_emails', !src.includes('all_clients_emails'));
check('upserts staff_users by sunset client', src.includes('staff_users'));

console.log('\n[5] Idempotent upsert');
check('checks existing staff user', src.includes('existing.rows'));
check('metadata marks non-demo source', src.includes('not_demo_seed'));

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:sunset-staging-staff-user — ALL CHECKS PASSED\n');
  process.exit(0);
}

console.error(`Results: ${pass} passed, ${fail} failed`);
console.error('verify:sunset-staging-staff-user — FAILED\n');
process.exit(1);
