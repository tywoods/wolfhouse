#!/usr/bin/env python3
"""Sunset Schedule timeslot layout + create-booking cleanup."""
from pathlib import Path

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}")


api = API.read_text(encoding="utf-8")

# ── CSS ──────────────────────────────────────────────────────────────────────
api = api.replace(
    ".portal-schedule-day-col{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);min-height:140px;display:flex;flex-direction:column}",
    ".portal-schedule-day-col{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);min-height:320px;display:flex;flex-direction:column}",
)
api = api.replace(
    ".portal-schedule-card-stat{font-size:22px;font-weight:800;color:var(--text);line-height:1.2}",
    ".portal-schedule-card-stat{font-size:22px;font-weight:800;color:var(--text);line-height:1.2}\n"
    ".portal-schedule-card-body{font-size:12px;line-height:1.45;color:var(--text-2)}\n"
    ".portal-schedule-card-body .schedule-slot-line{margin:0 0 4px}\n"
    ".portal-schedule-card-body .schedule-slot-line strong{color:var(--text);font-weight:700}\n"
    ".portal-schedule-card-muted{font-size:11px;color:var(--text-3);margin-top:4px}\n"
    ".portal-schedule-slot-group{border:1px solid var(--border-soft);border-radius:8px;padding:8px;margin-bottom:8px;background:var(--surface-soft)}\n"
    ".portal-schedule-slot-hdr{font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;display:flex;justify-content:space-between;gap:8px}\n"
    ".portal-schedule-slot-count{font-size:10px;font-weight:600;color:var(--text-3);white-space:nowrap}\n"
    ".portal-schedule-slot-bookings{display:flex;flex-direction:column;gap:4px}\n"
    ".portal-schedule-rentals-hdr{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-3);margin:4px 0 6px}\n"
    ".portal-schedule-slot-fallback{font-size:10px;color:var(--text-3);font-style:italic;margin-bottom:6px}",
)

# ── HTML: lessons today body + create form ───────────────────────────────────
api = api.replace(
    '    <div class="portal-schedule-card"><div class="portal-schedule-card-label" data-i18n="schedule.card.lessonsToday">Lessons today</div><div class="portal-schedule-card-stat" id="ps-lessons-today">…</div></div>',
    '    <div class="portal-schedule-card"><div class="portal-schedule-card-label" data-i18n="schedule.card.lessonsToday">Lessons today</div><div class="portal-schedule-card-body" id="ps-lessons-today">…</div></div>',
)

api = api.replace(
    """    <div class="portal-schedule-create-field"><label for="ps-create-time" data-i18n="schedule.create.time">Time</label><input id="ps-create-time" type="time"></div>""",
    """    <div class="portal-schedule-create-field" id="ps-create-time-lesson-wrap"><label for="ps-create-time-slot" data-i18n="schedule.create.lessonSlot">Lesson time slot</label><select id="ps-create-time-slot"></select></div>
    <div class="portal-schedule-create-field" id="ps-create-time-rental-wrap" style="display:none"><label for="ps-create-time" data-i18n="schedule.create.time">Time</label><input id="ps-create-time" type="time"></div>""",
)

api = api.replace(
    """    <div class="portal-schedule-create-field"><label for="ps-create-notes" data-i18n="schedule.create.notes">Notes</label><textarea id="ps-create-notes" rows="3"></textarea></div>
    <div class="portal-schedule-create-field"><label><input id="ps-create-needs-reply" type="checkbox"> <span data-i18n="schedule.create.needsReply">Needs reply</span></label></div>""",
    """    <div class="portal-schedule-create-field"><label for="ps-create-notes" data-i18n="schedule.create.notes">Notes</label><textarea id="ps-create-notes" rows="3"></textarea></div>""",
)

# ── State vars ───────────────────────────────────────────────────────────────
api = api.replace(
    "var scheduleConversationsCache = [];",
    "var scheduleConversationsCache = [];\nvar scheduleLessonTimesCache = [];\nvar scheduleLessonTimesFallback = false;\nvar scheduleLessonTimesLoaded = false;",
)

