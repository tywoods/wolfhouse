'use strict';

/**
 * verify:inbox-columns-playwright
 *
 * Measures the Inbox column layout in a real browser instead of asserting on CSS text.
 * Canonical rules: docs/INBOX-PORTAL-REDESIGN.md, "Column layout model".
 *
 * The page under test is the production /staff/ui document, built through the same offline
 * seam the parity harness uses and served by a fixture HTTP server: no Postgres, no Stripe,
 * no network. Every /staff/* endpoint the Inbox calls answers from the fixtures below, so a
 * conversation can be opened and columns 3 and 4 actually render.
 *
 * What it proves, in measured pixels:
 *   - each preset lands the documented widths on columns 1, 2 and 4
 *   - column 3 absorbs every remainder, and never drops under its floor
 *   - collapsing a column with Alt+1 / Alt+2 / Alt+Shift+4 moves only that column
 *   - a peek overlays column 3 at the peek width without moving a single track
 *   - the viewport buckets collapse column 4 under 1280px and column 2 under 900px
 *
 * Widths at every viewport, and the screenshots, land in tmp/inbox-columns-playwright/.
 *
 * Run:
 *   node scripts/verify-inbox-columns-playwright.js
 *   node scripts/verify-inbox-columns-playwright.js --keep   (leaves the server up)
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'tmp', 'inbox-columns-playwright');
const CLIENT = process.env.INBOX_COLUMNS_CLIENT || 'wolfhouse-somo';

const CONV_ID = '7f1d3a20-4c0b-4a1e-9c11-0b7c9a5d21ee';
const CONV_ID_2 = '9a2e4b31-5d1c-4b2f-8d22-1c8dab6e32ff';

/** Spec widths. Only column 3 is elastic; the rest snap to these. */
const W = {
  col1: { full: 240, icons: 56 },
  col2: { comfortable: 360, compact: 280, hidden: 0 },
  col4: { wide: 460, peek: 300, hidden: 0 },
};
const COL3_MIN = 480;
const PRESETS = {
  all4: { col1: 'full', col2: 'comfortable', col4: 'peek' },
  chat: { col1: 'full', col2: 'comfortable', col4: 'hidden' },
  guest: { col1: 'full', col2: 'comfortable', col4: 'wide' },
};

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`);
  return false;
}

function section(title) {
  console.log(`\n${title}`);
}

function near(actual, expected, tolerance) {
  return Math.abs(Number(actual) - Number(expected)) <= (tolerance === undefined ? 1 : tolerance);
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

function conversationRow(id, name, phone, preview) {
  return {
    conversation_id: id,
    guest_name: name,
    phone,
    channel: 'whatsapp',
    last_message_preview: preview,
    last_activity_label: '2 min',
    last_message_at: new Date().toISOString(),
    needs_human: false,
    bot_mode: 'bot',
    conversation_status: 'active',
    location_id: null,
    language: 'en',
  };
}

function threadComposite(id, name, phone) {
  const messages = [];
  for (let i = 0; i < 14; i += 1) {
    messages.push({
      message_id: `${id}-m${i}`,
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      message_text: i % 2 === 0
        ? 'Hi! Is a bed free for two nights from Friday, and do you rent boards?'
        : 'Yes — a shared dorm bed is free from Friday, and boards are included in the surf package.',
      created_at: new Date(Date.now() - (14 - i) * 60000).toISOString(),
      sent_by: i % 2 === 0 ? null : 'luna',
    });
  }
  return {
    success: true,
    conversation_id: id,
    detail: {
      success: true,
      conversation: Object.assign(conversationRow(id, name, phone, 'Thanks!'), {
        email: null,
        staff_reply_draft: '',
        human_notes: 'Repeat guest — prefers the quiet dorm.',
        conversation_summary: 'Asking about a two-night stay plus board rental.',
        handoff_reason: null,
      }),
    },
    messages: { success: true, messages, count: messages.length },
    context: {
      success: true,
      context: {
        conversation_id: id,
        booking_code: 'WH-2411-0042',
        booking_id: '2b6f1c44-9a11-4f0e-8b3d-6a1f2c7d9e10',
        check_in: '2026-08-21',
        check_out: '2026-08-23',
        guest_count: 2,
      },
      bookings: [
        {
          booking_id: '2b6f1c44-9a11-4f0e-8b3d-6a1f2c7d9e10',
          booking_code: 'WH-2411-0042',
          booking_status: 'confirmed',
          booking_payment_status: 'deposit_paid',
          booking_guest_name: name,
          check_in: '2026-08-21',
          check_out: '2026-08-23',
          guest_count: 2,
          package_code: 'surf_stay_2n',
          room_preference: 'shared_dorm',
          assigned_room_code: 'D2',
          assigned_bed_code: 'D2-3',
          confirmation_sent_at: new Date().toISOString(),
          payment_amount_due_cents: 18000,
          payment_amount_paid_cents: 6000,
        },
        {
          booking_id: '4c8e2d55-1b22-4a1f-9c4e-7b2e3d8f0a21',
          booking_code: 'WH-2409-0031',
          booking_status: 'confirmed',
          booking_payment_status: 'paid',
          booking_guest_name: name,
          check_in: '2026-09-04',
          check_out: '2026-09-07',
          guest_count: 1,
          package_code: 'surf_stay_3n',
          room_preference: 'private',
          assigned_room_code: 'P1',
          assigned_bed_code: null,
          confirmation_sent_at: new Date().toISOString(),
          payment_amount_due_cents: 29000,
          payment_amount_paid_cents: 29000,
        },
      ],
    },
    draft: { success: false, error: 'Not found' },
    pause_state: { success: true, paused: false, conversation_id: id, client_slug: CLIENT },
  };
}

function buildPortalHtml() {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.DEFAULT_CLIENT_SLUG = CLIENT;
  const api = require(path.join(ROOT, 'scripts', 'staff-query-api.js'));
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  return api.buildUiHtmlForOfflineTest(0, CLIENT);
}

function startFixtureServer(html) {
  const { loadClientPortalProfile } = require(path.join(ROOT, 'scripts', 'lib', 'staff-portal-clients'));
  const profile = loadClientPortalProfile(CLIENT);

  const server = http.createServer((req, res) => {
    const url = String(req.url || '');
    const pathname = url.split('?')[0];

    const json = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    if (pathname === '/' || pathname === '/staff' || pathname === '/staff/ui') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (pathname === '/staff/auth/session') {
      json({
        success: true,
        auth_required: true,
        role: 'admin',
        db_role: 'admin',
        email: 'columns@example.test',
        display_name: 'Columns Harness',
        active_client: CLIENT,
        clients: [{ slug: CLIENT, name: 'Wolfhouse Somo (fixture)' }],
        client_profiles: { [CLIENT]: profile },
        can_use_owner_insights: true,
      });
      return;
    }
    if (pathname === '/staff/inbox/views') {
      json({
        success: true,
        groups: [{ id: 'inbox', label: 'INBOX' }],
        views: [{ id: 'all', label: 'All', group: 'inbox', count: 2 }],
      });
      return;
    }
    if (pathname === '/staff/inbox/list') {
      json({
        success: true,
        rows: [
          Object.assign({}, conversationRow(CONV_ID, 'Hernan Diaz', '+346****1222', 'Is a bed free from Friday?'), {
            display_name: 'Hernan Diaz',
            last_activity: '2026-08-13T06:00:00.000Z',
          }),
          Object.assign({}, conversationRow(CONV_ID_2, 'Marta Silva', '+346****3444', 'Can I add a board rental?'), {
            display_name: 'Marta Silva',
            last_activity: '2026-08-13T05:55:00.000Z',
          }),
        ],
      });
      return;
    }
    if (pathname === '/staff/conversations') {
      json({
        success: true,
        conversations: [
          conversationRow(CONV_ID, 'Hernan Diaz', '+34600111222', 'Is a bed free from Friday?'),
          conversationRow(CONV_ID_2, 'Marta Silva', '+34600333444', 'Can I add a board rental?'),
        ],
      });
      return;
    }
    if (pathname === `/staff/inbox/thread/${CONV_ID}`) {
      json(threadComposite(CONV_ID, 'Hernan Diaz', '+34600111222'));
      return;
    }
    if (pathname === `/staff/inbox/thread/${CONV_ID_2}`) {
      json(threadComposite(CONV_ID_2, 'Marta Silva', '+34600333444'));
      return;
    }
    /* The live poll re-reads the thread on its own; answer it from the same fixture. */
    const messages = /^\/staff\/conversations\/([0-9a-f-]+)\/messages$/.exec(pathname);
    if (messages) {
      json(threadComposite(messages[1], 'Hernan Diaz', '+34600111222').messages);
      return;
    }
    if (req.method !== 'GET') {
      json({ success: true, fixture: true });
      return;
    }
    json({ success: true, rows: [], fixture: true });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_e) {
    return null;
  }
}

/* ── page driving ────────────────────────────────────────────────────────── */

const MEASURE = () => {
  const rect = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    const cs = window.getComputedStyle(node);
    return {
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
      left: Math.round(r.left * 100) / 100,
      right: Math.round(r.right * 100) / 100,
      top: Math.round(r.top * 100) / 100,
      visible: cs.display !== 'none' && cs.visibility !== 'hidden'
        && parseFloat(cs.opacity) > 0.01 && r.width > 0,
      position: cs.position,
    };
  };
  const shell = document.getElementById('inbox-shell');
  const shellRect = shell ? shell.getBoundingClientRect() : null;
  return {
    attrs: shell
      ? {
        col1: shell.getAttribute('data-col1'),
        col2: shell.getAttribute('data-col2'),
        col4: shell.getAttribute('data-col4'),
        peek: shell.getAttribute('data-peek'),
      }
      : null,
    shellWidth: shellRect ? Math.round(shellRect.width * 100) / 100 : null,
    shellHeight: shellRect ? Math.round(shellRect.height * 100) / 100 : null,
    threadHost: rect('#conv-detail'),
    template: shell ? window.getComputedStyle(shell).gridTemplateColumns : null,
    col1: rect('#inbox-col1'),
    col2: rect('#inbox-card'),
    col3: rect('.detail-main'),
    col4: rect('#inbox-detail-sidebar'),
  };
};

/** Longer than the .16s peek transition, so a measurement never lands mid-slide. */
const SETTLE_MS = 300;

async function openInbox(page, base) {
  await page.addInitScript(() => {
    try { window.localStorage.setItem('wh_staff_portal_locale', 'en'); } catch (_e) { /* ignore */ }
  });
  await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#inbox-shell', { state: 'attached', timeout: 15000 });
  /* On a phone the tab buttons live behind the nav menu, so drive the tab, not the chrome. */
  await page.waitForSelector('.tab-btn[data-tab="conversations"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => {
    const btn = document.querySelector('.tab-btn[data-tab="conversations"]');
    if (btn) btn.click();
  });
  await page.waitForSelector('#tab-conversations.active', { timeout: 15000 });
  await page.waitForSelector('#inbox-shell', { timeout: 15000 });
  await page.waitForSelector(`#conv-list .conv-card[data-id="${CONV_ID}"]`, { state: 'attached', timeout: 15000 });
  /* With column 2 collapsed the list is an offscreen overlay, so open the thread directly. */
  await page.evaluate((id) => {
    const card = document.querySelector(`#conv-list .conv-card[data-id="${id}"]`);
    if (card) card.click();
  }, CONV_ID);
  await page.waitForSelector('.detail-main', { timeout: 15000 });
  await page.waitForSelector('#inbox-detail-sidebar', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(SETTLE_MS);
}

