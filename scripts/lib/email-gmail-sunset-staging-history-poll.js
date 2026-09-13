'use strict';

/**
 * Sunset-staging Gmail history incremental poll helper (EMAIL-GMAIL-001 scaffolding).
 *
 * Cheap history.list polling by startHistoryId with idempotent dedupe on Gmail
 * message id. Inbound-only: ignores outbound SENT/DRAFT additions. No full mailbox
 * scrape, webhooks, routes, DB persistence, or live wiring.
 *
 * @module email-gmail-sunset-staging-history-poll
 */

const GMAIL_SUNSET_HISTORY_DEPLOYMENT = 'sunset-staging';
const GMAIL_SUNSET_HISTORY_HOST = 'gmail.googleapis.com';
const GMAIL_SUNSET_HISTORY_PATH = '/gmail/v1/users/me/history';
const GMAIL_SUNSET_HISTORY_DEFAULT_MAX_RESULTS = 100;
const GMAIL_SUNSET_HISTORY_MAX_RESULTS_LIMIT = 500;
const GMAIL_SUNSET_HISTORY_ID_RE = /^[0-9]{1,20}$/;
const GMAIL_SUNSET_GMAIL_MESSAGE_ID_RE = /^[0-9a-f]{10,32}$/i;
const GMAIL_SUNSET_INBOUND_EXCLUDED_LABELS = Object.freeze(['SENT', 'DRAFT', 'SPAM', 'TRASH']);
const GMAIL_SUNSET_INBOUND_PREFERRED_LABEL = 'INBOX';

const HISTORY_PAGE_KEYS = Object.freeze(['history', 'historyId']);
const HISTORY_RECORD_KEYS = Object.freeze(['id', 'messagesAdded']);
const MESSAGE_ADDED_KEYS = Object.freeze(['message']);
const MESSAGE_KEYS = Object.freeze(['id', 'labelIds']);

function deepFreezeFresh(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeFresh));
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepFreezeFresh(value[key]);
  return Object.freeze(out);
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = deepFreezeFresh(details);
  return Object.freeze(out);
}

function ok(value) {
  return value === undefined
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function snapshotOwnDataProps(object) {
  if (object == null || typeof object !== 'object' || Array.isArray(object)) {
    return { ok: false, reason: 'must_be_object' };
  }
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) return { ok: false, reason: 'must_be_object' };
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    if (!hasOwn(object, key)) continue;
    const desc = Object.getOwnPropertyDescriptor(object, key);
    if (!desc) continue;
    if (typeof desc.get === 'function' || typeof desc.set === 'function') {
      return { ok: false, reason: 'accessor', key: String(key) };
    }
    out[key] = desc.value;
  }
  return { ok: true, value: out };
}

function isHistoryId(value) {
  return typeof value === 'string' && GMAIL_SUNSET_HISTORY_ID_RE.test(value);
}

function isGmailMessageId(value) {
  return typeof value === 'string' && GMAIL_SUNSET_GMAIL_MESSAGE_ID_RE.test(value);
}

function exactKeys(object, keys) {
  const have = Object.keys(object);
  if (have.length !== keys.length) return false;
  const set = new Set(keys);
  return have.every((key) => set.has(key));
}

function normalizeLabelIds(raw) {
  if (!Array.isArray(raw)) return null;
  const labels = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!hasOwn(raw, String(index))) return null;
    const label = raw[index];
    if (typeof label !== 'string' || label.length < 1 || label.length > 64) return null;
    labels.push(label);
  }
  return labels;
}

function isInboundGmailMessage(labelIds) {
  if (!Array.isArray(labelIds)) return false;
  if (labelIds.some((label) => GMAIL_SUNSET_INBOUND_EXCLUDED_LABELS.includes(label))) return false;
  return labelIds.includes(GMAIL_SUNSET_INBOUND_PREFERRED_LABEL);
}

function buildGmailSunsetStagingHistoryListRequest(input) {
  const snap = snapshotOwnDataProps(input == null ? {} : input);
  if (!snap.ok) return fail('history_request_invalid', { reason: snap.reason });
  const value = snap.value;
  const allowed = ['startHistoryId', 'maxResults'];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    return fail('history_request_invalid', { reason: 'unknown_key' });
  }
  if (!hasOwn(value, 'startHistoryId')) return fail('history_request_invalid', { reason: 'missing_start_history_id' });
  if (!isHistoryId(value.startHistoryId)) return fail('history_request_invalid', { reason: 'start_history_id' });
  const maxResults = hasOwn(value, 'maxResults')
    ? value.maxResults
    : GMAIL_SUNSET_HISTORY_DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > GMAIL_SUNSET_HISTORY_MAX_RESULTS_LIMIT) {
    return fail('history_request_invalid', { reason: 'max_results' });
  }
  const params = new URLSearchParams([
    ['startHistoryId', value.startHistoryId],
    ['maxResults', String(maxResults)],
    ['historyTypes', 'messageAdded'],
  ]);
  return ok({
    deployment: GMAIL_SUNSET_HISTORY_DEPLOYMENT,
    host: GMAIL_SUNSET_HISTORY_HOST,
    path: GMAIL_SUNSET_HISTORY_PATH,
    query: params.toString(),
    request_url: `https://${GMAIL_SUNSET_HISTORY_HOST}${GMAIL_SUNSET_HISTORY_PATH}?${params.toString()}`,
    inbound_only: true,
    history_types: Object.freeze(['messageAdded']),
    full_mailbox_scrape: false,
  });
}

