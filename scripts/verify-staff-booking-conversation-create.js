/**
 * Phase 10.6h — Create conversation from booking drawer.
 *
 * Usage:
 *   npm run verify:staff-booking-conversation-create
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, msgPass, msgFail) { if (cond) ok(msgPass); else fail(msgFail || msgPass); }

console.log('\nverify-staff-booking-conversation-create.js  (Phase 10.6h)\n');

check(fs.existsSync(API_FILE), 'staff-query-api.js exists');
if (!fs.existsSync(API_FILE)) process.exit(1);

const src = fs.readFileSync(API_FILE, 'utf8');

try {
  execSync(`node --check "${API_FILE}"`, { stdio: 'ignore' });
  ok('staff-query-api.js passes node --check');
} catch (_) {
  fail('staff-query-api.js passes node --check');
}

const handlerStart = src.indexOf('async function handleBookingCreateConversation');
const handlerEnd = src.indexOf('async function handleBookingRecordCashPayment', handlerStart);
const handler = handlerStart >= 0 && handlerEnd > handlerStart
  ? src.slice(handlerStart, handlerEnd)
  : '';
const drawerJs = src.match(/function renderBookingContextDrawer\([\s\S]*?^function toGetClient/m)?.[0] || '';
const convCardIdx = drawerJs.indexOf('id="bc-drawer-card-conversation"');
const drawerRender = convCardIdx >= 0 ? drawerJs.slice(convCardIdx, convCardIdx + 1200) : drawerJs;
const footerRender = src.match(/function bcRenderBookingDrawerFooterHtml[\s\S]*?\n\}/)?.[0] || '';
const newConvInit = src.match(/function bcInitNewConversationShell[\s\S]*?\n\}/)?.[0] || '';
const loadInboxFn = src.match(/function loadInbox\([\s\S]*?\n\}/)?.[0] || '';
const openInboxFn = src.match(/function openInboxToConversation[\s\S]*?\n\}/)?.[0] || '';

console.log('\nA. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check(pkg.scripts && pkg.scripts['verify:staff-booking-conversation-create'],
  'package.json has verify:staff-booking-conversation-create script');

console.log('\nB. Drawer UI — no linked conversation');

check(/No linked conversation yet\./.test(drawerRender),
  'empty state copy: No linked conversation yet.');
check(!/No linked conversation or open handoff/.test(drawerRender),
  'old combined empty copy removed from drawer render');
check(/id="bc-new-conversation-btn"/.test(src), 'Start Conversation button id');
check(/Start Conversation/.test(src), 'Start Conversation button label');
check(/bcSyncConversationButtons/.test(src), 'syncs toolbar/footer conversation buttons');
check(/bcStartConversationFromBooking/.test(src), 'start conversation helper');
check(/btn-success-light/.test(footerRender), 'success-light conversation button class');
check(/data\.conversation/.test(footerRender) && /Open Conversation/.test(footerRender),
  'linked conversation preserves Open Conversation');
check(/if \(data\.conversation\)/.test(footerRender) && /} else \{/.test(footerRender),
  'button branch only when no linked conversation (else branch)');

console.log('\nC. Button → API → Inbox open');

check(/bcInitNewConversationShell/.test(src), 'drawer init wires new conversation shell');
check(/create-conversation/.test(src), 'UI posts to create-conversation');
check(/idempotency_key/.test(src.match(/function bcStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || ''), 'UI sends idempotency_key');
check(/Created from booking drawer/.test(src.match(/function bcStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || ''), 'UI sends drawer reason');
check(/openInboxToConversation/.test(src.match(/function bcStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || ''), 'success opens inbox via helper');
check(/function openInboxToConversation/.test(src), 'openInboxToConversation helper exists');
check(/beginConvDetailLoad/.test(src.match(/function openInboxToConversation[\s\S]*?\n\}/)?.[0] || ''),
  'openInboxToConversation shows loading state before inbox refresh');
check(/loadConvDetail\(selectConvIdAfterLoad\)/.test(src.match(/function loadInbox\([\s\S]*?\n\}/)?.[0] || ''),
  'loadInbox always reloads selected conversation detail');
check(/switchToTab\('conversations', 'inbox'\)/.test(openInboxFn), 'helper switches to Inbox tab');
check(/loadInbox\(convId\)/.test(openInboxFn), 'helper reloads inbox with conversation id');
check(/function loadInbox\(selectConvIdAfterLoad/.test(src), 'loadInbox accepts select-after-load');
check(/applyInboxFilter/.test(loadInboxFn), 'loadInbox still applies inbox filter');
check(/loadConvDetail\(selectConvIdAfterLoad\)/.test(loadInboxFn),
  'loadInbox loads detail when card not in filtered list');
check(/bcOpenOrStartConversationFromBooking/.test(src), 'open or start conversation handler');

console.log('\nD. API endpoint');

check(/async function handleBookingCreateConversation/.test(src), 'handler exists');
check(/pathname === '\/staff\/bookings\/create-conversation'/.test(src), 'route registered');
check(/requireAuth\(req, res, 'operator'\)/.test(
  src.slice(src.indexOf("pathname === '/staff/bookings/create-conversation'"),
    src.indexOf("pathname === '/staff/bookings/create-conversation'") + 500),
), 'operator auth on route');
check(/INSERT INTO conversations/.test(handler), 'creates conversation row');
check(/current_hold_booking_id/.test(handler), 'links conversation to booking');
check(/'staff_manual'/.test(handler), "metadata/session source staff_manual");
check(/channel:\s*'manual'/.test(handler), "channel manual in metadata");
check(/'open'::conversation_status/.test(handler), 'status open');
check(!/INSERT INTO messages/.test(handler), 'no outbound message insert');
check(/idempotent/.test(handler), 'idempotent response field');
check(/existingConvId|existing:\s*idempotent/.test(handler),
  'returns existing linked conversation idempotently');
check(/BOOKING_LINKED_CONVERSATION_SQL/.test(handler), 'lookup existing linked conversation');

console.log('\nE. Idempotency');

check(/booking-drawer-conv-/.test(src.match(/function bcStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || ''), 'stable UI idempotency key per booking');
check(/idempotency_key/.test(handler), 'server accepts idempotency_key');

console.log('\nF. Safety boundaries');

check(!/sendWhatsApp|whatsapp\.com|graph\.facebook|triggerN8n|n8n\.webhook|fetch\([^)]*n8n/i.test(handler + (src.match(/function bcStartConversationFromBooking[\s\S]*?\n\}/)?.[0] || '')),
  'no WhatsApp/n8n in handler or UI');
check(!/stripe\.|INSERT INTO payments|UPDATE payments/.test(handler),
  'no Stripe/payment mutation');
check(!/UPDATE booking_beds|INSERT INTO booking_beds|DELETE FROM booking_beds/.test(handler),
  'no booking_beds mutation');
check(!/booking_service_records/.test(handler),
  'no booking_service_records mutation');
check(!/database\/migrations|run-sql\.js/.test(handler), 'no migrations in handler');
check(/no_whatsapp:\s*true/.test(handler) && /n8n_called:\s*false/.test(handler),
  'response flags no WhatsApp/n8n');
check(/send_mutation:\s*false/.test(handler), 'send_mutation false');

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
