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

function envStr(env, key) {
  return String((env && env[key]) || '').trim();
}

/**
 * Staff-process tenant. Prefer trusted ingress slug; DEFAULT_CLIENT_SLUG is
 * the same fallback Staff API uses. Never inferred from the guest request.
 */
function staffTenantSlug(env = process.env) {
  const ingress = envStr(env, 'STAFF_API_INGRESS_TENANT_SLUG');
  if (ingress) return ingress;
  return envStr(env, 'DEFAULT_CLIENT_SLUG');
}

function hermesBaseUrl(env = process.env) {
  return String(
    envStr(env, 'WOLFHOUSE_HERMES_BASE_URL')
    || 'https://lunabox.lunafrontdesk.com',
  ).trim().replace(/\/$/, '');
}

function hermesFreshStartUrl(env = process.env) {
  const explicit = envStr(env, 'WOLFHOUSE_HERMES_GUEST_FRESH_START_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  return `${hermesBaseUrl(env)}/wolfhouse/guest-fresh-start`;
}

/**
 * Inbox Clear session-key route.
 *
 * Wolfhouse defaults to Lunabox `/wolfhouse/guest-session-key-reset`
 * (Caddy `/wolfhouse/*` → hermes-luna:8090).
 * Sunset Staff has no WOLFHOUSE_HERMES_* URL env; that Wolfhouse default is
 * the wrong tenant and live Confirm returns http_404. Sunset default/explicit
 * tenant routing uses `/whatsapp/guest-session-key-reset` so Caddy
 * `/whatsapp/*` reaches hermes-sunset-luna:8092. Explicit URL still wins.
 */
function hermesSessionKeyResetUrl(env = process.env) {
  const explicit = envStr(env, 'WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL');
  if (explicit) return explicit.replace(/\/$/, '');
  if (staffTenantSlug(env) === 'sunset') {
    return `${hermesBaseUrl(env)}/whatsapp/guest-session-key-reset`;
  }
  return `${hermesBaseUrl(env)}/wolfhouse/guest-session-key-reset`;
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

/**
 * Inbox Clear — reset only the live Hermes session_key for this guest.
 * Distinct Hermes route (never guest-fresh-start / hard_delete). That path
 * wipes shared USER.md/MEMORY.md and every state.db session for the phone.
 */
async function resetHermesConversationSession(guestPhone, opts = {}) {
  const phone = normalizeGuestPhone(guestPhone);
  if (!phone) {
    return { attempted: false, ok: false, reason: 'invalid_phone' };
  }

  const env = opts.env || process.env;
  const url = hermesSessionKeyResetUrl(env);
  if (!url) {
    return {
      attempted: false,
      ok: false,
      hard_delete: false,
      scope: 'session_key',
      reason: 'missing_session_key_url',
    };
  }

  const token = String(env.LUNA_BOT_INTERNAL_TOKEN || '').trim();
  if (!token) {
    return { attempted: false, ok: false, reason: 'missing_bot_token' };
  }

  const body = JSON.stringify({
    guest_phone: phone,
    conversation_id: opts.conversation_id || null,
  });
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
        scope: data.scope || 'session_key',
      };
    }
    return {
      attempted: true,
      ok: Boolean(data.ok),
      reset: Boolean(data.reset),
      hard_delete: false,
      scope: data.scope || 'session_key',
      reason: data.reason || null,
      session_key: data.session_key || null,
      old_session_id: data.old_session_id || null,
      deleted_session_ids: data.deleted_session_ids || [],
      deleted_count: data.deleted_count != null ? data.deleted_count : null,
      status: res.status,
    };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      reason: err && err.message ? err.message : 'request_failed',
      scope: 'session_key',
    };
  }
}

module.exports = {
  normalizeGuestPhone,
  staffTenantSlug,
  hermesFreshStartUrl,
  hermesSessionKeyResetUrl,
  resetHermesGuestSession,
  resetHermesConversationSession,
};
