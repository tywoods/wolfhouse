#!/usr/bin/env python3
"""Sunset Schedule source styling, rental pickup grouping, remove row source tags."""
from pathlib import Path

ROOT = Path("/opt/wolfhouse/WH")
API = ROOT / "scripts/staff-query-api.js"
I18N = ROOT / "scripts/lib/staff-portal-i18n.js"
V1 = ROOT / "scripts/verify-sunset-portal-v1.js"


def require(text, needle, label):
    if needle not in text:
        raise SystemExit(f"MISSING {label}: {needle[:120]}...")


api = API.read_text(encoding="utf-8")

# ── CSS: source row glow + compact qty ───────────────────────────────────────

OLD_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 40px minmax(120px,1.5fr) minmax(96px,1fr) 72px;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
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
.portal-schedule-ops-row-equip{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-2);line-height:1.3}"""

NEW_ROW_CSS = """.portal-schedule-ops-row{display:grid;grid-template-columns:4px 36px minmax(0,1fr) 72px;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:background .12s}
@media(max-width:720px){.portal-schedule-ops-col-hdr,.portal-schedule-ops-row{grid-template-columns:4px 32px 1fr 72px}.portal-schedule-ops-row-status{grid-column:4;grid-row:1}.portal-schedule-ops-row-guest-col{grid-column:3;grid-row:1}}
.portal-schedule-ops-row:last-child{border-bottom:none}
.portal-schedule-ops-row:hover{background:rgba(255,255,255,.04)}
.portal-schedule-ops-row.is-staff{background:linear-gradient(90deg,rgba(111,167,131,.14),transparent 42%)}
.portal-schedule-ops-row.is-luna{background:linear-gradient(90deg,rgba(111,147,184,.14),transparent 42%)}
.portal-schedule-ops-row-rail{width:4px;align-self:stretch;border-radius:999px;background:var(--border-soft);flex-shrink:0}
.portal-schedule-ops-row-rail.is-staff{background:#6fa783}
.portal-schedule-ops-row-rail.is-luna{background:#6f93b8}
.portal-schedule-ops-row-qty{display:inline-flex;align-items:center;justify-content:flex-start;min-width:28px;font-size:12px;font-weight:700;color:var(--text-3);letter-spacing:.02em;background:transparent;border:none;padding:0}
.portal-schedule-ops-row-guest-col{display:flex;flex-direction:column;gap:2px;min-width:0}
.portal-schedule-ops-row-guest{font-size:14px;font-weight:700;color:var(--text);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.portal-schedule-ops-row-equip-sub{font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:lowercase;color:var(--text-3);line-height:1.3}"""

require(api, OLD_ROW_CSS, "ops row css")
api = api.replace(OLD_ROW_CSS, NEW_ROW_CSS)

OLD_COL_HDR = """.portal-schedule-ops-col-hdr{display:grid;grid-template-columns:4px 40px minmax(120px,1.5fr) minmax(96px,1fr) 72px;gap:10px;padding:6px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);border-bottom:1px solid var(--border-soft);background:var(--surface-soft)}"""

NEW_COL_HDR = """.portal-schedule-ops-col-hdr{display:grid;grid-template-columns:4px 36px minmax(0,1fr) 72px;gap:10px;padding:6px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);border-bottom:1px solid var(--border-soft);background:var(--surface-soft)}"""

require(api, OLD_COL_HDR, "col hdr css")
api = api.replace(OLD_COL_HDR, NEW_COL_HDR)

OLD_PICKUP_EMPTY = """.portal-schedule-ops-rental-pickups-subhdr{padding:10px 16px 6px;font-size:13px;font-weight:700;color:var(--text-2)}"""

NEW_PICKUP_EMPTY = """.portal-schedule-ops-rental-pickups-subhdr{padding:10px 16px 6px;font-size:13px;font-weight:700;color:var(--text-2)}
.portal-schedule-ops-rental-pickups-empty{padding:4px 16px 10px;font-size:12px;color:var(--text-3);font-style:italic}"""

api = api.replace(OLD_PICKUP_EMPTY, NEW_PICKUP_EMPTY)

# ── JS helpers: aria label + rental kind + drawer label ──────────────────────

INSERT_AFTER = "function scheduleRowSourceLabel(row){"

NEW_HELPERS = """function scheduleRowSourceAriaLabel(row){
  var kind = scheduleRowSourceKind(row);
  if (kind === 'staff') return portalT('schedule.source.ariaStaff');
  if (kind === 'demo') return portalT('schedule.source.ariaDemo');
  return portalT('schedule.source.ariaLuna');
}

function scheduleRowSourceDrawerLabel(row){
  var kind = scheduleRowSourceKind(row);
  if (kind === 'staff') return portalT('schedule.source.staff');
  if (kind === 'demo') return portalT('schedule.source.demo');
  return portalT('schedule.source.luna');
}

function scheduleRentalPickupKind(group){
  if (!group) return null;
  var hasBoard = !!(group.components && group.components.surfboard) || scheduleGroupBoardsNeeded(group) > 0;
  var hasWets = !!(group.components && group.components.wetsuit) || scheduleGroupWetsuitsNeeded(group) > 0;
  if (hasBoard && hasWets) return 'both';
  if (hasBoard) return 'board';
  if (hasWets) return 'wetsuit';
  return null;
}

function scheduleRenderRentalPickupBlock(groups, titleKey, emptyKey){
  var total = (groups || []).reduce(function(a, g){
    return a + (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || g.quantity || 1);
  }, 0);
  var html = '<div class="portal-schedule-ops-rental-pickups-block">' +
    '<div class="portal-schedule-ops-rental-pickups-subhdr">' + escHtml(portalT(titleKey) + ' — ' + String((groups || []).length)) + '</div>';
  if (groups && groups.length){
    html += scheduleRenderOpsColumnHeader();
    groups.forEach(function(g){ html += scheduleRenderOpsBookingRow(g); });
  } else {
    html += '<div class="portal-schedule-ops-rental-pickups-empty">' + escHtml(portalT(emptyKey)) + '</div>';
  }
  return html + '</div>';
}

"""

require(api, INSERT_AFTER, "insert point for helpers")
api = api.replace(INSERT_AFTER, NEW_HELPERS + INSERT_AFTER)

# ── Ops row: no visible source tag, qty×, equip subline, row source class ───

OLD_ROW_FN = """function scheduleRenderOpsBookingRow(group){
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

NEW_ROW_FN = """function scheduleRenderOpsBookingRow(group){
  var g = group;
  if (!g) return '';
  scheduleEnsureRowId(g);
  var src = scheduleRowSourceKind(g);
  var rowSrcCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var railCls = src === 'staff' ? ' is-staff' : (src === 'luna' || src === 'demo' ? ' is-luna' : '');
  var ariaLabel = scheduleRowSourceAriaLabel(g);
  var qty = scheduleGroupHasLesson(g)
    ? (g.quantity || scheduleGroupComponentQty(g, 'lesson') || 1)
    : (scheduleGroupBoardsNeeded(g) || scheduleGroupWetsuitsNeeded(g) || 1);
  var equip = scheduleEquipmentPrepLabel(g);
  return '<div class="portal-schedule-ops-row' + rowSrcCls + (g._needsReply ? ' needs-reply' : '') + '" data-ps-booking-id="' + escHtml(g._scheduleId) + '" title="' + escHtml(ariaLabel) + '" aria-label="' + escHtml(ariaLabel) + '">' +
    '<span class="portal-schedule-ops-row-rail' + railCls + '" aria-hidden="true"></span>' +
    '<span class="portal-schedule-ops-row-qty">' + escHtml(String(qty) + '\u00d7') + '</span>' +
    '<div class="portal-schedule-ops-row-guest-col">' +
    '<span class="portal-schedule-ops-row-guest">' + escHtml(g.guest_name || 'Guest') + '</span>' +
    (equip ? '<span class="portal-schedule-ops-row-equip-sub">' + escHtml(equip) + '</span>' : '') +
    '</div>' +
    '<span class="portal-schedule-ops-row-status">' + scheduleRenderRowStatusHtml(g) + '</span>' +
    '</div>';
}"""

require(api, OLD_ROW_FN, "ops row fn")
api = api.replace(OLD_ROW_FN, NEW_ROW_FN)

# ── Column header: drop equipment column ─────────────────────────────────────

OLD_COL_HDR_FN = """function scheduleRenderOpsColumnHeader(){
  return '<div class="portal-schedule-ops-col-hdr">' +
    '<span></span><span>' + escHtml(portalT('schedule.col.qty')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.guest')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.equipment')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.status')) + '</span></div>';
}"""

NEW_COL_HDR_FN = """function scheduleRenderOpsColumnHeader(){
  return '<div class="portal-schedule-ops-col-hdr">' +
    '<span></span><span></span>' +
    '<span>' + escHtml(portalT('schedule.col.guest')) + '</span>' +
    '<span>' + escHtml(portalT('schedule.col.status')) + '</span></div>';
}"""

require(api, OLD_COL_HDR_FN, "col hdr fn")
api = api.replace(OLD_COL_HDR_FN, NEW_COL_HDR_FN)

# ── Rental pickups: both / board only / wetsuit only ────────────────────────

OLD_RENTAL = """  var gearGroups = scheduleBuildDisplayGroups(pack.gear || []).filter(scheduleGroupHasOnlyGear);
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

NEW_RENTAL = """  var gearGroups = scheduleBuildDisplayGroups(pack.gear || []).filter(scheduleGroupHasOnlyGear);
  var bothRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'both'; });
  var boardOnlyRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'board'; });
  var wetsuitOnlyRentals = gearGroups.filter(function(g){ return scheduleRentalPickupKind(g) === 'wetsuit'; });
  if (gearGroups.length){
    html += '<section class="portal-schedule-ops-rental-pickups">' +
      '<header class="portal-schedule-ops-rental-pickups-hdr">' + escHtml(portalT('schedule.ops.rentalPickupsToday')) + '</header>' +
      scheduleRenderRentalPickupBlock(bothRentals, 'schedule.ops.rentalBoth', 'schedule.ops.rentalNothingScheduled') +
      scheduleRenderRentalPickupBlock(boardOnlyRentals, 'schedule.ops.rentalBoardsOnly', 'schedule.ops.rentalNothingScheduled') +
      scheduleRenderRentalPickupBlock(wetsuitOnlyRentals, 'schedule.ops.rentalWetsuitsOnly', 'schedule.ops.rentalNothingScheduled') +
      '</section>';
  }"""

require(api, OLD_RENTAL, "rental section")
api = api.replace(OLD_RENTAL, NEW_RENTAL)

# ── Drawer: plain Source metadata, no pill ───────────────────────────────────

OLD_DRAWER_HERO = """  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<div class="portal-schedule-drawer-source is-' + escHtml(src) + '">' + escHtml(srcLabel) + '</div>' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
    '<p class="portal-schedule-card-sub" style="margin:0">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(row.booking_code || '—') + '</p>' +
    '</div>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.equipment')) + ':</strong> ' + escHtml(scheduleEquipmentPrepLabel(group)) + '</p>' +"""

NEW_DRAWER_HERO = """  body.innerHTML =
    '<div class="portal-schedule-drawer-hero">' +
    '<h3 style="margin:0 0 4px;font-size:22px">' + escHtml(group.guest_name || row.guest_name || 'Guest') + '</h3>' +
    '<p class="portal-schedule-card-sub" style="margin:0">' + escHtml(portalT('schedule.drawer.bookingCode')) + ': ' + escHtml(row.booking_code || '—') + '</p>' +
    '</div>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.drawer.source')) + ':</strong> ' + escHtml(scheduleRowSourceDrawerLabel(group)) + '</p>' +
    '<p class="portal-schedule-drawer-kv"><strong>' + escHtml(portalT('schedule.col.equipment')) + ':</strong> ' + escHtml(scheduleEquipmentPrepLabel(group)) + '</p>' +"""

require(api, OLD_DRAWER_HERO, "drawer hero")
api = api.replace(OLD_DRAWER_HERO, NEW_DRAWER_HERO)

# remove unused drawer vars if present
api = api.replace("  var srcLabel = scheduleRowSourceLabel(group);\n", "")

API.write_text(api, encoding="utf-8")
print("patched staff-query-api.js")

# ── i18n ─────────────────────────────────────────────────────────────────────

i18n = I18N.read_text(encoding="utf-8")

if "'schedule.ops.rentalBoth'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.ops.rentalPickupsToday': 'Rental pickups today',",
        "    'schedule.ops.rentalPickupsToday': 'Rental pickups today',\n"
        "    'schedule.ops.rentalBoth': 'Surfboard + wetsuit',\n"
        "    'schedule.ops.rentalBoardsOnly': 'Surfboards only',\n"
        "    'schedule.ops.rentalWetsuitsOnly': 'Wetsuits only',\n"
        "    'schedule.ops.rentalNothingScheduled': 'Nothing scheduled',",
    )

if "'schedule.source.ariaStaff'" not in i18n:
    i18n = i18n.replace(
        "    'schedule.source.staff': 'Staff',",
        "    'schedule.source.staff': 'Staff',\n"
        "    'schedule.source.demo': 'Demo',\n"
        "    'schedule.source.ariaStaff': 'Staff booking',\n"
        "    'schedule.source.ariaLuna': 'Luna booking',\n"
        "    'schedule.source.ariaDemo': 'Demo booking',",
    )

i18n = i18n.replace("    'schedule.view.month': 'Month',", "    'schedule.view.month': 'Next 30 days',")

I18N.write_text(i18n, encoding="utf-8")
print("patched i18n")

# ── verify ───────────────────────────────────────────────────────────────────

v1 = V1.read_text(encoding="utf-8")

v1 = v1.replace(
    "  assert('source shown as row subline not pebble', apiSrc.includes('portal-schedule-ops-row-source') && !apiSrc.includes('portal-schedule-ops-row-source portal-schedule-pebble'));",
    "  assert('no visible source tag in ops rows', !apiSrc.includes('portal-schedule-ops-row-source'));",
)

v1 = v1.replace(
    "  assert('muted source rail colors', apiSrc.includes('.portal-schedule-ops-row-rail.is-staff{background:#7d9b8a'));",
    "  assert('source row glow classes', apiSrc.includes('.portal-schedule-ops-row.is-staff{background:linear-gradient') && apiSrc.includes('.portal-schedule-ops-row.is-luna{background:linear-gradient'));",
)

v1 = v1.replace(
    "  assert('rental pickups section', apiSrc.includes('portal-schedule-ops-rental-pickups') && apiSrc.includes(\"portalT('schedule.ops.surfboardsNeeded')\"));",
    "  assert('rental pickups section', apiSrc.includes('portal-schedule-ops-rental-pickups') && apiSrc.includes('scheduleRenderRentalPickupBlock('));",
)

if "[22]" not in v1:
    section22 = """

