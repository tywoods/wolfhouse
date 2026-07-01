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
const { sendLunaWhatsAppMessage } = require('./luna-whatsapp-provider');

const SETTINGS_TABLE = 'client_notification_settings';
const EVENTS_TABLE = 'client_notification_events';
const NOTIFICATION_TYPES = ['new_conversation', 'human_needed'];
const MAX_RECIPIENTS = 10;
const NAME_MAX = 80;
const PHONE_RE = /^\+[1-9]\d{7,14}$/;
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
  const phone = normalizePhoneE164(src.phone);
  const name = trimStr(src.name).slice(0, NAME_MAX) || null;
  return { name, phone, enabled };
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
  for (const r of recipientsIn) {
    const norm = normalizeRecipient(r);
    if (norm.enabled && !norm.phone) {
      return { ok: false, error: `${typeLabel}: phone required when recipient enabled` };
    }
    if (norm.phone && !PHONE_RE.test(norm.phone)) {
      return { ok: false, error: `${typeLabel}: invalid phone (use E.164, e.g. +346...)` };
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
      status              TEXT NOT NULL CHECK (status IN ('dry_run', 'sent', 'failed', 'skipped')),
      reason              TEXT NULL,
      message_preview     TEXT NULL,
      provider_message_id TEXT NULL,
      error               TEXT NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pg.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_client_notification_events_dedupe
      ON ${EVENTS_TABLE} (
        client_slug,
        COALESCE(location_id, ''),
        conversation_id,
        notification_type,
        handoff_event_key,
        recipient_phone
      )`);
}

async function getNotificationSettings(pg, { clientSlug, locationId }) {
  await ensureNotificationTables(pg);
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
  if (notificationType === 'new_conversation') return 'initial';
  const key = trimStr(handoffEventKey);
  return key || `handoff:${Date.now()}`;
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
async function dispatchStaffWhatsAppNotifications(pg, env, input, context = {}) {
  const inp = input || {};
  const clientSlug = trimStr(inp.client_slug);
  const conversationId = trimStr(inp.conversation_id);
  const notificationType = trimStr(inp.notification_type);
  const locationId = normalizeLocationId(inp.location_id);
  const handoffKey = handoffEventKeyForType(notificationType, inp.handoff_event_key);

  const baseSkip = {
    ok: true,
    dispatched: false,
    skipped: true,
    results: [],
  };

  if (!pg || !clientSlug || !conversationId || !NOTIFICATION_TYPES.includes(notificationType)) {
    return { ...baseSkip, reason: 'invalid_input' };
  }

  if (!(await clientExists(pg, clientSlug))) {
    return { ...baseSkip, reason: 'unknown_client' };
  }

  await ensureNotificationTables(pg);

  const settings = await getNotificationSettings(pg, { clientSlug, locationId });
  const typeCfg = settings[notificationType];
  if (!typeCfg || typeCfg.enabled !== true) {
    return { ...baseSkip, reason: 'notifications_disabled_for_type' };
  }

  const enabledRecipients = (typeCfg.recipients || []).filter((r) => r.enabled && r.phone);
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
  for (const recipient of enabledRecipients) {
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

    const dedupeProbe = await insertNotificationEvent(pg, {
      client_slug: clientSlug,
      location_id: locationId,
      conversation_id: conversationId,
      notification_type: notificationType,
      handoff_event_key: handoffKey,
      recipient_phone: recipient.phone,
      recipient_name: recipient.name,
      status: 'sent',
      message_preview: message,
    });
    if (!dedupeProbe.inserted) {
      results.push({
        recipient_phone: recipient.phone,
        status: 'duplicate',
        duplicate: true,
      });
      continue;
    }

    const sendEnv = { ...(env || process.env), WHATSAPP_DRY_RUN: 'false' };
    const sendOut = await sendLunaWhatsAppMessage({
      to: recipient.phone,
      message,
      client_slug: clientSlug,
      idempotency_key: `staff-notify:${notificationType}:${conversationId}:${handoffKey}:${recipient.phone}`,
    }, sendEnv, context);

    const finalStatus = sendOut.send_performed ? 'sent' : 'failed';
    await pg.query(
      `UPDATE ${EVENTS_TABLE}
          SET status = $2,
              provider_message_id = $3,
              error = $4
        WHERE id = $1::uuid`,
      [
        dedupeProbe.id,
        finalStatus,
        sendOut.whatsapp_message_id || null,
        sendOut.send_performed ? null : trimStr(sendOut.blocked_reason || sendOut.provider_error) || 'send_failed',
      ],
    );

    results.push({
      recipient_phone: recipient.phone,
      status: finalStatus,
      provider_message_id: sendOut.whatsapp_message_id || null,
      message,
      send_performed: sendOut.send_performed === true,
    });
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
  if (!input || input.created !== true) return { skipped: true, reason: 'not_new_conversation' };
  return dispatchStaffWhatsAppNotifications(pg, env, {
    ...input,
    notification_type: 'new_conversation',
    handoff_event_key: 'initial',
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
  trimStr,
  normalizePhoneE164,
  isStaffNotificationsEnabled,
  isStaffNotificationsDryRun,
  validateNotificationSettingsPayload,
  validateNotificationTypeConfig,
  buildStaffInboxDeepLink,
  buildNewConversationMessage,
  buildHumanNeededMessage,
  buildNotificationMessage,
  resolveClientDisplayName,
  ensureNotificationTables,
  getNotificationSettings,
  putNotificationSettings,
  dispatchStaffWhatsAppNotifications,
  maybeNotifyNewConversation,
  maybeNotifyHumanNeeded,
  extractLocationFromMetadata,
  handoffEventKeyForType,
};
