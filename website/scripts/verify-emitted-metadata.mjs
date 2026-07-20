#!/usr/bin/env node
/**
 * Deterministic post-build check: local OG / Apple / logo assets must exist in
 * dist/ at the expected sizes, and index.html must reference local paths.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`PASS  ${msg}`);
}

function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html missing — run npm run build first');
  process.exit(1);
}

const checks = [
  ['og/luna-front-desk-og.png', 1200, 630],
  ['apple-touch-icon.png', 180, 180],
  ['luna-front-desk-logo.png', 707, 353],
];

for (const [rel, w, h] of checks) {
  const abs = join(DIST, rel);
  if (!existsSync(abs)) {
    fail(`missing ${rel}`);
    continue;
  }
  try {
    const size = pngSize(readFileSync(abs));
    if (size.width !== w || size.height !== h) {
      fail(`${rel} size ${size.width}x${size.height}, expected ${w}x${h}`);
    } else {
      ok(`${rel} ${w}x${h}`);
    }
  } catch (e) {
    fail(`${rel}: ${e.message}`);
  }
}

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!/property="og:image"\s+content="[^"]*\/og\/luna-front-desk-og\.png"/.test(html)) {
  fail('index.html missing local og:image href');
} else {
  ok('index.html og:image → /og/luna-front-desk-og.png');
}
if (!html.includes('rel="apple-touch-icon"') || !html.includes('href="/apple-touch-icon.png"')) {
  fail('index.html missing apple-touch-icon link');
} else {
  ok('index.html apple-touch-icon → /apple-touch-icon.png');
}

if (process.exitCode) {
  console.error('verify-emitted-metadata: FAILED');
  process.exit(1);
}
console.log('verify-emitted-metadata: PASS');
