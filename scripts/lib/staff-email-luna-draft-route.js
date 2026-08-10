'use strict';
/** Staff-only, draft-only Luna email generation boundary. */
const util = require('node:util');
const { createEmailLunaDraftEnvelope } = require('./email-luna-draft-handoff-contract');

const EMAIL_LUNA_GENERATE_DRAFT_PATH = '/staff/inbox/email/generate-luna-draft';
const EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV = 'EMAIL_STAFF_LUNA_DRAFT_ENABLED';
const EMAIL_LUNA_GENERATE_BODY_KEYS = Object.freeze(['conversation_id']);
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

const SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT = `
SELECT cl.id::text AS client_id, cl.slug AS client_slug,
  loc.id::text AS location_id, loc.location_id AS location_key,
  ep.id::text AS endpoint_id, c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_message_id, c.channel,
  ev.provider, ev.provider_mailbox_id AS provider_mailbox_id,
  ep.provider_resource_id AS endpoint_provider_mailbox_id, ev.location_id::text AS event_location_id,
  COALESCE(ev.subject,'') AS subject, COALESCE(ev.body_text,'') AS body_text,
  ''::text AS quoted_history, COALESCE(ev.from_display_name,'') AS from_display_name,
  COALESCE(ev.from_address,'') AS from_address, c.deleted_at AS conversation_deleted_at,
  c.status AS conversation_status, p.inbound_event_id::text AS latest_message_id,
  TRUE AS luna_draft_enabled
FROM clients cl
INNER JOIN staff_users su ON su.client_id=cl.id AND su.id=$2::uuid AND su.status='active'
INNER JOIN conversations c ON c.client_id=cl.id AND c.id=$3::uuid AND c.deleted_at IS NULL AND c.channel='email'
INNER JOIN tenant_email_inbound_inbox_projections p ON p.client_id=c.client_id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
  AND ev.location_id=p.location_id AND ev.endpoint_id=p.endpoint_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.location_id=loc.location_id AND ep.channel='email'
  AND ev.provider_mailbox_id=ep.provider_resource_id
WHERE cl.id=$1::uuid AND cl.slug='sunset' AND loc.location_id='sunset-somo'
ORDER BY ev.received_at DESC, ev.id DESC LIMIT 1`.replace(/\s+/g, ' ').trim();

function ownData(value, key) {
  try { const d = getDescriptor(value, key); return d && hasOwn(d, 'value') && d.enumerable && !d.get && !d.set ? d.value : undefined; }
  catch { return undefined; }
}
function exactRecord(value, keys) {
  try {
    if (!value || typeof value !== 'object' || isArray(value) || isProxy(value) || getPrototypeOf(value) !== Object.prototype) return false;
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
  if (!user || typeof user !== 'object' || user.status !== 'active' || user.client_slug !== 'sunset') return null;
  const staffId = uuid(user.staff_user_id); const clientId = uuid(user.client_id);
  return staffId && clientId && ['operator', 'admin', 'owner'].includes(user.role)
    ? freeze({ staff_user_id: staffId, client_id: clientId, role: user.role }) : null;
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
    if (!row || typeof row !== 'object') return null;
    const authority = {
      client_id: uuid(row.client_id), location_id: uuid(row.location_id), location_key: row.location_key,
      conversation_id: uuid(row.conversation_id), endpoint_id: uuid(row.endpoint_id), inbound_message_id: uuid(row.inbound_message_id),
    };
    if (!authority.client_id || authority.client_id !== expectedActor.client_id || authority.conversation_id !== conversationId
      || !authority.location_id || authority.location_key !== 'sunset-somo' || !authority.endpoint_id || !authority.inbound_message_id
      || row.client_slug !== 'sunset' || row.channel !== 'email' || row.provider !== 'microsoft_graph'
      || row.conversation_deleted_at != null || row.conversation_status !== 'active'
      || uuid(row.latest_message_id) !== authority.inbound_message_id || row.luna_draft_enabled !== true
      || uuid(row.event_location_id) !== authority.location_id
      || uuid(row.endpoint_provider_mailbox_id) !== uuid(row.provider_mailbox_id)) return null;
    return freeze({ authority: freeze(authority), row });
  } catch { return null; }
}
function isSafeReady(result, authority) {
  try {
    return result && typeof result === 'object' && result.status === 'draft_ready'
      && result.client_id === authority.client_id && result.location_id === authority.location_id
      && result.conversation_id === authority.conversation_id && result.draft_only === true
      && result.requires_staff_review === true && result.send_allowed === false && result.auto_send_allowed === false
      && typeof result.body === 'string' && result.body.length > 0 && Buffer.byteLength(result.body, 'utf8') <= 8000;
  } catch { return false; }
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
    try {
      const r = context.row;
      const envelope = createEmailLunaDraftEnvelope({ authority: context.authority, untrusted_content: {
        subject: String(r.subject || ''), body_text: String(r.body_text || ''), quoted_history: String(r.quoted_history || ''),
        from_display_name: String(r.from_display_name || ''), from_address: String(r.from_address || ''),
      } });
      // Classification and grounded-tool outputs are server-owned. The merged runtime
      // revalidates authentic provenance before any model call; no request authority is forwarded.
      const evidence = freeze({ source: 'staff_email_authoritative_reload' });
      const decision = freeze({ source: 'server_policy' });
      const runtime = deps.createLunaRuntime({ env: deps.runtimeEnv || process.env, authority: context.authority,
        tenant_location_gate: freeze({ client_id: context.authority.client_id, location_id: context.authority.location_id,
          location_key: context.authority.location_key, draft_enabled: true }) });
      const generated = await runtime.authorDraft({ envelope, evidence, decision });
      if (generated && generated.status === 'handoff_required')
        return deps.sendJSON(res, 422, freeze({ success: false, error: 'luna_handoff_required', reason: typeof generated.reason === 'string' ? generated.reason : 'unsupported_request' }));
      if (!isSafeReady(generated, context.authority)) return deps.sendJSON(res, 503, freeze({ success: false, error: 'luna_draft_unavailable' }));
      const saved = await deps.saveDraftThroughStaffOwner({ actor: a, conversation_id: input.conversation_id,
        message_text: generated.body, approval_id: null });
      if (!saved || saved.success !== true || saved.conversation_id !== input.conversation_id || saved.message_text !== generated.body)
        return deps.sendJSON(res, 503, freeze({ success: false, error: 'luna_draft_unavailable' }));
      return deps.sendJSON(res, 200, freeze({ success: true, conversation_id: saved.conversation_id,
        message_text: saved.message_text, approval_id: saved.approval_id }));
    } catch {
      return deps.sendJSON(res, 503, freeze({ success: false, error: 'luna_draft_unavailable' }));
    }
  }
  route = { handleGenerateLunaDraft, runtimeEnv: deps.runtimeEnv || process.env, withPgClient: deps.withPgClient };
  // The handler resolves this property at call time for the established offline
  // router probe; production wiring never mutates it.
  return route;
}
module.exports = { createStaffEmailLunaDraftRoute, EMAIL_LUNA_GENERATE_DRAFT_PATH,
  EMAIL_LUNA_GENERATE_DRAFT_ENABLED_ENV, EMAIL_LUNA_GENERATE_BODY_KEYS,
  SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT, snapshotEmailLunaGenerateBody,
  snapshotEmailLunaGenerateGateEnv, isEmailLunaGenerateDraftEnabled };
