'use strict';

/**
 * Verifier for the Sunset Finance read-only endpoint wiring in staff-query-api.js.
 * Source-level assertions (the full server is not booted here): route + owner/admin
 * gate, fail-closed tenant/location, server-side compute, no client-side money math.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}

function between(src, start, end) {
  const i = src.indexOf(start);
  if (i < 0) return '';
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? src.length : j);
}

// ── requires wired ──────────────────────────────────────────────────────────
ok('requires fetchSunsetFinanceData', /require\(['"]\.\/lib\/sunset-finance-data['"]\)/.test(API));
ok('requires computeSunsetFinanceSummary', /require\(['"]\.\/lib\/sunset-finance-summary['"]\)/.test(API));

// ── route registered as owner/admin GET ─────────────────────────────────────
const routeBlock = between(API, "pathname === '/staff/admin/finance/summary'", 'handleAdminFinanceSummaryGet(parsed.query');
ok('GET route /staff/admin/finance/summary registered', /pathname === '\/staff\/admin\/finance\/summary' && method === 'GET'/.test(API));
ok("route gated owner/admin via requireAuth(...,'admin')", /requireAuth\(req, res, 'admin'\)/.test(routeBlock));

// ── handler behavior ────────────────────────────────────────────────────────
const handler = between(API, 'async function handleAdminFinanceSummaryGet', 'async function handleAdminConfigPricePost');
ok('handler defined', handler.length > 0);
ok('fails closed for non-sunset client', /clientSlug !== 'sunset'/.test(handler) && /finance_unavailable_for_client/.test(handler));
ok('normalizes + restricts location to sunset-somo', /normalizeSunsetLocationId\(query\.location\)/.test(handler) && /locationId !== 'sunset-somo'/.test(handler) && /finance_unavailable_for_location/.test(handler));
ok('asserts staff client access (fail closed)', /assertStaffClientAccess\(user, clientSlug, res\)/.test(handler));
ok('rejects sql-injection-shaped client slug', /SQL_INJECT_RE\.test\(clientSlug\)/.test(handler));
ok('reads via withPgClient + fetchSunsetFinanceData', /withPgClient\(\(pg\) => fetchSunsetFinanceData\(pg, \{ clientSlug, locationId \}\)\)/.test(handler));
ok('computes server-side via pure lib', /computeSunsetFinanceSummary\(\{[\s\S]*data \}\)/.test(handler));
ok('uses Europe/Madrid timezone', /timeZone: 'Europe\/Madrid'/.test(handler));
ok('does not do money arithmetic in the handler', !/[+\-*/]=|Math\.(max|min|round)\(/.test(handler.replace(/Date\.now\(\) - started/g, '')));
ok('returns success + summary payload', /success: true/.test(handler) && /summary,/.test(handler));
ok('read failure returns safe 500 (no raw detail leak)', /error: 'read failed'/.test(handler));

console.log(`\n── verify:sunset-finance-endpoint: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-endpoint — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
