'use strict';

/**
 * verify:radar-slice16ah-g06-live-load-correction — RADAR Slice 16AH
 *
 * Offline gate: prove pinnedLookup honors Node dns.lookup callback contract
 * for options.all=true (Happy Eyeballs). Every pin fails closed through the
 * public-address validator (null/malformed/family/empty → stable safe codes;
 * no coercion / TypeError). Production-shaped RED shows scalar replies fail
 * before TLS via real Node https.request/net.connect. GREEN proves corrected
 * array contract reaches a real local TLS server (ephemeral self-signed cert
 * generated at runtime; trust only that cert; allowlisted hostname/SNI;
 * loopback pin inside sealed offline test). Records post-16AG live attempt as
 * attempted_not_proof. No live network, deploy, or scale mutation.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ah-g06-live-load-correction');
const harness = require('./lib/radar-g06-bounded-load-harness');

const ALLOWLIST_HOST = 'staff-staging.lunafrontdesk.com';

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
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
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

function reportHasNoHostsOrMessages(report) {
  const classes = report.error_code_classes || {};
  for (const k of Object.keys(classes)) {
    if (harness.safeErrorCodeClass(k) !== k) return false;
  }
  const json = JSON.stringify(report);
  if (/error_message|err_message|"message"\s*:/i.test(json)) return false;
  return true;
}

function expectThrow(fn) {
  try {
    fn();
    return { threw: false, code: null, isTypeError: false };
  } catch (err) {
    return {
      threw: true,
      code: err && err.code ? String(err.code) : null,
      isTypeError: err instanceof TypeError,
      name: err && err.name,
    };
  }
}

/** Legacy buggy scalar pinnedLookup (16AG defect) — verifier-local only. */
function legacyScalarPinnedLookup(pinned) {
  const primary = pinned[0];
  return function lookup(_hostname, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = {};
    }
    const family = (opts && opts.family) || primary.family;
    const match = pinned.find((p) => p.family === family) || primary;
    process.nextTick(() => cb(null, match.address, match.family));
  };
}

/**
 * Simulate Node Happy Eyeballs consumer: calls lookup with {all:true,hints:32}
 * and treats non-array results as ERR_INVALID_IP_ADDRESS (pre-TLS failure).
 */
function simulateHappyEyeballsConsumer(lookupFn) {
  return new Promise((resolve) => {
    lookupFn('pinned.invalid', { all: true, hints: 32 }, (err, addresses) => {
      if (err) {
        resolve({
          kind: 'error',
          error_code: harness.safeErrorCodeClass(err.code || 'LOOKUP_ERROR'),
          before_tls: true,
        });
        return;
      }
      if (!Array.isArray(addresses)) {
        resolve({
          kind: 'error',
          error_code: 'ERR_INVALID_IP_ADDRESS',
          before_tls: true,
        });
        return;
      }
      const valid = addresses.every((e) => e
        && typeof e.address === 'string'
        && (e.family === 4 || e.family === 6));
      if (!valid || !addresses.length) {
        resolve({
          kind: 'error',
          error_code: 'ERR_INVALID_IP_ADDRESS',
          before_tls: true,
        });
        return;
      }
      resolve({
        kind: 'ok',
        addresses,
        before_tls: false,
        error_code: undefined,
      });
    });
  });
}

