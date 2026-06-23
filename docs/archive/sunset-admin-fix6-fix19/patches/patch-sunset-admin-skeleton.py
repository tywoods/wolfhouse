#!/usr/bin/env python3
"""Sunset Admin tab — read-only skeleton (Slice B)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts' / 'staff-query-api.js'
I18N = ROOT / 'scripts' / 'lib' / 'staff-portal-i18n.js'
VPTI = ROOT / 'scripts' / 'verify-portal-tenant-isolation.js'
V1 = ROOT / 'scripts' / 'verify-sunset-portal-v1.js'
SPEC = ROOT / 'docs' / 'sunset' / 'SUNSET-ADMIN-CONFIG-SPEC.md'

ADMIN_CSS = """
.portal-admin-wrap{max-width:1100px;margin:0 auto;padding:24px 20px 32px}
.portal-admin-header{margin-bottom:18px}
.portal-admin-header h2{font-size:20px;font-weight:800;color:var(--text);margin:0 0 8px}
.portal-admin-banner{background:var(--surface-soft);border:1px solid var(--border-soft);border-radius:var(--radius);padding:12px 16px;margin-bottom:18px;font-size:13px;color:var(--text-2);line-height:1.5}
.portal-admin-banner strong{color:var(--text)}
.portal-admin-sections{display:grid;grid-template-columns:1fr;gap:14px}
.portal-admin-section{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-soft)}
.portal-admin-section-hdr{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);margin-bottom:10px}
.portal-admin-section-body{font-size:13px;color:var(--text);line-height:1.55}
.portal-admin-kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--border-soft)}
.portal-admin-kv:first-child{border-top:none;padding-top:0}
.portal-admin-kv-label{color:var(--text-2);font-weight:600}
.portal-admin-kv-value{text-align:right;color:var(--text)}
.portal-admin-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.portal-admin-table th,.portal-admin-table td{padding:6px 8px;border-bottom:1px solid var(--border-soft);text-align:left}
.portal-admin-table th{font-weight:700;color:var(--text-2);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.portal-admin-muted{color:var(--text-3);font-style:italic}
.portal-admin-actions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}
.portal-admin-btn[disabled]{opacity:.55;cursor:not-allowed}
#tab-admin.active{display:block}
"""

ADMIN_TAB_BTN = (
    '  <button class="tab-btn" data-tab="customers" data-i18n="nav.tab.customers" '
    'style="display:none">Customers</button>\n'
    '  <button class="tab-btn" data-tab="admin" data-i18n="nav.tab.admin" style="display:none">Admin</button>'
)

ADMIN_PANEL = '''<!-- ── Admin tab (Sunset read-only skeleton) ─────────────────────────────── -->
<div id="tab-admin" class="tab-panel">
<div class="portal-admin-wrap">
  <header class="portal-admin-header">
    <h2 data-i18n="admin.title">Admin</h2>
    <div class="portal-admin-banner">
      <strong data-i18n="admin.banner.readOnly">Read-only preview</strong> —
      <span data-i18n="admin.banner.writesDisabled">Admin writes are not enabled yet.</span>
      <span data-i18n="admin.banner.lunaNote"> These settings will eventually control what Luna quotes and offers.</span>
    </div>
  </header>
  <div class="portal-admin-sections">
    <section class="portal-admin-section" id="admin-sec-prices">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.prices">Prices</div>
      <div class="portal-admin-section-body" id="admin-prices-body"></div>
    </section>
    <section class="portal-admin-section" id="admin-sec-capacity">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.capacity">Lesson capacity</div>
      <div class="portal-admin-section-body" id="admin-capacity-body"></div>
    </section>
    <section class="portal-admin-section" id="admin-sec-times">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.lessonTimes">Lesson times</div>
      <div class="portal-admin-section-body" id="admin-times-body"></div>
    </section>
    <section class="portal-admin-section" id="admin-sec-business">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.businessInfo">Business info</div>
      <div class="portal-admin-section-body" id="admin-business-body"></div>
    </section>
    <section class="portal-admin-section" id="admin-sec-history">
      <div class="portal-admin-section-hdr" data-i18n="admin.section.changeHistory">Change history</div>
      <div class="portal-admin-section-body" id="admin-history-body"></div>
    </section>
  </div>
  <div class="portal-admin-actions">
    <button type="button" class="btn btn-primary portal-admin-btn" disabled data-i18n="admin.action.saveComingSoon">Save — Coming soon</button>
    <button type="button" class="btn btn-ghost portal-admin-btn" disabled data-i18n="admin.action.editComingSoon">Edit — Coming soon</button>
  </div>
</div>
</div><!-- /tab-admin -->

'''

ADMIN_JS = '''
function renderAdminSectionPrices(){
  var box = el('admin-prices-body');
  if (!box) return;
  box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.notConfigured')) + '</p>' +
    '<p style="margin-top:8px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.prices.futureNote')) + '</p>';
}

function renderAdminSectionCapacity(){
  var box = el('admin-capacity-body');
  if (!box) return;
  var cap = SUNSET_SCHEDULE_LESSON_DAY_CAP;
  box.innerHTML = '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.capacity.dailyDefault')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(String(cap) + ' ' + portalT('admin.capacity.seatsPerDay')) + '</span></div>' +
    '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.capacity.futureNote')) + '</p>';
}

function renderAdminSectionLessonTimes(profile){
  var box = el('admin-times-body');
  if (!box) return;
  var slots = (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [];
  if (!slots.length){
    box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.placeholder')) + '</p>';
    return;
  }
  var html = '<table class="portal-admin-table"><thead><tr><th>' + escHtml(portalT('admin.lessonTimes.col.date')) +
    '</th><th>' + escHtml(portalT('admin.lessonTimes.col.time')) + '</th><th>' + escHtml(portalT('admin.lessonTimes.col.label')) +
    '</th><th>' + escHtml(portalT('admin.lessonTimes.col.capacity')) + '</th></tr></thead><tbody>';
  slots.forEach(function(s){
    html += '<tr><td>' + escHtml(s.date || '—') + '</td><td>' + escHtml(s.slot_time || '—') + '</td><td>' +
      escHtml(s.offering_label || s.session_type || 'Lesson') + '</td><td>' +
      escHtml(s.capacity != null ? String(s.capacity) : '—') + '</td></tr>';
  });
  html += '</tbody></table>';
  box.innerHTML = html;
}

function renderAdminSectionBusinessInfo(){
  var box = el('admin-business-body');
  if (!box) return;
  box.innerHTML = '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.schoolName')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(portalT('demoHome.schoolName')) + '</span></div>' +
    '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.brand')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(portalT('demoHome.brand')) + '</span></div>' +
    '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.business.futureNote')) + '</p>';
}

function renderAdminSectionChangeHistory(){
  var box = el('admin-history-body');
  if (!box) return;
  box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.history.empty')) + '</p>';
}

function loadAdminTab(){
  var profile = getPortalProfile(getClient());
  if (!profile.is_surf_vertical) return;
  renderAdminSectionPrices();
  renderAdminSectionCapacity();
  renderAdminSectionLessonTimes(profile);
  renderAdminSectionBusinessInfo();
  renderAdminSectionChangeHistory();
}

function wireAdminTab(){ /* read-only — no interactive wiring yet */ }
'''

I18N_KEYS = """
    'nav.tab.admin': 'Admin',
    'admin.title': 'Admin',
    'admin.banner.readOnly': 'Read-only preview',
    'admin.banner.writesDisabled': 'Admin writes are not enabled yet.',
    'admin.banner.lunaNote': 'These settings will eventually control what Luna quotes and offers.',
    'admin.section.prices': 'Prices',
    'admin.section.capacity': 'Lesson capacity',
    'admin.section.lessonTimes': 'Lesson times',
    'admin.section.businessInfo': 'Business info',
    'admin.section.changeHistory': 'Change history',
    'admin.prices.notConfigured': 'Not configured yet',
    'admin.prices.futureNote': 'Price rules will be stored in tenant_price_rules when admin writes are enabled.',
    'admin.capacity.dailyDefault': 'Default daily lesson capacity',
    'admin.capacity.seatsPerDay': 'seats/day',
    'admin.capacity.futureNote': 'Per-slot overrides will use tenant_lesson_capacity_rules.',
    'admin.lessonTimes.placeholder': 'No lesson times configured yet.',
    'admin.lessonTimes.col.date': 'Date',
    'admin.lessonTimes.col.time': 'Time',
    'admin.lessonTimes.col.label': 'Offering',
    'admin.lessonTimes.col.capacity': 'Capacity',
    'admin.business.schoolName': 'School name',
    'admin.business.brand': 'Brand',
    'admin.business.futureNote': 'Contact and policy fields will appear here when business info is editable.',
    'admin.history.empty': 'No admin changes yet.',
    'admin.action.saveComingSoon': 'Save — Coming soon',
    'admin.action.editComingSoon': 'Edit — Coming soon',
