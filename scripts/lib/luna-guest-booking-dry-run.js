/**
 * Phase 12b — Luna guest booking dry-run orchestrator.
 *
 * Chains safe preview/gate patterns from Staff API bot routes without writes,
 * Stripe, WhatsApp, n8n, or live create paths.
 *
 * Reuses:
 *   - calculateWolfhouseQuote (same engine as POST /staff/bot/booking-preview)
 *   - getPauseState (same SoT as POST /staff/bot/check-guest-automation-gate)
 *   - getBedCalendar* queries (same as POST /staff/bot/availability-check)
 *   - wolfhouse-somo.pricing.json (same as POST /staff/bot/addon-request-preview)
 *
 * @module luna-guest-booking-dry-run
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { calculateWolfhouseQuote } = require('./wolfhouse-quote-calculator');
const { normalizeQuoteAddOnsForCombo } = require('./guest-addon-pricing');
const { buildBotQuoteIncludedItems } = require('./bot-quote-included-items');
const { computeWolfhouseRoomOptionFlags } = require('./wolfhouse-room-options');
const { runAvailabilityBedSelection, isRulesBasedRoomingEnabled } = require('./luna-bed-allocator');
const {
  resolveBotBookingPackageContext,
  buildBotQuoteReplyDraft,
} = require('./bot-booking-package-normalize');
const { getPauseState, formatPauseStateRow } = require('./staff-bot-pause-sql');
const {
  getBedCalendarRoomsQuery,
  getBedCalendarBlocksQuery,
} = require('./staff-bed-calendar-queries');

const DEFAULT_CLIENT = 'wolfhouse-somo';
const PRICING_PATH   = path.join(__dirname, '..', '..', 'config', 'clients', 'wolfhouse-somo.pricing.json');

/** Staff API routes this orchestrator mirrors (read-only / plan-only). */
const DRY_RUN_ANCHOR_ROUTES = {
  gate:            'POST /staff/bot/check-guest-automation-gate',
  booking_preview: 'POST /staff/bot/booking-preview',
  availability:    'POST /staff/bot/availability-check',
  addon_preview:   'POST /staff/bot/addon-request-preview',
};

/** Live routes that dry-run must never invoke. */
const LIVE_FORBIDDEN_ROUTES = [
  'POST /staff/manual-bookings/create',
  'POST /staff/bot/bookings/create',
  'POST /staff/bookings/generate-payment-link',
  'POST /staff/payments/:payment_id/create-stripe-link',
  'POST /staff/bot/payments/:payment_id/create-stripe-link',
  'POST /staff/stripe/webhook',
];

const FORBIDDEN_CONTEXT_KEYS = [
  'createBooking',
  'createPayment',
  'generateStripeLink',
  'sendWhatsApp',
  'activateN8n',
  'invokeWebhook',
  'runManualBookingCreate',
  'runBotBookingCreate',
];

const BOT_BOOKING_REQUIRED_FIELDS = [
  'check_in',
  'check_out',
  'guest_count',
  'package_code',
  'room_type',
  'guest_name',
  'phone',
  'payment_choice',
];

const BOT_FIELD_LABELS = {
  check_in:       'your check-in date',
  check_out:      'your check-out date',
  guest_count:    'how many guests',
  package_code:   'which package (Malibu, Uluwatu, or Waimea)',
  room_type:      'your room preference (shared or private)',
  guest_name:     'your name',
  phone:          'your WhatsApp number',
  payment_choice: 'whether you prefer to pay a deposit or the full amount',
};

const BOT_ADDON_SERVICE_TYPES = new Set(['yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard']);

const DRY_RUN_SAFETY_FLAGS = Object.freeze({
  dry_run:             true,
  creates_booking:     false,
  creates_payment:     false,
  creates_stripe_link: false,
  sends_whatsapp:      false,
  calls_n8n:           false,
});

function assertDryRunContext(context) {
  if (!context || typeof context !== 'object') return;
  for (const key of FORBIDDEN_CONTEXT_KEYS) {
    if (context[key] != null) {
      throw new Error(`dry-run forbids context.${key} — live route delegation blocked`);
    }
  }
  if (context.force_live === true) {
    throw new Error('dry-run forbids context.force_live');
  }
}

