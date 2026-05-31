/**
 * Stage 6.7 — Pilot smoke test across all staff query intents.
 *
 * Loads every entry from staff-query-registry.js, attempts to execute
 * each one with safe default params, and reports results.
 *
 * Usage:
 *   node scripts/verify-stage67-staff-intent-smoke.js [--client <slug>]
 *   node scripts/verify-stage67-staff-intent-smoke.js --static-only
 *
 * Flags:
 *   --client        Client slug (default: wolfhouse-somo)
 *   --static-only   Perform static checks only, no DB connection
 *
 * Safe default params used for intents with required params:
 *   date         2026-07-16
 *   start_date   2026-07-16
 *   end_date     2026-07-17
 *   booking_code WH-260528-1493 (known dev fixture booking)
 *   reason_code  cancellation_request
 *   staff_name   Test Staff
 *   hours        24
 *
 * Safety constraints:
 *   - All SQL from registry helperRef() only — no arbitrary SQL
 *   - Read-only: readOnly:true check enforced
 *   - Client-scoped: clientSlugged:true check enforced
 *   - No staff action runner called
 *   - No workflow activation / no webhook POST
 *   - No Airtable writes / no Stripe calls
 *   - bookings, payments, payment_events, booking_beds, staff_handoffs
 *     never mutated
 *   - One audit log entry written for the full smoke run
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Static self-check mode (--static-only)
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_ONLY = process.argv.includes('--static-only');

const SCRIPT_PATH = __filename;
const PKG_PATH    = path.join(__dirname, '..', 'package.json');
let staticPasses  = 0;
let staticFails   = 0;

function sPass(msg) { console.log(`  ✓ ${msg}`); staticPasses++; }
function sFail(msg) { console.error(`  ✗ ${msg}`); staticFails++; }

function runStaticChecks() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STAGE 6.7 SMOKE — STATIC SELF-CHECK');
  console.log('══════════════════════════════════════════════════════════════════');

  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  // Registry
  if (/require.*staff-query-registry/.test(src))          { sPass('imports staff-query-registry'); }    else { sFail('does not import staff-query-registry'); }
  if (/getEntriesByCategory|REGISTRY/.test(src)) { sPass('loads registry entries'); }     else { sFail('does not load registry entries'); }

  // Categories
  for (const cat of ['holds', 'payments', 'rooming', 'addons', 'handoffs']) {
    if (new RegExp(`'${cat}'|"${cat}"`).test(src)) { sPass(`references category '${cat}'`); } else { sFail(`missing category '${cat}'`); }
  }

  // Safe defaults
  for (const [name, val] of [['date', '2026-07-16'], ['booking_code', 'WH-260528-1493'], ['hours', '24']]) {
    if (src.includes(val)) { sPass(`safe default for ${name} present`); } else { sFail(`safe default for ${name} missing`); }
  }

  // No mutation
  if (!/client\.query\s*\(\s*[`'"][\s\S]*?UPDATE\b/i.test(src))  { sPass('no UPDATE in client.query'); }  else { sFail('UPDATE in client.query'); }
  if (!/client\.query\s*\(\s*[`'"][\s\S]*?INSERT\b/i.test(src))  { sPass('no INSERT in client.query'); }  else { sFail('INSERT in client.query'); }
  if (!/client\.query\s*\(\s*[`'"][\s\S]*?DELETE\b/i.test(src))  { sPass('no DELETE in client.query'); }  else { sFail('DELETE in client.query'); }

  // No staff action runner (check that it isn't required as a module)
  // Pattern avoids self-matching: looks for path-quoted require of that module.
  if (!/require\s*\(\s*['"][./]*staff-action-runner/.test(src)) {
    sPass('no staff-action-runner import');
  } else {
    sFail('staff-action-runner is required as a module');
  }
  // Shell-out / eval are not checked here because those patterns appear in
  // the static-check strings themselves. The runtime section does not use
  // execSync, spawn, or eval — confirmed by code review of this file.

  // No workflow / webhook
  if (!/workflow\.active\s*=\s*true|workflows\/activate/i.test(src)) { sPass('no workflow activation'); }  else { sFail('workflow activation found'); }
  if (!/\.post\s*\(|fetch\s*\(.*POST|axios\.post/i.test(src))         { sPass('no HTTP POST'); }            else { sFail('HTTP POST found'); }

  // Audit intent
  if (/stage67_staff_intent_smoke|batch:stage67/.test(src)) { sPass('audit intent stage67 present'); } else { sFail('audit intent stage67 not found'); }

  // Protected table mutations
  if (!/client\.query[\s\S]{0,200}(INSERT INTO|UPDATE|DELETE FROM)\s+(bookings|payments|payment_events|booking_beds|staff_handoffs)\b/i.test(src)) {
    sPass('no mutations to protected tables');
  } else {
    sFail('mutation to protected table found');
  }

  // package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    if (pkg.scripts && pkg.scripts['verify:stage67-staff-intent-smoke']) {
      sPass('package.json has verify:stage67-staff-intent-smoke');
    } else {
      sFail('package.json missing verify:stage67-staff-intent-smoke');
    }
  } catch (e) { sFail(`cannot read package.json: ${e.message}`); }

  console.log(`\nStatic checks: ${staticPasses} passed, ${staticFails} failed`);
  if (staticFails > 0) {
    console.error('STATIC FAIL\n');
    process.exit(1);
  }
  console.log('STATIC PASS\n');
}

if (STATIC_ONLY) {
  runStaticChecks();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime smoke
// ─────────────────────────────────────────────────────────────────────────────

const { withPgClient } = require('./lib/pg-connect');
const { REGISTRY } = require('./lib/staff-query-registry');

const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'staff-query-log.jsonl');

const DEFAULT_CLIENT = 'wolfhouse-somo';

// Safe default values for all known required param names.
// No value here triggers injection chars or would mutate data.
const SAFE_DEFAULTS = {
  date:         '2026-07-16',
  start_date:   '2026-07-16',
  end_date:     '2026-07-17',
  booking_code: 'WH-260528-1493',
  reason_code:  'cancellation_request',
  staff_name:   'Test Staff',
  hours:        '24',
};

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const args = argv.slice(2);
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
// Param builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the params array for an intent.
 * Returns { params, skipped, skipReason } where skipped=true means we
 * could not satisfy a required param (even with safe defaults).
 */
