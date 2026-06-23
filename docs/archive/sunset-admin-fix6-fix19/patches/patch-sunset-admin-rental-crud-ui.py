#!/usr/bin/env python3
"""Part 2: Admin rental UI + API routes in staff-query-api.js"""
from pathlib import Path

ROOT = Path('/opt/wolfhouse/WH')
API = ROOT / 'scripts/staff-query-api.js'
I18N = ROOT / 'scripts/lib/staff-portal-i18n.js'
I18N_ES = ROOT / 'scripts/lib/staff-portal-i18n-es-sunset.js'

api = API.read_text()

# imports
old_imp = """  validatePricePatchBody,
  validateLessonCapacityBody,"""
new_imp = """  validatePricePatchBody,
  validatePriceCreateBody,
  validateLessonCapacityBody,"""
if 'validatePriceCreateBody' not in api:
    api = api.replace(old_imp, new_imp.replace('validatePriceCreateBody,\n  ', ''), 1) if False else api
old_imp2 = """  validatePricePatchBody,
  validateLessonCapacityBody,
  validateLessonTimeCreateBody,"""
new_imp2 = """  validatePricePatchBody,
  validatePriceCreateBody,
  validateLessonCapacityBody,
  validateLessonTimeCreateBody,"""
if 'validatePriceCreateBody' not in api:
    if old_imp2 not in api:
        raise SystemExit('import block missing')
    api = api.replace(old_imp2, new_imp2, 1)

old_exp = """  patchPriceRule,
  putLessonCapacityDefault,"""
new_exp = """  createRentalPriceRule,
  deactivatePriceRule,
  patchPriceRule,
  putLessonCapacityDefault,"""
if 'createRentalPriceRule' not in api:
    if old_exp not in api:
        raise SystemExit('require exports missing')
    api = api.replace(old_exp, new_exp, 1)

# Replace admin price helpers + render section
old_block_start = 'function adminPriceGroupKey(p){'
old_block_end = 'function renderAdminSectionCapacityFromConfig(cfg){'
if 'function adminRentalGroupOrder()' in api:
    print('SKIP UI block already patched')
