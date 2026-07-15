'use strict';

/**
 * Sunset Schedule — day-view operations board UI (Slice 18).
 *
 * Injected after portal and drawer modules. Owns day-view #ps-ops-board HTML,
 * booking chip presentation, empty state, and rerender-safe chip click wiring.
 *
 * Consumes normalized rows from scheduleRowsCache via scheduleFindRowById.
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
 * scheduleOnCreateComponentChange, schedulePopulateCreateCourseFields, scheduleFindRowById.
 */

function scheduleDayOpsEquipmentPrepLabel(group){
  var boards = scheduleGroupBoardsNeeded(group);
  var wets = scheduleGroupWetsuitsNeeded(group);
  if (boards && wets) return portalT('schedule.equipment.boardAndWetsuit');
  if (boards) return portalT('schedule.equipment.board');
  if (wets) return portalT('schedule.equipment.wetsuit');
  return portalT('schedule.equipment.none');
}

function scheduleDayOpsRowStatusHtml(group){
  return scheduleRenderStatusBadgeHtml(group, { row: true });
}

function scheduleRenderOccupancyHtml(session){
  var cap = session.capacity;
  var split = scheduleSourceSplit(session.groups);
  var denom = cap || Math.max(session.surfers || 0, 1);
  var staffPct = Math.min(100, Math.round((split.staff / denom) * 100));
  var lunaPct = Math.min(Math.max(0, 100 - staffPct), Math.round((split.luna / denom) * 100));
  if (split.staff > 0 && staffPct < 4) staffPct = 4;
  if (split.luna > 0 && lunaPct < 4) lunaPct = Math.min(4, 100 - staffPct);
  return '<div class="portal-schedule-occ">' +
    '<span class="portal-schedule-occ-num">' + escHtml(String(session.surfers || 0)) +
    (cap ? '<small>/' + escHtml(String(cap)) + '</small>' : '') + '</span>' +
    '<span class="portal-schedule-occ-track" aria-hidden="true">' +
    '<i class="is-staff" style="width:' + staffPct + '%"></i>' +
    '<i class="is-luna" style="width:' + lunaPct + '%"></i>' +
    '</span></div>';
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
  var html = '<header class="portal-schedule-ops-lesson-hdr">' +
    '<div class="portal-schedule-ops-lesson-hdr-row">' +
    '<div class="portal-schedule-ops-lesson-hdr-main">' +
    '<div class="portal-schedule-ops-lesson-hdr-title">' + escHtml(label) + badges + '</div>' +
    '<div class="portal-schedule-ops-lesson-hdr-time">' + escHtml(timeLine) + '</div>' +
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
  var qty = scheduleGroupHasPrivateLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'private_lesson') || 1)
    : scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : scheduleGroupHasCourse(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'course') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  var equip = scheduleDayOpsEquipmentPrepLabel(g);
  var chipCls = src === 'staff' ? 'is-staff' : 'is-luna';
  var chipLabel = src === 'staff' ? portalT('schedule.legend.staff')
    : src === 'demo' ? portalT('schedule.source.demo')
    : portalT('schedule.legend.luna');
  return '<div class="portal-schedule-ops-row' + rowSrcCls + (g._needsReply ? ' needs-reply' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '" title="' + escHtml(ariaLabel) + '" aria-label="' + escHtml(ariaLabel) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty) + '×') + '</span>' +
    '<div class="portal-schedule-ops-row-guest-col">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    (equip ? '<span class="portal-schedule-ops-row-equip-sub">' + escHtml(equip) + '</span>' : '') +
    '</div>' +
    '<span class="portal-schedule-src-chip ' + chipCls + '"><i aria-hidden="true"></i>' + escHtml(chipLabel) + '</span>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleDayOpsRowStatusHtml(g) + '</span>' +
    '</div>';
}

