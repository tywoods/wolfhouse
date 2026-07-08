'use strict';

/**
 * Runtime verifier for Crowsnest Basic Auth — spawns local server, no DB/network deps.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_PORT) || 13040;

let pass = 0;
let fail = 0;
let child = null;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.username != null && options.password != null) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function waitForHealthz(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      request(port, '/healthz')
        .then((res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .catch(retry);
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Crowsnest did not become ready on port ${port}`));
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [API_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, CROWSNEST_PORT: String(port), CROWSNEST_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    waitForHealthz(port)
      .then(() => resolve(stderr))
      .catch((err) => {
        stopServer();
        reject(new Error(`${err.message}\n${stderr}`));
      });
  });
}

function stopServer() {
  if (!child) return Promise.resolve();
  const proc = child;
  child = null;
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 2000);
  });
}

async function runScenario(name, port, env, tests) {
  console.log(`\n[${name}]`);
  await startServer(port, env);
  try {
    for (const test of tests) {
      await test(port);
    }
  } finally {
    await stopServer();
  }
}

async function main() {
  console.log('verify:crowsnest-auth — runtime Basic Auth gate\n');

  await runScenario('A auth disabled', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'false',
  }, [
    async (port) => {
      const ui = await request(port, '/crowsnest/ui');
      ok('GET /crowsnest/ui => 200 when auth disabled', ui.statusCode === 200);
      ok('UI body includes Crowsnest', ui.body.includes('Crowsnest'));
    },
    async (port) => {
      const hz = await request(port, '/healthz');
      ok('GET /healthz => 200 when auth disabled', hz.statusCode === 200);
      let body;
      try { body = JSON.parse(hz.body); } catch { body = null; }
      ok('healthz auth_enabled:false when auth disabled', body && body.auth_enabled === false);
    },
  ]);

  await runScenario('B auth enabled admin/admin', BASE_PORT + 1, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const ui = await request(port, '/crowsnest/ui');
      ok('GET /crowsnest/ui no auth => 401', ui.statusCode === 401);
      ok('401 WWW-Authenticate Basic realm=Crowsnest', /Basic realm="Crowsnest"/i.test(String(ui.headers['www-authenticate'] || '')));
      ok('401 body safe message', ui.body.includes('Crowsnest access required'));
    },
    async (port) => {
      const ui = await request(port, '/crowsnest/ui', { username: 'wrong', password: 'creds' });
      ok('GET /crowsnest/ui wrong auth => 401', ui.statusCode === 401);
    },
    async (port) => {
      const ui = await request(port, '/crowsnest/ui', { username: 'admin', password: 'admin' });
      ok('GET /crowsnest/ui admin/admin => 200', ui.statusCode === 200);
      ok('authorized UI includes Clients', ui.body.includes('Clients'));
    },
    async (port) => {
      const hz = await request(port, '/healthz');
      ok('GET /healthz => 200 when auth enabled', hz.statusCode === 200);
      let body;
      try { body = JSON.parse(hz.body); } catch { body = null; }
      ok('healthz auth_enabled:true when auth enabled', body && body.auth_enabled === true);
      ok('healthz body does not contain admin credential', !/admin/i.test(hz.body));
    },
  ]);

  await runScenario('C auth required misconfigured', BASE_PORT + 2, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: '',
    CROWSNEST_AUTH_PASSWORD: '',
  }, [
    async (port) => {
      const ui = await request(port, '/crowsnest/ui');
      ok('GET /crowsnest/ui => 503 when auth misconfigured', ui.statusCode === 503);
      ok('503 safe message', ui.body.includes('Crowsnest auth is not configured'));
      ok('503 does not return Crowsnest page HTML', !ui.body.includes('<!DOCTYPE html>'));
    },
  ]);

  console.log(`\n── verify:crowsnest-auth: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-auth — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
