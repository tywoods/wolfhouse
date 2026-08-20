'use strict';

/**
 * IMAP FETCH → canonical inbound envelope mapper (EMAIL-IMAP-001).
 * Fail-closed on missing From, malformed dates, or oversized bodies.
 * Never logs envelope field values.
 *
 * @module email-imap-inbound-envelope-mapper
 */

const {
  validateInboundEmailEnvelope,
  EMAIL_INBOUND_BODY_TEXT_MAX,
  EMAIL_INBOUND_ENVELOPE_STRING_MAX,
} = require('./email-inbound-envelope-contract');

const MONTHS = Object.freeze({
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
});

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
  if (!validated.ok) {
    // Use envelope contract timestamp canonicalizer via a tiny probe; if it
    // rejects, treat INTERNALDATE as unusable.
    return null;
  }
  return validated.value.received_at;
}

function canonicalizeReceivedAt(value) {
  const parsed = parseInternalDate(value);
  if (parsed) return parsed;
  return null;
}

function parseFrom(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
  const angle = /^(?:"?([^"<]*?)"?\s*)?<([^>\s]+@[^>\s]+)>\s*$/.exec(trimmed);
  if (angle) {
    const name = angle[1] ? angle[1].trim() : '';
    return {
      name: name && name.length <= EMAIL_INBOUND_ENVELOPE_STRING_MAX ? name : null,
      address: angle[2].trim().toLowerCase(),
    };
  }
  if (!trimmed.includes('@') || /\s/.test(trimmed)) return null;
  return { name: null, address: trimmed.toLowerCase() };
}

function optionalBounded(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > EMAIL_INBOUND_ENVELOPE_STRING_MAX) return null;
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
    const uid = Number(message.uid);
    const uidvalidity = Number(message.uidvalidity);
    if (!Number.isInteger(uid) || uid < 1 || !Number.isInteger(uidvalidity) || uidvalidity < 1) {
      return Object.freeze({ ok: false });
    }
    if (typeof message.bodyText !== 'string' || message.bodyText.length > EMAIL_INBOUND_BODY_TEXT_MAX) {
      return Object.freeze({ ok: false });
    }
    const headers = message.headers && typeof message.headers === 'object' ? message.headers : {};
    const from = parseFrom(headers.from);
    if (!from || !from.address) return Object.freeze({ ok: false });
    const receivedAt = canonicalizeReceivedAt(message.internalDate);
    if (!receivedAt) return Object.freeze({ ok: false });
    const flags = Array.isArray(message.flags) ? message.flags : [];
    const envelope = {
      provider: 'imap_smtp',
      provider_mailbox_id: mailbox,
      provider_message_id: `uidvalidity:${uidvalidity}:uid:${uid}`,
      received_at: receivedAt,
      subject: optionalBounded(headers.subject),
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

module.exports = Object.freeze({ mapImapFetchedMessageToInboundEnvelope });
