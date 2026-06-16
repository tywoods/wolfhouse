'use strict';
/**
 * wolfhouse-quote-calculator.js
 * Stage 8.4.3 — Pure Wolfhouse quote calculator.
 *
 * Proration rule (MVP): Formula B — per-night ceil5.
 *   1. weekly_per_person_cents / 7  → fractional per-night rate
 *   2. Round UP to nearest 500 cents (EUR 5) per person per night
 *   3. Multiply by nights × guest_count
 *
 * Formula B is the selected MVP rule because it matches the Wolfhouse business rule
 * described in wolfhouse-somo.baseline.json (3x.2g): weekly package price ÷ 7,
 * rounded up to the nearest €5 per night, multiplied by nights.
 *
 * For exactly 7 nights: use flat weekly_per_person_cents × guest_count directly.
 * No proration needed for a full-week stay.
 *
 * Forbidden: no pg, no DB calls, no fetch, no Stripe, no n8n, no WhatsApp.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Round up to the nearest 500 cents (EUR 5).
 * @param {number} cents - fractional or whole cents value
 * @returns {number} integer cents rounded up to nearest 500
 */
function ceil5(cents) {
  return Math.ceil(cents / 500) * 500;
}

/**
 * Parse a YYYY-MM-DD date string to a UTC Date object.
 * Throws on invalid input.
 */
function parseDateUTC(str) {
  if (!str || typeof str !== 'string') throw new Error(`Expected YYYY-MM-DD string, got: ${JSON.stringify(str)}`);
  const d = new Date(str + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error(`Invalid date string: "${str}"`);
  return d;
}

/**
 * Count whole nights between two UTC Date objects.
 */
function nightsBetween(checkIn, checkOut) {
  return Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24));
}

/**
 * Find the season that applies to a given 1-based month number.
 * Returns the season with the highest priority value containing the month,
 * or null if no season covers the month.
 */
function findSeason(config, month) {
  let best = null;
  for (const s of config.seasons) {
    if (Array.isArray(s.month_numbers) && s.month_numbers.includes(month)) {
      if (!best || (s.priority || 0) > (best.priority || 0)) {
        best = s;
      }
    }
  }
  return best;
}

/** Load and parse the pricing config from disk. */
function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// ─── Shared blocked-result builder ───────────────────────────────────────────

function buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config) {
  const { client_slug, package_code, room_type = 'shared' } = input || {};
  return {
    success: false,
    client_slug: client_slug || null,
    currency: config.currency,
    nights: (typeof nights === 'number' && nights > 0) ? nights : null,
    guest_count: guests || null,
    package_code: package_code || null,
    room_type,
    season_code,
    line_items: [],
    subtotal_cents: 0,
    discount_cents: 0,
    total_cents: 0,
    deposit_required_cents: 0,
    payment_link_amount_cents: 0,
    amount_paid_cents: 0,
    balance_due_cents: 0,
    payment_options: config.payment_options,
    confidence: 'blocked',
    blockers: blockers || [],
    warnings: warnings || [],
    formula_summary: 'Formula B (per-night ceil5): weekly_price ÷ 7, rounded up to nearest €5/night, × nights × guests',
    staff_review_required: !!(staff_review_required || (blockers && blockers.length > 0)),
    source: 'wolfhouse-quote-calculator',
    missing_config: !!missing_config,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * calculateWolfhouseQuote(input, config)
 *
 * Pure function — no side effects, no DB, no network.
 *
 * @param {object} input
 *   client_slug      {string}   Must match config.client_slug
 *   check_in         {string}   YYYY-MM-DD
 *   check_out        {string}   YYYY-MM-DD
 *   guest_count      {number}   >= 1
 *   package_code     {string}   'malibu' | 'uluwatu' | 'waimea'
 *   room_type        {string}   'shared' | 'double' | 'private'  (default 'shared')
 *   payment_choice   {string}   'deposit' | 'full' | 'pay_on_arrival'  (default 'deposit')
 *   add_ons          {Array}    [{code, days?, quantity?}]
 *
 * @param {object} [config]  Optional; loaded from disk if omitted.
 * @returns {object}  Quote output (see below for field list).
 */
function calculateWolfhouseQuote(input, config) {
  if (!config) config = loadConfig();

  const {
    client_slug,
    check_in,
    check_out,
    guest_count,
    package_code,
    guest_packages,
    room_type     = 'shared',
    payment_choice = 'deposit',
    add_ons       = [],
  } = input || {};

  const blockers = [];
  const warnings = [];
  let staff_review_required = false;
  let missing_config        = false;

  // ── 1. client_slug ────────────────────────────────────────────────────────
  if (client_slug !== config.client_slug) {
    blockers.push(`client_slug mismatch: got "${client_slug}", config is "${config.client_slug}"`);
  }

  // ── 2. Date validation ────────────────────────────────────────────────────
  let checkInDate  = null;
  let checkOutDate = null;
  let nights       = null;

  try {
    checkInDate  = parseDateUTC(check_in);
    checkOutDate = parseDateUTC(check_out);
    nights       = nightsBetween(checkInDate, checkOutDate);
    if (nights <= 0) {
      blockers.push(`check_out must be after check_in (nights = ${nights})`);
    }
  } catch (e) {
    blockers.push(`invalid dates: ${e.message}`);
  }

  // ── 3. guest_count ────────────────────────────────────────────────────────
  const guests = parseInt(guest_count, 10);
  if (!Number.isInteger(guests) || guests < 1) {
    blockers.push(`guest_count must be a positive integer (got "${guest_count}")`);
  }

  // ── 3b. Optional per-guest packages ───────────────────────────────────────
  const KNOWN_PACKAGES = ['malibu', 'uluwatu', 'waimea'];
  const normalizePkgCode = (value) => String(value || '').trim().toLowerCase();
  const isNoPackageCode = (code) => code === 'package_none' || code === 'no_package' || code === 'accommodation_only';
  let normalizedGuestPackages = [];
  if (Array.isArray(guest_packages) && guest_packages.length > 0) {
    if (Number.isInteger(guests) && guests > 0 && guest_packages.length !== guests) {
      blockers.push(`guest_packages length (${guest_packages.length}) must match guest_count (${guests})`);
    }
    normalizedGuestPackages = guest_packages.map((item, idx) => {
      const code = normalizePkgCode(item && item.package_code);
      const guestNumber = item && item.guest_number != null ? Number(item.guest_number) : idx + 1;
      if (!code) blockers.push(`package_code is required for guest ${idx + 1}`);
      if (code && !KNOWN_PACKAGES.includes(code) && !isNoPackageCode(code)) {
        blockers.push(`unknown package_code "${code}" for guest ${idx + 1} — staff review required`);
        staff_review_required = true;
      }
      return { guest_number: Number.isInteger(guestNumber) && guestNumber > 0 ? guestNumber : idx + 1, package_code: code };
    });
  }
  const hasGuestPackages = normalizedGuestPackages.length > 0;

  // ── 4. Season lookup ──────────────────────────────────────────────────────
  let season_code = null;

  if (checkInDate && nights > 0) {
    const month  = checkInDate.getUTCMonth() + 1; // 1–12
    const season = findSeason(config, month);

    if (!season) {
      // Edge months (Mar=3, Nov=11) have no configured season
      missing_config        = true;
      staff_review_required = true;
      blockers.push(`month ${month} has no configured season — edge month, staff review required`);
    } else if (season.bookable === false) {
      blockers.push(`month ${month} is in the "${season.code}" season which is closed (not bookable)`);
    } else {
      season_code = season.code;
    }
  }

  // Return early if any fundamental blocker exists before we can price
  if (blockers.length > 0) {
    return buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config);
  }

  // ── 5. Package lookup ─────────────────────────────────────────────────────
  const normalizedPackage = String(package_code || '').trim().toLowerCase();
  const isNoPackage = normalizedPackage === 'package_none' || normalizedPackage === 'no_package';
  const isManualOverride = normalizedPackage === 'manual_override';
  const manualPricePerNightCents = input.manual_price_per_night_cents != null
    ? Math.round(Number(input.manual_price_per_night_cents))
    : (input.manual_price_per_night_euros != null
      ? Math.round(Number(input.manual_price_per_night_euros) * 100)
      : null);

  if (!package_code && !hasGuestPackages) {
    staff_review_required = true;
    blockers.push('package_code is required');
  } else if (isManualOverride) {
    if (!manualPricePerNightCents || manualPricePerNightCents <= 0) {
      blockers.push('Enter a valid price per night for Manual Price Override.');
    }
  } else if (isNoPackage) {
    // accommodation-only — priced from Malibu weekly reference below
  } else if (!KNOWN_PACKAGES.includes(normalizedPackage)) {
    staff_review_required = true;
    blockers.push(`unknown package_code "${package_code}" — staff review required`);
  }

  let pkg = null;
  if (!isNoPackage && !isManualOverride && normalizedPackage) {
    pkg = config.packages.find((p) => p.code === normalizedPackage) || null;
    if (KNOWN_PACKAGES.includes(normalizedPackage) && !pkg) {
      blockers.push(`package "${package_code}" not found in pricing config`);
    }
  }

  if (blockers.length > 0) {
    return buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config);
  }

  // ── 6. Seasonal price / accommodation base ────────────────────────────────
  let weekly_cents = null;
  let per_night_ceil5 = null;
  let package_cents;
  let formula_detail;
  const effectivePackageCode = isNoPackage ? 'package_none'
    : (isManualOverride ? 'manual_override' : normalizedPackage);

  const guestPackageLineItems = [];
  if (isManualOverride) {
    per_night_ceil5 = manualPricePerNightCents;
    package_cents = per_night_ceil5 * nights * guests;
    formula_detail = `Manual override: ${per_night_ceil5}¢/night × ${nights}n × ${guests}g = ${package_cents}¢`;
  } else if (hasGuestPackages) {
    package_cents = 0;
    const details = [];
    for (const gp of normalizedGuestPackages) {
      const gpCode = isNoPackageCode(gp.package_code) ? 'package_none' : gp.package_code;
      const pricePackageCode = gpCode === 'package_none' ? 'malibu' : gpCode;
      const pricePkg = config.packages.find((p) => p.code === pricePackageCode);
      if (!pricePkg) {
        blockers.push(`package "${pricePackageCode}" not found in pricing config`);
        continue;
      }
      const seasonPrices = pricePkg.seasonal_prices && pricePkg.seasonal_prices[season_code];
      if (!seasonPrices || !seasonPrices.weekly_per_person_cents) {
        blockers.push(`no price configured for package "${pricePackageCode}" in season "${season_code}"`);
        continue;
      }
      const gpWeekly = seasonPrices.weekly_per_person_cents;
      const gpNightly = ceil5(gpWeekly / 7);
      const gpCents = nights === 7 ? gpWeekly : gpNightly * nights;
      package_cents += gpCents;
      const labelPrefix = gpCode === 'package_none' ? 'Accommodation only' : pricePkg.name;
      const note = gpCode === 'package_none'
        ? (nights === 7
          ? `No package guest ${gp.guest_number}: Malibu ref ${gpWeekly}¢/week = ${gpCents}¢`
          : `No package guest ${gp.guest_number}: Malibu ref ceil5(${gpWeekly}¢/7)=${gpNightly}¢/night × ${nights}n = ${gpCents}¢`)
        : (nights === 7
          ? `${pricePkg.name} guest ${gp.guest_number}: ${gpWeekly}¢/week = ${gpCents}¢`
          : `${pricePkg.name} guest ${gp.guest_number}: ceil5(${gpWeekly}¢/7)=${gpNightly}¢/night × ${nights}n = ${gpCents}¢`);
      guestPackageLineItems.push({
        code: gpCode === 'package_none' ? 'guest_accommodation_only' : (nights === 7 ? 'guest_package' : 'guest_package_proration'),
        label: `Guest ${gp.guest_number}: ${labelPrefix} (${season_code}, ${nights} night${nights !== 1 ? 's' : ''})`,
        guest_number: gp.guest_number,
        package_code: gpCode,
        nights,
        guest_count: 1,
        unit_cents: nights === 7 ? gpWeekly : gpNightly,
        total_cents: gpCents,
        note,
      });
      details.push(`G${gp.guest_number} ${gpCode}: ${gpCents / 100}€`);
    }
    if (blockers.length > 0) {
      return buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config);
    }
    formula_detail = `Per-guest packages: ${details.join(' + ')} = ${package_cents / 100}€ package base`;
    const counts = normalizedGuestPackages.reduce((acc, gp) => {
      acc[gp.package_code] = (acc[gp.package_code] || 0) + 1;
      return acc;
    }, {});
    const majorityCode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    pkg = config.packages.find((p) => p.code === majorityCode) || null;
  } else {
    const pricePackageCode = isNoPackage ? 'malibu' : normalizedPackage;
    const pricePkg = config.packages.find((p) => p.code === pricePackageCode);
    if (!pricePkg) {
      blockers.push(`package "${pricePackageCode}" not found in pricing config`);
      return buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config);
    }
    pkg = pricePkg;
    const seasonPrices = pkg.seasonal_prices && pkg.seasonal_prices[season_code];
    if (!seasonPrices || !seasonPrices.weekly_per_person_cents) {
      if (isNoPackage) {
        blockers.push('Malibu reference price unavailable for no-package nightly calculation');
      } else {
        blockers.push(`no price configured for package "${pricePackageCode}" in season "${season_code}"`);
      }
      return buildBlockedResult(config, input, nights, guests, season_code, blockers, warnings, staff_review_required, missing_config);
    }
    weekly_cents = seasonPrices.weekly_per_person_cents;
    per_night_ceil5 = ceil5(weekly_cents / 7);
    if (isNoPackage) {
      if (nights === 7) {
        package_cents = weekly_cents * guests;
        formula_detail = `No package (Malibu 7-night ref): ${weekly_cents}¢/person/week × ${guests}g = ${package_cents}¢`;
      } else {
        package_cents = per_night_ceil5 * nights * guests;
        formula_detail = `No package (Malibu ref): ceil5(${weekly_cents}¢/7)=${per_night_ceil5}¢/night × ${nights}n × ${guests}g = ${package_cents}¢`;
      }
    } else if (nights === 7) {
      package_cents = weekly_cents * guests;
      formula_detail = `7-night flat: ${weekly_cents}¢/person/week × ${guests}g = ${package_cents}¢`;
    } else {
      package_cents = per_night_ceil5 * nights * guests;
      formula_detail = `Formula B: ceil5(${weekly_cents}¢/7)=${per_night_ceil5}¢/night × ${nights}n × ${guests}g = ${package_cents}¢`;
    }
  }

  // ── 7. Base package / accommodation line item ─────────────────────────────

  const line_items = [];
  if (hasGuestPackages) {
    line_items.push(...guestPackageLineItems);
  } else if (isNoPackage) {
    line_items.push({
      code: 'accommodation_only',
      label: `Accommodation only (${season_code}, ${nights} night${nights !== 1 ? 's' : ''}, ${guests} guest${guests !== 1 ? 's' : ''}, Malibu ref nightly)`,
      nights,
      guest_count: guests,
      unit_cents: per_night_ceil5,
      total_cents: package_cents,
      note: formula_detail,
    });
  } else if (isManualOverride) {
    line_items.push({
      code: 'manual_accommodation',
      label: `Manual Price Override (${nights} night${nights !== 1 ? 's' : ''}, ${guests} guest${guests !== 1 ? 's' : ''})`,
      nights,
      guest_count: guests,
      unit_cents: per_night_ceil5,
      total_cents: package_cents,
      note: formula_detail,
    });
  } else {
    line_items.push({
      code: nights === 7 ? 'package' : 'package_proration',
      label: nights === 7
        ? `${pkg.name} (${season_code}, 7 nights, ${guests} guest${guests !== 1 ? 's' : ''})`
        : `${pkg.name} proration (${season_code}, ${nights} nights, ${guests} guest${guests !== 1 ? 's' : ''}, Formula B)`,
      nights,
      guest_count: guests,
      unit_cents: nights === 7 ? weekly_cents : per_night_ceil5,
      total_cents: package_cents,
      note: formula_detail,
    });
  }

  // ── 8. Room supplement ────────────────────────────────────────────────────
  let supplement_cents = 0;
  const roomSupp = config.room_supplements && config.room_supplements[room_type];

  if (!roomSupp) {
    warnings.push(`unknown room_type "${room_type}" — no supplement applied`);
  } else {
    const supp_ppn = roomSupp.per_person_per_night_cents || 0;
    if (supp_ppn > 0) {
      supplement_cents = supp_ppn * nights * guests;
      line_items.push({
        code: 'room_supplement',
        label: `${room_type} room supplement (${supp_ppn / 100}€/person/night × ${nights}n × ${guests}g)`,
        nights,
        guest_count: guests,
        unit_cents: supp_ppn,
        total_cents: supplement_cents,
      });
    }
  }

  // ── 9. Add-ons ────────────────────────────────────────────────────────────
  let addons_cents = 0;
  const addOnList = Array.isArray(add_ons) ? add_ons : [];

  // Tally surf-lesson quantity across all lesson add-on codes
  let totalLessons = 0;
  for (const addon of addOnList) {
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') {
      totalLessons += Math.max(1, parseInt(addon.quantity, 10) || 1);
    }
  }

  for (const addon of addOnList) {
    // Surf lessons are pooled and handled after the loop
    if (addon.code === 'surf_lesson_single' || addon.code === 'surf_lesson_multi') continue;

    const cfgA = config.add_ons[addon.code];
    if (!cfgA) {
      warnings.push(`unknown add-on code "${addon.code}" — skipped`);
      continue;
    }

    if (cfgA.pricing_unit === 'per_day') {
      const days  = Math.max(1, parseInt(addon.days, 10) || 1);
      const unit  = cfgA.price_cents;
      const total = unit * days;
      addons_cents += total;
      line_items.push({
        code: addon.code,
        label: `${cfgA.name} (${days} day${days !== 1 ? 's' : ''} × ${unit / 100}€)`,
        days,
        unit_cents: unit,
        total_cents: total,
      });
      if (cfgA.on_site) {
        warnings.push(`${cfgA.name}: normally booked and paid on site — confirm charge timing with staff`);
      }
      if (cfgA.charge_timing === 'REQUIRED_FROM_STAFF') {
        warnings.push(`${cfgA.name}: charge timing not confirmed (with booking or on site?) — staff confirmation needed`);
      }
      continue;
    }

    if (cfgA.pricing_unit === 'per_class') {
      const qty   = Math.max(1, parseInt(addon.quantity, 10) || 1);
      const unit  = cfgA.price_cents;
      const total = unit * qty;
      addons_cents += total;
      line_items.push({
        code: addon.code,
        label: `${cfgA.name} (${qty} class${qty !== 1 ? 'es' : ''} × ${unit / 100}€)`,
        quantity: qty,
        unit_cents: unit,
        total_cents: total,
      });
      if (cfgA.on_site) {
        warnings.push(`${cfgA.name}: normally booked and paid on site — confirm with staff`);
      }
      continue;
    }

    if (cfgA.pricing_unit === 'per_meal') {
      const qty   = Math.max(1, parseInt(addon.quantity, 10) || 1);
      const unit  = cfgA.price_cents;
      const total = unit * qty;
      addons_cents += total;
      line_items.push({
        code: addon.code,
        label: `${cfgA.name} (${qty} meal${qty !== 1 ? 's' : ''} × ${unit / 100}€)`,
        quantity: qty,
        unit_cents: unit,
        total_cents: total,
      });
      continue;
    }

    warnings.push(`add-on "${addon.code}" has unhandled pricing_unit "${cfgA.pricing_unit}" — skipped`);
  }

  // Surf lessons: total quantity determines single vs. bundle pricing
  if (totalLessons > 0) {
    let lesson_unit, lesson_total, lesson_code, lesson_label;
    if (totalLessons === 1) {
      lesson_unit  = config.add_ons.surf_lesson_single.price_cents;
      lesson_total = lesson_unit;
      lesson_code  = 'surf_lesson_single';
      lesson_label = `Surf lesson (single, 1 × ${lesson_unit / 100}€)`;
    } else {
      lesson_unit  = config.add_ons.surf_lesson_multi.price_cents_each;
      lesson_total = lesson_unit * totalLessons;
      lesson_code  = 'surf_lesson_multi';
      lesson_label = `Surf lessons (bundle rate, ${totalLessons} × ${lesson_unit / 100}€)`;
    }
    addons_cents += lesson_total;
    line_items.push({
      code: lesson_code,
      label: lesson_label,
      quantity: totalLessons,
      unit_cents: lesson_unit,
      total_cents: lesson_total,
    });
  }

  // ── 10. Totals ────────────────────────────────────────────────────────────
  const subtotal_cents = package_cents + supplement_cents + addons_cents;
  const discount_cents = 0;
  const total_cents    = subtotal_cents - discount_cents;

  // ── 11. Deposit tier ──────────────────────────────────────────────────────
  // Weekly surf packs (Malibu/Uluwatu/Waimea) use the package deposit even
  // when a 7+ night stay is priced across more than one week. Custom,
  // accommodation-only, and under-7-night stays use the short/custom tier.
  const usesPackageDeposit = (hasGuestPackages
    ? normalizedGuestPackages.some((gp) => KNOWN_PACKAGES.includes(gp.package_code))
    : KNOWN_PACKAGES.includes(normalizedPackage))
    && nights >= 7
    && !isManualOverride;
  const deposit_required_cents = usesPackageDeposit
    ? config.deposits.tiers.standard_package.amount_cents
    : config.deposits.tiers.custom_or_short_stay.amount_cents;

  // ── 12. Payment link amount ───────────────────────────────────────────────
  let payment_link_amount_cents = 0;

  if (payment_choice === 'deposit') {
    payment_link_amount_cents = deposit_required_cents;
  } else if (payment_choice === 'full') {
    payment_link_amount_cents = total_cents;
  } else if (payment_choice === 'pay_on_arrival') {
    payment_link_amount_cents = 0;
    staff_review_required     = true;
    warnings.push('pay_on_arrival: no payment link generated — confirm arrangement with staff');
  } else {
    warnings.push(`unrecognised payment_choice "${payment_choice}" — defaulting to deposit`);
    payment_link_amount_cents = deposit_required_cents;
  }

  // ── 13. Balance ───────────────────────────────────────────────────────────
  const amount_paid_cents  = 0;
  const balance_due_cents  = total_cents - amount_paid_cents;

  // ── 14. Confidence ────────────────────────────────────────────────────────
  const confidence = (staff_review_required || warnings.length > 0) ? 'review' : 'auto';

  // ── 15. Formula summary ───────────────────────────────────────────────────
  const formula_summary = hasGuestPackages
    ? formula_detail
    : (isManualOverride
      ? `Manual override: ${(per_night_ceil5 / 100).toFixed(2)}€/night × ${nights}n × ${guests}g = ${package_cents / 100}€ accommodation`
      : (isNoPackage
        ? (nights === 7
          ? `No package (Malibu 7-night ref): ${weekly_cents / 100}€/person/week × ${guests} guest${guests !== 1 ? 's' : ''} = ${package_cents / 100}€`
          : `No package: Malibu ref ceil5(${(weekly_cents / 100).toFixed(2)}€/7)=${(per_night_ceil5 / 100).toFixed(2)}€/night × ${nights}n × ${guests}g`)
        : (nights === 7
          ? `7-night flat: ${weekly_cents / 100}€/person/week × ${guests} guest${guests !== 1 ? 's' : ''} = ${package_cents / 100}€ package base`
          : `Formula B (per-night ceil5): ceil5(${weekly_cents / 100}€/7) = ${per_night_ceil5 / 100}€/night × ${nights}n × ${guests}g = ${package_cents / 100}€ package base`)));

  return {
    success: true,
    client_slug,
    currency: config.currency,
    nights,
    guest_count: guests,
    package_code: hasGuestPackages ? null : effectivePackageCode,
    guest_packages: hasGuestPackages ? normalizedGuestPackages : undefined,
    room_type,
    season_code,
    line_items,
    subtotal_cents,
    discount_cents,
    total_cents,
    deposit_required_cents,
    payment_link_amount_cents,
    amount_paid_cents,
    balance_due_cents,
    payment_options: config.payment_options,
    confidence,
    blockers,
    warnings,
    formula_summary,
    staff_review_required,
    source: 'wolfhouse-quote-calculator',
    missing_config,
  };
}

module.exports = { calculateWolfhouseQuote };
