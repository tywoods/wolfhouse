'use strict';

/**
 * Sunset Schedule — canonical row normalizer (Slice 23).
 *
 * Injected before data-loader. Transforms authenticated Schedule API records into
 * immutable canonical normalized rows with stable identity and trust classification.
 *
 * Does not fetch, render, calculate aggregates, infer prices, or merge demo data
 * into trusted canonical rows.
 *
 * Requires runtime globals: getClient, getSunsetLocation (optional context helpers).
 */

function scheduleRowNormalizerClone(raw) {
  if (!raw) return null;
  try { return JSON.parse(JSON.stringify(raw)); } catch (_) { return Object.assign({}, raw); }
}

function scheduleRowNormalizerFreeze(row) {
  if (!row || typeof row !== 'object') return row;
  try { return Object.freeze(row); } catch (_) { return row; }
}

function scheduleRowMetaParse(row) {
  if (!row) return {};
  if (row.metadata && typeof row.metadata === 'object') return row.metadata;
  if (row.metadata) {
    try { return JSON.parse(row.metadata); } catch (_) { return {}; }
  }
  return {};
}

function scheduleRowMeta(row) {
  if (!row) return {};
  if (row._meta && typeof row._meta === 'object') return row._meta;
  var meta = scheduleRowMetaParse(row);
  row._meta = meta;
  return meta;
}

function scheduleRowIsPrivateLesson(row) {
  if (!row) return false;
  if (row._scheduleType === 'private_lesson') return true;
  var meta = scheduleRowMetaParse(row);
  if (String(meta.component || row.metadata_component || '').toLowerCase() === 'private_lesson') return true;
  if (String(meta.staff_ui_service_type || row.staff_ui_service_type || '').toLowerCase() === 'private_lesson') return true;
  return String(row.service_type || '').toLowerCase() === 'private_lesson';
}

function scheduleRowIsCourse(row) {
  if (!row) return false;
  var meta = scheduleRowMetaParse(row);
  if (String(meta.component || '').toLowerCase() === 'course') return true;
  if (String(meta.staff_ui_service_type || '').toLowerCase() === 'course') return true;
  var ui = String(row.staff_ui_service_type || meta.staff_ui_service_type || row.service_type || '').toLowerCase();
  return ui === 'course' || row._scheduleType === 'course';
}

function scheduleRowEffectivePaid(r) {
  if (!r) return false;
  if (String(r.booking_payment_status || '').toLowerCase() === 'paid') return true;
  var paid = Number(r.booking_amount_paid_cents || 0);
  var bal = r.booking_balance_due_cents;
  return paid > 0 && bal != null && Number(bal) <= 0;
}

function scheduleDeriveStableRowId(row, meta) {
  if (!row) return 'row:missing';
  if (row.service_record_id) return String(row.service_record_id);
  if (row._scheduleId && String(row._scheduleId).indexOf('demo-') === 0) return String(row._scheduleId);
  var bookingId = String(row.booking_id || '').trim();
  var dateIso = String(row.service_date || '').slice(0, 10);
  var component = String(meta.component || row.staff_ui_service_type || row.service_type || 'svc').toLowerCase();
  if (bookingId && dateIso) return 'bk:' + bookingId + ':' + dateIso + ':' + component;
  if (bookingId) return 'bk:' + bookingId;
  return 'row:' + dateIso + ':' + component + ':' + String(row.booking_code || 'anon').trim();
}

function scheduleEnsureRowId(row) {
  if (!row) return row;
  if (!row._scheduleId) {
    var meta = scheduleRowMetaParse(row);
    row._scheduleId = scheduleDeriveStableRowId(row, meta);
  }
  return row;
}

function scheduleRowSourceKind(row) {
  if (row && row._isDemo) return 'demo';
  if (row && (row._isDbManual || row.record_source === 'staff_manual')) return 'staff';
  if (row && (row._isLuna || row.record_source === 'luna_guest' || row.record_source === 'stripe')) return 'luna';
  return 'unknown';
}

