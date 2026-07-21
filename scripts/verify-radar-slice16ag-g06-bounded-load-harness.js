'use strict';

/**
 * verify:radar-slice16ag-g06-bounded-load-harness — RADAR Slice 16AG
 *
 * Offline gate: dependency-free bounded /readyz load harness with local fake
 * server. Proves allowlist fail-closed, bounds, concurrency, no redirects,
 * latency percentiles, and timeout/error/non-2xx accounting without bodies.
 * Does NOT execute live staging network calls, deploy, or scale mutation.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ag-g06-bounded-load-harness');
const harness = require('./lib/radar-g06-bounded-load-harness');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];
let liveNetworkAttempts = 0;

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

function startFakeServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
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
 * Transport that talks to a local fake origin while preserving the allowlisted
 * logical target for harness validation. Never opens staging network sockets.
 */
function fakeTransport(fakeOrigin, behavior) {
  return function transport(logicalTarget, timeoutMs) {
    if (!harness.ALLOWED_TARGETS.includes(logicalTarget)) {
      liveNetworkAttempts += 1;
      return Promise.reject(Object.assign(new Error('escape'), { code: 'ESCAPE' }));
    }
    const started = Date.now();
    return new Promise((resolve) => {
      if (behavior && behavior.forceTimeout) {
        setTimeout(() => {
          resolve({
            kind: 'timeout',
            status_code: null,
            latency_ms: Date.now() - started,
            redirected: false,
          });
        }, Math.min(timeoutMs, behavior.forceTimeoutMs || 30));
        return;
      }
      if (behavior && behavior.forceError) {
        resolve({
          kind: 'error',
          status_code: null,
          latency_ms: Date.now() - started,
          redirected: false,
          error_code: 'FAKE_ERROR',
        });
        return;
      }
      if (behavior && behavior.forceRedirect) {
        resolve({
          kind: 'status',
          status_code: 302,
          latency_ms: Date.now() - started,
          redirected: true,
          location: 'https://evil.example/readyz',
        });
        return;
      }

      const delayMs = behavior && behavior.delayMs ? behavior.delayMs : 0;
      const statusCode = behavior && behavior.statusCode ? behavior.statusCode : 200;
      const body = behavior && behavior.body != null ? behavior.body : '{"status":"ready"}';

      const doReq = () => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: Number(new URL(fakeOrigin).port),
          path: '/readyz',
          method: 'GET',
          headers: {},
          timeout: timeoutMs,
        }, (res) => {
          let collected = '';
          res.on('data', (c) => {
            // Intentionally discard for harness report; local drain only.
            if (behavior && behavior.captureBody) collected += c;
          });
          res.on('end', () => {
            resolve({
              kind: 'status',
              status_code: res.statusCode || statusCode,
              latency_ms: Date.now() - started,
              redirected: false,
              // Must never leak into harness aggregate; kept only if test asks.
              _test_body: behavior && behavior.captureBody ? collected : undefined,
            });
          });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({
            kind: 'timeout',
            status_code: null,
            latency_ms: Date.now() - started,
            redirected: false,
          });
        });
        req.on('error', (err) => {
          resolve({
            kind: 'error',
            status_code: null,
            latency_ms: Date.now() - started,
            redirected: false,
            error_code: err && err.code ? String(err.code) : 'ERROR',
          });
        });
        req.end();
      };

      if (delayMs > 0) setTimeout(doReq, delayMs);
      else doReq();
    });
  };
}

