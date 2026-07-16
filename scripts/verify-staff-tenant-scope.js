'use strict';

/**
 * Staff API tenant/session scope guard (read-only).
 *
 * 1) Static SQL scan for tenant-sensitive tables without obvious client scope.
 * 2) Match every hotspot against fingerprint-keyed debt registry (schema v2).
 * 3) Staff portal session-scoped client helpers.
 * 4) /staff/auth/session handler uses session-scoped helpers when auth required.
 *
 * Exit 0 when all hotspots are classified and strict mirleft/lawave scope is clean.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getSessionScopedClients,
  buildSessionClientProfilesMap,
  getAccessibleClients,
  buildClientProfilesMap,
  listBaselineClients,
} = require('./lib/staff-portal-clients');

const {
  scanSqlScopeDebt,
  scanTextDebt,
  windowTextForHit,
  loadScopeDebtRegistry,
  classifyDebtHotspots,
  summarizeClassification,
  assertDraftPaymentLinkClientScope,
  assertBalancePaymentLinkClientScope,
  findDuplicateScanFingerprints,
} = require('./lib/staff-tenant-scope-hotspot');

const REPO_ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(__dirname, 'staff-query-api.js');
const MANUAL_BOOKING_PAYMENT_PATH = path.join(__dirname, 'lib', 'staff-manual-booking-payment.js');
const ACCOMMODATION_BOOKING_CREATE_PATH = path.join(__dirname, 'lib', 'luna-front-desk-accommodation-booking-create-service.js');
const PAYMENT_LINK_SERVICE_PATH = path.join(__dirname, 'lib', 'luna-front-desk-payment-link-service.js');
const SUNSET_ACCESS_PATH = path.join(REPO_ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json');
const REGISTRY_PATH = path.join(__dirname, 'fixtures', 'staff-tenant-scope-debt-registry.json');

const DEBT_SHOW_MAX = 40;
const TOP_LIVE_FIX_MAX = 10;
const MIRLEFT_LAWAVE = /\b(mirleft|lawave)\b/i;
const GRANDFATHER_OK = /MULTICLIENT_SCOPE_OK:/;

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

function withTempJsonFile(label, payload, runFn) {
  const tmpPath = path.join(os.tmpdir(), `wh-staff-tenant-scope-${process.pid}-${label}.json`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload));
    return runFn(tmpPath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

function runRegistrySelfTests() {
  console.log('\n── Registry identity self-tests ──');

  const baseSql = "await pg.query(`UPDATE payments SET status = 'paid' WHERE id = $1`);";
  const v1Text = `'use strict';\nasync function applyPaid(pg) {\n${baseSql}\n}\n`;
  const v2Text = `'use strict';\n// unrelated inserted line\nasync function applyPaid(pg) {\n${baseSql}\n}\n`;
  const rel = 'scripts/lib/_selftest-tenant-scope.js';

  const hitsV1 = scanTextDebt(REPO_ROOT, rel, v1Text);
  const hitsV2 = scanTextDebt(REPO_ROOT, rel, v2Text);
  ok('S1 unrelated line insertion preserves fingerprint', hitsV1.length === 1 && hitsV2.length === 1
    && hitsV1[0].fingerprint === hitsV2[0].fingerprint,
  `v1=${hitsV1[0] && hitsV1[0].fingerprint} v2=${hitsV2[0] && hitsV2[0].fingerprint}`);

  const movedSql = `'use strict';\n\n\nasync function applyPaid(pg) {\n${baseSql}\n}\n`;
  const hitsMoved = scanTextDebt(REPO_ROOT, rel, movedSql);
  ok('S2 moving SQL within file preserves fingerprint', hitsMoved.length === 1 && hitsV1.length === 1
    && hitsMoved[0].fingerprint === hitsV1[0].fingerprint);

  const changedSql = "await pg.query(`UPDATE bookings SET status = 'paid' WHERE id = $1`);";
  const changedText = `'use strict';\nasync function applyPaid(pg) {\n${changedSql}\n}\n`;
  const hitsChanged = scanTextDebt(REPO_ROOT, rel, changedText);
  ok('S3 table/scope change yields new fingerprint', hitsChanged.length === 1 && hitsV1.length === 1
    && hitsChanged[0].fingerprint !== hitsV1[0].fingerprint);

  const fp = hitsV1[0] && hitsV1[0].fingerprint;
  ok('S4 precheck self-test hotspot found', Boolean(fp));
  if (!fp) return;
  const fakeRegistry = {
    schema_version: 2,
    entries: [
      {
        fingerprint: fp,
        file: rel,
        line: 2,
        table: 'payments',
        operation: 'UPDATE',
        owner: 'applyPaid',
        id: 'selftest-entry',
        status: 'ok',
        risk: 'false_positive',
        reason: 'self-test fixture',
      },
      {
        fingerprint: 'deadbeefdeadbeef',
        file: rel,
        line: 99,
        table: 'payments',
        operation: 'UPDATE',
        owner: 'removed',
        id: 'stale-entry',
        status: 'ok',
        risk: 'false_positive',
        reason: 'stale',
      },
    ],
  };
  withTempJsonFile('registry', fakeRegistry, (tmpRegistry) => {
    const loaded = loadScopeDebtRegistry(tmpRegistry);
    const { unclassified, stale } = classifyDebtHotspots(hitsV2, loaded.byFingerprint);
    ok('S4 deleted hotspot surfaces stale registry entry', stale.length === 1 && stale[0].id === 'stale-entry');
    ok('S4b moved hotspot still classifies by fingerprint', unclassified.length === 0);
  });

  let dupThrew = false;
  try {
    withTempJsonFile('dup-registry', (() => {
      const real = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      real.entries.push({ ...real.entries[0], id: 'dup-copy' });
      return real;
    })(), (dupPath) => {
      loadScopeDebtRegistry(dupPath);
    });
  } catch (e) {
    dupThrew = /duplicate registry fingerprint/i.test(e.message);
  }
  ok('S5 duplicate registry fingerprints fail closed', dupThrew);

  const dupText = `'use strict';\nasync function applyPaid(pg) {\n${baseSql}\n${baseSql}\n}\n`;
  const dupHits = scanTextDebt(REPO_ROOT, rel, dupText);
  const scanDups = findDuplicateScanFingerprints(dupHits);
  ok('S7 duplicate scanned hotspots share fingerprint (negative fixture)', scanDups.length === 1 && scanDups[0].count === 2);

  const paymentLinkSrc = fs.readFileSync(PAYMENT_LINK_SERVICE_PATH, 'utf8');
  ok('S6a createDraftPaymentStripeLink scoped', assertDraftPaymentLinkClientScope(paymentLinkSrc));
  ok('S6b createBookingBalancePaymentLink scoped', assertBalancePaymentLinkClientScope(paymentLinkSrc));
  const brokenDraft = paymentLinkSrc.replace(
    /(async function createDraftPaymentStripeLink[\s\S]*?WHERE id = \$5::uuid) AND client_id = \$6/,
    '$1',
  );
  ok('S6c draft fails independently when client_id removed',
    !assertDraftPaymentLinkClientScope(brokenDraft) && assertBalancePaymentLinkClientScope(brokenDraft));
  const brokenBalance = paymentLinkSrc.replace(
    /(async function createBookingBalancePaymentLink[\s\S]*?WHERE id = \$5::uuid) AND client_id = \$6/,
    '$1',
  );
  ok('S6d balance fails independently when client_id removed',
    assertDraftPaymentLinkClientScope(brokenBalance) && !assertBalancePaymentLinkClientScope(brokenBalance));
}

console.log('verify:staff-tenant-scope — Staff API tenant/session guardrails\n');

let registry;
try {
  registry = loadScopeDebtRegistry(REGISTRY_PATH);
} catch (err) {
  console.error(`  FAIL  could not load debt registry: ${err.message}`);
  process.exit(1);
}

ok('R1 registry schema v2 fingerprint identity', registry.meta.schema_version === 2
  && registry.meta.identity_model === 'fingerprint:v1');

// ── B. Portal session client scoping ────────────────────────────────────────
console.log('\n── Portal session client scoping ──');

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
const manualBookingPaymentSource = fs.readFileSync(MANUAL_BOOKING_PAYMENT_PATH, 'utf8');
const accommodationCreateSource = fs.readFileSync(ACCOMMODATION_BOOKING_CREATE_PATH, 'utf8');
const paymentLinkServiceSource = fs.readFileSync(PAYMENT_LINK_SERVICE_PATH, 'utf8');
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
  ((fs.readFileSync(path.join(__dirname, 'lib', 'stripe-hold-promote-policy.js'), 'utf8')
    .match(/WHERE id = \$4\s+AND client_id = \$5/g) || []).length >= 1)
  && ((staffApiSource.match(/WHERE id = \$4\s+AND client_id = \$5/g) || []).length >= 1));
ok('E6a createDraftPaymentStripeLink UPDATE includes client_id predicate',
  assertDraftPaymentLinkClientScope(paymentLinkServiceSource));
ok('E6b createBookingBalancePaymentLink UPDATE includes client_id predicate',
  assertBalancePaymentLinkClientScope(paymentLinkServiceSource));

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
  /bot_source:[\s\S]*UPDATE bookings[\s\S]*total_amount_cents[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$7/.test(accommodationCreateSource));
ok('G3 manualBookingApplyStaffPaymentChoice paid booking UPDATE scoped',
  /async function manualBookingApplyStaffPaymentChoice[\s\S]*UPDATE bookings[\s\S]*amount_paid_cents = \$1[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$5/.test(manualBookingPaymentSource));
ok('G4 manualBookingApplyStaffPaymentChoice waiting_payment UPDATEs scoped',
  (manualBookingPaymentSource.match(/SET payment_status = 'waiting_payment'::payment_status[\s\S]*?AND client_id = \(SELECT id FROM clients WHERE slug = \$2/g) || []).length >= 2);
ok('G5 manual booking create quote UPDATE scoped by clientSlug',
  /quote_snapshot:[\s\S]*paid_amount_type:[\s\S]*UPDATE bookings[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$7/.test(accommodationCreateSource));
ok('G6 manual booking private room preference UPDATE scoped',
  /room_preference = 'couple_private'[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$2/.test(accommodationCreateSource));
ok('G7 staff calendar bed block UPDATE scoped by clientSlug',
  /intent: 'api:calendar_bed_block_create'[\s\S]*UPDATE bookings[\s\S]*AND client_id = \(SELECT id FROM clients WHERE slug = \$3[\s\S]*block_type: 'bed_selection'/.test(staffApiSource));
ok('G8 no unscoped booking UPDATE by id in must-fix helper paths',
  !/manualBookingApplyStaffPaymentChoice[\s\S]*UPDATE bookings SET payment_status = 'waiting_payment'::payment_status WHERE id = \$1::uuid`,\s*\[bookingId\],/.test(manualBookingPaymentSource));

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

runRegistrySelfTests();

// ── A. SQL scope debt scan + registry classification ─────────────────────────
console.log('\n── SQL tenant scope scan (debt registry) ──');

const { debt, todos } = scanSqlScopeDebt(REPO_ROOT);
const scanFingerprintDups = findDuplicateScanFingerprints(debt);
const strict = debt.filter((hit) => {
  const win = windowTextForHit(REPO_ROOT, hit);
  return MIRLEFT_LAWAVE.test(win) && !GRANDFATHER_OK.test(win);
});
const { unclassified, classified, stale } = classifyDebtHotspots(debt, registry.byFingerprint);
const { byStatus, byRisk, todoItems } = summarizeClassification(classified);

ok('A0 scanned hotspots have unique fingerprints', scanFingerprintDups.length === 0, scanFingerprintDups.length
  ? scanFingerprintDups.map((d) => `${d.fingerprint} x${d.count} (${d.hits.map((h) => `${h.rel}:${h.line}`).join(', ')})`).join('; ')
  : null);

ok('A1 every scanned hotspot is classified in debt registry', unclassified.length === 0, unclassified.length
  ? unclassified.map((h) => `${h.fingerprint} ${h.rel}:${h.line} [${h.table}]`).join('; ')
  : null);

ok('A2 registry has no stale entries (removed hotspots)', stale.length === 0, stale.length
  ? stale.map((e) => `${e.fingerprint} ${e.file}:${e.line}`).join('; ')
  : null);

const openTodo = todoItems.filter(({ entry }) => entry.status === 'todo');
if (openTodo.length > 0) {
  console.log(`\n  INFO  ${openTodo.length} classified todo hotspot(s):`);
  const shown = openTodo.slice(0, DEBT_SHOW_MAX);
  for (const { hit, entry } of shown) {
    console.log(`    ${hit.fingerprint} ${hit.rel}:${hit.line}  [${hit.table}]  risk=${entry.risk}`);
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
    console.log(`    ${hit.fingerprint} ${hit.rel}:${hit.line} [${hit.table}]`);
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
