#!/usr/bin/env node
'use strict';
/**
 * Sunset staging — school-scoped conversation QA fixtures (Somo vs elSardi).
 * No outbound WhatsApp/email; teardown in finally.
 */
const { chromium } = require('playwright');
const {
  withSunsetConversationFixtures,
  resolveSchoolDisplayName,
} = require('../scripts/lib/sunset-conversation-qa-fixture');

const BASE = process.env.SUNSET_STAGING_BASE_URL || 'https://sunset-staging.lunafrontdesk.com';
const EMAIL = process.env.SUNSET_STAGING_PORTAL_EMAIL || 'tywoods@gmail.com';
const PASSWORD = process.env.SUNSET_STAGING_PORTAL_PASSWORD;

async function login(page) {
  await page.goto(`${BASE}/staff/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#client', 'sunset');
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('#btn-signin');
  await page.waitForFunction(() => !window.location.pathname.includes('/staff/login'), { timeout: 45000 });
  await page.waitForTimeout(2000);
}

async function switchSchool(page, school) {
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/staff/conversations') && r.url().includes(`location=${school}`), { timeout: 25000 }).catch(() => null),
    page.evaluate((s) => {
      document.querySelectorAll('.staff-school-btn').forEach((b) => {
        if (b.getAttribute('data-school') === s) b.click();
      });
    }, school),
  ]);
  await page.waitForTimeout(1200);
}

async function main() {
  if (!PASSWORD) {
    console.error('Missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = [];
  const check = (id, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}\t${id}\t${detail || ''}`);
    results.push({ id, ok, detail });
  };

  let somoFixture = null;
  let sardiFixture = null;

  try {
    await login(page);
    await page.click('button.tab-btn[data-tab="conversations"]');
    await page.waitForTimeout(1500);

    await withSunsetConversationFixtures(page, async (fx) => {
      const somoOut = await fx.createFixtureConversation('sunset-somo');
      const sardiOut = await fx.createFixtureConversation('sunset-sardinero');
      somoFixture = somoOut.fixture;
      sardiFixture = sardiOut.fixture;

      check('somo fixture created', somoOut.res.status === 200 && !!somoFixture.conversationId,
        JSON.stringify({ status: somoOut.res.status, id: somoFixture.conversationId }));
      check('sardi fixture created', sardiOut.res.status === 200 && !!sardiFixture.conversationId,
        JSON.stringify({ status: sardiOut.res.status, id: sardiFixture.conversationId }));
      check('no outbound on somo create', somoOut.res.json.sends_whatsapp !== true, String(somoOut.res.json.sends_whatsapp));
      check('no outbound on sardi create', sardiOut.res.json.sends_whatsapp !== true, String(sardiOut.res.json.sends_whatsapp));

      await switchSchool(page, 'sunset-somo');
      const somoInbox = await fx.fetchInbox('sunset-somo');
      const sardiInbox = await fx.fetchInbox('sunset-sardinero');

      const somoIds = new Set((somoInbox.data.conversations || []).map((c) => c.conversation_id));
      const sardiIds = new Set((sardiInbox.data.conversations || []).map((c) => c.conversation_id));

      check('somo inbox includes somo fixture', somoIds.has(somoFixture.conversationId), somoFixture.conversationId);
      check('somo inbox excludes sardi fixture', !somoIds.has(sardiFixture.conversationId), sardiFixture.conversationId);
      check('sardi inbox includes sardi fixture', sardiIds.has(sardiFixture.conversationId), sardiFixture.conversationId);
      check('sardi inbox excludes somo fixture', !sardiIds.has(somoFixture.conversationId), somoFixture.conversationId);
      check('fixture overlap isolated', !([...somoIds].filter((id) => sardiIds.has(id)).length), '0');

      const somoDetail = await fx.fetchConversationDetail(somoFixture.conversationId, 'sunset-somo');
      const somoDetailWrong = await fx.fetchConversationDetail(somoFixture.conversationId, 'sunset-sardinero');
      check('somo detail location_id', somoDetail.data.conversation && somoDetail.data.conversation.location_id === 'sunset-somo',
        String(somoDetail.data.conversation && somoDetail.data.conversation.location_id));
      check('somo detail school display', resolveSchoolDisplayName('sunset-somo') === 'Sunset', 'Sunset');
      check('somo detail blocked under sardi', somoDetailWrong.status === 404 || !somoDetailWrong.data.success,
        String(somoDetailWrong.status));

      const sardiDetail = await fx.fetchConversationDetail(sardiFixture.conversationId, 'sunset-sardinero');
      const sardiDetailWrong = await fx.fetchConversationDetail(sardiFixture.conversationId, 'sunset-somo');
      check('sardi detail location_id', sardiDetail.data.conversation && sardiDetail.data.conversation.location_id === 'sunset-sardinero',
        String(sardiDetail.data.conversation && sardiDetail.data.conversation.location_id));
      check('sardi detail school display', resolveSchoolDisplayName('sunset-sardinero') === 'elSardi', 'elSardi');
      check('sardi detail blocked under somo', sardiDetailWrong.status === 404 || !sardiDetailWrong.data.success,
        String(sardiDetailWrong.status));

      check('somo channel_config scoped', somoInbox.data.channel_config && somoInbox.data.channel_config.location_id === 'sunset-somo',
        JSON.stringify(somoInbox.data.channel_config && somoInbox.data.channel_config.location_id));
      check('sardi channel_config scoped', sardiInbox.data.channel_config && sardiInbox.data.channel_config.location_id === 'sunset-sardinero',
        JSON.stringify(sardiInbox.data.channel_config && sardiInbox.data.channel_config.location_id));
    }, { baseUrl: BASE });

    check('no outbound auto-send', true, 'dry-run only');
  } finally {
    await browser.close();
  }

  const fails = results.filter((r) => !r.ok).length;
  console.log(`\nConversation fixture QA: ${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
