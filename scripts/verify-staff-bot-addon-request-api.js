'use strict';
/**
 * verify-staff-bot-addon-request-api.js — Stage 8.8.25
 *
 * Static verifier for POST /staff/bot/addon-request-preview
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
let failed = 0;

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

const handlerStart = API_SRC.indexOf('async function handleBotAddonRequestPreview(');
const handlerEnd = handlerStart > -1
  ? API_SRC.indexOf('\n// Route: POST /staff/bot/booking-preview', handlerStart + 100)
  : -1;
const handlerText = handlerStart > -1 && handlerEnd > -1
  ? API_SRC.slice(handlerStart, handlerEnd)
  : '';

const routeIdx = API_SRC.indexOf("'/staff/bot/addon-request-preview'");
const routeBlock = routeIdx > -1 ? API_SRC.slice(routeIdx, routeIdx + 700) : '';

console.log('\nA. Route registration');
check('A1', 'handleBotAddonRequestPreview defined', API_SRC.includes('async function handleBotAddonRequestPreview('));
check('A2', "route '/staff/bot/addon-request-preview' registered", routeIdx > -1);
check('A3', 'router dispatches to handleBotAddonRequestPreview', routeBlock.includes('handleBotAddonRequestPreview'));
check('A4', 'POST-only enforced', routeBlock.includes("method !== 'POST'"));
check('A5', 'startup log mentions addon-request-preview', API_SRC.includes('bot/addon-request-preview') && API_SRC.includes('8.8.25'));

console.log('\nB. Auth');
check('B1', 'route uses requireBotAuth()', routeBlock.includes('requireBotAuth'));
check('B2', 'requireBotAuth defined', API_SRC.includes('async function requireBotAuth('));

console.log('\nC. Dry-run safety flags');
check('C1', 'preview_only: true in handler', handlerText.includes('preview_only: true'));
check('C2', 'no_write_performed: true in handler', handlerText.includes('no_write_performed: true'));
check('C3', 'creates_service_record: false in handler', handlerText.includes('creates_service_record: false'));
check('C4', 'creates_payment: false in handler', handlerText.includes('creates_payment: false'));
check('C5', 'creates_stripe_link: false in handler', handlerText.includes('creates_stripe_link: false'));
check('C6', 'sends_whatsapp: false in handler', handlerText.includes('sends_whatsapp: false'));

console.log('\nD. Validation paths');
check('D1', 'service_type allowlist (BOT_ADDON_SERVICE_TYPES)', handlerText.includes('BOT_ADDON_SERVICE_TYPES'));
check('D2', 'allowlist includes yoga/meal/surf_lesson/wetsuit/surfboard', handlerText.includes("'yoga'") && handlerText.includes("'meal'") && handlerText.includes("'surf_lesson'") && handlerText.includes("'wetsuit'") && handlerText.includes("'surfboard'"));
check('D3', 'missing service_date → ask_service_date', handlerText.includes("next_action: 'ask_service_date'"));
check('D4', 'missing/invalid quantity → ask_quantity', handlerText.includes("next_action: 'ask_quantity'"));
check('D5', 'booking not found path', handlerText.includes("next_action: 'booking_not_found'"));
check('D6', 'reply_draft present', handlerText.includes('reply_draft'));

console.log('\nE. Meals record-only');
check('E1', 'meal_on_site_only reason', handlerText.includes('meal_on_site_only'));
check('E2', 'meals payment_required false', handlerText.includes("serviceType === 'meal'") || handlerText.includes("reason: 'meal_on_site_only'"));

console.log('\nF. Payable service previews');
check('F1', 'wetsuit pricing path', handlerText.includes("serviceType === 'wetsuit'") || handlerText.includes('wetsuit_rental'));
check('F2', 'surfboard pricing path', handlerText.includes("serviceType === 'surfboard'") || handlerText.includes('soft_top_rental'));
check('F3', 'surf_lesson pricing path', handlerText.includes("serviceType === 'surf_lesson'") || handlerText.includes('surf_lesson_single'));
check('F4', 'yoga pricing path', handlerText.includes("serviceType === 'yoga'") || handlerText.includes('yoga_class'));
check('F5', 'service_record_preview object', handlerText.includes('service_record_preview'));
check('F6', 'payment_preview object', handlerText.includes('payment_preview'));
check('F7', 'uses wolfhouse-somo.pricing.json', API_SRC.includes('wolfhouse-somo.pricing.json') && API_SRC.includes('previewGuestAddonPricing'));

console.log('\nG. No writes / external calls');
const handlerNoComments = handlerText.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('G1', 'no INSERT in handler', !/\bINSERT\s+INTO\b/i.test(handlerNoComments));
check('G2', 'no UPDATE in handler', !/\bUPDATE\s+\w/i.test(handlerNoComments));
check('G3', 'no DELETE in handler', !/\bDELETE\s+FROM\b/i.test(handlerNoComments));
check('G4', 'no stripe.checkout.sessions.create', !handlerText.includes('checkout.sessions.create'));
check('G5', 'no graph.facebook.com', !handlerText.includes('graph.facebook.com'));
check('G6', 'no n8n URL/fetch', !handlerText.includes('n8n') && !handlerText.includes('fetch('));
check('G7', 'no WhatsApp send', !handlerText.includes('sends_whatsapp: true') && !handlerText.includes('whatsapp.send'));

console.log('\nH. package.json script');
check('H1', 'verify:staff-bot-addon-request-api script', !!PKG.scripts['verify:staff-bot-addon-request-api']);

console.log('\nI. Syntax check');
try {
  execSync('node --check scripts/staff-query-api.js', { cwd: ROOT, stdio: 'pipe' });
  check('I1', 'staff-query-api.js parses', true);
} catch (e) {
  check('I1', 'staff-query-api.js parses', false, e.message);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('verify-staff-bot-addon-request-api FAIL\n');
  process.exit(1);
}
console.log('verify-staff-bot-addon-request-api PASS\n');
