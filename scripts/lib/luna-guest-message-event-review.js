'use strict';

/**
 * Phase 23c.1 — Mark Meta handoff queue items reviewed (normalized JSON only).
 */

const {
  isMissingGuestMessageEventsTable,
  SELECT_GUEST_MESSAGE_EVENT_COLS,
  formatGuestMessageEventRow,
} = require('./luna-guest-message-events-sql');

const REVIEW_SOURCE = 'staff_portal_handoff_queue';
const MAX_REVIEW_NOTE_LEN = 500;
const DEFAULT_CLIENT_SLUG = 'wolfhouse-somo';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseNormalizedField(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function formatHandoffReviewSummary(review) {
  if (!review || review.reviewed !== true) return null;
  return {
    reviewed: true,
    reviewed_at: review.reviewed_at || null,
    reviewed_by: review.reviewed_by || null,
    review_note: review.review_note != null ? review.review_note : null,
    source: review.source || REVIEW_SOURCE,
  };
}

function isHandoffReviewed(normalized) {
  const norm = parseNormalizedField(normalized);
  return !!(norm && norm.handoff_review && norm.handoff_review.reviewed === true);
}

/**
 * @returns {{ ok: boolean, error?: string, input?: object }}
 */
function parseHandoffReviewInput(body) {
  const src = body || {};
  const clientSlug = trimStr(src.client_slug) || DEFAULT_CLIENT_SLUG;
  let reviewNote = trimStr(src.review_note) || null;
  if (reviewNote && reviewNote.length > MAX_REVIEW_NOTE_LEN) {
    reviewNote = reviewNote.slice(0, MAX_REVIEW_NOTE_LEN);
  }
  return {
    ok: true,
    input: {
      client_slug: clientSlug,
      review_note: reviewNote,
    },
  };
}

async function findGuestMessageEventById(pg, clientSlug, eventId) {
  try {
    const r = await pg.query(
      `SELECT ${SELECT_GUEST_MESSAGE_EVENT_COLS}
         FROM guest_message_events
        WHERE client_slug = $1
          AND id = $2::uuid
        LIMIT 1`,
      [clientSlug, eventId],
    );
    return { row: formatGuestMessageEventRow(r.rows[0] || null) };
  } catch (err) {
    if (isMissingGuestMessageEventsTable(err)) return { row: null, table_missing: true };
    throw err;
  }
}

/**
 * @param {object} pg
 * @param {{ client_slug: string, event_id: string, reviewed_by: string, review_note?: string|null }} input
 */
async function markGuestMessageEventHandoffReviewed(pg, input) {
  const payload = input || {};
  const clientSlug = payload.client_slug;
  const eventId = payload.event_id;
  const reviewedBy = trimStr(payload.reviewed_by) || null;

  const found = await findGuestMessageEventById(pg, clientSlug, eventId);
  if (found.table_missing) {
    return { ok: false, status: 503, error: 'guest_message_events table missing' };
  }
  if (!found.row) {
    return { ok: false, status: 404, error: 'guest_message_event not found' };
  }

  const norm = parseNormalizedField(found.row.normalized) || {};
  const existing = norm.handoff_review;
  if (existing && existing.reviewed === true) {
    return {
      ok: true,
      status: 200,
      already_reviewed: true,
      event_id: eventId,
      handoff_review: formatHandoffReviewSummary(existing),
    };
  }

  const handoffReview = {
    reviewed: true,
    reviewed_at: new Date().toISOString(),
    reviewed_by: reviewedBy,
    review_note: payload.review_note || null,
    source: REVIEW_SOURCE,
  };

  const updatedNorm = { ...norm, handoff_review: handoffReview };

  await pg.query(
    `UPDATE guest_message_events
        SET normalized = $3::jsonb,
            updated_at = NOW()
      WHERE client_slug = $1
        AND id = $2::uuid`,
    [clientSlug, eventId, JSON.stringify(updatedNorm)],
  );

  return {
    ok: true,
    status: 200,
    already_reviewed: false,
    event_id: eventId,
    handoff_review: formatHandoffReviewSummary(handoffReview),
  };
}

module.exports = {
  REVIEW_SOURCE,
  MAX_REVIEW_NOTE_LEN,
  parseHandoffReviewInput,
  formatHandoffReviewSummary,
  isHandoffReviewed,
  findGuestMessageEventById,
  markGuestMessageEventHandoffReviewed,
};
