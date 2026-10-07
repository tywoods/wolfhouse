'use strict';

/**
 * Luna Front Desk — canonical Wolfhouse accommodation availability service.
 *
 * Read-only bed/capacity check shared by Staff bot route, vertical adapter,
 * Luna dry-run, and booking-create preflight. Zero writes.
 *
 * See docs/LUNA-FRONT-DESK-DOMAIN-CONTRACT.md §14.
 */

const crypto = require('crypto');
const { resolveRoomFillRanking } = require('./luna-room-fill-policy');
const { resolveQuoteRoomTypeFromPreference, computeWolfhouseRoomOptionFlags } = require('./wolfhouse-room-options');
const {
  runAvailabilityBedSelection,
  isRulesBasedRoomingEnabled,
  needsGenderAwareBedAssignment,
} = require('./luna-bed-allocator');
const { normalizeGroupGender } = require('./luna-booking-intake-policy');
const {
  getBedCalendarRoomsQuery,
  getBedCalendarBlocksQuery,
} = require('./staff-bed-calendar-queries');
const {
  resolveBedCalendarRoomRows,
  filterDemoCalendarBlocks,
} = require('./wolfhouse-inventory-source');

const AVAILABILITY_CHANNELS = Object.freeze({
  BOT_HTTP: 'bot_http',
  LUNA_WHATSAPP: 'luna_whatsapp',
  VERTICAL_ADAPTER: 'vertical_adapter',
  BOOKING_PREFLIGHT: 'booking_preflight',
  MANUAL_STAFF: 'manual_staff',
});

const AVAILABILITY_PROVENANCE_VERSION = 1;
const OFFER_REVISION_VERSION = 1;

const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';

function accommodationApplicationHelpers() {
  return require('./wolfhouse-accommodation-application');
}

const DRY_RUN_SAFETY_FLAGS = Object.freeze({
  preview_only: true,
  no_write_performed: true,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  sends_whatsapp: false,
});

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

function skipped(reason, extra = {}) {
  return {
    ok: false,
    skipped: true,
    reason,
    ...DRY_RUN_SAFETY_FLAGS,
    ...extra,
  };
}

/**
 * Build a trusted Wolfhouse availability command (sync — no DB).
 */
function buildWolfhouseAvailabilityCommand(opts = {}) {
  const channel = String(opts.channel || '').trim();
  const trustedClientSlug = String(opts.trustedClientSlug || WOLFHOUSE_CLIENT_SLUG).trim();
  if (trustedClientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return fail(403, 'tenant_mismatch', 'unsupported_client', { client_slug: trustedClientSlug });
  }

  const transportBody = opts.transportBody || {};
  const { rejectSurfSchoolTransportFields } = accommodationApplicationHelpers();
  const surfReject = rejectSurfSchoolTransportFields(transportBody);
  if (!surfReject.ok) return surfReject;

  const bodySlug = String(transportBody.client_slug || trustedClientSlug).trim();
  if (bodySlug !== trustedClientSlug) {
    return fail(403, 'tenant_mismatch', 'client_slug override rejected', { client_slug: bodySlug });
  }

  const checkIn = String(transportBody.check_in || '').trim();
  const checkOut = String(transportBody.check_out || '').trim();
  const guestCountRaw = transportBody.guest_count;
  const guestCount = guestCountRaw != null ? parseInt(guestCountRaw, 10) : NaN;

  if (!checkIn || !checkOut) {
    return skipped('missing_dates_or_guest_count');
  }
  if (!guestCount || guestCount < 1) {
    return skipped('missing_dates_or_guest_count');
  }

  const ciDate = new Date(`${checkIn}T00:00:00Z`);
  const coDate = new Date(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(ciDate.getTime()) || Number.isNaN(coDate.getTime()) || coDate <= ciDate) {
    return skipped('invalid_date_range');
  }

  const roomType = resolveQuoteRoomTypeFromPreference(
    transportBody.room_type,
    transportBody.room_preference,
  );
  const genderPreference = transportBody.gender_preference
    ? String(transportBody.gender_preference).trim()
    : null;
  const groupGender = transportBody.group_gender
    ? String(transportBody.group_gender).trim()
    : null;
  const roomPreference = String(transportBody.room_preference || genderPreference || '').trim() || null;
  const guestName = String(transportBody.guest_name || '').trim() || null;
  const packageCode = transportBody.package_code != null
    ? String(transportBody.package_code).trim()
    : (transportBody.package_interest != null ? String(transportBody.package_interest).trim() : null);

  return {
    ok: true,
    command: {
      channel,
      clientSlug: trustedClientSlug,
      checkIn,
      checkOut,
      guestCount,
      roomType: String(roomType || 'shared').trim().toLowerCase(),
      genderPreference,
      groupGender,
      roomPreference,
      guestName,
      packageCode: packageCode || null,
      quoteConfig: opts.quoteConfig,
      guestPackages: Array.isArray(transportBody.guest_packages) ? transportBody.guest_packages : [],
      demoCalendarEnrichment: opts.demoCalendarEnrichment !== false,
      assignmentMode: opts.assignmentMode === true,
      transportBody,
    },
  };
}

