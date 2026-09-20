'use strict';

const crypto = require('node:crypto');
const {
  createEmailLunaSunsetEmailHermesSolClient,
} = require('../email-luna-sunset-email-hermes-sol-client');
const {
  parseCreateDraftNaturalPlan,
  renderCreateDraftNaturalPlan,
} = require('../email-luna-create-draft-natural-author');

const LIVE_SIMULATOR_EMAIL_ROUTE = '/api/live-simulator/email';
const MAX_SENDER_CHARS = 320;
const MAX_NAME_CHARS = 200;
const MAX_SUBJECT_CHARS = 998;
const MAX_BODY_CHARS = 16000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Synthetic simulator authority. These IDs do not name a mailbox, Inbox row,
// guest, or production entity; every request receives a fresh conversation and
// inbound-message ID before it crosses the existing same-Luna author door.
const SIMULATOR_AUTHORITY = Object.freeze({
  client_id: '6c349385-79ae-4bc7-904f-17d246b75df1',
  location_id: '11524d14-cd7e-469c-a56f-492868899456',
  location_key: 'sunset-somo',
  endpoint_id: '4f37194b-4a39-4baf-a76f-ddeac1d2890b',
});

function fail(status, code, error) {
  return { ok: false, status, code, error };
}

function clean(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > max) return null;
  return text;
}

function detectLanguage(subject, body) {
  const text = `${subject}\n${body}`;
  if (/[áéíóúñü¿¡]/i.test(text) || /\b(hola|gracias|reserva|alquiler|clase|tabla|habitación|cama|fechas?)\b/i.test(text)) return 'es';
  return 'en';
}

function normalizeEmailInput(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const tenant = String(source.tenantId || source.tenant || '').trim().toLowerCase();
  if (tenant !== 'sunset' && tenant !== 'sunset-somo' && tenant !== 'sunset-luna') {
    return fail(400, 'email_sunset_only', 'email simulation is available only for Sunset Luna');
  }
  const fromAddress = clean(source.fromAddress || source.from_address || source.sender, MAX_SENDER_CHARS);
  const fromDisplayName = clean(source.fromDisplayName || source.from_display_name || '', MAX_NAME_CHARS);
  const subject = clean(source.subject, MAX_SUBJECT_CHARS);
  const bodyText = clean(source.bodyText || source.body_text || source.body, MAX_BODY_CHARS);
  if (fromAddress === null || !EMAIL.test(fromAddress)) return fail(400, 'invalid_from_address', 'a valid mock sender email is required');
  if (fromDisplayName === null) return fail(413, 'from_display_name_too_large', 'sender name is too large');
  if (subject === null) return fail(413, 'subject_too_large', 'subject is too large');
  if (!subject) return fail(400, 'missing_subject', 'subject is required');
  if (bodyText === null) return fail(413, 'body_too_large', 'body is too large');
  if (!bodyText) return fail(400, 'missing_body', 'body is required');
  return {
    ok: true,
    tenant: 'sunset',
    language: detectLanguage(subject, bodyText),
    email: {
      subject,
      body_text: bodyText,
      quoted_history: '',
      from_display_name: fromDisplayName,
      from_address: fromAddress.toLowerCase(),
    },
  };
}

function isLiveSimulatorEmailStaging(env = process.env) {
  return String(env.CROWSNEST_ENVIRONMENT || '').trim().toLowerCase() === 'staging';
}

function authorEnvironment(env = process.env) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
    EMAIL_LUNA_HERMES_SOL_BASE_URL: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_ORIGIN || '',
    EMAIL_LUNA_HERMES_SOL_TOKEN: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_TOKEN || '',
    EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_HMAC_SECRET || '',
    EMAIL_LUNA_HERMES_SOL_TIMEOUT_MS: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_TIMEOUT_MS || '',
    EMAIL_LUNA_HERMES_SOL_TLS_PIN: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_TLS_PIN || '',
    EMAIL_LUNA_HERMES_SOL_TLS_SERVER_NAME: env.CROWSNEST_LIVE_SIM_EMAIL_AUTHOR_TLS_SERVER_NAME || '',
  };
}

function subjectForReply(subject) {
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

async function runLiveSimulatorEmail(input, options = {}) {
  const env = options.env || process.env;
  if (!isLiveSimulatorEmailStaging(env)) {
    return fail(404, 'email_simulator_not_available', 'Email simulator is available only in staging');
  }
  const normalized = normalizeEmailInput(input);
  if (!normalized.ok) return normalized;
  const conversationId = crypto.randomUUID();
  const inboundMessageId = crypto.randomUUID();
  const authority = {
    ...SIMULATOR_AUTHORITY,
    conversation_id: conversationId,
    inbound_message_id: inboundMessageId,
  };
  let client = options.authorClient;
  try {
    if (!client) client = createEmailLunaSunsetEmailHermesSolClient({ env: authorEnvironment(options.env) });
  } catch (_) {
    return fail(503, 'email_author_unavailable', 'Sunset Luna email author is not configured');
  }
  let authored;
  try {
    authored = await client.requestNaturalPlan({
      authority,
      untrusted_email: normalized.email,
      language: normalized.language,
      goals: '',
    });
  } catch (_) {
    return fail(502, 'email_author_unavailable', 'Sunset Luna email author is unavailable');
  }
  if (!authored || authored.status !== 'ok' || typeof authored.planJson !== 'string') {
    return fail(502, 'email_author_rejected', 'Sunset Luna could not draft this reply');
  }
  const plan = parseCreateDraftNaturalPlan(authored.planJson);
  const replyBody = plan && renderCreateDraftNaturalPlan(plan, normalized.language);
  if (!replyBody) return fail(502, 'email_author_malformed', 'Sunset Luna returned an invalid draft plan');
  return {
    ok: true,
    status: 200,
    tenant: 'sunset',
    tenant_label: 'Sunset Luna',
    channel: 'email',
    conversation_id: conversationId,
    inbound_message_id: inboundMessageId,
    from_address: normalized.email.from_address,
    inbound_subject: normalized.email.subject,
    reply_subject: subjectForReply(normalized.email.subject),
    reply_body: replyBody,
    language: normalized.language,
    delivery_status: 'not_sent',
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
    writes_allowed: false,
    catalog_quote_context: 'read_only',
    runtime: authored.marker && authored.marker.runtime ? authored.marker.runtime : 'hermes-sunset-luna-http',
    limitation: {
      staging_only: true,
      inbox_mirror_created: false,
      external_email_transport_enabled: false,
      graph_enabled: false,
      gmail_enabled: false,
      imap_enabled: false,
      smtp_enabled: false,
      booking_writes_enabled: false,
      payment_writes_enabled: false,
      waiver_writes_enabled: false,
    },
  };
}

module.exports = Object.freeze({
  LIVE_SIMULATOR_EMAIL_ROUTE,
  SIMULATOR_AUTHORITY,
  normalizeEmailInput,
  isLiveSimulatorEmailStaging,
  authorEnvironment,
  runLiveSimulatorEmail,
});
