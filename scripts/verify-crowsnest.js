'use strict';

/**
 * Static verifier for Crowsnest skeleton — no network, no DB.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const AUTH_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-auth.js');
const DOC_PRODUCT = path.join(ROOT, 'docs', 'CROWSNEST.md');
const DOC_PLAN = path.join(ROOT, 'docs', 'CROWSNEST-LOCATION-PLAN.md');
const PKG_PATH = path.join(ROOT, 'package.json');

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name);
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

console.log('verify:crowsnest — Crowsnest skeleton gate\n');

ok('scripts/crowsnest-api.js exists', fs.existsSync(API_PATH));
ok('scripts/lib/crowsnest/crowsnest-page.js exists', fs.existsSync(PAGE_PATH));
ok('scripts/lib/crowsnest/crowsnest-auth.js exists', fs.existsSync(AUTH_PATH));

const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const productDoc = read(DOC_PRODUCT) || '';
const planDoc = read(DOC_PLAN) || '';
const pkgRaw = read(PKG_PATH) || '';

ok('renderCrowsnestPage exported', /function renderCrowsnestPage|renderCrowsnestPage\s*\(/.test(pageSrc));
ok('crowsnest-api requires crowsnest-page', apiSrc.includes("require('./lib/crowsnest/crowsnest-page')"));
ok('/healthz route present', apiSrc.includes("pathname === '/healthz'"));
ok('healthz returns service crowsnest', apiSrc.includes("service: 'crowsnest'"));
ok('writes_enabled false in healthz', apiSrc.includes('writes_enabled: false'));

const writeRouteRe = /\.(post|put|patch|delete)\(|method\s*===\s*['"]POST|method\s*===\s*['"]PUT|method\s*===\s*['"]DELETE|method\s*===\s*['"]PATCH/i;
ok('no POST/PUT/DELETE write routes in crowsnest-api', !writeRouteRe.test(apiSrc));
ok('no database / pg imports in crowsnest-api', !/require\(['"].*pg|postgres|WOLFHOUSE_DATABASE/i.test(apiSrc));
ok('no staff-query-api import', !/require\(['"].*staff-query-api/.test(apiSrc));

ok('docs/CROWSNEST.md exists', fs.existsSync(DOC_PRODUCT));
ok('docs/CROWSNEST-LOCATION-PLAN.md exists', fs.existsSync(DOC_PLAN));
ok('product doc mentions internal/dev/operator', /internal|dev|operator/i.test(productDoc));
ok('product doc mentions Monshies', /Monshies/i.test(productDoc));
ok('product doc mentions Earthling', /Earthling/i.test(productDoc));
ok('product doc mentions surf house template', /surf house/i.test(productDoc));
ok('product doc mentions surf school template', /surf school/i.test(productDoc));
ok('product doc mentions skeleton / no live writes', /skeleton|no live writes|no writes/i.test(productDoc));
ok('plan doc mentions crowsnest.lunafrontdesk.com', /crowsnest\.lunafrontdesk\.com/i.test(planDoc));
ok('plan doc mentions no deploy / no Azure changes yet', /no deploy|no Azure|not.*deploy/i.test(planDoc));

let pkg = null;
try {
  pkg = JSON.parse(pkgRaw);
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok('package.json has crowsnest:start', pkg && pkg.scripts && typeof pkg.scripts['crowsnest:start'] === 'string');
ok('package.json has verify:crowsnest', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest'] === 'string');

console.log(`\n── verify:crowsnest: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
