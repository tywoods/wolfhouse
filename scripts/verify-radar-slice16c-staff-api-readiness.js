'use strict';

/**
 * verify:radar-slice16c-staff-api-readiness — RADAR Slice 16C
 *
 * Offline RED/GREEN gate for Staff API /readyz + ACA probes (Wolfhouse + Sunset).
 * No live deploy, no Azure mutation, no real secrets, no guest/payment calls.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16c-staff-api-readiness');
const readiness = require('./lib/staff-api-readiness');

const MASTER = locks.MASTER_BASIS;
const CONTRACT_REL = 'fixtures/radar-operations/slice16c-expected-contract.json';
const PROBE_FIXTURE_REL = 'fixtures/radar-operations/slice16c-probe-contract.json';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
  // Built dynamically so this file does not self-match the DSN pattern.
  new RegExp(String.raw`postgres(?:ql)?:` + String.raw`\/\/[^\s"']+`, 'i'),
];

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
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: !!cond });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: !!cond });
  return passed;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function bodyHasSensitiveLeak(bodyText, extras = []) {
  const needles = [
    'password',
    'Connection refused',
    'ECONNREFUSED',
    'stack',
    'SELECT 1',
    'postgres' + '://',
    'postgresql' + '://',
    'WOLFHOUSE_DATABASE_URL',
    'at Object.',
    'Error:',
    ...extras,
  ];
  const lower = String(bodyText || '').toLowerCase();
  for (const n of needles) {
    if (lower.includes(String(n).toLowerCase())) return true;
  }
  return false;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function mockWithPgClient(behavior) {
  return async function withPgClient(fn) {
    if (behavior === 'missing') {
      return undefined;
    }
    if (behavior === 'error') {
      const err = new Error([
        'ECONNREFUSED',
        ' ',
        'pass',
        'word',
        '=',
        'supersecret',
        ' ',
        'postgres',
        ':',
        '/',
        '/',
        'wolf:hunter2@db:5432/wolfhouse',
      ].join(''));
      err.stack = 'Error: boom\n    at Object.query (fake.js:1:1)';
      throw err;
    }
    if (behavior === 'timeout') {
      await new Promise((r) => setTimeout(r, readiness.READINESS_TIMEOUT_MS + 800));
      return fn({ query: async () => ({ rows: [{ '?column?': 1 }] }) });
    }
    if (behavior === 'ok') {
      return fn({
        query: async (sql) => {
          if (sql !== readiness.READINESS_SQL) {
            throw new Error(`unexpected sql ${sql}`);
          }
          return { rows: [{ '?column?': 1 }] };
        },
      });
    }
    throw new Error(`unknown behavior ${behavior}`);
  };
}

function bicepBuild(rel) {
  const outDir = path.join(ROOT, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `radar-16c-${path.basename(path.dirname(rel))}.json`);
  execFileSync(
    'az',
    ['bicep', 'build', '--file', path.join(ROOT, rel), '--outfile', out],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `/opt/data/.local/bin:${process.env.PATH || ''}`,
        DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return out;
}

function mutateProbesAbsent(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  return text.replace(block, '/* probes removed by RED */');
}

function mutateProbePort(text, badPort) {
  return text.replace(/port:\s*3036/g, `port: ${badPort}`);
}

function mutateProbeTiming(text) {
  return text
    .replace(/initialDelaySeconds:\s*30/, 'initialDelaySeconds: 1')
    .replace(/periodSeconds:\s*20/, 'periodSeconds: 1');
}

function mutateReadinessPathToHealthz(text) {
  // Swap readiness path only inside probes block.
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  const swapped = block.replace(
    /type:\s*'Readiness'([\s\S]*?)path:\s*'\/readyz'/,
    "type: 'Readiness'$1path: '/healthz'",
  );
  return text.replace(block, swapped);
}

function mutateLivenessToReadyz(text) {
  const block = locks.extractProbesBlock(text);
  if (!block) return text;
  const swapped = block.replace(
    /type:\s*'Liveness'([\s\S]*?)path:\s*'\/healthz'/,
    "type: 'Liveness'$1path: '/readyz'",
  );
  return text.replace(block, swapped);
}

console.log('verify:radar-slice16c-staff-api-readiness — RADAR Slice 16C\n');

