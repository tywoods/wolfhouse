/**
 * Regenerate + import all local bed-ops forks inactive (Assign / Reassign / Cancel).
 * Phase 3e.3b — no runtime execution, import only.
 *
 *   node scripts/import-bed-ops-local-inactive.js
 *   node scripts/import-bed-ops-local-inactive.js --verify-db
 */
const path = require('path');
const { execSync } = require('child_process');
const {
  importWorkflowInactive,
  queryN8nWorkflowActive,
  PROD_AIRTABLE_BASE_ID,
  TEST_AIRTABLE_BASE_ID,
} = require('./lib/bed-ops-local-build');

const REPO = path.join(__dirname, '..');
const BUILDS = [
  { name: 'Assign', script: 'build-assign-beds-local.js', id: 'B3c2AssignLocalPg01' },
  { name: 'Reassign', script: 'build-reassign-beds-local.js', id: 'B3c3ReassignLocal01' },
  { name: 'Cancel', script: 'build-cancel-beds-local.js', id: 'KchhRC9b3MIdkzPT' },
];

const args = process.argv.slice(2);

function runBuild(script) {
  execSync(`node scripts/${script} --import-inactive`, {
    cwd: REPO,
    stdio: 'inherit',
  });
}

console.log('Phase 3e.3b — regenerate bed-ops local forks + import inactive\n');
console.log(`Target Airtable base: ${TEST_AIRTABLE_BASE_ID} (neutralize ${PROD_AIRTABLE_BASE_ID})\n`);

for (const { name, script } of BUILDS) {
  console.log(`--- ${name} ---`);
  runBuild(script);
  console.log('');
}

if (args.includes('--verify-db')) {
  console.log('--- n8n DB workflow_entity.active (read-only) ---');
  const q = queryN8nWorkflowActive(BUILDS.map((b) => b.id));
  if (!q.ok) {
    console.log(`DB query skipped: ${q.error}`);
  } else {
    for (const row of q.rows) {
      console.log(`  ${row.name} (${row.id}): active=${row.active}`);
    }
  }
}

console.log('Done. No workflow activation or POST executed by this script.');
