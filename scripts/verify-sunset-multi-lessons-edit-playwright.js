'use strict';
/**
 * Generated Edit multi-course product buttons (Create parity):
 * 1) Group: open two-course readback → both aria-pressed → toggle add/remove →
 *    real quote + PATCH carry selected_courses → reopen exact buttons.
 * 2) Private same-day multi unchanged: seed two sessions → CE → remove session → PATCH → reopen.
 * No Group lessons[] / custom schedule invent. No evaluate() payload-builder fallback.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
const SINGLE_BOOKING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DATE = '2026-08-20';

function assertRemovedEditGroupBlock(editUi, staffApi) {
  const removedIds = [
    'ps-drawer-group-lessons-wrap',
    'ps-drawer-group-lessons',
    'ps-drawer-add-group-lesson',
    'scheduleDrawerReadGroupLessonRows',
    'scheduleDrawerAppendGroupLessonRow',
    'scheduleDrawerSyncGroupLessons',
    'scheduleDrawerGroupLessonCourseOptionsHtml',
    'scheduleDrawerGroupLessonScheduleOptionsHtml',
  ];
  for (const id of removedIds) {
    assert.ok(
      !editUi.includes(id),
      `Edit source must not contain removed Group lessons id/function: ${id}`,
    );
  }
  assert.ok(
    !/schedule\.create\.groupLessons/.test(editUi),
    'Edit must not reference schedule.create.groupLessons',
  );
  assert.ok(
    !/schedule\.create\.addLesson/.test(editUi),
    'Edit must not reference schedule.create.addLesson',
  );
  assert.ok(
    !/schedule\.create\.lessons/.test(editUi),
    'Edit must not reference schedule.create.lessons heading key',
  );
  assert.ok(
    /function scheduleDrawerGetSelectedCourseIds/.test(editUi),
    'Edit owns multi course id reader',
  );
  assert.ok(
    /function scheduleDrawerToggleCourse/.test(editUi),
    'Edit owns multi course toggle',
  );
  assert.ok(
    /selected_courses:\s*selectedCourses/.test(editUi),
    'Edit payload owns selected_courses',
  );
  // Create still owns its own absence (regression guard).
  assert.ok(
    !/ps-create-group-lessons-wrap/.test(staffApi),
    'Create Group lessons wrap remains removed',
  );
}

async function runGroupEdit(base) {
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const patches = [];
  const quotes = [];
  const errors = [];
  let equipment = [{ offering_key: 'softboard', mode: 'during_course', quantity: 2 }];
  // Canonical selected course product buttons (not lesson-builder rows).
  let selectedCourses = [
    { course_id: 'group-a', course_label: 'Group A', tier_key: '1_day', offering_id: 'surf_pack_group-a__1_day' },
    { course_id: 'group-b', course_label: 'Group B', tier_key: '1_day', offering_id: 'surf_pack_group-b__1_day' },
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
          course_id: selectedCourses[0] ? selectedCourses[0].course_id : 'group-a',
          course_label: selectedCourses[0] ? selectedCourses[0].course_label : 'Group A',
          quantity: 2,
          tier_key: '1_day',
          selected_courses: selectedCourses.slice(),
        },
      },
      // No Group lessons[] identity for product-button multi-course bookings.
      lessons: [],
      course_equipment: equipment.slice(),
      rentals: [],
      custom_line_items: [],
      editable: true,
      location_id: 'sunset-somo',
      payment: {
        subtotal_cents: 8000,
        paid_cents: 0,
        balance_due_cents: 8000,
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
      courses: [
        {
          course_id: 'group-a',
          label: 'Group A',
          eligible_on_requested_dates: true,
          schedules: ['0930_1130', '1215_1415'],
          equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-a__1_day' },
          ],
        },
        {
          course_id: 'group-b',
          label: 'Group B',
          eligible_on_requested_dates: true,
          schedules: ['0930_1130', '1215_1415'],
          equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-b__1_day' },
          ],
        },
        {
          course_id: 'group-c',
          label: 'Group C',
          eligible_on_requested_dates: true,
          schedules: ['0930_1130'],
          equipment_options: [{ offering_key: 'softboard', label: 'Softboard' }],
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-c__1_day' },
          ],
        },
      ],
      rentals: [],
      offerings: [],
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
    const selected = (body.components && body.components.course
      && Array.isArray(body.components.course.selected_courses))
      ? body.components.course.selected_courses
      : [];
    const total = selected.length >= 2 ? 8000 : 3500;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total_cents: total,
        subtotal_cents: total,
        line_items: selected.map((sc, i) => ({
          component: 'course',
          course_id: sc.course_id,
          tier_key: sc.tier_key || '1_day',
          total_cents: 3500,
          quantity: 2,
          selected_course_index: i,
        })),
        quote_provenance: { quote_fingerprint: 'fp-edit-' + selected.length },
      }),
    });
  });
  await page.route('**/staff/schedule/bookings?**', (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    patches.push(body);
    if (body.components && body.components.course
      && Array.isArray(body.components.course.selected_courses)) {
      selectedCourses = body.components.course.selected_courses.map((sc) => ({
        course_id: sc.course_id,
        course_label: sc.course_label || sc.course_id,
        tier_key: sc.tier_key || '1_day',
        offering_id: sc.offering_id || ('surf_pack_' + sc.course_id + '__1_day'),
      }));
    }
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
        rows: selectedCourses.map((sc, i) => ({
          booking_id: BOOKING_ID,
          booking_code: 'EDIT-MULTI',
          guest_name: 'Edit Multi Guest',
          record_source: 'staff_manual',
          service_date: date || DATE,
          service_time_local: '09:30',
          service_type: 'surf_lesson',
          offering_label: sc.course_label || sc.course_id,
          metadata: { component: 'course', course_id: sc.course_id },
          quantity: 2,
          payment_status: 'unpaid',
          booking_status: 'confirmed',
          status: 'confirmed',
          service_record_id: 'sr-' + i,
        })),
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

    // Removed Group lesson-builder block must be absent from live DOM.
    assert.strictEqual(await page.locator('#ps-drawer-group-lessons-wrap').count(), 0);
    assert.strictEqual(await page.locator('#ps-drawer-add-group-lesson').count(), 0);
    assert.strictEqual(await page.locator('.portal-schedule-group-lesson-row').count(), 0);

    await page.locator('#ps-drawer-course-list').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(400);

    // Both exact existing product buttons pressed from readback.
    let pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-drawer-course-list');
      if (!list) return [];
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed.sort(), ['group-a', 'group-b']);

    // Multi-select: add group-c without clearing a/b.
    await page.locator('#ps-drawer-course-list [data-course-id="group-c"]').click();
    await page.waitForTimeout(200);
    pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-drawer-course-list');
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed.sort(), ['group-a', 'group-b', 'group-c']);

    // Multi-select: remove group-b without clearing others.
    await page.locator('#ps-drawer-course-list [data-course-id="group-b"]').click();
    await page.waitForTimeout(200);
    pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-drawer-course-list');
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed.sort(), ['group-a', 'group-c']);

    // Shared surfer stepper remains.
    assert.ok(await page.locator('#ps-drawer-course-qty').count() >= 1, 'group surfer stepper present');

    await page.waitForTimeout(600);
    assert.ok(quotes.length >= 1, 'expected at least one real Edit quote request');
    const quoteWithCourses = [...quotes].reverse().find((q) => {
      const sc = q.components && q.components.course && q.components.course.selected_courses;
      return Array.isArray(sc) && sc.length >= 2;
    });
    assert.ok(quoteWithCourses, 'Edit quote body must carry selected_courses (≥2)');
    const quoteIds = quoteWithCourses.components.course.selected_courses.map((c) => c.course_id).sort();
    assert.deepStrictEqual(quoteIds, ['group-a', 'group-c']);
    const quoteGroupLessons = Array.isArray(quoteWithCourses.lessons)
      ? quoteWithCourses.lessons.filter((l) => l && (l.kind === 'group' || l.course_id))
      : [];
    assert.strictEqual(quoteGroupLessons.length, 0, 'Edit quote must not carry Group lessons[]');

    const before = patches.length;
    await page.locator('#ps-drawer-save').click();
    await page.waitForTimeout(900);
    assert.ok(patches.length > before, 'expected real PATCH (no evaluate fallback)');
    const patch = patches[patches.length - 1];
    assert.ok(patch && patch.components && patch.components.course);
    const selected = patch.components.course.selected_courses;
    assert.ok(Array.isArray(selected) && selected.length === 2, 'PATCH selected_courses must have exactly 2');
    assert.deepStrictEqual(selected.map((c) => c.course_id).sort(), ['group-a', 'group-c']);
    assert.ok(selected.every((c) => c.tier_key), 'each selected course needs tier identity');
    assert.ok(!/unit_amount|amount_cents|price_cents/i.test(JSON.stringify(selected)));
    const patchGroupLessons = Array.isArray(patch.lessons)
      ? patch.lessons.filter((l) => l && (l.kind === 'group' || l.course_id))
      : [];
    assert.strictEqual(patchGroupLessons.length, 0, 'PATCH must not carry Group lessons[]');
    assert.ok(
      !JSON.stringify(patch.components || {}).includes('schedule_key'),
      'PATCH components must not invent schedule_key',
    );

    // Reopen restores exact selected buttons.
    if (await page.locator('#ps-drawer-close').count()) {
      await page.locator('#ps-drawer-close').click();
    }
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-course-list').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-drawer-course-list');
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed.sort(), ['group-a', 'group-c']);
    assert.strictEqual(await page.locator('#ps-drawer-group-lessons-wrap').count(), 0);

    // Mobile widths: no horizontal overflow; surfer stepper still present.
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() => {
        const drawer = document.querySelector('#ps-drawer .portal-schedule-create-drawer')
          || document.querySelector('.portal-schedule-create-drawer')
          || document.querySelector('#ps-drawer');
        return drawer ? drawer.scrollWidth > drawer.clientWidth + 1 : false;
      });
      assert.strictEqual(overflow, false, `no overflow at ${width}px`);
      assert.ok(await page.locator('#ps-drawer-course-qty').count() >= 1, `stepper at ${width}px`);
    }

    assert.deepStrictEqual(errors, []);
    console.log('PASS focused Edit multi-course product buttons real quote+PATCH/reopen wire contract');
  } finally {
    await browser.close();
  }
}

