#!/usr/bin/env node
'use strict';

// Real create HTTP handler + production builder/executor + in-memory SQL.
// No mocked query results or live transports. Supporting schema is the occupants
// fixture, not the full migration stack. Only draft payments exist in this DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { PGlite } = require('@electric-sql/pglite');
const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
const offer = require('./lib/luna-front-desk-accommodation-availability-service');
const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');

async function verifyWolfhouseOfferRetryHandler() {
  const db = new PGlite();
  const calls = [];
  const errors = [];
  const pg = { async query(sql, params = []) {
    calls.push(String(sql));
    try { return await db.query(sql, params); }
    catch (error) { errors.push(error.message); throw error; }
  } };
  const payload = {
    confirm: true, require_offer_identity: true, idempotency_key: 'offline-retry-pairs',
    check_in: '2026-10-20', check_out: '2026-10-22', guest_count: 2,
    guest_name: 'Lucia', guests: [{ name: 'Lucia' }, { name: 'Carmen' }],
    phone: '+999****1288', package_code: 'package_none', room_type: 'shared',
    group_gender: 'female', selected_bed_codes: ['R8-B1', 'R8-B2'], payment_choice: 'full',
  };
  try {
    await seedOfflineBookingDb(db, payload);
    // The minimal occupants fixture omits this real payments column; recovery
    // orders saved payments by it. This is test schema, not a product migration.
    await db.exec('ALTER TABLE payments ADD COLUMN created_at timestamptz DEFAULT now()');
    let requestBody;
    const lib = name => require('./lib/' + name);
    const context = {
      ...lib('bot-booking-package-normalize'), ...lib('staff-manual-booking-payment'),
      ...lib('wolfhouse-room-options'), ...lib('wolfhouse-quote-calculator'),
      ...lib('guest-addon-pricing'), ...lib('bot-quote-included-items'),
      ...lib('wolfhouse-package-night-rules'), ...lib('booking-guests'),
      ...lib('staff-bed-calendar-queries'), ...offer,
      ...service, mapBotBookingCreateBlockedHttp,
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true, DEFAULT_CLIENT: 'wolfhouse-somo',
      appendAuditLog() {}, readBody: async () => JSON.stringify(requestBody),
      resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
      loadWolfhouseQuoteConfigWithOverlay: () => service.loadBookingQuoteConfigWithOverlay(pg),
      withPgClient: fn => fn(pg),
      sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
    };
    const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
    const start = source.indexOf('async function handleBotBookingCreate(req, res, user, authMode) {');
    assert.ok(start >= 0, 'ordinary create handler must exist');
    vm.createContext(context);
    const previewStart = source.indexOf('async function handleBotBookingPreview(req, res, user, authMode) {');
    const constantsStart = source.indexOf('const BOT_BOOKING_REQUIRED_FIELDS = [');
    assert.ok(previewStart > constantsStart && constantsStart >= 0);
    vm.runInContext(source.slice(constantsStart, source.indexOf('\n}\n', previewStart) + 2), context);
    requestBody = structuredClone(payload);
    const preview = await context.handleBotBookingPreview({}, {}, null, 'offline');
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.equal(preview.body.availability.status, 'checked');
    assert.equal(JSON.stringify(preview.body.availability.selected_bed_codes), JSON.stringify(payload.selected_bed_codes));
    payload.accepted_offer = JSON.parse(JSON.stringify(preview.body.offer_revision));
    assert.ok(payload.accepted_offer.offer_fingerprint, 'accepted revision must be issued by ordinary preview');
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
    const invoke = async body => {
      requestBody = structuredClone(body);
      return context.handleBotBookingCreate({}, {}, null, 'offline');
    };
    const original = await invoke(payload);
    assert.equal(original.status, 201, JSON.stringify(original));
    assert.equal(original.body.write_performed, true);
    assert.equal(errors.length, 0, errors.join('\n'));
    const stored = (await db.query('SELECT metadata FROM bookings WHERE id=$1', [original.body.booking_id])).rows[0];
    assert.ok(stored.metadata.operation_fingerprint, 'production writer persisted the fingerprint');
    const occupants = (await db.query('SELECT guest_name, assigned_bed_code FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number', [original.body.booking_id])).rows;
    assert.deepEqual(occupants, [
      { guest_name: 'Lucia', assigned_bed_code: 'R8-B1' },
      { guest_name: 'Carmen', assigned_bed_code: 'R8-B2' },
    ]);

    // SQL readback is the oracle, not a hand-built saved-booking mock/fingerprint.
    const snapshot = async () => {
      const data = {};
      for (const table of ['bookings', 'booking_beds', 'booking_guests', 'payments', 'booking_service_records']) {
        data[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
      }
      return JSON.stringify(data);
    };
    const unchanged = await snapshot();
    calls.length = 0;
    const exact = await invoke(payload);
    assert.equal(exact.status, 200, JSON.stringify(exact));
    assert.equal(exact.body.duplicate, true);
    assert.equal(exact.body.idempotent, true);
    assert.equal(exact.body.created, false);
    assert.equal(exact.body.write_performed, false);
    assert.equal(exact.body.booking_id, original.body.booking_id);
    assert.equal(exact.body.payment_id, original.body.payment_id);
    assert.equal(JSON.stringify(exact.body.quote), JSON.stringify(stored.metadata.quote_snapshot));
    assert.equal(exact.body.sends_whatsapp, false);
    assert.equal(exact.body.creates_stripe_link, false);
    assert.ok(calls.every(sql => /^\s*(?:\/\*[\s\S]*?\*\/\s*)?SELECT\b/i.test(sql)), 'retry SQL is read-only');
    assert.equal(await snapshot(), unchanged, 'exact retry changes no persisted rows');
    console.log('PASS ordinary HTTP exact retry: persisted outcome, no writes, occupied beds unchanged');

    const failures = [];
    const refusals = [];
    async function expectRefused(label, body) {
      try {
        const before = await snapshot();
        calls.length = 0;
        const refused = await invoke(body);
        refusals.push({ label, response: refused });
        assert.equal(refused.status, 409, label);
        assert.equal(refused.body.reason_code, 'idempotency_payload_mismatch');
        assert.equal(refused.body.write_performed, false);
        assert.equal(refused.body.created, false);
        assert.equal(refused.body.do_not_escalate, true);
        assert.equal(refused.body.booking_id, undefined);
        assert.ok(calls.every(sql => /^\s*(?:\/\*[\s\S]*?\*\/\s*)?SELECT\b/i.test(sql)), 'refusal SQL is read-only');
        assert.equal(await snapshot(), before, 'refusal changes no persisted rows');
        console.log(`PASS ordinary HTTP ${label}: typed 409, no write`);
      } catch (error) { failures.push(`${label}: ${error.message}`); }
    }
    const reversed = structuredClone(payload);
    reversed.selected_bed_codes.reverse();
    await expectRefused('reversed person-to-bed pairs with the same accepted offer/key', reversed);

    // Simulate a pre-fingerprint booking by removing only that field from the
    // genuine committed metadata. Dates, lead, guest count, beds and quote match.
    await db.query("UPDATE bookings SET metadata = metadata - 'operation_fingerprint' WHERE id=$1", [original.body.booking_id]);
    await expectRefused('legacy recovery even with an identical request', payload);
    const changedLegacy = structuredClone(payload);
    changedLegacy.phone = '+999****7777';
    changedLegacy.guests[1].name = 'Other Person';
    await expectRefused('legacy recovery with changed phone/second guest', changedLegacy);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(failures.length, 0, failures.join('\n'));
    return { evidence_mode: 'offline real preview/create handlers and SQL; minimal supporting schema; no live transport',
      preview, original, exact, refusals, occupants };
  } finally { await db.close(); }
}

module.exports = { verifyWolfhouseOfferRetryHandler };
if (require.main === module) verifyWolfhouseOfferRetryHandler().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
