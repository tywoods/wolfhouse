'use strict';

// Offline integration gate: real committed DDL and SQL persistence, no listeners.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');
const WH = 'wolfhouse-somo';
const bookingId = '00000000-0000-4000-8000-000000000001';
const sunsetId = '00000000-0000-4000-8000-000000000002';

// Shared with the browser gate: responses come from the production dispatcher and SQL.
async function createHarness() {
  const db = new PGlite();
  const queries = [];
  const pg = { query: async (sql, args) => {
    queries.push({ sql, args });
    return db.query(sql, args);
  } };
  const connectPath = require.resolve('./lib/pg-connect');
  const previous = require.cache[connectPath];
  require.cache[connectPath] = { id: connectPath, filename: connectPath, loaded: true,
    exports: { withPgClient: (fn) => fn(pg) } };
  const routes = require('./lib/staff-booking-transfers-routes');
  const request = (body) => Readable.from([Buffer.from(JSON.stringify(body))]);
  async function dispatch(method, body = {}, slug = WH, id = bookingId) {
    const req = request({ client_slug: slug, direction: 'arrival', airport_code: 'SDR', ...body });
    req.method = method;
    const res = { statusCode: 0, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
    assert.equal(await routes.dispatchBookingTransfersRoute(req, res,
      `/staff/bookings/${id}/transfers`, { client_slug: slug }), true);
    return { status: res.statusCode, body: res.body };
  }
  async function fare(code, amount, unit) {
    await db.query("DELETE FROM wh_pricing_rules WHERE client_slug=$1 AND item_type='transfer' AND item_code=$2", [WH, code]);
    if (amount != null) await db.query(`INSERT INTO wh_pricing_rules
      (client_slug,item_type,item_code,amount_cents,unit) VALUES ($1,'transfer',$2,$3,$4)`, [WH, code, amount, unit]);
  }
  // Accepted ADMIN input and real store SQL, not a hand-authored Transfer response.
  async function adminFare(code, amount, unit, currency = 'EUR') {
    const { validatePriceRuleBody } = require('./lib/wolfhouse-pricing-writes');
    const { savePriceRule } = require('./lib/wolfhouse-pricing-store');
    const validated = validatePriceRuleBody({ item_type: 'transfer', item_code: code, amount_cents: amount, unit, currency });
    assert.equal(validated.ok, true, JSON.stringify(validated));
    const row = await savePriceRule(pg, WH, validated.value, null);
    const stored = (await db.query('SELECT amount_cents,unit,currency FROM wh_pricing_rules WHERE id=$1', [row.id])).rows[0];
    assert.deepEqual(stored, { amount_cents: amount, unit, currency });
    return row;
  }
  const saved = async (id = bookingId) => (await db.query(
    'SELECT * FROM booking_transfers WHERE booking_id=$1 ORDER BY direction', [id])).rows;
  const close = async () => {
    if (previous) require.cache[connectPath] = previous;
    else delete require.cache[connectPath];
    delete require.cache[require.resolve('./lib/staff-booking-transfers-routes')];
    await db.close();
  };
  try {
    await db.exec(`CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL);
      CREATE TABLE staff_users (id uuid PRIMARY KEY);
      CREATE TABLE bookings (id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id), booking_code text,
        guest_count int, package_code text, check_in date, check_out date, status text, payment_status text);
      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END $$;
      INSERT INTO clients VALUES ('10000000-0000-4000-8000-000000000001','wolfhouse-somo'),
        ('10000000-0000-4000-8000-000000000002','sunset');
      INSERT INTO bookings VALUES ('${bookingId}','10000000-0000-4000-8000-000000000001','WH-TEST',3,NULL,'2026-10-01','2026-10-08','confirmed','unpaid'),
        ('${sunsetId}','10000000-0000-4000-8000-000000000002','SUN-TEST',3,NULL,'2026-10-01','2026-10-08','confirmed','unpaid');`);
    for (const migration of ['017_booking_transfers.sql', '076_wolfhouse_pricing_admin.sql', '109_wh_transfer_max_guest_count.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', migration), 'utf8'));
    }
    return { db, pg, queries, routes, request, dispatch, fare, adminFare, saved, close, bookingId };
  } catch (error) { await close(); throw error; }
}

