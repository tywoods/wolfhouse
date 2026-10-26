#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  stayHitsClosedSeason,
  findNearestOpenStay,
  evaluateClosedSeasonStay,
  closedSeasonGuestCopy,
} = require('./lib/wolfhouse-closed-season');

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
  const r = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en');
  assert.equal(r.closed_season, true);
  assert.equal(r.date_rule_ok, false);
  assert.equal(r.next_action, 'closed_season');
  assert.ok(r.guest_safe_next_action);
  assert.equal(r.nearest_open_dates.check_in, '2026-10-25');
  assert.equal(r.nearest_open_dates.check_out, '2026-11-01');
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

check('stay crossing into a closed range is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-10-28', '2026-11-03'), true);
  const r = evaluateClosedSeasonStay(SEASONS, '2026-10-28', '2026-11-03', 'es');
  assert.equal(r.closed_season, true);
  assert.equal(r.next_action, 'closed_season');
});

check('January stay is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2027-01-08', '2027-01-15'), true);
});

check('December stay is closed', () => {
  assert.equal(stayHitsClosedSeason(SEASONS, '2026-12-12', '2026-12-19'), true);
});

check('no seasons configured is not closed', () => {
  const r = evaluateClosedSeasonStay([], '2026-11-10', '2026-11-17', 'en');
  assert.equal(r.closed_season, false);
  assert.equal(r.date_rule_ok, true);
  assert.equal(r.nearest_open_dates, null);
});

check('nearest open stay keeps night count', () => {
  const n = findNearestOpenStay(SEASONS, '2026-11-10', '2026-11-17');
  assert.ok(n);
  const nights = (Date.parse(n.check_out + 'T00:00:00Z') - Date.parse(n.check_in + 'T00:00:00Z')) / 86400000;
  assert.equal(nights, 7);
});

check('guest copy is localized EN/ES/IT', () => {
  const en = closedSeasonGuestCopy('en');
  const es = closedSeasonGuestCopy('es');
  const it = closedSeasonGuestCopy('it');
  assert.ok(en && es && it);
  assert.notEqual(es, en);
  assert.notEqual(it, en);
  assert.match(es, /cerrad/i);
  assert.match(it, /chius/i);
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

const sample = evaluateClosedSeasonStay(SEASONS, '2026-11-10', '2026-11-17', 'en');
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

console.log('OK verify-wolfhouse-closed-season');
