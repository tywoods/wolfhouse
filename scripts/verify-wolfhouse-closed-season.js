#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  stayHitsClosedSeason,
  findNearestOpenStay,
  analyzeClosedSeasonStay,
  findSeasonReopensOn,
  evaluateClosedSeasonStay,
  madridTodayIso,
} = require('./lib/wolfhouse-closed-season');

const TODAY = '2026-10-26';

const SEASONS = [
  {
    code: 'closed',
    bookable: false,
    active: true,
    priority: 0,
    sort_order: 9,
    ranges: [
      { start_month: 11, start_day: 1, end_month: 2, end_day: 28 },
    ],
  },
  {
    code: 'spring_autumn',
    bookable: true,
    active: true,
    priority: 0,
    sort_order: 1,
    ranges: [
      { start_month: 4, start_day: 1, end_month: 6, end_day: 30 },
      { start_month: 10, start_day: 1, end_month: 10, end_day: 31 },
    ],
  },
  {
    code: 'summer',
    bookable: true,
    active: true,
    priority: 0,
    sort_order: 2,
    ranges: [
      { start_month: 7, start_day: 1, end_month: 7, end_day: 31 },
      { start_month: 9, start_day: 1, end_month: 9, end_day: 30 },
    ],
  },
  {
    code: 'august',
    bookable: true,
    active: true,
    priority: 10,
    sort_order: 3,
    ranges: [
      { start_month: 8, start_day: 1, end_month: 8, end_day: 31 },
    ],
  },
];

function check(name, fn) {
  try {
    fn();
    console.log('PASS', name);
  } catch (err) {
    console.error('FAIL', name, err.message);
    throw err;
  }
}

check('closed November stay is closed_season', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en', TODAY);
  assert.equal(r.closed_season, true);
  assert.equal(r.date_rule_ok, false);
  assert.equal(r.next_action, 'closed_season');
  assert.equal(r.guest_safe_next_action, null);
  assert.equal(r.structured_guest_context.season_reopens_on, '2027-04-01');
  assert.equal(r.nearest_open_dates, null, 'season-only candidate must not be presented before capacity check');
  assert.equal(r.nearest_open_candidate.check_in, '2027-04-01');
  assert.equal(r.season_reopens_on, '2027-04-01');
  assert.deepEqual(r.selected_bed_codes, []);
});

check('open July stay is not closed', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-07-10', '2026-07-17', 'en');
  assert.equal(r.closed_season, false);
  assert.equal(r.date_rule_ok, true);
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-07-10', '2026-07-17'), false);
});

check('October stay is open', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-10-04', '2026-10-11'), false);
});

check('unconfigured October nights are unknown, never open', () => {
  const winterOnly = [SEASONS[0]];
  const a = analyzeClosedSeasonStay(winterOnly, '2026-10-04', '2026-10-06');
  assert.deepEqual(a.open_nights, []);
  assert.deepEqual(a.unknown_nights, ['2026-10-04', '2026-10-05']);
  assert.equal(findNearestOpenStay(winterOnly, '2026-10-04', '2026-10-06', TODAY), null);
  const r = evaluateClosedSeasonStay(winterOnly, '2026-10-04', '2026-10-06', 'en', TODAY);
  assert.equal(r.date_rule_ok, false);
  assert.equal(r.next_action, 'date_availability_unknown');
});

check('bounded closure closes only its configured nights', () => {
  const bounded = [{ ...SEASONS[1], ranges: [{ start_month: 10, start_day: 1, end_month: 12, end_day: 31 }] }, {
    code: 'maintenance', bookable: false, active: true, priority: 20, sort_order: 0,
    ranges: [{ start_month: 11, start_day: 1, end_month: 11, end_day: 2 }],
  }];
  const a = analyzeClosedSeasonStay(bounded, '2026-11-01', '2026-11-05');
  assert.deepEqual(a.closed_nights, ['2026-11-01', '2026-11-02']);
  assert.deepEqual(a.open_nights, ['2026-11-03', '2026-11-04']);
});

