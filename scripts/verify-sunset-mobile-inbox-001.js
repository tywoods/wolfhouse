#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-INBOX-001
 * Phone Inbox must keep Chats|Guests tappable after a thread opens, and Guest
 * must be the card — not a panel trapped under the chat. Desktop selectors stay.
 *
 *   node scripts/verify-sunset-mobile-inbox-001.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const phonePair = [
  '.inbox-two-col.inbox-shell-cols:not(.show-thread){grid-template-rows:auto minmax(0,1fr)}',
  '.inbox-two-col.inbox-shell-cols:not(.show-thread) #conv-detail{display:none}',
];
ok('grepped phone master/detail pair is intact', phonePair.every((line) => api.includes(line)));

const phoneBlock = api.slice(api.indexOf('staff-portal-mobile:inbox-chrome'));
ok('phone chrome block exists', phoneBlock.length > 40);
ok('phone guest card replaces chat', phoneBlock.includes('data-inbox-preset="guest"') && phoneBlock.includes('.detail-main{\n    display:none!important;'));
ok('phone Chats|Guests stay after a thread opens', phoneBlock.includes('html[data-portal-client="sunset"] .inbox-two-col.inbox-shell-cols.show-thread > .inbox-col1{') && phoneBlock.includes('display:flex!important'));
ok('sunset and wolfhouse folder tabs are separate rules', phoneBlock.includes('html[data-portal-client="sunset"] .inbox-col1 > .inbox-folder-tabs{') && phoneBlock.includes('html:not([data-portal-client]) .inbox-col1 > .inbox-folder-tabs{'));
ok('folder tabs are a thumb target', phoneBlock.includes('min-height:44px'));
ok('phone page does not scroll sideways', phoneBlock.includes('overflow-x:hidden'));

ok('injected shell repeats the guest phone rule', shell.includes('body:has([data-inbox-preset="guest"][aria-pressed="true"]) #inbox-shell.show-thread .detail-main{display:none!important}'));
ok('injected shell keeps folder tabs on an open thread', shell.includes('html[data-portal-client="sunset"] #inbox-shell.inbox-two-col.inbox-shell-cols.show-thread > .inbox-col1{display:flex!important'));
ok('desktop 901 guest block was not rewritten', api.includes('@media(min-width:901px){') && api.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"] .detail-sidebar{display:none}'));

console.log(failed ? `verify:sunset-mobile-inbox-001 FAILED (${failed})` : 'verify:sunset-mobile-inbox-001 passed');
process.exit(failed ? 1 : 0);
