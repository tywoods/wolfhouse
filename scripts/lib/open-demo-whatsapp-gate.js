'use strict';

/**
 * Stage 27demo-b/c — Open demo WhatsApp inbound gate + live reply gate (no guest phone allowlist).
 */

const OPEN_DEMO_WHATSAPP_ROUTE = '/staff/bot/open-demo-whatsapp-inbound-dry-run';

function trimEnv(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isProductionEnvironment(env) {
  const e = env || process.env;
  return String(e.NODE_ENV || '').toLowerCase() === 'production';
}

function isOpenDemoWhatsAppEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_WHATSAPP_ENABLED === 'true';
}

function isOpenDemoLiveRepliesEnabled(env) {
  const e = env || process.env;
  return e.OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED === 'true';
}

function isWhatsappDryRun(env) {
  const e = env || process.env;
  return trimEnv(e.WHATSAPP_DRY_RUN).toLowerCase() !== 'false';
}

function configuredDemoPhoneNumberId(env) {
  const e = env || process.env;
  const v = e.OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID;
  return v != null && trimEnv(v) ? trimEnv(v) : null;
}

function configuredWhatsappPhoneNumberId(env) {
  const e = env || process.env;
  const v = e.WHATSAPP_PHONE_NUMBER_ID;
  return v != null && trimEnv(v) ? trimEnv(v) : null;
}

function wantsSendLiveReplyConfirmed(body) {
  const b = body || {};
  return b.send_live_reply_confirmed === true || b.send_live_reply_confirmed === 'true';
}

/**
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoWhatsAppGate(body, env) {
  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo WhatsApp inbound is disabled in production',
    };
  }
  if (!isOpenDemoWhatsAppEnabled(env)) {
    return {
      ok: false,
      status: 403,
      code: 'demo_disabled',
      error: 'open demo WhatsApp inbound is disabled (set OPEN_DEMO_WHATSAPP_ENABLED=true on staging)',
    };
  }
  const expectedPhoneNumberId = configuredDemoPhoneNumberId(env);
  if (expectedPhoneNumberId) {
    const incoming = body && body.phone_number_id != null
      ? trimEnv(body.phone_number_id)
      : '';
    if (!incoming || incoming !== expectedPhoneNumberId) {
      return {
        ok: false,
        status: 403,
        code: 'phone_number_id_mismatch',
        error: 'phone_number_id does not match OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
      };
    }
  }
  return { ok: true };
}

/**
 * Live reply gate — requires inbound demo gate + explicit env + WHATSAPP_DRY_RUN=false.
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string }}
 */
function evaluateOpenDemoWhatsAppLiveReplyGate(body, env) {
  const inboundGate = evaluateOpenDemoWhatsAppGate(body, env);
  if (!inboundGate.ok) return inboundGate;

  if (isProductionEnvironment(env)) {
    return {
      ok: false,
      status: 403,
      code: 'production_blocked',
      error: 'open demo WhatsApp live replies are disabled in production',
    };
  }
  if (!isOpenDemoLiveRepliesEnabled(env)) {
    return {
      ok: false,
      status: 403,
      code: 'live_replies_disabled',
      error: 'open demo live replies disabled (set OPEN_DEMO_WHATSAPP_LIVE_REPLIES_ENABLED=true)',
    };
  }
  if (isWhatsappDryRun(env)) {
    return {
      ok: false,
      status: 403,
      code: 'whatsapp_dry_run_active',
      error: 'WHATSAPP_DRY_RUN=true blocks live WhatsApp send',
    };
  }
  const demoPhoneId = configuredDemoPhoneNumberId(env);
  const waPhoneId = configuredWhatsappPhoneNumberId(env);
  if (demoPhoneId && waPhoneId && demoPhoneId !== waPhoneId) {
    return {
      ok: false,
      status: 403,
      code: 'whatsapp_phone_number_id_mismatch',
      error: 'WHATSAPP_PHONE_NUMBER_ID does not match OPEN_DEMO_WHATSAPP_PHONE_NUMBER_ID',
    };
  }
  return { ok: true };
}

