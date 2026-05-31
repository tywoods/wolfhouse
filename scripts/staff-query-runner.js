/**
 * Stage 6.2 — Staff query CLI runner.
 *
 * Executes a single read-only staff query intent from the registry against
 * the Wolfhouse dev Postgres DB and prints a formatted result table.
 *
 * Usage:
 *   node scripts/staff-query-runner.js <intent> [--client <slug>] [flags...]
 *
 * Examples:
 *   node scripts/staff-query-runner.js handoffs.open
 *   node scripts/staff-query-runner.js handoffs.open --client wolfhouse-somo
 *   node scripts/staff-query-runner.js payments.balance_due --client wolfhouse-somo
 *   node scripts/staff-query-runner.js rooming.arrivals --date 2026-07-07
 *   node scripts/staff-query-runner.js handoffs.by_reason --reason cancellation_request
 *   node scripts/staff-query-runner.js addons.lessons --date 2026-07-04
 *   node scripts/staff-query-runner.js handoffs.stale --hours 48
 *
 * Flags:
 *   --client   Client slug (default: wolfhouse-somo)
 *   --date     ISO date for date-based queries (YYYY-MM-DD)
 *   --start    Range start date for range queries
 *   --end      Range end date for range queries
 *   --booking  Booking code (e.g. WH-12345)
 *   --reason   Handoff reason code (e.g. cancellation_request)
 *   --staff    Staff member name/identifier
 *   --hours    Hours threshold for stale handoff queries (default: 24)
 *
 * Safety constraints:
 *   - Only registered intents from staff-query-registry.js are accepted
 *   - All entries must be readOnly: true and clientSlugged: true
 *   - No arbitrary SQL is accepted or executed
 *   - No write/action intents are in the registry
 *   - Audit log written to logs/staff-query-log.jsonl only (no DB writes)
 *   - No workflow JSON is modified; no guest workflows are activated
 *
 * Stage 6.2 is read-only. Write/action intents are Stage 6.5.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const {
  getEntry,
  INTENT_KEYS,
} = require('./lib/staff-query-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'staff-query-log.jsonl');
const MAX_COL_WIDTH = 40;

// Maps registry param names to the CLI flag that supplies them.
const PARAM_FLAG = {
  date:         (flags) => flags['--date'],
  start_date:   (flags) => flags['--start'],
  end_date:     (flags) => flags['--end'],
  booking_code: (flags) => flags['--booking'],
  reason_code:  (flags) => flags['--reason'],
  staff_name:   (flags) => flags['--staff'],
  hours:        (flags) => flags['--hours'],
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let intentKey = null;
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i];
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = val;
    } else if (!intentKey) {
      intentKey = args[i];
    }
  }

  return { intentKey, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety guards
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_INTENT_RE = /\b(write|upsert|insert|update|delete|resolve|create|assign)\b/i;
const SQL_INJECT_RE   = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

function guardEntry(entry) {
  if (!entry) return 'unknown intent';
  if (entry.missingHelper === true) return `helper not implemented: ${entry.helperFn}`;
  if (entry.readOnly !== true)      return `entry is not readOnly`;
  if (entry.clientSlugged !== true) return `entry is not client-scoped`;
  if (typeof entry.helperRef !== 'function') return `helperRef is not callable`;
  if (WRITE_INTENT_RE.test(entry.helperFn))  return `write intents are not allowed in Stage 6.2`;
  return null;
}

function guardParamValue(name, value) {
  if (value == null) return null;
  if (SQL_INJECT_RE.test(String(value))) return `unsafe characters in param '${name}'`;
  if (String(value).length > 200) return `param '${name}' too long`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Param resolution
// ─────────────────────────────────────────────────────────────────────────────

function buildQueryParams(entry, clientSlug, flags) {
  const params = [clientSlug];
  const usedParams = {};

  const allParams = [
    ...entry.requiredParams.map((p) => ({ ...p, required: true })),
    ...entry.optionalParams.map((p) => ({ ...p, required: false })),
  ];

  for (const p of allParams) {
    const resolver = PARAM_FLAG[p.name];
    let value;

    if (resolver) {
      value = resolver(flags);
    }

    if (value == null || value === '') {
      if (p.required) {
        throw new Error(
          `Missing required param '${p.name}' — supply with ${paramFlagHint(p.name)}\n` +
          `  Example: ${p.example || '(see registry)'}`
        );
      }
      // Use default for optional params
      if (p.default === 'TODAY') {
        value = new Date().toISOString().slice(0, 10);
      } else if (p.default != null) {
        value = String(p.default);
      } else {
        // No default, no value — skip (only valid if SQL truly doesn't need it,
        // but we warn so devs notice)
        continue;
      }
    }

    const guardErr = guardParamValue(p.name, value);
    if (guardErr) throw new Error(guardErr);

    params.push(value);
    usedParams[p.name] = value;
  }

  return { params, usedParams };
}

function paramFlagHint(paramName) {
  const hints = {
    date:         '--date YYYY-MM-DD',
    start_date:   '--start YYYY-MM-DD',
    end_date:     '--end YYYY-MM-DD',
    booking_code: '--booking WH-XXXXX',
    reason_code:  '--reason <reason_code>',
    staff_name:   '--staff <name>',
    hours:        '--hours <number>',
  };
  return hints[paramName] || `--${paramName} <value>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table formatter
// ─────────────────────────────────────────────────────────────────────────────

function formatTable(rows) {
  if (rows.length === 0) return null;

  const keys = Object.keys(rows[0]);
  // Compute column widths
  const widths = keys.map((k) =>
    Math.min(MAX_COL_WIDTH, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)))
  );

  const sep  = widths.map((w) => '-'.repeat(w + 2)).join('+');
  const header = keys.map((k, i) => ` ${k.padEnd(widths[i])} `).join('|');
  const lines = [sep, header, sep];

  for (const row of rows) {
    const line = keys
      .map((k, i) => {
        const val = String(row[k] ?? '');
        const truncated = val.length > MAX_COL_WIDTH ? val.slice(0, MAX_COL_WIDTH - 1) + '…' : val;
        return ` ${truncated.padEnd(widths[i])} `;
      })
      .join('|');
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
    // Audit log failure is non-fatal — report and continue
    console.warn(`  [warn] Could not write audit log: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const { intentKey, flags } = parseArgs(process.argv);

  // ── 1. Intent key required ────────────────────────────────────────────────
  if (!intentKey) {
    console.error('Usage: node scripts/staff-query-runner.js <intent> [--client <slug>] [flags...]');
    console.error(`\nAvailable intents (${INTENT_KEYS.length}):`);
    const byCategory = {};
    for (const k of INTENT_KEYS) {
      const cat = k.split('.')[0];
      (byCategory[cat] = byCategory[cat] || []).push(k);
    }
    for (const [cat, keys] of Object.entries(byCategory)) {
      console.error(`  ${cat}: ${keys.join(', ')}`);
    }
    process.exit(1);
  }

  // ── 2. Client slug ────────────────────────────────────────────────────────
  let clientSlug = flags['--client'] || DEFAULT_CLIENT_SLUG;
  if (!flags['--client']) {
    console.warn(`  [warn] No --client supplied; defaulting to '${DEFAULT_CLIENT_SLUG}'`);
  }

  // Strip common prefixes users might pass (wolfhouse → wolfhouse-somo)
  if (clientSlug === 'wolfhouse') {
    clientSlug = 'wolfhouse-somo';
    console.warn(`  [warn] Expanded --client 'wolfhouse' → 'wolfhouse-somo'`);
  }

  // ── 3. Registry lookup ────────────────────────────────────────────────────
  const entry = getEntry(intentKey);
  if (!entry) {
    console.error(`\nUnknown intent: '${intentKey}'`);
    console.error(`Run without arguments to see available intents.`);
    process.exit(1);
  }

  // ── 4. Safety checks ──────────────────────────────────────────────────────
  const guardErr = guardEntry(entry);
  if (guardErr) {
    console.error(`\nRefused to execute '${intentKey}': ${guardErr}`);
    process.exit(1);
  }

  // ── 5. Build params ───────────────────────────────────────────────────────
  let params, usedParams;
  try {
    ({ params, usedParams } = buildQueryParams(entry, clientSlug, flags));
  } catch (err) {
    console.error(`\nParam error for '${intentKey}': ${err.message}`);
    process.exit(1);
  }

  // ── 6. Header ─────────────────────────────────────────────────────────────
  console.log(`\n[ ${entry.category.toUpperCase()} ] ${entry.description}`);
  console.log(`  Intent:  ${intentKey}`);
  console.log(`  Client:  ${clientSlug}`);
  if (Object.keys(usedParams).length > 0) {
    console.log(`  Params:  ${JSON.stringify(usedParams)}`);
  }
  if (entry.migrationRequired) {
    console.log(`  Requires: ${entry.migrationRequired} (must be applied)`);
  }
  console.log('');

  // ── 7. Execute query ──────────────────────────────────────────────────────
  const started = Date.now();
  let rows = [];
  let success = false;
  let errorSummary = null;

  try {
    const sql = entry.helperRef();
    rows = await withPgClient(async (client) => {
      const result = await client.query(sql, params);
      return result.rows;
    });
    success = true;
  } catch (err) {
    errorSummary = err.message;
    console.error(`\nQuery failed: ${err.message}`);
    appendAuditLog({
      ts:         new Date().toISOString(),
      intent:     intentKey,
      category:   entry.category,
      client_slug: clientSlug,
      params:     usedParams,
      row_count:  0,
      success:    false,
      error:      errorSummary,
      elapsed_ms: Date.now() - started,
    });
    process.exit(1);
  }

  // ── 8. Output ─────────────────────────────────────────────────────────────
  const elapsed = Date.now() - started;
  const table = formatTable(rows);

  if (table) {
    console.log(table);
  } else {
    console.log('  No results.');
  }
  console.log(`\n  ${rows.length} row(s) | ${elapsed}ms`);

  // ── 9. Audit log ──────────────────────────────────────────────────────────
  appendAuditLog({
    ts:         new Date().toISOString(),
    intent:     intentKey,
    category:   entry.category,
    client_slug: clientSlug,
    params:     usedParams,
    row_count:  rows.length,
    success:    true,
    error:      null,
    elapsed_ms: elapsed,
  });
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
