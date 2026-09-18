'use strict';

/**
 * verify:inbox-guest-sidebar-split
 *
 * Offline checks for INBOX-GUEST-SIDEBAR-SPLIT-001 feature.
 *
 * Proves:
 *   - Surface ownership is declared for all Inbox and Guest views
 *   - Sunset Inbox surface order: all, whatsapp, email, needs_human, spam, owner_lab
 *   - Sunset Guest surface order: all_people, checked_in, lesson_today, upcoming,
 *     hot_leads, warm_leads, unpaid, waiver_due, do_not_contact
 *   - Owner Lab is Inbox-only (not in Guest surface order)
 *   - Spam is Inbox-only (not in Guest surface order)
 *   - EN/ES i18n keys exist for spam and owner_lab
 *   - inbox-views.js has surface switching logic
 *   - inbox-rows.js calls inboxViewsSwitchSurface on preset transitions
 *
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-guest-sidebar-split.js
 */

const fs = require('fs');
const path = require('path');

const {
  INBOX_SAVED_VIEWS,
  INBOX_VIEW_SURFACES,
  SUNSET_INBOX_SURFACE_ORDER,
  SUNSET_GUEST_SURFACE_ORDER,
  listInboxSavedViews,
  listInboxSavedViewsBySurface,
  viewBelongsToSurface,
  getDefaultViewForSurface,
  getInboxSavedViewDeclaration,
} = require('./lib/staff-inbox-saved-views');

const ROOT = path.join(__dirname, '..');
const VIEWS_UI_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-views.js');
const ROWS_UI_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-rows.js');
const I18N_EN_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

const viewsSrc = fs.readFileSync(VIEWS_UI_PATH, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_UI_PATH, 'utf8');
const i18nEnSrc = fs.readFileSync(I18N_EN_PATH, 'utf8');
const i18nEsSrc = fs.readFileSync(I18N_ES_PATH, 'utf8');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('\nverify:inbox-guest-sidebar-split — INBOX-GUEST-SIDEBAR-SPLIT-001\n');

console.log('[1] Surface constants and order arrays');

assert('INBOX_VIEW_SURFACES.INBOX is "inbox"',
  INBOX_VIEW_SURFACES.INBOX === 'inbox');
assert('INBOX_VIEW_SURFACES.GUEST is "guest"',
  INBOX_VIEW_SURFACES.GUEST === 'guest');
assert('SUNSET_INBOX_SURFACE_ORDER is frozen',
  Object.isFrozen(SUNSET_INBOX_SURFACE_ORDER));
assert('SUNSET_GUEST_SURFACE_ORDER is frozen',
  Object.isFrozen(SUNSET_GUEST_SURFACE_ORDER));

console.log('\n[2] Inbox surface order: all, whatsapp, email, needs_human, spam, owner_lab');

const expectedInboxOrder = ['all', 'whatsapp', 'email', 'needs_human', 'spam', 'owner_lab'];
assert('Inbox surface has exactly 6 filters',
  SUNSET_INBOX_SURFACE_ORDER.length === 6,
  `got ${SUNSET_INBOX_SURFACE_ORDER.length}`);
assert('Inbox surface order matches spec',
  SUNSET_INBOX_SURFACE_ORDER.join(',') === expectedInboxOrder.join(','),
  `got ${SUNSET_INBOX_SURFACE_ORDER.join(',')}`);

for (const viewId of expectedInboxOrder) {
  assert(`${viewId} is in Inbox surface`,
    viewBelongsToSurface(viewId, INBOX_VIEW_SURFACES.INBOX));
  assert(`${viewId} is NOT in Guest surface`,
    !viewBelongsToSurface(viewId, INBOX_VIEW_SURFACES.GUEST));
}

console.log('\n[3] Guest surface order: all_people, checked_in, lesson_today, upcoming, hot_leads, warm_leads, unpaid, waiver_due, do_not_contact');

const expectedGuestOrder = [
  'all_people', 'checked_in', 'lesson_today', 'upcoming',
  'hot_leads', 'warm_leads', 'unpaid', 'waiver_due', 'do_not_contact'
];
assert('Guest surface has exactly 9 filters',
  SUNSET_GUEST_SURFACE_ORDER.length === 9,
  `got ${SUNSET_GUEST_SURFACE_ORDER.length}`);
assert('Guest surface order matches spec',
  SUNSET_GUEST_SURFACE_ORDER.join(',') === expectedGuestOrder.join(','),
  `got ${SUNSET_GUEST_SURFACE_ORDER.join(',')}`);

for (const viewId of expectedGuestOrder) {
  assert(`${viewId} is in Guest surface`,
    viewBelongsToSurface(viewId, INBOX_VIEW_SURFACES.GUEST));
  assert(`${viewId} is NOT in Inbox surface`,
    !viewBelongsToSurface(viewId, INBOX_VIEW_SURFACES.INBOX));
}

