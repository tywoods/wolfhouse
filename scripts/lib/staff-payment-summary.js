'use strict';

const PAYMENT_SUMMARY_PATH = '/staff/admin/payment-summary';

function exactTrue(value) { return value === true || value === 'true'; }

/** Privacy-safe, read-only configuration evidence. Never returns a key or treats one as verification. */
function buildStaffPaymentSummary(env = process.env) {
  const enabled = exactTrue(env.STRIPE_LINKS_ENABLED);
  const keyMode = String(env.STRIPE_MODE || env.STRIPE_KEY_MODE || '').trim().toLowerCase();
  return Object.freeze({
    schema_version: 'staff.payment_summary.v1',
    enabled,
    key_mode: keyMode === 'test' ? 'test' : (keyMode === 'live' ? 'live' : 'unknown'),
    verified: enabled && exactTrue(env.STRIPE_ACCOUNT_VERIFIED),
  });
}

function handleStaffPaymentSummary(req, res, context = {}) {
  if (!req || req.method !== 'GET') return false;
  const sendJSON = context.sendJSON;
  if (typeof sendJSON !== 'function') throw new TypeError('sendJSON required');
  sendJSON(res, 200, buildStaffPaymentSummary(context.env || process.env), { 'Cache-Control': 'no-store' });
  return true;
}

module.exports = { PAYMENT_SUMMARY_PATH, buildStaffPaymentSummary, handleStaffPaymentSummary };
