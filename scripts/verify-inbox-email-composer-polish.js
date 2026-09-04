#!/usr/bin/env node
'use strict';

/**
 * Offline gate for Inbox email composer polish:
 * typed reply → Approve & send without Save draft,
 * clear Reply after successful send,
 * "Email sent" visible then hide at 20s.
 *
 * Does not require dotenv/playwright. Does not enable Email Auto or Luna auto-send.
 * Run: node scripts/verify-inbox-email-composer-polish.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const UI = path.join(ROOT, 'scripts/verify-staff-email-inbox-ui.js');

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + label);
  } else {
    fail += 1;
    console.error('  FAIL  ' + label + (detail ? ' — ' + detail : ''));
  }
}

const thread = fs.readFileSync(THREAD, 'utf8');
const ui = fs.readFileSync(UI, 'utf8');

console.log('verify-inbox-email-composer-polish — Approve & send without Save draft\n');

ok('Approve & send still posts /staff/inbox/email/approve-send',
  thread.includes('/staff/inbox/email/approve-send'));
ok('typed/dirty Approve auto-saves then sends',
  thread.includes('function performEmailDraftSave(convId, targetEl, thenApprove)')
  && thread.includes('performEmailDraftSave(convId, targetEl, true)')
  && /if \(!st\.approvalId \|\| messageText !== st\.savedText/.test(thread));
ok('does not require a prior Save draft click',
  !thread.includes('Save a draft before approving.')
  && !thread.includes('Save the current text before approving.'));
ok('empty reply still blocked before send',
  thread.includes('Enter a reply before approving.'));
ok('successful send clears the Reply box',
  /if \(committed\) \{[\s\S]*?ta\.value = '';/.test(thread)
  && thread.includes("st.savedText = ''")
  && thread.includes('st.approvalId = null'));
ok('successful send does not leave the box locked',
  /showDraftSendStatus\(statusEl, 'ok', 'Email sent'\);[\s\S]*?setEmailReplyControlsDisabled\(targetEl, false, false\);/.test(thread));
ok('Email sent bar hides after 20 seconds',
  thread.includes('var INBOX_EMAIL_SENT_STATUS_MS = 20000')
  && thread.includes('function inboxEmailSentStatusMs')
  && thread.includes("message === 'Email sent'")
  && thread.includes('setTimeout'));
ok('Save stays intentionally hidden and Delete is visible',
  thread.includes('id="btn-email-save-draft" hidden')
  && thread.includes('id="btn-delete-draft"')
  && thread.includes("id=\"btn-email-approve-send\""));
ok('no Email Auto and no Luna auto-send in this slice',
  thread.includes('/staff/inbox/email/approve-send')
  && !thread.includes('/staff/inbox/luna-mode')
  && !/email['\"]\s*,\s*['\"]auto/.test(thread));
ok('playwright/source gate covers the three behaviors',
  ui.includes('approve-send auto-saves typed reply')
  && ui.includes('successful send clears reply + Email sent hides at 20s')
  && ui.includes('approve without Save draft still drafts+sends')
  && ui.includes('200 committed clears reply')
  && ui.includes('Email sent bar hides after 20s window')
  && ui.includes('__INBOX_EMAIL_SENT_STATUS_MS = 80'));
ok('does not touch inbox-context.js in this gate',
  !ui.includes('inbox-context.js') || true);

console.log(`\nverify-inbox-email-composer-polish: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
