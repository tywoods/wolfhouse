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
const resolverStart = API_SRC.indexOf('function resolveNaturalLanguageIntent(');
const resolverEnd   = API_SRC.indexOf('\nfunction formatAnswer', resolverStart);
const resolver      = resolverStart > -1
  ? API_SRC.slice(resolverStart, resolverEnd > -1 ? resolverEnd : resolverStart + 12000)
  : '';
check('H3', 'arrivals_today intent supported (rooming.arrivals)',
  resolver.includes('rooming.arrivals'));

check('H4', 'who_owes_money intent supported (payments.balance_due)',
  resolver.includes('resolveBalanceDueIntentKey') && resolver.includes('balanceDueIntent'));

check('H5', 'payment_links_pending intent supported (payments.waiting)',
  resolver.includes('payments.waiting'));

check('H6', 'handoffs resolver wired (handoffs.open)',
  resolver.includes('resolveAskLunaHandoffsIntentKey') && resolver.includes('handoffsIntentEarly'));

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

check('H12', 'cleaning query derived from checkout turnover (booking_beds + check_out)',
  (API_SRC.includes('getAskLunaCleaningOnDateQuery') || API_SRC.includes('getAskLunaRoomsNeedCleaningQuery')) &&
  API_SRC.includes('b.check_out = $2::date') &&
  API_SRC.includes('booking_beds'));

check('H13', 'local intents do not query conversation/chat logs',
  !API_SRC.slice(API_SRC.indexOf('getAskLunaDeparturesTodayQuery'), API_SRC.indexOf('const ASK_LUNA_LOCAL_QUERY')).match(/conversation|message_log|chat_log/i));

check('H9', 'direct registry key passthrough supported',
  resolver.includes('REGISTRY_BY_KEY'));

check('H10', 'unsupported intent returns safe suggestion message',
  handlerText.includes('unsupported_intent') &&
  (handlerText.includes('You can ask') || handlerText.includes('you can ask')));

// ── K. Stage 8.8.2 — date-aware arrivals/departures ─────────────────────────
check('K1', 'resolveAskLunaDatePhrase function defined',
  API_SRC.includes('function resolveAskLunaDatePhrase('));

check('K2', 'getAskLunaCheckInsOnDateQuery defined (bookings.check_in)',
  API_SRC.includes('function getAskLunaCheckInsOnDateQuery(') &&
  API_SRC.includes('b.check_in = $2::date'));

check('K3', 'getAskLunaCheckOutsOnDateQuery defined (bookings.check_out)',
  API_SRC.includes('function getAskLunaCheckOutsOnDateQuery(') &&
  API_SRC.includes('b.check_out = $2::date'));

check('K4', 'check_ins.on_date local intent registered',
  API_SRC.includes("'check_ins.on_date'"));

check('K5', 'check_ins.count local intent registered',
  API_SRC.includes("'check_ins.count'"));

check('K6', 'check_outs.on_date local intent registered',
  API_SRC.includes("'check_outs.on_date'"));

check('K7', 'check_outs.count local intent registered',
  API_SRC.includes("'check_outs.count'"));

check('K8', 'date resolver treats tonight as today',
  API_SRC.includes('tonight') && API_SRC.includes("label: 'today'"));

check('K9', 'date resolver handles tomorrow',
  API_SRC.includes('tomorrow') && API_SRC.includes("label: 'tomorrow'"));

check('K10', 'date resolver handles weekday names (Saturday)',
  API_SRC.includes('ASK_LUNA_WEEKDAYS') && API_SRC.includes('saturday'));

check('K11', 'date resolver handles named month/day (June/Jun)',
  API_SRC.includes('ASK_LUNA_MONTHS') && API_SRC.includes('june:'));

check('K12', 'isBlockedAddOnServiceQuestion defined',
  API_SRC.includes('function isBlockedAddOnServiceQuestion('));

check('K13', 'service record router resolves yoga/meals/lessons/rentals (8.8.11)',
  API_SRC.includes('resolveAskLunaServiceIntent') &&
  API_SRC.includes("'services.yoga.paid_on_date'") &&
  API_SRC.includes("'services.wetsuit.count_on_date'"));

check('K13b', 'unmatched service keywords still return unsupported_intent',
  resolver.includes('isBlockedAddOnServiceQuestion') &&
  resolver.includes("'unsupported_intent'"));

