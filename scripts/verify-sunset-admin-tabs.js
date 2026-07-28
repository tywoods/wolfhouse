'use strict';

/**
 * verify:sunset-admin-tabs
 *
 * Stage 2 Admin sub-tabs: Finance (default shell) + Pricing (existing Admin UI).
 * Exercises production owners only — staff-query-api.js HTML/CSS and
 * scripts/browser/sunset-admin-ui.js via getSunsetAdminUiBrowserSource().
 *
 * Run:
 *   node scripts/verify-sunset-admin-tabs.js
 *   npm run verify:sunset-admin-tabs
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const ADMIN_UI = path.join(ROOT, 'scripts', 'browser', 'sunset-admin-ui.js');
const EN_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const ES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');

// Prefer env override; otherwise bind ephemeral port to avoid collisions with stale verify servers.
let PORT = Number(process.env.STAFF_QUERY_API_PORT || '0') || 0;
let BASE_URL = '';

const TAB_I18N_KEYS = [
  'admin.tabs.finance',
  'admin.tabs.pricing',
  'admin.tabs.listLabel',
  'admin.finance.summaryUnavailable',
];

let pass = 0;
let fail = 0;
let serverChild = null;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

function read(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
  return fs.readFileSync(p, 'utf8');
}

function extractTabAdminHtml(apiSrc) {
  const start = apiSrc.indexOf('<div id="tab-admin"');
  const end = apiSrc.indexOf('</div><!-- /tab-admin -->', start);
  if (start < 0 || end < 0) return '';
  return apiSrc.slice(start, end + '</div><!-- /tab-admin -->'.length);
}

function extractAdminCss(apiSrc) {
  // CSS lives in the same template string; grab portal-admin related blocks near tab-admin rules.
  const markers = [
    '.portal-admin-subtabs',
    '.portal-admin-subtab',
    '#admin-panel-finance',
    '#admin-panel-pricing',
    'data-admin-tab',
  ];
  return markers.map((m) => (apiSrc.includes(m) ? m : '')).filter(Boolean);
}

// ── [1] Static: tab order + structure on production HTML ───────────────────

function runStaticStructureChecks() {
  console.log('\n[1] Static Admin sub-tab structure (staff-query-api.js + sunset-admin-ui.js)\n');
  const apiSrc = read(STAFF_API);
  const adminUiSrc = getSunsetAdminUiBrowserSource();
  const html = extractTabAdminHtml(apiSrc);

  assert('tab-admin shell present in staff-query-api.js', html.length > 200);
  assert('production owner sunset-admin-ui.js readable via browser-source',
    adminUiSrc.length > 500 && fs.existsSync(ADMIN_UI));

  // Required: two tabs Finance first, Pricing second
  const tabKeyRe = /data-admin-tab="(finance|pricing)"/g;
  const keys = [];
  let m;
  while ((m = tabKeyRe.exec(html))) keys.push(m[1]);
  assert('exactly two data-admin-tab keys in Admin shell', keys.length === 2, `got ${keys.join(',')}`);
  assert('Finance tab first, Pricing second',
    keys[0] === 'finance' && keys[1] === 'pricing',
    `order=${keys.join(',')}`);

  assert('Finance button type=button',
    /<button[^>]*type="button"[^>]*data-admin-tab="finance"/.test(html)
    || /<button[^>]*data-admin-tab="finance"[^>]*type="button"/.test(html));
  assert('Pricing button type=button',
    /<button[^>]*type="button"[^>]*data-admin-tab="pricing"/.test(html)
    || /<button[^>]*data-admin-tab="pricing"[^>]*type="button"/.test(html));

  assert('tablist role present', /role="tablist"/.test(html));
  assert('role=tab on both buttons', (html.match(/role="tab"/g) || []).length >= 2);
  assert('role=tabpanel for finance and pricing', (html.match(/role="tabpanel"/g) || []).length >= 2);

  assert('aria-controls on finance tab',
    /data-admin-tab="finance"[^>]*aria-controls="admin-panel-finance"/.test(html)
    || /aria-controls="admin-panel-finance"[^>]*data-admin-tab="finance"/.test(html));
  assert('aria-controls on pricing tab',
    /data-admin-tab="pricing"[^>]*aria-controls="admin-panel-pricing"/.test(html)
    || /aria-controls="admin-panel-pricing"[^>]*data-admin-tab="pricing"/.test(html));

  // Pricing containment: existing sections live inside pricing panel
  const panelPricingIdx = html.indexOf('id="admin-panel-pricing"');
  const secTimesIdx = html.indexOf('id="admin-sec-times"');
  const secPricesIdx = html.indexOf('id="admin-sec-prices"');
  const saveMsgIdx = html.indexOf('id="admin-save-msg"');
  assert('admin-panel-pricing wrapper present', panelPricingIdx >= 0);
  assert('admin-sec-times inside pricing panel',
    panelPricingIdx >= 0 && secTimesIdx > panelPricingIdx
    && (saveMsgIdx < 0 || secTimesIdx < saveMsgIdx));
  assert('admin-sec-prices inside pricing panel',
    panelPricingIdx >= 0 && secPricesIdx > panelPricingIdx
    && (saveMsgIdx < 0 || secPricesIdx < saveMsgIdx));
  assert('admin-times-body retained', /id="admin-times-body"/.test(html));
  assert('admin-prices-body retained', /id="admin-prices-body"/.test(html));

  // Finance shell only — no fake revenue markup
  const financeStart = html.indexOf('id="admin-panel-finance"');
  const pricingStart = html.indexOf('id="admin-panel-pricing"');
  const financeHtml = financeStart >= 0 && pricingStart > financeStart
    ? html.slice(financeStart, pricingStart)
    : '';
  assert('finance panel present', financeHtml.length > 0);
  assert('finance panel has no fake revenue numbers',
    !/\b(€|EUR)\s*\d|\brevenue\b|\bmrr\b|\btotal sales\b/i.test(financeHtml));
  assert('no hard-coded Finance/Pricing English in runtime portalT paths without keys',
    adminUiSrc.includes("portalT('admin.tabs.finance')")
    || adminUiSrc.includes('portalT("admin.tabs.finance")')
    || /data-i18n="admin\.tabs\.finance"/.test(html));

  // JS owners
  assert('admin UI defines adminSelectSubTab or equivalent switch',
    /function adminSelectSubTab\s*\(/.test(adminUiSrc)
    || /function selectAdminSubTab\s*\(/.test(adminUiSrc)
    || /function adminSetActiveSubTab\s*\(/.test(adminUiSrc));
  assert('admin UI wires sub-tabs',
    /function wireAdminSubTabs\s*\(/.test(adminUiSrc)
    || /function wireAdminInnerTabs\s*\(/.test(adminUiSrc)
    || /data-admin-tab/.test(adminUiSrc) && /keydown/.test(adminUiSrc));
  assert('default sub-tab is finance on Admin load',
    /adminActiveSubTab\s*=\s*['"]finance['"]/.test(adminUiSrc)
    || /adminSelectSubTab\(\s*['"]finance['"]/.test(adminUiSrc)
    || /selectAdminSubTab\(\s*['"]finance['"]/.test(adminUiSrc));
  assert('keyboard support references ArrowLeft/ArrowRight',
    /ArrowLeft/.test(adminUiSrc) && /ArrowRight/.test(adminUiSrc));
  assert('keyboard support references Home/End',
    /Home/.test(adminUiSrc) && /End/.test(adminUiSrc));
  assert('sub-tab wire is single-entry guarded',
    /adminSubtabsWired|adminTabsWired|dataset\.adminSubtabsWired|data-admin-subtabs-wired/.test(adminUiSrc)
    || /adminWiredSubTabs/.test(adminUiSrc));

  // Mobile CSS contract
  assert('subtab min-height >= 44px CSS',
    /portal-admin-subtab[^}]*min-height:\s*44px/.test(apiSrc)
    || /\.portal-admin-subtab\{[^}]*min-height:\s*44px/.test(apiSrc));
  assert('subtabs prevent horizontal overflow',
    /portal-admin-subtabs\{[^}]*(max-width:\s*100%|overflow-x:\s*hidden|flex-wrap:\s*wrap)/.test(apiSrc)
    || /portal-admin-subtabs[^}]*flex-wrap:\s*wrap/.test(apiSrc));

  return { apiSrc, adminUiSrc, html };
}

// ── [2] Localization keys EN/ES/IT ─────────────────────────────────────────

function runI18nChecks() {
  console.log('\n[2] Admin tab i18n keys (EN/ES/IT production catalogs)\n');
  const en = read(EN_PATH);
  const es = read(ES_PATH);
  const adminUiSrc = getSunsetAdminUiBrowserSource();
  const apiSrc = read(STAFF_API);
  const used = new Set();
  const re = /portalT\('([^']+)'\)/g;
  let m;
  const scan = adminUiSrc + '\n' + extractTabAdminHtml(apiSrc);
  while ((m = re.exec(scan))) {
    if (m[1].startsWith('admin.tabs.') || m[1].startsWith('admin.finance.')) used.add(m[1]);
  }
  // Also data-i18n attributes
  const re2 = /data-i18n(?:-aria)?="(admin\.(?:tabs|finance)\.[^"]+)"/g;
  while ((m = re2.exec(scan))) used.add(m[1]);
  // Required keys must be discovered from production markup/runtime — never pre-seed `used`.
  assert(
    `required tab i18n keys discovered in production usage (${TAB_I18N_KEYS.length})`,
    TAB_I18N_KEYS.every((k) => used.has(k)),
    `missing from production: ${TAB_I18N_KEYS.filter((k) => !used.has(k)).join(',') || 'none'}; used=${[...used].join(',')}`,
  );
  assert('at least one admin.tabs/finance key discovered from production', used.size >= TAB_I18N_KEYS.length);

  for (const k of used) {
    assert(`EN has discovered key ${k}`, en.includes(`'${k}'`));
    assert(`ES has discovered key ${k}`, es.includes(`'${k}'`));
    // IT block is inside staff-portal-i18n.js
    const itBlock = en.slice(en.indexOf('it: {'));
    assert(`IT has discovered key ${k}`, itBlock.includes(`'${k}'`));
  }

  // No hard-coded English tab labels in runtime render without portalT/data-i18n
  assert('admin UI finance shell uses portalT for summary copy',
    /portalT\(\s*['"]admin\.finance\.summaryUnavailable['"]\s*\)/.test(adminUiSrc));
}

// ── [3] In-memory DOM: switch, draft retention, listener safety ────────────

function createMinimalDom(htmlFragment) {
  const elements = new Map();
  const listeners = new Map(); // elementId|type -> count

  function makeEl(id, attrs) {
    const el = {
      id: id || '',
      tagName: (attrs.tagName || 'DIV').toUpperCase(),
      className: attrs.className || '',
      classList: {
        _set: new Set(String(attrs.className || '').split(/\s+/).filter(Boolean)),
        add(c) { this._set.add(c); el.className = [...this._set].join(' '); },
        remove(c) { this._set.delete(c); el.className = [...this._set].join(' '); },
        contains(c) { return this._set.has(c); },
        toggle(c, force) {
          if (force === true) this.add(c);
          else if (force === false) this.remove(c);
          else if (this.contains(c)) this.remove(c);
          else this.add(c);
        },
      },
      dataset: Object.assign({}, attrs.dataset || {}),
      style: {},
      attributes: Object.assign({}, attrs.attributes || {}),
      children: [],
      parentNode: null,
      textContent: attrs.textContent || '',
      innerHTML: attrs.innerHTML || '',
      hidden: !!attrs.hidden,
      tabIndex: attrs.tabIndex != null ? attrs.tabIndex : 0,
      disabled: false,
      checked: false,
      value: attrs.value || '',
      _listeners: {},
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'hidden') this.hidden = v !== null && v !== false;
        if (k === 'aria-selected') this.attributes['aria-selected'] = String(v);
        if (k === 'tabindex' || k === 'tabIndex') this.tabIndex = Number(v);
        if (k.startsWith('data-')) {
          const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this.dataset[dk] = String(v);
        }
      },
      getAttribute(k) {
        if (k === 'hidden') return this.hidden ? '' : null;
        if (Object.prototype.hasOwnProperty.call(this.attributes, k)) return this.attributes[k];
        if (k.startsWith('data-')) {
          const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          return this.dataset[dk] != null ? this.dataset[dk] : null;
        }
        return null;
      },
      hasAttribute(k) {
        return this.getAttribute(k) != null;
      },
      removeAttribute(k) {
        delete this.attributes[k];
        if (k === 'hidden') this.hidden = false;
        if (k.startsWith('data-')) {
          const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          delete this.dataset[dk];
        }
      },
      addEventListener(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
        const key = `${this.id || this.getAttribute('data-admin-tab') || '?'}|${type}`;
        listeners.set(key, (listeners.get(key) || 0) + 1);
      },
      removeEventListener(type, fn) {
        if (!this._listeners[type]) return;
        this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
      },
      dispatchEvent(ev) {
        const type = ev.type;
        const list = this._listeners[type] || [];
        for (const fn of list) fn.call(this, ev);
        return true;
      },
      focus() {
        document.activeElement = this;
      },
      blur() {},
      closest(sel) {
        if (sel.startsWith('[data-admin-tab]') || sel === '[data-admin-tab]') {
          if (this.getAttribute('data-admin-tab')) return this;
        }
        if (sel === '[role="tablist"]' || sel === '.portal-admin-subtabs') {
          if (this.getAttribute('role') === 'tablist' || this.classList.contains('portal-admin-subtabs')) return this;
        }
        let p = this.parentNode;
        while (p) {
          if (sel.startsWith('#') && p.id === sel.slice(1)) return p;
          if (sel === '[role="tablist"]' && p.getAttribute('role') === 'tablist') return p;
          if ((sel === '[data-admin-tab]' || sel.startsWith('[data-admin-tab')) && p.getAttribute('data-admin-tab')) return p;
          p = p.parentNode;
        }
        return null;
      },
      querySelector(sel) {
        return queryIn(this, sel, false);
      },
      querySelectorAll(sel) {
        return queryIn(this, sel, true);
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      contains(node) {
        if (node === this) return true;
        for (const c of this.children) {
          if (c.contains && c.contains(node)) return true;
        }
        return false;
      },
    };
    if (id) elements.set(id, el);
    return el;
  }

  function matchAttrToken(el, token) {
    // token is like role="tab" or data-admin-tab or data-admin-tab="finance"
    const eq = token.indexOf('=');
    if (eq < 0) {
      return el.getAttribute(token) != null
        || (token.startsWith('data-') && el.dataset[token.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] != null);
    }
    const k = token.slice(0, eq);
    const v = token.slice(eq + 1).replace(/^["']|["']$/g, '');
    return el.getAttribute(k) === v;
  }

  function matches(el, sel) {
    if (!el) return false;
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    // Compound: button[role="tab"][data-admin-tab] or [role="tab"][data-admin-tab]
    const attrParts = [];
    let rest = sel;
    let tag = '';
    if (rest[0] !== '[') {
      const idx = rest.indexOf('[');
      if (idx < 0) return el.tagName === rest.toUpperCase();
      tag = rest.slice(0, idx);
      rest = rest.slice(idx);
    }
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    const re = /\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(rest))) attrParts.push(m[1]);
    if (!attrParts.length && !tag) {
      // plain [attr] already handled above when ends with ]
      if (sel.startsWith('[') && sel.endsWith(']')) {
        return matchAttrToken(el, sel.slice(1, -1));
      }
      return el.tagName === sel.toUpperCase();
    }
    return attrParts.every((t) => matchAttrToken(el, t));
  }

  function walk(node, out) {
    out.push(node);
    for (const c of node.children || []) walk(c, out);
  }

  function queryIn(root, sel, all) {
    const found = [];
    const nodes = [];
    walk(root, nodes);
    // skip root itself for querySelector from element? include root
    for (const n of nodes) {
      if (n === root && root !== document) continue;
      // compound: "button[data-admin-tab]"
      const parts = sel.split(',').map((s) => s.trim());
      for (const part of parts) {
        if (part.includes(' ')) {
          // simple descendant: "#x .y" not needed much
          const bits = part.split(/\s+/);
          // only support single-level for tests
          if (matches(n, bits[bits.length - 1])) found.push(n);
        } else if (matches(n, part)) {
          found.push(n);
        }
      }
    }
    if (all) {
      const list = found;
      list.forEach = Array.prototype.forEach;
      return list;
    }
    return found[0] || null;
  }

  const document = {
    body: makeEl(null, { tagName: 'BODY' }),
    activeElement: null,
    getElementById(id) { return elements.get(id) || null; },
    querySelector(sel) { return queryIn(document.body, sel, false); },
    querySelectorAll(sel) { return queryIn(document.body, sel, true); },
    createElement(tag) { return makeEl(null, { tagName: tag }); },
  };

  // Build a simplified tree from key ids in fragment
  const root = makeEl('tab-admin', { tagName: 'DIV', className: 'tab-panel active', dataset: {} });
  document.body.appendChild(root);

  const list = makeEl('admin-subtab-list', {
    tagName: 'DIV',
    className: 'portal-admin-subtabs',
    attributes: { role: 'tablist', 'aria-label': 'Admin sections' },
  });
  root.appendChild(list);

  const finBtn = makeEl('admin-tab-finance', {
    tagName: 'BUTTON',
    className: 'portal-admin-subtab',
    attributes: {
      type: 'button',
      role: 'tab',
      'data-admin-tab': 'finance',
      'aria-controls': 'admin-panel-finance',
      'aria-selected': 'true',
      tabindex: '0',
    },
    dataset: { adminTab: 'finance' },
    textContent: 'Finance',
  });
  finBtn.setAttribute('type', 'button');
  finBtn.setAttribute('role', 'tab');
  finBtn.setAttribute('data-admin-tab', 'finance');
  finBtn.setAttribute('aria-controls', 'admin-panel-finance');
  finBtn.setAttribute('aria-selected', 'true');
  finBtn.setAttribute('tabindex', '0');
  list.appendChild(finBtn);

  const prBtn = makeEl('admin-tab-pricing', {
    tagName: 'BUTTON',
    className: 'portal-admin-subtab',
    attributes: {
      type: 'button',
      role: 'tab',
      'data-admin-tab': 'pricing',
      'aria-controls': 'admin-panel-pricing',
      'aria-selected': 'false',
      tabindex: '-1',
    },
    dataset: { adminTab: 'pricing' },
    textContent: 'Pricing',
  });
  prBtn.setAttribute('type', 'button');
  prBtn.setAttribute('role', 'tab');
  prBtn.setAttribute('data-admin-tab', 'pricing');
  prBtn.setAttribute('aria-controls', 'admin-panel-pricing');
  prBtn.setAttribute('aria-selected', 'false');
  prBtn.setAttribute('tabindex', '-1');
  list.appendChild(prBtn);

  const finPanel = makeEl('admin-panel-finance', {
    tagName: 'DIV',
    attributes: { role: 'tabpanel', 'data-admin-tab-panel': 'finance', 'aria-labelledby': 'admin-tab-finance' },
    dataset: { adminTabPanel: 'finance' },
  });
  finPanel.setAttribute('role', 'tabpanel');
  finPanel.setAttribute('data-admin-tab-panel', 'finance');
  root.appendChild(finPanel);
  const finBody = makeEl('admin-finance-body', { tagName: 'DIV', className: 'portal-admin-finance-shell' });
  finPanel.appendChild(finBody);

  const prPanel = makeEl('admin-panel-pricing', {
    tagName: 'DIV',
    attributes: {
      role: 'tabpanel',
      'data-admin-tab-panel': 'pricing',
      'aria-labelledby': 'admin-tab-pricing',
      hidden: '',
    },
    dataset: { adminTabPanel: 'pricing' },
    hidden: true,
  });
  prPanel.setAttribute('role', 'tabpanel');
  prPanel.setAttribute('data-admin-tab-panel', 'pricing');
  prPanel.setAttribute('hidden', '');
  prPanel.hidden = true;
  root.appendChild(prPanel);

  const timesBody = makeEl('admin-times-body', { tagName: 'DIV' });
  const pricesBody = makeEl('admin-prices-body', { tagName: 'DIV' });
  const packGrid = makeEl('admin-pack-card-grid', { tagName: 'DIV' });
  const packCard = makeEl(null, { tagName: 'DIV', className: 'portal-admin-pack-card' });
  // draft input to prove retention
  const draftInput = makeEl('admin-capacity-input', {
    tagName: 'INPUT',
    value: 'DRAFT-KEEP-ME',
  });
  draftInput.value = 'DRAFT-KEEP-ME';
  packGrid.appendChild(packCard);
  timesBody.appendChild(packGrid);
  timesBody.appendChild(draftInput);
  prPanel.appendChild(timesBody);
  prPanel.appendChild(pricesBody);

  const saveMsg = makeEl('admin-save-msg', { tagName: 'DIV' });
  root.appendChild(saveMsg);

  // Patch querySelector on list to find tabs (include compound [role="tab"][data-admin-tab])
  list.querySelectorAll = function(sel) {
    if (
      sel === '[role="tab"]'
      || sel === 'button[data-admin-tab]'
      || sel === '[data-admin-tab]'
      || sel === '[role="tab"][data-admin-tab]'
      || sel === 'button[role="tab"][data-admin-tab]'
    ) {
      return [finBtn, prBtn];
    }
    return queryIn(list, sel, true);
  };
  list.querySelector = function(sel) {
    return list.querySelectorAll(sel)[0] || null;
  };

  return { document, elements, listeners, finBtn, prBtn, finPanel, prPanel, draftInput, list, root };
}

function runDomBehaviorChecks() {
  console.log('\n[3] DOM behavior: default, switch, draft retention, keyboard, listener safety\n');
  const adminUiSrc = getSunsetAdminUiBrowserSource();

  // Extract only the tab-related functions + state we need; full admin UI has many deps.
  // Prefer executing production functions if present.
  const hasSelect = /function adminSelectSubTab\s*\(/.test(adminUiSrc);
  const hasWire = /function wireAdminSubTabs\s*\(/.test(adminUiSrc);
  assert('production adminSelectSubTab exists for DOM harness', hasSelect);
  assert('production wireAdminSubTabs exists for DOM harness', hasWire);
  if (!hasSelect || !hasWire) return;

  const { document, listeners, finBtn, prBtn, finPanel, prPanel, draftInput, list, root } = createMinimalDom();

  const i18n = {
    'admin.tabs.finance': 'Finance',
    'admin.tabs.pricing': 'Pricing',
    'admin.tabs.listLabel': 'Admin sections',
    'admin.finance.summaryUnavailable': 'Finance summary is not available yet.',
    'admin.loading': 'Loading…',
  };

  const sandbox = {
    console,
    document,
    window: {},
    portalT(key) { return i18n[key] != null ? i18n[key] : key; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el(id) { return document.getElementById(id); },
    adminConfigCache: { success: true, writes_enabled: true, prices: [], lesson_times: [], surf_packs: [] },
    adminEditTarget: null,
    adminSaveBusy: false,
    adminLoadSeq: 0,
    adminActiveSubTab: 'finance',
    getClient() { return 'sunset'; },
    getPortalProfile() { return { is_surf_vertical: true }; },
    getSunsetLocation() { return 'sunset-somo'; },
    getSunsetLocationLabel() { return 'Sunset'; },
    SUNSET_SCHEDULE_LESSON_DAY_CAP: 24,
    scheduleInvalidateAdminCatalogCache() {},
    renderAdminSchoolContext() {},
    renderAdminSectionLessonTimesFromConfig() {},
    renderAdminSectionPricesFromConfig() {},
    fetch() { return Promise.reject(new Error('no network in unit harness')); },
    Promise,
    setTimeout,
    clearTimeout,
    Array,
    String,
    Number,
    Object,
    Math,
    JSON,
    Error,
    parseInt,
    isNaN,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Provide no-op stubs for all function declarations we might not extract fully.
  // Execute the full admin UI source after stubbing missing helpers referenced at parse time.
  // Strategy: extract tab functions by regex and evaluate with state vars.
  const selectMatch = adminUiSrc.match(/function adminSelectSubTab\s*\([\s\S]*?\n\}/);
  const wireMatch = adminUiSrc.match(/function wireAdminSubTabs\s*\([\s\S]*?\n\}/);
  const financeMatch = adminUiSrc.match(/function renderAdminFinanceShell\s*\([\s\S]*?\n\}/);
  // Multi-line functions may have nested braces — use brace counting
  function extractFn(src, name) {
    const startRe = new RegExp(`function ${name}\\s*\\(`);
    const sm = startRe.exec(src);
    if (!sm) return null;
    let i = sm.index;
    const braceStart = src.indexOf('{', i);
    let depth = 0;
    for (let j = braceStart; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    return null;
  }

  const selectFn = extractFn(adminUiSrc, 'adminSelectSubTab');
  const wireFn = extractFn(adminUiSrc, 'wireAdminSubTabs');
  const financeFn = extractFn(adminUiSrc, 'renderAdminFinanceShell');
  assert('extracted adminSelectSubTab source', !!selectFn);
  assert('extracted wireAdminSubTabs source', !!wireFn);
  assert('extracted renderAdminFinanceShell source', !!financeFn);
  if (!selectFn || !wireFn) return;

  const prelude = [
    'var adminActiveSubTab = "finance";',
    selectFn,
    financeFn || 'function renderAdminFinanceShell(){}',
    wireFn,
  ].join('\n');

  vm.runInNewContext(prelude, sandbox, { filename: 'sunset-admin-ui-tabs.js' });

  // Initial default
  sandbox.adminSelectSubTab('finance');
  if (sandbox.renderAdminFinanceShell) sandbox.renderAdminFinanceShell();

  assert('default finance aria-selected true', finBtn.getAttribute('aria-selected') === 'true');
  assert('default pricing aria-selected false', prBtn.getAttribute('aria-selected') === 'false');
  assert('default finance panel visible (not hidden)', !finPanel.hidden);
  assert('default pricing panel hidden', prPanel.hidden === true);

  // Finance shell honest copy
  const finText = finBodyText();
  function finBodyText() {
    const b = document.getElementById('admin-finance-body');
    return (b && (b.innerHTML || b.textContent)) || '';
  }
  assert('finance shell shows unavailable summary copy',
    /not available yet|summaryUnavailable|Finance summary/i.test(finBodyText())
    || finBodyText().includes(i18n['admin.finance.summaryUnavailable']));
  assert('finance shell has no currency amount fake values',
    !/€\s*\d|\d+\s*EUR|\$\d/.test(finBodyText()));

  // Switch to pricing via API
  sandbox.adminSelectSubTab('pricing');
  assert('pricing selected after switch', prBtn.getAttribute('aria-selected') === 'true');
  assert('finance deselected after switch', finBtn.getAttribute('aria-selected') === 'false');
  assert('pricing panel visible', !prPanel.hidden);
  assert('finance panel hidden after switch', finPanel.hidden === true);

  // Draft retention: input value still present (no re-render of pricing)
  assert('pricing draft input retained after tab switch',
    draftInput.value === 'DRAFT-KEEP-ME');

  // Switch back
  sandbox.adminSelectSubTab('finance');
  assert('draft still retained after return to finance', draftInput.value === 'DRAFT-KEEP-ME');
  assert('pricing panel hidden again', prPanel.hidden === true);

  // Wire once
  sandbox.wireAdminSubTabs();
  sandbox.wireAdminSubTabs();
  sandbox.wireAdminSubTabs();
  const clickCount = listeners.get('admin-subtab-list|click') || listeners.get('admin-tab-finance|click') || 0;
  // Either list-level delegation once, or per-button once each
  const listClicks = listeners.get('admin-subtab-list|click') || 0;
  const finClicks = listeners.get('admin-tab-finance|click') || 0;
  const prClicks = listeners.get('admin-tab-pricing|click') || 0;
  const keyCount = (listeners.get('admin-subtab-list|keydown') || 0)
    + (listeners.get('admin-tab-finance|keydown') || 0)
    + (listeners.get('admin-tab-pricing|keydown') || 0);
  assert('click listeners not duplicated across re-wire',
    (listClicks <= 1 && finClicks <= 1 && prClicks <= 1) && (listClicks + finClicks + prClicks >= 1),
    `list=${listClicks} fin=${finClicks} pr=${prClicks}`);
  assert('keydown listeners not duplicated',
    keyCount >= 1 && keyCount <= 3,
    `keydown total=${keyCount}`);

  // Keyboard: real keydown dispatch only — never repair with adminSelectSubTab after failure.
  finBtn.focus();
  const keyEv = (key, target) => ({
    type: 'keydown',
    key,
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
    target,
    currentTarget: list,
  });
  sandbox.adminSelectSubTab('finance', { focus: true });
  assert('pre-ArrowRight finance selected', finBtn.getAttribute('aria-selected') === 'true');
  list.dispatchEvent(keyEv('ArrowRight', finBtn));
  assert('ArrowRight keydown selects pricing tab', prBtn.getAttribute('aria-selected') === 'true');
  assert('ArrowRight keydown moves focus to pricing tab', document.activeElement === prBtn);

  sandbox.adminSelectSubTab('finance', { focus: true });
  assert('focus synchronized with finance selection', document.activeElement === finBtn);
  sandbox.adminSelectSubTab('pricing', { focus: true });
  assert('focus synchronized with pricing selection', document.activeElement === prBtn);

  // Home/End: assert executed selection behavior only (no source-string fallback).
  sandbox.adminSelectSubTab('finance', { focus: true });
  list.dispatchEvent(keyEv('End', finBtn));
  assert('End key selects last (pricing) tab', prBtn.getAttribute('aria-selected') === 'true');
  assert('End key moves focus to pricing tab', document.activeElement === prBtn);
  list.dispatchEvent(keyEv('Home', prBtn));
  assert('Home key selects first (finance) tab', finBtn.getAttribute('aria-selected') === 'true');
  assert('Home key moves focus to finance tab', document.activeElement === finBtn);
}

// ── [3b] Pricing draft retention across real renderAdminFromConfig ─────────

const { getSunsetAdminBrowserHelperSource } = require('./lib/sunset-admin-ui-helpers');

/**
 * Lightweight form-host box: when production sets innerHTML, expose real input/select/textarea
 * controls (id, value, checked, querySelectorAll) so draft snapshot/restore can run.
 */
