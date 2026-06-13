'use strict';

/**
 * Stage 57a — Hermes Luna Staff API bot tool wrappers.
 *
 * This is the thin client Hermes should use when Luna runs as the guest-facing
 * brain. It does not decide booking logic; it only maps Luna tool calls to the
 * Staff API /staff/bot/* contract with X-Luna-Bot-Token auth.
 */

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeBaseUrl(baseUrl) {
  const raw = trimStr(baseUrl || process.env.WOLFHOUSE_STAFF_API_BASE_URL || 'https://staff-staging.lunafrontdesk.com');
  return raw.replace(/\/+$/, '');
}

function normalizeBotPath(path) {
  const p = trimStr(path);
  if (!p) throw new Error('bot_path_required');
  if (/^https?:\/\//i.test(p)) return p;
  const noLead = p.replace(/^\/+/, '');
  if (noLead.startsWith('staff/bot/')) return `/${noLead}`;
  if (noLead.startsWith('bot/')) return `/staff/${noLead}`;
  return `/staff/bot/${noLead}`;
}

function parseJsonMaybe(text) {
  if (!trimStr(text)) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function resolveLunaDepositCents(input) {
  const i = input || {};
  const code = trimStr(i.package_code || i.package || i.package_interest).toLowerCase();
  if (['malibu', 'uluwatu', 'waimea'].includes(code)) return 20000;
  return 10000;
}

function createHermesStaffApiClient(options) {
  const opts = options || {};
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const botToken = trimStr(opts.botToken || process.env.LUNA_BOT_INTERNAL_TOKEN);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_impl_required');

  async function postBot(path, body, extra) {
    const e = extra || {};
    const urlPath = normalizeBotPath(path);
    const url = /^https?:\/\//i.test(urlPath) ? urlPath : `${baseUrl}${urlPath}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(e.headers || {}),
    };
    if (botToken) headers['X-Luna-Bot-Token'] = botToken;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
    const text = typeof res.text === 'function'
      ? await res.text()
      : (typeof res.json === 'function' ? JSON.stringify(await res.json()) : '');
    const parsed = parseJsonMaybe(text);
    if (!res.ok) {
      const err = new Error(`staff_api_bot_http_${res.status || 'error'}`);
      err.status = res.status;
      err.body = parsed;
      err.url = url;
      throw err;
    }
    return parsed == null ? { ok: true } : parsed;
  }

  return { baseUrl, postBot };
}

function buildHermesLunaToolset(options) {
  const client = createHermesStaffApiClient(options || {});
  return {
    client,
    checkAvailability(payload) {
      return client.postBot('/availability-check', payload);
    },
    quoteBooking(payload) {
      return client.postBot('/booking-preview', payload);
    },
    createBookingFromPlan(payload) {
      return client.postBot('/booking-create-from-plan', payload);
    },
    createPaymentLink(payload) {
      const p = payload || {};
      const paymentId = trimStr(p.payment_id || p.paymentId || p.id);
      if (!paymentId) throw new Error('payment_id_required');
      return client.postBot(`/payments/${encodeURIComponent(paymentId)}/create-stripe-link`, p);
    },
    sendConfirmation(payload) {
      return client.postBot('/bookings/send-confirmation', payload);
    },
    draftGuestReply(payload) {
      return client.postBot('/guest-reply-draft', payload);
    },
    sendGuestReply(payload) {
      return client.postBot('/guest-reply-send', payload);
    },
    addServiceToBooking(payload) {
      // Current Staff API exposes add-on/service write planning through preview;
      // confirm:true is required by the server for creation when enabled.
      return client.postBot('/addon-request-preview', payload);
    },
    saveTransfer(payload) {
      // Stage 57a Hermes contract endpoint. Staff API may need this route if not
      // already exposed; wrapper pins the desired /staff/bot/* shape.
      return client.postBot('/transfers/save', payload);
    },
    getPaymentStatus(payload) {
      return client.postBot('/payments/status', payload);
    },
    resolveDepositCents: resolveLunaDepositCents,
  };
}

module.exports = {
  createHermesStaffApiClient,
  buildHermesLunaToolset,
  resolveLunaDepositCents,
  normalizeBotPath,
};
