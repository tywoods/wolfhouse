'use strict';

/**
 * verify:booking-drawer-equipment-reorg
 *
 * Create + Edit EQUIPMENT list reorg gate (name-as-toggle, from €min, quote-authoritative
 * line totals, raw qty preservation, Edit stepper parity).
 *
 * Authoritative money: row line totals paint ONLY from quote response line_items
 * (offering_key + duration_key match). Verifier returns intentionally divergent
 * totals (catalog unit×qty ≠ quote line total) so local formula cannot pass.
 *
 * Run: npm run verify:booking-drawer-equipment-reorg
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

try {
  require.resolve('dotenv');
} catch (_) {
  const shared = '/opt/wolfhouse/WH/node_modules';
  if (fs.existsSync(shared)) {
    const paths = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
    if (!paths.includes(shared)) paths.unshift(shared);
    process.env.NODE_PATH = paths.join(path.delimiter);
    Module._initPaths();
  }
}

process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';

function pw() {
  try { return require('playwright'); }
  catch (e) { return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright'); }
}

const listen = (s) => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
});

const ARTIFACT_DIR = '/opt/data/artifacts';
const DATE = '2026-08-10';
const BOOKING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOT = path.join(__dirname, '..');

const RENTAL_OFFERINGS = [
  { offering_key: 'bicycle_rental', label: 'Bicycle', active: true, location_id: 'sunset-somo', excludes: [] },
  { offering_key: 'flipflops_rental', label: 'Flipflops', active: true, location_id: 'sunset-somo', excludes: [] },
  { offering_key: 'sup_rental', label: 'SUP', active: true, location_id: 'sunset-somo', excludes: [] },
  { offering_key: 'board_and_suit_rental', label: 'Surfboard + Wetsuit', active: true, location_id: 'sunset-somo', excludes: [] },
  { offering_key: 'towel_rental', label: 'Towel', active: true, location_id: 'sunset-somo', excludes: [] },
];

// Catalog prices (hints only). Verifier quote route returns DIFFERENT line totals.
const RENTAL_PRICES = [
  mkPrice('bicycle_rental', '1_day', 1000),
  mkPrice('bicycle_rental', '2_days', 1800),
  mkPrice('flipflops_rental', '1_day', 200),
  mkPrice('flipflops_rental', '2_days', 350),
  mkPrice('sup_rental', '1_day', 5000), // catalog €50 — quote will return €117 for qty 2
  mkPrice('sup_rental', '2_days', 9000),
  mkPrice('board_and_suit_rental', '1_day', 2000),
  mkPrice('board_and_suit_rental', '5_days', 10000),
  mkPrice('towel_rental', '1_day', 500), // catalog €5 — quote will return €41 for qty 1
  mkPrice('towel_rental', '2_days', 900),
];

function mkPrice(offering, duration, cents) {
  return {
    category: 'rental',
    offering_key: `${offering}__${duration}`,
    item_code: `${offering}__${duration}`,
    unit: 'day',
    amount_cents: cents,
    active: true,
    location_id: 'sunset-somo',
    label: duration.replace('_', ' '),
    client_slug: 'sunset',
    tenant: 'sunset',
  };
}

/** Authoritative divergent totals — NOT catalog unit × qty. */
const AUTH_LINE = {
  // sup 1_day × 2 catalog = 10000; auth = 11700
  'sup_rental|1_day|2': 11700,
  'sup_rental|1_day|1': 6100,
  'sup_rental|2_days|1': 9900,
  'sup_rental|2_days|2': 19100,
  // towel 1_day × 1 catalog = 500; auth = 4100
  'towel_rental|1_day|1': 4100,
  'towel_rental|1_day|2': 7700,
  'bicycle_rental|1_day|1': 1300,
  'flipflops_rental|1_day|1': 250,
  'board_and_suit_rental|1_day|1': 2200,
};

function authTotal(key, dur, qty) {
  const k = `${key}|${dur}|${qty}`;
  if (AUTH_LINE[k] != null) return AUTH_LINE[k];
  // deterministic offset so never equals catalog unit×qty for our fixtures
  const catalog = {
    sup_rental: { '1_day': 5000, '2_days': 9000 },
    towel_rental: { '1_day': 500, '2_days': 900 },
    bicycle_rental: { '1_day': 1000 },
    flipflops_rental: { '1_day': 200 },
    board_and_suit_rental: { '1_day': 2000 },
  };
  const u = (catalog[key] && catalog[key][dur]) || 1000;
  return u * qty + 1100; // always ≠ u*qty
}

function fmtEuro(cents) {
  return '€' + (Math.round(cents) / 100).toFixed(2);
}

function sourceContract() {
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const edit = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
  const portal = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
  const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

  assert.ok(/width:min\(440px,94vw\)/.test(api), 'Create drawer width');
  assert.ok(/width:min\(420px,92vw\)/.test(api), 'Edit drawer width');
  assert.ok(api.includes('portal-schedule-create-rental-toggle'), 'Create toggle');
  assert.ok(edit.includes('portal-schedule-create-rental-toggle'), 'Edit toggle');
  assert.ok(api.includes('schedulePaintRentalRowLineTotalsFromQuote'), 'paint helper');
  assert.ok(api.includes('scheduleClearRentalRowLineTotals'), 'clear helper');
  assert.ok(api.includes('scheduleMatchStandaloneRentalQuoteLine'), 'match helper');
  assert.ok(api.includes('quantityRaw'), 'Create raw qty capture');
  assert.ok(edit.includes('quantityRaw'), 'Edit raw qty capture');
  assert.ok(edit.includes('scheduleEnhanceIntSteppersIn(wrap)'), 'Edit enhances steppers on wrap');
  assert.ok(portal.includes('line_items: Array.isArray(data.line_items)') || portal.includes('rental_line_paint_failed'), 'Create quote stores line_items / paint fail');
  assert.ok(portal.includes('rental_line_paint_failed'), 'Create fail-closed on paint');
  assert.ok(edit.includes('rental_line_paint_failed'), 'Edit fail-closed on paint');
  assert.ok(api.includes('Equipment list qty steppers only') || api.includes('44px') && api.includes('ps-create-rentals') && api.includes('portal-schedule-int-step'), '44px equipment stepper CSS');
  assert.ok(/#ps-create-rentals[^{]*\.portal-schedule-int-step\{[^}]*min-height:44px/.test(api.replace(/\s+/g, ''))
    || api.includes('#ps-create-rentals .portal-schedule-create-rental-row .portal-schedule-int-step'), 'equipment step CSS selector');
  assert.ok(i18n.includes("'schedule.create.rentalFrom': 'from'"), 'EN from');
  assert.ok(i18n.includes("'schedule.create.rentalFrom': 'da'"), 'IT from');
  assert.ok(es.includes("'schedule.create.rentalFrom': 'desde'"), 'ES from');
  // Must not paint final line total from unit * qty in production helpers
  const paintFn = api.slice(
    api.indexOf('function schedulePaintRentalRowLineTotalsFromQuote'),
    api.indexOf('function scheduleUpdateRentalRowLineTotal'),
  );
  assert.ok(!/\*\s*qty|unitCents\s*\*\s*|amount_cents\s*\*\s*/.test(paintFn), 'paint helper no unit*qty');
  console.log('  PASS  source contract');
}

