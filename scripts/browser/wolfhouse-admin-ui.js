'use strict';

/**
 * Wolfhouse (lodging) Admin tab UI.
 *
 * Sunset owns the `#admin-*` shell inside `#tab-admin`; this module owns the
 * sibling `#admin-wh-shell` / `#wh-admin-*` shell and never reads or writes
 * Sunset admin state, config, or endpoints.
 *
 * Pricing / Email are placeholders until their lodging data models exist.
 * Luna Staff, Camps-Lessons-Services and Tour Operator host the production
 * top-level panels, relocated (not cloned) by applyClientPortalProfile.
 */
(function () {
  var WH_ADMIN_CLIENT = 'wolfhouse-somo';
  var WH_ADMIN_DEFAULT_SUBTAB = 'finance';
  var WH_ADMIN_SUBTABS = [
    'finance', 'pricing', 'luna-staff', 'services', 'tour-operator', 'email',
  ];

  /** Sub-tab key → id of the relocated top-level `.tab-panel` it hosts. */
  var WH_ADMIN_HOSTED_PANELS = {
    'luna-staff': 'tab-ask-luna',
    'services': 'tab-services',
    'tour-operator': 'tab-tour-operator',
  };

  /**
   * Placeholder sub-tabs: body id → i18n key for the section title.
   * Pricing is no longer here — scripts/browser/wolfhouse-admin-pricing-ui.js
   * owns `#wh-admin-pricing-body` and must not be overwritten by a placeholder.
   */
  var WH_ADMIN_PLACEHOLDERS = {
    email: { body: 'wh-admin-email-body', title: 'admin.tabs.email', fallback: 'Email' },
  };

  var whAdminActiveSubTab = WH_ADMIN_DEFAULT_SUBTAB;

  function node(id) { return document.getElementById(id); }

  function whT(key, fallback) {
    if (typeof t !== 'function') return fallback;
    var val = t(key);
    return (!val || val === key) ? fallback : val;
  }

  function whEsc(s) {
    if (typeof escHtml === 'function') return escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * True when this portal should show the lodging Admin shell.
   * Slug-gated so no surf tenant can ever land on it.
   */
  function portalIsWolfhouseAdmin(clientSlug) {
    var slug = clientSlug || (typeof getClient === 'function' ? getClient() : '');
    if (slug !== WH_ADMIN_CLIENT) return false;
    var profile = (typeof getPortalProfile === 'function') ? getPortalProfile(slug) : null;
    return !(profile && profile.is_surf_vertical);
  }

  /** Sub-tab key that owns a given top-level tab once it moves into Admin. */
  function whAdminSubTabForTopLevelTab(tab) {
    var keys = Object.keys(WH_ADMIN_HOSTED_PANELS);
    for (var i = 0; i < keys.length; i++) {
      if (WH_ADMIN_HOSTED_PANELS[keys[i]] === 'tab-' + tab) return keys[i];
    }
    return null;
  }

  function renderWhAdminPlaceholders() {
    var keys = Object.keys(WH_ADMIN_PLACEHOLDERS);
    for (var i = 0; i < keys.length; i++) {
      var spec = WH_ADMIN_PLACEHOLDERS[keys[i]];
      var body = node(spec.body);
      if (!body || body.dataset.whAdminPlaceholder === '1') continue;
      body.dataset.whAdminPlaceholder = '1';
      body.innerHTML =
        '<section class="portal-admin-section">' +
          '<div class="portal-admin-section-hdr">' +
            '<div class="portal-admin-section-hdr-title">' +
              whEsc(whT(spec.title, spec.fallback)) +
            '</div>' +
          '</div>' +
          '<div class="portal-admin-section-body">' +
            '<p class="portal-admin-muted">' +
              whEsc(whT('admin.placeholder.body', 'Not built yet.')) +
            '</p>' +
          '</div>' +
        '</section>';
    }
  }

  /**
   * Show one Wolfhouse Admin sub-tab.
   * Hosted panels are real `.tab-panel` nodes, so they need `.active` as well as
   * an unhidden wrapper.
   */
  function whAdminSelectSubTab(key, opts) {
    var next = WH_ADMIN_SUBTABS.indexOf(key) >= 0 ? key : WH_ADMIN_DEFAULT_SUBTAB;
    whAdminActiveSubTab = next;

    var tabs = document.querySelectorAll('#wh-admin-subtab-list [data-wh-admin-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i];
      var selected = tab.getAttribute('data-wh-admin-tab') === next;
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('tabindex', selected ? '0' : '-1');
      tab.classList.toggle('is-selected', selected);
      if (selected && opts && opts.focus && typeof tab.focus === 'function') tab.focus();
    }

    for (var s = 0; s < WH_ADMIN_SUBTABS.length; s++) {
      var subKey = WH_ADMIN_SUBTABS[s];
      var panel = node('wh-admin-panel-' + subKey);
      if (panel) {
        if (subKey === next) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
      }
      var hostedId = WH_ADMIN_HOSTED_PANELS[subKey];
      var hosted = hostedId ? node(hostedId) : null;
      if (hosted) hosted.classList.toggle('active', subKey === next);
    }

    if (next === 'finance' && typeof loadAdminFinanceSummary === 'function') loadAdminFinanceSummary();
    if (next === 'pricing' && typeof loadWolfhouseAdminPricing === 'function') loadWolfhouseAdminPricing();
    if (next === 'luna-staff' && typeof wireLunaStaffTabCards === 'function') wireLunaStaffTabCards();
    if (next === 'services' && typeof loadServicesTab === 'function') loadServicesTab();
    if (next === 'tour-operator' && typeof toOnTourOperatorTabOpen === 'function') toOnTourOperatorTabOpen();
  }

  function wireWhAdminSubTabs() {
    var list = node('wh-admin-subtab-list');
    if (!list || list.dataset.whAdminSubtabsWired === '1') return;
    list.dataset.whAdminSubtabsWired = '1';

    function tabButtons() {
      return Array.prototype.slice.call(list.querySelectorAll('[role="tab"][data-wh-admin-tab]'))
        .filter(function (btn) { return !btn.hidden; });
    }

    function selectByIndex(idx, focus) {
      var tabs = tabButtons();
      if (!tabs.length) return;
      var n = ((idx % tabs.length) + tabs.length) % tabs.length;
      whAdminSelectSubTab(tabs[n].getAttribute('data-wh-admin-tab'), { focus: !!focus });
    }

    list.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-wh-admin-tab]') : null;
      if (!btn || !list.contains(btn)) return;
      ev.preventDefault();
      whAdminSelectSubTab(btn.getAttribute('data-wh-admin-tab'), { focus: true });
    });

    list.addEventListener('keydown', function (ev) {
      var target = ev.target;
      if (!target || !target.getAttribute || !target.getAttribute('data-wh-admin-tab')) return;
      if (!list.contains(target)) return;
      var tabs = tabButtons();
      if (!tabs.length) return;
      var idx = tabs.indexOf(target);
      if (idx < 0) idx = 0;
      if (ev.key === 'ArrowRight') { ev.preventDefault(); selectByIndex(idx + 1, true); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); selectByIndex(idx - 1, true); }
      else if (ev.key === 'Home') { ev.preventDefault(); selectByIndex(0, true); }
      else if (ev.key === 'End') { ev.preventDefault(); selectByIndex(tabs.length - 1, true); }
    });
  }

  /**
   * Open/refresh the lodging Admin tab.
   * @param {{resetSubTab?: boolean, subTab?: string}} [opts]
   */
  function loadWolfhouseAdminTab(opts) {
    opts = opts || {};
    wireWhAdminSubTabs();
    renderWhAdminPlaceholders();
    if (opts.subTab) whAdminActiveSubTab = opts.subTab;
    else if (opts.resetSubTab) whAdminActiveSubTab = WH_ADMIN_DEFAULT_SUBTAB;
    whAdminSelectSubTab(whAdminActiveSubTab);
  }

  window.portalIsWolfhouseAdmin = portalIsWolfhouseAdmin;
  window.whAdminSelectSubTab = whAdminSelectSubTab;
  window.whAdminSubTabForTopLevelTab = whAdminSubTabForTopLevelTab;
  window.wireWhAdminSubTabs = wireWhAdminSubTabs;
  window.loadWolfhouseAdminTab = loadWolfhouseAdminTab;
  window.WH_ADMIN_HOSTED_PANELS = WH_ADMIN_HOSTED_PANELS;
})();
