'use strict';

/**
 * Calendar Inventory Bridge — apply a dry-run probe plan to occupancy.
 * Does not talk to Google. Callers supply occupancy + mutators.
 */

const {
  ASSIGNMENT_TYPE,
  syncMayMutate,
  generateOwnerBlockCode,
  buildOwnedBlockMetadata,
  CALENDAR_LEGEND_EN,
} = require('./external-calendar-inventory');

function applyProbePlan(plan, ctx) {
  ctx = ctx || {};
  const connectionId = ctx.connectionId;
  const occupancy = ctx.occupancy || {}; // bed_id -> rows (mutated copy)
  const created = [];
  const cancelled = [];
  const skipped = (plan.skipped || []).slice();
  const rejected = [];

  function rowsFor(bedId) {
    if (!occupancy[bedId]) occupancy[bedId] = [];
    return occupancy[bedId];
  }

  (plan.writes || []).forEach((op) => {
    if (op.action === 'cancel_owned_if_present') {
      const rows = rowsFor(op.bed_id);
      const keep = [];
      rows.forEach((row) => {
        if (syncMayMutate(row, connectionId)
          && row.external_uid === op.external_uid) {
          cancelled.push({ booking_id: row.booking_id, external_uid: op.external_uid });
        } else {
          keep.push(row);
        }
      });
      occupancy[op.bed_id] = keep;
      return;
    }
    if (op.action === 'insert_owned' || op.action === 'upsert_owned') {
      const rows = rowsFor(op.bed_id);
      const foreign = rows.filter((r) => !syncMayMutate(r, connectionId));
      if (foreign.length) {
        rejected.push({ reason: 'would_touch_foreign', external_uid: op.external_uid });
        return;
      }
      const existing = rows.find((r) => syncMayMutate(r, connectionId) && r.external_uid === op.external_uid);
      if (existing) {
        existing.assignment_start_date = op.start_date;
        existing.assignment_end_date = op.end_date;
        created.push({ action: 'upsert', booking_id: existing.booking_id, external_uid: op.external_uid });
        return;
      }
      const bookingId = 'xblk-' + (created.length + 1);
      rows.push({
        booking_id: bookingId,
        assignment_type: ASSIGNMENT_TYPE,
        assignment_start_date: op.start_date,
        assignment_end_date: op.end_date,
        guest_name: CALENDAR_LEGEND_EN,
        booking_code: generateOwnerBlockCode(op.start_date),
        external_uid: op.external_uid,
        metadata: buildOwnedBlockMetadata(connectionId, op.external_uid),
        status: 'blocked',
      });
      created.push({ action: 'insert', booking_id: bookingId, external_uid: op.external_uid });
    }
  });

  return {
    occupancy,
    created,
    cancelled,
    skipped,
    rejected,
    keepLastBlocks: plan.ok === false ? true : !!plan.keepLastBlocks,
  };
}

function occupancyUntouchedIfProbeFailed(before, after, plan) {
  if (plan && plan.ok) return true;
  return JSON.stringify(before) === JSON.stringify(after);
}

module.exports = {
  applyProbePlan,
  occupancyUntouchedIfProbeFailed,
};
