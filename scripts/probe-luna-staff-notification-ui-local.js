'use strict';

/**
 * Local Luna Staff notification panel probe — no deploy, no WhatsApp sends.
 * Requires staff-query-api on STAFF_QUERY_API_PORT (default 3047).
 */

const http = require('http');
const { chromium } = require('playwright');

const PORT = Number(process.env.STAFF_QUERY_API_PORT || 3047);
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${BASE}/staff/ui`, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      }).on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) reject(new Error(`server not ready on ${BASE}`));
        else setTimeout(tick, 200);
      }
    };
    tick();
  });
}

function sessionMock(overrides = {}) {
  return {
    success: true,
    auth_required: true,
    role: 'owner',
    email: 'owner@example.test',
    clients: [{ slug: 'sunset', name: 'Sunset Surf School' }],
    client_profiles: {
      sunset: {
        default_tab: 'portal-home',
        hidden_tabs: ['bed-calendar', 'tour-operator'],
        hidden_drawer_tabs: ['transfers'],
        lesson_slots_demo: [{ slot_time: '10:00', capacity: 8, date: null }],
        is_surf_vertical: true,
        demo_mode: false,
      },
    },
    can_use_owner_insights: true,
    ...overrides,
  };
}

async function runScenario(label, { settingsResponse, role }) {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err.message || err)));
  // Network 500s are expected without a local Postgres — only count uncaught JS exceptions.

  await page.addInitScript(({ settingsResponse, role }) => {
    const orig = window.fetch.bind(window);
    window.fetch = function (url, opts) {
      const u = String(url || '');
      if (u.includes('/staff/auth/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            auth_required: true,
            role: role,
            email: 'owner@example.test',
            clients: [{ slug: 'sunset', name: 'Sunset Surf School' }],
            client_profiles: {
              sunset: {
                default_tab: 'portal-home',
                hidden_tabs: ['bed-calendar', 'tour-operator'],
                is_surf_vertical: true,
              },
            },
            can_use_owner_insights: role === 'owner' || role === 'admin',
          }),
        });
      }
      if (u.includes('/staff/notification-settings')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => settingsResponse,
        });
      }
      return orig(url, opts);
    };
  }, { settingsResponse, role: role || 'owner' });

  await page.goto(`${BASE}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  const homeState = await page.evaluate(() => ({
    pending: document.body.classList.contains('portal-profile-pending'),
    activeTab: document.querySelector('.tab-btn.active')?.getAttribute('data-tab') || null,
    snsDisplay: (() => {
      const c = document.getElementById('cc-staff-notification-settings');
      return c ? window.getComputedStyle(c).display : null;
    })(),
  }));

  await page.click('.tab-btn[data-tab="ask-luna"]');
  await page.waitForTimeout(800);

  const lunaState = await page.evaluate(() => {
    const card = document.getElementById('cc-staff-notification-settings');
    const computed = card ? window.getComputedStyle(card).display : null;
  const inline = card ? card.style.display : null;
    return {
      activeTab: document.querySelector('.tab-btn.active')?.getAttribute('data-tab') || null,
      askLunaActive: document.getElementById('tab-ask-luna')?.classList.contains('active') || false,
      snsDisplay: computed,
      snsInline: inline,
      snsVisible: computed !== 'none' && computed !== '',
      snsDomVisible: !!(card && card.offsetParent !== null),
      hdr: card ? (card.querySelector('.cc-section-hdr')?.textContent || '').trim() : '',
      newEnabled: !!document.getElementById('sns-new-enabled'),
      humanEnabled: !!document.getElementById('sns-human-enabled'),
      snsError: (document.getElementById('sns-error')?.textContent || '').trim(),
    };
  });

  await browser.close();

  const checks = [
    [`${label}: portal-profile-pending cleared`, !homeState.pending, JSON.stringify(homeState)],
    [`${label}: portal-home active on boot`, homeState.activeTab === 'portal-home', homeState.activeTab],
    [`${label}: notification card hidden on portal-home`, homeState.snsDisplay === 'none', homeState.snsDisplay],
    [`${label}: no page JS errors`, consoleErrors.length === 0, consoleErrors.join(' | ')],
    [`${label}: Luna Staff tab active`, lunaState.activeTab === 'ask-luna', lunaState.activeTab],
    [`${label}: notification card visible on Luna Staff`, lunaState.snsVisible || lunaState.snsInline === '', lunaState.snsDisplay + ' inline=' + lunaState.snsInline],
    [`${label}: Staff WhatsApp Alerts title`, lunaState.hdr === 'Staff WhatsApp Alerts', lunaState.hdr],
    [`${label}: new conversation field present`, lunaState.newEnabled, String(lunaState.newEnabled)],
    [`${label}: human needed field present`, lunaState.humanEnabled, String(lunaState.humanEnabled)],
  ];

  if (settingsResponse && settingsResponse.success === false) {
    checks.push([
      `${label}: soft-fail shows inline error`,
      lunaState.snsVisible && lunaState.snsError.length > 0,
      lunaState.snsError || '(empty)',
    ]);
  }

  return checks;
}

async function main() {
  await waitForServer();
  const allChecks = [];
  allChecks.push(...await runScenario('owner-ok', {
    settingsResponse: {
      success: true,
      new_conversation: { enabled: true, recipients: [] },
      human_needed: { enabled: false, recipients: [] },
    },
    role: 'owner',
  }));
  allChecks.push(...await runScenario('owner-fetch-error', {
    settingsResponse: { success: false, error: 'read failed' },
    role: 'owner',
  }));

  let fail = 0;
  for (const [label, ok, detail] of allChecks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}\t${label}\t${detail || ''}`);
    if (!ok) fail += 1;
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
