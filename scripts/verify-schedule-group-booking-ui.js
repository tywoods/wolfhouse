'use strict';

/**
 * SCHEDULE-GROUP-BOOKING-UI-001 — multi-room group parent bar + soft accent/chip.
 *
 * Proves:
 * 1. CSS + legend markers for group parent bar / pebble chip / hover accent
 * 2. bcBuildMultiRoomGroups detects 2+ rooms on same booking_id
 * 3. Parent row HTML + block blocks carry bc-group-parent-bar / bc-block-group / bc-group-chip
 * 4. Single-room multi-bed stays are NOT painted as groups
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const apiPath = path.join(__dirname, 'staff-query-api.js');
const i18nPath = path.join(__dirname, 'lib/staff-portal-i18n.js');
const esPath = path.join(__dirname, 'lib/staff-portal-i18n-es.js');
const api = fs.readFileSync(apiPath, 'utf8');
const i18n = fs.readFileSync(i18nPath, 'utf8');
const es = fs.readFileSync(esPath, 'utf8');

let passed = 0;
function ok(name, cond, detail) {
  assert.ok(cond, detail || name);
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('[1] Static markers — CSS, legend, helpers, i18n');
ok('job marker in CSS', /SCHEDULE-GROUP-BOOKING-UI-001/.test(api));
ok('parent bar CSS', /\.bc-group-parent-bar\{/.test(api));
ok('soft lilac pebble chip CSS', /\.bc-group-chip\{[^}]*#E3D7F0/.test(api));
ok('group block accent CSS', /\.bc-block-group\{/.test(api));
ok('cross-room hover CSS', /\.bc-block-group-hover/.test(api));
ok('legend swatch', /bc-legend-sw-group/.test(api));
ok('legend i18n key in HTML', /data-i18n="calendar\.legend\.group"/.test(api));
ok('helper bcBuildMultiRoomGroups', /function bcBuildMultiRoomGroups\(/.test(api));
ok('helper bcRenderGroupParentRow', /function bcRenderGroupParentRow\(/.test(api));
ok('renderBedCalendar calls group builder', /var multiRoomGroups = bcBuildMultiRoomGroups\(blocks\)/.test(api));
ok('renderBookingBlock adds bc-block-group', /bc-block-group/.test(api) && /_bc_is_group/.test(api));
ok('EN i18n group keys', /'calendar\.legend\.group': 'Group'/.test(i18n) && /'calendar\.group\.chip': 'Group'/.test(i18n));
ok('ES i18n group keys', /"calendar\.legend\.group": "Grupo"/.test(es));
ok('IT i18n group keys', /'calendar\.legend\.group': 'Gruppo'/.test(i18n));
ok('empty-cell clean near-white (Gina multi-bed paint)', /\.bc-day-cell:not\(:has\(\.bc-block\)\)\{background:#F7F8F8\}/.test(api));
ok('empty-cell clean charcoal dark', /\[data-theme="dark"\] \.bc-day-cell:not\(:has\(\.bc-block\)\)\{background:#2A2A2C\}/.test(api));
ok('warm beige empty-cell wash gone', !/rgba\(240,236,228/.test(api));

console.log('\n[2] Behavioral — multi-room group builds parent bar + accent chip');
const start = api.indexOf('/** SCHEDULE-GROUP-BOOKING-UI-001 — stable key for multi-room group paint. */');
const end = api.indexOf('function bcColorClass(ct){', start);
assert.ok(start > 0 && end > start, 'extract group helpers');
const slice = api.slice(start, end);

const ctx = {
  t(key, vars) {
    const map = {
      'calendar.group.chip': 'Group',
      'calendar.group.rooms': (vars && vars.count) + ' rooms',
      'calendar.group.chipTitle': 'Group stay · ' + ((vars && vars.count) || 0) + ' rooms',
    };
    return map[key] || key;
  },
  escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
  el() { return null; },
};
vm.createContext(ctx);
vm.runInContext(slice, ctx);

const days = [
  { date: '2026-09-10', label: 'Thu 10' },
  { date: '2026-09-11', label: 'Fri 11' },
  { date: '2026-09-12', label: 'Sat 12' },
  { date: '2026-09-13', label: 'Sun 13' },
];

