'use strict';

/**
 * Verifier for the Sunset Finance admin UI: behavior of the pure renderer (executed
 * in a stub sandbox) + source-level checks for the loader (stale guard, states) and
 * i18n coverage (EN + IT; ES inherits EN via the portal's existing fallback).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UI_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'sunset-admin-ui.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}

// ── Execute the pure finance render functions in a stub sandbox ──────────────
function extract(fnName) {
  const re = new RegExp(`function ${fnName}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(UI_SRC);
  if (!m) return '';
  let i = UI_SRC.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < UI_SRC.length; j += 1) {
    if (UI_SRC[j] === '{') depth += 1;
    else if (UI_SRC[j] === '}') { depth -= 1; if (depth === 0) return UI_SRC.slice(m.index, j + 1); }
  }
  return '';
}

const fns = ['financeFmtEur', 'financePeriodEmpty', 'financeMetricRow', 'financeCard', 'renderFinanceTrendHtml', 'renderFinanceSummaryHtml']
  .map(extract).join('\n');
const sandbox = {
  portalT: (k) => k,                 // echo keys so we can assert which are used
  escHtml: (s) => String(s),
  portalLang: 'en',
  Intl,
};
vm.createContext(sandbox);
vm.runInContext(fns, sandbox);

const summary = {
  periods: {
    today: { booked_cents: 4000, collected_gross_cents: 6000, outstanding_cents: 6000, bookings_count: 1 },
    week: { booked_cents: 6000, collected_gross_cents: 6000, outstanding_cents: 9000, bookings_count: 2 },
    month: { booked_cents: 6000, collected_gross_cents: 6000, outstanding_cents: 9000, bookings_count: 2 },
  },
  daily_trend: [{ date: '2026-07-15', booked_cents: 4000, collected_gross_cents: 6000, outstanding_cents: 6000, bookings_count: 1 }],
};

ok('formats cents as EUR (display only)', /40[.,]00/.test(sandbox.financeFmtEur(4000)) && /€|EUR/.test(sandbox.financeFmtEur(4000)));
ok('period emptiness by comparison (no arithmetic)', sandbox.financePeriodEmpty({ booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 }) === true && sandbox.financePeriodEmpty(summary.periods.today) === false);

const html = sandbox.renderFinanceSummaryHtml(summary);
ok('renders three period cards (today/week/month)', /admin\.finance\.today/.test(html) && /admin\.finance\.week/.test(html) && /admin\.finance\.month/.test(html));
ok('renders all four metrics', /admin\.finance\.booked/.test(html) && /admin\.finance\.collectedGross/.test(html) && /admin\.finance\.outstanding/.test(html) && /admin\.finance\.bookings/.test(html));
ok('renders values from server (40.00, 60.00)', /40[.,]00/.test(html) && /60[.,]00/.test(html));
ok('renders daily trend section', /admin\.finance\.trendTitle/.test(html) && /2026-07-15/.test(html));
ok('surfaces gross-collected limitation note', /admin\.finance\.grossNote/.test(html));

const emptyHtml = sandbox.renderFinanceSummaryHtml({ periods: { today: { booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 }, week: { booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 }, month: { booked_cents: 0, collected_gross_cents: 0, outstanding_cents: 0, bookings_count: 0 } }, daily_trend: [] });
ok('empty periods → honest empty state', /admin\.finance\.empty/.test(emptyHtml));
ok('missing summary → unavailable state', /summaryUnavailable/.test(sandbox.renderFinanceSummaryHtml(null)));

// ── Loader source: stale guard + states + no request storms ─────────────────
const loader = extract('loadAdminFinanceSummary');
ok('loader has a generation/stale guard', /seq !== financeLoadSeq/.test(loader) && /\+\+financeLoadSeq/.test(UI_SRC));
ok('loader fetches the finance endpoint with client+location', /\/staff\/admin\/finance\/summary' \+ adminClientQuery\(\)/.test(loader));
ok('loader renders loading + error(+retry) states', /admin\.finance\.loading/.test(loader) && /renderFinanceErrorHtml\(\)/.test(loader));
ok('retry wiring guards against duplicate listeners', /financeWired/.test(UI_SRC));
ok('live load is Sunset-gated + decoupled from config-load fetch accounting', /getClient\(\) === 'sunset'[\s\S]{0,120}loadAdminFinanceSummary\(\)/.test(UI_SRC));
ok('shell placeholder stays static (fetch-free) during config load', extract('renderAdminFinanceShell').includes('summaryUnavailable') && !extract('renderAdminFinanceShell').includes('loadAdminFinanceSummary('));

// renderer must not do financial arithmetic (only display formatting in financeFmtEur)
const renderer = extract('renderFinanceSummaryHtml') + extract('financeCard') + extract('financeMetricRow') + extract('renderFinanceTrendHtml');
ok('renderer does no money arithmetic', !/[+\-*/]\s*(period|p)\.|_cents\s*[+\-*/]/.test(renderer));

// ── i18n coverage (EN + IT) ─────────────────────────────────────────────────
const keys = ['today', 'week', 'month', 'booked', 'collectedGross', 'outstanding', 'bookings', 'trendTitle', 'grossNote', 'loading', 'empty', 'error', 'retry'];
const enCount = keys.filter((k) => I18N_SRC.includes(`'admin.finance.${k}': '`)).length;
ok('all finance i18n keys present (EN+IT blocks)', keys.every((k) => (I18N_SRC.match(new RegExp(`'admin\\.finance\\.${k}':`, 'g')) || []).length >= 2), `enCount=${enCount}`);
ok('IT translates Collected (gross)', /Incassato \(lordo\)/.test(I18N_SRC));

// ── mobile-safe CSS (stacks + 44px control) ─────────────────────────────────
ok('cards stack by default (1 column)', /\.pf-cards\{[^}]*grid-template-columns:1fr/.test(CSS_SRC));
ok('retry control is 44px tap target', /\.portal-admin-finance-retry\{[^}]*min-height:44px/.test(CSS_SRC));
ok('trend rows avoid overflow (min-width:0 / wrap-safe)', /\.pf-trend-row\{[^}]*minmax\(0/.test(CSS_SRC));

console.log(`\n── verify:sunset-finance-ui: ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:sunset-finance-ui — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