console.log('\n[4] Owner Lab is Inbox-only');

const ownerLabDecl = getInboxSavedViewDeclaration('owner_lab');
assert('Owner Lab view exists',
  !!ownerLabDecl);
assert('Owner Lab has surface = inbox',
  ownerLabDecl && ownerLabDecl.surface === INBOX_VIEW_SURFACES.INBOX);
assert('Owner Lab is in SUNSET_INBOX_SURFACE_ORDER',
  SUNSET_INBOX_SURFACE_ORDER.indexOf('owner_lab') >= 0);
assert('Owner Lab is NOT in SUNSET_GUEST_SURFACE_ORDER',
  SUNSET_GUEST_SURFACE_ORDER.indexOf('owner_lab') < 0);

console.log('\n[5] Spam is Inbox-only');

const spamDecl = getInboxSavedViewDeclaration('spam');
assert('Spam view exists',
  !!spamDecl);
assert('Spam has surface = inbox',
  spamDecl && spamDecl.surface === INBOX_VIEW_SURFACES.INBOX);
assert('Spam is in SUNSET_INBOX_SURFACE_ORDER',
  SUNSET_INBOX_SURFACE_ORDER.indexOf('spam') >= 0);
assert('Spam is NOT in SUNSET_GUEST_SURFACE_ORDER',
  SUNSET_GUEST_SURFACE_ORDER.indexOf('spam') < 0);

console.log('\n[6] listInboxSavedViewsBySurface returns correctly ordered views');

const inboxViews = listInboxSavedViewsBySurface({ surface: 'inbox', isSunset: true });
const guestViews = listInboxSavedViewsBySurface({ surface: 'guest', isSunset: true });

assert('listInboxSavedViewsBySurface(inbox) returns at least 5 views',
  inboxViews.length >= 5, `got ${inboxViews.length}`);
assert('listInboxSavedViewsBySurface(guest) returns at least 8 views',
  guestViews.length >= 8, `got ${guestViews.length}`);

const inboxIds = inboxViews.map(v => v.id);
const guestIds = guestViews.map(v => v.id);

assert('Inbox views are in correct order',
  inboxIds.join(',') === expectedInboxOrder.slice(0, inboxIds.length).join(','),
  `got ${inboxIds.join(',')}`);

const guestAvailableExpected = expectedGuestOrder.filter(id => {
  const decl = getInboxSavedViewDeclaration(id);
  return decl && decl.available && decl.rail !== false;
});
assert('Guest views are in correct order',
  guestIds.join(',') === guestAvailableExpected.join(','),
  `got ${guestIds.join(',')}`);

console.log('\n[7] Default views per surface');

assert('Default Inbox view is "all"',
  getDefaultViewForSurface(INBOX_VIEW_SURFACES.INBOX) === 'all');
assert('Default Guest view is "all_people"',
  getDefaultViewForSurface(INBOX_VIEW_SURFACES.GUEST) === 'all_people');

console.log('\n[8] Surface property on all relevant views');

for (const viewId of expectedInboxOrder) {
  const decl = getInboxSavedViewDeclaration(viewId);
  assert(`${viewId} declaration has surface = inbox`,
    decl && decl.surface === INBOX_VIEW_SURFACES.INBOX,
    decl ? `got ${decl.surface}` : 'view not found');
}

for (const viewId of expectedGuestOrder) {
  const decl = getInboxSavedViewDeclaration(viewId);
  assert(`${viewId} declaration has surface = guest`,
    decl && decl.surface === INBOX_VIEW_SURFACES.GUEST,
    decl ? `got ${decl.surface}` : 'view not found');
}

console.log('\n[9] EN/ES i18n keys for spam and owner_lab');

assert('EN i18n has inbox.rail.view.spam',
  i18nEnSrc.includes("'inbox.rail.view.spam':") || i18nEnSrc.includes('"inbox.rail.view.spam":'));
assert('EN i18n has inbox.rail.view.owner_lab',
  i18nEnSrc.includes("'inbox.rail.view.owner_lab':") || i18nEnSrc.includes('"inbox.rail.view.owner_lab":'));
assert('ES i18n has inbox.rail.view.spam',
  i18nEsSrc.includes("'inbox.rail.view.spam':") || i18nEsSrc.includes('"inbox.rail.view.spam":'));
assert('ES i18n has inbox.rail.view.owner_lab',
  i18nEsSrc.includes("'inbox.rail.view.owner_lab':") || i18nEsSrc.includes('"inbox.rail.view.owner_lab":'));

console.log('\n[10] inbox-views.js surface management');

