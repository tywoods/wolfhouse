'use strict';

/**
 * Luna Staff header style — Save/dirty honesty (Bug Finder P3).
 *
 * Selecting a header mode must NOT apply or persist until Save.
 * Cancel discards the draft. EN/ES chrome strings must exist.
 * Does not touch Admin Email or staff-query-api.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { chromium } = require('playwright');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const adminUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-ui.js'), 'utf8');
const staffApi = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;

const I18N_KEYS = [
  'lunaStaff.headerStyle.title',
  'lunaStaff.headerStyle.sub',
  'lunaStaff.headerStyle.edit',
  'lunaStaff.headerStyle.save',
  'lunaStaff.headerStyle.cancel',
  'lunaStaff.headerStyle.unsaved',
  'lunaStaff.headerStyle.mode.normal',
  'lunaStaff.headerStyle.mode.compact',
  'lunaStaff.headerStyle.mode.sunset',
  'lunaStaff.headerStyle.mode.moonlight',
  'lunaStaff.headerStyle.mode.sunsetmoonlight',
];

for (const key of I18N_KEYS) {
  assert.ok(en[key] && en[key] !== key, 'EN missing ' + key);
  assert.ok(es[key] && es[key] !== key, 'ES missing ' + key);
}
assert.notStrictEqual(en['lunaStaff.headerStyle.save'], es['lunaStaff.headerStyle.save']);
assert.notStrictEqual(en['lunaStaff.headerStyle.unsaved'], es['lunaStaff.headerStyle.unsaved']);
assert.ok(en['lunaStaff.headerStyle.sub'].toLowerCase().includes('save'));
assert.ok(es['lunaStaff.headerStyle.sub'].toLowerCase().includes('guardar'));

assert.ok(adminUi.includes('function wireLunaStaffHeaderModeCard'), 'wire helper present');
assert.ok(adminUi.includes('function lunaStaffHeaderModeRefreshI18n'), 'locale refresh present');
assert.ok(adminUi.includes('lunaStaffHeaderModeRefreshI18n()'), 'locale hook wired');
assert.ok(adminUi.includes('Draft only'), 'draft-only comment present');
assert.ok(/apply\(draft,\s*true\)/.test(adminUi), 'Save persists via apply(..., true)');
assert.ok(adminUi.includes("removeAttribute('onclick')"), 'override strips onclick');
assert.ok(adminUi.includes('luna-header-mode-save-btn'), 'Save button created');
assert.ok(adminUi.includes('luna-header-mode-cancel-btn'), 'Cancel button created');
assert.ok(
  staffApi.includes("onclick=\"window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('normal',true)\""),
  'baseline template still has instant apply (override owns honesty)'
);
assert.ok(staffApi.includes('id="luna-header-mode-done-btn"'), 'legacy Done button still in template');

const honestyMatch = adminUi.match(
  /\/\* ── Luna Staff header style: draft \+ Save[\s\S]*?\(function lunaStaffHeaderModeBoot\(\)\{[\s\S]*?\}\)\(\);/
);
assert.ok(honestyMatch, 'honesty module extractable');

const headerCtrlMatch = staffApi.match(
  /\(function\(\)\{\s*var MODES=\['normal','compact','sunset','moonlight','sunsetmoonlight'\][\s\S]*?window\.__lunaHeaderMode=\{apply:apply,current:current[\s\S]*?\}\)\(\);/
);
assert.ok(headerCtrlMatch, 'header mode controller extractable');

const enJson = JSON.stringify(en);
const esJson = JSON.stringify(es);

const pageHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>header-mode-save</title></head>
<body class="luna-header-ui luna-hdr-sunsetmoonlight">
<section class="luna-header-mode-card" id="luna-header-mode-card" aria-label="Header style">
  <div class="luna-header-mode-head">
    <span class="luna-header-mode-title">Header style</span>
    <span class="luna-header-mode-sub">How the top banner looks across the staff portal.</span>
  </div>
  <div class="luna-header-mode-read">
    <span class="luna-header-mode-current" id="luna-header-mode-current">—</span>
    <button type="button" class="luna-header-mode-edit" id="luna-header-mode-edit-btn">Edit</button>
  </div>
  <div class="luna-header-mode-seg" role="group" aria-label="Header style">
    <button type="button" class="luna-header-mode-btn" data-header-mode="normal" aria-pressed="false" onclick="window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('normal',true)">Normal</button>
    <button type="button" class="luna-header-mode-btn" data-header-mode="compact" aria-pressed="false" onclick="window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('compact',true)">Compact</button>
    <button type="button" class="luna-header-mode-btn" data-header-mode="sunset" aria-pressed="false" onclick="window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('sunset',true)">Sunset</button>
    <button type="button" class="luna-header-mode-btn" data-header-mode="moonlight" aria-pressed="false" onclick="window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('moonlight',true)">Moonlight</button>
    <button type="button" class="luna-header-mode-btn" data-header-mode="sunsetmoonlight" aria-pressed="false" onclick="window.__lunaHeaderMode&&window.__lunaHeaderMode.apply('sunsetmoonlight',true)">Sunset &amp; Moonlight</button>
    <button type="button" class="luna-header-mode-btn luna-header-mode-done" id="luna-header-mode-done-btn">Done</button>
  </div>
</section>
<script>
window.__EN = ${enJson};
window.__ES = ${esJson};
window.__PACK = window.__EN;
try { localStorage.setItem('wh_staff_header_mode', 'sunsetmoonlight'); } catch (e) {}
function portalT(key){ var p=window.__PACK||{}; return p[key] || key; }
function t(key){ return portalT(key); }
function applyStaffPortalI18n(root){
  var scope = root || document;
  scope.querySelectorAll('[data-i18n]').forEach(function(el){
    var k = el.getAttribute('data-i18n');
    if (k) el.textContent = portalT(k);
  });
}
</script>
<script>
${headerCtrlMatch[0]}
</script>
<script>
${honestyMatch[0]}
</script>
</body>
</html>`;

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });

  const boot = await page.evaluate(() => ({
    hasApi: !!(window.__lunaHeaderMode),
    saved: window.__lunaHeaderMode.current(),
    doneGone: !document.getElementById('luna-header-mode-done-btn'),
    savePresent: !!document.getElementById('luna-header-mode-save-btn'),
    cancelPresent: !!document.getElementById('luna-header-mode-cancel-btn'),
    onclickGone: [...document.querySelectorAll('[data-header-mode]')].every((b) => !b.getAttribute('onclick')),
    storage: localStorage.getItem('wh_staff_header_mode'),
    body: document.body.className,
  }));
  assert.ok(boot.hasApi, 'controller mounted');
  assert.strictEqual(boot.saved, 'sunsetmoonlight');
  assert.ok(boot.doneGone, 'Done removed');
  assert.ok(boot.savePresent, 'Save present');
  assert.ok(boot.cancelPresent, 'Cancel present');
  assert.ok(boot.onclickGone, 'onclick stripped');
  assert.strictEqual(boot.storage, 'sunsetmoonlight');
  assert.ok(boot.body.includes('luna-hdr-sunsetmoonlight'));

  await page.click('#luna-header-mode-edit-btn');
  await page.click('[data-header-mode="compact"]');

  const afterDraft = await page.evaluate(() => ({
    editing: document.getElementById('luna-header-mode-card').classList.contains('is-editing'),
    dirty: document.getElementById('luna-header-mode-card').classList.contains('is-dirty'),
    compactActive: document.querySelector('[data-header-mode="compact"]').classList.contains('is-active'),
    storage: localStorage.getItem('wh_staff_header_mode'),
    body: document.body.className,
    currentLabel: document.getElementById('luna-header-mode-current').textContent,
    saveDisabled: document.getElementById('luna-header-mode-save-btn').disabled,
  }));
  assert.ok(afterDraft.editing, 'Edit opens editor');
  assert.ok(afterDraft.dirty, 'dirty when draft differs');
  assert.ok(afterDraft.compactActive, 'draft highlights compact');
  assert.strictEqual(afterDraft.storage, 'sunsetmoonlight', 'localStorage unchanged before Save');
  assert.ok(afterDraft.body.includes('luna-hdr-sunsetmoonlight'), 'live banner still saved mode');
  assert.ok(!afterDraft.body.includes('luna-hdr-compact'), 'live banner not compact before Save');
  assert.ok(!afterDraft.saveDisabled, 'Save enabled when dirty');
  assert.strictEqual(afterDraft.currentLabel, en['lunaStaff.headerStyle.mode.sunsetmoonlight']);

  await page.click('#luna-header-mode-save-btn');
  const afterSave = await page.evaluate(() => ({
    editing: document.getElementById('luna-header-mode-card').classList.contains('is-editing'),
    dirty: document.getElementById('luna-header-mode-card').classList.contains('is-dirty'),
    storage: localStorage.getItem('wh_staff_header_mode'),
    body: document.body.className,
    currentLabel: document.getElementById('luna-header-mode-current').textContent,
  }));
  assert.ok(!afterSave.editing, 'Save closes editor');
  assert.ok(!afterSave.dirty, 'Save clears dirty');
  assert.strictEqual(afterSave.storage, 'compact', 'Save persists compact');
  assert.ok(afterSave.body.includes('luna-hdr-compact'), 'Save applies compact to banner');
  assert.strictEqual(afterSave.currentLabel, en['lunaStaff.headerStyle.mode.compact']);

  await page.click('#luna-header-mode-edit-btn');
  await page.click('[data-header-mode="moonlight"]');
  await page.click('#luna-header-mode-cancel-btn');
  const afterCancel = await page.evaluate(() => ({
    editing: document.getElementById('luna-header-mode-card').classList.contains('is-editing'),
    storage: localStorage.getItem('wh_staff_header_mode'),
    body: document.body.className,
  }));
  assert.ok(!afterCancel.editing, 'Cancel closes editor');
  assert.strictEqual(afterCancel.storage, 'compact', 'Cancel does not persist moonlight');
  assert.ok(afterCancel.body.includes('luna-hdr-compact'), 'Cancel keeps saved compact');
  assert.ok(!afterCancel.body.includes('luna-hdr-moonlight'), 'Cancel does not leave moonlight live');

  const esChrome = await page.evaluate(() => {
    window.__PACK = window.__ES;
    if (typeof lunaStaffHeaderModeRefreshI18n === 'function') lunaStaffHeaderModeRefreshI18n();
    return {
      title: document.querySelector('.luna-header-mode-title').textContent,
      save: document.getElementById('luna-header-mode-save-btn').textContent,
      unsaved: document.getElementById('luna-header-mode-dirty').textContent,
    };
  });
  assert.strictEqual(esChrome.title, es['lunaStaff.headerStyle.title']);
  assert.strictEqual(esChrome.save, es['lunaStaff.headerStyle.save']);
  assert.strictEqual(esChrome.unsaved, es['lunaStaff.headerStyle.unsaved']);

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  console.log('verify-luna-staff-header-mode-save: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