else:
    idx = api.find(old_block_start)
    end = api.find(old_block_end)
    if idx < 0 or end < 0:
        raise SystemExit('admin price block anchors missing')
    new_block = r'''function adminRentalGroupOrder(){
  return ['bundles', 'boards', 'wetsuits', 'sup'];
}

function adminPriceGroupKey(p){
  var parsed = adminParsePriceRow(p);
  return parsed.groupKey;
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
  if (!key) return '—';
  var tKey = 'admin.period.' + key;
  var label = portalT(tKey);
  return label === tKey ? adminHumanizeText(key) : label;
}

function adminRentalPeriodOptions(selected){
  var opts = ['1_hour', 'half_day', '1_day', '2_days', '5_days', '7_days'];
  return opts.map(function(p){
    var sel = (selected === p) ? ' selected' : '';
    return '<option value="' + escHtml(p) + '"' + sel + '>' + escHtml(adminPeriodLabel(p)) + '</option>';
  }).join('');
}

function adminPriceCategoryLabel(category){
  var c = String(category || '').trim().toLowerCase();
  if (c === 'lesson') return portalT('admin.prices.category.lesson');
  if (c === 'rental') return portalT('admin.prices.category.rental');
  if (c === 'package') return portalT('admin.prices.category.package');
  return category || '—';
}

function adminUnitLabel(unit){
  return adminPeriodLabel(unit);
}

function renderAdminPriceCardEditForm(pid, p, groupKey){
  var parsed = adminParsePriceRow(p);
  var period = parsed.periodWindow || '1_day';
  return '<div class="portal-admin-edit-form">' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.period')) + '</label>' +
    '<select id="admin-price-period-' + escHtml(pid) + '">' + adminRentalPeriodOptions(period) + '</select></div>' +
    '<div class="portal-admin-edit-field"><label>' + escHtml(portalT('admin.edit.amountEur')) + '</label>' +
    '<input type="text" id="admin-price-amount-' + escHtml(pid) + '" value="' + escHtml(adminEurosFromAmount(p.amount)) + '" inputmode="decimal"></div>' +
    '<div class="portal-admin-edit-actions">' +
    '<button type="button" class="btn btn-primary" data-admin-action="save-price" data-price-id="' + escHtml(pid) + '">' +
    escHtml(portalT('admin.action.save')) + '</button>' +
    '<button type="button" class="btn btn-ghost" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.cancel')) + '</button>' +
    '</div></div>';
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
    var items = groups[key] || [];
    var groupEditing = writes && adminEditTarget === ('price-group:' + key);
    var adding = writes && adminEditTarget === ('price-add:' + key);
    html += '<div class="portal-admin-subsection" data-admin-price-group="' + escHtml(key) + '">';
    html += '<div class="portal-admin-subsection-title-row"><h3 class="portal-admin-subsection-title">' + escHtml(adminPriceGroupTitle(key)) + '</h3>';
    if (writes){
      var busyOther = adminEditTarget && !groupEditing && !adding;
      if (!busyOther){
        if (!groupEditing){
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn" data-admin-action="edit-price-group" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.edit')) + '">✎</button>';
        } else {
          html += '<button type="button" class="btn btn-ghost portal-admin-row-edit" data-admin-action="cancel-edit">' + escHtml(portalT('admin.action.done')) + '</button>';
        }
        if (!adding){
          html += '<button type="button" class="btn btn-primary portal-admin-row-edit portal-admin-icon-btn" data-admin-action="add-price" data-price-group="' +
            escHtml(key) + '" aria-label="' + escHtml(portalT('admin.action.addRental')) + '">+</button>';
        }
      }
    }
    html += '</div>';
    if (!items.length && !adding){
      html += '<p class="portal-admin-muted">' + escHtml(portalT('admin.prices.emptyCategory')) + '</p>';
    }
    if (items.length){
      html += '<div class="portal-admin-card-grid" id="admin-prices-card-grid-' + escHtml(key) + '">';
      items.forEach(function(p){
        var pid = p.id ? String(p.id) : '';
        var parsed = adminParsePriceRow(p);
        var cardTitle = adminPriceGroupTitle(key);
        html += '<article class="portal-admin-price-card" data-admin-price-card="' + escHtml(pid) + '">';
        html += '<div class="portal-admin-card-title-row"><div><div class="portal-admin-price-title">' + escHtml(cardTitle) + '</div>' +
          '<div class="portal-admin-price-meta">' + escHtml(adminPeriodLabel(parsed.periodWindow)) + '</div></div>';
        if (groupEditing && pid){
          html += '<div class="portal-admin-card-actions"><button type="button" class="btn btn-ghost portal-admin-row-edit portal-admin-icon-btn portal-admin-danger" data-admin-action="delete-price" data-price-id="' +
            escHtml(pid) + '" aria-label="' + escHtml(portalT('admin.action.remove')) + '">×</button></div>';
        }
        html += '</div>';
        if (groupEditing && pid){
          html += renderAdminPriceCardEditForm(pid, p, key);
        } else {
          html += '<div class="portal-admin-price-amount">' + escHtml(adminEurosFromAmount(p.amount) + ' ' + (p.currency || 'EUR')) + '</div>';
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

'''
    api = api[:idx] + new_block + api[end:]
    print('OK admin price UI block')

# wireAdminTab actions
wire_old = """    if (action === 'edit-capacity' || action === 'edit-price' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-time' || action === 'save-new-time'){
      if (!adminCfgWritesEnabled(cfg)) return;
    }"""
wire_new = """    if (action === 'edit-capacity' || action === 'edit-price-group' || action === 'add-price' || action === 'delete-price' || action === 'edit-time' || action === 'add-time' || action === 'delete-time' || action === 'save-capacity' || action === 'save-price' || action === 'save-new-price' || action === 'save-time' || action === 'save-new-time'){
      if (!adminCfgWritesEnabled(cfg)) return;
    }"""
