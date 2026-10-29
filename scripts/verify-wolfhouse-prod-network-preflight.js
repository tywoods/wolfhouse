'use strict';

/**
 * Read-only Wolfhouse prod network preflight.
 * Never creates, deletes, or recreates docker networks.
 * Stop on mismatch. Does not print secrets.
 */

const assert = require('assert/strict');
const fs = require('fs');

const NETWORK_NAME = 'wolfhouse-prod-private';
const REQUIRED_SUBNET = '172.29.0.0/16';
const OWNED_ADDRESSES = Object.freeze({
  '172.29.0.4': 'wolfhouse-prod-luna',
  '172.29.0.5': 'wolfhouse-prod-ingress',
});

class PreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PreflightError';
    this.code = code;
  }
}

function fail(code) {
  throw new PreflightError(code);
}

function containerName(entry) {
  const raw = String((entry && (entry.Name || entry.name)) || '').replace(/^\//, '');
  return raw;
}

function inspectContainers(inspect) {
  const containers = inspect.Containers;
  if (!containers || typeof containers !== 'object') return [];
  return Object.values(containers);
}

function validateInspect(inspect) {
  if (!inspect || typeof inspect !== 'object') fail('NETWORK_INSPECT_INVALID');
  if (inspect.Name !== NETWORK_NAME && inspect.Name !== `/${NETWORK_NAME}`) fail('NETWORK_NAME_MISMATCH');
  if (inspect.Internal !== true) fail('NETWORK_NOT_INTERNAL');
  const configs = (((inspect.IPAM || {}).Config) || []);
  const subnets = configs.map(row => String((row && row.Subnet) || ''));
  if (!subnets.includes(REQUIRED_SUBNET)) fail('SUBNET_MISMATCH');

  const owners = new Map();
  for (const entry of inspectContainers(inspect)) {
    const ip = String(entry.IPv4Address || '').split('/')[0];
    if (!ip) continue;
    owners.set(ip, containerName(entry));
  }
  for (const [ip, expected] of Object.entries(OWNED_ADDRESSES)) {
    const actual = owners.get(ip);
    if (!actual) continue;
    if (actual !== expected) fail('ADDRESS_FOREIGN_OWNER');
  }
  return {
    name: NETWORK_NAME,
    subnet: REQUIRED_SUBNET,
    internal: true,
  };
}

function fixtureOk() {
  return {
    Name: NETWORK_NAME,
    Internal: true,
    IPAM: { Config: [{ Subnet: REQUIRED_SUBNET, Gateway: '172.29.0.1' }] },
    Containers: {
      luna: { Name: 'wolfhouse-prod-luna', IPv4Address: '172.29.0.4/16' },
      ingress: { Name: 'wolfhouse-prod-ingress', IPv4Address: '172.29.0.5/16' },
    },
  };
}

function expectReject(name, inspect, code) {
  let thrown;
  try { validateInspect(inspect); } catch (error) { thrown = error; }
  if (!(thrown instanceof PreflightError) || thrown.code !== code) {
    throw new Error(`SELF_TEST_EXPECTED_REJECT ${name}`);
  }
  console.log(`PASS negative: ${name}`);
}

function runSelfTest() {
  const ok = validateInspect(fixtureOk());
  assert.equal(ok.subnet, REQUIRED_SUBNET);
  console.log('PASS compatible owned internal network');
  expectReject('not internal', { ...fixtureOk(), Internal: false }, 'NETWORK_NOT_INTERNAL');
  expectReject('wrong subnet', {
    ...fixtureOk(),
    IPAM: { Config: [{ Subnet: '172.18.0.0/16' }] },
  }, 'SUBNET_MISMATCH');
  expectReject('foreign owner', {
    ...fixtureOk(),
    Containers: { x: { Name: 'ovh-wolfhouse-staff', IPv4Address: '172.29.0.5/16' } },
  }, 'ADDRESS_FOREIGN_OWNER');
  expectReject('wrong name', { ...fixtureOk(), Name: 'bridge' }, 'NETWORK_NAME_MISMATCH');
  console.log('\nRESULT: 5/5 network preflight checks passed');
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--inspect-json') options.inspectJson = argv[++i];
    else throw new PreflightError('UNKNOWN_ARGUMENT');
  }
  return options;
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.selfTest) runSelfTest();
    else {
      if (!args.inspectJson) fail('INSPECT_JSON_REQUIRED');
      const inspect = JSON.parse(fs.readFileSync(args.inspectJson, 'utf8'));
      const payload = Array.isArray(inspect) ? inspect[0] : inspect;
      validateInspect(payload);
      console.log('PASS wolfhouse-prod-private preflight');
    }
  } catch (error) {
    const code = error instanceof PreflightError ? error.code : 'PREFLIGHT_INTERNAL';
    console.error(`FAIL Wolfhouse production network preflight: ${code}`);
    process.exitCode = 1;
  }
}

module.exports = { validateInspect, PreflightError };
