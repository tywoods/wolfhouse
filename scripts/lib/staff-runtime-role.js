'use strict';

/**
 * Staff runtime role — production vs test/staging.
 * Names and host/profile signals only. Never logs secret values.
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function lower(v) {
  return trimStr(v).toLowerCase();
}

const PROD_VALUES = new Set(['production', 'prod']);

/**
 * True when this Staff process is production (fail closed for destructive testing).
 * Any one production signal wins, even if NODE_ENV looks like staging.
 */
function isProductionStaffRuntime(env, hostHeader) {
  const e = env || {};
  const nodeEnv = lower(e.NODE_ENV);
  const profile = lower(e.STAFF_RUNTIME_PROFILE);
  const deploy = lower(e.LUNA_DEPLOYMENT);
  const wolfhouseEnv = lower(e.WOLFHOUSE_ENV);
  const host = lower(hostHeader);

  if (PROD_VALUES.has(nodeEnv) || PROD_VALUES.has(profile) || PROD_VALUES.has(deploy) || PROD_VALUES.has(wolfhouseEnv)) {
    return true;
  }
  if (host.includes('staging') || host.includes('localhost') || host.startsWith('127.0.0.1')) {
    return false;
  }
  if (host.includes('wh.lunafrontdesk.com') || host.includes('staff.lunafrontdesk.com')) {
    return true;
  }
  return false;
}

/**
 * Full Wipe cancels bookings. Never on production. Staging/test only.
 */
function canInboxFullWipe(env, hostHeader) {
  if (isProductionStaffRuntime(env, hostHeader)) return false;
  const { isStagingResetEnvironment } = require('./luna-test-reset-phone');
  return isStagingResetEnvironment(env || process.env, hostHeader || '');
}

/**
 * Inbox Clear is its own permission: session reset + hide messages via cleared_at.
 * Does not cancel bookings. Allowed on production and TEST for authenticated staff
 * (route still uses requireAuth viewer+).
 */
function canInboxClearThread(_env, _hostHeader) {
  return true;
}

module.exports = {
  isProductionStaffRuntime,
  canInboxFullWipe,
  canInboxClearThread,
};
