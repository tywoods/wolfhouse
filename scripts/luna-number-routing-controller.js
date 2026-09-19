'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const ROUTE_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const PUBLIC_CONTROLLER_PATH = '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook';
const EXACT_PATH = '/whatsapp/webhook';
const NUMBER_E164 = ['+34', '6****', '9419'].join('');
const PHONE_NUMBER_ID = '1152900101233109';
const TARGETS = Object.freeze({ wolfhouse: '127.0.0.1:8090', sunset: '127.0.0.1:8094' });
const ACTION_TARGET = Object.freeze({ flip_to_sunset: 'sunset', rollback_to_wolfhouse: 'wolfhouse' });
const MAX_NONCES = 10000;
const DEFAULT_STALE_LOCK_MS = 120000;
const seenNonces = new Map();
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function canonical(method, routePath, ts, nonce, body) { return [method, routePath, ts, nonce, body].join('\n'); }
function equalHex(a, b) { if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false; return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
function authenticate(req, raw, key, now = Date.now()) {
  const ts = String(req.headers['x-routing-timestamp'] || ''); const nonce = String(req.headers['x-routing-nonce'] || '');
  const match = /^HMAC ([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ''));
  for (const [n, t] of seenNonces) if (now - t > 60000) seenNonces.delete(n);
  if (!key || key.length < 32 || !match || !/^\d{13}$/.test(ts) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return false;
  if (Math.abs(now - Number(ts)) > 60000 || seenNonces.has(nonce) || seenNonces.size >= MAX_NONCES) return false;
  const expected = crypto.createHmac('sha256', key).update(canonical(req.method, ROUTE_PATH, ts, nonce, raw)).digest('hex');
  if (!equalHex(match[1], expected)) return false; seenNonces.set(nonce, now); return true;
}
function normalizeDial(value) { return String(value).replace(/^localhost:/, '127.0.0.1:'); }
function managedBlock(target) { return [`handle ${EXACT_PATH} {`, `  reverse_proxy ${TARGETS[target]}`, '}', ''].join('\n'); }
function parseRoute(text) {
  const source = String(text); let dial;
  for (const target of Object.keys(TARGETS)) if (source === managedBlock(target)) dial = TARGETS[target];
  if (!dial) return null;
  const target = Object.keys(TARGETS).find((key) => TARGETS[key] === dial);
  return target ? { target_luna: target, upstream: dial, revision: digest(source), exact_path: EXACT_PATH } : null;
}
function buildCandidate(current, target) { if (!parseRoute(current) || !Object.hasOwn(TARGETS, target)) throw Object.assign(new Error('fragment shape unsupported'), { code: 'caddy_route_shape_unsupported' }); return managedBlock(target); }
function verifyIngressProof(proof, target, key, now = Date.now()) { if (!proof || proof.number_e164 !== NUMBER_E164 || proof.phone_number_id !== PHONE_NUMBER_ID || proof.path !== EXACT_PATH || proof.environment !== 'staging' || normalizeDial(proof.upstream) !== TARGETS[target]) return false; if (!Number.isFinite(proof.observed_at_ms) || Math.abs(now - proof.observed_at_ms) > 120000) return false; const payload = [proof.number_e164, proof.phone_number_id, proof.path, proof.environment, proof.upstream, String(proof.observed_at_ms)].join('\n'); return equalHex(String(proof.signature || ''), crypto.createHmac('sha256', key).update(payload).digest('hex')); }
function exactRouteFromJson(cfg) {
  const exact = [];
  function walkRoutes(routes) { if (!Array.isArray(routes)) return; for (const route of routes) { const matches = Array.isArray(route.match) ? route.match : []; if (matches.some((m) => Array.isArray(m.path) && m.path.includes(EXACT_PATH))) exact.push(route); for (const handler of Array.isArray(route.handle) ? route.handle : []) if (handler && handler.handler === 'subroute') walkRoutes(handler.routes); } }
  const servers = cfg && cfg.apps && cfg.apps.http && cfg.apps.http.servers;
  if (!servers || typeof servers !== 'object') return null;
  for (const server of Object.values(servers)) walkRoutes(server && server.routes);
  if (exact.length !== 1) return null;
  const outer = exact[0]; const matches = outer.match;
  if (!Array.isArray(matches) || matches.length !== 1 || Object.keys(matches[0]).length !== 1 || !Array.isArray(matches[0].path) || matches[0].path.length !== 1 || matches[0].path[0] !== EXACT_PATH) return null;
  if (!Array.isArray(outer.handle) || outer.handle.length !== 1 || outer.handle[0].handler !== 'subroute' || !Array.isArray(outer.handle[0].routes) || outer.handle[0].routes.length !== 1) return null;
  const inner = outer.handle[0].routes[0];
  if (inner.match !== undefined || Object.keys(inner).some((k) => !['handle', 'terminal'].includes(k)) || !Array.isArray(inner.handle) || inner.handle.length !== 1 || inner.handle[0].handler !== 'reverse_proxy') return null;
  const proxy = inner.handle[0]; const upstreams = proxy.upstreams;
  if (!Array.isArray(upstreams) || upstreams.length !== 1 || Object.keys(upstreams[0]).some((k) => k !== 'dial')) return null;
  const dial = normalizeDial(upstreams[0].dial); const target = Object.keys(TARGETS).find((key) => TARGETS[key] === dial);
  return target ? { target_luna: target, upstream: dial } : null;
}
async function effectiveRoute(fetchImpl = fetch) { try { const response = await fetchImpl('http://127.0.0.1:2019/config/'); return response.ok ? exactRouteFromJson(await response.json()) : null; } catch (_) { return null; } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fsyncDir(f, filename) { const fd = f.openSync(path.dirname(filename), 'r'); try { f.fsyncSync(fd); } finally { f.closeSync(fd); } }
function atomicWrite(f, filename, value, mode = 0o600) { const tmp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; const fd = f.openSync(tmp, 'wx', mode); try { f.writeFileSync(fd, value); f.fsyncSync(fd); } finally { f.closeSync(fd); } f.renameSync(tmp, filename); fsyncDir(f, filename); }
function readJsonState(f, filename) { try { const value = JSON.parse(f.readFileSync(filename, 'utf8')); return { exists: true, value }; } catch (error) { if (error && error.code === 'ENOENT') return { exists: false }; throw Object.assign(new Error(`corrupt state file: ${filename}`), { code: 'corrupt_state' }); } }
function ownKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function processIdentity(f, pid = process.pid) {
  try { const bootId = f.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); const stat = f.readFileSync(`/proc/${pid}/stat`, 'utf8'); const close = stat.lastIndexOf(')'); if (!/^[0-9a-f-]{36}$/.test(bootId) || close < 2) return null; const fields = stat.slice(close + 2).split(' '); const starttime = fields[19]; return /^\d+$/.test(starttime) ? { boot_id: bootId, starttime } : null; } catch (_) { return null; }
}
async function acquireLock(f, lockDir, timeoutMs = 5000, options = {}) {
  const now = options.now || Date.now; const identity = options.processIdentity || ((pid) => processIdentity(f, pid)); const staleMs = options.staleMs || DEFAULT_STALE_LOCK_MS; const deadline = now() + timeoutMs; const token = crypto.randomUUID();
  while (true) {
    try { f.mkdirSync(lockDir, { mode: 0o700 }); const id = identity(process.pid); if (!id) { f.rmdirSync(lockDir); throw Object.assign(new Error('process identity unavailable'), { code: 'lock_identity_unavailable' }); } const owner = { version: 1, pid: process.pid, boot_id: id.boot_id, starttime: id.starttime, started_at_ms: now(), token }; atomicWrite(f, path.join(lockDir, 'owner.json'), `${JSON.stringify(owner)}\n`); return () => { let current; try { current = readJsonState(f, path.join(lockDir, 'owner.json')).value; } catch (_) { return; } if (current && current.token === token) { try { f.unlinkSync(path.join(lockDir, 'owner.json')); } catch (_) {} try { f.rmdirSync(lockDir); } catch (_) {} } }; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerFile = path.join(lockDir, 'owner.json'); let owner; try { owner = readJsonState(f, ownerFile).value; } catch (_) {} let age = -1; try { const dirStat = f.lstatSync(lockDir); const ownerStat = f.lstatSync(ownerFile); if (dirStat.isDirectory() && !dirStat.isSymbolicLink() && ownerStat.isFile() && !ownerStat.isSymbolicLink()) age = now() - Math.max(dirStat.mtimeMs, ownerStat.mtimeMs); } catch (_) {}
      const valid = ownKeys(owner, ['version','pid','boot_id','starttime','started_at_ms','token']) && owner.version === 1 && Number.isInteger(owner.pid) && owner.pid > 0 && /^[0-9a-f-]{36}$/.test(owner.boot_id) && /^\d+$/.test(owner.starttime) && Number.isFinite(owner.started_at_ms) && typeof owner.token === 'string'; const current = valid ? identity(owner.pid) : null; const same = current && current.boot_id === owner.boot_id && current.starttime === owner.starttime;
      if (age >= staleMs && (!valid || !same)) { try { f.unlinkSync(ownerFile); f.rmdirSync(lockDir); continue; } catch (_) {} }
      if (now() >= deadline) throw Object.assign(new Error('routing mutation busy'), { code: 'mutation_busy' }); await sleep(20);
    }
  }
}
function validResponse(value) { return ownKeys(value, ['status','body']) && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 && value.body && typeof value.body === 'object' && typeof value.body.ok === 'boolean'; }
function readLedger(f, filename) { const state = readJsonState(f, filename); if (!state.exists) return {}; const ledger = state.value; if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw Object.assign(new Error('invalid ledger schema'), { code: 'corrupt_state' }); for (const [id, row] of Object.entries(ledger)) if (!/^[0-9a-f-]{36}$/i.test(id) || !ownKeys(row, ['binding','response']) || typeof row.binding !== 'string' || !validResponse(row.response)) throw Object.assign(new Error('invalid ledger schema'), { code: 'corrupt_state' }); return ledger; }
function writeLedger(f, filename, ledger) { atomicWrite(f, filename, `${JSON.stringify(ledger)}\n`); }
function binding(body) { return [body.action, body.expected_revision, body.actor_account_id].join('\n'); }
function validJournal(j, body, bound, caddy) {
  const candidate = `${caddy}.${body.operation_id}.candidate`; const backup = `${caddy}.${body.operation_id}.bak`;
  return ownKeys(j, ['version','operation_id','binding','target','original_target','original_revision','candidate_revision','candidate_file','backup_file','phase','updated_at_ms']) && j.version === 1 && j.operation_id === body.operation_id && j.binding === bound && j.target === ACTION_TARGET[body.action] && Object.hasOwn(TARGETS, j.original_target) && /^[a-f0-9]{64}$/.test(j.original_revision) && /^[a-f0-9]{64}$/.test(j.candidate_revision) && j.candidate_file === candidate && j.backup_file === backup && ['prepared','installed','reloaded','rolled_back','cleanup_pending'].includes(j.phase) && Number.isFinite(j.updated_at_ms);
}
function preserveMetadata(f, source, destination) { const stat = f.statSync(source); f.chmodSync(destination, stat.mode & 0o7777); if (typeof f.chownSync === 'function') f.chownSync(destination, stat.uid, stat.gid); }
function createController(deps = {}) {
  const f = deps.fs || fs; const run = deps.exec || exec; const fetchImpl = deps.fetch || fetch; const caddy = deps.fragmentFile || deps.caddyfile || '/var/lib/luna-routing/luna-number-route.caddy'; const caddyBin = '/usr/bin/caddy'; const stateDir = deps.stateDir || path.dirname(caddy); const lockDir = deps.lockDir || path.join(stateDir, 'mutation.lock'); const ledgerFile = deps.ledgerFile || path.join(stateDir, 'operations.json'); const journalFile = deps.journalFile || path.join(stateDir, 'journal.json'); const key = deps.hmacKey || process.env.LUNA_ROUTING_CONTROLLER_HMAC_KEY; const proofKey = deps.proofKey || process.env.LUNA_ROUTING_INGRESS_PROOF_KEY;
  const checkpoint = (name) => { if (deps.crashAt === name) throw Object.assign(new Error(`injected crash: ${name}`), { crashInjected: true }); };
  const saveJournal = (j, phase) => { j.phase = phase; j.updated_at_ms = Date.now(); atomicWrite(f, journalFile, `${JSON.stringify(j)}\n`); };
  function validationWrapper(candidateFile) { return `http://127.0.0.1:0 {\n  import ${candidateFile}\n}\n`; }
  async function state() { const text = f.readFileSync(caddy, 'utf8'); const route = parseRoute(text); const effective = await effectiveRoute(fetchImpl); if (!route || !effective || route.target_luna !== effective.target_luna) throw Object.assign(new Error(), { code: 'route_readback_failed' }); return route; }
  async function mutate(body) {
    if (!body || !ACTION_TARGET[body.action] || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(body.operation_id || '')) || !/^[a-f0-9]{64}$/i.test(String(body.expected_revision || '')) || !['earthling', 'monshies'].includes(body.actor_account_id)) return { status: 422, body: { ok: false, code: 'invalid_request' } };
    let release; try { release = await acquireLock(f, lockDir, deps.lockTimeoutMs, { staleMs: deps.staleLockMs, processIdentity: deps.processIdentity, now: deps.now }); } catch (error) { return { status: error.code === 'mutation_busy' ? 409 : 503, body: { ok: false, code: error.code || 'lock_unavailable' } }; }
    const bound = binding(body); let j;
    try {
      const ledger = readLedger(f, ledgerFile); const prior = ledger[body.operation_id];
      const cleanup = () => { if (!j) return; saveJournal(j, 'cleanup_pending'); for (const file of [j.candidate_file, j.backup_file]) try { f.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } fsyncDir(f, caddy); f.unlinkSync(journalFile); fsyncDir(f, journalFile); };
      if (prior) { if (prior.binding !== bound) return { status: 409, body: { ok: false, code: 'operation_id_conflict' } }; const pending = readJsonState(f, journalFile); if (pending.exists) { j = pending.value; if (!validJournal(j, body, bound, caddy) || j.phase !== 'cleanup_pending') return { status: 503, body: { ok: false, indeterminate: true, code: 'corrupt_operation_journal' } }; try { cleanup(); } catch (_) { return { status: 503, body: { ok: false, code: 'terminal_outcome_cleanup_pending', operation_id: body.operation_id } }; } } return prior.response; }
      const finish = (response) => { ledger[body.operation_id] = { binding: bound, response }; writeLedger(f, ledgerFile, ledger); try { cleanup(); } catch (_) { return { status: 503, body: { ok: false, code: 'terminal_outcome_cleanup_pending', operation_id: body.operation_id } }; } return response; };
      const journalState = readJsonState(f, journalFile); j = journalState.exists ? journalState.value : null;
      if (j && !validJournal(j, body, bound, caddy)) return { status: 503, body: { ok: false, indeterminate: true, code: 'corrupt_operation_journal' } };
      if (!j) {
        const beforeText = f.readFileSync(caddy, 'utf8'); const before = parseRoute(beforeText); const beforeEffective = await effectiveRoute(fetchImpl);
        if (!before || !beforeEffective || before.target_luna !== beforeEffective.target_luna) return { status: 503, body: { ok: false, code: 'route_readback_failed' } };
        if (body.expected_revision !== before.revision) return { status: 409, body: { ok: false, code: 'stale_revision' } };
        const target = ACTION_TARGET[body.action];
        if (before.target_luna === target) { const response = { status: 200, body: { ok: true, idempotent: true, route: before, events: [{ type: 'precondition', details: { already_applied: true } }, { type: 'readback', details: { target } }] } }; ledger[body.operation_id] = { binding: bound, response }; try { writeLedger(f, ledgerFile, ledger); } catch (_) { return { status: 503, body: { ok: false, indeterminate: true, code: 'operation_ledger_indeterminate', operation_id: body.operation_id } }; } return response; }
        if (body.action === 'flip_to_sunset') { let proof; try { const response = await fetchImpl(process.env.LUNA_ROUTING_INGRESS_PROOF_URL, { headers: { accept: 'application/json' } }); proof = await response.json(); } catch (_) { return { status: 422, body: { ok: false, code: 'ingress_proof_unavailable', events: [{ type: 'precondition', details: { accepted: false } }] } }; } if (!proofKey || !verifyIngressProof(proof, target, proofKey)) return { status: 422, body: { ok: false, code: 'invalid_ingress_proof', events: [{ type: 'precondition', details: { accepted: false } }] } }; }
        let candidate; try { candidate = buildCandidate(beforeText, target); } catch (error) { return { status: 503, body: { ok: false, code: error.code } }; }
        const candidateFile = `${caddy}.${body.operation_id}.candidate`; const backupFile = `${caddy}.${body.operation_id}.bak`; atomicWrite(f, candidateFile, candidate, 0o640);
        const validationFile = path.join(stateDir, `validation-${body.operation_id}.Caddyfile`); try { atomicWrite(f, validationFile, validationWrapper(candidateFile), 0o600); await run(caddyBin, ['validate', '--config', validationFile, '--adapter', 'caddyfile']); } catch (_) { try { f.unlinkSync(candidateFile); } catch (__){ } return { status: 422, body: { ok: false, code: 'candidate_validation_failed' } }; } finally { try { f.unlinkSync(validationFile); fsyncDir(f, validationFile); } catch (_) {} }
        if (digest(f.readFileSync(caddy, 'utf8')) !== before.revision) { try { f.unlinkSync(candidateFile); } catch (_) {} return { status: 409, body: { ok: false, code: 'stale_revision' } }; }
        atomicWrite(f, backupFile, beforeText, 0o600);
        j = { version: 1, operation_id: body.operation_id, binding: bound, target, original_target: before.target_luna, original_revision: before.revision, candidate_revision: digest(candidate), candidate_file: candidateFile, backup_file: backupFile };
        saveJournal(j, 'prepared'); checkpoint('after-journal-before-rename');
      }
      let diskText = f.readFileSync(caddy, 'utf8'); let diskHash = digest(diskText); let effective = await effectiveRoute(fetchImpl);
      if (j.phase === 'rolled_back') {
        if (diskHash !== j.original_revision || !effective || effective.target_luna !== j.original_target) return { status: 503, body: { ok: false, indeterminate: true, code: 'recovery_state_ambiguous' } };
        return finish({ status: 503, body: { ok: false, code: 'mutation_rolled_back', events: [{ type: 'rollback', details: { restored: true } }] } });
      }
      if (j.phase === 'prepared') {
        if (diskHash === j.original_revision && effective && effective.target_luna === j.original_target) { if (!f.existsSync(j.candidate_file) || digest(f.readFileSync(j.candidate_file, 'utf8')) !== j.candidate_revision) return { status: 503, body: { ok: false, indeterminate: true, code: 'recovery_candidate_missing' } }; preserveMetadata(f, caddy, j.candidate_file); f.renameSync(j.candidate_file, caddy); fsyncDir(f, caddy); saveJournal(j, 'installed'); checkpoint('after-rename-before-reload'); }
        else if (diskHash === j.candidate_revision && effective && effective.target_luna === j.original_target) saveJournal(j, 'installed');
        else if (diskHash === j.candidate_revision && effective && effective.target_luna === j.target) saveJournal(j, 'reloaded');
        else return { status: 503, body: { ok: false, indeterminate: true, code: 'recovery_state_ambiguous' } };
      }
      if (j.phase === 'installed') {
        diskText = f.readFileSync(caddy, 'utf8'); effective = await effectiveRoute(fetchImpl);
        if (digest(diskText) !== j.candidate_revision || !effective || ![j.original_target, j.target].includes(effective.target_luna)) return { status: 503, body: { ok: false, indeterminate: true, code: 'recovery_state_ambiguous' } };
        if (effective.target_luna !== j.target) { try { await run('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'reload', 'caddy']); } catch (_) { return finish(await rollback(j)); } effective = await effectiveRoute(fetchImpl); }
        if (!effective || effective.target_luna !== j.target) return finish(await rollback(j));
        saveJournal(j, 'reloaded'); checkpoint('after-reload-before-final-ledger');
      }
      diskText = f.readFileSync(caddy, 'utf8'); effective = await effectiveRoute(fetchImpl); const route = parseRoute(diskText);
      if (j.phase !== 'reloaded' || digest(diskText) !== j.candidate_revision || !route || route.target_luna !== j.target || !effective || effective.target_luna !== j.target) return { status: 503, body: { ok: false, indeterminate: true, code: 'recovery_state_ambiguous' } };
      const response = { status: 200, body: { ok: true, route, events: [{ type: 'precondition', details: { accepted: true } }, { type: 'applied', details: { target: j.target } }, { type: 'readback', details: { target: j.target } }] } };
      return finish(response);
    } catch (error) { if (error.crashInjected) return { status: 503, body: { ok: false, indeterminate: true, code: 'injected_crash', operation_id: body.operation_id } }; return { status: 503, body: { ok: false, indeterminate: true, code: error.code === 'corrupt_state' ? 'corrupt_persistent_state' : 'mutation_indeterminate' } }; }
    finally { release(); }
  }
  async function rollback(journal) {
    const effective = await effectiveRoute(fetchImpl); const diskHash = digest(f.readFileSync(caddy, 'utf8'));
    if (diskHash !== journal.candidate_revision || !effective || ![journal.original_target, journal.target].includes(effective.target_luna) || !f.existsSync(journal.backup_file) || digest(f.readFileSync(journal.backup_file, 'utf8')) !== journal.original_revision) return { status: 503, body: { ok: false, indeterminate: true, code: 'mutation_indeterminate', events: [{ type: 'rollback', details: { restored: false } }] } };
    const metadata = f.statSync(caddy); atomicWrite(f, caddy, f.readFileSync(journal.backup_file, 'utf8'), metadata.mode & 0o7777); f.chmodSync(caddy, metadata.mode & 0o7777); if (typeof f.chownSync === 'function') f.chownSync(caddy, metadata.uid, metadata.gid);
    try { const validationFile = path.join(stateDir, `rollback-${journal.operation_id}.Caddyfile`); atomicWrite(f, validationFile, validationWrapper(caddy), 0o600); try { await run(caddyBin, ['validate', '--config', validationFile, '--adapter', 'caddyfile']); } finally { try { f.unlinkSync(validationFile); fsyncDir(f, validationFile); } catch (_) {} } await run('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'reload', 'caddy']); const after = await effectiveRoute(fetchImpl); if (!after || after.target_luna !== journal.original_target) throw new Error(); saveJournal(journal, 'rolled_back'); checkpoint('after-rollback-before-final-ledger'); return { status: 503, body: { ok: false, code: 'mutation_rolled_back', events: [{ type: 'rollback', details: { restored: true } }] } };
    } catch (error) { if (error.crashInjected) throw error; return { status: 503, body: { ok: false, indeterminate: true, code: 'mutation_indeterminate', events: [{ type: 'rollback', details: { restored: false } }] } }; }
  }
  return { state, mutate, key };
}
function send(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) }); res.end(data); }
function makeHandler(controller = createController()) { return async (req, res) => { if ((req.url || '').split('?')[0] !== ROUTE_PATH) return send(res, 404, { ok: false, code: 'not_found' }); let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) return send(res, 413, { ok: false, code: 'payload_too_large' }); } if (!authenticate(req, raw, controller.key)) return send(res, 401, { ok: false, code: 'unauthorized' }); if (req.method === 'GET') { try { return send(res, 200, { ok: true, route: await controller.state() }); } catch (error) { return send(res, 503, { ok: false, code: error.code || 'readback_failed' }); } } if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed' }); if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, code: 'unsupported_media_type' }); let body; try { body = JSON.parse(raw); } catch (_) { return send(res, 422, { ok: false, code: 'invalid_json' }); } const out = await controller.mutate(body); return send(res, out.status, out.body); }; }
if (require.main === module) http.createServer(makeHandler()).listen(Number(process.env.LUNA_ROUTING_CONTROLLER_PORT || 8096), '127.0.0.1');
module.exports = { ROUTE_PATH, PUBLIC_CONTROLLER_PATH, EXACT_PATH, NUMBER_E164, PHONE_NUMBER_ID, TARGETS, ACTION_TARGET, MAX_NONCES, DEFAULT_STALE_LOCK_MS, digest, canonical, authenticate, managedBlock, parseRoute, buildCandidate, verifyIngressProof, exactRouteFromJson, effectiveRoute, processIdentity, acquireLock, createController, makeHandler };
