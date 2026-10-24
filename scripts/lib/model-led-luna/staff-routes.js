'use strict';

const { assertSafeToolRequest } = require('./contracts');

const LUNA_V3_ROUTE_TO_TOOL = Object.freeze({
  '/staff/bot/luna-v3/check-availability': 'check_availability',
  '/staff/bot/luna-v3/find-rooms': 'find_rooms',
  '/staff/bot/luna-v3/pricing-catalog': 'get_pricing_catalog',
  '/staff/bot/luna-v3/quote': 'quote',
  '/staff/bot/luna-v3/hold-beds': 'hold_beds',
  '/staff/bot/luna-v3/book': 'book',
  '/staff/bot/luna-v3/release-hold': 'release_hold',
  '/staff/bot/luna-v3/get-booking': 'get_booking',
  '/staff/bot/luna-v3/payment-status': 'get_payment_status',
  '/staff/bot/luna-v3/payment-link': 'send_payment_link',
  '/staff/bot/luna-v3/cancel-unpaid': 'cancel_unpaid',
  '/staff/bot/luna-v3/notes/read': 'read_notes',
  '/staff/bot/luna-v3/notes/write': 'write_note',
  '/staff/bot/luna-v3/transfer-request': 'save_transfer_request',
  '/staff/bot/luna-v3/handoff': 'handoff_to_human',
  '/staff/bot/luna-v3/recover-operation': 'recover_operation',
  '/staff/bot/luna-v3/admit-simulator-session': 'admit_simulator_session',
});

async function dispatchLunaV3StaffRoute({ pathname, method, clientSlug, body, operations, authenticatedPrincipal, resolveSession, admitSimulatorSession }) {
  const tool = LUNA_V3_ROUTE_TO_TOOL[pathname];
  if (!tool) return null;
  if (String(method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: { ok: false, code: 'method_not_allowed' } };
  }
  if (clientSlug !== 'wolfhouse-somo') {
    return { status: 403, body: { ok: false, code: 'luna_v3_tenant_forbidden' } };
  }
  const input = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  if (!authenticatedPrincipal || !String(authenticatedPrincipal.principalId || '').trim()
      || (tool !== 'admit_simulator_session' && typeof resolveSession !== 'function')) {
    return { status: 403, body: { ok: false, code: 'luna_v3_authenticated_context_required' } };
  }
  if (tool === 'admit_simulator_session') {
    const sessionId = String(input.session_id || '').trim();
    const guestPhone = String(input.guest_phone || '').trim();
    const scoped = /^luna-v3:[0-9a-f]{24}$/.test(sessionId)
      && /^\+346999\d{5,6}$/.test(guestPhone)
      && input.external_send_allowed === false
      && input.staff_alert_allowed === false
      && authenticatedPrincipal.writeAllowed === true
      && typeof admitSimulatorSession === 'function';
    if (!scoped) return { status: 403, body: { ok: false, code: 'luna_v3_simulator_scope_forbidden' } };
    const admitted = await admitSimulatorSession({
      clientSlug,
      sessionId,
      guestPhone,
      principalId: authenticatedPrincipal.principalId,
    });
    return { status: admitted && admitted.ok === false ? (admitted.status || 422) : 200, body: admitted };
  }
  const boundSession = await resolveSession({ selector: input.session_id,
    principalId: authenticatedPrincipal.principalId, clientSlug });
  if (!boundSession || !boundSession.sessionId) {
    return { status: 403, body: { ok: false, code: 'luna_v3_session_forbidden' } };
  }
  if (input.external_send_allowed !== false || input.staff_alert_allowed !== false) {
    return { status: 403, body: { ok: false, code: 'luna_v3_transport_forbidden' } };
  }
  const operation = operations && operations[tool];
  if (typeof operation !== 'function') {
    return { status: 503, body: { ok: false, code: 'luna_v3_tool_not_registered', tool } };
  }
  const modelInput = { ...input };
  // The generic bot wrapper pins the tenant by adding client_slug. That is
  // trusted transport context, not a model tool argument.
  delete modelInput.client_slug;
  delete modelInput.tenant_id;
  delete modelInput.session_id;
  delete modelInput.external_send_allowed;
  delete modelInput.staff_alert_allowed;
  try { assertSafeToolRequest(tool, modelInput); }
  catch (error) { return { status: 400, body: { ok: false, code: 'invalid_tool_request', message: error.message } }; }
  try {
    const result = await operation(modelInput, {
      tenantId: clientSlug,
      authenticated: true,
      sessionId: boundSession.sessionId,
      principalId: authenticatedPrincipal.principalId,
      writeAllowed: authenticatedPrincipal.writeAllowed === true && boundSession.writeAllowed === true,
      guestPhone: boundSession.guestPhone || null,
    });
    return { status: result && result.ok === false ? (result.status || 422) : 200, body: result };
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status
      : Number.isInteger(error && error.httpStatus) ? error.httpStatus : 500;
    return { status, body: { ok: false, code: error.code || (status === 403 ? 'write_admission_denied' : 'luna_v3_operation_failed') } };
  }
}

module.exports = { LUNA_V3_ROUTE_TO_TOOL, dispatchLunaV3StaffRoute };