function parseGmailSunsetStagingHistoryListPage(raw) {
  const snap = snapshotOwnDataProps(raw);
  if (!snap.ok) return fail('history_page_invalid', { reason: snap.reason });
  const page = snap.value;
  if (!exactKeys(page, HISTORY_PAGE_KEYS)) return fail('history_page_invalid', { reason: 'key_set' });
  if (!isHistoryId(page.historyId)) return fail('history_page_invalid', { reason: 'successor_history_id' });
  if (!Array.isArray(page.history)) return fail('history_page_invalid', { reason: 'history_not_array' });
  const records = [];
  for (let index = 0; index < page.history.length; index += 1) {
    if (!hasOwn(page.history, String(index))) return fail('history_page_invalid', { reason: 'sparse_history' });
    const recordSnap = snapshotOwnDataProps(page.history[index]);
    if (!recordSnap.ok) return fail('history_page_invalid', { reason: 'history_record_shape' });
    const record = recordSnap.value;
    if (!exactKeys(record, HISTORY_RECORD_KEYS)) return fail('history_page_invalid', { reason: 'history_record_keys' });
    if (!isHistoryId(record.id)) return fail('history_page_invalid', { reason: 'history_record_id' });
    if (!Array.isArray(record.messagesAdded)) return fail('history_page_invalid', { reason: 'messages_added_not_array' });
    const messagesAdded = [];
    for (let addedIndex = 0; addedIndex < record.messagesAdded.length; addedIndex += 1) {
      if (!hasOwn(record.messagesAdded, String(addedIndex))) {
        return fail('history_page_invalid', { reason: 'sparse_messages_added' });
      }
      const addedSnap = snapshotOwnDataProps(record.messagesAdded[addedIndex]);
      if (!addedSnap.ok) return fail('history_page_invalid', { reason: 'message_added_shape' });
      const added = addedSnap.value;
      if (!exactKeys(added, MESSAGE_ADDED_KEYS)) return fail('history_page_invalid', { reason: 'message_added_keys' });
      const messageSnap = snapshotOwnDataProps(added.message);
      if (!messageSnap.ok) return fail('history_page_invalid', { reason: 'message_shape' });
      const message = messageSnap.value;
      if (!exactKeys(message, MESSAGE_KEYS)) return fail('history_page_invalid', { reason: 'message_keys' });
      if (!isGmailMessageId(message.id)) return fail('history_page_invalid', { reason: 'message_id' });
      const labelIds = normalizeLabelIds(message.labelIds);
      if (!labelIds) return fail('history_page_invalid', { reason: 'label_ids' });
      messagesAdded.push(Object.freeze({
        message: Object.freeze({ id: message.id, labelIds: Object.freeze(labelIds.slice()) }),
      }));
    }
    records.push(Object.freeze({
      id: record.id,
      messagesAdded: Object.freeze(messagesAdded),
    }));
  }
  return ok(Object.freeze({
    history: Object.freeze(records),
    historyId: page.historyId,
  }));
}