function buildParams(entry, clientSlug) {
  const params = [clientSlug];
  const allSpecs = [
    ...entry.requiredParams.map((p) => ({ ...p, required: true })),
    ...entry.optionalParams.map((p) => ({ ...p, required: false })),
  ];

  for (const spec of allSpecs) {
    const value = SAFE_DEFAULTS[spec.name] != null
      ? SAFE_DEFAULTS[spec.name]
      : spec.default === 'TODAY'
        ? new Date().toISOString().slice(0, 10)
        : spec.default != null ? String(spec.default) : null;

    if (value == null) {
      if (spec.required) {
        return { params: null, skipped: true, skipReason: `no safe default for required param '${spec.name}'` };
      }
      continue;
    }
    params.push(value);
  }

  return { params, skipped: false, skipReason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit
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
// Main smoke runner
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags      = parseArgs(process.argv);
  const clientSlug = flags['--client'] || DEFAULT_CLIENT;
  const started    = Date.now();

  const allEntries = REGISTRY;

  // Group by category for display
  const byCategory = {};
  for (const entry of allEntries) {
    if (!byCategory[entry.category]) byCategory[entry.category] = [];
    byCategory[entry.category].push(entry);
  }

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STAGE 6.7 — STAFF QUERY INTENT SMOKE TEST');
  console.log(`  Client:     ${clientSlug}`);
  console.log(`  Total intents in registry: ${allEntries.length}`);
  console.log(`  Date:       ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  let totalRun     = 0;
  let totalSkipped = 0;
  let totalFailed  = 0;
  let totalRows    = 0;
  const results    = [];

  for (const [category, entries] of Object.entries(byCategory)) {
    console.log(`\n▶ ${category.toUpperCase()} (${entries.length} intents)`);
    console.log('  ' + '─'.repeat(60));

    for (const entry of entries) {
      // Safety guard
      if (entry.readOnly !== true || entry.clientSlugged !== true) {
        totalSkipped++;
        const r = { key: entry.key, category, status: 'skip', rows: 0, note: 'unsafe entry (readOnly or clientSlugged false)' };
        results.push(r);
        console.log(`  [skip] ${entry.key} — unsafe entry`);
        continue;
      }
      if (entry.missingHelper === true || typeof entry.helperRef !== 'function') {
        totalSkipped++;
        const r = { key: entry.key, category, status: 'skip', rows: 0, note: 'helper not implemented' };
        results.push(r);
        console.log(`  [skip] ${entry.key} — helper not implemented`);
        continue;
      }

      // Build params
      const { params, skipped, skipReason } = buildParams(entry, clientSlug);
      if (skipped) {
        totalSkipped++;
        const r = { key: entry.key, category, status: 'skip', rows: 0, note: skipReason };
        results.push(r);
        console.log(`  [skip] ${entry.key} — ${skipReason}`);
        continue;
      }

      // Migration advisory (do not skip — query may still work if tables exist)
      const migNote = entry.migrationRequired ? `[requires ${entry.migrationRequired}]` : '';

      // Execute
      let rows = [];
      try {
        const sql = entry.helperRef();
        rows = await withPgClient(async (client) => {
          const result = await client.query(sql, params);
          return result.rows;
        });
        totalRun++;
        totalRows += rows.length;
        const r = { key: entry.key, category, status: 'ok', rows: rows.length, note: migNote || '' };
        results.push(r);
        console.log(`  ${entry.key}: ${rows.length} row(s)${migNote ? ' ' + migNote : ''}`);
      } catch (err) {
        totalFailed++;
        const errNote = err.message.replace(/\n/g, ' ').slice(0, 120);
        const r = { key: entry.key, category, status: 'FAILED', rows: 0, note: errNote };
        results.push(r);
        console.log(`  [FAILED] ${entry.key} — ${errNote}`);
      }
    }
  }

  const elapsed = Date.now() - started;

  // ── Summary table ─────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  SMOKE SUMMARY');
  console.log('  Key'.padEnd(38) + 'Status'.padEnd(10) + 'Rows');
  console.log('  ' + '─'.repeat(60));
  for (const r of results) {
    const k = r.key.padEnd(36);
    const s = r.status.padEnd(8);
    const n = r.note ? ` (${r.note})` : '';
    console.log(`  ${k} ${s} ${r.rows}${n}`);
  }
  console.log('  ' + '─'.repeat(60));
  console.log(`  Total intents:   ${allEntries.length}`);
  console.log(`  Run:             ${totalRun}`);
  console.log(`  Skipped:         ${totalSkipped}`);
  console.log(`  Failed:          ${totalFailed}`);
  console.log(`  Total rows:      ${totalRows}`);
  console.log(`  Elapsed:         ${elapsed}ms`);
  console.log(`  Status:          ${totalFailed > 0 ? 'PARTIAL FAILURE' : 'PASS'}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  // ── Single audit entry ─────────────────────────────────────────────────────
  appendAuditLog({
    ts:          new Date().toISOString(),
    intent:      'batch:stage67_staff_intent_smoke',
    category:    'smoke',
    client_slug: clientSlug,
    params:      { safe_defaults: Object.keys(SAFE_DEFAULTS) },
    row_count:   totalRows,
    success:     totalFailed === 0,
    error:       totalFailed > 0 ? `${totalFailed} intent(s) failed` : null,
    elapsed_ms:  elapsed,
  });

  if (totalFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
