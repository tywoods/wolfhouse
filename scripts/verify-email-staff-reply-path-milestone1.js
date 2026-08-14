'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EMAIL_DRAFT_PATH,
  EMAIL_APPROVE_SEND_PATH,
  ENV_DRAFTS_ENABLED,
  ENV_OUTBOUND_ENABLED,
  isEmailStaffDraftsEnabled,
  isEmailStaffOutboundEnabled,
} = require('./lib/staff-email-inbox-routes');
const {
  ENV_COMPOSITION_ENABLED,
} = require('./lib/email-outbound-sunset-staging-runtime-composition');

function main() {
  assert.equal(EMAIL_DRAFT_PATH, '/staff/inbox/email/draft');
  assert.equal(EMAIL_APPROVE_SEND_PATH, '/staff/inbox/email/approve-send');
  assert.equal(ENV_DRAFTS_ENABLED, 'EMAIL_STAFF_EMAIL_DRAFTS_ENABLED');
  assert.equal(ENV_OUTBOUND_ENABLED, 'EMAIL_STAFF_OUTBOUND_ENABLED');
  assert.equal(ENV_COMPOSITION_ENABLED, 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED');
  assert.equal(isEmailStaffDraftsEnabled({ EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true' }), true);
  assert.equal(isEmailStaffDraftsEnabled({}), false);
  assert.equal(isEmailStaffOutboundEnabled({ EMAIL_STAFF_OUTBOUND_ENABLED: 'true' }), true);
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(api, /emailInboxRoutes\.handleDraft/);
  assert.match(api, /emailInboxRoutes\.handleApproveSend/);
  const outbound = fs.readFileSync(
    path.join(__dirname, 'lib/email-outbound-sunset-staging-runtime-composition.js'),
    'utf8',
  );
  assert.match(outbound, /createMicrosoftGraphReplyDraftTransport/);
  assert.match(outbound, /dispatchApprovedOutbound/);
  console.log('verify:email-staff-reply-path-milestone1: ok');
}

main();
