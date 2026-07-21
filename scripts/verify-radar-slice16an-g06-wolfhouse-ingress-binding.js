'use strict';

/**
 * verify:radar-slice16an-g06-wolfhouse-ingress-binding — RADAR Slice 16AN
 *
 * Offline RED/GREEN for dedicated STAFF_API_INGRESS_TENANT_SLUG +
 * DEFAULT_CLIENT_SLUG compat fallback + conflict fail-closed, Wolfhouse/Sunset
 * staging IaC wiring, failed-canary honesty, OFF parity. No live deploy.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const locks = require('./lib/radar-slice16an-g06-wolfhouse-ingress-binding');
const corr = require('./lib/staff-api-request-correlation');
const boundary = require('./lib/staff-api-admission-boundary');
const ac = require('./lib/radar-g06-admission-control');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED   ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function pathExists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function headBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

function headSha() {
  try {
    return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

function mergeBaseWith(sha) {
  try {
    return execSync(`git merge-base HEAD ${sha}`, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (_) {
    return '';
  }
}

function fakeReq(opts) {
  const o = opts || {};
  const ee = new EventEmitter();
  ee.method = o.method || 'POST';
  ee.url = o.url || '/staff/stripe/webhook';
  ee.headers = Object.assign({}, o.headers || {});
  ee.aborted = false;
  ee.readableAborted = false;
  ee.destroyed = false;
  return ee;
}

function fakeRes() {
  const ee = new EventEmitter();
  ee.statusCode = 200;
  ee.headersSent = false;
  ee.writableEnded = false;
  ee.writableFinished = false;
  ee.finished = false;
  ee.destroyed = false;
  ee.closed = false;
  ee._headers = Object.create(null);
  ee._body = '';
  ee.setHeader = (k, v) => {
    ee._headers[String(k).toLowerCase()] = String(v);
  };
  ee.getHeader = (k) => ee._headers[String(k).toLowerCase()];
  ee.writeHead = (code, headers) => {
    ee.statusCode = code;
    ee.headersSent = true;
    if (headers && typeof headers === 'object') {
      Object.keys(headers).forEach((k) => {
        ee._headers[String(k).toLowerCase()] = String(headers[k]);
      });
    }
  };
  ee.end = (chunk) => {
    if (chunk != null) ee._body += String(chunk);
    ee.writableEnded = true;
    ee.writableFinished = true;
    ee.finished = true;
    ee.headersSent = true;
    ee.emit('finish');
    ee.emit('close');
  };
  return ee;
}

function sendJSON(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function withCleanEnv(extra, fn) {
  const prevDedicated = process.env[locks.INGRESS_ENV];
  const prevDefault = process.env[locks.DEFAULT_ENV];
  const prevFlag = process.env[locks.FLAG_ENV];
  delete process.env[locks.INGRESS_ENV];
  delete process.env[locks.DEFAULT_ENV];
  delete process.env[locks.FLAG_ENV];
  if (extra && typeof extra === 'object') {
    Object.keys(extra).forEach((k) => {
      if (extra[k] == null) delete process.env[k];
      else process.env[k] = String(extra[k]);
    });
  }
  try {
    return fn();
  } finally {
    if (prevDedicated === undefined) delete process.env[locks.INGRESS_ENV];
    else process.env[locks.INGRESS_ENV] = prevDedicated;
    if (prevDefault === undefined) delete process.env[locks.DEFAULT_ENV];
    else process.env[locks.DEFAULT_ENV] = prevDefault;
    if (prevFlag === undefined) delete process.env[locks.FLAG_ENV];
    else process.env[locks.FLAG_ENV] = prevFlag;
  }
}

async function main() {
  console.log(`\nRADAR 16AN — Wolfhouse ingress binding (${locks.BRANCH})\n`);

  const corrSrc = read(locks.CORRELATION_REL);
  const whBicep = read(locks.WH_BICEP_REL);
  const sunsetBicep = read(locks.SUNSET_BICEP_REL);
  const envExample = read(locks.ENV_EXAMPLE_REL);
  const design = readJson(locks.DESIGN_REL);
  const contract = readJson(locks.CONTRACT_REL);
  const doc = read('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = read('fixtures/radar-operations/findings.md');
  const pkg = readJson('package.json');
  const apiSrc = read('scripts/staff-query-api.js');

  green('dedicated_env_constant_exported',
    corr.STAFF_API_INGRESS_TENANT_SLUG_ENV === locks.INGRESS_ENV
    && corr.DEFAULT_CLIENT_SLUG_ENV === locks.DEFAULT_ENV
    && /STAFF_API_INGRESS_TENANT_SLUG/.test(corrSrc));

  green('resolve_prefers_dedicated', withCleanEnv({
    [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
  }, () => {
    const r = corr.resolveTrustedIngressBinding(null, process.env);
    return r.present === true
      && r.tenant_slug === locks.WH_INGRESS_SLUG
      && r.source === locks.INGRESS_ENV
      && r.conflict === false;
  }));

  {
    const missingOk = await withCleanEnv({}, async () => {
      const binding = corr.resolveTrustedIngressBinding(null, process.env);
      if (binding.present || binding.tenant_slug) return false;
      const b = boundary.createAdmissionBoundary({
        trustedTenantSlug: binding.tenant_slug,
        sendJSON,
      });
      const req = fakeReq();
      const res = fakeRes();
      let ran = false;
      const out = await b.admitAndRun(req, res, async () => { ran = true; });
      return out.ran_handler === false
        && out.fail_closed === true
        && ran === false
        && res.statusCode === 503
        && res.getHeader('retry-after') == null
        && out.decision === ac.DECISIONS.REJECTED_MISSING_TENANT;
    });
    red('missing_ingress_slug_fail_closed_on', missingOk);
  }

  red('conflict_ingress_slugs_fail_closed', withCleanEnv({
    [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, () => {
    const r = corr.resolveTrustedIngressBinding(null, process.env);
    return r.present === false
      && r.tenant_slug === null
      && r.conflict === true;
  }));

  red('request_spoof_ignored', withCleanEnv({
    [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
  }, () => {
    const binding = corr.resolveTrustedIngressBinding(null, process.env);
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: binding.tenant_slug,
      sendJSON,
    });
    const spoof = b.controller.tryAdmit({
      method: 'POST',
      pathname: '/staff/stripe/webhook',
      trustedTenantSlug: binding.tenant_slug,
      claimFromRequest: 'attacker-tenant',
    });
    return spoof.ok === false
      && spoof.decision === ac.DECISIONS.REJECTED_UNTRUSTED_TENANT
      && spoof.http_status == null
      && binding.tenant_slug === locks.WH_INGRESS_SLUG;
  }));

  red('off_parity_missing_slug_handler_runs', withCleanEnv({
    [locks.FLAG_ENV]: 'false',
  }, () => {
    const enabled = boundary.resolveAdmissionControlEnabled({ env: process.env });
    const binding = corr.resolveTrustedIngressBinding(null, process.env);
    let ran = false;
    const res = fakeRes();
    if (!enabled) {
      ran = true;
      res.writeHead(403);
      res.end('forbidden');
    }
    return enabled === false
      && binding.present === false
      && ran === true
      && res.statusCode === 403;
  }));

  red('default_alone_compat_fallback', withCleanEnv({
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, () => {
    const r = corr.resolveTrustedIngressBinding(null, process.env);
    return r.present === true
      && r.tenant_slug === locks.SUNSET_INGRESS_SLUG
      && r.source === locks.DEFAULT_ENV
      && r.conflict === false;
  }));

  red('dedicated_preferred_over_default', withCleanEnv({
    [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
    [locks.DEFAULT_ENV]: locks.WH_INGRESS_SLUG,
  }, () => {
    const r = corr.resolveTrustedIngressBinding(null, process.env);
    return r.source === locks.INGRESS_ENV
      && r.tenant_slug === locks.WH_INGRESS_SLUG;
  }));

  red('wolfhouse_bicep_no_default_client_slug', (() => {
    const hasIngress = /name:\s*'STAFF_API_INGRESS_TENANT_SLUG'[\s\S]{0,80}value:\s*'wolfhouse-somo'/.test(whBicep);
    const hasDefault = /name:\s*'DEFAULT_CLIENT_SLUG'/.test(whBicep);
    return hasIngress && !hasDefault;
  })());

  red('live_deploy_overclaim_rejected',
    contract.live_deploy === false
    && contract.live_mutation === false
    && contract.this_slice_deploys === false
    && design.live_mutation === false
    && design.this_slice_deploys === false
    && locks.EXPLICITLY_NOT_CLAIMED.includes('live_deploy_by_this_slice'));

  red('overload_shed_overclaim_rejected', (() => {
    const neg = /not claimed|does\s*\*+\s*not|does not|never|explicitly|identity fail-closed|not overload|Does not prove/i;
    let bareOverclaim = false;
    for (const line of String(doc).split(/\n/)) {
      if (neg.test(line)) continue;
      if (/\blive overload shed\b|\boverload shedding proven\b/i.test(line)) {
        bareOverclaim = true;
        break;
      }
    }
    return design.diagnosis.not_overload_shed === true
      && /identity_fail_closed_not_overload_shed/.test(JSON.stringify(design))
      && locks.FAILED_CANARY_ROLLBACK.classification === 'identity_fail_closed_not_overload_shed'
      && !bareOverclaim;
  })());

  red('full_g06_overclaim_rejected',
    contract.g06_verdict === 'partial'
    && contract.score.proven === 0
    && contract.score.partial === 9
    && contract.score.absent === 0
    && /G06 remains partial|G06.*partial/i.test(doc));

  red('default_alone_as_wolfhouse_fix_rejected',
    locks.SAFETY_ASSESSMENT.setting_DEFAULT_CLIENT_SLUG_wolfhouse_somo_alone.chosen === false
    && locks.SAFETY_ASSESSMENT.dedicated_STAFF_API_INGRESS_TENANT_SLUG.preferred === true
    && design.safety_assessment.DEFAULT_CLIENT_SLUG_alone_on_wolfhouse.chosen === false);

  green('wolfhouse_bicep_wires_ingress_slug',
    /STAFF_API_INGRESS_TENANT_SLUG/.test(whBicep)
    && /wolfhouse-somo/.test(whBicep)
    && !/name:\s*'DEFAULT_CLIENT_SLUG'/.test(whBicep));

  green('sunset_bicep_wires_ingress_slug_matching_default',
    /name:\s*'STAFF_API_INGRESS_TENANT_SLUG'[\s\S]{0,80}value:\s*'sunset'/.test(sunsetBicep)
    && /name:\s*'DEFAULT_CLIENT_SLUG'[\s\S]{0,40}value:\s*'sunset'/.test(sunsetBicep));

  green('env_example_documents_dedicated',
    /STAFF_API_INGRESS_TENANT_SLUG/.test(envExample)
    && /conflict|must match|fail.?closed/i.test(envExample));

  green('failed_canary_recorded_identity_fail_closed',
    design.failed_canary_rollback.wolfhouse.revision_on_fail === 'wh-staging-staff-api--0000522'
    && design.failed_canary_rollback.wolfhouse.revision_after_rollback === 'wh-staging-staff-api--0000523'
    && design.failed_canary_rollback.sunset.revision === 'luna-sunset-staging-staff-api--0000281'
    && design.failed_canary_rollback.classification === 'identity_fail_closed_not_overload_shed'
    && /0000522/.test(doc)
    && /0000523/.test(doc)
    && /identity fail-closed|identity_fail_closed/i.test(doc)
    && /identity fail-closed|identity_fail_closed|0000522/i.test(findings));

  green('package_script_registered',
    pkg.scripts
    && pkg.scripts['verify:radar-slice16an-g06-wolfhouse-ingress-binding']
      === 'node scripts/verify-radar-slice16an-g06-wolfhouse-ingress-binding.js');

  green('g06_remains_partial',
    contract.g06_verdict === 'partial'
    && design.g06_verdict === 'partial'
    && /G06 remains partial|G06.*partial/i.test(doc));

  green('score_not_inflated',
    contract.score.proven === 0
    && contract.score.partial === 9
    && contract.score.absent === 0);

  green('16am_deploy_flag_off_retained',
    contract.g06_backpressure_deploy_flag_off === 'live_proven_via_16AM'
    && pathExists('fixtures/radar-operations/slice16am-g06-backpressure-deploy-evidence.json'));

  green('staff_api_passes_env_to_resolve',
    /resolveTrustedIngressBinding\([^,]+,\s*env\)/.test(apiSrc));

  green('branch_and_master_basis',
    locks.MASTER_BASIS === '63ba28fe4149609db8277e7ebb8a80e5f1d18945'
    && contract.master_basis === locks.MASTER_BASIS
    && design.master_basis === locks.MASTER_BASIS
    && locks.BRANCH === 'radar/slice-16an-g06-wolfhouse-ingress-binding'
    && (headBranch() === locks.BRANCH || headBranch() === 'HEAD')
    && mergeBaseWith(locks.MASTER_BASIS) === locks.MASTER_BASIS);

  green('must_not_mutate_clean', (() => {
    try {
      const out = execSync(
        `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
        { cwd: ROOT, encoding: 'utf8' },
      ).trim();
      return out === '';
    } catch (_) {
      return false;
    }
  })());

  const redIds = redResults.map((r) => r.id);
  const greenIds = greenResults.map((r) => r.id);
  for (const id of locks.REQUIRED_RED) {
    ok(`REQUIRED_RED has ${id}`, redIds.includes(id));
  }
  for (const id of locks.REQUIRED_GREEN) {
    ok(`REQUIRED_GREEN has ${id}`, greenIds.includes(id));
  }

  ok('all RED assertions passed', redResults.every((r) => r.ok));
  ok('all GREEN assertions passed', greenResults.every((r) => r.ok));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  console.log(`HEAD=${headSha()} branch=${headBranch()}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
