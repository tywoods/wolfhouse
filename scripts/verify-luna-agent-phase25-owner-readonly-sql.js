/**
 * Phase 25d — Verifier for owner read-only SQL validator/executor.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-readonly-sql
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODULE = path.join(__dirname, 'lib', 'owner-readonly-sql.js');
const API = path.join(__dirname, 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25d-OWNER-READONLY-SQL.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'wolfhouse-somo';
const OTHER = 'sunset-surf-shop';

const UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js'),
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-whatsapp-router',
  'verify:luna-agent-phase25-staff-phone-access',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase25-owner-readonly-sql.js  (Phase 25d)\n');

try {
  execSync(`node --check "${MODULE}"`, { stdio: 'pipe' });
  pass('0', 'owner-readonly-sql.js passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const {
  normalizeOwnerSql,
  validateOwnerReadOnlySql,
  executeOwnerReadOnlySql,
  DEFAULT_MAX_LIMIT,
} = require('./lib/owner-readonly-sql');

const modSrc = readOrEmpty(MODULE);
const apiSrc = readOrEmpty(API);

section('A. Module exports + safety imports');

if (modSrc.includes('validateOwnerReadOnlySql') && modSrc.includes('executeOwnerReadOnlySql')) {
  pass('A1', 'validator + executor exported');
} else fail('A1', 'exports missing');

if (!modSrc.includes('luna-ai-provider') && !modSrc.includes('classifyAskLunaIntentWithAi')) {
  pass('A2', 'no AI provider imports');
} else fail('A2', 'AI provider imported');

if (!/stripe|sendWhatsApp|n8n|meta.*webhook/i.test(modSrc)) {
  pass('A3', 'no Stripe/WhatsApp/Meta/n8n in module');
} else fail('A3', 'forbidden integration in module');

if (!/runLunaGuestBooking|booking_write_preview|insert into bookings/i.test(modSrc)) {
  pass('A4', 'no booking/payment write helpers');
} else fail('A4', 'write helpers referenced');

if (modSrc.includes('BEGIN READ ONLY') && modSrc.includes('statement_timeout')) {
  pass('A5', 'executor uses READ ONLY tx + statement_timeout');
} else fail('A5', 'read-only transaction missing');

section('B. Validator — accept paths');

const validSelect = validateOwnerReadOnlySql({
  sql: 'SELECT booking_code FROM bookings WHERE client_slug = $1 LIMIT 10',
  client_slug: CLIENT,
});
if (validSelect.ok) pass('B1', 'valid SELECT + client_slug + LIMIT passes');
else fail('B1', `valid SELECT rejected: ${validSelect.error}`);

const validLiteral = validateOwnerReadOnlySql({
  sql: `SELECT id FROM bookings WHERE client_slug = '${CLIENT}' LIMIT 5`,
  client_slug: CLIENT,
});
if (validLiteral.ok) pass('B2', 'literal client_slug match passes');
else fail('B2', `literal slug rejected: ${validLiteral.error}`);

const validWith = validateOwnerReadOnlySql({
  sql: `WITH active AS (
    SELECT id FROM bookings WHERE client_slug = $1
  ) SELECT id FROM active LIMIT 3`,
  client_slug: CLIENT,
});
if (validWith.ok) pass('B3', 'read-only WITH ... SELECT passes');
else fail('B3', `WITH SELECT rejected: ${validWith.error}`);

const missingLimit = validateOwnerReadOnlySql({
  sql: 'SELECT booking_code FROM bookings WHERE client_slug = $1',
  client_slug: CLIENT,
});
if (missingLimit.ok && missingLimit.limit_enforced === true && missingLimit.append_limit === DEFAULT_MAX_LIMIT) {
  pass('B4', 'missing LIMIT safely enforced via append');
} else fail('B4', 'LIMIT enforcement missing');

section('C. Validator — reject paths');

function expectBlock(id, label, sql, clientSlug, errFragments) {
  const frags = Array.isArray(errFragments) ? errFragments : [errFragments];
  const v = validateOwnerReadOnlySql({ sql, client_slug: clientSlug || CLIENT });
  if (!v.ok && frags.some((f) => v.error === f || (v.reasons || []).includes(f))) {
    pass(id, label);
  } else {
    fail(id, `${label} — got ok=${v.ok} error=${v.error}`);
  }
}

expectBlock('C1', 'INSERT blocked', 'INSERT INTO bookings (client_slug) VALUES ($1)', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C2', 'UPDATE blocked', 'UPDATE bookings SET status = $1 WHERE client_slug = $2 LIMIT 1', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C3', 'DELETE blocked', 'DELETE FROM bookings WHERE client_slug = $1', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C4', 'DROP blocked', 'DROP TABLE bookings', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C5', 'ALTER blocked', 'ALTER TABLE bookings ADD COLUMN x int', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C6', 'TRUNCATE blocked', 'TRUNCATE bookings', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C7', 'CREATE blocked', 'CREATE TABLE evil (id int)', CLIENT, ['blocked_keyword', 'select_only']);
expectBlock('C8', 'COPY blocked', 'COPY bookings TO STDOUT', CLIENT, ['blocked_keyword', 'select_only']);

expectBlock('C9', 'multi-statement blocked',
  'SELECT id FROM bookings WHERE client_slug = $1 LIMIT 1; DELETE FROM bookings',
  CLIENT, 'multi_statement_blocked');

const commentNoise = validateOwnerReadOnlySql({
  sql: `SELECT booking_code FROM bookings WHERE client_slug = $1 LIMIT 1 -- DELETE FROM bookings`,
  client_slug: CLIENT,
});
if (commentNoise.ok) {
  pass('C10', 'line comments stripped before validation (no false DELETE block)');
} else {
  fail('C10', `valid SELECT with trailing comment rejected: ${commentNoise.error}`);
}

expectBlock('C11', 'missing client_slug blocked',
  'SELECT booking_code FROM bookings LIMIT 1', CLIENT, 'client_slug_filter_missing');

expectBlock('C12', 'wrong literal client_slug blocked',
  `SELECT booking_code FROM bookings WHERE client_slug = '${OTHER}' LIMIT 1`,
  CLIENT, 'client_slug_mismatch');

expectBlock('C13', 'LIMIT above max blocked',
  'SELECT booking_code FROM bookings WHERE client_slug = $1 LIMIT 500',
  CLIENT, 'limit_exceeds_max');

expectBlock('C14', 'disallowed table blocked',
  'SELECT id FROM auth_sessions WHERE client_slug = $1 LIMIT 1',
  CLIENT, 'table_not_allowed');

const writeCte = validateOwnerReadOnlySql({
  sql: `WITH w AS (INSERT INTO bookings (client_slug) VALUES ($1) RETURNING id)
        SELECT id FROM w LIMIT 1`,
  client_slug: CLIENT,
});
if (!writeCte.ok) pass('C15', 'write CTE blocked');
else fail('C15', 'write CTE should be blocked');

section('C2. Column allowlist enforcement (25e.2)');

function expectColumnBlock(id, label, sql, err) {
  const v = validateOwnerReadOnlySql({ sql, client_slug: CLIENT });
  if (!v.ok && v.error === err) pass(id, label);
  else fail(id, `${label} — got ok=${v.ok} error=${v.error}`);
}

expectColumnBlock('C16', 'raw_payload blocked',
  'SELECT id, raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  'sensitive_column_blocked');
expectColumnBlock('C17', 'SELECT * blocked',
  'SELECT * FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  'select_star_blocked');
expectColumnBlock('C18', 'metadata blocked on bookings',
  `SELECT b.metadata FROM bookings b WHERE b.id IN (
    SELECT booking_id FROM booking_service_records WHERE client_slug = $1
  ) LIMIT 5`,
  'sensitive_column_blocked');

const safeCols = validateOwnerReadOnlySql({
  sql: 'SELECT id, message_text FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  client_slug: CLIENT,
});
if (safeCols.ok) pass('C19', 'allowed columns still pass');
else fail('C19', `allowed columns blocked: ${safeCols.error}`);

section('D. Executor (mock pg)');

function createMockPg() {
  const log = [];
  return {
    log,
    query: async (sql, params) => {
      const norm = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: norm, params });
      if (/^BEGIN READ ONLY/i.test(norm)) return { rows: [] };
      if (/^SET LOCAL statement_timeout/i.test(norm)) return { rows: [] };
      if (/^COMMIT/i.test(norm)) return { rows: [] };
      if (/^ROLLBACK/i.test(norm)) return { rows: [] };
      if (/^SELECT/i.test(norm)) {
        return { rows: [{ booking_code: 'WH-TEST-1' }, { booking_code: 'WH-TEST-2' }] };
      }
      throw new Error(`unexpected sql: ${norm.slice(0, 60)}`);
    },
  };
}

(async () => {
  const pg = createMockPg();
  const execOk = await executeOwnerReadOnlySql(pg, {
    client_slug: CLIENT,
    sql: 'SELECT booking_code FROM bookings WHERE client_slug = $1',
    params: [CLIENT],
  });
  if (execOk.success && execOk.row_count === 2 && execOk.read_only === true) {
    pass('D1', 'executor returns rows on valid query');
  } else fail('D1', 'executor valid query failed');

  if (pg.log.some((q) => /^BEGIN READ ONLY/i.test(q.sql))
    && pg.log.some((q) => /^SET LOCAL statement_timeout/i.test(q.sql))) {
    pass('D2', 'executor opens READ ONLY tx and sets timeout');
  } else fail('D2', 'READ ONLY / timeout not logged');

  const pgAppend = createMockPg();
  const execAppend = await executeOwnerReadOnlySql(pgAppend, {
    client_slug: CLIENT,
    sql: 'SELECT booking_code FROM bookings WHERE client_slug = $1',
    params: [CLIENT],
  });
  const selectQ = pgAppend.log.find((q) => /^SELECT/i.test(q.sql));
  if (execAppend.success && selectQ && /LIMIT 100/i.test(selectQ.sql)) {
    pass('D3', 'executor appends LIMIT when missing');
  } else fail('D3', 'LIMIT append not applied in executor');

  const pgBad = createMockPg();
  const execBad = await executeOwnerReadOnlySql(pgBad, {
    client_slug: CLIENT,
    sql: 'DELETE FROM bookings WHERE client_slug = $1',
    params: [CLIENT],
  });
  if (!execBad.success && execBad.no_write_performed === true) {
    pass('D4', 'executor rejects blocked SQL without running SELECT');
  } else fail('D4', 'blocked SQL should not execute');

  section('E. API routes + untouched integrations');

  if (apiSrc.includes('/staff/owner/sql/validate') && apiSrc.includes('/staff/owner/sql/execute')) {
    pass('E1', 'staff API exposes owner sql validate/execute routes');
  } else fail('E1', 'routes missing from staff-query-api');

  if (apiSrc.includes('validateOwnerReadOnlySql') && apiSrc.includes('executeOwnerReadOnlySql')) {
    pass('E2', 'routes use owner-readonly-sql module');
  } else fail('E2', 'API not wired to module');

  const ownerSqlRouter = apiSrc.slice(
    apiSrc.indexOf('/staff/owner/sql/validate'),
    apiSrc.indexOf('/staff/owner/sql/execute') + 400,
  );
  if (/requireAuth\(req, res, 'operator'\)/.test(ownerSqlRouter)) {
    pass('E3', 'routes require operator+ session auth');
  } else fail('E3', 'auth gate missing');

  const ownerSqlHandlers = apiSrc.slice(
    apiSrc.indexOf('async function handleOwnerSqlValidate'),
    apiSrc.indexOf('async function handleOwnerSqlExecute') + 1200,
  );
  if (!/stripe|sendWhatsApp|n8n|luna-ai-provider|classifyAskLunaIntentWithAi/i.test(ownerSqlHandlers)) {
    pass('E4', 'owner sql handlers avoid Stripe/WhatsApp/n8n/AI');
  } else fail('E4', 'forbidden deps in handlers');

  for (const f of UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (src && !src.includes('owner-readonly-sql') && !src.includes('owner_readonly')) {
      pass(`E.${base}`, `${base} unchanged by 25d`);
    } else if (!src) {
      pass(`E.${base}`, `${base} not present (skip)`);
    } else {
      fail(`E.${base}`, `${base} touched unexpectedly`);
    }
  }

  section('F. Docs + npm script');

  if (fs.existsSync(DOC)) pass('F1', 'PHASE-25d-OWNER-READONLY-SQL.md exists');
  else fail('F1', 'doc missing');

  const doc = readOrEmpty(DOC);
  if (/SELECT-only|client_slug|LIMIT|25e/i.test(doc)) pass('F2', 'doc covers SELECT-only, scoping, LIMIT, 25e');
  else fail('F2', 'doc incomplete');

  const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-readonly-sql']) {
    pass('F3', 'npm script registered');
  } else fail('F3', 'npm script missing');

  section('G. Downstream scripts listed (not run)');

  for (const s of DOWNSTREAM) {
    if (pkg.scripts && pkg.scripts[s]) pass('G', `downstream registered: ${s}`);
    else fail('G', `downstream missing: ${s}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures === 0) {
    console.log(`PASS  (${passes} checks)`);
    process.exit(0);
  }
  console.error(`FAIL  (${failures} failed, ${passes} passed)`);
  process.exit(1);
})().catch((err) => {
  console.error('Verifier runtime error:', err);
  process.exit(1);
});
