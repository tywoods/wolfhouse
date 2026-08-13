'use strict';
/** Staff-only, draft-only Luna email generation boundary. */
const util = require('node:util');
const EMAIL_LUNA_GENERATE_DRAFT_PATH = '/staff/inbox/email/generate-luna-draft';
const EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV = 'EMAIL_STAFF_LUNA_DRAFT_ENABLED';
const EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR = 'luna_email_generation_capability_unavailable';
const EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON = 'authoritative_content_and_grounded_policy_not_configured';
const EMAIL_LUNA_GENERATE_BODY_KEYS = Object.freeze(['conversation_id']);
const READY_KEYS = Object.freeze(['status','subject','body','language','client_id','location_id','conversation_id','draft_only','requires_staff_review','send_allowed','auto_send_allowed']);
const HANDOFF_KEYS = Object.freeze(['status','reason','client_id','location_id','conversation_id','draft_only','requires_staff_review','send_allowed','auto_send_allowed']);
const SAVE_RECEIPT_KEYS = Object.freeze(['status','conversation_id','approval_id']);
const ACTOR_KEYS = Object.freeze(['staff_user_id','client_id','role']);
const BODY_MAX_BYTES = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const ownKeys = Reflect.ownKeys;
const isArray = Array.isArray;
const reflectApply = Reflect.apply;

// Align with staff-email-inbox-routes SQL_RESOLVE + live conversations schema:
// no c.deleted_at / c.channel (email proven by phone namespace + projection chain).
// Inbound events (063) use sender_* columns; body is not durable on events yet
// (empty body_text projection — handoff envelope still receives the key).
const SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT = `
SELECT cl.id::text AS client_id, cl.slug AS client_slug,
  loc.id::text AS location_id, loc.location_id AS location_key,
  ep.id::text AS endpoint_id, c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_message_id, 'email'::text AS channel,
  ev.provider, ev.provider_mailbox_id AS provider_mailbox_id, ev.provider_message_id AS provider_source_message_id,
  ep.provider_resource_id AS endpoint_provider_mailbox_id, ev.location_id::text AS event_location_id,
  COALESCE(ev.subject,'') AS subject, ''::text AS body_text,
  ''::text AS quoted_history, COALESCE(ev.sender_display_name,'') AS from_display_name,
  COALESCE(ev.sender_address,'') AS from_address, NULL::timestamptz AS conversation_deleted_at,
  c.status AS conversation_status, p.inbound_event_id::text AS latest_message_id,
  TRUE AS luna_draft_enabled
FROM clients cl
INNER JOIN staff_users su ON su.client_id=cl.id AND su.id=$2::uuid AND su.status='active'
  AND su.role IN ('operator','admin','owner')
INNER JOIN conversations c ON c.client_id=cl.id AND c.id=$3::uuid
  AND c.phone ~ '^(emailv1|email):'
INNER JOIN tenant_email_inbound_inbox_projections p ON p.client_id=c.client_id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
  AND ev.location_id=p.location_id AND ev.endpoint_id=p.endpoint_id
  AND ev.provider=p.provider AND ev.provider_mailbox_id=p.provider_mailbox_id
  AND ev.provider_message_id=p.provider_message_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.location_id=loc.location_id AND ep.channel='email'
  AND ep.provider='microsoft_graph' AND ep.auth_mode='delegated_authorization_code'
  AND ep.connector_mode='microsoft_delegated_oauth' AND ep.mailbox_access_kind='own_user'
  AND ep.binding_status='verified' AND ep.public_address IS NOT NULL AND btrim(ep.public_address)<>''
  AND ep.provider_resource_id IS NOT NULL AND btrim(ep.provider_resource_id)<>''
  AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND ev.provider_mailbox_id=ep.provider_resource_id
WHERE cl.id=$1::uuid AND cl.slug='sunset' AND loc.location_id='sunset-somo'
  AND ev.provider='microsoft_graph'
ORDER BY ev.received_at DESC, ev.id DESC LIMIT 1`.replace(/\s+/g, ' ').trim();

