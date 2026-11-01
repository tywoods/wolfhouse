'use strict';

const crypto = require('crypto');

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

function isSupervisorAccount(user) {
  if (!user || typeof user !== 'object') return false;
  if (user.account_kind === 'supervisor' || user.supervisor === true) return true;
  const tagged = String(user.role_tag || user.inbox_tag || '').toLowerCase();
  if (tagged === 'supervisor') return true;
  return false;
}

function sourceKey({ environment, runtime, kind, rowId, revision }) {
  return [environment, runtime, kind, rowId, revision].map((p) => String(p || '').trim()).join(':');
}

function operationKey(incidentId, step) {
  return `supervisor:${incidentId}:${step}`;
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
        if (e.delivery_status !== 'pending') return false;
        if (e.dispatch_lease_until && new Date(e.dispatch_lease_until) > ts) return false;
        if (e.next_retry_at && new Date(e.next_retry_at) > ts) return false;
        return true;
      });
      return due.slice(0, limit || 4).map(clone);
    },
    async claimDispatch(id, workerId, leaseUntil) {
      const row = events.find((e) => e.id === id);
      if (!row) return null;
      if (row.dispatch_lease_until && new Date(row.dispatch_lease_until) > new Date()) return null;
      row.dispatch_worker_id = workerId;
      row.dispatch_lease_until = leaseUntil instanceof Date ? leaseUntil.toISOString() : leaseUntil;
      row.delivery_status = 'dispatched';
      row.attempts = (row.attempts || 0) + 1;
      row.updated_at = nowIso();
      return clone(row);
    },
    async getCheckpoint(name) {
      return checkpoints[name] || null;
    },
    async setCheckpoint(name, cursor) {
      checkpoints[name] = cursor;
    },
    async insertIncident(input) {
      const live = incidents.find((i) => i.conversation_id === input.conversation_id && i.status === 'open');
      if (live) return { joined: true, incident: clone(live) };
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
      Object.assign(row, patch);
      return clone(row);
    },
    async appendLifecycle(entry) {
      lifecycle.push({ ...entry, recorded_at: nowIso() });
      return { ok: true };
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
  if (opts.reenable) {
    for (const ev of store.events || []) {
      if (ev.delivery_status === 'pending' && ev.outcome) {
        await store.updateEvent(ev.id, { delivery_status: 'stale_on_reenable', outcome: ev.outcome });
        stale += 1;
      }
    }
  }
  for (const adapter of adapters || []) {
    if (adapter.retentionGap) {
      await captureSupervisorEvent(store, {
        source_key: sourceKey({
          environment: 'france-wolfhouse-staging',
          runtime: 'staff',
          kind: 'capture_gap',
          rowId: adapter.name,
          revision: String(Date.now()),
        }),
        kind: 'capture_gap',
        obligation: 'handoff',
        reason: 'source retention prevents replay',
        client_id: adapter.client_id || null,
      });
      gaps += 1;
      continue;
    }
    const cursor = await store.getCheckpoint(adapter.name);
    const batch = await adapter.listSince(cursor, batchSize);
    if (!batch || !batch.length) continue;
    for (const item of batch) {
      const out = await captureSupervisorEvent(store, item);
      if (out.inserted) captured += 1;
      await store.setCheckpoint(adapter.name, item.cursor);
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
  const workerId = opts.workerId || 'worker';
  const leaseUntil = new Date((opts.now instanceof Date ? opts.now : new Date()).getTime() + 30 * 1000);
  for (const ev of due) {
    if (ev.cause_incident_id) {
      await store.updateEvent(ev.id, { delivery_status: 'suppressed_recursive' });
      suppressed += 1;
      continue;
    }
    const claimed = await store.claimDispatch(ev.id, workerId, leaseUntil);
    if (!claimed) continue;
    const result = await sender.post(claimed);
    if (result.ok) {
      await store.updateEvent(ev.id, {
        delivery_status: 'acked',
        acked_at: nowIso(opts.now),
        last_error: null,
      });
      posted += 1;
    } else {
      const attempts = claimed.attempts || 1;
      const backoffMs = Math.min(60 * 1000, 2000 * (2 ** Math.max(0, attempts - 1)));
      const failed = attempts >= 3;
      await store.updateEvent(ev.id, {
        delivery_status: failed ? 'failed' : 'pending',
        last_error: result.error,
        next_retry_at: new Date(Date.now() + backoffMs).toISOString(),
        dispatch_lease_until: null,
      });
    }
  }
  return { posted, suppressed };
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
  const transitionId = event.metadata && event.metadata.needs_human_transition_id
    ? event.metadata.needs_human_transition_id
    : null;
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
  if (incident.lease_token !== input.lease_token) return { ok: false, error: 'claim_expired' };
  const now = input.now instanceof Date ? input.now : new Date();
  if (new Date(incident.lease_until) < now) return { ok: false, error: 'claim_expired' };
  const leaseUntil = new Date(now.getTime() + 3 * 60 * 1000).toISOString();
  const updated = await store.updateIncident(incident.id, { lease_until: leaseUntil });
  return { ok: true, incident: updated };
}

function stayOutReason({ pause, lunaMode, lastStaffReplyAt, staffNeedsHuman, now }) {
  if (pause && pause.paused === true && pause.owner === 'staff') return 'stayed_out';
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
  if (!isSupervisorAccount(user)) return { ok: true, skipped: 'not_supervisor' };
  if (input.halt === true) return { ok: false, error: 'supervisor_halted', status: 409 };
  const incident = input.incident_id
    ? await store.getIncident(input.incident_id)
    : await store.getOpenIncident(input.conversation_id);
  if (!incident || incident.status !== 'open') return { ok: false, error: 'claim_expired', status: 409 };
  if (input.lease_token && incident.lease_token !== input.lease_token) {
    return { ok: false, error: 'claim_expired', status: 409 };
  }
  const now = input.now instanceof Date ? input.now : new Date();
  if (new Date(incident.lease_until) < now) return { ok: false, error: 'claim_expired', status: 409 };
  const stayed = stayOutReason(input);
  if (stayed) return { ok: false, error: stayed, status: 409 };
  return {
    ok: true,
    incident,
    operation_key: operationKey(incident.id, input.step || 'step'),
  };
}

async function recordSupervisorLifecycle(store, input) {
  return store.appendLifecycle({
    event_id: input.event_id,
    kind: input.kind,
    payload: input.payload || {},
    halted: input.halted === true,
    expired: input.expired === true,
  });
}

async function recordSupervisorOutcome(store, input) {
  const row = await store.updateEvent(input.event_id, {
    outcome: input.outcome,
    outcome_payload: input.payload || {},
    delivery_status: input.delivery_status || undefined,
  });
  return { ok: !!row, row };
}

function lunaOwnedPauseMatches(pause, claim) {
  if (!pause || pause.paused !== true) return false;
  if (String(pause.owner || '').toLowerCase() !== 'luna') return false;
  const permit = claim && claim.pause_permit_transition_id;
  if (!permit) return false;
  return String(pause.needs_human_transition_id || '') === String(permit);
}

async function evaluateSendWithSupervisorPermit(body, context, withPauseFn, noPauseFn) {
  const user = context && context.user;
  if (!isSupervisorAccount(user)) return withPauseFn(body, context);
  const store = context.store;
  const incident = context.incident_id ? await store.getIncident(context.incident_id) : null;
  if (incident && lunaOwnedPauseMatches(context.pause, incident)) {
    return noPauseFn(body, context);
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
  hmacSign,
  verifyHmac,
};
