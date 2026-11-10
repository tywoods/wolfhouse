'use strict';

// Offline LOCATION-ONCE-001 regression: synthetic data only, no network/send.
const assert = require('assert/strict');
const { buildWolfhousePaidConfirmationCopy } = require('./lib/luna-guest-confirmation-copy-style');

function verifyRenderer() {
  for (const language of ['en', 'es']) {
    const facts = {
      language, booking_code: 'LOCATION-FIXTURE', payment_status: 'paid',
      amount_paid_cents: 40000, balance_due_cents: 0,
      address: 'Fixture address, Somo', maps_link: 'https://maps.example/fixture',
      check_in_time: '15:00', gate_code: 'fixture-gate',
    };
    const repeat = buildWolfhousePaidConfirmationCopy({ ...facts, location_already_sent: true });
    assert.equal(repeat.includes(facts.maps_link), false, 'already-sent location must omit map');
    assert.equal(repeat.includes(facts.address), false, 'already-sent location must omit address');
    assert.match(repeat, /15:00/);
    assert.match(repeat, /fixture-gate/);
    assert.match(repeat, /€400/);
    for (const location_already_sent of [false, undefined, 'true']) {
      const fresh = buildWolfhousePaidConfirmationCopy({ ...facts, location_already_sent });
      assert.ok(fresh.includes(facts.maps_link));
      assert.ok(fresh.includes(facts.address));
    }
  }
  console.log('PASS location-once renderer: EN/ES, first location, time/gate/payment retained');
}

const { PGlite } = require('@electric-sql/pglite');
const { runGuestConfirmationPreviewDryRun } = require('./lib/luna-guest-confirmation-preview-dry-run');
const { getLunaBookingConfirmationPreview } = require('./lib/luna-booking-confirmation-preview');
const { loadLessonScheduleConfig } = require('./lib/luna-guest-lesson-schedule-config');
const CLIENT = '10000000-0000-4000-8000-000000000001';
const BOOKING = '20000000-0000-4000-8000-000000000001';
const CHAT = '30000000-0000-4000-8000-000000000001';
const MAP = loadLessonScheduleConfig('wolfhouse-somo').maps_link;
const ADDRESS = 'Fixture address, Somo';
const DRAFT = {
  booking_code: 'LOCATION-FIXTURE', guest_name: 'Fixture', payment_status: 'paid',
  amount_paid_cents: 40000, balance_due_cents: 0, total_amount_cents: 40000,
  room_number: 'R1', room_kind: 'mixed shared', language: 'en',
  address: ADDRESS, maps_link: MAP, gate_code: 'fixture-gate', check_in_time: '15:00',
};

