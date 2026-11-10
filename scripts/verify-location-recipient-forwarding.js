'use strict';

// LOCATION-ONCE-001: recipient plumbing only; preview policy is tested separately.
// All database and delivery boundaries are fixtures. No network or live sends.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendLunaBookingConfirmation } = require('./lib/luna-booking-confirmation-send');
const { tryAutoSendBookingConfirmation } = require('./lib/luna-guest-confirmation-auto-send');

const BOOKING = '11111111-1111-4111-8111-111111111111';
const CODE = 'WH-LOCATION-FIXTURE';
const OVERRIDE = '+34600000002';
const MESSAGE = 'Fixture confirmation';
const ENV = { LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'true' };
const forbidden = async () => assert.fail('Unexpected database or transport call');

function blockedTransport(calls) {
  return async (body) => {
    calls.push(body);
    return {
      status: 200,
      result: {
        success: false,
        send_performed: false,
        sends_whatsapp: false,
        blocked_reasons: ['whatsapp_dry_run_active'],
      },
    };
  };
}

test('manual confirmation forwards its trimmed recipient override to preview', async () => {
  const previews = [];
  const sends = [];
  const output = await sendLunaBookingConfirmation({
    client_slug: 'wolfhouse-somo', booking_id: BOOKING, booking_code: CODE,
    to: ` ${OVERRIDE} `, confirm_send: true, idempotency_key: 'location:manual',
  }, {
    pg: { query: forbidden }, env: ENV, sendMessage: forbidden, fetch: forbidden,
    getLunaBookingConfirmationPreview: async (input) => {
      previews.push(input);
      return { success: true, booking_id: BOOKING, message_preview: MESSAGE };
    },
    evaluateGuestReplySendRouteWithPause: blockedTransport(sends),
  });
  assert.equal(previews.length, 1);
  assert.equal(previews[0].to, OVERRIDE);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, previews[0].to);
  assert.equal(sends[0].suggested_reply, MESSAGE);
  assert.equal(sends[0].idempotency_key, 'location:manual');
  assert.equal(output.result.send_performed, false);
  assert.equal(output.result.updates_confirmation_sent_at, false);
});

function autoFixturePg({ metadataPhone = '+346****0001', simulator = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('guest_phone_meta')) return { rows: [{
        id: BOOKING, booking_code: CODE, booking_status: 'confirmed',
        payment_status: 'paid', confirmation_sent_at: null,
        guest_phone_meta: metadataPhone, guest_phone_column: '+346****0003',
      }] };
      if (sql.includes('AS booking_payment_status')) return { rows: [{
        booking_payment_status: 'paid', amount_paid_cents: 10000, payment_record_status: 'paid',
      }] };
      if (sql.includes("conv.metadata->>'simulator_synthetic'")) return { rows: simulator ? [{
        conversation_id: 'fixture-conversation', phone: metadataPhone,
      }] : [] };
      if (sql.includes("'confirmation_send_claim_state', 'in_flight'")) return { rows: [{ id: BOOKING }] };
      if (sql.includes("'confirmation_send_claim_state', 'released'")) return { rows: [] };
      assert.fail(`Unexpected fixture SQL: ${sql}`);
    },
  };
}

test('auto confirmation forwards its resolved override to preview and keeps the same send target', async () => {
  const previews = [];
  const sends = [];
  const output = await tryAutoSendBookingConfirmation({
    client_slug: 'wolfhouse-somo', booking_id: BOOKING, to: ` ${OVERRIDE} `,
  }, {
    pg: autoFixturePg(), env: ENV, sendMessage: forbidden, fetch: forbidden,
    runGuestConfirmationPreviewDryRun: async (input) => {
      previews.push(input);
      return {
        confirmation_preview_ready: true, booking_id: BOOKING, booking_code: CODE,
        proposed_confirmation_message: MESSAGE, message_preview: MESSAGE,
      };
    },
    evaluateGuestReplySendRouteWithPause: blockedTransport(sends),
  });
  assert.equal(previews.length, 1);
  assert.equal(previews[0].to, OVERRIDE);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, previews[0].to);
  assert.equal(sends[0].suggested_reply, MESSAGE);
  assert.equal(sends[0].idempotency_key, `confirmation:auto:${CODE}:${BOOKING}`);
  assert.equal(output.confirmation_sent, false);
  assert.equal(output.send.send_status, 'blocked_dry_run');
});

for (const fixture of [
  { name: 'metadata phone fallback', metadataPhone: '+346****0001', to: ' ', expected: '+346****0001' },
  { name: 'column phone fallback', metadataPhone: '', expected: '+346****0003' },
  { name: 'trusted simulator overrides caller', metadataPhone: '+346****0001', to: OVERRIDE,
    expected: '+346****0001', simulator: true },
]) {
  test(`auto preview preserves recipient policy: ${fixture.name}`, async () => {
    const previews = [];
    const output = await tryAutoSendBookingConfirmation({
      client_slug: fixture.simulator ? 'sunset' : 'wolfhouse-somo', booking_id: BOOKING, to: fixture.to,
    }, {
      pg: autoFixturePg(fixture),
      env: fixture.simulator ? {
        ...ENV, NODE_ENV: 'staging', DEFAULT_CLIENT_SLUG: 'sunset', LUNA_DEPLOYMENT: 'sunset-staging',
      } : ENV,
      sendMessage: forbidden, fetch: forbidden,
      evaluateGuestReplySendRouteWithPause: forbidden,
      mirrorHermesWhatsAppThreadMessage: forbidden,
      runGuestConfirmationPreviewDryRun: async (input) => {
        previews.push(input);
        return { confirmation_preview_ready: false };
      },
    });
    assert.equal(previews.length, 1);
    assert.equal(previews[0].to, fixture.expected);
    assert.equal(output.skip_reason, 'preview_not_ready');
    assert.equal(output.confirmation_sent, false);
  });
}
