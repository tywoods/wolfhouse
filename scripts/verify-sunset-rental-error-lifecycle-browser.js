#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// Isolated Git worktrees on the staging operator host intentionally do not duplicate
// node_modules. Match the verifier's existing Playwright fallback so the mandatory
// plain `npm run` gate can still load the generated Staff UI fixture dependencies.
function enableSharedWorktreeDependencies() {
  try { require.resolve('dotenv'); return; } catch (_) {}
  const shared = '/opt/wolfhouse/WH/node_modules';
  if (!fs.existsSync(shared)) return;
  const paths = String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
  if (!paths.includes(shared)) paths.unshift(shared);
  process.env.NODE_PATH = paths.join(path.delimiter);
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

async function main() {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const browser = await playwright().chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  let commitShouldFail = true;
  let commitCalls = 0;
  const offering = {
    offering_key: 'surfboard_wetsuit',
    label: 'Surfboard + Wetsuit',
    active: true,
    stock_quantity: 100,
  };
  const prices = [
    {
      id: 'price-sw-2h', category: 'rental', item_type: 'rental',
      offering_key: 'surfboard_wetsuit__2_hours', item_code: 'surfboard_wetsuit__2_hours',
      display_name: offering.label, label: offering.label, amount_cents: 1500,
      active: true, client_slug: 'sunset', location_id: 'sunset-somo',
    },
    {
      id: 'price-sw-1d', category: 'rental', item_type: 'rental',
      offering_key: 'surfboard_wetsuit__1_day', item_code: 'surfboard_wetsuit__1_day',
      display_name: offering.label, label: offering.label, amount_cents: 3000,
      active: true, client_slug: 'sunset', location_id: 'sunset-somo',
    },
  ];

  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  await page.route(/\/staff\/admin\/config\/rental-offerings(?:\/([^/?]+)(?:\/commit)?)?(?:\?|$)/, async (route) => {
    const req = route.request();
    const url = req.url();
    if (/\/commit(?:\?|$)/.test(url) && req.method() === 'POST') {
      commitCalls += 1;
      if (commitShouldFail) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'write failed' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, offering_key: offering.offering_key }),
        });
      }
      return;
    }
    if (req.method() === 'GET' && !/rental-offerings\/[^/?]+/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, offerings: [offering] }),
      });
      return;
    }
    await route.continue();
  });

  await page.route(/\/staff\/admin\/config(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.prices = prices.slice();
    body.writes_enabled = true;
    body.read_only = false;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify(body),
    });
  });

  const globalState = async () => page.locator('#admin-save-msg').evaluate((node) => ({
    text: node.textContent,
    display: node.style.display,
    cls: node.className,
  }));
  const setUnrelatedGlobal = async () => page.locator('#admin-save-msg').evaluate((node) => {
    node.textContent = 'UNRELATED FINANCE ERROR';
    node.className = 'state-msg portal-admin-save-msg error';
    node.style.display = 'block';
  });
  const assertGlobalUnchanged = async (label) => {
    const state = await globalState();
    assert.strictEqual(state.text, 'UNRELATED FINANCE ERROR', `${label}: text`);
    assert.strictEqual(state.display, 'block', `${label}: display`);
  };
  const card = () => page.locator('[data-admin-equip="surfboard_wetsuit"]');
  const edit = async () => {
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await card().waitFor();
    if (await card().locator('[data-admin-action="edit-equipment"]').count()) {
      await card().locator('[data-admin-action="edit-equipment"]').click();
    }
    await card().locator('[data-admin-action="save-equipment"]').waitFor();
  };
  const failRealSave = async () => {
    commitShouldFail = true;
    await setUnrelatedGlobal();
    const before = commitCalls;
    await card().locator('[data-admin-action="save-equipment"]').click();
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-admin-equip-error="surfboard_wetsuit"]');
      return node && /write failed/i.test(node.textContent || '') && node.style.display !== 'none';
    });
    assert.strictEqual(commitCalls, before + 1, 'actual Save must call atomic commit route once');
    await assertGlobalUnchanged('save failure preserves unrelated global');
  };
  const localErrorState = async () => page.locator('[data-admin-equip-error="surfboard_wetsuit"]')
    .evaluate((node) => ({ text: node.textContent, display: node.style.display }))
    .catch(() => ({ text: '', display: 'missing' }));
  const assertLocalCleared = async (label) => {
    const state = await localErrorState();
    assert.ok(!state.text || state.display === 'none' || state.display === 'missing', `${label}: ${JSON.stringify(state)}`);
  };

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');

    // Actual delegated Save listener: failure paints active-card error and preserves global state.
    await edit();
    await failRealSave();
    console.log('PASS real Save failure paints equipment-local error only');

    // Actual retry through the same listener: success clears local error and owns success notice.
    commitShouldFail = false;
    const beforeSuccess = commitCalls;
    await card().locator('[data-admin-action="save-equipment"]').click();
    await page.waitForFunction(() => /saved/i.test(document.querySelector('#admin-save-msg')?.textContent || ''));
    assert.strictEqual(commitCalls, beforeSuccess + 1, 'successful retry must call commit once');
    await assertLocalCleared('successful retry clears local error');
    console.log('PASS real successful retry clears local error');

    // Actual Cancel listener.
    await edit();
    await failRealSave();
    await card().locator('[data-admin-action="cancel-edit"]').click();
    await assertLocalCleared('Cancel clears local error');
    await assertGlobalUnchanged('Cancel preserves unrelated global');
    console.log('PASS real Cancel clears only local error');

    // Actual Admin subtab listener.
    await edit();
    await failRealSave();
    await page.locator('#admin-tab-finance').click();
    await assertLocalCleared('Admin subtab clears local error');
    await assertGlobalUnchanged('Admin subtab preserves unrelated global');
    console.log('PASS real Admin subtab clears only local error');

    // Actual top-level switchToTab path.
    await edit();
    await failRealSave();
    await page.locator('button[data-tab="portal-home"]').click();
    await assertLocalCleared('top-level leave Admin clears local error');
    await assertGlobalUnchanged('top-level leave preserves unrelated global');
    console.log('PASS real top-level leave clears only local error');

    // Actual client selector change listener while Admin is active.
    await edit();
    await failRealSave();
    const client = page.locator('#c-client');
    const alternate = await client.locator('option').evaluateAll((opts) =>
      opts.map((o) => o.value).find((v) => v && v !== 'sunset') || 'wolfhouse');
    await client.evaluate((node, value) => {
      node.value = value;
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }, alternate);
    await assertLocalCleared('client change clears local error');
    await assertGlobalUnchanged('client change preserves unrelated global');
    console.log('PASS real client change clears only local error');

    // Exercise actual Admin re-entry/load: restore Sunset through the real client
    // listener, then top-level click runs loadAdminTab, whose trusted config response
    // calls renderAdminFromConfig inside the production IIFE.
    await client.evaluate((node) => {
      node.value = 'sunset';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('button[data-tab="portal-home"]').click();
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await card().waitFor();
    await assertLocalCleared('real Admin load/render clears local error');
    await assertGlobalUnchanged('real Admin load/render preserves unrelated global');
    console.log('PASS real Admin load/render clears only local error');

    assert.deepStrictEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
    console.log(`ALL PASS real generated UI lifecycle (${commitCalls} commit calls)`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err && (err.stack || err.message || err));
  process.exit(1);
});
