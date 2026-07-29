var adminConfigCache = null;
var adminEditTarget = null;
/** In-memory Admin sub-tab: 'finance' | 'pricing'. Reset only on Admin reload (loadAdminTab). */
var adminActiveSubTab = 'finance';
/**
 * In-memory Pricing draft snapshot for preserveDraft re-renders.
 * Shape: { schoolKey, editTarget, fields: { [stableKey]: { kind:'value'|'check', value?, checked? } } }
 * Cleared on non-preserve re-renders and deliberate Admin reopen.
 */
var adminPricingDraftState = null;

function adminPricingDraftSchoolKey(){
  try {
    var client = (typeof getClient === 'function') ? String(getClient() || '') : '';
    var loc = '';
    if (client === 'sunset' && typeof getSunsetLocation === 'function') {
      loc = String(getSunsetLocation() || '');
    }
    return client + '|' + loc;
  } catch (_e) {
    return '';
  }
}

function adminClearPricingDraftState(){
  adminPricingDraftState = null;
}

function adminPricingDraftFieldKey(node){
  if (!node) return '';
  var id = node.id ? String(node.id) : '';
  if (id) return 'id:' + id;
  var field = (node.getAttribute && node.getAttribute('data-admin-price-field')) || '';
  if (field) {
    var card = (node.closest && node.closest('[data-admin-price-card]')) || null;
    var cardId = (card && card.getAttribute) ? String(card.getAttribute('data-admin-price-card') || '') : '';
    if (cardId) return 'price:' + cardId + ':' + field;
  }
  var cls = (node.className && String(node.className)) || '';
  if (/\bportal-admin-group-avail-toggle\b/.test(cls) || (node.classList && node.classList.contains('portal-admin-group-avail-toggle'))) {
    var g = (node.getAttribute && node.getAttribute('data-rental-group')) || '';
    if (g) return 'avail:' + g;
  }
  if (/\bpack-tier-amount\b/.test(cls) || (node.classList && node.classList.contains('pack-tier-amount'))) {
    var form = (node.closest && node.closest('[data-admin-pack-form]')) || null;
    var formId = (form && form.getAttribute) ? String(form.getAttribute('data-admin-pack-form') || '') : '';
    var row = (node.closest && node.closest('[data-pack-tier-row]')) || null;
    var rows = form ? form.querySelectorAll('[data-pack-tier-row]') : null;
    var idx = -1;
    if (rows && row) {
      for (var ri = 0; ri < rows.length; ri++) {
        if (rows[ri] === row) { idx = ri; break; }
      }
    }
    if (formId && idx >= 0) return 'pack-tier-amount:' + formId + ':' + idx;
  }
  if (/\bpack-tier-key\b/.test(cls) || (node.classList && node.classList.contains('pack-tier-key'))) {
    var formK = (node.closest && node.closest('[data-admin-pack-form]')) || null;
    var formIdK = (formK && formK.getAttribute) ? String(formK.getAttribute('data-admin-pack-form') || '') : '';
    var rowK = (node.closest && node.closest('[data-pack-tier-row]')) || null;
    var rowsK = formK ? formK.querySelectorAll('[data-pack-tier-row]') : null;
    var idxK = -1;
    if (rowsK && rowK) {
      for (var rj = 0; rj < rowsK.length; rj++) {
        if (rowsK[rj] === rowK) { idxK = rj; break; }
      }
    }
    if (formIdK && idxK >= 0) return 'pack-tier-key:' + formIdK + ':' + idxK;
  }
  var name = (node.getAttribute && node.getAttribute('name')) || '';
  if (name) return 'name:' + name;
  return '';
}

function adminPricingDraftRoots(){
  var roots = [];
  var prices = (typeof el === 'function') ? el('admin-prices-body') : null;
  var times = (typeof el === 'function') ? el('admin-times-body') : null;
  if (prices) roots.push(prices);
  if (times) roots.push(times);
  return roots;
}

function adminSnapshotPricingDraftState(){
  var fields = {};
  var roots = adminPricingDraftRoots();
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    if (!root || !root.querySelectorAll) continue;
    var nodes = root.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = adminPricingDraftFieldKey(node);
      if (!key) continue;
      var tag = String(node.tagName || '').toUpperCase();
      var type = String(node.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        fields[key] = { kind: 'check', checked: !!node.checked };
      } else if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        fields[key] = { kind: 'value', value: node.value != null ? String(node.value) : '' };
      }
    }
  }
  adminPricingDraftState = {
    schoolKey: adminPricingDraftSchoolKey(),
    editTarget: adminEditTarget != null ? String(adminEditTarget) : '',
    fields: fields,
  };
}

function adminRestorePricingDraftState(){
  var snap = adminPricingDraftState;
  if (!snap || !snap.fields) return;
  if (snap.schoolKey !== adminPricingDraftSchoolKey()) {
    adminClearPricingDraftState();
    return;
  }
  var curTarget = adminEditTarget != null ? String(adminEditTarget) : '';
  if (snap.editTarget !== curTarget) {
    // Mismatched edit surface — do not restore onto wrong controls.
    return;
  }
  var roots = adminPricingDraftRoots();
  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    if (!root || !root.querySelectorAll) continue;
    var nodes = root.querySelectorAll('input, select, textarea');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = adminPricingDraftFieldKey(node);
      if (!key || !Object.prototype.hasOwnProperty.call(snap.fields, key)) continue;
      var entry = snap.fields[key];
      if (!entry) continue;
      var tag = String(node.tagName || '').toUpperCase();
      var type = String(node.type || '').toLowerCase();
      if (entry.kind === 'check') {
        if (type !== 'checkbox' && type !== 'radio') continue;
        node.checked = !!entry.checked;
      } else if (entry.kind === 'value') {
        if (type === 'checkbox' || type === 'radio') continue;
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') continue;
        node.value = entry.value != null ? String(entry.value) : '';
      }
    }
  }
}

function adminPriceGroupBusy(groupKey){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  if (t.indexOf('price-group:') === 0) return t !== ('price-group:' + groupKey);
  if (t.indexOf('price-add:') === 0) return t !== ('price-add:' + groupKey);
  return false;
}
function adminLessonSectionEditing(){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  return t === 'time:new' || t.indexOf('time:') === 0;
}
function adminPackSectionEditing(){
  if (!adminEditTarget) return false;
  var t = String(adminEditTarget);
  return t === 'pack:new' || t.indexOf('pack:') === 0;
}
function adminPrivateLessonSectionEditing(){
  return adminEditTarget === 'private-lesson';
}

var adminSaveBusy = false;
var adminLoadSeq = 0;
/** Generation that currently owns adminSaveBusy (0 = none). Shared by all Admin loads/mutations. */
var adminBusyOwnerSeq = 0;

/**
 * Claim busy for a specific operation token. Newer claims supersede prior owners so stale
 * handlers cannot leave Admin permanently blocked.
 * Only adminClaimBusy / adminReleaseBusy / adminClearBusy may assign adminSaveBusy.
 */
function adminClaimBusy(opSeq){
  adminSaveBusy = true;
  adminBusyOwnerSeq = opSeq;
}

/**
 * Release busy only if opSeq still owns it. Stale success/error/finally no-ops.
 */
function adminReleaseBusy(opSeq){
  if (adminBusyOwnerSeq === opSeq){
    adminSaveBusy = false;
    adminBusyOwnerSeq = 0;
  }
}

/** Deliberate busy clear (canonical save/reload exit) — drops any owner. */
function adminClearBusy(){
  adminSaveBusy = false;
  adminBusyOwnerSeq = 0;
}

/**
 * Begin a new Admin operation: allocate a monotonic token and claim busy.
 * All loads, keep-edit reloads, and wireAdminTab mutations must use this (or
 * claim via adminClaimBusy after ++adminLoadSeq) — no naked adminSaveBusy writes.
 * @returns {number} operation token
 */
function adminBeginOp(){
  var opSeq = ++adminLoadSeq;
  adminClaimBusy(opSeq);
  return opSeq;
}

/** True when opSeq still owns the current busy generation. */
function adminOpStillOwns(opSeq){
  return adminBusyOwnerSeq === opSeq;
}

function adminCfgWritesEnabled(cfg){
  return !!(cfg && cfg.writes_enabled === true);
}