"""

V1_ADMIN_SECTION = '''

// ── 11. Sunset Admin tab (read-only skeleton) ────────────────────────────────

console.log('\\n[11] Sunset Admin tab — read-only skeleton');

if (apiSrc) {
  assert('Admin tab button present', apiSrc.includes('data-tab="admin"'));
  assert('Admin tab panel present', apiSrc.includes('id="tab-admin"'));
  assert('admin tab surf-gated', apiSrc.includes("tab === 'admin' && !profile.is_surf_vertical"));
  assert('loadAdminTab helper present', apiSrc.includes('function loadAdminTab('));
  assert('Admin prices section', apiSrc.includes('admin.section.prices') || apiSrc.includes('admin-sec-prices'));
  assert('Admin capacity section', apiSrc.includes('admin.section.capacity') || apiSrc.includes('admin-sec-capacity'));
  assert('Admin lesson times section', apiSrc.includes('admin.section.lessonTimes') || apiSrc.includes('admin-sec-times'));
  assert('Admin business info section', apiSrc.includes('admin.section.businessInfo') || apiSrc.includes('admin-sec-business'));
  assert('Admin change history section', apiSrc.includes('admin.section.changeHistory') || apiSrc.includes('admin-sec-history'));
  assert('Admin read-only banner', apiSrc.includes('admin.banner.readOnly'));
  assert('Admin writes disabled copy', apiSrc.includes('admin.banner.writesDisabled'));
  assert('Admin save button disabled coming soon', apiSrc.includes('admin.action.saveComingSoon') && apiSrc.includes('disabled'));
  assert('Wolfhouse bed-calendar preserved', apiSrc.includes('data-tab="bed-calendar"'));
}

if (i18nSrc) {
  assert('nav.tab.admin i18n key', i18nSrc.includes("'nav.tab.admin': 'Admin'"));
  assert('admin.section.prices i18n', i18nSrc.includes("'admin.section.prices'"));
}
'''


def patch_api(src: str) -> str:
    if 'id="tab-admin"' in src:
        print('staff-query-api.js already has Admin tab')
        return src

    anchor_css = '#tab-portal-home.active{display:block}'
    if anchor_css in src and 'portal-admin-wrap' not in src:
        src = src.replace(anchor_css, anchor_css + ADMIN_CSS)

    old_btn = (
        '  <button class="tab-btn" data-tab="customers" data-i18n="nav.tab.customers" '
        'style="display:none">Customers</button>'
    )
    if old_btn not in src:
        raise SystemExit('customers tab button anchor missing')
    src = src.replace(old_btn, ADMIN_TAB_BTN)

    marker = '</div><!-- /tab-customers -->'
    if marker not in src:
        raise SystemExit('tab-customers end marker missing')
    src = src.replace(marker, marker + '\n\n' + ADMIN_PANEL)

    hidden_old = "  if (tab === 'customers' && !profile.is_surf_vertical) return true;\n  if (tab === 'day-schedule' && !profile.is_surf_vertical) return true;"
    hidden_new = hidden_old.replace(
        "  if (tab === 'customers' && !profile.is_surf_vertical) return true;",
        "  if (tab === 'customers' && !profile.is_surf_vertical) return true;\n  if (tab === 'admin' && !profile.is_surf_vertical) return true;",
    )
    if hidden_old not in src:
        raise SystemExit('isTabHiddenForClient anchor missing')
    src = src.replace(hidden_old, hidden_new)

    apply_old = """    if (tab === 'customers') {
      btn.style.display = profile.is_surf_vertical ? '' : 'none';
      return;
    }"""
    apply_new = apply_old + """
    if (tab === 'admin') {
      btn.style.display = profile.is_surf_vertical ? '' : 'none';
      return;
    }"""
    if apply_old not in src:
        raise SystemExit('applyClientPortalProfile customers anchor missing')
    src = src.replace(apply_old, apply_new)

    switch_old = "  if (tab === 'customers') loadCustomersTab();\n  if (tab === 'day-schedule') loadDaySchedule();"
    switch_new = switch_old.replace(
        "  if (tab === 'customers') loadCustomersTab();",
        "  if (tab === 'customers') loadCustomersTab();\n  if (tab === 'admin') loadAdminTab();",
    )
    if switch_old not in src:
        raise SystemExit('switchToTab customers anchor missing')
    src = src.replace(switch_old, switch_new)

    click_old = "    if (target === 'customers') loadCustomersTab();\n    if (target === 'day-schedule') loadDaySchedule();"
    click_new = click_old.replace(
        "    if (target === 'customers') loadCustomersTab();",
        "    if (target === 'customers') loadCustomersTab();\n    if (target === 'admin') loadAdminTab();",
    )
    if click_old not in src:
        raise SystemExit('tab click customers anchor missing')
    src = src.replace(click_old, click_new)

    js_anchor = 'var customersCache = [];'
    if js_anchor not in src:
        raise SystemExit('customersCache anchor missing')
    src = src.replace(js_anchor, ADMIN_JS + '\n' + js_anchor)

    return src


def patch_i18n(src: str) -> str:
    if "'nav.tab.admin'" in src.split('module.exports = {', 1)[0]:
        print('admin i18n keys already present')
        return src
    anchor = "    'schedule.drawer.readOnly': 'Read-only detail — no edits from this panel.',"
    if anchor not in src:
        raise SystemExit('schedule i18n anchor missing')
    src = src.replace(anchor, anchor + I18N_KEYS)
    return src


def patch_vpti(src: str) -> str:
    if "nav includes Admin tab" in src:
        print('vpti already has Admin assertions')
        return src

    wh_old = "  assert('Wolfhouse excludes portal-schedule-wrap', !whScheduleUi.scheduleWrap);"
    wh_new = wh_old + """
  const whAdminUi = await page.evaluate(() => ({
    adminTab: !!document.querySelector('.tab-btn[data-tab="admin"]') &&
      window.getComputedStyle(document.querySelector('.tab-btn[data-tab="admin"]')).display !== 'none',
    adminPanel: !!document.getElementById('tab-admin'),
  }));
  assert('Wolfhouse excludes Admin tab visible', !whAdminUi.adminTab);
  assert('Wolfhouse excludes Admin panel', !whAdminUi.adminPanel);"""
    if wh_old in src and 'Wolfhouse excludes Admin tab visible' not in src:
        src = src.replace(wh_old, wh_new)

    ss_old = "  assert('nav includes Customers', tabLabelsInclude(state, ['Customers']));"
    ss_new = ss_old + "\n  assert('nav includes Admin tab', hasExactTabLabel(state, 'Admin'));"
    if ss_old in src:
        src = src.replace(ss_old, ss_new)

    wh_exclude = "  assert('nav excludes Today tab label', !hasExactTabLabel(state, 'Today'));\n  assert('nav excludes Customers', tabLabelsExclude(state, ['Customers']));"
    wh_exclude_new = wh_exclude.replace(
        "  assert('nav excludes Customers', tabLabelsExclude(state, ['Customers']));",
        "  assert('nav excludes Admin tab label', !hasExactTabLabel(state, 'Admin'));\n  assert('nav excludes Customers', tabLabelsExclude(state, ['Customers']));",
    )
    if wh_exclude in src and 'nav excludes Admin tab label' not in src.split('[Sunset]', 1)[0]:
        src = src.replace(wh_exclude, wh_exclude_new, 1)

    return src


def patch_v1(src: str) -> str:
    if '[11] Sunset Admin tab' in src:
        return src
    marker = '\n// ── Session-scoped client dropdown (Sunset-only staff) ─────────────────────'
    if marker in src:
        src = src.replace(marker, V1_ADMIN_SECTION + marker)
    return src


def main() -> int:
    for path in (API, I18N, VPTI, V1):
        if not path.is_file():
            print(f'missing {path}', file=sys.stderr)
            return 1

    api = patch_api(API.read_text(encoding='utf-8'))
    API.write_text(api, encoding='utf-8')
    print('OK staff-query-api.js')

    i18n = patch_i18n(I18N.read_text(encoding='utf-8'))
    I18N.write_text(i18n, encoding='utf-8')
    print('OK staff-portal-i18n.js')

    vpti = patch_vpti(VPTI.read_text(encoding='utf-8'))
    VPTI.write_text(vpti, encoding='utf-8')
    print('OK verify-portal-tenant-isolation.js')

    v1 = patch_v1(V1.read_text(encoding='utf-8'))
    V1.write_text(v1, encoding='utf-8')
    print('OK verify-sunset-portal-v1.js')

    if not SPEC.is_file():
        print(f'missing {SPEC} — copy spec doc first', file=sys.stderr)
        return 1
    print('OK docs/sunset/SUNSET-ADMIN-CONFIG-SPEC.md')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
