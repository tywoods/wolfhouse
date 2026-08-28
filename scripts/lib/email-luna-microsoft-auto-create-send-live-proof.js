'use strict';

/**
 * MAIL-MVP-004 — bounded Sunset-staging-only operator proof of MAIL-MVP-003.
 *
 * Default refuse. One Microsoft auto create-and-send through the canonical
 * 003 production owner for the existing guest-linked thread
 * subject `Testing 8 26`, sender `twoods@xantrion.com`.
 *
 * Does not rebuild 003. Does not execute live Azure/Graph unless a later
 * operator run is explicitly authorized against an exact-master image.
 * Copied scripts inside an old image are not proof.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const util = require('node:util');
const {
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
  isEmailMicrosoftAutoSendEmergencyEnabled,
  createEmailLunaMicrosoftAutoCreateAndSend,
  createProductionEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
} = require('./email-luna-microsoft-auto-create-send');
const {
  createEmailInboxChannelModeStore,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
} = require('./email-inbox-channel-mode');
const { normalizeInboundEmailAddress } = require('./email-inbound-conversation-identity');
const {
  digestGeneratedEmailLunaDraftBody,
  mintSelectedOperationSolEvidence,
  verifySelectedOperationSolEvidence,
  sanitizeSelectedOperationEvidence,
} = require('./staff-email-luna-draft-open');
const { ENV_HMAC_SECRET } = require('./email-luna-sunset-email-hermes-sol-activation');
const {
  createDelegatedGrantAccessSession,
  bindTrustedDelegatedGrantAccessSessionInternalStageObserver,
  readTrustedDelegatedGrantAccessSessionInternalStage,
  DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
} = require('./email-delegated-grant-access-session');
const {
  createSunsetMicrosoftOAuthClientSecretProvider,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const getDescriptor = Object.getOwnPropertyDescriptor;
const hasOwn = Object.hasOwn;

const ERROR_CODE = 'MAIL_MVP_004_LIVE_PROOF_INVALID';
const ERROR_MESSAGE = 'MAIL-MVP-004 Sunset auto create-and-send proof refused.';
const PROOF_VERSION = 'mail_mvp_004_v1';
const CONFIRMATION_PHRASE = 'I_UNDERSTAND_SUNSET_STAGING_MAIL_MVP_004_ONE_SHOT_AUTO_CREATE_AND_SEND';
const COMMAND = 'execute-once';
const PREFLIGHT_COMMAND = 'preflight';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const EXPECTED_DATABASE = 'sunset_staging';
const RG = 'luna-sunset-staging-rg';
const STAFF_APP = 'luna-sunset-staging-staff-api';
const EMAIL_LUNA_APP = 'luna-sunset-staging-email-luna';
const ACR_REGISTRY = 'whstagingacr';
const ACR_REPOSITORY = 'luna-sunset-staff-api';
const IMAGE_REPOSITORY = `${ACR_REGISTRY}.azurecr.io/${ACR_REPOSITORY}`;
const AZURE_JSON_MAX_BYTES = 10 * 1024 * 1024;
const AZURE_JSON_NOISE_MAX_BYTES = 8192;
const AZURE_JSON_NOISE_MAX_LINES = 32;
const PROOF_SUBJECT = 'Testing 8 26';
const PROOF_SENDER = 'twoods@xantrion.com';
const AZ_DEFAULT = '/opt/data/home/.local/bin/az';
const PTY_BIN = '/usr/bin/script';
const PROOF_REMOTE_NODE = 'scripts/prove-mail-mvp-004-auto-create-send.js';
const MUTATION_ISSUED_MARKER = 'MAIL_MVP_004_MUTATION_ISSUED';
const CAPABILITY_PURPOSE = 'mail_mvp_004_staff_owner';
const OPERATION_BINDING = 'Testing 8 26|twoods@xantrion.com';
const DEFAULT_NONCE_STORE_PATH = path.join(os.tmpdir(), 'mail-mvp-004-used-nonces.json');
const INNER_CONSUMED_CAPABILITY_PATH = '/tmp/mail-mvp-004-consumed-capabilities.json';
const INNER_DISPATCH_RECEIPT_PATH = '/tmp/mail-mvp-004-dispatch-receipt.json';
const OPERATOR_NONCE_RE = /^[0-9a-f]{64}$/;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_FUTURE_SKEW_MS = 60 * 1000;
const STAFF_OWNER_EXEC_TIMEOUT_MS = 12 * 60 * 1000;
const STAFF_OWNER_COMPLETION_WAIT_MS = 10 * 60 * 1000;
const SNAPSHOT_EXEC_TIMEOUT_MS = 180 * 1000;
// Successor readiness only. Observed ACA flag successor ~6m; ACA WebSocket exec
// is globally 429/unstable after Graph preflight, so flag proof does not wait
// 630s/20m for printenv. Operator confirm window stays 15m and is evaluated
// once at execute-once start; capability is issued after attest.
const REVISION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const REVISION_WAIT_INTERVAL_MS = 2000;
const FLAGS_SOURCE_TEMPLATE = 'template';
const FLAGS_SOURCE_REPLICA_PROCESS = 'replica_process';
const FLAGS_SOURCE_ACA_IMMUTABLE_REVISION = 'aca_immutable_revision';
// Floor used only to recognize trusted 429 Retry-After=600. Flag proof does not
// wait this cooldown: one optional printenv, then ACA-native revision proof.
const REPLICA_ATTEST_COOLDOWN_MS = 10 * 60 * 1000;
// Cap on trusted Retry-After seconds (Azure WebSocket HTTP 429 Retry-After=600).
const REPLICA_ATTEST_RETRY_AFTER_MAX_S = 600;
const REPLICA_ATTEST_RETRY_AFTER_SLACK_MS = 30 * 1000;
const REPLICA_ATTEST_RETRY_AFTER_WAIT_MS = REPLICA_ATTEST_COOLDOWN_MS
  + REPLICA_ATTEST_RETRY_AFTER_SLACK_MS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_AZ_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SAFE_B64 = /^[A-Za-z0-9+/]+=*$/;
const USED_OPERATOR_NONCES = new Set();
const PRODUCTION_AUTO_OWNERS = new WeakSet();
const PRODUCTION_GRAPH_VERIFIERS = new WeakSet();
const PRODUCTION_SUPERVISORS = new WeakSet();
const PRODUCTION_PG_ADAPTERS = new WeakSet();
const PRODUCTION_REPLICA_ENV_ATTESTORS = new WeakSet();
const PRODUCTION_KILL_SWITCHES = new WeakSet();
const PRODUCTION_STAFF_OWNER_EXEC_RESULTS = new WeakSet();
/** Brand for inner GRAPH_VERIFY replica one-bit diag. Untrusted objects cannot mint these. */
const GRAPH_INNER_REPLICA_DIAG = new WeakSet();
const GRAPH_INNER_DTO_KEYS = freeze([
  'ok',
  'reason',
  'adapter_available',
  'readonly',
  'arrivals',
  'duplicates',
  'threaded',
  'subject_ok',
  'token_present',
  'https_present',
  'request_built',
  'stage',
  'status',
]);
const GRAPH_INNER_DTO_KEY_SET = new Set(GRAPH_INNER_DTO_KEYS);
const GRAPH_INNER_ADAPTER_REASONS = freeze([
  'graph_unproven',
  'graph_auth_unproven',
  'graph_body_leaked',
]);
const GRAPH_LIST_SELECT = freeze([
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'internetMessageHeaders',
]);
const GRAPH_LIST_FORBIDDEN_SELECT = freeze(['body', 'bodyPreview', 'uniqueBody']);
/** Exact Prefer value from canonical Graph ImmutableId transports. Caller cannot override. */
const GRAPH_PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"';
const GRAPH_GET_DEADLINE_MS = 10_000;
const GRAPH_GET_MAX_BYTES = 65536;
const GRAPH_VERIFY_WORKER_ID = 'mail-mvp-004-graph-verify';
const GRAPH_GRANT_STAGE_REASON = freeze({
  status: 'graph_grant_status_unavailable',
  lease: 'graph_grant_lease_unavailable',
  open: 'graph_grant_open_unavailable',
  secret: 'graph_client_secret_unavailable',
  token: 'graph_token_unavailable',
  response: 'graph_response_unavailable',
  dead_grant: 'graph_grant_reauth_required',
  reseal: 'graph_grant_reconcile_required',
  commit: 'graph_grant_reconcile_required',
  release: 'graph_grant_release_unavailable',
});
const GRAPH_GRANT_STATUS_SET = new Set([
  STATUS_UNAVAILABLE,
  STATUS_UNCERTAIN,
  STATUS_REAUTH,
]);
if (
  !Array.isArray(DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES)
  || DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES.some((stage) => !GRAPH_GRANT_STAGE_REASON[stage])
) {
  throw new Error('graph_grant_stage_reason_mismatch');
}
const INNER_MODE_KILL_SWITCH = 'MAIL_MVP_004_KILL_SWITCH_PROBE';
const INNER_MODE_SNAPSHOT = 'MAIL_MVP_004_SNAPSHOT';
const INNER_MODE_GRAPH_VERIFY = 'MAIL_MVP_004_GRAPH_VERIFY';
const INNER_MODE_CHANNEL_PUT = 'MAIL_MVP_004_CHANNEL_MODE_PUT';
const LEFTOVER_FOLLOWUP = /a teammate can follow up if you need anything/i;
const THREAD_TOPIC = /\b(testing|mailbox|front desk|booking|surf|room|bed|lesson|class)\b/i;
const PRODUCTION_MARKERS = freeze([
  'production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod', 'wolfhouse',
]);
const PROXY_ENV_KEYS = freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);
const REQUIRED_PROOF_FILES = freeze([
  'scripts/prove-mail-mvp-004-auto-create-send.js',
  'scripts/lib/email-luna-microsoft-auto-create-send-live-proof.js',
  'scripts/lib/email-luna-microsoft-auto-create-send.js',
  'scripts/verify-email-microsoft-auto-create-send-live-proof.js',
  'docs/MAIL-MVP-004-SUNSET-AUTO-PROOF-RUNBOOK.md',
]);
const LIVE_IMAGE_REQUIREMENT = freeze({
  must_be_origin_master: true,
  tag_must_equal_master_sha: true,
  image_repository: IMAGE_REPOSITORY,
  copied_script_is_not_proof: true,
  inner_entrypoint: PROOF_REMOTE_NODE,
  required_files: REQUIRED_PROOF_FILES,
  staff_app: STAFF_APP,
  resource_group: RG,
  deploy_preflight: 'node scripts/assert-deploy-from-master.js',
  note: 'Code copied into an old Staff image is not proof. Rebuild luna-sunset-staff-api from exact origin/master after MAIL-MVP-004 merge, tag the image with that SHA, deploy only that revision, then authorize against the serving revision+image.',
});
const ALLOWED_FLAG_KEYS = freeze([
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
]);

const SQL_SELECT_PROOF_THREAD = `
SELECT cl.id::text AS client_id, cl.slug AS client_slug,
  loc.id::text AS location_id, loc.location_id AS location_key,
  ep.id::text AS endpoint_id, c.id::text AS conversation_id,
  p.inbound_event_id::text AS inbound_message_id,
  ev.provider, ev.provider_mailbox_id,
  ev.provider_message_id AS provider_source_message_id,
  ev.sender_address, ev.sender_display_name, ev.subject,
  ev.conversation_id AS graph_conversation_id,
  ev.internet_message_id AS inbound_internet_message_id,
  c.needs_human AS needs_human, c.status AS conversation_status,
  c.guest_id::text AS guest_id
FROM clients cl
INNER JOIN conversations c ON c.client_id=cl.id AND c.phone ~ '^(emailv1|email):'
INNER JOIN tenant_email_inbound_inbox_projections p
  ON p.client_id=c.client_id AND p.conversation_id=c.id
INNER JOIN tenant_email_inbound_events ev
  ON ev.client_id=p.client_id AND ev.id=p.inbound_event_id
INNER JOIN tenant_locations loc ON loc.client_id=ev.client_id AND loc.id=ev.location_id
INNER JOIN tenant_channel_endpoints ep ON ep.client_id=ev.client_id AND ep.id=ev.endpoint_id
  AND ep.channel='email' AND ep.provider='microsoft_graph'
WHERE cl.slug='sunset' AND loc.location_id='sunset-somo'
  AND ev.provider='microsoft_graph'
  AND lower(btrim(ev.sender_address))=$1
ORDER BY ev.received_at DESC, ev.id DESC
`.replace(/\s+/g, ' ').trim();

const SQL_COUNT_OPERATION_APPROVALS = `
SELECT count(*)::int AS n
  FROM tenant_email_reply_approvals
 WHERE client_id=$1::uuid AND conversation_id=$2::uuid
   AND source_inbound_event_id=$3::uuid
`.replace(/\s+/g, ' ').trim();

const SQL_COUNT_OPERATION_JOURNAL = `
SELECT count(*)::int AS n,
       coalesce(sum(j.send_invocation_count),0)::int AS sends
  FROM tenant_email_outbound_send_journal j
  INNER JOIN tenant_email_reply_approvals a
    ON a.client_id=j.client_id AND a.approval_id=j.approval_id
 WHERE a.client_id=$1::uuid AND a.conversation_id=$2::uuid
   AND a.source_inbound_event_id=$3::uuid
`.replace(/\s+/g, ' ').trim();

const SQL_COUNT_BOOKINGS = `
SELECT count(b.id)::int AS n
  FROM conversations c
  LEFT JOIN bookings b
    ON b.client_id=c.client_id AND b.guest_id=c.guest_id
 WHERE c.client_id=$1::uuid AND c.id=$2::uuid
   AND c.guest_id IS NOT NULL
 GROUP BY c.client_id, c.id, c.guest_id
`.replace(/\s+/g, ' ').trim();

