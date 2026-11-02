'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { isProductionStaffRuntime } = require('./staff-runtime-role');
const { getPauseState } = require('./staff-bot-pause-sql');

const ENABLED_FLAG = 'SUPERVISOR_EVENTS_ENABLED';
const SIGNING_FLAG = 'SUPERVISOR_WEBHOOK_SIGNING';
const HALT_FLAG = 'SUPERVISOR_HALT';

function flagOn(env, name) {
  return String((env || {})[name] || '').trim() === '1';
}

function isSupervisorEventsEnabled(env) {
  return flagOn(env || process.env, ENABLED_FLAG);
}

function isWebhookSigningEnabled(env) {
  return flagOn(env || process.env, SIGNING_FLAG);
}

function isSupervisorHalt(env) {
  return flagOn(env || process.env, HALT_FLAG);
}

function isFranceWolfhouseStaging(env) {
  const e = env || process.env;
  if (isProductionStaffRuntime(e)) return false;
  const deployment = String(e.LUNA_DEPLOYMENT || '').trim().toLowerCase();
  if (deployment.startsWith('sunset') || deployment === 'prod' || deployment === 'production') return false;
  const nodeEnv = String(e.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production') return false;
  const wh = String(e.WOLFHOUSE_ENV || e.WH_ENV || e.STAFF_ENV || '').trim().toLowerCase();
  if (wh === 'prod' || wh === 'production') return false;
  const slug = String(e.DEFAULT_CLIENT_SLUG || e.CLIENT_SLUG || '').trim();
  if (slug && slug !== 'wolfhouse-somo' && slug !== 'wolfhouse') return false;
  const host = String(e.STAFF_QUERY_API_PUBLIC_HOST || e.PUBLIC_HOST || '').toLowerCase();
  if (host && host.includes('lunafrontdesk.com') && !host.includes('staging')) return false;
  if (wh === 'staging') return true;
  if (nodeEnv === 'staging') return true;
  if (deployment === 'wolfhouse-staging' || deployment === 'staging') return true;
  if (host.includes('staff-staging')) return true;
  return false;
}

function shouldStartSupervisorEventsLoop(env) {
  const e = env || process.env;
  return isSupervisorEventsEnabled(e) && isFranceWolfhouseStaging(e);
}

function isSupervisorAccount(user, env) {
  if (!user || typeof user !== 'object') return false;
  const expected = String((env || process.env).LUNA_SUPERVISOR_STAFF_USER_ID || '').trim().toLowerCase();
  const actual = String(user.staff_user_id || '').trim().toLowerCase();
  if (!expected || !actual || expected !== actual) return false;
  return String(user.role || '').toLowerCase() === 'admin';
}

function sourceKey({ environment, runtime, kind, rowId, revision }) {
  return [environment, runtime, kind, rowId, revision].map((p) => String(p || '').trim()).join(':');
}

function isNonDispatchableSupervisorEvent(input) {
  return isWebhookWakeBlocked(input);
}

function encodeSupervisorCheckpoint(cursor) {
  if (cursor == null) return '';
  if (typeof cursor === 'string') return cursor;
  return JSON.stringify(cursor);
}

function decodeSupervisorCheckpoint(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw);
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') return parsed;
    return parsed;
  } catch (_) {
    return s;
  }
}

function operationKey(incidentId, step) {
  return `supervisor:${incidentId}:${step}`;
}

function classifyPauseOwner(pausedBy) {
  const by = String(pausedBy || '').trim();
  if (!by) return 'unproven';
  if (/^luna_flag_needs_human$/i.test(by)) return 'luna';
  if (/^(luna|bot|guest_luna|luna_guest|guest_bot)$/i.test(by)) return 'luna';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(by) || by.indexOf('@') !== -1) {
    return 'staff';
  }
  if (/^(staff_portal|supervisor_watchdog|staff)$/i.test(by)) return 'staff';
  return 'unproven';
}

function resolveSupervisorWriteTarget(input = {}) {
  const body = input.body || {};
  const query = input.query || {};
  const extra = input.extra || {};
  const bodyId = String(body.conversation_id || body.conversationId || '').trim();
  const extraId = String(extra.conversation_id || '').trim();
  const queryId = String(query.conversation_id || '').trim();
  if (bodyId && queryId && bodyId !== queryId) {
    return { ok: false, error: 'conversation_mismatch' };
  }
  if (bodyId && extraId && extraId !== bodyId) {
    return { ok: false, error: 'conversation_mismatch' };
  }
  const conversation_id = bodyId || extraId || '';
  if (!conversation_id) return { ok: false, error: 'conversation_required' };
  return { ok: true, conversation_id };
}

function shouldEmitSupervisorSendAudit(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.idempotent_replay === true) return false;
  if (result.send_performed === true && result.whatsapp_message_id) return true;
  if (result.success === true && result.whatsapp_message_id && result.send_performed !== false) return true;
  return false;
}

function shouldRecordSupervisorCompletion(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  if (receipt.effect === 'mutated') return true;
  if (receipt.effect === 'replayed') {
    return !!(receipt.prior_operation_key || receipt.operation_key || receipt.idempotency_key);
  }
  return false;
}

function normalizeSupervisorCompletionReceipt(receipt, payload) {
  const r = receipt && typeof receipt === 'object' ? receipt : {};
  const p = payload && typeof payload === 'object' ? payload : {};
  const booking = p.booking && typeof p.booking === 'object' ? p.booking : {};
  const note = p.note && typeof p.note === 'object' ? p.note : {};
  return {
    effect: r.effect || null,
    edit_type: r.edit_type || p.edit_type || r.note_op || null,
    booking_id: r.booking_id || booking.booking_id || booking.id || p.booking_id || null,
    booking_code: r.booking_code || booking.booking_code || p.booking_code || null,
    resource_id: r.resource_id || r.note_id || note.id || note.note_id || p.deleted_note_id || p.payment_id || null,
    prior_operation_key: r.prior_operation_key || null,
    operation_key: r.operation_key || r.idempotency_key || null,
    idempotency_key: r.idempotency_key || null,
  };
}

function supervisorAuditIdentity(input) {
  const originalKey = (input && (input.prior_operation_key || input.operation_key)) || '';
  return [
    'supervisor-audit',
    String(originalKey),
    String((input && input.action) || ''),
    String((input && input.edit_type) || ''),
    String((input && (input.booking_id || input.booking_code)) || ''),
    String((input && input.resource_id) || ''),
  ].join(':');
}

function isWebhookWakeBlocked(input) {
  const meta = input && input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  if (meta.wake_supervisor === false) return true;
  const kind = String(input && input.kind || '');
  return kind === 'capture_gap' || kind === 'audit_retry';
}

function supervisorHasHumanFallback(input) {
  if (input && input.cause_incident_id) return true;
  const meta = input && input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  return meta.supervisor_descendant === true && !!(input && input.conversation_id);
}

function initialSupervisorDeliveryStatus(input) {
  if (isWebhookWakeBlocked(input) && supervisorHasHumanFallback(input)) return 'failed';
  if (isWebhookWakeBlocked(input)) return 'diagnostic';
  return (input && input.delivery_status) || 'pending';
}

