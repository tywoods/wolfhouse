'use strict';

/**
 * Staff WhatsApp notifications — settings CRUD, message build, gated send, dedupe audit.
 *
 * Env gates (defaults safe):
 *   STAFF_WHATSAPP_NOTIFICATIONS_ENABLED=false
 *   STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN=true
 *   STAFF_PORTAL_PUBLIC_BASE_URL — optional inbox deep-link base
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendStaffWhatsAppTemplate } = require('./luna-whatsapp-provider');

const SETTINGS_TABLE = 'client_notification_settings';
const EVENTS_TABLE = 'client_notification_events';
const AUTHORIZATIONS_TABLE='staff_alert_authorizations';
const NOTIFICATION_TYPES = ['new_conversation', 'human_needed'];
const MAX_RECIPIENTS = 10;
const NAME_MAX = 80;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUNSET_LOCATION_IDS = new Set(['sunset-somo', 'sunset-sardinero']);
const CLIENTS_JSON = path.join(__dirname, '..', '..', 'config', 'clients', 'clients.json');

let clientsRegistryCache = null;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeLocationId(v) {
  const s = trimStr(v);
  return s || null;
}

function normalizePhoneE164(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const hadPlus = s.charAt(0) === '+';
  s = s.replace(/[\s\-().]/g, '').replace(/[^\d+]/g, '');
  s = (hadPlus ? '+' : '+') + s.replace(/\+/g, '');
  if (!PHONE_RE.test(s)) return null;
  return s;
}

function isStaffNotificationsEnabled(env = process.env) {
  const raw = String((env || {}).STAFF_WHATSAPP_NOTIFICATIONS_ENABLED ?? 'false').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function isStaffNotificationsDryRun(env = process.env) {
  const raw = String((env || {}).STAFF_WHATSAPP_NOTIFICATIONS_DRY_RUN ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off' && raw !== 'no';
}

function loadClientsRegistry() {
  if (clientsRegistryCache) return clientsRegistryCache;
  try {
    clientsRegistryCache = JSON.parse(fs.readFileSync(CLIENTS_JSON, 'utf8'));
  } catch (_) {
    clientsRegistryCache = { clients: [] };
  }
  return clientsRegistryCache;
}

function resolveClientDisplayName(clientSlug, locationId) {
  const slug = trimStr(clientSlug);
  const loc = normalizeLocationId(locationId);
  const reg = loadClientsRegistry();
  const clients = Array.isArray(reg.clients) ? reg.clients : [];

  for (const c of clients) {
    const locs = Array.isArray(c.locations) ? c.locations : [];
    for (const l of locs) {
      if (loc && l.location_id === loc) return trimStr(l.display_name) || loc;
      if (!loc && (l.location_id === slug || c.client_slug === slug)) {
        return trimStr(l.display_name) || trimStr(c.display_name) || slug;
      }
    }
    if (c.client_slug === slug) return trimStr(c.display_name) || slug;
  }

  for (const c of clients) {
    for (const l of (c.locations || [])) {
      if (l.location_id === slug) return trimStr(l.display_name) || slug;
    }
  }

  return slug || 'Unknown client';
}

function buildStaffInboxDeepLink(clientSlug, conversationId, locationId, env = process.env) {
  const base = trimStr(env.STAFF_PORTAL_PUBLIC_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('client', trimStr(clientSlug));
  if (normalizeLocationId(locationId)) params.set('location', normalizeLocationId(locationId));
  if (trimStr(conversationId)) params.set('conversation', trimStr(conversationId));
  const pathPart = '/staff/inbox';
  const qs = params.toString();
  const relative = `${pathPart}?${qs}`;
  if (!base) return relative;
  return `${base}${relative}`;
}

function emptyTypeConfig() {
  return { enabled: false, recipients: [] };
}

function normalizeRecipient(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled !== false;
  const staffNumberId = trimStr(src.staff_number_id) || null;
  const phone = normalizePhoneE164(src.phone);
  const name = trimStr(src.name).slice(0, NAME_MAX) || null;
  return { staff_number_id: staffNumberId, name, phone, enabled };
}

function validateNotificationTypeConfig(raw, typeLabel) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled === true;
  const recipientsIn = Array.isArray(src.recipients) ? src.recipients : [];
  if (recipientsIn.length > MAX_RECIPIENTS) {
    return { ok: false, error: `${typeLabel}: max ${MAX_RECIPIENTS} recipients` };
  }

  const recipients = [];
  const phones = new Set();
  const staffNumberIds = new Set();
  for (const r of recipientsIn) {
    const norm = normalizeRecipient(r);
    if (norm.staff_number_id && !UUID_RE.test(norm.staff_number_id)) {
      return { ok: false, error: `${typeLabel}: invalid staff_number_id` };
    }
    if (norm.enabled && !norm.staff_number_id && !norm.phone) {
      return { ok: false, error: `${typeLabel}: staff_number_id or phone required when recipient enabled` };
    }
    if (norm.phone && !PHONE_RE.test(norm.phone)) {
      return { ok: false, error: `${typeLabel}: invalid phone (use E.164, e.g. +346...)` };
    }
    if (norm.staff_number_id) {
      if (staffNumberIds.has(norm.staff_number_id)) {
        return { ok: false, error: `${typeLabel}: duplicate staff_number_id ${norm.staff_number_id}` };
      }
      staffNumberIds.add(norm.staff_number_id);
    }
    if (norm.phone) {
      if (phones.has(norm.phone)) {
        return { ok: false, error: `${typeLabel}: duplicate phone ${norm.phone}` };
      }
      phones.add(norm.phone);
    }
    recipients.push(norm);
  }

  return { ok: true, enabled, recipients };
}

function validateNotificationSettingsPayload(body) {
  const newConv = validateNotificationTypeConfig(body && body.new_conversation, 'new_conversation');
  if (!newConv.ok) return newConv;
  const human = validateNotificationTypeConfig(body && body.human_needed, 'human_needed');
  if (!human.ok) return human;
  return {
    ok: true,
    new_conversation: { enabled: newConv.enabled, recipients: newConv.recipients },
    human_needed: { enabled: human.enabled, recipients: human.recipients },
  };
}

async function ensureNotificationTables(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${SETTINGS_TABLE} (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug       TEXT NOT NULL,
      location_id       TEXT NULL,
      notification_type TEXT NOT NULL CHECK (notification_type IN ('new_conversation', 'human_needed')),
      enabled           BOOLEAN NOT NULL DEFAULT FALSE,
      recipients        JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notification_settings_scope_type
      ON ${SETTINGS_TABLE} (client_slug, COALESCE(location_id, ''), notification_type)`);
  await pg.query(`
    CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_slug         TEXT NOT NULL,
      location_id         TEXT NULL,
      conversation_id     UUID NULL,
      notification_type   TEXT NOT NULL CHECK (notification_type IN ('new_conversation', 'human_needed')),
      handoff_event_key   TEXT NOT NULL DEFAULT 'initial',
      recipient_phone     TEXT NOT NULL,
      recipient_name      TEXT NULL,
      authorization_id    TEXT NULL,
      staff_number_id     UUID NULL,
      directory_revision  TEXT NULL,
      status              TEXT NOT NULL CHECK (status IN ('dry_run', 'pending', 'accepted', 'sent', 'failed', 'unknown', 'skipped')),
      reason              TEXT NULL,
      message_preview     TEXT NULL,
      provider_message_id TEXT NULL,
      error               TEXT NULL,
      reserved_at         TIMESTAMPTZ NULL,
      accepted_at         TIMESTAMPTZ NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notification_events_audit_dedupe
      ON ${EVENTS_TABLE} (
        client_slug,
        COALESCE(location_id, ''),
        conversation_id,
        notification_type,
        handoff_event_key,
        recipient_phone
      ) WHERE authorization_id IS NULL`);
  await pg.query(`CREATE TABLE IF NOT EXISTS ${AUTHORIZATIONS_TABLE} (
    authorization_id TEXT PRIMARY KEY,
    binding_fingerprint TEXT NOT NULL,
    binding JSONB NOT NULL,
    max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 2),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    spent_total INTEGER NOT NULL DEFAULT 0,
    spent_new_conversation INTEGER NOT NULL DEFAULT 0,
    spent_human_needed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )`);
  await pg.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_alert_live_claim
    ON ${EVENTS_TABLE} (authorization_id, client_slug, COALESCE(location_id, ''), conversation_id,
      notification_type, handoff_event_key, staff_number_id) WHERE authorization_id IS NOT NULL`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function reserveStaffAlertAttempt(pg, row) {
  const ownClient = pg && typeof pg.connect === 'function';
  const client = ownClient ? await pg.connect() : pg;
  if (!client || typeof client.query !== 'function') throw new Error('PostgreSQL client required');
  const binding = row.authorization_scope || {};
  const fingerprint = crypto.createHash('sha256').update(stableJson(binding)).digest('hex');
  let began = false;
  try {
    await client.query('BEGIN'); began = true;
    await client.query(`INSERT INTO ${AUTHORIZATIONS_TABLE}
      (authorization_id, binding_fingerprint, binding, max_attempts, expires_at)
      VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz) ON CONFLICT (authorization_id) DO NOTHING`,
    [row.authorization_id, fingerprint, JSON.stringify(binding), row.max_attempts, row.expires_at]);
    const locked = await client.query(`SELECT *, (expires_at > clock_timestamp()) AS unexpired
      FROM ${AUTHORIZATIONS_TABLE} WHERE authorization_id=$1 FOR UPDATE`, [row.authorization_id]);
    const auth = locked.rows[0];
    if (!auth || auth.binding_fingerprint !== fingerprint || Number(auth.max_attempts) !== row.max_attempts) {
      await client.query('ROLLBACK'); began=false; return { reserved:false, reason:'canary_authorization_reused' };
    }
    const prior = await client.query(`SELECT id::text AS id FROM ${EVENTS_TABLE}
      WHERE authorization_id=$1 AND client_slug=$2 AND COALESCE(location_id,'')=COALESCE($3::text,'')
        AND conversation_id=$4::uuid AND notification_type=$5 AND handoff_event_key=$6
        AND staff_number_id=$7::uuid LIMIT 1`,
    [row.authorization_id,row.client_slug,normalizeLocationId(row.location_id),row.conversation_id,row.notification_type,row.handoff_event_key,row.staff_number_id]);
    if (prior.rows[0]) { await client.query('COMMIT'); began=false; return {reserved:false,duplicate:true,event_id:prior.rows[0].id}; }
    if (auth.revoked_at || !auth.unexpired) { await client.query('ROLLBACK'); began=false; return {reserved:false,reason:auth.revoked_at?'canary_revoked':'canary_expired'}; }
    if (Number(auth.spent_total) >= Number(auth.max_attempts)) { await client.query('ROLLBACK'); began=false; return {reserved:false,reason:'canary_budget_exhausted'}; }
    const typeSpent=row.notification_type==='new_conversation'?Number(auth.spent_new_conversation):Number(auth.spent_human_needed);
    if (typeSpent>=1) { await client.query('ROLLBACK'); began=false; return {reserved:false,reason:'canary_type_budget_exhausted'}; }
    const ins=await client.query(`INSERT INTO ${EVENTS_TABLE}
      (authorization_id,client_slug,location_id,conversation_id,notification_type,handoff_event_key,staff_number_id,
       recipient_phone,recipient_name,directory_revision,status,message_preview,reserved_at)
      VALUES ($1,$2,$3,$4::uuid,$5,$6,$7::uuid,$8,$9,$10,'pending',$11,clock_timestamp()) RETURNING id::text AS id`,
    [row.authorization_id,row.client_slug,normalizeLocationId(row.location_id),row.conversation_id,row.notification_type,row.handoff_event_key,row.staff_number_id,row.recipient_phone,row.recipient_name||null,row.directory_revision,row.message_preview||null]);
    await client.query(`UPDATE ${AUTHORIZATIONS_TABLE} SET spent_total=spent_total+1,
      spent_new_conversation=spent_new_conversation+CASE WHEN $2='new_conversation' THEN 1 ELSE 0 END,
      spent_human_needed=spent_human_needed+CASE WHEN $2='human_needed' THEN 1 ELSE 0 END,
      updated_at=clock_timestamp() WHERE authorization_id=$1`,[row.authorization_id,row.notification_type]);
    await client.query('COMMIT'); began=false; return {reserved:true,duplicate:false,event_id:ins.rows[0].id};
  } catch(error) { if(began) await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { if(ownClient) client.release(); }
}

async function getNotificationSettings(pg, { clientSlug, locationId }) {
  const slug = trimStr(clientSlug);
  const loc = normalizeLocationId(locationId);
  const out = {
    client_slug: slug,
    location_id: loc,
    new_conversation: emptyTypeConfig(),
    human_needed: emptyTypeConfig(),
  };
  if (!slug) return out;

  const res = await pg.query(
    `SELECT notification_type, enabled, recipients
       FROM ${SETTINGS_TABLE}
      WHERE client_slug = $1
        AND COALESCE(location_id, '') = COALESCE($2::text, '')`,
    [slug, loc],
  );

  for (const row of res.rows) {
    const type = trimStr(row.notification_type);
    if (!NOTIFICATION_TYPES.includes(type)) continue;
    const recipients = Array.isArray(row.recipients)
      ? row.recipients.map((r) => normalizeRecipient(r))
      : [];
    out[type] = { enabled: row.enabled === true, recipients };
  }
  return out;
}

async function putNotificationSettings(pg, { clientSlug, locationId, settings, actor }) {
  const slug = trimStr(clientSlug);
  if (!slug) return { ok: false, status: 400, error: 'client_slug required' };
  const v = validateNotificationSettingsPayload(settings || {});
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  await ensureNotificationTables(pg);
  const loc = normalizeLocationId(locationId);

  for (const type of NOTIFICATION_TYPES) {
    const cfg = v[type];
    const locKey = loc || '';
    const upd = await pg.query(
      `UPDATE ${SETTINGS_TABLE}
          SET enabled = $4,
              recipients = $5::jsonb,
              updated_at = NOW()
        WHERE client_slug = $1
          AND COALESCE(location_id, '') = $2
          AND notification_type = $3`,
      [slug, locKey, type, cfg.enabled === true, JSON.stringify(cfg.recipients)],
    );
    if (!upd.rowCount) {
      await pg.query(
        `INSERT INTO ${SETTINGS_TABLE} (client_slug, location_id, notification_type, enabled, recipients)
              VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [slug, loc, type, cfg.enabled === true, JSON.stringify(cfg.recipients)],
      );
    }
  }

  return { ok: true, settings: await getNotificationSettings(pg, { clientSlug: slug, locationId: loc }) };
}

function buildNewConversationMessage(ctx) {
  const guestPhone = trimStr(ctx.guest_phone) || 'unknown';
  const guestName = trimStr(ctx.guest_name) || 'unknown';
  const clientName = resolveClientDisplayName(ctx.client_slug, ctx.location_id);
  const inbox = buildStaffInboxDeepLink(ctx.client_slug, ctx.conversation_id, ctx.location_id, ctx.env);
  return [
    'New Luna conversation started.',
    '',
    `Guest: ${guestPhone}`,
    `Name: ${guestName}`,
    `Client: ${clientName}`,
    '',
    'Open inbox:',
    inbox,
  ].join('\n');
}

function buildHumanNeededMessage(ctx) {
  const guestPhone = trimStr(ctx.guest_phone) || 'unknown';
  const guestName = trimStr(ctx.guest_name) || 'unknown';
  const clientName = resolveClientDisplayName(ctx.client_slug, ctx.location_id);
  const reason = trimStr(ctx.reason) || 'No reason provided';
  const inbox = buildStaffInboxDeepLink(ctx.client_slug, ctx.conversation_id, ctx.location_id, ctx.env);
  return [
    'Luna needs human help.',
    '',
    `Guest: ${guestPhone}`,
    `Name: ${guestName}`,
    `Client: ${clientName}`,
    `Reason: ${reason}`,
    '',
    'Open inbox:',
    inbox,
  ].join('\n');
}

function buildNotificationMessage(notificationType, ctx) {
  if (notificationType === 'human_needed') return buildHumanNeededMessage(ctx);
  return buildNewConversationMessage(ctx);
}

function handoffEventKeyForType(notificationType, handoffEventKey) {
  if (!NOTIFICATION_TYPES.includes(trimStr(notificationType))) return null;
  return trimStr(handoffEventKey) || null;
}

function validateStaffAlertCanaryAuthorization(env = process.env, input = {}, now = new Date()) {
  // Default-empty, dispatcher-owned authority. This is intentionally not browser input.
  let authorization;
  try { authorization = JSON.parse(typeof (env || {}).STAFF_ALERT_CANARY_AUTHORIZATION === 'string'
    ? env.STAFF_ALERT_CANARY_AUTHORIZATION : ''); } catch (_) { authorization = null; }
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    return { ok: false, reason: 'canary_authorization_missing' };
  }

  const authId = typeof authorization.authorization_id === 'string' ? authorization.authorization_id.trim() : '';
  const deployment = typeof authorization.deployment === 'string' ? authorization.deployment.trim() : '';
  const trustedDeployment = typeof (env || {}).LUNA_DEPLOYMENT === 'string' ? env.LUNA_DEPLOYMENT.trim() : '';
  const senderId = typeof authorization.sender_phone_number_id === 'string' ? authorization.sender_phone_number_id.trim() : '';
  const trustedSenderId = typeof (env || {}).WHATSAPP_PHONE_NUMBER_ID === 'string' ? env.WHATSAPP_PHONE_NUMBER_ID.trim() : '';
  const approvedClientSlug = typeof authorization.client_slug === 'string' ? authorization.client_slug.trim() : '';
  const actualClientSlug = typeof input.client_slug === 'string' ? input.client_slug.trim() : '';
  const hasLocation = Object.prototype.hasOwnProperty.call(authorization, 'location_id');
  const approvedLocation = authorization.location_id;
  const actualLocation = input.location_id == null ? null : input.location_id;
  const approvedRecipientId = typeof authorization.staff_number_id === 'string' ? authorization.staff_number_id.trim().toLowerCase() : '';
  const actualRecipientId = typeof input.staff_number_id === 'string' ? input.staff_number_id.trim().toLowerCase() : '';
  const approvedPhone = typeof authorization.recipient_phone === 'string'
    ? normalizePhoneE164(authorization.recipient_phone) : null;
  const actualPhone = typeof input.phone === 'string' ? normalizePhoneE164(input.phone) : null;
  const approvedRevision = typeof authorization.directory_revision === 'string' ? authorization.directory_revision : '';
  const actualRevision = typeof input.directory_revision === 'string' ? input.directory_revision : '';
  const approvedGuestPhone = typeof authorization.approved_guest_phone === 'string'
    ? normalizePhoneE164(authorization.approved_guest_phone) : null;
  const actualGuestPhone = typeof input.guest_phone === 'string' ? normalizePhoneE164(input.guest_phone) : null;
  const types = authorization.alert_types;
  const notificationType = typeof input.notification_type === 'string' ? input.notification_type : '';
  const expiresRaw = authorization.expires_at;
  const expiresAt = typeof expiresRaw === 'string' ? new Date(expiresRaw) : new Date(NaN);
  const canonicalExpiry = !Number.isNaN(expiresAt.getTime()) && expiresAt.toISOString() === expiresRaw;
  const maxAttempts = authorization.max_attempts;
  const validLocation = hasLocation
    && ((approvedClientSlug === 'sunset'
      && (approvedLocation === 'sunset-somo' || approvedLocation === 'sunset-sardinero'))
      || (approvedClientSlug !== 'sunset' && approvedLocation === null));
  const validTypes = Array.isArray(types) && types.length > 0
    && types.every((type) => typeof type === 'string' && NOTIFICATION_TYPES.includes(type))
    && new Set(types).size === types.length;

  if (!authId || authId.length > 120
    || !deployment || !trustedDeployment
    || !senderId || !trustedSenderId
    || !SCOPE_ID_RE.test(approvedClientSlug) || !SCOPE_ID_RE.test(actualClientSlug)
    || !validLocation
    || !(actualLocation === null || (typeof actualLocation === 'string' && SCOPE_ID_RE.test(actualLocation)))
    || !UUID_RE.test(approvedRecipientId) || !UUID_RE.test(actualRecipientId)
    || !approvedPhone || !actualPhone
    || !approvedRevision || !actualRevision
    || !approvedGuestPhone || !actualGuestPhone
    || !validTypes || !NOTIFICATION_TYPES.includes(notificationType)
    || !canonicalExpiry
    || typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts)
    || maxAttempts < 1 || maxAttempts > 2) {
    return { ok: false, reason: 'canary_authorization_invalid' };
  }
  if (deployment !== trustedDeployment) return { ok: false, reason: 'canary_deployment_mismatch' };
  if (senderId !== trustedSenderId) return { ok: false, reason: 'canary_sender_mismatch' };
  if (approvedClientSlug !== actualClientSlug
    || approvedLocation !== actualLocation
    || approvedRecipientId !== actualRecipientId) {
    return { ok: false, reason: 'canary_scope_mismatch' };
  }
  if (approvedPhone !== actualPhone) return { ok: false, reason: 'canary_phone_mismatch' };
  if (approvedRevision !== actualRevision) return { ok: false, reason: 'canary_directory_revision_mismatch' };
  if (approvedGuestPhone !== actualGuestPhone) return { ok: false, reason: 'canary_guest_mismatch' };
  if (!types.includes(notificationType)) return { ok: false, reason: 'canary_type_mismatch' };
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'canary_expired' };
  return { ok: true, authorization_id: authId, max_attempts: maxAttempts, expires_at: expiresAt.toISOString() };
}

async function resolveActiveStaffAlertRecipient(pg, clientSlug, staffNumberId) {
  const slug = trimStr(clientSlug);
  const id = trimStr(staffNumberId);
  if (!pg || !slug || !id) return { ok: false, reason: 'recipient_not_active' };
  const result = await pg.query(
    `SELECT id::text AS id, phone, display_name, active, updated_at
       FROM wolfhouse_staff_whatsapp_numbers
      WHERE client_slug = $1 AND id = $2::uuid AND active = TRUE
      LIMIT 1`,
    [slug, id],
  );
  const row = result && result.rows && result.rows[0];
  const phone = row && normalizePhoneE164(row.phone);
  if (!row || !phone) return { ok: false, reason: 'recipient_not_active' };
  const updated = new Date(row.updated_at);
  if (Number.isNaN(updated.getTime())) return { ok: false, reason: 'recipient_version_unavailable' };
  return {
    ok: true,
    staff_number_id: trimStr(row.id),
    phone,
    name: trimStr(row.display_name) || null,
    phone_version: updated.toISOString(),
  };
}

async function clientExists(pg, clientSlug) {
  const slug = trimStr(clientSlug);
  if (!slug) return false;
  const r = await pg.query('SELECT 1 FROM clients WHERE slug = $1 LIMIT 1', [slug]);
  return r.rows.length > 0;
}

async function insertNotificationEvent(pg, row) {
  try {
    const ins = await pg.query(
      `INSERT INTO ${EVENTS_TABLE} (
         client_slug, location_id, conversation_id, notification_type, handoff_event_key,
         recipient_phone, recipient_name, status, reason, message_preview,
         provider_message_id, error
       ) VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id, status`,
      [
        row.client_slug,
        normalizeLocationId(row.location_id),
        row.conversation_id || null,
        row.notification_type,
        row.handoff_event_key,
        row.recipient_phone,
        row.recipient_name || null,
        row.status,
        row.reason || null,
        row.message_preview ? String(row.message_preview).slice(0, 500) : null,
        row.provider_message_id || null,
        row.error || null,
      ],
    );
    if (!ins.rows[0]) return { inserted: false, duplicate: true };
    return { inserted: true, duplicate: false, id: ins.rows[0].id, status: ins.rows[0].status };
  } catch (err) {
    return { inserted: false, duplicate: false, error: err.message };
  }
}

/**
 * Dispatch staff WhatsApp notifications for one event.
 * @param {import('pg').ClientBase} pg
 * @param {object} env
 * @param {object} input
 * @param {{ sendMessage?: Function }} [context]
 */
