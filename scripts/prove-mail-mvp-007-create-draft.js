#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-007 operator live proof.
 *
 * One controlled Create Draft on an existing eligible Sunset conversation.
 * Requires an existing operator session (STAFF_OPERATOR_COOKIE) or an in-process
 * Staff owner (bounded server-side). Never prints guest identifiers or content.
 * Never calls approve/send/provider endpoints.
 *
 * Env:
 *   MAIL_MVP_007_LIVE_PROOF=1
 *   LUNA_DEPLOYMENT=sunset-staging
 *   EMAIL_LUNA_PROOF_CONVERSATION_ID=<uuid>
 *   STAFF_OPERATOR_COOKIE  OR  in-process wiring via prove helper tests
 */

const assert = require('node:assert/strict');
const {
  LIVE_NOTES,
  createMailMvp007LiveProof,
} = require('./lib/email-luna-sunset-email-hermes-sol-live-proof');

function fail(message) {
  console.error(message);
  process.exit(1);
}

(async () => {
  if (process.env.MAIL_MVP_007_LIVE_PROOF !== '1') {
    fail('refuse: set MAIL_MVP_007_LIVE_PROOF=1 for the one controlled Create Draft');
  }
  if (process.env.LUNA_DEPLOYMENT !== 'sunset-staging') {
    fail('refuse: LUNA_DEPLOYMENT must be sunset-staging');
  }
  const conversationId = process.env.EMAIL_LUNA_PROOF_CONVERSATION_ID;
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) {
    fail('refuse: EMAIL_LUNA_PROOF_CONVERSATION_ID must be a uuid (value not printed)');
  }
  if (process.env.EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED !== 'true') {
    fail('refuse: EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED must be true');
  }
  const cookie = process.env.STAFF_OPERATOR_COOKIE;
  const inProcess = process.env.MAIL_MVP_007_INPROCESS_PROOF === '1';
  if (!cookie && !inProcess) {
    fail('refuse: provide STAFF_OPERATOR_COOKIE for the existing operator or in-process proof wiring');
  }
  if (!inProcess) {
    fail('refuse: HTTP operator proof is operator-run after deploy; this binary refuses to invent a live Staff URL/session. Use the in-process Staff owner on the deployed API host, or wire createMailMvp007LiveProof with the existing regenerateEmailLunaDraftOnStaffClick owner.');
  }
  assert.equal(LIVE_NOTES.includes('booking'), true);
  const proof = createMailMvp007LiveProof({
    withPgClient: global.__MAIL_MVP_007_WITH_PG__,
    createDraft: global.__MAIL_MVP_007_CREATE_DRAFT__,
    expectedBody: global.__MAIL_MVP_007_EXPECTED_BODY__,
  });
  const result = await proof.runOnce({
    actor: global.__MAIL_MVP_007_ACTOR__,
    conversation_id: conversationId,
  });
  if (!result.ok) fail(`PROOF_FAIL reason=${result.reason}`);
  console.log(JSON.stringify({
    ok: true,
    invoked: result.invoked,
    marker: result.marker,
    deltas: result.deltas,
    draftChars: result.draftChars,
  }));
})().catch((error) => {
  console.error(error && error.code ? error.code : 'proof_error');
  process.exit(1);
});
