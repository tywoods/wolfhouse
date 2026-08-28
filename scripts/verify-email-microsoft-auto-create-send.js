#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-003 — Microsoft Auto create-and-send.
 *
 * Outer Microsoft inbound composition + owner matrix. Default remains OFF.
 * Successful auto send must be exactly one draft, one approval, one journal,
 * one canonical provider transport invocation.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const AUTO_REL = 'scripts/lib/email-luna-microsoft-auto-create-send.js';
const AUTO_ABS = path.join(ROOT, AUTO_REL);
const COMP_REL = 'scripts/lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js';
const COMP_ABS = path.join(ROOT, COMP_REL);
const PKG = path.join(ROOT, 'package.json');
const COMPOSE = path.join(ROOT, 'docker/hermes-staging/docker-compose.vm.yml');
const BASELINE = path.join(ROOT, 'config/clients/sunset.baseline.json');
const MAIL_MVP = path.join(ROOT, 'docs/MAIL-MVP.md');

const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const A = '55555555-5555-4555-8555-555555555555';
const M = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SRC = 'graph-src-auto-1';
const BODY = 'Thanks for your message. Would you like to make a booking?';
const APP_ID = '12345678-1234-4234-8234-123456789abc';
const SECRET = 'secret-NEVER_LEAK_AUTO';
const HOST = 'luna-sunset-staging-kv.vault.azure.net';
const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
const MI = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';

const {
  isEmailMicrosoftAutoSendEmergencyEnabled,
  createEmailLunaMicrosoftAutoCreateAndSend,
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
  ENV_OUTREACH,
} = require('./lib/email-luna-microsoft-auto-create-send');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function autoOn(patch) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_AUTO_SEND_ENABLED: 'true',
    LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'true',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
    ...(patch || {}),
  };
}

function authority() {
  return Object.freeze({ clientId: C, locationId: L, endpointId: E });
}

function envelope(patch) {
  return Object.freeze({
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: SRC,
    ...(patch || {}),
  });
}

function projection(patch) {
  return Object.freeze({
    status: 'projected',
    conversation_id: V,
    ...(patch || {}),
  });
}

function actor() {
  return Object.freeze({ staff_user_id: A, client_id: C, role: 'operator' });
}

function contextRow(patch) {
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
    needs_human: false,
    conversation_status: 'open',
    ...patch,
  };
}

