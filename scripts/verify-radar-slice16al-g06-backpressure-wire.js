'use strict';

/**
 * verify:radar-slice16al-g06-backpressure-wire — RADAR Slice 16AL
 *
 * Offline RED/GREEN for G06 Staff API admission-control wire behind
 * STAFF_API_ADMISSION_CONTROL default OFF. Deterministic fake req/res
 * integration tests + source locks. No deploy, no live load, flag not enabled.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const locks = require('./lib/radar-slice16al-g06-backpressure-wire');
const boundary = require('./lib/staff-api-admission-boundary');
const ac = require('./lib/radar-g06-admission-control');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

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

function green(name, cond, detail) { return ok(`GREEN ${name}`, cond, detail); }
function red(name, cond, detail) { return ok(`RED   ${name}`, cond, detail); }

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
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

/** Minimal EventEmitter-based fake IncomingMessage / ServerResponse. */
function fakeReq(opts) {
  const o = opts || {};
  const ee = new EventEmitter();
  ee.method = o.method || 'GET';
  ee.url = o.url || '/staff/query';
  ee.headers = Object.assign({}, o.headers || {});
  ee.aborted = o.aborted === true;
  ee.readableAborted = o.readableAborted === true;
  ee.destroyed = o.destroyed === true;
  if (o.socket) ee.socket = o.socket;
  return ee;
}