/** guest_phone → phone → from (matches n8n Phase 12f parse node). */
function resolveDryRunPhone(src) {
  const s = src || {};
  const guestPhone = s.guest_phone != null ? String(s.guest_phone).trim() : '';
  if (guestPhone) return guestPhone;
  const phone = s.phone != null ? String(s.phone).trim() : '';
  if (phone) return phone;
  const from = s.from != null ? String(s.from).trim() : '';
  if (from) return from;
  return '';
}

function normalizeDryRunPaymentChoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (['full', 'full amount', 'pay full', 'pay full amount', 'all now', 'pay all', 'everything', 'whole amount'].includes(compact)) return 'full';
  if (['deposit', 'pay deposit', 'the deposit', 'deposit only'].includes(compact)) return 'deposit';
  if (['arrival', 'on arrival', 'pay on arrival', 'later', 'pay_on_arrival'].includes(compact)) return 'pay_on_arrival';
  return raw;
}

function normalizeInput(input) {
  const src = input || {};
  const guestCount = src.guest_count != null
    ? Number(src.guest_count)
    : (src.adults != null ? Number(src.adults) : (src.guests != null ? Number(src.guests) : null));
  const resolvedPhone = resolveDryRunPhone(src);

  return {
    client_slug:    String(src.client_slug || DEFAULT_CLIENT).trim(),
    guest_name:     String(src.guest_name || '').trim(),
    language:       String(src.language || 'en').trim().slice(0, 10),
    check_in:       String(src.check_in || '').trim(),
    check_out:      String(src.check_out || '').trim(),
    guest_count:    guestCount,
    package_code:   src.package_code != null ? String(src.package_code).trim().toLowerCase() : null,
    guest_packages: Array.isArray(src.guest_packages) ? src.guest_packages : [],
    room_type:      String(src.room_type || src.room_preference || 'shared').trim(),
    payment_choice: normalizeDryRunPaymentChoice(src.payment_choice),
    phone:          resolvedPhone,
    email:          String(src.email || '').trim(),
    add_ons:        Array.isArray(src.add_ons) ? src.add_ons : [],
    message_text:   src.message_text != null ? String(src.message_text) : null,
    conversation_id: src.conversation_id != null ? String(src.conversation_id).trim() || null : null,
    guest_phone:    resolvedPhone || null,
    booking_code:   src.booking_code != null ? String(src.booking_code).trim() || null : null,
    addon_request:  src.addon_request && typeof src.addon_request === 'object' ? src.addon_request : null,
    source:         String(src.source || 'luna_dry_run').trim().slice(0, 50),
  };
}

async function runGuestAutomationGate(fields, pg) {
  const gateInput = {
    client_slug:     fields.client_slug,
    conversation_id: fields.conversation_id,
    guest_phone:     fields.guest_phone || fields.phone || null,
    booking_code:    fields.booking_code,
  };

  if (!pg) {
    return {
      success:                       true,
      bot_paused:                    false,
      live_send_blocked:             false,
      can_continue_guest_automation: true,
      source:                        'default_active',
      no_write_performed:            true,
      sends_whatsapp:                false,
      whatsapp_dry_run:              true,
      skipped_db:                    true,
      anchor_route:                  DRY_RUN_ANCHOR_ROUTES.gate,
    };
  }

  try {
    const result = await getPauseState(pg, gateInput);
    if (result.row) {
      return {
        success:                       true,
        bot_paused:                    true,
        live_send_blocked:             true,
        can_continue_guest_automation: false,
        source:                        'bot_pause_states',
        pause_state:                   formatPauseStateRow(result.row),
        table_missing:                 !!result.table_missing,
        no_write_performed:            true,
        sends_whatsapp:                false,
        whatsapp_dry_run:              true,
        anchor_route:                  DRY_RUN_ANCHOR_ROUTES.gate,
      };
    }
    return {
      success:                       true,
      bot_paused:                    false,
      live_send_blocked:             false,
      can_continue_guest_automation: true,
      source:                        'default_active',
      table_missing:                 !!result.table_missing,
      no_write_performed:            true,
      sends_whatsapp:                false,
      whatsapp_dry_run:              true,
      anchor_route:                  DRY_RUN_ANCHOR_ROUTES.gate,
    };
  } catch (err) {
    return {
      success:                       true,
      bot_paused:                    false,
      live_send_blocked:             false,
      can_continue_guest_automation: true,
      source:                        'default_active',
      lookup_error:                  err.message,
      no_write_performed:            true,
      sends_whatsapp:                false,
      whatsapp_dry_run:              true,
      anchor_route:                  DRY_RUN_ANCHOR_ROUTES.gate,
    };
  }
}

