'use strict';

// Pure audit-tagging seam for the Luna Supervisor account. Deckhand owns route
// admission and supervisor_events persistence; callers must pass that already-
// authenticated actor and the configured, immutable supervisor staff-user ID.

const BUSINESS_ACTIONS = new Set([
  'booking_create', 'booking_edit', 'booking_move', 'payment_link_generate',
  'add_on_record', 'booking_cancel_unpaid', 'guest_message_send',
  'needs_human_set', 'booking_readback',
]);
const LIFECYCLE_STATES = new Set([
  'claim_rejected', 'stayed_out', 'stopped_expired', 'stopped_halted',
  'ty_report_failed',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOOKING_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function requiredUuid(value, code) {
  const result = String(value || '').trim();
  if (!UUID_RE.test(result)) throw new Error(code);
  return result;
}
function optionalUuid(value, code) {
  if (value == null || value === '') return undefined;
  return requiredUuid(value, code);
}
function requireSupervisorActor(actor, supervisorStaffUserId) {
  if (!actor || typeof actor !== 'object') throw new Error('supervisor_actor_required');
  const actual = requiredUuid(actor.staff_user_id, 'supervisor_actor_id_invalid');
  const expected = requiredUuid(supervisorStaffUserId, 'supervisor_configured_actor_id_invalid');
  if (actual !== expected) throw new Error('supervisor_actor_mismatch');
  if (String(actor.role || '').toLowerCase() !== 'admin') throw new Error('supervisor_actor_not_admin');
  const clientSlug = String(actor.client_slug || '').trim();
  if (!clientSlug) throw new Error('supervisor_actor_client_required');
  return { staffUserId: actual, clientSlug };
}
function optionalBookingRef(value) {
  if (value == null || value === '') return undefined;
  const result = String(value).trim();
  if (!BOOKING_REF_RE.test(result)) throw new Error('supervisor_booking_ref_invalid');
  return result;
}
function clean(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}
function buildSupervisorBusinessAuditEntry({ actor, supervisorStaffUserId, action, incidentId, conversationId, bookingRef } = {}) {
  const identity = requireSupervisorActor(actor, supervisorStaffUserId);
  if (!BUSINESS_ACTIONS.has(action)) throw new Error('supervisor_business_action_invalid');
  return clean({
    intent: `action:supervisor:${action}`,
    category: 'luna_supervisor',
    supervisor: true,
    staff_user_id: identity.staffUserId,
    client_slug: identity.clientSlug,
    incident_id: optionalUuid(incidentId, 'supervisor_incident_id_invalid'),
    conversation_id: optionalUuid(conversationId, 'supervisor_conversation_id_invalid'),
    booking_ref: optionalBookingRef(bookingRef),
  });
}
function buildSupervisorLifecycleAuditEntry({ actor, supervisorStaffUserId, lifecycle, eventId, incidentId, conversationId, bookingRef } = {}) {
  const identity = requireSupervisorActor(actor, supervisorStaffUserId);
  if (!LIFECYCLE_STATES.has(lifecycle)) throw new Error('supervisor_lifecycle_invalid');
  return clean({
    intent: `lifecycle:supervisor:${lifecycle}`,
    category: 'luna_supervisor_lifecycle',
    supervisor: true,
    lifecycle: true,
    staff_user_id: identity.staffUserId,
    client_slug: identity.clientSlug,
    event_id: optionalUuid(eventId, 'supervisor_event_id_invalid'),
    incident_id: optionalUuid(incidentId, 'supervisor_incident_id_invalid'),
    conversation_id: optionalUuid(conversationId, 'supervisor_conversation_id_invalid'),
    booking_ref: optionalBookingRef(bookingRef),
  });
}
function appendSupervisorBusinessAuditLog({ appendAuditLog, ...args } = {}) {
  if (typeof appendAuditLog !== 'function') throw new Error('supervisor_audit_sink_required');
  const entry = buildSupervisorBusinessAuditEntry(args);
  appendAuditLog(entry);
  return entry;
}
function appendSupervisorLifecycleAuditLog({ appendAuditLog, ...args } = {}) {
  if (typeof appendAuditLog !== 'function') throw new Error('supervisor_audit_sink_required');
  const entry = buildSupervisorLifecycleAuditEntry(args);
  appendAuditLog(entry);
  return entry;
}
module.exports = Object.freeze({
  BUSINESS_ACTIONS, LIFECYCLE_STATES,
  buildSupervisorBusinessAuditEntry, buildSupervisorLifecycleAuditEntry,
  appendSupervisorBusinessAuditLog, appendSupervisorLifecycleAuditLog,
});
