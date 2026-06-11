/**
 * Stage 7.7b — Static verifier for conversation API endpoints in
 * scripts/staff-query-api.js.
 *
 * Checks (33 total):
 *   1:     staff-conversation-queries.js exists
 *   2:     staff-query-api.js exists
 *   3:     staff-query-api.js requires staff-conversation-queries
 *   4–9:   All 6 query helpers imported (destructured in require)
 *  10–15:  All 6 GET routes present in router
 *  16–21:  All 6 handler functions defined
 *  22:     Each conversation route calls requireAuth
 *  23:     Audit entries use intent prefix 'api:conversation.'
 *  24:     Audit entries use category 'conversation_api'
 *  25:     No POST / PATCH / DELETE routes for /staff/conversations
 *  26:     No 'approve-send' or 'approve_send' reference in conversation handlers
 *  27:     No 'staff-reply' write route (POST .../staff-reply)
 *  28:     No 'takeover' write route (POST .../takeover)
 *  29:     No writes to bookings table in conversation handlers
 *  30:     No writes to payments table in conversation handlers
 *  31:     No writes to booking_beds table in conversation handlers
 *  32:     CONV_ID_RE and CONV_SUB_RE route regexes defined
 *  33:     /staff/conversations inbox route wired (GET)
 *
 * Usage:
 *   node scripts/verify-staff-conversation-api.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const QUERIES_FILE = path.join(__dirname, 'lib', 'staff-conversation-queries.js');
const API_FILE     = path.join(__dirname, 'staff-query-api.js');

let passes = 0;
let failures = 0;

function ok(msg) {
  console.log(`  PASS  ${msg}`);
  passes++;
}

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  failures++;
}

function check(condition, msgPass, msgFail) {
  if (condition) ok(msgPass); else fail(msgFail || msgPass);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\nverify-staff-conversation-api.js\n');

// Check 1
check(fs.existsSync(QUERIES_FILE), 'staff-conversation-queries.js exists');

// Check 2
if (!fs.existsSync(API_FILE)) {
  fail('staff-query-api.js exists');
  process.exit(1);
}
ok('staff-query-api.js exists');

const src = fs.readFileSync(API_FILE, 'utf8');

// Check 3: requires staff-conversation-queries
check(/require\s*\(\s*['"]\.\/lib\/staff-conversation-queries['"]\s*\)/.test(src),
  "staff-query-api.js requires './lib/staff-conversation-queries'");

// Checks 4–9: Each query helper destructured in require
const IMPORTS = [
  'getConversationInboxQuery',
  'getConversationDetailQuery',
  'getConversationMessagesQuery',
  'getConversationContextQuery',
  'getConversationBookingsQuery',
  'getConversationDraftQuery',
  'getConversationStaffStateQuery',
];
for (const name of IMPORTS) {
  check(src.includes(name),
    `Query helper imported/referenced: ${name}`);
}

// Checks 10–15: GET routes present in router
const ROUTES = [
  { label: "GET /staff/conversations (inbox)",       pattern: /\/staff\/conversations/ },
  { label: "GET /staff/conversations/:id (detail)",  pattern: /CONV_ID_RE/ },
  { label: "GET /staff/conversations/:id/messages",  pattern: /['"]messages['"]/ },
  { label: "GET /staff/conversations/:id/context",   pattern: /['"]context['"]/ },
  { label: "GET /staff/conversations/:id/draft",     pattern: /['"]draft['"]/ },
  { label: "GET /staff/conversations/:id/staff-state", pattern: /['"]staff-state['"]/ },
];
for (const r of ROUTES) {
  check(r.pattern.test(src), `Route present: ${r.label}`);
}

// Checks 16–21: Handler functions defined
const HANDLERS = [
  'handleConversationInbox',
  'handleConversationDetail',
  'handleConversationMessages',
  'handleConversationContext',
  'handleConversationDraft',
  'handleConversationStaffState',
];
for (const h of HANDLERS) {
  check(src.includes(`async function ${h}`) || src.includes(`function ${h}`),
    `Handler function defined: ${h}`);
}

// Check 22: requireAuth called in conversation section
check(/requireAuth\s*\(req,\s*res,\s*['"]viewer['"]/.test(src),
  "requireAuth('viewer') called for conversation routes");

// Check 23: audit intent prefix 'api:conversation.'
check(/intent:\s*['"]api:conversation\./.test(src),
  "Audit intent prefix 'api:conversation.' used");

// Check 24: category 'conversation_api'
check(/category:\s*['"]conversation_api['"]/.test(src),
  "Audit category 'conversation_api' used");

// Check 25: Allowed write routes on /staff/conversations only
check(/CONV_CLEAR_RE/.test(src), 'CONV_CLEAR_RE route regex defined');
check(/handleConversationClearMessages/.test(src), 'handleConversationClearMessages defined');
check(/handleConversationDelete/.test(src), 'handleConversationDelete defined');
check(/deleteConversationHard/.test(src), 'deleteConversationHard helper used');
check(/clearConversationMessages/.test(src), 'clearConversationMessages helper used');
check(/needs-human/.test(src) && /clear-messages/.test(src),
  'needs-human and clear-messages POST routes present');
check(/method\s*===\s*['"]DELETE['"][\s\S]{0,120}handleConversationDelete/.test(src),
  'DELETE conversation route wired to handleConversationDelete');
check(/convDeleteMatch && method === 'DELETE'/.test(src),
  'DELETE conversation route registered before GET-only guard');
check(!/\/staff\/conversations\/.+\/staff-reply/.test(src),
  'No unauthorized /staff/conversations write sub-routes (staff-reply)');

// Check 26 (was 26): No approve-send reference in conversation handlers
check(!/approve.send|approve_send/.test(src.split('handleConversationInbox')[1] || ''),
  'No approve-send reference in conversation handler code');

// Check 27: No POST staff-reply write route
check(!/\/staff\/conversations\/.+\/staff-reply/.test(src),
  'No /staff/conversations/:id/staff-reply write route');

// Check 28: No takeover write route
check(!/\/staff\/conversations\/.+\/takeover/.test(src),
  'No /staff/conversations/:id/takeover write route');

// Checks 29–31: No booking/payment writes in conversation handler functions only
function extractHandlerBlock(name) {
  const start = src.indexOf(`async function ${name}`);
  if (start < 0) return '';
  const next = src.indexOf('\nasync function ', start + 1);
  return next > start ? src.slice(start, next) : src.slice(start, start + 8000);
}
const convHandlerNames = [
  'handleConversationInbox',
  'handleConversationDetail',
  'handleConversationMessages',
  'handleConversationContext',
  'handleConversationDraft',
  'handleConversationStaffState',
  'handleConversationNeedsHuman',
  'handleConversationClearMessages',
  'handleConversationDelete',
];
const convHandlersOnly = convHandlerNames.map(extractHandlerBlock).join('\n');
check(!/UPDATE\s+bookings/i.test(convHandlersOnly),
  'No UPDATE bookings in conversation handlers');
check(!/UPDATE\s+payments/i.test(convHandlersOnly),
  'No UPDATE payments in conversation handlers');
check(!/UPDATE\s+booking_beds/i.test(convHandlersOnly),
  'No UPDATE booking_beds in conversation handlers');

// Check 32: Route regexes defined
check(/const CONV_ID_RE/.test(src) && /const CONV_SUB_RE/.test(src),
  'CONV_ID_RE and CONV_SUB_RE route regexes defined');

// Check 33: Inbox route wired in router
check(/pathname\s*===\s*['"]\/staff\/conversations['"]/.test(src),
  "Inbox route ('/staff/conversations') wired in router");

const ctxHandler = extractHandlerBlock('handleConversationContext');
check(/getConversationBookingsQuery/.test(ctxHandler),
  'Context handler loads guest bookings query');
check(/filterActiveInboxBookings/.test(ctxHandler) && /bookings:\s*activeBookings/.test(ctxHandler),
  'Context handler returns filtered active bookings array');

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nResult: ${passes} passed, ${failures} failed\n`);
if (failures > 0) process.exit(1);
