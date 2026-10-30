'use strict';

const assert = require('assert/strict');
const resolve = require('./lib/wolfhouse-pricing-resolve');
const { calculateWolfhouseQuote, loadConfig } = require('./lib/wolfhouse-quote-calculator');

const dbSeasons = [
  { code: 'spring_autumn', label: 'Spring Autumn', priority: 0, sort_order: 1, bookable: true, active: true,
    ranges: [{ start_month: 10, start_day: 1, end_month: 11, end_day: 30 }] },
  { code: 'closed', label: 'Closed', priority: 0, sort_order: 2, bookable: false, active: true,
    ranges: [{ start_month: 12, start_day: 1, end_month: 2, end_day: 29 }] },
];

const base = loadConfig();
const authoritative = resolve.applyAuthoritativeSeasonsToConfig(base, dbSeasons);
assert.deepEqual(authoritative.seasons, dbSeasons, 'DB seasons replace the bundled calendar exactly');
assert.notEqual(authoritative.seasons, dbSeasons, 'the authoritative config owns a defensive copy');
assert.equal(resolve.resolveSeasonForDate(authoritative.seasons, '2027-11-30').code, 'spring_autumn');
assert.equal(resolve.resolveSeasonForDate(authoritative.seasons, '2027-12-01').code, 'closed');

const boundarySeasons = [
  { code: 'inactive', active: false, priority: 99, sort_order: 0, ranges: [{ start_month: 5, start_day: 1, end_month: 5, end_day: 31 }] },
  { code: 'partial', active: true, priority: 1, sort_order: 5, ranges: [{ start_month: 5, start_day: 10, end_month: 5, end_day: 20 }] },
  { code: 'wrap', active: true, priority: 1, sort_order: 6, ranges: [{ start_month: 12, start_day: 20, end_month: 1, end_day: 10 }] },
  { code: 'tie_a', active: true, priority: 5, sort_order: 1, ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
  { code: 'tie_b', active: true, priority: 5, sort_order: 2, ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }] },
];
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-05-09'), null);
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-05-10').code, 'partial');
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-05-20').code, 'partial');
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-05-21'), null);
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-12-25').code, 'wrap');
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2028-01-10').code, 'wrap');
assert.equal(resolve.resolveSeasonForDate(boundarySeasons, '2027-08-15').code, 'tie_a');
for (const tz of ['UTC', 'Europe/Madrid']) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  assert.equal(resolve.resolveSeasonForDate(dbSeasons, '2027-03-28'), null, `DST-safe in ${tz}`);
  if (old === undefined) delete process.env.TZ; else process.env.TZ = old;
}

const november = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo', check_in: '2027-11-29', check_out: '2027-11-30',
  guest_count: 1, package_code: 'package_none', room_type: 'shared', payment_choice: 'deposit',
  manual_price_per_night_cents: 5000,
}, authoritative);
assert.equal(november.success, true, JSON.stringify(november.blockers));
assert.equal(november.season_code, 'spring_autumn');

const december = calculateWolfhouseQuote({
  client_slug: 'wolfhouse-somo', check_in: '2027-12-01', check_out: '2027-12-02',
  guest_count: 1, package_code: 'package_none', room_type: 'shared', payment_choice: 'deposit',
  manual_price_per_night_cents: 5000,
}, authoritative);
assert.equal(december.success, false);
assert.equal(december.closed_season, true);
assert.equal(december.season_code, 'closed');

for (const unavailable of [null, undefined, []]) {
  assert.throws(
    () => resolve.applyAuthoritativeSeasonsToConfig(base, unavailable),
    err => err && err.code === 'PRICING_SEASONS_UNAVAILABLE',
  );
}

const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
const {
  buildCheckedWolfhousePreviewOffer,
  rereadWolfhouseOfferForCommit,
} = require('./lib/luna-front-desk-accommodation-availability-service');
const fs = require('fs');
const path = require('path');
const guestCopySource = fs.readFileSync(path.join(__dirname, 'lib', 'bot-guest-safe-copy.js'), 'utf8');
assert.doesNotMatch(guestCopySource, /DateTimeFormat|CLOSED_SEASON_COPY|NEAREST_OPEN_DATES_COPY/);
const soul = fs.readFileSync(path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md'), 'utf8');
assert.doesNotMatch(soul, /November through February|March to October/i);
const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
assert.match(apiSource, /loadSeasons\(pg, 'wolfhouse-somo'\)/);
assert.match(apiSource, /applyAuthoritativeSeasonsToConfig\(base, seasons\)/);
assert.doesNotMatch(apiSource, /pricing overlay unavailable, serving bundled config/);

async function verifyDirectLoader() {
  const reads = [];
  const pg = {
    async query(sql) {
      reads.push(String(sql));
      if (/FROM wh_pricing_seasons s/.test(sql)) return { rows: dbSeasons };
      if (/FROM wh_pricing_rules/.test(sql)) return { rows: [{
        item_type: 'package', item_code: 'malibu', season_code: 'spring_autumn',
        unit: 'per_person_per_week', amount_cents: 99900, currency: 'EUR', active: true,
      }] };
      if (/FROM wh_pricing_items/.test(sql)) return { rows: [] };
      throw new Error('unexpected query');
    },
  };
  const loaded = await service.loadBookingQuoteConfigWithOverlay(pg);
  assert.equal(reads.filter(sql => /FROM wh_pricing_seasons s/.test(sql)).length, 1);
  assert.equal(resolve.resolveSeasonForDate(loaded.seasons, '2027-11-30').code, 'spring_autumn');
  const packageQuote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2027-11-22', check_out: '2027-11-29',
    guest_count: 1, package_code: 'malibu', room_type: 'shared', payment_choice: 'deposit',
  }, loaded);
  assert.equal(packageQuote.success, true, JSON.stringify(packageQuote.blockers));
  assert.equal(packageQuote.season_code, 'spring_autumn');
  assert.equal(packageQuote.line_items.find(row => row.code === 'package').total_cents, 99900);
  await assert.rejects(
    () => service.loadBookingQuoteConfigWithOverlay({ query: async () => { throw new Error('missing season table'); } }),
    err => err && err.code === 'PRICING_SEASONS_UNAVAILABLE',
  );
  for (const failedRead of ['rules', 'items']) {
    await assert.rejects(
      () => service.loadBookingQuoteConfigWithOverlay({
        async query(sql) {
          const text = String(sql);
          if (/FROM wh_pricing_seasons s/.test(text)) return { rows: dbSeasons };
          if (/FROM wh_pricing_rules/.test(text)) {
            if (failedRead === 'rules') throw new Error('rules unavailable');
            return { rows: [] };
          }
          if (/FROM wh_pricing_items/.test(text)) {
            if (failedRead === 'items') throw new Error('items unavailable');
            return { rows: [] };
          }
          throw new Error('unexpected query');
        },
      }),
      err => err && err.code === 'PRICING_OVERLAY_UNAVAILABLE',
      `${failedRead} read failure must fail closed`,
    );
  }
}

