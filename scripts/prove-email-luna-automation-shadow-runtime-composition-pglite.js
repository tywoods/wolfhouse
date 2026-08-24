'use strict';

/**
 * Prove Ch4 Slice B5 094 identity-match projection and composition schema gate.
 * Default-off. No provider. No journal terminal.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');
const {
  runEmailLunaAutomationShadowRuntimePreflight,
} = require('./lib/email-luna-automation-shadow-runtime-preflight');
const { provisionEmailLunaAutomationPrincipal } = require('./lib/email-luna-automation-principal-provision');
const WORKER_ROLE = 'luna_ch4b6_worker';

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-runtime-composition-red.json'),
  'utf8',
));
const UP_070 = fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8');

const C = b1.ids.client;
const L = b1.ids.location;
const E = b1.ids.endpoint;

function tryLoadPglite() {
  for (const base of [
    process.env.NODE_PATH,
    path.join(ROOT, 'node_modules'),
    '/opt/data/worktrees/full-sail-stage1-ch3a/node_modules',
    '/opt/data/wolfhouse-agent/node_modules',
  ].filter(Boolean)) {
    try {
      const mod = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite'));
      if (mod && mod.PGlite) return mod.PGlite;
    } catch (_) { /* continue */ }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch (_) { return null; }
}

function enabledEnv() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: C,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: L,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: E,
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:worker-secret@127.0.0.1:5432/sunset',
    WOLFHOUSE_DATABASE_URL: 'postgres://postgres:owner-secret@127.0.0.1:5432/sunset',
  };
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-runtime-composition.ch4b5-red.v1');
  assert.equal(RED.head_reviewed, '525d3f6580ccf1aea612485868e5f48f31a2ea3b');
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_WIRED, true);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
  assert.equal(/^\s*GRANT /m.test(b4.UP_094), false);
  console.log('ok - static B5 composition contract');
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_095);
  await b1.revokePublicExecuteOutsideCatalogs(db);
  await provisionEmailLunaAutomationPrincipal(b1.exclusiveSession(db), {
    roleName: WORKER_ROLE,
    kind: 'worker',
    client_id: ids.client,
    location_id: ids.location,
    location_key: 'sunset-somo',
    password: b1.PASSWORD,
    apply: true,
  });
  const owners = b4.loadOwners();
  const loaner = {
    async withTransactionClient(work) {
      await db.exec('SET SESSION AUTHORIZATION postgres');
      return b1.createLoaner(db).withTransactionClient(work);
    },
  };
  const workerLoaner = {
    async withTransactionClient(work) {
      await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
      try {
        return await work({
          async query(text, params) {
            return db.query(text, params);
          },
        });
      } finally {
        await db.exec('SET SESSION AUTHORIZATION postgres');
      }
    },
  };
  await b4.persistPending(owners, loaner, ids, ids.operation);
  const kernel = owners.createEmailLunaAutomationShadowWorkerKernel(
    b4.workerDeps(workerLoaner, ids.client, ids.location, ids.ownerA),
  );
  const first = await kernel.processNextShadowClaim();
  assert.equal(first.status, 'would_send');
  await db.exec(UP_070);
  await b4.insertHumanApproval(db, ids, {
    approval_id: 'a1111111-1111-4111-8111-111111111111',
    operation_id: 'b1111111-1111-4111-8111-111111111111',
  });

  const pre094 = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcome_project($1::uuid, $2::uuid)',
    [ids.operation, first.issuance_id],
  );
  assert.equal(pre094.rows[0].comparison_state, 'agreement');
  await db.exec(b4.UP_094);
  const post094 = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcome_project($1::uuid, $2::uuid)',
    [ids.operation, first.issuance_id],
  );
  assert.equal(post094.rows[0].comparison_state, 'staff_action_observed');
  const stored = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(stored.rows[0].comparison_state, 'pending_human');
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  console.log('ok - 094 relabels unique 070 match as staff_action_observed without rewriting stored capture or journal');

  const timerState = { calls: [] };
  const timers = {
    setTimeout(fn, ms) { timerState.calls.push({ fn, ms }); return timerState.calls.length; },
    clearTimeout() {},
  };
  const runtime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    withTransactionClient: workerLoaner.withTransactionClient,
    timers,
    intervalMs: 60000,
  });
  await runtime.start();
  assert.equal(timerState.calls.length, 1);
  const ticked = await runtime.tick();
  assert.ok(ticked.status === 'empty' || ticked.status === 'would_send');
  await runtime.stop();
  console.log('ok - composition start verifies 094 identity label and remains send-inert');

  const preflight = await runEmailLunaAutomationShadowRuntimePreflight({
    env: enabledEnv(),
    async query(sql, params) {
      await db.exec(`SET SESSION AUTHORIZATION ${WORKER_ROLE}`);
      return db.query(sql, params);
    },
  });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.schema_applied, true);
  assert.equal(preflight.identity_label_applied, true);
  assert.equal(preflight.runtime_started, false);
  assert.equal(preflight.comparison_state_label, 'staff_action_observed');
  console.log('ok - preflight sees applied 094 identity label and does not start runtime');

  await db.exec('SET SESSION AUTHORIZATION postgres');
  await db.exec(b4.DOWN_094);
  const restored = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcome_project($1::uuid, $2::uuid)',
    [ids.operation, first.issuance_id],
  );
  assert.equal(restored.rows[0].comparison_state, 'agreement');
  const stillStored = await db.query(
    'SELECT comparison_state FROM public.tenant_email_luna_automation_shadow_outcomes WHERE operation_id = $1',
    [ids.operation],
  );
  assert.equal(stillStored.rows[0].comparison_state, 'pending_human');
  console.log('ok - 094 down restores 093 projection label without dropping stored rows');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static B5 composition contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B5 shadow runtime composition pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };
