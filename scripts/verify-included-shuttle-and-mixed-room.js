'use strict';
// Offline checks for the included-shuttle booking save and mixed shared-room labels.
// No database, network, Stripe, or WhatsApp.
const assert = require('node:assert/strict');
const { getTransferRules } = require('./lib/client-transfer-config');
const {
  qualifyIncludedShuttleSave,
  persistAcceptedIncludedShuttle,
} = require('./lib/luna-included-shuttle-save');
const { handleBotBookingCreateFromPlan } = require('./lib/staff-bot-v2-routes');
const { projectGuestRooms, withAssignmentRoomType } = require('./lib/staff-guest-room-state');

const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = '11111111-1111-4111-8111-111111111111';
const includedAirports = getTransferRules(CLIENT).filter((rule) => rule && rule.included_when_package === true);
assert.equal(includedAirports.length, 1, 'the fixture client has one included airport shuttle');
const includedAirport = includedAirports[0].airport_code;

function stay(extra) {
  return {
    client_slug: CLIENT,
    check_in: '2027-09-20',
    check_out: '2027-09-26',
    package_code: 'malibu',
    guest_count: 1,
    ...extra,
  };
}

function packages(defaultNights) {
  return {
    packages: [{ code: 'malibu', ...(defaultNights == null ? {} : { default_nights: defaultNights }) }],
  };
}

function sharedPrivacy(codes) {
  return { source: 'saved_booking', private_room_enabled: false, room_codes: codes };
}

const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

function decision(body, config, client = CLIENT) {
  return qualifyIncludedShuttleSave(body, config, client);
}

const acceptedFull = decision(stay({ shuttle_choice: 'accepted' }), packages(6));
assert.equal(acceptedFull.save, true);
assert.equal(acceptedFull.entry.direction, 'arrival');
assert.equal(acceptedFull.entry.airport_code, includedAirport);
assert.equal(acceptedFull.entry.flight_number, undefined);
assert.doesNotMatch(acceptedFull.entry.notes, /\bdorm/i);

assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(4)).reason, 'full_stay_package');
assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(7)).reason, 'short_stay');
assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(7)).save, false);
assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(null)).reason, 'default_nights_unknown');
assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(null)).warn, true);
assert.equal(decision(stay({ shuttle_choice: 'declined' }), packages(6)).reason, 'declined');
assert.equal(decision(stay({}), packages(6)).reason, 'unresolved');
assert.equal(decision(stay({ shuttle_choice: 'accepted', package_code: 'package_none' }), packages(6)).reason, 'not_package');
assert.equal(decision(stay({ shuttle_choice: 'accepted', needs_shuttle: false }), packages(6)).reason, 'declined');
assert.equal(decision(stay({ shuttle_choice: 'accepted' }), packages(6), 'unknown-client').reason, 'included_airport_unknown');

const savedBooking = {
  success: true,
  write_performed: true,
  booking_id: BOOKING_ID,
  booking_code: 'WH-TEST',
};

async function persist(body, writer, config, notes) {
  const result = { ...savedBooking };
  const outcome = await persistAcceptedIncludedShuttle(body, result, {
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => config,
    writeIncludedShuttle: writer,
    withPgClient: async (run) => {
      await run({ query: async (_sql, params) => { notes.push(params); return { rowCount: 1 }; } });
    },
  });
  return { outcome, result };
}

