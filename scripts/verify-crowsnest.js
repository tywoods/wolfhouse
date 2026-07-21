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
const LOGO_PATH = path.join(ROOT, 'public', 'crowsnest', 'logo.png');
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

function between(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return '';
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return '';
  return src.slice(start, end);
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
const loginBody = between(apiSrc, 'async function handleLogin(req, res, method) {', 'async function handleLogout(req, res, method) {');
const logoutBody = between(apiSrc, 'async function handleLogout(req, res, method) {', 'function handleAsset(req, res, method) {');
const assetBody = between(apiSrc, 'function handleAsset(req, res, method) {', 'function handleHealthz(req, res, method) {');
const healthzBody = between(apiSrc, 'function handleHealthz(req, res, method) {', 'function handleProtectedUi(req, res, method, pathname) {');
const protectedUiBody = between(apiSrc, 'function handleProtectedUi(req, res, method, pathname) {', 'async function router(req, res) {');
const routerBody = between(apiSrc, 'async function router(req, res) {', 'const server = http.createServer');

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
ok('healthz rejects non-GET/HEAD', healthzBody.includes("method !== 'GET' && method !== 'HEAD'") && healthzBody.includes("sendMethodNotAllowed(res, 'GET, HEAD')"));
ok('protected UI rejects non-GET/HEAD', protectedUiBody.includes("method !== 'GET' && method !== 'HEAD'") && protectedUiBody.includes("sendMethodNotAllowed(res, 'GET, HEAD')"));
ok('asset rejects non-GET/HEAD', assetBody.includes("method !== 'GET' && method !== 'HEAD'") && assetBody.includes("sendMethodNotAllowed(res, 'GET, HEAD')"));
ok('login allows GET/HEAD/POST only', loginBody.includes("method !== 'POST'") && loginBody.includes("sendMethodNotAllowed(res, 'GET, HEAD, POST')"));
ok('logout allows POST only', logoutBody.includes("method !== 'POST'") && logoutBody.includes("sendMethodNotAllowed(res, 'POST')"));
ok('router fallback stays GET/HEAD only', routerBody.includes("method !== 'GET' && method !== 'HEAD'") && routerBody.includes("sendMethodNotAllowed(res, 'GET, HEAD')"));
ok('only /login advertises POST in Allow header', (apiSrc.match(/sendMethodNotAllowed\(res, 'GET, HEAD, POST'\)/g) || []).length === 1);

ok('CROWSNEST_AUTH_USERNAME env referenced', /CROWSNEST_AUTH_USERNAME/.test(authSrc));
ok('CROWSNEST_AUTH_PASSWORD env referenced', /CROWSNEST_AUTH_PASSWORD/.test(authSrc));
ok('Basic auth parsing helper exists', /function parseBasicAuthHeader|parseBasicAuthHeader\s*\(/.test(authSrc));
ok('isCrowsnestRequestAuthorized helper exists', /function isCrowsnestRequestAuthorized|isCrowsnestRequestAuthorized\s*\(/.test(authSrc));
ok('login session helper exists', /createCrowsnestSession|buildCrowsnestSessionCookie|isCrowsnestSessionAuthorized/.test(authSrc));
ok('sendCrowsnestAuthRequired helper exists', /function sendCrowsnestAuthRequired|sendCrowsnestAuthRequired\s*\(/.test(authSrc));
ok('sendCrowsnestAuthMisconfigured helper exists', /function sendCrowsnestAuthMisconfigured|sendCrowsnestAuthMisconfigured\s*\(/.test(authSrc));
ok('/healthz route remains public', apiSrc.includes("pathname === '/healthz'") && apiSrc.includes("service: 'crowsnest'") && apiSrc.includes('writes_enabled: false'));
ok('UI routes call browser auth guard', apiSrc.includes('isBrowserUiAuthorized(req)'));
ok('login route exists', apiSrc.includes("pathname === '/login'"));
ok('logout route exists', apiSrc.includes("pathname === '/logout'"));
ok('asset route exists', apiSrc.includes("pathname === ASSET_ROUTE") || apiSrc.includes("/crowsnest/assets/logo.png"));
ok('login page renderer exists', /renderCrowsnestLoginPage/.test(pageSrc));
ok('logo asset copied into repo', fs.existsSync(LOGO_PATH));
ok('auth misconfigured 503 path exists', apiSrc.includes('sendCrowsnestAuthMisconfigured'));
ok('healthz JSON does not embed auth password', !/auth_password|CROWSNEST_AUTH_PASSWORD/.test(apiSrc.split("pathname === '/healthz'")[1] || ''));
ok('page renderer does not embed auth credentials', !/CROWSNEST_AUTH_PASSWORD|DEFAULT_PASSWORD/.test(pageSrc));
ok('product doc mentions login portal', /login portal|sign in|private portal/i.test(productDoc));
ok('product doc mentions legacy Basic Auth compatibility', /Basic Auth|basic auth|legacy Basic/i.test(productDoc));
ok('product doc labels verified current live baseline', /VERIFIED CURRENT LIVE BASELINE/i.test(productDoc));
ok('product doc keeps live health stage as portal', /stage:\s*portal/i.test(productDoc));
ok('product doc records login portal as live', /Login portal \(live\)|Browser access \(live\)/i.test(productDoc) && /redirect.*\/login/i.test(productDoc));
ok('product doc keeps pre-portal shell as history only', /History \(pre-login-portal/i.test(productDoc) && /stage:\s*skeleton/i.test(productDoc));
ok('deploy plan mentions CROWSNEST_AUTH_USERNAME', /CROWSNEST_AUTH_USERNAME/.test(deployDoc));
ok('deploy plan mentions CROWSNEST_AUTH_PASSWORD', /CROWSNEST_AUTH_PASSWORD/.test(deployDoc));
ok('deploy plan records Azure auth secret refs', /cn-auth-user/.test(deployDoc) && /cn-auth-pass/.test(deployDoc));

const writeRouteRe = /\.(post|put|patch|delete)\(|\/(create|update|delete|save|write|submit)\b/i;
ok('no business/data write routes in crowsnest-api', !writeRouteRe.test(apiSrc));
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
ok('location doc records live standalone Azure deployment', /live|deployed/i.test(planDoc) && /crowsnest-internal/.test(planDoc));
ok('location doc labels verified current live baseline', /VERIFIED CURRENT LIVE BASELINE/i.test(planDoc));
ok('location doc keeps verified live stage portal', /stage:\s*portal/i.test(planDoc) && /Verified live/i.test(planDoc));
ok('location doc records login portal as live safety', /Live safety\s*\|\s*Branded login portal enabled/i.test(planDoc) && /\/login/.test(planDoc));
ok('location doc keeps pre-portal shell as history only', /History \(pre-login-portal/i.test(planDoc) && /stage:\s*skeleton/i.test(planDoc));
ok('docs/CROWSNEST-DEPLOY-PLAN.md exists', fs.existsSync(DOC_DEPLOY));
ok('deploy plan mentions separate Container App', /separate.*Container App/i.test(deployDoc));
ok('deploy plan mentions crowsnest-internal', /crowsnest-internal/.test(deployDoc));
ok('deploy plan mentions Dockerfile.crowsnest', /Dockerfile\.crowsnest/.test(deployDoc));
ok('deploy runbook records completed domain separation from wh-staging-staff-api', /wh-staging-staff-api/.test(deployDoc) && /separate|detached|migrat/i.test(deployDoc));
ok('deploy plan staff-staging remains untouched', /staff-staging.*untouched|remains.*wh-staging-staff-api|Must not change/i.test(deployDoc));
ok('deploy plan has rollback plan', /rollback/i.test(deployDoc));
ok('deploy runbook identifies the live baseline', /VERIFIED CURRENT LIVE BASELINE|live baseline|currently deployed|status:\s*live/i.test(deployDoc));
ok('deploy plan verified live auth redirects to /login', /Verified on[\s\S]*redirected[\s\S]*\/login/i.test(deployDoc) && /stage:\s*portal/i.test(deployDoc) && /legacy Basic/i.test(deployDoc));
ok('deploy plan keeps pre-portal Basic Auth challenge as history', /History \(pre-login-portal/i.test(deployDoc) && /Basic Auth challenge/i.test(deployDoc) && /stage:\s*skeleton/i.test(deployDoc));
ok('deploy plan records live revision and image SHA', /crowsnest-internal--0000007/.test(deployDoc) && /d8b52b452aa0535d242ac5fcf31077f62068ce4e/.test(deployDoc));
ok('deploy plan records Staff API unchanged at verified revision', /wh-staging-staff-api--0000520/.test(deployDoc) && /458ed255e8a06b7b0557718031e57f4d7064fa62/.test(deployDoc));
ok('deploy plan keeps credential distribution out of scope', /credential distribution is out of scope/i.test(deployDoc));
ok('deploy plan does not assert credentials delivered to humans', !/humans (?:have )?(?:received|been issued) (?:live )?credentials|credentials were (?:sent|issued|delivered) to/i.test(deployDoc));

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
ok('Dockerfile copies public/crowsnest', /COPY public\/crowsnest/.test(dockerSrc));
ok('Dockerfile includes bundled logo', fs.existsSync(LOGO_PATH));

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
