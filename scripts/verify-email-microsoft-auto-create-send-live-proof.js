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
  flagsLiteral,
  traffic100RevisionName,
  mergeRevisionIntoServing,
  extractAzureJson,
  parseAcrManifestDigest,
  readProductionServingIdentity,
  parseReplicaProcessEnv,
  buildReadonlyGraphListRequest,
  GRAPH_LIST_SELECT,
  buildSetEnvArgs,
  buildRevisionShowArgs,
  buildAcrManifestDigestArgs,
  buildStaffOwnerRemoteCommand,
  buildStaffOwnerExecAzArgs,
  encodeProofEnvPayload,
  isLegalStaffOwnerRemoteCommand,
  wrapPtyAzExec,
  spawnPtyHarness,
  classifyStaffOwnerExecResult,
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
  createEmailLunaMicrosoftAutoCreateAndSend,
  afterMicrosoftInboundProjected,
  selectProofThread,
  snapshotSelectedOperation,
  SQL_COUNT_BOOKINGS,
  runStaffOwnerProof,
  runCli,
  runKillSwitchProbe,
  runInnerSnapshot,
  runInnerGraphVerify,
  replicaLeftover,
  replicaSolProven,
} = require('./lib/email-luna-microsoft-auto-create-send-live-proof');
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
  const invoke = options.invoke || brandProductionAutoOwner(async () => {
    log.push('invoke');
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
    requireProductionOwner: options.requireProductionOwner,
    async readServingIdentity() {
      log.push(`read:${current.flags[ENV_LUNA_AUTO_SEND_ENABLED]}`);
      return current;
    },
    async waitServingHealthy({ enabled }) {
      log.push(`wait:${enabled}`);
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
      mode = value;
    },
    async getEmailChannelMode() { return mode; },
    async preflightSelectedOperation() {
      return options.preflight || preflightOk();
    },
    invokeAutoOwner: invoke,
    async snapshotOperation() { return { ...op }; },
    async readDurableEvidence() {
      return evidence;
    },
    async verifyGraphArrival() {
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
    assert.match(supervisorSrc, /execInner\(\{\s*snapshot:\s*'evidence'\s*\}\)/);
    assert.match(supervisorSrc, /execInner\(\{ killSwitchProbe: true \}\)/);
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
    assert.doesNotMatch(libSrc, /brandProductionGraphVerifier\(async \(\) => freeze\(\{\s*ok: false,\s*reason: 'graph_adapter_unwired'/);

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
        assert.doesNotMatch(String(opts.path), /sendMail|\/send\b/i);
        assert.match(opts.headers.Authorization, /^Bearer loan-token$/);
        const { PassThrough } = require('node:stream');
        const res = new PassThrough();
        const req = new PassThrough();
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
    assert.equal(innerGraph.ok, true);
    assert.equal(innerGraph.adapter_available, true);
    assert.equal(innerGraph.readonly, true);
    assert.equal(innerGraph.arrivals, 1);
    assert.equal(innerGraph.duplicates, 0);
    assert.equal(innerGraph.threaded, true);
    assert.equal(Object.prototype.hasOwnProperty.call(innerGraph, 'id'), false);
    assert.doesNotMatch(JSON.stringify(innerGraph), /loan-token|twoods@|graph-sent-1|Would you like/);
    assert.equal(seenGraph.length, 1);

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
          const { PassThrough } = require('node:stream');
          const res = new PassThrough();
          const req = new PassThrough();
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
    assert.match(cliSrc, /console\.log\(JSON\.stringify\(publicProofOutput\(result\)\)\)/);

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
    });
    assert.equal(evidenceFallback.ok, true);
    assert.equal(evidenceFallback.hmac_available, true);
    assert.equal(evidenceFallback.evidence_verified, false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceFallback, 'message_text'), false);
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
function withPgClient(fn) {
  return fn({
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
}
Module._load = function(request, parent, isMain) {
  const loaded = origLoad.apply(this, arguments);
  let resolved = request;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch {}
  if (path.resolve(resolved) !== target) return loaded;
  const origRunCli = loaded.runCli;
  const inject = { withPgClient, consumedCapabilityPath: ${JSON.stringify(consumedPath)} };
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
        process.nextTick(() => {
          cb(res);
          res.end(JSON.stringify({ value: fixture.graphMessages }));
        });
        req.destroy = () => {};
        return req;
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
    const evidenceOut = extractProofJson(`${evidenceSpawn.stdout}${evidenceSpawn.stderr}`);
    assert.equal(evidenceOut.ok, true);
    assert.equal(evidenceOut.hmac_available, true);
    assert.equal(evidenceOut.evidence_verified, true);
    assert.equal(evidenceOut.leftover, false);
    assert.notEqual(evidenceOut.status, 'sent');
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'message_text'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(evidenceOut, 'evidence_mac'), false);
    assertNoInnerLeak(evidenceSpawn.stdout);

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
    assert.notEqual(graphOut.status, 'sent');
    assertNoInnerLeak(graphSpawn.stdout);

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

  console.log('\nPASS MAIL-MVP-004 Sunset auto create-and-send operator proof');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
