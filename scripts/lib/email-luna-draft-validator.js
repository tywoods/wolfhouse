'use strict';

const utilTypes = require('node:util').types;
const { createEmailLunaDraftHandoff } = require('./email-luna-draft-handoff-contract');
const { assertEmailLunaDraftPolicyIssuance } = require('./email-luna-draft-policy');
const { recomputeEmailLunaDraftCanonicalFromAuthentic } = require('./email-luna-draft-author');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const isProxy = utilTypes.isProxy.bind(undefined);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const NativeRegExp = RegExp;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const arrayPush = uncurryThis(Array.prototype.push);
const arrayJoin = uncurryThis(Array.prototype.join);
const stringSplit = uncurryThis(String.prototype.split);
const stringIncludes = uncurryThis(String.prototype.includes);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const regexpTest = uncurryThis(RegExp.prototype.test);
const regexpExec = uncurryThis(RegExp.prototype.exec);
const regexpSymbolReplace = uncurryThis(RegExp.prototype[Symbol.replace]);
const regexpSourceGet = uncurryThis(objectGetOwnPropertyDescriptor(RegExp.prototype, 'source').get);
const regexpFlagsGet = uncurryThis(objectGetOwnPropertyDescriptor(RegExp.prototype, 'flags').get);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const AUTHENTIC_VALIDATIONS = new WeakSet();

const EMAIL_LUNA_DRAFT_VALIDATOR_VERSION = 'email-luna-draft-validator.v1';
const EMAIL_LUNA_DRAFT_VALIDATOR_HANDOFF_REASONS = objectFreeze([
  'unissued_evidence',
  'stale_evidence',
  'forged_draft',
  'authority_mismatch',
  'attachment_interpretation_required',
  'altered_subject',
  'altered_body',
  'altered_language',
  'mismatched_url',
  'mismatched_amount',
  'mismatched_date',
  'mismatched_time',
  'mismatched_booking_code',
  'mismatched_booking_status',
  'mismatched_payment_status',
  'mismatched_balance',
  'mismatched_availability',
  'mismatched_capacity',
  'mismatched_policy',
  'unsupported_claim',
  'internal_jargon',
]);
const INPUT_KEYS = objectFreeze(['envelope', 'decision', 'evidence', 'draft']);
const DRAFT_KEYS = objectFreeze([
  'status', 'subject', 'body', 'language', 'client_id', 'location_id', 'conversation_id',
  'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
]);
const JARGON = /grounded[_ ]facts?|classifier|draft_ready|handoff_required|tenant_id|location_id|send_allowed|auto_send|orchestrator|composer|staging|dry run|policy_key|required_facts|intent_support/i;
const URL_RE = /https?:\/\/[^\s]+|(?:www\.)?[a-z0-9.-]+\.(?:test|com|org|net|io)(?:\/[^\s]*)?/gi;
const MONEY_RE = /€\d+[.,]\d{2}/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME_RE = /\b(?:[01]\d|2[0-3]):[0-5]\d\b/g;
const BOOKING_CODE_RE = /\b[A-Z]{2,}-[A-Z0-9]{2,}\b/g;
const BOOKING_STATUS_RE = /\b(?:confirmed|pending|cancelled|confirmada|pendiente|cancelada)\b/gi;
const PAYMENT_STATUS_RE = /No payment is recorded yet\.|We have recorded a partial payment\.|The payment is recorded as paid\.|Todavía no consta ningún pago\.|Hemos registrado un pago parcial\.|El pago consta como abonado\./g;
const BALANCE_RE = /(?:Balance due|Saldo pendiente):\s*(€\d+[.,]\d{2})/g;
const AVAIL_UNAVAILABLE_RE = /\bis not available\b|\bno hay disponibilidad\b/i;
const AVAIL_AVAILABLE_RE = /\bis available\b|\bhay disponibilidad\b/i;
const CAPACITY_RE = /\b(\d+)\s+(?:spots|plazas)\b/gi;
const POLICY_WINDOW_RE = /\b(\d+)\s+(?:hours?’?|horas)\b/gi;
const UNSUPPORTED_RE = /\bYour reservation is all set\.|\bWe can fit you in tomorrow\.|\bI'll send this now\./g;
const MASK_URL_RE = /\s*(?:https?:\/\/[^\s]+|(?:www\.)?[a-z0-9.-]+\.(?:test|com|org|net|io)(?:\/[^\s]*)?)/gi;
const MASK_AVAIL_NOT_EN_RE = /\bis not available\b/gi;
const MASK_AVAIL_EN_RE = /\bis available\b/gi;
const MASK_AVAIL_NOT_ES_RE = /\bno hay disponibilidad\b/gi;
const MASK_AVAIL_ES_RE = /\bhay disponibilidad\b/gi;
const MASK_CAPACITY_RE = /\b\d+\s+(?:spots|plazas)\b/gi;
const MASK_POLICY_RE = /\b\d+\s+(?:hours|horas)/gi;
const MASK_BLANK_RE = /\n{3,}/g;
const MASK_TRAIL_RE = /[ \t\n]+$/g;

