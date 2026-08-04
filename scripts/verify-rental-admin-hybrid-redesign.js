'use strict';

/**
 * verify:rental-admin-hybrid-redesign
 *
 * Admin ▸ RENTAL PRICES hybrid redesign (compact browse + expand-in-place).
 * UI-only — production-generated /staff/ui; APIs intercepted.
 *
 * Duration × is PRE-EXISTING immediate DELETE with confirmation (not staged into
 * /commit). This suite documents and asserts that contract; it does not change it.
 *
 * Run: node scripts/verify-rental-admin-hybrid-redesign.js
 */

if (!process.env.NODE_PATH) {
  process.env.NODE_PATH = '/opt/data/workspaces/wolfhouse-grok/node_modules';
  // eslint-disable-next-line no-underscore-dangle
  require('module').Module._initPaths();
}
if (!process.env.STAFF_PORTAL_LOCALES) {
  process.env.STAFF_PORTAL_LOCALES = 'en,es,it';
}

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ARTIFACTS = '/opt/data/artifacts';

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function pw() {
  try {
    return require('playwright');
  } catch (_) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}

const listen = (s) =>
  new Promise((r, j) => {
    s.once('error', j);
    s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
  });

function priceRow(offering, duration, label, cents, id) {
  const code = `${offering}__${duration}`;
  return {
    id,
    category: 'rental',
    item_type: 'rental',
    offering_key: code,
    item_code: code,
    display_name: label,
    label,
    amount_cents: cents,
    active: true,
    client_slug: 'sunset',
    location_id: 'sunset-somo',
  };
}

/** Expected chips sorted by duration model order (hours before days). */
const EXPECTED_CHIPS = {
  bicycle: [
    { duration: '6_hours', label: '6 hours €10.00', cents: 1000 },
    { duration: '12_hours', label: '12 hours €15.00', cents: 1500 },
    { duration: '1_day', label: '1 day €20.00', cents: 2000 },
  ],
  sup_rental: [{ duration: '1_day', label: '1 day €50.00', cents: 5000 }],
  board_and_suit_rental: [
    { duration: '2_hours', label: '2 hours €15.00', cents: 1500 },
    { duration: '1_day', label: '1 day €30.00', cents: 3000 },
    { duration: '2_days', label: '2 days €40.00', cents: 4000 },
    { duration: '3_days', label: '3 days €60.00', cents: 6000 },
  ],
  towel_rental: [{ duration: '1_day', label: '1 day €5.00', cents: 500 }],
};

