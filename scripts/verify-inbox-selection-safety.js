#!/usr/bin/env node
'use strict';

/* Behavioral Slice 1 gate: evaluates the real inbox-thread.js owners with held
 * promises and a minimal DOM. No regex assertion is used for the outcomes. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js'), 'utf8');
const contextSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-context.js'), 'utf8');
let pass = 0; let fail = 0;
function ok(name, value, detail) { if (value) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); } }
function fn(name, source = src) { const a = source.indexOf(`function ${name}(`); const b = source.indexOf('\nfunction ', a + 1); return a < 0 ? '' : source.slice(a, b < 0 ? source.length : b); }
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
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
function loadRuntime(options = {}) {
  const detail = element(); const sidebar = element(); detail.sidebar = sidebar;
  detail.querySelector = selector => selector === '#inbox-detail-sidebar' ? sidebar : null;
  const list = listElement(); const pending = {}; const transitions = [];
  const sandbox = {
    selectedConvId: null, inboxSelectionGeneration: 0, inboxContextLastComposite: null,
    activeTab: 'conversations', locale: 'es', console,
    el: id => id === 'detail-content' ? detail : (id === 'conv-list' ? list : element()),
    fetch: url => { const id = decodeURIComponent(String(url).split('/').pop().split('?')[0]); pending[id] = deferred(); const json = () => pending[id].promise; return Promise.resolve({ json, clone: () => ({ json }) }); },
    showInboxMobileThread: () => {}, hideInboxMobileThread: () => {}, inboxEmptyDetailHtml: () => '<div>select a conversation</div>',
    inboxTeardownClearThreadDialog: () => {}, inboxParkRefreshBtn: () => {}, inboxAdoptRefreshToHeader: () => {},
    convDetailHasLayout: () => false, inboxReleaseMobileThreadHeight: () => {}, inboxStickThreadToLatest: () => {},
    beginConvDetailLoad: target => { target.innerHTML = '<div>Loading…</div>'; target.classList.add('is-loading-detail'); },
    isSurfInboxDemoThread: () => false, loadSurfInboxDemoDetail: () => false, inboxClientQuery: () => '',
    threadMessagesFingerprint: () => 'sig', sanitizeConversationContextForInbox: x => x, filterActiveInboxBookings: x => x,
    isLunaGuestAutomationPaused: () => false, inboxComposerChannelFor: c => c.channel, inboxGuestEmailOf: () => '', inboxIsChatPreset: () => false,
    escHtml: x => String(x == null ? '' : x), inboxPersonDisplayName: c => c.guest_name || 'Guest', conversationHasOpenHandoff: () => false, handoffLabel: () => '', t: x => x, portalT: x => x,
    inboxComposerChannelSwitchHtml: () => '', inboxWhatsAppDraftMountHtml: () => '', inboxClearThreadButtonHtml: () => '',
    inboxDeleteConversationButtonHtml: () => '', inboxClearThreadDialogHtml: () => '', staffEmailDraftsUiEnabled: () => false,
    inboxEmailDraftBodyOf: d => (d && d.draft_text) || '', inboxEmailDraftIsPending: () => false,
    inboxEmailOpenDraftSubject: () => '', inboxEmailComposerChromeHtml: () => '', inboxT: (_k, fallback) => fallback,
    emailReplyState: () => null, inboxFindGuestConversation: () => null, renderInboxThreadMessagesHtml: msgs => msgs.map(m => m.message_text).join(','), inboxFilterMessagesByChannel: x => x,
    inboxNoEmailThreadHtml: () => '', inboxChatHideGuest: () => {}, inboxPaintChatChromeSlot: () => {}, wireInboxComposerChannelSwitch: () => {},
    inboxFillComposerThread: () => {}, wireInboxEmailReply: () => {}, wireInboxSendReply: () => {}, wireInboxWhatsAppDraft: () => {},
    openCustomerCardForPhone: () => {}, openCreateBookingFromContact: () => {}, wireInboxSidebarToggle: target => { target.guest = sandbox.inboxContextLastComposite.detail.conversation.guest_name; },
    wireNeedsHumanToggle: () => {}, wireInboxNeedsHumanRaise: () => {}, wireLunaPauseSwitch: () => {}, wireInboxLunaModeControl: () => {},
    wireInboxClearThread: () => {}, wireInboxConversationDeleteButton: () => {}, wireFreshStart: () => {}, wireAgentSessionReset: () => {},
    inboxInitThreadResize: () => {}, inboxScrollThreadToBottom: () => {}, normalizeCustomerPhoneClient: x => x, openBookingInCalendar: () => {},
    getPortalProfile: () => ({}), getClient: () => 'sunset', updateInboxPreviewBanner: () => {}, inboxEmptyListMessage: () => 'empty', renderInboxConvCardHtml: c => `<div class="conv-card" data-id="${c.conversation_id}"></div>`,
    isPortalMobile: () => false, document: {
      createElement: () => element(),
      documentElement: { getAttribute: name => name === 'data-portal-client' ? (options.portalClient === undefined ? 'sunset' : options.portalClient) : null },
      startViewTransition: update => {
        const transition = { snapshot: detail.innerHTML, settled: false };
        transitions.push(transition);
        transition.ready = Promise.resolve().then(update).then(() => { transition.settled = true; });
        return transition;
      },
    },
    inboxContextRuntime: { fetchHooked: false }, inboxContextSidebarEl: target => target && target.sidebar,
    inboxContextModelFromComposite: composite => ({ conversation: composite.detail.conversation }), inboxContextEnsureStyles: () => {},
    inboxCustomerLoad: (target, conv) => { target.guest = conv.guest_name; },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`var inboxSelectionGeneration = 0;\nvar inboxConversationSwitchGeneration = 0;\nvar inboxConversationSwitchRelease = null;\nvar inboxConversationSwitchTransition = null;\n${fn('inboxSelectionIsCurrent')}\n${fn('clearInboxSelection')}\n${fn('renderInbox')}\n${fn('inboxRunConversationSwitch')}\n${fn('loadConvDetail')}\n${fn('inboxContextInstallFetchHook', contextSrc)}\n${fn('inboxContextFill', contextSrc)}\ninboxContextInstallFetchHook(); this.loadConvDetail = loadConvDetail; this.renderInbox = renderInbox; this.inboxRunConversationSwitch = inboxRunConversationSwitch; this.inboxContextFill = inboxContextFill;`, sandbox);
  return { sandbox, detail, sidebar, list, pending, transitions };
}

console.log('\nverify-inbox-selection-safety — behavioral owners\n');
(async () => {
  console.log('── conversation → conversation hold/swap ──');
  { const r = loadRuntime();
    r.detail.innerHTML = '<div>Select a conversation…</div>';
    r.sandbox.inboxRunConversationSwitch('A'); await flush();
    ok('Sunset first open holds the empty placeholder while A is pending',
      r.transitions.length === 0 && r.detail.innerHTML.includes('Select a conversation…') && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
    r.pending.A.resolve(response('A')); await flush();
    ok('Sunset first open swaps once to the complete A deck',
      r.detail.innerHTML.includes('Guest A') && r.detail.guest === 'Guest A' && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
  }
  { const r = loadRuntime({ portalClient: null });
    r.detail.innerHTML = '<div>Select a conversation…</div>';
    r.sandbox.inboxRunConversationSwitch('A'); await flush();
    ok('Wolfhouse first open holds the empty placeholder while A is pending',
      r.transitions.length === 0 && r.detail.innerHTML.includes('Select a conversation…') && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
    r.pending.A.resolve(response('A')); await flush();
    ok('Wolfhouse first open swaps once to the complete A deck',
      r.detail.innerHTML.includes('Guest A') && r.detail.guest === 'Guest A' && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
  }
  { const r = loadRuntime();
    r.sandbox.selectedConvId = 'A';
    r.detail.innerHTML = '<div>Guest A</div><div>message A</div><aside>Guest A context</aside>';
    r.sandbox.inboxRunConversationSwitch('B');
    await flush();
    ok('Sunset conversation switch snapshots the complete previous deck', r.transitions.length === 1 && r.transitions[0].snapshot.includes('Guest A context'));
    ok('previous deck remains the transition surface while B is pending', r.transitions[0] && r.transitions[0].settled === false);
    ok('slow Sunset switch keeps the live A deck fully painted while B is pending',
      r.detail.innerHTML.includes('Guest A context') && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
    r.pending.B.resolve(response('B')); await flush();
    ok('thread and guest/context commit together when B is ready', r.transitions[0].settled === true && r.detail.innerHTML.includes('Guest B') && r.detail.guest === 'Guest B', r.detail.innerHTML);
  }
  { const r = loadRuntime({ portalClient: null });
    r.sandbox.selectedConvId = 'A';
    r.detail.innerHTML = '<div>Guest A</div><div>message A</div><aside>Guest A context</aside>';
    r.sandbox.inboxRunConversationSwitch('B'); await flush();
    ok('Wolfhouse switch keeps the live A deck fully painted while B is pending',
      r.detail.innerHTML.includes('Guest A context') && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
    r.pending.B.resolve(response('B')); await flush();
    ok('Wolfhouse swaps once to the complete B deck',
      r.detail.innerHTML.includes('Guest B') && r.detail.guest === 'Guest B' && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
  }
  { const r = loadRuntime();
    r.sandbox.selectedConvId = 'A';
    r.detail.innerHTML = '<div>Guest A</div><div>message A</div><aside>Guest A context</aside>';
    r.sandbox.inboxRunConversationSwitch('B'); await flush();
    r.sandbox.inboxRunConversationSwitch('C'); await flush();
    ok('rapid C switch reuses the active transition instead of snapshotting B loading', r.transitions.length === 1 && r.transitions[0].snapshot.includes('Guest A context'), r.transitions.map(t => t.snapshot).join(' | '));
    ok('rapid C switch keeps the original A transition pending', r.transitions[0].settled === false);
    ok('rapid A→B→C keeps the live A deck fully painted until C settles',
      r.detail.innerHTML.includes('Guest A context') && !r.detail.innerHTML.includes('Loading…'), r.detail.innerHTML);
    r.pending.C.resolve(response('C')); await flush();
    ok('rapid switch commits only C as one complete deck', r.transitions[0].settled === true && r.sandbox.selectedConvId === 'C' && r.detail.innerHTML.includes('Guest C') && r.detail.guest === 'Guest C', r.detail.innerHTML);
    r.pending.B.resolve(response('B')); await flush();
    ok('late B cannot repaint after rapid C switch', r.sandbox.selectedConvId === 'C' && r.detail.innerHTML.includes('Guest C') && r.detail.guest === 'Guest C', r.detail.innerHTML);
  }
  console.log('── held A → B detail race ──');
  { const r = loadRuntime(); r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B'); r.pending.B.resolve(response('B')); await flush(); r.pending.A.resolve(response('A')); await flush();
    ok('B remains the canonical selection', r.sandbox.selectedConvId === 'B');
    ok('Chat header/content stays B after delayed A completes', r.detail.innerHTML.includes('Guest B') && r.detail.innerHTML.includes('message B') && !r.detail.innerHTML.includes('Guest A'));
    ok('Guest/context stays B after delayed A completes', r.detail.guest === 'Guest B');
    ok('production context cache remains B after delayed A completes', r.sandbox.inboxContextLastComposite.detail.conversation.conversation_id === 'B');
    r.sandbox.inboxContextFill(r.detail);
    ok('subsequent real Guest/context repaint remains B', r.sidebar.guest === 'Guest B');
    ok('stale A cannot replace B draft/loading state', r.detail.innerHTML.includes('draft B') && !r.detail.innerHTML.includes('draft A') && !r.detail.innerHTML.includes('Loading…'));
  }
  console.log('── stale A error ──');
  { const r = loadRuntime(); r.sandbox.loadConvDetail('A'); r.sandbox.loadConvDetail('B'); r.pending.B.resolve(response('B')); await flush(); r.pending.A.reject(new Error('A failed')); await flush();
    ok('stale A error cannot replace B detail or error state', r.detail.innerHTML.includes('Guest B') && !r.detail.innerHTML.includes('A failed'));
    ok('stale A error cannot alter B context cache', r.sandbox.inboxContextLastComposite.detail.conversation.conversation_id === 'B');
    r.sandbox.inboxContextFill(r.detail);
    ok('context repaint remains B after stale A error', r.sidebar.guest === 'Guest B');
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
