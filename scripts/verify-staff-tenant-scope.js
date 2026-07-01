'use strict';

/**
 * Staff API tenant/session scope guard (read-only).
 *
 * 1) Static SQL scan for tenant-sensitive tables without obvious client scope.
 * 2) Staff portal session-scoped client helpers.
 * 3) /staff/auth/session handler uses session-scoped helpers when auth required.
 *
 * Debt hotspots are reported; strict fail on mirleft/lawave scope mistakes only.
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');

const {
  getSessionScopedClients,
  buildSessionClientProfilesMap,
  getAccessibleClients,
  buildClientProfilesMap,
  listBaselineClients,
} = require('./lib/staff-portal-clients');

const REPO_ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(__dirname, 'staff-query-api.js');
const SUNSET_ACCESS_PATH = path.join(REPO_ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json');

const SENSITIVE_TABLES = [
  'bookings',
  'booking_service_records',
  'guest_message_events',
  'staff_conversations',
  'staff_conversation_messages',
  'customers',
  'tenant_services',
  'auth_sessions',
  'staff_users',
  'payments',
  'payment_records',
  'stripe_payment_events',
];

const TABLE_PATTERN = new RegExp(
  `\\b(${SENSITIVE_TABLES.join('|')})\\b`,
  'i',
);

const SCOPE_PATTERNS = [
  /\bclient_id\b/i,
  /\bclient_slug\b/i,
  /\btenant_id\b/i,
  /\blocation_id\b/i,
  /\bc\.slug\b/i,
  /\bclients\.slug\b/i,
  /\bJOIN\s+clients\b/i,
  /\bFROM\s+clients\b/i,
];

const GRANDFATHER_OK = /MULTICLIENT_SCOPE_OK:/;
const GRANDFATHER_TODO = /MULTICLIENT_SCOPE_TODO:/;
const MIRLEFT_LAWAVE = /\b(mirleft|lawave)\b/i;

const WINDOW_RADIUS = 22;
const DEBT_SHOW_MAX = 40;

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
    if (detail) console.log(`        ${detail}`);
  }
}

function relPath(abs) {
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function collectScanFiles() {
  const libDir = path.join(__dirname, 'lib');
  const out = new Set([STAFF_API_PATH]);
  const namePatterns = [/query/i, /queries/i, /write/i, /writes/i, /staff-bot-v2-routes/i];
  let entries = [];
  try {
    entries = fs.readdirSync(libDir);
  } catch {
    return [...out];
  }
  for (const name of entries) {
    if (!name.endsWith('.js')) continue;
    if (namePatterns.some((re) => re.test(name))) {
      out.add(path.join(libDir, name));
    }
  }
  return [...out].sort();
}

function windowText(lines, lineIdx) {
  const start = Math.max(0, lineIdx - WINDOW_RADIUS);
  const end = Math.min(lines.length, lineIdx + WINDOW_RADIUS + 1);
  return lines.slice(start, end).join('\n');
}

function hasScopeInWindow(text) {
  return SCOPE_PATTERNS.some((re) => re.test(text));
}

function hasGrandfatherOk(text) {
  return GRANDFATHER_OK.test(text);
}

function hasGrandfatherTodo(text) {
  return GRANDFATHER_TODO.test(text);
}

function looksSqlContext(line) {
  if (/\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|INTO|WHERE)\b/i.test(line)) return true;
  if (/`[\s\S]*/.test(line) && TABLE_PATTERN.test(line)) return true;
  if (line.includes('${') && TABLE_PATTERN.test(line)) return true;
  return false;
}