async function fixtureDb() {
  const db = new PGlite();
  // Relevant existing column shapes from migrations 001, 013 and 133; no production DB.
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE);
    CREATE TABLE bookings (
      id uuid PRIMARY KEY, client_id uuid, booking_code text, phone text,
      payment_status text, confirmation_sent_at timestamptz, primary_room_code text,
      amount_paid_cents integer, total_amount_cents integer, language text,
      check_in date, check_out date, guest_count integer, requested_room_type text,
      room_preference text, metadata jsonb, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE conversations (
      id uuid PRIMARY KEY, client_id uuid, phone text, current_hold_booking_id uuid,
      created_at timestamptz DEFAULT now(), cleared_at timestamptz, metadata jsonb DEFAULT '{}'
    );
    CREATE TABLE booking_conversation_links (
      client_id uuid, conversation_id uuid, booking_id uuid, created_at timestamptz DEFAULT now(),
      PRIMARY KEY (client_id, conversation_id, booking_id), UNIQUE (client_id, booking_id)
    );
    CREATE TABLE messages (
      id uuid DEFAULT gen_random_uuid(), client_id uuid, conversation_id uuid,
      direction text, message_text text, source text, route text DEFAULT 'whatsapp',
      whatsapp_message_id text, metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now()
    );
    CREATE TABLE guest_message_sends (
      id uuid DEFAULT gen_random_uuid(), client_slug text, channel text DEFAULT 'whatsapp',
      to_phone text, idempotency_key text, send_kind text, source text, message_text text,
      status text, provider_message_id text, sent_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE booking_beds (booking_id uuid, room_code text, bed_code text);
    CREATE TABLE payments (booking_id uuid, status text, payment_kind text,
      amount_due_cents integer, amount_paid_cents integer, checkout_url text,
      metadata jsonb, created_at timestamptz DEFAULT now());
  `);
  await db.query('INSERT INTO clients VALUES ($1, $2)', [CLIENT, 'wolfhouse-somo']);
  await db.query(`INSERT INTO bookings
    (id, client_id, booking_code, phone, payment_status, amount_paid_cents,
     total_amount_cents, primary_room_code, language, metadata)
    VALUES ($1, $2, 'LOCATION-FIXTURE', '+340000000001', 'paid', 40000, 40000, 'R1', 'en', $3)`,
  [BOOKING, CLIENT, JSON.stringify({ confirmation_draft: DRAFT })]);
  await db.query(`INSERT INTO conversations (id, client_id, phone, current_hold_booking_id)
    VALUES ($1, $2, '+340000000001', $3)`, [CHAT, CLIENT, BOOKING]);
  await db.query('INSERT INTO booking_conversation_links (client_id, conversation_id, booking_id) VALUES ($1, $2, $3)',
    [CLIENT, CHAT, BOOKING]);
  return db;
}

async function insertMirror(db, overrides = {}) {
  const m = {
    client: CLIENT, chat: CHAT, direction: 'outbound', text: `Invoice: ${MAP}`,
    source: 'hermes_luna_whatsapp_reply', route: 'whatsapp',
    wamid: 'wamid.fixture', metadata: {}, ...overrides,
  };
  await db.query(`INSERT INTO messages
    (client_id, conversation_id, direction, message_text, source, route, whatsapp_message_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [m.client, m.chat, m.direction, m.text, m.source, m.route, m.wamid, JSON.stringify(m.metadata)]);
}

async function preview(db, input = {}) {
  const errors = [];
  const pg = { async query(sql, params) {
    assert.match(sql.trim(), /^SELECT\b/, 'preview lookup is read-only');
    try { return await db.query(sql, params); } catch (error) { errors.push(error.code); throw error; }
  } };
  const result = await runGuestConfirmationPreviewDryRun({ client_slug: 'wolfhouse-somo', booking_id: BOOKING, ...input }, { pg });
  assert.deepEqual(errors, [], 'real preview SQL must not hide errors');
  return result;
}

async function expectFirstLocation(db, label, input = {}) {
  const result = await preview(db, input);
  assert.equal(result.success, true, label);
  assert.equal(result.location_already_sent, false, label);
  assert.ok(result.message_preview.includes(MAP), label);
  assert.ok(result.message_preview.includes(ADDRESS), label);
  assert.match(result.message_preview, /15:00/);
  assert.match(result.message_preview, /fixture-gate/);
  return result;
}

async function rollbackCase(db, action) {
  await db.exec('BEGIN');
  try { await action(); } finally { await db.exec('ROLLBACK'); }
}

async function verifyRouteBinding() {
  const fs = require('fs');
  const vm = require('vm');
  const source = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
  const start = source.indexOf('async function handleBotBookingConfirmationPreview(');
  const handler = source.slice(start, source.indexOf('\n}\n', start) + 2);
  let captured;
  const sandbox = {
    STAFF_AUTH_REQUIRED: true, readBody: async () => '{}',
    withPgClient: fn => fn({}), appendAuditLog: () => {},
    getLunaBookingConfirmationPreview: async (_body, ctx) => { captured = ctx; return { success: true }; },
    sendJSON: () => {}, send400: () => {}, Date, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(handler, sandbox);
  for (const mode of ['bot_token', 'session', 'open']) {
    await sandbox.handleBotBookingConfirmationPreview(
      { headers: { 'x-luna-guest-phone': 'fixture-phone' } }, {}, null, mode);
    assert.equal(captured.trustedGuestPhone, mode === 'bot_token' ? 'fixture-phone' : '', mode);
  }
  console.log('PASS authoring route: only authenticated bot ingress supplies trusted phone');
}

async function verifyHistory() {
  const db = await fixtureDb();
  try {
    await insertMirror(db);
    await insertMirror(db, { direction: 'inbound', source: 'hermes_luna_whatsapp_inbound',
      text: 'A link each please', wamid: 'wamid.inbound' });
    const fixturePhone = (await db.query(
      `SELECT regexp_replace(phone, '[^0-9]', '', 'g') AS phone FROM conversations WHERE id = $1`, [CHAT])).rows[0].phone;
    const request = { client_slug: 'wolfhouse-somo', authoring_context_only: true,
      phone: fixturePhone, inbound_message_id: 'wamid.inbound' };
    const contextErrors = [];
    const contextPg = { async query(sql, params) {
      try { return await db.query(sql, params); }
      catch (error) { contextErrors.push(error.message); throw error; }
    } };
    const denied = await getLunaBookingConfirmationPreview(request, { pg: contextPg });
    assert.deepEqual(denied.previous_sent_replies, [], 'no trusted ingress phone: no history');
    assert.equal(denied.location_already_sent, false);
    const context = await getLunaBookingConfirmationPreview(request, { pg: contextPg, trustedGuestPhone: fixturePhone });
    assert.deepEqual(contextErrors, []);
    assert.equal(context.success, true);
    assert.equal(context.location_already_sent, true, JSON.stringify(context));
    assert.deepEqual(context.previous_sent_replies, [`Invoice: ${MAP}`]);
    for (const change of [{ phone: '999' }, { client_slug: 'sunset' },
      { inbound_message_id: 'missing' }, { inbound_message_id: 'wamid.fixture' }]) {
      const wrong = await getLunaBookingConfirmationPreview({ ...request, ...change }, { pg: db, trustedGuestPhone: fixturePhone });
      assert.equal(wrong.location_already_sent, false);
      assert.deepEqual(wrong.previous_sent_replies, []);
    }
    console.log('PASS authoring context: inbound-bound tenant/phone/chat, sent replies only');
    await rollbackCase(db, async () => {
      await db.exec("UPDATE conversations SET cleared_at = now() + interval '1 second'");
      const cleared = await getLunaBookingConfirmationPreview(request,
        { pg: contextPg, trustedGuestPhone: fixturePhone });
      assert.deepEqual(cleared.previous_sent_replies, [], 'cleared thread hides prior replies');
      assert.equal(cleared.location_already_sent, false);
      await expectFirstLocation(db, 'cleared thread needs first location again');
    });
    const result = await preview(db);
    assert.equal(result.success, true);
    assert.equal(result.message_preview.includes(MAP), false, 'same-chat accepted invoice must suppress repeated map');
    assert.equal(result.message_preview.includes(ADDRESS), false);
    assert.match(result.message_preview, /15:00/);
    assert.match(result.message_preview, /fixture-gate/);
    assert.equal(result.location_already_sent, true);
    assert.equal(result.location_history_status, 'already_sent');
    console.log('PASS location-once SQL: accepted Hermes invoice suppresses same-chat location');
    await db.exec('DELETE FROM messages');
    await insertMirror(db, {
      source: 'staff_inbox_reply',
      route: 'staff_portal',
      text: `Approved Luna booking reply: ${MAP}`,
      wamid: 'wamid.approved-luna-draft',
      metadata: { send_kind: 'staff_reply' },
    });
    const approvedDraft = await preview(db);
    assert.equal(approvedDraft.message_preview.includes(MAP), false,
      'an approved Luna draft accepted by Meta must suppress the later payment-confirmation map');
    assert.equal(approvedDraft.location_already_sent, true);
    console.log('PASS location-once SQL: approved Luna draft counts as accepted same-chat location');
    const direct = await getLunaBookingConfirmationPreview({ client_slug: 'wolfhouse-somo', booking_id: BOOKING }, { pg: db });
    assert.equal(direct.message_preview.includes(MAP), false, 'legacy direct-send preview must also omit repeated map');
    assert.equal(direct.message_preview.includes(ADDRESS), false);
    assert.match(direct.message_preview, /fixture-gate/);
    await rollbackCase(db, async () => {
      const partial = { ...DRAFT, payment_status: 'deposit_paid', amount_paid_cents: 20000,
        balance_due_cents: 20000 };
      await db.query("UPDATE bookings SET payment_status = 'deposit_paid', amount_paid_cents = 20000, metadata = $1", [JSON.stringify({ confirmation_draft: partial })]);
      await db.query(`INSERT INTO payments (booking_id, status, payment_kind, amount_due_cents,
        amount_paid_cents, checkout_url) VALUES ($1, 'pending', 'balance', 20000, 0, $2)`,
        [BOOKING, 'https://pay.invalid/existing-balance']);
      const fresh = await getLunaBookingConfirmationPreview(
        { client_slug: 'wolfhouse-somo', booking_id: BOOKING, to: '99999' }, { pg: db });
      const repeat = await getLunaBookingConfirmationPreview(
        { client_slug: 'wolfhouse-somo', booking_id: BOOKING }, { pg: db });
      assert.ok(repeat.message_preview.includes('https://pay.invalid/existing-balance'), 'suppression retains existing balance link');
      assert.equal(repeat.message_preview,
        fresh.message_preview.split('\n').filter(line => !line.includes(MAP)).join('\n'),
        'legacy preview changes only its location line, not payments/room/copy');
    });
    console.log('PASS location-once direct-send preview: same trusted suppression and arrival facts');
    await expectFirstLocation(db, 'different final recipient cannot inherit chat evidence', { to: '999999' });
    const otherRecipient = await getLunaBookingConfirmationPreview(
      { client_slug: 'wolfhouse-somo', booking_id: BOOKING, to: '999999' }, { pg: db });
    assert.equal(otherRecipient.location_already_sent, false);
    assert.ok(otherRecipient.message_preview.includes(MAP));
    const sameRecipient = await preview(db, { to: fixturePhone });
    assert.equal(sameRecipient.location_already_sent, true);
    await db.exec('DELETE FROM messages');
    await db.query(`INSERT INTO guest_message_sends
      (id, client_slug, to_phone, send_kind, status, provider_message_id, message_text, sent_at)
      VALUES ('40000000-0000-4000-8000-000000000001', 'wolfhouse-somo', '+340000000001',
        'confirmation', 'sent', 'wamid.accepted-not-delivered', $1, now())`, [`Paid confirmation: ${MAP}`]);
    await db.query(`UPDATE bookings SET metadata = metadata || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ confirmation_send_id: '40000000-0000-4000-8000-000000000001' }), BOOKING]);
    const accepted = await preview(db);
    assert.equal(accepted.message_preview.includes(MAP), false, 'accepted Staff send is sufficient without delivered callback');
    assert.equal(accepted.location_already_sent, true);
    console.log('PASS location-once SQL: accepted Staff confirmation counts without delivery claim');
    await rollbackCase(db, async () => {
      await db.exec("UPDATE conversations SET cleared_at = now() + interval '1 second'");
      await expectFirstLocation(db, 'pre-clear Staff send is not current chat evidence');
    });
    for (const [label, update] of [
      ['failed send', "status = 'failed'"], ['blocked send', "status = 'blocked'"],
      ['pending send', "status = 'pending'"], ['missing receipt', 'provider_message_id = NULL'],
      ['other tenant', "client_slug = 'sunset'"], ['other recipient', "to_phone = '+999000000002'"],
      ['other channel', "channel = 'email'"], ['non-confirmation', "send_kind = 'draft'"],
      ['before current chat', "sent_at = '2000-01-01'"],
    ]) {
      await rollbackCase(db, async () => {
        await db.exec(`UPDATE guest_message_sends SET ${update}`);
        await expectFirstLocation(db, label);
      });
    }
    await rollbackCase(db, async () => {
      await db.exec("UPDATE bookings SET metadata = metadata - 'confirmation_send_id'");
      await expectFirstLocation(db, 'unbound audit is not phone-global history');
    });
    console.log('PASS location-once SQL: Staff status/receipt/tenant/recipient/channel/chat-age exclusions');
    await db.exec('DELETE FROM guest_message_sends');
    await expectFirstLocation(db, 'fresh chat includes location', {
      location_already_sent: true, location_history_status: 'already_sent',
      conversation_id: '30000000-0000-4000-8000-000000000099',
      confirmation_draft: { ...DRAFT, location_already_sent: true },
    });
    await rollbackCase(db, async () => {
      await db.query(`UPDATE bookings SET metadata = metadata || $1::jsonb`, [JSON.stringify({
        location_already_sent: true, confirmation_draft: { ...DRAFT, location_already_sent: true },
        conversation_history: [{ role: 'assistant', text: MAP }],
      })]);
      await expectFirstLocation(db, 'metadata/draft flags and quoted history are not send evidence');
    });
    for (const [label, message] of [
      ['inbound quoted map', { direction: 'inbound' }],
      ['other chat', { chat: '30000000-0000-4000-8000-000000000099' }],
      ['other tenant message', { client: '10000000-0000-4000-8000-000000000099' }],
      ['draft source', { source: 'hermes_luna_whatsapp_draft' }],
      ['no accepted receipt', { wamid: null }],
      ['blank receipt', { wamid: '  ' }],
      ['no location', { text: 'Invoice fixture' }],
      ['different map URL', { text: `${MAP}untrusted` }],
      ['different dotted URL', { text: `${MAP}.invalid` }],
    ]) {
      await rollbackCase(db, async () => {
        await insertMirror(db, message);
        await expectFirstLocation(db, label);
      });
    }
    console.log('PASS location-once SQL: fresh chat, untrusted flags, inbound/draft/foreign history, exact URL');

    await insertMirror(db);
    await rollbackCase(db, async () => {
      await db.exec('DELETE FROM booking_conversation_links; UPDATE conversations SET current_hold_booking_id = NULL');
      const unresolved = await expectFirstLocation(db, 'phone alone must not resolve a chat');
      assert.equal(unresolved.location_history_status, 'chat_identity_unresolved');
    });
    await rollbackCase(db, async () => {
      await db.query(`INSERT INTO conversations (id, client_id, phone, current_hold_booking_id)
        VALUES ('30000000-0000-4000-8000-000000000099', $1, '+999000000002', $2)`, [CLIENT, BOOKING]);
      const ambiguous = await expectFirstLocation(db, 'conflicting durable chats must not suppress even if only one phone matches');
      assert.equal(ambiguous.location_history_status, 'chat_identity_unresolved');
    });
    console.log('PASS location-once SQL: missing/conflicting durable identity retains location');
    await rollbackCase(db, async () => {
      // A new durable chat for the same known guest must not inherit the old bubble.
      const freshChat = '30000000-0000-4000-8000-000000000002';
      await db.exec('UPDATE conversations SET current_hold_booking_id = NULL');
      await db.query(`INSERT INTO conversations (id, client_id, phone, current_hold_booking_id)
        SELECT $1, client_id, phone, $2 FROM conversations WHERE id = $3`, [freshChat, BOOKING, CHAT]);
      await db.query('UPDATE booking_conversation_links SET conversation_id = $1', [freshChat]);
      await expectFirstLocation(db, 'fresh chat for same guest');
    });
    await rollbackCase(db, async () => {
      // The immutable link still resolves after the mutable hold pointer moves on.
      await db.exec('UPDATE conversations SET current_hold_booking_id = NULL');
      assert.equal((await preview(db)).location_already_sent, true);
    });
    await rollbackCase(db, async () => {
      await db.exec('DELETE FROM booking_conversation_links');
      assert.equal((await preview(db)).location_already_sent, true, 'legacy hold pointer remains usable');
    });
    await rollbackCase(db, async () => {
      await db.query(`UPDATE bookings SET metadata = jsonb_set(metadata, '{confirmation_draft,language}', '"es"')`);
      const spanish = await preview(db);
      assert.equal(spanish.location_already_sent, true);
      assert.equal(spanish.message_preview.includes(MAP), false);
      assert.match(spanish.message_preview, /Pago recibido/);
      assert.match(spanish.message_preview, /15:00/);
      assert.match(spanish.message_preview, /fixture-gate/);
    });
    console.log('PASS location-once SQL: fresh same-phone chat, durable/legacy links, Spanish preview');

    await db.exec('DELETE FROM messages');
    await db.query(`INSERT INTO guest_message_sends
      (id, client_slug, to_phone, send_kind, status, provider_message_id, message_text, sent_at)
      VALUES ('40000000-0000-4000-8000-000000000002', 'wolfhouse-somo', '+340000000001',
        'confirmation', 'sent', 'wamid.prior-booking', $1, now())`, [MAP]);
    const priorBooking = '20000000-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO bookings (id, client_id, booking_code, phone, metadata)
      VALUES ($1, $2, 'LOCATION-PRIOR', '+340000000001', $3)`,
    [priorBooking, CLIENT, JSON.stringify({ confirmation_send_id: '40000000-0000-4000-8000-000000000002' })]);
    await db.query('INSERT INTO booking_conversation_links (client_id, conversation_id, booking_id) VALUES ($1, $2, $3)',
      [CLIENT, CHAT, priorBooking]);
    assert.equal((await preview(db)).location_already_sent, true, 'once per chat, not once per booking');
    await rollbackCase(db, async () => {
      await db.query(`INSERT INTO conversations (id, client_id, phone)
        VALUES ('30000000-0000-4000-8000-000000000003', $1, '+340000000001')`, [CLIENT]);
      await db.query(`UPDATE booking_conversation_links SET conversation_id = '30000000-0000-4000-8000-000000000003'
        WHERE booking_id = $1`, [priorBooking]);
      await expectFirstLocation(db, 'accepted Staff send in another same-phone chat must not suppress');
    });
    console.log('PASS location-once SQL: prior booking in same chat counts; another same-phone chat does not');

    await db.exec('ALTER TABLE messages RENAME TO unavailable_messages');
    const unavailable = await runGuestConfirmationPreviewDryRun({ client_slug: 'wolfhouse-somo', booking_id: BOOKING }, { pg: db });
    assert.equal(unavailable.success, true);
    assert.equal(unavailable.location_already_sent, false);
    assert.equal(unavailable.location_history_status, 'lookup_unavailable');
    assert.ok(unavailable.message_preview.includes(MAP));
    assert.ok(unavailable.message_preview.includes(ADDRESS));
    await db.exec('ALTER TABLE unavailable_messages RENAME TO messages');
    await db.exec('ALTER TABLE booking_conversation_links RENAME TO unavailable_links');
    const unavailableIdentity = await runGuestConfirmationPreviewDryRun({ client_slug: 'wolfhouse-somo', booking_id: BOOKING }, { pg: db });
    assert.equal(unavailableIdentity.success, true);
    assert.equal(unavailableIdentity.location_history_status, 'lookup_unavailable');
    assert.ok(unavailableIdentity.message_preview.includes(MAP));
    console.log('PASS location-once SQL: unavailable history/identity keeps location with non-PII diagnostic');
  } finally {
    await db.close();
  }
}

(async () => {
  verifyRenderer();
  await verifyRouteBinding();
  await verifyHistory();
})().catch((error) => { console.error(error); process.exitCode = 1; });
