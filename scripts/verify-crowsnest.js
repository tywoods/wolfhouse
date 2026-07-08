'use strict';

/**
 * Static verifier for Crowsnest skeleton — no network, no DB.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const CLIENTS_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-clients.js');
const ONBOARDING_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-onboarding.js');
const AUTH_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-auth.js');
const DOC_PRODUCT = path.join(ROOT, 'docs', 'CROWSNEST.md');
const DOC_PLAN = path.join(ROOT, 'docs', 'CROWSNEST-LOCATION-PLAN.md');
const DOC_DEPLOY = path.join(ROOT, 'docs', 'CROWSNEST-DEPLOY-PLAN.md');
const DOCKERFILE_PATH = path.join(ROOT, 'Dockerfile.crowsnest');
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
ok('scripts/lib/crowsnest/crowsnest-clients.js exists', fs.existsSync(CLIENTS_PATH));
ok('scripts/lib/crowsnest/crowsnest-onboarding.js exists', fs.existsSync(ONBOARDING_PATH));
ok('scripts/lib/crowsnest/crowsnest-auth.js exists', fs.existsSync(AUTH_PATH));

const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const clientsSrc = read(CLIENTS_PATH) || '';
const onboardingSrc = read(ONBOARDING_PATH) || '';
const authSrc = read(AUTH_PATH) || '';
const uiHtml = (() => {
  try {
    const { renderCrowsnestPage } = require(PAGE_PATH);
    return typeof renderCrowsnestPage === 'function' ? renderCrowsnestPage() : '';
  } catch {
    return '';
  }
})();
const productDoc = read(DOC_PRODUCT) || '';
const planDoc = read(DOC_PLAN) || '';
const deployDoc = read(DOC_DEPLOY) || '';
const pkgRaw = read(PKG_PATH) || '';

ok('renderCrowsnestPage exported', /function renderCrowsnestPage|renderCrowsnestPage\s*\(/.test(pageSrc));
ok('getCrowsnestClients exported', /function getCrowsnestClients|getCrowsnestClients\s*\(/.test(clientsSrc));
ok('getCrowsnestOnboardingTemplates exported', /function getCrowsnestOnboardingTemplates|getCrowsnestOnboardingTemplates\s*\(/.test(onboardingSrc));
ok('getCrowsnestOnboardingChecklist exported', /function getCrowsnestOnboardingChecklist|getCrowsnestOnboardingChecklist\s*\(/.test(onboardingSrc));
ok('crowsnest-page requires crowsnest-clients', pageSrc.includes("require('./crowsnest-clients')"));
ok('crowsnest-page requires crowsnest-onboarding', pageSrc.includes("require('./crowsnest-onboarding')"));
ok('crowsnest-api requires crowsnest-page', apiSrc.includes("require('./lib/crowsnest/crowsnest-page')"));
ok('UI Clients section exists', uiHtml.includes('>Clients<') || uiHtml.includes('section">Clients'));
ok('UI Wolfhouse Somo card', uiHtml.includes('Wolfhouse Somo'));
ok('UI Sunset Somo card', uiHtml.includes('Sunset Somo'));
ok('UI Sunset Sardinero card', uiHtml.includes('Sunset Sardinero'));
ok('UI surf house template text', /surf house template/i.test(uiHtml));
ok('UI surf school template text', /surf school template/i.test(uiHtml));
ok('UI Add new client disabled/coming soon', uiHtml.includes('Add new client') && /Coming soon|disabled|aria-disabled/.test(uiHtml));
ok('UI safety copy read-only/no writes', /read-only|no client creation|no writes/i.test(uiHtml));
ok('UI environment/status rows render', uiHtml.includes('env-row') && uiHtml.includes('Environments / status'));
ok('UI Wolfhouse staff-staging link', uiHtml.includes('https://staff-staging.lunafrontdesk.com'));
ok('UI Wolfhouse production link', uiHtml.includes('https://wolfhouse.lunafrontdesk.com'));
ok('UI Sunset staging link', uiHtml.includes('https://sunset-staging.lunafrontdesk.com'));
ok('UI Luna WhatsApp placeholder', uiHtml.includes('Luna WhatsApp') && /Coming soon|coming_soon/i.test(uiHtml));
ok('UI Stripe placeholder', uiHtml.includes('Stripe'));
ok('UI Database placeholder', uiHtml.includes('Database'));
ok('UI static placeholders / no live health checks copy', /static placeholders only|no live health checks/i.test(uiHtml));
ok('UI New client onboarding section', uiHtml.includes('New client onboarding'));
ok('UI onboarding draft/no client creation copy', /draft form only|no client creation/i.test(uiHtml));
ok('UI Surf house template option', uiHtml.includes('Surf house'));
ok('UI Surf school template option', uiHtml.includes('Surf school'));
ok('UI client name field', uiHtml.includes('Client name') && uiHtml.includes('Example Surf House'));
ok('UI client slug field', uiHtml.includes('Client slug') && uiHtml.includes('example-surf-house'));
ok('UI primary location field', uiHtml.includes('Primary location') && uiHtml.includes('Somo, Spain'));
ok('UI contact email field', uiHtml.includes('Contact email') && uiHtml.includes('hello@example.com'));
ok('UI WhatsApp number field', uiHtml.includes('WhatsApp number'));
ok('UI staff portal domain field', uiHtml.includes('Staff portal domain'));
ok('UI staging domain field', uiHtml.includes('Staging domain'));
ok('UI notes field', uiHtml.includes('Notes') && /Internal setup notes/i.test(uiHtml));
ok('UI Preview setup button disabled', uiHtml.includes('Preview setup') && /disabled|aria-disabled/.test(uiHtml));
ok('UI Create client button disabled', uiHtml.includes('Create client') && /disabled|aria-disabled/.test(uiHtml));
ok('UI checklist tenant record', /Create tenant record/i.test(uiHtml));
ok('UI checklist database/schema', /database\/schema|Create database/i.test(uiHtml));
ok('UI checklist Staff API', /Staff API/i.test(uiHtml));
ok('UI checklist Luna identity', /Luna identity/i.test(uiHtml));
ok('UI checklist WhatsApp', /Configure WhatsApp/i.test(uiHtml));
ok('UI checklist Stripe', /Configure Stripe/i.test(uiHtml));
ok('UI checklist DNS/domain', /DNS\/domain/i.test(uiHtml));
ok('UI checklist smoke tests', /smoke tests/i.test(uiHtml));
ok('UI onboarding form safe action', /action="#"/.test(uiHtml) && !/<form[^>]+action=["']https?:/i.test(uiHtml));

const crowsnestLibSrc = [pageSrc, clientsSrc, onboardingSrc, read(AUTH_PATH) || ''].join('\n');
ok('no fetch/axios/http outbound in crowsnest lib', !/\bfetch\s*\(|require\(['"]axios|require\(['"]node-fetch|https?\.request\s*\(|https?\.get\s*\(/.test(crowsnestLibSrc));
ok('/healthz route present', apiSrc.includes("pathname === '/healthz'"));
ok('healthz returns service crowsnest', apiSrc.includes("service: 'crowsnest'"));
ok('writes_enabled false in healthz', apiSrc.includes('writes_enabled: false'));

ok('CROWSNEST_AUTH_USERNAME env referenced', /CROWSNEST_AUTH_USERNAME/.test(authSrc));
ok('CROWSNEST_AUTH_PASSWORD env referenced', /CROWSNEST_AUTH_PASSWORD/.test(authSrc));
ok('Basic auth parsing helper exists', /function parseBasicAuthHeader|parseBasicAuthHeader\s*\(/.test(authSrc));
ok('isCrowsnestRequestAuthorized helper exists', /function isCrowsnestRequestAuthorized|isCrowsnestRequestAuthorized\s*\(/.test(authSrc));
ok('sendCrowsnestAuthRequired helper exists', /function sendCrowsnestAuthRequired|sendCrowsnestAuthRequired\s*\(/.test(authSrc));
ok('sendCrowsnestAuthMisconfigured helper exists', /function sendCrowsnestAuthMisconfigured|sendCrowsnestAuthMisconfigured\s*\(/.test(authSrc));
ok('/healthz remains ungated (no gateCrowsnestUi in healthz handler)', (() => {
  const parts = apiSrc.split("pathname === '/healthz'");
  if (parts.length < 2) return false;
  const afterHealth = parts[1].split("pathname === '/'")[0];
  return !afterHealth.includes('gateCrowsnestUi');
})());
ok('UI routes call auth gate', apiSrc.includes('gateCrowsnestUi(req, res)'));
ok('401 auth required path exists', apiSrc.includes('sendCrowsnestAuthRequired'));
ok('WWW-Authenticate Basic realm=Crowsnest', /Basic realm="Crowsnest"/.test(authSrc));
ok('auth misconfigured 503 path exists', apiSrc.includes('sendCrowsnestAuthMisconfigured'));
ok('healthz JSON does not embed auth password', !/auth_password|CROWSNEST_AUTH_PASSWORD/.test(apiSrc.split("pathname === '/healthz'")[1] || ''));
ok('page renderer does not embed auth credentials', !/CROWSNEST_AUTH_PASSWORD|DEFAULT_PASSWORD/.test(pageSrc));
ok('product doc mentions Basic Auth', /Basic Auth|basic auth/i.test(productDoc));
ok('deploy plan mentions CROWSNEST_AUTH_USERNAME', /CROWSNEST_AUTH_USERNAME/.test(deployDoc));
ok('deploy plan mentions CROWSNEST_AUTH_PASSWORD', /CROWSNEST_AUTH_PASSWORD/.test(deployDoc));

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
ok('docs/CROWSNEST-DEPLOY-PLAN.md exists', fs.existsSync(DOC_DEPLOY));
ok('deploy plan mentions separate Container App', /separate.*Container App/i.test(deployDoc));
ok('deploy plan mentions crowsnest-internal', /crowsnest-internal/.test(deployDoc));
ok('deploy plan mentions Dockerfile.crowsnest', /Dockerfile\.crowsnest/.test(deployDoc));
ok('deploy plan mentions domain move from wh-staging-staff-api', /wh-staging-staff-api/.test(deployDoc) && /domain|detach|move/i.test(deployDoc));
ok('deploy plan staff-staging remains untouched', /staff-staging.*untouched|remains.*wh-staging-staff-api|Must not change/i.test(deployDoc));
ok('deploy plan has rollback plan', /rollback/i.test(deployDoc));
ok('deploy plan is planning only / DO NOT RUN YET', /DO NOT RUN YET|PLANNING ONLY|planning only/i.test(deployDoc));

const dockerSrc = read(DOCKERFILE_PATH) || '';
ok('Dockerfile.crowsnest exists', fs.existsSync(DOCKERFILE_PATH));
ok('Dockerfile uses node:22-alpine', /FROM node:22-alpine/i.test(dockerSrc));
ok('Dockerfile exposes 3040', /EXPOSE 3040/.test(dockerSrc));
ok('Dockerfile CMD runs crowsnest-api.js', /CMD.*scripts\/crowsnest-api\.js/.test(dockerSrc.replace(/\s+/g, ' ')));
ok('Dockerfile sets CROWSNEST_PORT=3040', /CROWSNEST_PORT=3040/.test(dockerSrc));
ok('Dockerfile does not reference staff-query-api.js', !/staff-query-api/.test(dockerSrc));
ok('Dockerfile does not reference WOLFHOUSE_DATABASE_URL', !/WOLFHOUSE_DATABASE/.test(dockerSrc));
ok('Dockerfile does not reference STRIPE', !/STRIPE/i.test(dockerSrc));
ok('Dockerfile does not reference WHATSAPP', !/WHATSAPP/i.test(dockerSrc));
ok('Dockerfile does not reference Azure CLI commands', !/\baz (containerapp|acr build)/.test(dockerSrc));
ok('deploy plan mentions Dockerfile.crowsnest', /Dockerfile\.crowsnest/.test(deployDoc));

let pkg = null;
try {
  pkg = JSON.parse(pkgRaw);
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok('package.json has crowsnest:start', pkg && pkg.scripts && typeof pkg.scripts['crowsnest:start'] === 'string');
ok('package.json has verify:crowsnest', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest'] === 'string');
ok('package.json has verify:crowsnest-auth', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-auth'] === 'string');

console.log(`\n── verify:crowsnest: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
