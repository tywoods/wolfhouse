'use strict';

/**
 * Adversarial proofs for n8n retired-callers guard hardening.
 * RED cases must fail; GREEN safety assertions without endpoints/env must pass.
 *
 * Fixture strings are assembled at runtime so this file itself stays free of
 * banned Cloud/webhook/env literals (and is not path-allowlisted by name).
 */

const assert = require('assert');
const {
  isPathAllowlisted,
  scanText,
  isHarmlessSafetyAssertion,
  findDangerousMatches,
  evaluateLine,
  cloudHostLiteral,
} = require('./lib/n8n-retired-callers-guard');

const cloud = cloudHostLiteral();
const cloudUrl = ['https://', cloud, '/webhook/', 'wolfhouse-manual-entries-queue'].join('');
const newRuntimeEnvLine = ['const u = process.env.', ['N8N', 'NEW', 'RUNTIME', 'URL'].join('_'), ';'].join('');
const webhookEnvLine = ['process.env.', ['N8N', 'WEBHOOK', 'URL'].join('_'), "='x'"].join('');

let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${label}`);
    console.error(`        ${err && err.message ? err.message : err}`);
  }
}

console.log('verify-n8n-retired-callers-adversarial');
console.log('\n── RED (must detect) ──');

check('Cloud URL followed by // without n8n', () => {
  const line = `${cloudUrl} // without n8n`;
  const hits = scanText(line);
  assert.ok(hits.some((h) => h.id === 'n8n_cloud_host' || h.id === 'n8n_cloud_webhook'), 'expected cloud violation');
  assert.strictEqual(isHarmlessSafetyAssertion(line), false);
});

check('Cloud URL beside calls_n8n:false', () => {
  const line = `url: '${cloudUrl}', calls_n8n:false`;
  const hits = scanText(line);
  assert.ok(hits.some((h) => h.id === 'n8n_cloud_host' || h.id === 'n8n_cloud_webhook'), 'expected cloud violation');
  assert.ok(findDangerousMatches(line).length > 0);
  assert.strictEqual(isHarmlessSafetyAssertion(line), false);
});

check('assembled process.env N8N_* NEW_RUNTIME_URL', () => {
  const hits = scanText(newRuntimeEnvLine);
  assert.ok(hits.some((h) => h.id === 'n8n_env_runtime'), 'expected N8N_* env violation');
  assert.strictEqual(evaluateLine(newRuntimeEnvLine).some((d) => d.id === 'n8n_env_runtime'), true);
});

check('hypothetical scripts/lib/new-runtime helper with n8n in name is NOT path-exempt', () => {
  const rel = ['scripts', 'lib', ['new', 'n8n', 'runtime'].join('-') + '.js'].join('/');
  assert.strictEqual(isPathAllowlisted(rel), false);
  const hits = scanText(`fetch('${cloudUrl}')`, rel);
  assert.ok(hits.length > 0, 'content in hypothetical new runtime helper must violate');
});

check('hypothetical scripts/build-new helper with n8n in name is NOT path-exempt', () => {
  const rel = ['scripts', ['build', 'new', 'n8n'].join('-') + '.js'].join('/');
  assert.strictEqual(isPathAllowlisted(rel), false);
  const hits = scanText(webhookEnvLine, rel);
  assert.ok(hits.some((h) => h.id === 'n8n_env_runtime'));
});

console.log('\n── GREEN (must allow) ──');

check('harmless no_n8n:true with no endpoint/env', () => {
  const line = 'return { no_n8n: true, ok: true };';
  assert.strictEqual(findDangerousMatches(line).length, 0);
  assert.strictEqual(isHarmlessSafetyAssertion(line), true);
  assert.strictEqual(scanText(line).length, 0);
});

check('harmless calls_n8n:false with no endpoint/env', () => {
  const line = 'meta: { calls_n8n: false },';
  assert.strictEqual(findDangerousMatches(line).length, 0);
  assert.strictEqual(isHarmlessSafetyAssertion(line), true);
  assert.strictEqual(scanText(line).length, 0);
});

check('closed allowlist does not wildcard n8n / build / inventory filenames', () => {
  assert.strictEqual(isPathAllowlisted(['scripts/lib', 'brand-new-helper-n8n-thing.js'].join('/')), false);
  assert.strictEqual(isPathAllowlisted('scripts/lib/main-brand-new-inventory.js'), false);
  assert.strictEqual(isPathAllowlisted('scripts/build-anything.js'), false);
  assert.strictEqual(isPathAllowlisted(['scripts', ['build', 'new', 'n8n'].join('-') + '.js'].join('/')), false);
  assert.strictEqual(isPathAllowlisted(['scripts/lib', ['new', 'n8n', 'runtime'].join('-') + '.js'].join('/')), false);
});

console.log(`\n── adversarial ${failed ? 'FAILED' : 'PASSED'} ──`);
process.exit(failed ? 1 : 0);