function createFormAwareRegistry() {
  const byId = new Map();

  function parseAttrs(attrStr) {
    const attrs = {};
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(attrStr))) attrs[m[1]] = m[2];
    if (/\bchecked\b/i.test(attrStr) && attrs.checked == null) attrs.checked = 'checked';
    if (/\bselected\b/i.test(attrStr) && attrs.selected == null) attrs.selected = 'selected';
    return attrs;
  }

  function makeControl(tag, attrStr, inner, cardId) {
    const attrs = parseAttrs(attrStr || '');
    const tagName = String(tag).toUpperCase();
    let value = attrs.value != null ? attrs.value : '';
    if (tagName === 'TEXTAREA') value = inner != null ? String(inner) : value;
    if (tagName === 'SELECT' && inner) {
      const sel = /<option\b([^>]*)\bselected\b[^>]*value="([^"]*)"/i.exec(inner)
        || /<option\b[^>]*value="([^"]*)"[^>]*\bselected\b/i.exec(inner);
      if (sel) value = sel[2] != null ? sel[2] : sel[1];
      else {
        const first = /value="([^"]*)"/.exec(inner);
        if (first) value = first[1];
      }
    }
    const ctrl = {
      tagName,
      id: attrs.id || '',
      type: attrs.type || (tagName === 'SELECT' ? 'select-one' : tagName === 'TEXTAREA' ? 'textarea' : 'text'),
      className: attrs.class || '',
      attributes: attrs,
      _priceCardId: cardId || '',
      get value() { return value; },
      set value(v) { value = v == null ? '' : String(v); },
      checked: attrs.checked != null,
      getAttribute(k) {
        if (k === 'id') return this.id || null;
        if (Object.prototype.hasOwnProperty.call(this.attributes, k)) return this.attributes[k];
        return null;
      },
      closest(sel) {
        if ((sel === '[data-admin-price-card]' || sel.startsWith('[data-admin-price-card')) && this._priceCardId) {
          const id = this._priceCardId;
          return {
            getAttribute(k) { return k === 'data-admin-price-card' ? id : null; },
          };
        }
        if ((sel === '[data-admin-pack-form]' || sel.startsWith('[data-admin-pack-form')) && this._packFormId) {
          const id = this._packFormId;
          return {
            getAttribute(k) { return k === 'data-admin-pack-form' ? id : null; },
          };
        }
        if (sel === '[data-pack-tier-row]' && this._tierRowIndex != null) {
          return { querySelector: () => null, _tierRowIndex: this._tierRowIndex };
        }
        return null;
      },
      classList: {
        contains: (c) => String(attrs.class || '').split(/\s+/).includes(c),
      },
    };
    return ctrl;
  }

  function parseControls(html) {
    const controls = [];
    // Inputs are usually unclosed `<input ...>` (not `/>` and not `</input>`).
    const inputRe = /<input\b([^>]*)>/gi;
    let m;
    while ((m = inputRe.exec(html))) {
      const before = html.slice(0, m.index);
      const cardM = [...before.matchAll(/data-admin-price-card="([^"]*)"/g)].pop();
      const packM = [...before.matchAll(/data-admin-pack-form="([^"]*)"/g)].pop();
      const tierCount = (before.match(/data-pack-tier-row/g) || []).length;
      const ctrl = makeControl('input', m[1], '', cardM ? cardM[1] : '');
      if (packM) ctrl._packFormId = packM[1];
      if (/\bpack-tier-(?:amount|key)\b/.test(m[1] || '')) ctrl._tierRowIndex = Math.max(0, tierCount - 1);
      controls.push(ctrl);
      if (ctrl.id) byId.set(ctrl.id, ctrl);
    }
    const pairRe = /<(select|textarea)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    while ((m = pairRe.exec(html))) {
      const before = html.slice(0, m.index);
      const cardM = [...before.matchAll(/data-admin-price-card="([^"]*)"/g)].pop();
      const packM = [...before.matchAll(/data-admin-pack-form="([^"]*)"/g)].pop();
      const tierCount = (before.match(/data-pack-tier-row/g) || []).length;
      const ctrl = makeControl(m[1], m[2], m[3], cardM ? cardM[1] : '');
      if (packM) ctrl._packFormId = packM[1];
      if (/\bpack-tier-(?:amount|key)\b/.test(m[2] || '')) ctrl._tierRowIndex = Math.max(0, tierCount - 1);
      controls.push(ctrl);
      if (ctrl.id) byId.set(ctrl.id, ctrl);
    }
    return controls;
  }

  function makeBox(id) {
    let html = '';
    let controls = [];
    const box = {
      id,
      get innerHTML() { return html; },
      set innerHTML(v) {
        for (const c of controls) {
          if (c.id && byId.get(c.id) === c) byId.delete(c.id);
        }
        html = String(v || '');
        controls = parseControls(html);
      },
      querySelectorAll(sel) {
        const s = String(sel || '').replace(/\s+/g, ' ').trim();
        if (s === 'input, select, textarea' || s === 'input,select,textarea') return controls.slice();
        if (s === 'input' || s === 'select' || s === 'textarea') {
          return controls.filter((c) => c.tagName === s.toUpperCase());
        }
        // [data-admin-price-field="amount"]
        const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(s);
        if (attr) {
          return controls.filter((c) => {
            const got = c.getAttribute(attr[1]);
            if (attr[2] == null) return got != null;
            return got === attr[2];
          });
        }
        return [];
      },
      querySelector(sel) {
        const all = box.querySelectorAll(sel);
        return all[0] || null;
      },
    };
    byId.set(id, box);
    return box;
  }

  return {
    byId,
    makeBox,
    getElementById(id) { return byId.get(id) || null; },
  };
}

