'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lib = require('./lib/external-calendar-inventory');
const { applyProbePlan } = require('./lib/external-calendar-inventory-apply');

const HEADERS = ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'];
const CONN = 'conn-wh-1';
const BED_A = 'bed-a';

function ok(label, cond, detail) {
  if (!cond) {
    console.error('FAIL', label, detail || '');
    throw new Error(label);
  }
  console.log('  PASS ', label);
}

function guestRow() {
  return {
    assignment_type: 'manual',
    assignment_start_date: '2026-09-10',
    assignment_end_date: '2026-09-12',
    status: 'confirmed',
    booking_id: 'guest-1',
  };
}

function staffBlock() {
  return {
    assignment_type: 'staff_block',
    assignment_start_date: '2026-09-20',
    assignment_end_date: '2026-09-22',
    status: 'blocked',
    booking_id: 'staff-1',
  };
}

function main() {
  console.log('verify-external-calendar-inventory');

  const mig = fs.readFileSync(path.join(ROOT, 'database/migrations/089_external_calendar_inventory.sql'), 'utf8');
  const down = fs.readFileSync(path.join(ROOT, 'database/migrations/089_external_calendar_inventory_down.sql'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');

  ok('migration creates connections table', /CREATE TABLE IF NOT EXISTS public\.external_calendar_connections/.test(mig));
  ok('migration bed-only maps', /bed_id uuid NOT NULL/.test(mig) && !/room_id/.test(mig));
  ok('migration kind is gsheet only', /CHECK \(kind = 'gsheet'\)/.test(mig));
  ok('migration has no sunset slug', !/sunset/i.test(mig));
  ok('down refuses imported events', /089_down_refused/.test(down));
  ok('lib default allowlist is wolfhouse-somo', lib.DEFAULT_ALLOWED_CLIENTS.join() === 'wolfhouse-somo');
  ok('sunset client rejected even if listed', lib.clientAllowed('sunset', {
    EXTERNAL_CALENDAR_CLIENTS: 'sunset,wolfhouse-somo',
  }) === false);
  ok('wolfhouse-somo allowed when flag on', lib.bridgeAvailable('wolfhouse-somo', {
    EXTERNAL_CALENDAR_INGEST_ENABLED: 'true',
  }) === true);
  ok('flag off disables wolfhouse', lib.bridgeAvailable('wolfhouse-somo', {}) === false);

  const good = [
    HEADERS,
    ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
  ];
  const maps = { R1A: BED_A };
  const plan = lib.probeSheetRows(good, { maps, connectionId: CONN, occupancy: {} });
  ok('good busy row dry-run inserts owned', plan.ok && plan.writes[0].action === 'insert_owned');
  ok('owned assignment type set', plan.writes[0].assignment_type === lib.ASSIGNMENT_TYPE);

  const vsGuest = lib.probeSheetRows(good, {
    maps, connectionId: CONN,
    occupancy: { [BED_A]: [guestRow()] },
  });
  ok('busy vs guest fails entire sync closed',
    vsGuest.ok === false && vsGuest.writes.length === 0 && vsGuest.keepLastBlocks === true);

  const vsStaff = lib.probeSheetRows([
    HEADERS,
    ['R1A', '2026-09-20', '2026-09-22', 'busy', 'uid-staff'],
  ], {
    maps, connectionId: CONN,
    occupancy: { [BED_A]: [staffBlock()] },
  });
  ok('busy vs overlapping staff_block fails entire sync',
    vsStaff.ok === false && vsStaff.writes.length === 0);

  const mixedGoodAndBad = lib.probeSheetRows([
    HEADERS,
    ['R1A', '2026-09-01', '2026-09-03', 'busy', 'uid-ok'],
    ['R1A', '10/09/2026', '12/09/2026', 'busy', 'uid-bad'],
  ], { maps, connectionId: CONN, occupancy: {} });
  ok('one malformed row fails whole sheet (zero writes)',
    mixedGoodAndBad.ok === false && mixedGoodAndBad.writes.length === 0);

  const drift = lib.probeSheetRows([['unit', 'start', 'end', 'status', 'id']], { maps, connectionId: CONN });
  ok('header drift errors with no writes', drift.ok === false && drift.writes.length === 0);

  const locale = lib.probeSheetRows([
    HEADERS,
    ['R1A', '10/09/2026', '12/09/2026', 'busy', 'uid-2'],
  ], { maps, connectionId: CONN });
  ok('locale date fails closed', locale.ok === false);

  const serial = lib.probeSheetRows([
    HEADERS,
    ['R1A', 45910, 45912, 'busy', 'uid-3'],
  ], { maps, connectionId: CONN });
  ok('excel serial fails closed', serial.ok === false);

  const merged = lib.probeSheetRows([
    HEADERS,
    ['R1A', { merged: true, value: '2026-09-10' }, '2026-09-12', 'busy', 'uid-4'],
  ], { maps, connectionId: CONN });
  ok('merged cells fail closed', merged.ok === false && merged.reason === 'merged_cells');

  const empty = lib.probeSheetRows([HEADERS], { maps, connectionId: CONN });
  ok('empty sheet is dry-run empty keep-last', empty.ok && empty.empty && empty.keepLastBlocks);

  const unmapped = lib.probeSheetRows(good, { maps: {}, connectionId: CONN });
  ok('unmapped unit fails entire sync', unmapped.ok === false && unmapped.writes.length === 0);

  ok('empty sheet does not become healthy',
    lib.nextConnectionStatus('pending', empty) === 'pending');

  const futureStaffOcc = { [BED_A]: [staffBlock()] };
  const nonOverlap = lib.probeSheetRows([
    HEADERS,
    ['R1A', '2026-08-01', '2026-08-03', 'busy', 'uid-aug'],
  ], { maps, connectionId: CONN, occupancy: futureStaffOcc });
  ok('non-overlapping future staff block does not fail', nonOverlap.ok === true && nonOverlap.writes.length === 1);
  const appliedRange = applyProbePlan(nonOverlap, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(futureStaffOcc)),
  });
  ok('apply keeps unrelated future staff block',
    appliedRange.occupancy[BED_A].some((r) => r.booking_id === 'staff-1')
    && appliedRange.created.length === 1);

  const occ = {};
  const applied = applyProbePlan(plan, { connectionId: CONN, occupancy: occ });
  ok('apply creates owned XBLK', applied.created.length === 1 && occ[BED_A][0].assignment_type === lib.ASSIGNMENT_TYPE);
  ok('created row labeled owner schedule', occ[BED_A][0].guest_name === lib.CALENDAR_LEGEND_EN);

  const before = JSON.parse(JSON.stringify(occ));
  const failed = applyProbePlan(drift, { connectionId: CONN, occupancy: JSON.parse(JSON.stringify(occ)) });
  ok('failed probe does not instruct writes', (drift.writes || []).length === 0);
  ok('keep last on error', failed.keepLastBlocks === true);
  assert.deepStrictEqual(before[BED_A][0].booking_id, occ[BED_A][0].booking_id);

  const freePlan = lib.probeSheetRows([
    HEADERS,
    ['R1A', '2026-09-10', '2026-09-12', 'free', 'uid-1'],
  ], { maps, connectionId: CONN, occupancy: occ });
  const afterFree = applyProbePlan(freePlan, { connectionId: CONN, occupancy: JSON.parse(JSON.stringify(occ)) });
  ok('free cancels only owned XBLK', afterFree.cancelled.length === 1 && afterFree.occupancy[BED_A].length === 0);

  const mixedOcc = {
    [BED_A]: [guestRow(), occ[BED_A][0]],
  };
  const freeAgain = applyProbePlan(freePlan, { connectionId: CONN, occupancy: JSON.parse(JSON.stringify(mixedOcc)) });
  ok('free leaves guest stay', freeAgain.occupancy[BED_A].some((r) => r.booking_id === 'guest-1'));

  ok('calendar yellow swatch in portal CSS', /\.bc-legend-sw-owner_schedule_blocked\{/.test(api));
  ok('legend i18n key in HTML', /calendar\.legend\.ownerScheduleBlocked/.test(api));
  ok('color type maps external_inventory_block', /external_inventory_block/.test(api) && /owner_schedule_blocked/.test(api));
  ok('EN legend exact string', /'calendar\.legend\.ownerScheduleBlocked': 'Owner schedule blocked'/.test(i18n));
  ok('staff_block still grey blocked', /assignType === 'private_room_block' \|\| assignType === 'staff_block'\) return 'blocked'/.test(api));
  ok('no ICS adapter', !/kind IN \('ics'/.test(mig));
  ok('no gcal kind', !/gcal/.test(mig));
  ok('probe route exists', /\/staff\/luna-staff\/calendar-bridge\/probe/.test(api));
  ok('public probe does not send fabricated rows',
    /ownerScheduleBridgeJson\('\/staff\/luna-staff\/calendar-bridge\/probe', 'POST', \{\}\)/.test(api));
  ok('connection select + new action exist',
    /id="osb-connections"/.test(api) && /id="osb-new"/.test(api));
  ok('oldest connection fallback removed',
    !/ORDER BY c\.created_at ASC\s+LIMIT 1\s+FOR UPDATE OF c/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/lib/external-calendar-inventory-sync.js'), 'utf8')));
  ok('single spreadsheets.get snapshot',
    /includeGridData=true/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/external-calendar-inventory-sheets.js'), 'utf8')));
  ok('save/sync/enable/maps actions exist',
    /id="osb-save"/.test(api) && /id="osb-sync"/.test(api) && /id="osb-enable"/.test(api) && /id="osb-save-maps"/.test(api));
  ok('handler rejects caller authority', /rejectCallerAuthority/.test(api));
  ok('handler uses real probe', /handleRealProbe/.test(api));
  ok('FOR UPDATE OF c used', /FOR UPDATE OF c/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/external-calendar-inventory-sync.js'), 'utf8')));
  ok('089 last_error_code not raw last_error',
    /last_error_code text NULL/.test(mig) && /last_error_detail text NULL/.test(mig));
  ok('089 uses location_key + tenant_locations FK',
    /location_key text NULL/.test(mig) && /tenant_locations \(client_id, location_id\)/.test(mig));
  ok('089 has no uuid location_id', !/location_id uuid/.test(mig));
  ok('091 migration removed',
    !fs.existsSync(path.join(ROOT, 'database/migrations/091_external_calendar_location_key.sql')));

  const routes = require('./lib/external-calendar-inventory-routes');
  ok('routes refuse sunset', routes.refuseClient('sunset').ok === false);
  ok('routes refuse when flag off', routes.refuseClient('wolfhouse-somo').ok === false);
  const prevFlag = process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
  ok('routes allow wolfhouse when flag on', routes.refuseClient('wolfhouse-somo').ok === true);
  if (prevFlag === undefined) delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  else process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = prevFlag;

  console.log('\nverify-external-calendar-inventory: ALL CHECKS PASSED');
}

main();
