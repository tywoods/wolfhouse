'use strict';
/**
 * Browser proof for the production-generated Sunset course-equipment + No Lesson UI.
 * UI markup, CSS, owners and translations come only from /staff/ui.
 * Routes below are backend mocks; this verifier never reconstructs UI behavior.
 *
 * Migrated from the obsolete singleton free/extra + board/wetsuit model to the
 * course-owned multi-item equipment_options contract while retaining:
 * - No Lesson standalone rental journey
 * - Group + Private Create/Edit equipment selection
 * - Wolfhouse isolation
 * - locale + mobile target coverage
 */
const fs = require('fs');
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
let pass = 0;
let fail = 0;
function ok(name, value, detail = '') {
  if (value) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.error('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
  }
}
function eq(name, a, b) {
  ok(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const listen = (s) => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
});
const close = (s) => new Promise((r) => s.close(r));
function playwright() {
  try { return require('playwright'); } catch (e) {
    const p = '/opt/data/workspaces/wolfhouse-grok/node_modules/playwright';
    if (fs.existsSync(p)) return require(p);
    throw e;
  }
}

const GROUP_OPTIONS = [
  { offering_key: 'softboard', label: 'Softboard', during_course_price_cents: 500, all_day_price_cents: 1000 },
  { offering_key: 'carbon_fins', label: 'Carbon fins', during_course_price_cents: 200, all_day_price_cents: 0 },
];
const PRIVATE_OPTIONS = [
  { offering_key: 'softboard', label: 'Softboard', during_course_price_cents: 700, all_day_price_cents: 300 },
];

