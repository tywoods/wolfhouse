'use strict';

/**
 * OWNER-LAB-FILTER-ISOLATE-QA-001
 *
 * Seadog RED: Owner Lab rail badge count=4 but selecting Owner Lab rendered an
 * empty middle list ("No guest email or chat…") while GET
 * /staff/inbox/list?view=owner_lab returned 4 Simulator WhatsApp rows.
 *
 * Cause: selectInboxSavedView sets inboxFilter='all' while inboxSavedViewId=
 * 'owner_lab'. The #1023 isolate path then excluded Owner Lab rows from the
 * client cache. Even after #1026 kept tagged rows, positively re-filtering with
 * isOwnerLabRow can still drop API-scoped rows. Owner Lab view must list the
 * same threads the badge counts — trust the API-scoped cache.
 *
 * All / WhatsApp / Email must keep excluding Owner Lab. Soft-teal chip stays.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const listPath = path.join(ROOT, 'scripts/browser/inbox-list.js');
const rowsPath = path.join(ROOT, 'scripts/browser/inbox-rows.js');
const listSrc = fs.readFileSync(listPath, 'utf8');
const rowsSrc = fs.readFileSync(rowsPath, 'utf8');

assert.match(listSrc, /OWNER-LAB-FILTER-ISOLATE-QA-001/,
  'QA contract id is anchored in the list filter owner');
assert.match(listSrc, /savedViewOwnerLab[\s\S]{0,180}inboxSavedViewId[\s\S]{0,80}'owner_lab'/,
  'Owner Lab saved-view id must drive list filtering');
assert.match(listSrc, /if \(!savedViewOwnerLab\) \{\s*if \(inboxFilter === 'owner_lab'\) \{\s*list = list\.filter\(isOwnerLabRow\);/,
  'Owner Lab saved view trusts API-scoped rows without re-filtering; legacy owner_lab filter still keeps them');
assert.match(listSrc, /else \{\s*list = list\.filter\(function\(c\)\{ return !isOwnerLabRow\(c\); \}\);\s*\}/,
  'All/WhatsApp/Email paths must keep excluding Owner Lab rows');
assert.match(rowsSrc, /\.inbox-owner-lab-chip\{[^}]*background:rgba\(63,146,142,\.14\);color:#256C68/s,
  'soft-teal Owner Lab chip styling remains present');

const sandbox = {
  console,
  document: { querySelectorAll: () => [] },
  inboxFilter: 'all',
  inboxSavedViewId: 'owner_lab',
  inboxRowIsOwnerLab(row) {
    return !!(row && (row.open_phone_testing === true || String(row.guest_tester_class || '').trim()));
  },
  conversationNeedsHuman(row) { return !!(row && row.needs_human); },
  el() { return null; },
};
vm.createContext(sandbox);
vm.runInContext(listSrc, sandbox, { filename: 'inbox-list.js' });

const ownerRows = [
  { conversation_id: 'owner-1', open_phone_testing: true, guest_tester_class: '', channel: 'whatsapp' },
  { conversation_id: 'owner-2', open_phone_testing: false, guest_tester_class: 'Owner Lab · Simulator', channel: 'whatsapp' },
  { conversation_id: 'owner-3', open_phone_testing: true, guest_tester_class: 'Simulator', channel: 'whatsapp' },
  { conversation_id: 'owner-4', open_phone_testing: false, guest_tester_class: 'qa lab', channel: 'whatsapp' },
];
const normalRows = [
  { conversation_id: 'normal-1', open_phone_testing: false, guest_tester_class: '', channel: 'whatsapp' },
  { conversation_id: 'normal-2', open_phone_testing: false, guest_tester_class: '', channel: 'email' },
];
const allRows = ownerRows.concat(normalRows);

// API already scoped to Owner Lab: 4 Simulator WhatsApp rows (badge count fixture).
let out = sandbox.filterInboxConversations(ownerRows);
assert.equal(out.length, 4, 'Owner Lab saved-view list length equals Owner Lab badge count fixture');
assert.deepEqual(out.map((r) => r.conversation_id), ownerRows.map((r) => r.conversation_id),
  'Owner Lab saved view renders the same tagged threads as the count covers');

// API-scoped rows that lack client markers must still render (trust the list endpoint).
const apiScopedWithoutClientMarkers = [
  { conversation_id: 'api-1', channel: 'whatsapp' },
  { conversation_id: 'api-2', channel: 'whatsapp' },
  { conversation_id: 'api-3', channel: 'whatsapp' },
  { conversation_id: 'api-4', channel: 'whatsapp' },
];
out = sandbox.filterInboxConversations(apiScopedWithoutClientMarkers);
assert.equal(out.length, 4,
  'Owner Lab view must not drop API-scoped rows when client markers are absent');

sandbox.inboxSavedViewId = 'all';
sandbox.inboxFilter = 'all';
out = sandbox.filterInboxConversations(allRows);
assert.deepEqual(out.map((r) => r.conversation_id), ['normal-1', 'normal-2'],
  'All excludes Owner Lab rows');

sandbox.inboxFilter = 'whatsapp';
out = sandbox.filterInboxConversations(allRows);
assert.deepEqual(out.map((r) => r.conversation_id), ['normal-1'],
  'WhatsApp excludes Owner Lab rows');

sandbox.inboxFilter = 'email';
out = sandbox.filterInboxConversations(allRows);
assert.deepEqual(out.map((r) => r.conversation_id), ['normal-2'],
  'Email excludes Owner Lab rows');

sandbox.inboxSavedViewId = 'all';
sandbox.inboxFilter = 'owner_lab';
out = sandbox.filterInboxConversations(allRows);
assert.deepEqual(out.map((r) => r.conversation_id), ownerRows.map((r) => r.conversation_id),
  'legacy Owner Lab filter chip still keeps Owner Lab rows');

console.log('PASS verify-owner-lab-saved-view-list: OWNER-LAB-FILTER-ISOLATE-QA-001 Owner Lab count=4 renders 4 rows; All/WhatsApp/Email exclude; soft-teal chip CSS retained');
