'use strict';

/**
 * Multi-client hardcoding guard (v1 — pragmatic).
 *
 * Scans repo text for client-specific literals that should live in
 * config/clients/clients.json and per-client config, not shared runtime code.
 *
 * Allowlisted paths (docs, client config, fixtures, verify scripts, migrations)
 * are skipped. Client-dedicated modules (filename contains client slug) are
 * grandfathered. Shared runtime matches are reported as suspicious hotspots.
 *
 * Strict fail: mirleft / lawave / la_wave outside allowlists (no historical debt).
 * wolfhouse / sunset / elSardi debt is reported but does not fail v1.
 *
 * Exit 0 when strict checks pass; nonzero on new-client hardcoding violations.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const CLIENT_TERMS = [
  { label: 'wolfhouse', re: /\bwolfhouse\b/i },
  { label: 'sunset', re: /\bsunset\b/i },
  { label: 'mirleft', re: /\bmirleft\b/i },
  { label: 'lawave', re: /\blawave\b/i },
  { label: 'elSardi', re: /\belSardi\b/ },
  { label: 'elsardi', re: /\belsardi\b/i },
  { label: 'la_wave', re: /\bla_wave\b/i },
];

/** Paths relative to repo root — entire subtrees skipped. */
const ALLOW_PREFIXES = [
  'docs/',
  'config/',
  'fixtures/',
  'scripts/fixtures/',
  'database/',
  'data/',
  'n8n/',
  'infra/',
  'docker/',
  'hermes-local/',
  '_work/',
  'node_modules/',
  '.git/',
];

/** Shared runtime roots — suspicious wolfhouse/sunset debt is reported here. */
const RUNTIME_PREFIXES = [
  'scripts/lib/',
  'scripts/staff-query-api.js',
  'scripts/browser/',
];

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.sql', '.md', '.html',
  '.yml', '.yaml', '.css', '.sh', '.ps1', '.vue', '.txt', '.xml', '.svg',
]);

const STRICT_TERMS = new Set(['mirleft', 'lawave', 'la_wave']);

function normRel(filePath) {
  return filePath.split(path.sep).join('/');
}

function isAllowedPath(rel) {
  for (const prefix of ALLOW_PREFIXES) {
    if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return true;
  }
  if (/^[^/]+\.md$/i.test(rel)) return true;
  const base = path.basename(rel);
  if (base.startsWith('verify-') && rel.startsWith('scripts/')) return true;
  if (rel === 'package.json') return true;
  if (rel === 'scripts/verify-no-client-hardcoding.js') return true;
  return false;
}

function isRuntimePath(rel) {
  for (const prefix of RUNTIME_PREFIXES) {
    if (rel === prefix || rel.startsWith(prefix)) return true;
  }
  return false;
}

/** Dedicated client modules — historical hardcoding expected. */
function isGrandfatheredModule(rel) {
  const base = path.basename(rel).toLowerCase();
  return (
    base.includes('wolfhouse')
    || base.includes('sunset')
    || base.includes('mirleft')
    || base.includes('lawave')
    || base.includes('elsardi')
  );
}

function shouldScanFile(rel) {
  if (isAllowedPath(rel)) return false;
  const ext = path.extname(rel).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return false;
  return true;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = normRel(path.relative(REPO_ROOT, full));
    if (ent.isDirectory()) {
      if (rel === 'node_modules' || rel === '.git' || rel === '_work') continue;
      walk(full, out);
      continue;
    }
    if (shouldScanFile(rel)) out.push(full);
  }
}

function scanFile(fullPath) {
  const rel = normRel(path.relative(REPO_ROOT, fullPath));
  if (isGrandfatheredModule(rel)) return { grandfathered: true, hits: [] };

  let text;
  try {
    text = fs.readFileSync(fullPath, 'utf8');
  } catch {
    return { grandfathered: false, hits: [] };
  }

  const lines = text.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const term of CLIENT_TERMS) {
      if (term.re.test(line)) {
        hits.push({
          rel,
          line: i + 1,
          term: term.label,
          snippet: line.trim().slice(0, 140),
          strict: STRICT_TERMS.has(term.label),
        });
      }
    }
  }
  return { grandfathered: false, hits };
}

console.log('verify:no-client-hardcoding — shared-runtime literal scan\n');

const files = [];
walk(REPO_ROOT, files);

let grandfatheredFiles = 0;
const suspicious = [];
const strictViolations = [];

for (const file of files) {
  const result = scanFile(file);
  if (result.grandfathered) {
    grandfatheredFiles += 1;
    continue;
  }
  for (const hit of result.hits) {
    if (!isRuntimePath(hit.rel)) {
      if (hit.strict) strictViolations.push(hit);
      continue;
    }
    suspicious.push(hit);
    if (hit.strict) strictViolations.push(hit);
  }
}

if (suspicious.length === 0) {
  console.log('  PASS  no suspicious client literals in shared runtime paths');
} else {
  console.log(`  INFO  ${suspicious.length} suspicious hotspot(s) in shared runtime (historical debt — do not add more):\n`);
  const byFile = new Map();
  for (const h of suspicious) {
    const key = `${h.rel}:${h.line}`;
    if (!byFile.has(key)) byFile.set(key, h);
  }
  const sorted = [...byFile.values()].sort((a, b) => {
    const c = a.rel.localeCompare(b.rel);
    return c !== 0 ? c : a.line - b.line;
  });
  const showMax = 80;
  for (const h of sorted.slice(0, showMax)) {
    console.log(`    ${h.rel}:${h.line}  [${h.term}]  ${h.snippet}`);
  }
  if (sorted.length > showMax) {
    console.log(`    ... and ${sorted.length - showMax} more`);
  }
}

if (strictViolations.length > 0) {
  console.log(`\n  FAIL  ${strictViolations.length} strict violation(s) — mirleft/lawave/la_wave must not appear outside allowlisted paths yet:\n`);
  for (const h of strictViolations) {
    console.log(`    ${h.rel}:${h.line}  [${h.term}]  ${h.snippet}`);
  }
} else {
  console.log('\n  PASS  no mirleft/lawave/la_wave literals outside allowlisted paths');
}

console.log(`\n── no-client-hardcoding: scanned ${files.length} files, grandfathered ${grandfatheredFiles} client modules, ${suspicious.length} hotspot(s), ${strictViolations.length} strict violation(s) ──`);

if (strictViolations.length === 0) {
  console.log('verify:no-client-hardcoding — PASSED (v1: reports wolfhouse/sunset debt, blocks new mirleft/lawave hardcoding)');
}
process.exit(strictViolations.length ? 1 : 0);
