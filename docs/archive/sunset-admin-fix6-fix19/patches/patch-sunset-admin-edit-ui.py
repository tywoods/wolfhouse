#!/usr/bin/env python3
"""Patch Sunset Admin edit UI (writes_enabled gated)."""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
I18N = ROOT / 'scripts/lib/staff-portal-i18n.js'
V1 = ROOT / 'scripts/verify-sunset-portal-v1.js'

ADMIN_ACTIONS_OLD = """  <div class="portal-admin-actions">
    <button type="button" class="btn btn-primary portal-admin-btn" disabled data-i18n="admin.action.saveComingSoon">Save — Coming soon</button>
    <button type="button" class="btn btn-ghost portal-admin-btn" disabled data-i18n="admin.action.editComingSoon">Edit — Coming soon</button>
  </div>"""

ADMIN_ACTIONS_NEW = """  <div id="admin-save-msg" class="state-msg portal-admin-save-msg" style="display:none;margin-top:12px" aria-live="polite"></div>"""

CSS_ANCHOR = '.portal-admin-btn[disabled]{opacity:.55;cursor:not-allowed}'
CSS_EXTRA = """
.portal-admin-save-msg{margin-top:12px}
.portal-admin-edit-form{margin-top:10px;padding:12px;border:1px solid var(--border-soft);border-radius:var(--radius);background:var(--surface-soft)}
.portal-admin-edit-field{margin-bottom:8px}
.portal-admin-edit-field label{display:block;font-size:11px;font-weight:700;color:var(--text-2);margin-bottom:4px}
.portal-admin-edit-field input{width:100%;max-width:240px;padding:6px 8px;border:1px solid var(--border-soft);border-radius:6px;font-size:13px}
.portal-admin-edit-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.portal-admin-row-edit{font-size:11px;padding:4px 10px}
.portal-admin-history-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.portal-admin-history-table th,.portal-admin-history-table td{padding:6px 8px;border-bottom:1px solid var(--border-soft);text-align:left}
.portal-admin-history-table th{font-weight:700;color:var(--text-2);font-size:11px;text-transform:uppercase}"""

ADMIN_JS_OLD_START = 'var adminConfigCache = null;'
ADMIN_JS_OLD_END = "function wireAdminTab(){ /* read-only — no interactive wiring yet */ }"

