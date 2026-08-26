'use strict';

/**
 * MAIL-MVP-007 — bounded Create Draft live-proof helper.
 *
 * One Create Draft. Aggregate counts only. Never prints guest identifiers
 * or content. Never calls approve/send/provider/booking owners.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const LIVE_NOTES = 'Thank them for the msg and then ask them if they want to do a booking';

const SQL_COUNT_APPROVALS = 'SELECT count(*)::int AS n FROM tenant_email_reply_approvals WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_COUNT_JOURNAL = 'SELECT count(*)::int AS n FROM tenant_email_outbound_send_journal WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_COUNT_BOOKINGS = 'SELECT count(*)::int AS n FROM bookings WHERE client_id=$1::uuid';
const SQL_COUNT_SENDS = 'SELECT coalesce(sum(send_invocation_count),0)::int AS n FROM tenant_email_outbound_send_journal WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_STANDING_DRAFT = 'SELECT length(coalesce(staff_reply_draft,\'\'))::int AS n FROM conversations WHERE client_id=$1::uuid AND id=$2::uuid';

function fail(reason) {
  return freeze({ ok: false, reason: reason || 'proof_failed' });
}

function asInt(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return null;
  const n = row.n;
  if (Number.isSafeInteger(n)) return n;
  const parsed = Number.parseInt(n, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function countRow(withPgClient, sql, params) {
  const result = await withPgClient((pg) => pg.query(sql, params));
  const row = result && result.rows && result.rows[0];
  return asInt(row);
}

async function snapshotCounts(withPgClient, clientId, conversationId) {
  const [approvals, journal, sends, bookings, draftChars] = await Promise.all([
    countRow(withPgClient, SQL_COUNT_APPROVALS, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_JOURNAL, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_SENDS, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_BOOKINGS, [clientId]),
    countRow(withPgClient, SQL_STANDING_DRAFT, [clientId, conversationId]),
  ]);
  if ([approvals, journal, sends, bookings, draftChars].some((n) => !Number.isSafeInteger(n))) {
    return null;
  }
  return freeze({ approvals, journal, sends, bookings, draftChars });
}

function createMailMvp007LiveProof(options) {
  const withPgClient = options && options.withPgClient;
  const createDraft = options && options.createDraft;
  const expectedBody = options && options.expectedBody;
  const notes = options && typeof options.notes === 'string' ? options.notes : LIVE_NOTES;
  if (typeof withPgClient !== 'function' || typeof createDraft !== 'function') {
    throw new Error('live_proof_misconfigured');
  }

  return freeze({
    async runOnce(input) {
      const actor = input && input.actor;
      const conversationId = input && input.conversation_id;
      const clientId = actor && actor.client_id;
      if (!actor || typeof conversationId !== 'string' || typeof clientId !== 'string') {
        return fail('authority_mismatch');
      }
      const before = await snapshotCounts(withPgClient, clientId, conversationId);
      if (!before) return fail('counts_unavailable');
      const drafted = await createDraft({
        actor,
        conversation_id: conversationId,
        operator_context: notes,
      });
      if (!drafted || drafted.status !== 'draft_ready') {
        return fail((drafted && drafted.reason) || 'create_draft_failed');
      }
      const body = drafted.draft_text || drafted.body || drafted.message_text;
      if (typeof expectedBody === 'string' && body !== expectedBody) {
        return fail('draft_mismatch');
      }
      if (typeof body !== 'string' || !body.trim()) return fail('empty_draft');
      const marker = drafted.marker || (drafted.diagnostics && drafted.diagnostics.email_luna_hermes_sol) || null;
      if (!marker || marker.provider !== 'openai-codex' || marker.model !== 'gpt-5.6-sol' || marker.runtime !== 'sunset-email-luna') {
        return fail('provenance_mismatch');
      }
      const after = await snapshotCounts(withPgClient, clientId, conversationId);
      if (!after) return fail('counts_unavailable');
      const deltas = freeze({
        approvals: after.approvals - before.approvals,
        journal: after.journal - before.journal,
        sends: after.sends - before.sends,
        bookings: after.bookings - before.bookings,
        draftChars: after.draftChars - before.draftChars,
      });
      if (deltas.approvals !== 0 || deltas.journal !== 0 || deltas.sends !== 0 || deltas.bookings !== 0) {
        return fail('side_effect');
      }
      if (deltas.draftChars === 0 && before.draftChars === after.draftChars && body.length === 0) {
        return fail('empty_draft');
      }
      return freeze({
        ok: true,
        reason: null,
        invoked: 1,
        marker: freeze({
          provider: marker.provider,
          model: marker.model,
          runtime: marker.runtime,
        }),
        before,
        after,
        deltas,
        draftChars: after.draftChars,
      });
    },
  });
}

module.exports = freeze({
  LIVE_NOTES,
  SQL_COUNT_APPROVALS,
  SQL_COUNT_JOURNAL,
  SQL_COUNT_BOOKINGS,
  SQL_COUNT_SENDS,
  createMailMvp007LiveProof,
});
