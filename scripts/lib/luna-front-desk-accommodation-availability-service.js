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
      demoCalendarEnrichment: opts.demoCalendarEnrichment !== false,
      assignmentMode: opts.assignmentMode === true,
      transportBody,
    },
  };
}

function computeWolfhouseAvailabilityInventory(bedRows, blockRows, command) {
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
  let groupGenderResolved = null;

  if (hasEnoughBeds) {
    const allowedBedCodes = new Set(bedsForPool.map((b) => b.bed_code));
    const capacityPick = runAvailabilityBedSelection({
      bedRows,
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
        if (genderPick.handoff) {
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

  if (!hasEnoughBeds) blockers.push('not_enough_available_beds');

  const roomOptionFlags = computeWolfhouseRoomOptionFlags(availableBeds, guestCount);

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
    dateEval = evaluateWolfhouseAccommodationDates({
      check_in: command.checkIn,
      check_out: command.checkOut,
      package_code: command.packageCode,
      package_interest: command.packageCode,
    });
  }

  let bedRows;
  let blockRows;
  try {
    const bedsRes = await pg.query(getBedCalendarRoomsQuery(), [command.clientSlug]);
    const blocksRes = await pg.query(
      getBedCalendarBlocksQuery(),
      [command.clientSlug, command.checkIn, command.checkOut],
    );
    bedRows = bedsRes.rows;
    blockRows = blocksRes.rows;
  } catch (err) {
    return fail(500, 'db_error', err.message);
  }

  if (command.demoCalendarEnrichment !== false) {
    bedRows = resolveBedCalendarRoomRows(command.clientSlug, bedRows);
    blockRows = filterDemoCalendarBlocks(blockRows);
  }

  const inventory = computeWolfhouseAvailabilityInventory(bedRows, blockRows, command);
  const body = buildCanonicalAvailabilityBody(command, inventory, dateEval);

  return { ok: true, status: 200, body };
}

/**
 * Map canonical availability to Staff bot HTTP response (transport enrichment only).
 */
function mapBotHttpAvailabilityResponse(canonical, httpOpts = {}) {
  const nextAction = canonical.domain_next_action === 'ask_staff_or_alternate_dates'
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
    demoCalendarEnrichment: true,
    assignmentMode,
    transportBody: body,
  };
}

/**
 * Re-check availability before booking commit; detect material inventory changes.
 */
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
  AVAILABILITY_CHANNELS,
  AVAILABILITY_PROVENANCE_VERSION,
  WOLFHOUSE_CLIENT_SLUG,
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  computeWolfhouseAvailabilityInventory,
  computeAvailabilityFingerprint,
  buildAvailabilityProvenance,
  mapBotHttpAvailabilityResponse,
  buildAvailabilityRecheckCommandFromBooking,
  validateAvailabilityProvenanceForCreate,
};
