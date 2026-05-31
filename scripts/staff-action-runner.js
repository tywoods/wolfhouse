/**
 * Stage 6.5a — Proposal-only staff action runner.
 *
 * Supports one action in this stage:
 *   handoff.resolve  — propose resolving an open staff handoff
 *
 * Usage:
 *   node scripts/staff-action-runner.js \
 *     --client wolfhouse-somo \
 *     --action handoff.resolve \
 *     --handoff-id <uuid> \
 *     --resolution "Resolved during proposal test" \
 *     --staff "Test Staff" \
 *     --dry-run
 *
 * CLI flags:
 *   --client       Client slug (default: wolfhouse-somo)
 *   --action       Action key from the allowlist
 *   --handoff-id   UUID of the target staff_handoffs row
 *   --resolution   Resolution summary text
 *   --staff        Resolving staff member name
 *   --dry-run      Proposal mode (always active in 6.5a; flag accepted for explicitness)
 *   --confirm      Hard-fails — confirmed writes NOT implemented in 6.5a
 *
 * Safety constraints:
 *   - Proposal-only: no UPDATE/INSERT/DELETE to any table in 6.5a
 *   - bookings, payments, payment_events, booking_beds never touched
 *   - staff_handoffs never mutated in 6.5a
 *   - No workflow JSON modified; no guest workflows activated
 *   - No shell-out, no eval, no webhook POST
 *   - SQL preview is a string only — it is never executed
 *   - One optional audit log entry written to logs/staff-query-log.jsonl
 *
 * Stage 6.5b will add the --confirm gate and the actual UPDATE execution.
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

  // SQL preview — string only, NEVER executed in 6.5a
  const sqlPreview = `
-- SQL PREVIEW (proposal only — NOT executed in Stage 6.5a)
-- Stage 6.5b will execute this behind an explicit --confirm gate.
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
  console.log('  ── To execute in Stage 6.5b ──────────────────────────────────');
  console.log('  Add --confirm flag once Stage 6.5b confirmed-write path is wired.');
  console.log('  The --confirm flag is NOT implemented in Stage 6.5a.');
  console.log('══════════════════════════════════════════════════════════════════\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const flags   = parseArgs(process.argv);
  const started = Date.now();

  // ── Hard-fail if --confirm is passed ──────────────────────────────────────
  if (flags['--confirm'] && flags['--confirm'] !== 'false') {
    console.error('\n[ERROR] --confirm is NOT implemented in Stage 6.5a.');
    console.error('        Confirmed staff writes are deferred to Stage 6.5b.');
    console.error('        No writes were made.\n');
    process.exit(1);
  }

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
        intent:      'action:handoff.resolve:proposal',
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
      console.log('\n══════════════════════════════════════════════════════════════════');
      console.log('  STAFF ACTION PROPOSAL — NO-OP');
      console.log('══════════════════════════════════════════════════════════════════');
      console.log(`  Handoff not found: ${handoffId}`);
      console.log(`  Client: ${clientSlug}`);
      console.log('  No action proposed. Nothing to resolve.\n');
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      'action:handoff.resolve:proposal',
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

    // ── Already resolved — print no-op ────────────────────────────────────────
    if (handoff.status === 'resolved' || handoff.status === 'cancelled') {
      console.log('\n══════════════════════════════════════════════════════════════════');
      console.log('  STAFF ACTION PROPOSAL — NO-OP');
      console.log('══════════════════════════════════════════════════════════════════');
      console.log(`  Handoff ${handoffId} is already '${handoff.status}'.`);
      console.log('  Nothing to do — no change would be made.\n');
      appendAuditLog({
        ts:          new Date().toISOString(),
        intent:      'action:handoff.resolve:proposal',
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

    // ── Print proposal ─────────────────────────────────────────────────────────
    printProposal(action, handoff, { ...flags, '--client': clientSlug, '--resolution': resolutionText, '--staff': staffName });

    auditSuccess = true;

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
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
