'use strict';

/**
 * Slice A — Per-guest booking & payments helpers.
 * Pure normalization + breakdown builders; DB insert helpers accept a pg client.
 */

const { calculateWolfhouseQuote, loadConfig, catalogPackageCodes } = require('./wolfhouse-quote-calculator');
const { computeStayNights, evaluatePackageEligibility } = require('./wolfhouse-package-night-rules');

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
  // Every booking uses the per-guest model, even when only a single primary name
  // + guest_count were supplied (placeholder per-guest names above). This keeps
  // deposits per guest and lets per-guest deposit links be issued for any booking.
  return {
    ok: true,
    guests,
    primary_name: fallbackName,
    guest_count: count,
    uses_per_guest_model: true,
  };
}

function isCatalogPackageCode(code, config) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return false;
  const pkgs = config && Array.isArray(config.packages) ? config.packages : [];
  return pkgs.some((p) => String(p && p.code || '').trim().toLowerCase() === c);
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
function packageInclusions(config, code) {
  const row = (config.packages || []).find((pkg) => pkg && String(pkg.code || '').trim().toLowerCase() === code);
  if (!row || !Array.isArray(row.inclusions)) return null;
  return row.inclusions.slice();
}

function accommodationPhrase(roomType, nights) {
  const stay = nights === 1
    ? '1 night'
    : (Number.isInteger(nights) && nights > 1 ? `${nights} nights` : null);
  if (!stay) return null;
  if (roomType === 'shared') return `${stay} in a dorm bed`;
  if (roomType === 'private') return `${stay} in a private room`;
  if (roomType === 'double') return `${stay} in a double room`;
  return `${stay} of accommodation`;
}

function plainIncludesLine(inclusions, nights, roomType) {
  if (!Array.isArray(inclusions) || inclusions.length === 0) return null;
  const labels = {
    shared_room: accommodationPhrase(roomType, nights),
    shirt: 'T-shirt',
    surfboard_6_days: 'surfboard',
    wetsuit_6_days: 'wetsuit',
    surf_lesson_each_day_6_days: 'surf lessons',
  };
  if (inclusions.some((code) => !Object.prototype.hasOwnProperty.call(labels, code) || !labels[code])) return null;
  const boardAndSuit = inclusions.includes('surfboard_6_days') && inclusions.includes('wetsuit_6_days');
  const parts = [];
  for (const code of inclusions) {
    if (boardAndSuit && code === 'wetsuit_6_days') continue;
    parts.push(boardAndSuit && code === 'surfboard_6_days' ? 'board + wetsuit' : labels[code]);
  }
  return parts.length ? `Includes: ${parts.join(', ')}` : null;
}

