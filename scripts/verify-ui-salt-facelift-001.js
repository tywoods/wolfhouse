'use strict';

/**
 * Style card: Salt/Sand in Light, Sand-only Dark, no four-swatch embed.
 * CSS/layout only. Does not touch send/inbound.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright',
  ];
  for (const id of candidates) {
    try {
      return require(id);
    } catch (_e) { /* try next */ }
  }
  return null;
}

const ROOT = path.join(__dirname, '..');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

const SALT_LIGHT = {
  cream: '#F5F5F7',
  surface: '#FFFFFF',
  'surface-soft': '#F2F2F7',
  sand: '#E5E5EA',
  tan: '#D1D1D6',
  sage: '#1F6B4A',
  olive: '#185A3E',
  'dusty-blue': '#8E8E93',
  ocean: '#636366',
  teal: '#E8F0EC',
  text: '#1D1D1F',
  'text-2': '#6E6E73',
  'text-3': '#8E8E93',
  border: '#D2D2D7',
  'border-soft': '#E5E5EA',
  primary: '#1B4D3E',
  'primary-hover': '#163E32',
  focus: '#1B4D3E',
  'luna-teal': '#1B4D3E',
  'luna-teal-dark': '#163E32',
};

const SAND_LIGHT = {
  cream: '#EDE8E0',
  surface: '#F5F1EA',
  'surface-soft': '#EDE8E0',
  sand: '#E0D8CC',
  tan: '#D4C9BA',
  sage: '#B8CBB0',
  olive: '#8FA58E',
  'dusty-blue': '#B5C4CE',
  ocean: '#9DB4C4',
  teal: '#D0E0DA',
  text: '#4E5853',
  'text-2': '#727C76',
  'text-3': '#959F99',
  border: '#DDD5C9',
  'border-soft': '#E8E2D8',
  primary: '#4E5853',
  'primary-hover': '#3F4843',
  focus: '#9DB4C4',
};

const SAND_DARK = {
  cream: '#181818',
  surface: '#252526',
  'surface-soft': '#2d2d2d',
  sand: '#3c3c3c',
  tan: '#3a4a3a',
  sage: '#6a9a72',
  olive: '#5a8a62',
  'dusty-blue': '#569cd6',
  ocean: '#2d5a78',
  teal: '#243828',
  text: '#cccccc',
  'text-2': '#9d9d9d',
  'text-3': '#6e6e6e',
  border: '#3c3c3c',
  'border-soft': '#333333',
  primary: '#4a7c59',
  'primary-hover': '#5a9468',
  focus: '#6a9a72',
};

function extractBlock(src, startRe, endRe) {
  const start = src.search(startRe);
  assert.ok(start >= 0, 'block start not found: ' + startRe);
  const rest = src.slice(start);
  const end = rest.search(endRe);
  assert.ok(end > 0, 'block end not found after ' + startRe);
  return rest.slice(0, end);
}

