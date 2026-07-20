'use strict';

/**
 * Stripe webhook public error minimization (RADAR 16O).
 *
 * Fail-closed client-visible bodies for POST /staff/stripe/webhook
 * pre-verification failures (raw-body read, missing webhook secret, SDK load,
 * signature verification). Never embed exception messages, stacks, parser
 * details, signatures, secrets, payloads, env/config names, or tenant
 * configuration.
 *
 * Internal audit may record only allowlisted reason categories — never raw
 * error text, signature, or body.
 */

const INVALID_STRIPE_SIGNATURE_CODE = 'invalid_stripe_signature';
const INVALID_STRIPE_SIGNATURE_MESSAGE = 'Invalid Stripe webhook signature';
const INVALID_WEBHOOK_REQUEST_CODE = 'invalid_webhook_request';
const STRIPE_WEBHOOK_UNAVAILABLE_CODE = 'stripe_webhook_unavailable';

const AUDIT_REASON_SDK_LOAD_FAILED = 'sdk_load_failed';
const AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED = 'signature_verification_failed';
const AUDIT_REASON_BODY_READ_FAILED = 'body_read_failed';
const AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE = 'webhook_secret_unavailable';

const ALLOWED_AUDIT_REASONS = Object.freeze([
  AUDIT_REASON_SDK_LOAD_FAILED,
  AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED,
  AUDIT_REASON_BODY_READ_FAILED,
  AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE,
]);

/** Frozen public body keys — exact schema for signature failures. */
const INVALID_SIGNATURE_BODY = Object.freeze({
  success: false,
  code: INVALID_STRIPE_SIGNATURE_CODE,
  message: INVALID_STRIPE_SIGNATURE_MESSAGE,
});

/** Frozen public body keys — exact schema for raw-body read failures. */
const INVALID_WEBHOOK_REQUEST_BODY = Object.freeze({
  success: false,
  code: INVALID_WEBHOOK_REQUEST_CODE,
});

/** Frozen public body keys — exact schema for SDK / secret unavailable (retryable 500). */
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
  'env',
  'config',
]);

const AUDIT_INTENT_BY_REASON = Object.freeze({
  [AUDIT_REASON_SDK_LOAD_FAILED]: 'webhook:stripe:sdk_load_failed',
  [AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED]: 'webhook:stripe:signature_verification_failed',
  [AUDIT_REASON_BODY_READ_FAILED]: 'webhook:stripe:body_read_failed',
  [AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE]: 'webhook:stripe:webhook_secret_unavailable',
});

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
 * @returns {{ success: false, code: string }}
 */
function buildInvalidWebhookRequestBody() {
  return {
    success: INVALID_WEBHOOK_REQUEST_BODY.success,
    code: INVALID_WEBHOOK_REQUEST_BODY.code,
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
 * Allowlisted audit entry for pre-verification public-error paths.
 * Never accepts raw exception text, signature, or body.
 * @param {'sdk_load_failed'|'signature_verification_failed'|'body_read_failed'|'webhook_secret_unavailable'} reason
 * @returns {{ ts: string, intent: string, category: string, reason: string, no_db_write: true }}
 */
function buildStripeWebhookPublicErrorAudit(reason) {
  if (!ALLOWED_AUDIT_REASONS.includes(reason)) {
    throw new Error('stripe_webhook_public_error_audit_reason_not_allowlisted');
  }
  return {
    ts: new Date().toISOString(),
    intent: AUDIT_INTENT_BY_REASON[reason],
    category: 'stripe_webhook',
    reason,
    no_db_write: true,
  };
}

/**
 * @param {unknown} body
 * @param {{ expectedKeys: string[], code: string, message?: string, retryable?: boolean }} spec
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertPublicErrorBodyShape(body, spec) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'body_not_object' };
  }
  const keys = Object.keys(body).sort();
  const expected = spec.expectedKeys.slice().sort();
  if (keys.join(',') !== expected.join(',')) {
    return { ok: false, detail: `unexpected_keys:${keys.join(',')}` };
  }
  for (const k of FORBIDDEN_PUBLIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      return { ok: false, detail: `forbidden_key:${k}` };
    }
  }
  if (body.success !== false) return { ok: false, detail: 'success_not_false' };
  if (body.code !== spec.code) return { ok: false, detail: 'code_mismatch' };
  if (Object.prototype.hasOwnProperty.call(spec, 'message')
    && body.message !== spec.message) {
    return { ok: false, detail: 'message_mismatch' };
  }
  if (Object.prototype.hasOwnProperty.call(spec, 'retryable')
    && body.retryable !== spec.retryable) {
    return { ok: false, detail: 'retryable_mismatch' };
  }
  return { ok: true };
}

/**
 * Assert a parsed public error body matches the frozen signature-failure schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertInvalidStripeSignatureBody(body) {
  return assertPublicErrorBodyShape(body, {
    expectedKeys: ['code', 'message', 'success'],
    code: INVALID_STRIPE_SIGNATURE_CODE,
    message: INVALID_STRIPE_SIGNATURE_MESSAGE,
  });
}

/**
 * Assert a parsed public error body matches the frozen raw-body failure schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertInvalidWebhookRequestBody(body) {
  return assertPublicErrorBodyShape(body, {
    expectedKeys: ['code', 'success'],
    code: INVALID_WEBHOOK_REQUEST_CODE,
  });
}

/**
 * Assert a parsed public error body matches the frozen unavailable schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertStripeWebhookUnavailableBody(body) {
  return assertPublicErrorBodyShape(body, {
    expectedKeys: ['code', 'retryable', 'success'],
    code: STRIPE_WEBHOOK_UNAVAILABLE_CODE,
    retryable: true,
  });
}

module.exports = {
  INVALID_STRIPE_SIGNATURE_CODE,
  INVALID_STRIPE_SIGNATURE_MESSAGE,
  INVALID_WEBHOOK_REQUEST_CODE,
  STRIPE_WEBHOOK_UNAVAILABLE_CODE,
  AUDIT_REASON_SDK_LOAD_FAILED,
  AUDIT_REASON_SIGNATURE_VERIFICATION_FAILED,
  AUDIT_REASON_BODY_READ_FAILED,
  AUDIT_REASON_WEBHOOK_SECRET_UNAVAILABLE,
  ALLOWED_AUDIT_REASONS,
  INVALID_SIGNATURE_BODY,
  INVALID_WEBHOOK_REQUEST_BODY,
  UNAVAILABLE_BODY,
  FORBIDDEN_PUBLIC_KEYS,
  buildInvalidStripeSignatureBody,
  buildInvalidWebhookRequestBody,
  buildStripeWebhookUnavailableBody,
  buildStripeWebhookPublicErrorAudit,
  assertInvalidStripeSignatureBody,
  assertInvalidWebhookRequestBody,
  assertStripeWebhookUnavailableBody,
};
