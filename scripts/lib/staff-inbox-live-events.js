/**
 * In-process Inbox live-activity hub (Phase 3, `docs/INBOX-PORTAL-REDESIGN.md`).
 *
 * Staging Staff API is one replica, so an EventEmitter per process is enough:
 * no Redis, no LISTEN/NOTIFY, no new table. Events are namespaced by
 * `client_slug` so a Wolfhouse subscriber never sees a Sunset payload.
 *
 * Write paths call `emitInboxConversationUpdated` after a successful persist.
 * `GET /staff/inbox/stream` subscribes and forwards those events as SSE.
 *
 * @module staff-inbox-live-events
 */

'use strict';

const { EventEmitter } = require('events');

const INBOX_LIVE_EVENT_HEARTBEAT = 'heartbeat';
const INBOX_LIVE_EVENT_CONVERSATION_UPDATED = 'conversation-updated';

function channelName(clientSlug) {
  return `inbox:${clientSlug}`;
}

function trimSlug(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * @param {string} event
 * @param {object} data
 * @returns {string} one SSE frame
 */
function formatSseEvent(event, data) {
  const name = String(event || '').replace(/[\r\n]/g, '');
  if (!name) return '';
  return `event: ${name}\ndata: ${JSON.stringify(data == null ? {} : data)}\n\n`;
}

function createInboxLiveHub() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);

  function emitInboxConversationUpdated(clientSlug, conversationId) {
    try {
      const slug = trimSlug(clientSlug);
      const id = trimSlug(conversationId);
      if (!slug || !id) return false;
      const payload = Object.freeze({
        event: INBOX_LIVE_EVENT_CONVERSATION_UPDATED,
        client_slug: slug,
        conversation_id: id,
        ts: new Date().toISOString(),
      });
      emitter.emit(channelName(slug), payload);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function subscribeInboxLive(clientSlug, listener) {
    const slug = trimSlug(clientSlug);
    if (!slug || typeof listener !== 'function') return function unsubscribe() {};
    const ch = channelName(slug);
    emitter.on(ch, listener);
    return function unsubscribe() {
      emitter.off(ch, listener);
    };
  }

  function subscriberCount(clientSlug) {
    return emitter.listenerCount(channelName(trimSlug(clientSlug)));
  }

  return {
    emitInboxConversationUpdated,
    subscribeInboxLive,
    subscriberCount,
  };
}

const defaultHub = createInboxLiveHub();

function emitInboxConversationUpdated(clientSlug, conversationId) {
  return defaultHub.emitInboxConversationUpdated(clientSlug, conversationId);
}

function subscribeInboxLive(clientSlug, listener) {
  return defaultHub.subscribeInboxLive(clientSlug, listener);
}

function subscriberCount(clientSlug) {
  return defaultHub.subscriberCount(clientSlug);
}

module.exports = {
  INBOX_LIVE_EVENT_HEARTBEAT,
  INBOX_LIVE_EVENT_CONVERSATION_UPDATED,
  formatSseEvent,
  createInboxLiveHub,
  emitInboxConversationUpdated,
  subscribeInboxLive,
  subscriberCount,
};