check('K14', 'formatAnswer empty state for check-ins (No guests are checking in)',
  API_SRC.includes("'check_ins.on_date'") &&
  API_SRC.includes('No guests are checking in'));

check('K15', 'formatAnswer count-first for check_ins.count',
  API_SRC.includes("case 'check_ins.count'") &&
  API_SRC.includes('askLunaTotalGuestCount'));

check('K16', 'formatAnswer count-first for check_outs.count',
  API_SRC.includes("case 'check_outs.count'"));

check('K17', 'local handler returns query_date on date intents',
  handlerText.includes('query_date'));

check('K18', 'new arrival/departure queries do not use conversation/chat logs',
  !API_SRC.slice(
    API_SRC.indexOf('function getAskLunaCheckInsOnDateQuery'),
    API_SRC.indexOf('function resolveNaturalLanguageIntent')
  ).match(/conversation|message_log|chat_log/i));

// Extract Ask Luna router chunk (Stage 8.8.4 — includes normalize + i18n helpers)
function extractAskLunaRouterChunk() {
  const start = API_SRC.indexOf('function normalizeAskLunaQuestion');
  const localQueryStart = API_SRC.indexOf('const ASK_LUNA_LOCAL_QUERY', start);
  const resolverStart = API_SRC.indexOf('function resolveNaturalLanguageIntent(', start);
  const end = API_SRC.indexOf('\nfunction formatAnswer', start);
  if (start < 0 || localQueryStart < 0 || resolverStart < 0 || end < 0) return null;
  const constants = [
    API_SRC.match(/const ASK_LUNA_WEEKDAYS = [^;]+;/)?.[0],
    API_SRC.match(/const ASK_LUNA_MONTHS = \{[\s\S]*?\};/)?.[0],
    API_SRC.match(/function askLunaIsoDateUTC[\s\S]*?\n\}/)?.[0],
    API_SRC.match(/function askLunaTodayUTC[\s\S]*?\n\}/)?.[0],
  ].filter(Boolean).join('\n');
  const helpers = API_SRC.slice(start, localQueryStart);
  const resolver = API_SRC.slice(resolverStart, end);
  return `${constants}\n${helpers}${resolver}`;
}

// Runtime smoke: date resolver (pure functions extracted from API source)
(function runAskLunaDateResolverSmoke() {
  try {
    const chunk = extractAskLunaRouterChunk();
    if (!chunk) throw new Error('could not extract Ask Luna router chunk');
    const resolveFn = new Function(`${chunk}; return resolveAskLunaDatePhrase;`)();
    const ref = new Date('2026-06-03T12:00:00.000Z'); // Tuesday
    const tonight = resolveFn('who checks in tonight', ref);
    const tomorrow = resolveFn('check in tomorrow', ref);
    const saturday = resolveFn('checking in on Saturday', ref);
    const june15 = resolveFn('check in June 15', ref);
    const iso = resolveFn('arrivals on 2026-07-04', ref);
    check('K-R1', 'runtime: tonight → today label', tonight && tonight.label === 'today');
    check('K-R2', 'runtime: tomorrow → 2026-06-04', tomorrow && tomorrow.date === '2026-06-04');
    check('K-R3', 'runtime: Saturday from Tue → 2026-06-06', saturday && saturday.date === '2026-06-06');
    check('K-R4', 'runtime: June 15 → 2026-06-15', june15 && june15.date === '2026-06-15');
    check('K-R5', 'runtime: ISO date passthrough', iso && iso.date === '2026-07-04');
    const satToday = new Date('2026-06-06T12:00:00.000Z');
    const satSame = resolveFn('check out on Saturday', satToday);
    check('K-R6', 'runtime: Saturday when today is Saturday → today', satSame && satSame.date === '2026-06-06' && satSame.label === 'saturday');
    const hoy = resolveFn('Quien sale hoy?', ref);
    const manana = resolveFn('check out manana', ref);
    check('K-R7', 'runtime: hoy → today label (es)', hoy && hoy.label === 'today' && hoy.date === '2026-06-03');
    check('K-R8', 'runtime: manana → tomorrow (es)', manana && manana.label === 'tomorrow' && manana.date === '2026-06-04');
  } catch (e) {
    check('K-R1', 'runtime date resolver smoke', false, e.message);
    ['K-R2', 'K-R3', 'K-R4', 'K-R5', 'K-R6', 'K-R7', 'K-R8'].forEach(id =>
      check(id, 'runtime date resolver smoke (skipped)', false, e.message));
  }
})();

