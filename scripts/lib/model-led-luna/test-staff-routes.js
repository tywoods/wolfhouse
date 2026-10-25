'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LUNA_V3_ROUTE_TO_TOOL,
  dispatchLunaV3StaffRoute: rawDispatch,
} = require('./staff-routes');

const dispatchLunaV3StaffRoute = (args) => rawDispatch({
  authenticatedPrincipal: { principalId: 'test-principal', writeAllowed: true },
  resolveSession: async ({ selector, principalId }) => selector === 'luna-v3:test-phone-hash' && principalId === 'test-principal'
    ? { sessionId: selector, writeAllowed: true } : null,
  ...args,
});

async function main() {
  assert.strictEqual(Object.keys(LUNA_V3_ROUTE_TO_TOOL).length, 18);
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/check-availability'], 'check_availability');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/handoff'], 'handoff_to_human');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/recover-operation'], 'recover_operation');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/admit-simulator-session'], 'admit_simulator_session');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/record-offer-presentation'], '_record_offer_presentation');

  const admitted = [];
  const admission = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/admit-simulator-session',
    method: 'POST',
    clientSlug: 'wolfhouse-somo',
    body: {
      session_id: 'luna-v3:0123456789abcdef01234567',
      guest_phone: '+34699901234',
      message_digest: 'a'.repeat(64),
      external_send_allowed: false,
      staff_alert_allowed: false,
    },
    admitSimulatorSession: async (request) => {
      admitted.push(request);
      return { ok: true, admitted: true };
    },
  });
  assert.strictEqual(admission.status, 200);
  assert.deepStrictEqual(admitted, [{
    clientSlug: 'wolfhouse-somo',
    sessionId: 'luna-v3:0123456789abcdef01234567',
    guestPhone: '+34699901234',
    principalId: 'test-principal',
    messageDigest: 'a'.repeat(64),
  }]);

  for (const body of [
    { session_id: 'luna-v3:not-a-digest', guest_phone: '+34699901234', external_send_allowed: false, staff_alert_allowed: false },
    { session_id: 'luna-v3:0123456789abcdef01234567', guest_phone: '+34611111111', external_send_allowed: false, staff_alert_allowed: false },
  ]) {
    const rejected = await dispatchLunaV3StaffRoute({
      pathname: '/staff/bot/luna-v3/admit-simulator-session', method: 'POST', clientSlug: 'wolfhouse-somo', body,
      admitSimulatorSession: async () => { throw new Error('must not run'); },
    });
    assert.strictEqual(rejected.status, 403);
    assert.strictEqual(rejected.body.code, 'luna_v3_simulator_scope_forbidden');
  }

  const seen = [];
  const response = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/quote',
    method: 'POST',
    clientSlug: 'wolfhouse-somo',
    body: {
      client_slug: 'wolfhouse-somo',
      tenant_id: 'wolfhouse-somo',
      session_id: 'luna-v3:test-phone-hash',
      operation_key: 'quote-route-1',
      check_in: '2027-11-05',
      check_out: '2027-11-15',
      guests: [{ name: 'Guest A' }],
      selection: { room_id: 'room-7' },
      external_send_allowed: false,
      staff_alert_allowed: false,
    },
    operations: {
      quote: async (input, context) => {
        seen.push({ input, context });
        return { ok: true, source: 'staff_pricing', total_cents: 12345 };
      },
    },
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body.source, 'staff_pricing');
  assert.strictEqual(seen[0].context.tenantId, 'wolfhouse-somo');
  assert.strictEqual(seen[0].context.authenticated, true);
  assert.strictEqual(seen[0].input.client_slug, undefined);
  assert.strictEqual(seen[0].input.tenant_id, undefined);
  assert.strictEqual(seen[0].input.session_id, undefined);
  assert.strictEqual(seen[0].input.external_send_allowed, undefined);
  assert.strictEqual(seen[0].input.staff_alert_allowed, undefined);

  const wrongTenant = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/quote', method: 'POST', clientSlug: 'sunset', body: {}, operations: {},
  });
  assert.strictEqual(wrongTenant.status, 403);
  const sendsOn = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/quote', method: 'POST', clientSlug: 'wolfhouse-somo',
    body: { session_id: 'luna-v3:x', external_send_allowed: true, staff_alert_allowed: false }, operations: {},
  });
  assert.strictEqual(sendsOn.status, 403);
  const missing = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/hold-beds', method: 'POST', clientSlug: 'wolfhouse-somo',
    body: { session_id: 'luna-v3:test-phone-hash', external_send_allowed: false, staff_alert_allowed: false }, operations: {},
  });
  assert.strictEqual(missing.status, 503);
  assert.strictEqual(missing.body.code, 'luna_v3_tool_not_registered');

  const preserved = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/payment-status', method: 'POST', clientSlug: 'wolfhouse-somo',
    body: { session_id: 'luna-v3:test-phone-hash', booking_reference: 'WH-1', external_send_allowed: false, staff_alert_allowed: false },
    authenticatedPrincipal: { principalId: 'test-principal', writeAllowed: true, turnId: 'route-correlation' },
    operations: { get_payment_status: async () => ({ ok: false, code: 'postgres_price_missing', classification: 'internal',
      next_step: 'wait_for_staff_price_configuration', correlation_id: null }) },
  });
  assert.strictEqual(preserved.body.classification, 'internal');
  assert.strictEqual(preserved.body.correlation_id, 'route-correlation');
  assert.strictEqual(preserved.body.next_step, 'wait_for_staff_price_configuration');

  const staffSource = fs.readFileSync(path.join(__dirname, '..', '..', 'staff-query-api.js'), 'utf8');
  assert(staffSource.includes("require('./lib/model-led-luna/staff-routes')"));
  assert(staffSource.includes('dispatchLunaV3StaffRoute({'));
  assert(staffSource.includes('LUNA_V3_STAFF_OPERATIONS'));
  console.log('model-led-luna route registration tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
