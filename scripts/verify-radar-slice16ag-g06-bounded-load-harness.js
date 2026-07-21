'use strict';

/**
 * verify:radar-slice16ag-g06-bounded-load-harness — RADAR Slice 16AG
 *
 * Offline gate: dependency-free bounded /readyz load harness with fail-closed
 * seals against real http/https/net/DNS. Exercises production-shaped fixed
 * HTTPS transport via runBoundedLoadOffline(OFFLINE_SEAL) against a local fake
 * server. Proves allowlist, bounds, concurrency, redirects, latency (monotonic,
 * transport latency ignored), timeout/error/non-2xx, hanging/trickle/abort/
 * close settle, deadline cleanup, DNS private/IANA-special-purpose reject,
 * hanging/late DNS settle (no request start), header/body/auth not sent, and
 * caller transport escape reject. Does NOT execute live staging
 * network calls, deploy, or scale mutation.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const path = require('path');
const { EventEmitter } = require('events');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ag-g06-bounded-load-harness');
const harness = require('./lib/radar-g06-bounded-load-harness');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];
let sealedNetworkHits = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runtimePathsUnchanged() {
  try {
    const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/radar-operations/gate-matrix.json'), 'utf8'));
    const basis = matrix.slice === 'RADAR-16AI'
      ? 'd04b633390bdcacfe3a04eed4796bba4184e29f8'
      : matrix.slice === 'RADAR-16AH'
      ? '6c24e9456bd42c7fa1b051bb1308aae8f632b293'
      : locks.MASTER_BASIS;
    const out = execSync(
      `git diff --name-only ${basis} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function expectThrow(fn, codePrefix) {
  try {
    fn();
    return { ok: false, detail: 'did not throw' };
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = err && err.message ? String(err.message) : '';
    if (codePrefix && !code.startsWith(codePrefix) && !msg.includes('fail_closed')) {
      return { ok: false, detail: `code=${code} msg=${msg}` };
    }
    return { ok: true, detail: code || msg };
  }
}

async function expectThrowAsync(fn, codePrefix) {
  try {
    await fn();
    return { ok: false, detail: 'did not throw' };
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const msg = err && err.message ? String(err.message) : '';
    if (codePrefix && !code.startsWith(codePrefix) && !msg.includes('fail_closed')) {
      return { ok: false, detail: `code=${code} msg=${msg}` };
    }
    return { ok: true, detail: code || msg };
  }
}

function reportHasNoBodies(report) {
  const json = JSON.stringify(report);
  if (/"body"\s*:/.test(json) && !/"body_sent":false/.test(json)) return false;
  if (/response_body/i.test(json) && !/"response_bodies_collected":false/.test(json)) return false;
  if (/"_test_body"/.test(json)) return false;
  if (/"status":"ready"/.test(json)) return false;
  return report.response_bodies_collected === false;
}

/** Hold real primitives before fail-closed seal; used only for local fake server. */
const realHttp = {
  createServer: http.createServer.bind(http),
  request: http.request.bind(http),
  get: http.get.bind(http),
};
const realHttps = {
  request: https.request.bind(https),
  get: https.get.bind(https),
};
const realNet = {
  connect: net.connect.bind(net),
  createConnection: net.createConnection.bind(net),
  createServer: net.createServer.bind(net),
};
const realDns = {
  lookup: dns.lookup.bind(dns),
  resolve: dns.resolve && dns.resolve.bind(dns),
  resolve4: dns.resolve4 && dns.resolve4.bind(dns),
  resolve6: dns.resolve6 && dns.resolve6.bind(dns),
  Resolver: dns.Resolver,
};

function sealThrow(kind) {
  return function sealedNetworkCall() {
    sealedNetworkHits += 1;
    const err = new Error(`fail_closed: offline verifier blocked ${kind}`);
    err.code = 'RADAR_OFFLINE_NETWORK_SEAL';
    throw err;
  };
}

function installNetworkFailClosed() {
  http.request = sealThrow('http.request');
  http.get = sealThrow('http.get');
  https.request = sealThrow('https.request');
  https.get = sealThrow('https.get');
  function isLoopbackHost(host) {
    const h = String(host || '');
    return h === '127.0.0.1' || h === '::1' || h === 'localhost';
  }

  // Allow loopback sockets only for the local fake server; block all other net.
  net.connect = function sealedConnect(...args) {
    const opts = args[0];
    let host = null;
    if (typeof opts === 'number') {
      host = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof opts === 'string') {
      host = opts;
    } else if (opts && typeof opts === 'object') {
      host = opts.host || opts.hostname || null;
    }
    if (isLoopbackHost(host)) return realNet.connect(...args);
    sealedNetworkHits += 1;
    const err = new Error('fail_closed: offline verifier blocked net.connect');
    err.code = 'RADAR_OFFLINE_NETWORK_SEAL';
    throw err;
  };
  net.createConnection = function sealedCreateConnection(...args) {
    return net.connect(...args);
  };
  // Allow literal loopback DNS only so local fake-server listen(127.0.0.1)
  // can bind; any other hostname/DNS API remains fail-closed.
  dns.lookup = function sealedDnsLookup(hostname, options, callback) {
    const host = String(hostname || '');
    if (isLoopbackHost(host)) {
      return realDns.lookup(hostname, options, callback);
    }
    sealedNetworkHits += 1;
    const err = new Error('fail_closed: offline verifier blocked dns.lookup');
    err.code = 'RADAR_OFFLINE_NETWORK_SEAL';
    if (typeof options === 'function') {
      process.nextTick(() => options(err));
      return;
    }
    if (typeof callback === 'function') {
      process.nextTick(() => callback(err));
      return;
    }
    throw err;
  };
  if (dns.resolve) dns.resolve = sealThrow('dns.resolve');
  if (dns.resolve4) dns.resolve4 = sealThrow('dns.resolve4');
  if (dns.resolve6) dns.resolve6 = sealThrow('dns.resolve6');
  if (dns.Resolver) {
    dns.Resolver = function SealedResolver() {
      sealedNetworkHits += 1;
      throw Object.assign(new Error('fail_closed: offline verifier blocked dns.Resolver'), {
        code: 'RADAR_OFFLINE_NETWORK_SEAL',
      });
    };
  }
}

