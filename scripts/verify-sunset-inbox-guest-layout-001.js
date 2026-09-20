#!/usr/bin/env node
'use strict';

/**
 * SUNSET-INBOX-GUEST-LAYOUT-001
 *
 * Sunset Inbox → Guests (and Chats/Full if they share the rail+list tracks):
 *   1) List → guest-card gap must be one 14px grid gap, not 28px from a 0px chat track.
 *   2) Left filter rail and middle guest list are the same width — 246px, the
 *      middle of the current 240 / 252 pair. Do not copy either extreme.
 *
 * Sunset staff UI only. Stay off Crow's Nest, Wolfhouse unprefixed tracks,
 * inbox-thread.js, and package.json.
 *
 * Run: node scripts/verify-sunset-inbox-guest-layout-001.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COLUMNS_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-columns.js');
const THREAD_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const CROWSNEST_PAGE = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'sunset-inbox-guest-layout-001.html');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_PATH, 'utf8');
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
const MID = '246px';

console.log('\n── sunset-only equal rail + list (246px middle of 240/252) ──');
ok('Wolfhouse col1 full stays 240px (unprefixed eight-rule set)',
  sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col1="full"]') === '--inbox-col1-w:240px');
ok('Wolfhouse col2 comfortable stays 252px (unprefixed eight-rule set)',
  sliceRule(apiSrc, '.inbox-two-col.inbox-shell-cols[data-col2="comfortable"]') === '--inbox-col2-w:252px');
ok('JS WIDTHS model stays 240 / 252 (Sunset overlay is CSS-only)',
  /col1:\s*\{\s*full:\s*'240px'/.test(columnsSrc)
  && /col2:\s*\{\s*comfortable:\s*'252px'/.test(columnsSrc));

const sunCol1 = sliceRule(apiSrc, `${SUNSET} .inbox-two-col.inbox-shell-cols[data-col1="full"]`);
const sunCol2 = sliceRule(apiSrc, `${SUNSET} .inbox-two-col.inbox-shell-cols[data-col2="comfortable"]`);
const sunWrap1 = sliceRule(apiSrc, `${SUNSET} .inbox-shell-wrap:has(#inbox-shell[data-col1="full"])`);
const sunWrap2 = sliceRule(apiSrc, `${SUNSET} .inbox-shell-wrap:has(#inbox-shell[data-col2="comfortable"])`);
ok(`Sunset col1 full is ${MID} (not 240, not 252)`,
  sunCol1 === `--inbox-col1-w:${MID}`, sunCol1);
ok(`Sunset col2 comfortable is ${MID} (same as col1, not either extreme)`,
  sunCol2 === `--inbox-col2-w:${MID}`, sunCol2);
ok('Sunset wrap :has copies the same 246px onto col1 full',
  sunWrap1 === `--inbox-col1-w:${MID}`, sunWrap1);
ok('Sunset wrap :has copies the same 246px onto col2 comfortable',
  sunWrap2 === `--inbox-col2-w:${MID}`, sunWrap2);
ok('Sunset rail and list widths are equal',
  sunCol1.replace('col1', 'col2') === sunCol2
  && sunCol1.includes(MID)
  && sunCol2.includes(MID));
ok('compact / icons tracks are not retargeted to 246px',
  !apiSrc.includes(`${SUNSET} .inbox-two-col.inbox-shell-cols[data-col1="icons"]{--inbox-col1-w:${MID}`)
  && !apiSrc.includes(`${SUNSET} .inbox-two-col.inbox-shell-cols[data-col2="compact"]{--inbox-col2-w:${MID}`));
ok('data-portal-client attribute stays Sunset-only',
  /portalDefaultClient === 'sunset' \? ' data-portal-client="sunset"' : ''/.test(apiSrc)
  && !/data-portal-client="\$\{portalDefaultClient\}"/.test(apiSrc));

console.log('\n── Guest list→card gap (drop the 0px chat track) ──');
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

console.log('\n── fixture ──');
const fixture = fs.existsSync(FIXTURE_PATH) ? fs.readFileSync(FIXTURE_PATH, 'utf8') : '';
ok('fixture exists', !!fixture);
ok('fixture is Sunset-scoped and titles the job',
  /data-portal-client="sunset"/.test(fixture)
  && /GUEST-LAYOUT-001/.test(fixture));
ok('fixture uses equal 246px tracks and a 3-col Guest grid',
  /--inbox-col1-w:246px/.test(fixture)
  && /--inbox-col2-w:246px/.test(fixture)
  && /minmax\(0,var\(--inbox-col2-w\)\) minmax\(0,1fr\)/.test(fixture)
  && /data-col4="wide"/.test(fixture));

console.log('\n── stay off ──');
ok('inbox-thread.js not modified', gitDiff('scripts/browser/inbox-thread.js') === '');
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
