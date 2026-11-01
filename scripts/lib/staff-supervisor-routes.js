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
      const fields = [];
      const vals = [id, workerId];
      Object.keys(patch || {}).forEach((k) => {
        if (patch[k] === undefined) return;
        vals.push(typeof patch[k] === 'object' && patch[k] !== null && !(patch[k] instanceof Date)
          ? JSON.stringify(patch[k]) : patch[k]);
        fields.push(`${k} = $${vals.length}`);
      });
      const q = await pg.query(
        `UPDATE supervisor_events SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $1 AND dispatch_worker_id = $2
           AND dispatch_lease_until IS NOT NULL AND dispatch_lease_until >= $3
         RETURNING *`,
        [...vals, now instanceof Date ? now : new Date()],
      );
      return q.rows[0] || null;
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
    const out = await withStore((store) => recordSupervisorOutcome(store, {
      event_id: eventId,
      outcome: body && body.outcome,
      payload: body && body.payload,
    }));
    if (!out.ok) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    return deps.sendJSON(res, 200, { success: true, event: out.row });
  }

  async function handleLifecycle(req, res, user, eventId, body) {
    if (!user) return deps.sendJSON(res, 401, { success: false, error: 'unauthorized' });
    const out = await withStore((store) => recordSupervisorLifecycle(store, {
      event_id: eventId,
      kind: body && body.kind,
      payload: body && body.payload,
      halted: isSupervisorHalt(process.env),
      expired: !!(body && body.expired),
    }));
    return deps.sendJSON(res, 200, { success: true, recorded: out.ok === true });
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
      now: new Date(),
    }));
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error });
    return deps.sendJSON(res, 200, { success: true, incident: out.incident });
  }

  async function loadAdmissionFacts(pg, conversationId) {
    if (!conversationId) return { pause: { paused: false }, lunaMode: 'auto', lastStaffReplyAt: null };
    let pause = { paused: false };
    let lunaMode = 'auto';
    let lastStaffReplyAt = null;
    try {
      const p = await pg.query(
        `SELECT paused_by, source, needs_human_transition_id
           FROM bot_pause_states
          WHERE conversation_id = $1::uuid AND cleared_at IS NULL
          ORDER BY paused_at DESC NULLS LAST
          LIMIT 1`,
        [conversationId],
      );
      if (p.rows[0]) {
        const src = String(p.rows[0].paused_by || p.rows[0].source || '').toLowerCase();
        pause = {
          paused: true,
          owner: src.includes('staff') ? 'staff' : 'luna',
          needs_human_transition_id: p.rows[0].needs_human_transition_id,
        };
      }
    } catch (_) {
      return null;
    }
    try {
      const m = await pg.query('SELECT luna_mode FROM conversations WHERE id = $1::uuid LIMIT 1', [conversationId]);
      if (m.rows[0] && m.rows[0].luna_mode) lunaMode = m.rows[0].luna_mode;
    } catch (_) { /* mode optional */ }
    try {
      const s = await pg.query(
        `SELECT created_at FROM conversation_messages
          WHERE conversation_id = $1::uuid
            AND direction = 'outbound'
            AND staff_user_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [conversationId],
      );
      if (s.rows[0]) lastStaffReplyAt = s.rows[0].created_at;
    } catch (_) { /* activity optional */ }
    return { pause, lunaMode, lastStaffReplyAt };
  }

  async function admitFromRequest(req, user, extra) {
    const incidentId = header(req, 'x-supervisor-incident-id');
    const lease = header(req, 'x-supervisor-lease-token') || (extra && extra.lease_token);
    const step = header(req, 'x-supervisor-step') || (extra && extra.step) || 'step';
    const conversationId = extra && extra.conversation_id;
    return withStore(async (store, pg) => {
      const facts = extra && extra.factsLoaded === true
        ? extra
        : await loadAdmissionFacts(pg, conversationId);
      if (!facts) return { ok: false, error: 'admission_facts_required', status: 409 };
      return admitSupervisorBusinessAction(store, {
        user,
        action: extra && extra.action,
        conversation_id: conversationId,
        incident_id: incidentId || extra && extra.incident_id,
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
