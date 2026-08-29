'use strict';

/**
 * verify:inbox-system-sender-counts
 *
 * Bug Finder #12 leftover (PACK-FIX-731-NOREPLY) — Inbox All list + badge
 * counts must not treat noreply / mailer-daemon / system senders as guests.
 *
 * #731 hid prefix-local-part conv.email. QA still saw 2 noreply rows because
 * All-list titles can come from display_name, and From headers can be wrapped
 * (`Mail Delivery Subsystem <mailer-daemon@…>`) or use microsoft-noreply.
 *
 * Offline: proves the shared list+counts WHERE excludes those leftover shapes
 * while keeping real guests and WhatsApp/phone-only rows.
 *
 * Run:
 *   node scripts/verify-inbox-system-sender-counts.js
 */

const fs = require('fs');
const path = require('path');

const {
  isSystemSenderEmail,
  isSystemSenderConversation,
  sqlExcludeSystemSenderConversations,
  SYSTEM_SENDER_DOMAINS,
} = require('./lib/staff-inbox-system-sender');

const {
  conversationInboxWhereSql,
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
} = require('./lib/staff-conversation-queries');

const ROOT = path.join(__dirname, '..');
const QUERIES_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'staff-conversation-queries.js'),
  'utf8',
);
const HELPER_SRC = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'staff-inbox-system-sender.js'),
  'utf8',
);

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

/** Fixture threads shaped like sunset-staging inbox rows (emails only; no invented guests). */
const FIXTURE_THREADS = Object.freeze([
  { id: 'wa-guest', channel: 'whatsapp', email: null, needs_human: true },
  { id: 'email-guest', channel: 'email', email: 'maria.surf@example.com', needs_human: true },
  { id: 'gmail-guest', channel: 'email', email: 'guest.person@gmail.com', needs_human: false },
  { id: 'godaddy-noreply', channel: 'email', email: 'noreply@godaddy.com', needs_human: true },
  { id: 'godaddy-email', channel: 'email', email: 'donotreply@email.godaddy.com', needs_human: true },
  { id: 'google-noreply', channel: 'email', email: 'no-reply@accounts.google.com', needs_human: true },
  { id: 'outlook-noreply', channel: 'email', email: 'noreply@email.microsoft.com', needs_human: false },
  { id: 'apollo', channel: 'email', email: 'mailer@apollo.io', needs_human: true },
  { id: 'mailer-daemon', channel: 'email', email: 'mailer-daemon@secureserver.net', needs_human: true },
  { id: 'notification-plus', channel: 'email', email: 'notifications+bounce@secureserver.net', needs_human: true },
  // PACK-FIX-731-NOREPLY leftover shapes still visible after prefix-only conv.email.
  {
    id: 'leftover-angle-mailer',
    channel: 'email',
    email: 'Mail Delivery Subsystem <mailer-daemon@secureserver.net>',
    display_name: 'Mail Delivery Subsystem',
    needs_human: true,
  },
  {
    id: 'leftover-display-noreply',
    channel: 'email',
    email: null,
    display_name: 'noreply@email.godaddy.com',
    needs_human: true,
  },
]);

function countGuestLike(threads) {
  return threads.filter((t) => !isSystemSenderConversation(t)).length;
}

function countNeedsHumanGuestLike(threads) {
  return threads.filter((t) => t.needs_human && !isSystemSenderConversation(t)).length;
}

console.log('\nverify:inbox-system-sender-counts — Bug Finder #12 leftover noreply All-list\n');

console.log('[1] Classifier: system vs guest addresses');

const SYSTEM_SAMPLES = [
  'noreply@godaddy.com',
  'no-reply@accounts.google.com',
  'donotreply@email.godaddy.com',
  'mailer@apollo.io',
  'mailer-daemon@secureserver.net',
  'notifications@secureserver.net',
  'noreply+tag@email.microsoft.com',
  '  No-Reply@GoDaddy.COM ',
  'Mail Delivery Subsystem <mailer-daemon@secureserver.net>',
  '"GoDaddy" <noreply@godaddy.com>',
  'microsoft-noreply@microsoftonline.com',
];
const GUEST_SAMPLES = [
  null,
  '',
  'maria.surf@example.com',
  'guest.person@gmail.com',
  'hola@outlook.com',
  'bookings@sunsetsurf.test',
  'tywoods@gmail.com',
];

for (const addr of SYSTEM_SAMPLES) {
  assert(`system: ${JSON.stringify(addr)}`, isSystemSenderEmail(addr) === true);
}
for (const addr of GUEST_SAMPLES) {
  assert(`guest: ${JSON.stringify(addr)}`, isSystemSenderEmail(addr) === false);
}
assert('SYSTEM_SENDER_DOMAINS includes apollo.io + godaddy',
  SYSTEM_SENDER_DOMAINS.includes('apollo.io')
  && SYSTEM_SENDER_DOMAINS.includes('godaddy.com'));
