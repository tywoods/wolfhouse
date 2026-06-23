'use strict';
const { chromium } = require('playwright');
const https = require('https');

function apiGet(cookies) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'GET',
      hostname: 'sunset-staging.lunafrontdesk.com',
      path: '/staff/admin/config?client=sunset',
      headers: { Accept: 'application/json', Cookie: cookies },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function summarize(cfg) {
  const hist = Array.isArray(cfg.change_history) ? cfg.change_history : [];
  const latest = hist[0] || null;
  return {
    writes_enabled: cfg.writes_enabled,
    read_only: cfg.read_only,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_times: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    audit_count: hist.length,
    latest_before: latest && latest.before_json && latest.before_json.capacity,
    latest_after: latest && latest.after_json && latest.after_json.capacity,
  };
}

(async () => {
  const password = process.env.SUNSET_STAGING_PORTAL_PASSWORD;
  if (!password) {
    console.error('missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const report = { steps: [] };

  await page.goto(base + '/staff/login', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-form', { timeout: 20000 });
  await page.fill('#client', 'sunset');
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', password);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });

  const cookies = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

  report.steps.push({ phase: 'before', api: summarize(await apiGet(cookies)) });

  await page.click('.tab-btn[data-tab="admin"]');
  await page.waitForSelector('#admin-capacity-body', { timeout: 20000 });
  await page.waitForTimeout(1500);

  const preEditUi = await page.evaluate(() => ({
    editingBanner: (document.body.innerText || '').includes('Editing enabled'),
    editCapacityVisible: !!document.querySelector('[data-admin-action="edit-capacity"]'),
    saveBeforeEdit: document.querySelectorAll('[data-admin-action="save-capacity"]').length,
  }));
  report.steps.push({ phase: 'writes_on_ui_pre_edit', ui: preEditUi });

  if (!preEditUi.editingBanner || !preEditUi.editCapacityVisible || preEditUi.saveBeforeEdit !== 0) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  await page.click('[data-admin-action="edit-capacity"]');
  await page.waitForSelector('#admin-capacity-input', { timeout: 10000 });
  const saveVisibleAfterEdit = await page.locator('[data-admin-action="save-capacity"]').count();
  report.steps.push({ phase: 'edit_form_open', save_buttons: saveVisibleAfterEdit });
  if (saveVisibleAfterEdit !== 1) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  await page.fill('#admin-capacity-input', '25');
  await page.click('[data-admin-action="save-capacity"]');
  await page.waitForFunction(() => {
    const msg = document.getElementById('admin-save-msg');
    return msg && msg.style.display !== 'none' && /saved/i.test(msg.textContent || '');
  }, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const afterWriteUi = await page.evaluate(() => {
    const body = document.getElementById('admin-capacity-body');
    return { capacityText: body ? body.innerText : '' };
  });
  const afterWriteApi = summarize(await apiGet(cookies));
  report.steps.push({ phase: 'after_write_25', ui: afterWriteUi, api: afterWriteApi });

  if (afterWriteApi.lesson_cap !== 25 || afterWriteApi.audit_count !== 3
    || afterWriteApi.latest_before !== 24 || afterWriteApi.latest_after !== 25) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  await page.click('[data-admin-action="edit-capacity"]');
  await page.waitForSelector('#admin-capacity-input', { timeout: 10000 });
  await page.fill('#admin-capacity-input', '24');
  await page.click('[data-admin-action="save-capacity"]');
  await page.waitForFunction(() => {
    const msg = document.getElementById('admin-save-msg');
    return msg && msg.style.display !== 'none' && /saved/i.test(msg.textContent || '');
  }, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const afterRestoreApi = summarize(await apiGet(cookies));
  const afterRestoreUi = await page.evaluate(() => {
    const body = document.getElementById('admin-capacity-body');
    return { capacityText: body ? body.innerText : '' };
  });
  report.steps.push({ phase: 'after_restore_24', ui: afterRestoreUi, api: afterRestoreApi });

  await browser.close();

  const ok = afterRestoreApi.lesson_cap === 24
    && afterRestoreApi.audit_count === 4
    && afterRestoreApi.latest_before === 25
    && afterRestoreApi.latest_after === 24
    && afterRestoreApi.price_count === 23
    && afterRestoreApi.lesson_times === 3;
  report.ok = ok;
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
