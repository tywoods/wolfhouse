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
const { calculateWolfhouseQuote } = require('./wolfhouse-quote-calculator');
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
const { runLunaGuestBookingDryRun } = require('./luna-guest-booking-dry-run');
const {
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  validateAvailabilityProvenanceForCreate,
  buildAvailabilityRecheckCommandFromBooking,
  AVAILABILITY_CHANNELS,
} = require('./luna-front-desk-accommodation-availability-service');
const { needsGenderAwareBedAssignment } = require('./luna-bed-allocator');

const BOOKING_CREATE_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
});

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
  return rawBedCodes.map(String).slice(0, 20);
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
    }, { pg: opts && opts.pgClient });
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
    });
  }

  const roomType = channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP
    ? resolveQuoteRoomTypeFromPreference(body.room_type, body.room_preference)
    : (String(body.room_type || 'shared').trim().slice(0, 20) || 'shared');

  if (!effectivePackageCode || effectivePackageCode === 'manual_override') {
    return fail(400, 'missing_package', 'package_code or guest_packages is required (use package_none for accommodation-only / short stays)');
  }

  const packageNightCheck = validateStaffPackageNightRule(checkIn, checkOut, effectivePackageCode);
  if (!packageNightCheck.ok) return fail(400, 'package_min_nights_violation', packageNightCheck.error);

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

  let assignedBedCodes = parseSelectedBedCodes(body);
  let availabilityProvenance = null;
  let availabilityPreflightAssignmentMode = false;

  const pg = opts && opts.pgClient;

  if (channel === BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP) {
    const genderAwareAssign = needsGenderAwareBedAssignment({
      guestCount: quoteGuestCount,
      groupGender: body.group_gender,
      genderPreference,
      roomPreference,
    });
    availabilityPreflightAssignmentMode = genderAwareAssign || assignedBedCodes.length === 0;
    if (assignedBedCodes.length === 0 || genderAwareAssign) {
      if (!pg) {
        return fail(500, 'database_required', 'pgClient required for bot bed auto-assignment');
      }
      const availBuilt = buildWolfhouseAvailabilityCommand({
        channel: AVAILABILITY_CHANNELS.BOOKING_PREFLIGHT,
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
      if (preflight.ok) availabilityProvenance = preflight.body.provenance || null;
    }
  }

  if (assignedBedCodes.length === 0) {
    return fail(400, 'missing_bed_codes', 'selected_bed_codes is required');
  }
  if (assignedBedCodes.some((c) => SQL_INJECT_RE.test(c))) {
    return fail(400, 'invalid_bed_codes', 'invalid character in selected_bed_codes');
  }

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
  }, opts.quoteConfig);
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
    const occupied = new Set(freshAvail.body.occupied_bed_codes || []);
    const conflict = assignedBedCodes.filter((code) => occupied.has(code));
    if (conflict.length > 0) {
      return fail(409, 'availability_changed', 'Selected beds are no longer available', {
        conflict_beds: conflict,
        _blocked: true,
      });
    }
  }

  await pg.query('BEGIN');
  try {
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
        const bedAssignments = bedsRes.rows.map((b, idx) => ({
          guest_number: idx + 1,
          bed_code: b.bed_code,
          room_code: b.room_code,
        }));
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
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
  rejectClientSuppliedMoney,
  resolveActorForChannel,
};
