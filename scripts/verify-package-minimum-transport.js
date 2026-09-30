'use strict';

// Offline actual-handler proof: never starts the Staff API or connects to a DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const apiPath = path.join(__dirname, 'staff-query-api.js');
const apiSource = fs.readFileSync(apiPath, 'utf8');
const calculator = require('./lib/wolfhouse-quote-calculator');
const pricingStore = require('./lib/wolfhouse-pricing-store');
const pricingResolve = require('./lib/wolfhouse-pricing-resolve');
const tests = [];
function test(name, run) { tests.push({ name, run }); }

// Named top-level functions, evaluated verbatim in an explicit dependency sandbox.
// No top-level Staff API initialization, HTTP listeners, credentials or network.
function actualApiFunction(name, deps) {
  const asyncStart = apiSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : apiSource.indexOf(`function ${name}(`);
  assert(start >= 0, `actual handler ${name} exists`);
  const end = apiSource.indexOf('\n}', start) + 2;
  assert(end > start, `actual handler ${name} terminates`);
  return vm.runInNewContext(`(${apiSource.slice(start, end)})`, {
    console, Date, Buffer, Set, Map, require: createRequire(apiPath), ...deps,
  }, { filename: `staff-query-api.js:${name}` });
}
function syntheticPricingPg({ items = [], error = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      assert(/^\s*SELECT\b/i.test(sql), 'transport proof forbids all writes including DDL');
      if (error) throw new Error('synthetic overlay lookup unavailable');
      if (/FROM wh_pricing_rules/.test(sql)) {
        assert.deepEqual(params, ['wolfhouse-somo']);
        return { rows: [] };
      }
      if (/FROM wh_pricing_items/.test(sql)) {
        assert.deepEqual(params, ['wolfhouse-somo']);
        return { rows: items };
      }
      throw new Error(`Unexpected synthetic SQL: ${sql}`);
    },
  };
}
function loader(pg) {
  return actualApiFunction('loadWolfhouseQuoteConfigWithOverlay', {
    loadConfig: calculator.loadConfig,
    withPgClient: (fn) => fn(pg),
    wolfhousePricingStore: pricingStore,
    applyOverlayRentalPricesToConfig: pricingResolve.applyOverlayRentalPricesToConfig,
    applyOverlayPackageItemsToConfig: pricingResolve.applyOverlayPackageItemsToConfig,
  });
}

test('overlay outage fails closed without discarding fallback prices', async () => {
  const config = await loader(syntheticPricingPg({ error: true }))();
  assert.equal(config.package_min_nights, null, 'never silently reuse seeded eligibility on overlay failure');
  assert.deepEqual(config.packages, calculator.loadConfig().packages);
});

function policyItems(value) {
  return [{ item_type: 'policy', item_code: 'package_min_nights', metadata: { minimum_nights: value }, active: true }];
}
function httpDeps(body) {
  return {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    readBody: async () => JSON.stringify(body),
    sendJSON: (_res, status, payload) => ({ status, body: payload }),
    send400: (_res, error) => ({ status: 400, body: { success: false, error } }),
  };
}
async function packagePreview(pg, nights = 7) {
  const route = actualApiFunction('handleBotPackagePricePreview', {
    ...httpDeps({ check_in: '2026-07-01', check_out: `2026-07-${String(nights + 1).padStart(2, '0')}`, guest_count: 1 }),
    _handleBotPackagePricePreview: require('./lib/staff-bot-v2-routes').handleBotPackagePricePreview,
    loadWolfhouseQuoteConfigWithOverlay: loader(pg),
  });
  return route({}, {}, null, 'offline');
}

test('normal package preview uses SQL-backed admin policy and propagates eligibility', async () => {
  const pg = syntheticPricingPg({ items: policyItems(10) });
  const response = await packagePreview(pg);
  assert.equal(response.status, 200);
  assert.equal(response.body.package_min_nights, 10);
  assert.equal(response.body.package_eligible, false);
  assert.equal(Object.values(response.body.packages).some((p) => p.success === true), false);
  assert(pg.queries.some((q) => /FROM wh_pricing_items/.test(q.sql)), 'actual route must read policy SQL');
});

