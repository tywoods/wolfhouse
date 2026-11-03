#!/usr/bin/env node
'use strict';

/**
 * Slice 1 local exit proof.
 *
 * This is deliberately a composition of the focused executable owner gates.  It
 * does not replace any owner, manufacture handler results, open a listener, or
 * enable a provider/alert/event transport.  Every child either invokes the
 * production owner against PGlite/committed SQL or exercises the installed
 * Wolfhouse quote owner.  A child failure is an exit-proof failure.
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const node = process.execPath;
const forbiddenEnv = [
  'META_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'SENDGRID_API_KEY',
  'RESEND_API_KEY', 'SMTP_PASSWORD', 'STAFF_ALERTS_ENABLED',
];
for (const key of forbiddenEnv) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.STAFF_ALERTS_ENABLED = 'false';
process.env.LUNA_SUPERVISOR_EVENTS_ENABLED = 'false';

const gates = [
  ['1A authoritative mixed-package deposit transition and installed failure boundary', 'python3', ['-m', 'unittest',
    'wolfhouse.test_accepted_quote.OwnerHostileTests.test_distribution_then_payment_acceptance_reloads_revalidates_and_saves',
    'wolfhouse.test_accepted_quote_installed_entrypoint.InstalledOwnerFailureBoundaryTests.test_registered_handler_failure_is_model_authored_without_owner_details',
    'wolfhouse.test_accepted_quote_installed_entrypoint.InstalledOwnerFailureBoundaryTests.test_registered_handler_failure_without_model_is_typed_failed_handoff'], 'docker/hermes-staging'],
  ['1B durable booking/conversation/tenant/location rejection', node,
    ['scripts/verify-luna-booking-conversation-linkage.js']],
  ['1B production contact/transfer handlers and SQL readback', node,
    ['scripts/verify-luna-transfer-contact-persistence-matrix.js']],
  ['1C Lab discovery followed by production thread read', node,
    ['scripts/verify-slice1c-lab-discovery-thread.js']],
  ['1C lease-bound supervisor reply owner', node,
    ['scripts/verify-slice1c-lease-send-reply.js']],
  ['1C disconnected/reconnect same-channel projection', node,
    ['scripts/verify-slice1c-reconnect-transcript.js']],
  ['1C persisted UUID consumer receipt and SQL projection', node,
    ['scripts/verify-slice1c-receipt-pglite.js']],
  ['1C tenant-scoped redacted event list/detail', node,
    ['scripts/verify-lunabot-slice1c.js']],
  ['1D receipt facts, pending delivery, exactly-once owed clearing', node,
    ['scripts/verify-lunabot-fullpowers-slice1d.js']],
];

let assertions = 0;
for (const [label, command, args, cwd = '.'] of gates) {
  const run = spawnSync(command, args, {
    cwd: path.resolve(root, cwd),
    env: process.env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(`\n--- ${label} ---\n`);
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) throw run.error;
  assert.equal(run.status, 0, `${label} failed with status ${run.status}`);
  assertions += 1;
}

assert.equal(assertions, gates.length);
console.log(`\nverify-lunabot-fullpowers-slice1-exit: PASS (${assertions}/${gates.length} authentic local owner gates; external transports disabled)`);