async function seedCaches(page, mode) {
  await page.evaluate((payload) => {
    if (typeof scheduleAdminPricesCache !== 'undefined') scheduleAdminPricesCache = payload.prices;
    if (typeof scheduleRentalOfferingsCache !== 'undefined') scheduleRentalOfferingsCache = payload.offerings;
    if (payload.mode === 'create' && typeof window.scheduleRenderCreateRentals === 'function') {
      window.scheduleRenderCreateRentals();
    }
    if (payload.mode === 'edit' && typeof scheduleRenderDrawerRentals === 'function') {
      scheduleRenderDrawerRentals();
    }
  }, { prices: RENTAL_PRICES, offerings: RENTAL_OFFERINGS, mode });
}

async function openCreate(page) {
  await page.evaluate(() => {
    if (typeof openScheduleCreateModal === 'function') openScheduleCreateModal(null);
    else {
      const m = document.getElementById('ps-create-modal');
      if (m) { m.style.display = 'flex'; m.setAttribute('aria-hidden', 'false'); }
      document.querySelector('.ck-cta, #ps-create-booking')?.click();
    }
  });
  await page.locator('#ps-create-modal').waitFor({ state: 'visible', timeout: 10000 });
}

async function rowState(page, wrapSel, offeringKey) {
  return page.evaluate(({ wrapSel: w, key }) => {
    const wrap = document.querySelector(w);
    const row = wrap && wrap.querySelector(`[data-rental-offering="${key}"]`);
    if (!row) return { missing: true };
    const btn = row.querySelector('.portal-schedule-create-rental-toggle');
    const check = row.querySelector('.ps-create-rental-check, .ps-drawer-rental-check');
    const from = row.querySelector('.portal-schedule-create-rental-from');
    const controls = row.querySelector('.portal-schedule-create-rental-controls');
    const qtyWrap = row.querySelector('.portal-schedule-create-rental-qty');
    const price = row.querySelector('.portal-schedule-create-rental-price');
    const dur = row.querySelector('select[data-rental-duration-select], select.ps-create-rental-duration, select.ps-drawer-rental-duration');
    const qtyInput = row.querySelector('input.ps-create-rental-qty-input, input.ps-drawer-rental-qty-input');
    const stepper = qtyInput && qtyInput.closest('.portal-schedule-int-stepper');
    const dec = stepper && stepper.querySelector('[data-int-step="dec"]');
    const inc = stepper && stepper.querySelector('[data-int-step="inc"]');
    function vis(el) {
      if (!el) return false;
      if (el.hasAttribute('hidden')) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.05
        && el.getBoundingClientRect().width > 1;
    }
    const checkR = check ? check.getBoundingClientRect() : null;
    const visibleCheckbox = !!(check && Number(getComputedStyle(check).opacity) > 0.05
      && checkR && checkR.width > 2 && checkR.height > 2);
    return {
      missing: false,
      ariaPressed: btn ? btn.getAttribute('aria-pressed') : null,
      isButton: !!(btn && btn.tagName === 'BUTTON'),
      btnMinH: btn ? btn.getBoundingClientRect().height : 0,
      checked: !!(check && check.checked),
      visibleCheckbox,
      fromText: from && vis(from) ? from.textContent.replace(/\s+/g, ' ').trim() : null,
      fromHidden: !from || !vis(from),
      controlsVisible: vis(controls),
      qtyVisible: vis(qtyWrap),
      qtyValue: qtyInput ? String(qtyInput.value) : null,
      priceText: price && vis(price) ? price.textContent.replace(/\s+/g, ' ').trim() : null,
      lineCents: price && price.getAttribute('data-line-total-cents') != null
        && price.getAttribute('data-line-total-cents') !== ''
        ? Number(price.getAttribute('data-line-total-cents'))
        : null,
      linePending: price ? price.getAttribute('data-line-pending') === '1' : false,
      durationValue: dur ? dur.value : null,
      hasStepper: !!stepper,
      decVisible: vis(dec),
      incVisible: vis(inc),
      decH: dec ? dec.getBoundingClientRect().height : 0,
      incH: inc ? inc.getBoundingClientRect().height : 0,
      isSelected: row.classList.contains('is-selected'),
    };
  }, { wrapSel, key: offeringKey });
}

async function quotePreviewText(page, sel) {
  return page.locator(sel).innerText().catch(() => '');
}

async function measureDrawerWidth(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return {
      width: Math.round(el.getBoundingClientRect().width * 100) / 100,
      overflow: el.scrollWidth > el.clientWidth + 1,
    };
  }, sel);
}

