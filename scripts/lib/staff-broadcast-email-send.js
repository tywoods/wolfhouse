/**
 * Phase 4 broadcast Graph send — reuses the existing Microsoft Graph
 * reply-draft transport's sendMail (same issueGraphRequest, host, token pins)
 * and the same delegated grant access session as approve-send.
 *
 * Not a second Microsoft client. Does not call the reply-draft create/send
 * path and never invents a source-message id.
 *
 * Construction is fail-closed: missing composition / mailbox / session →
 * null helper (caller must not treat that as HTTP 200 sent).
 *
 * @module staff-broadcast-email-send
 */

'use strict';

const {
  createMicrosoftGraphReplyDraftTransport,
} = require('./email-microsoft-graph-reply-draft-transport');
const {
  createDelegatedGrantAccessSession,
} = require('./email-delegated-grant-access-session');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
  SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const {
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  isEmailOutboundRuntimeCompositionEnabled,
} = require('./email-outbound-sunset-staging-runtime-composition');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SQL_RESOLVE_BROADCAST_MAILBOX = `
SELECT cl.id::text AS client_id,
       ep.id::text AS endpoint_id,
       ep.provider_resource_id AS provider_mailbox_id
  FROM clients cl
 INNER JOIN tenant_channel_endpoints ep ON ep.client_id = cl.id
 WHERE cl.id = $1::uuid
   AND ep.provider = 'microsoft_graph'
   AND ep.channel = 'email'
   AND ep.auth_mode = 'delegated_authorization_code'
   AND ep.connector_mode = 'microsoft_delegated_oauth'
   AND ep.mailbox_access_kind = 'own_user'
   AND ep.binding_status = 'verified'
   AND ep.outbound_enabled = true
   AND ep.provider_resource_id IS NOT NULL
   AND btrim(ep.provider_resource_id) <> ''
   AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ORDER BY ep.updated_at DESC, ep.id DESC
 LIMIT 1
`.replace(/\s+/g, ' ').trim();

function ownData(o, k) {
  try {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return UUID_RE.test(t) ? t : null;
}

function snapshotCompositionReadiness(env) {
  try {
    if (!isEmailOutboundRuntimeCompositionEnabled(env)) return null;
    const appId = ownData(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    const kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    if (!kv.ok || kv.composition_enabled !== true) return null;
    return Object.freeze({ env, applicationClientId: appId.toLowerCase() });
  } catch {
    return null;
  }
}

async function resolveBroadcastMailbox(pg, clientId) {
  const id = parseUuid(clientId);
  if (!id || !pg || typeof pg.query !== 'function') return null;
  const result = await pg.query(SQL_RESOLVE_BROADCAST_MAILBOX, [id]);
  const row = result && result.rows && result.rows[0];
  if (!row) return null;
  const mailbox = parseUuid(row.provider_mailbox_id);
  const endpointId = parseUuid(row.endpoint_id);
  const resolvedClientId = parseUuid(row.client_id);
  if (!mailbox || !endpointId || !resolvedClientId) return null;
  return Object.freeze({
    clientId: resolvedClientId,
    endpointId,
    providerMailboxId: mailbox,
  });
}

/**
 * Build a batch sendMail helper, or null when Graph/session cannot be constructed.
 * The returned function reports invokedGraph:true only after transport.sendMail runs.
 *
 * @param {{ pgClient: object, env: object, https: object, timers: object }} deps
 * @returns {null | function(object): Promise<object>}
 */
function createBroadcastEmailSendMail(deps) {
  try {
    if (!deps || typeof deps !== 'object') return null;
    if (SECRET_SUNSET !== SUNSET_DEPLOYMENT) return null;
    const env = deps.env;
    const pgClient = deps.pgClient;
    const ready = snapshotCompositionReadiness(env);
    if (!ready) return null;
    if (!pgClient || typeof pgClient.query !== 'function') return null;
    const httpsImpl = deps.https;
    const timers = deps.timers;
    if (!httpsImpl || typeof httpsImpl.request !== 'function') return null;
    if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
      return null;
    }
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(ready.env);
    if (!composition || composition.ok !== true || composition.composition_enabled !== true || !composition.provider) {
      return null;
    }
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) return null;
    const tokenTransport = createMicrosoftTokenHttpTransport(Object.freeze({
      httpsImpl,
      timers,
    }));
    const graphTransport = createMicrosoftGraphReplyDraftTransport(Object.freeze({
      httpsImpl: httpsImpl.request,
      timers,
    }));
    if (!graphTransport || typeof graphTransport.sendMail !== 'function') return null;
    const applicationClientId = ready.applicationClientId;
    const envelopeProvider = prov.value;
    const readyEnv = ready.env;

    return async function sendBroadcastEmail(batch) {
      const recipients = batch && Array.isArray(batch.recipients) ? batch.recipients : [];
      const subject = batch && typeof batch.subject === 'string' ? batch.subject : '';
      const body = batch && typeof batch.body === 'string' ? batch.body : '';
      const mailbox = await resolveBroadcastMailbox(pgClient, batch && batch.clientId);
      if (!mailbox || !recipients.length || !subject || !body) {
        return Object.freeze({
          ok: false,
          invokedGraph: false,
          error: 'email_broadcast_send_unavailable',
          results: Object.freeze([]),
        });
      }

      let session;
      try {
        session = createDelegatedGrantAccessSession(Object.freeze({
          deployment: SUNSET_DEPLOYMENT,
          applicationClientId,
          client: pgClient,
          envelopeProvider,
          secretProvider: createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({
            deployment: SUNSET_DEPLOYMENT,
            env: readyEnv,
          })),
          transport: tokenTransport,
          workerId: WORKER_ID,
        }));
      } catch {
        return Object.freeze({
          ok: false,
          invokedGraph: false,
          error: 'email_broadcast_send_unavailable',
          results: Object.freeze([]),
        });
      }

      const results = [];
      let invokedGraph = false;
      try {
        const sessionOut = await session.runWithAccessTokenOnce(
          Object.freeze({ clientId: mailbox.clientId, endpointId: mailbox.endpointId }),
          async (loan) => {
            const token = loan && typeof loan.accessToken === 'string' ? loan.accessToken : '';
            if (!token) return;
            for (const rec of recipients) {
              const phone = rec && rec.phone ? String(rec.phone) : '';
              const to = rec && rec.email ? String(rec.email) : '';
              try {
                invokedGraph = true;
                const sent = await graphTransport.sendMail({
                  accessToken: token,
                  provider_mailbox_id: mailbox.providerMailboxId,
                  to,
                  subject,
                  body_content_type: 'Text',
                  body_content: body,
                });
                results.push({
                  phone,
                  ok: !!(sent && sent.outcome === 'send_accepted'),
                });
              } catch {
                results.push({ phone, ok: false });
              }
            }
          },
        );
        if (!invokedGraph || !sessionOut || sessionOut.ok !== true) {
          return Object.freeze({
            ok: false,
            invokedGraph: invokedGraph === true,
            error: 'email_broadcast_send_unavailable',
            results: Object.freeze(results.slice()),
          });
        }
      } catch {
        return Object.freeze({
          ok: false,
          invokedGraph: invokedGraph === true,
          error: 'email_broadcast_send_unavailable',
          results: Object.freeze(results.slice()),
        });
      }

      return Object.freeze({
        ok: true,
        invokedGraph: true,
        results: Object.freeze(results.slice()),
      });
    };
  } catch {
    return null;
  }
}

module.exports = {
  SQL_RESOLVE_BROADCAST_MAILBOX,
  resolveBroadcastMailbox,
  createBroadcastEmailSendMail,
};
