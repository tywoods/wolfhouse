'use strict';

/**
 * MAIL-MVP-007 — one controlled Create Draft live proof.
 *
 * Invokes the production Staff Create Draft owner (the same function
 * POST /staff/inbox/email/create-draft calls). Aggregate counts only.
 * Never prints guest identifiers, conversation UUID, notes, tokens, or
 * draft body. Never calls approve/send/provider/booking owners.
 */

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');
const util = require('node:util');
const {
  EMAIL_LUNA_CREATE_DRAFT_PATH,
} = require('./staff-email-luna-draft-route');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const LIVE_NOTES = 'Thank them for the msg and then ask them if they want to do a booking';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AZ_DEFAULT = '/opt/data/home/.local/bin/az';
const PTY_BIN = '/usr/bin/script';
const RG = 'luna-sunset-staging-rg';
const STAFF_APP = 'luna-sunset-staging-staff-api';
const EMAIL_LUNA_APP = 'luna-sunset-staging-email-luna';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const PROOF_REMOTE_ENV_PATH = '/tmp/mail-mvp-007-proof.env';
const PROOF_REMOTE_NODE = 'scripts/prove-mail-mvp-007-create-draft.js';
const MUTATION_ISSUED_MARKER = 'MAIL_MVP_007_MUTATION_ISSUED';
const LOGS_TAIL = '200';
const LOG_WINDOW_MS = 15 * 60 * 1000;
const SAFE_AZ_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SAFE_B64 = /^[A-Za-z0-9+/]+=*$/;
const PRODUCTION_CREATE_DRAFT_OWNERS = new WeakSet();

const SQL_COUNT_APPROVALS = 'SELECT count(*)::int AS n FROM tenant_email_reply_approvals WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_COUNT_JOURNAL = 'SELECT count(*)::int AS n FROM tenant_email_outbound_send_journal WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_COUNT_BOOKINGS = 'SELECT count(*)::int AS n FROM bookings WHERE client_id=$1::uuid';
const SQL_COUNT_SENDS = 'SELECT coalesce(sum(send_invocation_count),0)::int AS n FROM tenant_email_outbound_send_journal WHERE client_id=$1::uuid AND conversation_id=$2::uuid';
const SQL_STANDING_DRAFT = [
  'SELECT length(coalesce(staff_reply_draft,\'\'))::int AS n,',
  ' coalesce(metadata->\'luna_email_open_draft\'->>\'claim_id\',\'\') AS claim_id,',
  ' coalesce(metadata->\'luna_email_open_draft\'->>\'generated_body_sha256\',\'\') AS body_sha,',
  ' coalesce(metadata->\'luna_email_open_draft\'->>\'state\',\'\') AS state',
  ' FROM conversations WHERE client_id=$1::uuid AND id=$2::uuid',
].join('');
const SQL_RESOLVE_PROOF_ACTOR = [
  'SELECT cl.id::text AS client_id, su.id::text AS staff_user_id, su.role',
  ' FROM conversations c',
  ' INNER JOIN clients cl ON cl.id=c.client_id AND cl.slug=\'sunset\'',
  ' INNER JOIN staff_users su ON su.client_id=cl.id AND su.status=\'active\'',
  '  AND su.role IN (\'operator\',\'admin\',\'owner\')',
  ' INNER JOIN tenant_email_inbound_inbox_projections p',
  '  ON p.client_id=c.client_id AND p.conversation_id=c.id',
  ' INNER JOIN tenant_email_inbound_events ev',
  '  ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id',
  ' INNER JOIN tenant_locations loc',
  '  ON loc.client_id=ev.client_id AND loc.id=ev.location_id',
  '  AND loc.location_id=\'sunset-somo\'',
  ' WHERE c.id=$1::uuid AND c.phone ~ \'^(emailv1|email):\' AND c.status=\'open\'',
  ' ORDER BY CASE su.role WHEN \'operator\' THEN 0 WHEN \'admin\' THEN 1 ELSE 2 END, su.id',
  ' LIMIT 1',
].join('');

function fail(reason, extra) {
  const out = { ok: false, reason: reason || 'proof_failed' };
  const attemptId = extra && snapshotConversationId(extra.attempt_id);
  if (attemptId) {
    out.attempt_id = attemptId;
    out.attempt_id_prefix = attemptId.slice(0, 8);
  }
  return freeze({
    ok: false,
    reason: out.reason,
    attempt_id: out.attempt_id || null,
    public: freeze(out),
  });
}

function asInt(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return null;
  const n = row.n;
  if (Number.isSafeInteger(n)) return n;
  const parsed = Number.parseInt(n, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable
      && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotConversationId(value) {
  return uuid(value);
}

function redactSensitive(text, secrets) {
  let out = String(text == null ? '' : text);
  const extra = Array.isArray(secrets) ? secrets : [];
  for (const secret of extra) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.split(LIVE_NOTES).join('[redacted-notes]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]');
  return out;
}

function snapshotMarker(marker) {
  if (!marker || typeof marker !== 'object' || isProxy(marker)) return null;
  const provider = ownData(marker, 'provider');
  const model = ownData(marker, 'model');
  const runtime = ownData(marker, 'runtime');
  if (provider !== 'openai-codex' || model !== 'gpt-5.6-sol' || runtime !== 'sunset-email-luna') {
    return null;
  }
  return freeze({
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    runtime: 'sunset-email-luna',
  });
}

function snapshotAuthenticity(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) return null;
  const requestId = uuid(ownData(value, 'request_id'));
  const hmacVerified = ownData(value, 'hmac_verified');
  const alg = ownData(value, 'alg');
  if (!requestId || hmacVerified !== true) return null;
  if (alg != null && alg !== 'HMAC-SHA256') return null;
  return freeze({
    alg: 'HMAC-SHA256',
    request_id: requestId,
    hmac_verified: true,
  });
}

function readHermesSolAttemptDiagnostics(drafted) {
  if (!drafted || typeof drafted !== 'object' || isProxy(drafted)) return null;
  const marker = snapshotMarker(
    ownData(drafted, 'marker')
    || (drafted.diagnostics && drafted.diagnostics.email_luna_hermes_sol)
    || null,
  );
  const authenticity = snapshotAuthenticity(ownData(drafted, 'authenticity'));
  if (!marker || !authenticity) return null;
  return freeze({
    ok: true,
    source: 'staff_hmac_verified_authenticity',
    marker,
    authenticity,
    request_id: authenticity.request_id,
  });
}

async function countRow(withPgClient, sql, params) {
  const result = await withPgClient((pg) => pg.query(sql, params));
  if (!result || !Array.isArray(result.rows) || result.rows.length < 1) return null;
  return asInt(result.rows[0]);
}

async function snapshotDraft(withPgClient, clientId, conversationId) {
  const result = await withPgClient((pg) => pg.query(SQL_STANDING_DRAFT, [clientId, conversationId]));
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) return null;
  const row = result.rows[0];
  const draftChars = asInt(row);
  if (!Number.isSafeInteger(draftChars)) return null;
  return freeze({
    draftChars,
    claim_id: typeof row.claim_id === 'string' ? row.claim_id : '',
    body_sha: typeof row.body_sha === 'string' ? row.body_sha : '',
    state: typeof row.state === 'string' ? row.state : '',
  });
}

