'use strict';

/**
 * Slice A — Per-guest booking & payments helpers.
 * Pure normalization + breakdown builders; DB insert helpers accept a pg client.
 */

const { calculateWolfhouseQuote, loadConfig } = require('./wolfhouse-quote-calculator');

const KNOWN_PACKAGES = ['malibu', 'uluwatu', 'waimea'];
const PACKAGE_PREVIEW_CODES = ['malibu', 'uluwatu', 'waimea'];

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Normalize Luna/Hermes payment_choice for bot booking create + quote.
 * "per_guest" means per-guest deposit links (quote still uses deposit tier math).
 *
 * @returns {{ payment_choice: string, per_guest_payment_links: boolean }}
 */
function normalizeBotBookingPaymentChoice(raw) {
  const compact = trimStr(raw).toLowerCase().replace(/[^a-z0-9_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return { payment_choice: 'deposit', per_guest_payment_links: false };
  }
  if (['per_guest', 'per guest', 'each guest', 'split', 'split deposit', 'link each'].includes(compact)) {
    return { payment_choice: 'deposit', per_guest_payment_links: true };
  }
  if (['full', 'full amount', 'pay full', 'pay full amount', 'all now', 'pay all', 'everything', 'whole amount'].includes(compact)) {
    return { payment_choice: 'full', per_guest_payment_links: false };
  }
  if (['deposit', 'pay deposit', 'the deposit', 'deposit only'].includes(compact)) {
    return { payment_choice: 'deposit', per_guest_payment_links: false };
  }
  if (['arrival', 'on arrival', 'pay on arrival', 'later', 'pay_on_arrival'].includes(compact)) {
    return { payment_choice: 'pay_on_arrival', per_guest_payment_links: false };
  }
  return { payment_choice: compact, per_guest_payment_links: false };
}

/** Map Staff API create validation errors to bridge blocked_reason codes. */
function mapBotBookingCreateErrorToBlockedReason(errorText) {
  const msg = trimStr(errorText).toLowerCase();
  if (!msg) return 'booking_create_failed';
  if (msg.includes('guest_name')) return 'guest_name_missing';
  if (msg.includes('phone')) return 'guest_phone_missing';
  if (msg.includes('payment_choice')) return 'payment_choice_missing';
  if (msg.includes('package_code') || msg.includes('package')) return 'booking_package_missing';
  if (msg.includes('check_in') || msg.includes('check_out') || msg.includes('dates')) return 'booking_dates_missing';
  if (msg.includes('selected_bed') || msg.includes('bed assignment')) return 'availability_selected_beds_missing';
  if (msg.includes('confirm')) return 'confirm_true_required';
  if (msg.includes('quote')) return 'booking_quote_missing_or_failed';
  if (msg.includes('overlap') || msg.includes('conflict')) return 'availability_overlap_conflict';
  if (msg.includes('guests length')) return 'guest_names_count_mismatch';
  if (msg.includes('guest name is required')) return 'guest_name_missing';
  return 'booking_create_failed';
}

function isNoPackageCode(code) {
  const c = trimStr(code).toLowerCase();
  return c === 'package_none' || c === 'no_package' || c === 'accommodation_only';
}

/**
 * Normalize guests: [{ name }] from request body.
 * Falls back to guest_name repeated guest_count times when guests omitted (legacy).
 *
 * @returns {{ ok: boolean, error?: string, guests: { guest_number: number, guest_name: string }[], primary_name: string, uses_per_guest_model: boolean }}
 */
function normalizeBookingGuestsInput(body) {
  const src = body || {};
  const guestCount = parseInt(src.guest_count, 10) || 0;
  const primaryName = trimStr(src.guest_name).slice(0, 200);
  const rawGuests = Array.isArray(src.guests) ? src.guests : [];

  if (rawGuests.length > 0) {
    if (guestCount > 0 && rawGuests.length !== guestCount) {
      return {
        ok: false,
        error: `guests length (${rawGuests.length}) must match guest_count (${guestCount})`,
        guests: [],
        primary_name: primaryName,
        uses_per_guest_model: true,
      };
    }
    const guests = rawGuests.map((item, idx) => {
      const name = trimStr(item && (item.name || item.guest_name)).slice(0, 200);
      if (!name) {
        return { guest_number: idx + 1, guest_name: '', _missing: true };
      }
      return { guest_number: idx + 1, guest_name: name };
    });
    const missing = guests.find((g) => g._missing);
    if (missing) {
      return {
        ok: false,
        error: `guest name is required for guest ${missing.guest_number}`,
        guests: [],
        primary_name: primaryName,
        uses_per_guest_model: true,
      };
    }
    const count = guestCount > 0 ? guestCount : guests.length;
    return {
      ok: true,
      guests,
      primary_name: guests[0].guest_name || primaryName,
      guest_count: count,
      uses_per_guest_model: true,
    };
  }

  const count = guestCount > 0 ? guestCount : (primaryName ? 1 : 0);
  if (count < 1) {
    return {
      ok: true,
      guests: [],
      primary_name: primaryName,
      guest_count: 0,
      uses_per_guest_model: false,
    };
  }
  const fallbackName = primaryName || 'Guest';
  const guests = [];
  for (let i = 0; i < count; i++) {
    guests.push({ guest_number: i + 1, guest_name: count === 1 ? fallbackName : `${fallbackName} (${i + 1})` });
  }
  return {
    ok: true,
    guests,
    primary_name: fallbackName,
    guest_count: count,
    uses_per_guest_model: false,
  };
}

/**
 * Deposit tier for one guest (anchor: wolfhouse-quote-calculator deposit section).
 */
function computeGuestDepositTierCents(config, packageCode, nights, isManualOverride) {
  const pkg = trimStr(packageCode).toLowerCase();
  const usesPackageDeposit = KNOWN_PACKAGES.includes(pkg)
    && nights >= 7
    && !isManualOverride
    && pkg !== 'manual_override'
    && !isNoPackageCode(pkg);
  return usesPackageDeposit
    ? config.deposits.tiers.standard_package.amount_cents
    : config.deposits.tiers.custom_or_short_stay.amount_cents;
}

/**
 * Build per-guest deposit list aligned with guest_packages or uniform package.
 */
function buildPerGuestDepositList(config, input, nights, guestCount, normalizedGuestPackages, normalizedPackage, isManualOverride) {
  const list = [];
  if (normalizedGuestPackages.length > 0) {
    for (const gp of normalizedGuestPackages) {
      list.push({
        guest_number: gp.guest_number,
        package_code: gp.package_code,
        deposit_cents: computeGuestDepositTierCents(config, gp.package_code, nights, isManualOverride),
      });
    }
    return list;
  }
  for (let i = 1; i <= guestCount; i++) {
    list.push({
      guest_number: i,
      package_code: normalizedPackage,
      deposit_cents: computeGuestDepositTierCents(config, normalizedPackage, nights, isManualOverride),
    });
  }
  return list;
}

/**
 * Split booking-level add-on cents equally across guests (integer-safe remainder to last guest).
 */
function splitCentsAcrossGuests(totalCents, guestCount) {
  const n = Math.max(1, guestCount);
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const base = Math.floor(total / n);
  let remainder = total - base * n;
  const shares = [];
  for (let i = 0; i < n; i++) {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    shares.push(base + extra);
  }
  return shares;
}

/**
 * Build per_person breakdown from a successful quote.
 *
 * @param {object} quote  calculateWolfhouseQuote output
 * @param {object} opts   { guest_names[], guest_packages[], uses_per_guest_model, payment_choice }
 */
function buildPerPersonBreakdown(quote, opts) {
  const o = opts || {};
  const guestCount = Number(quote.guest_count) || 0;
  if (guestCount < 1) return [];

  const names = Array.isArray(o.guest_names) ? o.guest_names : [];
  const depositByGuest = {};
  if (Array.isArray(quote.per_guest_deposits)) {
    for (const row of quote.per_guest_deposits) {
      depositByGuest[row.guest_number] = row.deposit_cents;
    }
  }

  const accByGuest = {};
  const pkgByGuest = {};
  const lineItems = Array.isArray(quote.line_items) ? quote.line_items : [];
  for (const li of lineItems) {
    if (li.guest_number != null && (li.code || '').startsWith('guest_')) {
      accByGuest[li.guest_number] = (accByGuest[li.guest_number] || 0) + Number(li.total_cents || 0);
      if (li.package_code) pkgByGuest[li.guest_number] = li.package_code;
    }
  }

  let uniformAccPerGuest = 0;
  let uniformPkg = quote.package_code || null;
  if (!Object.keys(accByGuest).length) {
    const accLines = lineItems.filter((li) => (
      ['package', 'package_proration', 'accommodation_only', 'manual_accommodation'].includes(li.code)
    ));
    const accTotal = accLines.reduce((s, li) => s + Number(li.total_cents || 0), 0);
    uniformAccPerGuest = Math.round(accTotal / guestCount);
    for (let i = 1; i <= guestCount; i++) {
      accByGuest[i] = uniformAccPerGuest;
    }
  }

  const addonLines = lineItems.filter((li) => !['package', 'package_proration', 'accommodation_only', 'manual_accommodation', 'room_supplement'].includes(li.code)
    && !(String(li.code || '').startsWith('guest_')));
  const addonTotal = addonLines.reduce((s, li) => s + Number(li.total_cents || 0), 0);
  const addonShares = splitCentsAcrossGuests(addonTotal, guestCount);

  const suppLine = lineItems.find((li) => li.code === 'room_supplement');
  const suppShares = suppLine
    ? splitCentsAcrossGuests(Number(suppLine.total_cents || 0), guestCount)
    : new Array(guestCount).fill(0);

  const paymentChoice = trimStr(o.payment_choice || 'deposit').toLowerCase();
  const rows = [];
  for (let i = 1; i <= guestCount; i++) {
    const accommodation_cents = accByGuest[i] || 0;
    const addons_cents = addonShares[i - 1] || 0;
    const supplement_cents = suppShares[i - 1] || 0;
    const subtotal_cents = accommodation_cents + addons_cents + supplement_cents;
    const deposit_cents = depositByGuest[i] != null
      ? depositByGuest[i]
      : (quote.deposit_required_cents || 0);
    const amount_paid_cents = 0;
    let balance_cents = subtotal_cents - amount_paid_cents;
    if (paymentChoice === 'deposit') {
      balance_cents = Math.max(0, subtotal_cents - deposit_cents);
    }
    rows.push({
      guest_number: i,
      guest_name: names[i - 1] || null,
      package_code: pkgByGuest[i] || uniformPkg,
      accommodation_cents,
      addons_cents,
      supplement_cents,
      subtotal_cents,
      deposit_cents,
      amount_paid_cents,
      balance_cents,
      payment_status: 'not_requested',
    });
  }
  return rows;
}

/**
 * Read-only package price preview for Luna (A5).
 */
function computePackagePricePreview(input, config) {
  if (!config) config = loadConfig();
  const clientSlug = trimStr(input.client_slug) || config.client_slug;
  const checkIn = trimStr(input.check_in);
  const checkOut = trimStr(input.check_out);
  const guestCount = Math.max(1, parseInt(input.guest_count, 10) || 1);
  const roomType = trimStr(input.room_type) || 'shared';

  const packages = {};
  let season_code = null;
  let nights = null;
  let blockers = [];

  for (const code of PACKAGE_PREVIEW_CODES) {
    const quote = calculateWolfhouseQuote({
      client_slug: clientSlug,
      check_in: checkIn,
      check_out: checkOut,
      guest_count: guestCount,
      package_code: code,
      room_type: roomType,
      payment_choice: 'deposit',
      add_ons: [],
    }, config);
    if (quote.season_code) season_code = quote.season_code;
    if (quote.nights) nights = quote.nights;
    if (!quote.success) {
      blockers = quote.blockers || blockers;
      packages[code] = { success: false, blockers: quote.blockers || [] };
      continue;
    }
    const perGuestDeposits = buildPerGuestDepositList(
      config,
      input,
      quote.nights,
      guestCount,
      [],
      code,
      false,
    );
    const depositPerGuest = perGuestDeposits[0] ? perGuestDeposits[0].deposit_cents : quote.deposit_required_cents;
    packages[code] = {
      success: true,
      total_cents: quote.total_cents,
      per_person_cents: Math.round(quote.total_cents / guestCount),
      deposit_per_guest_cents: depositPerGuest,
      deposit_total_cents: depositPerGuest * guestCount,
      currency: quote.currency,
      nights: quote.nights,
      season_code: quote.season_code,
    };
  }

  return {
    success: blockers.length === 0 || Object.values(packages).some((p) => p.success),
    client_slug: clientSlug,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    nights,
    season_code,
    packages,
    source: 'package-price-preview',
  };
}

const BOOKING_GUESTS_SELECT_SQL = `
SELECT
  bg.id::text              AS booking_guest_id,
  bg.guest_number,
  bg.guest_name,
  bg.assigned_room_code,
  bg.assigned_bed_code,
  bg.deposit_amount_cents,
  bg.amount_paid_cents,
  bg.payment_status,
  bg.payment_id::text      AS payment_id,
  bg.metadata,
  bg.created_at,
  bg.updated_at
FROM booking_guests bg
INNER JOIN bookings b ON b.id = bg.booking_id
INNER JOIN clients c ON c.id = bg.client_id
WHERE c.slug = $1
  AND b.booking_code = $2
ORDER BY bg.guest_number ASC
`;

function isMissingBookingGuestsTable(err) {
  const msg = String(err && err.message || '').toLowerCase();
  return msg.includes('booking_guests') && (msg.includes('does not exist') || msg.includes('relation'));
}

/**
 * Insert booking_guests rows inside an open transaction.
 *
 * @param {object} pg
 * @param {object} params
 */
async function insertBookingGuestsForBooking(pg, params) {
  const {
    clientId,
    bookingId,
    guests,
    bedAssignments,
    perPersonBreakdown,
  } = params;

  const breakdownByNum = {};
  for (const row of perPersonBreakdown || []) {
    breakdownByNum[row.guest_number] = row;
  }

  const inserted = [];
  for (const guest of guests || []) {
    const num = guest.guest_number;
    const bed = (bedAssignments || []).find((b) => b.guest_number === num)
      || (bedAssignments || [])[num - 1]
      || null;
    const br = breakdownByNum[num] || {};
    const r = await pg.query(
      `INSERT INTO booking_guests (
         client_id, booking_id, guest_number, guest_name,
         assigned_room_code, assigned_bed_code,
         deposit_amount_cents, amount_paid_cents, payment_status, metadata
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 0, 'not_requested', $8::jsonb
       )
       RETURNING id::text AS booking_guest_id, guest_number, guest_name,
                 deposit_amount_cents, payment_status`,
      [
        clientId,
        bookingId,
        num,
        guest.guest_name,
        bed ? bed.room_code : null,
        bed ? bed.bed_code : null,
        br.deposit_cents != null ? br.deposit_cents : 0,
        JSON.stringify({
          package_code: br.package_code || null,
          subtotal_cents: br.subtotal_cents || null,
          source: 'slice_a_booking_create',
        }),
      ],
    );
    inserted.push(r.rows[0]);
  }
  return inserted;
}

/**
 * Map selected bed codes to guest numbers (order preserved).
 */
function mapBedAssignmentsToGuests(selectedBedCodes, roomCodesByBed) {
  return (selectedBedCodes || []).map((bedCode, idx) => ({
    guest_number: idx + 1,
    bed_code: String(bedCode),
    room_code: roomCodesByBed && roomCodesByBed[bedCode] ? roomCodesByBed[bedCode] : null,
  }));
}

function buildGuestPaymentShortLinkPath(bookingCode, guestNumber) {
  const code = trimStr(bookingCode).toUpperCase();
  const n = parseInt(guestNumber, 10);
  if (!code || !Number.isInteger(n) || n < 1) return null;
  return `${code}/g${n}`;
}

function parseGuestPaymentShortLinkToken(token) {
  const raw = trimStr(token);
  const m = /^(.+)\/g(\d+)$/i.exec(raw);
  if (!m) return { ok: false };
  return {
    ok: true,
    booking_code: m[1].toUpperCase(),
    guest_number: parseInt(m[2], 10),
  };
}

function guestPaymentStatusFromRow(row) {
  if (!row) return 'unknown';
  const st = trimStr(row.payment_status).toLowerCase();
  if (st === 'paid' || Number(row.amount_paid_cents || 0) > 0) return 'paid';
  if (st === 'checkout_created') return 'checkout_created';
  if (st === 'draft') return 'draft';
  return st || 'not_requested';
}

module.exports = {
  KNOWN_PACKAGES,
  PACKAGE_PREVIEW_CODES,
  normalizeBookingGuestsInput,
  normalizeBotBookingPaymentChoice,
  mapBotBookingCreateErrorToBlockedReason,
  computeGuestDepositTierCents,
  buildPerGuestDepositList,
  buildPerPersonBreakdown,
  computePackagePricePreview,
  insertBookingGuestsForBooking,
  mapBedAssignmentsToGuests,
  buildGuestPaymentShortLinkPath,
  parseGuestPaymentShortLinkToken,
  guestPaymentStatusFromRow,
  isMissingBookingGuestsTable,
  BOOKING_GUESTS_SELECT_SQL,
  splitCentsAcrossGuests,
};
