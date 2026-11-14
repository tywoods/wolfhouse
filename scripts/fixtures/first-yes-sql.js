'use strict';
// Offline stdio adapter to actual Staff preview/direct-create handlers and real PGlite SQL.
// Default /booking-create-from-plan is a direct-handler label. Opt-in staff_body_stream
// runs the production reader/tenant dispatcher/wrapper on bytes, without HTTP sockets.
// No network, mocked business response, Stripe call, or guest delivery.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('../verify-luna-create-booking-occupants');
const lib = name => require('../lib/' + name);
const service = lib('luna-front-desk-accommodation-booking-create-service');
const offer = lib('luna-front-desk-accommodation-availability-service');
const { handleContactIdentity } = lib('luna-contact-identity');
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
    await seedOfflineBookingDb(db, { phone: '+999000000000001', guest_name: 'Riley' });
    // Mirror production enum labels before any handler queries paid rows.
    const initialSchema = fs.readFileSync(path.join(__dirname,
      '../../database/migrations/001_init.sql'), 'utf8');
    for (const type of ['payment_status', 'payment_record_status']) {
      const labels = initialSchema.match(new RegExp(`CREATE TYPE ${type} AS ENUM\\s*\\(([\\s\\S]*?)\\);`))[1].match(/'[^']+'/g);
      for (const label of labels) await db.exec(`ALTER TYPE ${type} ADD VALUE IF NOT EXISTS ${label}`);
    }
    // seedOfflineBookingDb owns the shared payment schema, including created_at.
    await db.exec(`ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents integer;
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb;
      UPDATE clients SET settings=COALESCE(settings,'{}'::jsonb) ||
        '{"inbox_channel_modes":{"whatsapp":"auto"}}'::jsonb
        WHERE slug='wolfhouse-somo';
      CREATE TABLE IF NOT EXISTS conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL,
        phone text, needs_human boolean NOT NULL DEFAULT false);
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone text;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS needs_human boolean NOT NULL DEFAULT false;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_staff_reply_at timestamptz;
      CREATE TABLE IF NOT EXISTS bot_pause_states (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text NOT NULL,
        guest_phone text, conversation_id text, paused boolean NOT NULL DEFAULT true,
        paused_by text NOT NULL);
      UPDATE rooms SET room_type='mixed', gender_strategy='Flexible', capacity=2,
        can_be_matrimonial=false, often_used_by_operator=false, selling_mode='shared',
        fill_priority=1 WHERE room_code='R1';
      UPDATE beds SET active=bed_number<=2 WHERE room_id=(SELECT id FROM rooms WHERE room_code='R1');`);
    let requestBody;
    const context = {
      ...lib('booking-create-source-attribution'),
      ...lib('bot-booking-package-normalize'), ...lib('staff-manual-booking-payment'),
      ...lib('staff-manual-booking-create-sql'), ...lib('staff-booking-portal-policy'),
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
    // Opt-in transport proof. Defaults above deliberately retain their historical
    // direct-handler behavior. Extract exact production functions, not copies.
    const staffContext = vm.createContext({ ...context, Buffer, URL, process,
      ...lib('staff-bot-request-tenant-bind'),
      userCanAccessClient: lib('staff-portal-clients').userCanAccessClient,
      _handleBotBookingCreateFromPlan: lib('staff-bot-v2-routes').handleBotBookingCreateFromPlan,
      makeInMemoryBotReq: lib('staff-bot-v2-routes').makeInMemoryBotReq,
      handlePostBookingTransfer: deny, handleBotGuestPaymentCreateLink: deny,
      STRIPE_LINKS_ENABLED: false, STRIPE_SECRET_KEY: '',
      sendJSON(res, status, body) {
        if (res.writeHead) res.writeHead(status);
        if (res.end) res.end(JSON.stringify(body));
        return { status, body };
      },
    });
    // send400 is called as a plain function by production handlers.
    staffContext.send400 = (res, error) => staffContext.sendJSON(res, 400, { error });
    for (const [name, prefix] of [
      ['readBody', 'function'],
      ['dispatchBotRouteBoundToPrincipalTenant', 'async function'],
      ['handleBotBookingCreateFromPlan', 'async function'],
      ['handleBotBookingCreate', 'async function'],
    ]) {
      // Optional exact historical source for a RED replay, never a production revert.
      const functionSource = name === 'readBody' && process.env.FIRST_YES_STAFF_READER_SOURCE
        ? fs.readFileSync(process.env.FIRST_YES_STAFF_READER_SOURCE, 'utf8') : source;
      const start = functionSource.indexOf(`${prefix} ${name}(`);
      const end = functionSource.indexOf('\n}\n', start);
      if (start < 0 || end < start) throw new Error('Staff source anchor changed: ' + name);
      vm.runInContext(functionSource.slice(start, end + 2), staffContext);
    }
    const bookingConstants = source.slice(constants, source.indexOf('\n}\n', preview) + 2);
    vm.runInContext(bookingConstants, staffContext);
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
          const req = { headers: { 'x-luna-guest-phone': cmd.guest_phone || '' } };
          if (cmd.path === '/booking-preview') result = await context.handleBotBookingPreview(req, {}, null, 'bot_token');
          else if (cmd.path === '/booking-create-from-plan' && cmd.staff_body_stream === true) {
            if (typeof cmd.raw_body !== 'string' || JSON.stringify(JSON.parse(cmd.raw_body)) !== JSON.stringify(requestBody)) {
              throw new Error('staff_body_stream requires unchanged original HTTP JSON bytes');
            }
            const bytes = Buffer.from(cmd.raw_body, 'utf8');
            const chunks = [];
            for (let offset = 0; offset < bytes.length; offset += 1024) chunks.push(bytes.subarray(offset, offset + 1024));
            const stream = Readable.from(chunks);
            stream.url = '/staff/bot/booking-create-from-plan';
            stream.method = 'POST';
            stream.headers = req.headers;
            record.transport = { mode: 'production readBody + tenant dispatcher + create-from-plan wrapper; Readable, no socket',
              url: stream.url, bytes: bytes.length, chunks: chunks.length };
            stream.on('error', error => { record.transport.reader_error = error.message; });
            const res = { writeHead(status) { this.status = status; },
              end(raw) { result = { status: this.status, body: JSON.parse(raw) }; } };
            // Authentication edge only; use the actual tenant-principal builder.
            const { user } = lib('staff-bot-principal-tenant-config').buildStaffBotAuthPrincipal(
              { LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo' }, { knownClientSlugs: ['wolfhouse-somo'] });
            const dispatched = await staffContext.dispatchBotRouteBoundToPrincipalTenant(
              { user, auth_mode: 'bot_token' }, stream, res, {},
              (principal, authMode) => staffContext.handleBotBookingCreateFromPlan(stream, res, principal, authMode));
            await dispatched.result;
            record.transport.handler_called = dispatched.handler_called;
            record.transport.bound_client_slug = stream._botBoundClientSlug || null;
            if (!result) throw new Error('Production dispatch returned no response');
          }
          else if (cmd.path === '/booking-create-from-plan') result = await context.handleBotBookingCreate(req, {}, null, 'bot_token');
          else if (cmd.path === '/contact-identity') {
            // The ordinary registered hook reads contact identity before the LLM.
            // Exercise the real handler/query; this fixture does not admit contact writes.
            if (Object.prototype.hasOwnProperty.call(requestBody, 'full_name')) {
              throw new Error('Contact identity writes are unsupported by this offline fixture');
            }
            result = await handleContactIdentity(pg, { clientSlug: 'wolfhouse-somo',
              phone: req.headers['x-luna-guest-phone'], body: requestBody });
          } else if (cmd.path === '/availability-check') {
            const built = offer.buildWolfhouseAvailabilityCommand({ channel: 'bot_http',
              trustedClientSlug: 'wolfhouse-somo', transportBody: requestBody,
              quoteConfig: await service.loadBookingQuoteConfigWithOverlay(pg), demoCalendarEnrichment: false });
            result = built.ok ? await offer.executeWolfhouseAvailabilityCheck(pg, built.command) : built;
          } else if (cmd.path === '/offline-checkout') {
            const payment = lib('luna-front-desk-payment-link-service');
            const built = payment.buildPaymentLinkCommand({
              operation: payment.PAYMENT_LINK_OPERATIONS.CREATE,
              channel: payment.PAYMENT_LINK_CHANNELS.LUNA_WHATSAPP,
              trustedClientSlug: 'wolfhouse-somo', trustedGuestPhone: cmd.guest_phone,
              paymentId: requestBody.payment_id, target: 'draft_payment',
            });
            if (!built.ok) throw new Error(JSON.stringify(built));
            result = await payment.createPaymentLink(pg, built.command, {
              staffActionsEnabled: true, stripeLinksEnabled: true,
              secretKey: 'sk_test_offline_only', blockLiveKeys: true,
              successUrl: 'https://example.invalid/success', cancelUrl: 'https://example.invalid/cancel',
              createStripeCheckoutSession: async () => ({ id: 'cs_test_offline',
                url: 'https://example.invalid/checkout', livemode: false,
                payment_status: 'unpaid', expires_at: 2000000000 }),
            });
          } else throw new Error('Unexpected offline endpoint: ' + cmd.path);
          response = { status: result.status || 200, body: result.body };
          record.response = response;
        } else if (cmd.reject_guest_projection === true) {
          // PostgreSQL executes the real helper UPDATE; no mocked query/transport.
          await db.exec(`CREATE FUNCTION reject_guest_projection() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offline guest projection rejected'; END $$;
            CREATE TRIGGER reject_guest_projection BEFORE UPDATE ON booking_guests
            FOR EACH ROW EXECUTE FUNCTION reject_guest_projection();`);
          response = { projection_trigger_installed: true };
        } else if (cmd.snapshot) {
          const tables = {};
          for (const table of ['bookings', 'booking_guests', 'booking_beds', 'payments', 'booking_service_records']) {
            tables[table] = (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
          }
          response = { tables, calls, errors };
        } else if (cmd.serious_booking_setup === true) {
          // Opt-in incident inventory only; preserve the first-yes defaults.
          // The shared seed already supplies an all-year SQL season and Malibu price.
          await db.exec(`UPDATE rooms SET room_type='mixed', gender_strategy='Flexible',
              capacity=4, selling_mode='shared', can_be_matrimonial=false,
              often_used_by_operator=false WHERE room_code='R1';
            UPDATE beds SET active=true, sellable=true
              WHERE room_id=(SELECT id FROM rooms WHERE room_code='R1') AND bed_number<=4;
            UPDATE rooms SET room_type='female_only', gender_strategy='Female preferred',
              selling_mode='shared', can_be_matrimonial=false, often_used_by_operator=false
              WHERE room_code='R5';
            UPDATE beds SET active=true, sellable=true
              WHERE bed_code IN ('R5-B1','R5-B2');`);
          if (cmd.split_save_only === true) {
            await db.exec(`UPDATE beds SET active=bed_code IN ('R5-B1','R5-B2','R1-B2');`);
          }
          response = { serious_booking_setup: true };
        } else if (cmd.incident_finance_setup === true) {
          // Use production booking-status enum additions; migration 024 keeps
          // booking_guests.payment_status TEXT (not the booking enum).
          const migration = fs.readFileSync(path.join(__dirname,
            '../../database/migrations/004_payment_schema_phase2.sql'), 'utf8');
          const initial = fs.readFileSync(path.join(__dirname,
            '../../database/migrations/001_init.sql'), 'utf8');
          const labels = initial.match(/CREATE TYPE payment_status AS ENUM\s*\(([\s\S]*?)\);/)[1].match(/'[^']+'/g);
          for (const label of labels) await db.exec(`ALTER TYPE payment_status ADD VALUE IF NOT EXISTS ${label}`);
          for (const sql of migration.match(/ALTER TYPE payment_status[^;]+;/g)) await db.exec(sql);
          await db.exec(`ALTER TYPE payment_record_status ADD VALUE IF NOT EXISTS 'checkout_created';`);
          await db.exec(`ALTER TABLE payments ADD COLUMN amount_paid_cents int DEFAULT 0;
            ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
            ALTER TABLE payments ADD COLUMN checkout_url text;
            ALTER TABLE payments ADD COLUMN expires_at timestamptz;
            ALTER TABLE bookings ADD COLUMN amount_paid_cents int DEFAULT 0;
            UPDATE wh_pricing_rules SET amount_cents=29900
              WHERE item_type='package' AND item_code='malibu';`);
          response = { incident_finance_setup: true,
            conversation_id: (await db.query('SELECT id FROM conversations LIMIT 1')).rows[0].id };
        } else if (cmd.requoted_staff_body_pricing === true) {
          // Synthetic November incident price, through SQL rules and the real calculator.
          await db.exec(`UPDATE wh_pricing_rules SET amount_cents=24900, per_night_cents=4150
            WHERE client_slug='wolfhouse-somo' AND item_type='package' AND item_code='malibu';`);
          response = { requoted_staff_body_pricing: true };
        } else if (cmd.make_room_private) {
          await db.query("UPDATE rooms SET selling_mode='private' WHERE room_code=$1", [cmd.make_room_private]);
          response = { made_private: cmd.make_room_private };
        } else if (cmd.block_bed) {
          const checkIn = cmd.check_in || '2026-10-20';
          const checkOut = cmd.check_out || '2026-10-22';
          const booking = (await db.query(`INSERT INTO bookings(client_id,booking_code,status,check_in,check_out)
            SELECT id,'OFFLINE-COMPETING','confirmed',$1::date,$2::date FROM clients WHERE slug='wolfhouse-somo' RETURNING id`, [checkIn, checkOut])).rows[0];
          await db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,assignment_start_date,assignment_end_date,assignment_type)
            SELECT client_id,$1,id,bed_code,(SELECT room_code FROM rooms WHERE id=beds.room_id),$3::date,$4::date,'guest' FROM beds WHERE bed_code=$2`, [booking.id, cmd.block_bed, checkIn, checkOut]);
          response = { blocked: cmd.block_bed };
        } else throw new Error('Unknown fixture command');
      } catch (error) { response = { fixture_error: error.stack || String(error) }; }
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