async function resolveStoredConversationTruth(pg, input) {
  const i = input || {};
  const clientSlug = typeof i.client_slug === 'string' ? i.client_slug.trim() : '';
  const conversationId = typeof i.conversation_id === 'string' ? i.conversation_id.trim() : '';
  if (!pg || typeof pg.query !== 'function' || !SCOPE_ID_RE.test(clientSlug)
    || !UUID_RE.test(conversationId)) {
    return { ok: false, reason: 'conversation_identity_invalid' };
  }
  let result;
  try {
    result = await pg.query(
      `SELECT conv.id::text AS conversation_id,
              c.slug AS client_slug,
              conv.phone AS guest_phone,
              conv.display_name AS guest_name,
              conv.guest_id::text AS guest_id,
              conv.customer_id::text AS customer_id,
              conv.metadata
         FROM conversations conv
         JOIN clients c ON c.id = conv.client_id
        WHERE c.slug = $1
          AND conv.id = $2::uuid
        LIMIT 1`,
      [clientSlug, conversationId],
    );
  } catch (error) {
    return { ok: false, reason: 'conversation_lookup_failed', error };
  }
  const row = result && result.rows && result.rows[0];
  if (!row) return { ok: false, reason: 'conversation_not_found' };
  let metadata = row.metadata;
  if (typeof metadata === 'string') {
    try { metadata = JSON.parse(metadata); } catch (_) { return { ok: false, reason: 'conversation_metadata_invalid' }; }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {};
  const guestPhone = typeof row.guest_phone === 'string' ? row.guest_phone.trim() : '';
  if (!PHONE_RE.test(guestPhone)) return { ok: false, reason: 'conversation_guest_phone_invalid' };
  if (metadata.simulator_synthetic === true || /^\+999/.test(guestPhone)) {
    return { ok: false, reason: 'synthetic_conversation' };
  }
  let locationId = null;
  if (clientSlug === 'sunset') {
    locationId = typeof metadata.location_id === 'string' ? metadata.location_id : '';
    if (!SUNSET_LOCATION_IDS.has(locationId)) return { ok: false, reason: 'conversation_location_invalid' };
  } else if (metadata.location_id != null) {
    return { ok: false, reason: 'conversation_location_invalid' };
  }
  return {
    ok: true,
    conversation: {
      client_slug: clientSlug,
      conversation_id: conversationId,
      location_id: locationId,
      guest_phone: guestPhone,
      guest_name: typeof row.guest_name === 'string' ? row.guest_name.trim() : '',
      guest_id: row.guest_id || null,
      customer_id: row.customer_id || null,
      metadata,
    },
  };
}

async function dispatchStaffWhatsAppNotifications(pg, env, input, context = {}) {
  let inp = input || {};
  const requestedClientSlug = trimStr(inp.client_slug);
  const requestedConversationId = trimStr(inp.conversation_id);
  const notificationType = trimStr(inp.notification_type);
  const handoffKey = handoffEventKeyForType(notificationType, inp.handoff_event_key);

  const baseSkip = {
    ok: true,
    dispatched: false,
    skipped: true,
    results: [],
  };

  if (!pg || !requestedClientSlug || !requestedConversationId || !NOTIFICATION_TYPES.includes(notificationType)) {
    return { ...baseSkip, reason: 'invalid_input' };
  }
  if (!handoffKey) return { ...baseSkip, reason: 'event_identity_missing' };
  if (inp.suppress_notifications === true) return { ...baseSkip, reason: 'explicit_no_send' };

  const stored = await resolveStoredConversationTruth(pg, {
    client_slug: requestedClientSlug,
    conversation_id: requestedConversationId,
  });
  if (!stored.ok) return { ...baseSkip, reason: stored.reason };
  const truth = stored.conversation;
  const requestedLocation = Object.prototype.hasOwnProperty.call(inp, 'location_id')
    ? normalizeLocationId(inp.location_id)
    : truth.location_id;
  if (requestedLocation !== truth.location_id) return { ...baseSkip, reason: 'conversation_location_mismatch' };
  if (inp.guest_phone != null && trimStr(inp.guest_phone) !== truth.guest_phone) {
    return { ...baseSkip, reason: 'conversation_guest_mismatch' };
  }
  inp = { ...inp, ...truth };
  const clientSlug = truth.client_slug;
  const conversationId = truth.conversation_id;
  const locationId = truth.location_id;

  await ensureNotificationTables(pg);

  const settings = await getNotificationSettings(pg, { clientSlug, locationId });
  const typeCfg = settings[notificationType];
  if (!typeCfg || typeCfg.enabled !== true) {
    return { ...baseSkip, reason: 'notifications_disabled_for_type' };
  }

  const enabledRecipients = (typeCfg.recipients || []).filter((r) => r.enabled && (r.staff_number_id || r.phone));
  if (!enabledRecipients.length) {
    return { ...baseSkip, reason: 'no_enabled_recipients' };
  }

  const globallyEnabled = isStaffNotificationsEnabled(env);
  const dryRun = isStaffNotificationsDryRun(env);
  const message = buildNotificationMessage(notificationType, {
    ...inp,
    client_slug: clientSlug,
    location_id: locationId,
    conversation_id: conversationId,
    env: env || process.env,
  });

  const results = [];
  for (const configuredRecipient of enabledRecipients) {
    let recipient = configuredRecipient;
    if (configuredRecipient.staff_number_id) {
      const resolvedRecipient = await resolveActiveStaffAlertRecipient(
        pg,
        clientSlug,
        configuredRecipient.staff_number_id,
      );
      if (!resolvedRecipient.ok) {
        results.push({
          staff_number_id: configuredRecipient.staff_number_id,
          status: 'skipped',
          reason: resolvedRecipient.reason,
        });
        continue;
      }
      recipient = {
        ...configuredRecipient,
        ...resolvedRecipient,
        directory_revision: resolvedRecipient.phone_version,
      };
    }
    if (!globallyEnabled) {
      const audit = await insertNotificationEvent(pg, {
        client_slug: clientSlug,
        location_id: locationId,
        conversation_id: conversationId,
        notification_type: notificationType,
        handoff_event_key: handoffKey,
        recipient_phone: recipient.phone,
        recipient_name: recipient.name,
        status: 'skipped',
        reason: 'staff_whatsapp_notifications_disabled',
        message_preview: message,
      });
      results.push({
        recipient_phone: recipient.phone,
        status: 'skipped',
        duplicate: audit.duplicate === true,
        globally_disabled: true,
      });
      continue;
    }

    if (dryRun) {
      const audit = await insertNotificationEvent(pg, {
        client_slug: clientSlug,
        location_id: locationId,
        conversation_id: conversationId,
        notification_type: notificationType,
        handoff_event_key: handoffKey,
        recipient_phone: recipient.phone,
        recipient_name: recipient.name,
        status: 'dry_run',
        reason: 'staff_whatsapp_notifications_dry_run',
        message_preview: message,
      });
      results.push({
        recipient_phone: recipient.phone,
        status: audit.duplicate ? 'duplicate' : 'dry_run',
        message,
        duplicate: audit.duplicate === true,
      });
      continue;
    }

    const canary = validateStaffAlertCanaryAuthorization(env, {
      client_slug: clientSlug,
      location_id: locationId,
      staff_number_id: recipient.staff_number_id,
      phone: recipient.phone,
      directory_revision: recipient.directory_revision,
      guest_phone: inp.guest_phone,
      notification_type: notificationType,
    });
    if (!canary.ok) {
      results.push({ recipient_phone: recipient.phone, status: 'skipped', reason: canary.reason, canary_denied: true });
      continue;
    }

    let templateConfig;
    try {
      const allTemplates = JSON.parse(env.STAFF_ALERT_TEMPLATES_JSON || '{}');
      templateConfig = allTemplates[notificationType];
    } catch (_) { templateConfig = null; }
    if (!templateConfig || !trimStr(templateConfig.name) || !trimStr(templateConfig.language_code)
      || !Array.isArray(templateConfig.components)) {
      results.push({ recipient_phone: recipient.phone, status: 'skipped', reason: 'staff_template_config_missing' });
      continue;
    }
    let authorizationScope;
    try { authorizationScope = JSON.parse(env.STAFF_ALERT_CANARY_AUTHORIZATION); } catch (_) { authorizationScope = null; }
    const reserveAttempt = typeof context.reserveAttempt === 'function'
      ? context.reserveAttempt : reserveStaffAlertAttempt;
    let reservation;
    try {
      reservation = await reserveAttempt(pg, {
        authorization_id: canary.authorization_id,
        authorization_scope: authorizationScope,
        max_attempts: canary.max_attempts,
        expires_at: canary.expires_at,
        client_slug: clientSlug,
        location_id: locationId,
        conversation_id: conversationId,
        notification_type: notificationType,
        handoff_event_key: handoffKey,
        staff_number_id: recipient.staff_number_id,
        recipient_phone: recipient.phone,
        recipient_name: recipient.name,
        directory_revision: recipient.directory_revision,
        message_preview: message,
      });
    } catch (error) {
      results.push({ recipient_phone: recipient.phone, status: 'unknown', reason: 'reservation_failed' });
      continue;
    }
    if (!reservation.reserved) {
      results.push({ recipient_phone: recipient.phone,
        status: reservation.duplicate ? 'duplicate' : 'skipped',
        duplicate: reservation.duplicate === true, reason: reservation.reason || null });
      continue;
    }

    // Re-resolve mutable authority after the durable reservation and immediately before transport.
    const currentRecipient = await resolveActiveStaffAlertRecipient(pg, clientSlug, recipient.staff_number_id);
    const currentCanary = currentRecipient.ok ? validateStaffAlertCanaryAuthorization(env, {
      client_slug: clientSlug, location_id: locationId, staff_number_id: currentRecipient.staff_number_id,
      phone: currentRecipient.phone, directory_revision: currentRecipient.phone_version,
      guest_phone: inp.guest_phone, notification_type: notificationType,
    }) : currentRecipient;
    if (!currentRecipient.ok || !currentCanary.ok) {
      await pg.query(`UPDATE ${EVENTS_TABLE} SET status='failed', error=$2 WHERE id=$1::uuid`,
        [reservation.event_id, currentRecipient.reason || currentCanary.reason]);
      results.push({ recipient_phone: recipient.phone, status: 'failed', reason: currentRecipient.reason || currentCanary.reason });
      continue;
    }

    const sendEnv = { ...(env || process.env), WHATSAPP_DRY_RUN: 'false' };
    const sendTemplate = typeof context.sendTemplate === 'function'
      ? context.sendTemplate : sendStaffWhatsAppTemplate;
    let sendOut;
    let finalStatus;
    try {
      sendOut = await sendTemplate({
        to: currentRecipient.phone,
        sender_phone_number_id: trimStr(env.WHATSAPP_PHONE_NUMBER_ID),
        template_name: templateConfig.name,
        language_code: templateConfig.language_code,
        components: templateConfig.components,
        client_slug: clientSlug,
        idempotency_key: `staff-notify:${notificationType}:${conversationId}:${handoffKey}:${recipient.staff_number_id}`,
      }, sendEnv, context);
      finalStatus = sendOut.send_performed ? 'accepted'
        : (sendOut.outcome === 'ambiguous' ? 'unknown' : 'failed');
    } catch (error) {
      sendOut = { send_performed: false, provider_error: error.message };
      finalStatus = 'unknown';
    }
    await pg.query(`UPDATE ${EVENTS_TABLE}
      SET status=$2, provider_message_id=$3, error=$4,
          accepted_at=CASE WHEN $2='accepted' THEN clock_timestamp() ELSE accepted_at END
      WHERE id=$1::uuid`, [reservation.event_id, finalStatus, sendOut.whatsapp_message_id || null,
      sendOut.send_performed ? null : trimStr(sendOut.blocked_reason || sendOut.provider_error) || 'send_failed']);

    results.push({ recipient_phone: currentRecipient.phone, status: finalStatus,
      provider_message_id: sendOut.whatsapp_message_id || null, message,
      send_performed: sendOut.send_performed === true });
  }

  return {
    ok: true,
    dispatched: true,
    notification_type: notificationType,
    conversation_id: conversationId,
    handoff_event_key: handoffKey,
    message,
    results,
  };
}

async function maybeNotifyNewConversation(pg, env, input, context) {
  const eventKey = trimStr(input && input.initial_alert_event_key);
  if (!input || input.created !== true || !eventKey) return { skipped: true, reason: 'not_new_conversation' };
  return dispatchStaffWhatsAppNotifications(pg, env, {
    ...input,
    notification_type: 'new_conversation',
    handoff_event_key: eventKey,
  }, context);
}

async function maybeNotifyHumanNeeded(pg, env, input, context) {
  if (!input || input.transitioned !== true) return { skipped: true, reason: 'no_transition' };
  return dispatchStaffWhatsAppNotifications(pg, env, {
    ...input,
    notification_type: 'human_needed',
    handoff_event_key: input.handoff_event_key,
  }, context);
}

function extractLocationFromMetadata(metadata) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  return normalizeLocationId(meta.location_id || meta.school_location_id);
}

module.exports = {
  NOTIFICATION_TYPES,
  MAX_RECIPIENTS,
  PHONE_RE,
  SETTINGS_TABLE,
  EVENTS_TABLE,
  AUTHORIZATIONS_TABLE,
  trimStr,
  normalizePhoneE164,
  isStaffNotificationsEnabled,
  isStaffNotificationsDryRun,
  validateStaffAlertCanaryAuthorization,
  resolveActiveStaffAlertRecipient,
  resolveStoredConversationTruth,
  validateNotificationSettingsPayload,
  validateNotificationTypeConfig,
  buildStaffInboxDeepLink,
  buildNewConversationMessage,
  buildHumanNeededMessage,
  buildNotificationMessage,
  resolveClientDisplayName,
  ensureNotificationTables,
  reserveStaffAlertAttempt,
  getNotificationSettings,
  putNotificationSettings,
  dispatchStaffWhatsAppNotifications,
  maybeNotifyNewConversation,
  maybeNotifyHumanNeeded,
  extractLocationFromMetadata,
  handoffEventKeyForType,
};
