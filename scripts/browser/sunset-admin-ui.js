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

/**
 * Clear equipment-local write errors only (`[data-admin-equip-error]`).
 * Never touches shared `#admin-save-msg` — global Admin notices keep their own lifecycle.
 * Used at cancel / Admin subtab / top-level leave / client-change / fresh render boundaries
 * and before painting a new equipment error on the active card.
 */
function adminClearEquipErrors(){
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  var nodes = document.querySelectorAll('[data-admin-equip-error]');
  for (var i = 0; i < nodes.length; i++) {
    nodes[i].style.display = 'none';
    nodes[i].textContent = '';
    nodes[i].className = 'state-msg portal-admin-equip-error';
  }
}

/**
 * Show an error on the active equipment edit card (not a sticky global banner).
 * Does not erase unrelated `#admin-save-msg` content. Sibling equip hosts are cleared first.
 * Falls back to the global admin-save-msg only when the card host is missing.
 */
function adminShowEquipError(equipKey, text){
  var key = String(equipKey || '').trim();
  adminClearEquipErrors();
  var host = key
    ? (el('admin-equip-error-' + key)
      || (typeof document !== 'undefined' && document.querySelector
        ? document.querySelector('[data-admin-equip-error="' + key + '"]')
        : null))
    : null;
  if (host) {
    host.className = 'state-msg portal-admin-equip-error error';
    host.textContent = text || '';
    host.style.display = text ? 'block' : 'none';
    return;
  }
  adminShowMessage('error', text || '');
}

function adminEurosFromAmount(amount){
  var n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(2);
}
/** Readout money: leading €, never trailing "EUR" (avoids wrap + keeps cards tidy). */
function adminFormatEuroDisplay(amount){
  var s = adminEurosFromAmount(amount);
  if (!s) return '';
  return '€' + s;
}

/**
 * Strict euro text → integer cents (max 2 fraction digits, no float round).
 * Accepts "12", "12.5", "12.50", "12,50". Rejects negatives, >2 decimals, NaN.
 */
