#!/usr/bin/env python3
"""Sunset Schedule prep-sheet layout — column rows, strong headers, rental pickups."""
from pathlib import Path

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}")


api = API.read_text(encoding="utf-8")

# ── CSS: prep sheet layout ───────────────────────────────────────────────────

OLD_OPS_CSS_BLOCK = """.portal-schedule-ops-lesson-hdr{display:grid;grid-template-columns:minmax(120px,1fr) auto minmax(160px,1.2fr);align-items:baseline;gap:8px 16px;padding:10px 14px;border-bottom:1px solid var(--border-soft);background:transparent}
@media(max-width:720px){.portal-schedule-ops-lesson-hdr{grid-template-columns:1fr;gap:4px}}
.portal-schedule-ops-lesson-hdr-left{font-size:13px;font-weight:700;color:var(--text-2);line-height:1.3}
.portal-schedule-ops-lesson-hdr-surfers{font-size:28px;font-weight:800;line-height:1;color:var(--text);text-align:center}
.portal-schedule-ops-lesson-hdr-meta{font-size:12px;color:var(--text-3);text-align:right;line-height:1.4}
@media(max-width:720px){.portal-schedule-ops-lesson-hdr-surfers{text-align:left}.portal-schedule-ops-lesson-hdr-meta{text-align:left}}
.portal-schedule-ops-lesson-rows{display:flex;flex-direction:column;gap:0}
.portal-schedule-ops-row{display:grid;grid-template-columns:4px 36px minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.03)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a}
.portal-schedule-ops-row-rail.is-luna{background:#7a8fa6}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;border-radius:999px;background:var(--surface-soft);border:1px solid rgba(255,255,255,.08);font-size:14px;font-weight:800;color:var(--text)}
.portal-schedule-ops-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.portal-schedule-ops-row-guest{font-size:14px;font-weight:700;color:var(--text);line-height:1.2}
.portal-schedule-ops-row-summary{font-size:12px;color:var(--text-3);line-height:1.35}
.portal-schedule-ops-row-status{text-align:right;justify-self:end}
.portal-schedule-ops-rental-prep{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media(max-width:800px){.portal-schedule-ops-rental-prep{grid-template-columns:1fr}}
.portal-schedule-ops-rental-block{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:12px 14px}
.portal-schedule-ops-rental-hdr{font-size:13px;font-weight:800;margin-bottom:10px;display:flex;justify-content:space-between;gap:8px}
.portal-schedule-ops-rental-total{font-size:20px;font-weight:800;color:var(--text)}"""

NEW_OPS_CSS_BLOCK = """.portal-schedule-ops-lesson-hdr{padding:14px 16px;border-bottom:1px solid var(--border-soft);background:rgba(255,255,255,.04)}
.portal-schedule-ops-lesson-hdr-title{font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text);line-height:1.3}
.portal-schedule-ops-lesson-hdr-booked{font-size:15px;font-weight:600;color:var(--text-2);margin-top:6px;line-height:1.35}
.portal-schedule-ops-lesson-hdr-prep{font-size:13px;color:var(--text-3);margin-top:4px;line-height:1.35}
.portal-schedule-ops-lesson-rows{display:flex;flex-direction:column;gap:0}
.portal-schedule-ops-col-hdr{display:grid;grid-template-columns:4px 40px minmax(120px,1.5fr) minmax(96px,1fr) 72px;gap:10px;padding:6px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);border-bottom:1px solid var(--border-soft);background:var(--surface-soft)}
.portal-schedule-ops-col-hdr span:nth-child(n+3){padding-left:2px}
.portal-schedule-ops-row{display:grid;grid-template-columns:4px 40px minmax(120px,1.5fr) minmax(96px,1fr) 72px;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
@media(max-width:720px){.portal-schedule-ops-col-hdr,.portal-schedule-ops-row{grid-template-columns:4px 36px 1fr 88px}.portal-schedule-ops-row-equip{grid-column:3;font-size:10px;margin-top:-2px}.portal-schedule-ops-row-status{grid-column:4;grid-row:1}.portal-schedule-ops-row-guest-col{grid-row:1}}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.03)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a}
.portal-schedule-ops-row-rail.is-luna{background:#7a8fa6}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:32px;border-radius:999px;background:var(--surface-soft);border:1px solid rgba(255,255,255,.08);font-size:14px;font-weight:800;color:var(--text)}
.portal-schedule-ops-row-guest-col{display:flex;flex-direction:column;gap:1px;min-width:0}
.portal-schedule-ops-row-guest{font-size:14px;font-weight:700;color:var(--text);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.portal-schedule-ops-row-source{font-size:10px;color:var(--text-3);line-height:1.2}
.portal-schedule-ops-row-equip{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-2);line-height:1.3}
.portal-schedule-ops-row-status{text-align:right;font-size:11px}
.portal-schedule-metric-slots{font-size:13px;line-height:1.6;color:var(--text-2)}
.portal-schedule-metric-slots .portal-schedule-metric-slot{display:block;font-weight:600}
.portal-schedule-ops-rental-pickups{margin-top:20px;border:1px solid rgba(255,255,255,.08);border-radius:var(--radius);background:var(--surface);overflow:hidden}
.portal-schedule-ops-rental-pickups-hdr{padding:12px 16px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text);border-bottom:1px solid var(--border-soft);background:rgba(255,255,255,.04)}
.portal-schedule-ops-rental-pickups-block{padding:0 0 8px;border-bottom:1px solid var(--border-soft)}
.portal-schedule-ops-rental-pickups-block:last-child{border-bottom:none}
.portal-schedule-ops-rental-pickups-subhdr{padding:10px 16px 6px;font-size:13px;font-weight:700;color:var(--text-2)}"""

