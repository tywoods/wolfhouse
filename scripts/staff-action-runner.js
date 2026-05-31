/**
 * Stage 6.5b — Staff action runner with confirmed write gate.
 *
 * Supports one action:
 *   handoff.resolve  — mark an open staff handoff resolved
 *
 * Usage (proposal — no DB write):
 *   node scripts/staff-action-runner.js \
 *     --client wolfhouse-somo \
 *     --action handoff.resolve \
 *     --handoff-id <uuid> \
 *     --resolution "Resolved" \
 *     --staff "Name" \
 *     --dry-run
 *
 * Usage (confirmed write — executes UPDATE):
 *   node scripts/staff-action-runner.js \
 *     --client wolfhouse-somo \
 *     --action handoff.resolve \
 *     --handoff-id <uuid> \
 *     --resolution "Resolved" \
 *     --staff "Name" \
 *     --confirm
 *
 * CLI flags:
 *   --client       Client slug (default: wolfhouse-somo)
 *   --action       Action key from the allowlist
 *   --handoff-id   UUID of the target staff_handoffs row
 *   --resolution   Resolution summary text (required)
 *   --staff        Resolving staff member name (required)
 *   --dry-run      Proposal mode — prints proposal, no DB write (default if no --confirm)
 *   --confirm      Executes the UPDATE against staff_handoffs
 *
 * Safety constraints:
 *   - Confirmed write only affects staff_handoffs (one row, client-scoped)
 *   - bookings, payments, payment_events, booking_beds are never touched
 *   - Only actions in ACTION_ALLOWLIST may be confirmed — no arbitrary SQL
 *   - resolveHandoffSql() used exclusively in the --confirm branch
 *   - No workflow JSON modified; no guest workflows activated
 *   - No shell-out, no eval, no webhook POST
 *   - Audit log entry written to logs/staff-query-log.jsonl
 *     (intent: action:handoff.resolve:confirmed when --confirm is present)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { withPgClient } = require('./lib/pg-connect');
const { resolveHandoffSql } = require('./lib/staff-handoff-write-sql');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'staff-query-log.jsonl');

/**
 * Allowlisted staff actions.
 * Only actions in this list may be proposed or executed.
 * Add new entries in Stage 6.5b+, not before.
 */
const ACTION_ALLOWLIST = [
  'handoff.resolve',
];

// SQL injection guard — applied to text parameters
const SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

// ─────────────────────────────────────────────────────────────────────────────
// Arg parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args  = argv.slice(2);
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
// Guard helpers
// ─────────────────────────────────────────────────────────────────────────────

function guardText(name, value) {
  if (!value) throw new Error(`Missing required flag: ${name}`);
  if (SQL_INJECT_RE.test(String(value))) throw new Error(`Unsafe characters in ${name}`);
  if (String(value).length > 500) throw new Error(`${name} too long (max 500 chars)`);
  return String(value).trim();
}

