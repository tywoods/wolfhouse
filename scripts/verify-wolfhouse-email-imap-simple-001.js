'use strict';

/**
 * BUILD-WOLFHOUSE-EMAIL-IMAP-SIMPLE-001 / CLICK-FIRST-001
 * Empty Wolfhouse IMAP card: Connect only. Click then email + one password.
 * Advanced (collapsed) holds SMTP/IMAP host, ports, usernames.
 * Connect still POSTs /smtp/connect. Fail closed. Sunset + OAuth cards stay put.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

assert.doesNotMatch(uiSrc, /type="password"/);
assert.match(uiSrc, /'password'/);
assert.match(uiSrc, /data-wh-email="mailbox-password"/);
assert.match(uiSrc, /data-wh-email-advanced/);
assert.match(uiSrc, /adminEmailGuessImapHost/);
assert.match(uiSrc, /readWolfhouseSmtpImapConnectPayload/);
assert.doesNotMatch(uiSrc, /data-wh-email-credentials/);
assert.ok(!uiSrc.includes('inbox-thread'));
assert.match(apiSrc, /\[data-wh-email-advanced\]/);

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
    open: /\sopen[>=]/.test(html) && /data-wh-email-advanced/.test(html) && /data-wh-email-advanced open/.test(html),
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
  const fetches = [];
  const sandbox = {
    URL,
    Date,
    window: {
      location: { assign() {} },
      prompt() { return null; },
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
  return { body, sandbox, fetches };
}

const emptyDto = {
  actions: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  provider_actions: {
    microsoft_graph: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    gmail_api: { prepare: false, connect: false, disconnect: false, reauthorize: false },
    imap_smtp: { prepare: false, connect: false, disconnect: false, reauthorize: false },
  },
  locations: [{ location_id: 'wolfhouse-somo', active: true }],
  endpoints: [],
};

const sunset = boot('sunset');
sunset.sandbox.renderAdminEmailSettingsData(emptyDto);
assert.doesNotMatch(sunset.body.innerHTML, /mailbox-password/);
assert.doesNotMatch(sunset.body.innerHTML, /data-wh-email-advanced/);
assert.doesNotMatch(sunset.body.innerHTML, /Connect IMAP \/ SMTP/);

const wolf = boot('wolfhouse-somo');
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
let html = wolf.body.innerHTML;
const imap = cardHtml(html, 'imap_smtp');
assert.doesNotMatch(imap, /data-email-prepare-address/);
assert.doesNotMatch(imap, /mailbox-password/);
assert.doesNotMatch(imap, /data-wh-email-advanced/);
assert.doesNotMatch(imap, /smtp-server/);
assert.match(imap, /Click Connect to enter your mailbox email and password/);
assert.doesNotMatch(cardHtml(html, 'microsoft_graph'), /data-email-prepare-address/);
assert.doesNotMatch(cardHtml(html, 'gmail_api'), /data-email-prepare-address/);
assert.match(cardHtml(html, 'microsoft_graph'), /Connect Microsoft email/);
assert.match(cardHtml(html, 'gmail_api'), /Connect Google email/);

const emptyImapBtn = wolf.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
emptyImapBtn.btn.click();
assert.equal(wolf.fetches.length, 0);
html = wolf.body.innerHTML;
assert.match(cardHtml(html, 'imap_smtp'), /data-email-prepare-address/);
assert.match(cardHtml(html, 'imap_smtp'), /data-wh-email="mailbox-password"/);
assert.match(cardHtml(html, 'imap_smtp'), /<details class="portal-admin-email-advanced" data-wh-email-advanced>/);
assert.doesNotMatch(cardHtml(html, 'imap_smtp'), /data-wh-email-advanced open/);
assert.match(cardHtml(html, 'imap_smtp'), />Advanced</);
assert.match(cardHtml(html, 'imap_smtp'), /value="587"/);
assert.match(cardHtml(html, 'imap_smtp'), /value="993"/);
assert.doesNotMatch(cardHtml(html, 'imap_smtp'), /data-wh-email="smtp-password"/);
assert.doesNotMatch(cardHtml(html, 'imap_smtp'), /data-wh-email="imap-password"/);
assert.doesNotMatch(cardHtml(html, 'microsoft_graph'), /data-email-prepare-address/);
assert.doesNotMatch(cardHtml(html, 'gmail_api'), /data-email-prepare-address/);

wolf.sandbox.portalLang = 'es';
wolf.sandbox.adminEmailImapPromptOpen = true;
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
assert.match(cardHtml(wolf.body.innerHTML, 'imap_smtp'), />Avanzado</);
assert.match(cardHtml(wolf.body.innerHTML, 'imap_smtp'), /Contraseña/);

wolf.sandbox.portalLang = 'en';
wolf.sandbox.adminEmailImapPromptOpen = true;
wolf.sandbox.adminEmailImapAdvancedOpen = true;
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
assert.match(cardHtml(wolf.body.innerHTML, 'imap_smtp'), /data-wh-email-advanced open/);
wolf.sandbox.adminEmailImapAdvancedOpen = false;

function fillAndConnect(clientBoot, email, password, extra) {
  clientBoot.sandbox.adminEmailImapPromptOpen = true;
  clientBoot.sandbox.renderAdminEmailSettingsData(emptyDto);
  const card = clientBoot.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
  card.prepare.value = email;
  card.fields['mailbox-password'].value = password;
  if (extra) Object.keys(extra).forEach((k) => { card.fields[k].value = extra[k]; });
  card.btn.click();
  return card;
}

fillAndConnect(wolf, 'frontdesk@example.test', 'one-shared-secret');
assert.equal(wolf.fetches.length, 1);
assert.equal(wolf.fetches[0].url, '/staff/admin/email-settings/smtp/connect');
const posted = JSON.parse(wolf.fetches[0].body);
assert.equal(posted.public_address, 'frontdesk@example.test');
assert.equal(posted.smtp.user, 'frontdesk@example.test');
assert.equal(posted.imap.user, 'frontdesk@example.test');
assert.equal(posted.smtp.password, 'one-shared-secret');
assert.equal(posted.imap.password, 'one-shared-secret');
assert.equal(posted.smtp.port, 587);
assert.equal(posted.imap.port, 993);
assert.equal(posted.smtp.tls, 'starttls');
assert.equal(posted.imap.tls, 'tls');
assert.equal(posted.smtp.server, 'smtp.example.test');
assert.equal(posted.imap.server, 'imap.example.test');
assert.doesNotMatch(wolf.body.innerHTML, /Connected as/);

const gmailWolf = boot('wolfhouse-somo');
fillAndConnect(gmailWolf, 'desk@gmail.com', 'app-pass');
const gmailPosted = JSON.parse(gmailWolf.fetches[0].body);
assert.equal(gmailPosted.smtp.server, 'smtp.gmail.com');
assert.equal(gmailPosted.imap.server, 'imap.gmail.com');

const emptyPw = boot('wolfhouse-somo');
fillAndConnect(emptyPw, 'frontdesk@example.test', '');
assert.equal(emptyPw.fetches.length, 0);
assert.match(cardHtml(emptyPw.body.innerHTML, 'imap_smtp'), /data-email-prepare-hint|Enter the mailbox email and password/);

const advanced = boot('wolfhouse-somo');
fillAndConnect(advanced, 'desk@custom.test', 'secret', {
  'smtp-server': 'mail.custom.test',
  'imap-server': 'imap.custom.test',
  'smtp-user': 'smtp-user@custom.test',
  'imap-user': 'imap-user@custom.test',
});
const advPosted = JSON.parse(advanced.fetches[0].body);
assert.equal(advPosted.smtp.server, 'mail.custom.test');
assert.equal(advPosted.imap.server, 'imap.custom.test');
assert.equal(advPosted.smtp.user, 'smtp-user@custom.test');
assert.equal(advPosted.imap.user, 'imap-user@custom.test');
assert.equal(advPosted.smtp.password, 'secret');
assert.equal(advPosted.imap.password, 'secret');

console.log('PASS BUILD-WOLFHOUSE-EMAIL-IMAP-SIMPLE-001');
