#!/usr/bin/env node
/**
 * Assert two consecutive production builds leave tracked CSP authorization
 * files byte-identical and produce identical dist trees (read-only seal).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const TRACKED = [
  'security/inline-blocks.inventory.json',
  'security/headers.contract.json',
  'public/_headers',
];

function shaFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function snapshotTracked() {
  return Object.fromEntries(TRACKED.map((rel) => [rel, shaFile(join(ROOT, rel))]));
}

function assertTrackedStable(before, after, label) {
  for (const rel of TRACKED) {
    if (before[rel] !== after[rel]) {
      console.error(`assert-build-readonly: ${label} modified ${rel}`);
      process.exit(1);
    }
  }
}

function hashTree(dir) {
  const files = [];
  function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else files.push(abs);
    }
  }
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(dir, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return { hash: h.digest('hex'), count: files.length };
}

function npmBuild() {
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

const start = snapshotTracked();
npmBuild();
const after1 = snapshotTracked();
assertTrackedStable(start, after1, 'build #1');
const first = hashTree(DIST);

npmBuild();
const after2 = snapshotTracked();
assertTrackedStable(start, after2, 'build #2');
const second = hashTree(DIST);

if (first.hash !== second.hash || first.count !== second.count) {
  console.error(
    `assert-build-readonly: dist trees differ (${first.hash} / ${second.hash}, files ${first.count}/${second.count})`,
  );
  process.exit(1);
}

if (!existsSync(join(DIST, '_headers'))) {
  console.error('assert-build-readonly: dist/_headers missing');
  process.exit(1);
}

if (readFileSync(join(ROOT, 'public/_headers'), 'utf8') !== readFileSync(join(DIST, '_headers'), 'utf8')) {
  console.error('assert-build-readonly: dist/_headers !== public/_headers');
  process.exit(1);
}

console.log(
  `assert-build-readonly: PASS (two builds, tracked CSP files unchanged, identical dist ${first.hash.slice(0, 12)}… ${first.count} files)`,
);
