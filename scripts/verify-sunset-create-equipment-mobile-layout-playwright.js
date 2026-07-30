'use strict';

/**
 * verify:sunset-create-equipment-mobile-layout-playwright
 *
 * RED→GREEN layout gate for Sunset Booking Create drawer equipment rows at
 * narrow mobile widths (320 / 390 / 430). Uses production-generated UI and
 * real mode/course button transitions; asserts bounding rectangles (not source
 * regex alone):
 *   - equipment name readable (not clipped)
 *   - rental-duration select, amount, Surfers qty non-overlapping
 *   - row + catalog container no document/card overflow
 *   - first row fully visible within create body (not partially hidden)
 *
 * Scenarios: standalone-rental-only, Group, Private, course-selected Group,
 * one item and multiple items.
 *
 * Run: node scripts/verify-sunset-create-equipment-mobile-layout-playwright.js
 *      npm run verify:sunset-create-equipment-mobile-layout-playwright
 */

const assert = require('assert');

process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';

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

const WIDTHS = [320, 390, 430];
const TOL = 1.5;
// Desktop sanity: wrap may engage but controls must still not overlap/clip.
const DESKTOP_WIDTH = 1280;

const RENTAL_OFFERINGS = [
  {
    offering_key: 'towel_rental',
    label: 'Towel',
    active: true,
    location_id: 'sunset-somo',
    excludes: [],
  },
  {
    offering_key: 'poncho_rental',
    label: 'Long carbon surfboard rental pack',
    active: true,
    location_id: 'sunset-somo',
    excludes: [],
  },
];

