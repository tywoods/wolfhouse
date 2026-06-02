'use strict';
/**
 * verify-staff-quote-preview-api.js
 * Stage 8.4.4 — Static verifier for POST /staff/quote-preview.
 *
 * Confirms the endpoint:
 *  A. Exists in staff-query-api.js with the correct route and handler.
 *  B. Imports calculateWolfhouseQuote from wolfhouse-quote-calculator.
 *  C. Loads pricing config from config/clients/wolfhouse-somo.pricing.json (via calculator).
 *  D. Response includes the required safety fields.
 *  E. Handler body contains no INSERT / UPDATE / DELETE SQL.
 *  F. No Stripe, WhatsApp, or n8n calls in the handler.
 *  G. Does not require MANUAL_BOOKING_ENABLED or STAFF_ACTIONS_ENABLED.
 *  H. node --check passes.
 *  I. package.json has the verify script.
 *
 * Usage: node scripts/verify-staff-quote-preview-api.js
 */

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const TARGET = path.join(__dirname, 'staff-query-api.js');
const PKG    = path.join(__dirname, '..', 'package.json');

let passed = 0, failed = 0;

function check(id, description, fn) {
  try {
    const result = fn();
    if (result === true || result === undefined) {
      console.log(`  PASS [${id}] ${description}`);
      passed++;
    } else {
      console.error(`  FAIL [${id}] ${description}`);
      if (typeof result === 'string') console.error(`       → ${result}`);
      failed++;
    }
  } catch (err) {
    console.error(`  FAIL [${id}] ${description}`);
    console.error(`       → ${err.message}`);
    failed++;
  }
}

check('A1', 'staff-query-api.js exists', () => {
  if (!fs.existsSync(TARGET)) return `File not found: ${TARGET}`;
});

if (!fs.existsSync(TARGET)) {
  console.error('\n  Cannot continue — staff-query-api.js not found.\n');
  process.exit(1);
}

const src = fs.readFileSync(TARGET, 'utf8');

// ─── A. Route + handler present ──────────────────────────────────────────────