function buildOpenDemoLiveReplySendBody(normalized, proposedReply) {
  const n = normalized || {};
  const reply = trimEnv(proposedReply);
  const sendKind = 'staff_reply';
  const idempotencyKey = `open-demo:${n.client_slug}:whatsapp:${n.inbound_message_id}:live-reply`;
  return {
    client_slug: n.client_slug,
    to: n.guest_phone,
    suggested_reply: reply,
    send_kind: sendKind,
    idempotency_key: idempotencyKey,
    source: 'open_demo_whatsapp_live_reply',
    draft: {
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
    },
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: true,
    },
  };
}

function buildOpenDemoLiveReplyBlockedResponse(gateResult) {
  return {
    live_send_blocked:     true,
    sends_whatsapp:        false,
    whatsapp_sent:         false,
    send_performed:        false,
    live_reply_attempted:  false,
    live_reply_gate_blocked: true,
    live_reply_gate_code:  gateResult.code || 'blocked',
    live_reply_error:      gateResult.error || 'open demo live reply blocked',
  };
}

function resolveInboundMessageId(body) {
  const b = body || {};
  if (b.inbound_message_id != null && String(b.inbound_message_id).trim()) {
    return String(b.inbound_message_id).trim();
  }
  if (b.wamid != null && String(b.wamid).trim()) {
    return String(b.wamid).trim();
  }
  if (b.raw_meta_message_id != null && String(b.raw_meta_message_id).trim()) {
    return String(b.raw_meta_message_id).trim();
  }
  return null;
}

/**
 * Validate n8n-shaped open demo payload (after trim).
 */
function validateOpenDemoInboundBody(body) {
  const b = body || {};
  const clientSlug = b.client_slug != null ? String(b.client_slug).trim() : '';
  const channel = b.channel != null ? String(b.channel).trim().toLowerCase() : '';
  const guestPhone = b.guest_phone != null ? String(b.guest_phone).trim() : '';
  const messageText = b.message_text != null ? String(b.message_text).trim() : '';
  const inboundMessageId = resolveInboundMessageId(b);

  const missing = [];
  if (!clientSlug) missing.push('client_slug');
  if (channel !== 'whatsapp') missing.push('channel must be whatsapp');
  if (!guestPhone) missing.push('guest_phone');
  if (!messageText) missing.push('message_text');
  if (!inboundMessageId) missing.push('inbound_message_id or wamid');

  return {
    ok: missing.length === 0,
    missing,
    normalized: {
      source: 'n8n_open_demo_whatsapp',
      client_slug: clientSlug,
      channel: 'whatsapp',
      guest_phone: guestPhone,
      message_text: messageText,
      inbound_message_id: inboundMessageId,
      phone_number_id: b.phone_number_id != null ? String(b.phone_number_id).trim() : null,
      contact_name: b.contact_name != null ? String(b.contact_name).trim() : null,
      received_at: b.received_at != null ? String(b.received_at).trim() : null,
      reference_date: b.reference_date != null ? String(b.reference_date).trim() : null,
      language_hint: b.language_hint,
      guest_context: b.guest_context,
      conversation_id: b.conversation_id != null ? String(b.conversation_id).trim() : null,
      automation_gate_context: {
        ...(b.automation_gate_context && typeof b.automation_gate_context === 'object'
          ? b.automation_gate_context
          : {}),
        public_guest_automation_enabled: false,
        whatsapp_dry_run: true,
        live_send_allowed: false,
        open_demo_whatsapp: true,
      },
    },
  };
}

function buildOpenDemoBlockedResponse(gateResult) {
  return {
    success:           false,
    dry_run:           true,
    open_demo:         true,
    sends_whatsapp:    false,
    live_send_blocked: true,
    demo_gate_blocked: true,
    demo_gate_code:    gateResult.code || 'blocked',
    error:             gateResult.error || 'open demo inbound blocked',
  };
}

module.exports = {
  OPEN_DEMO_WHATSAPP_ROUTE,
  isProductionEnvironment,
  isOpenDemoWhatsAppEnabled,
  isOpenDemoLiveRepliesEnabled,
  isWhatsappDryRun,
  configuredDemoPhoneNumberId,
  configuredWhatsappPhoneNumberId,
  wantsSendLiveReplyConfirmed,
  evaluateOpenDemoWhatsAppGate,
  evaluateOpenDemoWhatsAppLiveReplyGate,
  buildOpenDemoLiveReplySendBody,
  buildOpenDemoLiveReplyBlockedResponse,
  resolveInboundMessageId,
  validateOpenDemoInboundBody,
  buildOpenDemoBlockedResponse,
};
