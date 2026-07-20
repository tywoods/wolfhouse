'use strict';

/**
 * verify:staff-auth-api — fail-closed Staff API auth config (DILDO Slice 1)
 *
 * 1) Pure validator unit checks (no monolith import).
 * 2) Spawn real scripts/staff-query-api.js and prove refuse/start behavior.
 *
 * Run: node scripts/verify-staff-auth-api.js
 *      npm run verify:staff-auth-api
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'staff-query-api.js');
const BASE_PORT = Number(process.env.STAFF_AUTH_VERIFY_PORT) || 13036;

const {
  validateStaffAuthConfig,
  formatStaffAuthConfigErrors,
  AUTH_REQUIRED_VAR,
  AUTH_HTTPS_VAR,
  AUTH_ALLOW_OPEN_VAR,
  BOT_TOKEN_VAR,
  BIND_HOST_VAR,
} = require('./lib/staff-auth-config');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function baseSpawnEnv(overrides) {
  const env = { ...process.env };
  delete env.STAFF_AUTH_REQUIRED;
  delete env.STAFF_AUTH_HTTPS;
  delete env.STAFF_AUTH_ALLOW_OPEN;
  delete env.STAFF_RUNTIME_PROFILE;
  delete env.LUNA_BOT_INTERNAL_TOKEN;
  delete env.STAFF_QUERY_API_HOST;
  delete env.NODE_ENV;
  // FORTRESS 15L — clear Meta signature vars so spawn cases are explicit.
  delete env.META_APP_SECRET;
  delete env.META_WHATSAPP_VERIFY_TOKEN;
  delete env.META_WEBHOOK_SKIP_VERIFY;
  return { ...env, ...overrides };
}

function requestHealthz(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/healthz',
        method: 'GET',
        timeout: 1000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('healthz timeout'));
    });
    req.end();
  });
}

function spawnApi(port, envOverrides) {
  const child = spawn(process.execPath, [API_SCRIPT], {
    cwd: ROOT,
    env: baseSpawnEnv({
      STAFF_QUERY_API_PORT: String(port),
      ...envOverrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`timed out waiting for exit after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForListen(child, port, getStdout, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      reject(new Error(`process exited before listen (code=${code}, signal=${signal})`));
    };
    child.once('exit', onExit);

    const tick = () => {
      if (Date.now() - started > timeoutMs) {
        child.removeListener('exit', onExit);
        reject(new Error(`timed out waiting for listen on ${port}\n${getStdout()}`));
        return;
      }
      requestHealthz(port)
        .then((res) => {
          if (res.statusCode === 200) {
            child.removeListener('exit', onExit);
            resolve(res);
            return;
          }
          setTimeout(tick, 150);
        })
        .catch(() => setTimeout(tick, 150));
    };
    tick();
  });
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    try { child.kill('SIGTERM'); } catch { resolve(); }
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 2000);
  });
}

async function expectRefuseStartup(name, port, envOverrides, assertFn) {
  console.log(`\n[spawn refuse] ${name}`);
  const { child, getStdout, getStderr } = spawnApi(port, envOverrides);
  let listened = false;
  try {
    await Promise.race([
      waitForListen(child, port, getStdout, 8000).then(() => { listened = true; }),
      waitForExit(child, 20000),
    ]);
  } catch (err) {
    // timeout waiting for exit after listen attempt counts as failure below
    if (!listened && child.exitCode == null) {
      await stopChild(child);
    }
  }

  if (listened) {
    await stopChild(child);
    ok(`${name}: exits before listening`, false, 'process listened on /healthz');
    return;
  }

  const code = child.exitCode;
  const stdout = getStdout();
  const stderr = getStderr();
  const combined = `${stdout}\n${stderr}`;
  ok(`${name}: exits nonzero`, code !== 0 && code != null, `code=${code}`);
  ok(`${name}: never printed listen banner`, !/running on http/i.test(combined));
  if (typeof assertFn === 'function') {
    assertFn({ code, stdout, stderr, combined });
  }
}

async function expectStart(name, port, envOverrides, assertFn) {
  console.log(`\n[spawn start] ${name}`);
  const { child, getStdout, getStderr } = spawnApi(port, envOverrides);
  try {
    const health = await waitForListen(child, port, getStdout, 45000);
    ok(`${name}: listens and /healthz=200`, health.statusCode === 200);
    if (typeof assertFn === 'function') {
      assertFn({ health, stdout: getStdout(), stderr: getStderr() });
    }
  } catch (err) {
    ok(`${name}: listens and /healthz=200`, false, err.message);
  } finally {
    await stopChild(child);
  }
}

function runUnitChecks() {
  console.log('\n[unit] validateStaffAuthConfig');

  const missing = validateStaffAuthConfig({});
  ok('missing STAFF_AUTH_REQUIRED refuses', missing.ok === false);
  ok('missing error names STAFF_AUTH_REQUIRED', missing.errors.some((e) => e.variable === AUTH_REQUIRED_VAR));

  const empty = validateStaffAuthConfig({ STAFF_AUTH_REQUIRED: '' });
  ok('empty STAFF_AUTH_REQUIRED refuses', empty.ok === false);

  const falseNoOpen = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'false',
    NODE_ENV: 'test',
  });
  ok('false without allow-open refuses', falseNoOpen.ok === false);
  ok('false without allow-open names STAFF_AUTH_ALLOW_OPEN', falseNoOpen.errors.some((e) => e.variable === AUTH_ALLOW_OPEN_VAR));

  const mixed = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'True',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
  });
  ok('mixed-case STAFF_AUTH_REQUIRED refuses', mixed.ok === false);

  const malformed = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'yes',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
  });
  ok('malformed STAFF_AUTH_REQUIRED refuses', malformed.ok === false);

  const prodOpen = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'production',
    STAFF_QUERY_API_HOST: '127.0.0.1',
  });
  ok('production open mode refuses', prodOpen.ok === false);

  const stagingOpen = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'staging',
    STAFF_QUERY_API_HOST: '127.0.0.1',
  });
  ok('staging open mode refuses', stagingOpen.ok === false);

  const openNonLoopback = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'test',
    STAFF_QUERY_API_HOST: '0.0.0.0',
  });
  ok('open mode non-loopback refuses', openNonLoopback.ok === false);
  ok('open mode non-loopback names bind host', openNonLoopback.errors.some((e) => e.variable === BIND_HOST_VAR));

  const stagingNoHttps = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'true',
    NODE_ENV: 'staging',
  });
  ok('staging without STAFF_AUTH_HTTPS refuses', stagingNoHttps.ok === false);
  ok('staging HTTPS error names STAFF_AUTH_HTTPS', stagingNoHttps.errors.some((e) => e.variable === AUTH_HTTPS_VAR));

  const weakBot = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
    LUNA_BOT_INTERNAL_TOKEN: 'short-secret',
  });
  ok('weak bot token refuses', weakBot.ok === false);
  ok('weak bot error names LUNA_BOT_INTERNAL_TOKEN', weakBot.errors.some((e) => e.variable === BOT_TOKEN_VAR));
  const weakMsg = formatStaffAuthConfigErrors(weakBot);
  ok('weak bot error does not leak secret', !weakMsg.includes('short-secret'));

  const sessionOnlyBot = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
  });
  ok('authenticated mode without bot token ok', sessionOnlyBot.ok === true);

  const authed = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
    LUNA_BOT_INTERNAL_TOKEN: 'a'.repeat(32),
  });
  ok('authenticated staging mode ok', authed.ok === true && authed.authRequired === true);

  const openOk = validateStaffAuthConfig({
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'test',
    STAFF_QUERY_API_HOST: '127.0.0.1',
  });
  ok('local/test open mode ok', openOk.ok === true && openOk.openMode === true);
  ok('local/test open mode bindHost loopback', openOk.bindHost === '127.0.0.1');
}

async function runSpawnChecks() {
  const weakSecret = 'weak-bot-secret-SHOULD-NOT-LEAK';

  await expectRefuseStartup('missing auth config', BASE_PORT, {}, ({ combined }) => {
    ok('missing auth stderr names STAFF_AUTH_REQUIRED', combined.includes(AUTH_REQUIRED_VAR));
  });

  await expectRefuseStartup('explicit false outside local/test', BASE_PORT + 1, {
    STAFF_AUTH_REQUIRED: 'false',
    NODE_ENV: 'staging',
    STAFF_AUTH_HTTPS: 'true',
  }, ({ combined }) => {
    ok(
      'explicit false error mentions open allow or profile',
      combined.includes(AUTH_ALLOW_OPEN_VAR) || combined.includes('open mode'),
    );
  });

  await expectRefuseStartup('malformed auth value', BASE_PORT + 2, {
    STAFF_AUTH_REQUIRED: 'YES',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
  }, ({ combined }) => {
    ok('malformed stderr names STAFF_AUTH_REQUIRED', combined.includes(AUTH_REQUIRED_VAR));
  });

  await expectRefuseStartup('production open-mode request', BASE_PORT + 3, {
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'production',
    STAFF_QUERY_API_HOST: '127.0.0.1',
  }, ({ combined }) => {
    ok('production open-mode stderr mentions refuse', /refus|staging\/production|open mode/i.test(combined));
  });

  await expectRefuseStartup('weak bot secret', BASE_PORT + 4, {
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
    LUNA_BOT_INTERNAL_TOKEN: weakSecret,
  }, ({ combined }) => {
    ok('weak bot stderr names LUNA_BOT_INTERNAL_TOKEN', combined.includes(BOT_TOKEN_VAR));
    ok('weak bot stderr does not leak secret', !combined.includes(weakSecret));
  });

  await expectStart('valid authenticated mode', BASE_PORT + 5, {
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'true',
    NODE_ENV: 'staging',
    STAFF_QUERY_API_HOST: '127.0.0.1',
    // FORTRESS 15L — staging profile requires Meta signature config (sample values only).
    META_APP_SECRET: 'fortress_staff_auth_meta_app_secret_SAMPLE_NOT_LIVE',
    META_WHATSAPP_VERIFY_TOKEN: 'fortress_staff_auth_verify_token_SAMPLE_NOT_LIVE',
    META_WEBHOOK_SKIP_VERIFY: 'false',
  });

  await expectStart('explicit local/test open mode on loopback', BASE_PORT + 6, {
    STAFF_AUTH_REQUIRED: 'false',
    STAFF_AUTH_ALLOW_OPEN: 'true',
    NODE_ENV: 'test',
    STAFF_QUERY_API_HOST: '127.0.0.1',
  }, ({ stdout }) => {
    ok(
      'open mode listen banner mentions optional/open',
      /OPTIONAL|open mode|STAFF_AUTH_REQUIRED=false/i.test(stdout),
    );
  });
}

async function main() {
  console.log('verify:staff-auth-api — fail-closed Staff API authentication\n');
  runUnitChecks();
  await runSpawnChecks();

  console.log(`\n── verify:staff-auth-api: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:staff-auth-api — ALL CHECKS PASSED');
    process.exit(0);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
