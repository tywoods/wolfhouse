'use strict';

/**
 * Canonical migration integrity helpers (FOUNDATION Slice 4 + 13A.1).
 * Never connects to staging/prod/Azure. Pure filesystem + policy checks.
 *
 * Checksum mode canonical_lf_v1 (Slice 13A.1):
 * - reject unsupported/binary content (NUL bytes);
 * - normalize CRLF and lone CR to LF;
 * - SHA-256 over resulting UTF-8 bytes;
 * - identical on Windows and Linux regardless of checkout EOL conversion.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'canonical-manifest.json');

const CHECKSUM_MODE_CANONICAL_LF_V1 = 'canonical_lf_v1';
const SUPPORTED_CHECKSUM_MODES = Object.freeze([CHECKSUM_MODE_CANONICAL_LF_V1]);

const FORBIDDEN_HOST_PATTERNS = Object.freeze([
  /\.postgres\.database\.azure\.com$/i,
  /azure\.com$/i,
  /luna-sunset/i,
  /wolfhouse/i,
  /staging/i,
  /prod/i,
  /production/i,
]);

const FORBIDDEN_DB_NAMES = Object.freeze([
  'sunset_staging',
  'wolfhouse_staging',
  'wolfhouse',
  'production',
  'prod',
]);

const CLASSIFICATIONS = Object.freeze([
  'canonical_forward',
  'proposed_not_executable',
  'rollback_down',
  'superseded',
  'unresolved',
]);

/** Provenance-aware ledger apply kinds (Slice 14AD). */
const APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE = 'verified_structural_baseline';
const APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE = 'verified_current_state_baseline';
const APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER = 'executed_by_canonical_runner';
const APPLY_KINDS = Object.freeze([
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
]);
const BASELINE_APPLY_KINDS = Object.freeze([
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
]);

/**
 * Fresh ledger DDL (Slice 4 columns preserved + Slice 14AD provenance columns).
 *
 * Timestamp semantics (documented solely as ledger recording time — never
 * historical migration execution time on the source database):
 * - applied_at: wall clock of the ledger INSERT transaction (NOW()/txn ts)
 * - ledger_recorded_at: same transaction recording timestamp as applied_at
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migration_ledger (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  apply_order INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  apply_kind TEXT NOT NULL,
  checksum_mode TEXT NOT NULL DEFAULT 'canonical_lf_v1',
  evidence_ref TEXT,
  provenance_notes TEXT,
  ledger_recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT schema_migration_ledger_apply_kind_check
    CHECK (apply_kind IN (
      'verified_structural_baseline',
      'verified_current_state_baseline',
      'executed_by_canonical_runner'
    )),
  CONSTRAINT schema_migration_ledger_checksum_mode_check
    CHECK (checksum_mode = 'canonical_lf_v1')
);
CREATE UNIQUE INDEX IF NOT EXISTS schema_migration_ledger_apply_order_uidx
  ON schema_migration_ledger (apply_order);
`;

/**
 * Historical Slice 4 five-column ledger DDL (pre-14AD).
 * Preserved for Slice 14AC design-only eligibility evidence byte-lock stability;
 * fresh installs use LEDGER_DDL; legacy tables use LEDGER_LEGACY_UPGRADE_DDL.
 */
const LEDGER_DDL_SLICE4_BASE = `
CREATE TABLE IF NOT EXISTS schema_migration_ledger (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  apply_order INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

/**
 * Additive upgrade for pre-14AD five-column ledgers.
 * Safe to run after LEDGER_DDL on fresh tables (IF NOT EXISTS no-ops).
 *
 * Provenance columns are added NULLABLE with NO column DEFAULTs and NO
 * backfill: preexisting rows keep null apply_kind/checksum_mode/
 * evidence_ref/provenance_notes/ledger_recorded_at until an explicit
 * operator repair writes canonical provenance + canonical checksum.
 * Reconcile fails closed on null provenance / mode-hash inconsistency —
 * upgrade schema succeeds; runner refuses unrepaired legacy rows.
 */
const LEDGER_LEGACY_UPGRADE_DDL = `
ALTER TABLE schema_migration_ledger
  ADD COLUMN IF NOT EXISTS apply_kind TEXT;
