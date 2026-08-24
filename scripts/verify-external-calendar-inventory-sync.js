'use strict';

const { runConnectionSync, createSyncScheduler, dtoHasAuthority, listDueSql, markAttempt } = require('./lib/external-calendar-inventory-sync');
const sheets = require('./lib/external-calendar-inventory-sheets');
const {
  detectGridMergesForTab, detectExtraColumns, detectOverflowRows, classifyHttp, parseSpreadsheetSnapshot,
} = sheets;

function yellowCell() {
  return {
    formattedValue: '',
    effectiveFormat: { backgroundColor: { red: 1, green: 0.85, blue: 0.2 } },
  };
}
function dateCell(iso) {
  return { formattedValue: iso };
}
function nameCell(name) {
  return { formattedValue: name };
}
function occupancyRows() {
  return [
    [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')],
    [nameCell('R1A'), yellowCell(), yellowCell()],
  ];
}

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function mockPg(state) {
  state.bedLocks = state.bedLocks || 0;
  return {
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (/^BEGIN/i.test(sql.trim())) { state.begins += 1; return { rows: [] }; }
      if (/^COMMIT/i.test(sql.trim())) { state.commits += 1; return { rows: [] }; }
      if (/^ROLLBACK/i.test(sql.trim())) { state.rollbacks += 1; return { rows: [] }; }
      if (/FROM clients/.test(sql)) return { rows: [{ id: 'cid-wh', slug: 'wolfhouse-somo' }] };
      if (/FOR UPDATE OF c/.test(sql)) {
        return { rows: [{
          id: 'conn-1', client_id: 'cid-wh', status: 'pending',
          spreadsheet_id: '1234567890abcdef', sheet_name: 'inventory',
        }] };
      }
      if (/FROM external_calendar_unit_maps/.test(sql)) {
        return { rows: [{ external_unit_key: 'R1A', bed_id: 'bed-a', map_id: 'm1' }] };
      }
      if (/FROM beds/.test(sql) && /FOR UPDATE/.test(sql)) {
        state.bedLocks += 1;
        return { rows: (params[1] || []).map((id) => ({ id })) };
      }
      if (/FROM booking_beds/.test(sql)) return { rows: [] };
      if (/UPDATE external_calendar_connections/.test(sql)) {
        state.statusUpdates.push(params);
        return { rows: [] };
      }
      if (/INSERT INTO bookings/.test(sql)) {
        state.bookingInserts += 1;
        return { rows: [{ id: 'bk-new' }] };
      }
      if (/INSERT INTO booking_beds/.test(sql)) {
        state.bedInserts += 1;
        return { rows: [] };
      }
      if (/INSERT INTO external_inventory_events/.test(sql)) return { rows: [] };
      if (/SELECT bk.id/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('verify-external-calendar-inventory-sync');
  ok('dto rejects rows', dtoHasAuthority({ rows: [] }) === true);
  ok('dto rejects occupancy', dtoHasAuthority({ occupancy: {} }) === true);
  ok('dto allows empty probe body', dtoHasAuthority({}) === false);

  const missing = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const CID = '11111111-1111-1111-1111-111111111111';
  const missingRes = await runConnectionSync(mockPg(missing), { clientSlug: 'wolfhouse-somo' });
  ok('sync without fetched does not write', missingRes.wrote === false && missing.bookingInserts === 0);

  const denied = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const deniedRes = await runConnectionSync(mockPg(denied), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: { ok: false, reason: 'sheets_token_denied', keepLastBlocks: true },
  });
  ok('token denial is not empty_sheet', deniedRes.reason === 'sheets_token_denied');
  ok('token denial writes zero bookings', denied.bookingInserts === 0);
  ok('token denial keeps last blocks', deniedRes.keepLastBlocks === true);
  ok('token denial uses a transaction', denied.begins === 1 && denied.commits === 1);

  const good = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const okSync = await runConnectionSync(mockPg(good), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: {
      ok: true,
      rows: occupancyRows(),
    },
  });
  ok('valid fetch persists booking in one txn', okSync.ok && good.bookingInserts === 1 && good.begins === 1 && good.commits === 1);

  const boom = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const boomPg = mockPg(boom);
  const orig = boomPg.query.bind(boomPg);
  boomPg.query = async (sql, params) => {
    if (/INSERT INTO bookings/.test(sql)) throw new Error('injected');
    return orig(sql, params);
  };
  const rolled = await runConnectionSync(boomPg, {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: {
      ok: true,
      rows: occupancyRows(),
    },
  });
  ok('inject write failure rolls back with public code',
    rolled.reason === 'calendar_sync_rolled_back' && boom.rollbacks === 1 && rolled.error == null);

  ok('due SQL uses poll_seconds and stale_after', /poll_seconds/.test(listDueSql()) && /stale_after/.test(listDueSql()));
  ok('grid merges scoped to configured tab', detectGridMergesForTab({
    sheets: [
      { properties: { title: 'other' }, merges: [{ startRowIndex: 0 }] },
      { properties: { title: 'inventory' }, merges: [] },
    ],
  }, 'inventory').merged === false);
  ok('merge on configured tab fails', detectGridMergesForTab({
    sheets: [{ properties: { title: 'inventory' }, merges: [{ startRowIndex: 0 }] }],
  }, 'inventory').merged === true);
  ok('missing tab fails', detectGridMergesForTab({
    sheets: [{ properties: { title: 'other' }, merges: [] }],
  }, 'inventory').reason === 'sheet_tab_missing');
  ok('column F populated is extra', detectExtraColumns([
    ['unit_key', 'start_date', 'end_date', 'status', 'external_uid', 'notes'],
  ], 5).extra === true);
  ok('row 5003 after blank is overflow', detectOverflowRows([[], ['R1', '2026-09-10', '2026-09-12', 'busy', 'u']]).overflow === true);
  ok('one snapshot parser accepts grid data', parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        { rowData: [{ values: [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')] }] },
        { rowData: [] },
      ],
    }],
  }, 'inventory').ok === true);
  ok('incomplete snapshot fails', parseSpreadsheetSnapshot({
    sheets: [{ properties: { title: 'inventory' }, data: [{ rowData: [] }] }],
  }, 'inventory').reason === 'sheet_snapshot_incomplete');
  const coloredSnap = parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        {
          rowData: [
            { values: [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')] },
            { values: [nameCell('R1A'), yellowCell(), yellowCell()] },
          ],
        },
        { rowData: [] },
      ],
    }],
  }, 'inventory');
  ok('snapshot keeps effectiveFormat fill for occupancy cells',
    coloredSnap.ok === true
    && coloredSnap.rows[1][1]
    && coloredSnap.rows[1][1].effectiveFormat
    && coloredSnap.rows[1][1].effectiveFormat.backgroundColor
    && coloredSnap.rows[1][1].effectiveFormat.backgroundColor.red === 1);
  const wideDates = [nameCell('')].concat(Array.from({ length: 8 }, (_, i) => dateCell('2026-09-' + String(i + 1).padStart(2, '0'))));
  const wideSnap = parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        { rowData: [{ values: wideDates }] },
        { rowData: [] },
      ],
    }],
  }, 'inventory');
  ok('occupancy grid may be wider than five columns',
    wideSnap.ok === true && wideSnap.rows[0].length === 9);
  const src = require('fs').readFileSync(require('path').join(__dirname, 'lib/external-calendar-inventory-sheets.js'), 'utf8');
  ok('Sheets request asks for effectiveFormat fill fields',
    /effectiveFormat/.test(src) && /backgroundColorStyle/.test(src) && /userEnteredFormat/.test(src));
  ok('Sheets request does not fetch conditionalFormats rules',
    !/conditionalFormats/.test(src));
  const extraColorSnap = parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        {
          rowData: [
            { values: [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')] },
            { values: [nameCell('R1A'), yellowCell(), yellowCell(), yellowCell()] },
          ],
        },
        { rowData: [] },
      ],
    }],
  }, 'inventory');
  ok('snapshot preserves colored body cell beyond final date header',
    extraColorSnap.ok === true
    && extraColorSnap.rows[1].length === 4
    && extraColorSnap.rows[1][3]
    && extraColorSnap.rows[1][3].effectiveFormat
    && extraColorSnap.rows[1][3].effectiveFormat.backgroundColor
    && extraColorSnap.rows[1][3].effectiveFormat.backgroundColor.red === 1);
  const extraDataSnap = parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        {
          rowData: [
            { values: [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')] },
            { values: [nameCell('R1A'), yellowCell(), yellowCell(), { formattedValue: 'NOTE' }] },
          ],
        },
        { rowData: [] },
      ],
    }],
  }, 'inventory');
  ok('snapshot preserves nonempty extra body cell beyond final date header',
    extraDataSnap.ok === true
    && extraDataSnap.rows[1].length === 4
    && extraDataSnap.rows[1][3]
    && extraDataSnap.rows[1][3].formattedValue === 'NOTE');
  const extraColorSync = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const extraColorSyncRes = await runConnectionSync(mockPg(extraColorSync), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: extraColorSnap,
  });
  ok('extra colored body cell fails closed with zero writes and keep-last',
    extraColorSyncRes.ok === false
    && extraColorSyncRes.keepLastBlocks === true
    && extraColorSync.bookingInserts === 0
    && extraColorSync.bedInserts === 0
    && extraColorSyncRes.reason === 'header_unknown_column');
  const extraDataSync = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const extraDataSyncRes = await runConnectionSync(mockPg(extraDataSync), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: extraDataSnap,
  });
  ok('extra nonempty body cell fails closed with zero writes and keep-last',
    extraDataSyncRes.ok === false
    && extraDataSyncRes.keepLastBlocks === true
    && extraDataSync.bookingInserts === 0
    && extraDataSyncRes.reason === 'header_unknown_column');

  const reversedUid = 'grid:R1A:2026-09-01:2026-09-04';
  const reversedOccState = {
    queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0,
    occupancyRows: [{
      bed_id: 'bed-a',
      assignment_type: 'external_inventory_block',
      assignment_start_date: '2026-09-01',
      assignment_end_date: '2026-09-04',
      booking_id: 'bk-reversed',
      status: 'blocked',
      metadata: {
        external_calendar: {
          connection_id: 'conn-1',
          external_uid: reversedUid,
        },
      },
    }],
    cancelledBookingIds: [],
    deletedBedSql: [],
  };
  const reversedPg = mockPg(reversedOccState);
  const reversedOrig = reversedPg.query.bind(reversedPg);
  reversedPg.query = async (sql, params) => {
    if (/FROM booking_beds/.test(sql) && !/INSERT/.test(sql) && !/DELETE/.test(sql) && !/UPDATE/.test(sql)) {
      reversedOccState.queries.push({ sql, params });
      if (/assignment_start_date < \$4/.test(sql)) return { rows: [] };
      return { rows: reversedOccState.occupancyRows };
    }
    if (/SELECT bk.id/.test(sql)) {
      reversedOccState.queries.push({ sql, params });
      if (params && params[2] === reversedUid) return { rows: [{ id: 'bk-reversed' }] };
      return { rows: [] };
    }
    if (/DELETE FROM booking_beds/.test(sql)) {
      reversedOccState.deletedBedSql.push({ sql, params });
    }
    if (/UPDATE bookings SET status = 'cancelled'/.test(sql)) {
      reversedOccState.cancelledBookingIds.push(params[0]);
    }
    return reversedOrig(sql, params);
  };
  const reversedSnap = parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        {
          rowData: [
            { values: [nameCell(''), dateCell('2026-09-03'), dateCell('2026-09-01')] },
            { values: [nameCell('R1A'), { formattedValue: '' }, { formattedValue: '' }] },
          ],
        },
        { rowData: [] },
      ],
    }],
  }, 'inventory');
  ok('reversed header snapshot still parses grid cells',
    reversedSnap.ok === true
    && reversedSnap.rows[0][1].formattedValue === '2026-09-03'
    && reversedSnap.rows[0][2].formattedValue === '2026-09-01');
  const reversedSync = await runConnectionSync(reversedPg, {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: reversedSnap,
  });
  ok('reversed date headers fail closed with zero writes and keep-last',
    reversedSync.ok === false
    && reversedSync.keepLastBlocks === true
    && reversedSync.wrote === false
    && reversedSync.reason === 'date_header_order'
    && reversedOccState.bookingInserts === 0
    && reversedOccState.bedInserts === 0
    && reversedOccState.cancelledBookingIds.length === 0
    && reversedOccState.deletedBedSql.length === 0);

  const octoberUid = 'grid:R1A:2026-10-01:2026-10-10';
  const octoberOccState = {
    queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0,
    occupancyRows: [{
      bed_id: 'bed-a',
      assignment_type: 'external_inventory_block',
      assignment_start_date: '2026-10-01',
      assignment_end_date: '2026-10-10',
      booking_id: 'bk-oct',
      status: 'blocked',
      metadata: {
        external_calendar: {
          connection_id: 'conn-1',
          external_uid: octoberUid,
        },
      },
    }],
    cancelledBookingIds: [],
  };
  const octoberPg = mockPg(octoberOccState);
  const octOrig = octoberPg.query.bind(octoberPg);
  octoberPg.query = async (sql, params) => {
    if (/FROM booking_beds/.test(sql) && !/INSERT/.test(sql) && !/DELETE/.test(sql) && !/UPDATE/.test(sql)) {
      octoberOccState.queries.push({ sql, params });
      if (/assignment_start_date < \$4/.test(sql)) return { rows: [] };
      return { rows: octoberOccState.occupancyRows };
    }
    if (/SELECT bk.id/.test(sql)) {
      octoberOccState.queries.push({ sql, params });
      if (params && params[2] === octoberUid) return { rows: [{ id: 'bk-oct' }] };
      return { rows: [] };
    }
    if (/UPDATE bookings SET status = 'cancelled'/.test(sql)) {
      octoberOccState.cancelledBookingIds.push(params[0]);
    }
    return octOrig(sql, params);
  };
  const octoberSync = await runConnectionSync(octoberPg, {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: {
      ok: true,
      rows: [
        [nameCell(''), dateCell('2026-09-01'), dateCell('2026-09-02'), dateCell('2026-09-03')],
        [nameCell('R1A'), yellowCell(), yellowCell(), yellowCell()],
      ],
    },
  });
  ok('September sync does not cancel a fully outside October owned block',
    octoberSync.ok === true
    && octoberOccState.cancelledBookingIds.indexOf('bk-oct') < 0
    && octoberOccState.bookingInserts >= 1);

  ok('column overflow with fill fails closed', parseSpreadsheetSnapshot({
    sheets: [{
      properties: { title: 'inventory' },
      merges: [],
      data: [
        { rowData: [{ values: [nameCell(''), dateCell('2026-09-10')] }] },
        { rowData: [] },
        { rowData: [{ values: [yellowCell()] }] },
      ],
    }],
  }, 'inventory').reason === 'sheet_over_limit');
  ok('503 classified provider 5xx', classifyHttp(503) === 'sheets_provider_5xx');
  ok('valid fetch locks beds before write', okSync.ok && good.bedLocks >= 1);

  let ticks = 0;
  const sched = createSyncScheduler({
    intervalMs: 999999,
    withPgClient: async (fn) => fn(mockPg({
      queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0, bedLocks: 0,
    })),
    listDueConnections: async () => [{ id: 'c', client_slug: 'wolfhouse-somo' }],
    fetchSheet: async () => {
      ticks += 1;
      return { ok: false, reason: 'sheets_timeout', keepLastBlocks: true };
    },
  });
  await sched.tick();
  ok('scheduler preserves fetch failure class', ticks === 1);

  const persistState = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  await markAttempt(mockPg(persistState), { id: CID }, { last_error: 'ECONNRESET', status: 'error', success: false });
  ok('markAttempt allowlists hostile persist code',
    persistState.statusUpdates[0] && persistState.statusUpdates[0][1] === 'calendar_bridge_failed');

  const skipState = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const skippedSync = await runConnectionSync(mockPg(skipState), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: {
      ok: true,
      rows: [
        [nameCell(''), dateCell('2026-09-10'), dateCell('2026-09-11')],
        [nameCell('UNMAPPED'), yellowCell(), yellowCell()],
      ],
    },
  });
  ok('sync skipped rows omit unknown internals',
    skippedSync.ok === false
    && skippedSync.skipped
    && skippedSync.skipped[0].skip_reason === 'unmapped_unit_key'
    && skippedSync.skipped[0].bed_id == null);
  ok('sync persist of unmapped uses allowlisted code',
    skipState.statusUpdates[0] && skipState.statusUpdates[0][1] === 'unmapped_unit_key');

  const sqlState = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const sqlSync = await runConnectionSync(mockPg(sqlState), {
    clientSlug: 'wolfhouse-somo',
    connectionId: CID,
    fetched: { ok: false, reason: 'password=supersecret duplicate key value', keepLastBlocks: true },
  });
  ok('sync fetch SQL/credential reason is not stored raw',
    sqlSync.reason === 'calendar_bridge_failed'
    && sqlState.statusUpdates[0]
    && sqlState.statusUpdates[0][1] === 'calendar_bridge_failed');

  console.log('\nverify-external-calendar-inventory-sync: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
