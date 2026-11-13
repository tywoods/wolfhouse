'use strict';

// Real builder/executor and real atomic create SQL (ephemeral PGlite).
// Only PG boundary reads outside that SQL are fixtures. No service monkeypatches,
// live database, Stripe, network, or guest sends.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { currentWolfhouseOfferFromCreateCommand } = require('./lib/luna-front-desk-accommodation-availability-service');
const { loadConfig: bundledConfig } = require('./lib/wolfhouse-quote-calculator');
function loadConfig() {
  const config = structuredClone(bundledConfig());
  config.seasons = [{ code: 'summer', active: true, bookable: true,
    ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }] }];
  return config;
}
const { buildPerPersonBreakdown } = require('./lib/booking-guests');
const { GOLDEN_BED_ROWS } = require('./lib/luna-golden-offline-pg');
const SLUG = 'wolfhouse-somo';
const body = () => ({ confirm: true, check_in: '2026-07-06', check_out: '2026-07-13',
  guest_count: 2, guest_name: 'Alex', guests: [{ name: 'Alex' }, { name: 'Sam' }],
  phone: '+34600000000', package_code: 'malibu', room_type: 'shared',
  payment_choice: 'deposit', payment_link_distribution: 'separate',
  selected_bed_codes: ['R1-B1', 'R1-B2'], idempotency_key: 'always-save-test' });

