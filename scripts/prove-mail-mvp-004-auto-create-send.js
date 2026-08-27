#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-004 operator proof CLI.
 *
 * Default refuse. Does not execute cloud/live/provider work from an
 * unauthorized invocation. Inner Staff-image mode is
 * MAIL_MVP_004_STAFF_OWNER_PROOF=1 and must run the image-owned copy of
 * this file (`scripts/prove-mail-mvp-004-auto-create-send.js`). Copying
 * this file into an old image is not proof.
 */

const {
  runCli,
  publicProofOutput,
  sanitizeGraphPublic,
  graphInnerExecStdoutOk,
} = require('./lib/email-luna-microsoft-auto-create-send-live-proof');

function graphVerifyMode(env) {
  return !!(env && env.MAIL_MVP_004_GRAPH_VERIFY === '1');
}

function emitPublic(result) {
  if (graphVerifyMode(process.env)) {
    return sanitizeGraphPublic(result && result.public ? result.public : result);
  }
  return publicProofOutput(result);
}

function fail(result) {
  const pub = emitPublic(result);
  console.error(JSON.stringify(pub));
  process.exit(1);
}

(async () => {
  const result = await runCli(process.argv.slice(2), { env: process.env });
  if (graphVerifyMode(process.env)) {
    const pub = emitPublic(result);
    if (graphInnerExecStdoutOk(pub) === true) {
      console.log(JSON.stringify(pub));
      process.exit(0);
    }
    fail(result);
    return;
  }
  if (!result || result.ok !== true) {
    fail(result);
  }
  console.log(JSON.stringify(emitPublic(result)));
})().catch(() => {
  fail({ ok: false, reason: 'proof_error' });
});
