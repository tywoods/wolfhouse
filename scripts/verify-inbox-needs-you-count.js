'use strict';

/**
 * verify:inbox-needs-you-count
 *
 * INBOX-NEEDS-YOU-COUNT-001 — Offline gate for the Inbox left-rail
 * "Needs human" count.
 *
 * Bug: the orange thread badge reads conversations.needs_human, but the rail
 * counted CRM customers (needs_attention). Email threads often have no customer
 * row → badge on / rail 0.
 *
 * Fix contract:
 *   - needs_human view lists + counts conversations.needs_human = TRUE
 *   - needs_attention CRM people filter stays queryable but off the rail
 *   - EN / ES rail copy already exists (do not invent strings)
 *
 * Run:
 *   node scripts/verify-inbox-needs-you-count.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const {
  INBOX_VIEW_SOURCES,
  INBOX_VIEW_ID_BY_CRM_FILTER,
  listInboxSavedViews,
  listInboxSavedViewDeclarations,
  getInboxSavedViewDeclaration,
  buildInboxViewQuery,
  buildInboxViewCountsPlan,
} = require('./lib/staff-inbox-saved-views');

const {
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
} = require('./lib/staff-conversation-queries');

const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const i18nEsSunset = require('./lib/staff-portal-i18n-es-sunset');

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

console.log('\nverify:inbox-needs-you-count — Needs human rail uses conversations.needs_human\n');

console.log('[1] Registry: Needs human is an Inbox conversation view');

const needsHuman = getInboxSavedViewDeclaration('needs_human');
assert('needs_human declaration exists', !!needsHuman);
assert('needs_human source is conversations', needsHuman.source === INBOX_VIEW_SOURCES.CONVERSATIONS);
assert('needs_human sets needsHuman flag', needsHuman.needsHuman === true);
assert('needs_human has no CRM filter', needsHuman.crmFilter == null);
assert('needs_human sits in needs_you group', needsHuman.group === 'needs_you');
assert('needs_human is on the rail', needsHuman.rail !== false
  && listInboxSavedViews().some((v) => v.id === 'needs_human'));
assert('needs_human label is Needs human', needsHuman.label === 'Needs human');

console.log('\n[2] List + count SQL filter conversations.needs_human = TRUE');

const listBuilt = buildInboxViewQuery({ view: 'needs_human', clientSlug: 'sunset', query: { location: 'sunset-somo' } });
assert('needs_human list builds', listBuilt.ok === true);
assert('list SQL includes conv.needs_human = TRUE',
  listBuilt.sql.includes('conv.needs_human = TRUE'));
assert('list SQL matches getConversationInboxQuery({ needsHumanScoped: true })',
  listBuilt.sql === getConversationInboxQuery({
    locationScoped: true,
    needsHumanScoped: true,
  }));
assert('list does not use customer CRM SQL',
  !listBuilt.sql.includes('crm_tags')
  && listBuilt.source === INBOX_VIEW_SOURCES.CONVERSATIONS);

const plan = buildInboxViewCountsPlan({
  clientSlug: 'sunset',
  query: { location: 'sunset-somo' },
});
const convPass = plan.passes.find((p) => p.source === INBOX_VIEW_SOURCES.CONVERSATIONS);
assert('conversation counts pass includes needs_human',
  !!convPass && convPass.viewIds.includes('needs_human'));
assert('counts SQL FILTERs on conv.needs_human = TRUE',
  /COUNT\(\*\) FILTER \(WHERE conv\.needs_human = TRUE\)::int AS "needs_human"/.test(convPass.sql));
assert('helper accepts needsHuman count columns',
  getConversationInboxCountsQuery({
    locationScoped: true,
    columns: [
      { key: 'all', channel: null },
      { key: 'needs_human', channel: null, needsHuman: true },
    ],
  }).includes('FILTER (WHERE conv.needs_human = TRUE)'));

console.log('\n[3] Hidden needs_attention CRM view keeps customer gates');

const needsAttention = getInboxSavedViewDeclaration('needs_attention');
assert('needs_attention declaration exists', !!needsAttention);
assert('needs_attention is customers + crmFilter needs_attention',
  needsAttention.source === INBOX_VIEW_SOURCES.CUSTOMERS
  && needsAttention.crmFilter === 'needs_attention');
assert('needs_attention is hidden from the rail',
  needsAttention.rail === false
  && !listInboxSavedViews().some((v) => v.id === 'needs_attention')
  && !plan.views.some((v) => v.id === 'needs_attention'));
assert('CRM map still owns needs_attention',
  INBOX_VIEW_ID_BY_CRM_FILTER.needs_attention === 'needs_attention');
const crmBuilt = buildInboxViewQuery({
  view: 'needs_attention',
  clientSlug: 'wolfhouse-somo',
  query: {},
});
assert('needs_attention still builds customer SQL for gates',
  crmBuilt.ok === true
  && crmBuilt.source === INBOX_VIEW_SOURCES.CUSTOMERS
  && crmBuilt.crmFilter === 'needs_attention'
  && crmBuilt.filterSql.includes('lc.needs_human'));

console.log('\n[4] Rail copy — existing EN / ES strings only');

const enVal = STAFF_PORTAL_STRINGS.en['inbox.rail.view.needs_human'];
const esMerged = STAFF_PORTAL_STRINGS.es['inbox.rail.view.needs_human'];
const esSunsetVal = i18nEsSunset['inbox.rail.view.needs_human'];

assert('EN rail string is Needs human', enVal === 'Needs human', String(enVal));
assert('ES merged portal string is Requiere personal', esMerged === 'Requiere personal', String(esMerged));
assert('ES sunset override is Requiere personal', esSunsetVal === 'Requiere personal', String(esSunsetVal));

const i18nEnSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const i18nEsSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');
assert('EN i18n file keeps inbox.rail.view.needs_human',
  i18nEnSrc.includes("'inbox.rail.view.needs_human': 'Needs human'"));
assert('ES sunset i18n file keeps inbox.rail.view.needs_human',
  i18nEsSrc.includes("'inbox.rail.view.needs_human': 'Requiere personal'"));

console.log('\n[5] Stay off competing surfaces');

const stayOff = [
  'scripts/browser/inbox-context.js',
  'scripts/browser/inbox-thread.js',
];
for (const rel of stayOff) {
  // Presence is fine — this gate only documents the stay-off list for reviewers.
  assert(`stay-off path exists (do not edit in this ticket): ${rel}`,
    fs.existsSync(path.join(ROOT, rel)));
}

const convSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-conversation-queries.js'), 'utf8');
assert('conversation queries expose needsHumanScoped on the inbox list',
  convSrc.includes('needsHumanScoped')
  && convSrc.includes('conv.needs_human = TRUE'));
assert('needs_human list filter is additive (inboxNeedsHumanWhereClause)',
  convSrc.includes('function inboxNeedsHumanWhereClause')
  && /conversationInboxWhereSql\([^)]*needsHumanScoped/.test(convSrc.replace(/\s+/g, ' ')));

const decls = listInboxSavedViewDeclarations();
assert('registry still declares Needs human for the rail',
  decls.some((v) => v.id === 'needs_human' && v.label === 'Needs human'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-needs-you-count — FAILED');
  process.exit(1);
}
console.log('verify:inbox-needs-you-count — ALL CHECKS PASSED');
process.exit(0);
