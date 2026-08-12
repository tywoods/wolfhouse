/**
 * Staff Portal Inbox, Customers tab: list state, status and tag filters, bulk selection.
 *
 * Injected into /staff/ui at the inbox-customers-filters marker. This is a fragment
 * spliced into the portal's IIFE, not a standalone module: it relies on siblings in that
 * scope (el, escHtml, portalT, getClient) and is therefore already in strict mode.
 */

var selectedCustomerPhone = null;
var customersSearchTimer = null;
var customersBulkSelected = {};
var customersFiltersMenuOpen = false;

var CUSTOMERS_STATUS_FILTER_DEFS = [
  { id: 'all', i18n: 'customers.filter.all' },
  { id: 'warm_leads', i18n: 'customers.filter.warmLeads', title: 'customers.filter.warmLeadsTitle', lodgingOnly: false },
  { id: 'hot_leads', i18n: 'customers.filter.hotLeads', title: 'customers.filter.hotLeadsTitle' },
  { id: 'checked_in_now', i18n: 'customers.filter.checkedInNow', title: 'customers.filter.checkedInNowTitle', lodgingOnly: true },
  { id: 'lesson_today', i18n: 'customers.filter.lessonToday', title: 'customers.filter.lessonTodayTitle', surfOnly: true },
  { id: 'upcoming', i18n: 'customers.filter.upcoming', title: 'customers.filter.upcomingTitle', surfOnly: true },
  { id: 'unpaid', i18n: 'customers.filter.unpaid', title: 'customers.filter.unpaidTitle', surfOnly: true },
  { id: 'waiver_pending', i18n: 'customers.filter.waiverPending', title: 'customers.filter.waiverPendingTitle', surfOnly: true },
  { id: 'do_not_contact', i18n: 'customers.filter.doNotContact', title: 'customers.filter.doNotContactTitle' },
  { id: 'needs_attention', i18n: 'customers.filter.needsAttention' },
];

var CUSTOMERS_TAG_FILTER_DEFS = [
  { id: 'rental', i18n: 'customers.filter.rental', tag: 'rental' },
  { id: 'accommodation', i18n: 'customers.tags.accommodation', tag: 'accommodation' },
  { id: 'surf_school', i18n: 'customers.tags.surf_school', tag: 'surf_school' },
  { id: 'vip', i18n: 'customers.tags.vip', tag: 'vip' },
  { id: 'local', i18n: 'customers.tags.local', tag: 'local' },
  { id: 'newsletter_ok', i18n: 'customers.tags.newsletter_ok', tag: 'newsletter_ok' },
];

function customerDisplayTags(c) {
  if (!c) return [];
  if (Array.isArray(c.display_tags)) return c.display_tags;
  return [];
}

function customerHasDisplayTag(c, tagKey) {
  return customerDisplayTags(c).indexOf(tagKey) >= 0;
}

function customerMatchesTagFilter(c, filterId) {
  for (var i = 0; i < CUSTOMERS_TAG_FILTER_DEFS.length; i++) {
    var def = CUSTOMERS_TAG_FILTER_DEFS[i];
    if (def.id !== filterId) continue;
    if (def.tag) return customerHasDisplayTag(c, def.tag);
  }
  return true;
}

function customerFilterLabel(def) {
  return portalT(def.i18n);
}

function customerTagTone(tagKey) {
  if (tagKey === 'do_not_contact') return 'dnc';
  if (tagKey === 'hot_lead' || tagKey === 'hot_leads') return 'hot';
  if (tagKey === 'warm_lead' || tagKey === 'warm_leads') return 'warm';
  if (tagKey === 'surf_school') return 'surf';
  return 'neutral';
}

function getActiveCustomersTagFilterIds() {
  return Object.keys(customersTagFilters).filter(function(k) { return customersTagFilters[k]; });
}

function getCustomersVisibleRows() {
  var rows = customersCache || [];
  var tagIds = getActiveCustomersTagFilterIds();
  if (!tagIds.length) return rows;
  return rows.filter(function(c) {
    return tagIds.every(function(fid) { return customerMatchesTagFilter(c, fid); });
  });
}

