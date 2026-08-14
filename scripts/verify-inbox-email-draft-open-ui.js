'use strict';

/**
 * EMAIL-DRAFT-OPEN-UI — Luna draft ready on Inbox open, or honest pending.
 * No invented prices/availability. Auto-send off. No Skipper send/OAuth files.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const threadSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');
const shellSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-shell.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

const start = threadSrc.indexOf('function inboxEmailDraftBodyOf');
const end = threadSrc.indexOf('function inboxPersonDisplayName');
assert.ok(start > 0 && end > start, 'open-draft helpers present');
const sandbox = {
  inboxEmailSubjectOf(conv) { return String((conv && (conv.email_subject || conv.subject)) || ''); },
  inboxEmailReplySubjectDefault(subject) {
    const s = String(subject || '').trim();
    if (!s) return 'Re: ';
    if (/^re\s*:/i.test(s)) return s;
    return 'Re: ' + s;
  },
};
vm.createContext(sandbox);
vm.runInContext(
  threadSrc.slice(start, end)
    + '\nthis.inboxEmailDraftBodyOf = inboxEmailDraftBodyOf;'
    + '\nthis.inboxEmailDraftIsPending = inboxEmailDraftIsPending;'
    + '\nthis.inboxEmailOpenDraftSubject = inboxEmailOpenDraftSubject;',
  sandbox
);

const body = 'Thanks for writing — a host will confirm the next step.';
assert.strictEqual(sandbox.inboxEmailDraftBodyOf({ draft_text: body }, {}), body);
assert.strictEqual(sandbox.inboxEmailDraftBodyOf({ body: body }, {}), body);
assert.strictEqual(sandbox.inboxEmailDraftBodyOf({}, { staff_reply_draft: body }), body);
assert.strictEqual(sandbox.inboxEmailDraftBodyOf({ draft_text: '' }, { staff_reply_draft: '' }), '');
assert.strictEqual(
  sandbox.inboxEmailDraftIsPending({ reason: 'no_draft_stored', draft_available: false }, { needs_human: true }, ''),
  true
);
assert.strictEqual(
  sandbox.inboxEmailDraftIsPending({ draft_text: body }, { needs_human: true }, body),
  false
);
assert.strictEqual(
  sandbox.inboxEmailOpenDraftSubject({ subject: 'Boards for Saturday' }, { email_subject: 'other' }, []),
  'Re: Boards for Saturday'
);

assert.ok(threadSrc.includes('Luna draft pending'));
assert.ok(threadSrc.includes('id="btn-email-generate-luna-draft" hidden'));
assert.ok(threadSrc.includes('#btn-email-generate-luna-draft') || apiSrc.includes('#btn-email-generate-luna-draft{display:none!important}'));
assert.ok(apiSrc.includes('#btn-email-generate-luna-draft{display:none!important}'));
assert.ok(shellSrc.includes('#inbox-shell #btn-email-generate-luna-draft{display:none!important}'));
assert.ok(threadSrc.includes('id="btn-email-approve-send"'));
assert.ok(threadSrc.includes('/staff/inbox/email/approve-send'));
assert.ok(!/onload[^\n]{0,160}generate-luna-draft|openConversation[^\n]{0,160}generate-luna-draft/i.test(threadSrc));
assert.ok(!threadSrc.includes('last_bot_reply'));
assert.ok(!/€\s*\d|availability is|we have beds/i.test(threadSrc.slice(start, end)));
assert.ok(!threadSrc.includes('email-inbound-inbox-bridge'));
assert.ok(!threadSrc.includes('staff-email-oauth'));
assert.ok(!threadSrc.includes('/staff/inbox/luna-mode'));

console.log('PASS EMAIL-DRAFT-OPEN-UI draft-on-open or honest pending');
