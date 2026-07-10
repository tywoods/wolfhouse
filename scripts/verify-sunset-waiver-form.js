'use strict';

/**
 * verify:sunset-waiver-form
 *
 * Offline checks for public /forms/waiver/:token page + routes.
 *
 * Run:
 *   node scripts/verify-sunset-waiver-form.js
 *   npm run verify:sunset-waiver-form
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PAGE = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-form-page.js');
const ROUTES = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-routes.js');
const CONFIG = path.join(ROOT, 'config', 'clients', 'sunset.waiver-form.json');
const MODEL = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-model.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

console.log('\nverify:sunset-waiver-form — public waiver page/route offline checks\n');

console.log('[1] files + config gate');
assert('page module exists', fs.existsSync(PAGE));
assert('routes module exists', fs.existsSync(ROUTES));
assert('staff-query-api.js exists', fs.existsSync(API));
assert('config exists', fs.existsSync(CONFIG));
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
assert('BLOCKED_FOR_LEGAL_COPY_CONFIRMATION', cfg._meta.status === 'BLOCKED_FOR_LEGAL_COPY_CONFIRMATION');
assert('needs_legal_copy_confirmation', cfg._meta.needs_legal_copy_confirmation === true);
assert('draft form_version', cfg._meta.form_version === 'sunset_google_form_v1_draft_from_screenshots');

const apiSrc = fs.readFileSync(API, 'utf8');
const pageSrc = fs.readFileSync(PAGE, 'utf8');
const routesSrc = fs.readFileSync(ROUTES, 'utf8');
const modelSrc = fs.readFileSync(MODEL, 'utf8');

console.log('\n[2] staff-query-api route registration (before auth)');
assert('requires sunset-waiver-routes', apiSrc.includes("require('./lib/sunset-waiver-routes')"));
assert('tryHandleSunsetWaiverPublicRoute used', apiSrc.includes('tryHandleSunsetWaiverPublicRoute'));
assert('forms/waiver path pattern present',
  apiSrc.includes('tryHandleSunsetWaiverPublicRoute') && routesSrc.includes('/forms/waiver/'));
const routerIdx = apiSrc.indexOf('async function router(');
const waiverCallIdx = apiSrc.indexOf('tryHandleSunsetWaiverPublicRoute(pathname, method, req, res');
const authLoginIdx = apiSrc.indexOf("pathname === '/staff/auth/login'");
const payIdx = apiSrc.indexOf('GUEST_PAY_SHORT_LINK_RE.exec');
assert('router contains waiver hook', waiverCallIdx > routerIdx && routerIdx >= 0);
assert('waiver hook before staff auth login', waiverCallIdx > 0 && authLoginIdx > waiverCallIdx);
assert('waiver hook before or with public /pay block',
  payIdx < 0 || (waiverCallIdx > 0 && waiverCallIdx < authLoginIdx));

console.log('\n[3] page module content from config');
assert('FICHA DE INSCRIPCIÓN heading', pageSrc.includes('FICHA DE INSCRIPCIÓN'));
assert('CONDICIONES GENERALES DEL CONTRATO', pageSrc.includes('CONDICIONES GENERALES DEL CONTRATO'));
assert('INFORMACIÓN Y CONSENTIMIENTO', pageSrc.includes('INFORMACIÓN Y CONSENTIMIENTO'));
assert('escapes with esc(', /function esc\(/.test(pageSrc) && pageSrc.includes('.replace(/&/g'));
assert('phone saved row copy', pageSrc.includes('Teléfono: ya guardado desde WhatsApp'));
assert('email saved row copy', pageSrc.includes('E-mail: ya guardado desde la reserva'));
assert('success message', pageSrc.includes('Gracias — tu formulario de Sunset está completo. Puedes volver a WhatsApp.'));
assert('invalid message', pageSrc.includes('Este enlace no es válido o ha caducado.'));
assert('unavailable message', pageSrc.includes('Este enlace ya no está disponible. Contacta con Sunset para recibir uno nuevo.'));
assert('already submitted message', pageSrc.includes('Este formulario ya fue enviado. Puedes volver a WhatsApp.'));
assert('no production default host in page', !pageSrc.includes("https://sunset.lunafrontdesk.com"));
assert('cream/navy styling', pageSrc.includes('--cream') && pageSrc.includes('--navy'));

console.log('\n[4] routes module');
assert('GET handler', routesSrc.includes('handleWaiverGet'));
assert('POST handler', routesSrc.includes('handleWaiverPost'));
assert('calls recordWaiverSubmission', routesSrc.includes('recordWaiverSubmission'));
assert('calls getWaiverRequestByPublicId', routesSrc.includes('getWaiverRequestByPublicId'));
assert('tenant hard-coded sunset', routesSrc.includes("SUNSET_TENANT_ID") && routesSrc.includes("delete body.tenant_id"));
assert('WAIVER_PUBLIC_PATH_RE', routesSrc.includes('WAIVER_PUBLIC_PATH_RE'));
assert('no production default in routes', !routesSrc.includes("https://sunset.lunafrontdesk.com"));
assert('model default remains staging', modelSrc.includes("https://sunset-staging.lunafrontdesk.com"));

console.log('\n[5] unit-style page generation');
const page = require('./lib/sunset-waiver-form-page');
const routes = require('./lib/sunset-waiver-routes');

assert('matchWaiverPublicPath extracts token',
  routes.matchWaiverPublicPath('/forms/waiver/waiv_test123') === 'waiv_test123');
assert('matchWaiverPublicPath rejects other paths',
  routes.matchWaiverPublicPath('/staff/ui') == null);

const pendingHtml = page.buildPendingFormHtml({
  config: cfg,
  prefill: {
    phone: '+34600111222',
    email: 'guest@example.com',
    full_name: 'Ada <script>alert(1)</script> Lovelace',
    lesson_days: '23, 24 julio',
    summary: 'Clase Somo — booking internal should not appear',
  },
  actionPath: '/forms/waiver/waiv_test123',
});
assert('pending renders form title', pendingHtml.includes(cfg.title));
assert('pending renders school name', pendingHtml.includes(cfg.school.name));
assert('pending escapes script in name', pendingHtml.includes('Ada &lt;script&gt;alert(1)&lt;/script&gt; Lovelace'));
assert('pending does not include raw script tag from name', !pendingHtml.includes('<script>alert(1)</script>'));
assert('pending hides phone input when prefilled',
  pendingHtml.includes('Teléfono: ya guardado desde WhatsApp')
  && !/<input[^>]*name="phone"[^>]*type="tel"/i.test(pendingHtml));
assert('pending hides email input when prefilled',
  pendingHtml.includes('E-mail: ya guardado desde la reserva')
  && !/<input[^>]*name="email"[^>]*type="email"/i.test(pendingHtml));
assert('pending shows three section cards',
  pendingHtml.includes('id="section-inscription"')
  && pendingHtml.includes('id="section-contract"')
  && pendingHtml.includes('id="section-privacy"'));
assert('pending shows contract conditions list', pendingHtml.includes('<ol>'));
assert('pending POST action path', pendingHtml.includes('action="/forms/waiver/waiv_test123"'));

const completedHtml = page.buildAlreadySubmittedHtml();
assert('completed state message', completedHtml.includes('Este formulario ya fue enviado. Puedes volver a WhatsApp.'));

const invalidHtml = page.buildInvalidLinkHtml();
assert('invalid state message', invalidHtml.includes('Este enlace no es válido o ha caducado.'));

const successHtml = page.buildSuccessHtml();
assert('success state message', successHtml.includes('Gracias — tu formulario de Sunset está completo'));

const missing = page.collectAndValidateAnswers(cfg, {}, {});
assert('validation fails without answers', missing.ok === false);
assert('validation mentions DNI', missing.errors.some((e) => /DNI/i.test(e)));
assert('validation mentions contract acceptance',
  missing.errors.some((e) => /condiciones del contrato/i.test(e)));

const okish = page.collectAndValidateAnswers(cfg, {
  phone: '+34600111222',
  email: 'a@b.co',
}, {
  full_name: 'Test Guest',
  dni: '12345678A',
  lesson_days: '23 julio',
  accident_insurance: 'yes_accident_insurance',
  accept_contract_conditions: 'yes',
  express_consent_purposes: ['Realizar labores formativas.'],
  accept_personal_data_conditions: 'yes',
});
assert('validation passes with required set + prefilled contact', okish.ok === true, (okish.errors || []).join('; '));
assert('prefill phone source', okish.answers.phone && okish.answers.phone.source === 'prefill');
assert('prefill email source', okish.answers.email && okish.answers.email.source === 'prefill');
assert('user dni source', okish.answers.dni && okish.answers.dni.source === 'user');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK  verify:sunset-waiver-form');
console.log('\nLegal/product note: express_consent_purposes is required=true in config (Google Form behavior preserved). Review whether opt-in marketing consents should remain mandatory before production.');
