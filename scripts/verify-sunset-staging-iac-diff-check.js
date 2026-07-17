'use strict';

/**
 * Diff consistency check: DRIFT-REPORT.md must agree with live inventory fixture.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const reportPath = path.join(ROOT, 'infra/azure/sunset-staging/inventory/DRIFT-REPORT.md');
const invPath = path.join(ROOT, 'infra/azure/sunset-staging/inventory/live-inventory.normalized.json');

const report = fs.readFileSync(reportPath, 'utf8');
const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));

let failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('verify:sunset-staging-iac-diff-check — report vs fixture\n');

ok('resource count in report', report.includes(`**${inv.resourceCount}** resources`), `expected ${inv.resourceCount}`);
ok('cost amount in report', report.includes(String(inv.cost.amount)), `expected ${inv.cost.amount}`);
ok('cost currency in report', report.includes(inv.cost.currency));
ok('period from in report', report.includes(inv.cost.period.from));
ok('period to in report', report.includes(inv.cost.period.to));
ok('master sha in report', report.includes(inv.sourceMasterSha));

for (const item of inv.items) {
  ok(
    `classification row present: ${item.id}`,
    report.includes(`| ${item.id} |`) && report.includes(item.classification),
  );
}

// Ensure report does not claim declared_but_absent for core when fixture count is 0
const declaredAbsent = inv.items.filter((i) => i.classification === 'declared_but_absent').length;
ok('declared_but_absent count documented as 0 when none', declaredAbsent === 0 && report.includes('| declared_but_absent | 0 |'));

console.log(`\n── diff-check: ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