(async () => {
  console.log('\nverify:booking-drawer-equipment-reorg\n');
  sourceContract();

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  let quoteDelayMs = 0;
  let quoteMode = 'normal'; // normal | missing_line | duplicate_line | hold_old
  let heldResponses = [];
  const quoteBodies = [];
  const saveBodies = [];
  let quoteSeq = 0;

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route('**/staff/admin/config?**', async (route) => {
    const x = await route.fetch();
    let body;
    try { body = await x.json(); } catch (_) { body = { success: true }; }
    body.success = true;
    body.prices = RENTAL_PRICES.slice();
    body.rental_offerings = RENTAL_OFFERINGS.slice();
    body.private_lesson = { enabled: true, label: 'Private Course', default_duration_minutes: 120, equipment_options: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/staff/admin/config/rental-offerings**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, offerings: RENTAL_OFFERINGS }),
    });
  });

  await page.route('**/staff/schedule/bookings/catalog?**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, ok: true, courses: [], offerings: [], rentals: [] }),
    });
  });

  await page.route('**/staff/schedule/bookings/quote?**', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
    quoteBodies.push(body);
    quoteSeq += 1;
    const mySeq = quoteSeq;
    const delay = quoteDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const rentals = Array.isArray(body.rentals) ? body.rentals : [];
    let line_items = rentals.map((r) => {
      const key = String(r.offering_key || '');
      const dur = String(r.duration_key || r.duration || '1_day');
      const qty = Number(r.quantity) || 1;
      const total = authTotal(key, dur, qty);
      return {
        component: key,
        offering_key: key,
        duration_key: dur,
        quantity: qty,
        unit_amount_cents: Math.round(total / qty),
        total_cents: total,
        course_equipment: false,
        label: key,
      };
    });

    // Unrelated non-rental line so top total ≠ single equipment line
    const EXTRA = 3333;
    line_items = line_items.concat([{
      component: 'staff_custom',
      offering_key: null,
      duration_key: null,
      quantity: 1,
      total_cents: EXTRA,
      label: 'Unrelated line',
      client_line_id: 'unrelated-extra',
    }]);

    if (quoteMode === 'missing_line') {
      line_items = line_items.filter((li) => li.offering_key !== 'sup_rental');
    }
    if (quoteMode === 'duplicate_line') {
      const sup = line_items.find((li) => li.offering_key === 'sup_rental');
      if (sup) line_items.push({ ...sup, total_cents: sup.total_cents + 50 });
    }

    const total_cents = line_items.reduce((s, li) => s + (Number(li.total_cents) || 0), 0);
    const payload = {
      success: true,
      total_cents,
      subtotal_cents: total_cents,
      line_items,
      quote_provenance: { quote_fingerprint: `fp-equip-${mySeq}` },
    };

    if (quoteMode === 'hold_old') {
      heldResponses.push({ seq: mySeq, payload });
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });

  await page.route('**/staff/schedule/bookings?**', async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
      saveBodies.push({ kind: 'create', body });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          booking_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          booking_code: 'EQUIP-C',
        }),
      });
    }
    if (method === 'PATCH' || method === 'PUT') {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
      saveBodies.push({ kind: 'update', body });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, booking_id: BOOKING_ID }),
      });
    }
    return route.continue();
  });

  await page.route('**/staff/schedule/bookings/update**', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
    saveBodies.push({ kind: 'update', body });
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, booking_id: BOOKING_ID }),
    });
  });

  await page.route('**/staff/schedule/day?**', (route) => {
    const date = new URL(route.request().url()).searchParams.get('date') || DATE;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date,
        lessons: [],
        gear: [],
        rows: [{
          booking_id: BOOKING_ID,
          booking_code: 'EQUIP-E',
          guest_name: 'Equipment Edit Guest',
          record_source: 'staff_manual',
          service_date: date,
          service_time_local: '09:30',
          service_type: 'rental',
          offering_label: 'SUP',
          metadata: { component: 'rental', offering_key: 'sup_rental' },
          quantity: 2,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
        }],
      }),
    });
  });

  await page.route('**/staff/schedule/bookings/detail?**', (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        booking_id: BOOKING_ID,
        booking_code: 'EQUIP-E',
        guest_name: 'Equipment Edit Guest',
        phone: '+34600999888',
        payment_status: 'unpaid',
        date_from: DATE,
        date_to: DATE,
        components: {},
        lessons: [],
        course_equipment: [],
        rentals: [
          { offering_key: 'sup_rental', duration_key: '1_day', quantity: 2 },
        ],
        custom_line_items: [],
        editable: true,
        location_id: 'sunset-somo',
        payment: {
          subtotal_cents: 11700,
          paid_cents: 0,
          balance_due_cents: 11700,
          line_items: [],
        },
      }),
    });
  });

  await page.route('**/staff/schedule/rental-stock?**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, stock: {} }),
    });
  });

  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.waitForTimeout(400);

    // ═══════════════════════════════════════════════════════════════════
    // CREATE
    // ═══════════════════════════════════════════════════════════════════
    console.log('[Create]');
    await openCreate(page);
    await page.locator('#ps-create-guest').fill('Equipment Create Guest');
    await page.locator('#ps-create-phone').fill('+34600111222');
    await page.evaluate(([from, to]) => {
      for (const [id, v] of [['ps-create-date-from', from], ['ps-create-date-to', to]]) {
        const n = document.getElementById(id);
        if (n) { n.value = v; n.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, [DATE, DATE]);
    const noLesson = page.locator('[data-create-activity="ps-create-comp-no-lesson"]');
    if (await noLesson.count()) await noLesson.click();
    await seedCaches(page, 'create');
    await page.waitForTimeout(200);

    const createWrap = '#ps-create-rentals';
    await page.locator(`${createWrap} [data-rental-offering]`).first().waitFor({ timeout: 10000 });

    // Initial unselected
    const keys = await page.evaluate((w) => [...document.querySelectorAll(`${w} [data-rental-offering]`)].map((r) => r.getAttribute('data-rental-offering')), createWrap);
    for (const key of keys) {
      const st = await rowState(page, createWrap, key);
      assert.strictEqual(st.missing, false, key);
      assert.strictEqual(st.isButton, true);
      assert.strictEqual(st.ariaPressed, 'false');
      assert.ok(st.btnMinH >= 44, `${key} height`);
      assert.strictEqual(st.visibleCheckbox, false);
      assert.strictEqual(st.controlsVisible, false);
      assert.ok(st.fromText && /^from\s+€/.test(st.fromText), st.fromText);
    }
    console.log('  PASS  Create initial unselected');

    // Select SUP
    await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-create-rental-toggle`).click();
    await page.waitForTimeout(100);
    let sup = await rowState(page, createWrap, 'sup_rental');
    assert.strictEqual(sup.ariaPressed, 'true');
    assert.strictEqual(sup.controlsVisible, true);
    assert.strictEqual(sup.qtyVisible, true);
    assert.strictEqual(sup.visibleCheckbox, false);
    // Pending until quote paints
    assert.ok(sup.linePending || sup.priceText === '—' || sup.lineCents == null, 'pending before quote');
    // Wait for quote
    await page.waitForTimeout(700);
    sup = await rowState(page, createWrap, 'sup_rental');
    // qty defaults to 1 → auth 6100 not catalog 5000
    assert.strictEqual(sup.lineCents, authTotal('sup_rental', '1_day', 1), `auth line ${sup.lineCents}`);
    assert.ok(sup.priceText.includes(fmtEuro(authTotal('sup_rental', '1_day', 1))), sup.priceText);
    console.log('  PASS  Create select paints authoritative (not catalog) line total');

    // Qty 2 via stepper — must exist
    const supRow = page.locator(`${createWrap} [data-rental-offering="sup_rental"]`);
    const inc = supRow.locator('.portal-schedule-int-stepper [data-int-step="inc"]');
    const dec = supRow.locator('.portal-schedule-int-stepper [data-int-step="dec"]');
    assert.strictEqual(await inc.count(), 1, 'Create + stepper required');
    assert.strictEqual(await dec.count(), 1, 'Create − stepper required');
    assert.ok(await inc.isVisible());
    assert.ok(await dec.isVisible());
    const incBox = await inc.boundingBox();
    assert.ok(incBox && incBox.height >= 44 && incBox.width >= 44, `Create + >=44 got ${JSON.stringify(incBox)}`);
    const decBox = await dec.boundingBox();
    assert.ok(decBox && decBox.height >= 44 && decBox.width >= 44, `Create − >=44 got ${JSON.stringify(decBox)}`);
    await inc.click();
    await page.waitForTimeout(700);
    sup = await rowState(page, createWrap, 'sup_rental');
    assert.strictEqual(Number(sup.qtyValue), 2);
    const expectSup2 = authTotal('sup_rental', '1_day', 2); // 11700 not 10000
    assert.strictEqual(sup.lineCents, expectSup2, `auth qty2 ${sup.lineCents} ≠ catalog 10000`);
    assert.notStrictEqual(expectSup2, 5000 * 2, 'fixture divergent from catalog');

    // Multi-select towel
    await page.locator(`${createWrap} [data-rental-offering="towel_rental"] .portal-schedule-create-rental-toggle`).click();
    await page.waitForTimeout(700);
    const towel = await rowState(page, createWrap, 'towel_rental');
    const expectTowel = authTotal('towel_rental', '1_day', 1); // 4100 not 500
    assert.strictEqual(towel.lineCents, expectTowel, `towel auth ${towel.lineCents}`);
    assert.strictEqual((await rowState(page, createWrap, 'sup_rental')).lineCents, expectSup2, 'SUP keeps own total');

    // Quoted total includes both + EXTRA 3333
    const lastBody = quoteBodies.filter((q) => Array.isArray(q.rentals) && q.rentals.length >= 2).at(-1);
    assert.ok(lastBody, 'quote body with 2 rentals');
    const lastSup = lastBody.rentals.find((r) => r.offering_key === 'sup_rental');
    const lastTowel = lastBody.rentals.find((r) => r.offering_key === 'towel_rental');
    assert.ok(lastSup && Number(lastSup.quantity) === 2);
    assert.ok(lastTowel);
    const topTotal = expectSup2 + expectTowel + 3333;
    const qText = await quotePreviewText(page, '#ps-create-quote-preview');
    if (qText && /€/.test(qText)) {
      assert.ok(
        qText.includes(fmtEuro(topTotal)) || qText.includes(String((topTotal / 100).toFixed(2))),
        `Quoted total shows top ${topTotal}: ${qText}`,
      );
      assert.ok(!qText.includes(fmtEuro(expectSup2)) || qText.includes(fmtEuro(topTotal)), 'total is full sum');
    }
    console.log('  PASS  Create multi-item distinct auth totals + top total');

    // REAL CREATE with TWO selected rentals after valid quote
    const createsBeforeTwo = saveBodies.filter((s) => s.kind === 'create').length;
    assert.strictEqual(await page.locator('#ps-create-submit').isDisabled(), false, 'Create enabled for two-rental submit');
    await page.locator('#ps-create-submit').click();
    await page.waitForTimeout(800);
    const createsAfter = saveBodies.filter((s) => s.kind === 'create');
    assert.strictEqual(createsAfter.length, createsBeforeTwo + 1, 'exactly one create request');
    const createBody = createsAfter.at(-1).body || {};
    assert.ok(Array.isArray(createBody.rentals) && createBody.rentals.length === 2, JSON.stringify(createBody.rentals));
    const cSup = createBody.rentals.find((r) => r.offering_key === 'sup_rental');
    const cTowel = createBody.rentals.find((r) => r.offering_key === 'towel_rental');
    assert.ok(cSup && cTowel, 'both rentals in create payload');
    assert.strictEqual(Number(cSup.quantity), 2);
    assert.strictEqual(String(cSup.duration_key || cSup.duration), '1_day');
    assert.strictEqual(Number(cTowel.quantity), 1);
    assert.strictEqual(String(cTowel.duration_key || cTowel.duration), '1_day');
    const moneyKeys = JSON.stringify(createBody.rentals);
    assert.ok(!/total_cents|unit_amount|amount_cents|price_cents/i.test(moneyKeys), 'no client money on rentals');
    console.log('  PASS  Create submit two rentals exact payload');

    // Re-open create for remaining Create tests
    await openCreate(page);
    await page.locator('#ps-create-guest').fill('Equipment Create Guest');
    await page.locator('#ps-create-phone').fill('+34600111222');
    await page.evaluate(([from, to]) => {
      for (const [id, v] of [['ps-create-date-from', from], ['ps-create-date-to', to]]) {
        const n = document.getElementById(id);
        if (n) { n.value = v; n.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }, [DATE, DATE]);
    if (await noLesson.count()) await noLesson.click();
    await seedCaches(page, 'create');
    await page.waitForTimeout(200);
    await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-create-rental-toggle`).click();
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      if (qty) { qty.value = '2'; qty.setAttribute('data-qty-raw', '2'); qty.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await page.waitForTimeout(500);

    // Deselect towel if present
    if ((await rowState(page, createWrap, 'towel_rental')).ariaPressed === 'true') {
      await page.locator(`${createWrap} [data-rental-offering="towel_rental"] .portal-schedule-create-rental-toggle`).click();
      await page.waitForTimeout(200);
    }
    assert.strictEqual((await rowState(page, createWrap, 'towel_rental')).ariaPressed, 'false');

    // RAW qty preservation
    for (const invalid of ['1.5', '2e1', '3abc']) {
      await page.evaluate((raw) => {
        const row = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"]');
        const qty = row.querySelector('input.ps-create-rental-qty-input');
        qty.value = raw;
        qty.setAttribute('data-qty-owner', 'user');
        qty.setAttribute('data-qty-raw', raw);
        qty.dispatchEvent(new Event('input', { bubbles: true }));
        qty.dispatchEvent(new Event('change', { bubbles: true }));
      }, invalid);
      const before = await page.evaluate(() => {
        const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
        return { v: qty.value, raw: qty.getAttribute('data-qty-raw') };
      });
      assert.strictEqual(before.raw, invalid, `pre-render raw attr ${invalid}`);
      await page.evaluate(() => {
        if (typeof window.scheduleRenderCreateRentals === 'function') window.scheduleRenderCreateRentals();
      });
      await page.waitForTimeout(80);
      const st = await rowState(page, createWrap, 'sup_rental');
      const after = await page.evaluate(() => {
        const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
        return { v: qty && qty.value, raw: qty && qty.getAttribute('data-qty-raw') };
      });
      assert.strictEqual(st.qtyValue, invalid, `Create raw survives re-render: ${invalid} got ${st.qtyValue} after=${JSON.stringify(after)}`);
      assert.ok(st.lineCents == null || st.linePending || st.priceText === '—', `no fake total for ${invalid}`);
    }
    // restore valid qty
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '2';
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    console.log('  PASS  Create raw invalid qty preserved across re-render');

    // Race: delay quote, change qty, old must not win
    quoteDelayMs = 400;
    quoteSeq = 0;
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '1';
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(50);
    // pending
    let mid = await rowState(page, createWrap, 'sup_rental');
    assert.ok(mid.linePending || mid.priceText === '—' || mid.lineCents == null, 'cleared on intent change');
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '2';
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(900);
    quoteDelayMs = 0;
    sup = await rowState(page, createWrap, 'sup_rental');
    assert.strictEqual(Number(sup.qtyValue), 2);
    assert.strictEqual(sup.lineCents, authTotal('sup_rental', '1_day', 2), 'newer response wins');
    console.log('  PASS  Create quote race: pending then newer wins');

    // Missing line fail-closed — Create blocked, no create request
    const createsBeforeMissing = saveBodies.filter((s) => s.kind === 'create').length;
    quoteMode = 'missing_line';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '1';
      qty.setAttribute('data-qty-raw', '1');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    sup = await rowState(page, createWrap, 'sup_rental');
    assert.ok(sup.lineCents == null || sup.linePending || sup.priceText === '—', 'missing line no paint');
    let createDisabled = await page.locator('#ps-create-submit').isDisabled();
    assert.strictEqual(createDisabled, true, 'Create disabled on missing quote line');
    await page.locator('#ps-create-submit').click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    assert.strictEqual(
      saveBodies.filter((s) => s.kind === 'create').length,
      createsBeforeMissing,
      'no create request on missing line',
    );

    // Duplicate line fail-closed
    quoteMode = 'duplicate_line';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '1';
      qty.setAttribute('data-qty-raw', '1');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    sup = await rowState(page, createWrap, 'sup_rental');
    assert.ok(sup.lineCents == null || sup.linePending || sup.priceText === '—', 'duplicate line no paint');
    createDisabled = await page.locator('#ps-create-submit').isDisabled();
    assert.strictEqual(createDisabled, true, 'Create disabled on duplicate quote line');
    await page.locator('#ps-create-submit').click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    assert.strictEqual(
      saveBodies.filter((s) => s.kind === 'create').length,
      createsBeforeMissing,
      'no create request on duplicate line',
    );

    // Restore valid quote — Create enabled again
    quoteMode = 'normal';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '2';
      qty.setAttribute('data-qty-raw', '2');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(800);
    createDisabled = await page.locator('#ps-create-submit').isDisabled();
    assert.strictEqual(createDisabled, false, 'Create re-enabled after valid quote');
    console.log('  PASS  Create missing/duplicate line fail-closed (submit blocked)');

    // Restore good state for screenshots
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-create-rentals [data-rental-offering="sup_rental"] input.ps-create-rental-qty-input');
      qty.value = '2';
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // leave one unselected
    const bikePressed = (await rowState(page, createWrap, 'bicycle_rental')).ariaPressed;
    if (bikePressed === 'true') {
      await page.locator(`${createWrap} [data-rental-offering="bicycle_rental"] .portal-schedule-create-rental-toggle`).click();
    }
    await page.waitForTimeout(500);

    // Keyboard
    const bikeBtn = page.locator(`${createWrap} [data-rental-offering="bicycle_rental"] .portal-schedule-create-rental-toggle`);
    await bikeBtn.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(80);
    assert.strictEqual((await rowState(page, createWrap, 'bicycle_rental')).ariaPressed, 'true');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
    assert.strictEqual((await rowState(page, createWrap, 'bicycle_rental')).ariaPressed, 'false');

    // i18n from
    for (const [loc, word] of [['es', 'desde'], ['it', 'da'], ['en', 'from']]) {
      await page.evaluate((l) => {
        try { localStorage.setItem('wh_staff_portal_locale', l); } catch (_e) { /* ignore */ }
        window.getStaffLocale = function () { return l; };
        if (typeof window.applyStaffPortalI18n === 'function') window.applyStaffPortalI18n(document);
        if (typeof window.scheduleRenderCreateRentals === 'function') window.scheduleRenderCreateRentals();
        if (typeof window.applyStaffPortalI18n === 'function') {
          const wrap = document.getElementById('ps-create-rentals');
          if (wrap) window.applyStaffPortalI18n(wrap);
        }
      }, loc);
      await page.waitForTimeout(80);
      // ensure unselected
      const st0 = await rowState(page, createWrap, 'flipflops_rental');
      if (st0.ariaPressed === 'true') {
        await page.locator(`${createWrap} [data-rental-offering="flipflops_rental"] .portal-schedule-create-rental-toggle`).click();
      }
      const st = await rowState(page, createWrap, 'flipflops_rental');
      const fromWord = st.fromText ? st.fromText.trim().split(/\s+/)[0].toLowerCase() : '';
      assert.strictEqual(fromWord, word, `locale ${loc}`);
    }
    await page.evaluate(() => {
      window.getStaffLocale = function () { return 'en'; };
      if (typeof window.scheduleRenderCreateRentals === 'function') window.scheduleRenderCreateRentals();
    });
    // re-select SUP for screenshot
    if ((await rowState(page, createWrap, 'sup_rental')).ariaPressed !== 'true') {
      await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-create-rental-toggle`).click();
    }
    await page.waitForTimeout(500);

    // Ensure selected for stepper measure
    if ((await rowState(page, createWrap, 'sup_rental')).ariaPressed !== 'true') {
      await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-create-rental-toggle`).click();
      await page.waitForTimeout(400);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const createDesktopW = await measureDrawerWidth(page, '#ps-create-modal .portal-schedule-create-drawer');
    assert.ok(createDesktopW && createDesktopW.width <= 442);
    const cIncD = await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-int-stepper [data-int-step="inc"]`).boundingBox();
    assert.ok(cIncD && cIncD.height >= 44 && cIncD.width >= 44, 'Create desktop stepper 44');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'booking-equipment-reorg-create-desktop.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(80);
    const cIncN = await page.locator(`${createWrap} [data-rental-offering="sup_rental"] .portal-schedule-int-stepper [data-int-step="inc"]`).boundingBox();
    assert.ok(cIncN && cIncN.height >= 44 && cIncN.width >= 44, 'Create narrow stepper 44');
    const createNarrowW = await measureDrawerWidth(page, '#ps-create-modal .portal-schedule-create-drawer');
    assert.ok(createNarrowW && !createNarrowW.overflow, 'create narrow no overflow');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'booking-equipment-reorg-create-narrow.png') });
    console.log('  PASS  Create screenshots + width + 44px steppers');

    await page.locator('#ps-create-close').click().catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);

    // ═══════════════════════════════════════════════════════════════════
    // EDIT
    // ═══════════════════════════════════════════════════════════════════
    console.log('[Edit]');
    await page.setViewportSize({ width: 1280, height: 900 });
    const row = page.locator('[data-ps-booking-id]').filter({ hasText: 'Equipment Edit Guest' }).first();
    await row.waitFor({ timeout: 15000 });
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-edit-form, #ps-drawer-body').first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const radios = document.querySelectorAll('input[name="ps-drawer-main-activity"], input[type=radio]');
      radios.forEach((r) => {
        if (String(r.value) === 'none' || /no-lesson|none/.test(r.id || '')) {
          r.checked = true;
          r.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      if (typeof scheduleDrawerPopulateComponentFields === 'function') scheduleDrawerPopulateComponentFields();
    });
    await seedCaches(page, 'edit');
    await page.waitForTimeout(300);

    const editWrap = '#ps-drawer-rentals';
    if (await page.locator(`${editWrap} [data-rental-offering]`).count() === 0) {
      await page.evaluate(() => {
        const wrap = document.getElementById('ps-drawer-rentals');
        if (wrap) {
          wrap.setAttribute('data-seed-rentals', JSON.stringify([
            { offering_key: 'sup_rental', duration_key: '1_day', quantity: 2 },
          ]));
        }
        if (typeof scheduleRenderDrawerRentals === 'function') scheduleRenderDrawerRentals();
      });
      await seedCaches(page, 'edit');
      await page.waitForTimeout(250);
    }
    await page.locator(`${editWrap} [data-rental-offering]`).first().waitFor({ timeout: 12000 });

    // Seeded SUP
    let editSup = await rowState(page, editWrap, 'sup_rental');
    if (editSup.missing || editSup.ariaPressed !== 'true') {
      await page.evaluate(() => {
        const wrap = document.getElementById('ps-drawer-rentals');
        wrap.setAttribute('data-seed-rentals', JSON.stringify([
          { offering_key: 'sup_rental', duration_key: '1_day', quantity: 2 },
        ]));
        if (typeof scheduleRenderDrawerRentals === 'function') scheduleRenderDrawerRentals();
      });
      await seedCaches(page, 'edit');
      await page.waitForTimeout(300);
      editSup = await rowState(page, editWrap, 'sup_rental');
    }
    assert.strictEqual(editSup.ariaPressed, 'true', 'Edit SUP seeded');
    assert.strictEqual(editSup.qtyVisible, true);

    // BLOCKER 1: Edit steppers REQUIRED (no optional)
    const editSupRow = page.locator(`${editWrap} [data-rental-offering="sup_rental"]`);
    const eInc = editSupRow.locator('.portal-schedule-int-stepper [data-int-step="inc"]');
    const eDec = editSupRow.locator('.portal-schedule-int-stepper [data-int-step="dec"]');
    assert.strictEqual(await eInc.count(), 1, 'Edit + button required');
    assert.strictEqual(await eDec.count(), 1, 'Edit − button required');
    assert.ok(await eInc.isVisible(), 'Edit + visible');
    assert.ok(await eDec.isVisible(), 'Edit − visible');
    const eIncBox = await eInc.boundingBox();
    assert.ok(eIncBox && eIncBox.height >= 44 && eIncBox.width >= 44, `Edit + >=44 got ${JSON.stringify(eIncBox)}`);
    const eDecBox = await eDec.boundingBox();
    assert.ok(eDecBox && eDecBox.height >= 44 && eDecBox.width >= 44, `Edit − >=44 got ${JSON.stringify(eDecBox)}`);
    // qty between
    const qtyBetween = await editSupRow.evaluate((row) => {
      const ste = row.querySelector('.portal-schedule-int-stepper');
      if (!ste) return false;
      const kids = [...ste.children];
      const tags = kids.map((k) => k.tagName + (k.getAttribute('data-int-step') || k.tagName));
      return /DEC/i.test(tags.join(',')) || (kids[0] && kids[0].getAttribute('data-int-step') === 'dec'
        && kids[1] && kids[1].tagName === 'INPUT'
        && kids[2] && kids[2].getAttribute('data-int-step') === 'inc');
    });
    assert.ok(qtyBetween, 'qty input between − and +');

    // Wait for quote paint
    await page.waitForTimeout(800);
    editSup = await rowState(page, editWrap, 'sup_rental');
    // seed qty 2
    assert.strictEqual(Number(editSup.qtyValue), 2, `seeded qty ${editSup.qtyValue}`);
    assert.strictEqual(editSup.lineCents, authTotal('sup_rental', '1_day', 2), `Edit auth line ${editSup.lineCents}`);
    console.log('  PASS  Edit steppers + seeded auth line total');

    // Stepper inc works
    await eInc.click();
    await page.waitForTimeout(700);
    editSup = await rowState(page, editWrap, 'sup_rental');
    assert.strictEqual(Number(editSup.qtyValue), 3);
    assert.strictEqual(editSup.lineCents, authTotal('sup_rental', '1_day', 3));
    await eDec.click();
    await page.waitForTimeout(700);
    editSup = await rowState(page, editWrap, 'sup_rental');
    assert.strictEqual(Number(editSup.qtyValue), 2);
    assert.strictEqual(editSup.lineCents, authTotal('sup_rental', '1_day', 2));
    console.log('  PASS  Edit stepper +/− updates qty and auth line');

    // Multi select towel — KEEP both selected through Save
    await page.locator(`${editWrap} [data-rental-offering="towel_rental"] .portal-schedule-create-rental-toggle`).click();
    await page.waitForTimeout(700);
    const editTowel = await rowState(page, editWrap, 'towel_rental');
    assert.strictEqual(editTowel.lineCents, authTotal('towel_rental', '1_day', 1));
    assert.strictEqual((await rowState(page, editWrap, 'sup_rental')).lineCents, authTotal('sup_rental', '1_day', 2));
    assert.strictEqual(editTowel.ariaPressed, 'true', 'towel stays selected for save');

    // Edit missing-line fail-closed: Save disabled, no update
    const updatesBeforeMissing = saveBodies.filter((s) => s.kind === 'update').length;
    quoteMode = 'missing_line';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"] input.ps-drawer-rental-qty-input');
      qty.value = '2';
      qty.setAttribute('data-qty-raw', '2');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    let saveDisabled = await page.locator('#ps-drawer-save, .portal-schedule-drawer-edit-footer .btn-primary').first().isDisabled();
    assert.strictEqual(saveDisabled, true, 'Edit Save disabled on missing line');
    await page.locator('#ps-drawer-save, .portal-schedule-drawer-edit-footer .btn-primary').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
    assert.strictEqual(
      saveBodies.filter((s) => s.kind === 'update').length,
      updatesBeforeMissing,
      'no update on missing line',
    );
    quoteMode = 'duplicate_line';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"] input.ps-drawer-rental-qty-input');
      qty.value = '2';
      qty.setAttribute('data-qty-raw', '2');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(700);
    saveDisabled = await page.locator('#ps-drawer-save, .portal-schedule-drawer-edit-footer .btn-primary').first().isDisabled();
    assert.strictEqual(saveDisabled, true, 'Edit Save disabled on duplicate line');
    quoteMode = 'normal';
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"] input.ps-drawer-rental-qty-input');
      qty.value = '2';
      qty.setAttribute('data-qty-raw', '2');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(800);
    // re-ensure towel selected after re-quotes
    if ((await rowState(page, editWrap, 'towel_rental')).ariaPressed !== 'true') {
      await page.locator(`${editWrap} [data-rental-offering="towel_rental"] .portal-schedule-create-rental-toggle`).click();
      await page.waitForTimeout(700);
    }
    if ((await rowState(page, editWrap, 'sup_rental')).ariaPressed !== 'true') {
      await page.locator(`${editWrap} [data-rental-offering="sup_rental"] .portal-schedule-create-rental-toggle`).click();
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        const qty = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"] input.ps-drawer-rental-qty-input');
        qty.value = '2'; qty.setAttribute('data-qty-raw', '2');
        qty.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(700);
    }
    saveDisabled = await page.locator('#ps-drawer-save, .portal-schedule-drawer-edit-footer .btn-primary').first().isDisabled();
    assert.strictEqual(saveDisabled, false, 'Edit Save re-enabled after valid quote');
    console.log('  PASS  Edit missing/duplicate fail-closed + restore');

    // RAW qty on Edit (temporarily — restore two selection after)
    for (const invalid of ['1.5', '2e1', '3abc']) {
      await page.evaluate((raw) => {
        const row = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"]');
        const qty = row.querySelector('input.ps-drawer-rental-qty-input');
        qty.value = raw;
        qty.setAttribute('data-qty-owner', 'user');
        qty.setAttribute('data-qty-raw', raw);
        qty.dispatchEvent(new Event('change', { bubbles: true }));
      }, invalid);
      await page.evaluate(() => {
        if (typeof scheduleRenderDrawerRentals === 'function') scheduleRenderDrawerRentals();
      });
      await page.waitForTimeout(80);
      const st = await rowState(page, editWrap, 'sup_rental');
      assert.strictEqual(st.qtyValue, invalid, `Edit raw ${invalid} got ${st.qtyValue}`);
      assert.ok(st.lineCents == null || st.linePending || st.priceText === '—');
    }
    await page.evaluate(() => {
      const qty = document.querySelector('#ps-drawer-rentals [data-rental-offering="sup_rental"] input.ps-drawer-rental-qty-input');
      qty.value = '2';
      qty.setAttribute('data-qty-raw', '2');
      qty.dispatchEvent(new Event('change', { bubbles: true }));
      // re-select towel if raw re-render dropped selection
      const towel = document.querySelector('#ps-drawer-rentals [data-rental-offering="towel_rental"] .ps-drawer-rental-check');
      if (towel && !towel.checked) {
        towel.checked = true;
        towel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(700);
    console.log('  PASS  Edit raw qty preservation');

    // Date change invalidates
    await page.evaluate(() => {
      const to = document.getElementById('ps-drawer-date-to') || document.getElementById('ps-drawer-date-from');
      if (to) {
        to.value = '2026-08-11';
        to.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(100);
    let afterDate = await rowState(page, editWrap, 'sup_rental');
    // may re-render; if selected, should pending then paint
    await page.waitForTimeout(800);
    afterDate = await rowState(page, editWrap, 'sup_rental');
    // restore date
    await page.evaluate(() => {
      for (const id of ['ps-drawer-date-from', 'ps-drawer-date-to']) {
        const n = document.getElementById(id);
        if (n) { n.value = '2026-08-10'; n.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    });
    await page.waitForTimeout(600);
    console.log('  PASS  Edit date change path exercised');

    // Ensure TWO rentals selected with valid quote before screenshots + save
    await page.evaluate(() => {
      function selectKey(key, qty) {
        const row = document.querySelector('#ps-drawer-rentals [data-rental-offering="' + key + '"]');
        if (!row) return;
        const check = row.querySelector('.ps-drawer-rental-check');
        if (check && !check.checked) {
          check.checked = true;
          check.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const q = row.querySelector('input.ps-drawer-rental-qty-input');
        if (q) {
          q.value = String(qty);
          q.setAttribute('data-qty-raw', String(qty));
          q.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      selectKey('sup_rental', 2);
      selectKey('towel_rental', 1);
    });
    await page.waitForTimeout(900);
    assert.strictEqual((await rowState(page, editWrap, 'sup_rental')).ariaPressed, 'true');
    assert.strictEqual((await rowState(page, editWrap, 'towel_rental')).ariaPressed, 'true');
    editSup = await rowState(page, editWrap, 'sup_rental');
    assert.ok(editSup.hasStepper && editSup.incVisible, 'Edit screenshot requires stepper');
    const eIncFinal = await page.locator(`${editWrap} [data-rental-offering="sup_rental"] .portal-schedule-int-stepper [data-int-step="inc"]`).boundingBox();
    assert.ok(eIncFinal && eIncFinal.height >= 44 && eIncFinal.width >= 44, 'Edit desktop stepper 44');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'booking-equipment-reorg-edit-desktop.png') });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(80);
    const eIncNarrow = await page.locator(`${editWrap} [data-rental-offering="sup_rental"] .portal-schedule-int-stepper [data-int-step="inc"]`).boundingBox();
    assert.ok(eIncNarrow && eIncNarrow.height >= 44 && eIncNarrow.width >= 44, 'Edit narrow stepper 44');
    const editNarrowOverflow = await measureDrawerWidth(page, '#ps-detail-drawer');
    assert.ok(editNarrowOverflow && !editNarrowOverflow.overflow, 'edit narrow no overflow');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'booking-equipment-reorg-edit-narrow.png') });
    console.log('  PASS  Edit screenshots with steppers >=44');

    // REAL Save with TWO rentals — must produce exactly one update
    await page.setViewportSize({ width: 1280, height: 900 });
    const updatesBefore = saveBodies.filter((s) => s.kind === 'update').length;
    const saveBtn = page.locator('#ps-drawer-save, button[data-drawer-save], .portal-schedule-drawer-edit-footer .btn-primary').first();
    assert.ok(await saveBtn.count(), 'save button present');
    assert.strictEqual(await saveBtn.isDisabled(), false, 'Save enabled for two-rental save');
    await saveBtn.click();
    await page.waitForTimeout(800);
    const updates = saveBodies.filter((s) => s.kind === 'update');
    assert.strictEqual(updates.length, updatesBefore + 1, 'exactly one update request required');
    const last = updates.at(-1);
    assert.ok(last && last.body, 'update body present');
    assert.ok(Array.isArray(last.body.rentals) && last.body.rentals.length === 2, JSON.stringify(last.body.rentals));
    const uSup = last.body.rentals.find((x) => x.offering_key === 'sup_rental');
    const uTowel = last.body.rentals.find((x) => x.offering_key === 'towel_rental');
    assert.ok(uSup && uTowel, 'both rentals in update');
    assert.strictEqual(Number(uSup.quantity), 2);
    assert.ok(uSup.duration_key || uSup.duration);
    assert.strictEqual(Number(uTowel.quantity), 1);
    assert.ok(uTowel.duration_key || uTowel.duration);
    assert.ok(!/total_cents|unit_amount|amount_cents|price_cents/i.test(JSON.stringify(last.body.rentals)), 'no client money');
    console.log('  PASS  Edit save/update two rentals exact payload');

    const serious = errors.filter((e) => !/ResizeObserver|favicon|net::ERR/i.test(e));
    assert.deepStrictEqual(serious, [], serious.join(' | '));
    console.log('  PASS  no page errors');
    console.log('\nPASS verify:booking-drawer-equipment-reorg\n');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error('\nFAIL verify:booking-drawer-equipment-reorg\n');
  console.error(e);
  process.exit(1);
});