check('known-open prefix stops at the first unknown night before a closure', () => {
  const seasons = [{
    code: 'one_open_night', bookable: true, active: true, priority: 10, sort_order: 0,
    ranges: [{ start_month: 10, start_day: 30, end_month: 10, end_day: 30 }],
  }, {
    code: 'maintenance', bookable: false, active: true, priority: 20, sort_order: 0,
    ranges: [{ start_month: 11, start_day: 1, end_month: 11, end_day: 2 }],
  }];
  const a = analyzeClosedSeasonStay(seasons, '2026-10-30', '2026-11-03');
  assert.deepEqual(a.unknown_nights, ['2026-10-31']);
  assert.deepEqual(a.closed_nights, ['2026-11-01', '2026-11-02']);
  assert.deepEqual(a.partial_open_dates, {
    check_in: '2026-10-30', check_out: '2026-10-31', closed_from: '2026-11-01',
  });
});

check('unknown first night suppresses the known-open prefix', () => {
  const seasons = [{
    code: 'later_open', bookable: true, active: true, priority: 10, sort_order: 0,
    ranges: [{ start_month: 10, start_day: 31, end_month: 10, end_day: 31 }],
  }, {
    code: 'maintenance', bookable: false, active: true, priority: 20, sort_order: 0,
    ranges: [{ start_month: 11, start_day: 1, end_month: 11, end_day: 2 }],
  }];
  const a = analyzeClosedSeasonStay(seasons, '2026-10-30', '2026-11-03');
  assert.equal(a.partial_open_dates, null);
});

check('a later closure cannot extend a prefix across an earlier unknown night', () => {
  const seasons = [{
    code: 'split_open', bookable: true, active: true, priority: 10, sort_order: 0,
    ranges: [
      { start_month: 10, start_day: 30, end_month: 10, end_day: 30 },
      { start_month: 11, start_day: 1, end_month: 11, end_day: 1 },
    ],
  }, {
    code: 'maintenance', bookable: false, active: true, priority: 20, sort_order: 0,
    ranges: [{ start_month: 11, start_day: 2, end_month: 11, end_day: 2 }],
  }];
  const a = analyzeClosedSeasonStay(seasons, '2026-10-30', '2026-11-03');
  assert.deepEqual(a.unknown_nights, ['2026-10-31']);
  assert.deepEqual(a.partial_open_dates, {
    check_in: '2026-10-30', check_out: '2026-10-31', closed_from: '2026-11-02',
  });
});

check('reopening is derived after the relevant closure, not arrival', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-10-30', '2026-11-03', 'en', TODAY);
  assert.equal(r.season_reopens_on, '2027-04-01');
});

check('stay crossing into a closed range is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-10-28', '2026-11-03'), true);
  const r = evaluateClosedSeasonStay(SEASONS, '2026-10-28', '2026-11-03', 'es');
  assert.equal(r.closed_season, true);
  assert.equal(r.next_action, 'closed_season');
  assert.deepEqual(r.partial_open_dates, { check_in: '2026-10-28', check_out: '2026-11-01', closed_from: '2026-11-01' });
  assert.deepEqual(r.structured_guest_context.partial_open_dates, r.partial_open_dates);
});

check('January stay is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2027-01-08', '2027-01-15'), true);
});

check('December stay is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-12-12', '2026-12-19'), true);
});

check('no seasons configured is unknown, not open', () => {
  const r = evaluateClosedSeasonStay([], '2026-11-10', '2026-11-17', 'en');
  assert.equal(r.closed_season, false);
  assert.equal(r.date_rule_ok, false);
  assert.equal(r.next_action, 'date_availability_unknown');
  assert.equal(r.nearest_open_dates, null);
});

check('nearest open stay keeps night count', () => {
  const n = findNearestOpenStay(SEASONS, '2026-11-10', '2026-11-17', TODAY);
  assert.ok(n);
  const nights = (Date.parse(n.check_out + 'T00:00:00Z') - Date.parse(n.check_in + 'T00:00:00Z')) / 86400000;
  assert.equal(nights, 7);
});

check('nearest open dates never start before Madrid today', () => {
  const n = findNearestOpenStay(SEASONS, '2026-11-10', '2026-11-17', TODAY);
  assert.ok(n);
  assert.ok(n.check_in >= TODAY, n.check_in);
  assert.notEqual(n.check_in, '2026-10-25');
});

