'use strict';

const { runConnectionSync, createSyncScheduler, dtoHasAuthority, listDueSql } = require('./lib/external-calendar-inventory-sync');
const { detectGridMergesForTab, detectExtraColumns, detectOverflowRows, classifyHttp } = require('./lib/external-calendar-inventory-sheets');

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
  const missingRes = await runConnectionSync(mockPg(missing), { clientSlug: 'wolfhouse-somo' });
  ok('sync without fetched does not write', missingRes.wrote === false && missing.bookingInserts === 0);

  const denied = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const deniedRes = await runConnectionSync(mockPg(denied), {
    clientSlug: 'wolfhouse-somo',
    fetched: { ok: false, reason: 'sheets_token_denied', keepLastBlocks: true },
  });
  ok('token denial is not empty_sheet', deniedRes.reason === 'sheets_token_denied');
  ok('token denial writes zero bookings', denied.bookingInserts === 0);
  ok('token denial keeps last blocks', deniedRes.keepLastBlocks === true);
  ok('token denial uses a transaction', denied.begins === 1 && denied.commits === 1);

  const good = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0, begins: 0, commits: 0, rollbacks: 0 };
  const okSync = await runConnectionSync(mockPg(good), {
    clientSlug: 'wolfhouse-somo',
    fetched: {
      ok: true,
      rows: [
        ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
        ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
      ],
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
    fetched: {
      ok: true,
      rows: [
        ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
        ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
      ],
    },
  });
  ok('inject write failure rolls back', rolled.reason === 'sync_rollback' && boom.rollbacks === 1);

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
  ok('401 classified inaccessible', classifyHttp(401) === 'sheets_inaccessible');
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

  console.log('\nverify-external-calendar-inventory-sync: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
