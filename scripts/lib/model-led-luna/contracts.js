'use strict';

const TOOL_CONTRACTS = Object.freeze({
  check_quote_book: { method: 'POST', path: '/staff/bot/luna-v3/check-quote-book', write: true },
  check_availability: { method: 'POST', path: '/staff/bot/luna-v3/check-availability', write: false },
  find_rooms: { method: 'POST', path: '/staff/bot/luna-v3/find-rooms', write: false },
  get_pricing_catalog: { method: 'POST', path: '/staff/bot/luna-v3/pricing-catalog', write: false },
  // quote persists the exact agreed selection, so it requires durable write admission.
  quote: { method: 'POST', path: '/staff/bot/luna-v3/quote', write: true },
  hold_beds: { method: 'POST', path: '/staff/bot/luna-v3/hold-beds', write: true },
  book: { method: 'POST', path: '/staff/bot/luna-v3/book', write: true },
  release_hold: { method: 'POST', path: '/staff/bot/luna-v3/release-hold', write: true },
  get_booking: { method: 'POST', path: '/staff/bot/luna-v3/get-booking', write: false },
  get_payment_status: { method: 'POST', path: '/staff/bot/luna-v3/payment-status', write: false },
  send_payment_link: { method: 'POST', path: '/staff/bot/luna-v3/payment-link', write: true },
  cancel_unpaid: { method: 'POST', path: '/staff/bot/luna-v3/cancel-unpaid', write: true },
  read_notes: { method: 'POST', path: '/staff/bot/luna-v3/notes/read', write: false },
  write_note: { method: 'POST', path: '/staff/bot/luna-v3/notes/write', write: true },
  save_transfer_request: { method: 'POST', path: '/staff/bot/luna-v3/transfer-request', write: true },
  handoff_to_human: { method: 'POST', path: '/staff/bot/luna-v3/handoff', write: true },
  recover_operation: { method: 'POST', path: '/staff/bot/luna-v3/recover-operation', write: false },
});

const FORBIDDEN_INPUTS = new Set([
  'amount', 'amount_cents', 'deposit_cents', 'total_cents', 'remaining_cents',
  'totalCents', 'depositCents', 'remainingCents', 'balanceDueCents',
  'tenant_id', 'staff_api_base_url', 'destination', 'recipient_phone', 'provider_mode', 'currency',
  'external_send_allowed', 'staff_alert_allowed', 'silently_relax_together', 'auto_assign',
  'send_whatsapp', 'send_sms', 'send_email',
]);

const READ_SCHEMAS = Object.freeze({
  check_quote_book: new Set(['action', 'purpose', 'check_in', 'check_out', 'guests', 'room', 'package', 'add_ons', 'payment', 'offer_reference']),
  check_availability: new Set(['check_in', 'check_out', 'party_size', 'room_type', 'room_preference', 'keep_together', 'group_gender', 'guests']),
  find_rooms: new Set(['check_in', 'check_out', 'party_size', 'preferences']),
  get_pricing_catalog: new Set(['check_in', 'check_out', 'package_ids', 'service_ids']),
  quote: new Set(['operation_key', 'check_in', 'check_out', 'guests', 'selection', 'guest_packages', 'package_id', 'add_ons']),
  hold_beds: new Set(['operation_key', 'check_in', 'check_out', 'guests', 'assignments', 'quoted_selection']),
  book: new Set(['operation_key', 'hold_id']),
  get_booking: new Set(['booking_id']),
  recover_operation: new Set(['tool', 'operation_key']),
  release_hold: new Set(['operation_key', 'hold_id']),
  handoff_to_human: new Set(['operation_key', 'reason', 'context', 'booking_id', 'conversation_id']),
  get_payment_status: new Set(['booking_reference']),
  send_payment_link: new Set(['booking_reference', 'payment_scope', 'payment_choice', 'guest_position', 'operation_key']),
  cancel_unpaid: new Set(['booking_reference', 'guest_reason', 'operation_key']),
  read_notes: new Set(['topic', 'booking_reference']),
  write_note: new Set(['text', 'context', 'booking_reference', 'operation_key']),
  save_transfer_request: new Set(['booking_reference', 'decision', 'travel_details', 'operation_key']),
});
const NESTED_SCHEMAS = Object.freeze({
  guests: new Set(['name', 'explicit_gender', 'gender']),
  preferences: new Set(['room_type', 'room_preference', 'keep_together', 'group_gender', 'guests']),
  selection: new Set(['room_id', 'bed_ids', 'selected_bed_codes', 'room_type', 'room_preference', 'keep_together']),
  guest_packages: new Set(['guest_number', 'package_code']),
  add_ons: new Set(['code', 'name', 'days', 'quantity', 'dates', 'requested_dates', 'people']),
  assignments: new Set(['bed_code', 'guest_name', 'package_code']),
  context: new Set(['topic', 'kind', 'detail']),
  travel_details: new Set(['airport', 'direction', 'date', 'time', 'flight', 'passengers', 'boards']),
  room: new Set(['kind', 'name', 'beds', 'together']),
  package: new Set(['name', 'per_guest']),
  per_guest: new Set(['guest', 'name']),
  payment: new Set(['arrangement', 'choice']),
});

function assertKnownObject(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_INPUTS.has(key)) throw new Error(`model-supplied authority field is forbidden: ${path}.${key}`);
    if (!allowed.has(key)) throw new Error(`unknown field: ${path}.${key}`);
    const nested = NESTED_SCHEMAS[key];
    if (nested) {
      const rows = Array.isArray(item) ? item : [item];
      rows.forEach((row, index) => assertKnownObject(row, nested, `${path}.${key}${Array.isArray(item) ? `[${index}]` : ''}`));
    }
  }
}

