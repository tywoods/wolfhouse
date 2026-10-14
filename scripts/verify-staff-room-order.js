'use strict';

// V1.8 A — Style room order is a browser-local display choice.
// Numerical is the default. Priority follows the saved room UUID list.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const es = require('./lib/staff-portal-i18n-es');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const fill = fs.readFileSync(path.join(__dirname, 'browser/staff-room-fill.js'), 'utf8');

assert.match(api, /id="staff-room-order"/);
assert.match(api, /data-room-order="numerical"/);
assert.match(api, /data-room-order="priority"/);
assert.match(api, /html\[data-portal-client="sunset"\] #staff-room-order\{display:none!important\}/);
assert.equal(STAFF_PORTAL_STRINGS.en['lunaStaff.style.roomOrder.priority'], 'Priority');
assert.equal(es['lunaStaff.style.roomOrder.priority'], 'Prioridad');
const savedAt = fill.indexOf('Placement settings saved.');
const refreshAt = fill.indexOf("if (typeof loadBedCalendar === 'function') loadBedCalendar();");
assert.ok(refreshAt > savedAt);
assert.equal(fill.slice(savedAt, refreshAt).includes('Could not save'), false);

function extractFunction(name) {
  const start = api.indexOf('function ' + name + '(');
  assert.ok(start > 0, name);
  let i = api.indexOf('{', start);
  let depth = 0;
  for (; i < api.length; i += 1) {
    if (api[i] === '{') depth += 1;
    else if (api[i] === '}') {
      depth -= 1;
      if (depth === 0) return api.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + name);
}

const { parseStoredPolicy } = require('./lib/staff-room-fill-policy');
const hierarchy = new Function('resolveRoomCategory', 'parseStoredPolicy', extractFunction('buildRoomHierarchy') + '\nreturn buildRoomHierarchy;')(() => 'private', parseStoredPolicy);
assert.match(extractFunction('buildRoomHierarchy'), /parseStoredPolicy\(policy\)/);
const IDS = {
  R1: '11111111-1111-4111-8111-111111111111',
  R2: '22222222-2222-4222-8222-222222222222',
  R3: '33333333-3333-4333-8333-333333333333',
  R10: '10101010-1010-4101-8101-101010101010',
};
const policy = {
  contractVersion: 1,
  fillMode: 'house',
  roomPriority: [IDS.R10, IDS.R2, IDS.R1],
  roomPrioritySource: 'custom',
};
const catalogue = Object.entries(IDS).map(([code, room_id]) => ({ room_id, room_code: code }));
function rowsFor(saved) {
  return ['R1', 'R10', 'R2', 'R3'].map((code, index) => ({
    room_id: IDS[code],
    room_code: code,
    room_name: code,
    room_fill_policy: saved,
    room_fill_catalogue: catalogue,
    fill_priority: 100 - index,
    room_sort_order: 100 - index,
    bed_code: code + '-B1',
    bed_id: code + '-bed',
    bed_number: 1,
  }));
}
const rooms = hierarchy(rowsFor(policy));
assert.deepEqual(rooms.map((room) => room.room_code), ['R1', 'R10', 'R2', 'R3']);
assert.equal(rooms.find((room) => room.room_code === 'R10').room_priority_rank, 0);
assert.equal(rooms.find((room) => room.room_code === 'R2').room_priority_rank, 1);
assert.equal(rooms.find((room) => room.room_code === 'R1').room_priority_rank, 2);
assert.equal(rooms.find((room) => room.room_code === 'R3').room_priority_status, 'unranked');
assert.equal(Object.hasOwn(rooms[0], 'room_fill_policy'), false);
assert.equal(Object.hasOwn(rooms[0], 'room_fill_catalogue'), false);
assert.deepEqual(rooms[0].beds.map((bed) => bed.bed_code), ['R1-B1']);

const broken = hierarchy(rowsFor({ roomPriority: 'nope' }));
assert.ok(broken.every((room) => room.room_priority_status === 'unavailable'));
assert.equal(broken.length, 4);

const store = {};
const document = { documentElement: { getAttribute: () => '' } };
const sandbox = {
  document,
  localStorage: {
    getItem: (key) => (Object.hasOwn(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = value; },
  },
  getClient: () => 'wolfhouse-somo',
  el: () => null,
  bcData: null,
  renderBedCalendar: () => {},
  console,
};
vm.createContext(sandbox);
const start = api.indexOf('var BC_ROOM_ORDER_PREFIX');
const endName = 'function bcSortRoomsForDisplay';
const end = api.indexOf(endName, start);
const sortFn = extractFunction('bcSortRoomsForDisplay');
const browserFns = extractFunction('bcNaturalCodeSort') + '\n' + api.slice(start, end) + '\n' + sortFn;
vm.runInContext(browserFns + '\nthis.api = { bcRoomOrderRead, bcRoomOrderWrite, bcSortRoomsForDisplay, bcNaturalCodeSort };', sandbox);

assert.equal(sandbox.api.bcRoomOrderRead(), 'numerical');
const ranked = sandbox.api.bcSortRoomsForDisplay(rooms);
assert.equal(ranked.map((room) => room.room_code).join(','), 'R1,R2,R3,R10', 'default stays numerical');
sandbox.api.bcRoomOrderWrite('priority');
assert.equal(store['wh_staff_room_order_v1:wolfhouse-somo'], 'priority');
assert.equal(Object.keys(store).some((key) => key === 'wh_staff_room_order_v1'), false);
const priority = sandbox.api.bcSortRoomsForDisplay(rooms);
assert.equal(priority.map((room) => room.room_code).join(','), 'R10,R2,R1,R3');
const savedPreference = store['wh_staff_room_order_v1:wolfhouse-somo'];
function rejectedStaysNumerical(label, saved) {
  const before = store['wh_staff_room_order_v1:wolfhouse-somo'];
  const projected = hierarchy(rowsFor(saved));
  assert.ok(projected.every((room) => room.room_priority_status === 'unavailable'), label);
  assert.equal(sandbox.api.bcSortRoomsForDisplay(projected).map((room) => room.room_code).join(','), 'R1,R2,R3,R10', label);
  assert.equal(store['wh_staff_room_order_v1:wolfhouse-somo'], before, label + ' preference untouched');
  assert.equal(sandbox.api.bcRoomOrderRead(), 'priority', label + ' saved choice remains Priority');
  assert.equal(JSON.stringify(saved), JSON.stringify(rowsFor(saved)[0].room_fill_policy));
}
rejectedStaysNumerical('bad version', { ...policy, contractVersion: 99 });
rejectedStaysNumerical('duplicate ids', { ...policy, roomPriority: [IDS.R10, IDS.R10, IDS.R2] });
rejectedStaysNumerical('invalid priority source', { ...policy, roomPrioritySource: 'manual' });
assert.equal(savedPreference, 'priority');

function buildProductionPage(tenant) {
  const code = "process.env.NODE_ENV='test';process.env.STAFF_UI_BUILDER_TEST_SEAM='1';process.env.STAFF_AUTH_REQUIRED='false';process.env.STAFF_AUTH_ALLOW_OPEN='true';process.env.DEFAULT_CLIENT_SLUG=process.argv[1];process.stdout.write(require('./scripts/staff-query-api.js').buildUiHtmlForOfflineTest(0, process.argv[1]));";
  const result = spawnSync(process.execPath, ['-e', code, tenant], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, tenant + ' production builder failed\\n' + result.stderr);
  assert.match(result.stdout, /<!DOCTYPE html/i, tenant);
  assert.equal(result.stdout.includes('/* INJECT:staff-room-fill */'), false, tenant + ' room-fill injector did not run');
  assert.ok(result.stdout.includes('Placement settings saved.'), tenant + ' room-fill module missing');
  assert.ok(result.stdout.includes('id="staff-room-order"'), tenant + ' room order missing');
  return result.stdout;
}
const wolfPage = buildProductionPage('wolfhouse-somo');
const sunsetPage = buildProductionPage('sunset');
assert.match(sunsetPage, /<html lang="en" data-portal-client="sunset">/);
assert.match(wolfPage, /<html lang="en">/);
assert.doesNotMatch(wolfPage.slice(0, 80), /data-portal-client="sunset"/);
assert.match(sunsetPage, /html\[data-portal-client="sunset"\] #staff-room-order\{display:none!important\}/);
const withHistory = sandbox.api.bcSortRoomsForDisplay(rooms.concat([{ room_code: 'R0', history_only: true, room_priority_status: 'ranked', room_priority_rank: 0 }]));
assert.equal(withHistory.at(-1).room_code, 'R0');
store['wh_staff_room_order_v1:wolfhouse-somo'] = 'not-a-mode';
assert.equal(sandbox.api.bcRoomOrderRead(), 'numerical');
sandbox.getClient = () => '';
assert.equal(sandbox.api.bcRoomOrderWrite('priority').ok, false);
assert.equal(store['wh_staff_room_order_v1:'], undefined);
sandbox.getClient = () => 'sunset';
assert.equal(sandbox.api.bcRoomOrderRead(), 'numerical');
assert.equal(sandbox.api.bcSortRoomsForDisplay(rooms).map((room) => room.room_code).join(','), 'R1,R2,R3,R10');
sandbox.getClient = () => 'wolfhouse-somo';
document.documentElement.getAttribute = () => 'sunset';
assert.equal(sandbox.api.bcRoomOrderRead(), 'numerical');
document.documentElement.getAttribute = () => '';
sandbox.localStorage.setItem = () => { throw new Error('blocked'); };
const failed = sandbox.api.bcRoomOrderWrite('priority');
assert.equal(failed.ok, false);
assert.equal(failed.unsaved, true);
assert.equal(sandbox.api.bcRoomOrderRead(), 'priority');
const fallback = sandbox.api.bcSortRoomsForDisplay(broken);
assert.equal(fallback.map((room) => room.room_code).join(','), 'R1,R2,R3,R10');

console.log('PASS staff room order');
