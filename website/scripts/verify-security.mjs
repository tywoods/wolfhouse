#!/usr/bin/env node
/**
 * Built-output + contract gates for Slice C security hardening.
 * Requires `npm run build` (and preferably sync-csp-hashes) first.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLocalAssetOrigins } from './lib/local-asset-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const CONTRACT_PATH = join(ROOT, 'security/headers.contract.json');
const HEADERS_PATH = join(ROOT, 'public/_headers');

let failed = false;
function fail(msg) {
  console.error(`FAIL  ${msg}`);
  failed = true;
}
function ok(msg) {
  console.log(`PASS  ${msg}`);
}

function sha256Csp(content) {
  return `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;
}

function collectFiles(dir, pred) {
  const out = [];
  function walk(d) {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (pred(name, abs)) out.push(abs);
    }
  }
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

function extractInline(html, tag) {
  const bodies = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue;
    bodies.push(m[2]);
  }
  return bodies;
}

function parseCspFromHeaders(text) {
  const m = text.match(/Content-Security-Policy:\s*(.+)/i);
  if (!m) return null;
  return m[1].trim();
}

// --- Contract presence -------------------------------------------------------
if (!existsSync(CONTRACT_PATH)) {
  fail('security/headers.contract.json missing');
  process.exit(1);
}
if (!existsSync(HEADERS_PATH)) {
  fail('public/_headers missing');
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html missing — run npm run build first');
  process.exit(1);
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const headersText = readFileSync(HEADERS_PATH, 'utf8');
const csp = parseCspFromHeaders(headersText);

if (!csp) fail('_headers missing Content-Security-Policy');
else ok('CSP present in public/_headers');

// Forbidden tokens in the live CSP value (contract may list them under forbiddenTokens).
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

// HSTS caveats documented
if (!/HSTS caveat/i.test(headersText) || !contract.headers['Strict-Transport-Security']?.previewCaveat) {
  fail('HSTS preview/HTTPS caveats not documented');
} else {
  ok('HSTS caveats documented');
}

// CSP directive presence
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

// --- Source scanner ----------------------------------------------------------
const scan = scanLocalAssetOrigins(ROOT);
if (scan.files.length < 5) fail(`source scan found too few files: ${scan.files.length}`);
else ok(`source scan enumerated ${scan.files.length} CSS/Astro/HTML files`);
if (scan.errors.length) {
  for (const e of scan.errors) fail(`source scan: ${e}`);
} else {
  ok('source scan: all stylesheet/@import/@font-face URLs local');
}

// --- Dist: CSP hash compatibility --------------------------------------------
const htmlFiles = collectFiles(DIST, (n) => n.endsWith('.html'));
const neededScript = new Set();
const neededStyle = new Set();
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  for (const body of extractInline(html, 'script')) neededScript.add(sha256Csp(body));
  for (const body of extractInline(html, 'style')) neededStyle.add(sha256Csp(body));
}

const contractScripts = new Set(contract.inlineHashes?.script || []);
const contractStyles = new Set(contract.inlineHashes?.style || []);
for (const h of neededScript) {
  if (!contractScripts.has(h) || !(csp || '').includes(h)) {
    fail(`inline script hash not in contract/CSP: ${h}`);
  }
}
for (const h of neededStyle) {
  if (!contractStyles.has(h) || !(csp || '').includes(h)) {
    fail(`inline style hash not in contract/CSP: ${h}`);
  }
}
if (!failed) {
  ok(`CSP hashes cover ${neededScript.size} script + ${neededStyle.size} style inline block(s)`);
}

// Our scripts must be external (no is:inline bodies for reveal/js-class)
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
  'lunafrontdesk.com', // canonical/OG absolute URLs in meta (same product origin family)
];

for (const file of htmlFiles) {
  const rel = relative(DIST, file);
  const html = readFileSync(file, 'utf8');

  // No remote script/link stylesheet
  if (/<script\b[^>]*\bsrc\s*=\s*['"](?:https?:)?\/\//i.test(html)) {
    fail(`${rel}: remote script src`);
  }
  if (/<link\b[^>]*stylesheet[^>]*href\s*=\s*['"](?:https?:)?\/\//i.test(html)) {
    fail(`${rel}: remote stylesheet`);
  }

  // Fonts must stay on-origin paths
  if (/(?:fonts\.googleapis|fonts\.gstatic|fonts\.google)/i.test(html)) {
    fail(`${rel}: Google Fonts reference in built HTML`);
  }

  // Asset refs that look like http(s) for scripts/fonts/css
  const badAsset = html.match(
    /(?:src|href)=['"](?:https?:)?\/\/[^'"]+\.(?:js|css|woff2?|ttf|otf)['"]/gi,
  );
  if (badAsset?.length) fail(`${rel}: remote asset ref(s): ${badAsset.join(', ')}`);

  // Collect absolute URLs; allow only product canonical host in meta, mailto, etc.
  const urls = html.match(ABS_EXT) || [];
  for (const u of urls) {
    if (/^\/\/www\.w3\.org/i.test(u)) continue; // SVG xmlns occasionally
    if (/mailto:/i.test(u)) continue;
    const allowed = ALLOWED_HOST_FRAGMENTS.some((h) => u.includes(h));
    // Namespace URIs and schema.org-ish — skip non-network xmlns
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

// Local critical assets exist
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

// Internal links that point at site paths should not 404 for known pages
const indexHtml = readFileSync(join(DIST, 'index.html'), 'utf8');
if (!existsSync(join(DIST, 'privacy/index.html'))) fail('dist/privacy/index.html missing');
else ok('privacy page emitted');
if (!indexHtml.includes('href="/privacy/"') && !indexHtml.includes("href='/privacy/'")) {
  // privacy link may be relative on island — check privacy path exists in footer
  if (!indexHtml.includes('/privacy/')) fail('index.html missing /privacy/ link');
  else ok('index links to /privacy/');
} else {
  ok('index links to /privacy/');
}

// --- Privacy launch block preserved ------------------------------------------
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

// Lead disabled truth in index
if (!indexHtml.includes('lead-disabled-truth') || !/will not send or save/i.test(indexHtml)) {
  fail('lead disabled truth missing from built index');
} else {
  ok('lead disabled truth preserved');
}

// Demo isolation cues
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
