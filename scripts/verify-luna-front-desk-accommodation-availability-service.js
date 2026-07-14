'use strict';

/**
 * verify:luna-front-desk-accommodation-availability-service
 *
 * RED → GREEN gate for Wolfhouse accommodation availability service.
 *
 * Run:
 *   node scripts/verify-luna-front-desk-accommodation-availability-service.js
 */

const {
  AVAILABILITY_CHANNELS,
  AVAILABILITY_PROVENANCE_VERSION,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  mapBotHttpAvailabilityResponse,
  validateAvailabilityProvenanceForCreate,
  computeAvailabilityFingerprint,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const {
  BOOKING_CREATE_CHANNELS,
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { accommodationVerticalAdapter } = require('./lib/verticals/accommodation-vertical-adapter');
const { resolveBusinessVertical, VERTICAL_IDS } = require('./lib/luna-front-desk-business-vertical');
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
const SHORT_OUT = '2026-07-09';
const CLOSED_IN = '2026-01-10';
const CLOSED_OUT = '2026-01-17';

function wolfhouseResolved() {
  return resolveBusinessVertical({ clientSlug: WOLFHOUSE_CLIENT_SLUG });
}

function makePg(opts = {}) {
  const beds = opts.beds || GOLDEN_BED_ROWS;
  const blocks = opts.blocks || [];
  const inserts = [];
  let writeCount = 0;
  let committed = false;
  let rolledBack = false;
  return {
    inserts,
    writeCount: () => writeCount,
    committed: () => committed,
    rolledBack: () => rolledBack,
    query: async (sql, params) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim();
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) { committed = true; return { rows: [] }; }
      if (/^ROLLBACK/i.test(s)) { rolledBack = true; return { rows: [] }; }
      if (/inserted_booking_beds|is_duplicate|is_blocked|beds_inserted/i.test(s)) {
        if (opts.blocked === 'overlap_conflict') {
          return {
            rows: [{
              is_duplicate: false,
              is_blocked: true,
              block_reason: 'overlap_conflict',
              booking_id: null,
              beds_inserted: 0,
            }],
          };
        }
        if (opts.idempotencyDuplicate) {
          return {
            rows: [{
              is_duplicate: true,
              is_blocked: false,
              booking_id: 'dup-1',
              booking_code: 'WH-DUP',
              beds_inserted: 0,
            }],
          };
        }
        const bedCount = Array.isArray(params[12]) ? params[12].length : 1;
        inserts.push({ table: 'bookings', params: [...params] });
        return {
          rows: [{
            is_duplicate: false,
            is_blocked: false,
            booking_id: 'avail-booking-1',
            booking_code: 'WH-AVAIL-01',
            beds_inserted: bedCount,
            payments_inserted: 1,
            audit_event_id: 'audit-avail-1',
          }],
        };
      }
      if (/INSERT|UPDATE|DELETE/i.test(s) && !/SELECT/i.test(s)) {
        writeCount += 1;
        inserts.push({ sql: s.slice(0, 60) });
        return { rows: [{ id: 'write-blocked' }] };
      }
      if (norm.includes('FROM rooms r') && norm.includes('LEFT JOIN beds bd')) {
        return { rows: beds };
      }
      if (norm.includes('FROM booking_beds bb') && norm.includes('assignment_start_date')) {
        if (opts.blocksByCall && opts.blocksByCall.length) {
          const idx = opts.blocksByCall.shift();
          return { rows: blocks[idx] || blocks };
        }
        return { rows: blocks };
      }
      if (/UPDATE bookings/i.test(s)) {
        inserts.push({ table: 'bookings_update', params: [...params] });
        return { rows: [] };
      }
      if (/UPDATE payments/i.test(s)) return { rows: [{ payment_id: 'pay-1' }] };
      if (/FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-wh-1' }] };
      if (/SELECT client_id FROM bookings/i.test(s)) return { rows: [{ client_id: 'client-wh-1' }] };
      if (/FROM booking_beds/i.test(s) && /WHERE booking_id/i.test(s)) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1' }] };
      }
      if (/information_schema|to_regclass/i.test(s)) return { rows: [{ reg: 'booking_service_records' }] };
      return { rows: [] };
    },
  };
}

function coreFields(body) {
  return {
    has_enough_beds: body.has_enough_beds,
    available_count: body.available_count,
    selected_bed_codes: body.selected_bed_codes,
    blockers: body.blockers,
    warnings: body.warnings,
    occupied_count: body.occupied_count,
  };
}

