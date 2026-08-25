'use strict';

/**
 * Offline simulation / fake harness proof for Stage 2 Chapter 4C.
 * Does not open PostgreSQL. No live Graph/OAuth.
 */

const assert = require('node:assert/strict');
const {
  runOfflineSimulation,
  createFakeHarnessState,
  parseArgs,
} = require('./lib/email-luna-controlled-drafting-one-shot-live-proof');

async function main() {
  console.log('FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4C offline simulation / fake harness proof');
  console.log('This is not a PostgreSQL proof. It does not open, migrate, or query PostgreSQL.');
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
  const live = runOfflineSimulation({
    parsed: parseArgs(['enable-live-provider', '--apply', ...typed]),
    env,
    state,
  });
  assert.equal(live.ok, true);
  assert.equal(live.simulated_transition, true);
  assert.equal(live.would_require_provider_is_draft, true);
  assert.equal(live.would_consume_098, true);
  assert.equal(live.would_call_graph, false);
  assert.equal(live.live_evidence, false);
  assert.equal(live.token_returned, false);
  assert.equal(live.live_disabled_after, true);
  assert.equal(Object.hasOwn(live, 'consumed_098'), false);
  assert.equal(Object.hasOwn(live, 'provider_is_draft'), false);
  const abort = runOfflineSimulation({
    parsed: parseArgs(['abort', '--apply']),
    env,
    state,
  });
  assert.equal(abort.ok, true);
  assert.equal(abort.evidence_preserved, true);
  console.log('  PASS  offline simulation / fake harness transitions (not PostgreSQL)');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
