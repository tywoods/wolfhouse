'use strict';

/**
 * Stage 27w.2 — Deterministic guest_context / extracted_fields merge for multi-turn dry-run.
 */

const EXTRACTED_FIELD_KEYS = [
  'check_in',
  'check_out',
  'guest_count',
  'package_interest',
  'transfer_interest',
  'service_interest',
  'payment_preference',
];

function isPresent(value) {
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function mergeServiceInterest(prior, current) {
  const a = Array.isArray(prior) ? prior : [];
  const b = Array.isArray(current) ? current : [];
  if (!a.length && !b.length) return [];
  if (!a.length) return [...b];
  if (!b.length) return [...a];
  const out = [...a];
  for (const item of b) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function mergeTransferInterest(prior, current) {
  if (isPresent(current)) return current;
  if (isPresent(prior)) return prior;
  return null;
}

/**
 * Merge prior extracted booking fields with current-turn extraction.
 * New non-null/non-empty values win; null/empty current values do not erase prior.
 */
function mergeGuestExtractedFields(prior, current) {
  const p = prior || {};
  const c = current || {};
  const merged = {};

  for (const key of EXTRACTED_FIELD_KEYS) {
    if (key === 'service_interest') {
      merged.service_interest = mergeServiceInterest(p.service_interest, c.service_interest);
      continue;
    }
    if (key === 'transfer_interest') {
      merged.transfer_interest = mergeTransferInterest(p.transfer_interest, c.transfer_interest);
      continue;
    }
    if (isPresent(c[key])) merged[key] = c[key];
    else if (isPresent(p[key])) merged[key] = p[key];
    else merged[key] = c[key] != null ? c[key] : (p[key] != null ? p[key] : null);
  }

  return merged;
}

/**
 * Collect prior extracted fields from a guest_context object (simulator / orchestrator).
 */
function collectPriorExtractedFields(guestContext) {
  const ctx = guestContext || {};
  const fromCtx = ctx.extracted_fields && typeof ctx.extracted_fields === 'object'
    ? ctx.extracted_fields
    : {};
  const fromResult = ctx.result && ctx.result.extracted_fields && typeof ctx.result.extracted_fields === 'object'
    ? ctx.result.extracted_fields
    : {};
  const fromPriorFields = ctx.prior_fields && typeof ctx.prior_fields === 'object'
    ? ctx.prior_fields
    : {};
  return mergeGuestExtractedFields(
    mergeGuestExtractedFields(fromPriorFields, fromResult),
    fromCtx,
  );
}

/**
 * Normalize guest_context for chain helpers (router input + downstream wire).
 */
function normalizeGuestContextForChain(guestContext) {
  if (!guestContext || typeof guestContext !== 'object') return {};
  const priorExtracted = collectPriorExtractedFields(guestContext);
  const out = { ...guestContext };
  if (Object.keys(priorExtracted).some((k) => isPresent(priorExtracted[k]))) {
    out.extracted_fields = priorExtracted;
  }
  if (!out.message_lane && out.result && out.result.message_lane) {
    out.message_lane = out.result.message_lane;
  }
  if (out.readiness_state == null && out.result && out.result.readiness_state) {
    out.readiness_state = out.result.readiness_state;
  }
  if (out.booking_intake_ready == null && out.result && out.result.booking_intake_ready != null) {
    out.booking_intake_ready = out.result.booking_intake_ready;
  }
  if (out.intake_state == null && out.result && out.result.intake_state) {
    out.intake_state = out.result.intake_state;
  }
  return out;
}

module.exports = {
  mergeGuestExtractedFields,
  collectPriorExtractedFields,
  normalizeGuestContextForChain,
  mergeServiceInterest,
  EXTRACTED_FIELD_KEYS,
};
