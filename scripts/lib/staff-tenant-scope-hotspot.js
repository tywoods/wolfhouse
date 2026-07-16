'use strict';

/**
 * Stable hotspot identity for staff-tenant-scope debt registry (WB-3).
 * Registry keys are content fingerprints — line numbers are diagnostic only.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SENSITIVE_TABLES = [
  'bookings',
  'booking_service_records',
  'guest_message_events',
  'staff_conversations',
  'staff_conversation_messages',
  'customers',
  'tenant_services',
  'auth_sessions',
  'staff_users',
  'payments',
  'payment_records',
  'stripe_payment_events',
];

const TABLE_PATTERN = new RegExp(
  `\\b(${SENSITIVE_TABLES.join('|')})\\b`,
  'i',
);

const SCOPE_PATTERNS = [
  /\bclient_id\b/i,
  /\bclient_slug\b/i,
  /\btenant_id\b/i,
  /\blocation_id\b/i,
  /\bc\.slug\b/i,
  /\bclients\.slug\b/i,
  /\bJOIN\s+clients\b/i,
  /\bFROM\s+clients\b/i,
];

const GRANDFATHER_OK = /MULTICLIENT_SCOPE_OK:/;
const GRANDFATHER_TODO = /MULTICLIENT_SCOPE_TODO:/;

const WINDOW_RADIUS = 22;

const STAFF_API_PATH = path.join(__dirname, '..', 'staff-query-api.js');
const ACCOMMODATION_BOOKING_CREATE_PATH = path.join(
  __dirname,
  'luna-front-desk-accommodation-booking-create-service.js',
);

function relPath(repoRoot, abs) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

function collectScanFiles(repoRoot = path.join(__dirname, '..', '..')) {
  const libDir = path.join(repoRoot, 'scripts', 'lib');
  const out = new Set([
    path.join(repoRoot, 'scripts', 'staff-query-api.js'),
    path.join(repoRoot, 'scripts', 'lib', 'luna-front-desk-accommodation-booking-create-service.js'),
  ]);
  const namePatterns = [/query/i, /queries/i, /write/i, /writes/i, /staff-bot-v2-routes/i, /booking-create-service/i];
  let entries = [];
  try {
    entries = fs.readdirSync(libDir);
  } catch {
    return [...out];
  }
  for (const name of entries) {
    if (!name.endsWith('.js')) continue;
    if (namePatterns.some((re) => re.test(name))) {
      out.add(path.join(libDir, name));
    }
  }
  return [...out].sort();
}

function windowText(lines, lineIdx) {
  const start = Math.max(0, lineIdx - WINDOW_RADIUS);
  const end = Math.min(lines.length, lineIdx + WINDOW_RADIUS + 1);
  return lines.slice(start, end).join('\n');
}

function hasScopeInWindow(text) {
  return SCOPE_PATTERNS.some((re) => re.test(text));
}

function hasGrandfatherOk(text) {
  return GRANDFATHER_OK.test(text);
}

function hasGrandfatherTodo(text) {
  return GRANDFATHER_TODO.test(text);
}

function looksSqlContext(line) {
  if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO|WHERE)\b/i.test(line)) return true;
  if (/`[\s\S]*/.test(line) && TABLE_PATTERN.test(line)) return true;
  if (line.includes('${') && TABLE_PATTERN.test(line)) return true;
  return false;
}

function extractSqlFromLine(line, lines, lineIdx) {
  if (line.includes('`')) {
    const startIdx = line.indexOf('`');
    let buf = line.slice(startIdx + 1);
    if (!buf.includes('`')) {
      for (let j = lineIdx + 1; j < Math.min(lines.length, lineIdx + 12); j += 1) {
        buf += `\n${lines[j]}`;
        if (lines[j].includes('`')) break;
      }
    }
    const end = buf.indexOf('`');
    if (end >= 0) return buf.slice(0, end);
    return buf.trim();
  }
  const dbl = line.match(/'([^']*?)'/);
  if (dbl && /\b(SELECT|INSERT|UPDATE|DELETE|ALTER)\b/i.test(dbl[1])) return dbl[1];
  return line.trim();
}

