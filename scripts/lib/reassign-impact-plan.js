/**
 * Shared reassign impact plan for 3b.3a report (read-only).
 * Composes delete-all (cancel scope) + assign proposed beds (empty existing for assign phase).
 */
const { assignmentNaturalKey, toIsoDateString } = require('./bed-drift-keys');
const { loadAssignPlan, parseBedList } = require('./assign-booking-beds-plan');

function mapWouldDeleteRows(bookingCode, rows) {
  return (rows || []).map((row) => {
    const bedCode = String(row.bed_code || '').trim().toUpperCase();
    const startIso = toIsoDateString(row.assignment_start_date);
    const endIso = toIsoDateString(row.assignment_end_date);
    return {
      booking_bed_id: row.booking_bed_id,
      airtable_record_id: row.airtable_record_id || null,
      bed_code: bedCode,
      room_code: row.room_code,
      assignment_start_date: startIso,
      assignment_end_date: endIso,
      natural_key: assignmentNaturalKey(bookingCode, bedCode, startIso, endIso),
    };
  });
}

async function loadReassignPlan(client, flags) {
  const assignFlags = {
    clientSlug: flags.clientSlug,
    bookingCode: flags.bookingCode,
    airtableRecordId: flags.airtableRecordId,
    bedCodes: flags.bedCodes,
    checkIn: flags.checkIn,
    checkOut: flags.checkOut,
  };

  const plan = await loadAssignPlan(client, assignFlags, { ignoreExistingBookingBeds: true });
  if (plan.error) return plan;

  const wouldDelete = mapWouldDeleteRows(plan.bookingCode, plan.existingBedRowsBeforeDelete);

  return {
    ...plan,
    wouldDelete,
    wouldDeleteCount: wouldDelete.length,
  };
}

module.exports = {
  loadReassignPlan,
  parseBedList,
  mapWouldDeleteRows,
};
