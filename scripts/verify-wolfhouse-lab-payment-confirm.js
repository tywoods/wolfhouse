'use strict';

/**
 * Wolfhouse Lab payment confirmation.
 *
 * Sunset's Staff Lab already shows a Confirmation step after a test booking
 * is paid. Wolfhouse Lab must show the same step, and must not invent it
 * when the test booking is not paid. Sunset's confirmation_sent_at path
 * stays the only way a non-Lab or Sunset thread grows that step.
 *
 * Confirm path and not-paid path are painted at 1280 and 390.
 * A settled €200 deposit on a €600 booking is replayed through the real
 * inbox thread composite handler, not a hand-made payment status.
 * Run: node scripts/verify-wolfhouse-lab-payment-confirm.js
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LIST = path.join(ROOT, 'scripts/browser/inbox-list.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const ROWS = path.join(ROOT, 'scripts/browser/inbox-rows.js');
const QUERIES = path.join(ROOT, 'scripts/lib/staff-conversation-queries.js');

function functionSlice(src, name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const end = nextName ? src.indexOf(`function ${nextName}(`, start + 1) : src.length;
  if (end < 0) throw new Error(`Missing function ${nextName}`);
  return src.slice(start, end);
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function loadRealHelpers() {
  const listSrc = fs.readFileSync(LIST, 'utf8');
  const rowsSrc = fs.readFileSync(ROWS, 'utf8');
  const names = [
    'inboxConfirmationEventsFromBookings',
    'inboxRememberConfirmationEvents',
    'inboxMergeConfirmationEvents',
    'renderInboxThreadMessagesHtml',
    'inboxConversationIsWolfhouseLab',
    'inboxBookingPaymentConfirmed',
  ];
  const sandbox = {
    console,
    t(key) { return key; },
    escHtml(v) { return String(v == null ? '' : v); },
    fmtTs(v) { return String(v || ''); },
    formatInboxThreadBubbleHtml(m) { return sandbox.escHtml(m && m.message_text || ''); },
    inboxThreadDayKey(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '';
      return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    },
    inboxThreadDayLabel(ts) { return sandbox.inboxThreadDayKey(ts); },
    getClient() { return sandbox.client; },
    client: 'wolfhouse-somo',
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const pieces = [extractFunctionSource(rowsSrc, 'inboxRowIsOwnerLab')];
  for (const name of names) pieces.push(extractFunctionSource(listSrc, name));
  vm.runInContext(pieces.join('\n'), sandbox);
  return sandbox;
}

const PAID_AT = '2026-10-17T18:04:00.000Z';
const GUEST_AT = '2026-10-17T17:40:00.000Z';

function paidBooking() {
  return {
    booking_code: 'WH-LAB-1',
    booking_payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    payment_amount_paid_cents: 20000,
    payment_paid_at: PAID_AT,
    confirmation_sent_at: null,
  };
}

function unpaidBooking() {
  return {
    booking_code: 'WH-LAB-1',
    booking_payment_status: 'payment_pending',
    payment_record_status: 'checkout_created',
    payment_amount_paid_cents: 0,
    confirmation_sent_at: null,
  };
}

function guestMessages() {
  return [{
    direction: 'inbound',
    source: 'whatsapp',
    message_text: 'We paid the test link',
    created_at: GUEST_AT,
  }];
}

function paint(sandbox, bookings, opts) {
  sandbox.inboxRememberConfirmationEvents(bookings, opts || {});
  return sandbox.renderInboxThreadMessagesHtml(guestMessages());
}

function assertConfirmStep(html, label) {
  assert.match(html, /Booking confirmed/, `${label} shows Booking confirmed`);
  assert.match(html, /WH-LAB-1/, `${label} names the test booking`);
  assert.match(html, /Confirmation/, `${label} labels the step Confirmation`);
  assert.match(html, /We paid the test link/, `${label} keeps the guest message`);
}

function assertNoConfirmStep(html, label) {
  assert.doesNotMatch(html, /Booking confirmed/, `${label} does not invent a confirmation`);
  assert.doesNotMatch(html, /WH-LAB-1/, `${label} does not name an unconfirmed booking`);
  assert.match(html, /We paid the test link/, `${label} keeps the guest message`);
}

function unitChecks() {
  const sandbox = loadRealHelpers();
  const threadSrc = fs.readFileSync(THREAD, 'utf8');
  const querySrc = fs.readFileSync(QUERIES, 'utf8');
  const detailSql = functionSlice(querySrc, 'getConversationDetailQuery', 'getConversationMessagesQuery');
  const bookingsSql = functionSlice(querySrc, 'getConversationBookingsQuery', 'getConversationDraftQuery');

  assert.match(detailSql, /open_phone_testing/, 'Lab flag is on the thread detail row');
  assert.match(detailSql, /guest_tester_class/, 'Lab class is on the thread detail row');
  assert.match(bookingsSql, /payment_paid_at/, 'paid time is available to the Lab step');
  assert.match(
    threadSrc,
    /inboxRememberConfirmationEvents\(bookingRows,\s*\{[\s\S]*wolfhouseLab/,
    'thread load asks the real helper for the Wolfhouse Lab step',
  );

  sandbox.client = 'wolfhouse-somo';
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: true,
  }), true, 'Wolfhouse Lab conversation is in scope');
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    guest_tester_class: 'Simulator',
  }), true, 'Wolfhouse simulator class is in scope');
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: false,
  }), false, 'a real Wolfhouse conversation is not Lab');
  sandbox.client = 'sunset';
  assert.equal(sandbox.inboxConversationIsWolfhouseLab({
    open_phone_testing: true,
  }), false, 'Sunset Lab is not this Wolfhouse path');
  sandbox.client = 'wolfhouse-somo';

  const paidHtml = paint(sandbox, [paidBooking()], { wolfhouseLab: true });
  assertConfirmStep(paidHtml, 'paid Wolfhouse Lab');
  const unpaidHtml = paint(sandbox, [unpaidBooking()], { wolfhouseLab: true });
  assertNoConfirmStep(unpaidHtml, 'not-paid Wolfhouse Lab');
  const partialHtml = paint(sandbox, [{
    ...unpaidBooking(),
    booking_payment_status: 'partial',
    payment_record_status: 'partial',
    payment_amount_paid_cents: 1000,
  }], { wolfhouseLab: true });
  assertNoConfirmStep(partialHtml, 'partial Wolfhouse Lab');

  const realPaid = paint(sandbox, [paidBooking()], { wolfhouseLab: false });
  assertNoConfirmStep(realPaid, 'paid non-Lab Wolfhouse');

  sandbox.client = 'sunset';
  const sunsetPaid = paint(sandbox, [paidBooking()], { wolfhouseLab: false });
  assertNoConfirmStep(sunsetPaid, 'Sunset without confirmation_sent_at');
  const sunsetSent = paint(sandbox, [{
    ...paidBooking(),
    booking_code: 'SUN-LAB-1',
    confirmation_sent_at: '2026-10-17T18:05:00.000Z',
  }], { wolfhouseLab: false });
  assert.match(sunsetSent, /Booking confirmed/, 'Sunset sent confirmation still shows');
  assert.match(sunsetSent, /SUN-LAB-1/, 'Sunset sent confirmation keeps its code');

  return { paidHtml, unpaidHtml };
}

function pageHtml(threadHtml, width) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body{margin:0;font:14px/1.4 system-ui,sans-serif;background:#f6f1ea;color:#1c1c1e}
  .lab-shell{box-sizing:border-box;width:${width}px;min-height:100vh;padding:12px}
  .inbox-owner-lab-chip{display:inline-flex;margin-bottom:10px;padding:2px 8px;border-radius:999px;background:#e7f4f3;color:#1f6f6b;font-size:12px;font-weight:700}
  .thread{display:flex;flex-direction:column;gap:8px}
  .msg{max-width:100%}
  .msg-bubble{display:inline-block;max-width:100%;padding:8px 10px;border-radius:12px;background:#fff;border:1px solid #e6dfd4;white-space:pre-wrap;overflow-wrap:anywhere}
  .msg.outbound .msg-bubble{background:#e7f4f3}
  .msg-meta{font-size:11px;color:#6e6e73;margin-top:2px}
  .inbox-thread-day{font-size:11px;color:#6e6e73;text-align:center}
</style>
</head>
<body>
  <div class="lab-shell" id="lab-shell">
    <div class="inbox-owner-lab-chip">Lab</div>
    <div class="thread" id="thread">${threadHtml}</div>
  </div>
</body>
</html>`;
}

async function paintWidths(paidHtml, unpaidHtml) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.setContent(pageHtml(paidHtml, width), { waitUntil: 'load' });
      const paid = await page.evaluate(() => {
        const shell = document.getElementById('lab-shell');
        const step = [...document.querySelectorAll('.msg')].find((node) => /Booking confirmed/.test(node.textContent || ''));
        const bubble = step && step.querySelector('.msg-bubble');
        const box = bubble ? bubble.getBoundingClientRect() : null;
        return {
          lab: /Lab/.test(document.body.innerText),
          confirmed: /Booking confirmed/.test(document.body.innerText),
          sender: step ? (step.querySelector('.msg-meta') || {}).textContent : '',
          box,
          overflow: shell.scrollWidth > shell.clientWidth + 1,
          inView: !!(box && box.width > 0 && box.left >= -1 && box.right <= window.innerWidth + 1),
        };
      });
      assert.equal(paid.lab, true, `${width}px Lab chrome is visible`);
      assert.equal(paid.confirmed, true, `${width}px confirm path shows the step`);
      assert.match(paid.sender || '', /Confirmation/, `${width}px step is labeled Confirmation`);
      assert.equal(paid.overflow, false, `${width}px confirm path does not overflow`);
      assert.equal(paid.inView, true, `${width}px confirmation bubble is in view`);

      await page.setContent(pageHtml(unpaidHtml, width), { waitUntil: 'load' });
      const unpaid = await page.evaluate(() => ({
        confirmed: /Booking confirmed/.test(document.body.innerText),
        guest: /We paid the test link/.test(document.body.innerText),
        overflow: document.getElementById('lab-shell').scrollWidth
          > document.getElementById('lab-shell').clientWidth + 1,
      }));
      assert.equal(unpaid.confirmed, false, `${width}px not-paid path hides the step`);
      assert.equal(unpaid.guest, true, `${width}px not-paid path keeps the guest message`);
      assert.equal(unpaid.overflow, false, `${width}px not-paid path does not overflow`);
      console.log(`PASS ${width}px confirm path and not-paid path`);
    }
  } finally {
    await browser.close();
  }
}

const CLIENT_ID = '00000000-0000-0000-0000-000000000001';
const CHECK_IN = '2026-10-01';
const CHECK_OUT = '2026-10-08';

function compositeSchemaSql() {
  return `
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text);
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      client_id uuid,
      phone text,
      display_name text,
      email text,
      language text,
      bot_mode text,
      needs_human boolean,
      status text,
      conversation_stage text,
      pending_action text,
      last_message_preview text,
      last_bot_reply text,
      staff_reply_draft text,
      human_notes text,
      internal_staff_notes text,
      last_staff_reply_at timestamptz,
      conversation_summary text,
      created_at timestamptz,
      updated_at timestamptz,
      metadata jsonb,
      session_state jsonb,
      customer_id uuid,
      current_hold_booking_id uuid
    );
    CREATE TABLE bookings (
      id uuid PRIMARY KEY,
      client_id uuid,
      booking_code text,
      guest_name text,
      guest_count int,
      package_code text,
      phone text,
      check_in date,
      check_out date,
      status text,
      payment_status text,
      hold_expires_at timestamptz,
      confirmation_sent_at timestamptz,
      requested_room_type text,
      room_preference text,
      guest_gender_group_type text,
      assignment_status text,
      needs_rooming_review boolean,
      rooming_notes text,
      primary_room_code text,
      booking_source text,
      created_at timestamptz,
      total_amount_cents int,
      amount_paid_cents int,
      balance_due_cents int,
      deposit_required_cents int,
      metadata jsonb
    );
    CREATE TABLE booking_beds (
      booking_id uuid,
      room_code text,
      bed_code text,
      planning_row_label text,
      assignment_start_date date
    );
    CREATE TABLE payments (
      id uuid PRIMARY KEY,
      client_id uuid,
      booking_id uuid,
      status text,
      amount_due_cents int,
      amount_paid_cents int,
      paid_at timestamptz,
      created_at timestamptz,
      stripe_payment_intent_id text,
      finance_exclusion text,
      metadata jsonb
    );
    CREATE TABLE booking_service_records (
      id uuid PRIMARY KEY,
      booking_id uuid,
      client_slug text,
      status text,
      amount_due_cents int,
      metadata jsonb
    );
    CREATE TABLE staff_handoffs (
      id uuid PRIMARY KEY,
      conversation_id uuid,
      status text,
      reason_code text,
      priority text,
      summary text,
      assigned_staff text,
      opened_at timestamptz
    );
    CREATE TABLE customers (id uuid PRIMARY KEY, client_id uuid, phone text);
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      client_id uuid,
      conversation_id uuid,
      direction text,
      message_text text,
      language text,
      route text,
      source text,
      conversation_stage text,
      created_at timestamptz,
      metadata jsonb
    );
    CREATE TABLE tenant_email_inbound_inbox_projections (
      client_id uuid,
      conversation_id uuid,
      inbound_event_id uuid
    );
    CREATE TABLE tenant_email_inbound_events (
      id uuid,
      client_id uuid,
      subject text,
      received_at timestamptz
    );
    INSERT INTO clients VALUES ('${CLIENT_ID}', 'wolfhouse-somo');
  `;
}

function compositeRoutes(db) {
  const { createInboxThreadCompositeRoutes } = require('./lib/staff-inbox-thread-composite');
  const inboxHelpers = require('./lib/staff-inbox-helpers');
  let response;
  const routes = createInboxThreadCompositeRoutes({
    ...inboxHelpers,
    sendJSON(_res, status, body) { response = { status, body }; },
    send400() { throw new Error('unexpected 400'); },
    send404() { response = { status: 404, body: { success: false, error: 'Not found' } }; },
    assertStaffClientAccess() { return true; },
    appendAuditLog() {},
    withPgClient: (fn) => fn(db),
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /;/,
    resolveSunsetConversationScope: () => ({ queryOpts: {} }),
    conversationDetailQueryParams: (slug, id) => [slug, id],
  });
  return {
    routes,
    take() { return response; },
  };
}

async function insertCompositeCase(db, spec) {
  await db.query(
    `INSERT INTO conversations (
       id, client_id, phone, display_name, status, bot_mode, needs_human,
       created_at, updated_at, metadata, session_state, current_hold_booking_id
     ) VALUES ($1, $2, $3, 'Lab guest', 'open', 'bot', false, now(), now(), $4::jsonb, '{}'::jsonb, $5)`,
    [spec.convId, CLIENT_ID, spec.phone, JSON.stringify({ open_phone_testing: 'true' }), spec.bookingId],
  );
  await db.query(
    `INSERT INTO bookings (
       id, client_id, booking_code, guest_name, guest_count, phone, check_in, check_out,
       status, payment_status, created_at, total_amount_cents, amount_paid_cents,
       balance_due_cents, deposit_required_cents, metadata
     ) VALUES (
       $1, $2, $3, 'Lab guest', 1, $4, $5, $6, 'confirmed', $7, now(), 60000, 0, 60000, 20000, '{}'::jsonb
     )`,
    [spec.bookingId, CLIENT_ID, spec.code, spec.phone, CHECK_IN, CHECK_OUT, spec.paymentStatus],
  );
  await db.query(
    `INSERT INTO messages (
       id, client_id, conversation_id, direction, message_text, source, created_at, metadata
     ) VALUES ($1, $2, $3, 'inbound', 'We paid the test link', 'whatsapp', $4, '{}'::jsonb)`,
    [spec.messageId, CLIENT_ID, spec.convId, GUEST_AT],
  );
  if (spec.paidCents > 0) {
    await db.query(
      `INSERT INTO payments (
         id, client_id, booking_id, status, amount_due_cents, amount_paid_cents,
         paid_at, created_at, finance_exclusion, metadata
       ) VALUES ($1, $2, $3, 'paid', $4, $4, now(), now(), NULL, '{}'::jsonb)`,
      [spec.paymentId, CLIENT_ID, spec.bookingId, spec.paidCents],
    );
  }
}

async function replayCompositeCase(db, box, spec) {
  await insertCompositeCase(db, spec);
  await box.routes.handleInboxThreadComposite(spec.convId, { client: 'wolfhouse-somo' }, {}, {});
  const response = box.take();
  assert.equal(response && response.status, 200, `${spec.label} composite status ${JSON.stringify(response && response.body)}`);
  const body = response.body;
  assert.equal(body.context && body.context.success, true, `${spec.label} context ${JSON.stringify(body.context)}`);
  const booking = (body.context.bookings || [])[0];
  assert.ok(booking, `${spec.label} composite bookings came from the handler`);
  assert.equal(booking.booking_code, spec.code, `${spec.label} booking is the inserted row`);
  const conversation = body.detail && body.detail.conversation;
  assert.equal(conversation && conversation.open_phone_testing, true, `${spec.label} Lab flag came from the detail query`);
  return { booking, conversation };
}

async function compositeDepositReplay() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(compositeSchemaSql());
    const box = compositeRoutes(db);
    const sandbox = loadRealHelpers();
    sandbox.client = 'wolfhouse-somo';
    const settled = await replayCompositeCase(db, box, {
      label: '€200/€600 settled deposit',
      convId: '11111111-1111-4111-8111-111111111111',
      bookingId: '22222222-2222-4222-8222-222222222222',
      paymentId: '33333333-3333-4333-8333-333333333333',
      messageId: '44444444-4444-4444-8444-444444444444',
      phone: '+34600000191',
      code: 'WH-LAB-1',
      paymentStatus: 'deposit_paid',
      paidCents: 20000,
    });
    assert.equal(settled.booking.booking_payment_status, 'partial', 'handler hydration keeps a settled deposit as display partial');
    assert.equal(settled.booking.deposit_completed, true, 'read model carries deposit completed');
    assert.equal(Number(settled.booking.payment_amount_paid_cents), 20000, 'handler ledger paid is €200');
    assert.equal(Number(settled.booking.payment_amount_due_cents), 40000, 'handler balance remains €400');
    assert.equal(sandbox.inboxConversationIsWolfhouseLab(settled.conversation), true, 'composite detail is Wolfhouse Lab');
    const settledHtml = paint(sandbox, [settled.booking], {
      wolfhouseLab: sandbox.inboxConversationIsWolfhouseLab(settled.conversation),
    });
    assertConfirmStep(settledHtml, '€200/€600 settled deposit through the composite handler');

    const tooSmall = await replayCompositeCase(db, box, {
      label: '€10/€600 too-small partial',
      convId: '11111111-1111-4111-8111-111111111112',
      bookingId: '22222222-2222-4222-8222-222222222223',
      paymentId: '33333333-3333-4333-8333-333333333334',
      messageId: '44444444-4444-4444-8444-444444444445',
      phone: '+34600000192',
      code: 'WH-LAB-SMALL',
      paymentStatus: 'payment_pending',
      paidCents: 1000,
    });
    assert.equal(tooSmall.booking.booking_payment_status, 'partial', 'too-small payment stays display partial');
    assert.notEqual(tooSmall.booking.deposit_completed, true, 'too-small partial is not deposit completed');
    const tooSmallHtml = paint(sandbox, [tooSmall.booking], { wolfhouseLab: true });
    assert.doesNotMatch(tooSmallHtml, /Booking confirmed/, 'too-small partial stays unconfirmed');
    assert.doesNotMatch(tooSmallHtml, /WH-LAB-SMALL/, 'too-small partial is not named');

    const fullyPaid = await replayCompositeCase(db, box, {
      label: '€600/€600 fully paid',
      convId: '11111111-1111-4111-8111-111111111113',
      bookingId: '22222222-2222-4222-8222-222222222224',
      paymentId: '33333333-3333-4333-8333-333333333335',
      messageId: '44444444-4444-4444-8444-444444444446',
      phone: '+34600000193',
      code: 'WH-LAB-PAID',
      paymentStatus: 'paid',
      paidCents: 60000,
    });
    assert.equal(fullyPaid.booking.booking_payment_status, 'paid', 'fully paid display status stays paid');
    const paidHtml = paint(sandbox, [fullyPaid.booking], { wolfhouseLab: true });
    assert.match(paidHtml, /Booking confirmed/, 'fully paid composite path still confirms');
    assert.match(paidHtml, /WH-LAB-PAID/, 'fully paid composite path names its booking');

    const unpaid = await replayCompositeCase(db, box, {
      label: 'unpaid',
      convId: '11111111-1111-4111-8111-111111111114',
      bookingId: '22222222-2222-4222-8222-222222222225',
      messageId: '44444444-4444-4444-8444-444444444447',
      phone: '+34600000194',
      code: 'WH-LAB-OPEN',
      paymentStatus: 'payment_pending',
      paidCents: 0,
    });
    assert.notEqual(unpaid.booking.booking_payment_status, 'paid', 'unpaid composite path is not paid');
    assert.notEqual(unpaid.booking.booking_payment_status, 'deposit_paid', 'unpaid composite path is not deposit_paid');
    const unpaidHtml = paint(sandbox, [unpaid.booking], { wolfhouseLab: true });
    assert.doesNotMatch(unpaidHtml, /Booking confirmed/, 'unpaid composite path stays unconfirmed');

    const realThread = await replayCompositeCase(db, box, {
      label: 'real Wolfhouse thread',
      convId: '11111111-1111-4111-8111-111111111115',
      bookingId: '22222222-2222-4222-8222-222222222226',
      paymentId: '33333333-3333-4333-8333-333333333336',
      messageId: '44444444-4444-4444-8444-444444444448',
      phone: '+34600000195',
      code: 'WH-REAL-1',
      paymentStatus: 'deposit_paid',
      paidCents: 20000,
    });
    await db.query(`UPDATE conversations SET metadata = '{}'::jsonb WHERE id = $1`, [realThread.conversation.conversation_id]);
    await box.routes.handleInboxThreadComposite(realThread.conversation.conversation_id, { client: 'wolfhouse-somo' }, {}, {});
    const realResponse = box.take();
    const realBooking = realResponse.body.context.bookings[0];
    const realConv = realResponse.body.detail.conversation;
    assert.equal(sandbox.inboxConversationIsWolfhouseLab(realConv), false, 'real Wolfhouse thread is not Lab');
    const realHtml = paint(sandbox, [realBooking], {
      wolfhouseLab: sandbox.inboxConversationIsWolfhouseLab(realConv),
    });
    assert.doesNotMatch(realHtml, /Booking confirmed/, 'real Wolfhouse thread does not invent a confirmation');

    return { settledHtml, tooSmallHtml };
  } finally {
    await db.close();
  }
}

async function main() {
  const painted = unitChecks();
  console.log('PASS unit confirm path and not-paid path');
  const composite = await compositeDepositReplay();
  console.log('PASS composite €200/€600 settled deposit, too-small partial, fully paid, unpaid');
  await paintWidths(painted.paidHtml, painted.unpaidHtml);
  await paintWidths(composite.settledHtml, composite.tooSmallHtml);
  console.log('PASS verify-wolfhouse-lab-payment-confirm');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
