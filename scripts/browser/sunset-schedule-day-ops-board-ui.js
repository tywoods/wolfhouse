'use strict';

/**
 * Sunset Schedule — day-view operations board UI (Slice 18).
 *
 * Injected after portal and drawer modules. Owns day-view #ps-ops-board HTML,
 * booking chip presentation, empty state, and rerender-safe chip click wiring.
 *
 * Consumes rows via scheduleResolveRow (canonical + presentation indexes).
 * Does not fetch Schedule data, compute prices, or own drawer lifecycle.
 *
 * Requires portal globals: portalT, escHtml, el, scheduleEnsureRowId,
 * scheduleBuildDaySessions, scheduleBuildDisplayGroups, scheduleGroupIsStandaloneRental,
 * scheduleRentalPickupKind, scheduleGroupBoardsNeeded, scheduleGroupWetsuitsNeeded,
 * scheduleGroupHasPrivateLesson, scheduleGroupHasLesson, scheduleGroupHasCourse,
 * scheduleGroupComponentQty, scheduleRowSourceKind, scheduleRowSourceAriaLabel,
 * scheduleRenderStatusBadgeHtml, scheduleFormatSlotTimeRange, scheduleMinutesLabel,
 * scheduleSourceSplit, scheduleTodayIso, scheduleCoursesCache, scheduleLessonTimesFallback,
 * scheduleActiveDayIso, openScheduleDetailDrawer, openScheduleCreateModal,
 * scheduleOnCreateComponentChange, schedulePopulateCreateCourseFields, scheduleResolveRow.
 */

/**
 * Course-owned equipment rows on a display group (persisted CE service metadata).
 * Only rows with course_equipment=true. Never invents labels from
 * canonical/standalone rentals (rental_offering / generic_rental).
 *
 * Association scope: scheduleCourseAggregates already scopes records to the
 * same booking day and the active course session (peer Group courses excluded).
 * Create/Edit persists CE as booking-shared selection authorized for all
 * selected courses; metadata.course_id is the primary pack stamp only.
 */
function scheduleDayOpsCourseEquipmentRows(group){
  var records = group && Array.isArray(group.records) ? group.records : [];
  var out = [];
  for (var i = 0; i < records.length; i++) {
    var row = records[i];
    var meta = scheduleDayOpsParseMetaBlob(row && (row.metadata || row._meta));
    if (meta.course_equipment !== true) continue;
    // Never treat standalone generic rentals as course equipment.
    if (meta.rental_offering === true || meta.generic_rental === true) continue;
    out.push({ row: row, meta: meta });
  }
  return out;
}

/**
 * Course-equipment selection mode for a display group.
 * Returns 'during_course' | 'all_day' | null. Prefer All Day when any CE row is all_day.
 */
function scheduleDayOpsCourseEquipmentMode(group){
  var mode = null;
  var items = scheduleDayOpsCourseEquipmentRows(group);
  for (var i = 0; i < items.length; i++) {
    if (items[i].meta.course_equipment_mode === 'all_day') return 'all_day';
    mode = 'during_course';
  }
  return mode;
}

/**
 * Friendly rental/CE label (browser projection of scripts/lib/rental-offering-label.js).
 * Precedence: offering_label → catalog_label → display_name → label → service_name
 * → humanized offering_key. Never emit bare key when a friendly form exists.
 */
function scheduleDayOpsFriendlyOfferingLabel(meta, offeringKey){
  var m = meta || {};
  var key = String(offeringKey != null ? offeringKey : (m.offering_key || '')).trim();
  var itemCode = String(m.item_code || m.offering_item_code || '').trim();
  var candidates = [
    m.offering_label, m.catalog_label, m.display_name, m.label, m.service_name,
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] == null) continue;
    var text = String(candidates[i]).trim();
    if (!text) continue;
    var lower = text.toLowerCase();
    if (lower === 'addon_service' || lower === 'rental') continue;
    // Reject identity-like labels (raw key / item_code).
    if (key && lower === key.toLowerCase()) continue;
    if (itemCode && lower === itemCode.toLowerCase()) continue;
    if (key && lower.indexOf(key.toLowerCase() + '__') === 0) continue;
    return text;
  }
  if (!key) return '';
  if (key === 'board_rental') return 'Surfboard';
  if (key === 'wetsuit_rental') return 'Wetsuit';
  if (typeof scheduleHumanizeRentalOfferingKey === 'function') {
    return scheduleHumanizeRentalOfferingKey(key) || key;
  }
  return key.replace(/_rental$/i, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, function(c){
    return c.toUpperCase();
  }) || key;
}

/**
 * Compact card label: Admin-owned equipment label + mode.
 * Example: "Surfboard + Wetsuit · During Course". Multi-item CE joins with " · ".
 * "No equipment" only when this course's group truly has no CE rows.
 */
function scheduleDayOpsEquipmentPrepLabel(group){
  var items = scheduleDayOpsCourseEquipmentRows(group);
  if (items.length) {
    var parts = [];
    var seen = {};
    for (var i = 0; i < items.length; i++) {
      var meta = items[i].meta;
      var name = scheduleDayOpsFriendlyOfferingLabel(meta) || 'Equipment';
      var modeKey = meta.course_equipment_mode === 'all_day' ? 'all_day' : 'during_course';
      var modeLabel = portalT(
        modeKey === 'all_day'
          ? 'schedule.courseEquipment.allDay'
          : 'schedule.courseEquipment.during',
      );
      var part = name + ' · ' + modeLabel;
      if (seen[part]) continue;
      seen[part] = true;
      parts.push(part);
    }
    if (parts.length) return parts.join(' · ');
  }
  var boards = scheduleGroupBoardsNeeded(group);
  var wets = scheduleGroupWetsuitsNeeded(group);
  if (boards && wets) return portalT('schedule.equipment.boardAndWetsuit');
  if (boards) return portalT('schedule.equipment.board');
  if (wets) return portalT('schedule.equipment.wetsuit');
  return portalT('schedule.equipment.none');
}

