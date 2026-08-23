'use strict';

const { runConnectionSync, persistOwnedWrites, createSyncScheduler } = require('./lib/external-calendar-inventory-sync');

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function mockPg(state) {
  return {
    async query(sql, params) {
      state.queries.push({ sql, params });
      if (/FROM clients/.test(sql)) return { rows: [{ id: 'cid-wh', slug: 'wolfhouse-somo' }] };
      if (/FROM external_calendar_connections/.test(sql)) {
        return { rows: [{
          id: 'conn-1', client_id: 'cid-wh', status: 'pending',
          spreadsheet_id: '1234567890abcdef', sheet_name: 'inventory',
        }] };
      }
      if (/FROM external_calendar_unit_maps/.test(sql)) {
        return { rows: [{ external_unit_key: 'R1A', bed_id: 'bed-a', map_id: 'm1' }] };
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
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('verify-external-calendar-inventory-sync');
  const bad = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0 };
  const result = await runConnectionSync(mockPg(bad), {
    clientSlug: 'wolfhouse-somo',
    rows: [
      ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
      ['R1A', '10/09/2026', '12/09/2026', 'busy', 'uid-1'],
    ],
  });
  ok('malformed sheet writes zero bookings', result.wrote === false && bad.bookingInserts === 0);
  ok('malformed keeps last blocks', result.keepLastBlocks === true);
  ok('malformed updates connection status only', bad.statusUpdates.length === 1);

  const good = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0 };
  const okSync = await runConnectionSync(mockPg(good), {
    clientSlug: 'wolfhouse-somo',
    rows: [
      ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
      ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
    ],
  });
  ok('valid busy persists booking', okSync.ok && good.bookingInserts === 1 && good.bedInserts === 1);

  const empty = { queries: [], statusUpdates: [], bookingInserts: 0, bedInserts: 0 };
  const emptySync = await runConnectionSync(mockPg(empty), {
    clientSlug: 'wolfhouse-somo',
    rows: [['unit_key', 'start_date', 'end_date', 'status', 'external_uid']],
  });
  ok('empty sheet writes nothing', emptySync.wrote === false && empty.bookingInserts === 0);
  ok('empty does not mark healthy from pending', empty.statusUpdates[0][2] !== 'healthy');

  let ticks = 0;
  const sched = createSyncScheduler({
    intervalMs: 999999,
    withPgClient: async (fn) => fn({}),
    listDueConnections: async () => [{ id: 'c' }],
    syncOne: async () => { ticks += 1; },
  });
  await sched.tick();
  ok('scheduler tick runs due connections', ticks === 1);

  console.log('\nverify-external-calendar-inventory-sync: ALL CHECKS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