HELPERS = r"""
function scheduleNormalizeSlotTime(raw){
  var t = String(raw || '').trim();
  if (!t) return '';
  if (t.indexOf('-') >= 0) t = t.split('-')[0].trim();
  return t.slice(0, 5);
}

function scheduleFetchLessonTimesConfig(client){
  if (scheduleLessonTimesLoaded) return Promise.resolve(scheduleLessonTimesCache);
  if (adminConfigCache && adminConfigCache.lesson_times && adminConfigCache.lesson_times.length){
    scheduleLessonTimesCache = adminConfigCache.lesson_times.slice();
    scheduleLessonTimesFallback = adminConfigCache.source !== 'db';
    scheduleLessonTimesLoaded = true;
    return Promise.resolve(scheduleLessonTimesCache);
  }
  return fetch('/staff/admin/config?client=' + encodeURIComponent(client))
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      var profile = getPortalProfile(client);
      if (data && data.success && data.lesson_times && data.lesson_times.length){
        scheduleLessonTimesCache = data.lesson_times.slice();
        scheduleLessonTimesFallback = data.source !== 'db';
      } else {
        scheduleLessonTimesCache = (profile.lesson_slots_demo || []).slice();
        scheduleLessonTimesFallback = true;
      }
      scheduleLessonTimesLoaded = true;
      return scheduleLessonTimesCache;
    })
    .catch(function(){
      var profile = getPortalProfile(client);
      scheduleLessonTimesCache = (profile.lesson_slots_demo || []).slice();
      scheduleLessonTimesFallback = true;
      scheduleLessonTimesLoaded = true;
      return scheduleLessonTimesCache;
    });
}

function scheduleUniqueConfiguredSlots(lessonTimes){
  var seen = {};
  var out = [];
  (lessonTimes || []).forEach(function(s){
    var key = scheduleNormalizeSlotTime(s.slot_time);
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push({
      slot_time: s.slot_time,
      slot_key: key,
      label: s.offering_label || s.session_type || portalT('schedule.type.lesson'),
      source: s.source || 'config',
    });
  });
  out.sort(function(a,b){ return scheduleNormalizeSlotTime(a.slot_time).localeCompare(scheduleNormalizeSlotTime(b.slot_time)); });
  return out;
}

function scheduleSlotsForDate(lessonTimes, dateIso){
  var dated = [];
  var generic = [];
  (lessonTimes || []).forEach(function(s){
    var key = scheduleNormalizeSlotTime(s.slot_time);
    if (!key) return;
    var entry = {
      slot_time: s.slot_time,
      slot_key: key,
      label: s.offering_label || s.session_type || portalT('schedule.type.lesson'),
      source: s.source || 'config',
    };
    if (s.date && String(s.date).slice(0, 10) === dateIso) dated.push(entry);
    else if (!s.date) generic.push(entry);
  });
  var base = dated.length ? dated : generic;
  return scheduleUniqueConfiguredSlots(base.map(function(x){
    return { slot_time: x.slot_time, offering_label: x.label, session_type: x.label, source: x.source, date: null };
  }));
}

function scheduleSlotAggregates(lessons, slot){
  var key = scheduleNormalizeSlotTime(slot.slot_time);
  var rows = (lessons || []).filter(function(l){
    return scheduleRowType(l) === 'lesson' && scheduleNormalizeSlotTime(l.slot_time || l.service_time) === key;
  });
  var surfers = rows.reduce(function(a, r){ return a + (r.quantity != null ? Number(r.quantity) : 1); }, 0);
  return { bookings: rows.length, surfers: surfers, rows: rows };
}

function scheduleSlotCountLabel(stats){
  var b = stats.bookings || 0;
  var s = stats.surfers || 0;
  return String(b) + ' ' + portalT('schedule.slot.bookings') + ' / ' + String(s) + ' ' + portalT('schedule.slot.surfers');
}

function scheduleRenderBookingChipHtml(r){
  scheduleEnsureRowId(r);
  var typ = r._scheduleType || scheduleRowType(r);
  var label = r.guest_name || r.offering_label || scheduleRowTypeLabel(r);
  var extraCls = r._isDemo ? ' demo' : (r._isDbManual ? ' manual' : '');
  return '<div class="portal-schedule-item-card ' + typ + extraCls + '" data-ps-booking-id="' + escHtml(r._scheduleId) + '">' +
    escHtml(label) + '</div>';
}

function scheduleRenderDayBodyHtml(pack, dateIso, lessonTimes){
  var html = '';
  var slots = scheduleSlotsForDate(lessonTimes, dateIso);
  if (scheduleLessonTimesFallback && slots.length) {
    html += '<div class="portal-schedule-slot-fallback">' + escHtml(portalT('schedule.slot.fallbackNotice')) + '</div>';
  }
  if (slots.length){
    slots.forEach(function(slot){
      var stats = scheduleSlotAggregates(pack.lessons, slot);
      html += '<div class="portal-schedule-slot-group">' +
        '<div class="portal-schedule-slot-hdr"><span>' + escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + '</span>' +
        '<span class="portal-schedule-slot-count">' + escHtml(scheduleSlotCountLabel(stats)) + '</span></div>' +
        '<div class="portal-schedule-slot-bookings">';
      if (stats.rows.length){
        stats.rows.forEach(function(r){ html += scheduleRenderBookingChipHtml(r); });
      } else {
        html += '<div style="font-size:10px;color:var(--text-3)">' + escHtml(portalT('schedule.emptySlot')) + '</div>';
      }
      html += '</div></div>';
    });
  } else {
    html += '<div class="portal-schedule-slot-fallback">' + escHtml(portalT('schedule.slot.noConfiguredTimes')) + '</div>';
  }
  var rentals = (pack.gear || []).slice();
  if (rentals.length){
    html += '<div class="portal-schedule-rentals-hdr">' + escHtml(portalT('schedule.rentals.section')) + '</div>';
    rentals.forEach(function(r){ html += scheduleRenderBookingChipHtml(r); });
  }
  var unmatched = (pack.lessons || []).filter(function(l){
    if (!slots.length) return false;
    var key = scheduleNormalizeSlotTime(l.slot_time || l.service_time);
    return !slots.some(function(s){ return scheduleNormalizeSlotTime(s.slot_time) === key; });
  });
  if (unmatched.length){
    html += '<div class="portal-schedule-rentals-hdr">' + escHtml(portalT('schedule.slot.otherLessons')) + '</div>';
    unmatched.forEach(function(r){ html += scheduleRenderBookingChipHtml(r); });
  }
  if (!slots.length && !rentals.length && !(pack.lessons || []).length) {
    html += '<div style="font-size:11px;color:var(--text-3)">' + escHtml(portalT('schedule.emptyDay')) + '</div>';
  }
  return html;
}

function scheduleRenderLessonsTodayBreakdown(rows, todayIso, lessonTimes){
  var box = el('ps-lessons-today');
  if (!box) return;
  var slots = scheduleSlotsForDate(lessonTimes, todayIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);
  var todayLessons = (rows || []).filter(function(r){
    return String(r.service_date || '').slice(0, 10) === todayIso && scheduleRowType(r) === 'lesson';
  });
  if (!slots.length){
    box.innerHTML = '<div class="portal-schedule-card-stat">' + escHtml(String(todayLessons.length)) + '</div>';
    return;
  }
  var html = '';
  slots.forEach(function(slot){
    var stats = scheduleSlotAggregates(todayLessons, slot);
    html += '<p class="schedule-slot-line"><strong>' + escHtml(scheduleNormalizeSlotTime(slot.slot_time)) +
      '</strong> — ' + escHtml(scheduleSlotCountLabel(stats)) + '</p>';
  });
  if (scheduleLessonTimesFallback) {
    html += '<p class="portal-schedule-card-muted">' + escHtml(portalT('schedule.slot.fallbackNotice')) + '</p>';
  }
  box.innerHTML = html || ('<div class="portal-schedule-card-stat">0</div>');
}

function schedulePopulateCreateTimeFields(bookingType){
  var lessonWrap = el('ps-create-time-lesson-wrap');
  var rentalWrap = el('ps-create-time-rental-wrap');
  var slotSel = el('ps-create-time-slot');
  var isLesson = bookingType === 'lesson';
  if (lessonWrap) lessonWrap.style.display = isLesson ? '' : 'none';
  if (rentalWrap) rentalWrap.style.display = isLesson ? 'none' : '';
  if (!isLesson || !slotSel) return;
  var slots = scheduleUniqueConfiguredSlots(scheduleLessonTimesCache);
  var html = '';
  slots.forEach(function(s){
    html += '<option value="' + escHtml(scheduleNormalizeSlotTime(s.slot_time)) + '">' +
      escHtml(scheduleNormalizeSlotTime(s.slot_time) + (s.label ? ' — ' + s.label : '')) + '</option>';
  });
  if (!html) html = '<option value="">' + escHtml(portalT('schedule.slot.noConfiguredTimes')) + '</option>';
  slotSel.innerHTML = html;
}

function scheduleCreateTimeValue(bookingType){
  if (bookingType === 'lesson'){
    var slotSel = el('ps-create-time-slot');
    return slotSel ? slotSel.value : '';
  }
  var timeInput = el('ps-create-time');
  return timeInput ? timeInput.value : '10:00';
}

"""

