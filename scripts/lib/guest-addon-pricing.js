'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_PRICING_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

function loadWolfhousePricingConfig(pricingPath = DEFAULT_PRICING_PATH) {
  return JSON.parse(fs.readFileSync(pricingPath, 'utf8'));
}

function parseServiceMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function rentalDaysFromRecord(row) {
  const meta = parseServiceMetadata(row && row.metadata);
  return Math.max(1, Number(meta.rental_days || row.quantity || 1));
}

function boardVariantFromRecord(row) {
  const meta = parseServiceMetadata(row && row.metadata);
  const ui = String(meta.staff_ui_service_type || '').toLowerCase();
  if (ui === 'hard_board') return 'hard';
  if (ui === 'soft_board') return 'soft';
  const variant = String(meta.board_variant || '').toLowerCase();
  if (variant === 'hard' || variant === 'soft') return variant;
  const code = String(meta.pricing_addon_code || meta.source_addon_code || '').toLowerCase();
  if (code.includes('hard')) return 'hard';
  return 'soft';
}

function isActiveBoardRental(row) {
  if (!row || String(row.service_type || '').toLowerCase() !== 'surfboard') return false;
  const st = String(row.status || 'confirmed').toLowerCase();
  return st !== 'cancelled';
}

function isActiveWetsuitRental(row) {
  if (!row || String(row.service_type || '').toLowerCase() !== 'wetsuit') return false;
  const st = String(row.status || 'confirmed').toLowerCase();
  return st !== 'cancelled';
}

function isPaidServiceRecord(row) {
  const ps = String(row.payment_status || '').toLowerCase();
  if (ps === 'paid') return true;
  return Number(row.amount_paid_cents || 0) > 0;
}

function isUnpaidChargeableService(row) {
  if (!row) return false;
  if (isPaidServiceRecord(row)) return false;
  const ps = String(row.payment_status || '').toLowerCase();
  if (ps === 'not_requested' && Number(row.amount_due_cents || 0) === 0) return false;
  return Number(row.amount_due_cents || 0) > 0;
}

function findCoveringBoardRental(existingRecords, rentalDays) {
  const days = Math.max(1, Number(rentalDays) || 1);
  return (existingRecords || []).find((row) => {
    if (!isActiveBoardRental(row)) return false;
    return rentalDaysFromRecord(row) >= days;
  }) || null;
}

function findUnpaidWetsuitForCombo(existingRecords, rentalDays) {
  const days = Math.max(1, Number(rentalDays) || 1);
  return (existingRecords || []).find((row) => {
    if (!isActiveWetsuitRental(row)) return false;
    if (isPaidServiceRecord(row)) return false;
    if (Number(row.amount_due_cents || 0) <= 0) return false;
    return rentalDaysFromRecord(row) >= days;
  }) || null;
}

const LUNA_ADDON_CODE_ALIASES = Object.freeze({
  wetsuit: 'wetsuit_rental',
  surfboard: 'soft_top_rental',
  soft_board: 'soft_top_rental',
  soft_top: 'soft_top_rental',
  hard_board: 'hard_board_rental',
  surf_lesson: 'surf_lesson_single',
  yoga: 'yoga_class',
  meal: 'meals',
  meals: 'meals',
});

function rentalDaysFromAddOn(addon) {
  if (!addon) return 1;
  if (addon.days != null) return Math.max(1, parseInt(addon.days, 10) || 1);
  if (addon.quantity != null && (addon.service_type === 'wetsuit' || addon.service_type === 'surfboard')) {
    return Math.max(1, parseInt(addon.quantity, 10) || 1);
  }
  return Math.max(1, parseInt(addon.quantity, 10) || 1);
}

/**
 * Map Luna/Hermes add-on payloads to wolfhouse quote calculator codes.
 */
function normalizeLunaBookingAddOnsInput(addOns) {
  const out = [];
  for (const raw of (addOns || [])) {
    if (!raw || typeof raw !== 'object') continue;
    let code = String(raw.code || raw.addon_code || raw.service_type || '').trim().toLowerCase();
    if (!code) continue;
    code = LUNA_ADDON_CODE_ALIASES[code] || code;

    if (raw.board_type != null || raw.boardType != null) {
      const bt = String(raw.board_type || raw.boardType).trim().toLowerCase();
      if (bt === 'hard') code = 'hard_board_rental';
      else if (bt === 'soft') code = 'soft_top_rental';
    }

    if (code === 'wetsuit_rental' || code === 'soft_top_rental' || code === 'hard_board_rental'
      || code === 'wetsuit_soft_top_combo' || code === 'wetsuit_hard_board_combo') {
      out.push({ code, days: rentalDaysFromAddOn(raw) });
      continue;
    }
    if (code === 'surf_lesson_single' || code === 'surf_lesson_multi') {
      out.push({ code: 'surf_lesson_single', quantity: Math.max(1, parseInt(raw.quantity, 10) || 1) });
      continue;
    }
    if (code === 'yoga_class') {
      out.push({ code, quantity: Math.max(1, parseInt(raw.quantity, 10) || 1) });
      continue;
    }
    if (code === 'meals' || code === 'meal') {
      out.push({ code: 'meals', quantity: Math.max(1, parseInt(raw.quantity, 10) || 1) });
      continue;
    }
    out.push({ ...raw, code });
  }
  return out;
}

