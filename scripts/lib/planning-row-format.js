/**
 * Planning "Bookings Sync" row shape — ported from hosted Sync Planning Sheet
 * Code - Prepare Bookings Sync Rows (read-only, no n8n).
 */

const { bookingCodeToAirtableRecordId } = require('./airtable-record-id');

/** Column order matches Google Sheet "Bookings Sync" tab append mapping. */
const PLANNING_CSV_COLUMNS = [
  'Booking Record ID',
  'Booking ID',
  'Booking Source',
  'Guest Name',
  'Guest Count',
  'Check In',
  'Check Out',
  'Nights',
  'Room ID',
  'Bed ID',
  'Requested Room Type',
  'Room Preference',
  'Guest Gender / Group Type',
  'Status',
  'Payment Status',
  'Assignment Status',
  'Display Text',
  'Color Type',
  'Last Synced At',
  'Notes',
];

const BOOKING_SOURCE_LABELS = {
  whatsapp: 'WhatsApp',
  manual_staff: 'Manual Staff',
  operator: 'Operator',
  other: 'Other',
};

function clean(value) {
  return String(value == null ? '' : value).trim();
}

/** Raw Postgres / JS date → YYYY-MM-DD (UTC). Must run before display formatting. */
function toIsoDateString(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return toIsoDateString(parsed);
  }
  return '';
}

/** @deprecated use toIsoDateString — kept for tests / exports */
function normalizeDate(value) {
  return toIsoDateString(value);
}

function nightsBetween(checkInIso, checkOutIso) {
  if (!checkInIso || !checkOutIso) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkInIso) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOutIso)) {
    return '';
  }
  const start = new Date(`${checkInIso}T00:00:00Z`);
  const end = new Date(`${checkOutIso}T00:00:00Z`);
  const diff = Math.round((end - start) / 86400000);
  return Number.isFinite(diff) && diff > 0 ? String(diff) : '';
}

function normalizeBedId(roomId, bedIdRaw) {
  const room = String(roomId || '')
    .trim()
    .toUpperCase();
  const raw = String(bedIdRaw || '').trim();

  if (!raw) return '';

  if (/^R\d+-B\d+$/i.test(raw)) {
    return raw.toUpperCase();
  }

  const bedNumberMatch = raw.match(/bed\s*(\d+)/i);
  if (room && bedNumberMatch) {
    return `${room}-B${bedNumberMatch[1]}`;
  }

  const numberOnlyMatch = raw.match(/^(\d+)$/);
  if (room && numberOnlyMatch) {
    return `${room}-B${numberOnlyMatch[1]}`;
  }

  return raw;
}

