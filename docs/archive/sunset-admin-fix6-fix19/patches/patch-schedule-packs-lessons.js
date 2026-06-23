'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = 'G:/Luna/Sunset/scripts/staff-query-api.js';
let s = fs.readFileSync(path, 'utf8');

function must(cond, msg) { if (!cond) throw new Error(msg); }

must(s.includes('function adminRenderPackEditForm('), 'expected fix17 admin staff-query-api base');

// --- import pack count query ---
must(s.includes('getSunsetScheduleGearOnDateQuery'), 'schedule queries import missing');
s = s.replace(
  `const {
  getSunsetScheduleLessonsOnDateQuery,
  getSunsetScheduleGearOnDateQuery,
} = require('./lib/sunset-schedule-queries');`,
  `const {
  getSunsetScheduleLessonsOnDateQuery,
  getSunsetScheduleGearOnDateQuery,
  getSunsetScheduleSurfPackReservationCountsQuery,
} = require('./lib/sunset-schedule-queries');`,
);

// --- CSS: 6 metric cards ---
s = s.replace(
  '.portal-schedule-ops-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:18px}',
  '.portal-schedule-ops-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px}',
);
s = s.replace(
  '@media(max-width:1100px){.portal-schedule-ops-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}',
  '@media(max-width:1300px){.portal-schedule-ops-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}',
);
must(!s.includes('.portal-schedule-metric-card-packs'), 'pack card css already present');
s = s.replace(
  '.portal-schedule-metric-card-lessons .portal-schedule-card-label{margin-bottom:4px}',
  '.portal-schedule-metric-card-lessons .portal-schedule-card-label{margin-bottom:4px}\n.portal-schedule-metric-card-packs .portal-schedule-card-label{margin-bottom:4px}\n.portal-schedule-pack-rows{display:flex;flex-direction:column;gap:4px;min-height:2.5em}',
);

// --- HTML: surf packs card between lesson groups and surfboards ---
must(s.includes('id="ps-lessons-slot-sub"'), 'lessons card missing');
s = s.replace(
  '<div class="portal-schedule-card portal-schedule-metric-card portal-schedule-metric-card-lessons"><div class="portal-schedule-card-label" data-i18n="schedule.card.lessonGroups">Lesson groups</div><div class="portal-schedule-lesson-times" id="ps-lessons-slot-sub">…</div></div>\n    <div class="portal-schedule-card portal-schedule-metric-card"><div class="portal-schedule-card-label" data-i18n="schedule.card.surfboardsToday">Surfboards</div>',
  '<div class="portal-schedule-card portal-schedule-metric-card portal-schedule-metric-card-lessons"><div class="portal-schedule-card-label" data-i18n="schedule.card.lessonGroups">Lesson groups</div><div class="portal-schedule-lesson-times" id="ps-lessons-slot-sub">…</div></div>\n    <div class="portal-schedule-card portal-schedule-metric-card portal-schedule-metric-card-packs"><div class="portal-schedule-card-label" data-i18n="schedule.card.surfPacks">Surf packs</div><div class="portal-schedule-pack-rows" id="ps-surf-packs-sub">…</div></div>\n    <div class="portal-schedule-card portal-schedule-metric-card"><div class="portal-schedule-card-label" data-i18n="schedule.card.surfboardsToday">Surfboards</div>',
);

// --- schedule cache vars ---
s = s.replace(
  `var scheduleLessonTimesCache = [];
var scheduleLessonTimesFallback = false;
var scheduleLessonTimesLoaded = false;`,
  `var scheduleLessonTimesCache = [];
var scheduleSurfPacksCache = [];
var scheduleLessonTimesCacheLoc = null;
var scheduleSurfPackReservationCounts = {};
var scheduleSurfPackReservationCacheKey = '';
var scheduleLessonTimesFallback = false;
var SCHEDULE_MAX_LESSON_GROUPS = 4;`,
);