function realisticPricingCfg(locationId) {
  const prices = [];
  for (const k of ['1_day', '2_days', '3_days', '4_days', '5_days', '6_days', '7_days']) {
    prices.push({
      id: `r-${k}`,
      category: 'rental',
      item_code: `board_and_suit_rental__${k}`,
      offering_key: `board_and_suit_rental__${k}`,
      unit: k,
      amount: 25,
      amount_cents: 2500,
      currency: 'EUR',
      active: true,
    });
  }
  return {
    success: true,
    writes_enabled: true,
    location_id: locationId || 'sunset-somo',
    currency: 'EUR',
    prices,
    lesson_times: [],
    surf_packs: [],
    private_lesson: {
      enabled: true,
      label: 'Private lesson',
      amount_cents: 8000,
      currency: 'EUR',
      default_duration_minutes: 120,
      notes: '',
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(times) {
  const n = times == null ? 8 : times;
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function createAdminUiSandbox(registry, locationRef) {
  const sandbox = {
    console,
    document: {
      getElementById(id) { return registry.getElementById(id); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    window: {},
    portalT(key) { return key; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el(id) { return registry.getElementById(id); },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return locationRef.location; },
    getSunsetLocationLabel() {
      return locationRef.location === 'sunset-sardinero' ? 'elSardi' : 'Sunset';
    },
    getPortalProfile() { return { is_surf_vertical: true }; },
    SUNSET_SCHEDULE_LESSON_DAY_CAP: 24,
    scheduleInvalidateAdminCatalogCache() {},
    fetch() { return Promise.reject(new Error('no network in draft harness')); },
    Promise,
    setTimeout,
    clearTimeout,
    Array,
    String,
    Number,
    Object,
    Math,
    JSON,
    Error,
    parseInt,
    isNaN,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(getSunsetAdminBrowserHelperSource(), sandbox);
  vm.runInContext(getSunsetAdminUiBrowserSource(), sandbox);
  return sandbox;
}

function seedAdminHarnessDom(registry) {
  registry.makeBox('admin-prices-body');
  registry.makeBox('admin-times-body');
  registry.byId.set('admin-save-msg', { style: {}, textContent: '', className: '' });
  registry.byId.set('admin-write-banner', { style: {} });
  registry.byId.set('admin-finance-body', { innerHTML: '' });
  registry.byId.set('admin-fetch-state', {
    textContent: '',
    style: { display: 'none' },
    className: '',
    classList: { remove() {}, add() {} },
  });
  registry.byId.set('admin-panel-finance', {
    removeAttribute() {},
    setAttribute() {},
    hidden: false,
  });
  registry.byId.set('admin-panel-pricing', {
    removeAttribute() {},
    setAttribute() {},
    hidden: true,
  });
  registry.byId.set('admin-subtab-list', {
    dataset: {},
    querySelectorAll() { return []; },
    addEventListener() {},
  });
  registry.byId.set('tab-admin', { dataset: {}, addEventListener() {} });
}

function realisticPricingCfgWithMarker(locationId, amountEuros) {
  const cfg = realisticPricingCfg(locationId);
  const euros = Number(amountEuros);
  const cents = Math.round(euros * 100);
  for (const p of cfg.prices) {
    p.amount = euros;
    p.amount_cents = cents;
  }
  cfg._marker = `${locationId}:${euros.toFixed(2)}`;
  return cfg;
}

async function runPricingDraftRerenderChecks() {
  console.log('\n[3b] Pricing draft retention across real renderAdminFromConfig\n');
  const registry = createFormAwareRegistry();
  seedAdminHarnessDom(registry);
  const locationRef = { location: 'sunset-somo' };
  const sandbox = createAdminUiSandbox(registry, locationRef);

  assert('production defines renderAdminFromConfig', typeof sandbox.renderAdminFromConfig === 'function');
  assert(
    'renderAdminFromConfig accepts preserveDraft option (signature/source)',
    /function renderAdminFromConfig\s*\(\s*cfg\s*,\s*opts\s*\)/.test(getSunsetAdminUiBrowserSource())
      || /opts\s*&&\s*opts\.preserveDraft|opts\.preserveDraft/.test(getSunsetAdminUiBrowserSource()),
  );
  assert(
    'adminReloadConfigKeepingEdit passes preserveDraft on success path',
    /renderAdminFromConfig\s*\(\s*data\s*,\s*\{\s*preserveDraft\s*:\s*true\s*\}\s*\)/.test(getSunsetAdminUiBrowserSource()),
  );
  assert(
    'production defines adminReloadConfigKeepingEdit',
    typeof sandbox.adminReloadConfigKeepingEdit === 'function',
  );
  assert(
    'production defines adminReloadConfig (canonical save/reload owner)',
    typeof sandbox.adminReloadConfig === 'function',
  );

  const cfg = realisticPricingCfg(locationRef.location);
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.adminConfigCache = cfg;
  sandbox.renderAdminFromConfig(cfg);
  const amountId = 'admin-price-amount-r-1_day';
  let amountEl = registry.getElementById(amountId);
  assert('rendered Pricing amount control exists', !!(amountEl && amountEl.tagName === 'INPUT'), amountId);
  if (!amountEl) return;

  const serverAmount = amountEl.value;
  assert('server amount seeded', serverAmount === '25.00', `got ${serverAmount}`);
  amountEl.value = '99.50';
  assert('draft amount written in-memory before rerender', amountEl.value === '99.50');

  // Config refresh while still editing — must retain draft when preserveDraft:true
  sandbox.renderAdminFromConfig(cfg, { preserveDraft: true });
  amountEl = registry.getElementById(amountId);
  assert(
    'preserveDraft=true retains unsaved Pricing amount across renderAdminFromConfig',
    !!(amountEl && amountEl.value === '99.50'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );

  // Successful save / canonical refresh — must run production reload owner, not a direct
  // non-preserving renderAdminFromConfig call (that would be self-fulfilling).
  amountEl.value = '99.50';
  sandbox.renderAdminFromConfig(cfg, { preserveDraft: true });
  amountEl = registry.getElementById(amountId);
  assert('draft present before production save reload', !!(amountEl && amountEl.value === '99.50'));
  sandbox.fetch = function adminSaveReloadFetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cfg),
    });
  };
  sandbox.adminReloadConfig();
  await flushMicrotasks(12);
  assert(
    'production adminReloadConfig clears stored draft state',
    sandbox.adminPricingDraftState == null,
  );
  assert(
    'production adminReloadConfig clears edit target',
    sandbox.adminEditTarget == null,
  );
  // Canonical save reload exits edit mode (no amount inputs). Re-enter edit: server truth only.
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminFromConfig(cfg);
  amountEl = registry.getElementById(amountId);
  assert(
    'production adminReloadConfig/loadAdminTab leaves no stale draft on re-edit',
    !!(amountEl && amountEl.value === '25.00'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );

  // Edit again, then deliberate full Admin reopen path clears draft
  amountEl.value = '77.25';
  sandbox.renderAdminFromConfig(cfg, { preserveDraft: true });
  amountEl = registry.getElementById(amountId);
  assert('draft retained again before reopen clear', !!(amountEl && amountEl.value === '77.25'));

  sandbox.fetch = function adminReopenFetch() {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(cfg),
    });
  };
  // Production Admin reopen: loadAdminTab({ resetSubTab: true }) clears drafts.
  sandbox.loadAdminTab({ resetSubTab: true });
  await flushMicrotasks(12);
  assert('Admin reopen cleared draft state', sandbox.adminPricingDraftState == null);
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminFromConfig(cfg);
  amountEl = registry.getElementById(amountId);
  assert(
    'Admin reopen/full refresh does not restore stale draft on re-edit',
    !!(amountEl && amountEl.value === '25.00'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );

  // School mismatch: snapshot at school A, re-render school B, restore must not apply.
  assert('adminSnapshotPricingDraftState exists for school-mismatch gate',
    typeof sandbox.adminSnapshotPricingDraftState === 'function');
  assert('adminRestorePricingDraftState exists for school-mismatch gate',
    typeof sandbox.adminRestorePricingDraftState === 'function');
  locationRef.location = 'sunset-somo';
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminFromConfig(cfg);
  amountEl = registry.getElementById(amountId);
  if (amountEl) amountEl.value = '55.55';
  sandbox.adminSnapshotPricingDraftState();
  assert('snapshot school key recorded',
    !!(sandbox.adminPricingDraftState && sandbox.adminPricingDraftState.schoolKey === 'sunset|sunset-somo'));
  locationRef.location = 'sunset-sardinero';
  const cfgOther = realisticPricingCfg(locationRef.location);
  sandbox.adminConfigCache = cfgOther;
  sandbox.adminEditTarget = 'price-group:bundles';
  // Section re-render only (avoid renderAdminFromConfig clear) then attempt restore.
  sandbox.renderAdminSectionPricesFromConfig(cfgOther);
  sandbox.adminRestorePricingDraftState();
  amountEl = registry.getElementById(amountId);
  assert(
    'draft restore skips mismatched school',
    !!(amountEl && amountEl.value === '25.00'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );
  assert('school mismatch clears stored draft state', sandbox.adminPricingDraftState == null);

  // Retained-snapshot ownership: mismatched target must not apply draft, but snapshot stays
  // so a later matching-target restore can still rehydrate (no self-fulfilling clear+rerender).
  locationRef.location = 'sunset-somo';
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminFromConfig(cfg);
  amountEl = registry.getElementById(amountId);
  if (amountEl) amountEl.value = '66.66';
  sandbox.adminSnapshotPricingDraftState();
  assert(
    'retained snapshot captured for ownership test',
    !!(sandbox.adminPricingDraftState
      && sandbox.adminPricingDraftState.editTarget === 'price-group:bundles'
      && sandbox.adminPricingDraftState.fields
      && sandbox.adminPricingDraftState.fields[`id:${amountId}`]
      && sandbox.adminPricingDraftState.fields[`id:${amountId}`].value === '66.66'),
  );
  sandbox.adminEditTarget = 'private-lesson';
  sandbox.renderAdminSectionPricesFromConfig(cfg);
  sandbox.adminRestorePricingDraftState();
  assert(
    'mismatched edit target retains snapshot (does not clear)',
    !!(sandbox.adminPricingDraftState
      && sandbox.adminPricingDraftState.editTarget === 'price-group:bundles'
      && sandbox.adminPricingDraftState.fields[`id:${amountId}`]
      && sandbox.adminPricingDraftState.fields[`id:${amountId}`].value === '66.66'),
  );
  // Re-enter matching target WITHOUT restore first: server truth proves draft was not applied
  // while ownership mismatched (no self-fulfilling clear via non-preserve full render).
  sandbox.adminEditTarget = 'price-group:bundles';
  sandbox.renderAdminSectionPricesFromConfig(cfg);
  amountEl = registry.getElementById(amountId);
  assert(
    'after mismatched restore attempt, matching surface still server truth before re-restore',
    !!(amountEl && amountEl.value === '25.00'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );
  // Now restore — retained snapshot must rehydrate the draft.
  sandbox.adminRestorePricingDraftState();
  amountEl = registry.getElementById(amountId);
  assert(
    'retained snapshot restores when edit target matches again',
    !!(amountEl && amountEl.value === '66.66'),
    amountEl ? `got ${amountEl.value}` : 'missing control',
  );
}

/**
 * Real async production-source VM tests for in-flight adminReloadConfigKeepingEdit().
 * Asserts stale responses do not mutate cache/DOM/target/draft; newest load wins;
 * stale finally cannot clear a newer busy owner.
 */
async function runAdminReloadOwnershipRaceChecks() {
  console.log('\n[3c] adminReloadConfigKeepingEdit ownership / in-flight races\n');
  const amountId = 'admin-price-amount-r-1_day';

  // ── (1) Delayed response after school/location change ───────────────────
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfgA = realisticPricingCfgWithMarker('sunset-somo', 25);
    const cfgB = realisticPricingCfgWithMarker('sunset-sardinero', 40);
    const stalePayload = realisticPricingCfgWithMarker('sunset-somo', 11);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfgA;
    sandbox.adminSaveBusy = true;
    sandbox.renderAdminFromConfig(cfgA);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '88.00';
    sandbox.adminSnapshotPricingDraftState();
    const draftBefore = sandbox.adminPricingDraftState;
    const draftJsonBefore = JSON.stringify(draftBefore);

    const d = deferred();
    let fetchCount = 0;
    sandbox.fetch = function schoolRaceFetch() {
      fetchCount += 1;
      return d.promise.then((body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('school-race: reload issues one fetch', fetchCount === 1, `fetchCount=${fetchCount}`);
    assert('school-race: busy remains set for in-flight reload', sandbox.adminSaveBusy === true);

    // Ownership changes in flight: school B is now current with its own cache/DOM.
    locationRef.location = 'sunset-sardinero';
    sandbox.adminConfigCache = cfgB;
    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.renderAdminFromConfig(cfgB, { preserveDraft: false });
    amountEl = registry.getElementById(amountId);
    const htmlBeforeStale = registry.getElementById('admin-prices-body').innerHTML;
    const targetBeforeStale = sandbox.adminEditTarget;
    const cacheBeforeStale = sandbox.adminConfigCache;

    d.resolve(stalePayload);
    await flushMicrotasks(16);

    assert(
      'school-race: stale response does not install foreign config cache',
      sandbox.adminConfigCache === cacheBeforeStale
        && sandbox.adminConfigCache
        && sandbox.adminConfigCache._marker === cfgB._marker,
      sandbox.adminConfigCache && sandbox.adminConfigCache._marker,
    );
    assert(
      'school-race: stale response does not mutate edit target',
      sandbox.adminEditTarget === targetBeforeStale,
      String(sandbox.adminEditTarget),
    );
    assert(
      'school-race: stale response does not mutate Pricing DOM',
      registry.getElementById('admin-prices-body').innerHTML === htmlBeforeStale,
    );
    amountEl = registry.getElementById(amountId);
    assert(
      'school-race: school B server amount remains (no stale A install)',
      !!(amountEl && amountEl.value === '40.00'),
      amountEl ? `got ${amountEl.value}` : 'missing',
    );
  }

  // ── (2) Delayed response after edit-target change ───────────────────────
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg = realisticPricingCfgWithMarker('sunset-somo', 25);
    const stalePayload = realisticPricingCfgWithMarker('sunset-somo', 13);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg;
    sandbox.renderAdminFromConfig(cfg);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '77.00';
    sandbox.adminSnapshotPricingDraftState();

    const d = deferred();
    sandbox.fetch = function targetRaceFetch() {
      return d.promise.then((body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    // User switches edit surface while reload is in flight.
    sandbox.adminEditTarget = 'private-lesson';
    const cacheBefore = sandbox.adminConfigCache;
    const htmlBefore = registry.getElementById('admin-prices-body').innerHTML;
    const draftBefore = JSON.stringify(sandbox.adminPricingDraftState);

    d.resolve(stalePayload);
    await flushMicrotasks(16);

    assert(
      'target-race: stale response does not steal edit target back',
      sandbox.adminEditTarget === 'private-lesson',
      String(sandbox.adminEditTarget),
    );
    assert(
      'target-race: stale response does not replace config cache',
      sandbox.adminConfigCache === cacheBefore
        && sandbox.adminConfigCache
        && sandbox.adminConfigCache._marker === cfg._marker,
    );
    assert(
      'target-race: stale response does not mutate Pricing DOM',
      registry.getElementById('admin-prices-body').innerHTML === htmlBefore,
    );
    // Exact retained draft identity — no content-fallback that would hide a wipe+rebuild.
    assert(
      'target-race: draft snapshot identity retained (exact, no fallback)',
      JSON.stringify(sandbox.adminPricingDraftState) === draftBefore,
      `before=${draftBefore} after=${JSON.stringify(sandbox.adminPricingDraftState)}`,
    );
  }

  // ── (3) Overlapping reloads — newest wins ───────────────────────────────
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg0 = realisticPricingCfgWithMarker('sunset-somo', 25);
    const olderPayload = realisticPricingCfgWithMarker('sunset-somo', 17);
    const newerPayload = realisticPricingCfgWithMarker('sunset-somo', 19);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '55.00';
    sandbox.adminSnapshotPricingDraftState();

    const queue = [];
    sandbox.fetch = function overlapFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('overlap: two in-flight reloads', queue.length === 2, `queue=${queue.length}`);

    // Newest completes first.
    queue[1].resolve(newerPayload);
    await flushMicrotasks(16);
    amountEl = registry.getElementById(amountId);
    assert(
      'overlap: newest response installs config marker',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === newerPayload._marker),
      sandbox.adminConfigCache && sandbox.adminConfigCache._marker,
    );
    assert(
      'overlap: newest keep-edit preserves draft amount',
      !!(amountEl && amountEl.value === '55.00'),
      amountEl ? `got ${amountEl.value}` : 'missing',
    );
    assert('overlap: edit target kept after newest', sandbox.adminEditTarget === 'price-group:bundles');
    assert('overlap: busy cleared after newest completion', sandbox.adminSaveBusy === false);

    const cacheAfterNewest = sandbox.adminConfigCache;
    const htmlAfterNewest = registry.getElementById('admin-prices-body').innerHTML;
    const targetAfterNewest = sandbox.adminEditTarget;
    const draftAfterNewest = JSON.stringify(sandbox.adminPricingDraftState);

    // Older response arrives late — must be discarded.
    queue[0].resolve(olderPayload);
    await flushMicrotasks(16);

    assert(
      'overlap: older response does not replace newer cache',
      sandbox.adminConfigCache === cacheAfterNewest
        && sandbox.adminConfigCache._marker === newerPayload._marker,
    );
    assert(
      'overlap: older response does not mutate DOM after newest',
      registry.getElementById('admin-prices-body').innerHTML === htmlAfterNewest,
    );
    assert('overlap: older response does not change edit target', sandbox.adminEditTarget === targetAfterNewest);
    assert(
      'overlap: older response does not mutate draft after newest',
      JSON.stringify(sandbox.adminPricingDraftState) === draftAfterNewest,
    );
    amountEl = registry.getElementById(amountId);
    assert(
      'overlap: draft still 55.00 after discarded older response',
      !!(amountEl && amountEl.value === '55.00'),
      amountEl ? `got ${amountEl.value}` : 'missing',
    );
  }

  // ── (4) Stale finally/error cannot clear newer busy owner ───────────────
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg = realisticPricingCfgWithMarker('sunset-somo', 25);
    const newerPayload = realisticPricingCfgWithMarker('sunset-somo', 21);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg;
    sandbox.renderAdminFromConfig(cfg);

    const queue = [];
    sandbox.fetch = function busyRaceFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => {
        if (body && body.__reject) {
          return Promise.reject(new Error(body.__reject));
        }
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        };
      });
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('busy-race: first reload sets busy', sandbox.adminSaveBusy === true);
    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('busy-race: second reload keeps busy', sandbox.adminSaveBusy === true);
    assert('busy-race: two fetches queued', queue.length === 2, `queue=${queue.length}`);

    // Older fails after newer started — must not clear busy owned by newer.
    queue[0].resolve({ __reject: 'stale network failure' });
    await flushMicrotasks(16);
    assert(
      'busy-race: stale error/finally does not clear newer busy owner',
      sandbox.adminSaveBusy === true,
    );

    queue[1].resolve(newerPayload);
    await flushMicrotasks(16);
    assert('busy-race: newer success clears busy', sandbox.adminSaveBusy === false);
    assert(
      'busy-race: newer success installed marker',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === newerPayload._marker),
    );
  }

  // ── (5) Happy path: ownership unchanged keep-edit delete-price refresh ──
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg = realisticPricingCfgWithMarker('sunset-somo', 25);
    const refreshed = realisticPricingCfgWithMarker('sunset-somo', 25);
    // Simulate server removing one row identity while keeping amounts.
    refreshed.prices = refreshed.prices.filter((p) => p.id !== 'r-7_days');
    refreshed._marker = 'sunset-somo:kept-edit-refresh';

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg;
    sandbox.renderAdminFromConfig(cfg);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '33.25';
    sandbox.adminSnapshotPricingDraftState();

    const d = deferred();
    sandbox.fetch = function happyFetch() {
      return d.promise.then((body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('happy keep-edit: busy set for request', sandbox.adminSaveBusy === true);
    d.resolve(refreshed);
    await flushMicrotasks(16);

    assert('happy keep-edit: edit target preserved', sandbox.adminEditTarget === 'price-group:bundles');
    assert(
      'happy keep-edit: cache installed from response',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === refreshed._marker),
    );
    amountEl = registry.getElementById(amountId);
    assert(
      'happy keep-edit: draft amount preserved across keep-edit refresh',
      !!(amountEl && amountEl.value === '33.25'),
      amountEl ? `got ${amountEl.value}` : 'missing',
    );
    assert('happy keep-edit: busy cleared after success', sandbox.adminSaveBusy === false);
  }

  // ── (6) keep-edit → newer loadAdminTab: no permanent busy deadlock ───────
  // Bug: keep-edit sets busy + loadSeq; loadAdminTab bumps loadSeq only; stale
  // keep-edit cannot release; canonical never owns/releases → busy stuck true.
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg0 = realisticPricingCfgWithMarker('sunset-somo', 25);
    const keepPayload = realisticPricingCfgWithMarker('sunset-somo', 31);
    const canonPayload = realisticPricingCfgWithMarker('sunset-somo', 42);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '12.34';
    sandbox.adminSnapshotPricingDraftState();

    const queue = [];
    sandbox.fetch = function keepThenCanonFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => {
        if (body && body.__reject) return Promise.reject(new Error(body.__reject));
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        };
      });
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('deadlock-seq: keep-edit sets busy', sandbox.adminSaveBusy === true);
    assert('deadlock-seq: keep-edit queued fetch', queue.length === 1, `q=${queue.length}`);
    const keepSeq = sandbox.adminLoadSeq;

    // Newer canonical load supersedes keep-edit generation.
    sandbox.loadAdminTab();
    assert('deadlock-seq: loadAdminTab issued second fetch', queue.length === 2, `q=${queue.length}`);
    assert(
      'deadlock-seq: loadAdminTab advanced generation past keep-edit',
      sandbox.adminLoadSeq > keepSeq,
      `loadSeq=${sandbox.adminLoadSeq} keepSeq=${keepSeq}`,
    );

    // Stale keep-edit success first — must not install under newer ownership, must not
    // leave busy stuck if canonical later owns/releases.
    queue[0].resolve(keepPayload);
    await flushMicrotasks(16);
    assert(
      'deadlock-seq: stale keep-edit does not install keep payload under newer load',
      !(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === keepPayload._marker),
      sandbox.adminConfigCache && sandbox.adminConfigCache._marker,
    );

    queue[1].resolve(canonPayload);
    await flushMicrotasks(16);

    assert(
      'deadlock-seq: canonical success installs marker',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === canonPayload._marker),
      sandbox.adminConfigCache && sandbox.adminConfigCache._marker,
    );
    assert(
      'deadlock-seq: final busy false after keep-edit + canonical success',
      sandbox.adminSaveBusy === false,
      `busy=${sandbox.adminSaveBusy}`,
    );
    // Canonical load must not leave keep-edit draft identity as active edit surface
    // without preserveDraft — edit target may clear when writes disabled only; with
    // writes_enabled true target may remain unless reopen. Assert actions unblocked.
    assert(
      'deadlock-seq: actions not permanently rejected (busy gate open)',
      sandbox.adminSaveBusy === false,
    );
  }

  // ── (7) keep-edit → newer loadAdminTab failure/abort: busy false if owner ─
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg0 = realisticPricingCfgWithMarker('sunset-somo', 25);
    const keepPayload = realisticPricingCfgWithMarker('sunset-somo', 31);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);

    const queue = [];
    sandbox.fetch = function keepThenCanonFailFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => {
        if (body && body.__reject) return Promise.reject(new Error(body.__reject));
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        };
      });
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    sandbox.loadAdminTab();
    assert('canon-fail-seq: two fetches', queue.length === 2, `q=${queue.length}`);

    queue[0].resolve(keepPayload);
    await flushMicrotasks(16);
    queue[1].resolve({ __reject: 'canonical network abort' });
    await flushMicrotasks(16);

    assert(
      'canon-fail-seq: busy false after owning canonical failure/abort',
      sandbox.adminSaveBusy === false,
      `busy=${sandbox.adminSaveBusy}`,
    );
    assert(
      'canon-fail-seq: stale keep-edit did not leave success cache marker',
      !(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === keepPayload._marker),
    );
  }

  // ── (8) canonical load → newer keep-edit: stale canonical cannot clear busy ─
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg0 = realisticPricingCfgWithMarker('sunset-somo', 25);
    const keepPayload = realisticPricingCfgWithMarker('sunset-somo', 27);
    const staleCanon = realisticPricingCfgWithMarker('sunset-somo', 18);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);

    const queue = [];
    sandbox.fetch = function canonThenKeepFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => {
        if (body && body.__reject) return Promise.reject(new Error(body.__reject));
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        };
      });
    };

    sandbox.loadAdminTab();
    assert('canon-then-keep: first fetch is canonical', queue.length === 1);
    const canonSeq = sandbox.adminLoadSeq;

    // Re-establish edit surface + draft after loading shell so keep-edit preserveDraft is real
    // (canonical load may wipe Pricing DOM; this is not testing loading-shell draft survival).
    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);
    let amountEl = registry.getElementById(amountId);
    if (amountEl) amountEl.value = '44.00';
    sandbox.adminSnapshotPricingDraftState();

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    assert('canon-then-keep: keep-edit sets busy', sandbox.adminSaveBusy === true);
    assert(
      'canon-then-keep: keep-edit advanced generation',
      sandbox.adminLoadSeq > canonSeq,
      `loadSeq=${sandbox.adminLoadSeq} canonSeq=${canonSeq}`,
    );
    assert('canon-then-keep: two fetches', queue.length === 2, `q=${queue.length}`);

    // Stale canonical success — must not clear keep-edit busy or steal keep-edit state.
    queue[0].resolve(staleCanon);
    await flushMicrotasks(16);
    assert(
      'canon-then-keep: stale canonical success does not clear newer keep-edit busy',
      sandbox.adminSaveBusy === true,
      `busy=${sandbox.adminSaveBusy}`,
    );
    assert(
      'canon-then-keep: stale canonical does not install its marker under keep-edit',
      !(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === staleCanon._marker),
    );

    queue[1].resolve(keepPayload);
    await flushMicrotasks(16);
    assert('canon-then-keep: keep-edit success clears its busy', sandbox.adminSaveBusy === false);
    assert(
      'canon-then-keep: keep-edit installed marker',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === keepPayload._marker),
    );
    amountEl = registry.getElementById(amountId);
    assert(
      'canon-then-keep: keep-edit preserves draft amount',
      !!(amountEl && amountEl.value === '44.00'),
      amountEl ? `got ${amountEl.value}` : 'missing',
    );
  }

  // ── (9) Multiple canonical loads: newest owns; stale cannot mutate/release ─
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const olderPayload = realisticPricingCfgWithMarker('sunset-somo', 10);
    const midPayload = realisticPricingCfgWithMarker('sunset-somo', 20);
    const newestPayload = realisticPricingCfgWithMarker('sunset-somo', 30);

    const queue = [];
    sandbox.fetch = function multiCanonFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => {
        if (body && body.__reject) return Promise.reject(new Error(body.__reject));
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        };
      });
    };

    sandbox.loadAdminTab();
    sandbox.loadAdminTab();
    sandbox.loadAdminTab();
    assert('multi-canon: three in-flight loads', queue.length === 3, `q=${queue.length}`);
    const newestSeq = sandbox.adminLoadSeq;

    // Older success while newer still in flight — discard, do not clear newest busy.
    queue[0].resolve(olderPayload);
    await flushMicrotasks(16);
    assert(
      'multi-canon: stale older success does not install marker',
      !(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === olderPayload._marker),
    );
    assert(
      'multi-canon: stale older success does not release newer busy owner',
      sandbox.adminSaveBusy === true,
      `busy=${sandbox.adminSaveBusy}`,
    );

    // Mid fails while newest still owner.
    queue[1].resolve({ __reject: 'mid canonical fail' });
    await flushMicrotasks(16);
    assert(
      'multi-canon: stale mid error does not release newest busy',
      sandbox.adminSaveBusy === true,
    );
    assert(
      'multi-canon: generation still newest after stale completions',
      sandbox.adminLoadSeq === newestSeq,
    );

    queue[2].resolve(newestPayload);
    await flushMicrotasks(16);
    assert(
      'multi-canon: newest success installs marker',
      !!(sandbox.adminConfigCache && sandbox.adminConfigCache._marker === newestPayload._marker),
    );
    assert('multi-canon: newest success clears busy', sandbox.adminSaveBusy === false);
  }

  // ── (10) wireAdminTab action after keep-edit→loadAdminTab is not rejected ─
  {
    const registry = createFormAwareRegistry();
    seedAdminHarnessDom(registry);
    const locationRef = { location: 'sunset-somo' };
    // Capture Admin click handler so we can exercise the busy gate for real.
    let adminClickHandler = null;
    registry.byId.set('tab-admin', {
      dataset: {},
      addEventListener(type, fn) {
        if (type === 'click') adminClickHandler = fn;
      },
    });
    const sandbox = createAdminUiSandbox(registry, locationRef);
    const cfg0 = realisticPricingCfgWithMarker('sunset-somo', 25);
    const keepPayload = realisticPricingCfgWithMarker('sunset-somo', 31);
    const canonPayload = realisticPricingCfgWithMarker('sunset-somo', 42);

    sandbox.adminEditTarget = 'price-group:bundles';
    sandbox.adminConfigCache = cfg0;
    sandbox.renderAdminFromConfig(cfg0);

    const queue = [];
    sandbox.fetch = function actionAfterSeqFetch() {
      const d = deferred();
      queue.push(d);
      return d.promise.then((body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    };

    sandbox.adminReloadConfigKeepingEdit('price-group:bundles');
    sandbox.loadAdminTab();
    queue[0].resolve(keepPayload);
    await flushMicrotasks(16);
    queue[1].resolve(canonPayload);
    await flushMicrotasks(16);

    assert('action-after-seq: busy false', sandbox.adminSaveBusy === false);
    assert(
      'action-after-seq: wireAdminTab registered click handler',
      typeof adminClickHandler === 'function',
    );

    // Prove the production busy gate does not permanently reject: with busy false,
    // a non-toggle action without cache reaches adminShowMessage (loading), not early return.
    // If busy were stuck true, handler would return before touching the message box.
    const msg = registry.getElementById('admin-save-msg');
    msg.textContent = '';
    msg.style.display = 'none';
    msg.className = '';
    sandbox.adminConfigCache = null;
    const fakeBtn = {
      getAttribute(name) {
        return name === 'data-admin-action' ? 'edit-price' : null;
      },
      closest(sel) {
        if (sel === '[data-admin-action]') return fakeBtn;
        return null;
      },
    };
    const fakeEv = {
      target: fakeBtn,
      preventDefault() {},
    };
    adminClickHandler(fakeEv);
    assert(
      'action-after-seq: wireAdminTab action not permanently rejected by stuck busy',
      msg.style.display === 'block'
        && String(msg.textContent || '').length > 0,
      `display=${msg.style.display} text=${msg.textContent}`,
    );
  }
}

// ── [4] CSS contract for mobile widths (static) ────────────────────────────

function runMobileCssChecks() {
  console.log('\n[4] Mobile tab target + overflow CSS contract\n');
  const apiSrc = read(STAFF_API);
  assert('subtab min-height 44px', /portal-admin-subtab[\s\S]{0,200}min-height:\s*44px/.test(apiSrc));
  // Width must be asserted independently — never pass width from min-height alone.
  assert('subtab min-width 44px (touch target width, not height)',
    /portal-admin-subtab[\s\S]{0,200}min-width:\s*44px/.test(apiSrc));
  assert('subtabs wrap or no overflow-x',
    /portal-admin-subtabs[\s\S]{0,180}flex-wrap:\s*wrap/.test(apiSrc)
    || /portal-admin-subtabs[\s\S]{0,180}overflow-x:\s*hidden/.test(apiSrc)
    || /portal-admin-subtabs[\s\S]{0,180}max-width:\s*100%/.test(apiSrc));
  // Explicit mention of small viewports optional but preferred
  assert('admin wrap max-width still present (layout intact)',
    /\.portal-admin-wrap\{[^}]*max-width:\s*1100px/.test(apiSrc));
}

// ── [5] Optional Playwright smoke when available ───────────────────────────

function loadPlaywright() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'playwright'),
    '/opt/wolfhouse/WH/node_modules/playwright',
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'package.json'))) return require(c);
    } catch (_) { /* continue */ }
  }
  try {
    return require('playwright');
  } catch (_) {
    return null;
  }
}

