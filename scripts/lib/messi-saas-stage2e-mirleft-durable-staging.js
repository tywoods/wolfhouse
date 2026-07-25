'use strict';
/** MESSI SaaS Stage 2E — durable mirleft staging apply owner (wraps D1/D2). */
const fs = require('fs');
const path = require('path');
const d1 = require('./messi-saas-stage2d1-plan-status');
const d2 = require('./messi-saas-stage2d2-apply-rollback');

const STAGE = 'saas-2e';
const OWNER = 'messi-stage2e';
const STAGE_TAG = 'saas-2e-durable-staging';
const ALLOWED_SLUG = 'mirleft';
const HUMAN_APPROVAL_TOKEN = 'APPROVE_DURABLE_STAGING_MIRLEFT';
const BASELINE_REL = 'config/clients/mirleft.baseline.json';
const CLIENTS_REL = 'config/clients/clients.json';
const CLI_REL = 'scripts/messi-saas-stage2e-mirleft-durable-staging.js';
const LIB_REL = 'scripts/lib/messi-saas-stage2e-mirleft-durable-staging.js';
const DOC_REL = 'docs/MESSI-SAAS-STAGE2E-DURABLE-STAGING.md';
const PROVISIONAL_ROOM = 'TODO_provisional_placeholder_until_real_inventory';
const TEMP_TAG_KEYS = ['temporaryDrill', 'expiresAt', 'createdAt', 'ttlHours'];
const err = (code, message) => ({ code, message });

