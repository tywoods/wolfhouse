'use strict';
const crypto = require('crypto');
const waIdentity = require('../whatsapp-runtime-identity');
const CONTROLLER_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const EXACT_PATH = '/whatsapp/webhook';
const ENVIRONMENT = 'staging';
const ACTIONS = Object.freeze({ flip: 'flip_to_sunset', rollback: 'rollback_to_wolfhouse' });
const ROUTE_READ_TIMEOUT_MS = 2000;
const ROUTE_MUTATION_TIMEOUT_MS = 10000;
function routeControllerTimeoutMs(method) {
  return method === 'GET' ? ROUTE_READ_TIMEOUT_MS : ROUTE_MUTATION_TIMEOUT_MS;
}
const REGISTERED_LUNAS = Object.freeze([Object.freeze({ id: 'wolfhouse', upstream: '127.0.0.1:8090' }), Object.freeze({ id: 'sunset', upstream: '127.0.0.1:8094' })]);
const pools = new Map();
function isStagingEnvironment(env = process.env) {
  // Azure Crow’s Nest runs Node in production mode even for the staging deployment.
  // This dedicated deployment-scope flag is the fail-closed authority; absent or any
  // value other than the exact staging label keeps routing unavailable.
  return String(env.CROWSNEST_ENVIRONMENT || '').trim().toLowerCase() === 'staging';
}
function config(env = process.env) { if (!isStagingEnvironment(env)) return null; const raw = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_URL || ''); const key = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY || ''); const dsn = String(env.CROWSNEST_COMMS_DATABASE_URL || ''); try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook' && key.length >= 32 && dsn ? { url: url.href, key, dsn } : null; } catch (_) { return null; } }
function canonical(method, routePath, timestamp, nonce, body) { return [method, routePath, timestamp, nonce, body].join('\n'); }
function signedHeaders(method, routePath, body, key, now = Date.now(), nonce = crypto.randomUUID()) { const timestamp = String(now); const signature = crypto.createHmac('sha256', key).update(canonical(method, routePath, timestamp, nonce, body)).digest('hex'); return { authorization: `HMAC ${signature}`, 'x-routing-timestamp': timestamp, 'x-routing-nonce': nonce }; }
function sharedPool(dsn, poolFactory) { if (poolFactory) return poolFactory({ connectionString: dsn, max: 3 }); if (!pools.has(dsn)) { const { Pool } = require('pg'); pools.set(dsn, new Pool({ connectionString: dsn, max: 3 })); } return pools.get(dsn); }
function createAuditStore(dsn, poolFactory) {
  const pool = sharedPool(dsn, poolFactory);
  return {
    async latest() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE crowsnest_api');
        const result = await client.query(`SELECT operation_id,actor_username,updated_at
          FROM crowsnest_comms.number_route_operations
          WHERE state='succeeded' ORDER BY updated_at DESC LIMIT 1`);
        await client.query('COMMIT');
        const row = result.rows[0];
        return row ? { operation_id: row.operation_id, changed_by: row.actor_username, changed_at: new Date(row.updated_at).toISOString() } : null;
      } catch (error) { try { await client.query('ROLLBACK'); } catch (_) { } throw error; } finally { client.release(); }
    },
    async begin(event) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE crowsnest_api');
        const identity = event.identity || { number_id: null, phone_number_id: null, number_e164: null };
        const inserted = await client.query(`INSERT INTO crowsnest_comms.number_route_operations
          (operation_id,action,expected_revision,actor_account_id,actor_username,number_id,phone_number_id,number_e164,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested') ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id`, [event.operation_id, event.action, event.expected_revision, event.actor.account_id, event.actor.username, identity.number_id, identity.phone_number_id, identity.number_e164]);
        const existing = inserted.rowCount ? null : (await client.query('SELECT action,expected_revision,actor_account_id,actor_username,number_id,phone_number_id,number_e164,state,response FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [event.operation_id])).rows[0];
        if (existing && (existing.action !== event.action || existing.expected_revision !== event.expected_revision || existing.actor_account_id !== event.actor.account_id || existing.actor_username !== event.actor.username || existing.number_id !== identity.number_id || existing.phone_number_id !== identity.phone_number_id || existing.number_e164 !== identity.number_e164)) { await client.query('ROLLBACK'); return { conflict: true }; }
        if (inserted.rowCount) await client.query(`INSERT INTO crowsnest_comms.number_route_events
          (event_id,operation_id,sequence_no,event_type,actor_account_id,actor_username,action,expected_revision,details)
          VALUES ($1,$2,1,'requested',$3,$4,$5,$6,'{}')`, [crypto.randomUUID(), event.operation_id, event.actor.account_id, event.actor.username, event.action, event.expected_revision]);
        await client.query('COMMIT'); return { replay: Boolean(existing), response: existing && existing.response, state: existing && existing.state };
      } catch (error) { try { await client.query('ROLLBACK'); } catch (_) { } throw error; } finally { client.release(); }
    },
    async complete(event, result) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE crowsnest_api'); let sequence = 2;
        for (const item of result.events || []) await client.query(`INSERT INTO crowsnest_comms.number_route_events
          (event_id,operation_id,sequence_no,event_type,actor_account_id,actor_username,action,expected_revision,details)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (operation_id,sequence_no) DO NOTHING`, [crypto.randomUUID(), event.operation_id, sequence++, item.type, event.actor.account_id, event.actor.username, event.action, event.expected_revision, JSON.stringify(item.details || {})]);
        await client.query(`UPDATE crowsnest_comms.number_route_operations SET state=$2,response=$3::jsonb,updated_at=clock_timestamp() WHERE operation_id=$1`, [event.operation_id, result.ok ? 'succeeded' : (result.indeterminate ? 'indeterminate' : 'rejected'), JSON.stringify(result)]);
        await client.query('COMMIT');
      } catch (error) { try { await client.query('ROLLBACK'); } catch (_) { } throw error; } finally { client.release(); }
    },
    async close() { if (poolFactory) await pool.end(); },
  };
}
function observedDelivery(result) {
  const route = result && result.route;
  if (!route || !route.target_luna) return 'unavailable';
  return 'active';
}
function identityConfirmationError(input, env = process.env) {
  const snapshot = waIdentity.publicSnapshot(env);
  if (!snapshot.active) return null;
  if (!snapshot.ok) return snapshot.code || 'identity_rejected';
  if (!input || input.number_id !== snapshot.profileId || input.phone_number_id !== snapshot.phoneNumberId || input.number_e164 !== snapshot.numberE164) return 'stale_identity';
  return null;
}
function confirmedIdentity(input, env = process.env) {
  const snapshot = waIdentity.publicSnapshot(env);
  if (!snapshot.active || !snapshot.ok) return { number_id: null, phone_number_id: null, number_e164: null };
  return {
    number_id: input.number_id,
    phone_number_id: input.phone_number_id,
    number_e164: input.number_e164,
  };
}
function controllerIdentity(snapshot) {
  if (!snapshot || !snapshot.active || !snapshot.ok) return {};
  return {
    number_id: snapshot.profileId,
    phone_number_id: snapshot.phoneNumberId,
    number_e164: snapshot.numberE164,
  };
}
async function closeAuditPools() { const values = [...pools.values()]; pools.clear(); await Promise.all(values.map((pool) => pool.end())); }
async function callController(method, payload, cfg, transport = fetch) { const body = payload ? JSON.stringify(payload) : ''; const headers = { accept: 'application/json', 'content-type': 'application/json', ...signedHeaders(method, CONTROLLER_PATH, body, cfg.key) }; let response; try { response = await transport(cfg.url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(routeControllerTimeoutMs(method)) }); } catch (_) { return { ok: false, status: 503, indeterminate: method === 'POST', code: method === 'POST' ? 'routing_outcome_indeterminate' : 'routing_controller_unavailable' }; } let result = {}; try { result = await response.json(); } catch (_) { } if (!response.ok || result.ok !== true) return { ok: false, status: [409, 415, 422].includes(response.status) ? response.status : 503, code: result.code || 'routing_controller_rejected', indeterminate: result.indeterminate === true, events: Array.isArray(result.events) ? result.events : [] }; return result; }
async function readLunaNumberRoute(options = {}) { const runtimeEnv = options.env || process.env; if (!isStagingEnvironment(runtimeEnv)) return { ok: false, status: 404, code: 'routing_not_available' }; const cfg = config(runtimeEnv); if (!cfg) return { ok: false, status: 503, code: 'routing_not_configured' }; const result = await callController('GET', null, cfg, options.transport); if (!result.ok) return result; const snapshot = waIdentity.routePublicIdentity(runtimeEnv); let audit = null; try { const store = options.auditStore || createAuditStore(cfg.dsn, options.poolFactory); audit = await store.latest(); } catch (_) { audit = null; } return { ok: true, number_e164: snapshot.numberE164, number_display: snapshot.numberDisplay, phone_number_id: snapshot.phoneNumberId, routing_policy: 'off', routing_delivery: observedDelivery(result), environment: ENVIRONMENT, route: result.route, audit }; }
async function mutate(action, input, actor, options = {}) {
  const runtimeEnv = options.env || process.env;
  if (!isStagingEnvironment(runtimeEnv)) return { ok: false, status: 404, code: 'routing_not_available' };
  if (!Object.values(ACTIONS).includes(action)) return { ok: false, status: 422, code: 'invalid_action' };
  if (!actor || !['earthling', 'monshies'].includes(actor.account_id)) return { ok: false, status: 403, code: 'named_operator_required' };
  const expected = String(input && input.expected_revision || ''); const operationId = String(input && input.operation_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) || !/^[a-f0-9]{64}$/i.test(expected)) return { ok: false, status: 422, code: 'invalid_confirmation' };
  const identityError = identityConfirmationError(input, runtimeEnv);
  if (identityError) return { ok: false, status: 422, code: identityError };
  const cfg = config(runtimeEnv); if (!cfg) return { ok: false, status: 503, code: 'routing_not_configured' };
  const store = options.auditStore || createAuditStore(cfg.dsn, options.poolFactory); const identity = confirmedIdentity(input, runtimeEnv); const base = { operation_id: operationId, actor, action, expected_revision: expected, identity };
  let begun; try { begun = await store.begin(base); } catch (_) { return { ok: false, status: 503, code: 'audit_unavailable' }; }
  if (begun.conflict) return { ok: false, status: 409, code: 'operation_id_conflict' };
  if (begun.response && ['succeeded', 'rejected'].includes(begun.state)) return begun.response;
  const result = await callController('POST', { operation_id: operationId, action, expected_revision: expected, actor_account_id: actor.account_id, ...controllerIdentity(waIdentity.publicSnapshot(runtimeEnv)) }, cfg, options.transport);
  const completed = result.ok ? { ...result, audit: { operation_id: operationId, changed_by: actor.username, changed_at: new Date().toISOString() } } : result;
  try { await store.complete(base, completed); } catch (_) { return { ok: false, status: 503, indeterminate: true, code: 'audit_reconciliation_required', operation_id: operationId }; }
  return completed;
}
const flipLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.flip, input, actor, options);
const rollbackLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.rollback, input, actor, options);
module.exports = { CONTROLLER_PATH, EXACT_PATH, ENVIRONMENT, ACTIONS, REGISTERED_LUNAS, ROUTE_READ_TIMEOUT_MS, ROUTE_MUTATION_TIMEOUT_MS, routeControllerTimeoutMs, isStagingEnvironment, canonical, signedHeaders, createAuditStore, closeAuditPools, observedDelivery, identityConfirmationError, readLunaNumberRoute, flipLunaNumberRoute, rollbackLunaNumberRoute };
Object.defineProperty(module.exports, 'NUMBER_E164', { enumerable: true, get() { return waIdentity.exportedPublicId('numberE164'); } });
Object.defineProperty(module.exports, 'NUMBER_DISPLAY', { enumerable: true, get() { return waIdentity.exportedPublicId('numberDisplay'); } });
Object.defineProperty(module.exports, 'PHONE_NUMBER_ID', { enumerable: true, get() { return waIdentity.exportedPublicId('phoneNumberId'); } });
