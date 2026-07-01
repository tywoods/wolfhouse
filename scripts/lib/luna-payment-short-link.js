'use strict';

/**
 * Stage 37c — Guest-facing short payment link helpers.
 *
 * Short URL is redirect-only; Stripe checkout session remains payment truth.
 * No session creation, no payment mutation, no webhook changes.
 */

const fs = require('fs');
const path = require('path');
const { parseGuestPaymentShortLinkToken } = require('./booking-guests');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CLIENT = 'wolfhouse-somo';

const BOOKING_CODE_RE = /^(?:WH-[A-Z0-9]+(?:-[A-Z0-9-]+)?|MB-[A-Z0-9]+-\d{8}-[A-Z0-9]+|(?:SUNSET|ELSARDI)(?:-MAN)?-\d{8}-[A-Z0-9]+)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIVE_LINK_STATUSES = new Set(['checkout_created', 'draft', 'pending']);
const CANCELLED_LINK_STATUSES = new Set(['cancelled', 'canceled', 'expired', 'failed']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function messagingConfigPath(clientSlug) {
  return path.join(ROOT, 'config', 'clients', `${clientSlug || DEFAULT_CLIENT}.messaging.json`);
}

function loadClientMessagingConfig(clientSlug) {
  const slug = trimStr(clientSlug) || DEFAULT_CLIENT;
  const filePath = messagingConfigPath(slug);
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function normalizePublicBaseUrl(raw) {
  const v = trimStr(raw);
  if (!v) return null;
  try {
    const u = new URL(v.includes('://') ? v : `https://${v}`);
    return u.origin.replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

/**
 * Resolve public base URL for /pay/{booking_code} links.
 * Prefers explicit override, then env, then client messaging config.
 */
function resolvePublicPaymentBaseUrl(opts) {
  const o = opts || {};
  const env = readEnv(o.env);
  const fromOverride = normalizePublicBaseUrl(o.base_url);
  if (fromOverride) return fromOverride;

  for (const key of [
    'PUBLIC_PAYMENT_BASE_URL',
    'PUBLIC_GUEST_BASE_URL',
    'STAFF_PUBLIC_BASE_URL',
    'STRIPE_CHECKOUT_PUBLIC_BASE_URL',
  ]) {
    const origin = normalizePublicBaseUrl(env[key]);
    if (origin) return origin;
  }

  const messaging = loadClientMessagingConfig(o.client_slug);
  const cfg = messaging && messaging.public_urls;
  if (cfg) {
    const fromCfg = normalizePublicBaseUrl(cfg.public_payment_base_url || cfg.public_guest_base_url);
    if (fromCfg) return fromCfg;
  }

  return null;
}

function normalizeBookingCodeToken(token) {
  return trimStr(token).toUpperCase();
}

function isValidPaymentShortLinkBookingCode(code) {
  const c = normalizeBookingCodeToken(code);
  if (!c || c.length > 64) return false;
  if (UUID_RE.test(c)) return false;
  return BOOKING_CODE_RE.test(c);
}

/**
 * @returns {{ ok: boolean, booking_code?: string, reason?: string }}
 */
function parsePaymentShortLinkToken(token) {
  const guestParsed = parseGuestPaymentShortLinkToken(token);
  if (guestParsed.ok) {
    const bookingCode = normalizeBookingCodeToken(guestParsed.booking_code);
    if (!isValidPaymentShortLinkBookingCode(bookingCode)) {
      return { ok: false, reason: 'invalid_booking_code_token' };
    }
    return {
      ok: true,
      booking_code: bookingCode,
      guest_number: guestParsed.guest_number,
    };
  }
  const bookingCode = normalizeBookingCodeToken(token);
  if (!bookingCode) return { ok: false, reason: 'missing_token' };
  if (!isValidPaymentShortLinkBookingCode(bookingCode)) {
    return { ok: false, reason: 'invalid_booking_code_token' };
  }
  return { ok: true, booking_code: bookingCode };
}

function buildPaymentShortLink(input) {
  const src = input || {};
  const guestParsed = parseGuestPaymentShortLinkToken(src.booking_code || src.token || '');
  let bookingCode;
  let guestNumber = src.guest_number != null ? parseInt(src.guest_number, 10) : null;
  if (guestParsed.ok) {
    bookingCode = normalizeBookingCodeToken(guestParsed.booking_code);
    if (guestNumber == null) guestNumber = guestParsed.guest_number;
  } else {
    bookingCode = normalizeBookingCodeToken(src.booking_code);
  }
  if (!isValidPaymentShortLinkBookingCode(bookingCode)) return null;
  const base = resolvePublicPaymentBaseUrl({
    client_slug: src.client_slug,
    base_url: src.base_url,
    env: src.env,
  });
  if (!base) return null;
  if (guestNumber != null && Number.isInteger(guestNumber) && guestNumber > 0) {
    return `${base}/pay/${encodeURIComponent(bookingCode)}/g${guestNumber}`;
  }
  return `${base}/pay/${encodeURIComponent(bookingCode)}`;
}

function isStripeCheckoutUrlLive(checkoutUrl) {
  const url = trimStr(checkoutUrl);
  if (!url) return false;
  return /cs_live_/i.test(url) || /\/live\//i.test(url);
}

function isPublicPaymentRedirectSafe(env, checkoutUrl) {
  const e = readEnv(env);
  const url = trimStr(checkoutUrl);
  if (!url) return false;
  if (!isStripeCheckoutUrlLive(url)) return true;
  if (e.ALLOW_LIVE_PAYMENT_REDIRECT === 'true') return true;
  const key = trimStr(e.STRIPE_SECRET_KEY);
  if (key.startsWith('sk_live_') && e.ALLOW_LIVE_PAYMENT_REDIRECT === 'true') return true;
  return false;
}

function paymentRowHasCheckoutUrl(row) {
  if (!row) return false;
  if (row.checkout_url) return true;
  let md = row.metadata;
  if (typeof md === 'string') {
    try { md = JSON.parse(md); } catch (_) { md = {}; }
  }
  return !!(md && (md.payment_link_url || md.checkout_url));
}

function paymentRowCheckoutUrl(row) {
  if (!row) return null;
  if (row.checkout_url) return trimStr(row.checkout_url);
  let md = row.metadata;
  if (typeof md === 'string') {
    try { md = JSON.parse(md); } catch (_) { md = {}; }
  }
  return trimStr(md && (md.payment_link_url || md.checkout_url)) || null;
}

function paymentRowIsCancelled(status) {
  return CANCELLED_LINK_STATUSES.has(String(status || '').toLowerCase());
}

function paymentRowIsPaid(row) {
  const st = String(row && row.payment_status || '').toLowerCase();
  if (st === 'paid') return true;
  return Number(row && row.amount_paid_cents || 0) > 0;
}

function paymentRowIsExpired(row, now) {
  if (!row || !row.expires_at) return false;
  const exp = new Date(row.expires_at);
  if (Number.isNaN(exp.getTime())) return false;
  return exp.getTime() <= (now || Date.now());
}

function findLatestActiveCheckoutPayment(paymentRows, now, opts) {
  const guestNumber = opts && opts.guest_number != null ? parseInt(opts.guest_number, 10) : null;
  for (const row of paymentRows || []) {
    if (guestNumber != null && Number.isInteger(guestNumber)) {
      let md = row.metadata;
      if (typeof md === 'string') {
        try { md = JSON.parse(md); } catch (_) { md = {}; }
      }
      const rowGuest = md && md.guest_number != null ? parseInt(md.guest_number, 10) : null;
      if (rowGuest != null && rowGuest !== guestNumber) continue;
      if (row.booking_guest_id && md && md.guest_number == null) {
        // payment row linked via FK — guest filter applied in SQL when available
      }
    }
    const st = String(row.payment_status || '').toLowerCase();
    if (paymentRowIsCancelled(st)) continue;
    if (paymentRowIsPaid(row)) continue;
    if (!ACTIVE_LINK_STATUSES.has(st)) continue;
    const checkoutUrl = paymentRowCheckoutUrl(row);
    if (!checkoutUrl) continue;
    if (paymentRowIsExpired(row, now)) continue;
    return { row, checkout_url: checkoutUrl };
  }
  return null;
}

function bookingLooksFullyPaid(bookingRow, paymentRows) {
  const bkStatus = String(bookingRow && bookingRow.payment_status || '').toLowerCase();
  if (bkStatus === 'paid') return true;

  const balanceDue = bookingRow && bookingRow.balance_due_cents != null
    ? Number(bookingRow.balance_due_cents)
    : null;
  if (balanceDue != null && balanceDue > 0) return false;

  const totalCents = bookingRow && bookingRow.total_amount_cents != null
    ? Number(bookingRow.total_amount_cents)
    : null;
  const bkPaid = bookingRow && bookingRow.amount_paid_cents != null
    ? Number(bookingRow.amount_paid_cents)
    : null;
  if (totalCents != null && bkPaid != null && bkPaid >= totalCents) return true;

  const hasPaidRow = (paymentRows || []).some((row) => paymentRowIsPaid(row));
  const hasActive = !!findLatestActiveCheckoutPayment(paymentRows);

  if (bkStatus === 'deposit_paid') {
    if (balanceDue === 0) return true;
    return hasPaidRow && !hasActive && balanceDue == null;
  }

  return hasPaidRow && !hasActive;
}

/**
 * Pure resolver for redirect route + tests.
 *
 * @returns {{
 *   status: 'redirect'|'paid'|'inactive'|'not_found'|'unsafe_live'|'invalid_token',
 *   redirect_url?: string,
 *   message: string,
 *   payment_id?: string,
 *   stripe_checkout_url_present?: boolean,
 *   stripe_session_id?: string|null,
 *   payment_short_url?: string|null,
 * }}
 */
function resolvePaymentShortLinkRedirect(input) {
  const src = input || {};
  const env = readEnv(src.env);
  const parsed = parsePaymentShortLinkToken(src.booking_code || src.token);
  if (!parsed.ok) {
    return {
      status: 'invalid_token',
      message: 'This payment link is not valid.',
    };
  }

  const bookingCode = parsed.booking_code;
  const guestNumber = parsed.guest_number != null ? parsed.guest_number : null;
  const bookingRow = src.booking_row || src.bookingRow || null;
  const paymentRows = src.payment_rows || src.paymentRows || [];

  if (!bookingRow) {
    return {
      status: 'not_found',
      message: 'This payment link is no longer active — please message Wolfhouse and we\'ll send a fresh one.',
      booking_code: bookingCode,
      guest_number: guestNumber,
    };
  }

  const active = findLatestActiveCheckoutPayment(paymentRows, null, { guest_number: guestNumber });
  if (active && active.checkout_url) {
    if (!isPublicPaymentRedirectSafe(env, active.checkout_url)) {
      return {
        status: 'unsafe_live',
        message: 'This payment link cannot be opened safely in this environment.',
        booking_code: bookingCode,
        stripe_checkout_url_present: true,
        stripe_session_id: active.row.stripe_checkout_session_id || null,
      };
    }
    return {
      status: 'redirect',
      redirect_url: active.checkout_url,
      message: 'Redirecting to secure checkout.',
      booking_code: bookingCode,
      payment_id: active.row.payment_id || null,
      stripe_checkout_url_present: true,
      stripe_session_id: active.row.stripe_checkout_session_id || null,
      payment_short_url: buildPaymentShortLink({
        booking_code: bookingCode,
        guest_number: guestNumber,
        client_slug: src.client_slug,
        env,
      }),
    };
  }

  if (bookingLooksFullyPaid(bookingRow, paymentRows)) {
    return {
      status: 'paid',
      message: 'This payment is already completed.',
      booking_code: bookingCode,
      stripe_checkout_url_present: paymentRows.some((r) => paymentRowHasCheckoutUrl(r)),
      stripe_session_id: (paymentRows.find((r) => r.stripe_checkout_session_id) || {}).stripe_checkout_session_id || null,
    };
  }

  return {
    status: 'inactive',
    message: 'This payment link is no longer active — please message Wolfhouse and we\'ll send a fresh one.',
    booking_code: bookingCode,
    stripe_checkout_url_present: paymentRows.some((r) => paymentRowHasCheckoutUrl(r)),
    stripe_session_id: (paymentRows.find((r) => r.stripe_checkout_session_id) || {}).stripe_checkout_session_id || null,
  };
}

/**
 * Guest-facing URL: short link when configured, else raw Stripe checkout URL.
 */
function resolveGuestPaymentLinkUrl(input) {
  const src = input || {};
  const stripeUrl = trimStr(src.stripe_checkout_url);
  const shortUrl = buildPaymentShortLink({
    booking_code: src.booking_code,
    client_slug: src.client_slug,
    base_url: src.base_url,
    env: src.env,
  });
  if (shortUrl) return shortUrl;
  return stripeUrl || null;
}

function buildPaymentLinkObservability(input) {
  const src = input || {};
  const stripeUrl = trimStr(src.stripe_checkout_url);
  const shortUrl = buildPaymentShortLink({
    booking_code: src.booking_code,
    client_slug: src.client_slug,
    base_url: src.base_url,
    env: src.env,
  });
  return {
    payment_short_url: shortUrl || null,
    stripe_checkout_url_present: !!stripeUrl,
    stripe_session_id: trimStr(src.stripe_checkout_session_id) || null,
    guest_payment_url: shortUrl || stripeUrl || null,
    uses_short_payment_link: !!shortUrl,
  };
}

const PAYMENT_SHORT_LINK_LOOKUP_SQL = `
SELECT
  b.id::text                    AS booking_id,
  b.booking_code,
  b.status::text                AS booking_status,
  b.payment_status::text        AS payment_status,
  b.total_amount_cents,
  b.amount_paid_cents,
  b.balance_due_cents
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND UPPER(b.booking_code) = UPPER($2)
LIMIT 1
`;

const PAYMENT_SHORT_LINK_PAYMENTS_SQL = `
SELECT
  p.id::text                    AS payment_id,
  p.status::text                AS payment_status,
  p.amount_due_cents,
  p.amount_paid_cents,
  p.checkout_url,
  p.stripe_checkout_session_id,
  p.expires_at,
  p.metadata,
  p.booking_guest_id::text      AS booking_guest_id,
  p.created_at
FROM payments p
INNER JOIN bookings b ON b.id = p.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND UPPER(b.booking_code) = UPPER($2)
ORDER BY p.created_at DESC
`;

async function resolvePaymentShortLinkRedirectFromDb(pg, input) {
  const src = input || {};
  const parsed = parsePaymentShortLinkToken(src.booking_code || src.token);
  if (!parsed.ok) {
    return resolvePaymentShortLinkRedirect({ booking_code: src.booking_code, env: src.env });
  }
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT;
  const [bookingRes, paymentRes] = await Promise.all([
    pg.query(PAYMENT_SHORT_LINK_LOOKUP_SQL, [clientSlug, parsed.booking_code]),
    pg.query(PAYMENT_SHORT_LINK_PAYMENTS_SQL, [clientSlug, parsed.booking_code]),
  ]);
  let paymentRows = paymentRes.rows || [];
  if (parsed.guest_number != null) {
    paymentRows = paymentRows.filter((row) => {
      let md = row.metadata;
      if (typeof md === 'string') {
        try { md = JSON.parse(md); } catch (_) { md = {}; }
      }
      const mdGuest = md && md.guest_number != null ? parseInt(md.guest_number, 10) : null;
      return mdGuest === parsed.guest_number;
    });
  }
  return resolvePaymentShortLinkRedirect({
    booking_code: parsed.booking_code,
    guest_number: parsed.guest_number,
    client_slug: clientSlug,
    booking_row: bookingRes.rows[0] || null,
    payment_rows: paymentRows,
    env: src.env,
  });
}

module.exports = {
  DEFAULT_CLIENT,
  BOOKING_CODE_RE,
  buildPaymentShortLink,
  parsePaymentShortLinkToken,
  normalizeBookingCodeToken,
  isValidPaymentShortLinkBookingCode,
  resolvePublicPaymentBaseUrl,
  resolveGuestPaymentLinkUrl,
  resolvePaymentShortLinkRedirect,
  resolvePaymentShortLinkRedirectFromDb,
  buildPaymentLinkObservability,
  findLatestActiveCheckoutPayment,
  isPublicPaymentRedirectSafe,
  isStripeCheckoutUrlLive,
  loadClientMessagingConfig,
  PAYMENT_SHORT_LINK_LOOKUP_SQL,
  PAYMENT_SHORT_LINK_PAYMENTS_SQL,
};
