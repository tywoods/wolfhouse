#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-004 — offline Sunset auto create-and-send operator proof gate.
 * Fake adapters only. Does not execute live Azure, Graph, or provider send.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const {
  CONFIRMATION_PHRASE,
  COMMAND,
  PREFLIGHT_COMMAND,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  RG,
  STAFF_APP,
  ACR_REGISTRY,
  ACR_REPOSITORY,
  IMAGE_REPOSITORY,
  PROOF_SUBJECT,
  PROOF_SENDER,
  LIVE_IMAGE_REQUIREMENT,
  REQUIRED_PROOF_FILES,
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
  MUTATION_ISSUED_MARKER,
  PROOF_REMOTE_NODE,
  parseArgs,
  validateExactInvocation,
  validatePreflightInvocation,
  refusedRecord,
  redactSensitive,
  publicProofOutput,
  normalizeProofSubject,
  isProofSubject,
  isAuthoritativeSender,
  isLeftoverGenericDraft,
  leftoverFromDurableEvidence,
  isProduction003SentShape,
  exactReconciledCounts,
  duplicateUnreconciled,
  evaluateLiveProofReadiness,
  parseServingIdentity,
  parseRevisionShow,
  parseRunningReplica,
  servingHealthyReady100,
  servingIdentityCompatible,
  servingSuccessorAcceptable,
  flagsLiteral,
  acceptedFlagSource,
  parseRevisionTemplateEnv,
  proveAcaImmutableRevisionEnv,
  approvedFlagsOnly,
  approvedReplicaFlagsExact,
  traffic100RevisionName,
  mergeRevisionIntoServing,
  extractAzureJson,
  parseAcrManifestDigest,
  readProductionServingIdentity,
  waitServingHealthy,
  parseReplicaProcessEnv,
  parseTrustedReplicaAttestRetryAfterMs,
  replicaAttestBackoffMs,
  replicaAttestScopeKey,
  replicaAttestMatchesCurrent,
  buildReadonlyGraphListRequest,
  GRAPH_LIST_SELECT,
  GRAPH_PREFER_IMMUTABLE_ID,
  GRAPH_GET_DEADLINE_MS,
  buildSetEnvArgs,
  buildReplicaEnvExecAzArgs,
  buildReplicaEnvRemoteCommand,
  isLegalReplicaEnvRemoteCommand,
  buildRevisionShowArgs,
  buildAcrManifestDigestArgs,
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
  AZ_DEFAULT,
  PTY_BIN,
  snapshotSolMarker,
  snapshotTrustedProvenance,
  mintSelectedOperationSolEvidence,
  verifySelectedOperationSolEvidence,
  brandProductionAutoOwner,
  isProductionAutoOwner,
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
  issueSupervisorCapability,
  verifySupervisorCapability,
  encodeCapability,
  consumeInnerCapability,
  dispatchProcessAlive,
  ignoreRemoteExecHangup,
  writeOwnerOneshotRequest,
  readOwnerOneshotRequest,
  claimOwnerOneshotRequest,
  startMailMvp004StaffOwnerOneshotListener,
  stopMailMvp004StaffOwnerOneshotListener,
  readDispatchReceipt,
  writeDispatchReceipt,
  replaceProvenNoSendDispatchMarker,
  classifyReconcileSnapshot,
  closedWorkerReason,
  closedOwnerStatus,
  INNER_DISPATCH_RECEIPT_PATH,
  INNER_OWNER_REQUEST_PATH,
  INNER_OWNER_CLAIMED_PATH,
  STAFF_OWNER_EXEC_TIMEOUT_MS,
  STAFF_OWNER_COMPLETION_WAIT_MS,
  STAFF_OWNER_HANDOFF_WAIT_MS,
  RECONCILE_POLL_INTERVAL_MS,
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
  createEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
  selectProofThread,
  snapshotSelectedOperation,
  SQL_COUNT_BOOKINGS,
  runStaffOwnerProof,
  runCli,
  runKillSwitchProbe,
  runInnerSnapshot,
  runInnerChannelModePut,
  runInnerGraphVerify,
  GRAPH_GRANT_STAGE_REASON,
  classifyTrustedGraphGrantFailure,
  sanitizeGraphPublic,
  replicaLeftover,
  replicaSolProven,
} = require('./lib/email-luna-microsoft-auto-create-send-live-proof');
const {
  createDelegatedGrantAccessSession,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
  DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES,
} = require('./lib/email-delegated-grant-access-session');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
} = require('./lib/email-grant-envelope-fake-provider');
const {
  digestGeneratedEmailLunaDraftBody,
} = require('./lib/staff-email-luna-draft-open');
const { ENV_HMAC_SECRET } = require('./lib/email-luna-sunset-email-hermes-sol-activation');

const AUTO_ABS = path.join(ROOT, 'scripts/lib/email-luna-microsoft-auto-create-send.js');
const LIB_ABS = path.join(ROOT, 'scripts/lib/email-luna-microsoft-auto-create-send-live-proof.js');
const CLI_REL = 'scripts/prove-mail-mvp-004-auto-create-send.js';
const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const M = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const GUEST = '99999999-9999-4999-8999-999999999999';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SRC = 'graph-src-auto-004';
const IMAGE_SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const REVISION = `${STAFF_APP}--004-${IMAGE_SHA.slice(0, 8)}`;
const ISSUED = '2026-08-27T12:00:00.000Z';
const NOW_MS = Date.parse(ISSUED);
const SOL = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  runtime: 'sunset-email-luna',
});
const THREAD_DRAFT = 'Thanks for writing about the mailbox. Would you like to make a booking?';
const HMAC_SECRET = 'mvp004-sol-hmac-test-secret';
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
const GRAPH_APP_ID = '12345678-1234-4234-8234-123456789abc';
const GRAPH_OLD_RT = 'rt-old-NEVER_LEAK';
const GRAPH_NEW_RT = 'rt-new-NEVER_LEAK';
const GRAPH_ACCESS = 'at-NEVER_LEAK-access';
const GRAPH_SECRET = 'app-secret-NEVER_LEAK';
const GRAPH_PLANTED = 'planted-NEVER_LEAK-secret';
const PHASE_A_TOKEN_SCOPE = 'openid profile User.Read Mail.ReadWrite Mail.Send';

function nonce() {
  return crypto.randomBytes(32).toString('hex');
}

function flagsOff() {
  return Object.freeze({
    [ENV_LUNA_AUTO_SEND_ENABLED]: 'false',
    [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'false',
  });
}

function flagsOn() {
  return Object.freeze({
    [ENV_LUNA_AUTO_SEND_ENABLED]: 'true',
    [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'true',
  });
}

function serving(patch) {
  return {
    resourceGroup: RG,
    appName: STAFF_APP,
    revision: REVISION,
    imageRepository: IMAGE_REPOSITORY,
    imageTag: IMAGE_SHA,
    deploySha: IMAGE_SHA,
    digest: DIGEST,
    flags: flagsOff(),
    healthState: 'Healthy',
    runningState: 'Running',
    trafficWeight: 100,
    ready: true,
    provisioningState: 'Provisioned',
    flagsSource: 'replica_process',
    replica: `${REVISION}-abcde-fghij`,
    unrelatedEnvFingerprint: '[]',
    ...patch,
  };
}

function mintEvidence(messageText) {
  return mintSelectedOperationSolEvidence({
    authority: {
      client_id: C,
      location_id: L,
      conversation_id: V,
      inbound_message_id: M,
    },
    bodySha256: digestGeneratedEmailLunaDraftBody(messageText || THREAD_DRAFT),
    composed: {
      marker: SOL,
      authenticity: { hmac_verified: true, request_id: REQUEST_ID, alg: 'HMAC-SHA256' },
    },
    hmacSecret: HMAC_SECRET,
  });
}

function durableOk(patch) {
  const messageText = (patch && patch.message_text) || THREAD_DRAFT;
  const evidence = mintEvidence(messageText);
  const leftover = leftoverFromDurableEvidence({ message_text: messageText }) === true;
  return {
    message_text: messageText,
    draft_meta: { selected_operation_evidence: evidence },
    provenance: { ...evidence, marker: SOL },
    marker: SOL,
    immutable_draft_id: 'graph-draft-004',
    hmac_available: true,
    evidence_verified: leftover ? false : true,
    leftover,
    hmac_kind: 'authenticity',
    ...patch,
  };
}

function testCapability(nowMs) {
  return issueSupervisorCapability({
    nonce: nonce(),
    revision: REVISION,
    replica: `${REVISION}-abcde-fghij`,
    imageTag: IMAGE_SHA,
    digest: DIGEST,
  }, nowMs || NOW_MS);
}

function authArgs(patch) {
  const parsed = parseArgs([
    COMMAND,
    '--deployment', SUNSET_DEPLOYMENT,
    '--tenant', SUNSET_TENANT,
    '--database', EXPECTED_DATABASE,
    '--resource-group', RG,
    '--app', STAFF_APP,
    '--revision', REVISION,
    '--image-tag', IMAGE_SHA,
    '--digest', DIGEST,
    '--confirm', CONFIRMATION_PHRASE,
    '--operator-nonce', nonce(),
    '--confirm-issued-at', ISSUED,
  ]);
  return { ...parsed, ...(patch || {}) };
}

function threadRow(patch) {
  return {
    client_id: C,
    client_slug: 'sunset',
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    conversation_id: V,
    inbound_message_id: M,
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_source_message_id: SRC,
    sender_address: PROOF_SENDER,
    sender_display_name: 'twoods',
    subject: 'Re: Testing 8 26',
    graph_conversation_id: 'graph-thread-1',
    needs_human: false,
    conversation_status: 'open',
    guest_id: GUEST,
    ...patch,
  };
}

function frozenMethod(name, fn) { return Object.freeze({ [name]: fn }); }

function graphGrantRows(row) {
  return { rows: row == null ? [] : [row], rowCount: row == null ? 0 : 1 };
}

function graphGrantEmpty() { return { rows: [], rowCount: 0 }; }

function createGraphGrantMockPg(handlers) {
  return {
    async query(text, params) {
      const t = String(text);
      for (const h of handlers) {
        if (h.match(t, params)) return h.run(t, params);
      }
      throw new Error(`unmatched_sql:${t.slice(0, 80)}`);
    },
  };
}

function successGraphTokenTransport(bodyPatch = {}) {
  return frozenMethod('postTokenForm', async () => Object.freeze({
    statusCode: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: GRAPH_ACCESS,
      refresh_token: GRAPH_NEW_RT,
      scope: PHASE_A_TOKEN_SCOPE,
      ...bodyPatch,
    }),
  }));
}

function mockGraphGrantLifecycle({
  sealed, opId, failCommit, priorStatus, noGrant, failLease,
}) {
  let leaseTok = null;
  const prior = priorStatus || {
    client_id: C, endpoint_id: E,
    grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
    grant_lease_token: null,
    scope_version: 'phase_a_v2',
  };
  return createGraphGrantMockPg([
    {
      match: (t) => /FROM tenant_email_delegated_grants/i.test(t)
        && !/FOR UPDATE/i.test(t) && !/UPDATE/i.test(t) && !/INSERT/i.test(t),
      run: () => (noGrant ? graphGrantEmpty() : graphGrantRows(prior)),
    },
    {
      match: (t) => /FOR UPDATE OF g/i.test(t) || (/SELECT g\.\*/i.test(t) && /FOR UPDATE/i.test(t)),
      run: () => graphGrantRows({
        client_id: C, endpoint_id: E,
        grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        grant_lease_token: null, grant_lease_until: null,
        last_operation_id: opId,
        scope_version: 'phase_a_v2',
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
        endpoint_binding_status: 'verified',
      }),
    },
    {
      match: (t) => /SET grant_status='lease_held'/i.test(t),
      run: (_t, p) => {
        if (failLease) return graphGrantEmpty();
        leaseTok = p[3];
        return graphGrantRows({
          client_id: C, endpoint_id: E,
          grant_generation: 1, grant_status: 'lease_held',
          grant_lease_token: leaseTok,
          grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          last_operation_id: opId,
          scope_version: 'phase_a_v2',
        });
      },
    },
    {
      match: (t) => /grant_lease_token/i.test(t) && /FOR UPDATE/i.test(t)
        && /envelope_version/i.test(t),
      run: () => graphGrantRows({
        client_id: C, endpoint_id: E,
        grant_generation: 1, grant_status: 'lease_held',
        grant_lease_token: leaseTok,
        grant_lease_until: new Date(Date.now() + 60000).toISOString(),
        last_operation_id: opId,
        scope_version: 'phase_a_v2',
        envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
        kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
        kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
        ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag,
        wrapped_dek: sealed.wrapped_dek,
      }),
    },
    {
      match: (t) => /SET grant_generation=/i.test(t) && /grant_status='active'/i.test(t),
      run: (_t, p) => {
        if (failCommit) return graphGrantEmpty();
        return graphGrantRows({
          client_id: C, endpoint_id: E,
          grant_generation: Number(p[2]), grant_status: 'active',
          reconcile_state: 'clean',
          scope_version: 'phase_a_v2',
        });
      },
    },
    {
      match: (t) => /SET reconcile_state=/i.test(t),
      run: () => graphGrantRows({
        client_id: C, endpoint_id: E,
        grant_generation: 1, grant_status: 'lease_held',
        reconcile_state: 'ms_response_uncertain',
        scope_version: 'phase_a_v2',
      }),
    },
    {
      match: (t) => /SET grant_status='active'/i.test(t) && /grant_lease_owner=NULL/i.test(t),
      run: () => graphGrantRows({
        client_id: C, endpoint_id: E,
        grant_generation: 1, grant_status: 'active',
        reconcile_state: 'ms_response_uncertain',
        scope_version: 'phase_a_v2',
      }),
    },
    {
      match: (t) => /reauthorization_required/i.test(t),
      run: () => graphGrantRows({ grant_generation: 1, grant_status: 'reauthorization_required' }),
    },
    {
      match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
      run: () => graphGrantRows({ id: E }),
    },
    { match: () => true, run: () => graphGrantEmpty() },
  ]);
}

async function createGraphGrantSessionLoan(overrides = {}) {
  const fake = overrides.envelopeProvider || createFakeEmailGrantEnvelopeProvider();
  const op = overrides.opId || crypto.randomUUID();
  const sealed = overrides.sealed || await fakeSealRefreshToken(fake, {
    refreshToken: GRAPH_OLD_RT, clientId: C, endpointId: E,
    grantGeneration: 1, operationId: op,
  });
  return createDelegatedGrantAccessSession(Object.freeze({
    deployment: SUNSET_DEPLOYMENT,
    applicationClientId: GRAPH_APP_ID,
    client: overrides.client || mockGraphGrantLifecycle({
      sealed,
      opId: op,
      noGrant: overrides.noGrant === true,
      failLease: overrides.failLease === true,
      failCommit: overrides.failCommit === true,
      priorStatus: overrides.priorStatus,
    }),
    envelopeProvider: overrides.failingProvider || fake,
    secretProvider: overrides.secretProvider
      || frozenMethod('getClientSecret', async () => GRAPH_SECRET),
    transport: overrides.transport || successGraphTokenTransport(),
    workerId: overrides.workerId || 'mail-mvp-004-graph-verify-test',
  }));
}

const OTHER_GUEST = '88888888-8888-4888-8888-888888888888';
const OTHER_CLIENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_CONVERSATION = 'abababab-abab-4aba-8aba-abababababab';
const LEGACY_BOOKINGS_CONVERSATION_SQL = [
  'SELECT count(*)::int AS n FROM bookings',
  'WHERE client_id=$1::uuid AND conversation_id=$2::uuid',
].join(' ');

function pgUndefinedColumn(message) {
  const err = new Error(message || 'column conversation_id does not exist');
  err.code = '42703';
  return err;
}

function sqlMentionsBookingsConversationId(sql) {
  const n = String(sql).replace(/\s+/g, ' ');
  if (/\bbookings\.conversation_id\b/.test(n)) return true;
  if (/\bJOIN bookings b\b/.test(n) && /\bb\.conversation_id\b/.test(n)) return true;
  if (/\bFROM bookings\b/.test(n) && /\bconversation_id\b/.test(n)) return true;
  return false;
}

function isCanonicalGuestBookingCountSql(sql) {
  const n = String(sql).replace(/\s+/g, ' ');
  return /FROM conversations c/.test(n)
    && /JOIN bookings b/.test(n)
    && /b\.client_id=c\.client_id/.test(n)
    && /b\.guest_id=c\.guest_id/.test(n)
    && /c\.client_id=\$1::uuid/.test(n)
    && /c\.id=\$2::uuid/.test(n)
    && /c\.guest_id IS NOT NULL/.test(n)
    && /GROUP BY c\.client_id, c\.id, c\.guest_id/.test(n)
    && !sqlMentionsBookingsConversationId(n);
}

function sunsetBookingSchemaTables(patch) {
  return {
    conversations: [
      { client_id: C, id: V, guest_id: GUEST },
    ],
    bookings: [
      { client_id: C, id: 'b1', guest_id: GUEST },
      { client_id: C, id: 'b2', guest_id: GUEST },
      { client_id: C, id: 'b3', guest_id: GUEST },
      { client_id: C, id: 'b4', guest_id: GUEST },
      { client_id: C, id: 'other-guest', guest_id: OTHER_GUEST },
      { client_id: OTHER_CLIENT, id: 'cross-client', guest_id: GUEST },
    ],
    ...(patch || {}),
  };
}

function executeSunsetBookingCount(sql, params, tables) {
  if (sqlMentionsBookingsConversationId(sql)) {
    throw pgUndefinedColumn();
  }
  if (!isCanonicalGuestBookingCountSql(sql)) return { rows: [] };
  const clientId = params && params[0];
  const conversationId = params && params[1];
  const convs = (tables.conversations || []).filter((row) => (
    row.client_id === clientId && row.id === conversationId && row.guest_id
  ));
  const guests = new Set(convs.map((row) => row.guest_id));
  if (convs.length !== 1 || guests.size !== 1) return { rows: [] };
  const guestId = convs[0].guest_id;
  const n = (tables.bookings || []).filter((row) => (
    row.client_id === clientId && row.guest_id === guestId
  )).length;
  return { rows: [{ n }] };
}

function schemaShapedPg(tables, extra) {
  return async (fn) => fn({
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ');
      if (/FROM clients cl INNER JOIN conversations c/.test(n)) {
        return { rows: extra && extra.threadRows ? extra.threadRows : [threadRow()] };
      }
      if (/inbox_channel_modes/.test(n) && /SELECT/.test(n)) {
        return { rows: [{ inbox_channel_modes: { email: extra && extra.emailMode ? extra.emailMode : 'off' } }] };
      }
      if (/tenant_email_outbound_send_journal/.test(n)) {
        return { rows: [{ n: 0, sends: 0 }] };
      }
      if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) {
        return { rows: [{ n: 0 }] };
      }
      if (/JOIN bookings b/.test(n) || /FROM bookings\b/.test(n)) {
        return executeSunsetBookingCount(sql, params, tables);
      }
      return { rows: [] };
    },
  });
}

function preflightOk(patch) {
  return {
    ok: true,
    approvals: 0,
    journals: 0,
    provider_sends: 0,
    bookings: 4,
    luna_on: true,
    needs_human: false,
    guest_linked: true,
    sender_ok: true,
    subject_ok: true,
    sol_enabled: true,
    provider_source_message_id: SRC,
    graph_conversation_id: 'graph-thread-1',
    client_id: C,
    location_id: L,
    inbound_message_id: M,
    provider_mailbox_id: MAILBOX,
    ...patch,
  };
}

function makeHarness(options = {}) {
  const log = [];
  let current = serving(options.serving);
  let mode = options.mode || 'draft';
  let op = {
    approvals: 0,
    journals: 0,
    provider_sends: 0,
    bookings: 4,
    ...(options.op || {}),
  };
  const invoke = options.invoke || brandProductionAutoOwner(async (input) => {
    log.push('invoke');
    if (typeof options.onInvoke === 'function') options.onInvoke(input);
    op = { ...op, approvals: 1, journals: 1, provider_sends: 1 };
    return {
      status: 'sent',
      sent: true,
      approvals: 1,
      journals: 1,
      provider_sends: 1,
    };
  });
  let evidence = options.evidence || durableOk();
  const harness = createMailMvp004LiveProof({
    nonceStore: options.nonceStore || new Set(),
    now: options.now,
    requireProductionOwner: options.requireProductionOwner,
    async readServingIdentity() {
      log.push(`read:${current.flags[ENV_LUNA_AUTO_SEND_ENABLED]}`);
      return current;
    },
    async waitServingHealthy(input) {
      log.push(`wait:${input && input.enabled}`);
      if (typeof options.waitServingHealthy === 'function') {
        return options.waitServingHealthy(input, current);
      }
      const authorized = input && input.authorized;
      if (options.pinAuthorizedRevision === true && authorized
          && current.revision !== authorized.revision) {
        return {
          ...authorized,
          flagsSource: 'template',
          ready: true,
          trafficWeight: 100,
        };
      }
      return current;
    },
    async setEmergencyFlags(enabled) {
      log.push(`flags:${enabled}`);
      current = serving({
        ...current,
        revision: enabled ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}` : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}`,
        replica: enabled ? `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}-aaaaa-bbbbb`
          : `${STAFF_APP}--safe-${IMAGE_SHA.slice(0, 8)}-ccccc-ddddd`,
        flags: enabled ? flagsOn() : flagsOff(),
      });
      if (options.flagThrow && enabled) throw new Error('flag_boom');
    },
    async putEmailChannelMode(value) {
      log.push(`mode:${value}`);
      if (options.modeThrow && value === 'auto') throw new Error('channel_mode_unproven');
      if (typeof options.putEmailChannelMode === 'function') {
        await options.putEmailChannelMode(value);
        return;
      }
      mode = value;
    },
    async getEmailChannelMode() {
      if (typeof options.getEmailChannelMode === 'function') {
        return options.getEmailChannelMode();
      }
      return mode;
    },
    async preflightSelectedOperation() {
      return options.preflight || preflightOk();
    },
    invokeAutoOwner: invoke,
    async snapshotOperation() { return { ...op }; },
    async readDurableEvidence() {
      if (typeof options.readDurableEvidence === 'function') {
        return options.readDurableEvidence();
      }
      return evidence;
    },
    async verifyGraphArrival() {
      if (typeof options.verifyGraphArrival === 'function') {
        return options.verifyGraphArrival();
      }
      return options.graph || {
        ok: true,
        threaded: true,
        arrivals: 1,
        duplicates: 0,
        adapter_available: true,
        readonly: true,
        subject_ok: true,
      };
    },
    async verifyKillSwitch() {
      log.push('kill');
      if (typeof options.verifyKillSwitch === 'function') {
        return options.verifyKillSwitch();
      }
      return {
        ok: true,
        status: 'blocked',
        reason: 'emergency_flags_off',
        author_called: false,
        journal_called: false,
        provider_called: false,
        provider_sends: 0,
      };
    },
    async reconcile() {
      log.push('reconcile');
      op = { ...op, approvals: 1, journals: 1, provider_sends: 1 };
      if (typeof options.reconcile === 'function') return options.reconcile();
      return { status: 'sent', durable_evidence: evidence };
    },
  });
  return { harness, log, getServing: () => current, getMode: () => mode, getOp: () => op };
}

async function execute(harness, patch) {
  return harness.executeOnce({
    parsed: authArgs(),
    env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
    nowMs: NOW_MS,
    originMasterSha: IMAGE_SHA,
    headSha: IMAGE_SHA,
    artifactsOnMaster: true,
    treeHasProofFiles: true,
    requireLiveImage: true,
    ...patch,
  });
}

