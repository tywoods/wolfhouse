'use strict';

/**
 * verify:sunset-rental-dropdown-refresh
 *
 * Focused RED→GREEN gate for:
 *  A) Course equipment dropdown: active offering identities (price-independent)
 *  B) Delete rental only in pencil Edit mode (hard delete; priced + unpriced)
 *  C) Immediate catalog refresh after create/delete without full page.reload
 *
 * Offline browser fixture via generated /staff/ui. No network/deploy/production.
 * Companion: verify-sunset-rental-hard-delete.js (transactional hard-delete deep gate).
 *
 * Run: node scripts/verify-sunset-rental-dropdown-refresh.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

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

function sourceContracts() {
  const adminUi = read('scripts/browser/sunset-admin-ui.js');
  const en = read('scripts/lib/staff-portal-i18n.js');
  const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');
  let fail = 0;
  function ok(label, cond, detail) {
    if (cond) {
      console.log(`  PASS  ${label}`);
      return;
    }
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }

  console.log('\n[source] Course dropdown projection + edit-mode Delete + refresh contracts\n');

  const equipFn = (adminUi.match(/function adminEquipmentOfferings\(\)\{[\s\S]*?\n\}/) || [])[0] || '';
  ok(
    'adminEquipmentOfferings is active-only (not price-backed)',
    /active !== false|active === false/.test(equipFn)
      && !/adminOfferingHasActivePositivePrice/.test(equipFn),
  );
  ok(
    'adminOfferingHasActivePositivePrice uses exact key before __ (no LIKE)',
    /function adminOfferingHasActivePositivePrice\([\s\S]*?split\(['"]__['"]\)[\s\S]*?amount_cents[\s\S]*?>\s*0/.test(
      adminUi,
    ) && !/function adminOfferingHasActivePositivePrice\([\s\S]*?LIKE/.test(adminUi),
  );
  ok(
    'historical selected fallback remains unavailable disabled option',
    /admin\.courseEquipment\.unavailable/.test(adminUi) && /selected disabled/.test(adminUi),
  );
  ok(
    'Delete rental action exists; duration × stays removeDuration',
    /data-admin-action="delete-rental-offering"/.test(adminUi)
      && /admin\.prices\.deleteRental/.test(adminUi)
      && /delete-price[\s\S]{0,200}removeDuration/.test(adminUi),
  );
  ok(
    'Delete rental only in edit mode (not collapsed card)',
    /editing[\s\S]{0,800}delete-rental-offering|Edit mode:[\s\S]{0,300}delete-rental-offering|NEVER on the collapsed/.test(
      adminUi,
    ),
  );
  ok(
    'Delete rental posts DELETE to rental-offerings/:key',
    /delete-rental-offering[\s\S]{0,1200}adminApiRequest\(\s*['"]DELETE['"]\s*,\s*['"]\/staff\/admin\/config\/rental-offerings\//.test(
      adminUi,
    ),
  );
  ok(
    'Delete rental confirms with localized message',
    /delete-rental-offering[\s\S]{0,400}confirm[\s\S]{0,120}admin\.prices\.deleteRentalConfirm|admin\.prices\.deleteRentalConfirm[\s\S]{0,200}confirm/.test(
      adminUi,
    ) || /confirm\(portalT\(['"]admin\.prices\.deleteRentalConfirm['"]\)\)/.test(adminUi),
  );
  ok(
    'config + rental catalog fetches use cache no-store (or bust)',
    (/cache:\s*['"]no-store['"]/.test(adminUi) || /[_?](?:_ts|cb|cacheBust)=/.test(adminUi))
      && /rental-offerings[\s\S]{0,120}include_inactive=true/.test(adminUi),
  );
  ok(
    'save-new-equipment reloads config after create (no page.reload)',
    /action === ['"]save-new-equipment['"][\s\S]{0,3500}adminReloadConfig\(\)/.test(adminUi)
      && !/action === ['"]save-new-equipment['"][\s\S]{0,3500}location\.reload\s*\(/.test(adminUi)
      && !/action === ['"]save-new-equipment['"][\s\S]{0,3500}window\.location\.reload\s*\(/.test(adminUi),
  );
  ok(
    'delete-rental-offering reloads config after success',
    /delete-rental-offering[\s\S]{0,1500}adminReloadConfig\(/.test(adminUi),
  );
  ok('EN Delete rental copy', en.includes("'admin.prices.deleteRental': 'Delete rental'"));
  ok('ES Delete rental copy', es.includes("'admin.prices.deleteRental': 'Eliminar alquiler'"));
  ok(
    'EN Delete rental confirm',
    en.includes('admin.prices.deleteRentalConfirm')
      && /deleteRentalConfirm['"]:\s*['"][^'"]+/.test(en),
  );
  ok(
    'ES Delete rental confirm',
    es.includes('admin.prices.deleteRentalConfirm'),
  );

  if (fail) {
    throw new Error(`source contracts failed: ${fail}`);
  }
  console.log('  source contracts OK');
}

async function browserFixture() {
  console.log('\n[browser] Dropdown projection + Delete rental + create refresh\n');

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Mutable fixture — hard-delete removes identity; create adds it back.
  let offerings = [
    { offering_key: 'softboard', label: 'Soft board', active: true },
    { offering_key: 'ghost_fins', label: 'Ghost fins (unpriced)', active: true },
    { offering_key: 'zero_price_pad', label: 'Zero pad', active: true },
    { offering_key: 'retired_board', label: 'Retired board', active: false },
  ];
  let rentalPrices = [
    {
      id: 'price-soft-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'softboard__1_day',
      item_code: 'softboard__1_day',
      display_name: 'Soft board',
      label: 'Soft board',
      amount_cents: 1500,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      id: 'price-zero-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'zero_price_pad__1_day',
      item_code: 'zero_price_pad__1_day',
      display_name: 'Zero pad',
      label: 'Zero pad',
      amount_cents: 0,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
    {
      id: 'price-ret-1',
      category: 'rental',
      item_type: 'rental',
      offering_key: 'retired_board__1_day',
      item_code: 'retired_board__1_day',
      display_name: 'Retired board',
      label: 'Retired board',
      amount_cents: 900,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    },
  ];
  let pack = {
    pack_id: 'verify-demo-pack',
    label: 'Group',
    age_band: '12_and_up',
    group_size: 8,
    beaches: ['somo'],
    weekly: 'mon_fri',
    schedules: ['0930_1130'],
    price_tiers: [],
    equipment_options: [
      // Historical disabled reference retained as unavailable until edited/removed.
      { offering_key: 'retired_board', equipment_price_cents: 0, all_day_surcharge_cents: 0 },
    ],
  };
  let privateLesson = {
    enabled: true,
    label: 'Private',
    amount_cents: 5000,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: 120,
    notes: 'draft',
    equipment_options: [],
  };

  const deletes = [];
  const creates = [];
  const configGets = [];
  const catalogGets = [];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  // Register rental-offerings BEFORE config so collection/key paths are not swallowed.
  await page.route(/\/staff\/admin\/config\/rental-offerings(?:\/([a-z][a-z0-9_]*))?(?:\?|$)/, async (r) => {
    const method = r.request().method();
    const u = r.request().url();
    const keyMatch = /rental-offerings\/([a-z][a-z0-9_]*)(?:\?|$)/.exec(u);
    const key = keyMatch ? keyMatch[1] : '';
    if (!key) {
      if (method === 'GET') {
        catalogGets.push({ url: u, headers: r.request().headers() });
        await r.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
          body: JSON.stringify({ success: true, offerings: offerings.slice() }),
        });
        return;
      }
      if (method === 'POST') {
        const body = JSON.parse(r.request().postData() || '{}');
        creates.push({ kind: 'offering', body });
        const exists = offerings.some((o) => o.offering_key === body.offering_key);
        if (!exists) {
          offerings.push({
            offering_key: body.offering_key,
            label: body.label || body.offering_key,
            active: true,
          });
        }
        await r.fulfill({
          status: exists ? 409 : 201,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            offering: {
              offering_key: body.offering_key,
              label: body.label,
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
      if (Array.isArray(pack.equipment_options)) {
        pack = {
          ...pack,
          equipment_options: pack.equipment_options.filter((e) => e.offering_key !== key),
        };
      }
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          deleted: true,
          offering_key: key,
          offerings_deleted: 1,
          prices_deleted: 1,
          surf_packs_updated: 0,
          private_lessons_updated: 0,
        }),
      });
      return;
    }
    if (method === 'PATCH' && key) {
      const body = JSON.parse(r.request().postData() || '{}');
      const off = offerings.find((o) => o.offering_key === key);
      if (off && typeof body.active === 'boolean') off.active = body.active;
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offering: off || { offering_key: key } }),
      });
      return;
    }
    await r.continue();
  });

  // Exact admin config load only (not /config/prices, /config/rental-offerings, …).
  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (r) => {
    configGets.push({ url: r.request().url(), headers: r.request().headers() });
    const x = await r.fetch();
    const b = await x.json();
    b.surf_packs = [pack];
    b.private_lesson = privateLesson;
    b.prices = rentalPrices.slice();
    b.writes_enabled = true;
    b.read_only = false;
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(b),
    });
  });

  await page.route(/\/staff\/admin\/config\/prices(?:\?|$)/, async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    creates.push({ kind: 'price', body });
    const okKey = String(body.offering_key || '').trim();
    const dur = String(body.period_window || '1_day');
    const code = okKey.includes('__') ? okKey : `${okKey}__${dur}`;
    const baseKey = code.split('__')[0];
    const label = offerings.find((o) => o.offering_key === baseKey)?.label || baseKey;
    rentalPrices.push({
      id: `price-new-${rentalPrices.length + 1}`,
      category: 'rental',
      item_type: 'rental',
      offering_key: code,
      item_code: code,
      display_name: label,
      label,
      amount_cents: Number(body.amount_cents) || 0,
      active: true,
      client_slug: 'sunset',
      location_id: 'sunset-somo',
    });
    await r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, price: { item_code: code } }),
    });
  });

  await page.route('**/staff/admin/config/surf-packs/**', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    pack = { ...pack, ...body };
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, surf_pack: pack }),
    });
  });

  try {
    await page.goto(base + '/staff/ui');
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('[data-admin-pack-card]').first().waitFor();

    // ── A) Course dropdown projection (active identity, price-independent) ──
    await page.locator('[data-admin-action="edit-pack"]').click();
    let ed = page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');
    await ed.locator('[data-admin-action="add-equipment-option"]').click();
    const newRow = ed.locator('[data-equipment-option-row]').nth(1); // first row is historical retired_board
    const optionValues = await newRow.locator('select option').evaluateAll((opts) =>
      opts.map((o) => o.value).filter(Boolean),
    );
    assert.ok(optionValues.includes('softboard'), 'active priced offering selectable');
    assert.ok(optionValues.includes('ghost_fins'), 'active unpriced offering selectable');
    assert.ok(optionValues.includes('zero_price_pad'), 'active zero-price offering selectable');
    assert.ok(!optionValues.includes('retired_board'), 'disabled offering absent from new options');

    // Historical selected disabled key retained as Unavailable on its row only
    const histRow = ed.locator('[data-equipment-option-row]').first();
    const histSelected = await histRow.locator('select').inputValue();
    assert.strictEqual(histSelected, 'retired_board', 'historical selected disabled key retained');
    const histHtml = await histRow.locator('select').innerHTML();
    assert.ok(
      /retired_board[\s\S]*Unavailable|value="retired_board"[^>]*selected[^>]*disabled|value="retired_board"[^>]*disabled[^>]*selected/i.test(
        histHtml,
      ) || /Unavailable/i.test(await histRow.innerText()),
      'historical row shows Unavailable disabled option',
    );
    assert.ok(
      !(await newRow.locator('option[value="retired_board"]:not([disabled])').count()),
      'disabled key not freely selectable on other rows',
    );

    await page.locator('[data-admin-action="cancel-edit"]').click();

    // ── B) Delete rental only after pencil Edit (hard delete) ──
    const softCard = page.locator('[data-admin-equip="softboard"]');
    const ghostCard = page.locator('[data-admin-equip="ghost_fins"]');
    assert.strictEqual(await ghostCard.count(), 1, 'unpriced rental remains visible in Rental Admin');
    assert.strictEqual(
      await softCard.locator('[data-admin-action="delete-rental-offering"]').count(),
      0,
      'collapsed priced card has no Delete rental',
    );
    assert.strictEqual(
      await ghostCard.locator('[data-admin-action="delete-rental-offering"]').count(),
      0,
      'collapsed unpriced card has no Delete rental',
    );

    await ghostCard.locator('[data-admin-action="edit-equipment"]').click();
    const delBtn = page.locator('[data-admin-equip="ghost_fins"] [data-admin-action="delete-rental-offering"]');
    assert.strictEqual(await delBtn.count(), 1, 'edit mode shows Delete rental');
    assert.ok(
      /delete rental/i.test(await delBtn.innerText()),
      'Delete rental uses visible localized label, not bare ×',
    );

    page.once('dialog', async (d) => {
      assert.ok(/permanent|delete|duration|course/i.test(d.message()), 'confirm dialog mentions hard delete');
      await d.accept();
    });
    const configBeforeDelete = configGets.length;
    const catalogBeforeDelete = catalogGets.length;
    await delBtn.click();
    // Wait for hard-delete + full config/catalog refresh (card removed).
    await page.waitForFunction(
      () => !document.querySelector('[data-admin-equip="ghost_fins"]'),
      null,
      { timeout: 8000 },
    );
    for (let i = 0; i < 40 && (catalogGets.length <= catalogBeforeDelete || configGets.length <= configBeforeDelete); i++) {
      await page.waitForTimeout(50);
    }

    assert.deepStrictEqual(deletes, ['ghost_fins'], 'DELETE rental-offerings/ghost_fins called');
    assert.ok(configGets.length > configBeforeDelete, 'config reloaded after delete');
    assert.ok(catalogGets.length > catalogBeforeDelete, 'rental catalog reloaded after delete');
    assert.strictEqual(await page.locator('[data-admin-equip="ghost_fins"]').count(), 0, 'hard-deleted card gone');

    // Dropdown after delete (no page.reload)
    await page.locator('[data-admin-action="edit-pack"]').click();
    ed = page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');
    await ed.locator('[data-admin-action="add-equipment-option"]').click();
    const afterDelOpts = await ed
      .locator('[data-equipment-option-row]')
      .nth(1)
      .locator('select option')
      .evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
    assert.ok(!afterDelOpts.includes('ghost_fins'), 'after Delete, dropdown excludes item without page.reload');
    assert.ok(afterDelOpts.includes('softboard'), 'softboard still selectable after delete refresh');
    assert.ok(afterDelOpts.includes('zero_price_pad'), 'active unpriced/zero still selectable');
    await page.locator('[data-admin-action="cancel-edit"]').click();

    // ── C) Create offering + positive price → immediately selectable ──
    const configBeforeCreate = configGets.length;
    await page.locator('[data-admin-action="add-equipment"]').click();
    await page.locator('#admin-new-equip-name').fill('Kayak');
    // Defaults: days=1 via renderAdminDurationControl; require positive amount.
    await page.locator('#admin-new-equip-amount').fill('12.50');
    await page.locator('[data-admin-action="save-new-equipment"]').click();
    await page.waitForFunction(
      () => {
        const cards = document.querySelectorAll('[data-admin-equip]');
        return Array.from(cards).some((c) => /kayak/i.test(c.getAttribute('data-admin-equip') || ''));
      },
      null,
      { timeout: 8000 },
    );

    assert.ok(
      creates.some((c) => c.kind === 'offering'),
      'POST rental-offerings on create',
    );
    assert.ok(
      creates.some((c) => c.kind === 'price' && Number(c.body.amount_cents) > 0),
      'POST prices with positive amount on create',
    );
    assert.ok(configGets.length > configBeforeCreate, 'config refreshed after create without page.reload');

    await page.locator('[data-admin-action="edit-pack"]').click();
    ed = page.locator('[data-admin-pack-form] [data-admin-equipment-editor]');
    await ed.locator('[data-admin-action="add-equipment-option"]').click();
    const createOpts = await ed
      .locator('[data-equipment-option-row]')
      .nth(1)
      .locator('select option')
      .evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
    assert.ok(
      createOpts.includes('kayak_rental') || createOpts.some((v) => /kayak/.test(v)),
      'new offering appears in dropdown immediately: ' + JSON.stringify(createOpts),
    );

    // Prefer cache no-store on at least one post-mutation catalog/config get
    const lateCatalog = catalogGets.slice(catalogBeforeDelete);
    const lateConfig = configGets.slice(configBeforeDelete);
    const anyNoStore = [...lateCatalog, ...lateConfig].some((g) => {
      const h = g.headers || {};
      const cc = String(h['cache-control'] || h['Cache-Control'] || '');
      return /no-store/i.test(cc) || /[_&?](?:_ts|cb|cacheBust)=\d+/.test(g.url);
    });
    // Request-side cache is what we control in admin UI fetch options.
    const adminUi = read('scripts/browser/sunset-admin-ui.js');
    assert.ok(
      /cache:\s*['"]no-store['"]/.test(adminUi) || anyNoStore,
      'refresh path uses cache no-store or cache-bust',
    );

    assert.deepStrictEqual(errors, []);
    console.log('  browser fixture OK');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

async function main() {
  console.log('\nverify:sunset-rental-dropdown-refresh\n');
  // Source first (fast RED), then browser fixture.
  sourceContracts();
  await browserFixture();
  console.log('\nverify-sunset-rental-dropdown-refresh — ALL CHECKS PASSED\n');
}

main().catch((e) => {
  console.error('\nRED/FAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