/** YYYY-MM-DD token or empty. */
function scheduleDayOpsIsoDateToken(raw){
  var s = String(raw == null ? '' : raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function scheduleDayOpsParseMetaBlob(raw){
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/**
 * True when a service record is a standalone rental pickup line.
 * Scope is SERVICE RECORD identity — never booking type / course presence.
 * Excludes course_equipment and non-rental addon_service (e.g. meals).
 */
function scheduleIsStandaloneRentalPickupRecord(row){
  if (!row) return false;
  var meta = scheduleDayOpsParseMetaBlob(row.metadata || row._meta);
  if (meta.course_equipment === true) return false;
  // Exact rental metadata identity (preferred).
  if (meta.rental_offering === true || meta.generic_rental === true) return true;
  var st = String(row.service_type || '').toLowerCase();
  var ui = String(meta.staff_ui_service_type || row.staff_ui_service_type || '').toLowerCase();
  var key = String(meta.offering_key || '').trim();
  // service_type rental / staff_ui rental with offering key.
  if ((st === 'rental' || ui === 'rental') && key) return true;
  // addon_service only when stamped as a rental offering with rental identity markers
  // (duration/item_code/unit) — never bare catalog meals/etc.
  if (st === 'addon_service' && key && ui === 'rental'
    && (meta.duration_key || meta.item_code || meta.unit_cents != null)) {
    return true;
  }
  return false;
}

function scheduleGenericRentalDescriptors(group){
  var byKey = {};
  var records = group && Array.isArray(group.records) ? group.records : [];
  records.forEach(function(row){
    if (!scheduleIsStandaloneRentalPickupRecord(row)) return;
    var meta = scheduleDayOpsParseMetaBlob(row && (row.metadata || row._meta));
    var key = String(meta.offering_key || meta.offering_id || '').trim();
    if (!key) return;
    var label = scheduleDayOpsFriendlyOfferingLabel(meta, key) || key;
    if (!byKey[key]) byKey[key] = { offering_key: key, label: label, quantity: 0 };
    byKey[key].quantity += Math.max(1, Number(row.quantity) || 1);
  });
  return Object.keys(byKey).sort().map(function(key){ return byKey[key]; });
}

function scheduleGenericRentalDescriptor(group){
  return scheduleGenericRentalDescriptors(group)[0] || null;
}

/** Rental pickups panel UI state (sort + filter). Survives board re-renders. */
var scheduleRentalPickupsSortMode = 'guest';
var scheduleRentalPickupsGuestFilter = '';
var scheduleRentalPickupsRenderCtx = { pack: null, dateIso: '' };

try {
  var _rpSortStored = sessionStorage.getItem('sunset.schedule.rentalPickupsSort');
  if (_rpSortStored === 'guest' || _rpSortStored === 'item') scheduleRentalPickupsSortMode = _rpSortStored;
} catch (_) {}

function scheduleRentalPickupsNormName(name){
  var s = String(name == null ? '' : name).trim();
  try {
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (_) {}
  return s.toLowerCase();
}

function scheduleRentalPickupsCompareLabel(a, b){
  var aa = scheduleRentalPickupsNormName(a);
  var bb = scheduleRentalPickupsNormName(b);
  if (aa < bb) return -1;
  if (aa > bb) return 1;
  var rawA = String(a == null ? '' : a);
  var rawB = String(b == null ? '' : b);
  if (rawA < rawB) return -1;
  if (rawA > rawB) return 1;
  return 0;
}

function scheduleGroupHasClassicRentalComponents(group){
  if (!group) return false;
  var records = Array.isArray(group.records) ? group.records : [];
  var hasClassicRow = false;
  for (var i = 0; i < records.length; i++) {
    var row = records[i];
    var meta = scheduleDayOpsParseMetaBlob(row && (row.metadata || row._meta));
    // Never treat course equipment as classic rental pickups.
    if (meta.course_equipment === true) continue;
    if (meta.rental_offering === true || meta.generic_rental === true) continue;
    var comp = String(meta.component || row && row.service_type || '').toLowerCase();
    if (comp === 'surfboard' || comp === 'board' || comp === 'surfboard_rental' || comp === 'board_rental') {
      hasClassicRow = true;
      break;
    }
    if (comp === 'wetsuit' || comp === 'wetsuit_rental') {
      hasClassicRow = true;
      break;
    }
    var st = String(row && row.service_type || '').toLowerCase();
    if (st === 'surfboard' || st === 'wetsuit' || /surfboard|wetsuit/.test(st)) {
      hasClassicRow = true;
      break;
    }
  }
  if (hasClassicRow) return true;
  // Group component flags only when records confirm classic gear (avoid CE false positive).
  if (group.components && (group.components.surfboard || group.components.wetsuit) && records.length === 0) {
    return true;
  }
  return false;
}

/**
 * Display group has any service-record-scoped rental pickups (standalone
 * generic catalog lines and/or classic board/wetsuit). Booking may also own
 * courses/lessons — never gate on pure-standalone booking type.
 */
function scheduleGroupHasRentalPickups(group){
  if (!group) return false;
  if (group._isCancelled || group.schedule_ghost) return false;
  if (scheduleGenericRentalDescriptors(group).length > 0) return true;
  if (scheduleGroupHasClassicRentalComponents(group)) {
    var kind = typeof scheduleRentalPickupKind === 'function' ? scheduleRentalPickupKind(group) : null;
    if (kind === 'both' || kind === 'board' || kind === 'wetsuit') return true;
    // Classic rows present even if pickup-kind helper unavailable.
    return true;
  }
  return false;
}

/**
 * Select display groups for Rental Pickups Today by service-record content,
 * not booking type. Includes course bookings that own standalone rental add-ons.
 */
function scheduleSelectRentalPickupGroups(rows){
  var groups = typeof scheduleBuildDisplayGroups === 'function'
    ? scheduleBuildDisplayGroups(rows)
    : [];
  return (groups || []).filter(scheduleGroupHasRentalPickups);
}

/**
 * Flat pickup lines from standalone rental groups only.
 * One shared list drives Guest + Item views (no hard-coded section buckets).
 * Classic board/wetsuit pair emits only when the same group has classic components;
 * generic/catalog offerings always emit via offering_key.
 */
function scheduleBuildRentalPickupLines(gearGroups){
  var lines = [];
  (gearGroups || []).forEach(function(g){
    if (g && (g._isCancelled || g.schedule_ghost)) return;
    if (!g) return;
    scheduleEnsureRowId(g);
    var guestName = String(g.guest_name || 'Guest').trim() || 'Guest';
    var scheduleId = String(g._scheduleId || g.service_record_id || g.booking_id || '');
    var bookingId = String(g.booking_id || '');
    var generics = scheduleGenericRentalDescriptors(g);
    generics.forEach(function(desc){
      if (!desc || !desc.offering_key) return;
      lines.push({
        guestName: guestName,
        guestNameKey: scheduleRentalPickupsNormName(guestName),
        itemKey: 'offering:' + String(desc.offering_key),
        itemLabel: String(desc.label || desc.offering_key),
        offeringKey: String(desc.offering_key),
        quantity: Math.max(1, Number(desc.quantity) || 1),
        scheduleId: scheduleId,
        bookingId: bookingId,
        group: g,
      });
    });
    if (scheduleGroupHasClassicRentalComponents(g)) {
      var kind = typeof scheduleRentalPickupKind === 'function' ? scheduleRentalPickupKind(g) : null;
      if (kind === 'both' || kind === 'board' || kind === 'wetsuit') {
        var itemKey = 'pair:' + kind;
        var itemLabel = kind === 'both'
          ? portalT('schedule.ops.rentalBoth')
          : (kind === 'board' ? portalT('schedule.ops.rentalBoardsOnly') : portalT('schedule.ops.rentalWetsuitsOnly'));
        var qty = 1;
        if (kind === 'both') {
          qty = Math.max(
            1,
            Number(scheduleGroupBoardsNeeded(g)) || 0,
            Number(scheduleGroupWetsuitsNeeded(g)) || 0,
            Number(g.quantity) || 0
          );
        } else if (kind === 'board') {
          qty = Math.max(1, Number(scheduleGroupBoardsNeeded(g)) || 0, Number(g.quantity) || 0);
        } else {
          qty = Math.max(1, Number(scheduleGroupWetsuitsNeeded(g)) || 0, Number(g.quantity) || 0);
        }
        lines.push({
          guestName: guestName,
          guestNameKey: scheduleRentalPickupsNormName(guestName),
          itemKey: itemKey,
          itemLabel: itemLabel,
          offeringKey: '',
          quantity: qty,
          scheduleId: scheduleId,
          bookingId: bookingId,
          group: g,
        });
      }
    }
  });
  return lines;
}

function scheduleRenderRentalPickupsHeader(sortMode, filterText){
  var guestOn = sortMode === 'guest';
  var itemOn = sortMode === 'item';
  var html = '<header class="portal-schedule-ops-rental-pickups-hdr">' +
    '<span class="portal-schedule-ops-rental-pickups-title">' + escHtml(portalT('schedule.ops.rentalPickupsToday')) + '</span>' +
    '<div class="portal-schedule-ops-rental-pickups-tools">';
  // Filter first (left of Guest/Item) — only in guest sort mode.
  if (guestOn) {
    html += '<label class="portal-schedule-ops-rental-filter">' +
      '<span class="sr-only">' + escHtml(portalT('schedule.ops.rentalFilterGuest')) + '</span>' +
      '<input type="search" class="portal-schedule-ops-rental-filter-input" data-rp-filter="guest" ' +
      'placeholder="' + escHtml(portalT('schedule.ops.rentalFilterGuest')) + '" ' +
      'value="' + escHtml(filterText || '') + '" autocomplete="off" />' +
      '</label>';
  }
  html += '<div class="portal-schedule-ops-rental-sort" role="group" aria-label="' + escHtml(portalT('schedule.ops.rentalSortAria')) + '">' +
    '<button type="button" class="portal-schedule-ops-rental-sort-btn' + (guestOn ? ' is-active' : '') + '" data-rp-sort="guest">' +
    escHtml(portalT('schedule.ops.rentalSortGuest')) + '</button>' +
    '<button type="button" class="portal-schedule-ops-rental-sort-btn' + (itemOn ? ' is-active' : '') + '" data-rp-sort="item">' +
    escHtml(portalT('schedule.ops.rentalSortItem')) + '</button>' +
    '</div>';
  html += '</div></header>';
  return html;
}

function scheduleRenderRentalPickupLineRow(line, opts){
  opts = opts || {};
  var g = line.group || {};
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var rowSrcCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var railCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var ariaLabel = scheduleRowSourceAriaLabel(g);
  var chipCls = src === 'staff' ? 'is-staff' : 'is-luna';
  var chipLabel = src === 'staff' ? portalT('schedule.legend.staff')
    : src === 'demo' ? portalT('schedule.source.demo')
    : portalT('schedule.legend.luna');
  var primary = opts.primaryLabel != null ? opts.primaryLabel : line.guestName;
  var sub = opts.subLabel != null ? opts.subLabel : line.itemLabel;
  var qty = Math.max(1, Number(line.quantity) || 1);
  var offeringAttr = line.offeringKey
    ? ' data-rental-offering="' + escHtml(line.offeringKey) + '"'
    : (line.itemKey ? ' data-rental-item="' + escHtml(line.itemKey) + '"' : '');
  return '<div class="portal-schedule-ops-row' + rowSrcCls + (g._needsReply ? ' needs-reply' : '') +
    '" data-ps-booking-id="' + escHtml(g._scheduleId || line.scheduleId) + '"' + offeringAttr +
    ' title="' + escHtml(ariaLabel) + '" aria-label="' + escHtml(ariaLabel) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty) + '×') + '</span>' +
    '<div class="portal-schedule-ops-row-guest-col">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(primary) + '</span>' +
    (sub ? '<span class="portal-schedule-ops-row-equip-sub">' + escHtml(sub) + '</span>' : '') +
    '</div>' +
    '<span class="portal-schedule-src-chip ' + chipCls + '"><i aria-hidden="true"></i>' + escHtml(chipLabel) + '</span>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleDayOpsRowStatusHtml(g) + '</span>' +
    '</div>';
}

function scheduleRenderRentalPickupsByGuest(lines, filterText){
  var filterKey = scheduleRentalPickupsNormName(filterText || '');
  var byBooking = {};
  var order = [];
  (lines || []).forEach(function(line){
    if (filterKey && line.guestNameKey.indexOf(filterKey) === -1) return;
    var id = line.scheduleId || line.bookingId || (line.guestNameKey + ':' + Math.random());
    if (!byBooking[id]) {
      byBooking[id] = { id: id, guestName: line.guestName, guestNameKey: line.guestNameKey, group: line.group, lines: [] };
      order.push(id);
    }
    byBooking[id].lines.push(line);
  });
  order.sort(function(a, b){
    var ca = scheduleRentalPickupsCompareLabel(byBooking[a].guestName, byBooking[b].guestName);
    if (ca) return ca;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  if (!order.length) {
    var emptyKey = filterKey ? 'schedule.ops.rentalFilterEmpty' : 'schedule.ops.rentalNothingScheduled';
    return '<div class="portal-schedule-ops-rental-pickups-empty">' + escHtml(portalT(emptyKey)) + '</div>';
  }
  var html = '';
  order.forEach(function(id){
    var bucket = byBooking[id];
    bucket.lines.sort(function(x, y){
      var c = scheduleRentalPickupsCompareLabel(x.itemLabel, y.itemLabel);
      if (c) return c;
      if (x.itemKey < y.itemKey) return -1;
      if (x.itemKey > y.itemKey) return 1;
      return 0;
    });
    var g = bucket.group || {};
    scheduleEnsureRowId(g);
    var src = scheduleRowSourceKind(g);
    var chipCls = src === 'staff' ? 'is-staff' : 'is-luna';
    var chipLabel = src === 'staff' ? portalT('schedule.legend.staff')
      : src === 'demo' ? portalT('schedule.source.demo')
      : portalT('schedule.legend.luna');
    html += '<div class="portal-schedule-ops-rental-pickups-block" data-rp-guest-block="' + escHtml(id) + '">' +
      '<div class="portal-schedule-ops-rental-pickups-subhdr portal-schedule-ops-rental-guest-hdr">' +
      '<button type="button" class="portal-schedule-ops-rental-guest-open" data-ps-booking-id="' + escHtml(g._scheduleId || id) + '">' +
      escHtml(bucket.guestName) + '</button>' +
      '<span class="portal-schedule-src-chip ' + chipCls + '"><i aria-hidden="true"></i>' + escHtml(chipLabel) + '</span>' +
      '<span class="portal-schedule-ops-row-status">' + scheduleDayOpsRowStatusHtml(g) + '</span>' +
      '</div>' +
      '<div class="portal-schedule-ops-lesson-rows portal-schedule-ops-rental-item-lines">';
    bucket.lines.forEach(function(line){
      html += scheduleRenderRentalPickupLineRow(line, {
        primaryLabel: line.itemLabel,
        subLabel: '',
      });
    });
    html += '</div></div>';
  });
  return html;
}

function scheduleRenderRentalPickupsByItem(lines){
  var byItem = {};
  var order = [];
  (lines || []).forEach(function(line){
    var key = line.itemKey || ('label:' + line.itemLabel);
    if (!byItem[key]) {
      byItem[key] = { itemKey: key, itemLabel: line.itemLabel, offeringKey: line.offeringKey || '', lines: [], totalQty: 0 };
      order.push(key);
    }
    byItem[key].lines.push(line);
    byItem[key].totalQty += Math.max(1, Number(line.quantity) || 1);
  });
  order.sort(function(a, b){
    var c = scheduleRentalPickupsCompareLabel(byItem[a].itemLabel, byItem[b].itemLabel);
    if (c) return c;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  if (!order.length) {
    return '<div class="portal-schedule-ops-rental-pickups-empty">' + escHtml(portalT('schedule.ops.rentalNothingScheduled')) + '</div>';
  }
  var html = '';
  order.forEach(function(key){
    var bucket = byItem[key];
    bucket.lines.sort(function(x, y){
      var c = scheduleRentalPickupsCompareLabel(x.guestName, y.guestName);
      if (c) return c;
      var sx = String(x.scheduleId || '');
      var sy = String(y.scheduleId || '');
      if (sx < sy) return -1;
      if (sx > sy) return 1;
      return 0;
    });
    var offeringAttr = bucket.offeringKey
      ? ' data-rental-offering="' + escHtml(bucket.offeringKey) + '"'
      : ' data-rental-item="' + escHtml(bucket.itemKey) + '"';
    html += '<div class="portal-schedule-ops-rental-pickups-block"' + offeringAttr + '>' +
      '<div class="portal-schedule-ops-rental-pickups-subhdr">' +
      escHtml(bucket.itemLabel + ' — ' + String(bucket.totalQty)) + '</div>' +
      '<div class="portal-schedule-ops-lesson-rows">';
    bucket.lines.forEach(function(line){
      html += scheduleRenderRentalPickupLineRow(line, {
        primaryLabel: line.guestName,
        subLabel: '',
      });
    });
    html += '</div></div>';
  });
  return html;
}

function scheduleRenderRentalPickupsSection(gearGroups){
  var lines = scheduleBuildRentalPickupLines(gearGroups);
  if (!lines.length && !(gearGroups || []).length) return '';
  var sortMode = scheduleRentalPickupsSortMode === 'item' ? 'item' : 'guest';
  var filterText = scheduleRentalPickupsGuestFilter || '';
  var body = sortMode === 'item'
    ? scheduleRenderRentalPickupsByItem(lines)
    : scheduleRenderRentalPickupsByGuest(lines, filterText);
  if (!lines.length) {
    body = '<div class="portal-schedule-ops-rental-pickups-empty">' + escHtml(portalT('schedule.ops.rentalNothingScheduled')) + '</div>';
  }
  return '<section class="portal-schedule-ops-rental-pickups" data-rp-sort="' + escHtml(sortMode) + '">' +
    scheduleRenderRentalPickupsHeader(sortMode, filterText) +
    body +
    '</section>';
}

function scheduleWireRentalPickupsControls(container){
  if (!container) return;
  container.querySelectorAll('button[data-rp-sort]').forEach(function(btn){
    if (btn.dataset.rpSortWired) return;
    btn.dataset.rpSortWired = '1';
    btn.addEventListener('click', function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      var mode = btn.getAttribute('data-rp-sort') === 'item' ? 'item' : 'guest';
      if (scheduleRentalPickupsSortMode === mode) return;
      scheduleRentalPickupsSortMode = mode;
      try { sessionStorage.setItem('sunset.schedule.rentalPickupsSort', mode); } catch (_) {}
      scheduleRerenderDayOpsBoardFromCtx({ restoreFilterFocus: mode === 'guest' });
    });
  });
  var filterInput = container.querySelector('[data-rp-filter="guest"]');
  if (filterInput && !filterInput.dataset.rpFilterWired) {
    filterInput.dataset.rpFilterWired = '1';
    filterInput.addEventListener('input', function(){
      scheduleRentalPickupsGuestFilter = String(filterInput.value || '');
      scheduleRerenderDayOpsBoardFromCtx({ restoreFilterFocus: true });
    });
  }
}

function scheduleRerenderDayOpsBoardFromCtx(opts){
  opts = opts || {};
  var ctx = scheduleRentalPickupsRenderCtx || {};
  if (!ctx.pack) return;
  var selStart = null;
  var selEnd = null;
  var hadFocus = false;
  if (opts.restoreFilterFocus && typeof document !== 'undefined' && document.querySelector) {
    var prev = document.querySelector('[data-rp-filter="guest"]');
    if (prev && document.activeElement === prev) {
      hadFocus = true;
      try {
        selStart = prev.selectionStart;
        selEnd = prev.selectionEnd;
      } catch (_) {}
    }
  }
  renderScheduleDayOpsBoard(ctx.pack, ctx.dateIso);
  if (hadFocus && typeof document !== 'undefined' && document.querySelector) {
    var next = document.querySelector('[data-rp-filter="guest"]');
    if (next) {
      try { next.focus(); } catch (_) {}
      try {
        if (selStart != null && selEnd != null) next.setSelectionRange(selStart, selEnd);
      } catch (_) {}
    }
  }
}


/**
 * Canonical sorted unique booked service dates for a Today card group.
 * Prefer authoritative explicit date arrays; fall back to inclusive from/to.
 * Never invent a span from course duration alone when date data is missing/conflicting.
 */
function scheduleCanonicalBookedServiceDates(group){
  var explicit = {};
  var hasExplicit = false;
  var fromTo = { from: '', to: '' };
  var singles = {};

  function addExplicit(d){
    var iso = scheduleDayOpsIsoDateToken(d);
    if (!iso) return;
    explicit[iso] = true;
    hasExplicit = true;
  }
  function addExplicitArr(arr){
    if (!Array.isArray(arr)) return;
    for (var i = 0; i < arr.length; i += 1) addExplicit(arr[i]);
  }
  function absorbObj(obj){
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj.service_dates) && obj.service_dates.length){
      addExplicitArr(obj.service_dates);
    }
    if (Array.isArray(obj.booking_service_dates) && obj.booking_service_dates.length){
      addExplicitArr(obj.booking_service_dates);
    }
    if (Array.isArray(obj.rental_service_dates) && obj.rental_service_dates.length){
      addExplicitArr(obj.rental_service_dates);
    }
    if (Array.isArray(obj.covered_dates) && obj.covered_dates.length){
      addExplicitArr(obj.covered_dates);
    }
    // Multi-lesson / multi-day course bookings: declared lesson dates are authoritative.
    if (Array.isArray(obj.lessons) && obj.lessons.length){
      for (var li = 0; li < obj.lessons.length; li += 1){
        var lesson = obj.lessons[li];
        if (!lesson) continue;
        addExplicit(lesson.date || lesson.service_date);
      }
    }
    var pl = obj.components && obj.components.private_lesson;
    if (pl && Array.isArray(pl.sessions)){
      for (var s = 0; s < pl.sessions.length; s += 1){
        if (pl.sessions[s]) addExplicit(pl.sessions[s].date);
      }
    }
    var df = scheduleDayOpsIsoDateToken(obj.date_from);
    var dt = scheduleDayOpsIsoDateToken(obj.date_to || obj.date_from);
    if (df){
      if (!fromTo.from || df < fromTo.from) fromTo.from = df;
      if (!fromTo.to || (dt || df) > fromTo.to) fromTo.to = dt || df;
    } else if (dt){
      if (!fromTo.from || dt < fromTo.from) fromTo.from = dt;
      if (!fromTo.to || dt > fromTo.to) fromTo.to = dt;
    }
    var single = scheduleDayOpsIsoDateToken(obj.service_date);
    if (single) singles[single] = true;
  }

  absorbObj(group);
  if (group){
    absorbObj(scheduleDayOpsParseMetaBlob(group.metadata));
    absorbObj(scheduleDayOpsParseMetaBlob(group.booking_metadata));
    absorbObj(scheduleDayOpsParseMetaBlob(group._meta));
    var recs = group.records || [];
    for (var r = 0; r < recs.length; r += 1){
      var row = recs[r];
      absorbObj(row);
      absorbObj(scheduleDayOpsParseMetaBlob(row && row.metadata));
      absorbObj(scheduleDayOpsParseMetaBlob(row && row.booking_metadata));
      absorbObj(scheduleDayOpsParseMetaBlob(row && row._meta));
    }
  }

  var out = [];
  if (hasExplicit){
    out = Object.keys(explicit).sort();
    return out;
  }
  if (fromTo.from){
    if (typeof scheduleEnumerateDates === 'function'){
      out = (scheduleEnumerateDates(fromTo.from, fromTo.to || fromTo.from) || [])
        .map(scheduleDayOpsIsoDateToken).filter(Boolean);
    } else if (typeof scheduleParseIso === 'function' && typeof scheduleAddDays === 'function' && typeof scheduleIsoDate === 'function'){
      var cur = scheduleParseIso(fromTo.from);
      var end = scheduleParseIso(fromTo.to || fromTo.from);
      var guard = 0;
      while (cur.getTime() <= end.getTime() && guard < 400){
        out.push(scheduleIsoDate(cur));
        cur = scheduleAddDays(cur, 1);
        guard += 1;
      }
    } else {
      out = fromTo.from === (fromTo.to || fromTo.from)
        ? [fromTo.from]
        : [fromTo.from, fromTo.to].filter(Boolean);
    }
    if (out.length) return out;
  }
  out = Object.keys(singles).sort();

  // Display-only fallback: when a course+equipment booking is multi-day in the
  // loaded schedule snapshot, derive position from peer service dates of the
  // same booking (never invent span from duration alone).
  if (out.length <= 1 && group && group.booking_id
    && typeof scheduleGetRowsSnapshot === 'function') {
    try {
      var snap = scheduleGetRowsSnapshot() || [];
      var peerDates = {};
      var bid = String(group.booking_id);
      for (var pi = 0; pi < snap.length; pi += 1) {
        var peer = snap[pi];
        if (!peer || String(peer.booking_id || '') !== bid) continue;
        var pIso = scheduleDayOpsIsoDateToken(peer.service_date);
        if (pIso) peerDates[pIso] = true;
        var pMeta = scheduleDayOpsParseMetaBlob(peer.metadata || peer._meta);
        if (Array.isArray(pMeta.rental_service_dates)) {
          for (var rd = 0; rd < pMeta.rental_service_dates.length; rd += 1) {
            var rIso = scheduleDayOpsIsoDateToken(pMeta.rental_service_dates[rd]);
            if (rIso) peerDates[rIso] = true;
          }
        }
        if (Array.isArray(pMeta.service_dates)) {
          for (var sd = 0; sd < pMeta.service_dates.length; sd += 1) {
            var sIso = scheduleDayOpsIsoDateToken(pMeta.service_dates[sd]);
            if (sIso) peerDates[sIso] = true;
          }
        }
      }
      var peerKeys = Object.keys(peerDates).sort();
      if (peerKeys.length > out.length) return peerKeys;
    } catch (_snap) { /* ignore snapshot failures */ }
  }
  return out;
}

/**
 * Day progress for the selected Today date within a multi-day booking.
 * Returns { day, total } or null when hidden (single-day or selected date out of span).
 */
function scheduleBookingDayProgress(selectedIso, group){
  var selected = scheduleDayOpsIsoDateToken(selectedIso);
  if (!selected || !group) return null;
  var dates = scheduleCanonicalBookedServiceDates(group);
  if (!dates || dates.length <= 1) return null;
  var idx = dates.indexOf(selected);
  if (idx < 0) return null;
  return { day: idx + 1, total: dates.length };
}

function scheduleBookingDayProgressLabel(progress){
  if (!progress || !(progress.total > 1)) return '';
  var vars = { day: String(progress.day), total: String(progress.total) };
  if (typeof t === 'function') return t('schedule.card.dayProgress', vars);
  var raw = portalT('schedule.card.dayProgress');
  return String(raw)
    .split('{day}').join(vars.day)
    .split('{total}').join(vars.total);
}

function scheduleRenderDayProgressMetaHtml(group, selectedIso){
  var iso = scheduleDayOpsIsoDateToken(selectedIso);
  if (!iso && typeof scheduleActiveDayIso === 'function') iso = scheduleDayOpsIsoDateToken(scheduleActiveDayIso());
  if (!iso && group) iso = scheduleDayOpsIsoDateToken(group.service_date);
  var progress = scheduleBookingDayProgress(iso, group);
  if (!progress) return '';
  var label = scheduleBookingDayProgressLabel(progress);
  if (!label || label === 'schedule.card.dayProgress') return '';
  return '<span class="portal-schedule-day-progress" data-ps-day-progress="1" aria-label="' +
    escHtml(label) + '">' + escHtml(label) + '</span>';
}

function scheduleDayOpsRowStatusHtml(group){
  return scheduleRenderStatusBadgeHtml(group, { row: true });
}

/**
 * Circular/ring occupancy indicator for a course/session group header.
 * Text is always truthful (booked[/capacity]); visual fill is clamped 0–100%.
 * Missing/zero capacity is a neutral unknown state — never invents a denom.
 */
function scheduleRenderOccupancyHtml(session){
  session = session || {};
  var booked = Math.max(0, Number(session.surfers) || 0);
  var capRaw = session.capacity;
  var capNum = capRaw == null || capRaw === '' ? NaN : Number(capRaw);
  var hasCap = isFinite(capNum) && capNum > 0;
  var pct = 0;
  if (hasCap) {
    pct = Math.round((booked / capNum) * 100);
    if (!isFinite(pct) || pct < 0) pct = 0;
    if (pct > 100) pct = 100;
  }
  var numHtml = escHtml(String(booked))
    + (hasCap ? '<small>/' + escHtml(String(capNum)) + '</small>' : '');
  var aria;
  if (hasCap) {
    aria = String(portalT('schedule.ops.occupancy') || '')
      .split('{booked}').join(String(booked))
      .split('{capacity}').join(String(capNum));
    if (!aria || aria === 'schedule.ops.occupancy') {
      aria = 'Occupancy ' + booked + ' of ' + capNum;
    }
  } else {
    aria = String(portalT('schedule.ops.occupancyBooked') || '')
      .split('{booked}').join(String(booked));
    if (!aria || aria === 'schedule.ops.occupancyBooked') {
      aria = 'Occupancy ' + booked + ' booked';
    }
  }
  var cls = 'portal-schedule-occ'
    + (hasCap ? '' : ' is-unknown')
    + (hasCap && pct >= 100 ? ' is-full' : '')
    + (hasCap && booked > capNum ? ' is-over' : '');
  // Static ring via conic-gradient; --ps-occ-pct drives fill (0–100). No animation.
  return '<div class="' + cls + '" role="img" aria-label="' + escHtml(aria) + '" data-ps-occ-pct="' + pct + '">' +
    '<span class="portal-schedule-occ-ring" style="--ps-occ-pct:' + pct + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-occ-num">' + numHtml + '</span>' +
    '</div>';
}

/** Deterministic unique guest-panel id for a day-ops lesson/course group. */
function scheduleOpsGuestPanelId(session){
  session = session || {};
  var parts = [
    session.kind || 'session',
    session.course_id || session.slot_key || '',
    session.start != null ? String(session.start) : String(session.timeLabel || ''),
    session.label || '',
  ];
  var raw = parts.join('-').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!raw) raw = 'group';
  return 'ps-ops-guests-' + raw;
}

function scheduleRenderOpsGuestToggle(panelId, expanded){
  var isOpen = expanded !== false;
  var label = portalT(isOpen ? 'schedule.ops.hideGuests' : 'schedule.ops.showGuests');
  if (!label || label.indexOf('schedule.ops.') === 0) {
    label = isOpen ? 'Hide guests' : 'Show guests';
  }
  return '<button type="button" class="portal-schedule-ops-guest-toggle' +
    (isOpen ? '' : ' is-collapsed') +
    '" data-ps-ops-guest-toggle="1" aria-expanded="' + (isOpen ? 'true' : 'false') +
    '" aria-controls="' + escHtml(panelId) + '">' +
    '<span class="portal-schedule-ops-guest-toggle-label">' + escHtml(label) + '</span>' +
    '<span class="portal-schedule-ops-guest-toggle-icon" aria-hidden="true"></span>' +
    '</button>';
}

function scheduleRenderOpsGroupHeader(groupLabel, slotTime, stats, boardsNeeded, wetsuitsNeeded, opts){
  stats = stats || {};
  opts = opts || {};
  var time = opts.isPrivateLesson
    ? String(slotTime || '').trim()
    : scheduleFormatSlotTimeRange(slotTime || '');
  var label = String(groupLabel || '').trim() || time || portalT('schedule.type.lesson');
  var badges = '';
  if (opts.isRequested) badges += ' <span class="portal-schedule-hdr-badge is-requested">' + escHtml(portalT('schedule.privateLesson.requestedTime')) + '</span>';
  if (opts.done) badges += ' <span class="portal-schedule-hdr-badge is-done">' + escHtml(portalT('schedule.timeline.done')) + '</span>';
  var timeLine = (time ? time + ' · ' : '') + String(stats.surfers || 0) + ' ' + portalT('schedule.slot.booked');
  var occHtml = opts.session ? scheduleRenderOccupancyHtml(opts.session) : '';
  var toggleHtml = opts.guestPanelId
    ? scheduleRenderOpsGuestToggle(opts.guestPanelId, opts.guestExpanded !== false)
    : '';
  var html = '<header class="portal-schedule-ops-lesson-hdr">' +
    '<div class="portal-schedule-ops-lesson-hdr-row">' +
    '<div class="portal-schedule-ops-lesson-hdr-main">' +
    '<div class="portal-schedule-ops-lesson-hdr-title">' + escHtml(label) + badges + '</div>' +
    '<div class="portal-schedule-ops-lesson-hdr-time">' + escHtml(timeLine) + '</div>' +
    (toggleHtml ? '<div class="portal-schedule-ops-lesson-hdr-actions">' + toggleHtml + '</div>' : '') +
    '</div>' + occHtml + '</div>';
  if ((boardsNeeded || 0) > 0 || (wetsuitsNeeded || 0) > 0){
    var prepLine = portalT('schedule.ops.prepare') + ': ' + String(boardsNeeded || 0) + ' ' + portalT('schedule.summary.boards') + ' · ' +
      String(wetsuitsNeeded || 0) + ' ' + portalT('schedule.summary.wetsuits');
    html += '<div class="portal-schedule-ops-lesson-hdr-prep">' + escHtml(prepLine) + '</div>';
  }
  return html + '</header>';
}

function scheduleRenderOpsColumnHeader(){
  return '<div class="portal-schedule-ops-col-hdr">' +
    '<span></span><span></span>' +
    '<span>' + escHtml(portalT('schedule.col.guest')) + '</span>' +
    '<span></span>' +
    '<span>' + escHtml(portalT('schedule.col.status')) + '</span></div>';
}

function scheduleRenderOpsBookingRow(group){
  var g = group;
  if (!g) return '';
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var rowSrcCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var railCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var ariaLabel = scheduleRowSourceAriaLabel(g);
  // Course/lesson/private cards: gear sublabel is CE-only. Never paint a
  // standalone rental descriptor (SUP/S+W/…) onto the course card.
  var isCourseLane = (typeof scheduleGroupHasLesson === 'function' && scheduleGroupHasLesson(g))
    || (typeof scheduleGroupHasCourse === 'function' && scheduleGroupHasCourse(g))
    || (typeof scheduleGroupHasPrivateLesson === 'function' && scheduleGroupHasPrivateLesson(g));
  var genericRental = isCourseLane
    ? null
    : (g._genericRentalDescriptor || scheduleGenericRentalDescriptor(g));
  var qty = genericRental ? genericRental.quantity : scheduleGroupHasPrivateLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'private_lesson') || 1)
    : scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : scheduleGroupHasCourse(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'course') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  var equip = isCourseLane
    ? scheduleDayOpsEquipmentPrepLabel(g)
    : (genericRental ? genericRental.label : scheduleDayOpsEquipmentPrepLabel(g));
  var chipCls = src === 'staff' ? 'is-staff' : 'is-luna';
  var chipLabel = src === 'staff' ? portalT('schedule.legend.staff')
    : src === 'demo' ? portalT('schedule.source.demo')
    : portalT('schedule.legend.luna');
  var dayProgHtml = scheduleRenderDayProgressMetaHtml(g,
    (typeof scheduleActiveDayIso === 'function' ? scheduleActiveDayIso() : '') || g.service_date);
  return '<div class="portal-schedule-ops-row' + rowSrcCls + (g._needsReply ? ' needs-reply' : '') + (g._isCancelled || g.schedule_ghost ? ' is-cancelled' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '" title="' + escHtml(ariaLabel) + '" aria-label="' + escHtml(ariaLabel) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty) + '×') + '</span>' +
    '<div class="portal-schedule-ops-row-guest-col">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    (equip ? '<span class="portal-schedule-ops-row-equip-sub">' + escHtml(equip) + '</span>' : '') +
    (dayProgHtml || '') +
    '</div>' +
    '<span class="portal-schedule-src-chip ' + chipCls + '"><i aria-hidden="true"></i>' + escHtml(chipLabel) + '</span>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleDayOpsRowStatusHtml(g) + '</span>' +
    '</div>';
}

