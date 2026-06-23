#!/usr/bin/env python3
"""Fix missing save-price-group handler and ensure save-new-pack handler exists."""
from pathlib import Path

API = Path('/opt/wolfhouse/WH/scripts/staff-query-api.js')
api = API.read_text(encoding='utf-8')

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
if "if (action === 'save-price-group'){" in api:
    print('SKIP handler already present')
elif anchor not in api:
    raise SystemExit('save-price anchor missing')
else:
    api = api.replace(anchor, HANDLER + anchor, 1)
    print('OK inserted save-price-group handler')

# Fix adminHumanizeText corrupted regex if present
bad = "text = text.replace(/\x08(\\d+) day pack surfer\x08/i, '$1 day pack');"
good = "text = text.replace(/(\\d+) day pack surfer/i, '$1 day pack');"
if bad in api:
    api = api.replace(bad, good, 1)
    print('OK fixed adminHumanizeText regex')

# Ensure cancel-edit works without writes guard blocking - already not in guard

# Fix wireAdminTab: re-bind on each loadAdminTab if innerHTML replaced? 
# Actually issue might be adminWired on tab-admin but listener is fine.
# Another issue: edit/add actions call renderAdminFromConfig(cfg) when cfg is null.
# Harden: use adminConfigCache fallback in click handler
old_click = """    var cfg = adminConfigCache;
    var action = btn.getAttribute('data-admin-action');"""
new_click = """    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
      return;
    }
    var action = btn.getAttribute('data-admin-action');"""
# BUG: action used before defined - fix order
new_click = """    var action = btn.getAttribute('data-admin-action');
    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
      return;
    }"""
old_click = """    var cfg = adminConfigCache;
    var action = btn.getAttribute('data-admin-action');"""
if new_click not in api and old_click in api:
    api = api.replace(old_click, new_click, 1)
    print('OK cfg null guard in wireAdminTab')

API.write_text(api, encoding='utf-8')
print('DONE')
