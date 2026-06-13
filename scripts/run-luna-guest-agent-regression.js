/**
 * Stage 56 — Luna guest agent regression runner (100 randomized cases).
 *
 * Runs focused booking-flow fixtures locally or against staging, emitting a
 * JSON report agents can consume for fix loops.
 *
 * Usage:
 *   npm run luna:agent-regression:generate
 *   npm run luna:agent-regression -- --local
 *   npm run luna:agent-regression -- --local --report .tmp-agent-regression-report.json
 *   npm run luna:agent-regression -- --base-url https://staff-staging.lunafrontdesk.com --endpoint --limit 20
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_FIXTURE = path.join(__dirname, 'fixtures', 'generated-luna-guest-agent-regression.json');
const GENERATOR = path.join(__dirname, 'generate-luna-guest-agent-regression-fixtures.js');
const TORTURE_RUNNER = path.join(__dirname, 'run-luna-guest-torture-tests.js');

function usage() {
  console.log(`Usage: node scripts/run-luna-guest-agent-regression.js [options]

Options:
  --local              Run orchestrator in-process (default when no --endpoint)
  --endpoint           POST to staff API dry-run routes
  --base-url URL       Staging/local staff API base
  --limit N            Run first N cases
  --category CAT       Filter category (package_tier_intake, payment_phrase, ...)
  --report PATH        Write JSON report to file (default: .tmp-agent-regression-report.json)
  --regenerate         Regenerate fixture before run
  --fail-fast          Stop on first failure
  --help               Show help

Agent loop:
  1. npm run luna:agent-regression:generate
  2. npm run luna:agent-regression -- --local
  3. Fix failures listed in report → re-run until pass rate is 100%`);
}

function parseArgs(argv) {
  const opts = {
    local: false,
    endpoint: false,
    baseUrl: null,
    limit: null,
    category: null,
    report: path.join(process.cwd(), '.tmp-agent-regression-report.json'),
    regenerate: false,
    failFast: false,
    help: false,
    fixtureFile: DEFAULT_FIXTURE,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--endpoint') opts.endpoint = true;
    else if (a === '--regenerate') opts.regenerate = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--base-url' && argv[i + 1]) { opts.baseUrl = argv[++i]; }
    else if (a === '--limit' && argv[i + 1]) { opts.limit = Number(argv[++i]); }
    else if (a === '--category' && argv[i + 1]) { opts.category = argv[++i]; }
    else if (a === '--report' && argv[i + 1]) { opts.report = path.resolve(argv[++i]); }
    else if (a === '--fixture-file' && argv[i + 1]) { opts.fixtureFile = path.resolve(argv[++i]); }
  }
  if (!opts.endpoint) opts.local = true;
  return opts;
}

function ensureFixture(opts) {
  if (opts.regenerate || !fs.existsSync(opts.fixtureFile)) {
    const genArgs = ['node', GENERATOR, '--output', opts.fixtureFile];
    const gen = spawnSync(genArgs[0], genArgs.slice(1), { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    if (gen.status !== 0) {
      console.error(gen.stderr || gen.stdout);
      process.exit(1);
    }
    if (gen.stdout) process.stdout.write(gen.stdout);
  }
}

function enrichReportForAgent(report) {
  const hints = {
    'extracted_fields.guest_name must not': 'scripts/lib/luna-guest-message-intake.js parseGuestNameAnswer / isPackageTierGuestMessage',
    'extracted_fields.package_interest': 'scripts/lib/luna-guest-message-router.js extractBookingFields tier before guest_name',
    'payment_choice expected deposit': 'scripts/lib/luna-guest-payment-choice-dry-run.js detectPaymentChoiceFromMessage',
    'reply_must_not_contain': 'scripts/lib/luna-guest-frontdesk-reply.js or package choice composer — tier already selected',
    'handoff_required': 'scripts/lib/luna-guest-message-router.js intake readiness / quote chain',
  };
  const enrichedFailures = (report.failures || []).map((f) => {
    const hint = Object.entries(hints).find(([k]) => String(f.first_failure || '').includes(k));
    return {
      ...f,
      fix_hint: hint ? hint[1] : 'scripts/run-luna-guest-flow-batch.js checkFlowExpectations + orchestrator chain',
      agent_action: 'Reproduce with npm run luna:agent-regression -- --local --category ' + (f.category || 'unknown'),
    };
  });
  return {
    ...report,
    harness: 'stage56-agent-regression',
    agent_instructions: [
      'Fix root cause in hinted file(s), not individual test cases.',
      'Re-run: npm run luna:agent-regression -- --local',
      'Target: 100% pass rate on all 100 cases.',
    ],
    failures: enrichedFailures,
  };
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  ensureFixture(opts);

  const runnerArgs = [
    TORTURE_RUNNER,
    '--fixture-file', opts.fixtureFile,
    '--json',
  ];
  if (opts.local) runnerArgs.push('--local');
  if (opts.endpoint) runnerArgs.push('--endpoint');
  if (opts.baseUrl) runnerArgs.push('--base-url', opts.baseUrl);
  if (opts.limit != null) runnerArgs.push('--limit', String(opts.limit));
  if (opts.category) runnerArgs.push('--category', opts.category);
  if (opts.failFast) runnerArgs.push('--fail-fast');

  const run = spawnSync('node', runnerArgs, {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..'),
    maxBuffer: 20 * 1024 * 1024,
  });

  let report;
  try {
    report = JSON.parse(run.stdout.trim());
  } catch (err) {
    console.error('Failed to parse torture runner JSON output');
    if (run.stdout) console.log(run.stdout);
    if (run.stderr) console.error(run.stderr);
    process.exit(run.status || 1);
  }

  const agentReport = enrichReportForAgent(report);
  agentReport.exit_code = run.status;
  fs.writeFileSync(opts.report, `${JSON.stringify(agentReport, null, 2)}\n`, 'utf8');

  console.log(`\n── Agent Regression Report ──`);
  console.log(`Total:     ${agentReport.total}`);
  console.log(`Passed:    ${agentReport.passed}`);
  console.log(`Failed:    ${agentReport.failed}`);
  console.log(`Pass rate: ${agentReport.pass_rate_pct}%`);
  console.log(`Report:    ${opts.report}`);

  if (agentReport.failed > 0) {
    console.log('\nFirst failures (up to 10):');
    for (const f of agentReport.failures.slice(0, 10)) {
      console.log(`  [${f.id}] ${f.first_failure}`);
      console.log(`    hint: ${f.fix_hint}`);
    }
  }

  process.exit(run.status || 0);
}

if (require.main === module) main();
