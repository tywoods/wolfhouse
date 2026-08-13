#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-thread-mockup
 *
 * Offline gate for the Sunset Inbox thread column (mockup):
 *   - date separators in the timeline
 *   - Luna draft as an outbound ghost bubble inside #inbox-thread-wrap
 *     (sibling of #thread-container so live poll cannot wipe it)
 *   - Approve / Edit / Discard on the card; no fake time or ticks
 *   - thread header Luna label inherits the chrome channel default
 *   - Pause Luna Globally hidden while Inbox is the active tab (DOM stays)
 *   - guest-card Create booking is a forest pill; stay facts unchanged
 *
 * Stay off: staff-query-api.js, database/, infra/. No Graph / WhatsApp Cloud send.
 *
 * Run: node scripts/verify-inbox-thread-mockup.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  SHELL_MODULE,
  THREAD_MODULE,
  CONTEXT_MODULE,
  LUNA_MODE_MODULE,
  WHATSAPP_DRAFT_MODULE,
  LIST_MODULE,
} = require('./lib/inbox-browser-source');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG_PATH = path.join(ROOT, 'package.json');
const LUNA_ALL_PATH = path.join(ROOT, 'scripts', 'verify-luna-all.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');

const shellSrc = fs.readFileSync(SHELL_MODULE, 'utf8');
const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
const contextSrc = fs.readFileSync(CONTEXT_MODULE, 'utf8');
const lunaSrc = fs.readFileSync(LUNA_MODE_MODULE, 'utf8');
const draftSrc = fs.readFileSync(WHATSAPP_DRAFT_MODULE, 'utf8');
const listSrc = fs.readFileSync(LIST_MODULE, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const lunaAllSrc = fs.readFileSync(LUNA_ALL_PATH, 'utf8');
const i18nSrc = fs.readFileSync(I18N_PATH, 'utf8');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (conditionTrue(cond)) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function conditionTrue(cond) {
  return !!cond;
}

function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

function loadDraftFns() {
  const sandbox = {
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${draftSrc}\n` +
    'this.inboxWhatsAppDraftMountHtml = inboxWhatsAppDraftMountHtml;\n' +
    'this.inboxWhatsAppDraftCardHtml = inboxWhatsAppDraftCardHtml;\n',
    sandbox,
  );
  return sandbox;
}

function loadLunaFns() {
  const sandbox = {
    t: (key) => ({
      'inbox.detail.lunaMode.label': 'Luna',
      'inbox.detail.lunaMode.auto': 'Auto',
      'inbox.detail.lunaMode.draft': 'Draft',
      'inbox.detail.lunaMode.off': 'Off',
      'inbox.detail.lunaMode.inherited': 'inherited',
      'inbox.detail.lunaMode.autoHelp': 'auto help',
      'inbox.detail.lunaMode.draftHelp': 'draft help',
      'inbox.detail.lunaMode.offHelp': 'off help',
      'inbox.detail.needsHuman.raise': 'Needs human',
      'inbox.detail.needsHuman.clear': 'Clear',
      'inbox.detail.switch.needsHuman': 'Needs human',
    }[key] || key),
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    inboxShellLoadStoredModes: () => ({ whatsapp: 'auto', email: 'draft' }),
    inboxShellNormalizeWhatsApp: (v) => (v === 'draft' || v === 'off' || v === 'auto' ? v : 'auto'),
    inboxShellNormalizeEmail: (v) => (v === 'off' || v === 'draft' ? v : 'draft'),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${lunaSrc}\n` +
    'this.inboxLunaModeControlHtml = inboxLunaModeControlHtml;\n' +
    'this.inboxLunaModeIsInherited = inboxLunaModeIsInherited;\n' +
    'this.inboxLunaModeHeaderLabel = inboxLunaModeHeaderLabel;\n',
    sandbox,
  );
  return sandbox;
}

function loadListFns() {
  const sandbox = {
    escHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    t: (key) => key,
    fmtTs: (ts) => String(ts || ''),
    formatThreadMessageHtml: (body) => String(body || ''),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${listSrc}\n` +
    'this.inboxThreadDayKey = inboxThreadDayKey;\n' +
    'this.inboxThreadDayLabel = inboxThreadDayLabel;\n' +
    'this.renderInboxThreadMessagesHtml = renderInboxThreadMessagesHtml;\n',
    sandbox,
  );
  return sandbox;
}

console.log('\nverify:inbox-thread-mockup — thread column (date seps, ghost draft, inherited Luna)\n');

console.log('── date separators ──');
{
  const fns = loadListFns();
  const html = fns.renderInboxThreadMessagesHtml([
    { direction: 'inbound', message_text: 'hi', created_at: '2026-08-12T10:00:00Z', source: 'guest' },
    { direction: 'outbound', message_text: 'hello', created_at: '2026-08-12T10:05:00Z', source: 'hermes_luna_whatsapp_reply' },
    { direction: 'inbound', message_text: 'next day', created_at: '2026-08-13T09:00:00Z', source: 'guest' },
  ]);
  ok('list module renders .inbox-thread-day separators',
    /class="inbox-thread-day"/.test(html)
    && (html.match(/class="inbox-thread-day"/g) || []).length === 2);
  ok('same calendar day does not repeat the separator',
    (html.match(/class="inbox-thread-day"/g) || []).length === 2);
  ok('poll replaces #thread-container only (draft mount survives)',
    /container\.innerHTML = renderInboxThreadMessagesHtml\(msgs\)/.test(listSrc)
    && /el\('thread-container'\)/.test(sliceFn(listSrc, 'pollInboxSelectedThreadLive')));
}

console.log('\n── ghost draft in the timeline ──');
{
  const loadFn = sliceFn(threadSrc, 'loadConvDetail');
  const wrapIdx = loadFn.indexOf("id=\"inbox-thread-wrap\"");
  const containerIdx = loadFn.indexOf("id=\"thread-container\"");
  const mountIdx = loadFn.indexOf('inboxWhatsAppDraftMountHtml()');
  const panelIdx = loadFn.indexOf("class=\"draft-panel\"");
  ok('thread still mounts WhatsApp draft off the email path',
    /if \(!isEmailConversation\) html \+= inboxWhatsAppDraftMountHtml\(\)/.test(threadSrc));
  ok('draft mount sits inside #inbox-thread-wrap after #thread-container',
    wrapIdx >= 0 && containerIdx > wrapIdx && mountIdx > containerIdx && (panelIdx < 0 || mountIdx < panelIdx));
  ok('composer (Write a reply) stays in .draft-panel',
    /class="draft-panel"/.test(threadSrc)
    && /id="draft-textarea"/.test(threadSrc)
    && /id="btn-send-reply"/.test(threadSrc)
    && i18nSrc.includes("'inbox.detail.reply.editPlaceholder': 'Write a reply…'"));
  const fns = loadDraftFns();
  const mount = fns.inboxWhatsAppDraftMountHtml();
  const card = fns.inboxWhatsAppDraftCardHtml({
    draftText: 'Yes — 10am has two spots.',
    editing: false,
    toolTrace: ['availability'],
  });
  ok('mount is a timeline ghost (hidden until a draft loads)',
    /id="inbox-whatsapp-draft"/.test(mount)
    && /inbox-whatsapp-draft-in-timeline/.test(mount)
    && /\bhidden\b/.test(mount));
  ok('card keeps Approve / Edit and adds Discard',
    card.includes('Approve') && card.includes('Edit') && card.includes('Discard')
    && /id="btn-whatsapp-draft-approve"/.test(card)
    && /id="btn-whatsapp-draft-edit"/.test(card)
    && /id="btn-whatsapp-draft-discard"/.test(card));
  ok('card has no timestamp or delivery ticks',
    !/\d{1,2}:\d{2}/.test(card)
    && !/msg-meta/.test(card)
    && !/msg-ticks/.test(card)
    && !/✓✓|✔✔/.test(card));
  ok('optional tool trace renders when present',
    /inbox-whatsapp-draft-tools/.test(card) && card.includes('availability'));
  ok('Discard is local hide — no discard/reject API in this slice',
    /function performWhatsAppDraftDiscard\(/.test(draftSrc)
    && !/\/staff\/inbox\/whatsapp\/discard/.test(draftSrc)
    && !/\/staff\/inbox\/approvals\/.*reject/.test(draftSrc));
  ok('theme aligns the ghost to the outbound side and hides ticks',
    /#inbox-shell \.inbox-whatsapp-draft-in-timeline\{display:flex;justify-content:flex-end/.test(shellSrc)
    && /#inbox-shell \.inbox-whatsapp-draft-in-timeline\[hidden\]\{display:none!important\}/.test(shellSrc)
    && /border:1px dashed var\(--inbox-forest\)/.test(shellSrc)
    && /#inbox-shell \.inbox-whatsapp-draft-card \.msg-meta/.test(shellSrc));
}

console.log('\n── inherited Luna + hide Pause Globally ──');
{
  const fns = loadLunaFns();
  ok('unpaused WhatsApp matching chrome Auto is inherited',
    fns.inboxLunaModeIsInherited('whatsapp', false) === true
    && /inherited/.test(fns.inboxLunaModeHeaderLabel('whatsapp', false)));
  ok('paused WhatsApp against chrome Auto is an override, not inherited',
    fns.inboxLunaModeIsInherited('whatsapp', true) === false
    && !/\(inherited\)/.test(fns.inboxLunaModeHeaderLabel('whatsapp', true)));
  const html = fns.inboxLunaModeControlHtml({ channel: 'whatsapp', paused: false, needs_human: false });
  ok('header still keeps #luna-pause-switch and Auto|Off',
    /id="luna-pause-switch"/.test(html)
    && /data-luna-mode="auto"/.test(html)
    && /data-luna-mode="off"/.test(html)
    && !/data-luna-mode="draft"/.test(html));
  ok('Pause Globally stays in the portal template',
    /id="cc-luna-global-pause"/.test(apiSrc)
    && /Pause Luna Globally/.test(apiSrc));
  ok('Inbox-open CSS hides #cc-luna-global-pause without renaming the switch',
    /body:has\(#tab-conversations\.active\) #cc-luna-global-pause\{display:none!important\}/.test(shellSrc)
    && !/luna-global-pause-switch/.test(shellSrc)
    && !/Pause Luna Globally/.test(shellSrc));
  ok('Reset Luna / Full Wipe stay in thread HTML behind overflow',
    threadSrc.includes('Reset Luna session')
    && threadSrc.includes('Full Wipe (testing)')
    && /class="detail-conv-toolbar inbox-dev-overflow"/.test(threadSrc)
    && /#tab-conversations \.detail-conv-toolbar\{display:none!important\}/.test(shellSrc)
    && /#tab-conversations \.detail-conv-toolbar\.inbox-dev-overflow\{display:block!important/.test(shellSrc));
}

console.log('\n── guest card ──');
ok('Create booking is a forest pill class; Edit profile stays a text action',
  /class="btn inbox-guest-create-booking" id="inbox-create-booking-for-guest"/.test(contextSrc)
  && /id="inbox-edit-profile"/.test(contextSrc)
  && /background:#2F4A3E/.test(contextSrc)
  && !/--inbox-forest/.test(contextSrc));
ok('stay facts helper is unchanged',
  /function inboxContextStayFacts\(/.test(contextSrc)
  && /Checked in/.test(contextSrc)
  && /facts\.push\('Paid ' \+ paid\)/.test(contextSrc));
ok('theme restyles the create pill without inventing euros',
  /#inbox-shell \.inbox-guest-actions \.btn\.inbox-guest-create-booking\{/.test(shellSrc));

console.log('\n── stay off ──');
ok('staff-query-api.js has no thread-mockup markup pasted in',
  !/inbox-whatsapp-draft-in-timeline/.test(apiSrc)
  && !/inbox-thread-day/.test(apiSrc)
  && !/inbox-guest-create-booking/.test(apiSrc)
  && apiSrc.includes('INJECT:inbox-thread'));
ok('no Graph sendMail or WhatsApp Cloud send from thread/draft/luna modules',
  !/sendMail/.test(draftSrc) && !/sendMail/.test(lunaSrc) && !/sendMail/.test(threadSrc)
  && !/graph\.microsoft/.test(draftSrc)
  && !/_patched_whatsapp_cloud_send/.test(draftSrc)
  && !/⌘K|\+ New/.test(threadSrc));
ok('package.json and luna-all register this gate',
  pkg.scripts && pkg.scripts['verify:inbox-thread-mockup'] === 'node scripts/verify-inbox-thread-mockup.js'
  && /verify-inbox-thread-mockup\.js/.test(lunaAllSrc)
  && /verify:inbox-thread-mockup/.test(lunaAllSrc));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-thread-mockup — FAILED');
  process.exit(1);
}
console.log('verify:inbox-thread-mockup — ALL CHECKS PASSED');
process.exit(0);
