'use strict';

/**
 * Admin open must load Finance once (no stacked loading flash).
 * Subtab buttons stay put: scrolling tab panels reserve scrollbar-gutter.
 *
 * Execution: resolve /staff/admin/config + rental-offerings, then assert
 * exactly one /staff/admin/finance/summary request.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts/staff-query-api.js');
const ADMIN_UI = path.join(ROOT, 'scripts/browser/sunset-admin-ui.js');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', label); }
  else { fail += 1; console.log('  FAIL ', label, detail || ''); }
}

function extractFn(src, name) {
  const re = new RegExp('function ' + name + '\\([\\s\\S]*?\\n(?=function |$)');
  const m = src.match(re);
  return m ? m[0] : '';
}

function panelStub() {
  return { removeAttribute() {}, setAttribute() {}, classList: { toggle() {} } };
}

function flushMicrotasks(n) {
  let p = Promise.resolve();
  for (let i = 0; i < (n || 16); i += 1) p = p.then(() => undefined);
  return p;
}

async function runExecutionOnce(kind) {
  const adminUi = fs.readFileSync(ADMIN_UI, 'utf8');
  const selectSrc = extractFn(adminUi, 'adminSelectSubTab');
  const loadSrc = extractFn(adminUi, 'loadAdminTab');
  if (!selectSrc || !loadSrc) {
    return { extractOk: false, financeUrls: [], fetches: [], error: 'extract' };
  }

  const fetches = [];
  const els = {
    'admin-finance-body': { innerHTML: '', querySelector() { return null; } },
    'admin-panel-finance': panelStub(),
    'admin-panel-pricing': panelStub(),
    'admin-panel-luna-staff': panelStub(),
    'admin-panel-email': panelStub(),
    'tab-ask-luna': panelStub(),
    'admin-fetch-state': { textContent: '', style: { display: '' }, classList: { remove() {} }, className: '' },
  };

  const ctx = {
    adminActiveSubTab: 'finance',
    financeLoadSeq: 0,
    adminLoadSeq: 0,
    adminSaveBusy: false,
    adminConfigCache: null,
    adminEditTarget: null,
    fetches,
    document: {
      querySelectorAll() { return []; },
      body: { dataset: {} },
    },
    el(id) { return els[id] || null; },
    portalT(k) { return k; },
    escHtml(s) { return String(s); },
    getClient() { return 'sunset'; },
    getSunsetLocation() { return 'sunset-somo'; },
    getPortalProfile() { return { is_surf_vertical: true }; },
    adminClientQuery() { return '?client=sunset'; },
    cancelAdminEmailReauthorization() {},
    adminSyncEmailTabVisibility() {},
    wireAdminTab() {},
    wireAdminSubTabs() {},
    adminClearEquipErrors() {},
    adminClearPricingDraftState() {},
    renderAdminFinanceShell() { ctx.shellPainted = true; },
    renderAdminLoadingShell() {},
    renderAdminFromConfig() { ctx.renderedConfig = true; },
    renderAdminFallback() { ctx.renderedFallback = true; },
    adminCfgWritesEnabled() { return true; },
    adminBeginOp() { ctx.adminSaveBusy = true; return ++ctx.adminLoadSeq; },
    adminReleaseBusy() { ctx.adminSaveBusy = false; },
    loadAdminFinanceSummary() {
      return ctx.fetch('/staff/admin/finance/summary?client=sunset');
    },
    loadAdminFinanceForCurrentScope() {
      ctx.financeLoadSeq += 1;
      if (ctx.getClient() === 'sunset' || ctx.getClient() === 'wolfhouse-somo') {
        ctx.loadAdminFinanceSummary();
      }
    },
    fetch(url) {
      const u = String(url);
      fetches.push(u);
      if (u.includes('/staff/admin/finance/summary')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, summary: { periods: {} } }),
        });
      }
      if (u.includes('rental-offerings')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ offerings: [] }),
        });
      }
      if (u.includes('/staff/admin/config')) {
        if (kind === 'error') {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ success: false, error: 'boom' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    Error,
  };
  // Bind methods so extracted `function loadAdminTab` can call bare names
  // that the vm copies onto the context.
  vm.createContext(ctx);
  vm.runInContext(selectSrc + '\n' + loadSrc, ctx);

  ctx.loadAdminTab({ resetSubTab: true });
  await flushMicrotasks(24);

  const financeUrls = fetches.filter((u) => u.includes('/staff/admin/finance/summary'));
  return {
    extractOk: true,
    financeUrls,
    fetches,
    renderedConfig: !!ctx.renderedConfig,
    renderedFallback: !!ctx.renderedFallback,
  };
}

async function main() {
  console.log('verify-sunset-admin-load-stable');
  const api = fs.readFileSync(API, 'utf8');
  const adminUi = fs.readFileSync(ADMIN_UI, 'utf8');

  const openFn = (api.match(/function openAdminTabForCurrentClient\([^)]*\)\{[\s\S]{0,500}?loadAdminTab\(opts \|\| \{\}\);\s*\}/) || [''])[0];
  ok('extracted openAdminTabForCurrentClient', /function openAdminTabForCurrentClient/.test(openFn));
  ok('Admin open is one loadAdminTab (no extra finance fetch)',
    /loadAdminTab\(opts \|\| \{\}\);/.test(openFn)
    && !/loadAdminFinanceForCurrentScope/.test(openFn));

  ok('school switch on Admin is one loadAdminTab (no extra finance fetch)',
    /if \(el\('tab-admin'\) && el\('tab-admin'\)\.classList\.contains\('active'\)\) \{ loadAdminTab\(\); \}/.test(api)
    && !/el\('tab-admin'\)[\s\S]{0,80}loadAdminTab\(\); loadAdminFinanceForCurrentScope\(\)/.test(api));

  ok('loadAdminTab skips stacked finance select-load',
    /adminSelectSubTab\(adminActiveSubTab, \{ skipFinanceLoad: true \}\)/.test(adminUi));
  ok('post-config reconcile skips finance load',
    (adminUi.match(/adminSelectSubTab\(adminActiveSubTab \|\| 'finance', \{ skipFinanceLoad: true \}\)/g) || []).length === 3
    && !/adminSelectSubTab\(adminActiveSubTab \|\| 'finance'\);/.test(adminUi));
  ok('loadAdminTab still fetches finance once when Finanzas is showing',
    /adminActiveSubTab === 'finance' && typeof loadAdminFinanceForCurrentScope === 'function'[\s\S]{0,80}loadAdminFinanceForCurrentScope\(\)/.test(adminUi));
  ok('adminSelectSubTab still loads finance when skipFinanceLoad is off',
    /next === 'finance' && !\(opts && opts.skipFinanceLoad\) && typeof loadAdminFinanceSummary === 'function'\) loadAdminFinanceSummary\(\)/.test(adminUi));

  ok('active tab panel reserves scrollbar gutter (subtabs stay put on load)',
    /body > \.tab-panel\.active\{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable\}/.test(api));

  const success = await runExecutionOnce('success');
  ok('execution extracted adminSelectSubTab + loadAdminTab', success.extractOk);
  ok('execution painted config after both config fetches resolved', success.renderedConfig);
  ok('Admin → Finance issues exactly one finance/summary request after config success',
    success.financeUrls.length === 1,
    `got ${success.financeUrls.length} from ${JSON.stringify(success.fetches)}`);

  const errRun = await runExecutionOnce('error');
  ok('Admin → Finance issues exactly one finance/summary request after config error',
    errRun.financeUrls.length === 1,
    `got ${errRun.financeUrls.length} from ${JSON.stringify(errRun.fetches)}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