async function verifyAdminCurrency() {
  const h = await createHarness();
  try {
    const { loadStaffTransferConfig } = require('./lib/staff-transfer-pricing');
    const booking = (await h.db.query('SELECT id AS booking_id,guest_count,package_code FROM bookings WHERE id=$1', [bookingId])).rows[0];
    for (const unit of ['flat', 'per_person']) {
      await h.adminFare('SDR', 1950, unit, 'GBP');
      const total = unit === 'flat' ? 1950 : 5850;
      const get = await h.dispatch('GET');
      assert.equal(get.status, 200);
      assert.equal(get.body.admin_prices.SDR.currency, 'GBP', 'accepted ADMIN GBP must remain GBP in Staff reference');
      assert.equal(get.body.admin_prices.SDR.price_cents, total);
      for (const direction of ['arrival', 'departure']) {
        const post = await h.dispatch('POST', { direction });
        assert.equal(post.status, 200);
        assert.equal(post.body.pricing.currency, 'GBP', 'Staff POST must not relabel GBP as EUR');
        assert.equal(post.body.pricing.price_cents, total);
        assert.deepEqual(post.body.pricing, post.body.transfer.pricing);
        const row = (await h.saved()).find(r => r.direction === direction);
        assert.equal(row.currency, 'GBP', 'independent SQL currency readback');
        assert.equal(row.price_cents, total, 'currency preservation is not FX conversion');
      }
      const embedded = h.routes.buildTransfersDrawerPayload(WH, booking, await h.saved(), { resolvedConfig: await loadStaffTransferConfig(h.pg, WH) });
      assert.equal(embedded.admin_prices.SDR.currency, 'GBP');
      assert.equal(embedded.admin_prices.SDR.price_cents, total);
      for (const response of [(await h.dispatch('GET')).body, embedded]) {
        for (const row of response.transfers) {
          assert.equal(row.pricing.currency, 'GBP');
          assert.equal(row.pricing.price_cents, total);
        }
      }
      console.log('ok: production ADMIN validator/store GBP1950', unit, 'GET/embedded/both POST directions + SQL', total);
    }
  } finally { await h.close(); }
}

// Literal business expectations shared with the emitted-HTML browser gate, not
// computed with the production quote/formatter under test. Three guests.
const ADMIN_CENT_CASES = [
  { amount: 1950, unit: 'flat', currency: 'EUR', total: 1950, rate: '€19.50', note: 'Santander transfer: €19.50 flat.' },
  { amount: 1950, unit: 'per_person', currency: 'EUR', total: 5850, rate: '€19.50', note: 'Santander transfer: €19.50/person × 3 = €58.50 extra.' },
  { amount: 25, unit: 'per_person', currency: 'EUR', total: 75, rate: '€0.25', note: 'Santander transfer: €0.25/person × 3 = €0.75 extra.' },
  { amount: 1950, unit: 'flat', currency: 'GBP', total: 1950, rate: 'GBP 19.50', note: 'Santander transfer: GBP 19.50 flat.' },
  { amount: 1950, unit: 'per_person', currency: 'GBP', total: 5850, rate: 'GBP 19.50', note: 'Santander transfer: GBP 19.50/person × 3 = GBP 58.50 extra.' },
];

async function verifyAdminExactCents() {
  const h = await createHarness();
  try {
    const { loadStaffTransferConfig } = require('./lib/staff-transfer-pricing');
    const booking = (await h.db.query('SELECT id AS booking_id,guest_count,package_code FROM bookings WHERE id=$1', [bookingId])).rows[0];
    for (const c of ADMIN_CENT_CASES) {
      await h.adminFare('SDR', c.amount, c.unit, c.currency);
      const get = await h.dispatch('GET');
      assert.equal(get.status, 200);
      assert.equal(get.body.admin_prices.SDR.pricing_note, c.note, 'current Staff quote must describe exact cents, not whole-euro rounding');
      assert.equal(get.body.admin_prices.SDR.currency, c.currency);
      assert.equal(get.body.admin_prices.SDR.price_cents, c.total);
      for (const direction of ['arrival', 'departure']) {
        const post = await h.dispatch('POST', { direction });
        assert.equal(post.status, 200);
        assert.deepEqual(post.body.pricing, post.body.transfer.pricing);
        const row = (await h.saved()).find(r => r.direction === direction);
        for (const quote of [post.body.pricing, row]) {
          assert.equal(quote.price_cents, c.total);
          assert.equal(quote.currency, c.currency);
          assert.equal(quote.pricing_note, c.note, 'new saved notes cannot contradict the charge');
        }
      }
      const before = await h.saved();
      // Current ADMIN reference changes currency and amount, without FX or history rewrite.
      await h.adminFare('SDR', 4200, 'flat', c.currency === 'EUR' ? 'GBP' : 'EUR');
      const embedded = h.routes.buildTransfersDrawerPayload(WH, booking, before, { resolvedConfig: await loadStaffTransferConfig(h.pg, WH) });
      for (const response of [(await h.dispatch('GET')).body, embedded]) {
        assert.equal(response.admin_prices.SDR.price_cents, 4200);
        assert.notEqual(response.admin_prices.SDR.currency, c.currency);
        for (const row of response.transfers) {
          assert.equal(row.pricing.price_cents, c.total);
          assert.equal(row.pricing.currency, c.currency);
          assert.equal(row.pricing.pricing_note, c.note);
        }
      }
      assert.deepEqual(await h.saved(), before, 'reference reads never rewrite historical notes');
      for (const direction of ['arrival', 'departure']) {
        const zero = await h.dispatch('POST', { direction, manual_override_enabled: true, manual_override_euros: 0 });
        assert.equal(zero.status, 200);
        assert.equal(zero.body.pricing.price_cents, 0);
        assert.deepEqual(zero.body.pricing, zero.body.transfer.pricing);
        assert.equal((await h.saved()).find(r => r.direction === direction).price_cents, 0);
      }
      console.log('ok: production ADMIN cents/reference/saved note/history/custom zero both directions', JSON.stringify(c));
    }
  } finally { await h.close(); }
}