require(api, OLD_OPS_CSS_BLOCK, "ops css block")
api = api.replace(OLD_OPS_CSS_BLOCK, NEW_OPS_CSS_BLOCK)

# metric card label
api = api.replace(
    'data-i18n="schedule.card.lessonsToday">Lesson surfers',
    'data-i18n="schedule.card.lessonGroups">Lesson groups',
)

# ── Helpers ──────────────────────────────────────────────────────────────────

INSERT_AFTER = "function scheduleLessonGroupHeaderMeta(stats, boardsNeeded, wetsuitsNeeded){"
NEW_HELPERS = r"""function scheduleEquipmentPrepLabel(group){
  var boards = scheduleGroupBoardsNeeded(group);
  var wets = scheduleGroupWetsuitsNeeded(group);
  if (boards && wets) return portalT('schedule.equipment.boardAndWetsuit');
  if (boards) return portalT('schedule.equipment.board');
  if (wets) return portalT('schedule.equipment.wetsuit');
  return portalT('schedule.equipment.none');
}

function scheduleRenderLessonGroupHeader(slotTime, stats, boardsNeeded, wetsuitsNeeded){
  stats = stats || {};
  var time = scheduleNormalizeSlotTime(slotTime || '');
  return '<header class="portal-schedule-ops-lesson-hdr">' +
    '<div class="portal-schedule-ops-lesson-hdr-title">' + escHtml(time + ' ' + portalT('schedule.ops.lessonGroupTitle')) + '</div>' +
    '<div class="portal-schedule-ops-lesson-hdr-booked">' + escHtml(String(stats.surfers || 0) + ' ' + portalT('schedule.slot.booked') + ' · ' + String(stats.bookings || 0) + ' ' + portalT('schedule.slot.bookings')) + '</div>' +
    '<div class="portal-schedule-ops-lesson-hdr-prep">' + escHtml(portalT('schedule.ops.prepare') + ': ' + String(boardsNeeded || 0) + ' ' + portalT('schedule.summary.boards') + ' · ' + String(wetsuitsNeeded || 0) + ' ' + portalT('schedule.summary.wetsuits')) + '</div>' +
    '</header>';
}

function scheduleRenderOpsColumnHeader(){
  return '<div class="portal-schedule-ops-col-hdr">' +
    '<span></span><span>' + escHtml(portalT('schedule.col.qty')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.guest')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.equipment')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.status')) + '</span></div>';
}

"""

require(api, INSERT_AFTER, "insert point")
api = api.replace(INSERT_AFTER, NEW_HELPERS + INSERT_AFTER)

# Replace scheduleRenderOpsBookingRow entirely
OLD_ROW = """function scheduleRenderOpsBookingRow(group){
  var g = group;
  if (!g) return '';
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var railCls = src === 'staff' ? ' is-staff' : (src === 'luna' ? ' is-luna' : '');
  var qty = scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  var summary = scheduleServiceSummaryText(g);
  return '<div class="portal-schedule-ops-row' + (g._needsReply ? ' needs-reply' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true" title="' + escHtml(scheduleRowSourceLabel(g)) + '"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty)) + '</span>' +
    '<div class="portal-schedule-ops-row-main">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    (summary ? '<span class="portal-schedule-ops-row-summary">' + escHtml(summary) + '</span>' : '') +
    '</div>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleRenderRowStatusHtml(g) + '</span>' +
    '</div>';
}"""

