/**
 * Phase 3c.f.2 — Main payment/confirmation contract checker (read-only).
 */
const fs = require('fs');
const path = require('path');
const {
  runMainPaymentContractInventory,
  printConsoleSummary,
} = require('./lib/main-payment-contract-inventory');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');
const LOCAL_MAIN_PATH = path.join(
  REPO_ROOT,
  'n8n',
  'phase2',
  'Wolfhouse Booking Assistant - Main (local Stripe).json'
);

function usage() {
  console.error(`
Usage: npm run db:report:main-payment-contract -- [options]

Options:
  --workflow=<path>   Optional custom workflow JSON path
  --help, -h

Read-only static checker:
- Parses workflow JSON only
- No Postgres, Airtable, Stripe, Sheets, webhook, or workflow mutations
- Writes JSON report to reports/main-payment-contract-<timestamp>.json
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  let workflowPath = LOCAL_MAIN_PATH;
  for (const arg of argv) {
    if (arg.startsWith('--workflow=')) {
      const p = arg.slice('--workflow='.length);
      workflowPath = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
    }
  }
  return { workflowPath };
}

function main() {
  const { workflowPath } = parseArgs(process.argv.slice(2));
  const result = runMainPaymentContractInventory({ workflowPath });
  if (result.error || !result.report) {
    console.error(`Failed to load workflow: ${result.error || 'unknown error'}`);
    process.exit(1);
  }

  const report = result.report;
  printConsoleSummary(report);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `main-payment-contract-${stamp}.json`);
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

