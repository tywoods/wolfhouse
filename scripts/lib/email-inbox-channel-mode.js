'use strict';

/**
 * Canonical Inbox channel-mode store (MAIL-MVP-003).
 *
 * Email default remains `draft` (not Auto). Auto is an explicit stored value.
 * Pause stays in `bot_pause_states` — this module does not invent a pause store.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;

const EMAIL_INBOX_CHANNEL_MODE_DEFAULT = 'draft';
const WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT = 'auto';
const EMAIL_INBOX_CHANNEL_MODES = freeze(['auto', 'draft', 'off']);
const CHANNELS = freeze(['email', 'whatsapp']);
const SQL_LOAD_CLIENT_CHANNEL_MODES = `
SELECT metadata->'inbox_channel_modes' AS inbox_channel_modes
  FROM clients
 WHERE id=$1::uuid
 LIMIT 1
`.replace(/\s+/g, ' ').trim();
const SQL_STORE_CLIENT_CHANNEL_MODES = `
UPDATE clients
   SET metadata = jsonb_set(
     COALESCE(metadata, '{}'::jsonb),
     '{inbox_channel_modes}',
     $2::jsonb,
     true
   )
 WHERE id=$1::uuid
 RETURNING metadata->'inbox_channel_modes' AS inbox_channel_modes
`.replace(/\s+/g, ' ').trim();

function ownData(o, k) {
  try {
    const d = getDescriptor(o, k);
    return d && hasOwn(d, 'value') && d.enumerable && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeChannel(channel) {
  return channel === 'email' || channel === 'whatsapp' ? channel : null;
}

function normalizeEmailMode(value) {
  if (value === 'auto' || value === 'off' || value === 'draft') return value;
  return EMAIL_INBOX_CHANNEL_MODE_DEFAULT;
}

function normalizeWhatsAppMode(value) {
  if (value === 'draft' || value === 'off' || value === 'auto') return value;
  return WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT;
}

function snapshotModes(raw) {
  const src = raw && typeof raw === 'object' && !isProxy(raw) && !Array.isArray(raw) ? raw : {};
  return freeze({
    email: normalizeEmailMode(ownData(src, 'email') || src.email),
    whatsapp: normalizeWhatsAppMode(ownData(src, 'whatsapp') || src.whatsapp),
  });
}

function parseJsonb(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  if (typeof value === 'object') return value;
  return {};
}

function createEmailInboxChannelModeStore(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') throw new Error('channel_mode_store_deps');
  const withPgClient = deps.withPgClient;

  async function loadModes(clientId) {
    try {
      const loaded = await withPgClient(async (pg) => pg.query(SQL_LOAD_CLIENT_CHANNEL_MODES, [clientId]));
      const row = loaded && Array.isArray(loaded.rows) && loaded.rows.length === 1 ? loaded.rows[0] : null;
      return snapshotModes(parseJsonb(row && (ownData(row, 'inbox_channel_modes') || row.inbox_channel_modes)));
    } catch {
      return snapshotModes(null);
    }
  }

  async function getChannelMode(clientId, channel) {
    const ch = normalizeChannel(channel);
    if (!ch || typeof clientId !== 'string' || !clientId) {
      return ch === 'whatsapp' ? WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT : EMAIL_INBOX_CHANNEL_MODE_DEFAULT;
    }
    const modes = await loadModes(clientId);
    return ch === 'email' ? modes.email : modes.whatsapp;
  }

  async function putChannelMode(clientId, channel, value) {
    const ch = normalizeChannel(channel);
    if (!ch || typeof clientId !== 'string' || !clientId) return snapshotModes(null);
    const current = await loadModes(clientId);
    const next = freeze({
      email: ch === 'email' ? normalizeEmailMode(value) : current.email,
      whatsapp: ch === 'whatsapp' ? normalizeWhatsAppMode(value) : current.whatsapp,
    });
    try {
      await withPgClient(async (pg) => pg.query(SQL_STORE_CLIENT_CHANNEL_MODES, [
        clientId,
        JSON.stringify(next),
      ]));
    } catch {
      return current;
    }
    return next;
  }

  return freeze({ loadModes, getChannelMode, putChannelMode });
}

module.exports = {
  createEmailInboxChannelModeStore,
  normalizeEmailMode,
  normalizeWhatsAppMode,
  snapshotModes,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
  WHATSAPP_INBOX_CHANNEL_MODE_DEFAULT,
  EMAIL_INBOX_CHANNEL_MODES,
  CHANNELS,
  SQL_LOAD_CLIENT_CHANNEL_MODES,
  SQL_STORE_CLIENT_CHANNEL_MODES,
};
