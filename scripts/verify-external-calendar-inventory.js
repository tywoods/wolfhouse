'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lib = require('./lib/external-calendar-inventory');
const { applyProbePlan } = require('./lib/external-calendar-inventory-apply');

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

function rgb(r, g, b, a) {
  const c = { red: r, green: g, blue: b };
  if (a != null) c.alpha = a;
  return c;
}
const FILL_WHITE = rgb(1, 1, 1);
const FILL_YELLOW = rgb(1, 0.85, 0.2);
const FILL_RED = rgb(0.86, 0.15, 0.12);

function occCell(opts) {
  opts = opts || {};
  const cell = {};
  if (Object.prototype.hasOwnProperty.call(opts, 'formattedValue')) {
    cell.formattedValue = opts.formattedValue;
  } else if (opts.text != null) {
    cell.formattedValue = opts.text;
  }
  if (opts.numberValue != null) {
    cell.effectiveValue = { numberValue: opts.numberValue };
  }
  if (opts.stringValue != null) {
    cell.effectiveValue = Object.assign(cell.effectiveValue || {}, { stringValue: opts.stringValue });
  }
  function paint(formatOpts) {
    if (!formatOpts) return undefined;
    const fmt = {};
    if (formatOpts.backgroundColor) fmt.backgroundColor = formatOpts.backgroundColor;
    if (formatOpts.backgroundColorStyle) fmt.backgroundColorStyle = formatOpts.backgroundColorStyle;
    return Object.keys(fmt).length ? fmt : undefined;
  }
  const effective = paint(opts.effective);
  const entered = paint(opts.entered);
  if (effective) cell.effectiveFormat = effective;
  if (entered) cell.userEnteredFormat = entered;
  if (opts.merged === true) cell.merged = true;
  return cell;
}

function occHeader(dates) {
  return [occCell({ text: '' })].concat(dates.map((d) => occCell({ text: d })));
}

function occBed(name, fills, texts) {
  return [occCell({ text: name })].concat(fills.map((fill, i) => {
    const cellOpts = { text: texts && texts[i] != null ? texts[i] : '' };
    if (fill && fill !== 'clear') {
      if (fill === true || fill === 'yellow') {
        cellOpts.effective = { backgroundColor: FILL_YELLOW };
      } else if (fill === 'red') {
        cellOpts.effective = { backgroundColor: FILL_RED };
      } else if (fill === 'white') {
        cellOpts.effective = { backgroundColor: FILL_WHITE };
      } else if (typeof fill === 'object') {
        Object.assign(cellOpts, fill);
      }
    }
    return occCell(cellOpts);
  }));
}