function runBookingPreviewDryRun(fields) {
  const guestPackages = Array.isArray(fields.guest_packages) ? fields.guest_packages : [];
  const pkgCtx = resolveBotBookingPackageContext({
    packageCode: fields.package_code,
    guestPackages,
    checkIn: fields.check_in,
    checkOut: fields.check_out,
    guestCount: fields.guest_count || 0,
  });
  const effectivePackageCode = pkgCtx.quotePackageCode;
  const guestPackagesForQuote = pkgCtx.guestPackagesForQuote;
  const addOns = normalizeQuoteAddOnsForCombo(fields.add_ons, fields.guest_count || 0);

  const fieldValues = {
    check_in:       fields.check_in || null,
    check_out:      fields.check_out || null,
    guest_count:    (fields.guest_count != null && fields.guest_count > 0) ? fields.guest_count : null,
    package_code:   effectivePackageCode || null,
    guest_packages: guestPackagesForQuote,
    room_type:      fields.room_type || null,
    guest_name:     fields.guest_name || null,
    phone:          fields.phone || null,
    payment_choice: fields.payment_choice || null,
  };

  const missingFields = BOT_BOOKING_REQUIRED_FIELDS.filter((f) => !fieldValues[f]);
  const canQuote = !!(fields.check_in && fields.check_out && fields.guest_count > 0 && effectivePackageCode);

  let quote = null;
  let quoteError = null;
  if (canQuote) {
    try {
      quote = calculateWolfhouseQuote({
        client_slug:    fields.client_slug,
        check_in:       fields.check_in,
        check_out:      fields.check_out,
        guest_count:    fields.guest_count,
        package_code:   effectivePackageCode,
        guest_packages: guestPackagesForQuote,
        room_type:      fields.room_type || 'shared',
        payment_choice: fields.payment_choice || 'deposit',
        add_ons:        addOns,
      });
    } catch (err) {
      quoteError = err.message;
    }
  }

  let nextAction;
  if (quoteError) {
    nextAction = 'handoff_to_staff';
  } else if (quote && !quote.success) {
    nextAction = quote.staff_review_required ? 'handoff_to_staff' : 'ask_missing_details';
  } else if (quote && quote.success) {
    nextAction = 'show_quote';
  } else if (missingFields.length > 0) {
    nextAction = 'ask_missing_details';
  } else {
    nextAction = 'ask_missing_details';
  }

  let replyDraft;
  if (nextAction === 'ask_missing_details') {
    const readable = missingFields.map((f) => BOT_FIELD_LABELS[f] || f);
    const shown    = readable.slice(0, 3);
    const extra    = readable.length > 3 ? ` and ${readable.length - 3} more` : '';
    replyDraft = `Great, I can help you book. Could you also share: ${shown.join(', ')}${extra}?`;
  } else if (nextAction === 'handoff_to_staff') {
    replyDraft = "I'm going to have the team check this and get back to you shortly.";
  } else if (nextAction === 'show_quote' && quote) {
    replyDraft = buildBotQuoteReplyDraft(quote, pkgCtx, fields.package_code);
  } else {
    replyDraft = 'Let me check those dates and get back to you.';
  }

  const includedItems = (quote && quote.success)
    ? buildBotQuoteIncludedItems(quote, {
      isNoPackage: pkgCtx.isNoPackage,
      hasAddOns: addOns.length > 0,
    })
    : null;

  return {
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    creates_payment:     false,
    creates_stripe_link: false,
    sends_whatsapp:      false,
    anchor_route:        DRY_RUN_ANCHOR_ROUTES.booking_preview,
    missing_fields:      missingFields,
    has_missing_fields:  missingFields.length > 0,
    next_action:         nextAction,
    reply_draft:         replyDraft,
    quote,
    included_items:      includedItems,
    quote_error:         quoteError || null,
    availability_note: {
      status:  'not_checked',
      message: 'Full bed conflict check runs via availability step when dates and pg are present.',
    },
  };
}