function computeWolfhouseAvailabilityInventory(bedRows, blockRows, command, roomFillRanking = null) {
  const {
    guestCount,
    roomType,
    genderPreference,
    groupGender,
    roomPreference,
    guestName,
    assignmentMode,
  } = command;

  const warnings = [];
  const blockers = [];

  const allBeds = (bedRows || [])
    .filter((r) => r.bed_code && r.bed_active !== false && r.bed_sellable !== false)
    .map((r) => ({
      ...r,
      bed_code: r.bed_code,
      room_code: r.room_code,
      room_type: r.room_type || null,
      bed_label: r.bed_label || r.bed_code,
      active: r.bed_active !== false,
      sellable: r.bed_sellable !== false,
    }));

  const rulesRooming = isRulesBasedRoomingEnabled();
  const hasRoomTypeMeta = allBeds.some((b) => b.room_type !== null);
  let filteredBeds = allBeds;
  if (!rulesRooming && hasRoomTypeMeta && roomType && roomType !== 'any') {
    const privateTypes = ['private', 'double', 'matrimonial'];
    const sharedTypes = ['shared', 'dorm', 'mixed'];
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
  } else if (!rulesRooming && !hasRoomTypeMeta && roomType && roomType !== 'any') {
    warnings.push('room_type_filter_not_strict');
  }

  const bedsForPool = rulesRooming ? allBeds : filteredBeds;
  const occupiedBedCodes = new Set((blockRows || []).map((r) => r.bed_code).filter(Boolean));
  const availableBeds = bedsForPool.filter((b) => !occupiedBedCodes.has(b.bed_code));
  const availableCount = availableBeds.length;
  const hasEnoughBeds = availableCount >= guestCount;

  let selectedBedCodes = [];
  let selectedRoomCode = null;
  let allocationReason = null;
  let allocationSplit = false;
  let roomingHandoff = false;
  let needsClarification = false;
  let clarificationConflict = null;
  let groupGenderResolved = null;

  function absorbClarification(pick) {
    if (!pick || pick.needs_clarification !== true) return false;
    needsClarification = true;
    clarificationConflict = pick.conflict || pick.reason || 'room_preference_conflicts_with_explicit_gender';
    allocationReason = clarificationConflict;
    groupGenderResolved = pick.group_gender || groupGenderResolved;
    selectedBedCodes = [];
    selectedRoomCode = null;
    if (!blockers.includes('needs_clarification')) blockers.push('needs_clarification');
    return true;
  }

  if (hasEnoughBeds && Array.isArray(command.transportBody && command.transportBody.selected_bed_codes)
    && command.transportBody.selected_bed_codes.length
    && command.assignmentMode !== true) {
    const { validateExplicitBedSelection } = require('./luna-bed-allocator');
    const explicitCodes = command.transportBody.selected_bed_codes.map(String);
    const validation = validateExplicitBedSelection({
      selectedBedCodes: explicitCodes,
      guestCount,
      body: command.transportBody,
      bedRows,
      blockRows,
    });
    if (!validation.ok) {
      blockers.push(validation.reason || 'availability_changed');
      allocationReason = validation.reason || 'availability_changed';
      selectedBedCodes = [];
    } else {
      selectedBedCodes = explicitCodes;
      allocationReason = 'explicit_selection';
      const first = (bedRows || []).find((row) => row && row.bed_code === explicitCodes[0]);
      selectedRoomCode = first ? first.room_code : null;
    }
  } else if (hasEnoughBeds) {
    const allowedBedCodes = new Set(bedsForPool.map((b) => b.bed_code));
    const capacityPick = runAvailabilityBedSelection({
      bedRows,
      roomFillRanking,
      occupiedBedCodes,
      allowedBedCodes,
      blockRows,
      guestCount,
      guestName,
      genderPreference: genderPreference || groupGender || null,
      roomPreference: roomPreference || genderPreference || null,
      groupGender: groupGender || genderPreference || null,
      capacityOnly: true,
    });
    allocationReason = capacityPick.reason || null;
    allocationSplit = !!capacityPick.split;
    groupGenderResolved = capacityPick.group_gender || null;
    if (absorbClarification(capacityPick)) {
      // Fail closed. Do not fill beds, and do not turn a gender mismatch into a team handoff.
    } else {
    selectedBedCodes = capacityPick.selected_bed_codes || [];
    selectedRoomCode = capacityPick.selected_room_code || null;
    if (capacityPick.split) warnings.push('group_split_across_rooms_required');

    if (assignmentMode) {
      const readyForGenderAssign = needsGenderAwareBedAssignment({
        guestCount,
        groupGender,
        genderPreference,
        roomPreference,
      });
      if (readyForGenderAssign) {
        const genderPick = runAvailabilityBedSelection({
          bedRows,
          roomFillRanking,
          occupiedBedCodes,
          allowedBedCodes,
          blockRows,
          guestCount,
          guestName,
          genderPreference: genderPreference || groupGender || null,
          roomPreference: roomPreference || genderPreference || null,
          groupGender: groupGender || genderPreference || null,
          capacityOnly: false,
        });
        groupGenderResolved = genderPick.group_gender || groupGenderResolved;
        if (absorbClarification(genderPick)) {
          roomingHandoff = false;
        } else if (genderPick.handoff) {
          roomingHandoff = true;
          warnings.push(genderPick.reason || 'rooming_handoff');
          if (genderPick.reason === 'group_split_needs_staff') {
            blockers.push('group_split_needs_staff');
          } else {
            blockers.push(genderPick.reason || 'rooming_handoff');
          }
          selectedBedCodes = [];
          selectedRoomCode = null;
        } else {
          selectedBedCodes = genderPick.selected_bed_codes || [];
          selectedRoomCode = genderPick.selected_room_code || null;
          allocationReason = genderPick.reason || allocationReason;
          allocationSplit = !!genderPick.split;
          if (genderPick.split) warnings.push('group_split_across_rooms_required');
        }
      }
    }
    }
  }

  if (!hasEnoughBeds) blockers.push('not_enough_available_beds');

  const roomOptionFlags = computeWolfhouseRoomOptionFlags(availableBeds, guestCount, bedRows, blockRows);

  return {
    allBeds,
    availableBeds,
    availableCount,
    hasEnoughBeds,
    selectedBedCodes,
    selectedRoomCode,
    allocationReason,
    allocationSplit,
    groupGenderResolved,
    roomingHandoff,
    needsClarification,
    clarificationConflict,
    occupiedBedCodes,
    warnings,
    blockers,
    roomOptionFlags,
    rulesRooming,
  };
}

