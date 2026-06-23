#!/usr/bin/env python3
"""Patch Sunset Admin config read model + GET /staff/admin/config + Admin UI fetch."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
I18N = ROOT / 'scripts/lib/staff-portal-i18n.js'
V1 = ROOT / 'scripts/verify-sunset-portal-v1.js'
PKG = ROOT / 'package.json'

# ── 1. staff-query-api.js: require ───────────────────────────────────────────
api = API.read_text(encoding='utf-8')
needle_req = "} = require('./lib/staff-portal-clients');"
insert_req = "} = require('./lib/staff-portal-clients');\nconst { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');"
if "tenant-business-config" not in api:
    if needle_req not in api:
        raise SystemExit('require anchor not found')
    api = api.replace(needle_req, insert_req, 1)
    print('OK require tenant-business-config')

# ── 2. handleAdminConfig handler (before handleCustomerList) ─────────────────
handler = '''
async function handleAdminConfig(query, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  const resolved = resolveTenantBusinessConfig(clientSlug);
  if (!resolved.ok) {
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config',
      category: 'admin_api',
      client_slug: clientSlug,
      success: false,
      reason: resolved.reason,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    if (resolved.reason === 'unsupported_client') {
      return sendJSON(res, 403, { success: false, error: 'unsupported_client', client_slug: clientSlug });
    }
    return sendJSON(res, 404, { success: false, error: resolved.reason || 'not_found' });
  }

  const elapsed = Date.now() - started;
  appendAuditLog({
    ts: new Date().toISOString(),
    intent: 'api:admin.config',
    category: 'admin_api',
    client_slug: clientSlug,
    success: true,
    read_only: true,
    source: resolved.source,
    price_count: (resolved.prices || []).length,
    staff_user_id: user ? user.staff_user_id : null,
    elapsed_ms: elapsed,
  });

  const { ok, ...payload } = resolved;
  return sendJSON(res, 200, {
    success: true,
    ...payload,
    elapsed_ms: elapsed,
  });
}

'''
anchor_handler = 'async function handleCustomerList(query, res, user) {'
if 'function handleAdminConfig(' not in api:
    if anchor_handler not in api:
        raise SystemExit('handleCustomerList anchor not found')
    api = api.replace(anchor_handler, handler + anchor_handler, 1)
    print('OK handleAdminConfig')

# ── 3. Router: GET /staff/admin/config before /staff/customers ───────────────
route = '''  if (pathname === '/staff/admin/config') {
    const auth = await requireAuth(req, res, 'viewer');
    if (!auth.ok) return;
    return handleAdminConfig(parsed.query, res, auth.user);
  }

'''
anchor_route = "  if (pathname === '/staff/customers') {"
if "/staff/admin/config" not in api:
    if anchor_route not in api:
        raise SystemExit('customers route anchor not found')
    api = api.replace(anchor_route, route + anchor_route, 1)
    print('OK route /staff/admin/config')

# ── 4. Admin HTML: add fetch state ───────────────────────────────────────────
html_old = '''    <div class="portal-admin-banner">
      <strong data-i18n="admin.banner.readOnly">Read-only preview</strong> —'''
html_new = '''    <div id="admin-fetch-state" class="state-msg" style="display:none;margin-bottom:12px"></div>
    <div class="portal-admin-banner">
      <strong data-i18n="admin.banner.readOnly">Read-only preview</strong> —'''
if 'id="admin-fetch-state"' not in api:
    if html_old not in api:
        raise SystemExit('admin banner anchor not found')
    api = api.replace(html_old, html_new, 1)
    print('OK admin-fetch-state markup')

# ── 5. Replace Admin render/load functions ───────────────────────────────────
old_block_start = 'function renderAdminSectionPrices(){'
old_block_end = 'function wireAdminTab(){ /* read-only — no interactive wiring yet */ }'
idx_start = api.find(old_block_start)
idx_end = api.find(old_block_end)
if idx_start == -1 or idx_end == -1:
    raise SystemExit('admin render block not found')
if 'renderAdminFromConfig' not in api:
    new_block = r'''var adminConfigCache = null;

function renderAdminSectionPricesFromConfig(cfg){
  var box = el('admin-prices-body');
  if (!box) return;
  var prices = (cfg && cfg.prices) ? cfg.prices : [];
  if (!prices.length){
    box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.notConfigured')) + '</p>' +
      '<p style="margin-top:8px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.prices.futureNote')) + '</p>';
    return;
  }
  var html = '<table class="portal-admin-table"><thead><tr><th>' + escHtml(portalT('admin.prices.col.category')) +
    '</th><th>' + escHtml(portalT('admin.prices.col.offering')) + '</th><th>' + escHtml(portalT('admin.prices.col.unit')) +
    '</th><th>' + escHtml(portalT('admin.prices.col.amount')) + '</th><th>' + escHtml(portalT('admin.prices.col.status')) +
    '</th></tr></thead><tbody>';
  prices.forEach(function(p){
    html += '<tr><td>' + escHtml(p.category || '—') + '</td><td>' + escHtml(p.label || p.offering_key || '—') + '</td><td>' +
      escHtml(p.unit || '—') + '</td><td>' + escHtml(String(p.amount) + ' ' + (p.currency || 'EUR')) + '</td><td>' +
      escHtml(p.effective_state || p.pricing_status || '—') + '</td></tr>';
  });
  html += '</tbody></table>';
  html += '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.prices.configNote')) +
    ' (' + escHtml((cfg && cfg.source) ? cfg.source : 'config') + ')</p>';
  box.innerHTML = html;
}

function renderAdminSectionCapacityFromConfig(cfg){
  var box = el('admin-capacity-body');
  if (!box) return;
  var cap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  box.innerHTML = '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.capacity.dailyDefault')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(String(cap) + ' ' + portalT('admin.capacity.seatsPerDay')) + '</span></div>' +
    '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.capacity.futureNote')) + '</p>';
}

function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
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

function renderAdminSectionBusinessInfoFromConfig(cfg){
  var box = el('admin-business-body');
  if (!box) return;
  var info = (cfg && cfg.business_info) ? cfg.business_info : {};
  var stagingLabel = info.staging ? portalT('admin.business.stagingYes') : portalT('admin.business.stagingNo');
  box.innerHTML = '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.schoolName')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(info.name || portalT('demoHome.schoolName')) + '</span></div>' +
    '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.timezone')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(info.timezone || '—') + '</span></div>' +
    '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.source')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(info.config_source || (cfg && cfg.source) || '—') + '</span></div>' +
    '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.business.staging')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(stagingLabel) + '</span></div>' +
    '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.business.futureNote')) + '</p>';
}

function renderAdminSectionChangeHistoryFromConfig(cfg){
  var box = el('admin-history-body');
  if (!box) return;
  var rows = (cfg && cfg.change_history) ? cfg.change_history : [];
  if (!rows.length){
    box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.history.empty')) + '</p>';
    return;
  }
  box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.history.empty')) + '</p>';
}

function renderAdminFromConfig(cfg){
  renderAdminSectionPricesFromConfig(cfg);
  renderAdminSectionCapacityFromConfig(cfg);
  renderAdminSectionLessonTimesFromConfig(cfg);
  renderAdminSectionBusinessInfoFromConfig(cfg);
  renderAdminSectionChangeHistoryFromConfig(cfg);
}

function renderAdminFallback(profile){
  renderAdminSectionCapacityFromConfig({ lesson_capacity: { default_daily_cap: SUNSET_SCHEDULE_LESSON_DAY_CAP } });
  renderAdminSectionLessonTimesFromConfig({ lesson_times: (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [] });
  renderAdminSectionPricesFromConfig(null);
  renderAdminSectionBusinessInfoFromConfig(null);
  renderAdminSectionChangeHistoryFromConfig(null);
}

function loadAdminTab(){
  var profile = getPortalProfile(getClient());
  if (!profile.is_surf_vertical) return;
  var state = el('admin-fetch-state');
  if (state){ state.textContent = portalT('admin.loading'); state.style.display = 'block'; state.classList.remove('error'); }
  var url = '/staff/admin/config?client=' + encodeURIComponent(getClient());
  fetch(url).then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data){
      if (!data || data.success !== true) return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
      adminConfigCache = data;
      renderAdminFromConfig(data);
      if (state) state.style.display = 'none';
    })
    .catch(function(e){
      adminConfigCache = null;
      renderAdminFallback(profile);
      if (state){
        state.textContent = portalT('admin.error') + ' ' + e.message;
        state.className = 'state-msg error';
        state.style.display = 'block';
      }
    });
}

function wireAdminTab(){ /* read-only — no interactive wiring yet */ }
'''
    api = api[:idx_start] + new_block + api[idx_end + len(old_block_end):]
    print('OK admin render + loadAdminTab fetch')

API.write_text(api, encoding='utf-8')

# ── 6. i18n keys ─────────────────────────────────────────────────────────────
i18n = I18N.read_text(encoding='utf-8')
new_keys = """
    'admin.loading': 'Loading admin settings…',
    'admin.error': 'Could not load admin settings.',
    'admin.prices.col.category': 'Category',
    'admin.prices.col.offering': 'Offering',
    'admin.prices.col.unit': 'Unit',
    'admin.prices.col.amount': 'Amount',
    'admin.prices.col.status': 'Status',
    'admin.prices.configNote': 'Prices loaded from tenant config (read-only). Owner verification required before live quotes.',
    'admin.business.timezone': 'Timezone',
    'admin.business.source': 'Config source',
    'admin.business.staging': 'Staging / demo',
    'admin.business.stagingYes': 'Yes — demo or deployment not live',
    'admin.business.stagingNo': 'No',
