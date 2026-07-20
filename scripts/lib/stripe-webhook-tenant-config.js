'use strict';

/**
 * FORTRESS Slice 15B — authoritative Stripe webhook/reconcile tenant binding.
 *
 * Derives the expected client_slug for checkout-session payment lookup from
 * deployment/runtime env. Never trusts Stripe metadata as tenant authority.
 * Never hardcodes Wolfhouse/Sunset (or any tenant).
 *
 * Priority:
 *   1. STRIPE_WEBHOOK_CLIENT_SLUG (dedicated, preferred)
 *   2. DEFAULT_CLIENT_SLUG only when nonempty (compat fallback)
 *   3. If both set and conflict → fail closed
 *   4. If neither set → fail closed
 */

function trimSlug(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{
 *   ok: boolean,
 *   client_slug: string|null,
 *   reason: string,
 *   source: string|null,
 *   no_db_write: boolean,
 * }}
 */
function resolveStripeWebhookExpectedClientSlug(env) {
  const src = env || process.env || {};
  const webhookSlug = trimSlug(src.STRIPE_WEBHOOK_CLIENT_SLUG);
  const defaultSlug = trimSlug(src.DEFAULT_CLIENT_SLUG);

  if (webhookSlug && defaultSlug && webhookSlug !== defaultSlug) {
    return {
      ok: false,
      client_slug: null,
      reason: 'conflicting_runtime_client_slugs',
      source: null,
      no_db_write: true,
    };
  }

  if (webhookSlug) {
    return {
      ok: true,
      client_slug: webhookSlug,
      reason: 'stripe_webhook_client_slug',
      source: 'STRIPE_WEBHOOK_CLIENT_SLUG',
      no_db_write: false,
    };
  }

  if (defaultSlug) {
    return {
      ok: true,
      client_slug: defaultSlug,
      reason: 'default_client_slug_compat',
      source: 'DEFAULT_CLIENT_SLUG',
      no_db_write: false,
    };
  }

  return {
    ok: false,
    client_slug: null,
    reason: 'missing_runtime_client_slug',
    source: null,
    no_db_write: true,
  };
}

module.exports = {
  resolveStripeWebhookExpectedClientSlug,
  trimSlug,
};
