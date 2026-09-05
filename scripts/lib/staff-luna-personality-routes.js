'use strict';

/**
 * Staff Luna Personality routes — tenant-wide WhatsApp-only closed ID.
 *
 *   GET/PUT /staff/luna-personality     requireAuth('operator') in the router
 *   GET     /staff/bot/luna-personality requireBotAuth() in the router
 *
 * Tenant is always the authenticated principal: staff session client_id, or
 * bot-token principal client_slug (FORTRESS 15E). Callers cannot choose
 * another tenant. Persist only a closed ID in clients.settings JSONB.
 */

const {
  PRODUCT_NAME,
  CHANNEL,
  SETTINGS_KEY,
  DEFAULT_PERSONALITY_ID,
  CLOSED_PERSONALITY_IDS,
  isClosedPersonalityId,
  normalizeStoredPersonalityId,
  assertNoCallerStyleText,
} = require('./luna-guest-personality-packs');

const LUNA_PERSONALITY_PATH = '/staff/luna-personality';
const LUNA_PERSONALITY_BOT_PATH = '/staff/bot/luna-personality';
const LUNA_PERSONALITY_MIN_ROLE = 'operator';

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function resolvePrincipalTenant(user) {
  if (!user || typeof user !== 'object') return null;
  const clientId = trimStr(user.client_id);
  const clientSlug = trimStr(user.client_slug).toLowerCase();
  if (clientId) {
    return { kind: 'id', client_id: clientId, client_slug: clientSlug || null };
  }
  if (clientSlug) {
    return { kind: 'slug', client_id: null, client_slug: clientSlug };
  }
  return null;
}

function callerTenantConflictsPrincipal(caller, user) {
  const tenant = resolvePrincipalTenant(user);
  if (!tenant || !caller || typeof caller !== 'object') return false;
  const qSlug = trimStr(caller.client_slug).toLowerCase();
  const qId = trimStr(caller.client_id);
  if (qSlug) {
    if (tenant.client_slug) return qSlug !== tenant.client_slug;
    return true;
  }
  if (qId) {
    if (tenant.client_id) return qId !== tenant.client_id;
    return true;
  }
  return false;
}

function storedIdFromSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const raw = settings[SETTINGS_KEY];
  if (raw == null) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw.whatsapp != null) return raw.whatsapp;
  return null;
}

function publicPayload(normalized, extras) {
  return {
    success: true,
    product: PRODUCT_NAME,
    channel: CHANNEL,
    personality_id: normalized.id,
    closed_ids: CLOSED_PERSONALITY_IDS.slice(),
    source: normalized.source,
    ...extras,
  };
}

function createLunaPersonalityRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createLunaPersonalityRoutes: deps required');
  }
  const { sendJSON, readBody, withPgClient } = deps;

  async function loadSettingsById(clientId) {
    if (!clientId) return null;
    const row = await withPgClient(async (pg) => {
      const result = await pg.query(
        `SELECT settings FROM clients WHERE id = $1::uuid LIMIT 1`,
        [clientId],
      );
      return result.rows[0] || null;
    });
    return row && row.settings ? row.settings : {};
  }

  async function loadSettingsBySlug(clientSlug) {
    if (!clientSlug) return null;
    const row = await withPgClient(async (pg) => {
      const result = await pg.query(
        `SELECT settings FROM clients WHERE slug = $1 LIMIT 1`,
        [clientSlug],
      );
      return result.rows[0] || null;
    });
    return row && row.settings ? row.settings : {};
  }

  async function savePersonalityId(clientId, personalityId) {
    const row = await withPgClient(async (pg) => {
      const result = await pg.query(
        `UPDATE clients
            SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{luna_personality}',
              to_jsonb($2::text),
              true
            )
          WHERE id = $1::uuid
          RETURNING settings`,
        [clientId, personalityId],
      );
      return result.rows[0] || null;
    });
    return row;
  }

  function requireStaffUser(res, user) {
    if (user && user.client_id) return true;
    sendJSON(res, 401, {
      success: false,
      error: 'Authentication required. POST /staff/auth/login first.',
      auth_url: '/staff/auth/login',
    });
    return false;
  }

  async function handleLunaPersonalityGet(query, _req, res, user) {
    if (!requireStaffUser(res, user)) return;
    if (callerTenantConflictsPrincipal(query, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    try {
      const settings = await loadSettingsById(user.client_id);
      const normalized = normalizeStoredPersonalityId(storedIdFromSettings(settings));
      return sendJSON(res, 200, publicPayload(normalized));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'personality_read_failed' });
    }
  }

  async function handleLunaPersonalityPut(query, req, res, user) {
    if (!requireStaffUser(res, user)) return;
    if (callerTenantConflictsPrincipal(query, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req) || '{}');
    } catch (_e) {
      return sendJSON(res, 400, { success: false, error: 'invalid_json' });
    }
    try {
      assertNoCallerStyleText(body);
    } catch (_err) {
      return sendJSON(res, 400, { success: false, error: 'caller_style_text_rejected' });
    }
    if (body && body.channel != null && String(body.channel).trim().toLowerCase() !== CHANNEL) {
      return sendJSON(res, 400, { success: false, error: 'whatsapp_only' });
    }
    if (callerTenantConflictsPrincipal(body, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    const nextId = body && body.personality_id;
    if (!isClosedPersonalityId(nextId)) {
      return sendJSON(res, 400, {
        success: false,
        error: 'invalid_personality_id',
        closed_ids: CLOSED_PERSONALITY_IDS.slice(),
      });
    }
    const id = String(nextId).trim().toLowerCase();
    try {
      const row = await savePersonalityId(user.client_id, id);
      if (!row) {
        return sendJSON(res, 404, { success: false, error: 'client_not_found' });
      }
      const normalized = normalizeStoredPersonalityId(storedIdFromSettings(row.settings));
      return sendJSON(res, 200, publicPayload(normalized, { persisted: true }));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'personality_save_failed' });
    }
  }

  async function handleLunaPersonalityBotGet(query, _req, res, user) {
    // Bot token principal is { role, staff_user_id, client_slug } with no
    // session client_id (FORTRESS 15E). Tenant comes from that principal only.
    const tenant = resolvePrincipalTenant(user);
    if (!tenant) {
      sendJSON(res, 401, {
        success: false,
        error: 'Authentication required. Provide X-Luna-Bot-Token header or POST /staff/auth/login first.',
        auth_url: '/staff/auth/login',
      });
      return;
    }
    if (callerTenantConflictsPrincipal(query, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    try {
      const settings = tenant.kind === 'id'
        ? await loadSettingsById(tenant.client_id)
        : await loadSettingsBySlug(tenant.client_slug);
      const normalized = normalizeStoredPersonalityId(storedIdFromSettings(settings));
      return sendJSON(res, 200, publicPayload(normalized));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'personality_read_failed' });
    }
  }

  const handlers = Object.freeze({
    GET: handleLunaPersonalityGet,
    PUT: handleLunaPersonalityPut,
    BOT_GET: handleLunaPersonalityBotGet,
  });

  return {
    PATH: LUNA_PERSONALITY_PATH,
    BOT_PATH: LUNA_PERSONALITY_BOT_PATH,
    MIN_ROLE: LUNA_PERSONALITY_MIN_ROLE,
    handlers,
    handleLunaPersonalityGet,
    handleLunaPersonalityPut,
    handleLunaPersonalityBotGet,
  };
}

module.exports = {
  LUNA_PERSONALITY_PATH,
  LUNA_PERSONALITY_BOT_PATH,
  LUNA_PERSONALITY_MIN_ROLE,
  SETTINGS_KEY,
  DEFAULT_PERSONALITY_ID,
  createLunaPersonalityRoutes,
  resolvePrincipalTenant,
  callerTenantConflictsPrincipal,
};
