/**
 * Stage 45a — Wolfhouse room/bed inventory source of truth (Airtable CSV exports).
 *
 * Shared by Staff Portal bed calendar, manual booking bed lists, and Staff Ask Luna
 * inventory queries. Demo rooms (DEMO-R*) and stage8 demo bookings are excluded
 * from Wolfhouse/Cami runtime views.
 *
 * @module wolfhouse-inventory-source
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WOLFHOUSE_CLIENT_SLUG = 'wolfhouse-somo';
const ROOMS_CSV = path.join(ROOT, 'database', 'Rooms-Grid view.csv');
const BEDS_CSV = path.join(ROOT, 'database', 'Beds-Grid view.csv');
const DEMO_ROOM_CODE_RE = /^DEMO-/i;
const MIN_REAL_ROOMS = 10;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function boolChecked(v) {
  return v === 'checked' || v === true || v === 'true';
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur); cur = ''; }
      else cur += ch;
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (cols[i] || '').trim(); });
    return row;
  });
}

function mapRoomFromCsv(row) {
  const roomCode = trimStr(row['Room ID']);
  if (!roomCode) return null;
  return {
    room_code: roomCode,
    name: trimStr(row['Room Name']) || null,
    house: trimStr(row.House) || null,
    room_type: trimStr(row['Room Type']) || null,
    capacity: numOr(row.Capacity, 0),
    fill_priority: numOr(row['Fill Priority'], 50),
    private_priority: numOr(row['Private Priority'], 50),
    gender_strategy: trimStr(row['Gender Strategy']) || 'Flexible',
    can_be_matrimonial: boolChecked(row['Can be Matrimonial']),
    often_used_by_operator: boolChecked(row['Often used By Operator']),
    sort_order: row['Room Sort / Round Robin Order']
      ? numOr(row['Room Sort / Round Robin Order'], null) : null,
    avoid_until_needed: boolChecked(row['Avoid Until Needed']),
    active: boolChecked(row.Active),
  };
}

function mapBedFromCsv(row) {
  const bedCode = trimStr(row['Bed ID']);
  const roomCode = trimStr(row['Room ID']);
  if (!bedCode || !roomCode) return null;
  const sellable = boolChecked(row.Sellable)
    || (bedCode === 'R3-B1' && boolChecked(row.Active));
  return {
    bed_code: bedCode,
    room_code: roomCode,
    bed_number: row['Bed Number'] ? numOr(row['Bed Number'], null) : null,
    bed_label: trimStr(row['Bed Label']) || null,
    planning_row_label: trimStr(row['Planning Row Label']) || null,
    active: boolChecked(row.Active),
    sellable,
  };
}

let _csvCache = null;

/**
 * Load Wolfhouse inventory from committed Airtable CSV exports.
 * @returns {{ source: string, rooms: object[], beds: object[] }}
 */
function loadWolfhouseInventoryFromCsv() {
  if (_csvCache) return _csvCache;
  if (!fs.existsSync(ROOMS_CSV) || !fs.existsSync(BEDS_CSV)) {
    _csvCache = { source: 'none', rooms: [], beds: [] };
    return _csvCache;
  }
  const rooms = parseCsv(fs.readFileSync(ROOMS_CSV, 'utf8')).map(mapRoomFromCsv).filter(Boolean);
  const beds = parseCsv(fs.readFileSync(BEDS_CSV, 'utf8')).map(mapBedFromCsv).filter(Boolean);
  _csvCache = { source: 'csv_export', rooms, beds };
  return _csvCache;
}

function clearWolfhouseInventoryCache() {
  _csvCache = null;
}

function isWolfhouseInventoryClient(clientSlug) {
  return trimStr(clientSlug) === WOLFHOUSE_CLIENT_SLUG;
}

function isDemoRoomCode(roomCode) {
  return DEMO_ROOM_CODE_RE.test(trimStr(roomCode));
}

function isDemoCalendarBlock(row) {
  if (!row) return false;
  if (isDemoRoomCode(row.room_code) || isDemoRoomCode(row.bed_code)) return true;
  if (/^DEMO-/i.test(trimStr(row.booking_code))) return true;
  if (trimStr(row.metadata_source) === 'stage8_demo') return true;
  return false;
}

function filterDemoRoomRows(rows) {
  return (rows || []).filter((r) => !isDemoRoomCode(r.room_code));
}

function countDistinctRooms(rows) {
  return new Set((rows || []).map((r) => r.room_code).filter(Boolean)).size;
}