async function main() {
  // Each scenario owns a WASM database. Reclaim it at process exit instead of
  // retaining multiple PGlite heaps on memory-constrained offline runners.
  const cases = { currency: verifyAdminCurrency, cents: verifyAdminExactCents, snapshots: verifySnapshots };
  const selected = process.argv[2];
  if (selected) {
    assert.ok(Object.hasOwn(cases, selected), 'known verification scenario');
    return cases[selected]();
  }
  const { spawnSync } = require('node:child_process');
  for (const name of Object.keys(cases)) {
    const run = spawnSync(process.execPath, [__filename, name], { stdio: 'inherit', timeout: 120000 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, `${name} scenario failed`);
  }
}

async function verifySnapshots() {
  const { db, pg, queries, routes, request, dispatch, fare, saved, close } = await createHarness();
  try {
    console.log('Fixture: PGlite; committed migrations 017 + 076 + 109; minimal clients/bookings/staff_users.');
    await fare('SDR', 1700, 'per_person');
    const result = await dispatch('POST');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal((await saved())[0].price_cents, 5100, 'Staff dispatcher must persist ADMIN per-person fare × guests');
    console.log('ok: ADMIN per-person dispatcher POST independently read back 5100 cents');
    await fare('SDR', 4200, 'flat');
    const drawer = await dispatch('GET');
    assert.equal(drawer.status, 200);
    assert.ok(drawer.body.admin_prices, 'GET must expose resolved admin_prices');
    assert.deepEqual(Object.fromEntries(['amount_cents', 'unit', 'source', 'price_cents', 'currency'].map(
      (key) => [key, drawer.body.admin_prices.SDR[key]])),
    { amount_cents: 4200, unit: 'flat', source: 'db', price_cents: 4200, currency: 'EUR' });
    assert.equal(drawer.body.transfers[0].price_cents, 5100, 'saved invoice snapshot must not be repriced by GET');
    assert.equal(drawer.body.transfers[0].pricing.price_cents, 5100, 'displayed saved charge must retain history, not the current ADMIN quote');
    assert.equal((await saved())[0].price_cents, 5100);
    const { loadStaffTransferConfig: loadSnapshotConfig } = require('./lib/staff-transfer-pricing');
    const snapshotConfig = await loadSnapshotConfig(pg, WH);
    const snapshotBooking = { booking_id: bookingId, guest_count: 3 };
    for (const direction of ['arrival', 'departure']) {
      const zeroPost = await dispatch('POST', { direction, manual_override_euros: 0 });
      assert.equal(zeroPost.status, 200);
      assert.equal(zeroPost.body.pricing.price_cents, 0, 'POST top-level charge must be persisted custom zero');
      assert.deepEqual(zeroPost.body.pricing, zeroPost.body.transfer.pricing);
      assert.equal(zeroPost.body.pricing.pricing_note, 'Manual transfer override');
      for (const snapshot of [
        { price: 1900, currency: 'GBP', note: 'Historical charge', included: false },
        { price: 0, currency: 'EUR', note: 'Manual transfer override', included: false },
        { price: null, currency: 'EUR', note: 'Historical amount unknown', included: false },
        { price: null, currency: 'EUR', note: null, included: false },
        { price: 0, currency: 'EUR', note: 'Historical package', included: true },
      ]) {
        await db.query('UPDATE booking_transfers SET price_cents=$3,currency=$4,pricing_note=$5,included_in_package=$6 WHERE booking_id=$1 AND direction=$2',
          [bookingId, direction, snapshot.price, snapshot.currency, snapshot.note, snapshot.included]);
        const before = await saved();
        const get = (await dispatch('GET')).body;
        const embeddedSnapshot = routes.buildTransfersDrawerPayload(WH, snapshotBooking, before, { resolvedConfig: snapshotConfig });
        for (const response of [get, embeddedSnapshot]) {
          assert.equal(response.admin_prices.SDR.amount_cents, 4200);
          assert.equal(response.admin_prices.SDR.included_in_package, false);
          const row = response.transfers.find((r) => r.direction === direction);
          for (const field of ['price_cents', 'currency', 'included_in_package', 'pricing_note']) {
            assert.equal(row.pricing[field], row[field], `${direction} saved ${field} must match persistence`);
          }
          assert.equal(row.pricing.available, snapshot.price !== null || snapshot.included);
          if (row.pricing.available) assert.equal(row.pricing.error_code, null);
        }
        assert.deepEqual(await saved(), before, 'GET and embedded assembly do not mutate stored charges');
      }
    }
    await db.query("DELETE FROM booking_transfers WHERE booking_id=$1 AND direction='departure'", [bookingId]);
    console.log('ok: both directions GET/embedded historic GBP, custom zero, null with/without note, included; POST top-level zero; read-only snapshots');
    const group = await dispatch('POST');
    assert.equal(group.body.pricing.price_cents, 4200);
    assert.equal((await saved())[0].price_cents, 4200, 'flat fare charged once, not multiplied');
    console.log('ok: GET current ADMIN flat fare versus saved snapshot; POST group fare once');
    await db.query(`INSERT INTO wh_pricing_transfer_rules
      (client_slug,airport_code,label,aliases) VALUES ($1,'MAD','Madrid',ARRAY['barajas'])`, [WH]);
    const noFare = await dispatch('POST', { airport_code: 'barajas' });
    assert.equal(noFare.status, 200);
    assert.equal((await saved())[0].airport_code, 'MAD');
    assert.equal((await saved())[0].price_cents, null, 'missing custom fare must not become zero');
    assert.equal(noFare.body.pricing.available, false);
    assert.equal(noFare.body.pricing.error_code, 'transfer_price_unavailable');
    assert.equal(noFare.body.pricing.price_cents, null);
    assert.deepEqual(noFare.body.pricing, noFare.body.transfer.pricing);
    console.log('ok: custom alias airport without fare is unavailable, persisted price NULL');
    await fare('MAD', 900, 'per_person');
    await db.query("UPDATE wh_pricing_transfer_rules SET min_guest_count=4 WHERE airport_code='MAD'");
    const beforeMinimum = await saved();
    const tooSmall = await dispatch('POST', { airport_code: 'MAD' });
    assert.equal(tooSmall.status, 400, 'ADMIN custom airport minimum must block save without explicit amount');
    assert.deepEqual(await saved(), beforeMinimum);
    const exception = await dispatch('POST', { airport_code: 'MAD', manual_override_enabled: true, manual_override_euros: 0 });
    assert.equal(exception.status, 200);
    assert.equal((await saved())[0].price_cents, 0);
    assert.equal((await saved())[0].pricing_note, 'Manual transfer override');
    assert.equal(exception.body.pricing.price_cents, 0);
    assert.deepEqual(exception.body.pricing, exception.body.transfer.pricing);
    console.log('ok: ADMIN minimum enforced before writes; explicit zero exception persists');
    // Preservation matrix: these exercise existing policies, not new behavior slices.
    await db.query("UPDATE wh_pricing_transfer_rules SET min_guest_count=NULL WHERE airport_code='MAD'");
    for (const unit of ['flat', 'per_person']) {
      await fare('MAD', 0, unit);
      const zero = await dispatch('POST', { airport_code: 'Madrid' });
      assert.equal(zero.status, 200);
      assert.equal(zero.body.pricing.available, true);
      assert.equal((await saved())[0].price_cents, 0);
      const getZero = await dispatch('GET');
      assert.equal(getZero.body.admin_prices.MAD.amount_cents, 0);
      assert.equal(getZero.body.admin_prices.MAD.unit, unit);
      assert.equal(getZero.body.transfers[0].price_cents, 0);
    }
    await fare('MAD', null);
    const resetCustom = await dispatch('GET');
    assert.equal(resetCustom.body.admin_prices.MAD.available, false);
    assert.equal(resetCustom.body.admin_prices.MAD.amount_cents, null);
    assert.equal(resetCustom.body.transfers[0].price_cents, 0);
    await db.query("UPDATE wh_pricing_transfer_rules SET active=false WHERE airport_code='MAD'");
    assert.equal((await dispatch('GET')).body.airports.some((a) => a.code === 'MAD'), false);
    await db.query("DELETE FROM wh_pricing_transfer_rules WHERE airport_code='MAD'");
    assert.equal((await dispatch('GET')).body.airports.some((a) => a.code === 'MAD'), false);
    const deleteRes = { status(code) { this.code=code; return this; }, json(body) { this.body=body; return this; } };
    await routes.handleDeleteBookingTransfer(bookingId, 'arrival', { client_slug: WH }, deleteRes);
    assert.equal(deleteRes.code, 200);
    assert.equal((await saved()).length, 0);
    console.log('ok: custom zero flat/person save + GET; fare reset keeps snapshot; inactive/deleted custom removed; direction delete');

    await db.query("UPDATE wh_pricing_rules SET active=false WHERE item_code='SDR'");
    assert.equal((await dispatch('GET')).body.admin_prices.SDR.amount_cents, 2500);
    assert.equal((await dispatch('GET')).body.admin_prices.SDR.source, 'config');
    await fare('SDR', null);
    await db.query(`INSERT INTO wh_pricing_transfer_rules (client_slug,airport_code,label,active)
      VALUES ($1,'BIO','Inactive Bilbao',false)`, [WH]);
    const seed = await dispatch('GET');
    assert.equal(seed.body.admin_prices.BIO.error_code, 'bilbao_package_required');
    assert.equal(seed.body.admin_prices.BIO.amount_cents, 1500);
    assert.equal(seed.body.admin_prices.BIO.unit, 'per_person');
    assert.equal(seed.body.airports.find((a) => a.code === 'BIO').label, 'Bilbao');
    await db.query("UPDATE bookings SET package_code='malibu' WHERE id=$1", [bookingId]);
    const includedPost = await dispatch('POST');
    assert.equal(includedPost.status, 200);
    assert.equal((await saved())[0].price_cents, 0);
    assert.equal((await saved())[0].included_in_package, true);
    assert.equal(includedPost.body.pricing.included_in_package, true);
    assert.equal(includedPost.body.pricing.price_cents, 0);
    assert.deepEqual(includedPost.body.pricing, includedPost.body.transfer.pricing);
    assert.equal((await dispatch('POST', { airport_code: 'BIO' })).status, 400);
    assert.equal((await dispatch('POST', { airport_code: 'BIO', manual_override_enabled: true })).status, 400);
    assert.equal((await dispatch('POST', { airport_code: 'BIO', manual_override_euros: -1 })).status, 400);
    assert.equal((await dispatch('POST', { airport_code: 'BIO', guest_count: 4 })).status, 200);
    assert.equal((await saved())[0].price_cents, 6000);
    await fare('BIO', 8100, 'flat');
    assert.equal((await dispatch('POST', { airport_code: 'BIO', guest_count: 4 })).status, 200);
    assert.equal((await saved())[0].price_cents, 8100);
    await db.query("UPDATE bookings SET package_code=NULL WHERE id=$1", [bookingId]);
    const unknown = await dispatch('POST', { airport_code: 'XXX' });
    assert.equal(unknown.body.pricing.available, false);
    assert.equal((await saved())[0].price_cents, null);
    console.log('ok: inactive/removed seed overrides fall back; SDR package inclusion; BIO package/minimum/person/flat; unknown unavailable');

    await fare('SDR', 1900, 'per_person');
    const beforeInternal = queries.length;
    const internalRes = { status(code) { this.code=code; return this; }, json(body) { this.body=body; return this; } };
    await routes.handlePostBookingTransfer(bookingId, request({ client_slug: WH, direction: 'arrival', airport_code: 'SDR', source: 'luna' }), internalRes);
    assert.equal(internalRes.code, 200);
    assert.equal((await saved())[0].price_cents, 2500);
    assert.equal((await saved())[0].source, 'luna');
    assert.equal(internalRes.body.pricing.currency, 'EUR');
    assert.equal(internalRes.body.pricing.pricing_note, 'Santander transfer: €25 flat.', 'internal/Luna static note must remain byte-for-byte unchanged');
    assert.equal(internalRes.body.pricing.saved_charge, undefined, 'internal Luna response contract unchanged');
    assert.equal(queries.slice(beforeInternal).some((q) => /wh_pricing/.test(q.sql)), false);
    const beforeSunset = queries.length;
    const sunsetGet = await dispatch('GET', {}, 'sunset', sunsetId);
    assert.equal(sunsetGet.status, 200);
    assert.deepEqual(sunsetGet.body.airports, []);
    assert.deepEqual(sunsetGet.body.admin_prices, {});
    const sunsetPost = await dispatch('POST', {}, 'sunset', sunsetId);
    assert.equal(sunsetPost.status, 200);
    assert.equal(sunsetPost.body.pricing.error_code, 'airport_not_supported');
    assert.equal((await saved(sunsetId))[0].price_cents, null);
    assert.equal(queries.slice(beforeSunset).some((q) => /wh_pricing/.test(q.sql)), false);
    const { loadStaffTransferConfig } = require('./lib/staff-transfer-pricing');
    const config = await loadStaffTransferConfig(pg, WH);
    assert.deepEqual(config.rules.find((r) => r.airport_code === 'SDR').price,
      { amount_cents: 1900, currency: 'EUR', unit: 'per_person', source: 'db' });
    const embedded = routes.buildTransfersDrawerPayload(WH, { booking_id: bookingId, guest_count: 3 }, [], { resolvedConfig: config });
    assert.equal(embedded.admin_prices.SDR.price_cents, 5700);
    assert.equal(queries.some((q) => /\b(?:CREATE|ALTER)\b|wh_pricing_items|wh_pricing_seasons/i.test(q.sql)), false, 'request path must never perform DDL/catalog reads or writes');
    console.log('ok: internal Luna default unchanged; Sunset GET/POST no Wolfhouse SQL; resolver + embedded contract; no request DDL/catalog');

    const beforeFailure = await saved();
    for (const table of ['wh_pricing_rules', 'wh_pricing_transfer_rules']) {
      await db.exec(`ALTER TABLE ${table} RENAME TO hidden_pricing_table`);
      const badGet = await dispatch('GET');
      assert.equal(badGet.status, 500);
      assert.match(badGet.body.detail, new RegExp(table));
      const badPost = await dispatch('POST');
      assert.equal(badPost.status, 500, 'overlay SQL errors must be visible, not misreported as missing booking_transfers');
      assert.match(badPost.body.detail, new RegExp(table));
      assert.deepEqual(await saved(), beforeFailure, 'SQL failure must not write a transfer');
      await db.exec(`ALTER TABLE hidden_pricing_table RENAME TO ${table}`);
    }
    console.log('ok: real SQL failures in either overlay table visible on GET/POST; no writes');
    await db.query(`UPDATE wh_pricing_transfer_rules SET active=true, requires_package=false,
      min_guest_count=2, included_when_package=false WHERE airport_code='BIO'`);
    assert.equal((await dispatch('POST', { airport_code: 'BIO' })).status, 200);
    assert.equal((await saved())[0].price_cents, 8100, 'ADMIN can relax the seeded BIO package/minimum rules');
    await fare('SDR', 3300, 'flat');
    assert.equal((await dispatch('POST', { manual_override_euros: 0 })).status, 200);
    assert.equal((await saved())[0].price_cents, 0);
    assert.equal((await dispatch('GET')).body.transfers[0].price_cents, 0);
    assert.equal((await dispatch('POST')).status, 200);
    assert.equal((await saved())[0].price_cents, 3300, 'resetting booking custom fare uses current ADMIN fare');
    const persisted = (await saved())[0];
    console.log('SQL readback:', JSON.stringify({ airport_code: persisted.airport_code,
      price_cents: persisted.price_cents, guest_count: persisted.guest_count, source: persisted.source }));
    await db.exec('ALTER TABLE booking_transfers RENAME TO hidden_booking_transfers');
    const missingTransfers = await dispatch('GET');
    assert.equal(missingTransfers.status, 200);
    assert.equal(missingTransfers.body.transfers_available, false);
    assert.equal((await dispatch('POST')).status, 503);
    console.log('ok: ADMIN eligibility overrides; zero custom fare reset; missing booking_transfers compatibility');
    console.log('Focused backend verification completed; independent parent review/seal still required.');
  } finally {
    await close();
  }
}
module.exports = { createHarness, ADMIN_CENT_CASES };
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
