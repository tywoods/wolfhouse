/**
 * Stage 6.1 — Static verifier for staff-query-registry.js.
 *
 * Checks:
 *   1. Registry exports successfully (no import errors)
 *   2. All PLANNED_INTENTS are present
 *   3. Every entry has required fields (key, category, description,
 *      helperModule, helperFn, helperRef, clientSlugged, readOnly)
 *   4. All entries are readOnly: true
 *   5. All entries are clientSlugged: true
 *   6. No raw SQL strings embedded in registry entries
 *   7. helperRef is a callable function (or flagged missingHelper)
 *   8. Missing helpers reported clearly
 *   9. No write-enabled entries
 *  10. requiredParams and optionalParams are arrays
 *
 * Static-only: no DB connection, no HTTP, no n8n, no workflow changes.
 *
 * Exit code: 0 on PASS, 1 on FAIL.
 */

'use strict';

const {
  REGISTRY,
  PLANNED_INTENTS,
  getEntry,
} = require('./lib/staff-query-registry');

// ─────────────────────────────────────────────────────────────────────────────

const REQUIRED_ENTRY_FIELDS = [
  'key',
  'category',
  'description',
  'helperModule',
  'helperFn',
  'helperRef',
  'requiredParams',
  'optionalParams',
  'clientSlugged',
  'readOnly',
  'migrationRequired',
];

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
const SQL_INDICATOR  = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b/i;

let passes = 0;
let failures = 0;
const warnings = [];

