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
const OPTIONAL_HEADERS = ['notes', 'updated_at'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

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

function normalizeHeaderCell(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function validateHeaders(headerRow) {
  const got = (headerRow || []).map(normalizeHeaderCell);
  if (got.length < REQUIRED_HEADERS.length) {
    return { ok: false, reason: 'header_missing_columns', got };
  }
  for (let i = 0; i < REQUIRED_HEADERS.length; i++) {
    if (got[i] !== REQUIRED_HEADERS[i]) {
      return { ok: false, reason: 'header_drift', expected: REQUIRED_HEADERS, got };
    }
  }
  for (let i = REQUIRED_HEADERS.length; i < got.length; i++) {
    if (got[i] && OPTIONAL_HEADERS.indexOf(got[i]) < 0 && REQUIRED_HEADERS.indexOf(got[i]) < 0) {
      return { ok: false, reason: 'header_unknown_column', column: got[i] };
    }
  }
  return { ok: true, headers: got };
}

function parseSheetRow(cells, rowNumber) {
  const unit_key = String(cells[0] == null ? '' : cells[0]).trim();
  const startRaw = cells[1];
  const endRaw = cells[2];
  const status = String(cells[3] == null ? '' : cells[3]).trim().toLowerCase();
  const external_uid = String(cells[4] == null ? '' : cells[4]).trim();
  const notes = cells.length > 5 ? String(cells[5] || '').trim().slice(0, 200) : '';

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
    notes,
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
 * @param {Array<Array>} rows — first row headers, rest data. No network.
 * @returns probe result (dry-run)
 */
function probeSheetRows(rows, opts) {
  opts = opts || {};
  const maps = opts.maps || {}; // unit_key -> bed_id
  const occupancy = opts.occupancy || {}; // bed_id -> existing assignment rows
  const connectionId = opts.connectionId || 'probe';

  if (!Array.isArray(rows) || rows.length < 1) {
    return { ok: false, status: 'error', reason: 'empty_sheet', writes: [] };
  }
  const merged = detectMergedCells(rows);
  if (merged.merged) {
    return { ok: false, status: 'error', reason: 'merged_cells', writes: [], merged };
  }
  const headers = validateHeaders(rows[0]);
  if (!headers.ok) {
    return { ok: false, status: 'error', reason: headers.reason, header: headers, writes: [] };
  }

  const body = rows.slice(1).filter((r) => r && r.some((c) => String(c == null ? '' : c).trim() !== ''));
  const events = [];
  const parseErrors = [];
  const seenUid = Object.create(null);

  body.forEach((cells, idx) => {
    const parsed = parseSheetRow(cells, idx + 2);
    if (!parsed.ok) {
      parseErrors.push(parsed);
      return;
    }
    if (seenUid[parsed.external_uid]) {
      const prev = seenUid[parsed.external_uid];
      if (prev.start_date !== parsed.start_date || prev.end_date !== parsed.end_date) {
        parseErrors.push({
          ok: false,
          reason: 'duplicate_uid_ambiguous',
          external_uid: parsed.external_uid,
          rowNumber: parsed.rowNumber,
        });
        return;
      }
    }
    seenUid[parsed.external_uid] = parsed;
    events.push(parsed);
  });

  if (parseErrors.some((e) => e.reason === 'duplicate_uid_ambiguous')) {
    return { ok: false, status: 'error', reason: 'duplicate_uid_ambiguous', parseErrors, writes: [] };
  }
  if (parseErrors.length && events.filter((e) => e.status === 'busy').length === 0) {
    return { ok: false, status: 'error', reason: 'no_valid_busy_rows', parseErrors, writes: [] };
  }

  const writes = [];
  const skipped = [];
  events.forEach((ev) => {
    const bedId = maps[ev.unit_key] || null;
    if (!bedId) {
      skipped.push({ ...ev, status: 'skipped_unmapped', skip_reason: 'unmapped_unit_key' });
      return;
    }
    if (ev.status === 'free') {
      writes.push({ action: 'cancel_owned_if_present', ...ev, bed_id: bedId });
      return;
    }
    const existing = occupancy[bedId] || [];
    const overlapping = existing.filter((row) =>
      rangesOverlap(ev.start_date, ev.end_date, row.assignment_start_date, row.assignment_end_date)
    );
    const decision = classifyOverlap(overlapping, connectionId);
    if (decision.action === 'skipped_conflict') {
      skipped.push({ ...ev, bed_id: bedId, status: 'skipped_conflict', skip_reason: decision.reason });
      return;
    }
    writes.push({
      action: decision.action,
      ...ev,
      bed_id: bedId,
      assignment_type: ASSIGNMENT_TYPE,
      metadata: buildOwnedBlockMetadata(connectionId, ev.external_uid),
    });
  });

  const busyWrites = writes.filter((w) => w.action === 'insert_owned' || w.action === 'upsert_owned');
  const headerSha = sha256Hex(REQUIRED_HEADERS.join(','));
  return {
    ok: true,
    status: 'dry_run',
    headerSha,
    eventCount: events.length,
    parseErrors,
    writes,
    skipped,
    empty: busyWrites.length === 0 && events.filter((e) => e.status === 'busy').length === 0,
    keepLastBlocks: true,
  };
}

function nextConnectionStatus(prev, probe) {
  if (!probe || probe.ok === false) {
    if (prev === 'healthy' || prev === 'stale') return 'stale';
    return 'error';
  }
  if (prev === 'disabled') return 'disabled';
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
};