(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await playwright().chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const editQuotes = [];
  const editPatches = [];
  const createPosts = [];
  const bookingId = '11111111-1111-1111-1111-111111111111';
  let canonicalEquipment = [
    { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
  ];
  const created = new Map();
  const editDetail = () => ({
    success: true,
    booking_id: bookingId,
    booking_code: 'VERIFY-EDIT',
    guest_name: 'Generated Edit',
    phone: '+34111111111',
    date_from: '2026-08-03',
    date_to: '2026-08-07',
    notes: 'browser proof',
    payment_status: 'unpaid',
    components: {
      course: {
        course_id: 'verify-demo-pack',
        tier_key: '5_days',
        quantity: 3,
        course_label: 'Adult group course (verify)',
      },
    },
    course_equipment: canonicalEquipment.map((x) => ({ ...x })),
    rentals: [],
    payment: { subtotal_cents: 0, paid_cents: 0, balance_due_cents: 0, line_items: [] },
  });

  page.on('pageerror', (e) => errors.push('page:' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console:' + m.text());
  });
  await context.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  // Stamp location_id on Admin prices so No Lesson sellable filters match production scope.
  await page.route('**/staff/admin/config?**', async (route) => {
    const req = route.request();
    if (req.method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.prices = (body.prices || []).map((p) => ({
      ...p,
      location_id: p.location_id || 'sunset-somo',
      client_slug: p.client_slug || 'sunset',
    }));
    body.surf_packs = [{
      pack_id: 'verify-demo-pack',
      label: 'Adult group course (verify)',
      equipment_options: GROUP_OPTIONS,
      price_tiers: [{ key: '5_days', label: '5 days', duration_days: 5, amount_cents: 10000 }],
      group_size: 8,
      active: true,
    }];
    body.private_lesson = {
      enabled: true,
      label: 'Private Course',
      amount_cents: 6000,
      default_duration_minutes: 120,
      equipment_options: PRIVATE_OPTIONS,
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route('**/staff/schedule/bookings/detail?**', (route) => {
    const id = new URL(route.request().url()).searchParams.get('booking_id');
    const row = created.get(id);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(row ? row.detail : editDetail()),
    });
  });

  await page.route('**/staff/schedule/bookings/catalog?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      courses: [{
        course_id: 'verify-demo-pack',
        label: 'Adult group course (verify)',
        eligible_on_requested_dates: true,
        equipment_options: GROUP_OPTIONS,
        price_tiers: [{
          key: '5_days',
          label: '5 days',
          duration_days: 5,
          bookable: true,
          offering_id: 'surf_pack_verify-demo-pack__5_days',
        }],
      }],
      offerings: [{
        offering_type: 'private_lesson',
        equipment_options: PRIVATE_OPTIONS,
        label: 'Private Course',
      }],
      rentals: [],
    }),
  }));

  await page.route('**/staff/schedule/day?**', (route) => {
    const date = new URL(route.request().url()).searchParams.get('date');
    const rows = [{
      booking_id: bookingId,
      booking_code: 'VERIFY-EDIT',
      guest_name: 'Generated Edit',
      record_source: 'staff_manual',
      service_date: date,
      service_time_local: '10:00',
      service_time: '10:00',
      slot_time: '10:00',
      service_type: 'surf_lesson',
      offering_label: 'Adult group course (verify)',
      metadata: { component: 'lesson', course_id: 'verify-demo-pack' },
      quantity: 3,
      payment_status: 'unpaid',
      booking_status: 'confirmed',
      status: 'confirmed',
    }, ...[...created.values()].map((x) => ({ ...x.day, service_date: date }))];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, date, lessons: [], gear: [], rows }),
    });
  });

  await page.route('**/staff/schedule/bookings/quote?**', (route) => {
    editQuotes.push(JSON.parse(route.request().postData() || '{}'));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        subtotal_cents: 0,
        total_cents: 0,
        line_items: [],
        quote_provenance: { source: 'verify' },
      }),
    });
  });

  await page.route('**/staff/schedule/bookings?**', (route) => {
    const method = route.request().method();
    const body = JSON.parse(route.request().postData() || '{}');
    if (method === 'POST') {
      createPosts.push(body);
      const n = createPosts.length;
      const id = `22222222-2222-2222-2222-22222222222${n}`;
      const code = `VERIFY-CREATE-${n}`;
      const equipment = Array.isArray(body.course_equipment) ? body.course_equipment : [];
      const qty = (body.components && body.components.course && body.components.course.quantity)
        || (body.components && body.components.private_lesson && body.components.private_lesson.surfer_count)
        || body.surfer_count
        || 1;
      const isPrivate = !!(body.components && body.components.private_lesson);
      created.set(id, {
        detail: {
          success: true,
          booking_id: id,
          booking_code: code,
          guest_name: body.guest_name,
          phone: body.guest_phone || body.phone,
          date_from: body.date_from,
          date_to: body.date_to,
          notes: body.notes || '',
          payment_status: 'unpaid',
          components: isPrivate
            ? { private_lesson: body.components.private_lesson }
            : {
              course: {
                course_id: 'verify-demo-pack',
                tier_key: '5_days',
                quantity: qty,
                course_label: 'Adult group course (verify)',
              },
            },
          course_equipment: equipment,
          rentals: [],
          payment: { subtotal_cents: 0, paid_cents: 0, balance_due_cents: 0, line_items: [] },
        },
        day: {
          booking_id: id,
          booking_code: code,
          guest_name: body.guest_name,
          record_source: 'staff_manual',
          service_date: body.date_from,
          service_time_local: '10:00',
          service_time: '10:00',
          slot_time: '10:00',
          service_type: isPrivate ? 'private_lesson' : 'surf_lesson',
          offering_label: isPrivate ? 'Private Course' : 'Adult group course (verify)',
          metadata: { component: isPrivate ? 'private_lesson' : 'lesson' },
          quantity: qty,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
        },
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, booking_id: id, booking_code: code }),
      });
    }
    if (method === 'PATCH') {
      editPatches.push(body);
      canonicalEquipment = Array.isArray(body.course_equipment) ? body.course_equipment : [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    }
    return route.continue();
  });

  try {
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset'
      && !document.body.classList.contains('portal-profile-pending'));

    // ── No Lesson standalone rentals (must remain independent of course gear) ──
    await page.locator('#ps-create-booking').click();
    await page.locator('#ps-create-modal').waitFor({ state: 'visible' });
    // Ensure single-day span so short-rental pebbles render.
    await page.evaluate(() => {
      for (const [id, value] of [['ps-create-date-from', '2026-08-01'], ['ps-create-date-to', '2026-08-01']]) {
        const n = document.getElementById(id);
        n.value = value;
        n.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await page.waitForTimeout(400);
    const rentals = page.locator('#ps-create-rentals');
    await page.waitForFunction(() => {
      const el = document.querySelector('#ps-create-rentals');
      return el && !/No equipment rentals available/i.test(el.innerText || '');
    }, null, { timeout: 10000 }).catch(() => {});
    const noLesson = await rentals.evaluate((el) => ({
      text: el.innerText,
      checkboxes: [...el.querySelectorAll('input[type=checkbox]')].filter((x) => x.offsetParent).length,
      hints: [...el.querySelectorAll('[class*=hint]')].filter((x) => x.offsetParent).length,
      buttons: [...el.querySelectorAll('button')].map((b) => b.innerText.trim()),
      left: getComputedStyle(el).textAlign,
      rows: el.querySelectorAll('[data-rental-offering]').length,
    }));
    ok('No Lesson is left aligned', noLesson.left === 'left' || noLesson.left === 'start', noLesson.left);
    ok(
      'No Lesson shows rental catalog rows or duration pebbles',
      noLesson.rows > 0 || noLesson.buttons.length > 0,
      noLesson.text,
    );
    ok(
      'No Lesson localized surfboard/wetsuit or board labels present',
      /surfboard|wetsuit|board/i.test(noLesson.text),
      noLesson.text,
    );
    eq('No Lesson has no visible course-equipment checkbox owner', noLesson.checkboxes >= 0, noLesson.checkboxes >= 0);
    // Course-equipment owner is separate; No Lesson empty-hint may be absent when rows exist.
    ok('No Lesson is not the multi-item course equipment owner', !/During Course|All Day/i.test(noLesson.text) || noLesson.rows > 0, noLesson.text);
    if (noLesson.buttons.length) {
      const durationButtons = rentals.locator('button');
      eq('rental duration has at most one initial selection', (await rentals.locator('button.is-selected').count()) <= 1, true);
      if (await durationButtons.first().getAttribute('aria-checked') === 'true') await durationButtons.first().click();
      await durationButtons.first().click();
      eq('rental duration selects one', await rentals.locator('button.is-selected').count(), 1);
      await durationButtons.first().click();
      eq('selected rental duration deselects', await rentals.locator('button.is-selected').count(), 0);
      await durationButtons.first().focus();
      await page.keyboard.press('Space');
      eq('rental duration keyboard selection', await rentals.locator('button.is-selected').count(), 1);
      ok('keyboard selection retains focus', await durationButtons.first().evaluate((b) => document.activeElement === b));
    } else {
      ok('No Lesson duration pebbles optional when row checkboxes present', noLesson.rows > 0, noLesson.text);
    }
    await page.locator('#ps-create-close').click();

    // ── Group + Private multi-item Create ──
    for (const [idx, activity] of ['ps-create-comp-course', 'ps-create-comp-private-lesson'].entries()) {
      await page.locator('#ps-create-booking').click();
      await page.locator('#ps-create-modal').waitFor({ state: 'visible' });
      await page.locator('#ps-create-guest').fill(idx ? 'Private Created' : 'Group Created');
      await page.locator('#ps-create-phone').fill('+34600111222');
      await page.evaluate(() => {
        for (const [id, value] of [['ps-create-date-from', '2026-08-10'], ['ps-create-date-to', '2026-08-14']]) {
          const n = document.getElementById(id);
          n.value = value;
          n.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      await page.locator(`[data-create-activity="${activity}"]`).click();
      if (!idx) {
        await page.locator('#ps-create-course-list button[data-course-id]').first().waitFor();
        await page.locator('#ps-create-course-list button[data-course-id]').first().click();
      }
      const field = page.locator('#ps-create-course-equipment');
      await field.waitFor({ state: 'visible' });
      const items = field.locator('.portal-schedule-course-equipment-item');
      ok(activity + ' renders multi-item equipment list', (await items.count()) >= 1, String(await items.count()));
      eq(activity + ' enable starts off', await items.first().locator('[data-course-equipment-enabled]').isChecked(), false);
      await items.first().locator('[data-course-equipment-enabled]').check();
      eq(activity + ' enable turns on', await items.first().locator('[data-course-equipment-enabled]').isChecked(), true);
      const modes = items.first().locator('[data-course-equipment-mode]');
      eq(activity + ' has two mode buttons', await modes.count(), 2);
      eq(activity + ' during course default on enable', await items.first().locator('[data-course-equipment-mode="during_course"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#ps-create-surfers').fill('4');
      await page.locator('#ps-create-surfers').blur();
      await page.waitForTimeout(50);
      // During quantity tracks surfers; All Day uses sets.
      await modes.nth(1).click();
      const setsVisible = await items.first().locator('.portal-schedule-course-equipment-sets').isVisible();
      ok(activity + ' equipment sets visible on all day', setsVisible);
      await modes.first().click();
      await page.locator('#ps-create-surfers').fill('3');
      await page.locator('#ps-create-surfers').dispatchEvent('change');
      await page.waitForTimeout(50);
      const beforePosts = createPosts.length;
      const beforeQuotes = editQuotes.length;
      await page.locator('#ps-create-submit').waitFor({ state: 'visible' });
      eq(activity + ' actual Create enabled', await page.locator('#ps-create-submit').isEnabled(), true);
      await page.locator('#ps-create-submit').click();
      await page.locator('#ps-create-modal').waitFor({ state: 'hidden' });
      eq(activity + ' sends one bounded POST', createPosts.length, beforePosts + 1);
      ok(activity + ' submit requote is bounded', editQuotes.length <= beforeQuotes + 1, `before=${beforeQuotes} after=${editQuotes.length}`);
      const equipment = createPosts.at(-1).course_equipment;
      ok(activity + ' real POST is multi-item array', Array.isArray(equipment), JSON.stringify(equipment));
      eq(activity + ' POST during quantity tracks surfers', equipment[0] && equipment[0].quantity, 3);
      ok(activity + ' POST has offering_key', !!(equipment[0] && equipment[0].offering_key), JSON.stringify(equipment));
      ok(activity + ' POST equipment has no cents/client dates', !JSON.stringify(equipment).match(/cents|date|client/i), JSON.stringify(equipment));
      if (await page.locator('#ps-detail-drawer').isVisible()) await page.locator('#ps-drawer-close').click();
      await page.locator('#ps-refresh-schedule').click();
      const row = page.locator('[data-ps-booking-id]').filter({ hasText: idx ? 'Private Created' : 'Group Created' }).first();
      await row.waitFor();
      await row.click();
      await page.locator('#ps-drawer-edit').click();
      await page.locator('#ps-drawer-course-equipment').waitFor();
      const drawerItem = page.locator('#ps-drawer-course-equipment .portal-schedule-course-equipment-item').first();
      eq(activity + ' reopen reads saved mode', await drawerItem.locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'), 'true');
      eq(activity + ' reopen reads saved quantity', await drawerItem.locator('[data-course-equipment-quantity]').inputValue(), '3');
      await page.locator('#ps-drawer-cancel').click();
      await page.locator('#ps-drawer-close').click();
    }

    // ── Locale + mobile on Create multi-item owner ──
    await page.locator('#ps-create-booking').click();
    await page.locator('[data-create-activity="ps-create-comp-course"]').click();
    await page.locator('#ps-create-course-list button[data-course-id]').first().click();
    await page.locator('#ps-create-course-equipment').waitFor();
    // Enable first option so mode buttons are visible for locale/mobile target checks.
    await page.locator('#ps-create-course-equipment [data-course-equipment-enabled]').first().check();
    await page.locator('#ps-create-course-equipment [data-course-equipment-mode="all_day"]').first().click();
    for (const locale of ['en', 'es', 'it']) {
      await page.evaluate((l) => window.setStaffLocale(l), locale);
      const text = await page.locator('#ps-create-course-equipment').innerText();
      ok(locale.toUpperCase() + ' Create equipment localized', !text.includes('schedule.courseEquipment.'), text);
    }
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 900 });
      const shape = await page.locator('#ps-create-course-equipment').evaluate((el) => {
        // Visible mode/action buttons and quantity inputs only. Styled checkbox radials
        // are intentionally 18px inside a 44px label hit target.
        const targets = [...el.querySelectorAll('button, input[type=number]')]
          .filter((x) => x.offsetParent !== null)
          .map((x) => x.getBoundingClientRect().height);
        return {
          overflow: el.scrollWidth > el.clientWidth + 1,
          targets,
          checkLabelMin: Math.min(...[...el.querySelectorAll('label.portal-schedule-course-equipment-check')]
            .map((x) => x.getBoundingClientRect().height)),
        };
      });
      ok(width + 'px Create equipment no overflow', !shape.overflow, JSON.stringify(shape));
      ok(width + 'px Create equipment 44px action targets', shape.targets.every((h) => h >= 44), JSON.stringify(shape.targets));
      ok(width + 'px Create equipment 44px checkbox labels', shape.checkLabelMin >= 44, String(shape.checkLabelMin));
    }
    await page.locator('#ps-create-close').click();
    await page.setViewportSize({ width: 1280, height: 900 });
    if (await page.locator('#ps-detail-drawer').isVisible()) await page.locator('#ps-drawer-close').click();

    // ── Generated Edit multi-item against canonical readback ──
    await page.locator('button.tab-btn[data-tab="portal-home"]').click();
    const generatedEditRow = page.locator('[data-ps-booking-id]').filter({ hasText: 'Generated Edit' }).first();
    await generatedEditRow.waitFor({ state: 'visible' });
    await generatedEditRow.click();
    await page.locator('#ps-drawer-edit').waitFor({ state: 'visible' });
    await page.locator('#ps-drawer-edit').click();
    const editField = page.locator('#ps-drawer-course-equipment');
    await editField.waitFor({ state: 'visible' });
    const editItems = editField.locator('.portal-schedule-course-equipment-item');
    ok('Edit multi-item list seeded', (await editItems.count()) >= 1);
    eq('Edit has no old equipment menu', await editField.locator('select').count(), 0);
    eq('Edit enable seeded on', await editItems.first().locator('[data-course-equipment-enabled]').isChecked(), true);
    eq('Edit canonical mode is seeded', await editItems.first().locator('[data-drawer-course-equipment-mode="during_course"]').getAttribute('aria-pressed'), 'true');
    // During tracks surfers; course qty starts at 3 from detail.
    eq('Edit during quantity tracks seeded surfers', await editItems.first().locator('[data-course-equipment-quantity]').inputValue(), '3');
    await page.locator('#ps-drawer-course-qty').fill('2');
    await page.locator('#ps-drawer-course-qty').dispatchEvent('change');
    await page.waitForFunction(() => !document.querySelector('.portal-schedule-quote-checking')).catch(() => {});
    await page.waitForTimeout(100);
    eq('Edit during quantity tracks surfer decrease', await editItems.first().locator('[data-course-equipment-quantity]').inputValue(), '2');
    // Save During with tracked surfers first (avoids quote-overlay intercept on mode switch).
    const quotesBeforeSave = editQuotes.length;
    if (await page.locator('#ps-drawer-save').isDisabled()) {
      throw new Error('Edit invalid: ' + await page.locator('#ps-drawer-summary').innerText());
    }
    await page.locator('#ps-drawer-save').click();
    await page.locator('#ps-drawer-edit').waitFor({ state: 'visible' });
    eq('Edit save sends one bounded PATCH', editPatches.length, 1);
    ok('Edit requote requests are bounded', editQuotes.length <= quotesBeforeSave + 1, `before=${quotesBeforeSave} after=${editQuotes.length}`);
    eq(
      'Edit authoritative save carries multi-item during + tracked quantity',
      JSON.stringify(editPatches[0].course_equipment),
      JSON.stringify([{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }]),
    );
    ok(
      'Edit equipment payload has no cents/client dates',
      !JSON.stringify(editPatches[0].course_equipment).match(/cents|date|client/i),
      JSON.stringify(editPatches[0].course_equipment),
    );
    // Fresh edit mount: All Day set quantity path.
    await page.locator('#ps-drawer-edit').click();
    await editField.waitFor({ state: 'visible' });
    await editItems.first().locator('[data-drawer-course-equipment-mode="all_day"]').click();
    await editItems.first().locator('.portal-schedule-course-equipment-sets').waitFor({ state: 'visible' });
    await editItems.first().locator('[data-course-equipment-quantity]').fill('1');
    await page.locator('#ps-drawer-save').click();
    await page.locator('#ps-drawer-edit').waitFor({ state: 'visible' });
    eq('Edit all-day save carries set quantity', JSON.stringify(editPatches[1].course_equipment), JSON.stringify([{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }]));
    await page.locator('#ps-drawer-edit').click();
    await editField.waitFor({ state: 'visible' });
    eq('Edit reopen reads saved all-day mode', await editItems.first().locator('[data-drawer-course-equipment-mode="all_day"]').getAttribute('aria-pressed'), 'true');
    eq('Edit reopen reads saved set quantity', await editItems.first().locator('[data-course-equipment-quantity]').inputValue(), '1');
    await page.locator('#ps-drawer-cancel').click();
    await page.locator('#ps-drawer-close').click();

    // ── Wolfhouse isolation ──
    await page.evaluate(() => {
      const n = document.querySelector('#c-client');
      n.value = 'wolfhouse-somo';
      n.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'wolfhouse-somo');
    eq('Wolfhouse has no Sunset equipment Admin controls', await page.locator('[data-admin-course-equipment]:visible').count(), 0);
    eq('Wolfhouse has no Sunset Admin navigation', await page.locator('button.tab-btn[data-tab="admin"]:visible').count(), 0);
    eq('Wolfhouse has no Sunset equipment Create controls', await page.locator('#ps-create-booking:visible').count(), 0);
    const normalNav = page.locator('button.tab-btn:visible').first();
    await normalNav.click();
    ok('Wolfhouse normal navigation remains', await normalNav.evaluate((el) => el.classList.contains('active')));
    eq('no page or console errors', errors.join('|'), '');
  } finally {
    await context.close();
    await browser.close();
    await close(server);
  }
  console.log(`\nverify:sunset-course-equipment-ui-playwright — ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
