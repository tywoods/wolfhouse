'use strict';

/**
 * Bounded Sunset IMAP INBOX poll after verified durable IMAP health.
 * Normalized envelopes enter the existing MATCH / event-store / inbox-bridge
 * path. No SMTP send. No parallel Inbox model.
 *
 * @module email-sunset-imap-inbound-poll
 */

const contract = require('./email-sunset-imap-secret-ref-contract');
const { createSunsetImapImapsTransport, IMAP_FETCH_MAX_MESSAGES } = require('./email-sunset-imap-imaps-transport');
const { mapImapFetchedMessageToInboundEnvelope } = require('./email-imap-inbound-envelope-mapper');
const { createInboundEmailEventStore } = require('./email-inbound-event-store');
const { createEmailInboundInboxBridge } = require('./email-inbound-inbox-bridge');
const {
  resolveInboundMatchConversationIdentity,
} = require('./email-inbound-match-ingest');

const SQL_ADVISORY = 'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))';
const SQL_ELIGIBLE = `SELECT e.id::text AS id, e.public_address, e.inbound_enabled, e.outbound_enabled,
 e.active, e.default_automation_mode, e.imap_health_verified_at, tl.id::text AS location_uuid
 FROM tenant_channel_endpoints e
 JOIN clients c ON c.id=e.client_id
 JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id
 WHERE e.client_id=$1::uuid AND e.location_id=$2 AND e.provider='imap_smtp'
   AND c.slug='sunset'
   AND e.imap_health_verified_at IS NOT NULL
   AND e.inbound_enabled=TRUE AND e.outbound_enabled=FALSE
   AND e.active=FALSE AND e.default_automation_mode='off'
 LIMIT 2`.replace(/\s+/g, ' ').trim();
const SQL_ENABLE_INBOUND = `UPDATE tenant_channel_endpoints
 SET inbound_enabled=TRUE, updated_at=NOW()
 WHERE id=$1::uuid AND client_id=$2::uuid AND location_id=$3 AND provider='imap_smtp'
   AND imap_health_verified_at IS NOT NULL
   AND inbound_enabled=FALSE AND outbound_enabled=FALSE
   AND active=FALSE AND default_automation_mode='off'
 RETURNING id::text, inbound_enabled`.replace(/\s+/g, ' ').trim();
const SQL_ENDPOINT_FOR_ENABLE = `SELECT id::text, imap_health_verified_at, inbound_enabled, outbound_enabled,
 active, default_automation_mode FROM tenant_channel_endpoints
 WHERE client_id=$1::uuid AND location_id=$2 AND provider='imap_smtp' LIMIT 2`.replace(/\s+/g, ' ').trim();
const SQL_READ_CURSOR = `SELECT uidvalidity, last_uid FROM tenant_email_imap_fetch_cursors
 WHERE client_id=$1::uuid AND endpoint_id=$2::uuid AND mailbox='INBOX' LIMIT 1`.replace(/\s+/g, ' ').trim();
const SQL_UPSERT_CURSOR = `INSERT INTO tenant_email_imap_fetch_cursors
 (client_id, location_id, endpoint_id, mailbox, uidvalidity, last_uid, updated_at)
 VALUES ($1::uuid, $2::uuid, $3::uuid, 'INBOX', $4, $5, NOW())
 ON CONFLICT (client_id, endpoint_id, mailbox)
 DO UPDATE SET uidvalidity=EXCLUDED.uidvalidity, last_uid=EXCLUDED.last_uid, updated_at=NOW()`.replace(/\s+/g, ' ').trim();

function failure(kind, names) {
  const err = new Error('IMAP inbound poll failed.');
  Object.defineProperty(err, 'stack', { value: undefined });
  if (kind) Object.defineProperty(err, kind, { value: Object.freeze((names || []).slice()), enumerable: true });
  return Object.freeze(err);
}