const contract = readJson(CONTRACT_REL);
const probeFixture = readJson(PROBE_FIXTURE_REL);
const apiSrc = readText(locks.STAFF_API_REL);
const readinessSrc = readText(locks.READINESS_LIB_REL);
const whBicep = readText(locks.WOLFHOUSE_BICEP_REL);
const sunsetBicep = readText(locks.SUNSET_BICEP_REL);

ok('C1 contract pinned',
  contract.master_basis === MASTER
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.gate_id === locks.GATE_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.live_deploy === false
  && contract.live_mutation === false);

ok('C2 probe fixture matches locks',
  probeFixture.port === locks.PROBE_CONTRACT.port
  && probeFixture.startup.path === locks.PROBE_CONTRACT.startup.path
  && probeFixture.liveness.path === locks.PROBE_CONTRACT.liveness.path
  && probeFixture.readiness.path === locks.PROBE_CONTRACT.readiness.path
  && probeFixture.liveness.initialDelaySeconds === locks.PROBE_CONTRACT.liveness.initialDelaySeconds
  && probeFixture.readiness.periodSeconds === locks.PROBE_CONTRACT.readiness.periodSeconds);

ok('C3 readiness SQL locked to SELECT 1',
  readiness.READINESS_SQL === 'SELECT 1'
  && /const READINESS_SQL = 'SELECT 1'/.test(readinessSrc));

ok('C4 staff-query-api wires /readyz before /healthz',
  /pathname === READYZ_PATH/.test(apiSrc)
  && /handleStaffApiReadyz\(res, sendJSON, withPgClient\)/.test(apiSrc)
  && apiSrc.indexOf("pathname === READYZ_PATH") < apiSrc.indexOf("pathname === '/healthz'")
  && /require\('\.\/lib\/staff-api-readiness'\)/.test(apiSrc));

ok('C5 /healthz remains static (no readiness/pg in healthz block)', (() => {
  const i = apiSrc.indexOf("pathname === '/healthz'");
  const block = apiSrc.slice(i, i + 600);
  return /status:\s*'ok'/.test(block)
    && !/handleStaffApiReadyz/.test(block)
    && !/checkPostgresReadiness/.test(block)
    && !/withPgClient/.test(block)
    && !/SELECT 1/.test(block);
})());

