'use strict';

/**
 * Calendar Inventory Bridge — apply a dry-run probe plan to occupancy.
 * Overlap is date-range specific: a future/past foreign booking on the same
 * bed does not reject a non-overlapping owner block.
 */

const {
  ASSIGNMENT_TYPE,
  syncMayMutate,
  generateOwnerBlockCode,
  buildOwnedBlockMetadata,
  CALENDAR_LEGEND_EN,
  rangesOverlap,
} = require('./external-calendar-inventory');

function applyProbePlan(plan, ctx) {
  ctx = ctx || {};
  const connectionId = ctx.connectionId;
  const occupancy = ctx.occupancy || {};
  const created = [];
  const cancelled = [];
  const skipped = (plan.skipped || []).slice();
  const rejected = [];

  if (!plan || plan.ok === false) {
    return {
      occupancy,
      created,
      cancelled,
      skipped,
      rejected,
      keepLastBlocks: true,
      wrote: false,
    };
  }

  function rowsFor(bedId) {
    if (!occupancy[bedId]) occupancy[bedId] = [];
    return occupancy[bedId];
  }

  const writes = plan.writes || [];
  const ordered = writes.filter((op) => op.action === 'cancel_owned_if_present')
    .concat(writes.filter((op) => op.action !== 'cancel_owned_if_present'));
  ordered.forEach((op) => {
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
      const foreignOverlap = rows.filter((r) => !syncMayMutate(r, connectionId)
        && rangesOverlap(op.start_date, op.end_date, r.assignment_start_date, r.assignment_end_date));
      if (foreignOverlap.length) {
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
    keepLastBlocks: !!plan.keepLastBlocks,
    wrote: created.length + cancelled.length > 0,
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