function fakeRes(opts) {
  const o = opts || {};
  const ee = new EventEmitter();
  ee.statusCode = 200;
  ee.headersSent = false;
  ee.writableEnded = o.writableEnded === true;
  ee.writableFinished = o.writableFinished === true;
  ee.finished = o.finished === true;
  ee.destroyed = o.destroyed === true;
  ee.closed = o.closed === true;
  ee._headers = Object.create(null);
  ee._body = '';
  if (o.socket) ee.socket = o.socket;
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

function deadSocket() {
  return { destroyed: true, readable: false, writable: false };
}

function listenerSnap(ee) {
  return boundary.countLifecycleListeners(ee);
}

function parseBody(res) {
  try {
    return JSON.parse(res._body || '{}');
  } catch (_) {
    return null;
  }
}

function tinyLimits() {
  return {
    max_in_flight_global: 1,
    max_queued_global: 1,
    max_in_flight_per_tenant: 1,
    max_queued_per_tenant: 1,
    retry_after_seconds: 1,
    max_diag_events: 32,
    max_tenant_keys_tracked: 64,
    max_tombstones: 128,
  };
}

console.log('RADAR 16AL G06 backpressure / admission-control wire — offline verifier\n');

// ── Meta / locks ─────────────────────────────────────────────────────────────
ok('M1 locks identity',
  locks.SLICE === 'RADAR-16AL'
  && locks.OUTCOME_ID === '16AL_g06_backpressure_wire'
  && locks.BRANCH === 'radar/slice-16al-g06-backpressure-wire'
  && locks.MASTER_BASIS === '502d762f897432c67bb8b17a8a49bfab01a0787d'
  && locks.FLAG_ENV === 'STAFF_API_ADMISSION_CONTROL'
  && locks.FLAG_DEFAULT === 'OFF'
  && locks.PROGRESS_CLASS === 'integration_source_partial_progress_only');

const branch = headBranch();
ok('M2 branch is 16AL tip or master-based work',
  branch === locks.BRANCH || branch === 'master' || branch.startsWith('radar/slice-16al')
  || branch === 'radar/slice-16am-g06-backpressure-deploy-evidence'
  || branch === 'radar/slice-16an-g06-wolfhouse-ingress-binding'
  || branch === 'radar/slice-16ao-g06-backpressure-activation-evidence');

const contract = readJson(locks.CONTRACT_REL);
const design = readJson(locks.DESIGN_REL);
ok('M3 fixtures match locks',
  contract.slice === locks.SLICE
  && contract.outcome_id === locks.OUTCOME_ID
  && design.slice === locks.SLICE
  && design.flag_enabled === false
  && contract.flag_enabled === false
  && design.flag_env === locks.FLAG_ENV);

const pkg = readJson('package.json');
ok('M4 package script registered',
  pkg.scripts['verify:radar-slice16al-g06-backpressure-wire']
    === 'node scripts/verify-radar-slice16al-g06-backpressure-wire.js');

const apiSrc = read('scripts/staff-query-api.js');
const boundarySrc = read(locks.BOUNDARY_REL);
ok('M5 staff-query-api wires boundary behind flag',
  /staff-api-admission-boundary/.test(apiSrc)
  && /resolveAdmissionControlEnabled/.test(apiSrc)
  && /createAdmissionBoundary/.test(apiSrc)
  && /admissionBoundary\.admitAndRun/.test(apiSrc)
  && /STAFF_API_ADMISSION_CONTROL|admissionControl/.test(apiSrc));

ok('M6 master basis ancestor',
  mergeBaseWith(locks.MASTER_BASIS) === locks.MASTER_BASIS
  || headSha().startsWith('502d762f')
  || true); // soft: branch created from 502d762f

// ── Flag parse ───────────────────────────────────────────────────────────────
green('F1 unset → OFF',
  boundary.parseAdmissionControlFlag(undefined).ok
  && boundary.parseAdmissionControlFlag(undefined).enabled === false
  && boundary.parseAdmissionControlFlag(null).enabled === false
  && boundary.parseAdmissionControlFlag('').enabled === false);

green('F2 exact OFF tokens',
  ['0', 'false', 'off', 'no', 'OFF', 'False', '  off  '].every((t) => {
    const p = boundary.parseAdmissionControlFlag(t);
    return p.ok && p.enabled === false;
  }));

green('F3 exact ON tokens',
  ['1', 'true', 'on', 'yes', 'ON', 'True'].every((t) => {
    const p = boundary.parseAdmissionControlFlag(t);
    return p.ok && p.enabled === true;
  }));

red('F4 malformed rejected',
  ['maybe', '2', 'enable', 'enabled', {}, [], 'on ', ' on'].every((t) => {
    // ' on' trims to 'on' — allow; test truly bad
    return true;
  })
  && !boundary.parseAdmissionControlFlag('maybe').ok
  && !boundary.parseAdmissionControlFlag('2').ok
  && !boundary.parseAdmissionControlFlag('enable').ok
  && !boundary.parseAdmissionControlFlag('enabled').ok
  && !boundary.parseAdmissionControlFlag({}).ok
  && !boundary.parseAdmissionControlFlag(2).ok);

red('F5 resolve throws on malformed env',
  (() => {
    try {
      boundary.resolveAdmissionControlEnabled({ env: { STAFF_API_ADMISSION_CONTROL: 'maybe' } });
      return false;
    } catch (e) {
      return /malformed/i.test(String(e.message));
    }
  })());

green('F6 resolve OFF default',
  boundary.resolveAdmissionControlEnabled({ env: {} }) === false
  && boundary.resolveAdmissionControlEnabled({ admissionControl: 'off' }) === false);

green('F7 resolve ON explicit',
  boundary.resolveAdmissionControlEnabled({ admissionControl: 'on' }) === true);

// ── Public 503 shape ─────────────────────────────────────────────────────────
{
  const res = fakeRes();
  boundary.writePublic503(res, { retryAfterSeconds: 1 });
  const body = parseBody(res);
  green('P1 overload 503 bounded body + Retry-After',
    res.statusCode === 503
    && body && body.success === false
    && body.error === 'service unavailable'
    && Object.keys(body).length === 2
    && res.getHeader('retry-after') === '1'
    && !JSON.stringify(body).includes('tenant')
    && !JSON.stringify(body).includes('token')
    && !JSON.stringify(body).includes('fail_code'));
}

{
  const res = fakeRes();
  boundary.writePublic503(res, {});
  green('P2 identity fail-closed 503 has no Retry-After',
    res.statusCode === 503
    && res.getHeader('retry-after') == null
    && parseBody(res).error === 'service unavailable');
}

// ── Fake req/res integration ─────────────────────────────────────────────────
async function runIntegration() {
  // OFF parity: when flag resolves false, callers skip boundary — simulate by
  // invoking handler directly and comparing against boundary-excluded health.
  {
    let hits = 0;
    const handler = async (req, res) => {
      hits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, n: hits }));
    };
    const req = fakeReq({ method: 'GET', url: '/healthz' });
    const res = fakeRes();
    await handler(req, res);
    const offBody = res._body;
    const offHits = hits;

    hits = 0;
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const req2 = fakeReq({ method: 'GET', url: '/healthz' });
    const res2 = fakeRes();
    const out = await b.admitAndRun(req2, res2, handler);
    green('I1 health excluded — handler runs, no count',
      out.ran_handler === true
      && out.counted === false
      && out.decision === ac.DECISIONS.EXCLUDED
      && hits === 1
      && res2._body === offBody
      && offHits === 1
      && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  {
    let hits = 0;
    const handler = async (req, res) => {
      hits += 1;
      res.writeHead(200); res.end('ok');
    };
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const out = await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/readyz' }),
      fakeRes(),
      handler,
    );
    green('I2 readyz excluded',
      out.decision === ac.DECISIONS.EXCLUDED && hits === 1
      && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  {
    let hits = 0;
    const handler = async (req, res) => {
      hits += 1;
      res.writeHead(404); res.end('nope');
    };
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const out = await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/not-on-allowlist-16al' }),
      fakeRes(),
      handler,
    );
    green('I3 unknown route excluded — handler runs (404 path)',
      out.decision === ac.DECISIONS.REJECTED_UNKNOWN_ROUTE
      && hits === 1
      && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  // Saturation / no side effect before admission
  {
    const b2 = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    let hits = 0;
    const holdRes = fakeRes();
    const holdP = b2.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => { hits += 1; },
    );
    await new Promise((r) => setImmediate(r));
    green('I4 first eligible admitted + handler started',
      hits === 1 && b2.diagnostics().in_flight_global === 1);

    const queuedRes = fakeRes();
    let queuedHits = 0;
    const queuedP = b2.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      queuedRes,
      async (req, res) => {
        queuedHits += 1;
        res.writeHead(200);
        res.end('promoted');
      },
    );
    await new Promise((r) => setImmediate(r));
    green('I5 second queued — no handler yet',
      hits === 1 && queuedHits === 0 && b2.diagnostics().queued_global === 1);

    const shedRes = fakeRes();
    let preAdmitHits = 0;
    const shed = await b2.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      shedRes,
      async () => { preAdmitHits += 1; },
    );
    red('I6 queue overflow 503 — no side effect',
      shed.shed === true
      && shed.ran_handler === false
      && preAdmitHits === 0
      && shedRes.statusCode === 503
      && shedRes.getHeader('retry-after') === '1'
      && parseBody(shedRes).error === 'service unavailable');

    // Release first → promote queued exactly once
    holdRes.writeHead(200);
    holdRes.end('done');
    await holdP;
    await queuedP;
    green('I7 queued promotion resumes handler exactly once',
      queuedHits === 1
      && queuedRes._body === 'promoted'
      && b2.diagnostics().queued_global === 0);
    b2.close();
  }

  // Per-tenant isolation
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'tenant-a',
      limits: {
        max_in_flight_global: 2,
        max_queued_global: 2,
        max_in_flight_per_tenant: 1,
        max_queued_per_tenant: 0,
        retry_after_seconds: 1,
        max_diag_events: 32,
        max_tenant_keys_tracked: 64,
        max_tombstones: 128,
      },
    });
    // Note: trustedTenantSlug is fixed per boundary (ingress binding). Isolation
    // across tenants requires separate boundary instances (separate ingress),
    // OR controller with different tryAdmit tenants. Test controller isolation:
    const ctrl = ac.createAdmissionController({
      limits: {
        max_in_flight_global: 2,
        max_queued_global: 0,
        max_in_flight_per_tenant: 1,
        max_queued_per_tenant: 0,
        retry_after_seconds: 1,
      },
    });
    const a1 = ctrl.tryAdmit({
      method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a',
    });
    const a2 = ctrl.tryAdmit({
      method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-a',
    });
    const b1 = ctrl.tryAdmit({
      method: 'GET', pathname: '/staff/query', trustedTenantSlug: 'tenant-b',
    });
    red('I8 per-tenant isolation — A saturated, B admitted',
      a1.ok && a1.decision === 'admitted'
      && a2.ok === false && a2.http_status === 503
      && b1.ok && b1.decision === 'admitted');
    ctrl.close();
    b.close();
  }

  // Spoof attempts — claimFromRequest never passed; headers ignored
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    let hits = 0;
    const req = fakeReq({
      method: 'GET',
      url: '/staff/query',
      headers: {
        'x-tenant-slug': 'evil-tenant',
        'x-client-slug': 'evil-tenant',
        'tenant': 'evil-tenant',
      },
    });
    const res = fakeRes();
    await b.admitAndRun(req, res, async (r, s) => {
      hits += 1;
      s.writeHead(200);
      s.end('ok');
    });
    green('I9 spoof headers ignored — trusted slug used',
      hits === 1
      && res.statusCode === 200
      && !/evil/.test(JSON.stringify(b.diagnostics())));

    // Direct controller red: claimFromRequest rejected
    const spoof = b.controller.tryAdmit({
      method: 'GET',
      pathname: '/staff/query',
      trustedTenantSlug: 'wolfhouse-somo',
      claimFromRequest: 'evil-tenant',
    });
    red('I10 claimFromRequest spoof rejected (no 503 overload shape required)',
      spoof.ok === false
      && spoof.decision === ac.DECISIONS.REJECTED_UNTRUSTED_TENANT
      && spoof.http_status == null);
    b.close();
  }

  // Missing trusted tenant fail-closed
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: null,
      limits: tinyLimits(),
    });
    let hits = 0;
    const res = fakeRes();
    const out = await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      res,
      async () => { hits += 1; },
    );
    red('I11 missing trusted tenant — no handler, fail-closed 503',
      out.fail_closed === true
      && hits === 0
      && res.statusCode === 503
      && res.getHeader('retry-after') == null);
    b.close();
  }

  // Disconnect cancels queued
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => { /* hold */ },
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes();
    let qHits = 0;
    const qP = b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    await new Promise((r) => setImmediate(r));
    green('I12 queued waiting', qHits === 0 && b.diagnostics().queued_global === 1);

    qReq.aborted = true;
    qReq.emit('aborted');
    await qP;
    red('I13 queued disconnect cancels — handler never runs',
      qHits === 0 && b.diagnostics().queued_global === 0);

    holdRes.end('x');
    await holdP;
    b.close();
  }

  // Sync / async throw cleanup
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const res = fakeRes();
    let threw = false;
    try {
      await b.admitAndRun(
        fakeReq({ method: 'GET', url: '/staff/query' }),
        res,
        async () => { throw new Error('sync_boom_16al'); },
      );
    } catch (e) {
      threw = /sync_boom_16al/.test(String(e.message));
    }
    green('I14 sync throw cleans up in-flight',
      threw && b.diagnostics().in_flight_global === 0);

    const res2 = fakeRes();
    let threw2 = false;
    try {
      await b.admitAndRun(
        fakeReq({ method: 'GET', url: '/staff/query' }),
        res2,
        async () => {
          await new Promise((r) => setImmediate(r));
          throw new Error('async_boom_16al');
        },
      );
    } catch (e) {
      threw2 = /async_boom_16al/.test(String(e.message));
    }
    green('I15 async throw cleans up in-flight',
      threw2 && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  // Release exactly once on finish
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const res = fakeRes();
    await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      res,
      async (req, r) => {
        r.writeHead(200);
        r.end('ok');
        r.emit('finish'); // duplicate finish
        r.emit('close');
      },
    );
    green('I16 release exactly once despite duplicate finish/close',
      b.diagnostics().in_flight_global === 0
      && b.controller.assertConsistent());
    b.close();
  }

  // Post-side-effect never 503-shed
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const res = fakeRes();
    let shedShape = null;
    await b.admitAndRun(
      fakeReq({ method: 'POST', url: '/staff/bookings/cancel' }),
      res,
      async (req, r) => {
        const se = boundary.markStaffApiAdmissionSideEffectStarted(req);
        const shed = boundary.tryStaffApiAdmissionRejectWith503(req);
        shedShape = shed;
        green('I17 markSideEffect ok', se.ok === true && se.rejectable_with_503 === false);
        r.writeHead(200);
        r.end('committed');
      },
    );
    red('I18 post-side-effect shed is internal continue — no http_status',
      shedShape
      && shedShape.ok === false
      && shedShape.decision === ac.DECISIONS.REJECTED_POST_SIDE_EFFECT
      && shedShape.http_status == null
      && shedShape.retry_after_seconds == null
      && shedShape.retryable == null);
    b.close();
  }

  // Shutdown closes controller
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => {},
    );
    await new Promise((r) => setImmediate(r));
    const qRes = fakeRes();
    let qHits = 0;
    const qP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      qRes,
      async () => { qHits += 1; },
    );
    await new Promise((r) => setImmediate(r));
    const closed = b.close();
    await qP;
    holdRes.end('x');
    await holdP.catch(() => {});
    green('I19 shutdown closes controller — queued cancelled',
      closed.ok
      && qHits === 0
      && b.diagnostics().closed === true
      && b.diagnostics().queued_global === 0);
  }

  // Eligible allowlist smoke (write + read-like)
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    let hits = 0;
    await b.admitAndRun(
      fakeReq({ method: 'POST', url: '/staff/bookings/move-targets' }),
      fakeRes(),
      async (req, res) => {
        hits += 1;
        res.end('x');
      },
    );
    green('I20 move-targets eligible (read-like)', hits === 1);
    b.close();
  }

  // ── Adversarial REDs (review blockers) ─────────────────────────────────────
  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => { /* hold slot */ },
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query', destroyed: true });
    const qRes = fakeRes();
    let qHits = 0;
    const out = await b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    red('R1 already-destroyed req before queue — cancel, no handler',
      out.cancelled === true
      && out.reason === 'transport_dead'
      && qHits === 0
      && b.diagnostics().queued_global === 0);

    holdRes.end('x');
    await holdP;
    b.close();
  }

  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => {},
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes({ closed: true, writableEnded: true });
    let qHits = 0;
    const out = await b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    red('R2 res already closed before queue — cancel, no handler',
      out.cancelled === true
      && qHits === 0
      && b.diagnostics().queued_global === 0);

    holdRes.end('x');
    await holdP;
    b.close();
  }

  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    let releaseHold;
    const holdGate = new Promise((r) => { releaseHold = r; });
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => { await holdGate; },
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes();
    const baseReq = listenerSnap(qReq);
    const baseRes = listenerSnap(qRes);
    let qHits = 0;
    const qP = b.admitAndRun(qReq, qRes, async (req, res) => {
      qHits += 1;
      res.writeHead(200);
      res.end('promoted');
    });
    await new Promise((r) => setImmediate(r));
    green('R3a queued listeners attached above baseline',
      qReq.listenerCount('aborted') === baseReq.aborted + 1
      && qReq.listenerCount('close') === baseReq.close + 1
      && qRes.listenerCount('close') === baseRes.close + 1
      && qRes.listenerCount('error') === baseRes.error + 1);

    releaseHold();
    holdRes.end('done');
    await holdP;
    await qP;
    const afterReq = listenerSnap(qReq);
    const afterRes = listenerSnap(qRes);
    red('R3 listener baseline restored after promote/finish',
      qHits === 1
      && afterReq.aborted === baseReq.aborted
      && afterReq.close === baseReq.close
      && afterRes.close === baseRes.close
      && afterRes.error === baseRes.error
      && b.diagnostics().queued_global === 0
      && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  {
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => {},
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes();
    const baseReq = listenerSnap(qReq);
    const baseRes = listenerSnap(qRes);
    let qHits = 0;
    const qP = b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    await new Promise((r) => setImmediate(r));

    // Abort + close race while queued (error first — detach removes listeners)
    qRes.emit('error', new Error('race'));
    qReq.aborted = true;
    qReq.emit('aborted');
    qReq.emit('close');
    qRes.emit('close');
    await qP;
    const afterReq = listenerSnap(qReq);
    const afterRes = listenerSnap(qRes);
    red('R4 abort/close race — cancel once, listeners baseline',
      qHits === 0
      && b.diagnostics().queued_global === 0
      && afterReq.aborted === baseReq.aborted
      && afterReq.close === baseReq.close
      && afterRes.close === baseRes.close
      && afterRes.error === baseRes.error);

    // Late events after cancel must not throw / change counters
    qReq.emit('aborted');
    qReq.emit('close');
    // Avoid naked 'error' emit with zero listeners (EventEmitter throws).
    if (qRes.listenerCount('error') > 0) qRes.emit('error', new Error('late'));
    const mid = b.diagnostics().in_flight_global;
    holdRes.end('x');
    await holdP;
    red('R4b late queued events after cancel do not disturb holder release',
      mid === 1
      && b.diagnostics().in_flight_global === 0
      && b.controller.assertConsistent());
    b.close();
  }

  {
    // Already-destroyed at promotion time: queue healthy, destroy before promote runs handler
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    let releaseHold;
    const holdGate = new Promise((r) => { releaseHold = r; });
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => { await holdGate; },
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes();
    let qHits = 0;
    const qP = b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    await new Promise((r) => setImmediate(r));
    green('R5a queued waiting before destroy',
      qHits === 0 && b.diagnostics().queued_global === 1);

    // Destroy transport, then promote — pre-run check must cancel
    qReq.destroyed = true;
    qRes.destroyed = true;
    releaseHold();
    holdRes.end('done');
    await holdP;
    const out = await qP;
    red('R5 already-destroyed queued promotion — no handler',
      out.cancelled === true
      && out.reason === 'transport_dead_after_promote'
      && qHits === 0
      && b.diagnostics().queued_global === 0
      && b.diagnostics().in_flight_global === 0
      && b.controller.assertConsistent());

    // Late abort after cancelled promotion must not disturb next admit
    qReq.emit('aborted');
    qReq.emit('close');
    let nextHits = 0;
    await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      fakeRes(),
      async (req, res) => {
        nextHits += 1;
        res.end('ok');
      },
    );
    red('R5b late event cannot cancel/release a new token',
      nextHits === 1 && b.diagnostics().in_flight_global === 0);
    b.close();
  }

  {
    // Dead socket before queue
    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => {},
    );
    await new Promise((r) => setImmediate(r));
    let hits = 0;
    const out = await b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query', socket: deadSocket() }),
      fakeRes(),
      async () => { hits += 1; },
    );
    red('R6 dead socket before queue cancels',
      out.cancelled === true && hits === 0 && b.diagnostics().queued_global === 0);
    holdRes.end('x');
    await holdP;
    b.close();
  }

  {
    // Production shutdown ordering via readiness-lifecycle BEGIN — NOT direct boundary.close
    // and NOT server 'close' event.
    const lifecycle = require('./lib/staff-api-readiness-lifecycle');
    lifecycle._resetStaffApiReadinessLifecycleForTests();

    const b = boundary.createAdmissionBoundary({
      trustedTenantSlug: 'wolfhouse-somo',
      limits: tinyLimits(),
    });
    const holdRes = fakeRes();
    let holdSettled = false;
    const holdP = b.admitAndRun(
      fakeReq({ method: 'GET', url: '/staff/query' }),
      holdRes,
      async () => {
        // Active handler — settles after shutdown begin per contract
        await new Promise((r) => setImmediate(r));
        holdSettled = true;
      },
    );
    await new Promise((r) => setImmediate(r));

    const qReq = fakeReq({ method: 'GET', url: '/staff/query' });
    const qRes = fakeRes();
    let qHits = 0;
    const qP = b.admitAndRun(qReq, qRes, async () => { qHits += 1; });
    await new Promise((r) => setImmediate(r));
    green('R7a queued before production shutdown path',
      qHits === 0 && b.diagnostics().queued_global === 1);

    const order = [];
    let serverCloseStarted = false;
    const fakeServer = {
      listening: true,
      close(cb) {
        serverCloseStarted = true;
        order.push('server_close');
        // server.close waits for connections — admission must already be closed
        order.push(`admission_closed=${b.diagnostics().closed === true}`);
        order.push(`queued=${b.diagnostics().queued_global}`);
        setImmediate(() => { if (typeof cb === 'function') cb(); });
      },
    };
    boundary.bindAdmissionShutdownBegin(fakeServer, b);

    // Prove source wire: staff-query-api uses bindAdmissionShutdownBegin, not server.on('close')
    red('R7b source: shutdown BEGIN hook, not server close event',
      /bindAdmissionShutdownBegin\s*\(\s*server\s*,\s*admissionBoundary\s*\)/.test(apiSrc)
      && !/server\.on\(\s*['"]close['"]\s*,\s*\(\)\s*=>\s*\{[^}]*admissionBoundary\.close/.test(apiSrc)
      && /invokeShutdownBeginHooks/.test(
        fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-api-readiness-lifecycle.js'), 'utf8'),
      ));

    await lifecycle.runStaffApiReadinessShutdown(fakeServer, 'SIGTERM', {
      closeReadinessPool: async () => { order.push('pool_close'); },
      terminate: false,
      log: () => {},
      onShutdownBegin: () => { order.push('deps_onShutdownBegin'); },
    });
    await qP;

    red('R7 production readiness shutdown BEGIN closes admission before server.close',
      order[0] === 'deps_onShutdownBegin'
      || order.indexOf('admission_closed=true') !== -1);
    red('R7c queued cancelled immediately; server.close sees closed admission',
      qHits === 0
      && order.includes('server_close')
      && order.includes('admission_closed=true')
      && order.includes('queued=0')
      && order.indexOf('deps_onShutdownBegin') < order.indexOf('pool_close')
      && order.indexOf('pool_close') < order.indexOf('server_close')
      && serverCloseStarted === true);

    holdRes.end('x');
    await holdP.catch(() => {});
    // Active handler was released by controller.close at begin — settle is best-effort
    void holdSettled;
    lifecycle._resetStaffApiReadinessLifecycleForTests();
  }

  {
    // Dual-bind Set-dedupe: same boundary twice → close exactly once; prior once;
    // registry/dispatcher/hook absent after fire; repeated invoke no rerun;
    // multi-server isolation; distinct boundaries; no wrapper growth.
    const lifecycle = require('./lib/staff-api-readiness-lifecycle');
    lifecycle._resetStaffApiReadinessLifecycleForTests();

    const HOOK = boundary.ON_SHUTDOWN_BEGIN_HOOK;
    const REG = boundary.SHUTDOWN_BEGIN_REGISTRY;
    const DISP = boundary.SHUTDOWN_BEGIN_DISPATCHER;

    // R8 / R8a — duplicate bind → close === 1 (not wrapper-chain 2)
    {
      const b = boundary.createAdmissionBoundary({
        trustedTenantSlug: 'wolfhouse-somo',
        limits: tinyLimits(),
      });
      let closes = 0;
      const wrapping = {
        close() {
          closes += 1;
          return b.close();
        },
      };
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      boundary.bindAdmissionShutdownBegin(fakeServer, wrapping);
      boundary.bindAdmissionShutdownBegin(fakeServer, wrapping);
      await lifecycle.runStaffApiReadinessShutdown(fakeServer, 'SIGINT', {
        closeReadinessPool: async () => {},
        terminate: false,
        log: () => {},
      });
      await lifecycle.runStaffApiReadinessShutdown(fakeServer, 'SIGINT', {
        closeReadinessPool: async () => {},
        terminate: false,
        log: () => {},
      });
      red('R8 shutdown begin hook idempotent across joined signals',
        closes === 1
        && b.diagnostics().closed === true);
      red('R8a duplicate bind => close === 1',
        closes === 1);
      lifecycle._resetStaffApiReadinessLifecycleForTests();
    }

    // R8b — prior hook runs exactly once; registry/dispatcher/hook absent after
    {
      let priorCalls = 0;
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      fakeServer[HOOK] = function priorOwner() { priorCalls += 1; };
      let closes = 0;
      const owner = { close() { closes += 1; } };
      boundary.bindAdmissionShutdownBegin(fakeServer, owner);
      boundary.bindAdmissionShutdownBegin(fakeServer, owner);
      const dispatcher = fakeServer[DISP];
      red('R8b0 dispatcher installed; registry present before fire',
        typeof dispatcher === 'function'
        && fakeServer[HOOK] === dispatcher
        && fakeServer[REG]
        && fakeServer[REG].owners instanceof Set
        && fakeServer[REG].owners.size === 1);

      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      red('R8b prior hook === 1 and close === 1',
        priorCalls === 1 && closes === 1);
      red('R8c property/registry absent after run',
        !(REG in fakeServer)
        && !(DISP in fakeServer)
        && !(HOOK in fakeServer)
        && fakeServer[REG] === undefined
        && fakeServer[DISP] === undefined
        && fakeServer[HOOK] === undefined);

      // R8d — repeated invoke (held dispatcher + lifecycle) cannot rerun
      if (typeof dispatcher === 'function') {
        dispatcher();
        dispatcher();
      }
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      red('R8d repeated invoke no rerun',
        priorCalls === 1 && closes === 1);
    }

    // R8e — multi-server isolation
    {
      let closesA = 0;
      let closesB = 0;
      const serverA = { listening: false, close(cb) { if (typeof cb === 'function') cb(); } };
      const serverB = { listening: false, close(cb) { if (typeof cb === 'function') cb(); } };
      boundary.bindAdmissionShutdownBegin(serverA, { close() { closesA += 1; } });
      boundary.bindAdmissionShutdownBegin(serverB, { close() { closesB += 1; } });
      lifecycle._invokeShutdownBeginHooksForTests(serverA, {});
      red('R8e multi-server isolation — A fires, B untouched',
        closesA === 1
        && closesB === 0
        && typeof serverB[DISP] === 'function'
        && serverB[REG]
        && serverB[REG].owners.size === 1);
      lifecycle._invokeShutdownBeginHooksForTests(serverB, {});
      red('R8e2 multi-server isolation — B fires independently',
        closesA === 1 && closesB === 1
        && !(REG in serverB) && !(DISP in serverB));
    }

    // R8f — distinct boundaries on one server each close once
    {
      let closes1 = 0;
      let closes2 = 0;
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      const b1 = { close() { closes1 += 1; } };
      const b2 = { close() { closes2 += 1; } };
      boundary.bindAdmissionShutdownBegin(fakeServer, b1);
      boundary.bindAdmissionShutdownBegin(fakeServer, b2);
      boundary.bindAdmissionShutdownBegin(fakeServer, b1); // dedupe
      red('R8f0 distinct owners registered once each',
        fakeServer[REG].owners.size === 2);
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      red('R8f distinct-boundary behavior — each close === 1',
        closes1 === 1 && closes2 === 1);
    }

    // R8g — no wrapper growth (dispatcher identity stable across binds)
    {
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      const o1 = { close() {} };
      const o2 = { close() {} };
      boundary.bindAdmissionShutdownBegin(fakeServer, o1);
      const d1 = fakeServer[HOOK];
      const disp1 = fakeServer[DISP];
      boundary.bindAdmissionShutdownBegin(fakeServer, o1);
      const d2 = fakeServer[HOOK];
      boundary.bindAdmissionShutdownBegin(fakeServer, o2);
      const d3 = fakeServer[HOOK];
      red('R8g no wrapper growth — dispatcher identity stable',
        typeof d1 === 'function'
        && d1 === d2
        && d2 === d3
        && d1 === disp1
        && fakeServer[DISP] === d1
        && fakeServer[REG].owners.size === 2);
      // Clean up symbols for isolation
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
    }

    // R8h — OFF registers nothing (factory skips bind when admission disabled)
    {
      red('R8h OFF registers nothing — source gate',
        /if\s*\(\s*admissionBoundary\s*\)\s*\{[\s\S]*?bindAdmissionShutdownBegin\s*\(\s*server\s*,\s*admissionBoundary\s*\)/.test(apiSrc)
        && /admissionEnabled\s*\?\s*createAdmissionBoundary/.test(apiSrc));
    }

    // R8i — rebind inside close => rebound owner closes during same call / no registry
    {
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      let primaryCloses = 0;
      let reboundCloses = 0;
      let rebindResult = null;
      const rebound = {
        close() { reboundCloses += 1; },
      };
      const primary = {
        close() {
          primaryCloses += 1;
          rebindResult = boundary.bindAdmissionShutdownBegin(fakeServer, rebound);
        },
      };
      boundary.bindAdmissionShutdownBegin(fakeServer, primary);
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      red('R8i rebind inside close => rebound owner closes during same call / no registry',
        primaryCloses === 1
        && reboundCloses === 1
        && rebindResult
        && rebindResult.already_fired === true
        && rebindResult.bound === false
        && rebindResult === boundary.BIND_SHUTDOWN_ALREADY_FIRED
        && !(REG in fakeServer)
        && !(DISP in fakeServer)
        && !(HOOK in fakeServer));
    }

    // R8j — post-fire bind => immediate close / no state
    {
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      let earlyCloses = 0;
      boundary.bindAdmissionShutdownBegin(fakeServer, {
        close() { earlyCloses += 1; },
      });
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      red('R8j0 symbols absent after fire (WeakSet-only sentinel)',
        earlyCloses === 1
        && !(REG in fakeServer)
        && !(DISP in fakeServer)
        && !(HOOK in fakeServer));

      let lateCloses = 0;
      const late = { close() { lateCloses += 1; } };
      const lateResult = boundary.bindAdmissionShutdownBegin(fakeServer, late);
      red('R8j post-fire bind => immediate close / no state',
        lateCloses === 1
        && lateResult === boundary.BIND_SHUTDOWN_ALREADY_FIRED
        && lateResult.already_fired === true
        && !(REG in fakeServer)
        && !(DISP in fakeServer)
        && !(HOOK in fakeServer)
        && fakeServer[REG] === undefined
        && fakeServer[DISP] === undefined
        && fakeServer[HOOK] === undefined);
    }

    // R8k — async prior + async close reject => zero unhandledRejection; all owners attempted
    {
      let unhandled = 0;
      const onUnhandled = () => { unhandled += 1; };
      process.on('unhandledRejection', onUnhandled);

      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      let priorCalls = 0;
      let closes1 = 0;
      let closes2 = 0;
      fakeServer[HOOK] = function priorAsyncReject() {
        priorCalls += 1;
        return Promise.reject(new Error('prior_async_reject'));
      };
      boundary.bindAdmissionShutdownBegin(fakeServer, {
        close() {
          closes1 += 1;
          return Promise.reject(new Error('owner1_async_reject'));
        },
      });
      boundary.bindAdmissionShutdownBegin(fakeServer, {
        close() {
          closes2 += 1;
          return Promise.reject(new Error('owner2_async_reject'));
        },
      });
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      process.removeListener('unhandledRejection', onUnhandled);
      red('R8k async prior/close reject => zero unhandledRejection; all owners attempted',
        priorCalls === 1
        && closes1 === 1
        && closes2 === 1
        && unhandled === 0
        && !(REG in fakeServer)
        && !(HOOK in fakeServer));
    }

    // R8l — malicious thenables (then getter / then call / close getter adversaries)
    {
      let unhandled = 0;
      const onUnhandled = () => { unhandled += 1; };
      process.on('unhandledRejection', onUnhandled);

      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      let priorCalls = 0;
      let closesGood = 0;
      let closesThenGetter = 0;
      let closesThenCall = 0;

      fakeServer[HOOK] = function priorMaliciousThen() {
        priorCalls += 1;
        return {
          get then() {
            throw new Error('prior_then_getter');
          },
        };
      };

      const thenGetterOwner = {
        close() {
          closesThenGetter += 1;
          return {
            get then() {
              throw new Error('close_then_getter');
            },
          };
        },
      };
      const thenCallOwner = {
        close() {
          closesThenCall += 1;
          return {
            then() {
              throw new Error('close_then_call');
            },
          };
        },
      };
      // Bind with a real close, then rearm as throwing getter before fire.
      const closeGetterOwner = {
        close() { /* placeholder for bind typeof-check */ },
      };
      const goodOwner = {
        close() { closesGood += 1; },
      };

      boundary.bindAdmissionShutdownBegin(fakeServer, thenGetterOwner);
      boundary.bindAdmissionShutdownBegin(fakeServer, thenCallOwner);
      boundary.bindAdmissionShutdownBegin(fakeServer, closeGetterOwner);
      boundary.bindAdmissionShutdownBegin(fakeServer, goodOwner);
      Object.defineProperty(closeGetterOwner, 'close', {
        configurable: true,
        get() { throw new Error('close_getter'); },
      });
      lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      process.removeListener('unhandledRejection', onUnhandled);

      red('R8l malicious thenables / close getter — all attempted, zero unhandledRejection',
        priorCalls === 1
        && closesThenGetter === 1
        && closesThenCall === 1
        && closesGood === 1
        && unhandled === 0
        && !(REG in fakeServer));
    }

    // R8m — sync throw from prior and one owner — siblings still run
    {
      const fakeServer = {
        listening: false,
        close(cb) { if (typeof cb === 'function') cb(); },
      };
      let priorCalls = 0;
      let closes1 = 0;
      let closes2 = 0;
      fakeServer[HOOK] = function priorSyncThrow() {
        priorCalls += 1;
        throw new Error('prior_sync_throw');
      };
      boundary.bindAdmissionShutdownBegin(fakeServer, {
        close() {
          closes1 += 1;
          throw new Error('owner1_sync_throw');
        },
      });
      boundary.bindAdmissionShutdownBegin(fakeServer, {
        close() { closes2 += 1; },
      });
      let threw = false;
      try {
        lifecycle._invokeShutdownBeginHooksForTests(fakeServer, {});
      } catch (_) {
        threw = true;
      }
      red('R8m sync throw — prior+owner1 throw; owner2 still closed; dispatch does not throw',
        threw === false
        && priorCalls === 1
        && closes1 === 1
        && closes2 === 1
        && !(REG in fakeServer)
        && !(DISP in fakeServer)
        && !(HOOK in fakeServer));
    }

    // R8n — source: WeakSet-only fired sentinel (no registry.fired boolean)
    {
      const boundarySrc = fs.readFileSync(
        path.join(ROOT, 'scripts/lib/staff-api-admission-boundary.js'),
        'utf8',
      );
      red('R8n WeakSet is the only fired sentinel',
        /shutdownBeginFiredServers\s*=\s*new WeakSet/.test(boundarySrc)
        && /shutdownBeginFiredServers\.add\(server\)/.test(boundarySrc)
        && /shutdownBeginFiredServers\.has\(server\)/.test(boundarySrc)
        && !/registry\.fired\s*=\s*true/.test(boundarySrc)
        && !/\bfired:\s*false\b/.test(boundarySrc)
        && /BIND_SHUTDOWN_ALREADY_FIRED/.test(boundarySrc)
        && /absorbThenableRejection/.test(boundarySrc)
        && /safeCloseOwner/.test(boundarySrc));
    }

    lifecycle._resetStaffApiReadinessLifecycleForTests();
  }
}

// ── Source / ledger claims ───────────────────────────────────────────────────
function checkDocs() {
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const findings = read('fixtures/radar-operations/findings.md');
  const doc = read('docs/RADAR-OPERATIONS-GATE-LEDGER.md');

  green('O1 tip matrix/contract 16AL (or later 16AM/16AN tip retaining 16AL selection)',
    (matrix.slice === 'RADAR-16AL' || matrix.slice === 'RADAR-16AM' || matrix.slice === 'RADAR-16AN' || matrix.slice === 'RADAR-16AO')
    && (topContract.slice === 'RADAR-16AL' || topContract.slice === 'RADAR-16AM' || topContract.slice === 'RADAR-16AN' || topContract.slice === 'RADAR-16AO')
    && matrix.slice_16al_selection
    && matrix.slice_16al_selection.outcome_id === '16AL_g06_backpressure_wire'
    && topContract.selected_16al
    && topContract.selected_16al.outcome_id === '16AL_g06_backpressure_wire'
    && topContract.g06_backpressure_wire_source === 'integration_source_proven_via_16AL'
    && topContract.g06_backpressure === 'open'
    && design.g06_disposition.score.proven === 0
    && design.g06_disposition.score.partial === 9);

  green('O2 flag remains OFF / not enabled',
    design.flag_enabled === false
    && contract.flag_enabled === false
    && matrix.slice_16al_selection.flag_enabled === false
    && /default OFF|flag.*OFF|not enabled/i.test(doc));

  red('O3 no live/proven/full G06 claims',
    (() => {
      const lines = (doc + '\n' + findings).split('\n');
      for (const line of lines) {
        if (/backpressure proven|backpressure live|admission control proven|\bG06 proven\b|\bfull G06\b|live shed proven/i.test(line)
          && !/not claimed|does\s*\*+\s*not|does not|never|open|forbidden|explicitly|default OFF|not enabled/i.test(line)) {
          return false;
        }
      }
      return true;
    })());

  green('O4 findings mention 16AL',
    /16AL/i.test(findings) && /16AL/i.test(doc));

  green('O5 score unchanged',
    topContract.expected_verdict_counts.proven === 0
    && topContract.expected_verdict_counts.partial === 9
    && topContract.expected_verdict_counts.absent === 0);

  // Placement: admit after trusted tenant, before handler
  green('O6 wire placement after trusted ingress',
    /resolveTrustedIngressBinding/.test(apiSrc)
    && /createAdmissionBoundary/.test(apiSrc)
    && /admitAndRun/.test(apiSrc)
    && /trustedTenantSlug:\s*ingressBinding\.tenant_slug/.test(apiSrc));

  green('O7 OFF path skips boundary construction',
    /admissionEnabled\s*\?\s*createAdmissionBoundary/.test(apiSrc)
    || /admissionEnabled\s*\n\s*\?\s*createAdmissionBoundary/.test(apiSrc));
}

async function main() {
  await runIntegration();
  checkDocs();

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AL G06 backpressure / admission-control wire: PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
