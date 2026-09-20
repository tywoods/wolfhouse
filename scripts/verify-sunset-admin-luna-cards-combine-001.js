#!/usr/bin/env node
'use strict';

/**
 * SUNSET-ADMIN-LUNA-CARDS-COMBINE-001
 * One Sunset Admin card: General Notes, Guest Conversation alerts,
 * Automated staff notifications. Style/Personality stay separate.
 * Stay off inbox-thread.js and staff-query-api HTML.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OWNER = path.join(ROOT, 'scripts/browser/sunset-admin-luna-cards-combine.js');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts/lib/sunset-admin-browser-source.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

const uiSrc = fs.readFileSync(OWNER, 'utf8');
const adminUi = fs.readFileSync(ADMIN_UI, 'utf8');
const injectSrc = fs.readFileSync(BROWSER_SRC, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');

assert.ok(uiSrc.includes("data-sunset-luna-cards-combine"), 'combine marker');
assert.ok(uiSrc.includes('cc-house-notes'), 'moves general notes');
assert.ok(uiSrc.includes('cc-staff-notification-settings'), 'moves guest alerts');
assert.ok(uiSrc.includes('cc-automated-staff-notifications'), 'moves automations');
assert.ok(
  uiSrc.indexOf("wrap.appendChild(notes)") < uiSrc.indexOf("wrap.appendChild(alerts)")
    && uiSrc.indexOf("wrap.appendChild(alerts)") < uiSrc.indexOf("wrap.appendChild(autos)"),
  'runtime order notes → alerts → automations',
);
assert.ok(uiSrc.includes('padding:16px 18px'), 'Pricing card padding');
assert.ok(uiSrc.includes('background:var(--surface)'), 'Salt/Sand surface, not surface-soft');
assert.ok(!uiSrc.includes('--surface-soft'), 'card is not grey surface-soft');
assert.ok(!/Foam|Sol|Kelp|Ember/.test(uiSrc), 'no new palette names');
assert.ok(!uiSrc.includes('inbox-thread'), 'owner stays off inbox-thread');
assert.ok(!/\bfetch\s*\(/.test(uiSrc), 'no network');
assert.ok(!/sendWhatsApp/.test(uiSrc), 'does not send WhatsApp');

assert.ok(injectSrc.includes('sunset-admin-luna-cards-combine.js'), 'injected with sunset Admin UI');
const injectFn = injectSrc.match(/function getSunsetAdminUiBrowserSource\(\) \{[\s\S]*?\n\}/);
assert.ok(injectFn, 'getSunsetAdminUiBrowserSource present');
assert.ok(
  injectFn[0].indexOf('LUNA_CARDS_COMBINE') >= 0
    && injectFn[0].indexOf('LUNA_CARDS_COMBINE') < injectFn[0].indexOf('BROWSER_UI'),
  'combine injected before admin-ui',
);

assert.ok(adminUi.includes('paintSunsetAdminLunaCardsCombine()'), 'Admin locale/tab paints combine');
assert.ok(
  /next === 'luna-staff' && typeof paintSunsetAdminLunaCardsCombine === 'function'/.test(adminUi),
  'Luna Staff subtab paints combine after wire',
);
assert.ok(
  /function adminRefreshOnLocaleChange\(\)\{[\s\S]*paintSunsetAdminLunaCardsCombine\(\);/.test(adminUi),
  'locale change re-paints combine',
);

assert.ok(!apiSrc.includes('cc-luna-notes-alerts-automations'), 'staff-query-api.js stays file-bounded off');
assert.ok(!threadSrc.includes('paintSunsetAdminLunaCardsCombine'), 'inbox-thread.js untouched');
assert.ok(!threadSrc.includes('cc-luna-notes-alerts-automations'), 'inbox-thread.js has no combine wrap');

function node(id, className) {
  const n = {
    id,
    className: className || '',
    style: { display: '' },
    parentNode: null,
    children: [],
    nextSibling: null,
    getAttribute() { return null; },
    setAttribute() {},
    appendChild(child) {
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, before) {
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      const i = before ? this.children.indexOf(before) : -1;
      if (i >= 0) this.children.splice(i, 0, child);
      else this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
  };
  return n;
}

function makeSandbox(opts) {
  const portalClient = opts.portalClient;
  const client = opts.client;
  const wrapHost = node('al-wrap');
  const personality = node('staff-luna-personality-card', 'staff-style-card luna-header-mode-card');
  const notes = node('cc-house-notes', 'card cc-section');
  const alerts = node('cc-staff-notification-settings', 'card cc-section');
  const autos = node('cc-automated-staff-notifications', 'card cc-section');
  wrapHost.appendChild(personality);
  wrapHost.appendChild(autos);
  wrapHost.appendChild(alerts);
  wrapHost.appendChild(notes);
  notes.style.display = opts.hideNotes ? 'none' : '';
  alerts.style.display = opts.hideAlerts ? 'none' : '';
  autos.style.display = opts.hideAutos ? 'none' : '';

  const byId = {
    'al-wrap': wrapHost,
    'staff-luna-personality-card': personality,
    'cc-house-notes': notes,
    'cc-staff-notification-settings': alerts,
    'cc-automated-staff-notifications': autos,
  };
  const headKids = [];
  let cssMounted = false;
  const sandbox = {
    getClient() { return client; },
    el(id) { return byId[id] || null; },
    document: {
      documentElement: {
        getAttribute(name) { return name === 'data-portal-client' ? portalClient : null; },
      },
      head: {
        appendChild(n) { headKids.push(n); cssMounted = true; return n; },
      },
      createElement(tag) {
        const created = node('', '');
        created.tagName = String(tag).toUpperCase();
        created.textContent = '';
        const origSetId = Object.getOwnPropertyDescriptor(created, 'id');
        return created;
      },
      getElementById(id) {
        if (id === 'sunset-luna-cards-combine-css') return cssMounted ? { id } : null;
        if (byId[id]) return byId[id];
        function walk(n) {
          if (!n) return null;
          if (n.id === id) return n;
          const kids = n.children || [];
          for (let i = 0; i < kids.length; i++) {
            const hit = walk(kids[i]);
            if (hit) return hit;
          }
          return null;
        }
        return walk(wrapHost);
      },
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  sandbox.__host = wrapHost;
  sandbox.__notes = notes;
  sandbox.__alerts = alerts;
  sandbox.__autos = autos;
  sandbox.__byId = byId;
  sandbox.__register = function register(id, n) { byId[id] = n; };
  return sandbox;
}

const sunset = makeSandbox({ portalClient: 'sunset', client: 'sunset' });
sunset.paintSunsetAdminLunaCardsCombine();
const wrap = sunset.document.getElementById('cc-luna-notes-alerts-automations');
assert.ok(wrap, 'sunset paints combine wrap');
assert.strictEqual(wrap.getAttribute && wrap.id, 'cc-luna-notes-alerts-automations');
sunset.__register('cc-luna-notes-alerts-automations', wrap);
assert.strictEqual(wrap.children[0], sunset.__notes, 'notes first');
assert.strictEqual(wrap.children[1], sunset.__alerts, 'alerts second');
assert.strictEqual(wrap.children[2], sunset.__autos, 'automations third');
assert.ok(!/\bcard\b/.test(sunset.__notes.className), 'inner notes not a nested card');
assert.ok(!/\bcard\b/.test(sunset.__alerts.className), 'inner alerts not a nested card');
assert.ok(!/\bcard\b/.test(sunset.__autos.className), 'inner automations not a nested card');
assert.notEqual(wrap.style.display, 'none', 'owner-visible children keep wrap open');

sunset.paintSunsetAdminLunaCardsCombine();
assert.strictEqual(
  sunset.document.getElementById('cc-luna-notes-alerts-automations'),
  wrap,
  'second paint is idempotent',
);
assert.strictEqual(wrap.children.length, 3, 'second paint does not duplicate sections');

const wolf = makeSandbox({ portalClient: '', client: 'wolfhouse' });
wolf.paintSunsetAdminLunaCardsCombine();
assert.ok(!wolf.document.getElementById('cc-luna-notes-alerts-automations'), 'wolfhouse does not combine');
assert.ok(/\bcard\b/.test(wolf.__notes.className), 'wolfhouse notes stay a card');

const switched = makeSandbox({ portalClient: 'sunset', client: 'wolfhouse' });
switched.paintSunsetAdminLunaCardsCombine();
assert.ok(!switched.document.getElementById('cc-luna-notes-alerts-automations'), 'sunset html + wolfhouse client does not combine');

const hidden = makeSandbox({
  portalClient: 'sunset', client: 'sunset',
  hideNotes: true, hideAlerts: true, hideAutos: true,
});
hidden.paintSunsetAdminLunaCardsCombine();
const hiddenWrap = hidden.document.getElementById('cc-luna-notes-alerts-automations');
hidden.__register('cc-luna-notes-alerts-automations', hiddenWrap);
assert.ok(hiddenWrap, 'wrap still exists when children hidden');
assert.strictEqual(hiddenWrap.style.display, 'none', 'empty combine wrap is hidden for non-owner');

const incomplete = { document: {}, console };
vm.runInNewContext(uiSrc, incomplete);
assert.equal(typeof incomplete.paintSunsetAdminLunaCardsCombine, 'function', 'paint exported on incomplete sandbox');
assert.doesNotThrow(() => incomplete.paintSunsetAdminLunaCardsCombine(), 'paint must not throw on incomplete document');

console.log('PASS SUNSET-ADMIN-LUNA-CARDS-COMBINE-001 one Admin card notes/alerts/automations');
