'use strict';

const STATUS = Object.freeze({
  CONNECTED: 'Connected',
  NOT_CONNECTED: 'Not connected',
  UNKNOWN: 'Unknown',
});

function routeOwner(evidence) {
  if (!evidence || !evidence.route) return '';
  return String(
    evidence.route.client_slug || evidence.route.target_id || evidence.route.id || '',
  ).trim().toLowerCase();
}

function deriveWhatsAppStatus(evidence, expectedOwner) {
  if (!evidence || evidence.error || evidence.denied || evidence.ok === false) return STATUS.UNKNOWN;
  if (evidence.revoked) return STATUS.NOT_CONNECTED;
  if (evidence.configured === false) return STATUS.NOT_CONNECTED;
  const owner = routeOwner(evidence);
  if (!owner) return STATUS.UNKNOWN;
  if (expectedOwner && owner !== String(expectedOwner).trim().toLowerCase()) return STATUS.NOT_CONNECTED;
  return STATUS.CONNECTED;
}

function deriveEmailStatus(evidence) {
  if (!evidence || evidence.error || evidence.denied || !Array.isArray(evidence.endpoints)) return STATUS.UNKNOWN;
  if (evidence.endpoints.some((row) => row && (row.grant_status === 'revoked' || row.binding_status === 'revoked'))) return STATUS.NOT_CONNECTED;
  if (evidence.endpoints.some((row) => row && row.active === true && row.binding_status === 'verified')) return STATUS.CONNECTED;
  return STATUS.NOT_CONNECTED;
}

function deriveStripeStatus(evidence) {
  if (!evidence || evidence.error || evidence.denied) return STATUS.UNKNOWN;
  if (evidence.enabled === false) return STATUS.NOT_CONNECTED;
  if (evidence.enabled !== true) return STATUS.NOT_CONNECTED;
  if (evidence.verified !== true) return STATUS.NOT_CONNECTED;
  return STATUS.CONNECTED;
}

function deriveLunaStatus(evidence) {
  if (!evidence || evidence.error || evidence.denied) return STATUS.UNKNOWN;
  if (evidence.revoked) return STATUS.NOT_CONNECTED;
  if (evidence.identity && evidence.routing) return STATUS.CONNECTED;
  return STATUS.NOT_CONNECTED;
}

function normalizeLunaEvidenceResponse(value) {
  if (!value || value.schema_version !== 'staff.luna_status_summary.v1') return null;
  if (typeof value.identity_configured !== 'boolean'
      || typeof value.routing_configured !== 'boolean'
      || typeof value.paused !== 'boolean') return null;
  return {
    identity: value.identity_configured,
    routing: value.routing_configured,
    paused: value.paused,
  };
}

async function safeRead(fn) {
  try { return await fn(); } catch (_) { return null; }
}

function emptyEnvironment() {
  return { WhatsApp: STATUS.UNKNOWN, WhatsAppDetail: '', Email: STATUS.UNKNOWN, EmailDetail: '', Stripe: STATUS.UNKNOWN, Luna: STATUS.UNKNOWN };
}

function emailDetail(evidence) {
  if (!evidence || !Array.isArray(evidence.endpoints)) return '';
  const endpoint = evidence.endpoints.find((row) => row && row.active === true && row.binding_status === 'verified');
  const value = endpoint && String(endpoint.public_address || '').trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : '';
}

async function collectClientConnectionStatuses(options = {}) {
  const clients = Array.isArray(options.clients) ? options.clients : [];
  const origins = options.staffOrigins || {};
  const requestJson = typeof options.requestJson === 'function' ? options.requestJson : null;
  const whatsapp = typeof options.readWhatsApp === 'function' ? await safeRead(options.readWhatsApp) : null;
  const readLunaEvidence = typeof options.readLunaEvidence === 'function' ? options.readLunaEvidence : null;
  const result = {};
  for (const client of clients) {
    const environments = client.id === 'wolfhouse-somo' ? ['live', 'staging'] : ['staging'];
    result[client.id] = {};
    for (const environment of environments) {
      const row = emptyEnvironment();
      const expectedRouteOwner = client.client_slug === 'wolfhouse-somo' ? 'wolfhouse' : client.client_slug;
      row.WhatsApp = environment === 'staging'
        ? deriveWhatsAppStatus(whatsapp, expectedRouteOwner)
        : STATUS.UNKNOWN;
      if (row.WhatsApp === STATUS.CONNECTED) row.WhatsAppDetail = String(whatsapp && (whatsapp.number_display || whatsapp.number_e164) || '').trim();
      const origin = origins[client.client_slug] && (typeof origins[client.client_slug] === 'string'
        ? origins[client.client_slug] : origins[client.client_slug][environment]);
      if (requestJson && origin) {
        const base = String(origin).replace(/\/$/, '');
        const email = await safeRead(() => requestJson(`${base}/staff/admin/email-settings?client=${encodeURIComponent(client.client_slug)}`));
        const payment = await safeRead(() => requestJson(`${base}/staff/admin/payment-summary?client=${encodeURIComponent(client.client_slug)}`));
        const luna = await safeRead(() => requestJson(`${base}/staff/admin/luna-status-summary?client=${encodeURIComponent(client.client_slug)}`));
        row.Email = deriveEmailStatus(email);
        if (row.Email === STATUS.CONNECTED) row.EmailDetail = emailDetail(email);
        row.Stripe = deriveStripeStatus(payment);
        row.Luna = deriveLunaStatus(normalizeLunaEvidenceResponse(luna));
      }
      if (readLunaEvidence) {
        const lunaEvidence = await safeRead(() => readLunaEvidence(client, environment, whatsapp));
        row.Luna = deriveLunaStatus(lunaEvidence);
      }
      result[client.id][environment] = row;
    }
  }
  return result;
}

module.exports = { STATUS, deriveWhatsAppStatus, deriveEmailStatus, deriveStripeStatus, deriveLunaStatus, normalizeLunaEvidenceResponse, collectClientConnectionStatuses };