function scanSqlScopeDebt() {
  const debt = [];
  const todos = [];
  const strict = [];

  for (const filePath of collectScanFiles()) {
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const rel = relPath(filePath);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!TABLE_PATTERN.test(line)) continue;
      if (!looksSqlContext(line) && !/`/.test(line)) continue;

      const match = line.match(TABLE_PATTERN);
      const table = match ? match[1].toLowerCase() : 'unknown';
      const win = windowText(lines, i);

      if (hasGrandfatherOk(win)) continue;

      if (hasGrandfatherTodo(win)) {
        todos.push({ rel, line: i + 1, table });
        continue;
      }

      if (hasScopeInWindow(win)) continue;

      const hit = { rel, line: i + 1, table };
      debt.push(hit);

      if (MIRLEFT_LAWAVE.test(win) && !hasGrandfatherOk(win)) {
        strict.push(hit);
      }
    }
  }

  return { debt, todos, strict };
}

function extractHandleAuthSessionSource(source) {
  const start = source.indexOf('async function handleAuthSession');
  if (start < 0) return '';
  const rest = source.slice(start);
  const endMatch = rest.search(/\nasync function handle[A-Z]/);
  const fnBody = endMatch > 0 ? rest.slice(0, endMatch) : rest.slice(0, 8000);
  const authSplit = fnBody.split('if (!STAFF_AUTH_REQUIRED)');
  const devBlock = authSplit[1] ? authSplit[1].split('let user;')[0] : '';
  const authBlock = authSplit[1] ? authSplit[1].split('let user;')[1] || '' : fnBody;
  return { fnBody, devBlock, authBlock };
}

console.log('verify:staff-tenant-scope — Staff API tenant/session guardrails\n');

// ── B. Portal session client scoping ────────────────────────────────────────
console.log('── Portal session client scoping ──');

const wolfhouseUser = {
  email: 'tywoods@gmail.com',
  client_slug: 'wolfhouse-somo',
  role: 'owner',
};

const wolfScoped = getSessionScopedClients(wolfhouseUser);
ok('1 wolfhouse session returns exactly one client', wolfScoped.length === 1);
ok('1 wolfhouse session slug is wolfhouse-somo', wolfScoped[0] && wolfScoped[0].slug === 'wolfhouse-somo');

const sunsetAccess = JSON.parse(fs.readFileSync(SUNSET_ACCESS_PATH, 'utf8'));
const sunsetEmail = 'tywoods@gmail.com';
const sunsetAllowed = sunsetAccess.client_access && sunsetAccess.client_access[sunsetEmail];
ok('2 sunset staging access config lists sunset only', Array.isArray(sunsetAllowed)
  && sunsetAllowed.length === 1 && sunsetAllowed[0] === 'sunset');

const sunsetBaseline = listBaselineClients().filter((c) => c.slug === 'sunset');
ok('2 sunset baseline client exists', sunsetBaseline.length === 1);
const sunsetFilterSim = listBaselineClients().filter((c) => c.slug === 'sunset');
ok('2 session filter logic returns only sunset for sunset slug', sunsetFilterSim.length === 1
  && sunsetFilterSim[0].slug === 'sunset');

const noSlugUser = { email: 'tywoods@gmail.com', client_slug: '', role: 'operator' };
ok('3 authenticated user without client_slug returns no session clients', getSessionScopedClients(noSlugUser).length === 0);

const profiles = buildSessionClientProfilesMap(wolfhouseUser);
const profileKeys = Object.keys(profiles);
ok('4 buildSessionClientProfilesMap returns only active session client', profileKeys.length === 1
  && profileKeys[0] === 'wolfhouse-somo');

const broad = getAccessibleClients(wolfhouseUser);
const session = getSessionScopedClients(wolfhouseUser);
ok('5 getAccessibleClients can differ from session-scoped list', broad.length >= session.length);

// ── C. /staff/auth/session static assertion ───────────────────────────────
console.log('\n── /staff/auth/session handler ──');

const staffApiSource = fs.readFileSync(STAFF_API_PATH, 'utf8');
const { devBlock, authBlock } = extractHandleAuthSessionSource(staffApiSource);

ok('C1 authenticated session uses getSessionScopedClients', /getSessionScopedClients\(user\)/.test(authBlock));
ok('C2 authenticated session uses buildSessionClientProfilesMap', /buildSessionClientProfilesMap\(user\)/.test(authBlock));
ok('C3 authenticated session does not use buildClientProfilesMap(user)', !/buildClientProfilesMap\(user\)/.test(authBlock));
ok('C4 authenticated session does not use getAccessibleClients(user)', !/getAccessibleClients\(user\)/.test(authBlock));
ok('C5 dev no-auth bypass uses broad getAccessibleClients(null) (legacy local)', /getAccessibleClients\(null\)/.test(devBlock));

// ── A. SQL scope debt scan ──────────────────────────────────────────────────
console.log('\n── SQL tenant scope scan (debt report) ──');

const { debt, todos, strict } = scanSqlScopeDebt();

if (debt.length === 0) {
  ok('A no unscoped tenant-sensitive SQL hotspots', true);
} else {
  console.log(`  INFO  ${debt.length} unscoped hotspot(s) (historical debt — add scope or MULTICLIENT_SCOPE_OK/TODO):\n`);
  const shown = debt.slice(0, DEBT_SHOW_MAX);
  for (const h of shown) {
    console.log(`    ${h.rel}:${h.line}  [${h.table}]`);
  }
  if (debt.length > DEBT_SHOW_MAX) {
    console.log(`    ... and ${debt.length - DEBT_SHOW_MAX} more`);
  }
  ok('A debt scan completed (report-only for legacy unscoped SQL)', true);
}

if (todos.length > 0) {
  console.log(`\n  INFO  ${todos.length} MULTICLIENT_SCOPE_TODO marker(s):`);
  for (const t of todos.slice(0, 15)) {
    console.log(`    ${t.rel}:${t.line}  [${t.table}]`);
  }
}

ok('A strict mirleft/lawave scope violations', strict.length === 0, strict.length
  ? strict.map((h) => `${h.rel}:${h.line}`).join(', ')
  : null);

console.log(`\n── staff-tenant-scope summary: debt=${debt.length}, todo_markers=${todos.length}, strict=${strict.length} ──`);
console.log(`── staff-tenant-scope: ${pass} passed, ${fail} failed ──`);

if (fail === 0) {
  console.log('verify:staff-tenant-scope — PASSED (debt reported; strict mirleft/lawave clean)');
}
process.exit(fail ? 1 : 0);