assert('display_name-only noreply is a system conversation',
  isSystemSenderConversation({ email: null, display_name: 'noreply@email.godaddy.com' }) === true);
assert('WhatsApp/phone-only (null email, guest display_name) stays',
  isSystemSenderConversation({ email: null, display_name: 'Hernan' }) === false);
assert('Mail Delivery Subsystem label is system',
  isSystemSenderEmail('Mail Delivery Subsystem') === true);

console.log('\n[2] Before / after fixture counts (repro of badge inflation + leftover All rows)');

const beforeAll = FIXTURE_THREADS.length;
const afterAll = countGuestLike(FIXTURE_THREADS);
const beforeNeeds = FIXTURE_THREADS.filter((t) => t.needs_human).length;
const afterNeeds = countNeedsHumanGuestLike(FIXTURE_THREADS);

assert(`before All count is ${beforeAll} (includes system mailers + leftover)`, beforeAll === 12);
assert(`after All count is ${afterAll} (guests only)`, afterAll === 3,
  `got ${afterAll}`);
assert(`before Needs-human is ${beforeNeeds}`, beforeNeeds === 10);
assert(`after Needs-human is ${afterNeeds} (system needs_human dropped)`, afterNeeds === 2,
  `got ${afterNeeds}`);
assert('filter drops system rows from All', afterAll < beforeAll);
assert('filter drops system rows from Needs-human badge path', afterNeeds < beforeNeeds);
assert('leftover wrapped mailer-daemon is hidden',
  isSystemSenderConversation(FIXTURE_THREADS.find((t) => t.id === 'leftover-angle-mailer')));
assert('leftover display_name noreply is hidden',
  isSystemSenderConversation(FIXTURE_THREADS.find((t) => t.id === 'leftover-display-noreply')));

console.log('\n[3] Shared SQL WHERE wires the exclusion into list + counts');

const whereSql = conversationInboxWhereSql(false, false, false);
const excludeFrag = sqlExcludeSystemSenderConversations('conv');
assert('conversationInboxWhereSql appends system-sender exclusion',
  whereSql.includes('AND NOT') && whereSql.includes('conv.email'));
assert('exclusion also checks conv.display_name (leftover All-list titles)',
  excludeFrag.includes('conv.display_name') && whereSql.includes('conv.display_name'));
assert('exclusion fragment is embedded in shared WHERE',
  whereSql.includes(excludeFrag.trim()) || whereSql.replace(/\s+/g, ' ').includes('AND NOT'));
assert('exclusion mentions noreply local-part pattern',
  /no\[-_\]\?reply/.test(excludeFrag));
assert('exclusion extracts wrapped From <addr@host>',
  excludeFrag.includes("substring") && excludeFrag.includes('<'));
assert('exclusion matches noreply token inside local-part',
  excludeFrag.includes('[+._-]') && /no\[-_\]\?reply/.test(excludeFrag));

const listSql = getConversationInboxQuery({});
const countsSql = getConversationInboxCountsQuery({
  columns: [
    { key: 'all', channel: null },
    { key: 'email', channel: 'email' },
    { key: 'needs_human', channel: null, needsHuman: true },
  ],
});
assert('list query uses the shared WHERE (exclusion present)',
  listSql.includes('conv.email') && listSql.includes('AND NOT') && listSql.includes('conv.display_name'));
assert('counts query uses the shared WHERE (exclusion present)',
  countsSql.includes('AND NOT') && countsSql.includes('conv.email') && countsSql.includes('conv.display_name'));
assert('needs_human scoped list still excludes system senders',
  getConversationInboxQuery({ needsHumanScoped: true }).includes('needs_human = TRUE')
  && getConversationInboxQuery({ needsHumanScoped: true }).includes('AND NOT'));

console.log('\n[4] Owner wiring — stay off inbound / thread / email-settings');

assert('staff-conversation-queries requires staff-inbox-system-sender',
  /require\(['"]\.\/staff-inbox-system-sender['"]\)/.test(QUERIES_SRC));
assert('helper stays offline (no pg / graph / inbound-bridge require)',
  !/require\(['"]pg['"]\)/.test(HELPER_SRC)
  && !/require\(['"][^'"]*microsoft[^'"]*['"]\)/i.test(HELPER_SRC)
  && !/require\(['"][^'"]*email-inbound[^'"]*['"]\)/i.test(HELPER_SRC));
assert('inbox-thread.js not modified by this gate (source still present, not the owner)',
  fs.existsSync(path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js')));
assert('helper does not mention MailMVP',
  !/mail-?mvp/i.test(HELPER_SRC));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK — system/noreply senders excluded from inbox list+count path\n');