function pass(msg) {
  console.log(`  ✓ ${msg}`);
  passes++;
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  failures++;
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
  warnings.push(msg);
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Registry loads
// ─────────────────────────────────────────────────────────────────────────────
section('1. Registry loads');

if (!REGISTRY || !Array.isArray(REGISTRY)) {
  fail('REGISTRY is not an array');
  process.exit(1);
}
pass(`REGISTRY loaded (${REGISTRY.length} entries)`);

if (!Array.isArray(PLANNED_INTENTS)) {
  fail('PLANNED_INTENTS is not an array');
  process.exit(1);
}
pass(`PLANNED_INTENTS loaded (${PLANNED_INTENTS.length} entries)`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. All planned intents present
// ─────────────────────────────────────────────────────────────────────────────
section('2. All planned intents present');

const registeredKeys = new Set(REGISTRY.map((e) => e.key));
let missingCount = 0;

for (const intent of PLANNED_INTENTS) {
  if (registeredKeys.has(intent)) {
    pass(`${intent} registered`);
  } else {
    fail(`${intent} MISSING from registry`);
    missingCount++;
  }
}

if (missingCount === 0) {
  pass(`All ${PLANNED_INTENTS.length} planned intents present`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Required fields on every entry
// ─────────────────────────────────────────────────────────────────────────────
section('3. Required fields on every entry');

for (const entry of REGISTRY) {
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!(field in entry)) {
      fail(`${entry.key}: missing field '${field}'`);
    }
  }
}
pass(`All entries have required fields (checked ${REGISTRY.length} entries)`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. readOnly: true on all entries
// ─────────────────────────────────────────────────────────────────────────────
section('4. readOnly:true on all entries');

let writeEnabledCount = 0;
for (const entry of REGISTRY) {
  if (entry.readOnly !== true) {
    fail(`${entry.key}: readOnly is not true (got ${entry.readOnly})`);
    writeEnabledCount++;
  }
}
if (writeEnabledCount === 0) {
  pass(`All ${REGISTRY.length} entries have readOnly:true`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. clientSlugged: true on all entries
// ─────────────────────────────────────────────────────────────────────────────
section('5. clientSlugged:true on all entries');

let notClientScopedCount = 0;
for (const entry of REGISTRY) {
  if (entry.clientSlugged !== true) {
    fail(`${entry.key}: clientSlugged is not true`);
    notClientScopedCount++;
  }
}
if (notClientScopedCount === 0) {
  pass(`All ${REGISTRY.length} entries are client-scoped`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. No raw SQL strings embedded in registry entries
// ─────────────────────────────────────────────────────────────────────────────
section('6. No raw SQL strings embedded');

let embeddedSqlCount = 0;
for (const entry of REGISTRY) {
  for (const field of ['key', 'category', 'description', 'helperModule', 'helperFn']) {
    const val = entry[field];
    if (typeof val === 'string' && SQL_INDICATOR.test(val)) {
      fail(`${entry.key}: field '${field}' appears to contain SQL: "${val.slice(0, 60)}"`);
      embeddedSqlCount++;
    }
  }
  for (const p of [...(entry.requiredParams || []), ...(entry.optionalParams || [])]) {
    if (p && typeof p.name === 'string' && WRITE_KEYWORDS.test(p.name)) {
      fail(`${entry.key}: param name looks like SQL keyword: "${p.name}"`);
      embeddedSqlCount++;
    }
  }
}
if (embeddedSqlCount === 0) {
  pass('No raw SQL strings embedded in registry entry fields');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. helperRef is a callable function (or missingHelper reported)
// ─────────────────────────────────────────────────────────────────────────────
section('7. helperRef is callable (or missingHelper flagged)');

let missingHelpers = 0;
for (const entry of REGISTRY) {
  if (entry.missingHelper === true) {
    warn(`${entry.key}: missingHelper=true (helperFn '${entry.helperFn}' not resolved)`);
    missingHelpers++;
  } else if (typeof entry.helperRef !== 'function') {
    fail(`${entry.key}: helperRef is not a function (got ${typeof entry.helperRef})`);
    missingHelpers++;
  } else {
    pass(`${entry.key}: helperRef is callable (${entry.helperFn})`);
  }
}

if (missingHelpers > 0) {
  warn(`${missingHelpers} helper(s) could not be resolved — runtime use will fail until helpers are implemented`);
} else {
  pass('All helperRefs resolved — no missing helpers');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. requiredParams and optionalParams are arrays
// ─────────────────────────────────────────────────────────────────────────────
section('8. Param arrays valid');

for (const entry of REGISTRY) {
  if (!Array.isArray(entry.requiredParams)) {
    fail(`${entry.key}: requiredParams is not an array`);
  }
  if (!Array.isArray(entry.optionalParams)) {
    fail(`${entry.key}: optionalParams is not an array`);
  }
  // Each requiredParam must have name + description
  for (const p of entry.requiredParams) {
    if (!p || typeof p.name !== 'string' || typeof p.description !== 'string') {
      fail(`${entry.key}: requiredParam missing name or description`);
    }
  }
}
pass(`All param arrays valid (${REGISTRY.length} entries checked)`);

// ─────────────────────────────────────────────────────────────────────────────
// 9. No write-intent entries (belt-and-suspenders on top of readOnly check)
// ─────────────────────────────────────────────────────────────────────────────
section('9. No write-intent entries');

const writeIntentPattern = /\b(write|upsert|insert|update|delete|resolve|create|assign)\b/i;
let writeIntentCount = 0;
for (const entry of REGISTRY) {
  if (writeIntentPattern.test(entry.helperFn)) {
    fail(`${entry.key}: helperFn '${entry.helperFn}' looks like a write operation (readOnly registry must not contain write helpers)`);
    writeIntentCount++;
  }
}
if (writeIntentCount === 0) {
  pass('No write-intent helper functions in registry');
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. getEntry() lookup works for a sample of keys
// ─────────────────────────────────────────────────────────────────────────────
section('10. getEntry() lookup');

const sampleKeys = [
  'payments.waiting',
  'rooming.roster',
  'addons.lessons',
  'handoffs.open',
  'handoffs.needs_human_no_handoff',
  'holds.active',
];
for (const k of sampleKeys) {
  const e = getEntry(k);
  if (!e) {
    fail(`getEntry('${k}') returned undefined`);
  } else if (e.key !== k) {
    fail(`getEntry('${k}') returned wrong entry (key=${e.key})`);
  } else {
    pass(`getEntry('${k}') OK`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

const TOTAL_INTENTS = REGISTRY.length;
const CATEGORIES = [...new Set(REGISTRY.map((e) => e.category))];
const byCategory = Object.fromEntries(
  CATEGORIES.map((c) => [c, REGISTRY.filter((e) => e.category === c).length])
);
const migrationBreakdown = {
  none:            REGISTRY.filter((e) => !e.migrationRequired).length,
  migration_007:   REGISTRY.filter((e) => e.migrationRequired === 'migration_007').length,
  migration_008:   REGISTRY.filter((e) => e.migrationRequired === 'migration_008').length,
};

console.log('\n═══════════════════════════════════════════════════════════');
console.log(`Registry stats:`);
console.log(`  Total intents: ${TOTAL_INTENTS}`);
console.log(`  Planned covered: ${PLANNED_INTENTS.length - missingCount} / ${PLANNED_INTENTS.length}`);
for (const [cat, count] of Object.entries(byCategory)) {
  console.log(`  ${cat.padEnd(10)} ${count} intent(s)`);
}
console.log(`  Migration deps: none=${migrationBreakdown.none}, 007=${migrationBreakdown.migration_007}, 008=${migrationBreakdown.migration_008}`);
if (warnings.length > 0) {
  console.log(`  Warnings: ${warnings.length}`);
  for (const w of warnings) console.warn(`    ⚠ ${w}`);
}
console.log('');

const result = failures === 0 ? 'PASS' : 'FAIL';
console.log(`Result: ${result} — ${passes} passed, ${failures} failed, ${warnings.length} warning(s)`);

if (failures > 0) process.exit(1);
