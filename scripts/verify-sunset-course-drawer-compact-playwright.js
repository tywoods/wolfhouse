'use strict';
/**
 * Generated /staff/ui Playwright gate: Group Course edit-drawer compact redesign.
 *
 * Opens real Admin → Group courses → Edit with fixture interception.
 * Asserts compact equipment/price/time geometry, copy contract, remove paths,
 * value preservation, and no overflow at 390px + desktop drawer width.
 *
 * Artifact screenshots (outside git): /opt/data/cache/sunset-course-drawer/
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Isolated staging worktrees intentionally do not duplicate node_modules.
// Prefer normal resolution; fall back only inside this verifier process.
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
const assert = require('assert');

function pw() {
  try { return require('playwright'); }
  catch (e) { return require('/opt/data/workspaces/wolfhouse-grok/node_modules/playwright'); }
}

const ARTIFACT_DIR = '/opt/data/cache/sunset-course-drawer';
const listen = (s) => new Promise((r, j) => {
  s.once('error', j);
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`));
});

function ok(cond, msg) {
  assert.ok(cond, msg);
}

function visibleTextOf(nodeText) {
  return String(nodeText || '').replace(/\s+/g, ' ').trim();
}

async function noOverflow(page, card) {
  return page.evaluate((sel) => {
    const doc = document.documentElement;
    const body = document.body;
    const cardEl = document.querySelector(sel);
    if (!cardEl) return { ok: false, reason: 'missing card' };
    const docOverflow = doc.scrollWidth > doc.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1;
    const cardOverflow = cardEl.scrollWidth > cardEl.clientWidth + 1;
    const cardRect = cardEl.getBoundingClientRect();
    const outsides = [];
    cardEl.querySelectorAll('select,input,button,label,.portal-admin-pill').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.right > cardRect.right + 1.5 || r.left < cardRect.left - 1.5) {
        outsides.push((el.className || el.tagName || '').toString().slice(0, 80));
      }
    });
    return {
      ok: !docOverflow && !cardOverflow && outsides.length === 0,
      docOverflow,
      cardOverflow,
      outsides,
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      cardScroll: cardEl.scrollWidth,
      cardClient: cardEl.clientWidth,
    };
  }, card);
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({ headless: true });
  // Start desktop-wide so top-level Admin tab is visible (mobile uses nav menu).
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  let pack = {
    pack_id: 'verify-compact-pack',
    label: 'Curso Mañana',
    age_band: 'all_ages',
    group_size: 24,
    beaches: ['somo'],
    weekly: 'daily',
    schedules: ['1000_1200'],
    price_tiers: [
      { key: '1_day', label: '1 day', hours: 2, amount_cents: 3500 },
    ],
    equipment_options: [
      {
        offering_key: 'surfboard_wetsuit',
        during_course_price_cents: 0,
        all_day_price_cents: 1000,
      },
    ],
  };
  const offerings = [
    { offering_key: 'surfboard_wetsuit', label: 'Surfboard + Wetsuit', active: true },
    { offering_key: 'softboard', label: 'Softboard', active: true },
    { offering_key: 'carbon_fins', label: 'Carbon fins', active: true },
  ];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route('**/staff/admin/config?**', async (r) => {
    const x = await r.fetch();
    const b = await x.json();
    b.surf_packs = [pack];
    b.prices = [];
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  });
  await page.route('**/staff/admin/config/rental-offerings?**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, offerings }),
    }));

  try {
    await page.goto(base + '/staff/ui');
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.waitForFunction(() => {
      const b = document.querySelector('button.tab-btn[data-tab="admin"]');
      return b && b.style.display !== 'none' && b.offsetParent !== null;
    }, { timeout: 20000 });
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 15000 });
    await page.locator('#admin-tab-pricing').click();

    const card = page.locator('[data-admin-pack-card="verify-compact-pack"]');
    await card.waitFor({ timeout: 10000 });
    await card.locator('[data-admin-action="edit-pack"]').click();

    const form = page.locator('[data-admin-pack-form="verify-compact-pack"]');
    await form.waitFor();
    const editor = form.locator('[data-admin-equipment-editor]');
    await editor.waitFor();

    // Narrow to mobile-ish drawer width for primary layout contract + RED screenshot
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(80);

    // Capture baseline (RED or GREEN) artifact at mobile width
    const shotName = process.env.COMPACT_SHOT_NAME || 'before-red.png';
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, shotName),
      fullPage: true,
    });

    // ── Equipment compact row contract ──
    const eqRow = editor.locator('[data-equipment-option-row]').first();
    ok(await eqRow.count() === 1, 'equipment row present from seed');
    const select = eqRow.locator('select.admin-equipment-offering');
    const during = eqRow.locator('input.admin-equipment-during-price');
    const allDay = eqRow.locator('input.admin-equipment-all-day-price');
    const eqRemove = eqRow.locator('[data-admin-action="remove-equipment-option"]');
    ok(await select.count() === 1, 'equipment select present');
    ok(await during.count() === 1, 'during price input present');
    ok(await allDay.count() === 1, 'all-day price input present');
    ok(await eqRemove.count() === 1, 'equipment remove control present');

    // Values preserved (0.00 / 10.00)
    assert.strictEqual(await select.inputValue(), 'surfboard_wetsuit');
    assert.strictEqual(await during.inputValue(), '0.00');
    assert.strictEqual(await allDay.inputValue(), '10.00');

    // No full-width generic "Remove" text button in equipment editor
    const removeText = visibleTextOf(await eqRemove.innerText());
    ok(!/^remove$/i.test(removeText), 'equipment remove must not be full-width text "Remove" (use icon ×)');
    const eqRemoveAria = String(await eqRemove.getAttribute('aria-label') || '');
    const eqRemoveTitle = String(await eqRemove.getAttribute('title') || '');
    ok(/remove equipment/i.test(eqRemoveAria) || /remove equipment/i.test(eqRemoveTitle),
      'equipment × accessible name/title must say Remove equipment, got aria=' + eqRemoveAria + ' title=' + eqRemoveTitle);
    ok((await eqRemove.innerText()).includes('×') || (await eqRemove.textContent()).includes('×'),
      'equipment remove is icon ×');

    // Row geometry: select + 2 prices + × on one compact row (same baseline band)
    const geom = await eqRow.evaluate((row) => {
      const sel = row.querySelector('select.admin-equipment-offering');
      const d = row.querySelector('input.admin-equipment-during-price');
      const a = row.querySelector('input.admin-equipment-all-day-price');
      const x = row.querySelector('[data-admin-action="remove-equipment-option"]');
      const rs = sel.getBoundingClientRect();
      const rd = d.getBoundingClientRect();
      const ra = a.getBoundingClientRect();
      const rx = x.getBoundingClientRect();
      const midY = (el) => el.top + el.height / 2;
      const sameRow =
        Math.abs(midY(rs) - midY(rd)) < 18
        && Math.abs(midY(rs) - midY(ra)) < 18
        && Math.abs(midY(rs) - midY(rx)) < 22;
      return {
        sameRow,
        selectW: rs.width,
        duringW: rd.width,
        allDayW: ra.width,
        removeW: rx.width,
        removeH: rx.height,
        orderOk: rs.left < rd.left && rd.left < ra.left && ra.left < rx.left,
        fullWidthRemove: rx.width > row.getBoundingClientRect().width * 0.8,
      };
    });
    ok(geom.sameRow, 'equipment controls share one compact row (not stacked full-width Remove)');
    ok(!geom.fullWidthRemove, 'equipment × must not be full-width action strip');
    ok(geom.orderOk, 'equipment order: select, during, all-day, ×');
    ok(geom.selectW >= 120, 'equipment select has priority width (>=120), got ' + geom.selectW);
    ok(geom.selectW > geom.duringW && geom.selectW > geom.allDayW,
      'equipment select wider than price inputs');
    ok(geom.duringW >= 52 && geom.allDayW >= 52, 'price inputs usable width');

    // No redundant column label "Equipment" on the item field (section h4 remains)
    const editorText = visibleTextOf(await editor.innerText());
    const h4 = visibleTextOf(await editor.locator('h4').innerText());
    assert.strictEqual(h4, 'Equipment');
    // Count standalone field labels: should not re-label the dropdown "Equipment"
    const itemLabels = await eqRow.locator('label').evaluateAll((labs) =>
      labs.map((l) => (l.childNodes[0] && l.childNodes[0].textContent || l.textContent || '').trim()));
    ok(!itemLabels.some((t) => /^equipment$/i.test(t)),
      'no redundant Equipment column label on dropdown, labels=' + JSON.stringify(itemLabels));

    // Price labels: short During Course / All Day — NO euro on equipment (too tight).
    // Only Price for amount may show a visible € adornment in this Group Course edit form.
    const labelBlob = itemLabels.join(' | ');
    ok(!/price\s*\(€\)/i.test(labelBlob), 'no parenthetical euro-only "price (€)" label lines');
    ok(/during course/i.test(labelBlob) && /all day/i.test(labelBlob),
      'During Course / All Day labels present: ' + labelBlob);
    ok(!/€/.test(labelBlob), 'equipment row labels must not include €, labels=' + labelBlob);
    ok(await eqRow.locator('.portal-admin-currency').count() === 0,
      'no euro adornment inside equipment price fields');

    // Add equipment still works; remove second synthetic row without submit
    await editor.locator('[data-admin-action="add-equipment-option"]').click();
    assert.strictEqual(await editor.locator('[data-equipment-option-row]').count(), 2, 'Add equipment adds a row');
    await editor.locator('[data-equipment-option-row]').nth(1)
      .locator('[data-admin-action="remove-equipment-option"]').click();
    assert.strictEqual(await editor.locator('[data-equipment-option-row]').count(), 1,
      'equipment × removes only that assignment without submit');
    // Seed row values still intact
    assert.strictEqual(await during.inputValue(), '0.00');
    assert.strictEqual(await allDay.inputValue(), '10.00');

    // ── Price for compact row ──
    const tierRow = form.locator('[data-pack-tier-row]').first();
    ok(await tierRow.count() === 1, 'price tier row present');
    const tierKey = tierRow.locator('select.pack-tier-key');
    const tierAmt = tierRow.locator('input.pack-tier-amount');
    const tierRemove = tierRow.locator('[data-admin-action="remove-pack-tier"]');
    ok(await tierKey.count() === 1 && await tierAmt.count() === 1 && await tierRemove.count() === 1,
      'price row has duration + amount + ×');
    assert.strictEqual(await tierAmt.inputValue(), '35.00');
    const tierText = visibleTextOf(await tierRow.innerText());
    ok(/\/\s*student/i.test(tierText), 'price row keeps / Student unit copy');
    const tierAria = String(await tierRemove.getAttribute('aria-label') || '');
    const tierTitle = String(await tierRemove.getAttribute('title') || '');
    ok(/remove price tier/i.test(tierAria) || /remove price tier/i.test(tierTitle),
      'price-tier × accessible name/title must say Remove price tier');
    ok((await tierRemove.innerText()).includes('×') || (await tierRemove.textContent()).includes('×'),
      'price-tier remove is icon ×');

    // Exactly one visible € token in the Group Course edit form — owned by Price for amount
    const euroAudit = await form.evaluate((root) => {
      const eurNodes = [];
      const walk = (node) => {
        if (!node) return;
        if (node.nodeType === 3) {
          if (node.nodeValue && node.nodeValue.includes('€')) {
            const parent = node.parentElement;
            if (!parent) return;
            const st = window.getComputedStyle(parent);
            if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return;
            const r = parent.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return;
            eurNodes.push({
              text: String(node.nodeValue).trim().slice(0, 40),
              cls: String(parent.className || ''),
              tag: parent.tagName,
              inTier: !!parent.closest('[data-pack-tier-row]'),
              inEquip: !!parent.closest('[data-equipment-option-row], [data-admin-equipment-editor]'),
              inAmount: !!parent.closest('.portal-admin-pack-tier-amount'),
            });
          }
          return;
        }
        if (node.nodeType === 1) {
          Array.from(node.childNodes).forEach(walk);
        }
      };
      walk(root);
      const amountWrap = root.querySelector('.portal-admin-pack-tier-amount');
      let owned = null;
      if (amountWrap) {
        const curr = amountWrap.querySelector('.portal-admin-currency');
        const inp = amountWrap.querySelector('input.pack-tier-amount');
        if (curr && inp) {
          const rc = curr.getBoundingClientRect();
          const ri = inp.getBoundingClientRect();
          const mid = (r) => r.top + r.height / 2;
          owned = {
            sameBand: Math.abs(mid(rc) - mid(ri)) < 10,
            leftOfInput: rc.right <= ri.left + 2,
            gap: ri.left - rc.right,
            currText: (curr.textContent || '').trim(),
          };
        }
      }
      return { count: eurNodes.length, nodes: eurNodes, owned };
    });
    assert.strictEqual(euroAudit.count, 1, 'exactly one visible € in Group Course edit form, got '
      + euroAudit.count + ' ' + JSON.stringify(euroAudit.nodes));
    ok(euroAudit.nodes[0] && euroAudit.nodes[0].inTier && euroAudit.nodes[0].inAmount && !euroAudit.nodes[0].inEquip,
      'sole € belongs to Price for amount field, not equipment: ' + JSON.stringify(euroAudit.nodes[0]));
    ok(euroAudit.owned && euroAudit.owned.currText === '€', '€ adornment present on Price for amount');
    ok(euroAudit.owned.sameBand && euroAudit.owned.leftOfInput && euroAudit.owned.gap < 12,
      '€ compact and clearly owned by amount (same band, left of input): ' + JSON.stringify(euroAudit.owned));

    const tierGeom = await tierRow.evaluate((row) => {
      const s = row.querySelector('select.pack-tier-key');
      const a = row.querySelector('input.pack-tier-amount');
      const x = row.querySelector('[data-admin-action="remove-pack-tier"]');
      const rs = s.getBoundingClientRect();
      const ra = a.getBoundingClientRect();
      const rx = x.getBoundingClientRect();
      const mid = (r) => r.top + r.height / 2;
      return {
        sameRow: Math.abs(mid(rs) - mid(ra)) < 18 && Math.abs(mid(rs) - mid(rx)) < 22,
        selectW: rs.width,
        amountW: ra.width,
        orderOk: rs.left < ra.left && ra.left < rx.left,
      };
    });
    ok(tierGeom.sameRow, 'price tier is one compact row');
    ok(tierGeom.selectW >= 90, 'duration dropdown usable width');
    ok(tierGeom.amountW >= 52, 'tier price input usable');
    ok(tierGeom.orderOk, 'tier order: duration, price, ×');

    // Add second tier, remove only that one
    await form.locator('[data-admin-action="add-pack-tier"]').click();
    assert.strictEqual(await form.locator('[data-pack-tier-row]').count(), 2, 'add price adds tier row');
    await form.locator('[data-pack-tier-row]').nth(1).locator('input.pack-tier-amount').fill('40.00');
    await form.locator('[data-pack-tier-row]').nth(1).locator('[data-admin-action="remove-pack-tier"]').click();
    assert.strictEqual(await form.locator('[data-pack-tier-row]').count(), 1, 'price-tier × removes only that row');
    assert.strictEqual(await tierAmt.inputValue(), '35.00', 'first tier amount preserved');

    // ── Labels / time / beaches ──
    const formText = visibleTextOf(await form.innerText());
    ok(!/start time\s*\(hh:mm\)/i.test(formText), 'no Start time (HH:MM) suffix');
    ok(!/end time\s*\(hh:mm\)/i.test(formText), 'no End time (HH:MM) suffix');
    ok(/start time/i.test(formText) && /end time/i.test(formText), 'Start/End time labels present');
    ok(/beaches/i.test(formText) && /frequency|daily|sat/i.test(formText), 'Beaches + Frequency present');
    ok(/price for/i.test(formText), 'Price for section present');

    // One-schedule fixture: empty optional second start/end pair must NOT render
    ok(!/second start time/i.test(formText) && !/second end time/i.test(formText),
      'empty optional second schedule row omitted for one-schedule pack');
    assert.strictEqual(
      await form.locator('#admin-pack-verify-compact-pack-schedule-start2').count(),
      0,
      'no second-start input when pack has only one schedule',
    );
    assert.strictEqual(
      await form.locator('#admin-pack-verify-compact-pack-schedule-end2').count(),
      0,
      'no second-end input when pack has only one schedule',
    );

    // Start/End side-by-side at target width
    const timeGeom = await form.evaluate(() => {
      const start = document.querySelector('#admin-pack-verify-compact-pack-schedule-start');
      const end = document.querySelector('#admin-pack-verify-compact-pack-schedule-end');
      if (!start || !end) return { ok: false, reason: 'missing time inputs' };
      const rs = start.getBoundingClientRect();
      const re = end.getBoundingClientRect();
      const mid = (r) => r.top + r.height / 2;
      return {
        ok: true,
        sideBySide: Math.abs(mid(rs) - mid(re)) < 14 && re.left > rs.right - 4,
        startW: rs.width,
        endW: re.width,
        startVal: start.value,
        endVal: end.value,
      };
    });
    ok(timeGeom.ok, 'start/end inputs exist');
    ok(timeGeom.sideBySide, 'Start Time and End Time side by side');
    ok(timeGeom.startW >= 60 && timeGeom.endW >= 60, 'time inputs usable width');
    assert.strictEqual(timeGeom.startVal, '10:00');
    assert.strictEqual(timeGeom.endVal, '12:00');

    // Compact circular danger × — clearly red/danger color (not pale beige ghost)
    const dangerAudit = await form.evaluate(() => {
      const isRedish = (color, borderColor) => {
        const parse = (c) => {
          const m = String(c || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          if (!m) return null;
          return { r: +m[1], g: +m[2], b: +m[3] };
        };
        const c = parse(color);
        const b = parse(borderColor);
        const redOk = (x) => x && x.r >= 140 && x.r > x.g + 20 && x.r > x.b + 20;
        return { colorOk: redOk(c), borderOk: redOk(b), color, borderColor, c, b };
      };
      const check = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, reason: 'missing ' + sel };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const tone = isRedish(cs.color, cs.borderColor || cs.borderTopColor);
        const br = parseFloat(cs.borderRadius) || 0;
        return {
          ok: true,
          w: r.width,
          h: r.height,
          circular: br >= Math.min(r.width, r.height) / 2 - 1,
          compact: r.width <= 36 && r.height <= 36 && r.width >= 22 && r.height >= 22,
          aria: el.getAttribute('aria-label') || '',
          title: el.getAttribute('title') || '',
          text: (el.textContent || '').trim(),
          tone,
        };
      };
      return {
        equip: check('[data-admin-pack-form="verify-compact-pack"] [data-admin-action="remove-equipment-option"]'),
        tier: check('[data-admin-pack-form="verify-compact-pack"] [data-admin-action="remove-pack-tier"]'),
      };
    });
    for (const [name, d] of [['equipment', dangerAudit.equip], ['price-tier', dangerAudit.tier]]) {
      ok(d.ok, name + ' × present');
      ok(d.compact, name + ' × compact circular size, got ' + d.w + 'x' + d.h);
      ok(d.circular, name + ' × circular border-radius');
      ok(d.tone.colorOk || d.tone.borderOk,
        name + ' × danger/red-ish color or border, color=' + d.tone.color + ' border=' + d.tone.borderColor);
      ok((d.text || '').includes('×'), name + ' glyph is ×');
    }
    ok(/remove equipment/i.test(dangerAudit.equip.aria) || /remove equipment/i.test(dangerAudit.equip.title),
      'equipment × accessible name unchanged');
    ok(/remove price tier/i.test(dangerAudit.tier.aria) || /remove price tier/i.test(dangerAudit.tier.title),
      'price-tier × accessible name unchanged');

    // Beaches / Frequency chip padding balance + breathing room
    const chipStats = await form.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('[data-admin-pack-form="verify-compact-pack"] .portal-admin-pill-group'));
      const out = [];
      for (const g of groups) {
        const label = (g.querySelector('.portal-admin-pill-label') || {}).textContent || '';
        if (!/beach|frequen|weekly|daily/i.test(label) && !g.querySelector('[data-admin-pill-group="beaches"], [data-admin-pill-group="weekly"]')) {
          // still capture beaches/weekly via row attr
        }
        const row = g.querySelector('.portal-admin-pill-row');
        if (!row) continue;
        const group = row.getAttribute('data-admin-pill-group') || '';
        if (group !== 'beaches' && group !== 'weekly') continue;
        const pill = row.querySelector('.portal-admin-pill');
        if (!pill) continue;
        const cs = getComputedStyle(pill);
        const padT = parseFloat(cs.paddingTop) || 0;
        const padB = parseFloat(cs.paddingBottom) || 0;
        const lh = parseFloat(cs.lineHeight) || 0;
        const rowRect = row.getBoundingClientRect();
        const next = g.nextElementSibling;
        const nextTop = next ? next.getBoundingClientRect().top : rowRect.bottom + 8;
        const gapAfter = nextTop - rowRect.bottom;
        out.push({
          group,
          padT,
          padB,
          lh,
          gapAfter,
          balanced: Math.abs(padT - padB) <= 1.5 && padT >= 4 && padB >= 4,
          breath: gapAfter >= 6,
        });
      }
      return out;
    });
    ok(chipStats.length >= 2, 'beaches + weekly chip groups measured');
    for (const c of chipStats) {
      ok(c.balanced, c.group + ' chip padding balanced top/bottom, pad=' + c.padT + '/' + c.padB);
      ok(c.breath, c.group + ' has breathing room to next section, gap=' + c.gapAfter);
    }

    // Overflow at 390
    const ov390 = await noOverflow(page, '[data-admin-pack-form="verify-compact-pack"]');
    ok(ov390.ok, 'no horizontal overflow at 390px: ' + JSON.stringify(ov390));

    // Desktop drawer-ish width
    await page.setViewportSize({ width: 1280, height: 900 });
    // re-open edit if needed (viewport change keeps DOM)
    if (!(await form.isVisible().catch(() => false))) {
      await card.locator('[data-admin-action="edit-pack"]').click();
    }
    const ovDesk = await noOverflow(page, '[data-admin-pack-form="verify-compact-pack"]');
    ok(ovDesk.ok, 'no horizontal overflow at desktop: ' + JSON.stringify(ovDesk));

    const geomDesk = await eqRow.evaluate((row) => {
      const sel = row.querySelector('select.admin-equipment-offering');
      const d = row.querySelector('input.admin-equipment-during-price');
      const a = row.querySelector('input.admin-equipment-all-day-price');
      return {
        selectW: sel.getBoundingClientRect().width,
        duringW: d.getBoundingClientRect().width,
        allDayW: a.getBoundingClientRect().width,
      };
    });
    // Pack card grid is ~300px-wide on desktop; select must still own priority vs price fields.
    ok(geomDesk.selectW >= 100, 'desktop equipment select usable priority width, got ' + geomDesk.selectW);
    ok(geomDesk.selectW > geomDesk.duringW && geomDesk.selectW > geomDesk.allDayW,
      'desktop equipment select wider than price inputs');

    // Mobile full-page proof shot (caller may set COMPACT_SHOT_NAME_AFTER)
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(60);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, process.env.COMPACT_SHOT_NAME_AFTER || 'after-green.png'),
      fullPage: true,
    });

    // ── Configured second schedule: still editable + preserved on save ──
    pack = {
      ...pack,
      schedules: ['1000_1200', '1400_1600'],
    };
    const packWrites = [];
    await page.route('**/staff/admin/config/surf-packs/verify-compact-pack?**', async (r) => {
      const b = JSON.parse(r.request().postData() || '{}');
      packWrites.push(b);
      pack = { ...pack, ...b };
      await r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, surf_pack: pack }),
      });
    });
    // Full reload so Admin re-fetches config with the two-schedule pack (cfg is IIFE-local)
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(base + '/staff/ui');
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.waitForFunction(() => {
      const b = document.querySelector('button.tab-btn[data-tab="admin"]');
      return b && b.style.display !== 'none' && b.offsetParent !== null;
    }, { timeout: 20000 });
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 15000 });
    await page.locator('#admin-tab-pricing').click();
    await page.locator('[data-admin-pack-card="verify-compact-pack"] [data-admin-action="edit-pack"]').click();
    const form2 = page.locator('[data-admin-pack-form="verify-compact-pack"]');
    await form2.waitFor();
    const form2Text = visibleTextOf(await form2.innerText());
    ok(/second start time/i.test(form2Text) && /second end time/i.test(form2Text),
      'configured second schedule row is visible for edit');
    assert.strictEqual(await form2.locator('#admin-pack-verify-compact-pack-schedule-start2').inputValue(), '14:00');
    assert.strictEqual(await form2.locator('#admin-pack-verify-compact-pack-schedule-end2').inputValue(), '16:00');
    // Save without changing times — payload must keep both schedule keys
    await form2.locator('[data-admin-action="save-pack"]').click();
    await page.waitForTimeout(200);
    ok(packWrites.length >= 1, 'save-pack wrote payload');
    assert.deepStrictEqual(
      packWrites[packWrites.length - 1].schedules,
      ['1000_1200', '1400_1600'],
      'save payload preserves configured second schedule',
    );

    ok(pageErrors.length === 0, 'no pageerror: ' + pageErrors.join(' | '));
    // Filter noisy non-app console if any
    const realErrors = errors.filter((e) => !/favicon|Download the React/i.test(e));
    ok(realErrors.length === 0, 'no console error: ' + realErrors.join(' | '));

    console.log('PASS generated /staff/ui Group Course edit-drawer compact contract');
    console.log('artifacts:', ARTIFACT_DIR);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error('FAIL', e && e.stack || e);
  process.exit(1);
});
