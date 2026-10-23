'use strict';

const TOOL_CONTRACTS = Object.freeze({
  check_availability: { method: 'POST', path: '/staff/bot/luna-v3/check-availability', write: false },
  find_rooms: { method: 'POST', path: '/staff/bot/luna-v3/find-rooms', write: false },
  get_pricing_catalog: { method: 'POST', path: '/staff/bot/luna-v3/pricing-catalog', write: false },
  quote: { method: 'POST', path: '/staff/bot/luna-v3/quote', write: false },
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
});

const FORBIDDEN_INPUTS = new Set([
  'amount', 'amount_cents', 'deposit_cents', 'total_cents', 'remaining_cents',
  'tenant_id', 'staff_api_base_url', 'destination', 'recipient_phone', 'provider_mode',
  'external_send_allowed', 'staff_alert_allowed', 'silently_relax_together', 'auto_assign',
  'send_whatsapp', 'send_sms', 'send_email',
]);

function assertSafeToolRequest(name, input = {}) {
  const contract = TOOL_CONTRACTS[name];
  if (!contract) throw new Error(`unknown Luna v3 tool: ${name}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('tool arguments must be an object');
  const visit = (value, path = 'input') => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_INPUTS.has(key)) {
        throw new Error(`model-supplied authority field is forbidden: ${path}.${key}`);
      }
      visit(item, `${path}.${key}`);
    }
  };
  visit(input);
  if (contract.write && !String(input.operation_key || '').trim()) {
    throw new Error(`operation_key is required for ${name}`);
  }
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
