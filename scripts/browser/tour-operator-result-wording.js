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

  function tr(key, params) {
    var translate = input.translate || (typeof t === 'function' ? t : null);
    return translate ? translate(key, params || {}) : key;
  }
  function pushKey(key, params) { lines.push(tr(key, params)); }

  function contextLine() {
    var bits = [];
    var room = context.roomCode || (input.booking && input.booking.room_code) || '';
    var start = context.checkIn || context.releaseStart || (input.booking && input.booking.check_in) || '';
    var end = context.checkOut || context.releaseEnd || (input.booking && input.booking.check_out) || '';
    var code = context.bookingCode || (input.booking && input.booking.booking_code) || '';
    var name = context.operatorName || '';
    if (room) bits.push(tr('tourOperator.result.context.room', { room: room }));
    if (start && end) bits.push(tr('tourOperator.result.context.dates', { start: start, end: end }));
    if (code) bits.push(code);
    if (name) bits.push(name);
    if (bits.length) lines.push(bits.join(' · '));
  }

  function finish(kind, isErr, holdRetry) {
    return {
      kind: kind,
      badge: tr('tourOperator.result.badge.' + kind),
      lines: lines,
      isErr: !!isErr,
      holdRetry: !!holdRetry,
    };
  }

  if (input.lost && (action === 'create' || action === 'release')) {
    pushKey('tourOperator.result.uncertain.refreshBoth');
    contextLine();
    return finish('uncertain', true, true);
  }

  if (input.ok && action === 'create') {
    var booking = input.booking || {};
    pushKey('tourOperator.result.completed.blockSaved');
    if (!context.roomCode && booking.room_code) context.roomCode = booking.room_code;
    if (!context.checkIn && booking.check_in) context.checkIn = booking.check_in;
    if (!context.checkOut && booking.check_out) context.checkOut = booking.check_out;
    if (!context.bookingCode && booking.booking_code) context.bookingCode = booking.booking_code;
    contextLine();
    return finish('completed', false, false);
  }

  if (input.ok && action === 'release') {
    var rel = input.release || {};
    pushKey(rel.idempotent ? 'tourOperator.result.completed.releaseAlreadyDone' : 'tourOperator.result.completed.releaseDone');
    contextLine();
    if (rel.block_a && rel.block_a.booking_code) pushKey('tourOperator.result.detail.blockBooking', { label: 'A', booking: rel.block_a.booking_code });
    if (rel.block_b && rel.block_b.booking_code) pushKey('tourOperator.result.detail.blockBooking', { label: 'B', booking: rel.block_b.booking_code });
    return finish('completed', false, false);
  }

  if (input.ok && action === 'preview' && input.canCreate) {
    pushKey('tourOperator.result.ready.block');
    contextLine();
    return finish('ready', false, false);
  }

  if (input.ok && action === 'release-preview' && input.canRelease) {
    pushKey('tourOperator.result.ready.release');
    contextLine();
    var split = (input.preview && input.preview.split_phase) || {};
    if (split.block_a) pushKey('tourOperator.result.detail.blockDates', { label: 'A', start: split.block_a.check_in, end: split.block_a.check_out });
    if (split.block_b) pushKey('tourOperator.result.detail.blockDates', { label: 'B', start: split.block_b.check_in, end: split.block_b.check_out });
    if (split.release_fully_covers_block) pushKey('tourOperator.result.detail.wholeBlockReleased');
    return finish('ready', false, false);
  }

  var code = String(input.error || '');
  var actionable = input.actionable || [];
  var reasonKeys = {
    missing_required_fields: 'missingRequired',
    invalid_date_range: 'invalidDateRange',
    client_not_found: 'clientNotFound',
    room_not_found: 'roomNotFound',
    room_not_found_or_no_beds: 'roomNoBeds',
    room_not_found_or_no_active_beds: 'roomNoBeds',
    no_matching_operator_booking: 'noMatchingBlock',
    ambiguous_operator_booking_match: 'ambiguousBlock',
    release_window_does_not_overlap_original_block: 'releaseNoOverlap',
    postgres_overlap_conflicts_in_release_window: 'guestConflict',
    booking_id_mismatch: 'bookingMismatch',
    booking_not_found: 'bookingNotFound',
    not_operator_booking: 'notOperatorBooking',
    booking_not_active: 'bookingNotActive',
    release_dates_outside_block: 'releaseOutsideBlock',
    original_booking_not_found: 'originalNotFound',
    already_cancelled_ambiguous: 'alreadyCancelled',
    request_stuck_processing: 'requestProcessing',
    bed_conflicts: 'bedConflicts',
    'operator_name is required': 'operatorRequired',
    'room_code is required': 'roomRequired',
    'check_in and check_out must be YYYY-MM-DD': 'blockDatesRequired',
    'check_out must be after check_in': 'blockEndAfterStart',
    'confirm: true is required': 'confirmRequired',
    'invalid client slug': 'clientNotFound',
    'invalid or missing JSON body': 'requestUnreadable',
    'booking_id must be a valid UUID': 'chooseBlock',
    'release_start and release_end must be YYYY-MM-DD': 'releaseDatesRequired',
    'release_end must be after release_start': 'releaseEndAfterStart',
    'preview failed': 'checkFailed',
    'create failed': 'createFailed',
    'release failed': 'releaseFailed',
  };
  function pushReason(reasonCode, fallbackKey) {
    var suffix = reasonKeys[reasonCode];
    pushKey(suffix ? 'tourOperator.result.reason.' + suffix : fallbackKey);
  }

  var blockedCodes = {
    bed_conflicts: true, release_blocked: true, not_operator_booking: true,
    booking_not_active: true, release_dates_outside_block: true,
    booking_id_mismatch: true, already_cancelled_ambiguous: true,
    request_stuck_processing: true, no_matching_operator_booking: true,
    ambiguous_operator_booking_match: true,
    release_window_does_not_overlap_original_block: true,
    postgres_overlap_conflicts_in_release_window: true,
    missing_required_fields: true, invalid_date_range: true,
  };

  if (code === 'bed_conflicts' || (input.conflicts && input.conflicts.length && !input.canCreate)) {
    pushReason('bed_conflicts');
    (input.conflicts || []).forEach(function (row) {
      if (row) pushKey('tourOperator.result.detail.bedBookedBy', { bed: row.bed_code || '', booking: row.booking_code || '' });
    });
    contextLine();
    return finish('blocked', true, false);
  }

  if (code === 'release_blocked' || actionable.length) {
    pushKey('tourOperator.result.blocked.releaseNotReleased');
    actionable.forEach(function (item) { pushReason(item, 'tourOperator.result.blocked.release'); });
    if (!actionable.length && reasonKeys[code] && code !== 'release_blocked') pushReason(code);
    contextLine();
    return finish('blocked', true, false);
  }

  if (code.indexOf('Staff write actions are disabled') === 0) {
    pushKey('tourOperator.result.failed.savingDisabled');
    contextLine();
    return finish('failed', true, false);
  }

  if (code === 'request_stuck_processing' || code === 'already_cancelled_ambiguous') {
    pushReason(code);
    contextLine();
    return finish('blocked', true, true);
  }

  if (blockedCodes[code]) {
    pushReason(code, 'tourOperator.result.blocked.action');
    contextLine();
    return finish('blocked', true, code === 'request_stuck_processing');
  }

  if (reasonKeys[code]) {
    pushReason(code);
    contextLine();
    return finish('failed', true, false);
  }

  if (input.lost) {
    pushKey('tourOperator.result.failed.checkRetry');
    contextLine();
    return finish('failed', true, false);
  }

  pushKey('tourOperator.result.failed.generic');
  contextLine();
  return finish('failed', true, false);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { tourOperatorPlainResult: tourOperatorPlainResult };
}
