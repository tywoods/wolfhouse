'use strict';
// ============================================================================
// verify-service-payment-linkage-schema.js
// Static verifier for Stage 8.8.19 — service payment linkage migration spec
// NO DB connection. NO migration apply.
// ============================================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT           = path.resolve(__dirname, '..');
const MIGRATION_FILE = path.join(ROOT, 'database', 'migrations', '011_service_payment_linkage.sql');
const API_SRC        = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG            = path.join(ROOT, 'package.json');
const SELF           = __filename;

let passed = 0;
let failed = 0;
const results = [];

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    results.push(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    results.push(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

let sql = '';
try {
  sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
} catch (e) {
  check('A0', '011_service_payment_linkage.sql exists', false, e.message);
}

const apiSrc = fs.existsSync(API_SRC) ? fs.readFileSync(API_SRC, 'utf8') : '';
const pkgJson = fs.existsSync(PKG) ? JSON.parse(fs.readFileSync(PKG, 'utf8')) : {};
const selfSrc = fs.readFileSync(SELF, 'utf8');

// ── A. Migration file ────────────────────────────────────────────────────────
check('A1', 'migration 011 file exists', sql.length > 0);

check('A2', 'NOT YET APPLIED notice present', /NOT YET APPLIED/i.test(sql));

check('A3', 'transaction wrapped (BEGIN/COMMIT)',
  /^\s*BEGIN\s*;/m.test(sql) && /COMMIT\s*;/m.test(sql));

check('A4', 'targets booking_service_records table',
  /booking_service_records/i.test(sql));

// ── B. payment_id column + FK ───────────────────────────────────────────────
check('B1', 'payment_id UUID column on booking_service_records',
  /ADD COLUMN IF NOT EXISTS payment_id\s+UUID/i.test(sql));

check('B2', 'payment_id FK to payments(id)',
  /payment_id\s+UUID\s+REFERENCES\s+payments\s*\(\s*id\s*\)/i.test(sql));

check('B3', 'payment_id nullable (no NOT NULL on payment_id)',
  !/payment_id\s+UUID\s+NOT NULL/i.test(sql));

check('B4', 'payment_id column comment (linkage + webhook truth)',
  /COMMENT ON COLUMN booking_service_records\.payment_id/i.test(sql)
  && /payment_id/i.test(sql)
  && /service_record_ids/i.test(sql));

// ── C. payment_id index ─────────────────────────────────────────────────────
check('C1', 'index idx_booking_service_records_payment_id on payment_id',
  /idx_booking_service_records_payment_id[\s\S]{0,160}\(\s*payment_id\s*\)/i.test(sql));

check('C2', 'partial index WHERE payment_id IS NOT NULL',
  /idx_booking_service_records_payment_id[\s\S]{0,200}WHERE\s+payment_id\s+IS NOT NULL/i.test(sql));

// ── D. payment_kind addon_service ───────────────────────────────────────────
check('D1', 'addon_service enum addition documented',
  /addon_service/i.test(sql));

check('D2', 'ALTER TYPE payment_kind ADD VALUE (ENUM pattern from 004)',
  /ALTER TYPE\s+payment_kind\s+ADD VALUE/i.test(sql));

check('D3', 'ENUM assumption documented in migration comments',
  /ENUM/i.test(sql) && /004_payment_schema_phase2/i.test(sql));

check('D4', 'payments.payment_kind comment updated for addon_service',
  /COMMENT ON COLUMN payments\.payment_kind/i.test(sql)
  && /addon_service/i.test(sql));

// ── E. Migration safety (no data writes) ─────────────────────────────────────
check('E1', 'no INSERT', !/^\s*INSERT INTO\b/im.test(sql));

check('E2', 'no UPDATE', !/^\s*UPDATE\b/im.test(sql));

check('E3', 'no DELETE', !/^\s*DELETE FROM\b/im.test(sql));

check('E4', 'no TRUNCATE', !/\bTRUNCATE\b/i.test(sql));

check('E5', 'no DROP TABLE', !/\bDROP TABLE\b/i.test(sql));

// ── F. Repo safety ───────────────────────────────────────────────────────────
check('F1', 'verifier has no database connection code',
  !/\brequire\s*\(\s*['"][^'"]*pg-connect/i.test(selfSrc)
  && !/\bwithPgClient\s*\(/i.test(selfSrc));

let apiModified = false;
try {
  const porcelain = execSync(
    'git status --porcelain -- scripts/staff-query-api.js',
    { encoding: 'utf8', cwd: ROOT },
  ).trim();
  apiModified = porcelain.length > 0;
} catch (_) {
  apiModified = false;
}

check('F2', 'staff-query-api.js not modified in this slice',
  !apiModified, apiModified ? 'file has uncommitted changes' : undefined);

check('F3', 'no addon_service webhook branch in staff-query-api (future slice)',
  !/payment_kind\s*[=!]==?\s*['"]addon_service['"]/i.test(apiSrc)
  && !/addon_service[\s\S]{0,80}booking_service_records/i.test(apiSrc));

check('F4', 'migration has no graph.facebook.com', !/graph\.facebook\.com/i.test(sql));

check('F5', 'migration has no n8n URLs', !/n8n\.io/i.test(sql));

check('F6', 'migration has no Stripe API URLs', !/api\.stripe\.com/i.test(sql));

// ── G. package.json script ───────────────────────────────────────────────────
check('G1', 'package.json verify:service-payment-linkage-schema script',
  pkgJson.scripts
  && pkgJson.scripts['verify:service-payment-linkage-schema']
  === 'node scripts/verify-service-payment-linkage-schema.js');

// ── Print results ───────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-service-payment-linkage-schema PASS');
  process.exit(0);
} else {
  console.log('verify-service-payment-linkage-schema FAIL');
  process.exit(1);
}
