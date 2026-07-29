'use strict';
/**
 * Generated Edit multi-lesson contract:
 * 1) Group: open canonical readback → mutate lessons/equipment → real PATCH → reopen.
 * 2) Private same-day multi: seed two sessions → CE controls → remove session → PATCH → reopen.
 */
const assert = require('assert');
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';

function pw() {
  try { return require('playwright'); } catch (e) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}
const listen = (s) => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
});

const BOOKING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIVATE_BOOKING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DATE = '2026-08-20';

async function runGroupEdit(base) {
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const patches = [];
  const quotes = [];
  const errors = [];
  let equipment = [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }];
  let lessons = [
    { kind: 'group', course_id: 'group-a', date: DATE, schedule_key: '0930_1130', tier_key: '1_day' },
    { kind: 'group', course_id: 'group-a', date: DATE, schedule_key: '1215_1415', tier_key: '1_day' },
  ];

  function detail() {
    return {
      success: true,
      booking_id: BOOKING_ID,
      booking_code: 'EDIT-MULTI',
      guest_name: 'Edit Multi Guest',
      phone: '+34922222222',
      notes: 'kept',
      payment_status: 'unpaid',
      date_from: DATE,
      date_to: DATE,
      components: {
        course: {
          course_id: 'group-a',
          course_label: 'Group A',
          quantity: 2,
          tier_key: '1_day',
        },
      },
      lessons: lessons.slice(),
      course_equipment: equipment.slice(),
      rentals: [],
      custom_line_items: [],
      editable: true,
      location_id: 'sunset-somo',
      payment: {
        subtotal_cents: 7000,
        paid_cents: 0,
        balance_due_cents: 7000,
        line_items: [],
      },
    };
  }

  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/schedule/bookings/catalog?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      courses: [{
        course_id: 'group-a',
        label: 'Group A',
        eligible_on_requested_dates: true,
        schedules: ['0930_1130', '1215_1415'],
        equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
        price_tiers: [
          { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-a__1_day' },
        ],
      }],
      rentals: [],
    }),
  }));
  await page.route('**/staff/schedule/bookings/detail?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(detail()),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    quotes.push(body);
    const n = Array.isArray(body.lessons) ? body.lessons.length : 1;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total_cents: 3500 * Math.max(1, n),
        subtotal_cents: 3500 * Math.max(1, n),
        line_items: [],
        quote_provenance: { quote_fingerprint: 'fp-edit-' + n },
      }),
    });
  });
  await page.route('**/staff/schedule/bookings?**', (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    patches.push(body);
    if (Array.isArray(body.lessons)) lessons = body.lessons.slice();
    if (Array.isArray(body.course_equipment)) equipment = body.course_equipment.slice();
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, context: detail() }),
    });
  });
  await page.route('**/staff/schedule/day?**', (r) => {
    const date = new URL(r.request().url()).searchParams.get('date');
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date,
        lessons: [],
        gear: [],
        rows: [{
          booking_id: BOOKING_ID,
          booking_code: 'EDIT-MULTI',
          guest_name: 'Edit Multi Guest',
          record_source: 'staff_manual',
          service_date: date || DATE,
          service_time_local: '09:30',
          service_type: 'surf_lesson',
          offering_label: 'Group A',
          metadata: { component: 'course', course_id: 'group-a' },
          quantity: 2,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
        }],
      }),
    });
  });

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    const row = page.locator('[data-ps-booking-id]').filter({ hasText: 'Edit Multi Guest' }).first();
    await row.waitFor({ timeout: 10000 });
    await row.click();
    await page.locator('#ps-drawer-edit').click();

    await page.locator('#ps-drawer-group-lessons-wrap').waitFor({ state: 'visible', timeout: 8000 });
    const groupRows = page.locator('.portal-schedule-group-lesson-row');
    await page.waitForTimeout(400);
    let count = await groupRows.count();
    if (count < 2) {
      await page.waitForTimeout(500);
      count = await groupRows.count();
    }
    assert.ok(count >= 2, `expected ≥2 group lesson rows from readback, got ${count}`);

    const field = page.locator('#ps-drawer-course-equipment');
    await field.waitFor({ state: 'visible', timeout: 8000 });
    const ceItems = field.locator('.portal-schedule-course-equipment-item');
    assert.ok(await ceItems.count() >= 1, 'course equipment items render');
    assert.strictEqual(await ceItems.first().locator('input[type=checkbox]').isChecked(), true);

    await groupRows.nth(1).locator('[data-group-lesson-remove]').click();
    assert.strictEqual(await groupRows.count(), 1);

    await ceItems.first().locator('input[type=checkbox]').uncheck();

    const q0 = quotes.length;
    await page.locator('#ps-drawer-save').click();
    await page.waitForTimeout(700);
    assert.ok(patches.length >= 1, 'expected real PATCH');
    const patch = patches[patches.length - 1];
    assert.ok(Array.isArray(patch.lessons), 'PATCH lessons[] required');
    assert.strictEqual(patch.lessons.length, 1, 'removed lesson must not reappear on PATCH');
    assert.ok(patch.lessons[0].course_id === 'group-a');
    assert.ok(Array.isArray(patch.course_equipment));
    assert.strictEqual(patch.course_equipment.length, 0, 'cleared equipment on PATCH');
    assert.ok(!/unit_amount|amount_cents|price_cents/i.test(JSON.stringify(patch.lessons)));

    if (quotes.length > q0) {
      const q = quotes[quotes.length - 1];
      assert.ok(Array.isArray(q.lessons), 'Edit quote must forward lessons[]');
    }

    if (await page.locator('#ps-drawer-close').count()) {
      await page.locator('#ps-drawer-close').click();
    }
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-group-lessons-wrap').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.portal-schedule-group-lesson-row').count(), 1);
    await field.waitFor({ state: 'visible' });
    const reopenedCe = field.locator('.portal-schedule-course-equipment-item');
    if (await reopenedCe.count()) {
      assert.strictEqual(await reopenedCe.first().locator('input[type=checkbox]').isChecked(), false);
    }

    assert.deepStrictEqual(errors, []);
    console.log('PASS focused Edit multi-lesson Group readback/mutate/PATCH/reopen contract');
  } finally {
    await browser.close();
  }
}