function resolveDomainNextAction(channel, inventory, dateEval) {
  if (dateEval && !dateEval.ok) {
    if (dateEval.reason_code === 'closed_season') return 'closed_season';
    if (dateEval.reason_code === 'package_min_nights_violation') return 'package_min_nights_violation';
    return 'handoff_to_staff';
  }
  if (inventory.needsClarification) return 'ask_room_eligibility';
  if (!inventory.hasEnoughBeds) {
    return channel === AVAILABILITY_CHANNELS.BOT_HTTP
      ? 'ask_staff_or_alternate_dates'
      : 'handoff_to_staff';
  }
  if (inventory.roomingHandoff) return 'handoff_to_staff';
  if (channel === AVAILABILITY_CHANNELS.BOT_HTTP) return 'ready_for_bot_create';
  return 'show_availability_options';
}

function computeAvailabilityFingerprint(canonical) {
  const payload = {
    v: AVAILABILITY_PROVENANCE_VERSION,
    client_slug: canonical.client_slug,
    check_in: canonical.check_in,
    check_out: canonical.check_out,
    guest_count: canonical.guest_count,
    room_type: canonical.room_type,
    has_enough_beds: canonical.has_enough_beds,
    available_count: canonical.available_count,
    selected_bed_codes: [...(canonical.selected_bed_codes || [])].sort(),
    blockers: [...(canonical.blockers || [])].sort(),
    occupied_count: canonical.occupied_count,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildAvailabilityProvenance(canonical) {
  const fingerprint = computeAvailabilityFingerprint(canonical);
  return {
    availability_version: AVAILABILITY_PROVENANCE_VERSION,
    availability_fingerprint: fingerprint,
    checked_at: new Date().toISOString(),
    client_slug: canonical.client_slug,
    check_in: canonical.check_in,
    check_out: canonical.check_out,
    guest_count: canonical.guest_count,
    selected_bed_codes: canonical.selected_bed_codes || [],
    has_enough_beds: canonical.has_enough_beds,
    available_count: canonical.available_count,
    blockers: canonical.blockers || [],
    occupied_count: canonical.occupied_count,
  };
}

function buildCanonicalAvailabilityBody(command, inventory, dateEval) {
  const domainNextAction = resolveDomainNextAction(command.channel, inventory, dateEval);
  const canonical = {
    ...DRY_RUN_SAFETY_FLAGS,
    client_slug: command.clientSlug,
    check_in: command.checkIn,
    check_out: command.checkOut,
    guest_count: command.guestCount,
    room_type: command.roomType,
    gender_preference: command.genderPreference || null,
    room_preference: command.roomPreference || null,
    group_gender: inventory.groupGenderResolved,
    allocation_reason: inventory.allocationReason,
    allocation_split: inventory.allocationSplit,
    rules_based_rooming: inventory.rulesRooming,
    capacity_check_only: true,
    girls_room_available: inventory.roomOptionFlags.girls_room_available,
    private_room_available: inventory.roomOptionFlags.private_room_available,
    room_options: {
      girls_room_available: inventory.roomOptionFlags.girls_room_available,
      private_room_available: inventory.roomOptionFlags.private_room_available,
    },
    selected_bed_codes: inventory.selectedBedCodes,
    selected_room_code: inventory.selectedRoomCode,
    needs_clarification: inventory.needsClarification === true,
    clarification_conflict: inventory.clarificationConflict || null,
    needs_human: false,
    do_not_escalate: inventory.needsClarification === true,
    has_enough_beds: inventory.hasEnoughBeds,
    available_count: inventory.availableCount,
    available_beds: inventory.availableBeds.map((b) => ({
      bed_code: b.bed_code,
      room_code: b.room_code,
      room_type: b.room_type,
    })),
    occupied_count: inventory.occupiedBedCodes.size,
    occupied_bed_codes: [...inventory.occupiedBedCodes].sort(),
    warnings: [...inventory.warnings],
    blockers: [...inventory.blockers],
    domain_next_action: domainNextAction,
    assignment_mode: command.assignmentMode === true,
    demo_calendar_enrichment: command.demoCalendarEnrichment !== false,
  };

  if (dateEval) {
    canonical.nights = dateEval.nights;
    canonical.package_min_nights = dateEval.package_min_nights;
    canonical.package_eligible = dateEval.package_eligible;
    canonical.package_code = dateEval.package_code || command.packageCode || null;
    if (!dateEval.ok) {
      canonical.date_rule_ok = false;
      canonical.date_rule_reason = dateEval.reason_code || dateEval.reason;
      if (dateEval.reason_code && !canonical.blockers.includes(dateEval.reason_code)) {
        canonical.blockers.push(dateEval.reason_code);
      }
      if (dateEval.closed_season) canonical.closed_season = true;
    } else {
      canonical.date_rule_ok = true;
    }
  }

  canonical.provenance = buildAvailabilityProvenance(canonical);
  return canonical;
}

/**
 * Execute read-only Wolfhouse availability check. Zero writes.
 */
async function executeWolfhouseAvailabilityCheck(pg, command) {
  if (!command || command.clientSlug !== WOLFHOUSE_CLIENT_SLUG) {
    return fail(403, 'tenant_mismatch', 'unsupported_client');
  }
  if (!pg) {
    return skipped('no_pg_client');
  }

  let dateEval = null;
  if (command.packageCode || command.checkIn) {
    const { evaluateWolfhouseAccommodationDates } = accommodationApplicationHelpers();
    let config = command.quoteConfig;
    if (config === undefined) {
      config = require('./wolfhouse-quote-calculator').loadConfig();
      try {
        const items = await require('./wolfhouse-pricing-store').loadItems(pg, command.clientSlug);
        require('./wolfhouse-pricing-resolve').applyOverlayPackageItemsToConfig(config, items);
      } catch (_) {
        config.package_min_nights = null;
      }
    }
    dateEval = evaluateWolfhouseAccommodationDates({
      check_in: command.checkIn,
      check_out: command.checkOut,
      package_code: command.packageCode,
      package_interest: command.packageCode,
      guest_packages: command.guestPackages,
    }, { config });
  }

  let bedRows;
  let blockRows;
  let hasSavedFillPolicy = false;
  try {
    const bedsRes = await pg.query(getBedCalendarRoomsQuery(), [command.clientSlug]);
    const blocksRes = await pg.query(
      getBedCalendarBlocksQuery(),
      [command.clientSlug, command.checkIn, command.checkOut],
    );
    bedRows = bedsRes.rows;
    blockRows = blocksRes.rows;
    hasSavedFillPolicy = bedRows.some(row => row.room_fill_policy != null);
    // Zero active rooms have no inventory row on which to project the policy.
    // Check only that empty-inventory fallback edge; never resurrect disabled rooms.
    if (!bedRows.length && command.clientSlug === WOLFHOUSE_CLIENT_SLUG && command.demoCalendarEnrichment !== false) {
      const saved = await pg.query("SELECT to_jsonb(c)->'settings'->'luna_room_fill_policy' AS room_fill_policy FROM clients c WHERE c.slug = $1", [command.clientSlug]);
      hasSavedFillPolicy = saved.rows.some(row => row.room_fill_policy != null);
    }
  } catch (err) {
    return fail(500, 'db_error', err.message);
  }

  if (command.demoCalendarEnrichment !== false) {
    // A saved policy belongs to real inventory; never add unranked CSV/disabled rooms.
    if (!hasSavedFillPolicy) {
      bedRows = resolveBedCalendarRoomRows(command.clientSlug, bedRows);
    }
    blockRows = filterDemoCalendarBlocks(blockRows);
  }

  const fill = resolveRoomFillRanking({ clientSlug: command.clientSlug, bedRows, blockRows,
    checkIn: command.checkIn, checkOut: command.checkOut });
  const exactSelection = command.assignmentMode !== true
    && Array.isArray(command.transportBody?.selected_bed_codes) && command.transportBody.selected_bed_codes.length > 0;
  if (!exactSelection && !['active', 'not_configured', 'not_applicable'].includes(fill.status)) {
    return fail(409, 'room_fill_policy_requires_review', 'Room selection could not be confirmed',
      { room_fill_status: fill.status, write_performed: false });
  }
  const inventory = computeWolfhouseAvailabilityInventory(bedRows, blockRows, command, fill.byRoom);
  const body = buildCanonicalAvailabilityBody(command, inventory, dateEval);

  return { ok: true, status: 200, body };
}

/**
 * Map canonical availability to Staff bot HTTP response (transport enrichment only).
 */
function mapBotHttpAvailabilityResponse(canonical, httpOpts = {}) {
  const nextAction = canonical.needs_clarification
    ? 'ask_room_eligibility'
    : canonical.domain_next_action === 'ask_staff_or_alternate_dates'
    ? 'ask_staff_or_alternate_dates'
    : (canonical.has_enough_beds && canonical.date_rule_ok !== false
      ? 'ready_for_bot_create'
      : canonical.domain_next_action || 'ask_staff_or_alternate_dates');

  return {
    success: true,
    preview_only: true,
    no_write_performed: true,
    creates_booking: false,
    creates_payment: false,
    creates_stripe_link: false,
    sends_whatsapp: false,
    auth_mode: httpOpts.authMode || null,
    client_slug: httpOpts.clientSlug || canonical.client_slug,
    check_in: canonical.check_in,
    check_out: canonical.check_out,
    guest_count: canonical.guest_count,
    room_type: canonical.room_type,
    package_min_nights: canonical.package_min_nights,
    package_eligible: canonical.package_eligible,
    date_rule_ok: canonical.date_rule_ok,
    gender_preference: canonical.gender_preference,
    room_preference: canonical.room_preference,
    group_gender: canonical.group_gender,
    allocation_reason: canonical.allocation_reason,
    allocation_split: canonical.allocation_split,
    rules_based_rooming: canonical.rules_based_rooming,
    capacity_check_only: canonical.capacity_check_only,
    girls_room_available: canonical.girls_room_available,
    private_room_available: canonical.private_room_available,
    room_options: canonical.room_options,
    selected_bed_codes: canonical.selected_bed_codes,
    selected_room_code: canonical.selected_room_code,
    needs_clarification: canonical.needs_clarification === true,
    needs_human: false,
    do_not_escalate: canonical.needs_clarification === true,
    has_enough_beds: canonical.has_enough_beds,
    available_count: canonical.available_count,
    available_beds: canonical.available_beds,
    occupied_count: canonical.occupied_count,
    warnings: canonical.warnings,
    blockers: canonical.blockers,
    next_action: nextAction,
    elapsed_ms: httpOpts.elapsedMs != null ? httpOpts.elapsedMs : null,
    provenance: canonical.provenance,
  };
}

function buildAvailabilityRecheckCommandFromBooking(command) {
  const body = command.transportBody || {};
  const assignmentMode = command.availabilityPreflightAssignmentMode != null
    ? command.availabilityPreflightAssignmentMode
    : (command.channel === 'luna_whatsapp');
  return {
    channel: AVAILABILITY_CHANNELS.BOOKING_PREFLIGHT,
    clientSlug: command.clientSlug,
    checkIn: command.checkIn,
    checkOut: command.checkOut,
    guestCount: command.quoteGuestCount || command.guestCount,
    roomType: command.roomType,
    genderPreference: command.genderPreference || null,
    roomPreference: command.roomPreference || null,
    guestName: command.guestName || null,
    groupGender: body.group_gender || null,
    packageCode: command.effectivePackageCode || command.storagePackageCode || null,
    guestPackages: command.guestPackages || body.guest_packages || [],
    // Re-read current Admin policy at commit; never reuse transport-supplied config.
    demoCalendarEnrichment: true,
    assignmentMode,
    transportBody: body,
  };
}

/**
 * Re-check availability before booking commit; detect material inventory changes.
 */
function packagePolicyRecheckFailure(canonical) {
  const reason = (canonical.blockers || []).find(code => /^package_min_nights_/.test(code));
  if (!reason) return null;
  const minimum = canonical.package_min_nights;
  const reply = minimum == null
    ? 'I can’t confirm package eligibility right now. Would you like accommodation only?'
    : `Packages need at least ${minimum} nights. Would you prefer accommodation only or different dates?`;
  return { ok: false, status: 409, body: {
    success: false, reason_code: reason, error: reply, reply_draft: reply,
    package_min_nights: minimum, package_eligible: false,
    package_night_violation: {
      ok: false, reason_code: reason, error: reply,
      package_min_nights: minimum, package_eligible: false,
    },
    next_action: 'offer_accommodation_or_change_dates',
    write_performed: false, no_write_performed: true, staff_review_needed: false,
    staff_review_required: false, needs_human: false, do_not_escalate: true, _blocked: true,
  } };
}

function offerMoneyCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function normalizeGuestBedAssignments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row, index) => ({
    guest_index: Number.isInteger(row && row.guest_index) ? row.guest_index : index,
    guest_name: offerGuestName(row && (row.guest_name || row.name)),
    bed_code: String((row && row.bed_code) || '').trim(),
  })).filter((row) => row.bed_code);
}

