/**
 * Stage 8.3g — Pure JS availability/conflict preview helper.
 *
 * NOT WIRED — no API route calls this yet.
 * NOT RUNTIME — no DB calls, no SQL execution, no writes, no side effects.
 * NO WhatsApp / Stripe / n8n / pg-connect / fetch / fs.
 *
 * previewManualBookingAvailability(input) takes proposed booking details
 * and already-loaded in-memory data, then returns a structured preview
 * result indicating validity, conflicts, warnings, and summary.
 *
 * Half-open interval rule (same as SQL helper in staff-manual-booking-create-sql.js):
 *   existing.assignment_start_date < proposed_check_out
 *   existing.assignment_end_date   > proposed_check_in
 *
 * Ignored assignment statuses (normalised lowercase):
 *   - cancelled
 *   - expired
 *
 * Input shape:
 *   {
 *     client_id,
 *     check_in,             // YYYY-MM-DD string
 *     check_out,            // YYYY-MM-DD string (exclusive)
 *     selected_bed_codes,   // string[]
 *     guest_count,          // integer
 *     existing_assignments, // { booking_code, booking_status, assignment_status, bed_code,
 *                           //   room_code, assignment_start_date, assignment_end_date, guest_name }[]
 *     beds,                 // { bed_code, room_code, active, sellable, capacity }[]
 *     options               // optional: { today, allow_same_day, long_stay_warning_nights,
 *                           //             protected_room_codes, operator_room_codes }
 *   }
 *
 * Output shape:
 *   {
 *     is_valid,
 *     has_conflict,
 *     blockers,              // string[] — symbolic blocker codes
 *     warnings,              // string[] — advisory warnings
 *     proposed_nights,       // integer or null if dates invalid
 *     selected_bed_count,    // integer
 *     selected_beds,         // bed metadata for selected codes
 *     conflict_beds,         // bed codes with overlap
 *     conflict_assignments,  // assignment records that caused conflict
 *     availability_by_bed,   // { [bed_code]: { available, conflict_assignments } }
 *     summary                // human-readable string
 *   }
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Assignment statuses that do NOT block availability.
 * Normalised to lowercase for comparison.
 */
const NON_BLOCKING_STATUSES = Object.freeze(['cancelled', 'expired']);

const DEFAULT_LONG_STAY_WARNING_NIGHTS = 14;

// ---------------------------------------------------------------------------
// Date utilities (pure; no side effects)
// ---------------------------------------------------------------------------

/**
 * Parse a YYYY-MM-DD string to a Date object (UTC midnight).
 * Returns null on invalid input.
 * @param {string} str
 * @returns {Date|null}
 */
function parseDate(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d.getTime())) return null;
  return d;
}

/**
 * Day difference: (dateB - dateA) in whole calendar days (UTC).
 * @param {Date} dateA
 * @param {Date} dateB
 * @returns {number}
 */
function dayDiff(dateA, dateB) {
  return Math.round((dateB.getTime() - dateA.getTime()) / 86400000);
}

/**
 * Add N calendar days to a Date, returning a new Date.
 * @param {Date} date
 * @param {number} n
 * @returns {Date}
 */
function addDays(date, n) {
  return new Date(date.getTime() + n * 86400000);
}

// ---------------------------------------------------------------------------
// Overlap detection (half-open interval)
// ---------------------------------------------------------------------------

/**
 * Returns true if an existing assignment overlaps the proposed check-in/out
 * using the half-open interval rule.
 *
 * Half-open:
 *   existing_start < proposed_check_out
 *   existing_end   > proposed_check_in
 *
 * Non-blocking statuses (cancelled, expired) are excluded by the caller.
 *
 * @param {string} existingStart  YYYY-MM-DD
 * @param {string} existingEnd    YYYY-MM-DD
 * @param {Date}   proposedCheckIn
 * @param {Date}   proposedCheckOut
 * @returns {boolean}
 */
