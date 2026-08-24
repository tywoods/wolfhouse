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
          if (pg.failDeleteBeds) throw new Error('injected delete beds');
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
  const bedSql = ((okState.deletedBedsSql || [])[0] && okState.deletedBedsSql[0].sql) || '';
  const bookingSql = (okState.deletedBookingSql[0] && okState.deletedBookingSql[0].sql) || '';
  ok('owned bed delete is scoped to external_inventory_block', /external_inventory_block/.test(bedSql));
  ok('owned bed delete matches this connection_id metadata',
    /external_calendar/.test(bedSql) && /connection_id/.test(bedSql));
  ok('owned bed delete stays on tenant client_id', /client_id/.test(bedSql));
  ok('owned bed delete does not target staff_block/operator_block',
    !/staff_block/.test(bedSql) && !/operator_block/.test(bedSql));
  ok('owned parent delete is tenant + metadata + empty remaining beds',
    /external_calendar/.test(bookingSql) && /connection_id/.test(bookingSql)
    && /client_id/.test(bookingSql) && /NOT EXISTS/i.test(bookingSql)
    && !/external_inventory_block/.test(bookingSql)
    && !/staff_block/.test(bookingSql) && !/operator_block/.test(bookingSql));
  ok('connection row deleted after owned beds and bookings',
    okState.deletedConnectionSql.length === 1
    && okState.queries.findIndex((q) => /DELETE FROM booking_beds/.test(q.sql))
      < okState.queries.findIndex((q) => /DELETE FROM bookings/.test(q.sql))
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

  function parentConnId(booking) {
    const meta = booking.metadata && booking.metadata.external_calendar;
    return meta ? String(meta.connection_id || '') : '';
  }

  function semanticDeletePg(init) {
    const pg = deletePg(init);
    pg.deletedBedIds = [];
    pg.deletedBookingIds = [];
    pg.cascadedBedIds = [];
    const origQuery = pg.query.bind(pg);
    pg.query = async function query(sql, params) {
      const text = String(sql);
      const result = await origQuery(sql, params);
      if (!pg.store) return result;
      if (/DELETE FROM booking_beds/.test(text)) {
        const clientId = params[0];
        const connId = String(params[1]);
        const scoped = /external_inventory_block/.test(text)
          && /connection_id/.test(text)
          && /client_id/.test(text)
          && !/staff_block/.test(text)
          && !/operator_block/.test(text)
          && !/private_room_block/.test(text);
        pg.store.beds = pg.store.beds.filter((bed) => {
          if (bed.client_id !== clientId) return true;
          if (!scoped) {
            pg.deletedBedIds.push(bed.id);
            return false;
          }
          if (bed.assignment_type !== 'external_inventory_block') return true;
          const parent = pg.store.bookings.find((b) => b.id === bed.booking_id);
          if (!parent || parentConnId(parent) !== connId) return true;
          pg.deletedBedIds.push(bed.id);
          return false;
        });
        return { rows: pg.deletedBedIds.map((id) => ({ id })) };
      }
      if (/DELETE FROM bookings/.test(text)) {
        const clientId = params[0];
        const connId = String(params[1]);
        const emptyOnly = /NOT EXISTS/i.test(text);
        const metadataScoped = /external_calendar/.test(text) && /connection_id/.test(text) && /client_id/.test(text);
        const deletedIds = [];
        pg.store.bookings = pg.store.bookings.filter((bk) => {
          if (bk.client_id !== clientId) return true;
          if (!metadataScoped || parentConnId(bk) !== connId) return true;
          if (emptyOnly) {
            const remaining = pg.store.beds.filter((b) => b.booking_id === bk.id);
            if (remaining.length) return true;
          }
          deletedIds.push(bk.id);
          return false;
        });
        pg.deletedBookingIds = pg.deletedBookingIds.concat(deletedIds);
        const gone = Object.create(null);
        deletedIds.forEach((id) => { gone[id] = true; });
        pg.store.beds = pg.store.beds.filter((bed) => {
          if (gone[bed.booking_id]) {
            pg.cascadedBedIds.push(bed.id);
            return false;
          }
          return true;
        });
        return { rows: deletedIds.map((id) => ({ id })) };
      }
      return result;
    };
    return pg;
  }

  const mixedStore = {
    bookings: [
      {
        id: 'mixed-parent',
        client_id: CLIENT_ID,
        metadata: { external_calendar: { connection_id: CONN_ID } },
      },
      {
        id: 'pure-owned',
        client_id: CLIENT_ID,
        metadata: { external_calendar: { connection_id: CONN_ID } },
      },
      {
        id: 'guest-parent',
        client_id: CLIENT_ID,
        metadata: {},
      },
      {
        id: 'other-conn-parent',
        client_id: CLIENT_ID,
        metadata: { external_calendar: { connection_id: OTHER_CONN } },
      },
      {
        id: 'protected-parent',
        client_id: CLIENT_ID,
        metadata: {},
      },
    ],
    beds: [
      { id: 'bb-owned-mixed', booking_id: 'mixed-parent', client_id: CLIENT_ID, assignment_type: 'external_inventory_block' },
      { id: 'bb-guest-mixed', booking_id: 'mixed-parent', client_id: CLIENT_ID, assignment_type: 'manual' },
      { id: 'bb-staff-mixed', booking_id: 'mixed-parent', client_id: CLIENT_ID, assignment_type: 'staff_block' },
      { id: 'bb-protected-mixed', booking_id: 'mixed-parent', client_id: CLIENT_ID, assignment_type: 'operator_block' },
      { id: 'bb-pure', booking_id: 'pure-owned', client_id: CLIENT_ID, assignment_type: 'external_inventory_block' },
      { id: 'bb-guest', booking_id: 'guest-parent', client_id: CLIENT_ID, assignment_type: 'manual' },
      { id: 'bb-other', booking_id: 'other-conn-parent', client_id: CLIENT_ID, assignment_type: 'external_inventory_block' },
      { id: 'bb-protected', booking_id: 'protected-parent', client_id: CLIENT_ID, assignment_type: 'private_room_block' },
    ],
  };
  const mixedState = semanticDeletePg({
    connection: {
      id: CONN_ID, client_id: CLIENT_ID, name: 'Owner schedule · SHEETA',
      status: 'disabled',
    },
    store: mixedStore,
  });
  const mixedRemoved = await extCalRoutes.handleDelete(
    mixedState, 'wolfhouse-somo', CONN_ID, { confirm_name: 'Owner schedule · SHEETA' }
  );
  const mixedIds = (id) => mixedState.store.beds.some((b) => b.id === id);
  const mixedParents = (id) => mixedState.store.bookings.some((b) => b.id === id);
  ok('mixed-booking delete succeeds in one transaction',
    mixedRemoved.ok === true && mixedState.begins === 1 && mixedState.commits === 1 && mixedState.rollbacks === 0);
  ok('mixed-booking delete removes only this connection owned bed rows',
    mixedIds('bb-owned-mixed') === false && mixedIds('bb-pure') === false);
  ok('mixed-booking delete preserves guest/staff/protected beds on the mixed parent',
    mixedIds('bb-guest-mixed') === true
    && mixedIds('bb-staff-mixed') === true
    && mixedIds('bb-protected-mixed') === true);
  ok('mixed-booking delete keeps the mixed parent because assignments remain',
    mixedParents('mixed-parent') === true);
  ok('mixed-booking delete removes empty connection-owned parent',
    mixedParents('pure-owned') === false);
  ok('mixed-booking delete preserves guest, other-connection, and protected parents',
    mixedParents('guest-parent') === true
    && mixedParents('other-conn-parent') === true
    && mixedParents('protected-parent') === true
    && mixedIds('bb-guest') === true
    && mixedIds('bb-other') === true
    && mixedIds('bb-protected') === true);
  ok('mixed-booking delete never cascades remaining assignments',
    mixedState.cascadedBedIds.length === 0);
  const mixedBedSql = ((mixedState.deletedBedsSql || [])[0] && mixedState.deletedBedsSql[0].sql) || '';
  const mixedBookingSql = ((mixedState.deletedBookingSql || [])[0] && mixedState.deletedBookingSql[0].sql) || '';
  ok('bed delete happens before parent delete',
    mixedState.queries.findIndex((q) => /DELETE FROM booking_beds/.test(q.sql))
      < mixedState.queries.findIndex((q) => /DELETE FROM bookings/.test(q.sql)));
  ok('bed delete is tenant + assignment_type + connection metadata scoped',
    /external_inventory_block/.test(mixedBedSql)
    && /connection_id/.test(mixedBedSql)
    && /client_id/.test(mixedBedSql));
  ok('parent delete is tenant + metadata + empty remaining beds',
    /connection_id/.test(mixedBookingSql)
    && /client_id/.test(mixedBookingSql)
    && /NOT EXISTS/i.test(mixedBookingSql));

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
