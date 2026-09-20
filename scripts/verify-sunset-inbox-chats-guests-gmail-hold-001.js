#!/usr/bin/env node
'use strict';

/** SUNSET-INBOX-CHATS-GUESTS-GMAIL-HOLD-001
 * Current Chats/Guests deck remains painted while the destination deck builds,
 * then the complete deck swaps once. Sunset only; 500ms is a stall net.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');
const { ROWS_MODULE, THREAD_MODULE } = require('./lib/inbox-browser-source');
const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const api = fs.readFileSync(API, 'utf8');
const rows = fs.readFileSync(ROWS_MODULE, 'utf8');
const thread = fs.readFileSync(THREAD_MODULE, 'utf8');
const views = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-views.js'), 'utf8');
let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS ', label); }
  else { fail++; console.error('  FAIL ', label, detail || ''); }
}
function diff(rel) {
  try { return execSync(`git diff HEAD -- ${rel}`, { cwd: ROOT, encoding: 'utf8' }); }
  catch (_) { return 'git-error'; }
}
function classList() {
  const values = new Set();
  return { add(x){ values.add(x); }, remove(x){ values.delete(x); }, contains(x){ return values.has(x); } };
}
function element(id) {
  return {
    id, classList: classList(), attrs: {}, style: {}, children: [], parentNode: null,
    setAttribute(k,v){ this.attrs[k] = String(v); }, getAttribute(k){ return this.attrs[k]; },
    getBoundingClientRect(){ return { left: 20, top: 64, width: 1480, height: 760 }; },
    cloneNode(){ const n = element(''); n.isClone = true; return n; },
    appendChild(n){ n.parentNode = this; this.children.push(n); return n; },
    insertBefore(n){ return this.appendChild(n); },
    removeChild(n){ this.children = this.children.filter(x => x !== n); n.parentNode = null; },
    querySelector(sel){
      if (/conv-card|inbox-row/.test(String(sel)) && /conv-card|inbox-row/.test(String(this.innerHTML || ''))) return {};
      return null;
    },
  };
}
function harness(startGuest) {
  const html = element('html'); html.getAttribute = k => k === 'data-portal-client' ? 'sunset' : null;
  const body = element('body');
  const wrap = element('wrap'); wrap.classList.add('inbox-shell-wrap'); body.appendChild(wrap);
  const shell = element('inbox-shell'); wrap.appendChild(shell);
  const list = element('conv-list'); list.innerHTML = '<div class="conv-card">Ada</div>';
  const guest = element('guest'); guest.attrs['aria-pressed'] = startGuest ? 'true' : 'false';
  const chats = element('chats'); chats.attrs['aria-pressed'] = startGuest ? 'false' : 'true';
  const raf = [], timers = [], events = [];
  const document = {
    documentElement: html, body,
    startViewTransition(update) {
      events.push({ type: 'snapshot' });
      const ready = update();
      return { ready, finished: ready };
    },
    getElementById(id){ return ({ wrap, 'inbox-shell': shell, 'conv-list': list })[id] || null; },
    querySelector(sel){
      if (sel === '[data-inbox-preset="guest"][aria-pressed="true"]') return guest.attrs['aria-pressed'] === 'true' ? guest : null;
      if (sel === '.inbox-folder-hold') return body.children.find(x => x.classList.contains('inbox-folder-hold')) || null;
      return null;
    },
    createElement(){ return element(''); }, head: { appendChild(){} }, getElementsByTagName(){ return [this.head]; },
  };
  function preset(name) {
    guest.attrs['aria-pressed'] = name === 'guest' ? 'true' : 'false';
    chats.attrs['aria-pressed'] = name === 'guest' ? 'false' : 'true';
    events.push({ type: 'preset', hold: !!document.querySelector('.inbox-folder-hold') });
  }
  const s = {
    window: {}, document, console, Object, Array, String, Set,
    requestAnimationFrame(cb){ raf.push(cb); },
    setTimeout(cb, ms){ timers.push({ cb, ms }); return timers.length; }, clearTimeout(){},
    inboxColumnsSetPreset: preset, inboxColumnsRuntime: { record: { preset: startGuest ? 'guest' : 'all4' } },
    inboxContextIsGuestMode(){ return guest.attrs['aria-pressed'] === 'true'; },
    inboxCustomerPaint(){}, inboxViewsSwitchSurface(){}, renderInbox(){}, renderInboxViewsRail(){},
    getComputedStyle(){ return { marginLeft: '0px', marginRight: '0px' }; },
    scrollX: 0, scrollY: 0, innerWidth: 1520,
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(`${rows}\nthis.__rows = window.__inboxRows;`, s);
  s.flush = () => { const q = raf.splice(0); q.forEach(fn => fn()); };
  return { s, body, wrap, shell, timers, events };
}

console.log('verify SUNSET-INBOX-CHATS-GUESTS-GMAIL-HOLD-001');
console.log('\n── contract ──');
ok('Sunset keeps 1520px shared wrap', /html\[data-portal-client="sunset"\][\s\S]{0,180}max-width:1520px!important/.test(api));
ok('Guests keeps 14px list→card gap', /--inbox-col-gap:14px/.test(api));
ok('old blanking CSS is removed', !/html\[data-portal-client="sunset"\] #inbox-shell\.inbox-folder-switching\{[\s\S]{0,120}(visibility:hidden|opacity:0)/.test(api)
  && !/html\[data-portal-client="sunset"\] #wrap\.inbox-shell-wrap\.inbox-folder-switching\{[\s\S]{0,100}opacity:0/.test(api));
ok('hold uses a browser-owned immutable snapshot (no cloned duplicate IDs)',
  rows.includes('document.startViewTransition(function()')
  && !rows.includes('cloneNode(true)') && !rows.includes("classList.add('inbox-folder-hold')"));
ok('default cross-fade is disabled for a one-swap commit',
  api.includes('::view-transition-old(root)') && api.includes('::view-transition-new(root)')
  && api.includes('animation:none!important'));
ok('500ms exists only as the fallback net', /setTimeout\(function\(\) \{\s*inboxRowsEndFolderSwitch\(gen\);\s*\}, 500\)/.test(rows));
ok('a superseding switch releases the prior transition promise',
  /typeof inboxRowsRuntime\.folderSwitchResolve === 'function'[\s\S]{0,160}folderSwitchResolve\(\)/.test(rows));

console.log('\n── runtime ──');
{
  const h = harness(false); h.s.__rows.wrapGuestViewPreset(); h.s.inboxColumnsSetPreset('guest');
  ok('browser snapshots CURRENT before destination preset mutates',
    h.events[0] && h.events[0].type === 'snapshot'
    && h.events[1] && h.events[1].type === 'preset');
  const gen = h.s.inboxRowsRuntime.folderSwitching;
  h.s.__rows.noteFolderSwitchPart('list', gen); h.s.__rows.noteFolderSwitchPart('rail');
  ok('destination remains pending while only list+rail are ready', h.s.inboxRowsRuntime.folderSwitching > 0);
  h.s.__rows.noteFolderSwitchPart('card');
  ok('ready parts commit the switch without waiting for the net', h.s.inboxRowsRuntime.folderSwitching === 0);
  ok('happy path does not wait for fallback timer', h.timers.some(x => x.ms === 500));
}
{
  const h = harness(false); h.s.__rows.wrapGuestViewPreset(); h.s.inboxColumnsSetPreset('guest');
  const gen = h.s.inboxRowsRuntime.folderSwitching;
  h.s.__rows.noteFolderSwitchPart('rail'); h.s.__rows.noteFolderSwitchPart('card');
  h.s.__rows.noteFolderSwitchPart('list', gen - 1);
  ok('stale loadInbox generation cannot release CURRENT', h.s.inboxRowsRuntime.folderSwitching === gen);
  h.s.__rows.noteFolderSwitchPart('list', gen);
  ok('matching loadInbox generation completes NEXT readiness', h.s.inboxRowsRuntime.folderSwitching === 0);
}
{
  const h = harness(false); h.s.__rows.wrapGuestViewPreset(); h.s.inboxColumnsSetPreset('guest');
  const net = h.timers.find(x => x.ms === 500); net.cb();
  ok('500ms stall net commits even if destination parts stall', h.s.inboxRowsRuntime.folderSwitching === 0);
}

console.log('\n── scope fence ──');
ok('Sunset gate exists without package registration', !fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').includes('verify-sunset-inbox-chats-guests-gmail-hold-001'));
ok('inbox-thread change carries the folderSwitchGen boundary',
  thread.includes('var folderSwitchGen = Number(opts.folderSwitchGen) || 0;')
  && thread.includes('folderSwitchGen: folderSwitchGen'));
ok('active saved-view load path also carries folderSwitchGen',
  views.includes('function loadInboxFromSavedView(selectConvIdAfterLoad, opts)')
  && views.includes('var folderSwitchGen = Number(opts.folderSwitchGen) || 0;')
  && /applyInboxSavedViewRows\(inboxSavedViewRows, \{[\s\S]{0,180}folderSwitchGen: folderSwitchGen/.test(views));
ok('stay off Crow\'s Nest', diff('scripts/lib/crowsnest/crowsnest-page.js') === '');
if (fail) { console.error(`\nFAILED ${fail}; ${pass} passed`); process.exit(1); }
console.log(`\nOK ${pass} checks`);
