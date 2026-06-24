var adminConfigCache = null;
var adminEditTarget = null;
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

var adminSaveBusy = false;
var adminLoadSeq = 0;

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

function adminReloadConfigKeepingEdit(keepTarget){
  var saved = keepTarget || null;
  adminSaveBusy = false;
  var url = '/staff/admin/config' + adminClientQuery();
  fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function(data){
      if (!data || data.success !== true) return Promise.reject(new Error('load failed'));
      adminConfigCache = data;
      adminEditTarget = saved;
      renderAdminFromConfig(data);
    })
    .catch(function(e){
      adminEditTarget = saved;
      adminShowMessage('error', portalT('admin.error') + ' ' + e.message);
      if (adminConfigCache) renderAdminFromConfig(adminConfigCache);
    });
}

function adminReloadConfig(){
  adminEditTarget = null;
  adminSaveBusy = false;
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

var ADMIN_DEFAULT_PRICE_TIERS = [
  { key: '1_week', label: 'Price for 1 week (10 hours)', hours: 10, amount_cents: 18000 },
  { key: '2_weeks', label: 'Price for 2 weeks (20 hours)', hours: 20, amount_cents: 33500 },
  { key: '3_weeks', label: 'Price for 3 weeks (30 hours)', hours: 30, amount_cents: 48000 },
  { key: '4_weeks', label: 'Price for 4 weeks (40 hours)', hours: 40, amount_cents: 60000 },
  { key: 'single_class', label: 'Price for 1 single class (2 hours)', hours: 2, amount_cents: 4000 },
];
function adminDefaultPackConfigSeed(){
  return {
    age_band: '12_and_up',
    group_size: 16,
    beaches: ['el_sardinero', 'liencres', 'somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130', '1215_1415'],
    price_tiers: ADMIN_DEFAULT_PRICE_TIERS.map(function(t){ return Object.assign({}, t); }),
  };
}

function adminDefaultPackSeed(){
  var d = adminDefaultPackConfigSeed();
  return { label: portalT('admin.packs.defaultName'), age_band: d.age_band, group_size: d.group_size, beaches: d.beaches.slice(), weekly: d.weekly, schedules: d.schedules.slice(), price_tiers: d.price_tiers.map(function(t){ return Object.assign({}, t); }) };
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
// Owner-selectable course price durations (key + display label + hours metadata).
function adminPackTierDurations(){
  return [
    { key: '1_day', hours: 2 }, { key: '2_days', hours: 4 }, { key: '3_days', hours: 6 },
    { key: '5_days', hours: 10 }, { key: '7_days', hours: 14 },
    { key: '1_week', hours: 10 }, { key: '2_weeks', hours: 20 }, { key: '3_weeks', hours: 30 }, { key: '4_weeks', hours: 40 },
    { key: 'single_class', hours: 2 },
  ].map(function(d){ return { key: d.key, hours: d.hours, label: adminPeriodLabel(d.key) }; });
}
function adminRenderPackTierRowsHtml(rows){
  var durs = adminPackTierDurations();
  return (rows || []).map(function(r){
    var opts = durs.map(function(d){
      return '<option value="' + escHtml(d.key) + '"' + (d.key === r.key ? ' selected' : '') + '>' + escHtml(d.label) + '</option>';
    }).join('');
    return '<div class="portal-admin-pack-tier" data-pack-tier-row>' +
      '<select class="pack-tier-key">' + opts + '</select>' +
      '<input type="text" class="pack-tier-amount" value="' + escHtml(r.amount || '') + '" inputmode="decimal" placeholder="0.00">' +
      '<span class="portal-admin-muted">' + escHtml(portalT('admin.packs.perStudent')) + '</span>' +
      '<button type="button" class="btn btn-ghost portal-admin-icon-btn portal-admin-danger" data-admin-action="remove-pack-tier" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button>' +
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
  var rows = (tiers || []).map(function(t){
    return { key: t.key, amount: adminEurosFromAmount((t.amount_cents != null ? t.amount_cents : 0) / 100) };
  });
  if (!rows.length) rows = [{ key: '1_day', amount: '' }];
  return '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>' +
    '<div id="' + escHtml(prefix) + '-tier-rows">' + adminRenderPackTierRowsHtml(rows) + '</div>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="add-pack-tier" data-tier-prefix="' + escHtml(prefix) + '">+ ' + escHtml(portalT('admin.packs.addPrice')) + '</button>' +
    '</div>';
}
function adminRenderPackTierReadout(tiers){
  var html = '<div class="portal-admin-pill-group"><span class="portal-admin-pill-label">' + escHtml(portalT('admin.packs.priceTiers')) + '</span>';
  (tiers || []).forEach(function(t){
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
    adminRenderPillRow('beaches', adminPackBeachOptions(), p.beaches || [], true) +
    adminRenderPillRow('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false) +
    adminRenderPackScheduleFields(p, prefix) +
    adminRenderPackTierFields(p.price_tiers || ADMIN_DEFAULT_PRICE_TIERS, prefix) +
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
  var opts = ['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days'];
  return opts.map(function(p){
    var sel = (selected === p) ? ' selected' : '';
    return '<option value="' + escHtml(p) + '"' + sel + '>' + escHtml(adminPeriodLabel(p)) + '</option>';
  }).join('');
}

// Rank rental durations shortest → longest so prices display in time order
// (1h, 2h, half day, 1 day, 2 day, …) instead of numeric-then-alphabetical.
function adminRentalPeriodRank(period){
  var order = ['1_hour', '2_hours', 'half_day', '1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days', '1_week', '2_weeks', '3_weeks', '4_weeks'];
  var i = order.indexOf(String(period || '').trim());
  return i >= 0 ? i : 999;
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

function renderAdminSectionPricesFromConfig(cfg){
  var box = el('admin-prices-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var prices = (cfg && cfg.prices) ? cfg.prices : [];
  var groups = { bundles: [], boards: [], wetsuits: [], sup: [], other: [] };
  prices.filter(function(p){ return !adminIsLessonPrice(p); }).forEach(function(p){
    var g = adminPriceGroupKey(p);
    if (!groups[g]) g = 'other';
    groups[g].push(p);
  });
  var order = adminRentalGroupOrder();
  var html = '<div class="portal-admin-toolbar"><span class="portal-admin-muted">' + escHtml(portalT('admin.prices.help')) + '</span></div>';
  order.forEach(function(key){
    var items = (groups[key] || []).slice().sort(function(a, b){
      return adminRentalPeriodRank(adminParsePriceRow(a).periodWindow) - adminRentalPeriodRank(adminParsePriceRow(b).periodWindow);
    });
    var groupEditing = writes && adminEditTarget === ('price-group:' + key);
    var adding = writes && adminEditTarget === ('price-add:' + key);
    html += '<div class="portal-admin-subsection" data-admin-price-group="' + escHtml(key) + '">';
    html += '<div class="portal-admin-subsection-title-row"><div class="portal-admin-subsection-title-group">';
    html += '<h3 class="portal-admin-subsection-title">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';
    if (writes){
      var busyOther = adminPriceGroupBusy(key);
      if (!busyOther){
        html += '<div class="portal-admin-card-actions">';
        if (!groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-price-group" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>';
          if (!adding){
            html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-price" data-price-group="' +
              escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.add')) + '">+</button>';
          }
        } else {
          html += '<button type="button" class="btn btn-primary portal-admin-row-edit" data-admin-action="save-price-group" data-price-group="' +
            escHtml(key) + '">' + escHtml(portalT('admin.action.save')) + '</button>';
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="cancel-edit">' +
            escHtml(portalT('admin.action.cancel')) + '</button>';
        }
        html += '</div>';
      }
    }
    html += '</div></div>';
    if (!items.length && !adding){
      html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.emptyCategory')) + '</p>';
    }
    if (items.length){
      html += '<div class="portal-admin-card-grid" id="admin-prices-card-grid-' + escHtml(key) + '">';
      items.forEach(function(p){
        var pid = adminPriceRowId(p);
        var parsed = adminParsePriceRow(p);
        html += '<article class="portal-admin-price-card' + (groupEditing && pid ? ' is-editing' : '') + '" data-admin-price-card="' + escHtml(pid) + '">';
        if (groupEditing){
          html += '<div class="portal-admin-card-title-row"><div></div><div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-price" data-price-id="' +
            escHtml(pid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div></div>';
          html += renderAdminPriceCardEditForm(pid, p, key);
        } else {
          html += '<div class="portal-admin-price-card-readout"><span class="portal-admin-price-period">' + escHtml(adminPeriodLabel(parsed.periodWindow)) + '</span>' +
            '<span class="portal-admin-price-amount">' + escHtml(adminEurosFromAmount(p.amount) + ' ' + (p.currency || 'EUR')) + '</span></div>';
        }
        html += '</article>';
      });
      html += '</div>';
    }
    if (adding) html += renderAdminAddPriceForm(key);
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
    var label = adminHumanizeText(s.offering_label || 'Lesson');
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
function renderAdminPackCards(packs, writes){
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
      '<div class="portal-admin-pack-sub">' + escHtml(adminLessonAgeLabel(p.age_band)) + ' · ' + escHtml(portalT('admin.packs.groupExclusive').replace('{n}', String(p.group_size || 16))) + '</div></div>';
    if (writes && !editing && !adminPackSectionEditing()){
      html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-pack" data-pack-id="' +
        escHtml(pid) + '">✎</button><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-pack" data-pack-id="' +
        escHtml(pid) + '">×</button></div>';
    }
    html += '</div>';
    if (editing) html += adminRenderPackEditForm(pid, p);
    else {
      html += adminRenderPackPillReadout('beaches', adminPackBeachOptions(), p.beaches || [], true);
      html += adminRenderPackPillReadout('weekly', adminPackWeeklyPillOptions(), p.weekly || 'mon_fri', false);
      html += adminRenderPackScheduleReadout(p.schedules || []);
      html += adminRenderPackTierReadout(p.price_tiers || []);
    }
    html += '</article>';
  });
  return html + '</div></div>';
}
function renderAdminSectionLessonTimesFromConfig(cfg){
  var box = el('admin-times-body');
  if (!box) return;
  var writes = adminCfgWritesEnabled(cfg);
  var slots = (cfg && cfg.lesson_times) ? cfg.lesson_times : [];
  var packs = (cfg && cfg.surf_packs) ? cfg.surf_packs : [];
  var defaultCap = (cfg && cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap != null)
    ? cfg.lesson_capacity.default_daily_cap : SUNSET_SCHEDULE_LESSON_DAY_CAP;
  box.innerHTML = renderAdminLessonCards(slots, cfg, writes, defaultCap) + renderAdminPackCards(packs, writes);
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

function renderAdminFromConfig(cfg){
  try { renderAdminSectionBusinessInfoFromConfig(cfg); } catch (err) { console.error('admin business render failed', err); }
  try { renderAdminSectionLessonTimesFromConfig(cfg); } catch (err) { console.error('admin lessons render failed', err); }
  try { renderAdminSectionPricesFromConfig(cfg); } catch (err) { console.error('admin prices render failed', err); }
  try { renderAdminSectionChangeHistoryFromConfig(cfg); } catch (err) { console.error('admin history render failed', err); }
}

function renderAdminFallback(profile){
  adminEditTarget = null;
  var fallbackLocation = getClient() === 'sunset' ? getSunsetLocation() : null;
  renderAdminSectionBusinessInfoFromConfig({
    location_id: fallbackLocation,
    location_label: fallbackLocation ? getSunsetLocationLabel(fallbackLocation) : null,
    business_info: {}
  });
  renderAdminSectionLessonTimesFromConfig({ lesson_times: (profile && profile.lesson_slots_demo) ? profile.lesson_slots_demo : [], lesson_capacity: { default_daily_cap: SUNSET_SCHEDULE_LESSON_DAY_CAP } });
  renderAdminSectionPricesFromConfig(null);
  renderAdminSectionChangeHistoryFromConfig(null);
}

function renderAdminLoadingShell(profile){
  // Do not leave the Admin page blank while the DB-backed config request is in flight.
  // Render the safe local fallback immediately; the real config replaces it when loaded.
  renderAdminFallback(profile);
}

function loadAdminTab(){
  wireAdminTab();
  var profile = getPortalProfile(getClient());
  if (!profile.is_surf_vertical) return;
  var state = el('admin-fetch-state');
  var loadSeq = ++adminLoadSeq;
  renderAdminLoadingShell(profile);
  if (state){ state.textContent = portalT('admin.loading'); state.style.display = 'none'; state.classList.remove('error'); }
  var url = '/staff/admin/config' + adminClientQuery();
  var timeout = new Promise(function(_, reject){
    setTimeout(function(){ reject(new Error('request timeout')); }, 8000);
  });
  var request = fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); });
  Promise.race([request, timeout])
    .then(function(data){
      if (loadSeq !== adminLoadSeq) return;
      if (!data || data.success !== true) return Promise.reject(new Error((data && data.error) ? data.error : 'load failed'));
      adminConfigCache = data;
      if (!adminCfgWritesEnabled(data)) adminEditTarget = null;
      renderAdminFromConfig(data);
      if (state) state.style.display = 'none';
    })
    .catch(function(e){
      if (loadSeq !== adminLoadSeq) return;
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
    ev.preventDefault();
    var action = btn.getAttribute('data-admin-action');
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
    if (action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'save-price-group' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-new-price' || action === 'save-time' || action === 'save-new-time' || action === 'add-pack' || action === 'edit-pack' || action === 'delete-pack' || action === 'save-pack' || action === 'save-new-pack'){
      if (!adminCfgWritesEnabled(cfg)){ adminShowMessage('error', portalT('admin.banner.writesDisabled')); return; }
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
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/prices/' + encodeURIComponent(deletePriceId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPrice'));
          adminReloadConfigKeepingEdit(keepGroupEdit);
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
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
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/lesson-times/' + encodeURIComponent(deleteTimeId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedTime'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
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

    if (action === 'save-price'){
      var priceId = String(btn.getAttribute('data-price-id') || '');
      var periodInput = el('admin-price-period-' + priceId);
      var amountInput = el('admin-price-amount-' + priceId);
      var period = periodInput ? String(periodInput.value || '').trim() : '';
      if (!period){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var centsParsed = adminParseEurosToCents(amountInput && amountInput.value);
      if (!centsParsed.ok){ adminShowMessage('error', centsParsed.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/prices/' + encodeURIComponent(priceId) + adminClientQuery(), {
        period_window: period,
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
    if (action === 'save-new-price'){
      var rentalGroup = String(btn.getAttribute('data-price-group') || '');
      var newPeriodInput = el('admin-new-price-period');
      var newAmountInput = el('admin-new-price-amount');
      var newPeriod = newPeriodInput ? String(newPeriodInput.value || '').trim() : '';
      if (!newPeriod){ adminShowMessage('error', portalT('admin.edit.periodRequired')); return; }
      var newCents = adminParseEurosToCents(newAmountInput && newAmountInput.value);
      if (!newCents.ok){ adminShowMessage('error', newCents.error); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('POST', '/staff/admin/config/prices' + adminClientQuery(), {
        rental_group: rentalGroup,
        period_window: newPeriod,
        amount_cents: newCents.value,
      }).then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 201 && res.status !== 200) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', portalT('admin.edit.addedPrice'));
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
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('PATCH', '/staff/admin/config/lesson-times/' + encodeURIComponent(timeId) + adminClientQuery(), timePayload).then(function(res){
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
    if (action === 'delete-pack'){
      var deletePackId = String(btn.getAttribute('data-pack-id') || '');
      if (!deletePackId || !window.confirm(portalT('admin.edit.confirmRemovePack'))) return;
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('DELETE', '/staff/admin/config/surf-packs/' + encodeURIComponent(deletePackId) + adminClientQuery(), {})
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 200 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.removedPack'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
    if (action === 'save-pack' || action === 'save-new-pack'){
      var packId = action === 'save-pack' ? String(btn.getAttribute('data-pack-id') || '') : '';
      var payload = adminReadPackFormPayload(packId || null);
      if (payload._scheduleError){ adminShowMessage('error', payload._scheduleError); return; }
      delete payload._scheduleError;
      if (!payload.label){ adminShowMessage('error', portalT('admin.edit.nameRequired')); return; }
      adminSaveBusy = true;
      adminShowMessage('', '');
      var packReq = packId
        ? adminApiRequest('PATCH', '/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + adminClientQuery(), payload)
        : adminApiRequest('POST', '/staff/admin/config/surf-packs' + adminClientQuery(), payload);
      packReq.then(function(res){
        adminSaveBusy = false;
        if ((res.status !== 200 && res.status !== 201) || !res.data || res.data.success !== true){
          adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
          return;
        }
        adminShowMessage('success', packId ? portalT('admin.edit.savedPack') : portalT('admin.edit.addedPack'));
        adminReloadConfig();
      }).catch(function(err){
        adminSaveBusy = false;
        adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
      });
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
      adminSaveBusy = true;
      adminShowMessage('', '');
      adminApiRequest('POST', '/staff/admin/config/lesson-times' + adminClientQuery(), payload)
        .then(function(res){
          adminSaveBusy = false;
          if (res.status !== 201 || !res.data || res.data.success !== true){
            adminShowMessage('error', (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status));
            return;
          }
          adminShowMessage('success', portalT('admin.edit.addedTime'));
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }
  });
}