async function setPreset(page, preset) {
  await page.evaluate((name) => window.__inboxColumns.setPreset(name), preset);
  await page.waitForTimeout(SETTLE_MS);
}

async function resetStorage(page) {
  await page.evaluate(() => {
    Object.keys(window.localStorage)
      .filter((key) => key.indexOf(window.__inboxColumns.STORAGE_PREFIX) === 0)
      .forEach((key) => window.localStorage.removeItem(key));
    window.__inboxColumns.setPreset('all4');
  });
  await page.waitForTimeout(SETTLE_MS);
}

async function main() {
  console.log('verify-inbox-columns-playwright  (measured Inbox column widths)');

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log('  FAIL  playwright module unavailable (npx playwright install chromium)');
    return 1;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = buildPortalHtml();
  const { server, base } = await startFixtureServer(html);
  const measurements = {};

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await openInbox(page, base);
    await resetStorage(page);

    section('1. Presets at 1920×1080 — measured widths');
    for (const preset of ['all4', 'chat', 'guest']) {
      await setPreset(page, preset);
      const m = await page.evaluate(MEASURE);
      measurements[`1920:${preset}`] = m;
      const want = PRESETS[preset];

      ok(`${preset}: attributes are ${want.col1}/${want.col2}/${want.col4}`,
        m.attrs.col1 === want.col1 && m.attrs.col2 === want.col2 && m.attrs.col4 === want.col4,
        JSON.stringify(m.attrs));
      ok(`${preset}: column 1 measures ${W.col1[want.col1]}px`,
        near(m.col1.width, W.col1[want.col1]), m.col1.width);
      if (want.col2 === 'hidden') {
        ok(`${preset}: column 2 is off screen`, !m.col2 || !m.col2.visible,
          m.col2 && m.col2.width);
      } else {
        ok(`${preset}: column 2 measures ${W.col2[want.col2]}px`,
          near(m.col2.width, W.col2[want.col2]), m.col2.width);
      }
      ok(`${preset}: column 4 measures ${W.col4[want.col4]}px`,
        near(m.col4.width, W.col4[want.col4]), m.col4.width);
      ok(`${preset}: column 3 keeps its ${COL3_MIN}px floor`, m.col3.width >= COL3_MIN, m.col3.width);
      ok(`${preset}: column 3 absorbs the whole remainder`,
        near(m.col4.right, m.col3.right + W.col4[want.col4] + 14, 2)
        || near(m.col3.right + 14, m.col4.left, 2),
        JSON.stringify({ col3Right: m.col3.right, col4Left: m.col4.left }));
      ok(`${preset}: grid template is four tracks`,
        String(m.template).trim().split(/\s+/).length === 4, m.template);

      const shot = path.join(OUT_DIR, `preset-${preset}-1920.png`);
      await page.screenshot({ path: shot });
      measurements[`1920:${preset}`].screenshot = shot;
    }

    section('2. Column 3 grows as the others collapse');
    const a = measurements['1920:all4'];
    const c = measurements['1920:chat'];
    const g = measurements['1920:guest'];
    ok('chat gives column 3 more room than all four',
      c.col3.width > a.col3.width,
      JSON.stringify({ all4: a.col3.width, chat: c.col3.width }));
    ok('chat column 3 is the widest of the three presets',
      c.col3.width > g.col3.width,
      JSON.stringify({ chat: c.col3.width, guest: g.col3.width }));
    ok('every preset fills the same shell width',
      near(a.shellWidth, c.shellWidth, 1) && near(a.shellWidth, g.shellWidth, 1),
      JSON.stringify({ all4: a.shellWidth, chat: c.shellWidth, guest: g.shellWidth }));

    section('3. Individual toggles move one column only');
    await resetStorage(page);
    const before = await page.evaluate(MEASURE);
    await page.keyboard.press('Alt+Digit2');
    await page.waitForTimeout(SETTLE_MS);
    const afterCol2 = await page.evaluate(MEASURE);
    measurements['1920:alt2'] = afterCol2;
    ok('Alt+2 takes column 2 off screen', !afterCol2.col2 || !afterCol2.col2.visible,
      afterCol2.col2 && afterCol2.col2.width);
    ok('Alt+2 leaves column 1 at 240px', near(afterCol2.col1.width, 240), afterCol2.col1.width);
    ok('Alt+2 leaves column 4 at its peek width', near(afterCol2.col4.width, 300), afterCol2.col4.width);
    ok('column 3 takes the 360px column 2 gave up',
      near(afterCol2.col3.width, before.col3.width + 360 + 14, 2),
      JSON.stringify({ before: before.col3.width, after: afterCol2.col3.width }));

    await page.keyboard.press('Alt+Digit2');
    await page.waitForTimeout(SETTLE_MS);
    const restored = await page.evaluate(MEASURE);
    ok('Alt+2 again restores column 2 to 360px', near(restored.col2.width, 360), restored.col2.width);

    await page.keyboard.press('Alt+Digit1');
    await page.waitForTimeout(SETTLE_MS);
    const iconsRail = await page.evaluate(MEASURE);
    measurements['1920:alt1'] = iconsRail;
    ok('Alt+1 snaps column 1 to 56px and never hides it',
      near(iconsRail.col1.width, 56) && iconsRail.col1.visible, iconsRail.col1.width);

    await page.keyboard.press('Alt+Shift+Digit4');
    await page.waitForTimeout(SETTLE_MS);
    const noGuest = await page.evaluate(MEASURE);
    measurements['1920:alt-shift-4'] = noGuest;
    ok('Alt+Shift+4 takes column 4 off screen', !noGuest.col4 || !noGuest.col4.visible,
      noGuest.col4 && noGuest.col4.width);
    ok('column 3 reaches past 1300px with 1 at icons and 4 hidden',
      noGuest.col3.width > 1300, noGuest.col3.width);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(SETTLE_MS);
    const escaped = await page.evaluate(MEASURE);
    ok('Escape restores all four (240 / 360 / 300)',
      near(escaped.col1.width, 240) && near(escaped.col2.width, 360) && near(escaped.col4.width, 300),
      JSON.stringify({ col1: escaped.col1.width, col2: escaped.col2.width, col4: escaped.col4.width }));

    section('4. Peek overlays column 3 without moving a track');
    await setPreset(page, 'chat');
    const chatTracks = await page.evaluate(MEASURE);
    await page.hover('[data-inbox-peek-edge="col2"]');
    await page.waitForTimeout(SETTLE_MS);
    const peeked = await page.evaluate(MEASURE);
    measurements['1920:peek-col2'] = peeked;
    ok('the peek is announced on the container', peeked.attrs.peek === 'col2', JSON.stringify(peeked.attrs));
    ok('column 2 slides in at its 360px overlay width', near(peeked.col2.width, 360, 2), peeked.col2.width);
    ok('the peeked column is an overlay, not a track', peeked.col2.position === 'absolute', peeked.col2.position);
    ok('column 3 does not move while a column is peeked',
      near(peeked.col3.width, chatTracks.col3.width, 1) && near(peeked.col3.left, chatTracks.col3.left, 1),
      JSON.stringify({ before: chatTracks.col3.width, during: peeked.col3.width }));
    ok('the column states are untouched by a peek',
      peeked.attrs.col1 === 'icons' && peeked.attrs.col2 === 'hidden',
      JSON.stringify(peeked.attrs));
    const peekShot = path.join(OUT_DIR, 'peek-col2-1920.png');
    await page.screenshot({ path: peekShot });

    await page.click(`#conv-list .conv-card[data-id="${CONV_ID_2}"]`);
    await page.waitForTimeout(SETTLE_MS);
    const afterPick = await page.evaluate(MEASURE);
    ok('picking a conversation slides the peek away', !afterPick.attrs.peek, afterPick.attrs.peek);

    section('5. Viewport buckets, measured');
    const bucketCases = [
      { width: 1920, bucket: 'lg', col4Visible: true, col2Visible: true },
      { width: 1440, bucket: 'lg', col4Visible: true, col2Visible: true },
      { width: 1280, bucket: 'lg', col4Visible: true, col2Visible: true },
      { width: 1180, bucket: 'md', col4Visible: false, col2Visible: true },
      { width: 1000, bucket: 'md', col4Visible: false, col2Visible: true },
    ];
    for (const row of bucketCases) {
      await page.setViewportSize({ width: row.width, height: 1080 });
      await page.waitForTimeout(SETTLE_MS);
      await resetStorage(page);
      const m = await page.evaluate(MEASURE);
      measurements[`${row.width}:all4`] = m;
      const bucket = await page.evaluate(() => window.__inboxColumns.currentBucket());
      ok(`${row.width}px is bucket ${row.bucket}`, bucket === row.bucket, bucket);
      ok(`${row.width}px column 4 ${row.col4Visible ? 'stays' : 'auto-collapses'}`,
        !!(m.col4 && m.col4.visible) === row.col4Visible, JSON.stringify(m.attrs));
      ok(`${row.width}px column 2 ${row.col2Visible ? 'stays' : 'auto-hides'}`,
        !!(m.col2 && m.col2.visible) === row.col2Visible, JSON.stringify(m.attrs));
      ok(`${row.width}px keeps column 3 at or above its floor`, m.col3.width >= COL3_MIN, m.col3.width);
      if (row.width === 1180) {
        await page.screenshot({ path: path.join(OUT_DIR, 'bucket-md-1180.png') });
      }
      ok(`${row.width}px never overflows the shell`,
        m.col3.width + (m.col2 && m.col2.visible ? m.col2.width : 0)
          + (m.col4 && m.col4.visible ? m.col4.width : 0) + m.col1.width <= m.shellWidth + 1,
        JSON.stringify({ shell: m.shellWidth, col1: m.col1.width, col2: m.col2 && m.col2.width, col3: m.col3.width, col4: m.col4 && m.col4.width }));
    }

    await page.setViewportSize({ width: 860, height: 1000 });
    await page.waitForTimeout(SETTLE_MS);
    await resetStorage(page);
    const small = await page.evaluate(MEASURE);
    measurements['860:all4'] = small;
    const smallBucket = await page.evaluate(() => window.__inboxColumns.currentBucket());
    ok('860px is bucket sm', smallBucket === 'sm', smallBucket);
    ok('860px derives column 2 hidden and column 4 hidden',
      small.attrs.col2 === 'hidden' && small.attrs.col4 === 'hidden', JSON.stringify(small.attrs));

    section('6. A manual override survives until a bucket boundary');
    await page.setViewportSize({ width: 1180, height: 1080 });
    await page.waitForTimeout(SETTLE_MS);
    await resetStorage(page);
    const clamped = await page.evaluate(MEASURE);
    ok('md clamps column 4 away', !clamped.col4 || !clamped.col4.visible, JSON.stringify(clamped.attrs));
    await page.keyboard.press('Alt+Shift+Digit4');
    await page.waitForTimeout(SETTLE_MS);
    const overridden = await page.evaluate(MEASURE);
    ok('a manual restore beats the md clamp',
      overridden.attrs.col4 === 'peek' && overridden.col4.visible, JSON.stringify(overridden.attrs));
    /* Four columns at their documented widths need ~1462px; below that the snapping
       tracks give ground rather than push column 3 under its floor or overflow. */
    ok('a restore below 1280px squeezes the snapping tracks, not column 3',
      overridden.col4.width > 0 && overridden.col4.width <= 300
      && overridden.col3.width >= COL3_MIN
      && overridden.col1.width + overridden.col2.width + overridden.col3.width
        + overridden.col4.width <= overridden.shellWidth + 1,
      JSON.stringify({
        col1: overridden.col1.width,
        col2: overridden.col2.width,
        col3: overridden.col3.width,
        col4: overridden.col4.width,
        shell: overridden.shellWidth,
      }));
    await page.setViewportSize({ width: 1050, height: 1080 });
    await page.waitForTimeout(SETTLE_MS);
    const stillOverridden = await page.evaluate(MEASURE);
    ok('staying inside md keeps the override',
      !!(stillOverridden.col4 && stillOverridden.col4.visible), JSON.stringify(stillOverridden.attrs));
    await page.setViewportSize({ width: 1600, height: 1080 });
    await page.waitForTimeout(SETTLE_MS);
    await page.setViewportSize({ width: 1050, height: 1080 });
    await page.waitForTimeout(SETTLE_MS);
    const rederived = await page.evaluate(MEASURE);
    ok('crossing into lg and back re-derives the state',
      !rederived.col4 || !rederived.col4.visible, JSON.stringify(rederived.attrs));

    section('7. Persistence survives a reload, keyed by bucket');
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(SETTLE_MS);
    await resetStorage(page);
    await setPreset(page, 'guest');
    await openInbox(page, base);
    const reloaded = await page.evaluate(MEASURE);
    ok('the guest preset comes back after a reload',
      reloaded.attrs.col1 === 'full' && reloaded.attrs.col2 === 'comfortable' && reloaded.attrs.col4 === 'wide',
      JSON.stringify(reloaded.attrs));
    ok('column 4 measures its 460px wide state after the reload',
      near(reloaded.col4.width, 460), reloaded.col4.width);
    const storedKeys = await page.evaluate(() => Object.keys(window.localStorage)
      .filter((key) => key.indexOf(window.__inboxColumns.STORAGE_PREFIX) === 0));
    ok('the persisted key carries the viewport bucket',
      storedKeys.some((key) => /:lg$/.test(key)), storedKeys.join(', '));

    section('8. Phone width keeps the master/detail stack');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(SETTLE_MS);
    await openInbox(page, base);
    const phoneThread = await page.evaluate(MEASURE);
    measurements['390:thread'] = phoneThread;
    ok('the thread takes the whole phone width', near(phoneThread.col3.width, phoneThread.shellWidth, 2),
      JSON.stringify({ col3: phoneThread.col3.width, shell: phoneThread.shellWidth }));
    ok('the thread takes the whole phone height',
      near(phoneThread.threadHost.height, phoneThread.shellHeight, 2),
      JSON.stringify({ host: phoneThread.threadHost.height, shell: phoneThread.shellHeight }));
    ok('the rail and the list are out of the way while a thread is open',
      (!phoneThread.col1 || !phoneThread.col1.visible) && (!phoneThread.col2 || !phoneThread.col2.visible),
      JSON.stringify({ col1: phoneThread.col1, col2: phoneThread.col2 }));
    await page.click('#inbox-mobile-back');
    await page.waitForTimeout(SETTLE_MS);
    const phoneList = await page.evaluate(MEASURE);
    measurements['390:list'] = phoneList;
    ok('back puts the rail and the list back, both full width',
      near(phoneList.col1.width, phoneList.shellWidth, 2) && near(phoneList.col2.width, phoneList.shellWidth, 2),
      JSON.stringify({ col1: phoneList.col1.width, col2: phoneList.col2.width, shell: phoneList.shellWidth }));
    ok('the rail sits above the list rather than beside it',
      phoneList.col2.left === phoneList.col1.left, JSON.stringify({ col1: phoneList.col1.left, col2: phoneList.col2.left }));
    ok('back takes the closed thread out of the flow', !phoneList.threadHost.visible,
      JSON.stringify(phoneList.threadHost));
    ok('the list keeps every row of height the rail does not need',
      near(phoneList.col2.height, phoneList.shellHeight - phoneList.col1.height, 2),
      JSON.stringify({
        list: phoneList.col2.height, rail: phoneList.col1.height, shell: phoneList.shellHeight,
      }));
    await page.screenshot({ path: path.join(OUT_DIR, 'phone-390-list.png') });

    await page.setViewportSize({ width: 800, height: 844 });
    await page.waitForTimeout(SETTLE_MS);
    await openInbox(page, base);
    const tablet = await page.evaluate(MEASURE);
    measurements['800:stack'] = tablet;
    ok('800px stacks rail, list and thread in one column',
      tablet.col1.left === tablet.col2.left && tablet.col2.left === tablet.threadHost.left
      && tablet.col1.top < tablet.col2.top && tablet.col2.top < tablet.threadHost.top,
      JSON.stringify({ rail: tablet.col1.top, list: tablet.col2.top, thread: tablet.threadHost.top }));
    ok('the list and the thread split the height the rail leaves',
      near(tablet.col2.height, tablet.threadHost.height, 2)
      && tablet.col2.height > 200,
      JSON.stringify({
        list: tablet.col2.height, thread: tablet.threadHost.height, rail: tablet.col1.height,
      }));
    await page.screenshot({ path: path.join(OUT_DIR, 'tablet-800-stack.png') });

    fs.writeFileSync(
      path.join(OUT_DIR, 'measurements.json'),
      `${JSON.stringify(measurements, null, 2)}\n`,
      'utf8',
    );

    section('9. Measured widths');
    Object.keys(measurements).forEach((key) => {
      const m = measurements[key];
      console.log(`  ${key.padEnd(20)} shell ${String(m.shellWidth).padStart(7)}`
        + `  col1 ${String(m.col1 ? m.col1.width : 0).padStart(6)}`
        + `  col2 ${String(m.col2 && m.col2.visible ? m.col2.width : 0).padStart(6)}`
        + `  col3 ${String(m.col3 ? m.col3.width : 0).padStart(7)}`
        + `  col4 ${String(m.col4 && m.col4.visible ? m.col4.width : 0).padStart(6)}`);
    });
    console.log(`  widths + screenshots: ${OUT_DIR}`);
  } finally {
    await browser.close();
    if (process.argv.indexOf('--keep') < 0) await new Promise((r) => server.close(r));
  }

  console.log(`\n── verify:inbox-columns-playwright: ${pass} passed, ${fail} failed ──`);
  return fail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