async function snapshotCounts(withPgClient, clientId, conversationId) {
  const [approvals, journal, sends, bookings, draft] = await Promise.all([
    countRow(withPgClient, SQL_COUNT_APPROVALS, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_JOURNAL, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_SENDS, [clientId, conversationId]),
    countRow(withPgClient, SQL_COUNT_BOOKINGS, [clientId]),
    snapshotDraft(withPgClient, clientId, conversationId),
  ]);
  if (![approvals, journal, sends, bookings].every((n) => Number.isSafeInteger(n)) || !draft) {
    return null;
  }
  return freeze({
    approvals,
    journal,
    sends,
    bookings,
    draftChars: draft.draftChars,
    claim_id: draft.claim_id,
    body_sha: draft.body_sha,
    state: draft.state,
  });
}

function publicProofOutput(result) {
  if (!result || result.ok !== true) {
    const out = {
      ok: false,
      reason: result && result.reason ? String(result.reason) : 'proof_failed',
    };
    if (result && result.attempt_id) {
      out.attempt_id = result.attempt_id;
      out.attempt_id_prefix = String(result.attempt_id).slice(0, 8);
    }
    return freeze(out);
  }
  const requestId = result.request_id;
  const base = {
    ok: true,
    invoked: result.invoked,
    draft_persisted: true,
    draft_changed: result.draft_changed !== false,
    draftChars: result.draftChars,
    cas_advanced: result.cas_advanced === true,
    hmac_verified: true,
    logs_correlated: result.logs_correlated === true,
    marker: result.marker,
    request_id: requestId,
    request_id_prefix: typeof requestId === 'string' ? requestId.slice(0, 8) : '',
  };
  if (result.reconciled === true) {
    base.reconciled = true;
  }
  if (result.deltas && typeof result.deltas === 'object') {
    base.deltas = freeze({
      approvals: result.deltas.approvals,
      journal: result.deltas.journal,
      sends: result.deltas.sends,
      bookings: result.deltas.bookings,
    });
  }
  return freeze(base);
}

function brandProductionCreateDraft(fn) {
  if (typeof fn === 'function') PRODUCTION_CREATE_DRAFT_OWNERS.add(fn);
  return fn;
}

function isProductionCreateDraft(fn) {
  return typeof fn === 'function' && PRODUCTION_CREATE_DRAFT_OWNERS.has(fn);
}

