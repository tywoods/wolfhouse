'use strict';

// Connected regression mode: consume the exact Python accepted_quote.prepare_create
// wire payload on stdin, then run the production Staff bridge, create service, SQL
// writer, commit, and authoritative readback against one ephemeral PGlite database.
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const { seedOfflineBookingDb, makeOfflineBookingPg } = require('./verify-luna-create-booking-occupants');
const createService = require('./lib/luna-front-desk-accommodation-booking-create-service');
const requestTenant = require('./lib/staff-bot-request-tenant-bind');
const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');
const { loadCancellationGuestBookings, mapCancellationGuestBookingRows } = require('./lib/luna-guest-booking-disambiguation');

const CLIENT_SLUG = 'wolfhouse-somo';

function sendJSON(res, status, body) {
  if (res && typeof res.end === 'function') {
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }
  return { status, body };
}
function httpDeps(body) {
  return {
    DEFAULT_CLIENT: CLIENT_SLUG,
    readBody: async () => JSON.stringify(body),
    sendJSON,
    send400: (res, error) => sendJSON(res, 400, { success: false, error }),
  };
}
async function stdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

(async () => {
  const payload = await stdinJson();
  assert.equal(payload.require_offer_identity, true, 'Python payload must turn the Staff offer gate on');
  assert.equal(payload.confirm, true);
  assert(Array.isArray(payload.selected_bed_codes) && payload.selected_bed_codes.length > 0);
  assert(payload.check_in && payload.check_out, 'inventory fixture follows payload dates');
  payload.phone = payload.phone || '+34612341569';
  payload.guest_name = payload.guest_name || payload.guests[0].name;

  const db = new PGlite();
  try {
    // Seed only prerequisites and inventory, parameterized by the accepted payload.
    await seedOfflineBookingDb(db, payload);
    const conversation = (await db.query(
      `SELECT cv.id::text AS id FROM conversations cv JOIN clients c ON c.id = cv.client_id
        WHERE c.slug = $1 AND cv.phone = $2`, [CLIENT_SLUG, payload.phone])).rows[0];
    assert(conversation, 'payload owner must resolve to a real conversation');
    payload.conversation_id = conversation.id;

    const pg = makeOfflineBookingPg(db);
    const deps = {
      ...httpDeps(payload), ...requestTenant, ...createService, mapBotBookingCreateBlockedHttp,
      isGeneratedBookingCodeCollision: () => false,
      stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
      resolveWolfhouseAutomaticBookingAdmission: async () => ({ allowed: true, reason: null }),
      withPgClient: (fn) => fn(pg),
      loadWolfhouseQuoteConfigWithOverlay: async () => undefined,
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: false, appendAuditLog: () => {},
    };
    const actualCreate = actualApiFunction('handleBotBookingCreate', deps);
    const createFromPlan = require('./lib/staff-bot-v2-routes').handleBotBookingCreateFromPlan;
    const result = await createFromPlan(
      { headers: { 'x-luna-guest-phone': payload.phone } }, {}, null, 'bot_token', {
        ...httpDeps(payload), ...requestTenant, handleBotBookingCreate: actualCreate,
        appendAuditLog: () => {}, STAFF_AUTH_REQUIRED: false,
        stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
        STRIPE_LINKS_ENABLED: false, STRIPE_SECRET_KEY: '', process: { env: {} },
      });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.success, true);
    assert.equal(result.body.write_performed, true);
    assert.match(result.body.booking_code, /^WH-/);
    assert.equal(pg.calls.filter((call) => call.kind === 'commit').length, 1,
      'real writer must commit exactly once');

    const readRoute = actualApiFunction('handleBotListBookingsByPhone', {
      ...httpDeps({ phone: payload.phone }),
      resolveBotHandlerTrustedClientSlug: () => CLIENT_SLUG,
      SQL_INJECT_RE: /$a/,
      withPgClient: (fn) => fn(db),
      loadCancellationGuestBookings, mapCancellationGuestBookingRows,
    });
    const readback = await readRoute({}, {}, null, 'bot_token');
    assert.equal(readback.status, 200);
    assert.equal(readback.body.count, 1, JSON.stringify(readback.body));
    assert.equal(readback.body.bookings[0].booking_id, result.body.booking_id);
    assert.equal(readback.body.bookings[0].conversation_id, conversation.id);
    console.log(JSON.stringify({ booking_code: result.body.booking_code,
      booking_id: result.body.booking_id, conversation_id: conversation.id }));
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
