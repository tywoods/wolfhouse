'use strict';
// ============================================================================
// verify-booking-service-records-schema.js
// Static verifier for Stage 8.8.7 — booking_service_records migration spec
// NO DB connection. NO migration apply.
// ============================================================================

const fs   = require('fs');
const path = require('path');

const ROOT           = path.resolve(__dirname, '..');
const MIGRATION_FILE = path.join(ROOT, 'database', 'migrations', '010_booking_service_records.sql');
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
  check('A0', '010_booking_service_records.sql exists', false, e.message);
}

const apiSrc = fs.existsSync(API_SRC) ? fs.readFileSync(API_SRC, 'utf8') : '';
const pkgJson = fs.existsSync(PKG) ? JSON.parse(fs.readFileSync(PKG, 'utf8')) : {};
const selfSrc = fs.readFileSync(SELF, 'utf8');

// ── A. Migration file ────────────────────────────────────────────────────────
check('A1', 'migration file exists', sql.length > 0);

check('A2', 'NOT YET APPLIED notice present', /NOT YET APPLIED/i.test(sql));

check('A3', 'transaction wrapped (BEGIN/COMMIT)',
  /^\s*BEGIN\s*;/m.test(sql) && /COMMIT\s*;/m.test(sql));

check('A4', 'CREATE TABLE IF NOT EXISTS booking_service_records',
  /CREATE TABLE IF NOT EXISTS booking_service_records\b/i.test(sql));

check('A5', 'idempotent (IF NOT EXISTS on table and indexes)',
  (sql.match(/IF NOT EXISTS/gi) || []).length >= 5);

// ── B. Required columns ────────────────────────────────────────────────────
const REQUIRED_COLUMNS = [
  'id', 'client_slug', 'booking_id', 'booking_code', 'guest_name',
  'service_type', 'service_date', 'quantity', 'status',
  'amount_due_cents', 'amount_paid_cents', 'payment_status', 'source',
  'notes', 'metadata', 'created_at', 'updated_at',
];

for (const col of REQUIRED_COLUMNS) {
  check(`B-${col}`, `column ${col} defined`, new RegExp(`\\b${col}\\b`, 'i').test(sql));
}

check('B-pk', 'id UUID PRIMARY KEY DEFAULT gen_random_uuid()',
  /id\s+UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i.test(sql));

check('B-fk', 'booking_id REFERENCES bookings(id)',
  /booking_id\s+UUID REFERENCES bookings\s*\(\s*id\s*\)/i.test(sql));

// ── C. CHECK constraints ───────────────────────────────────────────────────
check('C1', 'service_type CHECK (yoga, meal, surf_lesson, wetsuit, surfboard)',
  /service_type[\s\S]{0,200}CHECK\s*\(\s*service_type IN\s*\(\s*'yoga'\s*,\s*'meal'\s*,\s*'surf_lesson'\s*,\s*'wetsuit'\s*,\s*'surfboard'\s*\)/i.test(sql));

check('C2', 'status CHECK (requested, confirmed, paid, cancelled)',
  /status[\s\S]{0,200}CHECK\s*\(\s*status IN\s*\(\s*'requested'\s*,\s*'confirmed'\s*,\s*'paid'\s*,\s*'cancelled'\s*\)/i.test(sql));

check('C3', 'payment_status CHECK (not_requested, pending, paid, refunded, waived)',
  /payment_status[\s\S]{0,250}CHECK\s*\(\s*payment_status IN/i.test(sql)
  && /'not_requested'/.test(sql) && /'pending'/.test(sql) && /'paid'/.test(sql)
  && /'refunded'/.test(sql) && /'waived'/.test(sql));

check('C4', 'quantity > 0 CHECK',
  /quantity[\s\S]{0,120}CHECK\s*\(\s*quantity\s*>\s*0\s*\)/i.test(sql));

check('C5', 'amount_due_cents >= 0 CHECK',
  /amount_due_cents[\s\S]{0,120}CHECK\s*\(\s*amount_due_cents\s*>=\s*0\s*\)/i.test(sql));

check('C6', 'amount_paid_cents >= 0 CHECK',
  /amount_paid_cents[\s\S]{0,120}CHECK\s*\(\s*amount_paid_cents\s*>=\s*0\s*\)/i.test(sql));

// ── D. Indexes ─────────────────────────────────────────────────────────────
check('D1', 'index client_slug + service_date',
  /idx_booking_service_records_client_date[\s\S]{0,120}\(\s*client_slug\s*,\s*service_date\s*\)/i.test(sql));

check('D2', 'index client_slug + service_type + service_date',
  /idx_booking_service_records_client_type_date[\s\S]{0,120}client_slug\s*,\s*service_type\s*,\s*service_date/i.test(sql));

check('D3', 'index booking_id',
  /idx_booking_service_records_booking[\s\S]{0,120}\(\s*booking_id\s*\)/i.test(sql));

check('D4', 'index payment_status',
  /idx_booking_service_records_payment_status[\s\S]{0,120}\(\s*payment_status\s*\)/i.test(sql));

// ── E. Design comments ─────────────────────────────────────────────────────
check('E1', 'comment: Staff API/Postgres source of truth',
  /Staff API[\s\S]{0,40}source of truth/i.test(sql));

check('E2', 'comment: n8n pipe only',
  /n8n[\s\S]{0,60}pipe/i.test(sql));

check('E3', 'comment: no chat-log answers',
  /no chat/i.test(sql) || /never chat/i.test(sql) || /chat.log/i.test(sql));

check('E4', 'comment: Stripe/manual truth for paid',
  /Stripe webhook/i.test(sql) && /manual/i.test(sql));

check('E5', 'set_updated_at trigger on booking_service_records',
  /CREATE TRIGGER booking_service_records_updated_at[\s\S]{0,120}ON booking_service_records/i.test(sql));

// ── F. Migration safety (no destructive ops) ─────────────────────────────────
check('F1', 'no DROP TABLE', !/\bDROP TABLE\b/i.test(sql));

check('F2', 'no TRUNCATE', !/\bTRUNCATE\b/i.test(sql));

check('F3', 'no INSERT seed data in migration', !/^\s*INSERT INTO\b/im.test(sql));

// ── G. Repo safety (no runtime DB writes or API routes) ─────────────────────
check('G1', 'verifier has no database connection code',
  !/\brequire\s*\(\s*['"][^'"]*pg-connect/i.test(selfSrc)
  && !/\bwithPgClient\s*\(/i.test(selfSrc));

check('G2', 'no API route additions for booking_service_records',
  !apiSrc.includes('booking_service_records') && !apiSrc.includes('/staff/service-records'));

check('G3', 'migration has no graph.facebook.com', !/graph\.facebook\.com/i.test(sql));

check('G4', 'migration has no n8n webhook/integration URLs',
  !/n8n\.io/i.test(sql) && !/webhook.*n8n/i.test(sql));

check('G5', 'migration has no Stripe API URLs', !/api\.stripe\.com/i.test(sql));

// ── H. package.json script ───────────────────────────────────────────────────
check('H1', 'package.json verify:booking-service-records-schema script',
  pkgJson.scripts
  && pkgJson.scripts['verify:booking-service-records-schema']
  === 'node scripts/verify-booking-service-records-schema.js');

// ── Print results ───────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-booking-service-records-schema PASS');
  process.exit(0);
} else {
  console.log('verify-booking-service-records-schema FAIL');
  process.exit(1);
}