function adminClientQuery(){
  var q = '?client=' + encodeURIComponent(getClient());
  if (getClient() === 'sunset'){
    q += '&location=' + encodeURIComponent(getSunsetLocation());
  }
  return q;
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

/**
 * Ownership gate for in-flight adminReloadConfigKeepingEdit responses.
 * Shares adminLoadSeq with loadAdminTab so newer loads win (single sequence owner).
 * Stale responses must not mutate cache/DOM/target/draft.
 * Busy release is generation-token based via adminReleaseBusy (not a naked boolean).
 */
function adminReloadKeepingEditOwnership(loadSeq, originSchoolKey, originEditTarget){
  if (loadSeq !== adminLoadSeq) return { apply: false };
  var curTarget = adminEditTarget != null ? String(adminEditTarget) : '';
  if (adminPricingDraftSchoolKey() !== originSchoolKey || curTarget !== originEditTarget) {
    // Same generation but school/edit ownership drifted — discard body.
    return { apply: false };
  }
  return { apply: true };
}

function adminReloadConfigKeepingEdit(keepTarget){
  var saved = keepTarget || null;
  // Capture full ownership identity at request start (school/client/location, edit target, generation).
  var originSchoolKey = adminPricingDraftSchoolKey();
  var originEditTarget = adminEditTarget != null ? String(adminEditTarget) : '';
  // Shared monotonic token with loads + mutations; only owner may release/mutate.
  var loadSeq = adminBeginOp();
  var url = '/staff/admin/config' + adminClientQuery();
  // try/catch around sync fetch throw: direct throw bypasses promise catch/finally and
  // would leave this token owning busy forever. Owning sync failure must release.
  try {
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(data){
        var gate = adminReloadKeepingEditOwnership(loadSeq, originSchoolKey, originEditTarget);
        if (!gate.apply) {
          adminReleaseBusy(loadSeq);
          return;
        }
        if (!data || data.success !== true) return Promise.reject(new Error('load failed'));
        adminConfigCache = data;
        adminEditTarget = saved;
        // Keep unsaved Pricing field drafts while re-rendering for a kept edit target.
        renderAdminFromConfig(data, { preserveDraft: true });
        adminReleaseBusy(loadSeq);
      })
      .catch(function(e){
        // Stale error/finally must not clear busy or mutate state owned by a newer operation.
        var gate = adminReloadKeepingEditOwnership(loadSeq, originSchoolKey, originEditTarget);
        if (!gate.apply) {
          adminReleaseBusy(loadSeq);
          return;
        }
        adminEditTarget = saved;
        adminShowMessage('error', portalT('admin.error') + ' ' + e.message);
        if (adminConfigCache) renderAdminFromConfig(adminConfigCache, { preserveDraft: true });
        adminReleaseBusy(loadSeq);
      });
  } catch (syncErr) {
    if (adminOpStillOwns(loadSeq)) {
      adminEditTarget = saved;
      adminShowMessage('error', portalT('admin.error') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      if (adminConfigCache) renderAdminFromConfig(adminConfigCache, { preserveDraft: true });
      adminReleaseBusy(loadSeq);
    }
  }
}

function adminReloadConfig(){
  adminEditTarget = null;
  adminClearBusy();
  adminClearPricingDraftState();
  // Admin pack/price CRUD must invalidate Schedule create-menu cache immediately —
  // same SPA session previously kept stale surf_packs until school switch/restart.
  if (typeof scheduleInvalidateAdminCatalogCache === 'function') scheduleInvalidateAdminCatalogCache();
  loadAdminTab();
}function adminIsLessonPrice(p){
  return String((p && p.category) || '').toLowerCase() === 'lesson';
}function adminLessonKindOptions(selected){
  return ['lesson', 'pack'].map(function(k){
    var sel = (selected === k) ? ' selected' : '';
    return '<option value="' + escHtml(k) + '"' + sel + '>' + escHtml(portalT('admin.lesson.kind.' + k)) + '</option>';
  }).join('');
}

function adminLessonAgeOptions(selected){
  return ['all_ages', '6_and_up', '6_to_11', '12_and_up'].map(function(a){
    var sel = (selected === a) ? ' selected' : '';
    return '<option value="' + escHtml(a) + '"' + sel + '>' + escHtml(portalT('admin.lesson.age.' + a)) + '</option>';
  }).join('');
}

function adminLessonFrequencyOptions(selected){
  return ['daily', 'sat_sun', 'mon_fri'].map(function(f){
    var sel = (selected === f) ? ' selected' : '';
    return '<option value="' + escHtml(f) + '"' + sel + '>' + escHtml(portalT('admin.lesson.frequency.' + f)) + '</option>';
  }).join('');
}

function adminLessonFrequencyLabel(freq){
  var key = String(freq || 'daily');
  var tKey = 'admin.lesson.frequency.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminLessonAgeLabel(age){
  var key = String(age || 'all_ages');
  var tKey = 'admin.lesson.age.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminLessonKindLabel(kind){
  var key = String(kind || 'lesson');
  var tKey = 'admin.lesson.kind.' + key;
  var label = portalT(tKey);
  return label === tKey ? key : label;
}

function adminResolveLessonSlotFields(s){
  return {
    kind: s.kind || 'lesson',
    age_band: s.age_band || 'all_ages',
    frequency: s.frequency || 'daily',
    price_amount: s.price_amount != null ? s.price_amount : null,
  };
}


function adminPackBeachOptions(){ return [
  { value: 'el_sardinero', label: portalT('admin.packs.beach.el_sardinero') },
  { value: 'liencres', label: portalT('admin.packs.beach.liencres') },
  { value: 'somo', label: portalT('admin.packs.beach.somo') },
];}
function adminPackGroupSizeOptions(){ return [8, 12, 16, 20, 24].map(function(n){
  return { value: String(n), label: portalT('admin.packs.groupExclusive').replace('{n}', String(n)) };
});}
function adminPackScheduleOptions(){ return [
  { value: '0930_1130', label: portalT('admin.packs.schedule.0930_1130') },
  { value: '1215_1415', label: portalT('admin.packs.schedule.1215_1415') },
];}
function adminPackWeeklyOptions(){ return adminLessonFrequencyOptions('mon_fri').replace(/mon_fri/,'mon_fri'); }
function adminRenderPillRow(group, options, selected, multi){
  var sel = multi ? (selected || []) : [selected];
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">';
  if (group === 'beaches') html += escHtml(portalT('admin.packs.beaches'));
  else if (group === 'group_size') html += escHtml(portalT('admin.packs.groupSize'));
  else if (group === 'weekly') html += escHtml(portalT('admin.edit.frequency'));
  else if (group === 'schedules') html += escHtml(portalT('admin.packs.schedules'));
  else if (group === 'age_band') html += escHtml(portalT('admin.edit.age'));
  else html += escHtml(group);
  html += '</span><div class="portal-admin-pill-row" data-admin-pill-group="' + escHtml(group) + '" data-admin-pill-multi="' + (multi ? '1' : '0') + '">';
  options.forEach(function(o){
    var on = sel.indexOf(o.value) >= 0;
    html += '<button type="button" class="portal-admin-pill' + (on ? ' is-selected' : '') + '" data-admin-action="toggle-pill" data-admin-pill-group="' + escHtml(group) + '" data-admin-pill-value="' + escHtml(o.value) + '">' + escHtml(o.label) + '</button>';
  });
  return html + '</div></div>';
}
// Read-only display of a pill group's selected values — used on the course card when NOT
// editing, so the pills can't be toggled unless the Edit button is pressed.
function adminRenderPackPillReadout(group, options, selected, multi){
  var sel = multi ? (selected || []) : [selected];
  var labelMap = {};
  options.forEach(function(o){ labelMap[o.value] = o.label; });
  var vals = sel.filter(Boolean).map(function(v){ return labelMap[v] || v; });
  var groupLabel = group;
  if (group === 'beaches') groupLabel = portalT('admin.packs.beaches');
  else if (group === 'weekly') groupLabel = portalT('admin.edit.frequency');
  else if (group === 'group_size') groupLabel = portalT('admin.packs.groupSize');
  else if (group === 'age_band') groupLabel = portalT('admin.edit.age');
  return '<div class="portal-admin-pill-group portal-admin-pill-readout"><span class="portal-admin-pill-label">' + escHtml(groupLabel) + '</span> <strong>' + escHtml(vals.join(', ') || '—') + '</strong></div>';
}
function adminPackFormRoot(pid){
  if (pid) return document.querySelector('[data-admin-pack-form="' + pid + '"]');
  return document.querySelector('[data-admin-pack-form="new"]');
}
function adminCollectPillValues(group, root){
  var scope = root || document;
  var row = scope.querySelector('.portal-admin-pill-row[data-admin-pill-group="' + group + '"]');
  if (!row) return [];
  return Array.prototype.slice.call(row.querySelectorAll('.portal-admin-pill.is-selected')).map(function(b){ return b.getAttribute('data-admin-pill-value'); });
}
function adminCollectSinglePill(group, fallback, root){
  var vals = adminCollectPillValues(group, root);
  return vals.length ? vals[0] : fallback;
}
function adminPackAgeOptions(){
  return ['all_ages', '6_and_up', '6_to_11', '12_and_up'].map(function(a){
    return { value: a, label: portalT('admin.lesson.age.' + a) };
  });
}
function adminPackWeeklyPillOptions(){
  return ['daily', 'sat_sun', 'mon_fri'].map(function(f){
    return { value: f, label: portalT('admin.lesson.frequency.' + f) };
  });
}

// No fabricated commercial amounts — Admin configures each 1–7 day price explicitly.
var ADMIN_DEFAULT_PRICE_TIERS = [];
var ADMIN_CANONICAL_DAY_TIER_KEYS = {
  '1_hour': true, '2_hours': true, 'half_day': true, 'full_day': true,
  '2_days': true, '3_days': true, '4_days': true,
  '5_days': true, '6_days': true, '7_days': true,
};
var ADMIN_CANONICAL_PACK_TIER_KEYS = {
  '1_day': true, '2_days': true, '3_days': true, '4_days': true,
  '5_days': true, '6_days': true, '7_days': true,
};
function adminDefaultPackConfigSeed(){
  return {
    equipment_included: false,
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero', 'liencres', 'somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130', '1215_1415'],
    price_tiers: [],
  };
}

function adminDefaultPackSeed(){
  var d = adminDefaultPackConfigSeed();
  return { label: portalT('admin.packs.defaultName'), equipment_included: false, age_band: d.age_band, group_size: d.group_size, beaches: d.beaches.slice(), weekly: d.weekly, schedules: d.schedules.slice(), price_tiers: d.price_tiers.map(function(t){ return Object.assign({}, t); }) };
}

function adminTimesFromScheduleKey(key){
  var parts = String(key || '').split('_');
  if (parts.length !== 2) return { start: '', end: '' };
  var fmt = function(hhmm){
    var s = String(hhmm || '').trim();
    if (s.length === 4) return s.slice(0, 2) + ':' + s.slice(2);
    return s;
  };
  return { start: fmt(parts[0]), end: fmt(parts[1]) };
}
function adminScheduleKeyFromTimes(start, end){
  var s = String(start || '').trim().replace(':', '');
  var e = String(end || '').trim().replace(':', '');
  if (!s || !e) return '';
  return s + '_' + e;
}
function adminRenderPackScheduleFields(p, prefix){
  var s0 = (p && p.schedules && p.schedules[0]) ? p.schedules[0] : '0930_1130';
  var s1 = (p && p.schedules && p.schedules[1]) ? p.schedules[1] : '';
  var t0 = adminTimesFromScheduleKey(s0);
  var t1 = adminTimesFromScheduleKey(s1);
  return '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-start" value="' + escHtml(t0.start) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-end" value="' + escHtml(t0.end) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.packs.startTime2')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-start2" value="' + escHtml(t1.start) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.packs.endTime2')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-end2" value="' + escHtml(t1.end) + '" placeholder="HH:MM" maxlength="5"></div>';
}
function adminRenderPackScheduleReadout(schedules){
  var list = (schedules || []).filter(Boolean).map(function(k){
    var t = adminTimesFromScheduleKey(k);
    return (t.start && t.end) ? (t.start + ' – ' + t.end) : null;
  }).filter(Boolean);
  var label = list.length ? list.join(', ') : '—';
  return '<div class="portal-admin-pack-schedule-readout"><span class="portal-admin-muted">' + escHtml(portalT('admin.packs.schedules')) + '</span> <strong>' + escHtml(label) + '</strong></div>';
}
function adminReadOnePackWindow(startId, endId, optional){
  var s = el(startId), e = el(endId);
  var sv = String((s && s.value) || '').trim();
  var ev = String((e && e.value) || '').trim();
  if (optional && !sv && !ev) return { ok: true, key: '' };
  var sp = adminParseTimeHm(sv);
  if (!sp.ok) return { ok: false, error: sp.error };
  var ep = adminParseTimeHm(ev);
  if (!ep.ok) return { ok: false, error: ep.error };
  if (ep.value <= sp.value) return { ok: false, error: portalT('admin.edit.endAfterStart') };
  return { ok: true, key: adminScheduleKeyFromTimes(sp.value, ep.value) };
}
function adminReadPackSchedules(prefix){
  var w1 = adminReadOnePackWindow(prefix + '-schedule-start', prefix + '-schedule-end', false);
  if (!w1.ok) return { ok: false, error: w1.error };
  var w2 = adminReadOnePackWindow(prefix + '-schedule-start2', prefix + '-schedule-end2', true);
  if (!w2.ok) return { ok: false, error: w2.error };
  var out = [];
  if (w1.key) out.push(w1.key);
  if (w2.key) out.push(w2.key);
  return { ok: true, value: out };
}
// Admin "Price for" course durations: exactly 1–7 days (no weeks / single_class).
function adminPackTierDurations(){
  return [
    { key: '1_day', hours: 2 }, { key: '2_days', hours: 4 }, { key: '3_days', hours: 6 },
    { key: '4_days', hours: 8 }, { key: '5_days', hours: 10 }, { key: '6_days', hours: 12 },
    { key: '7_days', hours: 14 },
  ].map(function(d){ return { key: d.key, hours: d.hours, label: adminPeriodLabel(d.key) }; });
}
function adminRenderPackTierRowsHtml(rows){
  var durs = adminPackTierDurations();
  return (rows || []).map(function(r){
    var opts = durs.map(function(d){
      return '<option value="' + escHtml(d.key) + '"' + (d.key === r.key ? ' selected' : '') + '>' + escHtml(d.label) + '</option>';
    }).join('');
    return '<div class="portal-admin-pack-tier" data-pack-tier-row style="position:relative;padding-right:22px">' +
      '<button type="button" class="portal-admin-icon-btn portal-admin-danger" data-admin-action="remove-pack-tier" aria-label="' + escHtml(portalT('admin.action.remove')) + '" title="' + escHtml(portalT('admin.action.remove')) + '" style="position:absolute;top:0;right:0;background:none;border:none;padding:0 2px;font-size:15px;line-height:1;cursor:pointer">×</button>' +
      '<select class="pack-tier-key">' + opts + '</select>' +
      '<input type="text" class="pack-tier-amount" value="' + escHtml(r.amount || '') + '" inputmode="decimal" placeholder="0.00">' +
      '<span class="portal-admin-muted">' + escHtml(portalT('admin.packs.perStudent')) + '</span>' +
      '</div>';
  }).join('');
}
function adminReadPackTierRows(prefix){
  var wrap = el(prefix + '-tier-rows');
  if (!wrap) return [];
  return Array.prototype.slice.call(wrap.querySelectorAll('[data-pack-tier-row]')).map(function(row){
    var keyEl = row.querySelector('.pack-tier-key');
    var amtEl = row.querySelector('.pack-tier-amount');
    return { key: keyEl ? keyEl.value : '', amount: amtEl ? amtEl.value : '' };
  });
}
function adminRenderPackTierFields(tiers, prefix){
  // Edit form only shows canonical 1–7 day keys. Legacy stored keys are not
  // rewritten here (server merge preserves them on save).
  var rows = (tiers || []).filter(function(t){
    return t && ADMIN_CANONICAL_PACK_TIER_KEYS[String(t.key || '').trim()];
  }).map(function(t){
    return { key: t.key, amount: adminEurosFromAmount((t.amount_cents != null ? t.amount_cents : 0) / 100) };
  });
  if (!rows.length) rows = [{ key: '1_day', amount: '' }];
  return '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>' +
    '<div id="' + escHtml(prefix) + '-tier-rows">' + adminRenderPackTierRowsHtml(rows) + '</div>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="add-pack-tier" data-tier-prefix="' + escHtml(prefix) + '">+ ' + escHtml(portalT('admin.packs.addPrice')) + '</button>' +
    '</div>';
}
function adminRenderPackTierReadout(tiers){
  // Course cards: commercial rows are only canonical 1_day…7_days.
  // Legacy keys (e.g. single_class) may remain in DB for old bookings but
  // never appear on Admin Group course card readouts or editable tier rows.
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>';
  (tiers || []).filter(function(t){
    return t && ADMIN_CANONICAL_PACK_TIER_KEYS[String(t.key || '').trim()];
  }).forEach(function(t){
    html += '<div class="portal-admin-pack-tier-row"><span>' + escHtml(t.label || t.key) + '</span><strong>' + escHtml(adminEurosFromAmount((t.amount_cents != null ? t.amount_cents : 0) / 100) + ' EUR ' + portalT('admin.packs.perStudent')) + '</strong></div>';
  });
  return html + '</div>';
}
function adminRenderPackEditForm(pid, pack){
  var p = pack || adminDefaultPackSeed();
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var formAttr = pid ? (' data-admin-pack-form="' + escHtml(pid) + '"') : ' id="admin-new-pack-form" data-admin-pack-form="new"';
  var inner = '<div class="portal-admin-pack-form"' + formAttr + '>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="' + prefix + '-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
    adminRenderPillRow('age_band', adminPackAgeOptions(), p.age_band || '12_and_up', false) +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.packs.groupSize')) + '</label>' +
    '<input type="number" id="' + prefix + '-group-size" min="1" max="999" step="1" value="' + escHtml(String(p.group_size || 16)) + '"></div>' +
    '<label class="portal-admin-edit-field"><input type="checkbox" id="' + prefix + '-equipment-included"' + (p.equipment_included === true ? ' checked' : '') + '> Equipment included <span class="portal-admin-muted">(board + wetsuit, €0, per participant/course day)</span></label>' +
    adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true) +
    adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false) +
    adminRenderPackScheduleFields(p, prefix) +
    adminRenderPackTierFields(p.price_tiers || [], prefix) +
    '<div class="portal-admin-price-card-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="' + (pid ? 'save-pack' : 'save-new-pack') + '" data-pack-id="' + escHtml(pid || '') + '">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
  if (pid) return inner;
  return '<div class="portal-admin-pack-card">' + inner + '</div>';
}
function adminReadPackFormPayload(pid){
  var root = adminPackFormRoot(pid || null);
  var prefix = pid ? ('admin-pack-' + pid) : 'admin-new-pack';
  var labelEl = el(prefix + '-label');
  var durMap = {};
  adminPackTierDurations().forEach(function(d){ durMap[d.key] = d; });
  var seenTierKeys = {};
  var tiers = adminReadPackTierRows(prefix).map(function(r){
    var d = durMap[r.key] || { key: r.key, label: r.key, hours: 0 };
    var cents = adminParseEurosToCents(r.amount);
    return { key: d.key, label: d.label, hours: d.hours, amount_cents: cents.ok ? cents.value : 0 };
  }).filter(function(t){
    if (!t.key || seenTierKeys[t.key]) return false; // drop blank + duplicate durations
    seenTierKeys[t.key] = true;
    return true;
  });
  var schedulesParsed = adminReadPackSchedules(prefix);
  return {
    label: labelEl ? String(labelEl.value || '').trim() : '',
    age_band: adminCollectSinglePill('age_band', '12_and_up', root),
    group_size: (function(){ var g = el(prefix + '-group-size'); var n = parseInt(g && g.value, 10); return (isFinite(n) && n > 0) ? n : 16; })(),
    equipment_included: !!(el(prefix + '-equipment-included') && el(prefix + '-equipment-included').checked),
    beaches: adminCollectPillValues('beaches', root),
    weekly: adminCollectSinglePill('weekly', 'mon_fri', root),
    schedules: schedulesParsed.ok ? schedulesParsed.value : [],
    price_tiers: tiers,
    _scheduleError: schedulesParsed.ok ? '' : schedulesParsed.error,
  };
}

