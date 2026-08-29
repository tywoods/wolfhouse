'use strict';

/**
 * verify:inbox-empty-states
 *
 * Bug Finder #18 — Inbox empty states must not triplicate:
 *   - one filter-aware message in the list column
 *   - select-a-thread prompt in the detail pane (not a second empty-inbox message)
 *
 * Offline: reads staff-query-api.js + inbox-rows.js, executes helpers in vm.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const ROWS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-rows.js');
const ES_SUNSET_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_PATH, 'utf8');
const esSunsetSrc = fs.readFileSync(ES_SUNSET_PATH, 'utf8');
const i18nSrc = fs.readFileSync(I18N_PATH, 'utf8');

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

function extractFn(src, name) {
  const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`);
  const m = src.match(re);
  if (!m) throw new Error(`missing function ${name}`);
  return m[0];
}

console.log('\nverify:inbox-empty-states — list/detail empty chrome\n');

console.log('── source contracts ──');
ok('inboxEmptyViewKind considers saved view id',
  apiSrc.includes('function inboxEmptyViewKind(')
  && /viewId === 'needs_human'/.test(apiSrc));
ok('inboxEmptyDetailHtml uses t() not portalT() for main (no surf empty-inbox copy)',
  /function inboxEmptyDetailHtml\([\s\S]*?t\('inbox\.empty\.main'\)/.test(apiSrc)
  && !/function inboxEmptyDetailHtml\([\s\S]*?portalT\('inbox\.empty\.main'\)/.test(apiSrc));
ok('inboxEmptyDetailHtml does not use school.surf sub in detail pane',
  !/function inboxEmptyDetailHtml\([\s\S]*?sub\.school\.surf/.test(apiSrc));
ok('inbox-rows dedupes list empty chrome after renderInbox',
  rowsSrc.includes('function inboxRowsFixEmptyChrome(')
  && rowsSrc.includes('inboxRowsFixEmptyChrome(convs, opts)'));
ok('inbox-thread.js is not edited for this fix',
  !fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js'), 'utf8')
    .includes('inboxRowsFixEmptyChrome'));
ok('ES needs-human empty list copy is filter-aware short form',
  esSunsetSrc.includes("'inbox.empty.listNeedsHuman.surf': 'Nada requiere atención.'"));
ok('EN needs-human empty list copy is filter-aware short form',
  i18nSrc.includes("'inbox.empty.listNeedsHuman.surf': 'Nothing needs attention.'"));

console.log('\n── runtime helpers ──');
const sandbox = {
  inboxFilter: 'all',
  inboxSavedViewId: 'needs_human',
  selectedConvId: null,
  console,
  escHtml: (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'),
  t: (key) => ({
    'inbox.empty.main': 'Select a conversation to review.',
    'inbox.empty.sub': 'Luna drafts and booking context will appear here.',
    'inbox.empty.listNeedsHuman.surf': 'Nothing needs attention.',
    'inbox.empty.list.school.surf': 'No guest email or chat messages for {school} yet.',
  }[key] || key),
  portalT: (key) => sandbox.t(key),
  getClient: () => 'sunset',
  getPortalProfile: () => ({ is_surf_vertical: true }),
  getSunsetLocationLabel: () => 'Sunset',
};
vm.createContext(sandbox);
vm.runInContext(
  extractFn(apiSrc, 'inboxEmptyViewKind') + '\n' +
  extractFn(apiSrc, 'inboxEmptyListMessage') + '\n' +
  extractFn(apiSrc, 'inboxEmptyDetailHtml') + '\n',
  sandbox,
);

ok('needs_human saved view maps to needs-human empty kind',
  sandbox.inboxEmptyViewKind() === 'needs-human');
ok('needs_human view uses filter-aware list message (not generic school empty)',
  sandbox.inboxEmptyListMessage() === 'Nothing needs attention.'
  && !sandbox.inboxEmptyListMessage().includes('Sunset'));
ok('detail empty uses select-a-thread main (not surf empty-inbox main)',
  sandbox.inboxEmptyDetailHtml().includes('Select a conversation to review.')
  && !sandbox.inboxEmptyDetailHtml().includes('No conversations yet')
  && !sandbox.inboxEmptyDetailHtml().includes('Guest emails and WhatsApp'));

console.log('\n── renderInbox wrap dedupes chrome ──');
const domSandbox = {
  window: {},
  document: {
    getElementById(id) {
      return domSandbox.nodes[id] || null;
    },
    createElement() { return { id: '', textContent: '', appendChild() {} }; },
    head: { appendChild() {} },
  },
  nodes: {
    'inbox-state': {
      id: 'inbox-state',
      style: { display: 'block' },
      textContent: '',
      classList: {
        _c: new Set(),
        remove(k) { this._c.delete(k); },
        add(k) { this._c.add(k); },
      },
    },
    'conv-list': { id: 'conv-list', innerHTML: '' },
    'detail-content': { id: 'detail-content', innerHTML: '' },
  },
  inboxRowsRuntime: { wired: true },
  inboxFilter: 'all',
  inboxSavedViewId: 'needs_human',
  selectedConvId: null,
  console,
  escHtml: sandbox.escHtml,
  t: sandbox.t,
  portalT: sandbox.portalT,
  getClient: sandbox.getClient,
  getPortalProfile: sandbox.getPortalProfile,
  getSunsetLocationLabel: sandbox.getSunsetLocationLabel,
  inboxEmptyListMessage: sandbox.inboxEmptyListMessage,
  inboxEmptyDetailHtml: sandbox.inboxEmptyDetailHtml,
};
domSandbox.window = domSandbox;
domSandbox.el = (id) => domSandbox.nodes[id] || null;
vm.createContext(domSandbox);
vm.runInContext(
  'function inboxRowsEl(id) { return el(id); }\n' +
  'function inboxRowsEsc(value) { return escHtml(value); }\n' +
  extractFn(rowsSrc, 'inboxRowsFixEmptyChrome') + '\n',
  domSandbox,
);
domSandbox.nodes['inbox-state'].textContent = 'No guest email or chat messages for Sunset yet.';
domSandbox.nodes['inbox-state'].style.display = 'block';
domSandbox.nodes['conv-list'].innerHTML =
  '<div class="conv-list-empty">No guest email or chat messages for Sunset yet.</div>';
domSandbox.nodes['detail-content'].innerHTML =
  '<div class="inbox-empty-right"><p class="main-msg">No conversations yet.</p>' +
  '<p class="sub-msg">Guest emails and WhatsApp for Sunset will appear here.</p></div>';
domSandbox.inboxRowsFixEmptyChrome([], {});
ok('after wrap: inbox-state hidden when list is empty',
  domSandbox.nodes['inbox-state'].style.display === 'none');
ok('after wrap: list keeps one filter-aware empty message',
  domSandbox.nodes['conv-list'].innerHTML === '<div class="conv-list-empty">Nothing needs attention.</div>');
ok('after wrap: detail pane restored to select-a-thread prompt',
  domSandbox.nodes['detail-content'].innerHTML.includes('Select a conversation to review.')
  && !domSandbox.nodes['detail-content'].innerHTML.includes('Guest emails and WhatsApp'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-empty-states — FAILED');
  process.exit(1);
}
console.log('verify:inbox-empty-states — ALL CHECKS PASSED');
process.exit(0);