function withRealInclusions(row, config, code, nights, roomType) {
  const inclusions = packageInclusions(config, code);
  if (!inclusions) return row;
  const line = plainIncludesLine(inclusions, nights, roomType);
  return line ? { ...row, inclusions, includes_line: line } : { ...row, inclusions };
}
function computePackagePricePreview(input, config) {
  config = config === undefined ? loadConfig() : (config || {});
  const clientSlug = trimStr(input.client_slug) || config.client_slug;
  const checkIn = trimStr(input.check_in);
  const checkOut = trimStr(input.check_out);
  const guestCount = Math.max(1, parseInt(input.guest_count, 10) || 1);
  const roomType = trimStr(input.room_type) || 'shared';

  const packages = {};
  let season_code = null;
  let nights = computeStayNights(checkIn, checkOut);
  const eligibility = evaluatePackageEligibility(nights, config);

  const codes = catalogPackageCodes(config);
  for (const code of eligibility.package_eligible ? codes : []) {
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
      packages[code] = withRealInclusions({ success: false, blockers: quote.blockers || [] }, config, code, nights, quote.room_type);
      continue;
    }
    const depositPerGuest = quote.per_guest_deposits[0].deposit_cents;
    packages[code] = {
      success: true,
      total_cents: quote.total_cents,
      per_person_cents: Math.round(quote.total_cents / guestCount),
      deposit_per_guest_cents: depositPerGuest,
      deposit_total_cents: quote.deposit_required_cents,
      currency: quote.currency,
      nights: quote.nights,
      season_code: quote.season_code,
    };
    packages[code] = withRealInclusions(packages[code], config, code, quote.nights, quote.room_type);
  }

  return {
    success: eligibility.package_eligible && Object.values(packages).some((p) => p.success),
    ...eligibility,
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
                 assigned_room_code, assigned_bed_code,
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

/**
 * Read-only invoice attribution, NOT a payer identity or collection authority.
 * Guest-linked receipts stay with that guest. Booking receipts are displayed
 * across guests without rewriting the ledger or the stored guest paid cache.
 * Input payments are the same tenant/booking/display-eligible ledger as totals.
 */
function projectGuestInvoicePayments(guestRows, paymentRows, perPerson = []) {
  if (!guestRows.length) return guestRows;
  const rows = guestRows.map(row => ({ ...row, invoice_paid_cents: 0, invoice_booking_credit_cents: 0 }));
  const byId = new Map(rows.map(row => [row.booking_guest_id, row]));
  let credit = 0;
  for (const payment of paymentRows) {
    if (String(payment.payment_status || '').toLowerCase() !== 'paid') continue;
    const paid = Number(payment.amount_paid_cents || 0);
    if (!Number.isSafeInteger(paid) || paid < 0) throw new Error('invalid_invoice_payment_amount');
    const guest = byId.get(payment.booking_guest_id);
    if (guest) guest.invoice_paid_cents += paid;
    else credit += paid;
  }
  const shares = rows.map(row => {
    let md = row.metadata || {};
    if (typeof md === 'string') { try { md = JSON.parse(md) || {}; } catch (_) { md = {}; } }
    const quoted = (perPerson || []).find(p => Number(p.guest_number) === Number(row.guest_number));
    const raw = row.subtotal_cents ?? md.subtotal_cents ?? (quoted && quoted.subtotal_cents);
    return raw != null && Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  });
  // Largest remainder, with a stable guest-number tie break. BigInt products
  // preserve exact cents even when amount * weight exceeds Number precision.
  function distribute(amount, weights) {
    if (!amount) return;
    if (!Number.isSafeInteger(amount)) throw new Error('invalid_invoice_payment_amount');
    if (!weights.some(n => n > 0)) weights = rows.map(() => 1);
    const sum = weights.reduce((s,n) => s + BigInt(n), 0n);
    const parts = weights.map((weight,i) => {
      const product = BigInt(amount) * BigInt(weight);
      return { i, cents: Number(product / sum), remainder: product % sum };
    });
    let left = amount - parts.reduce((s,p) => s + p.cents, 0);
    const order = parts.slice().sort((a,b) => a.remainder !== b.remainder
      ? (a.remainder > b.remainder ? -1 : 1)
      : Number(rows[a.i].guest_number) - Number(rows[b.i].guest_number));
    for (const part of order) { if (left <= 0) break; part.cents++; left--; }
    parts.forEach(part => { rows[part.i].invoice_booking_credit_cents += part.cents; });
  }
  // First cover outstanding shares; do not dilute an already-paid guest's
  // linked receipt. Any genuine overpayment remains visible rather than lost.
  if (shares.every(share => share != null)) {
    const remaining = shares.map((share,i) => Math.max(0,share - rows[i].invoice_paid_cents));
    const covered = Math.min(credit,remaining.reduce((s,n) => s+n,0));
    distribute(covered,remaining);
    distribute(credit-covered,shares);
  } else {
    // Legacy rows without authoritative shares: equal presentation only.
    distribute(credit,rows.map(() => 1));
  }
  rows.forEach(row => {
    row.invoice_paid_cents += row.invoice_booking_credit_cents;
    if (!Number.isSafeInteger(row.invoice_paid_cents)) throw new Error('invalid_invoice_payment_amount');
  });
  return rows;
}

function guestPaymentStatusFromRow(row) {
  if (!row) return 'unknown';
  const st = trimStr(row.payment_status).toLowerCase();
  if (st === 'paid' || Number(row.amount_paid_cents || 0) > 0) return 'paid';
  if (st === 'checkout_created') return 'checkout_created';
  if (st === 'draft') return 'draft';
  return st || 'not_requested';
}

const OFFER_HTTP_NEXT_ACTION = Object.freeze({
  offer_identity_required: 'clarify_offer',
  offer_unchecked: 're_quote',
  offer_terms_changed: 're_quote',
  availability_changed: 're_quote',
  write_recovery_required: 'recover_write',
  idempotency_payload_mismatch: 'clarify_offer',
  booking_policy_wrong_tenant: 'respect_portal_policy',
  booking_context_unbound: 'respect_portal_policy',
  booking_global_paused: 'respect_portal_policy',
  booking_conversation_paused: 'respect_portal_policy',
  booking_needs_human: 'respect_portal_policy',
  booking_channel_off: 'respect_portal_policy',
  booking_channel_draft: 'respect_portal_policy',
  booking_policy_unavailable: 'retry_policy_lookup',
  booking_tenant_unconfigured: 'retry_policy_lookup',
  booking_channel_unconfigured: 'retry_policy_lookup',
  booking_channel_invalid: 'retry_policy_lookup',
});

function mapBotBookingCreateBlockedHttp(row, status) {
  const src = row && typeof row === 'object' ? row : {};
  const reason = src.reason_code || src.block_reason;
  const nextAction = OFFER_HTTP_NEXT_ACTION[reason];
  if (!nextAction) return null;
  return {
    status: status || src.status || 409,
    body: {
      success: false,
      blocked: true,
      reason_code: reason,
      policy_source: src.policy_source || null,
      booking_allowed: false,
      policy_unavailable: nextAction === 'retry_policy_lookup',
      detail: src.detail || null,
      error: src.error || 'The booking was not created.',
      write_performed: false,
      no_write_performed: true,
      creates_booking: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
      staff_review_needed: false,
      do_not_escalate: true,
      next_action: nextAction,
    },
  };
}

module.exports = {
  KNOWN_PACKAGES,
  PACKAGE_PREVIEW_CODES,
  normalizeBookingGuestsInput,
  normalizeBotBookingPaymentChoice,
  mapBotBookingCreateErrorToBlockedReason,
  mapBotBookingCreateBlockedHttp,
  buildPerPersonBreakdown,
  computePackagePricePreview,
  insertBookingGuestsForBooking,
  mapBedAssignmentsToGuests,
  buildGuestPaymentShortLinkPath,
  parseGuestPaymentShortLinkToken,
  guestPaymentStatusFromRow,
  projectGuestInvoicePayments,
  isMissingBookingGuestsTable,
  BOOKING_GUESTS_SELECT_SQL,
  splitCentsAcrossGuests,
};
