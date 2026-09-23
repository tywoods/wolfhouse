'use strict';

/**
 * GINA-INBOX-12-13-002
 * Inbox booking open stays on the booking drawer (no schedule 403).
 * Confirmation events show in the thread from confirmation_sent_at.
 * Phone 390px: the real chip click must open #bc-side-drawer (display not none,
 * non-zero in-viewport rect). Return-value checks are not enough.
 * Run: node scripts/verify-gina-inbox-12-13.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CONTEXT = path.join(ROOT, 'scripts/browser/inbox-context.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const LIST = path.join(ROOT, 'scripts/browser/inbox-list.js');
const API = path.join(ROOT, 'scripts/staff-query-api.js');

let pass = 0;
let fail = 0;
function check(id, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${id}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${id}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

function extractFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function extractDrawerCascade(apiSrc) {
  const start = apiSrc.indexOf('/* staff-portal-calendar:side-drawer');
  const hideRe = /@media \(max-width:768px\)\{\s*#bc-side-drawer\{display:none!important\}\s*\}/g;
  let hideEnd = -1;
  let match;
  while ((match = hideRe.exec(apiSrc))) {
    if (match.index > start) hideEnd = match.index + match[0].length;
  }
  if (start < 0 || hideEnd < 0) throw new Error('drawer cascade markers missing');
  return apiSrc.slice(start, hideEnd);
}

function phoneOpenBeatsHide(apiSrc) {
  const re = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
  let match;
  while ((match = re.exec(apiSrc))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < apiSrc.length; i += 1) {
      if (apiSrc[i] === '{') depth += 1;
      else if (apiSrc[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;
    const block = apiSrc.slice(match.index, end + 1);
    if (/#bc-side-drawer\.is-open\s*\{[^}]*display\s*:\s*flex\s*!important/.test(block)) return true;
  }
  return false;
}

const contextSrc = fs.readFileSync(CONTEXT, 'utf8');
const threadSrc = fs.readFileSync(THREAD, 'utf8');
const listSrc = fs.readFileSync(LIST, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');

const clickBlock = threadSrc.slice(threadSrc.indexOf("querySelectorAll('.inbox-open-booking-cal')"));
check('C1', clickBlock.includes('inboxOpenBookingDrawerHere'), 'booking chip click opens the drawer');
check('C2', !/openBookingInCalendar\(/.test(clickBlock.slice(0, 900)), 'chip click must not leave for the calendar');
check('C3', !clickBlock.slice(0, 900).includes("switchToTab"), 'chip click must not switch tabs');

const openFn = extractFunctionSource(contextSrc, 'inboxOpenBookingDrawerHere');
check('D1', openFn.includes('inboxOpenWolfhouseBookingDrawer'), 'Wolfhouse has its own drawer path');
check('D2', openFn.includes('openScheduleDetailDrawer'), 'Sunset still uses the schedule drawer');
check('D3', !openFn.includes('/staff/schedule/bookings/detail'), 'open helper must not hardcode the sunset detail URL');

const wolfFn = (() => {
  try { return extractFunctionSource(contextSrc, 'inboxOpenWolfhouseBookingDrawer'); }
  catch (err) { return ''; }
})();
check('W1', wolfFn.includes('bcOpenSideBooking'), 'Wolfhouse opens the booking side drawer');
const ensureFn = (() => {
  try { return extractFunctionSource(contextSrc, 'inboxEnsureWolfhouseBookingDrawerOnBody'); }
  catch (err) { return ''; }
})();
check('W2', ensureFn.includes('bc-side-drawer') && ensureFn.includes('appendChild'), 'Wolfhouse drawer is lifted onto the page');
check('W3', !wolfFn.includes('openScheduleDetailDrawer'), 'Wolfhouse path must not call the sunset drawer');
check('W4', !wolfFn.includes("switchToTab"), 'Wolfhouse path must not switch to schedule/calendar');

check('S1', wolfFn.includes('loadBlockDetail') || apiSrc.includes('loadBlockDetail(code'), 'Wolfhouse open reaches loadBlockDetail');
check('S2', /\/staff\/bookings\/' \+ encodeURIComponent\(bookingCode\) \+ '\/context/.test(apiSrc), 'context URL is /staff/bookings/:code/context');
check('S3', apiSrc.includes('#bc-side-drawer{display:none!important}'), 'phone hide rule still present');
check('S4', phoneOpenBeatsHide(apiSrc), 'phone .is-open sets display:flex!important inside max-width:768px');

function t(key) { return key; }
function escHtml(v) { return String(v == null ? '' : v); }
function fmtTs(v) { return String(v || ''); }
function formatInboxThreadBubbleHtml(m) { return escHtml(m.message_text || ''); }
function inboxThreadDayKey() { return ''; }
function inboxThreadDayLabel() { return ''; }

const sandbox = {
  console, t, escHtml, fmtTs, formatInboxThreadBubbleHtml, inboxThreadDayKey, inboxThreadDayLabel,
  document: { body: { id: 'body' }, getElementById(id) { return sandbox.nodes[id] || null; } },
  nodes: {},
  calls: [],
  el(id) { return sandbox.nodes[id] || null; },
  getClient() { return sandbox.client; },
  isSunsetSurfActive() { return sandbox.client === 'sunset'; },
  openScheduleDetailDrawer(row) { sandbox.calls.push(['schedule', row]); },
  bcOpenSideBooking(blk) { sandbox.calls.push(['wolfhouse', blk]); },
  switchToTab() { sandbox.calls.push(['tab']); },
  openBookingInCalendar() { sandbox.calls.push(['calendar']); },
};
sandbox.window = sandbox;
sandbox.document.body.appendChild = function(node) { node.parentNode = sandbox.document.body; };
vm.createContext(sandbox);

const names = [
  'inboxEnsureScheduleDrawerOnBody',
  'inboxBookingUsesScheduleDrawer',
  'inboxEnsureWolfhouseBookingDrawerOnBody',
  'inboxOpenWolfhouseBookingDrawer',
  'inboxOpenBookingDrawerHere',
  'inboxConfirmationEventsFromBookings',
  'inboxRememberConfirmationEvents',
  'inboxMergeConfirmationEvents',
  'renderInboxThreadMessagesHtml',
];
const pieces = [];
for (const name of names) {
  const src = contextSrc.includes(`function ${name}(`) ? contextSrc : listSrc;
  try { pieces.push(extractFunctionSource(src, name)); }
  catch (err) { pieces.push(`function ${name}(){ throw new Error(${JSON.stringify(err.message)}); }`); }
}
vm.runInContext(pieces.join('\n'), sandbox);

const booking = {
  booking_id: '11111111-1111-4111-8111-111111111111',
  booking_code: 'WH-GINA',
  guest_name: 'Gina',
  check_in: '2026-09-23',
  check_out: '2026-09-28',
};
const hiddenParent = { id: 'tab-bed-calendar' };
sandbox.nodes['bc-side-drawer'] = { id: 'bc-side-drawer', parentNode: hiddenParent };
sandbox.client = 'wolfhouse-somo';
sandbox.calls = [];
let wolfOk = false;
try { wolfOk = sandbox.inboxOpenBookingDrawerHere(booking) === true; } catch (err) { wolfOk = false; }
check('R1', wolfOk, 'wolfhouse open returns true');
check('R2', sandbox.calls.some((c) => c[0] === 'wolfhouse' && c[1].booking_code === 'WH-GINA'), 'wolfhouse drawer got the booking code');
check('R3', !sandbox.calls.some((c) => c[0] === 'schedule' || c[0] === 'calendar' || c[0] === 'tab'), 'wolfhouse did not hit schedule/calendar');
check('R4', sandbox.nodes['bc-side-drawer'].parentNode === sandbox.document.body, 'drawer left the hidden calendar tab');

sandbox.client = 'sunset';
sandbox.calls = [];
sandbox.nodes['ps-detail-drawer'] = { id: 'ps-detail-drawer', parentNode: hiddenParent };
sandbox.nodes['ps-drawer-backdrop'] = { id: 'ps-drawer-backdrop', parentNode: hiddenParent };
let sunOk = false;
try { sunOk = sandbox.inboxOpenBookingDrawerHere(booking) === true; } catch (err) { sunOk = false; }
check('R5', sunOk && sandbox.calls.some((c) => c[0] === 'schedule'), 'sunset still opens the schedule drawer');
check('R6', !sandbox.calls.some((c) => c[0] === 'tab' || c[0] === 'calendar'), 'sunset click does not leave Inbox');

sandbox.inboxRememberConfirmationEvents([
  { booking_code: 'WH-GINA', confirmation_sent_at: '2026-09-20T10:00:00.000Z' },
  { booking_code: 'WH-OTHER', confirmation_sent_at: null },
]);
const html = sandbox.renderInboxThreadMessagesHtml([
  { direction: 'inbound', source: 'whatsapp', message_text: 'Hello', created_at: '2026-09-19T09:00:00.000Z' },
]);
check('E1', html.includes('Booking confirmed') && html.includes('WH-GINA'), 'confirmation event is in the thread');
check('E2', html.includes('Confirmation'), 'event is labeled Confirmation, not buried');
check('E3', html.includes('Hello'), 'guest messages stay');
check('E4', !html.includes('WH-OTHER'), 'unsent bookings do not invent an event');

function loadPlaywright() {
  const candidates = [
    'playwright',
    '/opt/data/home/.npm/_npx/e41f203b7505f1fb/node_modules/playwright',
    '/opt/wolfhouse/WH/node_modules/playwright',
  ];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (err) { /* next */ }
  }
  return null;
}

function chromiumExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/opt/data/workspace/.playwright/chromium-1228/chrome-linux64/chrome',
    '/opt/data/home/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function extractClickWire(src) {
  const start = src.indexOf("var calLinks = targetEl.querySelectorAll('.inbox-open-booking-cal');");
  const end = src.indexOf("targetEl.querySelectorAll('.inbox-booking-stack-item')", start);
  if (start < 0 || end < 0) throw new Error('real chip click wire missing');
  return src.slice(start, end);
}

function pageScript() {
  const fns = [
    'inboxBookingUsesScheduleDrawer',
    'inboxEnsureWolfhouseBookingDrawerOnBody',
    'inboxOpenWolfhouseBookingDrawer',
    'inboxOpenBookingDrawerHere',
    'bcOpenSideBooking',
    'loadBlockDetail',
  ].map((name) => {
    const src = contextSrc.includes(`function ${name}(`) ? contextSrc : apiSrc;
    return extractFunctionSource(src, name);
  }).join('\n');
  return `
function el(id){ return document.getElementById(id); }
function getClient(){ return 'wolfhouse-somo'; }
function isSunsetSurfActive(){ return false; }
function getBcClient(){ var node = el('bc-client'); return (node && node.value ? node.value : 'wolfhouse-somo').trim(); }
function bcUndockCreatePanel(){}
function bcSetSidePinned(){}
function bcSyncSideDrawerTop(){}
function bcPaintSideStayMeta(){}
function bcRenderDrawerLoadingHtml(){ return '<div class="bc-drawer-loading">Loading</div>'; }
function escHtml(v){ return String(v == null ? '' : v); }
var bcLastBookingContext = null;
var bcActiveDrawerTab = 'overview';
var bcLastOpenedBlock = null;
window.__fetches = [];
window.fetch = function(url){
  window.__fetches.push(String(url));
  return Promise.resolve({ ok: false, json: function(){ return Promise.resolve({ success: false, error: 'stub' }); } });
};
${fns}
var c = { guest_name: 'Gina' };
var targetEl = document.getElementById('inbox-root');
${extractClickWire(threadSrc)}
`;
}

function fixtureHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<input id="bc-client" value="wolfhouse-somo" type="hidden">
<div id="tab-bed-calendar" style="display:none">
  <aside id="bc-side-drawer">
    <div id="bc-side-title"></div>
    <div id="bc-side-meta"></div>
    <div id="bc-side-body"></div>
  </aside>
</div>
<div id="inbox-root">
  <button type="button" class="inbox-open-booking-cal"
    data-booking-id="11111111-1111-4111-8111-111111111111"
    data-booking-code="WH-GINA"
    data-check-in="2026-09-23"
    data-check-out="2026-09-28"
    data-guest-name="Gina">Open booking</button>
</div>
</body></html>`;
}

function intersectsViewport(rect, vw, vh) {
  const left = Math.max(rect.left, 0);
  const top = Math.max(rect.top, 0);
  const right = Math.min(rect.right, vw);
  const bottom = Math.min(rect.bottom, vh);
  return {
    width: Math.round((right - left) * 100) / 100,
    height: Math.round((bottom - top) * 100) / 100,
  };
}

async function measureOpen(page, vw, vh) {
  const before = await page.evaluate(() => {
    const rail = document.getElementById('bc-side-drawer');
    const cs = getComputedStyle(rail);
    return { display: cs.display, parent: rail.parentNode === document.body ? 'body' : (rail.parentNode && rail.parentNode.id) };
  });
  await page.click('.inbox-open-booking-cal');
  const afterClick = await page.evaluate(() => {
    const rail = document.getElementById('bc-side-drawer');
    const cs = getComputedStyle(rail);
    return {
      display: cs.display,
      parent: rail.parentNode === document.body ? 'body' : (rail.parentNode && rail.parentNode.id),
      className: rail.className,
      fetches: window.__fetches.slice(),
    };
  });
  try {
    await page.waitForFunction((box) => {
      const rail = document.getElementById('bc-side-drawer');
      if (!rail) return false;
      const cs = getComputedStyle(rail);
      if (cs.display === 'none') return false;
      const r = rail.getBoundingClientRect();
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const right = Math.min(r.right, box.vw);
      const bottom = Math.min(r.bottom, box.vh);
      return (right - left) > 1 && (bottom - top) > 1 && r.width > 1 && r.height > 1;
    }, { vw, vh }, { timeout: 2000 });
  } catch (err) { /* measured below */ }
  const measured = await page.evaluate(() => {
    const rail = document.getElementById('bc-side-drawer');
    const cs = getComputedStyle(rail);
    const r = rail.getBoundingClientRect();
    return {
      display: cs.display,
      width: r.width,
      height: r.height,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      parent: rail.parentNode === document.body ? 'body' : (rail.parentNode && rail.parentNode.id),
      fetches: window.__fetches.slice(),
    };
  });
  return { before, afterClick, measured };
}

async function phoneDrawerGate() {
  const playwright = loadPlaywright();
  check('P0', !!playwright, 'playwright required to measure the phone drawer');
  if (!playwright) return;
  const executablePath = chromiumExecutable();
  check('P0b', !!executablePath, 'chromium executable required');
  if (!executablePath) return;

  const css = extractDrawerCascade(apiSrc);
  check('P0c', /@media \(max-width:768px\)\{\s*#bc-side-drawer\{display:none!important\}\s*\}/.test(css),
    'measured cascade includes the phone hide rule');
  const browser = await playwright.chromium.launch({ headless: true, executablePath });
  try {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    const page = await phone.newPage();
    await page.setContent(fixtureHtml());
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: pageScript() });
    const phoneResult = await measureOpen(page, 390, 844);
    const hit = intersectsViewport(phoneResult.measured, 390, 844);
    const detail = JSON.stringify({
      before: phoneResult.before.display,
      display: phoneResult.measured.display,
      rect: phoneResult.measured,
      inViewport: hit,
      fetches: phoneResult.measured.fetches,
    });
    check('P1', phoneResult.before.display === 'none', '390px closed drawer stays display:none — ' + detail);
    check('P2', phoneResult.afterClick.display !== 'none', '390px real click computed display is not none — ' + detail);
    check('P3', phoneResult.measured.display !== 'none' && hit.width > 0 && hit.height > 0
      && phoneResult.measured.width > 0 && phoneResult.measured.height > 0,
      '390px drawer has a non-zero in-viewport rect — ' + detail);
    check('P4', phoneResult.measured.parent === 'body', '390px click lifted the drawer onto the page — ' + detail);
    check('P5', (phoneResult.measured.fetches || []).some((url) => url.indexOf('/staff/bookings/WH-GINA/context') !== -1),
      '390px click called loadBlockDetail /staff/bookings/:code/context — ' + detail);
    check('P6', !(phoneResult.measured.fetches || []).some((url) => url.indexOf('/staff/schedule/bookings/detail') !== -1),
      '390px click did not use the Sunset schedule detail URL — ' + detail);
    await phone.close();

    const desktop = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    const wide = await desktop.newPage();
    await wide.setContent(fixtureHtml());
    await wide.addStyleTag({ content: css });
    await wide.addScriptTag({ content: pageScript() });
    const wideResult = await measureOpen(wide, 1280, 800);
    const wideHit = intersectsViewport(wideResult.measured, 1280, 800);
    check('P7', wideResult.measured.display !== 'none' && wideHit.width > 0 && wideHit.height > 0,
      '1280px drawer still opens — ' + JSON.stringify({ display: wideResult.measured.display, hit: wideHit }));
    await desktop.close();
  } finally {
    await browser.close();
  }
}

phoneDrawerGate().then(() => {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
});
