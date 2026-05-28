/**
 * Phase 3e.3 — Main rooming/reassign static contract checker (read-only).
 */
const fs = require('fs');
const path = require('path');
const {
  runMainRoomingContractInventory,
  printConsoleSummary,
  defaultPaths,
} = require('./lib/main-rooming-contract-inventory');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');

function usage() {
  console.error(`
Usage: npm run db:report:main-rooming-contract -- [options]

Options:
  --help, -h

Read-only static checker:
- Parses workflow JSON only (Main, Reassign, Assign, Cancel)
- No Postgres/Airtable/webhook mutations
- Writes JSON report to reports/main-rooming-contract-<timestamp>.json
`);
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const paths = defaultPaths(REPO_ROOT);
  const result = runMainRoomingContractInventory({ paths });
  if (result.error || !result.report) {
    console.error(`Failed: ${result.error || 'unknown error'}`);
    process.exit(1);
  }

  const report = result.report;
  printConsoleSummary(report);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `main-rooming-contract-${stamp}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        output_file: outPath,
        ...report,
      },
      null,
      2
    )
  );

  console.log(`\nWrote ${outPath}`);
  process.exit(report.ok ? 0 : 2);
}

if (require.main === module) {
  main();
}
