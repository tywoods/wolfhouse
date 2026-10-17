'use strict';
// Staff portal fields: wetsuit promo, who-can-book, staff access code.
// Real router + isolated PGlite. Access code is compared, never printed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'artifacts/staff-portal-fields'));
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM = '11111111-1111-4111-8111-111111111111';
const BED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OFFER = 'Free wetsuit with a week stay';
const SECRET = crypto.randomBytes(12).toString('base64url');
const LOG_FILE = path.join(ROOT, 'logs', 'staff-query-log.jsonl');

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual == null ? '' : actual));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function assertSecret(actual, expected, label) {
  if (!sameSecret(actual, expected)) {
    throw new Error(label + ' mismatch');
  }
}

function assertNoSecret(text, label) {
  if (String(text == null ? '' : text).includes(SECRET)) {
    throw new Error(label + ' leaked access code');
  }
}

function assertFileHasNoSecret(file, label) {
  if (!fs.existsSync(file)) return;
  const buf = fs.readFileSync(file);
  if (buf.includes(Buffer.from(SECRET))) throw new Error(label + ' leaked access code');
}

(async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const logBefore = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  for (const key of Object.keys(process.env)) {
    if (/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WHATSAPP_|PG|DATABASE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STAFF_RUNTIME_PROFILE: 'test',
    STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'false',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_INTERNAL_TOKEN: 'offline-staff-portal-fields-fixture-only',
    STAFF_ACTIONS_ENABLED: 'false',
    BOT_BOOKING_ENABLED: 'false',
    STRIPE_LINKS_ENABLED: 'false',
    WHATSAPP_SEND_ENABLED: 'false',
  });

  const dbPath = path.join(OUT, 'isolated-sql-' + crypto.randomUUID());
  const { PGlite } = require('@electric-sql/pglite');
  let db = new PGlite(dbPath);
  const owner = {
    staff_user_id: '10000000-0000-4000-8000-000000000001',
    role: 'owner',
    client_id: CLIENT,
    client_slug: 'wolfhouse-somo',
  };
  let session = owner;
  const api = require('./staff-query-api');
  api.setFortress15j3OfflineSeams({
    resolveSessionUser: () => session,
    withPgClient: async (fn) => fn(db),
  });

  await db.exec(`
    CREATE TABLE clients(id uuid PRIMARY KEY, slug text, settings jsonb DEFAULT '{}');
    CREATE TABLE rooms(
      id uuid PRIMARY KEY, client_id uuid, room_code text, name text, house text,
      capacity integer, room_type text, gender_strategy text, active boolean DEFAULT true,
      can_be_matrimonial boolean DEFAULT false, often_used_by_operator boolean DEFAULT false
    );
    CREATE TABLE beds(
      id uuid PRIMARY KEY, client_id uuid, room_id uuid, bed_code text,
      bed_number integer, active boolean DEFAULT true, sellable boolean DEFAULT true
    );
    CREATE TABLE bookings(id uuid PRIMARY KEY, client_id uuid, booking_code text, status text);
    CREATE TABLE booking_beds(
      id uuid PRIMARY KEY, bed_id uuid, booking_id uuid, client_id uuid,
      assignment_start_date date, assignment_end_date date
    );
    INSERT INTO clients VALUES ('${CLIENT}', 'wolfhouse-somo', '{}');
    INSERT INTO rooms(id, client_id, room_code, name, capacity, room_type, gender_strategy)
      VALUES ('${ROOM}', '${CLIENT}', 'R1', 'Room 1', 4, 'mixed', 'Flexible');
    INSERT INTO beds(id, client_id, room_id, bed_code, bed_number)
      VALUES ('${BED}', '${CLIENT}', '${ROOM}', 'R1-B1', 1);
  `);

  async function dispatch(spec) {
    session = spec.session === 'none' ? null
      : spec.session === 'viewer' ? { ...owner, role: 'viewer' }
        : owner;
    const raw = spec.body == null ? '' : String(spec.body);
    const req = Readable.from([Buffer.from(raw)]);
    const headers = Object.assign({
      'content-type': 'application/json',
      accept: 'application/json',
      host: 'staff.test',
      origin: 'http://staff.test',
    }, spec.headers || {});
    Object.assign(req, { method: spec.method || 'GET', url: spec.path, headers });
    let endResponse;
    const ended = new Promise((resolve) => { endResponse = resolve; });
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      writeHead(status, extra) {
        this.statusCode = status;
        if (extra) Object.assign(this.headers, extra);
      },
      end(rawBody) {
        const text = rawBody == null ? '' : rawBody.toString();
        this.bodyText = text;
        this.body = text ? JSON.parse(text) : null;
        endResponse();
      },
    };
    await api.router(req, res);
    await ended;
    return { status: res.statusCode, body: res.body, headers: res.headers };
  }

  const checks = [];
  function check(name, ok) {
    checks.push({ name, ok: !!ok });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name);
    if (!ok) throw new Error(name);
  }

  const anon = await dispatch({ session: 'none', method: 'GET', path: '/staff/admin/staff-access-code' });
  check('access code requires auth', anon.status === 401);
  const viewer = await dispatch({ session: 'viewer', method: 'GET', path: '/staff/admin/wetsuit-promo' });
  check('promo requires admin', viewer.status === 403);
  const other = await dispatch({ method: 'GET', path: '/staff/admin/staff-access-code?client=sunset' });
  check('other tenant hidden', other.status === 404);

  const savedPromo = await dispatch({
    method: 'PUT',
    path: '/staff/admin/wetsuit-promo',
    body: JSON.stringify({ text: OFFER }),
  });
  check('promo save', savedPromo.status === 200 && savedPromo.body.text === OFFER);
  const promoSql = await db.query('SELECT wetsuit_promo_text, staff_access_code FROM wolfhouse_staff_portal_fields');
  check('promo sql', promoSql.rows[0].wetsuit_promo_text === OFFER && promoSql.rows[0].staff_access_code === '');

  const savedCode = await dispatch({
    method: 'PUT',
    path: '/staff/admin/staff-access-code',
    body: JSON.stringify({ code: SECRET }),
  });
  check('access save status', savedCode.status === 200 && savedCode.body.configured === true);
  assertSecret(savedCode.body.code, SECRET, 'access save body');
  const codeSql = await db.query('SELECT staff_access_code, wetsuit_promo_text FROM wolfhouse_staff_portal_fields');
  assertSecret(codeSql.rows[0].staff_access_code, SECRET, 'access sql');
  check('promo survived access save', codeSql.rows[0].wetsuit_promo_text === OFFER);
  const promoRead = await dispatch({ method: 'GET', path: '/staff/admin/wetsuit-promo' });
  check('promo reload', promoRead.status === 200 && promoRead.body.text === OFFER && !('code' in promoRead.body));
  assertNoSecret(JSON.stringify(promoRead.body), 'promo response');
  const codeRead = await dispatch({ method: 'GET', path: '/staff/admin/staff-access-code' });
  assertSecret(codeRead.body.code, SECRET, 'access reload');
  check('access cache', String(codeRead.headers['Cache-Control'] || codeRead.headers['cache-control'] || '').includes('no-store'));

  const roomBefore = await dispatch({ method: 'GET', path: '/staff/luna-intelligence/room-fill' });
  check('room load', roomBefore.status === 200 && roomBefore.body.catalogue[0].whoCanBook === 'anyone');
  const roomSave = await dispatch({
    method: 'PUT',
    path: '/staff/luna-intelligence/room-fill/rooms/' + ROOM + '/gender',
    body: JSON.stringify({ gender: 'female', expectedCatalogRevision: roomBefore.body.catalogRevision }),
  });
  check('who can book save', roomSave.status === 200 && roomSave.body.catalogue[0].whoCanBook === 'women_only');
  const roomSql = await db.query('SELECT room_type, gender_strategy FROM rooms WHERE id=$1', [ROOM]);
  check('who can book sql', roomSql.rows[0].room_type === 'female_only' && roomSql.rows[0].gender_strategy === 'Female preferred');
  await db.query("UPDATE rooms SET room_type='mixed', gender_strategy='Flexible' WHERE id=$1", [ROOM]);

  const fieldsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/wolfhouse-staff-portal-fields-ui.js'), 'utf8');
  const roomUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/staff-room-fill.js'), 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Staff fields</title></head><body>
    <div id="al-wrap"><div id="cc-house-notes"></div></div>
    <div id="staff-room-fill"></div>
    <script>${roomUi}\n${fieldsUi}\nwindow.loadWolfhouseStaffPortalFields();</script>
  </body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const leaks = [];
      page.on('console', (msg) => { if (msg.text().includes(SECRET)) leaks.push('console'); });
      page.on('pageerror', (err) => { if (String(err && err.message).includes(SECRET)) leaks.push('pageerror'); });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/fields') {
          return route.fulfill({ contentType: 'text/html', body: html });
        }
        if (url.origin !== 'http://staff.test') return route.abort();
        const result = await dispatch({
          method: request.method(),
          path: url.pathname + url.search,
          body: request.postData() || '',
          headers: request.headers(),
        });
        if (url.pathname !== '/staff/admin/staff-access-code') {
          assertNoSecret(JSON.stringify(result.body), 'routed ' + url.pathname);
        }
        return route.fulfill({
          status: result.status,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: JSON.stringify(result.body),
        });
      });

      await page.goto('http://staff.test/fields', { waitUntil: 'domcontentloaded' });
      await page.locator('#wh-wetsuit-promo-text').waitFor();
      await page.locator('#rf-gender-' + ROOM).waitFor();
      const offerBox = page.locator('#wh-wetsuit-promo-text');
      const codeBox = page.locator('#wh-staff-access-code');
      const who = page.getByRole('combobox', { name: 'Who can book for Room 1', exact: true });

      check(width + ' promo visible', await offerBox.isVisible());
      check(width + ' access masked', await codeBox.getAttribute('type') === 'password');
      check(width + ' who options', JSON.stringify(await who.locator('option').allTextContents()) === JSON.stringify(['Choose', 'Women only', 'Men only', 'Anyone']));
      const bounds = await page.evaluate(() => {
        const card = document.getElementById('wh-staff-portal-fields');
        const room = document.getElementById('staff-room-fill');
        const widthNow = window.innerWidth;
        return {
          cardRight: card.getBoundingClientRect().right,
          roomRight: room.getBoundingClientRect().right,
          scroll: document.documentElement.scrollWidth,
          width: widthNow,
        };
      });
      check(width + ' no overflow', bounds.cardRight <= bounds.width + 1 && bounds.roomRight <= bounds.width + 1 && bounds.scroll <= bounds.width + 1);

      await offerBox.fill(OFFER + ' ' + width);
      await page.locator('#wh-wetsuit-promo-save').click();
      await page.locator('#wh-wetsuit-promo-status').filter({ hasText: 'Saved.' }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#wh-wetsuit-promo-text').waitFor();
      check(width + ' promo reload', await page.locator('#wh-wetsuit-promo-text').inputValue() === OFFER + ' ' + width);

      await page.locator('#wh-staff-access-code').fill(SECRET);
      await page.locator('#wh-staff-access-code-save').click();
      await page.locator('#wh-staff-access-code-status').filter({ hasText: 'Saved.' }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#wh-staff-access-code').waitFor();
      assertSecret(await page.locator('#wh-staff-access-code').inputValue(), SECRET, width + ' access reload');
      check(width + ' access still masked', await page.locator('#wh-staff-access-code').getAttribute('type') === 'password');

      const whoAgain = page.getByRole('combobox', { name: 'Who can book for Room 1', exact: true });
      await whoAgain.selectOption('male');
      await page.getByRole('button', { name: 'Save gender for Room 1', exact: true }).click();
      await page.locator('#rf-gender-status-' + ROOM).filter({ hasText: 'Saved' }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#rf-gender-' + ROOM).waitFor();
      const savedWho = page.getByRole('combobox', { name: 'Who can book for Room 1', exact: true });
      check(width + ' who reload value', await savedWho.inputValue() === 'male');
      check(width + ' who reload label', await savedWho.locator('option:checked').textContent() === 'Men only');
      check(width + ' who token', await page.evaluate((id) => {
        const room = window.__roomFillState.server.catalogue.find((item) => item.roomId === id);
        return room && room.whoCanBook;
      }, ROOM) === 'men_only');

      const shot = path.join(OUT, 'fields-' + width + '.png');
      await page.screenshot({ path: shot, fullPage: true });
      assertFileHasNoSecret(shot, width + ' screenshot');
      check(width + ' no console leak', leaks.length === 0);
      await context.close();
      await db.query("UPDATE rooms SET room_type='mixed', gender_strategy='Flexible' WHERE id=$1", [ROOM]);
    }
  } finally {
    await browser.close();
  }

  const finalRoom = await db.query('SELECT room_type, gender_strategy FROM rooms WHERE id=$1', [ROOM]);
  check('room restored anyone', finalRoom.rows[0].room_type === 'mixed');
  const finalCode = await db.query('SELECT staff_access_code FROM wolfhouse_staff_portal_fields');
  assertSecret(finalCode.rows[0].staff_access_code, SECRET, 'final sql');
  if (fs.existsSync(LOG_FILE)) {
    const added = fs.readFileSync(LOG_FILE).subarray(logBefore);
    if (added.includes(Buffer.from(SECRET))) throw new Error('audit log leaked access code');
    check('audit has no access code', true);
  }
  for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.png')) assertFileHasNoSecret(path.join(OUT, file), file);
  }
  const summary = { passed: checks.length, failed: checks.filter((item) => !item.ok).length, widths: [1280, 390] };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  assertFileHasNoSecret(path.join(OUT, 'results.json'), 'results');
  console.log('PASS staff portal fields ' + summary.passed + '/0');
  api.setFortress15j3OfflineSeams(null);
  await db.close();
})().catch((err) => {
  const message = String(err && err.stack || err);
  if (message.includes(SECRET)) {
    console.error('FAIL staff portal fields: error text contained the access code and was withheld');
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
