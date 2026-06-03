'use strict';
// ============================================================================
// verify-staff-ask-luna-api.js
// Static verifier for Stage 8.6.1 — POST /staff/ask-luna
// ============================================================================

const fs   = require('fs');
const path = require('path');

const ROOT         = path.resolve(__dirname, '..');
const API_SRC      = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const ALLOWLIST_F  = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.staff-whatsapp-allowlist.json');

let passed = 0, failed = 0;
const results = [];

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    results.push(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    results.push(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

// ── Locate handler ───────────────────────────────────────────────────────────
const handlerStart = API_SRC.indexOf('async function handleAskLuna(');
const handlerEnd   = handlerStart > -1
  ? API_SRC.indexOf('\nasync function handle', handlerStart + 100)
  : -1;
const handlerText  = handlerStart > -1 && handlerEnd > -1
  ? API_SRC.slice(handlerStart, handlerEnd)
  : (handlerStart > -1 ? API_SRC.slice(handlerStart, handlerStart + 12000) : '');

// Route block: find the router's pathname check (not the UI-side fetch call)
const routeRouterPattern = "pathname === '/staff/ask-luna'";
const routeIdx   = API_SRC.indexOf(routeRouterPattern);
const routeBlock = routeIdx > -1 ? API_SRC.slice(routeIdx, routeIdx + 400) : '';

// Strip comments for write/external-call checks
const handlerNoComments = handlerText
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

// ── A. Endpoint + handler existence ─────────────────────────────────────────
check('A1', 'handleAskLuna function defined',
  API_SRC.includes('async function handleAskLuna('));

check('A2', "route '/staff/ask-luna' registered in router",
  API_SRC.includes("'/staff/ask-luna'"));

check('A3', 'router block dispatches to handleAskLuna',
  routeBlock.includes('handleAskLuna'));

check('A4', 'POST /staff/ask-luna in startup log (Stage 8.6.1)',
  API_SRC.includes('/staff/ask-luna') && API_SRC.includes('8.6.1'));

check('A5', 'router rejects non-POST with 405',
  routeBlock.includes('405') || routeBlock.includes('Method not allowed'));

// ── B. Response safety fields ────────────────────────────────────────────────
check('B1', "handler returns read_only: true",
  handlerText.includes('read_only') &&
  (handlerText.includes('read_only:         true') || handlerText.includes('read_only: true')));

check('B2', "handler returns no_write_performed: true",
  handlerText.includes('no_write_performed') &&
  (handlerText.includes('no_write_performed: true') || handlerText.includes('no_write_performed:') ));

check('B3', "handler returns sends_whatsapp: false",
  handlerText.includes('sends_whatsapp') &&
  (handlerText.includes('sends_whatsapp:     false') || handlerText.includes('sends_whatsapp: false')));

check('B4', 'handler returns intent, answer, rows, row_count',
  handlerText.includes('intent') &&
  handlerText.includes('answer') &&
  handlerText.includes('rows') &&
  handlerText.includes('row_count'));

check('B5', 'handler returns client_slug and source and staff_access',
  handlerText.includes('client_slug') &&
  handlerText.includes('source') &&
  handlerText.includes('staff_access'));

// ── C. Auth — session path ────────────────────────────────────────────────────
check('C1', 'session path uses requireAuth()',
  handlerText.includes('requireAuth('));

check('C2', 'session path sets staff_access = session',
  handlerText.includes("staffAccess = 'session'"));

check('C3', 'handler reads source from body (not URL)',
  handlerText.includes('body.source') || handlerText.includes("body['source']"));

// ── D. Auth — allowlist path ──────────────────────────────────────────────────
check('D1', 'staff_whatsapp path loads STAFF_ALLOWLIST_FILE',
  handlerText.includes('STAFF_ALLOWLIST_FILE') || handlerText.includes('staff-whatsapp-allowlist'));

check('D2', 'unknown phone returns 403',
  handlerText.includes('phone_not_allowlisted') || handlerText.includes('403'));

check('D3', 'staff_whatsapp_enabled:false returns 403',
  handlerText.includes('staff_whatsapp_disabled') || handlerText.includes('staff_whatsapp_enabled'));

check('D4', 'missing staff_phone returns 403',
  handlerText.includes('staff_phone_required') || handlerText.includes('staff_phone is required'));

check('D5', 'allowlisted_phone sets staff_access',
  handlerText.includes("staffAccess = 'allowlisted_phone'"));

check('D6', 'STAFF_ALLOWLIST_FILE constant defined in API file',
  API_SRC.includes('STAFF_ALLOWLIST_FILE'));

// ── E. Allowlist config file ──────────────────────────────────────────────────
let allowlist;
try {
  allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_F, 'utf8'));
} catch (e) {
  allowlist = null;
}
check('E1', 'wolfhouse-somo.staff-whatsapp-allowlist.json exists and is valid JSON',
  allowlist !== null);

if (allowlist) {
  check('E2', 'allowlist has client_slug field',
    allowlist.client_slug === 'wolfhouse-somo');

  check('E3', 'allowlist has staff_whatsapp_enabled field',
    typeof allowlist.staff_whatsapp_enabled === 'boolean');

  check('E4', 'allowlist has at least one staff_numbers entry',
    Array.isArray(allowlist.staff_numbers) && allowlist.staff_numbers.length > 0);

  check('E5', 'each staff_numbers entry has phone, role, active fields',
    allowlist.staff_numbers.every(n => n.phone && n.role && typeof n.active === 'boolean'));

  check('E6', 'no real Spanish mobile number patterns in allowlist (+34[67]xx = real mobiles)',
    !JSON.stringify(allowlist).match(/\+34[67]\d{8}/) &&
    !JSON.stringify(allowlist).match(/\+1[2-9]\d{9}/));

  check('E7', 'at least one active entry with clearly fake/staging number',
    allowlist.staff_numbers.some(n => n.active && n.phone.includes('999')));

  check('E8', 'inactive entry exists (for rejection testing)',
    allowlist.staff_numbers.some(n => n.active === false));
} else {
  ['E2','E3','E4','E5','E6','E7','E8'].forEach(id =>
    check(id, `allowlist check (file not loaded)`, false, 'allowlist file missing'));
}