const SQL_LOAD_OPERATION_EVIDENCE = `
SELECT a.approval_id::text AS approval_id, a.message_text, a.state,
       a.body_digest, j.immutable_draft_id, j.phase, j.outcome,
       j.send_invocation_count::int AS send_invocation_count,
       c.metadata->'luna_email_open_draft' AS draft_meta
  FROM tenant_email_reply_approvals a
  LEFT JOIN tenant_email_outbound_send_journal j
    ON j.client_id=a.client_id AND j.approval_id=a.approval_id
  INNER JOIN conversations c
    ON c.client_id=a.client_id AND c.id=a.conversation_id
 WHERE a.client_id=$1::uuid AND a.conversation_id=$2::uuid
   AND a.source_inbound_event_id=$3::uuid
 ORDER BY a.updated_at DESC, a.approval_id DESC
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
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function sha40(value) {
  return typeof value === 'string' && SHA40.test(value) ? value : null;
}

function asInt(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return null;
  const n = ownData(row, 'n') !== undefined ? ownData(row, 'n') : row.n;
  if (Number.isSafeInteger(n)) return n;
  const parsed = Number.parseInt(n, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function refusedRecord(reason, extra) {
  const out = {
    ok: false,
    status: 'refused',
    reason: reason || 'refused',
    proof_version: PROOF_VERSION,
    invoked: 0,
    approvals: 0,
    journals: 0,
    provider_sends: 0,
    sent: false,
    restored: extra && extra.restored === true,
    live_proof_blocked: true,
  };
  if (extra && extra.public) Object.assign(out, extra.public);
  const stage = closedGraphGrantStage(extra && extra.stage);
  if (stage) out.stage = stage;
  return freeze({
    ok: false,
    reason: out.reason,
    status: 'refused',
    invoked: 0,
    public: freeze(out),
    ...(extra || {}),
  });
}

function failRecord(reason, extra) {
  const restored = extra && extra.restored === true;
  const status = extra && extra.status ? extra.status : 'failed';
  const out = {
    ok: false,
    status,
    reason: reason || 'proof_failed',
    proof_version: PROOF_VERSION,
    invoked: extra && Number.isSafeInteger(extra.invoked) ? extra.invoked : 0,
    approvals: extra && Number.isSafeInteger(extra.approvals) ? extra.approvals : 0,
    journals: extra && Number.isSafeInteger(extra.journals) ? extra.journals : 0,
    provider_sends: extra && Number.isSafeInteger(extra.provider_sends) ? extra.provider_sends : 0,
    sent: false,
    restored,
    live_proof_blocked: extra && extra.live_proof_blocked === true,
  };
  if (extra && extra.dispatch_reset_allowed === true) out.dispatch_reset_allowed = true;
  if (extra && extra.process_alive === true) out.process_alive = true;
  return freeze({
    ok: false,
    reason: out.reason,
    status,
    invoked: out.invoked,
    restored,
    public: freeze(out),
    ...(extra || {}),
  });
}

function successRecord(extra) {
  const out = {
    ok: true,
    status: 'sent',
    reason: null,
    proof_version: PROOF_VERSION,
    invoked: 1,
    approvals: 1,
    journals: 1,
    provider_sends: 1,
    sent: true,
    restored: extra && extra.restored === true,
    kill_switch: extra && extra.kill_switch === true,
    graph_threaded: extra && extra.graph_threaded === true,
    duplicate: extra && extra.duplicate === true,
    live_proof_blocked: false,
  };
  return freeze({
    ok: true,
    reason: null,
    status: 'sent',
    invoked: 1,
    restored: out.restored,
    public: freeze(out),
    ...(extra || {}),
  });
}

function redactSensitive(text, secrets) {
  let out = String(text == null ? '' : text);
  const extra = Array.isArray(secrets) ? secrets : [];
  for (const secret of extra) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.split(PROOF_SENDER).join('[redacted-email]');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted]');
  out = out.replace(UUID, '[redacted-uuid]');
  return out;
}

const PUBLIC_REDACT_KEYS = freeze([
  'conversation_id',
  'draft_text',
  'message_text',
  'sender_address',
  'client_id',
  'location_id',
  'inbound_message_id',
  'provider_mailbox_id',
  'provider_source_message_id',
  'graph_conversation_id',
  'guest_id',
  'evidence_mac',
  'accessToken',
  'access_token',
  'body',
  'bodyPreview',
  'uniqueBody',
  'durable_evidence',
  'provenance',
  'after',
  'envelope',
  'projection',
  'authority',
  'token',
  'secret',
  'hmac_secret',
  'immutable_draft_id',
  'provider_message_id',
  'internetMessageId',
  'internet_message_id',
  'graph_message_id',
]);

function stripPublicPii(pub) {
  if (!pub || typeof pub !== 'object' || isProxy(pub) || Array.isArray(pub)) return pub;
  const copy = { ...pub };
  for (const key of PUBLIC_REDACT_KEYS) delete copy[key];
  delete copy.conversation_id;
  delete copy.draft_text;
  delete copy.message_text;
  delete copy.sender_address;
  const frozen = freeze(copy);
  if (GRAPH_INNER_REPLICA_DIAG.has(pub)) GRAPH_INNER_REPLICA_DIAG.add(frozen);
  return frozen;
}

function attachPublic(result, pub) {
  if (!result || typeof result !== 'object' || isProxy(result)) return result;
  if (!pub || typeof pub !== 'object' || isProxy(pub) || Array.isArray(pub)) return result;
  return freeze({ ...result, public: stripPublicPii(pub) });
}

function killSwitchPublic(result) {
  const ok = !!(result && result.ok === true);
  const out = {
    ok,
    reason: result && result.reason
      ? String(result.reason)
      : (ok ? 'emergency_flags_off' : 'kill_switch_unproven'),
    author_called: !!(result && result.author_called === true),
    journal_called: !!(result && result.journal_called === true),
    provider_called: !!(result && result.provider_called === true),
    provider_sends: result && Number.isSafeInteger(result.provider_sends) ? result.provider_sends : 0,
  };
  if (result && typeof result.status === 'string' && result.status) out.status = result.status;
  return freeze(out);
}

function snapshotCountsPublic(counts) {
  if (!counts || typeof counts !== 'object' || isProxy(counts)) {
    return freeze({ ok: false, reason: 'counts_unavailable' });
  }
  return freeze({
    ok: true,
    approvals: Number.isSafeInteger(counts.approvals) ? counts.approvals : 0,
    journals: Number.isSafeInteger(counts.journals) ? counts.journals : 0,
    provider_sends: Number.isSafeInteger(counts.provider_sends) ? counts.provider_sends : 0,
    bookings: Number.isSafeInteger(counts.bookings) ? counts.bookings : 0,
  });
}

function snapshotPreflightPublic(result) {
  return freeze({
    ok: result && result.ok === true,
    reason: result && result.ok === true ? null : (result && result.reason ? String(result.reason) : 'snapshot_unproven'),
    approvals: Number.isSafeInteger(result && result.approvals) ? result.approvals : 0,
    journals: Number.isSafeInteger(result && result.journals) ? result.journals : 0,
    provider_sends: Number.isSafeInteger(result && result.provider_sends) ? result.provider_sends : 0,
    bookings: Number.isSafeInteger(result && result.bookings) ? result.bookings : 0,
    luna_on: result && result.luna_on === true,
    needs_human: result && result.needs_human === true,
    guest_linked: result && result.guest_linked === true,
    sender_ok: result && result.sender_ok === true,
    subject_ok: result && result.subject_ok === true,
    sol_enabled: result && result.sol_enabled === true,
    channel_mode: result && typeof result.channel_mode === 'string' ? result.channel_mode : null,
  });
}

function snapshotModePublic(result) {
  return freeze({
    ok: result && result.ok === true,
    channel_mode: result && typeof result.channel_mode === 'string' ? result.channel_mode : null,
  });
}

function evidencePublic(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) {
    return freeze({
      ok: false,
      reason: 'snapshot_unproven',
      hmac_available: false,
      evidence_verified: false,
      leftover: false,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
    });
  }
  const marker = result.marker && typeof result.marker === 'object' && !isProxy(result.marker)
    ? freeze({
      provider: result.marker.provider,
      model: result.marker.model,
      runtime: result.marker.runtime,
    })
    : undefined;
  const out = {
    ok: result.ok === true,
    hmac_available: result.hmac_available === true,
    evidence_verified: result.evidence_verified === true,
    leftover: result.leftover === true,
    approvals: Number.isSafeInteger(result.approvals) ? result.approvals : 0,
    journals: Number.isSafeInteger(result.journals) ? result.journals : 0,
    provider_sends: Number.isSafeInteger(result.provider_sends) ? result.provider_sends : 0,
  };
  if (result.ok !== true && result.reason) out.reason = String(result.reason);
  if (result.hmac_kind) out.hmac_kind = result.hmac_kind;
  if (marker) out.marker = marker;
  if (result.sol_provider) out.sol_provider = result.sol_provider;
  if (result.sol_model) out.sol_model = result.sol_model;
  if (result.sol_runtime) out.sol_runtime = result.sol_runtime;
  if (result.duplicate_unreconciled === true) out.duplicate_unreconciled = true;
  // Supervisor evidence parser needs capability/HMAC/Sol fields only — never Graph message ids.
  return freeze(out);
}

function isKillSwitchShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  if (result.status === 'blocked') return true;
  if (result.reason === 'emergency_flags_off'
      || result.reason === 'kill_switch_unproven'
      || result.reason === 'kill_switch_side_effect') {
    return true;
  }
  return typeof result.author_called === 'boolean'
    || typeof result.journal_called === 'boolean'
    || typeof result.provider_called === 'boolean';
}

function isGraphShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  if (typeof result.adapter_available === 'boolean' || typeof result.readonly === 'boolean') return true;
  if (typeof result.reason === 'string' && /^graph_/.test(result.reason)) return true;
  return Number.isSafeInteger(result.arrivals) && typeof result.threaded === 'boolean';
}

function isEvidenceShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  if (typeof result.hmac_available === 'boolean' || typeof result.evidence_verified === 'boolean') return true;
  return result.reason === 'hmac_unwired' || result.reason === 'sol_unproven';
}

function isPreflightShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  return typeof result.luna_on === 'boolean'
    || typeof result.guest_linked === 'boolean'
    || typeof result.sender_ok === 'boolean'
    || typeof result.subject_ok === 'boolean'
    || typeof result.sol_enabled === 'boolean';
}

function isCountsShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  return Number.isSafeInteger(result.approvals)
    && Number.isSafeInteger(result.journals)
    && Number.isSafeInteger(result.provider_sends)
    && Number.isSafeInteger(result.bookings);
}

function innerPublicFromResult(result) {
  if (!result || typeof result !== 'object' || isProxy(result) || Array.isArray(result)) return null;
  if (result.reason === 'proven_no_send' || result.status === 'proven_no_send') {
    return freeze({
      ok: false,
      reason: 'proven_no_send',
      status: 'proven_no_send',
      dispatch_reset_allowed: result.dispatch_reset_allowed === true,
      process_alive: result.process_alive === true,
      invoked: Number.isSafeInteger(result.invoked) ? result.invoked : 0,
      approvals: Number.isSafeInteger(result.approvals) ? result.approvals : 0,
      journals: Number.isSafeInteger(result.journals) ? result.journals : 0,
      provider_sends: Number.isSafeInteger(result.provider_sends) ? result.provider_sends : 0,
      sent: false,
    });
  }
  if (result.reason === 'dispatch_in_flight' || result.status === 'dispatch_in_flight') {
    return freeze({
      ok: false,
      reason: 'dispatch_in_flight',
      process_alive: true,
      invoked: 0,
      sent: false,
    });
  }
  if (isKillSwitchShape(result)) return killSwitchPublic(result);
  if (isGraphShape(result)) return sanitizeGraphPublic(result);
  if (isEvidenceShape(result)) return evidencePublic(result);
  if (isPreflightShape(result)) return snapshotPreflightPublic(result);
  if (typeof result.dispatch_status === 'string' || result.snapshot === 'reconcile') {
    return snapshotReconcilePublic(result);
  }
  if (result.channel_mode && !Number.isSafeInteger(result.approvals)) return snapshotModePublic(result);
  if (isCountsShape(result)) return snapshotCountsPublic(result);
  if (result.reason === 'reconcile_owner_state') {
    return freeze({
      ok: false,
      reason: 'reconcile_owner_state',
      reconcile: true,
      approvals: Number.isSafeInteger(result.approvals) ? result.approvals : 0,
      journals: Number.isSafeInteger(result.journals) ? result.journals : 0,
      provider_sends: Number.isSafeInteger(result.provider_sends) ? result.provider_sends : 0,
    });
  }
  if (result.status === 'skipped' && result.reason === 'already_sent') {
    return freeze({
      ok: true,
      status: 'skipped',
      reason: 'already_sent',
      invoked: Number.isSafeInteger(result.invoked) ? result.invoked : 0,
      duplicate: true,
      approvals: Number.isSafeInteger(result.approvals) ? result.approvals : 1,
      journals: Number.isSafeInteger(result.journals) ? result.journals : 1,
      provider_sends: Number.isSafeInteger(result.provider_sends) ? result.provider_sends : 1,
    });
  }
  return null;
}

function withInnerPublic(result) {
  if (result && result.public && typeof result.public === 'object' && !isProxy(result.public)) {
    return result;
  }
  const pub = innerPublicFromResult(result);
  if (!pub) return result;
  return attachPublic(result, pub);
}

function publicProofOutput(result) {
  if (result && result.public && typeof result.public === 'object' && !isProxy(result.public)) {
    return stripPublicPii(result.public);
  }
  const inner = innerPublicFromResult(result);
  if (inner) return inner;
  if (!result || result.ok !== true) {
    return freeze({
      ok: false,
      reason: result && result.reason ? String(result.reason) : 'proof_failed',
      live_proof_blocked: true,
    });
  }
  // Never impersonate a Microsoft send. Outer execute always sets `.public`.
  return freeze({
    ok: true,
    status: result.status === 'sent' ? 'ok' : (typeof result.status === 'string' && result.status ? result.status : 'ok'),
    reason: result.reason == null ? null : String(result.reason),
  });
}

function normalizeProofSubject(value) {
  if (typeof value !== 'string') return null;
  let subject = value.replace(/\s+/g, ' ').trim();
  let previous = null;
  while (subject && subject !== previous) {
    previous = subject;
    subject = subject.replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
  }
  return subject || null;
}

function isProofSubject(value) {
  return normalizeProofSubject(value) === PROOF_SUBJECT;
}

function isAuthoritativeSender(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return false;
  const address = normalizeInboundEmailAddress(
    ownData(row, 'sender_address') || row.sender_address,
  );
  return address === PROOF_SENDER;
}

function isLeftoverGenericDraft(text) {
  if (typeof text !== 'string' || !text.trim()) return true;
  if (!LEFTOVER_FOLLOWUP.test(text)) return false;
  return !THREAD_TOPIC.test(text);
}

function validOperatorNonce(value) {
  return typeof value === 'string' && OPERATOR_NONCE_RE.test(value);
}

function validConfirmIssuedAt(value, nowMs) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  if (ms > now + CONFIRM_FUTURE_SKEW_MS) return false;
  if (now - ms > CONFIRM_WINDOW_MS) return false;
  return true;
}

function refusedProduction(env) {
  const deployment = ownData(env, 'LUNA_DEPLOYMENT');
  const tenant = ownData(env, 'DEFAULT_CLIENT_SLUG');
  if (typeof deployment === 'string' && PRODUCTION_MARKERS.includes(deployment.toLowerCase())) {
    return true;
  }
  if (typeof tenant === 'string' && PRODUCTION_MARKERS.includes(tenant.toLowerCase())) {
    return true;
  }
  return false;
}

function proxyPresent(env) {
  if (!env || typeof env !== 'object' || isProxy(env)) return true;
  for (const key of PROXY_ENV_KEYS) {
    const value = ownData(env, key);
    if (typeof value === 'string' && value.length > 0) return true;
  }
  return false;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const seen = Object.create(null);
  const flags = Object.create(null);
  flags.command = null;
  flags.deployment = null;
  flags.tenant = null;
  flags.database = null;
  flags.resourceGroup = null;
  flags.appName = null;
  flags.revision = null;
  flags.deploySha = null;
  flags.imageTag = null;
  flags.digest = null;
  flags.confirm = null;
  flags.operatorNonce = null;
  flags.confirmIssuedAt = null;
  flags.invalid = false;
  flags.invalidReason = null;
  function markSeen(name) {
    if (seen[name] === true) {
      flags.invalid = true;
      flags.invalidReason = 'duplicate_arg';
      return false;
    }
    seen[name] = true;
    return true;
  }
  function takeValue(name, i) {
    const value = args[i + 1];
    if (typeof value !== 'string' || value.length < 1 || value.startsWith('--')) {
      flags.invalid = true;
      flags.invalidReason = 'missing_arg_value';
      return i;
    }
    if (!markSeen(name)) return i + 1;
    flags[name] = value;
    return i + 1;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
      continue;
    }
    if (arg.includes('=')) {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'equals_form_refused';
      continue;
    }
    if (arg === '--target' || arg === '--conversation-id' || arg === '--execute-once') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'target_refused';
      continue;
    }
    if (arg === COMMAND) {
      if (!markSeen('command')) continue;
      flags.command = COMMAND;
    } else if (arg === PREFLIGHT_COMMAND) {
      if (!markSeen('command')) continue;
      flags.command = PREFLIGHT_COMMAND;
    } else if (arg === '--deployment') {
      i = takeValue('deployment', i);
    } else if (arg === '--tenant') {
      i = takeValue('tenant', i);
    } else if (arg === '--database') {
      i = takeValue('database', i);
    } else if (arg === '--resource-group') {
      i = takeValue('resourceGroup', i);
    } else if (arg === '--app') {
      i = takeValue('appName', i);
    } else if (arg === '--revision') {
      i = takeValue('revision', i);
    } else if (arg === '--deploy-sha') {
      i = takeValue('deploySha', i);
    } else if (arg === '--image-tag') {
      i = takeValue('imageTag', i);
    } else if (arg === '--digest') {
      i = takeValue('digest', i);
    } else if (arg === '--confirm') {
      i = takeValue('confirm', i);
    } else if (arg === '--operator-nonce') {
      i = takeValue('operatorNonce', i);
    } else if (arg === '--confirm-issued-at') {
      i = takeValue('confirmIssuedAt', i);
    } else {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
    }
  }
  if (flags.command !== COMMAND && flags.command !== PREFLIGHT_COMMAND && flags.invalid !== true) {
    flags.invalid = true;
    flags.invalidReason = args.length === 0 ? 'default_refuse' : 'unknown_or_hostile_arg';
  }
  return freeze({
    command: flags.command,
    deployment: flags.deployment,
    tenant: flags.tenant,
    database: flags.database,
    resourceGroup: flags.resourceGroup,
    appName: flags.appName,
    revision: flags.revision,
    deploySha: flags.deploySha,
    imageTag: flags.imageTag || flags.deploySha,
    digest: flags.digest,
    confirm: flags.confirm,
    operatorNonce: flags.operatorNonce,
    confirmIssuedAt: flags.confirmIssuedAt,
    invalid: flags.invalid === true,
    invalidReason: flags.invalidReason,
  });
}

function validatePinnedTarget(parsed) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.deployment !== SUNSET_DEPLOYMENT) return 'deployment_mismatch';
  if (parsed.tenant !== SUNSET_TENANT) return 'tenant_mismatch';
  if (parsed.database !== EXPECTED_DATABASE) return 'database_mismatch';
  if (parsed.resourceGroup !== RG) return 'wrong_target';
  if (parsed.appName !== STAFF_APP) return 'wrong_target';
  if (typeof parsed.revision !== 'string' || !SAFE_AZ_NAME.test(parsed.revision)
      || !parsed.revision.startsWith(STAFF_APP)) {
    return 'revision_mismatch';
  }
  const imageTag = sha40(parsed.imageTag) || sha40(parsed.deploySha);
  if (!imageTag) return 'exact_master_image_required';
  if (parsed.digest && !DIGEST_RE.test(parsed.digest)) return 'digest_mismatch';
  return null;
}

function validatePreflightInvocation(parsed) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.command !== PREFLIGHT_COMMAND) return 'unknown_or_hostile_arg';
  return validatePinnedTarget(parsed);
}

function validateExactInvocation(parsed, nowMs, nonceStore) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.command !== COMMAND) return parsed.command ? 'unknown_or_hostile_arg' : 'default_refuse';
  const pins = validatePinnedTarget(parsed);
  if (pins) return pins;
  if (parsed.confirm !== CONFIRMATION_PHRASE) return 'confirmation_required';
  if (!validOperatorNonce(parsed.operatorNonce)) return 'operator_nonce_invalid';
  if (!validConfirmIssuedAt(parsed.confirmIssuedAt, nowMs)) return 'confirm_window_invalid';
  const store = nonceStore || USED_OPERATOR_NONCES;
  if (store.has(parsed.operatorNonce)) return 'operator_nonce_replay';
  return null;
}

function evaluateLiveProofReadiness(input) {
  const serving = input && input.serving;
  const masterSha = sha40(input && input.originMasterSha);
  const headSha = sha40(input && input.headSha);
  const imageTag = sha40(serving && (serving.imageTag || serving.deploySha));
  const blocked = [];
  const artifactsOnMaster = input && input.artifactsOnMaster === true;
  const artifactsInImage = input && input.artifactsInImage === true;
  if (headSha && masterSha && headSha !== masterSha) blocked.push('head_not_origin_master');
  if (artifactsOnMaster !== true && artifactsInImage !== true) {
    blocked.push('proof_files_not_on_master');
  }
  if (!imageTag || !masterSha || imageTag !== masterSha) blocked.push('exact_master_image_required');
  if (serving && serving.imageRepository && serving.imageRepository !== IMAGE_REPOSITORY) {
    blocked.push('wrong_image_repository');
  }
  if (input && input.copiedScript === true) blocked.push('copied_script_is_not_proof');
  return freeze({
    ok: blocked.length === 0,
    can_proceed: blocked.length === 0,
    blocked_reasons: freeze(blocked),
    requirement: LIVE_IMAGE_REQUIREMENT,
    copied_script_boolean_trusted: false,
  });
}

function snapshotSolMarker(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) return null;
  const provider = ownData(value, 'provider') || value.provider;
  const model = ownData(value, 'model') || value.model;
  const runtime = ownData(value, 'runtime') || value.runtime;
  if (provider !== 'openai-codex' || model !== 'gpt-5.6-sol' || runtime !== 'sunset-email-luna') {
    return null;
  }
  return freeze({
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    runtime: 'sunset-email-luna',
  });
}

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object' && !isProxy(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !isProxy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function snapshotTrustedProvenance(source, expected, secret, messageText) {
  if (!source || typeof source !== 'object' || isProxy(source)) return null;
  if (source.hmac_verified === true && !source.evidence_mac
      && !(source.selected_operation_evidence && source.selected_operation_evidence.evidence_mac)) {
    return null;
  }
  const envelope = sanitizeSelectedOperationEvidence(
    ownData(source, 'selected_operation_evidence') || source.selected_operation_evidence || source,
  );
  if (!envelope) return null;
  const verified = verifySelectedOperationSolEvidence(
    envelope,
    expected,
    secret,
    messageText,
  );
  if (!verified) return null;
  return freeze({
    marker: verified.marker,
    request_id: verified.request_id,
    hmac_kind: verified.hmac_kind,
    evidence_mac: verified.evidence_mac,
    body_sha256: verified.body_sha256,
    alg: 'HMAC-SHA256',
    trusted: true,
  });
}

function provenanceFromDurableDraftMeta(draftMeta, expected, secret, messageText) {
  const meta = parseJsonMaybe(draftMeta);
  if (!meta) return null;
  const block = ownData(meta, 'luna_email_open_draft') || meta.luna_email_open_draft || meta;
  const envelope = (block && (ownData(block, 'selected_operation_evidence')
    || block.selected_operation_evidence)) || block;
  return snapshotTrustedProvenance(envelope, expected, secret, messageText);
}

function isProduction003SentShape(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return false;
  return result.status === 'sent'
    && result.sent === true
    && result.approvals === 1
    && result.journals === 1
    && result.provider_sends === 1;
}

function leftoverFromDurableEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || isProxy(evidence)) return true;
  const text = ownData(evidence, 'message_text') || evidence.message_text;
  return isLeftoverGenericDraft(text);
}

function replicaLeftover(evidence) {
  if (!evidence || typeof evidence !== 'object' || isProxy(evidence)) return true;
  if (evidence.leftover === true) return true;
  if (evidence.leftover === false) return false;
  if (typeof (ownData(evidence, 'message_text') || evidence.message_text) === 'string') {
    return leftoverFromDurableEvidence(evidence);
  }
  return true;
}

function replicaSolProven(evidence) {
  if (!evidence || typeof evidence !== 'object' || isProxy(evidence)) return false;
  if (evidence.evidence_verified !== true) return false;
  return !!snapshotSolMarker(evidence.marker || evidence);
}

function replicaEvidenceCapabilityAvailable(evidence) {
  if (!evidence || typeof evidence !== 'object' || isProxy(evidence)) return false;
  return evidence.hmac_available === true;
}

function replicaGraphAdapterAvailable(probe) {
  if (!probe || typeof probe !== 'object' || isProxy(probe)) return false;
  return probe.adapter_available === true && probe.readonly === true;
}

function headerCites(headerValue, cited) {
  if (typeof headerValue !== 'string' || typeof cited !== 'string' || !cited) return false;
  if (headerValue === cited) return true;
  const parts = headerValue.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.includes(cited);
}

function closedGraphGrantStage(stage) {
  try {
    if (typeof stage !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(GRAPH_GRANT_STAGE_REASON, stage)) return null;
    return stage;
  } catch {
    return null;
  }
}

function closedGraphGrantStatus(status) {
  try {
    if (typeof status !== 'string' || !GRAPH_GRANT_STATUS_SET.has(status)) return null;
    return status;
  } catch {
    return null;
  }
}

function classifyTrustedGraphGrantFailure(input) {
  const target = input && input.target;
  const result = input && input.result;
  const branded = readTrustedDelegatedGrantAccessSessionInternalStage(target)
    || readTrustedDelegatedGrantAccessSessionInternalStage(result);
  const stage = closedGraphGrantStage((branded && branded.stage) || (input && input.observedStage));
  if (!stage) {
    return freeze({
      ok: false,
      reason: 'graph_adapter_unwired',
      adapter_available: false,
      readonly: false,
    });
  }
  const out = {
    ok: false,
    reason: GRAPH_GRANT_STAGE_REASON[stage],
    adapter_available: false,
    readonly: false,
    stage,
  };
  const status = closedGraphGrantStatus(result && result.status);
  if (status) out.status = status;
  return freeze(out);
}

function closedGraphPublicReason(reason) {
  if (typeof reason !== 'string' || !reason) return null;
  if (
    reason === 'graph_adapter_unwired'
    || reason === 'graph_unproven'
    || reason === 'graph_auth_unproven'
    || reason === 'graph_send_forbidden'
    || reason === 'graph_body_leaked'
    || reason === 'graph_pii_leaked'
  ) {
    return reason;
  }
  for (const stage of Object.keys(GRAPH_GRANT_STAGE_REASON)) {
    if (GRAPH_GRANT_STAGE_REASON[stage] === reason) return reason;
  }
  return null;
}

function closedGraphReplicaBits(bits) {
  return freeze({
    token_present: !!(bits && bits.token_present === true),
    https_present: !!(bits && bits.https_present === true),
    request_built: !!(bits && bits.request_built === true),
  });
}

function brandGraphInnerReplicaPublic(pub) {
  if (!pub || typeof pub !== 'object' || isProxy(pub)) return pub;
  GRAPH_INNER_REPLICA_DIAG.add(pub);
  return pub;
}

function readBrandedGraphInnerReplicaBits(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) return null;
  if (!GRAPH_INNER_REPLICA_DIAG.has(result)) return null;
  return closedGraphReplicaBits(result);
}

function attachBrandedGraphReplicaBits(pub, bits) {
  if (!pub || typeof pub !== 'object' || isProxy(pub)) return pub;
  if (!bits) return pub;
  const branded = freeze({
    ...pub,
    token_present: bits.token_present === true,
    https_present: bits.https_present === true,
    request_built: bits.request_built === true,
  });
  return brandGraphInnerReplicaPublic(branded);
}

function sanitizeGraphPublic(result) {
  if (!result || typeof result !== 'object' || isProxy(result)) {
    return freeze({
      ok: false,
      reason: 'graph_adapter_unwired',
      adapter_available: false,
      readonly: false,
      arrivals: 0,
      duplicates: 0,
      threaded: false,
      subject_ok: false,
    });
  }
  const arrivals = Number.isSafeInteger(result.arrivals) ? result.arrivals : 0;
  const duplicates = Number.isSafeInteger(result.duplicates) ? result.duplicates : 0;
  const ok = result.ok === true;
  const stage = closedGraphGrantStage(result.stage);
  let reason = null;
  if (ok !== true) {
    const closed = closedGraphPublicReason(result.reason || 'graph_unproven');
    if (closed) reason = closed;
    else if (stage) reason = GRAPH_GRANT_STAGE_REASON[stage];
    else reason = 'graph_adapter_unwired';
  }
  const pub = {
    ok,
    reason,
    adapter_available: result.adapter_available === true,
    readonly: result.readonly === true,
    arrivals,
    duplicates,
    threaded: result.threaded === true,
    subject_ok: result.subject_ok === true,
  };
  if (ok !== true) {
    if (stage && GRAPH_GRANT_STAGE_REASON[stage] === pub.reason) pub.stage = stage;
    const grantStatus = closedGraphGrantStatus(result.status);
    if (grantStatus && pub.stage) pub.status = grantStatus;
  }
  const replicaBits = readBrandedGraphInnerReplicaBits(result);
  if (replicaBits) return attachBrandedGraphReplicaBits(freeze(pub), replicaBits);
  return freeze(pub);
}

function graphInnerResult(result, replicaBits) {
  const pub = sanitizeGraphPublic(result);
  if (!replicaBits) return attachPublic(pub, pub);
  const branded = attachBrandedGraphReplicaBits(pub, closedGraphReplicaBits(replicaBits));
  const attached = attachPublic(branded, branded);
  if (attached && attached.public) brandGraphInnerReplicaPublic(attached.public);
  brandGraphInnerReplicaPublic(attached);
  return attached;
}

function graphUnwiredPublic() {
  return sanitizeGraphPublic({
    ok: false,
    reason: 'graph_adapter_unwired',
    adapter_available: false,
    readonly: false,
  });
}

function ownExactBoolean(value, key) {
  const owned = ownData(value, key);
  if (owned === true) return true;
  if (owned === false) return false;
  return null;
}

function ownExactNonNegativeInt(value, key) {
  const owned = ownData(value, key);
  if (!Number.isSafeInteger(owned) || owned < 0) return null;
  return owned;
}

function closedGraphInnerDto(value) {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return null;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (!Array.isArray(keys) || keys.length < 8 || keys.length > GRAPH_INNER_DTO_KEYS.length) return null;
  for (const key of keys) {
    if (typeof key !== 'string' || !GRAPH_INNER_DTO_KEY_SET.has(key)) return null;
  }
  const ok = ownExactBoolean(value, 'ok');
  if (ok === null) return null;
  const adapterAvailable = ownExactBoolean(value, 'adapter_available');
  const readonly = ownExactBoolean(value, 'readonly');
  const threaded = ownExactBoolean(value, 'threaded');
  const subjectOk = ownExactBoolean(value, 'subject_ok');
  const arrivals = ownExactNonNegativeInt(value, 'arrivals');
  const duplicates = ownExactNonNegativeInt(value, 'duplicates');
  if (adapterAvailable === null || readonly === null || threaded === null || subjectOk === null) {
    return null;
  }
  if (arrivals === null || duplicates === null) return null;

  const hasReason = Object.prototype.hasOwnProperty.call(value, 'reason');
  let reason = null;
  if (ok === true) {
    if (hasReason && ownData(value, 'reason') != null) return null;
    if (adapterAvailable !== true || readonly !== true) return null;
  } else {
    if (!hasReason) return null;
    reason = closedGraphPublicReason(ownData(value, 'reason'));
    if (!reason) return null;
  }
  if (GRAPH_INNER_ADAPTER_REASONS.includes(reason)) {
    if (adapterAvailable !== true || readonly !== true) return null;
  }
  if (reason === 'graph_adapter_unwired' && (adapterAvailable !== false || readonly !== false)) {
    return null;
  }

  const hasToken = Object.prototype.hasOwnProperty.call(value, 'token_present');
  const hasHttps = Object.prototype.hasOwnProperty.call(value, 'https_present');
  const hasRequest = Object.prototype.hasOwnProperty.call(value, 'request_built');
  if (hasToken !== hasHttps || hasHttps !== hasRequest) return null;
  let replicaBits;
  if (hasToken) {
    const tokenPresent = ownExactBoolean(value, 'token_present');
    const httpsPresent = ownExactBoolean(value, 'https_present');
    const requestBuilt = ownExactBoolean(value, 'request_built');
    if (tokenPresent === null || httpsPresent === null || requestBuilt === null) return null;
    replicaBits = {
      token_present: tokenPresent === true,
      https_present: httpsPresent === true,
      request_built: requestBuilt === true,
    };
  }

  const hasStage = Object.prototype.hasOwnProperty.call(value, 'stage');
  const hasStatus = Object.prototype.hasOwnProperty.call(value, 'status');
  const stage = hasStage ? closedGraphGrantStage(ownData(value, 'stage')) : null;
  if (hasStage && !stage) return null;
  const grantStatus = hasStatus ? closedGraphGrantStatus(ownData(value, 'status')) : null;
  if (hasStatus && !grantStatus) return null;
  if (grantStatus && !stage) return null;

  const fields = {
    ok,
    reason,
    adapter_available: adapterAvailable === true,
    readonly: readonly === true,
    arrivals,
    duplicates,
    threaded: threaded === true,
    subject_ok: subjectOk === true,
  };
  if (stage) fields.stage = stage;
  if (grantStatus) fields.status = grantStatus;
  return freeze({ fields: freeze(fields), replicaBits: replicaBits ? freeze(replicaBits) : undefined });
}

function graphInnerExecStdoutOk(pub) {
  const closed = closedGraphInnerDto(pub);
  if (!closed || !closed.fields) return false;
  return closed.fields.reason !== 'graph_adapter_unwired';
}

function sanitizeReplicaEvidenceSnapshot(loaded, secret) {
  if (typeof secret !== 'string' || !secret || secret.trim() !== secret) {
    return freeze({
      ok: false,
      reason: 'hmac_unwired',
      hmac_available: false,
      evidence_verified: false,
      leftover: false,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
    });
  }
  if (!loaded || typeof loaded !== 'object' || isProxy(loaded)) {
    return freeze({
      ok: false,
      reason: 'snapshot_unproven',
      hmac_available: true,
      evidence_verified: false,
      leftover: false,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
    });
  }
  const approvals = Number.isSafeInteger(loaded.approvals) ? loaded.approvals : (
    loaded.message_text ? 1 : 0
  );
  const journals = Number.isSafeInteger(loaded.journals) ? loaded.journals : (
    loaded.immutable_draft_id ? 1 : 0
  );
  const sends = Number.isSafeInteger(loaded.provider_sends)
    ? loaded.provider_sends
    : (Number.isSafeInteger(loaded.send_invocation_count) ? loaded.send_invocation_count : 0);
  if (!loaded.message_text && (approvals === 0 || loaded.duplicate_unreconciled === true)) {
    return freeze({
      ok: true,
      hmac_available: true,
      evidence_verified: false,
      leftover: false,
      approvals,
      journals: Number.isSafeInteger(journals) ? journals : 0,
      provider_sends: sends,
      duplicate_unreconciled: loaded.duplicate_unreconciled === true,
    });
  }
  const expected = freeze({
    client_id: loaded.client_id,
    location_id: loaded.location_id,
    conversation_id: loaded.conversation_id,
    source_inbound_event_id: loaded.source_inbound_event_id,
  });
  const provenance = snapshotTrustedProvenance(
    loaded.draft_meta || loaded.provenance,
    expected,
    secret,
    loaded.message_text,
  );
  const leftover = leftoverFromDurableEvidence(loaded) === true;
  if (!provenance || !snapshotSolMarker(provenance.marker || provenance)) {
    return freeze({
      ok: false,
      reason: 'sol_unproven',
      hmac_available: true,
      evidence_verified: false,
      leftover,
      approvals,
      journals: Number.isSafeInteger(journals) ? journals : 0,
      provider_sends: sends,
    });
  }
  const marker = snapshotSolMarker(provenance.marker || provenance);
  return freeze({
    ok: true,
    hmac_available: true,
    evidence_verified: true,
    leftover,
    hmac_kind: provenance.hmac_kind,
    marker,
    sol_provider: marker.provider,
    sol_model: marker.model,
    sol_runtime: marker.runtime,
    approvals,
    journals: Number.isSafeInteger(journals) ? journals : 0,
    provider_sends: sends,
  });
}

function exactReconciledCounts(snapshot) {
  return !!(snapshot
    && snapshot.approvals === 1
    && snapshot.journals === 1
    && snapshot.provider_sends === 1);
}

function duplicateUnreconciled(snapshot) {
  if (!snapshot) return true;
  if (exactReconciledCounts(snapshot)) return false;
  const a = snapshot.approvals;
  const j = snapshot.journals;
  const p = snapshot.provider_sends;
  if (a === 0 && j === 0 && p === 0) return false;
  return true;
}

function wrapNonceStore(store) {
  if (store && typeof store.has === 'function' && typeof store.add === 'function'
      && store.add.length >= 0 && store._durable === true) {
    return store;
  }
  const set = store instanceof Set ? store : new Set();
  return {
    has(nonce) { return set.has(nonce); },
    add(nonce) {
      if (set.has(nonce)) return false;
      set.add(nonce);
      return true;
    },
  };
}

function createDurableNonceStore(filePath) {
  const target = typeof filePath === 'string' && filePath
    ? filePath
    : DEFAULT_NONCE_STORE_PATH;
  function readMap() {
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !isProxy(parsed)
        ? parsed
        : Object.create(null);
    } catch {
      return Object.create(null);
    }
  }
  function writeMap(map) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const store = {
    _durable: true,
    path: target,
    has(nonce) {
      if (!validOperatorNonce(nonce)) return false;
      const map = readMap();
      return hasOwn(map, nonce);
    },
    add(nonce, binding) {
      if (!validOperatorNonce(nonce)) return false;
      const map = readMap();
      if (hasOwn(map, nonce)) return false;
      map[nonce] = freeze({
        operation_binding: typeof binding === 'string' && binding ? binding : OPERATION_BINDING,
        consumed_at: new Date().toISOString(),
      });
      writeMap(map);
      return true;
    },
  };
  return freeze(store);
}

function capabilityMacKey(imageTag, digest) {
  return crypto.createHash('sha256')
    .update(`mail-mvp-004:${CONFIRMATION_PHRASE}:${imageTag || ''}:${digest || ''}`)
    .digest();
}

function canonicalCapabilityPayload(payload) {
  return JSON.stringify({
    purpose: payload.purpose,
    nonce: payload.nonce,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    revision: payload.revision,
    replica: payload.replica || null,
    image_tag: payload.image_tag,
    digest: payload.digest,
    operation_binding: payload.operation_binding,
  });
}

function issueSupervisorCapability(input, nowMs) {
  const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  const imageTag = sha40(input && input.imageTag);
  const digest = input && typeof input.digest === 'string' && DIGEST_RE.test(input.digest)
    ? input.digest : null;
  const revision = input && typeof input.revision === 'string' ? input.revision : null;
  const nonce = input && input.nonce;
  if (!imageTag || !digest || !revision || !validOperatorNonce(nonce)) return null;
  if (!SAFE_AZ_NAME.test(revision) || !revision.startsWith(STAFF_APP)) return null;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CONFIRM_WINDOW_MS).toISOString();
  const payload = {
    purpose: CAPABILITY_PURPOSE,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
    revision,
    replica: input.replica && SAFE_AZ_NAME.test(input.replica) ? input.replica : null,
    image_tag: imageTag,
    digest,
    operation_binding: OPERATION_BINDING,
  };
  const mac = crypto.createHmac('sha256', capabilityMacKey(imageTag, digest))
    .update(canonicalCapabilityPayload(payload))
    .digest('hex');
  return freeze({ ...payload, mac });
}

function encodeCapability(capability) {
  if (!capability || typeof capability.mac !== 'string') return null;
  const b64 = Buffer.from(JSON.stringify(capability), 'utf8').toString('base64');
  return SAFE_B64.test(b64) ? b64 : null;
}

function decodeCapability(raw) {
  if (typeof raw !== 'string' || !SAFE_B64.test(raw)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !isProxy(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function verifySupervisorCapability(raw, nowMs, expected) {
  const cap = typeof raw === 'string' ? decodeCapability(raw) : raw;
  if (!cap || typeof cap !== 'object' || isProxy(cap)) return freeze({ ok: false, reason: 'capability_required' });
  const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
  if (cap.purpose !== CAPABILITY_PURPOSE) return freeze({ ok: false, reason: 'capability_invalid' });
  if (!validOperatorNonce(cap.nonce)) return freeze({ ok: false, reason: 'capability_invalid' });
  if (cap.operation_binding !== OPERATION_BINDING) return freeze({ ok: false, reason: 'capability_invalid' });
  const imageTag = sha40(cap.image_tag);
  const digest = typeof cap.digest === 'string' && DIGEST_RE.test(cap.digest) ? cap.digest : null;
  if (!imageTag || !digest || typeof cap.mac !== 'string' || !/^[0-9a-f]{64}$/.test(cap.mac)) {
    return freeze({ ok: false, reason: 'capability_invalid' });
  }
  const expectedMac = crypto.createHmac('sha256', capabilityMacKey(imageTag, digest))
    .update(canonicalCapabilityPayload(cap))
    .digest('hex');
  try {
    if (expectedMac.length !== cap.mac.length
        || !crypto.timingSafeEqual(Buffer.from(expectedMac, 'hex'), Buffer.from(cap.mac, 'hex'))) {
      return freeze({ ok: false, reason: 'capability_invalid' });
    }
  } catch {
    return freeze({ ok: false, reason: 'capability_invalid' });
  }
  const issuedMs = Date.parse(cap.issued_at);
  const expiresMs = Date.parse(cap.expires_at);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)) {
    return freeze({ ok: false, reason: 'capability_invalid' });
  }
  if (expiresMs <= now) return freeze({ ok: false, reason: 'capability_expired' });
  if (expected) {
    if (expected.revision && cap.revision !== expected.revision) {
      return freeze({ ok: false, reason: 'capability_revision_mismatch' });
    }
    if (expected.imageTag && cap.image_tag !== expected.imageTag) {
      return freeze({ ok: false, reason: 'capability_invalid' });
    }
    if (expected.digest && cap.digest !== expected.digest) {
      return freeze({ ok: false, reason: 'capability_invalid' });
    }
  }
  return freeze({ ok: true, capability: freeze({ ...cap }) });
}

function consumeInnerCapability(nonce, filePath) {
  if (!validOperatorNonce(nonce)) return false;
  const target = filePath || INNER_CONSUMED_CAPABILITY_PATH;
  let map = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed;
  } catch { /* first use */ }
  if (hasOwn(map, nonce)) return false;
  map[nonce] = { consumed_at: new Date().toISOString() };
  try {
    fs.writeFileSync(target, `${JSON.stringify(map)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function dispatchProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ignoreRemoteExecHangup() {
  const ignore = () => {};
  try { process.on('SIGHUP', ignore); } catch { /* unavailable */ }
  try { process.on('SIGPIPE', ignore); } catch { /* unavailable */ }
  return true;
}

function readDispatchReceipt(filePath) {
  const target = typeof filePath === 'string' && filePath ? filePath : INNER_DISPATCH_RECEIPT_PATH;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed) || Array.isArray(parsed)) return null;
  if (ownData(parsed, 'operation_binding') !== OPERATION_BINDING) return null;
  const status = ownData(parsed, 'status');
  if (status !== 'issued' && status !== 'completed' && status !== 'failed' && status !== 'replaced') {
    return null;
  }
  const nonce = ownData(parsed, 'nonce');
  if (nonce != null && !validOperatorNonce(nonce)) return null;
  const pid = ownData(parsed, 'pid');
  return freeze({
    status,
    nonce: nonce || null,
    previous_nonce: validOperatorNonce(ownData(parsed, 'previous_nonce'))
      ? ownData(parsed, 'previous_nonce') : null,
    pid: Number.isSafeInteger(pid) ? pid : null,
    owner_status: ownData(parsed, 'owner_status') || null,
    reason: ownData(parsed, 'reason') || null,
    operation_binding: OPERATION_BINDING,
    issued_at: ownData(parsed, 'issued_at') || null,
    completed_at: ownData(parsed, 'completed_at') || null,
    process_alive: dispatchProcessAlive(Number.isSafeInteger(pid) ? pid : 0),
  });
}

