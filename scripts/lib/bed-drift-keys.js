/**
 * Normalized bed-assignment keys for CSV ↔ Postgres drift (Phase 3b.0).
 */
const path = require('path');
const { readCsvFile } = require('./parse-csv');

const DB_DIR = path.join(__dirname, '..', '..', 'database');

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
  // Airtable "Assignment Start/End Date" columns use D/M/Y (see Check In/Out ISO columns in CSV).
  const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (dmy) {
    let [, dayPart, monthPart, y] = dmy;
    y = y.length === 2 ? `20${y}` : y;
    const d = parseInt(dayPart, 10);
    const m = parseInt(monthPart, 10);
    if (d > 12) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (m > 12) {
      return `${y}-${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
    }
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return toIsoDateString(parsed);
  }
  return '';
}

function normalizeBedCode(roomId, bedRaw) {
  const room = String(roomId || '')
    .trim()
    .toUpperCase();
  const raw = String(bedRaw || '').trim();
  if (!raw) return '';
  if (/^R\d+-B\d+$/i.test(raw)) return raw.toUpperCase();
  const bedNumberMatch = raw.match(/bed\s*(\d+)/i);
  if (room && bedNumberMatch) return `${room}-B${bedNumberMatch[1]}`;
  const numberOnlyMatch = raw.match(/^(\d+)$/);
  if (room && numberOnlyMatch) return `${room}-B${numberOnlyMatch[1]}`;
  return raw.toUpperCase();
}

function assignmentNaturalKey(bookingCode, bedCode, startIso, endIso) {
  return `${bookingCode}|${bedCode}|${startIso}|${endIso}`;
}

function loadCsvBedAssignments() {
  const rows = readCsvFile(path.join(DB_DIR, 'Booking Beds-Active Bed Assignments.csv'));
  const assignments = [];

  for (const row of rows) {
    const bookingCode = String(row['Booking ID'] || '').trim();
    const roomId = String(row['Room ID'] || row.Room || '').trim();
    const bedRaw = String(row.Bed || row['Bed Label'] || '').trim();
    const bedCode = normalizeBedCode(roomId, bedRaw);
    const startIso = toIsoDateString(
      row['Assignment Start Date'] || row['Check In'] || ''
    );
    const endIso = toIsoDateString(row['Assignment End Date'] || row['Check Out'] || '');
    if (!bookingCode || !bedCode || !startIso || !endIso) continue;

    assignments.push({
      booking_code: bookingCode,
      bed_code: bedCode,
      assignment_start_date: startIso,
      assignment_end_date: endIso,
      natural_key: assignmentNaturalKey(bookingCode, bedCode, startIso, endIso),
      source: 'csv',
    });
  }

  return assignments;
}

function loadCsvBookingCodes() {
  const rows = readCsvFile(path.join(DB_DIR, 'Bookings-Grid view.csv'));
  const map = new Map();
  for (const row of rows) {
    const code = String(row['Booking ID'] || '').trim();
    if (!code) continue;
    map.set(code, {
      booking_code: code,
      status: String(row.Status || '').trim(),
      payment_status: String(row['Payment Status'] || '').trim(),
      assignment_status: String(row['Assignment Status'] || '').trim(),
    });
  }
  return map;
}

module.exports = {
  toIsoDateString,
  normalizeBedCode,
  assignmentNaturalKey,
  loadCsvBedAssignments,
  loadCsvBookingCodes,
};