function createMailMvp007LiveProof(options) {
  const withPgClient = options && options.withPgClient;
  const createDraft = options && options.createDraft;
  const correlateAttempt = options && options.correlateAttempt;
  const requireLogs = options && options.requireLogs === true;
  const notes = options && typeof options.notes === 'string' ? options.notes : LIVE_NOTES;
  if (typeof withPgClient !== 'function' || typeof createDraft !== 'function') {
    throw new Error('live_proof_misconfigured');
  }
  if (requireLogs && typeof correlateAttempt !== 'function') {
    throw new Error('live_proof_misconfigured');
  }

  async function reconcileOwnerState(input) {
    const actor = input && input.actor;
    const conversationId = snapshotConversationId(input && input.conversation_id);
    const clientId = actor && uuid(actor.client_id);
    const requestId = snapshotConversationId(input && input.request_id);
    if (!actor || !conversationId || !clientId || !requestId) {
      return fail('indeterminate_no_retry', { attempt_id: requestId });
    }
    let after;
    try {
      after = await snapshotCounts(withPgClient, clientId, conversationId);
    } catch {
      return fail('indeterminate_no_retry', { attempt_id: requestId });
    }
    if (!after) return fail('indeterminate_no_retry', { attempt_id: requestId });
    let logsCorrelated = false;
    if (typeof correlateAttempt === 'function') {
      let correlated;
      try {
        correlated = await correlateAttempt({ request_id: requestId });
      } catch {
        return fail('indeterminate_no_retry', { attempt_id: requestId });
      }
      if (correlated && correlated.ok === true) {
        if (correlated.request_id && correlated.request_id !== requestId) {
          return fail('indeterminate_no_retry', { attempt_id: requestId });
        }
        logsCorrelated = true;
      }
    }
    return freeze({
      ok: false,
      reason: 'reconcile_owner_state',
      reconcile: true,
      invoked: 0,
      attempt_id: requestId,
      request_id: requestId,
      draftChars: after.draftChars,
      state: after.state,
      claim_id: after.claim_id,
      body_sha: after.body_sha,
      logs_correlated: logsCorrelated,
      approvals: after.approvals,
      journal: after.journal,
      sends: after.sends,
      bookings: after.bookings,
      public: freeze({
        ok: false,
        reason: 'reconcile_owner_state',
        reconcile: true,
        attempt_id: requestId,
        attempt_id_prefix: requestId.slice(0, 8),
        draftChars: after.draftChars,
        logs_correlated: logsCorrelated,
      }),
    });
  }

  return freeze({
    route: EMAIL_LUNA_CREATE_DRAFT_PATH,
    reconcileOwnerState,
    async runOnce(input) {
      if (input && input.reconcileOnly === true) {
        return reconcileOwnerState(input);
      }
      const actor = input && input.actor;
      const conversationId = snapshotConversationId(input && input.conversation_id);
      const clientId = actor && uuid(actor.client_id);
      const requestId = snapshotConversationId(input && input.request_id);
      if (!actor || !conversationId || !clientId) return fail('authority_mismatch');
      if (notes !== LIVE_NOTES) return fail('notes_mismatch');
      const before = await snapshotCounts(withPgClient, clientId, conversationId);
      if (!before) return fail('counts_unavailable');
      let invoked = 0;
      let drafted;
      const draftInput = {
        actor,
        conversation_id: conversationId,
        operator_context: notes,
      };
      if (requestId) draftInput.request_id = requestId;
      try {
        drafted = await createDraft(draftInput);
        invoked += 1;
      } catch {
        return fail('create_draft_failed');
      }
      if (invoked !== 1) return fail('create_draft_not_once');
      if (!drafted || drafted.status !== 'draft_ready') {
        return fail((drafted && drafted.reason) || 'create_draft_failed');
      }
      if (drafted.success === true && drafted.message_text && !drafted.authenticity) {
        return fail('fake_staff_200');
      }
      const diagnostics = readHermesSolAttemptDiagnostics(drafted);
      if (!diagnostics) return fail('authenticity_mismatch');
      if (requestId && diagnostics.request_id !== requestId) return fail('request_id_mismatch');
      const marker = diagnostics.marker;
      const authenticity = diagnostics.authenticity;
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
      if (!Number.isSafeInteger(after.draftChars) || after.draftChars <= 0) {
        return fail('empty_draft');
      }
      const casAdvanced = after.claim_id !== before.claim_id || after.body_sha !== before.body_sha;
      const persistedChanged = deltas.draftChars !== 0 || casAdvanced;
      if (!persistedChanged) return fail('draft_not_persisted');
      let logsCorrelated = false;
      if (typeof correlateAttempt === 'function') {
        let correlated;
        try {
          correlated = await correlateAttempt({
            request_id: authenticity.request_id,
            marker,
          });
        } catch {
          return fail('logs_uncorrelated');
        }
        if (!correlated || correlated.ok !== true) return fail('logs_uncorrelated');
        if (correlated.request_id && correlated.request_id !== authenticity.request_id) {
          return fail('request_id_mismatch');
        }
        logsCorrelated = true;
      } else if (requireLogs) {
        return fail('logs_uncorrelated');
      }
      const proved = freeze({
        ok: true,
        reason: null,
        invoked: 1,
        marker,
        authenticity,
        request_id: authenticity.request_id,
        hmac_verified: true,
        logs_correlated: logsCorrelated,
        cas_advanced: casAdvanced,
        before: freeze({
          approvals: before.approvals,
          journal: before.journal,
          sends: before.sends,
          bookings: before.bookings,
          draftChars: before.draftChars,
        }),
        after: freeze({
          approvals: after.approvals,
          journal: after.journal,
          sends: after.sends,
          bookings: after.bookings,
          draftChars: after.draftChars,
        }),
        deltas: freeze({
          approvals: deltas.approvals,
          journal: deltas.journal,
          sends: deltas.sends,
          bookings: deltas.bookings,
        }),
        draftChars: after.draftChars,
      });
      return freeze({
        ...proved,
        public: publicProofOutput(proved),
      });
    },
  });
}

function createProductionStaffCreateDraftOwner(deps) {
  const withPgClient = deps && deps.withPgClient;
  if (typeof withPgClient !== 'function') throw new Error('live_proof_misconfigured');
  const { createStaffEmailLunaDraftOpen } = require('./staff-email-luna-draft-open');
  const { createEmailLunaSunsetStagingRuntimeComposition } = require('./email-luna-sunset-staging-runtime-composition');
  const { createEmailLunaDraftOpenContentFetcher } = require('./email-luna-draft-open-content-composition');
  const owner = createStaffEmailLunaDraftOpen({
    withPgClient,
    runtimeEnv: (deps && deps.runtimeEnv) || process.env,
    createLunaRuntime: createEmailLunaSunsetStagingRuntimeComposition,
    createContentFetcher(pgClient) {
      return createEmailLunaDraftOpenContentFetcher({
        env: (deps && deps.runtimeEnv) || process.env,
        pgClient,
        https,
        timers: { setTimeout, clearTimeout },
      });
    },
  });
  const createDraft = brandProductionCreateDraft((input) => (
    owner.regenerateEmailLunaDraftOnStaffClick(input)
  ));
  return freeze({
    owner,
    createDraft,
    route: EMAIL_LUNA_CREATE_DRAFT_PATH,
  });
}

async function resolveProofActor(withPgClient, conversationId) {
  const result = await withPgClient((pg) => pg.query(SQL_RESOLVE_PROOF_ACTOR, [conversationId]));
  const row = result && result.rows && result.rows[0];
  if (!row || typeof row !== 'object' || isProxy(row)) return null;
  const staffUserId = uuid(row.staff_user_id);
  const clientId = uuid(row.client_id);
  const role = row.role;
  if (!staffUserId || !clientId || !['operator', 'admin', 'owner'].includes(role)) return null;
  const actor = Object.create(null);
  actor.staff_user_id = staffUserId;
  actor.client_id = clientId;
  actor.role = role;
  return freeze(actor);
}