check('nearest open dates return none when no future open stay exists', () => {
  const onlyClosed = [{
    code: 'shut',
    bookable: false,
    active: true,
    priority: 0,
    sort_order: 0,
    ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }],
  }];
  assert.equal(findNearestOpenStay(onlyClosed, '2026-11-10', '2026-11-17', TODAY), null);
  const r = evaluateClosedSeasonStay(onlyClosed, '2026-11-10', '2026-11-17', 'en', TODAY);
  assert.equal(r.closed_season, true);
  assert.equal(r.nearest_open_dates, null);
});

check('guest copy is structured and contains no runtime localized prose', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en', TODAY);
  assert.equal(r.guest_safe_next_action, null);
  assert.equal(r.structured_guest_context.season_reopens_on, '2027-04-01');
  assert.match(r.prompt_instruction, /guest language/);
});

check('capacity-verified nearest stay requires an exact tuple', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'de', TODAY, {
    capacity_verified: { check_in: '2027-04-01', check_out: '2027-04-08', guest_count: 2 }, guest_count: 2,
  });
  assert.equal(r.nearest_open_dates.check_in, '2027-04-01');
});

check('capacity verification cannot authorize a changed candidate', () => {
  const r = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en', TODAY, {
    capacity_verified: { check_in: '2027-06-01', check_out: '2027-06-08', guest_count: 2 }, guest_count: 2,
  });
  assert.equal(r.nearest_open_dates, null);
});

check('closed-night analysis preserves arrival and identifies only closed nights', () => {
  const a = analyzeClosedSeasonStay(SEASONS, '2026-10-25', '2026-11-02');
  assert.equal(a.partial_open_dates.check_in, '2026-10-25');
  assert.equal(a.partial_open_dates.check_out, '2026-11-01');
  assert.deepEqual(a.closed_nights, ['2026-11-01']);
  assert.equal(findSeasonReopensOn(SEASONS, '2026-12-01', TODAY), '2027-04-01');
});

check('evaluateClosedSeasonStay uses injected seasons only — no hard-coded months', () => {
  const onlySummer = [{
    code: 'summer',
    bookable: true,
    active: true,
    priority: 0,
    sort_order: 0,
    ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }],
  }, {
    code: 'shut',
    bookable: false,
    active: true,
    priority: 0,
    sort_order: 1,
    ranges: [{ start_month: 6, start_day: 1, end_month: 6, end_day: 30 }],
  }];
  assert.equal(stayHitsClosedSeason(onlySummer, '2026-06-10', '2026-06-17'), true);
  assert.equal(stayHitsClosedSeason(onlySummer, '2026-11-10', '2026-11-17'), false);
});

const fs = require('fs');
const path = require('path');
check('availability-check route calls evaluateClosedSeason before bed search', () => {
  const src = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const start = src.indexOf('async function handleBotAvailabilityCheck');
  const end = src.indexOf('async function lookupBotAddonBooking', start);
  const route = src.slice(start, end);
  assert.match(route, /evaluateClosedSeason/);
  assert.match(route, /next_action: 'closed_season'/);
  assert.match(route, /selected_bed_codes: \[\]/);
  assert.ok(route.indexOf('evaluateClosedSeason') < route.indexOf('executeWolfhouseAvailabilityCheck'));
});

const sample = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en', TODAY);
console.log('NOVEMBER_SAMPLE', JSON.stringify({
  success: true,
  date_rule_ok: sample.date_rule_ok,
  closed_season: sample.closed_season,
  next_action: sample.next_action,
  guest_safe_next_action: sample.guest_safe_next_action,
  nearest_open_dates: sample.nearest_open_dates,
  selected_bed_codes: sample.selected_bed_codes,
  check_in: '2026-11-10',
  check_out: '2026-11-17',
}, null, 2));

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('PASS', name);
  } catch (err) {
    console.error('FAIL', name, err.message);
    throw err;
  }
}