function adminRentalGroupOrder(){
  return ['bundles', 'boards', 'wetsuits', 'sup'];
}

function adminPriceGroupKey(p){
  var parsed = adminParsePriceRow(p);
  return parsed.groupKey;
}


function adminPriceRowId(p){
  if (p && p.id) return String(p.id);
  var parsed = adminParsePriceRow(p);
  var loc = getClient() === 'sunset' ? getSunsetLocation() : 'default';
  var cat = String((p && p.category) || 'rental');
  var offering = String((p && (p.offering_key || parsed.offeringKey)) || '');
  var unit = String((p && p.unit) || parsed.periodWindow || '');
  return 'cfg:' + loc + ':' + cat + '|' + offering + '|' + unit;
}

function adminParsePriceRow(p){
  var code = String((p && (p.offering_key || p.item_code)) || '').toLowerCase();
  var parts = code.split('__');
  var offering = parts.length > 1 ? parts[0] : code;
  var period = parts.length > 1 ? parts.slice(1).join('__') : String((p && p.unit) || '');
  if (offering.indexOf('board_and_suit') >= 0 || (offering.indexOf('board') >= 0 && offering.indexOf('wetsuit') >= 0)) return { groupKey: 'bundles', offeringKey: offering, periodWindow: period };
  if (offering.indexOf('sup') >= 0) return { groupKey: 'sup', offeringKey: offering, periodWindow: period };
  if (offering.indexOf('wetsuit') >= 0) return { groupKey: 'wetsuits', offeringKey: offering, periodWindow: period };
  if (offering.indexOf('board') >= 0 || offering.indexOf('surfboard') >= 0) return { groupKey: 'boards', offeringKey: offering, periodWindow: period };
  return { groupKey: 'other', offeringKey: offering, periodWindow: period };
}

function adminPriceGroupTitle(key){
  if (key === 'bundles') return portalT('admin.prices.group.bundles');
  if (key === 'boards') return portalT('admin.prices.group.boards');
  if (key === 'wetsuits') return portalT('admin.prices.group.wetsuits');
  if (key === 'sup') return portalT('admin.prices.group.sup');
  return portalT('admin.prices.group.other');
}

function adminPeriodLabel(period){
  var key = String(period || '').trim();
  if (!key) return '???';
  var tKey = 'admin.period.' + key;
  var label = portalT(tKey);
  return label === tKey ? adminHumanizeText(key) : label;
}