function writeDispatchReceipt(record, filePath) {
  if (!record || typeof record !== 'object' || isProxy(record)) return null;
  const status = record.status;
  if (status !== 'issued' && status !== 'completed' && status !== 'failed' && status !== 'replaced') {
    return null;
  }
  const nonce = record.nonce == null ? null : record.nonce;
  if (nonce != null && !validOperatorNonce(nonce)) return null;
  const payload = freeze({
    operation_binding: OPERATION_BINDING,
    status,
    nonce,
    previous_nonce: validOperatorNonce(record.previous_nonce) ? record.previous_nonce : null,
    pid: Number.isSafeInteger(record.pid) ? record.pid : null,
    owner_status: record.owner_status || null,
    reason: record.reason || null,
    issued_at: record.issued_at || new Date().toISOString(),
    completed_at: record.completed_at || (status === 'issued' || status === 'replaced' ? null : new Date().toISOString()),
  });
  const target = typeof filePath === 'string' && filePath ? filePath : INNER_DISPATCH_RECEIPT_PATH;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
    return payload;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return null;
  }
}

function replaceProvenNoSendDispatchMarker(input) {
  const filePath = input && input.filePath;
  const counts = input && input.counts;
  if (counts && typeof counts === 'object' && !isProxy(counts)) {
    const approvals = Number.isSafeInteger(counts.approvals) ? counts.approvals : 0;
    const journals = Number.isSafeInteger(counts.journals) ? counts.journals : 0;
    const sends = Number.isSafeInteger(counts.provider_sends) ? counts.provider_sends : 0;
    if (approvals > 0 || journals > 0 || sends > 0) {
      return freeze({ ok: false, reason: 'operation_not_new' });
    }
  }
  const receipt = readDispatchReceipt(filePath);
  if (!receipt) return freeze({ ok: true, replaced: false, process_alive: false });
  if (receipt.process_alive === true) {
    return freeze({ ok: false, reason: 'dispatch_in_flight', process_alive: true });
  }
  if (receipt.status === 'completed' && receipt.owner_status === 'sent') {
    return freeze({ ok: false, reason: 'already_sent' });
  }
  const written = writeDispatchReceipt({
    status: 'replaced',
    nonce: null,
    previous_nonce: receipt.nonce,
    pid: null,
    reason: 'proven_no_send',
    issued_at: receipt.issued_at,
  }, filePath);
  if (!written) return freeze({ ok: false, reason: 'dispatch_receipt_unproven' });
  return freeze({ ok: true, replaced: true, process_alive: false, receipt: written });
}

function classifyReconcileSnapshot(inner, extra) {
  const marked = extra && extra.marked === true;
  if (!inner || typeof inner !== 'object' || isProxy(inner) || inner.ok !== true) {
    return freeze({
      status: 'failed',
      indeterminate: true,
      reason: 'indeterminate_no_retry',
      process_alive: !!(inner && inner.process_alive === true),
      retry: false,
    });
  }
  if (inner.process_alive === true) {
    return freeze({
      status: 'failed',
      indeterminate: true,
      reason: 'indeterminate_no_retry',
      process_alive: true,
      retry: false,
    });
  }
  const approvals = inner.approvals;
  const journals = inner.journals;
  const sends = inner.provider_sends;
  if (!Number.isSafeInteger(approvals) || !Number.isSafeInteger(journals) || !Number.isSafeInteger(sends)) {
    return freeze({
      status: 'failed',
      indeterminate: true,
      reason: 'indeterminate_no_retry',
      retry: false,
    });
  }
  if (exactReconciledCounts(inner)) {
    return freeze({
      status: 'skipped',
      reason: 'already_sent',
      retry: false,
      approvals: 1,
      journals: 1,
      provider_sends: 1,
    });
  }
  if (approvals === 0 && journals === 0 && sends === 0) {
    const dispatchStatus = typeof inner.dispatch_status === 'string' ? inner.dispatch_status : null;
    if (marked === true && !dispatchStatus) {
      return freeze({
        status: 'failed',
        indeterminate: true,
        reason: 'indeterminate_no_retry',
        retry: false,
        approvals: 0,
        journals: 0,
        provider_sends: 0,
      });
    }
    return freeze({
      status: 'proven_no_send',
      reason: 'proven_no_send',
      dispatch_reset_allowed: true,
      process_alive: false,
      retry: false,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
    });
  }
  return freeze({
    status: 'failed',
    reason: duplicateUnreconciled(inner) ? 'duplicate_unreconciled' : 'operation_counts_mismatch',
    retry: false,
    approvals,
    journals,
    provider_sends: sends,
  });
}

function snapshotReconcilePublic(result) {
  return freeze({
    ok: result && result.ok === true,
    reason: result && result.ok === true ? null : (result && result.reason ? String(result.reason) : 'snapshot_unproven'),
    approvals: Number.isSafeInteger(result && result.approvals) ? result.approvals : 0,
    journals: Number.isSafeInteger(result && result.journals) ? result.journals : 0,
    provider_sends: Number.isSafeInteger(result && result.provider_sends) ? result.provider_sends : 0,
    bookings: Number.isSafeInteger(result && result.bookings) ? result.bookings : 0,
    process_alive: result && result.process_alive === true,
    dispatch_status: result && typeof result.dispatch_status === 'string' ? result.dispatch_status : null,
    dispatch_reset_allowed: result && result.dispatch_reset_allowed === true,
  });
}

function servingIdentityCompatible(authorized, current) {
  if (!authorized || !current) return false;
  const authTag = sha40(authorized.imageTag) || sha40(authorized.deploySha);
  const curTag = sha40(current.imageTag) || sha40(current.deploySha);
  if (!authTag || authTag !== curTag) return false;
  if (authorized.digest && current.digest && authorized.digest !== current.digest) return false;
  if (current.appName !== STAFF_APP || current.resourceGroup !== RG) return false;
  if (current.imageRepository && current.imageRepository !== IMAGE_REPOSITORY) return false;
  return true;
}

function approvedFlagsOnly(flags) {
  if (!flags || typeof flags !== 'object' || isProxy(flags)) return false;
  const keys = Object.keys(flags);
  if (keys.length !== ALLOWED_FLAG_KEYS.length) return false;
  for (const key of ALLOWED_FLAG_KEYS) {
    if (!keys.includes(key)) return false;
    if (flags[key] !== 'true' && flags[key] !== 'false') return false;
  }
  return true;
}

function approvedReplicaFlagsExact(serving, enabled) {
  return flagsLiteral(serving, enabled) === true && approvedFlagsOnly(serving && serving.flags);
}

function servingSuccessorAcceptable(authorized, current) {
  if (!servingIdentityCompatible(authorized, current)) return false;
  if (!servingHealthyReady100(current)) return false;
  if (typeof current.revision !== 'string' || !current.revision.startsWith(STAFF_APP)) return false;
  if (!SAFE_AZ_NAME.test(current.revision)) return false;
  if (authorized.revision && !authorized.revision.startsWith(STAFF_APP)) return false;
  if (authorized.revision && !SAFE_AZ_NAME.test(authorized.revision)) return false;
  return true;
}

function typedReplicaCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasPinnedReplicaEvidence(identity) {
  if (!identity || typeof identity !== 'object' || isProxy(identity)) return false;
  const count = typedReplicaCount(identity.replicas);
  if (count !== null && count >= 1) return true;
  const replica = identity.replica;
  return typeof replica === 'string'
    && replica.startsWith(STAFF_APP)
    && SAFE_AZ_NAME.test(replica);
}

function acceptedHealthyServingRunningState(identity) {
  if (!identity || typeof identity !== 'object' || isProxy(identity)) return false;
  if (identity.runningState === 'Running') {
    return typedReplicaCount(identity.replicas) !== 0;
  }
  if (identity.runningState === 'RunningAtMaxScale') {
    return hasPinnedReplicaEvidence(identity);
  }
  return false;
}

function servingHealthyReady100(serving) {
  if (!serving || typeof serving !== 'object' || isProxy(serving)) return false;
  if (serving.healthState !== 'Healthy') return false;
  if (!acceptedHealthyServingRunningState(serving)) return false;
  if (serving.provisioningState && serving.provisioningState !== 'Provisioned'
      && serving.provisioningState !== 'Succeeded') {
    return false;
  }
  if (serving.trafficWeight !== 100) return false;
  if (serving.ready !== true) return false;
  if (typeof serving.revision !== 'string' || !serving.revision.startsWith(STAFF_APP)) return false;
  return true;
}

function acceptedFlagSource(source) {
  return source === FLAGS_SOURCE_REPLICA_PROCESS
    || source === FLAGS_SOURCE_ACA_IMMUTABLE_REVISION;
}

function flagsLiteral(serving, enabled) {
  if (!serving || !serving.flags) return false;
  if (!acceptedFlagSource(serving.flagsSource)) return false;
  const want = enabled === true ? 'true' : 'false';
  return serving.flags[ENV_LUNA_AUTO_SEND_ENABLED] === want
    && serving.flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] === want;
}

function parseRevisionTemplateEnv(env) {
  if (!Array.isArray(env)) {
    return freeze({ ok: false, reason: 'env_unproven', flags: null, fingerprint: null });
  }
  const flags = Object.create(null);
  const others = [];
  const seen = new Set();
  for (const row of env) {
    if (!row || typeof row !== 'object' || isProxy(row)) {
      return freeze({ ok: false, reason: 'env_malformed', flags: null, fingerprint: null });
    }
    const name = ownData(row, 'name') || row.name;
    if (typeof name !== 'string' || !name) {
      return freeze({ ok: false, reason: 'env_malformed', flags: null, fingerprint: null });
    }
    if (seen.has(name)) {
      return freeze({ ok: false, reason: 'env_duplicate', flags: null, fingerprint: null });
    }
    seen.add(name);
    const secretRef = ownData(row, 'secretRef') !== undefined ? ownData(row, 'secretRef') : row.secretRef;
    const value = ownData(row, 'value') !== undefined ? ownData(row, 'value') : row.value;
    const allowlisted = name === ENV_LUNA_AUTO_SEND_ENABLED
      || name === ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED;
    if (secretRef != null) {
      if (allowlisted) {
        return freeze({ ok: false, reason: 'env_secret_ref', flags: null, fingerprint: null });
      }
      if (typeof secretRef !== 'string' || !secretRef || value != null) {
        return freeze({ ok: false, reason: 'env_malformed', flags: null, fingerprint: null });
      }
      others.push(freeze({ name, secretRef }));
      continue;
    }
    if (typeof value !== 'string') {
      return freeze({ ok: false, reason: 'env_malformed', flags: null, fingerprint: null });
    }
    if (allowlisted) {
      if (value !== 'true' && value !== 'false') {
        return freeze({ ok: false, reason: 'env_non_literal', flags: null, fingerprint: null });
      }
      flags[name] = value;
      continue;
    }
    others.push(freeze({ name, value }));
  }
  if (flags[ENV_LUNA_AUTO_SEND_ENABLED] !== 'true' && flags[ENV_LUNA_AUTO_SEND_ENABLED] !== 'false') {
    return freeze({ ok: false, reason: 'env_missing', flags: null, fingerprint: null });
  }
  if (flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] !== 'true'
      && flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] !== 'false') {
    return freeze({ ok: false, reason: 'env_missing', flags: null, fingerprint: null });
  }
  others.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return freeze({
    ok: true,
    reason: null,
    flags: freeze({
      [ENV_LUNA_AUTO_SEND_ENABLED]: flags[ENV_LUNA_AUTO_SEND_ENABLED],
      [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED],
    }),
    fingerprint: JSON.stringify(others),
  });
}

function proveAcaImmutableRevisionEnv(identity, authorized, enabled) {
  if (!identity || !authorized || typeof identity !== 'object' || isProxy(identity)) return null;
  if (!servingSuccessorAcceptable(authorized, identity)) return null;
  if (!servingHealthyReady100(identity)) return null;
  const authTag = sha40(authorized.imageTag) || sha40(authorized.deploySha);
  const curTag = sha40(identity.imageTag) || sha40(identity.deploySha);
  if (!authTag || authTag !== curTag) return null;
  if (typeof authorized.digest !== 'string' || !DIGEST_RE.test(authorized.digest)) return null;
  if (typeof identity.digest !== 'string' || identity.digest !== authorized.digest) return null;
  if (typeof identity.revision !== 'string' || !identity.revision.startsWith(STAFF_APP)) return null;
  if (!SAFE_AZ_NAME.test(identity.revision)) return null;
  if (typeof identity.replica !== 'string' || !identity.replica.startsWith(STAFF_APP)) return null;
  if (!SAFE_AZ_NAME.test(identity.replica)) return null;
  if (identity.latestRevisionName && identity.latestRevisionName !== identity.revision) return null;
  if (identity.latestReadyRevisionName && identity.latestReadyRevisionName !== identity.revision) return null;
  const fingerprint = identity.unrelatedEnvFingerprint;
  if (typeof fingerprint !== 'string') return null;
  const authorizedFp = authorized.unrelatedEnvFingerprint;
  if (typeof authorizedFp === 'string') {
    if (authorizedFp !== fingerprint) return null;
  } else if (fingerprint !== '[]') {
    return null;
  }
  const flags = identity.flags;
  if (!approvedFlagsOnly(flags)) return null;
  const want = enabled === true ? 'true' : 'false';
  if (flags[ENV_LUNA_AUTO_SEND_ENABLED] !== want
      || flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] !== want) {
    return null;
  }
  return freeze({
    ...identity,
    flags,
    flagsSource: FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
    replica: identity.replica,
    revision: identity.revision,
    imageTag: identity.imageTag || authorized.imageTag,
    digest: identity.digest,
    unrelatedEnvFingerprint: fingerprint,
  });
}

function brandProductionAutoOwner(fn) {
  if (typeof fn === 'function') PRODUCTION_AUTO_OWNERS.add(fn);
  return fn;
}

function isProductionAutoOwner(fn) {
  return typeof fn === 'function' && PRODUCTION_AUTO_OWNERS.has(fn);
}

function createProductionStaffAutoCreateSendOwner(deps) {
  const withPgClient = deps && deps.withPgClient;
  if (typeof withPgClient !== 'function') throw new Error('live_proof_misconfigured');
  const owner = createProductionEmailLunaMicrosoftAutoCreateAndSend({
    env: (deps && deps.runtimeEnv) || process.env,
    pgClient: deps && deps.pgClient,
    https: (deps && deps.https) || require('node:https'),
    timers: (deps && deps.timers) || { setTimeout, clearTimeout },
    withPgClient,
    withTransactionClient: deps && deps.withTransactionClient,
  });
  const handle = brandProductionAutoOwner((input) => owner.handleProjectedInbound(input));
  return freeze({
    owner,
    handleProjectedInbound: handle,
    afterMicrosoftInboundProjected,
  });
}

function parseEnvList(raw) {
  if (!Array.isArray(raw)) return freeze({});
  const flags = Object.create(null);
  flags[ENV_LUNA_AUTO_SEND_ENABLED] = 'false';
  flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] = 'false';
  for (const row of raw) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    const name = ownData(row, 'name') || row.name;
    const value = ownData(row, 'value') || row.value;
    if (name === ENV_LUNA_AUTO_SEND_ENABLED || name === ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED) {
      flags[name] = value === 'true' ? 'true' : (typeof value === 'string' ? value : 'false');
    }
  }
  return freeze(flags);
}

function parseExplicitTrafficWeight(row) {
  if (!row || typeof row !== 'object' || isProxy(row)) return { ok: false, reason: 'traffic_unproven' };
  const hasOwnWeight = getDescriptor(row, 'weight')
    && hasOwn(getDescriptor(row, 'weight'), 'value');
  const weight = hasOwnWeight ? ownData(row, 'weight') : undefined;
  if (weight === undefined) {
    return { ok: false, reason: 'traffic_weight_missing' };
  }
  const n = typeof weight === 'number' ? weight : (typeof weight === 'string' && /^(0|[1-9][0-9]{0,2})$/.test(weight)
    ? Number.parseInt(weight, 10)
    : NaN);
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    return { ok: false, reason: 'traffic_weight_ambiguous' };
  }
  const revisionName = ownData(row, 'revisionName') || row.revisionName;
  if (typeof revisionName !== 'string' || !revisionName.startsWith(STAFF_APP) || !SAFE_AZ_NAME.test(revisionName)) {
    if (n === 0) return { ok: true, revisionName: null, weight: 0 };
    return { ok: false, reason: 'traffic_revision_invalid' };
  }
  return { ok: true, revisionName, weight: n };
}

function traffic100RevisionName(traffic) {
  if (!Array.isArray(traffic) || traffic.length < 1) return null;
  const hundred = [];
  let positive = 0;
  for (const row of traffic) {
    const parsed = parseExplicitTrafficWeight(row);
    if (!parsed.ok) return null;
    if (parsed.weight > 0) positive += 1;
    if (parsed.weight === 100) hundred.push(parsed.revisionName);
  }
  if (hundred.length !== 1 || positive !== 1 || !hundred[0]) return null;
  return hundred[0];
}

function typedDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value) ? value : null;
}

function isAzureCliNoiseLine(line) {
  if (typeof line !== 'string') return false;
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start += 1;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  if (start === end) return true;
  if (line.startsWith('WARNING:', start)) return true;
  if (line.startsWith('INFO:', start)) return true;
  const first = line[start];
  if (first === '-' || first === '\\' || first === '|' || first === '/') {
    let i = start + 1;
    while (i < end && (line[i] === ' ' || line[i] === '\t')) i += 1;
    const rest = line.slice(i, end);
    if (rest === 'Running' || rest.startsWith('Running ')
        || rest === 'Loading' || rest.startsWith('Loading ')
        || rest === 'Connecting' || rest.startsWith('Connecting ')
        || rest === 'Waiting' || rest.startsWith('Waiting ')) {
      return true;
    }
  }
  return false;
}