function staffOwnerEnvReady(env) {
  const src = env && typeof env === 'object' ? env : {};
  return ownData(src, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT
    && ownData(src, 'EMAIL_STAFF_LUNA_DRAFT_ENABLED') === 'true'
    && ownData(src, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED') === 'true'
    && ownData(src, 'EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED') === 'true';
}

function proofAttemptIdFrom(input, env) {
  return snapshotConversationId(
    (input && (input.attempt_id || input.request_id))
    || ownData(env, 'MAIL_MVP_007_PROOF_ATTEMPT_ID')
    || (env && env.MAIL_MVP_007_PROOF_ATTEMPT_ID),
  );
}

async function runStaffOwnerProof(input) {
  const env = (input && input.env) || process.env;
  const conversationId = snapshotConversationId(
    input && input.conversation_id || ownData(env, 'EMAIL_LUNA_PROOF_CONVERSATION_ID'),
  );
  const attemptId = proofAttemptIdFrom(input, env);
  if (!conversationId) return fail('authority_mismatch');
  if (!staffOwnerEnvReady(env)) return fail('staff_owner_disabled');
  const injectedClient = input && typeof input.withPgClient === 'function';
  const pg = injectedClient ? null : require('./pg-connect');
  const withPgClient = injectedClient ? input.withPgClient : pg.withPgClient;
  try {
    const wired = input && input.wired
      ? input.wired
      : createProductionStaffCreateDraftOwner({ withPgClient, runtimeEnv: env });
    if (!wired || typeof wired.createDraft !== 'function') return fail('live_proof_misconfigured');
    const actor = input && input.actor
      ? input.actor
      : await resolveProofActor(withPgClient, conversationId);
    if (!actor) return fail('authority_mismatch');
    const proof = createMailMvp007LiveProof({
      withPgClient,
      createDraft: wired.createDraft,
      correlateAttempt: typeof (input && input.correlateAttempt) === 'function'
        ? input.correlateAttempt
        : undefined,
      notes: LIVE_NOTES,
      requireLogs: false,
    });
    const payload = { actor, conversation_id: conversationId };
    if (attemptId) payload.request_id = attemptId;
    if (input && input.reconcileOnly === true) payload.reconcileOnly = true;
    return await proof.runOnce(payload);
  } finally {
    if (pg && typeof pg.closePgPool === 'function') {
      await pg.closePgPool();
    }
  }
}

async function runStaffOwnerReconcile(input) {
  const env = (input && input.env) || process.env;
  const attemptId = proofAttemptIdFrom(input, env);
  let result;
  try {
    result = await runStaffOwnerProof({
      ...input,
      env,
      reconcileOnly: true,
      attempt_id: attemptId,
    });
  } catch {
    return fail('indeterminate_no_retry', { attempt_id: attemptId });
  }
  if (result && result.reconcile === true) return result;
  return fail('indeterminate_no_retry', { attempt_id: attemptId });
}

function assertSunsetTarget(input, app) {
  const expectedApp = app || STAFF_APP;
  if (input && input.resourceGroup != null && input.resourceGroup !== RG) {
    throw new Error('wrong_target');
  }
  if (input && input.app != null && input.app !== expectedApp) {
    throw new Error('wrong_target');
  }
  if (input && input.deployment != null && input.deployment !== SUNSET_DEPLOYMENT) {
    throw new Error('wrong_target');
  }
  if (input && input.revision != null) {
    const revision = String(input.revision);
    if (!SAFE_AZ_NAME.test(revision) || !revision.startsWith(expectedApp)) {
      throw new Error('wrong_target');
    }
  }
  if (input && input.replica != null) {
    const replica = String(input.replica);
    if (!SAFE_AZ_NAME.test(replica) || !replica.startsWith(expectedApp)) {
      throw new Error('wrong_target');
    }
  }
}

function shSingleQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('invalid_argv');
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function encodeProofEnvPayload(conversationId, attemptId, reconcileOnly) {
  const id = snapshotConversationId(conversationId);
  const attempt = snapshotConversationId(attemptId);
  if (!id || !attempt) return null;
  const lines = [
    'MAIL_MVP_007_LIVE_PROOF=1',
    reconcileOnly === true ? 'MAIL_MVP_007_RECONCILE_ONLY=1' : 'MAIL_MVP_007_STAFF_OWNER_PROOF=1',
    `LUNA_DEPLOYMENT=${SUNSET_DEPLOYMENT}`,
    `EMAIL_LUNA_PROOF_CONVERSATION_ID=${id}`,
    `MAIL_MVP_007_PROOF_ATTEMPT_ID=${attempt}`,
  ];
  const b64 = Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64');
  if (!SAFE_B64.test(b64) || b64.length > 4096) return null;
  return b64;
}

function buildStaffOwnerRemoteCommand(conversationId, attemptId, reconcileOnly) {
  const b64 = encodeProofEnvPayload(conversationId, attemptId, reconcileOnly);
  if (!b64) return null;
  const issued = reconcileOnly === true ? '' : ` && echo ${MUTATION_ISSUED_MARKER}`;
  return `sh -c 'printf %s ${b64} | base64 -d > ${PROOF_REMOTE_ENV_PATH} && set -a && . ${PROOF_REMOTE_ENV_PATH} && set +a${issued} && exec node ${PROOF_REMOTE_NODE}'`;
}

function buildStaffOwnerExecAzArgs(options) {
  assertSunsetTarget(options, STAFF_APP);
  const conversationId = snapshotConversationId(options && options.conversationId);
  const attemptId = snapshotConversationId(options && options.attemptId);
  const replica = options && options.replica;
  const revision = options && options.revision;
  const reconcileOnly = options && options.reconcileOnly === true;
  if (!conversationId || !attemptId) return null;
  if (typeof replica !== 'string' || !SAFE_AZ_NAME.test(replica) || !replica.startsWith(STAFF_APP)) {
    throw new Error('wrong_target');
  }
  if (typeof revision !== 'string' || !SAFE_AZ_NAME.test(revision) || !revision.startsWith(STAFF_APP)) {
    throw new Error('wrong_target');
  }
  const command = buildStaffOwnerRemoteCommand(conversationId, attemptId, reconcileOnly);
  if (!command || !command.startsWith('sh -c \'')) return null;
  return freeze([
    'containerapp', 'exec',
    '-g', RG,
    '-n', STAFF_APP,
    '--replica', replica,
    '--revision', revision,
    '--command', command,
  ]);
}

function buildStaffOwnerExecArgs(conversationId, options) {
  return buildStaffOwnerExecAzArgs({
    conversationId,
    attemptId: options && options.attemptId,
    replica: options && options.replica,
    revision: options && options.revision,
    reconcileOnly: options && options.reconcileOnly,
    resourceGroup: options && options.resourceGroup,
    app: options && options.app,
    deployment: options && options.deployment,
  });
}

function wrapPtyAzExec(azBin, azArgs) {
  if (!Array.isArray(azArgs) || azArgs[0] !== 'containerapp' || azArgs[1] !== 'exec') {
    throw new Error('pty_required');
  }
  if (azArgs.includes('--format') || azArgs.includes('--query') || azArgs.includes('-o')) {
    throw new Error('unsupported_exec_flag');
  }
  const commandIndex = azArgs.indexOf('--command');
  const command = commandIndex >= 0 ? azArgs[commandIndex + 1] : '';
  if (typeof command !== 'string' || !command.startsWith('sh -c \'')) {
    throw new Error('pty_required');
  }
  const bin = typeof azBin === 'string' && azBin ? azBin : AZ_DEFAULT;
  const commandString = [bin, ...azArgs].map(shSingleQuote).join(' ');
  return {
    bin: PTY_BIN,
    args: freeze(['-q', '-e', '-c', commandString, '/dev/null']),
    azArgs: freeze(azArgs.slice()),
    azBin: bin,
  };
}

function isLegalPtyExecSpec(spec) {
  return !!(spec
    && spec.bin === PTY_BIN
    && Array.isArray(spec.args)
    && spec.args.length === 5
    && spec.args[0] === '-q'
    && spec.args[1] === '-e'
    && spec.args[2] === '-c'
    && typeof spec.args[3] === 'string'
    && spec.args[3].includes('containerapp')
    && spec.args[3].includes('exec')
    && spec.args[4] === '/dev/null'
    && Array.isArray(spec.azArgs)
    && spec.azArgs[0] === 'containerapp'
    && spec.azArgs[1] === 'exec'
    && spec.azArgs.includes('-g')
    && spec.azArgs[spec.azArgs.indexOf('-g') + 1] === RG
    && spec.azArgs.includes('-n')
    && spec.azArgs[spec.azArgs.indexOf('-n') + 1] === STAFF_APP);
}

function constructStaffOwnerExecHarness(input) {
  if (!input || input.pty === false || (input.stdio && input.stdio !== 'pty')) {
    throw new Error('pty_required');
  }
  const azArgs = buildStaffOwnerExecAzArgs(input);
  if (!azArgs) throw new Error('exec_harness_invalid');
  const spec = wrapPtyAzExec(input.azBin, azArgs);
  return freeze({
    ...spec,
    reconcileOnly: input.reconcileOnly === true,
    resourceGroup: RG,
    app: STAFF_APP,
    replica: input.replica,
    revision: input.revision,
  });
}

function spawnAz(azBin, args, options) {
  if (Array.isArray(args) && args.includes('exec')) {
    throw new Error('pty_required');
  }
  const bin = typeof azBin === 'string' && azBin ? azBin : AZ_DEFAULT;
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: (options && options.timeoutMs) || 180000,
    maxBuffer: 10 * 1024 * 1024,
    env: (options && options.env) || process.env,
  });
}

