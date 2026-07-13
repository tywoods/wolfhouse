'use strict';

/**
 * Read-only Sunset ordinary group-lesson quote (no booking/payment writes).
 * Reuses the same unit price resolver as post-create booking pricing.
 */

const { resolveTenantBusinessConfigAsync, resolveTenantBusinessConfig, SUNSET_ADMIN_CLIENT } = require('./tenant-business-config');
const {
  resolveSunsetGroupLessonUnitCents,
  computeSunsetGroupLessonQuoteTotalCents,
} = require('./sunset-stripe-payment-links');
const { parseIsoDateStrict } = require('./sunset-guest-date-intake');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

const SUNSET_CLIENT_SLUG = SUNSET_ADMIN_CLIENT;
const MAX_SERVICE_DATES = 31;

function parseQuoteQuantity(raw) {
  if (typeof raw === 'boolean') return null;
  if (typeof raw === 'number' && !Number.isInteger(raw)) return null;
  const n = parseInt(String(raw == null ? 1 : raw), 10);
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return n;
}

function validateGroupLessonQuoteBody(body, refDate) {
  const ref = refDate || new Date();
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.service_dates) || !b.service_dates.length) {
    return { ok: false, reason: 'service_dates_required' };
  }
  if (b.service_dates.length > MAX_SERVICE_DATES) {
    return { ok: false, reason: 'too_many_service_dates' };
  }
  const unique = [];
  for (const d of b.service_dates) {
    const parsed = parseIsoDateStrict(String(d || '').trim(), ref, {});
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason || 'invalid_date', detail: parsed };
    }
    if (unique.includes(parsed.iso)) {
      return { ok: false, reason: 'duplicate_service_dates' };
    }
    unique.push(parsed.iso);
  }
  unique.sort();
  const quantity = parseQuoteQuantity(b.quantity);
  if (quantity == null) {
    return { ok: false, reason: 'invalid_quantity' };
  }
  return { ok: true, service_dates: unique, quantity, date_count: unique.length };
}

function priceSourceLabel(adminCfg) {
  if (!adminCfg) return 'config_or_db';
  if (adminCfg.db_read_warning) return 'config_or_db';
  if (adminCfg.source === 'db' || adminCfg.source === 'merged') return 'config_or_db';
  return 'config_or_db';
}

function buildGroupLessonQuoteResult(locationId, validated, unitCents, adminCfg) {
  const totalCents = computeSunsetGroupLessonQuoteTotalCents(
    unitCents,
    validated.quantity,
    validated.date_count,
  );
  return {
    ok: true,
    tool: 'get_sunset_group_lesson_quote',
    location_id: locationId,
    service_dates: validated.service_dates,
    quantity: validated.quantity,
    date_count: validated.date_count,
    unit_amount_cents: unitCents,
    line_total_cents: totalCents,
    total_cents: totalCents,
    amount_eur: Math.round(totalCents / 100),
    currency: 'EUR',
    price_source: priceSourceLabel(adminCfg),
  };
}

function quoteSunsetGroupLessonsFromPrices(opts) {
  const locationId = normalizeSunsetLocationId(opts.locationId);
  const validated = validateGroupLessonQuoteBody(opts.body, opts.refDate);
  if (!validated.ok) {
    return { ok: false, success: false, reason: validated.reason, detail: validated.detail };
  }
  const unitCents = resolveSunsetGroupLessonUnitCents(opts.prices || []);
  if (unitCents == null) {
    return { ok: false, success: false, reason: 'group_lesson_price_unavailable' };
  }
  return buildGroupLessonQuoteResult(locationId, validated, unitCents, opts.adminCfg || null);
}

async function quoteSunsetGroupLessonsAsync(opts) {
  const clientSlug = String(opts.clientSlug || SUNSET_CLIENT_SLUG).trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, success: false, reason: 'invalid_tenant' };
  }
  const locationId = normalizeSunsetLocationId(opts.locationId);
  const validated = validateGroupLessonQuoteBody(opts.body, opts.refDate);
  if (!validated.ok) {
    return { ok: false, success: false, reason: validated.reason, detail: validated.detail };
  }
  let adminCfg;
  try {
    adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, {
      pgClient: opts.pgClient,
      locationId,
      skipDb: opts.skipDb,
    });
  } catch (_) {
    adminCfg = null;
  }
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, success: false, reason: 'admin_config_unavailable' };
  }
  const unitCents = resolveSunsetGroupLessonUnitCents(adminCfg.prices || []);
  if (unitCents == null) {
    return { ok: false, success: false, reason: 'group_lesson_price_unavailable' };
  }
  return buildGroupLessonQuoteResult(locationId, validated, unitCents, adminCfg);
}

function quoteSunsetGroupLessonsSync(opts) {
  const clientSlug = String(opts.clientSlug || SUNSET_CLIENT_SLUG).trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, success: false, reason: 'invalid_tenant' };
  }
  const locationId = normalizeSunsetLocationId(opts.locationId);
  const adminCfg = resolveTenantBusinessConfig(clientSlug, locationId);
  if (!adminCfg || adminCfg.ok === false) {
    return { ok: false, success: false, reason: 'admin_config_unavailable' };
  }
  return quoteSunsetGroupLessonsFromPrices({
    locationId,
    body: opts.body,
    refDate: opts.refDate,
    prices: adminCfg.prices || [],
    adminCfg,
  });
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  MAX_SERVICE_DATES,
  parseQuoteQuantity,
  validateGroupLessonQuoteBody,
  quoteSunsetGroupLessonsFromPrices,
  quoteSunsetGroupLessonsAsync,
  quoteSunsetGroupLessonsSync,
  buildGroupLessonQuoteResult,
};