function offerGuestName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  return name ? name.toLocaleLowerCase('es') : null;
}

function normalizeRoomArrangement(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => ({
    bed_code: String((row && row.bed_code) || '').trim(),
    room_code: String((row && row.room_code) || '').trim() || null,
    gender_strategy: String((row && (row.gender_strategy || row.room_gender)) || '').trim().toLowerCase() || null,
  })).filter((row) => row.bed_code)
    .sort((a, b) => a.bed_code.localeCompare(b.bed_code));
}

function normalizePaymentDistribution(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => ({
    guest_name: offerGuestName(row && (row.guest_name || row.name)),
    amount_cents: offerMoneyCents(row && row.amount_cents),
  })).filter((row) => row.guest_name || row.amount_cents != null);
}

function normalizeOfferAddOns(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (item == null || item === '') return null;
    if (typeof item === 'string') return { code: item.trim(), quantity: 1 };
    return {
      code: String(item.code || item.item_code || '').trim(),
      quantity: item.quantity == null || item.quantity === '' ? 1 : Number(item.quantity),
    };
  }).filter((item) => item && item.code);
}

function normalizeOfferGuestPackages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => ({
    guest_number: row && row.guest_number != null ? Number(row.guest_number) : null,
    package_code: String((row && row.package_code) || '').trim().toLowerCase(),
  })).filter((row) => row.package_code);
}

