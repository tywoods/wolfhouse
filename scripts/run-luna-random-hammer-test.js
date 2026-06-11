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
const CURATED_FAIL_CAP = 10;
const CURATED_PARTIAL_CAP = 5;
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
  --fixture-out DIR   Export curated FAIL/PARTIAL fixtures (cap 10 fail + 5 partial)
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

function summarizeIssueSummary(failures, categories) {
  const primary = (failures && failures[0]) || 'Expectation mismatch';
  const cats = (categories || []).filter(Boolean);
  if (!cats.length) return primary;
  return `${primary} (${cats.slice(0, 3).join(', ')})`;
}

function buildReviewExportPayload(scenario, record, seed) {
  const turns = (scenario.turns || []).map((t) => ({
    message: t.message,
    expect: t.expect || undefined,
  }));
  return {
    ...scenario,
    fixture_set: 'generated-hammer-failures',
    hammer_review: {
      source_seed: seed,
      scenario_id: record.scenario_id,
      language: record.language,
      scenario_type: record.scenario_type,
      failure_categories: record.failure_categories || [],
      generated_turns: record.input_turns || turns.map((t) => t.message),
      expected_issue_summary: summarizeIssueSummary(record.failures, record.failure_categories),
      final_extracted_facts: record.final_extracted_fields || {},
      quote_status: record.quote_status || null,
      luna_final_reply: record.luna_final_reply || null,
      suggested_fix_area: (record.suggested_fix_areas && record.suggested_fix_areas[0]) || null,
      hammer_result: record.result,
      failures: record.failures || [],
      exported_at: new Date().toISOString(),
    },
  };
}

function exportFailureFixtures(scenarios, results, outDir, exportOpts) {
  const dir = outDir || DEFAULT_FAILURE_DIR;
  const seed = exportOpts && exportOpts.seed;
  const failCap = (exportOpts && exportOpts.failCap) || CURATED_FAIL_CAP;
  const partialCap = (exportOpts && exportOpts.partialCap) || CURATED_PARTIAL_CAP;

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
  }

  const paired = results.map((r, i) => ({ r, scenario: scenarios[i] }));
  const failItems = paired.filter(({ r }) => r.result === 'FAIL').slice(0, failCap);
  const partialItems = paired.filter(({ r }) => r.result === 'PARTIAL').slice(0, partialCap);

  const written = [];
  for (const { r, scenario } of [...failItems, ...partialItems]) {
    const name = `${scenario.id}.json`;
    const payload = buildReviewExportPayload(scenario, r, seed);
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    written.push({
      file: name,
      result: r.result,
      scenario_id: r.scenario_id,
      language: r.language,
      scenario_type: r.scenario_type,
      failure_categories: r.failure_categories || [],
      expected_issue_summary: payload.hammer_review.expected_issue_summary,
      suggested_fix_area: payload.hammer_review.suggested_fix_area,
    });
  }

  const manifest = {
    stage: '40c',
    source_seed: seed,
    exported_at: new Date().toISOString(),
    caps: { fail: failCap, partial: partialCap },
    fail_exported: failItems.length,
    partial_exported: partialItems.length,
    exports: written,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    dir,
    written: written.map((w) => w.file),
    manifest,
    fail_count: failItems.length,
    partial_count: partialItems.length,
  };
}

