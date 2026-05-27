/**
 * Phase 3c.d.1 — Main conversation/message field inventory (read-only).
 */
const fs = require('fs');
const path = require('path');
const {
  runConversationInventory,
  printConsoleSummary,
} = require('./lib/main-conversation-inventory');

const REPO_ROOT = path.join(__dirname, '..');
const REPORTS_DIR = path.join(REPO_ROOT, 'reports');

const HOSTED_PATH = path.join(
  REPO_ROOT,
  'n8n',
  'Wolfhouse Booking Assistant  - Main.json'
);
const LOCAL_PATH = path.join(
  REPO_ROOT,
  'n8n',
  'phase2',
  'Wolfhouse Booking Assistant - Main (local Stripe).json'
);

function usage() {
  console.error(`
Usage: npm run db:report:main-conversation-inventory -- [options]

Options:
  --workflow=local|hosted|both   Default: local
  --help, -h

Read-only: parses workflow JSON only.
No Postgres, Airtable, Sheets, webhooks, or workflow mutations.
Writes JSON report to reports/main-conversation-inventory-<timestamp>.json
`);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  let which = 'local';
  for (const arg of argv) {
    if (arg.startsWith('--workflow=')) which = arg.slice('--workflow='.length);
  }
  if (!['local', 'hosted', 'both'].includes(which)) {
    console.error(`Invalid --workflow=${which}`);
    process.exit(1);
  }
  return { which };
}

function main() {
  const { which } = parseArgs(process.argv.slice(2));
  const bundle = runConversationInventory({
    hostedPath: HOSTED_PATH,
    localPath: LOCAL_PATH,
    which,
  });

  if (!bundle.reports.length) {
    console.error('No workflow JSON loaded. Check paths or run build:main:local-stripe.');
    process.exit(1);
  }

  printConsoleSummary(bundle);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(REPORTS_DIR, `main-conversation-inventory-${stamp}.json`);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        phase: '3c.d.1',
        read_only: true,
        no_mutations: true,
        which,
        output_file: outPath,
        ...bundle,
      },
      null,
      2
    )
  );

  console.log(`Wrote ${outPath}`);
  process.exit(0);
}

main();
