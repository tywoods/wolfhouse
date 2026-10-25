'use strict';

const { assertSafeToolRequest } = require('./contracts');
const { refusalEnvelope } = require('./staff-request-contract');

const refuse = (code, classification = 'validation', extra = {}, context = {}) => refusalEnvelope({ code, classification, ...extra }, context);

const LUNA_V3_ROUTE_TO_TOOL = Object.freeze({
  '/staff/bot/luna-v3/check-quote-book': 'check_quote_book',
  '/staff/bot/luna-v3/check-availability': 'check_availability',
  '/staff/bot/luna-v3/find-rooms': 'find_rooms',
  '/staff/bot/luna-v3/pricing-catalog': 'get_pricing_catalog',
  '/staff/bot/luna-v3/quote': 'quote',
  '/staff/bot/luna-v3/hold-beds': 'hold_beds',
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
  '/staff/bot/luna-v3/record-offer-presentation': '_record_offer_presentation',
});

async function dispatchLunaV3StaffRoute({ pathname, method, clientSlug, body, operations, authenticatedPrincipal, resolveSession, admitSimulatorSession, recordAssistantEvent }) {
  const tool = LUNA_V3_ROUTE_TO_TOOL[pathname];
  if (!tool) return null;
  const correlation_id = authenticatedPrincipal && (authenticatedPrincipal.correlationId || authenticatedPrincipal.turnId) || null;
  const reject = (code, classification = 'validation', extra = {}) => refuse(code, classification, extra,
    { correlationId: extra.correlation_id || correlation_id });
  if (String(method || '').toUpperCase() !== 'POST') {
    return { status: 405, body: reject('method_not_allowed') };
  }
  if (clientSlug !== 'wolfhouse-somo') {
    return { status: 403, body: reject('luna_v3_tenant_forbidden', 'authorization') };
  }
  const input = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  if (!authenticatedPrincipal || !String(authenticatedPrincipal.principalId || '').trim()
      || (tool !== 'admit_simulator_session' && typeof resolveSession !== 'function')) {
    return { status: 403, body: reject('luna_v3_authenticated_context_required', 'authorization') };
  }
  if (tool === 'admit_simulator_session') {
    const sessionId = String(input.session_id || '').trim();
    const guestPhone = String(input.guest_phone || '').trim();
    const messageDigest = String(input.message_digest || '').trim();
    const scoped = /^luna-v3:[0-9a-f]{24}$/.test(sessionId)
      && /^\+346999\d{5,6}$/.test(guestPhone)
      && input.external_send_allowed === false
      && input.staff_alert_allowed === false
      && /^[a-f0-9]{64}$/.test(messageDigest)
      && authenticatedPrincipal.writeAllowed === true
      && typeof admitSimulatorSession === 'function';
    if (!scoped) return { status: 403, body: reject('luna_v3_simulator_scope_forbidden', 'authorization') };
    const admitted = await admitSimulatorSession({
      clientSlug,
      sessionId,
      guestPhone,
      principalId: authenticatedPrincipal.principalId,
      messageDigest,
    });
    return { status: admitted && admitted.ok === false ? (admitted.status || 422) : 200, body: admitted };
  }
  const inboundEventId = String(authenticatedPrincipal.inboundEventId || '').trim();
  const boundSession = await resolveSession({ selector: input.session_id,
    principalId: authenticatedPrincipal.principalId, clientSlug, inboundEventId });
  if (!boundSession || !boundSession.sessionId) {
    return { status: 403, body: reject('luna_v3_session_forbidden', 'authorization') };
  }
  if (input.external_send_allowed !== false || input.staff_alert_allowed !== false) {
    return { status: 403, body: reject('luna_v3_transport_forbidden', 'authorization') };
  }
  const operation = operations && operations[tool];
  if (typeof operation !== 'function') {
    return { status: 503, body: { ...reject('luna_v3_tool_not_registered', 'internal'), tool } };
  }
  const modelInput = { ...input };
  // The generic bot wrapper pins the tenant by adding client_slug. That is
  // trusted transport context, not a model tool argument.
  delete modelInput.client_slug;
  delete modelInput.tenant_id;
  delete modelInput.session_id;
  delete modelInput.external_send_allowed;
  delete modelInput.staff_alert_allowed;
  delete modelInput.trusted_turn_id;
  try {
    if (tool === '_record_offer_presentation') {
      if (!/^offer_[A-Za-z0-9_-]{24,80}$/.test(String(modelInput.offer_reference || ''))
          || !String(modelInput.assistant_reply || '').trim()
          || typeof recordAssistantEvent !== 'function') throw new Error('trusted presentation evidence is required');
      modelInput.assistant_event_id = await recordAssistantEvent({ sessionId: boundSession.sessionId,
        principalId: authenticatedPrincipal.principalId, inboundEventId, reply: modelInput.assistant_reply });
    } else assertSafeToolRequest(tool, modelInput);
  }
  catch (error) {
    return { status: 400, body: reject(error.code || 'invalid_tool_request', 'validation', {
      path: error.path || '$',
      fieldMessage: error.message,
    }) };
  }
  try {
    const result = await operation(modelInput, {
      tenantId: clientSlug,
      authenticated: true,
      sessionId: boundSession.sessionId,
      principalId: authenticatedPrincipal.principalId,
      writeAllowed: authenticatedPrincipal.writeAllowed === true && boundSession.writeAllowed === true,
      guestPhone: boundSession.guestPhone || null,
      turnId: String(authenticatedPrincipal.turnId || '').trim() || null,
      authenticatedInboundEventId: inboundEventId || null,
      trustedPresentationRecorder: tool === '_record_offer_presentation',
    });
    const status = result && result.ok === false ? (result.status || 422) : 200;
    const body = result && result.ok === false
      ? { ...result, ...reject(result.code || result.reason || 'staff_operation_refused', result.classification || 'validation', result) }
      : result;
    return { status, body };
  } catch (error) {
    const status = Number.isInteger(error && error.status) ? error.status
      : Number.isInteger(error && error.httpStatus) ? error.httpStatus : 500;
    return { status, body: reject(error.code || (status === 403 ? 'write_admission_denied' : 'luna_v3_operation_failed'), status === 403 ? 'authorization' : 'internal') };
  }
}

module.exports = { LUNA_V3_ROUTE_TO_TOOL, dispatchLunaV3StaffRoute };