async function runPrivateEdit(base) {
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const patches = [];
  const quotes = [];
  const errors = [];
  let equipment = [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }];
  let lessons = [
    { kind: 'private', date: DATE, start: '09:00', end: '10:30' },
    { kind: 'private', date: DATE, start: '16:00', end: '17:30' },
  ];

  function detail() {
    return {
      success: true,
      booking_id: PRIVATE_BOOKING_ID,
      booking_code: 'EDIT-PRIVATE-MULTI',
      guest_name: 'Edit Private Multi Guest',
      phone: '+34933333333',
      notes: 'private multi',
      payment_status: 'unpaid',
      date_from: DATE,
      date_to: DATE,
      components: {
        private_lesson: {
          enabled: true,
          quantity: lessons.length,
          surfer_count: 2,
          sessions: lessons.map((l, i) => ({
            date: l.date, start: l.start, end: l.end, index: i + 1,
          })),
        },
      },
      lessons: lessons.slice(),
      course_equipment: equipment.slice(),
      rentals: [],
      custom_line_items: [],
      editable: true,
      location_id: 'sunset-somo',
      payment: {
        subtotal_cents: 24000,
        paid_cents: 0,
        balance_due_cents: 24000,
        line_items: [],
      },
    };
  }

  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/schedule/bookings/catalog?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      ok: true,
      courses: [],
      rentals: [],
      offerings: [{
        offering_type: 'private_lesson',
        label: 'Private Course',
        equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
      }],
    }),
  }));
  await page.route('**/staff/config?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      private_lesson: {
        enabled: true,
        label: 'Private Course',
        amount_cents: 6000,
        equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
      },
      prices: [],
      surf_packs: [],
      rental_offerings: [],
    }),
  }));
  await page.route('**/staff/schedule/bookings/detail?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(detail()),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    quotes.push(body);
    const n = Array.isArray(body.lessons) ? body.lessons.length : 1;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total_cents: 6000 * 2 * Math.max(1, n),
        subtotal_cents: 6000 * 2 * Math.max(1, n),
        line_items: [],
        quote_provenance: { quote_fingerprint: 'fp-priv-edit-' + n },
      }),
    });
  });
  await page.route('**/staff/schedule/bookings?**', (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    patches.push(body);
    if (Array.isArray(body.lessons)) lessons = body.lessons.slice();
    if (Array.isArray(body.course_equipment)) equipment = body.course_equipment.slice();
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, context: detail() }),
    });
  });
  await page.route('**/staff/schedule/day?**', (r) => {
    const date = new URL(r.request().url()).searchParams.get('date');
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date,
        lessons: [],
        gear: [],
        rows: [{
          booking_id: PRIVATE_BOOKING_ID,
          booking_code: 'EDIT-PRIVATE-MULTI',
          guest_name: 'Edit Private Multi Guest',
          record_source: 'staff_manual',
          service_date: date || DATE,
          service_time_local: '09:00',
          service_type: 'surf_lesson',
          offering_label: 'Private Course',
          metadata: { component: 'private_lesson', staff_ui_service_type: 'private_lesson' },
          quantity: 2,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
        }],
      }),
    });
  });

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    const row = page.locator('[data-ps-booking-id]').filter({ hasText: 'Edit Private Multi Guest' }).first();
    await row.waitFor({ timeout: 10000 });
    await row.click();
    await page.locator('#ps-drawer-edit').click();

    // Two same-day private sessions seeded from canonical readback
    await page.locator('#ps-drawer-private-sessions').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
    let sessionRows = page.locator('.portal-schedule-private-session-row');
    let count = await sessionRows.count();
    if (count < 2) {
      await page.waitForTimeout(600);
      count = await sessionRows.count();
    }
    assert.ok(count >= 2, `expected ≥2 private session rows from same-day readback, got ${count}`);

    // Add session control present
    assert.ok(await page.locator('#ps-drawer-add-private-session').count() >= 1, 'add private session control');

    // Private course equipment controls appear in Edit
    const field = page.locator('#ps-drawer-course-equipment');
    await field.waitFor({ state: 'visible', timeout: 10000 });
    const ceItems = field.locator('.portal-schedule-course-equipment-item');
    assert.ok(await ceItems.count() >= 1, 'private course equipment items render');
    assert.strictEqual(await ceItems.first().locator('input[type=checkbox]').isChecked(), true);

    // Mutate: remove second same-day session via real control
    await sessionRows.nth(1).locator('[data-private-session-remove]').click();
    assert.strictEqual(await page.locator('.portal-schedule-private-session-row').count(), 1);

    // Mutate: clear equipment
    await ceItems.first().locator('input[type=checkbox]').uncheck();

    await page.locator('#ps-drawer-save').click();
    await page.waitForTimeout(700);
    assert.ok(patches.length >= 1, 'expected real private PATCH');
    const patch = patches[patches.length - 1];
    assert.ok(Array.isArray(patch.lessons), 'PATCH lessons[] required for private');
    assert.strictEqual(patch.lessons.length, 1, 'removed private session must not reappear on PATCH');
    assert.ok(patch.lessons[0].kind === 'private');
    assert.ok(patch.lessons[0].date === DATE);
    assert.ok(patch.lessons[0].start && patch.lessons[0].end);
    assert.ok(Array.isArray(patch.course_equipment));
    assert.strictEqual(patch.course_equipment.length, 0, 'cleared private equipment on PATCH');
    assert.ok(!/unit_amount|amount_cents|price_cents/i.test(JSON.stringify(patch.lessons)));

    // Reopen preserves remaining session + equipment state
    if (await page.locator('#ps-drawer-close').count()) {
      await page.locator('#ps-drawer-close').click();
    }
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-private-sessions').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    assert.strictEqual(await page.locator('.portal-schedule-private-session-row').count(), 1);
    await field.waitFor({ state: 'visible' });
    const reopenedCe = field.locator('.portal-schedule-course-equipment-item');
    if (await reopenedCe.count()) {
      assert.strictEqual(await reopenedCe.first().locator('input[type=checkbox]').isChecked(), false);
    }

    assert.deepStrictEqual(errors, []);
    console.log('PASS focused Edit multi-lesson Private same-day readback/mutate/PATCH/reopen + CE');
  } finally {
    await browser.close();
  }
}

(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  try {
    await runGroupEdit(base);
    await runPrivateEdit(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
