/**
 * Inbox thread composite route — extracted from the six Inbox thread fetches.
 *
 * GET /staff/inbox/thread/:id returns, in one response and one Postgres
 * snapshot, the payloads the Inbox thread view used to assemble from
 * /staff/conversations/:id, .../messages, .../context, .../draft,
 * .../staff-state and /staff/bot/pause-state. Every section keeps the exact
 * body its own endpoint returns, nested under a named key, so the browser
 * consumes it without reshaping.
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with
 * the minRole from INBOX_THREAD_COMPOSITE_ROUTE_TABLE before dispatching; the
 * handler then applies the same assertStaffClientAccess check the six
 * individual routes apply.
 *
 * Shared query helpers: scripts/lib/staff-conversation-queries.js and
 * scripts/lib/staff-bot-pause-sql.js. Do not duplicate DB logic here.
 *
 * @module staff-inbox-thread-composite
 */

'use strict';

const {
  getConversationDetailQuery,
  getConversationMessagesQuery,
  projectStaffInboxThreadMessage,
  getConversationContextQuery,
  getConversationBookingsQuery,
  getConversationDraftQuery,
  getConversationStaffStateQuery,
} = require('./staff-conversation-queries');
const { getPauseState } = require('./staff-bot-pause-sql');

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const INBOX_THREAD_COMPOSITE_PATH = '/staff/inbox/thread/:id';
const INBOX_THREAD_COMPOSITE_RE = new RegExp(`^/staff/inbox/thread/(${UUID_RE})$`, 'i');

/** Section keys of the composite payload, in the order the browser reads them. */
const INBOX_THREAD_COMPOSITE_SECTIONS = Object.freeze([
  'detail',
  'messages',
  'context',
  'draft',
  'staff_state',
  'pause_state',
]);

/**
 * Canonical route table — minRole must match router requireAuth exactly.
 * Auth stays in staff-query-api.js; this table is the contract for the harness.
 */
const INBOX_THREAD_COMPOSITE_ROUTE_TABLE = Object.freeze([
  {
    id: 'inbox_thread_composite',
    method: 'GET',
    path: INBOX_THREAD_COMPOSITE_PATH,
    match: 'inbox_thread_composite',
    minRole: 'viewer',
  },
]);

const SNAPSHOT_BEGIN = 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';
const SECTION_SAVEPOINT = 'inbox_thread_section';

/**
 * @param {object} deps
 */
function createInboxThreadCompositeRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createInboxThreadCompositeRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    send404,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    markPgClientDiscardRequired,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
    resolveSunsetConversationScope,
    conversationDetailQueryParams,
    sanitizeConversationContextForInbox,
    filterActiveInboxBookings,
    buildPausedStateResponse,
    buildDefaultActivePauseResponse,
  } = deps;

  /**
   * A failed statement aborts the enclosing transaction, so one broken section
   * would take the rest of the snapshot with it. The savepoint keeps the other
   * sections readable and preserves per-section degradation.
   */
  async function readSection(pg, run) {
    const started = Date.now();
    await pg.query(`SAVEPOINT ${SECTION_SAVEPOINT}`);
    try {
      const value = await run();
      try {
        await pg.query(`RELEASE SAVEPOINT ${SECTION_SAVEPOINT}`);
      } catch (_releaseErr) {
        // A section that swallows its own statement error (getPauseState treats a
        // missing bot_pause_states table as "active") still leaves the
        // transaction aborted; rewind to the savepoint so its value survives.
        await pg.query(`ROLLBACK TO SAVEPOINT ${SECTION_SAVEPOINT}`);
        await pg.query(`RELEASE SAVEPOINT ${SECTION_SAVEPOINT}`);
      }
      return { ok: true, value, elapsed_ms: Date.now() - started };
    } catch (err) {
      await pg.query(`ROLLBACK TO SAVEPOINT ${SECTION_SAVEPOINT}`);
      await pg.query(`RELEASE SAVEPOINT ${SECTION_SAVEPOINT}`);
      return { ok: false, error: err, elapsed_ms: Date.now() - started };
    }
  }

  function queryFailedSection() {
    return { success: false, error: 'query failed' };
  }

  function notFoundSection() {
    return { success: false, error: 'Not found' };
  }

  async function readThreadSnapshot(pg, clientSlug, convId, scope) {
    const params = conversationDetailQueryParams(clientSlug, convId, scope);

    const detail = await readSection(pg, () => pg.query(
      getConversationDetailQuery(scope.queryOpts),
      params,
    ));
    if (!detail.ok) return { outcome: 'query_failed', error: detail.error };

    const detailRows = detail.value.rows || [];
    if (!detailRows.length) return { outcome: 'not_found' };

    const messages = await readSection(pg, () => pg.query(
      getConversationMessagesQuery(scope.queryOpts),
      params,
    ));
    const context = await readSection(pg, async () => {
      const ctx = await pg.query(getConversationContextQuery(scope.queryOpts), params);
      const bk = await pg.query(getConversationBookingsQuery(scope.queryOpts), params);
      return { contextRow: ctx.rows[0] || null, bookingRows: bk.rows || [] };
    });
    const draft = await readSection(pg, () => pg.query(
      getConversationDraftQuery(scope.queryOpts),
      params,
    ));
    const staffState = await readSection(pg, () => pg.query(
      getConversationStaffStateQuery(scope.queryOpts),
      params,
    ));
    const pause = await readSection(pg, () => getPauseState(pg, {
      client_slug: clientSlug,
      conversation_id: convId,
      guest_phone: null,
      booking_code: null,
    }));

    const sections = {};

    sections.detail = {
      success: true,
      conversation: detailRows[0],
      elapsed_ms: detail.elapsed_ms,
    };

    if (messages.ok) {
      const rows = (messages.value.rows || []).map((row) => projectStaffInboxThreadMessage(row));
      sections.messages = {
        success: true,
        messages: rows,
        count: rows.length,
        elapsed_ms: messages.elapsed_ms,
      };
    } else {
      sections.messages = queryFailedSection();
    }

    if (!context.ok) {
      sections.context = queryFailedSection();
    } else if (!context.value.contextRow) {
      sections.context = notFoundSection();
    } else {
      sections.context = {
        success: true,
        context: sanitizeConversationContextForInbox(context.value.contextRow),
        bookings: filterActiveInboxBookings(context.value.bookingRows),
        elapsed_ms: context.elapsed_ms,
      };
    }

    if (!draft.ok) {
      sections.draft = queryFailedSection();
    } else if (!(draft.value.rows || []).length) {
      sections.draft = notFoundSection();
    } else {
      sections.draft = { success: true, draft: draft.value.rows[0], elapsed_ms: draft.elapsed_ms };
    }

    if (!staffState.ok) {
      sections.staff_state = queryFailedSection();
    } else if (!(staffState.value.rows || []).length) {
      sections.staff_state = notFoundSection();
    } else {
      sections.staff_state = {
        success: true,
        staff_state: staffState.value.rows[0],
        elapsed_ms: staffState.elapsed_ms,
      };
    }

    if (!pause.ok) {
      sections.pause_state = buildDefaultActivePauseResponse({
        client_slug: clientSlug,
        guest_phone: null,
        conversation_id: convId,
        booking_code: null,
        lookup_error: true,
      });
    } else if (pause.value.row) {
      sections.pause_state = buildPausedStateResponse(pause.value.row);
    } else {
      sections.pause_state = buildDefaultActivePauseResponse({
        client_slug: clientSlug,
        guest_phone: null,
        conversation_id: convId,
        booking_code: null,
        table_missing: pause.value.table_missing || false,
      });
    }

    return { outcome: 'ok', sections };
  }

  async function handleInboxThreadComposite(convId, query, res, user) {
    const started = Date.now();
    const clientSlug = (String(query.client || DEFAULT_CLIENT)).trim();
    if (SQL_INJECT_RE.test(clientSlug)) return send400(res, 'invalid client slug');
    if (!assertStaffClientAccess(user, clientSlug, res)) return;

    const scope = resolveSunsetConversationScope(clientSlug, query);

    const auditBase = {
      ts:              new Date().toISOString(),
      intent:          'api:conversation.thread-composite',
      category:        'conversation_api',
      client_slug:     clientSlug,
      location_id:     scope.locationId,
      conversation_id: convId,
      staff_user_id:   user ? user.staff_user_id : null,
    };

    let result;
    try {
      result = await withPgClient(async (pg) => {
        await pg.query(SNAPSHOT_BEGIN);
        let snapshot;
        try {
          snapshot = await readThreadSnapshot(pg, clientSlug, convId, scope);
        } finally {
          // COMMIT on an aborted transaction behaves as ROLLBACK; either way the
          // connection must not return to the pool still holding the snapshot.
          // Cleanup uncertainty policy:
          //   - COMMIT fails + ROLLBACK succeeds: transaction closed, fail closed (throw)
          //   - COMMIT fails + ROLLBACK fails: connection unusable, mark for discard, throw
          //   - Either success: normal path
          try {
            await pg.query('COMMIT');
          } catch (commitErr) {
            let rollbackOk = false;
            try {
              await pg.query('ROLLBACK');
              rollbackOk = true;
            } catch (_rollbackErr) {
              // Both COMMIT and ROLLBACK failed — connection state is uncertain.
              // Mark the client so withPgClient releases it destructively.
              if (markPgClientDiscardRequired) markPgClientDiscardRequired(pg);
            }
            // Whether ROLLBACK succeeded or not, we must fail closed: the read snapshot
            // completed but transaction cleanup is uncertain; do not return HTTP 200.
            const cleanupErr = new Error('transaction_cleanup_failed');
            cleanupErr.commitErr = commitErr;
            cleanupErr.rollbackOk = rollbackOk;
            throw cleanupErr;
          }
        }
        return snapshot;
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }

    const elapsed = Date.now() - started;

    if (result.outcome === 'query_failed') {
      appendAuditLog({ ...auditBase, success: false, error: result.error.message, elapsed_ms: elapsed });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }

    // Wrong tenant, wrong Sunset location and deleted all land here with the
    // same body the detail route sends — never reveal that the row exists.
    if (result.outcome === 'not_found') {
      appendAuditLog({ ...auditBase, success: false, error: 'not_found', elapsed_ms: elapsed });
      return send404(res);
    }

    const sections = result.sections;
    appendAuditLog({
      ...auditBase,
      success: true,
      sections_ok: INBOX_THREAD_COMPOSITE_SECTIONS.filter((key) => sections[key] && sections[key].success === true),
      message_count: sections.messages.success ? sections.messages.count : null,
      elapsed_ms: elapsed,
    });

    return sendJSON(res, 200, {
      success: true,
      conversation_id: convId,
      detail: sections.detail,
      messages: sections.messages,
      context: sections.context,
      draft: sections.draft,
      staff_state: sections.staff_state,
      pause_state: sections.pause_state,
      elapsed_ms: elapsed,
    });
  }

  const handlers = Object.freeze({
    inbox_thread_composite: handleInboxThreadComposite,
  });

  const routes = Object.freeze(INBOX_THREAD_COMPOSITE_ROUTE_TABLE.map((row) => ({
    ...row,
    handler: handlers[row.id],
  })));

  return {
    INBOX_THREAD_COMPOSITE_PATH,
    INBOX_THREAD_COMPOSITE_RE,
    INBOX_THREAD_COMPOSITE_SECTIONS,
    INBOX_THREAD_COMPOSITE_ROUTE_TABLE,
    handlers,
    routes,
    handleInboxThreadComposite,
  };
}

module.exports = {
  INBOX_THREAD_COMPOSITE_PATH,
  INBOX_THREAD_COMPOSITE_RE,
  INBOX_THREAD_COMPOSITE_SECTIONS,
  INBOX_THREAD_COMPOSITE_ROUTE_TABLE,
  createInboxThreadCompositeRoutes,
};
