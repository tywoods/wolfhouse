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
const { runGuestConfirmationPreviewDryRun, buildFixturePg } = require('./lib/luna-guest-confirmation-preview-dry-run');
const {
  tryAutoSendBookingConfirmation,
  isAutoConfirmationSendEnabled,
} = require('./lib/luna-guest-confirmation-auto-send');
const {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
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
  received: /\*Payment received — you're officially part of the Wolfhouse family!\* 🎉/,
  money: /💶 \*Paid today:\* €200/,
  remain: /⏳ \*Still to pay:\* €250/,
  room: /🛏️ \*Room:\* A bed in our mixed shared room/,
  dates: /📅 \*Dates:\* Sun 15 Nov – Tue 24 Nov \(9 nights\)/,
});
assert.match(enDeposit, /^Hi Fabio! 🌊/);
assert.match(enDeposit, /👥 \*Guests:\* 1/);
assert.match(enDeposit, /💳 \*Total:\* €450/);
assert.match(enDeposit, /2684#/);
assert.match(enDeposit, /Somo/);
assert.match(enDeposit, /maps\.app\.goo\.gl\/oPRckhqozVBvXxL16/);
assert.doesNotMatch(enDeposit, /\bR3\b/);
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
  received: /\*Payment received — you're officially part of the Wolfhouse family!\* 🎉/,
  money: /💶 \*Paid:\* €450/,
  room: /🛏️ \*Room:\* A bed in our mixed shared room/,
  dates: /📅 \*Dates:\* Sun 15 Nov – Tue 24 Nov \(9 nights\)/,
});
assert.match(enFull, /💳 \*Total:\* €450/);
assert.match(enFull, /✅ \*Fully paid\*, nothing left to pay/);
assert.doesNotMatch(enFull, /€250/);
assert.doesNotMatch(enFull, /Deposit received/i);

const es = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'es' });
assertQuoteStyle(es, {
  booking_code: CODE,
  received: /\*Pago recibido — ¡ya formas parte de la familia Wolfhouse!\* 🎉/,
  money: /💶 \*Pagado hoy:\* €200/,
  remain: /⏳ \*Pendiente:\* €250/,
  room: /🛏️ \*Habitación:\* Una cama en nuestra habitación compartida mixta/,
  dates: /📅 \*Fechas:\* dom 15 nov – mar 24 nov \(9 noches\)/,
  absent: [/Deposit received/i, /Booking:/],
});
assert.match(es, /💳 \*Total:\* €450/);

const de = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'de' });
assert.match(de, /\*Zahlung erhalten — du gehörst jetzt zur Wolfhouse-Familie!\* 🎉/);
assert.match(de, /💶 \*Heute bezahlt:\* €200/);
assert.match(de, /💳 \*Gesamt:\* €450/);
assert.match(de, /⏳ \*Noch offen:\* €250/);
assert.doesNotMatch(de, /Deposit received|Booking:/);

const fr = buildWolfhousePaidConfirmationCopy({ ...depositFacts, language: 'fr' });
assert.match(fr, /Paiement reçu/);
assert.match(fr, /chambre partagée mixte/);
assert.doesNotMatch(fr, /Deposit received/);