function spawnPtyHarness(spec, options) {
  if (!isLegalPtyExecSpec(spec)) {
    throw new Error('pty_required');
  }
  return spawnSync(spec.bin, spec.args, {
    encoding: 'utf8',
    timeout: (options && options.timeoutMs) || 240000,
    maxBuffer: 10 * 1024 * 1024,
    env: (options && options.env) || process.env,
  });
}

function buildReplicaListArgs(app) {
  if (app !== STAFF_APP && app !== EMAIL_LUNA_APP) throw new Error('wrong_target');
  return freeze(['containerapp', 'replica', 'list', '-g', RG, '-n', app, '-o', 'json']);
}

function inferRevision(replicaName, app) {
  if (typeof replicaName !== 'string' || !replicaName.startsWith(app)) return null;
  const match = /^(.*)-[a-z0-9]{5,10}-[a-z0-9]{5}$/.exec(replicaName);
  if (!match) return null;
  const revision = match[1];
  return revision.startsWith(app) && SAFE_AZ_NAME.test(revision) ? revision : null;
}

function parseRunningReplica(raw, app) {
  if (app !== STAFF_APP && app !== EMAIL_LUNA_APP) return null;
  let parsed;
  try { parsed = JSON.parse(String(raw || '').trim() || 'null'); } catch { return null; }
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.value) ? parsed.value : null);
  if (!rows) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    const name = ownData(row, 'name');
    if (typeof name !== 'string' || !name.startsWith(app) || !SAFE_AZ_NAME.test(name)) continue;
    const props = ownData(row, 'properties');
    const running = (props && typeof props === 'object' ? ownData(props, 'runningState') : undefined)
      || ownData(row, 'runningState');
    if (running !== 'Running') continue;
    let revision = (props && typeof props === 'object' ? ownData(props, 'revisionName') : undefined)
      || ownData(row, 'revisionName');
    if (typeof revision !== 'string' || !revision.startsWith(app)) {
      revision = inferRevision(name, app);
    }
    if (typeof revision !== 'string' || !revision.startsWith(app) || !SAFE_AZ_NAME.test(revision)) continue;
    return freeze({ replica: name, revision, app, resourceGroup: RG });
  }
  return null;
}

function buildEmailLunaAttemptLogsArgs(requestId, options) {
  const id = snapshotConversationId(requestId);
  if (!id) return null;
  assertSunsetTarget({
    resourceGroup: options && options.resourceGroup,
    app: options && options.app,
    deployment: options && options.deployment,
    revision: options && options.revision,
  }, EMAIL_LUNA_APP);
  const args = [
    'containerapp', 'logs', 'show',
    '-g', RG,
    '-n', EMAIL_LUNA_APP,
    '--type', 'console',
    '--tail', LOGS_TAIL,
  ];
  if (options && options.revision) {
    args.push('--revision', options.revision);
  }
  if (options && options.replica) {
    if (!SAFE_AZ_NAME.test(options.replica) || !String(options.replica).startsWith(EMAIL_LUNA_APP)) {
      throw new Error('wrong_target');
    }
    args.push('--replica', options.replica);
  }
  return freeze(args);
}

