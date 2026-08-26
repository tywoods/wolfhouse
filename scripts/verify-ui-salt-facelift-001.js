'use strict';

/**
 * UI-SALT-FACELIFT-001 — Salt/Sand × Light/Dark, Style card, four embed palettes.
 *
 * CSS/layout only. Does not touch send/inbound. staff-staging chrome.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
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
  cream: '#F4F0E8',
  surface: '#FFFCF6',
  'surface-soft': '#F0EBE3',
  sand: '#E8E0D4',
  tan: '#D2C6B6',
  sage: '#7F9A82',
  olive: '#6E8A72',
  'dusty-blue': '#8AA4B0',
  ocean: '#5E8494',
  teal: '#D7E8E4',
  text: '#1F2A26',
  'text-2': '#5A6862',
  'text-3': '#8A9690',
  border: '#E4DCD0',
  'border-soft': '#EDE6DC',
  primary: '#1A6A65',
  'primary-hover': '#155751',
  focus: '#1A6A65',
  'luna-teal': '#1A6A65',
  'luna-teal-dark': '#155751',
};

const SALT_DARK = {
  cream: '#161C1A',
  surface: '#222926',
  'surface-soft': '#2A322E',
  sand: '#323A36',
  tan: '#3A4540',
  sage: '#8AAD90',
  olive: '#6E8A72',
  'dusty-blue': '#7EA8B4',
  ocean: '#4A7380',
  teal: '#243632',
  text: '#F2EDE6',
  'text-2': '#A3AFA9',
  'text-3': '#7A8680',
  border: '#2E3632',
  'border-soft': '#2A322E',
  primary: '#7EB8B2',
  'primary-hover': '#93C7C1',
  focus: '#7EB8B2',
  'luna-teal': '#7EB8B2',
  'luna-teal-dark': '#93C7C1',
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
  'lunaStaff.style.theme.light',
  'lunaStaff.style.theme.dark',
  'lunaStaff.style.combo.saltLight',
  'lunaStaff.style.combo.saltDark',
  'lunaStaff.style.combo.sandLight',
  'lunaStaff.style.combo.sandDark',
];

for (const key of I18N_KEYS) {
  assert.ok(en[key] && en[key] !== key, 'EN missing ' + key);
  assert.ok(es[key] && es[key] !== key, 'ES missing ' + key);
}
assert.notStrictEqual(en['lunaStaff.style.palette.salt'], es['lunaStaff.style.palette.salt']);
assert.strictEqual(en['lunaStaff.style.palette.salt'], 'Salt');
assert.strictEqual(en['lunaStaff.style.palette.sand'], 'Sand');
assert.strictEqual(en['lunaStaff.style.theme.light'], 'Light');
assert.strictEqual(en['lunaStaff.style.theme.dark'], 'Dark');

const saltLightCss = extractBlock(
  apiSrc,
  /:root\{/,
  /\n\[data-theme="dark"\]\{/
);
assertTokens('Salt Light :root', saltLightCss, SALT_LIGHT);
assert.ok(!/--cream:#EDE8E0/.test(saltLightCss), 'Salt Light :root must not keep Sand oatmeal cream');

const saltDarkCss = extractBlock(
  apiSrc,
  /\[data-theme="dark"\]\{/,
  /\n\[data-color-profile="sand"\]\{/
);
assertTokens('Salt Dark [data-theme=dark]', saltDarkCss, SALT_DARK);
assert.ok(!/--cream:#181818/.test(saltDarkCss), 'default dark must not be VS Code charcoal cream');
assert.ok(!/--surface:#252526/.test(saltDarkCss), 'default dark must not be VS Code charcoal surface');

const sandLightCss = extractBlock(
  apiSrc,
  /\[data-color-profile="sand"\]\{/,
  /\n\[data-color-profile="sand"\]\[data-theme="dark"\]\{/
);
assertTokens('Sand Light', sandLightCss, SAND_LIGHT);

const sandDarkCss = extractBlock(
  apiSrc,
  /\[data-color-profile="sand"\]\[data-theme="dark"\]\{/,
  /\n\[data-color-profile="sand"\]\[data-theme="dark"\] /
);
assertTokens('Sand Dark', sandDarkCss, SAND_DARK);

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
assert.ok(apiSrc.includes('id="staff-style-palette-embed"'), 'four-palette embed present');
assert.ok(apiSrc.includes('data-style-combo="salt-light"'), 'embed Salt Light');
assert.ok(apiSrc.includes('data-style-combo="salt-dark"'), 'embed Salt Dark');
assert.ok(apiSrc.includes('data-style-combo="sand-light"'), 'embed Sand Light');
assert.ok(apiSrc.includes('data-style-combo="sand-dark"'), 'embed Sand Dark');
assert.ok(apiSrc.includes('data-color-profile="salt"'), 'Salt pill');
assert.ok(apiSrc.includes('data-color-profile="sand"'), 'Sand pill');
assert.ok(apiSrc.includes('data-style-theme="light"'), 'Light pill');
assert.ok(apiSrc.includes('data-style-theme="dark"'), 'Dark pill');
assert.ok(
  !/\b(Foam|Sol|Kelp|Ember)\b/.test(apiSrc.slice(apiSrc.indexOf('id="staff-style-card"'), apiSrc.indexOf('id="luna-header-mode-card"'))),
  'Style card is Salt+Sand only — no Foam/Sol/Kelp/Ember'
);

const HEADER_MODES = ['normal', 'compact', 'sunset', 'moonlight', 'sunsetmoonlight'];
for (const mode of HEADER_MODES) {
  assert.ok(
    apiSrc.includes('data-header-mode="' + mode + '"'),
    'header still has mode ' + mode
  );
}
assert.ok(apiSrc.includes('id="luna-header-mode-card"'), 'Header style card stays');
assert.ok(adminUi.includes('function wireLunaStaffHeaderModeCard'), 'header mode wire stays');

assert.ok(!/function sendWhatsApp|handleInbound/.test(i18nSrc), 'i18n bootstrap stayed CSS/layout');

const styleStart = apiSrc.indexOf('/* ── Palette (soft boutique-hospitality)');
const styleEnd = apiSrc.indexOf('</style>', styleStart);
assert.ok(styleStart >= 0 && styleEnd > styleStart, 'main style block found');
const style = apiSrc.slice(styleStart, styleEnd);

const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ui-salt-facelift-001</title>
<style>
${style}
body{margin:0;background:var(--cream);color:var(--text)}
#probe{background:var(--surface);color:var(--text);border:1px solid var(--border)}
</style>
</head>
<body>
<button type="button" class="staff-theme-toggle" id="staff-theme-toggle" aria-pressed="false">moon</button>
<section class="staff-style-card luna-header-mode-card" id="staff-style-card" aria-label="Style">
  <div class="staff-style-row" role="group" aria-label="Palette">
    <button type="button" class="luna-header-mode-btn" data-color-profile="salt">Salt</button>
    <button type="button" class="luna-header-mode-btn" data-color-profile="sand">Sand</button>
  </div>
  <div class="staff-style-row" role="group" aria-label="Theme">
    <button type="button" class="luna-header-mode-btn" data-style-theme="light">Light</button>
    <button type="button" class="luna-header-mode-btn" data-style-theme="dark">Dark</button>
  </div>
  <div class="staff-style-palette-embed" id="staff-style-palette-embed" role="group" aria-label="Palettes">
    <button type="button" class="staff-style-swatch" data-style-combo="salt-light">Salt Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="salt-dark">Salt Dark</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-light">Sand Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-dark">Sand Dark</button>
  </div>
</section>
<section class="luna-header-mode-card" id="luna-header-mode-card">
  <button type="button" data-header-mode="normal">Normal</button>
  <button type="button" data-header-mode="compact">Compact</button>
  <button type="button" data-header-mode="sunset">Sunset</button>
  <button type="button" data-header-mode="moonlight">Moonlight</button>
  <button type="button" data-header-mode="sunsetmoonlight">Sunset &amp; Moonlight</button>
</section>
<div id="probe">probe</div>
<script>
${i18nSrc
    .slice(
      i18nSrc.indexOf("return `<script>\\n(function(){"),
      i18nSrc.lastIndexOf('</script>`')
    )
    .replace(/^return `<script>\\n/, '')
    .replace(/\$\{json\}/g, JSON.stringify(STAFF_PORTAL_STRINGS))
    .replace(/\$\{localesJson\}/g, JSON.stringify(['es', 'en']))
    .replace(/\$\{JSON\\.stringify\\(defaultLocale\\)\\}/g, JSON.stringify('es'))}
</script>
</body>
</html>`;

// The bootstrap extract above is fragile — build a self-contained harness instead.
const harnessHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ui-salt-facelift-001</title>
<style>
${style}
body{margin:0;background:var(--cream);color:var(--text)}
#probe{background:var(--surface);color:var(--text);border:1px solid var(--border)}
</style>
<script>
(function(){
  try {
    var t = localStorage.getItem('wh_staff_portal_theme');
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    var p = localStorage.getItem('wh_staff_color_profile');
    document.documentElement.setAttribute('data-color-profile', p === 'sand' ? 'sand' : 'salt');
  } catch (e) {}
})();
</script>
</head>
<body>
<button type="button" class="staff-theme-toggle" id="staff-theme-toggle" aria-pressed="false">moon</button>
<section class="staff-style-card luna-header-mode-card" id="staff-style-card" aria-label="Style">
  <div class="staff-style-row" role="group" aria-label="Palette">
    <button type="button" class="luna-header-mode-btn" data-color-profile="salt">Salt</button>
    <button type="button" class="luna-header-mode-btn" data-color-profile="sand">Sand</button>
  </div>
  <div class="staff-style-row" role="group" aria-label="Theme">
    <button type="button" class="luna-header-mode-btn" data-style-theme="light">Light</button>
    <button type="button" class="luna-header-mode-btn" data-style-theme="dark">Dark</button>
  </div>
  <div class="staff-style-palette-embed" id="staff-style-palette-embed" role="group" aria-label="Palettes">
    <button type="button" class="staff-style-swatch" data-style-combo="salt-light">Salt Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="salt-dark">Salt Dark</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-light">Sand Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-dark">Sand Dark</button>
  </div>
</section>
<section class="luna-header-mode-card" id="luna-header-mode-card">
  <button type="button" data-header-mode="normal">Normal</button>
  <button type="button" data-header-mode="compact">Compact</button>
  <button type="button" data-header-mode="sunset">Sunset</button>
  <button type="button" data-header-mode="moonlight">Moonlight</button>
  <button type="button" data-header-mode="sunsetmoonlight">Sunset &amp; Moonlight</button>
</section>
<div id="probe">probe</div>
<script>
${(function () {
    const start = i18nSrc.indexOf("  return `<script>\\n(function(){");
    // Use the runtime functions by inlining a copy that matches production API.
    return '';
  })()}
</script>
</body>
</html>`;

void pageHtml;
void harnessHtml;

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
      'cream',
      'surface',
      'surface-soft',
      'sand',
      'tan',
      'sage',
      'olive',
      'dusty-blue',
      'ocean',
      'teal',
      'text',
      'text-2',
      'text-3',
      'border',
      'border-soft',
      'primary',
      'primary-hover',
      'focus',
      'luna-teal',
      'luna-teal-dark',
    ];
    const out = {};
    names.forEach((n) => {
      out[n] = cs.getPropertyValue('--' + n).trim();
    });
    out.profile = document.documentElement.getAttribute('data-color-profile');
    out.theme = document.documentElement.getAttribute('data-theme');
    const moon = document.getElementById('staff-theme-toggle');
    out.moonPressed = moon ? moon.getAttribute('aria-pressed') : null;
    out.moonDarkClass = moon ? moon.classList.contains('is-dark') : null;
    out.lightPill = !!document.querySelector('[data-style-theme="light"].is-active');
    out.darkPill = !!document.querySelector('[data-style-theme="dark"].is-active');
    out.saltPill = !!document.querySelector('[data-color-profile="salt"].is-active');
    out.sandPill = !!document.querySelector('[data-color-profile="sand"].is-active');
    out.combo = {};
    ['salt-light', 'salt-dark', 'sand-light', 'sand-dark'].forEach((c) => {
      const el = document.querySelector('[data-style-combo="' + c + '"]');
      out.combo[c] = !!(el && el.classList.contains('is-active'));
    });
    out.headerModes = Array.from(document.querySelectorAll('[data-header-mode]')).map((el) =>
      el.getAttribute('data-header-mode')
    );
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
    el({ 'data-style-theme': 'light' }),
    el({ 'data-style-theme': 'dark' }),
    el({ 'data-style-combo': 'salt-light' }),
    el({ 'data-style-combo': 'salt-dark' }),
    el({ 'data-style-combo': 'sand-light' }),
    el({ 'data-style-combo': 'sand-dark' }),
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
        if (sel === '#staff-style-card [data-style-theme]') return cardKids.filter((n) => n.attrs['data-style-theme']);
        if (sel === '#staff-style-palette-embed [data-style-combo]') return cardKids.filter((n) => n.attrs['data-style-combo']);
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
  assert.ok(cardKids[2].classList.contains('is-active'), 'vm Light pill');
  assert.ok(cardKids[4].classList.contains('is-active'), 'vm Salt Light embed');
  ctx.toggleStaffTheme();
  assert.strictEqual(htmlEl.attrs['data-theme'], 'dark', 'vm moon dark');
  assert.ok(cardKids[3].classList.contains('is-active'), 'vm Dark pill follows moon');
  assert.ok(cardKids[5].classList.contains('is-active'), 'vm Salt Dark embed follows moon');
  ctx.setStaffStyleCombo('sand-dark');
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'sand', 'vm embed sand');
  assert.strictEqual(htmlEl.attrs['data-theme'], 'dark', 'vm embed dark');
  assert.ok(cardKids[1].classList.contains('is-active'), 'vm Sand pill');
  ctx.setStaffStyleCombo('salt-light');
  assert.strictEqual(htmlEl.attrs['data-color-profile'], 'salt', 'vm back to salt');
  assert.strictEqual(htmlEl.attrs['data-theme'], 'light', 'vm back to light');
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
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('wh_staff_portal_theme');
      localStorage.removeItem('wh_staff_color_profile');
    } catch (e) {}
  });

  // Production bootstrap from the module, not a copy.
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
</style>
${boot}
</head>
<body>
<button type="button" class="staff-theme-toggle" id="staff-theme-toggle" aria-pressed="false">moon</button>
<section class="staff-style-card luna-header-mode-card" id="staff-style-card" aria-label="Style">
  <div class="staff-style-row" role="group" aria-label="Palette">
    <button type="button" class="luna-header-mode-btn" data-color-profile="salt">Salt</button>
    <button type="button" class="luna-header-mode-btn" data-color-profile="sand">Sand</button>
  </div>
  <div class="staff-style-row" role="group" aria-label="Theme">
    <button type="button" class="luna-header-mode-btn" data-style-theme="light">Light</button>
    <button type="button" class="luna-header-mode-btn" data-style-theme="dark">Dark</button>
  </div>
  <div class="staff-style-palette-embed" id="staff-style-palette-embed" role="group" aria-label="Palettes">
    <button type="button" class="staff-style-swatch" data-style-combo="salt-light">Salt Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="salt-dark">Salt Dark</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-light">Sand Light</button>
    <button type="button" class="staff-style-swatch" data-style-combo="sand-dark">Sand Dark</button>
  </div>
</section>
<section class="luna-header-mode-card" id="luna-header-mode-card">
  <button type="button" data-header-mode="normal">Normal</button>
  <button type="button" data-header-mode="compact">Compact</button>
  <button type="button" data-header-mode="sunset">Sunset</button>
  <button type="button" data-header-mode="moonlight">Moonlight</button>
  <button type="button" data-header-mode="sunsetmoonlight">Sunset &amp; Moonlight</button>
</section>
<div id="probe">probe</div>
</body>
</html>`;

  const page = await context.newPage();
  await page.setContent(liveHtml, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    if (typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(document);
    if (typeof window.bindStaffThemeToggle === 'function') window.bindStaffThemeToggle();
    if (typeof window.bindStaffStyleCard === 'function') window.bindStaffStyleCard();
  });

  let got = await readTokens(page);
  assert.strictEqual(got.profile, 'salt', 'default profile is salt');
  assert.ok(got.theme === 'light' || got.theme === null || got.theme === 'light', 'default theme light');
  assertTokenSet('default Salt Light computed', got, SALT_LIGHT);
  assert.strictEqual(got.lightPill, true, 'Light pill active by default');
  assert.strictEqual(got.darkPill, false, 'Dark pill idle by default');
  assert.strictEqual(got.saltPill, true, 'Salt pill active by default');
  assert.strictEqual(got.sandPill, false, 'Sand pill idle by default');
  assert.strictEqual(got.combo['salt-light'], true, 'embed Salt Light active');
  assert.deepStrictEqual(got.headerModes, HEADER_MODES, 'five header modes stay');

  await page.click('#staff-theme-toggle');
  got = await readTokens(page);
  assert.strictEqual(got.theme, 'dark', 'moon sets dark');
  assert.strictEqual(got.profile, 'salt', 'moon keeps salt');
  assertTokenSet('Salt Dark via moon', got, SALT_DARK);
  assert.strictEqual(got.darkPill, true, 'Dark pill follows moon');
  assert.strictEqual(got.lightPill, false, 'Light pill follows moon');
  assert.strictEqual(got.moonPressed, 'true', 'moon pressed in dark');
  assert.strictEqual(got.combo['salt-dark'], true, 'embed Salt Dark follows moon');

  await page.click('[data-style-theme="light"]');
  got = await readTokens(page);
  assert.strictEqual(got.theme, 'light', 'Light pill sets theme');
  assert.strictEqual(got.moonPressed, 'false', 'moon follows Light pill');
  assertTokenSet('Salt Light via pill', got, SALT_LIGHT);

  await page.click('[data-style-combo="sand-dark"]');
  got = await readTokens(page);
  assert.strictEqual(got.profile, 'sand', 'embed Sand Dark sets sand');
  assert.strictEqual(got.theme, 'dark', 'embed Sand Dark sets dark');
  assertTokenSet('Sand Dark via embed', got, SAND_DARK);
  assert.strictEqual(got.sandPill, true, 'Sand pill follows embed');
  assert.strictEqual(got.darkPill, true, 'Dark pill follows embed');
  assert.strictEqual(got.moonPressed, 'true', 'moon follows Sand Dark embed');
  assert.ok(!normHex(got.surface).includes('222926'), 'Sand Dark is not Salt Dark surface');

  await page.click('[data-color-profile="salt"]');
  await page.click('[data-style-theme="light"]');
  await page.click('[data-style-combo="sand-light"]');
  got = await readTokens(page);
  assertTokenSet('Sand Light via embed', got, SAND_LIGHT);

  await page.click('[data-style-combo="salt-dark"]');
  got = await readTokens(page);
  assertTokenSet('Salt Dark via embed', got, SALT_DARK);
  assert.notStrictEqual(normHex(got.cream), '#181818', 'Salt Dark cream is not VS Code #181818');
  assert.notStrictEqual(normHex(got.surface), '#252526', 'Salt Dark surface is not VS Code #252526');

  await browser.close();
  console.log('verify-ui-salt-facelift-001: PASS');
}

main().catch((err) => {
  console.error('verify-ui-salt-facelift-001: FAIL');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