assert('inbox-views.js declares INBOX_VIEW_SURFACE_INBOX',
  viewsSrc.includes('INBOX_VIEW_SURFACE_INBOX'));
assert('inbox-views.js declares INBOX_VIEW_SURFACE_GUEST',
  viewsSrc.includes('INBOX_VIEW_SURFACE_GUEST'));
assert('inbox-views.js declares inboxCurrentSurface',
  viewsSrc.includes('inboxCurrentSurface'));
assert('inbox-views.js declares inboxLastInboxViewId',
  viewsSrc.includes('inboxLastInboxViewId'));
assert('inbox-views.js declares inboxLastGuestViewId',
  viewsSrc.includes('inboxLastGuestViewId'));
assert('inbox-views.js declares INBOX_SURFACE_ORDER_INBOX array',
  viewsSrc.includes('INBOX_SURFACE_ORDER_INBOX'));
assert('inbox-views.js declares INBOX_SURFACE_ORDER_GUEST array',
  viewsSrc.includes('INBOX_SURFACE_ORDER_GUEST'));
assert('inbox-views.js has inboxViewsSwitchSurface function',
  viewsSrc.includes('function inboxViewsSwitchSurface('));
assert('inbox-views.js exports switchSurface on window.__inboxViews',
  viewsSrc.includes('window.__inboxViews.switchSurface'));
assert('inbox-views.js has inboxViewGetSurfaceForViewId function',
  viewsSrc.includes('function inboxViewGetSurfaceForViewId('));
assert('inbox-views.js has inboxViewGetDefaultViewForSurface function',
  viewsSrc.includes('function inboxViewGetDefaultViewForSurface('));
assert('renderInboxViewsRail filters by surface',
  viewsSrc.includes('surfaceOrder.indexOf(v.id)') || viewsSrc.includes('surfaceViews'));

console.log('\n[11] inbox-rows.js surface switching integration');

assert('inbox-rows.js calls inboxViewsSwitchSurface',
  rowsSrc.includes('inboxViewsSwitchSurface('));
assert('inboxRowsEnterGuestDirectory calls inboxViewsSwitchSurface("guest")',
  /inboxRowsEnterGuestDirectory[\s\S]*?inboxViewsSwitchSurface\(['"]guest['"]\)/.test(rowsSrc));
assert('inboxRowsLeaveGuestDirectory calls inboxViewsSwitchSurface("inbox")',
  /inboxRowsLeaveGuestDirectory[\s\S]*?inboxViewsSwitchSurface\(['"]inbox['"]\)/.test(rowsSrc));
assert('inbox-rows.js checks window.__inboxViews.switchSurface as fallback',
  rowsSrc.includes('window.__inboxViews') && rowsSrc.includes('.switchSurface'));

console.log('\n[12] Client-side surface order mirrors server-side');

const clientInboxOrderMatch = viewsSrc.match(/INBOX_SURFACE_ORDER_INBOX\s*=\s*\[([^\]]+)\]/);
const clientGuestOrderMatch = viewsSrc.match(/INBOX_SURFACE_ORDER_GUEST\s*=\s*\[([^\]]+)\]/);

if (clientInboxOrderMatch) {
  const clientInboxOrder = clientInboxOrderMatch[1].replace(/['"]/g, '').split(',').map(s => s.trim());
  assert('Client INBOX_SURFACE_ORDER_INBOX matches server',
    clientInboxOrder.join(',') === expectedInboxOrder.join(','),
    `client=${clientInboxOrder.join(',')} server=${expectedInboxOrder.join(',')}`);
} else {
  assert('Client INBOX_SURFACE_ORDER_INBOX found', false, 'could not parse');
}

if (clientGuestOrderMatch) {
  const clientGuestOrder = clientGuestOrderMatch[1].replace(/['"]/g, '').split(',').map(s => s.trim());
  assert('Client INBOX_SURFACE_ORDER_GUEST matches server',
    clientGuestOrder.join(',') === expectedGuestOrder.join(','),
    `client=${clientGuestOrder.join(',')} server=${expectedGuestOrder.join(',')}`);
} else {
  assert('Client INBOX_SURFACE_ORDER_GUEST found', false, 'could not parse');
}

console.log('\n[13] Checked in is NOT renamed to Equipment Out');

const checkedInDecl = getInboxSavedViewDeclaration('checked_in');
assert('checked_in view label is "Checked in"',
  checkedInDecl && checkedInDecl.label === 'Checked in',
  checkedInDecl ? `got "${checkedInDecl.label}"` : 'view not found');

console.log('\n' + '─'.repeat(60));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-guest-sidebar-split — FAILED');
  process.exit(1);
}
console.log('verify:inbox-guest-sidebar-split — ALL CHECKS PASSED');
process.exit(0);