function adminRentalPeriodOptions(selected){
  // One deterministic list shared by every rental category. Never reinsert an
  // unknown stored key: show an invalid placeholder rather than allowing the
  // browser to silently select the first option.
  var opts = ['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  var sel = String(selected || '').trim();
  var invalid = sel && opts.indexOf(sel) < 0
    ? '<option value="" selected disabled>' + escHtml(adminPeriodLabel(sel)) + '</option>'
    : '';
  return invalid + opts.map(function(p){
    var isSel = (sel === p) ? ' selected' : '';
    return '<option value="' + escHtml(p) + '"' + isSel + '>' + escHtml(adminPeriodLabel(p)) + '</option>';
  }).join('');
}

// Rank rental durations shortest → longest (1 day … 7 days).
function adminRentalPeriodRank(period){
  var order = ['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  var i = order.indexOf(String(period || '').trim());
  return i >= 0 ? i : 999;
}

/** True when a rental period key is a sellable Admin 1–7 day window. */
function adminIsCanonicalRentalPeriod(period){
  return !!ADMIN_CANONICAL_DAY_TIER_KEYS[String(period || '').trim()];
}

/**
 * Rental Prices tab: only canonical 1_day…7_days rows are rendered / edited /
 * submitted. Legacy hour/half_day/week/custom rows stay in DB for old bookings
 * but are never mapped onto the first select option (that created duplicates).
 */
function adminFilterCanonicalRentalPriceRows(items){
  return (items || []).filter(function(p){
    var parsed = adminParsePriceRow(p);
    var period = String(parsed.periodWindow || '').trim();
    // Known commercial windows are rendered normally. A genuinely unknown
    // stored value must remain visible so Edit can present the disabled invalid
    // sentinel and block Save; silently hiding corrupt data defeats that guard.
    return adminIsCanonicalRentalPeriod(period) || (!!period && period !== '1_day' && adminRentalPeriodRank(period) === 999);
  });
}

function adminPriceCategoryLabel(category){
  var c = String(category || '').trim().toLowerCase();
  if (c === 'lesson') return portalT('admin.prices.category.lesson');
  if (c === 'rental') return portalT('admin.prices.category.rental');
  if (c === 'package') return portalT('admin.prices.category.package');
  return category || '???';
}

function adminUnitLabel(unit){
  return adminPeriodLabel(unit);
}

function adminPriceInputKey(pid){
  return String(pid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  var ik = adminPriceInputKey(pid);
  return '<div class="portal-admin-price-card-edit">' +
    '<div><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select data-admin-price-field="period" id="admin-price-period-' + escHtml(ik) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" data-admin-price-field="amount" id="admin-price-amount-' + escHtml(ik) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '</div>';
}

function renderAdminAddPriceForm(groupKey){
  return '<div class="portal-admin-edit-form" id="admin-add-price-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-new-price-period">' + adminRentalPeriodOptions('1_day') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-new-price-amount" value="" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-price" data-price-group="' + escHtml(groupKey) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function adminDeriveGroupAvailState(items){
  var total = items.length;
  if (total === 0) return 'off';
  var activeCount = items.filter(function(p){ return p && p.active !== false; }).length;
  if (activeCount === total) return 'on';
  if (activeCount === 0) return 'off';
  return 'mixed';
}

function adminDedupeGroupItems(items){
  // Collapse duplicate rows per unique key = item_code||unit||effective_from.
  // Prefer the active row; else the one with the highest positive amount; else first.
  var seen = {};
  var canonical = [];
  for (var i = 0; i < items.length; i++){
    var p = items[i];
    var ic = p.item_code || p.offering_key || '';
    var u = p.unit || p.period || '';
    var ef = p.effective_from || '';
    var k = ic + '||' + u + '||' + ef;
    if (!seen[k]){
      seen[k] = { idx: canonical.length, row: p };
      canonical.push(p);
    } else {
      var existing = seen[k].row;
      var existingAmt = Number(existing.amount_cents != null ? existing.amount_cents : (existing.amount || 0));
      var newAmt = Number(p.amount_cents != null ? p.amount_cents : (p.amount || 0));
      var existingActive = existing.active !== false;
      var newActive = p.active !== false;
      // Prefer active row; else highest positive amount.
      if ((!existingActive && newActive) ||
          (!existingActive && !newActive && newAmt > existingAmt && newAmt > 0)){
        canonical[seen[k].idx] = p;
        seen[k].row = p;
      }
    }
  }
  return canonical;
}

// ── Generic Equipment Pricing tab (Slice 1) — flat, groupless, data-driven ──
// Slugify a typed equipment name into a valid offering_key (lowercase, _-sep,
// no "__", suffixed _rental for consistency with board_rental/wetsuit_rental).
function adminSlugOfferingKey(name){
  var s = String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!s) return '';
  if (!/^[a-z]/.test(s)) s = 'x_' + s;
  if (!/_rental$/.test(s)) s += '_rental';
  return s;
}

// Read a [count][Hours|Days] duration control into a canonical duration_key.
function adminReadDurationControl(prefix){
  var countEl = el(prefix + '-count');
  var unitEl = el(prefix + '-unit');
  var count = parseInt(countEl && countEl.value, 10);
  var unit = unitEl ? String(unitEl.value || '') : '';
  var key = (typeof rentalDurationKeyFromUnitCount === 'function')
    ? rentalDurationKeyFromUnitCount(unit, count) : '';
  return { unit: unit, count: count, duration_key: key };
}

function renderAdminDurationControl(prefix, unit, count){
  var u = unit || 'days';
  var c = count || 1;
  return '<div class="portal-admin-edit-field portal-admin-equip-field"><label>' + escHtml(portalT('admin.prices.duration') || 'Duration') + '</label>' +
    '<div class="portal-admin-duration-row">' +
    '<input type="number" class="portal-admin-duration-count" id="' + prefix + '-count" min="1" max="999" step="1" value="' + escHtml(String(c)) + '">' +
    '<select class="portal-admin-duration-unit" id="' + prefix + '-unit">' +
    '<option value="hours"' + (u === 'hours' ? ' selected' : '') + '>' + escHtml(portalT('admin.prices.hours') || 'Hours') + '</option>' +
    '<option value="days"' + (u === 'days' ? ' selected' : '') + '>' + escHtml(portalT('admin.prices.days') || 'Days') + '</option>' +
    '</select></div></div>';
}

function renderAdminAddEquipmentForm(){
  return '<div class="portal-admin-edit-form portal-admin-equip-form" id="admin-add-equip-form">' +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label>' + escHtml(portalT('admin.prices.equipmentName') || 'Equipment name') + '</label>' +
    '<input type="text" id="admin-new-equip-name" placeholder="Kayak"></div>' +
    renderAdminDurationControl('admin-new-equip', 'days', 1) +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" class="portal-admin-equip-amount" id="admin-new-equip-amount" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-equipment">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function renderAdminAddEquipPriceForm(offeringKey){
  return '<div class="portal-admin-edit-form portal-admin-equip-form" id="admin-add-price-form">' +
    renderAdminDurationControl('admin-new-price', 'days', 1) +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" class="portal-admin-equip-amount" id="admin-new-price-amount" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-price" data-equip-key="' + escHtml(offeringKey) + '">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function renderAdminSectionPricesFromConfig(cfg){
  var box = el('admin-prices-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var prices = (cfg && cfg.prices) ? cfg.prices : [];
  var items = (typeof buildEquipmentPricingList === 'function') ? buildEquipmentPricingList(prices) : [];
  var addingItem = writes && adminEditTarget === 'equip-add-item';
  var html = '';
  if (writes){
    html += '<div class="portal-admin-equip-toolbar" style="margin-bottom:12px">';
    if (!adminEditTarget){
      html += '<button type="button" class="btn btn-primary" data-admin-action="add-equipment">+ ' +
        escHtml(portalT('admin.prices.addEquipment') || 'Add equipment') + '</button>';
    }
    html += '</div>';
    if (addingItem) html += renderAdminAddEquipmentForm();
  }
  if (!items.length && !addingItem){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.noEquipment') || 'No equipment yet — add your first item.') + '</p>';
  }
  items.forEach(function(item){
    var key = item.offering_key;
    var editing = writes && adminEditTarget === ('equip:' + key);
    var adding = writes && adminEditTarget === ('equip-add-price:' + key);
    html += '<div class="portal-admin-subsection" data-admin-equip="' + escHtml(key) + '">';
    html += '<div class="portal-admin-subsection-title-row">';
    html += '<h3 class="portal-admin-subsection-title">' + escHtml(item.label) + '</h3>';
    if (writes && !adminPriceGroupBusy(key)){
      html += '<div class="portal-admin-card-actions">';
      if (!editing){
        html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-equipment" data-equip-key="' +
          escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>';
        if (!adding){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-equip-price" data-equip-key="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button>';
        }
      } else {
        html += '<button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="cancel-edit">' +
          escHtml(portalT('admin.action.done') || 'Done') + '</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    if (!item.rows.length && !adding){
      html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.emptyCategory')) + '</p>';
    }
    if (item.rows.length){
      html += '<div class="portal-admin-card-grid" id="admin-prices-card-grid-' + escHtml(key) + '">';
      item.rows.forEach(function(r){
        var euros = adminEurosFromAmount((r.amount_cents == null ? 0 : r.amount_cents) / 100);
        html += '<article class="portal-admin-price-card' + (editing && r.pid ? ' is-editing' : '') + (r.active ? '' : ' is-inactive') + '" data-admin-price-card="' + escHtml(r.pid || '') + '">';
        if (editing && r.pid){
          html += '<div class="portal-admin-card-title-row"><span class="portal-admin-price-period">' + escHtml(r.duration_label) + '</span>' +
            '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-price" data-price-id="' +
            escHtml(r.pid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div>';
          html += '<div><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
            '<input type="text" data-admin-price-field="amount" id="admin-price-amount-' + escHtml(adminPriceInputKey(r.pid)) + '" value="' + escHtml(euros) + '" inputmode="decimal"></div>';
          html += '<button type="button" class="btn btn-primary portal-admin-row-edit" data-admin-action="save-price-amount" data-price-id="' +
            escHtml(r.pid) + '">' + escHtml(portalT('admin.action.save')) + '</button>';
        } else {
          html += '<div class="portal-admin-price-card-readout"><span class="portal-admin-price-period">' + escHtml(r.duration_label) + '</span>' +
            '<span class="portal-admin-price-amount">' + escHtml(euros + ' EUR') + '</span></div>';
        }
        html += '</article>';
      });
      html += '</div>';
    }
    if (adding) html += renderAdminAddEquipPriceForm(key);
    html += '</div>';
  });
  box.innerHTML = html;
}

function renderAdminSectionCapacityFromConfig(cfg){
  var box = el('admin-capacity-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var cap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var editing = writes && adminEditTarget === 'capacity';
  var html = '<div class="portal-admin-capacity-card"><div><div class="portal-admin-kv-label">' + escHtml(portalT('admin.capacity.dailyDefault')) +
    '</div><div class="portal-admin-section-note">' + escHtml(portalT('admin.capacity.help')) + '</div></div>' +
    '<div class="portal-admin-capacity-number">' + escHtml(String(cap)) + '</div></div>';
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
  html += '<p class="portal-admin-section-note">' + escHtml(portalT('admin.capacity.futureNote')) + '</p>';
  box.innerHTML = html;
}

function renderAdminTimeEditForm(sid, s){
  var defaultCap = (adminConfigCache && adminConfigCache.lesson_capacity && adminConfigCache.lesson_capacity.default_daily_cap != null)
    ? adminConfigCache.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var fields = adminResolveLessonSlotFields(s);
  return '<div class="portal-admin-edit-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-time-label" value="' + escHtml(adminHumanizeText(s.offering_label || '')) + '" maxlength="120"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-time-capacity" min="1" max="999" step="1" value="' + escHtml(s.capacity != null ? String(s.capacity) : String(defaultCap)) + '"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-time-start" value="' + escHtml(adminSlotTimeStart(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-time-end" value="' + escHtml(adminSlotTimeEnd(s.slot_time)) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.age')) + '</label>' +
    '<select id="admin-time-age">' + adminLessonAgeOptions(fields.age_band) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.frequency')) + '</label>' +
    '<select id="admin-time-frequency">' + adminLessonFrequencyOptions(fields.frequency) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.cost')) + '</label>' +
    '<input type="text" id="admin-time-cost" value="' + escHtml(fields.price_amount != null ? adminEurosFromAmount(fields.price_amount) : '') + '" inputmode="decimal"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-time" data-time-id="' + escHtml(sid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function renderAdminAddTimeForm(){
  var defaultCap = (adminConfigCache && adminConfigCache.lesson_capacity && adminConfigCache.lesson_capacity.default_daily_cap != null)
    ? adminConfigCache.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  return '<div class="portal-admin-edit-form" id="admin-add-time-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-new-time-label" value="" maxlength="120" placeholder="Group surf lesson"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.capacity')) + '</label>' +
    '<input type="number" id="admin-new-time-capacity" min="1" max="999" step="1" value="' + escHtml(String(defaultCap)) + '"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="admin-new-time-start" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="admin-new-time-end" value="" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.age')) + '</label>' +
    '<select id="admin-new-time-age">' + adminLessonAgeOptions('all_ages') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.frequency')) + '</label>' +
    '<select id="admin-new-time-frequency">' + adminLessonFrequencyOptions('daily') + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.cost')) + '</label>' +
    '<input type="text" id="admin-new-time-cost" value="" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-time">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function adminIsLessonSlot(s){
  var fields = adminResolveLessonSlotFields(s);
  return fields.kind !== 'pack';
}
function renderAdminLessonCards(slots, cfg, writes, defaultCap){
  var html = '';
  var lessons = (slots || []).filter(adminIsLessonSlot);
  html += '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.lessonTimes.lessonsTitle')) + '</h3>';
  if (writes && !adminLessonSectionEditing()){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-time" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div></div><p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.lessonsHelp')) + '</p>';
  if (writes && adminEditTarget === 'time:new') html += renderAdminAddTimeForm();
  if (!lessons.length && adminEditTarget !== 'time:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.lessonTimes.placeholder')) + '</p></div>';
    return html;
  }
  html += '<div class="portal-admin-compact-grid" id="admin-lesson-card-grid">';
  lessons.forEach(function(s){
    var sid = (s.id || s.slot_id) ? String(s.id || s.slot_id) : '';
    var editing = writes && adminEditTarget === ('time:' + sid);
    var label = adminHumanizeText(s.offering_label || portalT('schedule.type.lesson'));
    var fields = adminResolveLessonSlotFields(s);
    var capText = s.capacity != null ? String(s.capacity) : String(defaultCap);
    var duration = adminSlotDurationLabel(s.slot_time);
    var costText = fields.price_amount != null ? (adminEurosFromAmount(fields.price_amount) + ' ' + (s.price_currency || 'EUR')) : '—';
    html += '<article class="portal-admin-lesson-card" data-admin-lesson-card="' + escHtml(sid) + '">';
    html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-lesson-title">' + escHtml(label) + '</div>' +
      '<div class="portal-admin-lesson-meta">' + escHtml(adminLessonFrequencyLabel(fields.frequency)) + '</div></div>';
    if (writes && !editing && !adminLessonSectionEditing()){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>' +
        '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-time" data-time-id="' +
        escHtml(sid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div>';
    }
    html += '</div>';
    if (editing) html += renderAdminTimeEditForm(sid, s);
    else {
      html += '<div class="portal-admin-lesson-facts">' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.capacity')) + '<strong>' + escHtml(capText + ' ' + portalT('admin.lessonTimes.seats')) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.duration')) + '<strong>' + escHtml(duration) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.startTime')) + '<strong>' + escHtml(adminSlotTimeStart(s.slot_time) || '—') + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.age')) + '<strong>' + escHtml(adminLessonAgeLabel(fields.age_band)) + '</strong></div>' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.cost')) + '<strong>' + escHtml(costText) + '</strong></div></div>';
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
function renderAdminPackCards(packs, writes, defaultCap){
  defaultCap = defaultCap != null ? defaultCap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.packs.title')) + '</h3>';
  if (writes && !adminPackSectionEditing()){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-pack" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button></div>';
  }
  html += '</div></div><p class="portal-admin-muted">' + escHtml(portalT('admin.packs.help')) + '</p>';
  if (writes && adminEditTarget === 'pack:new') html += adminRenderPackEditForm('', adminDefaultPackSeed());
  var list = packs && packs.length ? packs : [];
  if (!list.length && adminEditTarget !== 'pack:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.packs.placeholder')) + '</p></div>';
    return html;
  }
  html += '<div class="portal-admin-pack-grid" id="admin-pack-card-grid">';
  list.forEach(function(p){
    var pid = (p.pack_id || p.id) ? String(p.pack_id || p.id) : '';
    var editing = writes && adminEditTarget === ('pack:' + pid);
    html += '<article class="portal-admin-pack-card" data-admin-pack-card="' + escHtml(pid) + '">';
    html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-pack-title">' + escHtml(p.label || 'Pack') + '</div>' +
      '<div class="portal-admin-pack-sub">' + escHtml(adminLessonAgeLabel(p.age_band)) + '</div></div>';
    if (writes && !editing && !adminPackSectionEditing()){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-pack" data-pack-id="' +
        escHtml(pid) + '">✎</button><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-pack" data-pack-id="' +
        escHtml(pid) + '">×</button></div>';
    }
    html += '</div>';
    if (editing) html += adminRenderPackEditForm(pid, p);
    else {
      var capText = String(p.group_size != null ? p.group_size : defaultCap);
      html += '<div class="portal-admin-lesson-facts">' +
        '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.capacity')) + '<strong>' + escHtml(capText + ' ' + portalT('admin.lessonTimes.seats')) + '</strong></div>' +
        '</div>';
      html += adminRenderPackPillReadout('beaches', adminPackBeachOptions(), p.beaches || [], true);
      html += adminRenderPackPillReadout('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false);
      html += adminRenderPackScheduleReadout(p.schedules || []);
      html += adminRenderPackTierReadout(p.price_tiers || []);
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
function renderAdminPrivateLessonEditForm(pl){
  var p = pl || {};
  return '<div class="portal-admin-edit-form" data-admin-private-lesson-form="1">' +
    '<div class="portal-admin-edit-field svc-check"><label><input type="checkbox" id="admin-private-enabled"' +
    (p.enabled ? ' checked' : '') + '> ' + escHtml(portalT('admin.privateLessons.enabled')) + '</label></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.displayName')) + '</label>' +
    '<input type="text" id="admin-private-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.privateLessons.price')) + '</label>' +
    '<input type="text" id="admin-private-price" value="' + escHtml(adminEurosFromAmount((p.amount_cents || 0) / 100)) + '" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.privateLessons.duration')) + '</label>' +
    '<input type="number" id="admin-private-duration" min="15" max="480" step="1" value="' +
    escHtml(String(p.default_duration_minutes != null ? p.default_duration_minutes : 120)) + '"></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.privateLessons.notes')) + '</label>' +
    '<textarea id="admin-private-notes" rows="3" maxlength="2000">' + escHtml(p.notes || '') + '</textarea></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-private-lesson">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}
