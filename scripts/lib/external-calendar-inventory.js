'use strict';

/**
 * Calendar Inventory Bridge — ownership + overlap contract (Slice 1)
 * and strict Google Sheet parse/probe (Slice 2).
 *
 * No network. No Google client. No DB writes.
 */

const crypto = require('crypto');

const ASSIGNMENT_TYPE = 'external_inventory_block';
const BOOKING_CODE_PREFIX = 'XBLK-';
const SOURCE_KIND = 'gsheet';
const CALENDAR_LABEL = 'owner_schedule_blocked';
const CALENDAR_LEGEND_I18N = 'calendar.legend.ownerScheduleBlocked';
const CALENDAR_LEGEND_EN = 'Owner schedule blocked';

const REQUIRED_HEADERS = ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'];
const OPTIONAL_HEADERS = [];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEFAULT_THEME_COLORS = Object.freeze(['BACKGROUND', 'UNSPECIFIED']);
const WHITE_EPS = 0.999;

/**
 * Occupancy grid contract
 * ----------------------
 * The connected Google Sheet is a bed × date colour grid:
 *   - column A = bed / unit names
 *   - row 1    = dates
 *   - each intersection cell is that bed on that date
 *
 * Booking authority is the *visible fill* from the Sheets API payload we
 * actually request (`effectiveFormat` + `userEnteredFormat` backgroundColor /
 * backgroundColorStyle). Cell text is never occupancy authority.
 *
 * Conditional formatting: we do not fetch `sheets.conditionalFormats` rules.
 * We request `effectiveFormat.backgroundColor` and
 * `effectiveFormat.backgroundColorStyle`, which Google already resolves after
 * conditional formats. A CF-only yellow cell therefore shows up as booked;
 * a CF that clears the fill shows up as available. `userEnteredFormat` is
 * used only when `effectiveFormat` is absent from the snapshot.
 *
 * Clear / available fills: absent, transparent (alpha 0), explicit white,
 * and theme BACKGROUND / UNSPECIFIED. Any other effective visible fill is
 * booked. Consecutive booked dates for one bed coalesce to a half-open range.
 *
 * Header width is the last parseable date column on row 1. Body rows may be
 * shorter (trailing clear). Any fill or data signal to the right of that last
 * date is `header_unknown_column` (zero writes, keep last).
 *
 * Date headers must strictly increase left-to-right. Duplicate dates stay
 * `date_header_duplicate`. Decreasing or out-of-order dates are
 * `date_header_order` (zero writes, keep last). No min/max recovery of a
 * reversed or shuffled grid.
 *
 * Cancellation is bounded to the represented half-open window
 * `[first header date, last header date + 1 day)` on a strictly ascending
 * header row. Fully outside owned inventory is preserved. A straddling owned
 * range is split: cancel the old UID, then insert remainder interval(s) using
 * the same connection ownership tags.
 */

const PROTECTED_ASSIGNMENT_TYPES = Object.freeze([
  'staff_block',
  'operator_block',
  'private_room_block',
]);

function isOwnedExternalBlock(row) {
  if (!row) return false;
  const at = String(row.assignment_type || '');
  if (at !== ASSIGNMENT_TYPE) return false;
  const meta = (row.metadata && row.metadata.external_calendar) || row.external_calendar || {};
  return !!meta.connection_id;
}

function syncMayMutate(row, connectionId) {
  if (!isOwnedExternalBlock(row)) return false;
  const meta = (row.metadata && row.metadata.external_calendar) || row.external_calendar || {};
  return String(meta.connection_id) === String(connectionId);
}

function classifyOverlap(existingRows, connectionId) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const foreign = existing.filter((r) => !syncMayMutate(r, connectionId));
  if (foreign.length) {
    return {
      action: 'skipped_conflict',
      reason: 'overlaps_non_owned',
      protected_types: foreign.map((r) => r.assignment_type || r.status || 'unknown'),
    };
  }
  const owned = existing.filter((r) => syncMayMutate(r, connectionId));
  if (owned.length) {
    return { action: 'upsert_owned', reason: 'existing_owned_block' };
  }
  return { action: 'insert_owned', reason: 'clear' };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