check('A2', "router dispatches pathname === '/staff/quote-preview'", () => {
  if (!/pathname === ['"]\/staff\/quote-preview['"]/.test(src)) {
    return "no route for '/staff/quote-preview' found in router";
  }
});

check('A3', 'handleQuotePreview function defined', () => {
  if (!src.includes('async function handleQuotePreview')) {
    return 'handleQuotePreview not found in source';
  }
});

check('A4', 'route accepts POST method', () => {
  // Look for the method check in the route block
  if (!/quote-preview[\s\S]{0,200}method !== 'POST'/.test(src) &&
      !/method !== 'POST'[\s\S]{0,200}quote-preview/.test(src)) {
    return 'no POST-only guard found near the quote-preview route';
  }
});

check('A5', 'route calls handleQuotePreview', () => {
  if (!/return handleQuotePreview\(req, res/.test(src)) {
    return 'handleQuotePreview not called in router';
  }
});

// ─── B. Calculator import ─────────────────────────────────────────────────────

check('B1', "calculateWolfhouseQuote imported from './lib/wolfhouse-quote-calculator'", () => {
  if (!/require\(['"]\.\/lib\/wolfhouse-quote-calculator['"]\)/.test(src)) {
    return 'wolfhouse-quote-calculator not required in staff-query-api.js';
  }
});

check('B2', 'calculateWolfhouseQuote destructured in import', () => {
  if (!/calculateWolfhouseQuote/.test(src)) return 'calculateWolfhouseQuote not found in source';
});

check('B3', 'calculateWolfhouseQuote called inside handleQuotePreview handler', () => {
  const hStart = src.indexOf('async function handleQuotePreview');
  const hEnd   = hStart > 0 ? src.indexOf('\n// ───', hStart + 100) : -1;
  const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 8000) : '';
  if (!handler.includes('calculateWolfhouseQuote(')) {
    return 'calculateWolfhouseQuote not called inside handleQuotePreview';
  }
});

// ─── C. Pricing config ────────────────────────────────────────────────────────

check('C1', 'wolfhouse-quote-calculator.js loads config from wolfhouse-somo.pricing.json', () => {
  const calcPath = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
  if (!fs.existsSync(calcPath)) return 'wolfhouse-quote-calculator.js not found';
  const calcSrc = fs.readFileSync(calcPath, 'utf8');
  if (!calcSrc.includes('wolfhouse-somo.pricing.json')) {
    return 'pricing config path not found in calculator source';
  }
});

check('C2', 'config/clients/wolfhouse-somo.pricing.json exists', () => {
  const cfgPath = path.join(__dirname, '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');
  if (!fs.existsSync(cfgPath)) return `Config not found: ${cfgPath}`;
});

// ─── D. Response safety fields ────────────────────────────────────────────────

// Scope checks to the handler body
const hStart = src.indexOf('async function handleQuotePreview');
const hEnd   = hStart > 0 ? src.indexOf('\n// ───', hStart + 100) : -1;
const handler = hStart > 0 ? src.slice(hStart, hEnd > 0 ? hEnd : hStart + 8000) : '';

check('D1', 'response includes preview_only: true', () => {
  if (!handler.includes('preview_only') || !handler.includes('true')) {
    return 'preview_only: true not found in handler response';
  }
});

check('D2', 'response includes no_write_performed: true', () => {
  if (!handler.includes('no_write_performed')) {
    return 'no_write_performed not found in handler response';
  }
});

check('D3', 'response includes creates_booking: false', () => {
  if (!handler.includes('creates_booking')) {
    return 'creates_booking not found in handler response';
  }
});

check('D4', 'response includes creates_payment: false', () => {
  if (!handler.includes('creates_payment')) {
    return 'creates_payment not found in handler response';
  }
});

check('D5', 'response includes creates_stripe_link: false', () => {
  if (!handler.includes('creates_stripe_link')) {
    return 'creates_stripe_link not found in handler response';
  }
});

check('D6', 'response includes quote field (calculator output)', () => {
  if (!/\bquote,/.test(handler) && !/quote:\s*quote/.test(handler)) {
    return 'quote field not found in handler response';
  }
});

check('D7', 'response includes elapsed_ms', () => {
  if (!handler.includes('elapsed_ms')) {
    return 'elapsed_ms not found in handler response';
  }
});

// ─── E. No DB writes in handler ───────────────────────────────────────────────

check('E1', 'handler body contains no INSERT SQL', () => {
  if (/\bINSERT\s+INTO\b/i.test(handler)) {
    return 'INSERT found in handleQuotePreview handler body';
  }
});

check('E2', 'handler body contains no UPDATE SQL', () => {
  if (/\bUPDATE\s+\w/i.test(handler)) {
    return 'UPDATE found in handleQuotePreview handler body';
  }
});

check('E3', 'handler body contains no DELETE SQL', () => {
  if (/\bDELETE\s+FROM\b/i.test(handler)) {
    return 'DELETE found in handleQuotePreview handler body';
  }
});

check('E4', 'handler body contains no withPgClient call (no DB connection)', () => {
  if (handler.includes('withPgClient')) {
    return 'withPgClient found in handleQuotePreview — handler should not touch the DB';
  }
});

// ─── F. No Stripe / WhatsApp / n8n calls in handler ──────────────────────────

check('F1', 'handler body has no Stripe API calls', () => {
  if (/stripe\.(paymentIntents|checkout|customers|prices|invoices)/i.test(handler)) {
    return 'Stripe API call found in handler';
  }
  if (/require\s*\(\s*['"]stripe['"]\s*\)/.test(handler)) {
    return 'stripe require found in handler';
  }
});

check('F2', 'handler body has no WhatsApp calls', () => {
  if (/whatsapp|graph\.facebook\.com/i.test(handler)) {
    return 'WhatsApp/Facebook Graph call found in handler';
  }
});

check('F3', 'handler body has no n8n webhook calls', () => {
  if (/n8n|webhook.*n8n/i.test(handler)) {
    return 'n8n reference found in handler';
  }
});

check('F4', 'handler body has no fetch() call', () => {
  if (/\bfetch\s*\(/.test(handler)) {
    return 'fetch() call found in handler — handler must be pure (no network)';
  }
});

// ─── G. Access control ────────────────────────────────────────────────────────

check('G1', 'route does NOT gate on MANUAL_BOOKING_ENABLED', () => {
  // Only check the block AFTER the route match (no lookback into adjacent routes).
  const routeBlock = (() => {
    const idx = src.indexOf("pathname === '/staff/quote-preview'");
    if (idx < 0) return '';
    return src.slice(idx, idx + 500);
  })();
  if (routeBlock.includes('MANUAL_BOOKING_ENABLED')) {
    return 'route dispatch for quote-preview references MANUAL_BOOKING_ENABLED — must not gate on it';
  }
});

check('G2', 'handler does NOT set STAFF_ACTIONS_ENABLED = true', () => {
  if (/STAFF_ACTIONS_ENABLED\s*=\s*true/.test(handler)) {
    return 'handler sets STAFF_ACTIONS_ENABLED=true — forbidden';
  }
});

check('G3', 'handler does NOT set MANUAL_BOOKING_ENABLED = true', () => {
  if (/MANUAL_BOOKING_ENABLED\s*=\s*true/.test(handler)) {
    return 'handler sets MANUAL_BOOKING_ENABLED=true — forbidden';
  }
});

check('G4', 'route calls requireAuth (auth required when STAFF_AUTH_REQUIRED=true)', () => {
  const routeBlock = (() => {
    const idx = src.indexOf("pathname === '/staff/quote-preview'");
    if (idx < 0) return '';
    return src.slice(idx, idx + 400);
  })();
  if (!routeBlock.includes('requireAuth')) {
    return 'requireAuth not called in the quote-preview route dispatch block';
  }
});

// ─── H. node --check ─────────────────────────────────────────────────────────

check('H1', 'staff-query-api.js passes node --check (no syntax errors)', () => {
  try {
    execSync(`node --check "${TARGET}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

const calcPath = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
check('H2', 'wolfhouse-quote-calculator.js passes node --check', () => {
  if (!fs.existsSync(calcPath)) return 'calculator file not found';
  try {
    execSync(`node --check "${calcPath}"`, { stdio: 'pipe' });
  } catch (e) {
    return `node --check failed: ${e.stderr ? e.stderr.toString().trim() : e.message}`;
  }
});

// ─── I. package.json ─────────────────────────────────────────────────────────

check('I1', 'package.json has verify:staff-quote-preview-api script', () => {
  if (!fs.existsSync(PKG)) return 'package.json not found';
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (!pkg.scripts || !pkg.scripts['verify:staff-quote-preview-api']) {
    return 'verify:staff-quote-preview-api not found in package.json scripts';
  }
});

check('I2', 'startup log mentions /staff/quote-preview', () => {
  if (!src.includes('/staff/quote-preview')) {
    return '/staff/quote-preview not found in source (startup log check)';
  }
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error(`\nverify-staff-quote-preview-api FAILED (${failed} check(s) failed)\n`);
  process.exit(1);
} else {
  console.log('\nverify-staff-quote-preview-api PASS\n');
  process.exit(0);
}