const RENTAL_PRICES = [
  {
    category: 'rental',
    offering_key: 'towel_rental__12_hours',
    item_code: 'towel_rental__12_hours',
    unit: 'session',
    amount_cents: 500,
    active: true,
    location_id: 'sunset-somo',
    label: 'Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'towel_rental__1_day',
    item_code: 'towel_rental__1_day',
    unit: 'day',
    amount_cents: 800,
    active: true,
    location_id: 'sunset-somo',
    label: 'Towel',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'poncho_rental__4_hours',
    item_code: 'poncho_rental__4_hours',
    unit: 'session',
    amount_cents: 300,
    active: true,
    location_id: 'sunset-somo',
    label: 'Long carbon surfboard rental pack',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
  {
    category: 'rental',
    offering_key: 'poncho_rental__1_day',
    item_code: 'poncho_rental__1_day',
    unit: 'day',
    amount_cents: 1200,
    active: true,
    location_id: 'sunset-somo',
    label: 'Long carbon surfboard rental pack',
    client_slug: 'sunset',
    tenant: 'sunset',
  },
];

const COURSE_OPTIONS = [
  { offering_key: 'carbon_fins', label: 'Carbon fins' },
  { offering_key: 'reef_helmet', label: 'Reef helmet long label' },
];

async function measureRentalLayout(page) {
  return page.evaluate((tol) => {
    function box(el) {
      if (!el || !el.getBoundingClientRect) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 && r.height <= 0) return null;
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
      };
    }
    function overlap(a, b) {
      if (!a || !b) return false;
      return !(
        a.right <= b.left + tol
        || b.right <= a.left + tol
        || a.bottom <= b.top + tol
        || b.bottom <= a.top + tol
      );
    }
    function inside(inner, outer) {
      if (!inner || !outer) return true;
      return (
        inner.left >= outer.left - tol
        && inner.right <= outer.right + tol
        && inner.top >= outer.top - tol
        && inner.bottom <= outer.bottom + tol
      );
    }

    const drawer = document.querySelector('#ps-create-modal .portal-schedule-create-drawer')
      || document.querySelector('#ps-create-modal');
    const body = document.querySelector('#ps-create-modal .portal-schedule-create-body');
    const wrap = document.querySelector('#ps-create-rentals');
    if (!wrap || !drawer) {
      return { ok: false, reason: 'missing_rentals_or_drawer' };
    }

    const drawerBox = box(drawer);
    const bodyBox = box(body);
    const wrapBox = box(wrap);
    const docOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const drawerOverflow = drawer.scrollWidth > drawer.clientWidth + 1;
    const wrapOverflow = wrap.scrollWidth > wrap.clientWidth + 1;
    const bodyOverflowX = body ? body.scrollWidth > body.clientWidth + 1 : false;

    const rows = [...wrap.querySelectorAll('.portal-schedule-create-rental-row')];
    const rowReports = rows.map((row, idx) => {
      const check = row.querySelector('.portal-schedule-create-check');
      const nameSpan = check && check.querySelector('span');
      const durLabel = row.querySelector('.portal-schedule-create-rental-duration-label');
      const durSel = row.querySelector('select.ps-create-rental-duration');
      const price = row.querySelector('.portal-schedule-create-rental-price');
      const qty = row.querySelector('.portal-schedule-create-rental-qty');
      const qtyVisible = qty && qty.offsetParent !== null
        && getComputedStyle(qty).display !== 'none'
        && getComputedStyle(qty).visibility !== 'hidden';

      const rowBox = box(row);
      const checkBox = box(check);
      const nameBox = box(nameSpan);
      const durBox = box(durSel || durLabel);
      const priceBox = box(price);
      const qtyBox = qtyVisible ? box(qty) : null;

      const nameClipped = !!(nameSpan && (
        nameSpan.scrollWidth > nameSpan.clientWidth + 2
        || (nameBox && checkBox && nameBox.right > checkBox.right + 2)
      ));

      const parts = [
        ['check', checkBox],
        ['duration', durBox],
        ['price', priceBox],
        ['qty', qtyBox],
      ].filter(([, b]) => b);

      const overlaps = [];
      for (let i = 0; i < parts.length; i += 1) {
        for (let j = i + 1; j < parts.length; j += 1) {
          if (overlap(parts[i][1], parts[j][1])) {
            overlaps.push(`${parts[i][0]}×${parts[j][0]}`);
          }
        }
      }

      const outsideRow = parts
        .filter(([, b]) => !inside(b, rowBox))
        .map(([n]) => n);

      // Clip/collapse (not scroll-fold): row horizontally outside body/drawer,
      // or row height collapsed while controls exist. Vertical off-screen inside
      // the scrollable create body is expected when course gear sits above.
      let partiallyHidden = false;
      if (rowBox && bodyBox) {
        if (rowBox.left < bodyBox.left - 2 || rowBox.right > bodyBox.right + 2) {
          partiallyHidden = true;
        }
      }
      if (rowBox && drawerBox) {
        if (rowBox.left < drawerBox.left - 2 || rowBox.right > drawerBox.right + 2) {
          partiallyHidden = true;
        }
      }
      if (rowBox && rowBox.height > 0 && rowBox.height < 28 && parts.length >= 2) {
        partiallyHidden = true;
      }

      // Controls must remain readable heights
      const thin = parts.some(([, b]) => b.height > 0 && b.height < 18);

      return {
        key: row.getAttribute('data-rental-offering') || String(idx),
        idx,
        nameClipped,
        overlaps,
        outsideRow,
        partiallyHidden,
        thin,
        checked: !!(check && check.querySelector('input') && check.querySelector('input').checked),
        hasDuration: !!durSel,
        hasPrice: !!price,
        hasQty: !!qtyBox,
        boxes: {
          row: rowBox,
          check: checkBox,
          duration: durBox,
          price: priceBox,
          qty: qtyBox,
        },
      };
    });

    // Course equipment items (Group/Private path)
    const ceField = document.querySelector('#ps-create-course-equipment');
    const ceVisible = ceField && ceField.offsetParent !== null && !ceField.hidden
      && getComputedStyle(ceField).display !== 'none';
    const ceItems = ceVisible
      ? [...ceField.querySelectorAll('.portal-schedule-course-equipment-item')]
      : [];
    const ceReports = ceItems.map((item, idx) => {
      const itemBox = box(item);
      const name = item.querySelector('.portal-schedule-course-equipment-name');
      const check = item.querySelector('label.portal-schedule-course-equipment-check');
      const nameBox = box(name);
      const checkBox = box(check);
      const nameClipped = !!(name && name.scrollWidth > name.clientWidth + 2);
      const overflow = item.scrollWidth > item.clientWidth + 1;
      const overlaps = [];
      if (nameBox && checkBox && overlap(nameBox, checkBox)
        && !(nameBox.left >= checkBox.right - tol || checkBox.left >= nameBox.right - tol)) {
        // Adjacent left-of is fine; only flag true area intersection that isn't edge-touch.
        const areaOverlap = Math.max(0, Math.min(nameBox.right, checkBox.right) - Math.max(nameBox.left, checkBox.left))
          * Math.max(0, Math.min(nameBox.bottom, checkBox.bottom) - Math.max(nameBox.top, checkBox.top));
        if (areaOverlap > 4) overlaps.push('check×name');
      }
      let partiallyHidden = false;
      if (itemBox && bodyBox) {
        if (itemBox.left < bodyBox.left - 2 || itemBox.right > bodyBox.right + 2) partiallyHidden = true;
      }
      if (itemBox && drawerBox) {
        if (itemBox.left < drawerBox.left - 2 || itemBox.right > drawerBox.right + 2) partiallyHidden = true;
      }
      if (itemBox && itemBox.height > 0 && itemBox.height < 28) partiallyHidden = true;
      return {
        idx,
        nameClipped,
        overflow,
        overlaps,
        partiallyHidden,
        outsideDrawer: itemBox && drawerBox ? !inside(itemBox, drawerBox) : false,
      };
    });

    const badRows = rowReports.filter((r) =>
      r.nameClipped
      || r.overlaps.length
      || r.outsideRow.length
      || r.partiallyHidden
      || r.thin);
    const badCe = ceReports.filter((r) =>
      r.nameClipped || r.overflow || r.overlaps.length || r.partiallyHidden || r.outsideDrawer);

    return {
      ok: !docOverflow && !drawerOverflow && !wrapOverflow && !bodyOverflowX
        && badRows.length === 0 && badCe.length === 0,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docOverflow,
      drawerOverflow,
      wrapOverflow,
      bodyOverflowX,
      drawerBox,
      wrapBox,
      rowCount: rows.length,
      rows: rowReports,
      ceCount: ceItems.length,
      ce: ceReports,
      badRows: badRows.map((r) => ({
        key: r.key,
        nameClipped: r.nameClipped,
        overlaps: r.overlaps,
        outsideRow: r.outsideRow,
        partiallyHidden: r.partiallyHidden,
        thin: r.thin,
      })),
      badCe,
    };
  }, TOL);
}

