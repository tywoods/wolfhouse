'use strict';

/**
 * Staff API tenant/session scope guard (read-only).
 *
 * 1) Static SQL scan for tenant-sensitive tables without obvious client scope.
 * 2) Match every hotspot against scripts/fixtures/staff-tenant-scope-debt-registry.json.
 * 3) Staff portal session-scoped client helpers.
 * 4) /staff/auth/session handler uses session-scoped helpers when auth required.
 *
 * Exit 0 when all hotspots are classified and strict mirleft/lawave scope is clean.
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
const REGISTRY_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-registry.json');

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
const TOP_LIVE_FIX_MAX = 10;

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

function hotspotKey(rel, line) {
  return `${rel}:${line}`;
}

function loadScopeDebtRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const byKey = new Map();
  for (const entry of entries) {
    const key = hotspotKey(entry.file, entry.line);
    if (byKey.has(key)) {
      throw new Error(`duplicate registry key ${key}`);
    }
    byKey.set(key, entry);
  }
  return { meta: parsed, entries, byKey };
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

function classifyDebtHotspots(debt, registryByKey) {
  const unclassified = [];
  const classified = [];
  const matchedKeys = new Set();

  for (const hit of debt) {
    const key = hotspotKey(hit.rel, hit.line);
    const entry = registryByKey.get(key);
    if (!entry) {
      unclassified.push(hit);
      continue;
    }
    matchedKeys.add(key);
    classified.push({ hit, entry });
  }

  const stale = [];
  for (const entry of registryByKey.values()) {
    const key = hotspotKey(entry.file, entry.line);
    if (!matchedKeys.has(key)) {
      stale.push(entry);
    }
  }

  return { unclassified, classified, stale };
}

function summarizeClassification(classified) {
  const byStatus = { ok: 0, todo: 0 };
  const byRisk = {
    false_positive: 0,
    ok_session_or_indirect_scope: 0,
    must_fix_before_shared_staging_router: 0,
    must_fix_before_live_multiclient: 0,
  };
  const todoItems = [];

  for (const { hit, entry } of classified) {
    if (entry.status === 'ok') byStatus.ok += 1;
    else if (entry.status === 'todo') {
      byStatus.todo += 1;
      todoItems.push({ hit, entry });
    }
    if (entry.risk && Object.prototype.hasOwnProperty.call(byRisk, entry.risk)) {
      byRisk[entry.risk] += 1;
    }
  }

  return { byStatus, byRisk, todoItems };
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

let registry;
try {
  registry = loadScopeDebtRegistry();
} catch (err) {
  console.error(`  FAIL  could not load debt registry: ${err.message}`);
  process.exit(1);
}

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

// ── D. Bed calendar ledger SQL client scope (Slice 6) ───────────────────────
console.log('\n── Bed calendar ledger SQL scope ──');

const ledgerSqlMatch = staffApiSource.match(/const BED_CALENDAR_BOOKING_LEDGER_SQL = `([\s\S]*?)`;/);
const unpaidLinkSqlMatch = staffApiSource.match(/const BED_CALENDAR_UNPAID_LINK_SQL = `([\s\S]*?)`;/);
const ledgerSql = ledgerSqlMatch ? ledgerSqlMatch[1] : '';
const unpaidLinkSql = unpaidLinkSqlMatch ? unpaidLinkSqlMatch[1] : '';

ok('D1 bed calendar handler enforces assertStaffClientAccess', /async function handleBedCalendar[\s\S]*?assertStaffClientAccess\(user, clientSlug, res\)/.test(staffApiSource));
ok('D2 ledger SQL outer bookings scoped by clients.slug', /FROM bookings b[\s\S]*INNER JOIN clients c ON c\.id = b\.client_id[\s\S]*c\.slug = \$2/.test(ledgerSql));
ok('D3 ledger SQL payments subquery scoped by clients.slug', /FROM payments p[\s\S]*INNER JOIN clients pc[\s\S]*pc\.slug = \$2/.test(ledgerSql));
ok('D4 ledger SQL service_records subquery scoped by clients.slug', /FROM booking_service_records bsr[\s\S]*INNER JOIN clients sc[\s\S]*sc\.slug = \$2/.test(ledgerSql));
ok('D5 unpaid link SQL scoped by clients.slug', /FROM payments p[\s\S]*INNER JOIN clients c[\s\S]*c\.slug = \$2/.test(unpaidLinkSql));
ok('D6 bed calendar ledger queries pass clientSlug param', /BED_CALENDAR_BOOKING_LEDGER_SQL, \[bookingIds, clientSlug\]/.test(staffApiSource)
  && /BED_CALENDAR_UNPAID_LINK_SQL, \[bookingIds, clientSlug\]/.test(staffApiSource));

// ── E. Payment / Stripe tenant scope (Slice 7) ───────────────────────────────
console.log('\n── Payment / Stripe SQL scope ──');

ok('E1 guest booking bridge scopes payments by client slug',
  /lookupIdempotentBookingReplay[\s\S]*FROM payments p[\s\S]*INNER JOIN clients c[\s\S]*c\.slug = \$2/.test(staffApiSource)
  || /FROM payments p[\s\S]*INNER JOIN clients c[\s\S]*c\.slug = \$2/.test(
    fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-booking-write-bridge.js'), 'utf8'),
  ));
ok('E2 hold payment draft SELECT filters by client_id',
  /loadPaymentDraftForBooking[\s\S]*AND client_id = \$2/.test(
    fs.readFileSync(path.join(__dirname, 'lib', 'luna-guest-hold-payment-draft-write.js'), 'utf8'),
  ));
ok('E3 bot stripe link UPDATE payments includes client_id predicate',
  /UPDATE payments[\s\S]*WHERE id = \$5[\s\S]*AND client_id = \$6/.test(
    fs.readFileSync(path.join(__dirname, 'lib', 'staff-bot-v2-routes.js'), 'utf8'),
  ));
ok('E4 staff cash payment idempotency SELECT joins clients.slug',
  /api:booking_record_cash_payment[\s\S]*FROM payments p[\s\S]*INNER JOIN clients c[\s\S]*c\.slug = \$2/.test(staffApiSource)
  || /metadata->>'idempotency_key' = \$3[\s\S]*LIMIT 1/.test(staffApiSource));
ok('E5 stripe webhook payment UPDATE includes client_id predicate',
  (staffApiSource.match(/WHERE id = \$4\s+AND client_id = \$5/g) || []).length >= 2);
ok('E6 staff payment link UPDATE includes client_id predicate',
  /staff_portal_stage849[\s\S]*WHERE id = \$5[\s\S]*AND client_id = \$6/.test(staffApiSource));

// ── F. Final payment-scope blocker (Slice 8) ─────────────────────────────────
console.log('\n── Combo-waive payment scope ──');

ok('F1 zeroOutUnpaidAddonServiceRecord payment cancel is client-scoped',
  /async function zeroOutUnpaidAddonServiceRecord\(pg, serviceRecordId, clientSlug\)[\s\S]*UPDATE payments p[\s\S]*FROM clients c[\s\S]*AND c\.slug = \$3/.test(staffApiSource));
ok('F2 zeroOutUnpaidAddonServiceRecord caller passes clientSlug',
  /zeroOutUnpaidAddonServiceRecord\(pg, comboPricing\.free_wetsuit_record_id, ctx\.clientSlug\)/.test(staffApiSource));

// ── G. Booking UPDATE by id tenant scope (Slice 9) ───────────────────────────
console.log('\n── Booking UPDATE by id SQL scope ──');

ok('G1 private room companion block UPDATE scoped by clientSlug',
  /staffPortalCreatePrivateRoomCompanionBlock[\s\S]*UPDATE bookings[\s\S]*private_room_parent_booking_id[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$3/.test(staffApiSource));
ok('G2 bot booking create quote UPDATE scoped by clientSlug',
  /bot_source:[\s\S]*UPDATE bookings[\s\S]*total_amount_cents[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$7/.test(staffApiSource));
ok('G3 manualBookingApplyStaffPaymentChoice paid booking UPDATE scoped',
  /async function manualBookingApplyStaffPaymentChoice[\s\S]*UPDATE bookings[\s\S]*amount_paid_cents = \$1[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$5/.test(staffApiSource));
ok('G4 manualBookingApplyStaffPaymentChoice waiting_payment UPDATEs scoped',
  (staffApiSource.match(/SET payment_status = 'waiting_payment'::payment_status[\s\S]*?AND client_id = \(SELECT id FROM clients WHERE slug = \$2/g) || []).length >= 2);
ok('G5 manual booking create quote UPDATE scoped by clientSlug',
  /quote_snapshot:[\s\S]*paid_amount_type:[\s\S]*UPDATE bookings[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$7/.test(staffApiSource));
ok('G6 manual booking private room preference UPDATE scoped',
  /room_preference = 'couple_private'[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$2/.test(staffApiSource));
ok('G7 staff calendar bed block UPDATE scoped by clientSlug',
  /intent: 'api:calendar_bed_block_create'[\s\S]*UPDATE bookings[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$3[\s\S]*block_type: 'bed_selection'/.test(staffApiSource));
ok('G8 no unscoped booking UPDATE by id in must-fix helper paths',
  !/manualBookingApplyStaffPaymentChoice[\s\S]*UPDATE bookings SET payment_status = 'waiting_payment'::payment_status WHERE id = \$1::uuid`,\s*\[bookingId\],/.test(staffApiSource));

// ── H. booking_service_records tenant scope (Slice 10) ─────────────────────────
console.log('\n── booking_service_records SQL scope ──');

ok('H1 staff add-service idempotency SELECT filters by client_slug',
  /handleBookingAddService[\s\S]*FROM booking_service_records[\s\S]*AND client_slug = \$4[\s\S]*idempotency_key/.test(staffApiSource));
ok('H2 staff add-service INSERT sets client_slug',
  /INSERT INTO booking_service_records[\s\S]*client_slug, booking_id[\s\S]*\$1, \$2::uuid/.test(staffApiSource));
ok('H3 stripe webhook addon idempotent COUNT filters by client_slug',
  /addon_service[\s\S]*SELECT COUNT\(\*\)::int AS n FROM booking_service_records[\s\S]*AND client_slug = \$2/.test(staffApiSource));
ok('H4 stripe webhook addon service record UPDATE filters by client_slug',
  /UPDATE booking_service_records[\s\S]*AND client_slug = \$4[\s\S]*payment_status IS DISTINCT FROM 'paid'/.test(staffApiSource));
ok('H5 stripe webhook addon linked SELECT filters by client_slug',
  /FROM booking_service_records[\s\S]*WHERE payment_id = \$1[\s\S]*AND client_slug = \$2/.test(staffApiSource));

// ── A. SQL scope debt scan + registry classification ─────────────────────────
console.log('\n── SQL tenant scope scan (debt registry) ──');

const { debt, todos, strict } = scanSqlScopeDebt();
const { unclassified, classified, stale } = classifyDebtHotspots(debt, registry.byKey);
const { byStatus, byRisk, todoItems } = summarizeClassification(classified);

ok('A1 every scanned hotspot is classified in debt registry', unclassified.length === 0, unclassified.length
  ? unclassified.map((h) => `${h.rel}:${h.line} [${h.table}]`).join('; ')
  : null);

ok('A2 registry has no stale entries (removed hotspots)', stale.length === 0, stale.length
  ? stale.map((e) => `${e.file}:${e.line}`).join('; ')
  : null);

const openTodo = todoItems.filter(({ entry }) => entry.status === 'todo');
if (openTodo.length > 0) {
  console.log(`\n  INFO  ${openTodo.length} classified todo hotspot(s):`);
  const shown = openTodo.slice(0, DEBT_SHOW_MAX);
  for (const { hit, entry } of shown) {
    console.log(`    ${hit.rel}:${hit.line}  [${hit.table}]  risk=${entry.risk}`);
  }
  if (openTodo.length > DEBT_SHOW_MAX) {
    console.log(`    ... and ${openTodo.length - DEBT_SHOW_MAX} more`);
  }
}

if (todos.length > 0) {
  console.log(`\n  INFO  ${todos.length} inline MULTICLIENT_SCOPE_TODO marker(s):`);
  for (const t of todos.slice(0, 15)) {
    console.log(`    ${t.rel}:${t.line}  [${t.table}]`);
  }
}

const liveFixTop = todoItems
  .filter(({ entry }) => entry.risk === 'must_fix_before_live_multiclient')
  .slice(0, TOP_LIVE_FIX_MAX);

console.log('\n── Debt classification summary ──');
console.log(`  hotspots_scanned: ${debt.length}`);
console.log(`  classified: ${classified.length}`);
console.log(`  status ok: ${byStatus.ok}`);
console.log(`  status todo: ${byStatus.todo}`);
console.log(`  risk false_positive: ${byRisk.false_positive}`);
console.log(`  risk ok_session_or_indirect_scope: ${byRisk.ok_session_or_indirect_scope}`);
console.log(`  risk must_fix_before_shared_staging_router: ${byRisk.must_fix_before_shared_staging_router}`);
console.log(`  risk must_fix_before_live_multiclient: ${byRisk.must_fix_before_live_multiclient}`);

if (liveFixTop.length > 0) {
  console.log(`\n── Top ${liveFixTop.length} must_fix_before_live_multiclient ──`);
  for (const { hit, entry } of liveFixTop) {
    console.log(`  ${entry.id}`);
    console.log(`    ${hit.rel}:${hit.line} [${hit.table}]`);
    console.log(`    ${entry.reason}`);
  }
}

ok('A strict mirleft/lawave scope violations', strict.length === 0, strict.length
  ? strict.map((h) => `${h.rel}:${h.line}`).join(', ')
  : null);

console.log(`\n── staff-tenant-scope summary: scanned=${debt.length}, classified=${classified.length}, unclassified=${unclassified.length}, inline_todo_markers=${todos.length}, strict=${strict.length} ──`);
console.log(`── staff-tenant-scope: ${pass} passed, ${fail} failed ──`);

if (fail === 0) {
  console.log('verify:staff-tenant-scope — PASSED (all hotspots classified; strict mirleft/lawave clean)');
}
process.exit(fail ? 1 : 0);
