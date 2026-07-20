'use strict';

/**
 * FORTRESS Slice 15A — tenant identity / confused-deputy boundary helpers.
 *
 * Offline-only. No network, no DB, no real secrets. Used by the Slice 15A
 * verifier for static evidence checks and RED/GREEN attack-case classification.
 */

const VERDICTS = Object.freeze([
  'proven_fail_closed',
  'proven_isolated_by_runtime',
  'unproven',
  'vulnerable',
]);

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isVerdict(v) {
  return VERDICTS.includes(v);
}

/**
 * Classify Stripe metadata-only payment binding (Slice 15A evidence model).
 *
 * Authoritative session binding (stripe_checkout_session_id === session.id) is
 * safe regardless of metadata. Metadata-only binding without a matching
 * client_slug is a defense-in-depth / confused-deputy risk on shared DB+Stripe.
 * Metadata reaches this path only after Stripe signature admission (not
 * arbitrary unauthenticated input).
 *
 * @returns {{ ok: boolean, reason: string, verdict: string }}
 */
function classifyStripeMetadataPaymentBinding(input) {
  const session = (input && input.session) || {};
  const payment = (input && input.payment) || {};
  const sessionId = trimStr(session.id);
  const lockedSessionId = trimStr(payment.stripe_checkout_session_id);
  const metaPaymentId = trimStr(session.metadata && session.metadata.payment_id);
  const metaClientSlug = trimStr(session.metadata && session.metadata.client_slug);
  const paymentId = trimStr(payment.payment_id);
  const paymentClientSlug = trimStr(payment.client_slug);

  if (lockedSessionId && sessionId && lockedSessionId === sessionId) {
    if (metaClientSlug && paymentClientSlug && metaClientSlug !== paymentClientSlug) {
      return {
        ok: false,
        reason: 'stripe_metadata_client_slug_mismatch',
        verdict: 'proven_fail_closed',
      };
    }
    return {
      ok: true,
      reason: 'session_id_authoritative',
      verdict: 'proven_fail_closed',
    };
  }

  if (!metaPaymentId) {
    return {
      ok: false,
      reason: 'binding_missing',
      verdict: 'proven_fail_closed',
    };
  }

  if (metaPaymentId !== paymentId) {
    return {
      ok: false,
      reason: 'metadata_payment_id_mismatch',
      verdict: 'proven_fail_closed',
    };
  }

  // Metadata-only path: current production code looks up by payment UUID globally
  // and only rejects client_slug mismatch when metadata.client_slug is present.
  if (!metaClientSlug) {
    return {
      ok: false,
      reason: 'metadata_only_missing_client_slug',
      verdict: 'vulnerable',
    };
  }
  if (metaClientSlug !== paymentClientSlug) {
    return {
      ok: false,
      reason: 'stripe_metadata_client_slug_mismatch',
      verdict: 'proven_fail_closed',
    };
  }

  // Matching metadata still trusts a global UUID lookup — shared DB risk remains
  // unless runtime isolates Stripe account + DB per tenant.
  return {
    ok: true,
    reason: 'metadata_only_matched_client_slug_shared_db_risk',
    verdict: 'vulnerable',
  };
}

/**
 * Classify bot-token vs body client_slug confused-deputy cases.
 * Sunset forced handlers reject body overrides; generic bot paths trust body.
 */
function classifyBotTenantOverride(input) {
  const authMode = trimStr(input && input.auth_mode);
  const handlerPolicy = trimStr(input && input.handler_policy);
  const bodySlug = trimStr(input && input.body_client_slug);
  const runtimeSlug = trimStr(input && input.runtime_client_slug);
  const forcedSlug = trimStr(input && input.forced_client_slug);

  if (authMode !== 'bot_token') {
    return { ok: true, reason: 'not_bot_token_path', verdict: 'unproven' };
  }

  if (handlerPolicy === 'force_tenant') {
    if (forcedSlug && bodySlug && bodySlug !== forcedSlug) {
      return {
        ok: false,
        reason: 'body_override_ignored_forced_tenant',
        verdict: 'proven_fail_closed',
        effective_client_slug: forcedSlug,
      };
    }
    return {
      ok: true,
      reason: 'forced_tenant',
      verdict: 'proven_fail_closed',
      effective_client_slug: forcedSlug || runtimeSlug,
    };
  }

  if (handlerPolicy === 'trust_body') {
    const effective = bodySlug || runtimeSlug;
    if (bodySlug && runtimeSlug && bodySlug !== runtimeSlug) {
      return {
        ok: true,
        reason: 'body_client_slug_overrides_runtime',
        verdict: 'vulnerable',
        effective_client_slug: effective,
      };
    }
    return {
      ok: true,
      reason: 'body_or_default_client_slug',
      verdict: 'vulnerable',
      effective_client_slug: effective,
    };
  }

  return { ok: false, reason: 'unknown_handler_policy', verdict: 'unproven' };
}

/**
 * Classify WhatsApp phone_number_id vs live normalized.client_slug behavior.
 */
