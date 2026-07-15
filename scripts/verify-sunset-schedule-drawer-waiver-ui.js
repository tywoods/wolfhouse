'use strict';

/**
 * verify:sunset-schedule-drawer-waiver-ui
 *
 * Slice 15 — Schedule drawer waiver controller gate.
 *
 * Run:
 *   node scripts/verify-sunset-schedule-drawer-waiver-ui.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  injectSunsetSchedulePortalModule,
  SCHEDULE_WAIVER_INJECT_MARKER,
} = require('./lib/sunset-schedule-browser-source');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const WAIVER_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-waiver-ui.js');
const VIEW_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const EDIT_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const PAY_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');
const BROWSER_SRC = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-browser-source.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

function extractFunctionSource(src, name) {
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function portalT(key) {
  const map = {
    'schedule.drawer.waiverNone': 'No waiver yet',
    'schedule.drawer.waiverCreate': 'Create link',
    'schedule.drawer.waiverCreateGroup': 'Create group link',
    'schedule.drawer.waiverStatus': 'Status',
    'schedule.drawer.waiverPending': 'Pending',
    'schedule.drawer.waiverCompleted': 'Completed',
    'schedule.drawer.waiverNeedsReview': 'Needs review',
    'schedule.drawer.waiverExpired': 'Expired',
    'schedule.drawer.waiverRevoked': 'Revoked',
    'schedule.drawer.waiverCompletedAt': 'Completed at',
    'schedule.drawer.waiverViewAnswers': 'View answers',
    'schedule.drawer.waiverAnswers': 'Answers',
    'schedule.drawer.waiverStudentLabel': 'Student',
    'schedule.drawer.waiverGroupLabel': 'Group',
    'schedule.drawer.waiverStudents': 'students',
    'schedule.drawer.waiverCompletedProgress': 'Progress',
    'schedule.drawer.waiverMigrationPending': 'Migration pending',
    'schedule.drawer.waiverCreated': 'Created',
    'schedule.drawer.waiverCreateFailed': 'Create failed',
    'schedule.drawer.waiverLoadFailed': 'Load failed',
  };
  return map[key] || key;
}

console.log('\nverify:sunset-schedule-drawer-waiver-ui\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const waiverExists = fs.existsSync(WAIVER_MODULE);
const waiverModSrc = waiverExists ? fs.readFileSync(WAIVER_MODULE, 'utf8') : '';
const viewModSrc = fs.readFileSync(VIEW_MODULE, 'utf8');
const editModSrc = fs.readFileSync(EDIT_MODULE, 'utf8');
const payModSrc = fs.readFileSync(PAY_MODULE, 'utf8');
const browserLoader = fs.readFileSync(BROWSER_SRC, 'utf8');

console.log('[1] Module files and injection order');
assert('waiver module exists', waiverExists);
assert('waiver inject marker in portal script', apiSrc.includes('/* INJECT:sunset-schedule-drawer-waiver-ui */'));
assert('browser source loads waiver module', browserLoader.includes('getSunsetScheduleDrawerWaiverBrowserSource'));
assert('inject chains portal → view → edit → payment → waiver → delete → controller', browserLoader.includes('SCHEDULE_DELETE_INJECT_MARKER'));

const markers = [
  '/* INJECT:sunset-schedule-portal-module */',
  '/* INJECT:sunset-schedule-drawer-view-ui */',
  '/* INJECT:sunset-schedule-drawer-edit-ui */',
  '/* INJECT:sunset-schedule-drawer-payment-ui */',
  '/* INJECT:sunset-schedule-drawer-waiver-ui */',
  '/* INJECT:sunset-schedule-drawer-delete-ui */',
  '/* INJECT:sunset-schedule-drawer-controller */',
];
const idx = markers.map((m) => apiSrc.indexOf(m));
assert('all seven markers present once', idx.every((i) => i >= 0) && markers.every((m) => apiSrc.split(m).length === 2));
assert('marker dependency order', idx[0] < idx[1] && idx[1] < idx[2] && idx[2] < idx[3] && idx[3] < idx[4] && idx[4] < idx[5] && idx[5] < idx[6]);
assert('inline scheduleLoadDrawerWaiver removed', !apiSrc.includes('function scheduleLoadDrawerWaiver('));
assert('inline scheduleCreateDrawerWaiver removed', !apiSrc.includes('function scheduleCreateDrawerWaiver('));
assert('inline scheduleRenderWaiverBoxInner removed', !apiSrc.includes('function scheduleRenderWaiverBoxInner('));
assert('inline scheduleWaiverIsGroup removed', !apiSrc.includes('function scheduleWaiverIsGroup('));
assert('view module still owns waiver section shell', viewModSrc.includes('function scheduleRenderDrawerWaiverSectionHtml('));
assert('edit module still calls scheduleLoadDrawerWaiver hook', editModSrc.includes('scheduleLoadDrawerWaiver(ctx)'));
assert('payment module unchanged slice 14 entrypoints', payModSrc.includes('function scheduleCreateDrawerStripeLink('));

