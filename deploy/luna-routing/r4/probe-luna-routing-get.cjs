#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const ROUTE_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const MAX_RESPONSE_BYTES = 8192;
function canonical(method, path, timestamp, nonce, body) { return [method, path, timestamp, nonce, body].join('\n'); }
function parseAllowlistedResult(raw, statusCode) {
  if (![200, 401, 503].includes(statusCode)) throw new Error(`unexpected HTTP status ${statusCode}`);
  let body;
  try { body = JSON.parse(raw); } catch (_) { throw new Error('response is not JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.ok !== 'boolean') throw new Error('invalid response schema');
  if (statusCode === 503 && !(body.ok === false && body.code === 'route_readback_failed')) throw new Error('unexpected inactive response');
  if (statusCode === 401 && !(body.ok === false && body.code === 'unauthorized')) throw new Error('unexpected unauthorized response');
  return { status: statusCode, body };
}
function request(url, key, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    const timers = options.timers || { setTimeout, clearTimeout };
    const deadlineMs = options.deadlineMs === undefined ? 8000 : options.deadlineMs;
    const idleMs = options.idleMs === undefined ? 5000 : options.idleMs;
    const finish = (fn, value) => { if (settled) return; settled = true; timers.clearTimeout(deadline); fn(value); };
    const deadline = timers.setTimeout(() => {
      const error = new Error('absolute request deadline exceeded');
      if (req) req.destroy(error); else finish(reject, error);
    }, deadlineMs);
    try {
      const target = new URL(url);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('URL must use http or https');
      if (typeof key !== 'string' || key.length < 32) throw new Error('HMAC key must be at least 32 characters');
      const timestamp = String((options.now || Date.now)());
      const nonce = options.nonce || crypto.randomBytes(18).toString('base64url');
      const signature = crypto.createHmac('sha256', key).update(canonical('GET', ROUTE_PATH, timestamp, nonce, '')).digest('hex');
      const client = options.client || (target.protocol === 'https:' ? https : http);
      req = client.request(target, { method: 'GET', headers: { accept: 'application/json', authorization: 'HMAC ' + signature, 'x-routing-timestamp': timestamp, 'x-routing-nonce': nonce }, timeout: idleMs }, res => {
        let chunks = [], size = 0;
        res.on('data', chunk => {
          size += Buffer.byteLength(chunk);
          if (size > (options.maxBytes || MAX_RESPONSE_BYTES)) { finish(reject, new Error('response too large')); return req.destroy(); }
          chunks.push(Buffer.from(chunk));
        });
        res.on('aborted', () => finish(reject, new Error('response aborted')));
        res.on('error', error => finish(reject, error));
        res.on('end', () => { try { finish(resolve, parseAllowlistedResult(Buffer.concat(chunks).toString('utf8'), res.statusCode)); } catch (error) { finish(reject, error); } });
      });
      req.on('timeout', () => req.destroy(new Error('socket idle timeout')));
      req.on('error', error => finish(reject, error));
      req.end();
    } catch (error) { if (req && typeof req.destroy === 'function') req.destroy(); finish(reject, error); }
  });
}
async function main(argv) {
  if (argv.length !== 2) throw new Error('usage: probe-luna-routing-get.cjs URL HMAC_KEY');
  const result = await request(argv[0], argv[1], { deadlineMs: process.env.LUNA_ROUTING_PROBE_DEADLINE_MS ? Number(process.env.LUNA_ROUTING_PROBE_DEADLINE_MS) : 8000 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 503) throw new Error('authenticated route is not inactive');
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; });
module.exports = { ROUTE_PATH, MAX_RESPONSE_BYTES, canonical, parseAllowlistedResult, request };
