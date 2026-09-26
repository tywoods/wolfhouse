'use strict';

/**
 * Phase 19e — Luna WhatsApp Cloud API provider (gated; mockable in tests).
 *
 * Does not perform DB writes. Caller must enforce route gates before invoking.
 */

const DEFAULT_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isWhatsappDryRun(env) {
  return String((env || {}).WHATSAPP_DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';
}

function normalizeWhatsAppTo(to) {
  return trimStr(to).replace(/[^\d]/g, '');
}

function resolveWhatsappProviderConfig(env = process.env) {
  const e = env || {};
  // Key Vault / az CLI often appends a trailing newline to secret values.
  const accessToken = trimStr(e.WHATSAPP_CLOUD_ACCESS_TOKEN).replace(/\s+/g, '');
  return {
    access_token: accessToken,
    phone_number_id: trimStr(e.WHATSAPP_PHONE_NUMBER_ID),
    api_base_url: trimStr(e.WHATSAPP_API_BASE_URL) || DEFAULT_GRAPH_API_BASE,
  };
}

function providerConfigMissing(cfg) {
  return !cfg.access_token || !cfg.phone_number_id;
}

function resolveWhatsappPhoneNumberId(input, env = process.env) {
  const fromInput = trimStr(input && input.phone_number_id);
  if (fromInput) return fromInput;
  return resolveWhatsappProviderConfig(env).phone_number_id;
}

function isPhaseTestWamid(messageId) {
  return /^wamid\.PHASE[0-9A-Z]+/i.test(trimStr(messageId));
}

function isWhatsappTypingIndicatorEnabled(env) {
  const raw = String((env || {}).LUNA_WHATSAPP_TYPING_INDICATOR_ENABLED ?? 'true').trim().toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

function shouldSendLunaWhatsAppTypingIndicator(messageId, env = process.env) {
  const id = trimStr(messageId);
  if (!id || isPhaseTestWamid(id)) return false;
  if (isWhatsappDryRun(env)) return false;
  if (!isWhatsappTypingIndicatorEnabled(env)) return false;
  const cfg = resolveWhatsappProviderConfig(env);
  if (providerConfigMissing(cfg)) return false;
  return true;
}

/**
 * @param {{ to: string, message: string, client_slug?: string, idempotency_key?: string }} input
 * @param {object} [env]
 * @param {{ sendMessage?: Function, fetch?: Function }} [context]
 */
async function sendLunaWhatsAppMessage(input, env = process.env, context = {}) {
  const src = input || {};
  const to = trimStr(src.to);
  const message = trimStr(src.message);
  const clientSlug = trimStr(src.client_slug) || 'wolfhouse-somo';
  const idempotencyKey = trimStr(src.idempotency_key);

  const baseResult = {
    client_slug: clientSlug,
    idempotency_key: idempotencyKey || null,
    to,
    no_write_performed: true,
    creates_booking: false,
    creates_payment: false,
    creates_stripe_link: false,
    calls_n8n: false,
  };

  if (isWhatsappDryRun(env)) {
    return {
      ...baseResult,
      success: false,
      send_performed: false,
      sends_whatsapp: false,
      would_send_whatsapp: false,
      dry_run: true,
      blocked_reason: 'whatsapp_dry_run_active',
    };
  }

  if (typeof context.sendMessage === 'function') {
    const mockOut = await context.sendMessage({
      to,
      message,
      client_slug: clientSlug,
      idempotency_key: idempotencyKey,
      env,
    });
    if (mockOut && mockOut.success === true) {
      return {
        ...baseResult,
        success: true,
        send_performed: true,
        sends_whatsapp: true,
        would_send_whatsapp: true,
        whatsapp_message_id: mockOut.whatsapp_message_id || mockOut.message_id || 'mock-wamid-test',
        provider: 'mock',
      };
    }
    return {
      ...baseResult,
      success: false,
      send_performed: false,
      sends_whatsapp: false,
      would_send_whatsapp: true,
      blocked_reason: (mockOut && mockOut.blocked_reason) || 'whatsapp_send_mock_failed',
    };
  }

  const cfg = resolveWhatsappProviderConfig(env);
  if (providerConfigMissing(cfg)) {
    return {
      ...baseResult,
      success: false,
      send_performed: false,
      sends_whatsapp: false,
      would_send_whatsapp: true,
      blocked_reason: 'whatsapp_provider_config_missing',
    };
  }

  const fetchFn = context.fetch || global.fetch;
  if (typeof fetchFn !== 'function') {
    return {
      ...baseResult,
      success: false,
      send_performed: false,
      sends_whatsapp: false,
      would_send_whatsapp: true,
      blocked_reason: 'whatsapp_provider_fetch_unavailable',
    };
  }

  const url = `${cfg.api_base_url.replace(/\/$/, '')}/${cfg.phone_number_id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: normalizeWhatsAppTo(to),
    type: 'text',
    text: { body: message },
  };

  const headers = {
    Authorization: `Bearer ${cfg.access_token}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }

  if (!res.ok) {
    return {
      ...baseResult,
      success: false,
      send_performed: false,
      sends_whatsapp: false,
      would_send_whatsapp: true,
      blocked_reason: 'whatsapp_provider_send_failed',
      provider_status: res.status,
      provider_error: body.error || body,
    };
  }

  const messageId = (body.messages && body.messages[0] && body.messages[0].id)
    || body.message_id
    || null;

  return {
    ...baseResult,
    success: true,
    send_performed: true,
    sends_whatsapp: true,
    would_send_whatsapp: true,
    whatsapp_message_id: messageId,
    provider: 'whatsapp_cloud_api',
    provider_status: res.status,
  };
}

async function sendStaffWhatsAppTemplate(input, env = process.env, context = {}) {
  const src = input || {};
  const cfg = resolveWhatsappProviderConfig(env);
  const to = trimStr(src.to);
  const senderId = trimStr(src.sender_phone_number_id);
  const templateName = trimStr(src.template_name);
  const languageCode = trimStr(src.language_code);
  const components = Array.isArray(src.components) ? src.components : null;
  const base = { success: false, send_performed: false, sends_whatsapp: false,
    would_send_whatsapp: true, to, provider: 'whatsapp_cloud_api' };
  if (isWhatsappDryRun(env)) return { ...base, blocked_reason: 'whatsapp_dry_run_active' };
  if (!senderId || senderId !== cfg.phone_number_id) return { ...base, blocked_reason: 'staff_template_sender_mismatch' };
  if (!templateName || !languageCode || !components) return { ...base, blocked_reason: 'staff_template_metadata_invalid' };
  if (providerConfigMissing(cfg)) return { ...base, blocked_reason: 'whatsapp_provider_config_missing' };
  const fetchFn = context.fetch || global.fetch;
  if (typeof fetchFn !== 'function') return { ...base, blocked_reason: 'whatsapp_provider_fetch_unavailable' };
  const url = `${cfg.api_base_url.replace(/\/$/, '')}/${senderId}/messages`;
  const payload = { messaging_product: 'whatsapp', to: normalizeWhatsAppTo(to), type: 'template',
    template: { name: templateName, language: { code: languageCode }, components } };
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(Number(context.timeout_ms)) ? Number(context.timeout_ms) : 8000;
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const error = new Error('staff template provider timeout');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  let res;
  try {
    res = await Promise.race([fetchFn(url, { method: 'POST', headers: {
      Authorization: 'Bearer ' + cfg.access_token, 'Content-Type': 'application/json',
      ...(trimStr(src.idempotency_key) ? { 'X-Idempotency-Key': trimStr(src.idempotency_key) } : {}),
    }, body: JSON.stringify(payload), signal: controller.signal }), timeoutPromise]);
  } catch (error) {
    clearTimeout(timeout);
    return { ...base, outcome: 'ambiguous', blocked_reason: error && error.name === 'AbortError'
      ? 'staff_template_provider_timeout' : 'staff_template_provider_unknown', provider_error: error.message };
  }
  let body = {};
  try {
    body = await Promise.race([res.json(), timeoutPromise]);
  } catch (error) {
    return { ...base, outcome: 'ambiguous', blocked_reason: error && error.name === 'AbortError'
      ? 'staff_template_provider_timeout' : 'staff_template_provider_response_invalid', provider_error: error.message };
  } finally { clearTimeout(timeout); }
  if (!res.ok) return { ...base, outcome: 'definitive_failure', blocked_reason: 'staff_template_provider_rejected',
    provider_status: res.status, provider_error: body.error || body };
  const messageId = (body.messages && body.messages[0] && body.messages[0].id) || body.message_id || null;
  if (!trimStr(messageId)) return { ...base, outcome: 'ambiguous', blocked_reason: 'staff_template_provider_response_invalid',
    provider_status: res.status };
  return { ...base, success: true, outcome: 'accepted', send_performed: true, sends_whatsapp: true,
    whatsapp_message_id: messageId, provider_status: res.status };
}

/**
 * Show WhatsApp typing dots (+ mark inbound message read) while Luna prepares a reply.
 * @param {{ message_id: string, phone_number_id?: string }} input
 * @param {object} [env]
 * @param {{ fetch?: Function, sendTypingIndicator?: Function }} [context]
 */
async function sendLunaWhatsAppTypingIndicator(input, env = process.env, context = {}) {
  const messageId = trimStr(input && input.message_id);
  const baseResult = {
    message_id: messageId || null,
    typing_indicator_attempted: true,
    no_write_performed: true,
    creates_booking: false,
    creates_payment: false,
    creates_stripe_link: false,
    calls_n8n: false,
  };

  if (!shouldSendLunaWhatsAppTypingIndicator(messageId, env)) {
    return {
      ...baseResult,
      success: false,
      typing_indicator_sent: false,
      blocked_reason: isWhatsappDryRun(env)
        ? 'whatsapp_dry_run_active'
        : (!messageId ? 'missing_message_id' : 'typing_indicator_not_eligible'),
    };
  }

  if (typeof context.sendTypingIndicator === 'function') {
    const mockOut = await context.sendTypingIndicator({
      message_id: messageId,
      phone_number_id: resolveWhatsappPhoneNumberId(input, env),
      env,
    });
    if (mockOut && mockOut.success === true) {
      return {
        ...baseResult,
        success: true,
        typing_indicator_sent: true,
        provider: 'mock',
      };
    }
    return {
      ...baseResult,
      success: false,
      typing_indicator_sent: false,
      blocked_reason: (mockOut && mockOut.blocked_reason) || 'typing_indicator_mock_failed',
    };
  }

  const cfg = resolveWhatsappProviderConfig(env);
  const phoneNumberId = resolveWhatsappPhoneNumberId(input, env) || cfg.phone_number_id;
  if (!cfg.access_token || !phoneNumberId) {
    return {
      ...baseResult,
      success: false,
      typing_indicator_sent: false,
      blocked_reason: 'whatsapp_provider_config_missing',
    };
  }

  const fetchFn = context.fetch || global.fetch;
  if (typeof fetchFn !== 'function') {
    return {
      ...baseResult,
      success: false,
      typing_indicator_sent: false,
      blocked_reason: 'whatsapp_provider_fetch_unavailable',
    };
  }

  const url = `${cfg.api_base_url.replace(/\/$/, '')}/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
    typing_indicator: { type: 'text' },
  };

  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let body = {};
  try {
    body = await res.json();
  } catch (_) {
    body = {};
  }

  if (!res.ok) {
    return {
      ...baseResult,
      success: false,
      typing_indicator_sent: false,
      blocked_reason: 'whatsapp_typing_indicator_failed',
      provider_status: res.status,
      provider_error: body.error || body,
    };
  }

  return {
    ...baseResult,
    success: body.success === true || res.ok,
    typing_indicator_sent: body.success === true || res.ok,
    provider: 'whatsapp_cloud_api',
    provider_status: res.status,
  };
}

module.exports = {
  sendLunaWhatsAppMessage,
  sendStaffWhatsAppTemplate,
  sendLunaWhatsAppTypingIndicator,
  shouldSendLunaWhatsAppTypingIndicator,
  isWhatsappTypingIndicatorEnabled,
  isPhaseTestWamid,
  isWhatsappDryRun,
  resolveWhatsappProviderConfig,
  resolveWhatsappPhoneNumberId,
  providerConfigMissing,
  DEFAULT_GRAPH_API_BASE,
};
