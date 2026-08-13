/**
 * Staff Inbox helpers — production implementations used by the Inbox composite
 * and individual conversation routes. Extracted for verifier consumption.
 *
 * These are the authoritative implementations; the verifier must execute these
 * (not recreated equivalents) to prove production parity.
 *
 * @module staff-inbox-helpers
 */

'use strict';

const { formatPauseStateRow } = require('./staff-bot-pause-sql');

function isInactiveInboxBookingStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'cancelled' || s === 'canceled' || s === 'expired';
}

function filterActiveInboxBookings(rows) {
  return (rows || []).filter((b) => !isInactiveInboxBookingStatus(b.booking_status));
}

function sanitizeConversationContextForInbox(row) {
  if (!row || !isInactiveInboxBookingStatus(row.booking_status)) return row;
  return {
    ...row,
    booking_id: null,
    booking_code: null,
    booking_status: null,
    booking_payment_status: null,
    check_in: null,
    check_out: null,
    guest_count: null,
    package_code: null,
    assigned_room_code: null,
    assigned_bed_code: null,
  };
}

function buildDefaultActivePauseResponse(extra) {
  return Object.assign({
    success:           true,
    paused:            false,
    bot_paused:        false,
    live_send_blocked: false,
    source:            'default_active',
  }, extra || {});
}

function buildPausedStateResponse(pauseStateRow, extra) {
  const pauseState = formatPauseStateRow(pauseStateRow);
  return Object.assign({
    success:           true,
    paused:            true,
    bot_paused:        true,
    live_send_blocked: true,
    source:            'bot_pause_states',
    pause_state:       pauseState,
    client_slug:       pauseState ? pauseState.client_slug : undefined,
    guest_phone:       pauseState ? pauseState.guest_phone : undefined,
    conversation_id:   pauseState ? pauseState.conversation_id : undefined,
    booking_id:        pauseState ? pauseState.booking_id : undefined,
    booking_code:      pauseState ? pauseState.booking_code : undefined,
    pause_reason:      pauseState ? pauseState.pause_reason : undefined,
    paused_by:         pauseState ? pauseState.paused_by : undefined,
    paused_at:         pauseState ? pauseState.paused_at : undefined,
    resumed_by:        pauseState ? pauseState.resumed_by : undefined,
    resumed_at:        pauseState ? pauseState.resumed_at : undefined,
    updated_at:        pauseState ? pauseState.updated_at : undefined,
  }, extra || {});
}

module.exports = {
  isInactiveInboxBookingStatus,
  filterActiveInboxBookings,
  sanitizeConversationContextForInbox,
  buildDefaultActivePauseResponse,
  buildPausedStateResponse,
};
