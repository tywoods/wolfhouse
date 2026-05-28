/**
 * Phase 3d.2 — Stripe contract checker (read-only).
 */
const fs = require('fs');
const path = require('path');
const {
  buildStripeContractInventory,
  printStripeContractSummary,
} = require('./lib/stripe-contract-inventory');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');

function usage() {
  console.error(`
Usage: node scripts/report-stripe-contract.js [--help]

Read-only static checker:
- Parses workflow JSON files only
- No webhook calls, no Stripe calls, no workflow activation
- No Postgres/Airtable/Sheets mutations
- Writes JSON report to reports/stripe-contract-<timestamp>.json
`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }
  if (args.length > 0) {
    usage();
    process.exit(1);
  }

  const report = buildStripeContractInventory();
  printStripeContractSummary(report);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `stripe-contract-${stamp}.json`);
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
  console.log(`Wrote ${outPath}`);
  process.exit(report.ok ? 0 : 2);
}

if (require.main === module) {
  main();
}