function csvInventoryToBedCalendarRows(inventory) {
  const rows = [];
  const rooms = [...inventory.rooms]
    .filter((r) => r.active !== false)
    .sort((a, b) => {
      const ao = a.fill_priority != null ? a.fill_priority : 999;
      const bo = b.fill_priority != null ? b.fill_priority : 999;
      if (ao !== bo) return ao - bo;
      return String(a.room_code).localeCompare(String(b.room_code), undefined, { numeric: true });
    });

  for (const room of rooms) {
    const roomBeds = inventory.beds
      .filter((b) => b.room_code === room.room_code && b.active !== false)
      .sort((a, b) => {
        const an = a.bed_number != null ? a.bed_number : 999;
        const bn = b.bed_number != null ? b.bed_number : 999;
        if (an !== bn) return an - bn;
        return String(a.bed_code).localeCompare(String(b.bed_code), undefined, { numeric: true });
      });

    if (roomBeds.length === 0) {
      rows.push({
        room_id: null,
        room_code: room.room_code,
        room_name: room.name,
        house: room.house,
        room_type: room.room_type,
        capacity: room.capacity,
        room_sort_order: room.fill_priority,
        fill_priority: room.fill_priority,
        gender_strategy: room.gender_strategy,
        can_be_matrimonial: room.can_be_matrimonial,
        often_used_by_operator: room.often_used_by_operator,
        bed_id: null,
        bed_code: null,
        bed_label: null,
        bed_number: null,
        bed_planning_label: null,
        bed_active: null,
        bed_sellable: null,
      });
      continue;
    }

    for (const bed of roomBeds) {
      rows.push({
        room_id: null,
        room_code: room.room_code,
        room_name: room.name,
        house: room.house,
        room_type: room.room_type,
        capacity: room.capacity,
        room_sort_order: room.fill_priority,
        fill_priority: room.fill_priority,
        gender_strategy: room.gender_strategy,
        can_be_matrimonial: room.can_be_matrimonial,
        often_used_by_operator: room.often_used_by_operator,
        bed_id: null,
        bed_code: bed.bed_code,
        bed_label: bed.bed_label,
        bed_number: bed.bed_number,
        bed_planning_label: bed.planning_row_label,
        bed_active: bed.active,
        bed_sellable: bed.sellable,
      });
    }
  }
  return rows;
}

function mergePgBedIdsIntoCsvRows(csvRows, pgRows) {
  const pgByBed = new Map();
  for (const r of pgRows || []) {
    if (r.bed_code) pgByBed.set(r.bed_code, r);
  }
  return csvRows.map((r) => {
    const pg = r.bed_code ? pgByBed.get(r.bed_code) : null;
    if (!pg) return r;
    return {
      ...r,
      room_id: pg.room_id || r.room_id,
      bed_id: pg.bed_id || r.bed_id,
    };
  });
}

/**
 * Resolve bed-calendar room rows for Wolfhouse: drop DEMO rooms; fall back to CSV
 * when PG has fewer than MIN_REAL_ROOMS real rooms.
 */
function resolveBedCalendarRoomRows(clientSlug, pgRows) {
  if (!isWolfhouseInventoryClient(clientSlug)) return pgRows || [];
  const filtered = filterDemoRoomRows(pgRows);
  if (countDistinctRooms(filtered) >= MIN_REAL_ROOMS) return filtered;
  const inv = loadWolfhouseInventoryFromCsv();
  if (!inv.rooms.length) return filtered;
  const csvRows = csvInventoryToBedCalendarRows(inv);
  return mergePgBedIdsIntoCsvRows(csvRows, pgRows);
}

function filterDemoCalendarBlocks(blockRows) {
  return (blockRows || []).filter((r) => !isDemoCalendarBlock(r));
}

/** SQL fragment — exclude demo rooms for wolfhouse-somo only (aliases `r`, `c`). */
function wolfhouseExcludeDemoRoomsSql(roomAlias = 'r', clientAlias = 'c') {
  return `AND (${clientAlias}.slug <> '${WOLFHOUSE_CLIENT_SLUG}' OR ${roomAlias}.room_code NOT LIKE 'DEMO-%')`;
}

/** SQL fragment — exclude stage8 demo bookings for wolfhouse-somo only. */
function wolfhouseExcludeDemoBookingsSql(bookingAlias = 'b', bedAlias = 'bb', clientAlias = 'c') {
  return `
  AND (
    ${clientAlias}.slug <> '${WOLFHOUSE_CLIENT_SLUG}'
    OR (
      COALESCE(${bookingAlias}.metadata->>'source', '') <> 'stage8_demo'
      AND ${bookingAlias}.booking_code NOT LIKE 'DEMO-%'
      AND COALESCE(${bedAlias}.room_code, '') NOT LIKE 'DEMO-%'
      AND COALESCE(${bedAlias}.bed_code, '') NOT LIKE 'DEMO-%'
    )
  )`;
}

function getWolfhouseInventorySummary() {
  const inv = loadWolfhouseInventoryFromCsv();
  const activeRooms = inv.rooms.filter((r) => r.active !== false);
  const activeBeds = inv.beds.filter((b) => b.active !== false);
  return {
    source: inv.source,
    room_count: activeRooms.length,
    bed_count: activeBeds.length,
    rooms_csv: ROOMS_CSV,
    beds_csv: BEDS_CSV,
    fill_priority_range: activeRooms.length
      ? {
        min: Math.min(...activeRooms.map((r) => r.fill_priority)),
        max: Math.max(...activeRooms.map((r) => r.fill_priority)),
      }
      : null,
    gender_strategies: [...new Set(activeRooms.map((r) => r.gender_strategy))],
  };
}

module.exports = {
  WOLFHOUSE_CLIENT_SLUG,
  DEMO_ROOM_CODE_RE,
  MIN_REAL_ROOMS,
  ROOMS_CSV,
  BEDS_CSV,
  loadWolfhouseInventoryFromCsv,
  clearWolfhouseInventoryCache,
  isWolfhouseInventoryClient,
  isDemoRoomCode,
  isDemoCalendarBlock,
  filterDemoRoomRows,
  filterDemoCalendarBlocks,
  resolveBedCalendarRoomRows,
  csvInventoryToBedCalendarRows,
  wolfhouseExcludeDemoRoomsSql,
  wolfhouseExcludeDemoBookingsSql,
  getWolfhouseInventorySummary,
};
