'use strict';
/**
 * verify:sunset-private-course-card-onerow
 *
 * Served-page (/staff/ui) proof for Private Courses card redesign:
 * - closed 2a full-width columns row
 * - one-row edit (identity | equipment | actions) + notes under
 * - equipment editor hooks/IDs preserved
 * - edit → add equipment → save round-trip (incl. policy fail-closed)
 *
 * Run: node scripts/verify-sunset-private-course-card-onerow.js
 */
const fs = require('fs');
const path = require('path');
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

function ok(name, cond, detail) {
  if (!cond) {
    const msg = detail ? `${name}: ${detail}` : name;
    throw new Error('FAIL ' + msg);
  }
  console.log('  PASS  ' + name);
}

(async () => {
  console.log('\nverify:sunset-private-course-card-onerow — served /staff/ui\n');

  // Source markers (static)
  const uiSrc = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-ui.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  ok('closed 2a row marker in UI', /data-admin-private-closed-row/.test(uiSrc));
  ok('one-row edit marker in UI', /data-admin-private-edit-row/.test(uiSrc));
  ok('notes under row', /data-admin-private-notes-field/.test(uiSrc));
  ok('equipment editor still used', /adminRenderEquipmentEditor\(p\.equipment_options/.test(uiSrc));
  ok('enabled checkbox id preserved', /id=\"admin-private-enabled\"/.test(uiSrc));
  ok('label/price/duration/notes ids',
    /id=\"admin-private-label\"/.test(uiSrc)
    && /id=\"admin-private-price\"/.test(uiSrc)
    && /id=\"admin-private-duration\"/.test(uiSrc)
    && /id=\"admin-private-notes\"/.test(uiSrc));
  ok('save/cancel/edit actions',
    /save-private-lesson/.test(uiSrc)
    && /cancel-edit/.test(uiSrc)
    && /edit-private-lesson/.test(uiSrc));
  ok('equipment hooks intact',
    /data-admin-equipment-editor/.test(uiSrc)
    && /data-equipment-option-rows/.test(uiSrc)
    && /admin-equipment-offering/.test(uiSrc)
    && /admin-equipment-during-policy/.test(uiSrc)
    && /admin-equipment-during-price/.test(uiSrc)
    && /admin-equipment-all-day-price/.test(uiSrc)
    && /add-equipment-option/.test(uiSrc)
    && /remove-equipment-option/.test(uiSrc)
    && /course-equipment-policy/.test(uiSrc));
  ok('CSS closed row present', /portal-admin-private-closed-row/.test(apiSrc));
  ok('CSS one-row edit present', /portal-admin-private-edit-row/.test(apiSrc));
  ok('CSS ≤520 collapse present',
    /@media\s*\(max-width:\s*520px\)[\s\S]{0,800}portal-admin-private-edit-row/.test(apiSrc)
    || /@media \(max-width:520px\)[\s\S]*portal-admin-private-closed-row/.test(apiSrc));
  ok('no private label blue accent', !/\.portal-admin-private-col-k[^{]*\{[^}]*#7fa8cf/.test(apiSrc));
  ok('private labels use text-3',
    /\.portal-admin-private-col-k[^{]*\{[^}]*color:\s*var\(--text-3\)/.test(apiSrc));
  ok('private price value not sage',
    !/\.portal-admin-private-price-val\{[^}]*sage/.test(apiSrc)
    && /\.portal-admin-private-price-val\{[^}]*var\(--text\)/.test(apiSrc));
  ok('private eq name not purple',
    !/\.portal-admin-private-eq-name\{[^}]*#b39ddb/.test(apiSrc));
  ok('price/duration ~64px',
    /\.portal-admin-private-price-field\{[^}]*64px/.test(apiSrc)
    && /\.portal-admin-private-duration-field\{[^}]*64px/.test(apiSrc));
  ok('equipment + beside × on last row pattern',
    /portal-admin-equipment-row-actions/.test(uiSrc)
    && /isLast/.test(uiSrc));
  ok('closed row nowrap CSS', /portal-admin-private-closed-row\{[^}]*flex-wrap:\s*nowrap/.test(apiSrc));

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const privateWrites = [];
  let privateLesson = {
    enabled: true,
    label: 'Private Lesson',
    amount_cents: 6000,
    currency: 'EUR',
    price_basis: 'per_session',
    default_duration_minutes: 120,
    notes: 'bring water',
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
    { offering_key: 'carbon_fins', label: 'Carbon fins', active: true },
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
    b.private_lesson = privateLesson;
    b.surf_packs = b.surf_packs || [];
    b._equipment_offerings = offerings;
    b.rental_offerings = offerings;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  });
  await page.route('**/staff/admin/config/rental-offerings?**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, offerings }) }));
  await page.route('**/staff/admin/config/private-lesson?**', (r) => {
    const b = JSON.parse(r.request().postData() || '{}');
    privateWrites.push(b);
    privateLesson = { ...privateLesson, ...b };
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, private_lesson: privateLesson }),
    });
  });

  try {
    await page.goto(base + '/staff/ui', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('[data-admin-private-lesson-card]').waitFor({ timeout: 15000 });

    // Served page must include our CSS (not a stub)
    const styleHasClosed = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets || []);
      for (const sh of sheets) {
        let rules;
        try { rules = sh.cssRules; } catch (_) { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (rule.selectorText && String(rule.selectorText).includes('portal-admin-private-closed-row')) return true;
          if (rule.cssText && String(rule.cssText).includes('portal-admin-private-closed-row')) return true;
        }
      }
      // fallback: style tags text
      return Array.from(document.querySelectorAll('style')).some((s) =>
        (s.textContent || '').includes('portal-admin-private-closed-row'));
    });
    ok('served <style> includes closed-row CSS', styleHasClosed);

    // ── Closed 2a ──
    const closed = page.locator('[data-admin-private-closed-row]');
    ok('closed 2a row renders', (await closed.count()) === 1);
    ok('closed columns present',
      (await page.locator('.portal-admin-private-col-name').count()) >= 1
      && (await page.locator('.portal-admin-private-col-price').count()) >= 1
      && (await page.locator('.portal-admin-private-col-dur').count()) >= 1
      && (await page.locator('.portal-admin-private-col-eq').count()) >= 1);
    ok('edit pencil on closed row',
      (await page.locator('[data-admin-private-closed-row] [data-admin-action="edit-private-lesson"]').count()) === 1);
    const privEq = page.locator('[data-admin-private-lesson-card] [data-admin-equipment-readout]');
    ok('equipment readout marker', (await privEq.count()) === 1);
    ok('pill-label Equipment',
      (await privEq.locator('.portal-admin-pill-label').textContent()).trim() === 'Equipment');
    ok('equipment row key',
      (await privEq.locator('[data-equipment-readout-row="softboard"]').count()) === 1);
    const closedText = await page.locator('[data-admin-private-lesson-card]').innerText();
    ok('closed shows Included for €0 during', /Included/i.test(closedText));
    ok('closed shows all-day amount', /10\.00/.test(closedText));
    ok('closed shows price value', /60\.00|€60/.test(closedText));
    ok('closed notes under row',
      (await page.locator('[data-admin-private-closed-notes]').count()) === 1);

    // Neutral colors on closed row (no blue/purple/green accents)
    const closedColors = await page.evaluate(() => {
      const row = document.querySelector('[data-admin-private-closed-row]');
      if (!row) return { ok: false, why: 'no row' };
      const k = row.querySelector('.portal-admin-private-col-k');
      const price = row.querySelector('.portal-admin-private-price-val');
      const eq = row.querySelector('.portal-admin-private-eq-name');
      const pillV = row.querySelector('.portal-admin-private-price-pill-v');
      function rgb(el) {
        if (!el) return '';
        return getComputedStyle(el).color;
      }
      function isAccent(rgbStr) {
        // Flag only the removed accents (blue label / purple item / sage price),
        // not neutral site greys or primary text.
        const m = String(rgbStr).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (!m) return false;
        const r = +m[1], g = +m[2], b = +m[3];
        // #7fa8cf ≈ 127,168,207
        if (Math.abs(r - 127) < 25 && Math.abs(g - 168) < 25 && Math.abs(b - 207) < 25) return true;
        // #b39ddb ≈ 179,157,219
        if (Math.abs(r - 179) < 25 && Math.abs(g - 157) < 25 && Math.abs(b - 219) < 25) return true;
        // #7bbf8f / sage ≈ 123,191,143
        if (Math.abs(r - 123) < 25 && Math.abs(g - 191) < 25 && Math.abs(b - 143) < 25) return true;
        return false;
      }
      return {
        ok: true,
        k: rgb(k), price: rgb(price), eq: rgb(eq), pillV: rgb(pillV),
        accent: [k, price, eq, pillV].some((el) => isAccent(rgb(el))),
      };
    });
    ok('closed colors readable', closedColors.ok);
    ok('closed no accent text colors', !closedColors.accent, JSON.stringify(closedColors));

    // Single-line closed at desktop width: eq pills/row don't wrap to second line
    const closedLayout = await page.evaluate(() => {
      const row = document.querySelector('[data-admin-private-closed-row]');
      if (!row) return { ok: false };
      const item = row.querySelector('.portal-admin-private-eq-item');
      if (!item) return { ok: true, skip: true };
      const rh = row.getBoundingClientRect().height;
      const ih = item.getBoundingClientRect().height;
      // one line ~ under 48px for the control row (notes are outside)
      return { ok: true, rh, ih, single: rh < 56 && ih < 40 };
    });
    ok('closed row roughly single-line height', closedLayout.skip || closedLayout.single,
      JSON.stringify(closedLayout));

    // ── Open edit one-row ──
    await page.locator('[data-admin-action="edit-private-lesson"]').click();
    const form = page.locator('[data-admin-private-lesson-form]');
    await form.waitFor();
    ok('edit form one-row marker', (await page.locator('[data-admin-private-edit-row]').count()) === 1);
    ok('identity zone', (await page.locator('[data-admin-private-identity]').count()) === 1);
    ok('equip zone', (await page.locator('[data-admin-private-equip-zone]').count()) === 1);
    ok('actions zone', (await page.locator('[data-admin-private-edit-actions]').count()) === 1);
    ok('#admin-private-enabled present', (await page.locator('#admin-private-enabled').count()) === 1);
    ok('#admin-private-enabled is checkbox',
      await page.locator('#admin-private-enabled').evaluate((el) => el.type === 'checkbox'));
    ok('#admin-private-enabled checked readable',
      await page.locator('#admin-private-enabled').evaluate((el) => el.checked === true));
    ok('#admin-private-label', (await page.locator('#admin-private-label').count()) === 1);
    ok('#admin-private-price', (await page.locator('#admin-private-price').count()) === 1);
    ok('#admin-private-duration', (await page.locator('#admin-private-duration').count()) === 1);
    ok('#admin-private-notes under row',
      (await page.locator('[data-admin-private-notes-field] #admin-private-notes').count()) === 1);

    const ed = form.locator('[data-admin-equipment-editor]');
    ok('equipment editor present', (await ed.count()) === 1);
    ok('equipment h4 title', (await ed.locator('h4').textContent()).trim() === 'Equipment');
    ok('equipment option rows container',
      (await ed.locator('[data-equipment-option-rows]').count()) === 1);
    ok('first equipment row hooks',
      (await ed.locator('[data-equipment-option-row] .admin-equipment-offering').count()) >= 1
      && (await ed.locator('[data-equipment-option-row] .admin-equipment-during-policy').count()) >= 1
      && (await ed.locator('[data-equipment-option-row] .admin-equipment-during-price').count()) >= 1
      && (await ed.locator('[data-equipment-option-row] .admin-equipment-all-day-price').count()) >= 1
      && (await ed.locator('[data-admin-action="remove-equipment-option"]').count()) >= 1);
    ok('add-equipment-option hook',
      (await ed.locator('[data-admin-action="add-equipment-option"]').count()) === 1);
    // With items present: + sits beside × on the last row (not in heading)
    ok('+ not in heading when rows exist',
      (await ed.locator('[data-admin-equipment-heading] [data-admin-action="add-equipment-option"]').count()) === 0);
    ok('+ beside × on last row',
      (await ed.locator('[data-equipment-option-row] .portal-admin-equipment-row-actions [data-admin-action="add-equipment-option"]').count()) === 1
      && (await ed.locator('[data-equipment-option-row] .portal-admin-equipment-row-actions [data-admin-action="remove-equipment-option"]').count()) >= 1);
    // During and All-day fields equal-ish width; × same row (no vertical offset beyond threshold)
    const fieldGeom = await ed.locator('[data-equipment-option-row]').first().evaluate((row) => {
      const d = row.querySelector('.admin-equipment-during-price');
      const a = row.querySelector('.admin-equipment-all-day-price');
      const x = row.querySelector('[data-admin-action="remove-equipment-option"]');
      if (!d || !a || !x) return { ok: false };
      const dr = d.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      const xr = x.getBoundingClientRect();
      return {
        ok: true,
        dw: dr.width, aw: ar.width,
        sameRow: Math.abs(dr.top - xr.top) < 20 && Math.abs(ar.top - xr.top) < 20,
        equalW: Math.abs(dr.width - ar.width) < 24,
      };
    });
    ok('during/all-day equal width', fieldGeom.ok && fieldGeom.equalW, JSON.stringify(fieldGeom));
    ok('× same row as price fields', fieldGeom.ok && fieldGeom.sameRow, JSON.stringify(fieldGeom));

    // No field overlap at a couple of widths
    async function assertNoOverlap(width) {
      await page.setViewportSize({ width, height: 900 });
      // ensure still in edit
      if ((await page.locator('[data-admin-private-lesson-form]').count()) === 0) {
        await page.locator('[data-admin-action="edit-private-lesson"]').click();
        await page.locator('[data-admin-private-lesson-form]').waitFor();
      }
      const overlap = await page.evaluate(() => {
        const form = document.querySelector('[data-admin-private-lesson-form]');
        if (!form) return 'no-form';
        const els = Array.from(form.querySelectorAll('input,select,button,textarea'));
        const boxes = els.map((el) => {
          const r = el.getBoundingClientRect();
          return { el, r };
        }).filter((x) => x.r.width > 2 && x.r.height > 2 && getComputedStyle(x.el).visibility !== 'hidden' && getComputedStyle(x.el).opacity !== '0');
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i].r, b = boxes[j].r;
            if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
            // ignore tiny 1px anti-alias collisions
            const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (ox > 4 && oy > 4) {
              return `overlap@${Math.round(a.left)},${Math.round(a.top)} w${Math.round(ox)}xh${Math.round(oy)}`;
            }
          }
        }
        return '';
      });
      ok('no control overlap @' + width, !overlap, overlap);
    }
    await assertNoOverlap(1280);
    await assertNoOverlap(980);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Invalid policy fail-closed: set explicit invalid via evaluate, then try save
    await ed.locator('[data-equipment-option-row]').first().evaluate((row) => {
      row.setAttribute('data-policy-explicit-invalid', '1');
      const sel = row.querySelector('.admin-equipment-during-policy');
      if (sel) {
        sel.setAttribute('data-policy-explicit-invalid', '1');
        // inject invalid option selected
        const opt = document.createElement('option');
        opt.value = 'not_a_policy';
        opt.selected = true;
        opt.textContent = 'not_a_policy — invalid';
        sel.appendChild(opt);
        sel.value = 'not_a_policy';
      }
    });
    const writesBefore = privateWrites.length;
    await page.locator('[data-admin-action="save-private-lesson"]').click();
    await page.waitForTimeout(150);
    ok('invalid policy does not POST save', privateWrites.length === writesBefore);

    // Cancel and re-open clean
    await page.locator('[data-admin-action="cancel-edit"]').click();
    await page.locator('[data-admin-action="edit-private-lesson"]').click();
    await form.waitFor();

    // Add second equipment item + save
    const ed2 = page.locator('[data-admin-private-lesson-form] [data-admin-equipment-editor]');
    await ed2.locator('[data-admin-action="add-equipment-option"]').click();
    ok('second item row stacked', (await ed2.locator('[data-equipment-option-row]').count()) === 2);
    const row2 = ed2.locator('[data-equipment-option-row]').nth(1);
    await row2.locator('.admin-equipment-offering').selectOption('wetsuit');
    await row2.locator('.admin-equipment-during-policy').selectOption('optional');
    await row2.locator('.admin-equipment-during-price').fill('5.00');
    await row2.locator('.admin-equipment-all-day-price').fill('12.00');
    await page.locator('#admin-private-notes').fill('bring water + towel');
    await page.locator('[data-admin-action="save-private-lesson"]').click();
    await page.waitForTimeout(200);

    ok('save posted', privateWrites.length >= 1);
    const last = privateWrites[privateWrites.length - 1];
    ok('save keeps enabled', last.enabled === true);
    ok('save keeps label', last.label === 'Private Lesson');
    ok('save notes', last.notes === 'bring water + towel');
    ok('save two equipment options', Array.isArray(last.equipment_options) && last.equipment_options.length === 2);
    ok('second option wetsuit optional',
      last.equipment_options.some((o) => o.offering_key === 'wetsuit'
        && o.during_course_policy === 'optional'
        && o.during_course_price_cents === 500
        && o.all_day_price_cents === 1200));

    // After save: closed 2a again with both items
    await page.locator('[data-admin-private-closed-row]').waitFor({ timeout: 5000 });
    ok('back to closed after save', (await page.locator('[data-admin-private-closed-row]').count()) === 1);
    ok('two readout rows after save',
      (await page.locator('[data-admin-private-lesson-card] [data-equipment-readout-row]').count()) === 2);

    // Remove to zero
    await page.locator('[data-admin-action="edit-private-lesson"]').click();
    const ed3 = page.locator('[data-admin-private-lesson-form] [data-admin-equipment-editor]');
    while ((await ed3.locator('[data-equipment-option-row]').count()) > 0) {
      await ed3.locator('[data-equipment-option-row]').first()
        .locator('[data-admin-action="remove-equipment-option"]').click();
    }
    ok('removed to zero rows', (await ed3.locator('[data-equipment-option-row]').count()) === 0);
    await page.locator('[data-admin-action="save-private-lesson"]').click();
    await page.waitForTimeout(200);
    const last0 = privateWrites[privateWrites.length - 1];
    ok('save empty equipment_options', Array.isArray(last0.equipment_options) && last0.equipment_options.length === 0);
    ok('empty equipment state',
      (await page.locator('[data-admin-private-lesson-card] [data-admin-equipment-empty]').count()) === 1);

    // Mobile collapse still opens edit without throw
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('[data-admin-action="edit-private-lesson"]').click();
    ok('edit opens at 390', (await page.locator('[data-admin-private-edit-row]').count()) === 1);
    ok('hooks still present at 390',
      (await page.locator('#admin-private-enabled').count()) === 1
      && (await page.locator('[data-admin-action="add-equipment-option"]').count()) === 1);
    await page.locator('[data-admin-action="cancel-edit"]').click();

    ok('no page errors', errors.length === 0, errors.join(' | '));
    console.log('\nverify:sunset-private-course-card-onerow — ALL CHECKS PASSED\n');
  } finally {
    await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
  }
})().catch((err) => {
  console.error('\nverify:sunset-private-course-card-onerow — FAILED\n', err && err.stack || err);
  process.exit(1);
});
