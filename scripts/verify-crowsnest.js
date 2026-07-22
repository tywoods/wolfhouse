'use strict';

/**
 * Static verifier for Crowsnest skeleton — no network, no DB.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const CLIENTS_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-clients.js');
const ONBOARDING_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-onboarding.js');
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const AUTH_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-auth.js');
const AI_USAGE_CONTRACT_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-ai-usage-contract.js');
const AI_USAGE_ADAPTER_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-ai-usage-adapter.js');
const AI_USAGE_DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-EVENT-CONTRACT.md');
const AI_USAGE_ADAPTER_DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-ADAPTER.md');
const AI_USAGE_VERIFY_PATH = path.join(ROOT, 'scripts', 'verify-crowsnest-ai-usage-contract.js');
const AI_USAGE_ADAPTER_VERIFY_PATH = path.join(ROOT, 'scripts', 'verify-crowsnest-ai-usage-adapter.js');
const DOC_PRODUCT = path.join(ROOT, 'docs', 'CROWSNEST.md');
const DOC_PLAN = path.join(ROOT, 'docs', 'CROWSNEST-LOCATION-PLAN.md');
const DOC_DEPLOY = path.join(ROOT, 'docs', 'CROWSNEST-DEPLOY-PLAN.md');
const DOCKERFILE_PATH = path.join(ROOT, 'Dockerfile.crowsnest');
const LOGO_PATH = path.join(ROOT, 'public', 'crowsnest', 'logo.png');
const PKG_PATH = path.join(ROOT, 'package.json');
const EXPECTED_LOGO_SHA256 = '7ace8b7e584e0848da3ca248d90988ab71c288f895961f03ec4aa6ee6367ad24';
const REMOVED_LOGIN_COPY = 'This private portal is for Monshies and Earthling. Use your operator credentials to continue.';

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
ok('scripts/lib/crowsnest/crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
ok('scripts/lib/crowsnest/crowsnest-ai-usage-contract.js exists', fs.existsSync(AI_USAGE_CONTRACT_PATH));
ok('scripts/lib/crowsnest/crowsnest-ai-usage-adapter.js exists', fs.existsSync(AI_USAGE_ADAPTER_PATH));
ok('docs/crowsnest/AI-USAGE-EVENT-CONTRACT.md exists', fs.existsSync(AI_USAGE_DOC_PATH));
ok('docs/crowsnest/AI-USAGE-ADAPTER.md exists', fs.existsSync(AI_USAGE_ADAPTER_DOC_PATH));
ok('scripts/verify-crowsnest-ai-usage-contract.js exists', fs.existsSync(AI_USAGE_VERIFY_PATH));
ok('scripts/verify-crowsnest-ai-usage-adapter.js exists', fs.existsSync(AI_USAGE_ADAPTER_VERIFY_PATH));

const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const clientsSrc = read(CLIENTS_PATH) || '';
const onboardingSrc = read(ONBOARDING_PATH) || '';
const authSrc = read(AUTH_PATH) || '';
function renderPageHtml(options) {
  try {
    const { renderCrowsnestPage } = require(PAGE_PATH);
    return typeof renderCrowsnestPage === 'function' ? renderCrowsnestPage(options) : '';
  } catch {
    return '';
  }
}

const uiHtml = renderPageHtml(); // default = Spyglass
const clientsHtml = renderPageHtml({ view: 'clients' });
const billingHtml = renderPageHtml({ view: 'billing' });
const communicationsHtml = renderPageHtml({ view: 'communications' });
const spyglassAliasHtml = renderPageHtml({ view: 'spyglass' });
const productDoc = read(DOC_PRODUCT) || '';
const planDoc = read(DOC_PLAN) || '';
const deployDoc = read(DOC_DEPLOY) || '';
const pkgRaw = read(PKG_PATH) || '';
const loginBody = between(apiSrc, 'async function handleLogin(req, res, method) {', 'async function handleLogout(req, res, method) {');
const logoutBody = between(apiSrc, 'async function handleLogout(req, res, method) {', 'function handleAsset(req, res, method, pathname) {');
const assetBody = between(apiSrc, 'function handleAsset(req, res, method, pathname) {', 'function handleHealthz(req, res, method) {');
const healthzBody = between(apiSrc, 'function handleHealthz(req, res, method) {', 'function handleProtectedUi(req, res, method, pathname) {');
const protectedUiBody = between(apiSrc, 'function handleProtectedUi(req, res, method, pathname) {', 'async function router(req, res) {');
const routerBody = between(apiSrc, 'async function router(req, res) {', 'const server = http.createServer');

function countAriaCurrent(html) {
  return (String(html || '').match(/aria-current=["']page["']/gi) || []).length;
}

function navHrefPresent(html, href) {
  const re = new RegExp(`<a\\b[^>]*\\bhref=["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
  return re.test(String(html || ''));
}

function hasInventedMetricNumber(html) {
  // Reject invented AI/cost/billing amounts (currency, token counts, usage totals).
  // Allowed: static client/env counts derived from in-memory client array.
  const text = String(html || '');
  if (/\$\s*\d|\d+\s*(?:USD|EUR|€)|€\s*\d/i.test(text)) return true;
  if (/\b(?:tokens?|requests?|messages?)\s*[:=]?\s*\d+/i.test(text)) return true;
  if (/\bAI\b[^<]{0,40}\b\d{2,}/i.test(text)) return true;
  if (/\b(?:cost|spend|invoice|balance)\b[^<]{0,40}\b\d+/i.test(text)) return true;
  return false;
}

ok('renderCrowsnestPage exported', /function renderCrowsnestPage|renderCrowsnestPage\s*\(/.test(pageSrc));
ok('getCrowsnestClients exported', /function getCrowsnestClients|getCrowsnestClients\s*\(/.test(clientsSrc));
ok('getCrowsnestOnboardingTemplates exported', /function getCrowsnestOnboardingTemplates|getCrowsnestOnboardingTemplates\s*\(/.test(onboardingSrc));
ok('getCrowsnestOnboardingChecklist exported', /function getCrowsnestOnboardingChecklist|getCrowsnestOnboardingChecklist\s*\(/.test(onboardingSrc));
ok('crowsnest-page requires crowsnest-clients', pageSrc.includes("require('./crowsnest-clients')"));
ok('crowsnest-page requires crowsnest-onboarding', pageSrc.includes("require('./crowsnest-onboarding')"));
ok('crowsnest-api requires crowsnest-page', apiSrc.includes("require('./lib/crowsnest/crowsnest-page')"));

// ── Slice 1: four-section nav + Spyglass default ────────────────────────────
ok('router protects /clients', routerBody.includes("pathname === '/clients'"));
ok('router protects /billing', routerBody.includes("pathname === '/billing'"));
ok('router protects /communications', routerBody.includes("pathname === '/communications'"));
ok('router keeps Spyglass aliases /crowsnest and /crowsnest/ui', routerBody.includes("pathname === '/crowsnest'") && routerBody.includes("pathname === '/crowsnest/ui'"));
ok('router keeps root / as Spyglass', routerBody.includes("pathname === '/'"));
ok('handleProtectedUi passes view/route into page renderer', /renderCrowsnestPage\s*\(\s*\{[\s\S]*view\s*:/.test(protectedUiBody) || /renderCrowsnestPage\s*\(\s*\{[\s\S]*route\s*:/.test(protectedUiBody));
ok('unknown path still returns 404 JSON', routerBody.includes("sendJSON(res, 404") && /not found/.test(routerBody));

ok('default render is Spyglass heading', /Spyglass/i.test(uiHtml) && /<h1[^>]*>[\s\S]*Spyglass/i.test(uiHtml));
// ── Iris: Spyglass is now a populated (sample-data) overview, not a counts shell ──
ok('Iris Spyglass renders expandable client rows with names', uiHtml.includes('client-row') && uiHtml.includes('Wolfhouse Somo') && uiHtml.includes('Sunset Somo') && uiHtml.includes('Sunset Sardinero'));
ok('default Spyglass does not render onboarding form', !uiHtml.includes('New client onboarding'));
ok('spyglass alias matches default with client rows', /Spyglass/i.test(spyglassAliasHtml) && spyglassAliasHtml.includes('client-row'));
ok('Iris Spyglass renders full-width AI usage panel', /ai-usage-panel/.test(uiHtml) && /AI usage/i.test(uiHtml));
ok('Iris Spyglass clearly labels sample data', /sample data/i.test(uiHtml) && uiHtml.includes('sample-badge') && uiHtml.includes('sample-banner'));
ok('Iris Spyglass states numbers are not live telemetry', /not live telemetry/i.test(uiHtml));
// Numbers ARE now allowed on Spyglass, but only alongside explicit sample labeling (guarded above).
ok('Iris Spyglass numbers appear only with sample labeling', !hasInventedMetricNumber(uiHtml) || /sample/i.test(uiHtml));
ok('Spyglass includes read-only / no-live-writes language', /read-only|no live writes|no writes/i.test(uiHtml));
ok('Spyglass shows static client count from in-memory data', /\b3\b/.test(uiHtml) && /client/i.test(uiHtml));

function assertSharedNav(label, html, activeHref) {
  ok(`${label} nav has Spyglass link`, navHrefPresent(html, '/'));
  ok(`${label} nav has Clients link`, navHrefPresent(html, '/clients'));
  ok(`${label} nav has Billing link`, navHrefPresent(html, '/billing'));
  ok(`${label} nav has Communications link`, navHrefPresent(html, '/communications'));
  ok(`${label} nav has Sales link`, navHrefPresent(html, '/sales'));
  ok(`${label} nav labels present`, /Spyglass/i.test(html) && />Clients</.test(html) && /Billing/i.test(html) && /Communications/i.test(html) && />Sales</.test(html));
  ok(`${label} has exactly one aria-current=page`, countAriaCurrent(html) === 1);
  const activeRe = new RegExp(`<a\\b[^>]*\\bhref=["']${activeHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*aria-current=["']page["']|<a\\b[^>]*aria-current=["']page["'][^>]*\\bhref=["']${activeHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
  ok(`${label} aria-current on active href ${activeHref}`, activeRe.test(html));
  ok(`${label} keeps logout`, /action=["']\/logout["']/i.test(html) && /Sign out/i.test(html));
  ok(`${label} nav is mobile-safe wrap/scroll`, /\bnav\b[\s\S]*overflow-x\s*:\s*auto|\bnav\b[\s\S]*flex-wrap\s*:\s*wrap|top-nav[\s\S]*overflow-x\s*:\s*auto|top-nav[\s\S]*flex-wrap\s*:\s*wrap/i.test(pageSrc + html));
}

assertSharedNav('Spyglass', uiHtml, '/');
assertSharedNav('Clients', clientsHtml, '/clients');
assertSharedNav('Billing', billingHtml, '/billing');
assertSharedNav('Communications', communicationsHtml, '/communications');
const salesHtml = renderPageHtml({ view: 'sales' });
assertSharedNav('Sales', salesHtml, '/sales');
ok('Sales view renders Sales heading', /<h1[^>]*>[\s\S]*Sales/i.test(salesHtml));
ok('Sales view shows manual intake', /website|business.?name/i.test(salesHtml) && /<form\b[^>]*action=["']\/sales\/prospects["']/i.test(salesHtml));
ok('router protects /sales', routerBody.includes("pathname === '/sales'"));
ok('router allowlists Sales create mutation', /\/sales\/prospects/.test(routerBody));
ok('crowsnest-sales module exists', fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js')));
ok('api requires crowsnest-sales', apiSrc.includes("require('./lib/crowsnest/crowsnest-sales')"));
ok(
  'page no longer couples directly to sales store reads',
  !pageSrc.includes("require('./crowsnest-sales')"),
);

ok('unknown view does not produce arbitrary content', (() => {
  const weird = renderPageHtml({ view: '"><script>alert(1)</script>' });
  return !weird.includes('<script>alert(1)</script>') && /Spyglass|not found|Crowsnest/i.test(weird);
})());

ok('UI Clients section exists', clientsHtml.includes('>Clients<') || clientsHtml.includes('section">Clients'));
ok('UI Wolfhouse Somo card', clientsHtml.includes('Wolfhouse Somo'));
ok('UI Sunset Somo card', clientsHtml.includes('Sunset Somo'));
ok('UI Sunset Sardinero card', clientsHtml.includes('Sunset Sardinero'));
ok('UI surf house template text', /surf house template/i.test(clientsHtml));
ok('UI surf school template text', /surf school template/i.test(clientsHtml));
ok('UI Add new client disabled/coming soon', clientsHtml.includes('Add new client') && /Coming soon|disabled|aria-disabled/.test(clientsHtml));
ok('UI safety copy read-only/no writes', /read-only|no client creation|no writes/i.test(clientsHtml));
ok('UI environment/status rows render', clientsHtml.includes('env-row') && clientsHtml.includes('Environments / status'));
ok('UI Wolfhouse staff-staging link', clientsHtml.includes('https://staff-staging.lunafrontdesk.com'));
ok('UI Wolfhouse production link', clientsHtml.includes('https://wolfhouse.lunafrontdesk.com'));
ok('UI Sunset staging link', clientsHtml.includes('https://sunset-staging.lunafrontdesk.com'));
ok('UI Luna WhatsApp placeholder', clientsHtml.includes('Luna WhatsApp') && /Coming soon|coming_soon/i.test(clientsHtml));
ok('UI Stripe placeholder', clientsHtml.includes('Stripe'));
ok('UI Database placeholder', clientsHtml.includes('Database'));
ok('UI static placeholders / no live health checks copy', /static placeholders only|no live health checks/i.test(clientsHtml));
ok('UI New client onboarding section', clientsHtml.includes('New client onboarding'));
ok('UI onboarding draft/no client creation copy', /draft form only|no client creation/i.test(clientsHtml));
ok('UI Surf house template option', clientsHtml.includes('Surf house'));
ok('UI Surf school template option', clientsHtml.includes('Surf school'));
ok('UI client name field', clientsHtml.includes('Client name') && clientsHtml.includes('Example Surf House'));
ok('UI client slug field', clientsHtml.includes('Client slug') && clientsHtml.includes('example-surf-house'));
ok('UI primary location field', clientsHtml.includes('Primary location') && clientsHtml.includes('Somo, Spain'));
ok('UI contact email field', clientsHtml.includes('Contact email') && clientsHtml.includes('hello@example.com'));
ok('UI WhatsApp number field', clientsHtml.includes('WhatsApp number'));
ok('UI staff portal domain field', clientsHtml.includes('Staff portal domain'));
ok('UI staging domain field', clientsHtml.includes('Staging domain'));
ok('UI notes field', clientsHtml.includes('Notes') && /Internal setup notes/i.test(clientsHtml));
ok('UI Preview setup button disabled', clientsHtml.includes('Preview setup') && /disabled|aria-disabled/.test(clientsHtml));
ok('UI Create client button disabled', clientsHtml.includes('Create client') && /disabled|aria-disabled/.test(clientsHtml));
ok('UI checklist tenant record', /Create tenant record/i.test(clientsHtml));
ok('UI checklist database/schema', /database\/schema|Create database/i.test(clientsHtml));
ok('UI checklist Staff API', /Staff API/i.test(clientsHtml));
ok('UI checklist Luna identity', /Luna identity/i.test(clientsHtml));
ok('UI checklist WhatsApp', /Configure WhatsApp/i.test(clientsHtml));
ok('UI checklist Stripe', /Configure Stripe/i.test(clientsHtml));
ok('UI checklist DNS/domain', /DNS\/domain/i.test(clientsHtml));
ok('UI checklist smoke tests', /smoke tests/i.test(clientsHtml));
ok('UI onboarding form safe action', /action="#"/.test(clientsHtml) && !/<form[^>]+action=["']https?:/i.test(clientsHtml));

ok('Billing placeholder says not connected', /not connected|not available|no data source|unavailable/i.test(billingHtml) && /Billing/i.test(billingHtml));
ok('Billing placeholder has no forms or mutations', (() => {
  const withoutLogout = billingHtml.replace(/<form[^>]+action=["']\/logout["'][\s\S]*?<\/form>/i, '');
  return !/<form\b/i.test(withoutLogout) && !/type=["']submit["']/i.test(withoutLogout);
})());
ok('Billing does not invent amounts', !hasInventedMetricNumber(billingHtml));
ok('Communications placeholder says not connected', /not connected|not available|no data source|unavailable/i.test(communicationsHtml) && /Communications/i.test(communicationsHtml));
ok('Communications placeholder has no send/recipient controls', (() => {
  const withoutLogout = communicationsHtml.replace(/<form[^>]+action=["']\/logout["'][\s\S]*?<\/form>/i, '');
  return !/send message|recipient|compose/i.test(communicationsHtml) && !/<form\b/i.test(withoutLogout);
})());
ok('Communications does not invent counts', !hasInventedMetricNumber(communicationsHtml));

ok('product doc labels Slice 1 as merged and deployed', /Slice 1/i.test(productDoc) && /merged and deployed/i.test(productDoc) && /14a7e3f7f656dd8a7dc11b528b8a645d3feb1210/.test(productDoc) && /crowsnest-internal--0000010/.test(productDoc) && /#128|PR #128|pull\/128/i.test(productDoc) && /cb11e/.test(productDoc) && /wh-staging-staff-api--0000520/.test(productDoc) && !/local candidate/i.test(productDoc));

const crowsnestLibSrc = [pageSrc, clientsSrc, onboardingSrc, read(AUTH_PATH) || '', read(SALES_PATH) || ''].join('\n');
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
ok('CROWSNEST_AUTH_EARTHLING_USERNAME env referenced', /CROWSNEST_AUTH_EARTHLING_USERNAME/.test(authSrc));
ok('CROWSNEST_AUTH_EARTHLING_PASSWORD env referenced', /CROWSNEST_AUTH_EARTHLING_PASSWORD/.test(authSrc));
ok('CROWSNEST_AUTH_MONSHIES_USERNAME env referenced', /CROWSNEST_AUTH_MONSHIES_USERNAME/.test(authSrc));
ok('CROWSNEST_AUTH_MONSHIES_PASSWORD env referenced', /CROWSNEST_AUTH_MONSHIES_PASSWORD/.test(authSrc));
ok('getCrowsnestAuthAccounts helper exists', /function getCrowsnestAuthAccounts|getCrowsnestAuthAccounts\s*\(/.test(authSrc));
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
ok('login logo SHA-256 matches transparent replacement', (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(LOGO_PATH)).digest('hex') === EXPECTED_LOGO_SHA256;
  } catch {
    return false;
  }
})());
ok('login page omits removed Monshies/Earthling sentence', !pageSrc.includes(REMOVED_LOGIN_COPY));
ok('login logo CSS uses display:block', /\.login-logo\s*\{[^}]*display\s*:\s*block\b/.test(pageSrc));
ok('login logo CSS uses margin-inline:auto', /\.login-logo\s*\{[^}]*margin-inline\s*:\s*auto\b/.test(pageSrc));
ok('login logo CSS uses responsive width', /\.login-logo\s*\{[^}]*width\s*:\s*min\s*\(/.test(pageSrc));
ok('login logo CSS uses height:auto', /\.login-logo\s*\{[^}]*height\s*:\s*auto\b/.test(pageSrc));
ok('login logo CSS avoids opaque black background', !/\.login-logo\s*\{[^}]*background(?:-color)?\s*:\s*(?:#000(?:000)?|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))\b/i.test(pageSrc));
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
ok('deploy plan mentions Earthling multi-account env', /CROWSNEST_AUTH_EARTHLING_USERNAME/.test(deployDoc) && /CROWSNEST_AUTH_EARTHLING_PASSWORD/.test(deployDoc));
ok('deploy plan mentions Monshies multi-account env', /CROWSNEST_AUTH_MONSHIES_USERNAME/.test(deployDoc) && /CROWSNEST_AUTH_MONSHIES_PASSWORD/.test(deployDoc));
ok('deploy plan records Azure auth secret refs', /cn-auth-user/.test(deployDoc) && /cn-auth-pass/.test(deployDoc));
ok('deploy plan records Monshies Azure secret refs', /cn-monshies-user/.test(deployDoc) && /cn-monshies-pass/.test(deployDoc));
ok('deploy plan records multi-account as verified current live', /VERIFIED CURRENT LIVE/i.test(deployDoc) && /Earthling/.test(deployDoc) && /Monshies/.test(deployDoc) && /cn-monshies-user/.test(deployDoc) && !/not deployed yet/i.test(deployDoc));
ok('product doc mentions Earthling multi-account env', /CROWSNEST_AUTH_EARTHLING_USERNAME/.test(productDoc) && /CROWSNEST_AUTH_EARTHLING_PASSWORD/.test(productDoc));
ok('product doc mentions Monshies multi-account env', /CROWSNEST_AUTH_MONSHIES_USERNAME/.test(productDoc) && /CROWSNEST_AUTH_MONSHIES_PASSWORD/.test(productDoc));
ok('product doc records live Azure Earthling/Monshies secret mapping', /cn-auth-user/.test(productDoc) && /cn-monshies-user/.test(productDoc) && /Earthling/.test(productDoc) && /Monshies/.test(productDoc) && !/not deployed/i.test(productDoc));

const writeRouteRe = /\.(post|put|patch|delete)\(|\/(create|update|delete|save|write|submit)\b/i;
const apiWithoutSalesMutations = apiSrc
  .replace(/async function handleSalesCreateProspect[\s\S]*?(?=async function handleSalesDecision)/, '')
  .replace(/async function handleSalesDecision[\s\S]*?(?=async function router)/, '')
  .replace(/if \(pathname === '\/sales\/prospects'\)[\s\S]*?return handleSalesCreateProspect[\s\S]*?\n/, '')
  .replace(/const decisionProspectId[\s\S]*?return handleSalesDecision[\s\S]*?\n\s*\}/, '')
  .replace(/\/sales\/prospects/g, '');
ok('no non-Sales business/data write routes in crowsnest-api', !writeRouteRe.test(apiWithoutSalesMutations));
ok('Sales mutations are narrowly allowlisted', /handleSalesCreateProspect/.test(apiSrc) && /handleSalesDecision/.test(apiSrc));
ok('Sales create allows POST only', /async function handleSalesCreateProspect[\s\S]*?sendMethodNotAllowed\(res, 'POST'\)/.test(apiSrc));
ok('Sales decision allows POST only', /async function handleSalesDecision[\s\S]*?sendMethodNotAllowed\(res, 'POST'\)/.test(apiSrc));
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
ok('deploy plan records live revision and image SHA', /crowsnest-internal--0000009/.test(deployDoc) && /3c3f6b5071bc8f5dc51c7216463e515f29fee258/.test(deployDoc));
ok('location plan records live revision and image SHA', /crowsnest-internal--0000009/.test(planDoc) && /3c3f6b5071bc8f5dc51c7216463e515f29fee258/.test(planDoc));
ok('deploy plan records Staff API unchanged at verified revision', /wh-staging-staff-api--0000520/.test(deployDoc) && /458ed255e8a06b7b0557718031e57f4d7064fa62/.test(deployDoc));
ok('deploy plan keeps credential distribution out of scope', /credential distribution is out of scope/i.test(deployDoc));
ok('deploy plan does not assert credentials delivered to humans', !/humans (?:have )?(?:received|been issued) (?:live )?credentials|credentials were (?:sent|issued|delivered) to/i.test(deployDoc));
ok('deploy plan preserves legacy single-account fallback docs', /Legacy single-account fallback/i.test(deployDoc) && /CROWSNEST_AUTH_USERNAME/.test(deployDoc));
ok('product doc preserves legacy single-account fallback docs', /Legacy single-account fallback/i.test(productDoc) && /CROWSNEST_AUTH_USERNAME/.test(productDoc));
ok('location plan records live multi-account secret mapping', /cn-auth-user/.test(planDoc) && /cn-monshies-user/.test(planDoc) && /Earthling/.test(planDoc) && /Monshies/.test(planDoc) && !/not deployed yet/i.test(planDoc));
ok('deploy plan records verified Monshies production login checks', /Monshies/.test(deployDoc) && /Secure cookie/i.test(deployDoc) && /logout isolation/i.test(deployDoc) && /invalid login/i.test(deployDoc));
ok('deploy plan does not invent unverified Earthling production login test', !/Earthling production (?:browser )?login (?:was )?(?:verified|passed|confirmed)/i.test(deployDoc));

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
ok('package.json has verify:crowsnest-ai-usage-contract', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-ai-usage-contract'] === 'string');
ok('package.json has verify:crowsnest-ai-usage-adapter', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-ai-usage-adapter'] === 'string');
ok('package.json has verify:crowsnest-sales', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales'] === 'string');
ok('package.json has verify:crowsnest-sales-durable', pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-durable'] === 'string');

console.log(`\n── verify:crowsnest: ${pass} passed, ${fail} failed ──`);
if (fail === 0) {
  console.log('verify:crowsnest — ALL CHECKS PASSED');
}
process.exit(fail ? 1 : 0);
