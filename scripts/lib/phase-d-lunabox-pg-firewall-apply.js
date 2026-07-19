'use strict';

/**
 * phase-d-lunabox-pg-firewall-apply — FOUNDATION Slice 14N
 *
 * Locked ARM apply adapter for exactly one PostgreSQL Flexible Server firewall
 * rule: AllowLunaboxEgress start=end=20.238.124.76 on existing
 * luna-sunset-staging-pg-app. Standalone Bicep declares the resource; this
 * adapter performs one gated ARM REST PUT of that rule only.
 *
 * Never opens a PostgreSQL client. Never deploys main.bicep. Never deletes or
 * broadens existing rules. Never accepts caller URL/body/token. No retries.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  TARGETS,
  ENV_SUBSCRIPTION,
  redactDeep,
  REDACTED,
} = require('./phase-d-live-readonly-boundary');
const {
  MI_LOADER_LOCKS,
} = require('./phase-d-managed-identity-credential-loader');

/** Live ARM apply activated for Slice 14N behind exact env+argv gates. */
const PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED = true;
const PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED = true;
/** Delete / broaden / Azure-services rules remain hard-disabled. */
const PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED = false;

const ENV_FIREWALL_APPLY = 'SUNSET_PHASE_D_LUNABOX_PG_FIREWALL_APPLY';
const CLI_APPLY_FIREWALL_RULE = '--apply-firewall-rule';

const IPV4_EXACT = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

const FIREWALL_LOCKS = Object.freeze({
  subscriptionId: TARGETS.subscriptionId,
  resourceGroup: TARGETS.resourceGroup,
  postgresServer: TARGETS.postgresServer,
  postgresHost: TARGETS.postgresHost,
  firewallRuleName: 'AllowLunaboxEgress',
  startIpAddress: '20.238.124.76',
  endIpAddress: '20.238.124.76',
  expectedOutboundIpv4: '20.238.124.76',
  armApiVersion: '2023-06-01-preview',
  costApiVersion: '2023-11-01',
  imdsHost: MI_LOADER_LOCKS.imdsHost,
  imdsApiVersion: MI_LOADER_LOCKS.imdsApiVersion,
  imdsPath: MI_LOADER_LOCKS.imdsPath,
  armResourceAudience: 'https://management.azure.com/',
  managedIdentityName: MI_LOADER_LOCKS.managedIdentityName,
  managedIdentityClientId: MI_LOADER_LOCKS.managedIdentityClientId,
  managedIdentityPrincipalId: MI_LOADER_LOCKS.managedIdentityPrincipalId,
  vmResourceGroup: 'wh-staging-rg',
  vmName: 'lunabox',
  managementHostname: 'management.azure.com',
  bicepModuleRel: 'infra/azure/sunset-staging/lunabox-pg-firewall-rule.bicep',
  bicepParametersRel: 'infra/azure/sunset-staging/lunabox-pg-firewall-rule.parameters.json',
  maxRulePollAttempts: 8,
  pollDelayMs: 2000,
  existingRules: Object.freeze([
    Object.freeze({
      name: 'AllowSunsetCaeEgress',
      startIpAddress: '4.209.106.13',
      endIpAddress: '4.209.106.13',
    }),
    Object.freeze({
      name: 'AllowSunsetAppEgress',
      startIpAddress: '4.208.189.26',
      endIpAddress: '4.208.189.26',
    }),
  ]),
  outboundIpServices: Object.freeze([
    Object.freeze({
      name: 'ipify',
      hostname: 'api.ipify.org',
      path: '/',
      purpose: 'outbound_ip_echo_1',
    }),
    Object.freeze({
      name: 'ifconfig_me',
      hostname: 'ifconfig.me',
      path: '/ip',
      purpose: 'outbound_ip_echo_2',
    }),
  ]),
  forbiddenRuleNames: Object.freeze([
    'AllowAllWindowsAzureIps',
    'AllowAllAzureIps',
    'AllowAzureServices',
    'AllowAllAzureServices',
  ]),
});

const FORBIDDEN_ARGV_FLAGS = Object.freeze([
  '--delete',
  '--purge',
  '--retry',
  '--retries',
  '--force',
  '--what-if',
  '--whatif',
  '--deploy',
  '--main-bicep',
  '--url',
  '--body',
  '--token',
  '--access-token',
  '--imds-url',
  '--arm-url',
  '--dsn',
  '--database-url',
  '--connection-string',
  '--host',
  '--user',
  '--username',
  '--password',
  '--file',
  '--range',
  '--cidr',
  '--ipv6',
  '--allow-azure-services',
  '--broaden',
  '--mutate-existing',
  '--execute-count-only',
  '--rollback',
]);

const ALLOWED_ARGV_FLAGS = Object.freeze([
  CLI_APPLY_FIREWALL_RULE,
  '--subscription',
  '--resource-group',
  '--vm-resource-group',
  '--vm-name',
  '--managed-identity',
  '--postgres-server',
  '--firewall-rule-name',
  '--start-ip',
  '--end-ip',
  '--help',
  '-h',
]);

const SAFE_OUTPUT_KEYS = Object.freeze([
  'ok',
  'code',
  'applyFirewallRule',
  'liveApplyEnabled',
  'liveHttpEnabled',
  'deleteEnabled',
  'liveMutation',
  'networkMutation',
  'firewallAction',
  'usedLiveHttp',
  'realImdsCall',
  'realArmCall',
  'realCostCall',
  'realOutboundIpCall',
  'realPostgresCall',
  'pgClientInstantiated',
  'httpRequestCount',
  'imdsRequestCount',
  'armGetCount',
  'armPutCount',
  'armDeleteCount',
  'costPostCount',
  'outboundIpGetCount',
  'putCount',
  'ruleGetPollCount',
  'retries',
  'subscriptionId',
  'resourceGroup',
  'vmResourceGroup',
  'vmName',
  'managedIdentityName',
  'managedIdentityClientId',
  'postgresServer',
  'postgresHost',
  'postgresServerResourceId',
  'firewallRuleName',
  'firewallRuleResourceId',
  'startIpAddress',
  'endIpAddress',
  'outboundIpv4Service1',
  'outboundIpv4Service2',
  'outboundIpv4Matched',
  'serverStateBefore',
  'serverStateAfter',
  'publicNetworkAccessBefore',
  'publicNetworkAccessAfter',
  'publicNetworkAccessUnchanged',
  'serverRemainedReady',
  'existingRulesBefore',
  'existingRulesAfter',
  'existingRulesUnchanged',
  'rulesBeforeCount',
  'rulesAfterCount',
  'thirdRuleExact',
  'costBefore',
  'costAfter',
  'costDelta',
  'costDeltaFlagged',
  'firewallRuleExpectedDirectCharge',
  'bicepModuleRel',
  'errors',
  'message',
  'note',
  'privateRefsZeroed',
]);

let httpRequestCount = 0;
let imdsRequestCount = 0;
let armGetCount = 0;
let armPutCount = 0;
let armDeleteCount = 0;
let costPostCount = 0;
let outboundIpGetCount = 0;
let putCount = 0;
let ruleGetPollCount = 0;
let pgClientInstantiated = 0;

function getFirewallApplyCounters() {
  return {
    httpRequestCount,
    imdsRequestCount,
    armGetCount,
    armPutCount,
    armDeleteCount,
    costPostCount,
    outboundIpGetCount,
    putCount,
    ruleGetPollCount,
    pgClientInstantiated,
  };
}

function resetFirewallApplyCounters() {
  httpRequestCount = 0;
  imdsRequestCount = 0;
  armGetCount = 0;
  armPutCount = 0;
  armDeleteCount = 0;
  costPostCount = 0;
  outboundIpGetCount = 0;
  putCount = 0;
  ruleGetPollCount = 0;
  pgClientInstantiated = 0;
}

function buildPostgresServerResourceId(locks = FIREWALL_LOCKS) {
  return (
    `/subscriptions/${locks.subscriptionId}`
    + `/resourceGroups/${locks.resourceGroup}`
    + `/providers/Microsoft.DBforPostgreSQL/flexibleServers/${locks.postgresServer}`
  );
}

function buildFirewallRuleResourceId(locks = FIREWALL_LOCKS) {
  return `${buildPostgresServerResourceId(locks)}/firewallRules/${locks.firewallRuleName}`;
}