function isBoundedAzureCliNoise(text) {
  if (typeof text !== 'string') return false;
  if (text.length > AZURE_JSON_NOISE_MAX_BYTES) return false;
  let lines = 0;
  let i = 0;
  while (i <= text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j += 1;
    if (!isAzureCliNoiseLine(text.slice(i, j))) return false;
    lines += 1;
    if (lines > AZURE_JSON_NOISE_MAX_LINES) return false;
    if (j >= text.length) break;
    if (text[j] === '\r' && text[j + 1] === '\n') i = j + 2;
    else i = j + 1;
  }
  return true;
}

function skipJsonWhitespace(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') break;
    i += 1;
  }
  return i;
}

function scanJsonString(text, i) {
  if (text[i] !== '"') return -1;
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') return i + 1;
    if (c === '\\') {
      if (i + 1 >= text.length) return -1;
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') return -1;
    i += 1;
  }
  return -1;
}

function scanJsonNumber(text, i) {
  const start = i;
  if (text[i] === '-') i += 1;
  if (i >= text.length) return -1;
  if (text[i] === '0') {
    i += 1;
  } else if (text[i] >= '1' && text[i] <= '9') {
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
  } else {
    return -1;
  }
  if (text[i] === '.') {
    i += 1;
    if (!(text[i] >= '0' && text[i] <= '9')) return -1;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i += 1;
    if (text[i] === '+' || text[i] === '-') i += 1;
    if (!(text[i] >= '0' && text[i] <= '9')) return -1;
    while (i < text.length && text[i] >= '0' && text[i] <= '9') i += 1;
  }
  return i > start ? i : -1;
}

function scanJsonContainer(text, i, open, close) {
  if (text[i] !== open) return -1;
  i += 1;
  let first = true;
  while (i < text.length) {
    i = skipJsonWhitespace(text, i);
    if (i >= text.length) return -1;
    if (text[i] === close) return i + 1;
    if (!first) {
      if (text[i] !== ',') return -1;
      i += 1;
      i = skipJsonWhitespace(text, i);
      if (i >= text.length || text[i] === close) return -1;
    }
    first = false;
    if (open === '{') {
      if (text[i] !== '"') return -1;
      i = scanJsonString(text, i);
      if (i < 0) return -1;
      i = skipJsonWhitespace(text, i);
      if (text[i] !== ':') return -1;
      i += 1;
    }
    i = scanJsonValue(text, i);
    if (i < 0) return -1;
  }
  return -1;
}

function scanJsonValue(text, i) {
  i = skipJsonWhitespace(text, i);
  if (i >= text.length) return -1;
  const c = text[i];
  if (c === '"') return scanJsonString(text, i);
  if (c === '{') return scanJsonContainer(text, i, '{', '}');
  if (c === '[') return scanJsonContainer(text, i, '[', ']');
  if (c === 't') return text.startsWith('true', i) ? i + 4 : -1;
  if (c === 'f') return text.startsWith('false', i) ? i + 5 : -1;
  if (c === 'n') return text.startsWith('null', i) ? i + 4 : -1;
  if (c === '-' || (c >= '0' && c <= '9')) return scanJsonNumber(text, i);
  return -1;
}

function jsonStartOffsetOnLine(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i += 1;
  if (line[i] === '{' || line[i] === '[') return i;
  return -1;
}

function extractAzureJson(raw) {
  if (raw && typeof raw === 'object') {
    if (isProxy(raw)) return null;
    return raw;
  }
  if (typeof raw !== 'string') return null;
  if (!raw || raw.length > AZURE_JSON_MAX_BYTES) return null;
  let offset = 0;
  let noiseBytes = 0;
  let noiseLines = 0;
  let start = -1;
  while (offset < raw.length) {
    let j = offset;
    while (j < raw.length && raw[j] !== '\n' && raw[j] !== '\r') j += 1;
    const line = raw.slice(offset, j);
    const localStart = jsonStartOffsetOnLine(line);
    if (localStart >= 0 && !isAzureCliNoiseLine(line)) {
      start = offset + localStart;
      break;
    }
    if (!isAzureCliNoiseLine(line)) return null;
    noiseLines += 1;
    noiseBytes += line.length;
    if (noiseLines > AZURE_JSON_NOISE_MAX_LINES || noiseBytes > AZURE_JSON_NOISE_MAX_BYTES) {
      return null;
    }
    if (j >= raw.length) break;
    if (raw[j] === '\r' && raw[j + 1] === '\n') offset = j + 2;
    else offset = j + 1;
  }
  if (start < 0) return null;
  if (!isBoundedAzureCliNoise(raw.slice(0, start))) return null;
  const end = scanJsonValue(raw, start);
  if (end < 0) return null;
  if (!isBoundedAzureCliNoise(raw.slice(end))) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed)) return null;
  return parsed;
}

function parseRevisionShow(raw) {
  const parsed = extractAzureJson(raw);
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed) || Array.isArray(parsed)) return null;
  const name = ownData(parsed, 'name') || parsed.name;
  const props = ownData(parsed, 'properties') || parsed.properties || parsed;
  const revision = name || ownData(props, 'name') || props.name;
  if (typeof revision !== 'string' || !revision.startsWith(STAFF_APP) || !SAFE_AZ_NAME.test(revision)) {
    return null;
  }
  const template = ownData(props, 'template') || props.template || {};
  const containers = ownData(template, 'containers') || template.containers;
  const container = Array.isArray(containers) ? containers[0] : null;
  const image = container && (ownData(container, 'image') || container.image);
  const env = container && (ownData(container, 'env') || container.env);
  const envProof = parseRevisionTemplateEnv(env);
  let digest = (container && (ownData(container, 'imageDigest') || container.imageDigest))
    || ownData(props, 'imageDigest') || props.imageDigest
    || (typeof parsed.digest === 'string' ? parsed.digest : null);
  if ((!digest || !DIGEST_RE.test(digest)) && typeof image === 'string' && image.includes('@')) {
    digest = image.slice(image.indexOf('@') + 1);
  }
  let imageTag = null;
  let imageRef = image;
  if (typeof image === 'string' && image.startsWith(`${IMAGE_REPOSITORY}:`)) {
    imageRef = image.split('@')[0];
    imageTag = imageRef.slice(IMAGE_REPOSITORY.length + 1);
  }
  const healthState = ownData(props, 'healthState') || props.healthState || parsed.healthState;
  const runningState = ownData(props, 'runningState') || props.runningState || parsed.runningState;
  const provisioningState = ownData(props, 'provisioningState') || props.provisioningState;
  const replicaRaw = ownData(props, 'replicas');
  const replicas = typedReplicaCount(replicaRaw !== undefined ? replicaRaw : ownData(parsed, 'replicas'));
  const healthOk = healthState === 'Healthy';
  const provisionedOk = provisioningState === 'Provisioned' || provisioningState === 'Succeeded';
  const exactImage = Boolean(sha40(imageTag));
  const ready = healthOk === true
    && provisionedOk === true
    && acceptedHealthyServingRunningState({ runningState, replicas }) === true
    && (runningState === 'Running' || exactImage === true);
  return freeze({
    resourceGroup: RG,
    appName: STAFF_APP,
    revision,
    imageRepository: IMAGE_REPOSITORY,
    imageTag,
    deploySha: sha40(imageTag) || null,
    digest: typeof digest === 'string' && DIGEST_RE.test(digest) ? digest : null,
    flags: envProof.ok === true ? envProof.flags : parseEnvList(env),
    flagsSource: FLAGS_SOURCE_TEMPLATE,
    unrelatedEnvFingerprint: envProof.ok === true ? envProof.fingerprint : null,
    revisionEnvReason: envProof.reason,
    healthState: typeof healthState === 'string' ? healthState : null,
    runningState: typeof runningState === 'string' ? runningState : null,
    provisioningState: typeof provisioningState === 'string' ? provisioningState : null,
    replicas,
    ready: ready === true,
    trafficWeight: null,
  });
}

function parseServingIdentity(raw) {
  const parsed = extractAzureJson(raw);
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed) || Array.isArray(parsed)) return null;
  if (parsed.healthState || (parsed.properties && parsed.properties.healthState)
      || parsed.runningState) {
    const fromRevision = parseRevisionShow(parsed);
    if (fromRevision) return fromRevision;
  }
  const name = ownData(parsed, 'name') || parsed.name;
  if (name && name !== STAFF_APP) return null;
  const props = ownData(parsed, 'properties') || parsed.properties || parsed;
  const config = ownData(props, 'configuration') || props.configuration || {};
  const ingress = ownData(config, 'ingress') || config.ingress || {};
  const traffic = ownData(ingress, 'traffic') || ingress.traffic || parsed.traffic;
  const trafficRevision = traffic100RevisionName(traffic);
  const latestReady = ownData(props, 'latestReadyRevisionName') || props.latestReadyRevisionName;
  const latest = ownData(props, 'latestRevisionName') || props.latestRevisionName;
  if (!trafficRevision) return null;
  if (typeof latestReady !== 'string' || latestReady !== trafficRevision) return null;
  if (typeof latest !== 'string' || latest !== trafficRevision) return null;
  const revision = trafficRevision;
  const template = ownData(props, 'template') || props.template || {};
  const containers = ownData(template, 'containers') || template.containers;
  const container = Array.isArray(containers) ? containers[0] : null;
  const image = container && (ownData(container, 'image') || container.image);
  const env = container && (ownData(container, 'env') || container.env);
  if (typeof image !== 'string' || !image.startsWith(`${IMAGE_REPOSITORY}:`)) return null;
  const imageRef = image.split('@')[0];
  const imageTag = imageRef.slice(IMAGE_REPOSITORY.length + 1);
  let digest = (container && (ownData(container, 'imageDigest') || container.imageDigest))
    || ownData(props, 'imageDigest')
    || (typeof parsed.digest === 'string' ? parsed.digest : null);
  if ((!digest || !DIGEST_RE.test(String(digest))) && image.includes('@')) {
    digest = image.slice(image.indexOf('@') + 1);
  }
  if (typeof revision !== 'string' || !revision.startsWith(STAFF_APP) || !SAFE_AZ_NAME.test(revision)) {
    return null;
  }
  const runningStatus = ownData(props, 'runningStatus') || props.runningStatus;
  return freeze({
    resourceGroup: RG,
    appName: STAFF_APP,
    revision,
    imageRepository: IMAGE_REPOSITORY,
    imageTag,
    deploySha: sha40(imageTag) || null,
    digest: typeof digest === 'string' && DIGEST_RE.test(digest) ? digest : (parsed.digest || null),
    flags: parseEnvList(env),
    flagsSource: FLAGS_SOURCE_TEMPLATE,
    healthState: null,
    runningState: runningStatus === 'Running' ? 'Running' : null,
    trafficWeight: 100,
    ready: false,
    latestReadyRevisionName: latestReady,
    latestRevisionName: latest,
  });
}

function mergeRevisionIntoServing(appIdentity, revisionIdentity) {
  if (!appIdentity || !revisionIdentity) return null;
  if (appIdentity.revision !== revisionIdentity.revision) return null;
  if (appIdentity.trafficWeight !== 100) return null;
  const imageTag = revisionIdentity.imageTag || appIdentity.imageTag;
  const digest = revisionIdentity.digest || appIdentity.digest;
  if (!sha40(imageTag) || !(typeof digest === 'string' && DIGEST_RE.test(digest))) return null;
  if (appIdentity.imageTag && revisionIdentity.imageTag
      && sha40(appIdentity.imageTag) !== sha40(revisionIdentity.imageTag)) {
    return null;
  }
  if (revisionIdentity.healthState !== 'Healthy') return null;
  if (!acceptedHealthyServingRunningState(revisionIdentity)) return null;
  if (revisionIdentity.provisioningState !== 'Provisioned'
      && revisionIdentity.provisioningState !== 'Succeeded') {
    return null;
  }
  if (revisionIdentity.ready !== true) return null;
  const replicas = typedReplicaCount(revisionIdentity.replicas);
  return freeze({
    ...appIdentity,
    imageTag,
    deploySha: sha40(imageTag),
    digest,
    flags: revisionIdentity.flags || appIdentity.flags,
    flagsSource: FLAGS_SOURCE_TEMPLATE,
    unrelatedEnvFingerprint: typeof revisionIdentity.unrelatedEnvFingerprint === 'string'
      ? revisionIdentity.unrelatedEnvFingerprint
      : null,
    revisionEnvReason: revisionIdentity.revisionEnvReason || null,
    healthState: revisionIdentity.healthState,
    runningState: revisionIdentity.runningState,
    provisioningState: revisionIdentity.provisioningState,
    replicas,
    ready: true,
    trafficWeight: 100,
    replica: appIdentity.replica || revisionIdentity.replica || null,
  });
}

function buildSetEnvArgs(enabled) {
  const value = enabled === true ? 'true' : 'false';
  return freeze([
    'containerapp', 'update',
    '-g', RG,
    '-n', STAFF_APP,
    '--set-env-vars',
    `${ENV_LUNA_AUTO_SEND_ENABLED}=${value}`,
    `${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED}=${value}`,
  ]);
}

function buildShowAppArgs() {
  return freeze(['containerapp', 'show', '-g', RG, '-n', STAFF_APP, '-o', 'json']);
}

function buildRevisionShowArgs(revision) {
  if (typeof revision !== 'string' || !SAFE_AZ_NAME.test(revision) || !revision.startsWith(STAFF_APP)) {
    return null;
  }
  return freeze([
    'containerapp', 'revision', 'show',
    '-g', RG, '-n', STAFF_APP,
    '--revision', revision,
    '-o', 'json',
  ]);
}

function buildReplicaListArgs() {
  return freeze(['containerapp', 'replica', 'list', '-g', RG, '-n', STAFF_APP, '-o', 'json']);
}

function buildAcrManifestDigestArgs(imageTag) {
  const tag = sha40(imageTag);
  if (!tag) return null;
  return freeze([
    'acr', 'manifest', 'show-metadata',
    '--name', `${ACR_REPOSITORY}:${tag}`,
    '--registry', ACR_REGISTRY,
    '-o', 'json',
  ]);
}

function parseAcrManifestDigestRow(row, tag) {
  if (!row || typeof row !== 'object' || isProxy(row) || Array.isArray(row)) return null;
  if (ownData(row, 'config') != null || ownData(row, 'layers') != null
      || row.config != null || row.layers != null) {
    return freeze({ ok: false, reason: 'config_layer_refused' });
  }
  const digest = typedDigest(ownData(row, 'digest'));
  if (!digest) return freeze({ ok: false, reason: 'missing' });
  const digestValues = [];
  for (const key of Object.keys(row)) {
    const desc = getDescriptor(row, key);
    if (!desc || !hasOwn(desc, 'value') || desc.get || desc.set || desc.enumerable !== true) {
      continue;
    }
    if (typeof desc.value === 'string' && DIGEST_RE.test(desc.value)
        && (key === 'digest' || key.toLowerCase().includes('digest'))) {
      digestValues.push(desc.value);
    }
  }
  const unique = [];
  for (const value of digestValues) {
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.length !== 1 || unique[0] !== digest) {
    return freeze({ ok: false, reason: 'multiple' });
  }
  const name = ownData(row, 'name');
  const repository = ownData(row, 'repository');
  const tags = ownData(row, 'tags');
  let bound = false;
  if (repository != null) {
    if (typeof repository !== 'string' || repository !== ACR_REPOSITORY) {
      return freeze({ ok: false, reason: 'mismatch' });
    }
    bound = true;
  }
  if (name != null) {
    if (typeof name !== 'string'
        || (name !== ACR_REPOSITORY && name !== `${ACR_REPOSITORY}:${tag}` && name !== tag)) {
      return freeze({ ok: false, reason: 'mismatch' });
    }
    bound = true;
  }
  if (tags != null) {
    if (!Array.isArray(tags)) return freeze({ ok: false, reason: 'malformed' });
    let hits = 0;
    for (const value of tags) {
      if (value === tag) hits += 1;
    }
    if (hits !== 1) return freeze({ ok: false, reason: hits === 0 ? 'mismatch' : 'multiple' });
    bound = true;
  }
  if (bound !== true) return freeze({ ok: false, reason: 'mismatch' });
  return freeze({
    ok: true,
    digest,
    tag,
    registry: ACR_REGISTRY,
    repository: ACR_REPOSITORY,
  });
}

function parseAcrManifestDigest(raw, expectedTag) {
  const tag = sha40(expectedTag);
  if (!tag) return null;
  const parsed = extractAzureJson(raw);
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed)) return null;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length < 1) return null;
  const matches = [];
  for (const row of rows) {
    const parsedRow = parseAcrManifestDigestRow(row, tag);
    if (!parsedRow) return null;
    if (parsedRow.ok !== true) {
      if (parsedRow.reason === 'mismatch' && Array.isArray(parsed) && rows.length > 1) {
        continue;
      }
      return null;
    }
    matches.push(parsedRow);
  }
  if (matches.length !== 1) return null;
  const uniqueDigests = [];
  for (const row of matches) {
    if (!uniqueDigests.includes(row.digest)) uniqueDigests.push(row.digest);
  }
  if (uniqueDigests.length !== 1) return null;
  return matches[0];
}

async function resolveBoundAcrDigest(azRun, app, revision) {
  const imageTag = sha40((revision && revision.imageTag) || (app && app.imageTag));
  if (!imageTag) return null;
  if (app && app.imageTag && sha40(app.imageTag) !== imageTag) return null;
  if (revision && revision.imageTag && sha40(revision.imageTag) !== imageTag) return null;
  const repo = (revision && revision.imageRepository) || (app && app.imageRepository);
  if (repo !== IMAGE_REPOSITORY) return null;
  const claimed = [];
  const appDigest = typedDigest(app && app.digest);
  const revisionDigest = typedDigest(revision && revision.digest);
  if (appDigest) claimed.push(appDigest);
  if (revisionDigest && revisionDigest !== appDigest) claimed.push(revisionDigest);
  if (claimed.length > 1) return null;
  const acrArgs = buildAcrManifestDigestArgs(imageTag);
  if (!acrArgs || typeof azRun !== 'function') return null;
  let acrShown;
  try {
    acrShown = await azRun(acrArgs);
  } catch {
    return null;
  }
  const acr = parseAcrManifestDigest(`${acrShown && acrShown.stdout || ''}`, imageTag);
  if (!acr || acr.ok !== true || !typedDigest(acr.digest)) return null;
  if (acr.tag !== imageTag || acr.repository !== ACR_REPOSITORY || acr.registry !== ACR_REGISTRY) {
    return null;
  }
  if (claimed.length === 1 && claimed[0] !== acr.digest) return null;
  return acr.digest;
}

function envOwn(env, key) {
  if (!env || typeof env !== 'object' || isProxy(env)) return undefined;
  const own = ownData(env, key);
  if (own !== undefined) return own;
  try { return env[key]; } catch { return undefined; }
}