function renderAdminPrivateLessonReadout(pl){
  var p = pl || {};
  var enabledText = p.enabled ? portalT('admin.privateLessons.enabledYes') : portalT('admin.privateLessons.enabledNo');
  var priceText = adminEurosFromAmount((p.amount_cents || 0) / 100) + ' ' + (p.currency || 'EUR') +
    ' · ' + portalT('admin.privateLessons.perSession');
  var durationText = String(p.default_duration_minutes != null ? p.default_duration_minutes : 120) + ' ' + portalT('admin.privateLessons.minutes');
  var html = '<div class="portal-admin-lesson-facts">' +
    '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.privateLessons.enabled')) + '<strong>' + escHtml(enabledText) + '</strong></div>' +
    '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.edit.displayName')) + '<strong>' + escHtml(p.label || '—') + '</strong></div>' +
    '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.privateLessons.price')) + '<strong>' + escHtml(priceText) + '</strong></div>' +
    '<div class="portal-admin-lesson-fact">' + escHtml(portalT('admin.privateLessons.duration')) + '<strong>' + escHtml(durationText) + '</strong></div>';
  if (p.notes) {
    html += '<div class="portal-admin-lesson-fact" style="grid-column:1 / -1">' + escHtml(portalT('admin.privateLessons.notes')) +
      '<strong>' + escHtml(p.notes) + '</strong></div>';
  }
  return html + '</div>';
}
function renderAdminPrivateLessonCard(cfg, writes){
  var pl = (cfg && cfg.private_lesson) ? cfg.private_lesson : { enabled: false, label: portalT('admin.privateLessons.defaultName'), amount_cents: 0, currency: 'EUR', default_duration_minutes: 120, notes: '' };
  var editing = writes && adminEditTarget === 'private-lesson';
  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.privateLessons.title')) + '</h3>';
  if (writes && !editing && !adminLessonSectionEditing() && !adminPackSectionEditing()){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-private-lesson" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button></div>';
  }
  html += '</div></div><p class="portal-admin-muted">' + escHtml(portalT('admin.privateLessons.help')) + '</p>';
  html += '<article class="portal-admin-lesson-card" data-admin-private-lesson-card="1">';
  if (editing) html += renderAdminPrivateLessonEditForm(pl);
  else html += renderAdminPrivateLessonReadout(pl);
  html += '</article></div>';
  return html;
}
function renderAdminCourseEquipment(cfg, writes){
  var root = cfg && cfg.course_equipment_pricing || {};
  var during = root.during_course || { policy: 'free_with_course', surfboard_cents: 0, wetsuit_cents: 0 };
  var allDay = root.all_day || { surfboard_cents: 0, wetsuit_cents: 0 };
  var free = during.policy !== 'extra';
  function centsInput(id, label, value, disabled){
    return '<div class="portal-admin-edit-field"><label for="' + id + '">' + escHtml(label) + '</label>' +
      '<input id="' + id + '" type="number" inputmode="numeric" min="0" step="1" value="' + escHtml(String(disabled ? 0 : value || 0)) + '"' +
      (disabled ? ' disabled' : '') + ' aria-describedby="admin-course-equipment-basis"></div>';
  }
  var html = '<section class="portal-admin-subsection" data-admin-course-equipment="1" aria-labelledby="admin-course-equipment-title">' +
    '<h3 id="admin-course-equipment-title" class="portal-admin-subsection-title">' + escHtml(portalT('admin.courseEquipment.title')) + '</h3>' +
    '<p class="portal-admin-muted">' + escHtml(portalT('admin.courseEquipment.help')) + '</p>' +
    '<fieldset><legend>' + escHtml(portalT('admin.courseEquipment.during')) + '</legend>' +
    '<label class="portal-admin-touch"><input type="radio" name="admin-course-equipment-policy" data-admin-action="course-equipment-policy" value="free_with_course"' + (free ? ' checked' : '') + (writes ? '' : ' disabled') + '> ' + escHtml(portalT('admin.courseEquipment.free')) + '</label>' +
    '<label class="portal-admin-touch"><input type="radio" name="admin-course-equipment-policy" data-admin-action="course-equipment-policy" value="extra"' + (!free ? ' checked' : '') + (writes ? '' : ' disabled') + '> ' + escHtml(portalT('admin.courseEquipment.extra')) + '</label>' +
    '<div class="portal-admin-course-equipment-grid">' + centsInput('admin-course-during-board', portalT('admin.courseEquipment.surfboard'), during.surfboard_cents, free || !writes) + centsInput('admin-course-during-suit', portalT('admin.courseEquipment.wetsuit'), during.wetsuit_cents, free || !writes) + '</div></fieldset>' +
    '<fieldset><legend>' + escHtml(portalT('admin.courseEquipment.allDay')) + '</legend><div class="portal-admin-course-equipment-grid">' +
    centsInput('admin-course-all-day-board', portalT('admin.courseEquipment.surfboard'), allDay.surfboard_cents, !writes) + centsInput('admin-course-all-day-suit', portalT('admin.courseEquipment.wetsuit'), allDay.wetsuit_cents, !writes) + '</div></fieldset>' +
    '<p id="admin-course-equipment-basis" class="portal-admin-muted">' + escHtml(portalT('admin.courseEquipment.centsBasis')) + '</p>';
  if (writes) html += '<button type="button" class="btn btn-primary portal-admin-touch" data-admin-action="save-course-equipment">' + escHtml(portalT('admin.action.save')) + '</button>';
  return html + '</section>';
}

function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  var packs = (cfg && cfg.surf_packs) ? cfg.surf_packs : [];
  var defaultCap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  box.innerHTML = renderAdminPackCards(packs, writes, defaultCap) + renderAdminPrivateLessonCard(cfg, writes) + renderAdminCourseEquipment(cfg, writes);
}

function renderAdminSectionBusinessInfoFromConfig(cfg){
  var box = el('admin-business-body');
  if (!box) return;
  var info = (cfg && cfg.business_info) ? cfg.business_info : {};
  var schoolName = (cfg && cfg.location_label) ? cfg.location_label : (info.name || portalT('demoHome.schoolName'));
  box.innerHTML = '<h1 class="portal-admin-school-heading">' + escHtml(schoolName) + '</h1>' +
    '<div class="portal-admin-school-heading-sub">' + escHtml(portalT('admin.business.activeSchoolHint')) + '</div>';
}

function renderAdminSectionChangeHistoryFromConfig(cfg){
  var box = el('admin-history-body');
  if (!box) return;
  var rows = (cfg && cfg.change_history) ? cfg.change_history.slice(0, 10) : [];
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
  if (banner) banner.style.display = 'none';
}

/**
 * Re-render Pricing sections from config.
 * @param {object} cfg
 * @param {{preserveDraft?: boolean}} [opts] When preserveDraft is true, snapshot form
 *   field values before replace and restore onto matching controls after render.
 *   Call sites must pass this explicitly (never guessed). Successful save / canonical
 *   refresh / Admin reopen omit it so server truth wins and stale drafts are cleared.
 */
function renderAdminFromConfig(cfg, opts){
  opts = opts || {};
  var preserve = !!(opts && opts.preserveDraft);
  if (preserve) adminSnapshotPricingDraftState();
  else adminClearPricingDraftState();
  renderAdminWriteState(cfg);
  if (typeof renderAdminSchoolContext === 'function') renderAdminSchoolContext(cfg);
  try { renderAdminSectionLessonTimesFromConfig(cfg); } catch (err) { console.error('admin lessons render failed', err); }
  try { renderAdminSectionPricesFromConfig(cfg); } catch (err) { console.error('admin prices render failed', err); }
  if (preserve) adminRestorePricingDraftState();
}

