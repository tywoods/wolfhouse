'use strict';

const VERTICAL_IDS = Object.freeze({
  SURF_SCHOOL: 'surf_school',
  ACCOMMODATION: 'accommodation',
});

const VERTICAL_CHANNELS = Object.freeze({
  MANUAL_STAFF: 'manual_staff',
  LUNA_WHATSAPP: 'luna_whatsapp',
  SCHEDULE: 'schedule',
});

// Legacy compatibility constant only — the one canonical tenant per vertical.
// Do NOT derive the vertical→tenant *membership* check from this map: membership
// is an audited predicate (see tenantBelongsToVertical), this is the historical
// single-tenant identity kept for callers that still reference it.
const VERTICAL_TENANT = Object.freeze({
  [VERTICAL_IDS.SURF_SCHOOL]: 'sunset',
  [VERTICAL_IDS.ACCOMMODATION]: 'wolfhouse-somo',
});

const WOLFHOUSE_CLIENT_ALIASES = Object.freeze(['wolfhouse', 'wolfhouse-somo']);

const { isSurfSchoolClient } = require('./surf-school-config');

function isWolfhouseClientSlug(clientSlug) {
  const slug = String(clientSlug || '').trim();
  return WOLFHOUSE_CLIENT_ALIASES.includes(slug);
}

/**
 * Audited membership: is this trusted slug a valid tenant for the vertical?
 * This is the 403 cross-tenant isolation boundary. Widening surf_school from
 * equality (=== 'sunset') to membership (any configured surf school) PRESERVES
 * isolation — a wolfhouse slug still fails surf_school, and an unknown slug
 * fails both. Recognition here does NOT imply the tenant is provisioned in the
 * pricing/booking spine; adapters must still fail closed for unprovisioned
 * tenants (see surf-school adapter's tenant-provisioned guard).
 */
function tenantBelongsToVertical(verticalId, clientSlug) {
  if (verticalId === VERTICAL_IDS.SURF_SCHOOL) return isSurfSchoolClient(clientSlug);
  if (verticalId === VERTICAL_IDS.ACCOMMODATION) return isWolfhouseClientSlug(clientSlug);
  return false;
}

function assertResolvedVerticalScope(resolved, expectedVerticalId) {
  if (!resolved || resolved.ok !== true) {
    return {
      ok: false,
      status: 403,
      reason: (resolved && resolved.reason) || 'unknown_tenant',
      reason_code: (resolved && resolved.reason_code) || 'unknown_tenant',
    };
  }
  if (resolved.verticalId !== expectedVerticalId) {
    return {
      ok: false,
      status: 403,
      reason: 'vertical_mismatch',
      reason_code: 'vertical_mismatch',
      vertical_id: resolved.verticalId,
    };
  }
  if (!tenantBelongsToVertical(expectedVerticalId, resolved.clientSlug)) {
    return {
      ok: false,
      status: 403,
      reason: 'tenant_mismatch',
      reason_code: 'tenant_mismatch',
      client_slug: resolved.clientSlug,
    };
  }
  return { ok: true };
}

module.exports = {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  VERTICAL_TENANT,
  WOLFHOUSE_CLIENT_ALIASES,
  isWolfhouseClientSlug,
  tenantBelongsToVertical,
  assertResolvedVerticalScope,
};