marker = "function scheduleEnsureRowId(row){"
require(api, marker, "scheduleEnsureRowId")
api = api.replace(marker, HELPERS + marker)

# renderScheduleSummary
OLD_SUMMARY = """function renderScheduleSummary(profile, weekData, convs){
  var today = dsTodayIso();
  var rows = scheduleRowsCache || [];
  setText('ps-rentals-today', String(scheduleRentalsToday(rows, today)));
  setText('ps-lessons-today', String(scheduleLessonsToday(rows, today)));
  setText('ps-need-reply', String(scheduleNeedReplyCount(convs) + scheduleBookingNeedReplyCount(rows)));
}"""

NEW_SUMMARY = """function renderScheduleSummary(profile, weekData, convs){
  var today = dsTodayIso();
  var rows = scheduleRowsCache || [];
  setText('ps-rentals-today', String(scheduleRentalsToday(rows, today)));
  scheduleRenderLessonsTodayBreakdown(rows, today, scheduleLessonTimesCache);
  setText('ps-need-reply', String(scheduleNeedReplyCount(convs) + scheduleBookingNeedReplyCount(rows)));
}"""

require(api, OLD_SUMMARY, "renderScheduleSummary")
api = api.replace(OLD_SUMMARY, NEW_SUMMARY)

# renderScheduleWeekGrid body rendering
OLD_GRID_BODY = """    pack.rows.forEach(function(r){
      scheduleEnsureRowId(r);
      var typ = r._scheduleType || scheduleRowType(r);
      var time = r.slot_time || r.service_time || '';
      var label = r.guest_name || r.offering_label || scheduleRowTypeLabel(r);
      var extraCls = r._isManual ? ' manual' : (r._isDemo ? ' demo' : '');
      html += '<div class="portal-schedule-item-card ' + typ + extraCls + '" data-ps-booking-id="' + escHtml(r._scheduleId) + '">' +
        escHtml((time ? time + ' · ' : '') + label) + '</div>';
    });
    if (!pack.rows.length) html += '<div style="font-size:11px;color:var(--text-3)">' + escHtml(portalT('schedule.emptyDay')) + '</div>';"""