function renderAdminFallback(profile){
  adminEditTarget = null;
  adminClearPricingDraftState();
  renderAdminWriteState(null);
  var fallbackLocation = getClient() === 'sunset' ? getSunsetLocation() : null;
  if (typeof renderAdminSchoolContext === 'function') {
    renderAdminSchoolContext({
      location_id: fallbackLocation,
      location_label: fallbackLocation ? getSunsetLocationLabel(fallbackLocation) : null,
    });
  }
  renderAdminSectionLessonTimesFromConfig({ lesson_times: (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [], lesson_capacity: { default_daily_cap: SUNSET_SCHEDULE_LESSON_DAY_CAP } });
  renderAdminSectionPricesFromConfig(null);
}

function renderAdminLoadingShell(profile){
  // Do not leave the Admin page blank while the DB-backed config request is in flight.
  // Render the safe local fallback immediately; the real config replaces it when loaded.
  renderAdminFallback(profile);
}

/**
 * Finance shell — Sunset-only V1. All money math is server-computed; the browser
 * only formats cents for display (no client-side financial calculations). Other
 * clients keep the honest "not available" message.
 */
function renderAdminFinanceShell(){
  var body = el('admin-finance-body');
  if (!body) return;
  // Static, fetch-free placeholder painted during admin config load. The live
  // summary is loaded separately (loadAdminFinanceSummary) from the admin
  // open/reload path so it never inflates config-load fetch accounting.
  body.innerHTML = '<div class="portal-admin-finance-unavailable"><p>' +
    escHtml(portalT('admin.finance.summaryUnavailable')) + '</p></div>';
}

// Generation guard: a superseded load (e.g. after a school/location change) must
// never paint stale numbers over a newer request.
var financeLoadSeq = 0;

function loadAdminFinanceSummary(){
  var body = el('admin-finance-body');
  if (!body) return;
  var seq = ++financeLoadSeq;
  var originClient = getClient();
  var originLocation = originClient === 'sunset' ? getSunsetLocation() : '';
  body.innerHTML = '<div class="portal-admin-finance-loading" role="status">' +
    escHtml(portalT('admin.finance.loading')) + '</div>';
  var url = '/staff/admin/finance/summary' + adminClientQuery();
  var timeoutId = null;
  var timeout = new Promise(function(_, reject){
    timeoutId = setTimeout(function(){ reject(new Error('timeout')); }, 8000);
  });
  function clearFinanceTimeout(){ if (timeoutId != null){ clearTimeout(timeoutId); timeoutId = null; } }
  try {
    var request = fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
    Promise.race([request, timeout])
      .then(function(data){
        clearFinanceTimeout();
        if (seq !== financeLoadSeq || getClient() !== originClient || (originClient === 'sunset' && getSunsetLocation() !== originLocation)) return; // stale response, ignore
        if (!data || data.success !== true || !data.summary){
          return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
        }
        body.innerHTML = renderFinanceSummaryHtml(data.summary);
      })
      .catch(function(e){
        clearFinanceTimeout();
        if (seq !== financeLoadSeq || getClient() !== originClient || (originClient === 'sunset' && getSunsetLocation() !== originLocation)) return; // stale
        body.innerHTML = renderFinanceErrorHtml();
        wireFinanceRetry();
      });
  } catch (syncErr){
    clearFinanceTimeout();
    if (seq !== financeLoadSeq || getClient() !== originClient || (originClient === 'sunset' && getSunsetLocation() !== originLocation)) return;
    body.innerHTML = renderFinanceErrorHtml();
    wireFinanceRetry();
  }
}

function loadAdminFinanceForCurrentScope(){
  // Scope changes invalidate any in-flight response even when the destination
  // tenant has no Finance endpoint. This request is separate from config loads.
  ++financeLoadSeq;
  if (getClient() === 'sunset') loadAdminFinanceSummary();
}

function wireFinanceRetry(){
  var btn = el('admin-finance-retry');
  if (btn && btn.dataset.financeWired !== '1'){
    btn.dataset.financeWired = '1';
    btn.addEventListener('click', function(){ loadAdminFinanceSummary(); });
  }
}

// Display-only: format integer cents as EUR. Not a financial calculation (no
// deriving totals) — /100 is currency unit display.
function financeFmtEur(cents){
  var n = (typeof cents === 'number' && isFinite(cents)) ? cents : 0;
  var lang = (typeof portalLang === 'string' && portalLang) ? portalLang : 'en';
  try {
    return new Intl.NumberFormat(lang, { style: 'currency', currency: 'EUR' }).format(n / 100);
  } catch (_){
    return '€' + (n / 100).toFixed(2);
  }
}

function financePeriodEmpty(p){
  return !p || (p.booked_cents === 0 && p.collected_gross_cents === 0 && p.outstanding_cents === 0 && p.bookings_count === 0);
}

function financeMetricRow(label, valueHtml){
  return '<div class="pf-metric"><span class="pf-metric-label">' + escHtml(label) +
    '</span><span class="pf-metric-value">' + valueHtml + '</span></div>';
}

function financeCard(titleKey, period){
  var p = period || { booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 };
  return '<section class="pf-card"><h4 class="pf-card-title">' + escHtml(portalT(titleKey)) + '</h4>' +
    financeMetricRow(portalT('admin.finance.booked'), escHtml(financeFmtEur(p.booked_cents))) +
    financeMetricRow(portalT('admin.finance.collectedGross'), escHtml(financeFmtEur(p.collected_gross_cents))) +
    financeMetricRow(portalT('admin.finance.outstanding'), escHtml(financeFmtEur(p.outstanding_cents))) +
    financeMetricRow(portalT('admin.finance.bookings'), escHtml(String(p.bookings_count || 0))) +
    '</section>';
}

function renderFinanceTrendHtml(trend){
  if (!trend || !trend.length) return '';
  var rows = '';
  for (var i = 0; i < trend.length; i++){
    var d = trend[i];
    rows += '<li class="pf-trend-row"><span class="pf-trend-date">' + escHtml(String(d.date)) + '</span>' +
      '<span class="pf-trend-booked">' + escHtml(financeFmtEur(d.booked_cents)) + '</span>' +
      '<span class="pf-trend-collected">' + escHtml(financeFmtEur(d.collected_gross_cents)) + '</span></li>';
  }
  return '<section class="pf-trend"><h4 class="pf-trend-title">' + escHtml(portalT('admin.finance.trendTitle')) +
    '</h4><ul class="pf-trend-list">' + rows + '</ul></section>';
}

function renderFinanceErrorHtml(){
  return '<div class="portal-admin-finance-error" role="alert"><p>' + escHtml(portalT('admin.finance.error')) + '</p>' +
    '<button type="button" id="admin-finance-retry" class="portal-admin-finance-retry">' +
    escHtml(portalT('admin.finance.retry')) + '</button></div>';
}

/** Pure renderer for a server-computed summary. No money arithmetic here. */
function renderFinanceSummaryHtml(summary){
  if (!summary || !summary.periods){
    return '<div class="portal-admin-finance-unavailable"><p>' +
      escHtml(portalT('admin.finance.summaryUnavailable')) + '</p></div>';
  }
  var p = summary.periods;
  var html = '<div class="portal-admin-finance">';
  html += '<p class="pf-gross-note">' + escHtml(portalT('admin.finance.grossNote')) + '</p>';
  if (financePeriodEmpty(p.today) && financePeriodEmpty(p.week) && financePeriodEmpty(p.month)){
    html += '<div class="portal-admin-finance-empty"><p>' + escHtml(portalT('admin.finance.empty')) + '</p></div>';
  } else {
    html += '<div class="pf-cards">' +
      financeCard('admin.finance.today', p.today) +
      financeCard('admin.finance.week', p.week) +
      financeCard('admin.finance.month', p.month) +
      '</div>';
    html += renderFinanceTrendHtml(summary.daily_trend);
  }
  html += '</div>';
  return html;
}

/**
 * Switch Admin sub-tab (finance | pricing | luna-staff). Does not re-render Pricing content —
 * in-memory draft state is retained until Admin reload.
 * @param {string} key
 * @param {{focus?: boolean}} [opts]
 */
function adminSelectSubTab(key, opts){
  var next = (key === 'pricing' || key === 'luna-staff') ? key : 'finance';
  adminActiveSubTab = next;
  var tabs = document.querySelectorAll('#admin-subtab-list [data-admin-tab]');
  var i;
  for (i = 0; i < tabs.length; i++){
    var tab = tabs[i];
    var tabKey = tab.getAttribute('data-admin-tab');
    var selected = tabKey === next;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.setAttribute('tabindex', selected ? '0' : '-1');
    tab.classList.toggle('is-selected', selected);
    if (selected && opts && opts.focus && typeof tab.focus === 'function') tab.focus();
  }
  var finPanel = el('admin-panel-finance');
  var prPanel = el('admin-panel-pricing');
  var lunaAdminPanel = el('admin-panel-luna-staff');
  var lunaPanel = el('tab-ask-luna');
  if (finPanel){
    if (next === 'finance') finPanel.removeAttribute('hidden');
    else finPanel.setAttribute('hidden', '');
  }
  if (prPanel){
    if (next === 'pricing') prPanel.removeAttribute('hidden');
    else prPanel.setAttribute('hidden', '');
  }
  if (lunaAdminPanel){
    if (next === 'luna-staff') lunaAdminPanel.removeAttribute('hidden');
    else lunaAdminPanel.setAttribute('hidden', '');
  }
  if (lunaPanel) lunaPanel.classList.toggle('active', next === 'luna-staff');
  if (next === 'luna-staff' && typeof wireLunaStaffTabCards === 'function') wireLunaStaffTabCards();
}

function wireAdminSubTabs(){
  var list = el('admin-subtab-list');
  if (!list || list.dataset.adminSubtabsWired === '1') return;
  list.dataset.adminSubtabsWired = '1';

  function tabButtons(){
    return Array.prototype.slice.call(list.querySelectorAll('[role="tab"][data-admin-tab]'));
  }

  function selectByIndex(idx, focus){
    var tabs = tabButtons();
    if (!tabs.length) return;
    var n = ((idx % tabs.length) + tabs.length) % tabs.length;
    var key = tabs[n].getAttribute('data-admin-tab') || 'finance';
    adminSelectSubTab(key, { focus: !!focus });
  }

  list.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-tab]') : null;
    if (!btn || !list.contains(btn)) return;
    ev.preventDefault();
    adminSelectSubTab(btn.getAttribute('data-admin-tab') || 'finance', { focus: true });
  });

  list.addEventListener('keydown', function(ev){
    var target = ev.target;
    if (!target || !target.getAttribute || !target.getAttribute('data-admin-tab')) return;
    if (!list.contains(target)) return;
    var tabs = tabButtons();
    if (!tabs.length) return;
    var idx = tabs.indexOf(target);
    if (idx < 0) idx = 0;
    var key = ev.key;
    if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'Home' || key === 'End'){
      ev.preventDefault();
      if (key === 'ArrowRight') selectByIndex(idx + 1, true);
      else if (key === 'ArrowLeft') selectByIndex(idx - 1, true);
      else if (key === 'Home') selectByIndex(0, true);
      else if (key === 'End') selectByIndex(tabs.length - 1, true);
    }
  });
}

/**
 * Load Admin config into Pricing panels.
 * @param {{resetSubTab?: boolean}} [opts] resetSubTab=true when Admin is opened/re-entered
 *   (Finance default). Config save reloads keep the current sub-tab so Pricing drafts are not
 *   silently discarded by a forced Finance switch.
 */
function loadAdminTab(opts){
  opts = opts || {};
  wireAdminTab();
  wireAdminSubTabs();
  if (opts.resetSubTab) {
    adminActiveSubTab = 'finance';
    // Deliberate Admin reopen/reload — drop any in-memory Pricing drafts.
    adminClearPricingDraftState();
  }
  if (adminActiveSubTab !== 'pricing' && adminActiveSubTab !== 'finance' && adminActiveSubTab !== 'luna-staff') adminActiveSubTab = 'finance';
  adminSelectSubTab(adminActiveSubTab);
  renderAdminFinanceShell();
  var profile = getPortalProfile(getClient());
  // Canonical load generation: supersede prior keep-edit/load/mutation and own busy so a
  // stale handler cannot leave Admin permanently blocked when it cannot release.
  var loadSeq = adminBeginOp();
  if (!profile.is_surf_vertical) {
    adminReleaseBusy(loadSeq);
    return;
  }
  var state = el('admin-fetch-state');
  renderAdminLoadingShell(profile);
  if (state){ state.textContent = portalT('admin.loading'); state.style.display = 'none'; state.classList.remove('error'); }
  var url = '/staff/admin/config' + adminClientQuery();
  // Cancellable timeout: a settled race must not leave a late reject as unhandled.
  var timeoutId = null;
  var timeout = new Promise(function(_, reject){
    timeoutId = setTimeout(function(){ reject(new Error('request timeout')); }, 8000);
  });
  function clearAdminLoadTimeout(){
    if (timeoutId != null){
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }
  // try/catch: synchronous fetch throw bypasses Promise.race .catch and would leave
  // this load owning busy permanently. Only the owning token may release.
  try {
    var request = fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
    Promise.race([request, timeout])
      .then(function(data){
        clearAdminLoadTimeout();
        if (loadSeq !== adminLoadSeq) return;
        if (!data || data.success !== true) return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
        adminConfigCache = data;
        if (!adminCfgWritesEnabled(data)) adminEditTarget = null;
        // Canonical config load — server truth, no draft replay.
        renderAdminFromConfig(data);
        adminSelectSubTab(adminActiveSubTab || 'finance');
        if (state) state.style.display = 'none';
        adminReleaseBusy(loadSeq);
      })
      .catch(function(e){
        clearAdminLoadTimeout();
        if (loadSeq !== adminLoadSeq) return;
        adminConfigCache = null;
        adminEditTarget = null;
        adminClearPricingDraftState();
        renderAdminFallback(profile);
        adminSelectSubTab(adminActiveSubTab || 'finance');
        if (state){
          state.textContent = portalT('admin.error') + ' ' + e.message;
          state.className = 'state-msg error';
          state.style.display = 'block';
        }
        adminReleaseBusy(loadSeq);
      });
  } catch (syncErr) {
    clearAdminLoadTimeout();
    if (loadSeq !== adminLoadSeq) return;
    adminConfigCache = null;
    adminEditTarget = null;
    adminClearPricingDraftState();
    renderAdminFallback(profile);
    adminSelectSubTab(adminActiveSubTab || 'finance');
    if (state){
      state.textContent = portalT('admin.error') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr));
      state.className = 'state-msg error';
      state.style.display = 'block';
    }
    adminReleaseBusy(loadSeq);
  }
}

