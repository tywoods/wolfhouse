'use strict';
/**
 * Generated Create multi-course product buttons:
 * click 2 course buttons → both aria-pressed → real quote + POST carry both course IDs.
 * No Group lessons[] / custom schedule data. No evaluate() payload-builder fallback.
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

(async () => {
  // Source absence: Create Group lessons section fully removed.
  const root = path.join(__dirname, '..');
  const staffApi = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
  const portal = fs.readFileSync(path.join(root, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
  const removedIds = [
    'ps-create-group-lessons-wrap',
    'ps-create-group-lessons',
    'ps-create-add-group-lesson',
    'scheduleReadCreateGroupLessonRows',
    'scheduleAppendCreateGroupLessonRow',
    'scheduleSyncCreateGroupLessonsVisibility',
    'scheduleWireCreateGroupLessons',
    'scheduleCreateGroupLessonCourseOptionsHtml',
    'scheduleCreateGroupLessonScheduleOptionsHtml',
  ];
  for (const id of removedIds) {
    assert.ok(
      !staffApi.includes(id),
      `Create source must not contain removed Group lessons id/function: ${id}`,
    );
  }
  assert.ok(
    !/schedule\.create\.groupLessons/.test(staffApi),
    'Create HTML must not reference schedule.create.groupLessons',
  );
  assert.ok(
    /function schedulePortalGetSelectedCreateCourseIds/.test(portal),
    'portal owns multi course id reader',
  );
  assert.ok(
    /function schedulePortalToggleCreateCourse/.test(portal),
    'portal owns multi course toggle',
  );

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const quotes = [];
  const posts = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/schedule/day?**', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      date: new URL(r.request().url()).searchParams.get('date'),
      lessons: [],
      gear: [],
      rows: [],
    }),
  }));
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
          equipment_options: [
            { offering_key: 'softboard', label: 'Softboard' },
          ],
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-a__1_day' },
          ],
        },
        {
          course_id: 'group-b',
          label: 'Group B',
          eligible_on_requested_dates: true,
          schedules: ['0930_1130', '1215_1415'],
          equipment_options: [
            { offering_key: 'softboard', label: 'Softboard' },
          ],
          price_tiers: [
            { key: '1_day', label: '1 day', duration_days: 1, bookable: true, offering_id: 'surf_pack_group-b__1_day' },
          ],
        },
      ],
      rentals: [],
      offerings: [{ offering_type: 'private_lesson', equipment_options: [] }],
    }),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
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
          total_cents: sc.course_id === 'group-b' ? 4500 : 3500,
          unit_amount_cents: sc.course_id === 'group-b' ? 2250 : 1750,
          quantity: 2,
          service_dates: [body.date_from || '2026-08-20'],
          selected_course_index: i,
        })),
        quote_provenance: { quote_fingerprint: 'fp-multi-courses-' + selected.length },
      }),
    });
  });
  await page.route('**/staff/schedule/bookings?**', (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    posts.push(JSON.parse(r.request().postData() || '{}'));
    return r.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        booking_id: '22222222-2222-4222-8222-222222222222',
        booking_code: 'MULTI-COURSE',
        total_cents: 8000,
      }),
    });
  });
  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('#ps-create-booking').click();
    await page.locator('#ps-create-guest').fill('Multi Course Guest');
    await page.locator('#ps-create-phone').fill('+34911111111');
    await page.evaluate(() => {
      for (const [id, v] of [['ps-create-date-from', '2026-08-20'], ['ps-create-date-to', '2026-08-20']]) {
        const n = document.getElementById(id);
        if (n) {
          n.value = v;
          n.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });
    await page.locator('#ps-create-surfers').fill('2');
    await page.locator('#ps-create-surfers').dispatchEvent('change');
    await page.locator('[data-create-activity="ps-create-comp-course"]').click();
    await page.locator('#ps-create-course-list [data-course-id="group-a"]').click();
    await page.locator('#ps-create-course-list [data-course-id="group-b"]').click();
    await page.waitForTimeout(300);

    // Both product buttons selected simultaneously.
    const pressed = await page.evaluate(() => {
      const list = document.getElementById('ps-create-course-list');
      if (!list) return [];
      return Array.from(list.querySelectorAll('button[data-course-id][aria-pressed="true"]'))
        .map((b) => b.getAttribute('data-course-id'));
    });
    assert.deepStrictEqual(pressed.sort(), ['group-a', 'group-b']);

    // Removed section must be absent from live DOM.
    assert.strictEqual(await page.locator('#ps-create-group-lessons-wrap').count(), 0);
    assert.strictEqual(await page.locator('#ps-create-add-group-lesson').count(), 0);
    assert.strictEqual(await page.locator('.portal-schedule-group-lesson-row').count(), 0);

    await page.waitForTimeout(800);
    assert.ok(quotes.length >= 1, 'expected at least one real quote request');
    const quoteWithCourses = [...quotes].reverse().find((q) => {
      const sc = q.components && q.components.course && q.components.course.selected_courses;
      return Array.isArray(sc) && sc.length >= 2;
    });
    assert.ok(quoteWithCourses, 'quote body must carry selected_courses (≥2)');
    const quoteIds = quoteWithCourses.components.course.selected_courses.map((c) => c.course_id).sort();
    assert.deepStrictEqual(quoteIds, ['group-a', 'group-b']);
    // No Group lessons[] / custom schedule invent.
    const groupLessons = Array.isArray(quoteWithCourses.lessons)
      ? quoteWithCourses.lessons.filter((l) => l && (l.kind === 'group' || l.course_id))
      : [];
    assert.strictEqual(groupLessons.length, 0, 'quote must not carry Group lessons[]');
    assert.ok(
      !JSON.stringify(quoteWithCourses).includes('schedule_key')
      || !/schedule_key/.test(JSON.stringify(quoteWithCourses.components || {})),
    );

    const before = posts.length;
    await page.locator('#ps-create-submit').click();
    await page.waitForTimeout(1000);

    assert.ok(posts.length > before, 'expected real POST create (no evaluate fallback)');
    const payload = posts[posts.length - 1];
    assert.ok(payload && payload.components && payload.components.course);
    const selected = payload.components.course.selected_courses;
    assert.ok(Array.isArray(selected) && selected.length >= 2, 'POST selected_courses must have ≥2');
    assert.deepStrictEqual(selected.map((c) => c.course_id).sort(), ['group-a', 'group-b']);
    assert.ok(selected.every((c) => c.tier_key), 'each selected course needs tier identity');
    assert.ok(!/unit_amount|amount_cents|price_cents/i.test(JSON.stringify(selected)));
    const postGroupLessons = Array.isArray(payload.lessons)
      ? payload.lessons.filter((l) => l && (l.kind === 'group' || l.course_id))
      : [];
    assert.strictEqual(postGroupLessons.length, 0, 'POST must not carry Group lessons[]');
    assert.strictEqual(
      Number(payload.surfer_count || (payload.components.course && payload.components.course.quantity)),
      2,
    );

    await page.setViewportSize({ width: 390, height: 900 });
    const overflow = await page.evaluate(() => {
      const modal = document.querySelector('#ps-create-modal .portal-schedule-create-drawer');
      return modal ? modal.scrollWidth > modal.clientWidth + 1 : false;
    });
    assert.strictEqual(overflow, false);
    assert.deepStrictEqual(errors, []);
    console.log('PASS focused Create multi-course product buttons real quote+POST wire contract');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