function createSunsetImapInboundPoll(opts) {
  const client = opts && opts.client;
  const env = opts && opts.env;
  const provider = opts && opts.secretProvider;
  const transport = opts && opts.imapTransport ? opts.imapTransport : createSunsetImapImapsTransport();
  const persistEnvelopes = typeof (opts && opts.persistEnvelopes) === 'function'
    ? opts.persistEnvelopes
    : null;
  const projectEvent = typeof (opts && opts.projectEvent) === 'function'
    ? opts.projectEvent
    : null;
  const withTransactionClient = typeof (opts && opts.withTransactionClient) === 'function'
    ? opts.withTransactionClient
    : async (work) => work(client);

  async function defaultPersist(authority, envelopes) {
    const store = createInboundEmailEventStore(Object.freeze({ withTransactionClient }));
    return store.persistBatch(authority, envelopes);
  }
  async function defaultProject(input) {
    const bridge = createEmailInboundInboxBridge(Object.freeze({ withTransactionClient }));
    return bridge.projectInboundEvent(input);
  }

  return Object.freeze({
    async enableInboundAfterVerifiedImapHealth(input) {
      if (!contract.isSunsetEmailImapInboundEnabled(env)) throw failure('failed_secret_names', []);
      if (!input || !client || typeof client.query !== 'function') throw failure('failed_secret_names', []);
      const found = await client.query(SQL_ENDPOINT_FOR_ENABLE, [input.clientId, input.locationId]);
      if (!found || !Array.isArray(found.rows) || found.rows.length !== 1
          || found.rows[0].imap_health_verified_at == null) {
        throw failure('failed_secret_names', []);
      }
      const row = found.rows[0];
      const marked = await client.query(SQL_ENABLE_INBOUND, [String(row.id), input.clientId, input.locationId]);
      if (!marked || !Array.isArray(marked.rows) || marked.rows.length !== 1) {
        throw failure('failed_secret_names', []);
      }
      return Object.freeze({ inbound_enabled: true, endpointId: String(row.id) });
    },

    async pollVerifiedImapInbox(input) {
      if (!contract.isSunsetEmailImapPollEnabled(env)) throw failure('failed_secret_names', []);
      if (!input || !client || typeof client.query !== 'function' || !provider
          || typeof provider.resolveSecret !== 'function' || !transport
          || typeof transport.fetchInbox !== 'function') throw failure('failed_secret_names', []);
      const refs = contract.evaluateSunsetImapSecretRefs(env);
      if (!refs.ok) throw failure('missing_secret_names', refs.missing_secret_names);

      await client.query(SQL_ADVISORY, ['imap-poll', `${input.clientId}:${input.locationId}`]);
      const found = await client.query(SQL_ELIGIBLE, [input.clientId, input.locationId]);
      if (!found || !Array.isArray(found.rows) || found.rows.length !== 1) {
        throw failure('failed_secret_names', []);
      }
      const row = found.rows[0];
      if (row.imap_health_verified_at == null || row.inbound_enabled !== true) {
        throw failure('failed_secret_names', []);
      }

      const values = [];
      for (let i = 0; i < refs.secret_refs.length; i += 1) {
        try {
          const value = await provider.resolveSecret(refs.secret_refs[i]);
          if (typeof value !== 'string' || value.length === 0) throw new Error('empty');
          values.push(value);
        } catch (_) {
          throw failure('failed_secret_names', [contract.SUNSET_IMAP_SECRET_NAMES[i]]);
        }
      }
      const port = Number(values[1]);
      if (!Number.isInteger(port) || port !== 993) throw failure('failed_secret_names', ['sunset-imap-port']);
      if (values[2] !== 'imaps') throw failure('failed_secret_names', ['sunset-imap-tls-mode']);

      const cursorRows = await client.query(SQL_READ_CURSOR, [input.clientId, String(row.id)]);
      const existing = cursorRows && cursorRows.rows && cursorRows.rows[0]
        ? cursorRows.rows[0]
        : null;
      const cursor = Object.freeze({
        uidvalidity: existing && existing.uidvalidity != null ? Number(existing.uidvalidity) : null,
        last_uid: existing && existing.last_uid != null ? Number(existing.last_uid) : 0,
      });

      const fetched = await transport.fetchInbox(Object.freeze({
        host: values[0], port, tlsMode: values[2], username: values[3], password: values[4],
      }), cursor);
      if (!fetched || fetched.ok !== true) {
        const names = fetched && Array.isArray(fetched.failed_secret_names)
          ? fetched.failed_secret_names.filter((name) => contract.SUNSET_IMAP_SECRET_NAMES.includes(name)) : [];
        throw failure('failed_secret_names', names);
      }
      const rawMessages = Array.isArray(fetched.messages) ? fetched.messages.slice(0, IMAP_FETCH_MAX_MESSAGES) : [];
      const envelopes = [];
      for (let i = 0; i < rawMessages.length; i += 1) {
        const mapped = mapImapFetchedMessageToInboundEnvelope(Object.freeze({
          mailbox: String(row.public_address),
          message: rawMessages[i],
        }));
        if (!mapped.ok) throw failure('failed_secret_names', []);
        const identity = resolveInboundMatchConversationIdentity(Object.freeze({
          providerMailboxId: mapped.value.provider_mailbox_id,
          fromAddress: mapped.value.sender_address,
        }));
        if (!identity) throw failure('failed_secret_names', []);
        envelopes.push(mapped.value);
      }

      const authority = Object.freeze({
        clientId: String(input.clientId),
        locationId: String(row.location_uuid),
        endpointId: String(row.id),
      });
      if (envelopes.length > 0) {
        const persist = persistEnvelopes || defaultPersist;
        const persisted = await persist(authority, envelopes);
        if (!persisted || persisted.ok !== true) throw failure('failed_secret_names', []);
        const project = projectEvent || defaultProject;
        for (let i = 0; i < envelopes.length; i += 1) {
          await project(Object.freeze({
            clientId: authority.clientId,
            locationId: authority.locationId,
            endpointId: authority.endpointId,
            provider: envelopes[i].provider,
            providerMailboxId: envelopes[i].provider_mailbox_id,
            providerMessageId: envelopes[i].provider_message_id,
          }));
        }
      }

      if (Number.isInteger(fetched.uidvalidity) && fetched.uidvalidity > 0) {
        await client.query(SQL_UPSERT_CURSOR, [
          input.clientId,
          row.location_uuid,
          String(row.id),
          fetched.uidvalidity,
          Number.isInteger(fetched.last_uid) ? fetched.last_uid : 0,
        ]);
      }
      return Object.freeze({ ok: true, fetched: envelopes.length });
    },
  });
}

module.exports = Object.freeze({
  IMAP_FETCH_MAX_MESSAGES,
  SQL_ELIGIBLE,
  SQL_ENABLE_INBOUND,
  createSunsetImapInboundPoll,
});
