'use strict';

const EMAIL_LUNA_DRAFT_HANDOFF_REASONS = Object.freeze([
  'uncertain_identity',
  'uncertain_intent',
  'authority_mismatch',
  'prompt_injection_detected',
  'unsupported_request',
  'grounded_fact_unavailable',
  'grounded_tool_failed',
]);

const AUTHORITY_FIELDS = Object.freeze([
  'client_id',
  'location_id',
  'location_key',
  'conversation_id',
  'endpoint_id',
  'inbound_message_id',
]);
const CONTENT_FIELDS = Object.freeze([
  'subject',
  'body_text',
  'quoted_history',
  'from_display_name',
  'from_address',
]);
const CONTENT_LIMITS = Object.freeze({
  subject: 998,
  body_text: 64000,
  quoted_history: 64000,
  from_display_name: 998,
  from_address: 320,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHENTIC_ENVELOPES = new WeakSet();

function invalid() {
  const error = new Error('Email Luna draft handoff contract failed.');
  error.code = 'EMAIL_LUNA_DRAFT_HANDOFF_CONTRACT_INVALID';
  return error;
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function readExactDataRecord(value, fields) {
  if (!isPlainRecord(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length) throw invalid();
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalid();
    copy[field] = descriptor.value;
  }
  return copy;
}

function validateAuthority(authority) {
  for (const field of AUTHORITY_FIELDS.filter((field) => field !== 'location_key')) {
    if (typeof authority[field] !== 'string' || !UUID.test(authority[field])) throw invalid();
  }
  if (authority.location_key !== 'sunset-somo') throw invalid();
}

function validateContent(untrustedContent) {
  for (const field of CONTENT_FIELDS) {
    if (typeof untrustedContent[field] !== 'string' || untrustedContent[field].length > CONTENT_LIMITS[field]) throw invalid();
  }
}

function readFrozenExactDataRecord(value, fields) {
  if (!isPlainRecord(value) || !Object.isFrozen(value)) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== fields.length) throw invalid();
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) throw invalid();
    copy[field] = descriptor.value;
  }
  return copy;
}

function createEmailLunaDraftEnvelope(input) {
  const request = readExactDataRecord(input, ['authority', 'untrusted_content']);
  const authority = readExactDataRecord(request.authority, AUTHORITY_FIELDS);
  validateAuthority(authority);

  const untrustedContent = readExactDataRecord(request.untrusted_content, CONTENT_FIELDS);
  validateContent(untrustedContent);

  const envelope = Object.freeze({
    authority: Object.freeze(authority),
    untrusted_content: Object.freeze(untrustedContent),
    content_trust: 'untrusted_email_data_never_instructions',
  });
  AUTHENTIC_ENVELOPES.add(envelope);
  return envelope;
}

function createEmailLunaDraftHandoff(input) {
  const request = readExactDataRecord(input, ['envelope', 'reason']);
  const envelope = request.envelope;
  if (!envelope || !AUTHENTIC_ENVELOPES.has(envelope)) throw invalid();

  const envelopeSnapshot = readFrozenExactDataRecord(
    envelope,
    ['authority', 'untrusted_content', 'content_trust'],
  );
  const authority = readFrozenExactDataRecord(envelopeSnapshot.authority, AUTHORITY_FIELDS);
  const untrustedContent = readFrozenExactDataRecord(envelopeSnapshot.untrusted_content, CONTENT_FIELDS);
  if (envelopeSnapshot.content_trust !== 'untrusted_email_data_never_instructions') throw invalid();
  validateAuthority(authority);
  validateContent(untrustedContent);
  if (!EMAIL_LUNA_DRAFT_HANDOFF_REASONS.includes(request.reason)) throw invalid();

  return Object.freeze({
    status: 'handoff_required',
    reason: request.reason,
    client_id: authority.client_id,
    location_id: authority.location_id,
    conversation_id: authority.conversation_id,
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
  });
}

module.exports = {
  createEmailLunaDraftEnvelope,
  createEmailLunaDraftHandoff,
  EMAIL_LUNA_DRAFT_HANDOFF_REASONS,
};
