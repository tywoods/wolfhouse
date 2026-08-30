'use strict';

/**
 * SAME-DESK-004 dedicated durable auto-send claim owner.
 *
 * Exactly one winner per (client_id, conversation_id, source_inbound_event_id).
 * Ownership is a bounded lease identified by lease_token + lease_epoch (CAS).
 * Pre-dispatch failure (author/save/gate) is retry-safe: release or expire,
 * then reclaim. Once provider invocation may have begun (state=dispatching),
 * never release or retry. Generic staff/SMTP approvals are out of scope.
 */

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freeze = Object.freeze;

const SAME_DESK_AUTO_SEND_LEASE_MS = 30_000;
const SAME_DESK_AUTO_PROVENANCE = 'same_desk_004_auto';

const SQL_INSERT_CLAIM = `
INSERT INTO tenant_email_same_desk_auto_send_claims (
  claim_id, client_id, conversation_id, source_inbound_event_id,
  claimant_staff_user_id, state, lease_token, lease_epoch,
  lease_expires_at, auto_provenance, claimed_at
) VALUES (
  $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
  'leased', $6::uuid, 1, $7::timestamptz, 'same_desk_004_auto', $8::timestamptz
)
ON CONFLICT (client_id, conversation_id, source_inbound_event_id)
DO UPDATE SET
  claimant_staff_user_id = EXCLUDED.claimant_staff_user_id,
  state = 'leased',
  lease_token = EXCLUDED.lease_token,
  lease_epoch = tenant_email_same_desk_auto_send_claims.lease_epoch + 1,
  lease_expires_at = EXCLUDED.lease_expires_at,
  approval_id = NULL,
  operation_id = NULL,
  linked_at = NULL,
  dispatching_at = NULL,
  released_at = NULL,
  claimed_at = EXCLUDED.claimed_at
WHERE
  tenant_email_same_desk_auto_send_claims.state = 'released'
  OR (
    tenant_email_same_desk_auto_send_claims.state IN ('leased', 'linked')
    AND tenant_email_same_desk_auto_send_claims.lease_expires_at <= EXCLUDED.claimed_at
  )
RETURNING claim_id::text AS claim_id, state,
  lease_token::text AS lease_token, lease_epoch::bigint AS lease_epoch,
  approval_id::text AS approval_id, operation_id::text AS operation_id,
  auto_provenance
`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_CLAIM = `
SELECT claim_id::text AS claim_id, state,
  lease_token::text AS lease_token, lease_epoch::bigint AS lease_epoch,
  approval_id::text AS approval_id, operation_id::text AS operation_id,
  claimant_staff_user_id::text AS claimant_staff_user_id,
  auto_provenance, lease_expires_at
FROM tenant_email_same_desk_auto_send_claims
WHERE client_id=$1::uuid AND conversation_id=$2::uuid AND source_inbound_event_id=$3::uuid
`.replace(/\s+/g, ' ').trim();

const SQL_LINK_APPROVAL = `
UPDATE tenant_email_same_desk_auto_send_claims
   SET approval_id=$4::uuid,
       operation_id=COALESCE($5::uuid, operation_id),
       state='linked',
       linked_at=$6::timestamptz
 WHERE claim_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
   AND lease_token=$7::uuid AND lease_epoch=$8::bigint
   AND state='leased' AND approval_id IS NULL
   AND auto_provenance='same_desk_004_auto'
   AND lease_expires_at > $6::timestamptz
 RETURNING claim_id::text AS claim_id, approval_id::text AS approval_id, state,
   lease_token::text AS lease_token, lease_epoch::bigint AS lease_epoch,
   auto_provenance
`.replace(/\s+/g, ' ').trim();