function customersHasActiveFilters() {
  return customersFilter !== 'all' || getActiveCustomersTagFilterIds().length > 0;
}

function customerProfileInitials(name) {
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function closeCustomersFiltersMenu() {
  customersFiltersMenuOpen = false;
  var menu = el('cust-filters-menu');
  var btn = el('cust-filters-btn');
  if (menu) { menu.classList.remove('open'); menu.setAttribute('aria-hidden', 'true'); }
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleCustomersFiltersMenu(forceOpen) {
  var menu = el('cust-filters-menu');
  if (!menu) return;
  var open = forceOpen === true ? true : (forceOpen === false ? false : !customersFiltersMenuOpen);
  customersFiltersMenuOpen = open;
  menu.classList.toggle('open', open);
  menu.setAttribute('aria-hidden', open ? 'false' : 'true');
  var btn = el('cust-filters-btn');
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderCustomersFiltersMenu();
}

function renderCustomersFiltersMenu() {
  var menu = el('cust-filters-menu');
  if (!menu) return;
  var profile = getPortalProfile(getClient());
  var showCheckedIn = !profile.is_surf_vertical;
  var showSurf = !!profile.is_surf_vertical;
  var html = '<div class="customers-filters-chip-field">';
  CUSTOMERS_STATUS_FILTER_DEFS.forEach(function(def) {
    if (def.lodgingOnly && !showCheckedIn) return;
    if (def.surfOnly && !showSurf) return;
    var active = customersFilter === def.id;
    var title = def.title ? ' title="' + escHtml(portalT(def.title)) + '"' : '';
    html += '<button type="button" class="customers-filters-option' + (active ? ' active' : '') + '" data-cust-status-filter="' + escHtml(def.id) + '"' + title + ' role="menuitemradio" aria-checked="' + (active ? 'true' : 'false') + '">' + escHtml(customerFilterLabel(def)) + '</button>';
  });
  CUSTOMERS_TAG_FILTER_DEFS.forEach(function(def) {
    var checked = !!customersTagFilters[def.id];
    html += '<label class="customers-filters-option' + (checked ? ' active' : '') + '" data-tag-tone="' + customerTagTone(def.tag || def.id) + '" role="menuitemcheckbox"><input type="checkbox" data-cust-tag-filter="' + escHtml(def.id) + '"' + (checked ? ' checked' : '') + '> ' + escHtml(customerFilterLabel(def)) + '</label>';
  });
  html += '</div>';
  if (customersHasActiveFilters()) {
    html += '<div class="customers-filters-group"><button type="button" class="customers-filters-option" data-cust-clear-filters role="menuitem">' + escHtml(portalT('customers.filters.clearAll')) + '</button></div>';
  }
  menu.innerHTML = html;
}

function renderCustomersFilterChips() {
  var box = el('cust-filter-chips');
  var trigger = el('cust-filters-btn');
  if (trigger) trigger.classList.toggle('has-active', customersHasActiveFilters());
  if (!box) return;
  var chips = [];
  if (customersFilter !== 'all') {
    CUSTOMERS_STATUS_FILTER_DEFS.forEach(function(def) {
      if (def.id === customersFilter) {
        chips.push({ kind: 'status', id: def.id, label: customerFilterLabel(def) });
      }
    });
  }
  getActiveCustomersTagFilterIds().forEach(function(id) {
    CUSTOMERS_TAG_FILTER_DEFS.forEach(function(def) {
      if (def.id === id) chips.push({ kind: 'tag', id: id, label: customerFilterLabel(def) });
    });
  });
  if (!chips.length) { box.innerHTML = ''; return; }
  box.innerHTML = chips.map(function(chip) {
    return '<span class="customers-filter-chip">' + escHtml(chip.label) +
      '<button type="button" data-cust-chip-remove="' + escHtml(chip.kind + ':' + chip.id) + '" aria-label="Remove ' + escHtml(chip.label) + '">×</button></span>';
  }).join('');
}

function renderCustomersFilterUI() {
  renderCustomersFiltersMenu();
  renderCustomersFilterChips();
}

function clearCustomersFilters() {
  customersFilter = 'all';
  customersTagFilters = {};
  customersBulkSelected = {};
  closeCustomersOutreachDrawer();
  renderCustomersFilterUI();
  loadCustomersList();
}

function toggleCustomersTagFilter(id) {
  if (!id) return;
  if (customersTagFilters[id]) delete customersTagFilters[id];
  else customersTagFilters[id] = true;
  renderCustomersFilterUI();
  renderCustomersList(getCustomersVisibleRows());
}

function selectAllShownCustomers() {
  getCustomersVisibleRows().forEach(function(c) {
    if (c && c.phone) customersBulkSelected[c.phone] = true;
  });
  renderCustomersList(getCustomersVisibleRows());
}

function clearCustomersBulkSelection() {
  customersBulkSelected = {};
  renderCustomersList(getCustomersVisibleRows());
}

function customerHasValidPhone(c) {
  return !!(c && c.phone && String(c.phone).trim());
}

function customerIsDoNotContact(c) {
  if (!c) return false;
  return customerHasDisplayTag(c, 'do_not_contact');
}

function getCustomersBulkSelectedPhones() {
  return Object.keys(customersBulkSelected).filter(function(phone) { return customersBulkSelected[phone]; });
}

function findCachedCustomer(phone) {
  for (var i = 0; i < customersCache.length; i++) {
    if (customersCache[i].phone === phone) return customersCache[i];
  }
  return null;
}

function updateCustomersBulkSelectionUI() {
  var count = getCustomersBulkSelectedPhones().length;
  var countEl = el('cust-selected-count');
  var btn = el('cust-message-selected-btn');
  var deleteBtn = el('cust-delete-selected-btn');
  var bar = el('cust-bulk-bar');
  if (bar) {
    bar.classList.toggle('is-visible', count > 0);
    bar.setAttribute('aria-hidden', count > 0 ? 'false' : 'true');
  }
  if (countEl) {
    countEl.textContent = portalT('customers.outreach.selectedCount').replace('{count}', String(count));
  }
  if (btn) {
    btn.disabled = count < 1;
    var label = portalT('customers.outreach.messageSelected');
    btn.textContent = count > 0 ? (label + ' (' + String(count) + ')') : label;
  }
  if (deleteBtn) deleteBtn.disabled = count < 1;
}

function deleteSelectedCustomerProfiles() {
  var phones = getCustomersBulkSelectedPhones();
  if (!phones.length) return;
  if (!window.confirm(portalT('customers.bulk.deleteConfirm').replace('{count}', String(phones.length)))) return;
  var button = el('cust-delete-selected-btn');
  if (button) button.disabled = true;
  fetch('/staff/customers/bulk-delete?client=' + encodeURIComponent(getClient()), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phones: phones })
  }).then(function(response) { return response.json().then(function(data) { if (!response.ok || !data.success) throw new Error(data.error || 'Delete failed'); return data; }); })
    .then(function(data) {
      customersBulkSelected = {}; selectedCustomerPhone = null;
      customerDetailState = { phone: null, data: null, editing: false, tagsEditing: false };
      window.alert(portalT('customers.bulk.deleteSuccess').replace('{count}', String(data.deleted_count)));
      return loadCustomersList();
    }).catch(function(err) { window.alert(portalT('customers.bulk.deleteFailed') + ' ' + err.message); updateCustomersBulkSelectionUI(); });
}

function buildCustomersOutreachPlan() {
  var phones = getCustomersBulkSelectedPhones();
  var recipients = [];
  var skippedNoPhone = [];
  var skippedDnc = [];
  phones.forEach(function(phone) {
    var c = findCachedCustomer(phone) || { phone: phone };
    var name = c.display_name || phone || 'Guest';
    if (!customerHasValidPhone(c)) {
      skippedNoPhone.push({ phone: phone, name: name });
      return;
    }
    if (customerIsDoNotContact(c)) {
      skippedDnc.push({ phone: c.phone, name: name });
      return;
    }
    recipients.push({ phone: c.phone, name: name });
  });
  return { recipients: recipients, skippedNoPhone: skippedNoPhone, skippedDnc: skippedDnc };
}

var customersOutreachTemplatesCache = [];
var customersOutreachTemplateEditingId = null;
var customersOutreachComposeMode = 'message';
var customersOutreachHasGeneratedDraft = false;