function parseLogTimeMs(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function extractLogFields(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return null;
  const log = ownData(row, 'Log') || ownData(row, 'log') || ownData(row, 'Message') || ownData(row, 'message')
    || row.Log || row.log || row.Message || row.message;
  if (typeof log !== 'string') return null;
  const timestamp = ownData(row, 'TimeStamp') || ownData(row, 'timestamp') || ownData(row, 'timeStamp')
    || row.TimeStamp || row.timestamp || row.timeStamp;
  const app = ownData(row, 'ContainerAppName') || ownData(row, 'Name') || ownData(row, 'name')
    || row.ContainerAppName || row.Name;
  const revision = ownData(row, 'RevisionName') || ownData(row, 'Revision') || ownData(row, 'revision')
    || row.RevisionName || row.Revision;
  const replica = ownData(row, 'ReplicaName') || ownData(row, 'Replica') || row.ReplicaName;
  return freeze({
    log,
    timestamp: typeof timestamp === 'string' ? timestamp : null,
    app: typeof app === 'string' ? app : null,
    revision: typeof revision === 'string' ? revision : null,
    replica: typeof replica === 'string' ? replica : null,
  });
}

function isPostCompletionMarker(line, requestId) {
  if (typeof line !== 'string') return false;
  const needle = `request_id=${requestId}`;
  return line.includes('email-draft-server attempt ')
    && line.includes(needle)
    && line.includes('provider=openai-codex')
    && line.includes('model=gpt-5.6-sol')
    && line.includes('runtime=sunset-email-luna')
    && line.includes('hmac=ok')
    && !/hmac=(?!ok\b)/.test(line);
}

function isPreCompletionSpoof(line, requestId) {
  if (typeof line !== 'string') return false;
  const needle = `request_id=${requestId}`;
  if (!line.includes(needle)) return false;
  if (isPostCompletionMarker(line, requestId)) return false;
  return /email-draft-server POST |echo |hmac=pending|invoke_started|input-echo/i.test(line)
    || (line.includes('email-draft-server') && !line.includes('hmac=ok'));
}

function parseEmailLunaAttemptLogs(raw, requestId, secrets, options) {
  const id = snapshotConversationId(requestId);
  if (!id) return fail('logs_uncorrelated');
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return fail('empty_logs');
  const guestLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|staff_reply_draft|message_text/;
  const nowMs = options && Number.isSafeInteger(options.nowMs) ? options.nowMs : Date.now();
  const windowMs = options && Number.isSafeInteger(options.windowMs) ? options.windowMs : LOG_WINDOW_MS;
  const requireTimestamp = options && options.requireTimestamp === true;
  const expectedApp = (options && options.app) || EMAIL_LUNA_APP;
  const expectedRevision = options && options.revision;
  const expectedRg = (options && options.resourceGroup) || RG;
  if (expectedApp !== EMAIL_LUNA_APP || expectedRg !== RG) return fail('wrong_target');
  if (expectedRevision && (!SAFE_AZ_NAME.test(expectedRevision) || !expectedRevision.startsWith(EMAIL_LUNA_APP))) {
    return fail('wrong_target');
  }

  const records = [];
  const rawLines = text.split(/\r?\n/);
  for (const line of rawLines) {
    if (!line.trim()) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (parsed && typeof parsed === 'object' && !isProxy(parsed)) {
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          const fields = extractLogFields(row);
          if (!fields) return fail('malformed_logs');
          records.push(fields);
        }
      } else {
        const fields = extractLogFields(parsed);
        if (!fields) return fail('malformed_logs');
        records.push(fields);
      }
    } else if (line.trim().startsWith('{') || line.trim().startsWith('[')) {
      return fail('malformed_logs');
    } else {
      records.push(freeze({
        log: line,
        timestamp: null,
        app: null,
        revision: null,
        replica: null,
      }));
    }
  }
  if (records.length === 0) return fail('empty_logs');

  let staleMatch = false;
  let spoofed = false;
  let wrongTarget = false;
  const matches = [];
  for (const rec of records) {
    redactSensitive(rec.log, secrets);
    if (guestLike.test(rec.log)) continue;
    if (rec.app && rec.app !== EMAIL_LUNA_APP) {
      if (rec.log.includes(`request_id=${id}`)) wrongTarget = true;
      continue;
    }
    if (expectedRevision && rec.revision && rec.revision !== expectedRevision) {
      if (rec.log.includes(`request_id=${id}`)) wrongTarget = true;
      continue;
    }
    if (isPreCompletionSpoof(rec.log, id)) {
      spoofed = true;
      continue;
    }
    if (!isPostCompletionMarker(rec.log, id)) continue;
    if (requireTimestamp && !rec.timestamp) {
      staleMatch = true;
      continue;
    }
    if (rec.timestamp) {
      const ts = parseLogTimeMs(rec.timestamp);
      if (ts == null) return fail('malformed_logs');
      if (nowMs - ts > windowMs || ts > nowMs + 60000) {
        staleMatch = true;
        continue;
      }
    }
    matches.push(rec);
  }
  if (wrongTarget && matches.length === 0) return fail('wrong_target');
  if (matches.length !== 1) {
    if (spoofed && matches.length === 0) return fail('logs_uncorrelated');
    if (staleMatch && matches.length === 0) return fail('stale_logs');
    if (matches.length === 0) return fail('logs_uncorrelated');
    return fail('logs_uncorrelated');
  }
  return freeze({
    ok: true,
    request_id: id,
    source: 'email_luna_attempt_log',
    timestamp: matches[0].timestamp,
    revision: matches[0].revision,
  });
}

function extractProofJson(raw, secrets) {
  const text = String(raw || '');
  const last = text.lastIndexOf('}');
  if (last < 0) return null;
  let start = -1;
  while ((start = text.indexOf('{', start + 1)) >= 0 && start <= last) {
    let value;
    try { value = JSON.parse(text.slice(start, last + 1)); } catch { continue; }
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) continue;
    if (value.ok !== true && value.ok !== false) continue;
    redactSensitive(JSON.stringify(value), secrets);
    return value;
  }
  return null;
}

function execLooksConnected(execResult) {
  const out = `${execResult && execResult.stdout || ''}${execResult && execResult.stderr || ''}`;
  return /websocket|cluster exec|ClusterExecFailure|connected|pty|session/i.test(out)
    || (execResult && execResult.status !== 0 && out.trim().length > 0);
}