ALTER TABLE schema_migration_ledger
  ADD COLUMN IF NOT EXISTS checksum_mode TEXT;
ALTER TABLE schema_migration_ledger
  ADD COLUMN IF NOT EXISTS evidence_ref TEXT;
ALTER TABLE schema_migration_ledger
  ADD COLUMN IF NOT EXISTS provenance_notes TEXT;
ALTER TABLE schema_migration_ledger
  ADD COLUMN IF NOT EXISTS ledger_recorded_at TIMESTAMPTZ;
DO $upgrade$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schema_migration_ledger_apply_kind_check'
  ) THEN
    ALTER TABLE schema_migration_ledger
      ADD CONSTRAINT schema_migration_ledger_apply_kind_check
      CHECK (
        apply_kind IS NULL
        OR apply_kind IN (
          'verified_structural_baseline',
          'verified_current_state_baseline',
          'executed_by_canonical_runner'
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schema_migration_ledger_checksum_mode_check'
  ) THEN
    ALTER TABLE schema_migration_ledger
      ADD CONSTRAINT schema_migration_ledger_checksum_mode_check
      CHECK (checksum_mode IS NULL OR checksum_mode = 'canonical_lf_v1');
  END IF;
END
$upgrade$;
CREATE UNIQUE INDEX IF NOT EXISTS schema_migration_ledger_apply_order_uidx
  ON schema_migration_ledger (apply_order);
`;

const LEDGER_TIMESTAMP_SEMANTICS = Object.freeze({
  applied_at:
    'Ledger recording time within the inserting transaction; never historical migration execution time.',
  ledger_recorded_at:
    'Same transaction recording timestamp as applied_at; documents when the ledger row was written.',
  neverHistoricalExecutionTime: true,
});

const LEDGER_SELECT_COLUMNS = Object.freeze([
  'id',
  'filename',
  'checksum_sha256',
  'apply_order',
  'applied_at',
  'apply_kind',
  'checksum_mode',
  'evidence_ref',
  'provenance_notes',
  'ledger_recorded_at',
]);

const ADVISORY_LOCK_KEY1 = 0x57480001; // WH
const ADVISORY_LOCK_KEY2 = 0x4d494731; // MIG1

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

/**
 * Normalize migration bytes to canonical LF UTF-8 for checksum mode canonical_lf_v1.
 * Rejects NUL/binary payloads. Does not alter SQL tokens beyond EOL conversion.
 */
function normalizeMigrationBytesToCanonicalLf(buf) {
  const input = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  if (input.includes(0x00)) {
    return {
      ok: false,
      code: 'unsupported_binary_content',
      message: 'migration bytes contain NUL; binary content is not supported',
    };
  }
  let text;
  try {
    text = input.toString('utf8');
  } catch (e) {
    return {
      ok: false,
      code: 'unsupported_encoding',
      message: 'migration bytes are not valid UTF-8',
    };
  }
  // Reject lone invalid UTF-8 replacement if buffer was not valid — Node replaces;
  // detect by round-trip for non-ASCII edge cases is imperfect; NUL already rejected.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { ok: true, text: normalized, buffer: Buffer.from(normalized, 'utf8') };
}

function sha256CanonicalLfV1FromBuffer(buf) {
  const n = normalizeMigrationBytesToCanonicalLf(buf);
  if (!n.ok) {
    throw Object.assign(new Error(n.message), { code: n.code });
  }
  return sha256Buffer(n.buffer);
}

function sha256CanonicalLfV1File(filePath) {
  return sha256CanonicalLfV1FromBuffer(fs.readFileSync(filePath));
}

function resolveChecksumMode(manifest) {
  const mode = manifest && manifest.checksumMode;
  if (!mode) {
    return { ok: false, code: 'checksum_mode_missing', message: 'manifest.checksumMode is required' };
  }
  if (!SUPPORTED_CHECKSUM_MODES.includes(mode)) {
    return {
      ok: false,
      code: 'checksum_mode_unknown',
      message: `unknown checksumMode ${mode}`,
    };
  }
  return { ok: true, mode };
}

function checksumMigrationBytes(buf, mode) {
  if (mode === CHECKSUM_MODE_CANONICAL_LF_V1) {
    try {
      return { ok: true, sha256: sha256CanonicalLfV1FromBuffer(buf), mode };
    } catch (e) {
      return { ok: false, code: e.code || 'checksum_failed', message: e.message };
    }
  }
  return { ok: false, code: 'checksum_mode_unknown', message: `unknown checksumMode ${mode}` };
}

function checksumMigrationFile(filePath, mode) {
  return checksumMigrationBytes(fs.readFileSync(filePath), mode);
}

/**
 * Token-aware SQL semantic comparable form:
 * - EOL already normalized by caller or here;
 * - skip comments;
 * - preserve string / dollar-quote payloads as opaque segments;
 * - collapse other whitespace to a single space.
 * Used to prove EOL-only edits do not change executable SQL semantics.
 */
function sqlSemanticComparable(sqlText) {
  const sql = String(sqlText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let out = '';
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;
  let dollarTag = null;
  let spacePending = false;

  function emitSpace() {
    if (out.length && !out.endsWith(' ') && !out.endsWith('\n')) spacePending = true;
  }
  function flushSpace() {
    if (spacePending) {
      out += ' ';
      spacePending = false;
    }
  }
  function emit(ch) {
    flushSpace();
    out += ch;
  }

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        for (let k = 0; k < dollarTag.length; k += 1) emit(sql[i + k]);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      emit(c);
      i += 1;
      continue;
    }
    if (inSingle) {
      emit(c);
      if (c === "'" && next === "'") {
        emit(next);
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      emit(c);
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (c === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      emit(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      emit(c);
      i += 1;
      continue;
    }
    if (c === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        dollarTag = m[0];
        for (let k = 0; k < m[0].length; k += 1) emit(m[0][k]);
        i += m[0].length;
        continue;
      }
    }

    if (/\s/.test(c)) {
      emitSpace();
      i += 1;
      continue;
    }
    emit(c);
    i += 1;
  }
  return out.trim();
}

function assertSqlSemanticsUnchanged(beforeBuf, afterBuf) {
  const a = normalizeMigrationBytesToCanonicalLf(beforeBuf);
  const b = normalizeMigrationBytesToCanonicalLf(afterBuf);
  if (!a.ok || !b.ok) {
    return { ok: false, code: 'normalize_failed', message: (a.message || b.message) };
  }
  const sa = sqlSemanticComparable(a.text);
  const sb = sqlSemanticComparable(b.text);
  if (sa !== sb) {
    return {
      ok: false,
      code: 'sql_semantics_changed',
      message: 'token-aware SQL semantic comparable form differs',
    };
  }
  return { ok: true, semanticFingerprint: sha256Buffer(Buffer.from(sa, 'utf8')) };
}

function ledgerChecksumAccepted(entry, ledgerChecksum) {
  const got = String(ledgerChecksum || '');
  if (!got || !/^[0-9a-f]{64}$/.test(got)) {
    return { ok: false, code: 'ledger_checksum_malformed' };
  }
  if (got === entry.sha256) {
    return { ok: true, mode: CHECKSUM_MODE_CANONICAL_LF_V1 };
  }
  // Narrow legacy acceptance: exact committed pre-canonical_lf_v1 hash only.
  if (entry.legacySha256 && got === entry.legacySha256) {
    return { ok: true, mode: 'legacy_crlf_era_exact' };
  }
  return { ok: false, code: 'ledger_checksum_mismatch' };
}

function isBaselineApplyKind(kind) {
  return BASELINE_APPLY_KINDS.includes(String(kind || ''));
}

function isExecutedApplyKind(kind) {
  return String(kind || '') === APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER;
}

function isKnownApplyKind(kind) {
  return APPLY_KINDS.includes(String(kind || ''));
}

/**
 * Reconcile ledger rows against the canonical forward chain.
 *
 * Both baseline kinds and executed_by_canonical_runner count as applied only
 * when checksums validate and apply_order forms an exact contiguous prefix.
 * Fail closed on null/unknown apply_kind, null/unknown checksum_mode, null
 * ledger_recorded_at, gaps, mismatches, or checksum_mode/hash inconsistency.
 *
 * checksum_mode=canonical_lf_v1 requires row.checksum_sha256 === entry.sha256.
 * An exact legacySha256 under canonical mode is NOT accepted (no silent
 * legacy→canonical mislabel); operator must repair to the canonical hash.
 * A dedicated ledger checksum_mode for legacy eras is intentionally not
 * introduced here.
 */
function reconcileLedger(forward, ledgerRows) {
  const errors = [];
  const rows = Array.isArray(ledgerRows) ? ledgerRows : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const row of rows) {
    const kind = row.apply_kind == null ? null : String(row.apply_kind);
    if (kind == null || kind === '') {
      errors.push({
        code: 'ledger_apply_kind_null',
        message: `ledger row ${row.id} has null/empty apply_kind`,
      });
    } else if (!isKnownApplyKind(kind)) {
      errors.push({
        code: 'ledger_apply_kind_unknown',
        message: `ledger row ${row.id} has unknown apply_kind ${kind}`,
      });
    }

    const mode = row.checksum_mode == null ? null : String(row.checksum_mode);
    if (mode == null || mode === '') {
      errors.push({
        code: 'ledger_checksum_mode_null',
        message: `ledger row ${row.id} has null/empty checksum_mode`,
      });
    } else if (mode !== CHECKSUM_MODE_CANONICAL_LF_V1) {
      errors.push({
        code: 'ledger_checksum_mode_unknown',
        message: `ledger row ${row.id} has unknown checksum_mode ${mode}`,
      });
    }

    if (row.ledger_recorded_at == null || String(row.ledger_recorded_at) === '') {
      errors.push({
        code: 'ledger_recorded_at_null',
        message: `ledger row ${row.id} has null/empty ledger_recorded_at`,
      });
    }

    const expected = forward.find((f) => f.id === row.id);
    if (!expected) {
      errors.push({
        code: 'ledger_unknown_id',
        message: `ledger contains unknown id ${row.id}`,
      });
      continue;
    }

    const got = String(row.checksum_sha256 || '');
    if (!got || !/^[0-9a-f]{64}$/.test(got)) {
      errors.push({
        code: 'ledger_checksum_malformed',
        message: `ledger checksum malformed for ${row.id}`,
      });
    } else if (mode === CHECKSUM_MODE_CANONICAL_LF_V1) {
      if (got === expected.sha256) {
        // canonical hash under canonical mode — ok
      } else if (expected.legacySha256 && got === expected.legacySha256) {
        errors.push({
          code: 'ledger_checksum_mode_hash_inconsistency',
          message:
            `ledger row ${row.id} stores legacySha256 under checksum_mode=${CHECKSUM_MODE_CANONICAL_LF_V1}; `
            + 'canonical mode requires entry.sha256 (explicit repair; no legacy mode)',
        });
      } else {
        errors.push({
          code: 'ledger_checksum_mismatch',
          message: `ledger checksum mismatch for ${row.id}`,
        });
      }
    } else if (mode == null || mode === '') {
      // Null mode already recorded; refuse to treat any stored hash as validated.
      errors.push({
        code: 'ledger_checksum_unprovenanced',
        message: `ledger row ${row.id} checksum cannot be validated without checksum_mode`,
      });
    }

    if (row.filename !== expected.filename) {
      errors.push({
        code: 'ledger_filename_mismatch',
        message: `ledger filename mismatch for ${row.id}`,
      });
    }
    if (Number(row.apply_order) !== expected.order) {
      errors.push({
        code: 'ledger_order_mismatch',
        message: `ledger order mismatch for ${row.id}`,
      });
    }
  }

  // Partial history: applied set must be a contiguous prefix of the forward chain
  const appliedOrders = rows.map((r) => Number(r.apply_order)).sort((a, b) => a - b);
  for (let i = 0; i < appliedOrders.length; i += 1) {
    if (appliedOrders[i] !== i + 1) {
      errors.push({
        code: 'ledger_partial_history',
        message: `ledger is not a contiguous prefix (gap at order ${i + 1})`,
      });
      break;
    }
  }

  return { ok: errors.length === 0, errors, byId };
}

/**
 * Build runner INSERT provenance for a newly executed migration.
 */
function buildExecutedByCanonicalRunnerProvenance(entry) {
  const id = entry && entry.id ? String(entry.id) : 'unknown';
  return {
    apply_kind: APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
    checksum_mode: CHECKSUM_MODE_CANONICAL_LF_V1,
    evidence_ref: `canonical_runner:${id}`,
    provenance_notes:
      `executed_by_canonical_runner via runCanonicalMigrations; checksumMode=${CHECKSUM_MODE_CANONICAL_LF_V1}`,
  };
}

function loadManifest(manifestPath) {
  const p = manifestPath || MANIFEST_PATH;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listSqlFilenames(migrationsDir) {
  return fs
    .readdirSync(migrationsDir || MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function forwardEntries(manifest) {
  return (manifest.entries || [])
    .filter((e) => e.inForwardChain === true && e.classification === 'canonical_forward')
    .slice()
    .sort((a, b) => a.order - b.order);
}

function validateManifestIntegrity(manifest, opts) {
  const options = opts || {};
  const migrationsDir = options.migrationsDir || MIGRATIONS_DIR;
  const errors = [];
  const entries = manifest.entries || [];

  const modeGate = resolveChecksumMode(manifest);
  if (!modeGate.ok) {
    errors.push({ code: modeGate.code, message: modeGate.message });
  }
  const mode = modeGate.ok ? modeGate.mode : null;

  if (!manifest.intentionalGaps || !manifest.intentionalGaps.some((g) => String(g.number) === '015')) {
    errors.push({ code: 'missing_015_gap', message: 'manifest must record intentional gap 015' });
  }

  const ids = new Set();
  const orders = new Set();
  const filenames = new Set();

  for (const e of entries) {
    if (!CLASSIFICATIONS.includes(e.classification)) {
      errors.push({
        code: 'bad_classification',
        message: `entry ${e.id || e.filename} has unknown classification ${e.classification}`,
      });
    }
    if (!e.id || !e.filename || !e.sha256 || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      errors.push({ code: 'entry_incomplete', message: `incomplete entry for ${e.filename || e.id}` });
      continue;
    }
    if (e.legacySha256 != null && !/^[0-9a-f]{64}$/.test(String(e.legacySha256))) {
      errors.push({
        code: 'legacy_sha_malformed',
        message: `legacySha256 malformed for ${e.filename}`,
      });
    }
    if (ids.has(e.id)) {
      errors.push({ code: 'duplicate_id', message: `duplicate canonical id ${e.id}` });
    }
    ids.add(e.id);
    if (filenames.has(e.filename)) {
      errors.push({ code: 'duplicate_filename', message: `duplicate filename ${e.filename}` });
    }
    filenames.add(e.filename);

    if (e.inForwardChain) {
      if (e.classification !== 'canonical_forward') {
        errors.push({
          code: 'non_forward_in_chain',
          message: `${e.filename} is in forward chain but classification=${e.classification}`,
        });
      }
      if (typeof e.order !== 'number' || !Number.isInteger(e.order) || e.order < 1) {
        errors.push({ code: 'bad_order', message: `${e.filename} missing positive integer order` });
      } else if (orders.has(e.order)) {
        errors.push({ code: 'duplicate_order', message: `duplicate forward order ${e.order}` });
      } else {
        orders.add(e.order);
      }
    } else if (e.classification === 'canonical_forward') {
      errors.push({
        code: 'forward_not_in_chain',
        message: `${e.filename} classified canonical_forward but inForwardChain=false`,
      });
    } else if (
      e.classification === 'proposed_not_executable' ||
      e.classification === 'rollback_down' ||
      e.classification === 'superseded'
    ) {
      if (e.order != null) {
        errors.push({
          code: 'non_forward_has_order',
          message: `${e.filename} must not have forward order`,
        });
      }
    } else if (e.classification === 'unresolved') {
      errors.push({
        code: 'unresolved_entry',
        message: `${e.filename} is unresolved — fail closed until classified`,
      });
    }

    const abs = path.join(migrationsDir, e.filename);
    if (!fs.existsSync(abs)) {
      errors.push({ code: 'missing_file', message: `manifest file missing on disk: ${e.filename}` });
      continue;
    }
    if (!mode) continue;
    const live = checksumMigrationFile(abs, mode);
    if (!live.ok) {
      errors.push({ code: live.code || 'checksum_failed', message: `${e.filename}: ${live.message}` });
      continue;
    }
    if (live.sha256 !== e.sha256) {
      errors.push({
        code: 'checksum_mismatch',
        message: `checksum changed for ${e.filename}`,
      });
    }
  }

  const onDisk = listSqlFilenames(migrationsDir);
  for (const f of onDisk) {
    if (!filenames.has(f)) {
      errors.push({
        code: 'unclassified_sql',
        message: `SQL file not in manifest: ${f}`,
      });
    }
  }

  const forward = forwardEntries(manifest);
  for (let i = 0; i < forward.length; i += 1) {
    if (forward[i].order !== i + 1) {
      errors.push({
        code: 'order_gap',
        message: `forward order must be contiguous starting at 1 (expected ${i + 1}, got ${forward[i].order} for ${forward[i].filename})`,
      });
      break;
    }
  }

  return { ok: errors.length === 0, errors, forwardCount: forward.length, checksumMode: mode };
}

function assertSafeDatabaseTarget(connectionInfo) {
  const errors = [];
  const host = String(connectionInfo.host || '');
  const database = String(connectionInfo.database || '');
  const port = Number(connectionInfo.port);

  if (!host || host === '') {
    errors.push({ code: 'target_host_missing', message: 'host required' });
  }
  const loopbackOk = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!loopbackOk) {
    errors.push({
      code: 'target_host_not_loopback',
      message: 'refusing non-loopback host (only localhost, 127.0.0.1, ::1)',
    });
  }
  for (const re of FORBIDDEN_HOST_PATTERNS) {
    if (re.test(host)) {
      errors.push({ code: 'target_host_forbidden', message: 'forbidden host pattern' });
    }
  }
  if (FORBIDDEN_DB_NAMES.includes(database.toLowerCase())) {
    errors.push({ code: 'target_db_forbidden', message: 'forbidden database name' });
  }
  if (!/^wh_mig_[a-z0-9_]+$/i.test(database)) {
    errors.push({
      code: 'target_db_not_ephemeral',
      message: 'database name must match wh_mig_* ephemeral pattern',
    });
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    errors.push({ code: 'target_port_invalid', message: 'invalid port' });
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Scan for top-level SQL transaction-control statements (BEGIN;/COMMIT;/ROLLBACK;/START TRANSACTION;).
 * Skips line/block comments, quoted strings, and dollar-quoted bodies — does not rewrite SQL.
 */
function scanTopLevelTxnControls(sqlText) {
  const sql = String(sqlText || '');
  const hits = [];
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingle = false;
  let inDouble = false;
  let dollarTag = null;

  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (c === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }

    if (c === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (c === '$') {
      const m = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        dollarTag = m[0];
        i += m[0].length;
        continue;
      }
    }

    const prevOk = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);
    if (prevOk) {
      const rest = sql.slice(i);
      let m = rest.match(/^(BEGIN|COMMIT|ROLLBACK)\s*;/i);
      if (m) {
        hits.push({ keyword: m[1].toUpperCase(), index: i, text: m[0] });
        i += m[0].length;
        continue;
      }
      m = rest.match(/^START\s+TRANSACTION\s*;/i);
      if (m) {
        hits.push({ keyword: 'START TRANSACTION', index: i, text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return hits;
}

/**
 * True when fragment contains only whitespace and SQL comments (no executable tokens).
 */
function isTriviaOnly(sqlText) {
  const sql = String(sqlText || '');
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '-' && next === '-') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Prepare migration SQL for execution inside a runner-owned transaction.
 * Accepts at most one outer BEGIN; ... COMMIT; pair (first/last top-level txn controls).
 * Leading/trailing comments before BEGIN / after COMMIT are allowed.
 * Removes only those wrappers by index slice — never regex-rewrites the body.
 * Rejects nested/extra/ambiguous transaction-control statements.
 */
function prepareMigrationBody(sqlText) {
  const trimmed = String(sqlText || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!trimmed) {
    return { ok: false, code: 'empty_sql', message: 'migration SQL is empty', body: null };
  }

  const hits = scanTopLevelTxnControls(trimmed);
  if (hits.length === 0) {
    return { ok: true, body: trimmed, stripped: false };
  }

  const first = hits[0];
  const last = hits[hits.length - 1];
  const prefix = trimmed.slice(0, first.index);
  const suffix = trimmed.slice(last.index + last.text.length);
  const startsWithBegin = first.keyword === 'BEGIN' && isTriviaOnly(prefix);
  const endsWithCommit = last.keyword === 'COMMIT' && isTriviaOnly(suffix);

  if (hits.length === 2 && startsWithBegin && endsWithCommit) {
    const body = trimmed.slice(first.index + first.text.length, last.index).trim();
    const inner = scanTopLevelTxnControls(body);
    if (inner.length) {
      return {
        ok: false,
        code: 'nested_or_extra_txn_control',
        message: `migration body contains nested/extra transaction control (${inner[0].keyword})`,
        body: null,
      };
    }
    return { ok: true, body, stripped: true };
  }

  if (!startsWithBegin || !endsWithCommit) {
    return {
      ok: false,
      code: 'ambiguous_txn_wrapper',
      message: 'migration has transaction control that is not a single outer BEGIN;/COMMIT; pair',
      body: null,
    };
  }

  return {
    ok: false,
    code: 'nested_or_extra_txn_control',
    message: `expected exactly one outer BEGIN;/COMMIT; pair, found ${hits.length} top-level txn controls`,
    body: null,
  };
}

function migrationHasOwnTransaction(sqlText) {
  const prepared = prepareMigrationBody(sqlText);
  return prepared.ok && prepared.stripped === true;
}

function schemaFingerprintRows(rows) {
  const lines = rows.map((r) => `${r.kind}|${r.name}|${r.detail}`).sort();
  return sha256Buffer(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

const SCHEMA_FINGERPRINT_SQL = `
SELECT * FROM (
  SELECT
    'table' AS kind,
    c.relname AS name,
    string_agg(a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum) AS detail
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  GROUP BY c.relname
  UNION ALL
  SELECT
    'index' AS kind,
    i.relname AS name,
    pg_get_indexdef(i.oid) AS detail
  FROM pg_catalog.pg_class i
  JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
  WHERE n.nspname = 'public' AND i.relkind = 'i'
  UNION ALL
  SELECT
    'constraint' AS kind,
    con.conname AS name,
    pg_get_constraintdef(con.oid) AS detail
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  WHERE n.nspname = 'public'
  UNION ALL
  SELECT
    'type' AS kind,
    t.typname AS name,
    t.typtype::text AS detail
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'c')
) q
ORDER BY kind, name;
`;

module.exports = {
  ROOT,
  MIGRATIONS_DIR,
  MANIFEST_PATH,
  FORBIDDEN_HOST_PATTERNS,
  FORBIDDEN_DB_NAMES,
  CLASSIFICATIONS,
  LEDGER_DDL,
  LEDGER_DDL_SLICE4_BASE,
  LEDGER_LEGACY_UPGRADE_DDL,
  LEDGER_TIMESTAMP_SEMANTICS,
  LEDGER_SELECT_COLUMNS,
  APPLY_KIND_VERIFIED_STRUCTURAL_BASELINE,
  APPLY_KIND_VERIFIED_CURRENT_STATE_BASELINE,
  APPLY_KIND_EXECUTED_BY_CANONICAL_RUNNER,
  APPLY_KINDS,
  BASELINE_APPLY_KINDS,
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  SCHEMA_FINGERPRINT_SQL,
  CHECKSUM_MODE_CANONICAL_LF_V1,
  SUPPORTED_CHECKSUM_MODES,
  sha256File,
  sha256Buffer,
  normalizeMigrationBytesToCanonicalLf,
  sha256CanonicalLfV1FromBuffer,
  sha256CanonicalLfV1File,
  resolveChecksumMode,
  checksumMigrationBytes,
  checksumMigrationFile,
  sqlSemanticComparable,
  assertSqlSemanticsUnchanged,
  ledgerChecksumAccepted,
  isBaselineApplyKind,
  isExecutedApplyKind,
  isKnownApplyKind,
  reconcileLedger,
  buildExecutedByCanonicalRunnerProvenance,
  loadManifest,
  listSqlFilenames,
  forwardEntries,
  validateManifestIntegrity,
  assertSafeDatabaseTarget,
  scanTopLevelTxnControls,
  prepareMigrationBody,
  migrationHasOwnTransaction,
  schemaFingerprintRows,
};
