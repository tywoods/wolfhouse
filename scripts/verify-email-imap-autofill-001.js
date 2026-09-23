'use strict';

/**
 * WOLFHOUSE-EMAIL-IMAP-AUTOFILL-001
 * Known-domain IMAP/SMTP host+port+tls suggestions; unknown domains left alone;
 * user-edited Advanced fields are not overwritten. No live mailbox / OAuth / send.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const {
  lookupEmailImapProviderDefaults,
  suggestEmailImapAutofillPatch,
  guessEmailImapHostFromAddress,
  listEmailImapProviderDefaultRows,
  extractEmailDomain,
} = require('./lib/email-imap-provider-defaults');

const fixture = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'fixtures/email-imap-provider-defaults.json'), 'utf8')
);
const uiSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const defaultsSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-imap-provider-defaults.js'), 'utf8');
const injectSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-admin-browser-source.js'), 'utf8');

assert.match(uiSrc, /applyAdminEmailImapAutofill/);
assert.match(uiSrc, /data-user-edited/);
assert.match(uiSrc, /fillProviderDefaults/);
assert.match(uiSrc, /addEventListener\('blur'/);
assert.match(injectSrc, /email-imap-provider-defaults\.js/);
assert.doesNotMatch(uiSrc, /create-payment|createPaymentLink|Cap Create/i);

for (const row of fixture.cases) {
  const got = lookupEmailImapProviderDefaults(row.address);
  if (row.provider_id == null) {
    assert.equal(got, null, 'unknown domain must stay null: ' + row.address);
    assert.equal(suggestEmailImapAutofillPatch(row.address, {}), null);
    continue;
  }
  assert.ok(got, 'expected defaults for ' + row.address);
  assert.equal(got.id, row.provider_id);
  assert.equal(got.smtp.server, row.smtp.server);
  assert.equal(got.smtp.port, row.smtp.port);
  assert.equal(got.smtp.tls, row.smtp.tls);
  assert.equal(got.imap.server, row.imap.server);
  assert.equal(got.imap.port, row.imap.port);
  assert.equal(got.imap.tls, row.imap.tls);
  assert.equal(guessEmailImapHostFromAddress('smtp', row.address), row.smtp.server);
  assert.equal(guessEmailImapHostFromAddress('imap', row.address), row.imap.server);

  const patch = suggestEmailImapAutofillPatch(row.address, {});
  assert.equal(patch['smtp-server'], row.smtp.server);
  assert.equal(patch['smtp-port'], String(row.smtp.port));
  assert.equal(patch['imap-server'], row.imap.server);
  assert.equal(patch['imap-port'], String(row.imap.port));

  const skipServer = suggestEmailImapAutofillPatch(row.address, { 'smtp-server': true });
  assert.ok(!Object.prototype.hasOwnProperty.call(skipServer, 'smtp-server'));
  assert.equal(skipServer['imap-server'], row.imap.server);
}

assert.equal(extractEmailDomain(' Desk@Gmail.COM '), 'gmail.com');
assert.equal(extractEmailDomain('not-an-email'), '');
assert.equal(guessEmailImapHostFromAddress('smtp', 'a@custom.test'), 'smtp.custom.test');
assert.equal(guessEmailImapHostFromAddress('imap', 'a@custom.test'), 'imap.custom.test');

const rows = listEmailImapProviderDefaultRows();
assert.ok(rows.some((r) => r.id === 'gmail'));
assert.ok(rows.some((r) => r.id === 'microsoft'));
assert.ok(rows.some((r) => r.id === 'icloud'));
assert.ok(rows.some((r) => r.id === 'yahoo'));

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
    attrs: {},
    listeners: {},
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    addEventListener(type, fn) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(fn);
    },
    dispatch(type) {
      (this.listeners[type] || []).forEach((fn) => fn({ target: this, type }));
    },
  };
  const value = /(?:^|\s)value="([^"]*)"/.exec(attrs);
  if (value) node.value = value[1];
  const named = /data-wh-email="([^"]+)"/.exec(attrs);
  if (named) node.attrs['data-wh-email'] = named[1];
  if (/data-email-prepare-address/.test(attrs)) node.attrs['data-email-prepare-address'] = '';
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
  const details = {
    open: false,
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
        if (p === 'imap_smtp') children.push(makeImapSection(html));
        else {
          children.push({
            className: 'portal-admin-email-settings portal-admin-email-card',
            html,
            getAttribute(name) { return name === 'data-email-provider' ? p : null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
          });
        }
      });
    },
  });
  return el;
}

function boot(client) {
  const body = makeBody();
  const sandbox = {
    URL,
    Date,
    globalThis: null,
    window: { location: { assign() {} }, prompt() { return null; }, confirm() { return true; } },
    document: { getElementById(id) { return id === 'admin-email-settings-body' ? body : null; } },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    getClient() { return client; },
    fetch() { return Promise.resolve({ ok: false, json: async () => ({}) }); },
    console,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(defaultsSrc + '\n' + uiSrc, sandbox);
  return { body, sandbox };
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

const wolf = boot('wolfhouse-somo');
wolf.sandbox.adminEmailImapPromptOpen = true;
wolf.sandbox.renderAdminEmailSettingsData(emptyDto);
const card = wolf.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
assert.ok(card && card.prepare);

card.prepare.value = 'desk@gmail.com';
card.prepare.dispatch('blur');
assert.equal(card.fields['smtp-server'].value, 'smtp.gmail.com');
assert.equal(card.fields['imap-server'].value, 'imap.gmail.com');
assert.equal(card.fields['smtp-port'].value, '587');
assert.equal(card.fields['imap-port'].value, '993');
assert.equal(card.fields['smtp-tls'].value, 'starttls');
assert.equal(card.fields['imap-tls'].value, 'tls');

card.fields['smtp-server'].value = 'mail.custom.override';
card.fields['smtp-server'].dispatch('input');
assert.equal(card.fields['smtp-server'].getAttribute('data-user-edited'), '1');

card.prepare.value = 'host@outlook.com';
card.prepare.dispatch('change');
assert.equal(card.fields['smtp-server'].value, 'mail.custom.override', 'must not overwrite user-edited SMTP host');
assert.equal(card.fields['imap-server'].value, 'outlook.office365.com', 'unedited IMAP host may update');

const beforeUnknownSmtp = card.fields['smtp-server'].value;
const beforeUnknownImap = card.fields['imap-server'].value;
card.prepare.value = 'ops@custom-hostel.test';
card.prepare.dispatch('blur');
assert.equal(card.fields['smtp-server'].value, beforeUnknownSmtp, 'unknown domain leaves SMTP alone');
assert.equal(card.fields['imap-server'].value, beforeUnknownImap, 'unknown domain leaves IMAP alone');

const fresh = boot('wolfhouse-somo');
fresh.sandbox.adminEmailImapPromptOpen = true;
fresh.sandbox.renderAdminEmailSettingsData(emptyDto);
const freshCard = fresh.body.children.find((c) => c.getAttribute('data-email-provider') === 'imap_smtp');
freshCard.prepare.value = 'stay@icloud.com';
freshCard.prepare.dispatch('input');
assert.equal(freshCard.fields['smtp-server'].value, 'smtp.mail.me.com');
assert.equal(freshCard.fields['imap-server'].value, 'imap.mail.me.com');

const sunset = boot('sunset');
sunset.sandbox.adminEmailImapPromptOpen = true;
sunset.sandbox.renderAdminEmailSettingsData(emptyDto);
assert.doesNotMatch(sunset.body.innerHTML, /mailbox-password/);

console.log('PASS WOLFHOUSE-EMAIL-IMAP-AUTOFILL-001');
