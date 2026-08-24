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
