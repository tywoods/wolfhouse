'use strict';

/**
 * Stage 56j — Luna + staff conversation notes on booking metadata.
 */

const { extractDietaryNotes } = require('./luna-booking-reactive-services-policy');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return { ...raw };
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function normalizeNotesList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((n) => n && trimStr(n.text))
    .map((n) => ({
      id: trimStr(n.id) || `note-${Date.now()}`,
      at: trimStr(n.at) || new Date().toISOString(),
      source: trimStr(n.source) || 'luna',
      text: trimStr(n.text),
      staff_user_id: n.staff_user_id != null ? trimStr(n.staff_user_id) : null,
    }));
}

/**
 * Extract note-worthy facts from a guest message for Luna to persist.
 *
 * @param {string} messageText
 * @param {object} fields
 * @returns {string[]}
 */
function extractLunaNoteCandidates(messageText, fields) {
  const notes = [];
  const text = trimStr(messageText);
  const f = fields || {};

  const dietary = extractDietaryNotes(text);
  if (dietary) notes.push(dietary);

  if (f.meals_request && f.meals_request.dietary_notes) {
    notes.push(trimStr(f.meals_request.dietary_notes));
  }

  const allergy = text.match(/\b(?:allerg(?:y|ies)|intoleran(?:t|ce))\b[^.?!\n]{0,80}/i);
  if (allergy) notes.push(trimStr(allergy[0]));

  const mobility = text.match(/\b(?:wheelchair|mobility|accessibility|accessible)\b[^.?!\n]{0,80}/i);
  if (mobility) notes.push(trimStr(mobility[0]));

  return [...new Set(notes.map(trimStr).filter(Boolean))];
}

async function loadBookingMetadata(pg, clientSlug, bookingId) {
  const res = await pg.query(
    `SELECT b.metadata
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid
      LIMIT 1`,
    [clientSlug, bookingId],
  );
  return parseMetadata(res.rows[0] && res.rows[0].metadata);
}

/**
 * @param {import('pg').Client} pg
 * @param {object} opts
 */
async function appendBookingLunaNotes(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const bookingId = trimStr(opts.booking_id);
  const messageText = trimStr(opts.message_text);
  const fields = opts.extracted_fields || opts.fields || {};
  const explicit = Array.isArray(opts.notes) ? opts.notes.map(trimStr).filter(Boolean) : [];
  const candidates = explicit.length
    ? explicit
    : extractLunaNoteCandidates(messageText, fields);

  if (!pg || !bookingId || !candidates.length) {
    return { attempted: false, skipped: candidates.length ? 'missing_pg_or_booking_id' : 'no_note_candidates' };
  }

  const metadata = await loadBookingMetadata(pg, clientSlug, bookingId);
  const existing = normalizeNotesList(metadata.luna_guest_notes);
  const existingTexts = new Set(existing.map((n) => n.text.toLowerCase()));
  const added = [];

  for (const text of candidates) {
    if (existingTexts.has(text.toLowerCase())) continue;
    const entry = {
      id: `luna-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      source: 'luna',
      text,
      staff_user_id: null,
    };
    existing.push(entry);
    existingTexts.add(text.toLowerCase());
    added.push(entry);
  }

  if (!added.length) {
    return { attempted: true, success: true, appended: [], deduped: true };
  }

  metadata.luna_guest_notes = existing;
  await pg.query(
    `UPDATE bookings b
        SET metadata = $3::jsonb, updated_at = NOW()
       FROM clients c
      WHERE b.client_id = c.id
        AND c.slug = $1
        AND b.id = $2::uuid`,
    [clientSlug, bookingId, JSON.stringify(metadata)],
  );

  return { attempted: true, success: true, appended: added, luna_guest_notes: existing };
}

/**
 * @param {import('pg').Client} pg
 * @param {object} opts
 */
async function appendBookingStaffNote(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const bookingId = trimStr(opts.booking_id);
  const text = trimStr(opts.text);
  const staffUserId = trimStr(opts.staff_user_id) || null;

  if (!pg || !bookingId || !text) {
    return { success: false, error: 'missing_required_fields' };
  }

  const metadata = await loadBookingMetadata(pg, clientSlug, bookingId);
  const existing = normalizeNotesList(metadata.luna_guest_notes);
  const entry = {
    id: `staff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source: 'staff',
    text,
    staff_user_id: staffUserId,
  };
  existing.push(entry);
  metadata.luna_guest_notes = existing;

  await pg.query(
    `UPDATE bookings b
        SET metadata = $3::jsonb, updated_at = NOW()
       FROM clients c
      WHERE b.client_id = c.id
        AND c.slug = $1
        AND b.id = $2::uuid`,
    [clientSlug, bookingId, JSON.stringify(metadata)],
  );

  return { success: true, note: entry, luna_guest_notes: existing };
}

function getLunaGuestNotesFromMetadata(metadata) {
  const meta = parseMetadata(metadata);
  return normalizeNotesList(meta.luna_guest_notes);
}

module.exports = {
  extractLunaNoteCandidates,
  appendBookingLunaNotes,
  appendBookingStaffNote,
  getLunaGuestNotesFromMetadata,
  normalizeNotesList,
};
