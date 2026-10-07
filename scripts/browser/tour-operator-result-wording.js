/**
 * Wolfhouse Staff Tour Operator result wording.
 * Display only. Does not write, retry, or change API codes.
 * Sunset must not call this.
 */
function tourOperatorPlainResult(input) {
  input = input || {};
  var action = String(input.action || '');
  var context = input.context || {};
  var lines = [];

  function push(text) {
    if (text) lines.push(String(text));
  }

  function tr(key, fallback) {
    return typeof t === 'function' ? t(key) : fallback;
  }

  function contextLine() {
    var bits = [];
    var room = context.roomCode || (input.booking && input.booking.room_code) || '';
    var start = context.checkIn || context.releaseStart || (input.booking && input.booking.check_in) || '';
    var end = context.checkOut || context.releaseEnd || (input.booking && input.booking.check_out) || '';
    var code = context.bookingCode || (input.booking && input.booking.booking_code) || '';
    var name = context.operatorName || '';
    if (room) bits.push('Room ' + room);
    if (start && end) bits.push(start + ' → ' + end);
    if (code) bits.push(code);
    if (name) bits.push(name);
    if (bits.length) push(bits.join(' · '));
  }

  function finish(kind, badge, isErr, holdRetry) {
    return {
      kind: kind,
      badge: tr('tourOperator.result.badge.' + kind, badge),
      lines: lines,
      isErr: !!isErr,
      holdRetry: !!holdRetry,
    };
  }

  if (input.lost && (action === 'create' || action === 'release')) {
    push(tr('tourOperator.result.uncertain.refreshBoth', 'Outcome uncertain, refresh the block list and calendar before retrying'));
    contextLine();
    return finish('uncertain', 'Uncertain', true, true);
  }

  if (input.ok && action === 'create') {
    var booking = input.booking || {};
    push('Room block saved.');
    if (!context.roomCode && booking.room_code) context.roomCode = booking.room_code;
    if (!context.checkIn && booking.check_in) context.checkIn = booking.check_in;
    if (!context.checkOut && booking.check_out) context.checkOut = booking.check_out;
    if (!context.bookingCode && booking.booking_code) context.bookingCode = booking.booking_code;
    contextLine();
    return finish('completed', 'Completed', false, false);
  }

  if (input.ok && action === 'release') {
    var rel = input.release || {};
    push(rel.idempotent ? 'This release was already completed.' : 'Release completed.');
    contextLine();
    if (rel.block_a && rel.block_a.booking_code) push('Block A: ' + rel.block_a.booking_code);
    if (rel.block_b && rel.block_b.booking_code) push('Block B: ' + rel.block_b.booking_code);
    return finish('completed', 'Completed', false, false);
  }

  if (input.ok && action === 'preview' && input.canCreate) {
    push('This room can be blocked for those dates.');
    contextLine();
    return finish('ready', 'Ready', false, false);
  }

  if (input.ok && action === 'release-preview' && input.canRelease) {
    push('Those dates can be released.');
    contextLine();
    var split = (input.preview && input.preview.split_phase) || {};
    if (split.block_a) push('Block A: ' + split.block_a.check_in + ' → ' + split.block_a.check_out);
    if (split.block_b) push('Block B: ' + split.block_b.check_in + ' → ' + split.block_b.check_out);
    if (split.release_fully_covers_block) push('The whole block would be released.');
    return finish('ready', 'Ready', false, false);
  }

  var code = String(input.error || '');
  var actionable = input.actionable || [];
  var reasons = {
    missing_required_fields: 'Some required details are missing.',
    invalid_date_range: 'The dates are not a valid range.',
    client_not_found: 'This property was not found.',
    room_not_found: 'That room was not found.',
    room_not_found_or_no_beds: 'That room has no beds to block.',
    room_not_found_or_no_active_beds: 'That room has no beds to block.',
    no_matching_operator_booking: 'No matching operator block was found.',
    ambiguous_operator_booking_match: 'More than one operator block matches. Pick the block again.',
    release_window_does_not_overlap_original_block: 'Those dates do not overlap this block.',
    postgres_overlap_conflicts_in_release_window: 'Guest bookings already use those dates.',
    booking_id_mismatch: 'The selected block does not match this room.',
    booking_not_found: 'That block was not found.',
    not_operator_booking: 'That booking is not an operator block.',
    booking_not_active: 'That block is no longer active.',
    release_dates_outside_block: 'Those dates are outside the block.',
    original_booking_not_found: 'The original block was not found.',
    already_cancelled_ambiguous: 'That block is already cancelled. Refresh blocks before trying again.',
    request_stuck_processing: 'A release is still processing. Refresh blocks before trying again.',
    bed_conflicts: 'Those beds are already booked.',
    'operator_name is required': 'Enter an operator name.',
    'room_code is required': 'Choose a room.',
    'check_in and check_out must be YYYY-MM-DD': 'Use a start date and an end date.',
    'check_out must be after check_in': 'The end date must be after the start date.',
    'confirm: true is required': 'Confirm the action before saving.',
    'invalid client slug': 'This property was not found.',
    'invalid or missing JSON body': 'The request could not be read.',
    'booking_id must be a valid UUID': 'Choose an operator block.',
    'release_start and release_end must be YYYY-MM-DD': 'Check the release dates.',
    'release_end must be after release_start': 'The release end must be after the start.',
    'preview failed': 'The check did not finish. Try the check again.',
    'create failed': 'The block was not saved.',
    'release failed': 'The release did not complete.',
  };

  var blockedCodes = {
    bed_conflicts: true,
    release_blocked: true,
    not_operator_booking: true,
    booking_not_active: true,
    release_dates_outside_block: true,
    booking_id_mismatch: true,
    already_cancelled_ambiguous: true,
    request_stuck_processing: true,
    no_matching_operator_booking: true,
    ambiguous_operator_booking_match: true,
    release_window_does_not_overlap_original_block: true,
    postgres_overlap_conflicts_in_release_window: true,
    missing_required_fields: true,
    invalid_date_range: true,
  };

  if (code === 'bed_conflicts' || (input.conflicts && input.conflicts.length && !input.canCreate)) {
    push(reasons.bed_conflicts);
    (input.conflicts || []).forEach(function (row) {
      if (!row) return;
      push('Bed ' + (row.bed_code || '') + ' is booked by ' + (row.booking_code || ''));
    });
    contextLine();
    return finish('blocked', 'Blocked', true, false);
  }

  if (code === 'release_blocked' || actionable.length) {
    push('This release is blocked. The dates were not released.');
    actionable.forEach(function (item) {
      push(reasons[item] || 'This release is blocked.');
    });
    if (!actionable.length && reasons[code] && code !== 'release_blocked') push(reasons[code]);
    contextLine();
    return finish('blocked', 'Blocked', true, false);
  }

  if (code.indexOf('Staff write actions are disabled') === 0) {
    push('Saving is turned off on this server.');
    contextLine();
    return finish('failed', 'Failed', true, false);
  }

  if (code === 'request_stuck_processing' || code === 'already_cancelled_ambiguous') {
    push(reasons[code]);
    contextLine();
    return finish('blocked', 'Blocked', true, true);
  }

  if (blockedCodes[code]) {
    push(reasons[code] || 'This action is blocked.');
    contextLine();
    return finish('blocked', 'Blocked', true, code === 'request_stuck_processing');
  }

  if (reasons[code]) {
    push(reasons[code]);
    contextLine();
    return finish('failed', 'Failed', true, false);
  }

  if (input.lost) {
    push('The check did not finish. Try the check again.');
    contextLine();
    return finish('failed', 'Failed', true, false);
  }

  push('This did not go through.');
  contextLine();
  return finish('failed', 'Failed', true, false);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tourOperatorPlainResult: tourOperatorPlainResult };
}