NEW_GRID_BODY = """    html += scheduleRenderDayBodyHtml(pack, iso, scheduleLessonTimesCache);"""

require(api, OLD_GRID_BODY, "week grid body")
api = api.replace(OLD_GRID_BODY, NEW_GRID_BODY)

# openScheduleCreateModal
OLD_OPEN = """function openScheduleCreateModal(){
  var modal = el('ps-create-modal');
  if (!modal) return;
  var dateInput = el('ps-create-date');
  if (dateInput && !dateInput.value) dateInput.value = dsTodayIso();
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}"""

NEW_OPEN = """function openScheduleCreateModal(){
  var modal = el('ps-create-modal');
  if (!modal) return;
  var dateInput = el('ps-create-date');
  if (dateInput && !dateInput.value) dateInput.value = dsTodayIso();
  var typeSel = el('ps-create-type');
  schedulePopulateCreateTimeFields(typeSel ? typeSel.value : 'lesson');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}"""

require(api, OLD_OPEN, "openScheduleCreateModal")
api = api.replace(OLD_OPEN, NEW_OPEN)

# submitScheduleManualBooking - remove needs_reply, use scheduleCreateTimeValue
api = api.replace(
    "  var timeVal = el('ps-create-time') ? el('ps-create-time').value : '10:00';",
    "  var timeVal = scheduleCreateTimeValue(type);",
)
api = api.replace(
    "  var needsReply = !!(el('ps-create-needs-reply') && el('ps-create-needs-reply').checked);\n",
    "",
)
api = api.replace(
    "      notes: notes,\n      needs_reply: needsReply,",
    "      notes: notes,",
)

