#!/usr/bin/env python3
"""School-aware Sunset Admin config — API + UI wiring."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
VERIFY = ROOT / 'scripts/verify-sunset-portal-v1.js'

api = API.read_text()

# ── setSunsetLocation: reload Admin tab on school switch ─────────────────────
old_set_loc = """  if (getPortalProfile(getClient()).is_surf_vertical) {
    if (el('tab-portal-home') && el('tab-portal-home').classList.contains('active')) loadSchedulePage();
    if (el('tab-customers') && el('tab-customers').classList.contains('active')) loadCustomersTab();
  }
}"""
new_set_loc = """  if (getPortalProfile(getClient()).is_surf_vertical) {
    if (el('tab-portal-home') && el('tab-portal-home').classList.contains('active')) loadSchedulePage();
    if (el('tab-customers') && el('tab-customers').classList.contains('active')) loadCustomersTab();
    if (el('tab-admin') && el('tab-admin').classList.contains('active')) loadAdminTab();
  }
}"""
if old_set_loc not in api:
    raise SystemExit('setSunsetLocation block not found')
api = api.replace(old_set_loc, new_set_loc, 1)

# ── adminClientQuery: append active school location ───────────────────────────
old_admin_q = """function adminClientQuery(){
  return '?client=' + encodeURIComponent(getClient());
}"""
new_admin_q = """function adminClientQuery(){
  var q = '?client=' + encodeURIComponent(getClient());
  if (getClient() === 'sunset'){
    q += '&location=' + encodeURIComponent(getSunsetLocation());
  }
  return q;
}"""
if old_admin_q not in api:
    raise SystemExit('adminClientQuery not found')
api = api.replace(old_admin_q, new_admin_q, 1)

# ── Admin header: school context banner ───────────────────────────────────────
old_admin_hdr = """    <div class="portal-admin-banner" id="admin-write-banner">
      <strong data-i18n="admin.banner.readOnly">Read-only preview</strong> —
      <span data-i18n="admin.banner.writesDisabled">Admin writes are not enabled yet.</span>
      <span data-i18n="admin.banner.lunaNote"> These settings will eventually control what Luna quotes and offers.</span>
    </div>
  </header>"""
new_admin_hdr = """    <div class="portal-admin-school-context" id="admin-school-context" style="display:none;margin-bottom:10px;font-size:13px;color:var(--text-2)">
      <strong data-i18n="admin.school.active">Config for</strong>
      <span id="admin-school-label">—</span>
      <span class="portal-admin-muted" data-i18n="admin.school.switchHint"> (use header school switcher)</span>
    </div>
    <div class="portal-admin-banner" id="admin-write-banner">
      <strong data-i18n="admin.banner.readOnly">Read-only preview</strong> —
      <span data-i18n="admin.banner.writesDisabled">Admin writes are not enabled yet.</span>
      <span data-i18n="admin.banner.lunaNote"> These settings will eventually control what Luna quotes and offers.</span>
    </div>
  </header>"""
if old_admin_hdr not in api:
    raise SystemExit('admin header not found')
api = api.replace(old_admin_hdr, new_admin_hdr, 1)

# ── renderAdminSchoolContext + wire into renderAdminFromConfig ────────────────
if 'function renderAdminSchoolContext(' not in api:
    insert_before = 'function renderAdminFromConfig(cfg){'
    school_fn = """function renderAdminSchoolContext(cfg){
  var wrap = el('admin-school-context');
  var label = el('admin-school-label');
  if (!wrap || !label) return;
  if (getClient() !== 'sunset'){
    wrap.style.display = 'none';
    return;
  }
  var loc = (cfg && cfg.location_id) ? cfg.location_id : getSunsetLocation();
  var text = (cfg && cfg.location_label) ? cfg.location_label : (loc === 'sunset-sardinero' ? 'El Sardi' : 'Sunset');
  label.textContent = text;
  wrap.style.display = 'block';
}

