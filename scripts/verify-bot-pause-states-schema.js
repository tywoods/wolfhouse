'use strict';
// ============================================================================
// verify-bot-pause-states-schema.js
// Static verifier for Phase 9.4a — bot_pause_states migration spec
// NO DB connection. NO migration apply.
// ============================================================================

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT           = path.resolve(__dirname, '..');
const MIGRATION_FILE = path.join(ROOT, 'database', 'migrations', '012_bot_pause_states.sql');
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
  check('A0', '012_bot_pause_states.sql exists', false, e.message);
}

const apiSrc = fs.existsSync(API_SRC) ? fs.readFileSync(API_SRC, 'utf8') : '';
const pkgJson = fs.existsSync(PKG) ? JSON.parse(fs.readFileSync(PKG, 'utf8')) : {};
const selfSrc = fs.readFileSync(SELF, 'utf8');

const REQUIRED_COLUMNS = [
  'id',
  'client_slug',
  'guest_phone',
  'conversation_id',
  'booking_id',
  'booking_code',
  'paused',
  'pause_reason',
  'paused_by',
  'paused_at',
  'resumed_by',
  'resumed_at',
  'metadata',
  'created_at',
  'updated_at',
];

// ── A. Migration file ────────────────────────────────────────────────────────
check('A1', 'migration 012 file exists', sql.length > 0);

check('A2', 'NOT YET APPLIED notice present', /NOT YET APPLIED/i.test(sql));

check('A3', 'transaction wrapped (BEGIN/COMMIT)',
  /^\s*BEGIN\s*;/m.test(sql) && /COMMIT\s*;/m.test(sql));

check('A4', 'CREATE TABLE IF NOT EXISTS bot_pause_states',
  /CREATE TABLE IF NOT EXISTS bot_pause_states/i.test(sql));

// ── B. Required columns ────────────────────────────────────────────────────
REQUIRED_COLUMNS.forEach((col, i) => {
  check(`B${i + 1}`, `column ${col} present`,
    new RegExp(`\\b${col}\\b`, 'i').test(sql));
});

check('B16', 'client_slug NOT NULL', /client_slug\s+TEXT\s+NOT NULL/i.test(sql));

check('B17', 'paused_by NOT NULL', /paused_by\s+TEXT\s+NOT NULL/i.test(sql));

check('B18', 'paused default true', /paused\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+TRUE/i.test(sql));

check('B19', 'metadata jsonb default',
  /metadata\s+JSONB\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i.test(sql));

// ── C. Scope CHECK constraint ────────────────────────────────────────────────
check('C1', 'CHECK requires guest_phone OR conversation_id',
  /CHECK\s*\(\s*guest_phone\s+IS NOT NULL\s+OR\s+conversation_id\s+IS NOT NULL\s*\)/i.test(sql)
  || /bot_pause_states_scope_required[\s\S]{0,120}guest_phone[\s\S]{0,80}conversation_id/i.test(sql));

// ── D. Indexes ───────────────────────────────────────────────────────────────
check('D1', 'index on client_slug',
  /idx_bot_pause_states_client_slug[\s\S]{0,120}\(\s*client_slug\s*\)/i.test(sql));

check('D2', 'partial index on conversation_id',
  /idx_bot_pause_states_conversation_id[\s\S]{0,200}WHERE\s+conversation_id\s+IS NOT NULL/i.test(sql));

check('D3', 'partial index on guest_phone',
  /idx_bot_pause_states_guest_phone[\s\S]{0,200}WHERE\s+guest_phone\s+IS NOT NULL/i.test(sql));

check('D4', 'partial index on booking_code',
  /idx_bot_pause_states_booking_code[\s\S]{0,200}WHERE\s+booking_code\s+IS NOT NULL/i.test(sql));

check('D5', 'partial unique active pause per client_slug + conversation_id',
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pause_states_active_conversation/i.test(sql)
  && /idx_bot_pause_states_active_conversation[\s\S]{0,200}\(\s*client_slug\s*,\s*conversation_id\s*\)/i.test(sql)
  && /idx_bot_pause_states_active_conversation[\s\S]{0,320}WHERE\s+paused\s*=\s*TRUE[\s\S]{0,80}conversation_id\s+IS NOT NULL/i.test(sql));

check('D6', 'partial unique active pause per client_slug + guest_phone (no conversation_id)',
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pause_states_active_phone/i.test(sql)
  && /idx_bot_pause_states_active_phone[\s\S]{0,200}\(\s*client_slug\s*,\s*guest_phone\s*\)/i.test(sql)
  && /idx_bot_pause_states_active_phone[\s\S]{0,360}WHERE\s+paused\s*=\s*TRUE[\s\S]{0,120}conversation_id\s+IS NULL[\s\S]{0,80}guest_phone\s+IS NOT NULL/i.test(sql));

// ── E. Source-of-truth comments (not bot_mode) ───────────────────────────────
check('E1', 'COMMENT ON TABLE bot_pause_states documents source of truth',
  /COMMENT ON TABLE bot_pause_states/i.test(sql)
  && /source of truth/i.test(sql));

check('E2', 'migration states do not use conversations.bot_mode as SoT',
  /do not use conversations\.bot_mode/i.test(sql)
  || /Do NOT use conversations\.bot_mode/i.test(sql));

check('E3', 'migration notes Staff Ask Luna not blocked',
  /Staff Ask Luna/i.test(sql) && /NOT blocked|not blocked/i.test(sql));

check('E4', 'migration notes guest automation scope only',
  /automated guest/i.test(sql) || /guest automation/i.test(sql) || /guest replies/i.test(sql));

// ── F. Migration safety (no data writes / no bot_mode mutation) ──────────────
check('F1', 'no INSERT', !/^\s*INSERT INTO\b/im.test(sql));

check('F2', 'no UPDATE', !/^\s*UPDATE\b/im.test(sql));

check('F3', 'no DELETE', !/^\s*DELETE FROM\b/im.test(sql));

check('F4', 'no TRUNCATE', !/\bTRUNCATE\b/i.test(sql));

check('F5', 'no DROP TABLE', !/\bDROP TABLE\b/i.test(sql));

check('F6', 'does not ALTER conversations.bot_mode',
  !/\bALTER TABLE\s+conversations\b/i.test(sql)
  && !/\bUPDATE\s+conversations\b/i.test(sql));

check('F7', 'no Stripe references', !/\bstripe\b/i.test(sql));

check('F8', 'no n8n references', !/\bn8n\b/i.test(sql));

// ── G. Repo safety ───────────────────────────────────────────────────────────
check('G1', 'verifier has no database connection code',
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

check('G2', 'staff-query-api.js not modified in this slice',
  !apiModified, apiModified ? 'file has uncommitted changes' : undefined);

check('G3', 'no /staff/bot/pause route in staff-query-api yet (future 9.4b)',
  !/\/staff\/bot\/pause/i.test(apiSrc));

// ── H. package.json script ───────────────────────────────────────────────────
check('H1', 'package.json verify:bot-pause-states-schema script',
  pkgJson.scripts
  && pkgJson.scripts['verify:bot-pause-states-schema']
  === 'node scripts/verify-bot-pause-states-schema.js');

// ── Print results ───────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-bot-pause-states-schema PASS');
  process.exit(0);
} else {
  console.log('verify-bot-pause-states-schema FAIL');
  process.exit(1);
}