function wolfhouseOfferPayload(offer) {
  const src = offer && typeof offer === 'object' ? offer : {};
  return {
    v: OFFER_REVISION_VERSION,
    client_slug: src.client_slug || null,
    check_in: src.check_in || null,
    check_out: src.check_out || null,
    guest_count: src.guest_count == null || src.guest_count === '' ? null : Number(src.guest_count),
    guest_bed_assignments: normalizeGuestBedAssignments(src.guest_bed_assignments),
    room_arrangement: normalizeRoomArrangement(src.room_arrangement),
    room_type: src.room_type || null,
    room_preference: src.room_preference || null,
    gender_preference: src.gender_preference || null,
    package_code: src.package_code || null,
    guest_packages: normalizeOfferGuestPackages(src.guest_packages),
    add_ons: normalizeOfferAddOns(src.add_ons),
    total_cents: offerMoneyCents(src.total_cents),
    deposit_required_cents: offerMoneyCents(src.deposit_required_cents),
    payment_link_amount_cents: offerMoneyCents(src.payment_link_amount_cents),
    currency: src.currency || null,
    payment_choice: src.payment_choice || null,
    per_guest_payment_links: src.per_guest_payment_links === true,
    payment_distribution: normalizePaymentDistribution(src.payment_distribution),
    availability_checked: src.availability_checked === true,
  };
}

function computeWolfhouseOfferFingerprint(offer) {
  return crypto.createHash('sha256').update(JSON.stringify(wolfhouseOfferPayload(offer))).digest('hex');
}

function buildWolfhouseOfferRevision(offer) {
  const bound = wolfhouseOfferPayload(offer);
  return {
    ...bound,
    offer_revision_version: OFFER_REVISION_VERSION,
    offer_fingerprint: computeWolfhouseOfferFingerprint(bound),
  };
}

