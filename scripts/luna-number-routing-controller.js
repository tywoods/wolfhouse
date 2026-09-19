'use strict';
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const ROUTE_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const EXACT_PATH = '/whatsapp/webhook';
const NUMBER_E164 = ['+34', '6****', '9419'].join('');
const PHONE_NUMBER_ID = '1152900101233109';
const TARGETS = Object.freeze({ wolfhouse: '127.0.0.1:8090', sunset: '127.0.0.1:8094' });
const ACTION_TARGET = Object.freeze({ flip_to_sunset: 'sunset', rollback_to_wolfhouse: 'wolfhouse' });
const MAX_NONCES = 10000;
const seenNonces = new Map();
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function canonical(method, routePath, ts, nonce, body) { return [method, routePath, ts, nonce, body].join('\n'); }
function equalHex(a, b) { if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false; return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
function authenticate(req, raw, key, now = Date.now()) {
  const ts = String(req.headers['x-routing-timestamp'] || '');
  const nonce = String(req.headers['x-routing-nonce'] || '');
  const match = /^HMAC ([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ''));
  for (const [n, t] of seenNonces) if (now - t > 60000) seenNonces.delete(n); // prune before lookup
  if (!key || key.length < 32 || !match || !/^\d{13}$/.test(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  if (Math.abs(now - Number(ts)) > 60000 || seenNonces.has(nonce) || seenNonces.size >= MAX_NONCES) return false;
  const expected = crypto.createHmac('sha256', key).update(canonical(req.method, ROUTE_PATH, ts, nonce, raw)).digest('hex');
  if (!equalHex(match[1], expected)) return false;
  seenNonces.set(nonce, now);
  return true;
}
function normalizeDial(value) { return String(value).replace(/^localhost:/, '127.0.0.1:'); }
function managedBlock(target) { return ['# BEGIN luna-number-route', `handle ${EXACT_PATH} {`, `  reverse_proxy ${TARGETS[target]}`, '}', '# END luna-number-route'].join('\n'); }
function parseRoute(text) {
  const source = String(text);
  const blocks = [...source.matchAll(/# BEGIN luna-number-route\s*\n([\s\S]*?)\n# END luna-number-route/g)];
  let dial;
  if (blocks.length > 1) return null;
  if (blocks.length === 1) {
    const body = blocks[0][1];
    if ((body.match(new RegExp(`handle\\s+${EXACT_PATH.replaceAll('/', '\\/')}\\s*\\{`, 'g')) || []).length !== 1) return null;
    const proxies = [...body.matchAll(/reverse_proxy\s+([^\s{}]+)/g)];
    if (proxies.length !== 1) return null;
    dial = normalizeDial(proxies[0][1]);
  } else {
    const broad = [...source.matchAll(/reverse_proxy\s+\/whatsapp\/\*\s+([^\s{}]+)/g)];
    if (broad.length !== 1) return null;
    dial = normalizeDial(broad[0][1]);
  }
  const target = Object.keys(TARGETS).find((key) => TARGETS[key] === dial);
  return target ? { target_luna: target, upstream: dial, revision: digest(source), exact_path: EXACT_PATH } : null;
}
function buildCandidate(current, target) {
  const block = managedBlock(target);
  const marker = /# BEGIN luna-number-route[\s\S]*?# END luna-number-route/;
  if (marker.test(current)) return current.replace(marker, block);
  const broad = /(^|\n)(\s*)reverse_proxy\s+\/whatsapp\/\*/m;
  const match = broad.exec(current);
  if (!match) throw Object.assign(new Error('broad route missing'), { code: 'caddy_route_shape_unsupported' });
  return current.slice(0, match.index) + (match[1] || '') + (match[2] || '') + block + '\n' + current.slice(match.index + (match[1] || '').length);
}
function verifyIngressProof(proof, target, key, now = Date.now()) {
  if (!proof || proof.number_e164 !== NUMBER_E164 || proof.phone_number_id !== PHONE_NUMBER_ID || proof.path !== EXACT_PATH || proof.environment !== 'staging' || normalizeDial(proof.upstream) !== TARGETS[target]) return false;
  if (!Number.isFinite(proof.observed_at_ms) || Math.abs(now - proof.observed_at_ms) > 120000) return false;
  const payload = [proof.number_e164, proof.phone_number_id, proof.path, proof.environment, proof.upstream, String(proof.observed_at_ms)].join('\n');
  return equalHex(String(proof.signature || ''), crypto.createHmac('sha256', key).update(payload).digest('hex'));
}
function exactRouteFromJson(cfg) {
  const exact = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.routes)) {
      for (const route of node.routes) {
        const matches = Array.isArray(route.match) ? route.match : [];
        if (matches.some((m) => Array.isArray(m.path) && m.path.includes(EXACT_PATH))) exact.push(route);
      }
    }
    for (const value of Object.values(node)) walk(value);
  }
  walk(cfg);
  if (exact.length !== 1) return null;
  const route = exact[0];
  const matches = route.match || [];
  if (matches.length !== 1 || Object.keys(matches[0]).length !== 1 || !Array.isArray(matches[0].path) || matches[0].path.length !== 1 || matches[0].path[0] !== EXACT_PATH) return null;
  if (!Array.isArray(route.handle) || route.handle.length !== 1 || route.handle[0].handler !== 'reverse_proxy') return null;
  const upstreams = route.handle[0].upstreams;
  if (!Array.isArray(upstreams) || upstreams.length !== 1 || Object.keys(upstreams[0]).some((k) => k !== 'dial')) return null;
  const dial = normalizeDial(upstreams[0].dial);
  const target = Object.keys(TARGETS).find((key) => TARGETS[key] === dial);
  return target ? { target_luna: target, upstream: dial } : null;
}
async function effectiveRoute(fetchImpl = fetch) {
  try { const response = await fetchImpl('http://127.0.0.1:2019/config/'); return response.ok ? exactRouteFromJson(await response.json()) : null; } catch (_) { return null; }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function acquireLock(f, lockDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { f.mkdirSync(lockDir, { mode: 0o700 }); return () => { try { f.rmdirSync(lockDir); } catch (_) { /* released/cleaned */ } }; }
    catch (error) { if (error.code !== 'EEXIST' || Date.now() >= deadline) throw Object.assign(new Error('routing mutation busy'), { code: 'mutation_busy' }); await sleep(20); }
  }
}
function readLedger(f, filename) { try { const value = JSON.parse(f.readFileSync(filename, 'utf8')); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; } }
function writeLedger(f, filename, ledger) { const tmp = `${filename}.${process.pid}.tmp`; f.writeFileSync(tmp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 }); f.renameSync(tmp, filename); }
function binding(body) { return [body.action, body.expected_revision, body.actor_account_id].join('\n'); }
function createController(deps = {}) {
  const f = deps.fs || fs; const run = deps.exec || exec; const fetchImpl = deps.fetch || fetch;
  const caddy = deps.caddyfile || '/etc/caddy/Caddyfile'; const lockDir = deps.lockDir || `${caddy}.routing-lock`;
  const ledgerFile = deps.ledgerFile || `${caddy}.routing-operations.json`;
  const key = deps.hmacKey || process.env.LUNA_ROUTING_CONTROLLER_HMAC_KEY;
  const proofKey = deps.proofKey || process.env.LUNA_ROUTING_INGRESS_PROOF_KEY;
  async function state() { const text = f.readFileSync(caddy, 'utf8'); const route = parseRoute(text); const effective = await effectiveRoute(fetchImpl); if (!route || !effective || route.target_luna !== effective.target_luna) throw Object.assign(new Error(), { code: 'route_readback_failed' }); return route; }
  async function mutate(body) {
    if (!body || !ACTION_TARGET[body.action] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.operation_id || '')) || !/^[a-f0-9]{64}$/i.test(String(body.expected_revision || '')) || !['earthling', 'monshies'].includes(body.actor_account_id)) return { status: 422, body: { ok: false, code: 'invalid_request' } };
    let release;
    try { release = await acquireLock(f, lockDir, deps.lockTimeoutMs); } catch (error) { return { status: 409, body: { ok: false, code: error.code } }; }
    let backup;
    try {
      const ledger = readLedger(f, ledgerFile); const prior = ledger[body.operation_id]; const bound = binding(body);
      if (prior) return prior.binding === bound ? prior.response : { status: 409, body: { ok: false, code: 'operation_id_conflict' } };
      const beforeText = f.readFileSync(caddy, 'utf8'); const before = parseRoute(beforeText); const beforeEffective = await effectiveRoute(fetchImpl);
      if (!before || !beforeEffective || before.target_luna !== beforeEffective.target_luna) return { status: 503, body: { ok: false, code: 'route_readback_failed' } };
      if (body.expected_revision !== before.revision) return { status: 409, body: { ok: false, code: 'stale_revision' } };
      const target = ACTION_TARGET[body.action];
      if (before.target_luna === target) {
        const response = { status: 200, body: { ok: true, idempotent: true, route: before, events: [{ type: 'precondition', details: { already_applied: true } }, { type: 'readback', details: { target } }] } };
        ledger[body.operation_id] = { binding: bound, response };
        try { writeLedger(f, ledgerFile, ledger); } catch (_) { return { status: 503, body: { ok: false, indeterminate: true, code: 'operation_ledger_indeterminate', operation_id: body.operation_id } }; }
        return response;
      }
      if (body.action === 'flip_to_sunset') {
        let proof; try { const response = await fetchImpl(process.env.LUNA_ROUTING_INGRESS_PROOF_URL, { headers: { accept: 'application/json' } }); proof = await response.json(); } catch (_) { return { status: 422, body: { ok: false, code: 'ingress_proof_unavailable', events: [{ type: 'precondition', details: { accepted: false } }] } }; }
        if (!proofKey || !verifyIngressProof(proof, target, proofKey)) return { status: 422, body: { ok: false, code: 'invalid_ingress_proof', events: [{ type: 'precondition', details: { accepted: false } }] } };
      }
      let candidate; try { candidate = buildCandidate(beforeText, target); } catch (error) { return { status: 503, body: { ok: false, code: error.code } }; }
      const tmp = `${caddy}.${body.operation_id}.candidate`; backup = `${caddy}.${body.operation_id}.bak`;
      f.writeFileSync(tmp, candidate, { mode: 0o640 });
      try { await run('caddy', ['validate', '--config', tmp]); } catch (_) { try { f.unlinkSync(tmp); } catch (__){ } return { status: 422, body: { ok: false, code: 'candidate_validation_failed' } }; }
      const immediate = f.readFileSync(caddy, 'utf8');
      if (digest(immediate) !== before.revision) { try { f.unlinkSync(tmp); } catch (_) { } return { status: 409, body: { ok: false, code: 'stale_revision' } }; }
      f.copyFileSync(caddy, backup); f.renameSync(tmp, caddy);
      const events = [{ type: 'precondition', details: { accepted: true } }, { type: 'applied', details: { target } }];
      let response;
      try {
        await run('systemctl', ['reload', 'caddy']); const effective = await effectiveRoute(fetchImpl); const route = parseRoute(f.readFileSync(caddy, 'utf8'));
        if (!effective || !route || effective.target_luna !== target || route.target_luna !== target) throw new Error('readback');
        events.push({ type: 'readback', details: { target } }); response = { status: 200, body: { ok: true, route, events } };
      } catch (_) {
        f.copyFileSync(backup, caddy); let restored = false;
        try { await run('caddy', ['validate', '--config', caddy]); await run('systemctl', ['reload', 'caddy']); const effective = await effectiveRoute(fetchImpl); const restoredRoute = parseRoute(f.readFileSync(caddy, 'utf8')); restored = Boolean(effective && restoredRoute && digest(f.readFileSync(caddy, 'utf8')) === before.revision && effective.target_luna === before.target_luna); } catch (__){ restored = false; }
        events.push({ type: 'rollback', details: { restored } }); response = restored ? { status: 503, body: { ok: false, code: 'mutation_rolled_back', events } } : { status: 503, body: { ok: false, indeterminate: true, code: 'mutation_indeterminate', events } };
      }
      ledger[body.operation_id] = { binding: bound, response };
      try { writeLedger(f, ledgerFile, ledger); } catch (_) { return { status: 503, body: { ok: false, indeterminate: true, code: 'operation_ledger_indeterminate', operation_id: body.operation_id, events } }; }
      return response;
    } finally { if (backup) try { f.unlinkSync(backup); } catch (_) { } release(); }
  }
  return { state, mutate, key };
}
function send(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) }); res.end(data); }
function makeHandler(controller = createController()) { return async (req, res) => { if ((req.url || '').split('?')[0] !== ROUTE_PATH) return send(res, 404, { ok: false, code: 'not_found' }); let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return send(res, 413, { ok: false, code: 'payload_too_large' }); } if (!authenticate(req, raw, controller.key)) return send(res, 401, { ok: false, code: 'unauthorized' }); if (req.method === 'GET') { try { return send(res, 200, { ok: true, route: await controller.state() }); } catch (error) { return send(res, 503, { ok: false, code: error.code || 'readback_failed' }); } } if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' }); if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, code: 'unsupported_media_type' }); let body; try { body = JSON.parse(raw); } catch (_) { return send(res, 422, { ok: false, code: 'invalid_json' }); } const out = await controller.mutate(body); return send(res, out.status, out.body); }; }
if (require.main === module) { const cert = fs.readFileSync(process.env.LUNA_ROUTING_TLS_CERT); const privateKey = fs.readFileSync(process.env.LUNA_ROUTING_TLS_KEY); https.createServer({ cert, key: privateKey }, makeHandler()).listen(Number(process.env.LUNA_ROUTING_CONTROLLER_PORT || 8096), '127.0.0.1'); }
module.exports = { ROUTE_PATH, EXACT_PATH, NUMBER_E164, PHONE_NUMBER_ID, TARGETS, ACTION_TARGET, MAX_NONCES, digest, canonical, authenticate, managedBlock, parseRoute, buildCandidate, verifyIngressProof, exactRouteFromJson, effectiveRoute, acquireLock, createController, makeHandler };