(async () => {
  const {
    buildWolfhouseAvailabilityCommand,
    executeWolfhouseAvailabilityCheck,
    AVAILABILITY_CHANNELS,
  } = require('./lib/luna-front-desk-accommodation-availability-service');

  await checkAsync('availability executor refuses December from Staff Pricing seasons, not the bed calendar', async () => {
    const pricingSeasons = [
      {
        id: 'open-1',
        code: 'spring_autumn',
        label: 'Open',
        bookable: true,
        active: true,
        priority: 0,
        sort_order: 1,
        ranges: [{ start_month: 3, start_day: 1, end_month: 11, end_day: 30 }],
      },
      {
        id: 'closed-1',
        code: 'closed',
        label: 'Closed',
        bookable: false,
        active: true,
        priority: 0,
        sort_order: 2,
        ranges: [{ start_month: 12, start_day: 1, end_month: 12, end_day: 31 }],
      },
    ];
    const pg = {
      query: async (sql) => {
        if (/wh_pricing_seasons/.test(String(sql))) return { rows: pricingSeasons };
        if (/FROM rooms/.test(String(sql))) {
          return { rows: [{ bed_code: 'R1-B1', room_code: 'R1', room_name: 'R1', capacity: 1 }] };
        }
        return { rows: [] };
      },
    };
    const built = buildWolfhouseAvailabilityCommand({
      channel: AVAILABILITY_CHANNELS.BOT_HTTP,
      trustedClientSlug: 'wolfhouse-somo',
      transportBody: {
        check_in: '2026-12-12',
        check_out: '2026-12-19',
        guest_count: 1,
        room_type: 'shared',
      },
    });
    assert.equal(built.ok, true);
    const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
    assert.equal(result.ok, true);
    assert.equal(result.body.closed_season, true);
    assert.equal(result.body.date_rule_ok, false);
    assert.equal(result.body.next_action, 'closed_season');
    assert.equal(result.body.has_enough_beds, false);
    assert.deepEqual(result.body.selected_bed_codes, []);
    assert.ok((result.body.blockers || []).includes('closed_season'));
  });

  function decemberStayCommand() {
    return buildWolfhouseAvailabilityCommand({
      channel: AVAILABILITY_CHANNELS.BOT_HTTP,
      trustedClientSlug: 'wolfhouse-somo',
      transportBody: {
        check_in: '2026-12-12',
        check_out: '2026-12-19',
        guest_count: 1,
        room_type: 'shared',
      },
    });
  }

  await checkAsync('Pricing missing or 42P01 is date_availability_unknown and skips beds', async () => {
    let searchedBeds = false;
    const pg = {
      query: async (sql) => {
        if (/wh_pricing_seasons/.test(String(sql))) {
          const err = new Error('relation "wh_pricing_seasons" does not exist');
          err.code = '42P01';
          throw err;
        }
        if (/FROM rooms/.test(String(sql))) {
          searchedBeds = true;
          return { rows: [{ bed_code: 'R1-B1', room_code: 'R1' }] };
        }
        return { rows: [] };
      },
    };
    const built = decemberStayCommand();
    assert.equal(built.ok, true);
    const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
    assert.equal(result.body.closed_season, false);
    assert.equal(result.body.date_rule_ok, false);
    assert.equal(result.body.next_action, 'date_availability_unknown');
    assert.equal(result.body.has_enough_beds, false);
    assert.deepEqual(result.body.selected_bed_codes, []);
    assert.equal(searchedBeds, false);
  });

  await checkAsync('empty Pricing catalog is date_availability_unknown and skips beds', async () => {
    let searchedBeds = false;
    const pg = {
      query: async (sql) => {
        if (/wh_pricing_seasons/.test(String(sql))) return { rows: [] };
        if (/FROM rooms/.test(String(sql))) {
          searchedBeds = true;
          return { rows: [{ bed_code: 'R1-B1', room_code: 'R1' }] };
        }
        return { rows: [] };
      },
    };
    const built = decemberStayCommand();
    const result = await executeWolfhouseAvailabilityCheck(pg, built.command);
    assert.equal(result.body.next_action, 'date_availability_unknown');
    assert.equal(result.body.has_enough_beds, false);
    assert.equal(searchedBeds, false);
  });

  await checkAsync('quote for Nov 28–Dec 3 is closed_season on the whole stay', async () => {
    const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
    const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
    const cfg = applyAuthoritativeSeasonsToConfig(loadConfig(), [
      {
        code: 'spring_autumn', label: 'Open', priority: 0, sort_order: 1, bookable: true, active: true,
        ranges: [{ start_month: 3, start_day: 1, end_month: 11, end_day: 30 }],
      },
      {
        code: 'closed', label: 'Closed', priority: 0, sort_order: 2, bookable: false, active: true,
        ranges: [{ start_month: 12, start_day: 1, end_month: 12, end_day: 31 }],
      },
    ]);
    const quote = calculateWolfhouseQuote({
      client_slug: 'wolfhouse-somo',
      check_in: '2026-11-28',
      check_out: '2026-12-03',
      guest_count: 1,
      package_code: 'package_none',
      room_type: 'shared',
      payment_choice: 'deposit',
    }, cfg);
    assert.equal(quote.success, false);
    assert.equal(quote.closed_season, true);
  });

  await checkAsync('date-change into December is closed_season', async () => {
    const { createWolfhouseDateChangeService } = require('./lib/wolfhouse-date-change');
    const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');
    const { applyAuthoritativeSeasonsToConfig } = require('./lib/wolfhouse-pricing-resolve');
    const cfg = applyAuthoritativeSeasonsToConfig(loadConfig(), [
      {
        code: 'spring_autumn', label: 'Open', priority: 0, sort_order: 1, bookable: true, active: true,
        ranges: [{ start_month: 3, start_day: 1, end_month: 11, end_day: 30 }],
      },
      {
        code: 'closed', label: 'Closed', priority: 0, sort_order: 2, bookable: false, active: true,
        ranges: [{ start_month: 12, start_day: 1, end_month: 12, end_day: 31 }],
      },
    ]);
    const state = {
      booking: {
        booking_id: 'b1', booking_code: 'WH-1', client_id: 'c1', client_slug: 'wolfhouse-somo',
        guest_phone: '+34111', check_in: '2026-11-01', check_out: '2026-11-07', guest_count: 1,
        package_code: 'package_none', requested_room_type: 'shared', room_preference: 'shared',
        metadata: {}, status: 'confirmed', total_amount_cents: 24000, deposit_required_cents: 10000,
        amount_paid_cents: 0, balance_due_cents: 24000,
      },
      assignments: [{ booking_bed_id: 'bb1', bed_id: 'bed1', bed_code: 'R1-B1', room_code: 'R1' }],
      conflicts: [],
    };
    const pg = {
      async query(sql) {
        if (/BEGIN|COMMIT|ROLLBACK/.test(String(sql).trim())) return { rows: [] };
        if (/FROM bookings b/.test(sql)) return { rows: [state.booking] };
        if (/FROM booking_beds bb/.test(sql) && /JOIN beds/.test(sql)) return { rows: state.assignments };
        if (/AS conflicting_booking_id/.test(sql)) return { rows: [] };
        throw new Error(`unexpected SQL: ${String(sql).slice(0, 80)}`);
      },
    };
    const service = createWolfhouseDateChangeService({
      withPgClient: async (fn) => fn(pg),
      quoteNewDates: async (input) => calculateWolfhouseQuote({
        client_slug: input.client_slug,
        check_in: input.check_in,
        check_out: input.check_out,
        guest_count: input.guest_count,
        package_code: input.package_code || 'package_none',
        room_type: input.room_type || 'shared',
        payment_choice: 'deposit',
      }, cfg),
      tokenSecret: 'unit-test-date-change-secret-32bytes-minimum',
    });
    const preview = await service.quote({
      client_slug: 'wolfhouse-somo',
      booking_code: 'WH-1',
      guest_phone: '+34111',
      new_check_in: '2026-12-12',
      new_check_out: '2026-12-19',
    });
    assert.equal(preview.success, false);
    assert.equal(preview.reason_code, 'closed_season');
    assert.equal(preview.closed_season, true);
  });

  console.log('OK verify-wolfhouse-closed-season');
})().catch(() => {
  process.exitCode = 1;
});
