'use strict';

/**
 * verify:inbox-catalog-get-only
 *
 * Live QA: opening sunset Inbox must not POST /staff/schedule/bookings/catalog.
 * Empty-dates catalog warmup is GET; dated Create/Edit eligibility may POST.
 * Startup must not double-call loadPortalHome (was racing two catalog POSTs).
 *
 * Run:
 *   node scripts/verify-inbox-catalog-get-only.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PORTAL_MODULE = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-portal-module.js');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
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

console.log('\nverify:inbox-catalog-get-only\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const modSrc = fs.readFileSync(PORTAL_MODULE, 'utf8');
const fetchCatalogSrc = extractFunctionSource(modSrc, 'schedulePortalFetchCatalog') || '';
const lessonCfgSrc = extractFunctionSource(apiSrc, 'scheduleFetchLessonTimesConfig') || '';
const startupSrc = extractFunctionSource(apiSrc, 'portalStartupAfterSession') || '';
const invalidateSrc = extractFunctionSource(apiSrc, 'scheduleInvalidateAdminCatalogCache') || '';

console.log('[1] Static: empty-dates catalog is GET-only');
assert('schedulePortalFetchCatalog present', fetchCatalogSrc.length > 0);
assert(
  'empty-dates path uses GET (no method POST when !hasDates)',
  /var hasDates = !!\(opts\.service_dates && opts\.service_dates\.length\)/.test(fetchCatalogSrc)
    && /if \(!hasDates\)/.test(fetchCatalogSrc)
    && /return schedulePortalFetchJson\(url\)/.test(fetchCatalogSrc),
);
assert(
  'dated catalog still POSTs with service_dates',
  /method:\s*'POST'/.test(fetchCatalogSrc)
    && /service_dates:\s*opts\.service_dates/.test(fetchCatalogSrc),
);
assert(
  'scheduleFetchLessonTimesConfig warms catalog via GET',
  /schedulePortalFetchCatalog\(\{\s*method:\s*'GET',\s*service_dates:\s*\[\]\s*\}\)/.test(lessonCfgSrc),
);
assert(
  'scheduleFetchLessonTimesConfig no longer POSTs empty catalog',
  !/schedulePortalFetchCatalog\(\{\s*method:\s*'POST',\s*service_dates:\s*\[\]\s*\}\)/.test(lessonCfgSrc),
);
assert(
  'in-flight coalesce present',
  apiSrc.includes('scheduleLessonTimesInflight')
    && /if \(!force && scheduleLessonTimesInflight\) return scheduleLessonTimesInflight/.test(lessonCfgSrc),
);
assert(
  'invalidate clears in-flight',
  /scheduleLessonTimesInflight\s*=\s*null/.test(invalidateSrc),
);

console.log('\n[2] Static: startup does not double-load Horario / prefers Inbox deep-link');
assert('portalStartupAfterSession present', startupSrc.length > 0);
assert(
  'startup does not call loadPortalHome again after switchToTab',
  !/loadPortalHome\s*\(/.test(startupSrc),
);
assert(
  'conversation deep-link lands on Inbox tab',
  /get\('conversation'\)/.test(startupSrc)
    && /tab = 'conversations'/.test(startupSrc),
);
assert(
  'switchToTab still loads Horario once',
  /if \(tab === 'portal-home'\) \{ wirePortalHomeScheduleControls\(\); loadPortalHome\(\); \}/.test(apiSrc),
);

console.log('\n[3] Runtime: schedulePortalFetchCatalog method selection');
(function runtimeCatalogMethods() {
  const calls = [];
  const ctx = {
    getClient: () => 'sunset',
    getSunsetLocation: () => 'sunset-somo',
    sunsetLocationQuerySuffix: () => '&location=sunset-somo',
    schedulePortalClientQuery: () => 'client=sunset&location=sunset-somo',
    schedulePortalFetchJson(url, opts) {
      calls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return Promise.resolve({
        ok: true,
        status: 200,
        data: { ok: true, success: true, courses: [], offerings: [] },
      });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fetchCatalogSrc + '\nthis.schedulePortalFetchCatalog = schedulePortalFetchCatalog;', ctx);

  return Promise.resolve()
    .then(() => ctx.schedulePortalFetchCatalog({ method: 'POST', service_dates: [] }))
    .then(() => ctx.schedulePortalFetchCatalog({ method: 'GET', service_dates: [] }))
    .then(() => ctx.schedulePortalFetchCatalog({}))
    .then(() => ctx.schedulePortalFetchCatalog({ service_dates: ['2026-08-28'], method: 'POST' }))
    .then(() => {
      const empty = calls.filter((c) => !c.body);
      const dated = calls.filter((c) => c.method === 'POST');
      assert('empty-dates callers all used GET (3)', empty.length === 3 && empty.every((c) => c.method === 'GET'));
      assert('dated eligibility still POSTs once', dated.length === 1 && /service_dates/.test(String(dated[0].body || '')));
      assert(
        'POST body includes require_db',
        dated[0] && /require_db/.test(String(dated[0].body || '')),
      );
    });
})()
  .then(() => {
    console.log(`\n── verify:inbox-catalog-get-only ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
    process.exit(fail ? 1 : 0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
