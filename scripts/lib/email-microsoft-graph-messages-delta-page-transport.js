'use strict';

/**
 * Microsoft Graph messages-delta single-page transport (UNWIRED).
 *
 * Thin public surface over the single network owner
 * (`email-microsoft-graph-delegated-messages-transport`):
 * - exact pinned Prefer: IdType="ImmutableId"
 * - exact authority-bound initial path
 *   `/v1.0/users/{canonicalUuid}/messages/delta?$top=5&$select=…` (not `/me`)
 * - continuation reuses PR408 `validateMessagesDeltaCursorUrl` (nextLink→$skiptoken
 *   only, deltaLink→$deltatoken only; validated provider URL used verbatim —
 *   append nothing)
 * - success: frozen DTO `{ envelopes, tombstones, successor_cursor, observed_count }`
 * - continuation HTTP 410 → private `cursor_gone` via
 *   `readTrustedMessagesDeltaOutcome` (public error remains generic)
 *
 * Does not duplicate the HTTP lifecycle. Does not export mint, brand, capability,
 * raw pages, tokens, or authority. Not wired into routes, OAuth composition, DB,
 * store, lease, grant, persistence, deploy, Azure, or live Graph.
 *
 * Existing health / ImmutableId / bounded-catchup factories remain byte-compatible
 * on the same network owner.
 *
 * @module email-microsoft-graph-messages-delta-page-transport
 */

const {
  PREFER_IMMUTABLE_ID,
  MESSAGES_DELTA_PAGE_FAILURE_CODE,
  MESSAGES_DELTA_PAGE_FAILURE_MESSAGE,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  MESSAGES_DELTA_PAGE_RESULT_KEYS,
  MESSAGES_DELTA_CURSOR_KINDS,
  buildMessagesDeltaInitialPath,
  buildImmutableIdUserMessagesPath,
  validateMessagesDeltaCursorUrl,
  readTrustedGraphStage,
  readTrustedMessagesDeltaOutcome,
  createMicrosoftGraphMessagesDeltaPageTransport,
} = require('./email-microsoft-graph-delegated-messages-transport');

const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID = true;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_USES_USERS_DELTA_PATH = true;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_MAX = TOP_MAX;
const EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_REUSES_PR408_CURSOR = true;

module.exports = Object.freeze({
  FAILURE_CODE: MESSAGES_DELTA_PAGE_FAILURE_CODE,
  FAILURE_MESSAGE: MESSAGES_DELTA_PAGE_FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  HOST,
  /** Count-health `/me` path pin (re-export only — delta uses users/…/messages/delta). */
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  MESSAGES_DELTA_PAGE_RESULT_KEYS,
  MESSAGES_DELTA_CURSOR_KINDS,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_USES_USERS_DELTA_PATH,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_MAX,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_REUSES_PR408_CURSOR,
  buildMessagesDeltaInitialPath,
  buildImmutableIdUserMessagesPath,
  validateMessagesDeltaCursorUrl,
  readTrustedGraphStage,
  readTrustedMessagesDeltaOutcome,
  createMicrosoftGraphMessagesDeltaPageTransport,
});
