'use strict';
/**
 * verify:sunset-group-course-card-opt3
 *
 * Served-page proof for Group Course Option 3 closed card + shared equipment editor fix.
 * Run: node scripts/verify-sunset-group-course-card-opt3.js
 */
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
function ok(name, cond, detail) {
  if (!cond) throw new Error('FAIL ' + name + (detail ? ': ' + detail : ''));
  console.log('  PASS  ' + name);
}

(async () => {
  console.log('\nverify:sunset-group-course-card-opt3 — served /staff/ui\n');
  const uiSrc = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-ui.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  ok('pack meta rows marker', /data-admin-pack-meta/.test(uiSrc));
  ok('pack prices 2col marker', /data-admin-pack-prices/.test(uiSrc));
  ok('equipment under meta before prices',
    /adminRenderEquipmentReadout[\s\S]{0,120}adminRenderPackTierReadout/.test(uiSrc));
  ok('eq row actions + last-row add', /portal-admin-equipment-row-actions/.test(uiSrc));
  ok('meta CSS text-3 labels', /\.portal-admin-pack-meta-k\{[^}]*var\(--text-3\)/.test(apiSrc));
  ok('no pack eq purple', !/\.portal-admin-pack-eq-name\{[^}]*#b39ddb/.test(apiSrc));
  ok('equal during/allday grid',
    /portal-admin-equipment-option-fields\{[^}]*minmax\(56px,1fr\)\s+minmax\(56px,1fr\)/.test(apiSrc)
    || /portal-admin-equipment-option-fields\{[^}]*1fr\)\s+minmax\(52px,1fr\)/.test(apiSrc));

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const packWrites = [];
  let pack = {
    pack_id: 'verify-demo-pack',
    label: 'Curso Manana',
    age_band: '12_and_up',
    group_size: 24,
    beaches: ['somo'],
    weekly: 'daily',
    schedules: ['1000_1200'],
    price_tiers: [
      { key: '1_day', label: '1 day', amount_cents: 3500 },
      { key: '2_days', label: '2 days', amount_cents: 7000 },
      { key: '3_days', label: '3 days', amount_cents: 10000 },
      { key: '4_days', label: '4 days', amount_cents: 13000 },
      { key: '5_days', label: '5 days', amount_cents: 16000 },
      { key: '6_days', label: '6 days', amount_cents: 18500 },
      { key: '7_days', label: '7 days', amount_cents: 21000 },
    ],
    equipment_options: [{
      offering_key: 'softboard',
      during_course_price_cents: 0,
      all_day_price_cents: 1000,
      during_course_policy: 'included',
    }],
  };
  const offerings = [
    { offering_key: 'softboard', label: 'Soft board', active: true },
    { offering_key: 'wetsuit', label: 'Wetsuit', active: true },
  ];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/admin/config?**', async (r) => {
    const x = await r.fetch();
    const b = await x.json();
    b.surf_packs = [pack];
    b.private_lesson = b.private_lesson || { enabled: true, label: 'Private', amount_cents: 5000, default_duration_minutes: 120, equipment_options: [] };
    b._equipment_offerings = offerings;
    b.rental_offerings = offerings;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  });
  await page.route('**/staff/admin/config/rental-offerings?**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, offerings }) }));
  await page.route('**/staff/admin/config/surf-packs/verify-demo-pack?**', (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    packWrites.push(body);
    pack = { ...pack, ...body };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, surf_pack: pack }) });
  });

  try {
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    const card = page.locator('[data-admin-pack-card="verify-demo-pack"]');
    await card.waitFor({ timeout: 15000 });

    ok('meta rows present', (await card.locator('[data-admin-pack-meta]').count()) === 1);
    ok('meta has capacity/beaches/frequency/schedule rows',
      (await card.locator('.portal-admin-pack-meta-row').count()) >= 4);
    // Equipment under meta (DOM order): meta then equipment-readout then prices
    const orderOk = await card.evaluate((el) => {
      const kids = Array.from(el.children);
      const mi = kids.findIndex((c) => c.matches && c.matches('[data-admin-pack-meta]'));
      const ei = kids.findIndex((c) => c.matches && c.matches('[data-admin-equipment-readout]'));
      const pi = kids.findIndex((c) => c.matches && c.matches('[data-admin-pack-prices]'));
      return mi >= 0 && ei > mi && pi > ei;
    });
    ok('equipment sits under meta before prices', orderOk);
    ok('2-col prices', (await card.locator('.portal-admin-pack-prices-2col').count()) === 1);
    ok('tier rows rendered', (await card.locator('.portal-admin-pack-tier-row').count()) >= 5);
    const eq = card.locator('[data-admin-equipment-readout]');
    ok('equipment readout', (await eq.count()) === 1);
    ok('equipment label Equipment', (await eq.locator('.portal-admin-pill-label').textContent()).trim() === 'Equipment');
    ok('softboard row', (await eq.locator('[data-equipment-readout-row="softboard"]').count()) === 1);
    const t = await card.innerText();
    ok('Included during', /Included/i.test(t));
    ok('all-day amount', /10\.00/.test(t));

    // Neutral colors on meta/eq
    const accent = await card.evaluate((el) => {
      function isAccent(rgbStr) {
        const m = String(rgbStr).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        if (Math.abs(r - 127) < 25 && Math.abs(g - 168) < 25 && Math.abs(b - 207) < 25) return true;
        if (Math.abs(r - 179) < 25 && Math.abs(g - 157) < 25 && Math.abs(b - 219) < 25) return true;
        if (Math.abs(r - 123) < 25 && Math.abs(g - 191) < 25 && Math.abs(b - 143) < 25) return true;
        return false;
      }
      const nodes = el.querySelectorAll('.portal-admin-pack-meta-k,.portal-admin-pack-meta-v,.portal-admin-pack-eq-name,.portal-admin-private-price-pill-v,.portal-admin-pack-tier-amt');
      for (const n of nodes) {
        if (isAccent(getComputedStyle(n).color)) return getComputedStyle(n).color;
      }
      return '';
    });
    ok('group closed no accent colors', !accent, accent);

    // Edit form equipment layout
    await card.locator('[data-admin-action="edit-pack"]').click();
    const ed = page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-equipment-editor]');
    await ed.waitFor();
    ok('h4 Equipment', (await ed.locator('h4').textContent()).trim() === 'Equipment');
    ok('+ on last row not heading',
      (await ed.locator('[data-admin-equipment-heading] [data-admin-action="add-equipment-option"]').count()) === 0
      && (await ed.locator('[data-equipment-option-row] [data-admin-action="add-equipment-option"]').count()) === 1);

    const geom = await ed.locator('[data-equipment-option-row]').first().evaluate((row) => {
      const d = row.querySelector('.admin-equipment-during-price');
      const a = row.querySelector('.admin-equipment-all-day-price');
      const x = row.querySelector('[data-admin-action="remove-equipment-option"]');
      const plus = row.querySelector('[data-admin-action="add-equipment-option"]');
      if (!d || !a || !x || !plus) return { ok: false };
      const dr = d.getBoundingClientRect(), ar = a.getBoundingClientRect(), xr = x.getBoundingClientRect(), pr = plus.getBoundingClientRect();
      return {
        ok: true,
        equalW: Math.abs(dr.width - ar.width) < 24,
        sameRowX: Math.abs(dr.top - xr.top) < 22 && Math.abs(ar.top - xr.top) < 22,
        plusBesideX: Math.abs(xr.top - pr.top) < 22 && pr.left >= xr.left - 2,
      };
    });
    ok('pack during/allday equal width', geom.ok && geom.equalW, JSON.stringify(geom));
    ok('pack × same row as prices', geom.ok && geom.sameRowX, JSON.stringify(geom));
    ok('pack + beside ×', geom.ok && geom.plusBesideX, JSON.stringify(geom));

    // policy fail-closed
    await ed.locator('[data-equipment-option-row]').first().evaluate((row) => {
      row.setAttribute('data-policy-explicit-invalid', '1');
      const sel = row.querySelector('.admin-equipment-during-policy');
      if (sel) {
        sel.setAttribute('data-policy-explicit-invalid', '1');
        const opt = document.createElement('option');
        opt.value = 'nope'; opt.selected = true; opt.textContent = 'nope';
        sel.appendChild(opt); sel.value = 'nope';
      }
    });
    const before = packWrites.length;
    await page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-action="save-pack"]').click();
    await page.waitForTimeout(150);
    ok('invalid policy no save', packWrites.length === before);

    await page.locator('[data-admin-action="cancel-edit"]').click();
    await card.locator('[data-admin-action="edit-pack"]').click();
    const ed2 = page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-equipment-editor]');
    await ed2.locator('[data-admin-action="add-equipment-option"]').click();
    ok('second row stacked', (await ed2.locator('[data-equipment-option-row]').count()) === 2);
    const row2 = ed2.locator('[data-equipment-option-row]').nth(1);
    await row2.locator('.admin-equipment-offering').selectOption('wetsuit');
    await row2.locator('.admin-equipment-during-policy').selectOption('optional');
    await row2.locator('.admin-equipment-during-price').fill('5.00');
    await row2.locator('.admin-equipment-all-day-price').fill('12.00');
    await page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-action="save-pack"]').click();
    await page.waitForTimeout(200);
    ok('save posted', packWrites.length >= 1);
    const last = packWrites[packWrites.length - 1];
    ok('two equipment options', Array.isArray(last.equipment_options) && last.equipment_options.length === 2);
    ok('wetsuit optional saved',
      last.equipment_options.some((o) => o.offering_key === 'wetsuit' && o.during_course_policy === 'optional'
        && o.during_course_price_cents === 500 && o.all_day_price_cents === 1200));

    // remove to zero
    await card.locator('[data-admin-action="edit-pack"]').click();
    const ed3 = page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-equipment-editor]');
    while ((await ed3.locator('[data-equipment-option-row]').count()) > 0) {
      await ed3.locator('[data-equipment-option-row]').first()
        .locator('[data-admin-action="remove-equipment-option"]').click();
    }
    ok('empty: heading + returns',
      (await ed3.locator('[data-admin-equipment-heading] [data-admin-action="add-equipment-option"]').count()) === 1);
    await page.locator('[data-admin-pack-form="verify-demo-pack"] [data-admin-action="save-pack"]').click();
    await page.waitForTimeout(200);
    const last0 = packWrites[packWrites.length - 1];
    ok('save empty equipment', Array.isArray(last0.equipment_options) && last0.equipment_options.length === 0);
    ok('empty readout',
      (await card.locator('[data-admin-equipment-empty]').count()) === 1);

    ok('no page errors', errors.length === 0, errors.join(' | '));
    console.log('\nverify:sunset-group-course-card-opt3 — ALL CHECKS PASSED\n');
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
})().catch((err) => {
  console.error('\nverify:sunset-group-course-card-opt3 — FAILED\n', err && err.stack || err);
  process.exit(1);
});
