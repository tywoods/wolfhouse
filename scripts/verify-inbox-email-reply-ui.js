'use strict';

/**
 * EMAIL-REPLY-001-UI — list/header show subject; composer has editable Re: field.
 * Does not touch Skipper send/OAuth/poller/Gmail files or language packs.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const viewsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-views.js'), 'utf8');

const start = threadSrc.indexOf('function inboxEmailSubjectOf');
const end = threadSrc.indexOf('function inboxPersonDisplayName');
assert.ok(start > 0 && end > start, 'subject helpers present');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(threadSrc.slice(start, end) + '\nthis.inboxEmailSubjectOf = inboxEmailSubjectOf;\nthis.inboxEmailReplySubjectDefault = inboxEmailReplySubjectDefault;', sandbox);

const subject = 'Boards for next weekend';
assert.strictEqual(sandbox.inboxEmailSubjectOf({ email_subject: subject, channel: 'email' }), subject);
assert.strictEqual(sandbox.inboxEmailSubjectOf({ channel: 'email', last_message_preview: subject }), subject);
assert.strictEqual(sandbox.inboxEmailSubjectOf({ channel: 'email' }, [{ email_subject: subject }]), subject);
assert.strictEqual(sandbox.inboxEmailReplySubjectDefault(subject), 'Re: Boards for next weekend');
assert.strictEqual(sandbox.inboxEmailReplySubjectDefault('Re: Boards for next weekend'), 'Re: Boards for next weekend');

assert.ok(viewsSrc.includes('email_subject: row.email_subject || row.subject || \'\''));
assert.ok(threadSrc.includes('conv-card-subject'));
assert.ok(threadSrc.includes('inboxEmailSubjectOf(c)'));
assert.ok(threadSrc.includes('id="inbox-thread-email-subject"'));
assert.ok(threadSrc.includes('id="inbox-email-reply-subject"'));
assert.ok(threadSrc.includes('inboxEmailReplySubjectDefault'));
assert.ok(threadSrc.includes('subject: subjectText'));
assert.ok(threadSrc.includes('id="btn-email-approve-send"'));
assert.ok(threadSrc.includes('var INBOX_EMAIL_SENT_STATUS_MS = 20000'));
assert.ok(!threadSrc.includes('email-inbound-inbox-bridge'));
assert.ok(!viewsSrc.includes('email-inbound-inbox-bridge'));
assert.ok(!threadSrc.includes('staff-email-oauth'));

console.log('PASS EMAIL-REPLY-001-UI subject list/header + editable Re: field');