async function runAvailabilityCheckDryRun(fields, pg) {
  const checkIn    = fields.check_in;
  const checkOut   = fields.check_out;
  const guestCount = fields.guest_count;
  const roomType   = String(fields.room_type || 'shared').trim().toLowerCase();

  if (!checkIn || !checkOut || !guestCount || guestCount < 1) {
    return {
      skipped: true,
      reason:  'missing_dates_or_guest_count',
      anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
    };
  }

  const ciDate = new Date(checkIn + 'T00:00:00Z');
  const coDate = new Date(checkOut + 'T00:00:00Z');
  if (isNaN(ciDate.getTime()) || isNaN(coDate.getTime()) || coDate <= ciDate) {
    return {
      skipped: true,
      reason:  'invalid_date_range',
      anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
    };
  }

  if (!pg) {
    return {
      skipped: true,
      reason:  'no_pg_client',
      preview_only: true,
      no_write_performed: true,
      anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
    };
  }

  const warnings = [];
  const blockers = [];

  const bedsRes   = await pg.query(getBedCalendarRoomsQuery(), [fields.client_slug]);
  const blocksRes = await pg.query(getBedCalendarBlocksQuery(), [fields.client_slug, checkIn, checkOut]);
  const bedRows   = bedsRes.rows;
  const blockRows = blocksRes.rows;

  const allBeds = bedRows
    .filter((r) => r.bed_code && r.bed_active !== false && r.bed_sellable !== false)
    .map((r) => ({
      bed_code:  r.bed_code,
      room_code: r.room_code,
      room_type: r.room_type || null,
      bed_label: r.bed_label || r.bed_code,
    }));

  const hasRoomTypeMeta = allBeds.some((b) => b.room_type !== null);
  let filteredBeds = allBeds;
  if (hasRoomTypeMeta && roomType && roomType !== 'any') {
    const privateTypes = ['private', 'double', 'matrimonial'];
    const sharedTypes  = ['shared', 'dorm'];
    if (roomType === 'shared') {
      const sharedBeds = allBeds.filter((b) => b.room_type && sharedTypes.includes(String(b.room_type).toLowerCase()));
      filteredBeds = sharedBeds.length > 0 ? sharedBeds : allBeds;
      if (sharedBeds.length === 0) warnings.push('room_type_filter_not_strict');
    } else if (privateTypes.includes(roomType)) {
      const privateBeds = allBeds.filter((b) => b.room_type && privateTypes.includes(String(b.room_type).toLowerCase()));
      filteredBeds = privateBeds.length > 0 ? privateBeds : allBeds;
      if (privateBeds.length === 0) warnings.push('room_type_filter_not_strict');
    } else {
      warnings.push('room_type_filter_not_strict');
    }
  } else if (!hasRoomTypeMeta && roomType && roomType !== 'any') {
    warnings.push('room_type_filter_not_strict');
  }

  const occupiedBedCodes = new Set(blockRows.map((r) => r.bed_code).filter(Boolean));
  const availableBeds  = filteredBeds.filter((b) => !occupiedBedCodes.has(b.bed_code));
  const availableCount   = availableBeds.length;
  const hasEnoughBeds    = availableCount >= guestCount;
  let selectedBedCodes = [];
  let selectedRoomCode = null;
  let allocationReason = null;
  let roomingHandoff = false;
  let groupGenderResolved = null;

  if (hasEnoughBeds) {
    const allowedBedCodes = new Set(filteredBeds.map((b) => b.bed_code));
    const pick = runAvailabilityBedSelection({
      bedRows,
      occupiedBedCodes,
      allowedBedCodes,
      guestCount,
      guestName: fields.guest_name || null,
      genderPreference: fields.gender_preference || null,
      roomPreference: fields.room_preference || fields.gender_preference || null,
    });
    allocationReason = pick.reason || null;
    groupGenderResolved = pick.group_gender || null;
    if (pick.handoff) {
      roomingHandoff = true;
      warnings.push(pick.reason || 'rooming_handoff');
      if (pick.reason === 'group_split_needs_staff') {
        blockers.push('group_split_needs_staff');
      } else {
        blockers.push(pick.reason || 'rooming_handoff');
      }
    } else {
      selectedBedCodes = pick.selected_bed_codes || [];
      selectedRoomCode = pick.selected_room_code || null;
      if (pick.split) warnings.push('group_split_across_rooms_required');
    }
  }

  if (!hasEnoughBeds) blockers.push('not_enough_available_beds');

  const roomOptionFlags = computeWolfhouseRoomOptionFlags(availableBeds, guestCount);

  return {
    preview_only:        true,
    no_write_performed:  true,
    creates_booking:     false,
    anchor_route:        DRY_RUN_ANCHOR_ROUTES.availability,
    check_in:            checkIn,
    check_out:           checkOut,
    guest_count:         guestCount,
    room_type:           roomType,
    girls_room_available:   roomOptionFlags.girls_room_available,
    private_room_available: roomOptionFlags.private_room_available,
    room_options: {
      girls_room_available:   roomOptionFlags.girls_room_available,
      private_room_available: roomOptionFlags.private_room_available,
    },
    selected_bed_codes:  selectedBedCodes,
    selected_room_code:  selectedRoomCode,
    group_gender:        groupGenderResolved,
    allocation_reason:   allocationReason,
    rules_based_rooming: isRulesBasedRoomingEnabled(),
    has_enough_beds:     hasEnoughBeds,
    available_count:     availableCount,
    warnings,
    blockers,
    next_action:         !hasEnoughBeds
      ? 'handoff_to_staff'
      : roomingHandoff
        ? 'handoff_to_staff'
        : 'show_availability_options',
  };
}

