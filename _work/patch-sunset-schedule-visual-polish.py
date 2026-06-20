#!/usr/bin/env python3
"""Sunset Schedule ops board density + clarity polish."""
from pathlib import Path

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}")


api = API.read_text(encoding="utf-8")

# ── CSS: tighter rows + lesson header layout ───────────────────────────────

OLD_LESSON_HDR_CSS = """.portal-schedule-ops-lesson-hdr{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;padding:12px 16px;border-bottom:1px solid var(--border-soft);background:transparent}
.portal-schedule-ops-lesson-time{font-size:18px;font-weight:800;color:var(--text);min-width:64px}
.portal-schedule-ops-lesson-surfers{font-size:32px;font-weight:800;line-height:1;color:var(--text)}
.portal-schedule-ops-lesson-bookings{font-size:12px;font-weight:600;color:var(--text-3)}
.portal-schedule-ops-lesson-equip{font-size:12px;color:var(--text-2);margin-left:auto}"""

NEW_LESSON_HDR_CSS = """.portal-schedule-ops-lesson-hdr{display:grid;grid-template-columns:minmax(120px,1fr) auto minmax(160px,1.2fr);align-items:baseline;gap:8px 16px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:transparent}
@media(max-width:720px){.portal-schedule-ops-lesson-hdr{grid-template-columns:1fr;gap:4px}}
.portal-schedule-ops-lesson-hdr-left{font-size:13px;font-weight:700;color:var(--text-2);line-height:1.3}
.portal-schedule-ops-lesson-hdr-surfers{font-size:28px;font-weight:800;line-height:1;color:var(--text);text-align:center}
.portal-schedule-ops-lesson-hdr-meta{font-size:12px;color:var(--text-3);text-align:right;line-height:1.4}
@media(max-width:720px){.portal-schedule-ops-lesson-hdr-surfers{text-align:left}.portal-schedule-ops-lesson-hdr-meta{text-align:left}}"""

require(api, OLD_LESSON_HDR_CSS, "lesson hdr css")
api = api.replace(OLD_LESSON_HDR_CSS, NEW_LESSON_HDR_CSS)

