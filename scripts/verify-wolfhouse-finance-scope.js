'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const data = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const wh = fs.readFileSync(path.join(ROOT, 'scripts/browser/wolfhouse-admin-ui.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); return; }
  fail += 1;
  console.error(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
}

ok('lodging finance fetch exists', /function fetchLodgingFinanceData/.test(data));
ok('lodging booked rows are stay totals, not sunset location',
  /LODGING_BSR_SQL[\s\S]{0,400}b\.total_amount_cents AS amount_due_cents/.test(data)
  && !/LODGING_BSR_SQL[\s\S]{0,500}location_id' = \$2/.test(data));
ok('lodging payments are client-scoped only',
  /LODGING_PAYMENTS_SQL[\s\S]{0,400}c\.slug = \$1/.test(data)
  && !/LODGING_PAYMENTS_SQL[\s\S]{0,400}location_id/.test(data));
ok('handler accepts wolfhouse-somo', /const lodging = clientSlug === 'wolfhouse-somo'/.test(api));
ok('handler still uses sunset fetch for sunset',
  /withPgClient\(\(pg\) => fetchSunsetFinanceData\(pg, \{ clientSlug, locationId \}\)\)/.test(api));
ok('handler uses lodging fetch for wolfhouse',
  /fetchLodgingFinanceData\(pg, \{ clientSlug \}\)/.test(api));
ok('UI loads finance for wolfhouse',
  /getClient\(\) === 'sunset' \|\| getClient\(\) === 'wolfhouse-somo'/.test(ui));
ok('UI paints wolfhouse finance host', /function financeSummaryHost/.test(ui)
  && /wh-admin-finance-body/.test(ui));
ok('Wolfhouse Admin loads finance on tab',
  /next === 'finance' && typeof loadAdminFinanceSummary === 'function'/.test(wh));
ok('Finance is not a Wolfhouse placeholder',
  !/finance: \{ body: 'wh-admin-finance-body'/.test(wh));

console.log(`\n── verify:wolfhouse-finance-scope: ${pass} passed, ${fail} failed ──`);
if (fail) process.exitCode = 1;