function innerProofLooksComplete(inner) {
  if (!inner || inner.ok !== true) return false;
  if (inner.success === true && inner.message_text && inner.hmac_verified !== true) return false;
  const requestId = uuid(inner.request_id);
  if (!requestId || inner.hmac_verified !== true) return false;
  if (!inner.marker || inner.marker.provider !== 'openai-codex'
      || inner.marker.model !== 'gpt-5.6-sol'
      || inner.marker.runtime !== 'sunset-email-luna') {
    return false;
  }
  const deltas = inner.deltas;
  if (!deltas || deltas.approvals !== 0 || deltas.journal !== 0
      || deltas.sends !== 0 || deltas.bookings !== 0) {
    return false;
  }
  if (!Number.isSafeInteger(inner.draftChars) || inner.draftChars <= 0
      || inner.draft_persisted !== true || inner.draft_changed !== true) {
    return false;
  }
  return true;
}

async function selectRunningTarget(input, app, azBin, env) {
  if (input && input.revision) {
    assertSunsetTarget(input, app);
    return freeze({
      replica: input.replica || null,
      revision: input.revision,
      app,
      resourceGroup: RG,
    });
  }
  const listFn = typeof (input && input.listReplicas) === 'function'
    ? input.listReplicas
    : (args) => spawnAz(azBin, args, { timeoutMs: 60000, env });
  const args = buildReplicaListArgs(app);
  let listed;
  try {
    listed = await listFn(args);
  } catch {
    return null;
  }
  const raw = `${listed && listed.stdout || ''}`;
  return parseRunningReplica(raw, app);
}

async function correlateEmailLunaLogs(logsFn, requestId, secrets, options) {
  const logArgs = buildEmailLunaAttemptLogsArgs(requestId, options);
  if (!logArgs) return fail('logs_uncorrelated');
  let logResult;
  try {
    logResult = await logsFn(logArgs);
  } catch {
    return fail('logs_uncorrelated');
  }
  const logOut = `${logResult && logResult.stdout || ''}`;
  return parseEmailLunaAttemptLogs(logOut, requestId, secrets, {
    nowMs: options && options.nowMs,
    windowMs: options && options.windowMs,
    revision: options && options.revision,
    app: EMAIL_LUNA_APP,
    resourceGroup: RG,
    requireTimestamp: options && options.requireTimestamp === true,
  });
}

function completeDeployedProof(inner, requestId, extras) {
  const proved = freeze({
    ok: true,
    reason: null,
    invoked: 1,
    marker: freeze({
      provider: inner.marker.provider,
      model: inner.marker.model,
      runtime: inner.marker.runtime,
    }),
    request_id: requestId,
    hmac_verified: true,
    logs_correlated: true,
    cas_advanced: inner.cas_advanced === true,
    reconciled: extras && extras.reconciled === true,
    deltas: freeze({
      approvals: 0,
      journal: 0,
      sends: 0,
      bookings: 0,
    }),
    draftChars: inner.draftChars,
  });
  return freeze({
    ...proved,
    public: publicProofOutput(proved),
  });
}

async function reconcileDeployedProof(input, context) {
  const {
    attemptId, conversationId, secrets, azBin, env, logsFn, lunaTarget, nowMs,
  } = context;
  const reconcileFn = typeof (input && input.reconcileStaff) === 'function'
    ? input.reconcileStaff
    : typeof (input && input.execStaff) === 'function'
      ? input.execStaff
      : (spec) => spawnPtyHarness(spec, { timeoutMs: 120000, env });
  let harness;
  try {
    harness = constructStaffOwnerExecHarness({
      conversationId,
      attemptId,
      replica: context.staffTarget.replica,
      revision: context.staffTarget.revision,
      azBin,
      reconcileOnly: true,
    });
  } catch {
    return fail('indeterminate_no_retry', { attempt_id: attemptId });
  }
  let ownerState = null;
  try {
    const recResult = await reconcileFn(harness);
    const recOut = `${recResult && recResult.stdout || ''}${recResult && recResult.stderr || ''}`;
    ownerState = extractProofJson(recOut, secrets);
  } catch {
    return fail('indeterminate_no_retry', { attempt_id: attemptId });
  }
  let correlated;
  try {
    correlated = await correlateEmailLunaLogs(logsFn, attemptId, secrets, {
      revision: lunaTarget && lunaTarget.revision,
      replica: lunaTarget && lunaTarget.replica,
      nowMs,
      requireTimestamp: true,
    });
  } catch {
    return fail('indeterminate_no_retry', { attempt_id: attemptId });
  }
  const logsOk = correlated && correlated.ok === true && correlated.request_id === attemptId;
  const draftOk = ownerState && ownerState.reconcile === true
    && Number.isSafeInteger(ownerState.draftChars) && ownerState.draftChars > 0;
  if (logsOk && draftOk) {
    const proved = freeze({
      ok: true,
      reason: null,
      invoked: 1,
      reconciled: true,
      marker: freeze({
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        runtime: 'sunset-email-luna',
      }),
      request_id: attemptId,
      hmac_verified: true,
      logs_correlated: true,
      cas_advanced: true,
      draftChars: ownerState.draftChars,
      draft_changed: true,
    });
    return freeze({
      ...proved,
      public: publicProofOutput(proved),
    });
  }
  return fail('indeterminate_no_retry', { attempt_id: attemptId });
}

