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
  servingHealthyReady100,
  flagsLiteral,
  traffic100RevisionName,
  readProductionServingIdentity,
  parseReplicaProcessEnv,
  buildReadonlyGraphListRequest,
  GRAPH_LIST_SELECT,
  buildSetEnvArgs,
  buildRevisionShowArgs,
  buildStaffOwnerRemoteCommand,
  buildStaffOwnerExecAzArgs,
  encodeProofEnvPayload,
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
  runStaffOwnerProof,
  runCli,
  runKillSwitchProbe,
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
  return {
    message_text: messageText,
    draft_meta: { selected_operation_evidence: evidence },
    provenance: { ...evidence, marker: SOL },
    immutable_draft_id: 'graph-draft-004',
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
      return options.graph || { ok: true, threaded: true, arrivals: 1, duplicates: 0 };
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
    env: { LUNA_DEPLOYMENT: SUNSET_DEPLOYMENT, [ENV_HMAC_SECRET]: HMAC_SECRET },
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
        if (/FROM bookings/.test(n)) {
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
    assert.match(execArgs[execArgs.indexOf('--command') + 1], new RegExp(PROOF_REMOTE_NODE.replace(/\./g, '\\.')));
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
    assert.match(libSrc, /if \(inner\) \{\s*return freeze\(\{ \.\.\.inner, dispatch_marked: marked === true \}\);/s);

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

  console.log('\nPASS MAIL-MVP-004 Sunset auto create-and-send operator proof');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