function occGrid(dates, beds) {
  return [occHeader(dates)].concat(beds.map((b) => occBed(b.name, b.fills, b.texts)));
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

  const good = occGrid(
    ['2026-09-10', '2026-09-11'],
    [{ name: 'R1A', fills: [true, true] }]
  );
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

  const vsStaff = lib.probeSheetRows(occGrid(
    ['2026-09-20', '2026-09-21'],
    [{ name: 'R1A', fills: [true, true] }]
  ), {
    maps, connectionId: CONN,
    occupancy: { [BED_A]: [staffBlock()] },
  });
  ok('busy vs overlapping staff_block fails entire sync',
    vsStaff.ok === false && vsStaff.writes.length === 0);

  const mixedGoodAndBad = lib.probeSheetRows(occGrid(
    ['2026-09-01', '10/09/2026'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN, occupancy: {} });
  ok('one malformed row fails whole sheet (zero writes)',
    mixedGoodAndBad.ok === false && mixedGoodAndBad.writes.length === 0);

  const drift = lib.probeSheetRows([['unit', 'start', 'end', 'status', 'id']], { maps, connectionId: CONN });
  ok('header drift errors with no writes', drift.ok === false && drift.writes.length === 0);

  const locale = lib.probeSheetRows(occGrid(
    ['10/09/2026', '12/09/2026'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN });
  ok('locale date fails closed', locale.ok === false);

  const serial = lib.probeSheetRows([
    [occCell({ text: '' }), occCell({ numberValue: 45910 }), occCell({ numberValue: 45912 })],
    occBed('R1A', [true, true]),
  ], { maps, connectionId: CONN });
  ok('excel serial fails closed', serial.ok === false);

  const merged = lib.probeSheetRows([
    occHeader(['2026-09-10', '2026-09-11']),
    [occCell({ text: 'R1A' }), occCell({ merged: true, effective: { backgroundColor: FILL_YELLOW } }), occCell({ effective: { backgroundColor: FILL_YELLOW } })],
  ], { maps, connectionId: CONN });
  ok('merged cells fail closed', merged.ok === false && merged.reason === 'merged_cells');

  const empty = lib.probeSheetRows(occGrid(['2026-09-10', '2026-09-11'], []), { maps, connectionId: CONN });
  ok('empty sheet is dry-run empty keep-last', empty.ok && empty.empty && empty.keepLastBlocks);

  const unmapped = lib.probeSheetRows(good, { maps: {}, connectionId: CONN });
  ok('unmapped unit fails entire sync', unmapped.ok === false && unmapped.writes.length === 0);

  ok('empty sheet does not become healthy',
    lib.nextConnectionStatus('pending', empty) === 'pending');

  const futureStaffOcc = { [BED_A]: [staffBlock()] };
  const nonOverlap = lib.probeSheetRows(occGrid(
    ['2026-08-01', '2026-08-02'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN, occupancy: futureStaffOcc });
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

  const freePlan = lib.probeSheetRows(occGrid(
    ['2026-09-10', '2026-09-11'],
    [{ name: 'R1A', fills: [false, false] }]
  ), { maps, connectionId: CONN, occupancy: occ });
  const afterFree = applyProbePlan(freePlan, { connectionId: CONN, occupancy: JSON.parse(JSON.stringify(occ)) });
  ok('free cancels only owned XBLK', afterFree.cancelled.length === 1 && afterFree.occupancy[BED_A].length === 0);

  const mixedOcc = {
    [BED_A]: [guestRow(), occ[BED_A][0]],
  };
  const freeAgain = applyProbePlan(freePlan, { connectionId: CONN, occupancy: JSON.parse(JSON.stringify(mixedOcc)) });
  ok('free leaves guest stay', freeAgain.occupancy[BED_A].some((r) => r.booking_id === 'guest-1'));

  ok('calendar yellow swatch in portal CSS', /\.bc-legend-sw-owner_schedule_blocked\{/.test(api));
  const legendHtml = api.slice(Math.max(0, api.indexOf('id="bc-legend"')), api.indexOf('id="bc-legend"') + 900);
  ok('legend omits owner-schedule item', legendHtml.includes('id="bc-legend"') && !legendHtml.includes('ownerScheduleBlocked'));
  ok('cell titles still use owner-schedule i18n', /t\('calendar\.legend\.ownerScheduleBlocked'\)/.test(api));
  ok('color type maps external_inventory_block', /external_inventory_block/.test(api) && /owner_schedule_blocked/.test(api));
  ok('EN legend exact string', /'calendar\.legend\.ownerScheduleBlocked': 'Owner schedule blocked'/.test(i18n));
  ok('staff_block still grey blocked', /assignType === 'private_room_block' \|\| assignType === 'staff_block'\) return 'blocked'/.test(api));
  ok('no ICS adapter', !/kind IN \('ics'/.test(mig));
  ok('no gcal kind', !/gcal/.test(mig));
  ok('probe route exists', /\/staff\/luna-staff\/calendar-bridge\/probe/.test(api));
  ok('delete route exists', /method === 'DELETE'/.test(api) && /handleDelete/.test(api));
  ok('remove action confirms then DELETE',
    /function ownerScheduleBridgeRemove\(\)\{/.test(api)
    && /window\.confirm\('Remove connected Sheet/.test(api)
    && /ownerScheduleBridgeJson\('\/staff\/luna-staff\/calendar-bridge', 'DELETE'/.test(api));
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
  ok('empty state connect CTA', /Connect Google Sheet/.test(api));
  ok('no invented browser secret', !/EXTERNAL_CALENDAR_SHEETS_SA/.test(api) && !/SECRET_REF/.test(api));
  ok('browser save does not send secret_ref', !/function ownerScheduleBridgeSave\(\)\{[\s\S]*?secret_ref/.test(api));
  ok('handler rejects caller authority', /rejectCallerAuthority/.test(api));
  ok('handler uses real probe', /handleRealProbe/.test(api));
  ok('FOR UPDATE OF c used', /FOR UPDATE OF c/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/external-calendar-inventory-sync.js'), 'utf8')));
  ok('089 occupancy is not in bridge migration',
    !/booking_beds_reject_overlap/.test(mig));
  ok('091 occupancy serialization exists',
    fs.existsSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization.sql')));
  const mig091 = fs.readFileSync(path.join(ROOT, 'database/migrations/091_booking_occupancy_serialization.sql'), 'utf8');
  ok('091 has no public _091 occupancy assert helpers',
    !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\._091_occupancy_assert_/i.test(mig091)
    && /DO\s+\$assert091\$/.test(mig091));
  ok('089 last_error_code not raw last_error',
    /last_error_code text NULL/.test(mig) && /last_error_detail text NULL/.test(mig));
  ok('089 uses location_key + tenant_locations FK',
    /location_key text NULL/.test(mig) && /tenant_locations \(client_id, location_id\)/.test(mig));
  ok('089 has no uuid location_id', !/location_id uuid/.test(mig));
  ok('091 migration removed',
    !fs.existsSync(path.join(ROOT, 'database/migrations/091_external_calendar_location_key.sql')));

  const routes = require('./lib/external-calendar-inventory-routes');
  ok('routes refuse sunset', routes.refuseClient('sunset').ok === false);
  ok('ECONNRESET is not stored', lib.storedErrorCode('ECONNRESET') === 'calendar_bridge_failed');
  ok('SQL text is not stored', lib.storedErrorCode('duplicate key value') === 'calendar_bridge_failed');
  ok('null stored error stays null', lib.storedErrorCode(null) === null);
  ok('known code stored as-is', lib.storedErrorCode('sheets_timeout') === 'sheets_timeout');
  ok('invalid_map stored as-is', lib.storedErrorCode('invalid_map') === 'invalid_map');
  ok('bed_not_in_tenant stored as-is', lib.storedErrorCode('bed_not_in_tenant') === 'bed_not_in_tenant');
  ok('maps_save_failed stored as-is', lib.storedErrorCode('maps_save_failed') === 'maps_save_failed');
  ok('date_header_order stored as-is', lib.storedErrorCode('date_header_order') === 'date_header_order');
  ok('date_header_order is public-safe', lib.PUBLIC_ERROR_CODES.indexOf('date_header_order') >= 0);
  ok('date_header_order has public-safe operator copy',
    /date_header_order: 'The Sheet dates are not in left-to-right order\. Last blocks were kept\.'/.test(api));
  ok('SQL payload is not a public skip code', lib.publicSkipCode('duplicate key value') === null);
  ok('allowlisted skip code kept', lib.publicSkipCode('unmapped_unit_key') === 'unmapped_unit_key');
  const nestedSkip = lib.sanitizeSkipped([{
    skip_reason: { nested: 'duplicate key value violates unique constraint bookings_pkey' },
    status: 'skipped_conflict',
    bed_id: 'bed-secret',
    connection_id: 'conn-internal',
    stack: 'Error: boom\n    at Object.<anonymous>',
  }]);
  ok('nested skip_reason object omitted',
    nestedSkip.length === 1
    && nestedSkip[0].status === 'skipped_conflict'
    && nestedSkip[0].skip_reason == null
    && nestedSkip[0].bed_id == null
    && nestedSkip[0].connection_id == null
    && nestedSkip[0].stack == null);
  const unknownSkip = lib.sanitizeSkipped([{ skip_reason: 'ECONNRESET', status: 'skipped_unmapped', unit_key: 'R1A', rowNumber: 2 }]);
  ok('unknown skip_reason omitted',
    unknownSkip.length === 1 && unknownSkip[0].skip_reason == null && unknownSkip[0].status === 'skipped_unmapped');
  const credSkip = lib.sanitizeSkipped([{
    skip_reason: 'ya29.access-token',
    access_token: 'ya29.secret',
    secret_ref: 'KV_LIVE_TOKEN',
    password: 'hunter2',
  }]);
  ok('provider payload skipped row does not copy credentials',
    credSkip.length === 1 && !/ya29|hunter2|KV_LIVE_TOKEN|secret_ref|access_token/.test(JSON.stringify(credSkip)));
  ok('audit fields strip SQL and stacks',
    lib.sanitizeAuditFields({
      error: 'relation "bookings" does not exist\n    at Parser.parse',
      reason: { skip_reason: 'duplicate key value' },
      skipped: [{ skip_reason: 'password=supersecret' }],
    }).error === 'calendar_bridge_failed');
  ok('audit fields keep allowlisted route codes',
    lib.sanitizeAuditFields({ error: 'invalid_map' }).error === 'invalid_map'
    && lib.sanitizeAuditFields({ reason: 'bed_not_in_tenant' }).error === 'bed_not_in_tenant'
    && lib.sanitizeAuditFields({ error: 'maps_save_failed' }).error === 'maps_save_failed');
  ok('staff-query-api audits through sanitizeAuditFields',
    /sanitizeAuditFields\(result\)/.test(api)
    && /error: auditSafe\.error/.test(api));
  ok('staff-query-api allowlists map route codes',
    /invalid_map:/.test(api) && /bed_not_in_tenant:/.test(api) && /maps_save_failed:/.test(api));
  ok('routes refuse when flag off', routes.refuseClient('wolfhouse-somo').ok === false);
  const prevFlag = process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = 'true';
  ok('routes allow wolfhouse when flag on', routes.refuseClient('wolfhouse-somo').ok === true);
  if (prevFlag === undefined) delete process.env.EXTERNAL_CALENDAR_INGEST_ENABLED;
  else process.env.EXTERNAL_CALENDAR_INGEST_ENABLED = prevFlag;

  // Occupancy color-grid contract (Sheet fill is booking authority).
  ok('occupancy fill helper exported', typeof lib.occupancyCellBooked === 'function');
  ok('clear/absent fill is available', lib.occupancyCellBooked({}) === false);
  ok('explicit white backgroundColor is available', lib.occupancyCellBooked(occCell({
    effective: { backgroundColor: FILL_WHITE },
  })) === false);
  ok('white rgb backgroundColorStyle is available', lib.occupancyCellBooked(occCell({
    effective: { backgroundColorStyle: { rgbColor: FILL_WHITE } },
  })) === false);
  ok('theme BACKGROUND fill is available', lib.occupancyCellBooked(occCell({
    effective: { backgroundColorStyle: { themeColor: 'BACKGROUND' } },
  })) === false);
  ok('transparent alpha-0 fill is available', lib.occupancyCellBooked(occCell({
    effective: { backgroundColor: rgb(1, 0, 0, 0) },
  })) === false);
  ok('non-white backgroundColor is booked', lib.occupancyCellBooked(occCell({
    effective: { backgroundColor: FILL_YELLOW },
  })) === true);
  ok('non-white backgroundColorStyle rgb is booked', lib.occupancyCellBooked(occCell({
    effective: { backgroundColorStyle: { rgbColor: FILL_RED } },
  })) === true);
  ok('non-default theme fill is booked', lib.occupancyCellBooked(occCell({
    effective: { backgroundColorStyle: { themeColor: 'ACCENT1' } },
  })) === true);
  ok('effectiveFormat wins over userEnteredFormat for conditional fill',
    lib.occupancyCellBooked(occCell({
      entered: { backgroundColor: FILL_WHITE },
      effective: { backgroundColor: FILL_YELLOW },
    })) === true);
  ok('conditional format that resolves to white is available',
    lib.occupancyCellBooked(occCell({
      entered: { backgroundColor: FILL_YELLOW },
      effective: { backgroundColor: FILL_WHITE },
    })) === false);
  ok('userEnteredFormat is used only when effectiveFormat is absent',
    lib.occupancyCellBooked(occCell({
      entered: { backgroundColor: FILL_RED },
    })) === true);

  const dates3 = ['2026-09-10', '2026-09-11', '2026-09-12'];
  const colorBusy = occGrid(dates3, [{ name: 'R1A', fills: [true, true, false] }]);
  const colorPlan = lib.probeSheetRows(colorBusy, { maps, connectionId: CONN, occupancy: {} });
  ok('colored consecutive cells coalesce to half-open range',
    colorPlan.ok === true
    && colorPlan.writes.length === 1
    && colorPlan.writes[0].action === 'insert_owned'
    && colorPlan.writes[0].start_date === '2026-09-10'
    && colorPlan.writes[0].end_date === '2026-09-12'
    && colorPlan.writes[0].unit_key === 'R1A');
  ok('color grid does not treat cell text as booking authority',
    lib.probeSheetRows(occGrid(dates3, [{
      name: 'R1A',
      fills: [false, false, false],
      texts: ['BOOKED', 'busy', 'uid-1'],
    }]), { maps, connectionId: CONN, occupancy: {} }).empty === true);
  ok('text in a colored cell still follows fill, not text',
    lib.probeSheetRows(occGrid(dates3, [{
      name: 'R1A',
      fills: [true, false, false],
      texts: ['AVAILABLE', '', ''],
    }]), { maps, connectionId: CONN, occupancy: {} }).writes[0].end_date === '2026-09-11');

  const split = lib.probeSheetRows(occGrid(dates3, [{
    name: 'R1A', fills: [true, false, true],
  }]), { maps, connectionId: CONN, occupancy: {} });
  ok('non-consecutive colored cells become two half-open ranges',
    split.ok && split.writes.length === 2
    && split.writes[0].start_date === '2026-09-10' && split.writes[0].end_date === '2026-09-11'
    && split.writes[1].start_date === '2026-09-12' && split.writes[1].end_date === '2026-09-13');

  const vsGuestColor = lib.probeSheetRows(colorBusy, {
    maps, connectionId: CONN,
    occupancy: { [BED_A]: [guestRow()] },
  });
  ok('colored overlap vs guest fails entire sync closed',
    vsGuestColor.ok === false && vsGuestColor.writes.length === 0 && vsGuestColor.keepLastBlocks === true);

  const vsStaffColor = lib.probeSheetRows(occGrid(
    ['2026-09-20', '2026-09-21'],
    [{ name: 'R1A', fills: [true, true] }]
  ), {
    maps, connectionId: CONN,
    occupancy: { [BED_A]: [staffBlock()] },
  });
  ok('colored overlap vs staff_block fails entire sync',
    vsStaffColor.ok === false && vsStaffColor.writes.length === 0);

  const dupDate = lib.probeSheetRows(occGrid(
    ['2026-09-10', '2026-09-10'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN });
  ok('duplicate date headers fail closed with no writes',
    dupDate.ok === false && dupDate.writes.length === 0 && dupDate.keepLastBlocks === true
    && dupDate.reason === 'date_header_duplicate');

  const descHeaders = lib.parseOccupancyDateHeaders(['', '2026-09-03', '2026-09-01']);
  ok('descending date headers fail closed as date_header_order',
    descHeaders.ok === false && descHeaders.reason === 'date_header_order' && descHeaders.dates.length === 0);

  const unsortedHeaders = lib.parseOccupancyDateHeaders(['', '2026-09-01', '2026-09-03', '2026-09-02']);
  ok('non-strictly-ascending date headers fail closed as date_header_order',
    unsortedHeaders.ok === false && unsortedHeaders.reason === 'date_header_order' && unsortedHeaders.dates.length === 0);

  const equalAdjacent = lib.parseOccupancyDateHeaders(['', '2026-09-01', '2026-09-01']);
  ok('adjacent duplicate dates keep date_header_duplicate',
    equalAdjacent.ok === false && equalAdjacent.reason === 'date_header_duplicate');

  const ascGapHeaders = lib.parseOccupancyDateHeaders(['', '2026-09-01', '2026-09-03']);
  ok('strictly ascending date headers with a gap still parse',
    ascGapHeaders.ok === true
    && ascGapHeaders.dates.map((d) => d.iso).join(',') === '2026-09-01,2026-09-03');

  const descProbe = lib.probeSheetRows(occGrid(
    ['2026-09-03', '2026-09-01'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN, occupancy: {} });
  ok('descending occupancy grid fails closed with zero writes',
    descProbe.ok === false
    && descProbe.reason === 'date_header_order'
    && descProbe.writes.length === 0
    && descProbe.keepLastBlocks === true);

  const badDate = lib.probeSheetRows(occGrid(
    ['2026-09-10', '10/09/2026'],
    [{ name: 'R1A', fills: [true, true] }]
  ), { maps, connectionId: CONN });
  ok('locale date headers fail closed',
    badDate.ok === false && badDate.writes.length === 0 && badDate.keepLastBlocks === true);

  const serialHeader = lib.probeSheetRows([
    [occCell({ text: '' }), occCell({ numberValue: 46266 })],
    occBed('R1A', [true]),
  ], { maps, connectionId: CONN });
  ok('excel serial date header fails closed',
    serialHeader.ok === false && serialHeader.writes.length === 0);

  const dupBed = lib.probeSheetRows(occGrid(dates3, [
    { name: 'R1A', fills: [true, false, false] },
    { name: 'R1A', fills: [false, true, false] },
  ]), { maps, connectionId: CONN });
  ok('duplicate bed names fail closed',
    dupBed.ok === false && dupBed.writes.length === 0 && dupBed.reason === 'duplicate_bed_name');

  const emptyNameColored = lib.probeSheetRows(occGrid(dates3, [
    { name: '', fills: [true, false, false] },
  ]), { maps, connectionId: CONN });
  ok('empty bed name with colored cells fails closed',
    emptyNameColored.ok === false && emptyNameColored.writes.length === 0);

  const emptyNameClear = lib.probeSheetRows(occGrid(dates3, [
    { name: '', fills: [false, false, false] },
    { name: 'R1A', fills: [true, false, false] },
  ]), { maps, connectionId: CONN, occupancy: {} });
  ok('empty clear bed row is skipped without deleting inventory',
    emptyNameClear.ok === true && emptyNameClear.writes.length === 1
    && emptyNameClear.writes[0].unit_key === 'R1A');

  const unmappedColor = lib.probeSheetRows(occGrid(dates3, [
    { name: 'UNKNOWN', fills: [true, false, false] },
  ]), { maps, connectionId: CONN });
  ok('unmapped colored row fails entire sync',
    unmappedColor.ok === false && unmappedColor.writes.length === 0
    && unmappedColor.keepLastBlocks === true
    && unmappedColor.reason === 'unmapped_unit_key');

  const emptyGrid = lib.probeSheetRows(occGrid(dates3, []), { maps, connectionId: CONN });
  ok('empty occupancy grid is dry-run empty keep-last',
    emptyGrid.ok && emptyGrid.empty && emptyGrid.keepLastBlocks
    && emptyGrid.writes.length === 0);

  const missingGrid = lib.probeSheetRows([], { maps, connectionId: CONN });
  ok('missing grid data fails closed keep-last',
    missingGrid.ok === false && missingGrid.keepLastBlocks === true && missingGrid.writes.length === 0);

  const unknown = lib.probeSheetRows([
    ['unit_key', 'start_date', 'end_date', 'status', 'external_uid'],
    ['R1A', '2026-09-10', '2026-09-12', 'busy', 'uid-1'],
  ], { maps, connectionId: CONN });
  ok('legacy text occupancy rows are unknown structure, not booking authority',
    unknown.ok === false && unknown.writes.length === 0 && unknown.keepLastBlocks === true);

  const ownedOcc = {
    [BED_A]: [{
      assignment_type: lib.ASSIGNMENT_TYPE,
      assignment_start_date: '2026-09-10',
      assignment_end_date: '2026-09-12',
      booking_id: 'xblk-keep',
      external_uid: 'grid:R1A:2026-09-10:2026-09-12',
      metadata: lib.buildOwnedBlockMetadata(CONN, 'grid:R1A:2026-09-10:2026-09-12'),
      status: 'blocked',
    }],
  };
  const cleared = lib.probeSheetRows(occGrid(dates3, [{
    name: 'R1A', fills: [false, false, false],
  }]), { maps, connectionId: CONN, occupancy: ownedOcc });
  ok('clearing colored cells cancels only owned blocks for this connection',
    cleared.ok === true
    && cleared.writes.some((w) => w.action === 'cancel_owned_if_present' && w.external_uid === 'grid:R1A:2026-09-10:2026-09-12')
    && !cleared.writes.some((w) => w.action === 'insert_owned' || w.action === 'upsert_owned'));
  const mixedKeep = {
    [BED_A]: [guestRow(), ownedOcc[BED_A][0], staffBlock()],
  };
  const afterClear = applyProbePlan(cleared, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(mixedKeep)),
  });
  ok('clear apply leaves guest stay and staff block',
    afterClear.occupancy[BED_A].some((r) => r.booking_id === 'guest-1')
    && afterClear.occupancy[BED_A].some((r) => r.booking_id === 'staff-1')
    && !afterClear.occupancy[BED_A].some((r) => r.booking_id === 'xblk-keep'));

  const malformedKeep = lib.probeSheetRows([['not', 'a', 'grid']], {
    maps, connectionId: CONN, occupancy: ownedOcc,
  });
  ok('malformed snapshot keeps last imported blocks',
    malformedKeep.ok === false && malformedKeep.keepLastBlocks === true && malformedKeep.writes.length === 0);

  function ownedBlock(opts) {
    opts = opts || {};
    const start = opts.start;
    const end = opts.end;
    const uid = opts.uid || ('grid:R1A:' + start + ':' + end);
    const conn = opts.connectionId || CONN;
    return {
      assignment_type: lib.ASSIGNMENT_TYPE,
      assignment_start_date: start,
      assignment_end_date: end,
      booking_id: opts.booking_id,
      external_uid: uid,
      metadata: lib.buildOwnedBlockMetadata(conn, uid),
      status: 'blocked',
    };
  }

  ok('occupancy signal helper treats color as visible',
    typeof lib.cellHasOccupancySignal === 'function'
    && lib.cellHasOccupancySignal(occCell({ effective: { backgroundColor: FILL_YELLOW } })) === true);
  ok('occupancy signal helper treats nonempty text as visible',
    lib.cellHasOccupancySignal(occCell({ text: 'NOTE' })) === true);
  ok('occupancy signal helper ignores trailing clear cells',
    lib.cellHasOccupancySignal(occCell({ text: '' })) === false
    && lib.cellHasOccupancySignal(occCell({ effective: { backgroundColor: FILL_WHITE } })) === false);

  const extraColorBody = [
    occHeader(['2026-09-10', '2026-09-11']),
    occBed('R1A', [true, true, 'yellow']),
  ];
  const extraColorPlan = lib.probeSheetRows(extraColorBody, { maps, connectionId: CONN, occupancy: ownedOcc });
  ok('colored extra body cell beyond date headers fails closed with zero writes',
    extraColorPlan.ok === false
    && extraColorPlan.writes.length === 0
    && extraColorPlan.keepLastBlocks === true
    && extraColorPlan.reason === 'header_unknown_column');

  const extraDataBody = [
    occHeader(['2026-09-10', '2026-09-11']),
    occBed('R1A', [true, true]).concat([occCell({ text: 'NOTE' })]),
  ];
  const extraDataPlan = lib.probeSheetRows(extraDataBody, { maps, connectionId: CONN, occupancy: ownedOcc });
  ok('nonempty extra body cell beyond date headers fails closed with zero writes',
    extraDataPlan.ok === false
    && extraDataPlan.writes.length === 0
    && extraDataPlan.keepLastBlocks === true
    && extraDataPlan.reason === 'header_unknown_column');

  const shortBody = [
    occHeader(['2026-09-10', '2026-09-11', '2026-09-12']),
    occBed('R1A', [true, true]),
  ];
  const shortPlan = lib.probeSheetRows(shortBody, { maps, connectionId: CONN, occupancy: {} });
  ok('shorter body row is trailing-clear and still syncs',
    shortPlan.ok === true
    && shortPlan.writes.length === 1
    && shortPlan.writes[0].start_date === '2026-09-10'
    && shortPlan.writes[0].end_date === '2026-09-12');

  const trailingClearBody = [
    occHeader(['2026-09-10', '2026-09-11']),
    occBed('R1A', [true, true, false, false]),
  ];
  const trailingClearPlan = lib.probeSheetRows(trailingClearBody, { maps, connectionId: CONN, occupancy: {} });
  ok('trailing clear cells beyond last date header are not a mismatch',
    trailingClearPlan.ok === true && trailingClearPlan.writes.length === 1);

  const septDates = ['2026-09-01', '2026-09-02', '2026-09-03'];
  ok('represented sheet window is half-open first/last header',
    typeof lib.representedSheetWindow === 'function'
    && JSON.stringify(lib.representedSheetWindow(septDates.map((iso, i) => ({ col: i + 1, iso }))))
      === JSON.stringify({ start: '2026-09-01', end: '2026-09-04' }));
  ok('represented window does not min/max-recover reversed headers',
    lib.representedSheetWindow(['2026-09-03', '2026-09-01']) == null
    && lib.representedSheetWindow(['2026-09-01', '2026-09-03', '2026-09-02']) == null);
  ok('interval subtract keeps fully-outside range',
    typeof lib.subtractHalfOpenRange === 'function'
    && JSON.stringify(lib.subtractHalfOpenRange('2026-10-01', '2026-10-10', '2026-09-01', '2026-09-04'))
      === JSON.stringify([{ start: '2026-10-01', end: '2026-10-10' }]));
  ok('interval subtract drops fully-inside range',
    JSON.stringify(lib.subtractHalfOpenRange('2026-09-02', '2026-09-04', '2026-09-01', '2026-09-04'))
      === JSON.stringify([]));
  ok('interval subtract keeps right remainder at window end',
    JSON.stringify(lib.subtractHalfOpenRange('2026-09-03', '2026-10-05', '2026-09-01', '2026-09-04'))
      === JSON.stringify([{ start: '2026-09-04', end: '2026-10-05' }]));
  ok('interval subtract keeps left remainder at window start',
    JSON.stringify(lib.subtractHalfOpenRange('2026-08-20', '2026-09-02', '2026-09-01', '2026-09-04'))
      === JSON.stringify([{ start: '2026-08-20', end: '2026-09-01' }]));
  ok('interval subtract splits a range that spans both sides of the window',
    JSON.stringify(lib.subtractHalfOpenRange('2026-08-20', '2026-10-05', '2026-09-01', '2026-09-04'))
      === JSON.stringify([
        { start: '2026-08-20', end: '2026-09-01' },
        { start: '2026-09-04', end: '2026-10-05' },
      ]));

  const septClear = occGrid(septDates, [{ name: 'R1A', fills: [false, false, false] }]);
  const octoberOwned = {
    [BED_A]: [ownedBlock({ start: '2026-10-01', end: '2026-10-10', booking_id: 'xblk-oct' })],
  };
  const outsidePlan = lib.probeSheetRows(septClear, {
    maps, connectionId: CONN, occupancy: octoberOwned,
  });
  ok('fully outside-window owned range is not cancelled',
    outsidePlan.ok === true
    && !outsidePlan.writes.some((w) => w.action === 'cancel_owned_if_present')
    && !outsidePlan.writes.some((w) => w.external_uid === 'grid:R1A:2026-10-01:2026-10-10'));
  const afterOutside = applyProbePlan(outsidePlan, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(octoberOwned)),
  });
  ok('September clear snapshot preserves October owned inventory',
    afterOutside.cancelled.length === 0
    && afterOutside.occupancy[BED_A].some((r) => r.booking_id === 'xblk-oct'
      && r.assignment_start_date === '2026-10-01'
      && r.assignment_end_date === '2026-10-10'));

  const rightStraddle = {
    [BED_A]: [ownedBlock({ start: '2026-09-03', end: '2026-10-05', booking_id: 'xblk-right' })],
  };
  const rightPlan = lib.probeSheetRows(septClear, {
    maps, connectionId: CONN, occupancy: rightStraddle,
  });
  const afterRight = applyProbePlan(rightPlan, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(rightStraddle)),
  });
  ok('right-boundary partial overlap keeps only the outside remainder',
    afterRight.occupancy[BED_A].length === 1
    && afterRight.occupancy[BED_A][0].assignment_start_date === '2026-09-04'
    && afterRight.occupancy[BED_A][0].assignment_end_date === '2026-10-05'
    && afterRight.occupancy[BED_A][0].booking_id !== 'xblk-right'
    && afterRight.occupancy[BED_A][0].assignment_type === lib.ASSIGNMENT_TYPE);

  const leftStraddle = {
    [BED_A]: [ownedBlock({ start: '2026-08-20', end: '2026-09-02', booking_id: 'xblk-left' })],
  };
  const afterLeft = applyProbePlan(lib.probeSheetRows(septClear, {
    maps, connectionId: CONN, occupancy: leftStraddle,
  }), {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(leftStraddle)),
  });
  ok('left-boundary partial overlap keeps only the outside remainder',
    afterLeft.occupancy[BED_A].length === 1
    && afterLeft.occupancy[BED_A][0].assignment_start_date === '2026-08-20'
    && afterLeft.occupancy[BED_A][0].assignment_end_date === '2026-09-01');

  const bothStraddle = {
    [BED_A]: [ownedBlock({ start: '2026-08-20', end: '2026-10-05', booking_id: 'xblk-both' })],
  };
  const afterBoth = applyProbePlan(lib.probeSheetRows(septClear, {
    maps, connectionId: CONN, occupancy: bothStraddle,
  }), {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(bothStraddle)),
  });
  const bothRanges = (afterBoth.occupancy[BED_A] || []).slice().sort((a, b) =>
    String(a.assignment_start_date).localeCompare(String(b.assignment_start_date)));
  ok('span across the window splits into two owned remainders',
    bothRanges.length === 2
    && bothRanges[0].assignment_start_date === '2026-08-20' && bothRanges[0].assignment_end_date === '2026-09-01'
    && bothRanges[1].assignment_start_date === '2026-09-04' && bothRanges[1].assignment_end_date === '2026-10-05');

  const mixedWindowOcc = {
    [BED_A]: [
      {
        assignment_type: 'manual',
        assignment_start_date: '2026-09-02',
        assignment_end_date: '2026-09-03',
        status: 'confirmed',
        booking_id: 'guest-sep',
      },
      staffBlock(),
      ownedBlock({ start: '2026-10-01', end: '2026-10-10', booking_id: 'xblk-oct' }),
      ownedBlock({
        start: '2026-09-01',
        end: '2026-09-02',
        booking_id: 'xblk-other',
        connectionId: 'conn-other',
      }),
    ],
  };
  const mixedWindowPlan = lib.probeSheetRows(septClear, {
    maps, connectionId: CONN, occupancy: mixedWindowOcc,
  });
  const afterMixedWindow = applyProbePlan(mixedWindowPlan, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(mixedWindowOcc)),
  });
  ok('window cancellation never clears guest, staff, or other-connection rows',
    afterMixedWindow.occupancy[BED_A].some((r) => r.booking_id === 'guest-sep')
    && afterMixedWindow.occupancy[BED_A].some((r) => r.booking_id === 'staff-1')
    && afterMixedWindow.occupancy[BED_A].some((r) => r.booking_id === 'xblk-other')
    && afterMixedWindow.occupancy[BED_A].some((r) => r.booking_id === 'xblk-oct'));

  const reversedOwned = {
    [BED_A]: [ownedBlock({ start: '2026-09-01', end: '2026-09-04', booking_id: 'xblk-reversed' })],
  };
  const reversedPlan = lib.probeSheetRows(occGrid(
    ['2026-09-03', '2026-09-01'],
    [{ name: 'R1A', fills: [false, false] }]
  ), { maps, connectionId: CONN, occupancy: reversedOwned });
  ok('reversed date headers fail closed with zero writes and keep-last',
    reversedPlan.ok === false
    && reversedPlan.reason === 'date_header_order'
    && reversedPlan.writes.length === 0
    && reversedPlan.keepLastBlocks === true
    && reversedPlan.writes.every((w) => w.action !== 'cancel_owned_if_present'));
  const afterReversed = applyProbePlan(reversedPlan, {
    connectionId: CONN,
    occupancy: JSON.parse(JSON.stringify(reversedOwned)),
  });
  ok('reversed headers do not cancel the existing owned September block',
    afterReversed.cancelled.length === 0
    && afterReversed.wrote === false
    && afterReversed.keepLastBlocks === true
    && afterReversed.occupancy[BED_A].some((r) => r.booking_id === 'xblk-reversed'
      && r.assignment_start_date === '2026-09-01'
      && r.assignment_end_date === '2026-09-04'));

  const shuffledPlan = lib.probeSheetRows(occGrid(
    ['2026-09-01', '2026-09-03', '2026-09-02'],
    [{ name: 'R1A', fills: [true, true, true] }]
  ), { maps, connectionId: CONN, occupancy: reversedOwned });
  ok('shuffled non-ascending headers fail closed with zero writes',
    shuffledPlan.ok === false
    && shuffledPlan.reason === 'date_header_order'
    && shuffledPlan.writes.length === 0
    && shuffledPlan.keepLastBlocks === true);

  console.log('\nverify-external-calendar-inventory: ALL CHECKS PASSED');
}

main();
