'use strict';

/**
 * verify:sunset-golden
 *
 * Offline structure validator for fixtures/sunset-golden/ fixtures.
 * Loads the manifest, reads each listed fixture, and asserts basic shape.
 *
 * Does NOT call LLMs, Staff API, DB, Stripe, WhatsApp, network, or env.
 *
 * Run:
 *   node scripts/verify-sunset-golden.js
 *   npm run verify:sunset-golden
 */

const fs   = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'sunset-golden');
const MANIFEST_PATH = path.join(FIXTURES_DIR, '_manifest.json');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function loadJson(filePath, label) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 1. Manifest ──────────────────────────────────────────────────────────────

console.log('\n[1] Manifest');

assert('manifest file exists', fs.existsSync(MANIFEST_PATH), MANIFEST_PATH);

const manifestResult = loadJson(MANIFEST_PATH);
assert('manifest is valid JSON', manifestResult.ok, manifestResult.error);

if (!manifestResult.ok) {
  console.error('\nCannot continue — manifest is not valid JSON.');
  process.exit(1);
}

const manifest = manifestResult.data;

assert('manifest has _schema field', typeof manifest._schema === 'string');
assert('manifest has tenant_id=sunset', manifest.tenant_id === 'sunset');
assert('manifest has fixtures array', Array.isArray(manifest.fixtures) && manifest.fixtures.length > 0);

const fixtureNames = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
console.log(`        ${fixtureNames.length} fixture(s) listed in manifest`);

// ── 2. Path containment ──────────────────────────────────────────────────────

console.log('\n[2] Path containment (no traversal outside fixtures/sunset-golden/)');

const escapedPaths = [];
for (const name of fixtureNames) {
  const resolved = path.resolve(FIXTURES_DIR, name);
  const contained = resolved.startsWith(path.resolve(FIXTURES_DIR) + path.sep) ||
                    resolved === path.resolve(FIXTURES_DIR);
  if (!contained) {
    escapedPaths.push(name);
  }
}
assert(
  'all fixture paths stay inside fixtures/sunset-golden/',
  escapedPaths.length === 0,
  escapedPaths.length > 0 ? `escaping paths: ${escapedPaths.join(', ')}` : undefined,
);

// ── 3. Per-fixture validation ────────────────────────────────────────────────

console.log('\n[3] Per-fixture validation');

let fixturePass = 0;
let fixtureFail = 0;

for (const name of fixtureNames) {
  const filePath = path.join(FIXTURES_DIR, name);
  console.log(`\n  fixture: ${name}`);

  // File exists
  const exists = fs.existsSync(filePath);
  assert(`  ${name} — file exists`, exists, filePath);
  if (!exists) { fixtureFail++; continue; }

  // Valid JSON
  const parsed = loadJson(filePath);
  assert(`  ${name} — valid JSON`, parsed.ok, parsed.error);
  if (!parsed.ok) { fixtureFail++; continue; }

  const f = parsed.data;

  // id or name
  const hasId = typeof f.id === 'string' && f.id.trim().length > 0;
  const hasName = typeof f.name === 'string' && f.name.trim().length > 0;
  assert(`  ${name} — has id or name`, hasId || hasName,
    `id=${JSON.stringify(f.id)} name=${JSON.stringify(f.name)}`);

  // channel or mode
  const hasChannel = typeof f.channel === 'string' && f.channel.trim().length > 0;
  const hasMode    = typeof f.mode === 'string' && f.mode.trim().length > 0;
  assert(`  ${name} — has channel or mode`, hasChannel || hasMode,
    `channel=${JSON.stringify(f.channel)}`);

  // guest input: turns[].message or top-level input/messages field
  const hasTurns = Array.isArray(f.turns) && f.turns.length > 0 &&
                   f.turns.every((t) => typeof t.message === 'string');
  const hasInput = typeof f.input === 'string' || Array.isArray(f.messages);
  assert(`  ${name} — has guest input (turns[].message or input/messages)`,
    hasTurns || hasInput,
    'no turns[].message, input, or messages field found');

  // expected/guardrails: turns[].expect.behavior or top-level expected/guardrails
  const hasExpectInTurns = Array.isArray(f.turns) && f.turns.length > 0 &&
    f.turns.some((t) => t.expect && (t.expect.behavior || t.expect.reply_not_contains));
  const hasFinalExpect  = f.final_expect && typeof f.final_expect === 'object';
  const hasExpectedTop  = f.expected || f.guardrails;
  assert(`  ${name} — has expected/guardrails field`,
    hasExpectInTurns || hasFinalExpect || hasExpectedTop,
    'no turns[].expect, final_expect, expected, or guardrails found');

  // tenant scoping — if tenant_id or client_slug present, must be sunset
  if (f.tenant_id !== undefined) {
    assert(`  ${name} — tenant_id=sunset`, f.tenant_id === 'sunset',
      `got tenant_id=${JSON.stringify(f.tenant_id)}`);
  }
  if (f.client_slug !== undefined) {
    assert(`  ${name} — client_slug=sunset`, f.client_slug === 'sunset',
      `got client_slug=${JSON.stringify(f.client_slug)}`);
  }

  fixturePass++;
}

// ── 4. Count summary ─────────────────────────────────────────────────────────

console.log('\n[4] Fixture count');
assert(
  `all ${fixtureNames.length} listed fixture(s) loaded and parsed`,
  fixtureFail === 0,
  fixtureFail > 0 ? `${fixtureFail} fixture(s) failed to load` : undefined,
);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`verify:sunset-golden`);
console.log(`  fixtures checked: ${fixtureNames.length}`);
console.log(`  assertions:  pass=${pass}  fail=${fail}`);

if (fail > 0) {
  process.exit(1);
}
