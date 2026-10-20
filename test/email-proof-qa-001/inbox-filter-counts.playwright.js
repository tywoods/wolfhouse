#!/usr/bin/env node
'use strict';

/**
 * INBOX-FILTER-COUNTS-QA-001 — staging-only, GET-only Inbox count reconciliation.
 *
 * Optional authenticated run:
 *   INBOX_FILTER_COUNTS_QA_COOKIE='name=value' \
 *     node test/email-proof-qa-001/inbox-filter-counts.playwright.js
 *
 * No cookie is an intentional fail-closed outcome: this test never asks for one.
 * It does not click UI controls, approve/send, alter channel modes, or make writes.
 */

const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.WOLFHOUSE_STAFF_API_BASE_URL || 'https://staff-staging.lunafrontdesk.com';
const COOKIE = process.env.INBOX_FILTER_COUNTS_QA_COOKIE || '';
const CHANNEL_VIEWS = ['whatsapp', 'email'];

function parseCookie(value) {
  const at = String(value).indexOf('=');
  assert.ok(at > 0, 'INBOX_FILTER_COUNTS_QA_COOKIE must be one name=value pair');
  return { name: value.slice(0, at), value: value.slice(at + 1), url: BASE };
}

function formatCounts(counts) {
  return Object.entries(counts).map(([name, count]) => `${name} ${count}`).join('; ');
}

async function main() {
  assert.match(BASE, /^https:\/\/staff-staging\.lunafrontdesk\.com\/?$/, 'sunset-staging Staff API base only');
  assert.ok(COOKIE, 'FAIL CLOSED — 401 / Authentication required: no staging staff session cookie env; list/count observation did not run');

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([parseCookie(COOKIE)]);
    const page = await context.newPage();
    const blocked = [];
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') return route.continue();
      blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.abort('blockedbyclient');
    });

    // Authenticate by a read-only UI load, then query the same rail/list endpoints
    // directly. No control is clicked and no selected conversation is opened.
    const ui = await page.goto(`${BASE}/staff/ui`, { waitUntil: 'domcontentloaded' });
    assert.notEqual(ui && ui.status(), 401, 'FAIL CLOSED — 401 / Authentication required');
    assert.equal(new URL(page.url()).pathname, '/staff/ui', 'staff session must reach Inbox UI, not login');

    const observed = await page.evaluate(async (channelViews) => {
      async function getJson(path) {
        const response = await fetch(path, { method: 'GET', credentials: 'same-origin' });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch (_) { /* asserted below */ }
        return { status: response.status, body };
      }
      async function listAll(view) {
        let cursor = '';
        let rows = [];
        let pages = 0;
        do {
          const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
          const result = await getJson(`/staff/inbox/list?view=${encodeURIComponent(view)}&limit=99${suffix}`);
          if (result.status === 401) return { unauthorized: true };
          if (result.status !== 200 || !result.body || !result.body.success) {
            throw new Error(`list ${view}: HTTP ${result.status}`);
          }
          rows = rows.concat(Array.isArray(result.body.rows) ? result.body.rows : []);
          cursor = result.body.has_more ? result.body.next_cursor : '';
          pages += 1;
          if (pages > 1000) throw new Error(`list ${view}: paging guard exceeded`);
        } while (cursor);
        const keys = rows.map((row) => row.key || `${row.source || ''}:${row.conversation_id || ''}`);
        return { rows, keys, pages };
      }

      const rail = await getJson('/staff/inbox/views');
      if (rail.status === 401) return { unauthorized: true };
      if (rail.status !== 200 || !rail.body || !rail.body.success) {
        throw new Error(`rail: HTTP ${rail.status}`);
      }
      const railCounts = Object.fromEntries((rail.body.views || []).map((view) => [view.id, Number(view.count)]));
      const lists = {};
      for (const view of ['all', ...channelViews]) lists[view] = await listAll(view);
      return { railCounts, lists };
    }, CHANNEL_VIEWS);

    assert.ok(!observed.unauthorized, 'FAIL CLOSED — 401 / Authentication required');
    assert.deepEqual(blocked, [], `FAIL CLOSED — read-only guard blocked mutation: ${blocked.join('; ')}`);

    for (const view of ['all', ...CHANNEL_VIEWS]) {
      assert.ok(Number.isInteger(observed.railCounts[view]), `rail badge missing/non-numeric for ${view}`);
      const list = observed.lists[view];
      assert.equal(new Set(list.keys).size, list.keys.length, `FAIL CLOSED — ${view} list has duplicate row keys across pages`);
      assert.equal(observed.railCounts[view], list.rows.length,
        `FAIL CLOSED — ${view} rail ${observed.railCounts[view]} != list ${list.rows.length}`);
    }

    const allRows = observed.lists.all.rows;
    const attributed = {};
    const missingChannel = [];
    for (const row of allRows) {
      const channel = String(row.channel || '').trim().toLowerCase();
      if (!channel) missingChannel.push(row.key || row.conversation_id || '<unknown>');
      else attributed[channel] = (attributed[channel] || 0) + 1;
    }
    assert.equal(missingChannel.length, 0,
      `FAIL CLOSED — ${missingChannel.length} All rows have no attributed channel`);
    const attributedTotal = Object.values(attributed).reduce((sum, count) => sum + count, 0);
    assert.equal(observed.lists.all.rows.length, attributedTotal,
      `FAIL CLOSED — All list ${allRows.length} != attributed channels ${formatCounts(attributed)}`);

    for (const view of CHANNEL_VIEWS) {
      assert.equal(attributed[view] || 0, observed.lists[view].rows.length,
        `FAIL CLOSED — All-derived ${view} ${attributed[view] || 0} != ${view} list ${observed.lists[view].rows.length}`);
    }
    const otherChannels = Object.fromEntries(Object.entries(attributed).filter(([channel]) => !CHANNEL_VIEWS.includes(channel)));
    assert.equal(Object.keys(otherChannels).length, 0,
      `FAIL CLOSED — unexplained attributed channels have no matching rail/list proof: ${formatCounts(otherChannels)}`);

    console.log(`PASS INBOX-FILTER-COUNTS-QA-001 — rail/list ${formatCounts({ all: observed.railCounts.all, whatsapp: observed.railCounts.whatsapp, email: observed.railCounts.email })}; All = WhatsApp + Email = ${attributedTotal}; remainder 0`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`FAIL INBOX-FILTER-COUNTS-QA-001 — ${error.message}`);
  process.exitCode = 1;
});
