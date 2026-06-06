'use strict';

/**
 * Phase 19g.11a — Staging-only Luna test phone reset (guest_message_events + guest_message_sends).
 */

const { isMissingGuestMessageEventsTable } = require('./luna-guest-message-events-sql');
const { isMissingGuestMessageSendsTable } = require('./luna-guest-message-send-sql');

const ALLOWED_RESET_CLIENT = 'wolfhouse-somo';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeResetPhone(phone) {
  return trimStr(phone).replace(/[\s+\-()]/g, '');
}

/**
 * Staging/test guard — default deny (403 in production/unknown env).
 */
function isStagingResetEnvironment(env = process.env, hostHeader = '') {
  const nodeEnv = trimStr(env.NODE_ENV).toLowerCase();
  if (nodeEnv === 'production') return false;

  if (nodeEnv === 'staging' || nodeEnv === 'test' || nodeEnv === 'development') {
    return true;
  }

  const host = trimStr(hostHeader).toLowerCase();
  if (host.includes('staging')) return true;
  if (host.includes('localhost') || host.startsWith('127.0.0.1')) return true;

  return false;
}

function parseResetLunaPhoneInput(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug);
  const phone = normalizeResetPhone(src.phone);

  if (!clientSlug) return { ok: false, error: 'client_slug required' };
  if (!phone) return { ok: false, error: 'phone required' };
  if (!/^\d{6,20}$/.test(phone)) return { ok: false, error: 'phone must contain 6-20 digits' };
  if (clientSlug !== ALLOWED_RESET_CLIENT) {
    return { ok: false, error: 'client_slug not allowed for test reset', status: 403 };
  }

  return {
    ok: true,
    input: {
      client_slug: clientSlug,
      phone,
      phone_like: `%${phone}%`,
    },
  };
}

async function resetLunaPhoneTestRows(pg, input) {
  const clientSlug = input.client_slug;
  const phoneLike = input.phone_like;
  let guestMessageEvents = 0;
  let guestMessageSends = 0;

  try {
    const ev = await pg.query(
      `DELETE FROM guest_message_events
        WHERE client_slug = $1
          AND REPLACE(COALESCE(from_phone, ''), '+', '') LIKE $2
        RETURNING id`,
      [clientSlug, phoneLike],
    );
    guestMessageEvents = ev.rowCount || 0;
  } catch (err) {
    if (!isMissingGuestMessageEventsTable(err)) throw err;
  }

  try {
    const se = await pg.query(
      `DELETE FROM guest_message_sends
        WHERE client_slug = $1
          AND REPLACE(COALESCE(to_phone, ''), '+', '') LIKE $2
        RETURNING id`,
      [clientSlug, phoneLike],
    );
    guestMessageSends = se.rowCount || 0;
  } catch (err) {
    if (!isMissingGuestMessageSendsTable(err)) throw err;
  }

  return {
    success: true,
    client_slug: clientSlug,
    phone: input.phone,
    deleted: {
      guest_message_events: guestMessageEvents,
      guest_message_sends: guestMessageSends,
    },
  };
}

module.exports = {
  ALLOWED_RESET_CLIENT,
  normalizeResetPhone,
  isStagingResetEnvironment,
  parseResetLunaPhoneInput,
  resetLunaPhoneTestRows,
};
