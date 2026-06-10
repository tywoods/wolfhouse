'use strict';

/**
 * Stage 31a — booking quote stale invalidation and correction/reset helpers.
 *
 * Code owns truth: if quote-affecting fields change after a ready quote,
 * prior quote/payment readiness must not be reused.
 */

const { collectPriorExtractedFields } = require('./luna-guest-context-merge');
const { detectPackageMutationIntent } = require('./luna-guest-message-intake');
const { detectPaymentChoiceFromMessage } = require('./luna-guest-payment-choice-dry-run');
const {
  detectPackageExplainerIntent,
} = require('./luna-guest-package-explainer');
const {
  detectServiceSideQuestionIntent,
  detectTransferSideQuestionIntent,
} = require('./luna-guest-service-transfer-explainer');

const QUOTE_AFFECTING_FIELDS = Object.freeze([
  'check_in',
  'check_out',
  'guest_count',
  'package_interest',
  'room_preference',
  'addons_skipped',
]);

const DATE_CORRECTION_RE = /\b(?:actually|sorry|wait|i\s+meant|meant|change(?:d)?\s+(?:to|the)?)\b/i;
const GUEST_COUNT_CORRECTION_RE = /\b(?:actually|sorry|wait|we\s+are|guests?\s*\d|\d\s+guests?)\b/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizeFieldValue(key, value) {
  if (value == null) return null;
  if (key === 'guest_count') return Number(value);
  if (key === 'addons_skipped') return value === true ? true : (value === false ? false : null);
  return trimStr(value).toLowerCase();
}

function detectQuoteAffectingFieldChanges(priorFields, currentFields) {
  const prior = priorFields || {};
  const current = currentFields || {};
  const corrected = [];
  for (const key of QUOTE_AFFECTING_FIELDS) {
    const p = normalizeFieldValue(key, prior[key]);
    const c = normalizeFieldValue(key, current[key]);
    if (p == null || c == null) continue;
    if (p !== c) corrected.push(key);
  }
  return corrected;
}

function hasExplicitDates(text) {
  return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[/-]\d|\d{4})\b/i.test(trimStr(text));
}

function hasGuestCountSignal(text) {
  return /\b(?:we\s+are|for\s+\d+|^\d+$|\d\s+guests?|guests?\s*\d)\b/i.test(trimStr(text));
}

/**
 * Corrections (package/dates/guests) are not full booking resets.
 */
function detectFieldCorrectionIntent(messageText) {
  const text = trimStr(messageText);
  if (!text) return false;
  if (detectPackageMutationIntent(text)) return true;
  if (DATE_CORRECTION_RE.test(text) && hasExplicitDates(text)) return true;
  if (GUEST_COUNT_CORRECTION_RE.test(text) && hasGuestCountSignal(text)) return true;
  return false;
}

function isQuotePreservingSideQuestion(messageText) {
  const text = trimStr(messageText);
  if (!text) return false;
  if (detectPackageExplainerIntent(text)) return true;
  if (detectServiceSideQuestionIntent(text)) return true;
  if (detectTransferSideQuestionIntent(text)) return true;
  const pc = detectPaymentChoiceFromMessage(text);
  if (pc === 'arrival_payment_question' || pc === 'payment_link_request') return true;
  return false;
}

function priorQuoteWasReady(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote && typeof ctx.quote === 'object' ? ctx.quote : {};
  const status = quote.quote_status || ctx.quote_status;
  return status === 'ready';
}

/**
 * Decide whether prior ready quote/payment state must be invalidated.
 * @returns {null|{ stale_quote_reason: string, corrected_fields: string[], previous_quote_invalidated: true }}
 */
function evaluateQuoteStaleInvalidation(priorGuestContext, routerResult, messageText) {
  if (!priorQuoteWasReady(priorGuestContext)) return null;
  const text = trimStr(messageText);
  if (!text) return null;
  if (isQuotePreservingSideQuestion(text)) return null;

  const priorFields = collectPriorExtractedFields(priorGuestContext);
  const currentFields = (routerResult && routerResult.extracted_fields) || {};
  const packageMutation = detectPackageMutationIntent(text);

  let corrected = detectQuoteAffectingFieldChanges(priorFields, currentFields);
  if (packageMutation) {
    corrected = [...new Set([...corrected, 'package_interest'])];
  }

  if (!corrected.length) return null;

  const reason = packageMutation
    ? 'package_changed'
    : corrected.join('_changed');

  return {
    stale_quote_reason: reason,
    corrected_fields: corrected,
    previous_quote_invalidated: true,
  };
}

function applyQuoteStaleInvalidation(guestContext, invalidation) {
  const prior = guestContext || {};
  const inv = invalidation || {};
  const priorQuote = prior.quote && typeof prior.quote === 'object' ? prior.quote : {};
  return {
    ...prior,
    quote: {
      quote_status: 'not_ready',
      quote_stale: true,
      stale_quote_reason: inv.stale_quote_reason || 'field_changed',
      corrected_fields: inv.corrected_fields || [],
      previous_quote_invalidated: true,
      payment_choice_needed: false,
      prior_quote_total_cents: priorQuote.quote_total_cents != null
        ? priorQuote.quote_total_cents
        : null,
      prior_package_code: priorQuote.package_code || null,
    },
    payment_choice_needed: false,
    quote_status: 'not_ready',
    payment_choice: null,
    stale_quote_reason: inv.stale_quote_reason || null,
    corrected_fields: inv.corrected_fields || [],
    previous_quote_invalidated: true,
  };
}

function quoteChainIsStale(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote && typeof ctx.quote === 'object' ? ctx.quote : {};
  return ctx.previous_quote_invalidated === true
    || ctx.quote_stale === true
    || quote.quote_stale === true
    || quote.previous_quote_invalidated === true;
}

function shouldPreservePriorReadyQuote(priorGuestContext) {
  if (!priorGuestContext) return false;
  if (quoteChainIsStale(priorGuestContext)) return false;
  const priorQuote = priorGuestContext.quote && typeof priorGuestContext.quote === 'object'
    ? priorGuestContext.quote
    : {};
  return priorQuote.quote_status === 'ready';
}

module.exports = {
  QUOTE_AFFECTING_FIELDS,
  detectQuoteAffectingFieldChanges,
  detectFieldCorrectionIntent,
  isQuotePreservingSideQuestion,
  evaluateQuoteStaleInvalidation,
  applyQuoteStaleInvalidation,
  quoteChainIsStale,
  shouldPreservePriorReadyQuote,
  priorQuoteWasReady,
};
