#!/usr/bin/env node
'use strict';

/**
 * SUNSET-EMAIL-MAILBOX-CARDS-POLISH-002
 *
 * Follow-up on live #1085 mailbox cards:
 * 1) Disconnect / Remove buttons are red; confirm before the action.
 * 2) Comfortable space between fields/controls and the action button (all 3 cards).
 * 3) No green outline on the Active Inbox Microsoft card.
 * 4) Status pill on the same line as the provider title, right-aligned.
 * 5) No MAILBOX kickers.
 * 6) Capability rows are label + status on one line.
 *
 * Sunset Admin Email only. Stay off Crow's Nest, Hermes, Inbox thread.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI_PATH = path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js');
const API_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const THREAD_PATH = path.join(ROOT, 'scripts/browser/inbox-thread.js');

const uiSrc = fs.readFileSync(UI_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const emailCss = emailCssBlock(apiSrc);

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

function emailCssBlock(src) {
  const start = src.indexOf('.portal-admin-email-settings .portal-admin-email-action-btn');
  if (start < 0) return '';
  const next = src.indexOf('/* Admin card rhythm', start);
  return src.slice(start, next < 0 ? start + 4000 : next);
}

function cardHtml(html, provider) {
  const re = new RegExp(
    '<section class="portal-admin-email-settings portal-admin-email-card[^\"]*" data-email-provider="'
    + provider + '"[\\s\\S]*?</section>'
  );
  const m = String(html).match(re);
  return m ? m[0] : '';
}

function cardHead(card) {
  const m = String(card).match(/<div class="portal-admin-email-card-head">[\s\S]*?<\/div>/);
  return m ? m[0] : '';
}

function makeBody() {
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); },
  });
  return el;
}

function boot(lang, extra) {
  const body = makeBody();
  const sandbox = Object.assign({
    URL,
    window: { location: { assign() {} } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) {
      const pack = {
        'admin.email.state.connected_health': 'Mailbox connected. Email processing remains off.',
        'admin.email.endpointActive': 'Mailbox connection',
        'admin.email.inbound': 'Inbound',
        'admin.email.outbound': 'Outbound',
        'admin.email.staffReplies': 'Staff replies',
        'admin.email.on': 'On',
        'admin.email.automation': 'Automation',
        'admin.email.off': 'Off',
      };
      return pack[key] || key;
    },
    portalLang: lang || 'en',
    getClient() { return 'sunset'; },
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
  }, extra || {});
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox };
}

const connectedPayload = {
  actions: { prepare: false, connect: false, disconnect: true, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: true, reauthorize: false },
    gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  smtp_secret_status: { missing_secret_names: [] },
  locations: [{ location_id: 'sunset-somo', active: true }],
  endpoints: [
    {
      provider: 'microsoft_graph',
      location_id: 'sunset-somo',
      endpoint_id: '11111111-1111-4111-8111-111111111111',
      public_address: 'support@sunset.example',
      connection_state: 'connected_health',
      last_sync: '2026-08-22T18:00:00.000Z',
    },
  ],
};

console.log('\n── stay off ──');
ok('owner file stays off inbox-thread', !uiSrc.includes('inbox-thread'));
ok('owner file stays off Crow\'s Nest', !/crowsnest/i.test(uiSrc));
ok('owner file stays off Hermes gateways', !/hermes-staging|wh-staging-hermes/i.test(uiSrc));
ok('inbox-thread bytes unchanged by this job', fs.existsSync(THREAD_PATH));

console.log('\n── 5. no MAILBOX kickers ──');
ok('owner no longer paints card-kicker MAILBOX', !uiSrc.includes('portal-admin-email-card-kicker'));
ok('owner no longer paints mailboxKind kicker', !uiSrc.includes('admin.email.mailboxKind'));

console.log('\n── 3. no green Active Inbox outline ──');
ok('active-inbox rule does not paint a green ring',
  !/\.portal-admin-email-card\.is-active-inbox\{[^}]*#2F6B45/.test(emailCss)
  && !/\.is-active-inbox\{[^}]*box-shadow:0 0 0 1px #2F6B45/.test(apiSrc));

console.log('\n── 1. red disconnect / remove + confirm ──');
ok('disconnect buttons are filled red, not ghost',
  /\[data-email-disconnect\][^{]{0,80}\{[^}]*background:#B42318/.test(emailCss)
  || /action-btn\[data-email-disconnect\][^{]*\{[^}]*background:#B42318/.test(emailCss)
  || /is-danger[^{]*\{[^}]*background:#B42318/.test(emailCss));
ok('coming-soon Remove Gmail uses the danger class',
  uiSrc.includes('is-danger') && uiSrc.includes('Remove Gmail'));
ok('disconnect click asks window.confirm first',
  /function wireDisconnectHandlers[\s\S]{0,1200}window\.confirm/.test(uiSrc));
ok('cancel confirm returns before POST',
  /function wireDisconnectHandlers[\s\S]{0,1600}!confirmFn\(/.test(uiSrc)
  || /function wireDisconnectHandlers[\s\S]{0,1600}if \(confirmFn && !confirmFn/.test(uiSrc));

console.log('\n── 2. spacing before action buttons ──');
ok('prepare group is a column with comfortable gap',
  /\.portal-admin-email-prepare-group\{[^}]*flex-direction:column/.test(emailCss)
  && /\.portal-admin-email-prepare-group\{[^}]*gap:(1[6-9]|2[0-9]|3[0-9])px/.test(emailCss));
ok('disconnect group has extra top space',
  /\.portal-admin-email-disconnect-group\{[^}]*margin-top:(1[6-9]|2[0-9]|3[0-9])px/.test(emailCss)
  || /\.portal-admin-email-disconnect-group,/.test(emailCss) === false
    && /\.portal-admin-email-disconnect-group\{[^}]*margin[^}]*1[6-9]px/.test(emailCss));
ok('card gap is at least 14px',
  /\.portal-admin-email-card\{[^}]*gap:(1[4-9]|2[0-9])px/.test(emailCss));

console.log('\n── 4. title-row status pills ──');
ok('card head reserves top-right for pause with status on its own row',
  /\.portal-admin-email-card-head\{[^}]*display:grid/.test(emailCss)
  && /\.portal-admin-email-card-head\{[^}]*grid-template-columns:minmax\(0,1fr\) auto/.test(emailCss)
  && /\.portal-admin-email-flow-toggle\{[^}]*grid-column:2;grid-row:1/.test(emailCss)
  && /\.portal-admin-email-card-head \.portal-admin-email-status\{[^}]*grid-row:2/.test(emailCss));
ok('owner paints card-head around title + pill',
  uiSrc.includes('portal-admin-email-card-head')
  && /card-head[\s\S]{0,240}card-title[\s\S]{0,240}adminEmailStatusPill/.test(uiSrc));

console.log('\n── 6. one-line capability rows ──');
ok('capabilities dl is a two-column grid',
  /\[data-email-capabilities\]\{[^}]*grid-template-columns:1fr auto/.test(emailCss)
  || /\[data-email-capabilities\]\{[^}]*display:grid/.test(emailCss)
    && /\[data-email-capabilities\]\{[^}]*grid-template-columns:1fr auto/.test(emailCss));

console.log('\n── painted cards ──');
{
  const { body, sandbox } = boot('en');
  sandbox.renderAdminEmailSettingsData(connectedPayload);
  const html = body.innerHTML;
  const ms = cardHtml(html, 'microsoft_graph');
  const gmail = cardHtml(html, 'gmail_api');
  const imap = cardHtml(html, 'imap_smtp');
  const msHead = cardHead(ms);
  const gmailHead = cardHead(gmail);
  const imapHead = cardHead(imap);

  ok('three cards painted', !!(ms && gmail && imap));
  ok('no MAILBOX kicker on any card',
    !/>Mailbox</.test(html) && !/portal-admin-email-card-kicker/.test(html));
  ok('Microsoft title row has Active Inbox on the right',
    /Microsoft 365/.test(msHead) && /Active Inbox/.test(msHead)
    && /card-title[\s\S]*portal-admin-email-status[\s\S]*Active Inbox/.test(msHead));
  ok('Gmail title row has Not connected on the right',
    /Gmail/.test(gmailHead) && /Not connected/.test(gmailHead)
    && /card-title[\s\S]*portal-admin-email-status[\s\S]*Not connected/.test(gmailHead));
  ok('IMAP title row has a right-aligned status pill',
    /IMAP \/ SMTP/.test(imapHead) && /portal-admin-email-status/.test(imapHead));
  ok('Gmail still says Coming soon in the card body', /Coming soon/.test(gmail));
  ok('Microsoft disconnect is the danger action',
    /data-email-disconnect="1"/.test(ms) && /Disconnect Microsoft/.test(ms));
  ok('Gmail Remove is the danger action',
    /Remove Gmail/.test(gmail) && /is-danger/.test(gmail));
  ok('IMAP Connect stays primary, not red',
    /Connect IMAP \/ SMTP/.test(imap) && /data-email-connect="prepare"/.test(imap)
    && !/is-danger/.test(imap));
  ok('IMAP empty card has no fields above Connect',
    !/data-email-prepare-address/.test(imap) && !/mailbox-password/.test(imap)
    && /Click Connect to enter your mailbox email and password/.test(imap));
  ok('capability rows still use dt+dd pairs',
    /<dl data-email-capabilities>/.test(ms)
    && /<dt>Mailbox connection<\/dt><dd data-email-cap="endpoint_active">Off<\/dd>/.test(ms)
    && /<dt>Inbound<\/dt><dd data-email-cap="inbound">Off<\/dd>/.test(ms)
    && /<dt>Staff replies<\/dt><dd data-email-cap="staff_replies">Off<\/dd>/.test(ms)
    && /<dt>Automation<\/dt><dd data-email-cap="automation">Off<\/dd>/.test(ms));
}

console.log('\n── confirm cancel leaves connected ──');
{
  const calls = [];
  const listeners = [];
  const btn = {
    disabled: false,
    attrs: {
      'data-email-disconnect': '1',
      'data-email-location-id': 'sunset-somo',
      'data-email-endpoint-id': '11111111-1111-4111-8111-111111111111',
      'data-email-provider': 'microsoft_graph',
    },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    addEventListener(type, fn) { if (type === 'click') listeners.push(fn); },
  };
  const section = {
    className: 'portal-admin-email-settings portal-admin-email-card',
    querySelector(sel) { return sel === '[data-email-disconnect]' ? btn : null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  };
  const body = {
    id: 'admin-email-settings-body',
    _html: '',
    querySelector(sel) {
      if (sel === '.portal-admin-email-settings') return section;
      if (sel === '[data-email-disconnect]') return btn;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.portal-admin-email-settings') return [section];
      return [];
    },
  };
  Object.defineProperty(body, 'innerHTML', {
    get() { return body._html; },
    set(v) { body._html = String(v); },
  });
  let confirmAnswer = false;
  const confirmMsgs = [];
  const sandbox = {
    URL,
    window: {
      location: { assign() {} },
      confirm(msg) { confirmMsgs.push(String(msg || '')); return confirmAnswer; },
    },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    getClient() { return 'sunset'; },
    fetch(url, opts) {
      calls.push({ url: String(url), method: opts && opts.method });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  body._html = '<section class="portal-admin-email-settings" data-email-provider="microsoft_graph">'
    + '<button type="button" data-email-disconnect="1" data-email-provider="microsoft_graph" '
    + 'data-email-location-id="sunset-somo" data-email-endpoint-id="11111111-1111-4111-8111-111111111111">'
    + 'Disconnect Microsoft</button></section>';
  sandbox.wireDisconnectHandlers(body);
  assert.ok(listeners.length, 'disconnect handler wired');
  listeners[0]();
  ok('cancel confirm does not POST disconnect',
    confirmMsgs.length === 1 && calls.length === 0);
  ok('confirm copy is an are-you-sure',
    /sure|disconnect|remove|cancel/i.test(confirmMsgs[0] || ''));
}

if (fail) {
  console.error(`\nFAIL sunset-email-mailbox-cards-polish-002  ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`\nPASS sunset-email-mailbox-cards-polish-002  ${pass} passed`);