NEW_ROW = """function scheduleRenderOpsBookingRow(group){
  var g = group;
  if (!g) return '';
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var railCls = src === 'staff' ? ' is-staff' : (src === 'luna' ? ' is-luna' : '');
  var qty = scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  var srcLabel = (src === 'staff' || src === 'luna') ? scheduleRowSourceLabel(g) : '';
  var equip = scheduleEquipmentPrepLabel(g);
  return '<div class="portal-schedule-ops-row' + (g._needsReply ? ' needs-reply' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty)) + '</span>' +
    '<div class="portal-schedule-ops-row-guest-col">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    (srcLabel ? '<span class="portal-schedule-ops-row-source">' + escHtml(srcLabel) + '</span>' : '') +
    '</div>' +
    '<span class="portal-schedule-ops-row-equip">' + escHtml(equip) + '</span>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleRenderRowStatusHtml(g) + '</span>' +
    '</div>';
}"""

require(api, OLD_ROW, "ops row")
api = api.replace(OLD_ROW, NEW_ROW)

# Lesson group header in ops board
OLD_SLOT_HDR = """      html += '<section class="portal-schedule-ops-lesson-group">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-hdr-left">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time) + ' ' + portalT('schedule.ops.lessonGroup')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-surfers">' + escHtml(String(stats.surfers) + ' ' + portalT('schedule.slot.surfers')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-meta">' + escHtml(scheduleLessonGroupHeaderMeta(stats, boardsNeeded, wetsuitsNeeded)) + '</span>' +
        '</header>' +
        '<div class="portal-schedule-ops-lesson-rows">';"""

NEW_SLOT_HDR = """      html += '<section class="portal-schedule-ops-lesson-group">' +
        scheduleRenderLessonGroupHeader(slot.slot_time, stats, boardsNeeded, wetsuitsNeeded) +
        '<div class="portal-schedule-ops-lesson-rows">' +
        scheduleRenderOpsColumnHeader();"""

require(api, OLD_SLOT_HDR, "slot hdr")
api = api.replace(OLD_SLOT_HDR, NEW_SLOT_HDR)

OLD_OTHER_HDR = """      html += '<section class="portal-schedule-ops-lesson-group portal-schedule-ops-lesson-other">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<span class="portal-schedule-ops-lesson-hdr-left">' + escHtml(portalT('schedule.slot.otherLessons')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-surfers">' + escHtml(String(otherSurfers) + ' ' + portalT('schedule.slot.surfers')) + '</span>' +
        '<span class="portal-schedule-ops-lesson-hdr-meta">' + escHtml(String(otherGroups.length) + ' ' + portalT('schedule.slot.bookings')) + '</span>' +
        '</header><div class="portal-schedule-ops-lesson-rows">';"""

NEW_OTHER_HDR = """      var otherBoards = otherGroups.reduce(function(a, g){ return a + scheduleGroupBoardsNeeded(g); }, 0);
      var otherWets = otherGroups.reduce(function(a, g){ return a + scheduleGroupWetsuitsNeeded(g); }, 0);
      html += '<section class="portal-schedule-ops-lesson-group portal-schedule-ops-lesson-other">' +
        '<header class="portal-schedule-ops-lesson-hdr">' +
        '<div class="portal-schedule-ops-lesson-hdr-title">' + escHtml(portalT('schedule.slot.otherLessons')) + '</div>' +
        '<div class="portal-schedule-ops-lesson-hdr-booked">' + escHtml(String(otherSurfers) + ' ' + portalT('schedule.slot.booked') + ' · ' + String(otherGroups.length) + ' ' + portalT('schedule.slot.bookings')) + '</div>' +
        '<div class="portal-schedule-ops-lesson-hdr-prep">' + escHtml(portalT('schedule.ops.prepare') + ': ' + String(otherBoards) + ' ' + portalT('schedule.summary.boards') + ' · ' + String(otherWets) + ' ' + portalT('schedule.summary.wetsuits')) + '</div>' +
        '</header><div class="portal-schedule-ops-lesson-rows">' + scheduleRenderOpsColumnHeader();"""

require(api, OLD_OTHER_HDR, "other hdr")
api = api.replace(OLD_OTHER_HDR, NEW_OTHER_HDR)

