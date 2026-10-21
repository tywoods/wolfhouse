'use strict';

/**
 * Offline proof for Wolfhouse paid confirmation (DH-PAID-CONFIRMATION-BUILD).
 * Calls the real Staff confirmation helpers. No network, no flag flip, no send.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildWolfhousePaidConfirmationCopy,
  passesConfirmationStyleContract,
} = require('./lib/luna-guest-confirmation-copy-style');
const { buildConfirmationPreviewFromPlaybook } = require('./lib/luna-client-messaging-playbook');
const { runGuestConfirmationPreviewDryRun } = require('./lib/luna-guest-confirmation-preview-dry-run');
const {
  tryAutoSendBookingConfirmation,
  isAutoConfirmationSendEnabled,
} = require('./lib/luna-guest-confirmation-auto-send');
const {
  evaluateGuestReplySendRoute,
  collectEnvGateReasons,
} = require('./lib/luna-guest-reply-send-route');
const { sendLunaBookingConfirmation } = require('./lib/luna-booking-confirmation-send');

const BOOKING = '11111111-1111-4111-8111-111111111111';
const CODE = 'WH-20261115-13007123';
const PHONE = '+34600111222';

function euroCount(message, code) {
  return message.split(code).length - 1;
}

function assertQuoteStyle(message, facts) {
  assert.match(message, /🌊/);
  assert.match(message, /📅/);
  assert.match(message, /🛏️/);
  assert.match(message, /💶/);
  assert.match(message, /📌/);
  assert.equal(euroCount(message, facts.booking_code), 1, message);
  assert.doesNotMatch(message, /\.00\b/);
  assert.doesNotMatch(message, /created successfully/i);
  assert.doesNotMatch(message, /Payment options|Amount due now|Booking reference|which would you like/i);
  assert.doesNotMatch(message, /^one bed/im);
  assert.doesNotMatch(message, /for Fabio/i);
  assert.match(message, facts.received);
  assert.match(message, facts.money);
  if (facts.remain) assert.match(message, facts.remain);
  else assert.doesNotMatch(message, /balance due|remaining balance|saldo|pay the balance/i);
  if (facts.room) assert.match(message, facts.room);
  if (facts.dates) assert.match(message, facts.dates);
  if (facts.absent) {
    for (const needle of facts.absent) assert.doesNotMatch(message, needle);
  }
}

const depositFacts = {
  language: 'en',
  guest_name: 'Fabio',
  booking_code: CODE,
  payment_status: 'deposit_paid',
  amount_paid_cents: 20000,
  balance_due_cents: 25000,
  total_amount_cents: 45000,
  check_in: '2026-11-15',
  check_out: '2026-11-24',
  guest_count: 1,
  room_kind: 'mixed',
  room_number: 'R3',
  gate_code: '2684#',
  address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
  maps_link: 'https://maps.app.goo.gl/oPRckhqozVBvXxL16',
};

const enDeposit = buildWolfhousePaidConfirmationCopy(depositFacts);
assertQuoteStyle(enDeposit, {
  booking_code: CODE,
  received: /Deposit received/i,
  money: /€200/,
  remain: /€250/,
  room: /A bed in a shared room/,
  dates: /Sun 15 Nov – Tue 24 Nov · 1 guest/,
});
assert.match(enDeposit, /Wolfhouse family/);
assert.match(enDeposit, /2684#/);
assert.match(enDeposit, /Somo/);
assert.match(enDeposit, /maps\.app\.goo\.gl\/oPRckhqozVBvXxL16/);
assert.match(enDeposit, /R3/);
assert.equal(passesConfirmationStyleContract(enDeposit, {
  booking_code: CODE,
  amount_paid_cents: 20000,
  balance_due_cents: 25000,
}).ok, true, JSON.stringify(passesConfirmationStyleContract(enDeposit, {
  booking_code: CODE,
  amount_paid_cents: 20000,
  balance_due_cents: 25000,
})));

const enFull = buildWolfhousePaidConfirmationCopy({
  ...depositFacts,
  payment_status: 'paid',
  amount_paid_cents: 45000,
  balance_due_cents: 0,
});
assertQuoteStyle(enFull, {
  booking_code: CODE,
  received: /Payment received/i,
  money: /€450/,
  room: /A bed in a shared room/,
  dates: /Sun 15 Nov/,
});
assert.doesNotMatch(enFull, /€250/);
assert.doesNotMatch(enFull, /Deposit received/i);

const es = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'es' });
assertQuoteStyle(es, {
  booking_code: CODE,
  received: /Depósito recibido/,
  money: /€200/,
  remain: /€250/,
  room: /cama en una habitación compartida/,
  dates: /15 nov/,
  absent: [/Deposit received/i, /Booking:/],
});

const de = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'de' });
assert.match(de, /Anzahlung erhalten/);
assert.match(de, /Wolfhouse-Familie/);
assert.doesNotMatch(de, /Deposit received|Booking:/);

const fr = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'fr' });
assert.match(fr, /Acompte reçu/);
assert.match(fr, /chambre partagée/);
assert.doesNotMatch(fr, /Deposit received/);

const it = buildWolfhousePaidConfirmationCopy({
  ...depositFacts,
  language: 'it',
  room_kind: 'private',
  guest_count: 2,
});
assert.match(it, /Acconto ricevuto/);
assert.match(it, /camera privata/);
assert.match(it, /2 ospiti/);

(async () => {
  const preview = await runGuestConfirmationPreviewDryRun({
    client_slug: 'wolfhouse-somo',
    booking_code: CODE,
    payment_status: 'deposit_paid',
    language_hint: 'en',
    guest_name: 'Fabio',
    confirmation_draft: {
      ...depositFacts,
      payment_status: 'deposit_paid',
    },
  }, { use_fixture_pg: true });
  assert.equal(preview.confirmation_preview_ready, true, JSON.stringify(preview.block_reasons));
  assert.match(preview.proposed_confirmation_message, /Deposit received/);
  assert.match(preview.proposed_confirmation_message, /🌊/);
  assert.doesNotMatch(preview.proposed_confirmation_message, /created successfully/i);
  assert.equal(euroCount(preview.proposed_confirmation_message, CODE), 1);

  const sunset = buildConfirmationPreviewFromPlaybook('sunset', 'en', {
    guest_name: 'Francisco',
    booking_code: 'SUNSET-TEST-001',
    amount_paid_cents: 63000,
    balance_due_cents: 0,
    address: '',
    gate_code: '',
    room_number: '',
  });
  assert.equal(sunset.template_source, 'confirmation_templates');
  assert.match(sunset.message, /payment received/i);
  assert.match(sunset.message, /booking is confirmed/i);
  assert.match(sunset.message, /thank you/i);
  assert.doesNotMatch(sunset.message, /🛏️|Wolfhouse family|Deposit received/);

  const playbook = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'en', {
    guest_name: 'Ty',
    booking_code: 'MB-WOLFHO-20260915-cd8f5b',
    amount_paid_cents: 20000,
    balance_due_cents: 39800,
    room_number: 'R3',
    gate_code: '2684#',
  });
  assert.match(playbook.message, /(^|\n)Booking: MB-WOLFHO-20260915-cd8f5b(\n|$)/);
  assert.match(playbook.message, /officially part of the Wolfhouse family/);

  const confirmOnly = {
    LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'true',
    LUNA_AUTO_SEND_ENABLED: 'false',
    WHATSAPP_DRY_RUN: 'true',
  };
  assert.equal(isAutoConfirmationSendEnabled(confirmOnly, 'wolfhouse-somo'), true);
  assert.equal(isAutoConfirmationSendEnabled(confirmOnly, 'sunset'), false);
  assert.equal(isAutoConfirmationSendEnabled(confirmOnly), false);
  assert.equal(isAutoConfirmationSendEnabled({ LUNA_AUTO_SEND_ENABLED: 'true' }, 'sunset'), true);

  for (const kind of ['ask_missing_field', 'show_quote', 'checkin_day']) {
    assert.ok(
      collectEnvGateReasons(confirmOnly, kind, 'wolfhouse-somo').includes('luna_auto_send_not_enabled'),
      kind,
    );
  }
  assert.deepEqual(collectEnvGateReasons(confirmOnly, 'confirmation', 'wolfhouse-somo'), []);
  assert.ok(collectEnvGateReasons(confirmOnly, 'confirmation', 'sunset').includes('luna_auto_send_not_enabled'));
  assert.deepEqual(collectEnvGateReasons(confirmOnly, 'staff_reply', 'wolfhouse-somo'), []);

  const otherKind = evaluateGuestReplySendRoute({
    client_slug: 'wolfhouse-somo',
    to: PHONE,
    suggested_reply: 'Which dates?',
    send_kind: 'show_quote',
    idempotency_key: 'quote-should-stay-blocked',
    send_eligibility: { requires_staff: false, send_allowed_later: true, auto_send_ready: true },
  }, confirmOnly);
  assert.ok(otherKind.result.blocked_reasons.includes('luna_auto_send_not_enabled'));
  assert.equal(otherKind.result.sends_whatsapp, false);

  const owned = [
    'luna-guest-confirmation-auto-send.js',
    'luna-guest-confirmation-send-go-no-go.js',
    'luna-booking-confirmation-send.js',
    'luna-guest-reply-send-route.js',
    'luna-guest-confirmation-preview-dry-run.js',
    'luna-booking-confirmation-preview.js',
    'luna-guest-confirmation-personality-copy.js',
    'luna-guest-confirmation-copy-style.js',
    'luna-client-messaging-playbook.js',
  ].map((name) => fs.readFileSync(path.join(__dirname, 'lib', name), 'utf8')).join('\n');
  assert.doesNotMatch(owned, /LUNA_AUTO_SEND_ENABLED\s*=\s*['"]true['"]/);
  assert.doesNotMatch(owned, /LUNA_EMAIL_[A-Z0-9_]*ENABLED\s*=/);
  assert.doesNotMatch(owned, /process\.env\.LUNA_AUTO_SEND_ENABLED\s*=/);

  function makePg(state) {
    return {
      async query(sql, params = []) {
        const flat = sql.replace(/\s+/g, ' ').trim();
        state.sql.push(flat);
        if (flat.includes('FROM bookings b INNER JOIN clients c') && flat.includes('confirmation_sent_at') && flat.includes('guest_phone_meta')) {
          if (params[1] !== state.slug) return { rows: [] };
          return { rows: [{
            id: BOOKING,
            booking_code: CODE,
            booking_status: 'confirmed',
            payment_status: state.payment_status,
            confirmation_sent_at: state.confirmation_sent_at,
            guest_phone_meta: PHONE,
            guest_phone_column: null,
            guest_name_meta: 'Fabio',
            guest_name: 'Fabio',
          }] };
        }
        if (flat.includes('LEFT JOIN LATERAL') && flat.includes('FROM payments')) {
          if (params[1] !== state.slug) return { rows: [] };
          return { rows: [{
            amount_paid_cents: state.amount_paid_cents,
            payment_record_status: state.payment_record_status,
            booking_payment_status: state.payment_status,
          }] };
        }
        if (flat.includes("metadata->>'simulator_synthetic'")) return { rows: [] };
        if (flat.includes('confirmation_send_claim_key') && flat.startsWith('UPDATE bookings')) {
          if (state.confirmation_sent_at) return { rows: [] };
          if (state.claim_in_flight) return { rows: [] };
          if (state.claim_key && state.claim_key !== params[2]) return { rows: [] };
          state.claim_key = params[2];
          state.claim_in_flight = true;
          state.claims += 1;
          return { rows: [{ id: BOOKING }] };
        }
        if (flat.includes('confirmation_send_claim_key') && flat.includes('SELECT')) {
          return { rows: [{
            confirmation_sent_at: state.confirmation_sent_at,
            claim_key: state.claim_key,
          }] };
        }
        if (flat.startsWith('UPDATE bookings b') && flat.includes('confirmation_sent_at = NOW()')) {
          if (state.confirmation_sent_at) return { rows: [] };
          state.confirmation_sent_at = '2026-10-21T09:08:14Z';
          return { rows: [{ confirmation_sent_at: state.confirmation_sent_at }] };
        }
        if (flat.includes('SELECT b.confirmation_sent_at')) {
          return { rows: state.confirmation_sent_at ? [{ confirmation_sent_at: state.confirmation_sent_at }] : [] };
        }
        const err = new Error(`unexpected SQL: ${flat}`);
        err.code = '42P01';
        throw err;
      },
    };
  }

  const sends = { count: 0 };
  const liveEnv = {
    LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'true',
    LUNA_AUTO_SEND_ENABLED: 'false',
    WHATSAPP_DRY_RUN: 'false',
  };
  const paid = makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    amount_paid_cents: 20000,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  });

  const previewReady = {
    confirmation_preview_ready: true,
    confirmation_send_allowed: false,
    proposed_confirmation_message: enDeposit,
    message_preview: enDeposit,
    booking_id: BOOKING,
    booking_code: CODE,
    payment_status: 'deposit_paid',
  };

  async function attempt(pg, overrides = {}, env = liveEnv) {
    return tryAutoSendBookingConfirmation({
      booking_id: BOOKING,
      booking_code: CODE,
      to: PHONE,
      client_slug: 'wolfhouse-somo',
      idempotency_key: overrides.idempotency_key || `confirmation:auto:webhook:${CODE}:pay-1`,
      ...overrides,
    }, {
      pg,
      env,
      runGuestConfirmationPreviewDryRun: async () => previewReady,
      sendMessage: async () => {
        sends.count += 1;
        return overrides.provider || { success: true, whatsapp_message_id: 'wamid.PAID1' };
      },
    });
  }

  const disabled = await attempt(makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    amount_paid_cents: 20000,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  }), {}, { LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'false', LUNA_AUTO_SEND_ENABLED: 'false', WHATSAPP_DRY_RUN: 'false' });
  assert.equal(disabled.skip_reason, 'luna_auto_send_not_enabled');
  assert.equal(disabled.attempted, false);
  assert.equal(sends.count, 0);

  const wrongTenant = await attempt(paid, { client_slug: 'sunset' });
  assert.equal(wrongTenant.skip_reason, 'booking_not_found');
  assert.equal(sends.count, 0);

  const unpaid = await attempt(makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'waiting_payment',
    payment_record_status: 'pending',
    amount_paid_cents: 0,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  }));
  assert.equal(unpaid.skip_reason, 'booking_not_paid_yet');
  assert.equal(sends.count, 0);

  const noTruth = await attempt(makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'deposit_paid',
    payment_record_status: 'pending',
    amount_paid_cents: 0,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  }));
  assert.equal(noTruth.skip_reason, 'no_payment_record_truth');
  assert.equal(sends.count, 0);

  const dry = await attempt(makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    amount_paid_cents: 20000,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  }), {}, { ...liveEnv, WHATSAPP_DRY_RUN: 'true' });
  assert.equal(dry.confirmation_sent, false);
  assert.equal(dry.whatsapp_dry_run, true);
  assert.equal(sends.count, 0);

  const first = await attempt(paid);
  assert.equal(first.confirmation_sent, true, JSON.stringify({
    skip: first.skip_reason,
    send: first.send && first.send.send_status,
    reasons: first.send && first.send.blocked_reasons,
  }));
  assert.equal(sends.count, 1);
  assert.match(first.preview.proposed_confirmation_message, /Deposit received/);

  const retry = await attempt(paid, { idempotency_key: `confirmation:auto:webhook:${CODE}:pay-2` });
  assert.notEqual(retry.confirmation_sent, true);
  assert.equal(sends.count, 1);

  const concurrentPg = makePg({
    slug: 'wolfhouse-somo',
    payment_status: 'deposit_paid',
    payment_record_status: 'paid',
    amount_paid_cents: 20000,
    confirmation_sent_at: null,
    claim_key: null,
    claims: 0,
    sql: [],
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const originalQuery = concurrentPg.query.bind(concurrentPg);
  concurrentPg.query = async (sql, params) => {
    if (String(sql).includes('confirmation_send_claim_key') && String(sql).trim().startsWith('UPDATE')) {
      await gate;
    }
    return originalQuery(sql, params);
  };
  const concurrentSends = { count: 0 };
  const concurrentAttempt = (key) => tryAutoSendBookingConfirmation({
    booking_id: BOOKING,
    booking_code: CODE,
    to: PHONE,
    client_slug: 'wolfhouse-somo',
    idempotency_key: key,
  }, {
    pg: concurrentPg,
    env: liveEnv,
    runGuestConfirmationPreviewDryRun: async () => previewReady,
    sendMessage: async () => {
      concurrentSends.count += 1;
      return { success: true, whatsapp_message_id: 'wamid.RACE' };
    },
  });
  const racing = Promise.all([
    concurrentAttempt('confirmation:auto:webhook:WH:evt-a'),
    concurrentAttempt('confirmation:auto:webhook:WH:evt-b'),
  ]);
  release();
  const raced = await racing;
  const sentCount = raced.filter((row) => row.confirmation_sent === true).length;
  assert.equal(sentCount, 1, JSON.stringify(raced.map((row) => row.skip_reason || row.send && row.send.send_status)));
  assert.equal(concurrentSends.count, 1);

  const uncertainPg = {
    marks: 0,
    async query(sql, params) {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('confirmation_sent_at = NOW()')) {
        this.marks += 1;
        return { rows: [{ confirmation_sent_at: '2026-10-21T09:08:14Z' }] };
      }
      if (flat.includes('SELECT b.confirmation_sent_at')) return { rows: [] };
      return { rows: [] };
    },
  };
  const uncertain = await sendLunaBookingConfirmation({
    client_slug: 'wolfhouse-somo',
    booking_id: BOOKING,
    booking_code: CODE,
    to: PHONE,
    idempotency_key: 'confirmation:booking:uncertain',
    confirm_send: true,
  }, {
    pg: uncertainPg,
    env: liveEnv,
    getLunaBookingConfirmationPreview: async () => ({
      success: true,
      booking_id: BOOKING,
      booking_code: CODE,
      message_preview: enDeposit,
      confirmation_sent_at: null,
    }),
    evaluateGuestReplySendRouteWithPause: async () => ({
      ok: true,
      status: 200,
      result: {
        success: true,
        send_performed: true,
        sends_whatsapp: true,
        whatsapp_message_id: null,
        delivery_uncertain: true,
        blocked_reasons: [],
      },
    }),
  });
  assert.equal(uncertain.result.updates_confirmation_sent_at, false);
  assert.equal(uncertain.result.delivery_uncertain, true);
  assert.equal(uncertainPg.marks, 0);

  console.log('verify-wolfhouse-paid-confirmation: PASS');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
