'use strict';

const assert = require('assert/strict');
const { tryAutoSendBookingConfirmation } = require('./lib/luna-guest-confirmation-auto-send');

const BOOKING = 'a28191d0-bc68-4a34-9c0b-70b1742530e2';
const CODE = 'WH-20270703-11956801';
const CONVERSATION = '8e6aac58-0ccb-470c-bc9b-989a8d58b87d';
const PHONE = '+9990100714001';

(async () => {
  const providerCalls = [];
  const mirrors = [];
  const pg = {
    async query(sql, params = []) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (flat.includes('FROM bookings b INNER JOIN clients c') && flat.includes('confirmation_sent_at')) {
        return { rows: [{
          id: BOOKING, booking_code: CODE, booking_status: 'confirmed',
          payment_status: 'deposit_paid', confirmation_sent_at: null,
          guest_phone_meta: PHONE, guest_phone_column: PHONE, guest_name_meta: 'Lucia',
        }] };
      }
      if (flat.includes('LEFT JOIN LATERAL') && flat.includes('FROM payments')) {
        return { rows: [{ amount_paid_cents: 20000, payment_record_status: 'paid',
          booking_payment_status: 'deposit_paid' }] };
      }
      if (flat.includes("metadata->>'simulator_synthetic'")) {
        const candidates = Array.isArray(params[1]) ? params[1] : [];
        const row = {
          conversation_id: CONVERSATION, phone: PHONE,
          location_id: 'wolfhouse-somo', simulator_source_phone: PHONE,
        };
        return { rows: candidates.includes(PHONE) ? [row] : [] };
      }
      throw new Error(`unexpected SQL: ${flat}`);
    },
  };

  const out = await tryAutoSendBookingConfirmation({
    booking_id: BOOKING,
    booking_code: CODE,
    to: PHONE,
    client_slug: 'wolfhouse-somo',
  }, {
    pg,
    env: {
      NODE_ENV: 'staging',
      LUNA_DEPLOYMENT: 'staff-staging',
      DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
      LUNA_AUTO_SEND_ENABLED: 'false',
      LUNA_CONFIRMATION_AUTO_SEND_ENABLED: 'true',
      WHATSAPP_DRY_RUN: 'false',
    },
    runGuestConfirmationPreviewDryRun: async () => ({
      confirmation_preview_ready: true,
      message_preview: 'Pago recibido — reserva WH-20270703-11956801.',
    }),
    sendMessage: async () => {
      providerCalls.push('live');
      return { success: true, whatsapp_message_id: 'wamid.SHOULD_NOT' };
    },
    mirrorHermesWhatsAppThreadMessage: async (_pg, body) => {
      mirrors.push(body);
      return { ok: true, thread: { persisted: true, message_id: 'sim-1' } };
    },
    markBookingConfirmationSent: async () => ({
      updated: true, confirmation_sent_at: '2026-11-11T19:20:09Z',
    }),
  });

  assert.equal(out.confirmation_sent, true, JSON.stringify({
    skip: out.skip_reason, suppressed: out.whatsapp_suppressed,
  }));
  assert.equal(out.whatsapp_suppressed, true);
  assert.equal(providerCalls.length, 0, 'must not live-send WhatsApp for a Crows Nest Wolfhouse chat');
  assert.equal(mirrors.length, 1);
  assert.equal(mirrors[0].simulator_synthetic, true);
  assert.equal(mirrors[0].source_owner, 'crowsnest-guest-door');
  console.log('verify-wolfhouse-cn-deposit-received: PASS');
})().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