async function runDeployedCreateDraftProof(input) {
  const env = (input && input.env) || process.env;
  const conversationId = snapshotConversationId(
    input && input.conversation_id || ownData(env, 'EMAIL_LUNA_PROOF_CONVERSATION_ID'),
  );
  const attemptId = snapshotConversationId(input && input.attempt_id)
    || proofAttemptIdFrom(input, env)
    || snapshotConversationId(crypto.randomUUID());
  if (!conversationId || !attemptId) return fail('authority_mismatch');
  if (ownData(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) return fail('authority_mismatch');
  const secrets = [conversationId, LIVE_NOTES];
  const azBin = (input && input.azBin) || ownData(env, 'AZ') || AZ_DEFAULT;
  const nowMs = input && Number.isSafeInteger(input.nowMs) ? input.nowMs : Date.now();
  let staffTarget;
  let lunaTarget;
  try {
    staffTarget = await selectRunningTarget(input, STAFF_APP, azBin, env);
    lunaTarget = await selectRunningTarget({
      replica: input && input.emailLunaReplica,
      revision: input && input.emailLunaRevision,
      resourceGroup: input && input.resourceGroup,
      app: input && input.emailLunaApp,
      deployment: input && input.deployment,
      listReplicas: input && input.listEmailLunaReplicas || input && input.listReplicas,
    }, EMAIL_LUNA_APP, azBin, env);
  } catch (error) {
    if (error && error.message === 'wrong_target') return fail('wrong_target', { attempt_id: attemptId });
    return fail('staff_exec_failed', { attempt_id: attemptId });
  }
  if (!staffTarget || !staffTarget.replica || !staffTarget.revision) {
    return fail('staff_exec_failed', { attempt_id: attemptId });
  }
  let harness;
  try {
    harness = constructStaffOwnerExecHarness({
      conversationId,
      attemptId,
      replica: staffTarget.replica,
      revision: staffTarget.revision,
      azBin,
      resourceGroup: input && input.resourceGroup,
      app: input && input.app,
      deployment: input && input.deployment,
    });
  } catch (error) {
    if (error && error.message === 'pty_required') return fail('pty_required', { attempt_id: attemptId });
    if (error && error.message === 'wrong_target') return fail('wrong_target', { attempt_id: attemptId });
    return fail('staff_exec_failed', { attempt_id: attemptId });
  }
  const execFn = typeof (input && input.execStaff) === 'function'
    ? input.execStaff
    : (spec) => spawnPtyHarness(spec, { timeoutMs: 240000, env });
  const logsFn = typeof (input && input.showLogs) === 'function'
    ? input.showLogs
    : (args) => spawnAz(azBin, args, { timeoutMs: 60000, env });
  const reconContext = {
    attemptId,
    conversationId,
    secrets,
    azBin,
    env,
    logsFn,
    staffTarget,
    lunaTarget,
    nowMs,
  };
  let execResult;
  try {
    execResult = await execFn(harness);
  } catch {
    return fail('staff_exec_failed', { attempt_id: attemptId });
  }
  const execStatus = execResult && Number.isSafeInteger(execResult.status) ? execResult.status : 1;
  const execOut = `${execResult && execResult.stdout || ''}${execResult && execResult.stderr || ''}`;
  const mutationIssued = execOut.includes(MUTATION_ISSUED_MARKER);
  const inner = extractProofJson(execOut, secrets);
  if (execStatus === 0 && inner && (inner.ok === true || inner.ok === false)) {
    if (inner.success === true && inner.message_text && inner.hmac_verified !== true) {
      return fail('fake_staff_200', { attempt_id: attemptId });
    }
    if (inner.ok !== true) {
      return fail((inner.reason) || 'staff_exec_failed', { attempt_id: attemptId });
    }
    if (!innerProofLooksComplete(inner)) {
      return fail('authenticity_mismatch', { attempt_id: attemptId });
    }
    const requestId = uuid(inner.request_id);
    if (requestId !== attemptId) return fail('request_id_mismatch', { attempt_id: attemptId });
    const correlated = await correlateEmailLunaLogs(logsFn, requestId, secrets, {
      revision: lunaTarget && lunaTarget.revision,
      replica: lunaTarget && lunaTarget.replica,
      nowMs,
      requireTimestamp: true,
    });
    if (!correlated || correlated.ok !== true) {
      return fail(correlated && correlated.reason ? correlated.reason : 'logs_uncorrelated', { attempt_id: attemptId });
    }
    return completeDeployedProof(inner, requestId, { reconciled: false });
  }
  if (mutationIssued) {
    if (innerProofLooksComplete(inner)) {
      const requestId = uuid(inner.request_id);
      if (requestId === attemptId) {
        const correlated = await correlateEmailLunaLogs(logsFn, requestId, secrets, {
          revision: lunaTarget && lunaTarget.revision,
          replica: lunaTarget && lunaTarget.replica,
          nowMs,
          requireTimestamp: true,
        });
        if (correlated && correlated.ok === true) {
          return completeDeployedProof(inner, requestId, { reconciled: true });
        }
      }
    }
    return reconcileDeployedProof(input, reconContext);
  }
  return fail('staff_exec_failed', { attempt_id: attemptId });
}

async function runMailMvp007CreateDraftProof(input) {
  const env = (input && input.env) || process.env;
  if (ownData(env, 'MAIL_MVP_007_LIVE_PROOF') !== '1') {
    return fail('live_proof_disabled');
  }
  if (ownData(env, 'MAIL_MVP_007_RECONCILE_ONLY') === '1') {
    return runStaffOwnerReconcile(input);
  }
  if (ownData(env, 'MAIL_MVP_007_STAFF_OWNER_PROOF') === '1') {
    return runStaffOwnerProof(input);
  }
  return runDeployedCreateDraftProof(input);
}

module.exports = freeze({
  LIVE_NOTES,
  EMAIL_LUNA_CREATE_DRAFT_PATH,
  SQL_COUNT_APPROVALS,
  SQL_COUNT_JOURNAL,
  SQL_COUNT_BOOKINGS,
  SQL_COUNT_SENDS,
  SQL_STANDING_DRAFT,
  SQL_RESOLVE_PROOF_ACTOR,
  AZ_DEFAULT,
  PTY_BIN,
  RG,
  STAFF_APP,
  EMAIL_LUNA_APP,
  SUNSET_DEPLOYMENT,
  LOG_WINDOW_MS,
  createMailMvp007LiveProof,
  createProductionStaffCreateDraftOwner,
  readHermesSolAttemptDiagnostics,
  publicProofOutput,
  redactSensitive,
  brandProductionCreateDraft,
  isProductionCreateDraft,
  buildStaffOwnerExecArgs,
  buildStaffOwnerExecAzArgs,
  buildStaffOwnerRemoteCommand,
  constructStaffOwnerExecHarness,
  isLegalPtyExecSpec,
  wrapPtyAzExec,
  spawnAz,
  spawnPtyHarness,
  buildReplicaListArgs,
  parseRunningReplica,
  buildEmailLunaAttemptLogsArgs,
  parseEmailLunaAttemptLogs,
  extractProofJson,
  runStaffOwnerProof,
  runStaffOwnerReconcile,
  runDeployedCreateDraftProof,
  runMailMvp007CreateDraftProof,
});
