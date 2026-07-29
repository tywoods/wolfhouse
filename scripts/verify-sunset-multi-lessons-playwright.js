'use strict';
/**
 * Generated Create multi-lesson contract:
 * real controls → real quote body with lessons[] → real POST with lessons[].
 * No evaluate() payload-builder fallback. No quotes.length >= 1 soft pass.
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

(async () => {
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
      courses: [{
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
      }],
      rentals: [],
      offerings: [{ offering_type: 'private_lesson', equipment_options: [] }],
    }),
  }));
  await page.route('**/staff/schedule/bookings/quote?**', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    const body = JSON.parse(r.request().postData() || '{}');
    quotes.push(body);
    // Require real lessons[] identity on quote — fail closed for transport regressions.
    const lessonCount = Array.isArray(body.lessons) ? body.lessons.length : 0;
    const total = lessonCount >= 2 ? 7000 : 3500;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        total_cents: total,
        subtotal_cents: total,
        line_items: (body.lessons || []).map((l, i) => ({
          component: 'course',
          course_id: l.course_id,
          schedule_key: l.schedule_key,
          total_cents: 3500,
          unit_amount_cents: 1750,
          quantity: 2,
          service_dates: [l.date],
          lesson_identity: `group|${l.course_id}|${l.date}|${l.schedule_key || ''}`,
          lesson_index: i,
        })),
        quote_provenance: { quote_fingerprint: 'fp-multi-' + lessonCount },
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
        booking_code: 'MULTI-LESSON',
        total_cents: 7000,
      }),
    });
  });
  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('#ps-create-booking').click();
    await page.locator('#ps-create-guest').fill('Multi Lesson Guest');
    await page.locator('#ps-create-phone').fill('+34911111111');
    // Hidden date range inputs (compact calendar UI) — set via DOM property + change.
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
    // Ensure group lessons UI is visible (Create wires on activity select).
    await page.evaluate(() => {
      if (typeof scheduleSyncCreateGroupLessonsVisibility === 'function') {
        scheduleSyncCreateGroupLessonsVisibility();
      }
    });
    await page.locator('#ps-create-group-lessons-wrap').waitFor({ state: 'visible', timeout: 5000 });
    const firstRow = page.locator('.portal-schedule-group-lesson-row').first();
    await firstRow.locator('[data-group-lesson-date]').fill('2026-08-20');
    await firstRow.locator('[data-group-lesson-course]').selectOption('group-a');
    await firstRow.locator('[data-group-lesson-schedule]').selectOption('0930_1130');
    await page.locator('#ps-create-add-group-lesson').click();
    const second = page.locator('.portal-schedule-group-lesson-row').nth(1);
    await second.locator('[data-group-lesson-date]').fill('2026-08-20');
    await second.locator('[data-group-lesson-course]').selectOption('group-a');
    await second.locator('[data-group-lesson-schedule]').selectOption('1215_1415');
    // Nudge quote by changing schedule (real control) so transport fires.
    await second.locator('[data-group-lesson-schedule]').selectOption('1215_1415');
    await page.waitForTimeout(800);

    // REQUIRE a real successful quote carrying ≥2 lessons (no soft quotes.length fallback).
    assert.ok(quotes.length >= 1, 'expected at least one real quote request');
    const quoteWithLessons = [...quotes].reverse().find(
      (q) => Array.isArray(q.lessons) && q.lessons.length >= 2,
    );
    assert.ok(quoteWithLessons, 'quote body must carry lessons[] (≥2) — transport regression');
    assert.ok(quoteWithLessons.lessons.every((l) => l.kind === 'group' || l.course_id));
    assert.ok(quoteWithLessons.lessons.every((l) => String(l.date).slice(0, 10) === '2026-08-20'));

    const before = posts.length;
    await page.locator('#ps-create-submit').click();
    await page.waitForTimeout(1000);

    // REQUIRE real POST only — no evaluate(scheduleReadCreatePayload) fallback.
    assert.ok(posts.length > before, 'expected real POST create (no evaluate fallback)');
    const payload = posts[posts.length - 1];
    assert.ok(payload && Array.isArray(payload.lessons), 'POST lessons[] must be present');
    assert.ok(payload.lessons.length >= 2, `POST expected ≥2 lessons got ${payload.lessons.length}`);
    assert.ok(payload.lessons.every((l) => l.kind === 'group' || l.course_id));
    assert.ok(payload.lessons.every((l) => String(l.date).slice(0, 10) === '2026-08-20'));
    const ids = new Set(payload.lessons.map((l) => `${l.course_id}|${l.schedule_key || ''}`));
    assert.ok(ids.size >= 2, 'same-day lessons need distinct schedule/course identity');
    assert.strictEqual(
      Number(payload.surfer_count || (payload.components && payload.components.course && payload.components.course.quantity)),
      2,
    );
    assert.ok(!/unit_amount|amount_cents|price_cents/i.test(JSON.stringify(payload.lessons)));

    await page.setViewportSize({ width: 390, height: 900 });
    const overflow = await page.evaluate(() => {
      const modal = document.querySelector('#ps-create-modal .portal-schedule-create-drawer');
      return modal ? modal.scrollWidth > modal.clientWidth + 1 : false;
    });
    assert.strictEqual(overflow, false);
    assert.deepStrictEqual(errors, []);
    console.log('PASS focused Create multi-lesson real quote+POST wire contract');
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