async function verifyCommitRereadFailsClosed() {
  const result = await rereadWolfhouseOfferForCommit({
    async query(sql) {
      const text = String(sql);
      if (text.includes('offer_commit_reread') || text.includes('FROM rooms r')) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1', room_type: 'shared', gender_strategy: 'mixed' }] };
      }
      if (text.includes('wh_pricing_seasons')) throw new Error('season read unavailable');
      return { rows: [] };
    },
  }, {
    clientSlug: 'wolfhouse-somo',
    checkIn: '2027-11-10',
    checkOut: '2027-11-17',
    quoteGuestCount: 1,
    assignedBedCodes: ['R1-B1'],
    roomType: 'shared',
    effectivePackageCode: 'malibu',
    paymentChoice: 'deposit',
    transportBody: { accepted_offer: { revision: 'test' } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'pricing_seasons_unavailable');
  assert.equal(result.write_performed, false);
}

async function verifyUnchangedNovemberOfferSurvivesCommitReread() {
  let seasonReads = 0;
  const pg = {
    async query(sql) {
      const text = String(sql);
      if (/FROM wh_pricing_seasons s/.test(text)) {
        seasonReads += 1;
        return { rows: dbSeasons };
      }
      if (/FROM wh_pricing_rules/.test(text)) return { rows: [{
        item_type: 'package', item_code: 'malibu', season_code: 'spring_autumn',
        unit: 'per_person_per_week', amount_cents: 99900, currency: 'EUR', active: true,
      }] };
      if (/FROM wh_pricing_items/.test(text)) return { rows: [] };
      if (text.includes('offer_commit_reread') || text.includes('FROM rooms r')) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1', room_type: 'shared', gender_strategy: 'mixed' }] };
      }
      return { rows: [] };
    },
  };
  const config = await service.loadBookingQuoteConfigWithOverlay(pg);
  const quote = calculateWolfhouseQuote({
    client_slug: 'wolfhouse-somo', check_in: '2027-11-22', check_out: '2027-11-29',
    guest_count: 1, package_code: 'malibu', room_type: 'shared', payment_choice: 'deposit',
  }, config);
  assert.equal(quote.success, true);
  const accepted = buildCheckedWolfhousePreviewOffer({
    client_slug: 'wolfhouse-somo', quote,
    availability: {
      availability_checked: true, status: 'checked', check_in: '2027-11-22', check_out: '2027-11-29',
      guest_count: 1, selected_bed_codes: ['R1-B1'], room_type: 'shared', allocation_reason: 'explicit_selection',
    },
    guests: [{ guest_name: 'Synthetic Guest' }],
    room_rows: [{ bed_code: 'R1-B1', room_code: 'R1', room_type: 'shared', gender_strategy: 'mixed' }],
    package_code: 'malibu', payment_choice: 'deposit',
  }).offer_revision;
  const reread = await rereadWolfhouseOfferForCommit(pg, {
    clientSlug: 'wolfhouse-somo', checkIn: '2027-11-22', checkOut: '2027-11-29',
    quoteGuestCount: 1, assignedBedCodes: ['R1-B1'], roomType: 'shared',
    effectivePackageCode: 'malibu', paymentChoice: 'deposit', allocationReason: 'explicit_selection',
    guestsNorm: { guests: [{ guest_name: 'Synthetic Guest' }] },
    transportBody: { accepted_offer: accepted },
  });
  assert.equal(reread.ok, true, JSON.stringify(reread));
  assert.ok(seasonReads >= 2, 'initial quote and commit reread both read authoritative seasons');
}

Promise.resolve()
  .then(verifyDirectLoader)
  .then(verifyCommitRereadFailsClosed)
  .then(verifyUnchangedNovemberOfferSurvivesCommitReread)
  .then(() => console.log('authoritative Pricing seasons: core replacement, boundaries, open/closed and unavailable gates PASS'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