function assertSafeToolRequest(name, input = {}) {
  const contract = TOOL_CONTRACTS[name];
  if (!contract) throw new Error(`unknown Luna v3 tool: ${name}`);
  const schema = READ_SCHEMAS[name];
  if (schema) assertKnownObject(input, schema, 'input');
  else {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tool arguments must be an object');
    const visit = (value, path = 'input') => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_INPUTS.has(key)) throw new Error(`model-supplied authority field is forbidden: ${path}.${key}`);
        visit(item, `${path}.${key}`);
      }
    };
    visit(input);
  }
  if (contract.write && name !== 'check_quote_book' && !String(input.operation_key || '').trim()) throw new Error(`operation_key is required for ${name}`);
  if (name === 'check_quote_book') {
    if (!['prepare', 'confirm', 'decline'].includes(input.action)) throw new Error('action must be prepare, confirm, or decline');
    if (input.action === 'prepare') {
      if (!['catalog', 'quote', 'offer'].includes(input.purpose)) throw new Error('purpose must be catalog, quote, or offer');
      if (!input.check_in || !input.check_out) throw new Error('check_in and check_out are required for prepare');
      if (input.purpose === 'quote' || input.purpose === 'offer') {
        if (!Array.isArray(input.guests) || input.guests.length === 0) throw new Error('guests are required for quote or offer prepare');
        if (!input.room || !input.package) throw new Error('room and package are required for quote or offer prepare');
        if (input.guests.length > 1 && (!input.payment || !['together', 'separately'].includes(input.payment.arrangement))) throw new Error('group payment arrangement is required');
        if (!Array.isArray(input.add_ons) || !input.payment) throw new Error('add_ons and payment are required for quote or offer prepare');
      }
    } else {
      if (!/^offer_[A-Za-z0-9_-]{24,80}$/.test(String(input.offer_reference || ''))) throw new Error('valid public offer_reference is required');
      const changed = Object.keys(input).filter((key) => !['action', 'offer_reference'].includes(key));
      if (changed.length) throw new Error('confirm or decline cannot change prepared offer terms');
    }

  }
  if (name === 'recover_operation' && (!String(input.tool || '').trim() || !String(input.operation_key || '').trim())) throw new Error('tool and operation_key are required for recover_operation');
  if (name === 'hold_beds') {
    if (typeof input.quoted_selection !== 'string' || !input.quoted_selection.trim()) throw new Error('quoted_selection must be a nonempty string');
    if (!Array.isArray(input.guests) || !Array.isArray(input.assignments) || input.assignments.length === 0
        || input.assignments.length !== input.guests.length) throw new Error('hold assignments must match ordered guests');
    input.assignments.forEach((assignment, index) => {
      if (!assignment || !['bed_code', 'guest_name', 'package_code'].every((field) => typeof assignment[field] === 'string' && assignment[field].trim())) {
        throw new Error('hold assignments require bed_code, guest_name, and package_code');
      }
      if (assignment.guest_name !== input.guests[index].name) throw new Error('hold assignments must match ordered guests');
    });
  }
  if (name === 'get_pricing_catalog') {
    for (const field of ['package_ids', 'service_ids']) {
      if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].some((value) => typeof value !== 'string' || !value.trim()))) {
        throw new Error(`${field} must be an array of strings`);
      }
    }
  }
  if (name === 'send_payment_link') {
    if (!['deposit', 'full', 'balance'].includes(input.payment_choice)) throw new Error('payment_choice must be deposit, full, or balance');
    if (typeof input.booking_reference !== 'string' || !input.booking_reference.trim()) throw new Error('booking_reference is required');
    if (input.payment_scope !== undefined && !['individual', 'booking'].includes(input.payment_scope)) throw new Error('payment_scope must be individual or booking');
    const scope = input.payment_scope || (input.guest_position ? 'individual' : null);
    if (!scope) throw new Error('payment_scope is required when guest_position is absent');
    if (scope === 'individual' && (!Number.isSafeInteger(input.guest_position) || input.guest_position < 1)) throw new Error('guest_position must be a positive integer for individual checkout');
    if (scope === 'booking' && input.guest_position !== undefined) throw new Error('guest_position is forbidden for booking checkout');
  }
  if (['get_payment_status', 'cancel_unpaid'].includes(name)
      && (typeof input.booking_reference !== 'string' || !input.booking_reference.trim())) throw new Error('booking_reference is required');
  return contract;
}

function buildStaffToolRequest(name, input, runtime) {
  const contract = assertSafeToolRequest(name, input);
  const baseUrl = String(runtime.baseUrl || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new Error('Luna v3 Staff base URL must be HTTPS');
  if (!runtime.token) throw new Error('Luna v3 Staff token is required');
  if (runtime.tenantId !== 'wolfhouse-somo') throw new Error('Luna v3 tenant must be wolfhouse-somo');
  if (!runtime.sessionId) throw new Error('Luna v3 session is required');
  return {
    method: contract.method,
    url: `${baseUrl}${contract.path}`,
    headers: { 'Content-Type': 'application/json', Authorization: ['Be', 'arer ', runtime.token].join('') },
    body: {
      ...input,
      tenant_id: runtime.tenantId,
      session_id: runtime.sessionId,
      external_send_allowed: false,
      staff_alert_allowed: false,
    },
  };
}

module.exports = { TOOL_CONTRACTS, assertSafeToolRequest, buildStaffToolRequest };
