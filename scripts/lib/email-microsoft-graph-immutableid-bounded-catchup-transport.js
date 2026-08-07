'use strict';

/**
 * Microsoft Graph delegated ImmutableId bounded-catchup transport (UNWIRED).
 *
 * Thin public surface over the single network owner
 * (`email-microsoft-graph-delegated-messages-transport`):
 * - multi-page sequential inbox retrieval with factory-fixed maxPages=10,
 *   maxMessages=50 (never caller-supplied)
 * - first request exact GET `/v1.0/users/{canonicalUuid}/messages` with
 *   Prefer: IdType="ImmutableId", same $top/$select as single-page
 * - follows only provider `@odata.nextLink` after strict validation
 * - canonical sort + identity dedupe via envelope-contract owners (same rules
 *   as batch processor) — **no** consumer invocation, **no** persistence
 * - success: one fresh frozen sanitized DTO with canonical envelopes + counts
 * - failure: existing sanitized ImmutableId transport failure only (atomic;
 *   no partial envelopes)
 *
 * Does not duplicate the HTTP lifecycle. Does not export mint, brand, capability,
 * raw pages, nextLink, or a generic success callback. Not wired into routes,
 * OAuth composition, DB, persistence, deploy, Azure, or live Graph.
 *
 * Existing single-page / count-health factories remain on their own surfaces and
 * stay byte-compatible.
 *
 * @module email-microsoft-graph-immutableid-bounded-catchup-transport
 */

const {
  PREFER_IMMUTABLE_ID,
  IMMUTABLEID_PAGE_FAILURE_CODE,
  IMMUTABLEID_PAGE_FAILURE_MESSAGE,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  BOUNDED_CATCHUP_MAX_PAGES,
  BOUNDED_CATCHUP_MAX_MESSAGES,
  buildImmutableIdUserMessagesPath,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdBoundedCatchupTransport,
} = require('./email-microsoft-graph-delegated-messages-transport');

const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PINS_PREFER_IMMUTABLE_ID = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_USES_USERS_PATH = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_INVOKES_CONSUMER = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_PAGES = BOUNDED_CATCHUP_MAX_PAGES;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_MESSAGES = BOUNDED_CATCHUP_MAX_MESSAGES;
const EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PAGE_SIZE = TOP_MAX;

module.exports = Object.freeze({
  FAILURE_CODE: IMMUTABLEID_PAGE_FAILURE_CODE,
  FAILURE_MESSAGE: IMMUTABLEID_PAGE_FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  HOST,
  /** Count-health `/me` path pin (re-export only — catchup uses users path). */
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  BOUNDED_CATCHUP_MAX_PAGES,
  BOUNDED_CATCHUP_MAX_MESSAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_USES_USERS_PATH,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_INVOKES_CONSUMER,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_PAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_MESSAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PAGE_SIZE,
  buildImmutableIdUserMessagesPath,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdBoundedCatchupTransport,
});
