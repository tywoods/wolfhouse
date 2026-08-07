'use strict';

/**
 * Offline Microsoft Graph list-page → canonical inbound-envelope bridge.
 *
 * Composes (does not re-parse):
 * - delegated transport page/row semantics via classifyParsedMessageEnvelopeList
 *   (exact Mail.ReadBasic max-5 page; validates then discards @odata.context,
 *   @odata.nextLink, and per-row @odata.etag)
 * - mapMicrosoftGraphMailReadBasicRowToInboundEnvelope for each row
 * - compareInboundEmailEnvelopesForOrder for deterministic contract order
 *
 * Shared-validator extraction decision: NOT required for safe reuse.
 * Transport already exports the approved page classifier; mapper already owns
 * single-row → canonical conversion. Extracting a third shared schema module
 * would be a broad transport refactor with dual-gate risk. Composition reuses
 * the existing contracts without inventing a competing page/envelope DTO.
 * EMAIL_MS_GRAPH_NORMALIZED_PAGE_SHARED_VALIDATOR_EXTRACTED = false.
 *
 * Input must explicitly include provider mailbox identity and Graph ImmutableId
 * provenance. Caller boolean/string/"proven" objects are rejected. Offline
 * success uses only the module-owned unauthenticated provenance token
 * (reference equality). This module does **not** export any capability, factory,
 * or mint that can produce authenticated provenance. Prefer: IdType="ImmutableId"
 * mapping is owned exclusively by the pinned HTTP execution path in the
 * delegated messages transport (private success→envelope path).
 *
 * This slice is explicitly non-persistence-ready and does not claim ImmutableId
 * provenance. Output is a fresh frozen array of at most TOP_MAX (5) canonical
 * envelopes. Retains no raw page/rows. No logging, network, DB, OAuth, routes,
 * or runtime wiring.
 *
 * @module email-microsoft-graph-normalized-page
 */

const util = require('util');

const {
  compareInboundEmailEnvelopesForOrder,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');

const {
  mapMicrosoftGraphMailReadBasicRowToInboundEnvelope,
} = require('./email-microsoft-graph-inbound-envelope-mapper');

const {
  TOP_MAX,
  classifyParsedMessageEnvelopeList,
} = require('./email-microsoft-graph-delegated-messages-transport');

const PROVIDER_ID = 'microsoft_graph';

/**
 * Explicit non-persistence-ready offline slice. Future persistence requires
 * Prefer: IdType="ImmutableId" provenance authenticated by the pinned HTTP
 * transport path — not a caller boolean/string or public mint.
 */
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_CLAIMS_IMMUTABLE_ID_PROVENANCE = false;
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX = TOP_MAX;

/**
 * Safe reuse composes transport + mapper + contract. No shared-validator
 * module extraction (without broad refactor).
 */
const EMAIL_MS_GRAPH_NORMALIZED_PAGE_SHARED_VALIDATOR_EXTRACTED = false;

/**
 * Module-owned unauthenticated provenance token. Offline callers must pass
 * this exact reference — clones, lookalikes, booleans, and strings fail closed.
 * Acknowledges unknown ImmutableId provenance; keeps the slice non-persistence-ready.
 */
const GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED = Object.freeze(Object.create(null));

const INPUT_KEYS = Object.freeze([
  'provider',
  'provider_mailbox_id',
  'page',
  'graph_immutable_id_provenance',
]);
const INPUT_KEY_SET = new Set(INPUT_KEYS);
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;

function deepFreezeFresh(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeFresh));
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = deepFreezeFresh(value[key]);
  }
  return Object.freeze(out);
}

function fail(error, details) {
  const out = { ok: false, error: String(error) };
  if (details !== undefined) out.details = deepFreezeFresh(details);
  return Object.freeze(out);
}

function ok(value) {
  return Object.freeze({ ok: true, value: deepFreezeFresh(value) });
}

function isProxySurface(value) {
  try {
    if (typeof PINNED_IS_PROXY !== 'function' || !PINNED_UTIL_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_UTIL_TYPES, [value]) === true;
  } catch {
    return true;
  }
}

