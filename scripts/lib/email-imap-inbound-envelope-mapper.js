'use strict';

/**
 * IMAP FETCH → canonical inbound envelope mapper (EMAIL-IMAP-001).
 * Fail-closed on missing From, malformed dates, or oversized bodies.
 * Bounded RFC 2047 + mailbox-list subset for common Gmail messages.
 * Never logs envelope field values. Never weakens sender-address validation
 * or body byte/char bounds.
 *
 * @module email-imap-inbound-envelope-mapper
 */

const {
  validateInboundEmailEnvelope,
  EMAIL_INBOUND_BODY_TEXT_MAX,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');
const {
  parseRfcUid,
  parseRfcUidvalidity,
} = require('./email-sunset-imap-imaps-transport');

const MONTHS = Object.freeze({
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
});
const ENCODED_WORD_RE = /^=\?([A-Za-z0-9-]+)\?([BbQq])\?([^?]*)\?=$/;
const ENCODED_WORD_RUN_RE = /=\?[A-Za-z0-9-]+\?[BbQq]\?[^?]*\?=(?:\s+=\?[A-Za-z0-9-]+\?[BbQq]\?[^?]*\?=)*/g;
const ENCODED_WORD_ONE_RE = /=\?[A-Za-z0-9-]+\?[BbQq]\?[^?]*\?=/g;
const RFC2047_MAX_WORDS = 32;
const PROHIBITED_DECODED = /[\u0000-\u001F\u007F]/;
const ADDR_LOCAL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/;
const ADDR_DOMAIN_RE = /^[A-Za-z0-9.-]+\.[A-Za-z0-9-]{2,63}$/;

function parseInternalDate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(value.trim());
  if (!match) return null;
  const month = MONTHS[match[2]];
  if (!month) return null;
  const day = match[1].padStart(2, '0');
  const offset = match[7];
  const isoOffset = `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const raw = `${match[3]}-${month}-${day}T${match[4]}:${match[5]}:${match[6]}${isoOffset}`;
  const validated = validateInboundEmailEnvelope({
    provider: 'imap_smtp',
    provider_mailbox_id: 'probe@example.test',
    provider_message_id: 'probe',
    received_at: raw,
    subject: null,
    body_text: '',
    sender_display_name: null,
    sender_address: 'probe@example.test',
    is_read: false,
    conversation_id: null,
    internet_message_id: null,
  });
  if (!validated.ok) return null;
  return validated.value.received_at;
}

function canonicalizeReceivedAt(value) {
  return parseInternalDate(value);
}

function decodeCharset(bytes, charset) {
  const name = String(charset).toLowerCase();
  if (name === 'utf-8' || name === 'utf8') return Buffer.from(bytes).toString('utf8');
  if (name === 'us-ascii' || name === 'ascii') {
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] > 127) return null;
    }
    return Buffer.from(bytes).toString('ascii');
  }
  if (name === 'iso-8859-1' || name === 'latin1') return Buffer.from(bytes).toString('latin1');
  return null;
}

function decodeQBytes(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (ch === '_') {
      bytes.push(0x20);
      continue;
    }
    if (ch === '=') {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    const code = encoded.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return null;
    bytes.push(code);
  }
  return bytes;
}

function decodeOneEncodedWord(token) {
  const match = ENCODED_WORD_RE.exec(token);
  if (!match) return null;
  const charset = match[1];
  const encoding = match[2].toUpperCase();
  const body = match[3];
  if (token.length > 75 && body.length > 63) {
    // RFC 2047 encoded-word max 75; Gmail occasionally exceeds slightly. Cap hard.
    if (token.length > 256) return null;
  }
  let bytes;
  if (encoding === 'B') {
    if (!/^[A-Za-z0-9+/]*=*$/.test(body) || body.length % 4 !== 0) return null;
    const buf = Buffer.from(body, 'base64');
    if (buf.length === 0 && body.replace(/=/g, '').length > 0) return null;
    bytes = Array.from(buf);
  } else if (encoding === 'Q') {
    bytes = decodeQBytes(body);
  } else {
    return null;
  }
  if (!bytes) return null;
  const decoded = decodeCharset(bytes, charset);
  if (typeof decoded !== 'string') return null;
  if (PROHIBITED_DECODED.test(decoded)) return null;
  return decoded;
}

function decodeRfc2047Bounded(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  if (value.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
  if (!/=\?/.test(value)) return value;
  const words = value.match(ENCODED_WORD_ONE_RE) || [];
  if (words.length > RFC2047_MAX_WORDS) return null;
  let out = '';
  let last = 0;
  let match;
  ENCODED_WORD_RUN_RE.lastIndex = 0;
  while ((match = ENCODED_WORD_RUN_RE.exec(value)) !== null) {
    out += value.slice(last, match.index);
    const parts = match[0].match(ENCODED_WORD_ONE_RE) || [];
    for (let i = 0; i < parts.length; i += 1) {
      const decoded = decodeOneEncodedWord(parts[i]);
      if (decoded == null) return null;
      out += decoded;
    }
    last = match.index + match[0].length;
  }
  out += value.slice(last);
  if (out.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
  if (PROHIBITED_DECODED.test(out)) return null;
  return out;
}

function isAddrSpec(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 3 || v.length > 320) return false;
  if (/[\s\u0000-\u001F\u007F<>()[\]\\,;:"]/.test(v)) return false;
  const at = v.lastIndexOf('@');
  if (at < 1 || at !== v.indexOf('@') || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (!ADDR_LOCAL_RE.test(local) || !ADDR_DOMAIN_RE.test(domain)) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  if (domain.startsWith('-') || domain.endsWith('-')) return false;
  return true;
}

function readQuotedString(s, start) {
  if (s[start] !== '"') return null;
  let i = start + 1;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= s.length) return null;
      const next = s[i + 1];
      if (PROHIBITED_DECODED.test(next)) return null;
      out += next;
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, next: i + 1 };
    if (PROHIBITED_DECODED.test(ch)) return null;
    out += ch;
    i += 1;
  }
  return null;
}

function skipWsp(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return i;
}

function parseFirstMailbox(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
  if (s.includes('(') || s.includes(')')) return null;
  let i = skipWsp(s, 0);
  let display = '';
  if (s[i] === '"') {
    const quoted = readQuotedString(s, i);
    if (!quoted) return null;
    display = quoted.value;
    i = skipWsp(s, quoted.next);
    if (s[i] !== '<') return null;
  }
  if (s[i] === '<') {
    const end = s.indexOf('>', i + 1);
    if (end < 0) return null;
    const addr = s.slice(i + 1, end).trim();
    if (!isAddrSpec(addr)) return null;
    i = skipWsp(s, end + 1);
    if (i < s.length && s[i] !== ',') return null;
    const nameDecoded = display ? decodeRfc2047Bounded(display) : null;
    if (display && nameDecoded == null) return null;
    const name = nameDecoded && nameDecoded.trim() ? nameDecoded.trim() : null;
    if (name && (name.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX || PROHIBITED_DECODED.test(name))) return null;
    return { name, address: addr.toLowerCase() };
  }
  const angle = s.indexOf('<', i);
  const comma = s.indexOf(',', i);
  if (angle >= 0 && (comma < 0 || angle < comma)) {
    display = s.slice(i, angle).trim();
    i = angle;
    if (s[i] !== '<') return null;
    const end = s.indexOf('>', i + 1);
    if (end < 0) return null;
    const addr = s.slice(i + 1, end).trim();
    if (!isAddrSpec(addr)) return null;
    i = skipWsp(s, end + 1);
    if (i < s.length && s[i] !== ',') return null;
    const nameDecoded = display ? decodeRfc2047Bounded(display) : null;
    if (display && nameDecoded == null) return null;
    const name = nameDecoded && nameDecoded.trim() ? nameDecoded.trim() : null;
    if (name && (name.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX || PROHIBITED_DECODED.test(name))) return null;
    return { name, address: addr.toLowerCase() };
  }
  const tokenEnd = comma >= 0 ? comma : s.length;
  const bare = s.slice(i, tokenEnd).trim();
  if (!isAddrSpec(bare)) return null;
  return { name: null, address: bare.toLowerCase() };
}

function parseFrom(raw) {
  return parseFirstMailbox(raw);
}

function optionalBounded(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
  if (PROHIBITED_DECODED.test(trimmed)) return null;
  return trimmed;
}

function mapImapFetchedMessageToInboundEnvelope(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Object.freeze({ ok: false });
    const mailbox = input.mailbox;
    const message = input.message;
    if (typeof mailbox !== 'string' || !mailbox || mailbox.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) {
      return Object.freeze({ ok: false });
    }
    if (!message || typeof message !== 'object') return Object.freeze({ ok: false });
    const uid = parseRfcUid(message.uid);
    const uidvalidity = parseRfcUidvalidity(message.uidvalidity);
    if (uid == null || uidvalidity == null) return Object.freeze({ ok: false });
    if (typeof message.bodyText !== 'string' || message.bodyText.length > EMAIL_INBOUND_BODY_TEXT_MAX) {
      return Object.freeze({ ok: false });
    }
    if (PROHIBITED_DECODED.test(message.bodyText.replace(/\r\n|\n|\r/g, ''))) {
      // Permit ordinary body newlines; reject other C0/DEL.
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(message.bodyText)) {
        return Object.freeze({ ok: false });
      }
    }
    const headers = message.headers && typeof message.headers === 'object' ? message.headers : {};
    const from = parseFrom(headers.from);
    if (!from || !from.address || !isAddrSpec(from.address)) return Object.freeze({ ok: false });
    const receivedAt = canonicalizeReceivedAt(message.internalDate);
    if (!receivedAt) return Object.freeze({ ok: false });
    const flags = Array.isArray(message.flags) ? message.flags : [];
    let subject = null;
    if (headers.subject != null && headers.subject !== '') {
      const decodedSubject = decodeRfc2047Bounded(String(headers.subject));
      if (decodedSubject == null) return Object.freeze({ ok: false });
      subject = optionalBounded(decodedSubject);
    }
    const envelope = {
      provider: 'imap_smtp',
      provider_mailbox_id: mailbox,
      provider_message_id: `uidvalidity:${uidvalidity}:uid:${uid}`,
      received_at: receivedAt,
      subject,
      body_text: message.bodyText,
      sender_display_name: optionalBounded(from.name),
      sender_address: from.address,
      is_read: flags.some((flag) => String(flag).replace(/^\\/, '').toLowerCase() === 'seen'),
      conversation_id: null,
      internet_message_id: optionalBounded(headers['message-id']),
    };
    const validated = validateInboundEmailEnvelope(envelope);
    if (!validated.ok) return Object.freeze({ ok: false });
    return Object.freeze({ ok: true, value: validated.value });
  } catch (_) {
    return Object.freeze({ ok: false });
  }
}

module.exports = Object.freeze({
  mapImapFetchedMessageToInboundEnvelope,
  parseFirstMailbox,
  decodeRfc2047Bounded,
  isAddrSpec,
});
