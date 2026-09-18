'use strict';

/**
 * OWNER-LAB-FILTER-EMPTY-LIST-FIX-001
 *
 * The Owner Lab saved-view rail selects view=owner_lab while the legacy filter
 * state remains `all`. The list filter must still keep Owner Lab rows for that
 * saved view, otherwise the API badge can show count=4 while the middle list
 * renders empty.
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

assert.match(listSrc, /savedViewOwnerLab[\s\S]{0,180}inboxSavedViewId[\s\S]{0,80}'owner_lab'/,
  'Owner Lab saved-view id must drive list filtering');
assert.match(listSrc, /inboxFilter === 'owner_lab' \|\| savedViewOwnerLab[\s\S]{0,120}list = list\.filter\(isOwnerLabRow\)/,
  'Owner Lab legacy filter or saved view must keep Owner Lab rows');
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
  { conversation_id: 'owner-1', open_phone_testing: true, guest_tester_class: '' },
  { conversation_id: 'owner-2', open_phone_testing: false, guest_tester_class: 'Owner Lab · Simulator' },
  { conversation_id: 'owner-3', open_phone_testing: true, guest_tester_class: 'Simulator' },
  { conversation_id: 'owner-4', open_phone_testing: false, guest_tester_class: 'qa lab' },
];
const normalRows = [
  { conversation_id: 'normal-1', open_phone_testing: false, guest_tester_class: '', channel: 'whatsapp' },
  { conversation_id: 'normal-2', open_phone_testing: false, guest_tester_class: '', channel: 'email' },
];
const allRows = ownerRows.concat(normalRows);

let out = sandbox.filterInboxConversations(allRows);
assert.equal(out.length, ownerRows.length, 'Owner Lab saved-view list length equals Owner Lab badge count fixture');
assert.deepEqual(out.map((r) => r.conversation_id), ownerRows.map((r) => r.conversation_id),
  'Owner Lab saved view renders the same tagged threads as the count covers');

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

console.log('PASS verify-owner-lab-saved-view-list: Owner Lab count fixture length=4 renders 4 rows; All/WhatsApp/Email exclude Owner Lab; soft-teal chip CSS retained');