const blocks = [
  {
    booking_id: 'g1',
    booking_code: 'GRP-001',
    guest_name: 'River Group',
    room_code: 'R1',
    bed_code: 'R1-B1',
    start_date: '2026-09-10',
    end_date: '2026-09-13',
    color_type: 'confirmed',
  },
  {
    booking_id: 'g1',
    booking_code: 'GRP-001',
    guest_name: 'River Group',
    room_code: 'R3',
    bed_code: 'R3-B2',
    start_date: '2026-09-10',
    end_date: '2026-09-13',
    color_type: 'confirmed',
  },
  {
    booking_id: 'solo',
    booking_code: 'SOLO-1',
    guest_name: 'Solo Guest',
    room_code: 'R8',
    bed_code: 'R8-B1',
    start_date: '2026-09-10',
    end_date: '2026-09-12',
    color_type: 'confirmed',
  },
  {
    booking_id: 'solo',
    booking_code: 'SOLO-1',
    guest_name: 'Solo Guest',
    room_code: 'R8',
    bed_code: 'R8-B2',
    start_date: '2026-09-10',
    end_date: '2026-09-12',
    color_type: 'confirmed',
  },
];

const groups = ctx.bcBuildMultiRoomGroups(blocks);
ok('detects exactly one multi-room group', groups.length === 1, 'got ' + groups.length);
ok('group spans 2 rooms', groups[0].roomCount === 2);
ok('group key stable', groups[0].key === 'id:g1');
ok('marks multi-room blocks as group', blocks[0]._bc_is_group === true && blocks[1]._bc_is_group === true);
ok('does not mark single-room multi-bed as group', blocks[2]._bc_is_group !== true && blocks[3]._bc_is_group !== true);

const parentHtml = ctx.bcRenderGroupParentRow(groups[0], days);
ok('parent row class present', /bc-group-parent-row/.test(parentHtml));
ok('parent bar element present', /class="bc-group-parent-bar"/.test(parentHtml));
ok('parent bar spans stay nights (3 days)', /colspan="3"/.test(parentHtml));
ok('parent bar carries group key', /data-group-key="id:g1"/.test(parentHtml));
ok('parent label includes Group chip', /bc-group-chip/.test(parentHtml) && /River Group/.test(parentHtml));
ok('parent meta shows room count', /2 rooms/.test(parentHtml));

const chipHtml = ctx.bcGroupChipHtml(blocks[0]);
ok('block chip HTML for group', /bc-group-chip/.test(chipHtml) && /Group/.test(chipHtml));
ok('no chip for single-room stay', ctx.bcGroupChipHtml(blocks[2]) === '');

/* Mimic renderBookingBlock group class wiring with the same attrs the UI uses */
function paintBlock(blk, idx) {
  const groupCls = blk && blk._bc_is_group ? ' bc-block-group' : '';
  const groupAttr = blk && blk._bc_group_key ? ' data-group-key="' + ctx.escHtml(blk._bc_group_key) + '"' : '';
  return '<div class="bc-block bc-block-confirmed' + groupCls + '" data-bidx="' + idx + '"' + groupAttr + '>' +
    '<span class="bc-block-label">' + ctx.escHtml(blk.guest_name) + '</span>' +
    ctx.bcGroupChipHtml(blk) +
    '</div>';
}
const painted = paintBlock(blocks[0], 0) + paintBlock(blocks[1], 1) + paintBlock(blocks[2], 2);
ok('painted group blocks include bc-block-group', (painted.match(/bc-block-group/g) || []).length === 2);
ok('painted group blocks include chip', (painted.match(/bc-group-chip/g) || []).length === 2);
ok('solo block has neither group class nor chip',
  !/Solo Guest[\s\S]*bc-block-group/.test(painted) &&
  painted.indexOf('Solo Guest') >= 0 &&
  painted.split('Solo Guest')[1].indexOf('bc-group-chip') < 0);

console.log('\n[3] Proof summary');
console.log('  Multi-room booking GRP-001 → parent bar colspan=3 + Group chip + bc-block-group accent');
console.log('  Single-room multi-bed SOLO-1 (Room 8) → no group paint');
console.log('\nPASS ' + passed + ' checks — schedule group booking UI');
