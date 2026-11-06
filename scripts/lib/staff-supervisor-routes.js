'use strict';

const crypto = require('crypto');
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
  encodeSupervisorCheckpoint,
  decodeSupervisorCheckpoint,
  initialSupervisorDeliveryStatus,
  classifyPauseOwner,
  bindLunaPausePermit,
} = require('./staff-supervisor-events');
const {
  appendSupervisorBusinessAuditLog,
  appendSupervisorLifecycleAuditLog,
  BUSINESS_ACTIONS,
  LIFECYCLE_STATES,
} = require('./luna-supervisor-audit');
const { getPauseState } = require('./staff-bot-pause-sql');
const { normalizeWhatsAppMode } = require('./email-inbox-channel-mode');

const SUPERVISOR_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID = new RegExp(`^${SUPERVISOR_UUID}$`, 'i');
const SUPERVISOR_CLAIM_RE = new RegExp(`^/staff/conversations/(${SUPERVISOR_UUID})/supervisor-claim$`, 'i');
const SUPERVISOR_RENEW_RE = new RegExp(`^/staff/conversations/(${SUPERVISOR_UUID})/supervisor-claim/renew$`, 'i');
const SUPERVISOR_EVENT_OUTCOME_RE = new RegExp(`^/staff/supervisor/events/(${SUPERVISOR_UUID})/outcome$`, 'i');
const SUPERVISOR_EVENT_LIFECYCLE_RE = new RegExp(`^/staff/supervisor/events/(${SUPERVISOR_UUID})/lifecycle$`, 'i');
const SUPERVISOR_EVENT_DETAIL_RE = new RegExp(`^/staff/supervisor/events/(${SUPERVISOR_UUID})$`, 'i');
const SUPERVISOR_EVENTS_PATH = '/staff/supervisor/events';
const SUPERVISOR_AUDIT_PATH = '/staff/supervisor/audit';

