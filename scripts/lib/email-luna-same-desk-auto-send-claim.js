'use strict';

/**
 * SAME-DESK-004 dedicated durable auto-send claim owner.
 *
 * Exactly one winner per (client_id, conversation_id, source_inbound_event_id).
 * Generic staff/SMTP tenant_email_reply_approvals inserts are out of scope:
 * this table cannot capture those rows.
 */

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freeze = Object.freeze;

const SQL_INSERT_CLAIM = `
INSERT INTO tenant_email_same_desk_auto_send_claims (
  claim_id, client_id, conversation_id, source_inbound_event_id,
  claimant_staff_user_id, state
) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'claimed')
ON CONFLICT (client_id, conversation_id, source_inbound_event_id) DO NOTHING
RETURNING claim_id::text AS claim_id, state,
  approval_id::text AS approval_id, operation_id::text AS operation_id
`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_CLAIM = `
SELECT claim_id::text AS claim_id, state,
  approval_id::text AS approval_id, operation_id::text AS operation_id,
  claimant_staff_user_id::text AS claimant_staff_user_id
FROM tenant_email_same_desk_auto_send_claims
WHERE client_id=$1::uuid AND conversation_id=$2::uuid AND source_inbound_event_id=$3::uuid
`.replace(/\s+/g, ' ').trim();

const SQL_LINK_APPROVAL = `
UPDATE tenant_email_same_desk_auto_send_claims
   SET approval_id=$4::uuid,
       operation_id=COALESCE($5::uuid, operation_id),
       state='linked',
       linked_at=NOW()
 WHERE claim_id=$1::uuid AND client_id=$2::uuid AND conversation_id=$3::uuid
   AND state='claimed' AND approval_id IS NULL
 RETURNING claim_id::text AS claim_id, approval_id::text AS approval_id, state
`.replace(/\s+/g, ' ').trim();

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function createSameDeskAutoSendClaimOwner(deps) {
  if (!deps || typeof deps.withPgClient !== 'function') {
    throw new Error('same_desk_auto_send_claim_deps');
  }
  const withPgClient = deps.withPgClient;

  async function claim(input) {
    const clientId = uuid(input && input.client_id);
    const conversationId = uuid(input && input.conversation_id);
    const inboundId = uuid(input && input.source_inbound_event_id);
    const actorId = uuid(input && input.claimant_staff_user_id);
    if (!clientId || !conversationId || !inboundId || !actorId) {
      return freeze({ status: 'lost', reason: 'invalid_claim_identity' });
    }
    const claimId = crypto.randomUUID();
    try {
      const row = await withPgClient(async (pg) => {
        const ins = await pg.query(SQL_INSERT_CLAIM, [
          claimId, clientId, conversationId, inboundId, actorId,
        ]);
        if (ins && Array.isArray(ins.rows) && ins.rows.length === 1) return ins.rows[0];
        const existing = await pg.query(SQL_LOAD_CLAIM, [clientId, conversationId, inboundId]);
        return existing && Array.isArray(existing.rows) && existing.rows[0] ? existing.rows[0] : null;
      });
      if (row && uuid(row.claim_id) === claimId) {
        return freeze({ status: 'won', claim_id: claimId, state: 'claimed' });
      }
      return freeze({
        status: 'lost',
        reason: 'already_claimed',
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
    if (!claimId || !clientId || !conversationId || !approvalId) {
      return freeze({ status: 'not_linked', reason: 'invalid_link_identity' });
    }
    const row = await withPgClient(async (pg) => {
      const upd = await pg.query(SQL_LINK_APPROVAL, [
        claimId, clientId, conversationId, approvalId, operationId,
      ]);
      return upd && Array.isArray(upd.rows) && upd.rows[0] ? upd.rows[0] : null;
    });
    if (!row) return freeze({ status: 'not_linked', reason: 'claim_not_linkable' });
    return freeze({
      status: 'linked',
      claim_id: row.claim_id,
      approval_id: row.approval_id,
      state: row.state,
    });
  }

  return freeze({ claim, linkApproval });
}

module.exports = {
  createSameDeskAutoSendClaimOwner,
  SQL_INSERT_CLAIM,
  SQL_LOAD_CLAIM,
  SQL_LINK_APPROVAL,
};