const PROJECTED_AUDITS = new Set();

function projectSupervisorAudit(store, appendAuditLog, entry) {
  const id = entry && entry.supervisor_audit_identity;
  if (id && PROJECTED_AUDITS.has(id)) return { ok: true, duplicate: true };
  if (store && store.projectedAudits && id && store.projectedAudits.has(id)) {
    return { ok: true, duplicate: true };
  }
  if (typeof appendAuditLog !== 'function') return { ok: false, error: 'audit_sink_required' };
  const sink = appendAuditLog(entry);
  if (sink && sink.ok === false) return sink;
  if (id) {
    PROJECTED_AUDITS.add(id);
    if (store && store.projectedAudits) store.projectedAudits.add(id);
  }
  return sink || { ok: true };
}

function auditClaimExpired(meta, now) {
  if (!meta || meta.audit_claim !== true) return true;
  if (meta.audit_replayed === true) return false;
  const until = meta.audit_claim_until ? new Date(meta.audit_claim_until) : null;
  if (!until || !Number.isFinite(until.getTime())) return true;
  return until.getTime() <= now.getTime();
}

function buildSupervisorAuditRetryEvent(input) {
  const identity = supervisorAuditIdentity(input);
  const action = String((input && input.action) || '').trim();
  return {
    source_key: sourceKey({
      environment: 'france-wolfhouse-staging',
      runtime: 'staff',
      kind: 'handoff',
      rowId: identity,
      revision: 'audit',
    }),
    kind: 'audit_retry',
    obligation: 'handoff',
    conversation_id: (input && input.conversation_id) || null,
    booking_id: (input && input.booking_id) || null,
    booking_code: (input && input.booking_code) || null,
    delivery_status: 'diagnostic',
    metadata: {
      wake_supervisor: false,
      audit_retry: true,
      action,
      edit_type: (input && input.edit_type) || null,
      effect: (input && input.effect) || null,
      resource_id: (input && input.resource_id) || null,
      operation_key: String((input && (input.prior_operation_key || input.operation_key)) || '').trim() || null,
      prior_operation_key: (input && input.prior_operation_key) || null,
      audit_identity: identity,
      audit_entry: (input && input.entry) || null,
    },
  };
}