function staffOwnerEnvReady(env) {
  return envOwn(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT
    && envOwn(env, 'EMAIL_STAFF_LUNA_DRAFT_ENABLED') === 'true'
    && envOwn(env, 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED') === 'true'
    && envOwn(env, 'EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED') === 'true';
}

function selectProofThread(rows) {
  if (!Array.isArray(rows)) return { ok: false, reason: 'thread_not_found' };
  const matched = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    if (!isAuthoritativeSender(row)) continue;
    if (!isProofSubject(ownData(row, 'subject') || row.subject)) continue;
    if (String(ownData(row, 'provider') || row.provider) !== 'microsoft_graph') continue;
    matched.push(row);
  }
  if (matched.length === 0) return { ok: false, reason: 'thread_not_found' };
  const unique = new Set(matched.map((row) => uuid(row.conversation_id)).filter(Boolean));
  if (unique.size !== 1) return { ok: false, reason: 'thread_ambiguous' };
  const row = matched[0];
  const guestId = uuid(ownData(row, 'guest_id') || row.guest_id);
  if (!guestId) return { ok: false, reason: 'not_guest_linked' };
  return freeze({ ok: true, row: freeze({ ...row, guest_id: guestId }) });
}

async function snapshotSelectedOperation(withPgClient, row) {
  const clientId = uuid(row && row.client_id);
  const conversationId = uuid(row && row.conversation_id);
  const inboundId = uuid(row && row.inbound_message_id);
  if (!clientId || !conversationId || !inboundId) return null;
  let approvals;
  let journal;
  let bookings;
  try {
    [approvals, journal, bookings] = await Promise.all([
      withPgClient((pg) => pg.query(SQL_COUNT_OPERATION_APPROVALS, [clientId, conversationId, inboundId])),
      withPgClient((pg) => pg.query(SQL_COUNT_OPERATION_JOURNAL, [clientId, conversationId, inboundId])),
      withPgClient((pg) => pg.query(SQL_COUNT_BOOKINGS, [clientId, conversationId])),
    ]);
  } catch {
    return null;
  }
  const approvalCount = asInt(approvals && approvals.rows && approvals.rows[0]);
  const journalRow = journal && journal.rows && journal.rows[0];
  const journalCount = asInt(journalRow);
  const sendCount = journalRow && Number.isSafeInteger(journalRow.sends)
    ? journalRow.sends
    : (journalRow ? Number.parseInt(journalRow.sends, 10) : null);
  const bookingRows = bookings && Array.isArray(bookings.rows) ? bookings.rows : null;
  if (!bookingRows || bookingRows.length !== 1) return null;
  const bookingCount = asInt(bookingRows[0]);
  if (![approvalCount, journalCount, sendCount, bookingCount].every((n) => Number.isSafeInteger(n))) {
    return null;
  }
  return freeze({
    approvals: approvalCount,
    journals: journalCount,
    provider_sends: sendCount,
    bookings: bookingCount,
  });
}

async function loadSelectedOperationEvidence(withPgClient, row, secret) {
  const clientId = uuid(row.client_id);
  const conversationId = uuid(row.conversation_id);
  const inboundId = uuid(row.inbound_message_id);
  const locationId = uuid(row.location_id);
  if (!clientId || !conversationId || !inboundId) return null;
  const loaded = await withPgClient((pg) => pg.query(SQL_LOAD_OPERATION_EVIDENCE, [
    clientId, conversationId, inboundId,
  ]));
  const rows = loaded && Array.isArray(loaded.rows) ? loaded.rows : null;
  if (!rows) return null;
  if (rows.length === 0) {
    return freeze({
      message_text: null,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      draft_meta: null,
      provenance: null,
      immutable_draft_id: null,
      client_id: clientId,
      location_id: locationId,
      conversation_id: conversationId,
      source_inbound_event_id: inboundId,
    });
  }
  if (rows.length !== 1) {
    return freeze({
      message_text: null,
      approvals: rows.length,
      journals: null,
      provider_sends: null,
      draft_meta: null,
      provenance: null,
      duplicate_unreconciled: true,
      client_id: clientId,
      location_id: locationId,
      conversation_id: conversationId,
      source_inbound_event_id: inboundId,
    });
  }
  const ev = rows[0];
  const draftMeta = parseJsonMaybe(ownData(ev, 'draft_meta') || ev.draft_meta);
  const messageText = ownData(ev, 'message_text') || ev.message_text;
  const expected = freeze({
    client_id: clientId,
    location_id: locationId,
    conversation_id: conversationId,
    source_inbound_event_id: inboundId,
  });
  const envelope = draftMeta && (
    ownData(draftMeta, 'selected_operation_evidence')
    || draftMeta.selected_operation_evidence
    || (parseJsonMaybe(draftMeta.luna_email_open_draft) && parseJsonMaybe(draftMeta.luna_email_open_draft).selected_operation_evidence)
  );
  const provenance = snapshotTrustedProvenance(
    envelope || draftMeta,
    expected,
    secret,
    typeof messageText === 'string' ? messageText : '',
  ) || provenanceFromDurableDraftMeta(draftMeta, expected, secret, messageText);
  const sends = Number.parseInt(ownData(ev, 'send_invocation_count') || ev.send_invocation_count, 10);
  return freeze({
    message_text: typeof messageText === 'string' ? messageText : null,
    approval_id: uuid(ownData(ev, 'approval_id') || ev.approval_id),
    state: ownData(ev, 'state') || ev.state,
    body_digest: ownData(ev, 'body_digest') || ev.body_digest,
    immutable_draft_id: ownData(ev, 'immutable_draft_id') || ev.immutable_draft_id || null,
    phase: ownData(ev, 'phase') || ev.phase || null,
    outcome: ownData(ev, 'outcome') || ev.outcome || null,
    draft_meta: draftMeta,
    provenance,
    send_invocation_count: Number.isSafeInteger(sends) ? sends : 0,
    approvals: 1,
    journals: ownData(ev, 'immutable_draft_id') || ev.immutable_draft_id ? 1 : 0,
    provider_sends: Number.isSafeInteger(sends) ? sends : 0,
    client_id: clientId,
    location_id: locationId,
    conversation_id: conversationId,
    source_inbound_event_id: inboundId,
  });
}

function createMailMvp004LiveProof(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('live_proof_misconfigured');
  const nonceStore = wrapNonceStore(deps.nonceStore || USED_OPERATOR_NONCES);
  const nowFn = typeof deps.now === 'function' ? deps.now : Date.now;

  async function restoreSafe(authorized) {
    const errors = [];
    try {
      if (typeof deps.setEmergencyFlags === 'function') await deps.setEmergencyFlags(false);
    } catch {
      errors.push('flags');
    }
    try {
      if (typeof deps.putEmailChannelMode === 'function') await deps.putEmailChannelMode('off');
    } catch {
      errors.push('mode');
    }
    let serving = null;
    try {
      if (typeof deps.waitServingHealthy === 'function') {
        serving = await deps.waitServingHealthy({ enabled: false, authorized });
      } else if (typeof deps.readServingIdentity === 'function') {
        serving = await deps.readServingIdentity();
      }
    } catch {
      errors.push('serving');
    }
    const flagsOff = approvedReplicaFlagsExact(serving, false);
    const servingOk = flagsOff === true
      && servingHealthyReady100(serving)
      && (!authorized || servingSuccessorAcceptable(authorized, serving));
    if (!servingOk) errors.push('off_replica_unproven');
    let kill = null;
    try {
      kill = typeof deps.verifyKillSwitch === 'function' ? await deps.verifyKillSwitch() : null;
    } catch {
      errors.push('kill_switch');
    }
    const modeOff = typeof deps.getEmailChannelMode === 'function'
      ? (await deps.getEmailChannelMode()) === 'off'
      : true;
    const killOk = kill && (
      kill.reason === 'emergency_flags_off'
      || (kill.status === 'blocked' && kill.reason === 'emergency_flags_off')
    );
    if (kill && kill.author_called === true) errors.push('kill_switch_author');
    if (kill && kill.journal_called === true) errors.push('kill_switch_journal');
    if (kill && kill.provider_called === true) errors.push('kill_switch_provider');
    return freeze({
      ok: errors.length === 0 && flagsOff === true && modeOff === true && killOk === true && servingOk === true,
      flags_off: flagsOff === true,
      mode_off: modeOff === true,
      kill_switch: killOk === true,
      serving_100: servingOk === true,
      errors: freeze(errors),
      serving,
      kill,
    });
  }

  async function executeOnce(input) {
    const env = (input && input.env) || {};
    if (refusedProduction(env)) return refusedRecord('production_refused');
    if (proxyPresent(env)) return refusedRecord('proxy_refused');
    if (envOwn(env, 'LUNA_DEPLOYMENT') && envOwn(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) {
      return refusedRecord('deployment_mismatch');
    }
    const parsed = (input && input.parsed) || parseArgs(input && input.argv);
    const nowMs = Number.isSafeInteger(input && input.nowMs) ? input.nowMs : nowFn();
    const authFail = validateExactInvocation(parsed, nowMs, nonceStore);
    if (authFail) return refusedRecord(authFail);
    if (nonceStore.add(parsed.operatorNonce, OPERATION_BINDING) === false) {
      return refusedRecord('operator_nonce_replay');
    }

    const serving = await deps.readServingIdentity();
    if (!serving || serving.appName !== STAFF_APP || serving.resourceGroup !== RG) {
      return refusedRecord('wrong_target');
    }
    if (serving.revision !== parsed.revision) return refusedRecord('revision_mismatch');
    if (!servingHealthyReady100(serving)) return refusedRecord('serving_not_100_healthy');
    const servingTag = sha40(serving.imageTag) || sha40(serving.deploySha);
    const typedTag = sha40(parsed.imageTag) || sha40(parsed.deploySha);
    if (!servingTag || servingTag !== typedTag) return refusedRecord('image_mismatch');
    if (parsed.digest && serving.digest && serving.digest !== parsed.digest) {
      return refusedRecord('digest_mismatch');
    }
    if (!serving.digest || !DIGEST_RE.test(serving.digest)) return refusedRecord('digest_mismatch');

    const readiness = evaluateLiveProofReadiness({
      serving,
      originMasterSha: input && input.originMasterSha,
      headSha: input && input.headSha,
      artifactsOnMaster: input && input.artifactsOnMaster === true,
      artifactsInImage: input && input.artifactsInImage === true,
      treeHasProofFiles: input && input.treeHasProofFiles,
    });
    if (input && input.requireLiveImage !== false && readiness.can_proceed !== true) {
      return refusedRecord(readiness.blocked_reasons[0] || 'exact_master_image_required', {
        live_proof_blocked: true,
        readiness,
      });
    }

    if (serving.flags[ENV_LUNA_AUTO_SEND_ENABLED] === 'true'
        || serving.flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] === 'true') {
      return refusedRecord('flags_already_enabled');
    }

    const pre = await deps.preflightSelectedOperation();
    if (!pre || pre.ok !== true) {
      return refusedRecord((pre && pre.reason) || 'preflight_failed');
    }
    if (pre.approvals !== 0 || pre.journals !== 0 || pre.provider_sends !== 0) {
      return refusedRecord('operation_not_new');
    }
    if (pre.luna_on !== true) return refusedRecord('luna_off');
    if (pre.needs_human !== false) return refusedRecord('needs_human');
    if (pre.guest_linked !== true) return refusedRecord('not_guest_linked');
    if (pre.sender_ok !== true) return refusedRecord('sender_mismatch');
    if (pre.subject_ok !== true) return refusedRecord('subject_mismatch');
    if (pre.sol_enabled !== true) return refusedRecord('sol_disabled');

    const beforeOnKill = typeof deps.verifyKillSwitch === 'function'
      ? await deps.verifyKillSwitch()
      : null;
    if (!beforeOnKill || beforeOnKill.ok !== true
        || beforeOnKill.status !== 'blocked'
        || beforeOnKill.reason !== 'emergency_flags_off'
        || beforeOnKill.author_called === true
        || beforeOnKill.journal_called === true
        || beforeOnKill.provider_called === true) {
      return refusedRecord((beforeOnKill && beforeOnKill.reason) || 'kill_switch_unproven');
    }

    let graphProbe = null;
    try {
      graphProbe = typeof deps.verifyGraphArrival === 'function'
        ? await deps.verifyGraphArrival({
          probe: true,
          provider_source_message_id: pre.provider_source_message_id,
          graph_conversation_id: pre.graph_conversation_id,
          provider_mailbox_id: pre.provider_mailbox_id,
          inbound_internet_message_id: pre.inbound_internet_message_id,
          subject: PROOF_SUBJECT,
        })
        : null;
    } catch {
      return refusedRecord('graph_adapter_unwired');
    }
    if (!replicaGraphAdapterAvailable(graphProbe)) {
      const sanitized = sanitizeGraphPublic(graphProbe);
      const reason = sanitized.reason || 'graph_adapter_unwired';
      const stage = closedGraphGrantStage(sanitized.stage);
      return refusedRecord(reason, stage ? { stage } : undefined);
    }

    let evidenceProbe = null;
    try {
      evidenceProbe = typeof deps.readDurableEvidence === 'function'
        ? await deps.readDurableEvidence()
        : null;
    } catch {
      return refusedRecord('snapshot_unproven');
    }
    if (!replicaEvidenceCapabilityAvailable(evidenceProbe)) {
      const reason = (evidenceProbe && evidenceProbe.reason) || 'hmac_unwired';
      return refusedRecord(reason === 'proof_error' ? 'snapshot_unproven' : reason);
    }

    let modeSnapshot = 'draft';
    try {
      modeSnapshot = typeof deps.getEmailChannelMode === 'function'
        ? await deps.getEmailChannelMode()
        : 'draft';
    } catch {
      return refusedRecord('channel_mode_unproven');
    }
    const requiredFinalMode = 'off';
    const authorizedRevision = serving.revision;
    let invoked = 0;
    let ownerResult = null;
    let after = null;
    let graph = null;
    let restored = null;
    let failedReason = null;
    let dispatchMarked = false;
    let capability = null;
    try {
      await deps.setEmergencyFlags(true);
      const enabled = typeof deps.waitServingHealthy === 'function'
        ? await deps.waitServingHealthy({ enabled: true, authorized: serving })
        : await deps.readServingIdentity();
      if (!enabled) {
        failedReason = 'enabled_revision_unproven';
      } else if (!servingIdentityCompatible(serving, enabled)) {
        failedReason = 'enabled_image_drift';
      } else if (!approvedReplicaFlagsExact(enabled, true) || !servingHealthyReady100(enabled)
          || !servingSuccessorAcceptable(serving, enabled)) {
        failedReason = 'enabled_revision_unproven';
      } else {
        try {
          await deps.putEmailChannelMode('auto');
        } catch {
          failedReason = 'channel_mode_unproven';
        }
        if (failedReason) {
          /* write miss already fail-closed; do not invoke */
        } else if ((await deps.getEmailChannelMode()) !== 'auto') {
          failedReason = 'channel_mode_unproven';
        } else if (!isProductionAutoOwner(deps.invokeAutoOwner)
            && deps.requireProductionOwner !== false) {
          failedReason = 'not_canonical_owner';
        } else {
        capability = issueSupervisorCapability({
          nonce: parsed.operatorNonce,
          revision: enabled.revision,
          replica: enabled.replica,
          imageTag: servingTag,
          digest: enabled.digest || serving.digest,
        }, nowFn());
        if (!capability) {
          failedReason = 'capability_invalid';
        } else if (capability.issued_at === parsed.confirmIssuedAt
            && Date.parse(parsed.confirmIssuedAt) !== nowMs) {
          failedReason = 'caller_issued_at_untrusted';
        } else {
          ownerResult = await deps.invokeAutoOwner({
            capability,
            revision: enabled.revision,
            replica: enabled.replica,
            authorizedRevision,
            digest: enabled.digest || serving.digest,
          });
          invoked += 1;
          dispatchMarked = ownerResult && ownerResult.dispatch_marked === true;
          if (invoked !== 1) failedReason = 'owner_not_once';
        }
        if (!failedReason && ownerResult && ownerResult.status === 'skipped'
            && ownerResult.reason === 'already_sent') {
          after = await deps.snapshotOperation();
          if (!exactReconciledCounts(after) || duplicateUnreconciled(after)) {
            failedReason = 'duplicate_unreconciled';
          }
        } else if (!failedReason && (!ownerResult || ownerResult.status !== 'sent')) {
          if (ownerResult && (ownerResult.indeterminate === true || ownerResult.outcome_unknown === true)
              && typeof deps.reconcile === 'function') {
            const rec = await deps.reconcile({ retryForbidden: true, capability });
            ownerResult = rec;
            if (!rec || rec.indeterminate === true || rec.retry === true) {
              failedReason = 'indeterminate_no_retry';
            } else if (rec.status === 'skipped' && rec.reason === 'already_sent') {
              after = await deps.snapshotOperation();
              if (!exactReconciledCounts(after)) failedReason = 'duplicate_unreconciled';
            } else if (rec.status === 'proven_no_send' || rec.reason === 'proven_no_send') {
              failedReason = 'proven_no_send';
              after = after || {
                approvals: Number.isSafeInteger(rec.approvals) ? rec.approvals : 0,
                journals: Number.isSafeInteger(rec.journals) ? rec.journals : 0,
                provider_sends: Number.isSafeInteger(rec.provider_sends) ? rec.provider_sends : 0,
              };
            } else if (rec.status !== 'sent') {
              failedReason = rec.reason || 'owner_failed';
            }
          } else if (dispatchMarked && (!ownerResult || ownerResult.status !== 'sent')) {
            failedReason = 'indeterminate_no_retry';
          } else {
            failedReason = (ownerResult && ownerResult.reason) || 'owner_failed';
          }
        }
        const durable = typeof deps.readDurableEvidence === 'function'
          ? await deps.readDurableEvidence()
          : (ownerResult && ownerResult.durable_evidence) || null;
        if (!failedReason && replicaLeftover(durable)) {
          failedReason = 'leftover_generic_draft';
        }
        if (!failedReason && !replicaSolProven(durable)) {
          failedReason = 'sol_unproven';
        }
        if (!failedReason) {
          after = after || await deps.snapshotOperation();
          if (!exactReconciledCounts(after) || duplicateUnreconciled(after)) {
            failedReason = after && duplicateUnreconciled(after)
              ? 'duplicate_unreconciled'
              : 'operation_counts_mismatch';
          }
          if (Number.isSafeInteger(pre.bookings) && after && after.bookings !== pre.bookings) {
            failedReason = 'booking_side_effect';
          }
        }
        if (!failedReason) {
          graph = await deps.verifyGraphArrival({
            ...after,
            provider_source_message_id: pre.provider_source_message_id,
            graph_conversation_id: pre.graph_conversation_id,
            immutable_draft_id: durable && durable.immutable_draft_id,
            subject: PROOF_SUBJECT,
          });
          if (!graph || graph.ok !== true || graph.threaded !== true || graph.arrivals !== 1
              || graph.duplicates !== 0) {
            failedReason = (graph && graph.reason) || 'graph_unproven';
          }
        }
        }
      }
    } catch {
      failedReason = failedReason || (dispatchMarked ? 'indeterminate_no_retry' : 'owner_failed');
    } finally {
      restored = await restoreSafe(serving);
      if (modeSnapshot && requiredFinalMode !== modeSnapshot) {
        /* required final off wins for this approved job */
      }
    }

    const restoredOk = restored && restored.ok === true;
    if (failedReason) {
      return failRecord(failedReason, {
        invoked,
        restored: restoredOk,
        status: restoredOk ? 'failed' : 'outcome_unknown',
        kill_switch: restored && restored.kill_switch === true,
        live_proof_blocked: false,
        dispatch_reset_allowed: failedReason === 'proven_no_send',
        process_alive: ownerResult && ownerResult.process_alive === true,
        approvals: after && after.approvals,
        journals: after && after.journals,
        provider_sends: after && after.provider_sends,
      });
    }
    if (!restoredOk) {
      return failRecord('cleanup_unproven', {
        invoked,
        restored: false,
        status: 'outcome_unknown',
        approvals: 1,
        journals: 1,
        provider_sends: 1,
      });
    }
    return successRecord({
      invoked: 1,
      restored: true,
      kill_switch: restored.kill_switch === true,
      graph_threaded: graph && graph.threaded === true,
      duplicate: ownerResult && ownerResult.reason === 'already_sent',
      after,
      authorized_revision: authorizedRevision,
      enabled_revision: capability && capability.revision,
      restored_revision: restored.serving && restored.serving.revision,
    });
  }

  return freeze({
    executeOnce,
    restoreSafe,
    parseArgs,
  });
}

async function runStaffOwnerProof(input) {
  const env = (input && input.env) || process.env;
  if (envOwn(env, 'MAIL_MVP_004_LIVE_PROOF') !== '1'
      && envOwn(env, 'MAIL_MVP_004_STAFF_OWNER_PROOF') !== '1') {
    return refusedRecord('live_proof_disabled');
  }
  if (envOwn(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) {
    return refusedRecord('deployment_mismatch');
  }
  const nowMs = Number.isSafeInteger(input && input.nowMs) ? input.nowMs : Date.now();
  const capRaw = (input && input.capability)
    || envOwn(env, 'MAIL_MVP_004_CAPABILITY')
    || env.MAIL_MVP_004_CAPABILITY;
  const capCheck = verifySupervisorCapability(capRaw, nowMs, {
    revision: envOwn(env, 'MAIL_MVP_004_REVISION') || (input && input.revision),
    imageTag: envOwn(env, 'MAIL_MVP_004_IMAGE_TAG') || (input && input.imageTag),
    digest: envOwn(env, 'MAIL_MVP_004_DIGEST') || (input && input.digest),
  });
  if (!capCheck.ok) return refusedRecord(capCheck.reason || 'capability_required');
  const consumedPath = (input && input.consumedCapabilityPath) || INNER_CONSUMED_CAPABILITY_PATH;
  const receiptPath = (input && input.dispatchReceiptPath) || INNER_DISPATCH_RECEIPT_PATH;
  const reconcileOnly = input && input.reconcileOnly === true;
  if (!staffOwnerEnvReady(env)) return refusedRecord('staff_owner_disabled');
  if (envOwn(env, ENV_LUNA_AUTO_SEND_ENABLED) !== 'true'
      || envOwn(env, ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED) !== 'true') {
    return refusedRecord('emergency_flags_off');
  }
  if (!isEmailMicrosoftAutoSendEmergencyEnabled(env)) {
    return refusedRecord('emergency_flags_off');
  }
  const injected = input && typeof input.withPgClient === 'function';
  let pg = null;
  let withPgClient;
  if (injected) {
    withPgClient = input.withPgClient;
  } else {
    try {
      pg = createProductionStaffPgAdapter();
      withPgClient = pg.withPgClient;
    } catch {
      return failRecord('pg_adapter_unwired');
    }
  }
  try {
    const loaded = await withPgClient((client) => client.query(SQL_SELECT_PROOF_THREAD, [PROOF_SENDER]));
    const selected = selectProofThread(loaded && loaded.rows);
    if (!selected.ok) return refusedRecord(selected.reason);
    const row = selected.row;
    if (row.needs_human === true) return refusedRecord('needs_human');
    if (row.conversation_status && row.conversation_status !== 'open') {
      return refusedRecord('conversation_not_open');
    }
    const store = createEmailInboxChannelModeStore({ withPgClient });
    const mode = await store.getChannelMode(row.client_id, 'email');
    if (mode !== 'auto') return refusedRecord('email_channel_not_auto');
    const before = await snapshotSelectedOperation(withPgClient, row);
    if (!before) return failRecord('counts_unavailable');
    if (reconcileOnly === true) {
      const receipt = readDispatchReceipt(receiptPath);
      return freeze({
        ok: false,
        reason: 'reconcile_owner_state',
        reconcile: true,
        invoked: 0,
        process_alive: receipt ? receipt.process_alive === true : false,
        dispatch_status: receipt ? receipt.status : null,
        public: freeze({
          ok: false,
          reason: 'reconcile_owner_state',
          reconcile: true,
          approvals: before.approvals,
          journals: before.journals,
          provider_sends: before.provider_sends,
          process_alive: receipt ? receipt.process_alive === true : false,
          dispatch_status: receipt ? receipt.status : null,
        }),
      });
    }
    if (before.approvals > 0 || before.journals > 0 || before.provider_sends > 0) {
      if (!exactReconciledCounts(before) || duplicateUnreconciled(before)) {
        return failRecord('duplicate_unreconciled', {
          invoked: 0,
          approvals: before.approvals,
          journals: before.journals,
          provider_sends: before.provider_sends,
        });
      }
      return freeze({
        ok: true,
        status: 'skipped',
        reason: 'already_sent',
        invoked: 0,
        public: freeze({
          ok: true,
          status: 'skipped',
          reason: 'already_sent',
          invoked: 0,
          approvals: 1,
          journals: 1,
          provider_sends: 1,
          duplicate: true,
        }),
      });
    }
    const wired = input && input.wired
      ? input.wired
      : createProductionStaffAutoCreateSendOwner({ withPgClient, runtimeEnv: env });
    const handle = wired && (wired.handleProjectedInbound || (wired.owner && wired.owner.handleProjectedInbound));
    if (typeof handle !== 'function') return failRecord('live_proof_misconfigured');
    if (input && input.requireProductionOwner !== false && !isProductionAutoOwner(handle)) {
      return failRecord('not_canonical_owner');
    }
    const replaced = replaceProvenNoSendDispatchMarker({ filePath: receiptPath, counts: before });
    if (!replaced.ok) {
      return refusedRecord(replaced.reason || 'dispatch_receipt_unproven', {
        public: freeze({
          ok: false,
          reason: replaced.reason || 'dispatch_receipt_unproven',
          process_alive: replaced.process_alive === true,
        }),
      });
    }
    if (consumeInnerCapability(capCheck.capability.nonce, consumedPath) !== true) {
      return refusedRecord('capability_replay');
    }
    ignoreRemoteExecHangup();
    const issued = writeDispatchReceipt({
      status: 'issued',
      nonce: capCheck.capability.nonce,
      pid: process.pid,
      reason: null,
    }, receiptPath);
    if (!issued) return failRecord('dispatch_receipt_unproven');
    const started = handle({
      env,
      authority: freeze({
        clientId: row.client_id,
        locationId: row.location_id,
        endpointId: row.endpoint_id,
      }),
      envelope: freeze({
        provider: 'microsoft_graph',
        provider_mailbox_id: row.provider_mailbox_id,
        provider_message_id: row.provider_source_message_id,
      }),
      projection: freeze({
        status: 'already_projected',
        conversation_id: row.conversation_id,
      }),
    });
    if (input && input.emitDispatchMarker !== false
        && (envOwn(env, 'MAIL_MVP_004_STAFF_OWNER_PROOF') === '1'
          || envOwn(env, 'MAIL_MVP_004_LIVE_PROOF') === '1')) {
      process.stdout.write(`${MUTATION_ISSUED_MARKER}\n`);
    }
    const result = await started;
    writeDispatchReceipt({
      status: result && result.status === 'sent' ? 'completed' : 'failed',
      nonce: capCheck.capability.nonce,
      pid: process.pid,
      owner_status: result && result.status ? result.status : 'failed',
      reason: result && result.reason ? result.reason : (result && result.status === 'sent' ? null : 'owner_failed'),
    }, receiptPath);
    const after = await snapshotSelectedOperation(withPgClient, row);
    const durable = await loadSelectedOperationEvidence(
      withPgClient,
      row,
      envOwn(env, ENV_HMAC_SECRET),
    );
    if (result && result.status === 'skipped' && result.reason === 'already_sent') {
      if (!exactReconciledCounts(after)) {
        return failRecord('duplicate_unreconciled', {
          invoked: 1,
          approvals: after ? after.approvals : 0,
          journals: after ? after.journals : 0,
          provider_sends: after ? after.provider_sends : 0,
        });
      }
      return freeze({
        ok: true,
        status: 'skipped',
        reason: 'already_sent',
        invoked: 1,
        durable_evidence: durable,
        public: freeze({
          ok: true,
          status: 'skipped',
          reason: 'already_sent',
          invoked: 1,
          duplicate: true,
          approvals: 1,
          journals: 1,
          provider_sends: 1,
        }),
      });
    }
    if (!result || result.status !== 'sent') {
      return failRecord((result && result.reason) || 'owner_failed', {
        invoked: 1,
        approvals: after ? after.approvals : 0,
        journals: after ? after.journals : 0,
        provider_sends: after ? after.provider_sends : 0,
      });
    }
    if (!exactReconciledCounts(after)) {
      return failRecord(duplicateUnreconciled(after) ? 'duplicate_unreconciled' : 'operation_counts_mismatch', {
        invoked: 1,
        approvals: after ? after.approvals : 0,
        journals: after ? after.journals : 0,
        provider_sends: after ? after.provider_sends : 0,
      });
    }
    if (leftoverFromDurableEvidence(durable)) {
      return failRecord('leftover_generic_draft', { invoked: 1, restored: false });
    }
    const provenance = (durable && durable.provenance)
      || snapshotTrustedProvenance(
        durable && durable.draft_meta,
        {
          client_id: row.client_id,
          location_id: row.location_id,
          conversation_id: row.conversation_id,
          source_inbound_event_id: row.inbound_message_id,
        },
        envOwn(env, ENV_HMAC_SECRET),
        durable && durable.message_text,
      );
    if (!provenance || !provenance.evidence_mac || !snapshotSolMarker(provenance.marker || provenance)) {
      return failRecord('sol_unproven', { invoked: 1 });
    }
    return freeze({
      ok: true,
      status: 'sent',
      reason: null,
      invoked: 1,
      durable_evidence: durable,
      provenance,
      after,
      public: freeze({
        ok: true,
        status: 'sent',
        invoked: 1,
        approvals: 1,
        journals: 1,
        provider_sends: 1,
        hmac_kind: provenance.hmac_kind,
        sol_provider: 'openai-codex',
        sol_model: 'gpt-5.6-sol',
        sol_runtime: 'sunset-email-luna',
      }),
    });
  } finally {
    if (pg && typeof pg.closePgPool === 'function') await pg.closePgPool();
  }
}

function shSingleQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid_argv');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SAFE_ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]{1,127}=[A-Za-z0-9+_./:=-]{1,8192}$/;

function proofEnvAssignments(attemptId, reconcileOnly, extra) {
  const b64 = encodeProofEnvPayload(attemptId, reconcileOnly, extra);
  if (!b64) return null;
  let decoded;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const lines = decoded.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3 || lines.length > 16) return null;
  const assignments = [];
  for (const line of lines) {
    if (!SAFE_ENV_ASSIGNMENT.test(line)) return null;
    assignments.push(line);
  }
  return freeze(assignments);
}

function isLegalStaffOwnerRemoteCommand(command) {
  if (typeof command !== 'string' || !command || command.length > 16384) return false;
  if (command.includes("'") || command.includes('"') || command.includes('`') || command.includes('\0')) {
    return false;
  }
  if (command.includes('$(') || command.includes('${') || command.includes('\n') || command.includes('\r')) {
    return false;
  }
  if (/^sh\s+-c\b/.test(command) || command.includes('|') || command.includes('>') || command.includes('<')) {
    return false;
  }
  const prefix = '/usr/bin/env ';
  const suffix = ` node ${PROOF_REMOTE_NODE}`;
  if (!command.startsWith(prefix) || !command.endsWith(suffix)) return false;
  const middle = command.slice(prefix.length, command.length - suffix.length);
  if (!middle) return false;
  const assignments = middle.split(' ');
  if (assignments.length < 3 || assignments.length > 16) return false;
  for (const assignment of assignments) {
    if (!SAFE_ENV_ASSIGNMENT.test(assignment)) return false;
  }
  return true;
}

function remoteExecTransportFailed(out) {
  const text = String(out || '');
  if (!text) return false;
  return /ClusterExecFailure/i.test(text)
    || /unterminated quoted string/i.test(text)
    || /command terminated with non-zero exit code/i.test(text)
    || /error executing command/i.test(text);
}

function replicaInnerExecRetryable(extra) {
  if (!extra || typeof extra !== 'object' || isProxy(extra)) return false;
  if (extra.capability) return false;
  if (extra.reconcileOnly === true) return true;
  if (extra.killSwitchProbe === true) return true;
  if (extra.graphVerify === true) return true;
  if (typeof extra.snapshot === 'string' && extra.snapshot) return true;
  if (extra.channelModePut === 'auto' || extra.channelModePut === 'off') return true;
  return false;
}

function replicaInnerExecTrusted429(executed) {
  if (!executed || typeof executed !== 'object' || isProxy(executed)) return false;
  if (executed.marked === true) return false;
  if (executed.inner && typeof executed.inner === 'object') return false;
  const text = typeof executed.out === 'string' ? executed.out : '';
  return parseTrustedReplicaAttestRetryAfterMs(text) !== null;
}

async function runReplicaInnerExecWith429Retry(runOnce, extra, sleepFn) {
  if (typeof runOnce !== 'function') return null;
  const first = await runOnce();
  if (!replicaInnerExecRetryable(extra) || !replicaInnerExecTrusted429(first)) {
    return first;
  }
  const second = await runOnce();
  if (!replicaInnerExecTrusted429(second)) return second;
  const waitMs = parseTrustedReplicaAttestRetryAfterMs(second.out);
  if (!Number.isSafeInteger(waitMs) || waitMs < 1) return second;
  const capped = Math.min(waitMs, REPLICA_ATTEST_COOLDOWN_MS);
  if (typeof sleepFn === 'function') await sleepFn(capped);
  else await new Promise((resolve) => setTimeout(resolve, capped));
  return runOnce();
}

function classifyStaffOwnerExecResult(execResult) {
  const stdout = execResult && typeof execResult.stdout === 'string' ? execResult.stdout : '';
  const stderr = execResult && typeof execResult.stderr === 'string' ? execResult.stderr : '';
  const out = `${stdout}${stderr}`;
  const marked = out.includes(MUTATION_ISSUED_MARKER);
  const inner = extractProofJson(out);
  const ptyStatus = execResult && Number.isSafeInteger(execResult.status) ? execResult.status : 1;
  const transportFailed = remoteExecTransportFailed(out);
  const status = ptyStatus !== 0 || transportFailed === true ? (ptyStatus !== 0 ? ptyStatus : 1) : 0;
  const classified = freeze({
    execResult,
    marked,
    inner,
    out,
    status,
    ptyStatus,
    transportFailed: transportFailed === true,
  });
  PRODUCTION_STAFF_OWNER_EXEC_RESULTS.add(classified);
  return classified;
}

function isProductionStaffOwnerExecResult(executed) {
  return !!(executed && typeof executed === 'object' && !isProxy(executed)
    && PRODUCTION_STAFF_OWNER_EXEC_RESULTS.has(executed));
}

function parseExactProductionGraphInnerExec(executed) {
  if (!isProductionStaffOwnerExecResult(executed)) return graphUnwiredPublic();
  if (executed.status !== 0 || executed.transportFailed === true) return graphUnwiredPublic();
  if (typeof executed.out !== 'string') return graphUnwiredPublic();
  const dto = extractExactlyOneProofJson(executed.out);
  if (!dto) return graphUnwiredPublic();
  const closed = closedGraphInnerDto(dto);
  if (!closed || !closed.fields) return graphUnwiredPublic();
  const attached = graphInnerResult(closed.fields, closed.replicaBits);
  if (attached && attached.public && typeof attached.public === 'object' && !isProxy(attached.public)) {
    return attached.public;
  }
  return graphUnwiredPublic();
}

function encodeProofEnvPayload(attemptId, reconcileOnly, extra) {
  const attempt = uuid(attemptId) || (typeof attemptId === 'string' && OPERATOR_NONCE_RE.test(attemptId)
    ? attemptId
    : null);
  if (!attempt && attemptId) return null;
  const id = uuid(attemptId) || crypto.randomUUID();
  const capability = extra && extra.capability ? encodeCapability(extra.capability) : null;
  if (extra && extra.capability && !capability) return null;
  const lines = [
    'MAIL_MVP_004_LIVE_PROOF=1',
    `LUNA_DEPLOYMENT=${SUNSET_DEPLOYMENT}`,
    `MAIL_MVP_004_PROOF_ATTEMPT_ID=${id}`,
  ];
  if (extra && extra.killSwitchProbe === true) {
    lines.push(`${INNER_MODE_KILL_SWITCH}=1`);
  } else if (extra && extra.graphVerify === true) {
    lines.push(`${INNER_MODE_GRAPH_VERIFY}=1`);
  } else if (extra && (extra.channelModePut === 'auto' || extra.channelModePut === 'off')) {
    lines.push(`${INNER_MODE_CHANNEL_PUT}=${extra.channelModePut}`);
  } else if (extra && typeof extra.snapshot === 'string' && extra.snapshot) {
    lines.push(`${INNER_MODE_SNAPSHOT}=${extra.snapshot}`);
  } else {
    lines.push(reconcileOnly === true ? 'MAIL_MVP_004_RECONCILE_ONLY=1' : 'MAIL_MVP_004_STAFF_OWNER_PROOF=1');
  }
  if (capability) lines.push(`MAIL_MVP_004_CAPABILITY=${capability}`);
  if (extra && extra.revision) lines.push(`MAIL_MVP_004_REVISION=${extra.revision}`);
  if (extra && extra.imageTag) lines.push(`MAIL_MVP_004_IMAGE_TAG=${extra.imageTag}`);
  if (extra && extra.digest) lines.push(`MAIL_MVP_004_DIGEST=${extra.digest}`);
  const b64 = Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64');
  if (!SAFE_B64.test(b64) || b64.length > 8192) return null;
  return b64;
}

function buildStaffOwnerRemoteCommand(attemptId, reconcileOnly, extra) {
  const assignments = proofEnvAssignments(attemptId, reconcileOnly, extra);
  if (!assignments) return null;
  // Azure CLI sends exec --command as one query string. The cluster either
  // whitespace-splits it into argv or wraps it as sh -c '<command>'. Nested
  // `sh -c 'printf %s …'` becomes argv sh -c 'printf  with $0=%s and dies:
  // "%s: line 0: syntax error: unterminated quoted string". Payload tokens
  // are controlled env assignments plus the fixed image node path, so pass
  // the argv string ACA actually executes. No quotes, pipes, or files.
  const command = `/usr/bin/env ${assignments.join(' ')} node ${PROOF_REMOTE_NODE}`;
  return isLegalStaffOwnerRemoteCommand(command) ? command : null;
}

function buildStaffOwnerExecAzArgs(options) {
  const replica = options && options.replica;
  const revision = options && options.revision;
  if (typeof replica !== 'string' || !SAFE_AZ_NAME.test(replica) || !replica.startsWith(STAFF_APP)) {
    return null;
  }
  if (typeof revision !== 'string' || !SAFE_AZ_NAME.test(revision) || !revision.startsWith(STAFF_APP)) {
    return null;
  }
  const command = buildStaffOwnerRemoteCommand(
    options && options.attemptId,
    options && options.reconcileOnly === true,
    {
      capability: options && options.capability,
      revision,
      imageTag: options && options.imageTag,
      digest: options && options.digest,
      killSwitchProbe: options && options.killSwitchProbe === true,
      graphVerify: options && options.graphVerify === true,
      snapshot: options && options.snapshot,
      channelModePut: options && options.channelModePut,
    },
  );
  if (!isLegalStaffOwnerRemoteCommand(command)) return null;
  return freeze([
    'containerapp', 'exec',
    '-g', RG,
    '-n', STAFF_APP,
    '--replica', replica,
    '--revision', revision,
    '--command', command,
  ]);
}

function wrapPtyAzExec(azBin, azArgs) {
  if (!Array.isArray(azArgs) || azArgs[0] !== 'containerapp' || azArgs[1] !== 'exec') {
    throw new Error('pty_required');
  }
  if (azArgs.includes('--format') || azArgs.includes('--query') || azArgs.includes('-o')) {
    throw new Error('unsupported_exec_flag');
  }
  const replica = azArgs.includes('--replica') ? azArgs[azArgs.indexOf('--replica') + 1] : '';
  const revision = azArgs.includes('--revision') ? azArgs[azArgs.indexOf('--revision') + 1] : '';
  if (typeof replica !== 'string' || !SAFE_AZ_NAME.test(replica) || !replica.startsWith(STAFF_APP)) {
    throw new Error('pty_required');
  }
  if (typeof revision !== 'string' || !SAFE_AZ_NAME.test(revision) || !revision.startsWith(STAFF_APP)) {
    throw new Error('pty_required');
  }
  if (azArgs.includes('-g') === false || azArgs[azArgs.indexOf('-g') + 1] !== RG) {
    throw new Error('pty_required');
  }
  if (azArgs.includes('-n') === false || azArgs[azArgs.indexOf('-n') + 1] !== STAFF_APP) {
    throw new Error('pty_required');
  }
  const commandIndex = azArgs.indexOf('--command');
  const command = commandIndex >= 0 ? azArgs[commandIndex + 1] : '';
  if (typeof command !== 'string' || !command) throw new Error('pty_required');
  const bin = typeof azBin === 'string' && azBin ? azBin : AZ_DEFAULT;
  const commandString = [bin, ...azArgs].map(shSingleQuote).join(' ');
  return {
    bin: PTY_BIN,
    args: freeze(['-q', '-e', '-c', commandString, '/dev/null']),
    azArgs: freeze(azArgs.slice()),
    azBin: bin,
    replica,
    revision,
  };
}

function spawnAz(azBin, args, options) {
  if (Array.isArray(args) && args.includes('exec')) throw new Error('pty_required');
  const bin = typeof azBin === 'string' && azBin ? azBin : AZ_DEFAULT;
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: (options && options.timeoutMs) || 180000,
    maxBuffer: 10 * 1024 * 1024,
    env: (options && options.env) || process.env,
  });
}

