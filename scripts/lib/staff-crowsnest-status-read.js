'use strict';

const crypto = require('crypto');

const LUNA_STATUS_SUMMARY_PATH = '/staff/admin/luna-status-summary';
const STATUS_READ_TOKEN_ENV = 'CROWSNEST_STATUS_READ_TOKEN';

function timingSafeTextEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function authorizeCrowsnestStatusRead(req, env = process.env) {
  const expected = String(env[STATUS_READ_TOKEN_ENV] || '');
  const provided = String(req && req.headers && req.headers['x-crowsnest-status-token'] || '');
  return expected.length >= 32 && provided.length >= 32 && timingSafeTextEqual(provided, expected);
}

function resolveCrowsnestStatusClientSlug(env = process.env) {
  return String(env.DEFAULT_CLIENT_SLUG || env.STAFF_API_INGRESS_TENANT_SLUG || '').trim();
}

async function buildStaffLunaStatusSummary(options = {}) {
  const clientSlug = String(options.clientSlug || '').trim();
  if (!clientSlug) return null;
  const pauseResult = typeof options.readGlobalPause === 'function'
    ? await options.readGlobalPause(clientSlug)
    : null;
  if (!pauseResult || pauseResult.error || pauseResult.table_missing) return null;
  return Object.freeze({
    schema_version: 'staff.luna_status_summary.v1',
    client_slug: clientSlug,
    identity_configured: options.identityConfigured === true,
    routing_configured: options.routingConfigured === true,
    paused: Boolean(pauseResult.row && pauseResult.row.paused === true),
  });
}

module.exports = {
  LUNA_STATUS_SUMMARY_PATH,
  STATUS_READ_TOKEN_ENV,
  authorizeCrowsnestStatusRead,
  resolveCrowsnestStatusClientSlug,
  buildStaffLunaStatusSummary,
};
