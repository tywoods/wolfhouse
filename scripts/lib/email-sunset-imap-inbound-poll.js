'use strict';

/**
 * Bounded Sunset IMAP INBOX poll after verified durable IMAP health.
 * Normalized envelopes enter the existing MATCH / event-store / inbox-bridge
 * path. No SMTP send. No parallel Inbox model.
 *
 * Cursor occupancy uses a durable lease (owner + token + expiry) so concurrent
 * replicas cannot share a cursor or regress last_uid. The lease is claimed and
 * released in short DB statements; the IMAP round-trip is not held inside a
 * transaction.
 *
 * @module email-sunset-imap-inbound-poll
 */

const crypto = require('node:crypto');
const contract = require('./email-sunset-imap-secret-ref-contract');
const {
  createSunsetImapImapsTransport,
  IMAP_FETCH_MAX_MESSAGES,
  parseRfcUidvalidity,
  parseRfcLastUid,
} = require('./email-sunset-imap-imaps-transport');
const { mapImapFetchedMessageToInboundEnvelope } = require('./email-imap-inbound-envelope-mapper');
const { createInboundEmailEventStore } = require('./email-inbound-event-store');
const { createEmailInboundInboxBridge } = require('./email-inbound-inbox-bridge');
const {
  resolveInboundMatchConversationIdentity,
} = require('./email-inbound-match-ingest');

const IMAP_LEASE_TTL_SECONDS = 60;
const IMAP_LEASE_OWNER_DEFAULT = 'sunset-imap-poll';
const IMAP_LEASE_OWNER_MAX = 128;
const PINNED_RANDOM_UUID = crypto.randomUUID.bind(crypto);

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
const SQL_DISCOVER = `SELECT e.id::text AS id, e.client_id::text AS client_id, e.public_address,
 e.inbound_enabled, e.outbound_enabled, e.active, e.default_automation_mode,
 e.imap_health_verified_at, tl.id::text AS location_uuid, e.location_id AS location_key
 FROM tenant_channel_endpoints e
 JOIN clients c ON c.id=e.client_id
 JOIN tenant_locations tl ON tl.client_id=e.client_id AND tl.location_id=e.location_id
 WHERE e.provider='imap_smtp'
   AND c.slug='sunset'
   AND e.imap_health_verified_at IS NOT NULL
   AND e.outbound_enabled=FALSE
   AND e.active=FALSE AND e.default_automation_mode='off'
 LIMIT 2`.replace(/\s+/g, ' ').trim();

const SQL_CLAIM = `INSERT INTO tenant_email_imap_fetch_cursors
 (client_id, location_id, endpoint_id, mailbox, uidvalidity, last_uid, lease_owner, lease_token, lease_until, updated_at)
 VALUES ($1::uuid, $2::uuid, $3::uuid, 'INBOX', 1, 0, $4, $5::uuid, clock_timestamp() + ($6::text || ' seconds')::interval, NOW())
 ON CONFLICT (client_id, endpoint_id, mailbox)
 DO UPDATE SET lease_owner = EXCLUDED.lease_owner, lease_token = EXCLUDED.lease_token, lease_until = EXCLUDED.lease_until, updated_at = NOW()
 WHERE tenant_email_imap_fetch_cursors.lease_token IS NULL
    OR tenant_email_imap_fetch_cursors.lease_until < clock_timestamp()
 RETURNING uidvalidity, last_uid, lease_owner, lease_token, lease_until`.replace(/\s+/g, ' ').trim();

const SQL_COMMIT_MONOTONIC = `UPDATE tenant_email_imap_fetch_cursors
 SET last_uid = $6, updated_at = NOW()
 WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND mailbox = 'INBOX'
   AND lease_owner = $3 AND lease_token = $4::uuid AND lease_until > clock_timestamp()
   AND uidvalidity = $5 AND last_uid <= $6
 RETURNING uidvalidity, last_uid`.replace(/\s+/g, ' ').trim();

const SQL_COMMIT_RESET = `UPDATE tenant_email_imap_fetch_cursors
 SET uidvalidity = $5, last_uid = $6, updated_at = NOW()
 WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND mailbox = 'INBOX'
   AND lease_owner = $3 AND lease_token = $4::uuid AND lease_until > clock_timestamp()
   AND uidvalidity <> $5
 RETURNING uidvalidity, last_uid`.replace(/\s+/g, ' ').trim();

const SQL_RELEASE = `UPDATE tenant_email_imap_fetch_cursors
 SET lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = NOW()
 WHERE client_id = $1::uuid AND endpoint_id = $2::uuid AND mailbox = 'INBOX'
   AND lease_owner = $3 AND lease_token = $4::uuid
 RETURNING mailbox`.replace(/\s+/g, ' ').trim();