// --- invalidate cache on school switch ---
must(s.includes('function setSunsetLocation(locationId){'), 'setSunsetLocation missing');
s = s.replace(
  `function setSunsetLocation(locationId){
  var next = (locationId === 'sunset-sardinero') ? 'sunset-sardinero' : 'sunset-somo';
  try { localStorage.setItem(STAFF_PORTAL_SUNSET_LOCATION_KEY, next); } catch (_) { /* ignore */ }
  refreshSunsetSchoolContextLabels();`,
  `function setSunsetLocation(locationId){
  var next = (locationId === 'sunset-sardinero') ? 'sunset-sardinero' : 'sunset-somo';
  try { localStorage.setItem(STAFF_PORTAL_SUNSET_LOCATION_KEY, next); } catch (_) { /* ignore */ }
  scheduleInvalidateSchoolConfigCache();
  refreshSunsetSchoolContextLabels();`,
);

// --- replace scheduleFetchLessonTimesConfig block ---
const oldFetch = `function scheduleFetchLessonTimesConfig(client){
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
}`;

const newFetch = `function scheduleInvalidateSchoolConfigCache(){
  scheduleLessonTimesCache = [];
  scheduleSurfPacksCache = [];
  scheduleLessonTimesCacheLoc = null;
  scheduleSurfPackReservationCounts = {};
  scheduleSurfPackReservationCacheKey = '';
  scheduleLessonTimesFallback = false;
}

function scheduleSchoolConfigUrl(client){
  var q = '/staff/admin/config?client=' + encodeURIComponent(client);
  if (client === 'sunset') q += '&location=' + encodeURIComponent(getSunsetLocation());
  return q;
}

function scheduleAdminCacheMatchesSchool(){
  if (!adminConfigCache || adminConfigCache.success !== true) return false;
  if (getClient() !== 'sunset') return true;
  var active = getSunsetLocation();
  var cached = adminConfigCache.location_id || 'sunset-somo';
  return String(cached) === String(active);
}

function scheduleLimitLessonSlots(slots, max){
  var cap = max != null ? max : SCHEDULE_MAX_LESSON_GROUPS;
  return (slots || []).slice(0, cap);
}

function scheduleFetchSchoolConfig(client){
  var loc = getClient() === 'sunset' ? getSunsetLocation() : null;
  if (loc && scheduleLessonTimesCacheLoc === loc && scheduleLessonTimesCache.length){
    return Promise.resolve({
      lesson_times: scheduleLessonTimesCache,
      surf_packs: scheduleSurfPacksCache,
    });
  }
  if (scheduleAdminCacheMatchesSchool() && adminConfigCache.lesson_times && adminConfigCache.lesson_times.length){
    scheduleLessonTimesCache = adminConfigCache.lesson_times.slice();
    scheduleSurfPacksCache = (adminConfigCache.surf_packs || []).slice();
    scheduleLessonTimesCacheLoc = loc;
    scheduleLessonTimesFallback = adminConfigCache.source !== 'db';
    return Promise.resolve({
      lesson_times: scheduleLessonTimesCache,
      surf_packs: scheduleSurfPacksCache,
    });
  }
  return fetch(scheduleSchoolConfigUrl(client), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      var profile = getPortalProfile(client);
      if (data && data.success){
        scheduleLessonTimesCache = (data.lesson_times && data.lesson_times.length)
          ? data.lesson_times.slice()
          : (profile.lesson_slots_demo || []).slice();
        scheduleSurfPacksCache = (data.surf_packs || []).slice();
        scheduleLessonTimesFallback = data.source !== 'db';
      } else {
        scheduleLessonTimesCache = (profile.lesson_slots_demo || []).slice();
        scheduleSurfPacksCache = [];
        scheduleLessonTimesFallback = true;
      }
      scheduleLessonTimesCacheLoc = loc;
      return { lesson_times: scheduleLessonTimesCache, surf_packs: scheduleSurfPacksCache };
    })
    .catch(function(){
      var profile = getPortalProfile(client);
      scheduleLessonTimesCache = (profile.lesson_slots_demo || []).slice();
      scheduleSurfPacksCache = [];
      scheduleLessonTimesFallback = true;
      scheduleLessonTimesCacheLoc = loc;
      return { lesson_times: scheduleLessonTimesCache, surf_packs: scheduleSurfPacksCache };
    });
}

function scheduleFetchLessonTimesConfig(client){
  return scheduleFetchSchoolConfig(client).then(function(cfg){
    scheduleLessonTimesCache = cfg.lesson_times || [];
    scheduleSurfPacksCache = cfg.surf_packs || [];
    return scheduleLessonTimesCache;
  });
}

function scheduleFetchSurfPackReservationCounts(client, dateIso){
  if (getClient() !== 'sunset') return Promise.resolve({});
  var loc = getSunsetLocation();
  var cacheKey = String(loc || '') + '|' + String(dateIso || '');
  if (scheduleSurfPackReservationCacheKey === cacheKey && scheduleSurfPackReservationCounts){
    return Promise.resolve(scheduleSurfPackReservationCounts);
  }
  var q = '/staff/schedule/surf-pack-counts?client=' + encodeURIComponent(client) +
    '&date=' + encodeURIComponent(dateIso) + '&location=' + encodeURIComponent(loc);
  return fetch(q, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(data){
      scheduleSurfPackReservationCounts = (data && data.counts && typeof data.counts === 'object') ? data.counts : {};
      scheduleSurfPackReservationCacheKey = cacheKey;
      return scheduleSurfPackReservationCounts;
    })
    .catch(function(){
      scheduleSurfPackReservationCounts = {};
      scheduleSurfPackReservationCacheKey = cacheKey;
      return scheduleSurfPackReservationCounts;
    });
}

function scheduleRenderSurfPacksTodayBreakdown(packs, counts){
  var sub = el('ps-surf-packs-sub');
  if (!sub) return;
  var list = (packs || []).slice();
  var html = '';
  list.forEach(function(p){
    var pid = String(p.pack_id || p.id || '');
    var n = counts && counts[pid] != null ? Number(counts[pid]) : 0;
    html += '<div class="portal-schedule-lesson-time-row">' +
      '<span class="portal-schedule-lesson-time">' + escHtml(p.label || portalT('schedule.packs.unnamed')) + '</span>' +
      '<span class="portal-schedule-lesson-time-count" title="' + escHtml(portalT('schedule.packs.reservations')) + '">' + escHtml(String(n)) + '</span>' +
      '</div>';
  });
  sub.innerHTML = html || ('<div class="portal-schedule-lesson-times-empty">' + escHtml(portalT('schedule.packs.none')) + '</div>');
}`;