ok('C6 readiness lib never returns error details',
  /NOT_READY_BODY/.test(readinessSrc)
  && /status: 'not-ready'/.test(readinessSrc)
  && !/error:\s*err/.test(readinessSrc)
  && !/err\.message/.test(readinessSrc)
  && !/err\.stack/.test(readinessSrc)
  && !/JSON\.stringify\(err/.test(readinessSrc));

const whProbe = locks.validateBicepProbeContract(whBicep);
const sunProbe = locks.validateBicepProbeContract(sunsetBicep);
ok('C7 Wolfhouse Bicep probe contract', whProbe.ok, whProbe.detail);
ok('C8 Sunset Bicep probe contract', sunProbe.ok, sunProbe.detail);
ok('C9 Wolfhouse/Sunset probe blocks identical (no drift)',
  whProbe.ok && sunProbe.ok && whProbe.block === sunProbe.block);

ok('C10 drill remains open',
  contract.final_controlled_drill
  && contract.final_controlled_drill.status === 'open'
  && contract.final_controlled_drill.id === '16C_DRILL_readiness_failure_traffic_shed'
  && Array.isArray(contract.still_open)
  && contract.still_open.length >= 2);

const pkg = readJson('package.json');
ok('C11 npm script registered',
  pkg.scripts['verify:radar-slice16c-staff-api-readiness']
  === 'node scripts/verify-radar-slice16c-staff-api-readiness.js');

// ── RED ─────────────────────────────────────────────────────────────────────

(async () => {
  // RED: missing pool / withPgClient
  {
    const r = await readiness.checkPostgresReadiness(null);
    red('missing_pool', r.ok === false);
    const r2 = await readiness.checkPostgresReadiness(undefined);
    red('missing_pool_undefined', r2.ok === false);
  }

  // RED: DB error → not-ready, no leak
  {
    const server = readiness.createReadyzTestListener({
      withPgClient: mockWithPgClient('error'),
    });
    const port = await listen(server);
    try {
      const res = await httpGet(port, '/readyz');
      red('db_error_503',
        res.statusCode === 503
        && JSON.parse(res.body).status === 'not-ready'
        && !bodyHasSensitiveLeak(res.body, ['supersecret', 'hunter2']));
    } finally {
      await closeServer(server);
    }
  }

  // RED: DB timeout → not-ready
  {
    const server = readiness.createReadyzTestListener({
      withPgClient: mockWithPgClient('timeout'),
    });
    const port = await listen(server);
    try {
      const started = Date.now();
      const res = await httpGet(port, '/readyz');
      const elapsed = Date.now() - started;
      red('db_timeout_503',
        res.statusCode === 503
        && JSON.parse(res.body).status === 'not-ready'
        && elapsed < readiness.READINESS_TIMEOUT_MS + 1500
        && !bodyHasSensitiveLeak(res.body));
    } finally {
      await closeServer(server);
    }
  }

  // RED: sensitive error leakage via checkPostgresReadiness return shape
  {
    const r = await readiness.checkPostgresReadiness(mockWithPgClient('error'));
    red('no_sensitive_fields_on_result',
      r.ok === false
      && Object.keys(r).length === 1
      && !('error' in r)
      && !('message' in r)
      && !('stack' in r));
  }

  // RED: DML/DDL query changes rejected
  {
    const badSqls = [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x=1',
      'DELETE FROM t',
      'DROP TABLE t',
      'ALTER TABLE t ADD c int',
      'SELECT 1; DELETE FROM t',
      'select 1',
      'SELECT 1 FROM users',
    ];
    let allRejected = true;
    for (const sql of badSqls) {
      const gate = readiness.assertReadOnlyReadinessSql(sql);
      const check = await readiness.checkPostgresReadiness(mockWithPgClient('ok'), { sql });
      if (gate.ok || check.ok) allRejected = false;
    }
    red('dml_ddl_query_rejected', allRejected);
  }

  // RED: swapped paths in source would fail static contract
  {
    const healthIdx = apiSrc.indexOf("pathname === '/healthz'");
    const healthBlock = apiSrc.slice(healthIdx, healthIdx + 500);
    const readyIdx = apiSrc.indexOf('pathname === READYZ_PATH');
    const readyBlock = apiSrc.slice(readyIdx, readyIdx + 250);
    const swappedHealthUsesReady = /handleStaffApiReadyz|checkPostgresReadiness|SELECT 1/.test(healthBlock);
    const readyUsesStaticOk = /status:\s*'ok'/.test(readyBlock) && !/handleStaffApiReadyz/.test(readyBlock);
    red('paths_not_swapped_in_source', !swappedHealthUsesReady && !readyUsesStaticOk);

    const liveSwap = mutateLivenessToReadyz(whBicep);
    const liveCheck = locks.validateBicepProbeContract(liveSwap);
    red('liveness_readyz_swap_rejected', liveCheck.ok === false);

    const readySwap = mutateReadinessPathToHealthz(whBicep);
    const readyCheck = locks.validateBicepProbeContract(readySwap);
    red('readiness_healthz_swap_rejected', readyCheck.ok === false);
  }

  // RED: absent probes
  {
    const absent = mutateProbesAbsent(whBicep);
    const r = locks.validateBicepProbeContract(absent);
    red('absent_probes_rejected', r.ok === false && /absent|missing/i.test(String(r.detail || '')));
  }

  // RED: wrong ports
  {
    const badPort = mutateProbePort(whBicep, 8080);
    // After port mutation, probeSpecPresent should fail (port: 3036 missing in probes)
    // Also mutate only probe ports inside block:
    const block = locks.extractProbesBlock(whBicep);
    const mutatedBlock = block.replace(/port:\s*3036/g, 'port: 8080');
    const mutated = whBicep.replace(block, mutatedBlock);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_port_rejected', r.ok === false, r.detail);
    void badPort;
  }

  // RED: wrong timings
  {
    const mutated = mutateProbeTiming(whBicep);
    const r = locks.validateBicepProbeContract(mutated);
    red('wrong_probe_timings_rejected', r.ok === false, r.detail);
  }

  // RED: Sunset/Wolfhouse drift
  {
    const drifted = sunsetBicep.replace(
      locks.extractProbesBlock(sunsetBicep),
      locks.extractProbesBlock(sunsetBicep).replace('periodSeconds: 20', 'periodSeconds: 99'),
    );
    const a = locks.validateBicepProbeContract(whBicep);
    const b = locks.validateBicepProbeContract(drifted);
    red('sunset_wolfhouse_drift_detected',
      a.ok === true
      && (b.ok === false || a.block !== b.block));
  }

  // ── GREEN ─────────────────────────────────────────────────────────────────

  {
    const server = readiness.createReadyzTestListener({
      withPgClient: mockWithPgClient('ok'),
    });
    const port = await listen(server);
    try {
      const ready = await httpGet(port, '/readyz');
      const live = await httpGet(port, '/healthz');
      green('listener_readyz_200',
        ready.statusCode === 200
        && JSON.parse(ready.body).status === 'ready'
        && !bodyHasSensitiveLeak(ready.body));
      green('listener_healthz_200_static',
        live.statusCode === 200
        && JSON.parse(live.body).status === 'ok'
        && !bodyHasSensitiveLeak(live.body));
    } finally {
      await closeServer(server);
    }
  }

  {
    try {
      const outWh = bicepBuild(locks.WOLFHOUSE_BICEP_REL);
      const compiledWh = JSON.parse(fs.readFileSync(outWh, 'utf8'));
      const tpl = JSON.stringify(compiledWh);
      green('compiled_wolfhouse_bicep_has_probes',
        fs.existsSync(outWh)
        && /"type"\s*:\s*"Liveness"/.test(tpl)
        && /"type"\s*:\s*"Readiness"/.test(tpl)
        && /"type"\s*:\s*"Startup"/.test(tpl)
        && /"path"\s*:\s*"\/readyz"/.test(tpl)
        && /"path"\s*:\s*"\/healthz"/.test(tpl)
        && /"port"\s*:\s*3036/.test(tpl));
    } catch (err) {
      green('compiled_wolfhouse_bicep_has_probes', false,
        String(err && err.stderr || err.message || err).slice(0, 500));
    }
  }

  {
    try {
      const outSun = bicepBuild(locks.SUNSET_BICEP_REL);
      const compiledSun = JSON.parse(fs.readFileSync(outSun, 'utf8'));
      const tpl = JSON.stringify(compiledSun);
      green('compiled_sunset_bicep_has_probes',
        fs.existsSync(outSun)
        && /"type"\s*:\s*"Liveness"/.test(tpl)
        && /"type"\s*:\s*"Readiness"/.test(tpl)
        && /"path"\s*:\s*"\/readyz"/.test(tpl)
        && /"port"\s*:\s*3036/.test(tpl));
    } catch (err) {
      green('compiled_sunset_bicep_has_probes', false,
        String(err && err.stderr || err.message || err).slice(0, 500));
    }
  }

  // Owned paths secret-free + no trailing WS in fixtures/docs owned by 16C
  let ownedOk = true;
  for (const rel of locks.OWNED_RELS) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      ok(`owned exists ${rel}`, false);
      ownedOk = false;
      continue;
    }
    const text = readText(rel);
    const sec = secretFree(text, rel);
    if (!sec.ok) {
      ok(`secret-free ${rel}`, false, sec.detail);
      ownedOk = false;
    }
  }
  ok('C12 owned artifacts secret-free', ownedOk);

  const requiredRed = [
    'missing_pool',
    'db_error_503',
    'db_timeout_503',
    'no_sensitive_fields_on_result',
    'dml_ddl_query_rejected',
    'paths_not_swapped_in_source',
    'liveness_readyz_swap_rejected',
    'readiness_healthz_swap_rejected',
    'absent_probes_rejected',
    'wrong_probe_port_rejected',
    'wrong_probe_timings_rejected',
    'sunset_wolfhouse_drift_detected',
  ];
  const requiredGreen = [
    'listener_readyz_200',
    'listener_healthz_200_static',
    'compiled_wolfhouse_bicep_has_probes',
    'compiled_sunset_bicep_has_probes',
  ];
  ok('C13 all required RED ids ran',
    requiredRed.every((id) => redResults.some((r) => r.id === id && r.ok)));
  ok('C14 all required GREEN ids ran',
    requiredGreen.every((id) => greenResults.some((r) => r.id === id && r.ok)));

  // database / hermes must stay untouched by 16C
  const forbiddenDiff = execFileSync(
    'git',
    ['diff', '--name-only', MASTER, '--', 'database/', 'docker/hermes-staging/'],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  ok('C15 no database/hermes mutation vs master', forbiddenDiff === '', forbiddenDiff);

  console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
  console.log(`Result: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16C staff API readiness: PASS');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