function invalid() {
  const error = new Error('Email Luna draft validator failed.');
  error.code = 'EMAIL_LUNA_DRAFT_VALIDATOR_INVALID';
  return error;
}

function cloneGlobalRegExp(regexp, flagsOverride) {
  const source = regexpSourceGet(regexp);
  const flagsBase = flagsOverride == null ? regexpFlagsGet(regexp) : flagsOverride;
  if (typeof source !== 'string' || typeof flagsBase !== 'string') throw invalid();
  const flags = stringIncludes(flagsBase, 'g') ? flagsBase : `${flagsBase}g`;
  try {
    return new NativeRegExp(source, flags);
  } catch (_) {
    throw invalid();
  }
}

function replaceRegExp(text, regexp, replacement, flagsOverride) {
  if (typeof text !== 'string') throw invalid();
  return regexpSymbolReplace(cloneGlobalRegExp(regexp, flagsOverride), text, replacement);
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function exactInput(value) {
  if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== Object.prototype) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== INPUT_KEYS.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < INPUT_KEYS.length; index += 1) {
      const key = INPUT_KEYS[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_VALIDATOR_INVALID') throw error;
    throw invalid();
  }
}

function exactDraft(value) {
  if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== null || !objectIsFrozen(value)) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== DRAFT_KEYS.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < DRAFT_KEYS.length; index += 1) {
      const key = DRAFT_KEYS[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) throw invalid();
      snapshot[key] = descriptor.value;
    }
    if (snapshot.status !== 'draft_ready' || snapshot.draft_only !== true
        || snapshot.requires_staff_review !== true || snapshot.send_allowed !== false
        || snapshot.auto_send_allowed !== false) throw invalid();
    if (typeof snapshot.subject !== 'string' || typeof snapshot.body !== 'string'
        || (snapshot.language !== 'en' && snapshot.language !== 'es')
        || typeof snapshot.client_id !== 'string' || typeof snapshot.location_id !== 'string'
        || typeof snapshot.conversation_id !== 'string') throw invalid();
    return snapshot;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_VALIDATOR_INVALID') throw error;
    throw invalid();
  }
}

function output(entries) {
  const value = objectCreate(null);
  for (let index = 0; index < entries.length; index += 1) {
    objectDefineProperty(value, entries[index][0], {
      value: entries[index][1], enumerable: true, writable: true, configurable: true,
    });
  }
  const frozen = objectFreeze(value);
  weakSetAdd(AUTHENTIC_VALIDATIONS, frozen);
  return frozen;
}

function bindingOf(envelope) {
  let handoffDto;
  try {
    handoffDto = createEmailLunaDraftHandoff({ envelope, reason: 'authority_mismatch' });
  } catch (_) {
    throw invalid();
  }
  return objectFreeze({
    client_id: handoffDto.client_id,
    location_id: handoffDto.location_id,
    conversation_id: handoffDto.conversation_id,
  });
}

function handoff(envelope, reason) {
  if (!arrayIncludes(EMAIL_LUNA_DRAFT_VALIDATOR_HANDOFF_REASONS, reason)) throw invalid();
  const binding = bindingOf(envelope);
  return output([
    ['status', 'handoff_required'], ['reason', reason],
    ['client_id', binding.client_id], ['location_id', binding.location_id],
    ['conversation_id', binding.conversation_id], ['draft_only', true],
    ['requires_staff_review', true], ['send_allowed', false], ['auto_send_allowed', false],
  ]);
}

function collect(text, regexp) {
  if (typeof text !== 'string') return objectFreeze([]);
  const found = [];
  const re = cloneGlobalRegExp(regexp);
  let match = regexpExec(re, text);
  while (match) {
    const value = match[1] || match[0];
    if (typeof value === 'string' && !arrayIncludes(found, value)) arrayPush(found, value);
    match = regexpExec(re, text);
  }
  return objectFreeze(found);
}

