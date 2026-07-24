'use strict';

/**
 * Static checks: Newsreader + Instrument Sans typography system for staff portal.
 * No HTTP / no deploy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const LOGIN_PAGE = path.join(ROOT, 'scripts', 'lib', 'staff-portal-login-page.js');
const LOGIN_CSS = path.join(ROOT, 'config', 'staff-portal', 'staff-login-page.css');

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
const loginPage = fs.readFileSync(LOGIN_PAGE, 'utf8');
const loginCss = fs.readFileSync(LOGIN_CSS, 'utf8');

const styleStart = apiSrc.indexOf('/* ── Palette (soft boutique-hospitality)');
const styleEnd = apiSrc.indexOf('</style>', styleStart);
const style = styleStart >= 0 && styleEnd > styleStart ? apiSrc.slice(styleStart, styleEnd) : '';

const FONT_HREF =
  'family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Instrument+Sans:wght@400;500;600;700';

console.log('verify-portal-typography-fonts');

assert('main UI Google Fonts stylesheet link', apiSrc.includes(FONT_HREF));
assert('main UI fonts.googleapis preconnect', apiSrc.includes('fonts.googleapis.com') && apiSrc.includes('fonts.gstatic.com'));
assert('login Google Fonts stylesheet link', loginPage.includes(FONT_HREF));
assert('CSS var --font-sans Instrument Sans', style.includes("--font-sans:'Instrument Sans'"));
assert('CSS var --font-display Newsreader', style.includes("--font-display:'Newsreader'"));
assert('body uses --font-sans', /body\{[^}]*font-family:var\(--font-sans\)/.test(style));
assert('no Inter in main style block', !style.includes('Inter'));
assert('login CSS uses --font-sans', loginCss.includes("--font-sans:'Instrument Sans'") && loginCss.includes('font-family:var(--font-sans)'));
assert('login CSS has --font-display', loginCss.includes("--font-display:'Newsreader'"));
assert('schedule range display font', style.includes('.portal-schedule-range') && style.includes('var(--font-display)'));
assert('lesson title display font', style.includes('.portal-schedule-ops-lesson-hdr-title') && style.includes('font-size:19px'));
assert('KPI stat display font ~34px', style.includes('font-size:34px') && style.includes('font-weight:500'));
assert('tabular-nums present', style.includes('font-variant-numeric:tabular-nums'));
assert('micro-label letter-spacing 0.09em', style.includes('letter-spacing:.09em') || style.includes('letter-spacing:0.09em'));
assert('tab active weight 600', style.includes('.tab-btn.active{font-weight:600'));
assert('no font-weight 800+ in main style', !/font-weight:\s*(?:8\d\d|9\d\d)/.test(style));
assert('utility pages use Instrument Sans', apiSrc.includes("font-family:'Instrument Sans',system-ui,sans-serif"));
assert('inputs inherit font', style.includes('button,input,select,textarea{font-family:inherit}'));

// Monospace allowed for code-ish UI
assert(
  'code mono still allowed outside Inter',
  apiSrc.includes("font-family:monospace") || style.includes('font-family:inherit')
);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
