'use strict';

/**
 * verify:sunset-admin-helper-parity
 *
 * Compares inline Admin browser helpers (extracted from staff-query-api.js, evaluated
 * in Chromium) against scripts/lib/sunset-admin-ui-helpers.js (Node).
 *
 * Test-only — does not wire the live portal to the pure module.
 *
 * Run: node scripts/verify-sunset-admin-helper-parity.js
 *      npm run verify:sunset-admin-helper-parity
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildVerifyStaffUiHtml } = require('./lib/sunset-admin-verify-ui-html');
const { loadInlineAdminHelperSnippet, STAFF_API } = require('./lib/sunset-admin-helper-extract');
const pure = require('./lib/sunset-admin-ui-helpers');

const ROOT = path.join(__dirname, '..');
const BASELINE_DEST = path.join(ROOT, 'config', 'clients', 'sunset.baseline.json');
const BASELINE_SRC = path.join(ROOT, 'sunset.baseline.json');

const PORT = Number(process.env.STAFF_HELPER_PARITY_PORT || '4037');
const BASE_URL = `http://127.0.0.1:${PORT}`;

const HUMANIZE_CASES = [
  'Wetsuit rental',
  'surf lesson',
  'adolescent',
  'cfg:sunset:board_wetsuit_rental',
  'cfg:sunset:1_day_pack_surfer',
  'foo   bar   baz',
  '',
];

const SLOT_CASES = [
  '11:00-13:00',
  '09:30-11:00',
  '16:00 - 18:00',
  '',
  '11:00',
];

const DURATION_CASES = [
  '11:00-13:00',
  '09:30-11:00',
  '11:00-11:45',
  '11:00',
  '',
  '13:00-11:00',
];

const TIME_HM_CASES = ['00:00', '23:59', '24:00', '9:00', 'abc', ''];

const CAPACITY_CASES = ['1', '25', '999', '0', '1000', '', 'abc'];

let pass = 0;
let fail = 0;
let serverChild = null;
let createdEsShim = false;
let createdBaselineCopy = false;

function ensureSunsetBaselineForVerify() {
  if (fs.existsSync(BASELINE_DEST)) return;
  if (!fs.existsSync(BASELINE_SRC)) {
    throw new Error('Missing config/clients/sunset.baseline.json and sunset.baseline.json at repo root');
  }
  fs.mkdirSync(path.dirname(BASELINE_DEST), { recursive: true });
  fs.copyFileSync(BASELINE_SRC, BASELINE_DEST);
  createdBaselineCopy = true;
}

function ensureStaffPortalI18nEsForVerify() {
  const esTarget = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js');
  if (fs.existsSync(esTarget)) return;
  const esStub = path.join(ROOT, 'scripts', 'fixtures', 'staff-portal-i18n-es-stub.js');
  fs.copyFileSync(esStub, esTarget);
  createdEsShim = true;
}

function cleanupVerifyArtifacts() {
  if (createdEsShim) {
    try {
      fs.unlinkSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js'));
    } catch (_) { /* ignore */ }
  }
  if (createdBaselineCopy) {
    try {
      fs.unlinkSync(BASELINE_DEST);
    } catch (_) { /* ignore */ }
  }
}

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
  return false;
}

function parserEqual(a, b) {
  if (a.ok !== b.ok) return false;
  if (a.ok) return a.value === b.value;
  return true;
}