function sameList(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareUrlClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, URL_RE), collect(canonicalBody, URL_RE))) return 'mismatched_url';
  return null;
}
function compareAmountClaims(draftBody, canonicalBody) {
  const draftMoney = collect(draftBody, MONEY_RE);
  const canonicalMoney = collect(canonicalBody, MONEY_RE);
  const draftPaid = collect(draftBody, /(?:Amount paid|Importe abonado):\s*(€\d+[.,]\d{2})/g);
  const canonicalPaid = collect(canonicalBody, /(?:Amount paid|Importe abonado):\s*(€\d+[.,]\d{2})/g);
  const left = draftPaid.length ? draftPaid : draftMoney;
  const right = canonicalPaid.length ? canonicalPaid : canonicalMoney;
  if (canonicalPaid.length || draftPaid.length) {
    if (!sameList(draftPaid, canonicalPaid)) return 'mismatched_amount';
    return null;
  }
  if (!sameList(left, right)) return 'mismatched_amount';
  return null;
}
function compareDateClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, DATE_RE), collect(canonicalBody, DATE_RE))) return 'mismatched_date';
  return null;
}
function compareTimeClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, TIME_RE), collect(canonicalBody, TIME_RE))) return 'mismatched_time';
  return null;
}
function compareBookingCodeClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, BOOKING_CODE_RE), collect(canonicalBody, BOOKING_CODE_RE))) {
    return 'mismatched_booking_code';
  }
  return null;
}
function compareBookingStatusClaims(draftBody, canonicalBody) {
  const normalize = (list) => {
    const out = [];
    for (let index = 0; index < list.length; index += 1) {
      const raw = stringToLowerCase(list[index]);
      const value = raw === 'confirmada' ? 'confirmed'
        : raw === 'pendiente' ? 'pending'
          : raw === 'cancelada' ? 'cancelled'
            : raw;
      if (!arrayIncludes(out, value)) arrayPush(out, value);
    }
    return objectFreeze(out);
  };
  if (!sameList(normalize(collect(draftBody, BOOKING_STATUS_RE)), normalize(collect(canonicalBody, BOOKING_STATUS_RE)))) {
    return 'mismatched_booking_status';
  }
  return null;
}
function comparePaymentStatusClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, PAYMENT_STATUS_RE), collect(canonicalBody, PAYMENT_STATUS_RE))) {
    return 'mismatched_payment_status';
  }
  return null;
}
function compareBalanceClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, BALANCE_RE), collect(canonicalBody, BALANCE_RE))) return 'mismatched_balance';
  return null;
}
function availabilityTokens(text) {
  if (regexpTest(AVAIL_UNAVAILABLE_RE, text)) return objectFreeze(['unavailable']);
  if (regexpTest(AVAIL_AVAILABLE_RE, text)) return objectFreeze(['available']);
  return objectFreeze([]);
}
function compareAvailabilityClaims(draftBody, canonicalBody) {
  if (!sameList(availabilityTokens(draftBody), availabilityTokens(canonicalBody))) return 'mismatched_availability';
  return null;
}
function compareCapacityClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, CAPACITY_RE), collect(canonicalBody, CAPACITY_RE))) return 'mismatched_capacity';
  return null;
}
function comparePolicyClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, POLICY_WINDOW_RE), collect(canonicalBody, POLICY_WINDOW_RE))) {
    return 'mismatched_policy';
  }
  return null;
}
function compareUnsupportedClaims(draftBody, canonicalBody) {
  if (!sameList(collect(draftBody, UNSUPPORTED_RE), collect(canonicalBody, UNSUPPORTED_RE))) {
    return 'unsupported_claim';
  }
  return null;
}

function maskClaims(text) {
  const paragraphs = stringSplit(text, '\n\n');
  const kept = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    if (regexpTest(JARGON, paragraphs[index])) continue;
    arrayPush(kept, paragraphs[index]);
  }
  let masked = arrayJoin(kept, '\n\n');
  masked = replaceRegExp(masked, MASK_URL_RE, '');
  masked = replaceRegExp(masked, MONEY_RE, '\0MONEY\0');
  masked = replaceRegExp(masked, DATE_RE, '\0DATE\0');
  masked = replaceRegExp(masked, TIME_RE, '\0TIME\0');
  masked = replaceRegExp(masked, BOOKING_CODE_RE, '\0CODE\0');
  masked = replaceRegExp(masked, MASK_AVAIL_NOT_EN_RE, '\0AVAIL\0');
  masked = replaceRegExp(masked, MASK_AVAIL_EN_RE, '\0AVAIL\0');
  masked = replaceRegExp(masked, MASK_AVAIL_NOT_ES_RE, '\0AVAIL\0');
  masked = replaceRegExp(masked, MASK_AVAIL_ES_RE, '\0AVAIL\0');
  masked = replaceRegExp(masked, MASK_CAPACITY_RE, '\0CAP\0');
  masked = replaceRegExp(masked, BOOKING_STATUS_RE, '\0BSTAT\0');
  masked = replaceRegExp(masked, PAYMENT_STATUS_RE, '\0PSTAT\0');
  masked = replaceRegExp(masked, MASK_POLICY_RE, '\0POL\0');
  masked = replaceRegExp(masked, UNSUPPORTED_RE, '');
  masked = replaceRegExp(masked, MASK_BLANK_RE, '\n\n');
  masked = replaceRegExp(masked, MASK_TRAIL_RE, '');
  return masked;
}

