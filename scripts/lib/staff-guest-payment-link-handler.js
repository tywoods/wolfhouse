'use strict';

const { bindStaffGuestPaymentClient } = require('./staff-guest-payment-link-auth');

async function handleStaffGenerateGuestPaymentLink(req, res, user, deps) {
  const { STAFF_ACTIONS_ENABLED, sendJSON, send400, readBody, UUID_VALIDATE_RE,
    DEFAULT_CLIENT, assertStaffClientAccess, delegatedHandler } = deps;
  if (!STAFF_ACTIONS_ENABLED) return sendJSON(res, 403, {
    success: false,
    error: 'Staff write actions are disabled. Set STAFF_ACTIONS_ENABLED=true to enable.',
    staff_actions_enabled: false,
  });
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch (_) { return send400(res, 'invalid or missing JSON body'); }
  const guestId = String(body.booking_guest_id || body.guest_id || '').trim();
  if (!guestId || !UUID_VALIDATE_RE.test(guestId)) return send400(res, 'booking_guest_id must be a valid UUID');
  const boundClientSlug = bindStaffGuestPaymentClient({ req, body, user, defaultClient: DEFAULT_CLIENT,
    assertStaffClientAccess, res, sendJSON });
  if (!boundClientSlug) return;
  return delegatedHandler(guestId, req, res, user, 'staff_portal', Object.assign({}, deps.delegatedContext, {
    boundClientSlug, parsedBody: body,
  }));
}

module.exports = { handleStaffGenerateGuestPaymentLink };
