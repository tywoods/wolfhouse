/**
 * Staff Portal — tenant-scoped CRM bulk WhatsApp outreach send (confirmation-gated).
 * Uses sendLunaWhatsAppMessage (Meta Cloud API provider). No email.
 *
 * @module staff-customer-outreach-send
 */

'use strict';

const crypto = require('crypto');
const { sendLunaWhatsAppMessage } = require('./luna-whatsapp-provider');
const {
  normalizeCustomerPhone,
  parseCrmTagsFromDb,
} = require('./staff-customer-queries');

const MAX_RECIPIENTS = 50;
const MESSAGE_MIN = 5;
const MESSAGE_MAX = 4000;
const OUTREACH_SEND_SOURCE = 'staff_customer_outreach';

function isCustomerOutreachWhatsAppEnabled(env = process.env) {
  return String((env || {}).CUSTOMER_OUTREACH_WHATSAPP_ENABLED || '').trim().toLowerCase() === 'true';
}

function trimText(value, maxLen) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.slice(0, maxLen);
}

function isValidOutreachPhone(phone) {
  const normalized = normalizeCustomerPhone(phone);
  if (!normalized) return false;
  const digits = normalized.replace(/[^\d]/g, '');
  return digits.length >= 8;
}

function uniquePhones(phones) {
  const out = [];
  const seen = new Set();
  for (const item of phones || []) {
    const normalized = normalizeCustomerPhone(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * @param {object} body
 * @returns {{ ok: true, value: { message: string, phones: string[] } } | { ok: false, error: string }}
 */
function parseOutreachSendBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.confirmed !== true) {
    return { ok: false, error: 'confirmation_required' };
  }
  const channel = trimText(b.channel || 'whatsapp', 32).toLowerCase() || 'whatsapp';
  if (channel !== 'whatsapp') {
    return { ok: false, error: 'email_not_supported' };
  }
  const message = trimText(b.message, MESSAGE_MAX);
  if (!message || message.length < MESSAGE_MIN) {
    return { ok: false, error: 'message_too_short' };
  }
  const phones = uniquePhones(Array.isArray(b.phones) ? b.phones : []);
  if (!phones.length) {
    return { ok: false, error: 'phones_required' };
  }
  if (phones.length > MAX_RECIPIENTS) {
    return { ok: false, error: 'recipient_cap_exceeded' };
  }
  return { ok: true, value: { message, phones, channel } };
}

function buildOutreachIdempotencyKey(clientSlug, phone, message) {
  const slug = trimText(clientSlug) || 'wolfhouse-somo';
  const hash = crypto.createHash('sha256')
    .update(`${slug}|${phone}|${message}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `crm-outreach:${slug}:${phone}:${hash}`;
}

/**
 * Tenant-scoped customer lookup for explicitly selected phones only.
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {string[]} phones
 */
async function lookupTenantCustomersByPhones(pg, clientSlug, phones) {
  const slug = trimText(clientSlug);
  if (!slug || !phones.length) return new Map();
  const r = await pg.query(
    `SELECT cu.phone, cu.full_name, cu.crm_tags
       FROM customers cu
      INNER JOIN clients c ON c.id = cu.client_id
      WHERE c.slug = $1
        AND cu.phone = ANY($2::text[])`,
    [slug, phones],
  );
  const map = new Map();
  for (const row of r.rows) {
    map.set(row.phone, row);
  }
  return map;
}

function customerIsDoNotContact(row) {
  if (!row) return false;
  const tags = parseCrmTagsFromDb(row.crm_tags);
  return tags.do_not_contact === true;
}

/**
 * Execute bulk outreach send for explicitly selected phones (no broadcast).
 *
 * @param {import('pg').Client|import('pg').PoolClient} pg
 * @param {string} clientSlug
 * @param {object} body
 * @param {{ env?: NodeJS.ProcessEnv, sendContext?: object, onRecipientAudit?: Function }} [opts]
 */
async function executeCustomerOutreachSend(pg, clientSlug, body, opts = {}) {
  const parsed = parseOutreachSendBody(body);
  if (!parsed.ok) {
    const status = parsed.error === 'recipient_cap_exceeded' ? 400 : 400;
    return { ok: false, status, error: parsed.error };
  }

  const { message, phones } = parsed.value;
  const customerMap = await lookupTenantCustomersByPhones(pg, clientSlug, phones);
  const results = [];
  const env = opts.env || process.env;
  const sendContext = opts.sendContext || {};

  for (const phone of phones) {
    const base = { phone, name: null };
    if (!isValidOutreachPhone(phone)) {
      const row = { ...base, status: 'skipped', reason: 'missing_phone' };
      results.push(row);
      if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
      continue;
    }

    const customer = customerMap.get(phone);
    if (!customer) {
      const row = { ...base, status: 'skipped', reason: 'not_in_tenant' };
      results.push(row);
      if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
      continue;
    }

    base.name = customer.full_name || null;
    if (customerIsDoNotContact(customer)) {
      const row = { ...base, status: 'skipped', reason: 'do_not_contact' };
      results.push(row);
      if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
      continue;
    }

    let sendResult;
    try {
      sendResult = await sendLunaWhatsAppMessage({
        to: phone,
        message,
        client_slug: clientSlug,
        idempotency_key: buildOutreachIdempotencyKey(clientSlug, phone, message),
      }, env, sendContext);
    } catch (err) {
      const row = {
        ...base,
        status: 'error',
        reason: 'send_failed',
        detail: err && err.message ? String(err.message).slice(0, 200) : null,
      };
      results.push(row);
      if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
      continue;
    }

    if (sendResult && sendResult.send_performed === true) {
      const row = {
        ...base,
        status: 'sent',
        whatsapp_message_id: sendResult.whatsapp_message_id || null,
      };
      results.push(row);
      if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
      continue;
    }

    const blocked = sendResult && sendResult.blocked_reason
      ? String(sendResult.blocked_reason)
      : 'send_failed';
    const row = {
      ...base,
      status: sendResult && sendResult.dry_run ? 'skipped' : 'error',
      reason: blocked,
    };
    results.push(row);
    if (typeof opts.onRecipientAudit === 'function') opts.onRecipientAudit(row);
  }

  const summary = {
    requested: phones.length,
    sent: results.filter((r) => r.status === 'sent').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    error: results.filter((r) => r.status === 'error').length,
  };

  return {
    ok: true,
    message_preview: message.slice(0, 240),
    results,
    summary,
    sends_whatsapp: summary.sent > 0,
  };
}

module.exports = {
  MAX_RECIPIENTS,
  MESSAGE_MIN,
  MESSAGE_MAX,
  OUTREACH_SEND_SOURCE,
  isCustomerOutreachWhatsAppEnabled,
  parseOutreachSendBody,
  buildOutreachIdempotencyKey,
  lookupTenantCustomersByPhones,
  executeCustomerOutreachSend,
  isValidOutreachPhone,
  customerIsDoNotContact,
};