function bookingBody(overrides = {}) {
  return {
    check_in: '2026-07-01', check_out: '2026-07-08', guest_count: 1,
    package_code: 'malibu', room_type: 'shared', payment_choice: 'deposit',
    guest_name: 'Offline Guest', phone: '+34000000000', confirm: true,
    selected_bed_codes: ['R1-B1'], ...overrides,
  };
}
async function bookingPreview(pg, body) {
  const normalizer = require('./lib/bot-booking-package-normalize');
  const route = actualApiFunction('handleBotBookingPreview', {
    ...httpDeps(body), ...normalizer,
    ...require('./lib/wolfhouse-package-night-rules'),
    ...require('./lib/staff-manual-booking-payment'),
    ...require('./lib/wolfhouse-room-options'),
    ...require('./lib/guest-addon-pricing'),
    ...require('./lib/bot-quote-included-items'),
    ...require('./lib/staff-bot-request-tenant-bind'),
    calculateWolfhouseQuote: calculator.calculateWolfhouseQuote,
    normalizeBotGuestPackagesForQuote: actualApiFunction('normalizeBotGuestPackagesForQuote', normalizer),
    loadWolfhouseQuoteConfigWithOverlay: loader(pg),
    STAFF_AUTH_REQUIRED: false,
    BOT_BOOKING_REQUIRED_FIELDS: [], BOT_FIELD_LABELS: {},
    appendAuditLog: () => {},
  });
  return route({}, {}, null, 'offline');
}

test('booking preview rejects admin-disqualified packages with configured copy', async () => {
  const out = await bookingPreview(syntheticPricingPg({ items: policyItems(10) }), bookingBody());
  assert.equal(out.body.next_action, 'package_not_available_for_dates');
  assert.equal(out.body.package_night_rule.package_min_nights, 10);
  assert.match(out.body.reply_draft, /10-night/);
  assert.doesNotMatch(out.body.reply_draft, /7-night/);
});

test('create validates configured minimum before any availability or write SQL', async () => {
  const { buildWolfhouseBookingCreateCommand, BOOKING_CREATE_CHANNELS } = require('./lib/luna-front-desk-accommodation-booking-create-service');
  for (const channel of Object.values(BOOKING_CREATE_CHANNELS)) {
    const config = await loader(syntheticPricingPg({ items: policyItems(10) }))();
    const result = await buildWolfhouseBookingCreateCommand({
      channel, trustedClientSlug: 'wolfhouse-somo',
      transportBody: bookingBody({ payment_choice: channel === 'manual_staff' ? 'no_payment_yet' : 'deposit' }),
      actorHints: { staff_role: 'operator' }, quoteConfig: config,
      pgClient: { query: async () => { throw new Error('eligibility must precede all booking SQL'); } },
    });
    assert.equal(result.ok, false, channel);
    assert.equal(result.body.reason_code, 'package_min_nights_violation', channel);
    assert.match(result.body.error, /10-night/, channel);
  }
});

