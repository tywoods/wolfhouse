'use strict';
const crypto = require('crypto');
const CONTROLLER_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const NUMBER_E164 = '+346****9419';
const PHONE_NUMBER_ID = '1152900101233109';
const EXACT_PATH = '/whatsapp/webhook';
const ENVIRONMENT = 'staging';
const ACTIONS = Object.freeze({ flip: 'flip_to_sunset', rollback: 'rollback_to_wolfhouse' });
const REGISTERED_LUNAS = Object.freeze([Object.freeze({ id: 'wolfhouse', upstream: '127.0.0.1:8090' }), Object.freeze({ id: 'sunset', upstream: '127.0.0.1:8094' })]);
const pools = new Map();
function config(env = process.env) { const raw = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_URL || ''); const key = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY || ''); const dsn = String(env.CROWSNEST_COMMS_DATABASE_URL || ''); try { const url = new URL(raw); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook' && key.length >= 32 && dsn ? { url: url.href, key, dsn } : null; } catch (_) { return null; } }
function canonical(method, routePath, timestamp, nonce, body) { return [method, routePath, timestamp, nonce, body].join('\n'); }
function signedHeaders(method, routePath, body, key, now = Date.now(), nonce = crypto.randomUUID()) { const timestamp = String(now); const signature = crypto.createHmac('sha256', key).update(canonical(method, routePath, timestamp, nonce, body)).digest('hex'); return { authorization: `HMAC ${signature}`, 'x-routing-timestamp': timestamp, 'x-routing-nonce': nonce }; }
function sharedPool(dsn, poolFactory) { if (poolFactory) return poolFactory({ connectionString: dsn, max: 3 }); if (!pools.has(dsn)) { const { Pool } = require('pg'); pools.set(dsn, new Pool({ connectionString: dsn, max: 3 })); } return pools.get(dsn); }
function createAuditStore(dsn, poolFactory) {
  const pool = sharedPool(dsn, poolFactory);
  return {
    async begin(event) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE crowsnest_api');
        const inserted = await client.query(`INSERT INTO crowsnest_comms.number_route_operations
          (operation_id,action,expected_revision,actor_account_id,actor_username,state)
          VALUES ($1,$2,$3,$4,$5,'requested') ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id`, [event.operation_id, event.action, event.expected_revision, event.actor.account_id, event.actor.username]);
        const existing = inserted.rowCount ? null : (await client.query('SELECT action,expected_revision,actor_account_id,actor_username,state,response FROM crowsnest_comms.number_route_operations WHERE operation_id=$1', [event.operation_id])).rows[0];
        if (existing && (existing.action !== event.action || existing.expected_revision !== event.expected_revision || existing.actor_account_id !== event.actor.account_id || existing.actor_username !== event.actor.username)) { await client.query('ROLLBACK'); return { conflict: true }; }
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
async function closeAuditPools() { const values = [...pools.values()]; pools.clear(); await Promise.all(values.map((pool) => pool.end())); }
async function callController(method, payload, cfg, transport = fetch) { const body = payload ? JSON.stringify(payload) : ''; const headers = { accept: 'application/json', 'content-type': 'application/json', ...signedHeaders(method, CONTROLLER_PATH, body, cfg.key) }; let response; try { response = await transport(cfg.url, { method, headers, body: body || undefined, signal: AbortSignal.timeout(10000) }); } catch (_) { return { ok: false, status: 503, indeterminate: method === 'POST', code: method === 'POST' ? 'routing_outcome_indeterminate' : 'routing_controller_unavailable' }; } let result = {}; try { result = await response.json(); } catch (_) { } if (!response.ok || result.ok !== true) return { ok: false, status: [409, 415, 422].includes(response.status) ? response.status : 503, code: result.code || 'routing_controller_rejected', indeterminate: result.indeterminate === true, events: Array.isArray(result.events) ? result.events : [] }; return result; }
async function readLunaNumberRoute(options = {}) { const cfg = config(options.env); if (!cfg) return { ok: false, status: 503, code: 'routing_not_configured' }; const result = await callController('GET', null, cfg, options.transport); return result.ok ? { ok: true, number_e164: NUMBER_E164, phone_number_id: PHONE_NUMBER_ID, environment: ENVIRONMENT, route: result.route } : result; }
async function mutate(action, input, actor, options = {}) {
  if (!Object.values(ACTIONS).includes(action)) return { ok: false, status: 422, code: 'invalid_action' };
  if (!actor || !['earthling', 'monshies'].includes(actor.account_id)) return { ok: false, status: 403, code: 'named_operator_required' };
  const expected = String(input && input.expected_revision || ''); const operationId = String(input && input.operation_id || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) || !/^[a-f0-9]{64}$/i.test(expected)) return { ok: false, status: 422, code: 'invalid_confirmation' };
  const cfg = config(options.env); if (!cfg) return { ok: false, status: 503, code: 'routing_not_configured' };
  const store = options.auditStore || createAuditStore(cfg.dsn, options.poolFactory); const base = { operation_id: operationId, actor, action, expected_revision: expected };
  let begun; try { begun = await store.begin(base); } catch (_) { return { ok: false, status: 503, code: 'audit_unavailable' }; }
  if (begun.conflict) return { ok: false, status: 409, code: 'operation_id_conflict' };
  if (begun.response && ['succeeded', 'rejected'].includes(begun.state)) return begun.response;
  const result = await callController('POST', { operation_id: operationId, action, expected_revision: expected, actor_account_id: actor.account_id }, cfg, options.transport);
  try { await store.complete(base, result); } catch (_) { return { ok: false, status: 503, indeterminate: true, code: 'audit_reconciliation_required', operation_id: operationId }; }
  return result;
}
const flipLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.flip, input, actor, options);
const rollbackLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.rollback, input, actor, options);
module.exports = { CONTROLLER_PATH, NUMBER_E164, PHONE_NUMBER_ID, EXACT_PATH, ENVIRONMENT, ACTIONS, REGISTERED_LUNAS, canonical, signedHeaders, createAuditStore, closeAuditPools, readLunaNumberRoute, flipLunaNumberRoute, rollbackLunaNumberRoute };
