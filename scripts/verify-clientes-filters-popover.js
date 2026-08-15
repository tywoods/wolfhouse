'use strict';

/**
 * Clientes Filters popover — open / apply / dismiss / EN+ES labels.
 * Sunset-staging portal only. No guest data. Stay off inbox-thread.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const filtersSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-filters.js'), 'utf8');
const profileSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-customers-profile.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

assert.ok(filtersSrc.includes('function positionCustomersFiltersMenu'));
assert.ok(filtersSrc.includes("menu.style.position = 'fixed'"));
assert.ok(filtersSrc.includes('function clearCustomersFiltersMenuPosition'));
assert.ok(filtersSrc.includes('if (customersFiltersMenuOpen) positionCustomersFiltersMenu()'));
assert.ok(profileSrc.includes("ev.key !== 'Escape'"));
assert.ok(profileSrc.includes('closeCustomersFiltersMenu()'));
assert.ok(profileSrc.includes("window.addEventListener('resize'"));
assert.ok(profileSrc.includes("document.addEventListener('scroll'"));
assert.ok(!filtersSrc.includes('inbox-thread.js'));
assert.ok(!profileSrc.includes('inbox-thread.js'));

const requiredEs = {
  'customers.filters.button': 'Filtros',
  'customers.filters.clearAll': 'Limpiar filtros',
  'customers.filter.warmLeads': 'Prospectos templados',
  'customers.filter.hotLeads': 'Prospectos calientes',
  'customers.filter.checkedInNow': 'Con check-in',
  'customers.filter.checkedInNowTitle': 'Actualmente con check-in (solo alojamiento)',
  'customers.filter.doNotContact': 'No contactar',
  'customers.filter.rental': 'Alquiler',
  'customers.filter.all': 'Todos',
  'customers.filter.lessonToday': 'Clase hoy',
  'customers.filter.unpaid': 'Sin pagar',
};

for (const [key, es] of Object.entries(requiredEs)) {
  assert.strictEqual(STAFF_PORTAL_STRINGS.es[key], es, `ES ${key}`);
  assert.ok(STAFF_PORTAL_STRINGS.en[key], `EN ${key} exists`);
  assert.notStrictEqual(STAFF_PORTAL_STRINGS.es[key], STAFF_PORTAL_STRINGS.en[key], `${key} must differ EN/ES`);
  assert.ok(esSrc.includes(`'${key}': '${es}'`) || esSrc.includes(`'${key}': "${es}"`), `es-sunset source has ${key}`);
}

assert.strictEqual(STAFF_PORTAL_STRINGS.en['customers.filters.button'], 'Filters');
assert.strictEqual(STAFF_PORTAL_STRINGS.en['customers.filter.warmLeads'], 'Warm Leads');

function makeEl(id) {
  const classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
    contains(c) { return this._set.has(c); },
  };
  return {
    id,
    style: {},
    classList,
    attributes: {},
    innerHTML: '',
    dataset: {},
    getAttribute(name) { return this.attributes[name] == null ? null : String(this.attributes[name]); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getBoundingClientRect() {
      if (this.id === 'cust-filters-btn') {
        return { left: 40, right: 120, top: 80, bottom: 112, width: 80, height: 32 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
  };
}

const btn = makeEl('cust-filters-btn');
const menu = makeEl('cust-filters-menu');
const chips = makeEl('cust-filter-chips');
const fakeWindow = { innerWidth: 1280, innerHeight: 720, addEventListener() {} };

const harness = `
var customersFiltersMenuOpen = false;
var customersFilter = 'all';
var customersTagFilters = {};
var customersCache = [];
var customersBulkSelected = {};
var selectedCustomerPhone = null;
${filtersSrc}
this.api = {
  open: function() { toggleCustomersFiltersMenu(true); },
  close: function() { closeCustomersFiltersMenu(); },
  isOpen: function() { return customersFiltersMenuOpen; },
  setFilter: function(mode) {
    customersFilter = mode || 'all';
    renderCustomersFilterUI();
  },
  filter: function() { return customersFilter; },
  menuHtml: function() { return el('cust-filters-menu').innerHTML; },
  menuStyle: function() {
    var m = el('cust-filters-menu');
    return {
      position: m.style.position,
      top: m.style.top,
      left: m.style.left,
      maxHeight: m.style.maxHeight,
      zIndex: m.style.zIndex
    };
  },
  ariaHidden: function() { return el('cust-filters-menu').getAttribute('aria-hidden'); },
  expanded: function() { return el('cust-filters-btn').getAttribute('aria-expanded'); }
};
`;

const hbox = {
  el(id) {
    if (id === 'cust-filters-btn') return btn;
    if (id === 'cust-filters-menu') return menu;
    if (id === 'cust-filter-chips') return chips;
    return null;
  },
  escHtml(s) { return String(s == null ? '' : s); },
  portalT(key) { return STAFF_PORTAL_STRINGS.es[key] || STAFF_PORTAL_STRINGS.en[key] || key; },
  getClient() { return 'sunset'; },
  getPortalProfile() { return { is_surf_vertical: true }; },
  closeCustomersOutreachDrawer() {},
  loadCustomersList() { return Promise.resolve(); },
  renderCustomersList() {},
  window: fakeWindow,
  console,
};
vm.createContext(hbox);
vm.runInContext(harness, hbox);

hbox.api.open();
assert.strictEqual(hbox.api.isOpen(), true, 'menu opens');
assert.strictEqual(hbox.api.ariaHidden(), 'false');
assert.strictEqual(hbox.api.expanded(), 'true');
assert.ok(menu.classList.contains('open'), 'open class applied');
const styleOpen = hbox.api.menuStyle();
assert.strictEqual(styleOpen.position, 'fixed', 'uses fixed positioning to escape overflow');
assert.ok(styleOpen.top && styleOpen.left, 'top/left set from trigger');
assert.ok(styleOpen.maxHeight, 'maxHeight constrained to viewport');
assert.strictEqual(styleOpen.zIndex, '500');
assert.ok(hbox.api.menuHtml().includes('Prospectos templados'), 'ES warm leads label rendered');
assert.ok(hbox.api.menuHtml().includes('Prospectos calientes'), 'ES hot leads label rendered');
assert.ok(hbox.api.menuHtml().includes('Clase hoy'), 'ES lesson today label rendered');
assert.ok(hbox.api.menuHtml().includes('data-cust-status-filter="unpaid"'), 'status options present');
assert.ok(!hbox.api.menuHtml().includes('customers.filter.'), 'no raw i18n keys in menu');

hbox.api.setFilter('unpaid');
assert.strictEqual(hbox.api.filter(), 'unpaid', 'status filter applies');
assert.ok(
  hbox.api.menuHtml().includes('data-cust-status-filter="unpaid"')
    && hbox.api.menuHtml().includes('aria-checked="true"'),
  'active status reflected'
);

hbox.api.close();
assert.strictEqual(hbox.api.isOpen(), false, 'menu closes');
assert.strictEqual(hbox.api.ariaHidden(), 'true');
assert.strictEqual(hbox.api.expanded(), 'false');
const styleClosed = hbox.api.menuStyle();
assert.strictEqual(styleClosed.position, '', 'fixed styles cleared on dismiss');
assert.strictEqual(styleClosed.top, '', 'top cleared on dismiss');
assert.ok(!menu.classList.contains('open'), 'open class removed');

const escSlice = profileSrc.slice(
  profileSrc.indexOf('function wireCustomersFiltersUI'),
  profileSrc.indexOf('function wireCustomersTab')
);
assert.ok(/keydown[\s\S]*Escape[\s\S]*closeCustomersFiltersMenu/.test(escSlice));
assert.ok(/stopPropagation/.test(escSlice));
assert.ok(/setCustomersFilter\(statusBtn\.getAttribute\('data-cust-status-filter'\)\)/.test(escSlice));
assert.ok(/closeCustomersFiltersMenu\(\)/.test(escSlice));

console.log('PASS clientes filters popover: open/apply/dismiss + fixed position + EN/ES labels');
