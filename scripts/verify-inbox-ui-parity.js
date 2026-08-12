'use strict';

/**
 * verify:inbox-ui-parity
 *
 * Byte-parity gate for the Inbox front-end extraction (Inbox Phase 0).
 *
 * The Inbox UI is generated inline by buildUiHtml() in scripts/staff-query-api.js.
 * Phase 0 moves that code into scripts/browser/inbox-*.js modules that are injected
 * back at INJECT markers, which must produce byte-identical HTML. This gate captures
 * a baseline before extraction and asserts every later step still matches it.
 *
 * Each tenant is built in a child process: staff-query-api.js reads env at require
 * time, so building two tenants in one process would reuse the first tenant's
 * module-level config.
 *
 * Run:
 *   node scripts/verify-inbox-ui-parity.js --save   # capture baseline (before extraction)
 *   node scripts/verify-inbox-ui-parity.js          # assert current output matches baseline
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-ui-parity');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');

/** sunset exercises the surf-vertical branch; wolfhouse-somo the lodging default. */
const TENANTS = ['sunset', 'wolfhouse-somo'];

const CONTEXT_CHARS = 220;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

/** Child mode: build one tenant's HTML through the production seam and write it. */
function runEmit(client, dest) {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.DEFAULT_CLIENT_SLUG = client;
  const api = require(path.join(ROOT, 'scripts', 'staff-query-api.js'));
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    console.error('Production staff UI builder seam is unavailable');
    process.exit(2);
  }
  fs.writeFileSync(dest, api.buildUiHtmlForOfflineTest(0, client), 'utf8');
}

function buildTenant(client, dest) {
  const r = spawnSync(process.execPath, [__filename, '--emit', client, dest], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`build failed for ${client}: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return fs.readFileSync(dest, 'utf8');
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : n;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function window(text, index) {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + CONTEXT_CHARS);
  return text.slice(start, end);
}

/** Any marker left in the output means an injector did not run. */
function unconsumedMarkers(html) {
  const found = [];
  const re = /\/\* INJECT:[a-z0-9-]+ \*\//g;
  let m = re.exec(html);
  while (m) {
    if (found.indexOf(m[0]) < 0) found.push(m[0]);
    m = re.exec(html);
  }
  return found;
}

function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : 'unknown';
}

function save() {
  ensureOutDir();
  const entries = {};
  for (const client of TENANTS) {
    const dest = path.join(OUT_DIR, `baseline-${client}.html`);
    const html = buildTenant(client, dest);
    const markers = unconsumedMarkers(html);
    entries[client] = { sha256: sha256(html), length: html.length, unconsumed_markers: markers };
    console.log(`  saved  ${client}  ${html.length} bytes  ${entries[client].sha256.slice(0, 16)}`);
    if (markers.length) {
      console.log(`         note: ${markers.length} unconsumed marker(s): ${markers.join(', ')}`);
    }
  }
  fs.writeFileSync(
    MANIFEST,
    `${JSON.stringify({ captured_at: new Date().toISOString(), git_head: gitHead(), tenants: entries }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nBaseline written to ${path.relative(ROOT, MANIFEST)}`);
  console.log('Re-run without --save after each extraction step to assert byte parity.');
  return 0;
}

function compare() {
  if (!fs.existsSync(MANIFEST)) {
    console.error('No baseline found. Run with --save first (before any extraction).');
    return 2;
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  ensureOutDir();

  let failures = 0;
  console.log(`\nverify:inbox-ui-parity  (baseline from ${manifest.git_head.slice(0, 12)})\n`);

  for (const client of TENANTS) {
    const expected = manifest.tenants[client];
    if (!expected) {
      console.error(`  FAIL  ${client} — no baseline entry`);
      failures += 1;
      continue;
    }
    const dest = path.join(OUT_DIR, `current-${client}.html`);
    const html = buildTenant(client, dest);
    const actualSha = sha256(html);

    if (actualSha === expected.sha256) {
      console.log(`  PASS  ${client}  byte-identical  ${html.length} bytes`);
    } else {
      failures += 1;
      console.error(`  FAIL  ${client}  output changed`);
      console.error(`        expected sha ${expected.sha256.slice(0, 16)} / ${expected.length} bytes`);
      console.error(`        actual   sha ${actualSha.slice(0, 16)} / ${html.length} bytes  (delta ${html.length - expected.length})`);

      const baselinePath = path.join(OUT_DIR, `baseline-${client}.html`);
      if (fs.existsSync(baselinePath)) {
        const before = fs.readFileSync(baselinePath, 'utf8');
        const idx = firstDifference(before, html);
        if (idx >= 0) {
          console.error(`        first difference at offset ${idx} (baseline line ${lineNumberAt(before, idx)})`);
          console.error(`        --- baseline ---\n${window(before, idx)}`);
          console.error(`        --- current ----\n${window(html, idx)}`);
        }
      }
    }

    const markers = unconsumedMarkers(html);
    const expectedMarkers = expected.unconsumed_markers || [];
    const leaked = markers.filter((m) => expectedMarkers.indexOf(m) < 0);
    if (leaked.length) {
      failures += 1;
      console.error(`  FAIL  ${client} — unconsumed inject marker(s): ${leaked.join(', ')}`);
    }
  }

  console.log('');
  if (failures) {
    console.error(`verify:inbox-ui-parity FAILED (${failures})`);
    console.error('The extraction changed rendered output. Diff the files in tmp/inbox-ui-parity/.');
    return 1;
  }
  console.log('verify:inbox-ui-parity PASSED — rendered UI is byte-identical to baseline');
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--emit') {
    runEmit(args[1], args[2]);
    return 0;
  }
  if (args.indexOf('--save') >= 0) return save();
  return compare();
}

process.exit(main());