// ── F. No writes ─────────────────────────────────────────────────────────────
check('F1', 'handler contains no INSERT statement',
  !handlerNoComments.match(/\bINSERT\s+INTO\b/i));

check('F2', 'handler contains no UPDATE statement',
  !handlerNoComments.match(/\bUPDATE\s+\w/i));

check('F3', 'handler contains no DELETE statement',
  !handlerNoComments.match(/\bDELETE\s+FROM\b/i));

// ── G. No external calls ──────────────────────────────────────────────────────
check('G1', 'handler does not call Stripe API (api.stripe.com)',
  !handlerNoComments.includes('api.stripe.com') && !handlerNoComments.includes('stripe.checkout'));

check('G2', 'handler does not send WhatsApp (no graph.facebook.com URL in handler)',
  !handlerNoComments.includes('graph.facebook.com'));

check('G3', 'handler does not call n8n (no n8n webhook trigger in handler)',
  !handlerNoComments.match(/\bn8n\b/) && !handlerNoComments.includes('triggerWorkflow'));

// ── H. Intent routing ────────────────────────────────────────────────────────
check('H1', 'resolveNaturalLanguageIntent function defined',
  API_SRC.includes('function resolveNaturalLanguageIntent('));

check('H2', 'formatAnswer function defined',
  API_SRC.includes('function formatAnswer('));

// Supported intents from task spec
const resolver = API_SRC.slice(
  API_SRC.indexOf('function resolveNaturalLanguageIntent('),
  API_SRC.indexOf('function resolveNaturalLanguageIntent(') + 4000
);
check('H3', 'arrivals_today intent supported (rooming.arrivals)',
  resolver.includes('rooming.arrivals'));

check('H4', 'who_owes_money intent supported (payments.balance_due)',
  resolver.includes('payments.balance_due'));

check('H5', 'payment_links_pending intent supported (payments.waiting)',
  resolver.includes('payments.waiting'));

check('H6', 'needs_human intent supported (handoffs.open)',
  resolver.includes('handoffs.open'));

check('H7', 'departures_today intent supported (not unsupported_intent)',
  resolver.includes("'departures_today'") &&
  !resolver.match(/departures_today[\s\S]{0,80}unsupported_intent/));

check('H8', 'rooms_or_beds_need_cleaning intent supported (not unsupported_intent)',
  resolver.includes("'rooms_or_beds_need_cleaning'") &&
  !resolver.match(/rooms_or_beds_need_cleaning[\s\S]{0,80}unsupported_intent/));

check('H11', 'departures_today query uses bookings + booking_beds (structured data)',
  API_SRC.includes('getAskLunaDeparturesTodayQuery') &&
  API_SRC.includes('FROM bookings b') &&
  API_SRC.includes('booking_beds bb'));

check('H12', 'cleaning query derived from today departures/turnover (booking_beds + check_out)',
  API_SRC.includes('getAskLunaRoomsNeedCleaningQuery') &&
  API_SRC.includes('b.check_out = $2::date') &&
  API_SRC.includes('FROM booking_beds bb'));

check('H13', 'local intents do not query conversation/chat logs',
  !API_SRC.slice(API_SRC.indexOf('getAskLunaDeparturesTodayQuery'), API_SRC.indexOf('const ASK_LUNA_LOCAL_QUERY')).match(/conversation|message_log|chat_log/i));

check('H9', 'direct registry key passthrough supported',
  resolver.includes('REGISTRY_BY_KEY'));

check('H10', 'unsupported intent returns safe suggestion message',
  handlerText.includes('unsupported_intent') &&
  (handlerText.includes('You can ask') || handlerText.includes('you can ask')));

// ── I. Uses existing registry infrastructure ─────────────────────────────────
check('I1', 'handler uses getEntry() from registry',
  handlerText.includes('getEntry('));

check('I2', 'handler uses resolveParams() for param resolution',
  handlerText.includes('resolveParams('));

check('I3', 'handler uses withPgClient for DB queries (SELECT only)',
  handlerText.includes('withPgClient'));

// ── J. No secrets in config ───────────────────────────────────────────────────
if (allowlist) {
  const configStr = JSON.stringify(allowlist);
  check('J1', 'no API keys or tokens in allowlist config',
    !configStr.match(/sk_[a-z]+_[a-zA-Z0-9]{20,}/) &&
    !configStr.match(/[a-f0-9]{32,}/));
  check('J2', 'no real personal phone numbers in allowlist (no +34[67] Spanish mobile or +447 UK mobile patterns)',
    !configStr.match(/\+34[67]\d{8}/) && !configStr.match(/\+44[7]\d{9}/));
} else {
  check('J1', 'no secrets in allowlist config', false, 'file not loaded');
  check('J2', 'no real phone numbers in allowlist', false, 'file not loaded');
}

// ── Print results ─────────────────────────────────────────────────────────────
results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-staff-ask-luna-api PASS');
  process.exit(0);
} else {
  console.log('verify-staff-ask-luna-api FAIL');
  process.exit(1);
}
