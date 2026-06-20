#!/usr/bin/env python3
"""Sunset Schedule visual refine — muted ops board, no component tag soup."""
from pathlib import Path
import re

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}: {needle[:80]}...")


api = API.read_text(encoding="utf-8")

# ── CSS: muted palette + row hierarchy ───────────────────────────────────────

OLD_PEBBLE_CSS = """.portal-schedule-pebble{display:inline-flex;align-items:center;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.portal-schedule-pebble.lesson{background:#fde68a;color:#92400e}
.portal-schedule-pebble.surfboard{background:#bfdbfe;color:#1e3a8a}
.portal-schedule-pebble.wetsuit{background:#fbcfe8;color:#831843}
.portal-schedule-pebble.paid{background:#bbf7d0;color:#14532d}
.portal-schedule-pebble.unpaid{background:#fecaca;color:#7f1d1d}
.portal-schedule-pebble.pending{background:#fed7aa;color:#9a3412}
.portal-schedule-pebble.needs-reply{background:#e9d5ff;color:#581c87}
.portal-schedule-pebble.source-staff{background:#bbf7d0;color:#14532d}
.portal-schedule-pebble.source-luna{background:#bfdbfe;color:#1e3a8a}"""

NEW_PEBBLE_CSS = """.portal-schedule-status{display:inline-block;font-size:11px;font-weight:600;line-height:1.3;white-space:nowrap}
.portal-schedule-status.is-paid{color:#6b8f71}
.portal-schedule-status.is-pending,.portal-schedule-status.is-unpaid{color:#b8935a}
.portal-schedule-status.is-needs-reply{color:#9a8ab8}
.portal-schedule-pebble{display:none}
.portal-schedule-drawer-source{font-size:11px;font-weight:600;letter-spacing:.02em;margin-bottom:8px}
.portal-schedule-drawer-source.is-staff{color:#7d9b8a}
.portal-schedule-drawer-source.is-luna{color:#7a8fa6}
.portal-schedule-drawer-components{list-style:none;margin:10px 0 14px;padding:0}
.portal-schedule-drawer-components li{font-size:13px;color:var(--text-2);padding:7px 0;border-bottom:1px solid var(--border-soft)}
.portal-schedule-drawer-components li:last-child{border-bottom:none}
.portal-schedule-drawer-comp-label{color:var(--text);font-weight:600}"""

require(api, OLD_PEBBLE_CSS, "pebble css")
api = api.replace(OLD_PEBBLE_CSS, NEW_PEBBLE_CSS)

OLD_CARD_CSS = ".portal-schedule-card{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow-soft)}"
NEW_CARD_CSS = ".portal-schedule-card{background:var(--surface);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius);padding:14px 16px;box-shadow:none}"
api = api.replace(OLD_CARD_CSS, NEW_CARD_CSS)

