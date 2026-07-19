'use strict';

/**
 * FOUNDATION Slice 9 — secret-free live provision orchestration.
 *
 * 1) Load admin env from existing sunset-database-url (never print)
 * 2) Read-only preflight inspect → decide action
 * 3) Controlled --apply
 * 4) Second --apply must VERIFY_NOOP
 * 5) Post-state verify (no business data)
 * 6) Write secret-free evidence under fixtures/ + tmp/
 *
 * Does not mutate firewall, schema/data, images, WhatsApp, payments, or the CA job.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadAdminEnvFromExistingAppDsn } = require('./load-sunset-staging-pg-admin-env');
const {
  TARGETS,
  ENV_APPLY_FLAG,
  ENV_SUBSCRIPTION,
  BOOTSTRAP_ACTIONS,
  decideBootstrapAction,
  runProvision,
  redactDeep,
} = require('./lib/sunset-schema-observer-role-provision');
const {
  buildLiveProvisionAdapters,
  inspectRoleAndSecret,
  verifyLivePostState,
} = require('./lib/sunset-schema-observer-role-live-adapters');

const ROOT = path.join(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, 'fixtures', 'sunset-schema-observer');
const TMP_DIR = path.join(ROOT, 'tmp', 'foundation-slice9');

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

async function applyOnce(label, adapters) {
  process.env[ENV_APPLY_FLAG] = '1';
  process.env[ENV_SUBSCRIPTION] = TARGETS.subscriptionId;
  const result = await runProvision({
    applyRequested: true,
    env: process.env,
    targets: TARGETS,
    ...adapters,
  });
  const safe = redactDeep({
    label,
    ok: result.ok,
    action: result.action,
    refused: result.refused,
    counters: result.counters,
    text: result.text,
    errors: result.errors,
  }, []);
  writeJson(path.join(TMP_DIR, `apply-${label}.json`), safe);
  return result;
}

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const loaded = loadAdminEnvFromExistingAppDsn();
  console.log(JSON.stringify({ adminEnvLoaded: true, userSet: loaded.userSet, passwordSet: loaded.passwordSet }));

  const adapters = buildLiveProvisionAdapters(process.env);

  // Read-only preflight
  const pre = await inspectRoleAndSecret(process.env);
  const decision = decideBootstrapAction(pre);
  const preEvidence = {
    roleExists: pre.roleExists,
    secretExists: pre.secretExists,
    roleValid: pre.roleValid,
    secretValid: pre.secretValid,
    decision: decision.action,
    decisionOk: decision.ok,
    memberships: pre.memberships,
    ownedObjectCount: (pre.ownedObjects || []).length,
    grants: pre.grants,
  };
  writeJson(path.join(TMP_DIR, 'preflight-state.json'), preEvidence);
  console.log(JSON.stringify({ preflight: preEvidence }));

  if (!decision.ok) {
    console.error('REFUSED: inconsistent pre-state — stop before mutation');
    process.exit(2);
  }

  // Brief pause to reduce Container Apps exec rate-limit pressure after preflight inspect.
  await new Promise((r) => setTimeout(r, 15000));

  const first = await applyOnce('first', adapters);
  if (!first.ok) {
    console.error('FIRST APPLY FAILED');
    process.exit(2);
  }
  console.log(JSON.stringify({
    firstApply: {
      ok: first.ok,
      action: first.action,
      counters: first.counters,
    },
  }));

  await new Promise((r) => setTimeout(r, 15000));

  // Rebuild adapters for second run (fresh inspect)
  const adapters2 = buildLiveProvisionAdapters(process.env);
  const second = await applyOnce('second', adapters2);
  if (!second.ok || second.action !== BOOTSTRAP_ACTIONS.VERIFY_NOOP) {
    console.error('SECOND APPLY did not VERIFY_NOOP');
    process.exit(2);
  }
  if (
    second.counters.passwordGenerated !== 0
    || second.counters.postgresExec !== 0
    || second.counters.keyVaultSet !== 0
    || second.counters.roleCreated !== 0
  ) {
    console.error('SECOND APPLY mutated or rotated credentials');
    process.exit(2);
  }
  console.log(JSON.stringify({
    secondApply: {
      ok: second.ok,
      action: second.action,
      counters: second.counters,
    },
  }));

  const post = await verifyLivePostState(process.env);
  writeJson(path.join(TMP_DIR, 'post-state.json'), post);
  if (!post.roleExists || !post.secretExists || !post.roleValid || !post.secretValid || !post.authorityOk) {
    console.error('POST-STATE verification failed');
    process.exit(2);
  }
  console.log(JSON.stringify({ postState: post }));

  const evidence = {
    kind: 'sunset-schema-observer-role-slice9-evidence',
    generatedAt: new Date().toISOString(),
    targets: { ...TARGETS },
    preflight: preEvidence,
    firstApply: {
      ok: first.ok,
      action: first.action,
      counters: first.counters,
    },
    secondApply: {
      ok: second.ok,
      action: second.action,
      counters: second.counters,
    },
    postState: post,
    nonMutations: {
      firewall: false,
      network: false,
      schemaData: false,
      containerAppsJob: false,
      wolfhouse: false,
      production: false,
    },
  };
  writeJson(path.join(EVIDENCE_DIR, 'slice9-live-apply-evidence.json'), evidence);
  console.log('wrote fixtures/sunset-schema-observer/slice9-live-apply-evidence.json');
}

main().catch((err) => {
  console.error('slice9 orchestration failed:', err && err.message ? err.message : err);
  process.exit(1);
});
