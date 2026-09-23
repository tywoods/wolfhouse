'use strict';

/**
 * Shared Staff portal Bookings tab layout redesign gates.
 *
 * Ty split (2026-09-23):
 *  - Desktop + mobile: remove money summary tiles only (Collected/Refunded/Net/Outstanding).
 *  - Mobile only: Bookings|Refund|Unpaid strip, footer scope note, Search+Clear /
 *    Dates|Status|Type|Export toolbar, phone card hierarchy.
 *  - Desktop: keep today's toolbar, rows, and under-summary explainer.
 *
 * Lodging (Wolfhouse) Type filter (2026-09-23 follow-up):
 *  - Desktop: Type stays hidden for lodging (class is-lodging-hide-desktop).
 *  - Mobile ≤768px: Type must be visible for both Sunset and Wolfhouse so the
 *    Type|Export row is present (no inline display:none).
 *
 * Run: node scripts/verify-sunset-bookings-layout-redesign.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra != null ? ` (${extra})` : ''}`);
  }
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_e) {
    try {
      return require('/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
    } catch (_e2) {
      return null;
    }
  }
}

/** Pull the shared Bookings chrome CSS block used for computed-style checks. */
function extractBookingsCss() {
  const start = api.indexOf('/* Admin Bookings N1');
  const endMarker = '.portal-admin-tabpanel{max-width:100%}';
  const end = api.indexOf(endMarker, start >= 0 ? start : 0);
  if (start < 0 || end < 0) return '';
  return api.slice(start, end + endMarker.length);
}

function fixtureHtml(css) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
body{margin:0;font-family:system-ui,sans-serif}
.skin-label{font-size:11px;margin:8px 0 4px;opacity:.7}
</style></head><body>
<p class="skin-label">Sunset (surf — Type never lodging-hidden)</p>
<div class="portal-admin-bookings" data-portal-skin="sunset">
  <div class="portal-admin-bookings-toolbar" role="search">
    <label class="portal-admin-bookings-field portal-admin-bookings-search">
      <span class="portal-admin-bookings-label">Search</span>
      <input class="portal-admin-bookings-input" />
    </label>
    <div class="portal-admin-bookings-field portal-admin-bookings-date-range">
      <span class="portal-admin-bookings-label">Dates</span>
      <button type="button" class="portal-admin-bookings-date-range-trigger">Any dates</button>
    </div>
    <label class="portal-admin-bookings-field portal-admin-bookings-filter-status">
      <span class="portal-admin-bookings-label">Status</span>
      <select class="portal-admin-bookings-input"><option>All</option></select>
    </label>
    <label class="portal-admin-bookings-field portal-admin-bookings-filter-type" id="type-sunset">
      <span class="portal-admin-bookings-label">Type</span>
      <select id="admin-bookings-type-sunset" class="portal-admin-bookings-input"><option>All types</option></select>
    </label>
    <div class="portal-admin-bookings-actions">
      <button type="button" class="portal-admin-bookings-clear-btn">Clear</button>
      <button type="button" class="portal-admin-bookings-export-btn">
        <span class="portal-admin-bookings-export-full">Export CSV</span>
        <span class="portal-admin-bookings-export-short">Export</span>
      </button>
    </div>
  </div>
</div>
<p class="skin-label">Wolfhouse (lodging — desktop hide via is-lodging-hide-desktop)</p>
<div class="portal-admin-bookings" data-portal-skin="wolfhouse">
  <div class="portal-admin-bookings-toolbar" role="search">
    <label class="portal-admin-bookings-field portal-admin-bookings-search">
      <span class="portal-admin-bookings-label">Search</span>
      <input class="portal-admin-bookings-input" />
    </label>
    <div class="portal-admin-bookings-field portal-admin-bookings-date-range">
      <span class="portal-admin-bookings-label">Dates</span>
      <button type="button" class="portal-admin-bookings-date-range-trigger">Any dates</button>
    </div>
    <label class="portal-admin-bookings-field portal-admin-bookings-filter-status">
      <span class="portal-admin-bookings-label">Status</span>
      <select class="portal-admin-bookings-input"><option>All</option></select>
    </label>
    <label class="portal-admin-bookings-field portal-admin-bookings-filter-type is-lodging-hide-desktop" id="type-wolfhouse">
      <span class="portal-admin-bookings-label">Type</span>
      <select id="admin-bookings-type-wolfhouse" class="portal-admin-bookings-input"><option>All types</option></select>
    </label>
    <div class="portal-admin-bookings-actions">
      <button type="button" class="portal-admin-bookings-clear-btn">Clear</button>
      <button type="button" class="portal-admin-bookings-export-btn">
        <span class="portal-admin-bookings-export-full">Export CSV</span>
        <span class="portal-admin-bookings-export-short">Export</span>
      </button>
    </div>
  </div>
