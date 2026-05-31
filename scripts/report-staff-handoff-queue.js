/**
 * Stage 6.3 — Staff handoff queue batch report.
 *
 * Runs all handoff-category intents from staff-query-registry.js in one pass
 * and prints a structured, section-per-intent report.
 *
 * Usage:
 *   node scripts/report-staff-handoff-queue.js [--client <slug>] [flags...]
 *
 * Optional flags:
 *   --client   Client slug (default: wolfhouse-somo)
 *   --reason   Supply reason_code for handoffs.by_reason
 *   --staff    Supply staff_name for handoffs.by_staff
 *   --booking  Supply booking_code for handoffs.by_booking
 *   --hours    Hours threshold for handoffs.stale (default: 24)
 *
 * Safety constraints:
 *   - Only handoff-category intents from staff-query-registry.js are executed
 *   - All entries are readOnly: true and clientSlugged: true
 *   - No arbitrary SQL is accepted or executed
 *   - No raw SQL is embedded; SQL comes from helperRef() only
 *   - No shell-out to staff-query-runner.js
 *   - Audit log written to logs/staff-query-log.jsonl only (no DB writes)
 *   - No workflow JSON modified; no guest workflows activated
 *   - Bookings, payments, payment_events, booking_beds, staff_handoffs,
 *     and conversations are never mutated
 *
 * Stage 6.3 is read-only. Write/action intents are Stage 6.5.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { getEntriesByCategory } = require('./lib/staff-query-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_SLUG  = 'wolfhouse-somo';
const DEFAULT_STALE_HOURS  = '24';
const MAX_COL_WIDTH        = 38;
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'staff-query-log.jsonl');

// Maps registry param names to CLI flag resolvers.
const PARAM_FLAG = {
  reason_code:  (flags) => flags['--reason'],
  staff_name:   (flags) => flags['--staff'],
  booking_code: (flags) => flags['--booking'],
  hours:        (flags) => flags['--hours'] || DEFAULT_STALE_HOURS,
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

/**
 * Returns { params, usedParams, missingRequired } for an entry.
 * missingRequired is an array of param names that were required but absent.
 */
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
      if (spec.required) {
        missingRequired.push(spec.name);
        continue;
      }
      // Optional: use default
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
// Table formatter
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
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);
  const started = Date.now();

  // ── Client slug ─────────────────────────────────────────────────────────────
  let clientSlug = flags['--client'] || DEFAULT_CLIENT_SLUG;
  if (!flags['--client']) {
    console.warn(`  [warn] No --client supplied; defaulting to '${DEFAULT_CLIENT_SLUG}'`);
  }
  if (clientSlug === 'wolfhouse') {
    clientSlug = 'wolfhouse-somo';
    console.warn(`  [warn] Expanded --client 'wolfhouse' → 'wolfhouse-somo'`);
  }

  // ── Load handoff entries from registry ──────────────────────────────────────
  const entries = getEntriesByCategory('handoffs');

  if (entries.length === 0) {
    console.error('No handoff entries found in registry.');
    process.exit(1);
  }

  // ── Report header ────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STAFF HANDOFF QUEUE REPORT');
  console.log(`  Client:  ${clientSlug}`);
  console.log(`  Intents: ${entries.length}`);
  console.log(`  Date:    ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ── Execute each intent ──────────────────────────────────────────────────────
  let totalRows = 0;
  let anyFailed = false;
  const errorSummaries = [];
  const auditParams = {};

  // Capture supplied optional param flags for audit
  if (flags['--reason'])  auditParams.reason_code  = flags['--reason'];
  if (flags['--staff'])   auditParams.staff_name   = flags['--staff'];
  if (flags['--booking']) auditParams.booking_code = flags['--booking'];
  if (flags['--hours'])   auditParams.hours        = flags['--hours'];

  for (const entry of entries) {
    const divider = '──────────────────────────────────────────────────────────────';
    console.log(divider);
    console.log(`  [${entry.key}]`);
    console.log(`  ${entry.description}`);

    // Migration advisory (non-blocking — dev DB may have it applied)
    if (entry.migrationRequired) {
      console.log(`  [requires ${entry.migrationRequired}]`);
    }

    // Safety guard: skip unsafe entries (belt-and-suspenders beyond registry guarantees)
    if (entry.readOnly !== true || entry.clientSlugged !== true) {
      console.log(`  [skip] unsafe registry entry — readOnly or clientSlugged not set`);
      console.log('');
      continue;
    }
    if (entry.missingHelper === true || typeof entry.helperRef !== 'function') {
      console.log(`  [skip] helper not implemented`);
      console.log('');
      continue;
    }

    // Resolve params
    const { params, usedParams, missingRequired } = resolveParams(entry, clientSlug, flags);

    if (missingRequired.length > 0) {
      const hints = missingRequired.map((n) => {
        const hintMap = {
          reason_code:  '--reason <reason_code>',
          staff_name:   '--staff <name>',
          booking_code: '--booking <WH-XXXXX>',
        };
        return hintMap[n] || `--${n} <value>`;
      });
      console.log(`  [skip] requires ${hints.join(', ')}`);
      console.log('');
      continue;
    }

    if (Object.keys(usedParams).length > 0) {
      console.log(`  Params: ${JSON.stringify(usedParams)}`);
    }

    // Execute query
    let rows = [];
    try {
      const sql = entry.helperRef();
      rows = await withPgClient(async (client) => {
        const result = await client.query(sql, params);
        return result.rows;
      });
    } catch (err) {
      console.log(`  [FAILED] ${err.message}`);
      anyFailed = true;
      errorSummaries.push(`${entry.key}: ${err.message}`);
      console.log('');
      continue;
    }

    totalRows += rows.length;
    const table = formatTable(rows);

    if (table) {
      console.log('');
      console.log(table);
    } else {
      console.log('  No results.');
    }
    console.log(`  ${rows.length} row(s)`);
    console.log('');
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`  Total rows across all runnable intents: ${totalRows}`);
  console.log(`  Elapsed: ${elapsed}ms`);
  if (anyFailed) {
    console.log(`  Status: PARTIAL FAILURE (see [FAILED] sections above)`);
  } else {
    console.log(`  Status: OK`);
  }
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ── Audit log ─────────────────────────────────────────────────────────────────
  appendAuditLog({
    ts:         new Date().toISOString(),
    intent:     'batch:handoffs',
    category:   'handoffs',
    client_slug: clientSlug,
    params:     auditParams,
    row_count:  totalRows,
    success:    !anyFailed,
    error:      anyFailed ? errorSummaries.join('; ') : null,
    elapsed_ms: elapsed,
  });

  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
