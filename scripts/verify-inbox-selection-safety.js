#!/usr/bin/env node
'use strict';

/* Behavioral Slice 1 gate: evaluates the real inbox-thread.js owners with held
 * promises and a minimal DOM. No regex assertion is used for the outcomes. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
let pass = 0; let fail = 0;
function ok(name, value) { if (value) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.error(`  FAIL  ${name}`); } }
function fn(name) { const a = src.indexOf(`function ${name}(`); const b = src.indexOf('\nfunction ', a + 1); return a < 0 ? '' : src.slice(a, b < 0 ? src.length : b); }
function deferred() { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function classList() { const values = new Set(); return { add: x => values.add(x), remove: x => values.delete(x), contains: x => values.has(x), toggle: (x, yes) => yes ? values.add(x) : values.delete(x) }; }
function element() { return { innerHTML: '', classList: classList(), style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} }; }
function listElement() {
  const list = element(); let cards = [];
  Object.defineProperty(list, 'innerHTML', { get: () => list._html || '', set: html => { list._html = html; cards = [...String(html).matchAll(/data-id="([^"]+)"/g)].map(m => ({ dataset: { id: m[1] }, classList: classList(), querySelector: () => null, addEventListener: () => {} })); } });
  list.querySelectorAll = selector => selector === '.conv-card' ? cards : [];
  list.querySelector = selector => { const m = selector.match(/data-id="([^"]+)"/); return m ? cards.find(c => c.dataset.id === m[1]) || null : null; };
  list.cards = () => cards;
  return list;
}
function response(id) { return { success: true, detail: { success: true, conversation: { conversation_id: id, guest_name: `Guest ${id}`, phone: `+${id}`, channel: 'whatsapp' } }, messages: { success: true, messages: [{ message_text: `message ${id}` }] }, context: { success: true, context: { guest_name: `Guest ${id}` } }, draft: { success: true, draft: { draft_text: `draft ${id}` } }, pause_state: { success: true } }; }
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function loadRuntime() {
  const detail = element(); const list = listElement(); const pending = {};
  const sandbox = {
    selectedConvId: null, inboxSelectionGeneration: 0, inboxContextLastComposite: null,
    activeTab: 'conversations', locale: 'es', console,
    el: id => id === 'detail-content' ? detail : (id === 'conv-list' ? list : element()),
    fetch: url => { const id = decodeURIComponent(String(url).split('/').pop().split('?')[0]); pending[id] = deferred(); return Promise.resolve({ json: () => pending[id].promise.then(body => { sandbox.inboxContextLastComposite = body; return body; }) }); },
    showInboxMobileThread: () => {}, hideInboxMobileThread: () => {}, inboxEmptyDetailHtml: () => '<div>select a conversation</div>',
    beginConvDetailLoad: target => { target.innerHTML = '<div>Loading…</div>'; target.classList.add('is-loading-detail'); },
    isSurfInboxDemoThread: () => false, loadSurfInboxDemoDetail: () => false, inboxClientQuery: () => '',
    threadMessagesFingerprint: () => 'sig', sanitizeConversationContextForInbox: x => x, filterActiveInboxBookings: x => x,
    isLunaGuestAutomationPaused: () => false, inboxComposerChannelFor: c => c.channel, inboxGuestEmailOf: () => '', inboxIsChatPreset: () => false,
    escHtml: x => String(x == null ? '' : x), conversationHasOpenHandoff: () => false, handoffLabel: () => '', t: x => x, portalT: x => x,
    inboxComposerChannelSwitchHtml: () => '', inboxWhatsAppDraftMountHtml: () => '', staffEmailDraftsUiEnabled: () => false,
    emailReplyState: () => null, inboxFindGuestConversation: () => null, renderInboxThreadMessagesHtml: msgs => msgs.map(m => m.message_text).join(','), inboxFilterMessagesByChannel: x => x,
    inboxNoEmailThreadHtml: () => '', inboxChatHideGuest: () => {}, inboxPaintChatChromeSlot: () => {}, wireInboxComposerChannelSwitch: () => {},
    inboxFillComposerThread: () => {}, wireInboxEmailReply: () => {}, wireInboxSendReply: () => {}, wireInboxWhatsAppDraft: () => {},
    openCustomerCardForPhone: () => {}, openCreateBookingFromContact: () => {}, wireInboxSidebarToggle: target => { target.guest = sandbox.inboxContextLastComposite.detail.conversation.guest_name; },
    wireNeedsHumanToggle: () => {}, wireInboxNeedsHumanRaise: () => {}, wireLunaPauseSwitch: () => {}, wireInboxLunaModeControl: () => {}, wireFreshStart: () => {}, wireAgentSessionReset: () => {},
    inboxInitThreadResize: () => {}, inboxScrollThreadToBottom: () => {}, normalizeCustomerPhoneClient: x => x, openBookingInCalendar: () => {},
    getPortalProfile: () => ({}), getClient: () => 'sunset', updateInboxPreviewBanner: () => {}, inboxEmptyListMessage: () => 'empty', renderInboxConvCardHtml: c => `<div class="conv-card" data-id="${c.conversation_id}"></div>`,
    isPortalMobile: () => false, document: { createElement: () => element() },
  };
  vm.createContext(sandbox);
  vm.runInContext(`var inboxSelectionGeneration = 0;\n${fn('inboxSelectionIsCurrent')}\n${fn('clearInboxSelection')}\n${fn('renderInbox')}\n${fn('loadConvDetail')}\nthis.loadConvDetail = loadConvDetail; this.renderInbox = renderInbox;`, sandbox);
  return { sandbox, detail, list, pending };
}

console.log('\nverify-inbox-selection-safety — behavioral owners\n');
(async () => {
  console.log('── held A → B detail race ──');
  { const r = loadRuntime(); r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B'); r.pending.B.resolve(response('B')); await flush(); r.pending.A.resolve(response('A')); await flush();
    ok('B remains the canonical selection', r.sandbox.selectedConvId === 'B');
    ok('Chat header/content stays B after delayed A completes', r.detail.innerHTML.includes('Guest B') && r.detail.innerHTML.includes('message B') && !r.detail.innerHTML.includes('Guest A'));
    ok('Guest/context stays B after delayed A completes', r.detail.guest === 'Guest B');
    ok('stale A cannot replace B draft/loading state', r.detail.innerHTML.includes('draft B') && !r.detail.innerHTML.includes('draft A') && !r.detail.innerHTML.includes('Loading…'));
  }
  console.log('── stale A error ──');
  { const r = loadRuntime(); r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B'); r.pending.B.resolve(response('B')); await flush(); r.pending.A.reject(new Error('A failed')); await flush();
    ok('stale A error cannot replace B detail or error state', r.detail.innerHTML.includes('Guest B') && !r.detail.innerHTML.includes('A failed'));
  }
  console.log('── real renderInbox filter behavior ──');
  { const r = loadRuntime(); r.sandbox.selectedConvId = 'A'; r.detail.innerHTML = 'Guest A'; let loads = 0; r.sandbox.loadConvDetail = () => { loads++; };
    r.sandbox.renderInbox([{ conversation_id: 'B' }]);
    ok('search/filter removal clears canonical selected ID', r.sandbox.selectedConvId === null);
    ok('removed selection leaves no result selected', r.list.cards().every(c => !c.classList.contains('selected')));
    ok('removed selection renders neutral Chat and Guest state', r.detail.innerHTML.includes('select a conversation') && !r.detail.guest);
    ok('channel filter does not auto-select its first result', loads === 0);
    r.sandbox.selectedConvId = 'A'; r.detail.innerHTML = 'Guest A'; r.detail.guest = 'Guest A'; loads = 0;
    r.sandbox.renderInbox([{ conversation_id: 'A' }, { conversation_id: 'B' }]);
    ok('retained filter keeps A selected', r.list.cards().find(c => c.dataset.id === 'A').classList.contains('selected'));
    ok('retained filter avoids a replacement detail load', loads === 0);
    ok('locale and active Inbox tab stay unchanged', r.sandbox.locale === 'es' && r.sandbox.activeTab === 'conversations');
  }
  console.log(`\n── verify-inbox-selection-safety: ${pass} passed, ${fail} failed ──`);
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
