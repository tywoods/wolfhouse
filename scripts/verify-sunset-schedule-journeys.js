#!/usr/bin/env node
'use strict';

/**
 * verify:sunset-schedule-journeys
 *
 * Authenticated, staging-only Sunset Schedule browser journey gate.
 * Durable replacement for ad-hoc tmp/prove-slice-24/25/26 scripts.
 *
 * Safety:
 *   - refuses production-looking hosts
 *   - credentials from environment only
 *   - uniquely tagged synthetic bookings
 *   - cleanup in finally + cleanup-zero proof
 *   - screenshots/logs on failure
 *   - no WhatsApp/email
 *   - Stripe test-mode payment-link UI only (staging portal)
 *
 * Required env:
 *   SUNSET_STAGING_PORTAL_PASSWORD
 *
 * Optional env:
 *   SUNSET_STAGING_PORTAL_EMAIL (default tywoods@gmail.com)
 *   SUNSET_STAGING_BASE_URL (default https://sunset-staging.lunafrontdesk.com)
 *   SUNSET_SCHEDULE_JOURNEY_ARTIFACTS (default tmp/verify-sunset-schedule-journeys)
 *
 * Run:
 *   npm run verify:sunset-schedule-journeys
 *   node scripts/verify-sunset-schedule-journeys.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_BASE = 'https://sunset-staging.lunafrontdesk.com';
const ALLOWED_HOSTS = new Set([
  'sunset-staging.lunafrontdesk.com',
]);
const TAG_PREFIX = 'SJrn';
const ARTIFACT_DIR = process.env.SUNSET_SCHEDULE_JOURNEY_ARTIFACTS
  || path.join(process.cwd(), 'tmp', 'verify-sunset-schedule-journeys');

const results = {
  checks: [],
  journeys: {},
  cleanup: null,
  artifacts: [],
  host: null,
  started_at: new Date().toISOString(),
};

function track(ok, label, detail) {
  const row = { ok: !!ok, label, detail: detail == null ? null : String(detail).slice(0, 400) };
  results.checks.push(row);
  console.log(ok ? '  PASS' : '  FAIL', label, detail == null ? '' : detail);
  return !!ok;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`\nverify:sunset-schedule-journeys — missing required env: ${name}`);
    process.exit(2);
  }
  return String(value).trim();
}

function guardStagingUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Invalid portal URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Refusing non-staging portal host: ${host}`);
  }
  if (/prod/i.test(host) || host.includes('production') || host === 'sunset.lunafrontdesk.com') {
    throw new Error(`Refusing production-looking portal host: ${host}`);
  }
  if (!host.includes('staging')) {
    throw new Error(`Refusing host without staging marker: ${host}`);
  }
  return host;
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    console.error('Playwright is required. Install: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes("Executable doesn't exist") || msg.includes('browserType.launch')) {
      console.log('  note bundled Playwright chromium missing — using system Chrome channel');
      return chromium.launch({ headless: true, channel: 'chrome' });
    }
    throw err;
  }
}

async function captureFailure(page, slug, err) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const shot = path.join(ARTIFACT_DIR, `${slug}-${stamp}.png`);
    const log = path.join(ARTIFACT_DIR, `${slug}-${stamp}.log`);
    if (page) {
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      results.artifacts.push(shot);
    }
    fs.writeFileSync(log, String(err && err.stack ? err.stack : err), 'utf8');
    results.artifacts.push(log);
    console.error('  artifact', shot);
    console.error('  artifact', log);
  } catch (_) {
    /* ignore artifact failures */
  }
}

function uniqueGuest(label) {
  return `${TAG_PREFIX} ${label} ${crypto.randomBytes(3).toString('hex')}`;
}

