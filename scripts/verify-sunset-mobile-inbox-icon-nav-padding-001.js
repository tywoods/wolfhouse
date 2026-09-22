#!/usr/bin/env node
'use strict';

/**
 * SUNSET-MOBILE-INBOX-ICON-NAV-PADDING-001
 * Phone Inbox: icon-only filter bar (no sideways scroll), card stack gaps,
 * no list bleed, no Needs-human / Booking header clip. Desktop selectors untouched.
 *
 *   node scripts/verify-sunset-mobile-inbox-icon-nav-padding-001.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const views = fs.readFileSync(path.join(root, 'scripts/browser/inbox-views.js'), 'utf8');
const rows = fs.readFileSync(path.join(root, 'scripts/browser/inbox-rows.js'), 'utf8');

let failed = 0;
function ok(label, cond, detail) {
  if (cond) {
    console.log('ok -', label);
    return;
  }
  failed += 1;
  console.error('FAIL -', label, detail || '');
}

const phoneChrome = api.slice(api.indexOf('staff-portal-mobile:inbox-chrome'));
ok('phone chrome block exists', phoneChrome.length > 40);

ok(
  'phone views rail is icon-only (no overflow-x scroll)',
  phoneChrome.includes('inbox-views-item-label') &&
    phoneChrome.includes('clip:rect(0,0,0,0)') &&
    phoneChrome.includes('overflow-x:hidden') &&
    !/staff-portal-mobile:inbox-chrome[\s\S]{0,2500}\.inbox-views-rail\{[^}]*overflow-x:auto/.test(api)
);

ok(
  'phone views items are compact icon targets',
  phoneChrome.includes('max-width:56px') && phoneChrome.includes('min-height:44px')
);

ok(
  'views buttons expose aria-label and title',
  views.includes("aria-label=\"' + escHtml(label) + '\"") &&
    views.includes("title=\"' + escHtml(label) + '\"")
);

ok(
  'phone stacks cards with breathing room',
  phoneChrome.includes('--inbox-mobile-stack-gap:12px') &&
    (shell.includes('margin:12px 0 0') || phoneChrome.includes('margin:var(--inbox-mobile-stack-gap'))
);

ok(
  'phone conversation list has top padding (no bleed)',
  phoneChrome.includes('padding-top:6px') || shell.includes('#conv-list.conv-list{padding-top:6px')
);

ok(
  'phone detail header grows (no padding:0 clip)',
  /show-thread \.detail-header\{[^}]*padding:12px 14px/.test(api) &&
    !/\.inbox-two-col\.show-thread \.detail-header\{flex-shrink:0;margin-bottom:4px;padding:0\}/.test(api)
);

ok(
  'phone detail-header-main overflow visible',
  api.includes('.inbox-two-col.show-thread .detail-header-main{overflow:visible') ||
    rows.includes("detail-header-main{flex:1 1 100%;min-width:0;order:1;overflow:visible")
);

ok(
  'injected shell keeps icon-only rail + header grow',
  shell.includes("inbox-views-item-label{position:absolute") &&
    shell.includes('show-thread .detail-header{flex-wrap:wrap;align-items:flex-start') &&
    shell.includes('overflow:visible')
);

ok(
  'desktop 901 guest block was not rewritten',
  api.includes('@media(min-width:901px){') &&
    api.includes('.inbox-two-col.inbox-shell-cols[data-col4="hidden"] .detail-sidebar{display:none}')
);

ok(
  'Chats|Guests phone rule from 001 still present',
  phoneChrome.includes('data-inbox-preset="guest"') &&
    phoneChrome.includes('display:flex!important')
);

console.log(
  failed
    ? `verify:sunset-mobile-inbox-icon-nav-padding-001 FAILED (${failed})`
    : 'verify:sunset-mobile-inbox-icon-nav-padding-001 passed'
);
process.exit(failed ? 1 : 0);