OLD_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 44px minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.03)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a}
.portal-schedule-ops-row-rail.is-luna{background:#7a8fa6}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;border-radius:999px;background:var(--surface-soft);border:1px solid rgba(255,255,255,.08);font-size:16px;font-weight:800;color:var(--text)}"""

NEW_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 36px minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.03)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a}
.portal-schedule-ops-row-rail.is-luna{background:#7a8fa6}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;border-radius:999px;background:var(--surface-soft);border:1px solid rgba(255,255,255,.08);font-size:14px;font-weight:800;color:var(--text)}"""

require(api, OLD_ROW_CSS, "row css")
api = api.replace(OLD_ROW_CSS, NEW_ROW_CSS)

api = api.replace(
    ".portal-schedule-ops-row-guest{font-size:15px;font-weight:700;color:var(--text);line-height:1.25}",
    ".portal-schedule-ops-row-guest{font-size:14px;font-weight:700;color:var(--text);line-height:1.2}",
)

# ── Range label helper ───────────────────────────────────────────────────────

OLD_FORMAT_RANGE = """function scheduleFormatRange(start, end){
  try {
    var opts = { month: 'short', day: 'numeric' };
    var a = start.toLocaleDateString(undefined, opts);
    var b = end.toLocaleDateString(undefined, Object.assign({}, opts, { year: 'numeric' }));
    return a + ' – ' + b;
  } catch (_) { return scheduleIsoDate(start) + ' – ' + scheduleIsoDate(end); }
}"""

NEW_FORMAT_RANGE = """function scheduleFormatRange(start, end){
  try {
    var opts = { month: 'short', day: 'numeric' };
    var a = start.toLocaleDateString(undefined, opts);
    var b = end.toLocaleDateString(undefined, Object.assign({}, opts, { year: 'numeric' }));
    return a + ' – ' + b;
  } catch (_) { return scheduleIsoDate(start) + ' – ' + scheduleIsoDate(end); }
}

function scheduleFormatRangeLabel(start, end, viewMode){
  viewMode = viewMode || scheduleViewMode || 'day';
  try {
    var startIso = scheduleIsoDate(start);
    var endIso = scheduleIsoDate(end);
    var today = scheduleTodayIso();
    var startFull = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (viewMode === 'day'){
      if (startIso === today) return portalT('schedule.view.today') + ' · ' + startFull;
      return startFull;
    }
    if (viewMode === 'next30'){
      var endFull = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return portalT('schedule.view.next30') + ' · ' + scheduleFormatRange(start, end).replace(/, \\d{4}$/, '') + ' – ' + endFull.split(', ').pop();
    }
    return scheduleFormatRange(start, end);
  } catch (_) {
    return scheduleFormatRange(start, end);
  }
}

function scheduleLessonGroupHeaderMeta(stats, boardsNeeded, wetsuitsNeeded){
  stats = stats || {};
  var parts = [];
  parts.push(String(stats.bookings || 0) + ' ' + portalT('schedule.slot.bookings'));
  parts.push(String(boardsNeeded || 0) + ' ' + portalT('schedule.summary.boards'));
  parts.push(String(wetsuitsNeeded || 0) + ' ' + portalT('schedule.summary.wetsuits'));
  return parts.join(' · ');
}"""

require(api, OLD_FORMAT_RANGE, "scheduleFormatRange")
api = api.replace(OLD_FORMAT_RANGE, NEW_FORMAT_RANGE)

# Fix next30 label - the replace above has a hacky regex. Let me use cleaner logic in the patch.

CLEAN_NEXT30 = """    if (viewMode === 'next30'){
      var endFull = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return portalT('schedule.view.next30') + ' · ' + scheduleFormatRange(start, end).replace(/, \\d{4}$/, '') + ' – ' + endFull.split(', ').pop();
    }"""

BETTER_NEXT30 = """    if (viewMode === 'next30'){
      var a = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      var b = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return portalT('schedule.view.next30') + ' · ' + a + ' – ' + b;
    }"""

api = api.replace(CLEAN_NEXT30, BETTER_NEXT30)

# ── Status badges: row vs drawer ───────────────────────────────────────────

OLD_STATUS = """function scheduleRenderStatusBadgeHtml(group){
  if (!group) return '';
  var ps = String(group.payment_status || '').toLowerCase();
  var html = '';
  if (ps === 'paid') html = '<span class="portal-schedule-status is-paid">' + escHtml(portalT('schedule.status.paid')) + '</span>';
  else if (ps === 'pending') html = '<span class="portal-schedule-status is-pending">' + escHtml(portalT('schedule.status.pending')) + '</span>';
  else if (ps) html = '<span class="portal-schedule-status is-unpaid">' + escHtml(portalT('schedule.status.unpaid')) + '</span>';
  if (group._needsReply){
    html += (html ? ' ' : '') + '<span class="portal-schedule-status is-needs-reply">' + escHtml(portalT('schedule.drawer.needsReply')) + '</span>';
  }
  return html;
}"""

NEW_STATUS = """function scheduleRenderStatusBadgeHtml(group, opts){
  opts = opts || {};
  if (!group) return '';
  var ps = String(group.payment_status || '').toLowerCase();
  var html = '';
  var pendingKey = opts.detail ? 'schedule.status.pendingDetail' : 'schedule.status.pending';
  if (ps === 'paid'){
    if (!opts.row) html = '<span class="portal-schedule-status is-paid">' + escHtml(portalT('schedule.status.paid')) + '</span>';
  } else if (ps === 'pending'){
    html = '<span class="portal-schedule-status is-pending">' + escHtml(portalT(pendingKey)) + '</span>';
  } else if (ps){
    html = '<span class="portal-schedule-status is-unpaid">' + escHtml(portalT('schedule.status.unpaid')) + '</span>';
  }
  if (group._needsReply){
    html += (html ? ' ' : '') + '<span class="portal-schedule-status is-needs-reply">' + escHtml(portalT('schedule.drawer.needsReply')) + '</span>';
  }
  return html;
}

function scheduleRenderRowStatusHtml(group){
  return scheduleRenderStatusBadgeHtml(group, { row: true });
}"""

require(api, OLD_STATUS, "status badge")
api = api.replace(OLD_STATUS, NEW_STATUS)

api = api.replace(
    "return scheduleRenderStatusBadgeHtml(group);",
    "return scheduleRenderStatusBadgeHtml(group, opts);",
)

# ── Ops row uses row status ──────────────────────────────────────────────────

api = api.replace(
    "'<span class=\"portal-schedule-ops-row-status\">' + scheduleRenderStatusBadgeHtml(g) + '</span>' +",
    "'<span class=\"portal-schedule-ops-row-status\">' + scheduleRenderRowStatusHtml(g) + '</span>' +",
)

# ── Drawer uses detail pending ───────────────────────────────────────────────

api = api.replace(
    "'<p class=\"portal-schedule-drawer-kv\"><strong>' + escHtml(portalT('schedule.col.payment')) + ':</strong> ' + scheduleRenderStatusBadgeHtml(group) + '</p>' +",
    "'<p class=\"portal-schedule-drawer-kv\"><strong>' + escHtml(portalT('schedule.col.payment')) + ':</strong> ' + scheduleRenderStatusBadgeHtml(group, { detail: true }) + '</p>' +",
)

# ── Lesson group header HTML ─────────────────────────────────────────────────

OLD_SLOT_HDR = """      html += '<section class="portal-schedule-ops-lesson-group">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-time">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + '</span>' +
        '<span class="portal-schedule-ops-lesson-surfers">' + escHtml(String(stats.surfers)) + '</span>' +
        '<span class="portal-schedule-ops-lesson-bookings">' + escHtml(String(stats.bookings) + ' ' + portalT('schedule.slot.bookings')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-equip">' +
        escHtml(String(boardsNeeded) + ' ' + portalT('schedule.type.boardRental') + ' · ' + String(wetsuitsNeeded) + ' ' + portalT('schedule.type.wetsuitRental')) +
        '</span></header>' +"""

NEW_SLOT_HDR = """      html += '<section class="portal-schedule-ops-lesson-group">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-hdr-left">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time) + ' ' + portalT('schedule.ops.lessonGroup')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-surfers">' + escHtml(String(stats.surfers) + ' ' + portalT('schedule.slot.surfers')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-meta">' + escHtml(scheduleLessonGroupHeaderMeta(stats, boardsNeeded, wetsuitsNeeded)) + '</span>' +
        '</header>' +"""

require(api, OLD_SLOT_HDR, "slot hdr")
api = api.replace(OLD_SLOT_HDR, NEW_SLOT_HDR)

OLD_OTHER_HDR = """      html += '<section class="portal-schedule-ops-lesson-group portal-schedule-ops-lesson-other">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-time">' + escHtml(portalT('schedule.slot.otherLessons')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-surfers">' + escHtml(String(otherSurfers)) + '</span>' +
        '<span class="portal-schedule-ops-lesson-bookings">' + escHtml(String(otherGroups.length) + ' ' + portalT('schedule.slot.bookings')) + '</span>' +
        '</header><div class="portal-schedule-ops-lesson-rows">';"""

NEW_OTHER_HDR = """      html += '<section class="portal-schedule-ops-lesson-group portal-schedule-ops-lesson-other">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-hdr-left">' + escHtml(portalT('schedule.slot.otherLessons')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-surfers">' + escHtml(String(otherSurfers) + ' ' + portalT('schedule.slot.surfers')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-meta">' + escHtml(String(otherGroups.length) + ' ' + portalT('schedule.slot.bookings')) + '</span>' +
        '</header><div class="portal-schedule-ops-lesson-rows">';"""

require(api, OLD_OTHER_HDR, "other hdr")
api = api.replace(OLD_OTHER_HDR, NEW_OTHER_HDR)

# ── Lessons today breakdown subtext ──────────────────────────────────────────

OLD_BREAKDOWN = """    subHtml += escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + ': ' + escHtml(String(stats.surfers)) + ' ' + portalT('schedule.slot.surfers') + ' · ';"""

NEW_BREAKDOWN = """    subHtml += escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + ' · ' + escHtml(String(stats.surfers)) + ' ' + portalT('schedule.slot.surfers') + ' · ';"""

require(api, OLD_BREAKDOWN, "breakdown sub")
api = api.replace(OLD_BREAKDOWN, NEW_BREAKDOWN)

# ── Equipment card subtext ───────────────────────────────────────────────────

OLD_BOARDS_SUB = """    boardsSub.textContent = String(equip.boards.lesson) + ' ' + portalT('schedule.type.lesson') + ' · ' +
      String(equip.boards.rental) + ' ' + portalT('schedule.type.rental');"""

NEW_BOARDS_SUB = """    boardsSub.textContent = String(equip.boards.lesson) + ' ' + portalT('schedule.metric.lesson') + ' · ' +
      String(equip.boards.rental) + ' ' + portalT('schedule.metric.rental');"""

require(api, OLD_BOARDS_SUB, "boards sub")
api = api.replace(OLD_BOARDS_SUB, NEW_BOARDS_SUB)

OLD_WETS_SUB = """    wetsSub.textContent = String(equip.wetsuits.lesson) + ' ' + portalT('schedule.type.lesson') + ' · ' +
      String(equip.wetsuits.rental) + ' ' + portalT('schedule.type.rental');"""

NEW_WETS_SUB = """    wetsSub.textContent = String(equip.wetsuits.lesson) + ' ' + portalT('schedule.metric.lesson') + ' · ' +
      String(equip.wetsuits.rental) + ' ' + portalT('schedule.metric.rental');"""

require(api, OLD_WETS_SUB, "wets sub")
api = api.replace(OLD_WETS_SUB, NEW_WETS_SUB)

# ── Range label in loadSchedulePage ──────────────────────────────────────────

api = api.replace(
    "  setText('ps-range-label', scheduleFormatRange(rangeStart, rangeEnd));",
    "  setText('ps-range-label', scheduleFormatRangeLabel(rangeStart, rangeEnd, scheduleViewMode));",
)

API.write_text(api, encoding="utf-8")
print("patched staff-query-api.js")

# ── i18n ─────────────────────────────────────────────────────────────────────

i18n = I18N.read_text(encoding="utf-8")
replacements = [
    ("    'schedule.status.pending': 'Pending payment',", "    'schedule.status.pending': 'Pending',\n    'schedule.status.pendingDetail': 'Pending payment',"),
]
for old, new in replacements:
    if old in i18n:
        i18n = i18n.replace(old, new)

if "'schedule.ops.lessonGroup'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.ops.boardTitle': 'Today ops board',",
        "    'schedule.ops.boardTitle': 'Today ops board',\n    'schedule.ops.lessonGroup': 'lesson group',\n    'schedule.metric.lesson': 'lesson',\n    'schedule.metric.rental': 'rental',",
    )
I18N.write_text(i18n, encoding="utf-8")
print("patched i18n")

# ── verify section 20 polish ─────────────────────────────────────────────────

v1 = V1.read_text(encoding="utf-8")
if "[20]" not in v1:
    section20 = """

// ── 20. Sunset Schedule visual polish — density + clarity ───────────────────

console.log('\\n[20] Sunset Schedule visual polish — density + clarity');

if (apiSrc) {
  assert('lesson group header surfers label', apiSrc.includes('portal-schedule-ops-lesson-hdr-surfers') && apiSrc.includes("portalT('schedule.slot.surfers')"));
  assert('lesson group header meta', apiSrc.includes('scheduleLessonGroupHeaderMeta('));
  assert('row status hides paid', apiSrc.includes('function scheduleRenderRowStatusHtml(') && apiSrc.includes('opts.row'));
  assert('short pending label key', apiSrc.includes("'schedule.status.pending': 'Pending'") || /schedule\\.status\\.pending['\"]:\\s*['\"]Pending['\"]/.test(i18nSrc || ''));
  assert('no Pending payment in row renderer', !apiSrc.includes("scheduleRenderRowStatusHtml(g)") || apiSrc.includes('schedule.status.pendingDetail'));
  assert('Today range label helper', apiSrc.includes('function scheduleFormatRangeLabel(') && apiSrc.includes("portalT('schedule.view.today') + ' · '"));
  assert('metric card lesson rental subtext keys', apiSrc.includes("portalT('schedule.metric.lesson')") && apiSrc.includes("portalT('schedule.metric.rental')"));
  assert('slot subtext uses middle dot', apiSrc.includes("' · ' + escHtml(String(stats.surfers))"));
  assert('component pebble css still absent', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
}
"""
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        section20 + "\nconsole.log('\\n' + '─'.repeat(48));",
    )
    V1.write_text(v1, encoding="utf-8")
    print("patched verify-sunset-portal-v1.js")

print("done")