async function runRouteStyle(pg, transportBody) {
  const built = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody,
    demoCalendarEnrichment: true,
    assignmentMode: false,
  });
  const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
  return mapBotHttpAvailabilityResponse(result.body, { authMode: 'bot_token', clientSlug: WOLFHOUSE_CLIENT_SLUG, elapsedMs: 1 });
}

async function run() {
  console.log('\nverify:luna-front-desk-accommodation-availability-service\n');
  const wh = wolfhouseResolved();
  const pg = makePg();

  console.log('[A] Command normalization');
  const built = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 2, room_type: 'shared' },
  });
  assert('command builds', built.ok === true);
  assert('provenance version constant', AVAILABILITY_PROVENANCE_VERSION === 1);

  const tenantReject = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { client_slug: 'sunset', check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 1 },
  });
  assert('tenant override rejected', tenantReject.ok === false && tenantReject.body.reason_code === 'tenant_mismatch');

  const surfReject = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.VERTICAL_ADAPTER,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { offering_id: 'x', check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 1 },
  });
  assert('surf-school fields rejected', surfReject.body.reason === 'surf_school_fields_not_supported');

  console.log('\n[B] Route vs adapter canonical parity');
  const transport = { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 2, room_type: 'shared' };
  const routeBody = await runRouteStyle(pg, transport);
  const adapterAvail = await accommodationVerticalAdapter.checkAvailability(pg, {
    resolved: wh,
    transportBody: transport,
  });
  assert('adapter ok', adapterAvail.ok === true);
  assert('has_enough_beds parity', routeBody.has_enough_beds === adapterAvail.body.has_enough_beds);
  assert('selected_bed_codes parity', JSON.stringify(routeBody.selected_bed_codes) === JSON.stringify(adapterAvail.body.selected_bed_codes));
  assert('available_count parity', routeBody.available_count === adapterAvail.body.available_count);
  assert('blockers parity', JSON.stringify(routeBody.blockers) === JSON.stringify(adapterAvail.body.blockers));
  assert('provenance fingerprint parity', routeBody.provenance.availability_fingerprint === adapterAvail.body.provenance.availability_fingerprint);

  console.log('\n[C] Valid dates and guest count');
  const valid = await executeWolfhouseAvailabilityCheck(pg, built.command);
  assert('valid dates ok', valid.ok === true);
  assert('has enough beds golden', valid.body.has_enough_beds === true);
  assert('provenance attached', !!valid.body.provenance.availability_fingerprint);

  console.log('\n[D] Unavailable / partial / conflict states');
  const almostFullBlocks = GOLDEN_BED_ROWS.slice(0, GOLDEN_BED_ROWS.length - 1).map((r) => ({
    bed_code: r.bed_code,
    room_code: r.room_code,
    booking_code: 'WH-FULL',
  }));
  const pgFew = makePg({ blocks: almostFullBlocks });
  const fewBuilt = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 2, room_type: 'shared' },
    demoCalendarEnrichment: false,
  });
  const fewResult = await executeWolfhouseAvailabilityCheck(pgFew, fewBuilt.command);
  assert('not enough beds', fewResult.body.has_enough_beds === false);
  assert('not_enough blocker', fewResult.body.blockers.includes('not_enough_available_beds'));

  const occupiedBlocks = [{ bed_code: 'R1-B1', room_code: 'R1', booking_code: 'WH-OCC' }];
  const pgOcc = makePg({ blocks: occupiedBlocks });
  const occBuilt = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 1, room_type: 'shared', selected_bed_codes: ['R1-B1'] },
  });
  const occResult = await executeWolfhouseAvailabilityCheck(pgOcc, occBuilt.command);
  assert('occupied reduces pool', occResult.body.available_count < valid.body.available_count);

  console.log('\n[E] Package/night and closed-season rules');
  const shortPkgBuilt = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { check_in: CHECK_IN, check_out: SHORT_OUT, guest_count: 1, package_code: 'malibu', room_type: 'shared' },
  });
  const shortPkg = await executeWolfhouseAvailabilityCheck(pg, shortPkgBuilt.command);
  assert('package min nights violation', shortPkg.body.date_rule_ok === false);
  assert('package blocker present', shortPkg.body.blockers.includes('package_min_nights_violation'));

  const closedBuilt = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: { check_in: CLOSED_IN, check_out: CLOSED_OUT, guest_count: 1, package_code: 'malibu', room_type: 'shared' },
  });
  const closedResult = await executeWolfhouseAvailabilityCheck(pg, closedBuilt.command);
  assert('closed season blocked', closedResult.body.date_rule_ok === false);
  assert('closed_season flag or blocker', closedResult.body.closed_season === true || closedResult.body.blockers.includes('closed_season'));

  console.log('\n[F] Zero writes on availability check');
  const pgWrites = makePg();
  await executeWolfhouseAvailabilityCheck(pgWrites, built.command);
  assert('availability zero writes', pgWrites.writeCount() === 0);

  console.log('\n[G] Booking preflight — unchanged availability proceeds');
  const pgCreate = makePg();
  const lunaBuilt = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: {
      confirm: true,
      check_in: CHECK_IN,
      check_out: CHECK_OUT,
      guest_count: 1,
      package_code: 'malibu',
      room_type: 'shared',
      guest_name: 'Avail Guest',
      phone: '+34600111222',
      payment_choice: 'deposit',
      selected_bed_codes: ['R1-B1'],
    },
    actorHints: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pgClient: pgCreate,
  });
  assert('booking command builds with provenance', lunaBuilt.ok === true && !!lunaBuilt.command.availabilityProvenance);
  const pgExec = makePg();
  const createOut = await executeWolfhouseBookingCreate(pgExec, lunaBuilt.command, { stripeConfig: { stripeLinksEnabled: false } });
  assert('unchanged availability creates', createOut.ok === true, JSON.stringify(createOut.body));
  assert('create committed', pgExec.committed() === true);

  console.log('\n[H] Changed availability rejected before commit');
  const pgStaleBuild = makePg();
  const staleBuilt = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: {
      confirm: true,
      check_in: CHECK_IN,
      check_out: CHECK_OUT,
      guest_count: 1,
      package_code: 'malibu',
      room_type: 'shared',
      guest_name: 'Stale Guest',
      phone: '+34600111223',
      payment_choice: 'deposit',
      selected_bed_codes: ['R1-B1'],
    },
    actorHints: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pgClient: pgStaleBuild,
  });
  assert('stale build ok', staleBuilt.ok === true);
  const pgStaleExec = makePg({ blocks: occupiedBlocks });
  const staleOut = await executeWolfhouseBookingCreate(pgStaleExec, staleBuilt.command);
  assert('stale availability blocked', staleOut.ok === false && staleOut.body._blocked === true);
  assert('stale reason availability_changed', staleOut.body.reason_code === 'availability_changed');
  assert('stale zero booking inserts', pgStaleExec.inserts.filter((i) => /is_duplicate/i.test(String(i.sql))).length === 0);

  console.log('\n[I] Write-time SQL recheck prevents overbooking');
  const pgOverlapBuild = makePg();
  const overlapBuilt = await buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.MANUAL_STAFF,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: {
      confirm: true,
      check_in: CHECK_IN,
      check_out: CHECK_OUT,
      guest_count: 1,
      package_code: 'malibu',
      room_type: 'shared',
      guest_name: 'Overlap Guest',
      phone: '+34600111224',
      payment_choice: 'no_payment_yet',
      selected_bed_codes: ['R1-B1'],
    },
    actorHints: { staff_user_id: 'staff-1', staff_role: 'operator', email: 'staff@test.com' },
    pgClient: pgOverlapBuild,
  });
  const pgOverlapExec = makePg({ blocked: 'overlap_conflict' });
  const overlapOut = await executeWolfhouseBookingCreate(pgOverlapExec, overlapBuilt.command);
  assert('sql overlap blocked', overlapOut.ok === false && overlapOut.body._blocked === true);
  assert('overlap rolled back', pgOverlapExec.rolledBack() === true);

  console.log('\n[J] Wolfhouse / Sunset isolation');
  const sunsetResolve = resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'sunset-somo' });
  assert('sunset not accommodation', sunsetResolve.verticalId === VERTICAL_IDS.SURF_SCHOOL);
  const sunsetCmd = buildWolfhouseAvailabilityCommand({
    channel: AVAILABILITY_CHANNELS.BOT_HTTP,
    trustedClientSlug: 'sunset',
    transportBody: { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 1 },
  });
  assert('sunset tenant rejected at build', sunsetCmd.ok === false);

  const provCheck = await validateAvailabilityProvenanceForCreate(pg, {
    clientSlug: WOLFHOUSE_CLIENT_SLUG,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    quoteGuestCount: 1,
    guestCount: 1,
    roomType: 'shared',
    assignedBedCodes: ['R1-B1'],
    effectivePackageCode: 'malibu',
    transportBody: {},
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
  }, {
    availability_version: AVAILABILITY_PROVENANCE_VERSION,
    availability_fingerprint: 'deadbeef',
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: 1,
  });
  assert('fingerprint mismatch detected', provCheck.ok === false && provCheck.body.reason_code === 'availability_changed');

  console.log(`\n── verify:luna-front-desk-accommodation-availability-service ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(2);
});
