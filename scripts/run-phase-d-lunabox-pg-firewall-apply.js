'use strict';

/**
 * run-phase-d-lunabox-pg-firewall-apply — FOUNDATION Slice 14N
 *
 * Default-disabled operator CLI that applies exactly one PostgreSQL Flexible
 * Server firewall rule (AllowLunaboxEgress / 20.238.124.76) via locked ARM REST
 * PUT behind exact env+argv gates. Never opens a PostgreSQL client. Never
 * deploys main.bicep. Never deletes or broadens existing rules.
 *
 * Usage (default refuse):
 *   node scripts/run-phase-d-lunabox-pg-firewall-apply.js
 */

const {
  evaluateFirewallApplyGates,
  executeLunaboxPgFirewallApply,
  renderFirewallApplyUsage,
  pickSafeFirewallOutput,
  resetFirewallApplyCounters,
  getFirewallApplyCounters,
  ENV_FIREWALL_APPLY,
  CLI_APPLY_FIREWALL_RULE,
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED,
  FIREWALL_LOCKS,
} = require('./lib/phase-d-lunabox-pg-firewall-apply');

// Surface locked gate names for operators/verifiers (values live in the adapter).
void ENV_FIREWALL_APPLY;

function renderFailClosedCatch(err) {
  return pickSafeFirewallOutput({
    ok: false,
    code: 'firewall_apply_unhandled',
    applyFirewallRule: false,
    liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
    liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
    deleteEnabled: PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED === true,
    liveMutation: false,
    usedLiveHttp: false,
    realPostgresCall: false,
    pgClientInstantiated: 0,
    httpRequestCount: getFirewallApplyCounters().httpRequestCount,
    putCount: getFirewallApplyCounters().putCount,
    retries: 0,
    message: String((err && err.message) || err || 'unhandled').slice(0, 240),
    privateRefsZeroed: true,
    firewallRuleExpectedDirectCharge: false,
    bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(renderFirewallApplyUsage());
    process.exit(0);
  }

  resetFirewallApplyCounters();

  if (!argv.includes(CLI_APPLY_FIREWALL_RULE) && argv.length === 0) {
    console.log(renderFirewallApplyUsage());
    console.log('');
    console.log(JSON.stringify(pickSafeFirewallOutput({
      ok: false,
      code: 'default_disabled',
      applyFirewallRule: false,
      liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
      liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
      deleteEnabled: false,
      liveMutation: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realArmCall: false,
      realCostCall: false,
      realOutboundIpCall: false,
      realPostgresCall: false,
      pgClientInstantiated: 0,
      httpRequestCount: getFirewallApplyCounters().httpRequestCount,
      putCount: 0,
      retries: 0,
      note: 'Default path refused — zero ARM mutation / zero PostgreSQL',
      privateRefsZeroed: true,
      firewallRuleExpectedDirectCharge: false,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
      subscriptionId: FIREWALL_LOCKS.subscriptionId,
      resourceGroup: FIREWALL_LOCKS.resourceGroup,
      postgresServer: FIREWALL_LOCKS.postgresServer,
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
    }), null, 2));
    process.exit(2);
  }

  const gates = evaluateFirewallApplyGates({ env: process.env, argv });
  if (!gates.ok) {
    console.log(JSON.stringify(pickSafeFirewallOutput({
      ok: false,
      code: gates.code,
      applyFirewallRule: gates.applyFirewallRule === true,
      liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
      liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
      deleteEnabled: false,
      liveMutation: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realArmCall: false,
      realCostCall: false,
      realOutboundIpCall: false,
      realPostgresCall: false,
      pgClientInstantiated: 0,
      httpRequestCount: getFirewallApplyCounters().httpRequestCount,
      putCount: 0,
      retries: 0,
      errors: gates.errors,
      message: 'firewall apply gates rejected — zero ARM mutation',
      privateRefsZeroed: true,
      firewallRuleExpectedDirectCharge: false,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
    }), null, 2));
    process.exit(2);
  }

  const result = await executeLunaboxPgFirewallApply({
    env: process.env,
    argv,
  });
  console.log(JSON.stringify(pickSafeFirewallOutput(result), null, 2));
  process.exit(result.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(JSON.stringify(renderFailClosedCatch(err), null, 2));
  process.exit(1);
});