function scheduleRenderRentalPickupBlock(groups, titleKey, emptyKey, opts){
  opts = opts || {};
  var title = opts.literalTitle ? String(titleKey || '') : portalT(titleKey);
  var offeringAttr = opts.offeringKey ? ' data-rental-offering="' + escHtml(String(opts.offeringKey)) + '"' : '';
  var html = '<div class="portal-schedule-ops-rental-pickups-block"' + offeringAttr + '>' +
    '<div class="portal-schedule-ops-rental-pickups-subhdr">' + escHtml(title + ' — ' + String((groups || []).length)) + '</div>';
  if (groups && groups.length){
    html += '<div class="portal-schedule-ops-lesson-rows">' + scheduleRenderOpsColumnHeader();
    groups.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
    html += '</div>';
  } else {
    html += '<div class="portal-schedule-ops-rental-pickups-empty">' + escHtml(portalT(emptyKey)) + '</div>';
  }
  return html + '</div>';
}

function scheduleRenderTimelineNowLine(nowLabel){
  return '<div class="portal-schedule-tl-now" aria-hidden="true"><span>' + escHtml(nowLabel) + '</span></div>';
}

function scheduleRenderTimelineSession(session, done){
  var groupCls = 'portal-schedule-ops-lesson-group' +
    (session.kind === 'course' ? ' portal-schedule-ops-course-group' : '') +
    (session.kind === 'private_lesson' ? ' portal-schedule-ops-private-group' : '') +
    (session.kind === 'other' ? ' portal-schedule-ops-lesson-other' : '');
  var stats = { surfers: session.surfers, bookings: session.bookings };
  var hdrLabel = session.kind === 'private_lesson' ? (session.sectionLabel || session.label) : session.label;
  var hdrTime = session.kind === 'private_lesson' ? session.timeLabel : session.timeLabel;
  var panelId = scheduleOpsGuestPanelId(session);
  // Reuse timeline `done` (today + end <= nowMin): past populated courses start with
  // the guest/booking panel collapsed. Private/other sessions stay expanded.
  var guestExpanded = session.kind !== 'course' || !done;
  var html = '<section class="' + groupCls + '">' +
    scheduleRenderOpsGroupHeader(hdrLabel, hdrTime, stats, session.boardsNeeded || 0, session.wetsuitsNeeded || 0,
      {
        isCourse: session.kind === 'course',
        isPrivateLesson: session.kind === 'private_lesson',
        isRequested: !!session.isRequested,
        done: done,
        session: session,
        guestPanelId: panelId,
        guestExpanded: guestExpanded,
      }) +
    '<div id="' + escHtml(panelId) + '" class="portal-schedule-ops-lesson-rows' +
      (guestExpanded ? '' : ' is-collapsed') +
      '" role="region"' + (guestExpanded ? '' : ' hidden') + '>' +
    scheduleRenderOpsColumnHeader();
  (session.groups || []).forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
  return html + '</div></section>';
}

