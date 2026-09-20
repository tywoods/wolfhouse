#!/usr/bin/env node
'use strict';

/**
 * SUNSET-UI-POLISH-EMAIL-AND-INBOX-TABS-001
 *
 * 1) Admin Email mailbox buttons match site guest-card actions
 *    (appearance:none, surface+border ghost, green primary on Connect).
 * 2) Inbox Full/Guest become folder tabs Chats | Guests on the leftmost
 *    column; #tabs presets hide on Sunset only; click still setPreset.
 *
 * Stay off inbox-thread.js, Crow's Nest, Hermes gateways, production.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const SHELL_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-shell.js');
const COLUMNS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-columns.js');
const EMAIL_UI_PATH = path.join(ROOT, 'scripts', 'browser', 'sunset-admin-email-settings-ui.js');
const THREAD_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const shellSrc = fs.readFileSync(SHELL_PATH, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_PATH, 'utf8');
const emailUiSrc = fs.readFileSync(EMAIL_UI_PATH, 'utf8');
const threadBefore = fs.readFileSync(THREAD_PATH, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

console.log('\n── email mailbox buttons ──');
ok('kills native white button chrome',
  /appearance:none/.test(apiSrc) && /-webkit-appearance:none/.test(apiSrc)
  && /portal-admin-email-action-btn/.test(apiSrc));
ok('ghost fill uses surface + border like .btn-ghost',
  /portal-admin-email-action-btn[^\{]*\{[^}]*background:var\(--surface\)/.test(apiSrc)
  && /portal-admin-email-action-btn[^\{]*\{[^}]*border:1px solid var\(--border\)/.test(apiSrc));
ok('Connect / Register / Retry are green primary',
  /\[data-email-connect\][^\{]{0,80}\{[^}]*background:var\(--primary\)/.test(apiSrc)
  || /action-btn\[data-email-connect\][^\{]*\{[^}]*background:var\(--primary\)/.test(apiSrc));
ok('email owner file still paints action buttons',
  emailUiSrc.includes('portal-admin-email-action-btn')
  && emailUiSrc.includes('data-email-connect')
  && emailUiSrc.includes('data-email-disconnect'));

console.log('\n── inbox folder tabs markup ──');
const railStart = apiSrc.indexOf('<nav class="inbox-col1"');
const railBody = railStart < 0 ? '' : apiSrc.slice(railStart, apiSrc.indexOf('</nav>', railStart));
ok('left column has folder tabs, not the old view-switch',
  /class="inbox-folder-tabs"/.test(railBody)
  && !/class="inbox-view-switch"/.test(railBody));
ok('visible labels are Chats and Guests',
  /data-i18n="inbox.layout.folder.chats">Chats</.test(railBody)
  && /data-i18n="inbox.layout.folder.guests">Guests</.test(railBody)
  && !/>Full</.test(railBody)
  && !/>Guest</.test(railBody));
ok('folder tabs keep Full vs Guest presets',
  /data-view="full"[^>]*data-inbox-preset="all4"/.test(railBody)
  && /data-view="guest"[^>]*data-inbox-preset="guest"/.test(railBody)
  && /inboxColumnsSetPreset\('all4'\)/.test(railBody)
  && /inboxColumnsSetPreset\('guest'\)/.test(railBody));
ok('#tabs still has hidden Full/Chat/Guest markup for gates',
  /data-inbox-preset="all4"/.test(apiSrc)
  && /data-inbox-preset="chat"/.test(apiSrc)
  && />Full</.test(apiSrc));

console.log('\n── sunset-only chrome ──');
ok('folder tabs hidden by default (Wolfhouse)',
  /\.inbox-folder-tabs\{display:none\}/.test(apiSrc));
ok('Sunset shows folder tabs on the left rail',
  /html\[data-portal-client="sunset"\] \.inbox-col1 > \.inbox-folder-tabs\{/.test(apiSrc)
  && /display:flex/.test(apiSrc.slice(apiSrc.indexOf('html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs{'))));
ok('Sunset hides #tabs Full/Guest chips',
  /html\[data-portal-client="sunset"\] #tabs \.inbox-layout-presets\{display:none!important\}/.test(apiSrc));
ok('mockup still hides leftover Conversations|Customers switch',
  /#tab-conversations \.inbox-view-switch\{display:none!important\}/.test(shellSrc));

console.log('\n── EN/ES ──');
ok('EN Chats / Guests',
  STAFF_PORTAL_STRINGS.en['inbox.layout.folder.chats'] === 'Chats'
  && STAFF_PORTAL_STRINGS.en['inbox.layout.folder.guests'] === 'Guests');
ok('ES Chats / Huéspedes',
  STAFF_PORTAL_STRINGS.es['inbox.layout.folder.chats'] === 'Chats'
  && STAFF_PORTAL_STRINGS.es['inbox.layout.folder.guests'] === 'Huéspedes');
ok('hidden preset keys stay Full / Completa',
  STAFF_PORTAL_STRINGS.en['inbox.layout.preset.all4'] === 'Full'
  && STAFF_PORTAL_STRINGS.es['inbox.layout.preset.all4'] === 'Completa');

console.log('\n── click path (folder tab → setPreset) ──');
function makeBtn(attrs) {
  const classSet = new Set(String(attrs.className || '').split(/\s+/).filter(Boolean));
  return {
    attrs: Object.assign({}, attrs),
    classList: {
      toggle(name, on) {
        if (on) classSet.add(name);
        else classSet.delete(name);
      },
      contains(name) { return classSet.has(name); },
    },
    getAttribute(k) { return this.attrs[k] == null ? null : String(this.attrs[k]); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    closest(sel) {
      if (sel === '[data-inbox-preset]' && this.attrs['data-inbox-preset']) return this;
      if (sel === '.inbox-view-btn' || sel === '.inbox-folder-tab') return this;
      return null;
    },
  };
}
const chatsBtn = makeBtn({
  className: 'inbox-folder-tab inbox-view-btn is-active',
  'data-view': 'full',
  'data-inbox-preset': 'all4',
  'aria-pressed': 'true',
});
const guestsBtn = makeBtn({
  className: 'inbox-folder-tab inbox-view-btn',
  'data-view': 'guest',
  'data-inbox-preset': 'guest',
  'aria-pressed': 'false',
});
const tabsFull = makeBtn({
  className: 'inbox-layout-preset-btn is-active',
  'data-inbox-preset': 'all4',
  'aria-pressed': 'true',
});
const ctx = {
  INBOX_COLUMNS_SHELL_ID: 'inbox-shell',
  document: {
    querySelectorAll(sel) {
      if (sel === '[data-inbox-preset]') return [tabsFull, chatsBtn, guestsBtn];
      if (sel.indexOf('.inbox-view-btn[data-view="full"]') >= 0) return [chatsBtn, guestsBtn];
      if (sel === '[data-inbox-col-toggle]') return [];
      return [];
    },
    querySelector() { return null; },
    getElementById(id) {
      return id === 'inbox-shell'
        ? { setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {} }
        : null;
    },
    addEventListener() {},
  },
  window: { addEventListener() {}, innerWidth: 1440, matchMedia() { return { matches: false, addListener() {}, addEventListener() {} }; } },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  console,
};
ctx.window.document = ctx.document;
vm.createContext(ctx);
vm.runInContext(columnsSrc, ctx);
ok('columns module loaded', typeof ctx.inboxColumnsSetPreset === 'function'
  && typeof ctx.inboxColumnsHandleControlClick === 'function');

const presets = [];
const origSet = ctx.inboxColumnsSetPreset;
ctx.inboxColumnsSetPreset = function (preset) {
  presets.push(preset);
  return origSet.apply(this, arguments);
};
ctx.inboxColumnsHandleControlClick({ target: guestsBtn });
ok('Guests folder tab click sets guest preset', presets[0] === 'guest');
ok('Guests tab is active after guest click',
  guestsBtn.getAttribute('aria-pressed') === 'true'
  && guestsBtn.classList.contains('is-active')
  && chatsBtn.getAttribute('aria-pressed') === 'false');
ctx.inboxColumnsHandleControlClick({ target: chatsBtn });
ok('Chats folder tab click sets all4 (Full) preset', presets[1] === 'all4');
ok('Chats tab is active after all4 click',
  chatsBtn.getAttribute('aria-pressed') === 'true'
  && guestsBtn.getAttribute('aria-pressed') === 'false');

console.log('\n── stay off ──');
ok('inbox-thread.js not modified',
  fs.readFileSync(THREAD_PATH, 'utf8') === threadBefore);
ok('email UI does not mention inbox-thread',
  !emailUiSrc.includes('inbox-thread'));

if (fail) {
  console.error(`\nFAILED ${fail}  passed ${pass}`);
  process.exit(1);
}
console.log(`\nOK ${pass} checks`);