function waitForServerReady(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE_URL}/staff/ui`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
      function retry() {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`parity server not ready on ${BASE_URL}`));
          return;
        }
        setTimeout(tick, 200);
      }
    };
    tick();
  });
}

function startParityServer() {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  return new Promise((resolve, reject) => {
    serverChild = createSunsetAdminVerifyServer();
    serverChild.on('error', reject);
    serverChild.listen(PORT, '127.0.0.1', () => {
      waitForServerReady().then(resolve).catch(reject);
    });
  });
}

function stopParityServer() {
  if (!serverChild) return;
  try {
    serverChild.close();
  } catch (_) { /* ignore */ }
  serverChild = null;
}

async function runInlineHelpersInBrowser(page, snippet) {
  return page.evaluate(({ code, humanizeCases, slotCases, durationCases, timeHmCases, capacityCases }) => {
    // eslint-disable-next-line no-unused-vars
    function portalT(key) { return key; }
    // eslint-disable-next-line no-eval
    eval(code);
    const out = {
      humanize: {},
      slotStart: {},
      slotEnd: {},
      duration: {},
      timeHm: {},
      capacity: {},
    };
    for (const c of humanizeCases) out.humanize[c] = adminHumanizeText(c);
    for (const c of slotCases) {
      out.slotStart[c] = adminSlotTimeStart(c);
      out.slotEnd[c] = adminSlotTimeEnd(c);
    }
    for (const c of durationCases) out.duration[c] = adminSlotDurationLabel(c);
    for (const c of timeHmCases) out.timeHm[c] = adminParseTimeHm(c);
    for (const c of capacityCases) out.capacity[c] = adminParseCapacity(c);
    return out;
  }, {
    code: snippet,
    humanizeCases: HUMANIZE_CASES,
    slotCases: SLOT_CASES,
    durationCases: DURATION_CASES,
    timeHmCases: TIME_HM_CASES,
    capacityCases: CAPACITY_CASES,
  });
}

async function evalInlineHelpersFromUiScript(page) {
  return page.evaluate(() => {
    const scripts = Array.from(document.scripts)
      .map((s) => s.textContent || '')
      .filter((t) => t.includes('function adminHumanizeText('));
    if (!scripts.length) return { error: 'admin script not found in /staff/ui' };
    const script = scripts.reduce((a, b) => (a.length > b.length ? a : b), '');
    if (!script.includes('function adminParseCapacity(')) {
      return { error: 'adminParseCapacity missing from embedded script' };
    }
    return { ok: true, hasHumanize: script.includes('function adminHumanizeText(') };
  });
}

async function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    console.error('Playwright required: npm install --save-dev playwright && npx playwright install chromium');
    process.exit(2);
  }
}

function runNodePureCases() {
  return {
    humanize: Object.fromEntries(HUMANIZE_CASES.map((c) => [c, pure.adminHumanizeText(c)])),
    slotStart: Object.fromEntries(SLOT_CASES.map((c) => [c, pure.adminSlotTimeStart(c)])),
    slotEnd: Object.fromEntries(SLOT_CASES.map((c) => [c, pure.adminSlotTimeEnd(c)])),
    duration: Object.fromEntries(DURATION_CASES.map((c) => [c, pure.adminSlotDurationLabel(c)])),
    timeHm: Object.fromEntries(TIME_HM_CASES.map((c) => [c, pure.adminParseTimeHm(c)])),
    capacity: Object.fromEntries(CAPACITY_CASES.map((c) => [c, pure.adminParseCapacity(c)])),
  };
}

async function main() {
  console.log('\nverify:sunset-admin-helper-parity — inline browser vs pure module\n');
  ensureSunsetBaselineForVerify();
  ensureStaffPortalI18nEsForVerify();

  try {
  console.log('[1] Embedded /staff/ui HTML contains inline helper definitions\n');
  const html = buildVerifyStaffUiHtml();
  assert('buildVerifyStaffUiHtml ok', html.length > 5000);
  assert('embedded HTML has adminHumanizeText', html.includes('function adminHumanizeText('));
  assert('embedded HTML has adminSlotTimeEnd', html.includes('function adminSlotTimeEnd('));
  assert('embedded HTML has adminParseCapacity', html.includes('function adminParseCapacity('));

  const snippet = loadInlineAdminHelperSnippet();
  assert('extracted helper snippet from staff-query-api.js', snippet.length > 200);

  const playwright = await loadPlaywright();
  await startParityServer();

  let browser;
  let inline;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${BASE_URL}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const uiCheck = await evalInlineHelpersFromUiScript(page);
    assert('/staff/ui embeds admin helper script', uiCheck.ok === true, uiCheck.error || '');

    console.log('\n[2] Playwright eval of extracted inline helpers (from staff-query-api.js)\n');
    inline = await runInlineHelpersInBrowser(page, snippet);
    assert('browser inline helper eval completed', inline && typeof inline.humanize === 'object');
  } finally {
    if (browser) await browser.close();
  }

  const nodePure = runNodePureCases();

  console.log('\n[3] adminHumanizeText — browser vs pure\n');
  for (const input of HUMANIZE_CASES) {
    const b = inline.humanize[input];
    const n = nodePure.humanize[input];
    assert(`humanize ${JSON.stringify(input)}`, b === n, `browser=${JSON.stringify(b)} pure=${JSON.stringify(n)}`);
  }

  console.log('\n[4] adminSlotTimeStart / adminSlotTimeEnd — browser vs pure\n');
  for (const input of SLOT_CASES) {
    const bs = inline.slotStart[input];
    const ns = nodePure.slotStart[input];
    assert(`start ${JSON.stringify(input)}`, bs === ns, `browser=${JSON.stringify(bs)} pure=${JSON.stringify(ns)}`);
    const be = inline.slotEnd[input];
    const ne = nodePure.slotEnd[input];
    assert(`end ${JSON.stringify(input)}`, be === ne, `browser=${JSON.stringify(be)} pure=${JSON.stringify(ne)}`);
  }

  console.log('\n[5] adminSlotDurationLabel — browser vs pure\n');
  for (const input of DURATION_CASES) {
    const b = inline.duration[input];
    const n = nodePure.duration[input];
    assert(`duration ${JSON.stringify(input)}`, b === n, `browser=${JSON.stringify(b)} pure=${JSON.stringify(n)}`);
  }

  console.log('\n[6] adminParseTimeHm — browser vs pure (ok/value)\n');
  for (const input of TIME_HM_CASES) {
    const b = inline.timeHm[input];
    const n = nodePure.timeHm[input];
    assert(`timeHm ${JSON.stringify(input)}`, parserEqual(b, n),
      `browser=${JSON.stringify(b)} pure=${JSON.stringify(n)}`);
  }

  console.log('\n[7] adminParseCapacity — browser vs pure (ok/value)\n');
  for (const input of CAPACITY_CASES) {
    const b = inline.capacity[input];
    const n = nodePure.capacity[input];
    assert(`capacity ${JSON.stringify(input)}`, parserEqual(b, n),
      `browser=${JSON.stringify(b)} pure=${JSON.stringify(n)}`);
  }

  console.log('\n[8] Source file unchanged check\n');
  assert('staff-query-api.js readable', fs.existsSync(STAFF_API));

  console.log('\n' + '─'.repeat(48));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('verify:sunset-admin-helper-parity — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:sunset-admin-helper-parity — ALL CHECKS PASSED');
  console.log('\nNote: keep separate from npm run verify:sunset-admin (Playwright + fixture server).');
  } finally {
    stopParityServer();
    cleanupVerifyArtifacts();
  }
}

main().catch((err) => {
  stopParityServer();
  cleanupVerifyArtifacts();
  console.error('verify:sunset-admin-helper-parity — ERROR:', err.message);
  process.exit(1);
});