function buildOwnedBlockMetadata(connectionId, externalUid) {
  return {
    external_calendar: {
      connection_id: connectionId,
      external_uid: externalUid,
      source_kind: SOURCE_KIND,
      label: CALENDAR_LABEL,
    },
  };
}

function generateOwnerBlockCode(startDate) {
  const d = String(startDate || '').replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${BOOKING_CODE_PREFIX}${d}-${rand}`.toUpperCase();
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function parseIsoDate(value) {
  const s = String(value == null ? '' : value).trim();
  const m = DATE_RE.exec(s);
  if (!m) return { ok: false, reason: 'date_not_iso' };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, reason: 'date_invalid' };
  }
  if (typeof value === 'number' || /^[0-9]{5}(\.0+)?$/.test(s)) {
    return { ok: false, reason: 'date_excel_serial' };
  }
  return { ok: true, value: s };
}

function addDaysIso(iso, days) {
  const parsed = parseIsoDate(iso);
  if (!parsed.ok) return null;
  const m = DATE_RE.exec(parsed.value);
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return dt.toISOString().slice(0, 10);
}

function colorChannel(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function colorIsTransparent(color) {
  if (!color || typeof color !== 'object') return false;
  if (color.alpha == null) return false;
  return colorChannel(color.alpha) === 0;
}

function colorIsWhite(color) {
  if (!color || typeof color !== 'object') return false;
  const r = colorChannel(color.red);
  const g = colorChannel(color.green);
  const b = colorChannel(color.blue);
  if (r > 1 || g > 1 || b > 1) {
    return r >= 254 && g >= 254 && b >= 254;
  }
  return r >= WHITE_EPS && g >= WHITE_EPS && b >= WHITE_EPS;
}

function occupancyFormat(cell) {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
  if (cell.effectiveFormat && typeof cell.effectiveFormat === 'object') return cell.effectiveFormat;
  if (cell.userEnteredFormat && typeof cell.userEnteredFormat === 'object') return cell.userEnteredFormat;
  return null;
}

function styleIsDefaultOrClear(style) {
  if (!style || typeof style !== 'object') return false;
  const theme = style.themeColor == null ? '' : String(style.themeColor).toUpperCase();
  if (theme && DEFAULT_THEME_COLORS.indexOf(theme) >= 0) return true;
  if (style.rgbColor && (colorIsWhite(style.rgbColor) || colorIsTransparent(style.rgbColor))) return true;
  return false;
}

function styleIsBooked(style) {
  if (!style || typeof style !== 'object') return false;
  if (styleIsDefaultOrClear(style)) return false;
  const theme = style.themeColor == null ? '' : String(style.themeColor).toUpperCase();
  if (theme) return true;
  if (style.rgbColor && !colorIsWhite(style.rgbColor) && !colorIsTransparent(style.rgbColor)) return true;
  return false;
}

/**
 * True when the cell has a visible non-default fill in the snapshot we request.
 * effectiveFormat wins (conditional-format result). userEnteredFormat is fallback.
 */
function occupancyCellBooked(cell) {
  if (cell == null || typeof cell !== 'object' || Array.isArray(cell)) return false;
  const format = occupancyFormat(cell);
  if (!format) return false;
  if (format.backgroundColorStyle) {
    if (styleIsBooked(format.backgroundColorStyle)) return true;
    if (styleIsDefaultOrClear(format.backgroundColorStyle)) return false;
  }
  if (format.backgroundColor) {
    if (colorIsTransparent(format.backgroundColor) || colorIsWhite(format.backgroundColor)) return false;
    return true;
  }
  return false;
}

function cellDisplayText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell);
  }
  if (typeof cell !== 'object') return '';
  if (cell.formattedValue != null) return String(cell.formattedValue);
  if (cell.effectiveValue && cell.effectiveValue.stringValue != null) {
    return String(cell.effectiveValue.stringValue);
  }
  return '';
}

function parseDateHeaderCell(cell) {
  if (typeof cell === 'number') return { ok: false, reason: 'date_excel_serial' };
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) {
    if (cell.effectiveValue && typeof cell.effectiveValue.numberValue === 'number'
      && cell.formattedValue == null) {
      return { ok: false, reason: 'date_excel_serial' };
    }
  }
  const text = cellDisplayText(cell).trim();
  if (!text) return { ok: false, reason: 'date_header_invalid' };
  if (/^[0-9]{5}(\.0+)?$/.test(text)) return { ok: false, reason: 'date_excel_serial' };
  const parsed = parseIsoDate(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason === 'date_excel_serial' ? parsed.reason : 'date_header_invalid' };
  return { ok: true, value: parsed.value };
}

function parseOccupancyDateHeaders(headerRow) {
  const raw = Array.isArray(headerRow) ? headerRow.slice() : [];
  while (raw.length && cellDisplayText(raw[raw.length - 1]).trim() === '' && !occupancyCellBooked(raw[raw.length - 1])) {
    raw.pop();
  }
  if (raw.length < 2) {
    return { ok: false, reason: 'unknown_structure', dates: [] };
  }
  const dates = [];
  const seen = Object.create(null);
  for (let c = 1; c < raw.length; c++) {
    const parsed = parseDateHeaderCell(raw[c]);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, dates: [], col: c + 1 };
    }
    if (seen[parsed.value]) {
      return { ok: false, reason: 'date_header_duplicate', dates: [], value: parsed.value, col: c + 1 };
    }
    if (dates.length && !(parsed.value > dates[dates.length - 1].iso)) {
      return { ok: false, reason: 'date_header_order', dates: [], value: parsed.value, col: c + 1 };
    }
    seen[parsed.value] = true;
    dates.push({ col: c, iso: parsed.value });
  }
  if (!dates.length) return { ok: false, reason: 'unknown_structure', dates: [] };
  return { ok: true, dates };
}

function occupancyExternalUid(unitKey, startDate, endDate) {
  return ('grid:' + unitKey + ':' + startDate + ':' + endDate).slice(0, 160);
}

function cellHasOccupancySignal(cell) {
  return cellDisplayText(cell).trim() !== '' || occupancyCellBooked(cell);
}

function isoDateOnly(value) {
  if (value == null) return '';
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

/**
 * Represented Sheet window is half-open [first header date, last header date + 1 day).
 * Callers must pass strictly ascending headers (parseOccupancyDateHeaders).
 * Cancellation and remainder math use this span, not an unbounded bed history.
 */
function representedSheetWindow(dates) {
  const list = Array.isArray(dates) ? dates : [];
  const isos = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const iso = isoDateOnly(item && typeof item === 'object' ? item.iso : item);
    if (!DATE_RE.test(iso)) continue;
    if (isos.length && !(iso > isos[isos.length - 1])) return null;
    isos.push(iso);
  }
  if (!isos.length) return null;
  const end = addDaysIso(isos[isos.length - 1], 1);
  if (!end) return null;
  return { start: isos[0], end };
}

/**
 * Subtract half-open [cutStart, cutEnd) from [start, end).
 * Fully outside → original range. Fully inside → []. Partial → remaining owned intervals.
 */
function subtractHalfOpenRange(start, end, cutStart, cutEnd) {
  const s = isoDateOnly(start);
  const e = isoDateOnly(end);
  const cs = isoDateOnly(cutStart);
  const ce = isoDateOnly(cutEnd);
  if (!DATE_RE.test(s) || !DATE_RE.test(e) || !(s < e)) return [];
  if (!DATE_RE.test(cs) || !DATE_RE.test(ce) || !(cs < ce)) return [{ start: s, end: e }];
  if (e <= cs || s >= ce) return [{ start: s, end: e }];
  const remainders = [];
  if (s < cs) remainders.push({ start: s, end: cs });
  if (e > ce) remainders.push({ start: ce, end: e });
  return remainders.filter((r) => r.start < r.end);
}

function coalesceBookedDates(unitKey, dates, bookedFlags, rowNumber) {
  const ranges = [];
  let i = 0;
  while (i < dates.length) {
    if (!bookedFlags[i]) {
      i += 1;
      continue;
    }
    const start = dates[i].iso;
    let endExclusive = addDaysIso(start, 1);
    let j = i + 1;
    while (j < dates.length && bookedFlags[j] && dates[j].iso === endExclusive) {
      endExclusive = addDaysIso(dates[j].iso, 1);
      j += 1;
    }
    ranges.push({
      ok: true,
      rowNumber,
      unit_key: unitKey,
      start_date: start,
      end_date: endExclusive,
      status: 'busy',
      external_uid: occupancyExternalUid(unitKey, start, endExclusive),
    });
    i = j;
  }
  return ranges;
}

function failClosed(reason, extra) {
  return Object.assign({
    ok: false,
    status: 'error',
    reason,
    writes: [],
    skipped: [],
    keepLastBlocks: true,
  }, extra || {});
}

function normalizeHeaderCell(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function validateHeaders(headerRow) {
  const raw = (headerRow || []).map(normalizeHeaderCell);
  while (raw.length && raw[raw.length - 1] === '') raw.pop();
  if (raw.length !== REQUIRED_HEADERS.length) {
    return { ok: false, reason: raw.length < REQUIRED_HEADERS.length ? 'header_missing_columns' : 'header_unknown_column', got: raw };
  }
  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    if (raw[i] !== REQUIRED_HEADERS[i]) {
      return { ok: false, reason: 'header_drift', expected: REQUIRED_HEADERS.slice(), got: raw };
    }
  }
  return { ok: true, headers: raw };
}

function parseSheetRow(cells, rowNumber) {
  const unit_key = String(cells[0] == null ? '' : cells[0]).trim();
  const startRaw = cells[1];
  const endRaw = cells[2];
  const status = String(cells[3] == null ? '' : cells[3]).trim().toLowerCase();
  const external_uid = String(cells[4] == null ? '' : cells[4]).trim();

  if (!unit_key) return { ok: false, skip: true, reason: 'empty_unit_key', rowNumber };
  if (!external_uid) return { ok: false, skip: true, reason: 'empty_external_uid', rowNumber };
  if (status !== 'busy' && status !== 'free') {
    return { ok: false, skip: true, reason: 'status_invalid', rowNumber, status };
  }
  if (typeof startRaw === 'number' || typeof endRaw === 'number') {
    return { ok: false, skip: true, reason: 'date_excel_serial', rowNumber };
  }
  const start = parseIsoDate(startRaw);
  const end = parseIsoDate(endRaw);
  if (!start.ok) return { ok: false, skip: true, reason: start.reason, rowNumber };
  if (!end.ok) return { ok: false, skip: true, reason: end.reason, rowNumber };
  if (!(end.value > start.value)) {
    return { ok: false, skip: true, reason: 'end_not_after_start', rowNumber };
  }
  return {
    ok: true,
    rowNumber,
    unit_key,
    start_date: start.value,
    end_date: end.value,
    status,
    external_uid,
  };
}

function detectMergedCells(rows) {
  // Structural: any cell that is explicitly the merge marker object used by tests/adapters.
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (cell && typeof cell === 'object' && (cell.merged === true || cell.merge === true)) {
        return { merged: true, row: r + 1, col: c + 1 };
      }
    }
  }
  return { merged: false };
}

/**
 * @param {Array<Array>} rows — occupancy grid: row 0 dates, col 0 bed names.
 *   Cells may be strings (tests) or Sheets CellData snapshots with format.
 * @returns probe result (dry-run)
 */
function probeSheetRows(rows, opts) {
  opts = opts || {};
  const maps = opts.maps || {}; // unit_key -> bed_id
  const occupancy = opts.occupancy || {}; // bed_id -> existing assignment rows
  const connectionId = opts.connectionId || 'probe';

  if (!Array.isArray(rows) || rows.length < 1) {
    return failClosed('empty_sheet');
  }
  const merged = detectMergedCells(rows);
  if (merged.merged) {
    return failClosed('merged_cells', { merged });
  }
  const headers = parseOccupancyDateHeaders(rows[0]);
  if (!headers.ok) {
    return failClosed(headers.reason || 'unknown_structure', { header: headers });
  }

  const body = rows.slice(1);
  const events = [];
  const skipped = [];
  const seenBeds = Object.create(null);
  const mentionedBedIds = Object.create(null);
  let namedRowCount = 0;
  const lastDateCol = headers.dates[headers.dates.length - 1].col;
  const sheetWindow = representedSheetWindow(headers.dates);

  for (let r = 0; r < body.length; r++) {
    const cells = body[r] || [];
    for (let c = lastDateCol + 1; c < cells.length; c++) {
      if (cellHasOccupancySignal(cells[c])) {
        return failClosed('header_unknown_column', { rowNumber: r + 2, col: c + 1 });
      }
    }
  }

  for (let r = 0; r < body.length; r++) {
    const cells = body[r] || [];
    const rowNumber = r + 2;
    const unitKey = cellDisplayText(cells[0]).trim();
    const bookedFlags = headers.dates.map((d) => occupancyCellBooked(cells[d.col]));
    const anyBooked = bookedFlags.some(Boolean);
    if (!unitKey) {
      if (anyBooked) return failClosed('empty_bed_name', { rowNumber });
      continue;
    }
    if (seenBeds[unitKey]) {
      return failClosed('duplicate_bed_name', { rowNumber, unit_key: unitKey });
    }
    seenBeds[unitKey] = true;
    namedRowCount += 1;
    const ranges = coalesceBookedDates(unitKey, headers.dates, bookedFlags, rowNumber);
    const bedId = maps[unitKey] || null;
    if (!bedId) {
      if (anyBooked) {
        skipped.push({
          unit_key: unitKey,
          rowNumber,
          status: 'skipped_unmapped',
          skip_reason: 'unmapped_unit_key',
        });
      }
      continue;
    }
    mentionedBedIds[bedId] = unitKey;
    ranges.forEach((ev) => events.push(Object.assign({ bed_id: bedId }, ev)));
  }

  if (skipped.length) {
    return failClosed(skipped[0].skip_reason || 'unmapped_unit_key', {
      skipped,
      eventCount: events.length,
    });
  }

  const writes = [];
  const busyUids = Object.create(null);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const existing = occupancy[ev.bed_id] || [];
    const overlapping = existing.filter((row) =>
      rangesOverlap(ev.start_date, ev.end_date, row.assignment_start_date, row.assignment_end_date)
    );
    const decision = classifyOverlap(overlapping, connectionId);
    if (decision.action === 'skipped_conflict') {
      skipped.push({ ...ev, status: 'skipped_conflict', skip_reason: decision.reason });
      continue;
    }
    busyUids[ev.external_uid] = true;
    writes.push({
      action: decision.action,
      ...ev,
      assignment_type: ASSIGNMENT_TYPE,
      metadata: buildOwnedBlockMetadata(connectionId, ev.external_uid),
    });
  }

  if (skipped.length) {
    return failClosed(skipped[0].skip_reason || skipped[0].status, {
      skipped,
      eventCount: events.length,
    });
  }

  if (namedRowCount > 0 && sheetWindow) {
    Object.keys(occupancy).forEach((bedId) => {
      if (!mentionedBedIds[bedId]) return;
      (occupancy[bedId] || []).forEach((row) => {
        if (!syncMayMutate(row, connectionId)) return;
        const meta = (row.metadata && row.metadata.external_calendar) || {};
        const uid = row.external_uid || meta.external_uid;
        if (!uid || busyUids[uid]) return;
        const start = isoDateOnly(row.assignment_start_date);
        const end = isoDateOnly(row.assignment_end_date);
        if (!DATE_RE.test(start) || !DATE_RE.test(end) || !(start < end)) return;
        if (end <= sheetWindow.start || start >= sheetWindow.end) return;
        const remainders = subtractHalfOpenRange(start, end, sheetWindow.start, sheetWindow.end);
        writes.push({
          action: 'cancel_owned_if_present',
          bed_id: bedId,
          unit_key: mentionedBedIds[bedId],
          external_uid: uid,
          start_date: start,
          end_date: end,
          status: 'free',
        });
        remainders.forEach((rem) => {
          const remUid = occupancyExternalUid(mentionedBedIds[bedId], rem.start, rem.end);
          writes.push({
            action: 'insert_owned',
            bed_id: bedId,
            unit_key: mentionedBedIds[bedId],
            start_date: rem.start,
            end_date: rem.end,
            status: 'busy',
            external_uid: remUid,
            assignment_type: ASSIGNMENT_TYPE,
            metadata: buildOwnedBlockMetadata(connectionId, remUid),
          });
        });
      });
    });
  }

  const busyWrites = writes.filter((w) => w.action === 'insert_owned' || w.action === 'upsert_owned');
  const headerSha = sha256Hex(headers.dates.map((d) => d.iso).join(','));
  const empty = writes.length === 0 && busyWrites.length === 0;
  return {
    ok: true,
    status: 'dry_run',
    headerSha,
    eventCount: events.length,
    parseErrors: [],
    writes,
    skipped: [],
    empty,
    keepLastBlocks: true,
  };
}

function nextConnectionStatus(prev, probe) {
  if (!probe || probe.ok === false) {
    if (prev === 'healthy' || prev === 'stale') return 'stale';
    return 'error';
  }
  if (prev === 'disabled') return 'disabled';
  if (probe.empty) {
    if (prev === 'healthy') return 'healthy';
    if (prev === 'stale') return 'stale';
    return prev || 'pending';
  }
  return 'healthy';
}

const DEFAULT_ALLOWED_CLIENTS = Object.freeze(['wolfhouse-somo']);
const BLOCKED_CLIENTS = Object.freeze(['sunset', 'sunset-somo', 'sunset-sardinero']);

function allowedClientsFromEnv(env) {
  env = env || process.env;
  const raw = String(env.EXTERNAL_CALENDAR_CLIENTS || '').trim();
  if (!raw) return DEFAULT_ALLOWED_CLIENTS.slice();
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function ingestEnabled(env) {
  env = env || process.env;
  return env.EXTERNAL_CALENDAR_INGEST_ENABLED === 'true';
}

function clientAllowed(slug, env) {
  const s = String(slug || '').trim();
  if (!s) return false;
  if (BLOCKED_CLIENTS.indexOf(s) >= 0) return false;
  if (s.indexOf('sunset') === 0) return false;
  return allowedClientsFromEnv(env).indexOf(s) >= 0;
}

function bridgeAvailable(slug, env) {
  return ingestEnabled(env) && clientAllowed(slug, env);
}

const PUBLIC_ERROR_CODES = Object.freeze([
  'calendar_bridge_client_not_allowed',
  'calendar_bridge_disabled',
  'calendar_bridge_failed',
  'calendar_sync_rolled_back',
  'caller_authority_rejected',
  'client_not_found',
  'connection_id_required',
  'connection_not_found',
  'empty_sheet',
  'empty_bed_name',
  'duplicate_bed_name',
  'date_header_invalid',
  'date_header_duplicate',
  'date_header_order',
  'unknown_structure',
  'header_unknown_column',
  'header_drift',
  'invalid_connection',
  'connection_not_disabled',
  'confirm_name_required',
  'confirm_name_mismatch',
  'delete_failed',
  'invalid_map',
  'bed_not_in_tenant',
  'maps_array_required',
  'maps_save_failed',
  'merged_cells',
  'save_failed',
  'secret_ref_invalid',
  'sheet_over_limit',
  'sheet_snapshot_incomplete',
  'sheet_tab_missing',
  'sheet_fetch_required',
  'sheets_inaccessible',
  'sheets_malformed_json',
  'sheets_provider_5xx',
  'sheets_timeout',
  'sheets_token_denied',
  'overlap_conflict',
  'overlaps_non_owned',
  'unmapped_unit_key',
  'bridge_unavailable',
  'unknown_action',
]);

const PUBLIC_SKIP_CODES = Object.freeze([
  'unmapped_unit_key',
  'overlaps_non_owned',
]);

function storedErrorCode(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    return 'calendar_bridge_failed';
  }
  const code = String(value).trim();
  if (!code) return null;
  if (PUBLIC_ERROR_CODES.indexOf(code) >= 0) return code;
  return 'calendar_bridge_failed';
}

function publicErrorCode(value) {
  return storedErrorCode(value);
}

function publicSkipCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (!code) return null;
  if (PUBLIC_SKIP_CODES.indexOf(code) >= 0) return code;
  return null;
}

function sanitizeSkipped(skipped) {
  if (!Array.isArray(skipped)) return [];
  const out = [];
  for (let i = 0; i < skipped.length; i++) {
    const item = skipped[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const status = item.status === 'skipped_unmapped' || item.status === 'skipped_conflict'
      ? item.status
      : 'skipped';
    const row = { status };
    if (typeof item.rowNumber === 'number' && Number.isFinite(item.rowNumber)) {
      row.rowNumber = item.rowNumber;
    }
    if (typeof item.unit_key === 'string') {
      row.unit_key = item.unit_key.slice(0, 80);
    }
    const skip = publicSkipCode(item.skip_reason);
    if (skip) row.skip_reason = skip;
    out.push(row);
  }
  return out;
}

function sanitizeAuditFields(result) {
  const raw = result && typeof result === 'object'
    ? (result.error || result.reason || null)
    : null;
  return {
    error: storedErrorCode(raw),
  };
}

module.exports = {
  ASSIGNMENT_TYPE,
  BOOKING_CODE_PREFIX,
  SOURCE_KIND,
  CALENDAR_LABEL,
  CALENDAR_LEGEND_I18N,
  CALENDAR_LEGEND_EN,
  REQUIRED_HEADERS,
  OPTIONAL_HEADERS,
  PROTECTED_ASSIGNMENT_TYPES,
  isOwnedExternalBlock,
  syncMayMutate,
  classifyOverlap,
  rangesOverlap,
  buildOwnedBlockMetadata,
  generateOwnerBlockCode,
  sha256Hex,
  parseIsoDate,
  addDaysIso,
  occupancyCellBooked,
  cellDisplayText,
  parseDateHeaderCell,
  parseOccupancyDateHeaders,
  occupancyExternalUid,
  cellHasOccupancySignal,
  isoDateOnly,
  representedSheetWindow,
  subtractHalfOpenRange,
  coalesceBookedDates,
  validateHeaders,
  parseSheetRow,
  detectMergedCells,
  probeSheetRows,
  nextConnectionStatus,
  DEFAULT_ALLOWED_CLIENTS,
  BLOCKED_CLIENTS,
  allowedClientsFromEnv,
  ingestEnabled,
  clientAllowed,
  bridgeAvailable,
  PUBLIC_ERROR_CODES,
  PUBLIC_SKIP_CODES,
  storedErrorCode,
  publicErrorCode,
  publicSkipCode,
  sanitizeSkipped,
  sanitizeAuditFields,
};
