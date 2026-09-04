#!/usr/bin/env node
'use strict';

/**
 * INBOX-DRAFT-EMPTY-SAVE-DELETE-001
 *
 * Empty / whitespace-only Save draft and Delete draft must be an idempotent
 * no-op on WhatsApp and Email: no error status, no POST/DELETE, no wipe of
 * other thread state. Non-empty Save/Delete still hit the network.
 *
 * Reproduced on current master before this pack:
 *   WA empty Save     → error "Enter valid draft text before saving."
 *   WA whitespace Save → POST /staff/inbox/whatsapp/draft
 *   WA empty Delete   → error "Delete failed" (no approval_id)
 *   Email empty Save  → error "Enter a reply before saving a draft."
 *   Email whitespace Save → POST /staff/inbox/email/draft ("Saving draft…")
 *   Email empty Delete → silent, but bumped seq before the no-op
 *
 * Run: node scripts/verify-inbox-draft-empty-save-delete.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const WA_SRC = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-whatsapp-draft.js'), 'utf8');
const THREAD_SRC = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');

const CONV = '22222222-2222-4222-8222-222222222222';
const AP1 = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function makeEl(id, extras) {
  const listeners = {};
  const el = {
    id,
    value: '',
    disabled: false,
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    innerHTML: '',
    _inboxStatusTimer: null,
    classList: { add() {}, remove() {} },
    querySelector(sel) {
      if (this._kids && Object.prototype.hasOwnProperty.call(this._kids, sel)) return this._kids[sel];
      if (sel === '#' + this.id) return this;
      return null;
    },
    querySelectorAll(sel) {
      const n = this.querySelector(sel);
      return n ? [n] : [];
    },
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    dispatchEvent(ev) {
      const type = (ev && ev.type) || 'click';
      const event = ev || {
        type,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      for (const fn of (listeners[type] || [])) fn(event);
    },
    closest(sel) {
      if (sel === '.draft-panel') return this._panel || (this.id === 'draft-panel' ? this : null);
      if (sel === 'button') return this;
      return null;
    },
    contains(node) {
      if (node === this) return true;
      return !!(this._all && this._all.indexOf(node) >= 0);
    },
  };
  Object.assign(el, extras || {});
  return el;
}

function makeComposer() {
  const ta = makeEl('draft-textarea');
  const status = makeEl('draft-send-status');
  const saveWa = makeEl('btn-save-draft');
  const saveEmail = makeEl('btn-email-save-draft');
  const del = makeEl('btn-delete-draft');
  const send = makeEl('btn-send-reply');
  const appr = makeEl('btn-email-approve-send');
  const subject = makeEl('inbox-email-reply-subject');
  const byteCount = makeEl('email-draft-byte-count');
  const waMount = makeEl('inbox-whatsapp-draft', { hidden: true, innerHTML: '' });
  const thread = makeEl('thread-container', { innerHTML: '<div class="msg" data-keep="1">prior thread</div>' });
  const kids = {
    '#draft-textarea': ta,
    '#draft-send-status': status,
    '#btn-save-draft': saveWa,
    '#btn-email-save-draft': saveEmail,
    '#btn-delete-draft': del,
    '#btn-send-reply': send,
    '#btn-email-approve-send': appr,
    '#inbox-email-reply-subject': subject,
    '#email-draft-byte-count': byteCount,
    '#btn-email-generate-luna-draft': null,
    '#btn-email-create-draft': null,
    '#inbox-email-create-draft-context': null,
    '#inbox-whatsapp-draft': waMount,
    '#thread-container': thread,
  };
  const panel = makeEl('draft-panel');
  panel._kids = kids;
  const all = Object.values(kids).filter(Boolean).concat([panel]);
  panel._all = all;
  panel.contains = (n) => n === panel || all.indexOf(n) >= 0;
  const target = makeEl('conv-detail');
  target._kids = Object.assign({ '.draft-panel': panel }, kids);
  target._all = all.concat([target]);
  target.contains = (n) => n === target || target._all.indexOf(n) >= 0;
  target.querySelector = (sel) => target._kids[sel] || null;
  target.querySelectorAll = (sel) => {
    const n = target.querySelector(sel);
    return n ? [n] : [];
  };
  panel.querySelector = target.querySelector;
  panel.querySelectorAll = target.querySelectorAll;
  [saveWa, saveEmail, del, send, appr, ta, status, subject].forEach((n) => { n._panel = panel; });
  return { target, panel, ta, status, saveWa, saveEmail, del, thread, subject };
}

function sandboxBase(fetches) {
  return {
    console,
    TextEncoder,
    selectedConvId: CONV,
    getClient: () => 'sunset',
    inboxClientQuery: () => '?client=sunset',
    escHtml: (s) => String(s),
    showDraftSendStatus(el, kind, message) {
      if (!el) return;
      el.className = 'draft-send-status is-visible ' + (kind || '');
      el.textContent = message || '';
    },
    loadConvDetail() {},
    performInboxSend() {},
    fetch(url, opts) {
      const method = (opts && opts.method) || 'GET';
      fetches.push({ url: String(url), method, body: opts && opts.body, headers: opts && opts.headers });
      const u = String(url);
      if (method === 'GET') {
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            conversation_id: CONV,
            channel: 'whatsapp',
            approval_id: null,
            draft_text: null,
            status: 'none',
            tool_trace: null,
          }),
        });
      }
      if (method === 'POST' && u.indexOf('/staff/inbox/whatsapp/draft') >= 0) {
        const body = JSON.parse((opts && opts.body) || '{}');
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            conversation_id: CONV,
            channel: 'whatsapp',
            approval_id: AP1,
            draft_text: body.draft_text,
            status: 'pending',
          }),
        });
      }
      if (method === 'POST' && u.indexOf('/staff/inbox/email/draft') >= 0) {
        const body = JSON.parse((opts && opts.body) || '{}');
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            conversation_id: CONV,
            message_text: body.message_text,
            approval_id: AP1,
          }),
        });
      }
      if (method === 'DELETE') {
        return Promise.resolve({
          status: 200,
          text: async () => JSON.stringify({
            success: true,
            conversation_id: CONV,
            channel: u.indexOf('whatsapp') >= 0 ? 'whatsapp' : 'email',
            deleted: true,
          }),
        });
      }
      return Promise.resolve({ status: 500, text: async () => '{"success":false}' });
    },
    window: {
      __EMAIL_STAFF_EMAIL_DRAFTS_ENABLED__: true,
      __EMAIL_STAFF_OUTBOUND_ENABLED__: true,
    },
    document: { querySelector() { return null; } },
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    JSON,
    Object,
    String,
    Array,
    Reflect,
    Error,
  };
}

function loadWa(fetches) {
  const sb = sandboxBase(fetches);
  vm.createContext(sb);
  vm.runInContext(
    WA_SRC +
      '\nthis.performWhatsAppComposerSave = performWhatsAppComposerSave;' +
      '\nthis.performWhatsAppDraftDelete = performWhatsAppDraftDelete;' +
      '\nthis.whatsappDraftState = whatsappDraftState;' +
      '\nthis.wireInboxWhatsAppDraft = wireInboxWhatsAppDraft;',
    sb,
  );
  return sb;
}

function loadEmail(fetches) {
  const start = THREAD_SRC.indexOf('var EMAIL_DRAFT_MAX_UTF8_BYTES');
  const end = THREAD_SRC.indexOf('\nfunction wireInboxSendReply');
  assert.ok(start >= 0 && end > start, 'email composer slice');
  const sb = sandboxBase(fetches);
  vm.createContext(sb);
  vm.runInContext(
    THREAD_SRC.slice(start, end) +
      '\nthis.performEmailDraftSave = performEmailDraftSave;' +
      '\nthis.performEmailDraftDelete = performEmailDraftDelete;' +
      '\nthis.emailReplyState = emailReplyState;' +
      '\nthis.wireInboxEmailReply = wireInboxEmailReply;',
    sb,
  );
  return sb;
}

function mutatingFetches(fetches) {
  return fetches.filter((f) => f.method === 'POST' || f.method === 'DELETE');
}

function assertNoError(label, panel, fetches, st) {
  assert.equal(/\berror\b/.test(panel.status.className), false, label + ' no error class: ' + panel.status.className);
  assert.equal(/failed|Enter /i.test(String(panel.status.textContent || '')), false, label + ' no error copy: ' + panel.status.textContent);
  assert.equal(mutatingFetches(fetches).length, 0, label + ' no POST/DELETE');
  assert.equal(panel.thread.innerHTML, '<div class="msg" data-keep="1">prior thread</div>', label + ' thread intact');
  assert.equal(st.inFlight, false, label + ' not inFlight');
}

(async () => {
  assert.doesNotMatch(THREAD_SRC, /Enter a reply before saving a draft\./);
  assert.match(THREAD_SRC, /if \(!String\(messageText\)\.trim\(\)\) \{/);
  assert.match(WA_SRC, /if\(!String\(text\)\.trim\(\)\)return;/);
  assert.doesNotMatch(WA_SRC, /if\(!approval\)\{whatsappDraftShowStatus\(targetEl,'error','Delete failed'\);return;\}/);

  const emptyBodies = ['', '   ', '\n\t  ', ' \n'];

  for (const body of emptyBodies) {
    const fetches = [];
    const sb = loadWa(fetches);
    const p = makeComposer();
    p.ta.value = body;
    sb.selectedConvId = CONV;
    const st = sb.whatsappDraftState(CONV);
    st.approvalId = null;
    st.draftText = 'keep-luna';
    st.seq = 0;
    sb.wireInboxWhatsAppDraft(CONV, p.target);
    p.ta.value = body;
    p.status.className = '';
    p.status.textContent = '';
    p.saveWa.dispatchEvent({ type: 'click', target: p.saveWa, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assertNoError('WA save empty [' + JSON.stringify(body) + ']', p, fetches, st);
    assert.equal(st.draftText, 'keep-luna', 'WA save does not wipe held draft text');
    assert.equal(st.approvalId, null, 'WA save empty does not mint approval');
    p.del.dispatchEvent({ type: 'click', target: p.del, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assertNoError('WA delete empty [' + JSON.stringify(body) + ']', p, fetches, st);
    assert.equal(st.draftText, 'keep-luna', 'WA delete empty does not wipe held draft text');
  }

  for (const body of emptyBodies) {
    const fetches = [];
    const sb = loadEmail(fetches);
    const p = makeComposer();
    p.ta.value = body;
    sb.selectedConvId = CONV;
    const st = sb.emailReplyState(CONV);
    st.approvalId = null;
    st.savedText = 'keep-email';
    st.savedSubject = 'Re: stay';
    st.seq = 0;
    st.inFlight = false;
    sb.wireInboxEmailReply(CONV, p.target);
    p.ta.value = body;
    p.status.className = '';
    p.status.textContent = '';
    const seqBefore = st.seq;
    p.saveEmail.dispatchEvent({ type: 'click', target: p.saveEmail, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assertNoError('Email save empty [' + JSON.stringify(body) + ']', p, fetches, st);
    assert.equal(st.savedText, 'keep-email', 'Email save does not wipe savedText');
    assert.equal(st.savedSubject, 'Re: stay', 'Email save does not wipe subject');
    assert.equal(st.approvalId, null, 'Email save empty does not mint approval');
    assert.equal(st.seq, seqBefore, 'Email save empty does not bump seq');
    p.del.dispatchEvent({ type: 'click', target: p.del, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    assertNoError('Email delete empty [' + JSON.stringify(body) + ']', p, fetches, st);
    assert.equal(st.seq, seqBefore, 'Email delete empty does not bump seq');
    assert.equal(st.savedText, 'keep-email', 'Email delete empty does not wipe savedText');
  }

  {
    const fetches = [];
    const sb = loadWa(fetches);
    const p = makeComposer();
    p.ta.value = 'Exact WA draft text';
    sb.selectedConvId = CONV;
    sb.wireInboxWhatsAppDraft(CONV, p.target);
    p.ta.value = 'Exact WA draft text';
    p.saveWa.dispatchEvent({ type: 'click', target: p.saveWa, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setImmediate(r));
    const posts = mutatingFetches(fetches).filter((f) => f.method === 'POST');
    assert.equal(posts.length, 1, 'non-empty WA save still POSTs');
    assert.match(posts[0].url, /\/staff\/inbox\/whatsapp\/draft/);
    assert.equal(JSON.parse(posts[0].body).draft_text, 'Exact WA draft text');
  }

  {
    const fetches = [];
    const sb = loadEmail(fetches);
    const p = makeComposer();
    p.ta.value = 'First email draft body';
    sb.selectedConvId = CONV;
    const st = sb.emailReplyState(CONV);
    st.approvalId = null;
    st.savedText = '';
    sb.wireInboxEmailReply(CONV, p.target);
    p.ta.value = 'First email draft body';
    p.saveEmail.dispatchEvent({ type: 'click', target: p.saveEmail, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    await new Promise((r) => setImmediate(r));
    const posts = mutatingFetches(fetches).filter((f) => f.method === 'POST');
    assert.equal(posts.length, 1, 'non-empty Email save still POSTs');
    assert.equal(JSON.parse(posts[0].body).message_text, 'First email draft body');
  }

  {
    const fetches = [];
    const sb = loadWa(fetches);
    const p = makeComposer();
    p.ta.value = 'Exact WA draft text';
    sb.selectedConvId = CONV;
    const st = sb.whatsappDraftState(CONV);
    st.approvalId = AP1;
    st.draftText = 'Exact WA draft text';
    sb.wireInboxWhatsAppDraft(CONV, p.target);
    st.approvalId = AP1;
    st.inFlight = false;
    p.ta.value = 'Exact WA draft text';
    p.del.dispatchEvent({ type: 'click', target: p.del, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    const deletes = mutatingFetches(fetches).filter((f) => f.method === 'DELETE');
    assert.equal(deletes.length, 1, 'non-empty WA delete still DELETEs');
    assert.match(deletes[0].url, /approval_id=abcdefab-cdef-4abc-8def-abcdefabcdef/);
  }

  {
    const fetches = [];
    const sb = loadEmail(fetches);
    const p = makeComposer();
    p.ta.value = 'Updated email draft body';
    sb.selectedConvId = CONV;
    const st = sb.emailReplyState(CONV);
    st.approvalId = AP1;
    st.savedText = 'Updated email draft body';
    sb.wireInboxEmailReply(CONV, p.target);
    st.approvalId = AP1;
    st.inFlight = false;
    p.ta.value = 'Updated email draft body';
    p.del.dispatchEvent({ type: 'click', target: p.del, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
    const deletes = mutatingFetches(fetches).filter((f) => f.method === 'DELETE');
    assert.equal(deletes.length, 1, 'non-empty Email delete still DELETEs');
    assert.match(deletes[0].url, /approval_id=abcdefab-cdef-4abc-8def-abcdefabcdef/);
  }

  console.log('verify:inbox-draft-empty-save-delete PASSED (empty/whitespace Save+Delete no-op on WA+Email click; non-empty still mutates)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