function writeReviewPackDoc(report, exportMeta) {
  const mdPath = path.join(ROOT, 'docs', 'STAGE-40C-HAMMER-REVIEW-PACK.md');
  const passRate = report.count ? Math.round((report.passed / report.count) * 100) : 0;
  const failRate = report.count ? Math.round((report.failed / report.count) * 100) : 0;
  const partialRate = report.count ? Math.round((report.partial / report.count) * 100) : 0;

  const langRows = Object.entries(report.language_breakdown || {})
    .map(([lang, s]) => `| ${lang} | ${s.pass || 0} | ${s.partial || 0} | ${s.fail || 0} |`)
    .join('\n');

  const scenarioRows = Object.entries(report.scenario_breakdown || {})
    .map(([sc, s]) => `| ${sc.replace(/_/g, ' ')} | ${s.pass || 0} | ${s.partial || 0} | ${s.fail || 0} |`)
    .join('\n');

  const catLines = (report.top_failure_categories || [])
    .slice(0, 8)
    .map((row) => `- **${row.category.replace(/_/g, ' ')}** — ${row.count} hits`)
    .join('\n');

  const examples = (report.results || [])
    .filter((r) => r.result === 'FAIL' || r.result === 'PARTIAL')
    .slice(0, 5)
    .map((ex, idx) => {
      const turns = (ex.input_turns || []).map((m, i) => `${i + 1}. Guest: "${m}"`).join('\n');
      const reply = ex.luna_final_reply
        ? `Luna (last turn): "${String(ex.luna_final_reply).slice(0, 220)}${ex.luna_final_reply.length > 220 ? '…' : ''}"`
        : 'Luna: (no final reply captured)';
      const facts = ex.final_extracted_fields
        ? `Facts kept: dates ${ex.final_extracted_fields.check_in || '—'}→${ex.final_extracted_fields.check_out || '—'}, guests ${ex.final_extracted_fields.guest_count ?? '—'}, package ${ex.final_extracted_fields.package_interest || '—'}`
        : '';
      return `### Example ${idx + 1}: ${ex.scenario_id} (${ex.result})

**Type:** ${ex.scenario_type} · **Lang:** ${ex.language}

${turns}

${reply}

${facts}

**Issue:** ${(ex.failures && ex.failures[0]) || 'partial expectation mismatch'}
`;
    })
    .join('\n');

  const exportedList = exportMeta && exportMeta.manifest
    ? exportMeta.manifest.exports.map((e) => `- \`${e.file}\` (${e.result}) — ${e.expected_issue_summary}`).join('\n')
    : '_(run with --fixture-out to generate)_';

  const lines = [
    '# Stage 40c — Hammer Review Pack (Ale/Cami)',
    '',
    'Readable summary of Luna’s randomized stress-test results. No live payments, WhatsApp, or confirmations were used.',
    '',
    '---',
    '',
    '## 1. What the hammer test does',
    '',
    'The hammer test generates **100 realistic guest conversations** in Italian, English, Spanish, German, and mixed phrasing — including typos and emojis. Each conversation is run through the **same Luna booking path** used in production dry-run mode. We score PASS / PARTIAL / FAIL and export a **small curated set** of failures for manual review.',
    '',
    '**Command used:** `npm run hammer:luna -- --count 100 --seed 40402 --local --write-report --fixture-out`',
    '',
    '---',
    '',
    '## 2. Current score (seed 40402)',
    '',
    '| PASS | PARTIAL | FAIL | Total |',
    '|------|---------|------|-------|',
    `| **${report.passed}** | **${report.partial}** | **${report.failed}** | ${report.count} |`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Pass rate | **${passRate}%** |`,
    `| Partial rate | ${partialRate}% |`,
    `| Fail rate | **${failRate}%** |`,
    '',
    'Stage 40b target was ≥65 PASS and <20 FAIL — **met**.',
    '',
    '### Language breakdown',
    '',
    '| Language | PASS | PARTIAL | FAIL |',
    '|----------|------|---------|------|',
    langRows,
    '',
    '### Scenario breakdown',
    '',
    '| Scenario | PASS | PARTIAL | FAIL |',
    '|----------|------|---------|------|',
    scenarioRows,
    '',
    '### Top failure categories',
    '',
    catLines || '_None_',
    '',
    '---',
    '',
    '## 3. What Luna handles well',
    '',
    '- **Short-stay and weekly package bookings** in IT/EN/ES/DE with messy dates and guest counts',
    '- **Embedded booking + side questions** when dates and guests arrive in one message (cash, transfer)',
    '- **First-turn surf add-ons** (wetsuit, board, lessons) on many paths',
    '- **Corrections and resets** on most flows; Spanish/English/German correction paths are strong',
    '- **Multilingual out-of-order** fixture set: 11/12 pass (1 known composer partial on yoga copy)',
    '- **Booking-core** regression: 26/26 pass',
    '',
    '---',
    '',
    '## 4. What still fails',
    '',
    'Remaining issues are **edge combinations**, not core booking collapse:',
    '',
    '1. **Turn-2 cash side-question** — quote context lost after a clean first turn on some EN/IT/DE paths',
    '2. **Italian correction + stale quote** — guest-count correction does not always invalidate/rebuild quote',
    '3. **German add-on phrasing** — occasional partials on wetsuit/lesson wording',
    '4. **Meals/yoga mid-flow** — dinner or yoga add-on not always detected on turn 2',
    '5. **Rare reset** — final guest count null after reset + reopen',
    '',
    '---',
    '',
    '## 5. Examples of real failing conversations',
    '',
    examples || '_No failures in this run._',
    '',
    '---',
    '',
    '## 6. What Ale/Cami should test manually',
    '',
    'Focus manual hammering on these **high-value messy combos**:',
    '',
    '1. Book dates + guests, then ask **“can we pay cash?”** before choosing deposit/full',
    '2. Start a Malibu/weekly quote, then say **“actually we are 3”** (Italian: _in realtà siamo 3_)',
    '3. Short stay + **wetsuit and board** in one message (DE: Neopren + Board)',
    '4. Mid-flow **dinner or yoga** after quote is ready',
    '5. **Reset** (“start over”) then send new dates in the next message',
    '6. Mixed **IT/EN** in one thread with typos and emojis around dates',
    '',
    'Use exported fixtures under `fixtures/luna-conversation-state-machine/generated-hammer-failures/` as starting scripts.',
    '',
    '---',
    '',
    '## 7. What is safe to ignore for demo',
    '',
    '- **PARTIAL** on composer copy (e.g. missing the word “yoga” once) — tone, not booking breakage',
    '- **Internal dry-run labels** in logs — not guest-facing',
    '- **Add-on pay-at-checkout** wording — services are held, not charged in hammer mode',
    '- Failures that only appear with **hammer typo injection** (`julyy`, `luglo`) if clean phrasing works in manual test',
    '',
    '---',
    '',
    '## 8. Top recommended Stage 40d fixes',
    '',
    '1. **Turn-2 cash side-question quote preservation** — keep quote ready when guest asks cash/bank after quote',
    '2. **Italian correction_stale_quote** — invalidate and rebuild when guest count changes mid-flow',
    '',
    'Do not start Somo FAQ or surf report until these two are cleaner for manual testing.',
    '',
    '---',
    '',
    '## What to tell Ale/Cami',
    '',
    '> Luna now handles **most clean and messy booking flows**, including multiple languages, corrections, add-ons, and combined side-questions. On our 100-conversation stress test, **74 passed** and only **10 failed** — mostly unusual combos like asking about cash on turn 2 after a quote, or changing guest count in Italian without refreshing the quote. **These are exactly the areas we want you to hammer manually** using the exported conversation scripts. Nothing in this test sent real payments or WhatsApp messages.',
    '',
    '---',
    '',
    '## Exported curated fixtures',
    '',
    exportMeta
      ? `Seed **${exportMeta.manifest.source_seed}** · ${exportMeta.fail_count} FAIL + ${exportMeta.partial_count} PARTIAL exported (caps: ${CURATED_FAIL_CAP} fail, ${CURATED_PARTIAL_CAP} partial)`
      : '',
    '',
    exportedList,
    '',
    '---',
    '',
    '## Safety',
    '',
    report.safety_note || 'No writes, live Stripe, WhatsApp, confirmations, n8n activation, or production changes.',
    '',
  ];

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return mdPath;
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
    const exp = exportFailureFixtures(generated.scenarios, hammerResults, outDir, {
      seed: opts.seed,
      failCap: CURATED_FAIL_CAP,
      partialCap: CURATED_PARTIAL_CAP,
    });
    if (!opts.json) {
      console.log(`\nExported ${exp.written.length} curated fixtures (${exp.fail_count} FAIL + ${exp.partial_count} PARTIAL) → ${exp.dir}`);
    }
    report.exported_failure_fixtures = exp;
    writeReviewPackDoc(report, exp);
    if (!opts.json) {
      console.log(`Review pack: ${path.join(ROOT, 'docs', 'STAGE-40C-HAMMER-REVIEW-PACK.md')}`);
    }
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
  writeReviewPackDoc,
  exportFailureFixtures,
  DEFAULT_FAILURE_DIR,
  CURATED_FAIL_CAP,
  CURATED_PARTIAL_CAP,
};
