'use strict';

/**
 * MAIL-MVP-001 — bounded operator Create Draft context.
 *
 * Plain staff guidance only. Never authority for prices, availability,
 * payment URLs, bookings, tenant/location/endpoint, or send/approve.
 */

const crypto = require('node:crypto');
const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;
const ownKeys = Reflect.ownKeys;

const OPERATOR_DRAFT_CONTEXT_MAX_CHARS = 500;
const OPERATOR_DRAFT_CONTEXT_MAX_UTF8_BYTES = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const INJECTION = /(?:\bsystem\s*:|\[\s*system\s*\]|\bdeveloper\s+(?:message|instruction)|ignore\s+(?:all\s+)?previous\s+instructions?|override\s+policy|switch\s+tenant|call\s+[a-z_$][\w$]*\s*\(|<\s*\/?\s*system\b|\b(?:location_id|required_facts|send_allowed|draft_ready|low_confidence)\s*=|"(?:authority|policy|low_confidence)"\s*:)/i;

function ownData(value, key) {
  try {
    const descriptor = getDescriptor(value, key);
    return descriptor && hasOwn(descriptor, 'value') && descriptor.enumerable && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function exactCreateDraftKeys(value) {
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = ownKeys(value);
    if (!keys.length || keys.some((key) => typeof key !== 'string')) return null;
    if (!keys.includes('conversation_id')) return null;
    for (const key of keys) {
      if (key !== 'conversation_id' && key !== 'context') return null;
    }
    return keys;
  } catch {
    return null;
  }
}

function snapshotOperatorDraftContext(raw) {
  if (raw === undefined || raw === null) {
    return freeze({ ok: true, context: '', dropped: false });
  }
  if (typeof raw !== 'string') {
    return freeze({ ok: false, error: 'invalid_context' });
  }
  if (raw.length > OPERATOR_DRAFT_CONTEXT_MAX_CHARS
      || Buffer.byteLength(raw, 'utf8') > OPERATOR_DRAFT_CONTEXT_MAX_UTF8_BYTES) {
    return freeze({ ok: false, error: 'context_too_long' });
  }
  let text;
  try {
    text = raw.normalize('NFC');
  } catch {
    return freeze({ ok: false, error: 'invalid_context' });
  }
  text = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').trim();
  if (text.length > OPERATOR_DRAFT_CONTEXT_MAX_CHARS
      || Buffer.byteLength(text, 'utf8') > OPERATOR_DRAFT_CONTEXT_MAX_UTF8_BYTES) {
    return freeze({ ok: false, error: 'context_too_long' });
  }
  if (INJECTION.test(text)) {
    return freeze({ ok: true, context: '', dropped: true });
  }
  return freeze({ ok: true, context: text, dropped: false });
}

function snapshotEmailLunaCreateDraftBody(raw) {
  const keys = exactCreateDraftKeys(raw);
  if (!keys) return null;
  const conversationId = uuid(ownData(raw, 'conversation_id'));
  if (!conversationId) return null;
  if (!keys.includes('context')) {
    return freeze({ conversation_id: conversationId, context: '' });
  }
  const snapped = snapshotOperatorDraftContext(ownData(raw, 'context'));
  if (!snapped.ok) return null;
  return freeze({ conversation_id: conversationId, context: snapped.context, context_dropped: snapped.dropped });
}

function operatorDraftContextDigest(context) {
  if (typeof context !== 'string' || !context) return null;
  return crypto.createHash('sha256').update(context, 'utf8').digest('hex');
}

const PRICE_OR_MONEY = /€|\$|£|\b(?:eur|usd|gbp)\b|\b\d+[.,]\d{2}\b|\bprices?\b|\bcosts?\b/i;
const URLISH = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/i;
const PAYMENT_CLAIM = /\bpay\s+now\b|\bpayment\s+(?:link|url)\b|\bstripe\b|\bdeposit\b/i;
const HOLD_CLAIM = /\bholds?\b|\bholding\b/i;
const AVAIL_CLAIM = /\bavailab(?:le|ility)\b/i;
const BOOKING_AUTHORITY_CLAIM = /\bbooking\s+(?:is|code|confirmed|created|id)\b|\bcreate(?:d)?\s+the\s+booking\b|\bwe(?:['’]ve| have)\s+booked\b|\bi\s+booked\b/i;

function sentenceHasAuthorityClaim(text) {
  return PRICE_OR_MONEY.test(text)
    || URLISH.test(text)
    || PAYMENT_CLAIM.test(text)
    || HOLD_CLAIM.test(text)
    || AVAIL_CLAIM.test(text)
    || BOOKING_AUTHORITY_CLAIM.test(text)
    || INJECTION.test(text);
}

function extractPermittedOperatorGuidance(context) {
  if (typeof context !== 'string') return '';
  let text;
  try {
    text = context.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  } catch {
    return '';
  }
  if (!text) return '';
  const kept = [];
  for (const block of text.split('\n')) {
    const line = block.trim();
    if (!line) continue;
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const sentence = raw.trim().replace(/[.]+$/, '').trim();
      if (!sentence) continue;
      if (sentenceHasAuthorityClaim(sentence) || sentenceHasAuthorityClaim(raw)) continue;
      kept.push(sentence);
    }
  }
  return kept.join('\n');
}

function guestFacingGuidanceLines(permitted, language) {
  const es = language === 'es';
  const lines = [];
  if (typeof permitted !== 'string' || !permitted.trim()) return '';
  for (const raw of permitted.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let match;
    if ((match = /^(?:please\s+)?(?:mention|include|note)\s+(?:the\s+)?(.+)$/i.exec(line))) {
      const topic = match[1].trim();
      lines.push(es ? `Queríamos mencionar ${topic}.` : `We wanted to mention ${topic}.`);
      continue;
    }
    if ((match = /^(?:please\s+)?ask (?:them|the guest) to (.+)$/i.exec(line))) {
      const rest = match[1].trim();
      lines.push(es ? `Por favor, ${rest}.` : `Please ${rest}.`);
      continue;
    }
    if ((match = /^(?:please\s+)?ask about (?:the\s+)?(.+)$/i.exec(line))) {
      const topic = match[1].trim();
      lines.push(es ? `¿Podrías contarnos sobre ${topic}?` : `Could you tell us about ${topic}?`);
      continue;
    }
    if (/^(?:please\s+)?reply in (?:spanish|english|es|en)$/i.test(line)) continue;
    lines.push(es ? `También queríamos añadir: ${line}.` : `We also wanted to add: ${line}.`);
  }
  return lines.join('\n');
}

function applyPermittedOperatorGuidanceToDraft(baseBody, operatorContext, language) {
  const lang = language === 'es' ? 'es' : 'en';
  const source = typeof baseBody === 'string' ? baseBody : '';
  const permitted = extractPermittedOperatorGuidance(operatorContext);
  if (!permitted) return source;
  const guest = guestFacingGuidanceLines(permitted, lang);
  if (!guest) return source;
  if (source === guest || source === permitted || source === operatorContext) return source;
  const trimmed = source.trim();
  if (!trimmed) return source;
  const signoff = lang === 'es' ? 'Un saludo cálido,' : 'Warm regards,';
  if (trimmed.includes(signoff)) {
    return trimmed.replace(signoff, `${guest}\n\n${signoff}`);
  }
  if (/\nLuna\s*$/.test(trimmed)) {
    return trimmed.replace(/\nLuna\s*$/, `\n\n${guest}\n\nLuna`);
  }
  return `${trimmed}\n\n${guest}`;
}

module.exports = freeze({
  OPERATOR_DRAFT_CONTEXT_MAX_CHARS,
  OPERATOR_DRAFT_CONTEXT_MAX_UTF8_BYTES,
  snapshotOperatorDraftContext,
  snapshotEmailLunaCreateDraftBody,
  operatorDraftContextDigest,
  extractPermittedOperatorGuidance,
  applyPermittedOperatorGuidanceToDraft,
});