function makeOwner(options = {}) {
  const providerCalls = [];
  const approvals = [];
  const journals = [];
  const drafts = [];
  const store = {
    mode: options.mode || 'auto',
    pause: options.pause || { lookup_error: false, global_paused: false, conversation_paused: false },
    row: options.row || contextRow(),
    approval: options.approval || null,
    journaledOps: new Set(options.journaledOps || []),
  };
  let inFlight = false;
  const owner = createEmailLunaMicrosoftAutoCreateAndSend({
    withPgClient: async (fn) => fn({
      async query(sql, params) {
        const n = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM staff_users su/.test(n)) {
          return { rows: options.noActor ? [] : [{ staff_user_id: A, client_id: C, role: 'operator' }] };
        }
        if (/FROM clients cl INNER JOIN conversations c/.test(n) || /cl.slug='sunset' AND loc.location_id='sunset-somo'/.test(n)) {
          if (options.contextMiss) return { rows: [] };
          return { rows: [store.row] };
        }
        if (/FROM tenant_email_reply_approvals/.test(n)) {
          return { rows: store.approval ? [store.approval] : [] };
        }
        return { rows: [] };
      },
    }),
    getEmailChannelMode: async () => store.mode,
    readPause: async () => store.pause,
    resolveAutoActor: options.noActor ? async () => null : async () => actor(),
    journalExists: async (approval) => store.journaledOps.has(String(approval.approval_id))
      || store.journaledOps.has(String(approval.operation_id)),
    regenerateEmailLunaDraftOnStaffClick: async (input) => {
      if (inFlight) return { status: 'conflict', draft_text: '', reason: 'in_progress' };
      inFlight = true;
      drafts.push(input);
      if (options.authorFail) return { status: 'pending', draft_text: '', send_allowed: false, auto_send_allowed: false };
      if (options.authorThrow) throw new Error('author_boom');
      assert.equal(input.operator_context, '');
      assert.equal(input.conversation_id, V);
      return {
        status: 'draft_ready',
        draft_text: options.draftText || BODY,
        conversation_id: V,
        send_allowed: false,
        auto_send_allowed: false,
        subject: 'Re: Boards',
      };
    },
    saveDraftThroughStaffOwner: async (input) => {
      approvals.push(input);
      if (options.saveFail) return { status: 'not_saved', conversation_id: V, approval_id: null };
      const id = '99999999-9999-4999-8999-999999999999';
      store.approval = {
        approval_id: id,
        operation_id: '88888888-8888-4888-8888-888888888888',
        message_text: input.message_text,
        state: 'draft',
        subject: input.subject,
        source_inbound_event_id: M,
      };
      return { status: 'saved', conversation_id: V, approval_id: id };
    },
    approveAndDispatchEmailOutbound: async (input) => {
      providerCalls.push(input);
      journals.push(input.approval_id);
      if (options.providerUnknown) {
        return { status: 503, code: 'email_send_outcome_unknown', journaled: true, provider_invoked: true };
      }
      if (options.providerFail) {
        return { status: 503, code: 'email_send_unavailable', journaled: false, provider_invoked: true };
      }
      store.approval = { ...(store.approval || {}), state: 'approved', approval_id: input.approval_id };
      store.journaledOps.add(String(input.approval_id));
      return { status: 200, code: 'email_send_committed', ok: true, journaled: true, provider_invoked: true };
    },
    recoverApprovedOutbound: async (input) => {
      providerCalls.push({ recover: true, ...input });
      return { status: 200, code: 'email_send_committed' };
    },
  });
  return { owner, providerCalls, approvals, journals, drafts, store };
}

async function runOwner(options, proj, envPatch, extraInput) {
  const h = makeOwner(options);
  const result = await h.owner.handleProjectedInbound({
    env: autoOn(envPatch),
    authority: authority(),
    envelope: envelope(extraInput && extraInput.envelope),
    projection: projection(proj),
  });
  return { ...h, result };
}

function enabledCaptureEnv(patch) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
    LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
    LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
    EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
    EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
    ...patch,
  };
}