const SQL_RELEASE_CLAIM = `
UPDATE tenant_email_same_desk_auto_send_claims
   SET state='released',
       released_at=$4::timestamptz,
       lease_expires_at=$4::timestamptz
 WHERE claim_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
   AND lease_token=$5::uuid AND lease_epoch=$6::bigint
   AND state IN ('leased', 'linked')
 RETURNING claim_id::text AS claim_id, state, lease_token::text AS lease_token,
   lease_epoch::bigint AS lease_epoch
`.replace(/\s+/g, ' ').trim();

const SQL_BEGIN_DISPATCH = `
UPDATE tenant_email_same_desk_auto_send_claims
   SET state='dispatching',
       dispatching_at=$4::timestamptz
 WHERE claim_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
   AND lease_token=$5::uuid AND lease_epoch=$6::bigint
   AND state='linked' AND approval_id IS NOT NULL
   AND auto_provenance='same_desk_004_auto'
   AND lease_expires_at > $4::timestamptz
 RETURNING claim_id::text AS claim_id, approval_id::text AS approval_id, state,
   lease_token::text AS lease_token, lease_epoch::bigint AS lease_epoch,
   auto_provenance
`.replace(/\s+/g, ' ').trim();

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function asDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function createSameDeskAutoSendClaimOwner(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') {
    throw new Error('same_desk_auto_send_claim_deps');
  }
  const withPgClient = deps.withPgClient;
  const nowFn = typeof deps.now === 'function' ? deps.now : () => new Date();
  const leaseMs = Number.isFinite(deps.leaseMs) && deps.leaseMs > 0
    ? deps.leaseMs
    : SAME_DESK_AUTO_SEND_LEASE_MS;

  function readNow(input) {
    const fromInput = asDate(input && input.now);
    if (fromInput) return fromInput;
    const fromClock = asDate(nowFn());
    if (fromClock) return fromClock;
    throw new Error('same_desk_auto_send_claim_clock');
  }

  async function claim(input) {
    const clientId = uuid(input && input.client_id);
    const conversationId = uuid(input && input.conversation_id);
    const inboundId = uuid(input && input.source_inbound_event_id);
    const actorId = uuid(input && input.claimant_staff_user_id);
    if (!clientId || !conversationId || !inboundId || !actorId) {
      return freeze({ status: 'lost', reason: 'invalid_claim_identity' });
    }
    const claimId = crypto.randomUUID();
    const leaseToken = crypto.randomUUID();
    const now = readNow(input);
    const expires = new Date(now.getTime() + leaseMs);
    try {
      const row = await withPgClient(async (pg) => {
        const ins = await pg.query(SQL_INSERT_CLAIM, [
          claimId, clientId, conversationId, inboundId, actorId,
          leaseToken, expires.toISOString(), now.toISOString(),
        ]);
        if (ins && Array.isArray(ins.rows) && ins.rows.length === 1) return ins.rows[0];
        const existing = await pg.query(SQL_LOAD_CLAIM, [clientId, conversationId, inboundId]);
        return existing && Array.isArray(existing.rows) && existing.rows[0] ? existing.rows[0] : null;
      });
      if (row && uuid(row.lease_token) === leaseToken) {
        return freeze({
          status: 'won',
          claim_id: row.claim_id,
          lease_token: leaseToken,
          lease_epoch: Number(row.lease_epoch),
          state: 'leased',
          auto_provenance: SAME_DESK_AUTO_PROVENANCE,
        });
      }
      return freeze({
        status: 'lost',
        reason: row && row.state === 'dispatching' ? 'outcome_unknown' : 'already_claimed',
        claim_id: row && row.claim_id,
        approval_id: row && row.approval_id,
        state: row && row.state,
      });
    } catch (err) {
      if (err && String(err.code) === '23505') {
        return freeze({ status: 'lost', reason: 'already_claimed' });
      }
      throw err;
    }
  }

  async function linkApproval(input) {
    const claimId = uuid(input && input.claim_id);
    const clientId = uuid(input && input.client_id);
    const conversationId = uuid(input && input.conversation_id);
    const approvalId = uuid(input && input.approval_id);
    const operationId = uuid(input && input.operation_id);
    const leaseToken = uuid(input && input.lease_token);
    const epoch = Number(input && input.lease_epoch);
    if (!claimId || !clientId || !conversationId || !approvalId || !leaseToken || !Number.isInteger(epoch)) {
      return freeze({ status: 'not_linked', reason: 'invalid_link_identity' });
    }
    const now = readNow(input);
    const row = await withPgClient(async (pg) => {
      const upd = await pg.query(SQL_LINK_APPROVAL, [
        claimId, clientId, conversationId, approvalId, operationId,
        now.toISOString(), leaseToken, epoch,
      ]);
      return upd && Array.isArray(upd.rows) && upd.rows[0] ? upd.rows[0] : null;
    });
    if (!row) return freeze({ status: 'not_linked', reason: 'stale_lease' });
    return freeze({
      status: 'linked',
      claim_id: row.claim_id,
      approval_id: row.approval_id,
      state: row.state,
      lease_token: row.lease_token,
      lease_epoch: Number(row.lease_epoch),
      auto_provenance: SAME_DESK_AUTO_PROVENANCE,
    });
  }

  async function release(input) {
    const claimId = uuid(input && input.claim_id);
    const clientId = uuid(input && input.client_id);
    const conversationId = uuid(input && input.conversation_id);
    const leaseToken = uuid(input && input.lease_token);
    const epoch = Number(input && input.lease_epoch);
    if (!claimId || !clientId || !conversationId || !leaseToken || !Number.isInteger(epoch)) {
      return freeze({ status: 'not_released', reason: 'invalid_release_identity' });
    }
    const now = readNow(input);
    const row = await withPgClient(async (pg) => {
      const upd = await pg.query(SQL_RELEASE_CLAIM, [
        claimId, clientId, conversationId, now.toISOString(), leaseToken, epoch,
      ]);
      return upd && Array.isArray(upd.rows) && upd.rows[0] ? upd.rows[0] : null;
    });
    if (!row) return freeze({ status: 'not_released', reason: 'stale_lease' });
    return freeze({
      status: 'released',
      claim_id: row.claim_id,
      state: row.state,
      lease_token: row.lease_token,
      lease_epoch: Number(row.lease_epoch),
    });
  }

  async function beginDispatch(input) {
    const claimId = uuid(input && input.claim_id);
    const clientId = uuid(input && input.client_id);
    const conversationId = uuid(input && input.conversation_id);
    const leaseToken = uuid(input && input.lease_token);
    const epoch = Number(input && input.lease_epoch);
    if (!claimId || !clientId || !conversationId || !leaseToken || !Number.isInteger(epoch)) {
      return freeze({ status: 'not_begun', reason: 'invalid_dispatch_identity' });
    }
    const now = readNow(input);
    const row = await withPgClient(async (pg) => {
      const upd = await pg.query(SQL_BEGIN_DISPATCH, [
        claimId, clientId, conversationId, now.toISOString(), leaseToken, epoch,
      ]);
      return upd && Array.isArray(upd.rows) && upd.rows[0] ? upd.rows[0] : null;
    });
    if (!row) return freeze({ status: 'not_begun', reason: 'stale_lease' });
    return freeze({
      status: 'dispatching',
      claim_id: row.claim_id,
      approval_id: row.approval_id,
      state: row.state,
      lease_token: row.lease_token,
      lease_epoch: Number(row.lease_epoch),
      auto_provenance: SAME_DESK_AUTO_PROVENANCE,
    });
  }

  return freeze({ claim, linkApproval, release, beginDispatch });
}

module.exports = {
  createSameDeskAutoSendClaimOwner,
  SAME_DESK_AUTO_SEND_LEASE_MS,
  SAME_DESK_AUTO_PROVENANCE,
  SQL_INSERT_CLAIM,
  SQL_LOAD_CLAIM,
  SQL_LINK_APPROVAL,
  SQL_RELEASE_CLAIM,
  SQL_BEGIN_DISPATCH,
};
