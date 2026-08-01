'use strict';
/**
 * Generated /staff/ui Playwright gate: Group Course edit-drawer compact redesign
 * + follow-up (full equipment label, heading +, secondary-time reveal)
 * + three-course grid: slim edit cards stay in auto-fill columns (no full-row span).
 *
 * Opens real Admin → Group courses → Edit with fixture interception.
 * Asserts three-pack desktop row geometry while editing, two-row equipment
 * layout inside ~320px cards so Surfboard + Wetsuit fits, heading icon-add,
 * secondary schedule reveal, value preservation, and no overflow at 390 + desktop.
 *
 * Artifact screenshots (outside git): /opt/data/cache/sunset-three-course-grid/
 * Legacy follow-up path kept for prior consumers.
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

const ARTIFACT_DIR = '/opt/data/cache/sunset-three-course-grid';
// Keep legacy paths for any external consumers of COMPACT_SHOT_NAME
const LEGACY_FOLLOWUP_DIR = '/opt/data/cache/sunset-course-drawer-followup';
const LEGACY_ARTIFACT_DIR = '/opt/data/cache/sunset-course-drawer';
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

/** Measure whether the closed <select> presentation can show the selected label fully. */
async function measureSelectLabelFit(page, selectLocator, expectedLabel) {
  return selectLocator.evaluate((sel, expected) => {
    const opt = sel.options[sel.selectedIndex];
    const label = String((opt && opt.textContent) || '').replace(/\s+/g, ' ').trim();
    const cs = getComputedStyle(sel);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // Match select font as closely as possible
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim();
    const textW = ctx.measureText(label).width;
    // Native select chrome (padding + dropdown chevron). Use measured padding + ~22px chevron.
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const chrome = padL + padR + 22;
    const rect = sel.getBoundingClientRect();
    const usable = Math.max(0, rect.width - chrome);
    // Prefer geometry evidence; also report scroll vs client when meaningful
    const scrollW = sel.scrollWidth;
    const clientW = sel.clientWidth;
    return {
      label,
      expected,
      labelMatch: label === expected,
      selectW: rect.width,
      textW,
      usable,
      chrome,
      // Selected presentation fits when usable content box covers measured text
      fits: usable + 0.5 >= textW,
      scrollW,
      clientW,
      scrollFits: scrollW <= clientW + 1,
    };
  }, expectedLabel);
}

