'use strict';

/**
 * Canonical /staff/bot/* auth owner (requireBotAuth).
 *
 * Production staff-query-api.js executes this factory. Tests must call this
 * owner rather than reimplement token comparison.
 *
 * Behavior matches the previous inline function:
 *   1. STAFF_AUTH_REQUIRED=false → open
 *   2. Valid X-Luna-Bot-Token / Bearer matching LUNA_BOT_INTERNAL_TOKEN → bot_token
 *   3. Otherwise session cookie via loadAuthSession
 */

const crypto = require('crypto');
const { buildStaffBotAuthPrincipal } = require('./staff-bot-principal-tenant-config');

function tokensMatch(provided, expected) {
  const a = Buffer.from(String(provided || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createRequireBotAuth(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createRequireBotAuth: deps required');
  }
  const getStaffAuthRequired = deps.getStaffAuthRequired;
  const getBotToken = deps.getBotToken;
  const listBaselineClients = deps.listBaselineClients;
  const buildPrincipal = deps.buildPrincipal || buildStaffBotAuthPrincipal;
  const enforceAuthenticatedStaffRouteAuthz = deps.enforceAuthenticatedStaffRouteAuthz;
  const loadAuthSession = deps.loadAuthSession;
  const sendJSON = deps.sendJSON;
  if (typeof getStaffAuthRequired !== 'function') throw new Error('createRequireBotAuth: getStaffAuthRequired');
  if (typeof getBotToken !== 'function') throw new Error('createRequireBotAuth: getBotToken');
  if (typeof listBaselineClients !== 'function') throw new Error('createRequireBotAuth: listBaselineClients');
  if (typeof enforceAuthenticatedStaffRouteAuthz !== 'function') {
    throw new Error('createRequireBotAuth: enforceAuthenticatedStaffRouteAuthz');
  }
  if (typeof loadAuthSession !== 'function') throw new Error('createRequireBotAuth: loadAuthSession');
  if (typeof sendJSON !== 'function') throw new Error('createRequireBotAuth: sendJSON');

  return async function requireBotAuth(req, res) {
    if (!getStaffAuthRequired()) return { ok: true, user: null, auth_mode: 'open' };

    const expectedToken = getBotToken();
    if (expectedToken) {
      const rawHeader = (req.headers && req.headers['x-luna-bot-token']) || '';
      const bearerHeader = (req.headers && req.headers.authorization) || '';
      const bearerToken = String(bearerHeader).startsWith('Bearer ')
        ? String(bearerHeader).slice(7).trim()
        : '';
      const provided = rawHeader || bearerToken;

      if (provided) {
        if (tokensMatch(provided, expectedToken)) {
          const knownSlugs = listBaselineClients().map((c) => c.slug);
          const principal = buildPrincipal(process.env, {
            knownClientSlugs: knownSlugs,
          });
          if (!principal.ok || !principal.user) {
            sendJSON(res, 503, {
              success: false,
              error: 'bot_principal_tenant_unconfigured',
              reason: principal.reason || 'missing_runtime_client_slug',
            });
            return { ok: false };
          }
          if (!enforceAuthenticatedStaffRouteAuthz(req, res, principal.user)) return { ok: false };
          return { ok: true, user: principal.user, auth_mode: 'bot_token' };
        }
        sendJSON(res, 401, {
          success: false,
          error: 'Invalid bot token.',
        });
        return { ok: false };
      }
    }

    let user;
    try {
      user = await loadAuthSession(req);
    } catch (_err) {
      sendJSON(res, 500, { success: false, error: 'auth session lookup failed' });
      return { ok: false };
    }

    if (!user) {
      sendJSON(res, 401, {
        success: false,
        error: 'Authentication required. Provide X-Luna-Bot-Token header or POST /staff/auth/login first.',
        auth_url: '/staff/auth/login',
      });
      return { ok: false };
    }

    if (!enforceAuthenticatedStaffRouteAuthz(req, res, user)) return { ok: false };
    return { ok: true, user, auth_mode: 'session' };
  };
}

module.exports = {
  createRequireBotAuth,
  tokensMatch,
};
