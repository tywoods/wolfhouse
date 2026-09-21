#!/usr/bin/env node
'use strict';

/**
 * ADMIN-LUNA-STAFF-CARDS-REGROUP-001
 * Admin → Luna Staff 3-card layout on Sunset AND Wolfhouse:
 *   1. General Notes (own card, first)
 *   2. Numbers → Guest Conversation Alerts → Automated Staff Notifications
 *   3. Style + Luna Personality
 * Stay off inbox-thread.js and staff-query-api HTML.
 * Supersedes SUNSET-ADMIN-LUNA-CARDS-COMBINE-001.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OWNER = path.join(ROOT, 'scripts/browser/sunset-admin-luna-cards-combine.js');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');
const WH_ADMIN_UI = path.join(ROOT, 'scripts/browser/wolfhouse-admin-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts/lib/sunset-admin-browser-source.js');
const WH_BROWSER_SRC = path.join(ROOT, 'scripts/lib/wolfhouse-admin-browser-source.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

const uiSrc = fs.readFileSync(OWNER, 'utf8');
const adminUi = fs.readFileSync(ADMIN_UI, 'utf8');
const whAdminUi = fs.readFileSync(WH_ADMIN_UI, 'utf8');
const injectSrc = fs.readFileSync(BROWSER_SRC, 'utf8');
const whInjectSrc = fs.readFileSync(WH_BROWSER_SRC, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');

assert.ok(uiSrc.includes('paintAdminLunaStaffCardsRegroup'), 'exports regroup paint');
assert.ok(uiSrc.includes('data-admin-luna-numbers-combine'), 'numbers wrap marker');
assert.ok(uiSrc.includes('data-admin-luna-style-combine'), 'style wrap marker');
assert.ok(uiSrc.includes('cc-staff-whatsapp-numbers'), 'moves staff numbers');
assert.ok(uiSrc.includes('cc-staff-notification-settings'), 'moves guest alerts');
assert.ok(uiSrc.includes('cc-automated-staff-notifications'), 'moves automations');
assert.ok(uiSrc.includes('staff-style-card'), 'moves style card');
assert.ok(uiSrc.includes('staff-luna-personality-card'), 'moves personality');
assert.ok(uiSrc.includes('cc-house-notes'), 'places general notes');
assert.ok(
  uiSrc.indexOf("numbersWrap.appendChild(numbers)") < uiSrc.indexOf("numbersWrap.appendChild(alerts)")
    && uiSrc.indexOf("numbersWrap.appendChild(alerts)") < uiSrc.indexOf("numbersWrap.appendChild(autos)"),
  'runtime order numbers → alerts → automations',
);
assert.ok(
  uiSrc.indexOf("styleWrap.appendChild(styleCard)") < uiSrc.indexOf("styleWrap.appendChild(personality)"),
  'runtime order style → personality',
);
assert.ok(
  uiSrc.indexOf('host.insertBefore(notes') < uiSrc.indexOf('host.insertBefore(numbersWrap')
    && uiSrc.indexOf('host.insertBefore(numbersWrap') < uiSrc.indexOf('host.insertBefore(styleWrap'),
  'top order notes → numbers wrap → style wrap',
);
assert.ok(uiSrc.includes('padding:16px 18px'), 'Pricing card padding');
assert.ok(uiSrc.includes('background:var(--surface)'), 'Salt/Sand surface, not surface-soft');
assert.ok(!uiSrc.includes('--surface-soft'), 'card is not grey surface-soft');
assert.ok(!/Foam|Sol|Kelp|Ember/.test(uiSrc), 'no new palette names');
assert.ok(!uiSrc.includes('inbox-thread'), 'owner stays off inbox-thread');
assert.ok(!/\bfetch\s*\(/.test(uiSrc), 'no network');
assert.ok(!/sendWhatsApp/.test(uiSrc), 'does not send WhatsApp');
assert.ok(uiSrc.includes('wolfhouse-somo') && uiSrc.includes("'sunset'"), 'targets both portals');

assert.ok(injectSrc.includes('sunset-admin-luna-cards-combine.js'), 'injected with sunset Admin UI');
assert.ok(whInjectSrc.includes('sunset-admin-luna-cards-combine.js'), 'injected with wolfhouse Admin UI');
const injectFn = injectSrc.match(/function getSunsetAdminUiBrowserSource\(\) \{[\s\S]*?\n\}/);
assert.ok(injectFn, 'getSunsetAdminUiBrowserSource present');
assert.ok(
  injectFn[0].indexOf('LUNA_CARDS_COMBINE') >= 0
    && injectFn[0].indexOf('LUNA_CARDS_COMBINE') < injectFn[0].indexOf('BROWSER_UI'),
  'combine injected before admin-ui',
);
assert.ok(
  /function getWolfhouseAdminUiSource\(\) \{[\s\S]*LUNA_STAFF_CARDS_REGROUP[\s\S]*BROWSER_SRC/.test(whInjectSrc),
  'wolfhouse injects regroup before admin-ui',
);

assert.ok(
  /paintAdminLunaStaffCardsRegroup\(\)/.test(adminUi),
  'Sunset Admin locale/tab paints regroup',
);
assert.ok(
  /next === 'luna-staff'[\s\S]{0,120}paintAdminLunaStaffCardsRegroup/.test(adminUi),
  'Sunset Luna Staff subtab paints regroup after wire',
);
assert.ok(
  /next === 'luna-staff'[\s\S]{0,200}paintAdminLunaStaffCardsRegroup/.test(whAdminUi),
  'Wolfhouse Luna Staff subtab paints regroup after wire',
);

assert.ok(!apiSrc.includes('cc-luna-numbers-alerts-automations'), 'staff-query-api.js stays file-bounded off');
assert.ok(!apiSrc.includes('cc-luna-style-personality'), 'staff-query-api.js has no style wrap id');
assert.ok(!threadSrc.includes('paintAdminLunaStaffCardsRegroup'), 'inbox-thread.js untouched');
assert.ok(!threadSrc.includes('cc-luna-numbers-alerts-automations'), 'inbox-thread.js has no numbers wrap');

function node(id, className) {
  const n = {
    id,
    className: className || '',
    style: { display: '' },
    parentNode: null,
    children: [],
    nextSibling: null,
    firstChild: null,
    getAttribute() { return null; },
    setAttribute() {},
    appendChild(child) {
      if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
        child.parentNode.removeChild(child);
      }
      this.children.push(child);
      child.parentNode = this;
      this.firstChild = this.children[0] || null;
      for (let i = 0; i < this.children.length; i++) {
        this.children[i].nextSibling = this.children[i + 1] || null;
      }
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
      this.firstChild = this.children[0] || null;
      for (let j = 0; j < this.children.length; j++) {
        this.children[j].nextSibling = this.children[j + 1] || null;
      }
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      this.firstChild = this.children[0] || null;
      for (let j = 0; j < this.children.length; j++) {
        this.children[j].nextSibling = this.children[j + 1] || null;
      }
      return child;
    },
  };
  return n;
}

function makeSandbox(opts) {
  const portalClient = opts.portalClient;
  const client = opts.client;
  const wrapHost = node('al-wrap');
  const styleCard = node('staff-style-card', 'staff-style-card luna-header-mode-card');
  const personality = node('staff-luna-personality-card', 'staff-style-card luna-header-mode-card');
  const numbers = node('cc-staff-whatsapp-numbers', 'card cc-section');
  const alerts = node('cc-staff-notification-settings', 'card cc-section');
  const autos = node('cc-automated-staff-notifications', 'card cc-section');
  const notes = node('cc-house-notes', 'card cc-section');
  const owner = node('cc-owner-schedule-bridge', 'card cc-section');
  wrapHost.appendChild(styleCard);
  wrapHost.appendChild(personality);
  wrapHost.appendChild(owner);
  wrapHost.appendChild(numbers);
  wrapHost.appendChild(autos);
  wrapHost.appendChild(alerts);
  wrapHost.appendChild(notes);
  numbers.style.display = opts.hideNumbers ? 'none' : '';
  alerts.style.display = opts.hideAlerts ? 'none' : '';
  autos.style.display = opts.hideAutos ? 'none' : '';
  notes.style.display = opts.hideNotes ? 'none' : '';

  const byId = {
    'al-wrap': wrapHost,
    'staff-style-card': styleCard,
    'staff-luna-personality-card': personality,
    'cc-staff-whatsapp-numbers': numbers,
    'cc-staff-notification-settings': alerts,
    'cc-automated-staff-notifications': autos,
    'cc-house-notes': notes,
    'cc-owner-schedule-bridge': owner,
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
        return created;
      },
      getElementById(id) {
        if (id === 'admin-luna-staff-cards-regroup-css') return cssMounted ? { id } : null;
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
  sandbox.__numbers = numbers;
  sandbox.__alerts = alerts;
  sandbox.__autos = autos;
  sandbox.__style = styleCard;
  sandbox.__personality = personality;
  sandbox.__owner = owner;
  sandbox.__byId = byId;
  sandbox.__register = function register(id, n) { byId[id] = n; };
  return sandbox;
}

function assertRegroup(label, sandbox) {
  sandbox.paintAdminLunaStaffCardsRegroup();
  const numbersWrap = sandbox.document.getElementById('cc-luna-numbers-alerts-automations');
  const styleWrap = sandbox.document.getElementById('cc-luna-style-personality');
  assert.ok(numbersWrap, `${label}: numbers wrap`);
  assert.ok(styleWrap, `${label}: style wrap`);
  sandbox.__register('cc-luna-numbers-alerts-automations', numbersWrap);
  sandbox.__register('cc-luna-style-personality', styleWrap);

  assert.strictEqual(sandbox.__host.children[0], sandbox.__notes, `${label}: notes first`);
  assert.strictEqual(sandbox.__host.children[1], numbersWrap, `${label}: numbers wrap second`);
  assert.strictEqual(sandbox.__host.children[2], styleWrap, `${label}: style wrap third`);

  assert.strictEqual(numbersWrap.children[0], sandbox.__numbers, `${label}: numbers first in wrap`);
  assert.strictEqual(numbersWrap.children[1], sandbox.__alerts, `${label}: alerts second in wrap`);
  assert.strictEqual(numbersWrap.children[2], sandbox.__autos, `${label}: autos third in wrap`);
  assert.strictEqual(styleWrap.children[0], sandbox.__style, `${label}: style first in style wrap`);
  assert.strictEqual(styleWrap.children[1], sandbox.__personality, `${label}: personality second in style wrap`);

  assert.ok(/\bcard\b/.test(sandbox.__notes.className), `${label}: notes stays a card`);
  assert.ok(!/\bcard\b/.test(sandbox.__numbers.className), `${label}: numbers demoted`);
  assert.ok(!/\bcard\b/.test(sandbox.__alerts.className), `${label}: alerts demoted`);
  assert.ok(!/\bcard\b/.test(sandbox.__autos.className), `${label}: autos demoted`);
  assert.ok(sandbox.__host.children.indexOf(sandbox.__owner) > 2, `${label}: owner schedule after primary three`);

  sandbox.paintAdminLunaStaffCardsRegroup();
  assert.strictEqual(
    sandbox.document.getElementById('cc-luna-numbers-alerts-automations'),
    numbersWrap,
    `${label}: second paint idempotent numbers wrap`,
  );
  assert.strictEqual(numbersWrap.children.length, 3, `${label}: no duplicate numbers sections`);
  assert.strictEqual(styleWrap.children.length, 2, `${label}: no duplicate style sections`);
}

assertRegroup('sunset', makeSandbox({ portalClient: 'sunset', client: 'sunset' }));
assertRegroup('wolfhouse', makeSandbox({ portalClient: 'wolfhouse', client: 'wolfhouse-somo' }));

const other = makeSandbox({ portalClient: '', client: 'other-tenant' });
other.paintAdminLunaStaffCardsRegroup();
assert.ok(!other.document.getElementById('cc-luna-numbers-alerts-automations'), 'other tenant does not regroup');
assert.ok(/\bcard\b/.test(other.__numbers.className), 'other tenant numbers stay a card');

const hidden = makeSandbox({
  portalClient: 'sunset', client: 'sunset',
  hideNumbers: true, hideAlerts: true, hideAutos: true, hideNotes: true,
});
hidden.paintAdminLunaStaffCardsRegroup();
const hiddenWrap = hidden.document.getElementById('cc-luna-numbers-alerts-automations');
hidden.__register('cc-luna-numbers-alerts-automations', hiddenWrap);
assert.ok(hiddenWrap, 'wrap still exists when children hidden');
assert.strictEqual(hiddenWrap.style.display, 'none', 'empty numbers wrap is hidden for non-owner');

const incomplete = { document: {}, console };
vm.runInNewContext(uiSrc, incomplete);
assert.equal(typeof incomplete.paintAdminLunaStaffCardsRegroup, 'function', 'paint exported on incomplete sandbox');
assert.doesNotThrow(() => incomplete.paintAdminLunaStaffCardsRegroup(), 'paint must not throw on incomplete document');
assert.equal(typeof incomplete.paintSunsetAdminLunaCardsCombine, 'function', 'legacy alias exported');

console.log('PASS ADMIN-LUNA-STAFF-CARDS-REGROUP-001 notes / numbers+alerts+autos / style+personality on Sunset+Wolfhouse');
