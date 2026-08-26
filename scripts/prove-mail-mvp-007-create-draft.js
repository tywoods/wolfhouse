#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-007 operator live proof.
 *
 * One controlled Create Draft on an existing eligible Sunset conversation.
 * Lunabox: az containerapp exec into Staff, then correlate Email Luna logs
 * by opaque request_id. Staff container: gated owner proof
 * (MAIL_MVP_007_STAFF_OWNER_PROOF=1) that invokes the production
 * POST /staff/inbox/email/create-draft owner exactly once.
 *
 * Never prints guest identifiers, conversation UUID, notes, tokens, or draft body.
 * Never calls approve/send/provider endpoints.
 *
 * Env:
 *   MAIL_MVP_007_LIVE_PROOF=1
 *   LUNA_DEPLOYMENT=sunset-staging
 *   EMAIL_LUNA_PROOF_CONVERSATION_ID=<uuid>   (operator-supplied; never printed)
 *   AZ=/opt/data/home/.local/bin/az           (Lunabox outer driver)
 *   MAIL_MVP_007_STAFF_OWNER_PROOF=1          (Staff container only; disabled by default)
 */

const {
  LIVE_NOTES,
  runMailMvp007CreateDraftProof,
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
  if (!conversationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId)) {
    fail('refuse: EMAIL_LUNA_PROOF_CONVERSATION_ID must be a uuid (value not printed)');
  }
  if (LIVE_NOTES.includes('booking') !== true) {
    fail('refuse: proof notes mismatch');
  }
  const result = await runMailMvp007CreateDraftProof({
    env: process.env,
    conversation_id: conversationId,
  });
  if (!result || result.ok !== true) {
    fail(`PROOF_FAIL reason=${result && result.reason ? result.reason : 'proof_failed'}`);
  }
  console.log(JSON.stringify(result.public));
})().catch((error) => {
  console.error(error && error.code ? error.code : 'proof_error');
  process.exit(1);
});