const htmlSample = injectSunsetSchedulePortalModule('<script>(function(){function el(id){return null;}/* INJECT:sunset-schedule-portal-module *//* INJECT:sunset-schedule-drawer-view-ui *//* INJECT:sunset-schedule-drawer-edit-ui *//* INJECT:sunset-schedule-drawer-payment-ui *//* INJECT:sunset-schedule-drawer-waiver-ui *//* INJECT:sunset-schedule-drawer-delete-ui *//* INJECT:sunset-schedule-drawer-controller *//* INJECT:sunset-schedule-day-ops-board-ui *//* INJECT:sunset-schedule-forecast-cards-ui *//* INJECT:sunset-schedule-view-grid-ui */function escHtml(s){return s;}})();</script>');
assert('buildUiHtml inject includes waiver module', htmlSample.includes('function scheduleLoadDrawerWaiver('));
assert('waiver module injected once', htmlSample.split('function scheduleLoadDrawerWaiver(').length === 2);

console.log('\n[2] Waiver safety, guards and server authority');
if (waiverExists) {
  assert('create in-flight guard', /scheduleDrawerWaiverCreateInFlight/.test(waiverModSrc));
  assert('does not infer signed from URL alone', !/public_url[\s\S]{0,80}completed/.test(waiverModSrc.replace(/w\.status === 'completed'/g, '')));
  assert('signed answers use submission status not browser flag', waiverModSrc.includes("w.status === 'completed'"));
  assert('mutation POST body empty object only', (() => {
    const fn = extractFunctionSource(waiverModSrc, 'scheduleCreateDrawerWaiver') || '';
    return /body:\s*JSON\.stringify\(\{\}\)/.test(fn);
  })());
  assert('booking id from scheduleDrawerState ctx only', (() => {
    const fn = extractFunctionSource(waiverModSrc, 'scheduleCreateDrawerWaiver') || '';
    return fn.includes('scheduleDrawerState') && fn.includes('ctx.booking_id') && !/JSON\.stringify\(\{[^}]*booking_id/.test(fn);
  })());
  assert('successful create refetches waiver GET', (() => {
    const fn = extractFunctionSource(waiverModSrc, 'scheduleCreateDrawerWaiver') || '';
    return fn.includes('scheduleLoadDrawerWaiver');
  })());
  assert('copy uses server public_url only', waiverModSrc.includes('data.waiver.public_url'));
  assert('group copy uses waiverCopyGroup key', waiverModSrc.includes('schedule.drawer.waiverCopyGroup'));
  assert('single copy uses waiverCopy key', waiverModSrc.includes('schedule.drawer.waiverCopy'));
  assert('no WhatsApp in waiver module', !/whatsapp/i.test(waiverModSrc));
  assert('no duplicated legal waiver form copy', !/Google Form|Formulario de inscripción/i.test(waiverModSrc));
  assert('answers rendered with escHtml on labels and values', (() => {
    const fn = extractFunctionSource(waiverModSrc, 'scheduleRenderWaiverSubmissionBlock') || '';
    return fn.includes('escHtml(a.label') && fn.includes('escHtml(String');
  })());
}

console.log('\n[3] Required waiver controller functions');
[
  'scheduleWaiverStatusLabel',
  'scheduleWaiverIsGroup',
  'scheduleWaiverTargetCount',
  'scheduleWaiverCompletedCount',
  'scheduleRenderWaiverBoxInner',
  'scheduleWireDrawerWaiver',
  'scheduleViewDrawerWaiverAnswers',
  'scheduleRenderWaiverSubmissionBlock',
  'scheduleRenderWaiverAnswers',
  'scheduleLoadDrawerWaiver',
  'scheduleCreateDrawerWaiver',
].forEach((name) => {
  assert(`module defines ${name}`, waiverExists && extractFunctionSource(waiverModSrc, name) != null);
});

console.log('\n[4] VM — states, XSS, duplicate create, parity');
if (waiverExists) {
  const dom = {};
  const fetchLog = [];
  let createInFlight = false;
  const ctx = {
    console,
    scheduleDrawerState: { ctx: { booking_id: 'b-waiver-1' } },
    scheduleDrawerWaiverCreateInFlight: false,
    el: (id) => dom[id] || null,
    getClient: () => 'sunset',
    sunsetLocationQuerySuffix: () => '',
    scheduleCopyTextFallback: () => {},
    scheduleDrawerFlashCopied: () => {},
    scheduleDateOnlyLabel: (v) => String(v || '').slice(0, 10),
    scheduleDrawerCopyIconBtnHtml: (id) => `<button id="${id}"></button>`,
    fetch: (url, opts) => {
      fetchLog.push({ url, opts });
      if (opts && opts.method === 'POST' && url.includes('/waiver')) {
        if (createInFlight) return Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false }) });
        createInFlight = true;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      if (url.includes('/waiver/submission')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            submission: {
              raw_answers_json: {
                answers: {
                  q1: { label: 'Name', value: 'Ana' },
                  q2: { label: 'Optional', value: null },
                },
              },
            },
          }),
        });
      }
      if (url.includes('/waiver')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            waiver: { status: 'pending', public_url: 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_test' },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    },
  };

  dom['ps-drawer-waiver-box'] = { innerHTML: '', style: {} };
  dom['ps-drawer-waiver-create'] = { disabled: false, onclick: null };
  dom['ps-drawer-waiver-msg'] = { style: {}, className: '', textContent: '' };

  vm.createContext(ctx);
  vm.runInContext(`function escHtml(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}`, ctx);
  vm.runInContext(`function portalT(k){return (${portalT.toString()})(k);}`, ctx);
  vm.runInContext('var scheduleDrawerWaiverCreateInFlight=false;', ctx);

  [
    'scheduleWaiverStatusLabel',
    'scheduleWaiverIsGroup',
    'scheduleWaiverTargetCount',
    'scheduleWaiverCompletedCount',
    'scheduleRenderWaiverBoxInner',
    'scheduleWireDrawerWaiver',
    'scheduleViewDrawerWaiverAnswers',
    'scheduleRenderWaiverSubmissionBlock',
    'scheduleRenderWaiverAnswers',
    'scheduleLoadDrawerWaiver',
    'scheduleCreateDrawerWaiver',
  ].forEach((name) => {
    const fnSrc = extractFunctionSource(waiverModSrc, name);
    if (fnSrc) vm.runInContext(`${fnSrc}\nthis.${name}=${name};`, ctx);
  });

  const missingHtml = ctx.scheduleRenderWaiverBoxInner({ guest_count: 1, waiver: null });
  assert('missing waiver renders empty state', missingHtml.includes('No waiver yet'));
  assert('missing waiver shows create action', missingHtml.includes('ps-drawer-waiver-create'));

  const pendingHtml = ctx.scheduleRenderWaiverBoxInner({
    guest_count: 1,
    waiver: { status: 'pending', public_url: 'https://x.com/waiv_1' },
  });
  assert('unsigned pending renders status', pendingHtml.includes('Pending'));
  assert('unsigned pending renders actionable URL', pendingHtml.includes('ps-drawer-waiver-url'));

  const signedHtml = ctx.scheduleRenderWaiverBoxInner({
    guest_count: 1,
    waiver: {
      status: 'completed',
      completed_at: '2026-07-01',
      public_url: 'https://x.com/waiv_done',
      submission: {
        raw_answers_json: {
          answers: { legal_q: { label: 'I accept <terms>', value: 'Sí' } },
        },
      },
    },
  });
  assert('signed waiver renders completed status', signedHtml.includes('Completed'));
  assert('signed waiver shows view answers button', signedHtml.includes('ps-drawer-waiver-view'));
  assert('signed waiver does not show create button', !signedHtml.includes('id="ps-drawer-waiver-create"'));

  const expiredHtml = ctx.scheduleRenderWaiverBoxInner({
    guest_count: 1,
    waiver: { status: 'expired', public_url: null },
  });
  assert('expired without URL is non-actionable', !expiredHtml.includes('ps-drawer-waiver-url'));
  assert('expired without URL no create retry', !expiredHtml.includes('ps-drawer-waiver-create'));

  const xssData = {
    guest_count: 20,
    expected_request_mode: 'group',
    waiver: {
      status: 'pending',
      public_url: 'https://x.com/<script>',
    },
    multi_student_note: '<img onerror=alert(1)>',
  };
  const xssHtml = ctx.scheduleRenderWaiverBoxInner(xssData);
  assert('waiver URL escaped in href', xssHtml.includes('&lt;script&gt;') || !xssHtml.includes('<script>'));
  assert('group note escaped', xssHtml.includes('&lt;img'));

  const answersHtml = ctx.scheduleRenderWaiverSubmissionBlock({
    raw_answers_json: {
      answers: {
        q1: { label: '<b>Name</b>', value: '<script>' },
        q2: { label: 'Optional', value: null },
      },
    },
  });
  assert('answer labels escaped', answersHtml.includes('&lt;b&gt;'));
  assert('answer values escaped', answersHtml.includes('&lt;script&gt;'));
  assert('missing optional answer safe', answersHtml.includes('—'));

  const staffShell = ctx.scheduleRenderWaiverBoxInner({ guest_count: 1, waiver: null });
  const lunaShell = ctx.scheduleRenderWaiverBoxInner({ guest_count: 1, waiver: null, source: 'luna' });
  assert('staff and Luna bookings share waiver renderer', staffShell === lunaShell);

  ctx.scheduleCreateDrawerWaiver();
  ctx.scheduleCreateDrawerWaiver();
  setImmediate(function () {
    setImmediate(function () {
      const postCalls = fetchLog.filter((f) => f.opts && f.opts.method === 'POST' && f.url.includes('/waiver'));
      assert('duplicate create issues at most one POST', postCalls.length <= 1);

      const getAfterCreate = fetchLog.filter((f) => (!f.opts || f.opts.method !== 'POST') && f.url.includes('/waiver') && !f.url.includes('submission'));
      assert('successful create triggers waiver GET refetch', getAfterCreate.length >= 1);

      console.log(`\n── verify:sunset-schedule-drawer-waiver-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
      process.exit(fail ? 1 : 0);
    });
  });
} else {
  console.log(`\n── verify:sunset-schedule-drawer-waiver-ui ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}
