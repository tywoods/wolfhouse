/**
 * Stage 6.4d — Combined staff ops digest.
 *
 * Runs all four category blocks (handoffs, payments, rooming, addons) from
 * staff-query-registry.js in one pass and prints per-category summaries
 * followed by a grand total.
 *
 * Usage:
 *   node scripts/report-staff-digest.js [--client <slug>] [flags...]
 *
 * Optional flags:
 *   --client   Client slug (default: wolfhouse-somo)
 *   --date     Date for date-based queries (lessons/yoga/rentals/meals/transfers/arrivals)
 *   --start    Range start date (rooming.occupied_beds)
 *   --end      Range end date (rooming.occupied_beds)
 *   --booking  Booking code for by-booking queries
 *
 * Safety constraints:
 *   - Only registry-approved intents are executed; no arbitrary SQL
 *   - SQL from helperRef() only — no embedded raw SQL
 *   - No shell-out to other report scripts
 *   - Single audit log entry written to logs/staff-query-log.jsonl
 *   - bookings, payments, payment_events, booking_beds, staff_handoffs
 *     and conversations are never mutated
 *   - No workflow JSON modified; no guest workflows activated
 *
 * Stage 6.4d is read-only. Write/action intents are Stage 6.5.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { getEntriesByCategory } = require('./lib/staff-query-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const MAX_COL_WIDTH       = 36;
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'staff-query-log.jsonl');

const CATEGORIES = ['handoffs', 'payments', 'rooming', 'addons'];

// Maps registry param names to CLI flag resolvers.
const PARAM_FLAG = {
  date:         (flags) => flags['--date'],
  start_date:   (flags) => flags['--start'],
  end_date:     (flags) => flags['--end'],
  booking_code: (flags) => flags['--booking'],
  reason_code:  (flags) => flags['--reason'],
  staff_name:   (flags) => flags['--staff'],
  hours:        (flags) => flags['--hours'] || '24',
};

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i];
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = val;
    }
  }
  return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety guard
// ─────────────────────────────────────────────────────────────────────────────

const SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

function guardParamValue(name, value) {
  if (value == null) return null;
  if (SQL_INJECT_RE.test(String(value))) return `unsafe characters in param '${name}'`;
  if (String(value).length > 200) return `param '${name}' too long`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Param resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveParams(entry, clientSlug, flags) {
  const params = [clientSlug];
  const usedParams = {};
  const missingRequired = [];

  const allSpecs = [
    ...entry.requiredParams.map((p) => ({ ...p, required: true })),
    ...entry.optionalParams.map((p) => ({ ...p, required: false })),
  ];

  for (const spec of allSpecs) {
    const resolver = PARAM_FLAG[spec.name];
    let value = resolver ? resolver(flags) : undefined;

    if (value == null || value === '') {
      if (spec.required) { missingRequired.push(spec.name); continue; }
      value = spec.default === 'TODAY'
        ? new Date().toISOString().slice(0, 10)
        : spec.default != null ? String(spec.default) : null;
      if (value == null) continue;
    }

    const guardErr = guardParamValue(spec.name, value);
    if (guardErr) throw new Error(guardErr);

    params.push(value);
    usedParams[spec.name] = value;
  }

  return { params, usedParams, missingRequired };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table formatter (compact — narrower columns for digest)
// ─────────────────────────────────────────────────────────────────────────────

function formatTable(rows) {
  if (rows.length === 0) return null;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.min(MAX_COL_WIDTH, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)))
  );
  const sep    = widths.map((w) => '-'.repeat(w + 2)).join('+');
  const header = keys.map((k, i) => ` ${k.padEnd(widths[i])} `).join('|');
  const lines  = [sep, header, sep];
  for (const row of rows) {
    const line = keys.map((k, i) => {
      const val = String(row[k] ?? '');
      const t   = val.length > MAX_COL_WIDTH ? val.slice(0, MAX_COL_WIDTH - 1) + '…' : val;
      return ` ${t.padEnd(widths[i])} `;
    }).join('|');
    lines.push(line);
  }
  lines.push(sep);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit log
// ─────────────────────────────────────────────────────────────────────────────

function appendAuditLog(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.warn(`  [warn] Could not write audit log: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run one category block — returns { rows, skipped, failed, errors }
// ─────────────────────────────────────────────────────────────────────────────

async function runCategory(category, clientSlug, flags) {
  const entries = getEntriesByCategory(category);
  let categoryRows = 0;
  let skipped = 0;
  const errors = [];
  const summaryLines = [];

  for (const entry of entries) {
    // Safety guard
    if (entry.readOnly !== true || entry.clientSlugged !== true) {
      skipped++;
      summaryLines.push(`  [skip] ${entry.key} — unsafe registry entry`);
      continue;
    }
    if (entry.missingHelper === true || typeof entry.helperRef !== 'function') {
      skipped++;
      summaryLines.push(`  [skip] ${entry.key} — helper not implemented`);
      continue;
    }

    // Resolve params
    const { params, usedParams, missingRequired } = resolveParams(entry, clientSlug, flags);
    if (missingRequired.length > 0) {
      skipped++;
      const hintMap = {
        date:         '--date YYYY-MM-DD',
        start_date:   '--start YYYY-MM-DD',
        end_date:     '--end YYYY-MM-DD',
        booking_code: '--booking WH-XXXXX',
        reason_code:  '--reason <code>',
        staff_name:   '--staff <name>',
      };
      const hints = missingRequired.map((n) => hintMap[n] || `--${n} <value>`);
      summaryLines.push(`  [skip] ${entry.key} — requires ${hints.join(', ')}`);
      continue;
    }

    // Execute
    let rows = [];
    try {
      const sql = entry.helperRef();
      rows = await withPgClient(async (client) => {
        const result = await client.query(sql, params);
        return result.rows;
      });
    } catch (err) {
      errors.push(`${entry.key}: ${err.message}`);
      summaryLines.push(`  [FAILED] ${entry.key} — ${err.message}`);
      continue;
    }

    categoryRows += rows.length;
    const paramStr = Object.keys(usedParams).length > 0
      ? ` (${JSON.stringify(usedParams)})`
      : '';
    summaryLines.push(`  ${entry.key}${paramStr}: ${rows.length} row(s)`);

    // Print table inline
    const table = formatTable(rows);
    if (table) {
      console.log('');
      console.log(table);
    }
  }

  return { categoryRows, skipped, errors, summaryLines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags   = parseArgs(process.argv);
  const started = Date.now();

  // ── Client slug ────────────────────────────────────────────────────────────
  let clientSlug = flags['--client'] || DEFAULT_CLIENT_SLUG;
  if (!flags['--client']) {
    console.warn(`  [warn] No --client supplied; defaulting to '${DEFAULT_CLIENT_SLUG}'`);
  }
  if (clientSlug === 'wolfhouse') {
    clientSlug = 'wolfhouse-somo';
    console.warn(`  [warn] Expanded --client 'wolfhouse' → 'wolfhouse-somo'`);
  }

  // ── Report header ──────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STAFF OPS DIGEST');
  console.log(`  Client:     ${clientSlug}`);
  console.log(`  Categories: ${CATEGORIES.join(', ')}`);
  console.log(`  Date:       ${new Date().toISOString()}`);
  const flagSummary = ['--date', '--start', '--end', '--booking']
    .filter((f) => flags[f])
    .map((f) => `${f}=${flags[f]}`)
    .join('  ');
  if (flagSummary) console.log(`  Params:     ${flagSummary}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ── Run each category ──────────────────────────────────────────────────────
  const auditParams = {};
  if (flags['--date'])    auditParams.date         = flags['--date'];
  if (flags['--start'])   auditParams.start_date   = flags['--start'];
  if (flags['--end'])     auditParams.end_date      = flags['--end'];
  if (flags['--booking']) auditParams.booking_code  = flags['--booking'];

  let grandTotal = 0;
  let grandSkipped = 0;
  let grandRun = 0;
  let anyFailed = false;
  const allErrors = [];
  const categorySummaries = {};

  for (const category of CATEGORIES) {
    console.log(`\n▶ ${category.toUpperCase()}`);
    console.log('  ' + '─'.repeat(60));

    const { categoryRows, skipped, errors, summaryLines } = await runCategory(
      category, clientSlug, flags
    );

    for (const line of summaryLines) {
      console.log(line);
    }

    const run = summaryLines.filter((l) => !l.includes('[skip]') && !l.includes('[FAILED]')).length;
    grandTotal   += categoryRows;
    grandSkipped += skipped;
    grandRun     += run;
    if (errors.length > 0) {
      anyFailed = true;
      allErrors.push(...errors);
    }

    categorySummaries[category] = { rows: categoryRows, run, skipped, failed: errors.length };
    console.log(`  — ${categoryRows} row(s) across ${run} intent(s) run`);
  }

  // ── Grand total ────────────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  GRAND TOTAL');
  for (const [cat, stats] of Object.entries(categorySummaries)) {
    console.log(`  ${cat.padEnd(10)} ${stats.rows.toString().padStart(4)} row(s)  ` +
                `(${stats.run} run, ${stats.skipped} skipped${stats.failed > 0 ? `, ${stats.failed} failed` : ''})`);
  }
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  ${'total'.padEnd(10)} ${grandTotal.toString().padStart(4)} row(s)  ` +
              `(${grandRun} run, ${grandSkipped} skipped)`);
  console.log(`  Elapsed:   ${elapsed}ms`);
  console.log(`  Status:    ${anyFailed ? 'PARTIAL FAILURE' : 'OK'}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ── Single audit entry ─────────────────────────────────────────────────────
  appendAuditLog({
    ts:          new Date().toISOString(),
    intent:      'batch:digest',
    category:    'digest',
    client_slug: clientSlug,
    params:      auditParams,
    row_count:   grandTotal,
    success:     !anyFailed,
    error:       anyFailed ? allErrors.join('; ') : null,
    elapsed_ms:  elapsed,
  });

  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