function assertEmailLunaDraftValidation(value) {
  if (value === null || typeof value !== 'object' || isProxy(value) || arrayIsArray(value)) throw invalid();
  if (!weakSetHas(AUTHENTIC_VALIDATIONS, value) || !objectIsFrozen(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  return value;
}

function validateEmailLunaDraft(input) {
  const request = exactInput(input);
  const envelope = request.envelope;
  bindingOf(envelope);
  let trusted;
  try {
    trusted = assertEmailLunaDraftPolicyIssuance({
      envelope: request.envelope,
      decision: request.decision,
      evidence: request.evidence,
    });
  } catch (_) {
    return handoff(envelope, 'unissued_evidence');
  }
  if (trusted.status === 'handoff_required') {
    return handoff(envelope, trusted.reason === 'stale_evidence' ? 'stale_evidence' : 'unissued_evidence');
  }
  if (trusted.attachment_interpretation_required === true) {
    return handoff(envelope, 'attachment_interpretation_required');
  }
  const draft = exactDraft(request.draft);
  if (draft.client_id !== trusted.binding.client_id || draft.location_id !== trusted.binding.location_id || draft.conversation_id !== trusted.binding.conversation_id) {
    return handoff(envelope, 'authority_mismatch');
  }
  if (draft.language !== trusted.language) return handoff(envelope, 'altered_language');
  if (regexpTest(JARGON, `${draft.subject}\n${draft.body}`)) return handoff(envelope, 'internal_jargon');
  let matched;
  try {
    matched = recomputeEmailLunaDraftCanonicalFromAuthentic({
      envelope: request.envelope,
      decision: request.decision,
      evidence: request.evidence,
      draft: request.draft,
    });
  } catch (_) {
    return handoff(envelope, 'forged_draft');
  }
  if (!matched || typeof matched !== 'object' || isProxy(matched) || arrayIsArray(matched)) {
    return handoff(envelope, 'unsupported_claim');
  }
  if (matched.subject !== draft.subject) return handoff(envelope, 'altered_subject');
  if (maskClaims(draft.body) !== maskClaims(matched.body)) return handoff(envelope, 'altered_body');
  const urlFailure = compareUrlClaims(draft.body, matched.body);
  if (urlFailure) return handoff(envelope, urlFailure);
  const amountFailure = compareAmountClaims(draft.body, matched.body);
  if (amountFailure) return handoff(envelope, amountFailure);
  const dateFailure = compareDateClaims(draft.body, matched.body);
  if (dateFailure) return handoff(envelope, dateFailure);
  const timeFailure = compareTimeClaims(draft.body, matched.body);
  if (timeFailure) return handoff(envelope, timeFailure);
  const bookingCodeFailure = compareBookingCodeClaims(draft.body, matched.body);
  if (bookingCodeFailure) return handoff(envelope, bookingCodeFailure);
  const bookingStatusFailure = compareBookingStatusClaims(draft.body, matched.body);
  if (bookingStatusFailure) return handoff(envelope, bookingStatusFailure);
  const paymentStatusFailure = comparePaymentStatusClaims(draft.body, matched.body);
  if (paymentStatusFailure) return handoff(envelope, paymentStatusFailure);
  const balanceFailure = compareBalanceClaims(draft.body, matched.body);
  if (balanceFailure) return handoff(envelope, balanceFailure);
  const availabilityFailure = compareAvailabilityClaims(draft.body, matched.body);
  if (availabilityFailure) return handoff(envelope, availabilityFailure);
  const capacityFailure = compareCapacityClaims(draft.body, matched.body);
  if (capacityFailure) return handoff(envelope, capacityFailure);
  const policyFailure = comparePolicyClaims(draft.body, matched.body);
  if (policyFailure) return handoff(envelope, policyFailure);
  const unsupportedFailure = compareUnsupportedClaims(draft.body, matched.body);
  if (unsupportedFailure) return handoff(envelope, unsupportedFailure);
  return output([
    ['status', 'valid'], ['language', trusted.language],
    ['client_id', trusted.binding.client_id], ['location_id', trusted.binding.location_id],
    ['conversation_id', trusted.binding.conversation_id], ['draft_only', true],
    ['requires_staff_review', true], ['send_allowed', false], ['auto_send_allowed', false],
  ]);
}

module.exports = {
  EMAIL_LUNA_DRAFT_VALIDATOR_HANDOFF_REASONS,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
  assertEmailLunaDraftValidation,
  validateEmailLunaDraft,
};