test('vertical create cannot bypass DB policy when caller omits quote config', async () => {
  const { resolveBusinessVertical, invokeVerticalOperation } = require('./lib/luna-front-desk-business-vertical');
  const pg = syntheticPricingPg({ items: policyItems(10) });
  const result = await invokeVerticalOperation(resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }), 'createBooking', pg, {
    channel: 'manual_staff', actorHints: { staff_role: 'operator' },
    transportBody: bookingBody({ payment_choice: 'no_payment_yet' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'package_min_nights_violation');
  assert.match(result.body.error, /10-night/);
  assert(pg.queries.some((q) => /FROM wh_pricing_items/.test(q.sql)));
});

test('vertical quote and catalog load DB policy rather than seeded eligibility', async () => {
  const { resolveBusinessVertical, invokeVerticalOperation } = require('./lib/luna-front-desk-business-vertical');
  const resolved = resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' });
  const catalog = await invokeVerticalOperation(resolved, 'listOfferings', syntheticPricingPg({ items: policyItems(10) }), {
    channel: 'luna_whatsapp', transportBody: bookingBody(),
  });
  assert.equal(catalog.body.package_min_nights, 10);
  assert.equal(catalog.body.package_eligible, false);
  const quote = await invokeVerticalOperation(resolved, 'quoteOffering', syntheticPricingPg({ items: policyItems(10) }), {
    channel: 'luna_whatsapp', transportBody: bookingBody(),
  });
  assert.equal(quote.ok, false);
  assert.equal(quote.body.package_night_violation.package_min_nights, 10);
});

test('create without any effective config or DB cannot silently reuse seed minimum', async () => {
  const { buildWolfhouseBookingCreateCommand } = require('./lib/luna-front-desk-accommodation-booking-create-service');
  const result = await buildWolfhouseBookingCreateCommand({
    channel: 'manual_staff', trustedClientSlug: 'wolfhouse-somo',
    transportBody: bookingBody({ payment_choice: 'no_payment_yet' }),
    actorHints: { staff_role: 'operator' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.body.reason_code, 'package_min_nights_configuration_invalid');
});

test('vertical date evaluation respects supplied effective policy', async () => {
  const { resolveBusinessVertical, invokeVerticalOperation } = require('./lib/luna-front-desk-business-vertical');
  const result = await invokeVerticalOperation(resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }), 'evaluateDates', null, {
    channel: 'luna_whatsapp', transportBody: bookingBody(),
    config: { ...calculator.loadConfig(), package_min_nights: 10 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.package_min_nights, 10);
});

async function createFromPlan(pg, body = bookingBody(), overrides = {}) {
  const sendJSON = (res, status, payload) => {
    if (res.end) { res.writeHead(status); res.end(JSON.stringify(payload)); }
    return { status, body: payload };
  };
  const deps = {
    ...httpDeps(body), sendJSON,
    send400: (res, error) => sendJSON(res, 400, { success: false, error }),
    ...require('./lib/staff-bot-request-tenant-bind'),
    ...require('./lib/luna-front-desk-accommodation-booking-create-service'),
    withPgClient: (fn) => fn(pg),
    loadWolfhouseQuoteConfigWithOverlay: loader(pg),
    BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: false, appendAuditLog: () => {},
    ...overrides,
  };
  const route = actualApiFunction('handleBotBookingCreateFromPlan', {
    ...deps,
    _handleBotBookingCreateFromPlan: require('./lib/staff-bot-v2-routes').handleBotBookingCreateFromPlan,
    handleBotBookingCreate: actualApiFunction('handleBotBookingCreate', deps),
    makeInMemoryBotReq: () => { throw Error('unused transport'); },
    handlePostBookingTransfer: () => { throw Error('no transfer writes'); },
    handleBotGuestPaymentCreateLink: () => { throw Error('no payment links'); },
    STRIPE_LINKS_ENABLED: false, STRIPE_SECRET_KEY: '', process: { env: {} },
  });
  return route({}, {}, null, 'offline');
}

test('actual create-from-plan preserves policy rejection instead of missing-package escalation', async () => {
  const preview = await bookingPreview(syntheticPricingPg({ items: policyItems(4) }), bookingBody());
  assert.equal(preview.body.quote.success, true);
  const pg = syntheticPricingPg({ items: policyItems(10) });
  const out = await createFromPlan(pg);
  assert.equal(out.body.reason_code, 'package_min_nights_violation');
  assert.deepEqual(out.body.blocked_reasons, ['package_min_nights_violation']);
  assert.equal(out.body.package_night_violation.package_min_nights, 10);
  assert.equal(out.body.next_action, 'offer_accommodation_or_change_dates');
  assert.equal(out.body.staff_review_needed, false);
  assert.equal(out.body.write_performed, false);
});

// Run real build and commit guards; change only the authoritative data between them.
async function createAtCommitChange({ manual = false, minimumAfter = 10 } = {}) {
  const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
  let minimum = 4;
  let executions = 0;
  const pg = syntheticPricingPg();
  const pricingQuery = pg.query.bind(pg);
  pg.query = async (sql, params) => {
    if (/FROM wh_pricing_items/.test(sql)) {
      pg.queries.push({ sql, params });
      return { rows: policyItems(minimum) };
    }
    if (/FROM rooms r/.test(sql)) {
      pg.queries.push({ sql, params });
      return { rows: [{ room_id: 'offline-room', room_code: 'R1', room_type: 'mixed',
        capacity: 4, gender_strategy: 'mixed', bed_code: 'R1-B1', bed_active: true,
        bed_sellable: true, bed_number: 1 }] };
    }
    if (/FROM booking_beds bb/.test(sql)) {
      pg.queries.push({ sql, params });
      return { rows: [] };
    }
    return pricingQuery(sql, params);
  };
  const execute = async (...args) => {
    executions += 1;
    assert.equal(args[1].quote.success, true, 'command was eligible before policy changed');
    minimum = minimumAfter;
    return service.executeWolfhouseBookingCreate(...args);
  };
  const body = bookingBody({ check_out: '2026-07-05', room_preference: 'mixed',
    ...(manual ? { payment_choice: 'no_payment_yet' } : {}) });
  const response = manual
    ? await actualApiFunction('handleManualBookingCreate', {
      ...httpDeps(body), ...service, withPgClient: fn => fn(pg),
      loadWolfhouseQuoteConfigWithOverlay: loader(pg), executeWolfhouseBookingCreate: execute,
      MANUAL_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: false, appendAuditLog: () => {},
      STRIPE_LINKS_ENABLED: false, STRIPE_SECRET_KEY: '',
      stripeCheckoutRedirectUrlsConfigured: false, stripeCheckoutSessionSuccessUrl: '',
      stripeCheckoutSessionCancelUrl: '', manualBookingPrivateRoomEnabled: false,
    })({}, {}, null)
    : await createFromPlan(pg, body, { executeWolfhouseBookingCreate: execute });
  assert.equal(executions, 1, 'must reach real commit guard, not stop in build');
  return { ...response, queries: pg.queries };
}

test('commit policy changes retain structured rejection through bot bridge and manual HTTP', async () => {
  for (const manual of [false, true]) {
    for (const minimumAfter of [10, null]) {
      const out = await createAtCommitChange({ manual, minimumAfter });
      const reason = minimumAfter == null ? 'package_min_nights_configuration_invalid' : 'package_min_nights_violation';
      assert(out.queries.every(q => /^\s*SELECT\b/i.test(q.sql)), 'commit rejection must never attempt writes');
      assert.equal(out.body.reason_code, reason, JSON.stringify(out.body));
      assert.equal(out.body.package_night_violation.package_min_nights, minimumAfter);
      assert.equal(out.body.next_action, 'offer_accommodation_or_change_dates');
      assert.equal(out.body.staff_review_needed, false);
      assert.equal(out.body.write_performed, false);
      assert.equal(out.body.do_not_escalate, true);
      assert.doesNotMatch(out.body.error || '', /undefined/);
      if (minimumAfter != null) assert.match(out.body.reply_draft, /10 nights/);
    }
  }
});

module.exports = { actualApiFunction, bookingPreview, bookingBody, syntheticPricingPg, policyItems, httpDeps, loader, createFromPlan, createAtCommitChange, packagePreview };

if (require.main === module) (async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed += 1; console.error(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} offline transport tests passed; no live calls`);
  process.exitCode = failed ? 1 : 0;
})();