must(s.includes(oldFetch), 'scheduleFetchLessonTimesConfig block not found');
s = s.replace(oldFetch, newFetch);

// --- limit lesson groups in summary card ---
s = s.replace(
  `function scheduleRenderLessonsTodayBreakdown(rows, todayIso, lessonTimes){
  var sub = el('ps-lessons-slot-sub');
  if (!sub) return;
  var slots = scheduleSlotsForDate(lessonTimes, todayIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);`,
  `function scheduleRenderLessonsTodayBreakdown(rows, todayIso, lessonTimes){
  var sub = el('ps-lessons-slot-sub');
  if (!sub) return;
  var slots = scheduleLimitLessonSlots(scheduleSlotsForDate(lessonTimes, todayIso));
  if (!slots.length) slots = scheduleLimitLessonSlots(scheduleUniqueConfiguredSlots(lessonTimes));`,
);

// --- limit lesson groups on ops board ---
s = s.replace(
  `function scheduleRenderOpsBoard(pack, dateIso, lessonTimes){
  pack = pack || { lessons: [], gear: [], rows: [] };
  var html = '';
  var slots = scheduleSlotsForDate(lessonTimes, dateIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);`,
  `function scheduleRenderOpsBoard(pack, dateIso, lessonTimes){
  pack = pack || { lessons: [], gear: [], rows: [] };
  var html = '';
  var slots = scheduleLimitLessonSlots(scheduleSlotsForDate(lessonTimes, dateIso));
  if (!slots.length) slots = scheduleLimitLessonSlots(scheduleUniqueConfiguredSlots(lessonTimes));`,
);

// --- limit in day body ---
s = s.replace(
  `function scheduleRenderDayBodyHtml(pack, dateIso, lessonTimes){
  var html = '';
  var slots = scheduleSlotsForDate(lessonTimes, dateIso);
  if (!slots.length) slots = scheduleUniqueConfiguredSlots(lessonTimes);`,
  `function scheduleRenderDayBodyHtml(pack, dateIso, lessonTimes){
  var html = '';
  var slots = scheduleLimitLessonSlots(scheduleSlotsForDate(lessonTimes, dateIso));
  if (!slots.length) slots = scheduleLimitLessonSlots(scheduleUniqueConfiguredSlots(lessonTimes));`,
);

