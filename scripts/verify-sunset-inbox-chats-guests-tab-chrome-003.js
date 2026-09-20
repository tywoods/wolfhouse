#!/usr/bin/env node
'use strict';

/**
 * SUNSET-INBOX-CHATS-GUESTS-TAB-CHROME-003
 *
 * Follow-up on live Chats/Guests folder tabs (#1085):
 *   1) No dark-strip gap between the folder tabs and the All/WhatsApp/Email card.
 *   2) Active Chats/Guests tab uses site green (All-row / --inbox-forest family), not gray --surface.
 *
 * Sunset Staff Inbox only. Stay off Crow's Nest, Hermes, Email mailbox cards,
 * inbox-thread.js, and package.json.
 *
 * Run: node scripts/verify-sunset-inbox-chats-guests-tab-chrome-003.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const THREAD_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-thread.js');
const CROWSNEST_PAGE = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const EMAIL_UI = path.join(ROOT, 'scripts', 'browser', 'sunset-admin-email-settings-ui.js');

const apiSrc = fs.readFileSync(API_PATH, 'utf8');
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

console.log('\n── sunset-only chrome ──');
ok('folder tabs still hidden by default (Wolfhouse)',
  /\.inbox-folder-tabs\{display:none\}/.test(apiSrc));
ok('Sunset shows folder tabs on the left rail',
  /html\[data-portal-client="sunset"\] \.inbox-col1 > \.inbox-folder-tabs\{/.test(apiSrc)
  && /display:flex/.test(sliceRule(apiSrc, 'html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs')));
ok('data-portal-client attribute stays Sunset-only',
  /portalDefaultClient === 'sunset' \? ' data-portal-client="sunset"' : ''/.test(apiSrc)
  && !/data-portal-client="\$\{portalDefaultClient\}"/.test(apiSrc));

console.log('\n── gap closed (tabs sit on the card) ──');
const tabsRule = sliceRule(apiSrc, 'html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs');
const mb = /margin:[^;]*0\s+0\s+(-?\d+)px/.exec(tabsRule)
  || /margin-bottom:(-?\d+)px/.exec(tabsRule);
const marginBottom = mb ? Number(mb[1]) : null;
ok('folder tabs cancel the 10px col1 gap (margin-bottom <= -10px)',
  marginBottom != null && marginBottom <= -10,
  `rule=${tabsRule.replace(/\s+/g, ' ').slice(0, 180)} mb=${marginBottom}`);
ok('folder tabs stack above the rail (z-index)',
  /z-index:2/.test(tabsRule) && /position:relative/.test(tabsRule));
ok('views-rail top corners flatten so the card attaches to the tabs',
  /html\[data-portal-client="sunset"\] #inbox-shell\.inbox-two-col\.inbox-shell-cols \.inbox-col1 > \.inbox-views-rail\{/.test(apiSrc)
  && /border-top-left-radius:0/.test(apiSrc)
  && /border-top-right-radius:0/.test(apiSrc));
ok('Wolfhouse .inbox-col1 gap:10px is unchanged (Autonomy spacing stays)',
  /\.inbox-col1\{[\s\S]{0,180}gap:10px/.test(apiSrc));

console.log('\n── active tab is site green, not gray ──');
const activeNeedle = 'html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs .inbox-folder-tab.is-active';
const activeIdx = apiSrc.indexOf(activeNeedle);
const activeBlock = activeIdx < 0 ? '' : apiSrc.slice(activeIdx, activeIdx + 900);
const lightActive = sliceRule(
  apiSrc,
  'html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs .inbox-folder-tab[aria-pressed="true"]',
);
const darkActive = sliceRule(
  apiSrc,
  'html[data-portal-client="sunset"][data-theme="dark"] .inbox-col1 > .inbox-folder-tabs .inbox-folder-tab[aria-pressed="true"]',
);
ok('light active tab uses --inbox-forest / --primary, not --surface',
  /background:var\(--inbox-forest/.test(lightActive)
  && !/background:var\(--surface\)/.test(lightActive),
  lightActive);
ok('dark active tab uses --inbox-forest / staff-green, not --surface',
  /background:var\(--inbox-forest/.test(darkActive)
  && !/background:var\(--surface\)/.test(darkActive),
  darkActive);
ok('light active copy is cream; dark uses All-row staff-green text (not --cream charcoal)',
  /color:var\(--cream/.test(lightActive)
  && /color:var\(--staff-green-text/.test(darkActive)
  && !/color:var\(--cream/.test(darkActive));
ok('active rules stay Sunset-prefixed',
  (activeBlock.match(/html\[data-portal-client="sunset"\]/g) || []).length >= 2
  && !/\n\.inbox-folder-tab\.is-active\{/.test(apiSrc));

console.log('\n── stay off ──');
ok('inbox-thread.js not modified', gitDiff('scripts/browser/inbox-thread.js') === '');
ok('Crow\'s Nest page not modified', gitDiff('scripts/lib/crowsnest/crowsnest-page.js') === '');
ok('Email mailbox UI not modified', gitDiff('scripts/browser/sunset-admin-email-settings-ui.js') === '');
ok('package.json not modified', gitDiff('package.json') === '');
ok('no Hermes / Crow\'s Nest strings in this chrome block',
  !/hermes/i.test(activeBlock) && !/crowsnest/i.test(activeBlock));
ok('inbox-thread.js still has no folder-tab chrome',
  !threadSrc.includes('inbox-folder-tab') && !threadSrc.includes('SUNSET-INBOX-CHATS-GUESTS-TAB-CHROME-003'));

const threadExists = fs.existsSync(THREAD_PATH);
const crowsnestExists = fs.existsSync(CROWSNEST_PAGE);
const emailExists = fs.existsSync(EMAIL_UI);
ok('stay-off files still exist (not deleted)', threadExists && crowsnestExists && emailExists);

if (fail) {
  console.error(`\nFAILED ${fail}  passed ${pass}`);
  process.exit(1);
}
console.log(`\nOK ${pass} checks`);
