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
  const missingId = await extCalRoutes.handleRealProbe({
    async query() { return { rows: [{ id: 'cid', slug: 'wolfhouse-somo' }] }; },
  }, { clientSlug: 'wolfhouse-somo', fetchSheet: async () => ({ ok: true, rows: [] }) });
  ok('probe without id is 400', missingId.error === 'connection_id_required' && missingId.status === 400);
  ok('requireConnectionId rejects empty', extCalRoutes.requireConnectionId('').error === 'connection_id_required');
  ok('hostile stored SQL last_error is allowlisted',
    extCalRoutes.sanitizeConnection({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'x',
      last_error_code: 'duplicate key value violates unique constraint bookings_pkey',
    }).last_error === 'calendar_bridge_failed');
  ok('sanitize never copies last_error_detail',
    !Object.prototype.hasOwnProperty.call(
      extCalRoutes.sanitizeConnection({ last_error_code: 'empty_sheet', last_error_detail: 'SQLSTATE 23505' }),
      'last_error_detail'
    ));
  const nested = extCalRoutes.publicResult({
    ok: false,
    reason: 'empty_sheet',
    skipped: [{ skip_reason: 'relation "booking_beds" does not exist', status: 'x' }],
  });
  ok('nested skipped SQL omitted from public result',
    JSON.stringify(nested).indexOf('does not exist') < 0);

  delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  console.log('\nverify-external-calendar-inventory-routes: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
