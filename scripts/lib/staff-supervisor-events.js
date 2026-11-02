'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
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
  return receipt.effect === 'mutated' || receipt.effect === 'replayed';
}

function buildSupervisorAuditRetryEvent(input) {
  const operationKeyValue = String((input && input.operation_key) || '').trim();
  const action = String((input && input.action) || '').trim();
  const rowId = operationKeyValue || [input && input.incident_id, action].filter(Boolean).join(':') || 'audit';
  return {
    source_key: sourceKey({
      environment: 'france-wolfhouse-staging',
      runtime: 'staff',
      kind: 'handoff',
      rowId,
      revision: 'audit',
    }),
    kind: 'audit_retry',
    obligation: 'handoff',
    conversation_id: (input && input.conversation_id) || null,
    booking_code: (input && input.booking_code) || null,
    metadata: {
      wake_supervisor: false,
      audit_retry: true,
      action,
      operation_key: operationKeyValue || null,
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
  let replayed = 0;
  let failed = 0;
  for (const ev of listed) {
    const meta = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : {};
    if (meta.audit_retry !== true || !meta.audit_entry) continue;
    if (meta.audit_replayed === true) continue;
    if (typeof opts.appendAuditLog !== 'function') {
      failed += 1;
      continue;
    }
    try {
      const sink = opts.appendAuditLog(meta.audit_entry);
      if (sink && sink.ok === false) throw new Error(sink.error || 'audit_sink_failed');
      await store.updateEvent(ev.id, {
        delivery_status: ev.delivery_status === 'pending' ? 'diagnostic' : ev.delivery_status,
        metadata: Object.assign({}, meta, { audit_replayed: true }),
        last_error: null,
      });
      replayed += 1;
    } catch (err) {
      failed += 1;
      await store.updateEvent(ev.id, { last_error: `audit_replay_failed:${err && err.message || err}` });
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
        delivery_status: 'pending',
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
    async getCheckpoint(name) {
      return checkpoints[name] || null;
    },
    async setCheckpoint(name, cursor) {
      checkpoints[name] = cursor;
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
        last_error: event.last_error || `needs_human_pending:${error || reason || 'failed'}`,
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
  const guestDelivered = !!(event.whatsapp_message_id
    || (event.metadata && event.metadata.guest_whatsapp_message_id));
  if (!guestDelivered) {
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
    : null;
  if (pg && incident && incident.pause_permit_transition_id) {
    try {
      const loaded = await getPauseState(pg, {
        client_slug: (body && (body.client_slug || body.client)) || 'wolfhouse-somo',
        guest_phone: body && body.to,
        conversation_id: body && body.conversation_id,
      });
      if (loaded && loaded.row) {
        await bindLunaPausePermit(pg, loaded.row, incident.pause_permit_transition_id);
      }
    } catch (_) { /* send route still revalidates live pause */ }
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

async function recordSupervisorCauseOnConversation(pg, conversationId, causeIncidentId) {
  if (!pg || !conversationId || !causeIncidentId) return { ok: false, error: 'cause_required' };
  await pg.query(
    `UPDATE conversations
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object('supervisor_cause_incident_id', to_jsonb($2::text))
      WHERE id = $1::uuid`,
    [conversationId, String(causeIncidentId)],
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
      if (actual && actual.delivered && ev.delivery_status === 'failed') {
        await store.updateEvent(ev.id, {
          delivery_status: 'acked',
          outcome: 'delivered_on_reconcile',
        });
        reconciled += 1;
        continue;
      }
    }
    if (ev.delivery_status === 'acked' && ev.acked_at
        && !(ev.metadata && ev.metadata.guest_whatsapp_message_id)) {
      const ackedAt = new Date(ev.acked_at).getTime();
      if (Number.isFinite(ackedAt) && now.getTime() - ackedAt > 15 * 60 * 1000) {
        const saved = await persistSupervisorNeedsHuman(opts, ev, 'acked_never_delivered');
        if (!saved || saved.ok === false) failedSaves += 1;
        else needsHuman += 1;
      }
    }
    if (ev.delivery_status === 'accepted_pending_delivery' && ev.updated_at) {
      const age = now.getTime() - new Date(ev.updated_at).getTime();
      if (age > 15 * 60 * 1000) {
        await store.updateEvent(ev.id, { last_error: 'accepted_pending_unknown' });
      }
    }
    if (ev.delivery_status === 'failed' || ev.delivery_status === 'suppressed_recursive') {
      const out = await persistSupervisorNeedsHuman({ ...opts, store }, ev, ev.last_error || ev.kind);
      if (out && out.ok) needsHuman += 1;
      else failedSaves += 1;
    }
  }
  return { ok: failedSaves === 0, needsHuman, reconciled, failedSaves };
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
  return {
    ok: reconcile.ok !== false && auditReplay.ok !== false && !(dispatch && dispatch.failedSaves),
    catchUp, dispatch, reconcile, auditReplay,
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
  buildSupervisorAuditRetryEvent,
  retainFailedSupervisorAudit,
  replaySupervisorAuditRetries,
  bindCompleteDispatchParams,
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
  persistSupervisorNeedsHuman,
  recordSupervisorCauseOnConversation,
  reconcileSupervisorDeliveries,
  runSupervisorStaffTick,
  startSupervisorEventsLoop,
  runWithSupervisorSendContext,
  getSupervisorSendContext,
  trustedSupervisorContext,
};