// --- renderScheduleSummary: surf packs ---
s = s.replace(
  `function renderScheduleSummary(profile, weekData, convs){
  var today = scheduleTodayIso();
  var rows = scheduleRowsCache || [];
  scheduleRenderLessonsTodayBreakdown(rows, today, scheduleLessonTimesCache);`,
  `function renderScheduleSummary(profile, weekData, convs){
  var today = scheduleTodayIso();
  var rows = scheduleRowsCache || [];
  scheduleRenderLessonsTodayBreakdown(rows, today, scheduleLessonTimesCache);
  scheduleRenderSurfPacksTodayBreakdown(scheduleSurfPacksCache, scheduleSurfPackReservationCounts);`,
);

// --- loadSchedulePage: fetch pack counts ---
s = s.replace(
  `  var configP = scheduleFetchLessonTimesConfig(client);
  var dataP = scheduleViewMode === 'next30'
    ? scheduleFetchNext30(client, rangeStart)
    : scheduleFetchWeek(client, rangeStart);
  return Promise.all([convP, dataP, configP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];`,
  `  var configP = scheduleFetchSchoolConfig(client);
  var packCountsP = scheduleFetchSurfPackReservationCounts(client, scheduleTodayIso());
  var dataP = scheduleViewMode === 'next30'
    ? scheduleFetchNext30(client, rangeStart)
    : scheduleFetchWeek(client, rangeStart);
  return Promise.all([convP, dataP, configP, packCountsP]).then(function(results){
    var convData = results[0];
    var weekData = results[1];
    var schoolCfg = results[2] || {};
    scheduleLessonTimesCache = schoolCfg.lesson_times || [];
    scheduleSurfPacksCache = schoolCfg.surf_packs || [];
    scheduleLessonTimesCacheLoc = getClient() === 'sunset' ? getSunsetLocation() : null;`,
);

// --- API handler before handleSunsetScheduleDayGet ---
const handlerAnchor = 'async function handleSunsetScheduleDayGet(query, res, user) {';
must(s.includes(handlerAnchor), 'handleSunsetScheduleDayGet missing');

const packHandler = `async function handleSunsetScheduleSurfPackCountsGet(query, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  const dateIso = (String(query.date || '')).trim();
  const locationId = normalizeSunsetLocationId(query.location);
  if (SQL_INJECT_RE.test(clientSlug) || !isIsoDateStaff(dateIso)) return send400(res, 'invalid client or date');
  if (clientSlug !== SUNSET_CLIENT_SLUG) return sendJSON(res, 403, { success: false, error: 'sunset only' });
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  try {
    const counts = await withPgClient(async (pg) => {
      const result = await pg.query(getSunsetScheduleSurfPackReservationCountsQuery(), [clientSlug, dateIso, locationId]);
      const out = {};
      for (const row of result.rows) {
        if (row.pack_id) out[String(row.pack_id)] = Number(row.reservation_count) || 0;
      }
      return out;
    });
    return sendJSON(res, 200, {
      success: true,
      date: dateIso,
      location_id: locationId,
      counts,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    console.error('surf pack counts failed', err);
    return sendJSON(res, 500, { success: false, error: 'query failed' });
  }
}

async function handleSunsetScheduleDayGet(query, res, user) {`;

s = s.replace(handlerAnchor, packHandler);

// --- route ---
must(s.includes("pathname === '/staff/schedule/day'"), 'schedule day route missing');
s = s.replace(
  `  if (pathname === '/staff/schedule/day' && method === 'GET') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleSunsetScheduleDayGet(parsed.query, res, auth.user);
  }`,
  `  if (pathname === '/staff/schedule/surf-pack-counts' && method === 'GET') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleSunsetScheduleSurfPackCountsGet(parsed.query, res, auth.user);
  }
  if (pathname === '/staff/schedule/day' && method === 'GET') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleSunsetScheduleDayGet(parsed.query, res, auth.user);
  }`,
);

must(s.includes('schedule.card.surfPacks'), 'surf packs card missing');
must(s.includes('scheduleFetchSchoolConfig'), 'school config fetch missing');
must(s.includes('SCHEDULE_MAX_LESSON_GROUPS'), 'lesson group cap missing');
must(!s.includes('scheduleLessonTimesLoaded'), 'old global lesson cache flag remains');

fs.writeFileSync(path, s, 'utf8');
console.log('patch-schedule-packs-lessons ok, lines', s.split('\n').length);
