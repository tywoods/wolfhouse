'use strict';

/**
 * tenant-business-config.js
 *
 * Read-only tenant business configuration resolver for Sunset Admin.
 * Loads from config/clients/{slug}.baseline.json — no DB, no writes.
 *
 * Future DB tables (spec only): tenant_price_rules, tenant_lesson_capacity_rules,
 * tenant_lesson_time_rules, tenant_config_audit_log — see docs/sunset/SUNSET-ADMIN-CONFIG-SPEC.md
 *
 * @module tenant-business-config
 */

const { loadBaselineJson, loadClientPortalProfile } = require('./staff-portal-clients');

const SUNSET_ADMIN_CLIENT = 'sunset';
const DEFAULT_DAILY_CAP = 24;

function flattenOfferingPrices(offerings, category, currency) {
  const prices = [];
  if (!offerings || typeof offerings !== 'object') return prices;
  for (const [offeringKey, offering] of Object.entries(offerings)) {
    if (!offering || typeof offering !== 'object') continue;
    const pricesEur = offering.prices_eur;
    if (!pricesEur || typeof pricesEur !== 'object') continue;
    for (const [unitKey, amount] of Object.entries(pricesEur)) {
      if (unitKey.startsWith('_')) continue;
      if (amount == null || typeof amount !== 'number') continue;
      prices.push({
        category,
        offering_key: offeringKey,
        label: offering.label || offeringKey,
        currency,
        unit: unitKey,
        amount,
        pricing_status: offering.pricing_status || null,
        active: true,
        effective_state: offering.pricing_status === 'confirmed' ? 'confirmed' : (offering.pricing_status || 'unverified_seed'),
      });
    }
  }
  return prices;
}

function loadLessonTimesFromConfig(cfg) {
  const slots = cfg && cfg.portal_demo && Array.isArray(cfg.portal_demo.lesson_slots)
    ? cfg.portal_demo.lesson_slots
    : [];
  if (slots.length) {
    return slots.map((s) => ({
      slot_id: s.slot_id || null,
      date: s.date || null,
      slot_time: s.slot_time || null,
      offering_label: s.offering_label || null,
      session_type: s.session_type || null,
      capacity: s.capacity != null ? Number(s.capacity) : null,
      source: s.source || 'config',
    }));
  }
  const common = cfg
    && cfg.catalog
    && cfg.catalog.lessons
    && cfg.catalog.lessons.scheduling
    && cfg.catalog.lessons.scheduling.common_slot_times;
  if (Array.isArray(common) && common.length) {
    return common.map((slotTime, idx) => ({
      slot_id: `fallback-slot-${idx + 1}`,
      date: null,
      slot_time: slotTime,
      offering_label: null,
      session_type: null,
      capacity: null,
      source: 'fallback',
    }));
  }
  return [];
}

/**
 * Resolve read-only business config for Admin tab / GET /staff/admin/config.
 *
 * @param {string} clientSlug
 * @returns {{ ok: true, client_slug, read_only, source, prices, lesson_capacity, lesson_times, business_info, change_history } | { ok: false, reason, client_slug? }}
 */
function resolveTenantBusinessConfig(clientSlug) {
  const slug = String(clientSlug || '').trim();
  const profile = loadClientPortalProfile(slug);

  if (!profile.is_surf_vertical || slug !== SUNSET_ADMIN_CLIENT) {
    return { ok: false, reason: 'unsupported_client', client_slug: slug };
  }

  const baseline = loadBaselineJson(slug);
  if (!baseline) {
    return {
      ok: true,
      client_slug: slug,
      read_only: true,
      source: 'fallback',
      prices: [],
      lesson_capacity: { default_daily_cap: DEFAULT_DAILY_CAP, overrides: [] },
      lesson_times: [],
      business_info: {
        name: slug,
        timezone: null,
        staging: true,
        config_source: 'fallback',
      },
      change_history: [],
    };
  }

  const currency = (baseline.pricing_policy && baseline.pricing_policy.currency)
    || (baseline._meta && baseline._meta.currency)
    || 'EUR';

  const rentals = baseline.catalog && baseline.catalog.rentals && baseline.catalog.rentals.offerings;
  const lessons = baseline.catalog && baseline.catalog.lessons && baseline.catalog.lessons.offerings;
  const prices = [
    ...flattenOfferingPrices(rentals, 'rental', currency),
    ...flattenOfferingPrices(lessons, 'lesson', currency),
  ];

  const demoMode = !!(baseline.portal_demo && baseline.portal_demo.demo_mode);
  const deploymentEnabled = !!(baseline.deployment && baseline.deployment.enabled);

  return {
    ok: true,
    client_slug: slug,
    read_only: true,
    source: 'config',
    prices,
    lesson_capacity: {
      default_daily_cap: DEFAULT_DAILY_CAP,
      overrides: [],
    },
    lesson_times: loadLessonTimesFromConfig(baseline),
    business_info: {
      name: (baseline._meta && baseline._meta.client_name)
        || (baseline.persona && baseline.persona.brand_name)
        || slug,
      timezone: (baseline._meta && baseline._meta.timezone) || null,
      staging: demoMode || !deploymentEnabled,
      config_source: `${slug}.baseline.json`,
    },
    change_history: [],
  };
}

module.exports = {
  SUNSET_ADMIN_CLIENT,
  DEFAULT_DAILY_CAP,
  flattenOfferingPrices,
  loadLessonTimesFromConfig,
  resolveTenantBusinessConfig,
};
