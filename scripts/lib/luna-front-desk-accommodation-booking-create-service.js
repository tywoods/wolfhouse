'use strict';

/**
 * Luna Front Desk — canonical Wolfhouse accommodation booking-create service.
 *
 * Single write use case shared by Staff manual booking create and Luna bot
 * booking create. Routes authenticate, apply transport-only gates, build a
 * trusted command, call executeWolfhouseBookingCreate, and map the HTTP response.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §14.
 */

const crypto = require('crypto');
const { WOLFHOUSE_CLIENT_SLUG, rejectSurfSchoolTransportFields } = require('./wolfhouse-accommodation-application');
const { calculateWolfhouseQuote, loadConfig } = require('./wolfhouse-quote-calculator');
const wolfhousePricingStore = require('./wolfhouse-pricing-store');
const { applyOverlayRentalPricesToConfig, applyOverlayPackageItemsToConfig } = require('./wolfhouse-pricing-resolve');
const { validateStaffPackageNightRule } = require('./wolfhouse-package-night-rules');
const { validateAndNormalizeQuoteAddOns } = require('./guest-addon-pricing');
const { resolveQuoteRoomTypeFromPreference } = require('./wolfhouse-room-options');
const {
  resolveBotBookingPackageContext,
  normalizeGuestPackagesInput,
  guestPackagesMajorityStorageCode,
} = require('./bot-booking-package-normalize');
const {
  normalizeBookingGuestsInput,
  normalizeBotBookingPaymentChoice,
  buildPerPersonBreakdown,
  insertBookingGuestsForBooking,
  isMissingBookingGuestsTable,
} = require('./booking-guests');
const { buildManualBookingCreateSql, MANUAL_BOOKING_ALLOWED_ROLES } = require('./staff-manual-booking-create-sql');
const {
  normalizeManualBookingStaffPaymentChoice,
  manualBookingQuotePaymentChoice,
  manualBookingPaymentKindForStaffChoice,
  manualBookingAmountDueForStaffChoice,
  resolveManualBookingPaidAmountCents,
  manualBookingBookingPaymentStatusForCreate,
  manualBookingApplyStaffPaymentChoice,
  isManualBookingDepositChoice,
} = require('./staff-manual-booking-payment');
const {
  buildManualBookingServiceRecordRows,
  tryInsertManualBookingServiceRecords,
} = require('./manual-booking-service-records');
const { createOrMergeManualCustomer } = require('./staff-customer-queries');
const { runLunaGuestBookingDryRun } = require('./luna-guest-booking-dry-run');
const {
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  validateAvailabilityProvenanceForCreate,
  packagePolicyRecheckFailure,
  buildAvailabilityRecheckCommandFromBooking,
  compareAcceptedWolfhouseOffer,
  currentWolfhouseOfferFromCreateCommand,
  rereadWolfhouseOfferForCommit,
  AVAILABILITY_CHANNELS,
} = require('./luna-front-desk-accommodation-availability-service');
const { validateExplicitBedSelection, rejectIncompatiblePreselectedBeds } = require('./luna-bed-allocator');
const { getBedCalendarRoomsQuery, getBedCalendarBlocksQuery } = require('./staff-bed-calendar-queries');
const { resolveBedCalendarRoomRows } = require('./wolfhouse-inventory-source');

const BOOKING_CREATE_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
});

// Shared by direct service/vertical callers that already own a PG connection.
// Read failures retain price fallback but never revive stale package eligibility.
async function loadBookingQuoteConfigWithOverlay(pg) {
  const base = loadConfig();
  try {
    if (!pg) return { ...base, package_min_nights: null };
    // Tables belong to migrations/Admin writes, never a quote or preflight read.
    const rules = await wolfhousePricingStore.loadRules(pg, WOLFHOUSE_CLIENT_SLUG);
    const items = await wolfhousePricingStore.loadItems(pg, WOLFHOUSE_CLIENT_SLUG);
    return applyOverlayPackageItemsToConfig(applyOverlayRentalPricesToConfig(base, rules), items);
  } catch (_err) {
    return { ...base, package_min_nights: null };
  }
}

const SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

const ACCOMMODATION_CLIENT_MONEY_FIELDS = Object.freeze([
  'total_cents',
  'deposit_required_cents',
  'balance_due_cents',
  'payment_link_amount_cents',
  'deposit_amount_cents',
  'total_amount_cents',
  'amount_due_cents',
  'amount_paid_cents',
  'paid_amount_cents',
  'subtotal_cents',
  'discount_cents',
]);

function rejectClientSuppliedMoney(transportBody) {
  const body = transportBody && typeof transportBody === 'object' ? transportBody : {};
  for (const key of ACCOMMODATION_CLIENT_MONEY_FIELDS) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
      return { ok: false, reason: 'client_money_rejected', field: key };
    }
  }
  if (body.quote && typeof body.quote === 'object') {
    for (const key of ACCOMMODATION_CLIENT_MONEY_FIELDS) {
      if (body.quote[key] !== undefined && body.quote[key] !== null && body.quote[key] !== '') {
        return { ok: false, reason: 'client_money_rejected', field: `quote.${key}` };
      }
    }
  }
  return { ok: true };
}

function fail(status, reasonCode, error, extra = {}) {
  return {
    ok: false,
    status,
    body: {
      success: false,
      reason_code: reasonCode,
      error: error || reasonCode,
      ...extra,
    },
  };
}

function roomMismatchFail(reasonCode, extra = {}) {
  return fail(409, reasonCode, 'That room would not work for this booking. A mixed or shared dorm would — which would you like?', {
    needs_clarification: true,
    needs_human: false,
    do_not_escalate: true,
    staff_review_needed: false,
    selected_bed_codes: [],
    ...extra,
  });
}

async function loadPolicyBedRows(pg, clientSlug) {
  if (!pg) return [];
  const bedsRes = await pg.query(getBedCalendarRoomsQuery(), [clientSlug]);
  return resolveBedCalendarRoomRows(clientSlug, (bedsRes && bedsRes.rows) || []);
}

function rejectUnsafeAssignedBeds(assignedBedCodes, bedRows, groupGender) {
  const rejected = rejectIncompatiblePreselectedBeds({
    selectedBedCodes: assignedBedCodes,
    bedRows,
    groupGender,
  });
  if (!rejected.ok) return rejected;
  const gender = String(groupGender || '').trim().toLowerCase();
  if (gender !== 'male' && gender !== 'female') return { ok: true, bed_codes: [] };
  const known = new Set((bedRows || []).map((row) => row && row.bed_code).filter(Boolean));
  const unknown = (assignedBedCodes || []).filter((code) => code && !known.has(code));
  if (unknown.length) return { ok: false, reason: 'incompatible_preselected_beds', bed_codes: unknown };
  return { ok: true, bed_codes: [] };
}

