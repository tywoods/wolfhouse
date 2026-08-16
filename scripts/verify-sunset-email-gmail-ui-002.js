'use strict';

/**
 * EMAIL-GMAIL-UI-002 — Scope Gmail connect feedback away from Microsoft.
 *
 * Gmail never shows Microsoft progress/failure copy. Empty Gmail prepare is an
 * honest inline hint with no provider POST. Failed Google prepare/start is
 * Gmail-specific. Successful prepare starts OAuth immediately (no second-click
 * Connect). Failure/busy state is per provider/attempt. IMAP stays coming soon.
 * Gmail disconnect/reauth remain off when the disconnect gate is off. No secrets / Inbox / poller.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = require('node:path').join(__dirname, '..');
const uiSrc = fs.readFileSync(require('node:path').join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');

const LOCATION = 'sunset-somo';
const MS_ID = '22222222-2222-4222-8222-222222222222';
const GOOGLE_ID = '33333333-3333-4333-8333-333333333333';

assert.ok(uiSrc.includes('postGoogleEndpointPrepare'));
assert.ok(uiSrc.includes('postGoogleOAuthStart'));
assert.ok(uiSrc.includes('Connecting Gmail…'));
assert.ok(uiSrc.includes('Conectando Gmail…'));
assert.ok(uiSrc.includes('Couldn’t connect Gmail') || uiSrc.includes("Couldn't connect Gmail"));
assert.ok(uiSrc.includes('No se pudo conectar Gmail'));
assert.ok(uiSrc.includes('Enter a Gmail address'));
assert.ok(!uiSrc.includes('inbox-thread'));
assert.ok(!/AADSTS|ErrorInvalidMailbox|MailboxNotEnabledForRESTAPI|GraphError/.test(uiSrc));
assert.ok(!uiSrc.includes('console.log(dto.authorizationUrl)'));
assert.doesNotMatch(uiSrc, /provider_actions\.gmail_api\s*=\s*\{prepare:false,connect:true/);

function validGoogleUrl() {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  [
    ['client_id', '9876543210-web_client.v2.apps.googleusercontent.com'],
    ['response_type', 'code'],
    ['redirect_uri', 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback'],
    ['response_mode', 'query'],
    ['scope', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'],
    ['state', 'a'.repeat(43)],
    ['nonce', 'b'.repeat(43)],
    ['code_challenge', 'c'.repeat(43)],
    ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
  ].forEach(([k, v]) => u.searchParams.append(k, v));
  return u.toString();
}

function cardHtml(html, provider) {
  const start = html.indexOf('data-email-provider="' + provider + '"');
  assert.ok(start >= 0, 'missing card ' + provider);
  const from = html.lastIndexOf('<section', start);
  const next = html.indexOf('<section', from + 8);
  return html.slice(from, next === -1 ? html.length : next);
}

function parseAttrs(raw) {
  const attrs = Object.create(null);
  String(raw || '').replace(/([:\w-]+)="([^"]*)"/g, (_, k, v) => {
    attrs[k] = v;
    return '';
  });
  return attrs;
}

function makeInteractiveBody() {
  const cards = [];
  const body = {
    id: 'admin-email-settings-body',
    _html: '',
    isConnected: true,
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      if (sel === '.portal-admin-email-settings') return cards.slice();
      const providerMatch = String(sel).match(/data-email-provider="([^"]+)"/);
      if (providerMatch) return cards.filter((c) => c.getAttribute('data-email-provider') === providerMatch[1]);
      if (sel === '[data-email-connect-busy]') {
        return cards.filter((c) => c.attrs['data-email-connect-busy'] === '1');
      }
      return [];
    },
  };
  Object.defineProperty(body, 'innerHTML', {
    configurable: true,
    get() { return body._html; },
    set(v) {
      body._html = String(v);
      cards.length = 0;
      String(v).split(/<section\b/).slice(1).forEach((part) => {
        cards.push(makeSection('<section' + part.split('</section>')[0] + '</section>'));
      });
    },
  });
  return { body, cards };
}

function makeSection(html) {
  const open = html.match(/^<section\b([^>]*)>/) || [];
  const attrs = parseAttrs(open[1]);
  const listeners = {};
  const btnOpen = html.match(/<button([^>]*)data-email-connect="([^"]+)"([^>]*)>([^<]*)<\/button>/);
  let btn = null;
  if (btnOpen) {
    const btnAttrs = parseAttrs((btnOpen[1] || '') + ' ' + (btnOpen[3] || ''));
    btnAttrs['data-email-connect'] = btnOpen[2];
    btn = {
      attrs: btnAttrs,
      textContent: btnOpen[4] || '',
      disabled: /\bdisabled\b/.test(btnOpen[0]),
      isConnected: true,
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      click() {
        (listeners.click || []).forEach((fn) => fn({ type: 'click', target: btn }));
      },
    };
  }
  const inputOpen = html.match(/<input([^>]*)data-email-prepare-address([^>]*)>/);
  const input = inputOpen
    ? { value: '', disabled: false, attrs: parseAttrs((inputOpen[1] || '') + ' data-email-prepare-address ' + (inputOpen[2] || '')) }
    : null;
  const progress = { hidden: true, textContent: '' };
  const section = {
    className: 'portal-admin-email-settings portal-admin-email-card',
    attrs,
    btn,
    input,
    progress,
    isConnected: true,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelector(sel) {
      if (sel === '[data-email-connect]') return btn;
      if (sel === '[data-email-prepare-address]') return input;
      if (sel === '[data-email-connect-progress]') return progress;
      if (sel === '[data-email-reauthorize]' || sel === '[data-email-disconnect]') return null;
      return null;
    },
  };
  return section;
}

function livePayload(extra) {
  return Object.assign({
    actions: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    provider_actions: {
      microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: true, connect: false, disconnect: false, reauthorize: false },
    },
    locations: [{ location_id: LOCATION, active: true }],
    endpoints: [],
  }, extra || {});
}

function connectPayload() {
  return livePayload({
    provider_actions: {
      microsoft_graph: { prepare: true, connect: false, disconnect: false, reauthorize: false },
      gmail_api: { prepare: false, connect: true, disconnect: false, reauthorize: false },
    },
    endpoints: [{
      provider: 'gmail_api',
      location_id: LOCATION,
      endpoint_id: GOOGLE_ID,
      public_address: 'desk@gmail.example',
      connection_state: 'registered_not_connected',
    }],
  });
}

function boot(fetchImpl) {
  const { body, cards } = makeInteractiveBody();
  const calls = [];
  const assigned = [];
  const sandbox = {
    URL,
    Date,
    Object,
    Reflect,
    Number,
    String,
    Promise,
    JSON,
    Array,
    window: { location: { assign(url) { assigned.push(String(url)); } } },
    document: {
      body: { contains() { return true; } },
      getElementById(id) { return id === 'admin-email-settings-body' ? body : null; },
    },
    el(id) { return id === 'admin-email-settings-body' ? body : null; },
    escHtml(s) { return String(s == null ? '' : s); },
    portalT(key) { return key; },
    portalLang: 'en',
    fetch(url, opts) {
      calls.push({ url: String(url), body: opts && opts.body, method: opts && opts.method });
      return fetchImpl(url, opts, calls);
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  return { sandbox, body, cards, calls, assigned };
}

async function flush() {
  for (let i = 0; i < 24; i += 1) await Promise.resolve();
}

function findCard(cards, provider) {
  return cards.find((c) => c.getAttribute('data-email-provider') === provider) || null;
}

async function run() {
  // Empty Gmail prepare: inline hint, no POST, no Microsoft failure.
  {
    const { sandbox, body, cards, calls } = boot(() => Promise.resolve({ ok: false, json: async () => ({}) }));
    sandbox.renderAdminEmailSettingsData(livePayload());
    const gmail = findCard(cards, 'gmail_api');
    assert.ok(gmail && gmail.btn && gmail.input, 'live Gmail prepare');
    gmail.input.value = '   ';
    gmail.btn.click();
    await flush();
    assert.equal(calls.length, 0, 'empty Gmail address must not POST');
    const html = body.innerHTML;
    const gmailHtml = cardHtml(html, 'gmail_api');
    const msHtml = cardHtml(html, 'microsoft_graph');
    const imapHtml = cardHtml(html, 'imap_smtp');
    assert.match(gmailHtml, /Enter a Gmail address/);
    assert.doesNotMatch(gmailHtml, /Couldn’t connect Microsoft|Couldn't connect Microsoft|Connecting Microsoft/);
    assert.doesNotMatch(msHtml, /Enter a Gmail address|Couldn’t connect Microsoft|Couldn't connect Microsoft|Couldn’t connect Gmail|Couldn't connect Gmail/);
    assert.match(msHtml, /Connect Microsoft email/);
    assert.match(imapHtml, /Coming soon/);
    assert.doesNotMatch(imapHtml, /data-email-connect=/);
    assert.doesNotMatch(gmailHtml, /data-email-disconnect|data-email-reauthorize/);
  }

  // Failed Google prepare paints Gmail-only failure.
  {
    const { sandbox, body, cards, calls } = boot(() => Promise.resolve({ ok: false, json: async () => ({}) }));
    sandbox.renderAdminEmailSettingsData(livePayload());
    const gmail = findCard(cards, 'gmail_api');
    gmail.input.value = 'desk@gmail.example';
    gmail.btn.click();
    await flush();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/oauth\/google\/endpoint$/);
    const gmailHtml = cardHtml(body.innerHTML, 'gmail_api');
    const msHtml = cardHtml(body.innerHTML, 'microsoft_graph');
    assert.match(gmailHtml, /Couldn’t connect Gmail|Couldn't connect Gmail/);
    assert.match(gmailHtml, /Nothing was changed/);
    assert.doesNotMatch(gmailHtml, /Couldn’t connect Microsoft|Couldn't connect Microsoft|Connecting Microsoft/);
    assert.doesNotMatch(msHtml, /Couldn’t connect Gmail|Couldn't connect Gmail|Couldn’t connect Microsoft|Couldn't connect Microsoft|Connecting Microsoft|Connecting Gmail/);
    assert.match(msHtml, /Connect Microsoft email/);
    sandbox.portalLang = 'es';
    sandbox.adminEmailRefreshOnLocaleChange();
    assert.match(cardHtml(body.innerHTML, 'gmail_api'), /No se pudo conectar Gmail/);
    assert.doesNotMatch(cardHtml(body.innerHTML, 'gmail_api'), /No se pudo conectar Microsoft/);
    assert.doesNotMatch(cardHtml(body.innerHTML, 'microsoft_graph'), /No se pudo conectar Gmail|No se pudo conectar Microsoft/);
  }

  // Failed Microsoft prepare keeps Microsoft copy and leaves Gmail clean.
  {
    const { sandbox, body, cards } = boot(() => Promise.resolve({ ok: false, json: async () => ({}) }));
    sandbox.renderAdminEmailSettingsData(livePayload());
    const ms = findCard(cards, 'microsoft_graph');
    ms.input.value = 'desk@outlook.example';
    ms.btn.click();
    await flush();
    const gmailHtml = cardHtml(body.innerHTML, 'gmail_api');
    const msHtml = cardHtml(body.innerHTML, 'microsoft_graph');
    assert.match(msHtml, /Couldn’t connect Microsoft|Couldn't connect Microsoft/);
    assert.doesNotMatch(msHtml, /Couldn’t connect Gmail|Couldn't connect Gmail|Connecting Gmail/);
    assert.doesNotMatch(gmailHtml, /Couldn’t connect Microsoft|Couldn't connect Microsoft|Connecting Microsoft|Couldn’t connect Gmail|Couldn't connect Gmail/);
    assert.match(gmailHtml, /Connect Google email/);
  }

  // Successful Gmail prepare starts OAuth immediately — no second-click Connect.
  {
    const { sandbox, body, cards, calls, assigned } = boot((url) => {
      if (String(url).endsWith('/oauth/google/endpoint')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, endpoint_id: GOOGLE_ID }) });
      }
      if (String(url).endsWith('/oauth/google/start')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ authorizationUrl: validGoogleUrl(), expiresAt: '2099-01-01T00:00:00.000Z' }),
        });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
    sandbox.renderAdminEmailSettingsData(livePayload());
    const gmail = findCard(cards, 'gmail_api');
    gmail.input.value = 'desk@gmail.example';
    gmail.btn.click();
    await flush();
    assert.deepEqual(calls.map((c) => c.url), [
      '/staff/admin/email-settings/oauth/google/endpoint',
      '/staff/admin/email-settings/oauth/google/start',
    ]);
    assert.equal(calls[0].body, JSON.stringify({ location_id: LOCATION, public_address: 'desk@gmail.example' }));
    assert.equal(calls[1].body, JSON.stringify({ location_id: LOCATION, endpoint_id: GOOGLE_ID }));
    assert.equal(assigned.length, 1);
    assert.equal(assigned[0], validGoogleUrl());
    assert.doesNotMatch(cardHtml(body.innerHTML, 'gmail_api'), /data-email-connect="connect"/);
    assert.doesNotMatch(body.innerHTML, /\/oauth\/microsoft\//);
  }

  // Existing Gmail connect starts only — never prepare again.
  {
    const { sandbox, cards, calls, assigned } = boot((url) => {
      if (String(url).endsWith('/oauth/google/start')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ authorizationUrl: validGoogleUrl(), expiresAt: '2099-01-01T00:00:00.000Z' }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, endpoint_id: 'should-not-prepare' }) });
    });
    sandbox.renderAdminEmailSettingsData(connectPayload());
    const gmail = findCard(cards, 'gmail_api');
    assert.equal(gmail.btn.getAttribute('data-email-connect'), 'connect');
    gmail.btn.click();
    await flush();
    assert.deepEqual(calls.map((c) => c.url), ['/staff/admin/email-settings/oauth/google/start']);
    assert.equal(calls[0].body, JSON.stringify({ location_id: LOCATION, endpoint_id: GOOGLE_ID }));
    assert.equal(assigned[0], validGoogleUrl());
  }

  // Provider/attempt isolation: late Gmail failure must not overwrite Microsoft busy.
  {
    let rejectGmail;
    const { sandbox, body, cards } = boot((url) => {
      if (String(url).includes('/google/endpoint')) {
        return new Promise((_, reject) => { rejectGmail = () => reject(new Error('unavailable')); });
      }
      if (String(url).includes('/microsoft/endpoint')) {
        return new Promise(() => {});
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    });
    sandbox.renderAdminEmailSettingsData(livePayload());
    const gmail = findCard(cards, 'gmail_api');
    gmail.input.value = 'desk@gmail.example';
    gmail.btn.click();
    await flush();
    const ms = findCard(cards, 'microsoft_graph');
    ms.input.value = 'desk@outlook.example';
    ms.btn.click();
    await flush();
    assert.equal(findCard(cards, 'microsoft_graph').progress.textContent, 'Connecting Microsoft…');
    assert.doesNotMatch(findCard(cards, 'gmail_api').progress.textContent, /Microsoft/);
    rejectGmail();
    await flush();
    const gmailHtml = cardHtml(body.innerHTML, 'gmail_api');
    const msCard = findCard(cards, 'microsoft_graph');
    assert.match(gmailHtml, /Couldn’t connect Gmail|Couldn't connect Gmail/);
    assert.doesNotMatch(gmailHtml, /Connecting Microsoft|Couldn’t connect Microsoft|Couldn't connect Microsoft/);
    assert.equal(msCard.progress.textContent, 'Connecting Microsoft…');
    assert.equal(msCard.attrs['data-email-connect-busy'], '1');
    assert.doesNotMatch(msCard.btn.textContent, /Gmail/);
  }

  // Stale/detached: a load reset drops an in-flight Gmail failure.
  {
    let rejectGmail;
    const { sandbox, body, cards } = boot((url) => {
      if (String(url).includes('/google/endpoint')) {
        return new Promise((_, reject) => { rejectGmail = () => reject(new Error('unavailable')); });
      }
      return Promise.resolve({ ok: true, json: async () => livePayload() });
    });
    sandbox.getClient = () => 'sunset';
    sandbox.renderAdminEmailSettingsData(livePayload());
    const gmail = findCard(cards, 'gmail_api');
    gmail.input.value = 'desk@gmail.example';
    gmail.btn.click();
    await flush();
    sandbox.loadAdminEmailSettings();
    await flush();
    rejectGmail();
    await flush();
    assert.doesNotMatch(body.innerHTML, /Couldn’t connect Gmail|Couldn't connect Gmail|Couldn’t connect Microsoft|Couldn't connect Microsoft/);
  }

  // Busy chrome is provider-specific.
  {
    const { sandbox } = boot(() => Promise.resolve({ ok: false, json: async () => ({}) }));
    const btn = {
      disabled: false,
      textContent: 'Connect Google email',
      attrs: { 'data-email-provider': 'gmail_api' },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      getAttribute(k) { return this.attrs[k] || null; },
    };
    const progress = { hidden: true, textContent: '' };
    const section = {
      attrs: { 'data-email-provider': 'gmail_api' },
      getAttribute(k) { return this.attrs[k] || null; },
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      querySelector(sel) {
        if (sel === '[data-email-connect]') return btn;
        if (sel === '[data-email-connect-progress]') return progress;
        return null;
      },
    };
    sandbox.portalLang = 'en';
    sandbox.setConnectBusy(section, true);
    assert.equal(btn.textContent, 'Connecting Gmail…');
    assert.equal(progress.textContent, 'Connecting Gmail…');
    assert.doesNotMatch(btn.textContent, /Microsoft/);
    sandbox.portalLang = 'es';
    sandbox.setConnectBusy(section, true);
    assert.equal(btn.textContent, 'Conectando Gmail…');
    assert.equal(progress.textContent, 'Conectando Gmail…');
  }

  console.log('PASS EMAIL-GMAIL-UI-002 scoped Gmail connect feedback');
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
