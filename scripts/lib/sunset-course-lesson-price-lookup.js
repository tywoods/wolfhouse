'use strict';

/**
 * Sunset course / private-lesson / group-lesson slot unit prices from
 * tenant_price_rules via loadTenantPriceRuleFromDb (same fail-closed contract
 * as rentals). Sunset-only. Never invents amounts; never falls back to the
 * catalog/baseline blob when the admin table exists.
 *
 * Persisted item_code shapes (admin tab):
 *   surf_pack_<packId>__<tier>     item_type=package  unit=day|session
 *   private_lesson__session        item_type=lesson   unit=session
 *   lesson_slot_<slotId>__session  item_type=lesson   unit=session
 */

const {
  isSunsetAdminDbReadEnabled,
  loadTenantPriceRuleFromDb,
} = require('./tenant-business-config');
const {
  isSunsetLocationId,
  normalizeSunsetLocationId,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-school-locations');

const EXPECTED_TENANT = 'sunset';
const PRIVATE_LESSON_ITEM_CODE = 'private_lesson__session';

function packPriceItemCode(packId, tierKey) {
  return `surf_pack_${String(packId).trim()}__${String(tierKey).trim()}`;
}

function billingUnitForSurfPackItemCode(itemCode) {
  const tier = String(itemCode || '').split('__').pop();
  return tier === 'single_class' ? 'session' : 'day';
}

function looksLikePersistedOfferingCode(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  if (s === PRIVATE_LESSON_ITEM_CODE) return true;
  if (/^surf_pack_.+__.+$/i.test(s)) return true;
  if (/^lesson_slot_.+__session$/i.test(s)) return true;
  return false;
}

/**
 * Resolve the exact tenant_price_rules identity from booking/service metadata.
 * Does not look up amounts — identity only.
 *
 * @returns {{ itemType:string, itemCode:string, billingUnit:string }|null}
 */
function resolveCourseLessonPriceIdentity(meta) {
  const m = meta || {};
  const component = String(m.component || m.staff_ui_service_type || '').toLowerCase();

  if (component === 'private_lesson') {
    return {
      itemType: 'lesson',
      itemCode: PRIVATE_LESSON_ITEM_CODE,
      billingUnit: 'session',
    };
  }

  const candidates = [
    m.item_code,
    m.offering_key,
    m.price_item_code,
    looksLikePersistedOfferingCode(m.offering_id) ? m.offering_id : null,
    looksLikePersistedOfferingCode(m.price_id) ? m.price_id : null,
  ].map((v) => (v == null ? '' : String(v).trim())).filter(Boolean);

  for (const code of candidates) {
    if (code === PRIVATE_LESSON_ITEM_CODE) {
      return { itemType: 'lesson', itemCode: code, billingUnit: 'session' };
    }
    if (/^lesson_slot_.+__session$/i.test(code)) {
      return { itemType: 'lesson', itemCode: code, billingUnit: 'session' };
    }
    if (/^surf_pack_.+__.+$/i.test(code)) {
      return {
        itemType: 'package',
        itemCode: code,
        billingUnit: billingUnitForSurfPackItemCode(code),
      };
    }
  }

  const courseId = m.course_id != null ? String(m.course_id).trim() : '';
  const tierKey = (m.tier && m.tier.key) || m.tier_key || m.duration_key || '';
  if (courseId && tierKey) {
    const itemCode = packPriceItemCode(courseId, tierKey);
    return {
      itemType: 'package',
      itemCode,
      billingUnit: billingUnitForSurfPackItemCode(itemCode),
    };
  }

  return null;
}

function isCourseOrLessonServiceRecord(sr, meta) {
  const m = meta || {};
  const component = String(m.component || m.staff_ui_service_type || '').toLowerCase();
  if (component === 'course' || component === 'private_lesson' || component === 'lesson' || component === 'group_lesson') {
    return true;
  }
  if (m.course_id || m.offering_id || m.item_code) {
    const dbType = String(sr && sr.service_type || '').toLowerCase();
    if (dbType === 'surf_lesson') return true;
  }
  return false;
}

async function defaultLoadRule(params) {
  if (params.pgClient) {
    return loadTenantPriceRuleFromDb(params.pgClient, params);
  }
  const { withPgClient } = require('./pg-connect');
  return withPgClient((client) => loadTenantPriceRuleFromDb(client, params));
}

/**
 * Async fail-closed unit price for Sunset course / private lesson / group slot.
 *
 * When SUNSET_ADMIN_DB_READ_ENABLED=true:
 *   found            → DB amount
 *   tables_missing   → bootstrap only (caller may use catalog); returns tables_missing
 *   not_found / …    → price_not_configured (never catalog)
 *   query error      → price_lookup_failed
 */
async function lookupSunsetCourseLessonPriceAsync(opts) {
  const options = opts || {};
  const rawSlug = options.client_slug;
  const clientSlug = (rawSlug != null) ? String(rawSlug).trim() : EXPECTED_TENANT;
  const qty = Math.max(1, Number(options.quantity) || 1);
  const meta = options.metadata || {};

  if (clientSlug !== EXPECTED_TENANT) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      client_slug: clientSlug,
      expected_tenant: EXPECTED_TENANT,
    };
  }

  const locationExplicit = Object.prototype.hasOwnProperty.call(options, 'location_id');
  const rawLoc = options.location_id != null ? options.location_id : meta.location_id;
  if (locationExplicit || meta.location_id != null) {
    if (rawLoc == null || String(rawLoc).trim() === '' || !isSunsetLocationId(rawLoc)) {
      return {
        ok: false,
        reason: 'unknown_location',
        client_slug: clientSlug,
        location_id: rawLoc == null ? rawLoc : String(rawLoc).trim(),
      };
    }
  }
  const locationId = (rawLoc != null && String(rawLoc).trim() !== '')
    ? normalizeSunsetLocationId(rawLoc)
    : DEFAULT_SUNSET_LOCATION_ID;

  const identity = resolveCourseLessonPriceIdentity(meta);
  if (!identity) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      source: 'db',
      detail: 'unresolved_offering_identity',
    };
  }

  if (!isSunsetAdminDbReadEnabled()) {
    return {
      ok: false,
      reason: 'db_read_disabled',
      client_slug: clientSlug,
      location_id: locationId,
      item_code: identity.itemCode,
      item_type: identity.itemType,
      billing_unit: identity.billingUnit,
    };
  }

  const loadRule = options.loadRule || defaultLoadRule;
  let dbRes;
  try {
    dbRes = await loadRule({
      clientSlug,
      locationId,
      itemType: identity.itemType,
      // item_code is already the full persisted offering__duration key.
      itemCode: identity.itemCode,
      duration: '',
      billingUnit: identity.billingUnit,
      pgClient: options.pgClient,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'price_lookup_failed',
      client_slug: clientSlug,
      location_id: locationId,
      item_code: identity.itemCode,
      detail: (err && err.message) ? err.message : 'db_error',
    };
  }

  if (!dbRes || dbRes.status === 'tables_missing') {
    return {
      ok: false,
      reason: 'tables_missing',
      client_slug: clientSlug,
      location_id: locationId,
      item_code: identity.itemCode,
      item_type: identity.itemType,
      billing_unit: identity.billingUnit,
    };
  }

  if (dbRes.status !== 'found') {
    const failClosed = dbRes.status === 'billing_unit_required'
      || dbRes.status === 'location_scope_unavailable'
      || dbRes.status === 'invalid_location'
      || dbRes.status === 'not_found';
    return {
      ok: false,
      reason: failClosed ? 'price_not_configured' : 'price_lookup_failed',
      client_slug: clientSlug,
      location_id: locationId,
      item_code: identity.itemCode,
      item_type: identity.itemType,
      billing_unit: identity.billingUnit,
      detail: dbRes.status,
      source: 'db',
    };
  }

  const amountCents = Math.round(Number(dbRes.amount_cents));
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      reason: 'price_not_configured',
      client_slug: clientSlug,
      location_id: locationId,
      item_code: identity.itemCode,
      source: 'db',
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    location_id: dbRes.location_id || locationId,
    item_code: identity.itemCode,
    item_type: identity.itemType,
    billing_unit: identity.billingUnit,
    unit_amount_cents: amountCents,
    amount_cents: amountCents * qty,
    quantity: qty,
    currency: dbRes.currency || 'EUR',
    source: 'db',
  };
}

module.exports = {
  PRIVATE_LESSON_ITEM_CODE,
  packPriceItemCode,
  resolveCourseLessonPriceIdentity,
  isCourseOrLessonServiceRecord,
  lookupSunsetCourseLessonPriceAsync,
  billingUnitForSurfPackItemCode,
};