async function boundary() {
  const db = new PGlite();
  await db.exec(`
    CREATE TYPE booking_status AS ENUM ('confirmed','cancelled','expired');
    CREATE TYPE payment_status AS ENUM ('not_requested');
    CREATE TYPE payment_record_status AS ENUM ('draft');
    CREATE TYPE payment_kind AS ENUM ('deposit_only','full_amount');
    CREATE TABLE clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text);
    CREATE TABLE rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, room_code text, room_type text);
    CREATE TABLE beds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, room_id uuid, bed_code text, active bool DEFAULT true, sellable bool DEFAULT true);
    CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, booking_code text UNIQUE,
      guest_name text, phone text, email text, language text, status booking_status, payment_status payment_status,
      assignment_status text, check_in date, check_out date, guest_count int, package_code text, primary_room_code text,
      booking_source text, staff_notes text, confirmation_sent_at timestamptz, metadata jsonb,
      total_amount_cents int, deposit_required_cents int, balance_due_cents int, requested_room_type text);
    CREATE TABLE booking_beds (id uuid DEFAULT gen_random_uuid(), client_id uuid, booking_id uuid, bed_id uuid,
      bed_code text, room_code text, assignment_start_date date, assignment_end_date date,
      assignment_type text, assignment_notes text, guest_name text);
    CREATE TABLE payments (id uuid DEFAULT gen_random_uuid(), client_id uuid, booking_id uuid, status payment_record_status,
      payment_kind payment_kind, currency text, amount_due_cents int, metadata jsonb);
    CREATE TABLE workflow_events (id uuid DEFAULT gen_random_uuid(), client_id uuid, workflow_name text,
      node_name text, event_level text, message text, booking_id uuid, payload jsonb);
    INSERT INTO clients (slug) VALUES ('wolfhouse-somo');
    INSERT INTO rooms (client_id,room_code,room_type) SELECT id,'R1','shared' FROM clients;
    INSERT INTO beds (client_id,room_id,bed_code) SELECT client_id,id,code FROM rooms CROSS JOIN unnest(ARRAY['R1-B1','R1-B2']) code;
  `);
  const calls = [];
  const pg = { db, calls, async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s) || s.includes('inserted_booking_beds AS')) return db.query(sql, params);
    if (s.includes('offer_idempotency_lookup')) return { rows: pg.saved ? [pg.saved] : [] };
    if (s.includes('FROM wh_pricing_seasons s')) {
      if (pg.failPricingRefresh) throw new Error('fixture pricing refresh read failed');
      return { rows: loadConfig().seasons };
    }
    if (s.includes('FROM wh_pricing_rules r')) return { rows: [{ item_type: 'package', item_code: 'malibu',
      season_code: 'summer', unit: 'per_person_per_week', amount_cents: pg.livePrice || 29900, active: true }] };
    if (s.includes('FROM conversations c')) return { rows: pg.wrongConversation ? [{ conversation_id: 'wrong', location_id: 'sunset-somo' }] : [] };
    if (s.includes('FROM rooms r') && s.includes('LEFT JOIN beds bd')) {
      if (pg.failAvailabilityRefresh) throw new Error('fixture availability refresh read failed');
      return { rows: pg.emptyVerificationInventory ? [] : GOLDEN_BED_ROWS };
    }
    if (s.includes('FROM booking_beds bb') && s.includes('assignment_start_date')) return { rows: pg.occupiedBeds || [] };
    if (s.includes('UPDATE bookings') && s.includes('total_amount_cents')) {
      if (pg.failWrite) throw new Error('fixture DB write failed');
      return db.query(sql, params);
    }
    if (s.startsWith('SELECT client_id FROM bookings')) return db.query(sql, params);
    if (s.startsWith('SELECT bed_code, room_code')) return db.query(sql.replace('ORDER BY created_at ASC', ''), params);
    if (s.startsWith('INSERT INTO booking_guests')) return { rows: [{ booking_guest_id: `guest-${params[2]}`,
      guest_number: params[2], guest_name: params[3], assigned_room_code: params[4], assigned_bed_code: params[5], deposit_amount_cents: params[6] }] };
    if (s.startsWith('UPDATE payments')) return db.query(sql, params);
    return { rows: [] };
  } };
  return pg;
}
async function build(pg, transportBody, config = loadConfig(), extra = {}) {
  return service.buildWolfhouseBookingCreateCommand({ channel: 'luna_whatsapp', trustedClientSlug: SLUG,
    pgClient: pg, quoteConfig: config, transportBody, ...extra });
}
function writer(pg) { return pg.calls.find(c => c.sql.includes('inserted_booking_beds AS')); }
async function run() {
  const pg = await boundary();
  try {
    const original = await build(pg, body());
    assert.equal(original.ok, true, JSON.stringify(original));
    const acceptedQuote = JSON.parse(JSON.stringify(original.command.quote));
    acceptedQuote.per_person = buildPerPersonBreakdown(acceptedQuote, { guest_names: ['Alex', 'Sam'], payment_choice: 'deposit' });
    const accepted = { ...body(), always_save_accepted_booking: true, require_offer_identity: true,
      accepted_offer: currentWolfhouseOfferFromCreateCommand({ ...original.command, availabilityChecked: true }), accepted_quote: acceptedQuote,
      booking_check_warnings: ['owner_check_mismatch'] };
    const config = structuredClone(loadConfig());
    config.packages[0].seasonal_prices.summer.weekly_per_person_cents += 10000;
    pg.livePrice = config.packages[0].seasonal_prices.summer.weekly_per_person_cents;
    const changed = await build(pg, accepted, config);
    assert.equal(changed.ok, true, JSON.stringify(changed));
    const out = await service.executeWolfhouseBookingCreate(pg, changed.command);
    assert.equal(out.ok, true, `accepted price/check mismatch must save: ${JSON.stringify(out)}`);
    assert.equal(writer(pg).params[18], acceptedQuote.total_cents, 'SQL total is last quoted total');
    assert.equal(writer(pg).params[17], acceptedQuote.deposit_required_cents);
    assert.match(writer(pg).params[21], /owner_check_mismatch/);
    assert.match(writer(pg).params[21], /offer_terms_changed/);
    assert.ok(pg.calls.some(c => c.sql.includes('offer_price_lock')), 'commit-time pricing reread really ran');
    assert.equal(pg.calls.find(c => c.sql.startsWith('UPDATE payments')).params[1], acceptedQuote.payment_link_amount_cents);
    const metadata = JSON.parse(pg.calls.find(c => c.sql.includes('SET total_amount_cents')).params[4]);
    assert.deepEqual(metadata.quote_snapshot, acceptedQuote);
    assert.deepEqual(out.body._per_person, acceptedQuote.per_person);
    assert.deepEqual(pg.calls.filter(c => c.sql.startsWith('INSERT INTO booking_guests')).map(c => c.params[6]), acceptedQuote.per_person.map(p => p.deposit_cents));
    const saved = (await pg.db.query('SELECT * FROM bookings')).rows;
    assert.equal(saved.length, 1);
    assert.match(saved[0].staff_notes, /owner_check_mismatch/);
    console.log('PASS real service + atomic SQL save old quote, split amounts and Staff warnings');

    const pricingUnavailable = await boundary();
    try {
      pricingUnavailable.failPricingRefresh = true;
      const noRefresh = await build(pricingUnavailable, accepted, undefined, { quoteConfig: undefined });
      assert.equal(noRefresh.ok, true, JSON.stringify(noRefresh));
      const savedKnownQuote = await service.executeWolfhouseBookingCreate(pricingUnavailable, noRefresh.command);
      assert.equal(savedKnownQuote.ok, true, JSON.stringify(savedKnownQuote));
      assert.equal(writer(pricingUnavailable).params[18], acceptedQuote.total_cents);
      assert.match(writer(pricingUnavailable).params[21], /pricing_recheck_unavailable/);
      assert.deepEqual(noRefresh.command.quote, acceptedQuote, 'fallback metadata never replaces quote money');
      const missingSnapshot = await boundary();
      try {
        missingSnapshot.failPricingRefresh = true;
        const built = await build(missingSnapshot, { ...accepted, accepted_quote: null }, undefined,
          { quoteConfig: undefined });
        assert.equal(built.ok, true, JSON.stringify(built));
        const created = await service.executeWolfhouseBookingCreate(missingSnapshot, built.command);
        assert.equal(created.ok, true, JSON.stringify(created));
        const rows = (await missingSnapshot.db.query('SELECT * FROM bookings')).rows;
        assert.equal(rows.length, 1, 'pricing-check failure must not veto the actual save');
        assert.equal(rows[0].status, 'confirmed');
        assert.match(rows[0].staff_notes, /pricing_recheck_unavailable/);
        assert.match(rows[0].staff_notes, /accepted_quote_unavailable/);
        assert.equal(rows[0].total_amount_cents, acceptedQuote.total_cents);
        assert.equal(rows[0].deposit_required_cents, acceptedQuote.deposit_required_cents);
        assert.equal(rows[0].balance_due_cents, acceptedQuote.balance_due_cents);
        assert.equal((await missingSnapshot.db.query('SELECT * FROM booking_beds')).rows.length, 2);
        const payment = (await missingSnapshot.db.query('SELECT * FROM payments')).rows;
        assert.equal(payment.length, 1);
        assert.equal(payment[0].amount_due_cents, acceptedQuote.payment_link_amount_cents);
        assert.deepEqual(rows[0].metadata.quote_snapshot.per_person, [], 'no fabricated itemized prices');
        const second = await build(missingSnapshot, { ...accepted, accepted_quote: null,
          idempotency_key: 'pricing-outage-occupied' }, undefined, { quoteConfig: undefined });
        const refused = await service.executeWolfhouseBookingCreate(missingSnapshot, second.command);
        assert.equal(refused.ok, false);
        assert.equal(refused.body.block_reason, 'overlap_conflict');
        assert.equal((await missingSnapshot.db.query('SELECT * FROM bookings')).rows.length, 1);
        console.log('PASS pricing read failure without quote snapshot persists booking, beds, accepted-offer money and staff warnings; occupied bed still refuses');
      } finally { await missingSnapshot.db.close(); }
      await assert.rejects(() => build(pricingUnavailable, { ...accepted, always_save_accepted_booking: false }, undefined,
        { quoteConfig: undefined }), { code: 'PRICING_SEASONS_UNAVAILABLE' });
      console.log('PASS unavailable price refresh still saves the owner-held Staff quote');
      console.log('PASS pricing failure outside the accepted always-save path remains unchanged');
    } finally { await pricingUnavailable.db.close(); }

    const noMoney = await boundary();
    try {
      noMoney.failPricingRefresh = true;
      const built = await build(noMoney, { ...accepted, accepted_quote: null, accepted_offer: null },
        undefined, { quoteConfig: undefined });
      assert.equal(built.ok, true, JSON.stringify(built));
      const created = await service.executeWolfhouseBookingCreate(noMoney, built.command);
      assert.equal(created.ok, true, JSON.stringify(created));
      const rows = (await noMoney.db.query('SELECT * FROM bookings')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'confirmed');
      for (const key of ['total_amount_cents', 'deposit_required_cents', 'balance_due_cents']) {
        assert.equal(rows[0][key], null, `${key} must stay unknown, not invented or zero-priced`);
      }
      assert.match(rows[0].staff_notes, /pricing_recheck_unavailable/);
      assert.match(rows[0].staff_notes, /accepted_quote_unavailable/);
      assert.equal((await noMoney.db.query('SELECT * FROM booking_beds')).rows.length, 2);
      assert.equal((await noMoney.db.query('SELECT * FROM payments')).rows.length, 0);
      assert.equal(created.body._payment_id, null);
      assert.deepEqual(created.body._per_person, []);
      console.log('PASS no retained money still persists booking and staff warning, with NULL prices and no fabricated charge');
    } finally { await noMoney.db.close(); }

    const freshQuote = await boundary();
    try {
      const withoutSnapshot = await build(freshQuote, { ...accepted, accepted_quote: null });
      assert.equal(withoutSnapshot.ok, true, `no earlier quote must not become a display gate: ${JSON.stringify(withoutSnapshot)}`);
      const savedFresh = await service.executeWolfhouseBookingCreate(freshQuote, withoutSnapshot.command);
      assert.equal(savedFresh.ok, true, JSON.stringify(savedFresh));
      assert.equal(writer(freshQuote).params[18], original.command.totalCents);
      assert.match(writer(freshQuote).params[21], /accepted_quote_unavailable/);
      console.log('PASS no earlier quote snapshot uses Staff calculation and saves with advisory note');
    } finally { await freshQuote.db.close(); }

    const uncertain = await boundary();
    try {
      uncertain.emptyVerificationInventory = true;
      const unchecked = await build(uncertain, { ...accepted, keep_together: true });
      assert.equal(unchecked.ok, true, `verification must not veto accepted save: ${JSON.stringify(unchecked)}`);
      const savedUnchecked = await service.executeWolfhouseBookingCreate(uncertain, unchecked.command);
      assert.equal(savedUnchecked.ok, true, JSON.stringify(savedUnchecked));
      assert.equal((await uncertain.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
      assert.match(writer(uncertain).params[21], /availability_changed/);
      assert.equal(writer(uncertain).params[18], acceptedQuote.total_cents);
      console.log('PASS failed explicit-bed verification is advisory; real atomic SQL saves free beds');
    } finally { await uncertain.db.close(); }

    for (const failDuringBuild of [true, false]) {
      const unavailable = await boundary();
      try {
        unavailable.failAvailabilityRefresh = failDuringBuild;
        const unchecked = await build(unavailable, accepted);
        assert.equal(unchecked.ok, true, JSON.stringify(unchecked));
        unavailable.failAvailabilityRefresh = true;
        const savedUnchecked = await service.executeWolfhouseBookingCreate(unavailable, unchecked.command);
        assert.equal(savedUnchecked.ok, true, JSON.stringify(savedUnchecked));
        assert.match(writer(unavailable).params[21], /availability_recheck_failed/);
        assert.equal((await unavailable.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
      } finally { await unavailable.db.close(); }
    }
    console.log('PASS unavailable availability refresh with/without provenance is advisory; atomic SQL saves known free beds');

    const clarification = await boundary();
    try {
      const checked = await build(clarification, { ...accepted, selected_bed_codes: 'R1-B1,R1-B2',
        group_gender: 'male', room_preference: 'female_only' });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      assert.ok(checked.command.bookingCheckWarnings.includes('incompatible_preselected_beds'));
      const savedClarification = await service.executeWolfhouseBookingCreate(clarification, checked.command);
      assert.equal(savedClarification.ok, true, JSON.stringify(savedClarification));
      assert.match(writer(clarification).params[21], /incompatible_preselected_beds/);
      console.log('PASS explicit-bed eligibility diagnostic routes through policy and saves selected free beds');
    } finally { await clarification.db.close(); }

    const noAllocation = await boundary();
    try {
      const missing = await build(noAllocation, { ...accepted, selected_bed_codes: [],
        group_gender: 'male', room_preference: 'female_only' });
      assert.equal(missing.ok, false, JSON.stringify(missing));
      assert.equal(missing.body.reason_code, 'bed_assignment_failed');
      assert.match(missing.body.error, /needs_clarification/);
      assert.equal(writer(noAllocation), undefined);
      console.log('PASS autoassignment clarification is advisory but absent bed facts remain structural; no invented beds');
    } finally { await noAllocation.db.close(); }

    pg.calls.length = 0;
    const conflict = await build(pg, { ...accepted, idempotency_key: 'second-booking' }, config);
    const occupied = await service.executeWolfhouseBookingCreate(pg, conflict.command);
    assert.equal(occupied.ok, false);
    assert.equal(occupied.body.block_reason, 'overlap_conflict');
    assert.ok(writer(pg), 'occupied-bed decision reached actual SQL, not a fabricated refusal');
    assert.ok(pg.calls.some(c => c.sql === 'ROLLBACK'));
    assert.equal((await pg.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
    console.log('PASS actual Postgres overlap predicate aborts second booking; no extra row');

    pg.calls.length = 0;
    pg.occupiedBeds = [{ bed_code: 'R1-B1', room_code: 'R1' }];
    const knownConflict = await build(pg, { ...accepted, idempotency_key: 'known-conflict' }, config);
    assert.equal(knownConflict.ok, true, JSON.stringify(knownConflict));
    knownConflict.command.availabilityProvenance = null;
    const preflightConflict = await service.executeWolfhouseBookingCreate(pg, knownConflict.command);
    assert.equal(preflightConflict.ok, false);
    assert.equal(preflightConflict.body.bed_already_taken, true);
    assert.equal(writer(pg), undefined);
    pg.occupiedBeds = [];
    console.log('PASS known occupied-bed preflight returns typed bed_already_taken for HTTP normalization');

    pg.calls.length = 0;
    const legacy = await build(pg, { ...accepted, always_save_accepted_booking: false }, config);
    const legacyResult = await service.executeWolfhouseBookingCreate(pg, legacy.command);
    assert.equal(legacyResult.ok, true, JSON.stringify(legacyResult));
    // #1661 already made price/offer drift advisory without the new marker.
    // The SQL idempotency path may run, but it must not insert a duplicate.
    assert.equal((await pg.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
    const manual = await build(pg, { ...accepted, payment_choice: 'no_payment_yet' }, config, { channel: 'manual_staff' });
    assert.equal(manual.ok, true);
    assert.notEqual(manual.command.totalCents, acceptedQuote.total_cents);
    assert.equal(manual.command.notes, null);
    const sunset = await build(pg, accepted, config, { trustedClientSlug: 'sunset-somo' });
    assert.equal(sunset.body.reason_code, 'tenant_mismatch');
    assert.equal((await build(pg, { ...accepted, total_cents: 1 }, config)).body.reason_code, 'client_money_rejected');
    assert.equal((await build(pg, { ...accepted, check_out: 'bad' }, config)).body.reason_code, 'invalid_dates');
    for (const selected_bed_codes of [['R1-B1'], ['R1-B1', 'R1-B1'], ['R1-B1', 'bad!']]) {
      assert.equal((await build(pg, { ...accepted, selected_bed_codes }, config)).body.reason_code, 'invalid_bed_codes');
    }
    console.log('PASS legacy/manual/Sunset, model money and malformed date boundaries unchanged');

    pg.calls.length = 0;
    pg.wrongConversation = true;
    assert.equal((await service.executeWolfhouseBookingCreate(pg, changed.command)).body.reason_code, 'booking_conversation_location_mismatch');
    assert.equal(writer(pg), undefined);
    pg.wrongConversation = false;
    const denied = await service.executeWolfhouseBookingCreate(pg, changed.command, {
      authorizeAutomaticBooking: async () => ({ allowed: false, reason: 'booking_disabled' }),
    });
    assert.equal(denied.body.reason_code, 'booking_disabled');
    assert.equal(writer(pg), undefined);
    pg.saved = { ...saved[0], booking_id: saved[0].id, metadata: { operation_fingerprint: 'different' } };
    assert.equal((await service.executeWolfhouseBookingCreate(pg, changed.command)).body.reason_code, 'idempotency_payload_mismatch');
    pg.saved = null;
    console.log('PASS tenant conversation and idempotency protection unchanged');

    await pg.db.exec('DELETE FROM booking_beds; DELETE FROM bookings;');
    pg.calls.length = 0;
    pg.failWrite = true;
    await assert.rejects(() => service.executeWolfhouseBookingCreate(pg, changed.command), /fixture DB write failed/);
    assert.equal((await pg.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 0);
    assert.ok(pg.calls.some(c => c.sql === 'ROLLBACK'));
    console.log('PASS DB failure rolls back, never fabricated success');
  } finally { await pg.db.close(); }
}
// Python owner-dispatch integration: the payload is used verbatim, not repaired
// or replaced by a JS fixture. Only prerequisite reads use boundary fixtures.
async function persistOwnerPayload(payload) {
  const pg = await boundary();
  try {
    const { actualApiFunction } = require('./verify-package-minimum-transport');
    const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');
    const handleCreate = actualApiFunction('handleBotBookingCreate', {
      ...service, mapBotBookingCreateBlockedHttp,
      DEFAULT_CLIENT: SLUG, STAFF_AUTH_REQUIRED: false,
      readBody: async () => JSON.stringify(payload),
      sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
      stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
      resolveBotHandlerTrustedClientSlug: () => SLUG,
      withPgClient: fn => fn(pg),
      loadWolfhouseQuoteConfigWithOverlay: async () => loadConfig(),
      resolveWolfhouseAutomaticBookingAdmission: async () => ({ allowed: true }),
      isGeneratedBookingCodeCollision: () => false,
      appendAuditLog: () => {},
    });
    const result = await handleCreate({ headers: { 'x-luna-guest-phone': payload.phone } }, {}, null, 'bot_token');
    assert.equal(result.status, 201, JSON.stringify(result));
    assert.equal(result.body.success, true, JSON.stringify(result));
    assert.equal(result.body.write_performed, true, JSON.stringify(result));
    assert.ok(writer(pg), 'owner payload must reach the real atomic SQL writer');
    assert.equal(pg.calls.filter(c => c.sql === 'COMMIT').length, 1);
    const bookings = (await pg.db.query('SELECT * FROM bookings')).rows;
    const beds = (await pg.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    const payments = (await pg.db.query('SELECT * FROM payments')).rows;
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0].id, result.body.booking_id);
    assert.equal(beds.length, payload.guest_count);
    assert.ok(beds.every(b => b.booking_id === bookings[0].id));
    for (const warning of payload.booking_check_warnings || []) {
      assert.ok(bookings[0].staff_notes.includes(warning), `missing saved warning: ${warning}`);
    }
    return { response: result.body, bookings, beds, payments,
      atomic_sql_executed: true, commits: 1 };
  } finally { await pg.db.close(); }
}

module.exports = { boundary, build, persistOwnerPayload };
if (require.main === module) {
  const main = process.argv.includes('--owner-payload-stdin') ? async () => {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    process.stdout.write(JSON.stringify(await persistOwnerPayload(JSON.parse(raw))) + '\n');
  } : run;
  main().catch(err => { console.error(err); process.exitCode = 1; });
}
