/**
 * Reset Hermes gateway session memory for a WhatsApp guest (Fresh Start).
 *
 * @module luna-hermes-guest-session-reset
 */

'use strict';

function normalizeGuestPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return `+${digits}`;
}

function hermesFreshStartUrl() {
  const explicit = String(process.env.WOLFHOUSE_HERMES_GUEST_FRESH_START_URL || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const base = String(
    process.env.WOLFHOUSE_HERMES_BASE_URL
    || 'https://lunabox.lunafrontdesk.com',
  ).trim().replace(/\/$/, '');
  return `${base}/wolfhouse/guest-fresh-start`;
}

/**
 * Ask Hermes to reset the guest's WhatsApp session (same as operator /new).
 * @param {string} guestPhone - E.164 or digits
 * @returns {Promise<object>}
 */
async function resetHermesGuestSession(guestPhone, opts = {}) {
  const phone = normalizeGuestPhone(guestPhone);
  if (!phone) {
    return { attempted: false, ok: false, reason: 'invalid_phone' };
  }

  const token = String(process.env.LUNA_BOT_INTERNAL_TOKEN || '').trim();
  if (!token) {
    return { attempted: false, ok: false, reason: 'missing_bot_token' };
  }

  const hardDelete = opts.hard_delete !== false;
  const url = hermesFreshStartUrl();
  const body = JSON.stringify({ guest_phone: phone, hard_delete: hardDelete });
  const headers = {
    'Content-Type': 'application/json',
    'X-Luna-Bot-Token': token,
  };

  try {
    const res = await fetch(url, { method: 'POST', headers, body });
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }
    if (!res.ok) {
      return {
        attempted: true,
        ok: false,
        reason: data.reason || data.error || `http_${res.status}`,
        status: res.status,
        session_key: data.session_key || null,
        reset: data.reset || false,
      };
    }
    return {
      attempted: true,
      ok: Boolean(data.ok),
      reset: Boolean(data.reset),
      hard_delete: data.hard_delete !== false,
      reason: data.reason || null,
      session_key: data.session_key || null,
      old_session_id: data.old_session_id || null,
      new_session_id: data.new_session_id || null,
      deleted_session_ids: data.deleted_session_ids || [],
      deleted_count: data.deleted_count != null ? data.deleted_count : null,
      status: res.status,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      reason: err && err.message ? err.message : 'request_failed',
    };
  }
}

module.exports = {
  normalizeGuestPhone,
  hermesFreshStartUrl,
  resetHermesGuestSession,
};
