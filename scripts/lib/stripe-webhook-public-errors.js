'use strict';

/**
 * Stripe webhook public error minimization (RADAR 16O).
 *
 * Fail-closed client-visible bodies for POST /staff/stripe/webhook signature /
 * SDK failures. Never embed exception messages, stacks, parser details,
 * signatures, secrets, payloads, or tenant configuration.
 *
 * Internal audit may record only allowlisted reason categories — never raw
 * error text, signature, or body.
 */

const INVALID_STRIPE_SIGNATURE_CODE = 'invalid_stripe_signature';
const INVALID_STRIPE_SIGNATURE_MESSAGE = 'Invalid Stripe webhook signature';
const STRIPE_WEBHOOK_UNAVAILABLE_CODE = 'stripe_webhook_unavailable';

const AUDIT_REASON_SDK_LOAD_FAILED = 'sdk_load_failed';
const AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED = 'signature_verification_failed';

const ALLOWED_AUDIT_REASONS = Object.freeze([
  AUDIT_REASON_SDK_LOAD_FAILED,
  AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED,
]);

/** Frozen public body keys — exact schema for signature failures. */
const INVALID_SIGNATURE_BODY = Object.freeze({
  success: false,
  code: INVALID_STRIPE_SIGNATURE_CODE,
  message: INVALID_STRIPE_SIGNATURE_MESSAGE,
});

/** Frozen public body keys — exact schema for SDK load failures (retryable 500). */
const UNAVAILABLE_BODY = Object.freeze({
  success: false,
  code: STRIPE_WEBHOOK_UNAVAILABLE_CODE,
  retryable: true,
});

const FORBIDDEN_PUBLIC_KEYS = Object.freeze([
  'error',
  'stack',
  'exception',
  'exception_class',
  'name',
  'type',
  'details',
  'detail',
  'parser',
  'signature',
  'stripe_signature',
  'webhook_secret',
  'secret',
  'payload',
  'event',
  'raw_body',
  'body',
  'tenant',
  'client_slug',
  'tenant_slug',
]);

/**
 * @returns {{ success: false, code: string, message: string }}
 */
function buildInvalidStripeSignatureBody() {
  return {
    success: INVALID_SIGNATURE_BODY.success,
    code: INVALID_SIGNATURE_BODY.code,
    message: INVALID_SIGNATURE_BODY.message,
  };
}

/**
 * @returns {{ success: false, code: string, retryable: true }}
 */
function buildStripeWebhookUnavailableBody() {
  return {
    success: UNAVAILABLE_BODY.success,
    code: UNAVAILABLE_BODY.code,
    retryable: UNAVAILABLE_BODY.retryable,
  };
}

/**
 * Allowlisted audit entry for signature/SDK public-error paths.
 * Never accepts raw exception text, signature, or body.
 * @param {'sdk_load_failed'|'signature_verification_failed'} reason
 * @returns {{ ts: string, intent: string, category: string, reason: string, no_db_write: true }}
 */
function buildStripeWebhookPublicErrorAudit(reason) {
  if (!ALLOWED_AUDIT_REASONS.includes(reason)) {
    throw new Error('stripe_webhook_public_error_audit_reason_not_allowlisted');
  }
  const intent = reason === AUDIT_REASON_SDK_LOAD_FAILED
    ? 'webhook:stripe:sdk_load_failed'
    : 'webhook:stripe:signature_verification_failed';
  return {
    ts: new Date().toISOString(),
    intent,
    category: 'stripe_webhook',
    reason,
    no_db_write: true,
  };
}

/**
 * Assert a parsed public error body matches the frozen signature-failure schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertInvalidStripeSignatureBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'body_not_object' };
  }
  const keys = Object.keys(body).sort();
  const expected = ['code', 'message', 'success'].sort();
  if (keys.join(',') !== expected.join(',')) {
    return { ok: false, detail: `unexpected_keys:${keys.join(',')}` };
  }
  for (const k of FORBIDDEN_PUBLIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      return { ok: false, detail: `forbidden_key:${k}` };
    }
  }
  if (body.success !== false) return { ok: false, detail: 'success_not_false' };
  if (body.code !== INVALID_STRIPE_SIGNATURE_CODE) {
    return { ok: false, detail: 'code_mismatch' };
  }
  if (body.message !== INVALID_STRIPE_SIGNATURE_MESSAGE) {
    return { ok: false, detail: 'message_mismatch' };
  }
  return { ok: true };
}

/**
 * Assert a parsed public error body matches the frozen SDK-unavailable schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertStripeWebhookUnavailableBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'body_not_object' };
  }
  const keys = Object.keys(body).sort();
  const expected = ['code', 'retryable', 'success'].sort();
  if (keys.join(',') !== expected.join(',')) {
    return { ok: false, detail: `unexpected_keys:${keys.join(',')}` };
  }
  for (const k of FORBIDDEN_PUBLIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      return { ok: false, detail: `forbidden_key:${k}` };
    }
  }
  if (body.success !== false) return { ok: false, detail: 'success_not_false' };
  if (body.code !== STRIPE_WEBHOOK_UNAVAILABLE_CODE) {
    return { ok: false, detail: 'code_mismatch' };
  }
  if (body.retryable !== true) return { ok: false, detail: 'retryable_not_true' };
  return { ok: true };
}

module.exports = {
  INVALID_STRIPE_SIGNATURE_CODE,
  INVALID_STRIPE_SIGNATURE_MESSAGE,
  STRIPE_WEBHOOK_UNAVAILABLE_CODE,
  AUDIT_REASON_SDK_LOAD_FAILED,
  AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED,
  ALLOWED_AUDIT_REASONS,
  INVALID_SIGNATURE_BODY,
  UNAVAILABLE_BODY,
  FORBIDDEN_PUBLIC_KEYS,
  buildInvalidStripeSignatureBody,
  buildStripeWebhookUnavailableBody,
  buildStripeWebhookPublicErrorAudit,
  assertInvalidStripeSignatureBody,
  assertStripeWebhookUnavailableBody,
};