function scheduleNormalizerApplyTrustFlags(r, ctx) {
  ctx = ctx || {};
  var trustedLocation = ctx.locationId || ctx.location_id || null;
  var meta = scheduleRowMetaParse(r);
  var rowLocation = r.location_id || meta.location_id || null;
  if (trustedLocation && rowLocation && String(rowLocation) !== String(trustedLocation)) {
    r._canonicalBlocked = true;
    r._canonicalBlockReason = 'location_conflict';
  }
  if (!String(r.booking_id || '').trim() && !r._isDemo) {
    r._canonicalBlocked = true;
    r._canonicalBlockReason = r._canonicalBlockReason || 'missing_booking_id';
  }
  if (r.record_source === 'staff_manual') r._isDbManual = true;
  else if (r.record_source === 'luna_guest' || r.record_source === 'stripe') r._isLuna = true;
  r._trustSource = scheduleRowSourceKind(r);
  return r;
}

function scheduleNormalizerApplyDisplayFields(r) {
  var meta = scheduleRowMetaParse(r);
  if (!r.slot_time) r.slot_time = meta.slot_time || null;
  if (!r.notes) r.notes = r.notes || meta.notes || null;
  if (r.needs_reply === true || r.needs_reply === 't') r._needsReply = true;
  if (meta.component) r.component = meta.component;
  if (String(meta.component || '').toLowerCase() === 'course' || String(meta.staff_ui_service_type || '').toLowerCase() === 'course') {
    r._scheduleType = 'course';
  } else if (String(meta.component || '').toLowerCase() === 'private_lesson' || String(meta.staff_ui_service_type || '').toLowerCase() === 'private_lesson') {
    r._scheduleType = 'private_lesson';
  } else if (String(meta.component || '').toLowerCase() === 'lesson' || String(meta.staff_ui_service_type || '').toLowerCase() === 'lesson') {
    r._scheduleType = 'lesson';
  }
  if (meta.lesson_category) r.lesson_category = meta.lesson_category;
  if (meta.course_id) r.course_id = meta.course_id;
  if (meta.course_label) r.course_label = meta.course_label;
  if (scheduleRowIsCourse(r)) r._scheduleType = 'course';
  if (scheduleRowIsPrivateLesson(r)) r._scheduleType = 'private_lesson';
  if (meta.bundle_id) r.bundle_id = meta.bundle_id;
  if (r.staff_ui_service_type) r.service_type = r.staff_ui_service_type;
  if (!r._scheduleType) {
    if (/lesson|surf_lesson/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
    else r._scheduleType = 'rental';
  }
  if (r._needsReply == null) r._needsReply = false;
  if (!r.phone && meta.guest_phone) r.phone = meta.guest_phone;
  if (r.service_time_local && !r.service_time) r.service_time = r.service_time_local;
  var ps = String(r.payment_status || '').toLowerCase();
  if (scheduleRowEffectivePaid(r)) r.payment_status = 'paid';
  else if (ps === 'pending' || ps === 'waiting_payment' || ps === 'not_requested') r.payment_status = 'unpaid';
  return r;
}

function scheduleNormalizeApiRow(raw, ctx, opts) {
  if (!raw || typeof raw !== 'object') return null;
  opts = opts || {};
  var r = scheduleRowNormalizerClone(raw);
  if (!r) return null;
  scheduleEnsureRowId(r);
  if (r.service_record_id) r._scheduleId = String(r.service_record_id);
  scheduleNormalizerApplyDisplayFields(r);
  scheduleNormalizerApplyTrustFlags(r, ctx);
  if (opts.freeze === false) return r;
  return scheduleRowNormalizerFreeze(r);
}

function scheduleNormalizeApiRowsBatch(rawRows, ctx) {
  var pending = [];
  var presentationOnlyRows = [];
  var errors = [];
  var serviceRecordIndex = {};

  (rawRows || []).forEach(function(raw, idx) {
    if (!raw || typeof raw !== 'object') {
      errors.push({ index: idx, reason: 'malformed_record' });
      return;
    }
    try {
      var norm = scheduleNormalizeApiRow(raw, ctx, { freeze: false });
      if (!norm) {
        errors.push({ index: idx, reason: 'normalize_failed' });
        return;
      }
      var srKey = norm.service_record_id ? String(norm.service_record_id) : null;
      if (srKey && serviceRecordIndex[srKey]) return;
      if (srKey) serviceRecordIndex[srKey] = norm._scheduleId;
      pending.push(norm);
    } catch (_) {
      errors.push({ index: idx, reason: 'normalize_exception' });
    }
  });

  var bookingCodeToId = {};
  var bookingIdLocation = {};
  pending.forEach(function(norm) {
    var code = String(norm.booking_code || '').trim();
    var bid = String(norm.booking_id || '').trim();
    if (code) {
      if (bookingCodeToId[code] && bookingCodeToId[code] !== bid) {
        norm._canonicalBlocked = true;
        norm._canonicalBlockReason = norm._canonicalBlockReason || 'booking_code_conflict';
        pending.forEach(function(other) {
          if (String(other.booking_code || '').trim() === code) {
            other._canonicalBlocked = true;
            other._canonicalBlockReason = other._canonicalBlockReason || 'booking_code_conflict';
          }
        });
      }
      if (!bookingCodeToId[code]) bookingCodeToId[code] = bid;
    }
    if (bid) {
      var loc = String(norm.location_id || '').trim();
      if (bookingIdLocation[bid] && loc && bookingIdLocation[bid] !== loc) {
        norm._canonicalBlocked = true;
        norm._canonicalBlockReason = 'tenant_location_conflict';
      }
      if (!bookingIdLocation[bid] && loc) bookingIdLocation[bid] = loc;
    }
  });

  var canonicalRows = pending.map(function(norm) { return scheduleRowNormalizerFreeze(norm); });

  return {
    canonicalRows: canonicalRows,
    presentationOnlyRows: presentationOnlyRows,
    errors: errors,
  };
}

function scheduleNormalizerContextFromRuntime(profile) {
  return {
    client: typeof getClient === 'function' ? getClient() : null,
    locationId: typeof getSunsetLocation === 'function' ? getSunsetLocation() : null,
    profile: profile || null,
  };
}

function scheduleNormalizeLoadedScheduleResponse(weekData, profile, ctx) {
  ctx = ctx || scheduleNormalizerContextFromRuntime(profile);
  var rawRows = [];
  (weekData || []).forEach(function(p) {
    (p.rows || []).forEach(function(r) { rawRows.push(r); });
  });
  var batch = scheduleNormalizeApiRowsBatch(rawRows, ctx);
  var normByDate = {};
  batch.canonicalRows.forEach(function(r) {
    var iso = String(r.service_date || '').slice(0, 10);
    if (!iso) return;
    if (!normByDate[iso]) normByDate[iso] = [];
    normByDate[iso].push(r);
  });
  var rebuiltWeek = (weekData || []).map(function(p) {
    var iso = p.dateIso;
    var dayRows = normByDate[iso] || [];
    var lessons = dayRows.filter(function(r) {
      return r._scheduleType === 'lesson' || r._scheduleType === 'course' || r._scheduleType === 'private_lesson';
    });
    var gear = dayRows.filter(function(r) { return r._scheduleType === 'rental'; });
    return {
      dateIso: iso,
      lessons: lessons,
      gear: gear,
      rows: dayRows,
    };
  });
  return {
    weekData: rebuiltWeek,
    canonicalRows: batch.canonicalRows,
    presentationOnlyRows: [],
    errors: batch.errors,
  };
}

function scheduleNormalizePresentationDemoRow(raw, ctx) {
  if (!raw || typeof raw !== 'object') return null;
  var r = scheduleRowNormalizerClone(raw);
  r._isDemo = true;
  scheduleEnsureRowId(r);
  if (!r._scheduleType) {
    if (/lesson|private_lesson|course/.test(String(r.service_type || ''))) r._scheduleType = 'lesson';
    else r._scheduleType = 'rental';
  }
  if (r._needsReply == null) r._needsReply = false;
  r._trustSource = 'demo';
  return scheduleRowNormalizerFreeze(r);
}