if 'edit-price-group' not in api:
    if wire_old not in api:
        raise SystemExit('wireAdminTab gate missing')
    api = api.replace(wire_old, wire_new, 1)

if "action === 'edit-price'" in api and "action === 'edit-price-group'" not in api.split("action === 'edit-price'")[0][-200:]:
    pass

# Replace edit-price handler with edit-price-group
edit_price_old = """    if (action === 'edit-price'){
      adminEditTarget = 'price:' + String(btn.getAttribute('data-price-id') || '');
      adminShowMessage('', '');
      renderAdminFromConfig(cfg);
      return;
    }"""
edit_price_new = """    if (action === 'edit-price-group'){
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
          adminReloadConfig();
        }).catch(function(err){
          adminSaveBusy = false;
          adminShowMessage('error', portalT('admin.edit.saveFailed') + ' ' + err.message);
        });
      return;
    }"""
if "action === 'edit-price-group'" not in api:
    if edit_price_old not in api:
        raise SystemExit('edit-price handler missing')
    api = api.replace(edit_price_old, edit_price_new, 1)

# Update save-price handler to use per-card fields
save_price_old = """    if (action === 'save-price'){
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
      }).then(function(res){"""
save_price_new = """    if (action === 'save-price'){
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
      }).then(function(res){"""
if 'admin-price-period-' not in api:
    if save_price_old not in api:
        raise SystemExit('save-price handler missing')
    api = api.replace(save_price_old, save_price_new, 1)

# Add save-new-price after save-price block
save_new_anchor = """      return;
    }
    if (action === 'save-time'){"""
save_new_price = """      return;
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
        if (res.status !== 201 || !res.data || res.data.success !== true){
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
    if (action === 'save-time'){"""
if "action === 'save-new-price'" not in api:
    if save_new_anchor not in api:
        raise SystemExit('save-new-price anchor missing')
    api = api.replace(save_new_anchor, save_new_price, 1)

# API handlers
if 'async function handleAdminConfigPricePost' not in api:
    handler_block = """
async function handleAdminConfigPricePost(query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({
    user,
    clientSlug,
    staffAuthRequired: STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch (_) {
    return send400(res, 'invalid JSON body');
  }
  const validated = validatePriceCreateBody(body);
  if (!validated.ok) return send400(res, validated.error);

  try {
    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => createRentalPriceRule(pg, {
      clientSlug,
      locationId,
      patch: validated.patch,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config.price_create',
      category: 'admin_api',
      client_slug: clientSlug,
      success: result.ok,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

async function handleAdminConfigPriceDelete(ruleIdRaw, query, req, res, user) {
  const started = Date.now();
  const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
  if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
  const gate = evaluateAdminWriteGate({
    user,
    clientSlug,
    staffAuthRequired: STAFF_AUTH_REQUIRED,
    resolveStaffRole,
  });
  if (!gate.ok) return sendAdminWriteGateFailure(res, gate);
  if (!assertStaffClientAccess(user, clientSlug, res)) return;

  const idCheck = validateUuid(ruleIdRaw, 'price rule id');
  if (!idCheck.ok) return send400(res, idCheck.error);

  try {
    const locationId = normalizeSunsetLocationId(query.location);
    const result = await withPgClient(async (pg) => deactivatePriceRule(pg, {
      ruleId: idCheck.value,
      clientSlug,
      locationId,
      actor: { staff_user_id: user && user.staff_user_id, email: user && user.email },
    }));
    appendAuditLog({
      ts: new Date().toISOString(),
      intent: 'api:admin.config.price_delete',
      category: 'admin_api',
      client_slug: clientSlug,
      success: result.ok,
      staff_user_id: user ? user.staff_user_id : null,
      elapsed_ms: Date.now() - started,
    });
    return sendJSON(res, result.status, { ...result.body, elapsed_ms: Date.now() - started });
  } catch (err) {
    return sendJSON(res, 500, { success: false, error: 'write failed' });
  }
}

"""
    anchor = 'async function handleAdminConfigLessonCapacityPut(query, req, res, user) {'
    if anchor not in api:
        raise SystemExit('handler anchor missing')
    api = api.replace(anchor, handler_block + anchor, 1)