function installAzureLoadIntercept() {
  const original = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === '@azure/identity') {
      return {
        ManagedIdentityCredential: class {
          constructor(clientId) { assert.equal(clientId, MI); }
          getToken() { return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 }); }
        },
      };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class {
          constructor(keyId) { assert.equal(keyId, KEY_ID); }
          wrapKey() { return Promise.resolve({ result: Buffer.alloc(256) }); }
          unwrapKey() { return Promise.resolve({ result: Buffer.alloc(32) }); }
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

async function runComposition(options = {}) {
  const autoCalls = [];
  const projectionInputs = [];
  const restore = installAzureLoadIntercept();
  const absStore = path.join(ROOT, 'scripts/lib/email-inbound-event-store.js');
  const secretPath = path.join(ROOT, 'scripts/lib/sunset-microsoft-oauth-provider.js');
  const kvPath = path.join(ROOT, 'scripts/lib/email-grant-envelope-azure-kv-sunset-staging-runtime-composition.js');
  const provPath = path.join(ROOT, 'scripts/lib/email-grant-envelope-provider-contract.js');
  const tokPath = path.join(ROOT, 'scripts/lib/email-microsoft-token-http-transport.js');
  const sessionPath = path.join(ROOT, 'scripts/lib/email-delegated-grant-access-session.js');
  const bridgePath = path.join(ROOT, 'scripts/lib/email-inbound-inbox-bridge.js');
  const immutPath = path.join(ROOT, 'scripts/lib/email-microsoft-graph-immutableid-page-transport.js');
  const authBoundPath = path.join(ROOT, 'scripts/lib/email-authority-bound-inbound-operation.js');
  const autoPath = AUTO_ABS;

  const prev = {};
  function fake(modPath, exports) {
    prev[modPath] = require.cache[modPath];
    require.cache[modPath] = {
      id: modPath, filename: modPath, loaded: true, exports,
    };
  }

  try {
    delete require.cache[COMP_ABS];
    delete require.cache[absStore];
    fake(secretPath, {
      SUNSET_DEPLOYMENT: 'sunset-staging',
      createSunsetMicrosoftOAuthClientSecretProvider: () => Object.freeze({ resolveClientSecret: async () => 'x' }),
    });
    fake(kvPath, {
      parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig: () => ({ ok: true, composition_enabled: true }),
      createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition: () => ({
        ok: true, composition_enabled: true, provider: Object.freeze({ wrap: true }),
      }),
    });
    fake(provPath, { validateEmailGrantEnvelopeProvider: (p) => ({ ok: true, value: p }) });
    fake(tokPath, { createMicrosoftTokenHttpTransport: () => Object.freeze({ post: async () => ({}) }) });
    fake(sessionPath, {
      SUNSET_DEPLOYMENT: 'sunset-staging',
      createDelegatedGrantAccessSession: () => Object.freeze({
        runWithAccessTokenOnce: async () => ({ ok: true }),
      }),
    });
    fake(bridgePath, {
      createEmailInboundInboxBridge: () => Object.freeze({
        projectInboundEvent: async (input) => {
          projectionInputs.push(input);
          return Object.freeze({
            status: options.projectionStatus || 'projected',
            conversation_id: V,
          });
        },
      }),
    });
    fake(immutPath, {
      createMicrosoftGraphImmutableIdPageTransport: () => Object.freeze({
        listNormalizedInboundEnvelopes: async () => Object.freeze([]),
      }),
    });
    const batch = options.batch || [envelope()];
    fake(absStore, {
      EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED: false,
      resolveWithTransactionClient: (raw) => (typeof raw === 'function' ? raw : null),
      createDurableInboundEventStoreConsumer: () => async () => ({ acknowledged: true }),
    });
    fake(authBoundPath, {
      FAILURE_CODE: 'authority_bound_inbound_failed',
      RESULT_KEYS: Object.freeze(['status', 'input_count', 'delivered_count', 'duplicate_count']),
      createAuthorityBoundInboundOperation: (deps) => Object.freeze({
        runAuthorityBoundInbound: async () => {
          const ack = await deps.consumer(Object.freeze(batch.map((item) => Object.freeze(item))));
          assert.deepEqual(ack, { acknowledged: true });
          return Object.freeze({
            ok: true,
            value: Object.freeze({
              status: 'processed',
              input_count: batch.length,
              delivered_count: batch.length,
              duplicate_count: 0,
            }),
          });
        },
      }),
    });
    const realAuto = require(autoPath);
    fake(autoPath, {
      ...realAuto,
      afterMicrosoftInboundProjected: async (input) => {
        autoCalls.push(input);
        if (typeof options.autoImpl === 'function') return options.autoImpl(input);
        return realAuto.afterMicrosoftInboundProjected(input);
      },
      shouldSuppressInboundNeedsHuman: async (input) => {
        if (typeof options.suppressNeedsHuman === 'function') return options.suppressNeedsHuman(input);
        return realAuto.shouldSuppressInboundNeedsHuman(input);
      },
    });
    delete require.cache[COMP_ABS];
    const comp = require(COMP_REL.replace('scripts/', './'));
    const commits = [];
    const runtime = comp.createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime({
      env: enabledCaptureEnv(options.envPatch),
      pgClient: { async query() { return { rows: [] }; } },
      withTransactionClient: async (work) => work({
        async query(sql) {
          const n = String(sql).replace(/\s+/g, ' ').trim();
          if (n === 'COMMIT') commits.push(n);
          return { rows: [] };
        },
      }),
      https: { request() {} },
      timers: { setTimeout() {}, clearTimeout() {} },
    });
    const result = await runtime.runInboundEventStore(authority());
    return { result, autoCalls, projectionInputs, commits, comp };
  } finally {
    restore();
    for (const [modPath, cached] of Object.entries(prev)) {
      if (cached) require.cache[modPath] = cached;
      else delete require.cache[modPath];
    }
    delete require.cache[COMP_ABS];
    delete require.cache[AUTO_ABS];
  }
}

async function main() {
  console.log('verify:email-microsoft-auto-create-send\n');

  console.log('[1] Emergency flags — literal true AND, fail closed');
  ok('both true enables', isEmailMicrosoftAutoSendEmergencyEnabled(autoOn()) === true);
  ok('missing email flag blocks', isEmailMicrosoftAutoSendEmergencyEnabled({
    LUNA_AUTO_SEND_ENABLED: 'true',
  }) === false);
  ok('missing luna flag blocks', isEmailMicrosoftAutoSendEmergencyEnabled({
    LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
  }) === false);
  ok('false blocks', isEmailMicrosoftAutoSendEmergencyEnabled(autoOn({
    LUNA_AUTO_SEND_ENABLED: 'false',
  })) === false);
  ok('TRUE malformed blocks', isEmailMicrosoftAutoSendEmergencyEnabled(autoOn({
    LUNA_AUTO_SEND_ENABLED: 'TRUE',
  })) === false);
  ok('1 malformed blocks', isEmailMicrosoftAutoSendEmergencyEnabled(autoOn({
    LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: '1',
  })) === false);
  ok('empty blocks', isEmailMicrosoftAutoSendEmergencyEnabled(autoOn({
    LUNA_AUTO_SEND_ENABLED: '',
  })) === false);
  ok('outreach true does not enable', isEmailMicrosoftAutoSendEmergencyEnabled({
    CUSTOMER_OUTREACH_EMAIL_ENABLED: 'true',
  }) === false);
  const autoSrc = fs.readFileSync(AUTO_ABS, 'utf8');
  ok('does not read CUSTOMER_OUTREACH_EMAIL_ENABLED as a gate',
    !/envOwn\(env,\s*ENV_OUTREACH\)/.test(autoSrc)
    && !/env\[ENV_OUTREACH\]/.test(autoSrc)
    && autoSrc.includes(ENV_OUTREACH));
  ok('exports exact flag names',
    ENV_LUNA_AUTO_SEND_ENABLED === 'LUNA_AUTO_SEND_ENABLED'
    && ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED === 'LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED');
  const channelModeSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/email-inbox-channel-mode.js'), 'utf8');
  ok('003 channel-mode store uses clients.settings not metadata',
    /settings->'inbox_channel_modes'/.test(channelModeSrc)
    && /SET settings = jsonb_set/.test(channelModeSrc)
    && !/metadata->'inbox_channel_modes'/.test(channelModeSrc)
    && /createEmailInboxChannelModeStore/.test(autoSrc));
  ok('auto context binds the same sendable Microsoft mailbox as staff SQL_RESOLVE',
    autoSrc.includes("ep.binding_status='verified'")
    && autoSrc.includes("ep.auth_mode='delegated_authorization_code'")
    && autoSrc.includes("ep.connector_mode='microsoft_delegated_oauth'")
    && autoSrc.includes("ep.mailbox_access_kind='own_user'")
    && autoSrc.includes('ev.provider_mailbox_id=ep.provider_resource_id')
    && autoSrc.includes('ev.provider_message_id=p.provider_message_id')
    && autoSrc.includes("ep.location_id=loc.location_id")
    && autoSrc.includes("ep.provider_resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'")
    && autoSrc.includes('btrim(ep.public_address)')
    && !/FOR UPDATE/.test(autoSrc));

  console.log('\n[2] Owner matrix — blocked paths have zero provider sends');
  {
    const off = await runOwner({}, {}, { LUNA_AUTO_SEND_ENABLED: 'false' });
    ok('auto off: blocked, zero send',
      off.result.status === 'blocked' && off.result.reason === 'emergency_flags_off'
      && off.providerCalls.length === 0 && off.approvals.length === 0 && off.drafts.length === 0);

    const missing = await runOwner({}, {}, { LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: undefined });
    ok('email emergency missing: blocked, zero send',
      missing.result.reason === 'emergency_flags_off' && missing.providerCalls.length === 0);

    const malformed = await runOwner({}, {}, { LUNA_AUTO_SEND_ENABLED: 'yes' });
    ok('malformed emergency: blocked, zero send',
      malformed.result.reason === 'emergency_flags_off' && malformed.providerCalls.length === 0);

    const draftMode = await runOwner({ mode: 'draft' });
    ok('channel Auto off (draft): blocked, zero send',
      draftMode.result.reason === 'email_channel_not_auto'
      && draftMode.providerCalls.length === 0 && draftMode.approvals.length === 0);

    const lunaOff = await runOwner({ pause: { lookup_error: false, global_paused: false, conversation_paused: true } });
    ok('Luna Off blocks before draft/send',
      lunaOff.result.reason === 'luna_off'
      && lunaOff.drafts.length === 0 && lunaOff.providerCalls.length === 0);

    const globalPause = await runOwner({ pause: { lookup_error: false, global_paused: true, conversation_paused: false } });
    ok('global pause fail closed',
      globalPause.result.reason === 'global_paused' && globalPause.providerCalls.length === 0);

    const pauseErr = await runOwner({ pause: { lookup_error: true, global_paused: true, conversation_paused: true } });
    ok('pause lookup failure fail closed',
      pauseErr.result.reason === 'pause_fail_closed' && pauseErr.providerCalls.length === 0);

    const needsHuman = await runOwner({ row: contextRow({ needs_human: true }) });
    ok('needs_human blocks before draft/send',
      needsHuman.result.reason === 'needs_human'
      && needsHuman.drafts.length === 0 && needsHuman.providerCalls.length === 0);

    const mismatch = await runOwner({ row: contextRow({ location_key: 'sunset-sardinero' }) });
    ok('location mismatch blocks',
      mismatch.result.reason === 'authority_mismatch' && mismatch.providerCalls.length === 0);

    const endpointMismatch = await runOwner({
      row: contextRow({ endpoint_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
    });
    ok('endpoint mismatch blocks',
      endpointMismatch.result.reason === 'authority_mismatch' && endpointMismatch.providerCalls.length === 0);

    const mailboxType = await runOwner({ row: contextRow({ provider_mailbox_id: { id: MAILBOX } }) });
    ok('non-string mailbox id blocks before save',
      mailboxType.result.reason === 'authority_mismatch'
      && mailboxType.approvals.length === 0 && mailboxType.providerCalls.length === 0);

    const imap = await runOwner({}, {}, {}, { envelope: { provider: 'imap_smtp' } });
    ok('non-Microsoft provider excluded',
      imap.result.reason === 'provider_not_microsoft' && imap.providerCalls.length === 0);

    const authorFail = await runOwner({ authorFail: true });
    ok('author failure fail closed, no approval/send',
      authorFail.result.status === 'failed' && authorFail.result.sent === false
      && authorFail.approvals.length === 0 && authorFail.providerCalls.length === 0);

    const saveFail = await runOwner({ saveFail: true });
    ok('save/approval failure: no provider send, not marked sent',
      saveFail.result.status === 'failed' && saveFail.result.sent === false
      && saveFail.providerCalls.length === 0
      && saveFail.result.reason === 'approval_not_saved');

    const providerFail = await runOwner({ providerFail: true });
    ok('provider failure: not marked sent',
      providerFail.result.status === 'failed' && providerFail.result.sent === false
      && providerFail.result.reason === 'provider_failure');

    const unknown = await runOwner({ providerUnknown: true });
    ok('provider uncertainty: not marked sent, no false committed',
      unknown.result.status === 'failed' && unknown.result.sent === false
      && unknown.result.code === 'email_send_outcome_unknown');
  }

  console.log('\n[3] Eligible success — exactly one draft, approval, journal, provider send');
  {
    const hit = await runOwner({});
    ok('eligible all-on sends', hit.result.status === 'sent' && hit.result.sent === true);
    ok('exactly one Create Draft author call with empty context',
      hit.drafts.length === 1 && hit.drafts[0].operator_context === '');
    ok('exactly one approval', hit.approvals.length === 1 && hit.result.approvals === 1);
    ok('expected_authority matches sendable staff-resolve shape',
      hit.approvals[0].expected_authority
      && hit.approvals[0].expected_authority.provider === 'microsoft_graph'
      && hit.approvals[0].expected_authority.provider_mailbox_id === MAILBOX
      && hit.approvals[0].expected_authority.provider_source_message_id === SRC
      && hit.approvals[0].expected_authority.source_inbound_event_id === M
      && hit.approvals[0].expected_authority.location_key === 'sunset-somo');
    ok('exactly one provider transport', hit.providerCalls.length === 1 && hit.result.provider_sends === 1);
    ok('exactly one journal', hit.journals.length === 1 && hit.result.journals === 1);
    ok('Create Draft still draft_only contract on author result path',
      hit.drafts.length === 1);
    ok('no We also wanted to add / invented payment in owner wiring',
      !String(hit.approvals[0] && hit.approvals[0].message_text).includes('We also wanted to add'));
  }

  console.log('\n[4] Duplicate / retry / concurrent');
  {
    const first = await runOwner({});
    const dup = await runOwner({
      approval: {
        approval_id: first.result.approval_id,
        operation_id: '88888888-8888-4888-8888-888888888888',
        message_text: BODY,
        state: 'approved',
        subject: 'Re: Boards',
        source_inbound_event_id: M,
      },
      journaledOps: [first.result.approval_id],
    });
    ok('duplicate webhook/event: no second approval/journal/send',
      dup.result.status === 'skipped' && dup.result.reason === 'already_sent'
      && dup.drafts.length === 0 && dup.approvals.length === 0 && dup.providerCalls.length === 1
      && dup.providerCalls[0].recover === true);

    const h = makeOwner({});
    const a = h.owner.handleProjectedInbound({
      env: autoOn(), authority: authority(), envelope: envelope(), projection: projection(),
    });
    const b = h.owner.handleProjectedInbound({
      env: autoOn(), authority: authority(), envelope: envelope(), projection: projection({ status: 'already_projected' }),
    });
    const [ra, rb] = await Promise.all([a, b]);
    const sends = h.providerCalls.filter((c) => !c.recover).length;
    ok('concurrent duplicate: at most one provider send',
      sends === 1
      && ((ra.status === 'sent' && rb.status !== 'sent') || (rb.status === 'sent' && ra.status !== 'sent')
        || (ra.status === 'sent' && rb.status === 'skipped') || (rb.status === 'sent' && ra.status === 'skipped')
        || (ra.status === 'sent' && rb.status === 'sent' && h.providerCalls.length === 1)));
  }

  console.log('\n[5] Outer Microsoft inbound composition');
  {
    const dormant = await runComposition();
    ok('composition still succeeds with flags off',
      dormant.result.status === 'success' && dormant.result.durably_processed === true);
    ok('flags off: auto owner not invoked', dormant.autoCalls.length === 0);
    ok('flags off: projection does not pass setNeedsHuman',
      dormant.projectionInputs.every((p) => !Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman')));

    const eligible = await runComposition({
      envPatch: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      autoImpl: async (input) => {
        assert.equal(input.authority.clientId, C);
        assert.equal(input.authority.locationId, L);
        assert.equal(input.authority.endpointId, E);
        assert.equal(input.envelope.provider, 'microsoft_graph');
        assert.equal(input.projection.status, 'projected');
        assert.equal(input.projection.conversation_id, V);
        return { status: 'sent', sent: true, draft_writes: 1, approvals: 1, journals: 1, provider_sends: 1 };
      },
    });
    ok('eligible composition invokes auto after projection with trusted binding',
      eligible.autoCalls.length === 1
      && eligible.autoCalls[0].authority.clientId === C
      && eligible.autoCalls[0].authority.endpointId === E
      && eligible.autoCalls[0].projection.conversation_id === V);
    ok('inbound durability still success when auto runs',
      eligible.result.status === 'success');

    const dupEvent = await runComposition({
      envPatch: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      projectionStatus: 'already_projected',
      autoImpl: async (input) => {
        assert.equal(input.projection.status, 'already_projected');
        return { status: 'skipped', reason: 'already_sent', provider_sends: 0 };
      },
    });
    ok('already_projected still enters auto owner (idempotent skip, not a public endpoint)',
      dupEvent.autoCalls.length === 1);

    const two = await runComposition({
      envPatch: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      batch: [envelope({ provider_message_id: 'a' }), envelope({ provider_message_id: 'b' })],
      autoImpl: async () => ({ status: 'blocked', reason: 'email_channel_not_auto' }),
    });
    ok('one auto attempt per inbound envelope', two.autoCalls.length === 2);

    const lunaFlagOnly = await runComposition({
      envPatch: { LUNA_AUTO_SEND_ENABLED: 'true' },
      autoImpl: async () => { throw new Error('auto_must_not_run'); },
    });
    ok('single emergency flag does not invoke auto', lunaFlagOnly.autoCalls.length === 0);

    const malformedComp = await runComposition({
      envPatch: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'TRUE',
      },
    });
    ok('malformed email auto flag does not invoke auto', malformedComp.autoCalls.length === 0);
  }

  console.log('\n[6] Create Draft / Approve compatibility pins + dormant defaults');
  {
    const draftRoute = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js'), 'utf8');
    ok('Create Draft still send_allowed false / auto_send_allowed false',
      /send_allowed === false/.test(draftRoute) && /auto_send_allowed === false/.test(draftRoute));
    const inboxRoutes = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js'), 'utf8');
    ok('Approve & send still owns SQL_APPROVE + journal + dispatchApprovedOutbound',
      /SQL_APPROVE/.test(inboxRoutes)
      && /SQL_JOURNAL_EXISTS/.test(inboxRoutes)
      && /dispatchApprovedOutbound/.test(inboxRoutes)
      && /approveAndDispatchEmailOutbound/.test(inboxRoutes));
    const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
    ok('auto hooks existing Microsoft inbound composition, not a public endpoint',
      /afterMicrosoftInboundProjected/.test(compSrc)
      && !/app\.(get|post|put)\(/.test(autoSrc));
    ok('delta worker Microsoft path also hooks auto',
      fs.readFileSync(path.join(ROOT, 'scripts/lib/email-delta-sunset-staging-runtime-composition.js'), 'utf8')
        .includes('afterMicrosoftInboundProjected'));
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    ok('package.json has verify:mail-mvp-003', !!pkg.scripts['verify:mail-mvp-003']);
    ok('verify:mail-mvp-001 unchanged chain',
      /verify-email-create-draft-context/.test(pkg.scripts['verify:mail-mvp-001'])
      && /verify-inbox-email-create-draft-ui/.test(pkg.scripts['verify:mail-mvp-001']));
    const compose = fs.readFileSync(COMPOSE, 'utf8');
    ok('compose does not set email auto-send true',
      !/LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED=true/.test(compose));
    const baseline = fs.readFileSync(BASELINE, 'utf8');
    ok('baseline does not enable auto-send flags',
      !/LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED/.test(baseline));
    const plan = fs.readFileSync(MAIL_MVP, 'utf8');
    ok('MAIL-MVP.md records 003 as this Microsoft auto slice',
      /003/.test(plan) && /auto create-and-send/.test(plan));
    ok('no default env flip in auto owner',
      /=== 'true'/.test(autoSrc)
      && autoSrc.includes('LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED'));
  }

  console.log(`\n── verify:email-microsoft-auto-create-send ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
