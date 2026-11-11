'use strict';

const { resolvePrincipalTenant, callerTenantConflictsPrincipal } = require('./staff-luna-personality-routes');
const { normalizeStaffMemberName } = require('./luna-guest-handoff-warm-note');

const STAFF_INFO_PATH = '/staff/staff-info';
const STAFF_INFO_BOT_PATH = '/staff/bot/staff-info';
const SETTINGS_KEY = 'staff_member_name';

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function nameFromSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return '';
  return normalizeStaffMemberName(settings[SETTINGS_KEY]);
}

function publicPayload(name, extras) {
  return { success: true, staff_member_name: name || '', ...extras };
}

function createStaffInfoRoutes(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('createStaffInfoRoutes: deps required');
  const { sendJSON, readBody, withPgClient } = deps;

  async function loadSettingsById(clientId) {
    if (!clientId) return null;
    const row = await withPgClient(async (pg) => {
      const result = await pg.query('SELECT settings FROM clients WHERE id = $1::uuid LIMIT 1', [clientId]);
      return result.rows[0] || null;
    });
    return row && row.settings ? row.settings : {};
  }

  async function loadSettingsBySlug(clientSlug) {
    if (!clientSlug) return null;
    const row = await withPgClient(async (pg) => {
      const result = await pg.query('SELECT settings FROM clients WHERE slug = $1 LIMIT 1', [clientSlug]);
      return result.rows[0] || null;
    });
    return row && row.settings ? row.settings : {};
  }

  async function saveName(clientId, name) {
    const row = await withPgClient(async (pg) => {
      const result = await pg.query(
        `UPDATE clients
            SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{staff_member_name}',
              to_jsonb($2::text),
              true
            )
          WHERE id = $1::uuid
          RETURNING settings`,
        [clientId, name],
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

  async function handleStaffInfoGet(query, _req, res, user) {
    if (!requireStaffUser(res, user)) return;
    if (callerTenantConflictsPrincipal(query, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    try {
      const settings = await loadSettingsById(user.client_id);
      return sendJSON(res, 200, publicPayload(nameFromSettings(settings)));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'staff_info_read_failed' });
    }
  }

  async function handleStaffInfoPut(query, req, res, user) {
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
    if (callerTenantConflictsPrincipal(body, user)) {
      return sendJSON(res, 403, { success: false, error: 'client_access_denied' });
    }
    const name = normalizeStaffMemberName(body && body.staff_member_name);
    try {
      const row = await saveName(user.client_id, name);
      if (!row) return sendJSON(res, 404, { success: false, error: 'client_not_found' });
      return sendJSON(res, 200, publicPayload(nameFromSettings(row.settings), { persisted: true }));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'staff_info_save_failed' });
    }
  }

  async function handleStaffInfoBotGet(query, _req, res, user) {
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
      return sendJSON(res, 200, publicPayload(nameFromSettings(settings)));
    } catch (_err) {
      return sendJSON(res, 500, { success: false, error: 'staff_info_read_failed' });
    }
  }

  return {
    PATH: STAFF_INFO_PATH,
    BOT_PATH: STAFF_INFO_BOT_PATH,
    handleStaffInfoGet,
    handleStaffInfoPut,
    handleStaffInfoBotGet,
  };
}

module.exports = {
  STAFF_INFO_PATH,
  STAFF_INFO_BOT_PATH,
  SETTINGS_KEY,
  createStaffInfoRoutes,
  nameFromSettings,
  trimStr,
};
