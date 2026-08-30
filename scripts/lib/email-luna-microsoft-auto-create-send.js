'use strict';

/**
 * MAIL-MVP-003 — Microsoft Auto create-and-send owner.
 *
 * Dormant by default. Provider auto-send requires both emergency flags as the
 * literal string `true`:
 *   LUNA_AUTO_SEND_ENABLED
 *   LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED
 *
 * SAME-DESK-004 — WhatsApp-like Staff-API auto-send on the same inbound
 * seam, without the dormant email emergency flag. Auto-send only when
 * conversation Luna is On, needs_human is false, and Global Pause is off.
 * needs_human keeps Approve & send. Luna Off / Global Pause stay draft-only.
 *
 * Does not read CUSTOMER_OUTREACH_EMAIL_ENABLED.
 * Pause remains `bot_pause_states` via getPauseState (fail closed).
 * Draft author is the proven Create Draft producer (empty operator context).
 * Send reuses staff Approve & send: approval + journal + provider transport.
 */

const util = require('node:util');
const { getPauseState } = require('./staff-bot-pause-sql');
const { validateOutboundReplySubject } = require('./email-outbound-reply-subject');
const {
  createEmailInboxChannelModeStore,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
} = require('./email-inbox-channel-mode');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;

const ENV_LUNA_AUTO_SEND_ENABLED = 'LUNA_AUTO_SEND_ENABLED';
const ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED = 'LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED';
const ENV_OUTREACH = 'CUSTOMER_OUTREACH_EMAIL_ENABLED';
const SUNSET_SLUG = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SQL_RESOLVE_AUTO_ACTOR = `
SELECT su.id::text AS staff_user_id, su.client_id::text AS client_id, su.role::text AS role
  FROM staff_users su
  INNER JOIN clients cl ON cl.id=su.client_id
 WHERE su.client_id=$1::uuid AND cl.slug='sunset' AND su.status='active'
   AND su.role IN ('owner','admin','operator')
 ORDER BY CASE su.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, su.id
 LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_AUTO_CONTEXT = `
SELECT cl.id::text AS client_id, cl.slug AS client_slug,
  loc.id::text AS location_id, loc.location_id AS location_key,
  ep.id::text AS endpoint_id, c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_message_id,
  ev.provider, ev.provider_mailbox_id, ev.provider_message_id AS provider_source_message_id,
  c.needs_human AS needs_human, c.status AS conversation_status
FROM clients cl
INNER JOIN conversations c ON c.client_id=cl.id AND c.id=$2::uuid
  AND c.phone ~ '^(emailv1|email):'
INNER JOIN tenant_email_inbound_inbox_projections p
  ON p.client_id=c.client_id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev
  ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
  AND ev.location_id=p.location_id AND ev.endpoint_id=p.endpoint_id
  AND ev.provider=p.provider AND ev.provider_mailbox_id=p.provider_mailbox_id
  AND ev.provider_message_id=p.provider_message_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.location_id=loc.location_id
  AND ep.channel='email' AND ep.provider='microsoft_graph'
  AND ep.auth_mode='delegated_authorization_code'
  AND ep.connector_mode='microsoft_delegated_oauth'
  AND ep.mailbox_access_kind='own_user'
  AND ep.binding_status='verified'
  AND ep.public_address IS NOT NULL AND btrim(ep.public_address) <> ''
  AND ep.provider_resource_id IS NOT NULL AND btrim(ep.provider_resource_id) <> ''
  AND ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND ev.provider_mailbox_id=ep.provider_resource_id
WHERE cl.id=$1::uuid AND cl.slug='sunset' AND loc.location_id='sunset-somo'
  AND ev.provider='microsoft_graph'
ORDER BY ev.received_at DESC, ev.id DESC
LIMIT 1
`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_EXISTING_APPROVAL = `
SELECT approval_id::text AS approval_id, operation_id::text AS operation_id,
  message_text, state, subject, source_inbound_event_id::text AS source_inbound_event_id
FROM tenant_email_reply_approvals
WHERE client_id=$1::uuid AND conversation_id=$2::uuid
  AND source_inbound_event_id=$3::uuid
  AND state IN ('draft','approved','terminal')
