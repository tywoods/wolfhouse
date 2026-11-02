'use strict';

const {
  captureSupervisorEvent,
  claimSupervisorIncident,
  renewSupervisorClaim,
  admitSupervisorBusinessAction,
  recordSupervisorLifecycle,
  recordSupervisorOutcome,
  isSupervisorAccount,
  isSupervisorHalt,
  operationKey,
  resolveSupervisorWriteTarget,
  bindCompleteDispatchParams,
  classifyPauseOwner,
} = require('./staff-supervisor-events');

const SUPERVISOR_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${SUPERVISOR_UUID}$`, 'i');
const SUPERVISOR_CLAIM_RE = new RegExp(`^/staff/conversations/(${SUPERVISOR_UUID})/supervisor-claim$`, 'i');
const SUPERVISOR_RENEW_RE = new RegExp(`^/staff/conversations/(${SUPERVISOR_UUID})/supervisor-claim/renew$`, 'i');
const SUPERVISOR_EVENT_OUTCOME_RE = new RegExp(`^/staff/supervisor/events/(${SUPERVISOR_UUID})/outcome$`, 'i');
const SUPERVISOR_EVENT_LIFECYCLE_RE = new RegExp(`^/staff/supervisor/events/(${SUPERVISOR_UUID})/lifecycle$`, 'i');
const SUPERVISOR_AUDIT_PATH = '/staff/supervisor/audit';

function header(req, name) {
  const h = req && req.headers ? req.headers : {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
}

function createPgSupervisorStore(pg) {
  return {
    async insertEvent(input) {
      const q = await pg.query(
        `INSERT INTO supervisor_events (
           client_id, conversation_id, booking_id, booking_code, kind, reason, obligation,
           source_key, cause_incident_id, metadata
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (source_key) DO NOTHING
         RETURNING *`,
        [
          input.client_id || null,
          input.conversation_id || null,
          input.booking_id || null,
          input.booking_code || null,
          input.kind,
          input.reason || null,
          input.obligation,
          input.source_key,
          input.cause_incident_id || null,
          JSON.stringify(input.metadata || {}),
        ],
      );
      if (q.rows[0]) return { inserted: true, row: q.rows[0] };
      const existing = await pg.query('SELECT * FROM supervisor_events WHERE source_key = $1', [input.source_key]);
      return { inserted: false, row: existing.rows[0] || null };
    },
    async getEvent(id) {
      const q = await pg.query('SELECT * FROM supervisor_events WHERE id = $1', [id]);
      return q.rows[0] || null;
    },
    async updateEvent(id, patch) {
      const fields = [];
      const vals = [];
      Object.keys(patch).forEach((k) => {
        if (patch[k] === undefined) return;
        vals.push(typeof patch[k] === 'object' && patch[k] !== null && !(patch[k] instanceof Date)
          ? JSON.stringify(patch[k]) : patch[k]);
        fields.push(`${k} = $${vals.length}`);
      });
      vals.push(id);
      const q = await pg.query(
        `UPDATE supervisor_events SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
        vals,
      );
      return q.rows[0] || null;
    },
    async listDueEvents(now, { limit } = {}) {
      const q = await pg.query(
        `SELECT * FROM supervisor_events
         WHERE (
             delivery_status = 'pending'
             OR (delivery_status = 'dispatched' AND (dispatch_lease_until IS NULL OR dispatch_lease_until < $1))
           )
           AND (dispatch_lease_until IS NULL OR dispatch_lease_until < $1)
           AND (next_retry_at IS NULL OR next_retry_at <= $1)
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now instanceof Date ? now : new Date(), limit || 4],
      );
      return q.rows;
    },
    async claimDispatch(id, workerId, leaseUntil) {
      const q = await pg.query(
        `UPDATE supervisor_events
         SET dispatch_worker_id = $2,
             dispatch_lease_until = $3,
             delivery_status = 'dispatched',
             attempts = attempts + 1,
             updated_at = NOW()
         WHERE id = $1
           AND delivery_status IN ('pending', 'dispatched')
           AND (dispatch_lease_until IS NULL OR dispatch_lease_until < NOW())
         RETURNING *`,
        [id, workerId, leaseUntil],
      );
      return q.rows[0] || null;
    },
    async completeDispatch(id, workerId, patch, now) {
      const bound = bindCompleteDispatchParams(id, workerId, patch, now);
      const q = await pg.query(bound.sql, bound.vals);
      return q.rows[0] || null;
    },
    async listEvents(filter = {}) {
      const statuses = filter.statuses;
      if (statuses && statuses.length) {
        const q = await pg.query(
          'SELECT * FROM supervisor_events WHERE delivery_status = ANY($1::text[]) ORDER BY created_at ASC',
          [statuses],
        );
        return q.rows;
      }
      const q = await pg.query('SELECT * FROM supervisor_events ORDER BY created_at ASC');
      return q.rows;
    },
    async getCheckpoint(name) {
      const q = await pg.query('SELECT cursor FROM supervisor_catchup_checkpoints WHERE source_name = $1', [name]);
      return q.rows[0] ? q.rows[0].cursor : null;
    },
    async setCheckpoint(name, cursor) {
      await pg.query(
        `INSERT INTO supervisor_catchup_checkpoints (source_name, cursor, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (source_name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
        [name, cursor],
      );
    },
    async insertIncident(input) {
      await pg.query(
        `UPDATE supervisor_incidents
         SET status = 'expired', closed_reason = 'lease_expired'
         WHERE conversation_id = $1 AND status = 'open' AND lease_until < NOW()`,
        [input.conversation_id],
      );
      const live = await pg.query(
        `SELECT * FROM supervisor_incidents
         WHERE conversation_id = $1 AND status = 'open'
         FOR UPDATE`,
        [input.conversation_id],
      );
      if (live.rows[0]) return { joined: true, incident: live.rows[0] };
      const q = await pg.query(
        `INSERT INTO supervisor_incidents (
           conversation_id, event_id, obligation, after_message_id, lease_token, lease_until,
           staff_user_id, pause_permit_transition_id, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *`,
        [
          input.conversation_id,
          input.event_id,
          input.obligation || null,
          input.after_message_id || null,
          input.lease_token,
          input.lease_until,
          input.staff_user_id || null,
          input.pause_permit_transition_id || null,
        ],
      );
      return { joined: false, incident: q.rows[0] };
    },
    async getOpenIncident(conversationId) {
      const q = await pg.query(
        `SELECT * FROM supervisor_incidents WHERE conversation_id = $1 AND status = 'open' LIMIT 1`,
        [conversationId],
      );
      return q.rows[0] || null;
    },
    async getIncident(id) {
      const q = await pg.query('SELECT * FROM supervisor_incidents WHERE id = $1', [id]);
      return q.rows[0] || null;
    },
    async updateIncident(id, patch) {
      const q = await pg.query(
        `UPDATE supervisor_incidents SET lease_until = COALESCE($2, lease_until), status = COALESCE($3, status),
           closed_reason = COALESCE($4, closed_reason) WHERE id = $1 RETURNING *`,
        [id, patch.lease_until || null, patch.status || null, patch.closed_reason || null],
      );
      return q.rows[0] || null;
    },
    async renewIncident(input) {
      const q = await pg.query(
        `UPDATE supervisor_incidents
            SET lease_until = $2
          WHERE id = $1
            AND lease_token = $3
            AND staff_user_id = $4
            AND status = 'open'
            AND ($5::text IS NULL OR obligation IS NULL OR obligation = $5)
            AND lease_until >= $6
          RETURNING *`,
        [
          input.incident_id,
          input.lease_until,
          input.lease_token,
          input.staff_user_id,
          input.obligation || null,
          input.now instanceof Date ? input.now : new Date(),
        ],
      );
      return q.rows[0] || null;
    },
    async appendLifecycle(entry) {
      await pg.query(
        `INSERT INTO supervisor_lifecycle (event_id, kind, payload, halted, expired)
         VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [entry.event_id || null, entry.kind, JSON.stringify(entry.payload || {}), entry.halted === true, entry.expired === true],
      );
      return { ok: true };
    },
  };
}

function loadSeadogAuditHelper() {
  try {
    return require('./staff-supervisor-audit');
  } catch (_) {
    return null;
  }
}

function createStaffSupervisorRoutes(deps) {
  if (!deps || typeof deps.sendJSON !== 'function' || typeof deps.withPgClient !== 'function') {
    throw new Error('supervisor_routes_deps');
  }
  const seadogAudit = deps.seadogAudit || loadSeadogAuditHelper();

  async function withStore(fn) {
    return deps.withPgClient(async (pg) => fn(createPgSupervisorStore(pg), pg));
  }

  async function handleClaim(req, res, user, convId, body) {
    if (!isSupervisorAccount(user)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    if (!UUID.test(convId)) return deps.sendJSON(res, 400, { success: false, error: 'invalid_conversation' });
    const eventId = body && body.event_id;
    if (!eventId || !UUID.test(String(eventId))) {
      return deps.sendJSON(res, 400, { success: false, error: 'event_id_required' });
    }
    const out = await withStore((store) => claimSupervisorIncident(store, {
      user,
      conversation_id: convId,
      event_id: eventId,
      after_message_id: body.after_message_id || null,
      now: new Date(),
    }));
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error });
    return deps.sendJSON(res, 200, { success: true, joined: out.joined === true, incident: out.incident });
  }

  async function handleOutcome(req, res, user, eventId, body) {
    if (!isSupervisorAccount(user)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    const out = await withStore(async (store) => {
      const event = await store.getEvent(eventId);
      if (!event) return { ok: false, error: 'event_not_found' };
      return recordSupervisorOutcome(store, {
        event_id: eventId,
        conversation_id: event.conversation_id,
        incident_id: body && body.incident_id,
        lease_token: body && body.lease_token || header(req, 'x-supervisor-lease-token'),
        user,
        outcome: body && body.outcome,
        obligation: event.obligation,
      });
    });
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error || 'not_found' });
    return deps.sendJSON(res, 200, { success: true, event: out.row, closed: out.closed === true, pending: out.pending === true });
  }

  async function handleLifecycle(req, res, user, eventId, body) {
    if (!user) return deps.sendJSON(res, 401, { success: false, error: 'unauthorized' });
    const out = await withStore((store) => recordSupervisorLifecycle(store, {
      event_id: eventId,
      conversation_id: body && body.conversation_id,
      user,
      kind: body && body.kind,
      payload: body && body.payload,
      halted: isSupervisorHalt(process.env),
      expired: !!(body && body.expired),
    }));
    return deps.sendJSON(res, 200, { success: true, recorded: out.ok === true, error: out.ok ? undefined : out.error });
  }

  async function handleAudit(req, res, user, body) {
    if (!seadogAudit || typeof seadogAudit.handleSupervisorAudit !== 'function') {
      return deps.sendJSON(res, 501, { success: false, error: 'audit_helper_unwired' });
    }
    return seadogAudit.handleSupervisorAudit(req, res, user, body, deps);
  }

  async function handleRenew(req, res, user, convId, body) {
    if (!isSupervisorAccount(user)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    const out = await withStore((store) => renewSupervisorClaim(store, {
      incident_id: body && body.incident_id,
      lease_token: body && body.lease_token || header(req, 'x-supervisor-lease-token'),
      user,
      obligation: body && body.obligation,
      now: new Date(),
    }));
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error });
    return deps.sendJSON(res, 200, { success: true, incident: out.incident });
  }

  async function loadAdmissionFacts(pg, conversationId, extra) {
    if (!conversationId) return null;
    let conv;
    try {
      const c = await pg.query(
        `SELECT id::text AS id, phone, last_staff_reply_at,
                current_hold_booking_id::text AS current_hold_booking_id,
                needs_human_transition_id::text AS needs_human_transition_id,
                metadata
           FROM conversations
          WHERE id = $1::uuid
          LIMIT 1`,
        [conversationId],
      );
      conv = c.rows[0];
    } catch (_) {
      return null;
    }
    if (!conv) return null;
    let pause = { paused: false, owner: null };
    try {
      const p = await pg.query(
        `SELECT paused, paused_by, metadata, pause_reason, conversation_id, guest_phone
           FROM bot_pause_states
          WHERE paused = TRUE
            AND (
              conversation_id = $1
              OR (conversation_id IS NULL AND guest_phone = $2)
              OR (conversation_id IS NULL AND guest_phone IS NULL AND client_slug = $3)
            )
          ORDER BY CASE
            WHEN conversation_id = $1 THEN 0
            WHEN guest_phone = $2 THEN 1
            ELSE 2
          END, paused_at DESC
          LIMIT 1`,
        [String(conversationId), String(conv.phone || ''), String((extra && extra.body && extra.body.client_slug) || '')],
      );
      if (p.rows[0] && p.rows[0].paused === true) {
        const meta = p.rows[0].metadata || {};
        const by = String(p.rows[0].paused_by || '').trim();
        pause = {
          paused: true,
          owner: classifyPauseOwner(by),
          paused_by: by,
          needs_human_transition_id: meta.needs_human_transition_id
            || meta.transition_id
            || conv.needs_human_transition_id
            || null,
          metadata: meta,
        };
      }
    } catch (_) {
      return null;
    }
    let lunaMode = null;
    const clientSlug = extra && extra.body && extra.body.client_slug;
    if (clientSlug) {
      try {
        const m = await pg.query(
          `SELECT settings->'inbox_channel_modes'->>'whatsapp' AS whatsapp_mode
             FROM clients WHERE slug = $1 LIMIT 1`,
          [String(clientSlug)],
        );
        if (m.rows[0] && m.rows[0].whatsapp_mode) lunaMode = m.rows[0].whatsapp_mode;
      } catch (_) {
        return null;
      }
    }
    if (!lunaMode) return null;
    return {
      pause,
      lunaMode,
      lastStaffReplyAt: conv.last_staff_reply_at || null,
      current_hold_booking_id: conv.current_hold_booking_id,
      phone: conv.phone,
      needs_human_transition_id: conv.needs_human_transition_id,
    };
  }

  async function admitFromRequest(req, user, extra) {
    const lease = header(req, 'x-supervisor-lease-token') || (extra && extra.lease_token);
    const step = (extra && extra.step) || 'step';
    return withStore(async (store, pg) => {
      let conversationId = null;
      const target = resolveSupervisorWriteTarget({
        body: extra && extra.body || {},
        query: extra && extra.query || {},
        extra: extra || {},
      });
      if (target.ok) conversationId = target.conversation_id;
      else if (target.error === 'conversation_mismatch') {
        return { ok: false, error: 'conversation_mismatch', status: 409 };
      }
      if (!conversationId && extra && extra.body && pg) {
        const bookingId = extra.body.booking_id;
        const bookingCode = extra.body.booking_code;
        if (bookingId || bookingCode) {
          try {
            const q = await pg.query(
              `SELECT c.id::text AS conversation_id, b.id::text AS booking_id, b.booking_code
                 FROM conversations c
                 JOIN bookings b ON b.id = c.current_hold_booking_id
                WHERE ($1::text <> '' AND b.id::text = $1)
                   OR ($2::text <> '' AND b.booking_code = $2)
                LIMIT 2`,
              [String(bookingId || ''), String(bookingCode || '')],
            );
            if (bookingId && bookingCode && q.rows[0]
                && String(q.rows[0].booking_id) !== String(bookingId)
                && String(q.rows[0].booking_code) !== String(bookingCode)) {
              return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
            }
            if (q.rows[0] && q.rows[0].conversation_id) conversationId = q.rows[0].conversation_id;
          } catch (_) {
            return { ok: false, error: 'conversation_required', status: 409 };
          }
        }
      }
      if (!conversationId) return { ok: false, error: 'conversation_required', status: 409 };
      if (extra && extra.body && extra.body.booking_id && pg) {
        try {
          const bind = await pg.query(
            `SELECT id::text AS id FROM conversations
              WHERE id = $1::uuid AND current_hold_booking_id = $2::uuid
              LIMIT 1`,
            [conversationId, String(extra.body.booking_id)],
          );
          if (!bind.rows[0]) return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
        } catch (_) {
          return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
        }
      }
      const facts = await loadAdmissionFacts(pg, conversationId, extra);
      if (!facts) return { ok: false, error: 'admission_facts_required', status: 409 };
      const bodyPhone = extra && extra.body && (extra.body.phone || extra.body.guest_phone);
      if (bodyPhone && facts.phone) {
        const norm = (v) => String(v || '').replace(/\D/g, '');
        if (norm(bodyPhone) && norm(facts.phone) && norm(bodyPhone) !== norm(facts.phone)) {
          return { ok: false, error: 'phone_conversation_mismatch', status: 409 };
        }
      }
      return admitSupervisorBusinessAction(store, {
        user,
        action: extra && extra.action,
        conversation_id: conversationId,
        body: extra && extra.body || {},
        query: extra && extra.query || {},
        incident_id: extra && extra.incident_id,
        lease_token: lease,
        step,
        now: new Date(),
        halt: isSupervisorHalt(process.env),
        factsLoaded: true,
        pause: facts.pause,
        lunaMode: facts.lunaMode,
        lastStaffReplyAt: facts.lastStaffReplyAt,
      });
    });
  }

  return Object.freeze({
    SUPERVISOR_CLAIM_RE,
    SUPERVISOR_RENEW_RE,
    SUPERVISOR_EVENT_OUTCOME_RE,
    SUPERVISOR_EVENT_LIFECYCLE_RE,
    SUPERVISOR_AUDIT_PATH,
    handleClaim,
    handleRenew,
    handleOutcome,
    handleLifecycle,
    handleAudit,
    admitFromRequest,
    operationKey,
    captureSupervisorEvent,
    createPgSupervisorStore,
    seadogAuditLoaded: !!seadogAudit,
  });
}

module.exports = {
  SUPERVISOR_CLAIM_RE,
  SUPERVISOR_RENEW_RE,
  SUPERVISOR_EVENT_OUTCOME_RE,
  SUPERVISOR_EVENT_LIFECYCLE_RE,
  SUPERVISOR_AUDIT_PATH,
  createStaffSupervisorRoutes,
  createPgSupervisorStore,
  loadSeadogAuditHelper,
};
