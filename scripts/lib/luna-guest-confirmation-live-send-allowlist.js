'use strict';

/**
 * Stage 27s — Confirmation live-send allowlist (staging proof only).
 *
 * Hard gate: when WHATSAPP_DRY_RUN=false, recipient must appear in
 * LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST before live WhatsApp send.
 *
 * No public guest automation · staging test phone only.
 */

const ALLOWLIST_ENV_KEY = 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST';

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function readEnv(env) {
  return env || process.env;
}

function normalizeRecipientPhone(to) {
  return trimStr(to).replace(/[^\d]/g, '');
}

/**
 * Parse comma/semicolon/whitespace-separated allowlist from env.
 * @param {object} [env]
 * @returns {string[]} normalized digit-only phone numbers
 */
function parseConfirmationLiveSendAllowlist(env) {
  const raw = trimStr(readEnv(env)[ALLOWLIST_ENV_KEY]);
  if (!raw) return [];
  return [...new Set(
    raw.split(/[,;\s]+/)
      .map(normalizeRecipientPhone)
      .filter(Boolean),
  )];
}

/**
 * @param {string} to
 * @param {object} [env]
 */
function isConfirmationLiveSendRecipientAllowlisted(to, env) {
  const normalized = normalizeRecipientPhone(to);
  if (!normalized) return false;
  const list = parseConfirmationLiveSendAllowlist(env);
  if (!list.length) return false;
  return list.includes(normalized);
}

/**
 * Live-send gate evaluation (only when WHATSAPP_DRY_RUN=false).
 *
 * @returns {{ allowed: boolean, reasons: string[], allowlist: string[], normalized_to: string }}
 */
function evaluateConfirmationLiveSendAllowlist(to, env) {
  const normalizedTo = normalizeRecipientPhone(to);
  const allowlist = parseConfirmationLiveSendAllowlist(env);
  const reasons = [];

  if (!normalizedTo) reasons.push('to_required');
  if (!allowlist.length) reasons.push('live_send_allowlist_not_configured');
  if (normalizedTo && allowlist.length && !allowlist.includes(normalizedTo)) {
    reasons.push('recipient_not_allowlisted');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    allowlist,
    normalized_to: normalizedTo || null,
  };
}

module.exports = {
  ALLOWLIST_ENV_KEY,
  parseConfirmationLiveSendAllowlist,
  isConfirmationLiveSendRecipientAllowlisted,
  evaluateConfirmationLiveSendAllowlist,
  normalizeRecipientPhone,
};