OLD_OPS_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 52px 1fr auto auto;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:var(--surface-soft)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#16a34a}
.portal-schedule-ops-row-rail.is-luna{background:#2563eb}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;border-radius:999px;background:var(--surface-soft);border:1px solid var(--border-soft);font-size:18px;font-weight:800;color:var(--text)}
.portal-schedule-ops-row-guest{font-size:15px;font-weight:700;color:var(--text)}
.portal-schedule-ops-row-pebbles{justify-self:end}"""

NEW_OPS_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 44px minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.03)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft)}
.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a}
.portal-schedule-ops-row-rail.is-luna{background:#7a8fa6}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;border-radius:999px;background:var(--surface-soft);border:1px solid rgba(255,255,255,.08);font-size:16px;font-weight:800;color:var(--text)}
.portal-schedule-ops-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.portal-schedule-ops-row-guest{font-size:15px;font-weight:700;color:var(--text);line-height:1.25}
.portal-schedule-ops-row-summary{font-size:12px;color:var(--text-3);line-height:1.35}
.portal-schedule-ops-row-status{text-align:right;justify-self:end}"""

require(api, OLD_OPS_ROW_CSS, "ops row css")
api = api.replace(OLD_OPS_ROW_CSS, NEW_OPS_ROW_CSS)

OLD_LESSON_HDR = ".portal-schedule-ops-lesson-hdr{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px 16px;padding:14px 16px;border-bottom:1px solid var(--border-soft);background:var(--surface-soft)}"
NEW_LESSON_HDR = ".portal-schedule-ops-lesson-hdr{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 14px;padding:12px 16px;border-bottom:1px solid var(--border-soft);background:transparent}"
api = api.replace(OLD_LESSON_HDR, NEW_LESSON_HDR)

OLD_LESSON_GROUP = ".portal-schedule-ops-lesson-group{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-soft)}"
NEW_LESSON_GROUP = ".portal-schedule-ops-lesson-group{background:var(--surface);border:1px solid rgba(255,255,255,.06);border-radius:var(--radius);overflow:hidden;box-shadow:none}"
api = api.replace(OLD_LESSON_GROUP, NEW_LESSON_GROUP)

OLD_CREATE_COMP = ".portal-schedule-create-components{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}\n.portal-schedule-create-components label{font-size:12px;display:flex;align-items:center;gap:6px}"
NEW_CREATE_COMP = ".portal-schedule-create-components{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}\n.portal-schedule-create-components label{font-size:12px;display:flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid rgba(255,255,255,.08);border-radius:var(--radius-sm);background:var(--surface-soft);color:var(--text-2);cursor:pointer}"
api = api.replace(OLD_CREATE_COMP, NEW_CREATE_COMP)

# ── JS helpers ───────────────────────────────────────────────────────────────

OLD_PEBBLES_FN = """function scheduleRenderPebblesHtml(group, opts){
  opts = opts || {};
  var html = '';
  var comps = group && group.components ? Object.keys(group.components) : scheduleRowComponents(group);
  (comps || []).forEach(function(c){
    html += '<span class="portal-schedule-pebble ' + escHtml(c) + '">' + escHtml(scheduleComponentLabel(c)) + '</span>';
  });
  if (opts.payment !== false){
    var ps = String((group && group.payment_status) || '').toLowerCase();
    if (ps) html += '<span class="portal-schedule-pebble ' + escHtml(ps === 'paid' ? 'paid' : (ps === 'pending' ? 'pending' : 'unpaid')) + '">' + escHtml(ps) + '</span>';
  }
  if (group && group._needsReply) html += '<span class="portal-schedule-pebble needs-reply">' + escHtml(portalT('schedule.drawer.needsReply')) + '</span>';
  var src = scheduleRowSourceKind(group);
  if (src === 'staff' || src === 'luna') html += '<span class="portal-schedule-pebble source-' + escHtml(src) + '">' + escHtml(scheduleRowSourceLabel(group)) + '</span>';
  return html;
}"""

NEW_HELPERS = r"""function scheduleServiceSummaryText(group){
  if (!group) return '';
  var comps = group.components ? Object.keys(group.components) : scheduleRowComponents(group);
  var hasLesson = scheduleGroupHasLesson(group) || comps.indexOf('lesson') >= 0;
  var slot = scheduleNormalizeSlotTime(group.slot_time || '');
  if (hasLesson){
    var surfers = group.quantity || scheduleGroupComponentQty(group, 'lesson') || 1;
    var head = (slot ? slot + ' ' : '') + portalT('schedule.type.lesson').toLowerCase() + ' · ' + surfers + ' ' + portalT('schedule.slot.surfers');
    var gear = [];
    if (scheduleGroupBoardsNeeded(group)) gear.push(portalT('schedule.summary.boardShort'));
    if (scheduleGroupWetsuitsNeeded(group)) gear.push(portalT('schedule.summary.wetsuitShort'));
    return gear.length ? head + ' · ' + gear.join(' + ') : head;
  }
  if (comps.indexOf('surfboard') >= 0 && comps.indexOf('wetsuit') < 0){
    var boards = scheduleGroupBoardsNeeded(group) || 1;
    return portalT('schedule.type.boardRental') + ' · ' + boards + ' ' + portalT('schedule.summary.boards');
  }
  if (comps.indexOf('wetsuit') >= 0 && comps.indexOf('surfboard') < 0){
    var wets = scheduleGroupWetsuitsNeeded(group) || 1;
    return portalT('schedule.type.wetsuitRental') + ' · ' + wets + ' ' + portalT('schedule.summary.wetsuits');
  }
  return portalT('schedule.type.rental');
}

function scheduleRenderStatusBadgeHtml(group){
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
}

function scheduleRenderComponentListHtml(group){
  if (!group) return '';
  var lines = [];
  if (scheduleGroupHasLesson(group)){
    var surfers = group.quantity || scheduleGroupComponentQty(group, 'lesson') || 1;
    var slot = scheduleNormalizeSlotTime(group.slot_time || '') || '—';
    lines.push('<li><span class="portal-schedule-drawer-comp-label">' + escHtml(portalT('schedule.type.lesson')) + ':</span> ' +
      escHtml(String(surfers) + ' ' + portalT('schedule.slot.surfers') + ', ' + slot) + '</li>');
  }
  var boards = scheduleGroupBoardsNeeded(group);
  if (boards) lines.push('<li><span class="portal-schedule-drawer-comp-label">' + escHtml(portalT('schedule.type.boardRental')) + ':</span> ' +
    escHtml(String(boards) + ' ' + portalT('schedule.summary.boards')) + '</li>');
  var wets = scheduleGroupWetsuitsNeeded(group);
  if (wets) lines.push('<li><span class="portal-schedule-drawer-comp-label">' + escHtml(portalT('schedule.type.wetsuitRental')) + ':</span> ' +
    escHtml(String(wets) + ' ' + portalT('schedule.summary.wetsuits')) + '</li>');
  return lines.length ? '<ul class="portal-schedule-drawer-components">' + lines.join('') + '</ul>' : '';
}

function scheduleRenderPebblesHtml(group, opts){
  opts = opts || {};
  if (opts.components) {
    var html = '';
    var comps = group && group.components ? Object.keys(group.components) : scheduleRowComponents(group);
    (comps || []).forEach(function(c){
      html += escHtml(scheduleComponentLabel(c)) + ' ';
    });
    return html.trim();
  }
  return scheduleRenderStatusBadgeHtml(group);
}"""

require(api, OLD_PEBBLES_FN, "scheduleRenderPebblesHtml")
api = api.replace(OLD_PEBBLES_FN, NEW_HELPERS)

OLD_OPS_ROW = """function scheduleRenderOpsBookingRow(group){
  var g = group;
  if (!g) return '';
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var railCls = src === 'staff' ? ' is-staff' : ' is-luna';
  var qty = scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  return '<div class="portal-schedule-ops-row' + (g._needsReply ? ' needs-reply' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty)) + '</span>' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    '<span class="portal-schedule-ops-row-source portal-schedule-pebble source-' + escHtml(src) + '">' + escHtml(scheduleRowSourceLabel(g)) + '</span>' +
    '<span class="portal-schedule-ops-row-pebbles portal-schedule-chip-meta">' + scheduleRenderPebblesHtml(g) + '</span>' +
    '</div>';
}"""

NEW_OPS_ROW = """function scheduleRenderOpsBookingRow(group){
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
    '<span class="portal-schedule-ops-row-status">' + scheduleRenderStatusBadgeHtml(g) + '</span>' +
    '</div>';
}"""

require(api, OLD_OPS_ROW, "scheduleRenderOpsBookingRow")
api = api.replace(OLD_OPS_ROW, NEW_OPS_ROW)

OLD_CHIP = """  return '<div class="portal-schedule-item-card lesson' + extraCls + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<div class="portal-schedule-chip-main"><span class="portal-schedule-chip-qty">' + escHtml(String(qty)) + '</span><span>' + escHtml(label) + '</span></div>' +
    '<div class="portal-schedule-chip-meta">' + scheduleRenderPebblesHtml(g, { payment: false }) + '</div></div>';"""

NEW_CHIP = """  var summary = scheduleServiceSummaryText(g);
  return '<div class="portal-schedule-item-card lesson' + extraCls + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<div class="portal-schedule-chip-main"><span class="portal-schedule-chip-qty">' + escHtml(String(qty)) + '</span><span>' + escHtml(label) + '</span></div>' +
    (summary ? '<div class="portal-schedule-ops-row-summary">' + escHtml(summary) + '</div>' : '') +
    '</div>';"""

require(api, OLD_CHIP, "booking chip")
api = api.replace(OLD_CHIP, NEW_CHIP)

OLD_GEAR_CHIP = """  return '<div class="portal-schedule-item-card rental' + extraCls + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<div class="portal-schedule-chip-main"><span class="portal-schedule-chip-qty">' + escHtml(String(qty)) + '</span><span>' + escHtml(g.guest_name || 'Guest') + '</span></div>' +
    '<div class="portal-schedule-chip-meta">' + scheduleRenderPebblesHtml(g, { payment: false }) + '</div></div>';"""

NEW_GEAR_CHIP = """  var summary = scheduleServiceSummaryText(g);
  return '<div class="portal-schedule-item-card rental' + extraCls + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '">' +
    '<div class="portal-schedule-chip-main"><span class="portal-schedule-chip-qty">' + escHtml(String(qty)) + '</span><span>' + escHtml(g.guest_name || 'Guest') + '</span></div>' +
    (summary ? '<div class="portal-schedule-ops-row-summary">' + escHtml(summary) + '</div>' : '') +
    '</div>';"""

require(api, OLD_GEAR_CHIP, "gear chip")
api = api.replace(OLD_GEAR_CHIP, NEW_GEAR_CHIP)

OLD_LIST_CELL = "      '<td><div class=\"portal-schedule-chip-meta\">' + scheduleRenderPebblesHtml(group || r) + '</div></td>' +"
NEW_LIST_CELL = "      '<td><span class=\"portal-schedule-ops-row-summary\">' + escHtml(scheduleServiceSummaryText(group || r)) + '</span></td>' +"
if OLD_LIST_CELL in api:
    api = api.replace(OLD_LIST_CELL, NEW_LIST_CELL)

OLD_DRAWER = """  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<div class="portal-schedule-pebble source-' + escHtml(src) + '" style="margin-bottom:8px">' + escHtml(srcLabel) + '</div>' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
    '<p class="portal-schedule-card-sub" style="margin:0">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(row.booking_code || '—') + '</p>' +
    '</div>' +
    '<div class="portal-schedule-drawer-qty">' + escHtml(String(qty)) + '</div>' +
    '<p class="portal-schedule-card-sub" style="margin:4px 0 14px">' + escHtml(portalT('schedule.create.surferCount')) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.date')) + ':</strong> ' + escHtml(String(row.service_date || '—').slice(0, 10)) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.time')) + ':</strong> ' + escHtml(slot) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.components')) + ':</strong> ' + escHtml(compText || '—') + '</p>' +
    '<div class="portal-schedule-chip-meta" style="margin:8px 0 12px">' + scheduleRenderPebblesHtml(group) + '</div>' +
    '<div class="portal-schedule-drawer-prep">' +
    '<span><strong>' + escHtml(portalT('schedule.type.boardRental')) + ':</strong> ' + escHtml(String(boards)) + '</span>' +
    '<span><strong>' + escHtml(portalT('schedule.type.wetsuitRental')) + ':</strong> ' + escHtml(String(wetsuits)) + '</span>' +
    '</div>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.payment')) + ':</strong> ' + escHtml(row.payment_status || '—') + '</p>' +"""

NEW_DRAWER = """  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<div class="portal-schedule-drawer-source is-' + escHtml(src) + '">' + escHtml(srcLabel) + '</div>' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
    '<p class="portal-schedule-card-sub" style="margin:0">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(row.booking_code || '—') + '</p>' +
    '</div>' +
    scheduleRenderComponentListHtml(group) +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.date')) + ':</strong> ' + escHtml(String(row.service_date || '—').slice(0, 10)) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.payment')) + ':</strong> ' + scheduleRenderStatusBadgeHtml(group) + '</p>' +"""

require(api, OLD_DRAWER, "drawer body")
api = api.replace(OLD_DRAWER, NEW_DRAWER)

# remove unused drawer vars if still referenced — compText/boards/wetsuits/slot/qty may warn but JS allows
api = api.replace("  var compText = comps.map(scheduleComponentLabel).join(', ');\n", "")
api = api.replace("  var boards = scheduleGroupBoardsNeeded(group);\n  var wetsuits = scheduleGroupWetsuitsNeeded(group);\n", "")
api = api.replace("  var slot = scheduleNormalizeSlotTime(group.slot_time || row.slot_time || row.service_time || '—') || '—';\n", "")

API.write_text(api, encoding="utf-8")
print("patched staff-query-api.js")

# ── i18n ─────────────────────────────────────────────────────────────────────

i18n = I18N.read_text(encoding="utf-8")
I18N_KEYS = """
    'schedule.summary.boardShort': 'board',
    'schedule.summary.wetsuitShort': 'wetsuit',
    'schedule.summary.boards': 'boards',
    'schedule.summary.wetsuits': 'wetsuits',
    'schedule.status.paid': 'Paid',
    'schedule.status.pending': 'Pending payment',
    'schedule.status.unpaid': 'Unpaid',
"""
if "'schedule.summary.boardShort'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.source.luna': 'Luna',",
        "    'schedule.source.luna': 'Luna',\n" + I18N_KEYS,
    )
    I18N.write_text(i18n, encoding="utf-8")
    print("patched i18n")

