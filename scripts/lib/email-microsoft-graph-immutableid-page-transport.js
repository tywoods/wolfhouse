'use strict';

/**
 * Microsoft Graph delegated ImmutableId page transport (runtime-capable, UNWIRED).
 *
 * Thin public surface over the single network owner
 * (`email-microsoft-graph-delegated-messages-transport`):
 * - exact pinned Prefer: IdType="ImmutableId"
 * - private success→canonical-envelope path (no public provenance mint)
 * - same path/$top/$select/caps/cleanup/failure sanitization as count health
 *
 * Does not duplicate the HTTP lifecycle. Does not export mint, brand, capability,
 * raw validated pages, or a generic success callback. Not wired into routes,
 * OAuth composition, DB, persistence, dedup, deploy, Azure, or live Graph.
 *
 * @module email-microsoft-graph-immutableid-page-transport
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
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdPageTransport,
} = require('./email-microsoft-graph-delegated-messages-transport');

const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID = true;
const EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX = TOP_MAX;

module.exports = Object.freeze({
  FAILURE_CODE: IMMUTABLEID_PAGE_FAILURE_CODE,
  FAILURE_MESSAGE: IMMUTABLEID_PAGE_FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  HOST,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdPageTransport,
});
