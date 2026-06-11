'use strict';

/**
 * Stage 40a — Randomized multilingual Luna hammer test runner.
 *
 * Usage:
 *   npm run hammer:luna -- --count 100 --seed 12345 --local --write-report
 */

const fs = require('fs');
const path = require('path');

const { generateHammerScenarios, LANGUAGE_FILTERS } = require('./lib/luna-random-guest-flow-generator');
const { runConversationFixture } = require('./lib/luna-conversation-fixture-set-batch');
const {
  buildHammerResultRecord,
  HAMMER_FAILURE_CATEGORIES,
  suggestFixAreas,
} = require('./lib/luna-hammer-classifier');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'tmp');
const DEFAULT_FAILURE_CAP = 20;
const DEFAULT_FAILURE_DIR = path.join(
  ROOT, 'fixtures', 'luna-conversation-state-machine', 'generated-hammer-failures',
);

function usage() {
  console.log(`Usage: node scripts/run-luna-random-hammer-test.js [options]

Options:
  --count N           Number of generated scenarios (default 50)
  --seed N            Deterministic seed (default 40401)
  --local             Local orchestrator dry-run (default)
  --language LANG     it|en|es|de|mixed|all (default all)
  --write-report      Write JSON + markdown reports
  --fixture-out DIR   Export failing scenarios as fixtures (cap 20)
  --max-turns N       Cap turns per generated scenario
  --json              JSON report to stdout only
  --fail-fast         Stop on first FAIL
  --help              Show help

Default: review-only local dry-run — no writes, Stripe, WhatsApp, confirmations, or n8n.`);
}

function parseArgs(argv) {
  const opts = {
    count: 50,
    seed: 40401,
    local: true,
    language: 'all',
    writeReport: false,
    fixtureOut: null,
    maxTurns: null,
    json: false,
    failFast: false,
    phonePrefix: '+3460040',
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--local') opts.local = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--write-report') opts.writeReport = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--count') opts.count = parseInt(argv[++i], 10);
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--language') opts.language = argv[++i];
    else if (a === '--fixture-out') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) opts.fixtureOut = argv[++i];
      else opts.fixtureOut = DEFAULT_FAILURE_DIR;
    }
    else if (a === '--max-turns') opts.maxTurns = parseInt(argv[++i], 10);
    else if (a === '--phone-prefix') opts.phonePrefix = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
      process.exit(1);
    }
  }
  return opts;
}