function classifyWhatsAppIngressTenant(input) {
  const routingEnabled = !!(input && input.routing_config_enabled);
  const hardBlockEnabled = !!(input && input.hard_block_enabled);
  const phoneNumberId = trimStr(input && input.phone_number_id);
  const shadowSlug = input && input.shadow_client_slug != null
    ? trimStr(input.shadow_client_slug)
    : null;
  const shadowBlocked = !!(input && input.channel_resolution_blocked);
  const liveSlug = trimStr(input && input.live_client_slug);

  if (!routingEnabled) {
    return {
      ok: true,
      reason: 'routing_config_absent_legacy_default',
      verdict: 'proven_isolated_by_runtime',
      effective_client_slug: liveSlug || 'wolfhouse-somo',
    };
  }

  if (!phoneNumberId || shadowBlocked || !shadowSlug) {
    if (hardBlockEnabled) {
      return {
        ok: false,
        reason: 'unknown_channel_identity_hard_blocked',
        verdict: 'proven_fail_closed',
      };
    }
    return {
      ok: true,
      reason: 'unknown_phone_number_id_shadow_only_live_default_unchanged',
      verdict: 'vulnerable',
      effective_client_slug: liveSlug || 'wolfhouse-somo',
    };
  }

  if (liveSlug && shadowSlug && liveSlug !== shadowSlug && liveSlug !== 'wolfhouse' && shadowSlug !== 'wolfhouse') {
    // live still on legacy default while shadow resolved differently
    if (liveSlug === 'wolfhouse-somo' && shadowSlug === 'sunset') {
      return {
        ok: true,
        reason: 'shadow_resolved_but_live_client_slug_not_switched',
        verdict: 'vulnerable',
        effective_client_slug: liveSlug,
        shadow_client_slug: shadowSlug,
      };
    }
  }

  if (liveSlug === shadowSlug || (liveSlug === 'wolfhouse-somo' && shadowSlug === 'wolfhouse')) {
    return {
      ok: true,
      reason: 'live_matches_shadow_or_wolfhouse_alias',
      verdict: hardBlockEnabled ? 'proven_fail_closed' : 'unproven',
      effective_client_slug: liveSlug,
    };
  }

  return {
    ok: true,
    reason: 'shadow_live_divergence',
    verdict: 'vulnerable',
    effective_client_slug: liveSlug,
    shadow_client_slug: shadowSlug,
  };
}

/**
 * Classify Sunset Somo vs Sardinero location confusion.
 */
function classifySunsetLocationBinding(input) {
  const phoneNumberId = trimStr(input && input.phone_number_id);
  const routes = (input && input.routes) || {};
  const requestedLocation = trimStr(input && input.requested_location_id);
  const matched = routes[phoneNumberId];

  if (!phoneNumberId || !matched) {
    return {
      ok: false,
      reason: 'unknown_sunset_phone_number_id',
      verdict: 'proven_fail_closed',
    };
  }
  if (requestedLocation && requestedLocation !== matched) {
    return {
      ok: false,
      reason: 'location_override_rejected',
      verdict: 'proven_fail_closed',
      location_id: matched,
    };
  }
  return {
    ok: true,
    reason: 'phone_number_id_authoritative',
    verdict: 'proven_fail_closed',
    location_id: matched,
  };
}

/**
 * Classify portal session vs request tenant mismatch.
 */
function classifyPortalSessionTenant(input) {
  const sessionSlug = trimStr(input && input.session_client_slug);
  const requestSlug = trimStr(input && input.request_client_slug);
  const accessible = Array.isArray(input && input.accessible_slugs)
    ? input.accessible_slugs.map(trimStr)
    : [];
  const assertAccessCalled = !!(input && input.assert_staff_client_access);

  if (!sessionSlug) {
    return { ok: false, reason: 'missing_session_client', verdict: 'proven_fail_closed' };
  }
  if (accessible.length && !accessible.includes(sessionSlug)) {
    return { ok: false, reason: 'session_client_access_denied', verdict: 'proven_fail_closed' };
  }
  if (requestSlug && requestSlug !== sessionSlug) {
    if (assertAccessCalled && !accessible.includes(requestSlug)) {
      return { ok: false, reason: 'client_access_denied', verdict: 'proven_fail_closed' };
    }
    if (!assertAccessCalled) {
      return {
        ok: true,
        reason: 'request_tenant_mismatch_without_assert',
        verdict: 'unproven',
      };
    }
  }
  return { ok: true, reason: 'session_scoped', verdict: 'proven_fail_closed' };
}

/**
 * Secret-free fixture hygiene: reject strings that look like live credentials.
 */
function scanSecretFreeText(text) {
  const raw = String(text || '');
  const findings = [];
  const patterns = [
    { id: 'sk_live', re: /sk_live_[A-Za-z0-9]+/ },
    { id: 'sk_test_long', re: /sk_test_[A-Za-z0-9]{20,}/ },
    { id: 'whsec', re: /whsec_[A-Za-z0-9]+/ },
    { id: 'bearer_jwt', re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { id: 'aws_key', re: /AKIA[0-9A-Z]{16}/ },
    { id: 'meta_token', re: /EAA[A-Za-z0-9]{30,}/ },
  ];
  for (const p of patterns) {
    if (p.re.test(raw)) findings.push(p.id);
  }
  return findings;
}

function summarizeVerdictCounts(boundaries) {
  const counts = {
    proven_fail_closed: 0,
    proven_isolated_by_runtime: 0,
    unproven: 0,
    vulnerable: 0,
    total: 0,
  };
  for (const b of boundaries || []) {
    const v = b && b.verdict;
    if (!isVerdict(v)) continue;
    counts[v] += 1;
    counts.total += 1;
  }
  return counts;
}

module.exports = {
  VERDICTS,
  SEVERITIES,
  isVerdict,
  classifyStripeMetadataPaymentBinding,
  classifyBotTenantOverride,
  classifyWhatsAppIngressTenant,
  classifySunsetLocationBinding,
  classifyPortalSessionTenant,
  scanSecretFreeText,
  summarizeVerdictCounts,
};
