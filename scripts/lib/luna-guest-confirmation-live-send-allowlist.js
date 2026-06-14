'use strict';

/**
 * Stage 27s — Confirmation live-send recipient normalization.
 *
 * Stage 54: allowlist removed — any guest phone may receive confirmation when
 * LUNA_AUTO_SEND_ENABLED=true and WHATSAPP_DRY_RUN=false.
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
  return !!normalizeRecipientPhone(to);
}

/**
 * Live-send gate evaluation (only when WHATSAPP_DRY_RUN=false).
 * Stage 54 — no per-phone allowlist; valid recipient phone is sufficient.
 *
 * @returns {{ allowed: boolean, reasons: string[], allowlist: string[], normalized_to: string }}
 */
function evaluateConfirmationLiveSendAllowlist(to, env) {
  const normalizedTo = normalizeRecipientPhone(to);
  const reasons = [];
  if (!normalizedTo) reasons.push('to_required');

  return {
    allowed: reasons.length === 0,
    reasons,
    allowlist: [],
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
