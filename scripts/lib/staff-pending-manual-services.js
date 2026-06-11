'use strict';

/**
 * Stage 34a — shared read-only helpers for guest pending manual service records.
 */

const PENDING_ORIGIN = 'luna_guest_pending';
const DB_SOURCE = 'luna_guest';

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isPendingManualServiceRecord(row) {
  const r = row || {};
  const meta = parseMetadata(r.metadata);
  return r.source === DB_SOURCE
    && r.status === 'requested'
    && meta.pending_origin === PENDING_ORIGIN
    && meta.needs_scheduling === true
    && (r.service_date == null || r.service_date === '');
}

function serviceTypeLabel(serviceType) {
  const t = String(serviceType || '').toLowerCase();
  if (t === 'yoga') return 'Yoga';
  if (t === 'meal' || t === 'meals') return 'Meals/dinner';
  return t || 'Service';
}

function formatPendingManualServiceStaffLine(row) {
  const meta = parseMetadata(row.metadata);
  const label = serviceTypeLabel(row.service_type);
  const intent = meta.intent_status || meta.original_status || 'requested';
  if (row.service_type === 'yoga') {
    return `${label} — requested by guest, needs scheduling`;
  }
  if (row.service_type === 'meal') {
    if (intent === 'interested' || intent === 'deferred') {
      return `${label} — ${intent}, needs staff follow-up`;
    }
    return `${label} — requested by guest, needs scheduling`;
  }
  return `${label} — ${intent}, needs staff follow-up`;
}

function filterPendingManualServiceRecords(rows) {
  return (rows || []).filter(isPendingManualServiceRecord);
}

/** Staff-facing block for booking lookup / drawer (no raw metadata). */
function formatPendingManualServicesSection(rows) {
  const list = filterPendingManualServiceRecords(rows);
  if (!list.length) return '';
  const lines = ['Pending services:', ''];
  for (const row of list) {
    lines.push(`* ${formatPendingManualServiceStaffLine(row)}`);
  }
  return lines.join('\n');
}

module.exports = {
  PENDING_ORIGIN,
  DB_SOURCE,
  parseMetadata,
  isPendingManualServiceRecord,
  formatPendingManualServiceStaffLine,
  filterPendingManualServiceRecords,
  formatPendingManualServicesSection,
};