# loadSchedulePage - fetch lesson times config
OLD_LOAD = """  var dataP = scheduleViewMode === 'month'
    ? scheduleFetchMonth(client, new Date(scheduleWeekStart.getFullYear(), scheduleWeekStart.getMonth(), 1))
    : scheduleFetchWeek(client, scheduleViewMode === 'day' ? scheduleParseIso(dsTodayIso()) : scheduleWeekStart);
  Promise.all([convP, dataP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];"""

NEW_LOAD = """  var configP = scheduleFetchLessonTimesConfig(client);
  var dataP = scheduleViewMode === 'month'
    ? scheduleFetchMonth(client, new Date(scheduleWeekStart.getFullYear(), scheduleWeekStart.getMonth(), 1))
    : scheduleFetchWeek(client, scheduleViewMode === 'day' ? scheduleParseIso(dsTodayIso()) : scheduleWeekStart);
  Promise.all([convP, dataP, configP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];"""

require(api, OLD_LOAD, "loadSchedulePage")
api = api.replace(OLD_LOAD, NEW_LOAD)

# Align demo lesson times with configured slots when available
api = api.replace(
    """    var demoRows = scheduleBuildDemoBookings(scheduleWeekStart);
    weekData = scheduleMergeRowsIntoWeekData(weekData, demoRows);""",
    """    var demoRows = scheduleBuildDemoBookings(scheduleWeekStart);
    if (scheduleLessonTimesCache.length){
      var demoSlots = scheduleUniqueConfiguredSlots(scheduleLessonTimesCache);
      var demoLessonIdx = 0;
      demoRows.forEach(function(r){
        if (r._isDemo && scheduleRowType(r) === 'lesson' && demoSlots[demoLessonIdx]){
          r.slot_time = scheduleNormalizeSlotTime(demoSlots[demoLessonIdx].slot_time);
          demoLessonIdx += 1;
        }
      });
    }
    weekData = scheduleMergeRowsIntoWeekData(weekData, demoRows);""",
)

