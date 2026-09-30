'use strict';
// Actual HTTP functions/services, synthetic SELECT-only DB; no listener or live calls.
const assert = require('node:assert/strict');
const { actualApiFunction, httpDeps, bookingBody, policyItems } = require('./verify-package-minimum-transport');
const availability = require('./lib/luna-front-desk-accommodation-availability-service');
const create = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { loadConfig } = require('./lib/wolfhouse-quote-calculator');
const { resolveBusinessVertical, invokeVerticalOperation } = require('./lib/luna-front-desk-business-vertical');
const body = bookingBody({ check_out: '2026-07-05', room_preference: 'mixed', selected_bed_codes: ['R1-B1'] });
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function pgPolicy(minimum, outage = false) {
  const queries = [];
  const pg = { queries, minimum, async query(sql, params) {
    queries.push(String(sql));
    assert(/^\s*SELECT/i.test(sql), 'entrypoint proof forbids all writes');
    assert.equal(params[0], 'wolfhouse-somo');
    if (/FROM wh_pricing_rules/.test(sql)) return { rows: [] };
    if (/FROM wh_pricing_items/.test(sql)) {
      if (outage) throw Error('synthetic policy outage');
      return { rows: policyItems(pg.minimum) };
    }
    if (/FROM rooms r/.test(sql)) return { rows: [{ room_id: 'offline-room', room_code: 'R1', room_type: 'mixed', capacity: 4,
      gender_strategy: 'mixed', bed_code: 'R1-B1', bed_active: true, bed_sellable: true, bed_number: 1 }] };
    if (/FROM booking_beds bb/.test(sql)) return { rows: [] };
    throw Error('Unexpected SQL: ' + sql);
  } };
  return pg;
}
async function httpAvailability(pg, requestBody = body) {
  let response;
  const fn = actualApiFunction('handleBotAvailabilityCheck', {
    ...httpDeps(requestBody), ...availability, ...require('./lib/staff-bot-request-tenant-bind'),
    sendJSON: (_res, status, payload) => { response = { status, body: payload }; },
    withPgClient: fn => fn(pg), appendAuditLog: () => {}, STAFF_AUTH_REQUIRED: false,
    console: { log() {}, error() {} },
  });
  await fn({}, {}, null, 'offline');
  return response;
}

test('ordinary availability agrees at below/equal/above, outage, invalid and mixed-party boundaries', async () => {
  for (const minimum of [3, 4, 5, 10, null]) {
    const pg = pgPolicy(minimum);
    const result = await httpAvailability(pg, { ...body, quote_config: { package_min_nights: 1 } });
    assert.equal(result.status, 200);
    assert.equal(result.body.package_min_nights, minimum);
    assert.equal(result.body.package_eligible, minimum != null && minimum <= 4);
    assert.equal(result.body.date_rule_ok, minimum != null && minimum <= 4);
    assert(pg.queries.some(q => /FROM wh_pricing_items/.test(q)));
  }
  assert.equal((await httpAvailability(pgPolicy(4, true))).body.package_eligible, false);
  for (const guest_packages of [
    [{ guest_number: 1, package_code: 'package_none' }, { guest_number: 2, package_code: 'malibu' }],
    [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'package_none' }],
  ]) {
    const result = await httpAvailability(pgPolicy(5), { ...body, guest_count: 2, package_code: 'package_none', guest_packages });
    assert.equal(result.body.date_rule_ok, false);
    assert(result.body.blockers.includes('package_min_nights_violation'));
  }
});

test('ordinary vertical quote loads Admin config with SELECTs only', async () => {
  const pg = pgPolicy(4);
  const result = await invokeVerticalOperation(resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }), 'quoteOffering', pg, {
    transportBody: body,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.body.quote.success, true);
  assert.equal(result.body.quote.package_min_nights, 4);
});

test('vertical availability preserves explicitly supplied trusted config', async () => {
  const result = await invokeVerticalOperation(resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }), 'checkAvailability', pgPolicy(10), {
    transportBody: body, config: { ...loadConfig(), package_min_nights: 4 },
  });
  assert.equal(result.body.date_rule_ok, true);
  assert.equal(result.body.package_min_nights, 4);
});

