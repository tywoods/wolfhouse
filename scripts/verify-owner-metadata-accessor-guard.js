'use strict';

/**
 * Security gate: owner SQL may read ONLY booking_service_records.metadata->>'service_name'
 * and ->>'service_id' (the signup -> experience/camp link). Raw metadata and every other
 * JSON field MUST stay blocked. Regression guard for the validator allowance.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const { validateOwnerReadOnlySql } = require('./lib/owner-readonly-sql');

const SLUG = 'wolfhouse-somo';
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function v(sql) { return validateOwnerReadOnlySql({ sql, client_slug: SLUG }); }

console.log('verify:owner-metadata-accessor-guard — read-only\n');

// ALLOWED — the two signup-link fields
ok('metadata->>service_name allowed',
  v(`SELECT bsr.metadata->>'service_name' AS s, COUNT(*) c FROM booking_service_records bsr WHERE bsr.client_slug = $1 AND bsr.metadata->>'service_name' ILIKE '%chokes%' AND bsr.status NOT IN ('cancelled') GROUP BY 1 LIMIT 100`).ok === true);
ok('metadata->>service_id allowed',
  v(`SELECT COUNT(*) c FROM booking_service_records bsr WHERE bsr.client_slug = $1 AND bsr.metadata->>'service_id' = 'abc' LIMIT 100`).ok === true);
ok('tenant_services catalog allowed',
  v(`SELECT name, category FROM tenant_services WHERE client_slug = $1 AND active = true LIMIT 100`).ok === true);

// BLOCKED — everything else metadata
ok('bare metadata blocked',
  v(`SELECT bsr.metadata FROM booking_service_records bsr WHERE bsr.client_slug = $1 LIMIT 10`).ok === false);
ok('metadata->>created_by blocked (staff email)',
  v(`SELECT bsr.metadata->>'created_by' AS w FROM booking_service_records bsr WHERE bsr.client_slug = $1 LIMIT 10`).ok === false);
ok('metadata->>unit_cents blocked (internal pricing)',
  v(`SELECT bsr.metadata->>'unit_cents' AS u FROM booking_service_records bsr WHERE bsr.client_slug = $1 LIMIT 10`).ok === false);
ok('unqualified bare metadata blocked',
  v(`SELECT metadata FROM booking_service_records WHERE client_slug = $1 LIMIT 10`).ok === false);

console.log(`\n── owner-metadata-accessor-guard: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:owner-metadata-accessor-guard — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
