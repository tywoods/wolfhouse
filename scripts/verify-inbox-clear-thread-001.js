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
 *     conversation to /staff/conversations/:id/reset-agent-session with client_slug
 *   - Backend owner is conversation + client scoped; sibling same-phone bindings
 *     fail closed; needs_human clears only after Hermes session-key reset success
 *   - Hermes session-key path does not delete shared agent memories and does not
 *     delete a second same-phone session
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
    click() {
      (listeners.click || []).forEach((fn) => fn({ type: 'click', target: node, preventDefault() {} }));
    },
    get lastChild() {
      return children.length ? children[children.length - 1] : null;
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
  const byId = {};
  const doc = {
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
  };
  const sandbox = {
    t: (key) => T[key] || key,
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    getClient: () => CLIENT,
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
    alert() {},
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
      'this.inboxAdoptRefreshToHeader = inboxAdoptRefreshToHeader;\n',
      sandbox,
    );
  } catch (err) {
    sandbox.__runError = err && err.message;
  }
  sandbox.__fetches = fetches;
  sandbox.__byId = byId;
  sandbox.__doc = doc;
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
    ok('Confirm POSTs reset-agent-session for the selected conversation id',
      req.opts && req.opts.method === 'POST'
      && req.url === '/staff/conversations/' + CONV_A + '/reset-agent-session');
    ok('Confirm body is client-scoped',
      body.client_slug === CLIENT
      && !body.hard_delete);
    ok('Confirm does not call reset-luna-context or Full Wipe',
      !/reset-luna-context/.test(req.url || '')
      && ui.__fetches.every((f) => !/reset-luna-context|clear-messages/.test(f.url)));
  } else {
    ok('opening dialog makes zero requests', false, 'wire helper missing');
    ok('dialog is shown on Clear click', false, 'wire helper missing');
    ok('Cancel makes zero requests', false, 'wire helper missing');
    ok('Cancel hides the dialog', false, 'wire helper missing');
    ok('Confirm makes exactly one request', false, 'wire helper missing');
    ok('Confirm POSTs reset-agent-session for the selected conversation id', false, 'wire helper missing');
    ok('Confirm body is client-scoped', false, 'wire helper missing');
    ok('Confirm does not call reset-luna-context or Full Wipe', false, 'wire helper missing');
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
    ok('Hermes called once with selected phone + session_key scope',
      hermesCalls.length === 1
      && hermesCalls[0].phone === '+34600000001'
      && hermesCalls[0].opts.scope === 'session_key'
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
    ok('Hermes called once with selected phone + session_key scope', false, 'owner missing');
    ok('needs_human cleared only after Hermes success', false, 'owner missing');
    ok('other conversation needs_human preserved', false, 'owner missing');
    ok('messages/bookings/payments/customers/identity not mutated', false, 'owner missing');
    ok('owner SQL is client+conversation scoped (no other-thread UPDATE)', false, 'owner missing');
    ok('Hermes failure does not clear needs_human', false, 'owner missing');
    ok('same-phone sibling fails closed (no Hermes, no needs_human clear)', false, 'owner missing');
  }

  console.log('\n[4] Staff handler + Hermes session-key path');
  const handlerStart = apiSrc.indexOf('async function handleConversationResetAgentSession(');
  const handlerEnd = apiSrc.indexOf('async function handleConversationResetLunaContext(');
  const handler = handlerStart >= 0
    ? apiSrc.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 4000)
    : '';
  ok('handler uses inbox-clear owner (not inline hard_delete phone wipe)',
    /performInboxClearThreadReset\s*\(/.test(handler)
    && !/hard_delete:\s*true/.test(handler),
    handler ? 'handler slice still mentions hard_delete' : 'handler missing');
  ok('handler keeps staging + client access fences',
    /isStagingResetEnvironment/.test(handler)
    && /assertStaffClientAccess/.test(handler));
  ok('Full Wipe still uses reset-luna-context + hard_delete',
    /function handleConversationResetLunaContext\(/.test(apiSrc)
    && /reset-luna-context/.test(apiSrc)
    && /hard_delete:\s*true/.test(sliceFn(apiSrc, 'handleConversationResetLunaContext')));
  ok('JS client has session-key scoped reset (no shared-memory hard_delete default)',
    /function resetHermesConversationSession\(/.test(hermesJs)
    && /scope:\s*['"]session_key['"]/.test(hermesJs));
  ok('legacy phone hard_delete helper remains for Full Wipe / overflow compatibility',
    /function resetHermesGuestSession\(/.test(hermesJs)
    && /hard_delete/.test(hermesJs));
  ok('Python session-key reset exists and does not call shared memory deletion',
    /def reset_session_key_only\(/.test(hermesPy)
    && !/clear_luna_agent_memories\(/.test(
      hermesPy.slice(hermesPy.indexOf('def reset_session_key_only'), hermesPy.indexOf('def reset_guest_session')),
    )
    && !/_list_whatsapp_session_ids\(/.test(
      hermesPy.slice(hermesPy.indexOf('def reset_session_key_only'), hermesPy.indexOf('def reset_guest_session')),
    ));
  ok('fresh-start route can select session_key scope without changing default hard_delete',
    /scope/.test(hermesPy) && /reset_session_key_only\(/.test(hermesPy)
    && /def reset_guest_session\(/.test(hermesPy)
    && /delete_guest_agent_sessions\(/.test(hermesPy));

  if (fs.existsSync(PY_GATE)) {
    const py = spawnSync('python3', [PY_GATE], { encoding: 'utf8', cwd: ROOT });
    ok('python session-key isolation gate', py.status === 0, (py.stdout || '') + (py.stderr || ''));
    if (py.stdout) process.stdout.write(py.stdout);
    if (py.status !== 0 && py.stderr) process.stderr.write(py.stderr);
  } else {
    ok('python session-key isolation gate', false, 'verify_inbox_clear_session_key.py missing');
  }

  console.log('\n[5] Stay off: no send, no second Luna toggle, gates registered');
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
