'use strict';

/**
 * Phase 3A guard: retired n8n callers must not return in executable/runtime code.
 *
 * Fails on:
 *   - tywoods.app.n8n.cloud
 *   - active n8n webhook URL shapes (Cloud or local webhook bases)
 *   - new N8N_* runtime env dependencies in scanned runtime surfaces
 *
 * Allowlisted (do not fail):
 *   - historical docs / evidence markdown
 *   - migration / inventory / local-build helpers
 *   - local smoke .ps1 under scripts/
 *   - lines that are explicit no_n8n / calls_n8n:false safety assertions
 *   - this verifier itself
 *   - infra/ (operator-owned local stack residual; not cleaned in 3A)
 *   - package.json (left untouched in 3A)
 *
 * Exit 0 on pass; nonzero on violations.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const SCAN_ROOTS = [
  'apps-script',
  'scripts',
  'docker/hermes-staging',
];

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'tmp',
  'fixtures',
  'Screenshots',
]);

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.gs', '.html', '.json', '.md', '.yml', '.yaml',
]);

/** Relative path prefixes/files that are migration evidence or local-dev residue. */
const ALLOW_PATH_PREFIXES = [
  'docs/',
  'infra/',
  'n8n/',
  'database/',
  'fixtures/',
  'test-payloads/',
  'hermes-local/',
  'scripts/verify-n8n-retired-callers.js',
  'scripts/lib/stripe-contract-inventory.js',
  'scripts/lib/open-demo-playground-common.js',
  'scripts/lib/main-rooming-contract-inventory.js',
  'scripts/lib/main-payment-contract-inventory.js',
  'scripts/lib/main-reassign-endpoint.js',
  'scripts/lib/main-workflow-inventory.js',
  'scripts/lib/main-rooming-contract-inventory.js',
  'scripts/lib/bed-ops-local-build.js',
  'scripts/lib/booking-state-resolver.js',
  'scripts/lib/manual-entry-pg-n8n-sql.js',
  'scripts/lib/operator-room-release-pg-n8n-sql.js',
  'scripts/lib/merged-payment-path.js',
  'scripts/lib/assign-booking-beds-pg-sql.js',
  'scripts/lib/meta-open-demo-inbound-adapter.js',
  'scripts/lib/main-conversation-inventory.js',
];

const ALLOW_PATH_REGEXES = [
  /^scripts\/verify-.*\.js$/i,
  /^scripts\/test-.*\.ps1$/i,
  /^scripts\/build-.*\.js$/i,
  /^scripts\/lib\/.*n8n.*\.js$/i,
  /^scripts\/lib\/main-.*inventory.*\.js$/i,
  /^scripts\/lib\/main-.*-pg-sql\.js$/i,
  /^scripts\/lib\/.*-pg-n8n-sql\.js$/i,
  /^scripts\/workflow-meta\.json$/i,
];

const BAN_PATTERNS = [
  {
    id: 'n8n_cloud_host',
    re: /tywoods\.app\.n8n\.cloud/i,
    label: 'tywoods.app.n8n.cloud',
  },
  {
    id: 'n8n_cloud_webhook',
    re: /https?:\/\/[^\s"'`]*n8n\.cloud[^\s"'`]*\/webhook\//i,
    label: 'n8n Cloud webhook URL',
  },
  {
    id: 'n8n_local_webhook',
    re: /https?:\/\/(?:localhost|127\.0\.0\.1|n8n-main)(?::\d+)?\/webhook\//i,
    label: 'local/compose n8n webhook URL',
  },
  {
    id: 'n8n_env_runtime',
    re: /(?:process\.env\.|\$env:|\$\{)N8N_[A-Z0-9_]+|\bN8N_[A-Z0-9_]+\s*=/,
    label: 'N8N_* runtime dependency',
  },
];

/** Lines that are safety assertions / guest-facing forbids — keep. */
const LINE_ALLOW_REGEXES = [
  /\bno_n8n\b/i,
  /\bcalls_n8n\b\s*[:=]\s*false/i,
  /\bn8n_called\b\s*[:=]\s*false/i,
  /\bforbidden_terms\b/i,
  /never\s+(?:say|mention)\s+n8n/i,
  /never\s+mention:[^\n]*\bn8n\b/i,
  /must\s+not\s+(?:mention|import|call)\s+n8n/i,
  /does\s+not\s+call\s+n8n/i,
  /without\s+n8n/i,
  /ported[^\n]*no\s+n8n/i,
];

function normRel(p) {
  return p.split(path.sep).join('/');
}

function isPathAllowlisted(rel) {
  if (rel === 'package.json') return true;
  for (const prefix of ALLOW_PATH_PREFIXES) {
    if (rel === prefix || rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix)) return true;
  }
  for (const re of ALLOW_PATH_REGEXES) {
    if (re.test(rel)) return true;
  }
  return false;
}

function isLineAllowlisted(line) {
  for (const re of LINE_ALLOW_REGEXES) {
    if (re.test(line)) return true;
  }
  return false;
}

function shouldScanFile(rel) {
  if (isPathAllowlisted(rel)) return false;
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXT.has(ext) && !rel.endsWith('.ps1')) return false;
  return true;
}

function walk(absDir, out) {
  if (!fs.existsSync(absDir)) return;
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = normRel(path.relative(ROOT, abs));
    if (ent.isDirectory()) {
      if (isPathAllowlisted(rel + '/')) continue;
      walk(abs, out);
      continue;
    }
    if (shouldScanFile(rel)) out.push(rel);
  }
}

function scanFile(rel) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isLineAllowlisted(line)) continue;
    for (const ban of BAN_PATTERNS) {
      if (ban.re.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          id: ban.id,
          label: ban.label,
          excerpt: line.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

function main() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(ROOT, root), files);
  }

  // Explicit: retired Apps Script tree must stay gone (or empty of callers).
  const appsScriptDir = path.join(ROOT, 'apps-script');
  if (fs.existsSync(appsScriptDir)) {
    const leftover = fs.readdirSync(appsScriptDir).filter((n) => !n.startsWith('.'));
    for (const name of leftover) {
      const rel = normRel(path.join('apps-script', name));
      if (shouldScanFile(rel) || TEXT_EXT.has(path.extname(name).toLowerCase()) || name.endsWith('.gs')) {
        files.push(rel);
      }
    }
  }

  const violations = [];
  for (const rel of files.sort()) {
    violations.push(...scanFile(rel));
  }

  // Hard assert: Cloud host must not appear outside allowlisted paths in whole scan set.
  const cloudInScan = violations.filter((v) => v.id === 'n8n_cloud_host' || v.id === 'n8n_cloud_webhook');

  if (violations.length) {
    console.error('verify-n8n-retired-callers FAILED');
    console.error(`Scanned ${files.length} files; ${violations.length} violation(s):\n`);
    for (const v of violations.slice(0, 50)) {
      console.error(`  ${v.file}:${v.line} [${v.id}] ${v.label}`);
      console.error(`    ${v.excerpt}`);
    }
    if (violations.length > 50) console.error(`  … ${violations.length - 50} more`);
    process.exit(1);
  }

  console.log('verify-n8n-retired-callers OK');
  console.log(`  scanned_files=${files.length}`);
  console.log('  cloud_host_in_runtime=0');
  console.log(`  allowlist=docs+migration helpers+verify/safety lines+infra residual`);
  if (cloudInScan.length !== 0) {
    // unreachable if violations empty, but keep invariant obvious
    process.exit(1);
  }
  process.exit(0);
}

main();
