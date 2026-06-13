'use strict';

/**
 * Luna nightly regression suite — multilingual, staff-portal-aligned, no live sends.
 *
 * Usage:
 *   npm run luna:nightly
 *   npm run luna:nightly -- --quick
 *   npm run luna:nightly -- --hammer-count 40 --strict
 *   node scripts/run-luna-nightly-suite.js --json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports', 'luna-nightly');
const { runHammerBatch } = require('./run-luna-random-hammer-test');
const { runConversationFixtureSetAsBatch } = require('./lib/luna-conversation-fixture-set-batch');
const { STAFF_PORTAL_CAPABILITIES } = require('./lib/luna-staff-portal-capability-matrix');

const BASE_LANGUAGES = ['en', 'de', 'it', 'es'];
const HAMMER_SEED_BASE = 60612;

function parseArgs(argv) {
  const opts = {
    quick: false,
    strict: false,
    hammerCount: 30,
    agentLimit: 40,
    json: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--quick') opts.quick = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--hammer-count') opts.hammerCount = parseInt(argv[++i], 10);
    else if (a === '--agent-limit') opts.agentLimit = parseInt(argv[++i], 10);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/run-luna-nightly-suite.js [options]

Options:
  --quick           Golden gate + verify:luna-all only (~5s)
  --strict          FAIL nightly on any PARTIAL (not just FAIL)
  --hammer-count N  Random scenarios per language (default 30)
  --agent-limit N   Agent regression cases (default 40, 0=skip)
  --json            Print full report JSON to stdout

Reports written to reports/luna-nightly/latest.json`);
}

function spawnStep(label, script, args = []) {
  const res = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    name: label,
    label,
    script,
    result: res.status === 0 ? 'PASS' : 'FAIL',
    exit_code: res.status,
    ok: res.status === 0,
    stdout_tail: (res.stdout || '').slice(-2000),
    stderr_tail: (res.stderr || '').slice(-1000),
  };
}

function summarizeBatch(name, report) {
  return {
    name,
    result: report.result,
    passed: report.passed,
    partial: report.partial,
    failed: report.failed,
    total: report.total,
    first_failure: report.first_failure || null,
    cami_score_average: report.cami_score_average,
    business_fact_safety: report.business_fact_safety,
  };
}

const GATE_SUITE_NAMES = new Set(['verify:luna-all', 'verify:luna-golden']);

function isGateSuite(summary) {
  return GATE_SUITE_NAMES.has(summary.name);
}

/** Overall label for humans; only gate suites can yield FAIL (deploy block). */
function suiteResult(summaries, strict) {
  for (const s of summaries) {
    if (!isGateSuite(s)) continue;
    if (s.result === 'FAIL' || (s.exit_code != null && s.exit_code !== 0)) return 'FAIL';
    if (strict && s.result === 'PARTIAL') return 'FAIL';
  }
  const advisory = summaries.filter((s) => !isGateSuite(s));
  if (advisory.some((s) => s.result === 'FAIL')) return 'ADVISORY_FAIL';
  if (summaries.some((s) => s.result === 'PARTIAL')) return 'PARTIAL';
  return 'PASS';
}

function nightlyExitCode(result) {
  return result === 'FAIL' ? 1 : 0;
}

async function runFixtureBatch(name, fixtureSet) {
  const report = await runConversationFixtureSetAsBatch({
    fixtureSet,
    json: true,
    returnOnly: true,
  });
  return summarizeBatch(name, report);
}

async function runHammerLanguage(lang, count, seed) {
  const report = await runHammerBatch({
    count,
    seed,
    language: lang,
    local: true,
    json: true,
    returnOnly: true,
    writeReport: false,
    fixtureOut: null,
  });
  return {
    name: `hammer-${lang}`,
    result: report.result,
    passed: report.passed,
    partial: report.partial,
    failed: report.failed,
    total: report.count,
    language: lang,
    seed,
    top_failure_categories: report.top_failure_categories || [],
    first_failure: report.top_failure_examples && report.top_failure_examples[0]
      ? {
        scenario_id: report.top_failure_examples[0].scenario_id,
        failures: report.top_failure_examples[0].failures,
      }
      : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const summaries = [];

  summaries.push(spawnStep('verify:luna-all', 'verify-luna-all.js'));
  summaries.push(spawnStep('verify:luna-golden', 'verify-luna-golden.js'));

  if (!opts.quick) {
    summaries.push(await runFixtureBatch('cami-realism', 'cami-realism'));
    summaries.push(await runFixtureBatch('multilingual-out-of-order', 'multilingual-out-of-order'));
    summaries.push(await runFixtureBatch('hammer-regressions', 'hammer-regressions'));
    summaries.push(await runFixtureBatch('faq-multilingual', 'faq-multilingual'));

    for (let i = 0; i < BASE_LANGUAGES.length; i++) {
      const lang = BASE_LANGUAGES[i];
      const seed = HAMMER_SEED_BASE + i * 1000;
      summaries.push(await runHammerLanguage(lang, opts.hammerCount, seed));
    }

    if (opts.agentLimit > 0) {
      summaries.push(spawnStep('agent-regression', 'run-luna-guest-agent-regression.js', [
        '--local',
        '--limit', String(opts.agentLimit),
        '--report', path.join(REPORT_DIR, 'agent-regression.json'),
      ]));
    }
  }

  const result = suiteResult(summaries, opts.strict);
  const gateSuites = summaries.filter(isGateSuite);
  const advisorySuites = summaries.filter((s) => !isGateSuite(s));
  const report = {
    stage: 'luna-nightly',
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    mode: opts.quick ? 'quick' : 'full',
    strict: opts.strict,
    result,
    deploy_gate: result === 'FAIL' ? 'BLOCKED' : 'OK',
    gate_policy: 'golden + verify:luna-all only (hammer/cami are advisory)',
    gate_suites: gateSuites.map((s) => ({ name: s.name, result: s.result })),
    advisory_summary: {
      fail: advisorySuites.filter((s) => s.result === 'FAIL').length,
      partial: advisorySuites.filter((s) => s.result === 'PARTIAL').length,
      pass: advisorySuites.filter((s) => s.result === 'PASS').length,
    },
    staff_portal_capabilities_tested: STAFF_PORTAL_CAPABILITIES.length,
    suites: summaries,
    safety_note: 'Local dry-run only — no WhatsApp, Stripe live, confirmations, or writes.',
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, '-');
  const stampedPath = path.join(REPORT_DIR, `${stamp}.json`);
  const latestPath = path.join(REPORT_DIR, 'latest.json');
  fs.writeFileSync(stampedPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(latestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (!opts.json) {
    console.log('\n── Luna nightly suite ──');
    console.log(`Result: ${result} · deploy gate: ${report.deploy_gate} · mode: ${report.mode}`);
    for (const s of summaries) {
      const stats = s.total != null
        ? `${s.passed}/${s.total} pass · ${s.partial || 0} partial · ${s.failed || 0} fail`
        : (s.ok ? 'ok' : `exit ${s.exit_code}`);
      const tag = isGateSuite(s) ? '[gate]' : '[advisory]';
      console.log(`  ${tag} ${s.name}: ${s.result || stats}`);
    }
    if (result === 'ADVISORY_FAIL') {
      console.log('  (advisory failures do not block deploy — fix or promote to golden)');
    }
    console.log(`Report: ${latestPath}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(nightlyExitCode(result));
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
