'use strict';
const crypto = require('crypto');


const CONTROLLER_PATH = '/v1/routes/meta-whatsapp-verified-webhook';
const NUMBER_E164 = '+34663439419';
const PHONE_NUMBER_ID = '1152900101233109';
const EXACT_PATH = '/whatsapp/webhook';
const ENVIRONMENT = 'staging';
const ACTIONS = Object.freeze({ flip: 'flip_to_sunset', rollback: 'rollback_to_wolfhouse' });
const REGISTERED_LUNAS = Object.freeze([
  Object.freeze({ id: 'wolfhouse', upstream: '127.0.0.1:8090' }),
  Object.freeze({ id: 'sunset', upstream: '127.0.0.1:8094' }),
]);

function config(env = process.env) {
  const origin = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_ORIGIN || '').replace(/\/$/, '');
  const key = String(env.CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY || '');
  const dsn = String(env.CROWSNEST_COMMS_DATABASE_URL || '');
  if (!/^https:\/\//.test(origin) || key.length < 32 || !dsn) return null;
  return { origin, key, dsn };
}
function canonical(method, path, timestamp, nonce, body) { return [method, path, timestamp, nonce, body].join('\n'); }
function signedHeaders(method, path, body, key, now = Date.now(), nonce = crypto.randomUUID()) {
  const timestamp = String(now);
  const signature = crypto.createHmac('sha256', key).update(canonical(method, path, timestamp, nonce, body)).digest('hex');
  return { authorization: ['HMAC', signature].join(' '), 'x-routing-timestamp': timestamp, 'x-routing-nonce': nonce };
}
function createAuditStore(dsn, poolFactory = (opts) => {
  const { Pool } = require('pg'); // deployment dependency; lazy so static/dev gates can start without npm install
  return new Pool(opts);
}) {
  const pool = poolFactory({ connectionString: dsn, max: 3 });
  return {
    async append(event) {
      await pool.query(`INSERT INTO crowsnest_comms.number_route_events
        (event_id,operation_id,sequence_no,event_type,actor_account_id,actor_username,action,expected_revision,details)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [crypto.randomUUID(), event.operation_id,
        event.sequence_no, event.event_type, event.actor.account_id, event.actor.username, event.action,
        event.expected_revision, JSON.stringify(event.details || {})]);
    },
    async close() { await pool.end(); },
  };
}
async function callController(method, payload, cfg, transport = fetch) {
  const body = payload ? JSON.stringify(payload) : '';
  const headers = { accept: 'application/json', 'content-type': 'application/json', ...signedHeaders(method, CONTROLLER_PATH, body, cfg.key) };
  let response;
  try { response = await transport(cfg.origin + CONTROLLER_PATH, { method, headers, body: body || undefined, signal: AbortSignal.timeout(10000) }); }
  catch (_) { return { ok: false, status: 503, code: 'routing_controller_unavailable' }; }
  let result = {}; try { result = await response.json(); } catch (_) { /* fail closed below */ }
  if (!response.ok || result.ok !== true) return { ok: false, status: [409,422].includes(response.status) ? response.status : 503, code: result.code || 'routing_controller_rejected', events: Array.isArray(result.events) ? result.events : [] };
  return result;
}
async function readLunaNumberRoute(options = {}) {
  const cfg = config(options.env); if (!cfg) return { ok:false,status:503,code:'routing_not_configured' };
  const result = await callController('GET', null, cfg, options.transport);
  return result.ok ? { ok:true, number_e164:NUMBER_E164, phone_number_id:PHONE_NUMBER_ID, environment:ENVIRONMENT, route:result.route } : result;
}
async function mutate(action, input, actor, options = {}) {
  if (!Object.values(ACTIONS).includes(action)) return { ok:false,status:422,code:'invalid_action' };
  if (!actor || !['earthling','monshies'].includes(actor.account_id)) return { ok:false,status:403,code:'named_operator_required' };
  const expected = String(input && input.expected_revision || '');
  const operationId = String(input && input.operation_id || '');
  if (!/^[a-f0-9-]{36}$/i.test(operationId) || !/^[a-f0-9]{64}$/i.test(expected)) return { ok:false,status:422,code:'invalid_confirmation' };
  const cfg = config(options.env); if (!cfg) return { ok:false,status:503,code:'routing_not_configured' };
  const store = options.auditStore || createAuditStore(cfg.dsn, options.poolFactory);
  const base = { operation_id:operationId, actor, action, expected_revision:expected };
  try { await store.append({ ...base, sequence_no:1, event_type:'requested', details:{} }); }
  catch (_) { return { ok:false,status:503,code:'audit_unavailable' }; }
  const payload = { operation_id:operationId, action, expected_revision:expected, actor_account_id:actor.account_id };
  const result = await callController('POST', payload, cfg, options.transport);
  try {
    let seq=2;
    for (const event of result.events || []) await store.append({ ...base, sequence_no:seq++, event_type:event.type, details:event.details || {} });
  } catch (_) { return { ok:false,status:503,code:'audit_completion_failed' }; }
  return result;
}
const flipLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.flip, input, actor, options);
const rollbackLunaNumberRoute = (input, actor, options) => mutate(ACTIONS.rollback, input, actor, options);
module.exports={CONTROLLER_PATH,NUMBER_E164,PHONE_NUMBER_ID,EXACT_PATH,ENVIRONMENT,ACTIONS,REGISTERED_LUNAS,canonical,signedHeaders,createAuditStore,readLunaNumberRoute,flipLunaNumberRoute,rollbackLunaNumberRoute};
