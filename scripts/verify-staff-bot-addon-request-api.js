'use strict';
/**
 * verify-staff-bot-addon-request-api.js — Stage 8.8.25 / 8.8.27
 *
 * Static verifier for:
 *   POST /staff/bot/addon-request-preview  (dry-run)
 *   POST /staff/bot/addon-requests/create  (write path)
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

const previewStart = API_SRC.indexOf('async function handleBotAddonRequestPreview(');
const previewEnd = API_SRC.indexOf('async function handleBotAddonRequestCreate(', previewStart + 100);
const previewText = previewStart > -1 && previewEnd > -1
  ? API_SRC.slice(previewStart, previewEnd)
  : '';

const createStart = API_SRC.indexOf('async function handleBotAddonRequestCreate(');
const createEnd = createStart > -1
  ? API_SRC.indexOf('\n// Route: POST /staff/bot/booking-preview', createStart + 100)
  : -1;
const createText = createStart > -1 && createEnd > -1
  ? API_SRC.slice(createStart, createEnd)
  : '';

const previewRouteIdx = API_SRC.indexOf("'/staff/bot/addon-request-preview'");
const previewRouteBlock = previewRouteIdx > -1 ? API_SRC.slice(previewRouteIdx, previewRouteIdx + 700) : '';

const createRouteIdx = API_SRC.indexOf("'/staff/bot/addon-requests/create'");
const createRouteBlock = createRouteIdx > -1 ? API_SRC.slice(createRouteIdx, createRouteIdx + 700) : '';

console.log('\nA. Preview route');
check('A1', 'handleBotAddonRequestPreview defined', previewStart > -1);
check('A2', "route '/staff/bot/addon-request-preview' registered", previewRouteIdx > -1);
check('A3', 'preview router dispatches handler', previewRouteBlock.includes('handleBotAddonRequestPreview'));
check('A4', 'preview uses requireBotAuth()', previewRouteBlock.includes('requireBotAuth'));
check('A5', 'shared resolveBotAddonRequestContext', API_SRC.includes('async function resolveBotAddonRequestContext('));

console.log('\nB. Preview dry-run safety');
check('B1', 'preview_only: true', previewText.includes('preview_only: true'));
check('B2', 'no_write_performed: true', previewText.includes('no_write_performed: true'));
check('B3', 'creates_service_record: false', previewText.includes('creates_service_record: false'));
check('B4', 'creates_payment: false in preview', previewText.includes('creates_payment: false'));
check('B5', 'sends_whatsapp: false in preview', previewText.includes('sends_whatsapp: false'));

console.log('\nC. Preview validation paths');
check('C1', 'service_type allowlist', API_SRC.includes('BOT_ADDON_SERVICE_TYPES'));
check('C2', 'ask_service_date path', API_SRC.includes("next_action: 'ask_service_date'"));
check('C3', 'ask_quantity path', API_SRC.includes("next_action: 'ask_quantity'"));
check('C4', 'meal_on_site_only', API_SRC.includes('meal_on_site_only'));
check('C5', 'pricing from wolfhouse-somo.pricing.json', API_SRC.includes('wolfhouse-somo.pricing.json'));

const previewNoComments = previewText.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
console.log('\nD. Preview no writes');
check('D1', 'no INSERT in preview handler', !/\bINSERT\s+INTO\b/i.test(previewNoComments));
check('D2', 'no stripe in preview handler', !previewText.includes('checkout.sessions.create'));

console.log('\nE. Create route');
check('E1', 'handleBotAddonRequestCreate defined', createStart > -1);
check('E2', "route '/staff/bot/addon-requests/create' registered", createRouteIdx > -1);
check('E3', 'create router dispatches handler', createRouteBlock.includes('handleBotAddonRequestCreate'));
check('E4', 'create uses requireBotAuth()', createRouteBlock.includes('requireBotAuth'));
check('E5', 'startup log mentions addon-requests/create', API_SRC.includes('bot/addon-requests/create') && API_SRC.includes('8.8.27'));

console.log('\nF. Create gates');
check('F1', 'BOT_ADDON_REQUESTS_ENABLED flag', API_SRC.includes('BOT_ADDON_REQUESTS_ENABLED'));
check('F2', 'confirm:true required', createText.includes('body.confirm !== true'));
check('F3', 'STRIPE_LINKS_ENABLED when canPay', createText.includes('STRIPE_LINKS_ENABLED'));
check('F4', 'calls resolveBotAddonRequestContext', createText.includes('resolveBotAddonRequestContext'));

console.log('\nG. Create write paths');
check('G1', 'INSERT booking_service_records', createText.includes('INSERT INTO booking_service_records'));
check('G2', "source luna_guest on service row", createText.includes("'luna_guest'"));
check('G3', 'INSERT addon_service payment', createText.includes("'addon_service'::payment_kind"));
check('G4', 'metadata luna_guest_addon_request', createText.includes('luna_guest_addon_request'));
check('G5', 'metadata service_record_ids', createText.includes('service_record_ids'));
check('G6', 'stripe.checkout.sessions.create in create', createText.includes('checkout.sessions.create'));
check('G7', 'Stripe amount from dbAmountDueCents not body', createText.includes('unit_amount: dbAmountDueCents'));
check('G8', 'meal record_only gate', createText.includes("ctx.paymentChoice !== 'record_only'"));
check('G9', 'response service_record_id', createText.includes('service_record_id'));
check('G10', 'response checkout_url', createText.includes('checkout_url'));
check('G11', 'response payment_kind addon_service', createText.includes("payment_kind = 'addon_service'") || createText.includes("payment_kind: 'addon_service'"));

console.log('\nH. Create safety');
check('H1', 'no_payment_truth_recorded', createText.includes('no_payment_truth_recorded: true'));
check('H2', 'sends_whatsapp: false', createText.includes('sends_whatsapp: false'));
check('H3', 'whatsapp_dry_run in response', createText.includes('whatsapp_dry_run'));
check('H4', 'no_n8n: true', createText.includes('no_n8n: true'));
check('H5', 'no graph.facebook.com in create', !createText.includes('graph.facebook.com'));
check('H6', 'no n8n fetch in create', !createText.includes('fetch('));
check('H7', 'no confirmation_sent_at write', !createText.includes('confirmation_sent_at'));
check('H8', 'no UPDATE bookings in create', !/\bUPDATE\s+bookings\b/i.test(createText.replace(/\/\/[^\n]*/g, '')));
check('H9', 'service row not marked paid', !createText.includes("payment_status = 'paid'") && !createText.includes("status = 'paid'"));
check('H10', 'amount_paid_cents 0 on insert', createText.includes('amount_paid_cents') && createText.includes(', 0,'));

console.log('\nI. package.json script');
check('I1', 'verify:staff-bot-addon-request-api script', !!PKG.scripts['verify:staff-bot-addon-request-api']);

console.log('\nJ. Syntax check');
try {
  execSync('node --check scripts/staff-query-api.js', { cwd: ROOT, stdio: 'pipe' });
  check('J1', 'staff-query-api.js parses', true);
} catch (e) {
  check('J1', 'staff-query-api.js parses', false, e.message);
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('verify-staff-bot-addon-request-api FAIL\n');
  process.exit(1);
}
console.log('verify-staff-bot-addon-request-api PASS\n');