async function rejectCreateIfBedsConflict(pg, clientSlug, assignedBedCodes, groupGender) {
  const gender = String(groupGender || '').trim().toLowerCase();
  if (!pg || (gender !== 'male' && gender !== 'female')) return null;
  const policyBeds = await loadPolicyBedRows(pg, clientSlug);
  const rejected = rejectUnsafeAssignedBeds(assignedBedCodes, policyBeds, gender);
  if (!rejected.ok) {
    return roomMismatchFail('incompatible_preselected_beds', { conflict_beds: rejected.bed_codes });
  }
  return null;
}

async function checkExplicitSelection(pg, clientSlug, codes, guestCount, body, checkIn, checkOut) {
  if (!pg) return fail(500, 'database_required', 'Database required to validate selected beds');
  try {
    // Do not enrich explicit selections from CSV: removed/inactive DB inventory must fail closed.
    const beds = await pg.query(getBedCalendarRoomsQuery(), [clientSlug]);
    const blocks = await pg.query(getBedCalendarBlocksQuery(), [clientSlug, checkIn, checkOut]);
    const validation = validateExplicitBedSelection({ selectedBedCodes: codes, guestCount, body,
      bedRows: beds.rows, blockRows: blocks.rows });
    if (!validation.ok) return fail(409, validation.reason,
      'The selected beds could not be confirmed. Please refresh the room options.', {
        conflict_beds: validation.bed_codes, needs_clarification: true, needs_human: false,
        // Keep this typed error out of the handler's generic SQL _blocked mapper.
        do_not_escalate: true, staff_review_needed: false, write_performed: false,
        selected_bed_codes: [],
      });
    const wanted = new Set(codes.map(String));
    return {
      ok: true,
      roomRows: (beds.rows || []).filter((row) => row && wanted.has(String(row.bed_code))),
    };
  } catch (_err) {
    return fail(503, 'availability_recheck_failed', 'Selected beds could not be verified', { write_performed: false });
  }
  return null;
}

async function ensureManualBookingCustomerLink(pg, command, bookingId) {
  if (!pg || !command || command.channel !== BOOKING_CREATE_CHANNELS.MANUAL_STAFF || !bookingId) {
    return null;
  }
  if (!command.phone) return null;
  const customerResult = await createOrMergeManualCustomer(pg, command.clientSlug, {
    display_name: command.guestName,
    phone: command.phone,
    email: command.email || undefined,
  });
  if (!customerResult || !customerResult.ok || !customerResult.body || !customerResult.body.customer_id) {
    throw Object.assign(new Error('customer_link_failed'), {
      reason_code: 'customer_link_failed',
      customerLinkFailed: true,
    });
  }
  const customerId = customerResult.body.customer_id;
  await pg.query(
    `UPDATE bookings
        SET customer_id = $3::uuid,
            updated_at = NOW()
      WHERE id = $1::uuid
        AND client_id = (SELECT id FROM clients WHERE slug = $2 LIMIT 1)
        AND (customer_id IS NULL OR customer_id = $3::uuid)`,
    [bookingId, command.clientSlug, customerId],
  );
  return {
    customer_id: customerId,
    phone: customerResult.body.phone || command.phone,
    created: customerResult.body.created === true,
    duplicate: customerResult.body.duplicate === true,
  };
}

function resolveActorForChannel(channel, actorHints) {
  const hints = actorHints && typeof actorHints === 'object' ? actorHints : {};
  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    return {
      staff_user_id: hints.staff_user_id || 'luna-bot-internal',
      staff_role: hints.staff_role || 'operator',
      source: hints.source || 'luna_whatsapp',
    };
  }
  if (channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF) {
    return {
      staff_user_id: hints.staff_user_id || 'manual-booking-local',
      staff_role: hints.staff_role || 'operator',
      email: hints.email || null,
    };
  }
  return null;
}