async function retainFailedSupervisorAudit(store, input) {
  if (!store || typeof store.insertEvent !== 'function') {
    return { ok: false, error: 'audit_retry_store_required' };
  }
  if (!input || !input.entry || typeof input.entry !== 'object') {
    return { ok: false, error: 'audit_entry_required' };
  }
  try {
    const out = await store.insertEvent(buildSupervisorAuditRetryEvent(input));
    if (!out || !out.row) return { ok: false, error: 'audit_retry_unrecorded' };
    return { ok: true, inserted: out.inserted === true, row: out.row };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function replaySupervisorAuditRetries(store, opts = {}) {
  const listed = typeof store.listEvents === 'function' ? await store.listEvents({}) : [];
  const now = opts.now instanceof Date ? opts.now : new Date();
  let replayed = 0;
  let failed = 0;
  for (const ev of listed) {
    const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : {};
    if (meta.audit_retry !== true || !meta.audit_entry) continue;
    if (meta.audit_replayed === true) continue;
    if (meta.audit_claim === true && !auditClaimExpired(meta, now)) continue;
    const entry = Object.assign({}, meta.audit_entry, {
      supervisor_audit_identity: meta.audit_identity || supervisorAuditIdentity({
        operation_key: meta.prior_operation_key || meta.operation_key,
        prior_operation_key: meta.prior_operation_key,
        action: meta.action,
        edit_type: meta.edit_type,
        booking_id: ev.booking_id,
        booking_code: ev.booking_code,
        resource_id: meta.resource_id,
      }),
    });
    let claimed = ev;
    if (typeof store.claimAuditReplay === 'function') {
      claimed = await store.claimAuditReplay(ev.id, now, opts.claimLeaseMs || 30000);
      if (!claimed) continue;
    } else {
      await store.updateEvent(ev.id, {
        metadata: Object.assign({}, meta, {
          audit_claim: true,
          audit_claim_until: new Date(now.getTime() + (opts.claimLeaseMs || 30000)).toISOString(),
        }),
      });
    }
    const claimedMeta = claimed.metadata && typeof claimed.metadata === 'object' ? claimed.metadata : meta;
    if (claimedMeta.audit_append_ok === true) {
      await store.updateEvent(ev.id, {
        delivery_status: 'diagnostic',
        metadata: Object.assign({}, claimedMeta, { audit_replayed: true, audit_claim: false }),
        last_error: null,
      });
      replayed += 1;
      continue;
    }
    try {
      const sink = projectSupervisorAudit(store, opts.appendAuditLog, entry);
      if (sink && sink.ok === false) throw new Error(sink.error || 'audit_sink_failed');
      await store.updateEvent(ev.id, {
        delivery_status: 'diagnostic',
        metadata: Object.assign({}, claimedMeta, {
          audit_replayed: true,
          audit_claim: false,
          audit_append_ok: true,
        }),
        last_error: null,
      });
      replayed += 1;
    } catch (err) {
      failed += 1;
      await store.updateEvent(ev.id, {
        metadata: Object.assign({}, claimedMeta, { audit_claim: false, audit_claim_until: null }),
        last_error: `audit_replay_failed:${err && err.message || err}`,
      });
    }
  }
  return { ok: failed === 0, replayed, failed };
}

function bindCompleteDispatchParams(id, workerId, patch, now) {
  const ts = now instanceof Date ? now : new Date();
  const vals = [id, workerId, ts];
  const fields = [];
  Object.keys(patch || {}).forEach((k) => {
    if (patch[k] === undefined) return;
    const raw = patch[k];
    vals.push(typeof raw === 'object' && raw !== null && !(raw instanceof Date) ? JSON.stringify(raw) : raw);
    fields.push(`${k} = $${vals.length}`);
  });
  const sql = `UPDATE supervisor_events SET ${fields.join(', ')}, updated_at = NOW()
         WHERE id = $1 AND dispatch_worker_id = $2
           AND dispatch_lease_until IS NOT NULL AND dispatch_lease_until >= $3
         RETURNING *`;
  return { sql, vals, fields };
}

function nowIso(now) {
  return (now instanceof Date ? now : new Date()).toISOString();
}

function clone(row) {
  return JSON.parse(JSON.stringify(row));
}

function createMemorySupervisorStore() {
  const events = [];
  const incidents = [];
  const lifecycle = [];
  const checkpoints = {};
  let seq = 0;

  return {
    events,
    incidents,
    lifecycle,
    checkpoints,
    projectedAudits: new Set(),
    async insertEvent(input) {
      const existing = events.find((e) => e.source_key === input.source_key);
      if (existing) return { inserted: false, row: clone(existing) };
      const row = {
        id: input.id || `evt-${++seq}`,
        client_id: input.client_id || null,
        conversation_id: input.conversation_id || null,
        booking_id: input.booking_id || null,
        booking_code: input.booking_code || null,
        kind: input.kind,
        reason: input.reason || null,
        obligation: input.obligation,
        source_key: input.source_key,
        cause_incident_id: input.cause_incident_id || null,
        delivery_status: initialSupervisorDeliveryStatus(input),
        attempts: 0,
        next_retry_at: null,
        last_error: null,
        dispatch_worker_id: null,
        dispatch_lease_until: null,
        acked_at: null,
        outcome: null,
        outcome_payload: {},
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
        created_at: input.created_at || nowIso(),
        updated_at: nowIso(),
      };
      events.push(row);
      return { inserted: true, row: clone(row) };
    },
    async getEvent(id) {
      const row = events.find((e) => e.id === id);
      return row ? clone(row) : null;
    },
    async updateEvent(id, patch) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return clone(row);
    },
    async listDueEvents(now, { limit } = {}) {
      const ts = now instanceof Date ? now : new Date(now || Date.now());
      const due = events.filter((e) => {
        const leaseExpired = !e.dispatch_lease_until || new Date(e.dispatch_lease_until) <= ts;
        const retryReady = !e.next_retry_at || new Date(e.next_retry_at) <= ts;
        if (!retryReady || !leaseExpired) return false;
        if (e.delivery_status === 'diagnostic') return false;
        if (isWebhookWakeBlocked(e) && !supervisorHasHumanFallback(e)) return false;
        if (e.delivery_status === 'pending') return true;
        if (e.delivery_status === 'dispatched' && leaseExpired) return true;
        return false;
      });
      return due.slice(0, limit || 4).map(clone);
    },
    async claimDispatch(id, workerId, leaseUntil) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      const now = new Date();
      if (row.dispatch_lease_until && new Date(row.dispatch_lease_until) > now) return null;
      if (row.next_retry_at && new Date(row.next_retry_at) > now) return null;
      if (row.delivery_status !== 'pending' && row.delivery_status !== 'dispatched') return null;
      row.dispatch_worker_id = workerId;
      row.dispatch_lease_until = leaseUntil instanceof Date ? leaseUntil.toISOString() : leaseUntil;
      row.delivery_status = 'dispatched';
      row.attempts = (row.attempts || 0) + 1;
      row.updated_at = nowIso();
      return clone(row);
    },
    async completeDispatch(id, workerId, patch, now) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      if (row.dispatch_worker_id !== workerId) return null;
      const ts = now instanceof Date ? now : new Date();
      if (!row.dispatch_lease_until || new Date(row.dispatch_lease_until) < ts) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return clone(row);
    },
    async claimHandoffFallback(id, now, leaseMs) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      if (meta.handoff_recorded === true) return null;
      const ts = now instanceof Date ? now : new Date();
      const until = meta.handoff_claim_until ? new Date(meta.handoff_claim_until) : null;
      if (meta.handoff_claim === true && until && Number.isFinite(until.getTime()) && until.getTime() > ts.getTime()) {
        return null;
      }
      row.metadata = Object.assign({}, meta, {
        handoff_claim: true,
        handoff_claim_until: new Date(ts.getTime() + (leaseMs || 30000)).toISOString(),
      });
      row.updated_at = nowIso();
      return clone(row);
    },
    async claimAuditReplay(id, now, leaseMs) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      if (meta.audit_replayed === true) return null;
      const ts = now instanceof Date ? now : new Date();
      if (meta.audit_claim === true && !auditClaimExpired(meta, ts)) return null;
      row.metadata = Object.assign({}, meta, {
        audit_claim: true,
        audit_claim_until: new Date(ts.getTime() + (leaseMs || 30000)).toISOString(),
        audit_claim_token: crypto.randomBytes(8).toString('hex'),
      });
      row.updated_at = nowIso();
      return clone(row);
    },
    async getCheckpoint(name) {
      return decodeSupervisorCheckpoint(checkpoints[name]);
    },
    async setCheckpoint(name, cursor) {
      checkpoints[name] = encodeSupervisorCheckpoint(cursor);
    },
    async insertIncident(input) {
      const now = new Date();
      const live = incidents.find((i) => i.conversation_id === input.conversation_id && i.status === 'open');
      if (live) {
        if (live.lease_until && new Date(live.lease_until) > now) {
          return { joined: true, incident: clone(live) };
        }
        live.status = 'expired';
        live.closed_reason = 'lease_expired';
      }
      const incident = {
        id: input.id || `inc-${++seq}`,
        conversation_id: input.conversation_id,
        event_id: input.event_id,
        obligation: input.obligation,
        after_message_id: input.after_message_id || null,
        lease_token: input.lease_token,
        lease_until: input.lease_until,
        staff_user_id: input.staff_user_id || null,
        pause_permit_transition_id: input.pause_permit_transition_id || null,
        status: 'open',
        closed_reason: null,
        created_at: nowIso(),
      };
      incidents.push(incident);
      return { joined: false, incident: clone(incident) };
    },
    async getOpenIncident(conversationId) {
      const row = incidents.find((i) => i.conversation_id === conversationId && i.status === 'open');
      return row ? clone(row) : null;
    },
    async getIncident(id) {
      const row = incidents.find((i) => i.id === id);
      return row ? clone(row) : null;
    },
    async updateIncident(id, patch) {
      const row = incidents.find((i) => i.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return clone(row);
    },
    async renewIncident(input) {
      const row = incidents.find((i) => i.id === input.incident_id);
      if (!row || row.status !== 'open') return null;
      if (row.lease_token !== input.lease_token) return null;
      if (input.staff_user_id && String(row.staff_user_id) !== String(input.staff_user_id)) return null;
      if (input.obligation && row.obligation && String(row.obligation) !== String(input.obligation)) return null;
      const now = input.now instanceof Date ? input.now : new Date();
      if (row.lease_until && new Date(row.lease_until) < now) return null;
      row.lease_until = input.lease_until;
      row.updated_at = nowIso();
      return clone(row);
    },
    async appendLifecycle(entry) {
      lifecycle.push({ ...entry, recorded_at: nowIso() });
      return { ok: true };
    },
    async listEvents(filter = {}) {
      const statuses = filter.statuses;
      return events.filter((e) => !statuses || statuses.includes(e.delivery_status)).map(clone);
    },
  };
}

async function captureSupervisorEvent(store, input) {
  if (!input || !input.source_key || !input.kind || !input.obligation) {
    throw new Error('supervisor_event_required');
  }
  return store.insertEvent(input);
}