function normalizeContent(text) {
  return String(text || '')
    .replace(/\$\d+/g, '$N')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function detectOperation(line, sqlText) {
  const src = `${line}\n${sqlText}`;
  if (/to_regclass|pg_catalog|conrelid/i.test(src)) return 'catalog_select';
  if (/\bALTER\s+TABLE\b/i.test(src)) return 'ddl_alter';
  if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line)) return 'comment';
  if (/console\.log\s*\(/.test(line)) return 'startup_log';
  if (/pathname\s*===/.test(line) || /if\s*\(\s*pathname/.test(line)) return 'route_dispatch';
  if (/Method not allowed/i.test(line)) return 'route_error_copy';
  if (/\^\/staff\//.test(line) || (/\/staff\/bookings\//.test(line) && /UUID_RE/.test(line))) return 'route_regex';
  if (/\.customers-|#tab-customers|user-select:|font-family:|border-radius:/i.test(line)) return 'ui_css';
  if (/<[a-z][\s\S]*customers/i.test(line) || /data-i18n=['"]customers\./i.test(line)) return 'ui_html';
  if (/portalT\(['"]customers\./i.test(line) || /textContent\s*=/.test(line)) return 'ui_js';
  if (/fetch\s*\(\s*['"]\/staff\//i.test(line)) return 'client_fetch';
  if (/error:\s*`/i.test(line) || /may not create/i.test(line)) return 'error_string';
  if (/\bUPDATE\s+auth_sessions\b/i.test(src)) return 'session_update';
  if (/\bUPDATE\b/i.test(src) && /`/.test(line)) return 'UPDATE';
  if (/\bINSERT\b/i.test(src) && /`/.test(line)) return 'INSERT';
  if (/\bDELETE\s+FROM\b/i.test(src)) return 'DELETE';
  if (/\bSELECT\b/i.test(src) && !/user-select:|#tab-customers[^`]*select\{/i.test(line)) return 'SELECT';
  return 'reference';
}

function detectOwner(lines, lineIdx) {
  for (let i = lineIdx; i >= Math.max(0, lineIdx - 120); i -= 1) {
    const line = lines[i];
    const fn = line.match(/(?:async\s+)?function\s+([A-Za-z0-9_]+)/);
    if (fn) return fn[1];
    const constFn = line.match(/(?:const|let|var)\s+([A-Z][A-Z0-9_]*)\s*=/);
    if (constFn) return constFn[1];
    const arrow = line.match(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/);
    if (arrow) return arrow[1];
  }
  return null;
}

function buildHotspotIdentity(repoRoot, rel, line, table, lines) {
  const lineIdx = line - 1;
  const rawLine = lines[lineIdx] || '';
  const sqlText = extractSqlFromLine(rawLine, lines, lineIdx);
  const operation = detectOperation(rawLine, sqlText);
  const owner = detectOwner(lines, lineIdx);
  const normalizedSql = normalizeContent(sqlText);
  const fingerprint = crypto
    .createHash('sha256')
    .update([rel, table, operation, owner || '', normalizedSql].join('\x1f'))
    .digest('hex')
    .slice(0, 16);

  return {
    fingerprint,
    file: rel,
    line,
    table,
    operation,
    owner,
    normalized_sql: normalizedSql.slice(0, 200),
    snippet: rawLine.trim().slice(0, 120),
  };
}

function scanSqlScopeDebt(repoRoot = path.join(__dirname, '..', '..')) {
  const debt = [];
  const todos = [];

  for (const filePath of collectScanFiles(repoRoot)) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const rel = relPath(repoRoot, filePath);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!TABLE_PATTERN.test(line)) continue;
      if (!looksSqlContext(line) && !/`/.test(line)) continue;

      const match = line.match(TABLE_PATTERN);
      const table = match ? match[1].toLowerCase() : 'unknown';
      const win = windowText(lines, i);

      if (hasGrandfatherOk(win)) continue;

      if (hasGrandfatherTodo(win)) {
        todos.push({ rel, line: i + 1, table });
        continue;
      }

      if (hasScopeInWindow(win)) continue;

      const identity = buildHotspotIdentity(repoRoot, rel, i + 1, table, lines);
      const hit = { ...identity, rel };
      debt.push(hit);
    }
  }

  return { debt, todos };
}

function windowTextForHit(repoRoot, hit) {
  const filePath = path.join(repoRoot, hit.rel);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  return windowText(lines, hit.line - 1);
}

function loadScopeDebtRegistry(registryPath) {
  const raw = fs.readFileSync(registryPath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  const schemaVersion = parsed.schema_version || 1;
  if (schemaVersion < 2) {
    throw new Error(
      `registry schema_version ${schemaVersion} is obsolete — regenerate fingerprint-keyed registry (schema v2)`,
    );
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const byFingerprint = new Map();
  for (const entry of entries) {
    if (!entry.fingerprint) {
      throw new Error(`registry entry missing fingerprint: ${entry.id || entry.file}`);
    }
    if (byFingerprint.has(entry.fingerprint)) {
      throw new Error(`duplicate registry fingerprint ${entry.fingerprint}`);
    }
    byFingerprint.set(entry.fingerprint, entry);
  }
  return { meta: parsed, entries, byFingerprint };
}

function classifyDebtHotspots(debt, registryByFingerprint) {
  const unclassified = [];
  const classified = [];
  const matchedFingerprints = new Set();

  for (const hit of debt) {
    const entry = registryByFingerprint.get(hit.fingerprint);
    if (!entry) {
      unclassified.push(hit);
      continue;
    }
    matchedFingerprints.add(hit.fingerprint);
    classified.push({ hit, entry });
  }

  const stale = [];
  for (const entry of registryByFingerprint.values()) {
    if (!matchedFingerprints.has(entry.fingerprint)) {
      stale.push(entry);
    }
  }

  return { unclassified, classified, stale };
}

function summarizeClassification(classified) {
  const byStatus = { ok: 0, todo: 0 };
  const byRisk = {
    false_positive: 0,
    ok_session_or_indirect_scope: 0,
    must_fix_before_shared_staging_router: 0,
    must_fix_before_live_multiclient: 0,
  };
  const todoItems = [];

  for (const { hit, entry } of classified) {
    if (entry.status === 'ok') byStatus.ok += 1;
    else if (entry.status === 'todo') {
      byStatus.todo += 1;
      todoItems.push({ hit, entry });
    }
    if (entry.risk && Object.prototype.hasOwnProperty.call(byRisk, entry.risk)) {
      byRisk[entry.risk] += 1;
    }
  }

  return { byStatus, byRisk, todoItems };
}

function classifyHotspotByEvidence(identity) {
  const { operation, normalized_sql: sql, table, owner } = identity;

  if (operation === 'session_update') {
    return {
      status: 'ok',
      risk: 'ok_session_or_indirect_scope',
      reason: 'Logout revokes caller session by hashed cookie token; session boundary is the scope.',
    };
  }
  if (operation === 'ddl_alter') {
    return {
      status: 'ok',
      risk: 'false_positive',
      reason: 'Schema DDL helper, not tenant row access.',
    };
  }
  if (operation === 'catalog_select') {
    return {
      status: 'ok',
      risk: 'false_positive',
      reason: 'Postgres catalog/schema introspection, not tenant data access.',
    };
  }
  if (['comment', 'route_regex', 'route_dispatch', 'route_error_copy', 'startup_log',
    'ui_css', 'ui_html', 'ui_js', 'client_fetch', 'error_string', 'reference'].includes(operation)) {
    const reasonByOp = {
      comment: 'Comment or config note only; not executable SQL.',
      route_regex: 'Route path regex; not SQL.',
      route_dispatch: 'Router branch; not SQL.',
      route_error_copy: 'HTTP error copy only.',
      startup_log: 'Startup route listing log; table name in URL string only.',
      ui_css: 'CSS selector; not SQL.',
      ui_html: 'Portal HTML template; not SQL.',
      ui_js: 'UI text assignment only.',
      client_fetch: 'Browser fetch to API route; no SQL on this line.',
      error_string: 'User-facing error string; not executable SQL.',
      reference: 'Non-SQL reference to sensitive table name.',
    };
    return {
      status: 'ok',
      risk: 'false_positive',
      reason: reasonByOp[operation] || 'Non-SQL reference; scanner hotspot only.',
    };
  }

  return {
    status: 'todo',
    risk: 'must_fix_before_live_multiclient',
    reason: `Unclassified tenant-sensitive ${operation} on ${table}${owner ? ` in ${owner}` : ''}; review manually.`,
    suggested_fix: 'Add client_id/client_slug predicate or JOIN clients/bookings for defense-in-depth.',
  };
}

function buildRegistryEntryFromHotspot(hit) {
  const classification = classifyHotspotByEvidence(hit);
  const slug = `${hit.file.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${hit.fingerprint}`;
  return {
    fingerprint: hit.fingerprint,
    file: hit.file,
    line: hit.line,
    table: hit.table,
    operation: hit.operation,
    owner: hit.owner,
    normalized_sql: hit.normalized_sql,
    snippet: hit.snippet,
    id: slug,
    status: classification.status,
    risk: classification.risk,
    reason: classification.reason,
    ...(classification.suggested_fix ? { suggested_fix: classification.suggested_fix } : {}),
  };
}

function scanTextDebt(repoRoot, relPathStr, text) {
  const lines = text.split(/\r?\n/);
  const debt = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!TABLE_PATTERN.test(line)) continue;
    if (!looksSqlContext(line) && !/`/.test(line)) continue;
    const match = line.match(TABLE_PATTERN);
    const table = match ? match[1].toLowerCase() : 'unknown';
    const win = windowText(lines, i);
    if (hasGrandfatherOk(win) || hasGrandfatherTodo(win) || hasScopeInWindow(win)) continue;
    const identity = buildHotspotIdentity(repoRoot, relPathStr, i + 1, table, lines);
    debt.push({ ...identity, rel: relPathStr });
  }
  return debt;
}

function extractFunctionBody(source, fnName) {
  const start = source.indexOf(`async function ${fnName}`);
  if (start < 0) return '';
  const rest = source.slice(start);
  const end = rest.search(/\nasync function [A-Za-z0-9_]+/);
  return end > 0 ? rest.slice(0, end) : rest;
}

function assertDraftPaymentLinkClientScope(source) {
  const body = extractFunctionBody(source, 'createDraftPaymentStripeLink');
  return /UPDATE payments[\s\S]*?WHERE id = \$5::uuid AND client_id = \$6/.test(body);
}

function assertBalancePaymentLinkClientScope(source) {
  const body = extractFunctionBody(source, 'createBookingBalancePaymentLink');
  return /UPDATE payments[\s\S]*?WHERE id = \$5::uuid AND client_id = \$6/.test(body);
}

function findDuplicateScanFingerprints(debt) {
  const byFp = new Map();
  for (const hit of debt) {
    if (!byFp.has(hit.fingerprint)) byFp.set(hit.fingerprint, []);
    byFp.get(hit.fingerprint).push(hit);
  }
  const out = [];
  for (const [fingerprint, hits] of byFp) {
    if (hits.length > 1) out.push({ fingerprint, hits, count: hits.length });
  }
  return out;
}

module.exports = {
  SENSITIVE_TABLES,
  STAFF_API_PATH,
  ACCOMMODATION_BOOKING_CREATE_PATH,
  collectScanFiles,
  scanSqlScopeDebt,
  scanTextDebt,
  windowTextForHit,
  buildHotspotIdentity,
  loadScopeDebtRegistry,
  classifyDebtHotspots,
  summarizeClassification,
  classifyHotspotByEvidence,
  buildRegistryEntryFromHotspot,
  assertDraftPaymentLinkClientScope,
  assertBalancePaymentLinkClientScope,
  findDuplicateScanFingerprints,
  normalizeContent,
};
