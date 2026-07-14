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

const VERTICAL_TENANT = Object.freeze({
  [VERTICAL_IDS.SURF_SCHOOL]: 'sunset',
  [VERTICAL_IDS.ACCOMMODATION]: 'wolfhouse-somo',
});

const WOLFHOUSE_CLIENT_ALIASES = Object.freeze(['wolfhouse', 'wolfhouse-somo']);

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
  const expectedTenant = VERTICAL_TENANT[expectedVerticalId];
  if (expectedTenant && resolved.clientSlug !== expectedTenant) {
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

function isWolfhouseClientSlug(clientSlug) {
  const slug = String(clientSlug || '').trim();
  return WOLFHOUSE_CLIENT_ALIASES.includes(slug);
}

module.exports = {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  VERTICAL_TENANT,
  WOLFHOUSE_CLIENT_ALIASES,
  isWolfhouseClientSlug,
  assertResolvedVerticalScope,
};