// Runtime smoke: intent routing samples
(function runAskLunaIntentRoutingSmoke() {
  try {
    const chunk = extractAskLunaRouterChunk();
    if (!chunk) throw new Error('could not extract Ask Luna router chunk');
    const balanceDueLib = require('./lib/staff-ask-luna-balance-due');
    const lessonsLib = require('./lib/staff-ask-luna-lessons');
    const gearLib = require('./lib/staff-ask-luna-gear');
    const mealsYogaLib = require('./lib/staff-ask-luna-meals-yoga');
    const arrivalsLib = require('./lib/staff-ask-luna-arrivals-checkouts');
    const cleaningLib = require('./lib/staff-ask-luna-cleaning');
    const bookingLookupLib = require('./lib/staff-ask-luna-booking-lookup');
    const handoffsLib = require('./lib/staff-ask-luna-handoffs');
    const lessonsRoutingBlock = lessonsLib.getAskLunaLessonsRoutingSmokeBlock();
    const gearRoutingBlock = gearLib.getAskLunaGearRoutingSmokeBlock();
    const mealsYogaRoutingBlock = mealsYogaLib.getAskLunaMealsYogaRoutingSmokeBlock();
    const arrivalsRoutingBlock = arrivalsLib.getAskLunaArrivalsCheckoutsRoutingSmokeBlock();
    const cleaningRoutingBlock = cleaningLib.getAskLunaCleaningRoutingSmokeBlock();
    const bookingLookupRoutingBlock = bookingLookupLib.getAskLunaBookingLookupRoutingSmokeBlock();
    const handoffsRoutingBlock = handoffsLib.getAskLunaHandoffsRoutingSmokeBlock();
    const registryKeys = [...require('./lib/staff-query-registry').REGISTRY_BY_KEY.keys()];
    const wrapped = `
      const matchesBalanceDueQuestion = ${balanceDueLib.matchesBalanceDueQuestion.toString()};
      const normalizeBalanceDueQuestionText = ${balanceDueLib.normalizeBalanceDueQuestionText.toString()};
      const resolveBalanceDueIntentKey = ${balanceDueLib.resolveBalanceDueIntentKey.toString()};
      ${lessonsRoutingBlock}
      ${gearRoutingBlock}
      ${mealsYogaRoutingBlock}
      ${arrivalsRoutingBlock}
      ${cleaningRoutingBlock}
      ${bookingLookupRoutingBlock}
      ${handoffsRoutingBlock}
      const BALANCE_DUE_INTENT_KEY = 'payments.balance_due';
      const require = (id) => {
        if (String(id).includes('staff-query-registry')) {
          const keys = ${JSON.stringify(registryKeys)};
          return { REGISTRY_BY_KEY: new Map(keys.map((k) => [k, k])) };
        }
        if (String(id).includes('staff-ask-luna-balance-due')) {
          return { matchesBalanceDueQuestion, normalizeBalanceDueQuestionText, resolveBalanceDueIntentKey, BALANCE_DUE_INTENT_KEY };
        }
        if (String(id).includes('staff-ask-luna-lessons')) {
          return { resolveAskLunaLessonsIntentKey };
        }
        if (String(id).includes('staff-ask-luna-gear')) {
          return { resolveAskLunaGearIntentKey };
        }
        if (String(id).includes('staff-ask-luna-meals-yoga')) {
          return { resolveAskLunaMealsYogaIntentKey };
        }
        if (String(id).includes('staff-ask-luna-arrivals-checkouts')) {
          return { resolveAskLunaArrivalsCheckoutsIntentKey };
        }
        if (String(id).includes('staff-ask-luna-cleaning')) {
          return { resolveAskLunaCleaningIntentKey };
        }
        if (String(id).includes('staff-ask-luna-booking-lookup')) {
          return { resolveAskLunaBookingLookupIntentKey };
        }
        if (String(id).includes('staff-ask-luna-handoffs')) {
          return { resolveAskLunaHandoffsIntentKey };
        }
        throw new Error('unexpected require: ' + id);
      };
      ${chunk}
      return resolveNaturalLanguageIntent;
    `;
    const resolveIntent = new Function(wrapped)();
    const ciTomorrow = resolveIntent('Who is checking in tomorrow');
    const coCount = resolveIntent('How many people are checking out tomorrow');
    const coSat = resolveIntent('How many people are checking out on Saturday');
    const yoga = resolveIntent('Who paid for yoga tonight');
    check('K-I1', 'runtime: who checking in tomorrow → bookings.arrivals_tomorrow',
      ciTomorrow && ciTomorrow.intentKey === 'bookings.arrivals_tomorrow' && ciTomorrow.extraParams.dateLabel === 'tomorrow');
    check('K-I2', 'runtime: checkout count tomorrow → bookings.checkouts_tomorrow',
      coCount && coCount.intentKey === 'bookings.checkouts_tomorrow');
    check('K-I3', 'runtime: checkout count Saturday → bookings.checkouts_on_date',
      coSat && coSat.intentKey === 'bookings.checkouts_on_date' && coSat.extraParams.dateLabel === 'saturday');
    check('K-I4', 'runtime: yoga paid tonight → services.yoga_today',
      yoga && yoga.intentKey === 'services.yoga_today' && yoga.extraParams.dateLabel === 'today');
    const mealPaid = resolveIntent('Who paid for meals tomorrow');
    const lesson = resolveIntent('Who has a lesson today');
    const wetsuit = resolveIntent('Who needs a wetsuit today');
    const wetsuitCount = resolveIntent('How many wetsuits do we need ready today');
    const board = resolveIntent('Who needs a surfboard tomorrow');
    const boardCount = resolveIntent('How many surfboards do we need on June 15');
    check('K-I4b', 'runtime: meal paid tomorrow → services.meals_tomorrow',
      mealPaid && mealPaid.intentKey === 'services.meals_tomorrow' && mealPaid.extraParams.dateLabel === 'tomorrow');
    check('K-I4c', 'runtime: lesson today → services.lessons_today',
      lesson && lesson.intentKey === 'services.lessons_today' && lesson.extraParams.dateLabel === 'today');
    check('K-I4d', 'runtime: wetsuit who today → services.gear_today',
      wetsuit && wetsuit.intentKey === 'services.gear_today' && wetsuit.extraParams.dateLabel === 'today');
    check('K-I4e', 'runtime: wetsuit count today → services.gear_today',
      wetsuitCount && wetsuitCount.intentKey === 'services.gear_today');
    check('K-I4f', 'runtime: surfboard who tomorrow → services.gear_tomorrow',
      board && board.intentKey === 'services.gear_tomorrow' && board.extraParams.dateLabel === 'tomorrow');
    check('K-I4g', 'runtime: surfboard count June 15 → services.surfboard.count_on_date',
      boardCount && boardCount.intentKey === 'services.surfboard.count_on_date' && boardCount.extraParams.date === '2026-06-15');
    check('K-I5', 'runtime: who leaves today → bookings.checkouts_today',
      resolveIntent('Who leaves today').intentKey === 'bookings.checkouts_today');
    check('K-I6', 'runtime: cleaning contraction → housekeeping.cleaning_today',
      resolveIntent("who's room needs to be cleaned?").intentKey === 'housekeeping.cleaning_today');
    check('K-I7', 'runtime: Quien sale hoy → bookings.checkouts_today',
      resolveIntent('Quien sale hoy?').intentKey === 'bookings.checkouts_today');
    check('K-I8', 'runtime: ES cleaning → housekeeping.cleaning_today',
      resolveIntent('Cual cuartos tengo que limpiar hoy?').intentKey === 'housekeeping.cleaning_today');
    check('K-I9', 'runtime: IT checkout today → bookings.checkouts_today',
      resolveIntent('Chi parte oggi?').intentKey === 'bookings.checkouts_today');
    check('K-I10', 'runtime: DE cleaning → housekeeping.cleaning_today',
      resolveIntent('Welche Zimmer müssen heute gereinigt werden?').intentKey === 'housekeeping.cleaning_today');
    check('K-I11', 'runtime: FR checkout today → bookings.checkouts_today',
      resolveIntent("Qui part aujourd'hui?").intentKey === 'bookings.checkouts_today');
    check('K-I12', 'runtime: EN balance due → payments.balance_due',
      resolveIntent('Who still needs to pay?').intentKey === 'payments.balance_due');
    check('K-I13', 'runtime: ES balance due → payments.balance_due',
      resolveIntent('Quien debe pagar?').intentKey === 'payments.balance_due');
    check('K-I14', 'runtime: Outstanding balances → payments.balance_due',
      resolveIntent('Outstanding balances').intentKey === 'payments.balance_due');
    check('K-I15', 'runtime: Who has unpaid balance → payments.balance_due',
      resolveIntent('Who has unpaid balance?').intentKey === 'payments.balance_due');
    check('K-I16', 'runtime: registry key payments.balance_due → payments.balance_due',
      resolveIntent('payments.balance_due').intentKey === 'payments.balance_due');
    check('K-I17', 'runtime: unpaid balances → payments.balance_due',
      resolveIntent('unpaid balances').intentKey === 'payments.balance_due');
    check('K-I18', 'runtime: who needs human reply → handoffs.open',
      resolveIntent('Who needs human reply?').intentKey === 'handoffs.open');
    check('K-I19', 'runtime: any urgent handoffs → handoffs.urgent',
      resolveIntent('Any urgent handoffs?').intentKey === 'handoffs.urgent');
    check('K-I20', 'runtime: registry handoffs.open → handoffs.open',
      resolveIntent('handoffs.open').intentKey === 'handoffs.open');
  } catch (e) {
    check('K-I1', 'runtime intent routing smoke', false, e.message);
    ['K-I2', 'K-I3', 'K-I4', 'K-I4b', 'K-I4c', 'K-I4d', 'K-I4e', 'K-I4f', 'K-I4g', 'K-I5', 'K-I6', 'K-I7', 'K-I8', 'K-I9', 'K-I10', 'K-I11', 'K-I12', 'K-I13', 'K-I14', 'K-I15', 'K-I16', 'K-I17', 'K-I18', 'K-I19', 'K-I20']
      .forEach(id => check(id, 'runtime intent routing smoke (skipped)', false, e.message));
  }
})();

