'use strict';
// Offline VM/DOM contract tests: no backend, CSS, browser, or network dependencies.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-email-settings-ui.js'), 'utf8');
const providers = ['microsoft_graph', 'gmail_api', 'imap_smtp'];
const tick = () => new Promise(resolve => setImmediate(resolve));
function attrs(html) {
  const out = {};
  for (const m of html.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] === undefined ? '' : m[2];
  return out;
}
function node(a = {}) {
  return { a, isConnected: true, disabled: 'disabled' in a, hidden: 'hidden' in a, textContent: '',
    getAttribute(k) { return this.a[k] == null ? null : this.a[k]; },
    setAttribute(k, v) { this.a[k] = String(v); }, removeAttribute(k) { delete this.a[k]; },
    hasAttribute(k) { return k in this.a; },
    addEventListener(k, fn) { this[k] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
function boot(client = 'wolfhouse-somo', lang = 'en') {
  const body = node(); let html = ''; let sections = [];
  Object.defineProperty(body, 'innerHTML', { get: () => html, set(value) {
    for (const s of sections) { s.isConnected = false; for (const b of s.buttons) b.isConnected = false; }
    html = String(value);
    sections = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/g)].map(m => {
      const s = node(attrs(m[1])); s.html = m[0];
      s.buttons = [...m[2].matchAll(/<button\b([^>]*data-email-flow-paused[^>]*)>([\s\S]*?)<\/button>/g)].map(b => {
        const n = node(attrs(b[1])); n.textContent = b[2]; return n;
      });
      s.error = node();
      const group = /<div\b([^>]*data-email-flow-toggle[^>]*)>/.exec(m[2]);
      s.group = group ? node(attrs(group[1])) : null;
      if (s.group) {
        s.group.querySelectorAll = q => q === '[data-email-flow-paused]' ? s.buttons : [];
      }
      s.querySelector = q => q === '[data-email-flow-toggle]' ? s.group : q === '[data-email-flow-error]' ? s.error : null;
      s.querySelectorAll = q => q === '[data-email-flow-paused]' ? s.buttons : [];
      return s;
    });
  }});
  body.querySelectorAll = q => q === '.portal-admin-email-settings' ? sections : [];
  body.querySelector = q => q === '[data-email-flow-toggle][aria-busy="true"]'
    ? (sections.map(s => s.group).find(g => g && g.a['aria-busy'] === 'true') || null) : null;
  const panel = node(); const tab = node({ 'aria-selected': 'true' });
  const top = { classList: { contains: () => true } };
  const requests = [];
  const env = { client, body, panel, tab, requests, cards: () => sections };
  const sandbox = {
    URL, AbortController, console, portalLang: lang,
    getClient: () => env.client,
    escHtml: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    portalT: k => ({ 'admin.email.on': 'On', 'admin.email.off': 'Off' })[k] || k,
    el: id => id === 'admin-email-settings-body' ? body : null,
    document: { body: { contains: n => n.isConnected }, querySelector: () => top,
      getElementById: id => id === 'admin-tab-email' ? tab : id === 'admin-panel-email' ? panel : body },
    window: {},
    fetch: (url, opts) => new Promise((resolve, reject) => requests.push({ url, opts, resolve, reject })),
  };
  vm.runInNewContext(source, sandbox);
  env.ui = sandbox;
  env.reply = (index, dto, status = 200) => requests[index].resolve({ ok: status === 200, status, json: async () => dto });
  return env;
}
function payload(paused = false) {
  return { locations: [{ location_id: 'location-1', active: true }],
    provider_actions: Object.fromEntries(providers.map(p => [p, { disconnect: true, prepare: true }])),
    endpoints: providers.map((provider, i) => ({ provider, location_id: 'location-1', endpoint_id: 'endpoint-' + i,
      connection_state: 'connected_health', public_address: 'mail@example.test', pause_available: true,
      mail_flow_paused: paused, endpoint_active: true, inbound_enabled: true, outbound_enabled: false, automation_enabled: false })) };
}
function selected(button) { return button.getAttribute('aria-pressed') === 'true'; }
async function main() {
  const h = boot(); h.ui.renderAdminEmailSettingsData(payload());
  assert.equal(h.cards().length, 3);
  for (const s of h.cards()) {
    assert.equal(s.buttons.length, 2, s.a['data-email-provider'] + ' must have On|Off');
    assert.match(s.html, /portal-admin-email-card-head[\s\S]*portal-admin-email-flow-toggle/);
    assert.equal(selected(s.buttons[0]), true);
    assert.match(s.buttons[0].a.class, /is-on/);
    assert.equal(s.buttons[1].disabled, false);
    assert.match(s.html, /data-email-disconnect/);
  }
  console.log('PASS all provider headers include enabled, selected On|Off and retain Disconnect');
  for (const change of [{ pause_available: false }, { pause_available: 'true' }, { mail_flow_paused: undefined },
    { mail_flow_paused: 'false' }, { connection_state: 'disconnected' }, { connection_state: 'reauth_required' }, { endpoint_id: '' }]) {
    const d = payload(); Object.assign(d.endpoints[0], change); h.ui.renderAdminEmailSettingsData(d);
    assert.ok(h.cards()[0].buttons.every(b => b.disabled), JSON.stringify(change));
  }
  h.ui.renderAdminEmailSettingsData({ locations: [], endpoints: [] });
  assert.ok(h.cards().every(s => s.buttons.length === 2 && s.buttons.every(b => b.disabled)));
  const sunset = boot('sunset'); sunset.ui.renderAdminEmailSettingsData({ locations: [], endpoints: [] });
  assert.ok(sunset.cards().every(s => s.buttons.length === 2 && s.buttons.every(b => b.disabled)), 'coming-soon placeholders');
  console.log('PASS missing/unsupported/disconnected/malformed state fails closed, including placeholders');
  for (const lang of ['en', 'es']) {
    const p = boot('wolfhouse-somo', lang); const d = payload(true); const before = JSON.stringify(d);
    p.ui.renderAdminEmailSettingsData(d);
    for (const s of p.cards()) {
      assert.equal(selected(s.buttons[1]), true); assert.match(s.buttons[1].a.class, /is-off/);
      assert.match(s.html, /data-email-flow-note/);
      assert.match(s.html, lang === 'es' ? /Pausa general/ : /Master pause/);
      const off = lang === 'es' ? 'Desactivado' : 'Off';
      assert.match(s.html, new RegExp('data-email-cap="endpoint_active">' + (lang === 'es' ? 'Activado' : 'On') + '</dd>'), 'pause does not paint mailbox connection Off');
      assert.match(s.html, new RegExp('data-email-cap="inbound">' + off + '[^<]*<span[^>]*data-email-cap-saved="on"'));
      assert.match(s.html, new RegExp('data-email-cap="staff_replies">' + off + '[^<]*<span[^>]*data-email-cap-saved="off"'));
      assert.match(s.html, lang === 'es' ? /no activa/ : /does not enable/);
    }
    assert.equal(JSON.stringify(d), before, 'saved capabilities never mutated');
  }
  console.log('PASS EN/ES master-pause explanation and saved/effective capability facts');
  for (const client of ['sunset', 'wolfhouse-somo']) for (let i = 0; i < 3; i++) {
    const p = boot(client); p.ui.renderAdminEmailSettingsData(payload()); const card = p.cards()[i];
    card.buttons[1].click(); card.buttons[1].click();
    assert.equal(p.requests.length, 1); assert.ok(card.buttons.every(b => b.disabled));
    assert.equal(selected(card.buttons[0]), true, 'no optimistic selection');
    assert.equal(p.requests[0].url, '/staff/admin/email-settings/pause');
    assert.equal(p.requests[0].opts.method, 'POST'); assert.equal(p.requests[0].opts.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(p.requests[0].opts.body), { client, location_id: 'location-1', endpoint_id: 'endpoint-' + i, paused: true });
    p.reply(0, { success: true, endpoint_id: 'endpoint-' + i, mail_flow_paused: true }); await tick();
    assert.equal(p.requests[1].url, '/staff/admin/email-settings?client=' + client);
    p.reply(1, payload(true)); await tick(); assert.equal(selected(p.cards()[i].buttons[1]), true);
    p.cards()[i].buttons[0].click(); assert.equal(JSON.parse(p.requests[2].opts.body).paused, false);
    p.reply(2, { success: true, endpoint_id: 'endpoint-' + i, mail_flow_paused: false }); await tick();
    p.reply(3, payload(false)); await tick();
    assert.match(p.cards()[i].html, /data-email-cap="staff_replies">Off<\/dd>/);
  }
  console.log('PASS exact API contract, duplicate-click/busy guard, authoritative reload, resume keeps Off capabilities');
  for (const failure of ['http', 'network', 'endpoint', 'boolean', 'success', 'json']) {
    const p = boot(); p.ui.renderAdminEmailSettingsData(payload()); const card = p.cards()[0]; card.buttons[1].click();
    if (failure === 'network') p.requests[0].reject(new Error('offline'));
    else if (failure === 'json') p.requests[0].resolve({ ok: true, status: 200, json: async () => { throw Error('bad JSON'); } });
    else p.reply(0, { success: failure !== 'success', endpoint_id: failure === 'endpoint' ? 'other' : 'endpoint-0', mail_flow_paused: failure === 'boolean' ? 'true' : true }, failure === 'http' ? 403 : 200);
    await tick(); assert.equal(p.requests.length, 1); assert.equal(selected(card.buttons[0]), true);
    assert.ok(card.error.textContent.length > 0); assert.equal(card.error.hidden, false); assert.ok(card.buttons.every(b => !b.disabled));
  }
  console.log('PASS HTTP/network/invalid DTO/JSON failures visible without optimistic state');
  for (const switchView of [p => { p.client = 'sunset'; }, p => { p.tab.a['aria-selected'] = 'false'; },
    p => { p.panel.hidden = true; }, p => p.ui.renderAdminEmailSettingsData(payload()),
    p => { p.ui.cancelAdminEmailReauthorization(); }]) {
    for (const fail of [false, true]) {
      const p = boot(); p.ui.renderAdminEmailSettingsData(payload()); const old = p.cards()[0]; old.buttons[1].click();
      switchView(p); const before = p.body.innerHTML;
      if (fail) p.requests[0].reject(new Error('late')); else p.reply(0, { success: true, endpoint_id: 'endpoint-0', mail_flow_paused: true });
      await tick(); assert.equal(p.requests.length, 1); assert.equal(p.body.innerHTML, before); assert.equal(old.error.textContent, '');
    }
  }
  const staleGet = boot(); staleGet.ui.renderAdminEmailSettingsData(payload()); staleGet.cards()[0].buttons[1].click();
  staleGet.reply(0, { success: true, endpoint_id: 'endpoint-0', mail_flow_paused: true }); await tick();
  staleGet.ui.cancelAdminEmailReauthorization(); const before = staleGet.body.innerHTML;
  staleGet.reply(1, payload(true)); await tick(); assert.equal(staleGet.body.innerHTML, before);
  console.log('PASS stale success/failure ignored after tenant/tab/render/navigation switches, including reload');
  const gmail = boot('sunset'); const gmailData = payload(); gmailData.provider_actions.gmail_api = {};
  gmail.ui.renderAdminEmailSettingsData(gmailData);
  assert.ok(gmail.cards()[1].buttons.every(b => !b.disabled), 'Gmail endpoint pause support does not depend on OAuth prepare/connect');
  assert.doesNotMatch(gmail.cards()[1].html, /data-email-connect=|data-email-disconnect=/, 'no provider abilities added');
  const locale = boot(); locale.ui.renderAdminEmailSettingsData(payload()); const card = locale.cards()[0];
  card.buttons[0].click(); assert.equal(locale.requests.length, 0, 'selected segment is a no-op');
  card.buttons[1].click(); locale.ui.portalLang = 'es'; locale.ui.adminEmailRefreshOnLocaleChange();
  assert.equal(locale.cards()[0], card, 'locale refresh must not re-enable a pending operation');
  assert.ok(card.buttons.every(b => b.disabled));
  locale.reply(0, { success: true, endpoint_id: 'endpoint-0', mail_flow_paused: true }); await tick();
  locale.reply(1, payload(false)); await tick();
  assert.equal(selected(locale.cards()[0].buttons[0]), true, 'GET is authoritative even if another writer changed POST result');
  for (const lang of ['en', 'es']) {
    const p = boot('wolfhouse-somo', lang); p.ui.renderAdminEmailSettingsData(payload()); p.cards()[0].buttons[1].click();
    p.reply(0, { success: true, endpoint_id: 'endpoint-0', mail_flow_paused: true }); await tick();
    p.requests[1].reject(new Error('offline')); await tick();
    assert.match(p.body.innerHTML, lang === 'es' ? /se guardó/ : /was saved/);
    assert.doesNotMatch(p.body.innerHTML, /Nothing was changed|No se ha cambiado nada/);
    p.ui.adminEmailRefreshOnLocaleChange();
    assert.doesNotMatch(p.body.innerHTML, /Nothing was changed|No se ha cambiado nada/, 'locale repaint retains truthful reload failure');
  }
  console.log('PASS independent Gmail support, locale busy guard, concurrent server changes and truthful reload failures');
  console.log('PASS EMAIL-CARD-PAUSE-TOGGLE-001 UI (offline VM)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