function scheduleRenderTimelineEmptySlot(session){
  var seatsBit = session.capacity ? (' · ' + String(session.capacity) + ' ' + portalT('schedule.glance.seats')) : '';
  var timeBit = session.timeLabel ? (' · ' + session.timeLabel) : '';
  var addCourse = session.kind === 'course' && session.course_id
    ? (' data-ps-add-course="' + escHtml(String(session.course_id)) + '"')
    : '';
  return '<section class="portal-schedule-ops-lesson-group portal-schedule-empty-slot-group portal-schedule-ops-course-group">' +
    '<div class="portal-schedule-empty-slot-row">' +
    '<div class="portal-schedule-empty-slot-main">' +
    '<span class="portal-schedule-empty-slot-label">' + escHtml(session.label || '') + '</span>' +
    '<span class="portal-schedule-empty-slot-sub">' + escHtml(portalT('schedule.emptySlot') + timeBit + seatsBit) + '</span>' +
    '</div>' +
    '<button type="button" class="portal-schedule-empty-add"' + addCourse + ' data-ps-add-slot="' + escHtml(session.slot_key || '') + '">+ ' + escHtml(portalT('schedule.createBooking')) + '</button>' +
    '</div></section>';
}

function scheduleRenderTimelineItem(session, ctx){
  var done = !!(ctx.isToday && session.end != null && session.end <= ctx.nowMin);
  var isEmpty = !(session.groups && session.groups.length);
  var cls = 'portal-schedule-tl-item' + (done ? ' is-done' : '') + (isEmpty ? ' is-empty' : '');
  var startLabel = session.start != null ? scheduleMinutesLabel(session.start) : '';
  var endLabel = session.end != null ? scheduleMinutesLabel(session.end) : '';
  var timeCol = '<div class="portal-schedule-tl-time">' +
    (startLabel ? '<b>' + escHtml(startLabel) + '</b>' + (endLabel ? '<small>– ' + escHtml(endLabel) + '</small>' : '') : '') +
    '</div>';
  var body = isEmpty ? scheduleRenderTimelineEmptySlot(session) : scheduleRenderTimelineSession(session, done);
  return '<div class="' + cls + '">' + timeCol + '<span class="portal-schedule-tl-dot" aria-hidden="true"></span>' +
    '<div class="portal-schedule-tl-body">' + body + '</div></div>';
}