/**
 * Merge wetsuit + board rentals into combo quote lines (same-day promo).
 * Overlapping days: wetsuit is free for days covered by a board rental.
 */
function normalizeQuoteAddOnsForCombo(addOns) {
  const list = normalizeLunaBookingAddOnsInput(addOns);
  const out = [];
  const used = new Set();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.code === 'wetsuit_soft_top_combo' || item.code === 'wetsuit_hard_board_combo') {
      out.push(item);
      used.add(i);
    }
  }

  const boardPairs = [
    ['soft_top_rental', 'wetsuit_soft_top_combo'],
    ['hard_board_rental', 'wetsuit_hard_board_combo'],
  ];

  for (let i = 0; i < list.length; i++) {
    if (used.has(i) || list[i].code !== 'wetsuit_rental') continue;
    const wDays = rentalDaysFromAddOn(list[i]);

    for (const [boardCode, comboCode] of boardPairs) {
      const bIdx = list.findIndex((a, j) => !used.has(j) && a.code === boardCode);
      if (bIdx < 0) continue;
      const bDays = rentalDaysFromAddOn(list[bIdx]);
      const overlap = Math.min(wDays, bDays);
      if (overlap <= 0) continue;

      used.add(i);
      used.add(bIdx);
      out.push({ code: comboCode, days: overlap });
      const extraBoard = bDays - overlap;
      const extraWetsuit = wDays - overlap;
      if (extraBoard > 0) out.push({ code: boardCode, days: extraBoard });
      if (extraWetsuit > 0) out.push({ code: 'wetsuit_rental', days: extraWetsuit });
      break;
    }
  }

  for (let i = 0; i < list.length; i++) {
    if (!used.has(i)) out.push(list[i]);
  }
  return out;
}

/**
 * Pure pricing preview for Luna guest add-ons (post-booking).
 * @param {string} serviceType
 * @param {number} quantity — meals count or rental days
 * @param {string} clientSlug
 * @param {{ board_type?: string, pricingPath?: string }} [opts]
 */
