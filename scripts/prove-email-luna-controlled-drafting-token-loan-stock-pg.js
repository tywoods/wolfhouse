'use strict';

/**
 * Stock PostgreSQL proof for Stage 2 Chapter 4C one-shot harness fake transitions.
 * SKIP honestly when embedded PostgreSQL is unavailable. No live Graph/OAuth.
 */

const assert = require('node:assert/strict');
const {
  runOneShotLiveProof,
  createFakeHarnessState,
  parseArgs,
} = require('./lib/email-luna-controlled-drafting-one-shot-live-proof');

const PG_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/pg';
const EMBEDDED_MODULE = '/opt/data/calendar-inventory-bridge-bf/node_modules/embedded-postgres/dist/index.js';

function resolveEmbedded() {
  try {
    require(PG_MODULE);
    require(EMBEDDED_MODULE);
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C stock-PG / fake harness proof');
  const ids = {
    authorizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    issuanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
  const env = { LUNA_DEPLOYMENT: 'sunset-staging', DEFAULT_CLIENT_SLUG: 'sunset' };
  const state = createFakeHarnessState({
    authorizationPresent: true,
    authorizationId: ids.authorizationId,
    operationId: ids.operationId,
    issuanceId: ids.issuanceId,
    recipientAddress: 'operator-test@example.test',
    flags: {
      EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED: 'true',
      EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED: 'true',
      EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED: 'true',
      EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED: 'true',
      EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED: 'false',
    },
  });
  const typed = [
    '--authorization-id', ids.authorizationId,
    '--operation-id', ids.operationId,
    '--issuance-id', ids.issuanceId,
    '--recipient-address', 'operator-test@example.test',
    '--confirm-recipient', 'operator-test@example.test',
  ];
  const live = runOneShotLiveProof({
    parsed: parseArgs(['enable-live-provider', '--apply', ...typed]),
    env,
    state,
  });
  assert.equal(live.ok, true);
  assert.equal(live.provider_is_draft, true);
  assert.equal(live.graph_send_called, false);
  assert.equal(live.token_returned, false);
  assert.equal(live.live_disabled_after, true);
  const abort = runOneShotLiveProof({
    parsed: parseArgs(['abort', '--apply']),
    env,
    state,
  });
  assert.equal(abort.ok, true);
  assert.equal(abort.evidence_preserved, true);
  if (!resolveEmbedded()) {
    console.log('SKIP — embedded PostgreSQL unavailable; fake harness transitions proved');
    return;
  }
  console.log('  PASS  stock-PG module present; fake one-shot transitions still the Chapter 4C source proof (no live Graph)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
