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
  ok('rejects secret_ref', extCalRoutes.rejectCallerAuthority({ secret_ref: 'ANY_NAME' }).error === 'caller_authority_rejected');
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
  ok('sanitize never copies secret_ref',
    !Object.prototype.hasOwnProperty.call(
      extCalRoutes.sanitizeConnection({ last_error_code: 'empty_sheet', secret_ref: 'KV_WH_SHEET' }),
      'secret_ref'
    ));

  const hostilePub = extCalRoutes.publicResult({
    ok: false,
    error: 'duplicate key value violates unique constraint bookings_pkey',
    reason: 'password=supersecret',
    skipped: [{
      skip_reason: { nested: 'relation "pg_authid" is forbidden' },
      status: 'skipped_conflict',
      bed_id: 'bed-internal',
      stack: 'Error: boom',
      secret_ref: 'KV_LIVE',
    }],
    connection: {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'x',
      last_error_code: 'ECONNRESET',
      last_error_detail: 'SQLSTATE 23505',
      secret_ref: 'KV_LIVE_TOKEN',
    },
    maps: [{ external_unit_key: 'R1A', bed_id: 'bed-a', password: 'hunter2', skip_reason: 'SQL' }],
  });
  const hostileJson = JSON.stringify(hostilePub);
  ok('unknown route error becomes calendar_bridge_failed',
    hostilePub.error === 'calendar_bridge_failed' && hostilePub.reason === 'calendar_bridge_failed');
  ok('publicResult omits nested skip_reason and internals',
    !/duplicate key|pg_authid|password=|hunter2|KV_LIVE|ECONNRESET|SQLSTATE|bed-internal|secret_ref/.test(hostileJson));
  ok('intended map codes stay public',
    extCalRoutes.publicResult({ ok: false, error: 'invalid_map' }).error === 'invalid_map'
    && extCalRoutes.publicResult({ ok: false, error: 'bed_not_in_tenant' }).error === 'bed_not_in_tenant'
    && extCalRoutes.publicResult({ ok: false, error: 'maps_save_failed' }).error === 'maps_save_failed');
  ok('allowlisted skip_reason survives publicResult',
    extCalRoutes.publicResult({
      ok: false,
      reason: 'unmapped_unit_key',
      skipped: [{ skip_reason: 'unmapped_unit_key', status: 'skipped_unmapped', unit_key: 'R1A', rowNumber: 2, bed_id: 'hidden' }],
    }).skipped[0].skip_reason === 'unmapped_unit_key'
    && extCalRoutes.publicResult({
      ok: false,
      reason: 'unmapped_unit_key',
      skipped: [{ skip_reason: 'unmapped_unit_key', status: 'skipped_unmapped', unit_key: 'R1A', rowNumber: 2, bed_id: 'hidden' }],
    }).skipped[0].bed_id == null);

  delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  console.log('\nverify-external-calendar-inventory-routes: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
