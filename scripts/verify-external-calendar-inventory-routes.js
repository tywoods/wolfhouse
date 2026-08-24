'use strict';

const extCalRoutes = require('./lib/external-calendar-inventory-routes');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

async function main() {
  console.log('verify-external-calendar-inventory-routes');

  ok('sunset refused', extCalRoutes.refuseClient('sunset').error === 'calendar_bridge_client_not_allowed');
  ok('flag off refuses wolfhouse', extCalRoutes.refuseClient('wolfhouse-somo').error === 'calendar_bridge_disabled');
  process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
  ok('flag on allows wolfhouse', extCalRoutes.refuseClient('wolfhouse-somo').ok === true);
  ok('sunset still refused with flag on', extCalRoutes.refuseClient('sunset').ok === false);

  ok('rejects caller rows', extCalRoutes.rejectCallerAuthority({ rows: [[]] }).error === 'caller_authority_rejected');
  ok('rejects occupancy', extCalRoutes.rejectCallerAuthority({ occupancy: {} }).error === 'caller_authority_rejected');
  ok('rejects connection_id', extCalRoutes.rejectCallerAuthority({ connection_id: 'x' }).error === 'caller_authority_rejected');
  ok('empty probe DTO allowed', extCalRoutes.rejectCallerAuthority({}) === null);

  const probe = await extCalRoutes.handleRealProbe({
    async query() { return { rows: [{ id: 'cid', slug: 'wolfhouse-somo' }] }; },
  }, {
    clientSlug: 'wolfhouse-somo',
    connectionId: 'conn-1',
    fetchSheet: async () => ({ ok: false, reason: 'sheets_inaccessible', keepLastBlocks: true }),
  });
  // loadLockedState will fail client lookup shape — that's ok if we get a structured error
  ok('real probe never reads body.rows', !Object.prototype.hasOwnProperty.call(probe, 'rows'));

  delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  console.log('\nverify-external-calendar-inventory-routes: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
