/**
 * Bot pause-state GET handler — extracted for verifier route-level parity.
 *
 * This is the production handler for /staff/bot/pause-state. Extracting it
 * into a DI factory allows the verifier to execute the real route orchestration
 * without importing staff-query-api.js (which starts runtime work on load).
 *
 * @module staff-bot-pause-state-handler
 */

'use strict';

const { getPauseState } = require('./staff-bot-pause-sql');
const {
  buildPausedStateResponse,
  buildDefaultActivePauseResponse,
} = require('./staff-inbox-helpers');

const DEFAULT_SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

/**
 * @param {object} deps
 * @param {function} deps.sendJSON
 * @param {function} deps.send400
 * @param {function} deps.withPgClient
 * @param {function} deps.appendAuditLog
 * @param {string} [deps.DEFAULT_CLIENT]
 * @param {RegExp} [deps.SQL_INJECT_RE]
 */
function createBotPauseStateRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createBotPauseStateRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    withPgClient,
    appendAuditLog,
    DEFAULT_CLIENT = 'wolfhouse-somo',
    SQL_INJECT_RE = DEFAULT_SQL_INJECT_RE,
  } = deps;

  async function handleBotPauseStateGet(query, res, user) {
    const started = Date.now();
    const clientSlug = String(query.client_slug || query.client || DEFAULT_CLIENT).trim();
    const conversationId = query.conversation_id != null
      ? String(query.conversation_id).trim() || null
      : null;
    const guestPhone = query.guest_phone != null
      ? String(query.guest_phone).trim() || null
      : null;
    const bookingCode = query.booking_code != null
      ? String(query.booking_code).trim() || null
      : null;

    if (!clientSlug || SQL_INJECT_RE.test(clientSlug)) {
      return send400(res, 'client_slug is required');
    }
    if (!conversationId && !guestPhone && !bookingCode) {
      return send400(res, 'conversation_id, guest_phone, or booking_code is required');
    }

    try {
      const result = await withPgClient((pg) => getPauseState(pg, {
        client_slug:     clientSlug,
        conversation_id: conversationId,
        guest_phone:     guestPhone,
        booking_code:    bookingCode,
      }));

      appendAuditLog(Object.assign({
        ts: new Date().toISOString(),
        intent: 'api:bot.pause-state',
        category: 'bot_pause_api',
        client_slug: clientSlug,
        success: true,
        paused: !!result.row,
        source: result.row ? 'bot_pause_states' : 'default_active',
        table_missing: !!result.table_missing,
        elapsed_ms: Date.now() - started,
      }, user ? { staff_user_id: user.staff_user_id } : {}));

      if (result.row) {
        return sendJSON(res, 200, buildPausedStateResponse(result.row));
      }

      return sendJSON(res, 200, buildDefaultActivePauseResponse({
        client_slug: clientSlug,
        guest_phone: guestPhone,
        conversation_id: conversationId,
        booking_code: bookingCode,
        table_missing: result.table_missing || false,
      }));
    } catch (err) {
      appendAuditLog({
        ts: new Date().toISOString(),
        intent: 'api:bot.pause-state',
        category: 'bot_pause_api',
        client_slug: clientSlug,
        success: false,
        error: err.message,
        elapsed_ms: Date.now() - started,
      });
      return sendJSON(res, 200, buildDefaultActivePauseResponse({
        client_slug: clientSlug,
        guest_phone: guestPhone,
        conversation_id: conversationId,
        booking_code: bookingCode,
        lookup_error: true,
      }));
    }
  }

  return {
    handleBotPauseStateGet,
  };
}

module.exports = {
  createBotPauseStateRoutes,
  DEFAULT_SQL_INJECT_RE,
};
