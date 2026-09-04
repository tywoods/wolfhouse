'use strict';

/**
 * SUNSET-LUNA-ACA-UI-001 — sunset Admin read-only Luna runtime status.
 * Guest WhatsApp is still Hermes. ACA runtime is additive / not live for guests.
 * Stay off inbox-thread.js, email-settings backend, webhook cutover, extra On/Off.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OWNER = path.join(ROOT, 'scripts/browser/sunset-admin-luna-runtime-status.js');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');
const BROWSER_SRC = path.join(ROOT, 'scripts/lib/sunset-admin-browser-source.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

const uiSrc = fs.readFileSync(OWNER, 'utf8');
const adminUi = fs.readFileSync(ADMIN_UI, 'utf8');
const injectSrc = fs.readFileSync(BROWSER_SRC, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');

assert.ok(uiSrc.includes('data-sunset-luna-runtime="1"'), 'runtime status marker');
assert.ok(uiSrc.includes('Live on Hermes'), 'EN Hermes pill');
assert.ok(uiSrc.includes('Activo en Hermes'), 'ES Hermes pill');
assert.ok(uiSrc.includes('The new Luna ACA runtime is additive and not live for guests.'), 'EN additive copy');
assert.ok(uiSrc.includes('El nuevo runtime ACA de Luna es aditivo y no está activo para huéspedes.'), 'ES additive copy');
assert.ok(uiSrc.includes('Guest WhatsApp'), 'EN title');
assert.ok(uiSrc.includes('WhatsApp de huéspedes'), 'ES title');
assert.ok(uiSrc.includes('padding:16px 18px'), 'Pricing card padding');
assert.ok(uiSrc.includes('background:var(--surface)'), 'Salt/Sand surface, not surface-soft');
assert.ok(!uiSrc.includes('--surface-soft'), 'card is not grey surface-soft');
assert.ok(!/Foam|Sol|Kelp|Ember/.test(uiSrc), 'no new palette names');
assert.ok(!uiSrc.includes('inbox-thread'), 'owner stays off inbox-thread');
assert.ok(!/type=\"checkbox\"/.test(uiSrc), 'no extra On/Off');
assert.ok(!/<button/.test(uiSrc), 'no buttons');
assert.ok(!/\bfetch\s*\(/.test(uiSrc), 'no network');
assert.ok(!/sendWhatsApp/.test(uiSrc), 'does not send WhatsApp');
assert.ok(!/payment_link/.test(uiSrc), 'does not invent leftover/prices');

assert.ok(injectSrc.includes('sunset-admin-luna-runtime-status.js'), 'injected with sunset Admin UI');
const injectFn = injectSrc.match(/function getSunsetAdminUiBrowserSource\(\) \{[\s\S]*?\n\}/);
assert.ok(injectFn, 'getSunsetAdminUiBrowserSource present');
assert.ok(
  injectFn[0].indexOf('LUNA_RUNTIME_STATUS') >= 0
    && injectFn[0].indexOf('LUNA_RUNTIME_STATUS') < injectFn[0].indexOf('BROWSER_UI'),
  'runtime status injected before admin-ui'
);

assert.ok(adminUi.includes('paintSunsetLunaRuntimeStatus()'), 'Admin locale/tab paints status');
assert.ok(
  /next === 'luna-staff' && typeof paintSunsetLunaRuntimeStatus === 'function'/.test(adminUi),
  'Luna Staff subtab paints status'
);
assert.ok(
  /function adminRefreshOnLocaleChange\(\)\{[\s\S]*paintSunsetLunaRuntimeStatus\(\);/.test(adminUi),
  'locale change re-paints status'
);

assert.ok(!apiSrc.includes('sunset-luna-runtime-status'), 'staff-query-api.js stays file-bounded off');
assert.ok(!threadSrc.includes('sunset-luna-runtime-status'), 'inbox-thread.js untouched by this chrome');
assert.ok(!threadSrc.includes('paintSunsetLunaRuntimeStatus'), 'inbox-thread.js has no runtime painter');

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function makeSandbox(opts) {
  const portalClient = opts.portalClient;
  const client = opts.client;
  const lang = opts.lang || 'en';
  const wrap = {
    html: '',
    innerHTML: '',
    insertAdjacentHTML(pos, html) {
      if (pos === 'afterbegin') this.html = String(html) + this.html;
      else this.html += String(html);
      this.innerHTML = this.html;
    },
  };
  let card = null;
  const css = { id: 'sunset-luna-runtime-status-css' };
  let cssMounted = false;
  const headKids = [];
  const sandbox = {
    portalLang: lang,
    portalT(key) { return key; },
    getClient() { return client; },
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
    el(id) { return id === 'al-wrap' ? wrap : null; },
    document: {
      documentElement: {
        getAttribute(name) { return name === 'data-portal-client' ? portalClient : null; },
      },
      head: {
        appendChild(node) { headKids.push(node); cssMounted = true; },
      },
      createElement(tag) {
        return { id: '', textContent: '', tagName: String(tag).toUpperCase() };
      },
      getElementById(id) {
        if (id === 'al-wrap') return wrap;
        if (id === 'sunset-luna-runtime-status') return card;
        if (id === 'sunset-luna-runtime-status-css') return cssMounted ? css : null;
        return null;
      },
    },
    console,
  };
  vm.runInNewContext(uiSrc, sandbox);
  sandbox.__wrap = wrap;
  sandbox.__setCard = function setCard(node) { card = node; };
  sandbox.__headKids = headKids;
  return sandbox;
}

const sunsetEn = makeSandbox({ portalClient: 'sunset', client: 'sunset', lang: 'en' });
sunsetEn.paintSunsetLunaRuntimeStatus();
assert.strictEqual(sunsetEn.__wrap.html, '', 'sunset EN no longer paints ACA additive banner');
assert.ok(!/additive and not live/.test(sunsetEn.__wrap.html), 'sunset EN no additive note');
assert.ok(!/<button/.test(sunsetEn.__wrap.html), 'painted chrome has no button');
assert.ok(!/type="checkbox"/.test(sunsetEn.__wrap.html), 'painted chrome has no switch');

const sunsetEs = makeSandbox({ portalClient: 'sunset', client: 'sunset', lang: 'es' });
sunsetEs.paintSunsetLunaRuntimeStatus();
assert.strictEqual(sunsetEs.__wrap.html, '', 'sunset ES no longer paints ACA additive banner');

const wolf = makeSandbox({ portalClient: '', client: 'wolfhouse', lang: 'en' });
wolf.paintSunsetLunaRuntimeStatus();
assert.strictEqual(wolf.__wrap.html, '', 'wolfhouse does not paint the card');

const switched = makeSandbox({ portalClient: 'sunset', client: 'wolfhouse', lang: 'en' });
switched.paintSunsetLunaRuntimeStatus();
assert.strictEqual(switched.__wrap.html, '', 'sunset html + wolfhouse client hides the card');

const locale = makeSandbox({ portalClient: 'sunset', client: 'sunset', lang: 'en' });
locale.paintSunsetLunaRuntimeStatus();
assert.strictEqual(locale.__wrap.html, '', 'locale re-paint stays empty (banner gone)');
locale.portalLang = 'es';
locale.paintSunsetLunaRuntimeStatus();
assert.strictEqual(locale.__wrap.html, '', 'ES locale re-paint stays empty');

assert.ok(
  sha256(THREAD).length === 64,
  'inbox-thread.js still present for stay-off identity'
);

console.log('PASS SUNSET-LUNA-ACA-UI-001 read-only Hermes/ACA status on sunset Admin');