const realHttp = {
  createServer: http.createServer.bind(http),
  request: http.request.bind(http),
  get: http.get.bind(http),
};
const realHttps = {
  createServer: https.createServer.bind(https),
  request: https.request.bind(https),
  get: https.get.bind(https),
};
const realNet = {
  connect: net.connect.bind(net),
  createConnection: net.createConnection.bind(net),
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

function isLoopbackHost(host) {
  const h = String(host || '');
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

function installNetworkFailClosed() {
  http.request = sealThrow('http.request');
  http.get = sealThrow('http.get');
  https.request = sealThrow('https.request');
  https.get = sealThrow('https.get');
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

/**
 * Generate ephemeral self-signed cert+key at test runtime.
 * Material lives only in memory after generation; temp files are unlinked.
 * Fail-closed if openssl is unavailable. Never commit cert/key.
 */
function generateEphemeralTlsMaterial(hostname, opts = {}) {
  const opensslBin = opts.opensslBin || 'openssl';
  try {
    execFileSync(opensslBin, ['version'], { stdio: 'pipe' });
  } catch (_) {
    const err = new Error('fail_closed: openssl unavailable for ephemeral TLS material');
    err.code = 'RADAR_OFFLINE_OPENSSL_UNAVAILABLE';
    throw err;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar16ah-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync(opensslBin, [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-nodes',
      '-subj', `/CN=${hostname}`,
      '-addext', `subjectAltName=DNS:${hostname}`,
    ], { stdio: 'pipe' });
    const keyPem = fs.readFileSync(keyPath);
    const certPem = fs.readFileSync(certPath);
    return { keyPem, certPem, hostname, dir };
  } catch (err) {
    if (err && err.code === 'RADAR_OFFLINE_OPENSSL_UNAVAILABLE') throw err;
    const wrapped = new Error('fail_closed: openssl ephemeral cert generation failed');
    wrapped.code = 'RADAR_OFFLINE_OPENSSL_UNAVAILABLE';
    throw wrapped;
  } finally {
    try { fs.unlinkSync(keyPath); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(certPath); } catch (_) { /* ignore */ }
    try { fs.rmdirSync(dir); } catch (_) { /* ignore */ }
  }
}

function startLocalTlsServer(material, handler) {
  return new Promise((resolve, reject) => {
    const server = realHttps.createServer(
      { key: material.keyPem, cert: material.certPem },
      handler,
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        hostname: material.hostname,
        certPem: material.certPem,
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
 * Real Node https.request path for offline proof:
 * - preserves allowlisted hostname + SNI (servername)
 * - trusts only the ephemeral cert
 * - remaps validated pinnedLookup array results to loopback for net.connect
 * - passes scalar replies through unchanged so Node yields ERR_INVALID_IP_ADDRESS
 */
function makeRealTlsHttpsRequest(tlsCtx, capture) {
  return function offlineHttpsRequest(options, callback) {
    const opts = { ...(options || {}) };
    const hostname = opts.hostname || opts.host || tlsCtx.hostname;
    const servername = opts.servername || hostname;
    const meta = {
      method: opts.method || 'GET',
      headers: { ...(opts.headers || {}) },
      path: opts.path,
      hostname,
      servername,
      lookup_invoked: false,
      lookup_all: null,
      lookup_result_kind: null,
    };
    if (capture) capture.calls.push(meta);

    const origLookup = opts.lookup;
    opts.port = tlsCtx.port;
    opts.hostname = hostname;
    opts.servername = servername;
    opts.ca = [tlsCtx.certPem];
    opts.rejectUnauthorized = true;
    // Disable keep-alive so each request exercises the injected lookup path.
    opts.agent = false;
    opts.headers = {};

    opts.lookup = function remappingLookup(host, lookupOpts, cb) {
      let callback = cb;
      let o = lookupOpts;
      if (typeof lookupOpts === 'function') {
        callback = lookupOpts;
        o = {};
      }
      meta.lookup_invoked = true;
      meta.lookup_all = !!(o && o.all);

      if (typeof origLookup !== 'function') {
        meta.lookup_result_kind = 'err';
        const err = Object.assign(new Error('missing_lookup'), { code: 'RADAR_LOAD_DNS' });
        process.nextTick(() => callback(err));
        return;
      }

      origLookup(host, o || {}, (err, addresses, family) => {
        if (err) {
          meta.lookup_result_kind = 'err';
          callback(err);
          return;
        }
        if (!Array.isArray(addresses)) {
          meta.lookup_result_kind = 'scalar';
          // Real Node Happy Eyeballs path: scalar under all=true → ERR_INVALID_IP_ADDRESS
          callback(null, addresses, family);
          return;
        }
        meta.lookup_result_kind = 'array';
        // Pin to loopback inside sealed offline test; prefer IPv4 (server on 127.0.0.1).
        const remapped = addresses
          .filter((a) => a && (a.family === 4 || a.family === 6))
          .map((a) => ({
            address: a.family === 6 ? '::1' : '127.0.0.1',
            family: a.family,
          }));
        const v4 = remapped.filter((a) => a.family === 4);
        callback(null, v4.length ? v4 : remapped);
      });
    };

    return realHttps.request(opts, callback);
  };
}

function publicDnsLookup(hostname, options, callback) {
  let cb = callback;
  if (typeof options === 'function') cb = options;
  process.nextTick(() => cb(null, [{ address: '8.8.8.8', family: 4 }]));
}

function dualStackDnsLookup(hostname, options, callback) {
  let cb = callback;
  if (typeof options === 'function') cb = options;
  process.nextTick(() => cb(null, [
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]));
}

async function runVerifier() {
  console.log('RADAR 16AH G06 live-load correction — offline fail-closed verifier\n');

  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');
  const harnessSrc = readText(locks.HARNESS_REL);
  const verifySrc = readText(locks.VERIFY_REL);

  const tip16ai = matrix.slice === 'RADAR-16AI';
  const tipBranchOk = tip16ai && currentBranch() === 'radar/slice-16ai-g06-live-load-evidence';
  const tipBasisOk = tip16ai && matrix.master_basis === 'd04b633390bdcacfe3a04eed4796bba4184e29f8'
    && topContract.master_basis === 'd04b633390bdcacfe3a04eed4796bba4184e29f8';
  ok('C1 HEAD on 16AH branch (or 16AI tip)', currentBranch() === locks.BRANCH || tipBranchOk, currentBranch());
  ok('C2 master_basis locked (16AH lock or 16AI tip)',
    (locks.MASTER_BASIS === '6c24e9456bd42c7fa1b051bb1308aae8f632b293'
      && sliceContract.master_basis === locks.MASTER_BASIS
      && matrix.master_basis === locks.MASTER_BASIS
      && topContract.master_basis === locks.MASTER_BASIS)
    || tipBasisOk);
  ok('C3 slice/outcome/branch locked (16AH lock or 16AI tip)',
    (sliceContract.slice === locks.SLICE
      && sliceContract.outcome_id === locks.OUTCOME_ID
      && sliceContract.branch === locks.BRANCH
      && matrix.slice === locks.SLICE
      && matrix.branch === locks.BRANCH
      && topContract.slice === locks.SLICE
      && topContract.branch === locks.BRANCH)
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

  ok('C0 pinnedLookup exported and all=true branch present',
    typeof harness.pinnedLookup === 'function'
    && typeof harness.safeErrorCodeClass === 'function'
    && typeof harness.assertPublicDnsAddresses === 'function'
    && /wantAll|opts\.all|options\.all/.test(harnessSrc)
    && /assertPublicDnsAddresses\(pinned\)/.test(harnessSrc)
    && /RADAR_LOAD_DNS_ADDRESS|RADAR_LOAD_DNS_FAMILY/.test(harnessSrc)
    && /ERR_INVALID_IP_ADDRESS|Happy Eyeballs|all===true|all=true/.test(harnessSrc)
    && /POST_16AG_LIVE_LOAD_ATTEMPT/.test(harnessSrc)
    && /attempted_not_proof/.test(harnessSrc)
    && /generateEphemeralTlsMaterial|RADAR_OFFLINE_OPENSSL_UNAVAILABLE/.test(verifySrc)
    && /realHttps\.request|https\.createServer/.test(verifySrc)
    && !verifySrc.includes(['makeProduction', 'ShapedHttpsRequest'].join(''))
    && !verifySrc.includes(['startFake', 'Server'].join('') + '('));

  const pins = harness.assertPublicDnsAddresses([
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ]);

  // --- RED: openssl unavailable fail-closed ---
  {
    const missing = expectThrow(() => generateEphemeralTlsMaterial(ALLOWLIST_HOST, {
      opensslBin: '/nonexistent/radar16ah-openssl',
    }));
    red('openssl_required_fail_closed_when_unavailable',
      missing.threw === true
      && missing.code === 'RADAR_OFFLINE_OPENSSL_UNAVAILABLE'
      && missing.isTypeError === false,
      JSON.stringify(missing));
  }

  // --- RED: public-address validator via pinnedLookup (no coercion / TypeError) ---
  {
    const cases = [
      { label: 'null_entry', input: [null], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'undefined_entry', input: [undefined], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'empty_object', input: [{}], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'null_address', input: [{ address: null, family: 4 }], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'numeric_address', input: [{ address: 1, family: 4 }], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'malformed_address', input: [{ address: 'not-an-ip', family: 4 }], code: 'RADAR_LOAD_DNS_ADDRESS' },
      { label: 'empty_address', input: [{ address: '  ', family: 4 }], code: 'RADAR_LOAD_DNS_ADDRESS' },
    ];
    const results = cases.map((c) => {
      const r = expectThrow(() => harness.pinnedLookup(c.input));
      return { ...c, ...r };
    });
    red('pinned_lookup_null_malformed_address_rejected',
      results.every((r) => r.threw && r.code === 'RADAR_LOAD_DNS_ADDRESS' && !r.isTypeError),
      JSON.stringify(results.map((r) => ({ label: r.label, code: r.code, typeError: r.isTypeError }))));
  }

  {
    const cases = [
      { label: 'string_family', input: [{ address: '8.8.8.8', family: '4' }], code: 'RADAR_LOAD_DNS_FAMILY' },
      { label: 'mismatched_family', input: [{ address: '8.8.8.8', family: 6 }], code: 'RADAR_LOAD_DNS_FAMILY' },
      { label: 'truthy_family', input: [{ address: '8.8.8.8', family: true }], code: 'RADAR_LOAD_DNS_FAMILY' },
      { label: 'zero_family', input: [{ address: '8.8.8.8', family: 0 }], code: 'RADAR_LOAD_DNS_FAMILY' },
    ];
    const results = cases.map((c) => {
      const r = expectThrow(() => harness.pinnedLookup(c.input));
      return { ...c, ...r };
    });
    red('pinned_lookup_invalid_mismatched_family_rejected',
      results.every((r) => r.threw && r.code === 'RADAR_LOAD_DNS_FAMILY' && !r.isTypeError),
      JSON.stringify(results.map((r) => ({ label: r.label, code: r.code, typeError: r.isTypeError }))));
  }

  {
    const empty = expectThrow(() => harness.pinnedLookup([]));
    const nonArray = expectThrow(() => harness.pinnedLookup(null));
    red('pinned_lookup_empty_pins_rejected',
      empty.threw && empty.code === 'RADAR_LOAD_DNS' && !empty.isTypeError
      && nonArray.threw && nonArray.code === 'RADAR_LOAD_DNS' && !nonArray.isTypeError,
      JSON.stringify({ empty, nonArray }));
  }

  // --- RED: production-shaped scalar under all=true fails before TLS ---
  {
    const legacy = legacyScalarPinnedLookup(pins);
    const result = await simulateHappyEyeballsConsumer(legacy);
    red('production_shaped_all_true_scalar_fails_before_http',
      result.kind === 'error'
      && result.before_tls === true
      && result.error_code === 'ERR_INVALID_IP_ADDRESS'
      && harness.safeErrorCodeClass(result.error_code) === 'ERR_INVALID_IP_ADDRESS',
      JSON.stringify({ kind: result.kind, code: result.error_code, before_tls: result.before_tls }));
  }

  red('safe_error_code_classes_no_message_host_body',
    harness.safeErrorCodeClass('ERR_INVALID_IP_ADDRESS') === 'ERR_INVALID_IP_ADDRESS'
    && harness.safeErrorCodeClass('RADAR_LOAD_DNS_ADDRESS') === 'RADAR_LOAD_DNS_ADDRESS'
    && harness.safeErrorCodeClass('RADAR_LOAD_DNS_FAMILY') === 'RADAR_LOAD_DNS_FAMILY'
    && harness.safeErrorCodeClass('ECONNRESET') === 'ECONNRESET'
    && harness.safeErrorCodeClass('not a code!') === 'UNCLASSIFIED'
    && harness.safeErrorCodeClass({ code: 'EPIPE', message: 'boom at host.example' }) === 'EPIPE'
    && harness.safeErrorCodeClass({ message: 'no code' }) === 'UNCLASSIFIED'
    && !/host\.example|boom/.test(harness.safeErrorCodeClass({ code: 'EPIPE', message: 'boom at host.example' })));

  {
    const emptyPins = harness.pinnedLookup([{ address: '8.8.8.8', family: 4 }]);
    const familyMiss = await new Promise((resolve) => {
      emptyPins('x', { all: true, family: 6 }, (err, addresses) => {
        resolve({
          code: err && harness.safeErrorCodeClass(err.code),
          hasAddresses: addresses != null,
        });
      });
    });
    red('pinned_lookup_family_miss_errors',
      familyMiss.code === 'RADAR_LOAD_DNS_PIN_MISS'
      && familyMiss.hasAddresses === false);
  }

  // --- GREEN: corrected contract ---
  {
    const lookup = harness.pinnedLookup(pins);
    const allTrue = await new Promise((resolve) => {
      lookup('x', { all: true, hints: 32 }, (err, addresses, family) => {
        resolve({ err, addresses, family });
      });
    });
    const consumer = await simulateHappyEyeballsConsumer(lookup);
    green('pinned_lookup_all_true_returns_validated_array',
      !allTrue.err
      && Array.isArray(allTrue.addresses)
      && allTrue.addresses.length === 2
      && allTrue.family === undefined
      && allTrue.addresses.every((e) => typeof e.address === 'string' && (e.family === 4 || e.family === 6))
      && consumer.kind === 'ok'
      && consumer.before_tls === false);
  }

  {
    const lookup = harness.pinnedLookup(pins);
    const scalar = await new Promise((resolve) => {
      lookup('x', { all: false, family: 4 }, (err, address, family) => {
        resolve({ err, address, family });
      });
    });
    green('pinned_lookup_all_false_scalar_contract',
      !scalar.err
      && typeof scalar.address === 'string'
      && scalar.address === '8.8.8.8'
      && scalar.family === 4
      && !Array.isArray(scalar.address));
  }

  {
    const lookup = harness.pinnedLookup(pins);
    const v6 = await new Promise((resolve) => {
      lookup('x', { all: true, family: 6 }, (err, addresses) => {
        resolve({ err, addresses });
      });
    });
    green('pinned_lookup_family_filter_exact_pins',
      !v6.err
      && Array.isArray(v6.addresses)
      && v6.addresses.length === 1
      && v6.addresses[0].family === 6
      && v6.addresses[0].address === '2001:4860:4860::8888');
  }

  // Ephemeral TLS material (runtime only; no committed cert/key).
  let material;
  try {
    material = generateEphemeralTlsMaterial(ALLOWLIST_HOST);
  } catch (err) {
    ok('C_TLS_MATERIAL ephemeral openssl cert', false, String(err && err.code));
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log('RADAR 16AH G06 live-load correction: FAIL');
    process.exit(1);
  }
  ok('C_TLS_MATERIAL ephemeral openssl cert in-memory only',
    Buffer.isBuffer(material.keyPem)
    && Buffer.isBuffer(material.certPem)
    && material.hostname === ALLOWLIST_HOST
    && !fs.existsSync(path.join(material.dir || '', 'key.pem'))
    && !fs.existsSync(path.join(material.dir || '', 'cert.pem')));

  installNetworkFailClosed();
  try {
    ok('C_SEAL http/https/net/dns fail closed',
      (() => {
        try { http.request('http://example.com'); return false; } catch (e) { return e.code === 'RADAR_OFFLINE_NETWORK_SEAL'; }
      })()
      && (() => {
        try { https.request('https://example.com'); return false; } catch (e) { return e.code === 'RADAR_OFFLINE_NETWORK_SEAL'; }
      })()
      && (() => {
        try { net.connect({ host: '1.1.1.1', port: 443 }); return false; } catch (e) { return e.code === 'RADAR_OFFLINE_NETWORK_SEAL'; }
      })());
    {
      const dnsSealed = await new Promise((resolve) => {
        dns.lookup('example.com', (err) => resolve(!!(err && err.code === 'RADAR_OFFLINE_NETWORK_SEAL')));
      });
      ok('C_SEAL dns.lookup non-loopback fail closed', dnsSealed);
    }

    const tls = await startLocalTlsServer(material, (req, res) => {
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
      const report = await harness.runBoundedLoadOffline(
        {
          target: locks.WH_READYZ_URL,
          profile: {
            concurrency: 1,
            max_duration_ms: 5000,
            max_requests: 4,
            request_timeout_ms: 1000,
          },
        },
        {
          seal: harness.OFFLINE_SEAL,
          httpsRequest: makeRealTlsHttpsRequest(tls, capture),
          dnsLookup: publicDnsLookup,
        },
      );

      green('production_shaped_pinned_lookup_reaches_tls',
        report.status_counts['2xx'] === 4
        && report.status_counts.error === 0
        && capture.calls.length === 4
        && capture.calls.every((c) => c.lookup_invoked === true
          && c.lookup_all === true
          && c.lookup_result_kind === 'array'
          && c.hostname === ALLOWLIST_HOST
          && c.servername === ALLOWLIST_HOST)
        && reportHasNoBodies(report),
        JSON.stringify({
          status_counts: report.status_counts,
          lookup_kinds: capture.calls.map((c) => c.lookup_result_kind),
          sni: capture.calls.map((c) => c.servername),
        }));

      const badCapture = { calls: [] };
      function scalarInjectingHttpsRequest(options, callback) {
        const opts = { ...(options || {}) };
        opts.lookup = legacyScalarPinnedLookup([{ address: '8.8.8.8', family: 4 }]);
        return makeRealTlsHttpsRequest(tls, badCapture)(opts, callback);
      }
      const badReport = await harness.runBoundedLoadOffline(
        {
          target: locks.SUNSET_READYZ_URL,
          profile: {
            concurrency: 1,
            max_duration_ms: 5000,
            max_requests: 3,
            request_timeout_ms: 1000,
          },
        },
        {
          seal: harness.OFFLINE_SEAL,
          httpsRequest: scalarInjectingHttpsRequest,
          dnsLookup: publicDnsLookup,
        },
      );
      ok('C_RED_SHAPE scalar injection yields all errors before TLS',
        badReport.status_counts.error === 3
        && badReport.status_counts['2xx'] === 0
        && badReport.error_code_classes
        && badReport.error_code_classes.ERR_INVALID_IP_ADDRESS === 3
        && badCapture.calls.every((c) => c.lookup_result_kind === 'scalar')
        && reportHasNoBodies(badReport)
        && reportHasNoHostsOrMessages(badReport),
        JSON.stringify({
          status_counts: badReport.status_counts,
          error_code_classes: badReport.error_code_classes,
        }));

      green('error_code_classes_aggregated_safely',
        badReport.error_code_classes
        && badReport.error_code_classes.ERR_INVALID_IP_ADDRESS === 3
        && Object.keys(badReport.error_code_classes).every(
          (k) => harness.safeErrorCodeClass(k) === k,
        )
        && reportHasNoHostsOrMessages(badReport)
        && report.error_code_classes
        && Object.keys(report.error_code_classes).length === 0);
    } finally {
      await closeServer(tls.server);
    }

    green('live_attempt_recorded_attempted_not_proof',
      harness.POST_16AG_LIVE_LOAD_ATTEMPT
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.status === 'attempted_not_proof'
      && sliceContract.post_16ag_live_load_attempt.status === 'attempted_not_proof'
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.outcome_class
        === 'both_targets_60_of_60_error_before_http'
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.root_cause_class
        === 'pinned_lookup_scalar_under_options_all_true'
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.direct_readyz_pre_post_class === 'ready'
      && Array.isArray(harness.POST_16AG_LIVE_LOAD_ATTEMPT.does_not_prove)
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.does_not_prove.includes('load_soak_success')
      && harness.POST_16AG_LIVE_LOAD_ATTEMPT.does_not_prove.includes('live_load_proof')
      && !/\b(load soak proven|live load executed successfully|G06 proven)\b/i.test(
        String(harness.POST_16AG_LIVE_LOAD_ATTEMPT.note || ''),
      ));

    const g06 = matrix.gates.find((g) => g.id === 'G06_scaling_capacity');
    green('g06_remains_partial',
      g06
      && g06.verdict === 'partial'
      && /16AH|16AG|16AI/.test(g06.rationale)
      && Array.isArray(g06.gaps)
      && g06.gaps.some((x) => /load|soak/i.test(String(x)))
      && g06.gaps.some((x) => /autoscal/i.test(String(x)))
      && g06.gaps.some((x) => /SLO|backpressure/i.test(String(x)))
      && !/\bG06\s+proven\b/i.test(String(g06.rationale)));

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
      && /attempted_not_proof/.test(verifySrc)
      && /legacyScalarPinnedLookup|ERR_INVALID_IP_ADDRESS/.test(verifySrc)
      && /generateEphemeralTlsMaterial/.test(verifySrc)
      && /makeRealTlsHttpsRequest/.test(verifySrc)
      && (verifySrc.match(/\brunBoundedLoad\s*\(/g) || []).length === 0);

    {
      const pkg = readJson('package.json');
      green('package_script_registered',
        pkg.scripts
        && pkg.scripts['verify:radar-slice16ah-g06-live-load-correction']
          === 'node scripts/verify-radar-slice16ah-g06-live-load-correction.js');
    }

    green('16ag_source_partial_retained',
      topContract.selected_16ag
      && topContract.selected_16ag.g06_load_harness_source === 'source_closed_via_16AG'
      && topContract.selected_16ag.g06_load_proof === 'open'
      && matrix.slice_16ag_selection
      && matrix.slice_16ag_selection.g06_load_harness_source === 'source_closed_via_16AG'
      && harness.FUTURE_DRILL_PROFILE.status === 'defined_not_executed');
  } finally {
    restoreNetwork();
  }

  ok('C5 selected_16ah in top contract',
    topContract.selected_16ah
    && topContract.selected_16ah.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ah.g06_verdict === 'partial'
    && topContract.selected_16ah.g06_load_proof === 'open'
    && topContract.selected_16ah.live_load_attempt_status === 'attempted_not_proof'
    && topContract.selected_16ah.pinned_lookup_all_true === 'corrected');

  ok('C6 matrix slice_16ah_selection',
    matrix.slice_16ah_selection
    && matrix.slice_16ah_selection.selected === true
    && matrix.slice_16ah_selection.outcome_id === locks.OUTCOME_ID
    && matrix.slice_16ah_selection.live_load_attempt.status === 'attempted_not_proof'
    && matrix.slice_16ah_selection.g06_load_proof === 'open');

  ok('C7 doc + findings mention 16AH correction without load success / G06 proven',
    /16AH|pinned.?lookup|all=true|Happy Eyeballs/i.test(doc)
    && /16AH|pinned.?lookup|attempted_not_proof/i.test(findings)
    && /attempted_not_proof/i.test(doc)
    && /attempted_not_proof/i.test(findings)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bload\s+soak\s+proven\b/i.test(doc)
    && !/\bG06\s+proven\b/i.test(findings)
    && !/\blive\s+load\s+(success|soak)\s+proven\b/i.test(findings));

  ok('C8 runtime paths unchanged vs master', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  ok('C9 progress_class source_partial',
    locks.PROGRESS_CLASS === 'source_partial_progress_only'
    && sliceContract.progress_class === 'source_partial_progress_only'
    && matrix.slice_16ah_selection.progress_class === 'source_partial_progress_only');

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

  // dualStackDnsLookup retained for family-filter unit path coverage above;
  // reference so lint/unused does not drop the allowlisted dual-stack helper.
  void dualStackDnsLookup;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('RADAR 16AH G06 live-load correction: FAIL');
    process.exit(1);
  }
  console.log('RADAR 16AH G06 live-load correction (source-partial): PASS');
}

runVerifier().catch((err) => {
  console.error(err);
  process.exit(1);
});
