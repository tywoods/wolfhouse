'use strict';

function bindStaffGuestPaymentClient({ req, body, user, defaultClient, assertStaffClientAccess, res, sendJSON }) {
  const requestUrl = new URL(req.url || '/', 'http://staff.local');
  const clientSlug = String(requestUrl.searchParams.get('client') || defaultClient).trim();
  if (!assertStaffClientAccess(user, clientSlug, res)) return null;
  if (body.client_slug != null && String(body.client_slug).trim() !== clientSlug) {
    sendJSON(res, 403, { success: false, error: 'client_scope_mismatch' });
    return null;
  }
  return clientSlug;
}

module.exports = { bindStaffGuestPaymentClient };