async function main() {
  console.log('verify:email-microsoft-auto-create-send-live-proof\n');

  const autoSrc = fs.readFileSync(AUTO_ABS, 'utf8');
  const libSrc = fs.readFileSync(LIB_ABS, 'utf8');
  const cliSrc = fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
  const plan = fs.readFileSync(path.join(ROOT, 'docs/MAIL-MVP.md'), 'utf8');
  const runbook = fs.readFileSync(path.join(ROOT, 'docs/MAIL-MVP-004-SUNSET-AUTO-PROOF-RUNBOOK.md'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  console.log('[1] Default refuse and typed one-shot authorization');
  {
    const none = parseArgs([]);
    assert.equal(none.invalid, true);
    assert.equal(none.invalidReason, 'default_refuse');
    assert.equal(validateExactInvocation(none, NOW_MS), 'default_refuse');

    const envOnly = await runCli([], { env: { MAIL_MVP_004_LIVE_PROOF: '1', LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT } });
    assert.equal(envOnly.ok, false);
    assert.equal(envOnly.reason, 'default_refuse');

    const missingConfirm = parseArgs([
      COMMAND, '--deployment', SUNSET_DEPLOYMENT, '--tenant', SUNSET_TENANT,
      '--database', EXPECTED_DATABASE, '--resource-group', RG, '--app', STAFF_APP,
      '--revision', REVISION, '--image-tag', IMAGE_SHA, '--digest', DIGEST,
      '--operator-nonce', nonce(), '--confirm-issued-at', ISSUED,
    ]);
    assert.equal(validateExactInvocation(missingConfirm, NOW_MS), 'confirmation_required');

    const wrongPhrase = authArgs({ confirm: 'I_AM_SURE' });
    assert.equal(validateExactInvocation(wrongPhrase, NOW_MS), 'confirmation_required');

    const okAuth = authArgs();
    assert.equal(validateExactInvocation(okAuth, NOW_MS, new Set()), null);

    const store = new Set();
    const first = authArgs();
    assert.equal(validateExactInvocation(first, NOW_MS, store), null);
    store.add(first.operatorNonce);
    assert.equal(validateExactInvocation(first, NOW_MS, store), 'operator_nonce_replay');

    const stale = authArgs({ confirmIssuedAt: '2026-08-27T11:00:00.000Z' });
    assert.equal(validateExactInvocation(stale, NOW_MS, new Set()), 'confirm_window_invalid');

    assert.equal(parseArgs(['execute-once', '--target', 'sunset']).invalidReason, 'target_refused');
    assert.equal(parseArgs(['execute-once', '--conversation-id', V]).invalidReason, 'target_refused');
    assert.equal(parseArgs(['execute-once', '--deployment=sunset-staging']).invalidReason, 'equals_form_refused');

    const spawned = spawnSync(process.execPath, [CLI_REL], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, MAIL_MVP_004_LIVE_PROOF: '1' },
    });
    assert.notEqual(spawned.status, 0);
    assert.match(`${spawned.stdout}${spawned.stderr}`, /default_refuse|refused/);
  }

  console.log('[2] Target / production / sender / subject bind');
  {
    const prod = await runCli([COMMAND], { env: { LUNA_DEPLOYMENT: 'production' } });
    assert.equal(prod.reason, 'production_refused');
    const wolf = await runCli([COMMAND], { env: { DEFAULT_CLIENT_SLUG: 'wolfhouse' } });
    assert.equal(wolf.reason, 'production_refused');
    assert.equal(validatePinnedOrWrong(), undefined);
    function validatePinnedOrWrong() {
      const wrongApp = authArgs({ appName: 'luna-sunset-staging-email-luna' });
      assert.equal(validateExactInvocation(wrongApp, NOW_MS, new Set()), 'wrong_target');
      const staffStaging = authArgs({ appName: 'wh-staging-staff-api' });
      assert.equal(validateExactInvocation(staffStaging, NOW_MS, new Set()), 'wrong_target');
    }
    assert.equal(normalizeProofSubject('Re: Testing 8 26'), PROOF_SUBJECT);
    assert.equal(isProofSubject('Testing 8 26'), true);
    assert.equal(isProofSubject('Re: Other guest'), false);
    assert.equal(isAuthoritativeSender(threadRow()), true);
    assert.equal(isAuthoritativeSender(threadRow({ sender_address: 'twoods@example.com' })), false);
    assert.equal(isAuthoritativeSender(threadRow({
      sender_address: 'other@xantrion.com',
      sender_display_name: 'twoods',
    })), false);
    const selected = selectProofThread([threadRow()]);
    assert.equal(selected.ok, true);
    const noGuest = selectProofThread([threadRow({ guest_id: null })]);
    assert.equal(noGuest.reason, 'not_guest_linked');
    const leftover = isLeftoverGenericDraft('Thanks for your message. A teammate can follow up if you need anything.');
    assert.equal(leftover, true);
    assert.equal(isLeftoverGenericDraft(THREAD_DRAFT), false);
  }

  console.log('[3] Exact-master image requirement; copied script is not proof');
  {
    const blocked = evaluateLiveProofReadiness({
      serving: serving(),
      originMasterSha: IMAGE_SHA,
      headSha: 'c'.repeat(40),
      treeHasProofFiles: false,
      copiedScript: true,
    });
    assert.equal(blocked.can_proceed, false);
    assert.ok(blocked.blocked_reasons.includes('head_not_origin_master'));
    assert.ok(blocked.blocked_reasons.includes('proof_files_not_on_master'));
    assert.ok(blocked.blocked_reasons.includes('copied_script_is_not_proof'));
    const oldImage = evaluateLiveProofReadiness({
      serving: serving({ imageTag: 'd'.repeat(40) }),
      originMasterSha: IMAGE_SHA,
      headSha: IMAGE_SHA,
      treeHasProofFiles: true,
    });
    assert.equal(oldImage.can_proceed, false);
    assert.ok(oldImage.blocked_reasons.includes('exact_master_image_required'));
    const ready = evaluateLiveProofReadiness({
      serving: serving(),
      originMasterSha: IMAGE_SHA,
      headSha: IMAGE_SHA,
      artifactsOnMaster: true,
      treeHasProofFiles: true,
    });
    assert.equal(ready.can_proceed, true);
    assert.equal(ready.copied_script_boolean_trusted, false);
    const copiedFalseNotProof = evaluateLiveProofReadiness({
      serving: serving(),
      originMasterSha: IMAGE_SHA,
      headSha: IMAGE_SHA,
      copiedScript: false,
    });
    assert.equal(copiedFalseNotProof.can_proceed, false);
    assert.ok(copiedFalseNotProof.blocked_reasons.includes('proof_files_not_on_master'));
    assert.equal(LIVE_IMAGE_REQUIREMENT.copied_script_is_not_proof, true);
    assert.equal(LIVE_IMAGE_REQUIREMENT.inner_entrypoint, PROOF_REMOTE_NODE);
    assert.equal(LIVE_IMAGE_REQUIREMENT.image_repository, IMAGE_REPOSITORY);
    for (const rel of REQUIRED_PROOF_FILES) {
      assert.equal(fs.existsSync(path.join(ROOT, rel)), true, rel);
    }

    const { harness } = makeHarness();
    const refusedImage = await execute(harness, {
      originMasterSha: IMAGE_SHA,
      headSha: 'e'.repeat(40),
      treeHasProofFiles: false,
    });
    assert.equal(refusedImage.ok, false);
    assert.ok(['head_not_origin_master', 'proof_files_not_on_master', 'exact_master_image_required']
      .includes(refusedImage.reason));
    assert.equal(refusedImage.invoked, 0);
  }

  console.log('[4] Independent zero/new preflight refuses before mutation');
  {
    const { harness, log } = makeHarness({
      preflight: preflightOk({ approvals: 1, journals: 1, provider_sends: 1 }),
    });
    const already = await execute(harness);
    assert.equal(already.reason, 'operation_not_new');
    assert.equal(log.includes('flags:true'), false);
    assert.equal(log.includes('invoke'), false);

    const needs = await execute(makeHarness({
      preflight: preflightOk({ needs_human: true }),
    }).harness);
    assert.equal(needs.reason, 'needs_human');

    const lunaOff = await execute(makeHarness({
      preflight: preflightOk({ luna_on: false }),
    }).harness);
    assert.equal(lunaOff.reason, 'luna_off');

    const solOff = await execute(makeHarness({
      preflight: preflightOk({ sol_enabled: false }),
    }).harness);
    assert.equal(solOff.reason, 'sol_disabled');
  }

  console.log('[5] Authorized path: one canonical owner, restore in finally, kill-switch');
  {
    const { harness, log, getServing, getMode } = makeHarness();
    const result = await execute(harness);
    assert.equal(result.ok, true);
    assert.equal(result.invoked, 1);
    assert.equal(result.restored, true);
    assert.equal(result.public.approvals, 1);
    assert.equal(result.public.journals, 1);
    assert.equal(result.public.provider_sends, 1);
    assert.equal(result.public.kill_switch, true);
    assert.equal(result.public.graph_threaded, true);
    assert.deepEqual(getServing().flags, flagsOff());
    assert.equal(getMode(), 'off');
    assert.ok(log.includes('flags:true'));
    assert.ok(log.includes('flags:false'));
    assert.ok(log.includes('mode:auto'));
    assert.ok(log.includes('mode:off'));
    assert.ok(log.includes('invoke'));
    assert.ok(log.includes('kill'));
    assert.equal(log.filter((x) => x === 'invoke').length, 1);
    const pub = JSON.stringify(publicProofOutput(result));
    assert.doesNotMatch(pub, new RegExp(V, 'i'));
    assert.doesNotMatch(pub, /twoods@xantrion/);
    assert.doesNotMatch(pub, /Would you like to make a booking/);
  }

  console.log('[6] Cleanup always runs; duplicate reconciles without retry');
  {
    const throwing = brandProductionAutoOwner(async () => { throw new Error('boom'); });
    const { harness: hThrow, log, getServing, getMode } = makeHarness({ invoke: throwing });
    const failed = await execute(hThrow);
    assert.equal(failed.ok, false);
    assert.equal(getServing().flags[ENV_LUNA_AUTO_SEND_ENABLED], 'false');
    assert.equal(getMode(), 'off');
    assert.ok(log.includes('flags:false'));
    assert.ok(log.includes('mode:off'));

    let invokes = 0;
    const once = brandProductionAutoOwner(async () => {
      invokes += 1;
      return { status: 'skipped', reason: 'already_sent', marker: SOL, draft_text: THREAD_DRAFT };
    });
    const { harness: hDup } = makeHarness({
      invoke: once,
      op: { approvals: 1, journals: 1, provider_sends: 1, bookings: 4 },
    });
    const dup = await execute(hDup);
    assert.equal(invokes, 1);
    assert.equal(dup.ok, true);
    assert.equal(dup.public.duplicate, true);

    let retried = 0;
    const indeterminate = brandProductionAutoOwner(async () => {
      retried += 1;
      return { status: 'failed', indeterminate: true, reason: 'staff_exec_failed' };
    });
    const rec = await execute(makeHarness({
      invoke: indeterminate,
      reconcile: async () => ({ status: 'sent', marker: SOL, draft_text: THREAD_DRAFT }),
    }).harness);
    assert.equal(retried, 1);
    assert.equal(rec.ok, true);

    const leftoverInvoke = brandProductionAutoOwner(async () => ({
      status: 'sent',
      sent: true,
      approvals: 1,
      journals: 1,
      provider_sends: 1,
    }));
    const leftover = await execute(makeHarness({
      invoke: leftoverInvoke,
      evidence: durableOk({
        message_text: 'Thanks for your message. A teammate can follow up if you need anything.',
      }),
    }).harness);
    assert.equal(leftover.reason, 'leftover_generic_draft');
    assert.equal(leftover.restored, true);

    const unbranded = async () => ({ status: 'sent', marker: SOL, draft_text: THREAD_DRAFT });
    const notCanon = await execute(makeHarness({ invoke: unbranded }).harness);
    assert.equal(notCanon.reason, 'not_canonical_owner');
    assert.equal(isProductionAutoOwner(unbranded), false);
  }

  console.log('[7] Flag mutation is bounded; inner command uses image path');
  {
    const enable = buildSetEnvArgs(true);
    const disable = buildSetEnvArgs(false);
    assert.deepEqual(enable.slice(0, 5), ['containerapp', 'update', '-g', RG, '-n']);
    assert.equal(enable[5], STAFF_APP);
    assert.equal(enable.includes('--sethome'), false);
    assert.ok(enable.includes(`${ENV_LUNA_AUTO_SEND_ENABLED}=true`));
    assert.ok(enable.includes(`${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED}=true`));
    assert.equal(enable.some((a) => /IMAP|SMTP|CUSTOMER_OUTREACH|BOOKING/.test(String(a))), false);
    assert.ok(disable.includes(`${ENV_LUNA_AUTO_SEND_ENABLED}=false`));
    const cmd = buildStaffOwnerRemoteCommand(crypto.randomUUID(), false);
    assert.match(cmd, new RegExp(PROOF_REMOTE_NODE.replace(/\./g, '\\.')));
    assert.doesNotMatch(cmd, new RegExp(`echo ${MUTATION_ISSUED_MARKER}`));
    assert.match(libSrc, /process\.stdout\.write\(`\$\{MUTATION_ISSUED_MARKER\}\\n`\)/);
    assert.doesNotMatch(cmd, /printf %s .*email-luna-microsoft-auto-create-send-live-proof/);
    const b64 = encodeProofEnvPayload(crypto.randomUUID(), false);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    assert.match(decoded, /MAIL_MVP_004_STAFF_OWNER_PROOF=1/);
    assert.doesNotMatch(decoded, /LUNA_AUTO_SEND_ENABLED=true/);
    assert.doesNotMatch(decoded, new RegExp(V, 'i'));
    const parsedShow = parseServingIdentity({
      name: STAFF_APP,
      properties: {
        latestRevisionName: REVISION,
        latestReadyRevisionName: REVISION,
        configuration: {
          ingress: {
            traffic: [{ revisionName: REVISION, weight: 100 }],
          },
        },
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'false' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'false' },
            ],
          }],
        },
      },
    });
    assert.equal(parsedShow.imageTag, IMAGE_SHA);
    assert.equal(parsedShow.trafficWeight, 100);
    assert.equal(parsedShow.flagsSource, 'template');
    assert.equal(flagsLiteral(parsedShow, false), false);
  }

  console.log('[8] Inner staff owner: existing 003 path, Sol, skip duplicate');
  {
    const os = require('node:os');
    const rows = [threadRow()];
    const counts = { approvals: 0, journals: 0, sends: 0, bookings: 4 };
    const queries = [];
    const withPgClient = async (fn) => fn({
      async query(sql, params) {
        const n = String(sql).replace(/\s+/g, ' ');
        queries.push(n);
        if (/FROM clients cl INNER JOIN conversations c/.test(n)) {
          assert.equal(params[0], PROOF_SENDER);
          return { rows };
        }
        if (/inbox_channel_modes/.test(n) && /SELECT/.test(n)) {
          return { rows: [{ inbox_channel_modes: { email: 'auto', whatsapp: 'auto' } }] };
        }
        if (/luna_email_open_draft/.test(n) && /message_text/.test(n)) {
          if (counts.approvals !== 1) return { rows: [] };
          return {
            rows: [{
              approval_id: '55555555-5555-4555-8555-555555555555',
              message_text: THREAD_DRAFT,
              state: 'terminal',
              body_digest: 'c'.repeat(64),
              immutable_draft_id: 'graph-draft-004',
              send_invocation_count: counts.sends,
              draft_meta: {
                selected_operation_evidence: mintEvidence(THREAD_DRAFT),
              },
            }],
          };
        }
        if (/tenant_email_outbound_send_journal/.test(n)) {
          return { rows: [{ n: counts.journals, sends: counts.sends }] };
        }
        if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) {
          return { rows: [{ n: counts.approvals }] };
        }
        if (/JOIN bookings b/.test(n)) {
          assert.equal(params[0], C);
          assert.equal(params[1], V);
          return { rows: [{ n: counts.bookings }] };
        }
        return { rows: [] };
      },
    });
    const handle = brandProductionAutoOwner(async (input) => {
      assert.equal(input.envelope.provider, 'microsoft_graph');
      assert.equal(input.projection.conversation_id, V);
      assert.equal(isEmailEmergency(input.env), true);
      counts.approvals = 1;
      counts.journals = 1;
      counts.sends = 1;
      return {
        status: 'sent',
        sent: true,
        approvals: 1,
        journals: 1,
        provider_sends: 1,
      };
    });
    function isEmailEmergency(env) {
      return env[ENV_LUNA_AUTO_SEND_ENABLED] === 'true'
        && env[ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED] === 'true';
    }
    function innerCall(handleFn, extra) {
      const cap = testCapability();
      return {
        env: {
          MAIL_MVP_004_LIVE_PROOF: '1',
          MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
          LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
          EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
          EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
          EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
          LUNA_AUTO_SEND_ENABLED: 'true',
          LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
          MAIL_MVP_004_CAPABILITY: encodeCapability(cap),
          MAIL_MVP_004_REVISION: REVISION,
          MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
          MAIL_MVP_004_DIGEST: DIGEST,
          [ENV_HMAC_SECRET]: HMAC_SECRET,
        },
        withPgClient,
        wired: { handleProjectedInbound: handleFn },
        nowMs: NOW_MS,
        consumedCapabilityPath: path.join(os.tmpdir(), `mvp004-cap-${cap.nonce}.json`),
        dispatchReceiptPath: path.join(os.tmpdir(), `mvp004-receipt-${cap.nonce}.json`),
        ...(extra || {}),
      };
    }
    const inner = await runStaffOwnerProof(innerCall(handle));
    assert.equal(inner.ok, true);
    assert.equal(inner.invoked, 1);
    assert.equal(snapshotSolMarker(inner.provenance.marker).model, 'gpt-5.6-sol');

    const standalone = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      withPgClient,
      wired: { handleProjectedInbound: handle },
    });
    assert.equal(standalone.reason, 'capability_required');

    const disabled = await runStaffOwnerProof({
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      withPgClient,
      wired: { handleProjectedInbound: handle },
    });
    assert.equal(disabled.reason, 'live_proof_disabled');

    counts.approvals = 1;
    counts.journals = 1;
    counts.sends = 1;
    const skipped = await runStaffOwnerProof(innerCall(brandProductionAutoOwner(async () => {
      throw new Error('must_not_resend');
    })));
    assert.equal(skipped.reason, 'already_sent');
    assert.equal(skipped.invoked, 0);
  }

  console.log('[9] Pins: 003 reused, 004 docs/scripts, no 005/006/008/4J');
  {
    assert.equal(typeof createEmailLunaMicrosoftAutoCreateAndSend, 'function');
    assert.equal(typeof afterMicrosoftInboundProjected, 'function');
    assert.match(libSrc, /require\('\.\/email-luna-microsoft-auto-create-send'\)/);
    assert.match(autoSrc, /MAIL-MVP-003/);
    assert.doesNotMatch(libSrc, /handleProjectedInbound[\s\S]{0,80}rebuild/);
    assert.equal(pkg.scripts['verify:mail-mvp-004'], 'node scripts/verify-email-microsoft-auto-create-send-live-proof.js');
    assert.match(pkg.scripts['verify:mail-mvp-003'], /verify-email-microsoft-auto-create-send/);
    assert.match(pkg.scripts['verify:mail-mvp-007'], /verify-email-luna-sunset-email-hermes-sol/);
    assert.match(plan, /004/);
    assert.match(plan, /I_UNDERSTAND_SUNSET_STAGING_MAIL_MVP_004_ONE_SHOT_AUTO_CREATE_AND_SEND/);
    assert.match(runbook, /copied as proof/i);
    assert.match(runbook, /assert-deploy-from-master/);
    assert.match(runbook, /twoods@xantrion\.com/);
    assert.match(runbook, /Testing 8 26/);
    assert.match(runbook, /dispatch_reason/);
    assert.match(runbook, /enumerated snake_case tokens only/);
    assert.doesNotMatch(libSrc, /mail_mvp_004_staff_oneshot/);
    assert.match(cliSrc, /MAIL_MVP_004_STAFF_OWNER_PROOF/);
    assert.doesNotMatch(libSrc, /imap_smtp/);
    assert.doesNotMatch(runbook, /Full Sail 4J execute/);
    assert.match(runbook, /No .*Full Sail 4J/i);
    const redacted = redactSensitive(`${V} ${PROOF_SENDER} Bearer tok`, [V]);
    assert.doesNotMatch(redacted, new RegExp(V, 'i'));
    assert.doesNotMatch(redacted, /twoods@xantrion/);
  }

  console.log('[10] Preflight CLI is not live PASS');
  {
    const pre = await runCli([
      PREFLIGHT_COMMAND,
      '--deployment', SUNSET_DEPLOYMENT,
      '--tenant', SUNSET_TENANT,
      '--database', EXPECTED_DATABASE,
      '--resource-group', RG,
      '--app', STAFF_APP,
      '--revision', REVISION,
      '--image-tag', IMAGE_SHA,
      '--digest', DIGEST,
    ], {
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      execGit: (args) => {
        if (args[1] === 'HEAD') return { stdout: `${'f'.repeat(40)}\n` };
        return { stdout: `${IMAGE_SHA}\n` };
      },
      serving: serving(),
    });
    assert.equal(pre.status, 'preflight_ok');
    assert.equal(pre.ok, false);
    assert.equal(pre.live_proof_blocked, true);
    assert.equal(validatePreflightInvocation(parseArgs([
      PREFLIGHT_COMMAND,
      '--deployment', SUNSET_DEPLOYMENT,
      '--tenant', SUNSET_TENANT,
      '--database', EXPECTED_DATABASE,
      '--resource-group', RG,
      '--app', STAFF_APP,
      '--revision', REVISION,
      '--image-tag', IMAGE_SHA,
      '--digest', DIGEST,
    ])), null);
  }

  console.log('[11] Hostile: production 003 success shape is not leftover after send');
  {
    const productionSent = {
      status: 'sent',
      reason: null,
      draft_writes: 1,
      approvals: 1,
      journals: 1,
      provider_sends: 1,
      sent: true,
    };
    assert.equal(isProduction003SentShape(productionSent), true);
    assert.equal(isLeftoverGenericDraft(productionSent.draft_text), true);
    assert.equal(leftoverFromDurableEvidence({ message_text: THREAD_DRAFT }), false);
    const prodOwner = createEmailLunaMicrosoftAutoCreateAndSend({
      withPgClient: async () => ({ rows: [] }),
      async regenerateEmailLunaDraftOnStaffClick() { return { status: 'draft_ready', draft_text: THREAD_DRAFT }; },
      async saveDraftThroughStaffOwner() { return { status: 'saved', approval_id: '55555555-5555-4555-8555-555555555555' }; },
      async approveAndDispatchEmailOutbound() {
        return { code: 'email_send_committed', status: 200, journaled: true, provider_invoked: true };
      },
      async getEmailChannelMode() { return 'auto'; },
      async readPause() { return { lookup_error: false, global_paused: false, conversation_paused: false }; },
      async resolveAutoActor() {
        return { staff_user_id: '11111111-1111-4111-8111-111111111111', client_id: C, role: 'owner' };
      },
    });
    assert.equal(typeof prodOwner.handleProjectedInbound, 'function');
    const { harness } = makeHarness();
    const result = await execute(harness);
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
    assert.equal(result.public.approvals, 1);
  }

  console.log('[12] Hostile: partial duplicate is fail-closed; never ok:true');
  {
    assert.equal(exactReconciledCounts({ approvals: 1, journals: 1, provider_sends: 1 }), true);
    assert.equal(duplicateUnreconciled({ approvals: 1, journals: 1, provider_sends: 0 }), true);
    assert.equal(duplicateUnreconciled({ approvals: 2, journals: 1, provider_sends: 1 }), true);
    const partial = brandProductionAutoOwner(async () => ({
      status: 'skipped',
      reason: 'already_sent',
    }));
    const failed = await execute(makeHarness({
      invoke: partial,
      op: { approvals: 1, journals: 1, provider_sends: 0, bookings: 4 },
    }).harness);
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'duplicate_unreconciled');
    assert.equal(failed.restored, true);
  }

  console.log('[13] Hostile: durable nonce, supervisor issued-at, Graph, kill-switch, bookings scope');
  {
    const noncePath = path.join(require('node:os').tmpdir(), `mvp004-nonce-${process.pid}.json`);
    try { fs.unlinkSync(noncePath); } catch { /* first */ }
    const store = createDurableNonceStore(noncePath);
    const n = nonce();
    assert.equal(store.add(n, 'Testing 8 26|twoods@xantrion.com'), true);
    const restarted = createDurableNonceStore(noncePath);
    assert.equal(restarted.has(n), true);
    assert.equal(restarted.add(n, 'Testing 8 26|twoods@xantrion.com'), false);

    const callerIssued = '2026-08-27T11:50:00.000Z';
    const cap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    assert.notEqual(cap.issued_at, callerIssued);
    assert.equal(cap.issued_at, ISSUED);
    const verified = verifySupervisorCapability(encodeCapability(cap), NOW_MS, {
      revision: REVISION,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    });
    assert.equal(verified.ok, true);

    const graph = createProductionGraphArrivalVerifier({
      async listThreadMessages(input) {
        assert.equal(input.forbid_body, true);
        assert.equal(input.forbid_send, true);
        assert.equal(input.graph_conversation_id, 'graph-thread-1');
        assert.equal(input.provider_mailbox_id, MAILBOX);
        assert.equal(graphSelectOk(input.select), true);
        return {
          messages: [{
            id: 'graph-sent-1',
            conversationId: 'graph-thread-1',
            subject: 'Re: Testing 8 26',
            inReplyTo: SRC,
          }],
        };
      },
    });
    function graphSelectOk(select) {
      const fields = Array.isArray(select) ? select : [];
      return !fields.includes('body') && !fields.includes('bodyPreview');
    }
    const arrival = await graph.verifyGraphArrival({
      graph_conversation_id: 'graph-thread-1',
      provider_source_message_id: SRC,
      provider_mailbox_id: MAILBOX,
      immutable_draft_id: 'graph-draft-004',
    });
    assert.equal(arrival.ok, true);
    assert.equal(arrival.arrivals, 1);
    assert.equal(arrival.duplicates, 0);
    const leaked = classifyGraphArrival([{
      id: 'x',
      conversationId: 'graph-thread-1',
      subject: 'Re: Testing 8 26',
      body: 'secret guest body',
    }], { graph_conversation_id: 'graph-thread-1', provider_source_message_id: SRC });
    assert.equal(leaked.reason, 'graph_body_leaked');

    let author = 0;
    let journal = 0;
    let provider = 0;
    const killOwner = createEmailLunaMicrosoftAutoCreateAndSend({
      withPgClient: async () => ({ rows: [] }),
      async regenerateEmailLunaDraftOnStaffClick() { author += 1; return { status: 'draft_ready', draft_text: 'nope' }; },
      async saveDraftThroughStaffOwner() { journal += 1; return { status: 'saved', approval_id: 'x' }; },
      async approveAndDispatchEmailOutbound() { provider += 1; return { code: 'email_send_committed', status: 200 }; },
      async getEmailChannelMode() { return 'auto'; },
      async readPause() { return { lookup_error: false, global_paused: false, conversation_paused: false }; },
      async resolveAutoActor() { return { staff_user_id: '11111111-1111-4111-8111-111111111111', client_id: C, role: 'owner' }; },
    });
    const kill = createCanonical003KillSwitch({
      handleProjectedInbound: (input) => killOwner.handleProjectedInbound(input),
    });
    const killed = await kill({
      env: {
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        [ENV_LUNA_AUTO_SEND_ENABLED]: 'false',
        [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'false',
      },
      authority: { clientId: C, locationId: L, endpointId: E },
      envelope: { provider: 'microsoft_graph', provider_mailbox_id: MAILBOX, provider_message_id: SRC },
      projection: { status: 'already_projected', conversation_id: V },
    });
    assert.equal(killed.reason, 'emergency_flags_off');
    assert.equal(killed.status, 'blocked');
    assert.equal(author, 0);
    assert.equal(journal, 0);
    assert.equal(provider, 0);

    const revArgs = buildRevisionShowArgs(REVISION);
    assert.deepEqual(revArgs.slice(0, 3), ['containerapp', 'revision', 'show']);
    assert.equal(revArgs.includes('--revision'), true);
    const parsedRev = parseRevisionShow({
      name: REVISION,
      properties: {
        healthState: 'Healthy',
        runningState: 'Running',
        provisioningState: 'Provisioned',
        imageDigest: DIGEST,
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
            ],
          }],
        },
      },
    });
    assert.equal(parsedRev.healthState, 'Healthy');
    assert.equal(parsedRev.digest, DIGEST);
    assert.equal(parsedRev.flagsSource, 'template');
    assert.equal(servingHealthyReady100({ ...parsedRev, trafficWeight: 100, ready: true }), true);
    assert.equal(flagsLiteral(parsedRev, true), false);

    const execArgs = buildStaffOwnerExecAzArgs({
      attemptId: cap.nonce,
      replica: `${REVISION}-abcde-fghij`,
      revision: `${STAFF_APP}--enabled-${IMAGE_SHA.slice(0, 8)}`,
      capability: cap,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    });
    assert.equal(execArgs[1], 'exec');
    assert.equal(execArgs.includes('--revision'), true);
    const execCommand = execArgs[execArgs.indexOf('--command') + 1];
    assert.match(execCommand, new RegExp(PROOF_REMOTE_NODE.replace(/\./g, '\\.')));
    assert.equal(isLegalStaffOwnerRemoteCommand(execCommand), true);
    assert.doesNotMatch(execCommand, /^sh -c /);
    assert.doesNotMatch(execCommand, /'/);
  }

  console.log('[14] Hostile: production supervisor contract; default CLI still refuses');
  {
    const fakeGraph = {
      async verifyGraphArrival() {
        return { ok: true, threaded: true, arrivals: 1, duplicates: 0 };
      },
    };
    const fakePg = async () => ({ rows: [] });
    const supervisor = createProductionMailMvp004Supervisor({
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      graphVerifier: fakeGraph,
      withPgClient: fakePg,
      async verifyKillSwitch() {
        return { ok: true, status: 'blocked', reason: 'emergency_flags_off' };
      },
    });
    assert.equal(isProductionPgAdapter(fakePg), false);
    assert.equal(typeof supervisor.executeOnce, 'function');
    const graphArrival = await createProductionReadonlyGraphListAdapter({}).verifyGraphArrival({
      graph_conversation_id: 'graph-thread-1',
      provider_mailbox_id: MAILBOX,
      forbid_send: true,
    });
    assert.equal(graphArrival.ok, false);
    assert.ok(['graph_adapter_unwired', 'graph_unproven'].includes(graphArrival.reason));

    let threw = false;
    try {
      createProductionReadonlyGraphListAdapter({
        listThreadMessages: fakeGraph.verifyGraphArrival,
        allowInjectedList: true,
      });
    } catch (error) {
      threw = error.message === 'graph_adapter_unwired';
    }
    assert.equal(threw, true);

    const defaultRefuse = await runCli([], { env: { MAIL_MVP_004_LIVE_PROOF: '1' } });
    assert.equal(defaultRefuse.ok, false);
    assert.equal(defaultRefuse.reason, 'default_refuse');
  }

  console.log('[15] Hostile: traffic, Sol HMAC, Graph/PG wiring, replica env, marker, kill-switch');
  {
    const fifty = traffic100RevisionName([
      { revisionName: REVISION, weight: 50 },
      { revisionName: `${STAFF_APP}--other`, weight: 50 },
    ]);
    assert.equal(fifty, null);
    const missingWeight = parseServingIdentity({
      name: STAFF_APP,
      properties: {
        latestRevisionName: REVISION,
        latestReadyRevisionName: REVISION,
        configuration: { ingress: { traffic: [{ revisionName: REVISION, latest: true }] } },
        template: { containers: [{ image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}` }] },
      },
    });
    assert.equal(missingWeight, null);
    const coerced = await readProductionServingIdentity(async (args) => {
      if (args[1] === 'show' && !args.includes('revision')) {
        return {
          status: 0,
          stdout: JSON.stringify({
            name: STAFF_APP,
            properties: {
              latestRevisionName: REVISION,
              latestReadyRevisionName: REVISION,
              configuration: {
                ingress: { traffic: [{ revisionName: REVISION, weight: 50 }] },
              },
              template: { containers: [{ image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}@${DIGEST}` }] },
            },
          }),
        };
      }
      return { status: 0, stdout: '{}' };
    });
    assert.equal(coerced, null);

    const forged = snapshotTrustedProvenance({
      marker: SOL,
      authenticity: { hmac_verified: true, alg: 'HMAC-SHA256' },
    }, {
      client_id: C, location_id: L, conversation_id: V, source_inbound_event_id: M,
    }, HMAC_SECRET, THREAD_DRAFT);
    assert.equal(forged, null);
    const missingMac = verifySelectedOperationSolEvidence({
      hmac_verified: true,
      request_id: REQUEST_ID,
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      runtime: 'sunset-email-luna',
    }, {
      client_id: C, location_id: L, conversation_id: V, source_inbound_event_id: M,
    }, HMAC_SECRET, THREAD_DRAFT);
    assert.equal(missingMac, null);
    const validEvidence = mintEvidence(THREAD_DRAFT);
    const verified = verifySelectedOperationSolEvidence(
      validEvidence,
      { client_id: C, location_id: L, conversation_id: V, source_inbound_event_id: M },
      HMAC_SECRET,
      THREAD_DRAFT,
    );
    assert.equal(verified.request_id, REQUEST_ID);
    const swappedBody = verifySelectedOperationSolEvidence(
      validEvidence,
      { client_id: C, location_id: L, conversation_id: V, source_inbound_event_id: M },
      HMAC_SECRET,
      'different draft body about the mailbox booking',
    );
    assert.equal(swappedBody, null);

    const bodySelect = buildReadonlyGraphListRequest({
      provider_mailbox_id: MAILBOX,
      graph_conversation_id: 'graph-thread-1',
      forbid_send: true,
      select: ['id', 'body', 'conversationId'],
    });
    assert.equal(bodySelect, null);
    const goodSelect = buildReadonlyGraphListRequest({
      provider_mailbox_id: MAILBOX,
      graph_conversation_id: 'graph-thread-1',
      forbid_send: true,
      select: GRAPH_LIST_SELECT.slice(),
    });
    assert.equal(goodSelect.method, 'GET');
    assert.equal(goodSelect.path.includes('body'), false);
    assert.match(goodSelect.path, /conversationId/);
    assert.match(goodSelect.path, /internetMessageId/);
    assert.match(goodSelect.path, new RegExp(`/v1\\.0/users/${MAILBOX}/messages`));
    assert.doesNotMatch(goodSelect.path, /bodyPreview/);

    let pgMismatch = null;
    try {
      const adapter = createProductionStaffPgAdapter({
        pgConnect: {
          async withPgClient(fn) {
            return fn({
              async query() { return { rows: [{ current_database: 'wolfhouse_staging' }] }; },
            });
          },
        },
      });
      await adapter.withPgClient(async () => 'nope');
    } catch (error) {
      pgMismatch = error.reason || error.message;
    }
    assert.equal(pgMismatch, 'database_mismatch');
    const sunsetPg = createProductionStaffPgAdapter({
      pgConnect: {
        async withPgClient(fn) {
          return fn({
            async query(sql) {
              if (/current_database/.test(String(sql))) {
                return { rows: [{ current_database: EXPECTED_DATABASE }] };
              }
              return { rows: [] };
            },
          });
        },
      },
    });
    assert.equal(isProductionPgAdapter(sunsetPg.withPgClient), true);
    const identified = await sunsetPg.withPgClient(async () => 'ok');
    assert.equal(identified, 'ok');

    const templateServing = parseRevisionShow({
      name: REVISION,
      properties: {
        healthState: 'Healthy',
        runningState: 'Running',
        provisioningState: 'Provisioned',
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
            ],
          }],
        },
      },
    });
    assert.equal(flagsLiteral({ ...templateServing, trafficWeight: 100 }, true), false);
    const replicaEnv = parseReplicaProcessEnv(
      `${ENV_LUNA_AUTO_SEND_ENABLED}=true\n${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED}=true\n`,
    );
    assert.equal(replicaEnv.flagsSource, 'replica_process');
    assert.equal(flagsLiteral({
      ...templateServing,
      trafficWeight: 100,
      ready: true,
      flags: replicaEnv,
      flagsSource: 'replica_process',
    }, true), true);
    assert.equal(acceptedFlagSource(FLAGS_SOURCE_ACA_IMMUTABLE_REVISION), true);
    assert.equal(acceptedFlagSource(FLAGS_SOURCE_TEMPLATE), false);
    assert.equal(flagsLiteral({
      ...templateServing,
      trafficWeight: 100,
      ready: true,
      flags: flagsOn(),
      flagsSource: FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
      replica: `${REVISION}-abcde-fghij`,
      unrelatedEnvFingerprint: '[]',
    }, true), true);

    let syntheticKillThrew = false;
    try {
      createCanonical003KillSwitch({
        handleProjectedInbound: async () => ({ status: 'blocked', reason: 'emergency_flags_off' }),
        syntheticEnv: true,
      });
    } catch (error) {
      syntheticKillThrew = error.message === 'kill_switch_synthetic_env';
    }
    assert.equal(syntheticKillThrew, true);

    const classified = extractProofJson(`noise\n${MUTATION_ISSUED_MARKER}\n{"ok":false,"reason":"author_failed"}`);
    assert.equal(classified.reason, 'author_failed');
    const markedInner = freezeInnerClassified();
    function freezeInnerClassified() {
      return { ok: false, reason: classified.reason };
    }
    assert.equal(markedInner.reason, 'author_failed');
    assert.match(libSrc, /if \(classified\.inner\) \{\s*return freeze\(\{ \.\.\.classified\.inner, dispatch_marked: classified\.marked === true \}\);/s);

    let author = 0;
    const probeOwner = createEmailLunaMicrosoftAutoCreateAndSend({
      withPgClient: async () => ({ rows: [] }),
      async regenerateEmailLunaDraftOnStaffClick() { author += 1; return { status: 'draft_ready', draft_text: 'nope' }; },
      async saveDraftThroughStaffOwner() { return { status: 'saved', approval_id: 'x' }; },
      async approveAndDispatchEmailOutbound() { return { code: 'email_send_committed', status: 200 }; },
      async getEmailChannelMode() { return 'auto'; },
      async readPause() { return { lookup_error: false, global_paused: false, conversation_paused: false }; },
      async resolveAutoActor() { return { staff_user_id: '11111111-1111-4111-8111-111111111111', client_id: C, role: 'owner' }; },
    });
    const replicaKill = createCanonical003KillSwitch({
      handleProjectedInbound: (input) => probeOwner.handleProjectedInbound(input),
    });
    const probed = await replicaKill({
      env: {
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        [ENV_LUNA_AUTO_SEND_ENABLED]: 'false',
        [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'false',
      },
      authority: { clientId: C, locationId: L, endpointId: E },
      envelope: { provider: 'microsoft_graph', provider_mailbox_id: MAILBOX, provider_message_id: SRC },
      projection: { status: 'already_projected', conversation_id: V },
    });
    assert.equal(probed.status, 'blocked');
    assert.equal(probed.reason, 'emergency_flags_off');
    assert.equal(author, 0);

    const { harness: hKill } = makeHarness({
      async verifyKillSwitch() {
        return { ok: false, reason: 'kill_switch_unproven' };
      },
    });
    const beforeOn = await execute(hKill);
    assert.equal(beforeOn.reason, 'kill_switch_unproven');
    assert.equal(beforeOn.invoked, 0);
  }

  console.log('[16] Hostile: replica Graph/HMAC/kill-switch; unwired fails before dispatch');
  {
    const executeOnceSrc = libSrc.slice(
      libSrc.indexOf('async function executeOnce'),
      libSrc.indexOf('async function runStaffOwnerProof'),
    );
    const supervisorSrc = libSrc.slice(
      libSrc.indexOf('function createProductionMailMvp004Supervisor'),
      libSrc.indexOf('function inspectRepoReadiness'),
    );
    const runCliSrc = libSrc.slice(libSrc.indexOf('async function runCli'));
    assert.match(supervisorSrc, /execInner\(\{ graphVerify: true \}\)/);
    assert.match(supervisorSrc, /parseExactProductionGraphInnerExec\(executed\)/);
    assert.doesNotMatch(supervisorSrc, /sanitizeGraphPublic\(executed\.inner\)/);
    assert.match(supervisorSrc, /execInner\(\{\s*snapshot:\s*'evidence'\s*\}\)/);
    assert.match(supervisorSrc, /execInner\(\{\s*snapshot:\s*'reconcile'\s*\}\)/);
    assert.match(supervisorSrc, /execInner\(\{\s*snapshot:\s*'preflight'\s*\}\)/);
    assert.match(supervisorSrc, /execInner\(\{\s*channelModePut: value \}\)/);
    assert.match(supervisorSrc, /execInner\(\{ killSwitchProbe: true \}\)/);
    assert.doesNotMatch(supervisorSrc, /async putEmailChannelMode\(value\) \{\s*if \(typeof withPgClient/);
    assert.match(supervisorSrc, /executed\.status !== 0/);
    assert.match(supervisorSrc, /executed\.transportFailed === true/);
    assert.match(supervisorSrc, /classifyStaffOwnerExecResult/);
    assert.doesNotMatch(supervisorSrc, /getAccessToken/);
    assert.doesNotMatch(supervisorSrc, /createProductionReadonlyGraphListAdapter/);
    assert.doesNotMatch(supervisorSrc, /createCanonical003KillSwitch/);
    assert.doesNotMatch(supervisorSrc, /ENV_HMAC_SECRET|EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET/);
    assert.doesNotMatch(runCliSrc, /getAccessToken/);
    assert.match(runCliSrc, /runInnerGraphVerify/);
    assert.doesNotMatch(executeOnceSrc, /ENV_HMAC_SECRET|EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET/);
    assert.doesNotMatch(executeOnceSrc, /evidence_mac[\s\S]{0,120}snapshotSolMarker/);
    assert.match(executeOnceSrc, /replicaGraphAdapterAvailable/);
    assert.match(executeOnceSrc, /replicaEvidenceCapabilityAvailable/);
    assert.match(libSrc, /createDelegatedGrantAccessSession/);
    assert.match(libSrc, /runWithAccessTokenOnce/);
    assert.match(libSrc, /bindTrustedDelegatedGrantAccessSessionInternalStageObserver/);
    assert.match(libSrc, /readTrustedDelegatedGrantAccessSessionInternalStage/);
    assert.match(libSrc, /graph_grant_status_unavailable/);
    assert.match(libSrc, /graph_grant_lease_unavailable/);
    assert.match(libSrc, /graph_grant_open_unavailable/);
    assert.match(libSrc, /graph_client_secret_unavailable/);
    assert.match(libSrc, /graph_token_unavailable/);
    assert.match(libSrc, /graph_response_unavailable/);
    assert.match(libSrc, /graph_grant_reauth_required/);
    assert.match(libSrc, /graph_grant_reconcile_required/);
    assert.match(libSrc, /graph_grant_release_unavailable/);
    assert.match(libSrc, /classifyTrustedGraphGrantFailure/);
    assert.doesNotMatch(libSrc, /brandProductionGraphVerifier\(async \(\) => freeze\(\{\s*ok: false,\s*reason: 'graph_adapter_unwired'/);
    assert.deepEqual([...DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES], [
      'status', 'lease', 'open', 'secret', 'token', 'response',
      'dead_grant', 'reseal', 'commit', 'release',
    ]);
    assert.equal(GRAPH_GRANT_STAGE_REASON.status, 'graph_grant_status_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.lease, 'graph_grant_lease_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.open, 'graph_grant_open_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.secret, 'graph_client_secret_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.token, 'graph_token_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.response, 'graph_response_unavailable');
    assert.equal(GRAPH_GRANT_STAGE_REASON.dead_grant, 'graph_grant_reauth_required');
    assert.equal(GRAPH_GRANT_STAGE_REASON.reseal, 'graph_grant_reconcile_required');
    assert.equal(GRAPH_GRANT_STAGE_REASON.commit, 'graph_grant_reconcile_required');
    assert.equal(GRAPH_GRANT_STAGE_REASON.release, 'graph_grant_release_unavailable');
    for (const stage of DELEGATED_GRANT_ACCESS_SESSION_INTERNAL_STAGES) {
      assert.equal(typeof GRAPH_GRANT_STAGE_REASON[stage], 'string');
      assert.match(GRAPH_GRANT_STAGE_REASON[stage], /^graph_/);
    }

    assert.equal(replicaSolProven({
      evidence_mac: 'ab'.repeat(32),
      marker: SOL,
    }), false);
    assert.equal(replicaSolProven({
      evidence_verified: true,
      marker: SOL,
    }), true);
    assert.equal(replicaLeftover({ leftover: false }), false);
    assert.equal(replicaLeftover({ leftover: true, evidence_verified: true, marker: SOL }), true);

    const { harness: hUnwired, log: unwiredLog } = makeHarness({
      graph: {
        ok: false,
        reason: 'graph_adapter_unwired',
        adapter_available: false,
        readonly: false,
        arrivals: 0,
        duplicates: 0,
        threaded: false,
      },
    });
    const unwiredGraph = await execute(hUnwired);
    assert.equal(unwiredGraph.reason, 'graph_adapter_unwired');
    assert.equal(unwiredGraph.invoked, 0);
    assert.equal(unwiredLog.includes('flags:true'), false);
    assert.equal(unwiredLog.includes('invoke'), false);

    const { harness: hGrantDiag, log: grantDiagLog } = makeHarness({
      graph: {
        ok: false,
        reason: 'graph_grant_lease_unavailable',
        stage: 'lease',
        status: STATUS_UNAVAILABLE,
        adapter_available: false,
        readonly: false,
        arrivals: 0,
        duplicates: 0,
        threaded: false,
      },
    });
    const grantDiagRefuse = await execute(hGrantDiag);
    assert.equal(grantDiagRefuse.reason, 'graph_grant_lease_unavailable');
    assert.equal(grantDiagRefuse.status, 'refused');
    assert.equal(grantDiagRefuse.invoked, 0);
    assert.equal(grantDiagRefuse.public.stage, 'lease');
    assert.equal(grantDiagRefuse.public.status, 'refused');
    assert.equal(grantDiagLog.includes('flags:true'), false);
    assert.equal(grantDiagLog.includes('mode:auto'), false);
    assert.equal(grantDiagLog.includes('invoke'), false);
    assert.doesNotMatch(JSON.stringify(grantDiagRefuse), /NEVER_LEAK|loan-token|grant_generation/);

    const { harness: hHmac, log: hmacLog } = makeHarness({
      evidence: {
        hmac_available: false,
        evidence_verified: false,
        leftover: false,
        reason: 'hmac_unwired',
      },
    });
    const unwiredHmac = await execute(hHmac);
    assert.equal(unwiredHmac.reason, 'hmac_unwired');
    assert.equal(unwiredHmac.invoked, 0);
    assert.equal(hmacLog.includes('flags:true'), false);

    const { harness: hZero, log: zeroLog } = makeHarness({
      graph: {
        ok: false,
        reason: 'graph_unproven',
        adapter_available: true,
        readonly: true,
        arrivals: 0,
        duplicates: 0,
        threaded: false,
      },
    });
    const zeroArrival = await execute(hZero);
    assert.equal(zeroLog.includes('flags:true'), true);
    assert.equal(zeroArrival.invoked, 1);
    assert.equal(zeroArrival.reason, 'graph_unproven');
    assert.equal(zeroArrival.restored, true);

    function innerPg(rows, extraRows) {
      return async (fn) => fn({
        async query(sql, params) {
          const n = String(sql).replace(/\s+/g, ' ');
          if (/FROM clients cl INNER JOIN conversations c/.test(n)) {
            assert.equal(params[0], PROOF_SENDER);
            return { rows };
          }
          if (/luna_email_open_draft/.test(n) && /message_text/.test(n)) {
            return { rows: extraRows || [] };
          }
          if (/inbox_channel_modes/.test(n) && /SELECT/.test(n)) {
            return { rows: [{ inbox_channel_modes: { email: 'off' } }] };
          }
          if (/tenant_email_outbound_send_journal/.test(n)) {
            return { rows: [{ n: extraRows && extraRows.length ? 1 : 0, sends: extraRows && extraRows.length ? 1 : 0 }] };
          }
          if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) {
            return { rows: [{ n: extraRows && extraRows.length ? 1 : 0 }] };
          }
          if (/JOIN bookings b/.test(n)) {
            return { rows: [{ n: 4 }] };
          }
          return { rows: [] };
        },
      });
    }

    const graphRow = threadRow({ inbound_internet_message_id: '<src@test>' });
    const graphMessages = [{
      id: 'graph-sent-1',
      conversationId: 'graph-thread-1',
      internetMessageId: '<out@test>',
      subject: 'Re: Testing 8 26',
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<src@test>' },
        { name: 'References', value: '<src@test>' },
      ],
    }];
    const seenGraph = [];
    const httpsOk = {
      request(opts, cb) {
        seenGraph.push(opts);
        assert.equal(opts.method, 'GET');
        assert.equal(opts.host, 'graph.microsoft.com');
        assert.equal(String(opts.path).includes('body'), false);
        assert.doesNotMatch(String(opts.path), /sendMail|\/send\b|bodyPreview/i);
        assert.match(opts.headers.Authorization, /^Bearer loan-token$/);
        assert.equal(opts.headers.Prefer, GRAPH_PREFER_IMMUTABLE_ID);
        assert.equal(opts.headers.Prefer, 'IdType="ImmutableId"');
        assert.match(String(opts.path), new RegExp(`/v1\\.0/users/${MAILBOX}/messages`));
        const { PassThrough } = require('node:stream');
        const res = new PassThrough();
        const req = new PassThrough();
        res.statusCode = 200;
        process.nextTick(() => {
          cb(res);
          res.end(JSON.stringify({ value: graphMessages }));
        });
        req.destroy = () => {};
        return req;
      },
    };
    const tokenLoan = {
      async runWithAccessTokenOnce(binding, consumer) {
        assert.equal(binding.clientId, C);
        assert.equal(binding.endpointId, E);
        assert.equal(Object.keys(binding).join(','), 'clientId,endpointId');
        const listed = await consumer({ accessToken: 'loan-token' });
        return { ok: true, grant_generation: 1, value: listed };
      },
    };
    const innerGraph = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow], [{
        approval_id: '55555555-5555-4555-8555-555555555555',
        message_text: THREAD_DRAFT,
        immutable_draft_id: 'graph-sent-1',
        send_invocation_count: 1,
        draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
      }]),
      tokenLoan,
      https: httpsOk,
    });
    function assertGraphReplicaDiag(result, expected) {
      assert.equal(result.token_present, expected.token_present === true);
      assert.equal(result.https_present, expected.https_present === true);
      assert.equal(result.request_built, expected.request_built === true);
      if (result.public && typeof result.public === 'object') {
        assert.equal(result.public.token_present, expected.token_present === true);
        assert.equal(result.public.https_present, expected.https_present === true);
        assert.equal(result.public.request_built, expected.request_built === true);
      }
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'accessToken'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'grant_generation'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'token_length'), false);
      assert.doesNotMatch(
        JSON.stringify(result),
        /loan-token|Bearer |access_token|refresh_token|NEVER_LEAK|ya29\.|InvalidAuthenticationToken/,
      );
    }

    assert.equal(innerGraph.ok, true);
    assert.equal(innerGraph.adapter_available, true);
    assert.equal(innerGraph.readonly, true);
    assert.equal(innerGraph.arrivals, 1);
    assert.equal(innerGraph.duplicates, 0);
    assert.equal(innerGraph.threaded, true);
    assert.equal(Object.prototype.hasOwnProperty.call(innerGraph, 'id'), false);
    assert.doesNotMatch(JSON.stringify(innerGraph), /loan-token|twoods@|graph-sent-1|Would you like/);
    assert.equal(seenGraph.length, 1);
    assertGraphReplicaDiag(innerGraph, {
      token_present: true,
      https_present: true,
      request_built: true,
    });
    const resanitizedGraph = sanitizeGraphPublic(innerGraph.public);
    assertGraphReplicaDiag(resanitizedGraph, {
      token_present: true,
      https_present: true,
      request_built: true,
    });
    const clonedUnbranded = sanitizeGraphPublic(JSON.parse(JSON.stringify(innerGraph.public)));
    assert.equal(Object.prototype.hasOwnProperty.call(clonedUnbranded, 'token_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clonedUnbranded, 'https_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(clonedUnbranded, 'request_built'), false);
    assert.equal(parseExactProductionGraphInnerExec(JSON.parse(JSON.stringify(innerGraph.public))).reason, 'graph_adapter_unwired');
    assert.equal(parseExactProductionGraphInnerExec(JSON.parse(JSON.stringify(innerGraph.public))).adapter_available, false);

    const innerUnwired = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
    });
    assert.equal(innerUnwired.ok, false);
    assert.equal(innerUnwired.reason, 'graph_adapter_unwired');
    assert.equal(innerUnwired.adapter_available, false);
    assert.equal(Object.prototype.hasOwnProperty.call(innerUnwired, 'stage'), false);
    assertGraphReplicaDiag(innerUnwired, {
      token_present: false,
      https_present: false,
      request_built: false,
    });

    function assertGraphGrantDiag(result, stage, status) {
      const reason = GRAPH_GRANT_STAGE_REASON[stage];
      assert.equal(result.ok, false, stage);
      assert.equal(result.reason, reason, stage);
      assert.equal(result.stage, stage, stage);
      assert.equal(result.adapter_available, false, stage);
      assert.equal(result.readonly, false, stage);
      if (status) assert.equal(result.status, status, stage);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'grant_generation'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'accessToken'), false);
      assert.doesNotMatch(JSON.stringify(result), /NEVER_LEAK|loan-token|refresh_token|ya29\./);
      assert.doesNotMatch(JSON.stringify(result.public || {}), /NEVER_LEAK|loan-token|refresh_token/);
      assertGraphReplicaDiag(result, {
        token_present: false,
        https_present: false,
        request_built: false,
      });
    }

    const forgedGrant = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: {
        async runWithAccessTokenOnce() {
          return {
            ok: false,
            reason: 'graph_grant_status_unavailable',
            stage: 'status',
            status: STATUS_UNAVAILABLE,
            grant_generation: 8877,
            accessToken: 'loan-token',
            refresh_token: GRAPH_OLD_RT,
            body: GRAPH_PLANTED,
          };
        },
      },
    });
    assert.equal(forgedGrant.reason, 'graph_adapter_unwired');
    assert.equal(forgedGrant.adapter_available, false);
    assert.equal(Object.prototype.hasOwnProperty.call(forgedGrant, 'stage'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(forgedGrant, 'grant_generation'), false);
    assert.doesNotMatch(JSON.stringify(forgedGrant), /loan-token|8877|NEVER_LEAK/);
    assertGraphReplicaDiag(forgedGrant, {
      token_present: false,
      https_present: false,
      request_built: false,
    });
    const forgedBitsInjected = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: {
        async runWithAccessTokenOnce() {
          return {
            ok: false,
            reason: 'graph_adapter_unwired',
            token_present: true,
            https_present: true,
            request_built: true,
            accessToken: 'loan-token',
            grant_generation: 99,
          };
        },
      },
    });
    assert.equal(forgedBitsInjected.reason, 'graph_adapter_unwired');
    assertGraphReplicaDiag(forgedBitsInjected, {
      token_present: false,
      https_present: false,
      request_built: false,
    });
    const forgedSanitizedBits = sanitizeGraphPublic({
      ok: false,
      reason: 'graph_adapter_unwired',
      token_present: true,
      https_present: true,
      request_built: true,
      accessToken: 'loan-token',
      grant_generation: 99,
    });
    assert.equal(forgedSanitizedBits.reason, 'graph_adapter_unwired');
    assert.equal(Object.prototype.hasOwnProperty.call(forgedSanitizedBits, 'token_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(forgedSanitizedBits, 'https_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(forgedSanitizedBits, 'request_built'), false);
    const forgedClassified = classifyTrustedGraphGrantFailure({
      target: {
        ok: false,
        reason: 'graph_grant_lease_unavailable',
        stage: 'lease',
        status: STATUS_UNAVAILABLE,
      },
    });
    assert.equal(forgedClassified.reason, 'graph_adapter_unwired');
    assert.equal(Object.prototype.hasOwnProperty.call(forgedClassified, 'stage'), false);
    const observerOnly = classifyTrustedGraphGrantFailure({ observedStage: 'token' });
    assert.equal(observerOnly.reason, 'graph_token_unavailable');
    assert.equal(observerOnly.stage, 'token');
    assert.equal(observerOnly.adapter_available, false);

    const statusLoan = await createGraphGrantSessionLoan({ noGrant: true });
    const statusDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: statusLoan,
    });
    assertGraphGrantDiag(statusDiag, 'status', STATUS_UNAVAILABLE);

    const leaseLoan = await createGraphGrantSessionLoan({ failLease: true });
    const leaseDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: leaseLoan,
    });
    assertGraphGrantDiag(leaseDiag, 'lease', STATUS_UNAVAILABLE);

    const fakeOpen = createFakeEmailGrantEnvelopeProvider();
    const openOp = crypto.randomUUID();
    const openSealed = await fakeSealRefreshToken(fakeOpen, {
      refreshToken: GRAPH_OLD_RT, clientId: C, endpointId: E,
      grantGeneration: 1, operationId: openOp,
    });
    const openLoan = await createGraphGrantSessionLoan({
      sealed: openSealed,
      opId: openOp,
      envelopeProvider: fakeOpen,
      failingProvider: Object.freeze({
        sealGrantPayload: (...a) => fakeOpen.sealGrantPayload(...a),
        openGrantPayload: async () => { throw new Error(GRAPH_PLANTED); },
        rewrapGrantDek: (...a) => fakeOpen.rewrapGrantDek(...a),
      }),
    });
    const openDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: openLoan,
    });
    assertGraphGrantDiag(openDiag, 'open', STATUS_UNAVAILABLE);

    const secretLoan = await createGraphGrantSessionLoan({
      secretProvider: frozenMethod('getClientSecret', async () => {
        throw new Error(GRAPH_PLANTED);
      }),
    });
    const secretDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: secretLoan,
    });
    assertGraphGrantDiag(secretDiag, 'secret', STATUS_UNCERTAIN);

    const tokenLoanFail = await createGraphGrantSessionLoan({
      transport: frozenMethod('postTokenForm', async () => {
        throw new Error(GRAPH_PLANTED);
      }),
    });
    const tokenDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: tokenLoanFail,
    });
    assertGraphGrantDiag(tokenDiag, 'token', STATUS_UNCERTAIN);

    const responseLoan = await createGraphGrantSessionLoan({
      transport: frozenMethod('postTokenForm', async () => Object.freeze({
        statusCode: 503,
        contentType: 'text/plain',
        body: GRAPH_PLANTED,
      })),
    });
    const responseDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: responseLoan,
    });
    assertGraphGrantDiag(responseDiag, 'response', STATUS_UNCERTAIN);

    const reauthLoan = await createGraphGrantSessionLoan({
      priorStatus: {
        client_id: C, endpoint_id: E,
        grant_generation: 3, grant_status: 'reauthorization_required',
        reconcile_state: 'needs_operator', grant_lease_token: null,
      },
    });
    const reauthDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: reauthLoan,
    });
    assertGraphGrantDiag(reauthDiag, 'dead_grant', STATUS_REAUTH);

    const fakeReseal = createFakeEmailGrantEnvelopeProvider();
    const resealOp = crypto.randomUUID();
    const resealSealed = await fakeSealRefreshToken(fakeReseal, {
      refreshToken: GRAPH_OLD_RT, clientId: C, endpointId: E,
      grantGeneration: 1, operationId: resealOp,
    });
    const resealLoan = await createGraphGrantSessionLoan({
      sealed: resealSealed,
      opId: resealOp,
      envelopeProvider: fakeReseal,
      failingProvider: Object.freeze({
        sealGrantPayload: async () => { throw new Error(GRAPH_PLANTED); },
        openGrantPayload: (...a) => fakeReseal.openGrantPayload(...a),
        rewrapGrantDek: (...a) => fakeReseal.rewrapGrantDek(...a),
      }),
    });
    const resealDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: resealLoan,
    });
    assertGraphGrantDiag(resealDiag, 'reseal', STATUS_UNCERTAIN);

    const commitLoan = await createGraphGrantSessionLoan({ failCommit: true });
    const commitDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: commitLoan,
    });
    assertGraphGrantDiag(commitDiag, 'commit', STATUS_UNCERTAIN);

    const realRelease = await createGraphGrantSessionLoan();
    const releaseLoan = {
      async runWithAccessTokenOnce(binding, consumer) {
        return realRelease.runWithAccessTokenOnce(binding, async () => {
          throw new Error(GRAPH_PLANTED);
        });
      },
    };
    const releaseDiag = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: releaseLoan,
    });
    assertGraphGrantDiag(releaseDiag, 'release');

    const inboundOnly = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: {
        async runWithAccessTokenOnce(_binding, consumer) {
          const listed = await consumer({ accessToken: 'loan-token' });
          return { ok: true, grant_generation: 1, value: listed };
        },
      },
      https: {
        request(opts, cb) {
          assert.equal(opts.headers.Prefer, GRAPH_PREFER_IMMUTABLE_ID);
          const { PassThrough } = require('node:stream');
          const res = new PassThrough();
          const req = new PassThrough();
          res.statusCode = 200;
          process.nextTick(() => {
            cb(res);
            res.end(JSON.stringify({
              value: [{
                id: SRC,
                conversationId: 'graph-thread-1',
                internetMessageId: '<src@test>',
                subject: 'Testing 8 26',
              }],
            }));
          });
          req.destroy = () => {};
          return req;
        },
      },
    });
    assert.equal(inboundOnly.adapter_available, true);
    assert.equal(inboundOnly.readonly, true);
    assert.equal(inboundOnly.arrivals, 0);
    assert.equal(inboundOnly.ok, false);
    assert.equal(inboundOnly.reason, 'graph_unproven');
    assert.notEqual(inboundOnly.reason, 'graph_adapter_unwired');

    function assertClosedGraphPublic(result, reason) {
      assert.equal(result.ok, false, reason);
      assert.equal(result.reason, reason);
      assert.notEqual(result.reason, 'graph_adapter_unwired');
      assert.equal(result.adapter_available, true);
      assert.equal(result.readonly, true);
      assert.equal(Object.prototype.hasOwnProperty.call(result, 'id'), false);
      assert.doesNotMatch(JSON.stringify(result), /loan-token|planted|InvalidAuthenticationToken|ECONNRESET|twoods@|Would you like|Bearer /);
    }

    function mockGraphHttps({ statusCode = 200, body, hang, networkError } = {}) {
      return {
        request(opts, cb) {
          assert.equal(opts.method, 'GET');
          assert.equal(opts.host, 'graph.microsoft.com');
          assert.equal(opts.headers.Prefer, GRAPH_PREFER_IMMUTABLE_ID);
          assert.equal(opts.headers.Prefer, 'IdType="ImmutableId"');
          assert.match(opts.headers.Authorization, /^Bearer loan-token$/);
          assert.match(String(opts.path), new RegExp(`/v1\\.0/users/${MAILBOX}/messages`));
          assert.doesNotMatch(String(opts.path), /bodyPreview|sendMail|\/send\b/i);
          assert.equal(Object.prototype.hasOwnProperty.call(opts, 'body'), false);
          const { PassThrough } = require('node:stream');
          const res = new PassThrough();
          const req = new PassThrough();
          req.destroy = () => {};
          if (hang === true) return req;
          process.nextTick(() => {
            if (networkError === true) {
              req.emit('error', new Error('ECONNRESET planted-provider-error'));
              return;
            }
            res.statusCode = statusCode;
            cb(res);
            res.end(typeof body === 'string' ? body : JSON.stringify(body));
          });
          return req;
        },
      };
    }

    async function runGraphCase(httpsImpl, extra) {
      return runInnerGraphVerify({
        env: {
          MAIL_MVP_004_GRAPH_VERIFY: '1',
          LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        },
        withPgClient: innerPg([graphRow], [{
          approval_id: '55555555-5555-4555-8555-555555555555',
          message_text: THREAD_DRAFT,
          immutable_draft_id: 'graph-sent-1',
          send_invocation_count: 1,
          draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
        }]),
        tokenLoan,
        https: httpsImpl,
        timers: extra && extra.timers,
      });
    }

    const plantedAuth = JSON.stringify({
      error: { code: 'InvalidAuthenticationToken', message: 'planted-provider-error' },
    });
    const auth401 = await runGraphCase(mockGraphHttps({ statusCode: 401, body: plantedAuth }));
    assertClosedGraphPublic(auth401, 'graph_auth_unproven');
    const auth403 = await runGraphCase(mockGraphHttps({ statusCode: 403, body: plantedAuth }));
    assertClosedGraphPublic(auth403, 'graph_auth_unproven');
    const http500 = await runGraphCase(mockGraphHttps({
      statusCode: 500,
      body: JSON.stringify({ error: { code: 'ServiceUnavailable', message: 'planted-provider-error' } }),
    }));
    assertClosedGraphPublic(http500, 'graph_unproven');
    const malformed = await runGraphCase(mockGraphHttps({ statusCode: 200, body: '{not-json planted-provider-error' }));
    assertClosedGraphPublic(malformed, 'graph_unproven');
    const missingValue = await runGraphCase(mockGraphHttps({
      statusCode: 200,
      body: { error: { code: 'Unknown', message: 'planted-provider-error' } },
    }));
    assertClosedGraphPublic(missingValue, 'graph_unproven');
    let timeoutMs = null;
    const timeoutGraph = await runGraphCase(mockGraphHttps({ hang: true }), {
      timers: {
        setTimeout(fn, ms) {
          timeoutMs = ms;
          fn();
          return 1;
        },
        clearTimeout() {},
      },
    });
    assert.equal(timeoutMs, GRAPH_GET_DEADLINE_MS);
    assertClosedGraphPublic(timeoutGraph, 'graph_unproven');
    const networkGraph = await runGraphCase(mockGraphHttps({ networkError: true }));
    assertClosedGraphPublic(networkGraph, 'graph_unproven');
    const emptyList = await runGraphCase(mockGraphHttps({ statusCode: 200, body: { value: [] } }));
    assertClosedGraphPublic(emptyList, 'graph_unproven');
    assert.equal(emptyList.arrivals, 0);

    const matchingList = await runGraphCase(mockGraphHttps({
      statusCode: 200,
      body: { value: graphMessages },
    }));
    assert.equal(matchingList.ok, true);
    assert.equal(matchingList.adapter_available, true);
    assert.equal(matchingList.readonly, true);
    assert.equal(matchingList.arrivals, 1);
    assert.equal(matchingList.duplicates, 0);
    assert.equal(matchingList.threaded, true);
    assert.equal(matchingList.reason, null);
    assert.doesNotMatch(JSON.stringify(matchingList), /loan-token|graph-sent-1|Would you like/);
    assertGraphReplicaDiag(matchingList, {
      token_present: true,
      https_present: true,
      request_built: true,
    });
    assertGraphReplicaDiag(auth401, {
      token_present: true,
      https_present: true,
      request_built: true,
    });
    assertGraphReplicaDiag(http500, {
      token_present: true,
      https_present: true,
      request_built: true,
    });

    const blankToken = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan: {
        async runWithAccessTokenOnce(_binding, consumer) {
          const listed = await consumer({ accessToken: '' });
          return { ok: true, grant_generation: 1, value: listed };
        },
      },
      https: httpsOk,
    });
    assert.equal(blankToken.reason, 'graph_adapter_unwired');
    assert.equal(blankToken.adapter_available, false);
    assertGraphReplicaDiag(blankToken, {
      token_present: false,
      https_present: false,
      request_built: false,
    });

    const noHttps = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow]),
      tokenLoan,
      https: {},
    });
    assert.equal(noHttps.reason, 'graph_adapter_unwired');
    assert.equal(noHttps.adapter_available, false);
    assertGraphReplicaDiag(noHttps, {
      token_present: true,
      https_present: false,
      request_built: true,
    });

    const requestUnbuilt = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([threadRow({
        inbound_internet_message_id: '<src@test>',
        graph_conversation_id: '',
      })]),
      tokenLoan,
      https: httpsOk,
    });
    assert.equal(requestUnbuilt.reason, 'graph_send_forbidden');
    assertGraphReplicaDiag(requestUnbuilt, {
      token_present: true,
      https_present: false,
      request_built: false,
    });

    const authSanitized = sanitizeGraphPublic({
      ok: false,
      reason: 'graph_auth_unproven',
      adapter_available: true,
      readonly: true,
      arrivals: 0,
      duplicates: 0,
      threaded: false,
    });
    assert.equal(authSanitized.reason, 'graph_auth_unproven');
    assert.equal(authSanitized.adapter_available, true);
    assert.equal(authSanitized.readonly, true);
    assert.equal(GRAPH_PREFER_IMMUTABLE_ID, 'IdType="ImmutableId"');
    assert.equal(GRAPH_GET_DEADLINE_MS, 10000);

    const emptyEvidence = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'evidence',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        [ENV_HMAC_SECRET]: HMAC_SECRET,
      },
      withPgClient: innerPg([graphRow]),
    });
    assert.equal(emptyEvidence.ok, true);
    assert.equal(emptyEvidence.hmac_available, true);
    assert.equal(emptyEvidence.evidence_verified, false);
    assert.equal(Object.prototype.hasOwnProperty.call(emptyEvidence, 'message_text'), false);

    const verifiedEvidence = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'evidence',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        [ENV_HMAC_SECRET]: HMAC_SECRET,
      },
      withPgClient: innerPg([graphRow], [{
        approval_id: '55555555-5555-4555-8555-555555555555',
        message_text: THREAD_DRAFT,
        immutable_draft_id: 'graph-sent-1',
        send_invocation_count: 1,
        draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
      }]),
    });
    assert.equal(verifiedEvidence.ok, true);
    assert.equal(verifiedEvidence.hmac_available, true);
    assert.equal(verifiedEvidence.evidence_verified, true);
    assert.equal(verifiedEvidence.leftover, false);
    assert.equal(verifiedEvidence.sol_model, 'gpt-5.6-sol');
    assert.equal(Object.prototype.hasOwnProperty.call(verifiedEvidence, 'message_text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(verifiedEvidence, 'evidence_mac'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(verifiedEvidence, 'immutable_draft_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(verifiedEvidence.public || {}, 'immutable_draft_id'), false);
    assert.doesNotMatch(JSON.stringify(verifiedEvidence.public || {}), /graph-sent-1/);

    const missingSecret = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'evidence',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: innerPg([graphRow], [{
        approval_id: '55555555-5555-4555-8555-555555555555',
        message_text: THREAD_DRAFT,
        draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
      }]),
    });
    assert.equal(missingSecret.reason, 'hmac_unwired');
    assert.equal(missingSecret.hmac_available, false);

    const hostCli = fs.readFileSync(path.join(ROOT, CLI_REL), 'utf8');
    assert.doesNotMatch(hostCli, /EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET/);
    assert.doesNotMatch(hostCli, /getAccessToken/);

    const proofErrorGraph = sanitizeGraphPublic({ ok: false, reason: 'proof_error' });
    assert.equal(proofErrorGraph.ok, false);
    assert.equal(proofErrorGraph.reason, 'graph_adapter_unwired');
    const authKeep = sanitizeGraphPublic({
      ok: false,
      reason: 'graph_auth_unproven',
      adapter_available: true,
      readonly: true,
    });
    assert.equal(authKeep.reason, 'graph_auth_unproven');
    assert.equal(authKeep.adapter_available, true);
    assert.equal(proofErrorGraph.adapter_available, false);
    assert.equal(Object.prototype.hasOwnProperty.call(proofErrorGraph, 'stage'), false);
    const stagedProofError = sanitizeGraphPublic({
      ok: false,
      reason: 'proof_error',
      stage: 'lease',
      status: STATUS_UNAVAILABLE,
    });
    assert.equal(stagedProofError.reason, 'graph_grant_lease_unavailable');
    assert.equal(stagedProofError.stage, 'lease');
    assert.equal(stagedProofError.status, STATUS_UNAVAILABLE);
    const closedLease = sanitizeGraphPublic({
      ok: false,
      reason: 'graph_grant_lease_unavailable',
      stage: 'lease',
      status: STATUS_UNAVAILABLE,
    });
    assert.equal(closedLease.reason, 'graph_grant_lease_unavailable');
    assert.equal(closedLease.stage, 'lease');

    async function throwingReleasePg(rows, extraRows) {
      return async (fn) => {
        const value = await innerPg(rows, extraRows)(fn);
        throw new Error('pool_release_failed');
      };
    }
    const teardownGraph = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: await throwingReleasePg([graphRow], [{
        approval_id: '55555555-5555-4555-8555-555555555555',
        message_text: THREAD_DRAFT,
        immutable_draft_id: 'graph-sent-1',
        send_invocation_count: 1,
        draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
      }]),
      tokenLoan,
      https: httpsOk,
      closePgPool: async () => {
        throw new Error('pool_close_failed');
      },
    });
    assert.equal(teardownGraph.ok, true);
    assert.equal(teardownGraph.adapter_available, true);
    assert.equal(teardownGraph.readonly, true);
    assert.equal(teardownGraph.arrivals, 1);
    assert.equal(teardownGraph.threaded, true);
    assert.doesNotMatch(JSON.stringify(teardownGraph), /proof_error|pool_release_failed|pool_close_failed/);

    const leaseThenTeardownLoan = await createGraphGrantSessionLoan({ failLease: true });
    const leaseThenTeardown = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: await throwingReleasePg([graphRow]),
      tokenLoan: leaseThenTeardownLoan,
      closePgPool: async () => {
        throw new Error('pool_close_failed');
      },
    });
    assertGraphGrantDiag(leaseThenTeardown, 'lease', STATUS_UNAVAILABLE);

    const beforeClassUnwired = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: async () => {
        throw new Error('connect_failed');
      },
    });
    assert.equal(beforeClassUnwired.ok, false);
    assert.equal(beforeClassUnwired.reason, 'graph_adapter_unwired');
    assert.equal(Object.prototype.hasOwnProperty.call(beforeClassUnwired, 'stage'), false);

    const queryThrowUnwired = await runInnerGraphVerify({
      env: {
        MAIL_MVP_004_GRAPH_VERIFY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: async (fn) => fn({
        async query() { throw new Error('query_failed'); },
      }),
    });
    assert.equal(queryThrowUnwired.reason, 'graph_adapter_unwired');

    const { harness: hGraphThrow, log: graphThrowLog } = makeHarness({
      async verifyGraphArrival() { throw new Error('proof_error'); },
    });
    const graphThrowRefuse = await execute(hGraphThrow);
    assert.equal(graphThrowRefuse.ok, false);
    assert.equal(graphThrowRefuse.status, 'refused');
    assert.equal(graphThrowRefuse.reason, 'graph_adapter_unwired');
    assert.equal(graphThrowRefuse.invoked, 0);
    assert.equal(graphThrowLog.includes('flags:true'), false);
    assert.equal(graphThrowLog.includes('mode:auto'), false);
    assert.equal(graphThrowLog.includes('invoke'), false);
    assert.doesNotMatch(JSON.stringify(graphThrowRefuse), /proof_error/);

    const { harness: hEvidenceThrow, log: evidenceThrowLog } = makeHarness({
      async readDurableEvidence() { throw new Error('proof_error'); },
    });
    const evidenceThrowRefuse = await execute(hEvidenceThrow);
    assert.equal(evidenceThrowRefuse.reason, 'snapshot_unproven');
    assert.equal(evidenceThrowRefuse.invoked, 0);
    assert.equal(evidenceThrowLog.includes('flags:true'), false);
    assert.equal(evidenceThrowLog.includes('invoke'), false);

    const { harness: hModeThrow, log: modeThrowLog } = makeHarness({
      async getEmailChannelMode() { throw new Error('proof_error'); },
    });
    const modeThrowRefuse = await execute(hModeThrow);
    assert.equal(modeThrowRefuse.reason, 'channel_mode_unproven');
    assert.equal(modeThrowRefuse.invoked, 0);
    assert.equal(modeThrowLog.includes('flags:true'), false);
    assert.equal(modeThrowLog.includes('mode:auto'), false);
    assert.equal(modeThrowLog.includes('invoke'), false);

    const { harness: hPutThrow, log: putThrowLog } = makeHarness({ modeThrow: true });
    const putThrowRefuse = await execute(hPutThrow);
    assert.equal(putThrowRefuse.reason, 'channel_mode_unproven');
    assert.equal(putThrowRefuse.invoked, 0);
    assert.equal(putThrowLog.includes('flags:true'), true);
    assert.equal(putThrowLog.includes('mode:auto'), true);
    assert.equal(putThrowLog.includes('invoke'), false);

    const { harness: hModeStuck, log: modeStuckLog } = makeHarness({
      async getEmailChannelMode() { return 'draft'; },
    });
    const modeStuckRefuse = await execute(hModeStuck);
    assert.equal(modeStuckRefuse.reason, 'channel_mode_unproven');
    assert.equal(modeStuckRefuse.invoked, 0);
    assert.equal(modeStuckLog.includes('flags:true'), true);
    assert.equal(modeStuckLog.includes('mode:auto'), true);
    assert.equal(modeStuckLog.includes('invoke'), false);

    const { harness: hGraphProofReason, log: graphProofLog } = makeHarness({
      graph: { ok: false, reason: 'proof_error' },
    });
    const graphProofRefuse = await execute(hGraphProofReason);
    assert.equal(graphProofRefuse.reason, 'graph_adapter_unwired');
    assert.equal(graphProofRefuse.invoked, 0);
    assert.equal(graphProofLog.includes('flags:true'), false);

    const innerGraphSrc = libSrc.slice(
      libSrc.indexOf('async function runInnerGraphVerify'),
      libSrc.indexOf('function createProductionMailMvp004Supervisor'),
    );
    assert.match(innerGraphSrc, /if \(classified\) return classified/);
    assert.match(innerGraphSrc, /observedStage/);
    assert.match(innerGraphSrc, /closePool/);
    assert.match(innerGraphSrc, /graph_auth_unproven/);
    assert.match(innerGraphSrc, /listed\.ok !== true/);
    assert.match(innerGraphSrc, /replicaBits\.token_present = token !== ''/);
    assert.match(innerGraphSrc, /replicaBits\.request_built = !!\(request && request\.method === 'GET'\)/);
    assert.match(innerGraphSrc, /replicaBits\.https_present = !!\(httpsImpl && typeof httpsImpl\.request === 'function'\)/);
    assert.match(libSrc, /const GRAPH_INNER_REPLICA_DIAG = new WeakSet/);
    assert.match(libSrc, /function readBrandedGraphInnerReplicaBits/);
    assert.doesNotMatch(innerGraphSrc, /token\.length|accessToken\.length|loan-token/);
    assert.ok(
      innerGraphSrc.indexOf("replicaBits.token_present = token !== ''")
        < innerGraphSrc.indexOf('buildReadonlyGraphListRequest'),
    );
    assert.ok(
      innerGraphSrc.indexOf('replicaBits.request_built')
        < innerGraphSrc.indexOf('httpsGraphGet(httpsImpl, token, request'),
    );
    assert.ok(
      innerGraphSrc.indexOf('replicaBits.https_present')
        < innerGraphSrc.indexOf('httpsGraphGet(httpsImpl, token, request'),
    );
    assert.match(libSrc, /GRAPH_PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"'/);
    assert.match(libSrc, /reason === 'graph_auth_unproven'/);
    assert.match(libSrc, /classifyClosedGraphHttpStatus/);
    assert.doesNotMatch(
      libSrc.slice(libSrc.indexOf('function parseGraphListMessages'), libSrc.indexOf('function classifyClosedGraphHttpStatus')),
      /return null/,
    );
    assert.match(executeOnceSrc, /return refusedRecord\('graph_adapter_unwired'\)/);
    assert.match(executeOnceSrc, /return refusedRecord\('snapshot_unproven'\)/);
    assert.match(executeOnceSrc, /return refusedRecord\('channel_mode_unproven'\)/);
    assert.match(executeOnceSrc, /try \{\s*await deps\.putEmailChannelMode\('auto'\);\s*\} catch \{\s*failedReason = 'channel_mode_unproven';\s*\}/);
    assert.ok(executeOnceSrc.indexOf('waitServingHealthy({ enabled: true, authorized: serving })')
      < executeOnceSrc.indexOf("await deps.putEmailChannelMode('auto')"));
    assert.ok(executeOnceSrc.indexOf("failedReason = 'channel_mode_unproven'")
      < executeOnceSrc.indexOf('invokeAutoOwner'));
    const storeSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-inbox-channel-mode.js'), 'utf8');
    assert.match(storeSrc, /settings->'inbox_channel_modes'/);
    assert.match(storeSrc, /SET settings = jsonb_set/);
    assert.match(storeSrc, /COALESCE\(settings, '\{\}'::jsonb\)/);
    assert.match(storeSrc, /WHERE id=\$1::uuid/);
    assert.doesNotMatch(storeSrc, /metadata->'inbox_channel_modes'/);
    assert.doesNotMatch(storeSrc, /SET metadata = jsonb_set/);
    assert.doesNotMatch(storeSrc, /information_schema|pg_catalog|to_regclass/);
    assert.match(storeSrc, /if \(!row\) throw unproven\(\)/);
    assert.match(supervisorSrc, /execInner\(\{\s*channelModePut: value \}\)/);
    assert.match(supervisorSrc, /executed\.inner\.channel_mode !== value/);
    assert.ok(executeOnceSrc.indexOf("return refusedRecord('graph_adapter_unwired')")
      < executeOnceSrc.indexOf('setEmergencyFlags(true)'));
    assert.doesNotMatch(
      executeOnceSrc.slice(executeOnceSrc.indexOf('} finally {')),
      /return refusedRecord\('graph_adapter_unwired'\)/,
    );
  }

  console.log('[17] Hostile: Azure CLI JSON extractor and ACR digest attestation');
  {
    const AZ_EXT_WARNING = [
      'WARNING: The command requires the extension containerapp. It will be installed first.',
      'WARNING: The behavior of this command has been altered by the following extension: containerapp',
    ].join('\n');
    const OTHER_DIGEST = `sha256:${'c'.repeat(64)}`;
    const REPLICA = `${REVISION}-abcde-fghij`;
    const appJson = {
      name: STAFF_APP,
      properties: {
        latestRevisionName: REVISION,
        latestReadyRevisionName: REVISION,
        runningStatus: 'Running',
        configuration: {
          ingress: { traffic: [{ revisionName: REVISION, weight: 100 }] },
        },
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'false' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'false' },
            ],
          }],
        },
      },
    };
    const revisionJson = {
      name: REVISION,
      properties: {
        healthState: 'Healthy',
        runningState: 'Running',
        provisioningState: 'Provisioned',
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'false' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'false' },
            ],
          }],
        },
      },
    };
    const replicaJson = [{
      name: REPLICA,
      properties: { runningState: 'Running', revisionName: REVISION },
    }];
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };

    const warningPrefixed = `${AZ_EXT_WARNING}\n${JSON.stringify(appJson, null, 2)}\n`;
    const parsedPrefixed = parseServingIdentity(warningPrefixed);
    assert.equal(parsedPrefixed.revision, REVISION);
    assert.equal(parsedPrefixed.imageTag, IMAGE_SHA);
    assert.equal(parsedPrefixed.trafficWeight, 100);
    assert.equal(parsedPrefixed.digest, null);

    const warningSuffixed = `${JSON.stringify(revisionJson, null, 2)}\nWARNING: Preview version of extension is enabled.\n`;
    const parsedSuffixed = parseRevisionShow(warningSuffixed);
    assert.equal(parsedSuffixed.revision, REVISION);
    assert.equal(parsedSuffixed.healthState, 'Healthy');
    assert.equal(parsedSuffixed.digest, null);

    const replicaPrefixed = `${AZ_EXT_WARNING}\n${JSON.stringify(replicaJson, null, 2)}\n`;
    const parsedReplica = parseRunningReplica(replicaPrefixed, REVISION);
    assert.equal(parsedReplica.replica, REPLICA);
    assert.equal(parsedReplica.revision, REVISION);

    const warningBraces = `WARNING: encountered {not json} in extension output\n${JSON.stringify(appJson, null, 2)}\n`;
    assert.equal(parseServingIdentity(warningBraces).revision, REVISION);
    assert.equal(extractAzureJson(`WARNING: {sneaky}\n${JSON.stringify({ ok: true })}\n`).ok, true);

    assert.equal(extractAzureJson('WARNING: only noise\n'), null);
    assert.equal(extractAzureJson(`${AZ_EXT_WARNING}\n{"name":`), null);
    assert.equal(extractAzureJson(`${JSON.stringify(appJson)}${JSON.stringify(appJson)}`), null);
    assert.equal(extractAzureJson(`${JSON.stringify(appJson)}\n${JSON.stringify(appJson)}`), null);
    assert.equal(extractAzureJson('not json at all'), null);
    assert.equal(extractAzureJson('{"name": unquoted}'), null);
    assert.equal(extractAzureJson('[1,2'), null);
    assert.equal(parseServingIdentity(`${AZ_EXT_WARNING}\n{"name":"${STAFF_APP}"}`), null);
    assert.equal(parseRevisionShow('WARNING: x\n{"name":'), null);
    const proxyJson = new Proxy(appJson, { get() { return STAFF_APP; } });
    assert.equal(extractAzureJson(proxyJson), null);
    assert.equal(parseServingIdentity(proxyJson), null);

    const acrArgs = buildAcrManifestDigestArgs(IMAGE_SHA);
    assert.deepEqual(acrArgs, [
      'acr', 'manifest', 'show-metadata',
      '--name', `${ACR_REPOSITORY}:${IMAGE_SHA}`,
      '--registry', ACR_REGISTRY,
      '-o', 'json',
    ]);
    assert.equal(buildAcrManifestDigestArgs('latest'), null);
    assert.equal(buildAcrManifestDigestArgs('not-a-sha'), null);
    assert.equal(acrArgs.includes('build'), false);
    assert.equal(acrArgs.includes('import'), false);
    assert.equal(acrArgs.includes('untag'), false);
    assert.equal(acrArgs.includes('delete'), false);
    assert.equal(IMAGE_REPOSITORY, `${ACR_REGISTRY}.azurecr.io/${ACR_REPOSITORY}`);

    assert.equal(parseAcrManifestDigest(JSON.stringify(acrJson), IMAGE_SHA).digest, DIGEST);
    assert.equal(parseAcrManifestDigest(JSON.stringify({ tags: [IMAGE_SHA] }), IMAGE_SHA), null);
    assert.equal(parseAcrManifestDigest(JSON.stringify({
      digest: OTHER_DIGEST,
      tags: [IMAGE_SHA],
    }), IMAGE_SHA).digest, OTHER_DIGEST);
    assert.equal(parseAcrManifestDigest(JSON.stringify({
      digest: DIGEST,
      tags: ['ffffffffffffffffffffaaaaaaaaaaaaaaaaaaaa'],
    }), IMAGE_SHA), null);
    assert.equal(parseAcrManifestDigest(JSON.stringify({
      digest: DIGEST,
      manifestDigest: OTHER_DIGEST,
      tags: [IMAGE_SHA],
    }), IMAGE_SHA), null);
    assert.equal(parseAcrManifestDigest(JSON.stringify([
      { digest: DIGEST, tags: [IMAGE_SHA] },
      { digest: OTHER_DIGEST, tags: [IMAGE_SHA] },
    ]), IMAGE_SHA), null);
    assert.equal(parseAcrManifestDigest('WARNING: x\n{"digest":', IMAGE_SHA), null);

    const appIdentity = parseServingIdentity(appJson);
    const revisionIdentity = parseRevisionShow(revisionJson);
    assert.equal(revisionIdentity.digest, null);
    assert.equal(mergeRevisionIntoServing(appIdentity, revisionIdentity), null);

    async function identityAz(overrides) {
      const calls = [];
      const azRun = async (args) => {
        calls.push(args.slice());
        if (typeof overrides === 'function') return overrides(args, calls);
        if (args[0] === 'acr') {
          return { status: 0, stdout: overrides && overrides.acr != null ? overrides.acr : JSON.stringify(acrJson, null, 2) };
        }
        if (args[1] === 'revision' && args[2] === 'show') {
          return {
            status: 0,
            stdout: overrides && overrides.revision != null
              ? overrides.revision
              : `${AZ_EXT_WARNING}\n${JSON.stringify(revisionJson, null, 2)}\n`,
          };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(replicaJson, null, 2)}\n` };
        }
        if (args[1] === 'show') {
          return {
            status: 0,
            stdout: overrides && overrides.app != null
              ? overrides.app
              : `${AZ_EXT_WARNING}\n${JSON.stringify(appJson, null, 2)}\n`,
          };
        }
        return { status: 1, stdout: '' };
      };
      const servingIdentity = await readProductionServingIdentity(azRun);
      return { servingIdentity, calls };
    }

    const green = await identityAz();
    assert.equal(green.servingIdentity.revision, REVISION);
    assert.equal(green.servingIdentity.imageTag, IMAGE_SHA);
    assert.equal(green.servingIdentity.digest, DIGEST);
    assert.equal(green.servingIdentity.trafficWeight, 100);
    assert.equal(green.servingIdentity.healthState, 'Healthy');
    assert.equal(green.servingIdentity.ready, true);
    assert.equal(green.servingIdentity.replica, REPLICA);
    assert.equal(green.calls.some((args) => args[0] === 'acr' && args.includes(ACR_REGISTRY)
      && args.includes(`${ACR_REPOSITORY}:${IMAGE_SHA}`)
      && args.includes('show-metadata')), true);
    assert.equal(green.calls.some((args) => args.includes('update') || args.includes('--set-env-vars')), false);

    const mismatch = await identityAz({
      revision: JSON.stringify({
        ...revisionJson,
        properties: { ...revisionJson.properties, imageDigest: DIGEST },
      }),
      acr: JSON.stringify({ digest: OTHER_DIGEST, tags: [IMAGE_SHA] }),
    });
    assert.equal(mismatch.servingIdentity, null);

    const missing = await identityAz({
      acr: JSON.stringify({ tags: [IMAGE_SHA], repository: ACR_REPOSITORY }),
    });
    assert.equal(missing.servingIdentity, null);

    const multiple = await identityAz({
      acr: JSON.stringify([
        { digest: DIGEST, tags: [IMAGE_SHA] },
        { digest: OTHER_DIGEST, tags: [IMAGE_SHA] },
      ]),
    });
    assert.equal(multiple.servingIdentity, null);

    const cliCalls = [];
    const cli = await runCli([
      COMMAND,
      '--deployment', SUNSET_DEPLOYMENT,
      '--tenant', SUNSET_TENANT,
      '--database', EXPECTED_DATABASE,
      '--resource-group', RG,
      '--app', STAFF_APP,
      '--revision', REVISION,
      '--image-tag', IMAGE_SHA,
      '--digest', DIGEST,
      '--confirm', CONFIRMATION_PHRASE,
      '--operator-nonce', nonce(),
      '--confirm-issued-at', ISSUED,
    ], {
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      azRun: async (args) => {
        cliCalls.push(args.slice());
        if (args.includes('update') || args.includes('--set-env-vars')) {
          throw new Error('flag_mutation_before_resolver');
        }
        if (args[0] === 'acr') return { status: 0, stdout: JSON.stringify(acrJson, null, 2) };
        if (args[1] === 'revision' && args[2] === 'show') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(revisionJson, null, 2)}\n` };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(replicaJson, null, 2)}\n` };
        }
        if (args[1] === 'show') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(appJson, null, 2)}\n` };
        }
        return { status: 1, stdout: '' };
      },
      nonceStore: new Set(),
      nowMs: NOW_MS,
      execGit: (args) => {
        if (args[0] === 'rev-parse' && args.includes('origin/master')) {
          return { status: 0, stdout: `${'f'.repeat(40)}\n` };
        }
        if (args[0] === 'cat-file') return { status: 0, stdout: '' };
        return { status: 0, stdout: `${IMAGE_SHA}\n` };
      },
    });
    assert.equal(cli.invoked, 0);
    assert.equal(cli.reason, 'head_not_origin_master');
    const acrIdx = cliCalls.findIndex((args) => args[0] === 'acr');
    const updateIdx = cliCalls.findIndex((args) => args.includes('update') || args.includes('--set-env-vars'));
    assert.ok(acrIdx >= 0);
    assert.equal(updateIdx, -1);
    assert.equal(cliCalls.some((args) => args[0] === 'acr' && args.includes('show-metadata')), true);

    const extractSrc = libSrc.slice(
      libSrc.indexOf('function extractAzureJson'),
      libSrc.indexOf('function parseRevisionShow'),
    );
    assert.match(extractSrc, /scanJsonValue/);
    assert.doesNotMatch(extractSrc, /lastIndexOf\(['"]\}['"]\)/);
    assert.doesNotMatch(extractSrc, /match\(/);
    assert.doesNotMatch(extractSrc, /replace\(/);
    const readSrc = libSrc.slice(
      libSrc.indexOf('async function readProductionServingIdentity'),
      libSrc.indexOf('async function waitServingHealthy'),
    );
    assert.match(readSrc, /resolveBoundAcrDigest/);
    assert.doesNotMatch(readSrc, /buildSetEnvArgs/);
    assert.doesNotMatch(readSrc, /--set-env-vars/);
    const executeOnceSrc = libSrc.slice(
      libSrc.indexOf('async function executeOnce'),
      libSrc.indexOf('async function runStaffOwnerProof'),
    );
    assert.ok(executeOnceSrc.indexOf('readServingIdentity') < executeOnceSrc.indexOf('setEmergencyFlags(true)'));
    const supervisorSrc = libSrc.slice(
      libSrc.indexOf('function createProductionMailMvp004Supervisor'),
      libSrc.indexOf('function inspectRepoReadiness'),
    );
    assert.match(supervisorSrc, /readProductionServingIdentity/);
    const runCliSrc = libSrc.slice(libSrc.indexOf('async function runCli'));
    assert.match(runCliSrc, /createProductionMailMvp004Supervisor/);
    const acrBuildSrc = libSrc.slice(
      libSrc.indexOf('function buildAcrManifestDigestArgs'),
      libSrc.indexOf('function parseAcrManifestDigestRow'),
    );
    assert.match(libSrc, /const ACR_REGISTRY = 'whstagingacr'/);
    assert.match(libSrc, /const ACR_REPOSITORY = 'luna-sunset-staff-api'/);
    assert.match(acrBuildSrc, /show-metadata/);
    assert.match(acrBuildSrc, /ACR_REGISTRY/);
    assert.match(acrBuildSrc, /ACR_REPOSITORY/);
    assert.doesNotMatch(acrBuildSrc, /'build'|'import'|'untag'|'delete'/);
  }

  console.log('[18] Hostile: RunningAtMaxScale is healthy only with replica evidence');
  {
    const AZ_EXT_WARNING = [
      'WARNING: The command requires the extension containerapp. It will be installed first.',
    ].join('\n');
    const REPLICA = `${REVISION}-abcde-fghij`;
    const appJson = {
      name: STAFF_APP,
      properties: {
        latestRevisionName: REVISION,
        latestReadyRevisionName: REVISION,
        runningStatus: 'Running',
        configuration: {
          ingress: { traffic: [{ revisionName: REVISION, weight: 100 }] },
        },
        template: {
          containers: [{
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'false' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'false' },
            ],
          }],
        },
      },
    };
    const liveRevisionJson = {
      id: `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/${RG}/providers/Microsoft.App/containerApps/${STAFF_APP}/revisions/${REVISION}`,
      name: REVISION,
      type: 'Microsoft.App/containerApps/revisions',
      properties: {
        active: true,
        createdTime: '2026-08-27T12:00:00.000Z',
        fqdn: `${REVISION}.${RG}.eastus.azurecontainerapps.io`,
        healthState: 'Healthy',
        provisioningState: 'Provisioned',
        runningState: 'RunningAtMaxScale',
        replicas: 1,
        template: {
          containers: [{
            name: STAFF_APP,
            image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
            env: [
              { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'false' },
              { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'false' },
            ],
          }],
          scale: { minReplicas: 1, maxReplicas: 1 },
        },
      },
    };
    const replicaJson = [{
      name: REPLICA,
      properties: { runningState: 'Running', revisionName: REVISION },
    }];
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };

    function revisionWith(patch) {
      return {
        ...liveRevisionJson,
        properties: {
          ...liveRevisionJson.properties,
          ...patch,
        },
      };
    }

    const parsedLive = parseRevisionShow(liveRevisionJson);
    assert.equal(parsedLive.runningState, 'RunningAtMaxScale');
    assert.equal(parsedLive.healthState, 'Healthy');
    assert.equal(parsedLive.provisioningState, 'Provisioned');
    assert.equal(parsedLive.replicas, 1);
    assert.equal(parsedLive.imageTag, IMAGE_SHA);
    assert.equal(parsedLive.ready, true);
    assert.equal(servingHealthyReady100({
      ...parsedLive,
      trafficWeight: 100,
      replica: REPLICA,
    }), true);

    const appIdentity = parseServingIdentity(appJson);
    assert.equal(appIdentity.trafficWeight, 100);
    assert.equal(appIdentity.latestReadyRevisionName, REVISION);
    const mergedLive = mergeRevisionIntoServing(
      { ...appIdentity, digest: DIGEST },
      { ...parsedLive, digest: DIGEST },
    );
    assert.equal(mergedLive.runningState, 'RunningAtMaxScale');
    assert.equal(mergedLive.ready, true);
    assert.equal(mergedLive.replicas, 1);
    assert.equal(mergedLive.trafficWeight, 100);
    assert.equal(servingHealthyReady100(mergedLive), true);

    assert.equal(parseRevisionShow(revisionWith({ replicas: 0 })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ replicas: 0 })).replicas, 0);
    assert.equal(mergeRevisionIntoServing(
      { ...appIdentity, digest: DIGEST },
      { ...parseRevisionShow(revisionWith({ replicas: 0 })), digest: DIGEST },
    ), null);

    const missingReplicas = revisionWith({});
    delete missingReplicas.properties.replicas;
    const parsedMissingReplicas = parseRevisionShow(missingReplicas);
    assert.equal(parsedMissingReplicas.runningState, 'RunningAtMaxScale');
    assert.equal(parsedMissingReplicas.replicas, null);
    assert.equal(parsedMissingReplicas.ready, false);
    assert.equal(mergeRevisionIntoServing(
      { ...appIdentity, digest: DIGEST },
      { ...parsedMissingReplicas, digest: DIGEST },
    ), null);

    assert.equal(parseRevisionShow(revisionWith({ replicas: '1' })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ replicas: '1' })).replicas, null);
    assert.equal(parseRevisionShow(revisionWith({ replicas: true })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ replicas: 1.5 })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ replicas: -1 })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({
      runningState: ' RunningAtMaxScale',
    })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({
      runningState: 'Running (at max)',
    })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({
      runningState: 'runningatmaxscale',
    })).ready, false);

    const unsafeStates = [
      'Degraded', 'Failed', 'Stopped', 'Processing', 'Activating',
      'Scaling', 'Unknown', 'Deactivating', 'ActivationFailed',
    ];
    for (const runningState of unsafeStates) {
      const parsedUnsafe = parseRevisionShow(revisionWith({ runningState, replicas: 1 }));
      assert.equal(parsedUnsafe.ready, false, runningState);
      assert.equal(parsedUnsafe.runningState, runningState);
      assert.equal(mergeRevisionIntoServing(
        { ...appIdentity, digest: DIGEST },
        { ...parsedUnsafe, digest: DIGEST, ready: true },
      ), null, runningState);
      assert.equal(servingHealthyReady100({
        ...parsedUnsafe,
        trafficWeight: 100,
        ready: true,
        replica: REPLICA,
      }), false, runningState);
    }
    const emptyRunning = parseRevisionShow(revisionWith({ runningState: '', replicas: 1 }));
    assert.equal(emptyRunning.ready, false);
    assert.equal(emptyRunning.runningState, null);

    assert.equal(parseRevisionShow(revisionWith({ healthState: 'Unhealthy' })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ healthState: 'None' })).ready, false);
    const missingHealth = revisionWith({});
    delete missingHealth.properties.healthState;
    assert.equal(parseRevisionShow(missingHealth).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ healthState: true })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ provisioningState: 'Failed' })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ provisioningState: 'Provisioning' })).ready, false);
    assert.equal(parseRevisionShow(revisionWith({ runningState: 'Stopped', replicas: 1 })).ready, false);

    assert.equal(parseRunningReplica(JSON.stringify([{
      name: REPLICA,
      properties: { runningState: 'RunningAtMaxScale', revisionName: REVISION },
    }]), REVISION), null);
    assert.equal(parseRunningReplica('[]', REVISION), null);
    assert.equal(parseRunningReplica('', REVISION), null);

    async function identityAz(overrides) {
      const calls = [];
      const azRun = async (args) => {
        calls.push(args.slice());
        if (typeof overrides === 'function') return overrides(args, calls);
        if (args[0] === 'acr') {
          return { status: 0, stdout: overrides && overrides.acr != null ? overrides.acr : JSON.stringify(acrJson, null, 2) };
        }
        if (args[1] === 'revision' && args[2] === 'show') {
          return {
            status: 0,
            stdout: overrides && overrides.revision != null
              ? overrides.revision
              : `${AZ_EXT_WARNING}\n${JSON.stringify(liveRevisionJson, null, 2)}\n`,
          };
        }
        if (args[1] === 'replica') {
          if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'replicas')) {
            return { status: 0, stdout: overrides.replicas };
          }
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(replicaJson, null, 2)}\n` };
        }
        if (args[1] === 'show') {
          return {
            status: 0,
            stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(appJson, null, 2)}\n`,
          };
        }
        return { status: 1, stdout: '' };
      };
      const servingIdentity = await readProductionServingIdentity(azRun);
      return { servingIdentity, calls };
    }

    const green = await identityAz();
    assert.equal(green.servingIdentity.revision, REVISION);
    assert.equal(green.servingIdentity.imageTag, IMAGE_SHA);
    assert.equal(green.servingIdentity.digest, DIGEST);
    assert.equal(green.servingIdentity.trafficWeight, 100);
    assert.equal(green.servingIdentity.healthState, 'Healthy');
    assert.equal(green.servingIdentity.runningState, 'RunningAtMaxScale');
    assert.equal(green.servingIdentity.replicas, 1);
    assert.equal(green.servingIdentity.ready, true);
    assert.equal(green.servingIdentity.replica, REPLICA);
    assert.equal(green.calls.some((args) => args[0] === 'acr' && args.includes('show-metadata')), true);
    assert.equal(green.calls.some((args) => args[1] === 'replica' && args[2] === 'list'), true);
    assert.equal(green.calls.some((args) => args.includes('update') || args.includes('--set-env-vars')), false);
    const showIdx = green.calls.findIndex((args) => args[1] === 'show' && !args.includes('revision'));
    const revIdx = green.calls.findIndex((args) => args[1] === 'revision' && args[2] === 'show');
    const acrIdx = green.calls.findIndex((args) => args[0] === 'acr');
    const replicaIdx = green.calls.findIndex((args) => args[1] === 'replica');
    assert.ok(showIdx >= 0 && revIdx > showIdx && acrIdx > revIdx && replicaIdx > acrIdx);

    const zeroRevision = await identityAz({
      revision: JSON.stringify(revisionWith({ replicas: 0 })),
    });
    assert.equal(zeroRevision.servingIdentity, null);

    const missingRevisionReplicas = await identityAz({
      revision: JSON.stringify(missingReplicas),
    });
    assert.equal(missingRevisionReplicas.servingIdentity, null);

    const emptyReplicaList = await identityAz({ replicas: '[]' });
    assert.equal(emptyReplicaList.servingIdentity, null);
    assert.equal(emptyReplicaList.calls.some((args) => args[1] === 'replica'), true);

    const missingReplicaList = await identityAz({ replicas: '' });
    assert.equal(missingReplicaList.servingIdentity, null);

    const coercedReplicaCount = await identityAz({
      revision: JSON.stringify(revisionWith({ replicas: '1' })),
    });
    assert.equal(coercedReplicaCount.servingIdentity, null);

    for (const runningState of ['Degraded', 'Failed', 'Stopped', 'Processing', 'Activating', 'Unknown']) {
      const refused = await identityAz({
        revision: JSON.stringify(revisionWith({ runningState, replicas: 1 })),
      });
      assert.equal(refused.servingIdentity, null, runningState);
    }

    const mismatchImage = await identityAz({
      revision: JSON.stringify(revisionWith({
        template: {
          containers: [{
            name: STAFF_APP,
            image: `${IMAGE_REPOSITORY}:${'c'.repeat(40)}`,
          }],
        },
      })),
    });
    assert.equal(mismatchImage.servingIdentity, null);

    const cliCalls = [];
    const cli = await runCli([
      COMMAND,
      '--deployment', SUNSET_DEPLOYMENT,
      '--tenant', SUNSET_TENANT,
      '--database', EXPECTED_DATABASE,
      '--resource-group', RG,
      '--app', STAFF_APP,
      '--revision', REVISION,
      '--image-tag', IMAGE_SHA,
      '--digest', DIGEST,
      '--confirm', CONFIRMATION_PHRASE,
      '--operator-nonce', nonce(),
      '--confirm-issued-at', ISSUED,
    ], {
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      azRun: async (args) => {
        cliCalls.push(args.slice());
        if (args.includes('update') || args.includes('--set-env-vars')) {
          throw new Error('flag_mutation_before_resolver');
        }
        if (args[0] === 'acr') return { status: 0, stdout: JSON.stringify(acrJson, null, 2) };
        if (args[1] === 'revision' && args[2] === 'show') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(liveRevisionJson, null, 2)}\n` };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(replicaJson, null, 2)}\n` };
        }
        if (args[1] === 'show') {
          return { status: 0, stdout: `${AZ_EXT_WARNING}\n${JSON.stringify(appJson, null, 2)}\n` };
        }
        return { status: 1, stdout: '' };
      },
      nonceStore: new Set(),
      nowMs: NOW_MS,
      execGit: (args) => {
        if (args[0] === 'rev-parse' && args.includes('origin/master')) {
          return { status: 0, stdout: `${'f'.repeat(40)}\n` };
        }
        if (args[0] === 'cat-file') return { status: 0, stdout: '' };
        return { status: 0, stdout: `${IMAGE_SHA}\n` };
      },
    });
    assert.equal(cli.invoked, 0);
    assert.notEqual(cli.reason, 'wrong_target');
    assert.equal(cli.reason, 'head_not_origin_master');
    assert.equal(cliCalls.some((args) => args.includes('update') || args.includes('--set-env-vars')), false);

    const healthySrc = libSrc.slice(
      libSrc.indexOf('function acceptedHealthyServingRunningState'),
      libSrc.indexOf('function servingHealthyReady100'),
    );
    assert.match(healthySrc, /RunningAtMaxScale/);
    assert.match(healthySrc, /hasPinnedReplicaEvidence/);
    const parseRevSrc = libSrc.slice(
      libSrc.indexOf('function parseRevisionShow'),
      libSrc.indexOf('function parseServingIdentity'),
    );
    assert.match(parseRevSrc, /typedReplicaCount/);
    assert.match(parseRevSrc, /acceptedHealthyServingRunningState/);
    const mergeSrc = libSrc.slice(
      libSrc.indexOf('function mergeRevisionIntoServing'),
      libSrc.indexOf('function buildSetEnvArgs'),
    );
    assert.match(mergeSrc, /acceptedHealthyServingRunningState/);
    assert.doesNotMatch(mergeSrc, /runningState !== 'Running'/);
    const readSrc = libSrc.slice(
      libSrc.indexOf('async function readProductionServingIdentity'),
      libSrc.indexOf('async function waitServingHealthy'),
    );
    assert.ok(readSrc.indexOf('mergeRevisionIntoServing') < readSrc.indexOf('buildReplicaListArgs'));
    assert.ok(readSrc.indexOf('buildReplicaListArgs') < readSrc.indexOf('parseRunningReplica'));
    assert.match(readSrc, /resolveBoundAcrDigest/);
    assert.doesNotMatch(readSrc, /--set-env-vars/);
  }

  console.log('[19] RED→GREEN: Sunset booking snapshot uses conversation guest, not missing column');
  {
    assert.equal(isCanonicalGuestBookingCountSql(SQL_COUNT_BOOKINGS), true);
    assert.equal(sqlMentionsBookingsConversationId(SQL_COUNT_BOOKINGS), false);
    assert.doesNotMatch(SQL_COUNT_BOOKINGS, /\bFROM bookings\b/);
    assert.doesNotMatch(SQL_COUNT_BOOKINGS, /\bbookings\.conversation_id\b|\bb\.conversation_id\b/);
    assert.match(SQL_COUNT_BOOKINGS, /FROM conversations c/);
    assert.match(SQL_COUNT_BOOKINGS, /LEFT JOIN bookings b/);
    assert.match(SQL_COUNT_BOOKINGS, /b\.client_id=c\.client_id AND b\.guest_id=c\.guest_id/);
    assert.match(SQL_COUNT_BOOKINGS, /c\.guest_id IS NOT NULL/);
    assert.match(runbook, /client\/guest_id/);
    assert.match(runbook, /no `bookings\.conversation_id`/);

    const tables = sunsetBookingSchemaTables();
    const withPg = schemaShapedPg(tables);

    let redCode = null;
    try {
      await withPg((pg) => pg.query(LEGACY_BOOKINGS_CONVERSATION_SQL, [C, V]));
    } catch (error) {
      redCode = error && error.code;
    }
    assert.equal(redCode, '42703');

    const green = await snapshotSelectedOperation(withPg, threadRow());
    assert.equal(green.bookings, 4);
    assert.equal(green.approvals, 0);
    assert.equal(green.journals, 0);
    assert.equal(green.provider_sends, 0);
    assert.equal(Object.prototype.hasOwnProperty.call(green, 'guest_id'), false);
    assert.doesNotMatch(JSON.stringify(green), new RegExp(GUEST, 'i'));
    assert.doesNotMatch(JSON.stringify(green), /b1|other-guest|cross-client/);

    const unlinkedTables = sunsetBookingSchemaTables({
      conversations: [{ client_id: C, id: V, guest_id: null }],
    });
    const unlinked = await snapshotSelectedOperation(schemaShapedPg(unlinkedTables), threadRow({ guest_id: null }));
    assert.equal(unlinked, null);

    const missingTables = sunsetBookingSchemaTables({ conversations: [] });
    const missing = await snapshotSelectedOperation(schemaShapedPg(missingTables), threadRow());
    assert.equal(missing, null);

    const missingConvTables = sunsetBookingSchemaTables({
      conversations: [{ client_id: C, id: OTHER_CONVERSATION, guest_id: GUEST }],
    });
    const wrongConversation = await snapshotSelectedOperation(
      schemaShapedPg(missingConvTables),
      threadRow(),
    );
    assert.equal(wrongConversation, null);

    const crossClientRow = await snapshotSelectedOperation(withPg, threadRow({ client_id: OTHER_CLIENT }));
    assert.equal(crossClientRow, null);

    const ambiguousPg = async (fn) => fn({
      async query(sql) {
        const n = String(sql).replace(/\s+/g, ' ');
        if (/tenant_email_outbound_send_journal/.test(n)) return { rows: [{ n: 0, sends: 0 }] };
        if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) return { rows: [{ n: 0 }] };
        if (/JOIN bookings b/.test(n) || /FROM bookings\b/.test(n)) {
          return { rows: [{ n: 1 }, { n: 2 }] };
        }
        return { rows: [] };
      },
    });
    const ambiguous = await snapshotSelectedOperation(ambiguousPg, threadRow());
    assert.equal(ambiguous, null);

    const thrownPg = async (fn) => fn({
      async query(sql) {
        const n = String(sql).replace(/\s+/g, ' ');
        if (/JOIN bookings b/.test(n) || /FROM bookings\b/.test(n)) throw pgUndefinedColumn();
        if (/tenant_email_outbound_send_journal/.test(n)) return { rows: [{ n: 0, sends: 0 }] };
        if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) return { rows: [{ n: 0 }] };
        return { rows: [] };
      },
    });
    const caught = await snapshotSelectedOperation(thrownPg, threadRow());
    assert.equal(caught, null);

    const innerPreflight = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'preflight',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: schemaShapedPg(tables),
    });
    assert.equal(innerPreflight.ok, true);
    assert.equal(innerPreflight.bookings, 4);
    assert.equal(innerPreflight.guest_linked, true);
    assert.equal(Object.prototype.hasOwnProperty.call(innerPreflight, 'guest_id'), false);

    const innerUnlinked = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'preflight',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: schemaShapedPg(unlinkedTables, {
        threadRows: [threadRow({ guest_id: null })],
      }),
    });
    assert.equal(innerUnlinked.ok, false);
    assert.equal(innerUnlinked.reason, 'not_guest_linked');

    const innerMissing = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'preflight',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: schemaShapedPg(unlinkedTables, {
        threadRows: [threadRow()],
      }),
    });
    assert.equal(innerMissing.ok, false);
    assert.equal(innerMissing.reason, 'counts_unavailable');

    const box = { getOp: null };
    const { harness: deltaHarness, getOp, log: deltaLog } = makeHarness({
      invoke: brandProductionAutoOwner(async () => {
        const op = box.getOp();
        op.approvals = 1;
        op.journals = 1;
        op.provider_sends = 1;
        op.bookings += 1;
        return {
          status: 'sent',
          sent: true,
          approvals: 1,
          journals: 1,
          provider_sends: 1,
        };
      }),
    });
    box.getOp = getOp;
    const delta = await execute(deltaHarness);
    assert.equal(delta.ok, false);
    assert.equal(delta.reason, 'booking_side_effect');
    assert.equal(delta.invoked, 1);
    assert.equal(delta.restored, true);
    assert.equal(deltaLog.includes('flags:true'), true);
    assert.equal(deltaLog.includes('flags:false'), true);
  }

  console.log('[20] ACA exec command shape; nested quotes fail; PTY false-zero is unproven');
  {
    const os = require('node:os');
    const replica = `${REVISION}-abcde-fghij`;
    const attemptId = crypto.randomUUID();
    const killCmd = buildStaffOwnerRemoteCommand(attemptId, false, {
      killSwitchProbe: true,
      revision: REVISION,
    });
    assert.equal(isLegalStaffOwnerRemoteCommand(killCmd), true);
    assert.doesNotMatch(killCmd, /^sh\s+-c\b/);
    assert.doesNotMatch(killCmd, /'/);
    assert.doesNotMatch(killCmd, /"/);
    assert.doesNotMatch(killCmd, /[|><`$]/);
    assert.match(
      killCmd,
      new RegExp(
        `^/usr/bin/env MAIL_MVP_004_LIVE_PROOF=1 .*MAIL_MVP_004_KILL_SWITCH_PROBE=1 .* node ${PROOF_REMOTE_NODE.replace(/\./g, '\\.')}$`,
      ),
    );
    assert.match(killCmd, new RegExp(`MAIL_MVP_004_PROOF_ATTEMPT_ID=${attemptId}`));
    assert.doesNotMatch(killCmd, /MAIL_MVP_004_STAFF_OWNER_PROOF=1/);
    assert.doesNotMatch(killCmd, /LUNA_AUTO_SEND_ENABLED=true/);
    const envPayload = encodeProofEnvPayload(attemptId, false, {
      killSwitchProbe: true,
      revision: REVISION,
    });
    assert.match(Buffer.from(envPayload, 'base64').toString('utf8'), /MAIL_MVP_004_KILL_SWITCH_PROBE=1/);

    const syntax = spawnSync('/bin/sh', ['-n', '-c', killCmd], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);

    const acaWrapped = spawnSync('/bin/sh', ['-n', '-c', `sh -c '${killCmd}'`], { encoding: 'utf8' });
    assert.equal(acaWrapped.status, 0, acaWrapped.stderr);

    const splitNew = killCmd.split(' ');
    assert.equal(splitNew[0], '/usr/bin/env');
    assert.equal(splitNew[splitNew.length - 2], 'node');
    assert.equal(splitNew[splitNew.length - 1], PROOF_REMOTE_NODE);
    assert.equal(splitNew.some((token) => token.startsWith("'") || token.includes("'")), false);

    const analogOld = "sh -c 'printf %s hello'";
    assert.equal(isLegalStaffOwnerRemoteCommand(analogOld), false);
    const splitOld = analogOld.split(' ');
    assert.deepEqual(splitOld.slice(0, 4), ['sh', '-c', "'printf", '%s']);
    const splitOldRun = spawnSync(splitOld[0], splitOld.slice(1), { encoding: 'utf8' });
    assert.notEqual(splitOldRun.status, 0);
    assert.match(`${splitOldRun.stdout}${splitOldRun.stderr}`, /%s:.*[Uu]nterminated quoted string/);

    const analogWrap = spawnSync('/bin/sh', ['-c', `sh -c '${analogOld}'`], { encoding: 'utf8' });
    assert.notEqual(analogWrap.status, 0);

    const analogNew = spawnSync('/bin/sh', ['-c', `sh -c '${'/usr/bin/env printf %s hello'}'`], { encoding: 'utf8' });
    assert.equal(analogNew.status, 0);
    assert.equal(analogNew.stdout, 'hello');

    const azArgs = buildStaffOwnerExecAzArgs({
      attemptId,
      replica,
      revision: REVISION,
      killSwitchProbe: true,
    });
    assert.equal(azArgs[azArgs.indexOf('--replica') + 1], replica);
    assert.equal(azArgs[azArgs.indexOf('--revision') + 1], REVISION);
    assert.equal(azArgs[azArgs.indexOf('-g') + 1], RG);
    assert.equal(azArgs[azArgs.indexOf('-n') + 1], STAFF_APP);
    assert.equal(azArgs[azArgs.indexOf('--command') + 1], killCmd);
    assert.equal(azArgs.includes('--format'), false);

    const spec = wrapPtyAzExec(AZ_DEFAULT, azArgs);
    assert.equal(spec.bin, PTY_BIN);
    assert.deepEqual(spec.args.slice(0, 3), ['-q', '-e', '-c']);
    assert.equal(spec.args[4], '/dev/null');
    assert.equal(spec.replica, replica);
    assert.equal(spec.revision, REVISION);
    assert.match(spec.args[3], new RegExp(replica.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(spec.args[3], new RegExp(REVISION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(spec.azArgs[spec.azArgs.indexOf('--command') + 1], /^sh -c /);
    assert.throws(() => wrapPtyAzExec(AZ_DEFAULT, [
      'containerapp', 'exec', '-g', RG, '-n', STAFF_APP, '--command', killCmd,
    ]), /pty_required/);
    assert.throws(() => wrapPtyAzExec(AZ_DEFAULT, [
      'containerapp', 'exec', '-g', RG, '-n', STAFF_APP,
      '--replica', replica, '--revision', REVISION,
      '--command', killCmd, '-o', 'json',
    ]), /unsupported_exec_flag/);

    const spoofJson = JSON.stringify({
      ok: true,
      status: 'blocked',
      reason: 'emergency_flags_off',
      author_called: false,
      journal_called: false,
      provider_called: false,
    });
    const falseZero = classifyStaffOwnerExecResult({
      status: 0,
      stdout: '%s: line 0: syntax error: unterminated quoted string\n',
      stderr: `ClusterExecFailure: error executing command [sh -c \\u0027printf %s ${envPayload} ... ${PROOF_REMOTE_NODE}\\u0027]\n${spoofJson}\n`,
    });
    assert.equal(falseZero.ptyStatus, 0);
    assert.equal(falseZero.transportFailed, true);
    assert.equal(falseZero.status, 1);
    assert.equal(remoteExecTransportFailed(falseZero.out), true);
    assert.equal(falseZero.inner && falseZero.inner.ok, true);
    assert.equal(
      !falseZero || falseZero.status !== 0 || falseZero.transportFailed === true || !falseZero.inner
        || falseZero.inner.ok !== true
        || falseZero.inner.status !== 'blocked'
        || falseZero.inner.reason !== 'emergency_flags_off'
        ? 'kill_switch_unproven'
        : 'ok',
      'kill_switch_unproven',
    );

    const cleanKill = classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${spoofJson}\n`,
      stderr: '',
    });
    assert.equal(cleanKill.status, 0);
    assert.equal(cleanKill.transportFailed, false);
    assert.equal(cleanKill.inner.reason, 'emergency_flags_off');

    const classifiedJson = classifyStaffOwnerExecResult({
      status: 1,
      stdout: `${MUTATION_ISSUED_MARKER}\n${JSON.stringify({ ok: true, status: 'sent' })}\n`,
      stderr: 'WebSocket disconnected ClusterExecFailure\n',
    });
    assert.equal(classifiedJson.transportFailed, true);
    assert.equal(classifiedJson.status, 1);
    assert.equal(classifiedJson.marked, true);
    assert.equal(classifiedJson.inner && classifiedJson.inner.status, 'sent');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-mvp-004-exec-'));
    const fakeAz = path.join(dir, 'az');
    fs.writeFileSync(fakeAz, `#!/bin/sh
echo '%s: line 0: syntax error: unterminated quoted string'
echo 'ClusterExecFailure: command terminated with non-zero exit code: error executing command [sh -c \\u0027printf %s x\\u0027]'
echo '${spoofJson.replace(/'/g, '')}'
exit 0
`);
    fs.chmodSync(fakeAz, 0o755);
    const ptySpec = wrapPtyAzExec(fakeAz, azArgs);
    const ptyResult = spawnPtyHarness(ptySpec, { timeoutMs: 15000, env: process.env });
    assert.equal(ptySpec.bin, PTY_BIN);
    assert.equal(ptyResult.status, 0);
    const ptyClassified = classifyStaffOwnerExecResult(ptyResult);
    assert.equal(ptyClassified.ptyStatus, 0);
    assert.equal(ptyClassified.transportFailed, true);
    assert.equal(ptyClassified.status, 1);
    assert.match(ptyClassified.out, /unterminated quoted string/);
    assert.match(ptyClassified.out, /ClusterExecFailure/);
    const ptyKillReason = (
      !ptyClassified || ptyClassified.status !== 0 || ptyClassified.transportFailed === true || !ptyClassified.inner
        || ptyClassified.inner.ok !== true
        || ptyClassified.inner.status !== 'blocked'
        || ptyClassified.inner.reason !== 'emergency_flags_off'
    ) ? 'kill_switch_unproven' : 'ok';
    assert.equal(ptyKillReason, 'kill_switch_unproven');
    fs.rmSync(dir, { recursive: true, force: true });

    const { harness: hFalseZero } = makeHarness({
      async verifyKillSwitch() {
        return {
          ok: false,
          reason: 'kill_switch_unproven',
          author_called: false,
          journal_called: false,
          provider_called: false,
        };
      },
    });
    const publicRefuse = await execute(hFalseZero);
    assert.equal(publicRefuse.reason, 'kill_switch_unproven');
    assert.equal(publicRefuse.invoked, 0);
    assert.equal(publicRefuse.restored, undefined);
    assert.match(runbook, /quote-free/);
    assert.match(runbook, /ClusterExecFailure/);
    assert.match(libSrc, /isLegalStaffOwnerRemoteCommand/);
    assert.match(libSrc, /const command = `\/usr\/bin\/env \$\{assignments\.join\(' '\)\} node \$\{PROOF_REMOTE_NODE\}`/);
    assert.doesNotMatch(libSrc, /return `sh -c '/);
  }

  console.log('[21] Inner CLI stdout is sanitized structured JSON, never generic sent');
  {
    const os = require('node:os');
    assert.doesNotMatch(libSrc, /result\.public \|\| freeze\(\{ ok: true, status: 'sent' \}\)/);
    assert.match(libSrc, /function killSwitchPublic/);
    assert.match(libSrc, /function withInnerPublic/);
    assert.match(libSrc, /Never impersonate a Microsoft send/);
    assert.match(cliSrc, /console\.log\(JSON\.stringify\(emitPublic\(result\)\)\)/);
    assert.match(cliSrc, /sanitizeGraphPublic/);
    assert.match(cliSrc, /graphInnerExecStdoutOk/);
    assert.match(cliSrc, /MAIL_MVP_004_GRAPH_VERIFY === '1'/);
    const evidencePublicSrc = libSrc.slice(
      libSrc.indexOf('function evidencePublic'),
      libSrc.indexOf('function isKillSwitchShape'),
    );
    assert.doesNotMatch(evidencePublicSrc, /immutable_draft_id/);
    assert.doesNotMatch(evidencePublicSrc, /provider_message_id/);
    assert.doesNotMatch(evidencePublicSrc, /internetMessageId/);
    assert.match(libSrc, /function replicaEvidenceCapabilityAvailable/);
    assert.doesNotMatch(
      libSrc.slice(
        libSrc.indexOf('function replicaEvidenceCapabilityAvailable'),
        libSrc.indexOf('function replicaGraphAdapterAvailable'),
      ),
      /immutable_draft_id/,
    );

    const outerPub = publicProofOutput({
      ok: true,
      public: {
        ok: true,
        status: 'sent',
        reason: null,
        proof_version: 'mail_mvp_004_v1',
        invoked: 1,
        approvals: 1,
        journals: 1,
        provider_sends: 1,
        sent: true,
        restored: true,
        kill_switch: true,
        graph_threaded: true,
        duplicate: false,
        live_proof_blocked: false,
      },
    });
    assert.equal(outerPub.ok, true);
    assert.equal(outerPub.status, 'sent');
    assert.equal(outerPub.invoked, 1);
    assert.equal(outerPub.approvals, 1);
    assert.equal(outerPub.journals, 1);
    assert.equal(outerPub.provider_sends, 1);
    assert.equal(outerPub.sent, true);
    assert.equal(outerPub.kill_switch, true);
    assert.equal(outerPub.graph_threaded, true);
    assert.equal(outerPub.live_proof_blocked, false);

    const generic = publicProofOutput({ ok: true, secret_body: THREAD_DRAFT });
    assert.notEqual(generic.status, 'sent');
    assert.equal(Object.prototype.hasOwnProperty.call(generic, 'secret_body'), false);

    const killFallback = publicProofOutput({
      ok: true,
      status: 'blocked',
      reason: 'emergency_flags_off',
      author_called: false,
      journal_called: false,
      provider_called: false,
      provider_sends: 0,
    });
    assert.equal(killFallback.ok, true);
    assert.equal(killFallback.status, 'blocked');
    assert.equal(killFallback.reason, 'emergency_flags_off');
    assert.equal(killFallback.author_called, false);
    assert.equal(killFallback.journal_called, false);
    assert.equal(killFallback.provider_called, false);
    assert.notEqual(killFallback.status, 'sent');

    const graphFallback = publicProofOutput({
      ok: true,
      adapter_available: true,
      readonly: true,
      arrivals: 1,
      duplicates: 0,
      threaded: true,
      subject_ok: true,
    });
    assert.equal(graphFallback.ok, true);
    assert.equal(graphFallback.adapter_available, true);
    assert.equal(graphFallback.readonly, true);
    assert.equal(graphFallback.arrivals, 1);
    assert.notEqual(graphFallback.status, 'sent');

    const evidenceFallback = publicProofOutput({
      ok: true,
      hmac_available: true,
      evidence_verified: false,
      leftover: false,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      message_text: THREAD_DRAFT,
      immutable_draft_id: 'graph-sent-1',
      provider_message_id: 'graph-sent-1',
    });
    assert.equal(evidenceFallback.ok, true);
    assert.equal(evidenceFallback.hmac_available, true);
    assert.equal(evidenceFallback.evidence_verified, false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceFallback, 'message_text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceFallback, 'immutable_draft_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceFallback, 'provider_message_id'), false);
    assert.doesNotMatch(JSON.stringify(evidenceFallback), /immutable_draft_id/);
    assert.doesNotMatch(JSON.stringify(evidenceFallback), /graph-sent-1/);
    assert.notEqual(evidenceFallback.status, 'sent');

    function assertNoInnerLeak(raw) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      assert.doesNotMatch(text, /twoods@xantrion/i);
      assert.doesNotMatch(text, new RegExp(V, 'i'));
      assert.doesNotMatch(text, /Would you like to make a booking/);
      assert.doesNotMatch(text, /loan-token/);
      assert.doesNotMatch(text, /Bearer /);
      assert.doesNotMatch(text, /"message_text"/);
      assert.doesNotMatch(text, /"evidence_mac"/);
      assert.doesNotMatch(text, /"secret_body"/);
      assert.doesNotMatch(text, /"immutable_draft_id"/);
      assert.doesNotMatch(text, /"provider_message_id"/);
    }

    function spawnProofCli(env, fixture) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-mvp-004-cli-'));
      const preload = path.join(dir, 'preload.js');
      const fixturePath = path.join(dir, 'fixture.json');
      const consumedPath = path.join(dir, 'consumed.json');
      fs.writeFileSync(fixturePath, JSON.stringify(fixture || {}));
      fs.writeFileSync(preload, `'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
const target = ${JSON.stringify(LIB_ABS)};
const origLoad = Module._load;
let dispatched = false;
function currentCounts() {
  if (dispatched === true) {
    return { approvals: 1, journals: 1, provider_sends: 1, bookings: fixture.bookings == null ? 4 : fixture.bookings };
  }
  return {
    approvals: fixture.approvals || 0,
    journals: fixture.journals || 0,
    provider_sends: fixture.provider_sends || 0,
    bookings: fixture.bookings == null ? 4 : fixture.bookings,
  };
}
async function withPgClient(fn) {
  const value = await fn({
    async query(sql) {
      const n = String(sql).replace(/\\s+/g, ' ');
      const counts = currentCounts();
      if (/current_database/.test(n)) return { rows: [{ current_database: 'sunset_staging' }] };
      if (/FROM clients cl INNER JOIN conversations c/.test(n)) {
        return { rows: fixture.threadRows || [] };
      }
      if (/luna_email_open_draft/.test(n) && /message_text/.test(n)) {
        if (fixture.ownerSent === true && dispatched !== true) return { rows: [] };
        return { rows: fixture.evidenceRows || [] };
      }
      if (/inbox_channel_modes/.test(n) && /SELECT/.test(n)) {
        return { rows: [{ inbox_channel_modes: { email: fixture.channelMode || 'off' } }] };
      }
      if (/tenant_email_outbound_send_journal/.test(n)) {
        return { rows: [{ n: counts.journals, sends: counts.provider_sends }] };
      }
      if (/tenant_email_reply_approvals/.test(n) && /count/.test(n)) {
        return { rows: [{ n: counts.approvals }] };
      }
      if (/JOIN bookings b/.test(n)) {
        return { rows: [{ n: counts.bookings }] };
      }
      return { rows: [] };
    },
  });
  if (fixture.throwOnRelease === true) throw new Error('pool_release_failed');
  return value;
}
async function closePgPool() {
  if (fixture.throwOnClose === true) throw new Error('pool_close_failed');
}
Module._load = function(request, parent, isMain) {
  const loaded = origLoad.apply(this, arguments);
  let resolved = request;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}
  if (path.resolve(resolved) !== target) return loaded;
  const origRunCli = loaded.runCli;
  const inject = {
    withPgClient,
    closePgPool,
    consumedCapabilityPath: ${JSON.stringify(consumedPath)},
    dispatchReceiptPath: ${JSON.stringify(path.join(dir, 'dispatch-receipt.json'))},
  };
  if (fixture.killBlocked === true) {
    inject.wired = {
      handleProjectedInbound: async () => ({
        status: 'blocked',
        reason: 'emergency_flags_off',
        draft_writes: 0,
        approvals: 0,
        journals: 0,
        provider_sends: 0,
        sent: false,
        author_called: false,
        journal_called: false,
        provider_called: false,
      }),
    };
  }
  if (fixture.graphMessages) {
    inject.tokenLoan = {
      async runWithAccessTokenOnce(_binding, consumer) {
        return { ok: true, grant_generation: 1, value: await consumer({ accessToken: 'loan-token' }) };
      },
    };
    inject.https = {
      request(opts, cb) {
        const { PassThrough } = require('stream');
        const res = new PassThrough();
        const req = new PassThrough();
        res.statusCode = 200;
        process.nextTick(() => {
          cb(res);
          res.end(JSON.stringify({ value: fixture.graphMessages }));
        });
        req.destroy = () => {};
        return req;
      },
    };
  }
  if (fixture.graphBlankToken === true) {
    inject.tokenLoan = {
      async runWithAccessTokenOnce(_binding, consumer) {
        return { ok: true, grant_generation: 1, value: await consumer({ accessToken: '' }) };
      },
    };
    inject.https = { request() { throw new Error('graph_should_not_get'); } };
  }
  if (fixture.graphNoHttps === true) {
    inject.tokenLoan = {
      async runWithAccessTokenOnce(_binding, consumer) {
        return { ok: true, grant_generation: 1, value: await consumer({ accessToken: 'loan-token' }) };
      },
    };
    inject.https = {};
  }
  if (fixture.graphForgedBits === true) {
    inject.tokenLoan = {
      async runWithAccessTokenOnce() {
        return {
          ok: false,
          reason: 'graph_adapter_unwired',
          token_present: true,
          https_present: true,
          request_built: true,
          accessToken: 'loan-token',
          grant_generation: 99,
        };
      },
    };
  }
  if (fixture.ownerSent === true) {
    inject.wired = {
      handleProjectedInbound: loaded.brandProductionAutoOwner(async () => {
        dispatched = true;
        return {
          status: 'sent',
          sent: true,
          approvals: 1,
          journals: 1,
          provider_sends: 1,
        };
      }),
    };
  }
  return Object.assign({}, loaded, {
    runCli(argv, options) {
      if (fixture.forceGraphProofError === true) {
        return Promise.resolve({ ok: false, reason: 'proof_error' });
      }
      return origRunCli(argv, Object.assign({}, options, inject));
    },
  });
};
`);
      try {
        return spawnSync(process.execPath, ['-r', preload, CLI_REL], {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, NODE_OPTIONS: '', ...env },
          timeout: 20000,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    const thread = threadRow({ inbound_internet_message_id: '<src@test>' });
    const graphMessages = [{
      id: 'graph-sent-1',
      conversationId: 'graph-thread-1',
      internetMessageId: '<out@test>',
      subject: 'Re: Testing 8 26',
      internetMessageHeaders: [
        { name: 'In-Reply-To', value: '<src@test>' },
        { name: 'References', value: '<src@test>' },
      ],
    }];
    const evidenceRows = [{
      approval_id: '55555555-5555-4555-8555-555555555555',
      message_text: THREAD_DRAFT,
      immutable_draft_id: 'graph-sent-1',
      send_invocation_count: 1,
      draft_meta: { selected_operation_evidence: mintEvidence(THREAD_DRAFT) },
    }];

    const killSpawn = spawnProofCli({
      MAIL_MVP_004_KILL_SWITCH_PROBE: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      [ENV_LUNA_AUTO_SEND_ENABLED]: 'false',
      [ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED]: 'false',
    }, { threadRows: [thread], killBlocked: true });
    assert.equal(killSpawn.status, 0, `${killSpawn.stdout}${killSpawn.stderr}`);
    const killOut = extractProofJson(`${killSpawn.stdout}${killSpawn.stderr}`);
    assert.equal(killOut.ok, true);
    assert.equal(killOut.status, 'blocked');
    assert.equal(killOut.reason, 'emergency_flags_off');
    assert.equal(killOut.author_called, false);
    assert.equal(killOut.journal_called, false);
    assert.equal(killOut.provider_called, false);
    assert.notEqual(killOut.status, 'sent');
    assert.equal(JSON.stringify(killOut), killSpawn.stdout.trim());
    assertNoInnerLeak(killSpawn.stdout);
    assertNoInnerLeak(killOut);

    const preflightSpawn = spawnProofCli({
      MAIL_MVP_004_SNAPSHOT: 'preflight',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], bookings: 4, channelMode: 'off' });
    assert.equal(preflightSpawn.status, 0, `${preflightSpawn.stdout}${preflightSpawn.stderr}`);
    const preflightOut = extractProofJson(`${preflightSpawn.stdout}${preflightSpawn.stderr}`);
    assert.equal(preflightOut.ok, true);
    assert.equal(preflightOut.bookings, 4);
    assert.equal(preflightOut.guest_linked, true);
    assert.equal(preflightOut.approvals, 0);
    assert.equal(preflightOut.journals, 0);
    assert.equal(preflightOut.provider_sends, 0);
    assert.notEqual(preflightOut.status, 'sent');
    assert.equal(Object.prototype.hasOwnProperty.call(preflightOut, 'conversation_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(preflightOut, 'client_id'), false);
    assertNoInnerLeak(preflightSpawn.stdout);

    const countsSpawn = spawnProofCli({
      MAIL_MVP_004_SNAPSHOT: 'counts',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], approvals: 0, journals: 0, provider_sends: 0, bookings: 4 });
    assert.equal(countsSpawn.status, 0, `${countsSpawn.stdout}${countsSpawn.stderr}`);
    const countsOut = extractProofJson(`${countsSpawn.stdout}${countsSpawn.stderr}`);
    assert.equal(countsOut.ok, true);
    assert.equal(countsOut.approvals, 0);
    assert.equal(countsOut.journals, 0);
    assert.equal(countsOut.provider_sends, 0);
    assert.equal(countsOut.bookings, 4);
    assert.notEqual(countsOut.status, 'sent');
    assertNoInnerLeak(countsSpawn.stdout);

    const evidenceSpawn = spawnProofCli({
      MAIL_MVP_004_SNAPSHOT: 'evidence',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      [ENV_HMAC_SECRET]: HMAC_SECRET,
    }, { threadRows: [thread], evidenceRows });
    assert.equal(evidenceSpawn.status, 0, `${evidenceSpawn.stdout}${evidenceSpawn.stderr}`);
    const evidenceStdout = `${evidenceSpawn.stdout}${evidenceSpawn.stderr}`;
    const evidenceOut = extractProofJson(evidenceStdout);
    assert.equal(evidenceOut.ok, true);
    assert.equal(evidenceOut.hmac_available, true);
    assert.equal(evidenceOut.evidence_verified, true);
    assert.equal(evidenceOut.leftover, false);
    assert.equal(evidenceOut.sol_model, 'gpt-5.6-sol');
    assert.equal(evidenceOut.sol_provider, 'openai-codex');
    assert.equal(evidenceOut.sol_runtime, 'sunset-email-luna');
    assert.equal(typeof evidenceOut.approvals, 'number');
    assert.equal(typeof evidenceOut.journals, 'number');
    assert.equal(typeof evidenceOut.provider_sends, 'number');
    assert.notEqual(evidenceOut.status, 'sent');
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'message_text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'evidence_mac'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'immutable_draft_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'provider_message_id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'internetMessageId'), false);
    assert.doesNotMatch(evidenceStdout, /immutable_draft_id/);
    assert.doesNotMatch(evidenceStdout, /provider_message_id/);
    assert.doesNotMatch(evidenceStdout, /internetMessageId/);
    assert.doesNotMatch(evidenceStdout, /graph-sent-1/);
    assert.doesNotMatch(JSON.stringify(evidenceOut), /immutable_draft_id/);
    assert.doesNotMatch(JSON.stringify(evidenceOut), /graph-sent-1/);
    assertNoInnerLeak(evidenceSpawn.stdout);

    const graphRedSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread] });
    assert.notEqual(graphRedSpawn.status, 0);
    const graphRedOut = extractProofJson(`${graphRedSpawn.stdout}${graphRedSpawn.stderr}`);
    assert.equal(graphRedOut.ok, false);
    assert.equal(graphRedOut.reason, 'graph_adapter_unwired');
    assert.equal(graphRedOut.token_present, false);
    assert.equal(graphRedOut.https_present, false);
    assert.equal(graphRedOut.request_built, false);
    assert.equal(graphRedOut.adapter_available, false);
    assert.notEqual(graphRedOut.status, 'sent');
    assertNoInnerLeak(graphRedSpawn.stdout + graphRedSpawn.stderr);
    assert.doesNotMatch(`${graphRedSpawn.stdout}${graphRedSpawn.stderr}`, /loan-token|Bearer |access_token|grant_generation/);

    const graphSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], evidenceRows, graphMessages });
    assert.equal(graphSpawn.status, 0, `${graphSpawn.stdout}${graphSpawn.stderr}`);
    const graphOut = extractProofJson(`${graphSpawn.stdout}${graphSpawn.stderr}`);
    assert.equal(graphOut.ok, true);
    assert.equal(graphOut.adapter_available, true);
    assert.equal(graphOut.readonly, true);
    assert.equal(graphOut.arrivals, 1);
    assert.equal(graphOut.duplicates, 0);
    assert.equal(graphOut.threaded, true);
    assert.equal(graphOut.token_present, true);
    assert.equal(graphOut.https_present, true);
    assert.equal(graphOut.request_built, true);
    assert.notEqual(graphOut.status, 'sent');
    assertNoInnerLeak(graphSpawn.stdout);
    assert.doesNotMatch(`${graphSpawn.stdout}${graphSpawn.stderr}`, /loan-token|Bearer |access_token|grant_generation|token_length/);

    const graphUnprovenSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], graphMessages: [] });
    assert.equal(graphUnprovenSpawn.status, 0, `${graphUnprovenSpawn.stdout}${graphUnprovenSpawn.stderr}`);
    const graphUnprovenOut = extractProofJson(`${graphUnprovenSpawn.stdout}${graphUnprovenSpawn.stderr}`);
    assert.equal(graphUnprovenOut.ok, false);
    assert.equal(graphUnprovenOut.reason, 'graph_unproven');
    assert.equal(graphUnprovenOut.adapter_available, true);
    assert.equal(graphUnprovenOut.readonly, true);
    assert.equal(graphUnprovenOut.token_present, true);
    assert.equal(graphUnprovenOut.https_present, true);
    assert.equal(graphUnprovenOut.request_built, true);
    assert.equal(graphInnerExecStdoutOk(graphUnprovenOut), true);
    assertNoInnerLeak(graphUnprovenSpawn.stdout);

    const graphBlankSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], graphBlankToken: true });
    assert.notEqual(graphBlankSpawn.status, 0);
    const graphBlankOut = extractProofJson(`${graphBlankSpawn.stdout}${graphBlankSpawn.stderr}`);
    assert.equal(graphBlankOut.reason, 'graph_adapter_unwired');
    assert.equal(graphBlankOut.token_present, false);
    assert.equal(graphBlankOut.https_present, false);
    assert.equal(graphBlankOut.request_built, false);
    assertNoInnerLeak(graphBlankSpawn.stdout + graphBlankSpawn.stderr);

    const graphNoHttpsSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], graphNoHttps: true });
    assert.notEqual(graphNoHttpsSpawn.status, 0);
    const graphNoHttpsOut = extractProofJson(`${graphNoHttpsSpawn.stdout}${graphNoHttpsSpawn.stderr}`);
    assert.equal(graphNoHttpsOut.reason, 'graph_adapter_unwired');
    assert.equal(graphNoHttpsOut.token_present, true);
    assert.equal(graphNoHttpsOut.https_present, false);
    assert.equal(graphNoHttpsOut.request_built, true);
    assertNoInnerLeak(graphNoHttpsSpawn.stdout + graphNoHttpsSpawn.stderr);
    assert.doesNotMatch(`${graphNoHttpsSpawn.stdout}${graphNoHttpsSpawn.stderr}`, /loan-token|Bearer /);

    const graphForgedSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { threadRows: [thread], graphForgedBits: true });
    assert.notEqual(graphForgedSpawn.status, 0);
    const graphForgedOut = extractProofJson(`${graphForgedSpawn.stdout}${graphForgedSpawn.stderr}`);
    assert.equal(graphForgedOut.reason, 'graph_adapter_unwired');
    assert.equal(graphForgedOut.token_present, false);
    assert.equal(graphForgedOut.https_present, false);
    assert.equal(graphForgedOut.request_built, false);
    assert.doesNotMatch(`${graphForgedSpawn.stdout}${graphForgedSpawn.stderr}`, /loan-token|grant_generation|"99"/);

    const graphTeardownSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, {
      threadRows: [thread],
      evidenceRows,
      graphMessages,
      throwOnRelease: true,
      throwOnClose: true,
    });
    assert.equal(graphTeardownSpawn.status, 0, `${graphTeardownSpawn.stdout}${graphTeardownSpawn.stderr}`);
    const graphTeardownOut = extractProofJson(`${graphTeardownSpawn.stdout}${graphTeardownSpawn.stderr}`);
    assert.equal(graphTeardownOut.ok, true);
    assert.equal(graphTeardownOut.adapter_available, true);
    assert.equal(graphTeardownOut.arrivals, 1);
    assert.equal(graphTeardownOut.threaded, true);
    assert.doesNotMatch(`${graphTeardownSpawn.stdout}${graphTeardownSpawn.stderr}`, /proof_error/);
    assert.notEqual(graphTeardownOut.reason, 'proof_error');
    assertNoInnerLeak(graphTeardownSpawn.stdout);

    const graphProofErrorSpawn = spawnProofCli({
      MAIL_MVP_004_GRAPH_VERIFY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
    }, { forceGraphProofError: true });
    assert.notEqual(graphProofErrorSpawn.status, 0);
    const graphProofErrorOut = extractProofJson(`${graphProofErrorSpawn.stdout}${graphProofErrorSpawn.stderr}`);
    assert.equal(graphProofErrorOut.ok, false);
    assert.equal(graphProofErrorOut.reason, 'graph_adapter_unwired');
    assert.doesNotMatch(`${graphProofErrorSpawn.stdout}${graphProofErrorSpawn.stderr}`, /proof_error/);
    assert.notEqual(graphProofErrorOut.status, 'sent');
    assert.equal(Object.prototype.hasOwnProperty.call(graphProofErrorOut, 'token_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(graphProofErrorOut, 'https_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(graphProofErrorOut, 'request_built'), false);

    const cap = testCapability(Date.now());
    const ownerEnv = {
      MAIL_MVP_004_LIVE_PROOF: '1',
      MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
      EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
      EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
      LUNA_AUTO_SEND_ENABLED: 'true',
      LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      MAIL_MVP_004_CAPABILITY: encodeCapability(cap),
      MAIL_MVP_004_REVISION: REVISION,
      MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
      MAIL_MVP_004_DIGEST: DIGEST,
      [ENV_HMAC_SECRET]: HMAC_SECRET,
    };
    const ownerSpawn = spawnProofCli(ownerEnv, {
      threadRows: [thread],
      channelMode: 'auto',
      ownerSent: true,
      bookings: 4,
      evidenceRows,
    });
    const ownerOut = extractProofJson(`${ownerSpawn.stdout}${ownerSpawn.stderr}`);
    assert.equal(ownerSpawn.status, 0, `${ownerSpawn.stdout}${ownerSpawn.stderr}`);
    assert.equal(ownerOut.ok, true);
    assert.equal(ownerOut.status, 'sent');
    assert.equal(ownerOut.invoked, 1);
    assert.equal(ownerOut.approvals, 1);
    assert.equal(ownerOut.journals, 1);
    assert.equal(ownerOut.provider_sends, 1);
    assert.match(ownerSpawn.stdout, new RegExp(MUTATION_ISSUED_MARKER));
    assertNoInnerLeak(ownerOut);

    const recCap = testCapability(Date.now());
    const recSpawn = spawnProofCli({
      MAIL_MVP_004_LIVE_PROOF: '1',
      MAIL_MVP_004_RECONCILE_ONLY: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
      EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
      EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
      LUNA_AUTO_SEND_ENABLED: 'true',
      LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      MAIL_MVP_004_CAPABILITY: encodeCapability(recCap),
      MAIL_MVP_004_REVISION: REVISION,
      MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
      MAIL_MVP_004_DIGEST: DIGEST,
    }, { threadRows: [thread], channelMode: 'auto', approvals: 0, journals: 0, provider_sends: 0, bookings: 4 });
    const recOut = extractProofJson(`${recSpawn.stdout}${recSpawn.stderr}`);
    assert.notEqual(recSpawn.status, 0);
    assert.equal(recOut.ok, false);
    assert.equal(recOut.reason, 'reconcile_owner_state');
    assert.equal(recOut.reconcile, true);
    assert.equal(recOut.approvals, 0);
    assert.notEqual(recOut.status, 'sent');
    assertNoInnerLeak(recSpawn.stdout + recSpawn.stderr);
  }

  console.log('[22] Hostile: host Graph exact exec parser rebrands closed inner DTO only');
  {
    const exactInner = {
      ok: false,
      reason: 'graph_unproven',
      adapter_available: true,
      readonly: true,
      arrivals: 0,
      duplicates: 0,
      threaded: false,
      subject_ok: false,
      token_present: true,
      https_present: true,
      request_built: true,
    };
    const exactStdout = `${JSON.stringify(exactInner)}\n`;
    const classifiedExact = classifyStaffOwnerExecResult({
      status: 0,
      stdout: exactStdout,
      stderr: '',
    });
    const currentOuter = sanitizeGraphPublic(classifiedExact.inner);
    assert.equal(currentOuter.reason, 'graph_unproven');
    assert.equal(Object.prototype.hasOwnProperty.call(currentOuter, 'token_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(currentOuter, 'https_present'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(currentOuter, 'request_built'), false);

    const injectedExecuted = {
      status: 0,
      transportFailed: false,
      inner: JSON.parse(exactStdout),
      out: exactStdout,
    };
    const redInjected = parseExactProductionGraphInnerExec(injectedExecuted);
    assert.equal(redInjected.reason, 'graph_adapter_unwired');
    assert.equal(redInjected.adapter_available, false);
    assert.equal(redInjected.readonly, false);
    assert.equal(Object.prototype.hasOwnProperty.call(redInjected, 'token_present'), false);

    const clonedClassified = JSON.parse(JSON.stringify(classifiedExact));
    const redClone = parseExactProductionGraphInnerExec(clonedClassified);
    assert.equal(redClone.reason, 'graph_adapter_unwired');
    assert.equal(redClone.adapter_available, false);
    assert.equal(redClone.readonly, false);

    const green = parseExactProductionGraphInnerExec(classifiedExact);
    assert.equal(green.ok, false);
    assert.equal(green.reason, 'graph_unproven');
    assert.equal(green.adapter_available, true);
    assert.equal(green.readonly, true);
    assert.equal(green.token_present, true);
    assert.equal(green.https_present, true);
    assert.equal(green.request_built, true);
    assert.equal(closedGraphInnerDto(exactInner).fields.reason, 'graph_unproven');
    assert.equal(extractExactlyOneProofJson(exactStdout).reason, 'graph_unproven');
    assert.equal(graphInnerExecStdoutOk(exactInner), true);
    assert.doesNotMatch(JSON.stringify(green), /loan-token|Bearer |access_token|grant_generation/);

    const authInner = {
      ...exactInner,
      reason: 'graph_auth_unproven',
    };
    const authGreen = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify(authInner)}\n`,
    }));
    assert.equal(authGreen.reason, 'graph_auth_unproven');
    assert.equal(authGreen.adapter_available, true);
    assert.equal(authGreen.readonly, true);

    const bodyInner = {
      ...exactInner,
      reason: 'graph_body_leaked',
    };
    const bodyGreen = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify(bodyInner)}\n`,
    }));
    assert.equal(bodyGreen.reason, 'graph_body_leaked');
    assert.equal(bodyGreen.adapter_available, true);
    assert.equal(bodyGreen.readonly, true);

    const sendInner = {
      ...exactInner,
      reason: 'graph_send_forbidden',
      adapter_available: false,
      readonly: false,
      token_present: true,
      https_present: false,
      request_built: false,
    };
    const sendGreen = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify(sendInner)}\n`,
    }));
    assert.equal(sendGreen.reason, 'graph_send_forbidden');
    assert.equal(sendGreen.adapter_available, false);
    assert.equal(sendGreen.readonly, false);

    const malformed = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: '{"ok":false,"reason":"graph_unproven"',
    }));
    assert.equal(malformed.reason, 'graph_adapter_unwired');
    assert.equal(malformed.adapter_available, false);

    const multiple = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify(exactInner)}\n${JSON.stringify(exactInner)}\n`,
    }));
    assert.equal(multiple.reason, 'graph_adapter_unwired');
    assert.equal(multiple.adapter_available, false);
    assert.equal(extractExactlyOneProofJson(`${JSON.stringify(exactInner)}\n${JSON.stringify(exactInner)}\n`), null);

    const nonzero = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 1,
      stdout: exactStdout,
    }));
    assert.equal(nonzero.reason, 'graph_adapter_unwired');
    assert.equal(nonzero.adapter_available, false);
    assert.equal(nonzero.readonly, false);

    const clusterFail = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: exactStdout,
      stderr: 'ClusterExecFailure: command terminated with non-zero exit code: error executing command\n',
    }));
    assert.equal(clusterFail.reason, 'graph_adapter_unwired');
    assert.equal(clusterFail.adapter_available, false);
    assert.equal(clusterFail.readonly, false);

    const unexpectedKey = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({ ...exactInner, planted: true })}\n`,
    }));
    assert.equal(unexpectedKey.reason, 'graph_adapter_unwired');
    assert.equal(closedGraphInnerDto({ ...exactInner, planted: true }), null);

    const unexpectedType = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({ ...exactInner, adapter_available: 1 })}\n`,
    }));
    assert.equal(unexpectedType.reason, 'graph_adapter_unwired');

    const unexpectedReason = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({ ...exactInner, reason: 'graph_ok' })}\n`,
    }));
    assert.equal(unexpectedReason.reason, 'graph_adapter_unwired');

    const bitsWithoutAdapter = parseExactProductionGraphInnerExec(classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({
        ...exactInner,
        adapter_available: false,
        readonly: false,
      })}\n`,
    }));
    assert.equal(bitsWithoutAdapter.reason, 'graph_adapter_unwired');
    assert.equal(bitsWithoutAdapter.adapter_available, false);

    const supervisor = createProductionMailMvp004Supervisor({
      env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT },
      azRun: async () => ({ status: 1, stdout: '' }),
      withPgClient: async () => ({ rows: [] }),
    });
    assert.equal(typeof supervisor.verifyGraphArrival, 'function');
    const unwiredServing = await supervisor.verifyGraphArrival();
    assert.equal(unwiredServing.reason, 'graph_adapter_unwired');
    assert.equal(unwiredServing.adapter_available, false);
    assert.equal(unwiredServing.readonly, false);
  }

  console.log('[23] RED→GREEN: successor revision after flag update is the enabled proof');
  {
    const ENABLED_REV = `${STAFF_APP}--0000704`;
    const RESTORED_REV = `${STAFF_APP}--0000705`;
    const ENABLED_REPLICA = `${ENABLED_REV}-aaaaa-bbbbb`;
    const RESTORED_REPLICA = `${RESTORED_REV}-ccccc-ddddd`;
    const original = serving();
    const enabledIdent = serving({
      revision: ENABLED_REV,
      replica: ENABLED_REPLICA,
      flags: flagsOn(),
    });
    const restoredIdent = serving({
      revision: RESTORED_REV,
      replica: RESTORED_REPLICA,
      flags: flagsOff(),
    });
    const driftedIdent = serving({
      revision: ENABLED_REV,
      replica: ENABLED_REPLICA,
      imageTag: 'c'.repeat(40),
      deploySha: 'c'.repeat(40),
      digest: `sha256:${'d'.repeat(64)}`,
      flags: flagsOn(),
    });

    assert.equal(servingIdentityCompatible(original, enabledIdent), true);
    assert.equal(servingSuccessorAcceptable(original, enabledIdent), true);
    assert.equal(servingSuccessorAcceptable(original, restoredIdent), true);
    assert.equal(servingIdentityCompatible(original, driftedIdent), false);
    assert.equal(servingSuccessorAcceptable(original, driftedIdent), false);
    assert.equal(servingSuccessorAcceptable(null, enabledIdent), false);
    assert.equal(approvedFlagsOnly(flagsOn()), true);
    assert.equal(approvedFlagsOnly({ ...flagsOn(), EXTRA: 'true' }), false);
    assert.equal(approvedReplicaFlagsExact(enabledIdent, true), true);
    assert.equal(approvedReplicaFlagsExact({ ...enabledIdent, flagsSource: 'template' }, true), false);
    assert.equal(approvedReplicaFlagsExact({
      ...enabledIdent,
      flagsSource: FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
    }, true), true);
    assert.equal(approvedReplicaFlagsExact(restoredIdent, false), true);

    const { harness: hPin, log: pinLog } = makeHarness({ pinAuthorizedRevision: true });
    const red = await execute(hPin);
    assert.equal(red.ok, false);
    assert.equal(red.reason, 'enabled_revision_unproven');
    assert.equal(red.invoked, 0);
    assert.equal(red.restored, false);
    assert.equal(red.status, 'outcome_unknown');
    assert.equal(pinLog.includes('flags:true'), true);
    assert.equal(pinLog.includes('invoke'), false);
    assert.equal(pinLog.includes('flags:false'), true);

    const { harness: hGreen, log: greenLog, getServing, getMode } = makeHarness();
    const green = await execute(hGreen);
    assert.equal(green.ok, true);
    assert.equal(green.invoked, 1);
    assert.equal(green.restored, true);
    assert.equal(getMode(), 'off');
    assert.deepEqual(getServing().flags, flagsOff());
    assert.equal(approvedReplicaFlagsExact(getServing(), false), true);
    assert.notEqual(getServing().revision, REVISION);
    assert.equal(greenLog.filter((x) => x === 'invoke').length, 1);

    const drifted = await execute(makeHarness({
      waitServingHealthy() {
        return driftedIdent;
      },
    }).harness);
    assert.equal(drifted.reason, 'enabled_image_drift');
    assert.equal(drifted.invoked, 0);

    const envCmd = buildReplicaEnvRemoteCommand();
    assert.equal(isLegalReplicaEnvRemoteCommand(envCmd), true);
    assert.equal(envCmd, `/usr/bin/printenv ${ENV_LUNA_AUTO_SEND_ENABLED} ${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED}`);
    assert.doesNotMatch(envCmd, /sh\s+-c/);
    assert.doesNotMatch(envCmd, /'/);
    assert.doesNotMatch(envCmd, /[|><`$]/);
    assert.equal(isLegalReplicaEnvRemoteCommand(`sh -c '${envCmd}'`), false);
    const analogOld = `sh -c 'printenv ${ENV_LUNA_AUTO_SEND_ENABLED} ${ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED} || (tr '\\0' '\\n' < /proc/1/environ)'`;
    assert.equal(isLegalReplicaEnvRemoteCommand(analogOld), false);
    const envArgs = buildReplicaEnvExecAzArgs(enabledIdent);
    assert.equal(envArgs[envArgs.indexOf('--command') + 1], envCmd);
    assert.equal(envArgs[envArgs.indexOf('--revision') + 1], ENABLED_REV);
    assert.equal(envArgs[envArgs.indexOf('--replica') + 1], ENABLED_REPLICA);
    const envSyntax = spawnSync('/bin/sh', ['-n', '-c', envCmd], { encoding: 'utf8' });
    assert.equal(envSyntax.status, 0, envSyntax.stderr);
    const envWrapped = spawnSync('/bin/sh', ['-n', '-c', `sh -c '${envCmd}'`], { encoding: 'utf8' });
    assert.equal(envWrapped.status, 0, envWrapped.stderr);
    const splitEnv = envCmd.split(' ');
    assert.deepEqual(splitEnv, [
      '/usr/bin/printenv',
      ENV_LUNA_AUTO_SEND_ENABLED,
      ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
    ]);

    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };
    function revisionState(revisionName, flagValue) {
      const replicaName = `${revisionName}-abcde-fghij`;
      return {
        replicaName,
        app: {
          name: STAFF_APP,
          properties: {
            latestRevisionName: revisionName,
            latestReadyRevisionName: revisionName,
            runningStatus: 'Running',
            configuration: {
              ingress: { traffic: [{ revisionName, weight: 100 }] },
            },
            template: {
              containers: [{
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        revision: {
          name: revisionName,
          properties: {
            healthState: 'Healthy',
            runningState: 'Running',
            provisioningState: 'Provisioned',
            replicas: 1,
            imageDigest: DIGEST,
            template: {
              containers: [{
                name: STAFF_APP,
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        replicas: [{
          name: replicaName,
          properties: { runningState: 'Running', revisionName },
        }],
      };
    }
    function switchingState() {
      const ready = revisionState(REVISION, 'false');
      const next = revisionState(ENABLED_REV, 'true');
      return {
        replicaName: ready.replicaName,
        app: {
          ...ready.app,
          properties: {
            ...ready.app.properties,
            latestRevisionName: ENABLED_REV,
            latestReadyRevisionName: REVISION,
            configuration: {
              ingress: { traffic: [{ revisionName: REVISION, weight: 100 }] },
            },
          },
        },
        revision: ready.revision,
        replicas: ready.replicas,
        next,
      };
    }

    let phase = 'original';
    const azRun = async (args) => {
      if (args.includes('update') || args.includes('--set-env-vars')) {
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'acr') {
        return { status: 0, stdout: JSON.stringify(acrJson) };
      }
      const state = phase === 'enabled'
        ? revisionState(ENABLED_REV, 'true')
        : phase === 'restored'
          ? revisionState(RESTORED_REV, 'false')
          : phase === 'switching'
            ? switchingState()
            : revisionState(REVISION, 'false');
      if (args[1] === 'exec') {
        assert.equal(args[args.indexOf('--command') + 1], envCmd);
        if (phase === 'enabled') {
          assert.equal(args[args.indexOf('--revision') + 1], ENABLED_REV);
          return { status: 0, stdout: 'true\ntrue\n' };
        }
        if (phase === 'restored') {
          assert.equal(args[args.indexOf('--revision') + 1], RESTORED_REV);
          return { status: 0, stdout: 'false\nfalse\n' };
        }
        return { status: 0, stdout: 'false\nfalse\n' };
      }
      if (args[1] === 'revision' && args[2] === 'show') {
        return { status: 0, stdout: JSON.stringify(state.revision) };
      }
      if (args[1] === 'replica') {
        return { status: 0, stdout: JSON.stringify(state.replicas) };
      }
      if (args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify(state.app) };
      }
      return { status: 1, stdout: '' };
    };

    const missingAuth = await waitServingHealthy(azRun, {
      enabled: true,
      authorized: null,
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 10,
      intervalMs: 5,
    });
    assert.equal(missingAuth, null);

    let nowMs = 0;
    phase = 'original';
    const successorWait = await waitServingHealthy(azRun, {
      enabled: true,
      authorized: original,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        if (phase === 'original') phase = 'switching';
        else phase = 'enabled';
      },
    });
    assert.equal(successorWait.revision, ENABLED_REV);
    assert.ok(acceptedFlagSource(successorWait.flagsSource));
    assert.equal(approvedReplicaFlagsExact(successorWait, true), true);
    assert.equal(servingSuccessorAcceptable(original, successorWait), true);
    assert.ok(nowMs < REVISION_WAIT_TIMEOUT_MS);

    nowMs = 0;
    phase = 'enabled';
    const restoredWait = await waitServingHealthy(azRun, {
      enabled: false,
      authorized: original,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        if (phase === 'enabled') phase = 'restored';
      },
    });
    assert.equal(restoredWait.revision, RESTORED_REV);
    assert.ok(acceptedFlagSource(restoredWait.flagsSource));
    assert.equal(approvedReplicaFlagsExact(restoredWait, false), true);
    assert.equal(servingSuccessorAcceptable(original, restoredWait), true);

    const executeOnceSrc = libSrc.slice(
      libSrc.indexOf('async function executeOnce'),
      libSrc.indexOf('async function runStaffOwnerProof'),
    );
    assert.match(executeOnceSrc, /waitServingHealthy\(\{ enabled: true, authorized: serving \}\)/);
    assert.match(executeOnceSrc, /restoreSafe\(serving\)/);
    assert.match(executeOnceSrc, /enabled_revision_unproven/);
    const supervisorSrc = libSrc.slice(
      libSrc.indexOf('function createProductionMailMvp004Supervisor'),
      libSrc.indexOf('function inspectRepoReadiness'),
    );
    assert.match(supervisorSrc, /const authorized = input && input.authorized/);
    assert.doesNotMatch(supervisorSrc, /const authorized = await readServing\(\)/);
    assert.match(libSrc, /servingSuccessorAcceptable/);
    assert.match(libSrc, /isLegalReplicaEnvRemoteCommand/);
    assert.match(libSrc, /const REPLICA_ENV_PRINTENV = `\/usr\/bin\/printenv/);
    assert.doesNotMatch(libSrc, /\/proc\/1\/environ/);
    assert.match(runbook, /successor/);
    assert.match(runbook, /printenv/);
    assert.match(runbook, /immutable/);
    assert.match(libSrc, /FLAGS_SOURCE_ACA_IMMUTABLE_REVISION/);
    assert.match(libSrc, /proveAcaImmutableRevisionEnv/);
    assert.doesNotMatch(libSrc, /return `sh -c '/);
    assert.match(libSrc, /const REVISION_WAIT_TIMEOUT_MS = 10 \* 60 \* 1000/);
    assert.match(libSrc, /const REVISION_WAIT_INTERVAL_MS = 2000/);
    assert.match(libSrc, /const CONFIRM_WINDOW_MS = 15 \* 60 \* 1000/);
    assert.doesNotMatch(libSrc, /const REVISION_WAIT_TIMEOUT_MS = 180000/);
    assert.doesNotMatch(libSrc, /const REVISION_WAIT_TIMEOUT_MS = 20 \* 60 \* 1000/);
    assert.doesNotMatch(libSrc, /const REVISION_WAIT_TIMEOUT_MS = 15 \* 60 \* 1000/);
    assert.match(runbook, /10 minutes per successor/);
    assert.match(runbook, /2s identity poll/);
    assert.match(plan, /10 minutes per successor/);
    assert.match(plan, /immutable/);
  }

  console.log('[24] RED→GREEN: revision wait budget covers ACA successor; confirm window not widened');
  {
    assert.equal(REVISION_WAIT_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(REVISION_WAIT_INTERVAL_MS, 2000);
    assert.equal(CONFIRM_WINDOW_MS, 15 * 60 * 1000);
    assert.ok(REVISION_WAIT_TIMEOUT_MS > 3 * 60 * 1000);
    assert.ok(REVISION_WAIT_TIMEOUT_MS > 6 * 60 * 1000);
    assert.ok(REVISION_WAIT_TIMEOUT_MS < 15 * 60 * 1000);
    assert.ok(REVISION_WAIT_TIMEOUT_MS < 20 * 60 * 1000);

    const atEdge = authArgs({ confirmIssuedAt: new Date(NOW_MS - CONFIRM_WINDOW_MS).toISOString() });
    assert.equal(validateExactInvocation(atEdge, NOW_MS, new Set()), null);
    const pastEdge = authArgs({
      confirmIssuedAt: new Date(NOW_MS - CONFIRM_WINDOW_MS - 1).toISOString(),
    });
    assert.equal(validateExactInvocation(pastEdge, NOW_MS, new Set()), 'confirm_window_invalid');

    const ENABLED_REV = `${STAFF_APP}--0000706`;
    const RESTORED_REV = `${STAFF_APP}--0000707`;
    const original = serving();
    const envCmd = buildReplicaEnvRemoteCommand();
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };
    const driftedDigest = `sha256:${'e'.repeat(64)}`;
    const driftedTag = 'c'.repeat(40);
    function revisionState(revisionName, flagValue, image) {
      const replicaName = `${revisionName}-abcde-fghij`;
      const tag = image && image.tag ? image.tag : IMAGE_SHA;
      const digest = image && image.digest ? image.digest : DIGEST;
      return {
        replicaName,
        app: {
          name: STAFF_APP,
          properties: {
            latestRevisionName: revisionName,
            latestReadyRevisionName: revisionName,
            runningStatus: 'Running',
            configuration: {
              ingress: { traffic: [{ revisionName, weight: 100 }] },
            },
            template: {
              containers: [{
                image: `${IMAGE_REPOSITORY}:${tag}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        revision: {
          name: revisionName,
          properties: {
            healthState: 'Healthy',
            runningState: 'Running',
            provisioningState: 'Provisioned',
            replicas: 1,
            imageDigest: digest,
            template: {
              containers: [{
                name: STAFF_APP,
                image: `${IMAGE_REPOSITORY}:${tag}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        replicas: [{
          name: replicaName,
          properties: { runningState: 'Running', revisionName },
        }],
      };
    }
    function switchingState() {
      const ready = revisionState(REVISION, 'false');
      return {
        replicaName: ready.replicaName,
        app: {
          ...ready.app,
          properties: {
            ...ready.app.properties,
            latestRevisionName: ENABLED_REV,
            latestReadyRevisionName: REVISION,
            configuration: {
              ingress: { traffic: [{ revisionName: REVISION, weight: 100 }] },
            },
          },
        },
        revision: ready.revision,
        replicas: ready.replicas,
      };
    }

    let phase = 'original';
    const azRun = async (args) => {
      if (args.includes('update') || args.includes('--set-env-vars')) {
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'acr') {
        if (phase === 'drifted') {
          return {
            status: 0,
            stdout: JSON.stringify({
              digest: driftedDigest,
              tags: [driftedTag],
              repository: ACR_REPOSITORY,
            }),
          };
        }
        return { status: 0, stdout: JSON.stringify(acrJson) };
      }
      const state = phase === 'enabled'
        ? revisionState(ENABLED_REV, 'true')
        : phase === 'restored'
          ? revisionState(RESTORED_REV, 'false')
          : phase === 'switching'
            ? switchingState()
            : phase === 'drifted'
              ? revisionState(ENABLED_REV, 'true', { tag: driftedTag, digest: driftedDigest })
              : revisionState(REVISION, 'false');
      if (args[1] === 'exec') {
        assert.equal(args[args.indexOf('--command') + 1], envCmd);
        if (phase === 'enabled') {
          return { status: 0, stdout: 'true\ntrue\n' };
        }
        if (phase === 'restored') {
          return { status: 0, stdout: 'false\nfalse\n' };
        }
        if (phase === 'drifted') {
          return { status: 0, stdout: 'true\ntrue\n' };
        }
        return { status: 0, stdout: 'false\nfalse\n' };
      }
      if (args[1] === 'revision' && args[2] === 'show') {
        return { status: 0, stdout: JSON.stringify(state.revision) };
      }
      if (args[1] === 'replica') {
        return { status: 0, stdout: JSON.stringify(state.replicas) };
      }
      if (args[1] === 'show') {
        return { status: 0, stdout: JSON.stringify(state.app) };
      }
      return { status: 1, stdout: '' };
    };

    let nowMs = 0;
    const lateSleeps = [];
    phase = 'original';
    const lateSuccessor = await waitServingHealthy(azRun, {
      enabled: true,
      authorized: original,
      now: () => nowMs,
      sleep: async (ms) => {
        lateSleeps.push(ms);
        nowMs += ms;
        if (nowMs > 3 * 60 * 1000) phase = 'enabled';
      },
    });
    assert.equal(lateSuccessor.revision, ENABLED_REV);
    assert.ok(nowMs > 3 * 60 * 1000);
    assert.ok(nowMs <= REVISION_WAIT_TIMEOUT_MS);
    assert.ok(lateSleeps.length > 0);
    assert.ok(lateSleeps.every((ms) => ms === REVISION_WAIT_INTERVAL_MS));
    assert.ok(acceptedFlagSource(lateSuccessor.flagsSource));
    assert.equal(approvedReplicaFlagsExact(lateSuccessor, true), true);
    assert.equal(servingSuccessorAcceptable(original, lateSuccessor), true);
    assert.equal(servingHealthyReady100(lateSuccessor), true);

    nowMs = 0;
    phase = 'switching';
    const timedOut = await waitServingHealthy(azRun, {
      enabled: true,
      authorized: original,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });
    assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
    assert.equal(approvedReplicaFlagsExact(timedOut, true), false);
    assert.notEqual(timedOut && timedOut.revision, ENABLED_REV);
    const { harness: timeoutHarness, log: timeoutLog } = makeHarness({
      waitServingHealthy(input, current) {
        if (input && input.enabled === true) return timedOut;
        return current;
      },
    });
    const timedOutExecute = await execute(timeoutHarness);
    assert.equal(timedOutExecute.ok, false);
    assert.equal(timedOutExecute.reason, 'enabled_revision_unproven');
    assert.equal(timedOutExecute.invoked, 0);
    assert.equal(timeoutLog.includes('invoke'), false);
    assert.equal(timeoutLog.includes('flags:true'), true);
    assert.equal(timeoutLog.includes('flags:false'), true);

    nowMs = 0;
    phase = 'original';
    const driftedWait = await waitServingHealthy(azRun, {
      enabled: true,
      authorized: original,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
        if (nowMs > 3 * 60 * 1000) phase = 'drifted';
      },
    });
    assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
    assert.equal(approvedReplicaFlagsExact(driftedWait, true), false);
    assert.equal(servingSuccessorAcceptable(original, driftedWait), false);

    let fakeNow = NOW_MS;
    let seenCap = null;
    const { harness: waitAuthHarness } = makeHarness({
      now: () => fakeNow,
      waitServingHealthy(input, current) {
        if (input && input.enabled === true) {
          fakeNow += REVISION_WAIT_TIMEOUT_MS + 1;
          return serving({
            revision: ENABLED_REV,
            replica: `${ENABLED_REV}-aaaaa-bbbbb`,
            flags: flagsOn(),
          });
        }
        return current;
      },
      onInvoke(input) {
        seenCap = input && input.capability;
        const check = verifySupervisorCapability(seenCap, fakeNow, {
          revision: ENABLED_REV,
          imageTag: IMAGE_SHA,
          digest: DIGEST,
        });
        assert.equal(check.ok, true);
      },
    });
    const afterWait = await execute(waitAuthHarness);
    assert.equal(afterWait.ok, true);
    assert.equal(afterWait.invoked, 1);
    assert.ok(seenCap);
    assert.equal(
      seenCap.issued_at,
      new Date(NOW_MS + REVISION_WAIT_TIMEOUT_MS + 1).toISOString(),
    );
    assert.notEqual(seenCap.issued_at, ISSUED);
    const issuedAtStart = issueSupervisorCapability({
      nonce: seenCap.nonce,
      revision: ENABLED_REV,
      replica: seenCap.replica,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const expiredIfStart = verifySupervisorCapability(issuedAtStart, fakeNow, {
      revision: ENABLED_REV,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    });
    assert.ok(REVISION_WAIT_TIMEOUT_MS < CONFIRM_WINDOW_MS);
    assert.equal(expiredIfStart.ok, true);
    assert.notEqual(seenCap.issued_at, issuedAtStart.issued_at);

    const executeOnceSrc = libSrc.slice(
      libSrc.indexOf('async function executeOnce'),
      libSrc.indexOf('async function runStaffOwnerProof'),
    );
    const authIdx = executeOnceSrc.indexOf('validateExactInvocation');
    const waitIdx = executeOnceSrc.indexOf('waitServingHealthy({ enabled: true, authorized: serving })');
    const putIdx = executeOnceSrc.indexOf("await deps.putEmailChannelMode('auto')");
    const capIdx = executeOnceSrc.indexOf('issueSupervisorCapability');
    assert.ok(authIdx >= 0 && waitIdx > authIdx && putIdx > waitIdx && capIdx > putIdx);
    assert.equal(executeOnceSrc.split('validateExactInvocation').length - 1, 1);
    assert.match(executeOnceSrc, /issueSupervisorCapability\(\{[\s\S]*?\},\s*nowFn\(\)\)/);
    assert.doesNotMatch(executeOnceSrc, /issueSupervisorCapability\(\{[\s\S]*?\},\s*nowMs\)/);
    const waitSrc = libSrc.slice(
      libSrc.indexOf('async function waitServingHealthy'),
      libSrc.indexOf('function createProductionStaffPgAdapter'),
    );
    assert.match(waitSrc, /REVISION_WAIT_TIMEOUT_MS/);
    assert.match(waitSrc, /REVISION_WAIT_INTERVAL_MS/);
    assert.doesNotMatch(waitSrc, /180000/);
  }

  console.log('[25] RED→GREEN: trusted 429 uses ACA-native immutable revision proof; printenv at most once');
  {
    assert.equal(REPLICA_ATTEST_COOLDOWN_MS, 10 * 60 * 1000);
    assert.equal(REPLICA_ATTEST_RETRY_AFTER_MAX_S, 600);
    assert.equal(REPLICA_ATTEST_RETRY_AFTER_SLACK_MS, 30 * 1000);
    assert.equal(REPLICA_ATTEST_RETRY_AFTER_WAIT_MS, 630 * 1000);
    const observedSuccessorMs = 6 * 60 * 1000;
    assert.ok(observedSuccessorMs < REVISION_WAIT_TIMEOUT_MS);
    assert.ok(observedSuccessorMs + REPLICA_ATTEST_RETRY_AFTER_WAIT_MS > REVISION_WAIT_TIMEOUT_MS);
    assert.equal(
      parseTrustedReplicaAttestRetryAfterMs('WebSocket HTTP 429 Retry-After 600'),
      600000,
    );
    assert.equal(
      parseTrustedReplicaAttestRetryAfterMs('HTTP/1.1 429 Too Many Requests\nRetry-After: 600'),
      600000,
    );
    assert.equal(
      parseTrustedReplicaAttestRetryAfterMs('HTTP 429 retry-after=600'),
      600000,
    );
    assert.equal(
      parseTrustedReplicaAttestRetryAfterMs('HTTP 429 Retry-After: 9999'),
      REPLICA_ATTEST_COOLDOWN_MS,
    );
    assert.equal(parseTrustedReplicaAttestRetryAfterMs('HTTP 429'), REPLICA_ATTEST_COOLDOWN_MS);
    assert.equal(parseTrustedReplicaAttestRetryAfterMs('retry-after=600'), null);
    assert.equal(parseTrustedReplicaAttestRetryAfterMs('true\ntrue\nretry-after=1'), null);
    assert.equal(parseTrustedReplicaAttestRetryAfterMs(''), null);
    assert.equal(
      replicaAttestBackoffMs('WebSocket HTTP 429 Retry-After 600'),
      REPLICA_ATTEST_RETRY_AFTER_WAIT_MS,
    );
    assert.notEqual(
      replicaAttestBackoffMs('WebSocket HTTP 429 Retry-After 600'),
      600000,
    );

    const ENABLED_REV = `${STAFF_APP}--0000801`;
    const RESTORED_REV = `${STAFF_APP}--0000802`;
    const original = serving();
    const envCmd = buildReplicaEnvRemoteCommand();
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };
    function revisionState(revisionName, flagValue) {
      const replicaName = `${revisionName}-abcde-fghij`;
      return {
        replicaName,
        app: {
          name: STAFF_APP,
          properties: {
            latestRevisionName: revisionName,
            latestReadyRevisionName: revisionName,
            runningStatus: 'Running',
            configuration: {
              ingress: { traffic: [{ revisionName, weight: 100 }] },
            },
            template: {
              containers: [{
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        revision: {
          name: revisionName,
          properties: {
            healthState: 'Healthy',
            runningState: 'Running',
            provisioningState: 'Provisioned',
            replicas: 1,
            imageDigest: DIGEST,
            template: {
              containers: [{
                name: STAFF_APP,
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        replicas: [{
          name: replicaName,
          properties: { runningState: 'Running', revisionName },
        }],
      };
    }

    function makeWaitAz(getPhase, execImpl) {
      const execs = [];
      const identityPolls = [];
      const azRun = async (args) => {
        const phase = getPhase();
        const state = phase === 'enabled'
          ? revisionState(ENABLED_REV, 'true')
          : phase === 'restored'
            ? revisionState(RESTORED_REV, 'false')
            : revisionState(REVISION, 'false');
        if (args[1] === 'show') identityPolls.push(state.replicaName);
        if (args[1] === 'exec') {
          assert.equal(args[args.indexOf('--command') + 1], envCmd);
          const revision = args[args.indexOf('--revision') + 1];
          const replica = args[args.indexOf('--replica') + 1];
          execs.push({ revision, replica, phase });
          return execImpl({ revision, replica, phase, args });
        }
        if (args[0] === 'acr') return { status: 0, stdout: JSON.stringify(acrJson) };
        if (args[1] === 'revision' && args[2] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.revision) };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: JSON.stringify(state.replicas) };
        }
        if (args[1] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.app) };
        }
        return { status: 1, stdout: '' };
      };
      return { azRun, execs, identityPolls };
    }

    {
      let nowMs = 0;
      let phase = 'enabled';
      const { azRun, execs, identityPolls } = makeWaitAz(() => phase, () => ({
        status: 0,
        stdout: 'true\ntrue\n',
      }));
      const immediate = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.equal(immediate.revision, ENABLED_REV);
      assert.equal(immediate.replica, `${ENABLED_REV}-abcde-fghij`);
      assert.equal(immediate.flagsSource, FLAGS_SOURCE_REPLICA_PROCESS);
      assert.equal(approvedReplicaFlagsExact(immediate, true), true);
      assert.equal(servingSuccessorAcceptable(original, immediate), true);
      assert.equal(servingHealthyReady100(immediate), true);
      assert.equal(immediate.imageTag, IMAGE_SHA);
      assert.equal(immediate.digest, DIGEST);
      assert.equal(immediate.trafficWeight, 100);
      assert.equal(execs.length, 1);
      assert.equal(nowMs, 0);
      assert.equal(identityPolls.length, 1);
    }

    {
      let nowMs = 0;
      let phase = 'enabled';
      const { azRun, execs } = makeWaitAz(() => phase, () => ({
        status: 429,
        stdout: '',
        stderr: 'WebSocket HTTP 429 Retry-After 600\n',
      }));
      const native429 = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.equal(execs.length, 1);
      assert.equal(nowMs, 0);
      assert.equal(native429.revision, ENABLED_REV);
      assert.equal(native429.replica, `${ENABLED_REV}-abcde-fghij`);
      assert.equal(native429.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
      assert.equal(approvedReplicaFlagsExact(native429, true), true);
      assert.equal(native429.imageTag, IMAGE_SHA);
      assert.equal(native429.digest, DIGEST);
      assert.notEqual(native429.flagsSource, FLAGS_SOURCE_REPLICA_PROCESS);
    }

    {
      let nowMs = 0;
      let phase = 'original';
      const { azRun, execs } = makeWaitAz(() => phase, ({ phase: current }) => {
        if (current === 'enabled') {
          return {
            status: 429,
            stdout: 'true\ntrue\n',
            stderr: 'WebSocket HTTP 429 Retry-After 600\n',
          };
        }
        return { status: 0, stdout: 'false\nfalse\n' };
      });
      const afterSuccessor = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
          if (nowMs >= observedSuccessorMs) phase = 'enabled';
        },
      });
      assert.equal(execs.length, 1);
      assert.equal(execs[0].revision, ENABLED_REV);
      assert.equal(afterSuccessor.revision, ENABLED_REV);
      assert.equal(afterSuccessor.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
      assert.equal(approvedReplicaFlagsExact(afterSuccessor, true), true);
      assert.equal(nowMs, observedSuccessorMs);
      assert.ok(nowMs < REVISION_WAIT_TIMEOUT_MS);
    }

    {
      let nowMs = 0;
      let phase = 'enabled';
      const { azRun, execs } = makeWaitAz(() => phase, () => ({
        status: 0,
        stdout: 'false\nfalse\n',
      }));
      const contradicted = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.equal(execs.length, 1);
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(approvedReplicaFlagsExact(contradicted, true), false);
      assert.notEqual(contradicted && contradicted.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
    }

    {
      let nowMs = 0;
      let phase = 'restored';
      const { azRun, execs } = makeWaitAz(() => phase, () => ({
        status: 429,
        stderr: 'WebSocket HTTP 429 Retry-After 600\n',
      }));
      const restoredNative = await waitServingHealthy(azRun, {
        enabled: false,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.equal(execs.length, 1);
      assert.equal(nowMs, 0);
      assert.equal(restoredNative.revision, RESTORED_REV);
      assert.equal(restoredNative.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
      assert.equal(approvedReplicaFlagsExact(restoredNative, false), true);
    }

    const waitSrc = libSrc.slice(
      libSrc.indexOf('async function waitServingHealthy'),
      libSrc.indexOf('function createProductionStaffPgAdapter'),
    );
    assert.match(waitSrc, /proveAcaImmutableRevisionEnv/);
    assert.match(libSrc, /FLAGS_SOURCE_ACA_IMMUTABLE_REVISION/);
    assert.match(waitSrc, /attestReplicaProcessEnvResult/);
    assert.doesNotMatch(waitSrc, /nextAttestAt/);
    assert.doesNotMatch(waitSrc, /180000/);
    assert.match(libSrc, /function parseRevisionTemplateEnv/);
    assert.match(runbook, /immutable/);
    assert.match(runbook, /secretRef/);
    assert.match(runbook, /10 minutes per successor/);
    assert.doesNotMatch(runbook, /20 minutes per successor/);
    assert.match(plan, /immutable/);
    assert.match(plan, /10 minutes per successor/);
    assert.doesNotMatch(plan, /20 minutes per successor/);
  }

  console.log('[26] RED→GREEN: Graph t0 stays separate exec; 6m successor + 429 uses native inside 10m');
  {
    const ENABLED_REV = `${STAFF_APP}--0000901`;
    const RESTORED_REV = `${STAFF_APP}--0000902`;
    const original = serving();
    const envCmd = buildReplicaEnvRemoteCommand();
    const observedSuccessorMs = 6 * 60 * 1000;
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };
    function revisionState(revisionName, flagValue) {
      const replicaName = `${revisionName}-abcde-fghij`;
      return {
        replicaName,
        app: {
          name: STAFF_APP,
          properties: {
            latestRevisionName: revisionName,
            latestReadyRevisionName: revisionName,
            runningStatus: 'Running',
            configuration: {
              ingress: { traffic: [{ revisionName, weight: 100 }] },
            },
            template: {
              containers: [{
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        revision: {
          name: revisionName,
          properties: {
            healthState: 'Healthy',
            runningState: 'Running',
            provisioningState: 'Provisioned',
            replicas: 1,
            imageDigest: DIGEST,
            template: {
              containers: [{
                name: STAFF_APP,
                image: `${IMAGE_REPOSITORY}:${IMAGE_SHA}`,
                env: [
                  { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
                  { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
                ],
              }],
            },
          },
        },
        replicas: [{
          name: replicaName,
          properties: { runningState: 'Running', revisionName },
        }],
      };
    }
    function switchingState(nextName) {
      const ready = revisionState(REVISION, 'false');
      return {
        replicaName: ready.replicaName,
        app: {
          ...ready.app,
          properties: {
            ...ready.app.properties,
            latestRevisionName: nextName,
            latestReadyRevisionName: REVISION,
            configuration: {
              ingress: { traffic: [{ revisionName: REVISION, weight: 100 }] },
            },
          },
        },
        revision: ready.revision,
        replicas: ready.replicas,
      };
    }

    function makeClockAz(getPhase, execImpl) {
      const execs = [];
      const identityPolls = [];
      const azRun = async (args) => {
        const phase = getPhase();
        const state = phase === 'enabled'
          ? revisionState(ENABLED_REV, 'true')
          : phase === 'restored'
            ? revisionState(RESTORED_REV, 'false')
            : phase === 'switching-restore'
              ? switchingState(RESTORED_REV)
              : switchingState(ENABLED_REV);
        if (args[1] === 'show') identityPolls.push(state.replicaName);
        if (args[1] === 'exec') {
          const revision = args[args.indexOf('--revision') + 1];
          const replica = args[args.indexOf('--replica') + 1];
          const command = args[args.indexOf('--command') + 1];
          const kind = command === envCmd ? 'process-env' : 'graph';
          execs.push({ revision, replica, phase, kind });
          return execImpl({ revision, replica, phase, kind, args });
        }
        if (args[0] === 'acr') return { status: 0, stdout: JSON.stringify(acrJson) };
        if (args[1] === 'revision' && args[2] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.revision) };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: JSON.stringify(state.replicas) };
        }
        if (args[1] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.app) };
        }
        return { status: 1, stdout: '' };
      };
      return { azRun, execs, identityPolls };
    }

    const graphArgs = buildStaffOwnerExecAzArgs({
      replica: original.replica,
      revision: original.revision,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
      graphVerify: true,
    });
    assert.ok(graphArgs);
    assert.match(graphArgs[graphArgs.indexOf('--command') + 1], /MAIL_MVP_004_GRAPH_VERIFY=1/);

    {
      let nowMs = 0;
      let phase = 'switching';
      const processEnvTimes = [];
      const { azRun, execs, identityPolls } = makeClockAz(() => phase, ({ kind }) => {
        if (kind === 'graph') {
          assert.equal(nowMs, 0);
          return {
            status: 0,
            stdout: `${JSON.stringify({
              ok: true,
              threaded: true,
              arrivals: 1,
              duplicates: 0,
              adapter_available: true,
              readonly: true,
              subject_ok: true,
            })}\n`,
          };
        }
        processEnvTimes.push(nowMs);
        return {
          status: 429,
          stdout: '',
          stderr: 'WebSocket HTTP 429 Retry-After 600\n',
        };
      });

      const graphAtT0 = await azRun(graphArgs);
      assert.equal(graphAtT0.status, 0);
      assert.equal(execs.length, 1);
      assert.equal(execs[0].kind, 'graph');
      assert.equal(nowMs, 0);

      const enabledWait = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
          if (phase === 'switching' && nowMs >= observedSuccessorMs) phase = 'enabled';
        },
      });
      assert.equal(execs[0].kind, 'graph');
      const processEnvExecs = execs.filter((row) => row.kind === 'process-env');
      assert.equal(processEnvExecs.length, 1);
      assert.deepEqual(processEnvTimes, [observedSuccessorMs]);
      assert.ok(nowMs < REVISION_WAIT_TIMEOUT_MS);
      assert.ok(nowMs < 15 * 60 * 1000);
      assert.equal(nowMs, observedSuccessorMs);
      assert.equal(enabledWait.revision, ENABLED_REV);
      assert.equal(enabledWait.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
      assert.equal(approvedReplicaFlagsExact(enabledWait, true), true);
      assert.ok(identityPolls.length > processEnvExecs.length);
      assert.equal(execs.filter((row) => row.kind === 'graph').length, 1);

      nowMs = 0;
      phase = 'switching-restore';
      const restoreTimes = [];
      const restoreAz = makeClockAz(() => phase, ({ kind }) => {
        if (kind === 'graph') return { status: 0, stdout: '{}\n' };
        restoreTimes.push(nowMs);
        return {
          status: 429,
          stdout: '',
          stderr: 'WebSocket HTTP 429 Retry-After 600\n',
        };
      });
      const restoredWait = await waitServingHealthy(restoreAz.azRun, {
        enabled: false,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
          if (phase === 'switching-restore' && nowMs >= observedSuccessorMs) phase = 'restored';
        },
      });
      assert.deepEqual(restoreTimes, [observedSuccessorMs]);
      assert.ok(nowMs < REVISION_WAIT_TIMEOUT_MS);
      assert.equal(restoredWait.revision, RESTORED_REV);
      assert.equal(restoredWait.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
      assert.equal(approvedReplicaFlagsExact(restoredWait, false), true);
    }

    {
      let fakeNow = NOW_MS;
      let seenCap = null;
      const attestDelay = observedSuccessorMs;
      const { harness: waitAuthHarness } = makeHarness({
        now: () => fakeNow,
        waitServingHealthy(input, current) {
          if (input && input.enabled === true) {
            fakeNow += attestDelay;
            return serving({
              revision: ENABLED_REV,
              replica: `${ENABLED_REV}-aaaaa-bbbbb`,
              flags: flagsOn(),
              flagsSource: FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
            });
          }
          fakeNow += attestDelay;
          return serving({
            revision: RESTORED_REV,
            replica: `${RESTORED_REV}-ccccc-ddddd`,
            flags: flagsOff(),
            flagsSource: FLAGS_SOURCE_ACA_IMMUTABLE_REVISION,
          });
        },
        onInvoke(input) {
          seenCap = input && input.capability;
          const check = verifySupervisorCapability(seenCap, fakeNow, {
            revision: ENABLED_REV,
            imageTag: IMAGE_SHA,
            digest: DIGEST,
          });
          assert.equal(check.ok, true);
        },
      });
      const afterWait = await execute(waitAuthHarness);
      assert.equal(afterWait.ok, true);
      assert.equal(afterWait.invoked, 1);
      assert.ok(seenCap);
      assert.equal(seenCap.issued_at, new Date(NOW_MS + attestDelay).toISOString());
      assert.notEqual(seenCap.issued_at, ISSUED);
      const issuedAtStart = issueSupervisorCapability({
        nonce: seenCap.nonce,
        revision: ENABLED_REV,
        replica: seenCap.replica,
        imageTag: IMAGE_SHA,
        digest: DIGEST,
      }, NOW_MS);
      const expiredIfStart = verifySupervisorCapability(issuedAtStart, fakeNow, {
        revision: ENABLED_REV,
        imageTag: IMAGE_SHA,
        digest: DIGEST,
      });
      assert.ok(attestDelay < CONFIRM_WINDOW_MS);
      assert.equal(expiredIfStart.ok, true);
      assert.notEqual(seenCap.issued_at, issuedAtStart.issued_at);
      const executeOnceSrc = libSrc.slice(
        libSrc.indexOf('async function executeOnce'),
        libSrc.indexOf('async function runStaffOwnerProof'),
      );
      assert.equal(executeOnceSrc.split('validateExactInvocation').length - 1, 1);
      const authIdx = executeOnceSrc.indexOf('validateExactInvocation');
      const waitIdx = executeOnceSrc.indexOf('waitServingHealthy({ enabled: true, authorized: serving })');
      const putIdx = executeOnceSrc.indexOf("await deps.putEmailChannelMode('auto')");
      const capIdx = executeOnceSrc.indexOf('issueSupervisorCapability');
      assert.ok(authIdx >= 0 && waitIdx > authIdx && putIdx > waitIdx && capIdx > putIdx);
      assert.match(libSrc, /verifyGraphArrival/);
      const graphBeforeFlags = executeOnceSrc.indexOf('verifyGraphArrival');
      const flagsIdx = executeOnceSrc.indexOf('setEmergencyFlags(true)');
      assert.ok(graphBeforeFlags >= 0 && flagsIdx > graphBeforeFlags);
    }
  }

  console.log('[27] Hostile: stale ready, template-only replica, secretRef, duplicates, unrelated drift, image drift, traffic switching');
  {
    const ENABLED_REV = `${STAFF_APP}--0001001`;
    const original = serving();
    const acrJson = {
      digest: DIGEST,
      tags: [IMAGE_SHA],
      repository: ACR_REPOSITORY,
    };
    function baseEnv(flagValue, extra) {
      const env = [
        { name: ENV_LUNA_AUTO_SEND_ENABLED, value: flagValue },
        { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: flagValue },
      ];
      if (Array.isArray(extra)) env.push(...extra);
      return env;
    }
    function revisionState(revisionName, flagValue, patch = {}) {
      const replicaName = patch.replicaName || `${revisionName}-abcde-fghij`;
      const env = patch.env || baseEnv(flagValue, patch.extraEnv);
      const traffic = patch.traffic || [{ revisionName, weight: 100 }];
      const latest = patch.latestRevisionName || revisionName;
      const latestReady = patch.latestReadyRevisionName || revisionName;
      const tag = patch.imageTag || IMAGE_SHA;
      const digest = patch.digest || DIGEST;
      return {
        replicaName,
        app: {
          name: STAFF_APP,
          properties: {
            latestRevisionName: latest,
            latestReadyRevisionName: latestReady,
            runningStatus: 'Running',
            configuration: {
              ingress: { traffic },
            },
            template: {
              containers: [{
                image: `${IMAGE_REPOSITORY}:${tag}`,
                env,
              }],
            },
          },
        },
        revision: {
          name: revisionName,
          properties: {
            healthState: patch.healthState || 'Healthy',
            runningState: patch.runningState || 'Running',
            provisioningState: 'Provisioned',
            replicas: patch.revisionReplicas === undefined ? 1 : patch.revisionReplicas,
            imageDigest: digest,
            template: {
              containers: [{
                name: STAFF_APP,
                image: `${IMAGE_REPOSITORY}:${tag}`,
                env,
              }],
            },
          },
        },
        replicas: patch.replicas !== undefined ? patch.replicas : [{
          name: replicaName,
          properties: { runningState: 'Running', revisionName },
        }],
      };
    }
    function makeHostileAz(getState, execImpl) {
      const execs = [];
      const azRun = async (args) => {
        const state = getState();
        if (args[1] === 'exec') {
          execs.push({
            revision: args[args.indexOf('--revision') + 1],
            replica: args[args.indexOf('--replica') + 1],
          });
          if (typeof execImpl === 'function') return execImpl();
          return {
            status: 429,
            stderr: 'WebSocket HTTP 429 Retry-After 600\n',
          };
        }
        if (args[0] === 'acr') {
          return {
            status: 0,
            stdout: JSON.stringify({
              digest: state.revision.properties.imageDigest,
              tags: [(state.app.properties.template.containers[0].image.split(':')[1] || '').split('@')[0]],
              repository: ACR_REPOSITORY,
            }),
          };
        }
        if (args[1] === 'revision' && args[2] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.revision) };
        }
        if (args[1] === 'replica') {
          return { status: 0, stdout: JSON.stringify(state.replicas) };
        }
        if (args[1] === 'show') {
          return { status: 0, stdout: JSON.stringify(state.app) };
        }
        return { status: 1, stdout: '' };
      };
      return { azRun, execs };
    }

    const secretParsed = parseRevisionTemplateEnv([
      { name: ENV_LUNA_AUTO_SEND_ENABLED, secretRef: 'auto-send' },
      { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
    ]);
    assert.equal(secretParsed.ok, false);
    assert.equal(secretParsed.reason, 'env_secret_ref');
    const dupParsed = parseRevisionTemplateEnv([
      { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
      { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
      { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
    ]);
    assert.equal(dupParsed.ok, false);
    assert.equal(dupParsed.reason, 'env_duplicate');
    const missingParsed = parseRevisionTemplateEnv([
      { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
    ]);
    assert.equal(missingParsed.ok, false);
    assert.equal(missingParsed.reason, 'env_missing');
    const driftParsed = parseRevisionTemplateEnv(baseEnv('true', [
      { name: 'NODE_ENV', value: 'production' },
    ]));
    assert.equal(driftParsed.ok, true);
    assert.notEqual(driftParsed.fingerprint, '[]');

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(REVISION, 'false', {
        latestRevisionName: ENABLED_REV,
        latestReadyRevisionName: REVISION,
      }));
      const staleReady = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(staleReady, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        replicas: [],
        revisionReplicas: 1,
      }));
      const templateOnly = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(templateOnly, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        replicas: [{
          name: `${REVISION}-zzzzz-yyyyy`,
          properties: { runningState: 'Running', revisionName: REVISION },
        }],
      }));
      const wrongReplica = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(wrongReplica, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        env: [
          { name: ENV_LUNA_AUTO_SEND_ENABLED, secretRef: 'luna-auto-send' },
          { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
        ],
      }));
      const secretRef = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(secretRef, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        env: [
          { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
          { name: ENV_LUNA_AUTO_SEND_ENABLED, value: 'true' },
          { name: ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED, value: 'true' },
        ],
      }));
      const duplicates = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(duplicates, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        extraEnv: [{ name: 'CUSTOMER_OUTREACH_EMAIL_ENABLED', value: 'true' }],
      }));
      const unrelated = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(unrelated, true), false);
    }

    {
      let nowMs = 0;
      const driftedTag = 'c'.repeat(40);
      const driftedDigest = `sha256:${'e'.repeat(64)}`;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        imageTag: driftedTag,
        digest: driftedDigest,
      }));
      const imageDrift = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(servingSuccessorAcceptable(original, imageDrift), false);
      assert.equal(approvedReplicaFlagsExact(imageDrift, true), false);
    }

    {
      let nowMs = 0;
      const { azRun, execs } = makeHostileAz(() => revisionState(ENABLED_REV, 'true', {
        traffic: [
          { revisionName: REVISION, weight: 50 },
          { revisionName: ENABLED_REV, weight: 50 },
        ],
        latestRevisionName: ENABLED_REV,
        latestReadyRevisionName: ENABLED_REV,
      }));
      const switched = await waitServingHealthy(azRun, {
        enabled: true,
        authorized: original,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      });
      assert.ok(nowMs > REVISION_WAIT_TIMEOUT_MS);
      assert.equal(execs.length, 0);
      assert.equal(approvedReplicaFlagsExact(switched, true), false);
    }

    const healthyEnabled = serving({
      revision: ENABLED_REV,
      replica: `${ENABLED_REV}-abcde-fghij`,
      flags: flagsOn(),
      flagsSource: FLAGS_SOURCE_TEMPLATE,
      unrelatedEnvFingerprint: '[]',
      latestRevisionName: ENABLED_REV,
      latestReadyRevisionName: ENABLED_REV,
    });
    const provenNative = proveAcaImmutableRevisionEnv(healthyEnabled, original, true);
    assert.equal(provenNative && provenNative.flagsSource, FLAGS_SOURCE_ACA_IMMUTABLE_REVISION);
    assert.equal(approvedReplicaFlagsExact(provenNative, true), true);
    assert.equal(proveAcaImmutableRevisionEnv({
      ...healthyEnabled,
      unrelatedEnvFingerprint: JSON.stringify([{ name: 'NODE_ENV', value: 'production' }]),
    }, original, true), null);
    assert.equal(proveAcaImmutableRevisionEnv({
      ...healthyEnabled,
      replica: null,
    }, original, true), null);
    assert.equal(proveAcaImmutableRevisionEnv({
      ...healthyEnabled,
      digest: `sha256:${'f'.repeat(64)}`,
    }, original, true), null);

    const { harness: hostileHarness, log: hostileLog } = makeHarness({
      waitServingHealthy(input, current) {
        if (input && input.enabled === true) return healthyEnabled;
        return serving({
          revision: `${STAFF_APP}--0001002`,
          replica: `${STAFF_APP}--0001002-ccccc-ddddd`,
          flags: flagsOff(),
        });
      },
    });
    const hostileExecute = await execute(hostileHarness);
    assert.equal(hostileExecute.ok, false);
    assert.equal(hostileExecute.reason, 'enabled_revision_unproven');
    assert.equal(hostileExecute.invoked, 0);
    assert.equal(hostileLog.includes('invoke'), false);
    assert.equal(hostileLog.includes('flags:true'), true);
    assert.equal(hostileLog.includes('flags:false'), true);
    assert.equal(hostileExecute.restored, true);
  }

  console.log('[28] Proven-no-send dispatch marker reset; ACA exec determinate');
  {
    const os = require('node:os');
    const ownerSrc = libSrc.slice(
      libSrc.indexOf('async function runStaffOwnerProof'),
      libSrc.indexOf('function shSingleQuote'),
    );
    assert.ok(ownerSrc.indexOf("return refusedRecord('email_channel_not_auto')")
      < ownerSrc.indexOf('consumeInnerCapability'));
    assert.ok(ownerSrc.indexOf('if (reconcileOnly === true)')
      < ownerSrc.indexOf('consumeInnerCapability'));
    assert.ok(ownerSrc.indexOf('replaceProvenNoSendDispatchMarker')
      < ownerSrc.indexOf('consumeInnerCapability'));
    assert.ok(ownerSrc.indexOf('consumeInnerCapability')
      < ownerSrc.indexOf('ignoreRemoteExecHangup'));
    assert.ok(ownerSrc.indexOf('ignoreRemoteExecHangup')
      < ownerSrc.indexOf('writeOwnerOneshotRequest'));
    assert.ok(ownerSrc.indexOf('writeOwnerOneshotRequest')
      < ownerSrc.indexOf('MUTATION_ISSUED_MARKER'));
    assert.match(libSrc, /process\.on\('SIGHUP', ignore\)/);
    assert.match(libSrc, /MAIL_MVP_004_STAFF_OWNER_WORKER/);
    assert.match(libSrc, /startMailMvp004StaffOwnerOneshotListener/);
    assert.doesNotMatch(ownerSrc, /spawnDetachedStaffOwnerWorker/);
    assert.doesNotMatch(ownerSrc, /detached: true/);
    assert.doesNotMatch(
      libSrc.slice(libSrc.indexOf('invokeAutoOwner: brandProductionAutoOwner'), libSrc.indexOf('async snapshotOperation')),
      /writeOwnerOneshotRequest/,
    );
    assert.match(libSrc, /STAFF_OWNER_EXEC_TIMEOUT_MS = 12 \* 60 \* 1000/);
    assert.equal(STAFF_OWNER_EXEC_TIMEOUT_MS, 12 * 60 * 1000);
    assert.ok(STAFF_OWNER_EXEC_TIMEOUT_MS > SNAPSHOT_EXEC_TIMEOUT_MS);
    assert.ok(STAFF_OWNER_COMPLETION_WAIT_MS >= 12 * 60 * 1000);
    assert.equal(STAFF_OWNER_COMPLETION_WAIT_MS, STAFF_OWNER_EXEC_TIMEOUT_MS);
    assert.equal(STAFF_OWNER_HANDOFF_WAIT_MS, 15 * 1000);
    assert.equal(RECONCILE_POLL_INTERVAL_MS, 15 * 1000);
    assert.ok(RECONCILE_POLL_INTERVAL_MS >= 15 * 1000);
    assert.equal(INNER_DISPATCH_RECEIPT_PATH, '/tmp/mail-mvp-004-dispatch-receipt.json');
    assert.equal(INNER_OWNER_REQUEST_PATH, '/tmp/mail-mvp-004-owner-request.json');
    assert.equal(INNER_OWNER_CLAIMED_PATH, '/tmp/mail-mvp-004-owner-request.claimed.json');
    const staffApiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
    assert.match(staffApiSrc, /startMailMvp004StaffOwnerOneshotListener/);
    assert.match(staffApiSrc, /withPgClient: _withPgClientImpl/);
    assert.ok(staffApiSrc.indexOf("LUNA_DEPLOYMENT") < staffApiSrc.indexOf('startMailMvp004StaffOwnerOneshotListener')
      || staffApiSrc.includes("process.env.LUNA_DEPLOYMENT"));
    assert.match(staffApiSrc, /sunset-staging/);
    assert.match(runbook, /long-lived Staff API process/);
    assert.match(runbook, /one-shot request/);
    assert.match(plan, /one-shot request/);
    assert.doesNotMatch(runbook, /detaches the 003 handle into a new session/);

    const reconCmd = buildStaffOwnerRemoteCommand(crypto.randomUUID(), false, { snapshot: 'reconcile' });
    assert.match(reconCmd, /MAIL_MVP_004_SNAPSHOT=reconcile/);
    assert.doesNotMatch(reconCmd, /MAIL_MVP_004_STAFF_OWNER_PROOF=1/);
    assert.doesNotMatch(reconCmd, /MAIL_MVP_004_CAPABILITY=/);
    assert.equal(isLegalStaffOwnerRemoteCommand(reconCmd), true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp004-reset-'));
    const receiptPath = path.join(dir, 'receipt.json');
    const consumedPath = path.join(dir, 'consumed.json');
    assert.equal(readDispatchReceipt(receiptPath), null);
    assert.equal(dispatchProcessAlive(process.pid), true);
    assert.equal(dispatchProcessAlive(-1), false);
    const issued = writeDispatchReceipt({
      status: 'issued',
      nonce: nonce(),
      pid: 999999001,
      reason: null,
    }, receiptPath);
    assert.equal(issued.status, 'issued');
    assert.equal(readDispatchReceipt(receiptPath).process_alive, false);
    const blockedCounts = replaceProvenNoSendDispatchMarker({
      filePath: receiptPath,
      counts: { approvals: 1, journals: 1, provider_sends: 1 },
    });
    assert.equal(blockedCounts.ok, false);
    assert.equal(blockedCounts.reason, 'operation_not_new');
    const livePid = writeDispatchReceipt({
      status: 'issued',
      nonce: nonce(),
      pid: process.pid,
    }, receiptPath);
    assert.equal(livePid.status, 'issued');
    const inFlight = replaceProvenNoSendDispatchMarker({
      filePath: receiptPath,
      counts: { approvals: 0, journals: 0, provider_sends: 0 },
    });
    assert.equal(inFlight.ok, false);
    assert.equal(inFlight.reason, 'dispatch_in_flight');
    writeDispatchReceipt({
      status: 'issued',
      nonce: nonce(),
      pid: 999999002,
    }, receiptPath);
    const replaced = replaceProvenNoSendDispatchMarker({
      filePath: receiptPath,
      counts: { approvals: 0, journals: 0, provider_sends: 0 },
    });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.replaced, true);
    assert.equal(readDispatchReceipt(receiptPath).status, 'replaced');

    const zero = classifyReconcileSnapshot({
      ok: true,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      bookings: 0,
      process_alive: false,
      dispatch_status: 'issued',
    }, { marked: true });
    assert.equal(zero.status, 'proven_no_send');
    assert.equal(zero.dispatch_reset_allowed, true);
    assert.equal(zero.dispatch_reason, null);
    assert.equal(zero.owner_status, null);
    assert.equal(zero.retry, false);
    assert.equal(closedWorkerReason('email_channel_not_auto'), 'email_channel_not_auto');
    assert.equal(closedWorkerReason('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), null);
    assert.equal(closedWorkerReason('sol unproven'), null);
    assert.equal(closedOwnerStatus('failed'), 'failed');
    assert.equal(closedOwnerStatus('sent extra'), null);
    const workerFailed = classifyReconcileSnapshot({
      ok: true,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      bookings: 0,
      process_alive: false,
      dispatch_status: 'failed',
      dispatch_reason: 'email_channel_not_auto',
      owner_status: 'failed',
    }, { marked: true });
    assert.equal(workerFailed.status, 'proven_no_send');
    assert.equal(workerFailed.reason, 'proven_no_send');
    assert.equal(workerFailed.dispatch_reason, 'email_channel_not_auto');
    assert.equal(workerFailed.owner_status, 'failed');
    assert.equal(workerFailed.dispatch_reset_allowed, true);
    assert.equal(workerFailed.retry, false);
    const leakedReason = classifyReconcileSnapshot({
      ok: true,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      bookings: 0,
      process_alive: false,
      dispatch_status: 'failed',
      dispatch_reason: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      owner_status: 'sent extra',
    }, { marked: true });
    assert.equal(leakedReason.status, 'proven_no_send');
    assert.equal(leakedReason.dispatch_reason, null);
    assert.equal(leakedReason.owner_status, null);
    const unsafeReceipt = writeDispatchReceipt({
      status: 'failed',
      nonce: nonce(),
      pid: null,
      owner_status: 'failed\nsecret=1',
      reason: 'Authorization: Bearer abc.def.ghi',
    }, path.join(dir, 'unsafe-receipt.json'));
    assert.equal(unsafeReceipt.reason, null);
    assert.equal(unsafeReceipt.owner_status, null);
    assert.equal(readDispatchReceipt(path.join(dir, 'unsafe-receipt.json')).reason, null);
    const refusedSnap = classifyReconcileSnapshot(
      publicProofOutput(refusedRecord('counts_unavailable')),
      { marked: true },
    );
    assert.equal(refusedSnap.reason, 'indeterminate_no_retry');
    assert.notEqual(refusedSnap.dispatch_reset_allowed, true);
    const missingFields = classifyReconcileSnapshot({
      ok: true,
      process_alive: false,
      dispatch_status: 'issued',
    }, { marked: true });
    assert.equal(missingFields.reason, 'indeterminate_no_retry');
    const markedNoReceipt = classifyReconcileSnapshot({
      ok: true,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      bookings: 0,
      process_alive: false,
    }, { marked: true });
    assert.equal(markedNoReceipt.reason, 'indeterminate_no_retry');
    assert.notEqual(markedNoReceipt.dispatch_reset_allowed, true);
    const alive = classifyReconcileSnapshot({
      ok: true,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
      bookings: 0,
      process_alive: true,
      dispatch_status: 'issued',
    }, { marked: true });
    assert.equal(alive.reason, 'indeterminate_no_retry');
    const sentSnap = classifyReconcileSnapshot({
      ok: true,
      approvals: 1,
      journals: 1,
      provider_sends: 1,
      bookings: 4,
      process_alive: false,
      dispatch_status: 'completed',
    }, { marked: true });
    assert.equal(sentSnap.reason, 'already_sent');

    let ownerCalls = 0;
    const markedUnknown = brandProductionAutoOwner(async () => {
      ownerCalls += 1;
      return {
        status: 'failed',
        indeterminate: true,
        outcome_unknown: true,
        dispatch_marked: true,
        reason: 'indeterminate_no_retry',
      };
    });
    const proven = await execute(makeHarness({
      invoke: markedUnknown,
      reconcile: async () => ({
        status: 'proven_no_send',
        reason: 'proven_no_send',
        dispatch_reason: 'email_channel_not_auto',
        owner_status: 'failed',
        dispatch_reset_allowed: true,
        process_alive: false,
        retry: false,
        approvals: 0,
        journals: 0,
        provider_sends: 0,
      }),
    }).harness);
    assert.equal(ownerCalls, 1);
    assert.equal(proven.ok, false);
    assert.equal(proven.reason, 'proven_no_send');
    assert.equal(proven.dispatch_reason, 'email_channel_not_auto');
    assert.equal(proven.invoked, 1);
    assert.equal(proven.restored, true);
    assert.equal(proven.public.dispatch_reset_allowed, true);
    assert.equal(proven.public.dispatch_reason, 'email_channel_not_auto');
    assert.equal(proven.public.owner_status, 'failed');
    assert.equal(proven.public.approvals, 0);
    assert.equal(proven.public.journals, 0);
    assert.equal(proven.public.provider_sends, 0);
    assert.equal(proven.public.sent, false);
    assert.equal(proven.retry, undefined);

    ownerCalls = 0;
    const stillUnknown = await execute(makeHarness({
      invoke: markedUnknown,
      reconcile: async () => ({
        status: 'failed',
        indeterminate: true,
        reason: 'indeterminate_no_retry',
        process_alive: true,
        retry: false,
      }),
    }).harness);
    assert.equal(ownerCalls, 1);
    assert.equal(stillUnknown.reason, 'indeterminate_no_retry');
    assert.notEqual(stillUnknown.public.dispatch_reset_allowed, true);

    const replayStore = createDurableNonceStore(path.join(dir, 'nonces.json'));
    const firstNonce = nonce();
    assert.equal(replayStore.add(firstNonce, 'Testing 8 26|twoods@xantrion.com'), true);
    assert.equal(replayStore.add(firstNonce, 'Testing 8 26|twoods@xantrion.com'), false);
    const replayParsed = authArgs({ operatorNonce: firstNonce });
    assert.equal(validateExactInvocation(replayParsed, NOW_MS, replayStore), 'operator_nonce_replay');
    const replacementNonce = nonce();
    assert.equal(validateExactInvocation(authArgs({ operatorNonce: replacementNonce }), NOW_MS, replayStore), null);

    const humanRows = [threadRow({ needs_human: true })];
    const withHuman = async (fn) => fn({
      async query(sql) {
        const n = String(sql).replace(/\s+/g, ' ');
        if (/FROM clients cl INNER JOIN conversations c/.test(n)) return { rows: humanRows };
        if (/inbox_channel_modes/.test(n)) return { rows: [{ inbox_channel_modes: { email: 'auto' } }] };
        if (/tenant_email_outbound_send_journal/.test(n)) return { rows: [{ n: 0, sends: 0 }] };
        if (/tenant_email_reply_approvals/.test(n)) return { rows: [{ n: 0 }] };
        if (/JOIN bookings b/.test(n)) return { rows: [{ n: 4 }] };
        if (/current_database/.test(n)) return { rows: [{ current_database: 'sunset_staging' }] };
        return { rows: [] };
      },
    });
    const humanCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const humanProof = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_LIVE_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
        MAIL_MVP_004_CAPABILITY: encodeCapability(humanCap),
        MAIL_MVP_004_REVISION: REVISION,
        MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
        MAIL_MVP_004_DIGEST: DIGEST,
      },
      withPgClient: withHuman,
      nowMs: NOW_MS,
      consumedCapabilityPath: consumedPath,
      dispatchReceiptPath: path.join(dir, 'human-receipt.json'),
      wired: { handleProjectedInbound: brandProductionAutoOwner(async () => ({ status: 'sent' })) },
    });
    assert.equal(humanProof.reason, 'needs_human');
    assert.equal(fs.existsSync(consumedPath), false);

    const reconCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    consumeInnerCapability(reconCap.nonce, consumedPath);
    const withZero = async (fn) => fn({
      async query(sql) {
        const n = String(sql).replace(/\s+/g, ' ');
        if (/FROM clients cl INNER JOIN conversations c/.test(n)) return { rows: [threadRow()] };
        if (/inbox_channel_modes/.test(n)) return { rows: [{ inbox_channel_modes: { email: 'auto' } }] };
        if (/tenant_email_outbound_send_journal/.test(n)) return { rows: [{ n: 0, sends: 0 }] };
        if (/tenant_email_reply_approvals/.test(n)) return { rows: [{ n: 0 }] };
        if (/JOIN bookings b/.test(n)) return { rows: [{ n: 4 }] };
        if (/current_database/.test(n)) return { rows: [{ current_database: 'sunset_staging' }] };
        return { rows: [] };
      },
    });
    const snapReceipt = path.join(dir, 'reconcile-reason-receipt.json');
    const writtenReason = writeDispatchReceipt({
      status: 'failed',
      nonce: nonce(),
      pid: null,
      owner_status: 'failed',
      reason: 'email_channel_not_auto',
    }, snapReceipt);
    assert.equal(writtenReason.reason, 'email_channel_not_auto');
    const reconSnap = await runInnerSnapshot({
      env: {
        MAIL_MVP_004_SNAPSHOT: 'reconcile',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      withPgClient: withZero,
      dispatchReceiptPath: snapReceipt,
    });
    assert.equal(reconSnap.ok, true);
    assert.equal(reconSnap.dispatch_status, 'failed');
    assert.equal(reconSnap.dispatch_reason, 'email_channel_not_auto');
    assert.equal(reconSnap.owner_status, 'failed');
    assert.equal(reconSnap.public.dispatch_reason, 'email_channel_not_auto');
    assert.equal(reconSnap.public.owner_status, 'failed');
    assert.equal(reconSnap.approvals, 0);
    assert.equal(reconSnap.journals, 0);
    assert.equal(reconSnap.provider_sends, 0);
    const classifiedSnap = classifyReconcileSnapshot(reconSnap.public, { marked: true });
    assert.equal(classifiedSnap.status, 'proven_no_send');
    assert.equal(classifiedSnap.reason, 'proven_no_send');
    assert.equal(classifiedSnap.dispatch_reason, 'email_channel_not_auto');
    assert.equal(classifiedSnap.retry, false);
    const pubNoSend = publicProofOutput({
      ok: false,
      reason: 'proven_no_send',
      status: 'proven_no_send',
      dispatch_reset_allowed: true,
      dispatch_reason: 'email_channel_not_auto',
      owner_status: 'failed',
      invoked: 1,
      approvals: 0,
      journals: 0,
      provider_sends: 0,
    });
    assert.equal(pubNoSend.dispatch_reason, 'email_channel_not_auto');
    assert.equal(pubNoSend.owner_status, 'failed');
    assert.equal(pubNoSend.sent, false);
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const badReceipt = path.join(blocker, 'receipt.json');
    assert.equal(writeDispatchReceipt({
      status: 'issued',
      nonce: nonce(),
      pid: process.pid,
    }, badReceipt), null);
    let writeFailHandle = 0;
    const writeFailCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const writeFail = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_LIVE_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
        MAIL_MVP_004_CAPABILITY: encodeCapability(writeFailCap),
        MAIL_MVP_004_REVISION: REVISION,
        MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
        MAIL_MVP_004_DIGEST: DIGEST,
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      consumedCapabilityPath: path.join(dir, 'write-fail-consumed.json'),
      dispatchReceiptPath: badReceipt,
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          writeFailHandle += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(writeFail.reason, 'dispatch_receipt_unproven');
    assert.equal(writeFailHandle, 0);
    const recon = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_LIVE_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        MAIL_MVP_004_RECONCILE_ONLY: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
        MAIL_MVP_004_CAPABILITY: encodeCapability(reconCap),
        MAIL_MVP_004_REVISION: REVISION,
        MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
        MAIL_MVP_004_DIGEST: DIGEST,
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      reconcileOnly: true,
      consumedCapabilityPath: consumedPath,
      dispatchReceiptPath: receiptPath,
    });
    assert.notEqual(recon.reason, 'capability_replay');
    assert.equal(recon.reason, 'reconcile_owner_state');
    assert.equal(recon.public.approvals, 0);
    assert.equal(recon.public.journals, 0);
    assert.equal(recon.public.provider_sends, 0);

    let parentHandleCalls = 0;
    const oneshotCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const requestPath = path.join(dir, 'owner-request.json');
    const claimedPath = path.join(dir, 'owner-request.claimed.json');
    const oneshotReceipt = path.join(dir, 'oneshot-receipt.json');
    const missingListener = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_LIVE_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
        MAIL_MVP_004_CAPABILITY: encodeCapability(oneshotCap),
        MAIL_MVP_004_REVISION: REVISION,
        MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
        MAIL_MVP_004_DIGEST: DIGEST,
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      useOneshot: true,
      oneshotRequestPath: requestPath,
      oneshotClaimedPath: claimedPath,
      consumedCapabilityPath: path.join(dir, 'oneshot-consumed.json'),
      dispatchReceiptPath: oneshotReceipt,
      workerBindTimeoutMs: 0,
      sleep: async () => {},
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          parentHandleCalls += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(parentHandleCalls, 0);
    assert.equal(missingListener.reason, 'dispatch_receipt_unproven');
    assert.equal(missingListener.invoked, 1);
    assert.equal(readOwnerOneshotRequest(requestPath), null);
    assert.equal(writeOwnerOneshotRequest({
      operation_binding: 'wrong',
      capability: encodeCapability(oneshotCap),
      nonce: oneshotCap.nonce,
      revision: REVISION,
      image_tag: IMAGE_SHA,
      digest: DIGEST,
    }, path.join(dir, 'bad-binding.json')), null);

    let staffHandleCalls = 0;
    const liveCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const liveRequest = path.join(dir, 'live-request.json');
    const liveClaimed = path.join(dir, 'live-request.claimed.json');
    const liveReceipt = path.join(dir, 'live-receipt.json');
    const liveConsumed = path.join(dir, 'live-consumed.json');
    const liveEnv = {
      MAIL_MVP_004_LIVE_PROOF: '1',
      MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
      LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
      EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
      EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
      LUNA_AUTO_SEND_ENABLED: 'true',
      LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      MAIL_MVP_004_REVISION: REVISION,
      MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
      MAIL_MVP_004_DIGEST: DIGEST,
    };
    const listener = startMailMvp004StaffOwnerOneshotListener({
      env: liveEnv,
      requestPath: liveRequest,
      claimedPath: liveClaimed,
      dispatchReceiptPath: liveReceipt,
      consumedCapabilityPath: liveConsumed,
      withPgClient: withZero,
      nowMs: NOW_MS,
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          staffHandleCalls += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(listener.ok, true);
    const handed = await runStaffOwnerProof({
      env: {
        ...liveEnv,
        MAIL_MVP_004_CAPABILITY: encodeCapability(liveCap),
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      useOneshot: true,
      oneshotRequestPath: liveRequest,
      oneshotClaimedPath: liveClaimed,
      consumedCapabilityPath: liveConsumed,
      dispatchReceiptPath: liveReceipt,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          parentHandleCalls += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(parentHandleCalls, 0);
    assert.equal(handed.invoked, 1);
    assert.ok(
      handed.reason === 'indeterminate_no_retry'
      || handed.status === 'sent'
      || handed.reason === 'operation_counts_mismatch',
    );
    const deadline = Date.now() + 2000;
    let liveDone = readDispatchReceipt(liveReceipt);
    while (Date.now() < deadline && (!liveDone || liveDone.status === 'issued')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      liveDone = readDispatchReceipt(liveReceipt);
    }
    assert.equal(staffHandleCalls, 1);
    assert.equal(liveDone.status, 'completed');
    assert.equal(liveDone.pid, null);
    assert.equal(liveDone.process_alive, false);
    stopMailMvp004StaffOwnerOneshotListener(listener);

    let releaseInflight;
    const inflightGate = new Promise((resolve) => { releaseInflight = resolve; });
    let inflightCalls = 0;
    const inflightCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const inflightRequest = path.join(dir, 'inflight-request.json');
    const inflightClaimed = path.join(dir, 'inflight-request.claimed.json');
    const inflightReceipt = path.join(dir, 'inflight-receipt.json');
    const inflightConsumed = path.join(dir, 'inflight-consumed.json');
    const inflightListener = startMailMvp004StaffOwnerOneshotListener({
      env: liveEnv,
      requestPath: inflightRequest,
      claimedPath: inflightClaimed,
      dispatchReceiptPath: inflightReceipt,
      consumedCapabilityPath: inflightConsumed,
      withPgClient: withZero,
      nowMs: NOW_MS,
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          inflightCalls += 1;
          await inflightGate;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(inflightListener.ok, true);
    const inflightHanded = await runStaffOwnerProof({
      env: {
        ...liveEnv,
        MAIL_MVP_004_CAPABILITY: encodeCapability(inflightCap),
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      useOneshot: true,
      oneshotRequestPath: inflightRequest,
      oneshotClaimedPath: inflightClaimed,
      consumedCapabilityPath: inflightConsumed,
      dispatchReceiptPath: inflightReceipt,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          parentHandleCalls += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(parentHandleCalls, 0);
    assert.equal(inflightHanded.reason, 'indeterminate_no_retry');
    assert.equal(inflightHanded.process_alive, true);
    assert.equal(inflightHanded.dispatch_marked, true);
    assert.equal(readDispatchReceipt(inflightReceipt).status, 'issued');
    assert.equal(inflightCalls, 1);
    releaseInflight();
    const inflightDeadline = Date.now() + 2000;
    let inflightDone = readDispatchReceipt(inflightReceipt);
    while (Date.now() < inflightDeadline && inflightDone && inflightDone.status === 'issued') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      inflightDone = readDispatchReceipt(inflightReceipt);
    }
    assert.equal(inflightDone.status, 'completed');
    assert.equal(inflightDone.pid, null);
    stopMailMvp004StaffOwnerOneshotListener(inflightListener);
    const refusedListener = startMailMvp004StaffOwnerOneshotListener({
      env: { LUNA_DEPLOYMENT: 'production' },
    });
    assert.equal(refusedListener.ok, false);
    assert.equal(refusedListener.reason, 'deployment_mismatch');
    assert.equal(claimOwnerOneshotRequest(path.join(dir, 'missing-req.json'), claimedPath), null);

    let orphanHandleCalls = 0;
    const orphanCap = issueSupervisorCapability({
      nonce: nonce(),
      revision: REVISION,
      replica: `${REVISION}-abcde-fghij`,
      imageTag: IMAGE_SHA,
      digest: DIGEST,
    }, NOW_MS);
    const orphan = await runStaffOwnerProof({
      env: {
        MAIL_MVP_004_LIVE_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_PROOF: '1',
        MAIL_MVP_004_STAFF_OWNER_WORKER: '1',
        MAIL_MVP_004_CAPABILITY_CONSUMED: '1',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
        EMAIL_LUNA_HERMES_SOL_AUTHOR_ENABLED: 'true',
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
        MAIL_MVP_004_CAPABILITY: encodeCapability(orphanCap),
        MAIL_MVP_004_REVISION: REVISION,
        MAIL_MVP_004_IMAGE_TAG: IMAGE_SHA,
        MAIL_MVP_004_DIGEST: DIGEST,
      },
      withPgClient: withZero,
      nowMs: NOW_MS,
      consumedCapabilityPath: path.join(dir, 'orphan-consumed.json'),
      dispatchReceiptPath: path.join(dir, 'orphan-receipt.json'),
      workerBindTimeoutMs: 0,
      sleep: async () => {},
      wired: {
        handleProjectedInbound: brandProductionAutoOwner(async () => {
          orphanHandleCalls += 1;
          return { status: 'sent' };
        }),
      },
    });
    assert.equal(orphanHandleCalls, 0);
    assert.equal(orphan.reason, 'dispatch_receipt_unproven');

    ignoreRemoteExecHangup();
    process.emit('SIGHUP');
    process.emit('SIGPIPE');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('[29] Host supervisor uses replica exec, not host PG');
  {
    const putCmd = buildStaffOwnerRemoteCommand(crypto.randomUUID(), false, { channelModePut: 'auto' });
    assert.match(putCmd, /MAIL_MVP_004_CHANNEL_MODE_PUT=auto/);
    assert.doesNotMatch(putCmd, /MAIL_MVP_004_STAFF_OWNER_PROOF=1/);
    assert.equal(isLegalStaffOwnerRemoteCommand(putCmd), true);
    const offCmd = buildStaffOwnerRemoteCommand(crypto.randomUUID(), false, { channelModePut: 'off' });
    assert.match(offCmd, /MAIL_MVP_004_CHANNEL_MODE_PUT=off/);
    const bad = encodeProofEnvPayload(crypto.randomUUID(), false, { channelModePut: 'draft' });
    const decoded = Buffer.from(bad, 'base64').toString('utf8');
    assert.match(decoded, /MAIL_MVP_004_STAFF_OWNER_PROOF=1/);
    assert.doesNotMatch(decoded, /MAIL_MVP_004_CHANNEL_MODE_PUT=draft/);

    let stored = 'off';
    const put = await runInnerChannelModePut({
      env: {
        MAIL_MVP_004_CHANNEL_MODE_PUT: 'auto',
        LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT,
      },
      async withPgClient(fn) {
        return fn({
          async query(sql) {
            const n = String(sql).replace(/\s+/g, ' ');
            if (/FROM clients cl INNER JOIN conversations c/.test(n)) return { rows: [threadRow()] };
            if (/inbox_channel_modes/.test(n) && /SELECT/.test(n)) {
              return { rows: [{ inbox_channel_modes: { email: stored } }] };
            }
            if (/jsonb_set/.test(n) || /inbox_channel_modes/.test(n)) {
              stored = 'auto';
              return { rows: [{ inbox_channel_modes: { email: stored } }] };
            }
            return { rows: [] };
          },
        });
      },
    });
    assert.equal(put.ok, true);
    assert.equal(put.public.channel_mode, 'auto');
  }

  console.log('[30] Capability-free inner exec retries trusted 429 once; owner does not');
  {
    assert.equal(replicaInnerExecRetryable({ channelModePut: 'auto' }), true);
    assert.equal(replicaInnerExecRetryable({ channelModePut: 'off' }), true);
    assert.equal(replicaInnerExecRetryable({ snapshot: 'mode' }), true);
    assert.equal(replicaInnerExecRetryable({ snapshot: 'preflight' }), true);
    assert.equal(replicaInnerExecRetryable({ killSwitchProbe: true }), true);
    assert.equal(replicaInnerExecRetryable({ graphVerify: true }), true);
    assert.equal(replicaInnerExecRetryable({ reconcileOnly: true }), true);
    assert.equal(replicaInnerExecRetryable({
      channelModePut: 'auto',
      capability: { nonce: 'x' },
    }), false);
    assert.equal(replicaInnerExecRetryable({}), false);
    assert.equal(replicaInnerExecRetryable(null), false);

    const bounced = classifyStaffOwnerExecResult({
      status: 1,
      stdout: '',
      stderr: "Handshake status 429 Too Many Requests retry-after: 600",
    });
    assert.equal(replicaInnerExecTrusted429(bounced), true);
    const marked429 = classifyStaffOwnerExecResult({
      status: 1,
      stdout: `${MUTATION_ISSUED_MARKER}\n`,
      stderr: 'Handshake status 429 Too Many Requests retry-after: 600',
    });
    assert.equal(replicaInnerExecTrusted429(marked429), false);
    const withInner = classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, channel_mode: 'off' })}\n`,
      stderr: '',
    });
    assert.equal(replicaInnerExecTrusted429(withInner), false);

    let calls = 0;
    const ok = classifyStaffOwnerExecResult({
      status: 0,
      stdout: `${JSON.stringify({ ok: true, channel_mode: 'auto' })}\n`,
    });
    const retried = await runReplicaInnerExecWith429Retry(async () => {
      calls += 1;
      return calls === 1 ? bounced : ok;
    }, { channelModePut: 'auto' });
    assert.equal(calls, 2);
    assert.equal(retried.inner.ok, true);
    assert.equal(retried.inner.channel_mode, 'auto');

    let ownerCalls = 0;
    await runReplicaInnerExecWith429Retry(async () => {
      ownerCalls += 1;
      return bounced;
    }, { capability: { nonce: 'no-retry' } });
    assert.equal(ownerCalls, 1);

    let waited = 0;
    const slept = [];
    const afterWait = await runReplicaInnerExecWith429Retry(async () => {
      waited += 1;
      return waited < 3 ? bounced : ok;
    }, { channelModePut: 'auto' }, async (ms) => {
      slept.push(ms);
    });
    assert.equal(waited, 3);
    assert.deepEqual(slept, [REPLICA_ATTEST_COOLDOWN_MS]);
    assert.notEqual(slept[0], REPLICA_ATTEST_RETRY_AFTER_WAIT_MS);
    assert.equal(afterWait.inner.channel_mode, 'auto');

    let twice = 0;
    const still429 = await runReplicaInnerExecWith429Retry(async () => {
      twice += 1;
      return bounced;
    }, { snapshot: 'mode' }, async () => {});
    assert.equal(twice, 3);
    assert.equal(replicaInnerExecTrusted429(still429), true);

    const invokeSrc = libSrc.slice(
      libSrc.indexOf('invokeAutoOwner: brandProductionAutoOwner'),
      libSrc.indexOf('async snapshotOperation'),
    );
    assert.doesNotMatch(invokeSrc, /runReplicaInnerExecWith429Retry/);
    const execSrc = libSrc.slice(
      libSrc.indexOf('async function execInner'),
      libSrc.indexOf('async function verifyGraphArrival'),
    );
    assert.match(execSrc, /runReplicaInnerExecWith429Retry\(runOnce, extra, sleep\)/);
    assert.doesNotMatch(execSrc, /REPLICA_ATTEST_RETRY_AFTER_WAIT_MS/);
  }

  console.log('\nPASS MAIL-MVP-004 Sunset auto create-and-send operator proof');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