async function catchUpSupervisorSources(store, adapters, opts = {}) {
  const batchSize = opts.batchSize || 100;
  let captured = 0;
  let gaps = 0;
  let stale = 0;
  for (const adapter of adapters || []) {
    if (adapter.retentionGap) {
      await captureSupervisorEvent(store, {
        source_key: sourceKey({
          environment: 'france-wolfhouse-staging',
          runtime: 'staff',
          kind: 'capture_gap',
          rowId: adapter.name,
          revision: String(adapter.name),
        }),
        kind: 'capture_gap',
        obligation: 'handoff',
        reason: 'source retention prevents replay',
        client_id: adapter.client_id || null,
      });
      gaps += 1;
      continue;
    }
    const cursor0 = await store.getCheckpoint(adapter.name);
    let cursor = cursor0;
    let pages = 0;
    const maxPages = opts.maxPages || 20;
    while (pages < maxPages) {
      pages += 1;
      const batch = await adapter.listSince(cursor, batchSize);
      if (!batch || !batch.length) break;
      for (const item of batch) {
        const out = await captureSupervisorEvent(store, item);
        if (out.inserted) captured += 1;
        await store.setCheckpoint(adapter.name, item.cursor);
        cursor = item.cursor;
      }
      if (batch.length < batchSize) break;
    }
  }
  if (opts.reenable) {
    const listed = typeof store.listEvents === 'function'
      ? await store.listEvents()
      : [];
    for (const ev of listed) {
      let resolved = false;
      if (typeof opts.currentState === 'function') {
        const live = await opts.currentState(ev);
        if (live && live.resolved === true) resolved = true;
        if (live && live.resolved === false) resolved = false;
      }
      if (resolved) {
        await store.updateEvent(ev.id, { delivery_status: 'stale_on_reenable', outcome: ev.outcome || 'resolved' });
        stale += 1;
      }
    }
  }
  return { captured, gaps, stale };
}