function parseSelectedBedCodes(body) {
  let rawBedCodes = body.selected_bed_codes;
  if (typeof rawBedCodes === 'string') {
    rawBedCodes = rawBedCodes.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (!Array.isArray(rawBedCodes)) {
    rawBedCodes = [];
  }
  return rawBedCodes.map(String);
}

function buildIdempotencyKey(channel, fields) {
  const prefix = channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF ? 'mb-' : 'bot-';
  if (fields.idempotencyKey) return String(fields.idempotencyKey).slice(0, 120);
  return prefix + crypto.createHash('md5').update([
    fields.clientSlug,
    fields.checkIn,
    fields.checkOut,
    fields.assignedBedCodes.slice().sort().join('_'),
    fields.guestName.toLowerCase(),
    fields.phone || '',
  ].join('|')).digest('hex');
}

/**
 * Build a trusted Wolfhouse accommodation booking-create command.
 *
 * When confirm !== true (or dry_run / preview_only), returns a dry-run body
 * instead of a command. Bot bed auto-assign requires opts.pgClient.
 */
async function buildWolfhouseBookingCreateCommand(opts) {
  const channel = String((opts && opts.channel) || '').trim();
  if (!Object.values(BOOKING_CREATE_CHANNELS).includes(channel)) {
    return fail(400, 'invalid_channel', 'invalid booking create channel');
  }

  const trustedClientSlug = String((opts && opts.trustedClientSlug) || '').trim();
  if (trustedClientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return fail(403, 'tenant_mismatch', 'unsupported_client', { client_slug: trustedClientSlug });
  }

  const transportBody = (opts && opts.transportBody) || {};
  const surfReject = rejectSurfSchoolTransportFields(transportBody);
  if (!surfReject.ok) return surfReject;

  const moneyReject = rejectClientSuppliedMoney(transportBody);
  if (!moneyReject.ok) {
    return fail(422, moneyReject.reason, `Client-supplied money field rejected: ${moneyReject.field}`, {
      field: moneyReject.field,
    });
  }

  const actor = resolveActorForChannel(channel, opts && opts.actorHints);
  if (!actor) return fail(400, 'invalid_channel', 'invalid booking create channel');

  const dryRunRequested = transportBody.dry_run === true
    || transportBody.preview_only === true
    || transportBody.confirm !== true
    || opts.dryRunOnly === true;

  if (dryRunRequested) {
    const dryRun = await runLunaGuestBookingDryRun({
      ...transportBody,
      client_slug: WOLFHOUSE_CLIENT_SLUG,
    }, { pg: opts && opts.pgClient, quoteConfig: opts.quoteConfig });
    return { ok: true, status: 200, dryRun: true, body: dryRun };
  }

  const body = transportBody;
  const clientSlug = WOLFHOUSE_CLIENT_SLUG;
  const checkIn = String(body.check_in || '').trim();
  const checkOut = String(body.check_out || '').trim();
  const guestCount = parseInt(body.guest_count, 10) || 0;

  const guestsNorm = normalizeBookingGuestsInput(body);
  if (!guestsNorm.ok) return fail(400, 'invalid_guests', guestsNorm.error);

  const guestName = (String(body.guest_name || '').trim() || guestsNorm.primary_name || '').slice(0, 200);
  const usesPerGuestModel = guestsNorm.uses_per_guest_model === true;
  const resolvedGuestCount = guestsNorm.guest_count || guestCount;
  const effectiveGuestCount = resolvedGuestCount > 0 ? resolvedGuestCount : guestCount;
  const quoteGuestCount = effectiveGuestCount > 0 ? effectiveGuestCount : guestCount;

  const phone = String(body.phone || body.guest_phone || '').trim().slice(0, 50);
  const email = String(body.email || '').trim().slice(0, 200) || null;
  const language = String(body.language || 'en').trim().slice(0, 10);
  const roomPreference = String(body.room_preference || '').trim().slice(0, 200) || null;
  const genderPreference = body.gender_preference ? String(body.gender_preference).trim().slice(0, 50) : null;
  const notes = String(body.notes || '').trim().slice(0, 2000) || null;
  const confirmFlag = body.confirm === true;
  const warningsAcknowledged = body.warnings_acknowledged === true;
  const bookingCode = body.booking_code ? String(body.booking_code).trim().slice(0, 60) : null;

  if (SQL_INJECT_RE.test(clientSlug)) return fail(400, 'invalid_client', 'invalid client slug');
  if (!checkIn || !checkOut) return fail(400, 'missing_dates', 'check_in and check_out are required (YYYY-MM-DD)');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    return fail(400, 'invalid_dates', 'check_in and check_out must be YYYY-MM-DD');
  }
  if (checkOut <= checkIn) return fail(400, 'invalid_dates', 'check_out must be after check_in');
  if (!guestName) return fail(400, 'missing_guest_name', 'guest_name is required');
  if (effectiveGuestCount < 1 && guestCount < 1) return fail(400, 'invalid_guest_count', 'guest_count must be at least 1');
  if (!confirmFlag) return fail(400, 'confirm_required', 'confirm: true is required in request body');

  const rawGuestPackages = Array.isArray(body.guest_packages) ? body.guest_packages : [];
  const packageCodeRaw = String(body.package_code || body.package_or_stay_type || '').trim().toLowerCase().slice(0, 50) || null;
  const quoteConfig = opts.quoteConfig !== undefined
    ? opts.quoteConfig
    : await loadBookingQuoteConfigWithOverlay(opts.pgClient);

  let guestPackages = [];
  let effectivePackageCode;
  let storagePackageCode;
  let guestPackagesForQuote;
  let pkgCtx;

  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    if (!phone) return fail(400, 'missing_phone', 'phone is required');
    const normalizedGuestPackages = rawGuestPackages.length
      ? normalizeGuestPackagesInput(rawGuestPackages, effectiveGuestCount || rawGuestPackages.length, packageCodeRaw || 'malibu')
      : { guest_packages: [] };
    if (normalizedGuestPackages.error) return fail(400, 'invalid_guest_packages', normalizedGuestPackages.error);
    guestPackages = normalizedGuestPackages.guest_packages || [];
    pkgCtx = resolveBotBookingPackageContext({
      packageCode: packageCodeRaw,
      guestPackages,
      checkIn,
      checkOut,
      guestCount: effectiveGuestCount || guestCount,
      config: quoteConfig,
    });
    effectivePackageCode = pkgCtx.quotePackageCode;
    storagePackageCode = pkgCtx.storagePackageCode;
    guestPackagesForQuote = pkgCtx.guestPackagesForQuote;
  } else {
    const normalizedGuestPackages = rawGuestPackages.length
      ? normalizeGuestPackagesInput(rawGuestPackages, effectiveGuestCount || rawGuestPackages.length, packageCodeRaw || 'malibu')
      : { guest_packages: [] };
    if (normalizedGuestPackages.error) return fail(400, 'invalid_guest_packages', normalizedGuestPackages.error);
    guestPackages = normalizedGuestPackages.guest_packages || [];
    effectivePackageCode = guestPackages.length
      ? (guestPackagesMajorityStorageCode(guestPackages) || packageCodeRaw || 'package_none')
      : packageCodeRaw;
    storagePackageCode = (!packageCodeRaw || packageCodeRaw === 'package_none' || packageCodeRaw === 'no_package')
      ? null
      : packageCodeRaw;
    guestPackagesForQuote = guestPackages.length ? guestPackages : undefined;
    pkgCtx = resolveBotBookingPackageContext({
      packageCode: effectivePackageCode,
      guestPackages,
      checkIn,
      checkOut,
      guestCount: effectiveGuestCount || guestCount,
      config: quoteConfig,
    });
  }

  const roomType = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
    ? resolveQuoteRoomTypeFromPreference(body.room_type, body.room_preference)
    : (String(body.room_type || 'shared').trim().slice(0, 20) || 'shared');

  if (!effectivePackageCode || effectivePackageCode === 'manual_override') {
    return fail(400, 'missing_package', 'package_code or guest_packages is required (use package_none for accommodation-only / short stays)');
  }

  const selectedPackageCodes = guestPackages.length
    ? guestPackages.map((guest) => guest.package_code)
    : [packageCodeRaw || effectivePackageCode];
  for (const code of selectedPackageCodes) {
    const packageNightCheck = validateStaffPackageNightRule(checkIn, checkOut, code, quoteConfig);
    if (!packageNightCheck.ok) {
      return fail(400, packageNightCheck.reason_code || 'package_min_nights_violation', packageNightCheck.error, {
        package_night_violation: packageNightCheck,
        package_min_nights: packageNightCheck.package_min_nights,
        package_eligible: false,
        write_performed: false,
        blocked_reasons: [packageNightCheck.reason_code],
        next_action: 'offer_accommodation_or_change_dates',
        staff_review_needed: false,
        do_not_escalate: true,
        guest_safe_next_action: 'Offer accommodation only or ask for different dates; do not change the selected package without consent.',
        reply_draft: packageNightCheck.package_min_nights == null
          ? 'I can’t confirm package eligibility right now. Would you like accommodation only?'
          : `Packages need at least ${packageNightCheck.package_min_nights} nights. Would you prefer accommodation only or different dates?`,
      });
    }
  }

  const addOnPrep = validateAndNormalizeQuoteAddOns(
    Array.isArray(body.add_ons) ? body.add_ons : [],
    quoteGuestCount,
  );
  if (!addOnPrep.ok) return fail(400, 'invalid_add_ons', addOnPrep.error);
  const addOns = addOnPrep.add_ons;

  let paymentChoice;
  let staffPayChoice;
  let perGuestPaymentLinks = false;
  let quotePaymentChoice;
  let paymentKind;
  let paymentStatus;
  let sqlDepositCents;
  let prePaidCents = 0;
  let paidAmountType = 'deposit';
  let paidAmountCustomCents = null;
  let manualPricePerNightCents = null;

  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    const paymentNorm = normalizeBotBookingPaymentChoice(body.payment_choice);
    paymentChoice = paymentNorm.payment_choice;
    perGuestPaymentLinks = paymentNorm.per_guest_payment_links === true;
    if (!paymentChoice) return fail(400, 'missing_payment_choice', 'payment_choice is required (deposit or full)');
    quotePaymentChoice = paymentChoice;
    paymentKind = paymentChoice === 'full' ? 'full_amount' : 'deposit_only';
    paymentStatus = 'not_requested';
    sqlDepositCents = null; // set after quote
  } else {
    staffPayChoice = normalizeManualBookingStaffPaymentChoice(body.payment_choice);
    if (!staffPayChoice) {
      return fail(400, 'invalid_payment_choice', 'payment_choice must be one of: stripe_deposit, stripe_deposit_per_guest, stripe_full, paid_cash, paid_bank_transfer, no_payment_yet');
    }
    perGuestPaymentLinks = staffPayChoice === 'stripe_deposit_per_guest';
    quotePaymentChoice = manualBookingQuotePaymentChoice(staffPayChoice);
    paymentKind = manualBookingPaymentKindForStaffChoice(staffPayChoice);
    paidAmountType = String(body.paid_amount_type || 'deposit').trim().toLowerCase();
    paidAmountCustomCents = body.paid_amount_cents != null
      ? Math.floor(Number(body.paid_amount_cents))
      : (body.paid_amount_euros != null ? Math.round(Number(body.paid_amount_euros) * 100) : null);
    if (staffPayChoice === 'paid_cash' || staffPayChoice === 'paid_bank_transfer') {
      if (!['deposit', 'full', 'custom'].includes(paidAmountType)) {
        return fail(400, 'invalid_paid_amount_type', 'paid_amount_type must be deposit, full, or custom for cash/bank payment');
      }
      if (paidAmountType === 'custom' && (!paidAmountCustomCents || paidAmountCustomCents <= 0)) {
        return fail(400, 'invalid_paid_amount', 'paid_amount_cents (or paid_amount_euros) is required when paid_amount_type is custom');
      }
    }
    manualPricePerNightCents = body.manual_price_per_night_cents != null
      ? Math.round(Number(body.manual_price_per_night_cents))
      : (body.manual_price_per_night_euros != null
        ? Math.round(Number(body.manual_price_per_night_euros) * 100)
        : null);
    if (!MANUAL_BOOKING_ALLOWED_ROLES.includes(actor.staff_role)) {
      return fail(403, 'staff_role_insufficient', `Role '${actor.staff_role}' may not create manual bookings.`);
    }
  }

  if (body.selected_bed_codes != null && !Array.isArray(body.selected_bed_codes)
    && typeof body.selected_bed_codes !== 'string') {
    return fail(400, 'invalid_bed_codes', 'selected_bed_codes must be an array or comma-separated string', { needs_human: false });
  }
  // Omitted/null/empty array/blank string means no selection. A nonempty
  // malformed selection must never be normalized into auto-allocation consent.
  const rawCodes = body.selected_bed_codes;
  const rawList = Array.isArray(rawCodes) ? rawCodes
    : (typeof rawCodes === 'string' && rawCodes.trim() ? rawCodes.split(',') : []);
  if (rawList.some(code => typeof code !== 'string' || !code.trim())) {
    return fail(400, 'invalid_bed_codes', 'Each selected bed code must be a nonempty string', { needs_human: false, write_performed: false });
  }
  let assignedBedCodes = parseSelectedBedCodes(body);
  const pg = opts && opts.pgClient;
  if (pg && channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP && body.idempotency_key) {
    const earlySaved = await lookupSavedWolfhouseCreate(pg, clientSlug, String(body.idempotency_key));
    if (earlySaved) {
      const earlyKind = classifySavedWolfhouseCreate(earlySaved, {
        clientSlug,
        channel,
        checkIn,
        checkOut,
        phone,
        paymentChoice,
        perGuestPaymentLinks,
        effectivePackageCode,
        assignedBedCodes,
        guestsNorm,
        transportBody: body,
      });
      if (earlyKind === 'different') {
        return fail(409, 'idempotency_payload_mismatch', 'This idempotency key was already used for a different booking.', {
          write_performed: false,
          creates_booking: false,
          created: false,
          staff_review_needed: false,
          do_not_escalate: true,
          next_action: 'clarify_offer',
          _blocked: true,
        });
      }
      return { ...savedWolfhouseCreateResult(earlySaved), recovered: true };
    }
  }
  let authoritativeRoomRows = [];
  const explicitBedSelection = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP && assignedBedCodes.length > 0;
  if (explicitBedSelection) {
    const selection = await checkExplicitSelection(pg, clientSlug, assignedBedCodes, quoteGuestCount, body, checkIn, checkOut);
    if (selection && selection.ok === false) return selection;
    authoritativeRoomRows = selection && Array.isArray(selection.roomRows) ? selection.roomRows : [];
  }
  const statedGenderEarly = String(body.group_gender || body.explicit_gender || genderPreference || '').trim().toLowerCase();
  if (!explicitBedSelection && assignedBedCodes.length && pg) {
    const preselectedConflict = await rejectCreateIfBedsConflict(pg, clientSlug, assignedBedCodes, statedGenderEarly);
    if (preselectedConflict) return preselectedConflict;
  }
  let availabilityProvenance = null;
  let availabilityPreflightAssignmentMode = false;

  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    // An accepted selection is validated above, not passed back through ranking.
    availabilityPreflightAssignmentMode = assignedBedCodes.length === 0;
    if (assignedBedCodes.length === 0) {
      if (!pg) {
        return fail(500, 'database_required', 'pgClient required for bot bed auto-assignment');
      }
      const availBuilt = buildWolfhouseAvailabilityCommand({
        channel: AVAILABILITY_CHANNELS.BOOKING_PREFLIGHT,
        quoteConfig,
        trustedClientSlug: clientSlug,
        transportBody: {
          ...body,
          check_in: checkIn,
          check_out: checkOut,
          guest_count: quoteGuestCount,
          room_type: roomType,
          package_code: effectivePackageCode,
        },
        demoCalendarEnrichment: true,
        assignmentMode: true,
      });
      if (!availBuilt.ok) {
        if (availBuilt.skipped) {
          return fail(400, 'availability_check_skipped', availBuilt.reason || 'availability_check_skipped');
        }
        return availBuilt;
      }
      const availResult = await executeWolfhouseAvailabilityCheck(pg, availBuilt.command);
      if (!availResult.ok) {
        return fail(availResult.status || 500, 'availability_check_failed', 'Availability check failed');
      }
      const bedAssign = availResult.body;
      availabilityProvenance = bedAssign.provenance || null;
      if (bedAssign && bedAssign.needs_clarification) {
        return roomMismatchFail('needs_clarification', {
          conflict: bedAssign.clarification_conflict || bedAssign.allocation_reason || null,
        });
      }
      if (bedAssign && Array.isArray(bedAssign.selected_bed_codes) && bedAssign.selected_bed_codes.length) {
        assignedBedCodes = bedAssign.selected_bed_codes.map(String).slice(0, 20);
      } else if (bedAssign && bedAssign.blockers && bedAssign.blockers.length) {
        return fail(400, 'bed_assignment_failed', `Bed assignment failed: ${bedAssign.blockers[0]}`);
      } else if (assignedBedCodes.length === 0) {
        return fail(400, 'missing_bed_codes', 'selected_bed_codes is required (pass beds or group_gender for auto-assign)');
      }
    } else if (pg) {
      const preflightBuilt = buildWolfhouseAvailabilityCommand({
        channel: AVAILABILITY_CHANNELS.BOOKING_PREFLIGHT,
        quoteConfig,
        trustedClientSlug: clientSlug,
        transportBody: {
          ...body,
          check_in: checkIn,
          check_out: checkOut,
          guest_count: quoteGuestCount,
          room_type: roomType,
          package_code: effectivePackageCode,
          selected_bed_codes: assignedBedCodes,
        },
        demoCalendarEnrichment: true,
        assignmentMode: false,
      });
      if (preflightBuilt.ok) {
        const preflight = await executeWolfhouseAvailabilityCheck(pg, preflightBuilt.command);
        if (preflight.ok && preflight.body && preflight.body.needs_clarification) {
          return roomMismatchFail('needs_clarification', {
            conflict: preflight.body.clarification_conflict || preflight.body.allocation_reason || null,
          });
        }
        if (preflight.ok) availabilityProvenance = preflight.body.provenance || null;
      }
    }
  } else if (assignedBedCodes.length === 0) {
    return fail(400, 'missing_bed_codes', 'selected_bed_codes is required (select empty calendar cells)');
  } else if (pg) {
    const preflightBuilt = buildWolfhouseAvailabilityCommand({
      channel: AVAILABILITY_CHANNELS.BOOKING_PREFLIGHT,
      trustedClientSlug: clientSlug,
      transportBody: {
        ...body,
        check_in: checkIn,
        check_out: checkOut,
        guest_count: quoteGuestCount,
        room_type: roomType,
        package_code: effectivePackageCode,
        selected_bed_codes: assignedBedCodes,
      },
      demoCalendarEnrichment: true,
      assignmentMode: false,
    });
    if (preflightBuilt.ok) {
      const preflight = await executeWolfhouseAvailabilityCheck(pg, preflightBuilt.command);
      if (preflight.ok && preflight.body && preflight.body.needs_clarification) {
        return roomMismatchFail('needs_clarification', {
          conflict: preflight.body.clarification_conflict || preflight.body.allocation_reason || null,
        });
      }
      if (preflight.ok) availabilityProvenance = preflight.body.provenance || null;
    }
  }

  if (assignedBedCodes.length === 0) {
    return fail(400, 'missing_bed_codes', 'selected_bed_codes is required');
  }
  if (assignedBedCodes.some((c) => SQL_INJECT_RE.test(c))) {
    return fail(400, 'invalid_bed_codes', 'invalid character in selected_bed_codes');
  }

  const statedGender = String(body.group_gender || body.explicit_gender || genderPreference || '').trim().toLowerCase();
  const bedConflict = !explicitBedSelection
    && await rejectCreateIfBedsConflict(pg, clientSlug, assignedBedCodes, statedGender);
  if (bedConflict) return bedConflict;

  const quote = calculateWolfhouseQuote({
    client_slug: clientSlug,
    check_in: checkIn,
    check_out: checkOut,
    guest_count: quoteGuestCount,
    package_code: effectivePackageCode,
    guest_packages: guestPackagesForQuote,
    room_type: roomType,
    payment_choice: quotePaymentChoice,
    add_ons: addOns,
    manual_price_per_night_cents: manualPricePerNightCents,
    uses_per_guest_deposits: usesPerGuestModel,
  }, quoteConfig);
  if (!quote.success || quote.blockers.length > 0) {
    return fail(400, 'quote_failed', 'Quote calculation failed: ' + (quote.blockers[0] || 'check pricing config'));
  }

  const depositCents = quote.deposit_required_cents;
  const totalCents = quote.total_cents;
  const paymentLinkAmountCents = channel === BOOKING_CREATE_CHANNELS.MANUAL_STAFF
    ? (manualBookingAmountDueForStaffChoice(staffPayChoice, depositCents, totalCents) || quote.payment_link_amount_cents)
    : quote.payment_link_amount_cents;

  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    sqlDepositCents = depositCents;
  } else {
    sqlDepositCents = (
      staffPayChoice === 'no_payment_yet'
      || staffPayChoice === 'paid_cash'
      || staffPayChoice === 'paid_bank_transfer'
      || isManualBookingDepositChoice(staffPayChoice)
      || staffPayChoice === 'stripe_full'
    )
      ? 0
      : depositCents;
    prePaidCents = (staffPayChoice === 'paid_cash' || staffPayChoice === 'paid_bank_transfer')
      ? resolveManualBookingPaidAmountCents(depositCents, totalCents, paidAmountType, paidAmountCustomCents)
      : 0;
    paymentStatus = manualBookingBookingPaymentStatusForCreate(staffPayChoice, prePaidCents, totalCents);
  }

  const source = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
    ? String(body.source || 'luna_whatsapp').trim().slice(0, 50)
    : (String(body.source || body.booking_source || 'staff_manual').trim().slice(0, 50) || 'staff_manual');
  const reason = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
    ? String(body.reason || 'Luna bot booking via /staff/bot/bookings/create').trim().slice(0, 500)
    : String(body.reason || 'Manual booking via Staff Portal Bed Calendar').trim().slice(0, 500);

  const idempotencyKey = buildIdempotencyKey(channel, {
    idempotencyKey: body.idempotency_key,
    clientSlug,
    checkIn,
    checkOut,
    assignedBedCodes,
    guestName,
    phone,
  });

  return {
    ok: true,
    command: {
      channel,
      clientSlug,
      transportBody: body,
      actor,
      checkIn,
      checkOut,
      guestName,
      phone,
      email,
      language,
      guestCount,
      quoteGuestCount,
      effectiveGuestCount,
      usesPerGuestModel,
      guestsNorm,
      assignedBedCodes,
      effectivePackageCode,
      storagePackageCode,
      guestPackages,
      guestPackagesForQuote,
      pkgCtx,
      roomType,
      roomPreference,
      genderPreference,
      groupGender: String(body.group_gender || body.explicit_gender || genderPreference || '').trim().toLowerCase() || null,
      addOns,
      quote,
      depositCents,
      totalCents,
      paymentLinkAmountCents,
      paymentChoice,
      staffPayChoice,
      perGuestPaymentLinks,
      quotePaymentChoice,
      paymentKind,
      paymentStatus,
      sqlDepositCents,
      prePaidCents,
      paidAmountType,
      paidAmountCustomCents,
      bookingStatus: 'confirmed',
      source,
      reason,
      notes,
      bookingCode,
      warningsAcknowledged,
      confirmFlag,
      idempotencyKey,
      availabilityProvenance,
      availabilityPreflightAssignmentMode,
      explicitBedSelection,
      requireOfferIdentity: body.require_offer_identity === true,
      authoritativeRoomRows,
      allocationReason: explicitBedSelection
        ? 'explicit_selection'
        : (body.allocation_reason || null),
    },
  };
}