function ownData(value, key) {
  try { const d = getDescriptor(value, key); return d && hasOwn(d, 'value') && d.enumerable && !d.get && !d.set ? d.value : undefined; }
  catch { return undefined; }
}
function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || isArray(value) || isProxy(value)
      || (getPrototypeOf(value) !== Object.prototype && getPrototypeOf(value) !== null)) return false;
    const actual = ownKeys(value);
    return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key)
      && ownData(value, key) !== undefined);
  } catch { return false; }
}
function uuid(value) { return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null; }
function snapshotEmailLunaGenerateBody(raw) {
  if (!exactRecord(raw, EMAIL_LUNA_GENERATE_BODY_KEYS)) return null;
  const conversationId = uuid(ownData(raw, 'conversation_id'));
  return conversationId ? freeze({ conversation_id: conversationId }) : null;
}
function snapshotEmailLunaGenerateGateEnv(env) {
  const src = env && typeof env === 'object' && !isProxy(env) ? env : {};
  const out = Object.create(null);
  for (const key of ['LUNA_DEPLOYMENT', 'STAFF_PORTAL_ORIGIN', EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED']) {
    const value = ownData(src, key); if (typeof value === 'string') out[key] = value;
  }
  return freeze(out);
}
function isEmailLunaGenerateDraftEnabled(env) {
  return ownData(env, 'LUNA_DEPLOYMENT') === 'sunset-staging'
    && ownData(env, EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV) === 'true'
    && ownData(env, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED') === 'true';
}
function actor(user) {
  if (!exactRecord(user, ACTOR_KEYS) || getPrototypeOf(user) !== null) return null;
  const role = ownData(user, 'role');
  const staffId = uuid(ownData(user, 'staff_user_id')); const clientId = uuid(ownData(user, 'client_id'));
  if (!staffId || !clientId || !['operator', 'admin', 'owner'].includes(role)) return null;
  const snap = Object.create(null);
  snap.staff_user_id = staffId; snap.client_id = clientId; snap.role = role;
  return freeze(snap);
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => { bytes += chunk.length; if (bytes > BODY_MAX_BYTES) reject(new Error('large')); else chunks.push(chunk); });
    req.on('end', resolve); req.on('error', reject);
  });
  return snapshotEmailLunaGenerateBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
