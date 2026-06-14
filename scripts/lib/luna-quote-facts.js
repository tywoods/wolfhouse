'use strict';

/**
 * Stage 31c — quote fact extraction + composer/hold-writer alignment helpers.
 */

const { collectPriorExtractedFields } = require('./luna-guest-context-merge');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function normalizePackageCode(value) {
  const v = trimStr(value).toLowerCase();
  if (!v || v === 'accommodation_only') return v || null;
  return v;
}

/**
 * Extract canonical quote facts from an orchestrator/review payload.
 * @param {object} payload
 * @returns {object|null}
 */
function extractQuoteFactsFromPayload(payload) {
  const p = payload || {};
  const result = p.result || {};
  const quote = p.quote || {};
  const fields = collectPriorExtractedFields({
    ...p,
    result,
    extracted_fields: result.extracted_fields,
  });

  const packageCode = normalizePackageCode(
    quote.package_code
    || (quote.quote_detail && quote.quote_detail.package_code)
    || fields.package_interest,
  );

  return {
    package_code: packageCode,
    check_in: quote.check_in || fields.check_in || null,
    check_out: quote.check_out || fields.check_out || null,
    guest_count: quote.guest_count != null ? Number(quote.guest_count)
      : (fields.guest_count != null ? Number(fields.guest_count) : null),
    quote_total_cents: quote.quote_total_cents != null ? Number(quote.quote_total_cents) : null,
    quote_status: quote.quote_status || null,
    quote_stale: quote.quote_stale === true || result.previous_quote_invalidated === true,
  };
}

/**
 * Verifier-only: composer guest copy facts should match hold/write facts.
 */
function assertComposerFactsMatchHoldFacts(composerFacts, writeFacts) {
  const errors = [];
  const c = composerFacts || {};
  const w = writeFacts || {};
  if (w.package_code && c.package_code && normalizePackageCode(c.package_code) !== normalizePackageCode(w.package_code)) {
    errors.push(`package_code composer=${c.package_code} write=${w.package_code}`);
  }
  if (w.check_in && c.check_in && c.check_in !== w.check_in) {
    errors.push(`check_in composer=${c.check_in} write=${w.check_in}`);
  }
  if (w.check_out && c.check_out && c.check_out !== w.check_out) {
    errors.push(`check_out composer=${c.check_out} write=${w.check_out}`);
  }
  if (w.guest_count != null && c.guest_count != null && Number(c.guest_count) !== Number(w.guest_count)) {
    errors.push(`guest_count composer=${c.guest_count} write=${w.guest_count}`);
  }
  if (w.quote_total_cents != null && c.quote_total_cents != null
    && Number(c.quote_total_cents) !== Number(w.quote_total_cents)) {
    errors.push(`quote_total_cents composer=${c.quote_total_cents} write=${w.quote_total_cents}`);
  }
  return { ok: errors.length === 0, errors };
}

function buildQuoteFactsObservability(payload) {
  const facts = extractQuoteFactsFromPayload(payload);
  const plan = (payload && payload.hold_payment_draft_plan) || {};
  const writeFacts = facts && plan.plan_status === 'ready'
    ? {
      ...facts,
      payment_kind: plan.payment_kind || null,
      payment_amount_cents: plan.payment_amount_cents != null ? plan.payment_amount_cents : null,
    }
    : facts;
  return {
    quote_facts_used_by_composer: facts,
    quote_facts_used_by_hold_writer: writeFacts,
    correction_applied: !!(payload && payload.result && payload.result.previous_quote_invalidated),
  };
}

module.exports = {
  extractQuoteFactsFromPayload,
  assertComposerFactsMatchHoldFacts,
  buildQuoteFactsObservability,
  normalizePackageCode,
};
