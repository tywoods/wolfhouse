'use strict';

/**
 * BUG-005 — Horario drawer Escape, scroll restore, backdrop stacking, Aplicar clearance.
 * Covers Reservas → Abrir en Agenda drawer shell: body-port order, pointer-events,
 * and overflow unlock (Escape + ✕). Stay off Inbox, email, language packs, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-controller.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.ok(drawerSrc.includes('function scheduleOverlayIsOpen'));
assert.ok(drawerSrc.includes('function scheduleDrawerDetailIsOpen'));
assert.ok(drawerSrc.includes('closeScheduleCreateModal'));
assert.ok(drawerSrc.includes("document.documentElement.style.overflow = ''"));
assert.ok(drawerSrc.includes('scheduleDrawerClearPageScrollLock'));
assert.ok(drawerSrc.includes("try { scheduleDrawerWireDismiss(); }"));
assert.ok(drawerSrc.includes('document.body.appendChild(backdrop)'));
assert.ok(drawerSrc.includes('document.body.appendChild(drawer)'));
assert.ok(drawerSrc.includes("pointerEvents = 'auto'"));
assert.ok(drawerSrc.includes("pointerEvents = 'none'"));
assert.ok(!drawerSrc.includes('getComputedStyle'),
  'overlay open must not use getComputedStyle (Create CSS defaults to flex)');
assert.ok(apiSrc.includes('scheduleDrawerLockPage'));
assert.ok(apiSrc.includes('scheduleDrawerUnlockPage'));
assert.ok(apiSrc.includes('scheduleDrawerWireDismiss'));
assert.ok(apiSrc.includes('body > .portal-schedule-drawer-backdrop'));
assert.ok(apiSrc.includes('.portal-schedule-drawer-backdrop[aria-hidden="true"]'));
assert.ok(apiSrc.includes('pointer-events:none!important'));
assert.ok(apiSrc.includes('body > .portal-schedule-drawer{position:fixed;z-index:9800'));
assert.ok(apiSrc.includes('padding:14px 18px 220px'));
assert.ok(apiSrc.includes('scroll-margin-bottom:168px'));
assert.ok(apiSrc.includes("applyBtn.scrollIntoView"));
assert.ok(!drawerSrc.includes('inbox-thread.js'));
assert.ok(!/staff-email-oauth|inbox-thread/.test(apiSrc.slice(
  apiSrc.indexOf('function openScheduleCreateModal'),
  apiSrc.indexOf('function openScheduleCreateModal') + 1800
)));

// ── Overlay helper unit tests ──────────────────────────────────────────────
{
  const start = drawerSrc.indexOf('function scheduleOverlayIsOpen');
  const end = drawerSrc.indexOf('function schedulePageHasOverlay');
  const sandbox = {
    window: {
      // Browser-shaped getComputedStyle that would falsely report Create as open
      // when inline display is emptied (stylesheet default is display:flex).
      getComputedStyle: function () { return { display: 'flex', visibility: 'visible' }; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(drawerSrc.slice(start, end) + '\nthis.scheduleOverlayIsOpen = scheduleOverlayIsOpen;', sandbox);

  function node(attrs) {
    return {
      hidden: !!attrs.hidden,
      style: { display: attrs.display || '' },
      getAttribute(k) { return k === 'aria-hidden' ? (attrs.aria || null) : null; },
    };
  }
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(null), false);
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'none', aria: 'true' })), false);
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'flex', aria: 'false' })), true);
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: 'block' })), true);
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: '', aria: 'true' })), false);
  // Empty inline display must NOT count as open even when getComputedStyle says flex.
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: '', aria: 'false' })), false);
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(node({ display: '' })), false);
}

// ── Behavioral: Escape closes + unlock restores overflow + stacking ────────
{
  function makeEl(id, attrs) {
    attrs = attrs || {};
    const attributes = Object.assign({}, attrs.attrs || {});
    if (attrs.aria != null) attributes['aria-hidden'] = attrs.aria;
    return {
      id: id,
      hidden: !!attrs.hidden,
      style: Object.assign({
        display: attrs.display || '',
        overflow: '',
        flex: '',
        zIndex: '',
        pointerEvents: '',
      }, attrs.style || {}),
      parentNode: null,
      dataset: {},
      querySelector: function () { return null; },
      setAttribute: function (k, v) { attributes[k] = String(v); },
      getAttribute: function (k) { return attributes[k] != null ? attributes[k] : null; },
      removeAttribute: function (k) { delete attributes[k]; },
      addEventListener: function (type, fn) {
        this._l = this._l || {};
        (this._l[type] = this._l[type] || []).push(fn);
      },
      appendChild: function (n) { n.parentNode = this; return n; },
    };
  }

  const body = makeEl('body');
  const html = makeEl('html');
  const tabHost = makeEl('tab-portal-home');
  const drawer = makeEl('ps-detail-drawer', { display: 'none', aria: 'true' });
  const backdrop = makeEl('ps-drawer-backdrop', { display: 'none', aria: 'true' });
  const create = makeEl('ps-create-modal', { display: 'none', aria: 'true' });
  const drawerBody = makeEl('ps-drawer-body');
  drawerBody.innerHTML = '';
  // Start under the tab (production HTML) so ensureDocumentLayer must body-port them.
  tabHost.appendChild(backdrop);
  tabHost.appendChild(drawer);
  const nodes = {
    'ps-detail-drawer': drawer,
    'ps-drawer-backdrop': backdrop,
    'ps-create-modal': create,
    'ps-drawer-body': drawerBody,
    'tab-portal-home': tabHost,
  };
  const docListeners = {};
  const appendOrder = [];
  const documentRef = {
    body: body,
    documentElement: html,
    addEventListener: function (t, fn) {
      (docListeners[t] = docListeners[t] || []).push(fn);
    },
    getElementById: function (id) { return nodes[id] || null; },
  };
  body.appendChild = function (n) {
    appendOrder.push(n && n.id);
    n.parentNode = body;
    return n;
  };

  const sandbox = {
    document: documentRef,
    // Prove we do not consult computed style for overlay open (would be flex).
    window: {
      getComputedStyle: function () { return { display: 'flex', visibility: 'visible' }; },
    },
    console: console,
    el: function (id) { return nodes[id] || null; },
    escHtml: function (s) { return String(s || ''); },
    portalT: function (k) { return k; },
    scheduleFindGroupForRow: function (r) { return r; },
    scheduleBuildDisplayGroups: function (rows) { return rows; },
    scheduleEnsureRowId: function (r) { r._scheduleId = r._scheduleId || 'x'; },
    scheduleDrawerCanLoadCanonical: function () { return false; },
    scheduleResolveGuestPhone: function () { return ''; },
    scheduleRowSourceDrawerLabel: function () { return 'x'; },
    scheduleEquipmentPrepLabel: function () { return 'x'; },
    scheduleRenderComponentListHtml: function () { return ''; },
    scheduleRenderStatusBadgeHtml: function () { return 'ok'; },
    scheduleWireDrawerConversation: function () {},
    scheduleFindLinkedConversation: function () { return null; },
    scheduleGroupHasPhone: function () { return false; },
    scheduleCloneDrawerCtx: function (c) { return c; },
    scheduleLastDrawerRowId: null,
    scheduleFetchDrawerContext: function () {
      return { then: function () { return this; }, catch: function () { return this; } };
    },
    scheduleRenderDrawerLoadingHtml: function () { return '<p>loading</p>'; },
    closeScheduleCreateModal: function () {
      create.style.display = 'none';
      create.setAttribute('aria-hidden', 'true');
      if (typeof sandbox.scheduleDrawerUnlockPage === 'function') sandbox.scheduleDrawerUnlockPage();
    },
  };
  // Prefer no-op conversation wiring during this lifecycle test.
  sandbox.scheduleWireDrawerConversation = function () {};
  vm.createContext(sandbox);
  vm.runInContext(
    drawerSrc
      + '\nthis.openScheduleDetailDrawer = openScheduleDetailDrawer;'
      + '\nthis.closeScheduleDetailDrawer = closeScheduleDetailDrawer;'
      + '\nthis.scheduleDrawerOnKeydown = scheduleDrawerOnKeydown;'
      + '\nthis.scheduleDrawerUnlockPage = scheduleDrawerUnlockPage;'
      + '\nthis.scheduleDrawerLockPage = scheduleDrawerLockPage;'
      + '\nthis.scheduleOverlayIsOpen = scheduleOverlayIsOpen;'
      + '\nthis.scheduleDrawerDetailIsOpen = scheduleDrawerDetailIsOpen;'
      + '\nthis.scheduleDrawerState = scheduleDrawerState;'
      + '\nscheduleWireDrawerConversation = function(){};'
      + '\nscheduleResolveGuestPhone = function(){ return ""; };',
    sandbox
  );

  assert.ok((docListeners.keydown || []).length >= 1, 'Escape listener wired on load');

  appendOrder.length = 0;
  sandbox.openScheduleDetailDrawer({ guest_name: 'Ada', service_date: '2026-08-15', notes: '' });
  assert.strictEqual(drawer.style.display, 'block', 'drawer opens');
  assert.strictEqual(backdrop.style.display, 'block', 'backdrop opens');
  assert.strictEqual(drawer.parentNode, body, 'drawer body-ported out of tab');
  assert.strictEqual(backdrop.parentNode, body, 'backdrop body-ported out of tab');
  assert.ok(appendOrder.indexOf('ps-drawer-backdrop') >= 0, 'backdrop appended to body');
  assert.ok(appendOrder.indexOf('ps-detail-drawer') >= 0, 'drawer appended to body');
  assert.ok(
    appendOrder.lastIndexOf('ps-detail-drawer') > appendOrder.lastIndexOf('ps-drawer-backdrop'),
    'drawer appended after backdrop so it paints on top'
  );
  assert.strictEqual(drawer.style.zIndex, '9800', 'drawer z-index above backdrop');
  assert.strictEqual(backdrop.style.zIndex, '9700', 'backdrop z-index below drawer');
  assert.strictEqual(drawer.style.pointerEvents, 'auto', 'drawer receives clicks');
  assert.strictEqual(backdrop.style.pointerEvents, 'auto', 'backdrop clickable while open');
  assert.strictEqual(body.style.overflow, 'hidden', 'body locked while open');
  assert.strictEqual(body.getAttribute('data-schedule-drawer-open'), '1', 'open flag set');
  assert.strictEqual(sandbox.scheduleDrawerDetailIsOpen(), true, 'detail is open');

  const esc = { key: 'Escape', preventDefault: function () { this.pd = true; } };
  (docListeners.keydown || []).forEach(function (fn) { fn(esc); });
  assert.strictEqual(drawer.style.display, 'none', 'Escape closes drawer');
  assert.strictEqual(backdrop.style.display, 'none', 'Escape hides backdrop');
  assert.strictEqual(backdrop.style.pointerEvents, 'none', 'Escape disables backdrop pointer-events');
  assert.strictEqual(backdrop.getAttribute('aria-hidden'), 'true', 'Escape aria-hides backdrop');
  assert.strictEqual(body.style.overflow, '', 'Escape restores body overflow');
  assert.strictEqual(html.style.overflow, '', 'Escape restores html overflow');
  assert.strictEqual(body.getAttribute('data-schedule-drawer-open'), null, 'open flag cleared');
  assert.ok(esc.pd, 'Escape preventDefault');

  sandbox.openScheduleDetailDrawer({ guest_name: 'Bob', service_date: '2026-08-15' });
  sandbox.closeScheduleDetailDrawer();
  assert.strictEqual(body.style.overflow, '', 'X close restores overflow');
  assert.strictEqual(backdrop.style.pointerEvents, 'none', 'X close disables backdrop pointer-events');
  assert.strictEqual(body.getAttribute('data-schedule-drawer-open'), null, 'X close clears flag');

  // Create modal with empty inline display + CSS-ish aria must not block unlock
  // (even when window.getComputedStyle would report flex).
  sandbox.openScheduleDetailDrawer({ guest_name: 'Cara', service_date: '2026-08-15' });
  create.style.display = '';
  create.setAttribute('aria-hidden', 'false');
  assert.strictEqual(sandbox.scheduleOverlayIsOpen(create), false, 'empty display is not open');
  sandbox.closeScheduleDetailDrawer();
  assert.strictEqual(body.style.overflow, '', 'unlock not blocked by empty-display create');

  // Reservas → Abrir en Agenda shape: customer drawer open uses loading shell + body port.
  appendOrder.length = 0;
  sandbox.scheduleDrawerCanLoadCanonical = function () { return false; };
  sandbox.openScheduleDetailDrawer({
    booking_id: 'bk-reservas-1',
    booking_code: 'SUNSET-20260815-TEST',
    guest_name: 'Dana',
    service_date: '2026-08-15',
    _drawerFromCustomer: true,
  });
  assert.strictEqual(drawer.style.display, 'block', 'Reservas open-in-schedule shows drawer shell');
  assert.strictEqual(backdrop.style.display, 'block', 'Reservas open-in-schedule shows backdrop');
  assert.strictEqual(drawer.parentNode, body, 'Reservas path body-ports drawer');
  assert.strictEqual(backdrop.parentNode, body, 'Reservas path body-ports backdrop');
  assert.ok(
    appendOrder.lastIndexOf('ps-detail-drawer') > appendOrder.lastIndexOf('ps-drawer-backdrop'),
    'Reservas path keeps drawer above backdrop in DOM'
  );
  assert.strictEqual(Number(drawer.style.zIndex) > Number(backdrop.style.zIndex), true,
    'Reservas path drawer z-index beats backdrop');
  sandbox.closeScheduleDetailDrawer();
  assert.strictEqual(body.style.overflow, '', 'Reservas path close restores overflow');
  assert.strictEqual(backdrop.style.pointerEvents, 'none', 'Reservas path close clears backdrop trap');
}

console.log('PASS BUG-005 Escape + scroll unlock + backdrop stacking + Aplicar clearance');