function aggregateCategories(results) {
  const counts = {};
  for (const cat of HAMMER_FAILURE_CATEGORIES) counts[cat] = 0;
  for (const r of results) {
    for (const cat of r.failure_categories || []) {
      counts[cat] = (counts[cat] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}

function buildReport(opts, batch, results) {
  const byLang = {};
  const byScenario = {};
  for (const r of results) {
    byLang[r.language] = byLang[r.language] || { pass: 0, partial: 0, fail: 0 };
    byLang[r.language][r.result.toLowerCase()]++;
    const st = r.scenario_type || 'unknown';
    byScenario[st] = byScenario[st] || { pass: 0, partial: 0, fail: 0 };
    byScenario[st][r.result.toLowerCase()]++;
  }

  const topFailures = results
    .filter((r) => r.result === 'FAIL' || r.result === 'PARTIAL')
    .slice(0, 10);

  const categoryRank = aggregateCategories(results);
  const topCategories = categoryRank.slice(0, 10).map(([cat, n]) => ({ category: cat, count: n }));
  const topFixes = suggestFixAreas(categoryRank.slice(0, 5).map(([cat]) => cat)).slice(0, 5);

  return {
    stage: '40a',
    mode: 'local',
    review_only: true,
    seed: opts.seed,
    count: results.length,
    passed: results.filter((r) => r.result === 'PASS').length,
    partial: results.filter((r) => r.result === 'PARTIAL').length,
    failed: results.filter((r) => r.result === 'FAIL').length,
    result: batch.result,
    language_filter: opts.language,
    language_breakdown: byLang,
    scenario_breakdown: byScenario,
    top_failure_examples: topFailures,
    top_failure_categories: topCategories,
    recommended_stage_40b_fixes: topFixes,
    safety_note: 'No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.',
    results,
  };
}

function writeJsonReport(report, seed) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const jsonPath = path.join(TMP_DIR, `luna-hammer-report-${seed}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return jsonPath;
}

function writeMarkdownReport(report, seedsNote) {
  const mdPath = path.join(ROOT, 'docs', 'STAGE-40A-RANDOM-HAMMER-TEST-RESULTS.md');
  const lines = [
    '# Stage 40a — Random Hammer Test Results',
    '',
    `**Seeds run:** ${seedsNote}`,
    `**Count:** ${report.count}`,
    `**Result:** ${report.result}`,
    '',
    '## Totals',
    '',
    `| PASS | PARTIAL | FAIL |`,
    `|------|---------|------|`,
    `| ${report.passed} | ${report.partial} | ${report.failed} |`,
    '',
    '## Language breakdown',
    '',
    '| Language | PASS | PARTIAL | FAIL |',
    '|----------|------|---------|------|',
  ];

  for (const [lang, stats] of Object.entries(report.language_breakdown || {})) {
    lines.push(`| ${lang} | ${stats.pass || 0} | ${stats.partial || 0} | ${stats.fail || 0} |`);
  }

  lines.push('', '## Scenario breakdown', '', '| Scenario | PASS | PARTIAL | FAIL |', '|----------|------|---------|------|');
  for (const [sc, stats] of Object.entries(report.scenario_breakdown || {})) {
    lines.push(`| ${sc} | ${stats.pass || 0} | ${stats.partial || 0} | ${stats.fail || 0} |`);
  }

  lines.push('', '## Top failure categories', '');
  for (const row of report.top_failure_categories || []) {
    lines.push(`- **${row.category}** — ${row.count}`);
  }

  lines.push('', '## Top 10 failure examples', '');
  for (const ex of report.top_failure_examples || []) {
    lines.push(`### ${ex.scenario_id} (${ex.result})`);
    lines.push(`- Type: ${ex.scenario_type} · Lang: ${ex.language}`);
    lines.push(`- Categories: ${(ex.failure_categories || []).join(', ') || '—'}`);
    lines.push(`- Failures: ${(ex.failures || []).slice(0, 3).join('; ') || '—'}`);
    lines.push('');
  }

  lines.push('## Top 5 recommended fixes for Stage 40b', '');
  for (const fix of report.recommended_stage_40b_fixes || []) {
    lines.push(`1. ${fix}`);
  }

  lines.push('', '## Safety', '', report.safety_note, '');

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return mdPath;
}

function exportFailureFixtures(scenarios, results, outDir, cap) {
  const dir = outDir || DEFAULT_FAILURE_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fails = results
    .map((r, i) => ({ r, scenario: scenarios[i] }))
    .filter(({ r }) => r.result === 'FAIL')
    .slice(0, cap || DEFAULT_FAILURE_CAP);

  const written = [];
  for (const { r, scenario } of fails) {
    const name = `${scenario.id}.json`;
    const payload = {
      ...scenario,
      hammer_export: {
        exported_from: 'stage40a-hammer',
        result: r.result,
        failure_categories: r.failure_categories,
        failures: r.failures,
      },
    };
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    written.push(name);
  }
  return { dir, written };
}

async function runHammerBatch(opts) {
  if (!LANGUAGE_FILTERS.includes(opts.language)) {
    console.error(`Invalid --language ${opts.language}. Use: ${LANGUAGE_FILTERS.join(', ')}`);
    process.exit(1);
  }

  const generated = generateHammerScenarios({
    count: opts.count,
    seed: opts.seed,
    language: opts.language,
    maxTurns: opts.maxTurns,
  });

  const batch = {
    result: 'PASS',
    passed: 0,
    partial: 0,
    failed: 0,
    total: generated.scenarios.length,
  };

  const hammerResults = [];
  const runOpts = {
    referenceDate: generated.reference_date,
    phonePrefix: opts.phonePrefix,
  };

  if (!opts.json) {
    console.log('\n── Luna Random Hammer Test (Stage 40a) ──');
    console.log(`Mode: local review-only · Count: ${batch.total} · Seed: ${opts.seed} · Lang: ${opts.language}`);
  }

  for (let i = 0; i < generated.scenarios.length; i++) {
    const scenario = generated.scenarios[i];
    let flowResult;
    try {
      flowResult = await runConversationFixture(scenario, runOpts, i);
    } catch (e) {
      flowResult = {
        id: scenario.id,
        result: 'FAIL',
        failures: [`internal_error: ${e.message}`],
        turns: [],
        last_out: null,
      };
    }

    const record = buildHammerResultRecord(
      scenario,
      flowResult,
      flowResult.last_out,
      opts.seed,
    );
    hammerResults.push(record);

    if (record.result === 'PASS') batch.passed++;
    else if (record.result === 'PARTIAL') batch.partial++;
    else {
      batch.failed++;
      batch.result = 'FAIL';
    }

    if (!opts.json) {
      console.log(`  ${record.result}  ${record.scenario_id} · ${record.scenario_type} · ${record.language}`);
      if (record.failures && record.failures[0]) {
        console.log(`         ${record.failures[0]}`);
      }
    }

    if (opts.failFast && record.result === 'FAIL') break;
  }

  if (batch.failed === 0 && batch.partial > 0) batch.result = 'PARTIAL';

  const report = buildReport(opts, batch, hammerResults);

  if (opts.writeReport) {
    const jsonPath = writeJsonReport(report, opts.seed);
    const mdPath = writeMarkdownReport(report, String(opts.seed));
    if (!opts.json) {
      console.log(`\nReport JSON: ${jsonPath}`);
      console.log(`Report MD:   ${mdPath}`);
    }
    report.report_paths = { json: jsonPath, markdown: mdPath };
  }

  if (opts.fixtureOut !== null) {
    const outDir = opts.fixtureOut || DEFAULT_FAILURE_DIR;
    const exp = exportFailureFixtures(generated.scenarios, hammerResults, outDir, DEFAULT_FAILURE_CAP);
    if (!opts.json) {
      console.log(`\nExported ${exp.written.length} failure fixtures → ${exp.dir}`);
    }
    report.exported_failure_fixtures = exp;
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\n── Hammer result: ${batch.result} ──`);
    console.log(`Passed: ${batch.passed} · Partial: ${batch.partial} · Failed: ${batch.failed} / ${batch.total}`);
  }

  process.exit(batch.result === 'FAIL' ? 1 : 0);
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    usage();
    process.exit(0);
  }
  runHammerBatch(opts).catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runHammerBatch,
  buildReport,
  writeJsonReport,
  writeMarkdownReport,
  exportFailureFixtures,
  DEFAULT_FAILURE_DIR,
};
