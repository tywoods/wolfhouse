#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-clear-thread-001
 *
 * INBOX-CLEAR-THREAD-001 — Staff Inbox "Clear" for the selected conversation.
 *
 * Proves:
 *   - Cooked header order: Luna On/Off control, then label-exact `Clear`, then Refresh
 *   - Clear is a soft-red pebble (pill family), not a rectangular danger button
 *   - Confirm dialog: Cancel makes zero requests; Confirm POSTs the selected
 *     conversation to /staff/conversations/:id/clear-thread-session with client_slug
 *   - Overflow Reset Luna session keeps /reset-agent-session hard-delete
 *   - Modal a11y (focus, Escape, Tab trap, restore Clear focus)
 *   - Clear-dialog teardown before selected detail DOM replace/clear (no leaked
 *     capture listener; no focus on detached UI when switching/clearing)
 *   - UI operation token bound to conversationId+clientSlug (stale selection ignored)
 *   - Backend owner is conversation + client scoped; sibling same-phone bindings
 *     fail closed; needs_human clears only after Hermes session-key reset success
 *   - Hermes session-key path does not delete shared agent memories and does not
 *     delete a second same-phone session; ordinary lock-taking _ensure_loaded
 *     is never called while holding store._lock (production-shape, no deadlock)
 *   - Dev overflow Reset Luna session / Full Wipe stay; no second Luna toggle;
 *     no guest send
 *
 * No new dependencies. Recording pg + generated Inbox functions + Python session
 * fake runner. No production, no WhatsApp send.
 *
 * Run: node scripts/verify-inbox-clear-thread-001.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const SHELL = path.join(ROOT, 'scripts/browser/inbox-shell.js');
