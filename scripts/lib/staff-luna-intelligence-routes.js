'use strict';

// Tenant comes only from the authenticated principal. Never from a model/caller.
const LUNA_INTELLIGENCE_PATH = '/staff/luna-intelligence';
const LUNA_INTELLIGENCE_BOT_PATH = '/staff/bot/luna-intelligence';

function createLunaIntelligenceRoutes({ sendJSON, readBody, withPgClient }) {
  function sendSetting(res, row) {
    if (!row) return sendJSON(res, 404, { success: false, error: 'client_not_found' });
    return sendJSON(res, 200, {
      success: true, client_slug: row.slug, enabled: !!(row.settings && row.settings.luna_intelligence === true),
    });
  }
  async function handleLunaIntelligenceGet(query, _req, res, user) {
    if (!user || (!user.client_id && !user.client_slug)) {
      return sendJSON(res, 401, { success: false, error: 'authentication_required' });
    }
    if (Object.keys(query || {}).length) {
      return sendJSON(res, 400, { success: false, error: 'caller_parameters_rejected' });
    }
    try {
      const result = await withPgClient((pg) => user.client_id
        ? pg.query('SELECT slug, settings FROM clients WHERE id = $1::uuid LIMIT 1', [user.client_id])
        : pg.query('SELECT slug, settings FROM clients WHERE slug = $1 LIMIT 1', [user.client_slug]));
      return sendSetting(res, result.rows[0]);
    } catch (_) {
      return sendJSON(res, 500, { success: false, error: 'intelligence_read_failed' });
    }
  }
  async function handleLunaIntelligencePut(query, req, res, user) {
    if (Object.keys(query || {}).length) {
      return sendJSON(res, 400, { success: false, error: 'caller_parameters_rejected' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { return sendJSON(res, 400, { success: false, error: 'invalid_json' }); }
    if (!body || Array.isArray(body) || typeof body.enabled !== 'boolean'
        || Object.keys(body).some((key) => key !== 'enabled')) {
      return sendJSON(res, 400, { success: false, error: 'invalid_intelligence_setting' });
    }
    try {
      const result = await withPgClient((pg) => pg.query(
        `UPDATE clients SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
          '{luna_intelligence}', to_jsonb($2::boolean), true)
         WHERE id = $1::uuid RETURNING slug, settings`, [user.client_id, body.enabled],
      ));
      return sendSetting(res, result.rows[0]);
    } catch (_) {
      return sendJSON(res, 500, { success: false, error: 'intelligence_save_failed' });
    }
  }
  return { handleLunaIntelligenceGet, handleLunaIntelligencePut };
}
module.exports = { LUNA_INTELLIGENCE_PATH, LUNA_INTELLIGENCE_BOT_PATH, createLunaIntelligenceRoutes };
