'use strict';

/**
 * Deterministic verifier for the Crowsnest client-metrics event contract (Pupil prep).
 * Pure offline checks — no network, no DB, no storage writes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-client-metrics');
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-client-metrics-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'CLIENT-METRICS-CONTRACT.md');

const {
  SCHEMA_VERSION,
  validateCrowsnestClientMetricsEvent,
} = require(CONTRACT_PATH);

const VALID_FIXTURES = Object.freeze([
  'valid-measured.json',
  'valid-metrics-unavailable.json',
  'valid-last-activity-null.json',
]);

/** Each invalid fixture must fail with (at least) this characteristic error, not merely any rejection. */
const INVALID_FIXTURE_SPECS = Object.freeze({
  'invalid-missing-tenant-id.json': 'tenant_id: required_non_empty_string',
  'invalid-unknown-top-level.json': 'region: unknown_field',
  'invalid-sensitive-key.json': 'metrics.phone: sensitive_key_forbidden',
  'invalid-unavailable-with-numbers.json': 'metrics.conversations_total: unknown_field',
  'invalid-negative-count.json': 'metrics.conversations_needing_human: must_be_non_negative_integer',
  'invalid-captured-at.json': 'captured_at: invalid_timestamp',
});

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

console.log('verify:crowsnest-client-metrics-contract — Pupil prep gate\n');

ok('contract module exists', fs.existsSync(CONTRACT_PATH));
ok('contract doc exists', fs.existsSync(DOC_PATH));
ok('schema version is crowsnest.client_metrics.v1', SCHEMA_VERSION === 'crowsnest.client_metrics.v1');
ok('validate export is a function', typeof validateCrowsnestClientMetricsEvent === 'function');

// Non-object / empty rejected.
ok('null event rejected', validateCrowsnestClientMetricsEvent(null).ok === false);
ok('array event rejected', validateCrowsnestClientMetricsEvent([]).ok === false);
ok('empty object rejected', validateCrowsnestClientMetricsEvent({}).ok === false);

// Valid fixtures accept.
for (const file of VALID_FIXTURES) {
  const res = validateCrowsnestClientMetricsEvent(readJson(file));
  ok(`valid fixture accepted: ${file}`, res.ok === true && res.errors.length === 0);
}

// Invalid fixtures reject with the expected characteristic error.
for (const [file, expected] of Object.entries(INVALID_FIXTURE_SPECS)) {
  const res = validateCrowsnestClientMetricsEvent(readJson(file));
  ok(`invalid fixture rejected: ${file}`, res.ok === false);
  ok(`invalid fixture surfaces "${expected}"`, res.errors.includes(expected));
}

// Every fixture in the dir is covered by a spec (no orphan fixtures).
const onDisk = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort();
const covered = [...VALID_FIXTURES, ...Object.keys(INVALID_FIXTURE_SPECS)].sort();
ok('every fixture is covered by the verifier', JSON.stringify(onDisk) === JSON.stringify(covered));

console.log(`\n── verify:crowsnest-client-metrics-contract: ${pass} passed, ${fail} failed ──`);
if (fail > 0) {
  console.error('verify:crowsnest-client-metrics-contract — FAILURES');
  process.exit(1);
}
console.log('verify:crowsnest-client-metrics-contract — ALL CHECKS PASSED');