function offerChangeDetail(prior, current) {
  const a = wolfhouseOfferPayload(prior);
  const b = wolfhouseOfferPayload(current);
  if (a.check_in !== b.check_in || a.check_out !== b.check_out || a.guest_count !== b.guest_count) {
    return 'dates_changed';
  }
  if (JSON.stringify(a.guest_bed_assignments) !== JSON.stringify(b.guest_bed_assignments)) {
    return 'bed_allocation_changed';
  }
  if (JSON.stringify(a.room_arrangement) !== JSON.stringify(b.room_arrangement)
    || a.room_type !== b.room_type || a.room_preference !== b.room_preference
    || a.gender_preference !== b.gender_preference) {
    return 'room_eligibility_changed';
  }
  if (a.package_code !== b.package_code
    || JSON.stringify(a.guest_packages) !== JSON.stringify(b.guest_packages)
    || JSON.stringify(a.add_ons) !== JSON.stringify(b.add_ons)) {
    return 'services_changed';
  }
  if (a.payment_choice !== b.payment_choice
    || a.per_guest_payment_links !== b.per_guest_payment_links
    || JSON.stringify(a.payment_distribution) !== JSON.stringify(b.payment_distribution)
    || a.total_cents !== b.total_cents
    || a.deposit_required_cents !== b.deposit_required_cents
    || a.payment_link_amount_cents !== b.payment_link_amount_cents
    || a.currency !== b.currency) {
    return 'payment_terms_changed';
  }
  if (a.availability_checked !== b.availability_checked) return 'availability_unchecked';
  return 'offer_fingerprint_mismatch';
}

function offerReject(reasonCode, detail) {
  return {
    ok: false,
    status: 409,
    reason_code: reasonCode,
    detail,
    error: reasonCode === 'offer_unchecked'
      ? 'That preview id was not checked against current beds and price. Ask for a fresh quote.'
      : reasonCode === 'offer_identity_required'
        ? 'A checked offer revision is required before this booking can be created.'
        : 'The accepted offer no longer matches current dates, beds, or price. Nothing was booked.',
    write_performed: false,
    creates_booking: false,
    no_write_performed: true,
    success: false,
  };
}

/**
 * Compare a guest-accepted offer with the revision Staff just recomputed.
 * A bare preview id is not an offer. Missing, null, and zero money stay distinct.
 */
function compareAcceptedWolfhouseOffer(accepted, current) {
  if (!accepted || typeof accepted !== 'object') {
    return offerReject('offer_identity_required', 'missing_accepted_offer');
  }
  const bareId = accepted.offer_id != null && String(accepted.offer_id).trim();
  const fingerprint = accepted.offer_fingerprint || null;
  if (bareId && !fingerprint) {
    return offerReject('offer_unchecked', 'id_without_server_revision');
  }
  if (!fingerprint || accepted.availability_checked !== true) {
    return offerReject(
      'offer_identity_required',
      accepted.availability_checked === true ? 'missing_offer_fingerprint' : 'availability_unchecked',
    );
  }
  const currentRevision = current && current.offer_fingerprint
    ? current
    : buildWolfhouseOfferRevision(current);
  if (currentRevision.availability_checked !== true) {
    return offerReject('offer_unchecked', 'current_availability_unchecked');
  }
  if (currentRevision.offer_fingerprint !== fingerprint) {
    return {
      ...offerReject('offer_terms_changed', offerChangeDetail(accepted, currentRevision)),
      expected_fingerprint: fingerprint,
      current_fingerprint: currentRevision.offer_fingerprint,
    };
  }
  return { ok: true, current_revision: currentRevision };
}

function guestsFromCreateCommand(command) {
  const src = command && typeof command === 'object' ? command : {};
  const norm = src.guestsNorm && Array.isArray(src.guestsNorm.guests) ? src.guestsNorm.guests : [];
  if (norm.length) {
    return norm.map((guest) => ({ name: guest.guest_name || guest.name || null }));
  }
  const body = src.transportBody || {};
  if (Array.isArray(body.guests) && body.guests.length) return body.guests;
  if (src.guestName) return [{ name: src.guestName }];
  return [];
}

function currentWolfhouseOfferFromCreateCommand(command) {
  const src = command && typeof command === 'object' ? command : {};
  const quote = src.quote || {};
  const beds = Array.isArray(src.assignedBedCodes) ? src.assignedBedCodes.map(String) : [];
  const checked = src.availabilityChecked === true || !!src.availabilityProvenance;
  const built = buildCheckedWolfhousePreviewOffer({
    client_slug: src.clientSlug,
    quote: { ...quote, success: checked ? true : quote.success },
    availability: {
      availability_checked: checked,
      status: checked ? 'checked' : 'not_checked',
      check_in: src.checkIn,
      check_out: src.checkOut,
      guest_count: src.quoteGuestCount,
      selected_bed_codes: beds,
      room_type: src.roomType,
      room_preference: src.roomPreference || null,
      group_gender: src.groupGender || src.genderPreference || null,
      gender_preference: src.genderPreference || null,
      allocation_reason: src.allocationReason || null,
    },
    guests: guestsFromCreateCommand(src),
    payment_choice: src.paymentChoice,
    per_guest_payment_links: src.perGuestPaymentLinks === true,
    payment_distribution: quote.per_guest_deposits || [],
    room_rows: src.authoritativeRoomRows || [],
    package_code: src.effectivePackageCode || null,
    guest_packages: src.guestPackagesForQuote || [],
    add_ons: src.addOns || [],
  });
  if (built.offer_revision) return built.offer_revision;
  return buildWolfhouseOfferRevision({
    client_slug: src.clientSlug,
    check_in: src.checkIn,
    check_out: src.checkOut,
    guest_count: src.quoteGuestCount,
    guest_bed_assignments: beds.map((bed, index) => ({
      guest_index: index,
      guest_name: (guestsFromCreateCommand(src)[index] || {}).name || null,
      bed_code: bed,
    })),
    availability_checked: false,
  });
}