function reportHasNoBodies(report) {
  const json = JSON.stringify(report);
  if (/"body"\s*:/.test(json) && !/"body_sent":false/.test(json)) return false;
  if (/response_body/i.test(json) && !/"response_bodies_collected":false/.test(json)) return false;
  if (/"_test_body"/.test(json)) return false;
  if (/"status":"ready"/.test(json)) return false;
  return report.response_bodies_collected === false;
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

async function runVerifier() {
  console.log('RADAR 16AG G06 bounded load harness — offline fake-server verifier\n');

  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');
  const harnessSrc = readText(locks.HARNESS_REL);

  ok('C1 HEAD on 16AG branch', currentBranch() === locks.BRANCH, currentBranch());
  ok('C2 master_basis locked',
    locks.MASTER_BASIS === '7a283b70d38a4906e6279d82a49c0f6dd2a4994e'
    && sliceContract.master_basis === locks.MASTER_BASIS
    && matrix.master_basis === locks.MASTER_BASIS
    && topContract.master_basis === locks.MASTER_BASIS);
  ok('C3 slice/outcome/branch locked',
    sliceContract.slice === locks.SLICE
    && sliceContract.outcome_id === locks.OUTCOME_ID
    && sliceContract.branch === locks.BRANCH
    && matrix.slice === locks.SLICE
    && matrix.branch === locks.BRANCH
    && topContract.slice === locks.SLICE
    && topContract.branch === locks.BRANCH);

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

  // --- Fake-server GREEN battery ---
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
    const report = await harness.runBoundedLoad({
      target: locks.WH_READYZ_URL,
      profile: {
        concurrency: 2,
        max_duration_ms: 5000,
        max_requests: 8,
        request_timeout_ms: 1000,
      },
      transport: fakeTransport(fake.origin, { statusCode: 200 }),
    });

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
  } finally {
    await closeServer(fake.server);
  }

  // Duration stop
  {
    const slow = await startFakeServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('ok');
      }, 200);
    });
    try {
      const report = await harness.runBoundedLoad({
        target: locks.SUNSET_READYZ_URL,
        profile: {
          concurrency: 2,
          max_duration_ms: 1000,
          max_requests: 100,
          request_timeout_ms: 1000,
        },
        transport: fakeTransport(slow.origin, { delayMs: 150, statusCode: 200 }),
      });
      green('max_duration_stop',
        report.stop_reason === 'max_duration'
        && report.completed >= 1
        && report.completed < 100
        && report.wall_ms >= 800);
    } finally {
      await closeServer(slow.server);
    }
  }

  // Redirect not followed
  {
    const report = await harness.runBoundedLoad({
      target: locks.WH_READYZ_URL,
      profile: {
        concurrency: 1,
        max_duration_ms: 3000,
        max_requests: 3,
        request_timeout_ms: 1000,
      },
      transport: fakeTransport('http://127.0.0.1:9', { forceRedirect: true }),
    });
    red('redirect_not_followed',
      report.redirects_followed === false
      && report.status_counts['3xx'] === 3
      && report.status_counts['2xx'] === 0
      && reportHasNoBodies(report));
  }

  // Timeout class
  {
    const report = await harness.runBoundedLoad({
      target: locks.WH_READYZ_URL,
      profile: {
        concurrency: 1,
        max_duration_ms: 3000,
        max_requests: 4,
        request_timeout_ms: 500,
      },
      transport: fakeTransport('http://127.0.0.1:9', { forceTimeout: true, forceTimeoutMs: 20 }),
    });
    green('timeout_class_accounted',
      report.status_counts.timeout === 4
      && report.completed === 4
      && reportHasNoBodies(report));
  }

  // Error class
  {
    const report = await harness.runBoundedLoad({
      target: locks.SUNSET_READYZ_URL,
      profile: {
        concurrency: 1,
        max_duration_ms: 3000,
        max_requests: 3,
        request_timeout_ms: 500,
      },
      transport: fakeTransport('http://127.0.0.1:9', { forceError: true }),
    });
    green('error_class_accounted',
      report.status_counts.error === 3
      && reportHasNoBodies(report));
  }

  // Non-2xx status classes
  {
    const statuses = [200, 301, 404, 503];
    let idx = 0;
    const report = await harness.runBoundedLoad({
      target: locks.WH_READYZ_URL,
      profile: {
        concurrency: 1,
        max_duration_ms: 5000,
        max_requests: 4,
        request_timeout_ms: 1000,
      },
      transport: async (target, timeoutMs) => {
        const code = statuses[idx % statuses.length];
        idx += 1;
        return {
          kind: 'status',
          status_code: code,
          latency_ms: 5,
          redirected: code >= 300 && code < 400,
        };
      },
    });
    green('non_2xx_status_classes_accounted',
      report.status_counts['2xx'] === 1
      && report.status_counts['3xx'] === 1
      && report.status_counts['4xx'] === 1
      && report.status_counts['5xx'] === 1
      && reportHasNoBodies(report));
  }

  green('future_drill_defined_not_executed',
    harness.FUTURE_DRILL_PROFILE.status === 'defined_not_executed'
    && sliceContract.future_drill_profile.status === 'defined_not_executed'
    && sliceContract.final_controlled_drill.status === 'defined_not_executed'
    && harness.FUTURE_DRILL_PROFILE.concurrency === 2
    && harness.FUTURE_DRILL_PROFILE.max_requests === 60
    && harness.FUTURE_DRILL_PROFILE.max_duration_ms === 30_000
    && harness.FUTURE_DRILL_PROFILE.request_timeout_ms === 4_000
    && sliceContract.final_controlled_drill.status === 'defined_not_executed'
    && !/^executed$/i.test(String(sliceContract.final_controlled_drill.status))
    && !/live_proven/i.test(String(sliceContract.final_controlled_drill.status)));

  const g06 = matrix.gates.find((g) => g.id === 'G06_scaling_capacity');
  green('g06_remains_partial',
    g06
    && g06.verdict === 'partial'
    && /16AG/.test(g06.rationale)
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
    liveNetworkAttempts === 0
    && /FUTURE_DRILL_PROFILE/.test(harnessSrc)
    && /defined_not_executed/.test(harnessSrc)
    && /fail_closed/.test(harnessSrc)
    && /transport:/.test(readText(locks.VERIFY_REL))
    && !/\b_defaultHttpsTransport\b/.test(readText(locks.VERIFY_REL).replace(
      /green\('no_live_network_in_verifier'[\s\S]*?\);/,
      '',
    )));

  {
    const pkg = readJson('package.json');
    green('package_script_registered',
      pkg.scripts
      && pkg.scripts['verify:radar-slice16ag-g06-bounded-load-harness']
        === 'node scripts/verify-radar-slice16ag-g06-bounded-load-harness.js');
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
    && /16AG|bounded.?load.?harness/i.test(findings)
    && /defined.?not.?executed|not executed/i.test(doc)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bload\s+soak\s+proven\b/i.test(doc)
    && !/\bG06\s+proven\b/i.test(findings));

  ok('C8 runtime paths unchanged vs master', runtimePathsUnchanged().ok, runtimePathsUnchanged().detail);

  ok('C9 progress_class source_partial',
    locks.PROGRESS_CLASS === 'source_partial_progress_only'
    && sliceContract.progress_class === 'source_partial_progress_only'
    && matrix.slice_16ag_selection.progress_class === 'source_partial_progress_only');

  // Required RED/GREEN coverage
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