function scheduleAttachCancelledCourseGroups(sessions, ghostRows){
  (sessions || []).forEach(function(session){
    if (!session || session.kind !== 'course') return;
    var courseId = String(session.course_id || '');
    if (!courseId) return;
    var courseRows = (ghostRows || []).filter(function(row){
      return scheduleRowType(row) === 'course' && scheduleCourseKey(row) === courseId;
    });
    if (!courseRows.length) return;
    // Mirror scheduleCourseAggregates: one exact booking/course group per course,
    // retaining same-booking equipment rows but excluding peer course rows.
    var relatedRows = scheduleRowsForSameBookings(ghostRows || [], courseRows).filter(function(row){
      if (scheduleRowType(row) !== 'course') return true;
      return scheduleCourseKey(row) === courseId;
    });
    var groups = scheduleBuildDisplayGroups(relatedRows).filter(scheduleGroupHasCourse);
    groups.forEach(function(group){
      var courseRec = (group.records || []).find(function(row){
        return scheduleRowType(row) === 'course' && scheduleCourseKey(row) === courseId;
      });
      if (!courseRec) return;
      var courseMeta = scheduleRowCourseMeta(courseRec);
      group.course_id = courseRec.course_id || courseMeta.course_id || courseId;
      group.course_label = scheduleResolveCourseDisplayLabel(
        group.course_id,
        courseRec.course_label || courseMeta.course_label || group.course_label,
      );
      var qty = courseRec.quantity != null ? Number(courseRec.quantity) : 1;
      if (Number.isFinite(qty) && qty >= 1) group.quantity = qty;
      group._isCancelled = true;
      group.schedule_ghost = true;
      session.groups = (session.groups || []).concat([group]);
    });
  });
  return sessions;
}