const it = buildWolfhousePaidConfirmationCopy({
  ...depositFacts,
  language: 'it',
  room_kind: 'private',
  guest_count: 2,
});
assert.match(it, /Pagamento ricevuto/);
assert.match(it, /Camera privata ospiti 2/);
assert.match(it, /👥 \*Ospiti:\* 2/);

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
  assert.match(preview.proposed_confirmation_message, /💶 \*Paid today:\* €200/);
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
  assert.match(first.preview.proposed_confirmation_message, /💶 \*Paid today:\* €200/);

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

  const copyCode = 'WH-REVIEW-COPY';
  const copyBooking = '44444444-4444-4444-8444-444444444444';
  const storedGermanDraft = {
    booking_code: copyCode,
    payment_status: 'paid',
    language: 'de',
    balance_due_cents: 0,
    amount_paid_cents: 20000,
    room_number: 'R3',
    gate_code: '2684#',
    check_in: '2026-11-15',
    check_out: '2026-11-24',
    guest_count: 1,
  };
  const copyInput = {
    booking_id: copyBooking,
    booking_code: copyCode,
    payment_status: 'paid',
    client_slug: 'wolfhouse-somo',
  };
  const germanBoundary = await runGuestConfirmationPreviewDryRun({
    ...copyInput,
    language_hint: 'en',
  }, { pg: buildFixturePg(copyInput, storedGermanDraft) });
  assert.equal(germanBoundary.confirmation_preview_ready, true, JSON.stringify(germanBoundary.block_reasons));
  assert.match(germanBoundary.proposed_confirmation_message, /Zahlung erhalten/);
  assert.match(germanBoundary.proposed_confirmation_message, /€200/);
  assert.doesNotMatch(germanBoundary.proposed_confirmation_message, /Payment received/);

  const amountDraft = { ...storedGermanDraft, language: 'en' };
  delete amountDraft.amount_paid_cents;
  const amountBoundary = await runGuestConfirmationPreviewDryRun({
    booking_code: copyCode,
    payment_status: 'paid',
    client_slug: 'wolfhouse-somo',
    language_hint: 'en',
  }, { pg: buildFixturePg({ booking_code: copyCode, payment_status: 'paid', client_slug: 'wolfhouse-somo' }, amountDraft) });
  assert.equal(amountBoundary.confirmation_preview_ready, true, JSON.stringify(amountBoundary.block_reasons));
  assert.match(amountBoundary.proposed_confirmation_message, /💶 \*Paid:\* €200/);
  assert.match(amountBoundary.proposed_confirmation_message, /💳 \*Total:\* €200/);

  const roomProbeId = '00000000-0000-4000-8000-000000000027';
  function roomProbePg(draftRoom, primaryRoom, bedRooms) {
    const row = {
      booking_id: roomProbeId,
      booking_code: 'WH-ROOM-PROBE',
      payment_status: 'deposit_paid',
      confirmation_sent_at: null,
      primary_room_code: primaryRoom,
      amount_paid_cents: 20000,
      total_amount_cents: 100000,
      language: 'en',
      check_in: '2026-06-05',
      check_out: '2026-06-10',
      guest_count: 2,
      requested_room_type: 'shared',
      room_preference: 'shared',
      metadata: {
        confirmation_draft: {
          booking_code: 'WH-ROOM-PROBE',
          guest_name: 'Test',
          payment_status: 'deposit_paid',
          amount_paid_cents: 20000,
          balance_due_cents: 80000,
          room_number: draftRoom,
          gate_code: '1234',
          address: 'Test address',
          check_in: '2026-06-05',
          check_out: '2026-06-10',
          guest_count: 2,
          requested_room_type: 'shared',
        },
      },
    };
    return {
      async query(sql) {
        if (/FROM booking_beds bb/.test(sql)) {
          return { rows: (bedRooms || []).map((room_code) => ({ room_code })) };
        }
        if (/FROM payments p/.test(sql)) return { rows: [] };
        if (/FROM bookings b/.test(sql)) return { rows: [row] };
        throw new Error(`room probe unexpected query: ${String(sql).slice(0, 80)}`);
      },
    };
  }
  async function roomProbe(draftRoom, primaryRoom, bedRooms) {
    return runGuestConfirmationPreviewDryRun({
      client_slug: 'wolfhouse-somo',
      booking_id: roomProbeId,
      payment_status: 'deposit_paid',
      language_hint: 'en',
    }, { pg: roomProbePg(draftRoom, primaryRoom, bedRooms) });
  }
  const staleRoom = await roomProbe('R1', 'R2', ['R2']);
  assert.equal(staleRoom.confirmation_preview_ready, true, JSON.stringify(staleRoom.block_reasons));
  assert.equal(staleRoom.room_label, 'R2', staleRoom.proposed_confirmation_message);
  assert.match(staleRoom.proposed_confirmation_message, /🛏️ \*Room:\* A bed in our mixed shared room/);
  assert.doesNotMatch(staleRoom.proposed_confirmation_message, /\bR[12]\b/);
  const multiRoom = await roomProbe('R1', 'R2', ['R2', 'R4']);
  assert.equal(multiRoom.confirmation_preview_ready, true, JSON.stringify(multiRoom.block_reasons));
  assert.equal(multiRoom.room_label, 'R2, R4', multiRoom.proposed_confirmation_message);
  assert.match(multiRoom.proposed_confirmation_message, /🛏️ \*Room:\* A bed in our mixed shared room/);
  assert.doesNotMatch(multiRoom.proposed_confirmation_message, /\bR[124]\b/);
  const draftOnlyRoom = await roomProbe('R1', null, []);
  assert.equal(draftOnlyRoom.confirmation_preview_ready, true, JSON.stringify(draftOnlyRoom.block_reasons));
  assert.equal(draftOnlyRoom.room_label, 'R1');
  assert.match(draftOnlyRoom.proposed_confirmation_message, /🛏️ \*Room:\* A bed in our mixed shared room/);
  assert.doesNotMatch(draftOnlyRoom.proposed_confirmation_message, /\bR1\b/);

  const fixture = buildFixturePg(copyInput, storedGermanDraft);
  const autoPg = {
    async query(sql, params) {
      const flat = String(sql).replace(/\s+/g, ' ');
      if (flat.includes('guest_phone_meta')) {
        return { rows: [{
          id: copyBooking,
          booking_code: copyCode,
          booking_status: 'confirmed',
          payment_status: 'paid',
          confirmation_sent_at: null,
          guest_phone_meta: '+34600000000',
          guest_phone_column: null,
          guest_name_meta: 'Greta',
          guest_name: 'Greta',
        }] };
      }
      if (flat.includes('LEFT JOIN LATERAL')) {
        return { rows: [{
          amount_paid_cents: 20000,
          payment_record_status: 'paid',
          booking_payment_status: 'paid',
        }] };
      }
      if (flat.includes('confirmation_send_claim')) return { rows: [{ id: copyBooking }] };
      if (/FROM bookings b/.test(sql) || /FROM booking_beds/.test(sql) || /FROM payments p/.test(sql)) {
        return fixture.query(sql, params);
      }
      const err = new Error('relation does not exist');
      err.code = '42P01';
      throw err;
    },
  };
  const automaticGerman = await tryAutoSendBookingConfirmation({
    booking_id: copyBooking,
    booking_code: copyCode,
    client_slug: 'wolfhouse-somo',
    to: '+34600000000',
  }, {
    pg: autoPg,
    env: {
      LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'true',
      LUNA_AUTO_SEND_ENABLED: 'false',
      WHATSAPP_DRY_RUN: 'true',
    },
  });
  assert.equal(automaticGerman.preview && automaticGerman.preview.confirmation_preview_ready, true, JSON.stringify(automaticGerman));
  assert.match(automaticGerman.preview.proposed_confirmation_message, /Zahlung erhalten/);
  assert.doesNotMatch(automaticGerman.preview.proposed_confirmation_message, /Payment received/);

  const { PGlite } = require('@electric-sql/pglite');
  const recoveryBook = '11111111-1111-4111-8111-111111111111';
  const recoveryClient = '22222222-2222-4222-8222-222222222222';
  const recoveryEnv = {
    LUNA_AUTO_SEND_ENABLED: 'true',
    LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'true',
    WHATSAPP_DRY_RUN: 'false',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'offline-fixture-not-a-token',
    WHATSAPP_PHONE_NUMBER_ID: 'offline-fixture',
  };
  const recoveryPreview = {
    confirmation_preview_ready: true,
    confirmation_send_allowed: false,
    proposed_confirmation_message: 'Payment received. Booking WH-TEST-001.',
    message_preview: 'Payment received. Booking WH-TEST-001.',
    booking_id: recoveryBook,
    booking_code: 'WH-TEST-001',
    payment_status: 'deposit_paid',
  };
  async function recoveryDb() {
    const db = new PGlite();
    await db.exec(`CREATE FUNCTION set_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TABLE clients(id uuid PRIMARY KEY, slug text);
      CREATE TABLE bookings(id uuid PRIMARY KEY, client_id uuid, booking_code text, status text, payment_status text, confirmation_sent_at timestamptz, metadata jsonb DEFAULT '{}', phone text, guest_name text, amount_paid_cents int);
      CREATE TABLE payments(id uuid PRIMARY KEY, booking_id uuid, client_id uuid, status text, amount_paid_cents int, paid_at timestamptz, created_at timestamptz);
      INSERT INTO clients VALUES('${recoveryClient}','wolfhouse-somo');
      INSERT INTO bookings VALUES('${recoveryBook}','${recoveryClient}','WH-TEST-001','confirmed','deposit_paid',NULL,'{"guest_phone":"+9990000001","guest_name":"Review Fixture"}',NULL,'Review Fixture',20000);
      INSERT INTO payments VALUES('33333333-3333-4333-8333-333333333333','${recoveryBook}','${recoveryClient}','paid',20000,NOW(),NOW());`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/013_guest_message_sends.sql'), 'utf8'));
    return db;
  }
  async function recoveryScenario(name) {
    const db = await recoveryDb();
    let calls = 0;
    let outage = false;
    const pg = {
      query: async (sql, params) => {
        if (outage) throw new Error('offline-injected-db-outage-after-provider-audit');
        if (name === 'audit-then-db-outage' && String(sql).includes('SET confirmation_sent_at = NOW()')) {
          outage = true;
          throw new Error('offline-injected-db-outage-after-provider-audit');
        }
        return db.query(sql, params);
      },
    };
    const fetch = async () => {
      calls += 1;
      if (name === 'definitive-rejection-then-retry' && calls === 1) {
        return { ok: false, status: 401, json: async () => ({ error: { message: 'offline definitive rejection' } }) };
      }
      if (name === 'accepted-without-provider-id') return { ok: true, status: 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OFFLINE.${calls}` }] }) };
    };
    const ctx = {
      pg,
      env: recoveryEnv,
      fetch,
      runGuestConfirmationPreviewDryRun: async () => recoveryPreview,
    };
    const input = (key) => ({
      booking_id: recoveryBook,
      booking_code: 'WH-TEST-001',
      client_slug: 'wolfhouse-somo',
      to: '+9990000001',
      idempotency_key: key,
    });
    if (name === 'concurrent-distinct-keys') {
      await Promise.all([
        tryAutoSendBookingConfirmation(input('race-a'), ctx),
        tryAutoSendBookingConfirmation(input('race-b'), ctx),
      ]);
      const sentAt = (await db.query('SELECT confirmation_sent_at FROM bookings')).rows[0].confirmation_sent_at;
      await db.close();
      return { calls, sentAt };
    }
    await tryAutoSendBookingConfirmation(input('event-a'), ctx);
    const second = await tryAutoSendBookingConfirmation(
      input(name === 'definitive-rejection-then-retry' ? 'event-b' : 'event-a'),
      { ...ctx, pg: db },
    );
    const sentAt = (await db.query('SELECT confirmation_sent_at FROM bookings')).rows[0].confirmation_sent_at;
    await db.close();
    return { calls, second, sentAt };
  }

  const rejected = await recoveryScenario('definitive-rejection-then-retry');
  assert.equal(rejected.calls, 2, 'known provider rejection must reach the provider again');
  assert.equal(rejected.second.confirmation_sent, true);
  assert.ok(rejected.sentAt);

  const repaired = await recoveryScenario('audit-then-db-outage');
  assert.equal(repaired.calls, 1, 'sent-audit repair must not send a second copy');
  assert.equal(repaired.second.confirmation_sent, true);
  assert.equal(repaired.second.send && repaired.second.send.send_status, 'idempotent_replay');
  assert.ok(repaired.sentAt);

  const uncertainHold = await recoveryScenario('accepted-without-provider-id');
  assert.equal(uncertainHold.calls, 1);
  assert.equal(uncertainHold.second.skip_reason, 'confirmation_claim_held');
  assert.equal(uncertainHold.sentAt, null);

  const overlap = await recoveryScenario('concurrent-distinct-keys');
  assert.equal(overlap.calls, 1);
  assert.ok(overlap.sentAt);

  const preserveDb = await recoveryDb();
  let quoteCalls = 0;
  let pendingCalls = 0;
  await preserveDb.query(
    `INSERT INTO guest_message_sends (
       client_slug, to_phone, idempotency_key, send_kind, message_text, status, blocked_reasons
     ) VALUES
       ('wolfhouse-somo', '+34600000000', 'quote-blocked', 'show_quote', 'Which dates?', 'blocked', '["luna_auto_send_not_enabled"]'::jsonb),
       ('wolfhouse-somo', '+34600000000', 'confirmation-pending', 'confirmation', 'Payment received.', 'pending', '[]'::jsonb)`,
  );
  const routeEnv = {
    LUNA_AUTO_SEND_ENABLED: 'true',
    WHATSAPP_DRY_RUN: 'false',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'offline-fixture-not-a-token',
    WHATSAPP_PHONE_NUMBER_ID: 'offline-fixture',
  };
  const quoteReplay = await evaluateGuestReplySendRouteWithPause({
    client_slug: 'wolfhouse-somo',
    to: '+34600000000',
    suggested_reply: 'Which dates?',
    send_kind: 'show_quote',
    idempotency_key: 'quote-blocked',
    send_eligibility: { send_allowed_later: true, requires_staff: false, auto_send_ready: true },
  }, {
    pg: preserveDb,
    env: routeEnv,
    fetch: async () => { quoteCalls += 1; return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.QUOTE' }] }) }; },
  });
  assert.equal(quoteReplay.result.idempotent_replay, true);
  assert.equal(quoteCalls, 0);
  const pendingReplay = await evaluateGuestReplySendRouteWithPause({
    client_slug: 'wolfhouse-somo',
    to: '+34600000000',
    suggested_reply: 'Payment received.',
    send_kind: 'confirmation',
    idempotency_key: 'confirmation-pending',
    send_eligibility: { send_allowed_later: true, requires_staff: false, auto_send_ready: true },
  }, {
    pg: preserveDb,
    env: routeEnv,
    fetch: async () => { pendingCalls += 1; return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.PENDING' }] }) }; },
  });
  assert.equal(pendingReplay.result.idempotent_replay, true);
  assert.equal(pendingCalls, 0);
  await preserveDb.close();

  const rowBalanceId = '44444444-4444-4444-8444-444444444444';
  function rowBalancePg(overrides) {
    const paymentStatus = overrides.payment_status;
    const amountPaid = overrides.amount_paid_cents;
    const total = overrides.total_amount_cents;
    const draft = overrides.draft;
    const row = {
      booking_id: rowBalanceId,
      booking_code: 'WH-ROW-BALANCE',
      payment_status: paymentStatus,
      confirmation_sent_at: null,
      primary_room_code: 'R2',
      amount_paid_cents: amountPaid,
      total_amount_cents: total,
      language: 'en',
      check_in: '2026-11-15',
      check_out: '2026-11-24',
      guest_count: 1,
      requested_room_type: 'shared',
      metadata: { confirmation_draft: draft },
    };
    return {
      async query(sql) {
        if (String(sql).includes('guest_phone_meta')) {
          return { rows: [{
            id: rowBalanceId,
            booking_code: 'WH-ROW-BALANCE',
            booking_status: 'confirmed',
            payment_status: paymentStatus,
            guest_phone_meta: '+346****0000',
          }] };
        }
        if (String(sql).includes('LEFT JOIN LATERAL')) {
          return { rows: [{
            amount_paid_cents: amountPaid,
            payment_record_status: 'paid',
            booking_payment_status: paymentStatus,
          }] };
        }
        if (String(sql).includes('confirmation_send_claim')) return { rows: [{ id: rowBalanceId }] };
        if (/FROM booking_beds bb/.test(sql)) return { rows: [{ room_code: 'R2' }] };
        if (/FROM payments p/.test(sql)) return { rows: [] };
        if (/FROM bookings b/.test(sql)) return { rows: [row] };
        const err = new Error('relation does not exist');
        err.code = '42P01';
        throw err;
      },
    };
  }
  async function automaticSendBoundary(overrides) {
    let captured = null;
    const automatic = await tryAutoSendBookingConfirmation({
      client_slug: 'wolfhouse-somo',
      booking_id: rowBalanceId,
      booking_code: 'WH-ROW-BALANCE',
      payment_status: overrides.payment_status,
      to: '+346****0000',
    }, {
      pg: rowBalancePg(overrides),
      env: { LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'true' },
      sendLunaBookingConfirmation: async (_, ctx) => {
        captured = (await ctx.getLunaBookingConfirmationPreview()).message_preview;
        return { result: { dry_run: true, blocked_reasons: ['whatsapp_dry_run_active'] } };
      },
    });
    assert.equal(automatic.preview && automatic.preview.confirmation_preview_ready, true, JSON.stringify(automatic));
    assert.equal(captured, automatic.preview.proposed_confirmation_message);
    return captured;
  }
  const rowOnlyDeposit = await automaticSendBoundary({
    payment_status: 'deposit_paid',
    amount_paid_cents: 20000,
    total_amount_cents: 45000,
    draft: {
      booking_code: 'WH-ROW-BALANCE',
      payment_status: 'deposit_paid',
      room_number: 'R2',
      gate_code: '2684#',
    },
  });
  assert.match(rowOnlyDeposit, /💶 \*Paid today:\* €200/);
  assert.match(rowOnlyDeposit, /💳 \*Total:\* €450/);
  assert.match(rowOnlyDeposit, /⏳ \*Still to pay:\* €250/);
  const paidInFullBoundary = await automaticSendBoundary({
    payment_status: 'paid',
    amount_paid_cents: 45000,
    total_amount_cents: 45000,
    draft: {
      booking_code: 'WH-ROW-BALANCE',
      payment_status: 'paid',
      room_number: 'R2',
      gate_code: '2684#',
    },
  });
  assert.match(paidInFullBoundary, /💶 \*Paid:\* €450/);
  assert.match(paidInFullBoundary, /💳 \*Total:\* €450/);
  assert.match(paidInFullBoundary, /✅ \*Fully paid\*, nothing left to pay/);
  assert.doesNotMatch(paidInFullBoundary, /Deposit received|€250|left for when you arrive/);
  const explicitDraftBoundary = await automaticSendBoundary({
    payment_status: 'deposit_paid',
    amount_paid_cents: 20000,
    total_amount_cents: 45000,
    draft: {
      booking_code: 'WH-ROW-BALANCE',
      payment_status: 'deposit_paid',
      amount_paid_cents: 20000,
      balance_due_cents: 80000,
      room_number: 'R2',
      gate_code: '2684#',
    },
  });
  assert.match(explicitDraftBoundary, /💶 \*Paid today:\* €200/);
  assert.match(explicitDraftBoundary, /💳 \*Total:\* €1000/);
  assert.match(explicitDraftBoundary, /⏳ \*Still to pay:\* €800/);
  assert.doesNotMatch(explicitDraftBoundary, /€250/);

  const timeoutDb = await recoveryDb();
  let timeoutCalls = 0;
  const timeoutCtx = {
    pg: timeoutDb,
    env: recoveryEnv,
    fetch: async () => {
      timeoutCalls += 1;
      throw Object.assign(new Error('offline provider timeout'), { name: 'AbortError' });
    },
    runGuestConfirmationPreviewDryRun: async () => recoveryPreview,
  };
  const timeoutInput = (key) => ({
    booking_id: recoveryBook,
    booking_code: 'WH-TEST-001',
    client_slug: 'wolfhouse-somo',
    to: '+999****0001',
    idempotency_key: key,
  });
  await tryAutoSendBookingConfirmation(timeoutInput('event-one'), timeoutCtx);
  const timeoutRetry = await tryAutoSendBookingConfirmation(timeoutInput('brand-new-event-key'), timeoutCtx);
  const timeoutRow = (await timeoutDb.query('SELECT status, provider_message_id FROM guest_message_sends')).rows[0];
  const timeoutState = (await timeoutDb.query('SELECT confirmation_sent_at FROM bookings')).rows[0];
  assert.equal(timeoutCalls, 1, 'a timeout must not authorize a second provider call');
  assert.equal(timeoutRow.status, 'pending');
  assert.equal(timeoutRow.provider_message_id, null);
  assert.equal(timeoutState.confirmation_sent_at, null);
  assert.equal(timeoutRetry.confirmation_sent, false);
  await timeoutDb.close();

  const overlapDb = await recoveryDb();
  await overlapDb.query(
    `INSERT INTO guest_message_sends(
       client_slug, to_phone, idempotency_key, send_kind, message_text, status, blocked_reasons
     ) VALUES ($1, $2, $3, 'confirmation', 'Payment received.', 'blocked', '["whatsapp_provider_send_failed"]'::jsonb)`,
    ['wolfhouse-somo', '+999****0001', 'retry-key'],
  );
  let overlapCalls = 0;
  let releaseBlocker;
  let releaseProvider;
  const blockerAtPause = new Promise((resolve) => { releaseBlocker = resolve; });
  const providerStarted = new Promise((resolve) => { releaseProvider = resolve; });
  let finishProvider;
  const providerHold = new Promise((resolve) => { finishProvider = resolve; });
  const overlapEnv = {
    LUNA_AUTO_SEND_ENABLED: 'true',
    WHATSAPP_DRY_RUN: 'false',
    WHATSAPP_CLOUD_ACCESS_TOKEN: 'offline-fixture-not-a-token',
    WHATSAPP_PHONE_NUMBER_ID: 'offline-fixture',
  };
  const overlapBody = {
    client_slug: 'wolfhouse-somo',
    to: '+999****0001',
    send_kind: 'confirmation',
    idempotency_key: 'retry-key',
    suggested_reply: 'Payment received.',
    send_eligibility: { auto_send_ready: true },
  };
  const gatedPg = {
    query: async (sql, params) => {
      if (String(sql).includes('FROM bot_pause_states')) {
        releaseBlocker();
        await providerStarted;
        return { rows: [] };
      }
      return overlapDb.query(sql, params);
    },
  };
  const overlapFetch = async () => {
    const n = ++overlapCalls;
    if (n === 1) {
      releaseProvider();
      await providerHold;
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.overlap.${n}` }] }) };
  };
  const blockedRequest = evaluateGuestReplySendRouteWithPause({
    ...overlapBody,
    send_eligibility: { requires_staff: true },
  }, { pg: gatedPg, env: overlapEnv, fetch: overlapFetch });
  await blockerAtPause;
  const sendingRequest = evaluateGuestReplySendRouteWithPause(overlapBody, {
    pg: overlapDb,
    env: overlapEnv,
    fetch: overlapFetch,
  });
  await providerStarted;
  await blockedRequest;
  const afterBlock = (await overlapDb.query('SELECT status, provider_message_id FROM guest_message_sends')).rows[0];
  assert.equal(afterBlock.status, 'pending', 'gate audit must not overwrite an in-flight confirmation');
  assert.equal(afterBlock.provider_message_id, null);
  const third = await evaluateGuestReplySendRouteWithPause(overlapBody, {
    pg: overlapDb,
    env: overlapEnv,
    fetch: overlapFetch,
  });
  finishProvider();
  const overlapFirst = await sendingRequest;
  assert.equal(overlapCalls, 1, 'one idempotency key must make one provider call');
  assert.equal(third.result.idempotent_replay, true);
  assert.equal(third.result.send_performed, false);
  assert.equal(overlapFirst.result.whatsapp_message_id, 'wamid.overlap.1');
  const overlapAudit = (await overlapDb.query('SELECT status, provider_message_id FROM guest_message_sends')).rows[0];
  assert.equal(overlapAudit.status, 'sent');
  assert.equal(overlapAudit.provider_message_id, 'wamid.overlap.1');
  await overlapDb.close();

  console.log('verify-wolfhouse-paid-confirmation: PASS');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