function previewGuestAddonPricing(serviceType, quantity, clientSlug) {
  const warnings = [];
  if (clientSlug !== DEFAULT_CLIENT) {
    return {
      amount_due_cents: null,
      pricing_addon_code: null,
      payment_required: false,
      warnings: [`pricing config not loaded for client "${clientSlug}" — staff review required`],
    };
  }

  if (serviceType === 'meal') {
    return {
      amount_due_cents: 0,
      payment_required: false,
      reason: 'meal_on_site_only',
      warnings: ['Meals are recorded on-site only for MVP — no payment link.'],
    };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf8'));
  } catch (err) {
    return {
      amount_due_cents: null,
      payment_required: false,
      warnings: [`pricing config unavailable: ${err.message}`],
    };
  }

  const addOns = config.add_ons || {};
  if (serviceType === 'wetsuit') {
    const cfg = addOns.wetsuit_rental;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'wetsuit_rental', payment_required: false, warnings: ['Wetsuit rental price not safely available — staff review required.'] };
    }
    return { amount_due_cents: cfg.price_cents * quantity, pricing_addon_code: 'wetsuit_rental', unit_cents: cfg.price_cents, payment_required: true, warnings };
  }
  if (serviceType === 'surfboard') {
    const cfg = addOns.surfboard_rental;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'surfboard_rental', payment_required: false, warnings: ['Surfboard rental price not safely available — staff review required.'] };
    }
    return { amount_due_cents: cfg.price_cents * quantity, pricing_addon_code: 'surfboard_rental', unit_cents: cfg.price_cents, payment_required: true, warnings };
  }
  if (serviceType === 'yoga') {
    const cfg = addOns.yoga_class;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'yoga_class', payment_required: false, warnings: ['Yoga price not safely available — staff review required.'] };
    }
    return { amount_due_cents: cfg.price_cents * quantity, pricing_addon_code: 'yoga_class', unit_cents: cfg.price_cents, payment_required: true, warnings };
  }
  if (serviceType === 'surf_lesson') {
    const cfg = addOns.surf_lesson;
    if (!cfg || cfg.pricing_status !== 'confirmed' || !cfg.price_cents) {
      return { amount_due_cents: null, pricing_addon_code: 'surf_lesson', payment_required: false, warnings: ['Surf lesson price not safely available — staff review required.'] };
    }
    return { amount_due_cents: cfg.price_cents * quantity, pricing_addon_code: 'surf_lesson', unit_cents: cfg.price_cents, payment_required: true, warnings };
  }

  return { amount_due_cents: null, payment_required: false, warnings: ['Unknown service type for pricing.'] };
}