function restoreNetwork() {
  http.request = realHttp.request;
  http.get = realHttp.get;
  https.request = realHttps.request;
  https.get = realHttps.get;
  net.connect = realNet.connect;
  net.createConnection = realNet.createConnection;
  dns.lookup = realDns.lookup;
  if (realDns.resolve) dns.resolve = realDns.resolve;
  if (realDns.resolve4) dns.resolve4 = realDns.resolve4;
  if (realDns.resolve6) dns.resolve6 = realDns.resolve6;
  if (realDns.Resolver) dns.Resolver = realDns.Resolver;
}

function startFakeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = realHttp.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        origin: `http://127.0.0.1:${addr.port}`,
      });
    });
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) return resolve();
    server.close(() => resolve());
  });
}

/**
 * Offline https.request stand-in: talks to local fake HTTP origin while the
 * harness still validates allowlisted logical HTTPS targets + pinned DNS.
 * Captures request options for header/body/auth REDs. Never touches staging.
 */
function makeOfflineHttpsRequest(fakeOrigin, behavior, capture) {
  const port = Number(new URL(fakeOrigin).port);
  return function offlineHttpsRequest(options, callback) {
    const opts = typeof options === 'string' ? new URL(options) : (options || {});
    if (capture) {
      capture.calls.push({
        method: opts.method || 'GET',
        headers: { ...(opts.headers || {}) },
        path: opts.path,
        hostname: opts.hostname,
        hasAuth: !!(opts.auth || (opts.headers && (opts.headers.Authorization || opts.headers.authorization))),
        bodyChunks: [],
      });
    }

    const mode = behavior && typeof behavior.mode === 'function'
      ? behavior.mode()
      : (behavior && behavior.mode) || 'ok';

    // Synthetic ClientRequest-like emitter for hang/abort/close/redirect modes
    // that do not need a real socket, plus real local HTTP for ok/trickle.
    if (mode === 'hang') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => {
          req.emit('error', err || Object.assign(new Error('destroyed'), { code: 'ECONNRESET' }));
        });
      };
      req.end = function end() {};
      req.write = function write() {
        if (capture && capture.calls.length) capture.calls[capture.calls.length - 1].bodyChunks.push('x');
        return true;
      };
      return req;
    }

    if (mode === 'force_redirect') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      };
      req.end = function end() {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 302;
          res.headers = { location: 'https://evil.example/readyz' };
          callback(res);
          process.nextTick(() => {
            res.emit('data', Buffer.from('redirect'));
            res.emit('end');
          });
        });
      };
      req.write = function write() { return true; };
      return req;
    }

    if (mode === 'premature_close') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      };
      req.end = function end() {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          process.nextTick(() => {
            res.emit('data', Buffer.from('partial'));
            res.emit('close'); // no 'end' → premature close settle
          });
        });
      };
      req.write = function write() { return true; };
      return req;
    }

    if (mode === 'response_error') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      };
      req.end = function end() {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          process.nextTick(() => {
            res.emit('error', Object.assign(new Error('res boom'), { code: 'RES_BOOM' }));
          });
        });
      };
      req.write = function write() { return true; };
      return req;
    }

    if (mode === 'aborted') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      };
      req.end = function end() {
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          callback(res);
          process.nextTick(() => {
            res.emit('aborted');
          });
        });
      };
      req.write = function write() { return true; };
      return req;
    }

    if (mode === 'req_error') {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = function destroy(err) {
        req.destroyed = true;
        process.nextTick(() => req.emit('error', err || new Error('destroyed')));
      };
      req.end = function end() {
        process.nextTick(() => {
          req.emit('error', Object.assign(new Error('req boom'), { code: 'REQ_BOOM' }));
        });
      };
      req.write = function write() { return true; };
      return req;
    }

    // Real local HTTP for ok / trickle / status cycling.
    const statusCode = behavior && behavior.statusCode ? behavior.statusCode : 200;
    const trickle = mode === 'trickle';
    const delayMs = behavior && behavior.delayMs ? behavior.delayMs : 0;

    const req = realHttp.request({
      hostname: '127.0.0.1',
      port,
      path: '/readyz',
      method: 'GET',
      headers: {},
    }, (res) => {
      if (trickle) {
        const wrapped = new EventEmitter();
        wrapped.statusCode = res.statusCode || statusCode;
        wrapped.headers = res.headers;
        callback(wrapped);
        let n = 0;
        const iv = setInterval(() => {
          n += 1;
          wrapped.emit('data', Buffer.from('.'));
          if (n >= 3) {
            clearInterval(iv);
            wrapped.emit('end');
          }
        }, behavior.trickleIntervalMs || 40);
        res.on('data', () => {});
        res.on('end', () => {});
        return;
      }
      // Pass through the real IncomingMessage so end/close ordering stays intact
      // (wrapping with late listeners can miss 'end' and false-trigger premature close).
      if (behavior && behavior.statusCycle) {
        const wrapped = new EventEmitter();
        wrapped.statusCode = behavior.statusCycle();
        wrapped.headers = res.headers;
        callback(wrapped);
        res.on('data', (c) => wrapped.emit('data', c));
        res.on('end', () => {
          wrapped.complete = true;
          wrapped.emit('end');
        });
        res.on('aborted', () => wrapped.emit('aborted'));
        res.on('error', (e) => wrapped.emit('error', e));
        res.on('close', () => wrapped.emit('close'));
        return;
      }
      callback(res);
    });

    // Bridge destroy/error so harness deadline abort settles.
    const origDestroy = req.destroy.bind(req);
    req.destroy = function destroy(err) {
      return origDestroy(err);
    };

    if (delayMs > 0) {
      const end = req.end.bind(req);
      req.end = function delayedEnd() {
        setTimeout(() => end(), delayMs);
      };
    }
    return req;
  };
}