ADMIN_JS_NEW = r'''var adminConfigCache = null;
var adminEditTarget = null;
var adminSaveBusy = false;

function adminCfgWritesEnabled(cfg){
  return !!(cfg && cfg.writes_enabled === true);
}

function adminClientQuery(){
  return '?client=' + encodeURIComponent(getClient());
}

function adminShowMessage(kind, text){
  var box = el('admin-save-msg');
  if (!box) return;
  if (!text){
    box.style.display = 'none';
    box.textContent = '';
    box.className = 'state-msg portal-admin-save-msg';
    return;
  }
  box.className = 'state-msg portal-admin-save-msg ' + (kind === 'error' ? 'error' : 'success');
  box.textContent = text;
  box.style.display = 'block';
}

function adminEurosFromAmount(amount){
  var n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}

function adminParseEurosToCents(text){
  var normalized = String(text || '').trim().replace(',', '.');
  if (!normalized) return { ok: false, error: portalT('admin.edit.amountRequired') };
  var n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: portalT('admin.edit.amountInvalid') };
  return { ok: true, value: Math.round(n * 100) };
}

function adminParseCapacity(text){
  var n = parseInt(String(text || '').trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 999) return { ok: false, error: portalT('admin.edit.capacityInvalid') };
  return { ok: true, value: n };
}

function adminParseTimeHm(text){
  var t = String(text || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return { ok: false, error: portalT('admin.edit.timeInvalid') };
  return { ok: true, value: t };
}

function adminSlotTimeStart(slotTime){
  var raw = String(slotTime || '').trim();
  if (!raw) return '';
  return raw.split('-')[0].trim();
}

function adminApiRequest(method, path, body){
  var opts = { method: method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (body != null){
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(data){
      return { status: r.status, data: data };
    });
  });
}

function adminReloadConfig(){
  adminEditTarget = null;
  adminSaveBusy = false;
  loadAdminTab();
}

function renderAdminSectionPricesFromConfig(cfg){
  var box = el('admin-prices-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var prices = (cfg && cfg.prices) ? cfg.prices : [];
  if (!prices.length){
    box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.notConfigured')) + '</p>' +
      '<p style="margin-top:8px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.prices.futureNote')) + '</p>';
    return;
  }
  var html = '<table class="portal-admin-table"><thead><tr><th>' + escHtml(portalT('admin.prices.col.category')) +
    '</th><th>' + escHtml(portalT('admin.prices.col.offering')) + '</th><th>' + escHtml(portalT('admin.prices.col.unit')) +
    '</th><th>' + escHtml(portalT('admin.prices.col.amount')) + '</th><th>' + escHtml(portalT('admin.prices.col.status')) +
    '</th>' + (writes ? '<th>' + escHtml(portalT('admin.edit.col.actions')) + '</th>' : '') +
    '</tr></thead><tbody>';
  prices.forEach(function(p){
    var pid = p.id ? String(p.id) : '';
    var editing = writes && adminEditTarget === ('price:' + pid);
    html += '<tr><td>' + escHtml(p.category || '—') + '</td><td>' + escHtml(p.label || p.offering_key || '—') + '</td><td>' +
      escHtml(p.unit || '—') + '</td><td>' + escHtml(String(p.amount) + ' ' + (p.currency || 'EUR')) + '</td><td>' +
      escHtml(p.effective_state || p.pricing_status || '—') + '</td>';
    if (writes){
      if (editing){
        html += '<td><span class="portal-admin-muted">' + escHtml(portalT('admin.edit.editing')) + '</span></td>';
      } else if (!adminEditTarget || adminEditTarget.indexOf('price:') !== 0){
        html += '<td><button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="edit-price" data-price-id="' +
          escHtml(pid) + '">' + escHtml(portalT('admin.action.edit')) + '</button></td>';
      } else {
        html += '<td></td>';
      }
    }
    html += '</tr>';
    if (editing){
      html += '<tr><td colspan="' + (writes ? 6 : 5) + '"><div class="portal-admin-edit-form">' +
        '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
        '<input type="text" id="admin-price-display-name" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
        '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
        '<input type="text" id="admin-price-amount-eur" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
        '<div class="portal-admin-edit-actions">' +
        '<button type="button" class="btn btn-primary" data-admin-action="save-price" data-price-id="' + escHtml(pid) + '">' +
        escHtml(portalT('admin.action.save')) + '</button>' +
        '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
        '</div></div></td></tr>';
    }
  });
  html += '</tbody></table>';
  html += '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.prices.configNote')) +
    ' (' + escHtml((cfg && cfg.source) ? cfg.source : 'config') + ')</p>';
  box.innerHTML = html;
}

function renderAdminSectionCapacityFromConfig(cfg){
  var box = el('admin-capacity-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var cap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var editing = writes && adminEditTarget === 'capacity';
  var html = '<div class="portal-admin-kv"><span class="portal-admin-kv-label">' + escHtml(portalT('admin.capacity.dailyDefault')) +
    '</span><span class="portal-admin-kv-value">' + escHtml(String(cap) + ' ' + portalT('admin.capacity.seatsPerDay')) + '</span></div>';
  if (writes && !adminEditTarget){
    html += '<div style="margin-top:10px"><button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="edit-capacity">' +
      escHtml(portalT('admin.action.edit')) + '</button></div>';
  }
  if (editing){
    html += '<div class="portal-admin-edit-form">' +
      '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.capacity.dailyDefault')) + '</label>' +
      '<input type="number" id="admin-capacity-input" min="1" max="999" step="1" value="' + escHtml(String(cap)) + '"></div>' +
      '<div class="portal-admin-edit-actions">' +
      '<button type="button" class="btn btn-primary" data-admin-action="save-capacity">' + escHtml(portalT('admin.action.save')) + '</button>' +
      '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
      '</div></div>';
  }
  html += '<p style="margin-top:10px;font-size:12px;color:var(--text-3)">' + escHtml(portalT('admin.capacity.futureNote')) + '</p>';
  box.innerHTML = html;
}

function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  if (!slots.length){
    box.innerHTML = '<p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.placeholder')) + '</p>';
    return;
  }
  var html = '<table class="portal-admin-table"><thead><tr><th>' + escHtml(portalT('admin.lessonTimes.col.date')) +
    '</th><th>' + escHtml(portalT('admin.lessonTimes.col.time')) + '</th><th>' + escHtml(portalT('admin.lessonTimes.col.label')) +
    '</th><th>' + escHtml(portalT('admin.lessonTimes.col.capacity')) + '</th>' +
    (writes ? '<th>' + escHtml(portalT('admin.edit.col.actions')) + '</th>' : '') +
    '</tr></thead><tbody>';
  slots.forEach(function(s){
    var sid = s.slot_id ? String(s.slot_id) : '';
    var editing = writes && adminEditTarget === ('time:' + sid);
    html += '<tr><td>' + escHtml(s.date || '—') + '</td><td>' + escHtml(s.slot_time || '—') + '</td><td>' +
      escHtml(s.offering_label || s.session_type || 'Lesson') + '</td><td>' +
      escHtml(s.capacity != null ? String(s.capacity) : '—') + '</td>';
    if (writes){
      if (editing){
        html += '<td><span class="portal-admin-muted">' + escHtml(portalT('admin.edit.editing')) + '</span></td>';
      } else if (!adminEditTarget || adminEditTarget.indexOf('time:') !== 0){
        html += '<td><button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="edit-time" data-time-id="' +
          escHtml(sid) + '">' + escHtml(portalT('admin.action.edit')) + '</button></td>';
      } else {
        html += '<td></td>';
      }
    }
    html += '</tr>';
    if (editing){
      html += '<tr><td colspan="' + (writes ? 5 : 4) + '"><div class="portal-admin-edit-form">' +
        '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
        '<input type="text" id="admin-time-label" value="' + escHtml(s.offering_label || s.session_type || '') + '" maxlength="120"></div>' +
        '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
        '<input type="text" id="admin-time-start" value="' + escHtml(adminSlotTimeStart(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
        '<div class="portal-admin-edit-actions">' +
        '<button type="button" class="btn btn-primary" data-admin-action="save-time" data-time-id="' + escHtml(sid) + '">' +
        escHtml(portalT('admin.action.save')) + '</button>' +
        '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
        '</div></div></td></tr>';
    }
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
  var html = '<table class="portal-admin-history-table"><thead><tr><th>' + escHtml(portalT('admin.history.col.when')) +
    '</th><th>' + escHtml(portalT('admin.history.col.actor')) + '</th><th>' + escHtml(portalT('admin.history.col.action')) +
    '</th><th>' + escHtml(portalT('admin.history.col.entity')) + '</th></tr></thead><tbody>';
  rows.forEach(function(r){
    html += '<tr><td>' + escHtml(r.changed_at ? String(r.changed_at).slice(0, 19).replace('T', ' ') : '—') + '</td><td>' +
      escHtml(r.actor_email || '—') + '</td><td>' + escHtml(r.action || '—') + '</td><td>' +
      escHtml(r.entity_type || '—') + '</td></tr>';
  });
  html += '</tbody></table>';
  box.innerHTML = html;
}

function renderAdminWriteState(cfg){
  var banner = el('admin-write-banner');
  if (banner) {
    if (adminCfgWritesEnabled(cfg)) {
      banner.innerHTML = '<strong>' + escHtml(portalT('admin.banner.writesUiEnabled')) + '</strong> — ' +
        escHtml(portalT('admin.banner.writesUiEnabledSub'));
    } else {
      banner.innerHTML = '<strong data-i18n="admin.banner.readOnly">' + escHtml(portalT('admin.banner.readOnly')) + '</strong> — ' +
        '<span data-i18n="admin.banner.writesDisabled">' + escHtml(portalT('admin.banner.writesDisabled')) + '</span> ' +
        '<span data-i18n="admin.banner.lunaNote">' + escHtml(portalT('admin.banner.lunaNote')) + '</span>';
    }
  }
}

function renderAdminFromConfig(cfg){
  renderAdminWriteState(cfg);
  renderAdminSectionPricesFromConfig(cfg);
  renderAdminSectionCapacityFromConfig(cfg);
  renderAdminSectionLessonTimesFromConfig(cfg);
  renderAdminSectionBusinessInfoFromConfig(cfg);
  renderAdminSectionChangeHistoryFromConfig(cfg);
}

function renderAdminFallback(profile){
  adminEditTarget = null;
  renderAdminWriteState(null);
  renderAdminSectionCapacityFromConfig({ lesson_capacity: { default_daily_cap: SUNSET_SCHEDULE_LESSON_DAY_CAP } });
  renderAdminSectionLessonTimesFromConfig({ lesson_times: (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [] });
  renderAdminSectionPricesFromConfig(null);
  renderAdminSectionBusinessInfoFromConfig(null);
  renderAdminSectionChangeHistoryFromConfig(null);
}

function loadAdminTab(){
  wireAdminTab();
  var profile = getPortalProfile(getClient());
  if (!profile.is_surf_vertical) return;
  var state = el('admin-fetch-state');
  if (state){ state.textContent = portalT('admin.loading'); state.style.display = 'block'; state.classList.remove('error'); }
  var url = '/staff/admin/config?client=' + encodeURIComponent(getClient());
  fetch(url).then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data){
      if (!data || data.success !== true) return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
      adminConfigCache = data;
      if (!adminCfgWritesEnabled(data)) adminEditTarget = null;
      renderAdminFromConfig(data);
      if (state) state.style.display = 'none';
    })
    .catch(function(e){
      adminConfigCache = null;
      adminEditTarget = null;
      renderAdminFallback(profile);
      if (state){
        state.textContent = portalT('admin.error') + ' ' + e.message;
        state.className = 'state-msg error';
        state.style.display = 'block';
      }
    });
}

function wireAdminTab(){
  var root = el('tab-admin');
  if (!root || root.dataset.adminWired === '1') return;
  root.dataset.adminWired = '1';
  root.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;
    if (!btn || adminSaveBusy) return;
    var cfg = adminConfigCache;
    var action = btn.getAttribute('data-admin-action');
    if (action === 'edit-capacity' || action === 'edit-price' || action === 'edit-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-time'){
      if (!adminCfgWritesEnabled(cfg)) return;
    }
    if (action === 'edit-capacity'){
      adminEditTarget = 'capacity';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'cancel-edit'){
      adminEditTarget = null;
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-price'){
      adminEditTarget = 'price:' + String(btn.getAttribute('data-price-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-time'){
      adminEditTarget = 'time:' + String(btn.getAttribute('data-time-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'save-capacity'){
      var capInput = el('admin-capacity-input');
      var capParsed = adminParseCapacity(capInput && capInput.value);
      if (!capParsed.ok){ adminShowMessage('error', capParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PUT', '/staff/admin/config/lesson-capacity' + adminClientQuery(), { default_daily_cap: capParsed.value })
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedCapacity'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var nameInput = el('admin-price-display-name');
      var amountInput = el('admin-price-amount-eur');
      var name = nameInput ? String(nameInput.value || '').trim() : '';
      if (!name){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
        display_name: name,
        amount_cents: centsParsed.value,
      }).then(function(res){
        adminSaveBusy = false;
        if (res.status !== 200 || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
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
    if (action === 'save-time'){
      var timeId = String(btn.getAttribute('data-time-id') || '');
      var labelInput = el('admin-time-label');
      var startInput = el('admin-time-start');
      var label = labelInput ? String(labelInput.value || '').trim() : '';
      if (!label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var timeParsed = adminParseTimeHm(startInput && startInput.value);
      if (!timeParsed.ok){ adminShowMessage('error', timeParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), {
        label: label,
        time_local: timeParsed.value,
      }).then(function(res){
        adminSaveBusy = false;
        if (res.status !== 200 || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.savedTime'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
    }
  });
}'''