async function lookupAddonBooking(pg, bookingCode, clientSlug) {
  const r = await pg.query(
    `SELECT b.id AS booking_id, b.booking_code, b.guest_name, b.check_in, b.check_out,
            b.status AS booking_status, b.client_id, cl.slug AS client_slug
       FROM bookings b
       JOIN clients cl ON cl.id = b.client_id
      WHERE b.booking_code = $1 AND cl.slug = $2`,
    [bookingCode, clientSlug],
  );
  return r.rows[0] || null;
}

async function runAddonPreviewDryRun(addonInput, fields, pg) {
  const body = Object.assign({ client_slug: fields.client_slug }, addonInput || {});
  const clientSlug  = String(body.client_slug || DEFAULT_CLIENT).trim();
  const bookingCode = String(body.booking_code || fields.booking_code || '').trim();
  const serviceType = String(body.service_type || '').trim().toLowerCase();
  const serviceDate = body.service_date != null ? String(body.service_date).trim() : '';
  const quantity    = Math.max(1, parseInt(body.quantity || '1', 10) || 1);

  if (!serviceType || !BOT_ADDON_SERVICE_TYPES.has(serviceType)) {
    return {
      skipped: false,
      preview_only: true,
      no_write_performed: true,
      creates_service_record: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
      anchor_route: DRY_RUN_ANCHOR_ROUTES.addon_preview,
      next_action: 'handoff_to_staff',
      error: `service_type must be one of: ${[...BOT_ADDON_SERVICE_TYPES].join(', ')}`,
    };
  }

  if (!bookingCode) {
    return {
      skipped: false,
      preview_only: true,
      anchor_route: DRY_RUN_ANCHOR_ROUTES.addon_preview,
      next_action: 'ask_missing_details',
      reply_draft: "I couldn't find that booking — could you share your booking code?",
    };
  }

  if (!serviceDate) {
    return {
      skipped: false,
      preview_only: true,
      anchor_route: DRY_RUN_ANCHOR_ROUTES.addon_preview,
      next_action: 'ask_missing_details',
      reply_draft: 'Which date would you like that for? (YYYY-MM-DD)',
      booking_code: bookingCode,
      service_type: serviceType,
    };
  }

  const pricing = previewGuestAddonPricing(serviceType, quantity, clientSlug);
  let booking = null;
  if (pg) {
    booking = await lookupAddonBooking(pg, bookingCode, clientSlug);
  }

  const isMeal = serviceType === 'meal';
  const canPay = !isMeal && pricing.payment_required && pricing.amount_due_cents != null && pricing.amount_due_cents > 0;

  let nextAction = 'handoff_to_staff';
  if (isMeal) nextAction = 'show_quote';
  else if (!pg) nextAction = 'show_quote';
  else if (!booking) nextAction = 'handoff_to_staff';
  else if (canPay) nextAction = 'would_create_payment_link_after_approval';
  else nextAction = 'show_quote';

  return {
    preview_only: true,
    no_write_performed: true,
    creates_service_record: false,
    creates_payment: false,
    creates_stripe_link: false,
    sends_whatsapp: false,
    anchor_route: DRY_RUN_ANCHOR_ROUTES.addon_preview,
    booking_code: bookingCode,
    booking_found: !!booking,
    service_type: serviceType,
    service_date: serviceDate,
    quantity,
    pricing,
    next_action: nextAction,
    would_create_payment: canPay,
    would_create_stripe_link: canPay,
  };
}