function publicDnsLookup(hostname, options, callback) {
  let cb = callback;
  if (typeof options === 'function') cb = options;
  // Fixture globally-routable address — never a live resolve; offline HTTPS
  // talks to the local fake origin and ignores the pinned IP for connect.
  process.nextTick(() => cb(null, [{ address: '8.8.8.8', family: 4 }]));
}

function privateDnsLookup(hostname, options, callback) {
  let cb = callback;
  if (typeof options === 'function') cb = options;
  process.nextTick(() => cb(null, [{ address: '10.0.0.5', family: 4 }]));
}

function loopbackDnsLookup(hostname, options, callback) {
  let cb = callback;
  if (typeof options === 'function') cb = options;
  process.nextTick(() => cb(null, [{ address: '127.0.0.1', family: 4 }]));
}

function hangingDnsLookup(_hostname, _options, _callback) {
  // Missing callback: must settle via remaining run-budget DNS race.
}

function makeLateDnsLookup(delayMs, address) {
  return function lateDnsLookup(hostname, options, callback) {
    let cb = callback;
    if (typeof options === 'function') cb = options;
    setTimeout(() => {
      cb(null, [{ address: address || '8.8.8.8', family: 4 }]);
    }, delayMs);
  };
}

async function runOffline(target, profile, fakeOrigin, behavior, capture) {
  return harness.runBoundedLoadOffline(
    { target, profile },
    {
      seal: harness.OFFLINE_SEAL,
      httpsRequest: makeOfflineHttpsRequest(fakeOrigin, behavior || { mode: 'ok' }, capture),
      dnsLookup: publicDnsLookup,
    },
  );
}

