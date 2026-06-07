'use strict';

/**
 * Phase 25d — Owner Command Center read-only SQL validator and executor.
 *
 * Safety layer before AI SQL planning (25e+). SELECT-only, client-scoped, allowlisted tables.
 *
 * @module owner-readonly-sql
 */

const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_TIMEOUT_MS = 3000;

/** Tables owner BI queries may reference (Stage 25d foundation; 25e adds catalog). */
const DEFAULT_ALLOWED_TABLES = Object.freeze([
  'bookings',
  'payments',
  'booking_beds',
  'booking_service_records',
  'rooms',
  'beds',
  'conversations',
  'messages',
  'guest_message_events',
]);

/** Tables that require an explicit client_slug filter in the query text. */
const CLIENT_SCOPED_TABLES = new Set(DEFAULT_ALLOWED_TABLES);

const BLOCKED_KEYWORD_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|COPY|GRANT|REVOKE|VACUUM|ANALYZE|CALL|DO|EXECUTE|INTO)\b/i;

const FROM_JOIN_TABLE_RE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?[a-z_][a-z0-9_]*)?/gi;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Strip SQL comments so blocked keywords cannot hide in line or block comments.
 *
 * @param {string} sql
 * @returns {string}
 */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const s = String(sql || '');
  while (i < s.length) {
    if (s[i] === '-' && s[i + 1] === '-') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (s[i] === "'" || s[i] === '"') {
      const q = s[i];
      out += s[i];
      i += 1;
      while (i < s.length) {
        out += s[i];
        if (s[i] === q) {
          if (s[i + 1] === q) {
            out += s[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * Normalize SQL for validation (comments stripped, whitespace collapsed).
 *
 * @param {string} sql
 * @returns {string}
 */
function normalizeOwnerSql(sql) {
  return stripSqlComments(sql).replace(/\s+/g, ' ').trim();
}

function extractCteNames(normalizedSql) {
  const names = new Set();
  if (!/^WITH\b/i.test(normalizedSql)) return names;
  const re = /\b(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi;
  let m;
  while ((m = re.exec(normalizedSql)) !== null) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

function extractReferencedTables(normalizedSql) {
  const cteNames = extractCteNames(normalizedSql);
  const tables = new Set();
  let m;
  const re = new RegExp(FROM_JOIN_TABLE_RE.source, 'gi');
  while ((m = re.exec(normalizedSql)) !== null) {
    const name = m[1].toLowerCase();
    if (!cteNames.has(name)) tables.add(name);
  }
  return [...tables];
}

function isMultiStatement(normalizedSql) {
  const trimmed = normalizedSql.replace(/;\s*$/, '').trim();
  return trimmed.includes(';');
}

function startsWithSelectOrWith(normalizedSql) {
  return /^(SELECT|WITH)\b/i.test(normalizedSql);
}

function validateWithReadOnly(normalizedSql) {
  if (!/^WITH\b/i.test(normalizedSql)) return { ok: true };
  const upper = normalizedSql.toUpperCase();
  const lastSelectIdx = upper.lastIndexOf('SELECT');
  if (lastSelectIdx < 0) {
    return { ok: false, error: 'with_must_end_in_select', detail: 'WITH query must include a final SELECT' };
  }
  const beforeFinalSelect = normalizedSql.slice(0, lastSelectIdx);
  if (BLOCKED_KEYWORD_RE.test(beforeFinalSelect)) {
    return { ok: false, error: 'with_write_cte_blocked', detail: 'WITH clause may not contain write statements' };
  }
  return { ok: true };
}

function validateClientSlugConstraint(normalizedSql, clientSlug) {
  const slug = trimStr(clientSlug);
  if (!slug) {
    return { ok: false, error: 'client_slug_required', detail: 'client_slug is required for validation' };
  }

  const hasParamBinding = /client_slug\s*=\s*\$1\b/i.test(normalizedSql);
  const literalRe = /client_slug\s*=\s*'([^']*)'/gi;
  let literalMatch;
  let hasMatchingLiteral = false;
  while ((literalMatch = literalRe.exec(normalizedSql)) !== null) {
    if (literalMatch[1] !== slug) {
      return {
        ok: false,
        error: 'client_slug_mismatch',
        detail: `SQL references client_slug '${literalMatch[1]}' but expected '${slug}'`,
      };
    }
    hasMatchingLiteral = true;
  }

  if (!hasParamBinding && !hasMatchingLiteral) {
    return {
      ok: false,
      error: 'client_slug_filter_missing',
      detail: 'Query must filter client_slug = $1 or client_slug = \'<client_slug>\'',
    };
  }

  return { ok: true, uses_param_binding: hasParamBinding };
}

function validateLimitClause(normalizedSql, maxLimit) {
  const cap = Number(maxLimit) > 0 ? Number(maxLimit) : DEFAULT_MAX_LIMIT;
  const limitMatch = normalizedSql.match(/\bLIMIT\s+(\d+)/i);
  if (!limitMatch) {
    return { ok: true, limit_missing: true, append_limit: cap };
  }
  const n = parseInt(limitMatch[1], 10);
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: 'invalid_limit', detail: 'LIMIT must be a positive integer' };
  }
  if (n > cap) {
    return {
      ok: false,
      error: 'limit_exceeds_max',
      detail: `LIMIT ${n} exceeds maximum allowed ${cap}`,
    };
  }
  return { ok: true, limit_value: n };
}

function validateAllowedTables(normalizedSql, allowedTables) {
  const allow = allowedTables instanceof Set
    ? allowedTables
    : new Set((allowedTables || DEFAULT_ALLOWED_TABLES).map((t) => String(t).toLowerCase()));
  const refs = extractReferencedTables(normalizedSql);
  for (const table of refs) {
    if (!allow.has(table)) {
      return {
        ok: false,
        error: 'table_not_allowed',
        detail: `Table '${table}' is not in the owner read-only allowlist`,
        table,
      };
    }
  }
  return { ok: true, referenced_tables: refs };
}

function validateClientScopedTablesPresent(normalizedSql) {
  const refs = extractReferencedTables(normalizedSql);
  const scopedUsed = refs.filter((t) => CLIENT_SCOPED_TABLES.has(t));
  if (scopedUsed.length === 0) {
    return {
      ok: false,
      error: 'no_client_scoped_table',
      detail: 'Query must reference at least one client-scoped allowlisted table',
    };
  }
  return { ok: true, scoped_tables: scopedUsed };
}

function buildSqlSummary(normalizedSql) {
  const s = trimStr(normalizedSql);
  if (s.length <= 120) return s;
  return `${s.slice(0, 117)}...`;
}

function prepareExecutableSql(originalSql, validationMeta) {
  let sql = trimStr(originalSql).replace(/;\s*$/, '');
  if (validationMeta.append_limit) {
    sql = `${sql} LIMIT ${validationMeta.append_limit}`;
  }
  return sql;
}

/**
 * Validate owner read-only SQL before execution.
 *
 * @param {{ sql: string, client_slug: string, allowedTables?: string[], maxLimit?: number }} opts
 * @returns {{ ok: boolean, error?: string, detail?: string, reasons?: string[], normalized_sql?: string, sql_to_execute?: string, append_limit?: number, limit_enforced?: boolean, read_only?: true }}
 */
function validateOwnerReadOnlySql(opts = {}) {
  const sql = trimStr(opts.sql);
  const clientSlug = trimStr(opts.client_slug);
  const maxLimit = Number(opts.maxLimit) > 0 ? Number(opts.maxLimit) : DEFAULT_MAX_LIMIT;
  const reasons = [];

  if (!sql) {
    return { ok: false, error: 'sql_required', detail: 'sql is required', reasons: ['sql_required'] };
  }

  const normalized = normalizeOwnerSql(sql);
  if (!normalized) {
    return { ok: false, error: 'sql_empty', detail: 'sql is empty after normalization', reasons: ['sql_empty'] };
  }

  if (isMultiStatement(normalized)) {
    reasons.push('multi_statement_blocked');
    return {
      ok: false,
      error: 'multi_statement_blocked',
      detail: 'Only a single SQL statement is allowed',
      reasons,
      normalized_sql: normalized,
    };
  }

  if (BLOCKED_KEYWORD_RE.test(normalized)) {
    reasons.push('blocked_keyword');
    return {
      ok: false,
      error: 'blocked_keyword',
      detail: 'Query contains blocked write or DDL keywords',
      reasons,
      normalized_sql: normalized,
    };
  }

  if (!startsWithSelectOrWith(normalized)) {
    reasons.push('select_only');
    return {
      ok: false,
      error: 'select_only',
      detail: 'Only SELECT or read-only WITH ... SELECT queries are allowed',
      reasons,
      normalized_sql: normalized,
    };
  }

  const withCheck = validateWithReadOnly(normalized);
  if (!withCheck.ok) {
    reasons.push(withCheck.error);
    return { ...withCheck, ok: false, reasons, normalized_sql: normalized };
  }

  const tableCheck = validateAllowedTables(normalized, opts.allowedTables);
  if (!tableCheck.ok) {
    reasons.push(tableCheck.error);
    return { ...tableCheck, ok: false, reasons, normalized_sql: normalized };
  }

  const scopedCheck = validateClientScopedTablesPresent(normalized);
  if (!scopedCheck.ok) {
    reasons.push(scopedCheck.error);
    return { ...scopedCheck, ok: false, reasons, normalized_sql: normalized };
  }

  const slugCheck = validateClientSlugConstraint(normalized, clientSlug);
  if (!slugCheck.ok) {
    reasons.push(slugCheck.error);
    return { ...slugCheck, ok: false, reasons, normalized_sql: normalized };
  }

  const limitCheck = validateLimitClause(normalized, maxLimit);
  if (!limitCheck.ok) {
    reasons.push(limitCheck.error);
    return { ...limitCheck, ok: false, reasons, normalized_sql: normalized };
  }

  const sqlToExecute = prepareExecutableSql(sql, limitCheck);

  return {
    ok: true,
    normalized_sql: normalized,
    sql_to_execute: sqlToExecute,
    append_limit: limitCheck.limit_missing ? limitCheck.append_limit : undefined,
    limit_enforced: limitCheck.limit_missing === true,
    referenced_tables: tableCheck.referenced_tables,
    read_only: true,
    reasons,
  };
}

/**
 * Execute validated owner read-only SQL inside a READ ONLY transaction.
 *
 * @param {import('pg').Client} pg
 * @param {{ client_slug: string, sql: string, params?: unknown[], maxRows?: number, maxLimit?: number, timeoutMs?: number, allowedTables?: string[] }} opts
 */
async function executeOwnerReadOnlySql(pg, opts = {}) {
  const started = Date.now();
  const clientSlug = trimStr(opts.client_slug);
  const maxRows = Number(opts.maxRows) > 0 ? Number(opts.maxRows) : DEFAULT_MAX_ROWS;
  const maxLimit = Number(opts.maxLimit) > 0 ? Number(opts.maxLimit) : DEFAULT_MAX_LIMIT;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const params = Array.isArray(opts.params) ? opts.params : [];

  const validation = validateOwnerReadOnlySql({
    sql: opts.sql,
    client_slug: clientSlug,
    allowedTables: opts.allowedTables,
    maxLimit,
  });

  if (!validation.ok) {
    return {
      success: false,
      error: validation.error,
      detail: validation.detail,
      reasons: validation.reasons || [],
      read_only: true,
      no_write_performed: true,
      elapsed_ms: Date.now() - started,
    };
  }

  if (validation.normalized_sql && /client_slug\s*=\s*\$1\b/i.test(validation.normalized_sql)) {
    if (params.length < 1 || trimStr(params[0]) !== clientSlug) {
      return {
        success: false,
        error: 'client_slug_param_mismatch',
        detail: 'When using client_slug = $1, params[0] must equal client_slug',
        read_only: true,
        no_write_performed: true,
        elapsed_ms: Date.now() - started,
      };
    }
  }

  const sqlToRun = validation.sql_to_execute;
  let rows = [];

  try {
    await pg.query('BEGIN READ ONLY');
    await pg.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const result = await pg.query(sqlToRun, params);
    rows = result.rows || [];
    await pg.query('COMMIT');
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      success: false,
      error: 'query_error',
      detail: err.message,
      sql_summary: buildSqlSummary(validation.normalized_sql),
      read_only: true,
      no_write_performed: true,
      elapsed_ms: Date.now() - started,
    };
  }

  const limited = rows.length > maxRows;
  if (limited) rows = rows.slice(0, maxRows);

  return {
    success: true,
    rows,
    row_count: rows.length,
    limited,
    sql_summary: buildSqlSummary(validation.normalized_sql),
    limit_enforced: validation.limit_enforced === true,
    append_limit: validation.append_limit,
    elapsed_ms: Date.now() - started,
    read_only: true,
    no_write_performed: true,
  };
}

module.exports = {
  DEFAULT_MAX_LIMIT,
  DEFAULT_MAX_ROWS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ALLOWED_TABLES,
  CLIENT_SCOPED_TABLES,
  stripSqlComments,
  normalizeOwnerSql,
  validateOwnerReadOnlySql,
  executeOwnerReadOnlySql,
  extractReferencedTables,
};