function buildCheckedWolfhousePreviewOffer(input) {
  const src = input && typeof input === 'object' ? input : {};
  const availability = src.availability && typeof src.availability === 'object' ? src.availability : {};
  const quote = src.quote && typeof src.quote === 'object' ? src.quote : {};
  const guests = Array.isArray(src.guests) ? src.guests : [];
  const beds = Array.isArray(availability.selected_bed_codes) ? availability.selected_bed_codes.map(String) : [];
  const checked = availability.availability_checked === true || availability.status === 'checked';
  const roomRows = Array.isArray(src.room_rows) ? src.room_rows : [];
  const byBed = new Map(roomRows.map((row) => [String(row && row.bed_code), row]));
  const assignments = beds.map((bed, index) => {
    const guest = guests[index] || {};
    return {
      guest_index: index,
      guest_name: guest.name || guest.guest_name || null,
      bed_code: bed,
    };
  });
  const roomArrangement = beds.map((bed) => {
    const row = byBed.get(bed) || {};
    return {
      bed_code: bed,
      room_code: row.room_code || null,
      gender_strategy: row.gender_strategy || row.room_gender || null,
    };
  });
  if (!checked || quote.success !== true) {
    return {
      availability: {
        status: 'not_checked',
        availability_checked: false,
        selected_bed_codes: beds,
        message: 'Availability was not checked, so this preview has no offer revision.',
      },
      offer_revision: null,
    };
  }
  const offerRevision = buildWolfhouseOfferRevision({
    client_slug: src.client_slug,
    check_in: availability.check_in,
    check_out: availability.check_out,
    guest_count: availability.guest_count != null ? availability.guest_count : guests.length,
    guest_bed_assignments: assignments,
    room_arrangement: roomArrangement,
    room_type: availability.room_type,
    room_preference: availability.room_preference,
    group_gender: availability.group_gender,
    gender_preference: availability.gender_preference,
    allocation_reason: availability.allocation_reason,
    package_code: quote.package_code || src.package_code || null,
    guest_packages: src.guest_packages || [],
    add_ons: src.add_ons || [],
    total_cents: quote.total_cents,
    deposit_required_cents: quote.deposit_required_cents,
    payment_link_amount_cents: quote.payment_link_amount_cents,
    currency: quote.currency,
    payment_choice: src.payment_choice,
    per_guest_payment_links: src.per_guest_payment_links === true,
    payment_distribution: src.payment_distribution || quote.per_guest_deposits || [],
    availability_checked: true,
  });
  return {
    availability: {
      status: 'checked',
      availability_checked: true,
      selected_bed_codes: beds,
      guest_bed_assignments: offerRevision.guest_bed_assignments,
      room_arrangement: offerRevision.room_arrangement,
      check_in: availability.check_in,
      check_out: availability.check_out,
      guest_count: availability.guest_count,
      room_type: availability.room_type,
    },
    offer_revision: offerRevision,
  };
}

async function loadAuthoritativeRoomRows(pg, clientSlug, bedCodes) {
  if (!pg || !clientSlug) return [];
  const { getBedCalendarRoomsQuery } = require('./staff-bed-calendar-queries');
  const res = await pg.query(
    `/* offer_commit_reread */ ${getBedCalendarRoomsQuery()}`,
    [clientSlug],
  );
  const wanted = new Set((bedCodes || []).map(String));
  return (res && Array.isArray(res.rows) ? res.rows : [])
    .filter((row) => row && row.bed_code && (!wanted.size || wanted.has(String(row.bed_code))));
}

async function loadAuthoritativeQuote(pg, command) {
  const src = command && typeof command === 'object' ? command : {};
  const { calculateWolfhouseQuote, loadConfig } = require('./wolfhouse-quote-calculator');
  const pricingStore = require('./wolfhouse-pricing-store');
  const {
    applyOverlayPackageItemsToConfig,
    applyOverlayRentalPricesToConfig,
  } = require('./wolfhouse-pricing-resolve');
  if (pg && src.clientSlug) {
    await pg.query(
      '/* offer_price_lock */ SELECT id FROM wh_pricing_rules WHERE client_slug = $1 FOR UPDATE',
      [src.clientSlug],
    );
    await pg.query(
      '/* offer_price_lock */ SELECT id FROM wh_pricing_items WHERE client_slug = $1 FOR UPDATE',
      [src.clientSlug],
    );
    const rules = await pricingStore.loadRules(pg, src.clientSlug);
    const items = await pricingStore.loadItems(pg, src.clientSlug);
    const config = applyOverlayPackageItemsToConfig(
      applyOverlayRentalPricesToConfig(loadConfig(), rules),
      items,
    );
    return calculateWolfhouseQuote({
      client_slug: src.clientSlug,
      check_in: src.checkIn,
      check_out: src.checkOut,
      guest_count: src.quoteGuestCount,
      package_code: src.effectivePackageCode || null,
      guest_packages: src.guestPackagesForQuote || [],
      room_type: src.roomType || 'shared',
      payment_choice: src.paymentChoice || 'deposit',
      add_ons: src.addOns || [],
      uses_per_guest_deposits: src.usesPerGuestModel === true,
    }, config);
  }
  return null;
}