/** Three pack cards share one desktop auto-fill row (side-by-side columns). */
async function measurePackGridRow(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('#admin-pack-card-grid, .portal-admin-pack-grid');
    if (!grid) return { ok: false, reason: 'missing pack grid' };
    const cards = Array.from(grid.querySelectorAll('[data-admin-pack-card], .portal-admin-pack-card'));
    if (cards.length < 3) return { ok: false, reason: 'need >=3 cards', count: cards.length };
    const gr = grid.getBoundingClientRect();
    const rects = cards.slice(0, 3).map((c) => {
      const r = c.getBoundingClientRect();
      return {
        id: c.getAttribute('data-admin-pack-card') || '',
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        editing: c.classList.contains('is-editing') || !!c.querySelector('[data-admin-pack-form]'),
      };
    });
    const tops = rects.map((r) => r.top);
    const maxTopDelta = Math.max(...tops) - Math.min(...tops);
    const widths = rects.map((r) => r.width);
    const minW = Math.min(...widths);
    const maxW = Math.max(...widths);
    // Side-by-side: similar tops + strictly increasing lefts (L→R order)
    const ordered = [...rects].sort((a, b) => a.left - b.left);
    const sideBySide =
      maxTopDelta < 48
      && ordered[0].left < ordered[1].left - 20
      && ordered[1].left < ordered[2].left - 20
      && ordered[0].right <= ordered[1].left + 4
      && ordered[1].right <= ordered[2].left + 4;
    const similarCols = maxW - minW <= Math.max(48, gr.width * 0.12);
    const editing = rects.find((r) => r.editing) || rects[0];
    const editingShare = gr.width > 0 ? editing.width / gr.width : 1;
    return {
      ok: true,
      gridW: gr.width,
      count: cards.length,
      rects,
      orderedIds: ordered.map((r) => r.id),
      maxTopDelta,
      minW,
      maxW,
      sideBySide,
      similarCols,
      editingW: editing.width,
      editingShare,
      // Slim column: edited card must stay ~1/3, never dominate the row
      slimEdit: editingShare <= 0.40 && editing.width <= gr.width * 0.40 + 8,
    };
  });
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.mkdirSync(LEGACY_FOLLOWUP_DIR, { recursive: true });
  fs.mkdirSync(LEGACY_ARTIFACT_DIR, { recursive: true });
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await pw().chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu'],
  });
  // Start desktop-wide so top-level Admin tab is visible (mobile uses nav menu).
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  // Fixture: three Group Course packs coexist in one desktop row (production-shaped labels).
  // Production CSS must stay responsive auto-fill — only this test hardcodes three packs.
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
  const siblingPacks = [
    {
      pack_id: 'verify-compact-pack-mid',
      label: 'Curso Medio Dia',
      age_band: 'all_ages',
      group_size: 24,
      beaches: ['somo'],
      weekly: 'daily',
      schedules: ['1200_1400'],
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
    },
    {
      pack_id: 'verify-compact-pack-night',
      label: 'Curso Noche',
      age_band: '12_up',
      group_size: 16,
      beaches: ['somo'],
      weekly: 'weekend',
      schedules: ['1900_2100'],
      price_tiers: [
        { key: '1_day', label: '1 day', hours: 2, amount_cents: 4000 },
      ],
      equipment_options: [
        {
          offering_key: 'surfboard_wetsuit',
          during_course_price_cents: 0,
          all_day_price_cents: 0,
        },
      ],
    },
  ];
  function allPacks() {
    return [pack, ...siblingPacks];
  }
  const offerings = [
    { offering_key: 'surfboard_wetsuit', label: 'Surfboard + Wetsuit', active: true },
    { offering_key: 'softboard', label: 'Softboard', active: true },
    { offering_key: 'carbon_fins', label: 'Carbon fins', active: true },
    {
      offering_key: 'very_long_custom_kit',
      label: 'Premium Longboard Carbon + Full Wetsuit Bundle XXL',
      active: true,
    },
  ];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route('**/staff/admin/config?**', async (r) => {
    const x = await r.fetch();
    const b = await x.json();
    b.surf_packs = allPacks();
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
    const midCard = page.locator('[data-admin-pack-card="verify-compact-pack-mid"]');
    const nightCard = page.locator('[data-admin-pack-card="verify-compact-pack-night"]');
    await midCard.waitFor({ timeout: 10000 });
    await nightCard.waitFor({ timeout: 10000 });

    // ═══════════════════════════════════════════════════════════════════════
    // THREE-COURSE GRID: desktop row stays 3 columns while editing Curso Mañana
    // (primary contract — RED on #339 full-row span of .is-editing pack card)
    // ═══════════════════════════════════════════════════════════════════════
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(100);

    const gridBefore = await measurePackGridRow(page);
    ok(gridBefore.ok, 'three pack cards present before edit: ' + JSON.stringify(gridBefore));
    ok(gridBefore.count === 3, 'fixture yields exactly three Group Course cards, got ' + gridBefore.count);
    ok(gridBefore.sideBySide,
      'before edit: three cards side-by-side in one desktop row: ' + JSON.stringify(gridBefore));
    ok(gridBefore.similarCols,
      'before edit: similar column widths: ' + JSON.stringify(gridBefore));

    await card.locator('[data-admin-action="edit-pack"]').click();

    const form = page.locator('[data-admin-pack-form="verify-compact-pack"]');
    await form.waitFor();
    const editor = form.locator('[data-admin-equipment-editor]');
    await editor.waitFor();
    await page.waitForTimeout(80);

    // Capture desktop RED/GREEN artifact while first card is editing + siblings visible
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, process.env.COMPACT_SHOT_NAME || 'desktop-three-red.png'),
      fullPage: true,
    });
    await page.screenshot({
      path: path.join(LEGACY_FOLLOWUP_DIR, process.env.COMPACT_SHOT_NAME || 'desktop-before-or-red.png'),
      fullPage: true,
    });

    const gridWhile = await measurePackGridRow(page);
    ok(gridWhile.ok, 'three pack cards present while editing: ' + JSON.stringify(gridWhile));
    ok(gridWhile.count === 3, 'while editing: still three cards in grid, got ' + gridWhile.count);
    ok(gridWhile.sideBySide,
      'while editing Curso Mañana: three cards remain side-by-side (must NOT span full grid / push siblings off first row): '
      + JSON.stringify(gridWhile));
    ok(gridWhile.similarCols,
      'while editing: sibling columns retain similar widths: ' + JSON.stringify(gridWhile));
    ok(gridWhile.slimEdit,
      'edited card stays slim (~<=40% pack grid, not full-row span): ' + JSON.stringify(gridWhile));
    // Sibling cards still in first row and retain their columns (not collapsed under full span)
    const siblingWhile = await page.evaluate(() => {
      const mid = document.querySelector('[data-admin-pack-card="verify-compact-pack-mid"]');
      const night = document.querySelector('[data-admin-pack-card="verify-compact-pack-night"]');
      const edit = document.querySelector('[data-admin-pack-card="verify-compact-pack"]');
      if (!mid || !night || !edit) return { ok: false };
      const rm = mid.getBoundingClientRect();
      const rn = night.getBoundingClientRect();
      const re = edit.getBoundingClientRect();
      return {
        ok: true,
        midW: rm.width,
        nightW: rn.width,
        editW: re.width,
        midVisible: rm.width > 80 && rm.height > 40,
        nightVisible: rn.width > 80 && rn.height > 40,
        midRightOfEdit: rm.left > re.left + 40,
        nightRightOfMid: rn.left > rm.left + 40,
      };
    });
    ok(siblingWhile.ok && siblingWhile.midVisible && siblingWhile.nightVisible,
      'siblings remain visible columns while editing: ' + JSON.stringify(siblingWhile));
    ok(siblingWhile.midRightOfEdit && siblingWhile.nightRightOfMid,
      'siblings retain left-to-right columns (Medio Dia, Noche) beside edited card: '
      + JSON.stringify(siblingWhile));

    // ═══════════════════════════════════════════════════════════════════════
    // FOLLOW-UP: Desktop full equipment label + heading + + secondary time
    // ═══════════════════════════════════════════════════════════════════════

    // Equipment heading row: title + adjacent icon-only + (Add equipment)
    const headingAudit = await editor.evaluate((ed) => {
      const h4 = ed.querySelector('h4, .portal-admin-equipment-heading, [data-admin-equipment-heading]');
      // Prefer explicit heading row; fall back to first heading-like node
      const headingRow = ed.querySelector('.portal-admin-equipment-heading-row')
        || (h4 && h4.parentElement);
      const titleEl = ed.querySelector('.portal-admin-equipment-heading-row h4, h4');
      const title = String((titleEl && titleEl.textContent) || '').replace(/\s+/g, ' ').trim();
      const addBtns = Array.from(ed.querySelectorAll('[data-admin-action="add-equipment-option"]'));
      const adds = addBtns.map((btn) => {
        const r = btn.getBoundingClientRect();
        const tr = titleEl ? titleEl.getBoundingClientRect() : null;
        const text = String(btn.textContent || '').replace(/\s+/g, ' ').trim();
        const aria = btn.getAttribute('aria-label') || '';
        const titleAttr = btn.getAttribute('title') || '';
        const midY = (x) => x.top + x.height / 2;
        const beside = tr
          && Math.abs(midY(r) - midY(tr)) < 18
          && r.left >= tr.right - 4
          && r.left <= tr.right + 48;
        return {
          text,
          aria,
          title: titleAttr,
          w: r.width,
          h: r.height,
          iconOnly: text === '+' || text === '＋',
          hasTextAdd: /\+\s*add equipment/i.test(text) || /^add equipment$/i.test(text),
          besideTitle: !!beside,
          accessible: /add equipment/i.test(aria) || /add equipment/i.test(titleAttr),
        };
      });
      // "Below" text button: full "+ Add equipment" still present as a trailing control
      const belowTextAdd = adds.some((a) => a.hasTextAdd && !a.besideTitle);
      const iconBeside = adds.find((a) => a.besideTitle && a.iconOnly);
      return {
        title,
        addCount: adds.length,
        adds,
        belowTextAdd,
        hasIconBeside: !!iconBeside,
        iconBeside: iconBeside || null,
      };
    });
    assert.strictEqual(headingAudit.title, 'Equipment', 'equipment section title is Equipment');
    ok(!headingAudit.belowTextAdd,
      'full "+ Add equipment" text button below rows must be removed; got '
      + JSON.stringify(headingAudit.adds));
    ok(headingAudit.hasIconBeside,
      'icon-only + must sit immediately beside Equipment heading: ' + JSON.stringify(headingAudit));
    ok(headingAudit.iconBeside && headingAudit.iconBeside.accessible,
      '+ must have aria-label/title "Add equipment": ' + JSON.stringify(headingAudit.iconBeside));
    ok(headingAudit.iconBeside
      && headingAudit.iconBeside.w >= 28 && headingAudit.iconBeside.h >= 28,
      '+ touch/visual target >=28px (prefer 32), got '
      + (headingAudit.iconBeside && headingAudit.iconBeside.w) + 'x'
      + (headingAudit.iconBeside && headingAudit.iconBeside.h));

    // Desktop: selected Surfboard + Wetsuit must fully fit in the select
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

    assert.strictEqual(await select.inputValue(), 'surfboard_wetsuit');
    assert.strictEqual(await during.inputValue(), '0.00');
    assert.strictEqual(await allDay.inputValue(), '10.00');

    const deskFit = await measureSelectLabelFit(page, select, 'Surfboard + Wetsuit');
    ok(deskFit.labelMatch, 'selected option text is Surfboard + Wetsuit, got ' + deskFit.label);
    ok(deskFit.fits,
      'desktop select must fully present "Surfboard + Wetsuit" (usable>=textW): '
      + JSON.stringify(deskFit));
    // Text-fit threshold: measured glyph width of the full label + modest chrome
    ok(deskFit.selectW >= deskFit.textW + 20,
      'select rect width >= text-fit threshold (textW+20), got ' + JSON.stringify(deskFit));
    // Prefer scrollWidth evidence when browser reports meaningful difference
    if (deskFit.scrollW > 0 && deskFit.clientW > 0) {
      ok(deskFit.scrollFits || deskFit.fits,
        'scrollWidth<=clientWidth or measured text fits: ' + JSON.stringify(deskFit));
    }

    // While editing inside a three-column desktop row the form stays slim (~320px card),
    // not full-grid expansion. Identity select uses a deliberate two-row layout instead.
    const widthAudit = await page.evaluate(() => {
      const formEl = document.querySelector('[data-admin-pack-form="verify-compact-pack"]');
      const cardEl = document.querySelector('[data-admin-pack-card="verify-compact-pack"]');
      const grid = document.querySelector('#admin-pack-card-grid');
      if (!formEl || !cardEl) return { ok: false, reason: 'missing form/card' };
      const fr = formEl.getBoundingClientRect();
      const cr = cardEl.getBoundingClientRect();
      const gr = grid ? grid.getBoundingClientRect() : null;
      const share = gr && gr.width > 0 ? fr.width / gr.width : 1;
      return {
        ok: true,
        formW: fr.width,
        cardW: cr.width,
        gridW: gr ? gr.width : null,
        share,
        // Slim coexisting column — must NOT full-span
        slim: share <= 0.40 && fr.width <= (gr ? gr.width * 0.40 + 8 : 420),
        // Card is narrow desktop column (~300–400), not admin-wide drawer
        cardNarrow: cr.width <= 420,
      };
    });
    ok(widthAudit.ok && widthAudit.slim,
      'edit form stays slim in pack grid while editing (not full-row span): '
      + JSON.stringify(widthAudit));
    ok(widthAudit.cardNarrow,
      'edited pack card remains ~one desktop column width: ' + JSON.stringify(widthAudit));

    // Slim ~320px card: deliberate two-row equipment (identity full width, then prices+×).
    // Do not rely on viewport media alone — desktop viewport with narrow grid card.
    const geomDesk = await eqRow.evaluate((row) => {
      const sel = row.querySelector('select.admin-equipment-offering');
      const d = row.querySelector('input.admin-equipment-during-price');
      const a = row.querySelector('input.admin-equipment-all-day-price');
      const x = row.querySelector('[data-admin-action="remove-equipment-option"]');
      const rs = sel.getBoundingClientRect();
      const rd = d.getBoundingClientRect();
      const ra = a.getBoundingClientRect();
      const rx = x.getBoundingClientRect();
      const rowR = row.getBoundingClientRect();
      const midY = (el) => el.top + el.height / 2;
      const sameRow =
        Math.abs(midY(rs) - midY(rd)) < 18
        && Math.abs(midY(rs) - midY(ra)) < 18
        && Math.abs(midY(rs) - midY(rx)) < 22;
      const pricesWithX =
        Math.abs(midY(rd) - midY(ra)) < 18
        && Math.abs(midY(rd) - midY(rx)) < 22
        && rd.left < ra.left && ra.left < rx.left;
      const twoRow =
        !sameRow
        && pricesWithX
        && rs.bottom <= rd.top + 10
        && rs.width >= rowR.width * 0.70;
      return {
        sameRow,
        twoRow,
        pricesWithX,
        selectW: rs.width,
        duringW: rd.width,
        allDayW: ra.width,
        removeW: rx.width,
        rowW: rowR.width,
        orderPrices: rd.left < ra.left && ra.left < rx.left,
        selectAbove: rs.bottom <= rd.top + 10,
      };
    });
    ok(geomDesk.twoRow,
      'slim desktop card uses deliberate two-row equipment (select full-width above prices+×): '
      + JSON.stringify(geomDesk));
    ok(geomDesk.selectW >= geomDesk.rowW * 0.70,
      'equipment select owns full card-width first row: ' + JSON.stringify(geomDesk));
    ok(geomDesk.duringW >= 52 && geomDesk.allDayW >= 52, 'desktop price inputs usable width');
    ok(geomDesk.orderPrices && geomDesk.pricesWithX,
      'desktop equipment second row order: During Course, All Day, ×');

    // Click heading + adds exactly one assignment (existing event path)
    const rowsBefore = await editor.locator('[data-equipment-option-row]').count();
    await editor.locator('[data-admin-action="add-equipment-option"]').click();
    assert.strictEqual(
      await editor.locator('[data-equipment-option-row]').count(),
      rowsBefore + 1,
      'heading + adds exactly one equipment assignment',
    );
    // equipment × removes owned row only
    await editor.locator('[data-equipment-option-row]').nth(1)
      .locator('[data-admin-action="remove-equipment-option"]').click();
    assert.strictEqual(
      await editor.locator('[data-equipment-option-row]').count(),
      1,
      'equipment × removes only that assignment without submit',
    );
    assert.strictEqual(await during.inputValue(), '0.00');
    assert.strictEqual(await allDay.inputValue(), '10.00');

    // Arbitrary longer catalog label still safe (select option present; no page error)
    await editor.locator('[data-admin-action="add-equipment-option"]').click();
    const longRow = editor.locator('[data-equipment-option-row]').nth(1);
    await longRow.locator('select.admin-equipment-offering').selectOption('very_long_custom_kit');
    const longFit = await measureSelectLabelFit(
      page,
      longRow.locator('select.admin-equipment-offering'),
      'Premium Longboard Carbon + Full Wetsuit Bundle XXL',
    );
    ok(longFit.labelMatch, 'longer catalog label selectable: ' + JSON.stringify(longFit));
    // May truncate if extremely long — but must not overflow card
    const longOv = await noOverflow(page, '[data-admin-pack-form="verify-compact-pack"]');
    ok(longOv.ok, 'longer label does not cause overflow: ' + JSON.stringify(longOv));
    await longRow.locator('[data-admin-action="remove-equipment-option"]').click();
    assert.strictEqual(await editor.locator('[data-equipment-option-row]').count(), 1);

    // ── Secondary times: default hidden; reveal via production event ──
    const formText0 = visibleTextOf(await form.innerText());
    ok(!/second start time/i.test(formText0) && !/second end time/i.test(formText0),
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

    const addSecondary = form.locator('[data-admin-action="add-secondary-schedule"]');
    ok(await addSecondary.count() === 1, 'Add secondary time control present');
    const addSecText = visibleTextOf(await addSecondary.innerText());
    ok(/add secondary time/i.test(addSecText),
      'button copy is Add secondary time, got: ' + addSecText);
    // Click reveals second pair without submit / without changing primary
    const primaryBefore = {
      start: await form.locator('#admin-pack-verify-compact-pack-schedule-start').inputValue(),
      end: await form.locator('#admin-pack-verify-compact-pack-schedule-end').inputValue(),
    };
    await addSecondary.click();
    await page.waitForTimeout(40);
    ok(await form.locator('#admin-pack-verify-compact-pack-schedule-start2').count() === 1,
      'second start revealed after Add secondary time');
    ok(await form.locator('#admin-pack-verify-compact-pack-schedule-end2').count() === 1,
      'second end revealed after Add secondary time');
    assert.strictEqual(
      await form.locator('#admin-pack-verify-compact-pack-schedule-start').inputValue(),
      primaryBefore.start,
      'primary start unchanged after reveal',
    );
    assert.strictEqual(
      await form.locator('#admin-pack-verify-compact-pack-schedule-end').inputValue(),
      primaryBefore.end,
      'primary end unchanged after reveal',
    );
    // Side-by-side second fields
    const secGeom = await form.evaluate(() => {
      const s = document.querySelector('#admin-pack-verify-compact-pack-schedule-start2');
      const e = document.querySelector('#admin-pack-verify-compact-pack-schedule-end2');
      if (!s || !e) return { ok: false };
      const rs = s.getBoundingClientRect();
      const re = e.getBoundingClientRect();
      const mid = (r) => r.top + r.height / 2;
      return {
        ok: true,
        sideBySide: Math.abs(mid(rs) - mid(re)) < 14 && re.left > rs.right - 4,
      };
    });
    ok(secGeom.ok && secGeom.sideBySide, 'Second Start/End side by side after reveal');
    // Fill secondary values (payload keys exercised later with configured fixture too)
    await form.locator('#admin-pack-verify-compact-pack-schedule-start2').fill('14:00');
    await form.locator('#admin-pack-verify-compact-pack-schedule-end2').fill('16:00');
    // After reveal, the add button should not re-add / may hide
    const addAfter = await form.locator('[data-admin-action="add-secondary-schedule"]').count();
    ok(addAfter === 0 || !(await form.locator('[data-admin-action="add-secondary-schedule"]').isVisible().catch(() => false)),
      'Add secondary time not re-offered once second pair is visible');

    // Cancel / re-open empty: hide second pair again if empty
    // (clear secondary then cancel-edit)
    await form.locator('#admin-pack-verify-compact-pack-schedule-start2').fill('');
    await form.locator('#admin-pack-verify-compact-pack-schedule-end2').fill('');
    await form.locator('[data-admin-action="cancel-edit"]').click();
    await page.waitForTimeout(80);
    await card.locator('[data-admin-action="edit-pack"]').click();
    await form.waitFor();
    assert.strictEqual(
      await form.locator('#admin-pack-verify-compact-pack-schedule-start2').count(),
      0,
      'cancel/rerender with empty second times hides second pair again',
    );
    ok(await form.locator('[data-admin-action="add-secondary-schedule"]').count() === 1,
      'Add secondary time returns after cancel with empty second window');

    // Re-open path complete — rebind locators
    const editor2 = form.locator('[data-admin-equipment-editor]');
    const eqRow2 = editor2.locator('[data-equipment-option-row]').first();
    const select2 = eqRow2.locator('select.admin-equipment-offering');
    const during2 = eqRow2.locator('input.admin-equipment-during-price');
    const allDay2 = eqRow2.locator('input.admin-equipment-all-day-price');
    const eqRemove2 = eqRow2.locator('[data-admin-action="remove-equipment-option"]');

    // ── Existing compact equipment contracts (post-follow-up) ──
    // No full-width generic "Remove" text button
    const removeText = visibleTextOf(await eqRemove2.innerText());
    ok(!/^remove$/i.test(removeText), 'equipment remove must not be full-width text "Remove" (use icon ×)');
    const eqRemoveAria = String(await eqRemove2.getAttribute('aria-label') || '');
    const eqRemoveTitle = String(await eqRemove2.getAttribute('title') || '');
    ok(/remove equipment/i.test(eqRemoveAria) || /remove equipment/i.test(eqRemoveTitle),
      'equipment × accessible name/title must say Remove equipment, got aria=' + eqRemoveAria + ' title=' + eqRemoveTitle);
    ok((await eqRemove2.innerText()).includes('×') || (await eqRemove2.textContent()).includes('×'),
      'equipment remove is icon ×');

    // No redundant column label "Equipment" on the item field (section h4 remains)
    const h4 = visibleTextOf(await editor2.locator('h4').first().innerText());
    assert.strictEqual(h4, 'Equipment');
    const itemLabels = await eqRow2.locator('label').evaluateAll((labs) =>
      labs.map((l) => (l.childNodes[0] && l.childNodes[0].textContent || l.textContent || '').trim()));
    ok(!itemLabels.some((t) => /^equipment$/i.test(t)),
      'no redundant Equipment column label on dropdown, labels=' + JSON.stringify(itemLabels));

    // Price labels: short During Course / All Day — NO euro on equipment
    const labelBlob = itemLabels.join(' | ');
    ok(!/price\s*\(€\)/i.test(labelBlob), 'no parenthetical euro-only "price (€)" label lines');
    ok(/during course/i.test(labelBlob) && /all day/i.test(labelBlob),
      'During Course / All Day labels present: ' + labelBlob);
    ok(!/€/.test(labelBlob), 'equipment row labels must not include €, labels=' + labelBlob);
    ok(await eqRow2.locator('.portal-admin-currency').count() === 0,
      'no euro adornment inside equipment price fields');

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

    // Start/End side-by-side
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

    // Compact circular danger × — clearly red/danger color
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
        const row = g.querySelector('.portal-admin-pill-row');
        if (!row) continue;
        const group = row.getAttribute('data-admin-pill-group') || '';
        if (group !== 'beaches' && group !== 'weekly') continue;
        const pill = row.querySelector('.portal-admin-pill');
        if (!pill) continue;
        const cs = getComputedStyle(pill);
        const padT = parseFloat(cs.paddingTop) || 0;
        const padB = parseFloat(cs.paddingBottom) || 0;
        const rowRect = row.getBoundingClientRect();
        const next = g.nextElementSibling;
        const nextTop = next ? next.getBoundingClientRect().top : rowRect.bottom + 8;
        const gapAfter = nextTop - rowRect.bottom;
        out.push({
          group,
          padT,
          padB,
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

    // ── Mobile 390: one full-width card; identity full-width + price row below; no overflow ──
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(80);

    const geom390 = await eqRow2.evaluate((row) => {
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
      const pricesWithX =
        Math.abs(midY(rd) - midY(ra)) < 18
        && Math.abs(midY(rd) - midY(rx)) < 22
        && rd.left < ra.left && ra.left < rx.left;
      // Two-row wrap: select on its own band above prices+×
      const wrapped =
        !sameRow
        && pricesWithX
        && rs.bottom <= rd.top + 8
        && rs.width >= row.getBoundingClientRect().width * 0.7;
      return {
        sameRow,
        wrapped,
        selectW: rs.width,
        duringW: rd.width,
        allDayW: ra.width,
        removeW: rx.width,
        fullWidthRemove: rx.width > row.getBoundingClientRect().width * 0.8,
        pricesWithX,
      };
    });
    ok(!geom390.fullWidthRemove, '390 equipment × must not be full-width action strip');
    ok(geom390.wrapped,
      'at 390 equipment uses deliberate two-row wrap (select full-width then prices+×): '
      + JSON.stringify(geom390));
    ok(geom390.selectW >= 120,
      '390 equipment identity full-width priority: ' + JSON.stringify(geom390));
    ok(geom390.duringW >= 48 && geom390.allDayW >= 48, '390 price inputs usable width');

    // Heading + still present and usable at 390
    const add390 = editor2.locator('[data-admin-action="add-equipment-option"]');
    ok(await add390.count() === 1, 'Add equipment + still present at 390');
    const add390Box = await add390.boundingBox();
    ok(add390Box && add390Box.width >= 28 && add390Box.height >= 28,
      '+ usable at 390, box=' + JSON.stringify(add390Box));

    const ov390 = await noOverflow(page, '[data-admin-pack-form="verify-compact-pack"]');
    ok(ov390.ok, 'no horizontal overflow at 390px: ' + JSON.stringify(ov390));

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, process.env.COMPACT_SHOT_NAME_MOBILE || 'mobile-390-green.png'),
      fullPage: true,
    });
    await page.screenshot({
      path: path.join(LEGACY_FOLLOWUP_DIR, process.env.COMPACT_SHOT_NAME_MOBILE || 'mobile-390-green.png'),
      fullPage: true,
    });
    // Also write legacy-friendly alias
    await page.screenshot({
      path: path.join(LEGACY_ARTIFACT_DIR, process.env.COMPACT_SHOT_NAME_AFTER || 'after-green.png'),
      fullPage: true,
    });

    // Desktop again — three-column row + overflow + full label still holds
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(60);
    if (!(await form.isVisible().catch(() => false))) {
      await card.locator('[data-admin-action="edit-pack"]').click();
      await form.waitFor();
    }
    const gridFinal = await measurePackGridRow(page);
    ok(gridFinal.ok && gridFinal.sideBySide && gridFinal.slimEdit,
      'desktop three-column slim edit still holds after mobile pass: ' + JSON.stringify(gridFinal));
    const ovDesk = await noOverflow(page, '[data-admin-pack-form="verify-compact-pack"]');
    ok(ovDesk.ok, 'no horizontal overflow at desktop: ' + JSON.stringify(ovDesk));
    // Also no grid-level horizontal overflow
    const ovGrid = await noOverflow(page, '#admin-pack-card-grid');
    ok(ovGrid.ok, 'pack grid has no horizontal overflow at desktop: ' + JSON.stringify(ovGrid));
    const deskFit2 = await measureSelectLabelFit(
      page,
      form.locator('select.admin-equipment-offering').first(),
      'Surfboard + Wetsuit',
    );
    ok(deskFit2.fits, 'desktop full label still fits after mobile pass: ' + JSON.stringify(deskFit2));

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, process.env.COMPACT_SHOT_NAME_DESKTOP || 'desktop-three-green.png'),
      fullPage: true,
    });
    await page.screenshot({
      path: path.join(LEGACY_FOLLOWUP_DIR, 'desktop-green.png'),
      fullPage: true,
    });

    // ── Configured second schedule: auto-shows + preserved on save ──
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
      'configured second schedule row is visible for edit without click');
    assert.strictEqual(await form2.locator('#admin-pack-verify-compact-pack-schedule-start2').inputValue(), '14:00');
    assert.strictEqual(await form2.locator('#admin-pack-verify-compact-pack-schedule-end2').inputValue(), '16:00');
    // No need for Add secondary time when already configured
    ok(await form2.locator('[data-admin-action="add-secondary-schedule"]').count() === 0,
      'Add secondary time hidden when second pair already present');
    // Save without changing times — payload must keep both schedule keys
    await form2.locator('[data-admin-action="save-pack"]').click();
    await page.waitForTimeout(200);
    ok(packWrites.length >= 1, 'save-pack wrote payload');
    assert.deepStrictEqual(
      packWrites[packWrites.length - 1].schedules,
      ['1000_1200', '1400_1600'],
      'save payload preserves configured second schedule',
    );

    // ── Reveal path save: one-schedule pack → add secondary → fill → save ──
    pack = {
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
    packWrites.length = 0;
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
    const form3 = page.locator('[data-admin-pack-form="verify-compact-pack"]');
    await form3.waitFor();
    await form3.locator('[data-admin-action="add-secondary-schedule"]').click();
    await form3.locator('#admin-pack-verify-compact-pack-schedule-start2').fill('15:00');
    await form3.locator('#admin-pack-verify-compact-pack-schedule-end2').fill('17:00');
    await form3.locator('[data-admin-action="save-pack"]').click();
    await page.waitForTimeout(200);
    ok(packWrites.length >= 1, 'save after secondary reveal wrote payload');
    assert.deepStrictEqual(
      packWrites[packWrites.length - 1].schedules,
      ['1000_1200', '1500_1700'],
      'save payload includes revealed secondary schedule keys',
    );

    ok(pageErrors.length === 0, 'no pageerror: ' + pageErrors.join(' | '));
    const realErrors = errors.filter((e) => !/favicon|Download the React/i.test(e));
    ok(realErrors.length === 0, 'no console error: ' + realErrors.join(' | '));

    console.log('PASS generated /staff/ui Group Course three-column slim edit + follow-up contract');
    console.log('artifacts:', ARTIFACT_DIR);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((e) => {
  console.error('FAIL', e && e.stack || e);
  process.exit(1);
});