# routes
route_old = """  const adminPricePatchMatch = /^\\/staff\\/admin\\/config\\/prices\\/([0-9a-f-]{36})$/i.exec(pathname);
  if (adminPricePatchMatch && method === 'PATCH') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigPricePatch(adminPricePatchMatch[1], parsed.query, req, res, auth.user);
  }"""
route_new = """  if (pathname === '/staff/admin/config/prices' && method === 'POST') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigPricePost(parsed.query, req, res, auth.user);
  }

  const adminPricePatchMatch = /^\\/staff\\/admin\\/config\\/prices\\/([0-9a-f-]{36})$/i.exec(pathname);
  if (adminPricePatchMatch && method === 'PATCH') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigPricePatch(adminPricePatchMatch[1], parsed.query, req, res, auth.user);
  }
  if (adminPricePatchMatch && method === 'DELETE') {
    const auth = await requireAuth(req, res, 'admin');
    if (!auth.ok) return;
    return handleAdminConfigPriceDelete(adminPricePatchMatch[1], parsed.query, req, res, auth.user);
  }"""
if "handleAdminConfigPricePost" not in api:
    if route_old not in api:
        raise SystemExit('price routes missing')
    api = api.replace(route_old, route_new, 1)

API.write_text(api)
print('OK staff-query-api.js')

# i18n
for path, insert_after in [
    (I18N, "'admin.action.addLesson': 'Add lesson',"),
    (I18N_ES, "'admin.action.addLesson': 'Añadir clase',"),
]:
    text = path.read_text()
    if "'admin.action.addRental'" in text:
        continue
    block = """
    'admin.action.addRental': 'Add rental',
    'admin.action.done': 'Done',
    'admin.edit.period': 'Time period',
    'admin.edit.periodRequired': 'Select a time period.',
    'admin.edit.confirmRemovePrice': 'Remove this rental price?',
    'admin.edit.addedPrice': 'Rental price added.',
    'admin.edit.removedPrice': 'Rental price removed.',
    'admin.prices.emptyCategory': 'No prices in this category yet.',
    'admin.period.1_hour': '1 hour',
    'admin.period.half_day': 'Half day',
    'admin.period.1_day': '1 day',
    'admin.period.2_days': '2 days',
    'admin.period.5_days': '5 days',
    'admin.period.7_days': '7 days',"""
    if insert_after not in text:
        raise SystemExit(f'i18n anchor missing in {path}')
    path.write_text(text.replace(insert_after, insert_after + block, 1))
    print(f'OK {path.name}')

es_block = """
  'admin.action.addRental': 'Añadir alquiler',
  'admin.action.done': 'Listo',
  'admin.edit.period': 'Periodo',
  'admin.edit.periodRequired': 'Selecciona un periodo.',
  'admin.edit.confirmRemovePrice': '¿Quitar este precio de alquiler?',
  'admin.edit.addedPrice': 'Precio de alquiler añadido.',
  'admin.edit.removedPrice': 'Precio de alquiler eliminado.',
  'admin.prices.emptyCategory': 'Aún no hay precios en esta categoría.',
  'admin.period.1_hour': '1 hora',
  'admin.period.half_day': 'Medio día',
  'admin.period.1_day': '1 día',
  'admin.period.2_days': '2 días',
  'admin.period.5_days': '5 días',
  'admin.period.7_days': '7 días',"""
if I18N_ES.exists() and "'admin.action.addRental'" not in I18N_ES.read_text():
    es = I18N_ES.read_text()
    anchor = "'admin.action.addLesson':"
    if anchor in es:
        I18N_ES.write_text(es.replace(anchor, es_block.strip() + "\n  " + anchor, 1))
        print('OK staff-portal-i18n-es-sunset.js')

print('part 2 done')