"""
    if insert_before not in api:
        raise SystemExit('renderAdminFromConfig anchor missing')
    api = api.replace(insert_before, school_fn + insert_before, 1)

old_render = """function renderAdminFromConfig(cfg){
  renderAdminWriteState(cfg);
  renderAdminSectionPricesFromConfig(cfg);"""
new_render = """function renderAdminFromConfig(cfg){
  renderAdminSchoolContext(cfg);
  renderAdminWriteState(cfg);
  renderAdminSectionPricesFromConfig(cfg);"""
if old_render not in api:
    raise SystemExit('renderAdminFromConfig body not found')
api = api.replace(old_render, new_render, 1)

# ── loadAdminTab fetch URL uses adminClientQuery ──────────────────────────────
old_load_url = "  var url = '/staff/admin/config?client=' + encodeURIComponent(getClient());"
new_load_url = "  var url = '/staff/admin/config' + adminClientQuery();"
if old_load_url not in api:
    raise SystemExit('loadAdminTab url not found')
api = api.replace(old_load_url, new_load_url, 1)

# ── i18n keys for admin school context ────────────────────────────────────────
for old_i18n, new_i18n in [
    ("'admin.banner.lunaNote': ' These settings will eventually control what Luna quotes and offers.',",
     "'admin.banner.lunaNote': ' These settings will eventually control what Luna quotes and offers.',\n    'admin.school.active': 'Config for',\n    'admin.school.switchHint': ' (use header school switcher)',"),
]:
    if old_i18n in api and new_i18n.split('\n')[1] not in api:
        api = api.replace(old_i18n, new_i18n, 1)

# ── handleAdminConfig: location param ─────────────────────────────────────────
old_handle = """  const resolved = isSunsetAdminDbReadEnabled()
    ? await resolveTenantBusinessConfigAsync(clientSlug)
    : resolveTenantBusinessConfig(clientSlug);"""
new_handle = """  const locationId = normalizeSunsetLocationId(query.location);
  const resolved = isSunsetAdminDbReadEnabled()
    ? await resolveTenantBusinessConfigAsync(clientSlug, { locationId })
    : resolveTenantBusinessConfig(clientSlug, locationId);"""
if old_handle not in api:
    raise SystemExit('handleAdminConfig resolver block not found')
api = api.replace(old_handle, new_handle, 1)

# audit log location
old_audit = """    source: resolved.source,
    price_count: (resolved.prices || []).length,"""
new_audit = """    source: resolved.source,
    location_id: locationId,
    price_count: (resolved.prices || []).length,"""
if old_audit in api and 'location_id: locationId' not in api.split('handleAdminConfig')[1][:800]:
    api = api.replace(old_audit, new_audit, 1)

# ── write handlers: pass locationId ───────────────────────────────────────────
for old, new in [
    ("""    const result = await withPgClient(async (pg) => patchPriceRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));""",
     """    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => patchPriceRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      locationId,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));"""),
    ("""    const result = await withPgClient(async (pg) => putLessonCapacityDefault(pg, {
      clientSlug,
      capacity: validated.patch.default_daily_cap,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));""",
     """    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => putLessonCapacityDefault(pg, {
      clientSlug,
      locationId,
      capacity: validated.patch.default_daily_cap,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));"""),
    ("""    const result = await withPgClient(async (pg) => patchLessonTimeRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));""",
     """    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => patchLessonTimeRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      locationId,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));"""),
]:
    if old not in api:
        raise SystemExit(f'write handler block missing: {old[:60]}')
    api = api.replace(old, new, 1)

# ── drawer/stripe: pass booking location to admin config resolver ─────────────
for old, new in [
    ("const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg });",
     "const adminCfg = await resolveTenantBusinessConfigAsync(clientSlug, { pgClient: pg, locationId: normalizeSunsetLocationId(locationId) });"),
]:
    pass  # only in lib files

API.write_text(api)
print('OK staff-query-api.js')

# ── Verifier section [29] ─────────────────────────────────────────────────────
verify = VERIFY.read_text()

section = """
console.log('\\n[29] Sunset school-aware Admin config');
{
  const apiSrc = readText('scripts/staff-query-api.js');
  const tbcSrc = readText('scripts/lib/tenant-business-config.js');
  const tawSrc = readText('scripts/lib/tenant-admin-writes.js');
  const storeSrc = readText('scripts/lib/sunset-admin-location-store.js');
  assert('location store module present', fs.existsSync(path.join(ROOT, 'scripts/lib/sunset-admin-location-store.js')));
  assert('admin fetch includes location param', apiSrc.includes("adminClientQuery()") && apiSrc.includes('&location=') && apiSrc.includes('getSunsetLocation()'));
  assert('loadAdminTab uses adminClientQuery', apiSrc.includes("'/staff/admin/config' + adminClientQuery()"));
  assert('handleAdminConfig resolves by location', apiSrc.includes('normalizeSunsetLocationId(query.location)') && apiSrc.includes('resolveTenantBusinessConfig(clientSlug, locationId)'));
  assert('admin writes pass locationId', tawSrc.includes('locationId') && apiSrc.includes('locationId,') && apiSrc.includes('putLessonCapacityDefault(pg, {'));
  assert('location store isolates schools', storeSrc.includes('applyStoreToResolvedConfig') && storeSrc.includes('normalizeSunsetLocationId(locationId)'));
  assert('default admin location is sunset-somo', storeSrc.includes('DEFAULT_SUNSET_LOCATION_ID') && tbcSrc.includes('normalizeSunsetLocationId'));
  assert('school switch reloads admin tab', apiSrc.includes("el('tab-admin')") && apiSrc.includes('loadAdminTab()'));
  assert('admin school context UI', apiSrc.includes('renderAdminSchoolContext') && apiSrc.includes('admin-school-label'));
  assert('wolfhouse admin resolver unchanged gate', tbcSrc.includes("slug !== SUNSET_ADMIN_CLIENT") && (function(){
    const wh = require('./lib/tenant-business-config').resolveTenantBusinessConfig('wolfhouse-somo');
    return wh && wh.ok === false && wh.reason === 'unsupported_client';
  })());
  assert('proposed migration 023 documented', fs.existsSync(path.join(ROOT, 'database/migrations/023_sunset_admin_location_id_PROPOSED.sql')));
}
"""

if '[29] Sunset school-aware Admin config' not in verify:
    anchor = "console.log('\\n[28] Staff API JS syntax (node --check)');"
    if anchor not in verify:
        raise SystemExit('verifier section 28 anchor missing')
    verify = verify.replace(anchor, section + anchor, 1)

# update syntax check list for new module
if 'sunset-admin-location-store.js syntax' not in verify:
    verify = verify.replace(
        "  runNodeSyntaxCheck('scripts/lib/sunset-customer-profile-writes.js');",
        "  runNodeSyntaxCheck('scripts/lib/sunset-customer-profile-writes.js');\n"
        "  runNodeSyntaxCheck('scripts/lib/sunset-admin-location-store.js');",
        1,
    )

VERIFY.write_text(verify)
print('OK verify-sunset-portal-v1.js')