/**
 * Wolfhouse Luna / simulator only. Sunset and manual staff creates are unchanged.
 * Returns a blocked result, or null when this create is not offer-gated.
 */
function lunaCreateOfferGate(command) {
  if (!command || command.clientSlug !== WOLFHOUSE_CLIENT_SLUG) return null;
  if (command.channel !== BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) return null;
  const body = command.transportBody || {};
  const required = command.requireOfferIdentity === true || body.require_offer_identity === true;
  const accepted = body.accepted_offer || command.acceptedOffer || null;
  if (!required && !accepted) return null;
  const decision = compareAcceptedWolfhouseOffer(
    accepted,
    currentWolfhouseOfferFromCreateCommand(command),
  );
  if (decision.ok) return null;
  return {
    ok: false,
    status: decision.status || 409,
    body: {
      ...decision,
      _blocked: true,
    },
  };
}

async function lookupSavedWolfhouseCreate(pg, clientSlug, idempotencyKey) {
  if (!pg || !clientSlug || !idempotencyKey) return null;
  const found = await pg.query(
    `/* offer_idempotency_lookup */
     SELECT bk.id AS booking_id, bk.booking_code, bk.status, bk.metadata,
            bk.check_in::text AS check_in, bk.check_out::text AS check_out,
            bk.guest_name, bk.guest_count, bk.package_code,
            (SELECT p.id FROM payments p WHERE p.booking_id = bk.id ORDER BY p.created_at LIMIT 1) AS payment_id
       FROM bookings bk
       JOIN clients c ON c.id = bk.client_id
      WHERE c.slug = $1
        AND bk.metadata->>'idempotency_key' = $2
      LIMIT 1`,
    [clientSlug, idempotencyKey],
  );
  return found && Array.isArray(found.rows) && found.rows[0] ? found.rows[0] : null;
}