function spawnPtyHarness(spec, options) {
  if (!spec || spec.bin !== PTY_BIN) throw new Error('pty_required');
  return spawnSync(spec.bin, spec.args, {
    encoding: 'utf8',
    timeout: (options && options.timeoutMs) || 240000,
    maxBuffer: 10 * 1024 * 1024,
    env: (options && options.env) || process.env,
  });
}

function inferRevision(replicaName) {
  if (typeof replicaName !== 'string' || !replicaName.startsWith(STAFF_APP)) return null;
  const match = /^(.*)-[a-z0-9]{5,10}-[a-z0-9]{5}$/.exec(replicaName);
  if (!match) return null;
  const revision = match[1];
  return revision.startsWith(STAFF_APP) && SAFE_AZ_NAME.test(revision) ? revision : null;
}

function parseRunningReplica(raw, expectedRevision) {
  const parsed = extractAzureJson(raw);
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed)) return null;
  const rows = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(ownData(parsed, 'value') || parsed.value) ? (ownData(parsed, 'value') || parsed.value) : null);
  if (!rows) return null;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    const name = ownData(row, 'name') || row.name;
    if (typeof name !== 'string' || !name.startsWith(STAFF_APP) || !SAFE_AZ_NAME.test(name)) continue;
    const props = ownData(row, 'properties') || row.properties;
    const running = (props && (ownData(props, 'runningState') || props.runningState))
      || ownData(row, 'runningState') || row.runningState;
    if (running !== 'Running') continue;
    let revision = (props && (ownData(props, 'revisionName') || props.revisionName))
      || ownData(row, 'revisionName') || row.revisionName;
    if (typeof revision !== 'string') revision = inferRevision(name);
    if (typeof revision !== 'string' || !revision.startsWith(STAFF_APP)) continue;
    if (expectedRevision && revision !== expectedRevision) continue;
    return freeze({ replica: name, revision, app: STAFF_APP, resourceGroup: RG });
  }
  return null;
}

function extractProofJson(raw, secrets) {
  const text = redactSensitive(String(raw || ''), secrets);
  const last = text.lastIndexOf('}');
  if (last < 0) return null;
  let start = -1;
  while ((start = text.indexOf('{', start + 1)) >= 0 && start <= last) {
    let value;
    try { value = JSON.parse(text.slice(start, last + 1)); } catch { continue; }
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) continue;
    if (value.ok !== true && value.ok !== false) continue;
    return value;
  }
  return null;
}

function extractExactlyOneProofJson(raw, secrets) {
  const text = redactSensitive(String(raw || ''), secrets);
  if (!text) return null;
  const found = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start < 0) break;
    let parsed = null;
    let end = -1;
    for (let j = start + 1; j < text.length; j += 1) {
      if (text[j] !== '}') continue;
      let value;
      try { value = JSON.parse(text.slice(start, j + 1)); } catch { continue; }
      if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) continue;
      if (value.ok !== true && value.ok !== false) continue;
      parsed = value;
      end = j;
      break;
    }
    if (!parsed) {
      i = start + 1;
      continue;
    }
    found.push(parsed);
    if (found.length > 1) return null;
    i = end + 1;
  }
  return found.length === 1 ? found[0] : null;
}

function graphSelectIsForbidden(select) {
  const fields = Array.isArray(select)
    ? select
    : (typeof select === 'string' ? select.split(',') : []);
  for (const field of fields) {
    const name = String(field || '').trim();
    if (GRAPH_LIST_FORBIDDEN_SELECT.includes(name) || /^body(Preview)?$/i.test(name)) {
      return true;
    }
  }
  return false;
}

function buildReadonlyGraphListRequest(input) {
  if (!input || input.forbid_send !== true) return null;
  const mailbox = uuid(input.provider_mailbox_id || input.mailbox_id);
  const conversationId = input.graph_conversation_id;
  if (!mailbox || typeof conversationId !== 'string' || !conversationId || conversationId.length > 512) {
    return null;
  }
  const select = Array.isArray(input.select) ? input.select.slice() : GRAPH_LIST_SELECT.slice();
  if (graphSelectIsForbidden(select)) return null;
  const allowed = new Set(GRAPH_LIST_SELECT);
  for (const field of select) {
    if (!allowed.has(field)) return null;
  }
  const filter = `conversationId eq '${String(conversationId).replace(/'/g, "''")}'`;
  const path = `/v1.0/users/${encodeURIComponent(mailbox)}/messages?$filter=${encodeURIComponent(filter)}&$select=${encodeURIComponent(select.join(','))}&$top=25`;
  return freeze({
    method: 'GET',
    host: 'graph.microsoft.com',
    path,
    select: freeze(select.slice()),
    forbid_send: true,
    forbid_body: true,
    provider_mailbox_id: mailbox,
    graph_conversation_id: conversationId,
  });
}

function closedGraphListFailure(reason) {
  return freeze({ ok: false, reason, messages: [] });
}

function parseGraphListMessages(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return closedGraphListFailure('graph_unproven'); }
  }
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed)) {
    return closedGraphListFailure('graph_unproven');
  }
  const value = ownData(parsed, 'value') || parsed.value;
  if (!Array.isArray(value)) return closedGraphListFailure('graph_unproven');
  const messages = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    if (ownData(row, 'body') !== undefined || ownData(row, 'bodyPreview') !== undefined
        || row.body != null || row.bodyPreview != null) {
      return freeze({ ok: false, reason: 'graph_body_leaked' });
    }
    const headers = ownData(row, 'internetMessageHeaders') || row.internetMessageHeaders;
    let inReplyTo = null;
    let references = null;
    if (Array.isArray(headers)) {
      for (const header of headers) {
        if (!header || typeof header !== 'object') continue;
        const name = String(ownData(header, 'name') || header.name || '').toLowerCase();
        const headerValue = ownData(header, 'value') || header.value;
        if (name === 'in-reply-to' && typeof headerValue === 'string') inReplyTo = headerValue;
        if (name === 'references' && typeof headerValue === 'string') references = headerValue;
      }
    }
    messages.push(freeze({
      id: ownData(row, 'id') || row.id,
      conversationId: ownData(row, 'conversationId') || row.conversationId,
      internetMessageId: ownData(row, 'internetMessageId') || row.internetMessageId,
      subject: ownData(row, 'subject') || row.subject,
      inReplyTo: typeof inReplyTo === 'string' ? inReplyTo : null,
      references: typeof references === 'string' ? references : null,
    }));
  }
  return freeze({ ok: true, messages: freeze(messages) });
}

function classifyClosedGraphHttpStatus(status) {
  if (status === 401 || status === 403) return 'graph_auth_unproven';
  return 'graph_unproven';
}

function httpsGraphGet(httpsImpl, token, request, timers) {
  return new Promise((resolve, reject) => {
    if (!httpsImpl || typeof httpsImpl.request !== 'function') {
      reject(new Error('graph_adapter_unwired'));
      return;
    }
    if (!request || request.method !== 'GET' || /\/send(Mail)?\b/i.test(String(request.path || ''))) {
      reject(new Error('graph_send_forbidden'));
      return;
    }
    const setTimer = timers && typeof timers.setTimeout === 'function'
      ? timers.setTimeout.bind(timers)
      : setTimeout;
    const clearTimer = timers && typeof timers.clearTimeout === 'function'
      ? timers.clearTimeout.bind(timers)
      : clearTimeout;
    let settled = false;
    let timerHandle = null;
    let req = null;
    const finish = (err, body) => {
      if (settled) return;
      settled = true;
      try { if (timerHandle != null) clearTimer(timerHandle); } catch { /* */ }
      if (err) reject(err);
      else resolve(body);
    };
    const fail = (reason) => {
      try { if (req && typeof req.destroy === 'function') req.destroy(); } catch { /* */ }
      finish(new Error(reason));
    };
    try {
      req = httpsImpl.request({
        method: 'GET',
        host: request.host,
        path: request.path,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          Prefer: GRAPH_PREFER_IMMUTABLE_ID,
        },
      }, (res) => {
        const status = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
        const chunks = [];
        let size = 0;
        const onChunk = (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > GRAPH_GET_MAX_BYTES) {
            fail('graph_unproven');
            return;
          }
          if (status === 200) chunks.push(chunk);
        };
        res.on('data', onChunk);
        res.on('error', () => fail('graph_unproven'));
        res.on('end', () => {
          if (settled) return;
          if (status !== 200) {
            fail(classifyClosedGraphHttpStatus(status));
            return;
          }
          finish(null, Buffer.concat(chunks).toString('utf8'));
        });
      });
    } catch {
      fail('graph_unproven');
      return;
    }
    if (!req || typeof req.on !== 'function') {
      fail('graph_adapter_unwired');
      return;
    }
    req.on('error', () => fail('graph_unproven'));
    try {
      timerHandle = setTimer(() => fail('graph_unproven'), GRAPH_GET_DEADLINE_MS);
    } catch {
      fail('graph_unproven');
      return;
    }
    try {
      req.end();
    } catch {
      fail('graph_unproven');
    }
  });
}

function classifyGraphArrival(messages, expected) {
  if (!Array.isArray(messages)) return freeze({ ok: false, reason: 'graph_unproven', arrivals: 0, duplicates: 0, threaded: false });
  const expectedThread = expected && expected.graph_conversation_id;
  const sourceId = expected && expected.provider_source_message_id;
  const inboundInternet = expected && expected.inbound_internet_message_id;
  const draftId = expected && expected.immutable_draft_id;
  let arrivals = 0;
  let duplicates = 0;
  let threaded = false;
  const seen = new Set();
  for (const row of messages) {
    if (!row || typeof row !== 'object' || isProxy(row)) continue;
    const id = ownData(row, 'id') || row.id;
    const conversationId = ownData(row, 'conversationId') || row.conversationId || row.graph_conversation_id;
    const subject = ownData(row, 'subject') || row.subject;
    const inReplyTo = ownData(row, 'inReplyTo') || row.inReplyTo;
    const references = ownData(row, 'references') || row.references;
    if (typeof (ownData(row, 'body') || row.body) === 'string') {
      return freeze({ ok: false, reason: 'graph_body_leaked', arrivals: 0, duplicates: 0, threaded: false });
    }
    if (typeof (ownData(row, 'from') || row.from) === 'string'
        || /@/.test(String(ownData(row, 'sender') || row.sender || ''))) {
      return freeze({ ok: false, reason: 'graph_pii_leaked', arrivals: 0, duplicates: 0, threaded: false });
    }
    if (sourceId && id === sourceId) continue;
    const subjectOk = isProofSubject(subject);
    const threadOk = expectedThread ? conversationId === expectedThread : subjectOk;
    const replyOk = headerCites(inReplyTo, sourceId)
      || headerCites(inReplyTo, inboundInternet)
      || headerCites(references, sourceId)
      || headerCites(references, inboundInternet)
      || (draftId && (id === draftId || row.provider_message_id === draftId))
      || (!sourceId && !inboundInternet && !draftId);
    if (!subjectOk || !threadOk || !replyOk) continue;
    if (typeof id === 'string' && seen.has(id)) {
      duplicates += 1;
      continue;
    }
    if (typeof id === 'string') seen.add(id);
    arrivals += 1;
    threaded = threadOk && subjectOk;
  }
  if (arrivals !== 1 || duplicates !== 0 || threaded !== true) {
    return freeze({
      ok: false,
      reason: arrivals > 1 || duplicates > 0 ? 'graph_duplicate' : 'graph_unproven',
      arrivals,
      duplicates,
      threaded,
    });
  }
  return freeze({
    ok: true,
    threaded: true,
    arrivals: 1,
    duplicates: 0,
    subject_ok: true,
  });
}

function brandProductionGraphVerifier(fn) {
  if (typeof fn === 'function') PRODUCTION_GRAPH_VERIFIERS.add(fn);
  return fn;
}

function isProductionGraphVerifier(fn) {
  return typeof fn === 'function' && PRODUCTION_GRAPH_VERIFIERS.has(fn);
}

function createProductionGraphArrivalVerifier(deps) {
  const list = deps && deps.listThreadMessages;
  if (typeof list !== 'function') throw new Error('graph_adapter_unwired');
  const verify = brandProductionGraphVerifier(async (input) => {
    const request = buildReadonlyGraphListRequest({
      ...input,
      select: GRAPH_LIST_SELECT,
      forbid_body: true,
      forbid_send: true,
    });
    if (!request) {
      return freeze({ ok: false, reason: 'graph_unproven', arrivals: 0, duplicates: 0, threaded: false });
    }
    const listed = await list(freeze({
      ...request,
      graph_conversation_id: input && input.graph_conversation_id,
      provider_source_message_id: input && input.provider_source_message_id,
      provider_mailbox_id: input && input.provider_mailbox_id,
      immutable_draft_id: input && input.immutable_draft_id,
      select: GRAPH_LIST_SELECT,
      forbid_body: true,
      forbid_send: true,
    }));
    if (listed && listed.reason === 'graph_body_leaked') {
      return freeze({ ok: false, reason: 'graph_body_leaked', arrivals: 0, duplicates: 0, threaded: false });
    }
    if (listed && listed.reason === 'graph_auth_unproven') {
      return freeze({ ok: false, reason: 'graph_auth_unproven', arrivals: 0, duplicates: 0, threaded: false });
    }
    if (!listed || listed.ok === false) {
      return freeze({ ok: false, reason: 'graph_unproven', arrivals: 0, duplicates: 0, threaded: false });
    }
    return classifyGraphArrival(listed && listed.messages ? listed.messages : listed, input);
  });
  return freeze({ verifyGraphArrival: verify });
}

function createProductionReadonlyGraphListAdapter(deps) {
  if (deps && deps.listThreadMessages && deps.allowInjectedList === true) {
    throw new Error('graph_adapter_unwired');
  }
  const httpsImpl = (deps && deps.https) || require('node:https');
  const getAccessToken = deps && deps.getAccessToken;
  if (typeof getAccessToken !== 'function') {
    const verify = async () => sanitizeGraphPublic({
      ok: false,
      reason: 'graph_adapter_unwired',
      adapter_available: false,
      readonly: false,
      arrivals: 0,
      duplicates: 0,
      threaded: false,
    });
    return freeze({ verifyGraphArrival: verify, unwired: true });
  }
  return createProductionGraphArrivalVerifier({
    async listThreadMessages(input) {
      if (input && (input.method === 'POST' || input.forbid_send !== true)) {
        return freeze({ ok: false, reason: 'graph_send_forbidden', messages: [] });
      }
      if (graphSelectIsForbidden(input && input.select)) {
        return freeze({ ok: false, reason: 'graph_body_leaked', messages: [] });
      }
      const request = buildReadonlyGraphListRequest({
        ...input,
        forbid_send: true,
        forbid_body: true,
        select: GRAPH_LIST_SELECT,
      });
      if (!request) return freeze({ ok: false, reason: 'graph_unproven', messages: [] });
      const token = await getAccessToken(input);
      if (typeof token !== 'string' || !token) {
        return freeze({ ok: false, reason: 'graph_adapter_unwired', messages: [] });
      }
      try {
        const raw = await httpsGraphGet(httpsImpl, token, request, deps && deps.timers);
        const parsed = parseGraphListMessages(raw);
        if (!parsed || parsed.ok !== true) {
          if (parsed && parsed.reason === 'graph_body_leaked') {
            return freeze({ ok: false, reason: 'graph_body_leaked' });
          }
          return closedGraphListFailure('graph_unproven');
        }
        return parsed;
      } catch (err) {
        const msg = err && typeof err.message === 'string' ? err.message : '';
        if (msg === 'graph_send_forbidden') return closedGraphListFailure('graph_send_forbidden');
        if (msg === 'graph_adapter_unwired') return closedGraphListFailure('graph_adapter_unwired');
        if (msg === 'graph_auth_unproven') return closedGraphListFailure('graph_auth_unproven');
        return closedGraphListFailure('graph_unproven');
      }
    },
  });
}

