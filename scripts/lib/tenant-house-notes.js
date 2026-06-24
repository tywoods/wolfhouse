'use strict';

/**
 * Tenant "house notes" — owner-editable, client-facing info Luna shares with guests
 * on demand (parking, wifi, quiet hours, pets policy, etc.). One row per client_slug.
 *
 * Pure validation + DB helpers with an idempotent runtime ensure-table twin
 * (lunabox can't run migrations). Mirrors the tenant-services pattern.
 */

const TABLE = 'tenant_house_notes';
const NOTES_MAX = 8000;

function validateHouseNotes(raw) {
  const notes = String(raw == null ? '' : raw);
  if (notes.length > NOTES_MAX) return { ok: false, error: `notes too long (max ${NOTES_MAX})` };
  return { ok: true, notes };
}

async function ensureHouseNotesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug  TEXT NOT NULL UNIQUE,
      notes        TEXT NOT NULL DEFAULT '',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by   UUID
    )`);
}

async function getHouseNotes(client, { clientSlug }) {
  await ensureHouseNotesTable(client);
  const res = await client.query(
    `SELECT notes, updated_at FROM ${TABLE} WHERE client_slug = $1`,
    [clientSlug],
  );
  const row = res.rows[0];
  return { ok: true, notes: row ? row.notes : '', updated_at: row ? row.updated_at : null };
}

async function setHouseNotes(client, { clientSlug, notes, actor }) {
  const v = validateHouseNotes(notes);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  await ensureHouseNotesTable(client);
  const res = await client.query(
    `INSERT INTO ${TABLE} (client_slug, notes, updated_by)
          VALUES ($1, $2, $3::uuid)
     ON CONFLICT (client_slug) DO UPDATE
          SET notes = EXCLUDED.notes, updated_at = NOW(), updated_by = EXCLUDED.updated_by
      RETURNING notes, updated_at`,
    [clientSlug, v.notes, (actor && actor.staff_user_id) || null],
  );
  return { ok: true, notes: res.rows[0].notes, updated_at: res.rows[0].updated_at };
}

module.exports = {
  NOTES_MAX,
  validateHouseNotes,
  ensureHouseNotesTable,
  getHouseNotes,
  setHouseNotes,
};
