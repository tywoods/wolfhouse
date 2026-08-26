'use strict';

/** Canonical PUT/GET /staff/inbox/luna-mode — channel defaults. Email default remains draft. */
const {
  createEmailInboxChannelModeStore,
  normalizeEmailMode,
  normalizeWhatsAppMode,
} = require('./email-inbox-channel-mode');

const INBOX_LUNA_MODE_PATH = '/staff/inbox/luna-mode';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createStaffInboxLunaModeRoutes(deps) {
  if (!deps || typeof deps.sendJSON !== 'function' || typeof deps.withPgClient !== 'function') {
    throw new Error('luna_mode_routes_deps');
  }
  const store = createEmailInboxChannelModeStore({ withPgClient: deps.withPgClient });

  async function handlePut(req, res, user, body) {
    if (!user || !UUID.test(String(user.client_id || '').toLowerCase())) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    const scope = body && body.scope;
    const channel = body && body.channel;
    const value = body && body.value;
    if (scope !== 'channel' || (channel !== 'email' && channel !== 'whatsapp')) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    const next = await store.putChannelMode(user.client_id, channel, value);
    return deps.sendJSON(res, 200, {
      success: true,
      scope: 'channel',
      channel,
      value: channel === 'email' ? normalizeEmailMode(next.email) : normalizeWhatsAppMode(next.whatsapp),
    });
  }

  async function handleGet(req, res, user) {
    if (!user || !UUID.test(String(user.client_id || '').toLowerCase())) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    const modes = await store.loadModes(user.client_id);
    return deps.sendJSON(res, 200, { success: true, modes });
  }

  return Object.freeze({
    INBOX_LUNA_MODE_PATH,
    handlePut,
    handleGet,
  });
}

module.exports = {
  INBOX_LUNA_MODE_PATH,
  createStaffInboxLunaModeRoutes,
};
