/**
 * Stage 7.7b — Static verifier for scripts/lib/staff-conversation-queries.js
 *
 * Checks (27 total):
 *   1–6:   Required exports exist
 *   7–12:  Each export is a function
 *  13–18:  Each function returns a string
 *  19–24:  SELECT-only (no UPDATE / INSERT / DELETE in returned SQL)
 *  25:     All queries are client-scoped ($1 = client slug)
 *  26:     Per-conversation queries use $2 = UUID cast
 *  27:     No eval / execSync / require('child_process')
 *
 * Usage:
 *   node scripts/verify-staff-conversation-queries.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const TARGET_FILE = path.join(__dirname, 'lib', 'staff-conversation-queries.js');
const EXPORTS = [
  'getConversationInboxQuery',
  'getConversationDetailQuery',
  'getConversationMessagesQuery',
  'getConversationContextQuery',
  'getConversationDraftQuery',
  'getConversationStaffStateQuery',
];

let passes = 0;
let failures = 0;

function ok(msg) {
  console.log(`  PASS  ${msg}`);
  passes++;
}

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}

function check(condition, msgPass, msgFail) {
  if (condition) ok(msgPass); else fail(msgFail || msgPass);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nverify-staff-conversation-queries.js\n');

// File existence
if (!fs.existsSync(TARGET_FILE)) {
  fail('File exists: scripts/lib/staff-conversation-queries.js');
  console.error('\n  Cannot continue — file missing.\n');
  process.exit(1);
}
ok('File exists: scripts/lib/staff-conversation-queries.js');

const src = fs.readFileSync(TARGET_FILE, 'utf8');

// Load module
let mod;
try {
  mod = require(TARGET_FILE);
} catch (err) {
  fail(`Module loads without error: ${err.message}`);
  process.exit(1);
}
ok('Module loads without error');

// Checks 1–6: Exports exist
for (const name of EXPORTS) {
  check(typeof mod[name] !== 'undefined', `Export exists: ${name}`);
}

// Checks 7–12: Exports are functions
for (const name of EXPORTS) {
  check(typeof mod[name] === 'function', `Export is a function: ${name}`);
}

// Checks 13–18: Each function returns a string
for (const name of EXPORTS) {
  if (typeof mod[name] !== 'function') {
    fail(`Return value is a string: ${name}() — skipped (not a function)`);
    continue;
  }
  try {
    const result = mod[name]();
    check(typeof result === 'string' && result.length > 10,
      `Return value is a non-empty string: ${name}()`);
  } catch (err) {
    fail(`Return value is a string: ${name}() — threw: ${err.message}`);
  }
}

// Checks 19–24: SELECT-only (no mutating SQL keywords in returned strings)
const MUTATION_RE = /\b(UPDATE|INSERT|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i;
for (const name of EXPORTS) {
  if (typeof mod[name] !== 'function') {
    fail(`SELECT-only: ${name}() — skipped`);
    continue;
  }
  let sql = '';
  try { sql = mod[name](); } catch (_) {}
  check(!MUTATION_RE.test(sql),
    `SELECT-only (no mutation keywords): ${name}()`);
}

// Check 25: All queries contain $1 (client slug)
let allClientScoped = true;
for (const name of EXPORTS) {
  if (typeof mod[name] !== 'function') continue;
  let sql = '';
  try { sql = mod[name](); } catch (_) {}
  if (!sql.includes('$1')) {
    allClientScoped = false;
    fail(`Client-scoped ($1 present): ${name}()`);
  }
}
if (allClientScoped) ok('All queries contain $1 (client slug scope)');

// Check 26: Per-conversation queries (detail, messages, context, draft, staff-state) use $2
const PER_CONV = ['getConversationDetailQuery', 'getConversationMessagesQuery',
                  'getConversationContextQuery', 'getConversationDraftQuery',
                  'getConversationStaffStateQuery'];
let allUuidParam = true;
for (const name of PER_CONV) {
  if (typeof mod[name] !== 'function') continue;
  let sql = '';
  try { sql = mod[name](); } catch (_) {}
  if (!sql.includes('$2') || !sql.toLowerCase().includes('uuid')) {
    allUuidParam = false;
    fail(`UUID param ($2::uuid): ${name}()`);
  }
}
if (allUuidParam) ok('Per-conversation queries use $2::uuid for conversation ID');

// Check 27: No dangerous patterns
const DANGER_RE = /\beval\s*\(|execSync|require\s*\(\s*['"]child_process/;
check(!DANGER_RE.test(src),
  'No eval / execSync / child_process in source');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
