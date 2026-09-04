'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

console.log('SUNSET-SPAM-LUNA-FUN-001 focused gate');

const spam = require('./lib/staff-conversation-spam');
const normalSql = spam.buildConversationSpamPredicate({ spamSelected: false });
const spamSql = spam.buildConversationSpamPredicate({ spamSelected: true });
assert.match(normalSql, /NOT.*metadata->>'is_spam'/);
assert.match(spamSql, /metadata->>'is_spam'/);
assert.doesNotMatch(normalSql + spamSql, /::boolean/);
assert.match(spam.SQL_SET_CONVERSATION_SPAM, /c\.slug = \$2/);
assert.match(spam.SQL_SET_CONVERSATION_SPAM, /conv\.id = \$1::uuid/);
assert.match(spam.setConversationSpam.toString(), /BEGIN/);
assert.match(spam.setConversationSpam.toString(), /pauseConversation/);
assert.match(spam.setConversationSpam.toString(), /resumeConversation/);
assert.match(spam.setConversationSpam.toString(), /resumed_by/);
assert.doesNotMatch(spam.setConversationSpam.toString(), /UPDATE bot_pause_states/);
assert.strictEqual(spam.normalizeSpamSelection('spam'), true);
assert.strictEqual(spam.normalizeSpamSelection('all'), false);
const { getConversationInboxCountsQuery } = require('./lib/staff-conversation-queries');
const countsSql = getConversationInboxCountsQuery({ columns: [
  { key: 'all' },
  { key: 'whatsapp', channel: 'whatsapp' },
  { key: 'spam', spamSelected: true },
] });
assert.match(countsSql, /AS "spam"/);
assert.match(countsSql, /AS "all"/);
assert.match(countsSql, /FILTER \(WHERE NOT \(/);
assert.doesNotMatch(countsSql, /AND NOT \([^\n]+is_spam[^\n]+\)\s*$/m,
  'outer count scope must include spam so its filtered count is non-zero');
console.log('ok - server-authoritative tenant/thread spam contract');

const { listInboxSavedViewDeclarations } = require('./lib/staff-inbox-saved-views');
const railIds = listInboxSavedViewDeclarations().filter((view) => view.rail !== false).map((view) => view.id);
assert.strictEqual(railIds.indexOf('upcoming'), railIds.indexOf('checked_in') + 1);
assert.strictEqual(railIds.indexOf('spam'), railIds.indexOf('lesson_today') + 1);
console.log('ok - Inbox rail places Upcoming under Checked in and Spam under Lesson today');

const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
const summary = computeSunsetFinanceSummary({
  now: new Date('2026-07-15T10:00:00Z'),
  bookings: [
    { booking_id: 'l1', total_amount_cents: 3000, record_source: 'luna_guest' },
    { booking_id: 's1', total_amount_cents: 2000, record_source: 'staff_manual' },
  ],
  bsr: [
    { booking_id: 'l1', service_date: '2026-07-15', service_type: 'surf_lesson', quantity: 2, amount_due_cents: 2000, metadata: {} },
    { booking_id: 'l1', service_date: '2026-07-15', service_type: 'wetsuit', quantity: 1, amount_due_cents: 1000, metadata: {} },
    { booking_id: 's1', service_date: '2026-07-15', service_type: 'surf_lesson', quantity: 9, amount_due_cents: 2000, metadata: {} },
  ],
  payments: [], surf_packs: [], rental_stock: [],
  view: { granularity: 'day', anchor: '2026-07-15' },
});
assert.deepStrictEqual(summary.redesign.luna_bookings, {
  total_bookings: 1,
  by_service: [
    { service_type: 'surf_lesson', quantity: 2 },
    { service_type: 'wetsuit', quantity: 1 },
  ],
});
console.log('ok - Finance Luna bookings uses booking record_source truth');

const financeData = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-finance-data.js'), 'utf8');
assert.match(financeData, /b\.record_source/);
assert.match(financeData, /record_source:\s*r\.record_source/);
const financeUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-finance-redesign-ui.js'), 'utf8');
assert.match(financeUi, /Luna bookings/);
assert.match(financeUi, /luna_bookings/);
console.log('ok - Staff API provenance is carried and Finance section renders it');

const soul = fs.readFileSync(path.join(ROOT, 'docker/hermes-sunset/SOUL.md'), 'utf8');
assert.match(soul, /surfing, waves, beaches, sunsets, friends and good vibes/i);
assert.match(soul, /never invent availability, leftover inventory, prices, kids policy, gear/i);
assert.match(soul, /Prices, availability, item menus, durations, inclusions, and payment links come ONLY from these/i);
console.log('ok - peppy Sunset staging voice retains tool-only commercial truth');

console.log('PASS SUNSET-SPAM-LUNA-FUN-001');
