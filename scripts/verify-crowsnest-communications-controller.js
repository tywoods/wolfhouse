'use strict';

const assert = require('assert');
const http = require('http');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const seen = [];
  let effective = { number_id: 'staging-es-34663439419', target_id: 'sunset' };
  let latest = { event_id: 'event-initial', number_id: effective.number_id, old_target_id: 'sunset', new_target_id: 'sunset', changed_by: 'fixture', changed_at: '2026-09-19T20:00:00Z' };
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const action = req.url.replace(/^\//, '');
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ action, method: req.method, body });
      let payload;
      if (action === 'targets') payload = { ok: true, numbers: [{ id: effective.number_id }], targets: [{ id: 'sunset' }, { id: 'wolfhouse' }] };
      else if (action === 'effective') payload = { ok: true, binding: effective };
      else if (action === 'audit') payload = { ok: true, latest };
      else if (action === 'confirm') payload = { ok: true, confirmation_token: 'fixture-confirmation-token' };
      else if (action === 'apply') {
        latest = { event_id: 'event-applied', number_id: body.number_id, old_target_id: effective.target_id, new_target_id: body.target_id, changed_by: 'fixture', changed_at: '2026-09-19T20:01:00Z' };
        effective = { number_id: body.number_id, target_id: body.target_id };
        payload = { ok: true, audit_event_id: latest.event_id };
      } else { res.writeHead(404); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  const upstreamPort = await listen(upstream);
  process.env.CROWSNEST_AUTH_REQUIRED = '0';
  process.env.CROWSNEST_LUNA_ROUTING_CONTROLLER_URL = `http://127.0.0.1:${upstreamPort}/`;
  const { server } = require('./crowsnest-api');
  const port = await listen(server);
  try {
    assert.equal((await request(port, '/api/staging/luna-routing/targets')).status, 200);
    assert.equal((await request(port, '/api/staging/luna-routing/effective')).body.binding.target_id, 'sunset');
    assert.equal((await request(port, '/api/staging/luna-routing/audit')).status, 200);
    assert.equal((await request(port, '/api/staging/luna-routing/confirm', { method: 'GET' })).status, 405);
    const base = { number_id: 'staging-es-34663439419', target_id: 'wolfhouse', expected_old_target_id: 'sunset' };
    assert.equal((await request(port, '/api/staging/luna-routing/confirm', { method: 'POST', body: base })).body.confirmation_token, 'fixture-confirmation-token');
    const applyResponse = await request(port, '/api/staging/luna-routing/apply', { method: 'POST', body: { ...base, confirmation_token: 'fixture-confirmation-token' } });
    assert.equal(applyResponse.status, 200);
    assert.equal(applyResponse.body.audit_event_id, 'event-applied');
    assert.equal((await request(port, '/api/staging/luna-routing/effective')).body.binding.target_id, 'wolfhouse');
    assert.equal((await request(port, '/api/staging/luna-routing/apply', { method: 'POST', body: { ...base, number_id: 'production-number', confirmation_token: 'fixture-confirmation-token' } })).body.error, 'unknown_or_production_number_denied');
    assert.equal((await request(port, '/api/staging/luna-routing/confirm', { method: 'POST', body: { ...base, target_id: 'arbitrary' } })).body.error, 'unknown_target_denied');
    assert.equal((await request(port, '/api/staging/luna-routing/apply', { method: 'POST', body: { ...base, confirmation_token: 'short' } })).body.error, 'invalid_confirmation_token');
    const apply = seen.find((entry) => entry.action === 'apply');
    assert.deepEqual(Object.keys(apply.body).sort(), ['confirmation_token', 'expected_old_target_id', 'number_id', 'target_id']);
    console.log('PASS verify:crowsnest-communications-controller');
  } finally {
    await close(server);
    await close(upstream);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