function buildPlannedActions(gate, bookingPreview, availability, addonPreview, fields) {
  const actions = [];

  if (gate.bot_paused || gate.can_continue_guest_automation === false) {
    actions.push('handoff_to_staff');
    return actions;
  }

  if (bookingPreview.has_missing_fields) {
    actions.push('ask_missing_details');
  }

  if (bookingPreview.quote && bookingPreview.quote.success) {
    actions.push('show_quote');
  }

  if (!fields.payment_choice && !bookingPreview.has_missing_fields) {
    actions.push('ask_deposit_or_full_payment');
  }

  if (availability && !availability.skipped && availability.has_enough_beds) {
    actions.push('show_availability_options');
  } else if (availability && !availability.skipped && availability.has_enough_beds === false) {
    actions.push('handoff_to_staff');
  }

  if (addonPreview && !addonPreview.skipped && addonPreview.would_create_stripe_link) {
    actions.push('would_create_payment_link_after_approval');
  }

  if (
    bookingPreview.quote &&
    bookingPreview.quote.success &&
    !bookingPreview.has_missing_fields &&
    fields.payment_choice &&
    (availability == null || availability.skipped || availability.has_enough_beds)
  ) {
    actions.push('would_create_booking_after_approval');
    if (fields.payment_choice) {
      actions.push('would_create_payment_link_after_approval');
    }
  }

  if (actions.length === 0) {
    actions.push(bookingPreview.next_action || 'ask_missing_details');
  }

  return [...new Set(actions)];
}

function resolveTopLevelNextAction(plannedActions, bookingPreview, gate) {
  if (gate.bot_paused) return 'handoff_to_staff';
  if (plannedActions.includes('ask_missing_details')) return 'ask_missing_details';
  if (plannedActions.includes('handoff_to_staff')) return 'handoff_to_staff';
  if (plannedActions.includes('show_quote')) return 'show_quote';
  if (plannedActions.includes('show_availability_options')) return 'show_availability_options';
  if (plannedActions.includes('ask_deposit_or_full_payment')) return 'ask_deposit_or_full_payment';
  if (plannedActions.includes('would_create_booking_after_approval')) return 'would_create_booking_after_approval';
  return bookingPreview.next_action || 'ask_missing_details';
}

/**
 * Run Luna guest booking dry-run plan (no writes, no external side effects).
 *
 * @param {object} input - guest/booking fields
 * @param {object} [context] - optional { pg } for read-only SELECT paths
 * @returns {Promise<object>}
 */
async function runLunaGuestBookingDryRun(input, context) {
  assertDryRunContext(context || {});

  const fields = normalizeInput(input);
  const pg     = context && context.pg ? context.pg : null;

  const gate           = await runGuestAutomationGate(fields, pg);
  const bookingPreview = runBookingPreviewDryRun(fields);

  let availability = null;
  if (fields.check_in && fields.check_out && fields.guest_count > 0) {
    availability = await runAvailabilityCheckDryRun(fields, pg);
  }

  let addonPreview = null;
  if (fields.addon_request) {
    addonPreview = await runAddonPreviewDryRun(fields.addon_request, fields, pg);
  }

  const planned_actions = buildPlannedActions(gate, bookingPreview, availability, addonPreview, fields);
  const next_action     = resolveTopLevelNextAction(planned_actions, bookingPreview, gate);

  let reply_draft = bookingPreview.reply_draft;
  if (addonPreview && addonPreview.reply_draft) {
    reply_draft = addonPreview.reply_draft;
  }

  return Object.assign({}, DRY_RUN_SAFETY_FLAGS, {
    planned_actions,
    gate,
    booking_preview: bookingPreview,
    availability:    availability || {},
    addon_preview:   addonPreview || {},
    reply_draft,
    next_action,
    client_slug:     fields.client_slug,
    language:        fields.language,
    message_text:    fields.message_text,
    phone:           fields.phone || null,
    guest_phone:     fields.guest_phone || null,
    guest_packages:  fields.guest_packages || [],
    anchor_routes:   DRY_RUN_ANCHOR_ROUTES,
    live_forbidden:  LIVE_FORBIDDEN_ROUTES,
    no_write_performed: true,
    preview_only:       true,
  });
}

module.exports = {
  runLunaGuestBookingDryRun,
  runAvailabilityCheckDryRun,
  runBookingPreviewDryRun,
  DRY_RUN_ANCHOR_ROUTES,
  LIVE_FORBIDDEN_ROUTES,
  DRY_RUN_SAFETY_FLAGS,
  FORBIDDEN_CONTEXT_KEYS,
};
