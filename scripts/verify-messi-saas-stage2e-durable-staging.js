#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2e-durable-staging — offline RED→GREEN (no Azure/DB/network). */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const LIB_REL = 'scripts/lib/messi-saas-stage2e-mirleft-durable-staging.js';
const CLI_REL = 'scripts/messi-saas-stage2e-mirleft-durable-staging.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2E-DURABLE-STAGING.md';
const VERIFY_REL = 'scripts/verify-messi-saas-stage2e-durable-staging.js';
const TOKEN = 'APPROVE_DURABLE_STAGING_MIRLEFT';
const SUB = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';
let pass = 0; let fail = 0;
const ok = (n, c, d) => {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); }
};
console.log('verify:messi-saas-stage2e-durable-staging — Stage 2E durable apply\n');
for (const rel of [LIB_REL, CLI_REL, DOC_REL, VERIFY_REL]) ok(`file ${rel}`, fs.existsSync(path.join(ROOT, rel)));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('package_script', pkg.scripts
  && pkg.scripts['verify:messi-saas-stage2e-durable-staging'] === `node ${VERIFY_REL}`);
const lib = require('./lib/messi-saas-stage2e-mirleft-durable-staging');
const src = fs.readFileSync(path.join(ROOT, LIB_REL), 'utf8');
const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
ok('contract', lib.ALLOWED_SLUG === 'mirleft' && lib.HUMAN_APPROVAL_TOKEN === TOKEN
  && lib.STAGE_TAG === 'saas-2e-durable-staging'
  && /ttl_rejected|temporary_drill_rejected|destroy_after_success_rejected|rollback_on_success_rejected|rollback_requires_failed_partial/.test(src)
  && /messi-saas-stage2d1-plan-status/.test(src) && /messi-saas-stage2d2-apply-rollback/.test(src)
  && /messiproof|TTL|temporaryDrill/i.test(doc) && /live_enabled|FACTORY/i.test(doc));
const tags = lib.durableTags({
  tenantSlug: 'mirleft', planDigest: 'a'.repeat(64), deploySha: 'b'.repeat(40),
  subscriptionId: SUB, resourceGroupName: 'luna-mirleft-staging-rg',
});
ok('durable_tags', !lib.hasTemporaryTagKeys(tags) && tags.durableStaging === 'true'
  && !Object.prototype.hasOwnProperty.call(tags, 'temporaryDrill'));
const deps = lib.createDeps({
  repoRoot: ROOT, azureMutationLog: [], verifiedDeploySha: 'c'.repeat(40), planDigest: 'd'.repeat(64),
  armRequest: async () => { deps.azureMutationLog.push('arm'); throw new Error('arm_forbidden'); },
});
const readiness = lib.assessReadiness(deps);
ok('readiness_false', !readiness.ready
  && ['inventory_provisional', 'prices_provisional', 'channels_provisional']
    .every((c) => readiness.blockers.some((b) => b.code === c))
  && readiness.live_enabled === false);
const bind = lib.deriveBinding({ slug: 'mirleft' }, deps);
ok('binding', bind.ok && bind.binding.clientSlug === 'mirleft'
  && bind.binding.resourceGroupName === 'luna-mirleft-staging-rg'
  && bind.binding.subscriptionId === SUB);
(async () => {
  for (const [opts, code] of [
    [{ slug: 'messiproof', humanApprovalToken: TOKEN }, 'slug_not_allowlisted'],
    [{ slug: 'mirleft' }, 'human_approval_required'],
    [{ slug: 'mirleft', humanApprovalToken: TOKEN, ttlHours: 48 }, 'ttl_rejected'],
    [{ slug: 'mirleft', humanApprovalToken: TOKEN, temporaryDrill: true }, 'temporary_drill_rejected'],
    [{ slug: 'mirleft', humanApprovalToken: TOKEN, rollbackOnSuccess: true }, 'rollback_on_success_rejected'],
    [{ slug: 'mirleft', humanApprovalToken: TOKEN, destroyAfterSuccess: true }, 'destroy_after_success_rejected'],
  ]) {
    const r = await lib.apply(opts, deps);
    ok(`reject_${code}`, !r.ok && r.azureMutations === 0 && r.refusedBeforeAzureWrite
      && r.errors.some((e) => e.code === code));
  }
  const applied = await lib.apply({ slug: 'mirleft', humanApprovalToken: TOKEN }, deps);
  ok('apply_blocked_zero_mut', !applied.ok && applied.readiness === false
    && applied.refusedBeforeAzureWrite && applied.azureMutations === 0
    && deps.azureMutationLog.length === 0
    && applied.errors.some((e) => e.code === 'readiness_blocked')
    && applied.binding.resourceGroupName === 'luna-mirleft-staging-rg'
    && applied.tags.durableStaging === 'true' && !lib.hasTemporaryTagKeys(applied.tags));
  const rb0 = await lib.rollback({ slug: 'mirleft', confirmDelete: 'luna-mirleft-staging-rg' }, deps);
  ok('rollback_needs_partial', !rb0.ok && rb0.errors.some((e) => e.code === 'rollback_requires_failed_partial'));
  const rb1 = await lib.rollback({
    slug: 'mirleft', confirmDelete: 'luna-mirleft-staging-rg', failedPartialCreation: true,
  }, deps);
  ok('rollback_not_armed', !rb1.ok && rb1.contract === 'canonical_rollback_on_failed_partial_only');
  ok('status_not_ready', lib.status({ slug: 'mirleft' }, deps).readiness === false);
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, CLI_REL), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  const j = JSON.parse(run(['apply', '--slug', 'mirleft', '--human-approval-token', TOKEN]).stdout || '{}');
  ok('cli_blocked', j.refusedBeforeAzureWrite && j.azureMutations === 0
    && j.errors.some((e) => e.code === 'readiness_blocked'));
  ok('cli_slug', JSON.parse(run(['apply', '--slug', 'messiproof', '--human-approval-token', TOKEN]).stdout || '{}')
    .errors.some((e) => e.code === 'slug_not_allowlisted'));
  let armHits = 0;
  const armed = lib.createDeps({
    repoRoot: ROOT, azureMutationLog: [], verifiedDeploySha: 'e'.repeat(40), planDigest: 'f'.repeat(64),
    armRequest: async () => { armHits += 1; return { status: 200, body: {} }; },
  });
  await lib.apply({ slug: 'mirleft', humanApprovalToken: TOKEN }, armed);
  ok('arm_never_called', armHits === 0 && armed.azureMutationLog.length === 0);
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
