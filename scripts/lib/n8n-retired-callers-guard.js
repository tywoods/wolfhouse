'use strict';

/**
 * Shared scan logic for Phase 3A n8n retired-callers guard.
 *
 * Dangerous runtime patterns are never suppressed by safety-assertion text.
 * Path allowlist is a closed exact set (no filename wildcards).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const SCAN_ROOTS = ['apps-script', 'scripts', 'docker/hermes-staging'];

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

/**
 * Closed exact paths for historical migration / local smoke residue still
 * containing banned literals. New files must never match via wildcard.
 */
const ALLOWED_HISTORICAL_PATHS = new Set([
  // prefixes (directory roots not scanned as runtime callers)
  'docs/',
  'infra/',
  'n8n/',
  'database/',
  'fixtures/',
  'test-payloads/',
  'hermes-local/',

  // this guard + repo verifier (pattern definitions / orchestration)
  // Guard module only (verifier entrypoint has no banned literals).
  'scripts/lib/n8n-retired-callers-guard.js',

  // known historical migration helpers (exact)
  'scripts/lib/stripe-contract-inventory.js',
  'scripts/lib/open-demo-playground-common.js',
  'scripts/lib/main-rooming-contract-inventory.js',
  'scripts/lib/main-payment-contract-inventory.js',
  'scripts/lib/main-reassign-endpoint.js',
  'scripts/lib/main-workflow-inventory.js',
  'scripts/lib/bed-ops-local-build.js',
  'scripts/lib/booking-state-resolver.js',
  'scripts/lib/manual-entry-pg-n8n-sql.js',
  'scripts/lib/operator-room-release-pg-n8n-sql.js',
  'scripts/lib/merged-payment-path.js',
  'scripts/lib/assign-booking-beds-pg-sql.js',
  'scripts/lib/meta-open-demo-inbound-adapter.js',
  'scripts/lib/main-conversation-inventory.js',
  'scripts/workflow-meta.json',

  // known local webhook smoke scripts (exact)
  'scripts/test-phase2c-stripe-branch.ps1',
  'scripts/test-phase2d-send-confirmation.ps1',
  'scripts/test-stripe-deposit.ps1',
  'scripts/test-assign-beds-webhook.ps1',
  'scripts/test-cancel-beds-webhook.ps1',
  'scripts/test-reassign-beds-webhook.ps1',
  'scripts/test-phase2f-routing.ps1',
]);

/** Build ban regexes without storing the contiguous Cloud host literal in-source. */
function buildBanPatterns() {
  const cloudHost = ['tywoods', 'app', 'n8n', 'cloud'].join('.');
  return [
    {
      id: 'n8n_cloud_host',
      re: new RegExp(cloudHost.replace(/\./g, '\\.'), 'i'),
      label: cloudHost,
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
}

const BAN_PATTERNS = buildBanPatterns();

/** Harmless assertion markers (only consulted when no dangerous pattern matches). */
const HARMLESS_SAFETY_LINE_REGEXES = [
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
  return String(p).split(path.sep).join('/');
}

function isPathAllowlisted(relRaw) {
  const rel = normRel(relRaw);
  if (rel === 'package.json') return true;
  if (ALLOWED_HISTORICAL_PATHS.has(rel)) return true;
  for (const entry of ALLOWED_HISTORICAL_PATHS) {
    if (entry.endsWith('/') && (rel === entry.slice(0, -1) || rel.startsWith(entry))) {
      return true;
    }
  }
  return false;
}

function findDangerousMatches(line) {
  const hits = [];
  for (const ban of BAN_PATTERNS) {
    if (ban.re.test(line)) {
      hits.push({ id: ban.id, label: ban.label });
    }
  }
  return hits;
}

function isHarmlessSafetyAssertion(line) {
  // Never treat a line with a dangerous runtime pattern as "harmless".
  if (findDangerousMatches(line).length) return false;
  return HARMLESS_SAFETY_LINE_REGEXES.some((re) => re.test(line));
}

/**
 * Evaluate one line. Dangerous patterns always win over safety text.
 * Returns violation descriptors (may be empty).
 */
function evaluateLine(line) {
  const dangers = findDangerousMatches(line);
  if (dangers.length) return dangers;
  // Harmless assertions are allowed; they produce no violations.
  if (isHarmlessSafetyAssertion(line)) return [];
  return [];
}

function scanText(text, fileLabel = '(memory)') {
  const hits = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const dangers = evaluateLine(lines[i]);
    for (const d of dangers) {
      hits.push({
        file: fileLabel,
        line: i + 1,
        id: d.id,
        label: d.label,
        excerpt: lines[i].trim().slice(0, 160),
      });
    }
  }
  return hits;
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
      if (isPathAllowlisted(`${rel}/`)) continue;
      walk(abs, out);
      continue;
    }
    if (shouldScanFile(rel)) out.push(rel);
  }
}

function collectScanFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    walk(path.join(ROOT, root), files);
  }
  const appsScriptDir = path.join(ROOT, 'apps-script');
  if (fs.existsSync(appsScriptDir)) {
    const leftover = fs.readdirSync(appsScriptDir).filter((n) => !n.startsWith('.'));
    for (const name of leftover) {
      const rel = normRel(path.join('apps-script', name));
      if (shouldScanFile(rel) || TEXT_EXT.has(path.extname(name).toLowerCase()) || name.endsWith('.gs')) {
        if (!files.includes(rel)) files.push(rel);
      }
    }
  }
  return files.sort();
}

function scanFile(rel) {
  const abs = path.join(ROOT, rel);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  return scanText(text, rel);
}

function collectViolations() {
  const files = collectScanFiles();
  const violations = [];
  for (const rel of files) {
    violations.push(...scanFile(rel));
  }
  return { files, violations };
}

module.exports = {
  ROOT,
  SCAN_ROOTS,
  ALLOWED_HISTORICAL_PATHS,
  BAN_PATTERNS,
  HARMLESS_SAFETY_LINE_REGEXES,
  isPathAllowlisted,
  findDangerousMatches,
  isHarmlessSafetyAssertion,
  evaluateLine,
  scanText,
  shouldScanFile,
  collectScanFiles,
  scanFile,
  collectViolations,
  cloudHostLiteral: () => ['tywoods', 'app', 'n8n', 'cloud'].join('.'),
};
