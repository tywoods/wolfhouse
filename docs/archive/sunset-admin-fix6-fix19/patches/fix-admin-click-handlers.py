#!/usr/bin/env python3
"""Fix admin click handlers: save-price-group, cross-section edit locks."""
from pathlib import Path

API = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
api = API.read_text(encoding='utf-8')

# --- save-price-group handler (was never inserted due to bad patch guard) ---
HANDLER = """    if (action === 'save-price-group'){
      var saveGroup = String(btn.getAttribute('data-price-group') || '');
      var grid = el('admin-prices-card-grid-' + saveGroup);
      if (!grid){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var cards = grid.querySelectorAll('[data-admin-price-card]');
      var jobs = [];
      var validationError = '';
      cards.forEach(function(card){
        var pid = card.getAttribute('data-admin-price-card');
        if (!pid) return;
        var periodInput = el('admin-price-period-' + pid);
        var amountInput = el('admin-price-amount-' + pid);
        var period = periodInput ? String(periodInput.value || '').trim() : '';
        if (!period){ validationError = portalT('admin.edit.periodRequired'); return; }
        var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
        if (!centsParsed.ok){ validationError = centsParsed.error; return; }
        jobs.push(adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(pid) + adminClientQuery(), {
          period_window: period,
          amount_cents: centsParsed.value,
        }));
      });
      if (validationError){ adminShowMessage('error', validationError); return; }
      if (!jobs.length){ adminShowMessage('error', portalT('admin.prices.emptyCategory')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      Promise.all(jobs).then(function(results){
        adminSaveBusy = false;
        var failed = results.find(function(res){ return res.status !== 200 || !res.data || res.data.success !== true; });
        if (failed){
          adminShowMessage('error', (failed.data && (failed.data.message || failed.data.error)) || ('HTTP ' + failed.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedPrice'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }

"""
anchor = "    if (action === 'save-price'){"
if "if (action === 'save-price-group'){" not in api:
    if anchor not in api:
        raise SystemExit('save-price anchor missing')
    api = api.replace(anchor, HANDLER + anchor, 1)
    print('OK save-price-group handler')

# --- helper: section-scoped edit busy checks ---
helper = """
function adminEditScope(target){
  var t = String(target || '');
  if (!t) return '';
  if (t.indexOf('price-group:') === 0 || t.indexOf('price-add:') === 0) return 'price';
  if (t.indexOf('time:') === 0 || t === 'time:new') return 'time';
  if (t.indexOf('pack:') === 0 || t === 'pack:new') return 'pack';
  if (t === 'capacity') return 'capacity';
  return 'other';
}
function adminEditBusyExcept(scope){
  if (!adminEditTarget) return false;
  return adminEditScope(adminEditTarget) !== scope;
}
"""
if 'function adminEditScope' not in api:
    api = api.replace('var adminEditTarget = null;', 'var adminEditTarget = null;' + helper, 1)
    print('OK adminEditScope helpers')

# --- rental section: use scope-aware busy ---
api = api.replace(
    "      var busyOther = adminEditTarget && !groupEditing && !adding;",
    "      var busyOther = adminEditBusyExcept('price') && !groupEditing && !adding;",
)

# --- lessons: scope-aware + and card actions ---
api = api.replace(
    "  if (writes && !adminEditTarget){\n    html += '<div class=\"portal-admin-card-actions\"><button type=\"button\" class=\"btn btn-ghost portal-admin-row-edit portal-admin-icon-btn\" data-admin-action=\"add-time\"",
    "  if (writes && !adminEditBusyExcept('time')){\n    html += '<div class=\"portal-admin-card-actions\"><button type=\"button\" class=\"btn btn-ghost portal-admin-row-edit portal-admin-icon-btn\" data-admin-action=\"add-time\"",
)
api = api.replace(
    "    if (writes && !editing && (!adminEditTarget || (adminEditTarget.indexOf('time:') !== 0 && adminEditTarget.indexOf('pack:') !== 0 && adminEditTarget !== 'pack:new'))){",
    "    if (writes && !editing && !adminEditBusyExcept('time')){",
)

# --- packs: scope-aware + ---
api = api.replace(
    "  if (writes && !adminEditTarget){\n    html += '<div class=\"portal-admin-card-actions\"><button type=\"button\" class=\"btn btn-ghost portal-admin-row-edit portal-admin-icon-btn\" data-admin-action=\"add-pack\"",
    "  if (writes && !adminEditBusyExcept('pack')){\n    html += '<div class=\"portal-admin-card-actions\"><button type=\"button\" class=\"btn btn-ghost portal-admin-row-edit portal-admin-icon-btn\" data-admin-action=\"add-pack\"",
)
api = api.replace(
    "    if (writes && !editing && (!adminEditTarget || adminEditTarget.indexOf('pack:') !== 0)){",
    "    if (writes && !editing && !adminEditBusyExcept('pack')){",
)

# --- wireAdminTab: action before cfg, null cfg guard ---
old = """    var cfg = adminConfigCache;
    var action = btn.getAttribute('data-admin-action');"""
new = """    var action = btn.getAttribute('data-admin-action');
    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
      return;
    }"""
if old in api:
    api = api.replace(old, new, 1)
    print('OK wireAdminTab cfg guard')

# --- stop click default on admin buttons (form submit edge case) ---
if "ev.preventDefault()" not in api.split('function wireAdminTab')[1].split('var customersCache')[0]:
    api = api.replace(
        "    if (!btn || adminSaveBusy) return;",
        "    if (!btn || adminSaveBusy) return;\n    ev.preventDefault();",
        1,
    )
    print('OK preventDefault on admin clicks')

API.write_text(api, encoding='utf-8')
print('DONE')