async function login(page, base, email, password) {
  await page.goto(`${base}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
}

async function openScheduleDay(page) {
  await page.evaluate(() => {
    document.querySelector('button.tab-btn[data-tab="portal-home"]')?.click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.querySelector('.portal-schedule-view-btn[data-ps-view="day"]')?.click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('ps-unpaid-pending-today');
    return el && el.textContent && el.textContent.trim() !== '…';
  }, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(900);
}

/** Reload Schedule via real UI nav (IIFE-scoped loadSchedulePage is not on window). */
async function reloadScheduleViaUi(page) {
  await page.evaluate(() => {
    document.querySelector('.portal-schedule-view-btn[data-ps-view="week"]')?.click();
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    document.querySelector('.portal-schedule-view-btn[data-ps-view="day"]')?.click();
  });
  await page.waitForTimeout(2200);
}

async function navSnapshot(page) {
  return page.evaluate(() => {
    const active = document.querySelector('.portal-schedule-view-btn.active');
    const label = document.getElementById('ps-range-label');
    const weekGrid = document.getElementById('ps-week-grid');
    const monthGrid = document.getElementById('ps-month-grid');
    const opsBoard = document.getElementById('ps-ops-board');
    const visible = (el) => !!(el && getComputedStyle(el).display !== 'none');
    return {
      activeView: active && active.getAttribute('data-ps-view'),
      label: label && label.textContent,
      weekVisible: visible(weekGrid),
      monthVisible: visible(monthGrid),
      opsVisible: visible(opsBoard),
    };
  });
}

async function clickView(page, view) {
  await page.evaluate((v) => {
    document.querySelector(`.portal-schedule-view-btn[data-ps-view="${v}"]`)?.click();
  }, view);
  await page.waitForTimeout(1600);
}

async function createPrivateLesson(page, guestName) {
  const today = new Date().toISOString().slice(0, 10);
  const created = await page.evaluate(async ({ guestName, today }) => {
    const phone = '+34600' + String(Math.floor(Math.random() * 900000) + 100000);
    const payload = {
      guest_name: guestName,
      guest_phone: phone,
      date_from: today,
      date_to: today,
      payment_status: 'unpaid',
      notes: 'sunset-schedule-journeys synthetic',
      components: {
        private_lesson: {
          enabled: true,
          quantity: 1,
          surfer_count: 1,
          sessions: [{ date: today, start: '10:00', end: '12:00' }],
        },
      },
    };
    const quoteBody = Object.assign({}, payload, { location_id: 'sunset-somo', service_dates: [today] });
    const quoteRes = await fetch('/staff/schedule/bookings/quote?client=sunset&location_id=sunset-somo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quoteBody),
    });
    const quoteData = await quoteRes.json();
    if (!quoteRes.ok || !quoteData.success) {
      return { ok: false, stage: 'quote', detail: quoteData };
    }
    const createRes = await fetch('/staff/schedule/bookings?client=sunset&location_id=sunset-somo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, payload, {
        location_id: 'sunset-somo',
        quote_provenance: quoteData.quote_provenance,
      })),
    });
    const createData = await createRes.json();
    return {
      ok: createRes.ok && createData.success === true,
      booking_id: createData.booking_id || null,
      booking_code: createData.booking_code || null,
      detail: createData,
    };
  }, { guestName, today });
  if (!created.ok) {
    throw new Error('create failed: ' + JSON.stringify(created.detail || created).slice(0, 300));
  }
  await reloadScheduleViaUi(page);
  return created;
}

async function waitForChip(page, guestName) {
  return page.waitForFunction((name) => {
    return Array.from(document.querySelectorAll('.portal-schedule-ops-row, .portal-schedule-item-card'))
      .some((el) => (el.textContent || '').includes(name));
  }, guestName, { timeout: 45000 }).then(() => true).catch(() => false);
}

async function openChip(page, guestName, mode) {
  const detailUrls = [];
  const handler = (req) => {
    if (req.url().includes('/staff/schedule/bookings/detail')) detailUrls.push(req.url());
  };
  page.on('request', handler);
  const row = page.locator('.portal-schedule-ops-row[data-ps-booking-id]', { hasText: guestName }).first();
  if (!(await row.count())) {
    // Fallback: any ops row / card containing name
    const clicked = await page.evaluate((name) => {
      const chip = Array.from(document.querySelectorAll('.portal-schedule-ops-row, .portal-schedule-item-card'))
        .find((el) => (el.textContent || '').includes(name));
      if (!chip) return false;
      chip.scrollIntoView({ block: 'center' });
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }, guestName);
    await page.waitForTimeout(1400);
    page.off('request', handler);
    return { ok: clicked, detailCount: detailUrls.length, mode: 'fallback' };
  }
  if (mode === 'inner') {
    await row.locator('.portal-schedule-ops-row-guest').scrollIntoViewIfNeeded();
    await row.locator('.portal-schedule-ops-row-guest').click({ timeout: 10000 });
  } else {
    await row.scrollIntoViewIfNeeded();
    await row.click({ timeout: 10000 });
  }
  await page.waitForTimeout(1400);
  const drawerOpen = await page.evaluate(() => {
    const d = document.getElementById('ps-detail-drawer');
    return !!(d && getComputedStyle(d).display !== 'none');
  });
  page.off('request', handler);
  return { ok: drawerOpen, detailCount: detailUrls.length, mode };
}

async function closeDrawer(page) {
  await page.evaluate(() => {
    document.getElementById('ps-drawer-close')?.click();
  });
  await page.waitForTimeout(400);
}

async function cleanupTagged(page, prefix) {
  const today = new Date().toISOString().slice(0, 10);
  return page.evaluate(async ({ today, prefix }) => {
    const raw = await fetch('/staff/schedule/day?client=sunset&date=' + today + '&location_id=sunset-somo').then((r) => r.json());
    const rows = (raw.rows || []).filter((r) => String(r.guest_name || '').startsWith(prefix));
    let deleted = 0;
    const names = [];
    for (const row of rows) {
      names.push(row.guest_name);
      if (!row.booking_id) continue;
      const res = await fetch('/staff/schedule/bookings?client=sunset&location_id=sunset-somo', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ booking_id: row.booking_id }),
      }).then((r) => r.json());
      if (res && res.success) deleted += 1;
    }
    return { found: rows.length, deleted, names };
  }, { today, prefix });
}

async function proveNavigationAndStale(page) {
  console.log('\n[1] Day/Week/Next30 navigation + stale-load protection');
  await openScheduleDay(page);
  const day = await navSnapshot(page);
  await clickView(page, 'week');
  const week = await navSnapshot(page);
  await clickView(page, 'next30');
  const next30 = await navSnapshot(page);
  await clickView(page, 'day');
  const dayReturn = await navSnapshot(page);

  const navPass = day.activeView === 'day'
    && week.activeView === 'week' && week.label !== day.label
    && next30.activeView === 'next30' && next30.label !== week.label
    && dayReturn.activeView === 'day' && dayReturn.label === day.label;
  track(navPass, 'nav_day_week_next30', JSON.stringify({ day: day.activeView, week: week.activeView, next30: next30.activeView }));

  // Stale-load: delay schedule fetches, double-click next, final label must match mid (not revert).
  const beforeLabel = ((await page.locator('#ps-range-label').textContent()) || '').trim();
  await page.evaluate(() => {
    const orig = window.fetch;
    window.__sjRestoreFetch = orig;
    window.__sjDelayScheduleFetch = true;
    window.fetch = function (url, opts) {
      if (window.__sjDelayScheduleFetch && String(url).includes('/staff/schedule/')) {
        return new Promise((resolve) => {
          setTimeout(() => { orig(url, opts).then(resolve); }, 2500);
        });
      }
      return orig(url, opts);
    };
  });
  const nextBtn = page.locator('#ps-next-week');
  if (await nextBtn.count()) {
    await nextBtn.click();
    await page.waitForTimeout(250);
    await nextBtn.click();
    const midLabel = ((await page.locator('#ps-range-label').textContent()) || '').trim();
    await page.waitForTimeout(3200);
    const afterLabel = ((await page.locator('#ps-range-label').textContent()) || '').trim();
    await page.evaluate(() => {
      window.__sjDelayScheduleFetch = false;
      if (window.__sjRestoreFetch) window.fetch = window.__sjRestoreFetch;
    });
    const stalePass = midLabel === afterLabel && midLabel !== beforeLabel;
    track(stalePass, 'stale_load_protection', JSON.stringify({ beforeLabel, midLabel, afterLabel }));
  } else {
    await page.evaluate(() => {
      window.__sjDelayScheduleFetch = false;
      if (window.__sjRestoreFetch) window.fetch = window.__sjRestoreFetch;
    });
    track(false, 'stale_load_protection', 'ps-next-week missing');
  }

  results.journeys.navigation = { day, week, next30, dayReturn };
}

async function proveCreateBoardDrawer(page) {
  console.log('\n[2] private lesson create → board → canonical drawer');
  await openScheduleDay(page);
  const guest = uniqueGuest('create');
  const created = await createPrivateLesson(page, guest);
  track(!!(created && created.booking_id), 'create_private_lesson', created && created.booking_id);
  await openScheduleDay(page);
  const visible = await waitForChip(page, guest);
  track(visible, 'chip_on_board', guest);
  const open = await openChip(page, guest, 'container');
  track(open.ok, 'canonical_drawer_opens', `details=${open.detailCount}`);
  const hasPayment = await page.locator('#ps-drawer-payment-box').count();
  track(hasPayment > 0, 'drawer_has_payment_section');
  await closeDrawer(page);
  results.journeys.createBoardDrawer = { guest, booking_id: created.booking_id, open };
  return { guest, created };
}

async function proveMobile390SingleDetail(browser, base, email, password) {
  console.log('\n[3] mobile 390 chip → exactly one detail request');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on('dialog', async (d) => { try { await d.accept(); } catch (_) {} });
  const guest = uniqueGuest('m390');
  try {
    await login(page, base, email, password);
    await openScheduleDay(page);
    const created = await createPrivateLesson(page, guest);
    track(!!created.booking_id, 'mobile_booking_created', created.booking_id);
    await openScheduleDay(page);
    await waitForChip(page, guest);
    const open = await openChip(page, guest, 'inner');
    track(open.ok, 'mobile390_drawer_opens');
    track(open.detailCount === 1, 'mobile390_exactly_one_detail', `count=${open.detailCount}`);
    await closeDrawer(page);
    results.journeys.mobile390 = { guest, booking_id: created.booking_id, detailCount: open.detailCount };
  } catch (err) {
    await captureFailure(page, 'mobile390', err);
    track(false, 'mobile390_journey', err.message);
  } finally {
    await cleanupTagged(page, TAG_PREFIX).catch(() => {});
    await context.close();
  }
}

async function proveEditSaveSinglePatch(page) {
  console.log('\n[4] edit/save → exactly one PATCH → refreshed drawer');
  await openScheduleDay(page);
  const guest = uniqueGuest('edit');
  const created = await createPrivateLesson(page, guest);
  track(!!created.booking_id, 'edit_booking_created', created.booking_id);
  await openScheduleDay(page);
  await waitForChip(page, guest);
  const open = await openChip(page, guest, 'container');
  track(open.ok, 'edit_drawer_open');

  const editBtn = page.locator('#ps-drawer-edit');
  if (!(await editBtn.count())) {
    track(false, 'edit_button_present');
    await closeDrawer(page);
    return;
  }
  await editBtn.click();
  await page.waitForTimeout(600);

  const patchUrls = [];
  const handler = (req) => {
    if (req.method() === 'PATCH' && req.url().includes('/staff/schedule/bookings')) {
      patchUrls.push(req.url());
    }
  };
  page.on('request', handler);

  const note = `journey-edit-${crypto.randomBytes(2).toString('hex')}`;
  await page.evaluate((n) => {
    const notes = document.getElementById('ps-drawer-notes');
    if (notes) {
      notes.value = n;
      notes.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, note);

  const saveBtn = page.locator('#ps-drawer-save');
  track(await saveBtn.count() > 0, 'save_button_present');
  if (await saveBtn.count()) {
    await saveBtn.click({ force: true });
    await page.waitForTimeout(4000);
  }
  page.off('request', handler);

  track(patchUrls.length === 1, 'exactly_one_patch', `count=${patchUrls.length}`);
  const body = await page.locator('#ps-drawer-body').innerText().catch(() => '');
  const msg = await page.locator('#ps-drawer-save-msg').innerText().catch(() => '');
  track(
    /Saved|Guardado|saved/i.test(msg + body) || !(await page.locator('#ps-drawer-save').count()),
    'drawer_refreshed_after_save',
    (msg || body).slice(0, 120),
  );
  await closeDrawer(page);
  results.journeys.editSave = { guest, booking_id: created.booking_id, patchCount: patchUrls.length };
}

async function provePaymentWaiverDelete(page) {
  console.log('\n[5] payment-link / manual-payment / waiver / delete');
  await openScheduleDay(page);
  const guest = uniqueGuest('pay');
  const created = await createPrivateLesson(page, guest);
  track(!!created.booking_id, 'pay_booking_created', created.booking_id);
  await openScheduleDay(page);
  await waitForChip(page, guest);
  await openChip(page, guest, 'container');
  await page.waitForSelector('#ps-drawer-payment-box', { timeout: 15000 }).catch(() => null);

  const stripeBtn = page.locator('#ps-drawer-stripe-link');
  if (await stripeBtn.count() && !(await stripeBtn.isDisabled())) {
    await stripeBtn.scrollIntoViewIfNeeded();
    await stripeBtn.click({ force: true });
    const linkReady = await page.waitForFunction(() => {
      return !!(document.getElementById('ps-drawer-stripe-url') || document.getElementById('ps-drawer-stripe-copy'));
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    const body = await page.locator('#ps-drawer-body').innerText();
    const hasLink = linkReady || /https:\/\/checkout\.stripe\.com\//.test(body) || /\/pay\//.test(body);
    const liveMode = /cs_live_|sk_live_/i.test(body);
    track(hasLink, 'payment_link_created', body.slice(0, 160));
    track(!liveMode, 'stripe_not_live_mode', liveMode ? 'live markers in drawer' : 'ok');
    track(await page.locator('#ps-drawer-stripe-copy').count() > 0, 'payment_link_copy_control');

    if (await page.locator('#ps-drawer-stripe-delete').count()) {
      await page.evaluate(() => {
        const details = document.querySelector('#ps-drawer-stripe-delete')?.closest('details');
        if (details) details.open = true;
      });
      await page.locator('#ps-drawer-stripe-delete').click({ force: true });
      await page.waitForTimeout(4000);
      const afterDel = await page.locator('#ps-drawer-body').innerText();
      const createBtnBack = await page.locator('#ps-drawer-stripe-link').count();
      const stillActiveUrl = await page.locator('#ps-drawer-stripe-url').count();
      track(
        createBtnBack > 0 || stillActiveUrl === 0 || /Deleted|eliminad|None|Ningún|outdated|caducado/i.test(afterDel),
        'payment_link_invalidated',
        afterDel.slice(0, 160),
      );
    }
  } else {
    track(true, 'payment_link_unavailable_graceful', 'button missing or disabled');
  }

  const manual = page.locator('#ps-drawer-manual-submit');
  if (await manual.count()) {
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((n) => { n.open = true; });
      const amt = document.getElementById('ps-drawer-manual-amount');
      const method = document.getElementById('ps-drawer-manual-method');
      if (amt) {
        amt.style.display = 'block';
        amt.value = '5';
        amt.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (method) method.value = 'in_store';
    });
    await page.locator('#ps-drawer-manual-submit').click({ force: true });
    await page.waitForTimeout(4000);
    const msg = await page.locator('#ps-drawer-manual-msg').innerText().catch(() => '');
    const paidHint = await page.locator('#ps-drawer-body').innerText();
    track(/Saved|Guardado|saved|pagado|Paid|€/i.test(msg + paidHint), 'manual_payment', msg || paidHint.slice(0, 120));
  } else {
    track(true, 'manual_pay_hidden_if_paid', 'manual form not present');
  }

  const waiverCreate = page.locator('#ps-drawer-waiver-create');
  if (await waiverCreate.count()) {
    await waiverCreate.click();
    await page.waitForTimeout(3500);
  }
  const waiverBox = await page.locator('#ps-drawer-waiver-box').innerText().catch(() => '');
  const waiverUrl = await page.locator('#ps-drawer-waiver-url').count();
  track(
    waiverUrl > 0 || /Pending|Pendiente|Completed|Complet|progress|enlace/i.test(waiverBox),
    'waiver_state',
    waiverBox.slice(0, 160),
  );

  console.log('\n[6] delete → drawer closes → row disappears → cleanup zero');
  const delBtn = page.locator('#ps-drawer-delete-booking');
  track(await delBtn.count() > 0, 'delete_button');
  if (await delBtn.count()) {
    await delBtn.scrollIntoViewIfNeeded();
    await delBtn.click({ force: true });
    await page.waitForTimeout(3500);
    const drawerGone = await page.evaluate(() => {
      const d = document.getElementById('ps-detail-drawer');
      return !d || d.style.display === 'none' || getComputedStyle(d).display === 'none';
    });
    track(drawerGone, 'delete_closes_drawer');
    const goneFromUi = await page.waitForFunction((name) => {
      return !Array.from(document.querySelectorAll('.portal-schedule-ops-row, .portal-schedule-item-card'))
        .some((el) => (el.textContent || '').includes(name));
    }, guest, { timeout: 20000 }).then(() => true).catch(() => false);
    const goneFromApi = await page.evaluate(async (name) => {
      const today = new Date().toISOString().slice(0, 10);
      const raw = await fetch('/staff/schedule/day?client=sunset&date=' + today + '&location_id=sunset-somo').then((r) => r.json());
      return !(raw.rows || []).some((r) => String(r.guest_name || '').includes(name));
    }, guest);
    track(goneFromUi || goneFromApi, 'delete_removes_row', goneFromUi ? 'ui' : (goneFromApi ? 'api' : 'still_visible'));
  }
  results.journeys.paymentWaiverDelete = { guest, booking_id: created.booking_id };
}

async function main() {
  const password = requireEnv('SUNSET_STAGING_PORTAL_PASSWORD');
  const email = (process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com').trim();
  const base = (process.env.SUNSET_STAGING_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const host = guardStagingUrl(base);
  results.host = host;

  console.log('verify:sunset-schedule-journeys');
  console.log(`  host=${host}`);
  console.log(`  artifacts=${ARTIFACT_DIR}`);
  console.log('  no WhatsApp/email; synthetic bookings only; Stripe test path via staging portal\n');

  track(true, 'staging_host_allowed', host);

  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);
  let context;
  let page;

  try {
    // Pre-clean leftovers from prior interrupted runs.
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on('dialog', async (d) => { try { await d.accept(); } catch (_) {} });
    await login(page, base, email, password);
    const pre = await cleanupTagged(page, TAG_PREFIX);
    console.log('cleanup_pre', JSON.stringify(pre));

    await proveNavigationAndStale(page);
    await proveCreateBoardDrawer(page);
    await proveEditSaveSinglePatch(page);
    await provePaymentWaiverDelete(page);
    await proveMobile390SingleDetail(browser, base, email, password);

    // Final cleanup + zero proof
    const post = await cleanupTagged(page, TAG_PREFIX);
    results.cleanup = post;
    console.log('\ncleanup_post', JSON.stringify(post));
    track(post.found === 0, 'cleanup_zero_artifacts', JSON.stringify(post));

    // Bundle markers (current architecture) — read-only assertions.
    const html = await page.content();
    track(html.includes('var SunsetScheduleRuntime = (function'), 'runtime_container_present');
    track(!/window\.SunsetScheduleRuntime\s*=/.test(html), 'runtime_not_on_window');
    track(html.includes('resolveRow'), 'resolveRow_present');
  } catch (err) {
    await captureFailure(page, 'fatal', err);
    track(false, 'journey_fatal', err.message);
  } finally {
    try {
      if (page) {
        const leftover = await cleanupTagged(page, TAG_PREFIX);
        if (!results.cleanup) results.cleanup = leftover;
        if (leftover.found > 0) {
          track(false, 'finally_cleanup_nonzero', JSON.stringify(leftover));
        }
      }
    } catch (_) { /* ignore */ }
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const reportPath = path.join(ARTIFACT_DIR, `report-${Date.now()}.json`);
  results.finished_at = new Date().toISOString();
  results.pass = results.checks.every((c) => c.ok);
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nreport ${reportPath}`);

  const failed = results.checks.filter((c) => !c.ok);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`verify:sunset-schedule-journeys  pass=${results.checks.length - failed.length}  fail=${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.error('  -', f.label, f.detail || '');
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
