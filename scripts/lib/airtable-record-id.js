/**
 * Map public booking_code (WH-rec…) to Airtable record id (rec…).
 * Same rule as scripts/sync-csv-to-postgres.js bookingCodeToAirtableId.
 */

function bookingCodeToAirtableRecordId(bookingCode) {
  if (!bookingCode) return null;
  const s = String(bookingCode).trim();
  if (!s.startsWith('WH-')) return null;
  const recordId = s.slice(3);
  if (!recordId || !recordId.startsWith('rec')) return null;
  return recordId;
}

module.exports = { bookingCodeToAirtableRecordId };
