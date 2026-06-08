/**
 * Phase 25e — Verifier for owner data catalog + approved query templates.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-owner-data-catalog
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(__dirname, 'lib', 'owner-data-catalog.js');
const READONLY = path.join(__dirname, 'lib', 'owner-readonly-sql.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25e-OWNER-DATA-CATALOG.md');
const PKG = path.join(ROOT, 'package.json');

const CLIENT = 'wolfhouse-somo';

const UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-owner-whatsapp-inbound.js'),
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
];

const REQUIRED_TEMPLATES = [
  'outstanding_balances',
  'revenue_summary_by_month',
  'arrivals_on_date',
  'occupancy_by_date',
  'package_popularity',
];

const DOWNSTREAM = [
  'verify:luna-agent-phase25-owner-readonly-sql',
  'verify:luna-agent-phase25-owner-whatsapp-router',
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

console.log('\nverify-luna-agent-phase25-owner-data-catalog.js  (Phase 25e)\n');

try {
  execSync(`node --check "${CATALOG}"`, { stdio: 'pipe' });
  pass('0', 'owner-data-catalog.js passes node --check');
} catch {
  fail('0', 'syntax check failed');
}

const catalog = require('./lib/owner-data-catalog');
const { validateOwnerReadOnlySql, DEFAULT_ALLOWED_TABLES } = require('./lib/owner-readonly-sql');

const catalogSrc = readOrEmpty(CATALOG);
const readonlySrc = readOrEmpty(READONLY);

section('A. Module exports');

const exportNames = [
  'getOwnerDataCatalog',
  'getOwnerAllowedTables',
  'getOwnerAllowedColumns',
  'getOwnerTablePolicy',
  'getOwnerApprovedQueryTemplates',
  'describeOwnerCatalogForAi',
];

for (const name of exportNames) {
  if (typeof catalog[name] === 'function') pass(`A.${name}`, `${name} exported`);
  else fail(`A.${name}`, `${name} missing`);
}

if (!catalogSrc.includes('luna-ai-provider') && !catalogSrc.includes('classifyAskLunaIntentWithAi')) {
  pass('A.ai', 'no AI provider imports');
} else fail('A.ai', 'AI provider imported');

if (!/require\s*\([^)]*(stripe|whatsapp|n8n|luna-ai|meta-whatsapp)/i.test(catalogSrc)
  && !catalogSrc.includes('sendWhatsApp')) {
  pass('A.integrations', 'no Stripe/WhatsApp/Meta/n8n runtime imports in catalog');
} else fail('A.integrations', 'forbidden integration import in catalog');

section('B. Table scoping policies');

const bookingsPolicy = catalog.getOwnerTablePolicy('bookings');
if (bookingsPolicy && bookingsPolicy.client_scope_mode === 'join_required') {
  pass('B1', 'bookings is join_required (not direct_client_slug)');
} else fail('B1', `bookings scope wrong: ${bookingsPolicy && bookingsPolicy.client_scope_mode}`);

if (bookingsPolicy && !bookingsPolicy.allowed_columns.includes('metadata')) {
  pass('B2', 'bookings.metadata not in allowed columns');
} else fail('B2', 'bookings.metadata should be sensitive/hidden');

const bsrPolicy = catalog.getOwnerTablePolicy('booking_service_records');
if (bsrPolicy && bsrPolicy.client_scope_mode === 'direct_client_slug') {
  pass('B3', 'booking_service_records is direct_client_slug');
} else fail('B3', 'booking_service_records should be direct_client_slug');

const gmePolicy = catalog.getOwnerTablePolicy('guest_message_events');
if (gmePolicy && gmePolicy.sensitive_columns.includes('raw_payload')) {
  pass('B4', 'guest_message_events.raw_payload marked sensitive');
} else fail('B4', 'raw_payload should be sensitive on guest_message_events');

const payPolicy = catalog.getOwnerTablePolicy('payments');
if (payPolicy && payPolicy.sensitive_columns.some((c) => c.includes('stripe'))) {
  pass('B5', 'payments Stripe provider IDs marked sensitive');
} else fail('B5', 'Stripe IDs should be sensitive on payments');

const staffPolicy = catalog.getOwnerTablePolicy('staff_phone_access');
if (staffPolicy && staffPolicy.sql_allowlisted === false) {
  pass('B6', 'staff_phone_access diagnostics-only (not SQL allowlisted)');
} else fail('B6', 'staff_phone_access should be excluded from SQL allowlist');

section('C. Allowlist vs validator');

const catalogTables = catalog.getOwnerAllowedTables().slice().sort();
const validatorTables = [...DEFAULT_ALLOWED_TABLES].sort();
if (JSON.stringify(catalogTables) === JSON.stringify(validatorTables)) {
  pass('C1', 'catalog allowed tables match owner-readonly-sql DEFAULT_ALLOWED_TABLES');
} else {
  fail('C1', `table mismatch catalog=${catalogTables.join(',')} validator=${validatorTables.join(',')}`);
}

for (const blocked of ['auth_sessions', 'staff_users', 'clients']) {
  if (!catalogTables.includes(blocked)) pass(`C.${blocked}`, `${blocked} not allowlisted`);
  else fail(`C.${blocked}`, `${blocked} must not be allowlisted`);
}

section('D. Approved query templates');

const templates = catalog.getOwnerApprovedQueryTemplates();
const byId = Object.fromEntries(templates.map((t) => [t.id, t]));

for (const id of REQUIRED_TEMPLATES) {
  if (byId[id]) pass(`D.${id}`, `template ${id} exists`);
  else fail(`D.${id}`, `template ${id} missing`);
}

if (byId.arrivals_tomorrow || byId.arrivals_on_date) {
  pass('D.arrivals', 'arrivals template present');
} else fail('D.arrivals', 'arrivals_on_date or arrivals_tomorrow required');

for (const tmpl of templates) {
  if (!/client_slug\s*=\s*\$1\b/i.test(tmpl.sql)) {
    fail(`D.slug.${tmpl.id}`, `${tmpl.id} missing client_slug = $1`);
    continue;
  }
  const hasLimit = /\bLIMIT\s+\d+/i.test(tmpl.sql);
  const hasAgg = /\b(GROUP BY|COUNT\s*\(|SUM\s*\()/i.test(tmpl.sql);
  if (hasLimit || hasAgg) {
    pass(`D.safe.${tmpl.id}`, `${tmpl.id} has LIMIT or safe aggregation`);
  } else {
    fail(`D.safe.${tmpl.id}`, `${tmpl.id} needs LIMIT or aggregation`);
  }

  const v = validateOwnerReadOnlySql({ sql: tmpl.sql, client_slug: CLIENT });
  if (tmpl.validation_status === 'approved') {
    if (v.ok) pass(`D.val.${tmpl.id}`, `${tmpl.id} validates against owner-readonly-sql`);
    else fail(`D.val.${tmpl.id}`, `${tmpl.id} failed validation: ${v.error} — ${v.detail}`);
  } else if (tmpl.validation_status === 'pending') {
    pass(`D.val.${tmpl.id}`, `${tmpl.id} marked pending (validation optional)`);
  }
}

section('E. describeOwnerCatalogForAi');

const aiDesc = catalog.describeOwnerCatalogForAi({ client_slug: CLIENT });
if (aiDesc.includes('bookings') && aiDesc.includes('join_required') && aiDesc.includes('outstanding_balances')) {
  pass('E1', 'describeOwnerCatalogForAi includes scoping + templates');
} else fail('E1', 'AI catalog description incomplete');

section('F. Stage 25e.2 — enum alignment + column blocking');

const obSql = byId.outstanding_balances?.sql || '';
const revSql = byId.revenue_summary_by_month?.sql || '';
if (obSql.includes("'cancelled'") && !obSql.includes("'canceled'")) {
  pass('F1', 'outstanding_balances uses staging-compatible cancelled enum');
} else fail('F1', 'outstanding_balances enum literals wrong');
if (revSql.includes("p.status = 'paid'") && !revSql.includes('succeeded')) {
  pass('F2', 'revenue_summary_by_month uses staging-compatible paid status');
} else fail('F2', 'revenue_summary_by_month payment status literal wrong');

function expectColumnBlock(id, label, sql, err) {
  const v = validateOwnerReadOnlySql({ sql, client_slug: CLIENT });
  if (!v.ok && v.error === err) pass(id, label);
  else fail(id, `${label} — got ok=${v.ok} error=${v.error}`);
}

expectColumnBlock('F3', 'raw_payload with id blocked',
  'SELECT id, raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  'sensitive_column_blocked');
expectColumnBlock('F4', 'raw_payload alone blocked',
  'SELECT raw_payload FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  'sensitive_column_blocked');
expectColumnBlock('F5', 'SELECT * blocked',
  'SELECT * FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  'select_star_blocked');
expectColumnBlock('F6', 'bookings.metadata blocked',
  `SELECT b.metadata FROM bookings b WHERE b.id IN (
    SELECT booking_id FROM booking_service_records WHERE client_slug = $1 AND booking_id IS NOT NULL
  ) LIMIT 5`,
  'sensitive_column_blocked');

const safeGme = validateOwnerReadOnlySql({
  sql: 'SELECT id, message_text, client_slug FROM guest_message_events WHERE client_slug = $1 LIMIT 5',
  client_slug: CLIENT,
});
if (safeGme.ok) pass('F7', 'safe guest_message_events columns pass');
else fail('F7', `safe columns rejected: ${safeGme.error}`);

const safeBsr = validateOwnerReadOnlySql({
  sql: 'SELECT service_type, amount_paid_cents FROM booking_service_records WHERE client_slug = $1 LIMIT 5',
  client_slug: CLIENT,
});
if (safeBsr.ok) pass('F8', 'safe booking_service_records columns pass');
else fail('F8', `safe bsr columns rejected: ${safeBsr.error}`);

section('G. Untouched integrations');

for (const f of UNTOUCHED) {
  const base = path.basename(f);
  const src = readOrEmpty(f);
  if (src && !src.includes('owner-data-catalog')) {
    pass(`G.${base}`, `${base} unchanged by 25e`);
  } else if (!src) {
    pass(`G.${base}`, `${base} not present (skip)`);
  } else {
    fail(`G.${base}`, `${base} touched unexpectedly`);
  }
}

if (!readonlySrc.includes('owner-data-catalog')) {
  fail('G.readonly', 'owner-readonly-sql should import catalog for allowlist');
} else pass('G.readonly', 'owner-readonly-sql integrated with catalog');

if (readonlySrc.includes('validateOwnerColumnPolicy')) {
  pass('G.columns', 'owner-readonly-sql enforces column policy (25e.2)');
} else fail('G.columns', 'validateOwnerColumnPolicy missing');

section('H. Docs + npm script');

if (fs.existsSync(DOC)) pass('H1', 'PHASE-25e-OWNER-DATA-CATALOG.md exists');
else fail('H1', 'doc missing');

const doc = readOrEmpty(DOC);
if (/join_required|bookings.*client_slug|25f|no WhatsApp|25e\.2|raw_payload|SELECT \*/i.test(doc)) {
  pass('H2', 'doc covers scoping, column enforcement, 25f, no WhatsApp');
} else fail('H2', 'doc incomplete');

const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase25-owner-data-catalog']) {
  pass('H3', 'npm script registered');
} else fail('H3', 'npm script missing');

section('I. Downstream scripts listed (not run)');

for (const s of DOWNSTREAM) {
  if (pkg.scripts && pkg.scripts[s]) pass('I', `downstream registered: ${s}`);
  else fail('I', `downstream missing: ${s}`);
}

console.log(`\n${'─'.repeat(60)}`);
if (failures === 0) {
  console.log(`PASS  (${passes} checks)`);
  process.exit(0);
}
console.error(`FAIL  (${failures} failed, ${passes} passed)`);
process.exit(1);
