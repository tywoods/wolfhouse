#!/usr/bin/env node
'use strict';

/**
 * verify:inbox-mobile-thread-scroll
 *
 * Offline gate for phone Inbox thread scroll + stick-to-latest:
 *   - .thread-messages is the scroll container (not overflow:hidden #inbox-thread-wrap)
 *   - mobile CSS restores flex height chain under .show-thread
 *   - live poll preserves scroll position on #thread-container
 *
 * Run: node scripts/verify-inbox-mobile-thread-scroll.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rowsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-rows.js'), 'utf8');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-list.js'), 'utf8');
const uiSrc = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();

let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  fail += 1;
  console.error(`  FAIL  ${name}`);
}

ok('mobile thread scroll CSS marker', rowsSrc.includes('staff-portal-mobile:inbox-thread-scroll'));
ok('thread-messages overflow-y on phone', /\.inbox-two-col\.show-thread \.thread-messages[\s\S]{0,240}overflow-y:auto!important/.test(rowsSrc));
ok('detail-layout overflow hidden (child scrolls)', /\.inbox-two-col\.show-thread \.detail-layout[\s\S]{0,180}overflow:hidden!important/.test(rowsSrc));
ok('inboxThreadScrollEl targets #thread-container', /function inboxThreadScrollEl\(/.test(threadSrc)
  && threadSrc.includes("'#thread-container'"));
ok('inboxStickThreadToLatest scrolls scrollHeight', /function inboxStickThreadToLatest\(/.test(threadSrc)
  && /scrollEl\.scrollTop = scrollEl\.scrollHeight/.test(threadSrc));
ok('fillComposerThread sticks after render', /function inboxFillComposerThread[\s\S]{0,2200}inboxStickThreadToLatest\(\)/.test(threadSrc));
ok('loadConvDetail releases mobile fixed height', threadSrc.includes('inboxReleaseMobileThreadHeight()'));
ok('live poll uses thread scroll el', /pollInboxSelectedThreadLive[\s\S]{0,600}inboxThreadScrollEl/.test(listSrc)
  || /pollInboxSelectedThreadLive[\s\S]{0,600}thread-container/.test(listSrc));
ok('portal source includes mobile thread scroll marker', uiSrc.includes('staff-portal-mobile:inbox-thread-scroll'));

console.log(`\nverify-inbox-mobile-thread-scroll: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