function scheduleRenderRentalPickupBlock(groups, titleKey, emptyKey){
  var html = '<div class="portal-schedule-ops-rental-pickups-block">' +
    '<div class="portal-schedule-ops-rental-pickups-subhdr">' + escHtml(portalT(titleKey) + ' — ' + String((groups || []).length)) + '</div>';
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
  var html = '<section class="' + groupCls + '">' +
    scheduleRenderOpsGroupHeader(hdrLabel, hdrTime, stats, session.boardsNeeded || 0, session.wetsuitsNeeded || 0,
      { isCourse: session.kind === 'course', isPrivateLesson: session.kind === 'private_lesson', isRequested: !!session.isRequested, done: done, session: session }) +
    '<div class="portal-schedule-ops-lesson-rows">' +
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
  var isEmpty = !session.surfers;
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

function scheduleRenderDayOpsBoardHtml(pack, dateIso, lessonTimes){
  pack = pack || { lessons: [], gear: [], rows: [] };
  var dayRows = pack.rows || [];
  var html = '';
  if (!scheduleCoursesCache.length && scheduleLessonTimesFallback && (lessonTimes || []).length){
    html += '<div class="portal-schedule-ops-fallback">' + escHtml(portalT('schedule.courses.noneConfigured')) + '</div>';
  }
  var sessions = scheduleBuildDaySessions(dayRows, dateIso, lessonTimes);
  var isToday = dateIso === scheduleTodayIso();
  var now = new Date();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var ctx = { isToday: isToday, nowMin: nowMin };
  var itemsHtml = '';
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
  var gearGroups = scheduleBuildDisplayGroups(dayRows).filter(scheduleGroupIsStandaloneRental);
  var bothRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'both'; });
  var boardOnlyRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'board'; });
  var wetsuitOnlyRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'wetsuit'; });
  if (gearGroups.length){
    var rentalBoardsTotal = gearGroups.reduce(function(a, g){ return a + scheduleGroupBoardsNeeded(g); }, 0);
    var rentalWetsTotal = gearGroups.reduce(function(a, g){ return a + scheduleGroupWetsuitsNeeded(g); }, 0);
    var rentalSummary = String(gearGroups.length) + ' ' + portalT('schedule.slot.bookings') + ' · ' +
      String(rentalBoardsTotal) + ' ' + portalT('schedule.summary.boards') + ' · ' +
      String(rentalWetsTotal) + ' ' + portalT('schedule.summary.wetsuits');
    html += '<section class="portal-schedule-ops-rental-pickups">' +
      '<header class="portal-schedule-ops-rental-pickups-hdr">' + escHtml(portalT('schedule.ops.rentalPickupsToday')) +
      '<span class="portal-schedule-ops-rental-pickups-count">' + escHtml(rentalSummary) + '</span></header>' +
      (bothRentals.length ? scheduleRenderRentalPickupBlock(bothRentals, 'schedule.ops.rentalBoth', 'schedule.ops.rentalNothingScheduled') : '') +
      (boardOnlyRentals.length ? scheduleRenderRentalPickupBlock(boardOnlyRentals, 'schedule.ops.rentalBoardsOnly', 'schedule.ops.rentalNothingScheduled') : '') +
      (wetsuitOnlyRentals.length ? scheduleRenderRentalPickupBlock(wetsuitOnlyRentals, 'schedule.ops.rentalWetsuitsOnly', 'schedule.ops.rentalNothingScheduled') : '') +
      '</section>';
  }
  if (!html) html = '<div class="portal-schedule-ops-empty">' + escHtml(portalT('schedule.emptyDay')) + '</div>';
  return html;
}

var scheduleDayOpsBoardRowsRef = [];

function scheduleResolveDayOpsRowFromChip(target){
  if (!target || typeof target.closest !== 'function') return null;
  var chip = target.closest('[data-ps-booking-id]');
  if (!chip) return null;
  var id = chip.getAttribute('data-ps-booking-id');
  if (!id) return null;
  var cached = scheduleFindRowById(id);
  if (cached) return cached;
  var packRow = (scheduleDayOpsBoardRowsRef || []).find(function(r) { return r && r._scheduleId === id; });
  return packRow || null;
}

function scheduleWireDayOpsBoardRows(container){
  if (!container) return;
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
      var slotKey = node.getAttribute('data-ps-add-slot');
      var dateIso = scheduleActiveDayIso();
      openScheduleCreateModal();
      var df = el('ps-create-date-from');
      var dt = el('ps-create-date-to');
      if (df) df.value = dateIso;
      if (dt) dt.value = dateIso;
      var courseCb = el('ps-create-comp-course');
      if (courseCb && !courseCb.checked){
        courseCb.checked = true;
        scheduleOnCreateComponentChange('ps-create-comp-course');
      }
      schedulePopulateCreateCourseFields();
      var courseSel = el('ps-create-course-select');
      var courseId = node.getAttribute('data-ps-add-course');
      if (courseSel && courseId) courseSel.value = courseId;
    });
  });
}

function renderScheduleDayOpsBoard(pack, dateIso){
  var box = el('ps-ops-board');
  if (!box) return;
  scheduleDayOpsBoardRowsRef = (pack && pack.rows) ? pack.rows.slice() : [];
  box.className = 'portal-schedule-ops-board';
  box.innerHTML = scheduleRenderDayOpsBoardHtml(pack, dateIso, scheduleLessonTimesCache);
  scheduleWireDayOpsBoardRows(box);
}