function isPlainOwnDataObject(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (isProxySurface(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function hasUnpairedSurrogate(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function snapshotOwnDataProps(obj) {
  try {
    if (!isPlainOwnDataObject(obj)) {
      return { ok: false, reason: 'must_be_object' };
    }
    const out = Object.create(null);
    for (const key of Reflect.ownKeys(obj)) {
      if (typeof key === 'symbol') {
        return { ok: false, reason: 'symbol_key' };
      }
      if (DANGEROUS_KEYS.has(key)) {
        return { ok: false, reason: 'dangerous_key', key };
      }
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) continue;
      if (desc.enumerable !== true) {
        return { ok: false, reason: 'non_enumerable', key };
      }
      if (typeof desc.get === 'function' || typeof desc.set === 'function') {
        return { ok: false, reason: 'accessor', key };
      }
      if (!Object.prototype.hasOwnProperty.call(desc, 'value')) {
        return { ok: false, reason: 'accessor', key };
      }
      out[key] = desc.value;
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false, reason: 'reflection_failed' };
  }
}

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accept provenance only when exact reference to module-owned unauthenticated
 * token (non-persistence-ready). Never trust caller booleans, strings, plain
 * "proven" objects, or any forgeable authenticated lookalike. No public mint.
 */
function acceptGraphImmutableIdProvenance(value) {
  if (value === GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED) {
    return { ok: true, authenticated: false };
  }
  return { ok: false };
}

/**
 * Map one already-classified Graph message list page to fresh frozen canonical
 * inbound envelopes (max TOP_MAX). Provider mailbox + ImmutableId provenance
 * are required explicit inputs.
 *
 * @param {unknown} input exact own-data
 *   `{ provider, provider_mailbox_id, page, graph_immutable_id_provenance }`
 * @returns {{ok:true,value:object[]}|{ok:false,error:string,details?:object}}
 */
function mapMicrosoftGraphPageToInboundEnvelopes(input) {
  const snap = snapshotOwnDataProps(input);
  if (!snap.ok) {
    return fail('graph_normalized_page_input_invalid', { reason: snap.reason, key: snap.key });
  }
  const o = snap.value;
  for (const key of Object.keys(o)) {
    if (!INPUT_KEY_SET.has(key)) {
      return fail('graph_normalized_page_input_invalid', { reason: 'unknown_key' });
    }
  }
  for (const required of INPUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(o, required)) {
      return fail('graph_normalized_page_input_invalid', {
        reason: 'missing_key',
        key: required,
      });
    }
  }

  if (o.provider !== PROVIDER_ID) {
    return fail('graph_normalized_page_provider_invalid');
  }

  if (typeof o.provider_mailbox_id !== 'string'
      || o.provider_mailbox_id.length < 1
      || o.provider_mailbox_id.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX
      || hasUnpairedSurrogate(o.provider_mailbox_id)) {
    return fail('graph_normalized_page_mailbox_invalid');
  }

  const provenance = acceptGraphImmutableIdProvenance(o.graph_immutable_id_provenance);
  if (!provenance.ok) {
    return fail('graph_normalized_page_provenance_invalid');
  }

  // Reuse delegated transport page/row semantics — validate then discard
  // @odata.context / @odata.nextLink / etag; no second page parser schema.
  const classified = classifyParsedMessageEnvelopeList(o.page);
  if (!classified || classified.stage !== 'success' || typeof classified.count !== 'number') {
    return fail('graph_normalized_page_page_invalid', {
      reason: classified && typeof classified.stage === 'string'
        ? classified.stage
        : 'page_invalid',
    });
  }
  if (classified.count > EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX) {
    return fail('graph_normalized_page_page_invalid', { reason: 'over_max' });
  }

  // Re-read value array only after transport classifier accepted the page.
  // Do not retain context/nextLink/etag (already validated+discarded by classifier).
  const rows = ownData(o.page, 'value');
  if (!Array.isArray(rows) || rows.length !== classified.count) {
    return fail('graph_normalized_page_page_invalid', { reason: 'value_mismatch' });
  }

  const envelopes = [];
  for (let i = 0; i < rows.length; i += 1) {
    const mapped = mapMicrosoftGraphMailReadBasicRowToInboundEnvelope({
      provider: PROVIDER_ID,
      provider_mailbox_id: o.provider_mailbox_id,
      row: rows[i],
    });
    if (!mapped.ok) {
      // Fail closed — no partial page of envelopes.
      return fail('graph_normalized_page_row_invalid', {
        reason: mapped.error || 'row_map_failed',
      });
    }
    envelopes.push(mapped.value);
  }

  // Deterministic contract order: received_at desc, identity tuple ASC tie-break.
  envelopes.sort(compareInboundEmailEnvelopesForOrder);

  // Fresh frozen array only — raw page/rows not retained on the result surface.
  return ok(envelopes);
}

module.exports = {
  mapMicrosoftGraphPageToInboundEnvelopes,
  GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_CLAIMS_IMMUTABLE_ID_PROVENANCE,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX,
  EMAIL_MS_GRAPH_NORMALIZED_PAGE_SHARED_VALIDATOR_EXTRACTED,
};
