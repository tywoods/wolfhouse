'use strict';

/**
 * EMAIL-REPLY-001 — outbound reply subject owner.
 *
 * Validates optional approve-send subject overrides, derives the deterministic
 * `Re: <last>` default without double-prefixing, and looks up the last persisted
 * inbound/outbound subject. Never invents placeholder subjects.
 */

const util = require('util');

const SUBJECT_MAX_CHARS = 200;
const SUBJECT_KEY = 'subject';
const NO_SUBJECT_PLACEHOLDER = '(no subject)';
const FAILURE = 'subject_invalid';

const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function'
  ? PINNED_TYPES.isProxy
  : null;

function isProxy(v) {
  try {
    if (!PINNED_IS_PROXY || !PINNED_TYPES) return true;
    return Reflect.apply(PINNED_IS_PROXY, PINNED_TYPES, [v]) === true;
  } catch {
    return true;
  }
}

function fail() {
  return Object.freeze({ ok: false, code: FAILURE });
}

function ok(value) {
  return Object.freeze({ ok: true, value });
}

function ownData(o, k) {
  try {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function validateOutboundReplySubject(raw) {
  try {
    if (typeof raw !== 'string') return fail();
    if (isProxy(raw)) return fail();
    if (raw.length < 1 || raw.length > SUBJECT_MAX_CHARS) return fail();
    if (raw !== raw.trim()) return fail();
    if (/[\x00-\x1f\x7f]/.test(raw)) return fail();
    if (raw.includes('\n') || raw.includes('\r')) return fail();
    return ok(raw);
  } catch {
    return fail();
  }
}

function stripLeadingRePrefixes(raw) {
  let t = raw;
  while (/^re\s*:/i.test(t)) {
    t = t.replace(/^re\s*:\s*/i, '').trim();
  }
  return t;
}

function deriveReplySubject(lastSubject) {
  try {
    if (typeof lastSubject !== 'string') return null;
    const trimmed = lastSubject.trim();
    if (!trimmed) return null;
    if (trimmed.toLowerCase() === NO_SUBJECT_PLACEHOLDER) return null;
    const rest = stripLeadingRePrefixes(trimmed);
    if (!rest || rest.toLowerCase() === NO_SUBJECT_PLACEHOLDER) return null;
    const derived = `Re: ${rest}`;
    const checked = validateOutboundReplySubject(derived);
    return checked.ok === true ? checked.value : null;
  } catch {
    return null;
  }
}

function resolveOutboundReplySubject(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return fail();
    if (ownData(input, 'overridePresent') === true) {
      return validateOutboundReplySubject(ownData(input, 'override'));
    }
    const derived = deriveReplySubject(ownData(input, 'lastSubject'));
    return ok(derived);
  } catch {
    return fail();
  }
}

/**
 * Current subject from persisted inbound events + outbound staff reply records.
 * Placeholder inbound message_text is not consulted.
 */
const SQL_LAST_PERSISTED_SUBJECT = `
SELECT sub.subject
FROM (
  SELECT ev.subject AS subject, ev.received_at AS occurred_at, ev.id::text AS tie
  FROM tenant_email_inbound_inbox_projections p
  INNER JOIN tenant_email_inbound_events ev
    ON ev.client_id = p.client_id AND ev.id = p.inbound_event_id
  WHERE p.client_id = $1::uuid AND p.conversation_id = $2::uuid
    AND ev.subject IS NOT NULL AND btrim(ev.subject) <> ''
  UNION ALL
  SELECT NULLIF(m.metadata->>'email_subject', ''), m.created_at, m.id::text
  FROM messages m
  WHERE m.client_id = $1::uuid AND m.conversation_id = $2::uuid
    AND m.direction = 'outbound'
    AND m.source = 'staff_email_reply'
    AND m.route = 'email'
    AND NULLIF(m.metadata->>'email_subject', '') IS NOT NULL
) sub
WHERE sub.subject IS NOT NULL AND btrim(sub.subject) <> ''
ORDER BY sub.occurred_at DESC NULLS LAST, sub.tie DESC
LIMIT 1
`.replace(/\s+/g, ' ').trim();

function applySubjectToUpdateApprovedDraft(transport, subject) {
  try {
    if (typeof subject !== 'string' || !transport || typeof transport !== 'object') return transport;
    const checked = validateOutboundReplySubject(subject);
    if (!checked.ok) return transport;
    const update = ownData(transport, 'updateApprovedDraft');
    const createReply = ownData(transport, 'createReply');
    const sendDraft = ownData(transport, 'sendDraft');
    const reconcileDraft = ownData(transport, 'reconcileDraft');
    if (typeof update !== 'function' || typeof createReply !== 'function'
        || typeof sendDraft !== 'function' || typeof reconcileDraft !== 'function') {
      return transport;
    }
    const pinnedSubject = checked.value;
    return Object.freeze({
      createReply,
      sendDraft,
      reconcileDraft,
      updateApprovedDraft(input) {
        try {
          if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) {
            return update.call(transport, input);
          }
          const next = {};
          for (const k of Reflect.ownKeys(input)) {
            if (typeof k !== 'string') continue;
            const d = Object.getOwnPropertyDescriptor(input, k);
            if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set) continue;
            next[k] = d.value;
          }
          next.subject = pinnedSubject;
          return update.call(transport, next);
        } catch {
          return update.call(transport, input);
        }
      },
    });
  } catch {
    return transport;
  }
}

module.exports = Object.freeze({
  SUBJECT_MAX_CHARS,
  SUBJECT_KEY,
  NO_SUBJECT_PLACEHOLDER,
  SQL_LAST_PERSISTED_SUBJECT,
  validateOutboundReplySubject,
  deriveReplySubject,
  resolveOutboundReplySubject,
  applySubjectToUpdateApprovedDraft,
});