function header(req, name) {
  const h = req && req.headers ? req.headers : {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || '';
}

/** One owner for legacy lease shapes accepted at supervisor HTTP boundaries. */
function normalizeSupervisorLease(req, body) {
  const src = body && typeof body === 'object' ? body : {};
  const candidates = [
    header(req, 'x-supervisor-lease-token'), src.lease_token,
    src.lease && src.lease.token,
    src.supervisor_lease && (src.supervisor_lease.token || src.supervisor_lease.lease_token),
    ...((Array.isArray(src.supervisor_leases) ? src.supervisor_leases : []).map((lease) => lease && (lease.token || lease.lease_token))),
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const unique = [...new Set(candidates)];
  if (!unique.length) return { ok: false, error: 'lease_token_required' };
  if (unique.length !== 1) return { ok: false, error: 'lease_token_conflict' };
  return { ok: true, token: unique[0] };
}

function createPgSupervisorStore(pg) {
  const projectedAudits = new Set();
  return {
    projectedAudits,
    async hasProjectedAudit(id) {
      if (!id) return false;
      if (projectedAudits.has(id)) return true;
      const q = await pg.query(
        `SELECT 1 FROM supervisor_events
          WHERE metadata->>'audit_identity' = $1
            AND (
              COALESCE(metadata->>'audit_append_ok','') = 'true'
              OR COALESCE(metadata->>'audit_replayed','') = 'true'
            )
          LIMIT 1`,
        [id],
      );
      return q.rowCount > 0;
    },
    async rememberProjectedAudit(id) {
      if (id) projectedAudits.add(id);
    },
    async insertEvent(input) {
      const q = await pg.query(
        `INSERT INTO supervisor_events (
           client_id, conversation_id, booking_id, booking_code, kind, reason, obligation,
           source_key, cause_incident_id, metadata, delivery_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
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
          initialSupervisorDeliveryStatus(input),
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
    async getEventBySourceKey(sourceKey) {
      const q = await pg.query('SELECT * FROM supervisor_events WHERE source_key = $1 LIMIT 1', [sourceKey]);
      return q.rows[0] || null;
    },
    async claimHandoffFallback(id, now, leaseMs) {
      const ts = now instanceof Date ? now : new Date();
      const until = new Date(ts.getTime() + (leaseMs || 30000)).toISOString();
      const token = crypto.randomBytes(8).toString('hex');
      const q = await pg.query(
        `UPDATE supervisor_events
            SET metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'handoff_claim', true,
                   'handoff_claim_until', to_jsonb($2::text),
                   'handoff_claim_token', to_jsonb($3::text)
                 ),
                updated_at = NOW()
          WHERE id = $1
            AND COALESCE(metadata->>'handoff_recorded','') IS DISTINCT FROM 'true'
            AND (
              COALESCE(metadata->>'handoff_claim','') IS DISTINCT FROM 'true'
              OR COALESCE(metadata->>'handoff_claim_until','') = ''
              OR (metadata->>'handoff_claim_until')::timestamptz <= NOW()
            )
          RETURNING *`,
        [id, until, token],
      );
      return q.rows[0] || null;
    },
    async completeHandoffFallback(id, token, patch) {
      if (!token) return null;
      const fields = [];
      const vals = [];
      Object.keys(patch || {}).forEach((k) => {
        if (patch[k] === undefined) return;
        vals.push(typeof patch[k] === 'object' && patch[k] !== null && !(patch[k] instanceof Date)
          ? JSON.stringify(patch[k]) : patch[k]);
        fields.push(`${k} = $${vals.length}`);
      });
      if (!fields.length) {
        const live = await pg.query(
          `SELECT * FROM supervisor_events
            WHERE id = $1 AND metadata->>'handoff_claim_token' = $2`,
          [id, token],
        );
        return live.rows[0] || null;
      }
      vals.push(id, token);
      const q = await pg.query(
        `UPDATE supervisor_events SET ${fields.join(', ')}, updated_at = NOW()
          WHERE id = $${vals.length - 1}
            AND metadata->>'handoff_claim_token' = $${vals.length}
            AND COALESCE(metadata->>'handoff_recorded','') IS DISTINCT FROM 'true'
          RETURNING *`,
        vals,
      );
      if (q.rows[0]) return q.rows[0];
      const live = await pg.query(
        `SELECT * FROM supervisor_events WHERE id = $1`,
        [id],
      );
      const row = live.rows[0];
      if (row && row.metadata && row.metadata.handoff_recorded === true) return row;
      return null;
    },
    async claimAuditReplay(id, now, leaseMs) {
      const ts = now instanceof Date ? now : new Date();
      const until = new Date(ts.getTime() + (leaseMs || 30000)).toISOString();
      const token = crypto.randomBytes(8).toString('hex');
      const q = await pg.query(
        `UPDATE supervisor_events
            SET metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'audit_claim', true,
                   'audit_claim_until', to_jsonb($2::text),
                   'audit_claim_token', to_jsonb($3::text)
                 ),
                updated_at = NOW()
          WHERE id = $1
            AND COALESCE(metadata->>'audit_replayed','') IS DISTINCT FROM 'true'
            AND (
              COALESCE(metadata->>'audit_claim','') IS DISTINCT FROM 'true'
              OR COALESCE(metadata->>'audit_claim_until','') = ''
              OR (metadata->>'audit_claim_until')::timestamptz <= NOW()
            )
          RETURNING *`,
        [id, until, token],
      );
      return q.rows[0] || null;
    },
    async completeAuditReplay(id, token, patch) {
      if (!token) return null;
      const fields = [];
      const vals = [];
      Object.keys(patch || {}).forEach((k) => {
        if (patch[k] === undefined) return;
        vals.push(typeof patch[k] === 'object' && patch[k] !== null && !(patch[k] instanceof Date)
          ? JSON.stringify(patch[k]) : patch[k]);
        fields.push(`${k} = $${vals.length}`);
      });
      if (!fields.length) return null;
      vals.push(id, token);
      const q = await pg.query(
        `UPDATE supervisor_events SET ${fields.join(', ')}, updated_at = NOW()
          WHERE id = $${vals.length - 1}
            AND metadata->>'audit_claim_token' = $${vals.length}
            AND COALESCE(metadata->>'audit_replayed','') IS DISTINCT FROM 'true'
          RETURNING *`,
        vals,
      );
      if (q.rows[0]) return q.rows[0];
      const live = await pg.query('SELECT * FROM supervisor_events WHERE id = $1', [id]);
      const row = live.rows[0];
      if (row && row.metadata && row.metadata.audit_replayed === true) return row;
      return null;
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
           AND delivery_status <> 'diagnostic'
           AND kind NOT IN ('capture_gap', 'audit_retry')
           AND COALESCE(metadata->>'wake_supervisor','') IS DISTINCT FROM 'false'
           AND (dispatch_lease_until IS NULL OR dispatch_lease_until < $1)
           AND (next_retry_at IS NULL OR next_retry_at <= $1)
           AND delivery_status <> 'diagnostic'
           AND kind NOT IN ('capture_gap', 'audit_retry')
           AND COALESCE(metadata->>'wake_supervisor','') IS DISTINCT FROM 'false'
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
           AND (next_retry_at IS NULL OR next_retry_at <= NOW())
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
      return q.rows[0] ? decodeSupervisorCheckpoint(q.rows[0].cursor) : null;
    },
    async setCheckpoint(name, cursor) {
      await pg.query(
        `INSERT INTO supervisor_catchup_checkpoints (source_name, cursor, updated_at)
         VALUES ($1,$2,NOW())
         ON CONFLICT (source_name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
        [name, encodeSupervisorCheckpoint(cursor)],
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

function createStaffSupervisorRoutes(deps) {
  if (!deps || typeof deps.sendJSON !== 'function' || typeof deps.withPgClient !== 'function') {
    throw new Error('supervisor_routes_deps');
  }
  const rawAppend = deps.appendAuditLog;
  const appendAuditLog = typeof rawAppend === 'function'
    ? (entry) => {
      const out = rawAppend(entry);
      if (out && out.ok === false) throw new Error(out.error || 'audit_sink_failed');
      return out;
    }
    : rawAppend;
  const supervisorStaffUserId = deps.supervisorStaffUserId || process.env.LUNA_SUPERVISOR_STAFF_USER_ID;

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
    const out = await withStore(async (store, pg) => {
      let pausePermit = null;
      try {
        const t = await pg.query(
          `SELECT c.needs_human_transition_id::text AS tid, c.phone, cl.slug AS client_slug
             FROM conversations c
             JOIN clients cl ON cl.id = c.client_id
            WHERE c.id = $1::uuid
            LIMIT 1`,
          [convId],
        );
        const conv = t.rows[0];
        const transitionId = conv && conv.tid || null;
        if (conv && transitionId) {
          const loaded = await getPauseState(pg, {
            client_slug: conv.client_slug,
            conversation_id: convId,
            guest_phone: conv.phone,
          });
          if (loaded && loaded.row && loaded.row.paused === true) {
            const bound = await bindLunaPausePermit(pg, loaded.row, transitionId);
            if (bound && bound.ok === true) pausePermit = transitionId;
          }
        }
      } catch (_) {
        pausePermit = null;
      }
      return claimSupervisorIncident(store, {
        user,
        conversation_id: convId,
        event_id: eventId,
        after_message_id: body.after_message_id || null,
        pause_permit_transition_id: pausePermit,
        now: new Date(),
      });
    });
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error });
    return deps.sendJSON(res, 200, { success: true, joined: out.joined === true, incident: out.incident });
  }

  async function handleOutcome(req, res, user, eventId, body) {
    if (!isSupervisorAccount(user)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    const lease = normalizeSupervisorLease(req, body);
    if (!lease.ok) return deps.sendJSON(res, 409, { success: false, error: lease.error });
    const out = await withStore(async (store) => {
      const event = await store.getEvent(eventId);
      if (!event) return { ok: false, error: 'event_not_found' };
      return recordSupervisorOutcome(store, {
        event_id: eventId,
        conversation_id: event.conversation_id,
        incident_id: body && body.incident_id,
        lease_token: lease.token,
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
    if (!out.ok) {
      return deps.sendJSON(res, 200, { success: true, recorded: false, error: out.error });
    }
    const lifecycle = out.kind;
    if (lifecycle && LIFECYCLE_STATES.has(lifecycle) && typeof appendAuditLog === 'function') {
      try {
        appendSupervisorLifecycleAuditLog({
          appendAuditLog,
          actor: user,
          supervisorStaffUserId,
          lifecycle,
          eventId: out.event_id,
          incidentId: out.incident_id,
          conversationId: out.conversation_id,
          bookingRef: out.booking_code,
        });
      } catch (err) {
        return deps.sendJSON(res, 200, {
          success: true,
          recorded: true,
          audit_error: String(err && err.message || 'supervisor_lifecycle_invalid'),
        });
      }
    }
    return deps.sendJSON(res, 200, { success: true, recorded: true });
  }

  async function handleAudit(req, res, user, body) {
    if (!user) return deps.sendJSON(res, 401, { success: false, error: 'unauthorized' });
    if (typeof appendAuditLog !== 'function') {
      return deps.sendJSON(res, 500, { success: false, error: 'supervisor_audit_sink_required' });
    }
    const kind = body && body.kind;
    try {
      if (kind === 'business') {
        return deps.sendJSON(res, 409, {
          success: false,
          error: 'emit_from_completion_path',
        });
      }
      if (kind === 'lifecycle') {
        return deps.sendJSON(res, 409, {
          success: false,
          error: 'emit_from_lifecycle_path',
        });
      }
      return deps.sendJSON(res, 400, { success: false, error: 'audit_kind_required' });
    } catch (err) {
      const msg = String(err && err.message || 'audit_failed');
      const sink = /audit_sink|ENOENT|EACCES|EPERM|EROFS/.test(msg);
      return deps.sendJSON(res, sink ? 500 : 400, {
        success: false,
        error: msg,
      });
    }
  }

  async function handleRenew(req, res, user, convId, body) {
    if (!isSupervisorAccount(user)) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    const lease = normalizeSupervisorLease(req, body);
    if (!lease.ok) return deps.sendJSON(res, 409, { success: false, error: lease.error });
    const out = await withStore((store) => renewSupervisorClaim(store, {
      incident_id: body && body.incident_id,
      lease_token: lease.token,
      user,
      obligation: body && body.obligation,
      now: new Date(),
    }));
    if (!out.ok) return deps.sendJSON(res, 409, { success: false, error: out.error });
    return deps.sendJSON(res, 200, { success: true, incident: out.incident });
  }

  function trustedTenant(user) {
    const clientId = String(user && user.client_id || '').trim();
    const clientSlug = String(user && user.client_slug || '').trim();
    return { clientId, clientSlug };
  }

  function bodyTenantClaim(extra) {
    return String(extra && extra.body && (extra.body.client_slug || extra.body.client) || '').trim();
  }

  async function loadAdmissionFacts(pg, conversationId, user, extra) {
    if (!conversationId) return null;
    let conv;
    try {
      const c = await pg.query(
        `SELECT c.id::text AS id, c.phone, c.last_staff_reply_at,
                current_hold_booking_id::text AS current_hold_booking_id,
                needs_human_transition_id::text AS needs_human_transition_id,
                c.metadata, cl.id::text AS client_id, cl.slug AS client_slug
           FROM conversations c
           JOIN clients cl ON cl.id = c.client_id
          WHERE c.id = $1::uuid
          LIMIT 1`,
        [conversationId],
      );
      conv = c.rows[0];
    } catch (_) {
      return null;
    }
    if (!conv) return null;
    const tenant = trustedTenant(user);
    if ((tenant.clientId && tenant.clientId !== String(conv.client_id))
      || (!tenant.clientId && tenant.clientSlug && tenant.clientSlug !== String(conv.client_slug))) return null;
    if (!tenant.clientId && !tenant.clientSlug) return null;
    const claimedSlug = bodyTenantClaim(extra);
    if (claimedSlug && claimedSlug !== String(conv.client_slug)) return null;
    const clientSlug = String(conv.client_slug);
    let pause = { paused: false, owner: null };
    try {
      const loaded = await getPauseState(pg, {
        client_slug: clientSlug,
        conversation_id: conversationId,
        guest_phone: conv.phone,
        booking_code: extra && extra.body && extra.body.booking_code,
      });
      if (loaded && loaded.table_missing === true) return null;
      if (loaded && loaded.row && loaded.row.paused === true) {
        const meta = loaded.row.metadata || {};
        const by = String(loaded.row.paused_by || '').trim();
        pause = {
          paused: true,
          owner: classifyPauseOwner(by),
          paused_by: by,
          pause_reason: loaded.row.pause_reason || null,
          id: loaded.row.id,
          needs_human_transition_id: meta.needs_human_transition_id
            || meta.transition_id
            || conv.needs_human_transition_id
            || null,
          metadata: meta,
          source: loaded.source,
          global_pause: loaded.global_pause === true,
        };
      }
    } catch (_) {
      return null;
    }
    let lunaMode = null;
    try {
      const m = await pg.query(
        `SELECT settings->'inbox_channel_modes'->>'whatsapp' AS whatsapp_mode
           FROM clients WHERE slug = $1 LIMIT 1`,
        [clientSlug],
      );
      if (!m.rows[0]) return null;
      lunaMode = normalizeWhatsAppMode(m.rows[0].whatsapp_mode);
    } catch (_) {
      return null;
    }
    return {
      pause,
      lunaMode,
      lastStaffReplyAt: conv.last_staff_reply_at || null,
      current_hold_booking_id: conv.current_hold_booking_id,
      phone: conv.phone,
      needs_human_transition_id: conv.needs_human_transition_id,
      client_slug: clientSlug,
    };
  }

  async function admitFromRequest(req, user, extra) {
    // Lease parsing is a supervisor-only overlay. Ordinary callers continue to
    // the existing admission owner, which returns its established not_supervisor
    // result without ever receiving an invented token.
    const supervisor = isSupervisorAccount(user);
    const leaseBody = Object.assign({}, extra && extra.body || {});
    if (extra && extra.lease_token) leaseBody.lease_token = extra.lease_token;
    const lease = supervisor ? normalizeSupervisorLease(req, leaseBody) : { ok: true, token: undefined };
    if (!lease.ok) return { ok: false, error: lease.error, status: 409 };
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
          const tenant = trustedTenant(user);
          if (!tenant.clientId && !tenant.clientSlug) {
            return { ok: false, error: 'trusted_tenant_required', status: 409 };
          }
          try {
            const q = await pg.query(
              `SELECT c.id::text AS conversation_id, b.id::text AS booking_id, b.booking_code
                 FROM bookings b
                 JOIN clients cl ON cl.id = b.client_id
                 JOIN conversations c ON c.client_id = b.client_id
                 LEFT JOIN booking_conversation_links bcl
                   ON bcl.client_id = b.client_id AND bcl.booking_id = b.id
                  AND bcl.conversation_id = c.id
                WHERE ($1::text <> '' OR $2::text <> '')
                  AND ($3::text = '' OR cl.id::text = $3)
                  AND ($3::text <> '' OR cl.slug = $4)
                  AND (bcl.booking_id IS NOT NULL OR c.current_hold_booking_id = b.id)
                  AND ($1::text = '' OR b.id::text = $1)
                  AND ($2::text = '' OR b.booking_code = $2)
                ORDER BY b.id::text, c.id::text`,
              [String(bookingId || '').trim(), String(bookingCode || '').trim(),
                tenant.clientId, tenant.clientSlug],
            );
            const matches = new Set(q.rows.map((r) => `${r.booking_id}:${r.conversation_id}`));
            if (matches.size !== 1) return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
            conversationId = q.rows[0].conversation_id;
          } catch (_) {
            return { ok: false, error: 'conversation_required', status: 409 };
          }
        }
      }
      if (!conversationId) return { ok: false, error: 'conversation_required', status: 409 };
      if (extra && extra.body && (extra.body.booking_id || extra.body.booking_code) && pg) {
        try {
          const hold = await pg.query(
            `SELECT b.id::text AS booking_id, b.booking_code
               FROM conversations c
               JOIN clients cl ON cl.id = c.client_id
               JOIN bookings b ON b.client_id = c.client_id
               LEFT JOIN booking_conversation_links bcl
                 ON bcl.client_id = c.client_id AND bcl.booking_id = b.id
                AND bcl.conversation_id = c.id
              WHERE c.id = $1::uuid
                AND (bcl.booking_id IS NOT NULL OR b.id = c.current_hold_booking_id)
                AND ($2::text <> '' OR $3::text <> '')
                AND ($2::text = '' OR b.id::text = $2)
                AND ($3::text = '' OR b.booking_code = $3)
              ORDER BY b.id::text`,
            [
              conversationId,
              String((extra.body && extra.body.booking_id) || ''),
              String((extra.body && extra.body.booking_code) || ''),
            ],
          );
          if (hold.rows.length !== 1) return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
          const row = hold.rows[0];
          const wantId = String((extra.body && extra.body.booking_id) || '').trim();
          const wantCode = String((extra.body && extra.body.booking_code) || '').trim();
          if (wantId && row.booking_id !== wantId) {
            return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
          }
          if (wantCode && String(row.booking_code) !== wantCode) {
            return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
          }
          extra.body.booking_id = row.booking_id;
          extra.body.booking_code = row.booking_code;
        } catch (_) {
          return { ok: false, error: 'booking_conversation_mismatch', status: 409 };
        }
      }
      const facts = await loadAdmissionFacts(pg, conversationId, user, extra);
      if (!facts) return { ok: false, error: 'admission_facts_required', status: 409 };
      const createPhone = extra && extra.action === 'booking_create'
        && extra.body && (extra.body.phone || extra.body.guest_phone);
      if (createPhone && facts.phone) {
        const norm = (v) => String(v || '').replace(/\D/g, '');
        if (norm(createPhone) && norm(facts.phone) && norm(createPhone) !== norm(facts.phone)) {
          return { ok: false, error: 'phone_conversation_mismatch', status: 409 };
        }
      }
      const admitted = await admitSupervisorBusinessAction(store, {
        user,
        action: extra && extra.action,
        conversation_id: conversationId,
        body: extra && extra.body || {},
        query: extra && extra.query || {},
        incident_id: extra && extra.incident_id,
        lease_token: lease.token,
        step,
        now: new Date(),
        halt: isSupervisorHalt(process.env),
        factsLoaded: true,
        pause: facts.pause,
        lunaMode: facts.lunaMode,
        lastStaffReplyAt: facts.lastStaffReplyAt,
      });
      if (admitted && admitted.ok && extra && extra.body && admitted.operation_key) {
        extra.body.idempotency_key = admitted.operation_key;
      }
      return admitted;
    });
  }

  async function handleEventRead(req, res, user, eventId, query = {}) {
    const tenant = trustedTenant(user);
    if (!user || (!tenant.clientId && !tenant.clientSlug)) {
      return deps.sendJSON(res, 403, { success: false, error: 'trusted_tenant_required' });
    }
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    let cursor = null;
    if (!eventId && query.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
        if (!cursor || !cursor.created_at || !UUID.test(String(cursor.id))) throw new Error('invalid');
      } catch (_) {
        return deps.sendJSON(res, 400, { success: false, error: 'invalid_cursor' });
      }
    }
    const rows = await deps.withPgClient(async (pg) => {
      const vals = [tenant.clientId, tenant.clientSlug];
      let detail = '';
      if (eventId) { vals.push(eventId); detail = `AND e.id = $${vals.length}::uuid`; }
      let page = '';
      if (cursor) {
        vals.push(cursor.created_at, cursor.id);
        page = `AND (e.created_at, e.id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`;
      }
      vals.push(eventId ? limit : limit + 1);
      const result = await pg.query(
        `SELECT e.* FROM supervisor_events e JOIN conversations c ON c.id = e.conversation_id JOIN clients cl ON cl.id = c.client_id
          WHERE (($1::text <> '' AND cl.id::text = $1) OR ($1::text = '' AND cl.slug = $2))
            AND (e.client_id IS NULL OR e.client_id = cl.id) ${detail} ${page}
          ORDER BY e.created_at DESC, e.id DESC LIMIT $${vals.length}`,
        vals,
      );
      return result.rows.map((row) => {
        const metadata = Object.assign({}, row.metadata || {});
        ['lease_token', 'handoff_claim_token', 'audit_claim_token', 'authorization', 'token'].forEach((key) => delete metadata[key]);
        return Object.assign({}, row, { metadata });
      });
    });
    if (eventId && !rows[0]) return deps.sendJSON(res, 404, { success: false, error: 'event_not_found' });
    if (eventId) return deps.sendJSON(res, 200, { success: true, event: rows[0] });
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit);
    const last = events[events.length - 1];
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
      created_at: last.created_at instanceof Date ? last.created_at.toISOString() : last.created_at,
      id: last.id,
    })).toString('base64url') : null;
    return deps.sendJSON(res, 200, { success: true, events, has_more: hasMore, next_cursor: nextCursor });
  }

  return Object.freeze({
    SUPERVISOR_CLAIM_RE,
    SUPERVISOR_RENEW_RE,
    SUPERVISOR_EVENT_OUTCOME_RE,
    SUPERVISOR_EVENT_LIFECYCLE_RE,
    SUPERVISOR_EVENT_DETAIL_RE,
    SUPERVISOR_EVENTS_PATH,
    SUPERVISOR_AUDIT_PATH,
    handleClaim,
    handleRenew,
    handleOutcome,
    handleLifecycle,
    handleAudit,
    handleEventRead,
    admitFromRequest,
    operationKey,
    captureSupervisorEvent,
    createPgSupervisorStore,
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
  normalizeSupervisorLease,
};