I18N_INSERT_AFTER = "'admin.business.stagingNo': 'No',"
I18N_NEW = """
    'admin.banner.writesUiEnabled': 'Editing enabled',
    'admin.banner.writesUiEnabledSub': 'Save changes one section at a time. Bulk edits are not available yet.',
    'admin.action.edit': 'Edit',
    'admin.action.save': 'Save',
    'admin.action.cancel': 'Cancel',
    'admin.edit.col.actions': 'Actions',
    'admin.edit.editing': 'Editing',
    'admin.edit.displayName': 'Display name',
    'admin.edit.amountEur': 'Amount (EUR)',
    'admin.edit.startTime': 'Start time (HH:MM)',
    'admin.edit.capacityInvalid': 'Capacity must be an integer from 1 to 999.',
    'admin.edit.amountRequired': 'Enter an amount.',
    'admin.edit.amountInvalid': 'Enter a valid non-negative amount.',
    'admin.edit.timeInvalid': 'Time must be HH:MM (24-hour).',
    'admin.edit.nameRequired': 'Name is required.',
    'admin.edit.savedCapacity': 'Lesson capacity saved.',
    'admin.edit.savedPrice': 'Price saved.',
    'admin.edit.savedTime': 'Lesson time saved.',
    'admin.edit.saveFailed': 'Save failed:',
    'admin.history.col.when': 'When',
    'admin.history.col.actor': 'Actor',
    'admin.history.col.action': 'Action',
    'admin.history.col.entity': 'Entity',
"""

