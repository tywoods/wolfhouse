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
const IMAGE_REPOSITORY = 'whstagingacr.azurecr.io/luna-sunset-staff-api';
const PROOF_SUBJECT = 'Testing 8 26';
const PROOF_SENDER = 'twoods@xantrion.com';
const AZ_DEFAULT = '/opt/data/home/.local/bin/az';
const PTY_BIN = '/usr/bin/script';
const PROOF_REMOTE_ENV_PATH = '/tmp/mail-mvp-004-proof.env';
const PROOF_REMOTE_NODE = 'scripts/prove-mail-mvp-004-auto-create-send.js';
const MUTATION_ISSUED_MARKER = 'MAIL_MVP_004_MUTATION_ISSUED';
const OPERATOR_NONCE_RE = /^[0-9a-f]{64}$/;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_FUTURE_SKEW_MS = 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_AZ_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const SAFE_B64 = /^[A-Za-z0-9+/]+=*$/;
const USED_OPERATOR_NONCES = new Set();
const PRODUCTION_AUTO_OWNERS = new WeakSet();
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

const SQL_COUNT_BOOKINGS = 'SELECT count(*)::int AS n FROM bookings WHERE client_id=$1::uuid';

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

function publicProofOutput(result) {
  if (!result || result.ok !== true) {
    const pub = result && result.public ? result.public : null;
    if (pub && typeof pub === 'object') {
      const copy = { ...pub };
      delete copy.conversation_id;
      delete copy.draft_text;
      delete copy.message_text;
      delete copy.sender_address;
      return freeze(copy);
    }
    return freeze({
      ok: false,
      reason: result && result.reason ? String(result.reason) : 'proof_failed',
      live_proof_blocked: true,
    });
  }
  return result.public || freeze({ ok: true, status: 'sent' });
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
  if (input && input.copiedScript === true) blocked.push('copied_script_is_not_proof');
  if (headSha && masterSha && headSha !== masterSha) blocked.push('head_not_origin_master');
  if (input && input.treeHasProofFiles !== true) blocked.push('proof_files_not_on_master');
  if (!imageTag || !masterSha || imageTag !== masterSha) blocked.push('exact_master_image_required');
  if (serving && serving.imageRepository && serving.imageRepository !== IMAGE_REPOSITORY) {
    blocked.push('wrong_image_repository');
  }
  return freeze({
    ok: blocked.length === 0,
    can_proceed: blocked.length === 0,
    blocked_reasons: freeze(blocked),
    requirement: LIVE_IMAGE_REQUIREMENT,
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

function parseServingIdentity(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || isProxy(parsed)) return null;
  const name = ownData(parsed, 'name') || parsed.name;
  if (name && name !== STAFF_APP) return null;
  const props = ownData(parsed, 'properties') || parsed.properties || parsed;
  const revision = ownData(props, 'latestRevisionName') || ownData(props, 'latestRevisionFqdn')
    || props.latestRevisionName || (parsed.revision);
  const template = ownData(props, 'template') || props.template || {};
  const containers = ownData(template, 'containers') || template.containers;
  const container = Array.isArray(containers) ? containers[0] : null;
  const image = container && (ownData(container, 'image') || container.image);
  const env = container && (ownData(container, 'env') || container.env);
  if (typeof image !== 'string' || !image.startsWith(`${IMAGE_REPOSITORY}:`)) return null;
  const imageTag = image.slice(IMAGE_REPOSITORY.length + 1);
  const digest = (container && (ownData(container, 'imageDigest') || container.imageDigest))
    || ownData(props, 'workloadProfileName') && null
    || (typeof parsed.digest === 'string' ? parsed.digest : null);
  const flags = parseEnvList(env);
  if (typeof revision !== 'string' || !revision.startsWith(STAFF_APP) || !SAFE_AZ_NAME.test(revision)) {
    return null;
  }
  return freeze({
    resourceGroup: RG,
    appName: STAFF_APP,
    revision,
    imageRepository: IMAGE_REPOSITORY,
    imageTag,
    deploySha: sha40(imageTag) || null,
    digest: typeof digest === 'string' && DIGEST_RE.test(digest) ? digest : (parsed.digest || null),
    flags,
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
  const clientId = uuid(row.client_id);
  const conversationId = uuid(row.conversation_id);
  const inboundId = uuid(row.inbound_message_id);
  if (!clientId || !conversationId || !inboundId) return null;
  const [approvals, journal, bookings] = await Promise.all([
    withPgClient((pg) => pg.query(SQL_COUNT_OPERATION_APPROVALS, [clientId, conversationId, inboundId])),
    withPgClient((pg) => pg.query(SQL_COUNT_OPERATION_JOURNAL, [clientId, conversationId, inboundId])),
    withPgClient((pg) => pg.query(SQL_COUNT_BOOKINGS, [clientId])),
  ]);
  const approvalCount = asInt(approvals && approvals.rows && approvals.rows[0]);
  const journalRow = journal && journal.rows && journal.rows[0];
  const journalCount = asInt(journalRow);
  const sendCount = journalRow && Number.isSafeInteger(journalRow.sends)
    ? journalRow.sends
    : (journalRow ? Number.parseInt(journalRow.sends, 10) : null);
  const bookingCount = asInt(bookings && bookings.rows && bookings.rows[0]);
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

function createMailMvp004LiveProof(deps) {
  if (!deps || typeof deps !== 'object') throw new Error('live_proof_misconfigured');
  const nonceStore = deps.nonceStore || USED_OPERATOR_NONCES;

  async function restoreSafe() {
    const errors = [];
    try {
      if (typeof deps.setEmergencyFlags === 'function') await deps.setEmergencyFlags(false);
    } catch (error) {
      errors.push('flags');
    }
    try {
      if (typeof deps.putEmailChannelMode === 'function') await deps.putEmailChannelMode('off');
    } catch {
      errors.push('mode');
    }
    let serving = null;
    try {
      serving = typeof deps.readServingIdentity === 'function'
        ? await deps.readServingIdentity()
        : null;
    } catch {
      errors.push('serving');
    }
    let kill = null;
    try {
      kill = typeof deps.verifyKillSwitch === 'function' ? await deps.verifyKillSwitch() : null;
    } catch {
      errors.push('kill_switch');
    }
    const flagsOff = serving && serving.flags
      && serving.flags[ENV_LUNA_AUTO_SEND_ENABLED] === 'false'
      && serving.flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] === 'false';
    const modeOff = typeof deps.getEmailChannelMode === 'function'
      ? (await deps.getEmailChannelMode()) === 'off'
      : true;
    const killOk = kill && (kill.ok === true || kill.reason === 'emergency_flags_off' || kill.status === 'blocked');
    return freeze({
      ok: errors.length === 0 && flagsOff === true && modeOff === true && killOk === true,
      flags_off: flagsOff === true,
      mode_off: modeOff === true,
      kill_switch: killOk === true,
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
    const authFail = validateExactInvocation(parsed, input && input.nowMs, nonceStore);
    if (authFail) return refusedRecord(authFail);
    nonceStore.add(parsed.operatorNonce);

    const serving = await deps.readServingIdentity();
    if (!serving || serving.appName !== STAFF_APP || serving.resourceGroup !== RG) {
      return refusedRecord('wrong_target');
    }
    if (serving.revision !== parsed.revision) return refusedRecord('revision_mismatch');
    const servingTag = sha40(serving.imageTag) || sha40(serving.deploySha);
    const typedTag = sha40(parsed.imageTag) || sha40(parsed.deploySha);
    if (!servingTag || servingTag !== typedTag) return refusedRecord('image_mismatch');
    if (parsed.digest && serving.digest && serving.digest !== parsed.digest) {
      return refusedRecord('digest_mismatch');
    }

    const readiness = evaluateLiveProofReadiness({
      serving,
      originMasterSha: input && input.originMasterSha,
      headSha: input && input.headSha,
      treeHasProofFiles: input && input.treeHasProofFiles,
      copiedScript: input && input.copiedScript === true,
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

    let invoked = 0;
    let ownerResult = null;
    let after = null;
    let graph = null;
    let restored = null;
    let failedReason = null;
    try {
      await deps.setEmergencyFlags(true);
      await deps.putEmailChannelMode('auto');
      const enabled = await deps.readServingIdentity();
      if (!enabled || (sha40(enabled.imageTag) || sha40(enabled.deploySha)) !== servingTag) {
        failedReason = 'enabled_image_drift';
      } else if (enabled.flags[ENV_LUNA_AUTO_SEND_ENABLED] !== 'true'
          || enabled.flags[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] !== 'true') {
        failedReason = 'enabled_revision_unproven';
      } else if ((await deps.getEmailChannelMode()) !== 'auto') {
        failedReason = 'channel_mode_unproven';
      } else if (!isProductionAutoOwner(deps.invokeAutoOwner)
          && deps.requireProductionOwner !== false) {
        failedReason = 'not_canonical_owner';
      } else {
        ownerResult = await deps.invokeAutoOwner();
        invoked += 1;
        if (invoked !== 1) failedReason = 'owner_not_once';
        if (!failedReason && ownerResult && ownerResult.status === 'skipped'
            && ownerResult.reason === 'already_sent') {
          after = await deps.snapshotOperation();
          if (!after || after.approvals !== 1 || after.journals !== 1 || after.provider_sends !== 1) {
            failedReason = 'duplicate_unreconciled';
          }
        } else if (!failedReason && (!ownerResult || ownerResult.status !== 'sent')) {
          if (ownerResult && ownerResult.indeterminate === true && typeof deps.reconcile === 'function') {
            const rec = await deps.reconcile();
            ownerResult = rec;
            if (!rec || rec.indeterminate === true) failedReason = 'indeterminate_no_retry';
            else if (rec.status !== 'sent' && rec.reason !== 'already_sent') {
              failedReason = rec.reason || 'owner_failed';
            }
          } else {
            failedReason = (ownerResult && ownerResult.reason) || 'owner_failed';
          }
        }
        if (!failedReason && ownerResult && isLeftoverGenericDraft(ownerResult.draft_text)) {
          failedReason = 'leftover_generic_draft';
        }
        if (!failedReason) {
          const marker = snapshotSolMarker(ownerResult && ownerResult.marker)
            || (typeof deps.readSolEvidence === 'function' ? snapshotSolMarker(await deps.readSolEvidence()) : null);
          if (!marker) failedReason = 'sol_unproven';
        }
        if (!failedReason) {
          after = after || await deps.snapshotOperation();
          if (!after || after.approvals !== 1 || after.journals !== 1 || after.provider_sends !== 1) {
            failedReason = 'operation_counts_mismatch';
          }
          if (Number.isSafeInteger(pre.bookings) && after && after.bookings !== pre.bookings) {
            failedReason = 'booking_side_effect';
          }
        }
        if (!failedReason) {
          graph = await deps.verifyGraphArrival(after);
          if (!graph || graph.ok !== true || graph.threaded !== true || graph.arrivals !== 1
              || graph.duplicates !== 0) {
            failedReason = (graph && graph.reason) || 'graph_unproven';
          }
        }
      }
    } catch {
      failedReason = failedReason || 'owner_failed';
    } finally {
      restored = await restoreSafe();
    }

    const restoredOk = restored && restored.ok === true;
    if (failedReason) {
      return failRecord(failedReason, {
        invoked,
        restored: restoredOk,
        status: restoredOk ? 'failed' : 'outcome_unknown',
        kill_switch: restored && restored.kill_switch === true,
        live_proof_blocked: false,
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
      marker: ownerResult && ownerResult.marker,
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
  if (!staffOwnerEnvReady(env)) return refusedRecord('staff_owner_disabled');
  if (!isEmailMicrosoftAutoSendEmergencyEnabled(env)) {
    return refusedRecord('emergency_flags_off');
  }
  const injected = input && typeof input.withPgClient === 'function';
  const pg = injected ? null : require('./pg-connect');
  const withPgClient = injected ? input.withPgClient : pg.withPgClient;
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
    if (input && input.reconcileOnly === true) {
      return freeze({
        ok: false,
        reason: 'reconcile_owner_state',
        reconcile: true,
        invoked: 0,
        public: freeze({
          ok: false,
          reason: 'reconcile_owner_state',
          reconcile: true,
          approvals: before.approvals,
          journals: before.journals,
          provider_sends: before.provider_sends,
        }),
      });
    }
    if (before.approvals > 0 || before.journals > 0 || before.provider_sends > 0) {
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
          approvals: before.approvals,
          journals: before.journals,
          provider_sends: before.provider_sends,
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
    const result = await handle({
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
    const after = await snapshotSelectedOperation(withPgClient, row);
    if (result && result.status === 'skipped' && result.reason === 'already_sent') {
      return freeze({
        ok: true,
        status: 'skipped',
        reason: 'already_sent',
        invoked: 1,
        marker: result.marker,
        draft_text: result.draft_text,
        public: freeze({
          ok: true,
          status: 'skipped',
          reason: 'already_sent',
          invoked: 1,
          duplicate: true,
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
    if (isLeftoverGenericDraft(result.draft_text || result.message_text)) {
      return failRecord('leftover_generic_draft', { invoked: 1 });
    }
    return freeze({
      ok: true,
      status: 'sent',
      reason: null,
      invoked: 1,
      marker: result.marker,
      draft_text: result.draft_text,
      after,
      public: freeze({
        ok: true,
        status: 'sent',
        invoked: 1,
        approvals: after ? after.approvals : result.approvals,
        journals: after ? after.journals : result.journals,
        provider_sends: after ? after.provider_sends : result.provider_sends,
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

function encodeProofEnvPayload(attemptId, reconcileOnly) {
  const attempt = uuid(attemptId) || (typeof attemptId === 'string' && OPERATOR_NONCE_RE.test(attemptId)
    ? attemptId
    : null);
  if (!attempt && attemptId) return null;
  const id = uuid(attemptId) || crypto.randomUUID();
  const lines = [
    'MAIL_MVP_004_LIVE_PROOF=1',
    reconcileOnly === true ? 'MAIL_MVP_004_RECONCILE_ONLY=1' : 'MAIL_MVP_004_STAFF_OWNER_PROOF=1',
    `LUNA_DEPLOYMENT=${SUNSET_DEPLOYMENT}`,
    `MAIL_MVP_004_PROOF_ATTEMPT_ID=${id}`,
  ];
  const b64 = Buffer.from(`${lines.join('\n')}\n`, 'utf8').toString('base64');
  if (!SAFE_B64.test(b64) || b64.length > 4096) return null;
  return b64;
}

function buildStaffOwnerRemoteCommand(attemptId, reconcileOnly) {
  const b64 = encodeProofEnvPayload(attemptId, reconcileOnly);
  if (!b64) return null;
  const issued = reconcileOnly === true ? '' : ` && echo ${MUTATION_ISSUED_MARKER}`;
  return `sh -c 'printf %s ${b64} | base64 -d > ${PROOF_REMOTE_ENV_PATH} && set -a && . ${PROOF_REMOTE_ENV_PATH} && set +a${issued} && exec node ${PROOF_REMOTE_NODE}'`;
}

function wrapPtyAzExec(azBin, azArgs) {
  if (!Array.isArray(azArgs) || azArgs[0] !== 'containerapp' || azArgs[1] !== 'exec') {
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

function inspectRepoReadiness(root, execGit) {
  const repo = root || path.join(__dirname, '..', '..');
  const git = typeof execGit === 'function'
    ? execGit
    : (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const master = git(['rev-parse', 'origin/master']);
  const headSha = sha40(String(head && head.stdout || '').trim());
  const masterSha = sha40(String(master && master.stdout || '').trim());
  let treeHasProofFiles = true;
  for (const rel of REQUIRED_PROOF_FILES) {
    try {
      fs.accessSync(path.join(repo, rel), fs.constants.R_OK);
    } catch {
      treeHasProofFiles = false;
      break;
    }
  }
  const onMaster = Boolean(headSha && masterSha && headSha === masterSha);
  return freeze({
    headSha,
    originMasterSha: masterSha,
    treeHasProofFiles: treeHasProofFiles === true && onMaster === true,
    filesPresent: treeHasProofFiles,
    onMaster,
  });
}

async function runCli(argv, options) {
  const env = (options && options.env) || process.env;
  if (envOwn(env, 'MAIL_MVP_004_STAFF_OWNER_PROOF') === '1'
      || envOwn(env, 'MAIL_MVP_004_RECONCILE_ONLY') === '1') {
    if (envOwn(env, 'MAIL_MVP_004_RECONCILE_ONLY') === '1') {
      return runStaffOwnerProof({ ...options, env, reconcileOnly: true });
    }
    return runStaffOwnerProof({ ...options, env });
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
      treeHasProofFiles: repo.treeHasProofFiles === true,
      copiedScript: false,
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
      treeHasProofFiles: options.treeHasProofFiles,
      requireLiveImage: options.requireLiveImage,
    });
  }
  const repo = inspectRepoReadiness(options && options.root, options && options.execGit);
  const readiness = evaluateLiveProofReadiness({
    serving: options && options.serving,
    originMasterSha: repo.originMasterSha,
    headSha: repo.headSha,
    treeHasProofFiles: repo.treeHasProofFiles === true,
    copiedScript: false,
  });
  const authFail = validateExactInvocation(parsed, options && options.nowMs);
  if (authFail) return refusedRecord(authFail);
  if (readiness.can_proceed !== true) {
    return refusedRecord(readiness.blocked_reasons[0] || 'exact_master_image_required', { readiness });
  }
  return refusedRecord('live_adapters_required');
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
  SQL_SELECT_PROOF_THREAD,
  SQL_COUNT_OPERATION_APPROVALS,
  SQL_COUNT_OPERATION_JOURNAL,
  SQL_COUNT_BOOKINGS,
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
  evaluateLiveProofReadiness,
  inspectRepoReadiness,
  parseServingIdentity,
  buildSetEnvArgs,
  buildShowAppArgs,
  buildStaffOwnerRemoteCommand,
  encodeProofEnvPayload,
  wrapPtyAzExec,
  snapshotSolMarker,
  brandProductionAutoOwner,
  isProductionAutoOwner,
  createProductionStaffAutoCreateSendOwner,
  createMailMvp004LiveProof,
  createEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
  selectProofThread,
  snapshotSelectedOperation,
  runStaffOwnerProof,
  runCli,
});
