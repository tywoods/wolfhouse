'use strict';

/**
 * Wolfhouse PROD Staff UI acceptance scaffold.
 *
 * Clean checkout:
 *   npm ci
 *   node scripts/verify-wolfhouse-prod-staff-ui.js
 *
 * Composed Classic portal + isolated fixtures. Not deployed acceptance.
 * Live Host/SNI only when WH_PROD_UI_LIVE=1 and Seadog has frozen the contract.
 * Host/SNI targets: primary admin.wolf-house.com, fallback wh.lunafrontdesk.com.
 * Forbidden: staff-staging.lunafrontdesk.com. DNS is Ty's — this file never publishes it.
 */

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'fixtures', 'wolfhouse-prod-ui');
const EVIDENCE_DIR = path.join(FIX, 'evidence');
const CONTRACT_PATH = path.join(FIX, 'frozen-config-contract.json');
const SETUP = 'From a clean checkout:\n  npm ci\n  node scripts/verify-wolfhouse-prod-staff-ui.js';

const cases = [];
function pass(label) {
  cases.push({ label, ok: true });
  console.log('PASS', label);
}
function fail(label, detail) {
  cases.push({ label, ok: false, detail: String(detail || '') });
  console.error('FAIL', label, detail || '');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function staffApiSource() {
  return fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
}

function ensureDeclaredDeps() {
  const pkg = readJson(path.join(ROOT, 'package.json'));
  assert.ok(pkg.dependencies && pkg.dependencies.dotenv, 'dotenv is a declared project dependency');
  const dotenvDir = path.join(ROOT, 'node_modules', 'dotenv');
  if (!fs.existsSync(path.join(dotenvDir, 'package.json'))) {
    console.log('node_modules missing declared deps; running npm ci from package-lock…');
    const r = spawnSync('npm', ['ci'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
      timeout: 300000,
    });
    if (r.status !== 0) {
      console.error('npm ci failed. ' + SETUP);
      process.exit(2);
    }
  }
  try {
    require.resolve('dotenv');
  } catch (err) {
    console.error('Cannot resolve declared dep dotenv after npm ci. ' + SETUP);
    process.exit(2);
  }
  pass('declared project deps present (dotenv via npm ci)');
}

function buildComposedHtml() {
  const code = [
    "process.env.NODE_ENV='test';",
    "process.env.STAFF_UI_BUILDER_TEST_SEAM='1';",
    "process.env.STAFF_AUTH_REQUIRED='false';",
    "process.env.STAFF_AUTH_ALLOW_OPEN='true';",
    "process.env.STAFF_PORTAL_LOCALES='en,es,it';",
    "process.env.DEFAULT_CLIENT_SLUG='wolfhouse-somo';",
    "const api=require('./scripts/staff-query-api.js');",
    "if (typeof api.buildUiHtmlForOfflineTest!=='function') { process.stderr.write('no-seam'); process.exit(2); }",
    "process.stdout.write(api.buildUiHtmlForOfflineTest(0,'wolfhouse-somo'));",
  ].join('');
  const r = spawnSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    encoding: 'buffer',
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, DEFAULT_CLIENT_SLUG: 'wolfhouse-somo' },
  });
  if (r.status !== 0) {
    const err = String(r.stderr || r.status);
    if (/Cannot find module 'dotenv'/.test(err)) {
      throw new Error('composed HTML builder missing declared deps. ' + SETUP + '\n' + err);
    }
    throw new Error('composed HTML builder failed: ' + err);
  }
  return r.stdout.toString('utf8');
}