V1_SECTION_11_OLD = """  assert('Admin save button disabled coming soon', apiSrc.includes('admin.action.saveComingSoon') && apiSrc.includes('disabled'));"""

V1_SECTION_11_NEW = """  assert('Admin writes gated by cfg.writes_enabled', apiSrc.includes('function adminCfgWritesEnabled('));
  assert('Admin edit controls hidden when writes off', apiSrc.includes('if (!adminCfgWritesEnabled(cfg)) adminEditTarget = null'));
  assert('Admin save message region', apiSrc.includes('id="admin-save-msg"'));
  assert('Admin legacy coming-soon buttons removed', !apiSrc.includes('admin.action.saveComingSoon'));"""

V1_SECTION_14 = """

// ── 14. Sunset Admin edit UI (writes_enabled gated) ───────────────────────────

console.log('\\n[14] Sunset Admin edit UI — writes_enabled gated');

if (apiSrc) {
  assert('wireAdminTab wired', apiSrc.includes('function wireAdminTab(') && apiSrc.includes("root.dataset.adminWired"));
  assert('admin PUT lesson-capacity client call', apiSrc.includes("'/staff/admin/config/lesson-capacity'") && apiSrc.includes('adminClientQuery()'));
  assert('admin PATCH price client call', apiSrc.includes("'/staff/admin/config/prices/'") && apiSrc.includes('save-price'));
  assert('admin PATCH lesson-time client call', apiSrc.includes("'/staff/admin/config/lesson-times/'") && apiSrc.includes('save-time'));
  assert('writes off skips write handlers', apiSrc.includes('if (!adminCfgWritesEnabled(cfg)) return'));
  assert('admin tab surf-gated no Wolfhouse exposure', apiSrc.includes("tab === 'admin' && !profile.is_surf_vertical"));
  assert('admin edit one target at a time', apiSrc.includes('var adminEditTarget'));
}

if (i18nSrc) {
  assert('admin.action.edit i18n', i18nSrc.includes("'admin.action.edit': 'Edit'"));
  assert('admin.banner.writesUiEnabled i18n', i18nSrc.includes("'admin.banner.writesUiEnabled'"));
}
"""