const LUNA_MODE = path.join(ROOT, 'scripts/browser/inbox-luna-mode.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const OWNER = path.join(ROOT, 'scripts/lib/staff-inbox-clear-thread.js');
const HERMES_JS = path.join(ROOT, 'scripts/lib/luna-hermes-guest-session-reset.js');
const HERMES_PY = path.join(ROOT, 'docker/hermes-staging/wolfhouse_guest_fresh_start.py');
const PY_GATE = path.join(ROOT, 'docker/hermes-staging/verify_inbox_clear_session_key.py');
const I18N = path.join(ROOT, 'scripts/lib/staff-portal-i18n.js');
const PKG = path.join(ROOT, 'package.json');
const LUNA_ALL = path.join(ROOT, 'scripts/verify-luna-all.js');

const CONV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CLIENT = 'sunset';

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

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (err) {
    return '';
  }
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

function sliceAsyncFn(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const nextAsync = src.indexOf('\nasync function ', start + 1);
  const nextFn = src.indexOf('\nfunction ', start + 1);
  let end = src.length;
  if (nextAsync > start) end = Math.min(end, nextAsync);
  if (nextFn > start) end = Math.min(end, nextFn);
  return src.slice(start, end);
}

let focusSink = null;

function loadOwner() {
  try {
    return require(OWNER);
  } catch (err) {
    return { __loadError: err && err.message };
  }
}

const T = {
  'inbox.detail.clearThread.button': 'Clear',
  'inbox.detail.clearThread.help': 'Reset Luna memory for this conversation only.',
  'inbox.detail.clearThread.title': 'Clear Luna session?',
  'inbox.detail.clearThread.body': 'This resets Luna memory for this conversation only. Messages, bookings, and payments stay.',
  'inbox.detail.clearThread.confirm': 'Clear',
  'common.cancel': 'Cancel',
  'inbox.detail.lunaMode.label': 'Luna',
  'inbox.detail.lunaMode.off': 'Off',
  'inbox.channelControl.on': 'On',
};

function miniNode(tag, attrs) {
  attrs = attrs || {};
  const children = [];
  const listeners = {};
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: attrs.id || '',
    className: attrs.className || '',
    textContent: attrs.textContent || '',
    innerHTML: attrs.innerHTML || '',
    hidden: !!attrs.hidden,
    disabled: false,
    dataset: Object.assign({}, attrs.dataset || {}),
    style: {},
    parentNode: null,
    children,
    attributes: {},
    setAttribute(k, v) {
      node.attributes[k] = String(v);
      if (k === 'id') node.id = String(v);
      if (k === 'aria-hidden') node.hidden = String(v) === 'true';
    },
    getAttribute(k) {
      if (k === 'id') return node.id;
      return node.attributes[k] || null;
    },
    appendChild(child) {
      if (!child) return child;
      if (child.parentNode && child.parentNode.children) {
        const sibs = child.parentNode.children;
        const i = sibs.indexOf(child);
        if (i >= 0) sibs.splice(i, 1);
      }
      child.parentNode = node;
      children.push(child);
      return child;
    },
    contains(child) {
      if (child === node) return true;
      return children.some((c) => c === child || (c.contains && c.contains(child)));
    },
    querySelector(sel) {
      const all = node.querySelectorAll(sel);
      return all[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      walk(node, (n) => {
        if (matchSel(n, sel)) out.push(n);
      });
      return out;
    },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    focus() {
      node._focused = true;
      if (typeof focusSink === 'function') focusSink(node);
    },
    click() {
      (listeners.click || []).forEach((fn) => fn({ type: 'click', target: node, preventDefault() {} }));
    },
    get lastChild() {
      return children.length ? children[children.length - 1] : null;
    },
  };
  node.classList = {
    add(c) {
      const cur = String(node.className || '').split(/\s+/).filter(Boolean);
      if (cur.indexOf(c) < 0) cur.push(c);
      node.className = cur.join(' ');
    },
    remove(c) {
      node.className = String(node.className || '').split(/\s+/).filter((x) => x && x !== c).join(' ');
    },
    contains(c) {
      return String(node.className || '').split(/\s+/).indexOf(c) >= 0;
    },
  };
  return node;
}

function walk(node, visit) {
  visit(node);
  (node.children || []).forEach((c) => walk(c, visit));
}

function matchSel(node, sel) {
  if (!sel) return false;
  if (sel.charAt(0) === '#') return node.id === sel.slice(1);
  if (sel.charAt(0) === '.') return String(node.className || '').split(/\s+/).indexOf(sel.slice(1)) >= 0;
  return node.tagName === String(sel).toUpperCase();
}

function loadThreadFns() {
  const fetches = [];
  const alerts = [];
  const byId = {};
  const docListeners = {};
  const doc = {
    activeElement: null,
    getElementById(id) {
      return byId[id] || null;
    },
    querySelector(sel) {
      if (sel.charAt(0) === '#') return byId[sel.slice(1)] || null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return miniNode(tag);
    },
    addEventListener(type, fn) {
      (docListeners[type] || (docListeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    __fireKey(ev) {
      (docListeners.keydown || []).slice().forEach((fn) => fn(ev));
    },
  };
  focusSink = (n) => { doc.activeElement = n; };
  const sandbox = {
    t: (key) => T[key] || key,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    getClient: () => CLIENT,
    selectedConvId: CONV_A,
    fetch: (url, opts) => {
      fetches.push({ url, opts: opts || {} });
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({
          success: true,
          hermes_session_reset: { ok: true, deleted_count: 1, scope: 'session_key' },
        }),
      });
    },
    document: doc,
    window: { confirm() { throw new Error('window.confirm must not be used for Inbox Clear'); } },
    alert(msg) { alerts.push(String(msg == null ? '' : msg)); },
    el(id) { return doc.getElementById(id); },
    inboxEmptyDetailHtml() { return '<div class="inbox-empty-right"></div>'; },
    hideInboxMobileThread() {},
    console,
  };
  sandbox.window.fetch = sandbox.fetch;
  vm.createContext(sandbox);
  const src = read(THREAD);
  try {
    vm.runInContext(
      `${src}\n` +
      'this.inboxClearThreadButtonHtml = inboxClearThreadButtonHtml;\n' +
      'this.inboxClearThreadDialogHtml = inboxClearThreadDialogHtml;\n' +
      'this.inboxCookSelectedConversationHeaderActions = inboxCookSelectedConversationHeaderActions;\n' +
      'this.wireInboxClearThread = wireInboxClearThread;\n' +
      'this.inboxAdoptRefreshToHeader = inboxAdoptRefreshToHeader;\n' +
      'this.inboxSetClearThreadDialogOpen = inboxSetClearThreadDialogOpen;\n' +
      'this.inboxClearThreadOpToken = inboxClearThreadOpToken;\n' +
      'this.inboxClearThreadCurrentToken = inboxClearThreadCurrentToken;\n' +
      'this.inboxClearThreadTrapKeydown = inboxClearThreadTrapKeydown;\n' +
      'this.inboxClearThreadFocusables = inboxClearThreadFocusables;\n' +
      'this.inboxTeardownClearThreadDialog = inboxTeardownClearThreadDialog;\n' +
      'this.inboxClearThreadDialogState = inboxClearThreadDialogState;\n' +
      'this.beginConvDetailLoad = beginConvDetailLoad;\n' +
      'this.clearInboxSelection = clearInboxSelection;\n',
      sandbox,
    );
  } catch (err) {
    sandbox.__runError = err && err.message;
  }
  sandbox.__fetches = fetches;
  sandbox.__alerts = alerts;
  sandbox.__byId = byId;
  sandbox.__doc = doc;
  sandbox.__docListeners = docListeners;
  return sandbox;
}

function makeRecordingPg(seed) {
  const convs = (seed.conversations || []).map((r) => Object.assign({}, r));
  const messages = (seed.messages || []).map((r) => Object.assign({}, r));
  const bookings = (seed.bookings || []).map((r) => Object.assign({}, r));
  const payments = (seed.payments || []).map((r) => Object.assign({}, r));
  const customers = (seed.customers || []).map((r) => Object.assign({}, r));
  const calls = [];
  return {
    convs, messages, bookings, payments, customers, calls,
    async query(sql, params) {
      const s = String(sql);
      const p = params ? [...params] : [];
      calls.push({ sql: s, params: p });
      if (/\bDELETE\b/i.test(s)) {
        const err = new Error('forbidden_delete: ' + s.split('\n')[0]);
        err.code = 'FORBIDDEN_DELETE';
        throw err;
      }
      if (/SELECT[\s\S]*FROM conversations conv[\s\S]*JOIN clients/i.test(s)
        && /conv\.id = \$2::uuid/i.test(s)
        && !/regexp_replace/i.test(s)
        && !/\bUPDATE\b/i.test(s)) {
        const slug = p[0];
        const id = p[1];
        const row = convs.find((c) => c.id === id && c.client_slug === slug);
        return { rows: row ? [Object.assign({ conversation_id: row.id }, row)] : [] };
      }
      if (/regexp_replace/i.test(s) && /SELECT/i.test(s) && !/\bUPDATE\b/i.test(s)) {
        const digits = p[0];
        const id = p[1];
        const rows = convs.filter((c) => c.digits === digits && c.id !== id).map((c) => ({
          conversation_id: c.id,
          client_slug: c.client_slug,
        }));
        return { rows };
      }
      if (/\bUPDATE conversations conv\b/i.test(s) && /needs_human = FALSE/i.test(s)) {
        const slug = p[0];
        const id = p[1];
        const row = convs.find((c) => c.id === id && c.client_slug === slug);
        if (!row) return { rows: [] };
        row.needs_human = false;
        return { rows: [{ conversation_id: row.id, needs_human: false }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\nverify:inbox-clear-thread-001 — selected-thread Clear\n');

  const threadSrc = read(THREAD);
  const shellSrc = read(SHELL);
  const lunaSrc = read(LUNA_MODE);
  const apiSrc = read(API);
  const hermesJs = read(HERMES_JS);
  const hermesPy = read(HERMES_PY);
  const i18nSrc = read(I18N);
  const pkg = JSON.parse(read(PKG) || '{}');
  const lunaAllSrc = read(LUNA_ALL);

  console.log('[1] Generated header: Luna, then Clear, then Refresh');
  const loadFn = sliceFn(threadSrc, 'loadConvDetail');
  const cookFn = sliceFn(threadSrc, 'inboxCookSelectedConversationHeaderActions');
  ok('Clear button helper exists', /function inboxClearThreadButtonHtml\(/.test(threadSrc));
  ok('successful Clear visibly replaces old bubbles with an explicit cleared state',
    /getElementById\('thread-container'\)/.test(threadSrc)
    && /thread\.innerHTML = .*Conversation cleared/.test(threadSrc));
  ok('header luna row includes Clear button html',
    /inboxClearThreadButtonHtml\(/.test(loadFn) || /id="btn-inbox-clear-thread"/.test(loadFn));
  ok('cooked order appends chrome then Clear then Refresh',
    /inbox-chat-chrome-slot/.test(cookFn)
    && /btn-inbox-clear-thread/.test(cookFn)
    && /inboxRefreshBtn|btn-refresh/.test(cookFn)
    && cookFn.indexOf('inbox-chat-chrome-slot') < cookFn.indexOf('btn-inbox-clear-thread')
    && cookFn.indexOf('btn-inbox-clear-thread') < Math.max(cookFn.indexOf('inboxRefreshBtn'), cookFn.indexOf('btn-refresh')));
  ok('CSS order is luna chrome, Clear, Refresh',
    /\.inbox-header-stack-luna \.inbox-chat-chrome-slot\{[^}]*order:\s*1/.test(apiSrc)
    && /#btn-inbox-clear-thread\{[^}]*order:\s*2/.test(apiSrc)
    && /\.inbox-header-stack-luna #btn-refresh\{[^}]*order:\s*3/.test(apiSrc));
  ok('English label is exactly Clear',
    /'inbox\.detail\.clearThread\.button': 'Clear'/.test(i18nSrc));

  const ui = loadThreadFns();
  ok('thread module loads Clear helpers',
    typeof ui.inboxClearThreadButtonHtml === 'function'
    && typeof ui.inboxCookSelectedConversationHeaderActions === 'function'
    && typeof ui.wireInboxClearThread === 'function',
    ui.__runError || 'helpers missing');

  if (typeof ui.inboxClearThreadButtonHtml === 'function') {
    const btnHtml = ui.inboxClearThreadButtonHtml();
    ok('generated button text is exactly Clear', />Clear</.test(btnHtml) && /id="btn-inbox-clear-thread"/.test(btnHtml));
    ok('Clear uses pill pebble class family',
      /class="[^"]*\bpill\b/.test(btnHtml) && /inbox-clear-thread-btn/.test(btnHtml));
    ok('Clear is not a danger/rectangular class',
      !/btn-danger|btn-error|danger-btn/.test(btnHtml));
  } else {
    ok('generated button text is exactly Clear', false, 'helper missing');
    ok('Clear uses pill pebble class family', false, 'helper missing');
    ok('Clear is not a danger/rectangular class', false, 'helper missing');
  }

  const pebbleCss = (apiSrc + '\n' + shellSrc);
  ok('soft-red pebble tokens (paused-luna family, pill radius)',
    /#btn-inbox-clear-thread|inbox-clear-thread-btn/.test(pebbleCss)
    && /#F8E8E8|#E8C4C4|#E8B4B4/.test(pebbleCss)
    && /#9C3D3D|#8B4A3A/.test(pebbleCss)
    && /radius-pill|border-radius:\s*999px/.test(pebbleCss));
  ok('not a harsh rectangular danger button',
    !/\.inbox-clear-thread-btn\{[^}]*border-radius:\s*[0-4]px/.test(pebbleCss)
    && !/\.inbox-clear-thread-btn\{[^}]*background:\s*#(c00|dc2626|b91c1c|ef4444)/i.test(pebbleCss));

  if (typeof ui.inboxCookSelectedConversationHeaderActions === 'function') {
    const row = miniNode('div', { id: 'inbox-header-luna-row' });
    const refresh = miniNode('button', { id: 'btn-refresh', textContent: '↻' });
    const clearBtn = miniNode('button', { id: 'btn-inbox-clear-thread', textContent: 'Clear' });
    const chrome = miniNode('div', { id: 'inbox-chat-chrome-slot' });
    const luna = miniNode('div', { className: 'inbox-luna-mode' });
    chrome.appendChild(luna);
    row.appendChild(clearBtn);
    ui.__byId['inbox-header-luna-row'] = row;
    ui.__byId['inbox-chat-chrome-slot'] = chrome;
    ui.__byId['btn-inbox-clear-thread'] = clearBtn;
    ui.__byId['btn-refresh'] = refresh;
    ui.document.getElementById = (id) => ui.__byId[id] || null;
    ui.inboxCookSelectedConversationHeaderActions();
    const ids = row.children.map((c) => c.id);
    ok('cooked DOM order is chrome, Clear, Refresh',
      ids[0] === 'inbox-chat-chrome-slot'
      && ids[1] === 'btn-inbox-clear-thread'
      && ids[2] === 'btn-refresh',
      JSON.stringify(ids));
    ok('chrome still holds the single Luna control',
      chrome.querySelector('.inbox-luna-mode')
      && row.children.filter((c) => c.id === 'inbox-chat-chrome-slot').length === 1);
  } else {
    ok('cooked DOM order is chrome, Clear, Refresh', false, 'cook helper missing');
    ok('chrome still holds the single Luna control', false, 'cook helper missing');
  }

  console.log('\n[2] Confirm dialog: cancel zero requests; confirm exact endpoint');
  ok('bounded dialog helper exists', /function inboxClearThreadDialogHtml\(/.test(threadSrc));
  ok('Clear does not use window.confirm',
    /function wireInboxClearThread\(/.test(threadSrc)
    && !/window\.confirm\(/.test(sliceFn(threadSrc, 'wireInboxClearThread')));
  ok('loadConvDetail wires Inbox Clear and keeps overflow reset/wipe',
    /wireInboxClearThread\s*\(/.test(threadSrc)
    && /wireAgentSessionReset\s*\(/.test(threadSrc)
    && /wireFreshStart\s*\(/.test(threadSrc)
    && /btn-agent-session-reset/.test(threadSrc)
    && /btn-guest-context-reset/.test(threadSrc)
    && /Reset Luna session/.test(threadSrc)
    && /Full Wipe \(testing\)/.test(threadSrc));

  if (typeof ui.wireInboxClearThread === 'function' && typeof ui.inboxClearThreadDialogHtml === 'function') {
    const root = miniNode('div');
    const btn = miniNode('button', { id: 'btn-inbox-clear-thread', textContent: 'Clear' });
    const dialog = miniNode('div', { id: 'inbox-clear-thread-dialog', hidden: true });
    const cancel = miniNode('button', { id: 'inbox-clear-thread-dialog-cancel', textContent: 'Cancel' });
    const confirm = miniNode('button', { id: 'inbox-clear-thread-dialog-confirm', textContent: 'Clear' });
    const backdrop = miniNode('div', { id: 'inbox-clear-thread-dialog-cancel-backdrop' });
    root.appendChild(btn);
    root.appendChild(dialog);
    dialog.appendChild(backdrop);
    dialog.appendChild(cancel);
    dialog.appendChild(confirm);
    ui.__byId['btn-inbox-clear-thread'] = btn;
    ui.__byId['inbox-clear-thread-dialog'] = dialog;
    ui.__byId['inbox-clear-thread-dialog-cancel'] = cancel;
    ui.__byId['inbox-clear-thread-dialog-confirm'] = confirm;
    ui.__byId['inbox-clear-thread-dialog-cancel-backdrop'] = backdrop;
    root.querySelector = (sel) => {
      if (sel === '#btn-inbox-clear-thread') return btn;
      if (sel === '#inbox-clear-thread-dialog') return dialog;
      return null;
    };
    ui.document.getElementById = (id) => ui.__byId[id] || null;
    ui.__fetches.length = 0;
    ui.wireInboxClearThread(CONV_A, root);
    btn.click();
    ok('opening dialog makes zero requests', ui.__fetches.length === 0, JSON.stringify(ui.__fetches));
    ok('dialog is shown on Clear click', dialog.hidden === false);
    cancel.click();
    ok('Cancel makes zero requests', ui.__fetches.length === 0, JSON.stringify(ui.__fetches));
    ok('Cancel hides the dialog', dialog.hidden === true);
    btn.click();
    confirm.click();
    await Promise.resolve();
    await Promise.resolve();
    ok('Confirm makes exactly one request', ui.__fetches.length === 1, JSON.stringify(ui.__fetches));
    const req = ui.__fetches[0] || {};
    const body = req.opts && req.opts.body ? JSON.parse(req.opts.body) : {};
    ok('Confirm POSTs clear-thread-session for the selected conversation id',
      req.opts && req.opts.method === 'POST'
      && req.url === '/staff/conversations/' + CONV_A + '/clear-thread-session');
    ok('Confirm body is client-scoped',
      body.client_slug === CLIENT
      && !body.hard_delete);
    ok('Confirm does not call reset-agent-session, reset-luna-context or Full Wipe',
      !/reset-agent-session|reset-luna-context/.test(req.url || '')
      && ui.__fetches.every((f) => !/reset-agent-session|reset-luna-context|clear-messages/.test(f.url)));
  } else {
    ok('opening dialog makes zero requests', false, 'wire helper missing');
    ok('dialog is shown on Clear click', false, 'wire helper missing');
    ok('Cancel makes zero requests', false, 'wire helper missing');
    ok('Cancel hides the dialog', false, 'wire helper missing');
    ok('Confirm makes exactly one request', false, 'wire helper missing');
    ok('Confirm POSTs clear-thread-session for the selected conversation id', false, 'wire helper missing');
    ok('Confirm body is client-scoped', false, 'wire helper missing');
    ok('Confirm does not call reset-agent-session, reset-luna-context or Full Wipe', false, 'wire helper missing');
  }

  console.log('\n[3] Backend owner: thread-only, needs_human after Hermes success');
  const owner = loadOwner();
  ok('staff-inbox-clear-thread owner module loads', !owner.__loadError, owner.__loadError);
  ok('owner exports perform + binding + needs_human clear',
    owner && typeof owner.performInboxClearThreadReset === 'function'
    && typeof owner.lookupInboxClearThreadBinding === 'function'
    && typeof owner.clearInboxClearThreadNeedsHuman === 'function');

  if (typeof owner.performInboxClearThreadReset === 'function') {
    const seed = {
      conversations: [
        {
          id: CONV_A, conversation_id: CONV_A, client_slug: CLIENT, phone: '+34600000001',
          digits: '34600000001', needs_human: true, display_name: 'Ana', status: 'open',
          email: 'ana@example.test', guest_id: 'g-a', customer_id: 'c-a',
        },
        {
          id: CONV_B, conversation_id: CONV_B, client_slug: CLIENT, phone: '+34600000002',
          digits: '34600000002', needs_human: true, display_name: 'Bea', status: 'open',
          email: 'bea@example.test', guest_id: 'g-b', customer_id: 'c-b',
        },
      ],
      messages: [
        { id: 'm1', conversation_id: CONV_A, message_text: 'hello' },
        { id: 'm2', conversation_id: CONV_B, message_text: 'other' },
      ],
      bookings: [
        { id: 'b1', conversation_id: CONV_A, code: 'SUN-1' },
        { id: 'b2', conversation_id: CONV_B, code: 'SUN-2' },
      ],
      payments: [{ id: 'p1', booking_id: 'b1', amount_cents: 5000 }],
      customers: [{ id: 'c-a', phone: '+34600000001' }, { id: 'c-b', phone: '+34600000002' }],
    };

    const pg = makeRecordingPg(seed);
    const hermesCalls = [];
    const out = await owner.performInboxClearThreadReset({
      pg,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async (phone, opts) => {
        hermesCalls.push({ phone, opts: opts || {} });
        return { attempted: true, ok: true, scope: 'session_key', session_key: 'whatsapp_cloud:dm:34600000001' };
      },
    });
    ok('happy path ok', out && out.ok === true && out.found === true, JSON.stringify(out));
    ok('Hermes called once with selected phone + conversation id',
      hermesCalls.length === 1
      && hermesCalls[0].phone === '+34600000001'
      && hermesCalls[0].opts.conversation_id === CONV_A);
    ok('needs_human cleared only after Hermes success',
      out.needs_human_cleared === true
      && pg.convs.find((c) => c.id === CONV_A).needs_human === false);
    ok('other conversation needs_human preserved',
      pg.convs.find((c) => c.id === CONV_B).needs_human === true);
    ok('messages/bookings/payments/customers/identity not mutated',
      pg.messages.length === 2 && pg.messages[0].message_text === 'hello'
      && pg.bookings.length === 2 && pg.bookings[0].code === 'SUN-1'
      && pg.payments[0].amount_cents === 5000
      && pg.customers.length === 2
      && pg.convs[0].id === CONV_A && pg.convs[0].phone === '+34600000001'
      && pg.convs[0].display_name === 'Ana' && pg.convs[0].status === 'open');
    ok('owner SQL is client+conversation scoped (no other-thread UPDATE)',
      pg.calls.filter((c) => /\bUPDATE\b/i.test(c.sql)).every((c) =>
        c.params[0] === CLIENT && c.params[1] === CONV_A));

    const pgFail = makeRecordingPg(seed);
    pgFail.convs.find((c) => c.id === CONV_A).needs_human = true;
    const hermesFail = [];
    const failed = await owner.performInboxClearThreadReset({
      pg: pgFail,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async (phone, opts) => {
        hermesFail.push({ phone, opts });
        return { attempted: true, ok: false, reason: 'gateway_not_ready' };
      },
    });
    ok('Hermes failure does not clear needs_human',
      failed && failed.ok === false
      && pgFail.convs.find((c) => c.id === CONV_A).needs_human === true
      && failed.needs_human_cleared !== true);

    const sharedSeed = {
      conversations: [
        {
          id: CONV_A, client_slug: CLIENT, phone: '+34600000001', digits: '34600000001',
          needs_human: true, display_name: 'Ana', status: 'open',
        },
        {
          id: CONV_B, client_slug: 'wolfhouse-somo', phone: '34600000001', digits: '34600000001',
          needs_human: true, display_name: 'Other tenant', status: 'open',
        },
      ],
      messages: [{ id: 'm1', conversation_id: CONV_A, message_text: 'hello' }],
      bookings: [],
      payments: [],
      customers: [],
    };
    const pgShared = makeRecordingPg(sharedSeed);
    const hermesShared = [];
    const shared = await owner.performInboxClearThreadReset({
      pg: pgShared,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async (phone, opts) => {
        hermesShared.push({ phone, opts });
        return { attempted: true, ok: true, scope: 'session_key' };
      },
    });
    ok('same-phone sibling fails closed (no Hermes, no needs_human clear)',
      shared && shared.ok === false
      && shared.reason === 'shared_session_binding'
      && hermesShared.length === 0
      && pgShared.convs.find((c) => c.id === CONV_A).needs_human === true
      && pgShared.convs.find((c) => c.id === CONV_B).needs_human === true,
      JSON.stringify(shared));
  } else {
    ok('happy path ok', false, 'owner missing');
    ok('Hermes called once with selected phone + conversation id', false, 'owner missing');
    ok('needs_human cleared only after Hermes success', false, 'owner missing');
    ok('other conversation needs_human preserved', false, 'owner missing');
    ok('messages/bookings/payments/customers/identity not mutated', false, 'owner missing');
    ok('owner SQL is client+conversation scoped (no other-thread UPDATE)', false, 'owner missing');
    ok('Hermes failure does not clear needs_human', false, 'owner missing');
    ok('same-phone sibling fails closed (no Hermes, no needs_human clear)', false, 'owner missing');
  }

  console.log('\n[4] Staff handler + Hermes session-key path');
  const resetHandler = sliceAsyncFn(apiSrc, 'handleConversationResetAgentSession');
  const clearHandler = sliceAsyncFn(apiSrc, 'handleConversationClearThreadSession');
  const wireReset = sliceFn(threadSrc, 'wireAgentSessionReset');
  const wireClear = sliceFn(threadSrc, 'wireInboxClearThread');
  const convResetFn = sliceFn(hermesJs, 'resetHermesConversationSession');
  const guestResetFn = sliceFn(hermesJs, 'resetHermesGuestSession');
  const freshStartHandler = hermesPy.includes('async def _handle_guest_fresh_start')
    && hermesPy.includes('async def _handle_guest_session_key_reset')
    ? hermesPy.slice(
      hermesPy.indexOf('async def _handle_guest_fresh_start'),
      hermesPy.indexOf('async def _handle_guest_session_key_reset'),
    )
    : '';
  ok('overflow Reset Luna session handler is still hard-delete',
    /resetHermesGuestSession\(/.test(resetHandler)
    && /hard_delete:\s*true/.test(resetHandler)
    && !/performInboxClearThreadReset/.test(resetHandler),
    resetHandler ? 'reset-agent-session handler changed' : 'reset handler missing');
  ok('overflow UI still POSTs reset-agent-session',
    /reset-agent-session/.test(wireReset)
    && !/clear-thread-session/.test(wireReset));
  ok('Clear uses a distinct Staff route',
    /CONV_CLEAR_THREAD_RE/.test(apiSrc)
    && /clear-thread-session/.test(apiSrc)
    && /performInboxClearThreadReset\s*\(/.test(clearHandler)
    && !/hard_delete:\s*true/.test(clearHandler)
    && /clear-thread-session/.test(wireClear)
    && !/reset-agent-session/.test(wireClear));
  ok('Clear handler keeps staging + client access fences',
    /isStagingResetEnvironment/.test(clearHandler)
    && /assertStaffClientAccess/.test(clearHandler));
  ok('Clear handler maps status via owner',
    /mapInboxClearThreadHttpStatus/.test(clearHandler));
  ok('Full Wipe still uses reset-luna-context + hard_delete',
    /function handleConversationResetLunaContext\(/.test(apiSrc)
    && /reset-luna-context/.test(apiSrc)
    && /hard_delete:\s*true/.test(sliceAsyncFn(apiSrc, 'handleConversationResetLunaContext')));
  ok('JS Clear client posts to distinct session-key route (not fresh-start)',
    /function resetHermesConversationSession\(/.test(hermesJs)
    && /function hermesSessionKeyResetUrl\(/.test(hermesJs)
    && /guest-session-key-reset/.test(hermesJs)
    && /hermesSessionKeyResetUrl\(/.test(convResetFn)
    && !/hermesFreshStartUrl\(/.test(convResetFn)
    && !/hard_delete:\s*true/.test(convResetFn)
    && /conversation_id: opts\.conversation_id/.test(convResetFn));
  ok('legacy phone hard_delete helper remains for Full Wipe / overflow compatibility',
    /function resetHermesGuestSession\(/.test(hermesJs)
    && /guest-fresh-start/.test(guestResetFn)
    && /hard_delete/.test(guestResetFn));
  ok('Python session-key reset exists and does not call shared memory deletion',
    /def reset_session_key_only\(/.test(hermesPy)
    && !/clear_luna_agent_memories\(/.test(
      hermesPy.slice(hermesPy.indexOf('def reset_session_key_only'), hermesPy.indexOf('def reset_guest_session')),
    )
    && !/_list_whatsapp_session_ids\(/.test(
      hermesPy.slice(hermesPy.indexOf('def reset_session_key_only'), hermesPy.indexOf('def reset_guest_session')),
    ));
  ok('fresh-start route is unchanged hard-delete; Clear is a distinct Hermes route',
    /reset_guest_session\(/.test(freshStartHandler)
    && !/reset_session_key_only\(/.test(freshStartHandler)
    && !/\bscope\b/.test(freshStartHandler)
    && /SESSION_KEY_RESET_PATH/.test(hermesPy)
    && /guest-session-key-reset/.test(hermesPy)
    && /delete_guest_agent_sessions\(/.test(hermesPy));

  if (fs.existsSync(PY_GATE)) {
    const py = spawnSync('python3', [PY_GATE], { encoding: 'utf8', cwd: ROOT });
    ok('python session-key isolation gate', py.status === 0, (py.stdout || '') + (py.stderr || ''));
    if (py.stdout) process.stdout.write(py.stdout);
    if (py.status !== 0 && py.stderr) process.stderr.write(py.stderr);
  } else {
    ok('python session-key isolation gate', false, 'verify_inbox_clear_session_key.py missing');
  }

  console.log('\n[5] needs_human unconditional re-read; never synthesize false');
  if (typeof owner.performInboxClearThreadReset === 'function') {
    const seedAlready = {
      conversations: [{
        id: CONV_A, conversation_id: CONV_A, client_slug: CLIENT, phone: '+34600000001',
        digits: '34600000001', needs_human: false, display_name: 'Ana', status: 'open',
      }],
    };
    const pgAlready = makeRecordingPg(seedAlready);
    const already = await owner.performInboxClearThreadReset({
      pg: pgAlready,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async () => ({ attempted: true, ok: true }),
    });
    ok('needs_human is cleared unconditionally after Hermes success (already false still UPDATEs)',
      already && already.ok === true
      && already.needs_human_cleared === true
      && already.needs_human === false
      && pgAlready.calls.some((c) => /\bUPDATE conversations conv\b/i.test(c.sql)
        && c.params[0] === CLIENT && c.params[1] === CONV_A)
      && pgAlready.calls.some((c) => /SELECT conv\.id::text AS conversation_id/.test(c.sql)
        && /conv\.needs_human/.test(c.sql)
        && !/\bUPDATE\b/i.test(c.sql)
        && c.params && c.params[1] === CONV_A),
      JSON.stringify(already));

    const seedNoRow = {
      conversations: [{
        id: CONV_A, conversation_id: CONV_A, client_slug: CLIENT, phone: '+34600000001',
        digits: '34600000001', needs_human: true, display_name: 'Ana', status: 'open',
      }],
    };
    const pgNoRow = makeRecordingPg(seedNoRow);
    const origNoRow = pgNoRow.query.bind(pgNoRow);
    pgNoRow.query = async (sql, params) => {
      if (/\bUPDATE conversations conv\b/i.test(sql)) return { rows: [] };
      return origNoRow(sql, params);
    };
    const noRow = await owner.performInboxClearThreadReset({
      pg: pgNoRow,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async () => ({ attempted: true, ok: true }),
    });
    ok('UPDATE no-row is partial failure and does not synthesize needs_human false',
      noRow && noRow.ok === false
      && noRow.partial === true
      && noRow.reason === 'needs_human_clear_failed'
      && noRow.needs_human === true
      && noRow.needs_human_cleared !== true
      && noRow.hermes_session_reset && noRow.hermes_session_reset.ok === true,
      JSON.stringify(noRow));

    const seedThrow = {
      conversations: [{
        id: CONV_A, conversation_id: CONV_A, client_slug: CLIENT, phone: '+34600000001',
        digits: '34600000001', needs_human: true, display_name: 'Ana', status: 'open',
      }],
    };
    const pgThrow = makeRecordingPg(seedThrow);
    const origThrow = pgThrow.query.bind(pgThrow);
    pgThrow.query = async (sql, params) => {
      if (/\bUPDATE conversations conv\b/i.test(sql)) throw new Error('deadlock');
      return origThrow(sql, params);
    };
    const threw = await owner.performInboxClearThreadReset({
      pg: pgThrow,
      clientSlug: CLIENT,
      convId: CONV_A,
      resetHermesConversationSession: async () => ({ attempted: true, ok: true }),
    });
    ok('UPDATE throw is partial failure and keeps snapshot needs_human',
      threw && threw.ok === false
      && threw.partial === true
      && threw.reason === 'needs_human_clear_failed'
      && threw.needs_human === true
      && threw.needs_human_cleared !== true,
      JSON.stringify(threw));
  } else {
    ok('needs_human is cleared unconditionally after Hermes success (already false still UPDATEs)', false, 'owner missing');
    ok('UPDATE no-row is partial failure and does not synthesize needs_human false', false, 'owner missing');
    ok('UPDATE throw is partial failure and keeps snapshot needs_human', false, 'owner missing');
  }

  console.log('\n[6] HTTP mapping: 409/400 retained, Hermes 502/503, post-reset DB 500');
  if (typeof owner.mapInboxClearThreadHttpStatus === 'function') {
    const map = owner.mapInboxClearThreadHttpStatus;
    ok('409 shared-session ambiguity', map({ found: true, ok: false, reason: 'shared_session_binding' }) === 409);
    ok('400 unsupported channel', map({ found: true, ok: false, reason: 'not_whatsapp_session' }) === 400);
    ok('503 Hermes unavailable (gateway_not_ready)', map({
      found: true, ok: false, reason: 'gateway_not_ready',
      hermes_session_reset: { attempted: true, ok: false, reason: 'gateway_not_ready' },
    }) === 503);
    ok('503 Hermes unavailable (missing_bot_token)', map({
      found: true, ok: false, reason: 'missing_bot_token',
      hermes_session_reset: { attempted: false, ok: false, reason: 'missing_bot_token' },
    }) === 503);
    ok('503 Hermes network failure', map({
      found: true, ok: false, reason: 'fetch failed',
      hermes_session_reset: { attempted: true, ok: false, reason: 'fetch failed' },
    }) === 503);
    ok('502 Hermes upstream HTTP failure', map({
      found: true, ok: false, reason: 'http_502',
      hermes_session_reset: { attempted: true, ok: false, status: 502, reason: 'http_502' },
    }) === 502);
    ok('500 post-reset needs_human DB failure', map({
      found: true, ok: false, partial: true, reason: 'needs_human_clear_failed',
      hermes_session_reset: { attempted: true, ok: true },
    }) === 500);
    ok('200 success', map({ found: true, ok: true }) === 200);
    ok('Clear handler uses mapped status not a 200-on-failure',
      /sendJSON\(res, status/.test(clearHandler)
      && !/result\.reason === 'shared_session_binding' \? 409/.test(clearHandler));
  } else {
    ok('409 shared-session ambiguity', false, 'mapper missing');
    ok('400 unsupported channel', false, 'mapper missing');
    ok('503 Hermes unavailable (gateway_not_ready)', false, 'mapper missing');
    ok('503 Hermes unavailable (missing_bot_token)', false, 'mapper missing');
    ok('503 Hermes network failure', false, 'mapper missing');
    ok('502 Hermes upstream HTTP failure', false, 'mapper missing');
    ok('500 post-reset needs_human DB failure', false, 'mapper missing');
    ok('200 success', false, 'mapper missing');
    ok('Clear handler uses mapped status not a 200-on-failure', false, 'mapper missing');
  }

  console.log('\n[7] Modal accessibility: initial focus, Escape, Tab trap, restore Clear');
  if (typeof ui.wireInboxClearThread === 'function') {
    const a11y = loadThreadFns();
    const aRoot = miniNode('div');
    const aBtn = miniNode('button', { id: 'btn-inbox-clear-thread', textContent: 'Clear' });
    const aDialog = miniNode('div', { id: 'inbox-clear-thread-dialog', hidden: true });
    const aCancel = miniNode('button', { id: 'inbox-clear-thread-dialog-cancel', textContent: 'Cancel' });
    const aConfirm = miniNode('button', { id: 'inbox-clear-thread-dialog-confirm', textContent: 'Clear' });
    const aBackdrop = miniNode('div', { id: 'inbox-clear-thread-dialog-cancel-backdrop' });
    aRoot.appendChild(aBtn);
    aRoot.appendChild(aDialog);
    aDialog.appendChild(aBackdrop);
    aDialog.appendChild(aCancel);
    aDialog.appendChild(aConfirm);
    a11y.__byId['btn-inbox-clear-thread'] = aBtn;
    a11y.__byId['inbox-clear-thread-dialog'] = aDialog;
    a11y.__byId['inbox-clear-thread-dialog-cancel'] = aCancel;
    a11y.__byId['inbox-clear-thread-dialog-confirm'] = aConfirm;
    a11y.__byId['inbox-clear-thread-dialog-cancel-backdrop'] = aBackdrop;
    aRoot.querySelector = (sel) => {
      if (sel === '#btn-inbox-clear-thread') return aBtn;
      if (sel === '#inbox-clear-thread-dialog') return aDialog;
      return null;
    };
    a11y.document.getElementById = (id) => a11y.__byId[id] || null;
    a11y.wireInboxClearThread(CONV_A, aRoot);
    aBtn.click();
    ok('opening focuses the initial control (Cancel)',
      a11y.document.activeElement === aCancel, String((a11y.document.activeElement && a11y.document.activeElement.id) || ''));
    a11y.document.activeElement = aCancel;
    a11y.document.__fireKey({
      key: 'Tab', shiftKey: true, preventDefault() { this._pd = true; }, stopPropagation() {},
    });
    ok('Shift+Tab from first control wraps to last (Confirm)',
      a11y.document.activeElement === aConfirm, String((a11y.document.activeElement && a11y.document.activeElement.id) || ''));
    a11y.document.activeElement = aConfirm;
    a11y.document.__fireKey({
      key: 'Tab', shiftKey: false, preventDefault() { this._pd = true; }, stopPropagation() {},
    });
    ok('Tab from last control wraps to first (Cancel)',
      a11y.document.activeElement === aCancel, String((a11y.document.activeElement && a11y.document.activeElement.id) || ''));
    a11y.document.__fireKey({
      key: 'Escape', preventDefault() {}, stopPropagation() {},
    });
    ok('Escape closes the dialog', aDialog.hidden === true);
    ok('Escape restores focus to invoking Clear',
      a11y.document.activeElement === aBtn, String((a11y.document.activeElement && a11y.document.activeElement.id) || ''));
  } else {
    ok('opening focuses the initial control (Cancel)', false, 'wire helper missing');
    ok('Shift+Tab from first control wraps to last (Confirm)', false, 'wire helper missing');
    ok('Tab from last control wraps to first (Cancel)', false, 'wire helper missing');
    ok('Escape closes the dialog', false, 'wire helper missing');
    ok('Escape restores focus to invoking Clear', false, 'wire helper missing');
  }

  console.log('\n[8] Operation token bound to conversationId+clientSlug; ignore stale UI');
  if (typeof ui.wireInboxClearThread === 'function') {
    const stale = loadThreadFns();
    const sRoot = miniNode('div');
    const sBtn = miniNode('button', { id: 'btn-inbox-clear-thread', textContent: 'Clear' });
    const sDialog = miniNode('div', { id: 'inbox-clear-thread-dialog', hidden: true });
    const sCancel = miniNode('button', { id: 'inbox-clear-thread-dialog-cancel', textContent: 'Cancel' });
    const sConfirm = miniNode('button', { id: 'inbox-clear-thread-dialog-confirm', textContent: 'Clear' });
    const sBackdrop = miniNode('div', { id: 'inbox-clear-thread-dialog-cancel-backdrop' });
    sRoot.appendChild(sBtn);
    sRoot.appendChild(sDialog);
    sDialog.appendChild(sBackdrop);
    sDialog.appendChild(sCancel);
    sDialog.appendChild(sConfirm);
    stale.__byId['btn-inbox-clear-thread'] = sBtn;
    stale.__byId['inbox-clear-thread-dialog'] = sDialog;
    stale.__byId['inbox-clear-thread-dialog-cancel'] = sCancel;
    stale.__byId['inbox-clear-thread-dialog-confirm'] = sConfirm;
    stale.__byId['inbox-clear-thread-dialog-cancel-backdrop'] = sBackdrop;
    sRoot.querySelector = (sel) => {
      if (sel === '#btn-inbox-clear-thread') return sBtn;
      if (sel === '#inbox-clear-thread-dialog') return sDialog;
      return null;
    };
    stale.document.getElementById = (id) => stale.__byId[id] || null;
    let resolveFetch;
    stale.fetch = (url, opts) => {
      stale.__fetches.push({ url, opts: opts || {} });
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };
    stale.wireInboxClearThread(CONV_A, sRoot);
    ok('op token is conversationId+clientSlug',
      typeof stale.inboxClearThreadOpToken === 'function'
      && stale.inboxClearThreadOpToken(CONV_A, CLIENT) === CONV_A + '::' + CLIENT);
    sBtn.click();
    sConfirm.click();
    stale.selectedConvId = CONV_B;
    resolveFetch({
      status: 200,
      json: () => Promise.resolve({ success: true, hermes_session_reset: { ok: true } }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    ok('stale completion still requested the wired conversation',
      stale.__fetches.length === 1
      && stale.__fetches[0].url === '/staff/conversations/' + CONV_A + '/clear-thread-session');
    ok('stale completion does not close the mounted dialog', sDialog.hidden === false);
    ok('stale completion does not alert on the new selection', stale.__alerts.length === 0);
    ok('stale completion does not re-enable the new selection via finally skip',
      sConfirm.disabled === true && sBtn.disabled === true);
  } else {
    ok('op token is conversationId+clientSlug', false, 'wire helper missing');
    ok('stale completion still requested the wired conversation', false, 'wire helper missing');
    ok('stale completion does not close the mounted dialog', false, 'wire helper missing');
    ok('stale completion does not alert on the new selection', false, 'wire helper missing');
    ok('stale completion does not re-enable the new selection via finally skip', false, 'wire helper missing');
  }

  console.log('\n[9] Clear-dialog teardown before selected detail DOM is replaced/cleared');
  const teardownFn = sliceFn(threadSrc, 'inboxTeardownClearThreadDialog');
  const beginFn = sliceFn(threadSrc, 'beginConvDetailLoad');
  const clearSelFn = sliceFn(threadSrc, 'clearInboxSelection');
  ok('dedicated teardown helper exists', /function inboxTeardownClearThreadDialog\(/.test(teardownFn));
  ok('teardown always removes the capture key listener and never focuses',
    /removeEventListener\(\s*['"]keydown['"]/.test(teardownFn)
    && /keyHandler/.test(teardownFn)
    && /invokeBtn\s*=\s*null/.test(teardownFn)
    && /open\s*=\s*false/.test(teardownFn)
    && !/\.focus\s*\(/.test(teardownFn));
  ok('switching conversation tears down Clear dialog before replacing detail DOM',
    /inboxTeardownClearThreadDialog\s*\(/.test(beginFn)
    && beginFn.indexOf('inboxTeardownClearThreadDialog') < beginFn.indexOf('innerHTML'));
  ok('clearing conversation tears down Clear dialog before clearing detail DOM',
    /inboxTeardownClearThreadDialog\s*\(/.test(clearSelFn)
    && clearSelFn.indexOf('inboxTeardownClearThreadDialog') < clearSelFn.indexOf('innerHTML'));

  function mountClearDialog(ctx) {
    const root = miniNode('div', { id: 'detail-content' });
    const btn = miniNode('button', { id: 'btn-inbox-clear-thread', textContent: 'Clear' });
    const dialog = miniNode('div', { id: 'inbox-clear-thread-dialog', hidden: true });
    const cancel = miniNode('button', { id: 'inbox-clear-thread-dialog-cancel', textContent: 'Cancel' });
    const confirm = miniNode('button', { id: 'inbox-clear-thread-dialog-confirm', textContent: 'Clear' });
    const backdrop = miniNode('div', { id: 'inbox-clear-thread-dialog-cancel-backdrop' });
    root.appendChild(btn);
    root.appendChild(dialog);
    dialog.appendChild(backdrop);
    dialog.appendChild(cancel);
    dialog.appendChild(confirm);
    ctx.__byId['btn-inbox-clear-thread'] = btn;
    ctx.__byId['inbox-clear-thread-dialog'] = dialog;
    ctx.__byId['inbox-clear-thread-dialog-cancel'] = cancel;
    ctx.__byId['inbox-clear-thread-dialog-confirm'] = confirm;
    ctx.__byId['inbox-clear-thread-dialog-cancel-backdrop'] = backdrop;
    ctx.__byId['detail-content'] = root;
    root.querySelector = (sel) => {
      if (sel === '#btn-inbox-clear-thread') return btn;
      if (sel === '#inbox-clear-thread-dialog') return dialog;
      return null;
    };
    ctx.document.getElementById = (id) => ctx.__byId[id] || null;
    return { root, btn, dialog, cancel, confirm };
  }

  if (typeof ui.wireInboxClearThread === 'function'
    && typeof ui.beginConvDetailLoad === 'function'
    && typeof ui.clearInboxSelection === 'function') {
    const sw = loadThreadFns();
    const mounted = mountClearDialog(sw);
    sw.wireInboxClearThread(CONV_A, mounted.root);
    mounted.btn.click();
    ok('modal is open with a capture key listener before switch',
      mounted.dialog.hidden === false
      && sw.inboxClearThreadDialogState.open === true
      && (sw.__docListeners.keydown || []).length === 1);
    const focusedOnSwitch = [];
    focusSink = (n) => { focusedOnSwitch.push(n && n.id); sw.document.activeElement = n; };
    sw.beginConvDetailLoad(mounted.root);
    ok('switching conversation while modal open removes capture key listener',
      (sw.__docListeners.keydown || []).length === 0,
      JSON.stringify((sw.__docListeners.keydown || []).length));
    ok('switching conversation while modal open clears open/invokeBtn without focusing detached Clear',
      sw.inboxClearThreadDialogState.open === false
      && sw.inboxClearThreadDialogState.invokeBtn === null
      && sw.inboxClearThreadDialogState.keyHandler === null
      && focusedOnSwitch.indexOf('btn-inbox-clear-thread') < 0,
      JSON.stringify({
        open: sw.inboxClearThreadDialogState.open,
        invokeBtn: sw.inboxClearThreadDialogState.invokeBtn,
        focused: focusedOnSwitch,
      }));
    sw.document.__fireKey({
      key: 'Escape', preventDefault() {}, stopPropagation() {},
    });
    ok('keydown after switch teardown is a no-op (listener gone)',
      (sw.__docListeners.keydown || []).length === 0);

    const cl = loadThreadFns();
    const cleared = mountClearDialog(cl);
    cl.wireInboxClearThread(CONV_A, cleared.root);
    cleared.btn.click();
    ok('modal is open with a capture key listener before clear',
      cleared.dialog.hidden === false
      && cl.inboxClearThreadDialogState.open === true
      && (cl.__docListeners.keydown || []).length === 1);
    const focusedOnClear = [];
    focusSink = (n) => { focusedOnClear.push(n && n.id); cl.document.activeElement = n; };
    cl.clearInboxSelection(cleared.root);
    ok('clearing conversation while modal open removes capture key listener',
      (cl.__docListeners.keydown || []).length === 0);
    ok('clearing conversation while modal open clears open/invokeBtn without focusing detached Clear',
      cl.inboxClearThreadDialogState.open === false
      && cl.inboxClearThreadDialogState.invokeBtn === null
      && cl.inboxClearThreadDialogState.keyHandler === null
      && focusedOnClear.indexOf('btn-inbox-clear-thread') < 0,
      JSON.stringify({
        open: cl.inboxClearThreadDialogState.open,
        invokeBtn: cl.inboxClearThreadDialogState.invokeBtn,
        focused: focusedOnClear,
      }));
  } else {
    ok('modal is open with a capture key listener before switch', false, 'helpers missing');
    ok('switching conversation while modal open removes capture key listener', false, 'helpers missing');
    ok('switching conversation while modal open clears open/invokeBtn without focusing detached Clear', false, 'helpers missing');
    ok('keydown after switch teardown is a no-op (listener gone)', false, 'helpers missing');
    ok('modal is open with a capture key listener before clear', false, 'helpers missing');
    ok('clearing conversation while modal open removes capture key listener', false, 'helpers missing');
    ok('clearing conversation while modal open clears open/invokeBtn without focusing detached Clear', false, 'helpers missing');
  }

  console.log('\n[10] Stay off: no send, no second Luna toggle, gates registered');
  ok('no guest WhatsApp/email send from Clear modules',
    !/sendMail/.test(threadSrc) && !/_patched_whatsapp_cloud_send/.test(threadSrc)
    && !/graph\.microsoft/.test(read(OWNER))
    && !/auto_send\s*=\s*true/.test(threadSrc + read(OWNER) + hermesJs));
  ok('no second Luna authority toggle added',
    (lunaSrc.match(/id="luna-pause-switch"/g) || []).length <= 1
    && !/data-luna-mode="clear"/.test(threadSrc));
  ok('package.json and luna-all register this gate',
    pkg.scripts && pkg.scripts['verify:inbox-clear-thread-001'] === 'node scripts/verify-inbox-clear-thread-001.js'
    && /verify-inbox-clear-thread-001\.js/.test(lunaAllSrc));

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:inbox-clear-thread-001 — FAILED');
    process.exit(1);
  }
  console.log('verify:inbox-clear-thread-001 — ALL CHECKS PASSED');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify:inbox-clear-thread-001 — ERROR', err);
  process.exit(1);
});