ORDER BY updated_at DESC
LIMIT 1
`.replace(/\s+/g, ' ').trim();

function ownData(o, k) {
  try {
    const d = getDescriptor(o, k);
    return d && hasOwn(d, 'value') && d.enumerable && !d.get && !d.set ? d.value : undefined;
  } catch {
    return undefined;
  }
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

function envOwn(env, key) {
  if (!env || typeof env !== 'object' || isProxy(env)) return undefined;
  const own = ownData(env, key);
  if (own !== undefined) return own;
  try { return env[key]; } catch { return undefined; }
}

function isLiteralTrue(env, key) {
  return envOwn(env, key) === 'true';
}

function isEmailMicrosoftAutoSendEmergencyEnabled(env) {
  return isLiteralTrue(env, ENV_LUNA_AUTO_SEND_ENABLED)
    && isLiteralTrue(env, ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED);
}

/** WhatsApp-like kill switch only. Does not enable the dormant MAIL-MVP-003 pair. */
function isSameDeskEmailAutoSendEnabled(env) {
  return isLiteralTrue(env, ENV_LUNA_AUTO_SEND_ENABLED)
    && !isEmailMicrosoftAutoSendEmergencyEnabled(env);
}

const CLOSED_SAVE_FAIL_REASONS = freeze([
  'stale_authority',
  'email_mailbox_not_sendable',
  'conversation_not_found',
  'draft_insert_failed',
  'subject_invalid',
  'approval_not_saved',
]);
const CLOSED_SAVE_STAGES = freeze([
  'snapshot_body',
  'digest',
  'persist_begin',
  'persist_subject',
  'persist_insert',
  'persist_commit',
  'persist_client',
]);
const PG_ERRCODE_RE = /^[0-9A-Z]{5}$/;

function closedSaveFailReason(value) {
  if (typeof value !== 'string') return 'approval_not_saved';
  for (const reason of CLOSED_SAVE_FAIL_REASONS) {
    if (reason === value) return reason;
  }
  return 'approval_not_saved';
}

function closedSaveStage(value) {
  if (typeof value !== 'string') return null;
  for (const stage of CLOSED_SAVE_STAGES) {
    if (stage === value) return stage;
  }
  return null;
}

function closedPgErrcode(value) {
  try {
    if (typeof value === 'string') return PG_ERRCODE_RE.test(value) ? value : null;
    if (!value || typeof value !== 'object' || isProxy(value)) return null;
    const direct = ownData(value, 'pg_code') || ownData(value, 'code') || ownData(value, 'sqlState');
    if (typeof direct === 'string' && PG_ERRCODE_RE.test(direct)) return direct;
    return null;
  } catch {
    return null;
  }
}

function saveThrowDiagnostics(err, saved) {
  const extra = { draft_writes: 1 };
  const stage = closedSaveStage(
    (err && err.save_stage) || (saved && saved.save_stage),
  );
  const pg = closedPgErrcode(err) || closedPgErrcode(saved && saved.pg_code);
  if (stage) extra.save_stage = stage;
  if (pg) extra.pg_code = pg;
  return extra;
}

function blocked(reason, extra) {
  return freeze({
    status: 'blocked',
    reason,
    draft_writes: 0,
    approvals: 0,
    journals: 0,
    provider_sends: 0,
    sent: false,
    ...(extra || {}),
  });
}

function failed(reason, extra) {
  return freeze({
    status: 'failed',
    reason,
    draft_writes: extra && extra.draft_writes ? extra.draft_writes : 0,
    approvals: extra && extra.approvals ? extra.approvals : 0,
    journals: extra && extra.journals ? extra.journals : 0,
    provider_sends: extra && extra.provider_sends ? extra.provider_sends : 0,
    sent: false,
    ...(extra || {}),
  });
}

function succeeded(extra) {
  return freeze({
    status: 'sent',
    reason: null,
    draft_writes: 1,
    approvals: 1,
    journals: 1,
    provider_sends: 1,
    sent: true,
    ...(extra || {}),
  });
}

function skippedDuplicate(extra) {
  return freeze({
    status: 'skipped',
    reason: 'already_sent',
    draft_writes: 0,
    approvals: 0,
    journals: 0,
    provider_sends: 0,
    sent: false,
    ...(extra || {}),
  });
}

async function defaultResolveAutoActor(withPgClient, clientId) {
  const loaded = await withPgClient(async (pg) => pg.query(SQL_RESOLVE_AUTO_ACTOR, [clientId]));
  const row = loaded && Array.isArray(loaded.rows) && loaded.rows.length === 1 ? loaded.rows[0] : null;
  if (!row) return null;
  const staffId = uuid(ownData(row, 'staff_user_id') || row.staff_user_id);
  const cid = uuid(ownData(row, 'client_id') || row.client_id);
  const role = ownData(row, 'role') || row.role;
  if (!staffId || !cid || !['owner', 'admin', 'operator'].includes(role)) return null;
  const actor = Object.create(null);
  actor.staff_user_id = staffId;
  actor.client_id = cid;
  actor.role = role;
  return freeze(actor);
}

async function defaultReadPause(pg, conversationId) {
  try {
    const result = await getPauseState(pg, {
      client_slug: SUNSET_SLUG,
      conversation_id: conversationId,
    });
    if (!result || result.table_missing) {
      return { lookup_error: true, global_paused: true, conversation_paused: true };
    }
    return {
      lookup_error: false,
      global_paused: result.global_pause === true,
      conversation_paused: !!(result.row && result.global_pause !== true),
    };
  } catch {
    return { lookup_error: true, global_paused: true, conversation_paused: true };
  }
}

function createEmailLunaMicrosoftAutoCreateAndSend(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('auto_create_send_deps');
  const withPgClient = typeof deps.withPgClient === 'function' ? deps.withPgClient : null;
  const regenerate = typeof deps.regenerateEmailLunaDraftOnStaffClick === 'function'
    ? deps.regenerateEmailLunaDraftOnStaffClick : null;
  const saveDraft = typeof deps.saveDraftThroughStaffOwner === 'function'
    ? deps.saveDraftThroughStaffOwner : null;
  const approveAndDispatch = typeof deps.approveAndDispatchEmailOutbound === 'function'
    ? deps.approveAndDispatchEmailOutbound : null;
  const recoverSend = typeof deps.recoverApprovedOutbound === 'function'
    ? deps.recoverApprovedOutbound : null;
  const getEmailChannelMode = typeof deps.getEmailChannelMode === 'function'
    ? deps.getEmailChannelMode : null;
  const readPause = typeof deps.readPause === 'function' ? deps.readPause : null;
  const resolveAutoActor = typeof deps.resolveAutoActor === 'function' ? deps.resolveAutoActor : null;
  const journalExists = typeof deps.journalExists === 'function' ? deps.journalExists : null;
  if (!withPgClient || !regenerate || !saveDraft || !approveAndDispatch) {
    throw new Error('auto_create_send_deps');
  }

  async function channelMode(clientId) {
    if (getEmailChannelMode) return getEmailChannelMode(clientId);
    const store = createEmailInboxChannelModeStore({ withPgClient });
    return store.getChannelMode(clientId, 'email');
  }

  async function runProjectedInbound(input, policy) {
    const env = input && input.env;
    const authority = input && input.authority;
    const envelope = input && input.envelope;
    const projection = input && input.projection;
    const sameDesk = policy && policy.sameDesk === true;
    if (sameDesk) {
      if (!isLiteralTrue(env, ENV_LUNA_AUTO_SEND_ENABLED)) {
        return blocked('luna_auto_send_not_enabled');
      }
    } else if (!isEmailMicrosoftAutoSendEmergencyEnabled(env)) {
      return blocked('emergency_flags_off');
    }
    if (!projection || (projection.status !== 'projected' && projection.status !== 'already_projected')) {
      return blocked('not_projected');
    }
    const provider = envelope && (ownData(envelope, 'provider') || envelope.provider);
    if (provider !== 'microsoft_graph') return blocked('provider_not_microsoft');

    const clientId = uuid(authority && (authority.clientId || authority.client_id));
    const locationId = uuid(authority && (authority.locationId || authority.location_id));
    const endpointId = uuid(authority && (authority.endpointId || authority.endpoint_id));
    const conversationId = uuid(projection.conversation_id);
    if (!clientId || !locationId || !endpointId || !conversationId) {
      return blocked('authority_mismatch');
    }

    const mode = await channelMode(clientId);
    if (mode !== 'auto') return blocked('email_channel_not_auto');

    const actor = resolveAutoActor
      ? await resolveAutoActor(clientId)
      : await defaultResolveAutoActor(withPgClient, clientId);
    if (!actor || actor.client_id !== clientId) return blocked('auto_actor_unavailable');

    const pause = readPause
      ? await readPause(conversationId)
      : await withPgClient(async (pg) => defaultReadPause(pg, conversationId));
    if (!pause || pause.lookup_error === true) return blocked('pause_fail_closed');
    if (pause.global_paused === true) return blocked('global_paused');
    if (pause.conversation_paused === true) return blocked('luna_off');

    const ctx = await withPgClient(async (pg) => {
      const loaded = await pg.query(SQL_LOAD_AUTO_CONTEXT, [clientId, conversationId]);
      const row = loaded && Array.isArray(loaded.rows) && loaded.rows.length === 1 ? loaded.rows[0] : null;
      if (!row) return null;
      const inboundId = uuid(row.inbound_message_id);
      let approval = null;
      if (inboundId) {
        const ap = await pg.query(SQL_LOAD_EXISTING_APPROVAL, [clientId, conversationId, inboundId]);
        approval = ap && Array.isArray(ap.rows) && ap.rows.length === 1 ? ap.rows[0] : null;
      }
      return { row, approval };
    });
    if (!ctx || !ctx.row) return blocked('authority_mismatch');
    const row = ctx.row;
    if (String(row.client_slug) !== SUNSET_SLUG) return blocked('authority_mismatch');
    if (String(row.location_key) !== SUNSET_LOCATION_KEY) return blocked('authority_mismatch');
    if (uuid(row.client_id) !== clientId || uuid(row.location_id) !== locationId
        || uuid(row.endpoint_id) !== endpointId) {
      return blocked('authority_mismatch');
    }
    if (uuid(row.conversation_id) !== conversationId) return blocked('authority_mismatch');
    if (row.provider !== 'microsoft_graph') return blocked('provider_not_microsoft');
    if (row.conversation_status && row.conversation_status !== 'open') return blocked('conversation_not_open');
    if (row.needs_human === true) return blocked('needs_human');

    const inboundEventId = uuid(row.inbound_message_id);
    const mailboxId = typeof row.provider_mailbox_id === 'string' ? row.provider_mailbox_id : null;
    const sourceMessageId = typeof row.provider_source_message_id === 'string'
      ? row.provider_source_message_id : null;
    if (!mailboxId || !sourceMessageId) return blocked('authority_mismatch');
    const expectedAuthority = freeze({
      client_id: clientId,
      location_id: locationId,
      location_key: SUNSET_LOCATION_KEY,
      endpoint_id: endpointId,
      conversation_id: conversationId,
      source_inbound_event_id: inboundEventId,
      provider: 'microsoft_graph',
      provider_mailbox_id: mailboxId,
      provider_source_message_id: sourceMessageId,
    });

    const existing = ctx.approval;
    if (existing && (existing.state === 'approved' || existing.state === 'terminal')) {
      const hasJournal = journalExists
        ? await journalExists(existing)
        : true;
      if (hasJournal) {
        if (recoverSend && existing.state === 'approved') {
          const recovered = await recoverSend({
            actor,
            conversation_id: conversationId,
            approval_id: existing.approval_id,
            env,
          });
          const recoveredSend = recovered && recovered.code === 'email_send_committed';
          return skippedDuplicate({
            approval_id: existing.approval_id,
            recovered: true,
            provider_sends: recoveredSend ? 0 : 0,
          });
        }
        return skippedDuplicate({ approval_id: existing.approval_id });
      }
      const dispatched = await approveAndDispatch({
        actor,
        conversation_id: conversationId,
        message_text: existing.message_text,
        approval_id: existing.approval_id,
        subject: existing.subject,
        env,
      });
      const committed = dispatched && dispatched.code === 'email_send_committed'
        && dispatched.status === 200;
      if (committed) {
        return succeeded({
          approval_id: existing.approval_id,
          draft_writes: 0,
          reused_approval: true,
        });
      }
      return failed('provider_failure', {
        approval_id: existing.approval_id,
        approvals: 0,
        journals: dispatched && dispatched.journaled ? 1 : 0,
        provider_sends: dispatched && dispatched.provider_invoked ? 1 : 0,
        code: dispatched && dispatched.code,
      });
    }

    if (existing && existing.state === 'draft' && existing.message_text) {
      const dispatched = await approveAndDispatch({
        actor,
        conversation_id: conversationId,
        message_text: existing.message_text,
        approval_id: existing.approval_id,
        subject: existing.subject,
        env,
      });
      const committed = dispatched && dispatched.code === 'email_send_committed'
        && dispatched.status === 200;
      if (committed) {
        return succeeded({
          approval_id: existing.approval_id,
          draft_writes: 0,
          reused_approval: true,
        });
      }
      return failed('provider_failure', {
        approval_id: existing.approval_id,
        approvals: 0,
        journals: dispatched && dispatched.journaled ? 1 : 0,
        provider_sends: dispatched && dispatched.provider_invoked ? 1 : 0,
        code: dispatched && dispatched.code,
      });
    }

    let draft;
    try {
      draft = await regenerate({
        actor,
        conversation_id: conversationId,
        operator_context: '',
        gateEnv: env,
      });
    } catch {
      return failed('author_failed');
    }
    if (!draft || draft.status !== 'draft_ready' || typeof draft.draft_text !== 'string'
        || !draft.draft_text) {
      return failed(draft && draft.status === 'conflict' ? 'conflict' : 'author_failed');
    }

    let saved;
    try {
      const saveInput = {
        actor,
        conversation_id: conversationId,
        message_text: draft.draft_text,
        approval_id: null,
        expected_authority: expectedAuthority,
      };
      const subjectCheck = typeof draft.subject === 'string'
        ? validateOutboundReplySubject(draft.subject) : null;
      if (subjectCheck && subjectCheck.ok === true) saveInput.subject = subjectCheck.value;
      saved = await saveDraft(saveInput);
    } catch (err) {
      const thrown = err && err.code === 'subject_invalid' ? 'subject_invalid' : 'approval_not_saved';
      return failed(closedSaveFailReason(thrown), saveThrowDiagnostics(err, null));
    }
    if (!saved || saved.status !== 'saved' || !saved.approval_id) {
      if (saved && saved.code === 'draft_identity_claimed') {
        const reloaded = await withPgClient(async (pg) => {
          const ap = await pg.query(SQL_LOAD_EXISTING_APPROVAL, [clientId, conversationId, inboundEventId]);
          return ap && Array.isArray(ap.rows) && ap.rows.length === 1 ? ap.rows[0] : null;
        });
        if (reloaded && (reloaded.state === 'approved' || reloaded.state === 'terminal')) {
          const hasJournal = journalExists ? await journalExists(reloaded) : true;
          if (hasJournal) {
            return skippedDuplicate({ approval_id: reloaded.approval_id, peer_claimed: true });
          }
          return failed('provider_failure', {
            approval_id: reloaded.approval_id,
            code: 'email_send_outcome_unknown',
            draft_writes: 0,
            approvals: 0,
            journals: 0,
            provider_sends: 0,
          });
        }
        return freeze({
          status: 'skipped',
          reason: 'already_claimed',
          draft_writes: 0,
          approvals: 0,
          journals: 0,
          provider_sends: 0,
          sent: false,
          approval_id: reloaded && reloaded.approval_id,
        });
      }
      return failed(closedSaveFailReason(saved && saved.code), saveThrowDiagnostics(null, saved));
    }

    let dispatched;
    try {
      dispatched = await approveAndDispatch({
        actor,
        conversation_id: conversationId,
        message_text: draft.draft_text,
        approval_id: saved.approval_id,
        subject: draft.subject,
        env,
      });
    } catch {
      return failed('provider_failure', { draft_writes: 1, approvals: 1 });
    }
    const committed = dispatched && dispatched.code === 'email_send_committed'
      && (dispatched.status === 200 || dispatched.ok === true);
    if (committed) {
      return succeeded({
        approval_id: saved.approval_id,
        conversation_id: conversationId,
      });
    }
    return failed('provider_failure', {
      draft_writes: 1,
      approvals: 1,
      journals: dispatched && dispatched.journaled ? 1 : 0,
      provider_sends: dispatched && dispatched.provider_invoked ? 1 : 0,
      approval_id: saved.approval_id,
      code: dispatched && dispatched.code,
    });
  }

  async function handleProjectedInbound(input) {
    return runProjectedInbound(input, { sameDesk: false });
  }

  async function handleSameDeskProjectedInbound(input) {
    return runProjectedInbound(input, { sameDesk: true });
  }

  return freeze({ handleProjectedInbound, handleSameDeskProjectedInbound });
}

async function shouldSuppressInboundNeedsHuman(input) {
  const env = input && input.env;
  if (!isEmailMicrosoftAutoSendEmergencyEnabled(env)) return false;
  const clientId = uuid(input && input.clientId);
  if (!clientId) return false;
  try {
    if (typeof input.getEmailChannelMode === 'function') {
      return (await input.getEmailChannelMode(clientId)) === 'auto';
    }
    const withPgClient = input.withPgClient || (input.withTransactionClient
      ? async (fn) => input.withTransactionClient(fn)
      : null);
    if (!withPgClient) return false;
    const store = createEmailInboxChannelModeStore({ withPgClient });
    return (await store.getChannelMode(clientId, 'email')) === 'auto';
  } catch {
    return false;
  }
}

function createProductionEmailLunaMicrosoftAutoCreateAndSend(input) {
  const { createStaffEmailLunaDraftOpen } = require('./staff-email-luna-draft-open');
  const { createStaffEmailInboxRoutes } = require('./staff-email-inbox-routes');
  const { createEmailLunaSunsetStagingRuntimeComposition } = require('./email-luna-sunset-staging-runtime-composition');
  const { createEmailLunaDraftOpenContentFetcher } = require('./email-luna-draft-open-content-composition');
  const { createSunsetStagingEmailOutboundDispatch } = require('./email-outbound-sunset-staging-runtime-composition');
  const env = input.env;
  const pgClient = input.pgClient;
  const https = input.https;
  const timers = input.timers;
  const withTransactionClient = input.withTransactionClient;
  const withPgClient = typeof input.withPgClient === 'function'
    ? input.withPgClient
    : async (fn) => fn(pgClient);
  const draftOpen = createStaffEmailLunaDraftOpen({
    withPgClient,
    runtimeEnv: env,
    createLunaRuntime: createEmailLunaSunsetStagingRuntimeComposition,
    createContentFetcher(pg) {
      return createEmailLunaDraftOpenContentFetcher({
        env,
        pgClient: pg,
        https,
        timers,
      });
    },
  });
  const inboxRoutes = createStaffEmailInboxRoutes({
    sendJSON() {},
    withPgClient,
    runtimeEnv: env,
    createOutboundDispatch(pg, compositionEnv) {
      return createSunsetStagingEmailOutboundDispatch(Object.freeze({
        env: compositionEnv || env,
        pgClient: pg,
        withTransactionClient: typeof withTransactionClient === 'function'
          ? async (work) => withTransactionClient(work)
          : async (work) => work(pg),
        https,
        timers,
      }));
    },
  });
  return createEmailLunaMicrosoftAutoCreateAndSend({
    withPgClient,
    regenerateEmailLunaDraftOnStaffClick: (req) => draftOpen.regenerateEmailLunaDraftOnStaffClick(req),
    saveDraftThroughStaffOwner: (req) => inboxRoutes.saveDraftThroughStaffOwner(req),
    approveAndDispatchEmailOutbound: (req) => inboxRoutes.approveAndDispatchEmailOutbound(req),
    getEmailChannelMode: input.getEmailChannelMode,
    readPause: input.readPause,
    resolveAutoActor: input.resolveAutoActor,
    journalExists: input.journalExists,
  });
}

function resolveAutoOwner(input) {
  if (input && input.owner) return input.owner;
  if (input && typeof input.regenerateEmailLunaDraftOnStaffClick === 'function') {
    return createEmailLunaMicrosoftAutoCreateAndSend(input);
  }
  return createProductionEmailLunaMicrosoftAutoCreateAndSend(input);
}

async function afterMicrosoftInboundProjected(input) {
  if (!isEmailMicrosoftAutoSendEmergencyEnabled(input && input.env)) {
    return blocked('emergency_flags_off');
  }
  return resolveAutoOwner(input).handleProjectedInbound(input);
}

async function afterSameDeskEmailAutoSend(input) {
  if (isEmailMicrosoftAutoSendEmergencyEnabled(input && input.env)) {
    return afterMicrosoftInboundProjected(input);
  }
  if (!isLiteralTrue(input && input.env, ENV_LUNA_AUTO_SEND_ENABLED)) {
    return blocked('luna_auto_send_not_enabled');
  }
  return resolveAutoOwner(input).handleSameDeskProjectedInbound(input);
}

module.exports = {
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
  ENV_OUTREACH,
  isEmailMicrosoftAutoSendEmergencyEnabled,
  isSameDeskEmailAutoSendEnabled,
  createEmailLunaMicrosoftAutoCreateAndSend,
  createProductionEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
  afterSameDeskEmailAutoSend,
  shouldSuppressInboundNeedsHuman,
  SQL_RESOLVE_AUTO_ACTOR,
  SQL_LOAD_AUTO_CONTEXT,
  SQL_LOAD_EXISTING_APPROVAL,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
};