(async () => {
  const writes = [];
  const saved = await persist(
    stay({ shuttle_choice: 'accepted' }),
    async (entry) => {
      writes.push(entry);
      return { success: true, write_performed: true };
    },
    packages(6),
    [],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].airport_code, includedAirport);
  assert.equal(writes[0].direction, 'arrival');
  assert.equal(saved.outcome.saved, true);
  assert.equal(saved.result.success, true);
  assert.equal(saved.result.write_performed, true);
  assert.equal(saved.result.transfer_save_results[0].included_shuttle, true);

  const failedNotes = [];
  const failed = await persist(
    stay({ shuttle_choice: 'accepted' }),
    async () => { throw new Error('transfer down'); },
    packages(6),
    failedNotes,
  );
  assert.equal(failed.outcome.saved, false);
  assert.equal(failed.result.success, true);
  assert.equal(failed.result.write_performed, true);
  assert.match(failed.result.staff_shuttle_warning, /Booking kept/);
  assert.equal(failedNotes.length, 1);
  assert.match(failedNotes[0][0], /\[Luna shuttle\]/);
  assert.equal(failedNotes[0][1], BOOKING_ID);

  const unknown = await persist(
    stay({ shuttle_choice: 'accepted' }),
    async () => { throw new Error('should not write'); },
    packages(null),
    [],
  );
  assert.equal(unknown.outcome.reason, 'default_nights_unknown');
  assert.equal(unknown.result.success, true);
  assert.match(unknown.result.staff_shuttle_warning, /default nights/);

  const sent = [];
  function sendJSON(_res, status, body) { sent.push({ status, body }); }
  const transferCalls = [];
  const plan = stay({ shuttle_choice: 'accepted', guest_name: 'Nia' });
  await handleBotBookingCreateFromPlan({ headers: {} }, {}, {}, 'bot_token', {
    sendJSON,
    send400() {},
    readBody: async () => JSON.stringify(plan),
    DEFAULT_CLIENT: CLIENT,
    STAFF_AUTH_REQUIRED: false,
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    handleBotBookingCreate: async (_req, res) => {
      res.end(JSON.stringify({
        success: true,
        write_performed: true,
        created: true,
        booking_id: BOOKING_ID,
        booking_code: 'WH-TEST',
      }));
    },
    handlePostBookingTransfer: async (_bookingId, req, jsonRes) => {
      transferCalls.push(JSON.parse(req._cachedBody));
      jsonRes.status(200).json({ success: true, write_performed: true, transfer: { direction: 'arrival' } });
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.success, true);
  assert.equal(sent[0].body.write_performed, true);
  assert.equal(transferCalls.length, 1);
  assert.equal(transferCalls[0].airport_code, includedAirport);
  assert.equal(transferCalls[0].confirm_transfer_write, true);
  assert.equal(transferCalls[0].flight_number, undefined);
  assert.equal(transferCalls[0].scheduled_at, undefined);
  assert.equal(sent[0].body.transfer_save_results[0].included_shuttle, true);

  const skipped = [];
  await handleBotBookingCreateFromPlan({ headers: {} }, {}, {}, 'bot_token', {
    sendJSON: (_res, _status, body) => skipped.push(body),
    send400() {},
    readBody: async () => JSON.stringify(stay({
      shuttle_choice: 'accepted',
      pending_transfers: [{ direction: 'arrival', airport_code: includedAirport }],
    })),
    DEFAULT_CLIENT: CLIENT,
    STAFF_AUTH_REQUIRED: false,
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    handleBotBookingCreate: async (_req, res) => {
      res.end(JSON.stringify({
        success: true, write_performed: true, created: true,
        booking_id: BOOKING_ID, booking_code: 'WH-TEST',
      }));
    },
    handlePostBookingTransfer: async () => { throw new Error('pending details are incomplete'); },
  });
  assert.equal(skipped[0].success, true);
  assert.equal(skipped[0].transfer_save_results.some((row) => row.included_shuttle), false);
  assert.equal(skipped[0].transfer_save_results[0].write_performed, false);

  const broken = [];
  await handleBotBookingCreateFromPlan({ headers: {} }, {}, {}, 'bot_token', {
    sendJSON: (_res, _status, body) => broken.push(body),
    send400() {},
    readBody: async () => JSON.stringify(stay({ shuttle_choice: 'accepted' })),
    DEFAULT_CLIENT: CLIENT,
    STAFF_AUTH_REQUIRED: false,
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    handleBotBookingCreate: async (_req, res) => {
      res.end(JSON.stringify({
        success: true, write_performed: true, created: true,
        booking_id: BOOKING_ID, booking_code: 'WH-TEST',
      }));
    },
    handlePostBookingTransfer: async () => { throw new Error('capacity missing'); },
  });
  assert.equal(broken[0].success, true);
  assert.equal(broken[0].write_performed, true);
  assert.equal(broken[0].transfer_save_results[0].write_performed, false);
  assert.match(broken[0].staff_shuttle_warning, /Booking kept/);

  const dbWrites = [];
  const fromAdmin = await persistAcceptedIncludedShuttle(stay({ shuttle_choice: 'accepted' }), { ...savedBooking }, {
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    loadTransferConfig: async () => ({
      rules: [{ airport_code: 'BIO', included_when_package: true, label: 'Bilbao' }],
      airports: [{ code: 'BIO', label: 'Bilbao' }],
    }),
    writeIncludedShuttle: async (entry) => {
      dbWrites.push(entry);
      return { success: true, write_performed: true };
    },
  });
  assert.equal(fromAdmin.saved, true);
  assert.equal(dbWrites[0].airport_code, 'BIO');
  assert.notEqual(dbWrites[0].airport_code, includedAirport);

  const notIncluded = await persistAcceptedIncludedShuttle(stay({ shuttle_choice: 'accepted' }), { ...savedBooking }, {
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    loadTransferConfig: async () => ({ rules: [{ airport_code: includedAirport, included_when_package: false }] }),
    writeIncludedShuttle: async () => { throw new Error('static seed must not make this free'); },
  });
  assert.equal(notIncluded.saved, false);
  assert.equal(notIncluded.reason, 'included_airport_unknown');

  const unread = await persistAcceptedIncludedShuttle(stay({ shuttle_choice: 'accepted' }), { ...savedBooking }, {
    boundClientSlug: CLIENT,
    loadQuoteConfig: async () => packages(6),
    loadTransferConfig: async () => { throw new Error('db down'); },
    writeIncludedShuttle: async () => { throw new Error('must not write'); },
  });
  assert.equal(unread.reason, 'transfer_config_unreadable');
  assert.equal(unread.saved, false);

  const guest = { guest_name: 'Nia', assigned_room_code: 'R1', booking_guest_id: 'g1' };
  const mixed = projectGuestRooms(
    [guest],
    { R1: { type: 'mixed', room_name: 'Dorm 1' } },
    {},
    sharedPrivacy(['R1']),
  )[0];
  assert.equal(mixed.room_label, 'Room 1, mixed shared room');
  assert.doesNotMatch(mixed.room_label, /\bdorm/i);
  assert.equal(mixed.inventory_room_type, 'mixed');

  const female = projectGuestRooms(
    [{ ...guest, assigned_room_code: 'R2' }],
    { R2: { type: 'female_only' } },
    {},
    sharedPrivacy(['R2']),
  )[0];
  assert.equal(female.room_label, 'Room 2, female shared room');

  const male = projectGuestRooms(
    [{ ...guest, assigned_room_code: 'R4' }],
    { R4: { type: 'male_only' } },
    {},
    sharedPrivacy(['R4']),
  )[0];
  assert.equal(male.room_label, 'Room 4, male shared room');

  const privateStay = projectGuestRooms(
    [{ ...guest, assigned_room_code: 'R7' }],
    { R7: { type: 'mixed' } },
    {},
    { source: 'saved_booking', private_room_enabled: true, room_codes: ['R7'] },
  )[0];
  assert.equal(privateStay.room_label, 'Room 7, private room');

  const unknownPrivacy = projectGuestRooms(
    [guest],
    { R1: { type: 'mixed' } },
    {},
    null,
  )[0];
  assert.equal(unknownPrivacy.room_label.includes('shared'), false);

  const fromAssignment = projectGuestRooms(
    [withAssignmentRoomType(guest, { room_code: 'R1', room_type: 'mixed', bed_code: 'R1-B1' }, [])],
    {},
    {},
    sharedPrivacy(['R1']),
  )[0];
  assert.equal(fromAssignment.room_label, 'Room 1, mixed shared room');
  assert.equal(fromAssignment.inventory_room_type, 'mixed');

  const catalogPrivateSharedStay = projectGuestRooms(
    [{ ...guest, assigned_room_code: 'R7' }],
    { R7: { type: 'private' } },
    {},
    sharedPrivacy(['R7']),
  )[0];
  assert.equal(catalogPrivateSharedStay.room_label, 'Room 7, shared room');

  console.warn = originalWarn;
  console.log('PASS included shuttle save and mixed shared room labels');
})().catch((err) => {
  console.warn = originalWarn;
  console.error(err);
  process.exit(1);
});