function wolfhouseOperationFingerprint(input) {
  const src = input && typeof input === 'object' ? input : {};
  const body = src.transportBody || src;
  const norm = src.guestsNorm && Array.isArray(src.guestsNorm.guests) ? src.guestsNorm.guests : [];
  const rawGuests = norm.length ? norm : (Array.isArray(body.guests) ? body.guests : []);
  const names = rawGuests.map((guest) => String((guest && (guest.guest_name || guest.name)) || '').trim().toLowerCase()).filter(Boolean);
  const primary = String(src.guestName || body.guest_name || names[0] || '').trim().toLowerCase();
  const beds = (src.assignedBedCodes || body.selected_bed_codes || []).map(String).filter(Boolean).sort();
  const accepted = body.accepted_offer || src.acceptedOffer || null;
  const addOns = (src.addOns || body.add_ons || []).map((item) => {
    if (typeof item === 'string') return item.trim().toLowerCase();
    return String((item && (item.code || item.item_code)) || '').trim().toLowerCase();
  }).filter(Boolean).sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    client_slug: src.clientSlug || body.client_slug || null,
    check_in: src.checkIn || body.check_in || null,
    check_out: src.checkOut || body.check_out || null,
    guest_count: src.quoteGuestCount || src.guestCount || body.guest_count || null,
    guest_name: primary || null,
    guest_names: names,
    phone: src.phone || body.phone || null,
    email: src.email || body.email || null,
    beds,
    room_type: src.roomType || body.room_type || null,
    payment_choice: src.paymentChoice || body.payment_choice || null,
    per_guest_payment_links: src.perGuestPaymentLinks === true || body.per_guest_payment_links === true,
    package_code: src.effectivePackageCode || body.package_code || null,
    add_ons: addOns,
    accepted_offer_fingerprint: accepted && (accepted.offer_fingerprint || accepted.offer_id) || null,
    channel: src.channel || 'luna_whatsapp',
  })).digest('hex');
}