async function rereadWolfhouseOfferForCommit(pg, command) {
  const src = command && typeof command === 'object' ? command : {};
  const body = src.transportBody || {};
  const accepted = body.accepted_offer || src.acceptedOffer || null;
  const beds = Array.isArray(src.assignedBedCodes) ? src.assignedBedCodes.map(String) : [];
  if (pg && src.clientSlug && beds.length) {
    await pg.query(
      `/* offer_room_lock */ SELECT bd.id
         FROM beds bd
         JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
         JOIN clients c ON c.id = bd.client_id
        WHERE c.slug = $1
          AND bd.bed_code = ANY($2::text[])
        FOR UPDATE OF bd, r`,
      [src.clientSlug, beds],
    );
    const { getBedCalendarBlocksQuery } = require('./staff-bed-calendar-queries');
    const blocks = await pg.query(getBedCalendarBlocksQuery(), [src.clientSlug, src.checkIn, src.checkOut]);
    const occupied = new Set((blocks && blocks.rows ? blocks.rows : []).map((row) => row.bed_code).filter(Boolean));
    const conflict = beds.filter((code) => occupied.has(code));
    if (conflict.length) {
      return {
        ...offerReject('availability_changed', 'assigned_beds_occupied'),
        conflict_beds: conflict,
      };
    }
  }
  const roomRows = await loadAuthoritativeRoomRows(pg, src.clientSlug, beds);
  let freshQuote = null;
  try {
    freshQuote = await loadAuthoritativeQuote(pg, src);
  } catch (_) {
    freshQuote = null;
  }
  const quoteForOffer = freshQuote && freshQuote.success
    ? freshQuote
    : {
      success: true,
      total_cents: null,
      deposit_required_cents: null,
      payment_link_amount_cents: null,
      currency: null,
    };
  const built = buildCheckedWolfhousePreviewOffer({
    client_slug: src.clientSlug,
    quote: quoteForOffer,
    availability: {
      availability_checked: true,
      status: 'checked',
      check_in: src.checkIn,
      check_out: src.checkOut,
      guest_count: src.quoteGuestCount,
      selected_bed_codes: beds,
      room_type: src.roomType,
      room_preference: src.roomPreference || null,
      group_gender: src.groupGender || src.genderPreference || null,
      gender_preference: src.genderPreference || null,
      allocation_reason: src.allocationReason || null,
    },
    guests: guestsFromCreateCommand(src),
    payment_choice: src.paymentChoice,
    per_guest_payment_links: src.perGuestPaymentLinks === true,
    payment_distribution: (freshQuote && freshQuote.per_guest_deposits) || [],
    room_rows: roomRows,
    package_code: src.effectivePackageCode || (freshQuote && freshQuote.package_code) || null,
    guest_packages: src.guestPackagesForQuote || [],
    add_ons: src.addOns || [],
  });
  return compareAcceptedWolfhouseOffer(accepted, built.offer_revision);
}

async function validateAvailabilityProvenanceForCreate(pg, command, provenance) {
  if (!provenance || typeof provenance !== 'object') {
    return { ok: true };
  }

  const recheckCmd = buildAvailabilityRecheckCommandFromBooking(command);
  const freshResult = await executeWolfhouseAvailabilityCheck(pg, recheckCmd);
  if (!freshResult.ok) {
    return {
      ok: false,
      status: freshResult.status || 409,
      body: {
        success: false,
        error: 'Availability could not be re-verified before booking create.',
        reason_code: 'availability_recheck_failed',
        detail: freshResult.body,
      },
    };
  }

  const fresh = freshResult.body;
  const policyFailure = packagePolicyRecheckFailure(fresh);
  if (policyFailure) return policyFailure;
  const expectedFp = provenance.availability_fingerprint
    || computeAvailabilityFingerprint(provenance);
  const currentFp = fresh.provenance
    ? fresh.provenance.availability_fingerprint
    : computeAvailabilityFingerprint(fresh);

  if (currentFp !== expectedFp) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'Bed availability changed since the last check. Please refresh availability and try again.',
        reason_code: 'availability_changed',
        detail: 'availability_fingerprint_mismatch',
        expected_fingerprint: expectedFp,
        current_fingerprint: currentFp,
        prior: provenance,
        current: fresh.provenance,
      },
    };
  }

  const assigned = command.assignedBedCodes || [];
  if (assigned.length > 0) {
    const occupied = new Set(fresh.occupied_bed_codes || []);
    const conflict = assigned.filter((code) => occupied.has(code));
    if (conflict.length > 0) {
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'Selected beds are no longer available.',
          reason_code: 'availability_changed',
          detail: 'assigned_beds_occupied',
          conflict_beds: conflict,
        },
      };
    }
    if (!fresh.has_enough_beds) {
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'Not enough beds available for this booking.',
          reason_code: 'availability_changed',
          detail: 'insufficient_capacity',
        },
      };
    }
  }

  return { ok: true, current_provenance: fresh.provenance };
}

module.exports = {
  packagePolicyRecheckFailure,
  AVAILABILITY_CHANNELS,
  AVAILABILITY_PROVENANCE_VERSION,
  OFFER_REVISION_VERSION,
  WOLFHOUSE_CLIENT_SLUG,
  computeWolfhouseOfferFingerprint,
  buildWolfhouseOfferRevision,
  compareAcceptedWolfhouseOffer,
  currentWolfhouseOfferFromCreateCommand,
  buildCheckedWolfhousePreviewOffer,
  rereadWolfhouseOfferForCommit,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  computeWolfhouseAvailabilityInventory,
  computeAvailabilityFingerprint,
  buildAvailabilityProvenance,
  mapBotHttpAvailabilityResponse,
  buildAvailabilityRecheckCommandFromBooking,
  validateAvailabilityProvenanceForCreate,
};