function safeRow(row, expectedActor, conversationId) {
  try {
    if (!row || typeof row !== 'object' || isProxy(row)) return null;
    const r = Object.create(null);
    for (const key of ['client_id','client_slug','location_id','location_key','endpoint_id','conversation_id','inbound_message_id',
      'channel','provider','provider_mailbox_id','provider_source_message_id','endpoint_provider_mailbox_id','event_location_id',
      'subject','body_text','quoted_history','from_display_name','from_address','conversation_deleted_at','conversation_status',
      'latest_message_id','luna_draft_enabled']) r[key] = ownData(row, key);
    const authority = {
      client_id: uuid(r.client_id), location_id: uuid(r.location_id), location_key: r.location_key,
      conversation_id: uuid(r.conversation_id), endpoint_id: uuid(r.endpoint_id), inbound_message_id: uuid(r.inbound_message_id),
    };
    if (!authority.client_id || authority.client_id !== expectedActor.client_id || authority.conversation_id !== conversationId
      || !authority.location_id || authority.location_key !== 'sunset-somo' || !authority.endpoint_id || !authority.inbound_message_id
      || r.client_slug !== 'sunset' || r.channel !== 'email' || r.provider !== 'microsoft_graph'
      || r.conversation_deleted_at != null || r.conversation_status !== 'open'
      || uuid(r.latest_message_id) !== authority.inbound_message_id || r.luna_draft_enabled !== true
      || uuid(r.event_location_id) !== authority.location_id
      || uuid(r.endpoint_provider_mailbox_id) !== uuid(r.provider_mailbox_id)
      || typeof r.provider_source_message_id !== 'string' || !r.provider_source_message_id) return null;
    const expectedAuthority = freeze({ client_id: authority.client_id, location_id: authority.location_id,
      location_key: authority.location_key, endpoint_id: authority.endpoint_id, conversation_id: authority.conversation_id,
      source_inbound_event_id: authority.inbound_message_id, provider: r.provider,
      provider_mailbox_id: r.provider_mailbox_id, provider_source_message_id: r.provider_source_message_id });
    return freeze({ authority: freeze(authority), expectedAuthority, row: freeze(r) });
  } catch { return null; }
}
function snapshotGenerated(result, authority) {
  const keys = exactRecord(result, READY_KEYS) ? READY_KEYS : (exactRecord(result, HANDOFF_KEYS) ? HANDOFF_KEYS : null);
  if (!keys) return null;
  const snap = Object.create(null);
  for (const key of keys) snap[key] = ownData(result, key);
  if (snap.client_id !== authority.client_id || snap.location_id !== authority.location_id
      || snap.conversation_id !== authority.conversation_id || snap.draft_only !== true
      || snap.requires_staff_review !== true || snap.send_allowed !== false || snap.auto_send_allowed !== false) return null;
  if (snap.status === 'handoff_required' && typeof snap.reason === 'string') return freeze(snap);
  if (snap.status !== 'draft_ready' || typeof snap.body !== 'string' || !snap.body.length
      || Buffer.byteLength(snap.body, 'utf8') > 8000) return null;
  return freeze(snap);
}
function snapshotSaveReceipt(receipt, conversationId) {
  try {
    if (!receipt || typeof receipt !== 'object' || isArray(receipt) || isProxy(receipt)
      || (getPrototypeOf(receipt) !== Object.prototype && getPrototypeOf(receipt) !== null)) return null;
    const actual = ownKeys(receipt);
    if (actual.length !== SAVE_RECEIPT_KEYS.length
      || !actual.every((key) => typeof key === 'string' && SAVE_RECEIPT_KEYS.includes(key))) return null;
    const snap = Object.create(null);
    for (const key of SAVE_RECEIPT_KEYS) {
      const descriptor = getDescriptor(receipt, key);
      if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable || descriptor.get || descriptor.set) return null;
      snap[key] = descriptor.value;
    }
    const savedConversationId = uuid(snap.conversation_id);
    const approvalId = uuid(snap.approval_id);
    if (snap.status !== 'saved' || savedConversationId !== conversationId || !approvalId) return null;
    return freeze({ status: snap.status, conversation_id: savedConversationId, approval_id: approvalId });
  } catch { return null; }
}
function createStaffEmailLunaDraftRoute(deps) {
  if (!deps || typeof deps.sendJSON !== 'function' || typeof deps.withPgClient !== 'function'
      || typeof deps.createLunaRuntime !== 'function' || typeof deps.saveDraftThroughStaffOwner !== 'function') throw new Error('deps required');
  let route;
  async function handleGenerateLunaDraft(req, res, user, gateEnv) {
    const env = gateEnv || snapshotEmailLunaGenerateGateEnv(deps.runtimeEnv || process.env);
    if (!isEmailLunaGenerateDraftEnabled(env)) return deps.sendJSON(res, 404, freeze({ success: false, error: 'not_found' }));
    const a = actor(user);
    if (!a) return deps.sendJSON(res, user ? 403 : 401, freeze({ success: false, error: user ? 'forbidden' : 'unauthorized' }));
    const headers = req && req.headers;
    if (!headers || headers['content-type'] !== 'application/json' || headers.origin !== ownData(env, 'STAFF_PORTAL_ORIGIN'))
      return deps.sendJSON(res, 403, freeze({ success: false, error: 'invalid_request' }));
    let input; try { input = await readBody(req); } catch { input = null; }
    if (!input) return deps.sendJSON(res, 400, freeze({ success: false, error: 'invalid_request' }));
    let context;
    try {
      context = await route.withPgClient(async (pg) => {
        const loaded = await pg.query(SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT, [a.client_id, a.staff_user_id, input.conversation_id]);
        return loaded && Array.isArray(loaded.rows) && loaded.rows.length === 1 ? safeRow(loaded.rows[0], a, input.conversation_id) : null;
      });
    } catch {
      return deps.sendJSON(res, 404, freeze({ success: false, error: 'not_found' }));
    }
    if (!context) return deps.sendJSON(res, 404, freeze({ success: false, error: 'not_found' }));
    // The inbound owner stores subject/sender metadata, not authoritative message
    // content, and no tenant/location-grounded email policy owner is production-wired.
    // Fail closed after authority reload and before runtime/model/write/send capabilities.
    return deps.sendJSON(res, 503, freeze({ success: false,
      error: EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR,
      reason: EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON }));
  }
  route = { handleGenerateLunaDraft, runtimeEnv: deps.runtimeEnv || process.env, withPgClient: deps.withPgClient };
  // The handler resolves this property at call time for the established offline
  // router probe; production wiring never mutates it.
  return route;
}
module.exports = { createStaffEmailLunaDraftRoute, EMAIL_LUNA_GENERATE_DRAFT_PATH,
  EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV, EMAIL_LUNA_GENERATE_BODY_KEYS,
  EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR, EMAIL_LUNA_GENERATION_UNAVAILABLE_REASON,
  SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT, snapshotEmailLunaGenerateBody,
  snapshotEmailLunaGenerateGateEnv, isEmailLunaGenerateDraftEnabled };