function adminParseEurosToCents(text){
  var s = String(text == null ? '' : text).trim();
  if (!s) return { ok: false, error: portalT('admin.edit.amountRequired') };
  s = s.replace(/[€$£\u00a0\s]/g, '');
  if (!s) return { ok: false, error: portalT('admin.edit.amountRequired') };
  if (s.charAt(0) === '+') s = s.slice(1);
  if (s.charAt(0) === '-') return { ok: false, error: portalT('admin.edit.amountInvalid') };
  // Locale: single comma with ≤2 trailing digits is decimal separator.
  var lastDot = s.lastIndexOf('.');
  var lastComma = s.lastIndexOf(',');
  var normalized = s;
  if (lastDot >= 0 && lastComma >= 0) {
    normalized = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    var fracC = s.slice(lastComma + 1);
    normalized = (/^\d{1,2}$/.test(fracC) && s.indexOf(',') === lastComma)
      ? s.replace(',', '.')
      : s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, error: portalT('admin.edit.amountInvalid') };
  }
  var parts = normalized.split('.');
  if (parts[1] != null && parts[1].length > 2) {
    return { ok: false, error: portalT('admin.edit.amountInvalid') };
  }
  var whole = parts[0] || '0';
  var frac = ((parts[1] || '') + '00').slice(0, 2);
  var cents = parseInt(whole, 10) * 100 + parseInt(frac, 10);
  if (!Number.isFinite(cents) || !Number.isInteger(cents) || cents < 0) {
    return { ok: false, error: portalT('admin.edit.amountInvalid') };
  }
  if (cents > Number.MAX_SAFE_INTEGER) {
    return { ok: false, error: portalT('admin.edit.amountInvalid') };
  }
  return { ok: true, value: cents };
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
    fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function(data){
        var gate = adminReloadKeepingEditOwnership(loadSeq, originSchoolKey, originEditTarget);
        if (!gate.apply) {
          adminReleaseBusy(loadSeq);
          return;
        }
        if (!data || data.success !== true) return Promise.reject(new Error('load failed'));
        // Refresh rental offerings (incl. inactive) so course dropdown + Enabled state stay authoritative.
        return fetch('/staff/admin/config/rental-offerings' + adminClientQuery() + '&include_inactive=true&_ts=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{Accept:'application/json'} })
          .then(function(r){ return r.ok ? r.json() : { offerings: [] }; }).catch(function(){ return { offerings: [] }; })
          .then(function(catalog){
            var gate2 = adminReloadKeepingEditOwnership(loadSeq, originSchoolKey, originEditTarget);
            if (!gate2.apply) {
              adminReleaseBusy(loadSeq);
              return;
            }
            data._equipment_offerings = catalog && Array.isArray(catalog.offerings) ? catalog.offerings : (data.rental_offerings || []);
            adminConfigCache = data;
            adminEditTarget = saved;
            // Keep unsaved Pricing field drafts while re-rendering for a kept edit target.
            renderAdminFromConfig(data, { preserveDraft: true });
            adminReleaseBusy(loadSeq);
          });
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
    equipment_options: [],
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
  return { label: portalT('admin.packs.defaultName'), equipment_options: [], age_band: d.age_band, group_size: d.group_size, beaches: d.beaches.slice(), weekly: d.weekly, schedules: d.schedules.slice(), price_tiers: d.price_tiers.map(function(t){ return Object.assign({}, t); }) };
}

/**
 * Exact offering ownership for a price row: canonical key is the segment before
 * the first `__` in item_code/offering_key. Never unescaped LIKE.
 */
function adminPriceOfferingKey(p){
  var code = String((p && (p.item_code != null ? p.item_code : p.offering_key)) || '').trim();
  if (!code) return '';
  return code.split('__')[0];
}

/**
 * True when cfg prices contain at least one active positive rental price for
 * the exact offering key. Used for commercial/bookable hints only — catalog
 * active state and course-equipment dropdown do NOT require a price.
 */
function adminOfferingHasActivePositivePrice(offeringKey, cfg){
  var key = String(offeringKey || '').trim();
  if (!key) return false;
  var prices = (cfg && cfg.prices) || (adminConfigCache && adminConfigCache.prices) || [];
  for (var i = 0; i < prices.length; i++){
    var p = prices[i];
    if (!p) continue;
    var cat = String(p.category || p.item_type || '').toLowerCase();
    if (cat && cat !== 'rental') continue;
    if (p.active === false) continue;
    var amt = p.amount_cents != null ? Number(p.amount_cents) : NaN;
    if (!(amt > 0)) continue;
    if (adminPriceOfferingKey(p) === key) return true;
  }
  return false;
}

/**
 * Course dropdown catalog: active rental offering identities for exact tenant/
 * location, regardless of standalone rental price rows. Course equipment owns
 * its own during-course/all-day prices. Disabled/deleted items absent.
 * No hardcoded item names/order — projection follows catalog order.
 */
function adminEquipmentOfferings(){
  return (adminConfigCache && adminConfigCache._equipment_offerings || adminConfigCache && adminConfigCache.rental_offerings || []).filter(function(o){
    return !!(o && o.active !== false);
  });
}
function adminAllEquipmentOfferings(){ return (adminConfigCache && adminConfigCache._equipment_offerings || adminConfigCache && adminConfigCache.rental_offerings || []).filter(function(o){ return !!o; }); }
function adminEquipmentRowsHtml(rows){
  var active=adminEquipmentOfferings(), selected={};
  var list = rows || [];
  list.forEach(function(r){if(r&&r.offering_key)selected[String(r.offering_key)]=true;});
  var addEqLabel = portalT('admin.courseEquipment.add') || 'Add equipment';
  return list.map(function(r,idx){
    var key=String(r.offering_key||''), exists=active.some(function(o){return String(o.offering_key)===key;});
    var opts='<option value="">'+escHtml(portalT('admin.courseEquipment.choose'))+'</option>';
    // Historical/unavailable: preserve selected disabled option — never silently rewrite.
    if(key&&!exists)opts+='<option value="'+escHtml(key)+'" selected disabled>'+escHtml(key+' — '+portalT('admin.courseEquipment.unavailable'))+'</option>';
    active.forEach(function(o){var k=String(o.offering_key||'');opts+='<option value="'+escHtml(k)+'"'+(k===key?' selected':'')+((selected[k]&&k!==key)?' disabled':'')+'>'+escHtml(o.label||o.display_name||k)+'</option>';});
    // Independent total unit prices (never surcharge/addition). Historical legacy pair
    // equipment_price_cents / all_day_surcharge_cents maps 1:1 to During / All Day.
    var duringCents = (r.during_course_price_cents != null)
      ? r.during_course_price_cents
      : (r.equipment_price_cents || 0);
    var allDayCents = (r.all_day_price_cents != null)
      ? r.all_day_price_cents
      : (r.all_day_surcharge_cents || 0);
    // Offering on its own row; then policy | During € | All Day € | × [+ on last row].
    // during_course_policy is explicit so optional €0 and unavailable are authorable.
    var removeEqLabel = portalT('admin.courseEquipment.remove') || 'Remove equipment';
    // Infer only when policy field is absent. Explicit invalid values are preserved
    // and fail save closed (never silently rewrite to included/optional).
    var hasExplicitPolicy = Object.prototype.hasOwnProperty.call(r, 'during_course_policy')
      && r.during_course_policy != null
      && String(r.during_course_policy).trim() !== '';
    var rawPolicy = hasExplicitPolicy ? String(r.during_course_policy).trim() : '';
    var policyValid = rawPolicy === 'included' || rawPolicy === 'optional' || rawPolicy === 'unavailable';
    var policyInvalid = hasExplicitPolicy && !policyValid;
    var policy = policyValid
      ? rawPolicy
      : (policyInvalid ? rawPolicy : ((Number(duringCents) === 0) ? 'included' : 'optional'));
    var policyOpts = '';
    if (policyInvalid) {
      policyOpts += '<option value="'+escHtml(rawPolicy)+'" selected disabled data-policy-invalid="1">'
        + escHtml(rawPolicy + ' — ' + (portalT('admin.courseEquipment.policyInvalid') || 'invalid'))
        + '</option>';
    }
    policyOpts += ['included', 'optional', 'unavailable'].map(function(p){
      var lab = p === 'included' ? portalT('admin.courseEquipment.policyIncluded')
        : (p === 'optional' ? portalT('admin.courseEquipment.policyOptional')
          : portalT('admin.courseEquipment.policyUnavailable'));
      var sel = (!policyInvalid && p === policy) ? ' selected' : '';
      return '<option value="'+p+'"'+sel+'>'+escHtml(lab)+'</option>';
    }).join('');
    var isLast = idx === list.length - 1;
    var actionsHtml = '<div class="portal-admin-equipment-row-actions">' +
      '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-danger portal-admin-equipment-remove" data-admin-action="remove-equipment-option" aria-label="'+escHtml(removeEqLabel)+'" title="'+escHtml(removeEqLabel)+'">×</button>' +
      (isLast
        ? '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-equipment-add" data-admin-action="add-equipment-option" aria-label="'+escHtml(addEqLabel)+'" title="'+escHtml(addEqLabel)+'">+</button>'
        : '') +
      '</div>';
    return '<div class="portal-admin-equipment-option-row" data-equipment-option-row="'+idx+'"'
      + (policyInvalid ? ' data-policy-explicit-invalid="1"' : '')
      + (hasExplicitPolicy ? ' data-policy-explicit="1"' : ' data-policy-absent="1"')
      + '>' +
      '<div class="portal-admin-equipment-offering-row">' +
      '<label class="portal-admin-equipment-offering-field">' +
      '<select class="admin-equipment-offering" aria-label="'+escHtml(portalT('admin.courseEquipment.choose'))+'">'+opts+'</select></label>' +
      '</div>' +
      '<div class="portal-admin-equipment-option-fields">' +
      '<label class="portal-admin-equipment-policy-field">'+escHtml(portalT('admin.courseEquipment.duringPolicy')) +
      '<select class="admin-equipment-during-policy" data-admin-action="course-equipment-policy"'
      + (policyInvalid ? ' data-policy-explicit-invalid="1"' : '')
      + ' aria-label="'+escHtml(portalT('admin.courseEquipment.duringPolicy'))+'">'+policyOpts+'</select></label>' +
      '<label class="portal-admin-equipment-price-field portal-admin-equipment-during-field">'+escHtml(portalT('admin.courseEquipment.duringPrice')) +
      '<input class="admin-equipment-during-price" inputmode="decimal" value="'+escHtml(adminEurosFromAmount((duringCents||0)/100))+'"></label>' +
      '<label class="portal-admin-equipment-price-field portal-admin-equipment-allday-field">'+escHtml(portalT('admin.courseEquipment.allDayPrice')) +
      '<input class="admin-equipment-all-day-price" inputmode="decimal" value="'+escHtml(adminEurosFromAmount((allDayCents||0)/100))+'"></label>' +
      actionsHtml +
      '</div></div>';
  }).join('');
}
function adminRenderEquipmentEditor(rows,prefix){
  // Heading keeps Equipment title. Empty state: compact + beside title.
  // Once items exist: + moves next to the last row's × (no heading +).
  var list = rows || [];
  var addEqLabel = portalT('admin.courseEquipment.add') || 'Add equipment';
  var threePrice = portalT('admin.courseEquipment.threePriceHelp') || '';
  var headingAdd = !list.length
    ? '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-equipment-add" data-admin-action="add-equipment-option" aria-label="'+escHtml(addEqLabel)+'" title="'+escHtml(addEqLabel)+'">+</button>'
    : '';
  return '<section class="portal-admin-equipment-editor" data-admin-equipment-editor="'+escHtml(prefix)+'">' +
    '<div class="portal-admin-equipment-heading-row" data-admin-equipment-heading>' +
    '<h4>'+escHtml(portalT('admin.courseEquipment.editorTitle'))+'</h4>' +
    headingAdd +
    '</div>' +
    (threePrice
      ? '<p class="portal-admin-equipment-three-price-help" data-admin-equipment-three-price-help="1">'+escHtml(threePrice)+'</p>'
      : '') +
    '<div data-equipment-option-rows>'+adminEquipmentRowsHtml(list)+'</div>' +
    '</section>';
}
function adminReadEquipmentOptions(root){
  var seen={},out=[],error='';
  Array.prototype.slice.call(root.querySelectorAll('[data-equipment-option-row]')).forEach(function(row){
    var key=String(row.querySelector('.admin-equipment-offering').value||'').trim();
    var duringEl=row.querySelector('.admin-equipment-during-price')||row.querySelector('.admin-equipment-price');
    var allDayEl=row.querySelector('.admin-equipment-all-day-price')||row.querySelector('.admin-equipment-surcharge');
    var policyEl=row.querySelector('.admin-equipment-during-policy');
    var p=adminParseEurosToCents(duringEl&&duringEl.value);
    var s=adminParseEurosToCents(allDayEl&&allDayEl.value);
    var policy=policyEl?String(policyEl.value||'').trim():'';
    var rowInvalid = !!(row.getAttribute && row.getAttribute('data-policy-explicit-invalid') === '1')
      || !!(policyEl && policyEl.getAttribute && policyEl.getAttribute('data-policy-explicit-invalid') === '1');
    var policyAllowed = policy==='included'||policy==='optional'||policy==='unavailable';
    // Explicit malformed policy: fail closed — never omit to trigger server inference.
    if(rowInvalid || (policy && !policyAllowed)){
      error=portalT('admin.courseEquipment.policyInvalid')||'During-course policy is invalid';
    }else if(!policy){
      // Truly absent (legacy): omit field so server backward-infers.
      policy='';
    }
    if(!key||seen[key])error=portalT('admin.courseEquipment.duplicate');
    else if(!p.ok||!s.ok)error=portalT('admin.edit.amountInvalid');
    else if(policy==='included'&&p.value!==0){
      error=portalT('admin.courseEquipment.includedRequiresZero')||'Included during-course gear must be €0';
    }else if(!error){
      seen[key]=true;
      var rowOut={offering_key:key,during_course_price_cents:p.value,all_day_price_cents:s.value};
      if(policy)rowOut.during_course_policy=policy;
      out.push(rowOut);
    }
  });
  return {ok:!error,value:out,error:error};
}
/** Loose DOM snapshot for add/remove re-render (keeps drafts, no validation). */
function adminDraftEquipmentRowsFromDom(root){
  if (!root) return [];
  return Array.prototype.slice.call(root.querySelectorAll('[data-equipment-option-row]')).map(function(row){
    var keyEl=row.querySelector('.admin-equipment-offering');
    var duringEl=row.querySelector('.admin-equipment-during-price')||row.querySelector('.admin-equipment-price');
    var allDayEl=row.querySelector('.admin-equipment-all-day-price')||row.querySelector('.admin-equipment-surcharge');
    var policyEl=row.querySelector('.admin-equipment-during-policy');
    var p=adminParseEurosToCents(duringEl&&duringEl.value);
    var s=adminParseEurosToCents(allDayEl&&allDayEl.value);
    var policy=policyEl?String(policyEl.value||'').trim():'';
    var out={
      offering_key:String(keyEl&&keyEl.value||'').trim(),
      during_course_price_cents:p.ok?p.value:0,
      all_day_price_cents:s.ok?s.value:0,
    };
    if(policy) out.during_course_policy=policy;
    return out;
  });
}
/** Empty editor: + in heading. Non-empty: + lives on last row only. */
function adminSyncEquipmentEditorHeadingAdd(editor, rowCount){
  if (!editor) return;
  var heading = editor.querySelector('[data-admin-equipment-heading]');
  if (!heading) return;
  var existing = heading.querySelector('[data-admin-action="add-equipment-option"]');
  if (rowCount > 0) {
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }
  if (existing) return;
  var addEqLabel = portalT('admin.courseEquipment.add') || 'Add equipment';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost portal-admin-icon-btn portal-admin-equipment-add';
  btn.setAttribute('data-admin-action', 'add-equipment-option');
  btn.setAttribute('aria-label', addEqLabel);
  btn.setAttribute('title', addEqLabel);
  btn.textContent = '+';
  heading.appendChild(btn);
}
/** Read-only card cents: exact 0 => localized Included; nonzero uses leading € (no trailing EUR). */
function adminEquipmentCentsText(cents){
  var n = Number(cents);
  if (n === 0) return portalT('admin.courseEquipment.included');
  return adminFormatEuroDisplay((Number.isFinite(n) ? n : 0) / 100);
}
/** Active catalog label, else stored key for historical/unavailable items. */
function adminEquipmentLabelForKey(key){
  var k = String(key || '');
  var found = adminEquipmentOfferings().find(function(o){ return String(o.offering_key || '') === k; });
  if (found) return String(found.label || found.display_name || k);
  return k;
}
/** Independent During/All Day totals for readout (canonical or legacy pair). */
function adminEquipmentOptionPrices(r){
  if (!r) return { during: 0, allDay: 0 };
  if (r.during_course_price_cents != null || r.all_day_price_cents != null) {
    return {
      during: Number(r.during_course_price_cents) || 0,
      allDay: Number(r.all_day_price_cents) || 0,
    };
  }
  return {
    during: Number(r.equipment_price_cents) || 0,
    allDay: Number(r.all_day_surcharge_cents) || 0,
  };
}
/** Group/Private read-only Equipment section — course-owned options only, no invented defaults.
 *  Neutral pill chrome (no accent colors): item name + During/All Day chips. */
function adminRenderEquipmentReadout(options){
  var rows = Array.isArray(options) ? options : [];
  var html = '<div class="portal-admin-pill-group portal-admin-equipment-readout portal-admin-pack-eq-readout" data-admin-equipment-readout="1">' +
    '<span class="portal-admin-pill-label">' + escHtml(portalT('admin.courseEquipment.editorTitle')) + '</span>';
  if (!rows.length){
    return html + '<div class="portal-admin-muted" data-admin-equipment-empty="1">' +
      escHtml(portalT('admin.courseEquipment.empty')) + '</div></div>';
  }
  html += '<div class="portal-admin-pack-eq-items">';
  rows.forEach(function(r){
    if (!r) return;
    var key = String(r.offering_key || '');
    var label = adminEquipmentLabelForKey(key);
    var prices = adminEquipmentOptionPrices(r);
    var hasExplicitPolicy = Object.prototype.hasOwnProperty.call(r, 'during_course_policy')
      && r.during_course_policy != null
      && String(r.during_course_policy).trim() !== '';
    var rawPolicy = hasExplicitPolicy ? String(r.during_course_policy).trim() : '';
    var duringText;
    if (rawPolicy === 'unavailable') {
      duringText = portalT('admin.courseEquipment.policyUnavailable') || 'Unavailable';
    } else if (rawPolicy === 'included' || Number(prices.during) === 0) {
      duringText = adminEquipmentCentsText(0);
    } else {
      duringText = adminEquipmentCentsText(prices.during);
    }
    var allDayText = adminEquipmentCentsText(prices.allDay);
    var duringLab = portalT('admin.courseEquipment.during') || 'During';
    var allDayLab = portalT('admin.courseEquipment.allDay') || 'All day';
    html += '<div class="portal-admin-pack-eq-item" data-equipment-readout-row="' + escHtml(key) + '">' +
      '<span class="portal-admin-pack-eq-name">' + escHtml(label) + '</span>' +
      '<div class="portal-admin-pack-eq-pills">' +
      '<span class="portal-admin-private-price-pill">' +
      '<span class="portal-admin-private-price-pill-k">' + escHtml(duringLab) + '</span>' +
      '<b class="portal-admin-private-price-pill-v" data-equipment-price="during">' + escHtml(duringText) + '</b></span>' +
      '<span class="portal-admin-private-price-pill">' +
      '<span class="portal-admin-private-price-pill-k">' + escHtml(allDayLab) + '</span>' +
      '<b class="portal-admin-private-price-pill-v" data-equipment-price="all_day">' + escHtml(allDayText) + '</b></span>' +
      '</div></div>';
  });
  return html + '</div></div>';
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
function adminPackSecondaryScheduleRowHtml(prefix, t1){
  t1 = t1 || { start: '', end: '' };
  return '<div class="portal-admin-pack-schedule-row" data-admin-pack-schedule-second>' +
    '<div class="portal-admin-edit-field"><label for="' + prefix + '-schedule-start2">' + escHtml(portalT('admin.packs.startTime2')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-start2" value="' + escHtml(t1.start || '') + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label for="' + prefix + '-schedule-end2">' + escHtml(portalT('admin.packs.endTime2')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-end2" value="' + escHtml(t1.end || '') + '" placeholder="HH:MM" maxlength="5"></div>' +
    '</div>';
}
function adminRenderPackScheduleFields(p, prefix){
  var s0 = (p && p.schedules && p.schedules[0]) ? p.schedules[0] : '0930_1130';
  var s1 = (p && p.schedules && p.schedules[1]) ? p.schedules[1] : '';
  // schedules may be raw keys ("1000_1200") or legacy {key,label} objects from verify fixtures
  if (s0 && typeof s0 === 'object') s0 = s0.key || '';
  if (s1 && typeof s1 === 'object') s1 = s1.key || '';
  var t0 = adminTimesFromScheduleKey(s0);
  var t1 = adminTimesFromScheduleKey(s1);
  // Compact two-column Start | End. Labels omit (HH:MM); placeholder still carries format.
  // Empty optional second window is omitted by default. Staff can reveal it via
  // "Add secondary time" (add-secondary-schedule). Configured second schedules
  // auto-render so edit/save preserves them without an extra click.
  var html = '<div class="portal-admin-pack-schedule-row">' +
    '<div class="portal-admin-edit-field"><label for="' + prefix + '-schedule-start">' + escHtml(portalT('admin.edit.startTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-start" value="' + escHtml(t0.start) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '<div class="portal-admin-edit-field"><label for="' + prefix + '-schedule-end">' + escHtml(portalT('admin.edit.endTime')) + '</label>' +
    '<input type="text" id="' + prefix + '-schedule-end" value="' + escHtml(t0.end) + '" placeholder="HH:MM" maxlength="5"></div>' +
    '</div>';
  if (t1.start || t1.end) {
    html += adminPackSecondaryScheduleRowHtml(prefix, t1);
  } else {
    html += '<button type="button" class="btn btn-ghost portal-admin-pack-add-secondary" data-admin-action="add-secondary-schedule" data-schedule-prefix="' + escHtml(prefix) + '">+ ' +
      escHtml(portalT('admin.packs.addSecondaryTime')) + '</button>';
  }
  return html;
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
  var removeTierLabel = portalT('admin.packs.removePriceTier') || 'Remove price tier';
  return (rows || []).map(function(r){
    var opts = durs.map(function(d){
      return '<option value="' + escHtml(d.key) + '"' + (d.key === r.key ? ' selected' : '') + '>' + escHtml(d.label) + '</option>';
    }).join('');
    // Compact row: wider duration | € amount | / Student | circular danger ×.
    // Still uses data-admin-action="remove-pack-tier" (distinct from equipment remove).
    return '<div class="portal-admin-pack-tier" data-pack-tier-row>' +
      '<select class="pack-tier-key" aria-label="' + escHtml(portalT('admin.packs.priceTiers')) + '">' + opts + '</select>' +
      '<label class="portal-admin-pack-tier-amount">' +
      '<span class="portal-admin-currency" aria-hidden="true">€</span>' +
      '<input type="text" class="pack-tier-amount" value="' + escHtml(r.amount || '') + '" inputmode="decimal" placeholder="0.00" aria-label="' + escHtml(portalT('admin.edit.amountEur')) + '">' +
      '</label>' +
      '<span class="portal-admin-muted portal-admin-pack-tier-unit">' + escHtml(portalT('admin.packs.perStudent')) + '</span>' +
      '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-danger portal-admin-pack-tier-remove" data-admin-action="remove-pack-tier" aria-label="' + escHtml(removeTierLabel) + '" title="' + escHtml(removeTierLabel) + '">×</button>' +
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
  // Option 3: two-column price list (1–4 | 5–7), neutral tokens.
  var list = (tiers || []).filter(function(t){
    return t && ADMIN_CANONICAL_PACK_TIER_KEYS[String(t.key || '').trim()];
  }).slice().sort(function(a, b){
    var na = parseInt(String(a.key || ''), 10) || 0;
    var nb = parseInt(String(b.key || ''), 10) || 0;
    return na - nb;
  });
  var left = [];
  var right = [];
  list.forEach(function(t){
    var n = parseInt(String(t.key || ''), 10) || 0;
    if (n >= 5) right.push(t);
    else left.push(t);
  });
  function colHtml(items){
    var h = '<div class="portal-admin-pack-prices-col">';
    items.forEach(function(t){
      h += '<div class="portal-admin-pack-tier-row" data-pack-tier-key="' + escHtml(String(t.key || '')) + '">' +
        '<span class="portal-admin-pack-tier-days">' + escHtml(t.label || t.key) + '</span>' +
        '<strong class="portal-admin-pack-tier-amt">' +
        escHtml(adminFormatEuroDisplay((t.amount_cents != null ? t.amount_cents : 0) / 100)) +
        '</strong></div>';
    });
    return h + '</div>';
  }
  var html = '<div class="portal-admin-pack-prices" data-admin-pack-prices="1">' +
    '<span class="portal-admin-pack-sectlab">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>';
  if (!list.length) {
    return html + '<div class="portal-admin-muted">—</div></div>';
  }
  html += '<div class="portal-admin-pack-prices-2col">' + colHtml(left) + colHtml(right) + '</div></div>';
  return html;
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
    adminRenderEquipmentEditor(p.equipment_options || [], prefix) +
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
    equipment_options: adminReadEquipmentOptions(root).value,
    _equipmentError: adminReadEquipmentOptions(root).ok ? '' : adminReadEquipmentOptions(root).error,
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
  // HISTORICAL helper for the legacy group Prices UI only. Equipment Admin
  // (Add equipment / New time-price) uses renderAdminDurationControl +
  // rentalDurationKeyFromUnitCount and writes generic N_hours / N_days keys —
  // never this fixed product-window list (and never 12 → half_day).
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

// Rank rental durations shortest → longest. Historical fixed windows first;
// generic N_hours / N_days sort by count via the duration model when present.
function adminRentalPeriodRank(period){
  var order = ['1_hour', '2_hours', 'half_day', 'full_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  var key = String(period || '').trim();
  var i = order.indexOf(key);
  if (i >= 0) return i;
  if (typeof parseRentalDurationKey === 'function') {
    var uc = parseRentalDurationKey(key);
    if (uc) {
      // hours: 0 + count; days: 1000 + count (hours before multi-day).
      return (uc.unit === 'days' ? 1000 : 0) + uc.count;
    }
  }
  return 9999;
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

/**
 * Duration count+unit control with one visual label and distinct accessible names.
 * Label id is unique per prefix; count/unit use aria-labelledby + aria-label (no duplicate IDs).
 */
function renderAdminDurationControl(prefix, unit, count){
  var u = unit || 'days';
  var c = count || 1;
  var labelId = String(prefix) + '-duration-label';
  var countId = String(prefix) + '-count';
  var unitId = String(prefix) + '-unit';
  var durLabel = portalT('admin.prices.duration') || 'Duration';
  var countAria = portalT('admin.prices.durationCountAria') || (durLabel + ' count');
  var unitAria = portalT('admin.prices.durationUnitAria') || (durLabel + ' unit');
  // Visual label id on group (aria-labelledby); count/unit use distinct aria-label so
  // getByLabel resolves uniquely. Do not put aria-labelledby on both controls alone —
  // that would yield identical accessible names.
  return '<div class="portal-admin-edit-field portal-admin-equip-field">' +
    '<span class="portal-admin-field-label" id="' + escHtml(labelId) + '">' + escHtml(durLabel) + '</span>' +
    '<div class="portal-admin-duration-row" role="group" aria-labelledby="' + escHtml(labelId) + '">' +
    '<input type="number" class="portal-admin-duration-count" id="' + escHtml(countId) +
    '" min="1" max="999" step="1" value="' + escHtml(String(c)) +
    '" aria-label="' + escHtml(countAria) + '">' +
    '<select class="portal-admin-duration-unit" id="' + escHtml(unitId) +
    '" aria-label="' + escHtml(unitAria) + '">' +
    '<option value="hours"' + (u === 'hours' ? ' selected' : '') + '>' + escHtml(portalT('admin.prices.hours') || 'Hours') + '</option>' +
    '<option value="days"' + (u === 'days' ? ' selected' : '') + '>' + escHtml(portalT('admin.prices.days') || 'Days') + '</option>' +
    '</select></div></div>';
}

/** Unknown/invalid duration sentinel — labelled select, no invented writable identity. */
function renderAdminDurationInvalidControl(prefix, displayLabel){
  var labelId = String(prefix) + '-duration-label';
  var selectId = String(prefix) + '-unit-invalid';
  var durLabel = portalT('admin.prices.duration') || 'Duration';
  return '<div class="portal-admin-edit-field portal-admin-equip-field">' +
    '<label id="' + escHtml(labelId) + '" for="' + escHtml(selectId) + '">' + escHtml(durLabel) + '</label>' +
    '<select class="portal-admin-duration-unit" id="' + escHtml(selectId) +
    '" disabled data-admin-duration-invalid="1" aria-invalid="true" aria-labelledby="' +
    escHtml(labelId) + '" aria-label="' + escHtml(durLabel) + '">' +
    '<option selected value="">' + escHtml(displayLabel || '???') + '</option>' +
    '</select></div>';
}

function renderAdminAddEquipmentForm(){
  var nameId = 'admin-new-equip-name';
  var stockId = 'admin-new-equip-stock';
  var amountId = 'admin-new-equip-amount';
  return '<div class="portal-admin-edit-form portal-admin-equip-form" id="admin-add-equip-form">' +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + nameId + '">' +
    escHtml(portalT('admin.prices.equipmentName') || 'Equipment name') + '</label>' +
    '<input type="text" id="' + nameId + '" placeholder="Kayak"></div>' +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + stockId + '">' +
    escHtml(portalT('admin.prices.stock') || 'Total stock') + '</label>' +
    '<input type="number" id="' + stockId + '" min="0" max="999" step="1" placeholder="" inputmode="numeric"></div>' +
    renderAdminDurationControl('admin-new-equip', 'days', 1) +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + amountId + '">' +
    escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" class="portal-admin-equip-amount" id="' + amountId + '" inputmode="decimal" placeholder="0.00"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-new-equipment">' + escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
}

function renderAdminAddEquipPriceForm(offeringKey){
  // Draft only — committed by the single item-level Save (save-equipment).
  var amountId = 'admin-new-price-amount';
  return '<div class="portal-admin-edit-form portal-admin-equip-form portal-admin-equip-draft-form" id="admin-add-price-form" data-equip-key="' + escHtml(offeringKey) + '">' +
    '<div class="portal-admin-equip-draft-label">' + escHtml(portalT('admin.prices.addDurationPrice') || portalT('admin.prices.newTimePrice') || 'Add duration + price') + '</div>' +
    renderAdminDurationControl('admin-new-price', 'days', 1) +
    '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + amountId + '">' +
    escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" class="portal-admin-equip-amount" id="' + amountId + '" inputmode="decimal" placeholder="0.00"></div>' +
    '</div>';
}

/** Merge price-derived equipment rows with rental offering identities so disabled items stay visible. */
function adminMergeEquipmentPricingItems(cfg){
  var prices = (cfg && cfg.prices) ? cfg.prices : [];
  var fromPrices = (typeof buildEquipmentPricingList === 'function') ? buildEquipmentPricingList(prices) : [];
  var byKey = {};
  var order = [];
  fromPrices.forEach(function(item){
    if (!item || !item.offering_key) return;
    byKey[item.offering_key] = {
      offering_key: item.offering_key,
      label: item.label,
      rows: item.rows || [],
      active: true,
      stock_quantity: null,
    };
    order.push(item.offering_key);
  });
  adminAllEquipmentOfferings().forEach(function(off){
    var key = String(off.offering_key || '').trim();
    if (!key) return;
    var isActive = off.active !== false;
    var stockQty = (off.stock_quantity === null || off.stock_quantity === undefined)
      ? null
      : (Number.isInteger(Number(off.stock_quantity)) ? Number(off.stock_quantity) : null);
    if (byKey[key]) {
      byKey[key].active = isActive;
      if (off.label) byKey[key].label = off.label;
      byKey[key].stock_quantity = stockQty;
      return;
    }
    // Disabled (or unpriced) offering: still list for re-enable / audit visibility.
    byKey[key] = {
      offering_key: key,
      label: off.label || off.display_name || key,
      rows: [],
      active: isActive,
      stock_quantity: stockQty,
    };
    order.push(key);
  });
  return order.map(function(k){ return byKey[k]; }).filter(Boolean);
}

/** Stock readout for equipment cards (configured total units). */
function adminEquipStockLabel(stockQuantity){
  if (stockQuantity === null || stockQuantity === undefined || stockQuantity === '') {
    return portalT('admin.prices.stockUnconfigured') || 'Stock not set';
  }
  var n = Number(stockQuantity);
  if (!Number.isInteger(n)) return portalT('admin.prices.stockUnconfigured') || 'Stock not set';
  return String(portalT('admin.prices.stockEquals') || 'Stock = {n}').replace('{n}', String(n));
}

/**
 * Compact browse stock part: "Stock = {n}" or truthful not-configured fallback.
 * Panel does not fetch/render today availability.
 */
function adminEquipCompactStockPart(stockQuantity){
  if (stockQuantity === null || stockQuantity === undefined || stockQuantity === '') {
    return portalT('admin.prices.stockUnconfigured') || 'Stock not set';
  }
  var n = Number(stockQuantity);
  if (!Number.isInteger(n)) return portalT('admin.prices.stockUnconfigured') || 'Stock not set';
  return String(portalT('admin.prices.stockEquals') || 'Stock = {n}').replace('{n}', String(n));
}

/** Semantic Enabled/Disabled label for browse meta + edit heading. */
function adminEquipEnabledLabel(active){
  return active
    ? (portalT('admin.prices.enabled') || 'Enabled')
    : (portalT('admin.prices.disabled') || 'Disabled');
}

/** Full localized chip label: "6 hours €10" / "1 day €20". */
function adminEquipPriceChipLabel(durationLabel, euros){
  var dur = String(durationLabel || '').trim() || '???';
  var amt = (euros === '' || euros == null) ? '' : String(euros);
  if (!amt) return dur;
  return dur + ' €' + amt;
}

/**
 * Mount + Add equipment into the stable section header slot (title left / button right).
 * Does not render a second toolbar inside #admin-prices-body.
 */
function adminPopulatePricesHeaderActions(writes){
  var hdrActions = el('admin-prices-hdr-actions');
  if (!hdrActions) return;
  if (writes){
    hdrActions.hidden = false;
    hdrActions.innerHTML = '<button type="button" class="btn btn-primary" data-admin-action="add-equipment">+ ' +
      escHtml(portalT('admin.prices.addEquipment') || 'Add equipment') + '</button>';
  } else {
    hdrActions.hidden = true;
    hdrActions.innerHTML = '';
  }
}

function renderAdminSectionPricesFromConfig(cfg){
  var box = el('admin-prices-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var items = adminMergeEquipmentPricingItems(cfg);
  var addingItem = writes && adminEditTarget === 'equip-add-item';
  // Title + Add equipment share one header row (stable mount slot outside body).
  adminPopulatePricesHeaderActions(writes);
  var html = '';
  // + Add equipment stays available in header even while one row is expanded / add form open.
  if (writes && addingItem) html += renderAdminAddEquipmentForm();
  if (!items.length && !addingItem){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.noEquipment') || 'No equipment yet — add your first item.') + '</p>';
  }
  html += '<div class="portal-admin-equip-list" data-admin-equip-list="1">';
  items.forEach(function(item){
    var key = item.offering_key;
    var itemActive = item.active !== false;
    // Nested edit: equip-add-price:KEY is item edit with the duration form open.
    var adding = writes && adminEditTarget === ('equip-add-price:' + key);
    var editing = writes && (adminEditTarget === ('equip:' + key) || adding);
    var deleteLabel = portalT('admin.prices.deleteEquipment') || portalT('admin.prices.deleteRental') || 'Delete equipment';
    var equipDisplayName = item.label || key;
    var editLabel = String(portalT('admin.prices.editEquipmentPrices') || 'Edit {name} rental prices')
      .replace('{name}', equipDisplayName);
    var saveLabel = portalT('admin.prices.saveChanges') || portalT('admin.action.save') || 'Save changes';
    var addDurLabel = portalT('admin.prices.addDurationPrice') || 'Add duration + price';
    var editingHeading = String(portalT('admin.prices.editingTitle') || 'Editing — {name}').replace('{name}', equipDisplayName);
    var statusOnLabel = adminEquipEnabledLabel(true);
    var statusOffLabel = adminEquipEnabledLabel(false);
    var removeDurLabel = portalT('admin.prices.removeDuration') || 'Remove duration price now';

    // Hybrid row: compact browse strip OR expand-in-place editor (one owner via adminEditTarget).
    html += '<div class="portal-admin-equip-row' +
      (editing ? ' is-editing' : ' is-compact') +
      (itemActive ? '' : ' is-equip-disabled') +
      '" data-admin-equip="' + escHtml(key) +
      '" data-equip-active="' + (itemActive ? '1' : '0') +
      '" data-equip-mode="' + (editing ? 'edit' : 'browse') + '">';

    if (!editing){
      // ── Compact browse row ──
      html += '<div class="portal-admin-equip-compact">';
      html += '<div class="portal-admin-equip-identity">';
      // Status dot left of name (not in meta line). Full name via title; wrap up to 2 lines.
      html += '<div class="portal-admin-equip-name-row">';
      html += '<span class="portal-admin-equip-status-dot' + (itemActive ? ' is-on' : ' is-off') +
        '" aria-hidden="true"></span>';
      html += '<div class="portal-admin-equip-name" title="' + escHtml(item.label || key) + '">' +
        escHtml(item.label) + '</div>';
      html += '</div>';
      // Exact semantic meta: "Stock = X · Enabled|Disabled" (no today availability slot).
      html += '<div class="portal-admin-equip-status" data-equip-status="' + escHtml(key) + '">';
      html += '<span class="portal-admin-equip-status-text portal-admin-muted">';
      html += '<span class="portal-admin-equip-stock-readout" data-equip-stock="' +
        escHtml(item.stock_quantity == null ? '' : String(item.stock_quantity)) + '">' +
        escHtml(adminEquipCompactStockPart(item.stock_quantity)) + '</span>';
      html += '<span class="portal-admin-equip-meta-sep" aria-hidden="true"> · </span>';
      html += '<span class="portal-admin-equip-active-label" data-equip-active-label="' +
        (itemActive ? '1' : '0') + '">' +
        escHtml(itemActive ? statusOnLabel : statusOffLabel) + '</span>';
      html += '</span></div></div>';

      // Price chips — full localized labels, wrap; never hide prices.
      html += '<div class="portal-admin-equip-chips" data-equip-chips="' + escHtml(key) + '">';
      if (item.rows.length){
        item.rows.forEach(function(r){
          var euros = adminEurosFromAmount((r.amount_cents == null ? 0 : r.amount_cents) / 100);
          var chip = adminEquipPriceChipLabel(r.duration_label, euros === '' ? '0' : euros);
          html += '<span class="portal-admin-equip-chip' + (r.active ? '' : ' is-inactive') +
            '" data-admin-price-duration="' + escHtml(r.duration_key || '') +
            '" data-admin-price-amount="' + escHtml(String(r.amount_cents == null ? 0 : r.amount_cents)) + '">' +
            escHtml(chip) + '</span>';
        });
      } else {
        html += '<span class="portal-admin-muted portal-admin-equip-chips-empty">' +
          escHtml(portalT('admin.prices.emptyCategory')) + '</span>';
      }
      html += '</div>';

      // Browse: pencil only — no overflow / compact Delete.
      if (writes && !adminPriceGroupBusy(key)){
        html += '<div class="portal-admin-equip-actions portal-admin-card-actions">';
        html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-equip-edit-btn" data-admin-action="edit-equipment" data-equip-key="' +
          escHtml(key) + '" aria-label="' + escHtml(editLabel) + '" title="' + escHtml(editLabel) + '">✎</button>';
        html += '</div>';
      }
      html += '</div>'; // compact
    } else {
      // ── Expand-in-place editor (green-accent shell) ──
      html += '<div class="portal-admin-equip-edit-shell" data-admin-equip-edit="' + escHtml(key) + '">';
      html += '<div class="portal-admin-equip-edit-header">';
      html += '<div class="portal-admin-equip-edit-heading-row portal-admin-equip-name-row">';
      html += '<span class="portal-admin-equip-status-dot' + (itemActive ? ' is-on' : ' is-off') +
        '" aria-hidden="true"></span>';
      html += '<h3 class="portal-admin-equip-edit-heading">' + escHtml(editingHeading) + '</h3>';
      html += '<span class="portal-admin-equip-active-label" data-equip-active-label="' +
        (itemActive ? '1' : '0') + '">' +
        escHtml(itemActive ? statusOnLabel : statusOffLabel) + '</span>';
      html += '</div></div>';

      var stockVal = item.stock_quantity == null ? '' : String(item.stock_quantity);
      var nameInputId = 'admin-equip-name-' + key;
      var stockInputId = 'admin-equip-stock-' + key;
      html += '<div class="portal-admin-edit-form portal-admin-equip-meta-form" data-equip-key="' + escHtml(key) + '">' +
        '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + escHtml(nameInputId) + '">' +
        escHtml(portalT('admin.prices.equipmentName') || 'Equipment name') + '</label>' +
        '<input type="text" id="' + escHtml(nameInputId) + '" data-admin-equip-field="name" data-equip-key="' + escHtml(key) + '" value="' + escHtml(item.label || '') + '" maxlength="120"></div>' +
        '<div class="portal-admin-edit-field portal-admin-equip-field"><label for="' + escHtml(stockInputId) + '">' +
        escHtml(portalT('admin.prices.stock') || 'Total stock') + '</label>' +
        '<input type="number" id="' + escHtml(stockInputId) + '" data-admin-equip-field="stock" data-equip-key="' + escHtml(key) + '" min="0" max="999" step="1" value="' + escHtml(stockVal) + '" inputmode="numeric" placeholder=""></div>' +
        '<div class="portal-admin-edit-field portal-admin-equip-field portal-admin-equip-enabled-field">' +
        '<span class="portal-admin-equip-switch-caption">' + escHtml(portalT('admin.prices.enabled') || 'Enabled') + '</span>' +
        '<label class="portal-admin-equip-switch" title="' + escHtml(portalT('admin.prices.enabled') || 'Enabled') + '">' +
        '<input type="checkbox" data-admin-action="toggle-equip-enabled" data-equip-key="' + escHtml(key) + '"' +
        (itemActive ? ' checked' : '') +
        ' aria-label="' + escHtml(portalT('admin.prices.enabled')) + '">' +
        '<span class="portal-admin-equip-switch-slider" aria-hidden="true"></span>' +
        '</label></div></div>';

      // Duration prices: responsive 3-col desktop / 2-col intermediate / 1-col mobile. Semantic duration + € + ×.
      html += '<div class="portal-admin-equip-price-grid" id="admin-prices-card-grid-' + escHtml(key) + '">';
      if (item.rows.length){
        item.rows.forEach(function(r){
          var euros = adminEurosFromAmount((r.amount_cents == null ? 0 : r.amount_cents) / 100);
          var durParsed = (typeof parseRentalDurationKey === 'function')
            ? parseRentalDurationKey(r.duration_key || r.unit || '')
            : null;
          var isInvalid = !!(r.invalid || !durParsed);
          var durUnit = (durParsed && durParsed.unit) || 'days';
          var durCount = (durParsed && durParsed.count) || 1;
          var pricePrefix = 'admin-price-' + adminPriceInputKey(r.pid || '');
          var amountId = 'admin-price-amount-' + adminPriceInputKey(r.pid || '');
          html += '<article class="portal-admin-price-card is-editing' + (r.active ? '' : ' is-inactive') +
            (isInvalid ? ' is-duration-invalid' : '') +
            '" data-admin-price-card="' + escHtml(r.pid || '') +
            '" data-admin-price-duration="' + escHtml(r.duration_key || '') + '">';
          if (isInvalid){
            // Fail-closed sentinel — do not invent a writable duration identity.
            html += renderAdminDurationInvalidControl(pricePrefix, r.duration_label || r.duration_key || '???');
          } else {
            html += renderAdminDurationControl(pricePrefix, durUnit, durCount);
          }
          html += '<div class="portal-admin-price-card-edit portal-admin-equip-amount-field"><div><label for="' +
            escHtml(amountId) + '">' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
            '<input type="text" data-admin-price-field="amount" id="' + escHtml(amountId) +
            '" value="' + escHtml(euros) + '" inputmode="decimal"></div></div>';
          if (r.pid){
            // PRE-EXISTING contract: × immediately DELETEs with confirmation; Cancel cannot undo.
            html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger portal-admin-equip-remove-duration" data-admin-action="delete-price" data-price-id="' +
              escHtml(r.pid) + '" title="' + escHtml(removeDurLabel) + '" aria-label="' +
              escHtml(removeDurLabel) + '">×</button>';
          }
          html += '</article>';
        });
      }
      html += '</div>';

      if (adding) {
        html += renderAdminAddEquipPriceForm(key);
      } else {
        html += '<button type="button" class="portal-admin-equip-add-duration" data-admin-action="add-equip-price" data-equip-key="' +
          escHtml(key) + '">+ ' + escHtml(addDurLabel) + '</button>';
      }

      // Single bottom action bar: Delete left; Cancel + Save changes right.
      // No top-right Delete rental / New time + price; no duplicate footer Delete elsewhere.
      html += '<div class="portal-admin-edit-actions portal-admin-equip-footer" data-equip-key="' + escHtml(key) + '">' +
        '<button type="button" class="btn btn-ghost portal-admin-danger portal-admin-equip-delete" data-admin-action="delete-rental-offering" data-equip-key="' +
        escHtml(key) + '" aria-label="' + escHtml(deleteLabel) + '">' + escHtml(deleteLabel) + '</button>' +
        '<div class="portal-admin-equip-footer-right">' +
        '<div id="admin-equip-error-' + escHtml(key) + '" data-admin-equip-error="' + escHtml(key) +
        '" class="state-msg portal-admin-equip-error" style="display:none" aria-live="polite"></div>' +
        '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' +
        escHtml(portalT('admin.action.cancel') || 'Cancel') + '</button>' +
        '<button type="button" class="btn btn-primary" data-admin-action="save-equipment" data-equip-key="' +
        escHtml(key) + '">' + escHtml(saveLabel) + '</button>' +
        '</div></div>';
      html += '</div>'; // edit-shell
    }
    html += '</div>'; // equip-row
  });
  html += '</div>'; // equip-list
  box.innerHTML = html;
  // Rental Prices panel intentionally does not fetch/render today's availability.
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
    var costText = fields.price_amount != null ? adminFormatEuroDisplay(fields.price_amount) : '—';
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
  var list = packs && packs.length ? packs.slice() : [];
  // A1: earliest course run time first (not alphabetical by name).
  list.sort(function(a, b){
    function earliestStart(p){
      var mins = null;
      var scheds = (p && p.schedules) || [];
      for (var i = 0; i < scheds.length; i++){
        var k = scheds[i];
        if (k && typeof k === 'object') k = k.key || '';
        k = String(k || '');
        var start = k.split('_')[0] || '';
        start = start.replace(':', '');
        if (start.length === 3) start = '0' + start;
        if (!/^\d{4}$/.test(start)) continue;
        var m = parseInt(start.slice(0, 2), 10) * 60 + parseInt(start.slice(2), 10);
        if (!Number.isFinite(m)) continue;
        if (mins == null || m < mins) mins = m;
      }
      return mins == null ? 24 * 60 + 1 : mins;
    }
    var da = earliestStart(a), db = earliestStart(b);
    if (da !== db) return da - db;
    return String((a && a.label) || '').localeCompare(String((b && b.label) || ''));
  });
  if (!list.length && adminEditTarget !== 'pack:new'){
    html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.packs.placeholder')) + '</p></div>';
    return html;
  }
  html += '<div class="portal-admin-pack-grid" id="admin-pack-card-grid">';
  list.forEach(function(p){
    var pid = (p.pack_id || p.id) ? String(p.pack_id || p.id) : '';
    var editing = writes && adminEditTarget === ('pack:' + pid);
    html += '<article class="portal-admin-pack-card' + (editing ? ' is-editing' : '') + '" data-admin-pack-card="' + escHtml(pid) + '">';
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
      // Option 3 closed card: meta as tidy label:value rows, equipment under meta,
      // then two-column price list (1–4 | 5–7). Neutral site tokens only.
      var capText = String(p.group_size != null ? p.group_size : defaultCap) + ' ' + portalT('admin.lessonTimes.seats');
      var beachLabels = (function(){
        var map = {};
        adminPackBeachOptions().forEach(function(o){ map[o.value] = o.label; });
        return (p.beaches || []).map(function(v){ return map[v] || v; }).filter(Boolean).join(', ') || '—';
      })();
      var weeklyLabel = (function(){
        var map = {};
        adminPackWeeklyPillOptions().forEach(function(o){ map[o.value] = o.label; });
        var w = p.weekly || 'mon_fri';
        return map[w] || w || '—';
      })();
      var schedLabel = (function(){
        var list = (p.schedules || []).filter(Boolean).map(function(k){
          if (k && typeof k === 'object') k = k.key || '';
          var t = adminTimesFromScheduleKey(k);
          return (t.start && t.end) ? (t.start + ' – ' + t.end) : null;
        }).filter(Boolean);
        return list.length ? list.join(', ') : '—';
      })();
      function metaRow(lab, val){
        return '<div class="portal-admin-pack-meta-row">' +
          '<span class="portal-admin-pack-meta-k">' + escHtml(lab) + '</span>' +
          '<span class="portal-admin-pack-meta-v">' + escHtml(val) + '</span></div>';
      }
      html += '<div class="portal-admin-pack-meta-rows" data-admin-pack-meta="1">' +
        metaRow(portalT('admin.edit.capacity'), capText) +
        metaRow(portalT('admin.packs.beaches'), beachLabels) +
        metaRow(portalT('admin.edit.frequency'), weeklyLabel) +
        metaRow(portalT('admin.packs.schedules'), schedLabel) +
        '</div>';
      // Equipment directly under meta (matches edit-form order).
      html += adminRenderEquipmentReadout(p.equipment_options || []);
      html += adminRenderPackTierReadout(p.price_tiers || []);
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
/**
 * Private closed card equipment cell — same markers/semantics as adminRenderEquipmentReadout
 * (data-admin-equipment-readout, pill-label Equipment, per-row keys, Included for €0)
 * but laid out as inline name + During/All-day pills for the 2a full-width row.
 */
function adminRenderPrivateEquipmentInline(options){
  var rows = Array.isArray(options) ? options : [];
  var html = '<div class="portal-admin-private-eq-readout portal-admin-equipment-readout" data-admin-equipment-readout="1">' +
    '<span class="portal-admin-pill-label portal-admin-visually-hidden">' +
    escHtml(portalT('admin.courseEquipment.editorTitle')) + '</span>';
  if (!rows.length){
    return html + '<div class="portal-admin-muted" data-admin-equipment-empty="1">' +
      escHtml(portalT('admin.courseEquipment.empty')) + '</div></div>';
  }
  html += '<div class="portal-admin-private-eq-items">';
  rows.forEach(function(r){
    if (!r) return;
    var key = String(r.offering_key || '');
    var label = adminEquipmentLabelForKey(key);
    var prices = adminEquipmentOptionPrices(r);
    // Existing semantics: 0 => Included; honor during_course_policy for During pill.
    var hasExplicitPolicy = Object.prototype.hasOwnProperty.call(r, 'during_course_policy')
      && r.during_course_policy != null
      && String(r.during_course_policy).trim() !== '';
    var rawPolicy = hasExplicitPolicy ? String(r.during_course_policy).trim() : '';
    var duringText;
    if (rawPolicy === 'unavailable') {
      duringText = portalT('admin.courseEquipment.policyUnavailable') || 'Unavailable';
    } else if (rawPolicy === 'included' || Number(prices.during) === 0) {
      duringText = adminEquipmentCentsText(0);
    } else {
      duringText = adminEquipmentCentsText(prices.during);
    }
    var allDayText = adminEquipmentCentsText(prices.allDay);
    var duringLab = portalT('admin.courseEquipment.during') || 'During';
    var allDayLab = portalT('admin.courseEquipment.allDay') || 'All day';
    html += '<div class="portal-admin-private-eq-item" data-equipment-readout-row="' + escHtml(key) + '">' +
      '<span class="portal-admin-private-eq-name">' + escHtml(label) + '</span>' +
      '<span class="portal-admin-private-price-pill">' +
      '<span class="portal-admin-private-price-pill-k">' + escHtml(duringLab) + '</span>' +
      '<b class="portal-admin-private-price-pill-v" data-equipment-price="during">' + escHtml(duringText) + '</b></span>' +
      '<span class="portal-admin-private-price-pill">' +
      '<span class="portal-admin-private-price-pill-k">' + escHtml(allDayLab) + '</span>' +
      '<b class="portal-admin-private-price-pill-v" data-equipment-price="all_day">' + escHtml(allDayText) + '</b></span>' +
      '</div>';
  });
  return html + '</div></div>';
}
function renderAdminPrivateLessonEditForm(pl){
  var p = pl || {};
  // One-row edit (approved mockup): identity | equipment editor | Save/Cancel.
  // Equipment subtree stays byte-intact (adminRenderEquipmentEditor hooks).
  // Notes is full-width under the control row (does not fit the single row).
  return '<div class="portal-admin-edit-form portal-admin-private-edit-form" data-admin-private-lesson-form="1">' +
    '<div class="portal-admin-private-edit-row" data-admin-private-edit-row="1">' +
      '<div class="portal-admin-private-identity" data-admin-private-identity="1">' +
        '<div class="portal-admin-edit-field portal-admin-private-enabled-field">' +
          '<span class="portal-admin-private-field-lab">' + escHtml(portalT('admin.privateLessons.enabled') || 'On') + '</span>' +
          '<label class="portal-admin-private-enabled-switch" for="admin-private-enabled">' +
          '<input type="checkbox" id="admin-private-enabled"' + (p.enabled ? ' checked' : '') + '>' +
          '<span class="portal-admin-private-enabled-slider" aria-hidden="true"></span>' +
          '</label></div>' +
        '<div class="portal-admin-edit-field portal-admin-private-label-field"><label for="admin-private-label">' +
          escHtml(portalT('admin.edit.displayName')) + '</label>' +
          '<input type="text" id="admin-private-label" value="' + escHtml(p.label || '') + '" maxlength="120"></div>' +
        '<div class="portal-admin-edit-field portal-admin-private-price-field"><label for="admin-private-price">' +
          escHtml(portalT('admin.privateLessons.price')) + '</label>' +
          '<input type="text" id="admin-private-price" value="' +
          escHtml(adminEurosFromAmount((p.amount_cents || 0) / 100)) +
          '" inputmode="decimal" placeholder="0.00"></div>' +
        '<div class="portal-admin-edit-field portal-admin-private-duration-field"><label for="admin-private-duration">' +
          escHtml(portalT('admin.privateLessons.duration')) + '</label>' +
          '<input type="number" id="admin-private-duration" min="15" max="480" step="1" value="' +
          escHtml(String(p.default_duration_minutes != null ? p.default_duration_minutes : 120)) + '"></div>' +
      '</div>' +
      '<div class="portal-admin-private-equip-zone" data-admin-private-equip-zone="1">' +
        adminRenderEquipmentEditor(p.equipment_options || [], 'admin-private') +
      '</div>' +
      '<div class="portal-admin-private-edit-actions portal-admin-edit-actions" data-admin-private-edit-actions="1">' +
        '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' +
          escHtml(portalT('admin.action.cancel')) + '</button>' +
        '<button type="button" class="btn btn-primary" data-admin-action="save-private-lesson">' +
          escHtml(portalT('admin.action.save')) + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="portal-admin-edit-field portal-admin-private-notes-field" data-admin-private-notes-field="1">' +
      '<label for="admin-private-notes">' + escHtml(portalT('admin.privateLessons.notes')) + '</label>' +
      '<textarea id="admin-private-notes" rows="2" maxlength="2000">' + escHtml(p.notes || '') + '</textarea>' +
    '</div>' +
  '</div>';
}
function renderAdminPrivateLessonReadout(pl, opts){
  var p = pl || {};
  var showEdit = !!(opts && opts.showEdit);
  // Closed 2a — full-width columns: Lesson | Price | Duration | Equipment | ✎
  var priceMain = adminFormatEuroDisplay((p.amount_cents || 0) / 100);
  var perSess = portalT('admin.privateLessons.perSession') || '/ session';
  var durationNum = String(p.default_duration_minutes != null ? p.default_duration_minutes : 120);
  var minLab = portalT('admin.privateLessons.minutes') || 'min';
  var html = '<div class="portal-admin-private-closed-row" data-admin-private-closed-row="1">' +
    '<div class="portal-admin-private-col portal-admin-private-col-name">' +
      '<span class="portal-admin-private-col-k">' + escHtml(portalT('admin.privateLessons.defaultName') || portalT('admin.edit.displayName') || 'Lesson') + '</span>' +
      '<span class="portal-admin-private-col-v">' + escHtml(p.label || '—') + '</span></div>' +
    '<div class="portal-admin-private-col portal-admin-private-col-price">' +
      '<span class="portal-admin-private-col-k">' + escHtml(portalT('admin.privateLessons.price')) + '</span>' +
      '<span class="portal-admin-private-col-v"><span class="portal-admin-private-price-val">' +
      escHtml(priceMain) + '</span> <small>' + escHtml(perSess) + '</small></span></div>' +
    '<div class="portal-admin-private-col portal-admin-private-col-dur">' +
      '<span class="portal-admin-private-col-k">' + escHtml(portalT('admin.privateLessons.duration')) + '</span>' +
      '<span class="portal-admin-private-col-v">' + escHtml(durationNum) +
      ' <small>' + escHtml(minLab) + '</small></span></div>' +
    '<div class="portal-admin-private-col portal-admin-private-col-eq">' +
      '<span class="portal-admin-private-col-k">' + escHtml(portalT('admin.courseEquipment.editorTitle') || 'Equipment') + '</span>' +
      '<div class="portal-admin-private-col-v">' + adminRenderPrivateEquipmentInline(p.equipment_options || []) + '</div></div>';
  if (showEdit) {
    html += '<div class="portal-admin-private-col portal-admin-private-col-edit">' +
      '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-private-lesson" aria-label="' +
      escHtml(portalT('admin.action.edit')) + '">✎</button></div>';
  }
  html += '</div>';
  if (p.notes) {
    html += '<div class="portal-admin-private-closed-notes" data-admin-private-closed-notes="1">' +
      '<span class="portal-admin-private-col-k">' + escHtml(portalT('admin.privateLessons.notes')) + '</span>' +
      '<span class="portal-admin-private-closed-notes-v">' + escHtml(p.notes) + '</span></div>';
  }
  return html;
}
function renderAdminPrivateLessonCard(cfg, writes){
  var pl = (cfg && cfg.private_lesson) ? cfg.private_lesson : { enabled: false, label: portalT('admin.privateLessons.defaultName'), amount_cents: 0, currency: 'EUR', default_duration_minutes: 120, notes: '' };
  var editing = writes && adminEditTarget === 'private-lesson';
  var canEdit = !!(writes && !editing && !adminLessonSectionEditing() && !adminPackSectionEditing());
  var html = '<div class="portal-admin-subsection"><div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title">' + escHtml(portalT('admin.privateLessons.title')) + '</h3>';
  // Edit control lives on the closed 2a row (full-width columns mockup) — not the title row.
  html += '</div></div><p class="portal-admin-muted">' + escHtml(portalT('admin.privateLessons.help')) + '</p>';
  html += '<article class="portal-admin-lesson-card portal-admin-private-lesson-card" data-admin-private-lesson-card="1">';
  if (editing) html += renderAdminPrivateLessonEditForm(pl);
  else html += renderAdminPrivateLessonReadout(pl, { showEdit: canEdit });
  html += '</article></div>';
  return html;
}
function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  var packs = (cfg && cfg.surf_packs) ? cfg.surf_packs : [];
  var defaultCap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  // Course equipment is owned per Group/Private card (equipment_options). The obsolete
  // location-wide Equipment + Price (All Day + Surfboard/Wetsuit) block is retired.
  box.innerHTML = renderAdminPackCards(packs, writes, defaultCap) + renderAdminPrivateLessonCard(cfg, writes);
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
function adminAccommodationFromCfg(cfg){
  var a = (cfg && cfg.accommodation) || {};
  return {
    enabled: a.enabled === true,
    currency: String(a.currency || 'EUR').toUpperCase() || 'EUR',
    ranges: Array.isArray(a.ranges) ? a.ranges.slice() : [],
    source: a.source || 'default',
  };
}

function adminFormatAccomEuro(cents){
  var n = Number(cents);
  if (!Number.isFinite(n)) n = 0;
  return (n / 100).toFixed(2);
}

function renderAdminAccommodationRangeRows(ranges, editing){
  var html = '';
  if (!ranges.length){
    html += '<p class="portal-admin-muted" data-i18n="admin.accommodation.noRanges">' +
      escHtml(portalT('admin.accommodation.noRanges') || 'No seasonal ranges yet.') + '</p>';
    return html;
  }
  html += '<div class="portal-admin-accommodation-range-list" data-testid="admin-accommodation-ranges">';
  ranges.forEach(function(r, idx){
    html += '<article class="portal-admin-price-card portal-admin-accommodation-range" data-accom-range-idx="' + idx + '">';
    if (editing){
      // Title | date range | price columns (+ remove). Dates share one cell so columns line up.
      html += '<div class="portal-admin-accommodation-range-row is-editing">';
      html += '<div class="portal-admin-accommodation-col-title"><label data-i18n="admin.accommodation.rangeTitle">' +
        escHtml(portalT('admin.accommodation.rangeTitle') || 'Title') + '</label>';
      html += '<input type="text" maxlength="120" data-accom-field="title" value="' + escHtml(r.title || '') + '"></div>';
      html += '<div class="portal-admin-accommodation-col-dates">';
      html += '<label data-i18n="admin.accommodation.checkIn">' + escHtml(portalT('admin.accommodation.checkIn') || 'Check in') +
        ' → ' + escHtml(portalT('admin.accommodation.checkOut') || 'Check out') + '</label>';
      html += '<div style="display:flex;gap:6px;min-width:0;flex-wrap:wrap">';
      html += '<input type="date" data-accom-field="check_in" value="' + escHtml(r.check_in || '') + '" style="flex:1 1 7rem;min-width:0">';
      html += '<input type="date" data-accom-field="check_out" value="' + escHtml(r.check_out || '') + '" style="flex:1 1 7rem;min-width:0">';
      html += '</div></div>';
      html += '<div class="portal-admin-accommodation-col-price"><label data-i18n="admin.accommodation.nightlyEur">' +
        escHtml(portalT('admin.accommodation.nightlyEur') || 'Per night (€)') + '</label>';
      html += '<input type="text" inputmode="decimal" data-accom-field="amount_eur" value="' +
        escHtml(adminFormatAccomEuro(r.amount_cents)) + '"></div>';
      html += '<button type="button" class="btn btn-ghost portal-admin-danger portal-admin-icon-btn" data-admin-action="accom-remove-range" data-accom-range-idx="' +
        idx + '" aria-label="' + escHtml(portalT('admin.accommodation.removeRange') || 'Remove range') + '">×</button>';
      html += '</div>';
    } else {
      html += '<div class="portal-admin-accommodation-range-row" data-testid="admin-accommodation-range-row">';
      html += '<span class="portal-admin-accommodation-range-title">' + escHtml(r.title || '—') + '</span>';
      html += '<span class="portal-admin-accommodation-range-dates">' +
        escHtml((r.check_in || '') + ' → ' + (r.check_out || '')) + '</span>';
      html += '<span class="portal-admin-accommodation-range-price">€' + escHtml(adminFormatAccomEuro(r.amount_cents)) +
        ' <span class="portal-admin-muted">' + escHtml(portalT('admin.accommodation.perNight') || '/ night') + '</span></span>';
      html += '</div>';
    }
    html += '</article>';
  });
  html += '</div>';
  return html;
}

function renderAdminSectionAccommodationFromConfig(cfg){
  var box = el('admin-accommodation-body');
  if (!box) return;
  // Sunset Pricing only — section is in Admin HTML; hide for non-sunset clients.
  var sec = el('admin-sec-accommodation');
  if (typeof getClient === 'function' && getClient() !== 'sunset'){
    if (sec) sec.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  if (sec) sec.style.display = '';
  var writes = adminCfgWritesEnabled(cfg);
  var ac = adminAccommodationFromCfg(cfg);
  var editing = writes && adminEditTarget === 'accommodation';
  // Single top card title only (no section-hdr duplicate). Enabled sits beside title.
  var html = '<div class="portal-admin-subsection" data-testid="admin-accommodation-card">';
  html += '<div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
  html += '<h3 class="portal-admin-subsection-title" data-i18n="admin.accommodation.title">' +
    escHtml(portalT('admin.accommodation.title') || 'Accommodation') + '</h3>';
  html += '<span class="portal-admin-muted" data-testid="admin-accommodation-enabled-status">' + escHtml(ac.enabled
    ? (portalT('admin.accommodation.enabledYes') || 'Enabled')
    : (portalT('admin.accommodation.enabledNo') || 'Disabled')) + '</span>';
  html += '</div>';
  if (writes && !editing){
    html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-accommodation" aria-label="' +
      escHtml(portalT('admin.action.edit') || 'Edit') + '">✎</button></div>';
  }
  html += '</div>';
  // Help sentence intentionally not rendered (UI cleanup); i18n key retained for docs/verifiers.
  if (editing){
    html += '<div class="portal-admin-edit-form" data-testid="admin-accommodation-edit">';
    html += '<label class="portal-admin-equip-enabled"><input type="checkbox" id="admin-accom-enabled"' +
      (ac.enabled ? ' checked' : '') + '> ' +
      escHtml(portalT('admin.accommodation.enabled') || 'Enabled') + '</label>';
    html += renderAdminAccommodationRangeRows(ac.ranges, true);
    html += '<div class="portal-admin-edit-actions" style="margin-top:10px">';
    html += '<button type="button" class="btn btn-ghost" data-admin-action="accom-add-range">+ ' +
      escHtml(portalT('admin.accommodation.addRange') || 'Add season range') + '</button>';
    html += '<button type="button" class="btn btn-primary" data-admin-action="save-accommodation">' +
      escHtml(portalT('admin.action.save') || 'Save') + '</button>';
    html += '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' +
      escHtml(portalT('admin.action.cancel') || 'Cancel') + '</button>';
    html += '</div></div>';
  } else {
    html += renderAdminAccommodationRangeRows(ac.ranges, false);
  }
  html += '</div>';
  box.innerHTML = html;
}

function adminReadAccommodationDraftFromDom(){
  var enabledEl = el('admin-accom-enabled');
  var enabled = !!(enabledEl && enabledEl.checked);
  var ranges = [];
  var cards = document.querySelectorAll('article.portal-admin-accommodation-range[data-accom-range-idx]');
  cards.forEach(function(card){
    if (!card.querySelector) return;
    var titleEl = card.querySelector('[data-accom-field="title"]');
    if (!titleEl) return; // readout card
    var title = String(titleEl.value || '').trim();
    var checkIn = String((card.querySelector('[data-accom-field="check_in"]') || {}).value || '').trim();
    var checkOut = String((card.querySelector('[data-accom-field="check_out"]') || {}).value || '').trim();
    var eurRaw = String((card.querySelector('[data-accom-field="amount_eur"]') || {}).value || '').trim();
    // Strict 2-decimal helper (same owner as other Admin euro fields) — never float Math.round.
    var centsParsed = adminParseEurosToCents(eurRaw);
    ranges.push({
      title: title,
      check_in: checkIn,
      check_out: checkOut,
      amount_cents: centsParsed.ok ? centsParsed.value : 0,
    });
  });
  return { enabled: enabled, ranges: ranges, currency: 'EUR' };
}

// adminSaveAccommodation removed: unwired dead duplicate. Live save is the
// data-admin-action="save-accommodation" branch (adminApiRequest + adminReloadConfig).

function renderAdminFromConfig(cfg, opts){
  opts = opts || {};
  var preserve = !!(opts && opts.preserveDraft);
  if (preserve) adminSnapshotPricingDraftState();
  else adminClearPricingDraftState();
  // Fresh render / reload: drop stale equipment-local write errors only.
  // preserveDraft keeps form values but not equip error ownership from a prior save.
  // Unrelated shared #admin-save-msg notices keep their own lifecycle.
  if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
  renderAdminWriteState(cfg);
  if (typeof renderAdminSchoolContext === 'function') renderAdminSchoolContext(cfg);
  try { renderAdminSectionLessonTimesFromConfig(cfg); } catch (err) { console.error('admin lessons render failed', err); }
  try { renderAdminSectionPricesFromConfig(cfg); } catch (err) { console.error('admin prices render failed', err); }
  try { renderAdminSectionAccommodationFromConfig(cfg); } catch (err) { console.error('admin accommodation render failed', err); }
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
// Option B navigator state (client-only; server recomputes redesign for this view).
var financeViewState = { granularity: 'month', anchor: null, start: null, end: null };
var financeLastSummary = null;
var financeCustomDraft = { start: null, end: null };
var financeCustomViewYm = null;
var financeCustomFocusIso = null;
var financeCustomRestoreFocus = false;
var financeCustomDocWired = false;

function financeViewQuery(){
  var q = '';
  var g = financeViewState && financeViewState.granularity ? financeViewState.granularity : 'month';
  q += '&granularity=' + encodeURIComponent(g);
  if (g === 'custom'){
    if (financeViewState.start) q += '&start=' + encodeURIComponent(financeViewState.start);
    if (financeViewState.end) q += '&end=' + encodeURIComponent(financeViewState.end);
  } else if (financeViewState.anchor){
    q += '&anchor=' + encodeURIComponent(financeViewState.anchor);
  }
  return q;
}

function financeShiftAnchor(iso, gran, dir){
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  var parts = iso.split('-').map(Number);
  var y = parts[0], m = parts[1], d = parts[2];
  var dt = new Date(Date.UTC(y, m - 1, d));
  if (gran === 'day') dt.setUTCDate(dt.getUTCDate() + dir);
  else if (gran === 'year') dt.setUTCFullYear(dt.getUTCFullYear() + dir);
  else {
    // month
    dt.setUTCMonth(dt.getUTCMonth() + dir);
  }
  var yy = dt.getUTCFullYear();
  var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(dt.getUTCDate()).padStart(2, '0');
  return yy + '-' + mm + '-' + dd;
}

function financeDateIsValidIso(iso){
  var s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var parts = s.split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return dt.getUTCFullYear() === parts[0] && (dt.getUTCMonth() + 1) === parts[1] && dt.getUTCDate() === parts[2];
}

function financeTodayIso(){
  try {
    if (typeof schedulePortalMadridTodayIso === 'function') return schedulePortalMadridTodayIso();
  } catch (_e) { /* ignore */ }
  var now = new Date();
  return new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function financeCustomDisplayText(start, end){
  var fallback = 'Custom';
  if (typeof portalT === 'function') {
    var label = portalT('admin.finance.gran.custom');
    if (label && label !== 'admin.finance.gran.custom') fallback = label;
  }
  start = financeDateIsValidIso(start) ? String(start).slice(0, 10) : '';
  end = financeDateIsValidIso(end) ? String(end).slice(0, 10) : '';
  if (!start || !end) return fallback;
  return start === end ? start : (start + ' – ' + end);
}

function financeDateAddDays(iso, days){
  if (!financeDateIsValidIso(iso)) return null;
  var parts = String(iso).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + (days * 86400000)).toISOString().slice(0, 10);
}

function financeDateWeekStartIso(iso){
  if (!financeDateIsValidIso(iso)) return iso;
  var parts = String(iso).split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return financeDateAddDays(iso, -dt.getUTCDay());
}

function financeDateWeekEndIso(iso){
  if (!financeDateIsValidIso(iso)) return iso;
  var parts = String(iso).split('-').map(Number);
  var dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return financeDateAddDays(iso, 6 - dt.getUTCDay());
}

function financeDateMoveFocus(iso, key){
  iso = String(iso || '').slice(0, 10);
  if (!financeDateIsValidIso(iso)) return null;
  if (key === 'ArrowLeft') return financeDateAddDays(iso, -1);
  if (key === 'ArrowRight') return financeDateAddDays(iso, 1);
  if (key === 'ArrowUp') return financeDateAddDays(iso, -7);
  if (key === 'ArrowDown') return financeDateAddDays(iso, 7);
  if (key === 'Home') return financeDateWeekStartIso(iso);
  if (key === 'End') return financeDateWeekEndIso(iso);
  return null;
}

function financeSelectRangeDay(draft, iso){
  draft = draft || { start: null, end: null };
  iso = String(iso || '').slice(0, 10);
  if (!financeDateIsValidIso(iso)) return draft;
  if (typeof scheduleCreateDateRangeSelectDay === 'function') {
    return scheduleCreateDateRangeSelectDay(draft, iso) || draft;
  }
  var start = financeDateIsValidIso(draft.start) ? draft.start : null;
  var end = financeDateIsValidIso(draft.end) ? draft.end : null;
  if (!start || end) return { start: iso, end: null };
  if (iso < start) return { start: iso, end: null };
  return { start: start, end: iso };
}

function financeCustomSeedDraft(){
  var start = ''; var end = '';
  try {
    start = el('pfb-custom-start') ? String(el('pfb-custom-start').value || '').slice(0, 10) : '';
    end = el('pfb-custom-end') ? String(el('pfb-custom-end').value || '').slice(0, 10) : '';
  } catch (_e) { /* ignore */ }
  if (!start && financeViewState && financeViewState.granularity === 'custom') start = financeViewState.start || '';
  if (!end && financeViewState && financeViewState.granularity === 'custom') end = financeViewState.end || '';
  return {
    start: financeDateIsValidIso(start) ? start : null,
    end: financeDateIsValidIso(end) ? end : null,
  };
}

function financeEnsureCustomRangePop(){
  try {
    var existing = el('pfb-custom-range-pop');
    if (existing) return existing;
  } catch (_e) { /* ignore */ }
  var body = null;
  try { body = el('admin-finance-body'); } catch (_e2) { body = null; }
  if (!body || typeof document === 'undefined' || !document.createElement) return null;
  var host = body.querySelector ? body.querySelector('.pfb-custom-row--client-host') : null;
  if (!host) {
    host = document.createElement('div');
    host.className = 'pfb-custom-row pfb-custom-row--client-host';
    var nav = body.querySelector ? body.querySelector('.pfb-nav') : null;
    if (nav && nav.parentNode === body) {
      if (nav.nextSibling) body.insertBefore(host, nav.nextSibling);
      else body.appendChild(host);
    } else if (body.firstChild) {
      body.insertBefore(host, body.firstChild);
    } else {
      body.appendChild(host);
    }
  }
  var pop = document.createElement('div');
  pop.id = 'pfb-custom-range-pop';
  pop.className = 'portal-schedule-create-date-range-popover pfb-custom-popover';
  pop.hidden = true;
  pop.style.display = 'none';
  host.appendChild(pop);
  return pop;
}

function financeCustomIsOpen(){
  var pop = financeEnsureCustomRangePop();
  return !!(pop && !pop.hidden && pop.style && pop.style.display !== 'none');
}

function financeSyncCustomUi(){
  var draft = financeCustomIsOpen() ? (financeCustomDraft || {}) : financeCustomSeedDraft();
  var start = draft.start || '';
  var end = draft.end || '';
  var display = null;
  var trigger = null;
  try {
    display = el('pfb-custom-display');
    trigger = el('pfb-custom-range-trigger');
  } catch (_e) { /* ignore */ }
  if (display) display.textContent = financeCustomDisplayText(start, end);
  if (trigger) trigger.setAttribute('aria-expanded', financeCustomIsOpen() ? 'true' : 'false');
}

function financeCustomClosePopover(opts){
  opts = opts || {};
  var pop = financeEnsureCustomRangePop();
  var trigger = null;
  try { trigger = el('pfb-custom-range-trigger'); } catch (_e) { trigger = null; }
  if (pop) {
    pop.hidden = true;
    if (pop.style) pop.style.display = 'none';
  }
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (opts.discard !== false && opts.applied !== true) financeCustomDraft = financeCustomSeedDraft();
  var shouldRestore = opts.restoreFocus !== false && financeCustomRestoreFocus;
  financeCustomRestoreFocus = false;
  financeSyncCustomUi();
  if (shouldRestore && trigger && typeof trigger.focus === 'function') {
    try { trigger.focus(); } catch (_f) { /* ignore */ }
  }
}

function financeCustomFocusInto(){
  var grid = null;
  try { grid = el('pfb-custom-grid'); } catch (_e) { grid = null; }
  var focusIso = financeCustomFocusIso || (financeCustomDraft && financeCustomDraft.start) || null;
  var btn = null;
  if (grid && focusIso && typeof grid.querySelector === 'function') {
    try { btn = grid.querySelector('[data-date="' + focusIso + '"],[data-pfb-day="' + focusIso + '"]'); } catch (_q) { btn = null; }
  }
  if (!btn && grid && typeof grid.querySelector === 'function') {
    btn = grid.querySelector('.portal-schedule-create-date-range-day:not(.is-outside)') || grid.querySelector('[data-date],[data-pfb-day]');
  }
  if (btn && typeof btn.focus === 'function') {
    try { btn.focus(); } catch (_f1) { /* ignore */ }
    return;
  }
  var pop = financeEnsureCustomRangePop();
  var first = pop && typeof pop.querySelector === 'function'
    ? (pop.querySelector('#pfb-custom-prev') || pop.querySelector('button'))
    : null;
  if (first && typeof first.focus === 'function') {
    try { first.focus(); } catch (_f2) { /* ignore */ }
  }
}

function financeCustomLocaleTag(){
  var loc = 'en';
  try {
    if (typeof getStaffLocale === 'function') loc = String(getStaffLocale() || 'en');
  } catch (_e) { loc = 'en'; }
  loc = String(loc || 'en').toLowerCase();
  if (loc.indexOf('es') === 0) return 'es';
  if (loc.indexOf('it') === 0) return 'it';
  return 'en';
}

function financeCustomDateCellAriaLabel(iso, localeTag){
  var s = String(iso || '').slice(0, 10);
  if (!financeDateIsValidIso(s)) return s;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  var d = Number(s.slice(8, 10));
  try {
    return new Intl.DateTimeFormat(localeTag || 'en', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
  } catch (_e) {
    return s;
  }
}

function financeRenderCustomCalendar(){
  var grid = null;
  var monthLabel = null;
  try {
    grid = el('pfb-custom-grid');
    monthLabel = el('pfb-custom-month-label');
  } catch (_e) { /* ignore */ }
  if (!grid) return;
  var seed = (financeCustomDraft && financeCustomDraft.start) || financeViewState.start || financeViewState.anchor || financeTodayIso();
  var ym = financeCustomViewYm || String(seed).slice(0, 7);
  var parts = ym.split('-');
  var year = Number(parts[0]) || new Date().getFullYear();
  var month = Number(parts[1]) || (new Date().getMonth() + 1);
  if (month < 1) { month = 12; year -= 1; }
  if (month > 12) { month = 1; year += 1; }
  financeCustomViewYm = year + '-' + String(month).padStart(2, '0');
  if (monthLabel) monthLabel.textContent = financeCustomViewYm;
  var first = new Date(Date.UTC(year, month - 1, 1));
  var startDow = first.getUTCDay();
  var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  var prevDays = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  var draft = financeCustomDraft || {};
  var dStart = financeDateIsValidIso(draft.start) ? draft.start : null;
  var dEnd = financeDateIsValidIso(draft.end) ? draft.end : null;
  var rangeLo = dStart && dEnd ? dStart : null;
  var rangeHi = dStart && dEnd ? dEnd : null;
  var dayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  var html = '';
  for (var di = 0; di < 7; di += 1) {
    html += '<span class="portal-schedule-create-date-range-dow" aria-hidden="true">' + escHtml(dayLabels[di]) + '</span>';
  }
  var cells = [];
  for (var i = 0; i < startDow; i += 1) {
    var pd = prevDays - startDow + i + 1;
    var pMonth = month - 1;
    var pYear = year;
    if (pMonth < 1) { pMonth = 12; pYear -= 1; }
    cells.push({
      iso: pYear + '-' + String(pMonth).padStart(2, '0') + '-' + String(pd).padStart(2, '0'),
      day: pd,
      outside: true,
    });
  }
  for (var day = 1; day <= daysInMonth; day += 1) {
    cells.push({
      iso: year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0'),
      day: day,
      outside: false,
    });
  }
  while (cells.length % 7 !== 0) {
    var nd = cells.length - (startDow + daysInMonth) + 1;
    var nMonth = month + 1;
    var nYear = year;
    if (nMonth > 12) { nMonth = 1; nYear += 1; }
    cells.push({
      iso: nYear + '-' + String(nMonth).padStart(2, '0') + '-' + String(nd).padStart(2, '0'),
      day: nd,
      outside: true,
    });
  }
  var focusIso = financeCustomFocusIso;
  var hasFocusCell = focusIso && cells.some(function(c){ return c.iso === focusIso; });
  if (!hasFocusCell) {
    focusIso = dStart && cells.some(function(c){ return c.iso === dStart; }) ? dStart : null;
    if (!focusIso) {
      for (var fi = 0; fi < cells.length; fi += 1) {
        if (!cells[fi].outside) { focusIso = cells[fi].iso; break; }
      }
    }
    financeCustomFocusIso = focusIso;
  }
  var localeTag = financeCustomLocaleTag();
  cells.forEach(function(c){
    var cls = 'portal-schedule-create-date-range-day';
    var selected = false;
    if (c.outside) cls += ' is-outside';
    if (dStart && c.iso === dStart) { cls += ' is-selected-start is-selected is-start'; selected = true; }
    if (dEnd && c.iso === dEnd) { cls += ' is-selected-end is-selected is-end'; selected = true; }
    if (rangeLo && rangeHi && c.iso > rangeLo && c.iso < rangeHi) cls += ' is-in-range is-mid';
    html += '<button type="button" class="' + cls + '" tabindex="' + ((focusIso && c.iso === focusIso) ? '0' : '-1') +
      '" data-date="' + escHtml(c.iso) + '" data-pfb-day="' + escHtml(c.iso) + '" aria-label="' + escHtml(financeCustomDateCellAriaLabel(c.iso, localeTag)) +
      '" aria-pressed="' + (selected ? 'true' : 'false') + '">' + escHtml(String(c.day)) + '</button>';
  });
  grid.innerHTML = html;
  grid._financeCustomCells = cells;
  financeSyncCustomUi();
}

function financeApplyCustomDraft(){
  var draft = financeCustomDraft || {};
  var start = draft.start ? String(draft.start).slice(0, 10) : '';
  var end = draft.end ? String(draft.end).slice(0, 10) : '';
  if (!(financeDateIsValidIso(start) && financeDateIsValidIso(end) && start <= end)) return false;
  try {
    if (el('pfb-custom-start')) el('pfb-custom-start').value = start;
    if (el('pfb-custom-end')) el('pfb-custom-end').value = end;
  } catch (_e) { /* ignore */ }
  financeViewState.granularity = 'custom';
  financeViewState.start = start;
  financeViewState.end = end;
  financeViewState.anchor = start;
  financeCustomClosePopover({ restoreFocus: true, applied: true, discard: false });
  loadAdminFinanceSummary();
  return true;
}

function financeOpenCustomRangePicker(){
  var pop = financeEnsureCustomRangePop();
  if (!pop) return;
  financeCustomDraft = financeCustomSeedDraft();
  financeCustomFocusIso = financeCustomDraft.start || financeViewState.start || financeViewState.anchor || financeTodayIso();
  financeCustomViewYm = String(financeCustomFocusIso || financeTodayIso()).slice(0, 7);
  pop.hidden = false;
  if (pop.style) pop.style.display = '';
  try {
    var trigger = el('pfb-custom-range-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
  } catch (_e) { /* ignore */ }
  financeCustomRestoreFocus = true;
  financeRenderCustomCalendar();
  financeSyncCustomUi();
  financeCustomFocusInto();
}

function financeCustomTogglePopover(){
  if (financeCustomIsOpen()) financeCustomClosePopover({ restoreFocus: true, discard: true });
  else financeOpenCustomRangePicker();
}

function financeCustomOnDocumentKeydown(ev){
  if (!ev || (ev.key !== 'Escape' && ev.key !== 'Esc')) return;
  if (!financeCustomIsOpen()) return;
  if (ev.preventDefault) ev.preventDefault();
  financeCustomClosePopover({ restoreFocus: true, discard: true });
}

function financeCustomOnDocumentPointer(ev){
  if (!financeCustomIsOpen()) return;
  var t = ev && ev.target;
  var pop = financeEnsureCustomRangePop();
  var trigger = null;
  try { trigger = el('pfb-custom-range-trigger'); } catch (_e) { trigger = null; }
  if (pop && t && pop.contains && pop.contains(t)) return;
  if (trigger && t && (t === trigger || (trigger.contains && trigger.contains(t)))) return;
  financeCustomClosePopover({ restoreFocus: true, discard: true });
}

function wireFinanceCustomRange(){
  var trigger = null;
  try { trigger = el('pfb-custom-range-trigger'); } catch (_e) { trigger = null; }
  if (!trigger) return;
  var prev = null; var next = null; var grid = null; var clearBtn = null; var closeBtn = null;
  try {
    prev = el('pfb-custom-prev');
    next = el('pfb-custom-next');
    grid = el('pfb-custom-grid');
    clearBtn = el('pfb-custom-clear');
    closeBtn = el('pfb-custom-close');
  } catch (_e2) { /* ignore */ }
  if (prev && prev.dataset.wired !== '1') {
    prev.dataset.wired = '1';
    prev.addEventListener('click', function(){
      var ym = (financeCustomViewYm || financeTodayIso().slice(0, 7)).split('-');
      var y = Number(ym[0]); var m = Number(ym[1]) - 1;
      if (m < 1) { m = 12; y -= 1; }
      financeCustomViewYm = y + '-' + String(m).padStart(2, '0');
      financeRenderCustomCalendar();
    });
  }
  if (next && next.dataset.wired !== '1') {
    next.dataset.wired = '1';
    next.addEventListener('click', function(){
      var ym = (financeCustomViewYm || financeTodayIso().slice(0, 7)).split('-');
      var y = Number(ym[0]); var m = Number(ym[1]) + 1;
      if (m > 12) { m = 1; y += 1; }
      financeCustomViewYm = y + '-' + String(m).padStart(2, '0');
      financeRenderCustomCalendar();
    });
  }
  if (grid && grid.dataset.wired !== '1') {
    grid.dataset.wired = '1';
    grid.addEventListener('click', function(ev){
      var t = ev && ev.target;
      var btn = t && t.closest ? t.closest('[data-date],[data-pfb-day]') : null;
      if (!btn || !(grid.contains ? grid.contains(btn) : true)) return;
      var iso = btn.getAttribute('data-date') || btn.getAttribute('data-pfb-day');
      financeCustomDraft = financeSelectRangeDay(financeCustomDraft, iso);
      financeCustomFocusIso = iso;
      if (financeApplyCustomDraft()) return;
      financeRenderCustomCalendar();
      financeCustomFocusInto();
    });
    grid.addEventListener('keydown', function(ev){
      if (!ev) return;
      var t = ev.target;
      var btn = t && t.closest ? t.closest('[data-date],[data-pfb-day]') : null;
      if (!btn || !(grid.contains ? grid.contains(btn) : true)) return;
      var iso = btn.getAttribute('data-date') || btn.getAttribute('data-pfb-day');
      var key = ev.key || ev.code;
      if (key === 'Enter' || key === ' ' || key === 'Spacebar' || key === 'Space') {
        if (ev.preventDefault) ev.preventDefault();
        financeCustomDraft = financeSelectRangeDay(financeCustomDraft, iso);
        financeCustomFocusIso = iso;
        if (financeApplyCustomDraft()) return;
        financeRenderCustomCalendar();
        financeCustomFocusInto();
        return;
      }
      var nextIso = financeDateMoveFocus(iso, key);
      if (!nextIso) return;
      if (ev.preventDefault) ev.preventDefault();
      financeCustomFocusIso = nextIso;
      var nextYm = String(nextIso).slice(0, 7);
      if (nextYm && nextYm !== financeCustomViewYm) financeCustomViewYm = nextYm;
      financeRenderCustomCalendar();
      financeCustomFocusInto();
    });
  }
  if (clearBtn && clearBtn.dataset.wired !== '1') {
    clearBtn.dataset.wired = '1';
    clearBtn.addEventListener('click', function(){
      financeCustomDraft = { start: null, end: null };
      financeCustomFocusIso = null;
      financeRenderCustomCalendar();
      financeCustomFocusInto();
    });
  }
  if (closeBtn && closeBtn.dataset.wired !== '1') {
    closeBtn.dataset.wired = '1';
    closeBtn.addEventListener('click', function(){
      financeCustomClosePopover({ restoreFocus: true, discard: false });
    });
  }
  if (!financeCustomDocWired) {
    financeCustomDocWired = true;
    try {
      document.addEventListener('keydown', financeCustomOnDocumentKeydown);
      document.addEventListener('mousedown', financeCustomOnDocumentPointer);
    } catch (_doc) { /* ignore */ }
  }
  financeSyncCustomUi();
}

function wireFinanceRedesignNav(body){
  if (!body) return;
  wireFinanceCustomRange();
  if (body.dataset.financeNavWired === '1') return;
  body.dataset.financeNavWired = '1';
  body.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest('[data-finance-nav], [data-finance-gran], [data-finance-trend]');
    if (!btn || !body.contains(btn)) return;

    var trend = btn.getAttribute('data-finance-trend');
    if (trend === 'days' || trend === 'month' || trend === 'year' || trend === '12m' || trend === 'months') {
      if (ev && ev.preventDefault) ev.preventDefault();
      var mode = (trend === 'year' || trend === '12m' || trend === 'months') ? 'year' : 'days';
      try { window.__financeTrendMode = mode; } catch (_t) { /* ignore */ }
      if (financeLastSummary && typeof renderFinanceRedesignHtml === 'function') body.innerHTML = renderFinanceRedesignHtml(financeLastSummary);
      else loadAdminFinanceSummary();
      return;
    }

    var gran = btn.getAttribute('data-finance-gran');
    if (gran){
      if (gran === 'custom') {
        if (ev && ev.preventDefault) ev.preventDefault();
        financeCustomTogglePopover();
        return;
      }
      financeViewState.granularity = gran;
      financeViewState.start = null;
      financeViewState.end = null;
      financeCustomDraft = { start: null, end: null };
      try {
        if (el('pfb-custom-start')) el('pfb-custom-start').value = '';
        if (el('pfb-custom-end')) el('pfb-custom-end').value = '';
      } catch (_h) { /* ignore */ }
      financeCustomClosePopover({ restoreFocus: false, discard: false });
      financeViewState.anchor = financeTodayIso();
      loadAdminFinanceSummary();
      return;
    }

    var nav = btn.getAttribute('data-finance-nav');
    if (nav === 'prev' || nav === 'next'){
      var dir = nav === 'prev' ? -1 : 1;
      var g = financeViewState.granularity || 'month';
      if (g === 'custom') return;
      var anchor = financeViewState.anchor || financeTodayIso();
      financeViewState.anchor = financeShiftAnchor(anchor, g, dir);
      loadAdminFinanceSummary();
      return;
    }
    if (nav === 'open-custom-range'){
      if (ev && ev.preventDefault) ev.preventDefault();
      financeCustomTogglePopover();
      return;
    }
  });
}


function loadAdminFinanceSummary(opts){
  opts = opts || {};
  var body = el('admin-finance-body');
  if (!body) return;
  var seq = ++financeLoadSeq;
  var originClient = getClient();
  var originLocation = originClient === 'sunset' ? getSunsetLocation() : '';
  body.innerHTML = '<div class="portal-admin-finance-loading" role="status">' +
    escHtml(portalT('admin.finance.loading')) + '</div>';
  var url = '/staff/admin/finance/summary' + adminClientQuery() + financeViewQuery();
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
        // Sync anchor from server redesign view when present.
        if (data.summary.redesign && data.summary.redesign.view && data.summary.redesign.view.range){
          financeViewState.granularity = data.summary.redesign.view.granularity || financeViewState.granularity || 'month';
          financeViewState.anchor = data.summary.redesign.view.range.start;
          if (financeViewState.granularity === 'custom') {
            financeViewState.start = data.summary.redesign.view.range.start || null;
            financeViewState.end = data.summary.redesign.view.range.end || null;
          } else {
            financeViewState.start = null;
            financeViewState.end = null;
          }
        }
        financeLastSummary = data.summary;
        body.innerHTML = renderFinanceSummaryHtml(data.summary);
        wireFinanceRedesignNav(body);
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
  // Option B redesign when server provides redesign block + renderer is injected.
  if (summary && summary.redesign && typeof renderFinanceRedesignHtml === 'function'){
    return renderFinanceRedesignHtml(summary);
  }
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
  var next = (key === 'pricing' || key === 'luna-staff' || key === 'bookings' || key === 'email') ? key : 'finance';
  var prevSub = adminActiveSubTab;
  adminActiveSubTab = next;
  // Leaving Email panel: invalidate/abort any pending Phase B reauthorization.
  if (prevSub === 'email' && next !== 'email'
      && typeof cancelAdminEmailReauthorization === 'function') {
    cancelAdminEmailReauthorization();
  }
  // Rental write errors are operation-scoped — never stick across Admin subtabs.
  // Equipment-local only: do not hide unrelated shared Admin notices.
  if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
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
  var bookingsPanel = el('admin-panel-bookings');
  var prPanel = el('admin-panel-pricing');
  var lunaAdminPanel = el('admin-panel-luna-staff');
  var emailPanel = el('admin-panel-email');
  var lunaPanel = el('tab-ask-luna');
  if (finPanel){
    if (next === 'finance') finPanel.removeAttribute('hidden');
    else finPanel.setAttribute('hidden', '');
  }
  if (bookingsPanel){
    if (next === 'bookings') bookingsPanel.removeAttribute('hidden');
    else bookingsPanel.setAttribute('hidden', '');
  }
  if (prPanel){
    if (next === 'pricing') prPanel.removeAttribute('hidden');
    else prPanel.setAttribute('hidden', '');
  }
  if (lunaAdminPanel){
    if (next === 'luna-staff') lunaAdminPanel.removeAttribute('hidden');
    else lunaAdminPanel.setAttribute('hidden', '');
  }
  if (emailPanel){
    if (next === 'email') emailPanel.removeAttribute('hidden');
    else emailPanel.setAttribute('hidden', '');
  }
  if (lunaPanel) lunaPanel.classList.toggle('active', next === 'luna-staff');
  if (next === 'luna-staff' && typeof wireLunaStaffTabCards === 'function') wireLunaStaffTabCards();
  if (next === 'email' && typeof loadAdminEmailSettings === 'function') loadAdminEmailSettings();
  if (next === 'bookings' && typeof renderAdminBookingsShell === 'function') {
    var bookingsBody = el('admin-bookings-body');
    if (bookingsBody && !bookingsBody.dataset.bookingsMounted) {
      bookingsBody.dataset.bookingsMounted = '1';
      renderAdminBookingsShell();
    } else if (typeof loadAdminBookings === 'function') {
      loadAdminBookings();
    }
  }
}

function adminSyncEmailTabVisibility(){
  var tab = el('admin-tab-email');
  var panel = el('admin-panel-email');
  if (!tab) return;
  var available = getClient() === 'sunset';
  if (available) tab.removeAttribute('hidden');
  else tab.setAttribute('hidden', '');
  if (!available && panel) panel.setAttribute('hidden', '');
  if (!available && adminActiveSubTab === 'email') {
    adminActiveSubTab = 'finance';
    // Client left Sunset Email surface: abort pending reauthorization.
    if (typeof cancelAdminEmailReauthorization === 'function') cancelAdminEmailReauthorization();
  }
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
  // Admin re-entry / reload: abort pending Email reauthorization before re-render.
  if (typeof cancelAdminEmailReauthorization === 'function') cancelAdminEmailReauthorization();
  adminSyncEmailTabVisibility();
  wireAdminTab();
  wireAdminSubTabs();
  // Equipment-local only on Admin load/re-entry (shared banner retains own lifecycle).
  if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
  if (opts.resetSubTab) {
    adminActiveSubTab = 'finance';
    // Deliberate Admin reopen/reload — drop any in-memory Pricing drafts.
    adminClearPricingDraftState();
  }
  if (adminActiveSubTab !== 'pricing' && adminActiveSubTab !== 'finance' && adminActiveSubTab !== 'luna-staff' && adminActiveSubTab !== 'bookings' && adminActiveSubTab !== 'email') adminActiveSubTab = 'finance';
  adminSelectSubTab(adminActiveSubTab);
  renderAdminFinanceShell();
  if (adminActiveSubTab === 'bookings' && typeof renderAdminBookingsShell === 'function') {
    var bookingsBodyOnLoad = el('admin-bookings-body');
    if (bookingsBodyOnLoad && !bookingsBodyOnLoad.dataset.bookingsMounted) {
      bookingsBodyOnLoad.dataset.bookingsMounted = '1';
      renderAdminBookingsShell();
    }
  }
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
    var request = fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
    Promise.race([request, timeout])
      .then(function(data){
        clearAdminLoadTimeout();
        if (loadSeq !== adminLoadSeq) return;
        if (!data || data.success !== true) return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
        return fetch('/staff/admin/config/rental-offerings' + adminClientQuery() + '&include_inactive=true&_ts=' + Date.now(), { credentials:'same-origin', cache:'no-store', headers:{Accept:'application/json'} })
          .then(function(r){return r.ok?r.json():{offerings:[]};}).catch(function(){return {offerings:[]};})
          .then(function(catalog){
        data._equipment_offerings = catalog && Array.isArray(catalog.offerings) ? catalog.offerings : (data.rental_offerings || []);
        adminConfigCache = data;
        if (!adminCfgWritesEnabled(data)) adminEditTarget = null;
        // Canonical config load — server truth, no draft replay.
        renderAdminFromConfig(data);
        adminSelectSubTab(adminActiveSubTab || 'finance');
        if (state) state.style.display = 'none';
        adminReleaseBusy(loadSeq);
          });
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
    // Do not preventDefault on native checkboxes — that blocks Enabled/Disabled flips.
    // (course-equipment-policy is a non-submit control that also must keep default.)
    if (action !== 'course-equipment-policy' && action !== 'toggle-equip-enabled') ev.preventDefault();
    var cfg = adminConfigCache;
    if (!cfg && action !== 'toggle-pill'){
      adminShowMessage('error', portalT('admin.loading'));
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
    if (action === 'add-equipment-option'){
      var equipmentEditor=btn.closest('[data-admin-equipment-editor]');
      var equipmentWrap=equipmentEditor&&equipmentEditor.querySelector('[data-equipment-option-rows]');
      if(!equipmentWrap)return;
      var equipmentRows=adminDraftEquipmentRowsFromDom(equipmentEditor);
      equipmentRows.push({offering_key:'',during_course_price_cents:0,all_day_price_cents:0,during_course_policy:'included'});
      equipmentWrap.innerHTML=adminEquipmentRowsHtml(equipmentRows);
      adminSyncEquipmentEditorHeadingAdd(equipmentEditor, equipmentRows.length);
      return;
    }
    if (action === 'add-secondary-schedule'){
      // Reveal Second Start/End without submit; primary values stay untouched.
      var schedulePrefix = String(btn.getAttribute('data-schedule-prefix') || '').trim();
      if (!schedulePrefix) return;
      if (document.getElementById(schedulePrefix + '-schedule-start2')) return;
      btn.insertAdjacentHTML('beforebegin', adminPackSecondaryScheduleRowHtml(schedulePrefix, { start: '', end: '' }));
      if (btn.parentNode) btn.parentNode.removeChild(btn);
      return;
    }
    if (action === 'remove-equipment-option'){
      var equipmentEditorRm=btn.closest('[data-admin-equipment-editor]');
      var equipmentRow=btn.closest('[data-equipment-option-row]');
      if(equipmentRow)equipmentRow.remove();
      if(equipmentEditorRm){
        var equipmentWrapRm=equipmentEditorRm.querySelector('[data-equipment-option-rows]');
        var remaining=adminDraftEquipmentRowsFromDom(equipmentEditorRm);
        if(equipmentWrapRm) equipmentWrapRm.innerHTML=adminEquipmentRowsHtml(remaining);
        adminSyncEquipmentEditorHeadingAdd(equipmentEditorRm, remaining.length);
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
    if (action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'delete-rental-offering' || action === 'save-price-group' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-new-price' || action === 'save-time' || action === 'save-new-time' || action === 'add-pack' || action === 'edit-pack' || action === 'delete-pack' || action === 'save-pack' || action === 'save-new-pack' || action === 'edit-private-lesson' || action === 'save-private-lesson' || action === 'toggle-group-availability' || action === 'toggle-equip-enabled' || action === 'add-equipment' || action === 'edit-equipment' || action === 'add-equip-price' || action === 'save-new-equipment' || action === 'save-price-amount' || action === 'save-equip-meta' || action === 'save-equipment' || action === 'edit-accommodation' || action === 'save-accommodation' || action === 'accom-add-range' || action === 'accom-remove-range'){
      if (!adminCfgWritesEnabled(cfg)) return;
    }
    if (action === 'delete-rental-offering'){
      // Equipment hard delete is only reachable from the edit footer (no browse overflow).
      var delEquipKey = String(btn.getAttribute('data-equip-key') || '').trim();
      if (!delEquipKey){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      // Hard delete: rental identity + all duration prices + course links permanently.
      // Duration-row × is a separate action (delete-price / removeDuration).
      if (!window.confirm(portalT('admin.prices.deleteRentalConfirm'))) return;
      var delEquipOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('DELETE', '/staff/admin/config/rental-offerings/' + encodeURIComponent(delEquipKey) + adminClientQuery(), {})
        .then(function(res){
          if (!adminOpStillOwns(delEquipOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(delEquipOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.prices.deletedRental') || portalT('admin.edit.savedPrice'));
          adminReleaseBusy(delEquipOpSeq);
          // Clear edit target so the deleted card does not re-open edit mode after reload.
          adminEditTarget = null;
          // Fresh config + offering catalog so cards/dropdowns drop this key immediately (no page.reload).
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(delEquipOpSeq)) return;
          adminReleaseBusy(delEquipOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(delEquipOpSeq)) return;
        adminReleaseBusy(delEquipOpSeq);
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + (syncErr && syncErr.message ? syncErr.message : String(syncErr)));
      }
      return;
    }
    if (action === 'toggle-equip-enabled'){
      // Staged UI only — active is committed by save-equipment (Cancel discards).
      var toggleEquipKey = String(btn.getAttribute('data-equip-key') || '').trim();
      var toggleEquipActive = !!(btn.checked);
      if (!toggleEquipKey) return;
      var toggleCard = btn.closest ? btn.closest('[data-admin-equip]') : null;
      if (toggleCard) {
        if (toggleEquipActive) toggleCard.classList.remove('is-equip-disabled');
        else toggleCard.classList.add('is-equip-disabled');
        toggleCard.setAttribute('data-equip-active-draft', toggleEquipActive ? '1' : '0');
        toggleCard.setAttribute('data-equip-active', toggleEquipActive ? '1' : '0');
        // Live-update heading status affordance without inventing persistence.
        var statusTxt = adminEquipEnabledLabel(toggleEquipActive);
        var dots = toggleCard.querySelectorAll('.portal-admin-equip-status-dot');
        for (var di = 0; di < dots.length; di++) {
          dots[di].classList.toggle('is-on', toggleEquipActive);
          dots[di].classList.toggle('is-off', !toggleEquipActive);
        }
        var labels = toggleCard.querySelectorAll('[data-equip-active-label]');
        for (var li = 0; li < labels.length; li++) {
          labels[li].setAttribute('data-equip-active-label', toggleEquipActive ? '1' : '0');
          labels[li].textContent = statusTxt;
        }
      }
      return;
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
      // Cancel drops rental-edit ownership only — not unrelated Admin notices.
      if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
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
      // Keep group or per-item equipment edit after removing a duration price.
      var keepGroupEdit = null;
      if (adminEditTarget) {
        var keepT = String(adminEditTarget);
        if (keepT.indexOf('price-group:') === 0 || keepT.indexOf('equip:') === 0) keepGroupEdit = adminEditTarget;
      }
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
          // Stay in item pencil mode after nested add (no page.reload).
          adminReloadConfigKeepingEdit('equip:' + addPriceKey);
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

    if (action === 'save-equipment'){
      // Single atomic server commit (meta + active + durations + optional new duration).
      var seKey = String(btn.getAttribute('data-equip-key') || '').trim();
      if (!seKey){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var seCard = document.querySelector('[data-admin-equip="' + seKey + '"]');
      var seNameEl = el('admin-equip-name-' + seKey);
      var seStockEl = el('admin-equip-stock-' + seKey);
      var seName = seNameEl ? String(seNameEl.value || '').trim() : '';
      if (!seName){ adminShowEquipError(seKey, portalT('admin.prices.equipmentNameRequired') || 'Enter an equipment name'); return; }
      var seBody = { label: seName, prices: [], new_prices: [] };
      var seStockRaw = seStockEl ? String(seStockEl.value || '').trim() : '';
      if (seStockRaw === '') {
        seBody.stock_quantity = null;
      } else {
        var seStockNum = parseInt(seStockRaw, 10);
        if (!Number.isInteger(seStockNum) || seStockNum < 0 || seStockNum > 999 || String(seStockNum) !== seStockRaw) {
          adminShowEquipError(seKey, portalT('admin.prices.stockInvalid') || 'Stock must be a whole number 0–999 or blank');
          return;
        }
        seBody.stock_quantity = seStockNum;
      }
      var seActiveEl = seCard
        ? seCard.querySelector('input[data-admin-action="toggle-equip-enabled"]')
        : null;
      if (seActiveEl) seBody.active = !!seActiveEl.checked;

      var seGrid = el('admin-prices-card-grid-' + seKey);
      if (seGrid) {
        var seCards = seGrid.querySelectorAll('[data-admin-price-card]');
        var sePriceErr = '';
        seCards.forEach(function(card){
          var pid = String(card.getAttribute('data-admin-price-card') || '').trim();
          if (!pid) return;
          if (card.querySelector && card.querySelector('[data-admin-duration-invalid]')) {
            sePriceErr = portalT('admin.prices.invalidDuration') || 'Enter a valid duration';
            return;
          }
          var amountInput = card.querySelector('[data-admin-price-field="amount"]') || el('admin-price-amount-' + adminPriceInputKey(pid));
          var cents = adminParseEurosToCents(amountInput && amountInput.value);
          if (!cents.ok){ sePriceErr = cents.error; return; }
          if (!(cents.value > 0)){ sePriceErr = portalT('admin.edit.amountRequiredToEnable'); return; }
          var row = { id: pid, amount_cents: cents.value };
          var durPrefix = 'admin-price-' + adminPriceInputKey(pid);
          var dur = adminReadDurationControl(durPrefix);
          if (dur && dur.duration_key) row.period_window = dur.duration_key;
          else if (dur && (dur.count != null || dur.unit)) {
            sePriceErr = portalT('admin.prices.invalidDuration') || 'Enter a valid duration';
            return;
          }
          seBody.prices.push(row);
        });
        if (sePriceErr){ adminShowEquipError(seKey, sePriceErr); return; }
      }

      var draftAmountEl = el('admin-new-price-amount');
      var draftForm = document.getElementById('admin-add-price-form');
      if (draftForm && draftAmountEl && String(draftAmountEl.value || '').trim() !== '') {
        var draftDur = adminReadDurationControl('admin-new-price');
        if (!draftDur.duration_key){ adminShowEquipError(seKey, portalT('admin.prices.invalidDuration') || 'Enter a valid duration'); return; }
        var draftCents = adminParseEurosToCents(draftAmountEl.value);
        if (!draftCents.ok){ adminShowEquipError(seKey, draftCents.error); return; }
        if (!(draftCents.value > 0)){ adminShowEquipError(seKey, portalT('admin.edit.amountRequiredToEnable')); return; }
        seBody.new_prices.push({
          period_window: draftDur.duration_key,
          amount_cents: draftCents.value,
        });
      }

      var seOpSeq = adminBeginOp();
      // Clear this operation's prior local equip error only (not shared Admin notices).
      if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
      adminApiRequest(
        'POST',
        '/staff/admin/config/rental-offerings/' + encodeURIComponent(seKey) + '/commit' + adminClientQuery(),
        seBody,
      ).then(function(res){
        if (!adminOpStillOwns(seOpSeq)) return;
        if (res.status !== 200 || !res.data || res.data.success !== true){
          adminReleaseBusy(seOpSeq);
          var em = (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status);
          if (/rental_name_already_exists/i.test(String(em))) {
            adminShowEquipError(seKey, portalT('admin.prices.rentalNameExists') || em);
          } else {
            adminShowEquipError(seKey, em);
          }
          return;
        }
        // Success: clear own equip error, then own the global banner with success.
        if (typeof adminClearEquipErrors === 'function') adminClearEquipErrors();
        adminShowMessage('success', portalT('admin.edit.savedPrice') || 'Saved.');
        adminReleaseBusy(seOpSeq);
        adminEditTarget = null;
        adminReloadConfig();
      }).catch(function(err){
        if (!adminOpStillOwns(seOpSeq)) return;
        adminReleaseBusy(seOpSeq);
        adminShowEquipError(seKey, portalT('admin.edit.saveFailed') + ' ' + (err && err.message ? err.message : String(err)));
      });
      return;
    }
    if (action === 'save-equip-meta'){
      var metaKey = String(btn.getAttribute('data-equip-key') || '').trim();
      if (!metaKey){ adminShowMessage('error', portalT('admin.edit.saveFailed')); return; }
      var metaNameEl = el('admin-equip-name-' + metaKey);
      var metaStockEl = el('admin-equip-stock-' + metaKey);
      var metaName = metaNameEl ? String(metaNameEl.value || '').trim() : '';
      if (!metaName){ adminShowMessage('error', portalT('admin.prices.equipmentNameRequired') || 'Enter an equipment name'); return; }
      var metaBody = { label: metaName };
      var stockRaw = metaStockEl ? String(metaStockEl.value || '').trim() : '';
      if (stockRaw === '') {
        metaBody.stock_quantity = null;
      } else {
        var stockNum = parseInt(stockRaw, 10);
        if (!Number.isInteger(stockNum) || stockNum < 0 || stockNum > 999 || String(stockNum) !== stockRaw) {
          adminShowMessage('error', portalT('admin.prices.stockInvalid') || 'Stock must be a whole number 0–999 or blank');
          return;
        }
        metaBody.stock_quantity = stockNum;
      }
      var metaOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PATCH', '/staff/admin/config/rental-offerings/' + encodeURIComponent(metaKey) + adminClientQuery(), metaBody)
        .then(function(res){
          if (!adminOpStillOwns(metaOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(metaOpSeq);
            var metaErr = (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status);
            if (/rental_name_already_exists/i.test(String(metaErr))) {
              adminShowMessage('error', portalT('admin.prices.rentalNameExists') || metaErr);
            } else {
              adminShowMessage('error', metaErr);
            }
            return;
          }
          adminShowMessage('success', portalT('admin.edit.savedPrice') || 'Saved.');
          adminReleaseBusy(metaOpSeq);
          adminReloadConfigKeepingEdit('equip:' + metaKey);
        }).catch(function(err){
          if (!adminOpStillOwns(metaOpSeq)) return;
          adminReleaseBusy(metaOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(metaOpSeq)) return;
        adminReleaseBusy(metaOpSeq);
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
      // Duration identity may change (e.g. 2 hours → 3 hours) atomically with amount.
      var spDurPrefix = 'admin-price-' + adminPriceInputKey(spPriceId);
      var spDur = adminReadDurationControl(spDurPrefix);
      var spPatch = { amount_cents: spCents.value };
      if (spDur && spDur.duration_key) {
        spPatch.period_window = spDur.duration_key;
      } else if (spDur && (spDur.count != null || spDur.unit)) {
        adminShowMessage('error', portalT('admin.prices.invalidDuration') || 'Enter a valid duration');
        return;
      }
      var spOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(spPriceId) + adminClientQuery(), spPatch)
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
      var eqStockInput = el('admin-new-equip-stock');
      var eqStockRaw = eqStockInput ? String(eqStockInput.value || '').trim() : '';
      var eqStockQty = null;
      if (eqStockRaw !== '') {
        var eqStockNum = parseInt(eqStockRaw, 10);
        if (!Number.isInteger(eqStockNum) || eqStockNum < 0 || eqStockNum > 999 || String(eqStockNum) !== eqStockRaw) {
          adminShowMessage('error', portalT('admin.prices.stockInvalid') || 'Stock must be a whole number 0–999 or blank');
          return;
        }
        eqStockQty = eqStockNum;
      }
      var eqOpSeq = adminBeginOp();
      adminShowMessage('', '');
      // Atomic create: offering + first duration price in one request (no partial catalog).
      // Do NOT append random suffixes to bypass name uniqueness. Preserve input on error.
      var createBody = {
        offering_key: eqKey,
        label: eqName,
        group_key: 'equipment',
        excludes: [],
        stock_quantity: eqStockQty,
        prices: [{ period_window: eqDur.duration_key, amount_cents: eqCents.value }],
      };
      adminApiRequest('POST', '/staff/admin/config/rental-offerings' + adminClientQuery(), createBody)
      .then(function(offRes){
        if (!adminOpStillOwns(eqOpSeq)) return;
        var offErr = offRes && offRes.data
          ? String(offRes.data.error || offRes.data.message || '')
          : '';
        if (offRes.status === 409 && /rental_name_already_exists/i.test(offErr)){
          adminReleaseBusy(eqOpSeq);
          adminShowMessage('error', portalT('admin.prices.rentalNameExists') || offErr);
          return;
        }
        if ((offRes.status !== 201 && offRes.status !== 200) || !offRes.data || offRes.data.success !== true){
          adminReleaseBusy(eqOpSeq);
          adminShowMessage('error', (offRes.data && (offRes.data.error || offRes.data.message)) || ('HTTP ' + offRes.status));
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
      var privateEquipment = adminReadEquipmentOptions(btn.closest('[data-admin-private-lesson-form]'));
      var labelText = String((labelEl && labelEl.value) || '').trim();
      if (!labelText){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      var priceParsed = adminParseEurosToCents(priceEl && priceEl.value);
      if (!priceParsed.ok){ adminShowMessage('error', priceParsed.error || portalT('admin.edit.amountInvalid')); return; }
      if (!privateEquipment.ok){ adminShowMessage('error', privateEquipment.error); return; }
      var durationVal = parseInt(String((durationEl && durationEl.value) || '120'), 10);
      if (!Number.isInteger(durationVal) || durationVal < 15 || durationVal > 480){
        adminShowMessage('error', portalT('admin.privateLessons.durationInvalid'));
        return;
      }
      var payload = {
        enabled: !!(enabledEl && enabledEl.checked),
        label: labelText,
        amount_cents: priceParsed.value,
        equipment_options: privateEquipment.value,
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
    if (action === 'edit-accommodation'){
      adminEditTarget = 'accommodation';
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }
    if (action === 'accom-add-range'){
      if (!adminConfigCache) return;
      if (!adminConfigCache.accommodation) {
        adminConfigCache.accommodation = { enabled: false, currency: 'EUR', ranges: [], source: 'default' };
      }
      var curRanges = Array.isArray(adminConfigCache.accommodation.ranges)
        ? adminConfigCache.accommodation.ranges.slice() : [];
      // Preserve in-progress DOM edits before re-render.
      var draft = adminReadAccommodationDraftFromDom();
      curRanges = draft.ranges && draft.ranges.length ? draft.ranges : curRanges;
      curRanges.push({ title: '', check_in: '', check_out: '', amount_cents: 0 });
      adminConfigCache.accommodation = {
        enabled: draft.enabled,
        currency: 'EUR',
        ranges: curRanges,
        source: adminConfigCache.accommodation.source || 'default',
      };
      adminEditTarget = 'accommodation';
      renderAdminFromConfig(adminConfigCache, { preserveDraft: false });
      return;
    }
    if (action === 'accom-remove-range'){
      var rmIdx = parseInt(String(btn.getAttribute('data-accom-range-idx') || ''), 10);
      if (!Number.isInteger(rmIdx) || rmIdx < 0 || !adminConfigCache) return;
      var draftRm = adminReadAccommodationDraftFromDom();
      var nextRanges = (draftRm.ranges || []).filter(function(_r, i){ return i !== rmIdx; });
      adminConfigCache.accommodation = {
        enabled: draftRm.enabled,
        currency: 'EUR',
        ranges: nextRanges,
        source: (adminConfigCache.accommodation && adminConfigCache.accommodation.source) || 'default',
      };
      adminEditTarget = 'accommodation';
      renderAdminFromConfig(adminConfigCache, { preserveDraft: false });
      return;
    }
    if (action === 'save-accommodation'){
      var accomDraft = adminReadAccommodationDraftFromDom();
      var saveAccomOpSeq = adminBeginOp();
      adminShowMessage('', '');
      try {
        adminApiRequest('PUT', '/staff/admin/config/accommodation' + adminClientQuery(), accomDraft)
        .then(function(res){
          if (!adminOpStillOwns(saveAccomOpSeq)) return;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminReleaseBusy(saveAccomOpSeq);
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminEditTarget = null;
          if (adminConfigCache && res.data.accommodation) {
            adminConfigCache.accommodation = res.data.accommodation;
          }
          adminShowMessage('success', portalT('admin.accommodation.saved') || 'Accommodation saved.');
          adminReleaseBusy(saveAccomOpSeq);
          adminReloadConfig();
        }).catch(function(err){
          if (!adminOpStillOwns(saveAccomOpSeq)) return;
          adminReleaseBusy(saveAccomOpSeq);
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      } catch (syncErr) {
        if (!adminOpStillOwns(saveAccomOpSeq)) return;
        adminReleaseBusy(saveAccomOpSeq);
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
      if (payload._equipmentError){ adminShowMessage('error', payload._equipmentError); return; }
      delete payload._equipmentError;
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