function classifySavedWolfhouseCreate(row, command) {
  const meta = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  if (meta.write_state === 'ambiguous' || row.status === 'pending') return 'ambiguous';
  if (meta.operation_fingerprint) {
    return meta.operation_fingerprint === wolfhouseOperationFingerprint(command) ? 'same' : 'different';
  }
  const body = (command && command.transportBody) || {};
  const checkIn = command && (command.checkIn || body.check_in);
  const checkOut = command && (command.checkOut || body.check_out);
  const guestName = String((command && command.guestName) || body.guest_name || '').trim().toLowerCase();
  const guestCount = command && (command.quoteGuestCount || command.guestCount || body.guest_count);
  if (row.check_in && checkIn && String(row.check_in).slice(0, 10) !== String(checkIn).slice(0, 10)) return 'different';
  if (row.check_out && checkOut && String(row.check_out).slice(0, 10) !== String(checkOut).slice(0, 10)) return 'different';
  if (row.guest_name && guestName && String(row.guest_name).trim().toLowerCase() !== guestName) return 'different';
  if (row.guest_count && guestCount && Number(row.guest_count) !== Number(guestCount)) return 'different';
  if (row.package_code && command && command.effectivePackageCode
    && String(row.package_code) !== String(command.effectivePackageCode)) return 'different';
  if (Array.isArray(meta.selected_bed_codes) && command && Array.isArray(command.assignedBedCodes)) {
    const savedBeds = meta.selected_bed_codes.map(String).sort().join(',');
    const nowBeds = command.assignedBedCodes.map(String).sort().join(',');
    if (savedBeds !== nowBeds) return 'different';
  }
  const proved = !!(row.check_in || row.guest_name || (Array.isArray(meta.selected_bed_codes) && meta.selected_bed_codes.length));
  return proved ? 'same' : 'different';
}

function savedWolfhouseCreateResult(row) {
  const meta = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  if (meta.write_state === 'ambiguous' || row.status === 'pending') {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        reason_code: 'write_recovery_required',
        detail: 'ambiguous_prior_write',
        booking_id: row.booking_id,
        booking_code: row.booking_code,
        write_performed: false,
        creates_booking: false,
        created: false,
        no_write_performed: true,
        staff_review_needed: false,
        do_not_escalate: true,
        next_action: 'recover_write',
      },
    };
  }
  return {
    ok: true,
    status: 200,
    recovered: true,
    body: {
      success: true,
      _duplicate: true,
      duplicate: true,
      idempotent: true,
      created: false,
      write_performed: false,
      creates_booking: false,
      duplicate_booking_id: row.booking_id,
      duplicate_booking_code: row.booking_code,
      booking_id: row.booking_id,
      booking_code: row.booking_code,
      payment_id: row.payment_id || meta.payment_id || null,
      quote: meta.quote_snapshot || null,
      booking_guests: meta.booking_guests || null,
      selected_bed_codes: meta.selected_bed_codes || null,
      response_delivered: meta.response_delivered === true,
      no_write_performed: true,
    },
  };
}

/**
 * Execute accommodation booking create inside caller-managed pg transaction scope.
 */