async function runBrowserSmoke(playwright) {
  console.log('\n[5] Playwright Admin tabs smoke (local verify server)\n');
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  serverChild = createSunsetAdminVerifyServer();
  await new Promise((resolve, reject) => {
    serverChild.once('error', reject);
    serverChild.listen(PORT, '127.0.0.1', () => {
      const addr = serverChild.address();
      PORT = typeof addr === 'object' && addr ? addr.port : PORT;
      BASE_URL = `http://127.0.0.1:${PORT}`;
      console.log(`  (verify server on ${BASE_URL})`);
      resolve();
    });
  });
  // wait ready
  const started = Date.now();
  await new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${BASE_URL}/staff/auth/session`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - started > 20000) return reject(new Error('server not ready'));
        setTimeout(tick, 200);
      }).on('error', () => {
        if (Date.now() - started > 20000) return reject(new Error('server not ready'));
        setTimeout(tick, 200);
      });
    };
    tick();
  });

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    // Desktop: full interaction (main nav is hamburger-hidden ≤768px).
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(() => {
        localStorage.setItem('staff_portal_client', 'sunset');
        localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
        localStorage.setItem('wh_staff_portal_locale', 'en');
      });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => {
        return document.body && !document.body.classList.contains('portal-profile-pending');
      }, null, { timeout: 30000 });
      await page.waitForFunction(() => {
        const sel = document.getElementById('c-client');
        return sel && sel.options.length > 0 && sel.value === 'sunset';
      }, null, { timeout: 30000 });
      const adminNav = page.locator('button.tab-btn[data-tab="admin"]');
      await adminNav.waitFor({ state: 'visible', timeout: 20000 });
      await adminNav.click();
      await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
      await page.waitForSelector('#admin-subtab-list', { timeout: 20000 });
      await page.waitForFunction(() => {
        const packs = document.querySelectorAll('#admin-pack-card-grid .portal-admin-pack-card').length;
        const prices = document.querySelectorAll('#admin-prices-body .portal-admin-price-card').length;
        const privateCard = document.querySelector('[data-admin-private-lesson-card="1"]');
        const fin = document.getElementById('admin-finance-body');
        return packs >= 1 && prices >= 1 && privateCard && fin && fin.innerText.trim().length > 0;
      }, null, { timeout: 25000 });

      const desktop = await page.evaluate(() => {
        const keys = Array.from(document.querySelectorAll('#admin-subtab-list [data-admin-tab]'))
          .map((t) => t.getAttribute('data-admin-tab'));
        return {
          keys,
          financeSelected: document.getElementById('admin-tab-finance')?.getAttribute('aria-selected') === 'true',
          pricingHidden: document.getElementById('admin-panel-pricing')?.hidden === true
            || document.getElementById('admin-panel-pricing')?.hasAttribute('hidden'),
          finText: document.getElementById('admin-finance-body')?.innerText || '',
        };
      });
      assert('desktop Finance first, Pricing second',
        desktop.keys[0] === 'finance' && desktop.keys[1] === 'pricing', desktop.keys.join(','));
      assert('desktop Finance default selected', desktop.financeSelected);
      assert('desktop Pricing panel hidden by default', desktop.pricingHidden);
      assert('desktop finance shell honest empty copy', /not available yet/i.test(desktop.finText));

      await page.locator('[data-admin-tab="pricing"]').click();
      await page.waitForFunction(() => {
        return document.getElementById('admin-tab-pricing')?.getAttribute('aria-selected') === 'true';
      }, null, { timeout: 5000 });
      const pricing = await page.evaluate(() => ({
        packCards: document.querySelectorAll('#admin-pack-card-grid .portal-admin-pack-card').length,
        prices: document.querySelectorAll('#admin-prices-body .portal-admin-price-card').length,
        privateCard: !!document.querySelector('[data-admin-private-lesson-card="1"]'),
        pricingHidden: document.getElementById('admin-panel-pricing')?.hidden === true,
      }));
      assert('desktop Pricing panel shown', !pricing.pricingHidden);
      assert('desktop Pricing contains pack cards', pricing.packCards >= 1);
      assert('desktop Pricing contains rental cards', pricing.prices >= 1);
      assert('desktop Pricing contains private lesson card', pricing.privateCard);

      await page.locator('[data-admin-tab="finance"]').click();
      await page.locator('[data-admin-tab="finance"]').focus();
      await page.keyboard.press('ArrowRight');
      const keySel = await page.evaluate(() => ({
        pricing: document.getElementById('admin-tab-pricing')?.getAttribute('aria-selected'),
        active: document.activeElement?.getAttribute('data-admin-tab'),
      }));
      assert('desktop ArrowRight selects pricing', keySel.pricing === 'true');
      assert('desktop ArrowRight focus follows selection', keySel.active === 'pricing');
      await page.keyboard.press('Home');
      const homeSel = await page.evaluate(() => ({
        finance: document.getElementById('admin-tab-finance')?.getAttribute('aria-selected'),
        active: document.activeElement?.getAttribute('data-admin-tab'),
      }));
      assert('desktop Home selects finance', homeSel.finance === 'true');
      assert('desktop Home focus follows selection', homeSel.active === 'finance');

      // Production /staff/ui: Pricing edit controls exist; draft across tab switch retained.
      // Full preserveDraft re-render proof is [3b] against production sunset-admin-ui.js source
      // (portal script is an IIFE — renderAdminFromConfig is not a window global).
      await page.locator('[data-admin-tab="pricing"]').click();
      await page.waitForFunction(() => {
        return document.getElementById('admin-tab-pricing')?.getAttribute('aria-selected') === 'true';
      }, null, { timeout: 5000 });
      const editGroup = page.locator('[data-admin-action="edit-price-group"]').first();
      await editGroup.waitFor({ state: 'visible', timeout: 15000 });
      await editGroup.click();
      await page.waitForSelector('[data-admin-price-field="amount"]', { timeout: 10000 });
      const uiDraft = await page.evaluate(() => {
        const input = document.querySelector('[data-admin-price-field="amount"]');
        if (!input) return { ok: false, reason: 'missing amount input after edit-price-group' };
        const id = input.id;
        const serverVal = String(input.value || '');
        input.value = '91.25';
        // Sub-tab switch must not wipe Pricing DOM (no re-render).
        const fin = document.querySelector('[data-admin-tab="finance"]');
        const pr = document.querySelector('[data-admin-tab="pricing"]');
        if (fin) fin.click();
        if (pr) pr.click();
        const after = document.getElementById(id);
        return {
          ok: true,
          id,
          serverVal,
          afterTabSwitch: after ? String(after.value || '') : '',
        };
      });
      assert('desktop Pricing edit form renders amount controls', uiDraft.ok, uiDraft.reason || '');
      if (uiDraft.ok) {
        assert(
          'desktop Pricing draft retained across Finance/Pricing sub-tab switch',
          uiDraft.afterTabSwitch === '91.25',
          `got ${uiDraft.afterTabSwitch} server was ${uiDraft.serverVal}`,
        );
      }
      await context.close();
    }

    // Mobile viewports: open Admin via API (main nav is drawer ≤768px), measure sub-tabs.
    const widths = [320, 375, 390, 430];
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      await context.addInitScript(() => {
        localStorage.setItem('staff_portal_client', 'sunset');
        localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
        localStorage.setItem('wh_staff_portal_locale', 'en');
      });
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => {
        return document.body && !document.body.classList.contains('portal-profile-pending');
      }, null, { timeout: 30000 });
      await page.waitForFunction(() => {
        const sel = document.getElementById('c-client');
        return sel && sel.options.length > 0 && sel.value === 'sunset';
      }, null, { timeout: 30000 });
      // Main nav is hamburger-hidden on ≤768px — open Admin without requiring nav tab visibility.
      await page.evaluate(() => {
        if (typeof window.switchToTab === 'function') window.switchToTab('admin');
        else {
          const btn = document.querySelector('button.tab-btn[data-tab="admin"]');
          if (btn) btn.click();
        }
      });
      await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 20000 });
      await page.waitForSelector('#admin-subtab-list', { timeout: 20000 });
      await page.waitForFunction(() => {
        const fin = document.getElementById('admin-finance-body');
        return fin && fin.innerText.trim().length > 0;
      }, null, { timeout: 20000 });

      const snap = await page.evaluate(() => {
        const keys = Array.from(document.querySelectorAll('#admin-subtab-list [data-admin-tab]'))
          .map((t) => t.getAttribute('data-admin-tab'));
        const list = document.getElementById('admin-subtab-list');
        const wrap = document.querySelector('#tab-admin .portal-admin-wrap');
        const overflow = list && wrap ? list.scrollWidth > wrap.clientWidth + 1 : false;
        const tabBox = document.getElementById('admin-tab-finance')?.getBoundingClientRect();
        const wrapBox = wrap?.getBoundingClientRect();
        const clips = list && wrapBox
          ? list.getBoundingClientRect().right > wrapBox.right + 1
          : false;
        return {
          keys,
          financeSelected: document.getElementById('admin-tab-finance')?.getAttribute('aria-selected') === 'true',
          finText: document.getElementById('admin-finance-body')?.innerText || '',
          overflow: overflow || clips,
          tabH: tabBox ? tabBox.height : 0,
          tabW: tabBox ? tabBox.width : 0,
        };
      });

      assert(`${width}px Finance first, Pricing second`,
        snap.keys[0] === 'finance' && snap.keys[1] === 'pricing', snap.keys.join(','));
      assert(`${width}px Finance default selected`, snap.financeSelected);
      assert(`${width}px finance shell honest empty copy`, /not available yet/i.test(snap.finText));
      assert(`${width}px no horizontal subtab overflow/clip`, !snap.overflow);
      assert(`${width}px subtab target height >= 44`, snap.tabH >= 44, `h=${snap.tabH}`);
      assert(`${width}px subtab target width >= 44`, snap.tabW >= 44, `w=${snap.tabW}`);

      await page.locator('[data-admin-tab="pricing"]').click();
      await page.waitForFunction(() => {
        return document.getElementById('admin-tab-pricing')?.getAttribute('aria-selected') === 'true';
      }, null, { timeout: 5000 });
      await page.waitForFunction(() => {
        return document.querySelectorAll('#admin-pack-card-grid .portal-admin-pack-card').length >= 1;
      }, null, { timeout: 20000 }).catch(() => {});
      const finalPricing = await page.evaluate(() => ({
        packCards: document.querySelectorAll('#admin-pack-card-grid .portal-admin-pack-card').length,
        prices: document.querySelectorAll('#admin-prices-body .portal-admin-price-card').length,
        privateCard: !!document.querySelector('[data-admin-private-lesson-card="1"]'),
      }));
      assert(`${width}px Pricing contains pack cards`, finalPricing.packCards >= 1);
      assert(`${width}px Pricing contains rental cards`, finalPricing.prices >= 1);
      assert(`${width}px Pricing contains private lesson card`, finalPricing.privateCard);

      await context.close();
    }
  } finally {
    await browser.close();
  }
}

function stopServer() {
  if (!serverChild) return;
  try { serverChild.close(); } catch (_) { /* ignore */ }
  serverChild = null;
}

async function main() {
  console.log('\nverify:sunset-admin-tabs — Sunset Admin Finance/Pricing tabs\n');
  try {
    runStaticStructureChecks();
    runI18nChecks();
    runDomBehaviorChecks();
    await runPricingDraftRerenderChecks();
    await runAdminReloadOwnershipRaceChecks();
    runMobileCssChecks();

    // Browser execution is mandatory for this verifier — never unconditional-pass on skip.
    const playwright = loadPlaywright();
    assert(
      'Playwright resolves for mandatory browser smoke (fail closed if missing)',
      !!playwright,
      'playwright module not resolvable under ROOT/node_modules or NODE_PATH',
    );
    if (!playwright) {
      console.error('verify:sunset-admin-tabs — FAILED (Playwright required)');
      process.exitCode = 1;
      return;
    }
    await runBrowserSmoke(playwright);

    console.log('\n' + '─'.repeat(48));
    console.log(`Results: ${pass} passed, ${fail} failed`);
    if (fail > 0) {
      console.error('verify:sunset-admin-tabs — FAILED');
      process.exitCode = 1;
      return;
    }
    console.log('verify:sunset-admin-tabs — ALL CHECKS PASSED');
  } finally {
    stopServer();
  }
}

main().catch((err) => {
  console.error('verify:sunset-admin-tabs — ERROR:', err && err.stack ? err.stack : err);
  stopServer();
  process.exit(1);
});