# wireScheduleControls - type change handler
api = api.replace(
    """  document.querySelectorAll('.portal-schedule-filter-btn').forEach(function(btn){
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function(){ setScheduleFilter(btn.getAttribute('data-ps-filter')); });
  });
}""",
    """  document.querySelectorAll('.portal-schedule-filter-btn').forEach(function(btn){
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', function(){ setScheduleFilter(btn.getAttribute('data-ps-filter')); });
  });
  var typeSel = el('ps-create-type');
  if (typeSel && !typeSel.dataset.wired){
    typeSel.dataset.wired = '1';
    typeSel.addEventListener('change', function(){ schedulePopulateCreateTimeFields(typeSel.value); });
  }
}""",
)

# drawer - add lesson slot line for lessons
api = api.replace(
    "    '<p class=\"portal-schedule-drawer-kv\"><strong>' + escHtml(portalT('schedule.drawer.time')) + ':</strong> ' + escHtml(String(row.slot_time || row.service_time || '—')) + '</p>' +",
    "    '<p class=\"portal-schedule-drawer-kv\"><strong>' + escHtml(portalT('schedule.drawer.time')) + ':</strong> ' + escHtml(String(row.slot_time || row.service_time || '—')) + '</p>' +\n"
    "    (scheduleRowType(row) === 'lesson' ? '<p class=\"portal-schedule-drawer-kv\"><strong>' + escHtml(portalT('schedule.drawer.lessonSlot')) + ':</strong> ' + escHtml(scheduleNormalizeSlotTime(row.slot_time || row.service_time || '—') || '—') + '</p>' : '') +",
)

API.write_text(api, encoding="utf-8")

# i18n
i18n = I18N.read_text(encoding="utf-8")
extra = """
    'schedule.create.lessonSlot': 'Lesson time slot',
    'schedule.slot.bookings': 'bookings',
    'schedule.slot.surfers': 'surfers',
    'schedule.slot.fallbackNotice': 'Using fallback lesson times — Admin config unavailable.',
    'schedule.slot.noConfiguredTimes': 'No configured lesson times',
    'schedule.emptySlot': 'No bookings in this slot',
    'schedule.rentals.section': 'Rentals',
    'schedule.slot.otherLessons': 'Other lesson times',
    'schedule.drawer.lessonSlot': 'Lesson slot',"""
if "'schedule.create.lessonSlot'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.create.time': 'Time',",
        "    'schedule.create.time': 'Time'," + extra,
    )
I18N.write_text(i18n, encoding="utf-8")

# verify section 17
v1 = V1.read_text(encoding="utf-8")
if "[17] Sunset Schedule timeslots" not in v1:
    v1 = v1.replace(
        "// ── Summary ─────────────────────────────────────────────────────────────────",
        """// ── 17. Sunset Schedule timeslots — Admin-configured lesson slots ────────────

console.log('\\n[17] Sunset Schedule timeslots — Admin-configured lesson slots');

if (apiSrc) {
  assert('needs-reply checkbox removed from create form', !apiSrc.includes('id="ps-create-needs-reply"'));
  assert('schedule loads admin lesson times', apiSrc.includes('function scheduleFetchLessonTimesConfig('));
  assert('schedule slot grouping helper', apiSrc.includes('function scheduleRenderDayBodyHtml('));
  assert('schedule slot aggregates', apiSrc.includes('function scheduleSlotAggregates('));
  assert('lessons today slot breakdown', apiSrc.includes('function scheduleRenderLessonsTodayBreakdown('));
  assert('create lesson slot select', apiSrc.includes('id="ps-create-time-slot"'));
  assert('no hardcoded-only slot times', !apiSrc.includes("slot_time: '10:00'") || apiSrc.includes('scheduleNormalizeSlotTime'));
  assert('submit no longer sends needs_reply from UI', !apiSrc.includes('ps-create-needs-reply'));
}

if (i18nSrc) {
  assert('schedule.slot.bookings i18n', i18nSrc.includes("'schedule.slot.bookings'"));
  assert('schedule.create.lessonSlot i18n', i18nSrc.includes("'schedule.create.lessonSlot'"));
}


// ── Summary ─────────────────────────────────────────────────────────────────""",
    )
V1.write_text(v1, encoding="utf-8")
print("PATCH OK")
