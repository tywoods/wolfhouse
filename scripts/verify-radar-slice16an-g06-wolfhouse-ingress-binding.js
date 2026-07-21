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

  // ── Strict dedicated-env fail-closed (no String() fallthrough) ─────────────

  function failClosedNoFallback(env, expectedReason) {
    const r = corr.resolveTrustedIngressBinding(null, env);
    const dump = JSON.stringify(r);
    return r.present === false
      && r.tenant_slug === null
      && r.source == null
      && r.conflict === false
      && r.reason === expectedReason
      && !/secret|wolfhouse-somo|sunset|toString|valueOf/i.test(String(r.reason || ''))
      && typeof r.reason === 'string'
      && r.reason.length > 0
      && r.reason.length <= 64
      && !dump.includes('secret-tenant-leak')
      && dump.indexOf('toString') === -1;
  }

  red('blank_dedicated_no_default_fallthrough', failClosedNoFallback({
    [locks.INGRESS_ENV]: '',
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, corr.INGRESS_ENV_REASONS.BLANK));

  red('whitespace_dedicated_no_default_fallthrough', failClosedNoFallback({
    [locks.INGRESS_ENV]: '   \t  ',
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, corr.INGRESS_ENV_REASONS.CONTROL_CHAR) // tab is control; also covers whitespace-only
    || failClosedNoFallback({
      [locks.INGRESS_ENV]: '     ',
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.BLANK));

  red('non_string_number_dedicated_fail_closed', failClosedNoFallback({
    [locks.INGRESS_ENV]: 123,
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, corr.INGRESS_ENV_REASONS.NON_STRING));

  red('non_string_object_array_boxed_dedicated_fail_closed', (() => {
    const objectOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: { slug: locks.WH_INGRESS_SLUG },
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.NON_STRING);
    const arrayOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: [locks.WH_INGRESS_SLUG],
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.NON_STRING);
    const boxedOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: Object(locks.SUNSET_INGRESS_SLUG),
      [locks.DEFAULT_ENV]: locks.WH_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.NON_STRING);
    return objectOk && arrayOk && boxedOk;
  })());

  red('nul_control_dedicated_fail_closed', (() => {
    const nulOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: `sunset\u0000x`,
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.CONTROL_CHAR);
    const belOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: 'sun\u0007set',
      [locks.DEFAULT_ENV]: locks.WH_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.CONTROL_CHAR);
    return nulOk && belOk;
  })());

  red('oversize_dedicated_fail_closed', failClosedNoFallback({
    [locks.INGRESS_ENV]: `a${'b'.repeat(64)}`,
    [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
  }, corr.INGRESS_ENV_REASONS.OVERSIZE));

  red('unicode_invalid_dedicated_fail_closed', (() => {
    const uniOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: 'café-slug',
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.INVALID_SLUG);
    const caseInvalidOk = failClosedNoFallback({
      [locks.INGRESS_ENV]: 'Bad Slug!',
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, corr.INGRESS_ENV_REASONS.INVALID_SLUG);
    return uniOk && caseInvalidOk;
  })());

  red('inherited_prototype_dedicated_absent_fallback', (() => {
    const proto = { [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG };
    const env = Object.create(proto);
    env[locks.DEFAULT_ENV] = locks.SUNSET_INGRESS_SLUG;
    const r = corr.resolveTrustedIngressBinding(null, env);
    return corr.envHasOwnProperty(env, locks.INGRESS_ENV) === false
      && r.present === true
      && r.tenant_slug === locks.SUNSET_INGRESS_SLUG
      && r.source === locks.DEFAULT_ENV
      && r.conflict === false
      && r.reason === null;
  })());

  red('undefined_null_present_dedicated_fail_closed', (() => {
    const undefEnv = { [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG };
    Object.defineProperty(undefEnv, locks.INGRESS_ENV, {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const nullEnv = {
      [locks.INGRESS_ENV]: null,
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    };
    return failClosedNoFallback(undefEnv, corr.INGRESS_ENV_REASONS.NULLISH)
      && failClosedNoFallback(nullEnv, corr.INGRESS_ENV_REASONS.NULLISH);
  })());

  red('getter_throwing_dedicated_fail_closed', (() => {
    const env = { [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG };
    Object.defineProperty(env, locks.INGRESS_ENV, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('secret-tenant-leak boom');
      },
    });
    return failClosedNoFallback(env, corr.INGRESS_ENV_REASONS.ENV_INSPECTION_FAILED);
  })());

  red('hostile_coercion_dedicated_fail_closed', (() => {
    const hostile = {
      toString() { return locks.SUNSET_INGRESS_SLUG; },
      valueOf() { return locks.SUNSET_INGRESS_SLUG; },
      [Symbol.toPrimitive]() { return locks.SUNSET_INGRESS_SLUG; },
    };
    const r = corr.resolveTrustedIngressBinding(null, {
      [locks.INGRESS_ENV]: hostile,
      [locks.DEFAULT_ENV]: locks.WH_INGRESS_SLUG,
    });
    return r.present === false
      && r.tenant_slug === null
      && r.source == null
      && r.reason === corr.INGRESS_ENV_REASONS.NON_STRING
      && r.conflict === false;
  })());

  red('malformed_present_default_fail_closed', (() => {
    // Dedicated absent: malformed own DEFAULT fails closed (no accept).
    const alone = failClosedNoFallback({
      [locks.DEFAULT_ENV]: '   ',
    }, corr.INGRESS_ENV_REASONS.BLANK);
    const nonString = failClosedNoFallback({
      [locks.DEFAULT_ENV]: 99,
    }, corr.INGRESS_ENV_REASONS.NON_STRING);
    // Dedicated valid + malformed present DEFAULT also fails closed.
    const withDedicated = failClosedNoFallback({
      [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
      [locks.DEFAULT_ENV]: '',
    }, corr.INGRESS_ENV_REASONS.DEFAULT_INVALID);
    return alone && nonString && withDedicated;
  })());

  red('valid_exact_match_both_envs', (() => {
    const r = corr.resolveTrustedIngressBinding(null, {
      [locks.INGRESS_ENV]: `  ${locks.SUNSET_INGRESS_SLUG}  `,
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    });
    return r.present === true
      && r.tenant_slug === locks.SUNSET_INGRESS_SLUG
      && r.source === locks.INGRESS_ENV
      && r.conflict === false
      && r.reason === null;
  })());

  red('absent_dedicated_valid_default_fallback', (() => {
    const r = corr.resolveTrustedIngressBinding(null, {
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    });
    return r.present === true
      && r.tenant_slug === locks.SUNSET_INGRESS_SLUG
      && r.source === locks.DEFAULT_ENV
      && r.conflict === false
      && r.reason === null;
  })());

  red('no_secret_raw_value_leakage_in_reason', (() => {
    const secret = 'secret-tenant-leak-SHOULD-NOT-APPEAR';
    const cases = [
      { [locks.INGRESS_ENV]: `  ${secret}!!  `, [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG },
      { [locks.INGRESS_ENV]: `${secret}\u0000`, [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG },
      { [locks.INGRESS_ENV]: '', [locks.DEFAULT_ENV]: secret },
      { [locks.INGRESS_ENV]: Object(secret), [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG },
      { [locks.INGRESS_ENV]: 42, [locks.DEFAULT_ENV]: `${secret}!!` },
      { [locks.DEFAULT_ENV]: `bad ${secret}` },
      { [locks.DEFAULT_ENV]: `${secret}\u0007` },
    ];
    return cases.every((env) => {
      const r = corr.resolveTrustedIngressBinding(null, env);
      const dump = JSON.stringify(r);
      return r.present === false
        && r.tenant_slug === null
        && dump.indexOf(secret) === -1
        && dump.indexOf('SHOULD-NOT-APPEAR') === -1
        && typeof r.reason === 'string'
        && r.reason.length <= 64
        && !/secret|SHOULD-NOT/i.test(r.reason);
    });
  })());

  // ── Hostile / revoked Proxy env inspection (never throw / never raw echo) ─

  const SECRET_RAW = 'SECRET_RAW';

  function assertSafeFailClosed(resolveFn) {
    let threw = false;
    let r;
    try {
      r = resolveFn();
    } catch (_) {
      threw = true;
      r = null;
    }
    const dump = r == null ? '' : JSON.stringify(r);
    return threw === false
      && r != null
      && r.present === false
      && r.tenant_slug === null
      && r.source == null
      && r.conflict === false
      && r.reason === corr.INGRESS_ENV_REASONS.ENV_INSPECTION_FAILED
      && typeof r.reason === 'string'
      && r.reason.length > 0
      && r.reason.length <= 64
      && dump.indexOf(SECRET_RAW) === -1
      && !/SECRET_RAW|secret-tenant-leak/i.test(dump)
      && !/SECRET_RAW|secret-tenant-leak/i.test(String(r.reason || ''));
  }

  function hostileSecretProxy(target) {
    return new Proxy(target || {}, {
      getOwnPropertyDescriptor(t, prop) {
        throw new Error(SECRET_RAW);
      },
      get() {
        throw new Error(SECRET_RAW);
      },
      has() {
        throw new Error(SECRET_RAW);
      },
      ownKeys() {
        throw new Error(SECRET_RAW);
      },
    });
  }

  red('trap_throws_secret_raw_fail_closed', assertSafeFailClosed(() => (
    corr.resolveTrustedIngressBinding(null, hostileSecretProxy({}))
  )));

  red('revoked_proxy_fail_closed', (() => {
    const target = {
      [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG,
      [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
    };
    const { proxy, revoke } = Proxy.revocable(target, {});
    revoke();
    return assertSafeFailClosed(() => corr.resolveTrustedIngressBinding(null, proxy));
  })());

  red('valid_dedicated_hostile_default_presence_fail_closed', (() => {
    const base = { [locks.INGRESS_ENV]: locks.WH_INGRESS_SLUG };
    const env = new Proxy(base, {
      getOwnPropertyDescriptor(t, prop) {
        if (prop === locks.DEFAULT_ENV) {
          throw new Error(SECRET_RAW);
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
      get(t, prop, recv) {
        if (prop === locks.DEFAULT_ENV) {
          throw new Error(SECRET_RAW);
        }
        return Reflect.get(t, prop, recv);
      },
      has(t, prop) {
        if (prop === locks.DEFAULT_ENV) {
          throw new Error(SECRET_RAW);
        }
        return Reflect.has(t, prop);
      },
      ownKeys() {
        throw new Error(SECRET_RAW);
      },
    });
    // Valid dedicated must not be partially accepted when DEFAULT presence inspect fails.
    return assertSafeFailClosed(() => corr.resolveTrustedIngressBinding(null, env))
      && corr.resolveTrustedIngressBinding(null, env).tenant_slug !== locks.WH_INGRESS_SLUG;
  })());

  red('hostile_dedicated_getter_fail_closed', (() => {
    const env = { [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG };
    Object.defineProperty(env, locks.INGRESS_ENV, {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error(SECRET_RAW);
      },
    });
    return assertSafeFailClosed(() => corr.resolveTrustedIngressBinding(null, env));
  })());

  red('explicit_binding_revoked_env', (() => {
    const { proxy, revoke } = Proxy.revocable({
      [locks.INGRESS_ENV]: locks.SUNSET_INGRESS_SLUG,
    }, {
      getOwnPropertyDescriptor() { throw new Error(SECRET_RAW); },
      get() { throw new Error(SECRET_RAW); },
      has() { throw new Error(SECRET_RAW); },
      ownKeys() { throw new Error(SECRET_RAW); },
    });
    revoke();
    let threw = false;
    let r;
    try {
      r = corr.resolveTrustedIngressBinding(
        { tenant_slug: locks.WH_INGRESS_SLUG },
        proxy,
      );
    } catch (_) {
      threw = true;
      r = null;
    }
    const dump = r == null ? '' : JSON.stringify(r);
    return threw === false
      && r != null
      && r.present === true
      && r.tenant_slug === locks.WH_INGRESS_SLUG
      && r.source === 'explicit'
      && r.conflict === false
      && r.reason === null
      && dump.indexOf(SECRET_RAW) === -1;
  })());

  // Explicit construction binding still wins over env.
  green('explicit_construction_binding_precedence', (() => {
    const r = corr.resolveTrustedIngressBinding(
      { tenant_slug: locks.WH_INGRESS_SLUG },
      {
        [locks.INGRESS_ENV]: locks.SUNSET_INGRESS_SLUG,
        [locks.DEFAULT_ENV]: locks.SUNSET_INGRESS_SLUG,
      },
    );
    return r.present === true
      && r.tenant_slug === locks.WH_INGRESS_SLUG
      && r.source === 'explicit'
      && r.conflict === false;
  })());

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
    && (headBranch() === locks.BRANCH || headBranch() === 'HEAD'
      || headBranch() === 'radar/slice-16ao-g06-backpressure-activation-evidence')
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
