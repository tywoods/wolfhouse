'use strict';

/**
 * BUILD-WOLFHOUSE-EMAIL-CONNECT-BUTTONS-001
 * Wolfhouse Admin Email: Connect on Microsoft, Gmail, and IMAP when empty.
 * No address/host fields above Connect. Click then prompt (IMAP form) or OAuth.
 * Sunset Gmail/IMAP coming-soon chrome stays put.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

assert.match(uiSrc, /function isWolfhouseEmailUi/);
assert.match(uiSrc, /Connect IMAP \/ SMTP/);
assert.match(uiSrc, /Conectar IMAP \/ SMTP/);
assert.match(uiSrc, /adminEmailImapPromptOpen/);
assert.match(uiSrc, /window\.prompt/);
assert.match(uiSrc, /disconnectClient === 'sunset' \|\| disconnectClient === 'wolfhouse-somo'/);
assert.doesNotMatch(uiSrc, /type="password"/);
assert.match(uiSrc, /'password'/);
assert.match(uiSrc, /Coming soon/);
assert.match(uiSrc, /Próximamente/);
assert.ok(!uiSrc.includes('inbox-thread'));

function cardHtml(html, provider) {
  const start = html.indexOf('data-email-provider="' + provider + '"');
  assert.ok(start >= 0, 'missing card ' + provider);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', from + 8);
  return html.slice(from, next === -1 ? html.length : next);
}

function makeBody() {
  const children = [];
  const el = {
    id: 'admin-email-settings-body',
    _html: '',
    children,
    querySelector(sel) {
      if (sel === '.portal-admin-email-settings') return children[0] || null;
      const m = /data-email-provider="([^"]+)"/.exec(sel);
      if (m) return children.find((c) => c.getAttribute('data-email-provider') === m[1]) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.portal-admin-email-settings') return children.slice();
      return [];
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      children.length = 0;
      const providers = [...String(v).matchAll(/data-email-provider="([^"]+)"/g)].map((m) => m[1]);
      providers.forEach((p) => {
        const html = cardHtml(el._html, p);
        const clickers = [];
        const btn = {
          disabled: false,
          textContent: '',
          getAttribute(name) {
            const re = new RegExp(name + '="([^"]*)"');
            const hit = html.match(/<button[^>]*data-email-connect="[^"]+"[^>]*>/);
            if (!hit) return null;
            const attr = hit[0].match(re);
            return attr ? attr[1] : null;
          },
          addEventListener(type, fn) { if (type === 'click') clickers.push(fn); },
          click() { clickers.forEach((fn) => fn()); },
        };
        const label = html.match(/<button[^>]*data-email-connect="[^"]+"[^>]*>([^<]*)</);
        if (label) btn.textContent = label[1];
        children.push({
          className: 'portal-admin-email-settings portal-admin-email-card',
          html,
          getAttribute(name) { return name === 'data-email-provider' ? p : null; },
          querySelector(sel) {
            if (sel === '[data-email-connect]') return /data-email-connect="/.test(html) ? btn : null;
            if (sel === '[data-email-prepare-address]') {
              return /data-email-prepare-address/.test(html) ? { value: '' } : null;
            }
            if (sel === '[data-email-disconnect]') return /data-email-disconnect="/.test(html) ? { disabled: false, getAttribute() { return ''; }, addEventListener() {} } : null;
            return null;
          },
          querySelectorAll() { return []; },
        });
      });
    },
  });
  return el;
}

function boot(client) {
  const body = makeBody();
  const prompts = [];
  const fetches = [];
  const sandbox = {
    URL,
    Date,
    window: {
      location: { assign() {} },
      prompt(msg) { prompts.push(msg); return null; },
      confirm() { return true; },
    },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    getClient() { return client; },
    fetch(url, opts) {
      fetches.push([url, opts && opts.body]);
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox, prompts, fetches };
}

const emptyDto = {
  actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [],
  endpoints: [],
};

const sunset = boot('sunset');
sunset.sandbox.renderAdminEmailSettingsData(emptyDto);
let html = sunset.body.innerHTML;
assert.match(html, /data-email-provider="microsoft_graph"/);
assert.match(html, /data-email-provider="gmail_api"/);
assert.match(html, /data-email-provider="imap_smtp"/);
assert.match(html, /Coming soon/);
assert.match(cardHtml(html, 'gmail_api'), /Coming soon|Próximamente|Not available yet|Aún no disponible/);
assert.doesNotMatch(cardHtml(html, 'gmail_api'), /data-email-connect=/);
assert.doesNotMatch(html, /Connect Google email/);
assert.doesNotMatch(html, /Connect IMAP \/ SMTP/);
assert.doesNotMatch(html, /data-wh-email-credentials/);
assert.doesNotMatch(html, /data-wh-email-advanced/);
assert.doesNotMatch(html, /mailbox-password/);
assert.match(html, /not available in this release|admin\.email\.actionsUnavailable/);

const wolf = boot('wolfhouse-somo');
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
html = wolf.body.innerHTML;
const ms = cardHtml(html, 'microsoft_graph');
const gmail = cardHtml(html, 'gmail_api');
const imap = cardHtml(html, 'imap_smtp');
assert.match(ms, /data-email-connect="prepare"/);
assert.match(gmail, /data-email-connect="prepare"/);
assert.match(imap, /data-email-connect="prepare"/);
assert.match(ms, /Connect Microsoft email/);
assert.match(gmail, /Connect Google email/);
assert.match(imap, /Connect IMAP \/ SMTP/);
assert.doesNotMatch(ms, /data-email-prepare-address/);
assert.doesNotMatch(gmail, /data-email-prepare-address/);
assert.doesNotMatch(imap, /data-email-prepare-address/);
assert.doesNotMatch(imap, /mailbox-password/);
assert.doesNotMatch(imap, /data-wh-email-advanced/);
assert.doesNotMatch(imap, /smtp-server/);
assert.doesNotMatch(imap, /data-wh-email-credentials/);
assert.match(imap, /Click Connect to enter your mailbox email and password/);
assert.doesNotMatch(html, /Coming soon/);
assert.doesNotMatch(html, /Próximamente/);
assert.doesNotMatch(html, /Not available yet/);
assert.doesNotMatch(html, /Aún no disponible/);
assert.doesNotMatch(html, /not available in this release/);
assert.doesNotMatch(html, /data-email-actions-unavailable/);

wolf.sandbox.portalLang = 'es';
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
html = wolf.body.innerHTML;
assert.match(cardHtml(html, 'microsoft_graph'), /Conectar email de Microsoft/);
assert.match(cardHtml(html, 'gmail_api'), /Conectar email de Google/);
assert.match(cardHtml(html, 'imap_smtp'), /Conectar IMAP \/ SMTP/);
assert.match(cardHtml(html, 'imap_smtp'), /Pulsa Conectar para introducir el email y la contraseña del buzón/);
assert.doesNotMatch(cardHtml(html, 'imap_smtp'), /data-email-prepare-address/);
assert.doesNotMatch(html, /Próximamente/);
assert.doesNotMatch(html, /Coming soon/);

wolf.sandbox.portalLang = 'en';
wolf.sandbox.adminEmailImapPromptOpen = true;
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
const imapPrompt = cardHtml(wolf.body.innerHTML, 'imap_smtp');
assert.match(imapPrompt, /data-email-prepare-address/);
assert.match(imapPrompt, /data-wh-email="mailbox-password"/);
assert.match(imapPrompt, /data-wh-email-advanced/);
assert.doesNotMatch(imapPrompt, /data-wh-email-advanced open/);
assert.match(imapPrompt, /data-wh-email="smtp-server"/);
assert.match(imapPrompt, /type="password"/);
assert.match(imapPrompt, /Connect IMAP \/ SMTP/);
assert.match(imapPrompt, /Enter the mailbox email and password/);
assert.doesNotMatch(cardHtml(wolf.body.innerHTML, 'microsoft_graph'), /data-email-prepare-address/);
assert.doesNotMatch(cardHtml(wolf.body.innerHTML, 'gmail_api'), /data-email-prepare-address/);

wolf.sandbox.adminEmailImapAdvancedOpen = true;
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
assert.match(cardHtml(wolf.body.innerHTML, 'imap_smtp'), /data-wh-email-advanced open/);

const connected = {
  actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'wolfhouse-somo', active: true }],
  endpoints: [{
    provider: 'microsoft_graph',
    location_id: 'wolfhouse-somo',
    endpoint_id: '11111111-1111-4111-8111-111111111111',
    public_address: 'desk@wolfhouse.example',
    connection_state: 'connected_health',
  }],
};
wolf.sandbox.adminEmailImapPromptOpen = false;
wolf.sandbox.adminEmailImapAdvancedOpen = false;
wolf.sandbox.renderAdminEmailSettingsData(connected);
html = wolf.body.innerHTML;
assert.match(cardHtml(html, 'microsoft_graph'), /data-email-disconnect=/);
assert.match(cardHtml(html, 'microsoft_graph'), /Disconnect Microsoft/);
assert.match(cardHtml(html, 'gmail_api'), /Connect Google email/);
assert.match(cardHtml(html, 'imap_smtp'), /Connect IMAP \/ SMTP/);
assert.doesNotMatch(html, /Coming soon/);

console.log('PASS BUILD-WOLFHOUSE-EMAIL-CONNECT-BUTTONS-001');