function createWebhookSender(opts = {}) {
  const fetchFn = opts.fetch || global.fetch;
  const signingEnabled = opts.signingEnabled === true;
  const sign = opts.sign || null;
  const webhookUrl = opts.webhookUrl || '';
  const secret = opts.secret || '';
  const timeoutMs = opts.timeoutMs || 10000;

  return {
    signingEnabled,
    async post(event) {
      if (!signingEnabled || typeof sign !== 'function') {
        return { ok: false, error: 'signing_unconfirmed' };
      }
      if (!webhookUrl) return { ok: false, error: 'webhook_url_missing' };
      const payload = {
        event_id: event.id,
        kind: event.kind,
        obligation: event.obligation,
        conversation_id: event.conversation_id,
        booking_code: event.booking_code,
        reason: event.reason,
        source_key: event.source_key,
      };
      const body = JSON.stringify(payload);
      const headers = Object.assign({ 'content-type': 'application/json' }, sign(body, secret) || {});
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
      try {
        const res = await fetchFn(webhookUrl, {
          method: 'POST',
          headers,
          body,
          signal: ac ? ac.signal : undefined,
        });
        const status = res && res.status;
        if (status >= 200 && status < 300) return { ok: true, status };
        return { ok: false, error: `http_${status}`, status };
      } catch (err) {
        return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message || err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function dispatchDueEvents(store, sender, opts = {}) {
  if (!opts.enabled) return { skipped: 'disabled', posted: 0 };
  if (!sender || sender.signingEnabled !== true) {
    const duePreview = await store.listDueEvents(opts.now, { limit: 20 });
    for (const ev of duePreview) {
      if (isWebhookWakeBlocked(ev) && !supervisorHasHumanFallback(ev)) continue;
      if (ev.cause_incident_id) continue;
      await store.updateEvent(ev.id, { last_error: 'signing_unconfirmed' });
    }
    return { skipped: 'signing_unconfirmed', posted: 0 };
  }
  const due = await store.listDueEvents(opts.now, { limit: opts.maxConcurrent || 4 });
  let posted = 0;
  let suppressed = 0;
  let failedSaves = 0;
  const leaseUntil = new Date((opts.now instanceof Date ? opts.now : new Date()).getTime() + 30 * 1000);
  for (const ev of due) {
    if (isWebhookWakeBlocked(ev) || ev.delivery_status === 'diagnostic') {
      if (supervisorHasHumanFallback(ev)) {
        await persistSupervisorNeedsHuman(opts, {
          ...ev,
          delivery_status: ev.delivery_status === 'failed' ? 'failed' : ev.delivery_status,
        }, ev.last_error || ev.kind || 'supervisor_descendant_failed');
      }
      continue;
    }
    const workerId = `staff-loop:${ev.id}:${crypto.randomBytes(8).toString('hex')}`;
    if (ev.cause_incident_id) {
      await store.updateEvent(ev.id, { delivery_status: 'suppressed_recursive' });
      suppressed += 1;
      const saved = await persistSupervisorNeedsHuman(opts, {
        ...ev,
        delivery_status: 'suppressed_recursive',
      }, 'supervisor_recursive_suppressed');
      if (!saved || saved.ok === false) failedSaves += 1;
      continue;
    }
    const claimed = await store.claimDispatch(ev.id, workerId, leaseUntil);
    if (!claimed) continue;
    const result = await sender.post(claimed);
    if (result.ok) {
      const done = await store.completeDispatch(ev.id, workerId, {
        delivery_status: 'acked',
        acked_at: nowIso(new Date()),
        last_error: null,
      }, new Date());
      if (!done) continue;
      posted += 1;
    } else {
      const attempts = claimed.attempts || 1;
      const backoffMs = Math.min(60 * 1000, 2000 * (2 ** Math.max(0, attempts - 1)));
      const failed = attempts >= 3;
      const done = await store.completeDispatch(ev.id, workerId, {
        delivery_status: failed ? 'failed' : 'pending',
        last_error: result.error,
        next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
        dispatch_lease_until: null,
      }, new Date());
      if (!done) continue;
      if (failed) {
        const saved = await persistSupervisorNeedsHuman(opts, {
          ...claimed,
          last_error: result.error,
          delivery_status: 'failed',
        }, result.error || 'supervisor_dispatch_failed');
        if (!saved || saved.ok === false) failedSaves += 1;
      }
    }
  }
  return { posted, suppressed, failedSaves };
}

function newLeaseToken() {
  return crypto.randomBytes(16).toString('hex');
}

async function claimSupervisorIncident(store, input) {
  const event = await store.getEvent(input.event_id);
  if (!event) return { ok: false, error: 'event_not_found' };
  if (event.conversation_id !== input.conversation_id) return { ok: false, error: 'conversation_mismatch' };
  const now = input.now instanceof Date ? input.now : new Date();
  const leaseUntil = new Date(now.getTime() + 3 * 60 * 1000).toISOString();
  const transitionId = input.pause_permit_transition_id
    || (event.metadata && event.metadata.needs_human_transition_id)
    || null;
  const out = await store.insertIncident({
    conversation_id: input.conversation_id,
    event_id: event.id,
    obligation: event.obligation,
    after_message_id: input.after_message_id || null,
    lease_token: newLeaseToken(),
    lease_until: leaseUntil,
    staff_user_id: input.user && input.user.staff_user_id,
    pause_permit_transition_id: transitionId,
  });
  return { ok: true, joined: out.joined === true, incident: out.incident };
}

async function renewSupervisorClaim(store, input) {
  const incident = await store.getIncident(input.incident_id);
  if (!incident) return { ok: false, error: 'incident_not_found' };
  if (incident.status !== 'open') return { ok: false, error: 'claim_expired' };
  if (incident.lease_token !== input.lease_token) return { ok: false, error: 'claim_expired' };
  const now = input.now instanceof Date ? input.now : new Date();
  if (new Date(incident.lease_until) < now) return { ok: false, error: 'claim_expired' };
  if (input.user && incident.staff_user_id && String(incident.staff_user_id) !== String(input.user.staff_user_id)) {
    return { ok: false, error: 'owner_mismatch' };
  }
  if (input.obligation && incident.obligation && String(incident.obligation) !== String(input.obligation)) {
    return { ok: false, error: 'obligation_mismatch' };
  }
  const leaseUntil = new Date(now.getTime() + 3 * 60 * 1000).toISOString();
  if (typeof store.renewIncident === 'function') {
    const updated = await store.renewIncident({
      incident_id: incident.id,
      lease_token: incident.lease_token,
      staff_user_id: incident.staff_user_id,
      obligation: incident.obligation,
      lease_until: leaseUntil,
      now,
    });
    if (!updated) return { ok: false, error: 'claim_expired' };
    return { ok: true, incident: updated };
  }
  const updated = await store.updateIncident(incident.id, { lease_until: leaseUntil });
  return { ok: true, incident: updated };
}

function stayOutReason({ pause, lunaMode, lastStaffReplyAt, staffNeedsHuman, now }) {
  if (pause && pause.paused === true && (pause.owner === 'staff' || pause.owner === 'unproven')) return 'stayed_out';
  const mode = String(lunaMode || '').toLowerCase();
  if (mode === 'off' || mode === 'draft') return 'stayed_out';
  if (lastStaffReplyAt) {
    const ts = new Date(lastStaffReplyAt).getTime();
    const n = (now instanceof Date ? now : new Date()).getTime();
    if (Number.isFinite(ts) && n - ts < 10 * 60 * 1000) return 'stayed_out';
  }
  if (staffNeedsHuman === true) return 'stayed_out';
  return null;
}

async function admitSupervisorBusinessAction(store, input) {
  const user = input.user;
  if (!isSupervisorAccount(user, input.env)) return { ok: true, skipped: 'not_supervisor' };
  if (input.halt === true) return { ok: false, error: 'supervisor_halted', status: 409 };
  if (!input.lease_token) return { ok: false, error: 'claim_expired', status: 409 };
  if (input.factsLoaded !== true) return { ok: false, error: 'admission_facts_required', status: 409 };
  const target = resolveSupervisorWriteTarget({
    body: input.body || {},
    query: input.query || {},
    extra: { conversation_id: input.conversation_id },
  });
  if (!target.ok) return { ok: false, error: target.error, status: 409 };
  const conversationId = target.conversation_id;
  const incident = input.incident_id
    ? await store.getIncident(input.incident_id)
    : await store.getOpenIncident(conversationId);
  if (!incident || incident.status !== 'open') return { ok: false, error: 'claim_expired', status: 409 };
  if (incident.lease_token !== input.lease_token) {
    return { ok: false, error: 'claim_expired', status: 409 };
  }
  const now = input.now instanceof Date ? input.now : new Date();
  if (new Date(incident.lease_until) < now) return { ok: false, error: 'claim_expired', status: 409 };
  if (incident.conversation_id !== conversationId) {
    return { ok: false, error: 'conversation_mismatch', status: 409 };
  }
  if (input.user && incident.staff_user_id && String(incident.staff_user_id) !== String(input.user.staff_user_id)) {
    return { ok: false, error: 'owner_mismatch', status: 409 };
  }
  const stayed = stayOutReason(input);
  if (stayed) return { ok: false, error: stayed, status: 409 };
  return {
    ok: true,
    incident,
    pause: input.pause || { paused: false },
    operation_key: operationKey(incident.id, input.step || 'step'),
    conversation_id: conversationId,
  };
}

async function persistSupervisorNeedsHuman(opts, event, reason) {
  if (event && event.metadata && event.metadata.handoff_recorded === true) {
    return { ok: true, already: true };
  }
  if (opts && opts.store && event && event.id && typeof opts.store.claimHandoffFallback === 'function') {
    const claimed = await opts.store.claimHandoffFallback(event.id, opts.now, opts.claimLeaseMs || 30000);
    if (!claimed) {
      const live = typeof opts.store.getEvent === 'function' ? await opts.store.getEvent(event.id) : event;
      if (live && live.metadata && live.metadata.handoff_recorded === true) {
        return { ok: true, already: true };
      }
      return { ok: true, busy: true };
    }
    event = claimed;
  } else if (event && event.metadata && event.metadata.handoff_claim === true) {
    const until = event.metadata.handoff_claim_until ? new Date(event.metadata.handoff_claim_until) : null;
    const now = opts && opts.now instanceof Date ? opts.now : new Date();
    if (until && Number.isFinite(until.getTime()) && until.getTime() > now.getTime()) {
      return { ok: true, busy: true };
    }
  } else if (event) {
    event.metadata = Object.assign({}, event.metadata || {}, {
      handoff_claim: true,
      handoff_claim_until: new Date(Date.now() + 30000).toISOString(),
    });
  }
  const writer = opts && opts.needsHumanWriter;
  const row = {
    conversation_id: event && event.conversation_id,
    booking_code: event && event.booking_code,
    booking_id: event && event.booking_id,
    reason: reason || (event && event.last_error) || (event && event.kind),
    cause_incident_id: event && event.cause_incident_id || null,
  };
  async function markPending(error) {
    if (opts && opts.store && event && event.id) {
      await opts.store.updateEvent(event.id, {
        last_error: event.last_error || null,
        metadata: Object.assign({}, event.metadata || {}, {
          handoff_claim: false,
          fallback_error: error || reason || 'failed',
        }),
        delivery_status: event.delivery_status === 'suppressed_recursive' ? 'suppressed_recursive' : 'failed',
        next_retry_at: new Date(Date.now() + 15 * 1000).toISOString(),
      });
    }
  }
  if (typeof writer !== 'function') {
    await markPending('needs_human_writer_missing');
    return { ok: false, error: 'needs_human_writer_missing' };
  }
  try {
    const out = await writer(row);
    if (!out || out.ok === false) {
      const err = (out && (out.error || out.reason)) || 'writer_failed';
      await markPending(err);
      return { ok: false, error: err, fallback_error: err };
    }
    if (opts.store && event && event.id) {
      await opts.store.updateEvent(event.id, {
        delivery_status: event.delivery_status === 'suppressed_recursive' ? 'suppressed_recursive' : 'needs_human_recorded',
        metadata: Object.assign({}, event.metadata || {}, {
          handoff_recorded: true,
          supervisor_cause_incident_id: event.cause_incident_id || null,
        }),
      });
    }
    return out;
  } catch (err) {
    await markPending(err && err.message || 'writer_threw');
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function recordSupervisorOutcome(store, input) {
  const event = await store.getEvent(input && input.event_id);
  if (!event) return { ok: false, error: 'event_not_found' };
  if (!input.conversation_id || event.conversation_id !== input.conversation_id) {
    return { ok: false, error: 'conversation_mismatch' };
  }
  const incident = input.incident_id
    ? await store.getIncident(input.incident_id)
    : await store.getOpenIncident(event.conversation_id);
  if (!incident || incident.status !== 'open') return { ok: false, error: 'claim_expired' };
  if (incident.conversation_id !== event.conversation_id) return { ok: false, error: 'conversation_mismatch' };
  if (incident.event_id && String(incident.event_id) !== String(event.id)) {
    return { ok: false, error: 'event_mismatch' };
  }
  if (!input.lease_token || incident.lease_token !== input.lease_token) {
    return { ok: false, error: 'claim_expired' };
  }
  const now = input.now instanceof Date ? input.now : new Date();
  if (incident.lease_until && new Date(incident.lease_until) < now) {
    return { ok: false, error: 'claim_expired' };
  }
  if (input.user && incident.staff_user_id && String(incident.staff_user_id) !== String(input.user.staff_user_id)) {
    return { ok: false, error: 'owner_mismatch' };
  }
  const obligation = event.obligation;
  if (incident.obligation && String(incident.obligation) !== String(obligation)) {
    return { ok: false, error: 'obligation_mismatch' };
  }
  if (input.obligation && String(input.obligation) !== String(obligation)) {
    return { ok: false, error: 'obligation_mismatch' };
  }
  const guestDelivered = !!(event.metadata && event.metadata.guest_delivered === true);
  const sendLike = obligation === 'guest_message'
    || obligation === 'guest_message_send'
    || obligation === 'send';
  if (sendLike && !guestDelivered) {
    const row = await store.updateEvent(input.event_id, {
      outcome: input.outcome,
    });
    return { ok: true, pending: true, closed: false, row };
  }
  const ownerResolved = !!(event.metadata && event.metadata.handoff_recorded === true);
  if (!sendLike && !ownerResolved && !guestDelivered) {
    const row = await store.updateEvent(input.event_id, {
      outcome: input.outcome,
    });
    return { ok: true, pending: true, closed: false, row };
  }
  const row = await store.updateEvent(input.event_id, {
    outcome: input.outcome,
    delivery_status: 'acked',
  });
  if (!row) return { ok: false, error: 'not_found' };
  await store.updateIncident(incident.id, {
    status: 'closed',
    closed_reason: input.outcome || 'outcome',
  });
  return { ok: true, closed: true, row };
}

async function recordSupervisorLifecycle(store, input) {
  if (!input || !input.event_id) return { ok: false, error: 'event_not_found' };
  const event = await store.getEvent(input.event_id);
  if (!event) return { ok: false, error: 'event_not_found' };
  if (input.conversation_id && event.conversation_id !== input.conversation_id) {
    return { ok: false, error: 'conversation_mismatch' };
  }
  if (input.user && !isSupervisorAccount(input.user, input.env)) {
    return { ok: false, error: 'account_mismatch' };
  }
  const kind = input.kind;
  const persisted = await store.appendLifecycle({
    event_id: input.event_id,
    kind,
    payload: input.payload || {},
    halted: input.halted === true,
    expired: input.expired === true,
    staff_user_id: input.user && input.user.staff_user_id,
  });
  if (!persisted || persisted.ok === false) return persisted || { ok: false, error: 'lifecycle_persist_failed' };
  return {
    ok: true,
    kind,
    event_id: event.id,
    conversation_id: event.conversation_id,
    booking_code: event.booking_code || null,
    incident_id: event.cause_incident_id || null,
  };
}

function lunaOwnedPauseMatches(pause, claim) {
  if (!pause || pause.paused !== true) return false;
  if (String(pause.owner || '').toLowerCase() !== 'luna') return false;
  const permit = claim && claim.pause_permit_transition_id;
  if (!permit) return false;
  return String(pause.needs_human_transition_id || '') === String(permit);
}

async function bindLunaPausePermit(pg, pauseRow, transitionId) {
  if (!pg || !pauseRow || !pauseRow.id || !transitionId) return { ok: false };
  if (classifyPauseOwner(pauseRow.paused_by || pauseRow.owner) !== 'luna') return { ok: false };
  await pg.query(
    `UPDATE bot_pause_states
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('needs_human_transition_id', to_jsonb($2::text))
      WHERE id = $1::uuid AND paused = TRUE`,
    [pauseRow.id, String(transitionId)],
  );
  return { ok: true };
}

async function evaluateSendWithSupervisorPermit(body, context, withPauseFn) {
  const pg = context && context.pg;
  const store = context && context.store;
  const incident = store && context.incident_id && typeof store.getIncident === 'function'
    ? await store.getIncident(context.incident_id)
    : (context && context.incident) || null;
  if (pg) {
    try {
      const loaded = await getPauseState(pg, {
        client_slug: (body && (body.client_slug || body.client)) || 'wolfhouse-somo',
        guest_phone: body && body.to,
        conversation_id: body && body.conversation_id,
      });
      if (loaded && loaded.table_missing === true) {
        return { result: { success: false, blocked_reasons: ['gate_pause_authority_unavailable'] } };
      }
      const owner = classifyPauseOwner(loaded && loaded.row && loaded.row.paused_by);
      if (owner === 'staff' || owner === 'global') {
        return { result: { success: false, blocked_reasons: ['gate_bot_paused'] } };
      }
      const liveTid = loaded && loaded.row && loaded.row.metadata
        && (loaded.row.metadata.needs_human_transition_id || loaded.row.metadata.transition_id);
      const permit = incident && incident.pause_permit_transition_id;
      if (permit && liveTid && String(liveTid) !== String(permit)) {
        return { result: { success: false, blocked_reasons: ['gate_pause_permit_mismatch'] } };
      }
    } catch (_) { /* send owner still revalidates */ }
  }
  return withPauseFn(body, context);
}

function hmacSign(body, secret, nowMs) {
  const ts = String(nowMs || Date.now());
  const hex = crypto.createHmac('sha256', String(secret || '')).update(`${ts}.${body}`).digest('hex');
  return {
    'x-supervisor-timestamp': ts,
    'x-supervisor-signature': `v1=${hex}`,
  };
}

function verifyHmac(body, secret, headers, nowMs) {
  const ts = String((headers && (headers['x-supervisor-timestamp'] || headers['X-Supervisor-Timestamp'])) || '');
  const sig = String((headers && (headers['x-supervisor-signature'] || headers['X-Supervisor-Signature'])) || '');
  if (!ts || !sig) return false;
  const age = Math.abs((nowMs || Date.now()) - Number(ts));
  if (!Number.isFinite(Number(ts)) || age > 5 * 60 * 1000) return false;
  const expected = hmacSign(body, secret, Number(ts))['x-supervisor-signature'];
  const got = sig.includes('v1=') ? `v1=${sig.split('v1=').pop()}` : sig;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
  } catch (_) {
    return false;
  }
}

const supervisorSendAls = new AsyncLocalStorage();

async function recordSupervisorCauseOnConversation(pg, conversationId, causeIncidentId, transitionId) {
  if (!pg || !conversationId || !causeIncidentId) return { ok: false, error: 'cause_required' };
  const conv = await pg.query(
    `UPDATE conversations
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
               'supervisor_cause_incident_id', to_jsonb($2::text),
               'supervisor_cause_transition_id', to_jsonb($3::text)
             )
      WHERE id = $1::uuid
        AND ($3::text IS NULL OR needs_human_transition_id::text IS NOT DISTINCT FROM $3::text)
      RETURNING id`,
    [conversationId, String(causeIncidentId), transitionId ? String(transitionId) : null],
  );
  if (!conv.rowCount) return { ok: false, error: 'cause_transition_mismatch' };
  try {
    await pg.query(
      `UPDATE staff_handoffs
          SET metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object('supervisor_cause_incident_id', to_jsonb($2::text))
        WHERE id = (
          SELECT h.id FROM staff_handoffs h
           WHERE h.conversation_id = $1::uuid
             AND h.resolved_at IS NULL
           ORDER BY h.created_at DESC
           LIMIT 1
        )`,
      [conversationId, String(causeIncidentId)],
    );
  } catch (err) {
    if (err && err.code === '42P01') return { ok: true };
    return { ok: false, error: String(err && err.message || err) };
  }
  return { ok: true };
}

async function clearSupervisorCauseOnConversation(pg, conversationId, causeIncidentId) {
  if (!pg || !conversationId) return { ok: false };
  await pg.query(
    `UPDATE conversations
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          - 'supervisor_cause_incident_id'
          - 'supervisor_cause_transition_id'
      WHERE id = $1::uuid
        AND ($2::text IS NULL OR metadata->>'supervisor_cause_incident_id' IS NOT DISTINCT FROM $2::text)`,
    [conversationId, causeIncidentId ? String(causeIncidentId) : null],
  );
  return { ok: true };
}

function runWithSupervisorSendContext(ctx, fn) {
  return supervisorSendAls.run(ctx || {}, fn);
}

function getSupervisorSendContext() {
  return supervisorSendAls.getStore() || null;
}

function trustedSupervisorContext() {
  const ctx = getSupervisorSendContext();
  if (!ctx || !ctx.incident) return undefined;
  return {
    incident_id: ctx.incident.id,
    cause_incident_id: ctx.incident.id,
    lease_token: ctx.incident.lease_token,
    pause_permit_transition_id: ctx.incident.pause_permit_transition_id,
  };
}

async function lookupSupervisorDelivery(pg, ev) {
  const wamid = ev && ev.metadata && ev.metadata.guest_whatsapp_message_id;
  if (!pg || !wamid) return null;
  try {
    const q = await pg.query(
      `SELECT lower(status) AS status
         FROM whatsapp_status_events
        WHERE provider_message_id = $1
        ORDER BY received_at DESC
        LIMIT 1`,
      [String(wamid)],
    );
    const status = q.rows[0] && q.rows[0].status;
    if (!status) return null;
    if (status === 'delivered' || status === 'read') return { delivered: true, status };
    if (status === 'failed' || status === 'undelivered') return { delivered: false, failed: true, status };
    return { delivered: false, status };
  } catch (err) {
    if (err && err.code === '42P01') return null;
    throw err;
  }
}

async function reconcileSupervisorDeliveries(store, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const listed = typeof store.listEvents === 'function'
    ? await store.listEvents({ statuses: ['failed', 'acked', 'suppressed_recursive', 'accepted_pending_delivery'] })
    : [];
  let needsHuman = 0;
  let reconciled = 0;
  let failedSaves = 0;
  for (const ev of listed) {
    if (ev.next_retry_at && new Date(ev.next_retry_at) > now) continue;
    if (ev.delivery_status === 'needs_human_recorded') continue;
    if (ev.metadata && ev.metadata.handoff_recorded === true) continue;
    if (typeof opts.deliveryLookup === 'function') {
      const actual = await opts.deliveryLookup(ev);
      if (actual && actual.delivered) {
        await store.updateEvent(ev.id, {
          delivery_status: 'acked',
          outcome: 'delivered_on_reconcile',
          metadata: Object.assign({}, ev.metadata || {}, { guest_delivered: true }),
        });
        reconciled += 1;
        continue;
      }
      if (actual && actual.failed) {
        const saved = await persistSupervisorNeedsHuman({ ...opts, store }, ev, 'delivery_failed');
        if (saved && saved.busy) continue;
        if (!saved || saved.ok === false) failedSaves += 1;
        else needsHuman += 1;
        continue;
      }
    }
    if (ev.delivery_status === 'acked' && ev.acked_at
        && !(ev.metadata && ev.metadata.guest_delivered === true)) {
      const ackedAt = new Date(ev.acked_at).getTime();
      if (Number.isFinite(ackedAt) && now.getTime() - ackedAt > 15 * 60 * 1000) {
        const saved = await persistSupervisorNeedsHuman(opts, ev, 'acked_never_delivered');
        if (saved && saved.busy) continue;
        if (!saved || saved.ok === false) failedSaves += 1;
        else needsHuman += 1;
      }
    }
    if (ev.delivery_status === 'accepted_pending_delivery' && ev.updated_at) {
      const age = now.getTime() - new Date(ev.updated_at).getTime();
      if (age > 15 * 60 * 1000) {
        const saved = await persistSupervisorNeedsHuman({ ...opts, store }, ev, 'accepted_pending_unknown');
        if (saved && saved.busy) continue;
        if (!saved || saved.ok === false) failedSaves += 1;
        else needsHuman += 1;
      }
    }
    if (ev.delivery_status === 'failed' || ev.delivery_status === 'suppressed_recursive') {
      const out = await persistSupervisorNeedsHuman({ ...opts, store }, ev, ev.last_error || ev.kind);
      if (out && out.busy) continue;
      if (out && out.ok) needsHuman += 1;
      else failedSaves += 1;
    }
  }
  return { ok: failedSaves === 0, needsHuman, reconciled, failedSaves };
}

async function reclassifyRetainedNoWake(store) {
  const listed = typeof store.listEvents === 'function'
    ? await store.listEvents({ statuses: ['pending', 'dispatched', 'diagnostic'] })
    : [];
  let diagnostic = 0;
  let failed = 0;
  for (const ev of listed) {
    if (!isWebhookWakeBlocked(ev)) continue;
    if (supervisorHasHumanFallback(ev)) {
      await store.updateEvent(ev.id, { delivery_status: 'failed' });
      failed += 1;
    } else {
      await store.updateEvent(ev.id, { delivery_status: 'diagnostic' });
      diagnostic += 1;
    }
  }
  return { diagnostic, failed };
}

async function runSupervisorStaffTick(opts = {}) {
  const env = opts.env || process.env;
  const enabled = opts.enabled === true || (opts.enabled == null && isSupervisorEventsEnabled(env));
  if (!enabled) return { ok: true, skipped: 'disabled' };
  const store = opts.store;
  if (!store) return { ok: false, error: 'store_required' };
  const catchUp = await catchUpSupervisorSources(store, opts.adapters || [], {
    reenable: opts.reenable === true,
    currentState: opts.currentState,
    now: opts.now,
  });
  const sender = opts.sender || createWebhookSender({
    signingEnabled: isWebhookSigningEnabled(env),
    webhookUrl: env.SUPERVISOR_WEBHOOK_URL,
    secret: env.SUPERVISOR_WEBHOOK_SECRET,
  });
  const retained = await reclassifyRetainedNoWake(store);
  const dispatch = await dispatchDueEvents(store, sender, {
    enabled: true,
    now: opts.now || new Date(),
    workerId: opts.workerId || `staff-loop:${process.pid}:${crypto.randomBytes(8).toString('hex')}`,
    needsHumanWriter: opts.needsHumanWriter,
    store,
  });
  const reconcile = await reconcileSupervisorDeliveries(store, opts);
  const auditReplay = await replaySupervisorAuditRetries(store, {
    appendAuditLog: opts.appendAuditLog,
  });
  const failedSaves = Number((dispatch && dispatch.failedSaves) || 0) + Number((reconcile && reconcile.failedSaves) || 0);
  return {
    ok: reconcile.ok !== false && auditReplay.ok !== false && !failedSaves,
    failedSaves,
    error: failedSaves ? `failedSaves:${failedSaves}` : undefined,
    catchUp, dispatch, reconcile, auditReplay, retained,
  };
}

function startSupervisorEventsLoop(opts = {}) {
  const intervalMs = opts.intervalMs || 20000;
  const tick = opts.tick || (() => runSupervisorStaffTick(opts));
  const timer = setInterval(() => {
    Promise.resolve()
      .then(() => tick())
      .then((out) => {
        if (out && out.ok === false && typeof opts.onVisibleFailure === 'function') {
          opts.onVisibleFailure(out);
        }
      })
      .catch((err) => {
        if (typeof opts.onVisibleFailure === 'function') {
          opts.onVisibleFailure({ ok: false, error: String(err && err.message || err) });
        }
      });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

const LOOKOUT_PIN = Object.freeze({
  environment: 'staging',
  runtime: 'wolfhouse',
  client_slug: 'wolfhouse-somo',
});

async function recordVisibleCaptureGap(store, reason, extra) {
  const gapKey = sourceKey({
    environment: LOOKOUT_PIN.environment,
    runtime: LOOKOUT_PIN.runtime,
    kind: 'capture_gap',
    rowId: extra && extra.rowId || 'capture',
    revision: String(reason),
  });
  try {
    await store.insertEvent({
      source_key: gapKey,
      kind: 'capture_gap',
      obligation: 'handoff',
      reason: String(reason),
      metadata: Object.assign({ wake_supervisor: false }, extra && extra.metadata ? extra.metadata : {}),
    });
  } catch (err) {
    throw new Error(`capture_gap_unrecorded:${reason}:${err && err.message || err}`);
  }
}

function createSupervisorEventInbox(store) {
  if (!store || typeof store.insertEvent !== 'function') throw new Error('supervisor_inbox_store_required');
  return {
    async capture(event) {
      try {
        if (!event || !event.source_key || !event.kind || !event.obligation) {
          await recordVisibleCaptureGap(store, 'supervisor_capture_missing_source_key', {
            rowId: event && event.kind || 'unknown',
          });
          throw new Error('supervisor_capture_missing_source_key');
        }
        const out = await captureSupervisorEvent(store, event);
        if (out && out.error) return { ok: false, error: out.error, inserted: false };
        if (event.checkpoint_name && event.cursor != null && event.cursor !== '') {
          await store.setCheckpoint(event.checkpoint_name, event.cursor);
        }
        return { ok: true, inserted: out.inserted === true, row: out.row };
      } catch (err) {
        if (String(err && err.message) === 'supervisor_capture_missing_source_key') throw err;
        await recordVisibleCaptureGap(store, String(err && err.message || err), {
          rowId: event && event.source_key || 'capture-fail',
        });
        throw err;
      }
    },
  };
}

function loadLookoutDetectorScan() {
  try {
    const mod = require('./luna-supervisor-lookout-detectors');
    if (mod && typeof mod.runLookoutDetectorScan === 'function') return mod.runLookoutDetectorScan;
    return null;
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

async function runSupervisorDetectorTick(opts = {}) {
  const enabled = opts.enabled === true || (opts.enabled == null && isSupervisorEventsEnabled(opts.env || process.env));
  if (!enabled) return { skipped: 'disabled' };
  const store = opts.store;
  const eventInbox = opts.eventInbox || (store ? createSupervisorEventInbox(store) : null);
  const scan = opts.scan === undefined ? loadLookoutDetectorScan() : opts.scan;
  if (typeof scan !== 'function') {
    if (store) {
      await recordVisibleCaptureGap(store, 'lookout_detectors_unwired', { rowId: 'lookout' });
    }
    return { ok: false, error: 'lookout_detectors_unwired' };
  }
  try {
    const result = await scan({
      pin: LOOKOUT_PIN,
      pg: opts.pg,
      eventInbox,
      sources: opts.sources,
      checkpoints: opts.checkpoints || {
        async get(name) { return store.getCheckpoint(name); },
        async set(name, cursor) {
          await store.setCheckpoint(name, cursor);
        },
      },
      now: opts.now || new Date(),
      batchSize: opts.batchSize || 100,
    });
    if (!result || result.ok === false) {
      const error = String((result && (result.error || result.reason)) || 'lookout_scan_failed');
      if (store) {
        await recordVisibleCaptureGap(store, error, { rowId: 'lookout' });
      }
      return { ok: false, error, result };
    }
    return { ok: true, result };
  } catch (err) {
    if (store) {
      await recordVisibleCaptureGap(store, String(err && err.message || err), { rowId: 'lookout-tick' });
    }
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = {
  ENABLED_FLAG,
  SIGNING_FLAG,
  HALT_FLAG,
  isSupervisorEventsEnabled,
  isWebhookSigningEnabled,
  isSupervisorHalt,
  isSupervisorAccount,
  sourceKey,
  operationKey,
  classifyPauseOwner,
  stayOutReason,
  resolveSupervisorWriteTarget,
  shouldEmitSupervisorSendAudit,
  shouldRecordSupervisorCompletion,
  normalizeSupervisorCompletionReceipt,
  supervisorAuditIdentity,
  projectSupervisorAudit,
  isWebhookWakeBlocked,
  supervisorHasHumanFallback,
  initialSupervisorDeliveryStatus,
  buildSupervisorAuditRetryEvent,
  retainFailedSupervisorAudit,
  replaySupervisorAuditRetries,
  reclassifyRetainedNoWake,
  bindCompleteDispatchParams,
  encodeSupervisorCheckpoint,
  decodeSupervisorCheckpoint,
  initialSupervisorDeliveryStatus,
  isNonDispatchableSupervisorEvent,
  createMemorySupervisorStore,
  captureSupervisorEvent,
  catchUpSupervisorSources,
  createWebhookSender,
  dispatchDueEvents,
  claimSupervisorIncident,
  renewSupervisorClaim,
  admitSupervisorBusinessAction,
  recordSupervisorLifecycle,
  recordSupervisorOutcome,
  evaluateSendWithSupervisorPermit,
  lunaOwnedPauseMatches,
  bindLunaPausePermit,
  hmacSign,
  verifyHmac,
  LOOKOUT_PIN,
  createSupervisorEventInbox,
  loadLookoutDetectorScan,
  runSupervisorDetectorTick,
  shouldStartSupervisorEventsLoop,
  isFranceWolfhouseStaging,
  persistSupervisorNeedsHuman,
  lookupSupervisorDelivery,
  recordSupervisorCauseOnConversation,
  clearSupervisorCauseOnConversation,
  reconcileSupervisorDeliveries,
  runSupervisorStaffTick,
  startSupervisorEventsLoop,
  runWithSupervisorSendContext,
  getSupervisorSendContext,
  trustedSupervisorContext,
};