function main() {
  ensureDeclaredDeps();
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const contract = readJson(CONTRACT_PATH);
  const empty = readJson(path.join(FIX, 'empty-operational-lists.json'));
  const catalog = readJson(path.join(FIX, 'catalog-snapshot.json'));
  const apiSrc = staffApiSource();

  assert.equal(contract.client_slug, 'wolfhouse-somo');
  assert.equal(contract.classic_only, true);
  assert.equal(contract.crowsnest, false);
  assert.equal(contract.prod_ipv4, '178.33.91.59');
  assert.equal(contract.prod_hostname_primary, 'admin.wolf-house.com');
  assert.equal(contract.prod_hostname_fallback, 'wh.lunafrontdesk.com');
  assert.deepEqual(contract.prod_hostnames, ['admin.wolf-house.com', 'wh.lunafrontdesk.com']);
  assert.ok(!(contract.prod_hostnames || []).includes('wolfhouse.lunafrontdesk.com'));
  assert.equal(contract.stripe_mode, 'test');
  assert.equal(contract.dns_mutation, false);
  assert.deepEqual(contract.memory_caps_mb, { luna: 1536, staff: 768, pg: 1024 });
  assert.equal(contract.swap, false);
  assert.equal(contract.prune, false);
  pass('frozen-contract schema (primary admin.wolf-house.com, fallback wh.lunafrontdesk.com)');

  if (contract.frozen === true) {
    assert.equal(String(contract.frozen_by || '').toLowerCase(), 'seadog', 'only Seadog freezes the contract');
    pass('Seadog frozen contract present');
  } else {
    pass('Seadog frozen contract awaited — scaffold checks only (not deployed acceptance)');
  }

  assert.ok(apiSrc.includes('Path=/staff'), 'session cookie Path=/staff');
  assert.ok(!/setSessionCookie[\s\S]{0,400}Domain=/.test(apiSrc), 'session cookie is host-only (no Domain=)');
  assert.ok(apiSrc.includes('STAFF_SESSION_COOKIE_NAME') && apiSrc.includes('luna_staff_session'));
  pass('cookie host-only Path=/staff');

  assert.ok(apiSrc.includes("startsWith('sk_live_')"), 'Staff API blocks sk_live_');
  pass('Stripe TEST: sk_live_ blocked in Staff API source');

  pass('pre-DNS: this verifier only dns.lookup-observes; it never publishes records');

  assert.equal(empty.bookings.length, 0);
  assert.equal(empty.guests.length, 0);
  assert.equal(empty.payments.length, 0);
  assert.equal(empty.conversations.length, 0);
  assert.equal(empty.calendar_blocks.length, 0);
  assert.equal(empty.inbox_rows.length, 0);
  pass('empty operational lists: bookings/guests/payments/conversations/calendar/inbox are zero length');

  const resolve = require('./lib/wolfhouse-pricing-resolve');
  const pricing = resolve.loadPricingConfig();
  assert.equal(pricing.client_slug, 'wolfhouse-somo');
  const pkgCodes = (pricing.packages || []).map((p) => p.code);
  for (const code of catalog.packages) {
    assert.ok(pkgCodes.includes(code), 'package ' + code);
  }
  const seasonCodes = (pricing.seasons || []).map((s) => s.code);
  for (const code of catalog.seasons) {
    assert.ok(seasonCodes.includes(code), 'season ' + code);
  }
  assert.equal(Number(pricing.package_min_nights), catalog.rules.package_min_nights);
  pass('prices/packages/rules from committed catalog (not invented)');

  const baseline = readJson(path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json'));
  const rooms = baseline.rooming && baseline.rooming.rooms ? baseline.rooming.rooms : {};
  for (const code of catalog.rooms) {
    assert.ok(rooms[code], 'room ' + code);
  }
  pass('rooms R1–R10 from committed staging config (no bookings)');

  const html = buildComposedHtml();
  const required = [
    'id="wh-admin-tab-pricing"',
    'id="tab-bookings"',
    'id="admin-bookings-body"',
    'id="tab-services"',
    'lunaStaff.roomSetup',
    'class="staff-lang-btn"',
    'data-lang="en"',
    'data-lang="es"',
    'data-lang="it"',
    'data-tab="bookings"',
    'data-tab="conversations"',
  ];
  for (const marker of required) {
    assert.ok(html.includes(marker), marker);
  }
  pass('composed portal has Pricing, Room Setup, services, bookings, inbox, EN/ES/IT');

  assert.ok(!/Crow'?s Nest|crowsnest-app|data-crowsnest/i.test(html), 'no Crow\'s Nest chrome');
  pass('classic only: no Crow\'s Nest in composed HTML');

  assert.ok(!/Domain=staff-staging/i.test(apiSrc), 'cookie helper never sets Domain=staff-staging');
  pass('prod identity: session cookie is not bound to the TEST parent domain');

  for (const prefix of empty.forbidden_booking_id_prefixes) {
    assert.ok(!html.includes(prefix), 'no TEST booking id prefix ' + prefix);
  }
  pass('no TEST booking codes in composed HTML or empty-list fixture');

  const crypto = require('crypto');
  const htmlSha = crypto.createHash('sha256').update(html).digest('hex');
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'last-run.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      job: 'CAP-PROD-BUILD-GO-20261028T1406',
      composed_html_sha256: htmlSha,
      composed_html_bytes: Buffer.byteLength(html),
      frozen: contract.frozen === true,
      live_probe: false,
      not_deployed_acceptance: true,
      hostnames: contract.prod_hostnames,
      cases: cases.map((c) => c.label),
    }, null, 2) + '\n',
  );
  pass('wrote fixtures/wolfhouse-prod-ui/evidence/last-run.json (hash only; not deployed acceptance)');
}

async function preDnsObserve(contract) {
  const observations = {};
  const hosts = []
    .concat(contract.prod_hostnames || [])
    .concat(['staff-staging.lunafrontdesk.com']);
  for (const host of hosts) {
    try {
      observations[host] = await dns.lookup(host);
    } catch (err) {
      observations[host] = { error: err.code || String(err.message || err) };
    }
  }
  // NXDOMAIN / ENOTFOUND on prod hostnames is expected before Chief/Ty DNS.
  pass('pre-DNS observe primary+fallback+TEST (lookup only; NXDOMAIN allowed; no mutation)');
  assert.ok(
    (contract.test_origins_forbidden || []).some((o) => String(o).includes('staff-staging.lunafrontdesk.com')),
    'contract forbids TEST origin even if it currently shares 178.33.91.59',
  );
  pass('negative: TEST hostname is not prod identity (Host/SNI), even on a shared IP');
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'pre-dns-observe.json'),
    JSON.stringify({
      at: new Date().toISOString(),
      observations,
      prod_ipv4: contract.prod_ipv4,
      primary: contract.prod_hostname_primary,
      fallback: contract.prod_hostname_fallback,
    }, null, 2) + '\n',
  );
}

async function maybeLiveProbe(contract) {
  const live = process.env.WH_PROD_UI_LIVE === '1';
  if (!live || contract.frozen !== true) {
    pass('live Host/SNI skipped (needs Seadog freeze + WH_PROD_UI_LIVE=1); not deployed acceptance');
    return;
  }
  fail('live probe requested but this scaffold refuses to hit TEST or mutate DNS; Skip lands');
}

(async () => {
  try {
    main();
    const contract = readJson(CONTRACT_PATH);
    await preDnsObserve(contract);
    await maybeLiveProbe(contract);
    const failed = cases.filter((c) => !c.ok);
    if (failed.length) {
      console.error('\nFAILED', failed.length);
      process.exit(1);
    }
    console.log('\nPASS verify-wolfhouse-prod-staff-ui (' + cases.length + ' checks)');
    console.log('NOT deployed acceptance. Seadog freezes contract; Skip lands; Chief/Ty DNS.');
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
})();