def replace_admin_js(text: str) -> str:
    start = text.find(ADMIN_JS_OLD_START)
    end = text.find(ADMIN_JS_OLD_END)
    if start < 0 or end < 0:
        raise SystemExit('admin JS block not found')
    end += len(ADMIN_JS_OLD_END)
    return text[:start] + ADMIN_JS_NEW + text[end:]


def main():
    api = API.read_text(encoding='utf-8')
    if 'function adminCfgWritesEnabled(' in api:
        print('already patched')
        return

    if ADMIN_ACTIONS_OLD not in api:
        raise SystemExit('admin actions HTML missing')
    api = api.replace(ADMIN_ACTIONS_OLD, ADMIN_ACTIONS_NEW, 1)

    if CSS_ANCHOR not in api:
        raise SystemExit('admin CSS anchor missing')
    if '.portal-admin-save-msg' not in api:
        api = api.replace(CSS_ANCHOR, CSS_ANCHOR + CSS_EXTRA, 1)

    api = replace_admin_js(api)
    API.write_text(api, encoding='utf-8')
    print('OK staff-query-api.js')

    i18n = I18N.read_text(encoding='utf-8')
    if "'admin.banner.writesUiEnabled'" not in i18n:
        if I18N_INSERT_AFTER not in i18n:
            raise SystemExit('i18n anchor missing')
        i18n = i18n.replace(I18N_INSERT_AFTER, I18N_INSERT_AFTER + I18N_NEW, 1)
        I18N.write_text(i18n, encoding='utf-8')
    print('OK staff-portal-i18n.js')

    v1 = V1.read_text(encoding='utf-8')
    if V1_SECTION_11_OLD not in v1:
        raise SystemExit('verify section 11 anchor missing')
    v1 = v1.replace(V1_SECTION_11_OLD, V1_SECTION_11_NEW, 1)
    if '[14] Sunset Admin edit UI' not in v1:
        anchor = "// ── Shared Inbox Slice 3A — channel badges + mock rows ───────────────────────"
        if anchor not in v1:
            raise SystemExit('verify section 14 anchor missing')
        v1 = v1.replace(anchor, V1_SECTION_14 + '\n' + anchor, 1)
    V1.write_text(v1, encoding='utf-8')
    print('OK verify-sunset-portal-v1.js')


if __name__ == '__main__':
    main()
