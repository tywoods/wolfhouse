#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const wrapperPath = path.join(__dirname, 'run-luna-routing-r4.sh');
const probePath = path.join(__dirname, 'probe-luna-routing-get.cjs');
const wrapper = fs.readFileSync(wrapperPath, 'utf8');

function shellWords(command) {
  const parsed = cp.spawnSync('bash', ['-c', `eval "set -- ${command}"; printf '%s\\0' "$@"`], {
    encoding: null,
    env: { PATH: process.env.PATH },
  });
  assert.strictEqual(parsed.status, 0, parsed.stderr?.toString());
  return parsed.stdout.toString().split('\0').slice(0, -1);
}

function acceptanceProbeArguments() {
  const line = wrapper.split('\n').find(candidate =>
    candidate.includes('probe-luna-routing-get.cjs') && candidate.includes('local.auth.json'));
  assert.ok(line, 'missing local authenticated acceptance probe');
  const command = line.slice(line.indexOf('node '), line.indexOf(' >'))
    .replace('"$BUNDLE/probe-luna-routing-get.cjs"', JSON.stringify(probePath))
    .replace('http://127.0.0.1:8096/v1/routes/meta-whatsapp-verified-webhook', '"$TEST_URL"')
    .replace('/root/luna-routing.env', '"$TEST_ENV"');
  return command;
}

async function startServer(temp) {
  const serverScript = path.join(temp, 'stub-server.cjs');
  fs.writeFileSync(serverScript, `
const http = require('node:http');
const server = http.createServer((request, response) => {
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: false, code: 'route_readback_failed' }));
});
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'));
`, { mode: 0o700 });
  const child = cp.spawn(process.execPath, [serverScript], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    lines.once('line', line => resolve(Number(line)));
    child.once('exit', code => reject(new Error(`stub server exited ${code}`)));
  });
  lines.close();
  return { child, port };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-routing-node-call-'));
  const envFile = path.join(temp, 'controller.env');
  fs.writeFileSync(envFile, `LUNA_ROUTING_CONTROLLER_HMAC_KEY=${'k'.repeat(32)}\n`, { mode: 0o600 });
  const { child, port } = await startServer(temp);
  try {
    const command = acceptanceProbeArguments();
    const invocation = shellWords(command.replace('$TEST_URL', `http://127.0.0.1:${port}/v1/routes/meta-whatsapp-verified-webhook`).replace('$TEST_ENV', envFile));
    assert.strictEqual(invocation[0], 'node');
    const result = cp.spawnSync(process.execPath, invocation.slice(1), { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `exact wrapper acceptance call failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      status: 503,
      body: { ok: false, code: 'route_readback_failed' },
    });

    const helperCalls = wrapper.split('\n').filter(line => /\bnode (?:-- )?"\$BUNDLE\/[^" ]+\.cjs"/.test(line));
    assert.ok(helperCalls.length >= 10, 'expected complete wrapper helper-call inventory');
    for (const line of helperCalls) {
      const afterHelper = line.match(/\bnode (?:-- )?"\$BUNDLE\/[^" ]+\.cjs"\s+([^;|>&]+)/)?.[1]?.trim();
      if (afterHelper?.startsWith('--')) {
        assert.match(line, /\bnode -- "\$BUNDLE\//, `Node option boundary missing: ${line.trim()}`);
      }
    }
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('PASS real Node executes wrapper helper calls without consuming helper options');
})().catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
