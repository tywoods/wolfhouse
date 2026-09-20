#!/usr/bin/env node
'use strict';

/**
 * SUNSET-INBOX-GUEST-LAYOUT-001 (rework)
 *
 * Sunset Inbox → Guests / Chats:
 *   1) KEEP: list → guest-card gap is one 14px grid gap (no leftover 0px chat track).
 *   2) UNDO: do NOT equalize col1/col2 to 246px. Wolfhouse 240/252 stay.
 *   3) Shared wrap across Chats (all4) and Guests so rail+list do not jump.
 *      Middle of the two live wraps: 1800 and 1240 → 1520.
 *   4) Chats ↔ Guests switch is atomic: tab chrome + list + side rail paint together.
 *
 * Sunset staff UI only. Stay off Crow's Nest, Wolfhouse unprefixed tracks,
 * inbox-thread.js, inbox-columns.js WIDTHS, and package.json.
 *
 * Run: node scripts/verify-sunset-inbox-guest-layout-001.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COLUMNS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-columns.js');
const ROWS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-rows.js');
const THREAD_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const CROWSNEST_PAGE = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'sunset-inbox-guest-layout-001.html');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_PATH, 'utf8');
const rowsSrc = fs.readFileSync(ROWS_PATH, 'utf8');
const threadSrc = fs.readFileSync(THREAD_PATH, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function sliceRule(src, selector) {
  const needle = selector + '{';
  const i = src.indexOf(needle);
  if (i < 0) return '';
  const start = i + needle.length;
  const end = src.indexOf('}', start);
  return end < 0 ? '' : src.slice(start, end);
}

function gitDiff(rel) {
  try {
    return execSync(`git diff HEAD -- ${rel}`, { cwd: ROOT, encoding: 'utf8' });
  } catch (_e) {
    return 'git-error';
  }
}

const SUNSET = 'html[data-portal-client="sunset"]';
const SHARED_WRAP = '1520px';

console.log('\n── undo equal-width 246px; Wolfhouse 240/252 stay ──');
ok('Wolfhouse col1 full stays 240px (unprefixed eight-rule set)',
  sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col1="full"]') === '--inbox-col1-w:240px');
ok('Wolfhouse col2 comfortable stays 252px (unprefixed eight-rule set)',
  sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col2="comfortable"]') === '--inbox-col2-w:252px');
ok('JS WIDTHS model stays 240 / 252',
  /col1:\s*\{\s*full:\s*'240px'/.test(columnsSrc)
  && /col2:\s*\{\s*comfortable:\s*'252px'/.test(columnsSrc));
ok('Sunset does not force col1/col2 to 246px',
  !apiSrc.includes('--inbox-col1-w:246px')
  && !apiSrc.includes('--inbox-col2-w:246px'));
ok('data-portal-client attribute stays Sunset-only',
  /portalDefaultClient === 'sunset' \? ' data-portal-client="sunset"' : ''/.test(apiSrc)
  && !/data-portal-client="\$\{portalDefaultClient\}"/.test(apiSrc));

console.log('\n── Guest list→card gap (keep 14px / drop 0px chat track) ──');
const wolfWideGrid = /(?:^|\n)\s*\.inbox-two-col\.inbox-shell-cols\[data-col4="wide"\]\{\s*grid-template-columns:([^}]+)\}/.exec(apiSrc);
const wolfGuestGrid = /(?:^|\n)\s*body:has\(\[data-inbox-preset="guest"\]\[aria-pressed="true"\]\) \.inbox-two-col\.inbox-shell-cols\{\s*grid-template-columns:([^}]+)\}/.exec(apiSrc);
ok('Wolfhouse Guest still documents the 0px chat track (untouched)',
  wolfWideGrid && /0px minmax\(0,1fr\)/.test(wolfWideGrid[1])
  && wolfGuestGrid && /0px minmax\(0,1fr\)/.test(wolfGuestGrid[1]),
  `wide=${wolfWideGrid && wolfWideGrid[1]} guest=${wolfGuestGrid && wolfGuestGrid[1]}`);

const sunWide = sliceRule(apiSrc, `${SUNSET} .inbox-two-col.inbox-shell-cols[data-col4="wide"]`);
const sunGuestGrid = sliceRule(
  apiSrc,
  `${SUNSET} body:has([data-inbox-preset="guest"][aria-pressed="true"]) .inbox-two-col.inbox-shell-cols`,
);
ok('Sunset Guest / col4=wide is a 3-col grid (rail | list | card) with no 0px track',
  /grid-template-columns:var\(--inbox-col1-w\) minmax\(0,var\(--inbox-col2-w\)\) minmax\(0,1fr\)/.test(sunWide)
  && /grid-template-columns:var\(--inbox-col1-w\) minmax\(0,var\(--inbox-col2-w\)\) minmax\(0,1fr\)/.test(sunGuestGrid)
  && !/0px/.test(sunWide)
  && !/0px/.test(sunGuestGrid),
  `wide=${sunWide} guest=${sunGuestGrid}`);

const sunSide = sliceRule(
  apiSrc,
  `${SUNSET} body:has([data-inbox-preset="guest"][aria-pressed="true"]) .inbox-two-col.inbox-shell-cols .detail-sidebar`,
);
const sunSideWide = sliceRule(
  apiSrc,
  `${SUNSET} .inbox-two-col.inbox-shell-cols[data-col4="wide"] .detail-sidebar`,
);
ok('Sunset Guest card sits in column 3 (one 14px gap after the list, not two)',
  /grid-column:3/.test(sunSide) && /grid-column:3/.test(sunSideWide),
  `guest=${sunSide} wide=${sunSideWide}`);
ok('Wolfhouse Guest card pin stays grid-column:4',
  /body:has\(\[data-inbox-preset="guest"\]\[aria-pressed="true"\]\) .inbox-two-col.inbox-shell-cols .detail-sidebar[\s\S]{0,280}grid-column:4/.test(apiSrc));
ok('desktop gap stays 14px (Chats guide)',
  /--inbox-col-gap:14px/.test(apiSrc)
  && /\.inbox-two-col\.inbox-shell-cols\{[\s\S]{0,400}gap:14px/.test(apiSrc));

console.log('\n── shared Chats ↔ Guests wrap (menus stay put) ──');
ok('Wolfhouse Full wrap stays 1800px',
  /#tab-conversations\.active #wrap\.inbox-shell-wrap\{[\s\S]{0,80}max-width:1800px!important/.test(apiSrc));
ok('Wolfhouse Chat/Guest wrap stays 1240px',
  /data-inbox-preset="guest"\]\[aria-pressed="true"\]\) #wrap\.inbox-shell-wrap\{[\s\S]{0,40}max-width:1240px!important/.test(apiSrc));
const sunMainWrap = sliceRule(apiSrc, `${SUNSET} #tab-conversations.active #wrap.inbox-shell-wrap`);
const sunGuestWrap = sliceRule(
  apiSrc,
  `${SUNSET} body:has(#tab-conversations.active):has([data-inbox-preset="guest"][aria-pressed="true"]) #wrap.inbox-shell-wrap`,
);
const sunChatWrap = sliceRule(
  apiSrc,
  `${SUNSET} body:has(#tab-conversations.active):has([data-inbox-preset="chat"][aria-pressed="true"]) #wrap.inbox-shell-wrap`,
);
ok(`Sunset Inbox wrap (Chats/Full) is ${SHARED_WRAP} — middle of 1800/1240`,
  sunMainWrap.includes(`max-width:${SHARED_WRAP}!important`),
  sunMainWrap);
ok(`Sunset Guest wrap is the same ${SHARED_WRAP}`,
  sunGuestWrap.includes(`max-width:${SHARED_WRAP}!important`),
  sunGuestWrap);
ok(`Sunset Chat-preset wrap is the same ${SHARED_WRAP}`,
  sunChatWrap.includes(`max-width:${SHARED_WRAP}!important`),
  sunChatWrap);
ok('Sunset Chats and Guests share one wrap width',
  sunMainWrap.includes(SHARED_WRAP)
  && sunGuestWrap.includes(SHARED_WRAP)
  && sunChatWrap.includes(SHARED_WRAP));

console.log('\n── atomic Chats ↔ Guests switch ──');
ok('Sunset keeps a browser snapshot instead of hiding the live shell',
  rowsSrc.includes('document.startViewTransition(function()')
  && !/html\[data-portal-client="sunset"\] #inbox-shell\.inbox-folder-switching\{/.test(apiSrc));
ok('rows owns the switch; thread only carries the async token',
  rowsSrc.includes('function inboxRowsBeginFolderSwitch(')
  && rowsSrc.includes('function inboxRowsNoteFolderSwitchPart(')
  && rowsSrc.includes('inboxRowsRunFolderSwitch')
  && !columnsSrc.includes('inbox-folder-switching')
  && threadSrc.includes('folderSwitchGen: folderSwitchGen'));
ok('preset wrap snapshots before legacy setPreset (one beat, not tab-first)',
  /document\.startViewTransition\(function\(\) \{\s*run\(\)/.test(rowsSrc));
ok('Sunset-only crossing (Chats ↔ Guests)',
  rowsSrc.includes('inboxRowsIsSunsetPortal()')
  && /crossing = wasGuest !== nowGuest && inboxRowsIsSunsetPortal\(\)/.test(rowsSrc));
ok('generation-bound list paint and rail paint both signal readiness',
  rowsSrc.includes("inboxRowsNoteFolderSwitchPart('list', opts && opts.folderSwitchGen)")
  && rowsSrc.includes("inboxRowsNoteFolderSwitchPart('rail')"));
ok('failed/slow fetch cannot leave Inbox invisible (timeout reveal)',
  /setTimeout\(function\(\) \{\s*inboxRowsEndFolderSwitch\(gen\);\s*\}, 500\)/.test(rowsSrc)
  || /setTimeout\(function\(\)\{\s*inboxRowsEndFolderSwitch\(gen\);\s*\}, 500\)/.test(rowsSrc)
  || /,\s*500\)/.test(rowsSrc) && rowsSrc.includes('inboxRowsEndFolderSwitch(gen)'));
ok('guest-directory wrap still latches guestView (do not drop #804)',
  rowsSrc.includes('inboxRowsRuntime.guestView = nowGuest')
  && rowsSrc.includes('inboxRowsEnterGuestDirectory')
  && rowsSrc.includes('wasGuest = inboxRowsGuestViewActive()'));

console.log('\n── fixture ──');
const fixture = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
ok('fixture exists', !!fixture);
ok('fixture is Sunset-scoped and titles the job',
  /data-portal-client="sunset"/.test(fixture)
  && /GUEST-LAYOUT-001/.test(fixture));
ok('fixture uses shared 1520 wrap + 3-col Guest grid (not 246px columns)',
  /max-width:1520px/.test(fixture)
  && /minmax\(0,var\(--inbox-col2-w\)\) minmax\(0,1fr\)/.test(fixture)
  && !/--inbox-col1-w:246px/.test(fixture)
  && /inbox-folder-switching/.test(fixture));

console.log('\n── stay off ──');
ok('inbox-thread.js carries only the authorized switch generation boundary',
  threadSrc.includes('var folderSwitchGen = Number(opts.folderSwitchGen) || 0;')
  && threadSrc.includes('folderSwitchGen: folderSwitchGen'));
ok('inbox-columns.js WIDTHS not modified', gitDiff('scripts/browser/inbox-columns.js') === '');
ok("Crow's Nest page not modified", gitDiff('scripts/lib/crowsnest/crowsnest-page.js') === '');
ok('package.json not modified', gitDiff('package.json') === '');
ok('inbox-thread.js still has no Guest-layout job marker',
  !threadSrc.includes('SUNSET-INBOX-GUEST-LAYOUT-001'));
ok('stay-off files still exist (not deleted)',
  fs.existsSync(THREAD_PATH) && fs.existsSync(CROWSNEST_PAGE));

if (fail) {
  console.error(`\nFAILED ${fail}  passed ${pass}`);
  process.exit(1);
}
console.log(`\nOK ${pass} checks`);