const SQL_CLAIM_PARAMS = Object.freeze({
  clientId: 1,
  locationId: 2,
  endpointId: 3,
  leaseOwner: 4,
  leaseToken: 5,
  ttlSeconds: 6,
});
const SQL_COMMIT_PARAMS = Object.freeze({
  clientId: 1,
  endpointId: 2,
  leaseOwner: 3,
  leaseToken: 4,
  uidvalidity: 5,
  lastUid: 6,
});
const SQL_RELEASE_PARAMS = Object.freeze({
  clientId: 1,
  endpointId: 2,
  leaseOwner: 3,
  leaseToken: 4,
});

function failure(kind, names) {
  const err = new Error('IMAP inbound poll failed.');
  Object.defineProperty(err, 'stack', { value: undefined });
  if (kind) Object.defineProperty(err, kind, { value: Object.freeze((names || []).slice()), enumerable: true });
  return Object.freeze(err);
}

function exactOneRow(result) {
  return !!(result
    && Array.isArray(result.rows)
    && result.rows.length === 1
    && result.rowCount === 1);
}

function validLeaseOwner(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length >= 1
    && value.length <= IMAP_LEASE_OWNER_MAX
    && !/[\s]/.test(value);
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
  const randomUUID = typeof (opts && opts.randomUUID) === 'function'
    ? opts.randomUUID
    : PINNED_RANDOM_UUID;
  const leaseOwner = opts && opts.leaseOwner != null ? opts.leaseOwner : IMAP_LEASE_OWNER_DEFAULT;
  const leaseTtlSeconds = opts && Number.isInteger(opts.leaseTtlSeconds)
    ? opts.leaseTtlSeconds
    : IMAP_LEASE_TTL_SECONDS;
  if (!validLeaseOwner(leaseOwner)
      || !Number.isInteger(leaseTtlSeconds)
      || leaseTtlSeconds < 1
      || leaseTtlSeconds > 120) {
    throw failure('failed_secret_names', []);
  }

  async function defaultPersist(authority, envelopes) {
    const store = createInboundEmailEventStore(Object.freeze({ withTransactionClient }));
    return store.persistBatch(authority, envelopes);
  }
  async function defaultProject(input) {
    const bridge = createEmailInboundInboxBridge(Object.freeze({ withTransactionClient }));
    return bridge.projectInboundEvent(input);
  }

  async function enableInboundAfterVerifiedImapHealth(input) {
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
  }

  async function pollVerifiedImapInbox(input) {
      if (!contract.isSunsetEmailImapPollEnabled(env)) throw failure('failed_secret_names', []);
      if (!input || !client || typeof client.query !== 'function' || !provider
          || typeof provider.resolveSecret !== 'function' || !transport
          || typeof transport.fetchInbox !== 'function') throw failure('failed_secret_names', []);
      const refs = contract.evaluateSunsetImapSecretRefs(env);
      if (!refs.ok) throw failure('missing_secret_names', refs.missing_secret_names);

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

      const leaseToken = randomUUID();
      if (typeof leaseToken !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) {
        throw failure('failed_secret_names', []);
      }
      const claimParams = [];
      claimParams[SQL_CLAIM_PARAMS.clientId - 1] = input.clientId;
      claimParams[SQL_CLAIM_PARAMS.locationId - 1] = row.location_uuid;
      claimParams[SQL_CLAIM_PARAMS.endpointId - 1] = String(row.id);
      claimParams[SQL_CLAIM_PARAMS.leaseOwner - 1] = leaseOwner;
      claimParams[SQL_CLAIM_PARAMS.leaseToken - 1] = leaseToken;
      claimParams[SQL_CLAIM_PARAMS.ttlSeconds - 1] = String(leaseTtlSeconds);
      const claimed = await client.query(SQL_CLAIM, claimParams);
      if (!exactOneRow(claimed)) throw failure('failed_secret_names', []);
      const held = claimed.rows[0];
      if (String(held.lease_owner) !== leaseOwner || String(held.lease_token) !== leaseToken) {
        throw failure('failed_secret_names', []);
      }
      const claimedUidvalidity = parseRfcUidvalidity(held.uidvalidity);
      const claimedLastUid = parseRfcLastUid(held.last_uid);
      if (claimedUidvalidity == null || claimedLastUid == null) {
        await client.query(SQL_RELEASE, [input.clientId, String(row.id), leaseOwner, leaseToken]).catch(() => {});
        throw failure('failed_secret_names', []);
      }

      let releaseNeeded = true;
      try {
        const fetched = await transport.fetchInbox(Object.freeze({
          host: values[0], port, tlsMode: values[2], username: values[3], password: values[4],
        }), Object.freeze({
          uidvalidity: claimedUidvalidity,
          last_uid: claimedLastUid,
        }));
        if (!fetched || fetched.ok !== true) {
          const names = fetched && Array.isArray(fetched.failed_secret_names)
            ? fetched.failed_secret_names.filter((name) => contract.SUNSET_IMAP_SECRET_NAMES.includes(name)) : [];
          throw failure('failed_secret_names', names);
        }
        const fetchedUidvalidity = parseRfcUidvalidity(fetched.uidvalidity);
        const fetchedLastUid = parseRfcLastUid(fetched.last_uid);
        if (fetchedUidvalidity == null || fetchedLastUid == null) {
          throw failure('failed_secret_names', []);
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
            const projected = await project(Object.freeze({
              clientId: authority.clientId,
              locationId: authority.locationId,
              endpointId: authority.endpointId,
              provider: envelopes[i].provider,
              providerMailboxId: envelopes[i].provider_mailbox_id,
              providerMessageId: envelopes[i].provider_message_id,
            }));
            if (!projected
                || (projected.status !== 'projected' && projected.status !== 'already_projected')) {
              throw failure('failed_secret_names', []);
            }
          }
        }

        const commitParams = [];
        commitParams[SQL_COMMIT_PARAMS.clientId - 1] = input.clientId;
        commitParams[SQL_COMMIT_PARAMS.endpointId - 1] = String(row.id);
        commitParams[SQL_COMMIT_PARAMS.leaseOwner - 1] = leaseOwner;
        commitParams[SQL_COMMIT_PARAMS.leaseToken - 1] = leaseToken;
        commitParams[SQL_COMMIT_PARAMS.uidvalidity - 1] = fetchedUidvalidity;
        commitParams[SQL_COMMIT_PARAMS.lastUid - 1] = fetchedLastUid;
        if (fetchedUidvalidity !== claimedUidvalidity) {
          const reset = await client.query(SQL_COMMIT_RESET, commitParams);
          if (!exactOneRow(reset)) throw failure('failed_secret_names', []);
        } else if (fetchedLastUid > claimedLastUid) {
          const advanced = await client.query(SQL_COMMIT_MONOTONIC, commitParams);
          if (!exactOneRow(advanced)) throw failure('failed_secret_names', []);
        } else if (fetchedLastUid < claimedLastUid) {
          throw failure('failed_secret_names', []);
        }

        const released = await client.query(SQL_RELEASE, [
          input.clientId, String(row.id), leaseOwner, leaseToken,
        ]);
        if (!exactOneRow(released)) throw failure('failed_secret_names', []);
        releaseNeeded = false;
        return Object.freeze({ ok: true, fetched: envelopes.length });
      } finally {
        if (releaseNeeded) {
          try {
            await client.query(SQL_RELEASE, [input.clientId, String(row.id), leaseOwner, leaseToken]);
          } catch (_) { /* best-effort conditional release */ }
        }
      }
    }

  async function pollEligibleSunsetImapInbox() {
    if (!contract.isSunsetEmailImapPollEnabled(env)) throw failure('failed_secret_names', []);
    if (!client || typeof client.query !== 'function') throw failure('failed_secret_names', []);
    const found = await client.query(SQL_DISCOVER, []);
    if (!found || !Array.isArray(found.rows) || found.rows.length !== 1) {
      return Object.freeze({ ok: false, status: 'ineligible', fetched: 0 });
    }
    const row = found.rows[0];
    if (row.imap_health_verified_at == null) {
      return Object.freeze({ ok: false, status: 'ineligible', fetched: 0 });
    }
    const clientId = String(row.client_id);
    const locationId = String(row.location_key);
    if (row.inbound_enabled !== true) {
      if (!contract.isSunsetEmailImapInboundEnabled(env)) {
        return Object.freeze({ ok: false, status: 'ineligible', fetched: 0 });
      }
      await enableInboundAfterVerifiedImapHealth(Object.freeze({ clientId, locationId }));
    }
    return pollVerifiedImapInbox(Object.freeze({ clientId, locationId }));
  }

  return Object.freeze({
    enableInboundAfterVerifiedImapHealth,
    pollVerifiedImapInbox,
    pollEligibleSunsetImapInbox,
  });
}

module.exports = Object.freeze({
  IMAP_FETCH_MAX_MESSAGES,
  IMAP_LEASE_TTL_SECONDS,
  IMAP_LEASE_OWNER_DEFAULT,
  SQL_ELIGIBLE,
  SQL_ENABLE_INBOUND,
  SQL_DISCOVER,
  SQL_CLAIM,
  SQL_COMMIT_MONOTONIC,
  SQL_COMMIT_RESET,
  SQL_RELEASE,
  SQL_CLAIM_PARAMS,
  SQL_COMMIT_PARAMS,
  SQL_RELEASE_PARAMS,
  createSunsetImapInboundPoll,
});
