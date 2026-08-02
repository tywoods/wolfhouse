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
  console.log('\n[source] hybrid layout + race gate + disclosure + i18n + CSS\n');
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const apiSrc = read('scripts/staff-query-api.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

  ok(
    'stock-today race: monotonic gen + school key + list identity gate',
    /adminEquipTodayRefreshSeq/.test(adminUi)
      && /data-equip-today-gen/.test(adminUi)
      && /data-equip-today-school/.test(adminUi)
      && /gen !== adminEquipTodayRefreshSeq/.test(adminUi)
      && /adminEquipTodaySchoolKey\(\) !== schoolKey/.test(adminUi)
      && /\[data-equip-available-today=/.test(adminUi),
  );
  ok(
    'overflow is simple disclosure (no role=menu/menuitem, no aria-haspopup=menu)',
    /data-admin-equip-overflow-panel/.test(adminUi)
      && /aria-controls/.test(adminUi)
      && /aria-expanded/.test(adminUi)
      && !/aria-haspopup="menu"/.test(adminUi)
      && !/role="menu"/.test(adminUi)
      && !/role="menuitem"/.test(adminUi)
      && /adminOpenEquipOverflowDisclosure/.test(adminUi)
      && /returnFocus/.test(adminUi),
  );
  ok(
    'semantic on/off status text always rendered',
    /admin\.prices\.on|statusOnLabel/.test(adminUi)
      && /data-equip-active-label/.test(adminUi)
      && /aria-live="polite"/.test(adminUi),
  );
  ok(
    'no full-row opacity fade for disabled equip rows',
    !/\.portal-admin-equip-row\.is-equip-disabled\{opacity/.test(apiSrc)
      && /portal-admin-equip-row\.is-equip-disabled \.portal-admin-equip-chip/.test(apiSrc),
  );
  ok(
    '44px touch targets for edit/overflow/remove/footer/duration',
    /\.portal-admin-equip-edit-btn[^{]*\{[^}]*min-height:44px/.test(apiSrc)
      && /portal-admin-duration-count\{[^}]*min-height:44px/.test(apiSrc)
      && /portal-admin-equip-delete\{[^}]*min-height:44px/.test(apiSrc)
      && /portal-admin-equip-overflow-item\{[^}]*min-height:44px/.test(apiSrc)
      && /var\(--focus/.test(apiSrc),
  );
  ok(
    'name wraps (line-clamp) not single-line ellipsis-only',
    /-webkit-line-clamp:\s*2/.test(apiSrc)
      && !/\.portal-admin-equip-name\{[^}]*white-space:nowrap/.test(apiSrc),
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
    'admin.prices.stockCount',
    'admin.prices.todayCount',
    'admin.prices.on',
    'admin.prices.off',
    'admin.prices.editingTitle',
    'admin.prices.addDurationPrice',
    'admin.prices.saveChanges',
    'admin.prices.moreActions',
    'admin.prices.deleteEquipment',
  ]) {
    ok(`EN ${key}`, en.includes(`'${key}'`));
    ok(`ES ${key}`, es.includes(`'${key}'`));
  }
  ok(
    'IT hybrid keys present (no EN fallback needed when locale it enabled)',
    en.includes("'admin.prices.editingTitle': 'Modifica — {name}'")
      && en.includes("'admin.prices.saveChanges': 'Salva modifiche'")
      && en.includes("'admin.prices.on': 'attivo'")
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

  async function shotPanel(name) {
    const panel = page.locator('#admin-prices-body');
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: path.join(ARTIFACTS, name),
      clip: await panel.boundingBox().then((b) => {
        if (!b) return null;
        return {
          x: Math.max(0, b.x - 8),
          y: Math.max(0, b.y - 8),
          width: Math.min(b.width + 16, 1280),
          height: Math.min(b.height + 16, 2000),
        };
      }),
    }).catch(async () => {
      await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage: false });
    });
  }

  try {
    await openAdminPricing();

    // ── 1 exact chips + status for every fixture item ──
    for (const key of Object.keys(EXPECTED_CHIPS)) {
      await assertExactChips(key, EXPECTED_CHIPS[key]);
    }
    ok(
      'disabled towel has semantic off + is-equip-disabled',
      (await page.locator('[data-admin-equip="towel_rental"]').evaluate((n) => n.classList.contains('is-equip-disabled')))
        && (await page.locator('[data-admin-equip="towel_rental"] [data-equip-active-label="0"]').count()) === 1,
    );
    ok(
      'active bicycle has semantic on label',
      (await page.locator('[data-admin-equip="bicycle"] [data-equip-active-label="1"]').count()) === 1
        && /on|enabled|activado|attivo/i.test(
          await page.locator('[data-admin-equip="bicycle"] [data-equip-active-label]').innerText(),
        ),
    );
    ok(
      'bicycle name has full title attribute',
      (await page.locator('[data-admin-equip="bicycle"] .portal-admin-equip-name').getAttribute('title')) === 'Bicycle',
    );
    ok(
      'available-today is aria-live polite',
      (await page.locator('[data-equip-available-today="bicycle"]').getAttribute('aria-live')) === 'polite',
    );

    await shotPanel('rental-admin-hybrid-desktop-browse.png');

    // ── stock-today race: held older request must not overwrite newer paint ──
    {
      let release;
      const holdCall = stockCall + 1; // next stock request is the stale one
      holdStock = {
        holdCall,
        promise: new Promise((res) => { release = res; }),
        resolve: () => release && release(),
      };
      // Trigger re-paint via edit open (calls renderAdminSectionPricesFromConfig + stock refresh).
      await page.locator('[data-admin-equip="bicycle"] [data-admin-action="edit-equipment"]').click();
      await page.waitForTimeout(150);
      ok('race setup: held stock call started', stockCall >= holdCall, `calls=${stockCall} hold=${holdCall}`);
      // Newer paint with updated remaining while older call still held (snapshot stays 22).
      stockByLoc['sunset-somo'].bicycle = 7;
      await page.locator('[data-admin-equip="bicycle"] [data-admin-action="cancel-edit"]').click();
      await page.waitForTimeout(450);
      const todayTxt = await page.locator('[data-equip-available-today="bicycle"]').innerText();
      const todayCount = await page.locator('[data-equip-available-today="bicycle"]').getAttribute('data-today-count');
      ok(
        'stock-today race: stale first response does not overwrite newer 7',
        todayCount === '7' || /7 today/.test(todayTxt),
        `txt=${todayTxt} count=${todayCount} calls=${stockCall} hold=${holdCall}`,
      );
      stockByLoc['sunset-somo'].bicycle = 22;
      if (release) release();
      holdStock = null;
      await page.waitForTimeout(150);
    }

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
    ok(
      'fields populated',
      (await bundle.locator('#admin-equip-name-board_and_suit_rental').inputValue()) === 'Surfboard + Wetsuit'
        && (await bundle.locator('#admin-equip-stock-board_and_suit_rental').inputValue()) === '100',
    );
    ok(
      'multi-duration editor has 4 price rows',
      (await bundle.locator('[data-admin-price-card]').count()) === 4,
    );
    ok(
      'equip overflow disclosure has no role=menu/menuitem',
      (await page.locator('[data-admin-equip-overflow] [role="menu"]').count()) === 0
        && (await page.locator('[data-admin-equip-overflow] [role="menuitem"]').count()) === 0
        && (await page.locator('[data-admin-equip-overflow] [aria-haspopup="menu"]').count()) === 0,
    );

    await shotPanel('rental-admin-hybrid-desktop-edit.png');

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
    ok(
      'cancel restores label (no mutation)',
      offerings.find((o) => o.offering_key === 'board_and_suit_rental').label === nameBefore
        && offerings.find((o) => o.offering_key === 'board_and_suit_rental').active === true,
    );

    // Enabled toggle Cancel then Save
    await bundle.locator('[data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(80);
    await bundle.locator('label.portal-admin-equip-switch').click();
    ok(
      'toggle staged disabled class while editing',
      (await bundle.evaluate((n) => n.classList.contains('is-equip-disabled'))),
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

    // ── 5 overflow disclosure a11y ──
    const bike = page.locator('[data-admin-equip="bicycle"]');
    const overflowBtn = bike.locator('[data-admin-action="equip-overflow-toggle"]');
    await overflowBtn.focus();
    await overflowBtn.click();
    await page.waitForTimeout(80);
    ok('disclosure open aria-expanded true', (await overflowBtn.getAttribute('aria-expanded')) === 'true');
    ok(
      'aria-controls points to panel',
      !!(await overflowBtn.getAttribute('aria-controls'))
        && (await page.locator(`#${await overflowBtn.getAttribute('aria-controls')}`).count()) === 1,
    );
    const delFocused = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.getAttribute && el.getAttribute('data-admin-action') === 'delete-rental-offering';
    });
    ok('open focuses Delete action', delFocused);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    ok('Escape closes disclosure', (await overflowBtn.getAttribute('aria-expanded')) === 'false');
    const focusBack = await page.evaluate(() => {
      const el = document.activeElement;
      return el && el.getAttribute && el.getAttribute('data-admin-action') === 'equip-overflow-toggle';
    });
    ok('Escape returns focus to trigger', focusBack);
    await overflowBtn.click();
    await page.waitForTimeout(50);
    await page.locator('#admin-prices-body').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(80);
    ok('outside click closes disclosure', (await overflowBtn.getAttribute('aria-expanded')) === 'false');

    // overflow delete on kayak after create — first create
    // ── 7 add-equipment exact body ──
    await page.locator('[data-admin-action="add-equipment"]').click();
    await page.locator('#admin-new-equip-name').fill('Kayak');
    await page.locator('#admin-new-equip-stock').fill('8');
    await page.locator('#admin-new-equip-count').fill('1');
    await page.locator('#admin-new-equip-unit').selectOption('days');
    await page.locator('#admin-new-equip-amount').fill('35');
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

    page.once('dialog', async (d) => { await d.accept(); });
    const kayak = page.locator('[data-admin-equip="kayak_rental"]');
    await kayak.locator('[data-admin-action="equip-overflow-toggle"]').click();
    await page.waitForTimeout(60);
    await kayak.locator('[data-admin-action="delete-rental-offering"]').click();
    await page.waitForTimeout(350);
    ok('deleted equipment row disappears', (await page.locator('[data-admin-equip="kayak_rental"]').count()) === 0);
    ok('DELETE equipment API invoked', deletes.includes('kayak_rental'), JSON.stringify(deletes));

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
      await page.evaluate(() => {
        try {
          if (typeof adminEditTarget !== 'undefined') adminEditTarget = null;
          if (typeof renderAdminFromConfig === 'function' && typeof adminConfigCache !== 'undefined') {
            renderAdminFromConfig(adminConfigCache);
          }
        } catch (_e) { /* */ }
      });
      await page.waitForTimeout(200);
    }

    await forceLocale('es');
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const esHeading = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading').innerText();
    const esSave = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="save-equipment"]').innerText();
    const esAdd = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-add-duration').innerText();
    ok('ES editingTitle in DOM (not EN)', /Editando —/.test(esHeading) && !/^Editing —/.test(esHeading), esHeading);
    ok('ES Save changes in DOM', /Guardar cambios/.test(esSave), esSave);
    ok('ES Add duration in DOM', /Añadir duración \+ precio/.test(esAdd), esAdd);
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="cancel-edit"]').click();

    await forceLocale('it');
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const itHeading = await page.locator('[data-admin-equip="sup_rental"] .portal-admin-equip-edit-heading').innerText();
    const itSave = await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="save-equipment"]').innerText();
    ok('IT editingTitle in DOM (not EN)', /Modifica —/.test(itHeading) && !/^Editing —/.test(itHeading), itHeading);
    ok('IT Save changes in DOM', /Salva modifiche/.test(itSave), itSave);
    await page.locator('[data-admin-equip="sup_rental"] [data-admin-action="cancel-edit"]').click();

    await forceLocale('en');
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
        .filter((t) => t.length > 200 && /adminEditTarget|renderAdminSectionPricesFromConfig|adminEquipTodayRefreshSeq/.test(t)),
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
    async function geometryAt(width, label, openKey) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      if (openKey) {
        const row = page.locator(`[data-admin-equip="${openKey}"]`);
        if ((await row.locator('[data-admin-equip-edit]').count()) === 0) {
          await row.locator('[data-admin-action="edit-equipment"]').click();
          await page.waitForTimeout(120);
        }
      }
      const layout = await page.evaluate((key) => {
        const body = document.body;
        const root = document.querySelector('#admin-prices-body');
        const row = key ? document.querySelector(`[data-admin-equip="${key}"]`) : null;
        const grid = row && row.querySelector('.portal-admin-equip-price-grid');
        const chips = row && row.querySelector('.portal-admin-equip-chips');
        // Prefer the prices panel/row; allow 4px subpixel/scrollbar noise.
        const panelOverflow = root ? (root.scrollWidth - root.clientWidth) : 0;
        const rowOverflow = row ? (row.scrollWidth - row.clientWidth) : 0;
        const overflow = panelOverflow > 4 || rowOverflow > 4;
        const controls = Array.from(document.querySelectorAll(
          '#admin-prices-body .portal-admin-equip-edit-btn,'
          + '#admin-prices-body .portal-admin-equip-overflow-btn,'
          + '#admin-prices-body .portal-admin-equip-remove-duration,'
          + '#admin-prices-body .portal-admin-equip-overflow-item,'
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
        const footer = row && row.querySelector('.portal-admin-equip-footer');
        let footerInBounds = true;
        if (footer && root) {
          const fr = footer.getBoundingClientRect();
          const rr = root.getBoundingClientRect();
          footerInBounds = fr.left >= rr.left - 2 && fr.right <= rr.right + 2;
        }
        return {
          overflow,
          minTouch,
          chipsWrap,
          cols,
          hasGrid: !!grid,
          footerInBounds,
          controlCount: controls.length,
        };
      }, openKey || null);
      ok(`${label}: no horizontal overflow`, !layout.overflow, JSON.stringify(layout));
      ok(`${label}: chipsWrap true`, layout.chipsWrap, JSON.stringify(layout));
      ok(`${label}: controls >=44px`, layout.minTouch >= 44 && layout.controlCount > 0, JSON.stringify(layout));
      if (openKey) {
        ok(`${label}: price grid exists`, layout.hasGrid && layout.cols >= 1, JSON.stringify(layout));
        ok(`${label}: footer within bounds`, layout.footerInBounds, JSON.stringify(layout));
      }
      return layout;
    }

    // Desktop: open multi-duration bicycle (after save has 2 existing + wait re-open)
    await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-action="edit-equipment"]').click();
    await page.waitForTimeout(100);
    const desk = await geometryAt(1280, 'desktop-editor', 'board_and_suit_rental');
    ok('desktop multi-duration uses 2 columns', desk.cols === 2, JSON.stringify(desk));
    await shotPanel('rental-admin-hybrid-desktop.png');

    // Narrow: multi-duration bundle editor (not single-row SUP)
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(120);
    // re-open if collapsed
    if ((await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-equip-edit]').count()) === 0) {
      await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-action="edit-equipment"]').click();
      await page.waitForTimeout(120);
    }
    const narrow = await geometryAt(390, 'narrow-editor', 'board_and_suit_rental');
    ok('narrow multi-duration grid is 1 column (not 0)', narrow.cols === 1, JSON.stringify(narrow));
    ok(
      'narrow multi-duration has multiple price cards',
      (await page.locator('[data-admin-equip="board_and_suit_rental"] [data-admin-price-card]').count()) >= 3,
    );
    await shotPanel('rental-admin-hybrid-narrow.png');

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
