'use strict';

/**
 * Wolfhouse Admin Pricing — write gate and body validation.
 *
 * Deliberately separate from scripts/lib/tenant-admin-writes.js: that module is
 * Sunset's and hard-refuses any other slug. This one refuses anything that is
 * not Wolfhouse, so the two tenants can never write through each other's path.
 *
 * Money crosses the wire as integer cents. Euro strings from the browser are
 * parsed here, never trusted as-is, and never floated.
 *
 * @module wolfhouse-pricing-writes
 */

const { WH_PRICING_CLIENT_SLUG } = require('./wolfhouse-pricing-resolve');

const WRITE_ENV_FLAG = 'WOLFHOUSE_ADMIN_WRITES_ENABLED';
const WRITE_MIN_ROLE = 'admin';
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };

const ITEM_TYPES = new Set(['package', 'rental', 'service']);

const RULE_ITEM_TYPES = new Set([
  'package', 'rental', 'service', 'transfer', 'addon', 'supplement', 'deposit',
]);

/** Units each item type may legitimately be priced in. */
const UNITS_BY_ITEM_TYPE = Object.freeze({
  package: new Set(['per_person_per_week', 'per_person', 'per_stay']),
  rental: new Set(['per_day', 'per_stay', 'flat']),
  service: new Set(['per_day', 'per_lesson', 'per_class', 'per_meal', 'per_person', 'per_stay']),
  transfer: new Set(['flat', 'per_person']),
  addon: new Set(['per_day', 'per_person', 'per_stay', 'flat']),
  supplement: new Set(['per_room_per_night', 'per_person_per_night']),
  deposit: new Set(['per_booking', 'per_person']),
});

const MAX_AMOUNT_CENTS = 100000000;
const CODE_RE = /^[a-z0-9][a-z0-9_]{0,62}[a-z0-9]$/;
const AIRPORT_CODE_RE = /^[A-Z]{3}$/;

function isWolfhousePricingWritesEnabled(env) {
  const raw = (env || process.env)[WRITE_ENV_FLAG];
  if (raw == null || String(raw).trim() === '') return false;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function hasMinRole(role, minRole) {
  return (ROLE_RANK[String(role || '').toLowerCase()] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * Fail-closed gate for every Wolfhouse pricing write.
 * Order matters: the disabled flag is checked before the slug so a misrouted
 * Sunset request never learns whether the Wolfhouse surface exists.
 */
function evaluateWolfhousePricingWriteGate(ctx) {
  const context = ctx || {};
  if (!isWolfhousePricingWritesEnabled(context.env)) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'writes_disabled', message: 'Wolfhouse Admin pricing writes disabled' },
    };
  }
  const clientSlug = String(context.clientSlug || '').trim();
  if (clientSlug !== WH_PRICING_CLIENT_SLUG) {
    return {
      ok: false,
      status: 403,
      body: { success: false, error: 'unsupported_client', client_slug: clientSlug },
    };
  }
  if (context.staffAuthRequired !== false) {
    if (!context.user) {
      return {
        ok: false,
        status: 401,
        body: {
          success: false,
          error: 'Authentication required. POST /staff/auth/login first.',
          auth_url: '/staff/auth/login',
        },
      };
    }
    const resolveRole = context.resolveStaffRole || ((u) => String(u.role || '').toLowerCase());
    const role = resolveRole(context.user);
    if (!hasMinRole(role, WRITE_MIN_ROLE)) {
      return {
        ok: false,
        status: 403,
        body: {
          success: false,
          error: 'forbidden_role',
          message: 'Owner or admin role required for Wolfhouse Admin pricing writes',
          current_role: role,
        },
      };
    }
  }
  return { ok: true };
}

/**
 * Parse a euro string into integer cents. Rejects negatives, more than two
 * decimals, and anything non-numeric after stripping a currency symbol.
 */
function parseEurosToCents(text) {
  if (text == null) return { ok: false, error: 'amount required' };
  let raw = String(text).trim();
  if (!raw) return { ok: false, error: 'amount required' };
  raw = raw.replace(/^[€$£]\s*/, '').replace(/\s/g, '');
  // Accept a comma decimal separator, but only when it is the sole separator.
  if (raw.includes(',') && !raw.includes('.')) raw = raw.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: 'amount must be a positive number with at most 2 decimals' };
  }
  const cents = Math.round(Number(raw) * 100);
  if (!Number.isSafeInteger(cents)) return { ok: false, error: 'amount out of range' };
  if (cents > MAX_AMOUNT_CENTS) return { ok: false, error: 'amount too large' };
  return { ok: true, value: cents };
}