function buildLockedImdsArmTokenUrl(locks = FIREWALL_LOCKS) {
  const q = new URLSearchParams({
    'api-version': locks.imdsApiVersion,
    resource: locks.armResourceAudience,
    client_id: locks.managedIdentityClientId,
  });
  return `http://${locks.imdsHost}${locks.imdsPath}?${q.toString()}`;
}

function buildArmServerPath(locks = FIREWALL_LOCKS) {
  return (
    `${buildPostgresServerResourceId(locks)}?api-version=${locks.armApiVersion}`
  );
}

function buildArmFirewallRulesListPath(locks = FIREWALL_LOCKS) {
  return (
    `${buildPostgresServerResourceId(locks)}/firewallRules`
    + `?api-version=${locks.armApiVersion}`
  );
}

function buildArmFirewallRulePath(locks = FIREWALL_LOCKS) {
  return (
    `${buildFirewallRuleResourceId(locks)}?api-version=${locks.armApiVersion}`
  );
}

function buildCostQueryPath(locks = FIREWALL_LOCKS) {
  return (
    `/subscriptions/${locks.subscriptionId}`
    + `/resourceGroups/${locks.resourceGroup}`
    + `/providers/Microsoft.CostManagement/query`
    + `?api-version=${locks.costApiVersion}`
  );
}

function monthToDatePeriod(now = new Date()) {
  const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const to = now.toISOString().slice(0, 10);
  return { from, to, label: 'month-to-date' };
}

function buildLockedCostQueryBody(type, period) {
  return {
    type,
    timeframe: 'Custom',
    timePeriod: { from: period.from, to: period.to },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
    },
  };
}

function isExactIpv4(value) {
  return typeof value === 'string' && IPV4_EXACT.test(value);
}

function isForbiddenAzureServicesRuleName(name) {
  const n = String(name || '');
  return FIREWALL_LOCKS.forbiddenRuleNames.some(
    (x) => x.toLowerCase() === n.toLowerCase(),
  );
}

function assertLockedSingleHostIpv4(startIp, endIp) {
  const errors = [];
  if (!isExactIpv4(startIp)) {
    errors.push({ code: 'ipv4_required', message: 'startIpAddress must be exact IPv4' });
  }
  if (!isExactIpv4(endIp)) {
    errors.push({ code: 'ipv4_required', message: 'endIpAddress must be exact IPv4' });
  }
  if (startIp === '0.0.0.0' || endIp === '0.0.0.0') {
    errors.push({ code: 'zero_ip_rejected', message: '0.0.0.0 rejected' });
  }
  if (startIp !== endIp) {
    errors.push({ code: 'ip_range_rejected', message: 'IP ranges rejected (start must equal end)' });
  }
  if (String(startIp || '').includes(':') || String(endIp || '').includes(':')) {
    errors.push({ code: 'ipv6_rejected', message: 'IPv6 rejected' });
  }
  if (startIp !== FIREWALL_LOCKS.startIpAddress || endIp !== FIREWALL_LOCKS.endIpAddress) {
    errors.push({
      code: 'wrong_locked_ip',
      message: `IPs must be exactly ${FIREWALL_LOCKS.startIpAddress}`,
    });
  }
  return { ok: errors.length === 0, errors };
}

function normalizeFirewallRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const props = rule.properties && typeof rule.properties === 'object'
    ? rule.properties
    : rule;
  return {
    name: String(rule.name || ''),
    startIpAddress: String(props.startIpAddress || ''),
    endIpAddress: String(props.endIpAddress || ''),
  };
}

function rulesByteSemanticEqual(a, b) {
  if (!a || !b) return false;
  return a.name === b.name
    && a.startIpAddress === b.startIpAddress
    && a.endIpAddress === b.endIpAddress;
}

function extractExistingLockedRules(ruleList) {
  const list = Array.isArray(ruleList) ? ruleList.map(normalizeFirewallRule).filter(Boolean) : [];
  const found = [];
  for (const expected of FIREWALL_LOCKS.existingRules) {
    const got = list.find((r) => r.name === expected.name);
    if (!got || !rulesByteSemanticEqual(got, expected)) {
      return {
        ok: false,
        code: 'existing_rule_mismatch',
        errors: [{
          code: 'existing_rule_mismatch',
          message: `existing rule ${expected.name} missing or changed`,
        }],
        rules: list,
      };
    }
    found.push(got);
  }
  return { ok: true, rules: found, all: list };
}

/**
 * Derive before/after rule snapshots + counts from locked existing rules and the
 * exact third rule — never from Azure's full `all` list length (which can already
 * include AllowLunaboxEgress on idempotent re-PUT and inflate before count).
 */
function buildExistingRuleSnapshots(beforeExtract, afterExtract, thirdAfter) {
  const existingRulesBefore = (beforeExtract && Array.isArray(beforeExtract.rules))
    ? beforeExtract.rules.map((r) => ({
      name: r.name,
      startIpAddress: r.startIpAddress,
      endIpAddress: r.endIpAddress,
    }))
    : [];
  const lockedAfter = (afterExtract && Array.isArray(afterExtract.rules))
    ? afterExtract.rules.map((r) => ({
      name: r.name,
      startIpAddress: r.startIpAddress,
      endIpAddress: r.endIpAddress,
    }))
    : [];
  const third = thirdAfter
    ? {
      name: thirdAfter.name,
      startIpAddress: thirdAfter.startIpAddress,
      endIpAddress: thirdAfter.endIpAddress,
    }
    : null;
  const existingRulesAfter = third
    ? lockedAfter.concat([third])
    : lockedAfter.slice();
  return {
    existingRulesBefore,
    existingRulesAfter,
    rulesBeforeCount: existingRulesBefore.length,
    rulesAfterCount: existingRulesAfter.length,
  };
}

function parseCostRow(body) {
  let j;
  try {
    j = JSON.parse(String(body || ''));
  } catch (_) {
    return { ok: false, code: 'cost_json_rejected' };
  }
  const row = (j.properties && j.properties.rows && j.properties.rows[0]) || null;
  if (!row || row[0] == null) {
    return { ok: false, code: 'cost_amount_unavailable' };
  }
  return {
    ok: true,
    amount: row[0],
    currency: row[1] || null,
  };
}

function sanitizeFirewallError(err, secrets) {
  const code = (err && err.code) ? String(err.code) : 'firewall_apply_failed';
  let message = String((err && err.message) || err || 'firewall apply failed').slice(0, 240);
  for (const s of secrets || []) {
    if (s && message.includes(s)) message = message.split(s).join(REDACTED);
  }
  if (/Bearer\s+\S+/i.test(message)) message = message.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  return { code, message };
}

function parseArgvPairs(argv) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const flags = new Set();
  const values = {};
  const unknown = [];
  const forbidden = [];

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      unknown.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    let flag = a;
    let val = null;
    if (eq > 0) {
      flag = a.slice(0, eq);
      val = a.slice(eq + 1);
    }
    if (FORBIDDEN_ARGV_FLAGS.includes(flag)) {
      forbidden.push(flag);
      if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (flag === CLI_APPLY_FIREWALL_RULE || flag === '--help' || flag === '-h') {
      flags.add(flag);
      continue;
    }
    if (ALLOWED_ARGV_FLAGS.includes(flag)) {
      if (val == null) {
        if (i + 1 >= args.length || args[i + 1].startsWith('-')) {
          unknown.push(flag);
          continue;
        }
        val = args[i + 1];
        i += 1;
      }
      values[flag] = val;
      flags.add(flag);
      continue;
    }
    unknown.push(flag);
    if (val == null && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
  }

  return { flags, values, unknown, forbidden, argv: args };
}