function statusDisplay(enumValue) {
  const s = clean(enumValue);
  if (!s) return '';
  if (s.includes('_')) {
    return s
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('_');
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function bookingSourceDisplay(value) {
  const key = clean(value).toLowerCase();
  return BOOKING_SOURCE_LABELS[key] || statusDisplay(value);
}

function formatDepositPaid(cents) {
  if (cents == null || cents === '') return '';
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n % 100 === 0) return `€${n / 100}`;
  return `€${(n / 100).toFixed(2)}`;
}

/** Build field bag compatible with hosted colorTypeFromFields / displayText. */
function fieldsFromPostgresRow(row, isoDates) {
  const paymentStatus = clean(row.payment_status);
  const depositPaid = formatDepositPaid(row.deposit_paid_cents);
  const checkInIso = isoDates?.checkInIso ?? toIsoDateString(row.assignment_start_date);
  const checkOutIso = isoDates?.checkOutIso ?? toIsoDateString(row.assignment_end_date);

  return {
    Booking: row.airtable_record_id || bookingCodeToAirtableRecordId(row.booking_code) || '',
    'Booking ID': row.booking_code || '',
    'Booking Source': bookingSourceDisplay(row.booking_source),
    'Guest Name': row.guest_name || '',
    'Guest Count': row.guest_count != null ? String(row.guest_count) : '',
    'Assignment Start Date': checkInIso,
    'Assignment End Date': checkOutIso,
    'Check In': checkInIso,
    'Check Out': checkOutIso,
    'Room ID': row.room_code || '',
    'Bed ID': row.bed_code || '',
    'Bed Label': row.bed_code || '',
    'Requested Room Type': row.requested_room_type || '',
    'Room Preference': row.room_preference || '',
    'Guest Gender / Group Type': row.guest_gender_group_type || '',
    Status: statusDisplay(row.status),
    'Payment Status': paymentStatus,
    'Assignment Status': statusDisplay(row.assignment_status),
    Package: row.package_code || '',
    'Deposit Paid': depositPaid,
    'Assignment Notes': row.assignment_notes || '',
  };
}

function colorTypeFromFields(fields) {
  const source = clean(fields['Booking Source']).toLowerCase();
  const status = clean(fields.Status).toLowerCase();
  const paymentStatus = clean(fields['Payment Status']).toLowerCase();
  const assignmentStatus = clean(fields['Assignment Status']).toLowerCase();

  if (status.includes('cancel') || status.includes('expired')) return 'cancelled';
  if (paymentStatus === 'failed') return 'conflict';
  if (assignmentStatus.includes('review') || status.includes('review')) return 'needs_review';
  if (source.includes('operator') || source.includes('manual')) return 'operator';

  if (paymentStatus === 'paid' || paymentStatus === 'deposit_paid') {
    return 'confirmed';
  }

  return 'hold';
}

function displayText(fields) {
  const guestName =
    clean(fields['Guest Name']) || clean(fields['Booking Guest Name']) || clean(fields.Name) || 'Guest';

  const paymentStatus = clean(fields['Payment Status']);
  const depositPaid = clean(fields['Deposit Paid']);
  const packageName = clean(fields.Package);
  const source = clean(fields['Booking Source']);

  const sourceLabel =
    source.toLowerCase().includes('operator') || source.toLowerCase().includes('manual')
      ? 'Manual'
      : 'Auto';

  const pieces = [guestName];
  if (paymentStatus) pieces.push(paymentStatus);
  if (depositPaid) pieces.push(depositPaid);
  if (packageName) pieces.push(packageName);
  pieces.push(sourceLabel);

  return pieces.join(' - ');
}

function formatPlanningRowFromPostgres(row, syncedAtIso) {
  const checkInIso = toIsoDateString(row.assignment_start_date);
  const checkOutIso = toIsoDateString(row.assignment_end_date);
  const nights = nightsBetween(checkInIso, checkOutIso);

  const fields = fieldsFromPostgresRow(row, { checkInIso, checkOutIso });
  const roomId = fields['Room ID'];
  const bedId = normalizeBedId(roomId, fields['Bed ID']);

  return {
    'Booking Record ID': fields.Booking || '',
    'Booking ID': fields['Booking ID'],
    'Booking Source': fields['Booking Source'],
    'Guest Name': fields['Guest Name'],
    'Guest Count': fields['Guest Count'],
    'Check In': checkInIso,
    'Check Out': checkOutIso,
    Nights: nights,
    'Room ID': roomId,
    'Bed ID': bedId,
    'Requested Room Type': fields['Requested Room Type'],
    'Room Preference': fields['Room Preference'],
    'Guest Gender / Group Type': fields['Guest Gender / Group Type'],
    Status: fields.Status,
    'Payment Status': fields['Payment Status'],
    'Assignment Status': fields['Assignment Status'],
    'Display Text': displayText(fields),
    'Color Type': colorTypeFromFields(fields),
    'Last Synced At': syncedAtIso || new Date().toISOString(),
    Notes: fields['Assignment Notes'],
  };
}

function escapeCsvCell(value) {
  const s = String(value == null ? '' : value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function planningRowToCsvLine(row, columns = PLANNING_CSV_COLUMNS) {
  return columns.map((col) => escapeCsvCell(row[col] ?? '')).join(',');
}

module.exports = {
  PLANNING_CSV_COLUMNS,
  normalizeBedId,
  normalizeDate,
  toIsoDateString,
  nightsBetween,
  colorTypeFromFields,
  displayText,
  fieldsFromPostgresRow,
  formatPlanningRowFromPostgres,
  escapeCsvCell,
  planningRowToCsvLine,
};