async function runSingleCourseEdit(base) {
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const patches = [];
  const errors = [];
  let selectedCourses = [
    { course_id: 'group-a', course_label: 'Group A', tier_key: '1_day', offering_id: 'surf_pack_group-a__1_day' },
  ];

  function detail() {
    return {
      success: true,
      booking_id: SINGLE_BOOKING_ID,
      booking_code: 'EDIT-SINGLE',
      guest_name: 'Edit Single Guest',
      phone: '+34944444444',
      notes: '',
      payment_status: 'unpaid',
      date_from: DATE,
      date_to: DATE,
      components: {
        course: {
          course_id: 'group-a',
          course_label: 'Group A',
          quantity: 1,
          tier_key: '1_day',
          selected_courses: selectedCourses.slice(),
        },
      },
      lessons: [],
      course_equipment: [],
      rentals: [],
      custom_line_items: [],
      editable: true,
      location_id: 'sunset-somo',
      payment: {
        subtotal_cents: 3500,
        paid_cents: 0,
        balance_due_cents: 3500,
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
      courses: [
        {
          course_id: 'group-a',
          label: 'Group A',
          eligible_on_requested_dates: true,
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-a__1_day' },
          ],
        },
        {
          course_id: 'group-b',
          label: 'Group B',
          eligible_on_requested_dates: true,
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-b__1_day' },
          ],
        },
      ],
      rentals: [],
    }),
  }));
  await page.route('**/staff/schedule/bookings/detail?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(detail()),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      total_cents: 3500,
      subtotal_cents: 3500,
      line_items: [],
      quote_provenance: { quote_fingerprint: 'fp-single' },
    }),
  }));
  await page.route('**/staff/schedule/bookings?**', (r) => {
    if (r.request().method() !== 'PATCH') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    patches.push(body);
    if (body.components && body.components.course
      && Array.isArray(body.components.course.selected_courses)) {
      selectedCourses = body.components.course.selected_courses.slice();
    }
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
          booking_id: SINGLE_BOOKING_ID,
          booking_code: 'EDIT-SINGLE',
          guest_name: 'Edit Single Guest',
          record_source: 'staff_manual',
          service_date: date || DATE,
          service_time_local: '09:30',
          service_type: 'surf_lesson',
          offering_label: 'Group A',
          metadata: { component: 'course', course_id: 'group-a' },
          quantity: 1,
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
    const row = page.locator('[data-ps-booking-id]').filter({ hasText: 'Edit Single Guest' }).first();
    await row.waitFor({ timeout: 10000 });
    await row.click();
    await page.locator('#ps-drawer-edit').click();
    await page.locator('#ps-drawer-course-list').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(300);
    const pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-drawer-course-list');
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed, ['group-a']);
    await page.locator('#ps-drawer-save').click();
    await page.waitForTimeout(700);
    assert.ok(patches.length >= 1, 'single-course PATCH');
    const patch = patches[patches.length - 1];
    const sc = patch.components.course.selected_courses;
    assert.ok(Array.isArray(sc) && sc.length === 1);
    assert.strictEqual(sc[0].course_id, 'group-a');
    assert.strictEqual(
      Array.isArray(patch.lessons)
        ? patch.lessons.filter((l) => l && l.kind === 'group').length
        : 0,
      0,
    );
    assert.deepStrictEqual(errors, []);
    console.log('PASS single-course Edit selected_courses compatibility');
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

    await page.locator('#ps-drawer-private-sessions').waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
    let sessionRows = page.locator('.portal-schedule-private-session-row');
    let count = await sessionRows.count();
    if (count < 2) {
      await page.waitForTimeout(600);
      count = await sessionRows.count();
    }
    assert.ok(count >= 2, `expected ≥2 private session rows from same-day readback, got ${count}`);
    assert.ok(await page.locator('#ps-drawer-add-private-session').count() >= 1, 'add private session control');

    // Group lesson-builder must not appear on Private.
    assert.strictEqual(await page.locator('#ps-drawer-group-lessons-wrap').count(), 0);

    const field = page.locator('#ps-drawer-course-equipment');
    await field.waitFor({ state: 'visible', timeout: 10000 });
    const ceItems = field.locator('.portal-schedule-course-equipment-item');
    assert.ok(await ceItems.count() >= 1, 'private course equipment items render');
    assert.strictEqual(await ceItems.first().locator('input[type=checkbox]').isChecked(), true);

    await sessionRows.nth(1).locator('[data-private-session-remove]').click();
    assert.strictEqual(await page.locator('.portal-schedule-private-session-row').count(), 1);
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
  const root = path.join(__dirname, '..');
  const editUi = fs.readFileSync(path.join(root, 'scripts/browser/sunset-schedule-drawer-edit-ui.js'), 'utf8');
  const staffApi = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
  assertRemovedEditGroupBlock(editUi, staffApi);

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  try {
    await runGroupEdit(base);
    await runSingleCourseEdit(base);
    await runPrivateEdit(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