# Rental pickups section
OLD_RENTAL = """  var gearGroups = scheduleBuildDisplayGroups(pack.gear || []).filter(scheduleGroupHasOnlyGear);
  var boardRentals = gearGroups.filter(function(g){ return g.components && g.components.surfboard; });
  var wetsuitRentals = gearGroups.filter(function(g){ return g.components && g.components.wetsuit; });
  if (boardRentals.length || wetsuitRentals.length){
    html += '<section class="portal-schedule-ops-rental-prep">';
    if (boardRentals.length){
      var boardTotal = boardRentals.reduce(function(a, g){ return a + scheduleGroupBoardsNeeded(g); }, 0);
      html += '<div class="portal-schedule-ops-rental-block portal-schedule-ops-rental-boards">' +
        '<header class="portal-schedule-ops-rental-hdr">' + escHtml(portalT('schedule.type.boardRental')) +
        ' <span class="portal-schedule-ops-rental-total">' + escHtml(String(boardTotal)) + '</span></header>';
      boardRentals.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
      html += '</div>';
    }
    if (wetsuitRentals.length){
      var wetsuitTotal = wetsuitRentals.reduce(function(a, g){ return a + scheduleGroupWetsuitsNeeded(g); }, 0);
      html += '<div class="portal-schedule-ops-rental-block portal-schedule-ops-rental-wetsuits">' +
        '<header class="portal-schedule-ops-rental-hdr">' + escHtml(portalT('schedule.type.wetsuitRental')) +
        ' <span class="portal-schedule-ops-rental-total">' + escHtml(String(wetsuitTotal)) + '</span></header>';
      wetsuitRentals.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
      html += '</div>';
    }
    html += '</section>';
  }"""

NEW_RENTAL = """  var gearGroups = scheduleBuildDisplayGroups(pack.gear || []).filter(scheduleGroupHasOnlyGear);
  var boardRentals = gearGroups.filter(function(g){ return g.components && g.components.surfboard; });
  var wetsuitRentals = gearGroups.filter(function(g){ return g.components && g.components.wetsuit; });
  if (boardRentals.length || wetsuitRentals.length){
    html += '<section class="portal-schedule-ops-rental-pickups">' +
      '<header class="portal-schedule-ops-rental-pickups-hdr">' + escHtml(portalT('schedule.ops.rentalPickupsToday')) + '</header>';
    if (boardRentals.length){
      var boardTotal = boardRentals.reduce(function(a, g){ return a + scheduleGroupBoardsNeeded(g); }, 0);
      html += '<div class="portal-schedule-ops-rental-pickups-block">' +
        '<div class="portal-schedule-ops-rental-pickups-subhdr">' + escHtml(portalT('schedule.ops.surfboardsNeeded') + ': ' + String(boardTotal)) + '</div>' +
        scheduleRenderOpsColumnHeader();
      boardRentals.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
      html += '</div>';
    }
    if (wetsuitRentals.length){
      var wetsuitTotal = wetsuitRentals.reduce(function(a, g){ return a + scheduleGroupWetsuitsNeeded(g); }, 0);
      html += '<div class="portal-schedule-ops-rental-pickups-block">' +
        '<div class="portal-schedule-ops-rental-pickups-subhdr">' + escHtml(portalT('schedule.ops.wetsuitsNeeded') + ': ' + String(wetsuitTotal)) + '</div>' +
        scheduleRenderOpsColumnHeader();
      wetsuitRentals.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
      html += '</div>';
    }
    html += '</section>';
  }"""

require(api, OLD_RENTAL, "rental section")
api = api.replace(OLD_RENTAL, NEW_RENTAL)

# Top card lesson breakdown — simpler slot lines
OLD_BREAKDOWN = """  var subHtml = '';
  slots.forEach(function(slot){
    var stats = scheduleSlotAggregates(todayLessons, slot);
    subHtml += escHtml(scheduleNormalizeSlotTime(slot.slot_time)) + ' · ' + escHtml(String(stats.surfers)) + ' ' + portalT('schedule.slot.surfers') + ' · ';
  });
  if (scheduleLessonTimesFallback) subHtml += escHtml(portalT('schedule.slot.fallbackNotice'));
  if (sub) sub.textContent = subHtml.replace(/ · $/, '') || portalT('schedule.lessons.noSlotsToday');"""

NEW_BREAKDOWN = """  var subHtml = '';
  slots.forEach(function(slot){
    var stats = scheduleSlotAggregates(todayLessons, slot);
    subHtml += '<span class="portal-schedule-metric-slot">' + escHtml(scheduleNormalizeSlotTime(slot.slot_time) + ' — ' + String(stats.surfers)) + '</span>';
  });
  if (scheduleLessonTimesFallback) subHtml += '<span class="portal-schedule-metric-slot">' + escHtml(portalT('schedule.slot.fallbackNotice')) + '</span>';
  if (sub){
    sub.className = 'portal-schedule-card-sub portal-schedule-metric-slots';
    sub.innerHTML = subHtml || escHtml(portalT('schedule.lessons.noSlotsToday'));
  }"""

