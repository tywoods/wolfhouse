#!/usr/bin/env node
'use strict';

// Convenience regression aggregate only. This is intentionally NOT the Slice 1
// exit proof: its children use independent databases and identities.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const node = process.execPath;
for (const key of ['META_ACCESS_TOKEN','WHATSAPP_ACCESS_TOKEN','SENDGRID_API_KEY','RESEND_API_KEY','SMTP_PASSWORD','STAFF_ALERTS_ENABLED']) delete process.env[key];
process.env.NODE_ENV='test'; process.env.STAFF_ALERTS_ENABLED='false'; process.env.LUNA_SUPERVISOR_EVENTS_ENABLED='false';
const gates=[
 ['1A quote owner','python3',['-m','unittest','wolfhouse.test_accepted_quote.OwnerHostileTests.test_distribution_then_payment_acceptance_reloads_revalidates_and_saves','wolfhouse.test_accepted_quote_installed_entrypoint.InstalledOwnerFailureBoundaryTests.test_registered_handler_failure_is_model_authored_without_owner_details','wolfhouse.test_accepted_quote_installed_entrypoint.InstalledOwnerFailureBoundaryTests.test_registered_handler_failure_without_model_is_typed_failed_handoff'],'docker/hermes-staging'],
 ['1B booking linkage',node,['scripts/verify-luna-booking-conversation-linkage.js']],
 ['1B contact/transfer',node,['scripts/verify-luna-transfer-contact-persistence-matrix.js']],
 ['1C Lab discovery/thread',node,['scripts/verify-slice1c-lab-discovery-thread.js']],
 ['1C lease/reply',node,['scripts/verify-slice1c-lease-send-reply.js']],
 ['1C reconnect',node,['scripts/verify-slice1c-reconnect-transcript.js']],
 ['1C receipt',node,['scripts/verify-slice1c-receipt-pglite.js']],
 ['1C event reads',node,['scripts/verify-lunabot-slice1c.js']],
 ['1D confirmation obligation',node,['scripts/verify-lunabot-fullpowers-slice1d.js']],
];
for(const [label,command,args,cwd='.'] of gates){const run=spawnSync(command,args,{cwd:path.resolve(root,cwd),env:process.env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});process.stdout.write(`\n--- ${label} ---\n${run.stdout||''}`);if(run.stderr)process.stderr.write(run.stderr);if(run.error)throw run.error;assert.equal(run.status,0,`${label} failed`);}
console.log(`\nverify-lunabot-fullpowers-slice1-aggregate: PASS (${gates.length} independent regression gates; not an exit proof)`);