function createCanonical003KillSwitch(deps) {
  const handle = deps && deps.handleProjectedInbound;
  if (typeof handle !== 'function') throw new Error('kill_switch_misconfigured');
  if (deps && deps.syntheticEnv === true) throw new Error('kill_switch_synthetic_env');
  async function verifyKillSwitch(input) {
    const env = (input && input.env) || (deps && deps.runtimeEnv) || process.env;
    if (envOwn(env, ENV_LUNA_AUTO_SEND_ENABLED) !== 'false'
        || envOwn(env, ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED) !== 'false') {
      return freeze({
        ok: false,
        reason: 'kill_switch_unproven',
        author_called: false,
        journal_called: false,
        provider_called: false,
      });
    }
    const result = await handle({
      env,
      authority: input && input.authority,
      envelope: input && input.envelope,
      projection: input && input.projection,
      probe: true,
      consume: false,
    });
    const authorCalled = !!(result && (result.draft_writes > 0 || result.author_called === true));
    const journalCalled = !!(result && (result.journals > 0 || result.journal_called === true));
    const providerCalled = !!(result && (result.provider_sends > 0 || result.provider_called === true));
    if (!result || result.status !== 'blocked' || result.reason !== 'emergency_flags_off') {
      return freeze({
        ok: false,
        status: result && result.status,
        reason: (result && result.reason) || 'kill_switch_unproven',
        author_called: authorCalled,
        journal_called: journalCalled,
        provider_called: providerCalled,
      });
    }
    if (authorCalled || journalCalled || providerCalled) {
      return freeze({
        ok: false,
        status: 'blocked',
        reason: 'kill_switch_side_effect',
        author_called: authorCalled,
        journal_called: journalCalled,
        provider_called: providerCalled,
      });
    }
    return freeze({
      ok: true,
      status: 'blocked',
      reason: 'emergency_flags_off',
      author_called: false,
      journal_called: false,
      provider_called: false,
      provider_sends: 0,
    });
  }
  PRODUCTION_KILL_SWITCHES.add(verifyKillSwitch);
  return verifyKillSwitch;
}

function isProductionKillSwitch(fn) {
  return typeof fn === 'function' && PRODUCTION_KILL_SWITCHES.has(fn);
}

const REPLICA_ENV_PRINTENV = `/usr/bin/printenv ${ENV_LUNA_AUTO_SEND_ENABLED} ${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED}`;
const REPLICA_ENV_ATTEST_TIMEOUT_MS = 20000;

function isLegalReplicaEnvRemoteCommand(command) {
  if (typeof command !== 'string' || !command || command.length > 512) return false;
  if (command.includes("'") || command.includes('"') || command.includes('`') || command.includes('\0')) {
    return false;
  }
  if (command.includes('$(') || command.includes('${') || command.includes('\n') || command.includes('\r')) {
    return false;
  }
  if (/^sh\s+-c\b/.test(command) || command.includes('|') || command.includes('>') || command.includes('<')) {
    return false;
  }
  return command === REPLICA_ENV_PRINTENV;
}

function buildReplicaEnvRemoteCommand() {
  return isLegalReplicaEnvRemoteCommand(REPLICA_ENV_PRINTENV) ? REPLICA_ENV_PRINTENV : null;
}

function buildReplicaEnvAttestCommand() {
  const command = buildReplicaEnvRemoteCommand();
  if (!command) return null;
  return freeze(['/usr/bin/printenv', ENV_LUNA_AUTO_SEND_ENABLED, ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]);
}

function buildReplicaEnvExecAzArgs(serving) {
  if (!serving || typeof serving.replica !== 'string' || !SAFE_AZ_NAME.test(serving.replica)) {
    return null;
  }
  if (typeof serving.revision !== 'string' || !SAFE_AZ_NAME.test(serving.revision)
      || !serving.revision.startsWith(STAFF_APP)) {
    return null;
  }
  const command = buildReplicaEnvRemoteCommand();
  if (!isLegalReplicaEnvRemoteCommand(command)) return null;
  return freeze([
    'containerapp', 'exec',
    '-g', RG,
    '-n', STAFF_APP,
    '--replica', serving.replica,
    '--revision', serving.revision,
    '--command', command,
  ]);
}

function replicaAttestScopeKey(serving, enabled) {
  if (!serving || typeof serving !== 'object' || isProxy(serving)) return null;
  const revision = serving.revision;
  const replica = serving.replica;
  if (typeof revision !== 'string' || typeof replica !== 'string') return null;
  if (!revision.startsWith(STAFF_APP) || !replica.startsWith(STAFF_APP)) return null;
  if (!SAFE_AZ_NAME.test(revision) || !SAFE_AZ_NAME.test(replica)) return null;
  return `${revision}\0${replica}\0${enabled === true ? '1' : '0'}`;
}

function replicaAttestMatchesCurrent(attested, identity, enabled) {
  if (!attested || !identity) return false;
  if (attested.revision !== identity.revision || attested.replica !== identity.replica) return false;
  if (attested.flagsSource !== FLAGS_SOURCE_REPLICA_PROCESS) return false;
  return approvedReplicaFlagsExact(attested, enabled) === true;
}

function parseTrustedReplicaAttestRetryAfterMs(raw) {
  const text = String(raw || '');
  if (!text) return null;
  const has429 = /HTTP(?:\/\d(?:\.\d)?)?\s*429\b/i.test(text)
    || /\b429\s+Too Many Requests\b/i.test(text)
    || /\bstatus(?:\s+code)?\s*[:=]?\s*429\b/i.test(text);
  if (!has429) return null;
  const match = text.match(/\bretry-after\b\s*[:=]?\s*"?(\d{1,4})"?/i);
  if (!match) return REPLICA_ATTEST_COOLDOWN_MS;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < 1) return REPLICA_ATTEST_COOLDOWN_MS;
  return Math.min(seconds, REPLICA_ATTEST_RETRY_AFTER_MAX_S) * 1000;
}

function replicaAttestBackoffMs(raw) {
  const parsed = parseTrustedReplicaAttestRetryAfterMs(raw);
  if (!Number.isSafeInteger(parsed)) {
    return REPLICA_ATTEST_COOLDOWN_MS;
  }
  const floored = parsed < REPLICA_ATTEST_COOLDOWN_MS
    ? REPLICA_ATTEST_COOLDOWN_MS
    : Math.min(parsed, REPLICA_ATTEST_COOLDOWN_MS);
  return Math.min(floored + REPLICA_ATTEST_RETRY_AFTER_SLACK_MS, REPLICA_ATTEST_RETRY_AFTER_WAIT_MS);
}

function parseReplicaProcessEnv(raw) {
  const text = String(raw || '');
  const flags = Object.create(null);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const name = line.slice(0, eq);
      const value = line.slice(eq + 1);
      if ((name === ENV_LUNA_AUTO_SEND_ENABLED
          || name === ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED)
          && (value === 'true' || value === 'false')) {
        flags[name] = value;
      }
    }
  }
  if (flags[ENV_LUNA_AUTO_SEND_ENABLED] && flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]) {
    return freeze({
      [ENV_LUNA_AUTO_SEND_ENABLED]: flags[ENV_LUNA_AUTO_SEND_ENABLED],
      [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED],
      flagsSource: FLAGS_SOURCE_REPLICA_PROCESS,
    });
  }
  const values = lines.filter((line) => line === 'true' || line === 'false');
  if (values.length === 2) {
    return freeze({
      [ENV_LUNA_AUTO_SEND_ENABLED]: values[0],
      [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: values[1],
      flagsSource: FLAGS_SOURCE_REPLICA_PROCESS,
    });
  }
  return null;
}

async function attestReplicaProcessEnvResult(azRun, serving, azBin, env, timeoutMs) {
  if (!serving || !servingHealthyReady100(serving)) {
    return freeze({ serving: null, retryAfterMs: null, attempted: false });
  }
  const args = buildReplicaEnvExecAzArgs(serving);
  if (!args || typeof azRun !== 'function') {
    return freeze({ serving: null, retryAfterMs: null, attempted: false });
  }
  let raw = null;
  const execTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : REPLICA_ENV_ATTEST_TIMEOUT_MS;
  try {
    raw = await azRun(args);
  } catch (error) {
    if (!error || error.message !== 'pty_required') {
      const thrownText = error && typeof error.message === 'string' ? error.message : '';
      return freeze({
        serving: null,
        retryAfterMs: replicaAttestBackoffMs(thrownText),
        attempted: true,
      });
    }
    try {
      const spec = wrapPtyAzExec(azBin || AZ_DEFAULT, args);
      raw = spawnPtyHarness(spec, { env: env || process.env, timeoutMs: execTimeout });
    } catch (ptyError) {
      const thrownText = ptyError && typeof ptyError.message === 'string' ? ptyError.message : '';
      return freeze({
        serving: null,
        retryAfterMs: replicaAttestBackoffMs(thrownText),
        attempted: true,
      });
    }
  }
  const statusHint = raw && raw.status === 429 ? 'HTTP 429' : '';
  const text = `${raw && raw.stdout || ''}\n${raw && raw.stderr || ''}\n${statusHint}`;
  const retryAfterMs = replicaAttestBackoffMs(text);
  if (parseTrustedReplicaAttestRetryAfterMs(text) !== null || remoteExecTransportFailed(text)) {
    return freeze({ serving: null, retryAfterMs, attempted: true });
  }
  const parsed = parseReplicaProcessEnv(text);
  if (!parsed) {
    return freeze({ serving: null, retryAfterMs: REPLICA_ATTEST_COOLDOWN_MS, attempted: true });
  }
  const flags = freeze({
    [ENV_LUNA_AUTO_SEND_ENABLED]: parsed[ENV_LUNA_AUTO_SEND_ENABLED],
    [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: parsed[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED],
  });
  if (!approvedFlagsOnly(flags)) {
    return freeze({ serving: null, retryAfterMs: REPLICA_ATTEST_COOLDOWN_MS, attempted: true });
  }
  return freeze({
    serving: freeze({
      ...serving,
      flags,
      flagsSource: FLAGS_SOURCE_REPLICA_PROCESS,
    }),
    retryAfterMs: 0,
    attempted: true,
  });
}

async function attestReplicaProcessEnv(azRun, serving, azBin, env, timeoutMs) {
  const probed = await attestReplicaProcessEnvResult(azRun, serving, azBin, env, timeoutMs);
  return probed && probed.serving ? probed.serving : null;
}

function brandReplicaEnvAttestor(fn) {
  if (typeof fn === 'function') PRODUCTION_REPLICA_ENV_ATTESTORS.add(fn);
  return fn;
}

async function readProductionServingIdentity(azRun) {
  const shown = await azRun(buildShowAppArgs());
  const app = parseServingIdentity(`${shown && shown.stdout || ''}`);
  if (!app || !app.revision || app.trafficWeight !== 100) return null;
  const revArgs = buildRevisionShowArgs(app.revision);
  if (!revArgs) return null;
  const revShown = await azRun(revArgs);
  const revision = parseRevisionShow(`${revShown && revShown.stdout || ''}`);
  if (!revision) return null;
  const digest = await resolveBoundAcrDigest(azRun, app, revision);
  if (!digest) return null;
  const merged = mergeRevisionIntoServing(
    freeze({ ...app, digest }),
    freeze({ ...revision, digest }),
  );
  if (!merged || merged.trafficWeight !== 100 || !servingHealthyReady100(merged)) return null;
  const replicas = await azRun(buildReplicaListArgs());
  const running = parseRunningReplica(`${replicas && replicas.stdout || ''}`, merged.revision);
  if (!running || !running.replica) return null;
  return freeze({
    ...merged,
    replica: running.replica,
    trafficWeight: 100,
    ready: true,
    flagsSource: FLAGS_SOURCE_TEMPLATE,
  });
}

function replicaProcessEnvContradictsDesired(probed, identity, enabled) {
  const attested = probed && probed.serving;
  if (!attested || attested.flagsSource !== FLAGS_SOURCE_REPLICA_PROCESS) return false;
  if (!identity || attested.revision !== identity.revision || attested.replica !== identity.replica) {
    return false;
  }
  return replicaAttestMatchesCurrent(attested, identity, enabled) !== true;
}

async function waitServingHealthy(azRun, options) {
  const enabled = options && options.enabled === true;
  const authorized = options && options.authorized;
  if (!authorized) return null;
  const nowFn = (options && options.now) || Date.now;
  const sleepFn = (options && options.sleep) || ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
  const timeoutMs = Number.isSafeInteger(options && options.timeoutMs)
    ? options.timeoutMs : REVISION_WAIT_TIMEOUT_MS;
  const intervalMs = Number.isSafeInteger(options && options.intervalMs)
    ? options.intervalMs : REVISION_WAIT_INTERVAL_MS;
  const start = nowFn();
  let last = null;
  const execTried = new Set();
  const processContradicted = new Set();
  while (nowFn() - start <= timeoutMs) {
    last = await readProductionServingIdentity(azRun);
    if (last && servingSuccessorAcceptable(authorized, last)) {
      const native = proveAcaImmutableRevisionEnv(last, authorized, enabled);
      const scope = replicaAttestScopeKey(last, enabled);
      if (native && !(scope && processContradicted.has(scope))) {
        if (scope && !execTried.has(scope)) {
          execTried.add(scope);
          const probed = await attestReplicaProcessEnvResult(
            azRun,
            last,
            options && options.azBin,
            options && options.env,
            options && options.attestTimeoutMs,
          );
          const attested = probed && probed.serving;
          if (attested
              && replicaAttestScopeKey(attested, enabled) === scope
              && replicaAttestMatchesCurrent(attested, last, enabled)
              && servingSuccessorAcceptable(authorized, attested)) {
            return attested;
          }
          if (replicaProcessEnvContradictsDesired(probed, last, enabled)) {
            processContradicted.add(scope);
          } else {
            return native;
          }
        } else {
          return native;
        }
      }
    }
    await sleepFn(intervalMs);
  }
  return last;
}

function createProductionStaffPgAdapter(options) {
  let pg = options && options.pgConnect;
  if (!pg) {
    try {
      pg = require('./pg-connect');
    } catch {
      pg = null;
    }
  }
  if (!pg || typeof pg.withPgClient !== 'function') {
    const err = new Error('pg_adapter_unwired');
    err.reason = 'pg_adapter_unwired';
    throw err;
  }
  async function withPgClient(fn) {
    return pg.withPgClient(async (client) => {
      const identity = await client.query('SELECT current_database() AS current_database');
      const row = identity && identity.rows && identity.rows[0];
      const db = row && (ownData(row, 'current_database') || row.current_database);
      if (db !== EXPECTED_DATABASE) {
        const err = new Error('database_mismatch');
        err.reason = 'database_mismatch';
        throw err;
      }
      return fn(client);
    });
  }
  PRODUCTION_PG_ADAPTERS.add(withPgClient);
  return freeze({
    withPgClient,
    closePgPool: typeof pg.closePgPool === 'function' ? () => pg.closePgPool() : async () => {},
  });
}

function isProductionPgAdapter(fn) {
  return typeof fn === 'function' && PRODUCTION_PG_ADAPTERS.has(fn);
}

async function runKillSwitchProbe(input) {
  const env = (input && input.env) || process.env;
  if (envOwn(env, INNER_MODE_KILL_SWITCH) !== '1') {
    return refusedRecord('kill_switch_unproven');
  }
  if (envOwn(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) {
    return refusedRecord('deployment_mismatch');
  }
  const injected = input && typeof input.withPgClient === 'function';
  let pg = null;
  let withPgClient;
  if (injected) {
    withPgClient = input.withPgClient;
  } else {
    try {
      pg = createProductionStaffPgAdapter();
      withPgClient = pg.withPgClient;
    } catch {
      return refusedRecord('pg_adapter_unwired');
    }
  }
  try {
    const loaded = await withPgClient((client) => client.query(SQL_SELECT_PROOF_THREAD, [PROOF_SENDER]));
    const selected = selectProofThread(loaded && loaded.rows);
    if (!selected.ok) return refusedRecord(selected.reason);
    const row = selected.row;
    const wired = input && input.wired
      ? input.wired
      : createProductionStaffAutoCreateSendOwner({ withPgClient, runtimeEnv: env });
    const handle = wired && (wired.handleProjectedInbound
      || (wired.owner && wired.owner.handleProjectedInbound));
    if (typeof handle !== 'function') return refusedRecord('kill_switch_unproven');
    const kill = createCanonical003KillSwitch({
      handleProjectedInbound: handle,
      runtimeEnv: env,
    });
    const probed = await kill({
      env,
      authority: freeze({
        clientId: row.client_id,
        locationId: row.location_id,
        endpointId: row.endpoint_id,
      }),
      envelope: freeze({
        provider: 'microsoft_graph',
        provider_mailbox_id: row.provider_mailbox_id,
        provider_message_id: row.provider_source_message_id,
      }),
      projection: freeze({
        status: 'already_projected',
        conversation_id: row.conversation_id,
      }),
    });
    return attachPublic(probed, killSwitchPublic(probed));
  } finally {
    if (pg && typeof pg.closePgPool === 'function') await pg.closePgPool();
  }
}

async function runInnerSnapshot(input) {
  const env = (input && input.env) || process.env;
  const kind = envOwn(env, INNER_MODE_SNAPSHOT) || (input && input.snapshot);
  if (typeof kind !== 'string' || !kind) return refusedRecord('snapshot_unproven');
  const injected = input && typeof input.withPgClient === 'function';
  let pg = null;
  let withPgClient;
  if (injected) {
    withPgClient = input.withPgClient;
  } else {
    try {
      pg = createProductionStaffPgAdapter();
      withPgClient = pg.withPgClient;
    } catch {
      return refusedRecord('pg_adapter_unwired');
    }
  }
  try {
    const loaded = await withPgClient((client) => client.query(SQL_SELECT_PROOF_THREAD, [PROOF_SENDER]));
    const selected = selectProofThread(loaded && loaded.rows);
    if (!selected.ok) return refusedRecord(selected.reason);
    const row = selected.row;
    if (kind === 'preflight') {
      const counts = await snapshotSelectedOperation(withPgClient, row);
      if (!counts) return refusedRecord('counts_unavailable');
      const store = createEmailInboxChannelModeStore({ withPgClient });
      const mode = await store.getChannelMode(row.client_id, 'email');
      const out = freeze({
        ok: true,
        ...counts,
        luna_on: row.conversation_status === 'open',
        needs_human: row.needs_human === true,
        guest_linked: !!uuid(row.guest_id),
        sender_ok: isAuthoritativeSender(row),
        subject_ok: isProofSubject(row.subject),
        sol_enabled: true,
        channel_mode: mode,
        provider_source_message_id: row.provider_source_message_id,
        graph_conversation_id: row.graph_conversation_id,
        conversation_id: row.conversation_id,
        client_id: row.client_id,
        location_id: row.location_id,
        inbound_message_id: row.inbound_message_id,
        provider_mailbox_id: row.provider_mailbox_id,
      });
      return attachPublic(out, snapshotPreflightPublic(out));
    }
    if (kind === 'counts') {
      const counts = await snapshotSelectedOperation(withPgClient, row);
      if (!counts) return refusedRecord('counts_unavailable');
      return attachPublic(freeze({ ok: true, ...counts }), snapshotCountsPublic(counts));
    }
    if (kind === 'evidence') {
      const loaded = await loadSelectedOperationEvidence(withPgClient, row, envOwn(env, ENV_HMAC_SECRET));
      const sanitized = sanitizeReplicaEvidenceSnapshot(loaded, envOwn(env, ENV_HMAC_SECRET));
      return attachPublic(sanitized, evidencePublic(sanitized));
    }
    if (kind === 'mode') {
      const store = createEmailInboxChannelModeStore({ withPgClient });
      const mode = await store.getChannelMode(row.client_id, 'email');
      const out = freeze({ ok: true, channel_mode: mode });
      return attachPublic(out, snapshotModePublic(out));
    }
    if (kind === 'dispatch' || kind === 'reconcile') {
      const receiptPath = (input && input.dispatchReceiptPath) || INNER_DISPATCH_RECEIPT_PATH;
      const receipt = readDispatchReceipt(receiptPath);
      const alive = receipt ? receipt.process_alive === true : false;
      const counts = await snapshotSelectedOperation(withPgClient, row);
      if (!counts) {
        return refusedRecord('counts_unavailable', {
          public: freeze({
            ok: false,
            reason: 'counts_unavailable',
            process_alive: alive,
            dispatch_status: receipt ? receipt.status : null,
            approvals: 0,
            journals: 0,
            provider_sends: 0,
          }),
        });
      }
      const out = freeze({
        ok: true,
        snapshot: 'reconcile',
        ...counts,
        process_alive: alive,
        dispatch_status: receipt ? receipt.status : null,
      });
      return attachPublic(out, snapshotReconcilePublic(out));
    }
    return refusedRecord('snapshot_unproven');
  } finally {
    if (pg && typeof pg.closePgPool === 'function') await pg.closePgPool();
  }
}

async function runInnerChannelModePut(input) {
  const env = (input && input.env) || process.env;
  const value = envOwn(env, INNER_MODE_CHANNEL_PUT) || (input && input.channelModePut);
  if (value !== 'auto' && value !== 'off') return refusedRecord('channel_mode_unproven');
  const injected = input && typeof input.withPgClient === 'function';
  let pg = null;
  let withPgClient;
  if (injected) {
    withPgClient = input.withPgClient;
  } else {
    try {
      pg = createProductionStaffPgAdapter();
      withPgClient = pg.withPgClient;
    } catch {
      return refusedRecord('pg_adapter_unwired');
    }
  }
  try {
    const loaded = await withPgClient((client) => client.query(SQL_SELECT_PROOF_THREAD, [PROOF_SENDER]));
    const selected = selectProofThread(loaded && loaded.rows);
    if (!selected.ok) return refusedRecord(selected.reason);
    const store = createEmailInboxChannelModeStore({ withPgClient });
    await store.putChannelMode(selected.row.client_id, 'email', value);
    const mode = await store.getChannelMode(selected.row.client_id, 'email');
    if (mode !== value) return refusedRecord('channel_mode_unproven');
    const out = freeze({ ok: true, channel_mode: mode });
    return attachPublic(out, snapshotModePublic(out));
  } finally {
    if (pg && typeof pg.closePgPool === 'function') await pg.closePgPool();
  }
}

function createProductionStaffMailboxTokenLoan(deps) {
  try {
    const env = deps && deps.env;
    const client = deps && deps.client;
    if (envOwn(env, 'LUNA_DEPLOYMENT') !== SUNSET_DEPLOYMENT) return null;
    const appId = envOwn(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (typeof appId !== 'string' || !UUID.test(appId)) return null;
    if (!client || typeof client.query !== 'function') return null;
    if (typeof client.connect === 'function'
        && (typeof client.totalCount === 'number' || typeof client.idleCount === 'number')) {
      return null;
    }
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(env);
    if (!composition || composition.ok !== true || !composition.provider) return null;
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) return null;
    const httpsImpl = (deps && deps.https) || require('node:https');
    const timers = (deps && deps.timers) || { setTimeout, clearTimeout };
    const tokenTransport = createMicrosoftTokenHttpTransport(freeze({
      httpsImpl,
      timers,
    }));
    return createDelegatedGrantAccessSession(freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId: appId.toLowerCase(),
      client,
      envelopeProvider: prov.value,
      secretProvider: createSunsetMicrosoftOAuthClientSecretProvider(freeze({
        deployment: SUNSET_DEPLOYMENT,
        env,
      })),
      transport: tokenTransport,
      workerId: GRAPH_VERIFY_WORKER_ID,
    }));
  } catch {
    return null;
  }
}