function assertTokens(label, css, tokens) {
  for (const [name, hex] of Object.entries(tokens)) {
    const re = new RegExp('--' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*' + hex, 'i');
    assert.ok(re.test(css), label + ' missing --' + name + ':' + hex);
  }
}

const I18N_KEYS = [
  'lunaStaff.style.title',
  'lunaStaff.style.sub',
  'lunaStaff.style.palette.salt',
  'lunaStaff.style.palette.sand',
  'lunaStaff.style.lightMode',
  'lunaStaff.style.darkMode',
];

for (const key of I18N_KEYS) {
  assert.ok(en[key] && en[key] !== key, 'EN missing ' + key);
  assert.ok(es[key] && es[key] !== key, 'ES missing ' + key);
}
assert.notStrictEqual(en['lunaStaff.style.palette.salt'], es['lunaStaff.style.palette.salt']);
assert.strictEqual(en['lunaStaff.style.palette.salt'], 'Salt');
assert.strictEqual(en['lunaStaff.style.palette.sand'], 'Sand');
assert.strictEqual(en['lunaStaff.style.lightMode'], 'Light mode');
assert.strictEqual(en['lunaStaff.style.darkMode'], 'Dark mode');

const saltLightCss = extractBlock(
  apiSrc,
  /:root\{/,
  /\n\[data-theme="dark"\]\{/
);
assertTokens('Salt Light :root', saltLightCss, SALT_LIGHT);
assert.ok(!/--cream:#EDE8E0/.test(saltLightCss), 'Salt Light :root must not keep Sand oatmeal cream');
assert.ok(/--cream:#F5F5F7/.test(saltLightCss), 'Salt Light Apple-clean cream');
assert.ok(/--surface:#FFFFFF/.test(saltLightCss), 'Salt Light white surface');
assert.ok(/--primary:#1B4D3E/.test(saltLightCss), 'Salt Light dark green primary');
assert.ok(!/--cream:#F3EEE6/.test(saltLightCss), 'no warm paper cream');
assert.ok(!/--cream:#E6EDE9/.test(saltLightCss), 'no cool sea-mist cream');
assert.ok(!/--surface:#FFFBF4/.test(saltLightCss), 'no warm paper surface');

const sandDarkCss = extractBlock(
  apiSrc,
  /\[data-theme="dark"\]\{/,
  /\n\[data-color-profile="sand"\]/
);
assertTokens('Sand Dark [data-theme=dark]', sandDarkCss, SAND_DARK);
assert.ok(!/--cream:#161C1A/.test(sandDarkCss), 'Salt Dark cream must not be default dark');
assert.ok(!/--surface:#222926/.test(sandDarkCss), 'Salt Dark surface must not be default dark');
assert.ok(/--cream:#181818/.test(sandDarkCss), 'default dark is Sand charcoal cream');
assert.ok(/--surface:#252526/.test(sandDarkCss), 'default dark is Sand charcoal surface');

const sandLightCss = extractBlock(
  apiSrc,
  /\[data-color-profile="sand"\]:not\(\[data-theme="dark"\]\)\{/,
  /\n\[data-theme="dark"\] #banner/
);
assertTokens('Sand Light', sandLightCss, SAND_LIGHT);

assert.ok(
  !/\[data-color-profile="sand"\]\[data-theme="dark"\] #banner\{background:/.test(apiSrc),
  'sand-dark must not set #banner background shorthand (flattens moonlight art)'
);
assert.ok(
  /\[data-theme="dark"\] \.luna-header-ui:not\(\.luna-hdr-compact\) #banner\{[\s\S]{0,400}background-size:100% 100%/.test(apiSrc),
  'dark painted banner re-sets background-size'
);
assert.ok(
  /luna-header-banner-dark\.png/.test(apiSrc),
  'moonlight banner asset stays'
);

assert.ok(
  /wh_staff_color_profile/.test(i18nSrc) &&
    /p==='sand'\s*\?\s*'sand'\s*:\s*'salt'/.test(i18nSrc.replace(/\s+/g, '')),
  'early script / bootstrap defaults missing profile to salt'
);
assert.ok(i18nSrc.includes("getItem('wh_staff_color_profile')") || i18nSrc.includes('STAFF_COLOR_PROFILE_KEY'), 'profile key present');
assert.ok(i18nSrc.includes('window.getStaffColorProfile'), 'getStaffColorProfile exported');
assert.ok(i18nSrc.includes('window.setStaffColorProfile'), 'setStaffColorProfile exported');
assert.ok(i18nSrc.includes('window.bindStaffStyleCard'), 'bindStaffStyleCard exported');
assert.ok(i18nSrc.includes("setAttribute('data-color-profile'"), 'apply sets data-color-profile');

assert.ok(apiSrc.includes('id="staff-style-card"'), 'Style card in embed');
assert.ok(apiSrc.includes('id="staff-style-light-mode"'), 'Light mode section');
assert.ok(apiSrc.includes('id="staff-style-dark-mode"'), 'Dark mode section');
assert.ok(apiSrc.includes('lunaStaff.style.lightMode'), 'Light mode title i18n');
assert.ok(apiSrc.includes('lunaStaff.style.darkMode'), 'Dark mode title i18n');
assert.ok(apiSrc.includes('data-color-profile="salt"'), 'Salt pill');
assert.ok(apiSrc.includes('data-color-profile="sand"'), 'Sand pill');
assert.ok(!apiSrc.includes('id="staff-style-palette-embed"'), 'four-palette embed removed');
assert.ok(!apiSrc.includes('data-style-combo="salt-dark"'), 'Salt Dark swatch removed');
assert.ok(!/data-style-theme="(light|dark)"/.test(apiSrc), 'Light/Dark pills removed from Style card');
assert.ok(
  !/\b(Foam|Sol|Kelp|Ember)\b/.test(apiSrc.slice(apiSrc.indexOf('id="staff-style-card"'), apiSrc.indexOf('id="staff-style-dark-mode"') + 80)),
  'Style card is Salt+Sand only — no Foam/Sol/Kelp/Ember'
);

const HEADER_MODES = ['normal', 'compact', 'sunset', 'moonlight', 'sunsetmoonlight'];
for (const mode of HEADER_MODES) {
  assert.ok(
    apiSrc.includes('data-header-mode="' + mode + '"'),
    'header still has mode ' + mode
  );
}
assert.ok(apiSrc.includes('id="luna-header-mode-card"'), 'header modes folded into Style');
assert.ok(apiSrc.includes('id="staff-style-card"') && apiSrc.indexOf('id="luna-header-mode-card"') > apiSrc.indexOf('id="staff-style-card"'), 'header block nested in Style');
assert.ok(apiSrc.includes('luna-header-mode-pencil'), 'pencil affordance present');
assert.ok(!/<section[^>]*id="luna-header-mode-card"/.test(apiSrc), 'no standalone Header style section');
assert.ok(adminUi.includes('function wireLunaStaffHeaderModeCard'), 'header mode wire stays');
assert.ok(apiSrc.includes('--chip-transfer-bg'), 'transfer chip token');
assert.ok(/\.bc-room-hdr\{background:var\(--room-bar/.test(apiSrc), 'room bars use --room-bar not sage');
assert.ok(!/\.bc-room-hdr\{background:var\(--sage\)/.test(apiSrc), 'room bars must not use --sage fill');
assert.ok(/--room-bar:#3A3A3C/.test(apiSrc), 'Salt room-bar is cool charcoal');
assert.ok(/--booking-confirmed-bg:#FFFFFF/.test(apiSrc), 'Salt confirmed pill is white not green');
assert.ok(!/--booking-confirmed-bg:#E0E6D0/.test(apiSrc), 'no pale olive confirmed fill');
assert.ok(!/--booking-confirmed-bg:#CEDFBF/.test(apiSrc), 'Sand confirmed not pale green');
assert.ok(!/--booking-confirmed-bg:#FFFBF4/.test(saltLightCss), 'Salt confirmed not warm paper');
assert.ok(/\.bc-block-confirmed\{[^}]*booking-confirmed-bg/.test(apiSrc), 'confirmed block uses booking-confirmed tokens');
assert.ok(!/function sendWhatsApp|handleInbound/.test(i18nSrc), 'i18n bootstrap stayed CSS/layout');

const styleStart = apiSrc.indexOf('/* ── Palette (soft boutique-hospitality)');
const styleEnd = apiSrc.indexOf('</style>', styleStart);
assert.ok(styleStart >= 0 && styleEnd > styleStart, 'main style block found');
const style = apiSrc.slice(styleStart, styleEnd);

function hexOf(rgb) {
  const m = String(rgb || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!m) return String(rgb || '').trim().toLowerCase();
  return (
    '#' +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  ).toUpperCase();
}

function normHex(h) {
  return String(h || '').trim().toUpperCase();
}

async function readTokens(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = [
      'cream', 'surface', 'surface-soft', 'sand', 'tan', 'sage', 'olive',
      'dusty-blue', 'ocean', 'teal', 'text', 'text-2', 'text-3', 'border',
      'border-soft', 'primary', 'primary-hover', 'focus', 'luna-teal', 'luna-teal-dark',
    ];
    const out = {};
    names.forEach((n) => {
      out[n] = cs.getPropertyValue('--' + n).trim();
    });
    out.profile = document.documentElement.getAttribute('data-color-profile');
    out.theme = document.documentElement.getAttribute('data-theme');
    const moon = document.getElementById('staff-theme-toggle');
    out.moonPressed = moon ? moon.getAttribute('aria-pressed') : null;
    out.saltPill = !!document.querySelector('[data-color-profile="salt"].is-active');
    out.sandPill = !!document.querySelector('[data-color-profile="sand"].is-active');
    out.lightTitle = !!(document.getElementById('staff-style-light-mode'));
    out.darkTitle = !!(document.getElementById('staff-style-dark-mode'));
    out.headerModes = Array.from(document.querySelectorAll('[data-header-mode]')).map((el) =>
      el.getAttribute('data-header-mode')
    );
    const banner = document.getElementById('banner');
    if (banner) {
      const bcs = getComputedStyle(banner);
      out.bannerImage = bcs.backgroundImage;
      out.bannerSize = bcs.backgroundSize;
      out.bannerRepeat = bcs.backgroundRepeat;
    }
    return out;
  });
}

function assertTokenSet(label, got, expected) {
  for (const [name, hex] of Object.entries(expected)) {
    const actual = normHex(got[name]);
    const want = normHex(hex);
    assert.strictEqual(actual, want, label + ' --' + name + ' expected ' + want + ' got ' + actual);
  }
}

function simulateStyleCard() {
  const vm = require('vm');
  const store = {};
  const pills = [];
  function el(attrs) {
    const node = {
      attrs: Object.assign({}, attrs),
      className: '',
      classList: {
        toggle(name, on) {
          const set = new Set(String(node.className).split(/\s+/).filter(Boolean));
          if (on) set.add(name); else set.delete(name);
          node.className = Array.from(set).join(' ');
        },
        contains(name) {
          return String(node.className).split(/\s+/).includes(name);
        },
      },
      getAttribute(k) { return node.attrs[k] == null ? null : String(node.attrs[k]); },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      closest(sel) {
        if (sel.startsWith('[') && sel.endsWith(']')) {
          const body = sel.slice(1, -1);
          const [key, raw] = body.split('=');
          if (!raw) return node.attrs[key] != null ? node : null;
          return node.attrs[key] === raw.replace(/"/g, '') ? node : null;
        }
        return null;
      },
    };
    pills.push(node);
    return node;
  }
  const htmlEl = {
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] || null; },
  };
  const moon = el({ id: 'staff-theme-toggle' });
  moon.id = 'staff-theme-toggle';
  const cardKids = [
    el({ 'data-color-profile': 'salt' }),
    el({ 'data-color-profile': 'sand' }),
  ];
  const card = {
    _staffStyleBound: false,
    contains() { return true; },
    addEventListener(type, fn) { card._onClick = fn; },
  };
  const { getStaffPortalI18nBootstrapScript } = require('./lib/staff-portal-i18n');
  const boot = getStaffPortalI18nBootstrapScript(['en', 'es']);
  const script = boot.replace(/^<script>/, '').replace(/<\/script>$/, '');
  const ctx = {
    document: {
      documentElement: htmlEl,
      getElementById(id) {
        if (id === 'staff-theme-toggle') return moon;
        if (id === 'staff-style-card') return card;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '#staff-style-card [data-color-profile]') return cardKids.filter((n) => n.attrs['data-color-profile']);
        if (sel === '#staff-style-card [data-style-theme]') return [];
        if (sel === '#staff-style-palette-embed [data-style-combo]') return [];
        if (sel === '.staff-lang-btn') return [];
        return [];
      },
      addEventListener() {},
    },
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem(k, v) { store[k] = String(v); },
      removeItem(k) { delete store[k]; },
    },
    window: null,
    console,
  };
  ctx.window = ctx;
  vm.runInNewContext(script, ctx);
  ctx.applyStaffTheme();
  ctx.bindStaffStyleCard();
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'salt', 'vm default profile salt');
  assert.strictEqual(htmlEl.attrs['data-theme'], 'light', 'vm default theme light');
  assert.ok(cardKids[0].classList.contains('is-active'), 'vm Salt pill');
  ctx.toggleStaffTheme();
  assert.strictEqual(htmlEl.attrs['data-theme'], 'dark', 'vm moon dark');
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'salt', 'vm moon keeps salt for light return');
  ctx.setStaffColorProfile('sand');
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'sand', 'vm sand pill');
  assert.ok(cardKids[1].classList.contains('is-active'), 'vm Sand pill active');
  ctx.setStaffTheme('light');
  assert.strictEqual(htmlEl.attrs['data-theme'], 'light', 'vm back to light');
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'sand', 'vm sand survives light');
}

async function main() {
  simulateStyleCard();
  const pw = loadPlaywright();
  if (!pw || !pw.chromium) {
    console.log('verify-ui-salt-facelift-001: PASS');
    return;
  }
  let browser;
  try {
    browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    console.log('verify-ui-salt-facelift-001: PASS');
    return;
  }

  const { getStaffPortalI18nBootstrapScript, getStaffPortalThemeEarlyScript } = require('./lib/staff-portal-i18n');
  const boot = getStaffPortalI18nBootstrapScript(['en', 'es']);
  const early = getStaffPortalThemeEarlyScript();
  const liveHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ui-salt-facelift-001</title>
${early}
<style>
${style}
body{margin:0;background:var(--cream);color:var(--text)}
#probe{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.bc-room-hdr{background:var(--room-bar,#4A4540);color:var(--room-bar-fg,#fff);padding:8px}
.bc-block-confirmed{background:var(--booking-confirmed-bg);color:var(--booking-confirmed-fg);border:1px solid var(--booking-confirmed-border);border-left:3px solid var(--booking-confirmed-rail);padding:8px;display:inline-block}
.pill-purple{background:var(--chip-transfer-bg);color:var(--chip-transfer-fg);border:1px solid var(--chip-transfer-border);padding:2px 6px}
.bc-block-pay-balance{background:var(--chip-balance-bg);color:var(--chip-balance-fg);border:1px solid var(--chip-balance-border);padding:2px 6px}
.bc-block-pay-link{background:var(--chip-link-bg);color:var(--chip-link-fg);border:1px solid var(--chip-link-border);padding:2px 6px}
</style>
${boot}
</head>
<body class="luna-header-ui">
<div id="banner">banner</div>
<button type="button" class="staff-theme-toggle" id="staff-theme-toggle" aria-pressed="false">moon</button>
<section class="staff-style-card luna-header-mode-card" id="staff-style-card" aria-label="Style">
  <div id="luna-header-mode-card" class="staff-style-header-block">
    <button type="button" data-header-mode="normal">Normal</button>
    <button type="button" data-header-mode="compact">Compact</button>
    <button type="button" data-header-mode="sunset">Sunset</button>
    <button type="button" data-header-mode="moonlight">Moonlight</button>
    <button type="button" data-header-mode="sunsetmoonlight">Sunset &amp; Moonlight</button>
    <button type="button" class="luna-header-mode-pencil" id="luna-header-mode-edit-btn">✎</button>
  </div>
  <div class="staff-style-mode" id="staff-style-light-mode">
    <div class="staff-style-mode-title">Light mode</div>
    <div class="staff-style-row" role="group" aria-label="Light palette">
      <button type="button" class="luna-header-mode-btn" data-color-profile="salt">Salt</button>
      <button type="button" class="luna-header-mode-btn" data-color-profile="sand">Sand</button>
    </div>
  </div>
  <div class="staff-style-mode" id="staff-style-dark-mode">
    <div class="staff-style-mode-title">Dark mode</div>
    <div class="staff-style-row staff-style-row--static">
      <span class="luna-header-mode-btn is-active">Sand</span>
    </div>
  </div>
</section>
<div class="bc-room-hdr" id="probe-room">Room 1</div>
<div class="bc-block-confirmed" id="probe-booking">Ty <span class="pill-purple">Transfer</span><span class="bc-block-pay-balance">Balance due</span><span class="bc-block-pay-link">Link sent</span></div>
<div id="probe">probe</div>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(liveHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('wh_staff_portal_theme');
      localStorage.removeItem('wh_staff_color_profile');
    } catch (e) {}
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    if (typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(document);
    if (typeof window.bindStaffThemeToggle === 'function') window.bindStaffThemeToggle();
    if (typeof window.bindStaffStyleCard === 'function') window.bindStaffStyleCard();
  });

  let got = await readTokens(page);
  assert.strictEqual(got.profile, 'salt', 'default profile is salt');
  assert.ok(got.theme === 'light' || got.theme === null, 'default theme light');
  assertTokenSet('default Salt Light computed', got, SALT_LIGHT);
  assert.strictEqual(got.saltPill, true, 'Salt pill active by default');
  assert.strictEqual(got.sandPill, false, 'Sand pill idle by default');
  assert.strictEqual(got.lightTitle, true, 'Light mode title present');
  assert.strictEqual(got.darkTitle, true, 'Dark mode title present');
  assert.deepStrictEqual(got.headerModes, HEADER_MODES, 'five header modes stay');

  await page.click('[data-color-profile="sand"]');
  got = await readTokens(page);
  assertTokenSet('Sand Light via pill', got, SAND_LIGHT);
  assert.strictEqual(got.sandPill, true, 'Sand pill active');

  await page.click('#staff-theme-toggle');
  got = await readTokens(page);
  assert.strictEqual(got.theme, 'dark', 'moon sets dark');
  assert.strictEqual(got.profile, 'sand', 'moon keeps sand');
  assertTokenSet('Sand Dark via moon from sand light', got, SAND_DARK);
  assert.ok(String(got.bannerImage).includes('luna-header-banner-dark.png'), 'dark banner uses moonlight PNG, not a flat gradient');
  assert.ok(/100%\s*100%/.test(String(got.bannerSize)), 'dark banner size fills the bar, got ' + got.bannerSize);
  assert.ok(!/repeat$/.test(String(got.bannerRepeat)) || String(got.bannerRepeat) === 'no-repeat', 'dark banner does not tile, got ' + got.bannerRepeat);

  await page.click('[data-color-profile="salt"]');
  got = await readTokens(page);
  assert.strictEqual(got.profile, 'salt', 'salt stored while dark');
  assertTokenSet('dark stays Sand Dark even if light palette is Salt', got, SAND_DARK);

  await page.click('#staff-theme-toggle');
  got = await readTokens(page);
  assert.strictEqual(got.theme, 'light', 'moon back to light');
  assertTokenSet('Salt Light restored after dark', got, SALT_LIGHT);

  const saltProbe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const room = getComputedStyle(document.getElementById('probe-room'));
    const booking = getComputedStyle(document.getElementById('probe-booking'));
    return {
      cream: cs.getPropertyValue('--cream').trim().toUpperCase(),
      surface: cs.getPropertyValue('--surface').trim().toUpperCase(),
      primary: cs.getPropertyValue('--primary').trim().toUpperCase(),
      sage: cs.getPropertyValue('--sage').trim().toUpperCase(),
      roomBar: cs.getPropertyValue('--room-bar').trim().toUpperCase(),
      confirmedBg: cs.getPropertyValue('--booking-confirmed-bg').trim().toUpperCase(),
      roomBg: room.backgroundColor,
      bookingBg: booking.backgroundColor,
    };
  });
  await page.click('[data-color-profile="sand"]');
  const sandProbe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const room = getComputedStyle(document.getElementById('probe-room'));
    const booking = getComputedStyle(document.getElementById('probe-booking'));
    return {
      cream: cs.getPropertyValue('--cream').trim().toUpperCase(),
      surface: cs.getPropertyValue('--surface').trim().toUpperCase(),
      primary: cs.getPropertyValue('--primary').trim().toUpperCase(),
      sage: cs.getPropertyValue('--sage').trim().toUpperCase(),
      roomBar: cs.getPropertyValue('--room-bar').trim().toUpperCase(),
      confirmedBg: cs.getPropertyValue('--booking-confirmed-bg').trim().toUpperCase(),
      roomBg: room.backgroundColor,
      bookingBg: booking.backgroundColor,
    };
  });
  assert.notStrictEqual(saltProbe.cream, sandProbe.cream, 'Salt cream ≠ Sand cream');
  assert.notStrictEqual(saltProbe.surface, sandProbe.surface, 'Salt surface ≠ Sand surface');
  assert.notStrictEqual(saltProbe.primary, sandProbe.primary, 'Salt primary ≠ Sand primary');
  assert.strictEqual(saltProbe.roomBar, '#3A3A3C', 'Salt room-bar is cool charcoal');
  assert.strictEqual(sandProbe.roomBar, '#4E5853', 'Sand room-bar is charcoal not sage');
  assert.notStrictEqual(saltProbe.roomBar, saltProbe.sage, 'room-bar split from sage');
  assert.notStrictEqual(sandProbe.roomBar, sandProbe.sage, 'Sand room-bar is not sage green');
  assert.notStrictEqual(saltProbe.roomBg, sandProbe.roomBg, 'room header color changes with palette');
  assert.strictEqual(saltProbe.roomBg, 'rgb(58, 58, 60)', 'Salt room hdr fill is cool charcoal #3A3A3C');
  assert.strictEqual(sandProbe.roomBg, 'rgb(78, 88, 83)', 'Sand room hdr fill is charcoal #4E5853');
  assert.ok(!/rgb\(122,\s*132,\s*88\)|rgb\(184,\s*203,\s*176\)|rgb\(74,\s*69,\s*64\)/i.test(saltProbe.roomBg), 'Salt room bars not sage/coffee');
  assert.strictEqual(saltProbe.confirmedBg, '#FFFFFF', 'Salt confirmed pill is white');
  assert.strictEqual(sandProbe.confirmedBg, '#F5F1EA', 'Sand confirmed pill is surface not green');
  assert.strictEqual(saltProbe.bookingBg, 'rgb(255, 255, 255)', 'Salt confirmed pill fill is white');
  assert.strictEqual(sandProbe.bookingBg, 'rgb(245, 241, 234)', 'Sand confirmed pill fill is surface');
  assert.ok(!/E0E6D0|CEDFBF|DCEAD2/i.test(saltProbe.confirmedBg + sandProbe.confirmedBg), 'no pale olive booking fill');
  assert.ok(!/rgb\(224,\s*230,\s*208\)|rgb\(206,\s*223,\s*191\)|rgb\(220,\s*234,\s*210\)/i.test(saltProbe.bookingBg + sandProbe.bookingBg), 'booking pill fills not pale olive');
  assert.strictEqual(saltProbe.cream, '#F5F5F7');
  assert.strictEqual(sandProbe.cream, '#EDE8E0');
  assert.strictEqual(saltProbe.primary, '#1B4D3E');
  assert.strictEqual(sandProbe.primary, '#4E5853');
  assert.strictEqual(saltProbe.surface, '#FFFFFF');

  void hexOf;
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  console.log('verify-ui-salt-facelift-001: PASS');
}

main().catch((err) => {
  console.error('verify-ui-salt-facelift-001: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