# ── verify section 19 ────────────────────────────────────────────────────────

v1 = V1.read_text(encoding="utf-8")
if "[19]" not in v1:
    section19 = """

// ── 19. Sunset Schedule visual refine — muted ops board ─────────────────────

console.log('\\n[19] Sunset Schedule visual refine — muted ops board');

if (apiSrc) {
  assert('service summary helper', apiSrc.includes('function scheduleServiceSummaryText('));
  assert('status badge helper', apiSrc.includes('function scheduleRenderStatusBadgeHtml('));
  assert('drawer component list helper', apiSrc.includes('function scheduleRenderComponentListHtml('));
  assert('ops row summary markup', apiSrc.includes('portal-schedule-ops-row-summary'));
  assert('ops row status markup', apiSrc.includes('portal-schedule-ops-row-status'));
  assert('drawer component list markup', apiSrc.includes('portal-schedule-drawer-components'));
  assert('no component pebbles in ops rows', !apiSrc.includes('portal-schedule-ops-row-pebbles'));
  assert('no source pebble in ops rows', !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('component pebble css removed from rows', !apiSrc.includes('.portal-schedule-pebble.lesson{background:#fde68a'));
  assert('muted source rail colors', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a'));
  assert('booking create still persists', apiSrc.includes('/staff/schedule/bookings') && apiSrc.includes('submitScheduleManualBooking'));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('no stripe wired in drawer', apiSrc.includes("portalT('schedule.drawer.stripeSoon')"));
}
"""
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        section19 + "\nconsole.log('\\n' + '─'.repeat(48));",
    )
    # strengthen section 18
    v1 = v1.replace(
        "  assert('booking source helpers', apiSrc.includes('function scheduleRowSourceKind(') && apiSrc.includes('function scheduleRenderPebblesHtml('));",
        "  assert('booking source helpers', apiSrc.includes('function scheduleRowSourceKind(') && apiSrc.includes('function scheduleServiceSummaryText('));",
    )
    V1.write_text(v1, encoding="utf-8")
    print("patched verify-sunset-portal-v1.js")

print("done")
