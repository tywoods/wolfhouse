'use strict';

const TOOL_CONTRACTS = Object.freeze({
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
  'tenant_id', 'staff_api_base_url', 'destination', 'recipient_phone', 'provider_mode',
  'external_send_allowed', 'staff_alert_allowed', 'silently_relax_together', 'auto_assign',
  'send_whatsapp', 'send_sms', 'send_email',
]);

const READ_SCHEMAS = Object.freeze({
  check_availability: new Set(['check_in', 'check_out', 'party_size', 'room_type', 'room_preference', 'keep_together', 'group_gender', 'guests']),
  find_rooms: new Set(['check_in', 'check_out', 'party_size', 'preferences']),
  get_pricing_catalog: new Set(['check_in', 'check_out', 'package_ids', 'service_ids']),
  quote: new Set(['operation_key', 'check_in', 'check_out', 'guests', 'selection', 'guest_packages', 'package_id', 'add_ons']),
  hold_beds: new Set(['operation_key', 'check_in', 'check_out', 'guests', 'assignments', 'quoted_selection']),
  book: new Set(['operation_key', 'hold_id']),
  get_booking: new Set(['booking_id']),
  recover_operation: new Set(['operation_key']),
  release_hold: new Set(['operation_key', 'hold_id']),
  handoff_to_human: new Set(['operation_key', 'reason', 'context', 'booking_id', 'conversation_id']),
});
const NESTED_SCHEMAS = Object.freeze({
  guests: new Set(['name', 'explicit_gender']),
  preferences: new Set(['room_type', 'room_preference', 'keep_together', 'group_gender', 'guests']),
  selection: new Set(['room_id', 'bed_ids', 'selected_bed_codes', 'room_type', 'room_preference', 'keep_together']),
  guest_packages: new Set(['guest_number', 'package_code']),
  add_ons: new Set(['code', 'days', 'quantity']),
  assignments: new Set(['bed_code', 'guest_name', 'package_code']),
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
  if (contract.write && !String(input.operation_key || '').trim()) throw new Error(`operation_key is required for ${name}`);
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