function wireAdminTab(){
  var root = el('tab-admin');
  if (!root || root.dataset.adminWired === '1') return;
  root.dataset.adminWired = '1';
  root.addEventListener('click', function(ev){
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;
    if (!btn || adminSaveBusy) return;
    var action = btn.getAttribute('data-admin-action');
    if (action !== 'course-equipment-policy') ev.preventDefault();
    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
      return;
    }
    if (action === 'course-equipment-policy'){
      var isFree = btn.value === 'free_with_course';
      root.querySelectorAll('input[name="admin-course-equipment-policy"]').forEach(function(radio){ radio.checked = radio === btn; });
      ['admin-course-during-board', 'admin-course-during-suit'].forEach(function(id){
        var input = el(id); if (input){ input.disabled = isFree; if (isFree) input.value = '0'; }
      });
      return;
    }
    if (action === 'save-course-equipment'){
      if (!adminCfgWritesEnabled(cfg)) return;
      function readCents(id){ var n = Number(el(id) && el(id).value); return Number.isSafeInteger(n) && n >= 0 ? n : null; }
      var policyEl = root.querySelector('input[name="admin-course-equipment-policy"]:checked');
      var policy = policyEl && policyEl.value === 'extra' ? 'extra' : 'free_with_course';
      var payload = { during_course: { policy: policy, surfboard_cents: policy === 'extra' ? readCents('admin-course-during-board') : 0, wetsuit_cents: policy === 'extra' ? readCents('admin-course-during-suit') : 0 }, all_day: { surfboard_cents: readCents('admin-course-all-day-board'), wetsuit_cents: readCents('admin-course-all-day-suit') } };
      if (payload.during_course.surfboard_cents == null || payload.during_course.wetsuit_cents == null || payload.all_day.surfboard_cents == null || payload.all_day.wetsuit_cents == null){ adminShowMessage('error', portalT('admin.courseEquipment.invalid')); return; }
      var op = adminBeginOp();
      adminApiRequest('PATCH', '/staff/admin/config/course-equipment' + adminClientQuery(), payload).then(function(resp){
        if (!adminOpStillOwns(op)) return;
        if (resp.status !== 200 || !resp.data || resp.data.success !== true) throw new Error(portalT('admin.courseEquipment.saveError'));
        adminConfigCache.course_equipment_pricing = resp.data.course_equipment_pricing;
        // This focused save must not discard unrelated unsaved Pricing edits.
        renderAdminFromConfig(adminConfigCache, { preserveDraft: true }); adminShowMessage('success', portalT('admin.courseEquipment.saved')); adminReleaseBusy(op);
      }).catch(function(){ if (!adminOpStillOwns(op)) return; adminShowMessage('error', portalT('admin.courseEquipment.saveError')); adminReleaseBusy(op); });
      return;
    }
    if (action === 'toggle-pill'){
      var row = btn.closest('.portal-admin-pill-row');
      var multi = row && row.getAttribute('data-admin-pill-multi') === '1';
      if (!row) return;
      if (!multi){
        if (btn.classList.contains('is-selected')){
          btn.classList.remove('is-selected');
        } else {
          row.querySelectorAll('.portal-admin-pill').forEach(function(p){ p.classList.remove('is-selected'); });
          btn.classList.add('is-selected');
        }
      } else {
        btn.classList.toggle('is-selected');
      }
      return;
    }
    if (action === 'add-pack-tier'){
      var addPfx = btn.getAttribute('data-tier-prefix');
      var tierWrap = addPfx ? el(addPfx + '-tier-rows') : null;
      if (!tierWrap) return;
      var curRows = adminReadPackTierRows(addPfx);
      curRows.push({ key: '1_day', amount: '' });
      tierWrap.innerHTML = adminRenderPackTierRowsHtml(curRows);
      return;
    }
    if (action === 'remove-pack-tier'){
      var tierRow = btn.closest ? btn.closest('[data-pack-tier-row]') : null;
      if (tierRow && tierRow.parentNode) tierRow.parentNode.removeChild(tierRow);
      return;
    }
    if (action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'save-price-group' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-new-price' || action === 'save-time' || action === 'save-new-time' || action === 'add-pack' || action === 'edit-pack' || action === 'delete-pack' || action === 'save-pack' || action === 'save-new-pack' || action === 'edit-private-lesson' || action === 'save-private-lesson' || action === 'toggle-group-availability' || action === 'add-equipment' || action === 'edit-equipment' || action === 'add-equip-price' || action === 'save-new-equipment' || action === 'save-price-amount'){
      if (!adminCfgWritesEnabled(cfg)) return;
    }
    if (action === 'toggle-group-availability'){
      var toggleRentalGroup = String(btn.getAttribute('data-rental-group') || '');
      var toggleActive = !!(btn.checked);
      if (!toggleRentalGroup){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var toggleOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('POST', '/staff/admin/config/prices/group-availability' + adminClientQuery(), {
            rental_group: toggleRentalGroup,
            active: toggleActive,
          })
        .then(function(res){
          if (!adminOpStillOwns(toggleOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(toggleOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            adminReloadConfig();
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedPrice'));
          adminReleaseBusy(toggleOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(toggleOpSeq)) return;
          adminReleaseBusy(toggleOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
          adminReloadConfig();
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(toggleOpSeq)) return;
        adminReleaseBusy(toggleOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
        adminReloadConfig();
      }
      return;
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
    if (action === 'edit-price-group'){
      adminEditTarget = 'price-group:' + String(btn.getAttribute('data-price-group') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-equipment'){
      adminEditTarget = 'equip-add-item';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-equipment'){
      adminEditTarget = 'equip:' + String(btn.getAttribute('data-equip-key') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-equip-price'){
      adminEditTarget = 'equip-add-price:' + String(btn.getAttribute('data-equip-key') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-price'){
      adminEditTarget = 'price-add:' + String(btn.getAttribute('data-price-group') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-price'){
      var deletePriceId = String(btn.getAttribute('data-price-id') || '');
      if (!deletePriceId || !window.confirm(portalT('admin.edit.confirmRemovePrice'))) return;
      var keepGroupEdit = adminEditTarget && String(adminEditTarget).indexOf('price-group:') === 0 ? adminEditTarget : null;
      var deletePriceOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('DELETE', '/staff/admin/config/prices/' + encodeURIComponent(deletePriceId) + adminClientQuery(), {})
        .then(function(res){
          if (!adminOpStillOwns(deletePriceOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(deletePriceOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPrice'));
          adminReleaseBusy(deletePriceOpSeq);
          adminReloadConfigKeepingEdit(keepGroupEdit);
        }).catch(function(err){
          if (!adminOpStillOwns(deletePriceOpSeq)) return;
          adminReleaseBusy(deletePriceOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(deletePriceOpSeq)) return;
        adminReleaseBusy(deletePriceOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'edit-time'){
      adminEditTarget = 'time:' + String(btn.getAttribute('data-time-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'add-time'){
      adminEditTarget = 'time:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'delete-time'){
      var deleteTimeId = String(btn.getAttribute('data-time-id') || '');
      if (!deleteTimeId || !window.confirm(portalT('admin.edit.confirmRemoveLesson'))) return;
      var deleteTimeOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('DELETE', '/staff/admin/config/lesson-times/' + encodeURIComponent(deleteTimeId) + adminClientQuery(), {})
        .then(function(res){
          if (!adminOpStillOwns(deleteTimeOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(deleteTimeOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedTime'));
          adminReleaseBusy(deleteTimeOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(deleteTimeOpSeq)) return;
          adminReleaseBusy(deleteTimeOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(deleteTimeOpSeq)) return;
        adminReleaseBusy(deleteTimeOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-capacity'){
      var capInput = el('admin-capacity-input');
      var capParsed = adminParseCapacity(capInput && capInput.value);
      if (!capParsed.ok){ adminShowMessage('error', capParsed.error); return; }
      var saveCapOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PUT', '/staff/admin/config/lesson-capacity' + adminClientQuery(), { default_daily_cap: capParsed.value })
        .then(function(res){
          if (!adminOpStillOwns(saveCapOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(saveCapOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedCapacity'));
          adminReleaseBusy(saveCapOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveCapOpSeq)) return;
          adminReleaseBusy(saveCapOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveCapOpSeq)) return;
        adminReleaseBusy(saveCapOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-price-group'){
      var saveGroup = String(btn.getAttribute('data-price-group') || '');
      var grid = el('admin-prices-card-grid-' + saveGroup);
      if (!grid){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var cards = grid.querySelectorAll('[data-admin-price-card]');
      var jobs = [];
      var validationError = '';
      cards.forEach(function(card){
        var pid = card.getAttribute('data-admin-price-card');
        if (!pid) return;
        var periodInput = card.querySelector('[data-admin-price-field="period"]');
        var amountInput = card.querySelector('[data-admin-price-field="amount"]');
        var period = periodInput ? String(periodInput.value || '').trim() : '';
        if (!period || !adminIsCanonicalRentalPeriod(period)){ validationError = portalT('admin.edit.periodRequired'); return; }
        var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
        if (!centsParsed.ok){ validationError = centsParsed.error; return; }
        // availability is now controlled at group level — omit active from per-duration patch
        jobs.push(adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(pid) + adminClientQuery(), {
          period_window: period,
          amount_cents: centsParsed.value,
        }));
      });
      if (validationError){ adminShowMessage('error', validationError); return; }
      if (!jobs.length){ adminShowMessage('error', portalT('admin.prices.emptyCategory')); return; }
      var saveGroupOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        Promise.all(jobs)
        .then(function(results){
          if (!adminOpStillOwns(saveGroupOpSeq)) return;
          var failed = results.find(function(res){ return res.status !== 200 || !res.data || res.data.success !== true; });
          if (failed){
            adminReleaseBusy(saveGroupOpSeq);
            adminShowMessage('error', (failed.data && (failed.data.message || failed.data.error)) || ('HTTP ' + failed.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedPrice'));
          adminReleaseBusy(saveGroupOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveGroupOpSeq)) return;
          adminReleaseBusy(saveGroupOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveGroupOpSeq)) return;
        adminReleaseBusy(saveGroupOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }

    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var periodInput = el('admin-price-period-' + priceId);
      var amountInput = el('admin-price-amount-' + priceId);
      var availableInput = el('admin-price-available-' + priceId);
      var period = periodInput ? String(periodInput.value || '').trim() : '';
      if (!period){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      var available = availableInput ? !!availableInput.checked : true;
      if (available && !(centsParsed.value > 0)){
        adminShowMessage('error', portalT('admin.edit.amountRequiredToEnable'));
        return;
      }
      var savePriceOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
            period_window: period,
            amount_cents: centsParsed.value,
            active: available,
          })
        .then(function(res){
          if (!adminOpStillOwns(savePriceOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(savePriceOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedPrice'));
          adminReleaseBusy(savePriceOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(savePriceOpSeq)) return;
          adminReleaseBusy(savePriceOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(savePriceOpSeq)) return;
        adminReleaseBusy(savePriceOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-new-price'){
      var addPriceKey = String(btn.getAttribute('data-equip-key') || '').trim();
      if (!addPriceKey){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var addDur = adminReadDurationControl('admin-new-price');
      if (!addDur.duration_key){ adminShowMessage('error', portalT('admin.prices.invalidDuration') || 'Enter a valid duration'); return; }
      var addAmountInput = el('admin-new-price-amount');
      var addCents = adminParseEurosToCents(addAmountInput && addAmountInput.value);
      if (!addCents.ok){ adminShowMessage('error', addCents.error); return; }
      if (!(addCents.value > 0)){ adminShowMessage('error', portalT('admin.edit.amountRequiredToEnable')); return; }
      var saveNewPriceOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('POST', '/staff/admin/config/prices' + adminClientQuery(), {
            offering_key: addPriceKey,
            period_window: addDur.duration_key,
            amount_cents: addCents.value,
          })
        .then(function(res){
          if (!adminOpStillOwns(saveNewPriceOpSeq)) return;
          if ((res.status !== 201 && res.status !== 200) || !res.data || res.data.success !== true){
            adminReleaseBusy(saveNewPriceOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.addedPrice'));
          adminReleaseBusy(saveNewPriceOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveNewPriceOpSeq)) return;
          adminReleaseBusy(saveNewPriceOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveNewPriceOpSeq)) return;
        adminReleaseBusy(saveNewPriceOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-price-amount'){
      var spPriceId = String(btn.getAttribute('data-price-id') || '');
      if (!spPriceId){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var spAmountInput = el('admin-price-amount-' + adminPriceInputKey(spPriceId));
      var spCents = adminParseEurosToCents(spAmountInput && spAmountInput.value);
      if (!spCents.ok){ adminShowMessage('error', spCents.error); return; }
      if (!(spCents.value > 0)){ adminShowMessage('error', portalT('admin.edit.amountRequiredToEnable')); return; }
      var spOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(spPriceId) + adminClientQuery(), {
            amount_cents: spCents.value,
          })
        .then(function(res){
          if (!adminOpStillOwns(spOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(spOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedPrice'));
          adminReleaseBusy(spOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(spOpSeq)) return;
          adminReleaseBusy(spOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(spOpSeq)) return;
        adminReleaseBusy(spOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-new-equipment'){
      var eqNameInput = el('admin-new-equip-name');
      var eqName = eqNameInput ? String(eqNameInput.value || '').trim() : '';
      if (!eqName){ adminShowMessage('error', portalT('admin.prices.equipmentNameRequired') || 'Enter an equipment name'); return; }
      var eqKey = adminSlugOfferingKey(eqName);
      if (!eqKey){ adminShowMessage('error', portalT('admin.prices.equipmentNameRequired') || 'Enter an equipment name'); return; }
      var eqDur = adminReadDurationControl('admin-new-equip');
      if (!eqDur.duration_key){ adminShowMessage('error', portalT('admin.prices.invalidDuration') || 'Enter a valid duration'); return; }
      var eqAmountInput = el('admin-new-equip-amount');
      var eqCents = adminParseEurosToCents(eqAmountInput && eqAmountInput.value);
      if (!eqCents.ok){ adminShowMessage('error', eqCents.error); return; }
      if (!(eqCents.value > 0)){ adminShowMessage('error', portalT('admin.edit.amountRequiredToEnable')); return; }
      var eqOpSeq = adminBeginOp();
      adminShowMessage('', '');
      // 1) create the catalog offering (so it can also be booked), then 2) its first price.
      var createOffering = adminApiRequest('POST', '/staff/admin/config/rental-offerings' + adminClientQuery(), {
        offering_key: eqKey, label: eqName, group_key: 'equipment', excludes: [],
      });
      createOffering.then(function(offRes){
        if (!adminOpStillOwns(eqOpSeq)) return null;
        // 409 = offering already exists — fine, proceed to add the price.
        if (offRes.status !== 201 && offRes.status !== 200 && offRes.status !== 409){
          adminReleaseBusy(eqOpSeq);
          adminShowMessage('error', (offRes.data && (offRes.data.error || offRes.data.message)) || ('HTTP ' + offRes.status));
          return null;
        }
        return adminApiRequest('POST', '/staff/admin/config/prices' + adminClientQuery(), {
          offering_key: eqKey, period_window: eqDur.duration_key, amount_cents: eqCents.value,
        });
      }).then(function(priceRes){
        if (priceRes === null || !adminOpStillOwns(eqOpSeq)) return;
        if ((priceRes.status !== 201 && priceRes.status !== 200) || !priceRes.data || priceRes.data.success !== true){
          adminReleaseBusy(eqOpSeq);
          adminShowMessage('error', (priceRes.data && (priceRes.data.message || priceRes.data.error)) || ('HTTP ' + priceRes.status));
          return;
        }
        adminEditTarget = null;
        adminShowMessage('success', portalT('admin.edit.addedPrice'));
        adminReleaseBusy(eqOpSeq);
        adminReloadConfig();
      }).catch(function(err){
        if (!adminOpStillOwns(eqOpSeq)) return;
        adminReleaseBusy(eqOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
      return;
    }
    if (action === 'save-time'){
      var timeId = String(btn.getAttribute('data-time-id') || '');
      var labelInput = el('admin-time-label');
      var startInput = el('admin-time-start');
      var endInput = el('admin-time-end');
      var capInput = el('admin-time-capacity');
      var label = labelInput ? String(labelInput.value || '').trim() : '';
      if (!label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var timeParsed = adminParseTimeHm(startInput && startInput.value);
      if (!timeParsed.ok){ adminShowMessage('error', timeParsed.error); return; }
      var endRaw = endInput ? String(endInput.value || '').trim() : '';
      var endParsed = { ok: true, value: null };
      if (endRaw){
        endParsed = adminParseTimeHm(endRaw);
        if (!endParsed.ok){ adminShowMessage('error', endParsed.error); return; }
        if (endParsed.value <= timeParsed.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
      }
      var capacityParsed = adminParseCapacity(capInput && capInput.value);
      if (!capacityParsed.ok){ adminShowMessage('error', capacityParsed.error); return; }
      var ageInput = el('admin-time-age');
      var freqInput = el('admin-time-frequency');
      var costInput = el('admin-time-cost');
      var costParsed = adminParseEurosToCents(costInput && costInput.value);
      if (!costParsed.ok){ adminShowMessage('error', costParsed.error); return; }
      var timePayload = {
        label: label,
        kind: 'lesson',
        age_band: ageInput ? String(ageInput.value || 'all_ages') : 'all_ages',
        frequency: freqInput ? String(freqInput.value || 'daily') : 'daily',
        time_local: timeParsed.value,
        capacity: capacityParsed.value,
        amount_cents: costParsed.value,
      };
      if (endParsed.value) timePayload.time_local_end = endParsed.value;
      var saveTimeOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), timePayload)
        .then(function(res){
          if (!adminOpStillOwns(saveTimeOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(saveTimeOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedTime'));
          adminReleaseBusy(saveTimeOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveTimeOpSeq)) return;
          adminReleaseBusy(saveTimeOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveTimeOpSeq)) return;
        adminReleaseBusy(saveTimeOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }

    if (action === 'add-pack'){
      adminEditTarget = 'pack:new';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-pack'){
      adminEditTarget = 'pack:' + String(btn.getAttribute('data-pack-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'edit-private-lesson'){
      adminEditTarget = 'private-lesson';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'save-private-lesson'){
      var enabledEl = el('admin-private-enabled');
      var labelEl = el('admin-private-label');
      var priceEl = el('admin-private-price');
      var durationEl = el('admin-private-duration');
      var notesEl = el('admin-private-notes');
      var labelText = String((labelEl && labelEl.value) || '').trim();
      if (!labelText){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var priceParsed = adminParseEurosToCents(priceEl && priceEl.value);
      if (!priceParsed.ok){ adminShowMessage('error', priceParsed.error || portalT('admin.edit.amountInvalid')); return; }
      var durationVal = parseInt(String((durationEl && durationEl.value) || '120'), 10);
      if (!Number.isInteger(durationVal) || durationVal < 15 || durationVal > 480){
        adminShowMessage('error', portalT('admin.privateLessons.durationInvalid'));
        return;
      }
      var payload = {
        enabled: !!(enabledEl && enabledEl.checked),
        label: labelText,
        amount_cents: priceParsed.value,
        currency: 'EUR',
        price_basis: 'per_session',
        default_duration_minutes: durationVal,
        notes: String((notesEl && notesEl.value) || '').trim(),
      };
      var savePrivateOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PUT', '/staff/admin/config/private-lesson' + adminClientQuery(), payload)
        .then(function(res){
          if (!adminOpStillOwns(savePrivateOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(savePrivateOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminEditTarget = null;
          adminShowMessage('success', portalT('admin.edit.savedPrivateLesson'));
          adminReleaseBusy(savePrivateOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(savePrivateOpSeq)) return;
          adminReleaseBusy(savePrivateOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(savePrivateOpSeq)) return;
        adminReleaseBusy(savePrivateOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      var deletePackOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          if (!adminOpStillOwns(deletePackOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(deletePackOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReleaseBusy(deletePackOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(deletePackOpSeq)) return;
          adminReleaseBusy(deletePackOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(deletePackOpSeq)) return;
        adminReleaseBusy(deletePackOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (payload._scheduleError){ adminShowMessage('error', payload._scheduleError); return; }
      delete payload._scheduleError;
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var savePackOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        (packId
            ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
            : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload))
        .then(function(res){
          if (!adminOpStillOwns(savePackOpSeq)) return;
          if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
            adminReleaseBusy(savePackOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
          adminReleaseBusy(savePackOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(savePackOpSeq)) return;
          adminReleaseBusy(savePackOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(savePackOpSeq)) return;
        adminReleaseBusy(savePackOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }

    if (action === 'save-new-time'){
      var newLabelInput = el('admin-new-time-label');
      var newStartInput = el('admin-new-time-start');
      var newEndInput = el('admin-new-time-end');
      var newLabel = newLabelInput ? String(newLabelInput.value || '').trim() : '';
      if (!newLabel){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var newStart = adminParseTimeHm(newStartInput && newStartInput.value);
      if (!newStart.ok){ adminShowMessage('error', newStart.error); return; }
      var newCapInput = el('admin-new-time-capacity');
      var newKindInput = el('admin-new-time-kind');
      var newAgeInput = el('admin-new-time-age');
      var newFreqInput = el('admin-new-time-frequency');
      var newCostInput = el('admin-new-time-cost');
      var newCapParsed = adminParseCapacity(newCapInput && newCapInput.value);
      if (!newCapParsed.ok){ adminShowMessage('error', newCapParsed.error); return; }
      var newCostParsed = adminParseEurosToCents(newCostInput && newCostInput.value);
      if (!newCostParsed.ok){ adminShowMessage('error', newCostParsed.error); return; }
      var payload = {
        label: newLabel,
        kind: 'lesson',
        age_band: newAgeInput ? String(newAgeInput.value || 'all_ages') : 'all_ages',
        frequency: newFreqInput ? String(newFreqInput.value || 'daily') : 'daily',
        time_local: newStart.value,
        capacity: newCapParsed.value,
        amount_cents: newCostParsed.value,
        active: true,
      };
      var newEndRaw = newEndInput ? String(newEndInput.value || '').trim() : '';
      if (newEndRaw){
        var newEnd = adminParseTimeHm(newEndRaw);
        if (!newEnd.ok){ adminShowMessage('error', newEnd.error); return; }
        if (newEnd.value <= newStart.value){ adminShowMessage('error', portalT('admin.edit.endAfterStart')); return; }
        payload.time_local_end = newEnd.value;
      }
      var saveNewTimeOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('POST', '/staff/admin/config/lesson-times' + adminClientQuery(), payload)
        .then(function(res){
          if (!adminOpStillOwns(saveNewTimeOpSeq)) return;
          if (res.status !== 201 || !res.data || res.data.success !== true){
            adminReleaseBusy(saveNewTimeOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.addedTime'));
          adminReleaseBusy(saveNewTimeOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveNewTimeOpSeq)) return;
          adminReleaseBusy(saveNewTimeOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveNewTimeOpSeq)) return;
        adminReleaseBusy(saveNewTimeOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
  });
}


