'use strict';

/** Source gate: honest Approve & send copy for non-Microsoft Inbox threads. */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const routesSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');

assert.match(threadSrc, /function emailUiFailureCopy\(op, status, data\)/);
assert.match(threadSrc, /email_mailbox_not_sendable/);
assert.match(threadSrc, /This conversation is not on the Microsoft Inbox mailbox, so it cannot be sent/);
assert.match(threadSrc, /emailUiFailureCopy\('draft', out\.status, out\.data\)/);
assert.match(threadSrc, /emailUiFailureCopy\('approve', out\.status, out\.data\)/);
assert.doesNotMatch(threadSrc, /emailUiFailureCopy\('draft', out\.status\)(?!,)/);
assert.match(routesSrc, /email_mailbox_not_sendable/);
assert.match(routesSrc, /SQL_VISIBLE_EMAIL/);
assert.doesNotMatch(routesSrc, /imap_smtp['"]\s*,\s*'microsoft_graph'/);

console.log('PASS inbox email mailbox-not-sendable UI copy');
