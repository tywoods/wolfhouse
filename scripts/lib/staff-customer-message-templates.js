/**
 * Staff Portal — tenant-scoped customer outreach message templates (CRUD).
 * Scoped via clients.slug on every query. No outbound WhatsApp from this module.
 *
 * @module staff-customer-message-templates
 */

'use strict';

const TABLE = 'customer_message_templates';
const TITLE_MAX = 120;
const BODY_MAX = 4000;
const CHANNEL_DEFAULT = 'whatsapp';
const ALLOWED_CHANNELS = new Set(['whatsapp']);

function trimText(value, maxLen) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function normalizeTags(input) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of src) {
    const t = trimText(item, 40);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

function rowToPublic(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    channel: row.channel || CHANNEL_DEFAULT,
    tags: normalizeTags(row.tags),
    active: row.active !== false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isMissingTemplatesTable(err) {
  if (!err) return false;
  if (err.code === '42P01') return true;
  const msg = String(err.message || '');
  return /customer_message_templates/i.test(msg) && /does not exist|undefined table/i.test(msg);
}

function parseCreateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const title = trimText(b.title, TITLE_MAX);
  const templateBody = trimText(b.body, BODY_MAX);
  const channel = trimText(b.channel || CHANNEL_DEFAULT, 32).toLowerCase() || CHANNEL_DEFAULT;
  if (!title) return { ok: false, error: 'title is required' };
  if (!templateBody) return { ok: false, error: 'body is required' };
  if (!ALLOWED_CHANNELS.has(channel)) return { ok: false, error: 'unsupported channel' };
  return {
    ok: true,
    value: {
      title,
      body: templateBody,
      channel,
      tags: normalizeTags(b.tags),
    },
  };
}

function parseUpdateBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const patch = {};
  if (b.title != null) {
    const title = trimText(b.title, TITLE_MAX);
    if (!title) return { ok: false, error: 'title is required' };
    patch.title = title;
  }
  if (b.body != null) {
    const templateBody = trimText(b.body, BODY_MAX);
    if (!templateBody) return { ok: false, error: 'body is required' };
    patch.body = templateBody;
  }
  if (b.channel != null) {
    const channel = trimText(b.channel, 32).toLowerCase();
    if (!ALLOWED_CHANNELS.has(channel)) return { ok: false, error: 'unsupported channel' };
    patch.channel = channel;
  }
  if (b.tags != null) patch.tags = normalizeTags(b.tags);
  if (b.active != null) patch.active = !!b.active;
  if (!Object.keys(patch).length) return { ok: false, error: 'no fields to update' };
  return { ok: true, value: patch };
}

async function resolveClientId(pg, clientSlug) {
  const r = await pg.query('SELECT id FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
  return r.rows[0] && r.rows[0].id;
}

/**
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 */
async function listCustomerMessageTemplates(pg, clientSlug) {
  const r = await pg.query(
    `SELECT t.id::text AS id, t.title, t.body, t.channel, t.tags, t.active, t.created_at, t.updated_at
       FROM ${TABLE} t
       INNER JOIN clients c ON c.id = t.client_id
      WHERE c.slug = $1
        AND t.active = TRUE
      ORDER BY t.updated_at DESC, t.title ASC`,
    [clientSlug],
  );
  return r.rows.map(rowToPublic);
}

/**
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {object} body
 */
async function createCustomerMessageTemplate(pg, clientSlug, body) {
  const parsed = parseCreateBody(body);
  if (!parsed.ok) return { ok: false, status: 400, body: { success: false, error: parsed.error } };

  const clientId = await resolveClientId(pg, clientSlug);
  if (!clientId) return { ok: false, status: 404, body: { success: false, error: 'client not found' } };

  const { title, body: templateBody, channel, tags } = parsed.value;
  const ins = await pg.query(
    `INSERT INTO ${TABLE} (client_id, title, body, channel, tags)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)
     RETURNING id::text AS id, title, body, channel, tags, active, created_at, updated_at`,
    [clientId, title, templateBody, channel, JSON.stringify(tags)],
  );
  const row = ins.rows[0];
  if (!row) return { ok: false, status: 500, body: { success: false, error: 'create failed' } };
  return { ok: true, status: 201, body: { success: true, template: rowToPublic(row) } };
}

/**
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string} templateId
 * @param {object} body
 */
async function updateCustomerMessageTemplate(pg, clientSlug, templateId, body) {
  const id = trimText(templateId, 64);
  if (!id) return { ok: false, status: 400, body: { success: false, error: 'invalid template id' } };

  const parsed = parseUpdateBody(body);
  if (!parsed.ok) return { ok: false, status: 400, body: { success: false, error: parsed.error } };

  const sets = [];
  const params = [clientSlug, id];
  let idx = 3;
  const patch = parsed.value;
  if (patch.title != null) { sets.push(`title = $${idx++}`); params.push(patch.title); }
  if (patch.body != null) { sets.push(`body = $${idx++}`); params.push(patch.body); }
  if (patch.channel != null) { sets.push(`channel = $${idx++}`); params.push(patch.channel); }
  if (patch.tags != null) { sets.push(`tags = $${idx++}::jsonb`); params.push(JSON.stringify(patch.tags)); }
  if (patch.active != null) { sets.push(`active = $${idx++}`); params.push(patch.active); }
  sets.push('updated_at = NOW()');

  const r = await pg.query(
    `UPDATE ${TABLE} t
        SET ${sets.join(', ')}
       FROM clients c
      WHERE t.client_id = c.id
        AND c.slug = $1
        AND t.id = $2::uuid
      RETURNING t.id::text AS id, t.title, t.body, t.channel, t.tags, t.active, t.created_at, t.updated_at`,
    params,
  );
  if (!r.rows.length) {
    return { ok: false, status: 404, body: { success: false, error: 'template not found' } };
  }
  return { ok: true, status: 200, body: { success: true, template: rowToPublic(r.rows[0]) } };
}

/**
 * Soft-delete: active = false.
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string} templateId
 */
async function deactivateCustomerMessageTemplate(pg, clientSlug, templateId) {
  return updateCustomerMessageTemplate(pg, clientSlug, templateId, { active: false });
}

module.exports = {
  TABLE,
  TITLE_MAX,
  BODY_MAX,
  ALLOWED_CHANNELS,
  normalizeTags,
  parseCreateBody,
  parseUpdateBody,
  isMissingTemplatesTable,
  listCustomerMessageTemplates,
  createCustomerMessageTemplate,
  updateCustomerMessageTemplate,
  deactivateCustomerMessageTemplate,
};