function validateAmountCents(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, error: 'amount_cents must be an integer' };
  if (n < 0) return { ok: false, error: 'amount_cents must be >= 0' };
  if (n > MAX_AMOUNT_CENTS) return { ok: false, error: 'amount_cents too large' };
  return { ok: true, value: n };
}

/** Accept either amount_cents (canonical) or amount_eur (browser convenience). */
function resolveAmountCents(body) {
  if (body.amount_cents != null) return validateAmountCents(body.amount_cents);
  if (body.amount_eur != null) return parseEurosToCents(body.amount_eur);
  return { ok: false, error: 'amount_cents or amount_eur required' };
}

function validateCode(value, label) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text) return { ok: false, error: `${label} required` };
  if (!CODE_RE.test(text)) {
    return { ok: false, error: `${label} must be lowercase letters, digits and underscores` };
  }
  return { ok: true, value: text };
}

function validateLabel(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, error: `${label} required` };
  if (text.length > 120) return { ok: false, error: `${label} too long` };
  return { ok: true, value: text };
}

function validateMonthDay(month, day, label) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || m < 1 || m > 12) return { ok: false, error: `${label} month invalid` };
  if (!Number.isInteger(d) || d < 1 || d > 31) return { ok: false, error: `${label} day invalid` };
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > maxDay) return { ok: false, error: `${label} day invalid for month` };
  return { ok: true, month: m, day: d };
}

/**
 * Validate a season plus its recurring ranges.
 * At least one range is required: a season with none would silently match no
 * date and quietly stop pricing every package hung off it.
 */
function validateSeasonBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const code = validateCode(body.code, 'code');
  if (!code.ok) return code;
  const label = validateLabel(body.label, 'label');
  if (!label.ok) return label;

  const priority = body.priority == null ? 0 : Number(body.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    return { ok: false, error: 'priority must be an integer between 0 and 1000' };
  }

  const rawRanges = Array.isArray(body.ranges) ? body.ranges : [];
  if (!rawRanges.length) return { ok: false, error: 'at least one date range required' };
  if (rawRanges.length > 24) return { ok: false, error: 'too many ranges' };

  const ranges = [];
  const seen = new Set();
  for (const raw of rawRanges) {
    const start = validateMonthDay(raw && raw.start_month, raw && raw.start_day, 'range start');
    if (!start.ok) return start;
    const end = validateMonthDay(raw && raw.end_month, raw && raw.end_day, 'range end');
    if (!end.ok) return end;
    const key = `${start.month}-${start.day}-${end.month}-${end.day}`;
    if (seen.has(key)) return { ok: false, error: 'duplicate date range' };
    seen.add(key);
    ranges.push({
      start_month: start.month,
      start_day: start.day,
      end_month: end.month,
      end_day: end.day,
    });
  }

  return {
    ok: true,
    value: {
      code: code.value,
      label: label.value,
      priority,
      bookable: body.bookable !== false,
      ranges,
    },
  };
}

function validatePriceRuleBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const itemType = String(body.item_type || '').trim();
  if (!RULE_ITEM_TYPES.has(itemType)) return { ok: false, error: 'invalid item_type' };

  const itemCode = itemType === 'transfer'
    ? validateAirportCode(body.item_code)
    : validateCode(body.item_code, 'item_code');
  if (!itemCode.ok) return itemCode;

  const unit = String(body.unit || '').trim();
  const allowedUnits = UNITS_BY_ITEM_TYPE[itemType];
  if (!allowedUnits || !allowedUnits.has(unit)) {
    return { ok: false, error: `invalid unit for ${itemType}` };
  }

  const amount = resolveAmountCents(body);
  if (!amount.ok) return amount;

  const active = body.active !== false;
  // An active price of zero is almost always a half-finished edit, and a zero
  // that reaches a quote reads as "free" to a guest. Supplements are the honest
  // exception: a shared room genuinely costs nothing extra.
  if (active && amount.value === 0 && itemType !== 'supplement') {
    return { ok: false, error: 'active price must be greater than zero' };
  }

  let seasonCode = null;
  if (body.season_code != null && String(body.season_code).trim() !== '') {
    const parsed = validateCode(body.season_code, 'season_code');
    if (!parsed.ok) return parsed;
    seasonCode = parsed.value;
  }
  if (seasonCode && itemType !== 'package') {
    return { ok: false, error: 'only package prices can be season-scoped' };
  }

  return {
    ok: true,
    value: {
      item_type: itemType,
      item_code: itemCode.value,
      season_code: seasonCode,
      unit,
      amount_cents: amount.value,
      currency: String(body.currency || 'EUR').toUpperCase().slice(0, 3),
      active,
    },
  };
}

function validateItemBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const itemType = String(body.item_type || '').trim();
  if (!ITEM_TYPES.has(itemType)) return { ok: false, error: 'invalid item_type' };
  const itemCode = validateCode(body.item_code, 'item_code');
  if (!itemCode.ok) return itemCode;
  const label = validateLabel(body.label, 'label');
  if (!label.ok) return label;

  let metadata = {};
  if (body.metadata != null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      return { ok: false, error: 'metadata must be an object' };
    }
    metadata = body.metadata;
  }

  return {
    ok: true,
    value: {
      item_type: itemType,
      item_code: itemCode.value,
      label: label.value,
      description: body.description == null ? null : String(body.description).trim().slice(0, 500),
      metadata,
      active: body.active !== false,
    },
  };
}

function validateAirportCode(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  if (!AIRPORT_CODE_RE.test(text)) {
    return { ok: false, error: 'airport_code must be a 3-letter IATA code' };
  }
  return { ok: true, value: text };
}

function validateTransferRuleBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid body' };
  }
  const airport = validateAirportCode(body.airport_code);
  if (!airport.ok) return airport;
  const label = validateLabel(body.label, 'label');
  if (!label.ok) return label;

  let minGuestCount = null;
  if (body.min_guest_count != null && String(body.min_guest_count).trim() !== '') {
    const n = Number(body.min_guest_count);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return { ok: false, error: 'min_guest_count must be between 1 and 99' };
    }
    minGuestCount = n;
  }

  const requiresPackage = body.requires_package === true;
  // The guest sees this text when the transfer is refused, so an unexplained
  // refusal is a support ticket. Require the copy when the rule can fire.
  if (requiresPackage && !String(body.unavailable_no_package_message || '').trim()) {
    return { ok: false, error: 'unavailable_no_package_message required when requires_package is set' };
  }
  if (minGuestCount && !String(body.unavailable_below_min_group_message || '').trim()) {
    return { ok: false, error: 'unavailable_below_min_group_message required when min_guest_count is set' };
  }

  let aliases = [];
  if (body.aliases != null) {
    if (!Array.isArray(body.aliases)) return { ok: false, error: 'aliases must be an array' };
    aliases = body.aliases.map((a) => String(a || '').trim().toLowerCase()).filter(Boolean);
  }

  return {
    ok: true,
    value: {
      airport_code: airport.value,
      label: label.value,
      aliases,
      requires_package: requiresPackage,
      included_when_package: body.included_when_package === true,
      min_guest_count: minGuestCount,
      unavailable_no_package_message:
        String(body.unavailable_no_package_message || '').trim() || null,
      unavailable_below_min_group_message:
        String(body.unavailable_below_min_group_message || '').trim() || null,
      active: body.active !== false,
    },
  };
}

module.exports = {
  WRITE_ENV_FLAG,
  WRITE_MIN_ROLE,
  ITEM_TYPES,
  RULE_ITEM_TYPES,
  UNITS_BY_ITEM_TYPE,
  MAX_AMOUNT_CENTS,
  isWolfhousePricingWritesEnabled,
  evaluateWolfhousePricingWriteGate,
  parseEurosToCents,
  validateAmountCents,
  validateCode,
  validateMonthDay,
  validateSeasonBody,
  validatePriceRuleBody,
  validateItemBody,
  validateAirportCode,
  validateTransferRuleBody,
};
