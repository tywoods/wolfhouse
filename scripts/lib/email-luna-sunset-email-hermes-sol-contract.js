'use strict';

/**
 * MAIL-MVP-007 — closed Staff↔Hermes email-draft plan contract.
 *
 * Hermes receives a structured envelope (never a free system prompt) and
 * returns a closed enumerated plan plus server-owned provenance. Staff API
 * validates/renders/persists. No send, approval, journal, or booking writes.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const create = Object.create;
const getProto = Object.getPrototypeOf;
const getDesc = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const ownKeys = Reflect.ownKeys;

const HERMES_SOL_PROVIDER = 'openai-codex';
const HERMES_SOL_MODEL = 'gpt-5.6-sol';
const HERMES_SOL_RUNTIME = 'sunset-email-luna';
const HERMES_SOL_ROLE = 'sunset-email-luna';
const HERMES_SOL_TENANT = 'sunset';
const HERMES_SOL_LOCATION_KEY = 'sunset-somo';
const HERMES_SOL_REQUEST_SCHEMA = 'sunset_email_luna_draft_plan_v1';
const HERMES_SOL_RESULT_SCHEMA = 'sunset_email_luna_draft_plan_result_v1';
const HERMES_SOL_TEMPLATE_REQUEST_SCHEMA = 'sunset_email_luna_template_plan_v1';
const HERMES_SOL_TEMPLATE_RESULT_SCHEMA = 'sunset_email_luna_template_plan_result_v1';
const HERMES_SOL_DRAFT_PATH = '/v1/internal/email-draft-plan';
const HERMES_SOL_MARKER_NAME = 'email_luna_hermes_sol';

const REQUEST_KEYS = freeze([
  'schema', 'tenant_id', 'location_key', 'client_id', 'location_id',
  'conversation_id', 'endpoint_id', 'inbound_message_id', 'language',
  'untrusted_email', 'private_staff_goals', 'request_id',
]);
const RESULT_KEYS = freeze(['schema', 'acts', 'provenance']);
const TEMPLATE_RESULT_KEYS = freeze(['schema', 'plan', 'provenance']);
const TEMPLATE_PLAN_KEYS = freeze(['template_id', 'tone', 'question_key', 'acknowledgment_key']);
const PROVENANCE_KEYS = freeze([
  'provider', 'model', 'runtime', 'tenant_id', 'location_key',
  'client_id', 'location_id', 'conversation_id', 'inbound_message_id',
]);
const EMAIL_KEYS = freeze([
  'subject', 'body_text', 'quoted_history', 'from_display_name', 'from_address',
]);
const GOALS_KEYS = freeze(['trust', 'goals']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_JSON_BYTES = 96 * 1024;
const MAX_RESULT_JSON_BYTES = 16 * 1024;
const MAX_GOALS_CHARS = 500;
const PRIVATE_STAFF_TRUST = 'untrusted_private_staff_instructions_never_guest_copy_never_quoted_guest_history';

function ownData(value, key) {
  try {
    const descriptor = getDesc(value, key);
    return descriptor && hasOwn(descriptor, 'value') && descriptor.enumerable && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactRecord(value, keys, proto) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return null;
  let actualProto;
  try { actualProto = getProto(value); } catch { return null; }
  if (actualProto !== proto && actualProto !== Object.prototype && actualProto !== null) return null;
  let keysFound;
  try { keysFound = ownKeys(value); } catch { return null; }
  if (!keysFound.length || keysFound.some((key) => typeof key !== 'string')) return null;
  if (keysFound.length !== keys.length) return null;
  const out = create(null);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    let found = false;
    for (let j = 0; j < keysFound.length; j += 1) {
      if (keysFound[j] === key) found = true;
    }
    if (!found) return null;
    out[key] = ownData(value, key);
  }
  return out;
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function clipString(value, max) {
  if (typeof value !== 'string' || isProxy(value)) return null;
  if (value.length > max) return null;
  return value;
}

function snapshotUntrustedEmail(value) {
  const rec = exactRecord(value, EMAIL_KEYS, Object.prototype);
  if (!rec) return null;
  const out = create(null);
  out.subject = clipString(rec.subject, 998);
  out.body_text = clipString(rec.body_text, 64000);
  out.quoted_history = clipString(rec.quoted_history, 64000);
  out.from_display_name = clipString(rec.from_display_name, 998);
  out.from_address = clipString(rec.from_address, 320);
  if (out.subject == null || out.body_text == null || out.quoted_history == null
      || out.from_display_name == null || out.from_address == null) {
    return null;
  }
  return freeze(out);
}

function snapshotGoals(value) {
  const rec = exactRecord(value, GOALS_KEYS, Object.prototype);
  if (!rec) return null;
  if (rec.trust !== PRIVATE_STAFF_TRUST) return null;
  const goals = clipString(rec.goals, MAX_GOALS_CHARS);
  if (goals == null) return null;
  const out = create(null);
  out.trust = PRIVATE_STAFF_TRUST;
  out.goals = goals;
  return freeze(out);
}

function snapshotAuthorityIds(rec) {
  const clientId = uuid(rec.client_id);
  const locationId = uuid(rec.location_id);
  const conversationId = uuid(rec.conversation_id);
  const endpointId = uuid(rec.endpoint_id);
  const inboundMessageId = uuid(rec.inbound_message_id);
  if (!clientId || !locationId || !conversationId || !endpointId || !inboundMessageId) return null;
  return freeze({
    client_id: clientId,
    location_id: locationId,
    conversation_id: conversationId,
    endpoint_id: endpointId,
    inbound_message_id: inboundMessageId,
  });
}

function parseDraftPlanRequest(raw) {
  if (typeof raw !== 'string' || isProxy(raw)) return freeze({ ok: false, reason: 'malformed' });
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_JSON_BYTES) {
    return freeze({ ok: false, reason: 'oversized' });
  }
  let value;
  try { value = JSON.parse(raw); } catch { return freeze({ ok: false, reason: 'malformed' }); }
  const rec = exactRecord(value, REQUEST_KEYS, Object.prototype);
  if (!rec) return freeze({ ok: false, reason: 'malformed' });
  if (rec.schema !== HERMES_SOL_REQUEST_SCHEMA && rec.schema !== HERMES_SOL_TEMPLATE_REQUEST_SCHEMA) {
    return freeze({ ok: false, reason: 'malformed' });
  }
  if (rec.tenant_id !== HERMES_SOL_TENANT) return freeze({ ok: false, reason: 'wrong_tenant' });
  if (rec.location_key !== HERMES_SOL_LOCATION_KEY) return freeze({ ok: false, reason: 'wrong_location' });
  if (rec.language !== 'en' && rec.language !== 'es') return freeze({ ok: false, reason: 'malformed' });
  const ids = snapshotAuthorityIds(rec);
  if (!ids) return freeze({ ok: false, reason: 'malformed' });
  const email = snapshotUntrustedEmail(rec.untrusted_email);
  if (!email) return freeze({ ok: false, reason: 'malformed' });
  const goals = snapshotGoals(rec.private_staff_goals);
  if (!goals) return freeze({ ok: false, reason: 'malformed' });
  const requestId = uuid(rec.request_id);
  if (!requestId) return freeze({ ok: false, reason: 'malformed' });
  const out = create(null);
  out.schema = rec.schema;
  out.tenant_id = HERMES_SOL_TENANT;
  out.location_key = HERMES_SOL_LOCATION_KEY;
  out.client_id = ids.client_id;
  out.location_id = ids.location_id;
  out.conversation_id = ids.conversation_id;
  out.endpoint_id = ids.endpoint_id;
  out.inbound_message_id = ids.inbound_message_id;
  out.language = rec.language;
  out.untrusted_email = email;
  out.private_staff_goals = goals;
  out.request_id = requestId;
  return freeze({ ok: true, value: freeze(out) });
}

function parseProvenance(value, expectedIds) {
  const rec = exactRecord(value, PROVENANCE_KEYS, Object.prototype);
  if (!rec) return null;
  if (rec.provider !== HERMES_SOL_PROVIDER) return null;
  if (rec.model !== HERMES_SOL_MODEL) return null;
  if (rec.runtime !== HERMES_SOL_RUNTIME) return null;
  if (rec.tenant_id !== HERMES_SOL_TENANT) return null;
  if (rec.location_key !== HERMES_SOL_LOCATION_KEY) return null;
  if (!expectedIds) return null;
  if (rec.client_id !== expectedIds.client_id) return null;
  if (rec.location_id !== expectedIds.location_id) return null;
  if (rec.conversation_id !== expectedIds.conversation_id) return null;
  if (rec.inbound_message_id !== expectedIds.inbound_message_id) return null;
  return freeze({
    provider: HERMES_SOL_PROVIDER,
    model: HERMES_SOL_MODEL,
    runtime: HERMES_SOL_RUNTIME,
    tenant_id: HERMES_SOL_TENANT,
    location_key: HERMES_SOL_LOCATION_KEY,
    client_id: expectedIds.client_id,
    location_id: expectedIds.location_id,
    conversation_id: expectedIds.conversation_id,
    inbound_message_id: expectedIds.inbound_message_id,
  });
}

function parseDraftPlanResult(raw, expectedIds) {
  if (typeof raw !== 'string' || isProxy(raw)) return freeze({ ok: false, reason: 'malformed' });
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESULT_JSON_BYTES) {
    return freeze({ ok: false, reason: 'malformed' });
  }
  let value;
  try { value = JSON.parse(raw); } catch { return freeze({ ok: false, reason: 'malformed' }); }
  const rec = exactRecord(value, RESULT_KEYS, Object.prototype);
  if (!rec) return freeze({ ok: false, reason: 'malformed' });
  if (rec.schema !== HERMES_SOL_RESULT_SCHEMA) return freeze({ ok: false, reason: 'malformed' });
  const provenance = parseProvenance(rec.provenance, expectedIds);
  if (!provenance) return freeze({ ok: false, reason: 'provenance_mismatch' });
  if (typeof rec.acts === 'string') {
    return freeze({ ok: true, value: freeze({ schema: rec.schema, actsJson: rec.acts, provenance }) });
  }
  try {
    const actsJson = JSON.stringify({ acts: rec.acts });
    return freeze({ ok: true, value: freeze({ schema: rec.schema, actsJson, provenance, acts: rec.acts }) });
  } catch {
    return freeze({ ok: false, reason: 'malformed' });
  }
}

function parseTemplatePlanResult(raw, expectedIds) {
  if (typeof raw !== 'string' || isProxy(raw)) return freeze({ ok: false, reason: 'malformed' });
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESULT_JSON_BYTES) {
    return freeze({ ok: false, reason: 'malformed' });
  }
  let value;
  try { value = JSON.parse(raw); } catch { return freeze({ ok: false, reason: 'malformed' }); }
  const rec = exactRecord(value, TEMPLATE_RESULT_KEYS, Object.prototype);
  if (!rec) return freeze({ ok: false, reason: 'malformed' });
  if (rec.schema !== HERMES_SOL_TEMPLATE_RESULT_SCHEMA) return freeze({ ok: false, reason: 'malformed' });
  const provenance = parseProvenance(rec.provenance, expectedIds);
  if (!provenance) return freeze({ ok: false, reason: 'provenance_mismatch' });
  const plan = exactRecord(rec.plan, TEMPLATE_PLAN_KEYS, Object.prototype);
  if (!plan) return freeze({ ok: false, reason: 'malformed' });
  try {
    return freeze({
      ok: true,
      value: freeze({
        schema: rec.schema,
        planJson: JSON.stringify(plan),
        provenance,
        plan: freeze(plan),
      }),
    });
  } catch {
    return freeze({ ok: false, reason: 'malformed' });
  }
}

function buildServerProvenance(ids) {
  if (!ids) return null;
  const clientId = uuid(ids.client_id);
  const locationId = uuid(ids.location_id);
  const conversationId = uuid(ids.conversation_id);
  const inboundMessageId = uuid(ids.inbound_message_id);
  if (!clientId || !locationId || !conversationId || !inboundMessageId) return null;
  return freeze({
    provider: HERMES_SOL_PROVIDER,
    model: HERMES_SOL_MODEL,
    runtime: HERMES_SOL_RUNTIME,
    tenant_id: HERMES_SOL_TENANT,
    location_key: HERMES_SOL_LOCATION_KEY,
    client_id: clientId,
    location_id: locationId,
    conversation_id: conversationId,
    inbound_message_id: inboundMessageId,
  });
}

function closedRuntimeMarker(provenance) {
  const rec = provenance && typeof provenance === 'object' ? provenance : null;
  const provider = rec ? ownData(rec, 'provider') : undefined;
  const model = rec ? ownData(rec, 'model') : undefined;
  const runtime = rec ? ownData(rec, 'runtime') : undefined;
  if (provider !== HERMES_SOL_PROVIDER || model !== HERMES_SOL_MODEL || runtime !== HERMES_SOL_RUNTIME) {
    return null;
  }
  return freeze({
    name: HERMES_SOL_MARKER_NAME,
    provider: HERMES_SOL_PROVIDER,
    model: HERMES_SOL_MODEL,
    runtime: HERMES_SOL_RUNTIME,
  });
}

function bindRequestToAuthority(parsed, authority) {
  if (!parsed || parsed.ok !== true || !parsed.value || !authority) return false;
  const req = parsed.value;
  return req.client_id === authority.client_id
    && req.location_id === authority.location_id
    && req.conversation_id === authority.conversation_id
    && req.endpoint_id === authority.endpoint_id
    && req.inbound_message_id === authority.inbound_message_id
    && req.tenant_id === HERMES_SOL_TENANT
    && req.location_key === HERMES_SOL_LOCATION_KEY;
}

module.exports = freeze({
  HERMES_SOL_PROVIDER,
  HERMES_SOL_MODEL,
  HERMES_SOL_RUNTIME,
  HERMES_SOL_ROLE,
  HERMES_SOL_TENANT,
  HERMES_SOL_LOCATION_KEY,
  HERMES_SOL_REQUEST_SCHEMA,
  HERMES_SOL_RESULT_SCHEMA,
  HERMES_SOL_TEMPLATE_REQUEST_SCHEMA,
  HERMES_SOL_TEMPLATE_RESULT_SCHEMA,
  HERMES_SOL_DRAFT_PATH,
  HERMES_SOL_MARKER_NAME,
  REQUEST_KEYS,
  RESULT_KEYS,
  PROVENANCE_KEYS,
  PRIVATE_STAFF_TRUST,
  MAX_REQUEST_JSON_BYTES,
  MAX_RESULT_JSON_BYTES,
  parseDraftPlanRequest,
  parseDraftPlanResult,
  parseTemplatePlanResult,
  parseProvenance,
  buildServerProvenance,
  closedRuntimeMarker,
  bindRequestToAuthority,
});