/** Day courses layout: 'timeline' (default) | 'cards'. Persisted in sessionStorage. */
var scheduleDayOpsLayoutMode = 'timeline';
var SCHEDULE_DAY_OPS_LAYOUT_KEY = 'ps-day-ops-layout';

function scheduleDayOpsIsMobileViewport() {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return !!window.matchMedia('(max-width: 768px)').matches;
    }
  } catch (_e) { /* ignore */ }
  return false;
}

function scheduleGetDayOpsLayoutMode() {
  // Mobile: always cards — no vertical timeline rail.
  if (scheduleDayOpsIsMobileViewport()) return 'cards';
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      var s = sessionStorage.getItem(SCHEDULE_DAY_OPS_LAYOUT_KEY);
      if (s === 'cards' || s === 'timeline') return s;
    }
  } catch (_e) { /* ignore */ }
  return scheduleDayOpsLayoutMode === 'cards' ? 'cards' : 'timeline';
}

/** Re-render board + cockpit when crossing the mobile breakpoint. */
function scheduleEnsureDayOpsLayoutMediaWatch() {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  if (window.__psOpsLayoutMediaWatch) return;
  window.__psOpsLayoutMediaWatch = true;
  var mq = window.matchMedia('(max-width: 768px)');
  var onChange = function () {
    try {
      var ctx = typeof scheduleRentalPickupsRenderCtx !== 'undefined' ? scheduleRentalPickupsRenderCtx : null;
      if (ctx && typeof renderScheduleDayOpsBoard === 'function') {
        renderScheduleDayOpsBoard(ctx.pack, ctx.dateIso);
      }
    } catch (_e1) { /* ignore */ }
    try {
      if (typeof schedulePaintDayCockpit === 'function') schedulePaintDayCockpit();
    } catch (_e2) { /* ignore */ }
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else if (typeof mq.addListener === 'function') mq.addListener(onChange);
}

function scheduleSetDayOpsLayoutMode(mode) {
  var next = mode === 'cards' ? 'cards' : 'timeline';
  scheduleDayOpsLayoutMode = next;
  try {
    if (typeof sessionStorage !== 'undefined' && sessionStorage) {
      sessionStorage.setItem(SCHEDULE_DAY_OPS_LAYOUT_KEY, next);
    }
  } catch (_e2) { /* ignore */ }
  var ctx = typeof scheduleRentalPickupsRenderCtx !== 'undefined' ? scheduleRentalPickupsRenderCtx : null;
  if (ctx && typeof renderScheduleDayOpsBoard === 'function') {
    renderScheduleDayOpsBoard(ctx.pack, ctx.dateIso);
  }
  // Keep cockpit pills in sync without a full page reload.
  if (typeof schedulePaintDayCockpit === 'function') {
    try { schedulePaintDayCockpit(); } catch (_e3) { /* ignore */ }
  }
  return next;
}

/**
 * Card grid columns from session count (Monshies):
 * 1→1, 2→2, 3→3, 4→2, 6→3; multiples of 3 → 3; even → 2; else → 3.
 */
function scheduleDayOpsCardsColumnCount(n) {
  var c = Number(n) || 0;
  if (c <= 1) return 1;
  if (c === 2) return 2;
  if (c === 3) return 3;
  if (c === 4) return 2;
  if (c % 3 === 0) return 3;
  if (c % 2 === 0) return 2;
  return 3;
}

function scheduleRenderCardsItem(session, ctx) {
  var done = !!(ctx.isToday && session.end != null && session.end <= ctx.nowMin);
  var isEmpty = !(session.groups && session.groups.length);
  var cls = 'portal-schedule-card-item' + (done ? ' is-done' : '') + (isEmpty ? ' is-empty' : '');
  var body = isEmpty ? scheduleRenderTimelineEmptySlot(session) : scheduleRenderTimelineSession(session, done);
  return '<div class="' + cls + '">' + body + '</div>';
}

function scheduleRenderDayOpsBoardHtml(pack, dateIso, lessonTimes){
  pack = pack || { lessons: [], gear: [], rows: [] };
  var dayRows = pack.rows || [];
  var activeRows = dayRows.filter(function(r){
    return !(r && (r._isCancelled || r.schedule_ghost));
  });
  var ghostRows = dayRows.filter(function(r){
    return !!(r && (r._isCancelled || r.schedule_ghost));
  });
  var html = '';
  if (!scheduleCoursesCache.length && scheduleLessonTimesFallback && (lessonTimes || []).length){
    html += '<div class="portal-schedule-ops-fallback">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</div>';
  }
  var sessions = scheduleBuildDaySessions(activeRows, dateIso, lessonTimes);
  scheduleAttachCancelledCourseGroups(sessions, ghostRows);
  var isToday = dateIso === scheduleTodayIso();
  var now = new Date();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var ctx = { isToday: isToday, nowMin: nowMin };
  var layoutMode = scheduleGetDayOpsLayoutMode();
  var itemsHtml = '';
  if (layoutMode === 'cards') {
    sessions.forEach(function(s){
      itemsHtml += scheduleRenderCardsItem(s, ctx);
    });
    if (sessions.length){
      var cols = scheduleDayOpsCardsColumnCount(sessions.length);
      html += '<div class="portal-schedule-cards-grid" data-ps-card-cols="' + String(cols) +
        '" style="--ps-card-cols:' + String(cols) + '">' + itemsHtml + '</div>';
    }
  } else {
    var nowInserted = !isToday;
    sessions.forEach(function(s){
      if (!nowInserted && s.start != null && s.start > nowMin){
        itemsHtml += scheduleRenderTimelineNowLine(scheduleMinutesLabel(nowMin));
        nowInserted = true;
      }
      itemsHtml += scheduleRenderTimelineItem(s, ctx);
    });
    if (!nowInserted && sessions.length){
      itemsHtml += scheduleRenderTimelineNowLine(scheduleMinutesLabel(nowMin));
    }
    if (sessions.length){
      html += '<div class="portal-schedule-timeline">' + itemsHtml + '</div>';
    }
  }
  // Service-record scope: include standalone rentals on course/lesson bookings.
  // Never filter by pure-standalone booking type (scheduleGroupIsStandaloneRental).
  var gearGroups = typeof scheduleSelectRentalPickupGroups === 'function'
    ? scheduleSelectRentalPickupGroups(activeRows)
    : scheduleBuildDisplayGroups(activeRows).filter(scheduleGroupHasRentalPickups);
  if (gearGroups.length){
    html += scheduleRenderRentalPickupsSection(gearGroups);
  }
  if (!html) html = '<div class="portal-schedule-ops-empty">' + escHtml(portalT('schedule.emptyDay')) + '</div>';
  return html;
}

function scheduleResolveDayOpsRowFromChip(target){
  if (!target || typeof target.closest !== 'function') return null;
  var chip = target.closest('[data-ps-booking-id]');
  if (!chip) return null;
  var id = chip.getAttribute('data-ps-booking-id');
  if (!id) return null;
  if (typeof scheduleResolveRow === 'function') return scheduleResolveRow(id);
  if (typeof scheduleFindRowById === 'function') return scheduleFindRowById(id);
  return null;
}

function scheduleWireDayOpsGuestToggles(container){
  if (!container || typeof container.querySelectorAll !== 'function') return;
  container.querySelectorAll('[data-ps-ops-guest-toggle]').forEach(function(btn){
    if (!btn || (btn.dataset && btn.dataset.psGuestToggleWired)) return;
    if (btn.dataset) btn.dataset.psGuestToggleWired = '1';
    btn.addEventListener('click', function(ev){
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      var panelId = btn.getAttribute('aria-controls');
      if (!panelId) return;
      var panel = null;
      if (typeof container.querySelector === 'function') {
        panel = container.querySelector('#' + panelId);
      }
      if (!panel && typeof document !== 'undefined' && document.getElementById) {
        panel = document.getElementById(panelId);
      }
      if (!panel) return;
      var expanded = btn.getAttribute('aria-expanded') !== 'false';
      var next = !expanded;
      btn.setAttribute('aria-expanded', next ? 'true' : 'false');
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle('is-collapsed', !next);
      } else {
        btn.className = String(btn.className || '')
          .replace(/\bis-collapsed\b/g, '')
          .trim() + (next ? '' : ' is-collapsed');
      }
      panel.hidden = !next;
      if (panel.classList && typeof panel.classList.toggle === 'function') {
        panel.classList.toggle('is-collapsed', !next);
      } else {
        panel.className = String(panel.className || '')
          .replace(/\bis-collapsed\b/g, '')
          .trim() + (next ? '' : ' is-collapsed');
      }
      var labelEl = typeof btn.querySelector === 'function'
        ? btn.querySelector('.portal-schedule-ops-guest-toggle-label')
        : null;
      var label = portalT(next ? 'schedule.ops.hideGuests' : 'schedule.ops.showGuests');
      if (!label || label.indexOf('schedule.ops.') === 0) {
        label = next ? 'Hide guests' : 'Show guests';
      }
      if (labelEl) labelEl.textContent = label;
    });
  });
}