function applyGmailSunsetStagingHistoryPollPage(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) return fail('history_poll_invalid', { reason: snap.reason });
  const value = snap.value;
  const allowed = ['page', 'seenMessageIds', 'startHistoryId'];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    return fail('history_poll_invalid', { reason: 'unknown_key' });
  }
  if (!hasOwn(value, 'page') || !hasOwn(value, 'seenMessageIds') || !hasOwn(value, 'startHistoryId')) {
    return fail('history_poll_invalid', { reason: 'missing_key' });
  }
  if (!isHistoryId(value.startHistoryId)) return fail('history_poll_invalid', { reason: 'start_history_id' });
  const parsed = parseGmailSunsetStagingHistoryListPage(value.page);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(value.seenMessageIds)) return fail('history_poll_invalid', { reason: 'seen_not_array' });
  const seen = new Set();
  for (let index = 0; index < value.seenMessageIds.length; index += 1) {
    if (!hasOwn(value.seenMessageIds, String(index))) return fail('history_poll_invalid', { reason: 'sparse_seen' });
    const messageId = value.seenMessageIds[index];
    if (!isGmailMessageId(messageId)) return fail('history_poll_invalid', { reason: 'seen_message_id' });
    if (seen.has(messageId)) return fail('history_poll_invalid', { reason: 'seen_duplicate_input' });
    seen.add(messageId);
  }
  const inboundMessageIds = [];
  let duplicatesSkipped = 0;
  let outboundSkipped = 0;
  for (const record of parsed.value.history) {
    for (const added of record.messagesAdded) {
      const message = added.message;
      if (!isInboundGmailMessage(message.labelIds)) {
        outboundSkipped += 1;
        continue;
      }
      if (seen.has(message.id)) {
        duplicatesSkipped += 1;
        continue;
      }
      seen.add(message.id);
      inboundMessageIds.push(message.id);
    }
  }
  return ok(Object.freeze({
    deployment: GMAIL_SUNSET_HISTORY_DEPLOYMENT,
    start_history_id: value.startHistoryId,
    successor_history_id: parsed.value.historyId,
    inbound_message_ids: Object.freeze(inboundMessageIds.slice()),
    inbound_count: inboundMessageIds.length,
    duplicates_skipped: duplicatesSkipped,
    outbound_skipped: outboundSkipped,
    idempotent_by_gmail_message_id: true,
    inbound_only: true,
    full_mailbox_scrape: false,
  }));
}

function createGmailSunsetStagingHistoryPollService(deps) {
  const CORE_DEPS_KEYS = ['deployment', 'transport'];
  const FAILURE_CODE = 'gmail_sunset_history_poll_failed';
  function ownData(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  }
  function exactPlainData(object, keys) {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    return actual.length === keys.length
      && actual.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && !descriptor.get && !descriptor.set;
      });
  }
  function failure() {
    const error = new Error(FAILURE_CODE);
    error.code = FAILURE_CODE;
    return error;
  }

  let transport;
  let getJson;
  try {
    if (!exactPlainData(deps, CORE_DEPS_KEYS)
        || ownData(deps, 'deployment') !== GMAIL_SUNSET_HISTORY_DEPLOYMENT) {
      throw failure();
    }
    transport = ownData(deps, 'transport');
    if (!transport || typeof ownData(transport, 'getJson') !== 'function') throw failure();
    getJson = ownData(transport, 'getJson');
  } catch (error) {
    if (error && error.code === FAILURE_CODE) throw error;
    throw failure();
  }

  async function pollHistoryPage(input) {
    try {
      const snap = snapshotOwnDataProps(input);
      if (!snap.ok) throw failure();
      const value = snap.value;
      if (!hasOwn(value, 'accessToken') || !hasOwn(value, 'startHistoryId') || !hasOwn(value, 'seenMessageIds')) {
        throw failure();
      }
      if (Object.keys(value).length !== 3) throw failure();
      if (typeof value.accessToken !== 'string' || value.accessToken.length < 1 || value.accessToken.length > 8192) {
        throw failure();
      }
      const request = buildGmailSunsetStagingHistoryListRequest({
        startHistoryId: value.startHistoryId,
      });
      if (!request.ok) throw failure();
      const response = await Reflect.apply(getJson, transport, [{
        host: request.value.host,
        path: `${request.value.path}?${request.value.query}`,
        authorization: `Bearer ${value.accessToken}`,
        responseLimitBytes: 262144,
      }]);
      if (!response || ownData(response, 'statusCode') !== 200) throw failure();
      const body = ownData(response, 'body');
      const poll = applyGmailSunsetStagingHistoryPollPage({
        page: body,
        seenMessageIds: value.seenMessageIds,
        startHistoryId: value.startHistoryId,
      });
      if (!poll.ok) throw failure();
      return poll.value;
    } catch (error) {
      if (error && error.code === FAILURE_CODE) throw error;
      throw failure();
    }
  }

  return Object.freeze({ pollHistoryPage });
}

module.exports = Object.freeze({
  GMAIL_SUNSET_HISTORY_DEPLOYMENT,
  GMAIL_SUNSET_HISTORY_HOST,
  GMAIL_SUNSET_HISTORY_PATH,
  GMAIL_SUNSET_HISTORY_DEFAULT_MAX_RESULTS,
  GMAIL_SUNSET_HISTORY_MAX_RESULTS_LIMIT,
  GMAIL_SUNSET_INBOUND_EXCLUDED_LABELS,
  GMAIL_SUNSET_INBOUND_PREFERRED_LABEL,
  buildGmailSunsetStagingHistoryListRequest,
  parseGmailSunsetStagingHistoryListPage,
  applyGmailSunsetStagingHistoryPollPage,
  createGmailSunsetStagingHistoryPollService,
});
