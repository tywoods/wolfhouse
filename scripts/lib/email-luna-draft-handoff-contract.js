'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectIsFrozen = Object.isFrozen;
const reflectOwnKeys = Reflect.ownKeys;
const arrayFilter = uncurryThis(Array.prototype.filter);
const arrayIncludes = uncurryThis(Array.prototype.includes);
const regexpTest = uncurryThis(RegExp.prototype.test);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);

const EMAIL_LUNA_DRAFT_HANDOFF_REASONS = objectFreeze([
  'uncertain_identity',
  'uncertain_intent',
  'authority_mismatch',
  'prompt_injection_detected',
  'unsupported_request',
  'grounded_fact_unavailable',
  'grounded_tool_failed',
]);
// Kept separate so the public Slice 4.1 reason contract remains byte-for-byte compatible.
// These reasons are issued only by the branded draft-author boundary.
const EMAIL_LUNA_DRAFT_AUTHOR_HANDOFF_REASONS = objectFreeze([
  'model_malformed',
  'model_timeout',
  'model_provider_error',
  'unsupported_claim',
  'injection_echo_detected',
]);

const AUTHORITY_FIELDS = objectFreeze([
  'client_id',
  'location_id',
  'location_key',
  'conversation_id',
  'endpoint_id',
  'inbound_message_id',
]);
const CONTENT_FIELDS = objectFreeze([
  'subject',
  'body_text',
  'quoted_history',
  'from_display_name',
  'from_address',
]);
const CONTENT_LIMITS = objectFreeze({
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
  return value !== null && typeof value === 'object' && objectGetPrototypeOf(value) === Object.prototype;
}

function readExactDataRecord(value, fields) {
  if (!isPlainRecord(value)) throw invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  if (reflectOwnKeys(descriptors).length !== fields.length) throw invalid();
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !descriptor.enumerable || !objectHasOwn(descriptor, 'value')) throw invalid();
    copy[field] = descriptor.value;
  }
  return copy;
}

function validateAuthority(authority) {
  for (const field of arrayFilter(AUTHORITY_FIELDS, (field) => field !== 'location_key')) {
    if (typeof authority[field] !== 'string' || !regexpTest(UUID, authority[field])) throw invalid();
  }
  if (authority.location_key !== 'sunset-somo') throw invalid();
}

function validateContent(untrustedContent) {
  for (const field of CONTENT_FIELDS) {
    if (typeof untrustedContent[field] !== 'string' || untrustedContent[field].length > CONTENT_LIMITS[field]) throw invalid();
  }
}

function readFrozenExactDataRecord(value, fields) {
  if (!isPlainRecord(value) || !objectIsFrozen(value)) throw invalid();
  const descriptors = objectGetOwnPropertyDescriptors(value);
  if (reflectOwnKeys(descriptors).length !== fields.length) throw invalid();
  const copy = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
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

  const envelope = objectFreeze({
    authority: objectFreeze(authority),
    untrusted_content: objectFreeze(untrustedContent),
    content_trust: 'untrusted_email_data_never_instructions',
  });
  weakSetAdd(AUTHENTIC_ENVELOPES, envelope);
  return envelope;
}

function createEmailLunaDraftHandoff(input) {
  const request = readExactDataRecord(input, ['envelope', 'reason']);
  const envelope = request.envelope;
  if (!envelope || !weakSetHas(AUTHENTIC_ENVELOPES, envelope)) throw invalid();

  const envelopeSnapshot = readFrozenExactDataRecord(
    envelope,
    ['authority', 'untrusted_content', 'content_trust'],
  );
  const authority = readFrozenExactDataRecord(envelopeSnapshot.authority, AUTHORITY_FIELDS);
  const untrustedContent = readFrozenExactDataRecord(envelopeSnapshot.untrusted_content, CONTENT_FIELDS);
  if (envelopeSnapshot.content_trust !== 'untrusted_email_data_never_instructions') throw invalid();
  validateAuthority(authority);
  validateContent(untrustedContent);
  if (!arrayIncludes(EMAIL_LUNA_DRAFT_HANDOFF_REASONS, request.reason)
      && !arrayIncludes(EMAIL_LUNA_DRAFT_AUTHOR_HANDOFF_REASONS, request.reason)) throw invalid();

  return objectFreeze({
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