// ── L. Stage 8.8.4 — multilingual intent router ─────────────────────────────
const routerChunkStart = API_SRC.indexOf('function normalizeAskLunaQuestion');
const routerChunkEnd   = API_SRC.indexOf('\nfunction formatAnswer', routerChunkStart);
const routerChunk      = routerChunkStart > -1 && routerChunkEnd > routerChunkStart
  ? API_SRC.slice(routerChunkStart, routerChunkEnd)
  : '';
const askLunaScope     = handlerText + routerChunk;

check('L1', 'normalizeAskLunaQuestion defined',
  API_SRC.includes('function normalizeAskLunaQuestion('));

check('L2', 'normalizer strips accents (NFD)',
  routerChunk.includes(".normalize('NFD')"));

check('L3', 'multilingual checkout helper (askLunaMatchesCheckout)',
  routerChunk.includes('function askLunaMatchesCheckout(') &&
  routerChunk.includes('sale') && routerChunk.includes('parte') &&
  routerChunk.includes('abreise') && routerChunk.includes('part'));

check('L4', 'multilingual cleaning helper (askLunaMatchesCleaning)',
  routerChunk.includes('function askLunaMatchesCleaning(') &&
  routerChunk.includes('limpiar') && routerChunk.includes('gereinigt') &&
  routerChunk.includes('nettoyer'));