async function executeWolfhouseBookingCreate(pg, command, execOpts = {}) {
  if (!command || command.clientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return fail(403, 'tenant_mismatch', 'unsupported_client');
  }
  const saved = await lookupSavedWolfhouseCreate(
    pg,
    command.clientSlug,
    command.idempotencyKey || (command.transportBody && command.transportBody.idempotency_key),
  );
  if (saved) {
    const kind = classifySavedWolfhouseCreate(saved, command);
    if (kind === 'different') {
      return fail(409, 'idempotency_payload_mismatch', 'This idempotency key was already used for a different booking.', {
        write_performed: false,
        creates_booking: false,
        created: false,
        staff_review_needed: false,
        do_not_escalate: true,
        next_action: 'clarify_offer',
        _blocked: true,
      });
    }
    return savedWolfhouseCreateResult(saved);
  }
  const offerBlocked = lunaCreateOfferGate(command);
  if (offerBlocked) return offerBlocked;

  const {
    actor,
    channel,
    clientSlug,
    checkIn,
    checkOut,
    guestName,
    phone,
    email,
    language,
    quoteGuestCount,
    guestCount,
    usesPerGuestModel,
    guestsNorm,
    assignedBedCodes,
    storagePackageCode,
    effectivePackageCode,
    guestPackagesForQuote,
    pkgCtx,
    roomType,
    roomPreference,
    genderPreference,
    groupGender,
    addOns,
    guestPackages,
    quote,
    depositCents,
    totalCents,
    paymentLinkAmountCents,
    paymentChoice,
    staffPayChoice,
    perGuestPaymentLinks,
    quotePaymentChoice,
    paymentKind,
    paymentStatus,
    sqlDepositCents,
    prePaidCents,
    paidAmountType,
    paidAmountCustomCents,
    bookingStatus,
    source,
    reason,
    notes,
    bookingCode,
    warningsAcknowledged,
    idempotencyKey,
    availabilityProvenance,
  } = command;

  if (command.explicitBedSelection) {
    const selection = await checkExplicitSelection(pg, clientSlug, assignedBedCodes,
      quoteGuestCount, command.transportBody, checkIn, checkOut);
    if (selection && selection.ok === false) return selection;
  }
  const provCheck = await validateAvailabilityProvenanceForCreate(pg, command, availabilityProvenance);
  if (!provCheck.ok) {
    return {
      ok: false,
      status: provCheck.status || 409,
      body: {
        ...provCheck.body,
        _blocked: true,
      },
    };
  }
  if (!availabilityProvenance) {
    const recheckCmd = buildAvailabilityRecheckCommandFromBooking(command);
    const freshAvail = await executeWolfhouseAvailabilityCheck(pg, recheckCmd);
    if (!freshAvail.ok) {
      return fail(freshAvail.status || 409, 'availability_recheck_failed', 'Availability could not be verified before create');
    }
    const policyFailure = packagePolicyRecheckFailure(freshAvail.body);
    if (policyFailure) return policyFailure;
    const occupied = new Set(freshAvail.body.occupied_bed_codes || []);
    const conflict = assignedBedCodes.filter((code) => occupied.has(code));
    if (conflict.length > 0) {
      return fail(409, 'availability_changed', 'Selected beds are no longer available', {
        conflict_beds: conflict,
        _blocked: true,
      });
    }
  }

  const bedConflict = !command.explicitBedSelection && await rejectCreateIfBedsConflict(
    pg,
    clientSlug,
    assignedBedCodes,
    groupGender || genderPreference,
  );
  if (bedConflict) return bedConflict;

  await pg.query('BEGIN');
  try {
    const offerRequired = command.channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
      && (command.requireOfferIdentity === true
        || (command.transportBody && command.transportBody.require_offer_identity === true));
    if (offerRequired) {
      const freshOffer = await rereadWolfhouseOfferForCommit(pg, command);
      if (!freshOffer.ok) {
        await pg.query('ROLLBACK');
        return {
          ok: false,
          status: freshOffer.status || 409,
          body: {
            ...freshOffer,
            _blocked: true,
            write_performed: false,
            creates_booking: false,
          },
        };
      }
    }
    const r = await pg.query(buildManualBookingCreateSql(), [
      clientSlug,
      actor.staff_user_id,
      actor.staff_role,
      idempotencyKey,
      bookingCode,
      guestName,
      phone,
      email,
      language,
      checkIn,
      checkOut,
      quoteGuestCount,
      assignedBedCodes,
      storagePackageCode,
      channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP ? (roomPreference || roomType) : roomPreference,
      bookingStatus,
      paymentStatus,
      channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP ? depositCents : sqlDepositCents,
      totalCents,
      source,
      reason,
      notes,
      true,
      warningsAcknowledged,
    ]);
    const result = r.rows[0] || null;

    if (!result) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 500, body: { success: false, error: 'no_result_row' } };
    }

    if (result.is_duplicate === true) {
      await pg.query('ROLLBACK');
      return {
        ok: true,
        status: 200,
        body: {
          ...result,
          _duplicate: true,
          assignedBedCodes,
          quote,
        },
      };
    }

    if (result.is_blocked === true) {
      await pg.query('ROLLBACK');
      return {
        ok: false,
        status: result.block_reason === 'overlap_conflict' ? 409 : 422,
        body: {
          ...result,
          _blocked: true,
          assignedBedCodes,
          quote,
        },
      };
    }

    const bedsInserted = Number(result.beds_inserted || 0);
    if (!result.booking_id || bedsInserted < 1 || bedsInserted !== assignedBedCodes.length) {
      await pg.query('ROLLBACK');
      return {
        ok: false,
        status: 409,
        body: {
          ...result,
          _safety_violation: true,
          assignedBedCodes,
          quote,
        },
      };
    }

    const metadataPatch = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
      ? {
        quote_snapshot: quote,
        payment_choice: paymentChoice,
        add_ons_at_create: addOns,
        guest_packages: guestPackagesForQuote,
        package_code: effectivePackageCode,
        accommodation_only: pkgCtx.isNoPackage,
        bot_source: source,
        per_person: quote.per_person || null,
        uses_per_guest_model: usesPerGuestModel,
        per_guest_payment_links: perGuestPaymentLinks,
        operation_fingerprint: wolfhouseOperationFingerprint({
          clientSlug, channel, checkIn, checkOut, phone, paymentChoice,
          perGuestPaymentLinks, effectivePackageCode, assignedBedCodes, guestsNorm,
          transportBody: command.transportBody || {},
        }),
        booking_guests: usesPerGuestModel ? guestsNorm.guests : undefined,
        ...(genderPreference ? { gender_preference: genderPreference } : {}),
      }
      : {
        quote_snapshot: quote,
        payment_choice: staffPayChoice,
        paid_amount_type: paidAmountType,
        add_ons_at_create: addOns,
        guest_packages: guestPackages,
        uses_per_guest_model: usesPerGuestModel,
        per_guest_payment_links: perGuestPaymentLinks,
        booking_guests: usesPerGuestModel ? guestsNorm.guests : undefined,
      };

    await pg.query(
      `UPDATE bookings
         SET total_amount_cents     = $1,
             deposit_required_cents = $2,
             balance_due_cents      = $3,
             requested_room_type    = $4,
             metadata               = metadata || $5::jsonb
       WHERE id = $6
         AND client_id = (SELECT id FROM clients WHERE slug = $7 LIMIT 1)`,
      [
        totalCents,
        depositCents,
        quote.balance_due_cents,
        channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP ? (roomPreference || roomType) : roomType,
        JSON.stringify(metadataPatch),
        result.booking_id,
        clientSlug,
      ],
    );

    const customerLink = await ensureManualBookingCustomerLink(pg, command, result.booking_id);
    if (customerLink) result._customer_link = customerLink;

    if (usesPerGuestModel && guestsNorm.guests.length > 0) {
      try {
        const clientRes = await pg.query(
          'SELECT client_id FROM bookings WHERE id = $1',
          [result.booking_id],
        );
        const bedsRes = await pg.query(
          `SELECT bed_code, room_code
             FROM booking_beds
            WHERE booking_id = $1
            ORDER BY created_at ASC`,
          [result.booking_id],
        );
        // All rows inserted in one statement may share created_at. DB row order
        // must never put a guest into another guest's (possibly gendered) bed.
        const bedByCode = new Map(bedsRes.rows.map(b => [b.bed_code, b]));
        const bedAssignments = assignedBedCodes.map((code, idx) => {
          const bed = bedByCode.get(code);
          if (!bed) throw new Error('Selected bed missing from booking assignment readback');
          return { guest_number: idx + 1, bed_code: code, room_code: bed.room_code };
        });
        const perPersonRows = buildPerPersonBreakdown(quote, {
          guest_names: guestsNorm.guests.map((g) => g.guest_name),
          payment_choice: channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP ? paymentChoice : quotePaymentChoice,
        });
        result._booking_guests = await insertBookingGuestsForBooking(pg, {
          clientId: clientRes.rows[0].client_id,
          bookingId: result.booking_id,
          guests: guestsNorm.guests,
          bedAssignments,
          perPersonBreakdown: perPersonRows,
        });
        result._per_person = perPersonRows;
      } catch (guestErr) {
        if (!isMissingBookingGuestsTable(guestErr)) throw guestErr;
        result._booking_guests_warning = 'booking_guests table not migrated';
      }
    } else {
      result._per_person = quote.per_person || null;
    }

    if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
      const serviceRecordRows = buildManualBookingServiceRecordRows({
        addOns,
        quote,
        clientSlug,
        bookingId: result.booking_id,
        bookingCode: result.booking_code,
        guestName,
        checkIn,
        guestCount,
        source: 'luna_guest',
      });
      const svcInsert = await tryInsertManualBookingServiceRecords(pg, serviceRecordRows);
      result._service_records_created = svcInsert.created;
      result._service_records_available = svcInsert.available;
      result._service_records_warning = svcInsert.warning;

      const pmUpdate = await pg.query(
        `UPDATE payments
           SET payment_kind     = $1::payment_kind,
               amount_due_cents = $2,
               metadata         = metadata || $3::jsonb
         WHERE booking_id = $4
           AND client_id = (SELECT id FROM clients WHERE slug = $5 LIMIT 1)
         RETURNING id AS payment_id`,
        [
          paymentKind,
          paymentLinkAmountCents,
          JSON.stringify({
            payment_choice: paymentChoice,
            quote_total_cents: totalCents,
            payment_link_amount_cents: paymentLinkAmountCents,
            source: 'bot_booking_stage854',
          }),
          result.booking_id,
          clientSlug,
        ],
      );
      result._payment_id = pmUpdate.rows.length > 0 ? pmUpdate.rows[0].payment_id : null;
    } else {
      let payOutcome;
      try {
        const stripeConfig = (execOpts && execOpts.stripeConfig) || {};
        payOutcome = await manualBookingApplyStaffPaymentChoice(pg, {
          staffPaymentChoice: staffPayChoice,
          paidAmountType,
          paidAmountCustomCents,
          paymentId: null,
          bookingId: result.booking_id,
          bookingCode: result.booking_code,
          clientSlug,
          depositCents,
          totalCents,
          actorId: actor.staff_user_id,
          actorLabel: (execOpts && execOpts.actorLabel) || actor.email || actor.staff_user_id,
          idempotencyKey,
          guestName,
          checkIn,
          checkOut,
          bookingGuests: Array.isArray(result._booking_guests) ? result._booking_guests : [],
          stripeConfig,
        });
        result._pay_outcome = payOutcome;
        result._payment_id = payOutcome.payment_id || null;
      } catch (payErr) {
        await pg.query('ROLLBACK');
        return {
          ok: false,
          status: payErr.code === 'STRIPE_NOT_CONFIGURED' ? 503 : (payErr.code === 'INVALID_PAID_AMOUNT' ? 400 : 422),
          body: {
            ...result,
            _payment_failed: true,
            _payment_error: payErr.code || payErr.message,
            assignedBedCodes,
            quote,
          },
        };
      }

      const serviceRecordRows = buildManualBookingServiceRecordRows({
        addOns,
        quote,
        clientSlug,
        bookingId: result.booking_id,
        bookingCode: result.booking_code,
        guestName,
        checkIn,
        quoteGuestCount,
      });
      const svcInsert = await tryInsertManualBookingServiceRecords(pg, serviceRecordRows);
      result._service_records_created = svcInsert.created;
      result._service_records_available = svcInsert.available;
      result._service_records_warning = svcInsert.warning;

      const privateRoomHooks = execOpts && execOpts.privateRoomHooks;
      if (privateRoomHooks && typeof privateRoomHooks.enabled === 'function'
        && privateRoomHooks.enabled(roomType)
        && typeof privateRoomHooks.syncPrivateRoomBlocks === 'function') {
        await pg.query(
          `UPDATE bookings
             SET room_preference = 'couple_private',
                 requested_room_type = 'double'
           WHERE id = $1
             AND client_id = (SELECT id FROM clients WHERE slug = $2 LIMIT 1)`,
          [result.booking_id, clientSlug],
        );
        const bedSync = await privateRoomHooks.syncPrivateRoomBlocks(pg, clientSlug, {
          booking_id: String(result.booking_id),
          check_in: checkIn,
          check_out: checkOut,
          primary_room_code: null,
        });
        if (bedSync && bedSync.error) {
          await pg.query('ROLLBACK');
          return {
            ok: false,
            status: (bedSync.error === 'private_room_room_not_empty' || bedSync.error === 'private_room_bed_block_conflict') ? 409 : 422,
            body: {
              ...result,
              _blocked: true,
              _private_room_block: bedSync,
              block_reason: bedSync.error,
              assignedBedCodes,
              quote,
            },
          };
        }
        result._bed_block = bedSync;
      }
    }

    await pg.query('COMMIT');
    return {
      ok: true,
      status: 201,
      body: {
        ...result,
        assignedBedCodes,
        quote,
        paymentLinkAmountCents,
        paymentKind,
        client_slug: clientSlug,
        check_in: checkIn,
        check_out: checkOut,
      },
    };
  } catch (e) {
    try { await pg.query('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

module.exports = {
  BOOKING_CREATE_CHANNELS,
  ACCOMMODATION_CLIENT_MONEY_FIELDS,
  loadBookingQuoteConfigWithOverlay,
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
  wolfhouseOperationFingerprint,
  rejectClientSuppliedMoney,
  resolveActorForChannel,
};