</div>
</body></html>`;
}

async function measureTypeVisibility(page) {
  return page.evaluate(() => {
    function info(id) {
      const el = document.getElementById(id);
      if (!el) return { missing: true, display: 'missing' };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        missing: false,
        display: cs.display,
        visibility: cs.visibility,
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      };
    }
    return {
      sunset: info('type-sunset'),
      wolfhouse: info('type-wolfhouse'),
      exportWh: (() => {
        const root = document.querySelector('[data-portal-skin="wolfhouse"] .portal-admin-bookings-export-btn');
        if (!root) return { missing: true };
        const r = root.getBoundingClientRect();
        const cs = getComputedStyle(root);
        return {
          missing: false,
          display: cs.display,
          visible: cs.display !== 'none' && r.width > 0 && r.height > 0,
        };
      })(),
    };
  });
}

async function runComputedStyleGates() {
  const css = extractBookingsCss();
  ok('extracted Bookings CSS block for fixture', css.length > 200
    && css.includes('.portal-admin-bookings-filter-type.is-lodging-hide-desktop')
    && css.includes('@media(max-width:768px)'));

  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available for Type computed-style', false, 'playwright missing');
    return;
  }

  const html = fixtureHtml(css);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

    await page.setViewportSize({ width: 390, height: 844 });
    const mobile = await measureTypeVisibility(page);
    ok('mobile Sunset Type not display:none',
      mobile.sunset && mobile.sunset.display !== 'none' && mobile.sunset.visible,
      JSON.stringify(mobile.sunset));
    ok('mobile Wolfhouse Type not display:none (lodging class restored)',
      mobile.wolfhouse && mobile.wolfhouse.display !== 'none' && mobile.wolfhouse.visible,
      JSON.stringify(mobile.wolfhouse));
    ok('mobile Wolfhouse Export still visible beside Type',
      mobile.exportWh && mobile.exportWh.visible,
      JSON.stringify(mobile.exportWh));

    await page.setViewportSize({ width: 1280, height: 800 });
    const desktop = await measureTypeVisibility(page);
    ok('desktop Sunset Type stays visible',
      desktop.sunset && desktop.sunset.display !== 'none' && desktop.sunset.visible,
      JSON.stringify(desktop.sunset));
    ok('desktop Wolfhouse Type stays hidden (lodging desktop contract)',
      desktop.wolfhouse && desktop.wolfhouse.display === 'none',
      JSON.stringify(desktop.wolfhouse));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  console.log('\nverify:sunset-bookings-layout-redesign\n');

  // ── Shared: money tiles gone ─────────────────────────────────────────────────
  ok('summary does not render Collected / Net / Outstanding / Refunded tiles',
    !/metric\('admin\.bookings\.metric\.collected'/.test(ui)
    && !/metric\('admin\.bookings\.metric\.net'/.test(ui)
    && !/metric\('admin\.bookings\.metric\.outstanding'/.test(ui)
    && !/metric\('admin\.bookings\.metric\.refunded'/.test(ui));
  ok('summary always renders Bookings count',
    /metric\('admin\.bookings\.metric\.bookings'/.test(ui));

  // ── Desktop: Bookings-only strip + under-summary note + classic toolbar ──────
  ok('desktop summary strip is single Bookings column by default',
    /\.portal-admin-bookings-summary-strip\{[^}]*grid-template-columns:minmax\(140px,220px\)/.test(api));
  ok('Refund/Unpaid metrics marked mobile-only and hidden on desktop',
    /portal-admin-bookings-metric--mobile-kpi/.test(ui)
    && /\.portal-admin-bookings-metric--mobile-kpi\{display:none\}/.test(api));
  ok('desktop keeps scope note under summary',
    /portal-admin-bookings-summary-note/.test(ui)
    && /data-bookings-kpi-scope="1"/.test(ui)
    && /\.portal-admin-bookings-summary-note\{/.test(api));
  ok('desktop toolbar is classic flex wrap (not mobile column/grid by default)',
    /\.portal-admin-bookings-toolbar\{display:flex;flex-wrap:wrap;align-items:flex-end/.test(api)
    && /\.portal-admin-bookings-actions\{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto\}/.test(api));
  ok('desktop Export label stays Export CSV (full span)',
    /portal-admin-bookings-export-full/.test(ui)
    && /admin\.bookings\.exportCsv/.test(ui)
    && /\.portal-admin-bookings-export-short\{display:none\}/.test(api));
  ok('desktop does not force mobile card grid outside 520px',
    !/\.portal-admin-bookings-tr\{[^}]*grid-template-areas:\s*"guest status"/.test(api.split('@media(max-width:520px)')[0]));

  // ── Mobile: lean KPIs, footer note, toolbar, cards ───────────────────────────
  ok('mobile shows Refund + Unpaid KPIs (refunded_cents / outstanding_cents)',
    /metric\('admin\.bookings\.metric\.refund',\s*adminBookingsFormatEur\(s\.refunded_cents\)/.test(ui)
    && /metric\('admin\.bookings\.metric\.unpaid',\s*adminBookingsFormatEur\(s\.outstanding_cents\)/.test(ui)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-metric--mobile-kpi\{display:block\}/.test(api)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-summary-strip\{[^}]*repeat\(3,minmax\(0,1fr\)\)/.test(api));
  ok('mobile moves scope note to footer (hides under-summary note)',
    /admin-bookings-footer-note/.test(ui)
    && /portal-admin-bookings-footer-note/.test(ui)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-summary-note\{display:none\}/.test(api)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-footer-note\{display:block\}/.test(api));
  ok('mobile toolbar: Search+Clear then Dates/Status/Type/Export',
    /@media\(max-width:768px\)\{[\s\S]*?grid-template-areas:[\s\S]*?"search clear"[\s\S]*?"dates status"[\s\S]*?"type export"/.test(api)
    && /id="admin-bookings-clear"/.test(ui)
    && /id="admin-bookings-export"/.test(ui)
    && /\.portal-admin-bookings-actions\{display:contents/.test(api));
  ok('mobile Export short label',
    /portal-admin-bookings-export-short/.test(ui)
    && /'admin\.bookings\.export':\s*'Export'/.test(i18n)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-export-full\{display:none\}/.test(api)
    && /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-export-short\{display:inline\}/.test(api));
  ok('mobile card hierarchy: guest+status first',
    /@media\(max-width:520px\)\{[\s\S]*?grid-template-areas:[\s\S]*?"guest status"[\s\S]*?"total paid"[\s\S]*?"code code"/.test(api));
  ok('rows expose pay-tone for mobile unpaid/paid emphasis',
    /is-pay-/.test(ui)
    && /adminBookingsRowPayTone/.test(ui)
    && /data-bookings-pay-tone/.test(ui)
    && /portal-admin-bookings-td-total/.test(ui)
    && /portal-admin-bookings-td-paid/.test(ui));
  ok('mobile keeps Booking ::before label on code cell',
    /\.portal-admin-bookings-td-code::before\{content:'Booking'/.test(api));
  ok('deep-link + export + clear ids preserved',
    /data-bookings-open-schedule/.test(ui)
    && /admin-bookings-export/.test(ui)
    && /admin-bookings-clear/.test(ui)
    && /\/staff\/admin\/bookings\/export\.csv/.test(ui));

  // ── Lodging Type: desktop hide, mobile show (both skins) ─────────────────────
  ok('lodging does not set inline Type display:none',
    !/typeWrap\.style\.display\s*=\s*['"]none['"]/.test(ui)
    && !/\.style\.display\s*=\s*['"]none['"]/.test(
      (ui.match(/adminBookingsIsLodging\(\)[\s\S]{0,400}/) || [''])[0]
    ));
  ok('lodging marks Type with is-lodging-hide-desktop class',
    /classList\.add\(['"]is-lodging-hide-desktop['"]\)/.test(ui)
    && /closest\(['"]\.portal-admin-bookings-filter-type['"]\)/.test(ui));
  ok('desktop CSS hides lodging Type via class',
    /\.portal-admin-bookings-filter-type\.is-lodging-hide-desktop\{display:none\}/.test(api));
  ok('mobile CSS restores lodging Type (not display:none)',
    /@media\(max-width:768px\)\{[\s\S]*?\.portal-admin-bookings-filter-type\.is-lodging-hide-desktop\{display:flex/.test(api));

  // ── i18n lean labels ─────────────────────────────────────────────────────────
  ok('EN/ES Refund + Unpaid metric keys',
    /'admin\.bookings\.metric\.refund':\s*'Refund'/.test(i18n)
    && /'admin\.bookings\.metric\.unpaid':\s*'Unpaid'/.test(i18n)
    && /'admin\.bookings\.metric\.refund':\s*'Reembolso'/.test(i18nEs)
    && /'admin\.bookings\.metric\.unpaid':\s*'Impagado'/.test(i18nEs));

  console.log('\n  computed-style (Sunset + Wolfhouse Type on mobile/desktop)\n');
  await runComputedStyleGates();

  console.log(`\nverify:sunset-bookings-layout-redesign  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