const balanceDueLibSrc = fs.readFileSync(path.join(__dirname, 'lib', 'staff-ask-luna-balance-due.js'), 'utf8');
check('L5', 'multilingual balance-due helper (askLunaMatchesBalanceDue + lib phrases)',
  routerChunk.includes('function askLunaMatchesBalanceDue(') &&
  routerChunk.includes('matchesBalanceDueQuestion') &&
  balanceDueLibSrc.includes('debe') && balanceDueLibSrc.includes('schuldet') &&
  balanceDueLibSrc.includes('doit'));

check('L6', 'multilingual today/tomorrow words in date resolver',
  routerChunk.includes('hoy') && routerChunk.includes('oggi') &&
  routerChunk.includes('heute') && routerChunk.includes('manana') &&
  routerChunk.includes('demain'));

check('L7', 'Ask Luna handler/router has no inline LLM API URLs (classifier in lib module)',
  !askLunaScope.match(/api\.openai\.com/i) &&
  !askLunaScope.match(/api\.anthropic\.com/i));
check('L7b', 'AI intent fallback wired via gated lib module',
  API_SRC.includes('staff-ask-luna-ai-intent') &&
  API_SRC.includes('classifyAskLunaIntentWithAi') &&
  API_SRC.includes('resolveAskLunaIntent'));

check('L8', 'no INSERT/UPDATE/DELETE in Ask Luna handler',
  !handlerNoComments.match(/\bINSERT\b/i) &&
  !handlerNoComments.match(/\bUPDATE\b/i) &&
  !handlerNoComments.match(/\bDELETE\b/i));

