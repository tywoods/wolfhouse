#!/usr/bin/env node
'use strict';

/**
 * INBOX-WA-AUTOMODE-HIDE-DRAFTS-001
 *
 * WhatsApp Channel Autonomy Auto hides Save draft and Delete draft.
 * Send reply stays. Draft mode shows all three. Email Delete draft stays.
 * Global Pause forces effective Draft, so the buttons come back.
 *
 * Run: node scripts/verify-inbox-wa-automode-hide-drafts.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WA = path.join(ROOT, 'scripts/browser/inbox-whatsapp-draft.js');
const SHELL = path.join(ROOT, 'scripts/browser/inbox-shell.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

const HIDE_RULE = '#inbox-shell.is-wa-automode [data-wa-composer-actions] #btn-save-draft,#inbox-shell.is-wa-automode [data-wa-composer-actions] #btn-delete-draft,#inbox-shell [data-wa-composer-actions] #btn-save-draft[hidden],#inbox-shell [data-wa-composer-actions] #btn-delete-draft[hidden]{display:none!important}';

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + label);
    pass += 1;
  } else {
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
    fail += 1;
  }
}

function makeNode(id, attrs) {
  attrs = attrs || {};
  const classes = new Set(String(attrs.className || '').split(/\s+/).filter(Boolean));
  const node = {
    id: id || '',
    hidden: false,
    disabled: false,
    value: attrs.value || '',
    textContent: attrs.text || '',
    dataset: {},
    attributes: Object.assign({}, attrs.attrs || {}),
    children: [],
    parentNode: null,
    _listeners: {},
  };
  node.classList = {
    contains(name) { return classes.has(name); },
    add(name) { classes.add(name); },
    remove(name) { classes.delete(name); },
    toggle(name, on) {
      const next = on === undefined ? !classes.has(name) : !!on;
      if (next) classes.add(name); else classes.delete(name);
      return next;
    },
  };
  node.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(node.attributes, k) ? node.attributes[k] : null);
  node.setAttribute = (k, v) => {
    node.attributes[k] = String(v);
    if (k === 'hidden') node.hidden = true;
  };
  node.removeAttribute = (k) => {
    delete node.attributes[k];
    if (k === 'hidden') node.hidden = false;
  };
  node.appendChild = (child) => {
    child.parentNode = node;
    node.children.push(child);
    return child;
  };
  node.querySelector = (sel) => {
    const found = node.querySelectorAll(sel);
    return found[0] || null;
  };
  node.querySelectorAll = (sel) => {
    const out = [];
    walk(node, (n) => { if (n !== node && matches(n, sel)) out.push(n); });
    return out;
  };
  node.closest = (sel) => {
    let n = node;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  };
  node.contains = (other) => {
    let n = other;
    while (n) {
      if (n === node) return true;
      n = n.parentNode;
    }
    return false;
  };
  node.addEventListener = (type, fn) => {
    (node._listeners[type] || (node._listeners[type] = [])).push(fn);
  };
  node.dispatchEvent = (ev) => {
    const event = ev || {};
    event.type = event.type || 'click';
    if (!event.target) event.target = node;
    event.preventDefault = event.preventDefault || function() {};
    event.stopPropagation = event.stopPropagation || function() {};
    const list = (node._listeners[event.type] || []).slice();
    for (const fn of list) fn(event);
    if (event.bubbles && node.parentNode && node.parentNode.dispatchEvent) {
      node.parentNode.dispatchEvent(event);
    }
    return true;
  };
  return node;
}

function walk(node, fn) {
  fn(node);
  (node.children || []).forEach((child) => walk(child, fn));
}

function matches(node, sel) {
  if (!sel || !node) return false;
  if (sel.charAt(0) === '#') return node.id === sel.slice(1);
  if (sel.charAt(0) === '[') {
    const m = sel.match(/^\[([^=\]]+)(?:=\"([^\"]*)\")?\]$/);
    if (!m) return false;
    if (!Object.prototype.hasOwnProperty.call(node.attributes, m[1])) return false;
    return m[2] == null || node.attributes[m[1]] === m[2];
  }
  if (sel.charAt(0) === '.') return node.classList && node.classList.contains(sel.slice(1));
  return false;
}

function buildDom() {
  const byId = {};
  function track(node) {
    if (node.id) byId[node.id] = node;
    return node;
  }
  const shell = track(makeNode('inbox-shell'));
  const wrap = track(makeNode('inbox-shell-channel-defaults'));
  shell.appendChild(wrap);
  const waRow = makeNode('', { attrs: { 'data-inbox-autonomy-row': 'whatsapp' } });
  const emRow = makeNode('', { attrs: { 'data-inbox-autonomy-row': 'email' } });
  wrap.appendChild(waRow);
  wrap.appendChild(emRow);
  function modeBtn(channel, mode) {
    const btn = makeNode('', {
      attrs: {
        'data-inbox-autonomy': mode,
        'data-inbox-autonomy-channel': channel,
        'aria-pressed': 'false',
      },
      text: mode,
    });
    return btn;
  }
  const waDraft = modeBtn('whatsapp', 'draft');
  const waAuto = modeBtn('whatsapp', 'auto');
  const emDraft = modeBtn('email', 'draft');
  const emAuto = modeBtn('email', 'auto');
  waRow.appendChild(waDraft);
  waRow.appendChild(waAuto);
  emRow.appendChild(emDraft);
  emRow.appendChild(emAuto);
  const waSel = track(makeNode('inbox-shell-whatsapp-mode', { value: 'draft' }));
  const emSel = track(makeNode('inbox-shell-email-mode', { value: 'draft' }));
  wrap.appendChild(waSel);
  wrap.appendChild(emSel);
  const actions = makeNode('', { attrs: { 'data-wa-composer-actions': '' } });
  const save = track(makeNode('btn-save-draft', { text: 'Save draft' }));
  const del = track(makeNode('btn-delete-draft', { text: 'Delete draft' }));
  const send = track(makeNode('btn-send-reply', { text: 'Send reply' }));
  actions.appendChild(save);
  actions.appendChild(del);
  actions.appendChild(send);
  shell.appendChild(actions);
  const emailDel = track(makeNode('email-delete-draft', { text: 'Delete draft' }));
  emailDel.id = 'btn-delete-draft-email';
  const emailRow = makeNode('email-actions');
  emailRow.appendChild(emailDel);
  shell.appendChild(emailRow);
  const pause = track(makeNode('cc-luna-global-pause'));
  const pauseSw = makeNode('luna-global-pause-switch');
  pauseSw.type = 'checkbox';
  pauseSw.checked = false;
  pause.appendChild(pauseSw);
  shell.appendChild(pause);
  return { byId, shell, wrap, waSel, emSel, waAuto, waDraft, save, del, send, emailDel, actions, pause };
}

function loadFns(dom) {
  const store = {};
  const fetches = [];
  const document = {
    readyState: 'loading',
    getElementById(id) { return dom.byId[id] || null; },
    querySelector(sel) { return dom.shell.querySelector(sel); },
    querySelectorAll(sel) {
      if (sel === '[data-wa-composer-actions]') return dom.shell.querySelectorAll(sel);
      return dom.shell.querySelectorAll(sel);
    },
    addEventListener() {},
  };
  // querySelector on document should search from shell's parent-less tree.
  document.querySelector = (sel) => {
    if (matches(dom.shell, sel)) return dom.shell;
    return dom.shell.querySelector(sel);
  };
  document.querySelectorAll = (sel) => {
    const out = [];
    if (matches(dom.shell, sel)) out.push(dom.shell);
    dom.shell.querySelectorAll(sel).forEach((n) => out.push(n));
    return out;
  };
  function Event(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
  }
  const sandbox = {
    console,
    document,
    Event,
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    getClient: () => 'wolfhouse-somo',
    inboxClientQuery: () => '?client=wolfhouse-somo',
    t: (key) => key,
    escHtml: (s) => String(s),
    el: (id) => dom.byId[id] || null,
    fetch(url, opts) {
      fetches.push({ url: String(url), method: (opts && opts.method) || 'GET' });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          inbox_channel_modes: { whatsapp: dom.waSel.value, email: dom.emSel.value },
        }),
        json: async () => ({ success: true }),
      });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(WA, 'utf8') + '\n' + fs.readFileSync(SHELL, 'utf8') + '\n' +
    'this.inboxWhatsAppChannelIsAutomode = inboxWhatsAppChannelIsAutomode;\n' +
    'this.inboxWhatsAppDraftActionHiddenAttr = inboxWhatsAppDraftActionHiddenAttr;\n' +
    'this.inboxWhatsAppComposerSyncDraftActions = inboxWhatsAppComposerSyncDraftActions;\n' +
    'this.wireInboxShellChannelDefaults = wireInboxShellChannelDefaults;\n' +
    'this.inboxShellSyncAutonomyButtons = inboxShellSyncAutonomyButtons;\n' +
    'this.inboxShellSyncPauseChrome = inboxShellSyncPauseChrome;\n',
    sandbox,
  );
  return { sandbox, fetches };
}

function hidden(btn) {
  return !!(btn && (btn.hidden || btn.getAttribute('hidden') != null));
}

function clickAutonomy(dom, btn) {
  dom.wrap.dispatchEvent({ type: 'click', target: btn, bubbles: false });
}

function main() {
  console.log('\nverify-inbox-wa-automode-hide-drafts — hide Save/Delete when WA Auto\n');
  const thread = fs.readFileSync(THREAD, 'utf8');
  const wa = fs.readFileSync(WA, 'utf8');
  const shell = fs.readFileSync(SHELL, 'utf8');
  const api = fs.readFileSync(API, 'utf8');

  ok('thread paints WA actions with the automode hook',
    thread.includes('data-wa-composer-actions')
    && thread.includes('inboxWhatsAppDraftActionHiddenAttr')
    && thread.includes('id="btn-save-draft"')
    && thread.includes('id="btn-send-reply"'));
  ok('email Delete draft markup stays in the email composer',
    thread.includes('id="btn-delete-draft"')
    && thread.includes('id="btn-email-save-draft"'));
  ok('hide rule beats inline-flex in staff CSS', api.includes(HIDE_RULE));
  ok('hide rule is repeated in mockup CSS', shell.includes(HIDE_RULE));
  ok('shell syncs composer when autonomy buttons sync',
    shell.includes('inboxWhatsAppComposerSyncDraftActions()'));

  const dom = buildDom();
  const { sandbox } = loadFns(dom);
  sandbox.wireInboxShellChannelDefaults();

  ok('draft mode starts with Save, Delete, and Send',
    !sandbox.inboxWhatsAppChannelIsAutomode()
    && sandbox.inboxWhatsAppDraftActionHiddenAttr() === ''
    && !hidden(dom.save) && !hidden(dom.del) && !hidden(dom.send));

  clickAutonomy(dom, dom.waAuto);
  ok('Auto click sets the WhatsApp select', dom.waSel.value === 'auto');
  ok('Auto click hides Save draft', hidden(dom.save));
  ok('Auto click hides Delete draft', hidden(dom.del));
  ok('Auto click keeps Send reply', !hidden(dom.send) && dom.send.getAttribute('hidden') == null);
  ok('Auto click stamps the shell class', dom.shell.classList.contains('is-wa-automode'));
  ok('Auto click does not hide the email Delete draft', !hidden(dom.emailDel));
  ok('paint attr is hidden while Auto', sandbox.inboxWhatsAppDraftActionHiddenAttr() === ' hidden');

  clickAutonomy(dom, dom.waDraft);
  ok('Draft click shows Save draft again', !hidden(dom.save) && dom.waSel.value === 'draft');
  ok('Draft click shows Delete draft again', !hidden(dom.del));
  ok('Draft click still shows Send reply', !hidden(dom.send));
  ok('Draft click clears the shell class', !dom.shell.classList.contains('is-wa-automode'));

  dom.waSel.value = 'auto';
  dom.wrap.classList.add('is-paused');
  sandbox.inboxShellSyncAutonomyButtons();
  ok('Global Pause while stored Auto shows Save and Delete again',
    !sandbox.inboxWhatsAppChannelIsAutomode()
    && !hidden(dom.save) && !hidden(dom.del) && !hidden(dom.send)
    && !dom.shell.classList.contains('is-wa-automode'));

  dom.wrap.classList.remove('is-paused');
  sandbox.inboxShellSyncAutonomyButtons();
  ok('leaving Pause with WhatsApp still Auto hides them again',
    sandbox.inboxWhatsAppChannelIsAutomode() && hidden(dom.save) && hidden(dom.del) && !hidden(dom.send));

  dom.emSel.value = 'auto';
  dom.waSel.value = 'draft';
  sandbox.inboxShellSyncAutonomyButtons();
  ok('Email Auto does not hide WhatsApp Save/Delete',
    !hidden(dom.save) && !hidden(dom.del) && !hidden(dom.send));

  const css = playwrightCss();
  ok('computed style hides Save/Delete under Auto and keeps Send', css.ok, css.detail);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

function playwrightCss() {
  const pwRoot = '/opt/data/workspace/apply-proof-invoice-drop-payment-guest-names-001/node_modules';
  if (!fs.existsSync(path.join(pwRoot, 'playwright'))) {
    return { ok: false, detail: 'playwright missing' };
  }
  const htmlPath = path.join(ROOT, 'tmp-wa-automode-hide.html');
  const scriptPath = path.join(ROOT, 'tmp-wa-automode-hide-playwright.js');
  const html = `<!doctype html><style>
#inbox-shell .btn-save-draft,#inbox-shell .btn-delete-draft,#inbox-shell .btn-send-reply{display:inline-flex}
${HIDE_RULE}
</style>
<div id="inbox-shell">
  <button type="button" id="flip-auto">Auto</button>
  <div class="draft-actions" data-wa-composer-actions>
    <button type="button" class="btn-save-draft" id="btn-save-draft">Save draft</button>
    <button type="button" class="btn-delete-draft" id="btn-delete-draft">Delete draft</button>
    <button type="button" class="btn-send-reply" id="btn-send-reply">Send reply</button>
  </div>
  <div class="draft-actions" id="email-actions">
    <button type="button" class="btn-delete-draft" id="email-delete">Delete draft</button>
  </div>
</div>
<script>
document.getElementById('flip-auto').addEventListener('click', function(){
  document.getElementById('inbox-shell').classList.add('is-wa-automode');
});
</script>`;
  const runner = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('file://${htmlPath}');
  const before = await page.evaluate(() => ({
    save: getComputedStyle(document.querySelector('#btn-save-draft')).display,
    send: getComputedStyle(document.querySelector('#btn-send-reply')).display,
  }));
  await page.click('#flip-auto');
  const after = await page.evaluate(() => ({
    save: getComputedStyle(document.querySelector('#btn-save-draft')).display,
    del: getComputedStyle(document.querySelector('[data-wa-composer-actions] #btn-delete-draft')).display,
    send: getComputedStyle(document.querySelector('#btn-send-reply')).display,
    email: getComputedStyle(document.querySelector('#email-delete')).display,
    saveVisible: document.querySelector('#btn-save-draft').getClientRects().length,
    sendVisible: document.querySelector('#btn-send-reply').getClientRects().length,
  }));
  await browser.close();
  const ok = before.save === 'inline-flex' && before.send === 'inline-flex'
    && after.save === 'none' && after.del === 'none' && after.send === 'inline-flex'
    && after.email === 'inline-flex' && after.saveVisible === 0 && after.sendVisible > 0;
  console.log(JSON.stringify({ ok, before, after }));
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
`;
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(scriptPath, runner);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      NODE_PATH: pwRoot,
      PLAYWRIGHT_BROWSERS_PATH: '/opt/data/home/.cache/ms-playwright',
    }),
    encoding: 'utf8',
    timeout: 60000,
  });
  try { fs.unlinkSync(htmlPath); } catch (_e) {}
  try { fs.unlinkSync(scriptPath); } catch (_e) {}
  const text = ((result.stdout || '') + (result.stderr || '')).trim();
  if (result.status !== 0) return { ok: false, detail: text.slice(0, 500) };
  return { ok: true, detail: text };
}

main();