async function runVerifier() {
  console.log('RADAR 16AG G06 bounded load harness — offline fail-closed verifier\n');

  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');
  const harnessSrc = readText(locks.HARNESS_REL);
  const verifySrc = readText(locks.VERIFY_REL);

  const tip16ah = matrix.slice === 'RADAR-16AH';
  const tip16ai = matrix.slice === 'RADAR-16AI';
  const tipBranchOk = (tip16ah && currentBranch() === 'radar/slice-16ah-g06-live-load-correction')
    || (tip16ai && currentBranch() === 'radar/slice-16ai-g06-live-load-evidence');
  const tipBasisOk = (tip16ah && matrix.master_basis === '6c24e9456bd42c7fa1b051bb1308aae8f632b293'
      && topContract.master_basis === '6c24e9456bd42c7fa1b051bb1308aae8f632b293')
    || (tip16ai && matrix.master_basis === 'd04b633390bdcacfe3a04eed4796bba4184e29f8'
      && topContract.master_basis === 'd04b633390bdcacfe3a04eed4796bba4184e29f8');
  ok('C1 HEAD on 16AG branch (or 16AH/16AI tip)', currentBranch() === locks.BRANCH || tipBranchOk, currentBranch());
  ok('C2 master_basis locked (16AG lock or 16AH/16AI tip)',
    (locks.MASTER_BASIS === '7a283b70d38a4906e6279d82a49c0f6dd2a4994e'
      && sliceContract.master_basis === locks.MASTER_BASIS
      && matrix.master_basis === locks.MASTER_BASIS
      && topContract.master_basis === locks.MASTER_BASIS)
    || tipBasisOk);
  ok('C3 slice/outcome/branch locked (16AG lock or 16AH/16AI tip)',
    (sliceContract.slice === locks.SLICE
      && sliceContract.outcome_id === locks.OUTCOME_ID
      && sliceContract.branch === locks.BRANCH
      && matrix.slice === locks.SLICE
      && matrix.branch === locks.BRANCH
      && topContract.slice === locks.SLICE
      && topContract.branch === locks.BRANCH)
    || (tip16ah
      && matrix.slice === 'RADAR-16AH'
      && matrix.branch === 'radar/slice-16ah-g06-live-load-correction'
      && topContract.slice === 'RADAR-16AH'
      && topContract.branch === 'radar/slice-16ah-g06-live-load-correction'
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH)
    || (tip16ai
      && matrix.slice === 'RADAR-16AI'
      && matrix.branch === 'radar/slice-16ai-g06-live-load-evidence'
      && topContract.slice === 'RADAR-16AI'
      && topContract.branch === 'radar/slice-16ai-g06-live-load-evidence'
      && sliceContract.slice === locks.SLICE
      && sliceContract.branch === locks.BRANCH));

  ok('C4 live flags false',
    sliceContract.live_deploy === false
    && sliceContract.live_mutation === false
    && sliceContract.live_network === false
    && sliceContract.this_slice_deploys === false
    && matrix.live_mutation === false);

  green('allowlist_exact_two_readyz',
    harness.ALLOWED_TARGETS.length === 2
    && harness.ALLOWED_TARGETS[0] === locks.WH_READYZ_URL
    && harness.ALLOWED_TARGETS[1] === locks.SUNSET_READYZ_URL
    && JSON.stringify(sliceContract.allowed_targets) === JSON.stringify(locks.ALLOWED_TARGETS));

  // Source: production runBoundedLoad must not accept caller transport.
  ok('C0 production path has no caller transport escape',
    /rejectCallerTransportEscape/.test(harnessSrc)
    && /RADAR_LOAD_TRANSPORT_ESCAPE/.test(harnessSrc)
    && /fixedHttpsGet/.test(harnessSrc)
    && /hrtime\.bigint/.test(harnessSrc)
    && /pinValidatedPublicDns/.test(harnessSrc)
    && /isGloballyRoutableIp/.test(harnessSrc)
    && /IANA_IPV4_SPECIAL_PURPOSE/.test(harnessSrc)
    && /IANA_IPV6_SPECIAL_PURPOSE/.test(harnessSrc)
    && /globallyReachable/.test(harnessSrc)
    && /RADAR_LOAD_DNS_DEADLINE/.test(harnessSrc)
    && /wallStartNs/.test(harnessSrc)
    && !/opts\.transport\s*=/.test(harnessSrc)
    && !/_defaultHttpsTransport/.test(harnessSrc));

  ok('C0b IANA special-purpose tables present and complete',
    Array.isArray(harness.IANA_IPV4_SPECIAL_PURPOSE)
    && harness.IANA_IPV4_SPECIAL_PURPOSE.length >= 26
    && Array.isArray(harness.IANA_IPV6_SPECIAL_PURPOSE)
    && harness.IANA_IPV6_SPECIAL_PURPOSE.length >= 25
    && harness.IANA_IPV4_SPECIAL_PURPOSE.every((e) => typeof e.globallyReachable === 'boolean'
      && typeof e.prefix === 'string' && typeof e.prefixLen === 'number')
    && harness.IANA_IPV6_SPECIAL_PURPOSE.every((e) => typeof e.globallyReachable === 'boolean'
      && typeof e.prefix === 'string' && typeof e.prefixLen === 'number')
    && harness.IANA_IPV4_SPECIAL_PURPOSE.some((e) => e.prefix === '192.88.99.0/24' && e.globallyReachable === false)
    && harness.IANA_IPV4_SPECIAL_PURPOSE.some((e) => e.prefix === '192.0.0.9/32' && e.globallyReachable === true)
    && harness.IANA_IPV4_SPECIAL_PURPOSE.some((e) => e.prefix === '192.0.0.10/32' && e.globallyReachable === true)
    && harness.IANA_IPV6_SPECIAL_PURPOSE.some((e) => e.prefix === '2001:2::/48' && e.globallyReachable === false)
    && harness.IANA_IPV6_SPECIAL_PURPOSE.some((e) => e.prefix === '2001:10::/28' && e.globallyReachable === false)
    && harness.IANA_IPV6_SPECIAL_PURPOSE.some((e) => e.prefix === '2001:20::/28' && e.globallyReachable === true));

  // --- RED: fail-closed target / profile escapes ---
  red('target_escape_rejected',
    expectThrow(() => harness.assertAllowedTarget('https://evil.example/readyz'), 'RADAR_LOAD').ok);

  red('http_target_rejected',
    expectThrow(() => harness.assertAllowedTarget('http://staff-staging.lunafrontdesk.com/readyz'), 'RADAR_LOAD').ok);

  red('non_readyz_path_rejected',
    expectThrow(() => harness.assertAllowedTarget('https://staff-staging.lunafrontdesk.com/healthz'), 'RADAR_LOAD').ok);

  red('query_string_rejected',
    expectThrow(
      () => harness.assertAllowedTarget('https://staff-staging.lunafrontdesk.com/readyz?x=1'),
      'RADAR_LOAD',
    ).ok);

  red('concurrency_over_max_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: locks.HARNESS_BOUNDS.MAX_CONCURRENCY + 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
    }), 'RADAR_LOAD').ok);

  red('duration_over_max_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: locks.HARNESS_BOUNDS.MAX_DURATION_MS + 1,
      max_requests: 10,
      request_timeout_ms: 1000,
    }), 'RADAR_LOAD').ok);

  red('requests_over_max_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: locks.HARNESS_BOUNDS.MAX_REQUESTS + 1,
      request_timeout_ms: 1000,
    }), 'RADAR_LOAD').ok);

  red('timeout_over_max_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: locks.HARNESS_BOUNDS.MAX_REQUEST_TIMEOUT_MS + 1,
    }), 'RADAR_LOAD').ok);

  red('post_method_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      method: 'POST',
    }), 'RADAR_LOAD').ok);

  red('custom_headers_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      headers: { Authorization: 'Bearer x' },
    }), 'RADAR_LOAD').ok);

  red('body_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      body: '{}',
    }), 'RADAR_LOAD').ok);

  red('auth_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      auth: 'user:pass',
    }), 'RADAR_LOAD').ok);

  red('follow_redirects_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      follow_redirects: true,
    }), 'RADAR_LOAD').ok);

  red('collect_bodies_rejected',
    expectThrow(() => harness.clampProfile({
      concurrency: 1,
      max_duration_ms: 5000,
      max_requests: 10,
      request_timeout_ms: 1000,
      collect_response_bodies: true,
    }), 'RADAR_LOAD').ok);

  // Transport escape on production entry
  {
    const t = await expectThrowAsync(
      () => harness.runBoundedLoad({
        target: locks.WH_READYZ_URL,
        transport: async () => ({ kind: 'status', status_code: 200, latency_ms: 1 }),
      }),
      'RADAR_LOAD_TRANSPORT_ESCAPE',
    );
    red('transport_escape_rejected', t.ok, t.detail);
  }

  // DNS / private + IANA special-purpose (fail-closed globally-routable)
  red('dns_private_address_rejected',
    expectThrow(() => harness.assertPublicDnsAddresses([{ address: '10.1.2.3', family: 4 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '127.0.0.1', family: 4 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '192.168.0.1', family: 4 }]), 'RADAR_LOAD').ok
    && harness.isGloballyRoutableIp('8.8.8.8') === true
    && harness.isGloballyRoutableIp('10.0.0.1') === false
    && harness.isPublicIp('8.8.8.8') === true);

  red('dns_special_ranges_rejected',
    harness.isGloballyRoutableIp('192.0.2.10') === false // documentation TEST-NET-1
    && harness.isGloballyRoutableIp('198.51.100.1') === false // TEST-NET-2
    && harness.isGloballyRoutableIp('203.0.113.5') === false // TEST-NET-3
    && harness.isGloballyRoutableIp('198.18.0.1') === false // benchmark
    && harness.isGloballyRoutableIp('240.0.0.1') === false // reserved
    && harness.isGloballyRoutableIp('224.0.0.1') === false // multicast (outside IANA table)
    && harness.isGloballyRoutableIp('169.254.1.1') === false // link-local
    && harness.isGloballyRoutableIp('0.0.0.0') === false // unspecified
    && harness.isGloballyRoutableIp('192.88.99.1') === false // deprecated 6to4 relay anycast
    && harness.isGloballyRoutableIp('2001:2::1') === false // benchmarking
    && harness.isGloballyRoutableIp('2001:10::1') === false // deprecated ORCHID
    && harness.isGloballyRoutableIp('::1') === false
    && harness.isGloballyRoutableIp('::') === false
    && harness.isGloballyRoutableIp('fe80::1') === false
    && harness.isGloballyRoutableIp('fc00::1') === false
    && harness.isGloballyRoutableIp('ff02::1') === false
    && harness.isGloballyRoutableIp('2001:db8::1') === false
    && harness.isGloballyRoutableIp('2001:4860:4860::8888') === true
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '192.0.2.1', family: 4 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '2001:db8::1', family: 6 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '198.18.1.1', family: 4 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '192.88.99.1', family: 4 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '2001:2::1', family: 6 }]), 'RADAR_LOAD').ok
    && expectThrow(() => harness.assertPublicDnsAddresses([{ address: '2001:10::1', family: 6 }]), 'RADAR_LOAD').ok);

  // Table-driven RED/GREEN across every IANA special-purpose prefix + ordinary public controls.
  {
    const ordinaryPublic = [
      '8.8.8.8',
      '1.1.1.1',
      '9.9.9.9',
      '2001:4860:4860::8888',
      '2606:4700:4700::1111',
    ];
    for (const ip of ordinaryPublic) {
      green(`iana_ordinary_public_${ip}`, harness.isGloballyRoutableIp(ip) === true, ip);
    }

    // Globally-reachable exceptions inside otherwise non-global 192.0.0.0/24.
    green('iana_global_exception_192.0.0.9/32',
      harness.isGloballyRoutableIp('192.0.0.9') === true
      && !expectThrow(() => harness.assertPublicDnsAddresses([{ address: '192.0.0.9', family: 4 }]), 'RADAR_LOAD').ok);
    green('iana_global_exception_192.0.0.10/32',
      harness.isGloballyRoutableIp('192.0.0.10') === true
      && !expectThrow(() => harness.assertPublicDnsAddresses([{ address: '192.0.0.10', family: 4 }]), 'RADAR_LOAD').ok);
    green('iana_global_orchidv2_2001:20::/28',
      harness.isGloballyRoutableIp('2001:20::1') === true);

    // IPv4-mapped addresses follow the IANA ::ffff:0:0/96 non-global row.
    red('iana_v6_mapped_embedded_private',
      harness.isGloballyRoutableIp('::ffff:10.0.0.1') === false
      && harness.isGloballyRoutableIp('::ffff:192.0.2.1') === false);
    red('iana_v6_mapped_embedded_public_still_nonglobal',
      harness.isGloballyRoutableIp('::ffff:8.8.8.8') === false);

    for (const entry of harness.IANA_IPV4_SPECIAL_PURPOSE) {
      const sample = harness.sampleAddressForIanaEntry(entry);
      const got = harness.isGloballyRoutableIp(sample);
      const id = entry.globallyReachable
        ? `iana_v4_global_${entry.prefix}`
        : `iana_v4_nonglobal_${entry.prefix}`;
      const cond = got === entry.globallyReachable;
      if (entry.globallyReachable) green(id, cond, `${sample} → ${got}`);
      else red(id, cond, `${sample} → ${got}`);
    }

    for (const entry of harness.IANA_IPV6_SPECIAL_PURPOSE) {
      const sample = harness.sampleAddressForIanaEntry(entry);
      const got = harness.isGloballyRoutableIp(sample);
      const id = entry.globallyReachable
        ? `iana_v6_global_${entry.prefix}`
        : `iana_v6_nonglobal_${entry.prefix}`;
      const cond = got === entry.globallyReachable;
      if (entry.globallyReachable) green(id, cond, `${sample} → ${got}`);
      else red(id, cond, `${sample} → ${got}`);
    }
  }

  // Install fail-closed seals BEFORE any offline load runs.
  installNetworkFailClosed();

  try {
    // Prove sealed modules reject (dns.lookup uses callback err for non-loopback).
    let dnsSealOk = false;
    {
      const dnsErr = await new Promise((resolve) => {
        try {
          dns.lookup('example.com', (err) => resolve(err || new Error('missing err')));
        } catch (err) {
          resolve(err);
        }
      });
      dnsSealOk = !!(dnsErr && dnsErr.code === 'RADAR_OFFLINE_NETWORK_SEAL');
    }
    ok('C_SEAL http/https/net/dns fail closed',
      expectThrow(() => http.request('http://example.com'), 'RADAR_OFFLINE').ok
      && expectThrow(() => https.request('https://example.com'), 'RADAR_OFFLINE').ok
      && expectThrow(() => net.connect({ host: '1.1.1.1', port: 443 }), 'RADAR_OFFLINE').ok
      && dnsSealOk);

    const fake = await startFakeServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/readyz') {
        res.writeHead(404);
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ready"}');
    });

    try {
      const capture = { calls: [] };
      const report = await runOffline(
        locks.WH_READYZ_URL,
        {
          concurrency: 2,
          max_duration_ms: 5000,
          max_requests: 8,
          request_timeout_ms: 1000,
        },
        fake.origin,
        { mode: 'ok' },
        capture,
      );

      green('bounds_respected',
        report.completed <= 8
        && report.started <= 8
        && report.peak_in_flight <= 2
        && report.profile.concurrency === 2);

      green('concurrency_peak_bounded',
        report.peak_in_flight >= 1
        && report.peak_in_flight <= 2);

      green('max_requests_stop',
        report.stop_reason === 'max_requests'
        && report.completed === 8
        && report.status_counts['2xx'] === 8);

      green('latency_percentiles_present',
        report.latency
        && report.latency.count === 8
        && typeof report.latency.p50_ms === 'number'
        && typeof report.latency.p95_ms === 'number'
        && typeof report.latency.p99_ms === 'number'
        && typeof report.latency.max_ms === 'number'
        && report.latency.max_ms >= report.latency.p50_ms);

      red('response_bodies_absent_from_report', reportHasNoBodies(report));

      red('header_body_auth_not_sent',
        capture.calls.length >= 1
        && capture.calls.every((c) => c.method === 'GET'
          && (!c.headers || Object.keys(c.headers).length === 0 || (
            !c.headers.Authorization && !c.headers.authorization
            && !c.headers.Cookie && !c.headers.cookie
          ))
          && c.hasAuth === false
          && c.bodyChunks.length === 0)
        && report.headers_sent === false
        && report.auth_sent === false
        && report.body_sent === false);
    } finally {
      await closeServer(fake.server);
    }

    // Duration stop + deadline cleanup
    {
      const slow = await startFakeServer((req, res) => {
        setTimeout(() => {
          res.writeHead(200);
          res.end('ok');
        }, 200);
      });
      try {
        const report = await runOffline(
          locks.SUNSET_READYZ_URL,
          {
            concurrency: 2,
            max_duration_ms: 1000,
            max_requests: 100,
            request_timeout_ms: 1000,
          },
          slow.origin,
          { mode: 'ok', delayMs: 150 },
        );
        green('max_duration_stop',
          report.stop_reason === 'max_duration'
          && report.completed >= 1
          && report.completed < 100
          && report.wall_ms >= 800);

        red('deadline_cleanup_destroys_actives',
          report.active_requests_remaining === 0
          && report.stop_reason === 'max_duration');
      } finally {
        await closeServer(slow.server);
      }
    }

    // Redirect not followed
    {
      const report = await runOffline(
        locks.WH_READYZ_URL,
        {
          concurrency: 1,
          max_duration_ms: 3000,
          max_requests: 3,
          request_timeout_ms: 1000,
        },
        'http://127.0.0.1:9',
        { mode: 'force_redirect' },
      );
      red('redirect_not_followed',
        report.redirects_followed === false
        && report.status_counts['3xx'] === 3
        && report.status_counts['2xx'] === 0
        && reportHasNoBodies(report));
    }

    // Hanging request → per-request deadline settles timeout
    {
      const report = await runOffline(
        locks.WH_READYZ_URL,
        {
          concurrency: 1,
          max_duration_ms: 3000,
          max_requests: 2,
          request_timeout_ms: 500,
        },
        'http://127.0.0.1:9',
        { mode: 'hang' },
      );
      red('hanging_request_deadline_settles',
        report.status_counts.timeout === 2
        && report.completed === 2
        && report.active_requests_remaining === 0
        && reportHasNoBodies(report));
      green('timeout_class_accounted',
        report.status_counts.timeout === 2
        && report.completed === 2);
    }

    // Trickle body settles (or times out) — must not hang the run
    {
      const trickleServer = await startFakeServer((req, res) => {
        res.writeHead(200);
        res.write('a');
        // Leave hanging without end — client-side trickle wrapper ends itself;
        // also support server that never ends: harness deadline must win.
        setTimeout(() => {
          try { res.end('z'); } catch (_) { /* ignore */ }
        }, 80);
      });
      try {
        const t0 = Date.now();
        const report = await runOffline(
          locks.SUNSET_READYZ_URL,
          {
            concurrency: 1,
            max_duration_ms: 3000,
            max_requests: 2,
            request_timeout_ms: 1000,
          },
          trickleServer.origin,
          { mode: 'trickle', trickleIntervalMs: 30 },
        );
        const elapsed = Date.now() - t0;
        red('trickle_body_settles_or_times_out',
          report.completed === 2
          && report.active_requests_remaining === 0
          && elapsed < 5000
          && (report.status_counts['2xx'] + report.status_counts.timeout + report.status_counts.error) === 2
          && reportHasNoBodies(report));
      } finally {
        await closeServer(trickleServer.server);
      }
    }

    // Abort / error / premature-close settle paths
    {
      const modes = ['aborted', 'response_error', 'premature_close', 'req_error'];
      let idx = 0;
      const report = await runOffline(
        locks.WH_READYZ_URL,
        {
          concurrency: 1,
          max_duration_ms: 5000,
          max_requests: 4,
          request_timeout_ms: 1000,
        },
        'http://127.0.0.1:9',
        { mode: () => modes[idx++] },
      );
      red('abort_error_close_paths_settle',
        report.completed === 4
        && report.status_counts.error === 4
        && report.active_requests_remaining === 0
        && reportHasNoBodies(report));
      green('error_class_accounted',
        report.status_counts.error === 4
        && reportHasNoBodies(report));
    }

    // Non-2xx status classes
    {
      const statuses = [200, 301, 404, 503];
      let idx = 0;
      const statusServer = await startFakeServer((req, res) => {
        const code = statuses[idx % statuses.length];
        idx += 1;
        res.writeHead(code, code >= 300 && code < 400 ? { Location: 'https://evil.example/readyz' } : {});
        res.end('x');
      });
      try {
        const report = await runOffline(
          locks.WH_READYZ_URL,
          {
            concurrency: 1,
            max_duration_ms: 5000,
            max_requests: 4,
            request_timeout_ms: 1000,
          },
          statusServer.origin,
          { mode: 'ok' },
        );
        green('non_2xx_status_classes_accounted',
          report.status_counts['2xx'] === 1
          && report.status_counts['3xx'] === 1
          && report.status_counts['4xx'] === 1
          && report.status_counts['5xx'] === 1
          && reportHasNoBodies(report));
      } finally {
        await closeServer(statusServer.server);
      }
    }

    // Transport-supplied latency must be ignored (adversarial offline settle cannot inject)
    {
      // Hanging path settles timeout; latency must be harness-monotonic (~>= request timeout),
      // not a forged 1ms value. Covered by hanging RED + percentiles on ok path.
      ok('C_LATENCY harness ignores transport latency values (source)',
        /ignore any[\s\S]*latency_ms|Intentionally drop any latency_ms|void ignored/.test(harnessSrc)
        && /hrtime\.bigint/.test(harnessSrc));
    }

    // Private DNS via offline sealed dnsLookup injection
    {
      const t = await expectThrowAsync(
        () => harness.runBoundedLoadOffline(
          {
            target: locks.WH_READYZ_URL,
            profile: {
              concurrency: 1,
              max_duration_ms: 1000,
              max_requests: 1,
              request_timeout_ms: 500,
            },
          },
          {
            seal: harness.OFFLINE_SEAL,
            httpsRequest: makeOfflineHttpsRequest('http://127.0.0.1:9', { mode: 'hang' }),
            dnsLookup: privateDnsLookup,
          },
        ),
        'RADAR_LOAD_DNS',
      );
      const t2 = await expectThrowAsync(
        () => harness.runBoundedLoadOffline(
          {
            target: locks.WH_READYZ_URL,
            profile: {
              concurrency: 1,
              max_duration_ms: 1000,
              max_requests: 1,
              request_timeout_ms: 500,
            },
          },
          {
            seal: harness.OFFLINE_SEAL,
            httpsRequest: makeOfflineHttpsRequest('http://127.0.0.1:9', { mode: 'hang' }),
            dnsLookup: loopbackDnsLookup,
          },
        ),
        'RADAR_LOAD_DNS',
      );
      ok('C_DNS private/loopback offline lookup rejected', t.ok && t2.ok, `${t.detail}|${t2.detail}`);
    }

    // Hanging DNS: missing callback must settle against remaining run budget;
    // no httpsRequest may start afterward.
    {
      const capture = { calls: [] };
      const t0 = Date.now();
      const t = await expectThrowAsync(
        () => harness.runBoundedLoadOffline(
          {
            target: locks.WH_READYZ_URL,
            profile: {
              concurrency: 1,
              max_duration_ms: 1000,
              max_requests: 10,
              request_timeout_ms: 500,
            },
          },
          {
            seal: harness.OFFLINE_SEAL,
            httpsRequest: makeOfflineHttpsRequest('http://127.0.0.1:9', { mode: 'hang' }, capture),
            dnsLookup: hangingDnsLookup,
          },
        ),
        'RADAR_LOAD_DNS_DEADLINE',
      );
      const elapsed = Date.now() - t0;
      red('hanging_dns_deadline_settles',
        t.ok
        && capture.calls.length === 0
        && elapsed >= 900
        && elapsed < 4000,
        `${t.detail}|calls=${capture.calls.length}|elapsed=${elapsed}`);
    }

    // Late DNS callback after deadline: ignore callback; no request starts.
    {
      const capture = { calls: [] };
      const lateLookup = makeLateDnsLookup(2000, '8.8.8.8');
      const t = await expectThrowAsync(
        () => harness.runBoundedLoadOffline(
          {
            target: locks.SUNSET_READYZ_URL,
            profile: {
              concurrency: 1,
              max_duration_ms: 1000,
              max_requests: 10,
              request_timeout_ms: 500,
            },
          },
          {
            seal: harness.OFFLINE_SEAL,
            httpsRequest: makeOfflineHttpsRequest('http://127.0.0.1:9', { mode: 'ok' }, capture),
            dnsLookup: lateLookup,
          },
        ),
        'RADAR_LOAD_DNS_DEADLINE',
      );
      // Allow late callback to fire after rejection; still no request.
      await new Promise((r) => setTimeout(r, 1500));
      red('late_dns_callback_no_request',
        t.ok && capture.calls.length === 0,
        `${t.detail}|calls=${capture.calls.length}`);
    }

    green('future_drill_defined_not_executed',
      harness.FUTURE_DRILL_PROFILE.status === 'defined_not_executed'
      && sliceContract.future_drill_profile.status === 'defined_not_executed'
      && sliceContract.final_controlled_drill.status === 'defined_not_executed'
      && harness.FUTURE_DRILL_PROFILE.concurrency === 2
      && harness.FUTURE_DRILL_PROFILE.max_requests === 60
      && harness.FUTURE_DRILL_PROFILE.max_duration_ms === 30_000
      && harness.FUTURE_DRILL_PROFILE.request_timeout_ms === 4_000
      && !/^executed$/i.test(String(sliceContract.final_controlled_drill.status))
      && !/live_proven/i.test(String(sliceContract.final_controlled_drill.status)));

    const g06 = matrix.gates.find((g) => g.id === 'G06_scaling_capacity');
    green('g06_remains_partial',
      g06
      && g06.verdict === 'partial'
      && /16AG|16AH/.test(g06.rationale)
      && Array.isArray(g06.gaps)
      && g06.gaps.some((x) => /load|soak/i.test(String(x)))
      && g06.gaps.some((x) => /autoscal/i.test(String(x)))
      && g06.gaps.some((x) => /SLO|backpressure/i.test(String(x))));

    green('score_not_inflated',
      topContract.expected_verdict_counts
      && topContract.expected_verdict_counts.proven === 0
      && topContract.expected_verdict_counts.partial === 9
      && topContract.expected_verdict_counts.absent === 0
      && sliceContract.verdict_policy.proven === 0
      && sliceContract.verdict_policy.partial === 9);

    green('no_live_network_in_verifier',
      sealedNetworkHits >= 4
      && /installNetworkFailClosed|RADAR_OFFLINE_NETWORK_SEAL/.test(verifySrc)
      && /runBoundedLoadOffline/.test(verifySrc)
      && /OFFLINE_SEAL/.test(verifySrc)
      && /FUTURE_DRILL_PROFILE/.test(harnessSrc)
      && /defined_not_executed/.test(harnessSrc)
      && /fail_closed/.test(harnessSrc)
      && /transport_escape_rejected/.test(verifySrc)
      // Production runBoundedLoad appears only in the transport-escape RED (must throw).
      && (verifySrc.match(/\brunBoundedLoad\s*\(/g) || []).length === 1);

    {
      const pkg = readJson('package.json');
      green('package_script_registered',
        pkg.scripts
        && pkg.scripts['verify:radar-slice16ag-g06-bounded-load-harness']
          === 'node scripts/verify-radar-slice16ag-g06-bounded-load-harness.js');
    }
  } finally {
    restoreNetwork();
  }

  ok('C5 selected_16ag in top contract',
    topContract.selected_16ag
    && topContract.selected_16ag.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ag.g06_load_harness_source === 'source_closed_via_16AG'
    && topContract.selected_16ag.g06_load_proof === 'open'
    && topContract.selected_16ag.g06_verdict === 'partial');

  ok('C6 matrix slice_16ag_selection',
    matrix.slice_16ag_selection
    && matrix.slice_16ag_selection.selected === true
    && matrix.slice_16ag_selection.outcome_id === locks.OUTCOME_ID
    && matrix.slice_16ag_selection.final_controlled_drill.status === 'defined_not_executed');

  ok('C7 doc + findings mention 16AG without G06 proven / load soak proven',
    /16AG|bounded.?load.?harness/i.test(doc)
    && /16AG|bounded.?load.?harness|16AH|attempted_not_proof/i.test(findings)
    && /defined.?not.?executed|not executed|attempted_not_proof/i.test(doc)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bload\s+soak\s+proven\b/i.test(doc)
    && !/\bG06\s+proven\b/i.test(findings));

  ok('C8 runtime paths unchanged vs master', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  ok('C9 progress_class source_partial',
    locks.PROGRESS_CLASS === 'source_partial_progress_only'
    && sliceContract.progress_class === 'source_partial_progress_only'
    && matrix.slice_16ag_selection.progress_class === 'source_partial_progress_only'
    && (!tip16ah || (matrix.slice_16ah_selection
      && matrix.slice_16ah_selection.progress_class === 'source_partial_progress_only')));

  const redIds = new Set(redResults.map((r) => r.id));
  const greenIds = new Set(greenResults.map((r) => r.id));
  ok('C10 all REQUIRED_RED present',
    locks.REQUIRED_RED.every((id) => redIds.has(id)),
    locks.REQUIRED_RED.filter((id) => !redIds.has(id)).join(','));
  ok('C11 all REQUIRED_GREEN present',
    locks.REQUIRED_GREEN.every((id) => greenIds.has(id)),
    locks.REQUIRED_GREEN.filter((id) => !greenIds.has(id)).join(','));
  ok('C12 all RED/GREEN assertions passed',
    redResults.every((r) => r.ok) && greenResults.every((r) => r.ok));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('RADAR 16AG G06 bounded load harness: FAIL');
    process.exit(1);
  }
  console.log('RADAR 16AG G06 bounded load harness (source-partial): PASS');
}

runVerifier().catch((err) => {
  console.error(err);
  process.exit(1);
});
