/**
 * Phase 11j — Verifier for Staff Ask Luna handoff / needs-human queries.
 *
 * Usage:
 *   npm run verify:staff-ask-luna-handoffs
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const HO_FILE = path.join(__dirname, 'lib', 'staff-ask-luna-handoffs.js');
const HQ_FILE = path.join(__dirname, 'lib', 'staff-handoff-queries.js');
const REG_FILE = path.join(__dirname, 'lib', 'staff-query-registry.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-handoffs.js  (Phase 11j)\n');

for (const f of [API_FILE, HO_FILE, HQ_FILE, REG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const hoSrc = fs.readFileSync(HO_FILE, 'utf8');
const hqSrc = fs.readFileSync(HQ_FILE, 'utf8');
const regSrc = fs.readFileSync(REG_FILE, 'utf8');
const pkg    = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${HO_FILE}"`, { stdio: 'ignore' });
  ok('staff-ask-luna-handoffs.js passes node --check');
} catch (_) {
  fail('staff-ask-luna-handoffs.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-handoffs']
    === 'node scripts/verify-staff-ask-luna-handoffs.js',
  'package.json verify script',
);

console.log('\nA. Registry');
check(regSrc.includes("'handoffs.open'"), 'registry: handoffs.open');
check(regSrc.includes("'handoffs.urgent'"), 'registry: handoffs.urgent');

console.log('\nB. Query — structured handoff state, no chat logs');

check(hoSrc.includes('getOpenHandoffsQuery'), 'uses getOpenHandoffsQuery');
check(hoSrc.includes('getHighPriorityHandoffsQuery'), 'uses getHighPriorityHandoffsQuery');
check(hoSrc.includes('getNeedsHumanWithoutOpenHandoffQuery'), 'merges needs_human conversations');
check(hqSrc.includes('staff_handoffs'), 'handoff-queries: staff_handoffs table');
check(hqSrc.includes('conv.needs_human = TRUE'), 'handoff-queries: conversations.needs_human flag');
check(
  hqSrc.includes("h.status IN ('open', 'assigned', 'waiting_guest')"),
  'open handoffs exclude resolved/cancelled',
);
check(
  hqSrc.includes("h.priority IN ('high', 'urgent')"),
  'urgent handoffs use real priority field',
);
check(!hoSrc.match(/FROM\s+messages|chat_transcript|message_text/i), 'no chat log queries in handoffs lib');
check(!hoSrc.match(/\b(INSERT|UPDATE|DELETE)\b/i), 'no write SQL in handoffs lib');
check(!hoSrc.match(/stripe|whatsapp|n8n|deploy|migration/i), 'handoffs lib has no Stripe/WhatsApp/n8n/deploy');

console.log('\nC. Ask Luna wiring');

check(apiSrc.includes('resolveAskLunaHandoffsIntentKey'), 'API uses handoffs resolver');
check(apiSrc.includes('handoffsIntentEarly'), 'resolved before cleaning/arrivals fallbacks');
check(apiSrc.includes('fetchAskLunaHandoffRows'), 'handler fetches merged handoff rows');
check(apiSrc.includes('formatAskLunaHandoffsAnswer'), 'formatAnswer uses handoffs formatter');
check(
  apiSrc.includes("intentKey === 'handoffs.open' || intentKey === 'handoffs.urgent'"),
  'dedicated handoffs handler branch',
);
check(
  apiSrc.includes('No conversations are currently waiting for staff.'),
  'empty open handoffs message',
);
check(
  apiSrc.includes('No urgent handoffs are currently open.'),
  'empty urgent handoffs message',
);

console.log('\nD. Phrase routing');

const {
  resolveAskLunaHandoffsIntentKey,
  fetchAskLunaHandoffRows,
  formatAskLunaHandoffsAnswer,
  normalizeHandoffRow,
  getAskLunaHandoffsQuerySourceCheck,
  OPEN_KEY,
  URGENT_KEY,
} = require('./lib/staff-ask-luna-handoffs');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const PHRASES_OPEN = [
  ['Who needs human reply?', OPEN_KEY],
  ['Who needs staff reply?', OPEN_KEY],
  ['Which conversations are waiting on staff?', OPEN_KEY],
  ['Show open handoffs', OPEN_KEY],
  ['Who needs help?', OPEN_KEY],
  ['Which guests need a human?', OPEN_KEY],
  ['Any conversations stuck?', OPEN_KEY],
  ['handoffs.open', OPEN_KEY],
];

const PHRASES_URGENT = [
  ['Any urgent handoffs?', URGENT_KEY],
  ['handoffs.urgent', URGENT_KEY],
];

for (const [phrase, expected] of PHRASES_OPEN) {
  const got = resolveAskLunaHandoffsIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
}

for (const [phrase, expected] of PHRASES_URGENT) {
  const got = resolveAskLunaHandoffsIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expected, `routes "${phrase}" → ${expected}`);
}

const urgentWins = resolveAskLunaHandoffsIntentKey('Any urgent handoffs waiting on staff?', REGISTRY_BY_KEY);
check(urgentWins && urgentWins.intentKey === URGENT_KEY, 'urgent phrase wins over open topic');

console.log('\nE. Formatter output');

const REF = new Date('2026-06-04T14:00:00Z');
const sampleRows = [
  normalizeHandoffRow({
    guest_name: 'Jimmy',
    booking_code: 'WH-260615-ABCD',
    reason_code: 'payment_claimed',
    summary: 'payment question',
    priority: 'high',
    opened_at: '2026-06-04T14:32:00Z',
    check_in: '2026-06-15',
    check_out: '2026-06-20',
    conversation_id: '11111111-1111-1111-1111-111111111111',
  }, 'handoff'),
  normalizeHandoffRow({
    guest_name: 'Anna',
    conversation_stage: 'human_handoff',
    pending_action: 'cancellation_request',
    updated_at: '2026-06-03T18:10:00Z',
    conversation_id: '22222222-2222-2222-2222-222222222222',
  }, 'needs_human'),
];

const openAnswer = formatAskLunaHandoffsAnswer(OPEN_KEY, sampleRows, { refDate: REF });
check(openAnswer.includes('2 conversations waiting'), 'open answer includes total headline');
check(openAnswer.includes('Jimmy'), 'open answer includes guest name');
check(openAnswer.includes('WH-260615-ABCD'), 'open answer includes booking code');
check(openAnswer.includes('payment question'), 'open answer includes reason/summary');
check(openAnswer.includes('Anna'), 'open answer includes second guest');
check(openAnswer.includes('no linked booking'), 'open answer notes missing booking');
check(openAnswer.includes('Total: 2 open handoffs'), 'open answer includes total footer');

const urgentAnswer = formatAskLunaHandoffsAnswer(URGENT_KEY, [sampleRows[0]], { refDate: REF });
check(urgentAnswer.includes('1 urgent handoff'), 'urgent answer headline');
check(urgentAnswer.includes('priority high'), 'urgent answer shows priority when present');

const emptyOpen = formatAskLunaHandoffsAnswer(OPEN_KEY, []);
check(
  emptyOpen === 'No conversations are currently waiting for staff.',
  'empty open handoffs message',
);
const emptyUrgent = formatAskLunaHandoffsAnswer(URGENT_KEY, []);
check(
  emptyUrgent === 'No urgent handoffs are currently open.',
  'empty urgent handoffs message',
);

console.log('\nF. Query source checks');

const qcheck = getAskLunaHandoffsQuerySourceCheck();
check(qcheck.usesStaffHandoffs, 'SQL source uses staff_handoffs');
check(qcheck.usesHighPriority, 'urgent SQL filters high/urgent priority');
check(qcheck.excludesResolved, 'open SQL excludes resolved statuses');
check(qcheck.usesNeedsHumanFlag, 'needs_human uses structured flag');
check(qcheck.noMessagesTable, 'no messages table in open handoff query');

console.log('\nG. Safety — fetchAskLunaHandoffRows is read-only');

check(
  typeof fetchAskLunaHandoffRows === 'function'
    && fetchAskLunaHandoffRows.toString().includes('pg.query'),
  'fetch uses SELECT via pg.query only',
);
check(
  !fetchAskLunaHandoffRows.toString().match(/\b(INSERT|UPDATE|DELETE)\b/i),
  'fetch helper has no writes',
);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
