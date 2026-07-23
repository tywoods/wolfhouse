'use strict';
/** Public non-secret Staff API identity probe (Stage 2D1). Separate from minimized /healthz. */
const HEALTH_IDENTITY_PATH = '/healthz/identity';
function handleStaffApiHealthIdentity(res, sendJSON, opts = {}) {
  const env = opts.env || process.env;
  return sendJSON(res, 200, {
    status: 'ok', service: 'staff-api',
    default_client_slug: String(env.DEFAULT_CLIENT_SLUG || '').trim(),
  });
}
function assertPublicHealthIdentityBody(body, expectedSlug) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, detail: 'body_not_object' };
  const keys = Object.keys(body).sort().join(',');
  if (keys !== 'default_client_slug,service,status') return { ok: false, detail: `unexpected_keys:${keys}` };
  if (body.status !== 'ok' || body.service !== 'staff-api') return { ok: false, detail: 'status_or_service' };
  if (String(body.default_client_slug) !== String(expectedSlug)) return { ok: false, detail: 'slug_mismatch' };
  return { ok: true };
}
module.exports = { HEALTH_IDENTITY_PATH, handleStaffApiHealthIdentity, assertPublicHealthIdentityBody };
