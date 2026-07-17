'use strict';

/**
 * Canonical migration integrity helpers (FOUNDATION Slice 4).
 * Never connects to staging/prod/Azure. Pure filesystem + policy checks.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, 'canonical-manifest.json');

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

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migration_ledger (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum_sha256 TEXT NOT NULL,
  apply_order INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const ADVISORY_LOCK_KEY1 = 0x57480001; // WH
const ADVISORY_LOCK_KEY2 = 0x4d494731; // MIG1

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
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
    const live = sha256File(abs);
    if (live !== e.sha256) {
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

  return { ok: errors.length === 0, errors, forwardCount: forward.length };
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
  ADVISORY_LOCK_KEY1,
  ADVISORY_LOCK_KEY2,
  SCHEMA_FINGERPRINT_SQL,
  sha256File,
  sha256Buffer,
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