function previewGuestAddonPricing(serviceType, quantity, clientSlug, opts = {}) {
  const warnings = [];
  const boardType = opts.board_type != null ? String(opts.board_type).trim().toLowerCase() : '';

  if (clientSlug !== 'wolfhouse-somo') {
    return {
      amount_due_cents: null,
      pricing_addon_code: null,
      unit_cents: null,
      payment_required: false,
      warnings: [`pricing config not loaded for client "${clientSlug}" — staff review required`],
    };
  }

  let config;
  try {
    config = loadWolfhousePricingConfig(opts.pricingPath);
  } catch (err) {
    return {
      amount_due_cents: null,
      pricing_addon_code: null,
      unit_cents: null,
      payment_required: false,
      warnings: [`pricing config unavailable: ${err.message}`],
    };
  }

  const addOns = config.add_ons || {};

  if (serviceType === 'meal') {
    const cfg = addOns.meal || addOns.meals;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return {
        amount_due_cents: null,
        pricing_addon_code: 'meal',
        unit_cents: null,
        payment_required: false,
        warnings: ['Meal price not safely available — staff review required.'],
      };
    }
    const qty = Math.max(1, Number(quantity) || 1);
    return {
      amount_due_cents: cfg.price_cents * qty,
      pricing_addon_code: 'meal',
      unit_cents: cfg.price_cents,
      payment_required: true,
      pricing_unit: 'per_meal',
      warnings,
    };
  }

  if (serviceType === 'wetsuit') {
    const cfg = addOns.wetsuit_rental;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return {
        amount_due_cents: null,
        pricing_addon_code: 'wetsuit_rental',
        unit_cents: null,
        payment_required: false,
        warnings: ['Wetsuit rental price not safely available — staff review required.'],
      };
    }
    const days = Math.max(1, Number(quantity) || 1);
    return {
      amount_due_cents: cfg.price_cents * days,
      pricing_addon_code: 'wetsuit_rental',
      unit_cents: cfg.price_cents,
      payment_required: true,
      pricing_unit: 'per_day',
      warnings,
    };
  }

  if (serviceType === 'surfboard') {
    const variant = boardType === 'hard' ? 'hard' : (boardType === 'soft' ? 'soft' : '');
    const code = variant === 'hard' ? 'hard_board_rental' : 'soft_top_rental';
    const cfg = addOns[code];
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return {
        amount_due_cents: null,
        pricing_addon_code: code,
        unit_cents: null,
        payment_required: false,
        warnings: ['Surfboard rental price not safely available — staff review required.'],
      };
    }
    const days = Math.max(1, Number(quantity) || 1);
    return {
      amount_due_cents: cfg.price_cents * days,
      pricing_addon_code: code,
      unit_cents: cfg.price_cents,
      payment_required: true,
      pricing_unit: 'per_day',
      board_type: variant || null,
      warnings,
    };
  }

  if (serviceType === 'surf_lesson') {
    const qty = Math.max(1, Number(quantity) || 1);
    if (qty === 1) {
      const cfg = addOns.surf_lesson_single;
      if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
        return {
          amount_due_cents: null,
          pricing_addon_code: 'surf_lesson_single',
          unit_cents: null,
          payment_required: false,
          warnings: ['Surf lesson price not safely available — staff review required.'],
        };
      }
      return {
        amount_due_cents: cfg.price_cents,
        pricing_addon_code: 'surf_lesson_single',
        unit_cents: cfg.price_cents,
        payment_required: true,
        pricing_unit: 'per_lesson',
        warnings,
      };
    }
    const cfg = addOns.surf_lesson_multi;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents_each) {
      return {
        amount_due_cents: null,
        pricing_addon_code: 'surf_lesson_multi',
        unit_cents: null,
        payment_required: false,
        warnings: ['Multi-lesson price not safely available — staff review required.'],
      };
    }
    return {
      amount_due_cents: cfg.price_cents_each * qty,
      pricing_addon_code: 'surf_lesson_multi',
      unit_cents: cfg.price_cents_each,
      payment_required: true,
      pricing_unit: 'per_lesson',
      warnings,
    };
  }

  if (serviceType === 'yoga') {
    const cfg = addOns.yoga_class;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return {
        amount_due_cents: null,
        pricing_addon_code: 'yoga_class',
        unit_cents: null,
        payment_required: false,
        warnings: ['Yoga class price not safely available — staff review required.'],
      };
    }
    const qty = Math.max(1, Number(quantity) || 1);
    return {
      amount_due_cents: cfg.price_cents * qty,
      pricing_addon_code: 'yoga_class',
      unit_cents: cfg.price_cents,
      payment_required: true,
      pricing_unit: 'per_class',
      warnings,
    };
  }

  return {
    amount_due_cents: null,
    pricing_addon_code: null,
    unit_cents: null,
    payment_required: false,
    warnings: [`unsupported service_type "${serviceType}" for pricing preview`],
  };
}

/**
 * Apply wetsuit/board combo promo using existing booking service records.
 * Returns create-time pricing adjustments (DB writes handled by caller).
 */
function resolveGuestAddonComboPricing({ serviceType, quantity, boardType, pricing, existingRecords }) {
  const days = Math.max(1, Number(quantity) || 1);
  const baseAmount = pricing && pricing.amount_due_cents != null
    ? Number(pricing.amount_due_cents)
    : 0;
  const result = {
    amount_due_cents: baseAmount,
    payment_required: !!(pricing && pricing.payment_required && baseAmount > 0),
    combo_applied: false,
    combo_reason: null,
    free_wetsuit_record_id: null,
  };

  if (serviceType === 'wetsuit') {
    const board = findCoveringBoardRental(existingRecords, days);
    if (board) {
      result.amount_due_cents = 0;
      result.payment_required = false;
      result.combo_applied = true;
      result.combo_reason = 'wetsuit_free_with_board';
    }
    return result;
  }

  if (serviceType === 'surfboard') {
    const wetsuit = findUnpaidWetsuitForCombo(existingRecords, days);
    if (wetsuit) {
      result.free_wetsuit_record_id = wetsuit.id;
      result.combo_applied = true;
      result.combo_reason = 'board_frees_unpaid_wetsuit';
    }
    return result;
  }

  return result;
}

module.exports = {
  DEFAULT_PRICING_PATH,
  loadWolfhousePricingConfig,
  previewGuestAddonPricing,
  resolveGuestAddonComboPricing,
  findCoveringBoardRental,
  findUnpaidWetsuitForCombo,
  boardVariantFromRecord,
  rentalDaysFromRecord,
  isPaidServiceRecord,
  parseServiceMetadata,
  normalizeLunaBookingAddOnsInput,
  normalizeQuoteAddOnsForCombo,
};