test('eligible four-night create commands and precommit rechecks agree for both channels', async () => {
  for (const channel of Object.values(create.BOOKING_CREATE_CHANNELS)) {
    const pg = pgPolicy(4);
    const built = await create.buildWolfhouseBookingCreateCommand({
      channel, trustedClientSlug: 'wolfhouse-somo', transportBody: body,
      quoteConfig: { ...loadConfig(), package_min_nights: 4 }, pgClient: pg,
    });
    assert.equal(built.ok, true, JSON.stringify(built));
    assert.equal(built.command.quote.success, true);
    const checked = await availability.validateAvailabilityProvenanceForCreate(pg, built.command, built.command.availabilityProvenance);
    assert.equal(checked.ok, true);
    pg.minimum = 10;
    const rejected = await availability.validateAvailabilityProvenanceForCreate(pg, built.command, built.command.availabilityProvenance);
    assert.equal(rejected.ok, false, 'new policy blocks commit even if inventory did not change');
  }
});

test('manual create without provenance blocks a newly raised minimum before any write', async () => {
  const pg = pgPolicy(10);
  const built = await create.buildWolfhouseBookingCreateCommand({
    channel: 'manual_staff', trustedClientSlug: 'wolfhouse-somo', transportBody: body,
    quoteConfig: { ...loadConfig(), package_min_nights: 4 },
  });
  assert.equal(built.ok, true);
  assert.equal(built.command.availabilityProvenance, null);
  const result = await create.executeWolfhouseBookingCreate(pg, built.command);
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'package_min_nights_violation');
  assert.equal(result.body.package_min_nights, 10);
  assert.equal(result.body.next_action, 'offer_accommodation_or_change_dates');
});

test('vertical create dry-run keeps supplied policy and never accepts transport config', async () => {
  const result = await invokeVerticalOperation(resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }), 'createBooking', null, {
    channel: 'manual_staff', transportBody: { ...body, dry_run: true, quote_config: { package_min_nights: 1 } },
    config: { ...loadConfig(), package_min_nights: 10 },
  });
  assert.equal(result.body.booking_preview.quote.success, false);
  assert.equal(result.body.booking_preview.quote.package_min_nights, 10);
});

test('HTTP package and booking previews use SELECT-only loader at an eligible lower minimum', async () => {
  const t = require('./verify-package-minimum-transport');
  for (const run of [pg => t.packagePreview(pg, 4), pg => t.bookingPreview(pg, body)]) {
    const pg = pgPolicy(4);
    const out = await run(pg);
    assert(pg.queries.every(q => /^\s*SELECT\b/i.test(q)), 'HTTP preview attempted non-SELECT');
    assert(pg.queries.some(q => /FROM wh_pricing_items/.test(q)), 'must read saved policy');
    assert.equal(out.status, 200);
    if (out.body.quote) assert.equal(out.body.quote.success, true);
    else assert.equal(out.body.package_eligible, true);
  }
});

test('actual HTTP create dry-run uses SELECT-only loader without attempting commit', async () => {
  const t = require('./verify-package-minimum-transport');
  for (const minimum of [4, 10]) {
    const pg = pgPolicy(minimum);
    const fn = actualApiFunction('handleBotBookingCreate', {
      ...httpDeps({ ...body, dry_run: true, quote_config: { package_min_nights: 1 } }),
      ...create, ...require('./lib/staff-bot-request-tenant-bind'),
      withPgClient: fn => fn(pg), loadWolfhouseQuoteConfigWithOverlay: t.loader(pg),
      executeWolfhouseBookingCreate: () => { throw Error('dry-run must never commit'); },
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: false, appendAuditLog: () => {},
    });
    const out = await fn({}, {}, null, 'offline');
    assert(pg.queries.every(q => /^\s*SELECT\b/i.test(q)), 'HTTP dry-run attempted non-SELECT');
    assert(pg.queries.some(q => /FROM wh_pricing_items/.test(q)), 'must read saved policy');
    assert.equal(out.body.booking_preview.quote.package_min_nights, minimum);
    assert.equal(out.body.booking_preview.quote.success, minimum === 4);
  }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log('PASS ' + name); }
    catch (err) { failed++; console.error('FAIL ' + name + '\n' + err.stack); }
  }
  console.log(`${tests.length - failed}/${tests.length} entrypoint checks passed`);
  process.exitCode = failed ? 1 : 0;
})();