function evaluateFirewallApplyEnvApproval(env) {
  const e = env || {};
  const errors = [];
  if (String(e[ENV_FIREWALL_APPLY] || '').trim() !== '1') {
    errors.push({
      code: 'apply_env_required',
      message: `env ${ENV_FIREWALL_APPLY}=1 is required`,
    });
  }
  if (String(e[ENV_SUBSCRIPTION] || '').trim() !== FIREWALL_LOCKS.subscriptionId) {
    errors.push({
      code: 'wrong_subscription_env',
      message: `env ${ENV_SUBSCRIPTION} must be exactly ${FIREWALL_LOCKS.subscriptionId}`,
    });
  }
  const forbiddenEnv = [
    'SUNSET_STAGING_PG_ADMIN_USER',
    'SUNSET_STAGING_PG_ADMIN_PASSWORD',
    'DATABASE_URL',
    'PGPASSWORD',
    'AZURE_CLIENT_SECRET',
    'WOLFHOUSE_DATABASE_URL',
    'SUNSET_SCHEMA_OBSERVER_DATABASE_URL',
  ];
  for (const key of forbiddenEnv) {
    if (e[key] != null && String(e[key]) !== '') {
      errors.push({
        code: 'forbidden_credential_env',
        message: `env ${key} must not be set for firewall apply path`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

function evaluateFirewallApplyExactTargets(argv) {
  const parsed = parseArgvPairs(argv);
  const errors = [];

  if (parsed.forbidden.length > 0) {
    errors.push({
      code: 'forbidden_argv',
      message: `forbidden argv flags: ${parsed.forbidden.join(',')}`,
      flags: parsed.forbidden.slice(),
    });
  }
  if (parsed.unknown.length > 0) {
    errors.push({
      code: 'unknown_cli_args',
      message: `unknown argv: ${parsed.unknown.join(',')}`,
      args: parsed.unknown.slice(),
    });
  }
  if (!parsed.flags.has(CLI_APPLY_FIREWALL_RULE)) {
    errors.push({
      code: 'apply_flag_required',
      message: `${CLI_APPLY_FIREWALL_RULE} is required`,
    });
  }

  const checks = [
    ['--subscription', FIREWALL_LOCKS.subscriptionId, 'wrong_subscription'],
    ['--resource-group', FIREWALL_LOCKS.resourceGroup, 'wrong_resource_group'],
    ['--vm-resource-group', FIREWALL_LOCKS.vmResourceGroup, 'wrong_vm_resource_group'],
    ['--vm-name', FIREWALL_LOCKS.vmName, 'wrong_vm_name'],
    ['--managed-identity', FIREWALL_LOCKS.managedIdentityName, 'wrong_managed_identity'],
    ['--postgres-server', FIREWALL_LOCKS.postgresServer, 'wrong_postgres_server'],
    ['--firewall-rule-name', FIREWALL_LOCKS.firewallRuleName, 'wrong_firewall_rule_name'],
    ['--start-ip', FIREWALL_LOCKS.startIpAddress, 'wrong_start_ip'],
    ['--end-ip', FIREWALL_LOCKS.endIpAddress, 'wrong_end_ip'],
  ];
  for (const [flag, expected, code] of checks) {
    const got = parsed.values[flag];
    if (got !== expected) {
      errors.push({
        code,
        message: `${flag} must be exactly ${expected}`,
        got: got == null ? null : String(got),
      });
    }
  }

  if (isForbiddenAzureServicesRuleName(parsed.values['--firewall-rule-name'])) {
    errors.push({
      code: 'azure_services_rule_rejected',
      message: 'Azure-services firewall rule rejected',
    });
  }

  const ipCheck = assertLockedSingleHostIpv4(
    parsed.values['--start-ip'],
    parsed.values['--end-ip'],
  );
  if (!ipCheck.ok) errors.push(...ipCheck.errors);

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    confirmed: errors.length === 0 ? { ...FIREWALL_LOCKS } : null,
  };
}

function evaluateFirewallApplyGates(opts) {
  const options = opts || {};
  const envGate = evaluateFirewallApplyEnvApproval(options.env || {});
  const exact = evaluateFirewallApplyExactTargets(options.argv || []);
  const errors = [];
  if (!envGate.ok) errors.push(...envGate.errors);
  if (!exact.ok) errors.push(...exact.errors);

  if (PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED === true) {
    errors.push({
      code: 'delete_must_stay_disabled',
      message: 'firewall delete must stay hard-disabled',
    });
  }

  return redactDeep({
    ok: errors.length === 0,
    code: errors.length === 0 ? 'firewall_apply_gates_ok' : 'firewall_apply_gates_rejected',
    errors,
    applyFirewallRule: exact.parsed && exact.parsed.flags.has(CLI_APPLY_FIREWALL_RULE),
    envOk: envGate.ok,
    exactTargetOk: exact.ok,
    confirmed: exact.confirmed,
    liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
    liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
    deleteEnabled: false,
    liveMutation: false,
    defaultEnabled: false,
    httpRequestCount: getFirewallApplyCounters().httpRequestCount,
    pgClientInstantiated: 0,
  }, []);
}

function pickSafeFirewallOutput(obj) {
  const out = {};
  const src = obj && typeof obj === 'object' ? obj : {};
  for (const k of SAFE_OUTPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

function exactFirewallApplyArgv() {
  return [
    CLI_APPLY_FIREWALL_RULE,
    '--subscription', FIREWALL_LOCKS.subscriptionId,
    '--resource-group', FIREWALL_LOCKS.resourceGroup,
    '--vm-resource-group', FIREWALL_LOCKS.vmResourceGroup,
    '--vm-name', FIREWALL_LOCKS.vmName,
    '--managed-identity', FIREWALL_LOCKS.managedIdentityName,
    '--postgres-server', FIREWALL_LOCKS.postgresServer,
    '--firewall-rule-name', FIREWALL_LOCKS.firewallRuleName,
    '--start-ip', FIREWALL_LOCKS.startIpAddress,
    '--end-ip', FIREWALL_LOCKS.endIpAddress,
  ];
}

function firewallApplyEnv(extra) {
  return {
    [ENV_FIREWALL_APPLY]: '1',
    [ENV_SUBSCRIPTION]: FIREWALL_LOCKS.subscriptionId,
    ...(extra || {}),
  };
}

function renderFirewallApplyUsage() {
  return [
    'phase-d:lunabox-pg-firewall-apply — FOUNDATION Slice 14N',
    '',
    'DEFAULT: refused (zero ARM mutation / zero PostgreSQL).',
    '',
    'Approved live apply (exact env + argv):',
    `  ${ENV_FIREWALL_APPLY}=1 ${ENV_SUBSCRIPTION}=${FIREWALL_LOCKS.subscriptionId} \\`,
    '  npm run phase-d:lunabox-pg-firewall-apply -- \\',
    `    ${CLI_APPLY_FIREWALL_RULE} \\`,
    `    --subscription ${FIREWALL_LOCKS.subscriptionId} \\`,
    `    --resource-group ${FIREWALL_LOCKS.resourceGroup} \\`,
    `    --vm-resource-group ${FIREWALL_LOCKS.vmResourceGroup} \\`,
    `    --vm-name ${FIREWALL_LOCKS.vmName} \\`,
    `    --managed-identity ${FIREWALL_LOCKS.managedIdentityName} \\`,
    `    --postgres-server ${FIREWALL_LOCKS.postgresServer} \\`,
    `    --firewall-rule-name ${FIREWALL_LOCKS.firewallRuleName} \\`,
    `    --start-ip ${FIREWALL_LOCKS.startIpAddress} \\`,
    `    --end-ip ${FIREWALL_LOCKS.endIpAddress}`,
    '',
    'One ARM PUT of AllowLunaboxEgress only. No PostgreSQL client. No main.bicep deploy.',
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Assert locked live request shape — reject caller URL/body/token/host drift.
 */
function assertLockedFirewallLiveRequest(req) {
  const purpose = req && req.purpose;
  const method = String((req && req.method) || '').toUpperCase();

  if (purpose === 'outbound_ip_echo_1' || purpose === 'outbound_ip_echo_2') {
    const svc = FIREWALL_LOCKS.outboundIpServices.find((s) => s.purpose === purpose);
    if (!svc || method !== 'GET') {
      throw Object.assign(new Error('outbound IP request rejected'), { code: 'outbound_ip_request_rejected' });
    }
    if (req.hostname !== svc.hostname || req.path !== svc.path) {
      throw Object.assign(new Error('outbound IP host/path drift rejected'), { code: 'outbound_ip_request_rejected' });
    }
    if (req.body != null && String(req.body) !== '') {
      throw Object.assign(new Error('outbound IP body rejected'), { code: 'caller_body_rejected' });
    }
    if (req.url || req.token || req.access_token) {
      throw Object.assign(new Error('caller url/token rejected'), { code: 'caller_token_rejected' });
    }
    return { protocol: 'https:', port: 443, hostname: svc.hostname, path: svc.path, body: null };
  }

  if (purpose === 'imds_arm_token') {
    const imdsUrl = new URL(buildLockedImdsArmTokenUrl());
    if (method !== 'GET'
      || req.hostname !== imdsUrl.hostname
      || `${req.path}` !== `${imdsUrl.pathname}${imdsUrl.search}`) {
      throw Object.assign(new Error('IMDS ARM token request rejected'), { code: 'imds_request_rejected' });
    }
    if (req.body != null && String(req.body) !== '') {
      throw Object.assign(new Error('IMDS body rejected'), { code: 'caller_body_rejected' });
    }
    return {
      protocol: 'http:',
      port: 80,
      hostname: imdsUrl.hostname,
      path: `${imdsUrl.pathname}${imdsUrl.search}`,
      body: null,
    };
  }

  const armPurposes = new Set([
    'server_get_before',
    'server_get_after',
    'firewall_rules_list_before',
    'firewall_rules_list_after',
    'firewall_rule_put',
    'firewall_rule_get_poll',
    'cost_actual_before',
    'cost_amortized_before',
    'cost_actual_after',
    'cost_amortized_after',
  ]);
  if (!armPurposes.has(purpose)) {
    throw Object.assign(new Error(`live HTTP purpose rejected: ${purpose || 'missing'}`), {
      code: 'http_purpose_rejected',
    });
  }

  if (req.hostname !== FIREWALL_LOCKS.managementHostname) {
    throw Object.assign(new Error('ARM hostname drift rejected'), { code: 'arm_host_rejected' });
  }
  if (req.url || req.token || req.access_token) {
    throw Object.assign(new Error('caller url/token rejected'), { code: 'caller_token_rejected' });
  }

  if (purpose.startsWith('cost_')) {
    if (method !== 'POST') {
      throw Object.assign(new Error('cost method must be POST'), { code: 'cost_method_rejected' });
    }
    const lockedPath = buildCostQueryPath();
    if (req.path !== lockedPath) {
      throw Object.assign(new Error('cost path drift rejected'), { code: 'cost_path_rejected' });
    }
    let parsed;
    try {
      parsed = JSON.parse(String(req.body || ''));
    } catch (_) {
      throw Object.assign(new Error('cost body must be locked JSON'), { code: 'caller_body_rejected' });
    }
    const expectType = purpose.includes('amortized') ? 'AmortizedCost' : 'ActualCost';
    if (parsed.type !== expectType
      || parsed.timeframe !== 'Custom'
      || !parsed.timePeriod
      || !parsed.dataset
      || !parsed.dataset.aggregation
      || !parsed.dataset.aggregation.totalCost) {
      throw Object.assign(new Error('cost body shape rejected'), { code: 'caller_body_rejected' });
    }
    return {
      protocol: 'https:',
      port: 443,
      hostname: FIREWALL_LOCKS.managementHostname,
      path: lockedPath,
      body: JSON.stringify(parsed),
    };
  }

  if (purpose === 'firewall_rule_put') {
    if (method !== 'PUT') {
      throw Object.assign(new Error('firewall rule method must be PUT'), { code: 'arm_method_rejected' });
    }
    const lockedPath = buildArmFirewallRulePath();
    if (req.path !== lockedPath) {
      throw Object.assign(new Error('firewall rule path drift rejected'), { code: 'arm_path_rejected' });
    }
    let parsed;
    try {
      parsed = JSON.parse(String(req.body || ''));
    } catch (_) {
      throw Object.assign(new Error('firewall PUT body must be JSON'), { code: 'caller_body_rejected' });
    }
    const props = parsed && parsed.properties;
    if (!props
      || props.startIpAddress !== FIREWALL_LOCKS.startIpAddress
      || props.endIpAddress !== FIREWALL_LOCKS.endIpAddress
      || Object.keys(parsed).some((k) => k !== 'properties')
      || Object.keys(props).some((k) => k !== 'startIpAddress' && k !== 'endIpAddress')) {
      throw Object.assign(new Error('firewall PUT body rejected'), { code: 'caller_body_rejected' });
    }
    return {
      protocol: 'https:',
      port: 443,
      hostname: FIREWALL_LOCKS.managementHostname,
      path: lockedPath,
      body: JSON.stringify({
        properties: {
          startIpAddress: FIREWALL_LOCKS.startIpAddress,
          endIpAddress: FIREWALL_LOCKS.endIpAddress,
        },
      }),
    };
  }

  if (method === 'DELETE') {
    throw Object.assign(new Error('DELETE rejected'), { code: 'delete_rejected' });
  }
  if (method !== 'GET') {
    throw Object.assign(new Error('ARM method rejected'), { code: 'arm_method_rejected' });
  }

  let lockedPath;
  if (purpose === 'server_get_before' || purpose === 'server_get_after') {
    lockedPath = buildArmServerPath();
  } else if (purpose === 'firewall_rules_list_before' || purpose === 'firewall_rules_list_after') {
    lockedPath = buildArmFirewallRulesListPath();
  } else if (purpose === 'firewall_rule_get_poll') {
    lockedPath = buildArmFirewallRulePath();
  }
  if (req.path !== lockedPath) {
    throw Object.assign(new Error('ARM path drift rejected'), { code: 'arm_path_rejected' });
  }
  if (req.body != null && String(req.body) !== '') {
    throw Object.assign(new Error('ARM GET body rejected'), { code: 'caller_body_rejected' });
  }
  return {
    protocol: 'https:',
    port: 443,
    hostname: FIREWALL_LOCKS.managementHostname,
    path: lockedPath,
    body: null,
  };
}

function createLiveFirewallHttpRequest() {
  let putCountLocal = 0;

  async function httpRequest(req) {
    const locked = assertLockedFirewallLiveRequest(req);
    const method = String(req.method || '').toUpperCase();
    if (method === 'PUT') {
      putCountLocal += 1;
      if (putCountLocal > 1) {
        throw Object.assign(new Error('exactly one PUT allowed — retries rejected'), {
          code: 'http_retry_rejected',
        });
      }
    }
    if (method === 'DELETE') {
      throw Object.assign(new Error('DELETE rejected'), { code: 'delete_rejected' });
    }

    const lib = locked.protocol === 'https:' ? https : http;
    const headers = { ...(req.headers || {}) };
    if (locked.body != null) {
      headers['Content-Length'] = Buffer.byteLength(locked.body);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };
      const nodeReq = lib.request({
        hostname: locked.hostname,
        port: locked.port,
        path: locked.path,
        method,
        headers,
        timeout: 30000,
      }, (res) => {
        const statusCode = Number(res.statusCode);
        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          finish(Object.assign(new Error('http redirect rejected'), {
            code: 'http_redirect_rejected',
          }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); });
        res.on('end', () => {
          finish(null, { statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', (err) => {
          finish(Object.assign(
            new Error(String((err && err.message) || err || 'http response failed').slice(0, 240)),
            { code: 'http_request_failed' },
          ));
        });
      });
      nodeReq.on('timeout', () => {
        nodeReq.destroy();
        finish(Object.assign(new Error('http request timeout'), { code: 'http_request_failed' }));
      });
      nodeReq.on('error', (err) => {
        finish(Object.assign(
          new Error(String((err && err.message) || err || 'http request failed').slice(0, 240)),
          { code: 'http_request_failed' },
        ));
      });
      if (locked.body != null) nodeReq.write(locked.body);
      nodeReq.end();
    });
  }

  httpRequest.getPutCount = () => putCountLocal;
  return httpRequest;
}

function resolveFirewallHttpRequest(opts) {
  const options = opts || {};
  if (options.offline === true || options.forbidLiveHttp === true) {
    if (typeof options.httpRequest === 'function') {
      return { httpRequest: options.httpRequest, usedLiveHttp: false };
    }
    return { httpRequest: null, usedLiveHttp: false };
  }
  if (typeof options.httpRequest === 'function') {
    return { httpRequest: options.httpRequest, usedLiveHttp: false };
  }
  if (PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true
    && PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true) {
    return { httpRequest: createLiveFirewallHttpRequest(), usedLiveHttp: true };
  }
  return { httpRequest: null, usedLiveHttp: false };
}

function createInjectedFirewallHttp(script) {
  const s = script || {};
  const calls = [];
  let putCountLocal = 0;
  let pollIdx = 0;

  const serverBody = JSON.stringify({
    name: FIREWALL_LOCKS.postgresServer,
    id: buildPostgresServerResourceId(),
    properties: {
      state: s.serverState || 'Ready',
      fullyQualifiedDomainName: FIREWALL_LOCKS.postgresHost,
      network: {
        publicNetworkAccess: s.publicNetworkAccess || 'Enabled',
      },
    },
  });

  const existingRules = (s.existingRules || FIREWALL_LOCKS.existingRules).map((r) => ({
    name: r.name,
    id: `${buildPostgresServerResourceId()}/firewallRules/${r.name}`,
    properties: {
      startIpAddress: r.startIpAddress,
      endIpAddress: r.endIpAddress,
    },
  }));

  function listBody(includeThird) {
    const value = existingRules.slice();
    if (includeThird) {
      value.push({
        name: FIREWALL_LOCKS.firewallRuleName,
        id: buildFirewallRuleResourceId(),
        properties: {
          startIpAddress: FIREWALL_LOCKS.startIpAddress,
          endIpAddress: FIREWALL_LOCKS.endIpAddress,
        },
      });
    }
    return JSON.stringify({ value });
  }

  function ruleBody(state) {
    return JSON.stringify({
      name: FIREWALL_LOCKS.firewallRuleName,
      id: buildFirewallRuleResourceId(),
      properties: {
        startIpAddress: FIREWALL_LOCKS.startIpAddress,
        endIpAddress: FIREWALL_LOCKS.endIpAddress,
        provisioningState: state || 'Succeeded',
      },
    });
  }

  function costBody(amount) {
    return JSON.stringify({
      properties: {
        columns: [
          { name: 'Cost', type: 'Number' },
          { name: 'Currency', type: 'String' },
        ],
        rows: [[amount, s.costCurrency || 'USD']],
      },
    });
  }

  async function httpRequest(req) {
    const request = req || {};
    const method = String(request.method || 'GET').toUpperCase();
    calls.push({
      purpose: request.purpose || null,
      hostname: request.hostname || null,
      path: request.path ? String(request.path).split('?')[0] : null,
      method,
      hasAuthorization: Boolean(request.headers && request.headers.Authorization),
    });

    if (s.throwOn && s.throwOn === request.purpose) {
      throw Object.assign(new Error(s.throwMessage || 'injected failure'), {
        code: s.throwCode || 'injected_failure',
      });
    }

    if (method === 'DELETE') {
      return { statusCode: 405, body: JSON.stringify({ error: 'delete_rejected' }) };
    }

    if (request.purpose === 'outbound_ip_echo_1' || request.purpose === 'outbound_ip_echo_2') {
      const ip = s.outboundIp != null ? String(s.outboundIp) : FIREWALL_LOCKS.expectedOutboundIpv4;
      if (s.outboundIpMismatch && request.purpose === 'outbound_ip_echo_2') {
        return { statusCode: 200, body: '1.2.3.4' };
      }
      return { statusCode: 200, body: ip };
    }

    if (request.purpose === 'imds_arm_token') {
      return {
        statusCode: 200,
        body: JSON.stringify({ access_token: s.imdsAccessToken || 'slice14n-proof-imds-token-never-commit' }),
      };
    }

    if (request.purpose === 'server_get_before' || request.purpose === 'server_get_after') {
      return { statusCode: 200, body: serverBody };
    }

    if (request.purpose === 'firewall_rules_list_before') {
      return { statusCode: 200, body: listBody(false) };
    }
    if (request.purpose === 'firewall_rules_list_after') {
      return { statusCode: 200, body: listBody(true) };
    }

    if (request.purpose === 'firewall_rule_put') {
      putCountLocal += 1;
      if (putCountLocal > 1) {
        return { statusCode: 429, body: JSON.stringify({ error: 'retry_rejected' }) };
      }
      if (s.putStatusCode && ![200, 201, 202].includes(Number(s.putStatusCode))) {
        return { statusCode: s.putStatusCode, body: JSON.stringify({ error: 'put_failed' }) };
      }
      return { statusCode: s.putStatusCode || 202, body: ruleBody('Updating') };
    }

    if (request.purpose === 'firewall_rule_get_poll') {
      pollIdx += 1;
      const states = s.pollStates || ['Updating', 'Succeeded'];
      const state = states[Math.min(pollIdx - 1, states.length - 1)];
      if (s.pollNotFound) {
        return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
      }
      return { statusCode: 200, body: ruleBody(state) };
    }

    if (request.purpose && request.purpose.startsWith('cost_')) {
      const before = request.purpose.includes('before');
      const amount = before
        ? (s.costBeforeAmount != null ? s.costBeforeAmount : 10)
        : (s.costAfterAmount != null ? s.costAfterAmount : 10);
      return { statusCode: 200, body: costBody(amount) };
    }

    return { statusCode: 404, body: JSON.stringify({ error: 'unknown_purpose' }) };
  }

  httpRequest.calls = calls;
  httpRequest.getPutCount = () => putCountLocal;
  return httpRequest;
}

function buildSafeCostSnapshot(type, period, parsed) {
  return {
    type,
    scope: `/subscriptions/${FIREWALL_LOCKS.subscriptionId}/resourceGroups/${FIREWALL_LOCKS.resourceGroup}`,
    period: { from: period.from, to: period.to, label: period.label },
    amount: parsed.amount,
    currency: parsed.currency,
  };
}

function computeCostDelta(before, after) {
  const out = {
    actualAmountDelta: null,
    amortizedAmountDelta: null,
    currency: null,
    flagged: false,
  };
  if (before && after && before.actual && after.actual) {
    out.actualAmountDelta = Number(after.actual.amount) - Number(before.actual.amount);
    out.currency = after.actual.currency || before.actual.currency;
  }
  if (before && after && before.amortized && after.amortized) {
    out.amortizedAmountDelta = Number(after.amortized.amount) - Number(before.amortized.amount);
    out.currency = out.currency || after.amortized.currency || before.amortized.currency;
  }
  out.flagged = (out.actualAmountDelta != null && out.actualAmountDelta !== 0)
    || (out.amortizedAmountDelta != null && out.amortizedAmountDelta !== 0);
  return out;
}

async function executeLunaboxPgFirewallApply(opts) {
  const options = opts || {};
  const countersBefore = getFirewallApplyCounters();
  const secrets = [];
  const privateBag = { _token: null };

  const gates = evaluateFirewallApplyGates({
    env: options.env,
    argv: options.argv,
  });
  if (!gates.ok) {
    return pickSafeFirewallOutput({
      ok: false,
      code: 'firewall_apply_gates_rejected',
      applyFirewallRule: gates.applyFirewallRule === true,
      liveApplyEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED === true,
      liveHttpEnabled: PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED === true,
      deleteEnabled: false,
      liveMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp: false,
      realImdsCall: false,
      realArmCall: false,
      realCostCall: false,
      realOutboundIpCall: false,
      realPostgresCall: false,
      pgClientInstantiated: 0,
      httpRequestCount: 0,
      putCount: 0,
      retries: 0,
      errors: gates.errors,
      message: 'firewall apply gates rejected — zero ARM mutation',
      note: 'gates failed — zero mutation',
      privateRefsZeroed: true,
      firewallRuleExpectedDirectCharge: false,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
      subscriptionId: FIREWALL_LOCKS.subscriptionId,
      resourceGroup: FIREWALL_LOCKS.resourceGroup,
      postgresServer: FIREWALL_LOCKS.postgresServer,
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
    });
  }

  const resolved = resolveFirewallHttpRequest(options);
  if (!resolved.httpRequest) {
    return pickSafeFirewallOutput({
      ok: false,
      code: 'http_transport_unavailable',
      applyFirewallRule: true,
      liveMutation: false,
      networkMutation: false,
      firewallAction: false,
      usedLiveHttp: false,
      message: 'http transport unavailable — zero mutation',
      privateRefsZeroed: true,
      pgClientInstantiated: 0,
      firewallRuleExpectedDirectCharge: false,
    });
  }
  const httpRequest = resolved.httpRequest;
  const usedLiveHttp = resolved.usedLiveHttp === true;
  const pollDelayMs = options.pollDelayMs != null
    ? Number(options.pollDelayMs)
    : (usedLiveHttp ? FIREWALL_LOCKS.pollDelayMs : 0);

  const fail = (code, message, extra) => {
    privateBag._token = null;
    const counters = getFirewallApplyCounters();
    const didPut = (counters.armPutCount > countersBefore.armPutCount)
      || (counters.putCount > countersBefore.putCount);
    return pickSafeFirewallOutput({
      ok: false,
      code,
      applyFirewallRule: true,
      liveApplyEnabled: true,
      liveHttpEnabled: true,
      deleteEnabled: false,
      liveMutation: didPut,
      networkMutation: didPut,
      firewallAction: didPut,
      usedLiveHttp,
      realImdsCall: usedLiveHttp && (counters.imdsRequestCount > countersBefore.imdsRequestCount),
      realArmCall: usedLiveHttp && (
        (counters.armGetCount > countersBefore.armGetCount)
        || (counters.armPutCount > countersBefore.armPutCount)
      ),
      realCostCall: usedLiveHttp && (counters.costPostCount > countersBefore.costPostCount),
      realOutboundIpCall: usedLiveHttp && (counters.outboundIpGetCount > countersBefore.outboundIpGetCount),
      realPostgresCall: false,
      pgClientInstantiated: 0,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
      armGetCount: counters.armGetCount - countersBefore.armGetCount,
      armPutCount: counters.armPutCount - countersBefore.armPutCount,
      armDeleteCount: 0,
      costPostCount: counters.costPostCount - countersBefore.costPostCount,
      outboundIpGetCount: counters.outboundIpGetCount - countersBefore.outboundIpGetCount,
      putCount: counters.putCount - countersBefore.putCount,
      ruleGetPollCount: counters.ruleGetPollCount - countersBefore.ruleGetPollCount,
      retries: 0,
      errors: [{ code, message }],
      message,
      note: extra && extra.note,
      privateRefsZeroed: true,
      firewallRuleExpectedDirectCharge: false,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
      subscriptionId: FIREWALL_LOCKS.subscriptionId,
      resourceGroup: FIREWALL_LOCKS.resourceGroup,
      vmResourceGroup: FIREWALL_LOCKS.vmResourceGroup,
      vmName: FIREWALL_LOCKS.vmName,
      managedIdentityName: FIREWALL_LOCKS.managedIdentityName,
      managedIdentityClientId: FIREWALL_LOCKS.managedIdentityClientId,
      postgresServer: FIREWALL_LOCKS.postgresServer,
      postgresHost: FIREWALL_LOCKS.postgresHost,
      postgresServerResourceId: buildPostgresServerResourceId(),
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      firewallRuleResourceId: buildFirewallRuleResourceId(),
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
      ...(extra || {}),
    });
  };

  try {
    // 1) Inspect server + firewall (read-only)
    httpRequestCount += 1;
    imdsRequestCount += 1;
    const imdsUrl = new URL(buildLockedImdsArmTokenUrl());
    const imdsRes = await httpRequest({
      purpose: 'imds_arm_token',
      method: 'GET',
      hostname: imdsUrl.hostname,
      path: `${imdsUrl.pathname}${imdsUrl.search}`,
      headers: { Metadata: 'true' },
    });
    if (!imdsRes || Number(imdsRes.statusCode) !== 200) {
      return fail('imds_http_rejected', 'IMDS ARM token GET rejected');
    }
    const imdsBody = JSON.parse(String(imdsRes.body || ''));
    const token = imdsBody && imdsBody.access_token ? String(imdsBody.access_token) : null;
    if (!token) return fail('imds_token_missing', 'IMDS access_token missing');
    secrets.push(token);
    privateBag._token = token;

    httpRequestCount += 1;
    armGetCount += 1;
    const serverBeforeRes = await httpRequest({
      purpose: 'server_get_before',
      method: 'GET',
      hostname: FIREWALL_LOCKS.managementHostname,
      path: buildArmServerPath(),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!serverBeforeRes || Number(serverBeforeRes.statusCode) !== 200) {
      return fail('server_get_rejected', 'PostgreSQL server GET rejected');
    }
    const serverBefore = JSON.parse(String(serverBeforeRes.body || ''));
    const stateBefore = serverBefore.properties && serverBefore.properties.state;
    const pnaBefore = serverBefore.properties
      && serverBefore.properties.network
      && serverBefore.properties.network.publicNetworkAccess;
    if (stateBefore !== 'Ready') {
      return fail('server_not_ready', 'PostgreSQL server not Ready — zero mutation', {
        serverStateBefore: stateBefore || null,
        publicNetworkAccessBefore: pnaBefore || null,
      });
    }
    if (pnaBefore !== 'Enabled') {
      return fail('public_network_access_unexpected', 'publicNetworkAccess must be Enabled', {
        serverStateBefore: stateBefore,
        publicNetworkAccessBefore: pnaBefore || null,
      });
    }

    httpRequestCount += 1;
    armGetCount += 1;
    const rulesBeforeRes = await httpRequest({
      purpose: 'firewall_rules_list_before',
      method: 'GET',
      hostname: FIREWALL_LOCKS.managementHostname,
      path: buildArmFirewallRulesListPath(),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rulesBeforeRes || Number(rulesBeforeRes.statusCode) !== 200) {
      return fail('firewall_list_rejected', 'firewall rules list GET rejected');
    }
    const rulesBeforeBody = JSON.parse(String(rulesBeforeRes.body || ''));
    const beforeExtract = extractExistingLockedRules(rulesBeforeBody.value || []);
    if (!beforeExtract.ok) {
      return fail(beforeExtract.code, beforeExtract.errors[0].message, {
        serverStateBefore: stateBefore,
        publicNetworkAccessBefore: pnaBefore,
        existingRulesBefore: beforeExtract.rules || [],
        rulesBeforeCount: (beforeExtract.rules || []).length,
      });
    }
    const thirdBefore = (beforeExtract.all || []).find(
      (r) => r.name === FIREWALL_LOCKS.firewallRuleName,
    );
    if (thirdBefore
      && !rulesByteSemanticEqual(thirdBefore, {
        name: FIREWALL_LOCKS.firewallRuleName,
        startIpAddress: FIREWALL_LOCKS.startIpAddress,
        endIpAddress: FIREWALL_LOCKS.endIpAddress,
      })) {
      return fail('third_rule_conflict', 'AllowLunaboxEgress exists with unexpected IPs — refuse', {
        serverStateBefore: stateBefore,
        publicNetworkAccessBefore: pnaBefore,
        existingRulesBefore: beforeExtract.rules,
        rulesBeforeCount: beforeExtract.rules.length,
      });
    }
    for (const r of beforeExtract.all || []) {
      if (isForbiddenAzureServicesRuleName(r.name)
        || r.startIpAddress === '0.0.0.0'
        || r.endIpAddress === '0.0.0.0') {
        return fail('azure_services_or_zero_rule_present', 'forbidden Azure-services/0.0.0.0 rule present');
      }
    }

    // 2) Independent outbound IPv4 from two HTTPS services
    const outboundIps = [];
    for (const svc of FIREWALL_LOCKS.outboundIpServices) {
      httpRequestCount += 1;
      outboundIpGetCount += 1;
      const ipRes = await httpRequest({
        purpose: svc.purpose,
        method: 'GET',
        hostname: svc.hostname,
        path: svc.path,
        headers: { Accept: 'text/plain' },
      });
      if (!ipRes || Number(ipRes.statusCode) !== 200) {
        return fail('outbound_ip_http_rejected', `outbound IP service ${svc.name} rejected`, {
          serverStateBefore: stateBefore,
          publicNetworkAccessBefore: pnaBefore,
          existingRulesBefore: beforeExtract.rules,
          rulesBeforeCount: beforeExtract.rules.length,
        });
      }
      const ip = String(ipRes.body || '').trim();
      if (!isExactIpv4(ip) || ip.includes(':')) {
        return fail('outbound_ip_not_ipv4', `outbound IP service ${svc.name} did not return exact IPv4`, {
          serverStateBefore: stateBefore,
          publicNetworkAccessBefore: pnaBefore,
          existingRulesBefore: beforeExtract.rules,
        });
      }
      outboundIps.push(ip);
    }
    if (outboundIps[0] !== FIREWALL_LOCKS.expectedOutboundIpv4
      || outboundIps[1] !== FIREWALL_LOCKS.expectedOutboundIpv4) {
      return fail('outbound_ip_mismatch', 'outbound IPv4 must equal locked 20.238.124.76 on both services — zero mutation', {
        outboundIpv4Service1: outboundIps[0],
        outboundIpv4Service2: outboundIps[1],
        outboundIpv4Matched: false,
        serverStateBefore: stateBefore,
        publicNetworkAccessBefore: pnaBefore,
        existingRulesBefore: beforeExtract.rules,
        rulesBeforeCount: beforeExtract.rules.length,
        liveMutation: false,
        networkMutation: false,
        firewallAction: false,
      });
    }

    // 3) Cost before (actual + amortized)
    const period = monthToDatePeriod();
    async function postCost(purpose, type) {
      httpRequestCount += 1;
      costPostCount += 1;
      const body = JSON.stringify(buildLockedCostQueryBody(type, period));
      const res = await httpRequest({
        purpose,
        method: 'POST',
        hostname: FIREWALL_LOCKS.managementHostname,
        path: buildCostQueryPath(),
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      const status = res ? Number(res.statusCode) : 0;
      if (!res || status !== 200) {
        // No retries — including 429. Fail closed with safe status only.
        return {
          ok: false,
          code: status === 429 ? 'cost_throttled' : 'cost_http_rejected',
        };
      }
      const parsed = parseCostRow(res.body);
      if (!parsed.ok) return parsed;
      return { ok: true, snapshot: buildSafeCostSnapshot(type, period, parsed) };
    }

    const costActualBefore = await postCost('cost_actual_before', 'ActualCost');
    if (!costActualBefore.ok) {
      return fail(costActualBefore.code || 'cost_before_failed', 'ActualCost before snapshot failed');
    }
    const costAmortBefore = await postCost('cost_amortized_before', 'AmortizedCost');
    if (!costAmortBefore.ok) {
      return fail(costAmortBefore.code || 'cost_before_failed', 'AmortizedCost before snapshot failed');
    }
    const costBefore = {
      actual: costActualBefore.snapshot,
      amortized: costAmortBefore.snapshot,
    };

    // 4) Exactly one PUT
    httpRequestCount += 1;
    armPutCount += 1;
    putCount += 1;
    const putBody = JSON.stringify({
      properties: {
        startIpAddress: FIREWALL_LOCKS.startIpAddress,
        endIpAddress: FIREWALL_LOCKS.endIpAddress,
      },
    });
    const putRes = await httpRequest({
      purpose: 'firewall_rule_put',
      method: 'PUT',
      hostname: FIREWALL_LOCKS.managementHostname,
      path: buildArmFirewallRulePath(),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: putBody,
    });
    if (!putRes || ![200, 201, 202].includes(Number(putRes.statusCode))) {
      return fail('firewall_put_rejected', 'firewall rule PUT rejected', {
        costBefore,
        outboundIpv4Service1: outboundIps[0],
        outboundIpv4Service2: outboundIps[1],
        outboundIpv4Matched: true,
        serverStateBefore: stateBefore,
        publicNetworkAccessBefore: pnaBefore,
        existingRulesBefore: beforeExtract.rules,
        rulesBeforeCount: beforeExtract.rules.length,
      });
    }

    // 5) Poll only exact rule GET to terminal state
    let terminalRule = null;
    for (let attempt = 1; attempt <= FIREWALL_LOCKS.maxRulePollAttempts; attempt += 1) {
      if (attempt > 1 && pollDelayMs > 0) await sleep(pollDelayMs);
      httpRequestCount += 1;
      armGetCount += 1;
      ruleGetPollCount += 1;
      const pollRes = await httpRequest({
        purpose: 'firewall_rule_get_poll',
        method: 'GET',
        hostname: FIREWALL_LOCKS.managementHostname,
        path: buildArmFirewallRulePath(),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!pollRes || Number(pollRes.statusCode) !== 200) {
        if (attempt === FIREWALL_LOCKS.maxRulePollAttempts) {
          return fail('firewall_rule_poll_failed', 'exact rule GET did not reach terminal state', {
            costBefore,
            putCount: 1,
            ruleGetPollCount: attempt,
          });
        }
        continue;
      }
      const pollBody = JSON.parse(String(pollRes.body || ''));
      const normalized = normalizeFirewallRule(pollBody);
      const prov = pollBody.properties && pollBody.properties.provisioningState;
      const ipsOk = normalized
        && normalized.name === FIREWALL_LOCKS.firewallRuleName
        && normalized.startIpAddress === FIREWALL_LOCKS.startIpAddress
        && normalized.endIpAddress === FIREWALL_LOCKS.endIpAddress;
      const stateOk = !prov || prov === 'Succeeded' || prov === 'Ready';
      if (ipsOk && stateOk) {
        terminalRule = normalized;
        break;
      }
      if (attempt === FIREWALL_LOCKS.maxRulePollAttempts) {
        return fail('firewall_rule_poll_exhausted', 'bounded rule GET polls exhausted without terminal state', {
          costBefore,
          putCount: 1,
          ruleGetPollCount: attempt,
        });
      }
    }
    if (!terminalRule) {
      return fail('firewall_rule_not_terminal', 'exact rule never reached terminal state');
    }

    // 6) Verify server + full rule set
    httpRequestCount += 1;
    armGetCount += 1;
    const serverAfterRes = await httpRequest({
      purpose: 'server_get_after',
      method: 'GET',
      hostname: FIREWALL_LOCKS.managementHostname,
      path: buildArmServerPath(),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!serverAfterRes || Number(serverAfterRes.statusCode) !== 200) {
      return fail('server_get_after_rejected', 'PostgreSQL server GET after rejected');
    }
    const serverAfter = JSON.parse(String(serverAfterRes.body || ''));
    const stateAfter = serverAfter.properties && serverAfter.properties.state;
    const pnaAfter = serverAfter.properties
      && serverAfter.properties.network
      && serverAfter.properties.network.publicNetworkAccess;

    httpRequestCount += 1;
    armGetCount += 1;
    const rulesAfterRes = await httpRequest({
      purpose: 'firewall_rules_list_after',
      method: 'GET',
      hostname: FIREWALL_LOCKS.managementHostname,
      path: buildArmFirewallRulesListPath(),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!rulesAfterRes || Number(rulesAfterRes.statusCode) !== 200) {
      return fail('firewall_list_after_rejected', 'firewall rules list GET after rejected');
    }
    const rulesAfterBody = JSON.parse(String(rulesAfterRes.body || ''));
    const afterExtract = extractExistingLockedRules(rulesAfterBody.value || []);
    if (!afterExtract.ok) {
      return fail('existing_rules_changed', 'existing firewall rules changed after apply', {
        existingRulesBefore: beforeExtract.rules,
        existingRulesAfter: afterExtract.rules || [],
        rulesBeforeCount: beforeExtract.rules.length,
        rulesAfterCount: (afterExtract.rules || []).length,
      });
    }
    const thirdAfter = (afterExtract.all || []).find(
      (r) => r.name === FIREWALL_LOCKS.firewallRuleName,
    );
    const thirdExact = Boolean(
      thirdAfter
      && rulesByteSemanticEqual(thirdAfter, {
        name: FIREWALL_LOCKS.firewallRuleName,
        startIpAddress: FIREWALL_LOCKS.startIpAddress,
        endIpAddress: FIREWALL_LOCKS.endIpAddress,
      }),
    );
    if (!thirdExact) {
      return fail('third_rule_missing_or_wrong', 'AllowLunaboxEgress missing or not exact after apply');
    }
    const ruleSnapshots = buildExistingRuleSnapshots(beforeExtract, afterExtract, thirdAfter);
    if ((afterExtract.all || []).length !== FIREWALL_LOCKS.existingRules.length + 1) {
      return fail('unrelated_rule_change', 'unexpected firewall rule count after apply — refuse unrelated change');
    }
    if (ruleSnapshots.rulesBeforeCount !== FIREWALL_LOCKS.existingRules.length
      || ruleSnapshots.rulesAfterCount !== FIREWALL_LOCKS.existingRules.length + 1) {
      return fail('rule_snapshot_count_mismatch', 'before/after rule snapshot counts must be 2→3');
    }
    if (stateAfter !== 'Ready' || pnaAfter !== pnaBefore) {
      return fail('server_postcondition_failed', 'server Ready/publicNetworkAccess postcondition failed', {
        serverStateAfter: stateAfter || null,
        publicNetworkAccessAfter: pnaAfter || null,
      });
    }

    // 7) Cost after — bounded cooldown between before/after (not a retry of a
    // failed request). Cost Management throttles burst POSTs; spacing is required.
    const costAfterCooldownMs = options.costAfterCooldownMs != null
      ? Number(options.costAfterCooldownMs)
      : (usedLiveHttp ? 45000 : 0);
    if (costAfterCooldownMs > 0) await sleep(costAfterCooldownMs);

    const costActualAfter = await postCost('cost_actual_after', 'ActualCost');
    if (!costActualAfter.ok) {
      return fail(costActualAfter.code || 'cost_after_failed', 'ActualCost after snapshot failed', {
        costBefore,
        putCount: 1,
        thirdRuleExact: true,
        existingRulesUnchanged: true,
        serverRemainedReady: stateAfter === 'Ready',
        publicNetworkAccessUnchanged: pnaBefore === pnaAfter,
      });
    }
    const costAmortAfter = await postCost('cost_amortized_after', 'AmortizedCost');
    if (!costAmortAfter.ok) {
      return fail(costAmortAfter.code || 'cost_after_failed', 'AmortizedCost after snapshot failed', {
        costBefore,
        putCount: 1,
        thirdRuleExact: true,
      });
    }
    const costAfter = {
      actual: costActualAfter.snapshot,
      amortized: costAmortAfter.snapshot,
    };
    const costDelta = computeCostDelta(costBefore, costAfter);

    privateBag._token = null;
    const counters = getFirewallApplyCounters();
    const deltaPut = counters.putCount - countersBefore.putCount;
    if (deltaPut !== 1) {
      return fail('put_count_integrity_failed', `expected exactly 1 PUT, got ${deltaPut}`);
    }

    return pickSafeFirewallOutput({
      ok: true,
      code: 'lunabox_pg_firewall_apply_ok',
      applyFirewallRule: true,
      liveApplyEnabled: true,
      liveHttpEnabled: true,
      deleteEnabled: false,
      liveMutation: true,
      networkMutation: true,
      firewallAction: true,
      usedLiveHttp,
      realImdsCall: usedLiveHttp,
      realArmCall: usedLiveHttp,
      realCostCall: usedLiveHttp,
      realOutboundIpCall: usedLiveHttp,
      realPostgresCall: false,
      pgClientInstantiated: 0,
      httpRequestCount: counters.httpRequestCount - countersBefore.httpRequestCount,
      imdsRequestCount: counters.imdsRequestCount - countersBefore.imdsRequestCount,
      armGetCount: counters.armGetCount - countersBefore.armGetCount,
      armPutCount: counters.armPutCount - countersBefore.armPutCount,
      armDeleteCount: 0,
      costPostCount: counters.costPostCount - countersBefore.costPostCount,
      outboundIpGetCount: counters.outboundIpGetCount - countersBefore.outboundIpGetCount,
      putCount: 1,
      ruleGetPollCount: counters.ruleGetPollCount - countersBefore.ruleGetPollCount,
      retries: 0,
      subscriptionId: FIREWALL_LOCKS.subscriptionId,
      resourceGroup: FIREWALL_LOCKS.resourceGroup,
      vmResourceGroup: FIREWALL_LOCKS.vmResourceGroup,
      vmName: FIREWALL_LOCKS.vmName,
      managedIdentityName: FIREWALL_LOCKS.managedIdentityName,
      managedIdentityClientId: FIREWALL_LOCKS.managedIdentityClientId,
      postgresServer: FIREWALL_LOCKS.postgresServer,
      postgresHost: FIREWALL_LOCKS.postgresHost,
      postgresServerResourceId: buildPostgresServerResourceId(),
      firewallRuleName: FIREWALL_LOCKS.firewallRuleName,
      firewallRuleResourceId: buildFirewallRuleResourceId(),
      startIpAddress: FIREWALL_LOCKS.startIpAddress,
      endIpAddress: FIREWALL_LOCKS.endIpAddress,
      outboundIpv4Service1: outboundIps[0],
      outboundIpv4Service2: outboundIps[1],
      outboundIpv4Matched: true,
      serverStateBefore: stateBefore,
      serverStateAfter: stateAfter,
      publicNetworkAccessBefore: pnaBefore,
      publicNetworkAccessAfter: pnaAfter,
      publicNetworkAccessUnchanged: pnaBefore === pnaAfter,
      serverRemainedReady: stateAfter === 'Ready',
      existingRulesBefore: ruleSnapshots.existingRulesBefore,
      existingRulesAfter: ruleSnapshots.existingRulesAfter,
      existingRulesUnchanged: true,
      rulesBeforeCount: ruleSnapshots.rulesBeforeCount,
      rulesAfterCount: ruleSnapshots.rulesAfterCount,
      thirdRuleExact: true,
      costBefore,
      costAfter,
      costDelta,
      costDeltaFlagged: costDelta.flagged === true,
      firewallRuleExpectedDirectCharge: false,
      bicepModuleRel: FIREWALL_LOCKS.bicepModuleRel,
      privateRefsZeroed: true,
      note: 'Exactly one AllowLunaboxEgress PUT; no PostgreSQL client; existing two rules unchanged; firewall rule has no expected direct charge',
    });
  } catch (err) {
    const safe = sanitizeFirewallError(err, secrets);
    return fail(safe.code, safe.message);
  } finally {
    privateBag._token = null;
  }
}

function assertBicepFirewallModuleLocked(repoRoot) {
  const root = repoRoot || path.join(__dirname, '..', '..');
  const bicepPath = path.join(root, FIREWALL_LOCKS.bicepModuleRel);
  const paramsPath = path.join(root, FIREWALL_LOCKS.bicepParametersRel);
  const bicep = fs.readFileSync(bicepPath, 'utf8');
  const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'));
  const errors = [];
  if (!bicep.includes("existing = {")) {
    errors.push({ code: 'bicep_must_reference_existing_server', message: 'bicep must use existing server' });
  }
  if (!bicep.includes('firewallRules@2023-06-01-preview')) {
    errors.push({ code: 'bicep_firewall_api_missing', message: 'bicep firewall API version missing' });
  }
  if (/^module\s+/m.test(bicep)) {
    errors.push({ code: 'bicep_must_stay_standalone', message: 'bicep must not declare modules' });
  }
  if (/module\s+\w+\s+'main\.bicep'/.test(bicep)) {
    errors.push({ code: 'bicep_must_stay_standalone', message: 'bicep must not wire main.bicep' });
  }
  const p = params.parameters || {};
  if (p.firewallRuleName?.value !== FIREWALL_LOCKS.firewallRuleName
    || p.startIpAddress?.value !== FIREWALL_LOCKS.startIpAddress
    || p.endIpAddress?.value !== FIREWALL_LOCKS.endIpAddress
    || p.postgresServerName?.value !== FIREWALL_LOCKS.postgresServer) {
    errors.push({ code: 'bicep_params_lock_mismatch', message: 'bicep parameters lock mismatch' });
  }
  return { ok: errors.length === 0, errors, bicepPath, paramsPath };
}

module.exports = {
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_APPLY_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_LIVE_HTTP_ENABLED,
  PHASE_D_LUNABOX_PG_FIREWALL_DELETE_ENABLED,
  ENV_FIREWALL_APPLY,
  CLI_APPLY_FIREWALL_RULE,
  FIREWALL_LOCKS,
  FORBIDDEN_ARGV_FLAGS,
  ALLOWED_ARGV_FLAGS,
  SAFE_OUTPUT_KEYS,
  getFirewallApplyCounters,
  resetFirewallApplyCounters,
  buildPostgresServerResourceId,
  buildFirewallRuleResourceId,
  buildLockedImdsArmTokenUrl,
  buildArmServerPath,
  buildArmFirewallRulesListPath,
  buildArmFirewallRulePath,
  buildCostQueryPath,
  buildLockedCostQueryBody,
  monthToDatePeriod,
  assertLockedSingleHostIpv4,
  evaluateFirewallApplyGates,
  evaluateFirewallApplyEnvApproval,
  evaluateFirewallApplyExactTargets,
  exactFirewallApplyArgv,
  firewallApplyEnv,
  renderFirewallApplyUsage,
  pickSafeFirewallOutput,
  assertLockedFirewallLiveRequest,
  createLiveFirewallHttpRequest,
  createInjectedFirewallHttp,
  resolveFirewallHttpRequest,
  executeLunaboxPgFirewallApply,
  assertBicepFirewallModuleLocked,
  normalizeFirewallRule,
  rulesByteSemanticEqual,
  extractExistingLockedRules,
  buildExistingRuleSnapshots,
  computeCostDelta,
};