require(api, OLD_BREAKDOWN, "breakdown")
api = api.replace(OLD_BREAKDOWN, NEW_BREAKDOWN)

# Drawer — add equipment line
OLD_DRAWER_LIST = """    scheduleRenderComponentListHtml(group) +"""
NEW_DRAWER_LIST = """    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.equipment')) + ':</strong> ' + escHtml(scheduleEquipmentPrepLabel(group)) + '</p>' +
    scheduleRenderComponentListHtml(group) +"""

require(api, OLD_DRAWER_LIST, "drawer equip")
api = api.replace(OLD_DRAWER_LIST, NEW_DRAWER_LIST)

API.write_text(api, encoding="utf-8")
print("patched staff-query-api.js")

# ── i18n ─────────────────────────────────────────────────────────────────────

i18n = I18N.read_text(encoding="utf-8")
ADDITIONS = """
    'schedule.card.lessonGroups': 'Lesson groups',
    'schedule.slot.booked': 'booked',
    'schedule.ops.lessonGroupTitle': 'LESSON GROUP',
    'schedule.ops.prepare': 'Prepare',
    'schedule.ops.rentalPickupsToday': 'Rental pickups today',
    'schedule.ops.surfboardsNeeded': 'Surfboards needed',
    'schedule.ops.wetsuitsNeeded': 'Wetsuits needed',
    'schedule.col.qty': 'Qty',
    'schedule.col.guest': 'Guest',
    'schedule.col.equipment': 'Equipment',
    'schedule.col.status': 'Status',
    'schedule.equipment.boardAndWetsuit': 'board + wetsuit',
    'schedule.equipment.board': 'board',
    'schedule.equipment.wetsuit': 'wetsuit',
    'schedule.equipment.none': 'no equipment',
"""
if "'schedule.equipment.none'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.metric.rental': 'rental',",
        "    'schedule.metric.rental': 'rental'," + ADDITIONS,
    )
I18N.write_text(i18n, encoding="utf-8")
print("patched i18n")

# ── verify ───────────────────────────────────────────────────────────────────

v1 = V1.read_text(encoding="utf-8")

v1 = v1.replace(
    "  assert('ops row summary markup', apiSrc.includes('portal-schedule-ops-row-summary'));",
    "  assert('ops row equipment column', apiSrc.includes('portal-schedule-ops-row-equip'));",
)

v1 = v1.replace(
    "  assert('lesson group header surfers label', apiSrc.includes('portal-schedule-ops-lesson-hdr-surfers') && apiSrc.includes(\"portalT('schedule.slot.surfers')\"));",
    "  assert('lesson group header booked label', apiSrc.includes('portal-schedule-ops-lesson-hdr-booked') && apiSrc.includes(\"portalT('schedule.slot.booked')\"));",
)

v1 = v1.replace(
    "  assert('slot subtext uses middle dot', apiSrc.includes(\"' · ' + escHtml(String(stats.surfers))\"));",
    "  assert('metric slot summary lines', apiSrc.includes('portal-schedule-metric-slot') && apiSrc.includes(\"' — ' + String(stats.surfers)\"));",
)

if "[21]" not in v1:
    section21 = """

// ── 21. Sunset Schedule prep-sheet layout ───────────────────────────────────

console.log('\\n[21] Sunset Schedule prep-sheet layout');

if (apiSrc) {
  assert('lesson group prepare header', apiSrc.includes('portal-schedule-ops-lesson-hdr-prep') && apiSrc.includes("portalT('schedule.ops.prepare')"));
  assert('ops column header row', apiSrc.includes('scheduleRenderOpsColumnHeader(') && apiSrc.includes('portal-schedule-ops-col-hdr'));
  assert('equipment prep label helper', apiSrc.includes('function scheduleEquipmentPrepLabel('));
  assert('equipment column on rows', apiSrc.includes('portal-schedule-ops-row-equip'));
  assert('rental pickups section', apiSrc.includes('portal-schedule-ops-rental-pickups') && apiSrc.includes("portalT('schedule.ops.surfboardsNeeded')"));
  assert('short pending in rows', apiSrc.includes("'schedule.status.pending': 'Pending'") || /schedule\\.status\\.pending['\"]:\\s*['\"]Pending['\"]/.test(i18nSrc || ''));
  assert('no component pebble css', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('create booking still works', apiSrc.includes('submitScheduleManualBooking'));
}
"""
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        section21 + "\nconsole.log('\\n' + '─'.repeat(48));",
    )

V1.write_text(v1, encoding="utf-8")
print("patched verify-sunset-portal-v1.js")
print("done")
