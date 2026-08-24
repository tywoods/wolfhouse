'use strict';

/**
 * Prove Ch4 Slice C1 staff-outbound coexistence against 088-095 on PGlite.
 * Default-off. Shadow-runtime provider-inert. No journal terminal. No live DB.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const b1 = require('./prove-email-luna-automation-issuance-material-pglite');
const b4 = require('./prove-email-luna-automation-shadow-comparison-pglite');
const {
  provisionEmailLunaAutomationPrincipal,
} = require('./lib/email-luna-automation-principal-provision');
const {
  createEmailLunaAutomationShadowSunsetStagingRuntimeComposition,
  resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION,
  DISABLED_CODE,
} = require('./lib/email-luna-automation-shadow-sunset-staging-runtime-composition');

const ROOT = path.resolve(__dirname, '..');
const RED = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'fixtures/email-luna-automation-shadow-runtime-coexistence-red.json'),
  'utf8',
));
const UP_095 = fs.readFileSync(path.join(ROOT, 'database/migrations/095_tenant_email_luna_automation_claim_scoped.sql'), 'utf8');
const WORKER_ROLE = 'luna_ch4c1_worker';

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

function enabledEnv(patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED: 'true',
    EMAIL_LUNA_AUTOMATION_SHADOW_CLIENT_ID: b1.ids.client,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_ID: b1.ids.location,
    EMAIL_LUNA_AUTOMATION_SHADOW_LOCATION_KEY: 'sunset-somo',
    EMAIL_LUNA_AUTOMATION_SHADOW_ENDPOINT_ID: b1.ids.endpoint,
    EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_REPLICA_COUNT: '1',
    EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DATABASE_URL: 'postgres://luna_shadow_worker:worker-secret@127.0.0.1:5432/sunset',
    WOLFHOUSE_DATABASE_URL: 'postgres://postgres:owner-secret@127.0.0.1:5432/sunset',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    ...patch,
  };
}

function assertStaticContract() {
  assert.equal(RED.id, 'email-luna-automation-shadow-runtime-coexistence.ch4c1-red.v1');
  assert.equal(RED.head_reviewed, '120b457f0fed3c960cf561330d9808e56268b6bd');
  assert.equal(RED.shadow_runtime_provider_inertness, true);
  assert.equal(RED.whole_process_provider_inertness, false);
  assert.equal(EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_COMPOSITION_ACTIVATION, false);
  const coexist = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv());
  assert.equal(coexist.runtime_activation, true);
  assert.equal(coexist.provider_capability, false);
  const autoSend = resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness(enabledEnv({
    LUNA_AUTO_SEND_ENABLED: 'true',
  }));
  assert.equal(autoSend.runtime_activation, false);
  assert.equal(autoSend.reason, 'provider_capability_refused');
  assert.equal(resolveEmailLunaAutomationShadowSunsetStagingRuntimeReadiness({}).runtime_activation, false);
  console.log('ok - static C1 coexistence contract');
}

async function provePglite(PGlite) {
  const ids = b1.ids;
  const db = new PGlite();
  await b1.applyThrough088(db);
  await db.exec(b1.UP);
  await db.exec(b4.UP_093);
  await db.exec(b4.UP_094);
  await db.exec(UP_095);
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
  const timers = { setTimeout() { return 1; }, clearTimeout() {} };
  const runtime = createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
    env: enabledEnv(),
    withTransactionClient: workerLoaner.withTransactionClient,
    timers,
    intervalMs: 60000,
  });
  await runtime.start();
  const ticked = await runtime.tick();
  assert.ok(ticked.status === 'empty' || ticked.status === 'would_send' || ticked.status === 'overlap_skipped');
  assert.equal(ticked.provider_invoked, false);
  assert.equal(ticked.journal_handoff, false);
  assert.equal(ticked.send_allowed, false);
  await runtime.stop();
  const journal = await db.query('SELECT COUNT(*)::int AS n FROM public.tenant_email_outbound_send_journal');
  assert.equal(journal.rows[0].n, 0);
  console.log('ok - shadow start with staff outbound composition remains send-inert and does not terminalize journal');

  assert.throws(
    () => createEmailLunaAutomationShadowSunsetStagingRuntimeComposition({
      env: enabledEnv({ LUNA_AUTO_SEND_ENABLED: 'true' }),
      withTransactionClient: workerLoaner.withTransactionClient,
      timers,
      intervalMs: 60000,
    }),
    (error) => error && error.code === DISABLED_CODE,
  );
  console.log('ok - LUNA_AUTO_SEND_ENABLED still refuses shadow create when outbound composition is true');
}

function runPgliteProof() {
  assertStaticContract();
  const PGlite = tryLoadPglite();
  if (!PGlite) {
    console.log('ok - pglite unavailable; static C1 coexistence contract only');
    return Promise.resolve();
  }
  return provePglite(PGlite).then(() => {
    console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice C1 shadow runtime coexistence pglite');
  });
}

if (require.main === module) {
  runPgliteProof().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runPgliteProof };
