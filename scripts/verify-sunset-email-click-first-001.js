'use strict';

/**
 * BUILD-SUNSET-EMAIL-CLICK-FIRST-001
 * Sunset Admin Email mirrors Wolfhouse click-first UX:
 * - Empty Microsoft/Gmail/IMAP cards: Connect only (no fields above Connect).
 * - Microsoft/Gmail: click → prompt for address → existing OAuth prepare/start.
 * - IMAP: click → email + password; Advanced (collapsed) for host/port/username.
 * - IMAP submit still POSTs identity register (/smtp/endpoint), not /smtp/connect.
 * - No send/outbound/automation; Wolfhouse path unchanged.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

assert.match(uiSrc, /function isAdminEmailClickFirstUi/);
assert.match(uiSrc, /adminEmailImapPromptOpen/);
assert.match(uiSrc, /data-wh-email="mailbox-password"/);
assert.match(uiSrc, /data-wh-email-advanced/);
assert.match(uiSrc, /postSmtpIdentityRegister/);
assert.match(uiSrc, /\/staff\/admin\/email-settings\/smtp\/endpoint/);
assert.doesNotMatch(uiSrc, /type="password"/);
assert.match(uiSrc, /'password'/);
assert.ok(!uiSrc.includes('inbox-thread'));

function cardHtml(html, provider) {
  const start = html.indexOf('data-email-provider="' + provider + '"');
  assert.ok(start >= 0, 'missing card ' + provider);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', from + 8);
  return html.slice(from, next === -1 ? html.length : next);
}

function parseInput(attrs) {
  const node = {
    value: '',
    disabled: false,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
  };
  const value = /(?:^|\s)value="([^"]*)"/.exec(attrs);
  if (value) node.value = value[1];
  return node;
}

function makeImapSection(html) {
  const fields = {};
  let prepare = null;
  const inputRe = /<input([^>]*)>/g;
  let m;
  while ((m = inputRe.exec(html))) {
    const attrs = m[1];
    const node = parseInput(attrs);
    if (/data-email-prepare-address/.test(attrs)) prepare = node;
    const named = /data-wh-email="([^"]+)"/.exec(attrs);
    if (named) fields[named[1]] = node;
  }
  const clickers = [];
  const btn = {
    disabled: false,
    textContent: '',
    getAttribute(name) {
      const hit = html.match(/<button[^>]*data-email-connect="[^"]+"[^>]*>/);
      if (!hit) return null;
      const attr = hit[0].match(new RegExp(name + '="([^"]*)"'));
      return attr ? attr[1] : null;
    },
    addEventListener(type, fn) { if (type === 'click') clickers.push(fn); },
    click() { clickers.forEach((fn) => fn()); },
  };
  const label = html.match(/<button[^>]*data-email-connect="[^"]+"[^>]*>([^<]*)</);
  if (label) btn.textContent = label[1];
  const details = {
    open: /data-wh-email-advanced open/.test(html),
    addEventListener() {},
  };
  return {
    className: 'portal-admin-email-settings portal-admin-email-card',
    html,
    fields,
    prepare,
    btn,
    getAttribute(name) { return name === 'data-email-provider' ? 'imap_smtp' : null; },
    querySelector(sel) {
      if (sel === '[data-email-connect]') return /data-email-connect="/.test(html) ? btn : null;
      if (sel === '[data-email-prepare-address]') return prepare;
      if (sel === '[data-wh-email-advanced]') return /data-wh-email-advanced/.test(html) ? details : null;
      if (sel === '[data-email-disconnect]') return null;
      const named = /\[data-wh-email="([^"]+)"\]/.exec(sel);
      if (named) return fields[named[1]] || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-wh-email]') return Object.values(fields);
      return [];
    },
  };
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
      const providers = [...String(v).matchAll(/data-email-provider="([^"]+)"/g)].map((row) => row[1]);
      providers.forEach((p) => {
        const html = cardHtml(el._html, p);
        if (p === 'imap_smtp') {
          children.push(makeImapSection(html));
          return;
        }
        const clickers = [];
        const btn = {
          disabled: false,
          textContent: '',
          getAttribute(name) {
            const hit = html.match(/<button[^>]*data-email-connect="[^"]+"[^>]*>/);
            if (!hit) return null;
            const attr = hit[0].match(new RegExp(name + '="([^"]*)"'));
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
            if (sel === '[data-email-prepare-address]') return null;
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
      prompt(msg) { prompts.push(String(msg)); return null; },
      confirm() { return true; },
    },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    getClient() { return client; },
    fetch(url, opts) {
      fetches.push({ url, body: opts && opts.body, method: opts && opts.method });
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { body, sandbox, prompts, fetches };
}

const LOCATION = 'sunset-somo';
const emptyLive = {
  actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    gmail_api: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: true, connect: false, disconnect: false, reauthorize: false },
  },
  smtp_secret_status: { configured: true, missing_secret_names: [] },
  locations: [{ location_id: LOCATION, active: true }],
  endpoints: [],
};

const sunset = boot('sunset');
sunset.sandbox.renderAdminEmailSettingsData(emptyLive);
let html = sunset.body.innerHTML;
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
assert.match(imap, /Click Connect to enter your mailbox email and password/);
assert.doesNotMatch(html, /Coming soon/);
assert.doesNotMatch(html, /Register mailbox/);

const msCard = sunset.body.children.find((c) => c.getAttribute('data-email-provider') === 'microsoft_graph');
msCard.querySelector('[data-email-connect]').click();
assert.equal(sunset.fetches.length, 0);
assert.equal(sunset.prompts.length, 1);
assert.match(sunset.prompts[0], /Microsoft email address|Enter a Microsoft/);

const imapCard = sunset.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
imapCard.btn.click();
assert.equal(sunset.fetches.length, 0);
html = sunset.body.innerHTML;
const imapPrompt = cardHtml(html, 'imap_smtp');
assert.match(imapPrompt, /data-email-prepare-address/);
assert.match(imapPrompt, /data-wh-email="mailbox-password"/);
assert.match(imapPrompt, /data-wh-email-advanced/);
assert.doesNotMatch(imapPrompt, /data-wh-email-advanced open/);
assert.match(imapPrompt, /data-wh-email="smtp-server"/);
assert.match(imapPrompt, /data-wh-email="imap-user"/);
assert.match(imapPrompt, /type="password"/);
assert.match(imapPrompt, /Enter the mailbox email and password/);
assert.doesNotMatch(cardHtml(html, 'microsoft_graph'), /data-email-prepare-address/);
assert.doesNotMatch(cardHtml(html, 'gmail_api'), /data-email-prepare-address/);

sunset.sandbox.portalLang = 'es';
sunset.sandbox.adminEmailImapPromptOpen = true;
sunset.sandbox.renderAdminEmailSettingsData(emptyLive);
assert.match(cardHtml(sunset.body.innerHTML, 'imap_smtp'), />Avanzado</);
assert.match(cardHtml(sunset.body.innerHTML, 'imap_smtp'), /Contraseña/);
assert.match(cardHtml(sunset.body.innerHTML, 'imap_smtp'), /Conectar IMAP \/ SMTP/);

sunset.sandbox.portalLang = 'en';
sunset.sandbox.adminEmailImapPromptOpen = true;
sunset.sandbox.adminEmailImapAdvancedOpen = true;
sunset.sandbox.renderAdminEmailSettingsData(emptyLive);
assert.match(cardHtml(sunset.body.innerHTML, 'imap_smtp'), /data-wh-email-advanced open/);
sunset.sandbox.adminEmailImapAdvancedOpen = false;

function fillImapAndConnect(clientBoot, email, password) {
  clientBoot.sandbox.adminEmailImapPromptOpen = true;
  clientBoot.sandbox.renderAdminEmailSettingsData(emptyLive);
  const card = clientBoot.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
  card.prepare.value = email;
  card.fields['mailbox-password'].value = password;
  card.btn.click();
  return card;
}

const registerBoot = boot('sunset');
fillImapAndConnect(registerBoot, 'desk@sunset.example', 'not-sent-to-register');
assert.equal(registerBoot.fetches.length, 1);
assert.equal(registerBoot.fetches[0].url, '/staff/admin/email-settings/smtp/endpoint');
const posted = JSON.parse(registerBoot.fetches[0].body);
assert.equal(posted.location_id, LOCATION);
assert.equal(posted.public_address, 'desk@sunset.example');
assert.equal(Object.keys(posted).sort().join(','), 'location_id,public_address');
assert.doesNotMatch(JSON.stringify(posted), /not-sent-to-register|password|smtp|imap/);

const emptyAddr = boot('sunset');
fillImapAndConnect(emptyAddr, '', 'secret');
assert.equal(emptyAddr.fetches.length, 0);
assert.match(cardHtml(emptyAddr.body.innerHTML, 'imap_smtp'), /data-email-prepare-hint|Enter the mailbox email and password/);

// Wolfhouse still uses /smtp/connect (no Sunset regression in shared file).
const wolf = boot('wolfhouse-somo');
fillImapAndConnect(wolf, 'frontdesk@example.test', 'one-shared-secret');
assert.equal(wolf.fetches.length, 1);
assert.equal(wolf.fetches[0].url, '/staff/admin/email-settings/smtp/connect');

console.log('PASS BUILD-SUNSET-EMAIL-CLICK-FIRST-001');
