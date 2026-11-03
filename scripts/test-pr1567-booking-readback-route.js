'use strict';

const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const {
  seedOfflineBookingDb,
  makeOfflineBookingPg,
} = require('./verify-luna-create-booking-occupants');
const createService = require('./lib/luna-front-desk-accommodation-booking-create-service');
const requestTenant = require('./lib/staff-bot-request-tenant-bind');
const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');
const {
  loadCancellationGuestBookings,
  mapCancellationGuestBookingRows,
} = require('./lib/luna-guest-booking-disambiguation');

const CLIENT_SLUG = 'wolfhouse-somo';
const PHONE = '+34600111569';

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

(async () => {
  const db = new PGlite();
  try {
    // A new, accepted owner payload: no saved booking/receipt is seeded. The
    // only pre-existing state is the real conversation and sellable inventory.
    const acceptedOwnerPayload = {
      confirm: true,
      check_in: '2026-07-06',
      check_out: '2026-07-09',
      guest_count: 1,
      guest_name: 'Fresh Owner Acceptance',
      guests: [{ name: 'Fresh Owner Acceptance' }],
      phone: PHONE,
      package_code: 'package_none',
      room_type: 'shared',
      group_gender: 'mixed',
      selected_bed_codes: ['R3-B1'],
      payment_choice: 'full',
      source: 'owner_first_acceptance',
    };
    await seedOfflineBookingDb(db, acceptedOwnerPayload);
    const conversation = (await db.query(
      `SELECT cv.id::text AS id
         FROM conversations cv
         JOIN clients c ON c.id = cv.client_id
        WHERE c.slug = $1 AND cv.phone = $2`,
      [CLIENT_SLUG, PHONE],
    )).rows[0];
    assert(conversation, 'fresh accepted payload must have a genuine conversation owner');
    acceptedOwnerPayload.conversation_id = conversation.id;

    const pg = makeOfflineBookingPg(db);
    const deps = {
      ...httpDeps(acceptedOwnerPayload),
      ...requestTenant,
      ...createService,
      mapBotBookingCreateBlockedHttp,
      isGeneratedBookingCodeCollision: () => false,
      stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
      resolveWolfhouseAutomaticBookingAdmission: async (_tx, input) => ({
        allowed: input.client_slug === CLIENT_SLUG && input.guest_phone === PHONE,
        reason: null,
      }),
      withPgClient: (fn) => fn(pg),
      loadWolfhouseQuoteConfigWithOverlay: async () => undefined,
      BOT_BOOKING_ENABLED: true,
      STAFF_AUTH_REQUIRED: false,
      appendAuditLog: () => {},
    };
    const actualCreate = actualApiFunction('handleBotBookingCreate', deps);
    const createFromPlan = require('./lib/staff-bot-v2-routes').handleBotBookingCreateFromPlan;
    const create = await createFromPlan({ headers: { 'x-luna-guest-phone': PHONE } }, {}, null, 'bot_token', {
      ...httpDeps(acceptedOwnerPayload),
      ...requestTenant,
      handleBotBookingCreate: actualCreate,
      appendAuditLog: () => {},
      STAFF_AUTH_REQUIRED: false,
      stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
      handlePostBookingTransfer: () => { throw Error('no transfer requested'); },
      handleBotGuestPaymentCreateLink: () => { throw Error('no payment link requested'); },
      STRIPE_LINKS_ENABLED: false,
      STRIPE_SECRET_KEY: '',
      process: { env: {} },
    });
    assert.equal(create.status, 201, JSON.stringify(create.body));
    assert.equal(create.body.success, true);
    assert.equal(create.body.write_performed, true);
    assert.equal(create.body.created, true);
    assert.ok(create.body.booking_id);
    assert.ok(create.body.booking_code);
    assert.equal(pg.calls.filter((call) => call.kind === 'booking_create').length, 1);
    assert.equal(pg.calls.filter((call) => call.kind === 'conversation_booking_link').length, 1);
    assert.equal(pg.calls.filter((call) => call.kind === 'commit').length, 1);

    // Authoritative list_my_bookings route, executing its production SQL against
    // the same committed PGlite state (no fabricated row or receipt).
    const route = actualApiFunction('handleBotListBookingsByPhone', {
      ...httpDeps({ phone: PHONE }),
      resolveBotHandlerTrustedClientSlug: () => CLIENT_SLUG,
      SQL_INJECT_RE: /$a/,
      withPgClient: (fn) => fn(db),
      loadCancellationGuestBookings,
      mapCancellationGuestBookingRows,
    });
    const readback = await route({}, {}, null, 'bot_token');
    assert.equal(readback.status, 200);
    assert.equal(readback.body.success, true);
    assert.equal(readback.body.count, 1);
    assert.equal(readback.body.bookings[0].booking_id, create.body.booking_id);
    assert.equal(readback.body.bookings[0].booking_code, create.body.booking_code);
    assert.equal(readback.body.bookings[0].conversation_id, conversation.id);

    const durable = (await db.query(
      `SELECT b.id::text AS booking_id, b.booking_code,
              b.metadata->>'conversation_id' AS metadata_conversation_id,
              cv.id::text AS conversation_id, cv.current_hold_booking_id::text AS current_hold_booking_id
         FROM bookings b
         JOIN conversations cv ON cv.current_hold_booking_id = b.id
        WHERE b.id = $1`,
      [create.body.booking_id],
    )).rows[0];
    assert.equal(durable.booking_id, create.body.booking_id);
    assert.equal(durable.current_hold_booking_id, create.body.booking_id);
    assert.equal(durable.conversation_id, conversation.id);
    assert.equal(durable.metadata_conversation_id, conversation.id);

    // Preserve fail-closed behavior: if the booking is linked to two
    // conversations, the read route must not present either as authoritative.
    await db.query(
      `INSERT INTO conversations (client_id, phone, display_name, language, current_hold_booking_id)
       SELECT client_id, $1, 'Ambiguous Owner', 'en', $2 FROM conversations WHERE id = $3`,
      ['+999****other', create.body.booking_id, conversation.id],
    );
    const ambiguous = await route({}, {}, null, 'bot_token');
    assert.equal(ambiguous.body.count, 1);
    assert.equal(Object.hasOwn(ambiguous.body.bookings[0], 'conversation_id'), false,
      'ambiguous durable linkage must be unpresented, never guessed by phone');

    console.log(`PR1569 genuine Staff create/readback passed: ${create.body.booking_code} -> ${conversation.id}`);
  } finally {
    await db.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