function overlapsHalfOpen(existingStart, existingEnd, proposedCheckIn, proposedCheckOut) {
  const eStart = parseDate(existingStart);
  const eEnd   = parseDate(existingEnd);
  if (!eStart || !eEnd) return false;
  // Half-open: existing_start < proposed_check_out AND existing_end > proposed_check_in
  return eStart < proposedCheckOut && eEnd > proposedCheckIn;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Pure availability/conflict preview for a proposed manual booking.
 * No DB calls. No SQL execution. No writes. No side effects.
 *
 * @param {object} input
 * @param {string}   input.client_id
 * @param {string}   input.check_in               YYYY-MM-DD
 * @param {string}   input.check_out              YYYY-MM-DD (exclusive)
 * @param {string[]} input.selected_bed_codes
 * @param {number}   input.guest_count
 * @param {object[]} input.existing_assignments   already-loaded booking_beds rows
 * @param {object[]} input.beds                   already-loaded bed metadata rows
 * @param {object}   [input.options]
 * @returns {object}
 */
function previewManualBookingAvailability(input) {
  const {
    check_in,
    check_out,
    selected_bed_codes  = [],
    guest_count         = 0,
    existing_assignments = [],
    beds                = [],
    options             = {},
  } = input || {};

  const blockers   = [];
  const warnings   = [];

  // ── Options ────────────────────────────────────────────────────────────────
  const today = options.today
    ? parseDate(options.today) || new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate()
      ))
    : new Date(Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate()
      ));

  const longStayThreshold  = typeof options.long_stay_warning_nights === 'number'
    ? options.long_stay_warning_nights
    : DEFAULT_LONG_STAY_WARNING_NIGHTS;

  const protectedRoomCodes = Array.isArray(options.protected_room_codes)
    ? options.protected_room_codes.map(c => String(c).toLowerCase())
    : [];

  const operatorRoomCodes  = Array.isArray(options.operator_room_codes)
    ? options.operator_room_codes.map(c => String(c).toLowerCase())
    : [];

  // ── Date validation ────────────────────────────────────────────────────────
  const checkInDate  = parseDate(check_in);
  const checkOutDate = parseDate(check_out);

  const datesInvalid = !checkInDate || !checkOutDate || checkOutDate <= checkInDate;
  if (!checkInDate || !checkOutDate) {
    blockers.push('invalid_dates');
  } else if (checkOutDate <= checkInDate) {
    blockers.push('invalid_dates');
  }

  const proposedNights = (checkInDate && checkOutDate && checkOutDate > checkInDate)
    ? dayDiff(checkInDate, checkOutDate)
    : null;

  if (proposedNights !== null && proposedNights <= 0) {
    if (!blockers.includes('invalid_dates')) blockers.push('invalid_dates');
  }

  // ── Bed list helpers ───────────────────────────────────────────────────────
  const bedMap = {};
  for (const bed of beds) {
    if (bed && bed.bed_code) bedMap[String(bed.bed_code)] = bed;
  }

  // ── Selected bed validation ────────────────────────────────────────────────
  const selectedCodes = Array.isArray(selected_bed_codes)
    ? selected_bed_codes.map(String)
    : [];

  if (selectedCodes.length === 0) {
    blockers.push('no_selected_beds');
  }

  const selectedBeds      = [];
  const notFoundCodes     = [];
  const inactiveOrUnsellable = [];

  for (const code of selectedCodes) {
    const bed = bedMap[code];
    if (!bed) {
      notFoundCodes.push(code);
    } else {
      selectedBeds.push(bed);
      const active   = bed.active !== false;
      const sellable = bed.sellable !== false;
      if (!active || !sellable) {
        inactiveOrUnsellable.push(code);
      }
    }
  }

  if (notFoundCodes.length > 0) {
    blockers.push('bed_not_found');
  }

  if (inactiveOrUnsellable.length > 0) {
    blockers.push('bed_inactive_or_unsellable');
  }

  // ── Guest count vs selected bed count ─────────────────────────────────────
  const selectedBedCount = selectedCodes.length;
  if (typeof guest_count === 'number' && guest_count > selectedBedCount) {
    blockers.push('guest_count_exceeds_selected_beds');
  }

  // ── Overlap detection ──────────────────────────────────────────────────────
  const conflictBeds        = [];
  const conflictAssignments = [];
  const availabilityByBed   = {};

  for (const code of selectedCodes) {
    availabilityByBed[code] = { available: true, conflict_assignments: [] };
  }

  if (!datesInvalid && selectedCodes.length > 0) {
    for (const assignment of existing_assignments) {
      if (!assignment) continue;

      // Normalised status check — cancelled/expired do not block
      const bookingStatus    = typeof assignment.booking_status    === 'string'
        ? assignment.booking_status.toLowerCase()
        : '';
      const assignmentStatus = typeof assignment.assignment_status === 'string'
        ? assignment.assignment_status.toLowerCase()
        : '';

      const isNonBlocking =
        NON_BLOCKING_STATUSES.includes(bookingStatus) ||
        NON_BLOCKING_STATUSES.includes(assignmentStatus);

      if (isNonBlocking) continue;

      const assignedBedCode = assignment.bed_code ? String(assignment.bed_code) : null;
      if (!assignedBedCode) continue;

      // Only check beds we have selected
      if (!selectedCodes.includes(assignedBedCode)) continue;

      // Half-open interval:
      //   existing.assignment_start_date < proposed_check_out
      //   existing.assignment_end_date   > proposed_check_in
      const overlaps = overlapsHalfOpen(
        assignment.assignment_start_date,
        assignment.assignment_end_date,
        checkInDate,
        checkOutDate
      );

      if (overlaps) {
        if (!conflictBeds.includes(assignedBedCode)) {
          conflictBeds.push(assignedBedCode);
        }
        conflictAssignments.push(assignment);
        if (availabilityByBed[assignedBedCode]) {
          availabilityByBed[assignedBedCode].available = false;
          availabilityByBed[assignedBedCode].conflict_assignments.push(assignment);
        }
      }
    }
  }

  if (conflictBeds.length > 0) {
    blockers.push('overlap_conflict');
  }

  // ── Warnings ───────────────────────────────────────────────────────────────
  if (!datesInvalid && checkInDate) {
    const daysUntilCheckIn = dayDiff(today, checkInDate);

    // Same-day arrival
    if (daysUntilCheckIn === 0) {
      warnings.push('same_day_arrival');
    }
    // Next-day arrival
    else if (daysUntilCheckIn === 1) {
      warnings.push('next_day_arrival');
    }
  }

  if (proposedNights !== null && proposedNights > longStayThreshold) {
    warnings.push('long_stay');
  }

  // Protected / operator room warnings
  const selectedRoomCodes = new Set(
    selectedBeds.map(b => b.room_code ? String(b.room_code).toLowerCase() : '')
  );
  for (const rc of selectedRoomCodes) {
    if (rc && protectedRoomCodes.includes(rc)) {
      warnings.push('protected_room_selected');
      break;
    }
  }
  for (const rc of selectedRoomCodes) {
    if (rc && operatorRoomCodes.includes(rc)) {
      warnings.push('operator_room_selected');
      break;
    }
  }

  // Guest count less than selected beds
  if (
    typeof guest_count === 'number' &&
    guest_count > 0 &&
    selectedBedCount > 0 &&
    guest_count < selectedBedCount
  ) {
    warnings.push('guest_count_less_than_selected_beds');
  }

  // ── Result assembly ────────────────────────────────────────────────────────
  const hasConflict = conflictBeds.length > 0;
  const isValid     = blockers.length === 0;

  // Summary string
  let summary;
  if (isValid) {
    summary = 'Available: ' + proposedNights + ' night(s), ' +
              selectedBedCount + ' bed(s) selected, no conflicts detected.';
    if (warnings.length > 0) {
      summary += ' Warnings: ' + warnings.join(', ') + '.';
    }
  } else {
    summary = 'Blocked: ' + blockers.join(', ') + '.' +
              (warnings.length > 0 ? ' Warnings: ' + warnings.join(', ') + '.' : '');
  }

  return {
    is_valid:              isValid,
    has_conflict:          hasConflict,
    blockers,
    warnings,
    proposed_nights:       proposedNights,
    selected_bed_count:    selectedBedCount,
    selected_beds:         selectedBeds.slice(), // do not mutate caller's array
    conflict_beds:         conflictBeds.slice(),
    conflict_assignments:  conflictAssignments.slice(),
    availability_by_bed:   availabilityByBed,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  previewManualBookingAvailability,
  NON_BLOCKING_STATUSES,
};
