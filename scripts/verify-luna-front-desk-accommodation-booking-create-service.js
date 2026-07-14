'use strict';

/**
 * verify:luna-front-desk-accommodation-booking-create-service
 *
 * RED → GREEN gate for Wolfhouse accommodation booking-create service.
 *
 * Run:
 *   node scripts/verify-luna-front-desk-accommodation-booking-create-service.js
 */

const {
  BOOKING_CREATE_CHANNELS,
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
  rejectClientSuppliedMoney,
  resolveActorForChannel,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { WOLFHOUSE_CLIENT_SLUG } = require('./lib/wolfhouse-accommodation-application');
const { GOLDEN_BED_ROWS } = require('./lib/luna-golden-offline-pg');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const CHECK_IN = '2026-07-06';
const CHECK_OUT = '2026-07-13';
const BED = 'R1-B1';

function baseTransport(overrides = {}) {
  return {
    confirm: true,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: 1,
    package_code: 'malibu',
    room_type: 'shared',
    guest_name: 'Service Guest',
    phone: '+34600111222',
    payment_choice: 'deposit',
    selected_bed_codes: ['R1-B1'],
    ...overrides,
  };
}

function manualTransport(overrides = {}) {
  return baseTransport({
    payment_choice: 'no_payment_yet',
    ...overrides,
  });
}

function makePg(opts = {}) {
  const inserts = [];
  let rolledBack = false;
  let committed = false;
  const idempotencyDuplicate = opts.idempotencyDuplicate === true;
  const blocked = opts.blocked || null;
  const safetyMismatch = opts.safetyMismatch === true;

  return {
    inserts,
    rolledBack: () => rolledBack,
    committed: () => committed,
    query: async (sql, params) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim();
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) { committed = true; return { rows: [] }; }
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/inserted_booking_beds|is_duplicate/i.test(s)) {
        if (idempotencyDuplicate) {
          return {
            rows: [{
              is_duplicate: true,
              duplicate_booking_id: 'dup-booking-1',
              duplicate_booking_code: 'WH-DUP-01',
              is_blocked: false,
              beds_inserted: 0,
            }],
          };
        }
        if (blocked) {
          return {
            rows: [{
              is_duplicate: false,
              is_blocked: true,
              block_reason: blocked,
              beds_inserted: 0,
            }],
          };
        }
        const bedCount = Array.isArray(params[12]) ? params[12].length : 1;
        const bedsInserted = safetyMismatch ? 0 : bedCount;
        inserts.push({ table: 'bookings', params: [...params] });
        return {
          rows: [{
            is_duplicate: false,
            is_blocked: false,
            booking_id: 'booking-wh-1',
            booking_code: 'WH-20260706-SVC01',
            beds_inserted: bedsInserted,
            payments_inserted: 1,
            audit_event_id: 'audit-1',
          }],
        };
      }
      if (norm.includes('FROM rooms r') && norm.includes('LEFT JOIN beds bd')) {
        return { rows: GOLDEN_BED_ROWS };
      }
      if (norm.includes('FROM booking_beds bb') && norm.includes('assignment_start_date')) {
        return { rows: opts.blocks || [] };
      }
      if (/UPDATE bookings/i.test(s)) {
        inserts.push({ table: 'bookings_update', params: [...params] });
        return { rows: [] };
      }
      if (/UPDATE payments/i.test(s)) {
        inserts.push({ table: 'payments_update', params: [...params] });
        return { rows: [{ payment_id: 'pay-wh-1' }] };
      }
      if (/SELECT client_id FROM bookings/i.test(s)) {
        return { rows: [{ client_id: 'client-wh-1' }] };
      }
      if (/FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-wh-1' }] };
      if (/FROM booking_beds/i.test(s)) {
        return { rows: [{ bed_code: BED, room_code: 'R1' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        inserts.push({ table: 'booking_service_records', params: [...params] });
        return { rows: [{ id: 'sr-1' }] };
      }
      if (/information_schema|to_regclass/i.test(s)) {
        return { rows: [{ reg: 'booking_service_records' }] };
      }
      return { rows: [] };
    },
  };
}

async function buildForChannel(channel, transportBody, extra = {}) {
  return buildWolfhouseBookingCreateCommand({
    channel,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody,
    actorHints: extra.actorHints || (channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF
      ? { staff_user_id: 'staff-1', staff_role: 'operator', email: 'staff@test.com' }
      : { staff_user_id: 'luna-bot-internal', staff_role: 'operator' }),
    pgClient: extra.pg,
  });
}

async function run() {
  console.log('\nverify:luna-front-desk-accommodation-booking-create-service\n');

  console.log('[A] Command normalization — manual vs Luna');
  const sharedPg = makePg();
  const manualBuilt = await buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, manualTransport());
  const lunaBuilt = await buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport(), { pg: sharedPg });
  assert('manual command builds', manualBuilt.ok === true);
  assert('luna command builds', lunaBuilt.ok === true, lunaBuilt.body && lunaBuilt.body.error);
  assert('both force wolfhouse tenant', manualBuilt.command.clientSlug === WOLFHOUSE_CLIENT_SLUG
    && lunaBuilt.command.clientSlug === WOLFHOUSE_CLIENT_SLUG);
  assert('manual actor email', manualBuilt.command.actor.email === 'staff@test.com');
  assert('luna actor staff id', lunaBuilt.command.actor.staff_user_id === 'luna-bot-internal');
  assert('resolveActorForChannel manual', resolveActorForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, { email: 'a@b.c' }).email === 'a@b.c');

  console.log('\n[B] Tenant mismatch + client money rejected');
  const tenantReject = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    trustedClientSlug: 'sunset',
    transportBody: manualTransport(),
  });
  assert('tenant mismatch', tenantReject.ok === false && tenantReject.body.reason_code === 'tenant_mismatch');
  const moneyReject = rejectClientSuppliedMoney({ total_cents: 50000, check_in: CHECK_IN });
  assert('client money rejected', moneyReject.ok === false && moneyReject.reason === 'client_money_rejected');
  const moneyBuild = await buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, manualTransport({ total_cents: 1 }));
  assert('build rejects client money', moneyBuild.ok === false && moneyBuild.body.reason_code === 'client_money_rejected');

  console.log('\n[C] Dry run when confirm !== true');
  const dryBuilt = await buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport({ confirm: false }), { pg: makePg() });
  assert('dry run returns body', dryBuilt.ok === true && dryBuilt.dryRun === true);
  assert('dry run safety flags', dryBuilt.body.dry_run === true && dryBuilt.body.creates_booking === false);

  console.log('\n[D] Bot vs manual success — same quote totals');
  const results = [];
  for (const [channel, transport] of [
    [BOOKING_CREATE_CHANNELS.MANUAL_STAFF, manualTransport()],
    [BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport()],
  ]) {
    const pgForBuild = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP ? makePg() : null;
    const built = await buildForChannel(channel, transport, { pg: pgForBuild });
    const pg = makePg();
    const out = await executeWolfhouseBookingCreate(pg, built.command, {
      stripeConfig: { stripeLinksEnabled: false },
    });
    results.push({ channel, built, out, pg });
    assert(`${channel} success`, out.ok === true, JSON.stringify(out.body));
    assert(`${channel} committed`, pg.committed() === true);
    assert(`${channel} quote present`, out.body.quote && out.body.quote.total_cents > 0);
  }
  assert('totals match across channels', results[0].out.body.quote.total_cents === results[1].out.body.quote.total_cents);

  console.log('\n[E] Failure paths rollback with zero booking inserts');
  const builtBlocked = await buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, manualTransport());
  const pgBlocked = makePg({ blocked: 'overlap_conflict' });
  const outBlocked = await executeWolfhouseBookingCreate(pgBlocked, builtBlocked.command);
  assert('blocked fails', outBlocked.ok === false && outBlocked.body._blocked === true);
  assert('blocked rolled back', pgBlocked.rolledBack() === true);
  assert('blocked zero booking inserts', pgBlocked.inserts.filter((i) => i.table === 'bookings').length === 0);

  const pgForSafetyBuild = makePg();
  const builtSafety = await buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport(), { pg: pgForSafetyBuild });
  const pgSafety = makePg({ safetyMismatch: true });
  const outSafety = await executeWolfhouseBookingCreate(pgSafety, builtSafety.command);
  assert('safety violation', outSafety.ok === false && outSafety.body._safety_violation === true);
  assert('safety rolled back', pgSafety.rolledBack() === true);

  console.log('\n[F] Idempotency replay');
  const builtIdem = await buildForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, manualTransport({ idempotency_key: 'idem-acc-1' }));
  const pgIdem = makePg({ idempotencyDuplicate: true });
  const outIdem = await executeWolfhouseBookingCreate(pgIdem, builtIdem.command);
  assert('idempotent ok', outIdem.ok === true && outIdem.body._duplicate === true);
  assert('idempotent no booking inserts', pgIdem.inserts.filter((i) => i.table === 'bookings').length === 0);

  console.log('\n[G] Bot channel draft payment update (no Stripe in create)');
  const botPg = makePg();
  const botPgBuild = makePg();
  const botBuilt = await buildForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, baseTransport(), { pg: botPgBuild });
  const botOut = await executeWolfhouseBookingCreate(botPg, botBuilt.command);
  assert('bot payment update', botPg.inserts.some((i) => i.table === 'payments_update'));
  assert('bot no stripe flag on outcome', botOut.ok === true && !botOut.body._pay_outcome);

  console.log(`\n── verify:luna-front-desk-accommodation-booking-create-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
