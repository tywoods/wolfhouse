'use strict';
// Offline stdio adapter to actual Staff preview/create handlers and real PGlite SQL.
// No network, mocked business response, Stripe call, or guest delivery.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('../verify-luna-create-booking-occupants');
const lib = name => require('../lib/' + name);
const service = lib('luna-front-desk-accommodation-booking-create-service');
const offer = lib('luna-front-desk-accommodation-availability-service');
const deny = () => { throw new Error('Network forbidden by first-yes SQL proof'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) {
  require(name).request = deny; require(name).get = deny;
}
globalThis.fetch = deny;

async function main() {
  const db = new PGlite();
  const calls = [], errors = [];
  const pg = { async query(sql, params = []) {
    try { return await db.query(sql, params); }
    catch (error) { errors.push(error.message); throw error; }
  }};
  try {
    await seedOfflineBookingDb(db, { phone: '+999000000001', guest_name: 'Riley' });
    await db.exec(`ALTER TABLE payments ADD created_at timestamptz DEFAULT now();
      UPDATE rooms SET room_type='mixed', gender_strategy='Flexible', capacity=2,
        can_be_matrimonial=false, often_used_by_operator=false, selling_mode='shared',
        fill_priority=1 WHERE room_code='R1';
      UPDATE beds SET active=bed_number<=2 WHERE room_id=(SELECT id FROM rooms WHERE room_code='R1');`);
    let requestBody;
    const context = {
      ...lib('bot-booking-package-normalize'), ...lib('staff-manual-booking-payment'),
      ...lib('wolfhouse-room-options'), ...lib('wolfhouse-quote-calculator'),
      ...lib('guest-addon-pricing'), ...lib('bot-quote-included-items'),
      ...lib('wolfhouse-package-night-rules'), ...lib('booking-guests'),
      ...lib('staff-bed-calendar-queries'), ...offer, ...service,
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true, DEFAULT_CLIENT: 'wolfhouse-somo',
      appendAuditLog() {}, readBody: async () => JSON.stringify(requestBody),
      resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
      loadWolfhouseQuoteConfigWithOverlay: () => service.loadBookingQuoteConfigWithOverlay(pg),
      withPgClient: fn => fn(pg),
      sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
    };
    const source = fs.readFileSync(path.join(__dirname, '../staff-query-api.js'), 'utf8');
    const constants = source.indexOf('const BOT_BOOKING_REQUIRED_FIELDS = [');
    const preview = source.indexOf('async function handleBotBookingPreview(req, res, user, authMode) {');
    const create = source.indexOf('async function handleBotBookingCreate(req, res, user, authMode) {');
    if (constants < 0 || preview < constants || create < 0) throw new Error('Staff handler source anchors changed');
    vm.createContext(context);
    vm.runInContext(source.slice(constants, source.indexOf('\n}\n', preview) + 2), context);
    vm.runInContext(source.slice(create, source.indexOf('\n}\n', create) + 2), context);
    const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    process.stdout.write(JSON.stringify({ ready: true }) + '\n');
    for await (const line of lines) {
      let response;
      try {
        const cmd = JSON.parse(line);
        if (cmd.path) {
          requestBody = structuredClone(cmd.body || {});
          const record = { path: cmd.path, body: requestBody };
          calls.push(record);
          let result;
          if (cmd.path === '/booking-preview') result = await context.handleBotBookingPreview({}, {}, null, 'offline');
          else if (cmd.path === '/booking-create-from-plan') result = await context.handleBotBookingCreate({}, {}, null, 'offline');
          else if (cmd.path === '/availability-check') {
            const built = offer.buildWolfhouseAvailabilityCommand({ channel: 'bot_http',
              trustedClientSlug: 'wolfhouse-somo', transportBody: requestBody,
              quoteConfig: await service.loadBookingQuoteConfigWithOverlay(pg), demoCalendarEnrichment: false });
            result = built.ok ? await offer.executeWolfhouseAvailabilityCheck(pg, built.command) : built;
          } else throw new Error('Unexpected offline endpoint: ' + cmd.path);
          response = { status: result.status || 200, body: result.body };
          record.response = response;
        } else if (cmd.snapshot) {
          const tables = {};
          for (const table of ['bookings', 'booking_guests', 'booking_beds', 'payments', 'booking_service_records']) {
            tables[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
          }
          response = { tables, calls, errors };
        } else if (cmd.make_room_private) {
          await db.query("UPDATE rooms SET selling_mode='private' WHERE room_code=$1", [cmd.make_room_private]);
          response = { made_private: cmd.make_room_private };
        } else if (cmd.block_bed) {
          const booking = (await db.query(`INSERT INTO bookings(client_id,booking_code,status,check_in,check_out)
            SELECT id,'OFFLINE-COMPETING','confirmed','2026-10-20','2026-10-22' FROM clients WHERE slug='wolfhouse-somo' RETURNING id`)).rows[0];
          await db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
            SELECT client_id,$1,id,bed_code,(SELECT room_code FROM rooms WHERE id=beds.room_id),'2026-10-20','2026-10-22','guest' FROM beds WHERE bed_code=$2`, [booking.id, cmd.block_bed]);
          response = { blocked: cmd.block_bed };
        } else throw new Error('Unknown fixture command');
      } catch (error) { response = { fixture_error: error.stack || String(error) }; }
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
