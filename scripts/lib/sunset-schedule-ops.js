'use strict';

/**
 * Sunset Schedule — operational aggregation helpers (lesson slots, equipment, prep counts).
 * Used by verify:sunset-portal-v1; mirrored in staff-query-api inline schedule UI.
 */

const DEFAULT_LESSON_SLOT_TIMES = ['11:00', '16:00'];

function normalizeSlotTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}:\d{2})/);
  if (!m) return s;
  const parts = m[1].split(':');
  return `${String(parts[0]).padStart(2, '0')}:${parts[1]}`;
}

function configuredLessonSlotTimes(profile, dateIso) {
  const slots = (profile && profile.lesson_slots_demo) || [];
  const times = [];
  for (const s of slots) {
    if (s.date && s.date !== dateIso) continue;
    const t = normalizeSlotTime(s.slot_time);
    if (t && !times.includes(t)) times.push(t);
  }
  if (!times.length) return DEFAULT_LESSON_SLOT_TIMES.slice();
  return times.sort();
}

function parseRowMetadata(row) {
  if (!row) return {};
  if (row.metadata && typeof row.metadata === 'object') return row.metadata;
  if (typeof row.metadata === 'string') {
    try { return JSON.parse(row.metadata); } catch { return {}; }
  }
  return {};
}

function rowQuantity(row) {
  const q = row && row.quantity != null ? Number(row.quantity) : 1;
  return Number.isFinite(q) && q > 0 ? q : 1;
}

function isLessonRow(row) {
  const st = String(row.service_type || row.staff_ui_service_type || '').toLowerCase();
  return st === 'lesson' || st === 'surf_lesson' || row._scheduleType === 'lesson';
}

function isBoardRow(row) {
  const st = String(row.service_type || row.staff_ui_service_type || '').toLowerCase();
  return /board/.test(st) || st === 'surfboard';
}

function isWetsuitRow(row) {
  const st = String(row.service_type || row.staff_ui_service_type || '').toLowerCase();
  return /wetsuit/.test(st);
}

function buildBookingGearIndex(rows, dateIso) {
  const index = new Map();
  for (const row of rows || []) {
    const iso = String(row.service_date || row.date || '').slice(0, 10);
    if (iso !== dateIso) continue;
    const code = row.booking_code || row._scheduleId || 'unknown';
    if (!index.has(code)) {
      index.set(code, { boards: 0, wetsuits: 0, lessonQty: 0, hasLesson: false });
    }
    const entry = index.get(code);
    const qty = rowQuantity(row);
    if (isLessonRow(row)) {
      entry.hasLesson = true;
      entry.lessonQty += qty;
    } else if (isBoardRow(row)) entry.boards += qty;
    else if (isWetsuitRow(row)) entry.wetsuits += qty;
    const meta = parseRowMetadata(row);
    if (meta.include_board === true || meta.needs_board === true) entry.boards = Math.max(entry.boards, qty);
    if (meta.include_wetsuit === true || meta.needs_wetsuit === true) entry.wetsuits = Math.max(entry.wetsuits, qty);
  }
  return index;
}

function equipmentLabelForLessonRow(row, gearIndex) {
  const code = row.booking_code || row._scheduleId;
  const meta = parseRowMetadata(row);
  let boards = 0;
  let wetsuits = 0;
  if (gearIndex && code && gearIndex.has(code)) {
    const g = gearIndex.get(code);
    boards = g.boards;
    wetsuits = g.wetsuits;
  }
  if (meta.include_board === true || meta.needs_board === true) boards = Math.max(boards, rowQuantity(row));
  if (meta.include_wetsuit === true || meta.needs_wetsuit === true) wetsuits = Math.max(wetsuits, rowQuantity(row));
  if (boards > 0 && wetsuits > 0) return 'board + wetsuit';
  if (boards > 0) return 'board only';
  if (wetsuits > 0) return 'wetsuit only';
  return 'no equipment';
}

function rowSourceLabel(row) {
  const src = String(row.record_source || row.source || '').toLowerCase();
  const meta = parseRowMetadata(row);
  const metaSrc = String(meta.source || meta.created_via || '').toLowerCase();
  const combined = `${src} ${metaSrc}`;
  if (/luna|agent|bot|whatsapp|guest/.test(combined)) return 'Luna';
  if (/staff|manual|import/.test(combined)) return 'Staff';
  if (row._isDemo) return 'Demo';
  return 'Staff';
}

function slotForLessonRow(row, slotTimes) {
  const t = normalizeSlotTime(row.slot_time || row.service_time);
  if (t && slotTimes.includes(t)) return t;
  if (t) {
    let best = slotTimes[0] || 'Other';
    for (const s of slotTimes) {
      if (t <= s) { best = s; break; }
      best = s;
    }
    return best;
  }
  return slotTimes[0] || 'Other';
}

function aggregateDayOps(rows, dateIso, profile) {
  const slotTimes = configuredLessonSlotTimes(profile, dateIso);
  const dayRows = (rows || []).filter((r) => String(r.service_date || r.date || '').slice(0, 10) === dateIso);
  const gearIndex = buildBookingGearIndex(dayRows, dateIso);
  const slots = slotTimes.map((time) => ({
    time,
    booked: 0,
    boards: 0,
    wetsuits: 0,
    rows: [],
  }));
  const slotMap = Object.fromEntries(slots.map((s) => [s.time, s]));
  const rentalBoards = [];
  const rentalWetsuits = [];
  let boardsLesson = 0;
  let wetsuitsLesson = 0;
  let boardsRental = 0;
  let wetsuitsRental = 0;

  for (const row of dayRows) {
    if (isLessonRow(row)) {
      const slotKey = slotForLessonRow(row, slotTimes);
      const bucket = slotMap[slotKey] || slotMap[slotTimes[0]];
      if (!bucket) continue;
      const qty = rowQuantity(row);
      bucket.booked += qty;
      bucket.rows.push(row);
      const code = row.booking_code || row._scheduleId;
      const gear = code && gearIndex.get(code);
      if (gear) {
        bucket.boards += gear.boards;
        bucket.wetsuits += gear.wetsuits;
        boardsLesson += gear.boards;
        wetsuitsLesson += gear.wetsuits;
      }
    } else if (isBoardRow(row)) {
      const code = row.booking_code;
      const linked = code && gearIndex.get(code) && gearIndex.get(code).hasLesson;
      if (linked) continue;
      rentalBoards.push(row);
      boardsRental += rowQuantity(row);
    } else if (isWetsuitRow(row)) {
      const code = row.booking_code;
      const linked = code && gearIndex.get(code) && gearIndex.get(code).hasLesson;
      if (linked) continue;
      rentalWetsuits.push(row);
      wetsuitsRental += rowQuantity(row);
    }
  }

  return {
    dateIso,
    slots,
    rentalBoards,
    rentalWetsuits,
    boardsTotal: boardsLesson + boardsRental,
    wetsuitsTotal: wetsuitsLesson + wetsuitsRental,
    boardsLesson,
    boardsRental,
    wetsuitsLesson,
    wetsuitsRental,
    gearIndex,
  };
}

module.exports = {
  DEFAULT_LESSON_SLOT_TIMES,
  normalizeSlotTime,
  configuredLessonSlotTimes,
  equipmentLabelForLessonRow,
  rowSourceLabel,
  aggregateDayOps,
  buildBookingGearIndex,
};
