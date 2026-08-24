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

  ok('handleDelete exported', typeof extCalRoutes.handleDelete === 'function');

  const CONN_ID = '11111111-1111-1111-1111-111111111111';
  const OTHER_CONN = '22222222-2222-2222-2222-222222222222';
  const CLIENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function deletePg(init) {
    const pg = Object.assign({
      queries: [],
      begins: 0,
      commits: 0,
      rollbacks: 0,
      deletedBookingSql: [],
      deletedConnectionSql: [],
      ownedBookingIds: [],
      async query(sql, params) {
        const text = String(sql);
        pg.queries.push({ sql: text, params });
        if (/^\s*BEGIN/i.test(text)) { pg.begins += 1; return { rows: [] }; }
        if (/^\s*COMMIT/i.test(text)) { pg.commits += 1; return { rows: [] }; }
        if (/^\s*ROLLBACK/i.test(text)) { pg.rollbacks += 1; return { rows: [] }; }
        if (/FROM clients/.test(text)) {
          return { rows: pg.missingClient ? [] : [{ id: CLIENT_ID }] };
        }
        if (/FROM external_calendar_connections/.test(text) && /FOR UPDATE/.test(text)) {
          return { rows: pg.connection ? [pg.connection] : [] };
        }
        if (/DELETE FROM bookings/.test(text)) {
          pg.deletedBookingSql.push({ sql: text, params });
          if (pg.failDeleteBookings) throw new Error('injected delete bookings');
          return { rows: (pg.ownedBookingIds || []).map((id) => ({ id })) };
        }
        if (/DELETE FROM booking_beds/.test(text)) {
          pg.deletedBedsSql = (pg.deletedBedsSql || []).concat([{ sql: text, params }]);
          return { rows: [] };
        }
        if (/DELETE FROM external_calendar_connections/.test(text)) {
          pg.deletedConnectionSql.push({ sql: text, params });
          if (pg.connection && pg.connection.status !== 'disabled') return { rows: [] };
          return { rows: pg.connection ? [{ id: pg.connection.id }] : [] };
        }
        return { rows: [] };
      },
    }, init || {});
    return pg;
  }

  const missingDelete = await extCalRoutes.handleDelete(deletePg({}), 'wolfhouse-somo', '', { confirm_name: 'Owner schedule · SHEETA' });
  ok('delete without id is 400', missingDelete.error === 'connection_id_required' && missingDelete.status === 400);

  const missingConn = deletePg({});
  const notFound = await extCalRoutes.handleDelete(missingConn, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' });
  ok('delete unknown connection is 404', notFound.error === 'connection_not_found' && notFound.status === 404);
  ok('delete unknown connection does not delete bookings', (missingConn.deletedBookingSql || []).length === 0);

  const enabledState = deletePg({
    connection: {
      id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA',
      status: 'healthy', secret_ref: 'KV_LIVE', last_error_detail: 'SQLSTATE',
    },
  });
  const enabled = await extCalRoutes.handleDelete(enabledState, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' });
  ok('delete while On/enabled is refused', enabled.error === 'connection_not_disabled' && enabled.ok === false);
  ok('enabled delete does not touch bookings or connection',
    enabledState.deletedBookingSql.length === 0 && enabledState.deletedConnectionSql.length === 0
    && enabledState.rollbacks >= 1);

  const noConfirm = deletePg({
    connection: { id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA', status: 'disabled' },
  });
  const missingName = await extCalRoutes.handleDelete(noConfirm, 'wolfhouse-somo', CONN_ID, {});
  ok('delete requires confirm_name', missingName.error === 'confirm_name_required' && noConfirm.deletedConnectionSql.length === 0);

  const mismatchState = deletePg({
    connection: { id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA', status: 'disabled' },
  });
  const mismatch = await extCalRoutes.handleDelete(mismatchState, 'wolfhouse-somo', CONN_ID, { confirm_name: 'wrong' });
  ok('delete confirm_name must match connection',
    mismatch.error === 'confirm_name_mismatch' && mismatchState.deletedBookingSql.length === 0);

  const okState = deletePg({
    connection: {
      id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA',
      status: 'disabled', secret_ref: 'KV_LIVE_TOKEN',
    },
    ownedBookingIds: ['bk-owned'],
  });
  const removed = await extCalRoutes.handleDelete(okState, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' });
  ok('disabled delete succeeds', removed.ok === true && removed.deleted === true);
  ok('delete uses one transaction', okState.begins === 1 && okState.commits === 1 && okState.rollbacks === 0);
  const bookingSql = (okState.deletedBookingSql[0] && okState.deletedBookingSql[0].sql) || '';
  ok('owned booking delete is scoped to external_inventory_block', /external_inventory_block/.test(bookingSql));
  ok('owned booking delete matches this connection_id metadata',
    /external_calendar/.test(bookingSql) && /connection_id/.test(bookingSql));
  ok('owned booking delete stays on tenant client_id', /client_id/.test(bookingSql));
  ok('owned booking delete does not target staff_block/operator_block',
    !/staff_block/.test(bookingSql) && !/operator_block/.test(bookingSql));
  ok('connection row deleted after owned bookings',
    okState.deletedConnectionSql.length === 1
    && okState.queries.findIndex((q) => /DELETE FROM bookings/.test(q.sql))
      < okState.queries.findIndex((q) => /DELETE FROM external_calendar_connections/.test(q.sql)));
  const pubDel = extCalRoutes.publicResult(removed);
  const pubDelJson = JSON.stringify(pubDel);
  ok('delete DTO is sanitized',
    pubDel.ok === true && pubDel.deleted === true
    && !/secret_ref|KV_LIVE|SQLSTATE|password/.test(pubDelJson));

  const boomState = deletePg({
    connection: { id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA', status: 'disabled' },
    failDeleteBookings: true,
  });
  const boom = await extCalRoutes.handleDelete(boomState, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' });
  ok('delete write failure rolls back',
    boom.ok === false && boomState.rollbacks >= 1 && boomState.commits === 0
    && (boom.error === 'delete_failed' || boom.error === 'calendar_bridge_failed'));

  const otherTenant = deletePg({ missingClient: true });
  const cross = await extCalRoutes.handleDelete(otherTenant, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' });
  ok('delete unknown tenant is 404', cross.error === 'client_not_found');
  ok('cross-tenant delete issues no booking delete', (otherTenant.deletedBookingSql || []).length === 0);

  const otherConnBody = extCalRoutes.publicResult({
    ok: true,
    deleted: true,
    connection: { id: OTHER_CONN, secret_ref: 'KV_OTHER', last_error_detail: 'nope' },
  });
  ok('public delete result never copies secret_ref',
    !Object.prototype.hasOwnProperty.call(otherConnBody.connection || {}, 'secret_ref')
    && !Object.prototype.hasOwnProperty.call(otherConnBody.connection || {}, 'last_error_detail'));

  delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  console.log('\nverify-external-calendar-inventory-routes: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