// ── 22. Sunset Schedule source styling + rental pickup grouping ─────────────

console.log('\\n[22] Sunset Schedule source styling + rental pickup grouping');

if (apiSrc) {
  assert('no Staff-created row tag markup', !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('no demo badge in ops row renderer', !apiSrc.includes("scheduleRowSourceLabel(g)") || !apiSrc.includes('portal-schedule-ops-row-source'));
  assert('source aria label helper', apiSrc.includes('function scheduleRowSourceAriaLabel('));
  assert('row source class is-staff', apiSrc.includes(\"' is-staff'\") && apiSrc.includes('.portal-schedule-ops-row.is-staff'));
  assert('row source class is-luna', apiSrc.includes('.portal-schedule-ops-row.is-luna'));
  assert('compact qty multiplier', apiSrc.includes(\"String(qty) + '\u00d7'\") || apiSrc.includes('String(qty) + \\'\\u00d7\\''));
  assert('rental both section key', apiSrc.includes(\"portalT('schedule.ops.rentalBoth')\") || (i18nSrc && i18nSrc.includes(\"'schedule.ops.rentalBoth'\")));
  assert('rental boards only section key', i18nSrc.includes(\"'schedule.ops.rentalBoardsOnly'\") || apiSrc.includes(\"'schedule.ops.rentalBoardsOnly'\"));
  assert('rental wetsuits only section key', i18nSrc.includes(\"'schedule.ops.rentalWetsuitsOnly'\") || apiSrc.includes(\"'schedule.ops.rentalWetsuitsOnly'\"));
  assert('rental pickup kind helper', apiSrc.includes('function scheduleRentalPickupKind('));
  assert('drawer plain source kv', apiSrc.includes('scheduleRowSourceDrawerLabel(group)') && apiSrc.includes(\"portalT('schedule.drawer.source')\"));
  assert('next30 view button i18n', i18nSrc.includes(\"'schedule.view.next30': 'Next 30 days'\") || apiSrc.includes('schedule.view.next30'));
  assert('month label not Month', !i18nSrc.includes(\"'schedule.view.month': 'Month'\"));
  assert('drawer still opens', apiSrc.includes('function openScheduleDetailDrawer('));
  assert('create booking still works', apiSrc.includes('submitScheduleManualBooking'));
}
"""
    v1 = v1.replace(
        "console.log('\\n' + '─'.repeat(48));",
        section22 + "\nconsole.log('\\n' + '─'.repeat(48));",
    )

V1.write_text(v1, encoding="utf-8")
print("patched verify-sunset-portal-v1.js")
print("done")
