/**
 * Stage 27test-t.1 — Verifier for shared Postgres pool in pg-connect.js
 *
 * Usage:
 *   npm run verify:stage27test-t-pg-pool
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PG_CONNECT = path.join(__dirname, 'lib', 'pg-connect.js');
const PKG = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27test-t-pg-pool';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27test-t-pg-pool.js  (Stage 27test-t.1)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. pg-connect module');

if (!fs.existsSync(PG_CONNECT)) {
  fail('A1', 'pg-connect.js missing');
} else {
  pass('A1', 'pg-connect.js exists');
  try {
    execSync(`node --check "${PG_CONNECT}"`, { stdio: 'pipe' });
    pass('A2', 'pg-connect.js passes node --check');
  } catch {
    fail('A2', 'pg-connect.js syntax error');
  }
}

const src = fs.existsSync(PG_CONNECT) ? fs.readFileSync(PG_CONNECT, 'utf8') : '';
const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

if (src.includes("require('pg')") && src.includes('Pool')) {
  pass('A3', 'imports Pool from pg');
} else {
  fail('A3', 'Pool import missing');
}

if (/let pool\s*=\s*null|var pool\s*=\s*null/.test(src) && src.includes('function getPool')) {
  pass('A4', 'module-level singleton pool with lazy getPool');
} else {
  fail('A4', 'singleton pool pattern missing');
}

if (!/withPgClient[\s\S]*new Client/.test(src)) {
  pass('A5', 'withPgClient does not construct new Client()');
} else {
  fail('A5', 'withPgClient still uses new Client()');
}

if (src.includes('pool.connect()') || src.includes('getPool().connect()')) {
  pass('A6', 'withPgClient uses pool.connect()');
} else {
  fail('A6', 'pool.connect() missing');
}

if (src.includes('client.release()')) {
  pass('A7', 'client.release() in finally');
} else {
  fail('A7', 'client.release() missing');
}

if (!src.includes('client.end()')) {
  pass('A8', 'does not call client.end() per request');
} else {
  fail('A8', 'still calls client.end() — should use release()');
}

if (src.includes('PG_POOL_MAX')) {
  pass('A9', 'PG_POOL_MAX env supported');
} else {
  fail('A9', 'PG_POOL_MAX missing');
}

if (src.includes('connectionTimeoutMillis')) {
  pass('A10', 'connectionTimeoutMillis configured');
} else {
  fail('A10', 'connectionTimeoutMillis missing');
}

if (src.includes('idleTimeoutMillis')) {
  pass('A11', 'idleTimeoutMillis configured');
} else {
  fail('A11', 'idleTimeoutMillis missing');
}

if (src.includes('getConnectionString') && src.includes('withPgClient')) {
  pass('A12', 'getConnectionString and withPgClient exports preserved');
} else {
  fail('A12', 'public API exports missing');
}

if (!/new Pool\([\s\S]*withPgClient/.test(src) || !src.includes('if (!pool)')) {
  if (src.includes('if (!pool)')) {
    pass('A13', 'Pool created once in getPool lazy init');
  } else {
    fail('A13', 'Pool may be created per request');
  }
} else {
  pass('A13', 'Pool created once in getPool lazy init');
}

section('B. Runtime smoke');

try {
  const { getConnectionString, withPgClient } = require('./lib/pg-connect.js');
  if (typeof getConnectionString === 'function') pass('B1', 'getConnectionString is a function');
  else fail('B1', 'getConnectionString not a function');
  if (typeof withPgClient === 'function') pass('B2', 'withPgClient is a function');
  else fail('B2', 'withPgClient not a function');
  const cs = getConnectionString();
  if (cs && String(cs).includes('postgres')) pass('B3', 'getConnectionString returns postgres URL');
  else fail('B3', 'getConnectionString invalid');
} catch (e) {
  fail('B1', `runtime require failed: ${e.message}`);
}

section('C. Safety — no live sends');

const forbidden = [
  ['C1', 'sendWhatsApp', 'WhatsApp send'],
  ['C2', 'api.stripe.com', 'Stripe fetch'],
  ['C3', 'graph.facebook.com', 'Meta fetch'],
  ['C4', 'calls_n8n', 'n8n call flag'],
];
for (const [id, sym, label] of forbidden) {
  if (!code.includes(sym)) pass(id, `pg-connect does not reference ${label}`);
  else fail(id, `pg-connect references ${label}`);
}

section('D. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('D1', `${SCRIPT} registered`);
else fail('D1', `${SCRIPT} npm script missing`);

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