function createDeps(o = {}) {
  return {
    repoRoot: path.join(__dirname, '..', '..'), d1, d2,
    readFileSync: (p, e) => fs.readFileSync(p, e || 'utf8'),
    armRequest: async () => { throw new Error('stage2e_arm_forbidden_while_not_ready'); },
    azureMutationLog: [], allowAzureRollback: false, ...o,
  };
}
function assertAllowlistedSlug(raw) {
  const s = String(raw || '');
  return s === ALLOWED_SLUG
    ? { ok: true, errors: [], slug: s }
    : { ok: false, errors: [err('slug_not_allowlisted', `allowlist is exactly "${ALLOWED_SLUG}"`)] };
}
function assertHumanApprovalToken(opts) {
  return String((opts && opts.humanApprovalToken) || '') === HUMAN_APPROVAL_TOKEN
    ? { ok: true, errors: [] }
    : { ok: false, errors: [err('human_approval_required',
      `exact --human-approval-token ${HUMAN_APPROVAL_TOKEN} required`)] };
}
function assertDurableSemantics(opts) {
  const o = opts || {}; const errors = [];
  if (o.ttlHours != null) errors.push(err('ttl_rejected', 'durable staging rejects TTL'));
  if (o.temporaryDrill) errors.push(err('temporary_drill_rejected', 'rejects temporaryDrill'));
  if (o.approveMaxTotalUsd != null) errors.push(err('temporary_cost_cap_rejected', 'use human approval token'));
  if (o.rollbackOnSuccess) errors.push(err('rollback_on_success_rejected', 'no rollback-on-success'));
  if (o.destroyAfterSuccess) errors.push(err('destroy_after_success_rejected', 'no destroy-after-success'));
  return { ok: !errors.length, errors };
}
function durableTags(b) {
  return {
    tenant: b.tenantSlug, stage: STAGE_TAG, owner: OWNER, durableStaging: 'true',
    planDigest: b.planDigest || '', deploySha: b.deploySha || '',
    subscriptionId: b.subscriptionId || '', resourceGroupName: b.resourceGroupName || '',
  };
}
function hasTemporaryTagKeys(t) {
  return TEMP_TAG_KEYS.some((k) => Object.prototype.hasOwnProperty.call(t || {}, k));
}
function assessReadiness(deps) {
  const blockers = [];
  const push = (code, message) => {
    if (!blockers.some((b) => b.code === code)) blockers.push({ code, message });
  };
  let clients; let baseline; let entry = null;
  try { clients = JSON.parse(deps.readFileSync(path.join(deps.repoRoot, CLIENTS_REL), 'utf8')); }
  catch (e) { return { ready: false, blockers: [{ code: 'clients_unreadable', message: String(e.message || e) }] }; }
  entry = (clients.clients || []).find((c) => c.client_slug === ALLOWED_SLUG);
  if (!entry) push('client_missing', 'mirleft missing from clients.json');
  else if (entry.live_enabled === true) push('live_enabled_must_stay_false', 'live_enabled must remain false');
  try { baseline = JSON.parse(deps.readFileSync(path.join(deps.repoRoot, BASELINE_REL), 'utf8')); }
  catch (e) {
    return { ready: false, blockers: [...blockers, { code: 'baseline_unreadable', message: String(e.message || e) }] };
  }
  if (baseline.rooming && baseline.rooming._status === PROVISIONAL_ROOM) {
    push('inventory_provisional', 'rooming provisional placeholder');
  }
  for (const [id, room] of Object.entries((baseline.rooming && baseline.rooming.rooms) || {})) {
    if (!id.startsWith('_') && room && (room.status === PROVISIONAL_ROOM || room.guest_assignable === false)) {
      push('inventory_provisional', `room inventory provisional (${id})`); break;
    }
  }
  const walk = (n) => {
    if (!n || typeof n !== 'object' || blockers.some((b) => b.code === 'prices_provisional')) return;
    if (n.pricing_status === 'unverified_seed' || n.pricing_status === 'todo') {
      push('prices_provisional', 'pricing_status unverified_seed/todo in baseline'); return;
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(baseline.catalog || baseline.pricing || baseline);
  const wa = (baseline.channels && baseline.channels.whatsapp) || {};
  if (wa.enabled !== true || wa.status === 'planned'
    || !baseline.deployment || baseline.deployment.whatsapp_phone_number_id == null) {
    push('channels_provisional', 'WhatsApp/channels not provisioned');
  }
  if (baseline.deployment && baseline.deployment.enabled === true) {
    push('deployment_enabled_forbidden', 'deployment.enabled must stay false');
  }
  return { ready: blockers.length === 0, blockers, live_enabled: entry ? !!entry.live_enabled : null };
}
function deriveBinding(opts, deps) {
  const slugGate = assertAllowlistedSlug(opts && opts.slug);
  if (!slugGate.ok) return slugGate;
  const sub = d1.readStagingSubscriptionAuthority(deps.repoRoot);
  if (!sub.ok) return sub;
  const names = d1.deriveNames(slugGate.slug, sub.subscriptionId);
  const tags = durableTags({
    tenantSlug: names.tenantSlug, planDigest: deps.planDigest || null,
    deploySha: deps.verifiedDeploySha || null,
    subscriptionId: names.subscriptionId, resourceGroupName: names.resourceGroupName,
  });
  if (hasTemporaryTagKeys(tags)) {
    return { ok: false, errors: [err('durable_tags_polluted', 'durable tags must not carry temporary keys')] };
  }
  return {
    ok: true, errors: [], names, tags, stage: STAGE, owner: OWNER, stageTag: STAGE_TAG,
    binding: {
      clientSlug: names.tenantSlug, resourceGroupName: names.resourceGroupName,
      subscriptionId: names.subscriptionId,
      deploySha: deps.verifiedDeploySha || null, planDigest: deps.planDigest || null,
    },
  };
}
async function apply(opts, depsIn) {
  const deps = depsIn || createDeps();
  const before = (deps.azureMutationLog || []).length;
  const refuse = (extra) => ({
    ok: false, azureMutations: (deps.azureMutationLog || []).length - before,
    refusedBeforeAzureWrite: true, stage: STAGE, owner: OWNER, ...extra,
  });
  for (const g of [assertDurableSemantics(opts), assertAllowlistedSlug(opts && opts.slug),
    assertHumanApprovalToken(opts)]) {
    if (!g.ok) return refuse(g);
  }
  const bind = deriveBinding(opts, deps);
  if (!bind.ok) return refuse(bind);
  const readiness = assessReadiness(deps);
  if (!readiness.ready) {
    return refuse({
      errors: [
        err('readiness_blocked', 'apply refused: Mirleft inventory/prices/channels provisional'),
        ...readiness.blockers.map((b) => err(b.code, b.message)),
      ],
      readiness: false, blockers: readiness.blockers, binding: bind.binding, tags: bind.tags,
      live_enabled: readiness.live_enabled, temporarySemantics: false,
      rollbackOnSuccess: false, destroyAfterSuccess: false,
    });
  }
  return refuse({
    errors: [err('live_apply_not_enabled', 'readiness true still does not enable live Azure apply')],
    readiness: true, binding: bind.binding, tags: bind.tags,
  });
}
async function rollback(opts, depsIn) {
  const deps = depsIn || createDeps();
  for (const g of [assertDurableSemantics(opts), assertAllowlistedSlug(opts && opts.slug)]) {
    if (!g.ok) return { ...g, azureMutations: 0 };
  }
  const slug = String(opts.slug);
  if (opts.failedPartialCreation !== true) {
    return { ok: false, azureMutations: 0, errors: [err('rollback_requires_failed_partial',
      'canonical rollback only when --failed-partial-creation')] };
  }
  const expectedRg = `luna-${slug}-staging-rg`;
  if (String(opts.confirmDelete || '') !== expectedRg) {
    return { ok: false, azureMutations: 0, errors: [err('confirm_delete_mismatch',
      `--confirm-delete must equal ${expectedRg}`)] };
  }
  if (!deps.allowAzureRollback) {
    return {
      ok: false, azureMutations: 0, contract: 'canonical_rollback_on_failed_partial_only',
      errors: [err('rollback_not_armed', 'D2 rollback only when allowAzureRollback after failed partial')],
      delegatesTo: 'scripts/messi-saas-stage2d2-apply-rollback.js',
    };
  }
  return deps.d2.rollback({
    slug, confirmDelete: expectedRg, _internalFailureRollback: true,
  }, deps.d2Deps);
}
function status(opts, depsIn) {
  const deps = depsIn || createDeps();
  const slugGate = assertAllowlistedSlug((opts && opts.slug) || ALLOWED_SLUG);
  if (!slugGate.ok) return slugGate;
  const readiness = assessReadiness(deps);
  const bind = deriveBinding({ slug: slugGate.slug }, deps);
  return {
    ok: true, stage: STAGE, owner: OWNER, slug: slugGate.slug,
    readiness: readiness.ready, blockers: readiness.blockers, live_enabled: readiness.live_enabled,
    binding: bind.ok ? bind.binding : null, tags: bind.ok ? bind.tags : null,
    temporarySemantics: false, destroyAfterSuccess: false, rollbackOnSuccess: false, azureMutations: 0,
  };
}

module.exports = Object.freeze({
  STAGE, OWNER, STAGE_TAG, ALLOWED_SLUG, HUMAN_APPROVAL_TOKEN,
  BASELINE_REL, CLIENTS_REL, CLI_REL, LIB_REL, DOC_REL, PROVISIONAL_ROOM,
  createDeps, assertAllowlistedSlug, assertHumanApprovalToken, assertDurableSemantics,
  durableTags, hasTemporaryTagKeys, assessReadiness, deriveBinding, apply, rollback, status, d1, d2,
});