// Simple UUID v4 pattern check
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function guardUuid(name, value) {
  if (!value) throw new Error(`Missing required flag: ${name}`);
  if (!UUID_RE.test(value)) throw new Error(`${name} must be a valid UUID (got: ${value})`);
  return value.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only lookup: fetch handoff row by id + client
// ─────────────────────────────────────────────────────────────────────────────

const HANDOFF_BY_ID_SQL = `
SELECT
  h.id::text        AS handoff_id,
  h.reason_code,
  h.summary,
  h.priority,
  h.status,
  h.assigned_staff,
  h.phone,
  h.opened_at,
  h.resolved_at,
  h.resolution_summary
FROM staff_handoffs h
JOIN clients c ON c.id = h.client_id
WHERE c.slug = $1
  AND h.id   = $2::uuid
LIMIT 1
`;

async function fetchHandoffRow(clientSlug, handoffId) {
  return withPgClient(async (client) => {
    const result = await client.query(HANDOFF_BY_ID_SQL, [clientSlug, handoffId]);
    return result.rows[0] || null;
  });
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
// Proposal printer
// ─────────────────────────────────────────────────────────────────────────────

function printProposal(action, handoff, flags) {
  const resolutionText = flags['--resolution'] || '(none provided)';
  const staffName      = flags['--staff']      || '(none provided)';

  // SQL preview — string only, NEVER executed in proposal mode
  const sqlPreview = `
-- SQL PREVIEW (proposal only — NOT executed without --confirm)
-- Run with --confirm to execute this UPDATE against staff_handoffs.
UPDATE staff_handoffs h
SET
  status             = 'resolved',
  resolved_at        = NOW(),
  resolution_summary = $3,
  updated_at         = NOW()
FROM clients c
WHERE c.slug        = $1
  AND h.id          = $2::uuid
  AND h.client_id   = c.id
  AND h.status NOT IN ('resolved', 'cancelled')
RETURNING h.id::text, h.reason_code, h.resolved_at;

-- Bind params would be:
--   $1 = '${flags['--client'] || DEFAULT_CLIENT_SLUG}'
--   $2 = '${handoff.handoff_id}'
--   $3 = '${resolutionText.replace(/'/g, "''")}'
`.trim();

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  STAFF ACTION PROPOSAL');
  console.log('  Mode:        PROPOSAL ONLY (Stage 6.5a — no writes executed)');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`\n  Action:          ${action}`);
  console.log(`  Handoff ID:      ${handoff.handoff_id}`);
  console.log(`  Reason code:     ${handoff.reason_code || '(none)'}`);
  console.log(`  Current status:  ${handoff.status}`);
  console.log(`  Priority:        ${handoff.priority || '(none)'}`);
  console.log(`  Phone:           ${handoff.phone || '(none)'}`);
  console.log(`  Opened at:       ${handoff.opened_at || '(unknown)'}`);
  console.log(`  Assigned staff:  ${handoff.assigned_staff || '(unassigned)'}`);
  console.log('');
  console.log('  ── Proposed change ───────────────────────────────────────────');
  console.log(`  New status:      resolved`);
  console.log(`  Resolved by:     ${staffName}`);
  console.log(`  Resolution:      ${resolutionText}`);
  console.log('');
  console.log('  ── SQL preview (NOT executed) ─────────────────────────────────');
  const indented = sqlPreview.split('\n').map((l) => '  ' + l).join('\n');
  console.log(indented);
  console.log('');
  console.log('  ── To execute ────────────────────────────────────────────────');
  console.log('  Re-run with --confirm to execute this UPDATE against staff_handoffs.');
  console.log('══════════════════════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags   = parseArgs(process.argv);
  const started = Date.now();

  // ── Confirm mode flag ─────────────────────────────────────────────────────
  const confirmMode = flags['--confirm'] && flags['--confirm'] !== 'false';

  // ── Client slug ────────────────────────────────────────────────────────────
  let clientSlug = flags['--client'] || DEFAULT_CLIENT_SLUG;
  if (!flags['--client']) {
    console.warn(`  [warn] No --client supplied; defaulting to '${DEFAULT_CLIENT_SLUG}'`);
  }
  if (clientSlug === 'wolfhouse') {
    clientSlug = 'wolfhouse-somo';
    console.warn(`  [warn] Expanded --client 'wolfhouse' → 'wolfhouse-somo'`);
  }

  // ── Action lookup ──────────────────────────────────────────────────────────
  const action = flags['--action'];
  if (!action) {
    console.error('\n[ERROR] --action is required.');
    console.error(`        Supported actions: ${ACTION_ALLOWLIST.join(', ')}\n`);
    process.exit(1);
  }
  if (!ACTION_ALLOWLIST.includes(action)) {
    console.error(`\n[ERROR] Unknown action: '${action}'`);
    console.error(`        Allowlisted actions: ${ACTION_ALLOWLIST.join(', ')}\n`);
    process.exit(1);
  }

  let auditSuccess = false;
  let auditError   = null;

  // ── handoff.resolve ────────────────────────────────────────────────────────
  if (action === 'handoff.resolve') {
    let handoffId;
    let resolutionText;
    let staffName;

    try {
      handoffId      = guardUuid('--handoff-id', flags['--handoff-id']);
      resolutionText = guardText('--resolution', flags['--resolution']);
      staffName      = guardText('--staff',      flags['--staff']);
    } catch (err) {
      console.error(`\n[ERROR] ${err.message}\n`);
      process.exit(1);
    }

    // ── Fetch handoff row (read-only) ────────────────────────────────────────
    let handoff;
    try {
      handoff = await fetchHandoffRow(clientSlug, handoffId);
    } catch (err) {
      const errMsg = `Could not read handoff row: ${err.message}`;
      console.error(`\n[ERROR] ${errMsg}\n`);
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      confirmMode
          ? 'action:handoff.resolve:confirmed'
          : 'action:handoff.resolve:proposal',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId },
        row_count:   0,
        success:     false,
        error:       errMsg,
        elapsed_ms:  Date.now() - started,
      });
      process.exit(1);
    }

    // ── Handoff not found ─────────────────────────────────────────────────────
    if (!handoff) {
      const modeLabel = confirmMode ? 'CONFIRMED — NO-OP' : 'PROPOSAL — NO-OP';
      console.log('\n══════════════════════════════════════════════════════════════════');
      console.log(`  STAFF ACTION ${modeLabel}`);
      console.log('══════════════════════════════════════════════════════════════════');
      console.log(`  Handoff not found: ${handoffId}`);
      console.log(`  Client: ${clientSlug}`);
      console.log('  No action taken. Nothing to resolve.\n');
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      confirmMode
          ? 'action:handoff.resolve:confirmed'
          : 'action:handoff.resolve:proposal',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId },
        row_count:   0,
        success:     true,
        error:       'handoff_not_found',
        elapsed_ms:  Date.now() - started,
      });
      process.exit(0);
    }

    // ── Already resolved/cancelled — no-op ───────────────────────────────────
    if (handoff.status === 'resolved' || handoff.status === 'cancelled') {
      const label = confirmMode ? 'CONFIRMED — NO-OP' : 'PROPOSAL — NO-OP';
      console.log('\n══════════════════════════════════════════════════════════════════');
      console.log(`  STAFF ACTION ${label}`);
      console.log('══════════════════════════════════════════════════════════════════');
      console.log(`  Handoff ${handoffId} is already '${handoff.status}'.`);
      console.log('  Nothing to do — no change would be made.\n');
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      confirmMode
          ? 'action:handoff.resolve:confirmed'
          : 'action:handoff.resolve:proposal',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId },
        row_count:   1,
        success:     true,
        error:       `already_${handoff.status}`,
        elapsed_ms:  Date.now() - started,
      });
      process.exit(0);
    }

    // ── Proposal mode (no --confirm) ──────────────────────────────────────────
    if (!confirmMode) {
      printProposal(action, handoff, {
        ...flags,
        '--client':     clientSlug,
        '--resolution': resolutionText,
        '--staff':      staffName,
      });
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      'action:handoff.resolve:proposal',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId, staff: staffName },
        row_count:   1,
        success:     true,
        error:       null,
        elapsed_ms:  Date.now() - started,
      });
      return;
    }

    // ── Confirmed write path (--confirm present) ──────────────────────────────
    // Only staff_handoffs is mutated. resolveHandoffSql is client-scoped by
    // $1=client_slug and $2=handoff_id so no other rows can be affected.
    // bookings, payments, payment_events, booking_beds are never touched.
    let updatedRow;
    try {
      const sql = resolveHandoffSql();
      updatedRow = await withPgClient(async (client) => {
        const result = await client.query(sql, [clientSlug, handoffId, resolutionText]);
        return result.rows[0] || null;
      });
    } catch (err) {
      const errMsg = `Confirmed write failed: ${err.message}`;
      console.error(`\n[ERROR] ${errMsg}\n`);
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      'action:handoff.resolve:confirmed',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId, staff: staffName },
        row_count:   0,
        success:     false,
        error:       errMsg,
        elapsed_ms:  Date.now() - started,
      });
      process.exit(1);
    }

    if (!updatedRow) {
      // Guard should not normally be hit after earlier checks, but handle safely
      console.log('\n[WARN] UPDATE returned no rows — handoff may have already been resolved by another process.');
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      'action:handoff.resolve:confirmed',
        category:    'staff_action',
        client_slug: clientSlug,
        params:      { handoff_id: handoffId, staff: staffName },
        row_count:   0,
        success:     true,
        error:       'no_rows_updated',
        elapsed_ms:  Date.now() - started,
      });
      process.exit(0);
    }

    console.log('\n══════════════════════════════════════════════════════════════════');
    console.log('  STAFF ACTION CONFIRMED — EXECUTED');
    console.log('══════════════════════════════════════════════════════════════════');
    console.log(`  Action:          ${action}`);
    console.log(`  Handoff ID:      ${updatedRow.id || handoffId}`);
    console.log(`  Reason code:     ${updatedRow.reason_code || handoff.reason_code || '(none)'}`);
    console.log(`  Status before:   ${handoff.status}`);
    console.log(`  Status after:    resolved`);
    console.log(`  Resolved at:     ${updatedRow.resolved_at || new Date().toISOString()}`);
    console.log(`  Resolved by:     ${staffName}`);
    console.log(`  Resolution:      ${resolutionText}`);
    console.log('══════════════════════════════════════════════════════════════════\n');

    appendAuditLog({
      ts:          new Date().toISOString(),
      intent:      'action:handoff.resolve:confirmed',
      category:    'staff_action',
      client_slug: clientSlug,
      params:      { handoff_id: handoffId, staff: staffName },
      row_count:   1,
      success:     true,
      error:       null,
      elapsed_ms:  Date.now() - started,
    });
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
