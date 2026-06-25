'use strict';

/**
 * Static checks for staff portal login page (no HTTP).
 * Ensures login-only changes do not regress portal features on current master.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const LOGIN_PAGE = path.join(ROOT, 'scripts', 'lib', 'staff-portal-login-page.js');
const LOGIN_CSS = path.join(ROOT, 'config', 'staff-portal', 'staff-login-page.css');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es.js');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const LOGIN_BG = path.join(ROOT, 'public', 'images', 'luna-login-bg.jpg');

let pass = 0;
let fail = 0;

function assert(label, ok) {
  if (ok) {
    pass += 1;
    console.log('  PASS', label);
  } else {
    fail += 1;
    console.log('  FAIL', label);
  }
}

const apiSrc = fs.readFileSync(API, 'utf8');
const pageSrc = fs.readFileSync(LOGIN_PAGE, 'utf8');
const cssSrc = fs.readFileSync(LOGIN_CSS, 'utf8');
const i18nSrc = fs.readFileSync(I18N, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES, 'utf8');
const dockerSrc = fs.readFileSync(DOCKERFILE, 'utf8');

const { buildStaffLoginHtml } = require('./lib/staff-portal-login-page');
const mockLangSwitch = '<button type="button" class="staff-lang-btn-login staff-lang-btn is-active" data-lang="es">ES</button>';
const wolfhouseHtml = buildStaffLoginHtml('wolfhouse-somo', ['es', 'en', 'it'], mockLangSwitch + '<button type="button" data-lang="it">IT</button>');
const sunsetHtml = buildStaffLoginHtml('sunset', ['es', 'en'], mockLangSwitch);

console.log('verify-staff-login-page');

assert('login module exists', fs.existsSync(LOGIN_PAGE));
assert('login CSS exists', fs.existsSync(LOGIN_CSS));
assert('background asset exists', fs.existsSync(LOGIN_BG) && fs.statSync(LOGIN_BG).size > 1000);
assert('Dockerfile copies public', dockerSrc.includes('COPY public ./public'));
assert('staff-query-api serves /images/luna-login-bg.jpg', apiSrc.includes('/images/luna-login-bg.jpg') && apiSrc.includes('handleStaffPortalLoginBg'));
assert('buildLoginHtml delegates to login module', apiSrc.includes('buildStaffLoginHtml(loginDefaultClient, STAFF_PORTAL_LOCALES'));
assert('DEFAULT_CLIENT_SLUG respected for tenant default', apiSrc.includes('process.env.DEFAULT_CLIENT_SLUG'));

assert('buildStaffLoginHtml returns HTML', wolfhouseHtml.includes('<!DOCTYPE html>'));
assert('loginShell present', wolfhouseHtml.includes('loginShell'));
assert('portrait stage + card', wolfhouseHtml.includes('loginStage') && wolfhouseHtml.includes('loginCard'));
assert('botanical decor layer', wolfhouseHtml.includes('loginBotanicalDecor'));
assert('control pill', wolfhouseHtml.includes('loginControlPill'));
assert('login title + wave', wolfhouseHtml.includes('loginTitle') && wolfhouseHtml.includes('loginTitleWave'));
assert('field icons (building/email/lock)', wolfhouseHtml.includes('fieldInputWrap') && pageSrc.includes('ICON_BUILDING'));
assert('password visibility toggle', wolfhouseHtml.includes('password-toggle') && wolfhouseHtml.includes('fieldPasswordToggle'));
assert('sign-in button + icon', wolfhouseHtml.includes('signInButton') && wolfhouseHtml.includes('signInButtonIcon'));
assert('help link', wolfhouseHtml.includes('login-help-link'));
assert('footer brand + tagline keys', wolfhouseHtml.includes('login.footerTagline') && wolfhouseHtml.includes('login.footerTitle'));
assert('Guest care tagline EN', i18nSrc.includes('Guest care, always there.'));
assert('Guest care tagline ES', i18nEsSrc.includes('Siempre ahí para tus huéspedes.'));
assert('Guest care tagline IT', i18nSrc.includes('Sempre qui per i tuoi ospiti.'));
assert('Luna Front Desk Admin help copy', i18nSrc.includes('Contact your Luna Front Desk Admin'));

assert('auth POST /staff/auth/login preserved', pageSrc.includes('/staff/auth/login'));
assert('doSignIn + btn-signin preserved', pageSrc.includes('doSignIn') && pageSrc.includes('btn-signin'));
assert('field ids client/email/password preserved', wolfhouseHtml.includes('id="client"') && wolfhouseHtml.includes('id="email"') && wolfhouseHtml.includes('id="password"'));

assert('Wolfhouse default client value', wolfhouseHtml.includes('value="wolfhouse-somo"'));
assert('Sunset default client value', sunsetHtml.includes('value="sunset"'));
assert('Sunset login does not default Wolfhouse', !sunsetHtml.includes('value="wolfhouse-somo"'));

assert('Services tab marker preserved', apiSrc.includes('data-tab="services"'));
assert('Staff & Owner WhatsApp section preserved', apiSrc.includes('Staff & Owner WhatsApp numbers'));
assert('tenant-driven locale switcher preserved', apiSrc.includes('renderStaffLangSwitchButtons'));
assert('default locale follows first STAFF_PORTAL_LOCALES entry', apiSrc.includes('STAFF_PORTAL_LOCALES[0]'));
assert('root redirects to staff login', apiSrc.includes('Location: \'/staff/login\'') && apiSrc.includes('pathname === \'/\''));

assert('CSS background image path', cssSrc.includes('/images/luna-login-bg.jpg'));
assert('CSS narrower stage max ~440px', cssSrc.includes('440px'));
assert('decor pointer-events safe', cssSrc.includes('pointer-events:none'));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