async function openCreate(page) {
  const modal = page.locator('#ps-create-modal');
  if (await modal.evaluate((el) => el && !el.hidden && getComputedStyle(el).display !== 'none').catch(() => false)) {
    // already open
  } else {
    await page.locator('#ps-create-booking').click();
  }
  await page.locator('#ps-create-guest').waitFor({ state: 'visible', timeout: 8000 });
}

async function fillBasics(page) {
  await page.locator('#ps-create-guest').fill('Mobile Layout Guest');
  await page.locator('#ps-create-phone').fill('+34600111222');
  await page.evaluate(() => {
    for (const [id, v] of [['ps-create-date-from', '2026-08-10'], ['ps-create-date-to', '2026-08-10']]) {
      const n = document.getElementById(id);
      n.value = v;
      n.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await page.locator('#ps-create-surfers').fill('2');
  await page.locator('#ps-create-surfers').blur();
}

async function seedRentalCaches(page) {
  await page.evaluate((payload) => {
    // eslint-disable-next-line no-undef
    if (typeof scheduleAdminPricesCache !== 'undefined') scheduleAdminPricesCache = payload.prices;
    // eslint-disable-next-line no-undef
    if (typeof scheduleRentalOfferingsCache !== 'undefined') {
      // eslint-disable-next-line no-undef
      scheduleRentalOfferingsCache = payload.offerings;
    }
    if (typeof scheduleRenderCreateRentals === 'function') scheduleRenderCreateRentals();
  }, {
    prices: RENTAL_PRICES,
    offerings: RENTAL_OFFERINGS,
  });
}

async function assertLayout(page, label, widths = WIDTHS) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    // Re-measure after reflow
    await page.waitForTimeout(80);
    const report = await measureRentalLayout(page);
    if (!report.ok) {
      const detail = JSON.stringify({
        label,
        width,
        docOverflow: report.docOverflow,
        drawerOverflow: report.drawerOverflow,
        wrapOverflow: report.wrapOverflow,
        bodyOverflowX: report.bodyOverflowX,
        badRows: report.badRows,
        badCe: report.badCe,
        rowCount: report.rowCount,
        ceCount: report.ceCount,
      }, null, 2);
      throw new Error(`layout FAIL ${label} @${width}px:\n${detail}`);
    }
    assert.ok(report.rowCount >= 1, `${label} @${width}: expected rental rows`);
    console.log(`  PASS  ${label} @${width}px rows=${report.rowCount} ce=${report.ceCount}`);
  }
}

(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

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
    body.private_lesson = {
      enabled: true,
      label: 'Private Course',
      default_duration_minutes: 120,
      equipment_options: COURSE_OPTIONS,
    };
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
      body: JSON.stringify({
        success: true,
        ok: true,
        courses: [{
          course_id: 'verify-mobile-group',
          label: 'Verifier Group',
          eligible_on_requested_dates: true,
          equipment_options: COURSE_OPTIONS,
          price_tiers: [{
            key: '1_day',
            label: '1 day',
            duration_days: 1,
            bookable: true,
            offering_id: 'surf_pack_verify-mobile-group__1_day',
          }],
        }],
        offerings: [{
          offering_type: 'private_lesson',
          offering_key: 'private',
          label: 'Private Course',
          equipment_options: COURSE_OPTIONS,
        }],
        rentals: [],
      }),
    });
  });

  await page.route('**/staff/schedule/bookings/quote?**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, total_cents: 0, subtotal_cents: 0, line_items: [] }),
    });
  });

  await page.route('**/staff/schedule/bookings?**', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        booking_id: '44444444-4444-4444-4444-444444444444',
        booking_code: 'MOBILE',
      }),
    });
  });

  let pass = 0;
  try {
    console.log('\nverify:sunset-create-equipment-mobile-layout-playwright\n');

    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await seedRentalCaches(page);

    // ── 1) Standalone rental-only (Equipment only / no lesson) ─────────────
    console.log('[1] Standalone rental-only — multi-item rows');
    await openCreate(page);
    await fillBasics(page);
    // Ensure equipment-only path
    const noLessonBtn = page.locator('[data-create-activity="ps-create-comp-no-lesson"]');
    if (await noLessonBtn.count()) {
      await noLessonBtn.click();
    }
    await seedRentalCaches(page);
    await page.waitForTimeout(150);
    const rentWrap = page.locator('#ps-create-rentals');
    await rentWrap.locator('[data-rental-offering="towel_rental"]').waitFor({ state: 'visible', timeout: 8000 });
    assert.strictEqual(await rentWrap.locator('.portal-schedule-create-rental-row').count(), 2, 'two rental items');

    // One item checked (shows duration + amount; Surfers hidden on equipment-only)
    await rentWrap.locator('[data-rental-offering="towel_rental"] input.ps-create-rental-check').check();
    await page.waitForTimeout(100);
    await assertLayout(page, 'standalone-rental-only one-checked');
    pass += WIDTHS.length;

    // Multiple items checked
    await rentWrap.locator('[data-rental-offering="poncho_rental"] input.ps-create-rental-check').check();
    await page.waitForTimeout(100);
    await assertLayout(page, 'standalone-rental-only multi-checked');
    pass += WIDTHS.length;

    // ── 2) Group (no course pick yet) — Surfers qty appears on checked rows ─
    console.log('\n[2] Group activity — rental rows with Surfers');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[data-create-activity="ps-create-comp-course"]').click();
    await page.waitForTimeout(150);
    await seedRentalCaches(page);
    // Re-check after re-render
    const towel = rentWrap.locator('[data-rental-offering="towel_rental"]');
    if (!(await towel.locator('input.ps-create-rental-check').isChecked())) {
      await towel.locator('input.ps-create-rental-check').check();
    }
    await page.waitForTimeout(100);
    // Surfers qty must be visible for Group+checked
    const qtyVisible = await towel.locator('.portal-schedule-create-rental-qty').evaluate((el) => {
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    });
    assert.strictEqual(qtyVisible, true, 'Group checked rental shows Surfers qty');
    await assertLayout(page, 'group-no-course rental+surfers');
    pass += WIDTHS.length;

    // ── 3) Course-selected Group — course equipment + rentals ──────────────
    console.log('\n[3] Course-selected Group — course equipment + rentals');
    await page.setViewportSize({ width: 1280, height: 900 });
    const courseBtn = page.locator('#ps-create-course-list [data-course-id]').first();
    await courseBtn.waitFor({ state: 'visible', timeout: 8000 });
    await courseBtn.click();
    await page.waitForTimeout(200);
    const ceField = page.locator('#ps-create-course-equipment');
    await ceField.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(await ceField.locator('.portal-schedule-course-equipment-item').count() >= 1);
    // Enable first course equipment item (mode buttons expand)
    const firstCe = ceField.locator('.portal-schedule-course-equipment-item').first();
    await firstCe.locator('input[type=checkbox]').check();
    await page.waitForTimeout(100);
    await seedRentalCaches(page);
    if (!(await towel.locator('input.ps-create-rental-check').isChecked())) {
      await towel.locator('input.ps-create-rental-check').check();
    }
    await page.waitForTimeout(100);
    await assertLayout(page, 'group-course-selected rental+CE');
    pass += WIDTHS.length;

    // ── 4) Private — transition + multi CE + rentals ───────────────────────
    console.log('\n[4] Private activity — multi CE + rentals');
    await page.setViewportSize({ width: 1280, height: 900 });
    // Back out of course drill-down if needed
    const back = page.locator('#ps-create-main-activity-back, [data-create-main-activity-back]');
    if (await back.count() && await back.isVisible().catch(() => false)) {
      await back.click();
      await page.waitForTimeout(100);
    }
    await page.locator('[data-create-activity="ps-create-comp-private-lesson"]').click();
    await page.waitForTimeout(200);
    await ceField.waitFor({ state: 'visible', timeout: 8000 });
    assert.strictEqual(await ceField.locator('.portal-schedule-course-equipment-item').count(), 2, 'Private two CE options');
    await ceField.locator('.portal-schedule-course-equipment-item').nth(0).locator('input[type=checkbox]').check();
    await ceField.locator('.portal-schedule-course-equipment-item').nth(1).locator('input[type=checkbox]').check();
    await page.waitForTimeout(100);
    await seedRentalCaches(page);
    const poncho = rentWrap.locator('[data-rental-offering="poncho_rental"]');
    if (!(await poncho.locator('input.ps-create-rental-check').isChecked())) {
      await poncho.locator('input.ps-create-rental-check').check();
    }
    if (!(await towel.locator('input.ps-create-rental-check').isChecked())) {
      await towel.locator('input.ps-create-rental-check').check();
    }
    await page.waitForTimeout(100);
    await assertLayout(page, 'private multi-CE multi-rental');
    pass += WIDTHS.length;

    // Desktop remains stable with same control model (no clip/overlap)
    console.log('\n[5] Desktop stability (1280) — same controls, no clip/overlap');
    await assertLayout(page, 'private multi-CE multi-rental desktop', [DESKTOP_WIDTH]);
    pass += 1;

    // Control model still present after mobile widths
    assert.strictEqual(await rentWrap.locator('select.ps-create-rental-duration').count() >= 1, true);
    assert.strictEqual(await rentWrap.locator('.portal-schedule-create-rental-price').count() >= 1, true);
    assert.strictEqual(await rentWrap.locator('.ps-create-rental-qty-input').count() >= 1, true);

    assert.deepStrictEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    console.log(`\nPASS equipment mobile layout gate (${pass} width-scenario asserts, 0 page errors)\n`);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