"""
if "'admin.loading'" not in i18n:
    anchor = "'admin.action.editComingSoon': 'Edit — Coming soon',"
    if anchor not in i18n:
        raise SystemExit('i18n anchor not found')
    i18n = i18n.replace(anchor, anchor + new_keys, 1)
    I18N.write_text(i18n, encoding='utf-8')
    print('OK i18n keys')

# ── 7. verify-sunset-portal-v1 section 12 ────────────────────────────────────
v1 = V1.read_text(encoding='utf-8')
section12 = '''
// ── 12. Sunset Admin config API (read-only read model) ───────────────────────

console.log('\\n[12] Sunset Admin config API — read-only read model');

if (apiSrc) {
  assert('GET /staff/admin/config route', apiSrc.includes("pathname === '/staff/admin/config'"));
  assert('handleAdminConfig handler', apiSrc.includes('function handleAdminConfig('));
  assert('tenant-business-config import', apiSrc.includes("require('./lib/tenant-business-config')"));
  assert('Admin config read_only in audit', apiSrc.includes("intent: 'api:admin.config'") && apiSrc.includes('read_only: true'));
  assert('loadAdminTab fetches admin config', apiSrc.includes('/staff/admin/config?client='));
  assert('Admin fetch error fallback', apiSrc.includes('renderAdminFallback'));
  assert('unsupported_client 403 path', apiSrc.includes("'unsupported_client'"));
}

try {
  const tbc = require('./lib/tenant-business-config');
  assert('DEFAULT_DAILY_CAP export 24', tbc.DEFAULT_DAILY_CAP === 24);
  const sample = tbc.resolveTenantBusinessConfig('sunset');
  assert('resolver sunset read_only', sample.ok === true && sample.read_only === true);
  assert('resolver sunset cap 24', sample.lesson_capacity.default_daily_cap === 24);
  const wh = tbc.resolveTenantBusinessConfig('wolfhouse-somo');
  assert('resolver blocks wolfhouse', wh.ok === false && wh.reason === 'unsupported_client');
} catch (err) {
  assert('tenant-business-config module loads', false, err.message);
}

'''
if '[12] Sunset Admin config API' not in v1:
    anchor_v1 = "// ── Session-scoped client dropdown (Sunset-only staff) ─────────────────────"
    if anchor_v1 not in v1:
        raise SystemExit('v1 session anchor not found')
    v1 = v1.replace(anchor_v1, section12 + '\n' + anchor_v1, 1)
    V1.write_text(v1, encoding='utf-8')
    print('OK verify-sunset-portal-v1 section 12')

# ── 8. package.json script ───────────────────────────────────────────────────
pkg = PKG.read_text(encoding='utf-8')
if 'verify:tenant-business-config' not in pkg:
    pkg = pkg.replace(
        '"verify:sunset-portal-v1": "node scripts/verify-sunset-portal-v1.js",',
        '"verify:sunset-portal-v1": "node scripts/verify-sunset-portal-v1.js",\n    "verify:tenant-business-config": "node scripts/verify-tenant-business-config.js",',
        1,
    )
    PKG.write_text(pkg, encoding='utf-8')
    print('OK package.json script')

print('PATCH COMPLETE')