async function runInnerGraphVerify(input) {
  const env = (input && input.env) || process.env;
  if (envOwn(env, INNER_MODE_GRAPH_VERIFY) !== '1') {
    return graphInnerResult({
      ok: false,
      reason: 'graph_adapter_unwired',
      adapter_available: false,
      readonly: false,
    });
  }
  const replicaBits = {
    token_present: false,
    https_present: false,
    request_built: false,
  };
  const injectedLoan = input && input.tokenLoan
    && typeof input.tokenLoan.runWithAccessTokenOnce === 'function'
    ? input.tokenLoan
    : null;
  const httpsImpl = (input && input.https) || require('node:https');
  const injected = input && typeof input.withPgClient === 'function';
  let pg = null;
  let withPgClient;
  if (injected) {
    withPgClient = input.withPgClient;
  } else {
    try {
      pg = createProductionStaffPgAdapter();
      withPgClient = pg.withPgClient;
    } catch {
      return graphInnerResult({
        ok: false,
        reason: 'graph_adapter_unwired',
        adapter_available: false,
        readonly: false,
      }, replicaBits);
    }
  }
  let observedStage = null;
  let classified = null;
  const remember = (result) => {
    classified = graphInnerResult(result, replicaBits);
    return classified;
  };
  const closePool = async () => {
    const closer = (input && typeof input.closePgPool === 'function')
      ? input.closePgPool
      : (pg && typeof pg.closePgPool === 'function' ? () => pg.closePgPool() : null);
    if (typeof closer !== 'function') return;
    try {
      await closer();
    } catch {
      // Pool teardown must never mask a classified Graph result.
    }
  };
  try {
    const inner = await withPgClient(async (client) => {
      const loaded = await client.query(SQL_SELECT_PROOF_THREAD, [PROOF_SENDER]);
      const selected = selectProofThread(loaded && loaded.rows);
      if (!selected.ok) {
        return remember({
          ok: false,
          reason: selected.reason,
          adapter_available: false,
          readonly: false,
        });
      }
      const row = selected.row;
      const clientId = uuid(row.client_id);
      const endpointId = uuid(row.endpoint_id);
      if (!clientId || !endpointId) {
        return remember({
          ok: false,
          reason: 'graph_adapter_unwired',
          adapter_available: false,
          readonly: false,
        });
      }
      const session = injectedLoan || createProductionStaffMailboxTokenLoan({
        env,
        client,
        https: httpsImpl,
        timers: (input && input.timers) || { setTimeout, clearTimeout },
      });
      if (!session || typeof session.runWithAccessTokenOnce !== 'function') {
        return remember({
          ok: false,
          reason: 'graph_adapter_unwired',
          adapter_available: false,
          readonly: false,
        });
      }
      bindTrustedDelegatedGrantAccessSessionInternalStageObserver(session, (note) => {
        const stage = closedGraphGrantStage(note && note.stage);
        if (stage) observedStage = stage;
      });
      const scopedPg = async (fn) => fn(client);
      let evidence = null;
      try {
        evidence = await loadSelectedOperationEvidence(scopedPg, row, null);
      } catch {
        evidence = null;
      }
      const graphTimers = (input && input.timers) || { setTimeout, clearTimeout };
      let sessionOut;
      let sessionThrown = null;
      try {
        sessionOut = await session.runWithAccessTokenOnce(
          freeze({ clientId, endpointId }),
          async (loan) => {
            const token = loan && typeof loan.accessToken === 'string' ? loan.accessToken : '';
            replicaBits.token_present = token !== '';
            if (!token) {
              return closedGraphListFailure('graph_adapter_unwired');
            }
            const request = buildReadonlyGraphListRequest({
              provider_mailbox_id: row.provider_mailbox_id,
              graph_conversation_id: row.graph_conversation_id,
              forbid_send: true,
              forbid_body: true,
              select: GRAPH_LIST_SELECT.slice(),
            });
            replicaBits.request_built = !!(request && request.method === 'GET');
            if (!request || request.method !== 'GET') {
              return closedGraphListFailure('graph_send_forbidden');
            }
            replicaBits.https_present = !!(httpsImpl && typeof httpsImpl.request === 'function');
            try {
              const raw = await httpsGraphGet(httpsImpl, token, request, graphTimers);
              const parsed = parseGraphListMessages(raw);
              if (!parsed || parsed.ok !== true) {
                if (parsed && parsed.reason === 'graph_body_leaked') {
                  return freeze({ ok: false, reason: 'graph_body_leaked' });
                }
                return closedGraphListFailure('graph_unproven');
              }
              return parsed;
            } catch (err) {
              const msg = err && typeof err.message === 'string' ? err.message : '';
              if (msg === 'graph_send_forbidden') return closedGraphListFailure('graph_send_forbidden');
              if (msg === 'graph_adapter_unwired') return closedGraphListFailure('graph_adapter_unwired');
              if (msg === 'graph_auth_unproven') return closedGraphListFailure('graph_auth_unproven');
              return closedGraphListFailure('graph_unproven');
            }
          },
        );
      } catch (err) {
        sessionThrown = err;
      }
      if (sessionThrown || !sessionOut || sessionOut.ok !== true) {
        return remember(classifyTrustedGraphGrantFailure({
          target: sessionThrown || sessionOut,
          result: sessionOut,
          observedStage,
        }));
      }
      const listed = sessionOut.value;
      if (listed && listed.reason === 'graph_body_leaked') {
        return remember({
          ok: false,
          reason: 'graph_body_leaked',
          adapter_available: true,
          readonly: true,
        });
      }
      if (listed && listed.ok === false && listed.reason === 'graph_adapter_unwired') {
        return remember({
          ok: false,
          reason: 'graph_adapter_unwired',
          adapter_available: false,
          readonly: false,
        });
      }
      if (listed && listed.ok === false && listed.reason === 'graph_send_forbidden') {
        return remember({
          ok: false,
          reason: 'graph_send_forbidden',
          adapter_available: false,
          readonly: false,
        });
      }
      if (listed && listed.ok === false && listed.reason === 'graph_auth_unproven') {
        return remember({
          ok: false,
          reason: 'graph_auth_unproven',
          adapter_available: true,
          readonly: true,
          arrivals: 0,
          duplicates: 0,
          threaded: false,
        });
      }
      if (!listed || listed.ok !== true || !Array.isArray(listed.messages)) {
        return remember({
          ok: false,
          reason: 'graph_unproven',
          adapter_available: true,
          readonly: true,
          arrivals: 0,
          duplicates: 0,
          threaded: false,
        });
      }
      const arrival = classifyGraphArrival(listed.messages, {
        graph_conversation_id: row.graph_conversation_id,
        provider_source_message_id: row.provider_source_message_id,
        inbound_internet_message_id: row.inbound_internet_message_id,
        immutable_draft_id: evidence && evidence.immutable_draft_id,
        provider_mailbox_id: row.provider_mailbox_id,
      });
      return remember({
        ...arrival,
        adapter_available: true,
        readonly: true,
      });
    });
    if (classified) return classified;
    if (inner && typeof inner === 'object') return remember(inner);
    return remember({
      ok: false,
      reason: 'graph_adapter_unwired',
      adapter_available: false,
      readonly: false,
    });
  } catch (err) {
    if (classified) return classified;
    return remember(classifyTrustedGraphGrantFailure({
      target: err,
      observedStage,
    }));
  } finally {
    await closePool();
  }
}

function createProductionMailMvp004Supervisor(options) {
  const env = (options && options.env) || process.env;
  const azBin = (options && options.azBin) || envOwn(env, 'AZ') || AZ_DEFAULT;
  const azRun = typeof (options && options.azRun) === 'function'
    ? options.azRun
    : (args) => spawnAz(azBin, args, { env });
  const nonceStore = options && options.nonceStore
    ? wrapNonceStore(options.nonceStore)
    : createDurableNonceStore(options && options.nonceStorePath);
  let pgAdapter;
  try {
    pgAdapter = isProductionPgAdapter(options && options.withPgClient)
      ? { withPgClient: options.withPgClient }
      : createProductionStaffPgAdapter({ pgConnect: options && options.pgConnect });
  } catch {
    async function unwiredPg() {
      const err = new Error('pg_adapter_unwired');
      err.reason = 'pg_adapter_unwired';
      throw err;
    }
    pgAdapter = { withPgClient: unwiredPg };
  }
  const withPgClient = pgAdapter.withPgClient;
  const sleep = options && options.sleep;
  const now = options && options.now;

  async function readServing() {
    return readProductionServingIdentity(azRun);
  }

  function innerExecTimeoutMs(extra) {
    if (extra && (extra.snapshot || extra.killSwitchProbe === true || extra.graphVerify === true
        || extra.reconcileOnly === true || extra.channelModePut === 'auto' || extra.channelModePut === 'off')) {
      return SNAPSHOT_EXEC_TIMEOUT_MS;
    }
    return STAFF_OWNER_EXEC_TIMEOUT_MS;
  }

  async function execInner(extra) {
    const serving = await readServing();
    const azArgs = buildStaffOwnerExecAzArgs({
      attemptId: extra && extra.attemptId,
      replica: serving && serving.replica,
      revision: serving && serving.revision,
      capability: extra && extra.capability,
      imageTag: serving && serving.imageTag,
      digest: serving && serving.digest,
      reconcileOnly: extra && extra.reconcileOnly === true,
      killSwitchProbe: extra && extra.killSwitchProbe === true,
      graphVerify: extra && extra.graphVerify === true,
      snapshot: extra && extra.snapshot,
      channelModePut: extra && extra.channelModePut,
    });
    if (!azArgs) return null;
    async function runOnce() {
      let execResult;
      try {
        const spec = wrapPtyAzExec(azBin, azArgs);
        execResult = spawnPtyHarness(spec, { env, timeoutMs: innerExecTimeoutMs(extra) });
      } catch (error) {
        if (!error || error.message !== 'pty_required') throw error;
        execResult = await azRun(azArgs);
      }
      return classifyStaffOwnerExecResult(execResult);
    }
    return runReplicaInnerExecWith429Retry(runOnce, extra, sleep);
  }

  async function verifyGraphArrival() {
    const executed = await execInner({ graphVerify: true });
    return parseExactProductionGraphInnerExec(executed);
  }

  const supervisor = createMailMvp004LiveProof({
    nonceStore,
    now,
    requireProductionOwner: options && options.requireProductionOwner,
    readServingIdentity: readServing,
    async waitServingHealthy(input) {
      const authorized = input && input.authorized;
      if (!authorized) return null;
      return waitServingHealthy(azRun, {
        enabled: input && input.enabled === true,
        authorized,
        sleep,
        now,
        azBin,
        env,
      });
    },
    async setEmergencyFlags(enabled) {
      const args = buildSetEnvArgs(enabled);
      const result = await azRun(args);
      if (!result || result.status !== 0) throw new Error('flag_update_failed');
    },
    async putEmailChannelMode(value) {
      if (value !== 'auto' && value !== 'off') throw new Error('channel_mode_unproven');
      const executed = await execInner({ channelModePut: value });
      if (!executed || executed.status !== 0 || executed.transportFailed === true
          || !executed.inner || executed.inner.ok !== true
          || executed.inner.channel_mode !== value) {
        throw new Error('channel_mode_unproven');
      }
    },
    async getEmailChannelMode() {
      const executed = await execInner({ snapshot: 'mode' });
      if (!executed || executed.status !== 0 || executed.transportFailed === true
          || !executed.inner || executed.inner.ok !== true) {
        return null;
      }
      return executed.inner.channel_mode;
    },
    async preflightSelectedOperation() {
      const executed = await execInner({ snapshot: 'preflight' });
      if (!executed || executed.status !== 0 || executed.transportFailed === true
          || !executed.inner || executed.inner.ok !== true) {
        return {
          ok: false,
          reason: (executed && executed.inner && executed.inner.reason) || 'preflight_failed',
        };
      }
      return executed.inner;
    },
    invokeAutoOwner: brandProductionAutoOwner(async (input) => {
      const serving = await readServing();
      const capability = input && input.capability;
      const revision = (input && input.revision) || serving.revision;
      const replica = (input && input.replica) || serving.replica;
      const azArgs = buildStaffOwnerExecAzArgs({
        attemptId: capability && capability.nonce,
        replica,
        revision,
        capability,
        imageTag: serving.imageTag,
        digest: serving.digest,
        reconcileOnly: false,
      });
      if (!azArgs) return failRecord('staff_exec_failed');
      const spec = wrapPtyAzExec(azBin, azArgs);
      let execResult;
      try {
        execResult = spawnPtyHarness(spec, { env, timeoutMs: STAFF_OWNER_EXEC_TIMEOUT_MS });
      } catch (error) {
        if (!error || error.message !== 'pty_required') throw error;
        execResult = await azRun(azArgs);
      }
      const classified = classifyStaffOwnerExecResult(execResult);
      if (classified.inner) {
        return freeze({ ...classified.inner, dispatch_marked: classified.marked === true });
      }
      if (classified.marked) {
        return freeze({
          status: 'failed',
          indeterminate: true,
          outcome_unknown: true,
          dispatch_marked: true,
          reason: 'indeterminate_no_retry',
        });
      }
      return freeze({ status: 'failed', reason: 'staff_exec_failed' });
    }),
    async snapshotOperation() {
      const executed = await execInner({ snapshot: 'counts' });
      if (!executed || executed.status !== 0 || executed.transportFailed === true
          || !executed.inner || executed.inner.ok !== true) {
        return null;
      }
      const inner = executed.inner;
      if (![inner.approvals, inner.journals, inner.provider_sends, inner.bookings]
          .every((n) => Number.isSafeInteger(n))) {
        return null;
      }
      return freeze({
        approvals: inner.approvals,
        journals: inner.journals,
        provider_sends: inner.provider_sends,
        bookings: inner.bookings,
      });
    },
    async readDurableEvidence() {
      const executed = await execInner({ snapshot: 'evidence' });
      if (!executed || !executed.inner || typeof executed.inner !== 'object') {
        return freeze({
          ok: false,
          reason: 'snapshot_unproven',
          hmac_available: false,
          evidence_verified: false,
          leftover: false,
        });
      }
      return executed.inner;
    },
    verifyGraphArrival,
    async verifyKillSwitch() {
      const executed = await execInner({ killSwitchProbe: true });
      if (!executed || executed.status !== 0 || executed.transportFailed === true || !executed.inner
          || executed.inner.ok !== true
          || executed.inner.status !== 'blocked'
          || executed.inner.reason !== 'emergency_flags_off') {
        return freeze({
          ok: false,
          reason: 'kill_switch_unproven',
          author_called: false,
          journal_called: false,
          provider_called: false,
        });
      }
      if (executed.inner.author_called === true
          || executed.inner.journal_called === true
          || executed.inner.provider_called === true) {
        return freeze({
          ok: false,
          reason: 'kill_switch_side_effect',
          author_called: executed.inner.author_called === true,
          journal_called: executed.inner.journal_called === true,
          provider_called: executed.inner.provider_called === true,
        });
      }
      return executed.inner;
    },
    async reconcile(input) {
      if (typeof (options && options.reconcile) === 'function') {
        return options.reconcile(input);
      }
      if (input && input.retryForbidden !== true) {
        return freeze({ status: 'failed', indeterminate: true, reason: 'indeterminate_no_retry' });
      }
      const wait = typeof sleep === 'function'
        ? sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + STAFF_OWNER_COMPLETION_WAIT_MS;
      let last = null;
      for (;;) {
        const executed = await execInner({ snapshot: 'reconcile' });
        const inner = executed && executed.inner;
        last = classifyReconcileSnapshot(inner, { marked: true });
        if (last.process_alive === true && Date.now() < deadline) {
          await wait(REVISION_WAIT_INTERVAL_MS);
          continue;
        }
        return freeze({ ...last, retry: false });
      }
    },
  });
  const exposed = freeze({
    ...supervisor,
    verifyGraphArrival,
  });
  PRODUCTION_SUPERVISORS.add(exposed);
  return exposed;
}

function inspectRepoReadiness(root, execGit) {
  const repo = root || path.join(__dirname, '..', '..');
  const git = typeof execGit === 'function'
    ? execGit
    : (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const master = git(['rev-parse', 'origin/master']);
  const headSha = sha40(String(head && head.stdout || '').trim());
  const masterSha = sha40(String(master && master.stdout || '').trim());
  let artifactsOnMaster = true;
  for (const rel of REQUIRED_PROOF_FILES) {
    const listed = git(['cat-file', '-e', `origin/master:${rel}`]);
    const status = listed && Number.isSafeInteger(listed.status) ? listed.status : 1;
    if (status !== 0) {
      artifactsOnMaster = false;
      break;
    }
  }
  const onMaster = Boolean(headSha && masterSha && headSha === masterSha);
  return freeze({
    headSha,
    originMasterSha: masterSha,
    artifactsOnMaster: artifactsOnMaster === true,
    artifactsInImage: false,
    treeHasProofFiles: artifactsOnMaster === true,
    filesPresent: artifactsOnMaster === true,
    onMaster,
    inspectedFrom: 'origin/master',
    copied_script_boolean_trusted: false,
  });
}

async function runCli(argv, options) {
  const env = (options && options.env) || process.env;
  if (envOwn(env, INNER_MODE_KILL_SWITCH) === '1') {
    return withInnerPublic(await runKillSwitchProbe({ ...options, env }));
  }
  if (envOwn(env, INNER_MODE_SNAPSHOT)) {
    return withInnerPublic(await runInnerSnapshot({ ...options, env }));
  }
  if (envOwn(env, INNER_MODE_GRAPH_VERIFY) === '1') {
    try {
      return withInnerPublic(await runInnerGraphVerify({ ...options, env }));
    } catch (err) {
      return graphInnerResult(classifyTrustedGraphGrantFailure({ target: err }), {
        token_present: false,
        https_present: false,
        request_built: false,
      });
    }
  }
  if (envOwn(env, INNER_MODE_CHANNEL_PUT) === 'auto' || envOwn(env, INNER_MODE_CHANNEL_PUT) === 'off') {
    return withInnerPublic(await runInnerChannelModePut({ ...options, env }));
  }
  if (envOwn(env, 'MAIL_MVP_004_STAFF_OWNER_PROOF') === '1'
      || envOwn(env, 'MAIL_MVP_004_RECONCILE_ONLY') === '1') {
    if (envOwn(env, 'MAIL_MVP_004_RECONCILE_ONLY') === '1') {
      return withInnerPublic(await runStaffOwnerProof({ ...options, env, reconcileOnly: true }));
    }
    return withInnerPublic(await runStaffOwnerProof({ ...options, env }));
  }
  if (refusedProduction(env)) return refusedRecord('production_refused');
  const parsed = parseArgs(argv);
  if (!parsed.command) return refusedRecord(parsed.invalidReason || 'default_refuse');
  if (parsed.command === PREFLIGHT_COMMAND) {
    const pin = validatePreflightInvocation(parsed);
    if (pin) return refusedRecord(pin);
    const repo = inspectRepoReadiness(options && options.root, options && options.execGit);
    const serving = options && options.serving;
    const readiness = evaluateLiveProofReadiness({
      serving: serving || { imageTag: parsed.imageTag, imageRepository: IMAGE_REPOSITORY },
      originMasterSha: repo.originMasterSha,
      headSha: repo.headSha,
      artifactsOnMaster: repo.artifactsOnMaster === true,
      artifactsInImage: repo.artifactsInImage === true,
      treeHasProofFiles: repo.treeHasProofFiles === true,
    });
    return freeze({
      ok: false,
      status: 'preflight_ok',
      reason: readiness.can_proceed === true ? null : (readiness.blocked_reasons[0] || 'exact_master_image_required'),
      live_proof_blocked: readiness.can_proceed !== true,
      readiness,
      public: freeze({
        ok: false,
        status: 'preflight_ok',
        live_proof_blocked: readiness.can_proceed !== true,
        blocked_reasons: readiness.blocked_reasons,
        command: PREFLIGHT_COMMAND,
        proof_version: PROOF_VERSION,
      }),
    });
  }
  if (typeof (options && options.executeOnce) === 'function') {
    return options.executeOnce({ parsed, env, argv, nowMs: options.nowMs });
  }
  if (options && options.harness) {
    return options.harness.executeOnce({
      parsed,
      env,
      argv,
      nowMs: options.nowMs,
      originMasterSha: options.originMasterSha,
      headSha: options.headSha,
      artifactsOnMaster: options.artifactsOnMaster,
      artifactsInImage: options.artifactsInImage,
      treeHasProofFiles: options.treeHasProofFiles,
      requireLiveImage: options.requireLiveImage,
    });
  }
  const repo = inspectRepoReadiness(options && options.root, options && options.execGit);
  const supervisor = options && options.supervisor
    ? options.supervisor
    : createProductionMailMvp004Supervisor({
      env,
      azBin: options && options.azBin,
      azRun: options && options.azRun,
      nonceStore: options && options.nonceStore,
      nonceStorePath: options && options.nonceStorePath,
      sleep: options && options.sleep,
      now: options && options.now,
      pgConnect: options && options.pgConnect,
    });
  const serving = typeof supervisor.readServingIdentity === 'function'
    ? null
    : (options && options.serving);
  const readiness = evaluateLiveProofReadiness({
    serving: serving || options.serving || { imageTag: parsed.imageTag, imageRepository: IMAGE_REPOSITORY },
    originMasterSha: repo.originMasterSha,
    headSha: repo.headSha,
    artifactsOnMaster: repo.artifactsOnMaster === true,
    artifactsInImage: repo.artifactsInImage === true,
    treeHasProofFiles: repo.treeHasProofFiles === true,
  });
  const authFail = validateExactInvocation(parsed, options && options.nowMs, options && options.nonceStore);
  if (authFail) return refusedRecord(authFail);
  return supervisor.executeOnce({
    parsed,
    env,
    argv,
    nowMs: options && options.nowMs,
    originMasterSha: repo.originMasterSha,
    headSha: repo.headSha,
    artifactsOnMaster: repo.artifactsOnMaster === true,
    artifactsInImage: repo.artifactsInImage === true,
    treeHasProofFiles: repo.treeHasProofFiles === true,
    requireLiveImage: options && options.requireLiveImage,
  });
}

module.exports = freeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  PREFLIGHT_COMMAND,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  EXPECTED_DATABASE,
  RG,
  STAFF_APP,
  EMAIL_LUNA_APP,
  ACR_REGISTRY,
  ACR_REPOSITORY,
  IMAGE_REPOSITORY,
  PROOF_SUBJECT,
  PROOF_SENDER,
  LIVE_IMAGE_REQUIREMENT,
  REQUIRED_PROOF_FILES,
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
  EMAIL_INBOX_CHANNEL_MODE_DEFAULT,
  ALLOWED_FLAG_KEYS,
  MUTATION_ISSUED_MARKER,
  PROOF_REMOTE_NODE,
  AZ_DEFAULT,
  PTY_BIN,
  CAPABILITY_PURPOSE,
  OPERATION_BINDING,
  INNER_DISPATCH_RECEIPT_PATH,
  STAFF_OWNER_EXEC_TIMEOUT_MS,
  STAFF_OWNER_COMPLETION_WAIT_MS,
  SNAPSHOT_EXEC_TIMEOUT_MS,
  CONFIRM_WINDOW_MS,
  REVISION_WAIT_TIMEOUT_MS,
  REVISION_WAIT_INTERVAL_MS,
  FLAGS_SOURCE_TEMPLATE,
  FLAGS_SOURCE_REPLICA_PROCESS,
  FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
  REPLICA_ATTEST_COOLDOWN_MS,
  REPLICA_ATTEST_RETRY_AFTER_MAX_S,
  REPLICA_ATTEST_RETRY_AFTER_SLACK_MS,
  REPLICA_ATTEST_RETRY_AFTER_WAIT_MS,
  SQL_SELECT_PROOF_THREAD,
  SQL_COUNT_OPERATION_APPROVALS,
  SQL_COUNT_OPERATION_JOURNAL,
  SQL_COUNT_BOOKINGS,
  SQL_LOAD_OPERATION_EVIDENCE,
  parseArgs,
  validateExactInvocation,
  validatePreflightInvocation,
  refusedRecord,
  publicProofOutput,
  redactSensitive,
  normalizeProofSubject,
  isProofSubject,
  isAuthoritativeSender,
  isLeftoverGenericDraft,
  leftoverFromDurableEvidence,
  isProduction003SentShape,
  exactReconciledCounts,
  duplicateUnreconciled,
  evaluateLiveProofReadiness,
  inspectRepoReadiness,
  parseServingIdentity,
  parseRevisionShow,
  parseRunningReplica,
  parseReplicaProcessEnv,
  parseExplicitTrafficWeight,
  traffic100RevisionName,
  mergeRevisionIntoServing,
  servingHealthyReady100,
  servingIdentityCompatible,
  servingSuccessorAcceptable,
  flagsLiteral,
  acceptedFlagSource,
  parseRevisionTemplateEnv,
  proveAcaImmutableRevisionEnv,
  approvedFlagsOnly,
  approvedReplicaFlagsExact,
  extractAzureJson,
  parseAcrManifestDigest,
  resolveBoundAcrDigest,
  readProductionServingIdentity,
  waitServingHealthy,
  attestReplicaProcessEnv,
  parseTrustedReplicaAttestRetryAfterMs,
  replicaAttestBackoffMs,
  replicaAttestScopeKey,
  replicaAttestMatchesCurrent,
  buildSetEnvArgs,
  buildShowAppArgs,
  buildRevisionShowArgs,
  buildReplicaListArgs,
  buildAcrManifestDigestArgs,
  buildReplicaEnvExecAzArgs,
  buildReplicaEnvRemoteCommand,
  isLegalReplicaEnvRemoteCommand,
  buildReadonlyGraphListRequest,
  GRAPH_LIST_SELECT,
  GRAPH_PREFER_IMMUTABLE_ID,
  GRAPH_GET_DEADLINE_MS,
  buildStaffOwnerRemoteCommand,
  buildStaffOwnerExecAzArgs,
  encodeProofEnvPayload,
  isLegalStaffOwnerRemoteCommand,
  wrapPtyAzExec,
  spawnPtyHarness,
  classifyStaffOwnerExecResult,
  replicaInnerExecRetryable,
  replicaInnerExecTrusted429,
  runReplicaInnerExecWith429Retry,
  parseExactProductionGraphInnerExec,
  extractExactlyOneProofJson,
  closedGraphInnerDto,
  graphInnerExecStdoutOk,
  remoteExecTransportFailed,
  snapshotSolMarker,
  snapshotTrustedProvenance,
  mintSelectedOperationSolEvidence,
  verifySelectedOperationSolEvidence,
  brandProductionAutoOwner,
  isProductionAutoOwner,
  createProductionStaffAutoCreateSendOwner,
  createMailMvp004LiveProof,
  createProductionMailMvp004Supervisor,
  createProductionGraphArrivalVerifier,
  createProductionReadonlyGraphListAdapter,
  createProductionStaffPgAdapter,
  isProductionPgAdapter,
  createCanonical003KillSwitch,
  classifyGraphArrival,
  extractProofJson,
  createDurableNonceStore,
  runKillSwitchProbe,
  runInnerSnapshot,
  runInnerChannelModePut,
  runInnerGraphVerify,
  GRAPH_GRANT_STAGE_REASON,
  classifyTrustedGraphGrantFailure,
  sanitizeGraphPublic,
  createProductionStaffMailboxTokenLoan,
  sanitizeReplicaEvidenceSnapshot,
  replicaLeftover,
  replicaSolProven,
  issueSupervisorCapability,
  verifySupervisorCapability,
  encodeCapability,
  consumeInnerCapability,
  dispatchProcessAlive,
  ignoreRemoteExecHangup,
  readDispatchReceipt,
  writeDispatchReceipt,
  replaceProvenNoSendDispatchMarker,
  classifyReconcileSnapshot,
  createEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
  selectProofThread,
  snapshotSelectedOperation,
  loadSelectedOperationEvidence,
  runStaffOwnerProof,
  runCli,
});