function scheduleWireDayOpsBoardRows(container){
  if (!container) return;
  scheduleWireDayOpsGuestToggles(container);
  container.querySelectorAll('[data-ps-booking-id]').forEach(function(node){
    if (node.dataset.psOpsWired) return;
    node.dataset.psOpsWired = '1';
    node.addEventListener('click', function(ev){
      ev.stopPropagation();
      var row = scheduleResolveDayOpsRowFromChip(ev.target);
      if (row) openScheduleDetailDrawer(row);
    });
  });
  container.querySelectorAll('[data-ps-add-slot]').forEach(function(node){
    if (node.dataset.psAddWired) return;
    node.dataset.psAddWired = '1';
    node.addEventListener('click', function(ev){
      ev.stopPropagation();
      var dateIso = scheduleActiveDayIso();
      var courseId = node.getAttribute('data-ps-add-course') || '';
      openScheduleCreateModal({
        activity: 'group',
        course_id: courseId || null,
        date_from: dateIso,
        date_to: dateIso,
      });
    });
  });
}

function renderScheduleDayOpsBoard(pack, dateIso){
  var box = el('ps-ops-board');
  if (!box) return;
  scheduleEnsureDayOpsLayoutMediaWatch();
  scheduleRentalPickupsRenderCtx = { pack: pack || { lessons: [], gear: [], rows: [] }, dateIso: dateIso || '' };
  var layoutMode = scheduleGetDayOpsLayoutMode();
  box.className = 'portal-schedule-ops-board';
  box.setAttribute('data-ops-layout', layoutMode);
  box.innerHTML = scheduleRenderDayOpsBoardHtml(pack, dateIso, scheduleLessonTimesCache);
  scheduleWireDayOpsBoardRows(box);
  scheduleWireRentalPickupsControls(box);
}
