'use strict';

/** Regression gate: canonical Azure KV composition security cases must run from clean checkout. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const rootNpmrc = path.join(ROOT, '.npmrc');
if (fs.existsSync(rootNpmrc)) {
  console.error('clean-checkout portability failed: root .npmrc imposes repository-wide npm policy');
  process.exit(1);
}

const canonical = path.join(__dirname,
  'verify-email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js');
const required = [
  'prototype-only SDK client seal/open + hostile AZURE/DI ignored',
  'throwing code getter on construction → envelope_kv_failed (no plant)',
  'proxy ownKeys/getOwnPropertyDescriptor/getPrototypeOf traps → sanitized',
  'planted wrap exception sanitized at provider boundary',
];

const child = spawnSync(process.execPath, [canonical], {
  cwd: ROOT,
  env: { ...process.env, NODE_OPTIONS: '' },
  encoding: 'utf8',
  maxBuffer: 4 * 1024 * 1024,
});
const output = `${child.stdout || ''}${child.stderr || ''}`;
process.stdout.write(output);
const missing = required.filter((name) => !output.includes(`PASS  ${name}`));
if (child.status !== 0 || missing.length) {
  console.error(`clean-checkout portability failed: ${missing.join('; ') || `canonical exit ${child.status}`}`);
  process.exit(1);
}
console.log(`clean-checkout portability: ${required.length} legacy security cases passed`);
