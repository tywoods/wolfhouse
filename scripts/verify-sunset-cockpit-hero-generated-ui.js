#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function enableSharedWorktreeDependencies() {
  try { require.resolve('dotenv'); return; } catch (_) {}
  const shared = '/opt/wolfhouse/WH/node_modules';
  if (!fs.existsSync(shared)) return;
  const parts = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  if (!parts.includes(shared)) parts.unshift(shared);
  process.env.NODE_PATH = parts.join(path.delimiter);
  Module._initPaths();
}
enableSharedWorktreeDependencies();

function playwright() {
  try { return require('playwright'); } catch (_) {
    return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright');
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function localIsoDate() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function bookingRows({ id, guest, cancelled }) {
  const status = cancelled ? 'cancelled' : 'confirmed';
  const common = {
    booking_id: id,
    booking_code: id,
    guest_name: guest,
    service_date: localIsoDate(),
    quantity: 1,
    booking_status: status,
    service_status: status,
    status,
    _isCancelled: cancelled || undefined,
  };
  return [
    {
      ...common,
      service_record_id: `${id}-course`,
      service_type: 'course',
      staff_ui_service_type: 'course',
      service_time_local: '10:00',
      slot_time: '10:00-12:00',
      metadata: {
        component: 'course',
        course_id: 'verify-demo-pack',
        course_label: 'Curso Mañana',
        slot_time: '10:00-12:00',
      },
    },
    {
      ...common,
      service_record_id: `${id}-gear`,
      service_type: 'addon_service',
      staff_ui_service_type: 'course_equipment',
      metadata: {
        component: 'course_equipment',
        course_equipment: true,
        offering_key: 'surfboard_wetsuit',
        offering_label: 'Surfboard + Wetsuit',
        label: 'Surfboard + Wetsuit',
        fulfillment: 'during_course',
        course_id: 'verify-demo-pack',
      },
    },
  ];
}

async function main() {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await playwright().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const scheduleRequests = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const rows = [
    ...bookingRows({ id: 'hero-ana', guest: 'Ana', cancelled: false }),
    ...bookingRows({ id: 'hero-bob', guest: 'Bob', cancelled: false }),
    ...bookingRows({ id: 'hero-cam', guest: 'Cam', cancelled: false }),
    ...bookingRows({ id: 'hero-don', guest: 'Don', cancelled: false }),
    ...bookingRows({ id: 'hero-edu', guest: 'Edu', cancelled: true }),
    // Later course exact item must never leak into First up.
    {
      ...bookingRows({ id: 'hero-later', guest: 'Later', cancelled: false })[0],
      service_record_id: 'hero-later-course',
      service_time_local: '16:00',
      slot_time: '16:00-18:00',
      metadata: {
        component: 'course',
        course_id: 'later-pack',
        course_label: 'Curso Tarde',
        slot_time: '16:00-18:00',
      },
    },
    {
      ...bookingRows({ id: 'hero-later', guest: 'Later', cancelled: false })[1],
      service_record_id: 'hero-later-gear',
      metadata: {
        component: 'course_equipment', course_equipment: true,
        offering_key: 'softboard', offering_label: 'Softboard', label: 'Softboard',
        fulfillment: 'during_course', course_id: 'later-pack',
      },
    },
  ];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.surf_packs = [
      {
        pack_id: 'verify-demo-pack', label: 'Curso Mañana', group_size: 24,
        schedules: [{ key: '1000_1200', label: '10:00-12:00' }],
        enabled: true,
      },
      {
        pack_id: 'later-pack', label: 'Curso Tarde', group_size: 24,
        schedules: [{ key: '1600_1800', label: '16:00-18:00' }],
        enabled: true,
      },
    ];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route(/\/staff\/schedule\/day(?:\?|$)/, async (route) => {
    scheduleRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        date: localIsoDate(),
        lessons: [],
        gear: [],
        rows,
      }),
    });
  });

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="portal-home"]').click();
    await page.locator('#ps-day-cockpit').waitFor();
    await page.waitForFunction(() => {
      const hero = document.querySelector('#ps-day-cockpit .ck-now');
      return hero && /First up:\s*Curso Mañana/i.test(hero.textContent || '');
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const hero = document.querySelector('#ps-day-cockpit .ck-now');
      return hero && /4\s+Surfboard \+ Wetsuit\s+to prep/i.test(hero.textContent || '');
    }, null, { timeout: 10000 });

    const heroText = await page.locator('#ps-day-cockpit .ck-now').innerText();
    assert.match(heroText, /First up:\s*Curso Mañana/i);
    assert.match(heroText, /4\s+Surfboard \+ Wetsuit\s+to prep/i);
    assert.doesNotMatch(heroText, /0 boards\s*[·.]\s*0 wetsuits/i);
    assert.doesNotMatch(heroText, /Softboard\s+to prep/i, 'later-session gear leaked into First up');
    assert.ok(scheduleRequests.length >= 1, 'real Schedule day endpoint was not requested');
    assert.deepStrictEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);

    console.log('PASS generated /staff/ui requested real Schedule day endpoint');
    console.log('PASS production builder/mapping/classification rendered 4 active exact items');
    console.log('PASS cancelled fifth guest and later-course gear excluded');
    console.log(`HERO ${JSON.stringify(heroText.replace(/\s+/g, ' ').trim())}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err && (err.stack || err.message || err));
  process.exit(1);
});
