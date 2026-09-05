'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
    env: { PATH: process.env.PATH, DESIGN_PREVIEW_PORT: '18710' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => {throw new Error('server exited before ready');}), new Promise((_, reject) => setTimeout(() => reject(new Error('startup timeout')), 5000).unref())]);
    const base = 'http://127.0.0.1:18710';
    for (const route of ['/', '/staff/login', '/staff/ui']) {
      const r = await fetch(base + route); assert.equal(r.status, 200);
      assert.match(r.headers.get('content-security-policy'), /connect-src 'none'/);
      assert.match(r.headers.get('x-robots-tag'), /noindex/);
      assert.match(await r.text(), /sample data/i);
    }
    assert.equal((await fetch(base + '/staff/api/bookings')).status, 404);
    assert.equal((await fetch(base + '/server.cjs')).status, 404);
    assert.equal((await fetch(base + '/.env')).status, 404);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await fetch(base + '/staff/login', { method })).status, 405);
    }
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal(await (await fetch(base + '/staff/login', { method: 'HEAD' })).text(), '');
    console.log('PASS: unauthenticated preview paths, no API/file exposure, writes rejected, CSP, noindex, health and HEAD');
  } finally { child.kill(); await once(child, 'exit'); }
})().catch(e => { console.error(e); process.exitCode = 1; });