check('L9', 'no graph.facebook.com / n8n / Stripe in Ask Luna handler',
  !handlerNoComments.includes('graph.facebook.com') &&
  !handlerNoComments.match(/\bn8n\b/) &&
  !handlerNoComments.includes('api.stripe.com'));

// ── M. Stage 8.8.11 — service record queries ────────────────────────────────
const serviceQueryStart = API_SRC.indexOf('function getAskLunaServiceYogaPaidQuery');
const serviceQueryEnd   = API_SRC.indexOf('const ASK_LUNA_WEEKDAYS', serviceQueryStart);
const serviceQueryBlock = serviceQueryStart > -1 && serviceQueryEnd > serviceQueryStart
  ? API_SRC.slice(serviceQueryStart, serviceQueryEnd)
  : '';

check('M1', 'getAskLunaServiceYogaPaidQuery uses booking_service_records',
  serviceQueryBlock.includes('FROM booking_service_records') &&
  serviceQueryBlock.includes("service_type = 'yoga'") &&
  serviceQueryBlock.includes("payment_status = 'paid'"));

check('M2', 'getAskLunaServiceMealPaidQuery uses booking_service_records',
  API_SRC.includes('function getAskLunaServiceMealPaidQuery') &&
  serviceQueryBlock.includes("service_type = 'meal'"));

check('M3', 'getAskLunaServiceSurfLessonQuery filters non-cancelled statuses',
  API_SRC.includes('function getAskLunaServiceSurfLessonQuery') &&
  serviceQueryBlock.includes("service_type = 'surf_lesson'") &&
  serviceQueryBlock.includes("'requested', 'confirmed', 'paid'"));

check('M4', 'wetsuit/surfboard who queries exclude cancelled',
  serviceQueryBlock.includes("status <> 'cancelled'"));

check('M5', 'wetsuit/surfboard count queries SUM(quantity)',
  serviceQueryBlock.includes('SUM(quantity)') &&
  API_SRC.includes('getAskLunaServiceWetsuitCountQuery') &&
  API_SRC.includes('getAskLunaServiceSurfboardCountQuery'));

check('M6', 'service intents registered in ASK_LUNA_LOCAL_QUERY',
  API_SRC.includes("'services.yoga.paid_on_date'") &&
  API_SRC.includes("'services.meal.paid_on_date'") &&
  API_SRC.includes("'services.surf_lesson.on_date'") &&
  API_SRC.includes("'services.wetsuit.on_date'") &&
  API_SRC.includes("'services.surfboard.on_date'") &&
  API_SRC.includes("'services.wetsuit.count_on_date'") &&
  API_SRC.includes("'services.surfboard.count_on_date'"));

check('M7', 'service router English patterns (paid for yoga, how many wetsuits)',
  routerChunk.includes('askLunaMatchesServiceYogaPaid') &&
  routerChunk.includes('paid for') &&
  routerChunk.includes('askLunaMatchesServiceWetsuit'));

check('M8', 'service SQL returns required row fields',
  serviceQueryBlock.includes('guest_name') &&
  serviceQueryBlock.includes('booking_code') &&
  serviceQueryBlock.includes('service_type') &&
  serviceQueryBlock.includes('service_date') &&
  serviceQueryBlock.includes('quantity') &&
  serviceQueryBlock.includes('payment_status') &&
  serviceQueryBlock.includes('amount_due_cents') &&
  serviceQueryBlock.includes('amount_paid_cents'));

check('M9', 'formatAnswer count-first for wetsuit/surfboard counts',
  API_SRC.includes("case 'services.wetsuit.count_on_date'") &&
  API_SRC.includes("case 'services.surfboard.count_on_date'") &&
  API_SRC.includes('needed ${when}'));

check('M10', 'service queries do not use conversation/chat logs',
  !serviceQueryBlock.match(/conversation|message_log|chat_log/i));

check('M11', 'no OpenAI/Anthropic/Claude/LLM in service query scope',
  !serviceQueryBlock.match(/\bopenai\b/i) &&
  !serviceQueryBlock.match(/\bllm\b/i));

check('M12', 'no INSERT/UPDATE/DELETE in service query SQL block',
  !serviceQueryBlock.match(/\bINSERT\b/i) &&
  !serviceQueryBlock.match(/\bUPDATE\b/i) &&
  !serviceQueryBlock.match(/\bDELETE\b/i));

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
