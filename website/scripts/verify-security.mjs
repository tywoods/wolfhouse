#!/usr/bin/env node
/**
 * Built-output + contract gates for Slice C security hardening.
 * Requires `npm run build` (astro + seal-dist-security) first.
 * Never rewrites tracked inventory/contract/_headers.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLocalAssetOrigins } from './lib/local-asset-scan.mjs';
import {
  CONTRACT_REL,
  HEADERS_REL,
  INVENTORY_REL,
  parseCspFromHeaders,
  verifyContractHeadersInventoryEquivalence,
  verifyDistAgainstInventory,
} from './lib/inline-csp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

let failed = false;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failed = true;
}
function ok(msg) {
  console.log(`PASS  ${msg}`);
}

function listHtml(dir) {
  const out = [];
  function walk(d) {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (name.endsWith('.html')) out.push(abs);
    }
  }
  walk(dir);
  return out.sort();
}

// --- Presence ----------------------------------------------------------------
for (const rel of [INVENTORY_REL, CONTRACT_REL, HEADERS_REL]) {
  if (!existsSync(join(ROOT, rel))) {
    fail(`${rel} missing`);
    process.exit(1);
  }
}
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html missing — run npm run build first');
  process.exit(1);
}
ok('inventory + contract + _headers present');

const contract = JSON.parse(readFileSync(join(ROOT, CONTRACT_REL), 'utf8'));
const headersText = readFileSync(join(ROOT, HEADERS_REL), 'utf8');
const inventory = JSON.parse(readFileSync(join(ROOT, INVENTORY_REL), 'utf8'));
const csp = parseCspFromHeaders(headersText);

if (!csp) fail('_headers missing Content-Security-Policy');
else ok('CSP present in public/_headers');

if (!inventory.reviewed || !Array.isArray(inventory.blocks) || inventory.blocks.length === 0) {
  fail('inline-blocks inventory must be reviewed with blocks');
} else {
  ok(`inline-blocks inventory reviewed (${inventory.blocks.length} block(s))`);
}

// Forbidden tokens
const cspDirectives = contract.headers?.['Content-Security-Policy']?.directives || {};
const directiveBlob = Object.values(cspDirectives).flat().join(' ');
if (/unsafe-eval/i.test(csp || '') || /unsafe-eval/i.test(directiveBlob)) {
  fail("CSP must not include 'unsafe-eval'");
} else {
  ok("no 'unsafe-eval'");
}
if (/script-src[^;]*'unsafe-inline'/.test(csp || '') || /style-src[^;]*'unsafe-inline'/.test(csp || '')) {
  fail("CSP must not use 'unsafe-inline' keywords (use sha256 hashes)");
} else {
  ok("no 'unsafe-inline' keywords in CSP");
}

// Required header values
const required = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'],
  ['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
  ['X-Frame-Options', 'DENY'],
];
for (const [name, value] of required) {
  const re = new RegExp(`${name}:\\s*${value.replace(/[()*]/g, '\\$&')}`, 'i');
  if (!re.test(headersText)) fail(`_headers missing ${name}: ${value}`);
  else ok(`${name}`);
}

if (!/HSTS caveat/i.test(headersText) || !contract.headers['Strict-Transport-Security']?.previewCaveat) {
  fail('HSTS preview/HTTPS caveats not documented');
} else {
  ok('HSTS caveats documented');
}

const directiveNeedles = [
  "default-src 'self'",
  'script-src',
  'style-src',
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];
for (const d of directiveNeedles) {
  if (!(csp || '').includes(d)) fail(`CSP missing directive fragment: ${d}`);
}
if (!failed) ok('CSP core directives present');

// Bidirectional canonical equivalence + exact inventory hashes
const equiv = verifyContractHeadersInventoryEquivalence(ROOT);
if (!equiv.ok) {
  for (const e of equiv.errors) fail(e);
} else {
  ok('contract ↔ _headers ↔ inventory bidirectionally canonical-equivalent');
}

// Dist must match inventory exactly (unknown/missing/duplicate/moved refused)
const match = verifyDistAgainstInventory(ROOT);
if (!match.ok) {
  for (const e of match.errors) fail(e);
} else {
  ok(`dist inline blocks match inventory (${match.found.length})`);
}

// Dist _headers must be exact copy of committed public/_headers
const distHeaders = join(DIST, '_headers');
if (!existsSync(distHeaders)) fail('dist/_headers missing');
else if (readFileSync(distHeaders, 'utf8') !== headersText) {
  fail('dist/_headers must be an exact copy of committed public/_headers');
} else {
  ok('dist/_headers exact copy of committed public/_headers');
}

// sync-csp-hashes must refuse to rewrite (dist-as-authorization removed)
{
  const stub = readFileSync(join(ROOT, 'scripts/sync-csp-hashes.mjs'), 'utf8');
  if (/writeFileSync/.test(stub)) fail('sync-csp-hashes must not write tracked files');
  else ok('sync-csp-hashes does not write tracked files');
}

// report helper must not be wired into build
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (/\breport:inline\b/.test(pkg.scripts?.build || '')) {
    fail('report:inline must never be part of npm run build');
  } else if (!/seal-dist-security/.test(pkg.scripts?.build || '')) {
    fail('npm run build must seal via seal-dist-security');
  } else if (/sync-csp-hashes/.test(pkg.scripts?.build || '')) {
    fail('npm run build must not call sync-csp-hashes');
  } else {
    ok('build is verify+copy only (no auto-approve)');
  }
}

// --- Source scanner ----------------------------------------------------------
const scan = scanLocalAssetOrigins(ROOT);
if (scan.files.length < 5) fail(`source scan found too few files: ${scan.files.length}`);
else ok(`source scan enumerated ${scan.files.length} CSS/Astro/HTML files`);
if (scan.errors.length) {
  for (const e of scan.errors) fail(`source scan: ${e}`);
} else {
  ok('source scan: all stylesheet/@import/@font-face URLs local');
}

const layout = readFileSync(join(ROOT, 'src/layouts/Layout.astro'), 'utf8');
if (/<script is:inline>/.test(layout)) {
  fail('Layout.astro still has inline script bodies — use /js/*.js');
} else if (!layout.includes('/js/js-class.js') || !layout.includes('/js/reveal.js')) {
  fail('Layout.astro must load /js/js-class.js and /js/reveal.js');
} else {
  ok('Layout scripts externalized');
}

// --- Dist: external origins / links / assets ---------------------------------
const ABS_EXT = /(?:https?:)?\/\/[^\s"'`)\]]+/gi;
const ALLOWED_HOST_FRAGMENTS = [
  'lunafrontdesk.com',
];

const htmlFiles = listHtml(DIST);
for (const file of htmlFiles) {
  const rel = relative(DIST, file);
  const html = readFileSync(file, 'utf8');

  if (/<script\b[^>]*\bsrc\s*=\s*['"](?:https?:)?\/\//i.test(html)) {
    fail(`${rel}: remote script src`);
  }
  if (/<link\b[^>]*stylesheet[^>]*href\s*=\s*['"](?:https?:)?\/\//i.test(html)) {
    fail(`${rel}: remote stylesheet`);
  }
  if (/(?:fonts\.googleapis|fonts\.gstatic|fonts\.google)/i.test(html)) {
    fail(`${rel}: Google Fonts reference in built HTML`);
  }

  const badAsset = html.match(
    /(?:src|href)=['"](?:https?:)?\/\/[^'"]+\.(?:js|css|woff2?|ttf|otf)['"]/gi,
  );
  if (badAsset?.length) fail(`${rel}: remote asset ref(s): ${badAsset.join(', ')}`);

  const urls = html.match(ABS_EXT) || [];
  for (const u of urls) {
    if (/^\/\/www\.w3\.org/i.test(u)) continue;
    if (/mailto:/i.test(u)) continue;
    const allowed = ALLOWED_HOST_FRAGMENTS.some((h) => u.includes(h));
    if (/xmlns|\.w3\.org/i.test(html.slice(Math.max(0, html.indexOf(u) - 40), html.indexOf(u)))) {
      continue;
    }
    if (!allowed && /\.(?:js|css|woff2?|png|jpg|svg|ico)(?:\?|$)/i.test(u)) {
      fail(`${rel}: external asset origin ${u}`);
    }
    if (!allowed && /(?:fonts\.|cdn\.|unpkg|jsdelivr|googleapis)/i.test(u)) {
      fail(`${rel}: forbidden external origin ${u}`);
    }
  }
}
if (!failed) ok('built HTML: no remote scripts/stylesheets/fonts');

for (const asset of [
  'js/js-class.js',
  'js/reveal.js',
  'fonts/inter-latin-400-normal.woff2',
  'og/luna-front-desk-og.png',
  'apple-touch-icon.png',
  '_headers',
]) {
  if (!existsSync(join(DIST, asset))) fail(`dist missing ${asset}`);
  else ok(`dist has ${asset}`);
}

const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!existsSync(join(DIST, 'privacy/index.html'))) fail('dist/privacy/index.html missing');
else ok('privacy page emitted');
if (!indexHtml.includes('href="/privacy/"') && !indexHtml.includes("href='/privacy/'")) {
  if (!indexHtml.includes('/privacy/')) fail('index.html missing /privacy/ link');
  else ok('index links to /privacy/');
} else {
  ok('index links to /privacy/');
}

const privacyHtml = readFileSync(join(DIST, 'privacy/index.html'), 'utf8');
const privacyNeedles = [
  'LAUNCH-BLOCKING REQUIRED VALUE',
  'controller-identity-blocker',
  'data-controller-complete="false"',
  '24 months',
  'self-hosted',
];
for (const n of privacyNeedles) {
  if (!privacyHtml.includes(n)) fail(`privacy launch block missing: ${n}`);
}
if (!failed) ok('privacy launch blocker preserved in dist');

if (!indexHtml.includes('lead-disabled-truth') || !/will not send or save/i.test(indexHtml)) {
  fail('lead disabled truth missing from built index');
} else {
  ok('lead disabled truth preserved');
}

if (!indexHtml.includes('Demo data') && !indexHtml.includes('demo data')) {
  fail('demo data labeling missing from built index');
} else {
  ok('demo copy preserved');
}

if (failed) {
  console.error('verify-security: FAILED');
  process.exit(1);
}
console.log('verify-security: PASS');
