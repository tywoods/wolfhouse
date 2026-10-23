'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LUNA_V3_ROUTE_TO_TOOL,
  dispatchLunaV3StaffRoute,
} = require('./staff-routes');

async function main() {
  assert.strictEqual(Object.keys(LUNA_V3_ROUTE_TO_TOOL).length, 16);
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/check-availability'], 'check_availability');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/handoff'], 'handoff_to_human');
  assert.strictEqual(LUNA_V3_ROUTE_TO_TOOL['/staff/bot/luna-v3/recover-operation'], 'recover_operation');

  const seen = [];
  const response = await dispatchLunaV3StaffRoute({
    pathname: '/staff/bot/luna-v3/quote',
    method: 'POST',
    clientSlug: 'wolfhouse-somo',
    body: {
      tenant_id: 'wolfhouse-somo',
      session_id: 'luna-v3:test-phone-hash',
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
    body: { session_id: 'luna-v3:x', external_send_allowed: false, staff_alert_allowed: false }, operations: {},
  });
  assert.strictEqual(missing.status, 503);
  assert.strictEqual(missing.body.code, 'luna_v3_tool_not_registered');

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