function sourceContracts() {
  console.log('\n[source] polish layout + meta + no overflow + i18n + CSS\n');
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

  ok(
    'header has stable Add Equipment mount slot (not body toolbar)',
    /id="admin-prices-hdr-actions"/.test(apiSrc)
      && /adminPopulatePricesHeaderActions|admin-prices-hdr-actions/.test(adminUi)
      && !/portal-admin-equip-toolbar/.test(adminUi)
      && /portal-admin-prices-hdr/.test(apiSrc),
  );
  ok(
    'panel does not call/render today availability',
    !/adminRefreshEquipAvailableToday/.test(adminUi)
      && !/data-equip-available-today/.test(adminUi)
      && !/adminEquipTodayRefreshSeq/.test(adminUi)
      && !/portal-admin-equip-available-today/.test(adminUi),
  );
  ok(
    'no equipment overflow helpers/markup/CSS',
    !/data-admin-equip-overflow/.test(adminUi)
      && !/equip-overflow-toggle/.test(adminUi)
      && !/adminOpenEquipOverflowDisclosure/.test(adminUi)
      && !/adminCloseAllEquipOverflowMenus/.test(adminUi)
      && !/portal-admin-equip-overflow/.test(apiSrc),
  );
  ok(
    'browse pencil only; delete only via edit footer action',
    /data-admin-action="edit-equipment"/.test(adminUi)
      && /portal-admin-equip-footer[\s\S]{0,400}delete-rental-offering/.test(adminUi)
      && !/equip-overflow[\s\S]{0,200}delete-rental-offering/.test(adminUi),
  );
  ok(
    'duration control associates label via group aria-labelledby + control aria-label (unique id per prefix)',
    /function renderAdminDurationControl[\s\S]{0,1200}duration-label[\s\S]{0,400}aria-labelledby[\s\S]{0,400}aria-label/.test(adminUi)
      && /durationCountAria|Duration count/.test(adminUi)
      && /durationUnitAria|Duration unit/.test(adminUi)
      && /renderAdminDurationInvalidControl/.test(adminUi),
  );
  ok(
    'add/edit fields use for= association on name/stock/amount',
    /label for="'\s*\+\s*nameId/.test(adminUi)
      && /label for="'\s*\+\s*stockId/.test(adminUi)
      && /label for="'\s*\+\s*amountId/.test(adminUi)
      && /label for="'\s*\+\s*escHtml\(nameInputId\)/.test(adminUi)
      && /label for="'\s*\+\s*escHtml\(stockInputId\)/.test(adminUi)
      && /label for="'\s*\+\s*escHtml\(amountId\)/.test(adminUi),
  );
  ok(
    'edit pencil uses equipment-specific i18n Edit {name} rental prices',
    /admin\.prices\.editEquipmentPrices/.test(adminUi)
      && /Edit \{name\} rental prices/.test(en),
  );
  ok(
    'status dot in name row; meta uses Stock = + Enabled/Disabled',
    /portal-admin-equip-name-row/.test(adminUi)
      && /adminEquipCompactStockPart/.test(adminUi)
      && /admin\.prices\.stockEquals|adminEquipEnabledLabel/.test(adminUi)
      && /data-equip-active-label/.test(adminUi)
      && /portal-admin-equip-meta-sep/.test(adminUi),
  );
  ok(
    'no full-row opacity fade for disabled equip rows',
    !/\.portal-admin-equip-row\.is-equip-disabled\{opacity/.test(apiSrc)
      && /portal-admin-equip-row\.is-equip-disabled \.portal-admin-equip-chip/.test(apiSrc),
  );
  ok(
    '44px touch targets for edit/remove/footer/duration',
    /\.portal-admin-equip-edit-btn[^{]*\{[^}]*min-height:44px/.test(apiSrc)
      && /\.portal-admin-equip-remove-duration\{[^}]*min-height:44px/.test(apiSrc)
      && /portal-admin-duration-count\{[^}]*min-height:44px/.test(apiSrc)
      && /portal-admin-equip-delete\{[^}]*min-height:44px/.test(apiSrc)
      && /var\(--focus/.test(apiSrc),
  );
  ok(
    'duration × is compact inline (transparent, no large boxed dominance)',
    /\.portal-admin-equip-remove-duration\{[^}]*background:\s*transparent/.test(apiSrc)
      && /\.portal-admin-equip-remove-duration\{[^}]*font-size:\s*14px/.test(apiSrc)
      && !/\.portal-admin-equip-edit-btn,\s*\.portal-admin-equip-remove-duration\{/.test(apiSrc),
  );
  ok(
    'name wraps (line-clamp) not single-line ellipsis-only',
    /-webkit-line-clamp:\s*2/.test(apiSrc)
      && !/\.portal-admin-equip-name\{[^}]*white-space:nowrap/.test(apiSrc),
  );
  ok(
    'add-equipment form has scoped bottom margin before list',
    /#admin-prices-body #admin-add-equip-form\{[^}]*margin-bottom:\s*20px/.test(apiSrc)
      || /#admin-add-equip-form\{[^}]*margin-bottom:\s*20px/.test(apiSrc),
  );
  ok(
    'edit meta form compact left flex row + no overflow clip on enabled',
    /portal-admin-equip-meta-form\{[^}]*display:\s*flex/.test(apiSrc)
      && /portal-admin-equip-meta-form\{[^}]*justify-content:\s*flex-start/.test(apiSrc)
      && /portal-admin-equip-meta-form > \.portal-admin-equip-field:first-child\{[^}]*max-width:\s*min\(100%,360px\)/.test(apiSrc)
      && /portal-admin-equip-enabled-field\{[^}]*overflow:\s*visible/.test(apiSrc),
  );
  ok(
    'price grid 3-col desktop / 2 intermediate / 1 mobile',
    /portal-admin-equip-price-grid\{[^}]*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\)/.test(apiSrc)
      && /@media\(max-width:1100px\)\{[\s\S]{0,200}portal-admin-equip-price-grid\{[^}]*repeat\(2,minmax\(0,1fr\)\)/.test(apiSrc)
      && /@media\(max-width:720px\)\{[\s\S]{0,400}portal-admin-equip-price-grid\{[^}]*minmax\(0,1fr\)/.test(apiSrc),
  );
  ok(
    'duration × still immediate delete-price (not staged into commit body as remove list)',
    /data-admin-action="delete-price"/.test(adminUi)
      && /if \(action === 'delete-price'\)\{[\s\S]{0,800}adminApiRequest\(\s*['"]DELETE['"]/.test(adminUi)
      && /removeDuration/.test(adminUi),
  );
  ok(
    'removeDuration copy signals immediate removal',
    /admin\.prices\.removeDuration['"]:\s*['"]Remove duration price now['"]/.test(en)
      || en.includes("'admin.prices.removeDuration': 'Remove duration price now'"),
  );
  for (const key of [
    'admin.prices.stockEquals',
    'admin.prices.stockUnconfigured',
    'admin.prices.enabled',
    'admin.prices.disabled',
    'admin.prices.editingTitle',
    'admin.prices.editEquipmentPrices',
    'admin.prices.durationCountAria',
    'admin.prices.durationUnitAria',
    'admin.prices.addDurationPrice',
    'admin.prices.saveChanges',
    'admin.prices.deleteEquipment',
  ]) {
    ok(`EN ${key}`, en.includes(`'${key}'`));
    ok(`ES ${key}`, es.includes(`'${key}'`) || (key === 'admin.prices.enabled' || key === 'admin.prices.disabled'));
  }
  ok(
    'EN Stock = {n} + Enabled/Disabled exact',
    en.includes("'admin.prices.stockEquals': 'Stock = {n}'")
      && en.includes("'admin.prices.enabled': 'Enabled'")
      && en.includes("'admin.prices.disabled': 'Disabled'"),
  );
  ok(
    'EN editEquipmentPrices template',
    en.includes("'admin.prices.editEquipmentPrices': 'Edit {name} rental prices'"),
  );
  ok(
    'ES Activado/Desactivado + Stock = + edit pencil',
    es.includes("'admin.prices.enabled': 'Activado'")
      && es.includes("'admin.prices.disabled': 'Desactivado'")
      && es.includes("'admin.prices.stockEquals': 'Stock = {n}'")
      && es.includes("'admin.prices.editEquipmentPrices': 'Editar precios de alquiler de {name}'"),
  );
  ok(
    'IT hybrid keys present (Attivo/Disattivato, Stock =, edit pencil)',
    en.includes("'admin.prices.editingTitle': 'Modifica — {name}'")
      && en.includes("'admin.prices.saveChanges': 'Salva modifiche'")
      && en.includes("'admin.prices.enabled': 'Attivo'")
      && en.includes("'admin.prices.disabled': 'Disattivato'")
      && en.includes("'admin.prices.stockEquals': 'Stock = {n}'")
      && en.includes("'admin.prices.editEquipmentPrices': 'Modifica prezzi noleggio di {name}'")
      && en.includes("'admin.prices.removeDuration': 'Rimuovi prezzo durata ora'"),
  );
}

async function browserFixture() {
  console.log('\n[browser] production /staff/ui hybrid redesign (adversarial)\n');
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  try {
    const serverPath = require.resolve('./fixtures/sunset-admin-verify-server');
    delete require.cache[serverPath];
    const htmlPath = require.resolve('./lib/sunset-admin-verify-ui-html');
    delete require.cache[htmlPath];
    delete require.cache[require.resolve('./staff-query-api')];
    delete require.cache[require.resolve('./lib/staff-portal-i18n')];
  } catch (_e) { /* ignore */ }

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  let offerings = [
    { offering_key: 'bicycle', label: 'Bicycle', active: true, stock_quantity: 25 },
    { offering_key: 'sup_rental', label: 'SUP', active: true, stock_quantity: 5 },
    { offering_key: 'board_and_suit_rental', label: 'Surfboard + Wetsuit', active: true, stock_quantity: 100 },
    { offering_key: 'towel_rental', label: 'Towel', active: false, stock_quantity: 50 },
  ];
  let rentalPrices = [
    priceRow('bicycle', '6_hours', 'Bicycle', 1000, 'p-bike-6h'),
    priceRow('bicycle', '12_hours', 'Bicycle', 1500, 'p-bike-12h'),
    priceRow('bicycle', '1_day', 'Bicycle', 2000, 'p-bike-1d'),
    priceRow('sup_rental', '1_day', 'SUP', 5000, 'p-sup-1d'),
    priceRow('board_and_suit_rental', '2_hours', 'Surfboard + Wetsuit', 1500, 'p-bundle-2h'),
    priceRow('board_and_suit_rental', '1_day', 'Surfboard + Wetsuit', 3000, 'p-bundle-1d'),
    priceRow('board_and_suit_rental', '2_days', 'Surfboard + Wetsuit', 4000, 'p-bundle-2d'),
    priceRow('board_and_suit_rental', '3_days', 'Surfboard + Wetsuit', 6000, 'p-bundle-3d'),
    priceRow('towel_rental', '1_day', 'Towel', 500, 'p-towel-1d'),
  ];
  const commitBodies = [];
  const createPosts = [];
  const deletes = [];
  const priceDeletes = [];
  let stockByLoc = {
    'sunset-somo': { bicycle: 22, sup_rental: 3, board_and_suit_rental: 80, towel_rental: 49 },
    'sunset-other': { bicycle: 99, sup_rental: 1, board_and_suit_rental: 1, towel_rental: 1 },
  };
  /** Hold first stock response until second resolves (race test). */
  let holdStock = null;
  let stockCall = 0;

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  // Avoid broken logo noise
  await page.route(/\.(png|jpg|jpeg|svg|ico|webp)(\?|$)/i, async (r) => {
    await r.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  });

  await page.route(/\/staff\/schedule\/rental-stock/, async (r) => {
    stockCall += 1;
    const callN = stockCall;
    const u = r.request().url();
    const locMatch = /[?&]location=([^&]+)/.exec(u);
    const loc = locMatch ? decodeURIComponent(locMatch[1]) : 'sunset-somo';
    const body = JSON.parse(r.request().postData() || '{}');
    const offs = Array.isArray(body.offerings) ? body.offerings : [];
    // Snapshot remaining at request time so a held older call keeps its original payload.
    const table = { ...(stockByLoc[loc] || stockByLoc['sunset-somo']) };
    const items = offs.map((o) => {
      const key = String(o.offering_key || '');
      const rem = table[key];
      if (rem == null) {
        return { offering_key: key, not_configured: true, stock_quantity: null, remaining: null };
      }
      return { offering_key: key, stock_quantity: rem, remaining: rem, sold_out: rem <= 0 };
    });
    const payload = { success: true, items, _loc: loc, _call: callN };

    if (holdStock && callN === holdStock.holdCall) {
      await holdStock.promise;
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      return;
    }
    if (holdStock && callN > holdStock.holdCall) {
      holdStock.resolve();
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  await page.route(/\/staff\/admin\/config\/rental-offerings(?:\/([a-z][a-z0-9_]*)(?:\/commit)?)?(?:\?|$)/, async (r) => {
    const method = r.request().method();
    const u = r.request().url();
    const commitMatch = /rental-offerings\/([a-z][a-z0-9_]*)\/commit(?:\?|$)/.exec(u);
    if (commitMatch && method === 'POST') {
      const key = commitMatch[1];
      const body = JSON.parse(r.request().postData() || '{}');
      commitBodies.push({ key, body, url: u });
      const off = offerings.find((o) => o.offering_key === key);
      if (off) {
        if (body.label != null) off.label = body.label;
        if (Object.prototype.hasOwnProperty.call(body, 'stock_quantity')) off.stock_quantity = body.stock_quantity;
        if (typeof body.active === 'boolean') off.active = body.active;
      }
      if (Array.isArray(body.prices)) {
        body.prices.forEach((pr) => {
          const existing = rentalPrices.find((p) => p.id === pr.id);
          if (!existing) return;
          if (pr.amount_cents != null) existing.amount_cents = pr.amount_cents;
          if (pr.period_window) {
            const base = String(existing.offering_key || existing.item_code || '').split('__')[0];
            existing.offering_key = `${base}__${pr.period_window}`;
            existing.item_code = existing.offering_key;
            if (off) {
              existing.label = off.label;
              existing.display_name = off.label;
            }
          }
        });
      }
      if (Array.isArray(body.new_prices)) {
        body.new_prices.forEach((np) => {
          const dur = String(np.period_window || '1_day');
          const code = `${key}__${dur}`;
          if (rentalPrices.some((p) => String(p.item_code || p.offering_key) === code)) return;
          rentalPrices.push(
            priceRow(key, dur, (off && off.label) || key, Number(np.amount_cents) || 0, `p-new-${rentalPrices.length + 1}`),
          );
        });
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering_key: key, offering: off || { offering_key: key } }),
      });
      return;
    }
    const keyMatch = /rental-offerings\/([a-z][a-z0-9_]*)(?:\?|$)/.exec(u);
    const key = keyMatch ? keyMatch[1] : '';
    if (!key) {
      if (method === 'GET') {
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, offerings: offerings.slice() }),
        });
        return;
      }
      if (method === 'POST') {
        const body = JSON.parse(r.request().postData() || '{}');
        createPosts.push(body);
        if (!offerings.some((o) => o.offering_key === body.offering_key)) {
          offerings.push({
            offering_key: body.offering_key,
            label: body.label || body.offering_key,
            active: true,
            stock_quantity: body.stock_quantity != null ? body.stock_quantity : null,
          });
        }
        if (Array.isArray(body.prices)) {
          body.prices.forEach((pr) => {
            rentalPrices.push(
              priceRow(
                body.offering_key,
                pr.period_window || '1_day',
                body.label,
                Number(pr.amount_cents) || 0,
                `p-create-${rentalPrices.length + 1}`,
              ),
            );
          });
        }
        await r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            offering: {
              offering_key: body.offering_key,
              label: body.label,
              stock_quantity: body.stock_quantity,
              active: true,
            },
          }),
        });
        return;
      }
    }
    if (method === 'DELETE' && key) {
      deletes.push(key);
      offerings = offerings.filter((o) => o.offering_key !== key);
      rentalPrices = rentalPrices.filter(
        (p) => String(p.item_code || p.offering_key || '').split('__')[0] !== key,
      );
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, deleted: true, offering_key: key }),
      });
      return;
    }
    await r.continue();
  });

  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (r) => {
    const x = await r.fetch();
    const b = await x.json();
    b.prices = rentalPrices.slice();
    b.rental_offerings = offerings.slice();
    b._equipment_offerings = offerings.slice();
    b.writes_enabled = true;
    b.read_only = false;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(b),
    });
  });

  await page.route(/\/staff\/admin\/config\/prices\/[^?/]+/, async (r) => {
    if (r.request().method() === 'DELETE') {
      const m = /\/prices\/([^?/]+)/.exec(r.request().url());
      const id = m ? decodeURIComponent(m[1]) : '';
      priceDeletes.push({ id, url: r.request().url() });
      rentalPrices = rentalPrices.filter((p) => p.id !== id);
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) });
      return;
    }
    await r.continue();
  });

  async function openAdminPricing() {
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset', null, { timeout: 15000 });
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('#admin-prices-body').waitFor({ timeout: 10000 });
    await page.locator('[data-admin-equip="bicycle"]').waitFor({ timeout: 10000 });
    await page.waitForTimeout(350);
  }

  async function chipTexts(key) {
    return page.locator(`[data-admin-equip="${key}"] .portal-admin-equip-chip`).evaluateAll((nodes) =>
      nodes.map((n) => ({
        text: (n.textContent || '').trim(),
        duration: n.getAttribute('data-admin-price-duration') || '',
        cents: n.getAttribute('data-admin-price-amount') || '',
      })),
    );
  }

  async function assertExactChips(key, expected) {
    const got = await chipTexts(key);
    ok(
      `${key}: chip count exact ${expected.length}`,
      got.length === expected.length,
      JSON.stringify(got),
    );
    expected.forEach((exp, i) => {
      ok(
        `${key}: chip[${i}] duration+label exact`,
        got[i]
          && got[i].duration === exp.duration
          && got[i].text === exp.label
          && Number(got[i].cents) === exp.cents,
        JSON.stringify({ got: got[i], exp }),
      );
    });
  }

  async function shotSection(name) {
    // Full element screenshot of complete section (may be taller than viewport).
    // Fail closed if crop/capture fails — no silent full-page fallback.
    const section = page.locator('#admin-sec-prices');
    await section.waitFor({ state: 'visible', timeout: 10000 });
    await section.scrollIntoViewIfNeeded();
    const outPath = path.join(ARTIFACTS, name);
    try {
      await section.screenshot({ path: outPath });
    } catch (err) {
      throw new Error(`screenshot crop failed for ${name}: ${err && err.message ? err.message : err}`);
    }
    const st = fs.statSync(outPath);
    if (!st.size || st.size < 200) {
      throw new Error(`screenshot empty/too small for ${name}: size=${st.size}`);
    }
  }

  async function assertNoToday(label) {
    const r = await page.evaluate(() => {
      const slots = document.querySelectorAll(
        '#admin-sec-prices [data-equip-available-today], #admin-sec-prices .portal-admin-equip-available-today',
      );
      const body = document.querySelector('#admin-prices-body');
      const text = body ? (body.innerText || '') : '';
      const todayish = /\b\d+\s+today\b|\b\d+\s+hoy\b|\b\d+\s+oggi\b|available.?today/i.test(text);
      return { slots: slots.length, todayish, sample: text.slice(0, 120) };
    });
    ok(`${label}: zero today DOM`, r.slots === 0, JSON.stringify(r));
    ok(`${label}: zero today text`, !r.todayish, JSON.stringify(r));
    ok(`${label}: stockCall===0`, stockCall === 0, `stockCall=${stockCall}`);
  }

  async function measureHeader(label) {
    const hdr = await page.evaluate(() => {
      const root = document.querySelector('[data-admin-prices-hdr]');
      if (!root) return { missing: true };
      const titles = root.querySelectorAll('.portal-admin-section-hdr-title, [data-i18n="admin.section.prices"]');
      const actions = document.getElementById('admin-prices-hdr-actions');
      const addBtns = actions
        ? actions.querySelectorAll('[data-admin-action="add-equipment"]')
        : [];
      const bodyToolbar = document.querySelector('#admin-prices-body .portal-admin-equip-toolbar');
      const bodyAdd = document.querySelectorAll('#admin-prices-body [data-admin-action="add-equipment"]');
      const title = titles[0];
      const btn = addBtns[0];
      let titleBefore = false;
      let sameRow = false;
      let overlap = false;
      let overflow = (root.scrollWidth - root.clientWidth) > 4;
      if (title && btn) {
        const kids = Array.from(root.children);
        titleBefore = kids.indexOf(title) >= 0
          && kids.indexOf(actions) >= 0
          && kids.indexOf(title) < kids.indexOf(actions);
        const tr = title.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        sameRow = Math.abs(tr.top - br.top) < 12
          || (tr.bottom > br.top + 2 && br.bottom > tr.top + 2 && Math.abs(tr.top - br.top) < 28);
        // Horizontal overlap of boxes while on same row is a failure.
        const hOverlap = !(tr.right <= br.left + 0.5 || br.right <= tr.left + 0.5);
        const vOverlap = !(tr.bottom <= br.top + 0.5 || br.bottom <= tr.top + 0.5);
        overlap = hOverlap && vOverlap;
      }
      return {
        missing: false,
        titleCount: titles.length,
        addCount: addBtns.length,
        bodyToolbar: !!bodyToolbar,
        bodyAddCount: bodyAdd.length,
        titleText: title ? (title.textContent || '').trim() : '',
        btnText: btn ? (btn.textContent || '').trim() : '',
        titleBefore,
        sameRow,
        overlap,
        overflow,
      };
    });
    ok(`${label}: header present`, !hdr.missing, JSON.stringify(hdr));
    ok(`${label}: exact one title`, hdr.titleCount === 1, JSON.stringify(hdr));
    ok(`${label}: exact one + Add equipment`, hdr.addCount === 1, JSON.stringify(hdr));
    ok(`${label}: DOM order title before action`, hdr.titleBefore, JSON.stringify(hdr));
    ok(`${label}: no body toolbar/add duplicate`, !hdr.bodyToolbar && hdr.bodyAddCount === 0, JSON.stringify(hdr));
    ok(`${label}: no title/button overlap`, !hdr.overlap, JSON.stringify(hdr));
    ok(`${label}: header no horizontal overflow`, !hdr.overflow, JSON.stringify(hdr));
    // Same row when it fits; if wraps, still no overlap/overflow (already asserted).
    if (hdr.sameRow) {
      ok(`${label}: title+button same row when fits`, true);
    } else {
      ok(`${label}: wrapped header still clean (no overlap/overflow)`, !hdr.overlap && !hdr.overflow, JSON.stringify(hdr));
    }
    return hdr;
  }

  try {
    await openAdminPricing();

    // ── 0 header: exact one title + one Add; order + geometry ──
    const hdrDesktop = await measureHeader('desktop-header');
    ok('i18n title present on header', /rental prices/i.test(hdrDesktop.titleText), hdrDesktop.titleText);
    ok('Add equipment button text', /\+|add equipment/i.test(hdrDesktop.btnText), hdrDesktop.btnText);

    // ── 1 exact chips + status for every fixture item ──
    for (const key of Object.keys(EXPECTED_CHIPS)) {
      await assertExactChips(key, EXPECTED_CHIPS[key]);
    }

    // Browse meta geometry: status dot is sibling before name in name row; absent from meta.
    const bikeMeta = await page.locator('[data-admin-equip="bicycle"]').evaluate((row) => {
      const nameRow = row.querySelector('.portal-admin-equip-name-row');
      const name = row.querySelector('.portal-admin-equip-name');
      const dotsInName = nameRow ? Array.from(nameRow.querySelectorAll('.portal-admin-equip-status-dot')) : [];
      const status = row.querySelector('[data-equip-status]');
      const dotsInMeta = status ? Array.from(status.querySelectorAll('.portal-admin-equip-status-dot')) : [];
      const metaText = status ? (status.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const stock = row.querySelector('[data-equip-stock]');
      const active = row.querySelector('[data-equip-active-label]');
      const today = row.querySelector('[data-equip-available-today], .portal-admin-equip-available-today');
      const overflow = row.querySelector('[data-admin-equip-overflow], [data-admin-action="equip-overflow-toggle"]');
      const compactDelete = row.querySelector('.portal-admin-equip-compact [data-admin-action="delete-rental-offering"]');
      const pencils = row.querySelectorAll('[data-admin-action="edit-equipment"]');
      let nameDotBefore = false;
      if (nameRow && name && dotsInName[0]) {
        const kids = Array.from(nameRow.children);
        nameDotBefore = kids.indexOf(dotsInName[0]) >= 0
          && kids.indexOf(name) >= 0
          && kids.indexOf(dotsInName[0]) < kids.indexOf(name);
      }
      return {
        nameDotBefore,
        dotsInName: dotsInName.length,
        dotsInMeta: dotsInMeta.length,
        metaText,
        stockText: stock ? (stock.textContent || '').trim() : '',
        activeText: active ? (active.textContent || '').trim() : '',
        activeAttr: active ? active.getAttribute('data-equip-active-label') : null,
        today: !!today,
        overflow: !!overflow,
        compactDelete: !!compactDelete,
        pencils: pencils.length,
        title: name ? name.getAttribute('title') : null,
        disabled: row.classList.contains('is-equip-disabled'),
      };
    });
    ok(
      'status dot sibling before name in name row',
      bikeMeta.nameDotBefore && bikeMeta.dotsInName === 1,
      JSON.stringify(bikeMeta),
    );
    ok('status dot absent from meta line', bikeMeta.dotsInMeta === 0, JSON.stringify(bikeMeta));
    ok(
      'exact Stock = 25 · Enabled meta EN',
      bikeMeta.metaText === 'Stock = 25 · Enabled'
        && bikeMeta.stockText === 'Stock = 25'
        && bikeMeta.activeText === 'Enabled'
        && bikeMeta.activeAttr === '1',
      JSON.stringify(bikeMeta),
    );
    ok('zero today visible/slot on browse card', !bikeMeta.today && stockCall === 0, `stockCall=${stockCall} ${JSON.stringify(bikeMeta)}`);
    ok(
      'zero browse overflow/compact delete; one pencil',
      !bikeMeta.overflow && !bikeMeta.compactDelete && bikeMeta.pencils === 1,
      JSON.stringify(bikeMeta),
    );
    ok('bicycle name has full title attribute', bikeMeta.title === 'Bicycle');

    // Equipment-specific edit pencil accessible names (EN)
    const pencilNames = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#admin-prices-body [data-admin-action="edit-equipment"]')).map((btn) => ({
        key: btn.getAttribute('data-equip-key') || '',
        aria: (btn.getAttribute('aria-label') || '').trim(),
        title: (btn.getAttribute('title') || '').trim(),
      }));
    });
    const expectedEquipNames = {
      bicycle: 'Bicycle',
      sup_rental: 'SUP',
      board_and_suit_rental: 'Surfboard + Wetsuit',
      towel_rental: 'Towel',
    };
    ok('all browse pencils present', pencilNames.length === Object.keys(expectedEquipNames).length, JSON.stringify(pencilNames));
    const ariaSet = new Set(pencilNames.map((p) => p.aria));
    ok('edit accessible names are distinct', ariaSet.size === pencilNames.length, JSON.stringify(pencilNames));
    pencilNames.forEach((p) => {
      const name = expectedEquipNames[p.key];
      const expect = `Edit ${name} rental prices`;
      ok(
        `EN edit name for ${p.key}`,
        name && p.aria === expect && p.title === expect && p.aria.includes(name),
        JSON.stringify(p),
      );
    });
    // Accessible-name lookup works for each pencil
    for (const name of Object.values(expectedEquipNames)) {
      const loc = page.getByRole('button', { name: `Edit ${name} rental prices`, exact: true });
      ok(`getByRole edit pencil: ${name}`, (await loc.count()) === 1);
    }

    const towelMeta = await page.locator('[data-admin-equip="towel_rental"]').evaluate((row) => ({
      disabled: row.classList.contains('is-equip-disabled'),
      meta: (row.querySelector('[data-equip-status]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      active: row.querySelector('[data-equip-active-label]')?.getAttribute('data-equip-active-label'),
    }));
    ok(
      'disabled towel: is-equip-disabled + Stock = 50 · Disabled',
      towelMeta.disabled && towelMeta.meta === 'Stock = 50 · Disabled' && towelMeta.active === '0',
      JSON.stringify(towelMeta),
    );

    await assertNoToday('after-browse');
    await shotSection('rental-admin-polish-desktop-browse.png');

    // ── 2 pencil expands exact row ──
    const bundle = page.locator('[data-admin-equip="board_and_suit_rental"]');
    await bundle.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(120);
    ok('bundle editing', (await bundle.getAttribute('data-equip-mode')) === 'edit');
    ok(
      'other rows stay compact',
      (await page.locator('[data-admin-equip="bicycle"] .portal-admin-equip-compact').count()) === 1
        && (await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-compact').count()) === 1,
    );
    ok(
      'editing heading EN',
      /Editing — Surfboard \+ Wetsuit/.test(await bundle.locator('.portal-admin-equip-edit-heading').innerText()),
    );
    const editHeader = await bundle.evaluate((row) => {
      const headingRow = row.querySelector('.portal-admin-equip-edit-heading-row');
      const dot = headingRow && headingRow.querySelector('.portal-admin-equip-status-dot');
      const heading = headingRow && headingRow.querySelector('.portal-admin-equip-edit-heading');
      const label = headingRow && headingRow.querySelector('[data-equip-active-label]');
      let orderOk = false;
      if (headingRow && dot && heading) {
        const kids = Array.from(headingRow.children);
        orderOk = kids.indexOf(dot) < kids.indexOf(heading);
      }
      return {
        orderOk,
        label: label ? (label.textContent || '').trim() : '',
        attr: label ? label.getAttribute('data-equip-active-label') : null,
        hasDot: !!dot,
      };
    });
    ok(
      'editor header: dot left of heading + Enabled status',
      editHeader.orderOk && editHeader.hasDot && editHeader.label === 'Enabled' && editHeader.attr === '1',
      JSON.stringify(editHeader),
    );
    ok(
      'fields populated',
      (await bundle.locator('#admin-equip-name-board_and_suit_rental').inputValue()) === 'Surfboard + Wetsuit'
        && (await bundle.locator('#admin-equip-stock-board_and_suit_rental').inputValue()) === '100',
    );
    // Accessible-name lookup for edit meta + first duration card amount
    ok(
      'edit meta Equipment name via getByLabel',
      (await bundle.getByLabel('Equipment name', { exact: true }).inputValue()) === 'Surfboard + Wetsuit',
    );
    ok(
      'edit meta Total stock via getByLabel',
      (await bundle.getByLabel('Total stock', { exact: true }).inputValue()) === '100',
    );
    ok(
      'edit duration count via accessible name',
      (await bundle.getByLabel('Duration count', { exact: true }).count()) >= 1,
    );
    ok(
      'edit duration unit via accessible name',
      (await bundle.getByLabel('Duration unit', { exact: true }).count()) >= 1,
    );
    ok(
      'edit amount via accessible name',
      (await bundle.getByLabel('Amount (EUR)', { exact: true }).count()) >= 1,
    );
    ok(
      'enabled switch aria-label retained',
      (await bundle.locator('input[data-admin-action="toggle-equip-enabled"]').getAttribute('aria-label')) === 'Enabled',
    );
    ok(
      'multi-duration editor has 4 price rows',
      (await bundle.locator('[data-admin-price-card]').count()) === 4,
    );
    ok(
      'zero overflow controls in panel',
      (await page.locator('[data-admin-equip-overflow], [data-admin-action="equip-overflow-toggle"]').count()) === 0,
    );

    await assertNoToday('during-edit');
    await shotSection('rental-admin-polish-desktop-edit.png');

    // ── 3 duration controls + add duration + no old top buttons ──
    ok('duration count controls', (await bundle.locator('.portal-admin-duration-count').count()) >= 4);
    ok('€ amount inputs', (await bundle.locator('[data-admin-price-field="amount"]').count()) >= 4);
    const removeLabel = await bundle.locator('[data-admin-action="delete-price"]').first().getAttribute('aria-label');
    ok(
      '× accessible label signals immediate removal',
      /now|ahora|ora|immediate|Remove duration/i.test(removeLabel || ''),
      removeLabel,
    );
    ok(
      'add duration dashed row',
      (await bundle.locator('.portal-admin-equip-add-duration').count()) === 1,
    );
    ok(
      'Save changes + Delete in footer only',
      (await bundle.locator('.portal-admin-equip-footer [data-admin-action="save-equipment"]').count()) === 1
        && (await bundle.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').count()) === 1
        && (await bundle.locator('.portal-admin-card-actions [data-admin-action="delete-rental-offering"]').count()) === 0,
    );

    // ── 4 Cancel no mutation ──
    const nameBefore = offerings.find((o) => o.offering_key === 'board_and_suit_rental').label;
    await bundle.locator('#admin-equip-name-board_and_suit_rental').fill('SHOULD NOT SAVE');
    await bundle.locator('input[data-admin-action="toggle-equip-enabled"]').evaluate((el) => {
      if (el.checked) el.click();
    });
    await bundle.locator('[data-admin-action="cancel-edit"]').click();
    await page.waitForTimeout(150);
    ok('cancel collapses', (await bundle.locator('.portal-admin-equip-compact').count()) === 1);
    ok('cancel no commit', commitBodies.length === 0);
    await assertNoToday('after-edit-cancel');
    ok(
      'cancel restores label (no mutation)',
      offerings.find((o) => o.offering_key === 'board_and_suit_rental').label === nameBefore
        && offerings.find((o) => o.offering_key === 'board_and_suit_rental').active === true,
    );

    // Enabled toggle Cancel then Save — heading status updates live
    await bundle.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    await bundle.locator('label.portal-admin-equip-switch').click();
    ok(
      'toggle staged disabled class while editing',
      (await bundle.evaluate((n) => n.classList.contains('is-equip-disabled'))),
    );
    ok(
      'toggle updates heading status to Disabled',
      (await bundle.locator('.portal-admin-equip-edit-heading-row [data-equip-active-label]').innerText()).trim() === 'Disabled'
        && (await bundle.locator('.portal-admin-equip-edit-heading-row [data-equip-active-label]').getAttribute('data-equip-active-label')) === '0',
    );
    await bundle.locator('[data-admin-action="cancel-edit"]').click();
    await page.waitForTimeout(100);
    ok(
      'cancel restores enabled (no commit)',
      commitBodies.length === 0
        && offerings.find((o) => o.offering_key === 'board_and_suit_rental').active === true
        && !(await bundle.evaluate((n) => n.classList.contains('is-equip-disabled'))),
    );
    await bundle.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    await bundle.locator('label.portal-admin-equip-switch').click();
    await bundle.locator('[data-admin-action="save-equipment"]').click();
    await page.waitForTimeout(400);
    const toggleCommit = commitBodies[commitBodies.length - 1];
    ok(
      'Save toggled active:false exact in commit',
      toggleCommit
        && toggleCommit.key === 'board_and_suit_rental'
        && toggleCommit.body
        && toggleCommit.body.active === false,
      JSON.stringify(toggleCommit && toggleCommit.body),
    );
    // re-enable for later tests
    await bundle.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    await bundle.locator('label.portal-admin-equip-switch').click();
    await bundle.locator('[data-admin-action="save-equipment"]').click();
    await page.waitForTimeout(300);

    // ── 5 Add equipment form gap + exact body; footer Delete only ──
    await page.locator('[data-admin-action="add-equipment"]').click();
    await page.waitForTimeout(100);
    const addGap = await page.evaluate(() => {
      const form = document.getElementById('admin-add-equip-form');
      const list = document.querySelector('.portal-admin-equip-list');
      if (!form || !list) return { ok: false, missing: true };
      const fr = form.getBoundingClientRect();
      const lr = list.getBoundingClientRect();
      const visualGap = lr.top - fr.bottom;
      return { ok: true, missing: false, visualGap };
    });
    ok('add form/list nodes present', addGap.ok && !addGap.missing, JSON.stringify(addGap));
    ok(
      'add form / list visualGap >= 16 desktop',
      addGap.ok && addGap.visualGap >= 16,
      JSON.stringify(addGap),
    );
    // Accessible-name fill path (production labels)
    await page.locator('#admin-add-equip-form').getByLabel('Equipment name', { exact: true }).fill('Kayak');
    await page.locator('#admin-add-equip-form').getByLabel('Total stock', { exact: true }).fill('8');
    await page.locator('#admin-add-equip-form').getByLabel('Duration count', { exact: true }).fill('1');
    await page.locator('#admin-add-equip-form').getByLabel('Duration unit', { exact: true }).selectOption('days');
    await page.locator('#admin-add-equip-form').getByLabel('Amount (EUR)', { exact: true }).fill('35');
    await shotSection('rental-admin-polish-desktop-add.png');
    await page.locator('[data-admin-action="save-new-equipment"]').click();
    await page.waitForTimeout(400);
    const createBody = createPosts.find((b) => /kayak/i.test(String(b.offering_key || b.label || '')));
    ok(
      'add-equipment exact body key/label/stock/1_day/3500',
      createBody
        && createBody.offering_key === 'kayak_rental'
        && createBody.label === 'Kayak'
        && Number(createBody.stock_quantity) === 8
        && Array.isArray(createBody.prices)
        && createBody.prices.length === 1
        && createBody.prices[0].period_window === '1_day'
        && Number(createBody.prices[0].amount_cents) === 3500,
      JSON.stringify(createBody),
    );
    ok('kayak row appears', (await page.locator('[data-admin-equip="kayak_rental"]').count()) === 1);

    // Delete only from edit footer; dismiss then accept confirm
    const kayak = page.locator('[data-admin-equip="kayak_rental"]');
    ok(
      'compact kayak has zero delete/overflow',
      (await kayak.locator('[data-admin-action="delete-rental-offering"]').count()) === 0
        && (await kayak.locator('[data-admin-action="equip-overflow-toggle"]').count()) === 0
        && (await kayak.locator('[data-admin-action="edit-equipment"]').count()) === 1,
    );
    await kayak.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    const kayakEdit = page.locator('[data-admin-equip="kayak_rental"]');
    ok(
      'edit footer sole equipment delete',
      (await kayakEdit.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').count()) === 1
        && (await page.locator('.portal-admin-equip-compact [data-admin-action="delete-rental-offering"]').count()) === 0,
    );
    page.once('dialog', async (d) => { await d.dismiss(); });
    await kayakEdit.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').click();
    await page.waitForTimeout(120);
    ok('dismiss keeps kayak (no DELETE)', !deletes.includes('kayak_rental') && (await page.locator('[data-admin-equip="kayak_rental"]').count()) === 1);
    page.once('dialog', async (d) => {
      ok('equipment delete confirms hard-delete copy', /permanent|delete|duration|course/i.test(d.message()), d.message());
      await d.accept();
    });
    await kayakEdit.locator('.portal-admin-equip-footer [data-admin-action="delete-rental-offering"]').click();
    await page.waitForTimeout(350);
    ok('deleted equipment row disappears', (await page.locator('[data-admin-equip="kayak_rental"]').count()) === 0);
    ok('DELETE equipment API invoked', deletes.includes('kayak_rental'), JSON.stringify(deletes));
    await assertNoToday('after-add-save-delete');

    // ── remove-duration immediate DELETE (pre-existing contract) ──
    await page.locator('[data-admin-equip="bicycle"] [data-admin-action="edit-equipment"]').click();
    let bikeEdit = page.locator('[data-admin-equip="bicycle"]');
    const removeTarget = bikeEdit.locator('[data-admin-action="delete-price"][data-price-id="p-bike-1d"]');
    ok('1_day remove × present', (await removeTarget.count()) === 1);
    page.once('dialog', async (d) => {
      ok('duration delete confirms', /remove|delete|duration|price/i.test(d.message()), d.message());
      await d.accept();
    });
    await removeTarget.click();
    await page.waitForTimeout(350);
    ok(
      'duration DELETE path exact id p-bike-1d',
      priceDeletes.some((p) => p.id === 'p-bike-1d' && /\/staff\/admin\/config\/prices\/p-bike-1d/.test(p.url)),
      JSON.stringify(priceDeletes),
    );
    // After immediate delete + reload, 1_day gone from chips (still in edit keep)
    bikeEdit = page.locator('[data-admin-equip="bicycle"]');
    ok(
      '1_day row gone after immediate DELETE',
      (await bikeEdit.locator('[data-admin-price-card="p-bike-1d"]').count()) === 0
        && (await bikeEdit.locator('[data-admin-price-duration="1_day"]').count()) === 0,
    );
    // Document: Cancel cannot undo immediate delete — already reloaded without that price.

    // ── 6 Edit → Save atomic: name/stock, amount 1200, new 3_days/4500 ──
    if ((await bikeEdit.locator('#admin-equip-name-bicycle').count()) === 0) {
      await page.locator('[data-admin-equip="bicycle"] [data-admin-action="edit-equipment"]').click();
      bikeEdit = page.locator('[data-admin-equip="bicycle"]');
    }
    await bikeEdit.locator('#admin-equip-name-bicycle').fill('City Bike');
    await bikeEdit.locator('#admin-equip-stock-bicycle').fill('30');
    // Amount on 6_hours card (first remaining after 1_day removed)
    const sixHourAmount = bikeEdit.locator('[data-admin-price-card="p-bike-6h"] [data-admin-price-field="amount"]');
    if ((await sixHourAmount.count()) >= 1) {
      await sixHourAmount.fill('12');
    } else {
      await bikeEdit.locator('[data-admin-price-field="amount"]').first().fill('12');
    }
    await bikeEdit.locator('[data-admin-action="add-equip-price"]').click();
    await page.waitForTimeout(100);
    bikeEdit = page.locator('[data-admin-equip="bicycle"]');
    await bikeEdit.locator('#admin-new-price-count').fill('3');
    await bikeEdit.locator('#admin-new-price-unit').selectOption('days');
    await bikeEdit.locator('#admin-new-price-amount').fill('45');
    // Nested add re-renders — re-apply meta + amount on the edit form.
    await bikeEdit.locator('#admin-equip-name-bicycle').fill('City Bike');
    await bikeEdit.locator('#admin-equip-stock-bicycle').fill('30');
    const sixHourAmount2 = bikeEdit.locator('[data-admin-price-card="p-bike-6h"] [data-admin-price-field="amount"]');
    if ((await sixHourAmount2.count()) >= 1) await sixHourAmount2.fill('12');
    else await bikeEdit.locator('[data-admin-price-field="amount"]').first().fill('12');
    const commitsBefore = commitBodies.length;
    await bikeEdit.locator('[data-admin-action="save-equipment"]').click();
    await page.waitForTimeout(500);
    const last = commitBodies[commitBodies.length - 1];
    ok('save hit /commit', commitsBefore < commitBodies.length && last && /\/commit/.test(last.url));
    ok(
      'commit shape: City Bike / 30 / prices with 1200 + new 3_days 4500',
      last
        && last.body
        && last.body.label === 'City Bike'
        && Number(last.body.stock_quantity) === 30
        && Array.isArray(last.body.prices)
        && last.body.prices.some((p) => p.id === 'p-bike-6h' && Number(p.amount_cents) === 1200)
        && Array.isArray(last.body.new_prices)
        && last.body.new_prices.some((np) => np.period_window === '3_days' && Number(np.amount_cents) === 4500),
      JSON.stringify(last && last.body),
    );
    ok('row collapses after save', (await page.locator('[data-admin-equip="bicycle"] .portal-admin-equip-compact').count()) === 1);
    const postChips = await chipTexts('bicycle');
    const postExpected = [
      { duration: '6_hours', label: '6 hours €12.00', cents: 1200 },
      { duration: '12_hours', label: '12 hours €15.00', cents: 1500 },
      { duration: '3_days', label: '3 days €45.00', cents: 4500 },
    ];
    ok(
      'post-save chips exact sorted set',
      postChips.length === postExpected.length
        && postExpected.every((e, i) => postChips[i]
          && postChips[i].duration === e.duration
          && postChips[i].text === e.label
          && Number(postChips[i].cents) === e.cents),
      JSON.stringify(postChips),
    );

    // ── 8 locale interact EN/ES/IT — real DOM, no EN fallback for new keys ──
    async function forceLocale(loc) {
      await page.evaluate((l) => {
        localStorage.setItem('wh_staff_portal_locale', l);
        if (typeof window.setStaffLocale === 'function') window.setStaffLocale(l);
      }, loc);
      // Admin render helpers live in script scope (not window) — force re-paint via UI.
      const openEdit = page.locator('[data-admin-equip-edit]');
      if ((await openEdit.count()) > 0) {
        await page.locator('[data-admin-action="cancel-edit"]').first().click().catch(() => {});
        await page.waitForTimeout(80);
      }
      await page.locator('[data-admin-action="edit-equipment"]').first().click();
      await page.waitForTimeout(100);
      await page.locator('[data-admin-action="cancel-edit"]').first().click();
      await page.waitForTimeout(150);
    }

    await forceLocale('es');
    await assertNoToday('after-locale-es');
    const esMeta = (await page.locator('[data-admin-equip="bicycle"] [data-equip-status]').innerText()).replace(/\s+/g, ' ').trim();
    ok('ES Stock = meta exact', /^Stock = \d+ · Activado$/.test(esMeta), esMeta);
    const esTowel = (await page.locator('[data-admin-equip="towel_rental"] [data-equip-status]').innerText()).replace(/\s+/g, ' ').trim();
    ok('ES Disabled meta exact', esTowel === 'Stock = 50 · Desactivado', esTowel);
    const esPencil = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').getAttribute('aria-label');
    ok(
      'ES edit pencil interpolates equipment name',
      esPencil === 'Editar precios de alquiler de SUP' && esPencil.includes('SUP'),
      esPencil,
    );
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const esHeading = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading').innerText();
    const esSave = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="save-equipment"]').innerText();
    const esAdd = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-add-duration').innerText();
    const esHdrStatus = (await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading-row [data-equip-active-label]').innerText()).trim();
    ok('ES editingTitle in DOM (not EN)', /Editando —/.test(esHeading) && !/^Editing —/.test(esHeading), esHeading);
    ok('ES Save changes in DOM', /Guardar cambios/.test(esSave), esSave);
    ok('ES Add duration in DOM', /Añadir duración \+ precio/.test(esAdd), esAdd);
    ok('ES edit header Activado', esHdrStatus === 'Activado', esHdrStatus);
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="cancel-edit"]').click();

    await forceLocale('it');
    await assertNoToday('after-locale-it');
    const itTowel = (await page.locator('[data-admin-equip="towel_rental"] [data-equip-status]').innerText()).replace(/\s+/g, ' ').trim();
    ok('IT Disabled meta exact', itTowel === 'Stock = 50 · Disattivato', itTowel);
    const itBike = (await page.locator('[data-admin-equip="sup_rental"] [data-equip-status]').innerText()).replace(/\s+/g, ' ').trim();
    ok('IT Enabled meta form', /^Stock = \d+ · Attivo$/.test(itBike), itBike);
    const itPencil = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').getAttribute('aria-label');
    ok(
      'IT edit pencil interpolates equipment name',
      itPencil === 'Modifica prezzi noleggio di SUP' && itPencil.includes('SUP'),
      itPencil,
    );
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const itHeading = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading').innerText();
    const itSave = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="save-equipment"]').innerText();
    const itHdrStatus = (await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading-row [data-equip-active-label]').innerText()).trim();
    ok('IT editingTitle in DOM (not EN)', /Modifica —/.test(itHeading) && !/^Editing —/.test(itHeading), itHeading);
    ok('IT Save changes in DOM', /Salva modifiche/.test(itSave), itSave);
    ok('IT edit header Attivo', itHdrStatus === 'Attivo', itHdrStatus);
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="cancel-edit"]').click();

    await forceLocale('en');
    await assertNoToday('after-locale-en');
    const enBikeMeta = (await page.locator('[data-admin-equip="bicycle"] [data-equip-status]').innerText()).replace(/\s+/g, ' ').trim();
    ok('EN Stock = meta localized DOM', /^Stock = \d+ · Enabled$/.test(enBikeMeta), enBikeMeta);
    // City Bike after rename
    const enBikePencil = await page.locator('[data-admin-equip="bicycle"] [data-admin-action="edit-equipment"]').getAttribute('aria-label');
    ok(
      'EN edit pencil after rename uses City Bike',
      enBikePencil === 'Edit City Bike rental prices',
      enBikePencil,
    );
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    ok(
      'EN editingTitle in DOM',
      /Editing — SUP/.test(await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading').innerText()),
    );
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="cancel-edit"]').click();

    // ── 9 cooked scripts parse (must find scripts) ──
    const scriptBodies = await page.evaluate(() =>
      Array.from(document.scripts)
        .map((s) => s.textContent || '')
        .filter((t) => t.length > 200 && /adminEditTarget|renderAdminSectionPricesFromConfig|adminPopulatePricesHeaderActions/.test(t)),
    );
    ok('cooked scripts found (>=1)', scriptBodies.length >= 1, `n=${scriptBodies.length}`);
    let parseOk = true;
    let parseErr = '';
    for (const body of scriptBodies) {
      try {
        // eslint-disable-next-line no-new
        new vm.Script(body, { filename: 'cooked-staff-ui.js' });
      } catch (e) {
        parseOk = false;
        parseErr = String(e && e.message ? e.message : e);
        break;
      }
    }
    ok('cooked scripts parse', parseOk, parseErr);
    ok('no pageerror', pageErrors.length === 0, pageErrors.join('; '));
    const realConsole = consoleErrors.filter((c) => !/favicon|Download the React|Failed to load resource/i.test(c));
    ok('no console errors', realConsole.length === 0, realConsole.join('; '));

    // ── 10 geometry desktop multi-duration editor + narrow multi-duration ──
    async function geometryAt(width, label, openKey, mode) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      if (openKey && mode === 'edit') {
        const row = page.locator(`[data-admin-equip="${openKey}"]`);
        if ((await row.locator('[data-admin-equip-edit]').count()) === 0) {
          await row.locator('[data-admin-action="edit-equipment"]').click();
          await page.waitForTimeout(120);
        }
      }
      const layout = await page.evaluate((args) => {
        const key = args.key;
        const expectEdit = args.expectEdit;
        const root = document.querySelector('#admin-prices-body');
        const section = document.querySelector('#admin-sec-prices');
        const row = key ? document.querySelector(`[data-admin-equip="${key}"]`) : null;
        const grid = row && row.querySelector('.portal-admin-equip-price-grid');
        const chips = row && row.querySelector('.portal-admin-equip-chips');
        const meta = row && row.querySelector('.portal-admin-equip-meta-form');
        const footer = row && row.querySelector('.portal-admin-equip-footer');
        const hdr = document.querySelector('[data-admin-prices-hdr]');
        const missing = {
          root: !root,
          section: !section,
          row: !!(key && !row),
          grid: !!(expectEdit && (!row || !grid)),
          meta: !!(expectEdit && (!row || !meta)),
          footer: !!(expectEdit && (!row || !footer)),
          hdr: !hdr,
        };
        const anyMissing = Object.keys(missing).some((k) => missing[k]);
        // Prefer the prices panel/row; allow 4px subpixel/scrollbar noise.
        const panelOverflow = root ? (root.scrollWidth - root.clientWidth) : 99;
        const rowOverflow = row ? (row.scrollWidth - row.clientWidth) : 0;
        const sectionOverflow = section ? (section.scrollWidth - section.clientWidth) : 99;
        const hdrOverflow = hdr ? (hdr.scrollWidth - hdr.clientWidth) > 4 : true;
        const cardOverflow = grid
          ? Array.from(grid.querySelectorAll('.portal-admin-price-card')).some(
            (c) => (c.scrollWidth - c.clientWidth) > 4,
          )
          : false;
        const overflow = panelOverflow > 4 || rowOverflow > 4 || sectionOverflow > 4 || cardOverflow;
        const controls = Array.from(document.querySelectorAll(
          '#admin-prices-body .portal-admin-equip-edit-btn,'
          + '#admin-prices-body .portal-admin-equip-remove-duration,'
          + '#admin-prices-body .portal-admin-equip-footer .btn,'
          + '#admin-prices-body .portal-admin-equip-add-duration,'
          + '#admin-prices-body .portal-admin-duration-count,'
          + '#admin-prices-body .portal-admin-duration-unit,'
          + '#admin-prices-body [data-admin-price-field="amount"]',
        )).filter((el) => {
          if (!el.getClientRects().length) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 8 && r.height >= 8;
        });
        const sizes = controls.map((el) => {
          const r = el.getBoundingClientRect();
          return Math.min(r.width, r.height);
        });
        const minTouch = sizes.length ? Math.min(...sizes) : 0;
        let chipsWrap = true;
        if (chips) {
          chipsWrap = chips.scrollWidth <= chips.clientWidth + 2 || getComputedStyle(chips).flexWrap === 'wrap';
        }
        let cols = 0;
        if (grid) {
          const gt = getComputedStyle(grid).gridTemplateColumns || '';
          cols = gt.split(' ').filter((x) => x && x !== 'none').length;
        }
        let footerInBounds = false;
        if (footer && root) {
          const fr = footer.getBoundingClientRect();
          const rr = root.getBoundingClientRect();
          footerInBounds = fr.left >= rr.left - 2 && fr.right <= rr.right + 2;
        }
        // Meta form: name / stock / enabled non-overlap + enabled not clipped + left cluster
        let metaOverlap = false;
        let enabledClipped = false;
        let metaFieldCount = 0;
        let metaLeftCluster = false;
        let metaOrderOk = false;
        let metaSameRow = false;
        let metaTrailingSlack = 0;
        if (meta) {
          const fields = Array.from(meta.querySelectorAll(':scope > .portal-admin-equip-field'));
          metaFieldCount = fields.length;
          const rects = fields.map((f) => {
            const r = f.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
          });
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i];
              const b = rects[j];
              if (!(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5)) {
                metaOverlap = true;
              }
            }
          }
          const enabledField = meta.querySelector('.portal-admin-equip-enabled-field');
          const sw = enabledField && enabledField.querySelector('.portal-admin-equip-switch');
          if (enabledField && sw) {
            const er = enabledField.getBoundingClientRect();
            const sr = sw.getBoundingClientRect();
            enabledClipped = sr.right > er.right + 1 || sr.bottom > er.bottom + 1 || sr.width < 40;
          } else if (expectEdit) {
            enabledClipped = true;
          }
          if (fields.length >= 3) {
            const nameF = fields[0];
            const stockF = fields[1];
            const enF = fields[2];
            const nr = nameF.getBoundingClientRect();
            const sr = stockF.getBoundingClientRect();
            const er = enF.getBoundingClientRect();
            const mr = meta.getBoundingClientRect();
            metaOrderOk = nr.left <= sr.left + 1 && sr.left <= er.left + 1;
            metaSameRow = Math.abs(nr.top - sr.top) < 18 && Math.abs(sr.top - er.top) < 18;
            // Cluster left: last field ends well before panel/meta right (not stretched far-right).
            metaTrailingSlack = mr.right - er.right;
            metaLeftCluster = metaSameRow
              && metaOrderOk
              && metaTrailingSlack >= 40
              && (sr.left - nr.right) < 40
              && (er.left - sr.right) < 40
              && nr.width >= sr.width;
          }
        }
        // Compact × visual vs 44×44 hit target
        let removeHitOk = true;
        let removeVisualCompact = true;
        let removeLabelOk = true;
        const removes = row
          ? Array.from(row.querySelectorAll('.portal-admin-equip-remove-duration'))
          : [];
        removes.forEach((btn) => {
          const r = btn.getBoundingClientRect();
          if (r.width < 44 || r.height < 44) removeHitOk = false;
          const cs = getComputedStyle(btn);
          const bg = (cs.backgroundColor || '').replace(/\s/g, '');
          const transparentBg = bg === 'transparent' || bg === 'rgba(0,0,0,0)' || bg === 'rgba(0,0,0,0.0)';
          const fontPx = parseFloat(cs.fontSize) || 99;
          const weight = parseInt(cs.fontWeight, 10) || 700;
          if (!transparentBg || fontPx > 15 || weight >= 700) removeVisualCompact = false;
          const al = (btn.getAttribute('aria-label') || '').trim();
          if (!/remove duration/i.test(al)) removeLabelOk = false;
        });
        if (expectEdit && removes.length === 0) {
          removeHitOk = false;
          removeVisualCompact = false;
          removeLabelOk = false;
        }
        return {
          missing,
          anyMissing,
          overflow,
          panelOverflow,
          rowOverflow,
          sectionOverflow,
          cardOverflow,
          minTouch,
          chipsWrap,
          cols,
          hasGrid: !!grid,
          footerInBounds,
          controlCount: controls.length,
          metaOverlap,
          enabledClipped,
          hdrOverflow,
          metaFieldCount,
          metaLeftCluster,
          metaOrderOk,
          metaSameRow,
          metaTrailingSlack,
          removeHitOk,
          removeVisualCompact,
          removeLabelOk,
          removeCount: removes.length,
        };
      }, { key: openKey || null, expectEdit: mode === 'edit' });
      ok(`${label}: required nodes present`, !layout.anyMissing, JSON.stringify(layout.missing));
      ok(`${label}: no horizontal overflow`, !layout.overflow && !layout.hdrOverflow, JSON.stringify(layout));
      if (mode === 'edit') {
        ok(`${label}: chipsWrap true`, layout.chipsWrap, JSON.stringify(layout));
        ok(`${label}: controls >=44px`, layout.minTouch >= 44 && layout.controlCount > 0, JSON.stringify(layout));
        ok(`${label}: price grid exists`, layout.hasGrid && layout.cols >= 1, JSON.stringify(layout));
        ok(`${label}: footer within bounds`, layout.footerInBounds, JSON.stringify(layout));
        ok(`${label}: meta fields present`, layout.metaFieldCount >= 3, JSON.stringify(layout));
        ok(`${label}: name/stock/enabled non-overlap`, !layout.metaOverlap, JSON.stringify(layout));
        ok(`${label}: enabled field not clipped`, !layout.enabledClipped, JSON.stringify(layout));
        ok(
          `${label}: compact × hit target ~44 + aria label`,
          layout.removeHitOk && layout.removeLabelOk && layout.removeCount > 0,
          JSON.stringify({
            removeHitOk: layout.removeHitOk,
            removeLabelOk: layout.removeLabelOk,
            removeCount: layout.removeCount,
          }),
        );
        ok(
          `${label}: × visually compact (transparent/lighter)`,
          layout.removeVisualCompact,
          JSON.stringify({ removeVisualCompact: layout.removeVisualCompact }),
        );
      }
      return layout;
    }

    // Desktop: open multi-duration bundle — exact 3 columns + left meta cluster
    await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const desk = await geometryAt(1280, 'desktop-editor', 'board_and_suit_rental', 'edit');
    ok('desktop multi-duration uses exact 3 columns', desk.cols === 3, JSON.stringify(desk));
    ok(
      'desktop meta left-aligned cluster (name wider, stock+switch compact together)',
      desk.metaLeftCluster && desk.metaOrderOk && desk.metaSameRow && desk.metaTrailingSlack >= 40,
      JSON.stringify({
        metaLeftCluster: desk.metaLeftCluster,
        metaOrderOk: desk.metaOrderOk,
        metaSameRow: desk.metaSameRow,
        metaTrailingSlack: desk.metaTrailingSlack,
      }),
    );
    ok(
      'desktop: no body/panel/card overflow',
      !desk.overflow && desk.panelOverflow <= 4 && desk.rowOverflow <= 4 && !desk.cardOverflow,
      JSON.stringify(desk),
    );
    await measureHeader('desktop-header-recheck');

    // Intermediate width: exact 2-column duration grid
    const mid = await geometryAt(900, 'intermediate-editor', 'board_and_suit_rental', 'edit');
    ok('intermediate multi-duration uses exact 2 columns', mid.cols === 2, JSON.stringify(mid));
    ok(
      'intermediate: no body/panel/card overflow',
      !mid.overflow && mid.panelOverflow <= 4 && mid.rowOverflow <= 4 && !mid.cardOverflow,
      JSON.stringify(mid),
    );

    // Narrow: multi-duration bundle editor + browse + add gap
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(120);
    if ((await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-equip-edit]').count()) === 0) {
      await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-action="edit-equipment"]').click();
      await page.waitForTimeout(120);
    }
    const narrow = await geometryAt(390, 'narrow-editor', 'board_and_suit_rental', 'edit');
    ok('narrow multi-duration grid is 1 column (not 0)', narrow.cols === 1, JSON.stringify(narrow));
    ok(
      'narrow multi-duration has multiple price cards',
      (await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-price-card]').count()) >= 3,
    );
    ok(
      'narrow: no body/panel/card overflow',
      !narrow.overflow && narrow.panelOverflow <= 4 && narrow.rowOverflow <= 4 && !narrow.cardOverflow,
      JSON.stringify(narrow),
    );
    await measureHeader('narrow-header-edit');
    await assertNoToday('narrow-edit');
    await shotSection('rental-admin-polish-narrow-edit.png');

    await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-action="cancel-edit"]').click();
    await page.waitForTimeout(80);
    await geometryAt(390, 'narrow-browse', null, 'browse');
    await measureHeader('narrow-header-browse');
    await assertNoToday('narrow-browse');
    await shotSection('rental-admin-polish-narrow-browse.png');

    await page.locator('[data-admin-action="add-equipment"]').click();
    await page.waitForTimeout(100);
    const addGapNarrow = await page.evaluate(() => {
      const form = document.getElementById('admin-add-equip-form');
      const list = document.querySelector('.portal-admin-equip-list');
      if (!form || !list) return { ok: false, missing: true };
      const visualGap = list.getBoundingClientRect().top - form.getBoundingClientRect().bottom;
      const section = document.querySelector('#admin-sec-prices');
      const overflow = section ? (section.scrollWidth - section.clientWidth) > 4 : true;
      return { ok: true, missing: false, visualGap, overflow };
    });
    ok('add form/list nodes present narrow', addGapNarrow.ok && !addGapNarrow.missing, JSON.stringify(addGapNarrow));
    ok(
      'add form / list visualGap >= 16 narrow',
      addGapNarrow.ok && addGapNarrow.visualGap >= 16,
      JSON.stringify(addGapNarrow),
    );
    ok('narrow add: no horizontal overflow', addGapNarrow.ok && !addGapNarrow.overflow, JSON.stringify(addGapNarrow));
    await assertNoToday('narrow-add');
    await shotSection('rental-admin-polish-narrow-add.png');

    // Six required polish screenshots must exist and be non-empty
    const requiredShots = [
      'rental-admin-polish-desktop-browse.png',
      'rental-admin-polish-desktop-add.png',
      'rental-admin-polish-desktop-edit.png',
      'rental-admin-polish-narrow-browse.png',
      'rental-admin-polish-narrow-add.png',
      'rental-admin-polish-narrow-edit.png',
    ];
    requiredShots.forEach((name) => {
      const p = path.join(ARTIFACTS, name);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (_e) { size = 0; }
      ok(`screenshot exists nonempty: ${name}`, size >= 200, `size=${size} path=${p}`);
    });

  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  console.log('verify-rental-admin-hybrid-redesign\n');
  try {
    sourceContracts();
    await browserFixture();
  } catch (err) {
    fail += 1;
    console.error('  FAIL  uncaught:', err && err.stack ? err.stack : err);
  }
  console.log(`\n── verify:rental-admin-hybrid-redesign ${fail === 0 ? 'PASSED' : 'FAILED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
