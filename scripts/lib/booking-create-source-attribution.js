'use strict';

/**
 * Trust boundary for /staff/bot/booking-create-from-plan.
 * The caller's authenticated principal, never the transport/plugin payload,
 * owns the persisted creation source used by Finance.
 */
function sourceForAuthenticatedCaller(authMode) {
  return authMode === 'bot_token' ? 'luna_guest' : 'staff';
}

function stampBookingCreateSource(body, authMode) {
  const safeBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return { ...safeBody, source: sourceForAuthenticatedCaller(authMode) };
}

module.exports = { sourceForAuthenticatedCaller, stampBookingCreateSource };
