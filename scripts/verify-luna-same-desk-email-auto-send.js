'use strict';

/**
 * SAME-DESK-004 — email auto-send on the inbound Staff-API seam, like
 * WhatsApp auto, when conversation Luna is On AND needs_human is false
 * AND tenant Global Pause is off.
 *
 * Draft-only otherwise. Approve & send remains the needs_human path.
 * WhatsApp auto is unchanged. MAIL-MVP-003 emergency flags stay dormant.
 *
 * Fakes only at provider / DB boundaries. The shipped auto-create-send
 * owner + inbound composition + WhatsApp send route run for real.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const AUTO_REL = 'scripts/lib/email-luna-microsoft-auto-create-send.js';
const AUTO_ABS = path.join(ROOT, AUTO_REL);
const COMP_REL = 'scripts/lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js';
const COMP_ABS = path.join(ROOT, COMP_REL);
const DELTA_ABS = path.join(ROOT, 'scripts/lib/email-delta-sunset-staging-runtime-composition.js');
const WA_ROUTE_ABS = path.join(ROOT, 'scripts/lib/luna-guest-reply-send-route.js');
const WA_ELIG_ABS = path.join(ROOT, 'scripts/lib/luna-guest-reply-send-eligibility.js');
const INBOX_ROUTES_ABS = path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js');
const OPEN_ABS = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js');
const BOOKING_ABS = path.join(ROOT, 'scripts/lib/email-luna-booking-from-email.js');
const MIG_100_UP = path.join(ROOT, 'database/migrations/100_tenant_email_same_desk_auto_send_claims.sql');
const MIG_100_DOWN = path.join(ROOT, 'database/migrations/100_tenant_email_same_desk_auto_send_claims_down.sql');
const STOCK_PG_PROVE = path.join(ROOT, 'scripts/prove-luna-same-desk-auto-send-claim-stock-pg.js');
const CLAIM_TABLE = 'tenant_email_same_desk_auto_send_claims';
const CLAIM_IDENTITY_UQ = 'tenant_email_same_desk_auto_send_claims_identity_uq';
const CLAIM_OWNER_ABS = path.join(ROOT, 'scripts/lib/email-luna-same-desk-auto-send-claim.js');
const { spawnSync } = require('node:child_process');

const {
  createEmailLunaMicrosoftAutoCreateAndSend,
  isEmailMicrosoftAutoSendEmergencyEnabled,
  shouldSuppressInboundNeedsHuman,
  ENV_LUNA_AUTO_SEND_ENABLED,
  ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED,
} = require('./lib/email-luna-microsoft-auto-create-send');
const { evaluateGuestReplySendRoute } = require('./lib/luna-guest-reply-send-route');

const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const V = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const A = '55555555-5555-4555-8555-555555555555';
const M = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const SRC = 'graph-src-same-desk-004';
const BODY = 'Thanks for your message. Would you like to make a booking?';
const APPROVAL_ID = '99999999-9999-4999-8999-999999999999';

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function sameDeskEnv(patch) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_AUTO_SEND_ENABLED: 'true',
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
  const staffApproves = [];
  const store = {
    mode: options.mode || 'auto',
    pause: options.pause || { lookup_error: false, global_paused: false, conversation_paused: false },
    row: options.row || contextRow(),
    approval: options.approval || null,
    journaledOps: new Set(options.journaledOps || []),
  };
  const owner = createEmailLunaMicrosoftAutoCreateAndSend({
    withPgClient: async (fn) => fn({
      async query(sql) {
        const n = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM staff_users su/.test(n)) {
          return { rows: [{ staff_user_id: A, client_id: C, role: 'operator' }] };
        }
        if (/FROM clients cl INNER JOIN conversations c/.test(n)
            || /cl.slug='sunset' AND loc.location_id='sunset-somo'/.test(n)) {
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
    resolveAutoActor: async () => actor(),
    journalExists: async (approval) => store.journaledOps.has(String(approval.approval_id))
      || store.journaledOps.has(String(approval.operation_id)),
    regenerateEmailLunaDraftOnStaffClick: async (input) => {
      drafts.push(input);
      assert.equal(input.operator_context, '');
      return {
        status: 'draft_ready',
        draft_text: BODY,
        conversation_id: V,
        send_allowed: false,
        auto_send_allowed: false,
        draft_only: true,
        subject: 'Re: Boards',
      };
    },
    claimSameDeskAutoSend: async () => {
      if (options.claimLost) {
        return { status: 'lost', reason: 'already_claimed', approval_id: options.claimApprovalId || null };
      }
      return { status: 'won', claim_id: '11111111-1111-4111-8111-111111111111', state: 'claimed' };
    },
    linkSameDeskAutoSendApproval: async (input) => {
      store.claim = { ...input, state: 'linked' };
      return { status: 'linked' };
    },
    saveDraftThroughStaffOwner: async (input) => {
      approvals.push(input);
      store.approval = {
        approval_id: APPROVAL_ID,
        operation_id: '88888888-8888-4888-8888-888888888888',
        message_text: input.message_text,
        state: 'draft',
        subject: input.subject,
        source_inbound_event_id: M,
      };
      return { status: 'saved', conversation_id: V, approval_id: APPROVAL_ID };
    },
    approveAndDispatchEmailOutbound: async (input) => {
      providerCalls.push(input);
      journals.push(input.approval_id);
      store.approval = { ...(store.approval || {}), state: 'approved', approval_id: input.approval_id };
      store.journaledOps.add(String(input.approval_id));
      store.row = { ...store.row, needs_human: false, conversation_status: 'open' };
      return { status: 200, code: 'email_send_committed', ok: true, journaled: true, provider_invoked: true };
    },
    recoverApprovedOutbound: async (input) => {
      providerCalls.push({ recover: true, ...input });
      return { status: 200, code: 'email_send_committed' };
    },
  });
  return {
    owner,
    providerCalls,
    approvals,
    journals,
    drafts,
    staffApproves,
    store,
    async staffApproveExistingDraft() {
      staffApproves.push(store.approval);
      const dispatched = await owner.approveAndDispatchEmailOutbound
        ? owner.approveAndDispatchEmailOutbound({
          actor: actor(),
          conversation_id: V,
          message_text: store.approval.message_text,
          approval_id: store.approval.approval_id,
          subject: store.approval.subject,
          env: sameDeskEnv(),
        })
        : null;
      return dispatched;
    },
  };
}

function sameDeskHandle(owner, input) {
  if (typeof owner.handleSameDeskProjectedInbound === 'function') {
    return owner.handleSameDeskProjectedInbound(input);
  }
  return owner.handleProjectedInbound(input);
}

/** Mirror SQL_UPSERT_CONVERSATION needs_human CASE from the inbox bridge. */
function applyProducerNeedsHuman(existing, projectInput, provider) {
  const suppressed = Object.prototype.hasOwnProperty.call(projectInput, 'setNeedsHuman')
    && projectInput.setNeedsHuman === false;
  const excluded = suppressed ? false : provider === 'microsoft_graph';
  if (existing == null) return excluded === true;
  return excluded ? true : existing;
}

function sqlConst(src, name) {
  const m = String(src).match(new RegExp(`const ${name} = \`([\\s\\S]*?)\``));
  return m ? m[1] : '';
}

function runStockPgProof(label) {
  if (!fs.existsSync(STOCK_PG_PROVE)) {
    check(label, false, `missing ${path.relative(ROOT, STOCK_PG_PROVE)}`);
    return false;
  }
  const result = spawnSync(process.execPath, [STOCK_PG_PROVE], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  const skipped = /PASS-by-skip|skipped when .* unset|not counted as PASS|UNAVAILABLE/i.test(out)
    && result.status === 0;
  check(
    label,
    result.status === 0 && skipped !== true
      && /exactly one claim winner/i.test(out)
      && /loser provider-inert/i.test(out),
    `status=${result.status} skipped=${skipped} tail=${out.slice(-800)}`,
  );
  return result.status === 0 && skipped !== true;
}

function installAzureLoadIntercept() {
  const original = Module._load;
  Module._load = function intercepted(request, parent, isMain) {
    if (request === '@azure/identity') {
      return { ManagedIdentityCredential: class { getToken() { return Promise.resolve({ token: 'x', expiresOnTimestamp: Date.now() + 1 }); } } };
    }
    if (request === '@azure/keyvault-keys') {
      return {
        CryptographyClient: class {
          wrapKey() { return Promise.resolve({ result: Buffer.alloc(256) }); }
          unwrapKey() { return Promise.resolve({ result: Buffer.alloc(32) }); }
        },
      };
    }
    return original.call(this, request, parent, isMain);
  };
  return () => { Module._load = original; };
}

function tryLoadPglite() {
  for (const base of [
    process.env.NODE_PATH,
    path.join(ROOT, 'node_modules'),
    '/opt/data/wolfhouse-agent/node_modules',
    '/opt/data/worktrees/bookings-finance-label-audit/node_modules',
    '/opt/data/worktrees/full-sail-stage1-ch3a/node_modules',
    '/opt/data/calendar-inventory-bridge-bf/node_modules',
  ].filter(Boolean)) {
    try {
      const mod = require(path.join(String(base).split(path.delimiter)[0], '@electric-sql/pglite'));
      if (mod && mod.PGlite) return mod.PGlite;
    } catch {
      /* continue */
    }
  }
  try { return require('@electric-sql/pglite').PGlite; } catch { return null; }
}

async function runInboundComposition(options = {}) {
  const autoCalls = [];
  const sameDeskCalls = [];
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
  const conv = { needs_human: Object.prototype.hasOwnProperty.call(options, 'seedNeedsHuman') ? options.seedNeedsHuman : null };
  const ownerHarness = options.ownerOptions ? makeOwner(options.ownerOptions) : makeOwner({
    row: contextRow({ needs_human: conv.needs_human === true }),
    pause: options.pause,
  });
  const prev = {};
  function fake(modPath, exports) {
    prev[modPath] = require.cache[modPath];
    require.cache[modPath] = { id: modPath, filename: modPath, loaded: true, exports };
  }
  const channelModes = options.channelModes || { email: 'auto', whatsapp: 'auto' };
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
          const provider = input.provider || 'microsoft_graph';
          conv.needs_human = applyProducerNeedsHuman(conv.needs_human, input, provider);
          ownerHarness.store.row = { ...ownerHarness.store.row, needs_human: conv.needs_human };
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
      afterSameDeskEmailAutoSend: async (input) => {
        sameDeskCalls.push(input);
        if (typeof options.sameDeskImpl === 'function') return options.sameDeskImpl(input);
        return sameDeskHandle(ownerHarness.owner, input);
      },
      shouldSuppressInboundNeedsHuman: async (input) => realAuto.shouldSuppressInboundNeedsHuman(input),
    });
    delete require.cache[COMP_ABS];
    const comp = require(COMP_REL.replace('scripts/', './'));
    const APP_ID = '12345678-1234-4234-8234-123456789abc';
    const SECRET = 'secret-NEVER_LEAK_AUTO';
    const HOST = 'luna-sunset-staging-kv.vault.azure.net';
    const KEY_ID = `https://${HOST}/keys/luna-email-grant-kek/fde9704bd37b45fabe1f12a6a615b032`;
    const runtime = comp.createSunsetStagingMicrosoftDelegatedInboundEventStoreRuntime({
      env: {
        LUNA_DEPLOYMENT: 'sunset-staging',
        LUNA_EMAIL_DURABLE_INBOUND_CAPTURE_ENABLED: 'true',
        LUNA_EMAIL_OAUTH_CLIENT_ID: APP_ID,
        LUNA_EMAIL_OAUTH_CLIENT_SECRET: SECRET,
        EMAIL_GRANT_ENVELOPE_AZURE_KV_COMPOSITION_ENABLED: 'true',
        EMAIL_GRANT_ENVELOPE_AZURE_KV_TRUSTED_HOST: HOST,
        EMAIL_GRANT_ENVELOPE_AZURE_KV_VERSIONED_KEY_ID: KEY_ID,
        ...(options.envPatch || {}),
      },
      pgClient: { async query() { return { rows: [] }; } },
      withTransactionClient: async (work) => work({
        async query(sql) {
          const n = String(sql).replace(/\s+/g, ' ').trim();
          if (/inbox_channel_modes/.test(n)) {
            return { rows: [{ inbox_channel_modes: { ...channelModes } }] };
          }
          return { rows: [] };
        },
      }),
      https: { request() {} },
      timers: { setTimeout() {}, clearTimeout() {} },
    });
    const result = await runtime.runInboundEventStore(authority());
    return { result, autoCalls, sameDeskCalls, projectionInputs, conv, ownerHarness };
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

async function runSameDesk(options, envPatch, extra) {
  const h = makeOwner(options);
  const result = await sameDeskHandle(h.owner, {
    env: sameDeskEnv(envPatch),
    authority: authority(),
    envelope: envelope(extra && extra.envelope),
    projection: projection(extra && extra.projection),
  });
  return { ...h, result };
}

function providerSends(h) {
  return h.providerCalls.filter((c) => !c.recover).length;
}

async function main() {
  console.log('verify:luna-same-desk-email-auto-send\n');

  const autoMod = require('./lib/email-luna-microsoft-auto-create-send');
  const autoSrc = fs.readFileSync(AUTO_ABS, 'utf8');
  const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
  const deltaSrc = fs.readFileSync(DELTA_ABS, 'utf8');
  const waSrc = fs.readFileSync(WA_ROUTE_ABS, 'utf8');
  const inboxSrc = fs.readFileSync(INBOX_ROUTES_ABS, 'utf8');
  const openSrc = fs.readFileSync(OPEN_ABS, 'utf8');
  const bookingSrc = fs.readFileSync(BOOKING_ABS, 'utf8');

  console.log('[0] Seam + WhatsApp isolation pins');
  check(
    'inbound Microsoft composition still owns the projected-inbound seam',
    /afterMicrosoftInboundProjected/.test(compSrc)
      && /projectInboundEvent/.test(compSrc)
      && !/app\.(get|post|put)\(/.test(autoSrc),
  );
  check(
    'delta worker also hooks the same inbound seam',
    /afterMicrosoftInboundProjected/.test(deltaSrc) && /projectInboundEvent/.test(deltaSrc),
  );
  check(
    'SAME-DESK-004 does not invent a browser/UI send path',
    !/handleCreateDraftClick|approveSendClick|inbox-thread/.test(autoSrc),
  );
  check(
    'MAIL-MVP-003 emergency AND still requires both literal true flags',
    isEmailMicrosoftAutoSendEmergencyEnabled({
      LUNA_AUTO_SEND_ENABLED: 'true',
      LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
    }) === true
      && isEmailMicrosoftAutoSendEmergencyEnabled({
        LUNA_AUTO_SEND_ENABLED: 'true',
      }) === false
      && ENV_LUNA_AUTO_SEND_ENABLED === 'LUNA_AUTO_SEND_ENABLED'
      && ENV_LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED === 'LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED',
  );
  check(
    'MAIL-MVP-003 owner stays blocked without the email emergency flag',
    (await (async () => {
      const h = makeOwner({});
      return h.owner.handleProjectedInbound({
        env: sameDeskEnv(),
        authority: authority(),
        envelope: envelope(),
        projection: projection(),
      });
    })()).reason === 'emergency_flags_off',
  );

  const waAuto = evaluateGuestReplySendRoute({
    client_slug: 'sunset',
    to: '+34600000404',
    suggested_reply: 'Which dates were you thinking of?',
    send_kind: 'ask_missing_field',
    idempotency_key: 'same-desk-004:wa-auto',
    send_eligibility: { requires_staff: false, send_allowed_later: true, auto_send_ready: true },
  }, { LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'false' });
  check(
    'WhatsApp auto path still evaluates (not email-blocked)',
    waAuto.ok === true || waAuto.result.error !== 'email_channel_send_not_supported',
    JSON.stringify(waAuto.result && waAuto.result.error),
  );
  const waEmail = evaluateGuestReplySendRoute({
    client_slug: 'sunset',
    to: 'emailv1:9f2c',
    suggested_reply: 'hello',
    send_kind: 'ask_missing_field',
    idempotency_key: 'same-desk-004:wa-email',
  }, { LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'false' });
  check(
    'WhatsApp send route still refuses email identities',
    waEmail.status === 400 && waEmail.result.error === 'email_channel_send_not_supported',
  );
  check(
    'WhatsApp route still gates auto-send on literal LUNA_AUTO_SEND_ENABLED',
    /sendKind !== 'staff_reply' && !isTruthyEnv\(env, 'LUNA_AUTO_SEND_ENABLED'\)/.test(waSrc)
      && /email_channel_send_not_supported/.test(waSrc)
      && fs.readFileSync(WA_ELIG_ABS, 'utf8').includes('isWhatsappDryRun'),
  );
  check(
    'Approve & send + generate-on-open owners still exist for the draft path',
    /approveAndDispatchEmailOutbound/.test(inboxSrc)
      && /handleApproveSend/.test(inboxSrc)
      && /regenerateEmailLunaDraftOnStaffClick/.test(openSrc)
      && /needs_human !== true/.test(openSrc),
  );
  check(
    'SAME-DESK-003 booking owner still does not send',
    !/handleApproveSend|appendOutboundJournal|sendMail/.test(bookingSrc)
      && bookingSrc.includes("NOW() + INTERVAL '24 hours'"),
  );

  console.log('\n[1] Luna On + needs_human false + Global Pause off => exactly one provider send');
  {
    const hit = await runSameDesk({});
    check(
      'case 1: status sent',
      hit.result.status === 'sent' && hit.result.sent === true,
      JSON.stringify({ status: hit.result.status, reason: hit.result.reason, sent: hit.result.sent }),
    );
    check(
      'case 1: exactly one Create Draft author call with empty operator context',
      hit.drafts.length === 1 && hit.drafts[0].operator_context === '',
      `drafts=${hit.drafts.length}`,
    );
    check(
      'case 1: exactly one approval + journal + provider send',
      hit.approvals.length === 1
        && hit.journals.length === 1
        && providerSends(hit) === 1
        && hit.result.provider_sends === 1
        && hit.result.approvals === 1
        && hit.result.journals === 1,
      JSON.stringify({
        approvals: hit.approvals.length,
        journals: hit.journals.length,
        provider: providerSends(hit),
        result: {
          approvals: hit.result.approvals,
          journals: hit.result.journals,
          provider_sends: hit.result.provider_sends,
        },
      }),
    );
    check(
      'case 1: durable sent/thread state (approved + journaled + needs_human false)',
      hit.store.approval
        && hit.store.approval.state === 'approved'
        && hit.store.journaledOps.has(APPROVAL_ID)
        && hit.store.row.needs_human === false
        && hit.store.row.conversation_status === 'open',
      JSON.stringify({
        state: hit.store.approval && hit.store.approval.state,
        needs_human: hit.store.row.needs_human,
      }),
    );
    check(
      'case 1: does not require LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED',
      isEmailMicrosoftAutoSendEmergencyEnabled(sameDeskEnv()) === false,
    );
    check(
      'case 1: still uses Create Draft + Approve & send owners (no Graph shortcut)',
      hit.approvals[0]
        && hit.approvals[0].expected_authority
        && hit.approvals[0].expected_authority.provider === 'microsoft_graph'
        && hit.approvals[0].expected_authority.source_inbound_event_id === M
        && !/sendMail|createReply/.test(JSON.stringify(hit.approvals[0])),
    );
  }

  console.log('\n[2] needs_human true => zero provider send; draft remains approvable');
  {
    const blocked = await runSameDesk({ row: contextRow({ needs_human: true }) });
    check(
      'case 2: auto-send blocked as needs_human',
      blocked.result.status === 'blocked'
        && blocked.result.reason === 'needs_human'
        && blocked.result.sent === false,
      JSON.stringify({ status: blocked.result.status, reason: blocked.result.reason }),
    );
    check(
      'case 2: zero provider send, zero auto approval, zero auto journal',
      providerSends(blocked) === 0
        && blocked.approvals.length === 0
        && blocked.journals.length === 0
        && blocked.drafts.length === 0,
      JSON.stringify({
        provider: providerSends(blocked),
        approvals: blocked.approvals.length,
        drafts: blocked.drafts.length,
      }),
    );

    const draftH = makeOwner({
      row: contextRow({ needs_human: true }),
      approval: {
        approval_id: APPROVAL_ID,
        operation_id: '88888888-8888-4888-8888-888888888888',
        message_text: BODY,
        state: 'draft',
        subject: 'Re: Boards',
        source_inbound_event_id: M,
      },
    });
    const autoOut = await sameDeskHandle(draftH.owner, {
      env: sameDeskEnv(),
      authority: authority(),
      envelope: envelope(),
      projection: projection(),
    });
    check(
      'case 2: standing draft is not auto-dispatched',
      autoOut.status === 'blocked'
        && autoOut.reason === 'needs_human'
        && providerSends(draftH) === 0
        && draftH.store.approval.state === 'draft',
      JSON.stringify({ status: autoOut.status, reason: autoOut.reason, state: draftH.store.approval.state }),
    );
    const staff = await draftH.owner.handleProjectedInbound({
      env: sameDeskEnv({
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      }),
      authority: authority(),
      envelope: envelope(),
      projection: projection(),
    });
    check(
      'case 2: MAIL-MVP-003 emergency path also refuses needs_human (Approve & send stays staff)',
      staff.status === 'blocked' && staff.reason === 'needs_human' && providerSends(draftH) === 0,
      JSON.stringify({ status: staff.status, reason: staff.reason }),
    );
    check(
      'case 2: staff Approve & send owner remains the dispatch seam',
      /SQL_APPROVE/.test(inboxSrc)
        && /dispatchApprovedOutbound/.test(inboxSrc)
        && /handleApproveSend/.test(inboxSrc),
    );
  }

  console.log('\n[3] Luna Off => zero provider send / draft only');
  {
    const off = await runSameDesk({
      pause: { lookup_error: false, global_paused: false, conversation_paused: true },
    });
    check(
      'case 3: Luna Off blocks auto-send',
      off.result.status === 'blocked'
        && off.result.reason === 'luna_off'
        && off.result.sent === false,
      JSON.stringify({ status: off.result.status, reason: off.result.reason }),
    );
    check(
      'case 3: zero provider send and no auto draft/approval',
      providerSends(off) === 0 && off.drafts.length === 0 && off.approvals.length === 0,
    );
  }

  console.log('\n[4] Global Pause on => zero provider send / draft only');
  {
    const paused = await runSameDesk({
      pause: { lookup_error: false, global_paused: true, conversation_paused: false },
    });
    check(
      'case 4: Global Pause blocks auto-send',
      paused.result.status === 'blocked'
        && paused.result.reason === 'global_paused'
        && paused.result.sent === false,
      JSON.stringify({ status: paused.result.status, reason: paused.result.reason }),
    );
    check(
      'case 4: zero provider send and no auto draft/approval',
      providerSends(paused) === 0 && paused.drafts.length === 0 && paused.approvals.length === 0,
    );
    const lookupFail = await runSameDesk({
      pause: { lookup_error: true, global_paused: true, conversation_paused: true },
    });
    check(
      'pause lookup failure stays fail-closed (no send)',
      lookupFail.result.status === 'blocked'
        && lookupFail.result.reason === 'pause_fail_closed'
        && providerSends(lookupFail) === 0,
      JSON.stringify({ status: lookupFail.result.status, reason: lookupFail.result.reason }),
    );
  }

  console.log('\n[5] Replay / idempotency');
  {
    const first = await runSameDesk({});
    const dup = await runSameDesk({
      approval: {
        approval_id: first.result.approval_id || APPROVAL_ID,
        operation_id: '88888888-8888-4888-8888-888888888888',
        message_text: BODY,
        state: 'approved',
        subject: 'Re: Boards',
        source_inbound_event_id: M,
      },
      journaledOps: [first.result.approval_id || APPROVAL_ID],
    });
    check(
      'replay of the same inbound: skipped already_sent, no second approval/journal',
      dup.result.status === 'skipped'
        && dup.result.reason === 'already_sent'
        && dup.drafts.length === 0
        && dup.approvals.length === 0
        && providerSends(dup) === 0,
      JSON.stringify({
        status: dup.result.status,
        reason: dup.result.reason,
        drafts: dup.drafts.length,
        approvals: dup.approvals.length,
        provider: providerSends(dup),
        recover: dup.providerCalls.length,
      }),
    );
    check(
      'authenticity of concurrency is the stock-PG prove, not an in-process adapter',
      fs.existsSync(STOCK_PG_PROVE)
        && /embedded-postgres/.test(fs.readFileSync(STOCK_PG_PROVE, 'utf8'))
        && /lock_timeout/.test(fs.readFileSync(STOCK_PG_PROVE, 'utf8')),
    );
  }

  console.log('\n[6] HIGH 1 — authoritative needs_human at the real composition seam');
  {
    const suppressSameDesk = await shouldSuppressInboundNeedsHuman({
      env: sameDeskEnv(),
      clientId: C,
      sameDesk: true,
      getEmailChannelMode: async () => 'auto',
    });
    check(
      '004 sameDesk flag does not suppress/manufacture needs_human',
      suppressSameDesk === false,
      `suppress=${suppressSameDesk}`,
    );
    const suppressEmergency = await shouldSuppressInboundNeedsHuman({
      env: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      clientId: C,
      getEmailChannelMode: async () => 'auto',
    });
    check(
      'MAIL-MVP-003 emergency still suppresses when channel auto (legacy contract)',
      suppressEmergency === true,
      `suppress=${suppressEmergency}`,
    );

    const switchOn = await runInboundComposition({
      envPatch: { LUNA_AUTO_SEND_ENABLED: 'true' },
      channelModes: { email: 'auto', whatsapp: 'auto' },
    });
    check(
      '004 switch on: composition does not pass setNeedsHuman',
      switchOn.projectionInputs.length >= 1
        && switchOn.projectionInputs.every((p) => !Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman')),
      JSON.stringify(switchOn.projectionInputs.map((p) => ({ has: Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman'), v: p.setNeedsHuman }))),
    );
    check(
      '004 switch on: inbound producer needs_human=true remains true and does not send',
      switchOn.conv.needs_human === true
        && switchOn.sameDeskCalls.length === 1
        && providerSends(switchOn.ownerHarness) === 0
        && switchOn.ownerHarness.store.row.needs_human === true,
      JSON.stringify({
        needs_human: switchOn.conv.needs_human,
        sameDeskCalls: switchOn.sameDeskCalls.length,
        sends: providerSends(switchOn.ownerHarness),
        row: switchOn.ownerHarness.store.row.needs_human,
      }),
    );

    const seededTrue = await runInboundComposition({
      envPatch: { LUNA_AUTO_SEND_ENABLED: 'true' },
      seedNeedsHuman: true,
      channelModes: { email: 'auto', whatsapp: 'auto' },
    });
    check(
      'authoritative existing needs_human=true remains true under 004 switch on',
      seededTrue.conv.needs_human === true
        && providerSends(seededTrue.ownerHarness) === 0
        && seededTrue.projectionInputs.every((p) => !Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman')),
      JSON.stringify({ needs_human: seededTrue.conv.needs_human, sends: providerSends(seededTrue.ownerHarness) }),
    );

    const lunaOff = await runInboundComposition({
      envPatch: { LUNA_AUTO_SEND_ENABLED: 'true' },
      seedNeedsHuman: true,
      pause: { lookup_error: false, global_paused: false, conversation_paused: true },
      channelModes: { email: 'auto', whatsapp: 'auto' },
    });
    check(
      'Luna Off does not mutate needs_human and does not send',
      lunaOff.conv.needs_human === true
        && lunaOff.ownerHarness.store.row.needs_human === true
        && providerSends(lunaOff.ownerHarness) === 0
        && lunaOff.projectionInputs.every((p) => !Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman')),
      JSON.stringify({
        needs_human: lunaOff.conv.needs_human,
        sends: providerSends(lunaOff.ownerHarness),
        projection: lunaOff.projectionInputs[0] && lunaOff.projectionInputs[0].setNeedsHuman,
      }),
    );

    const paused = await runInboundComposition({
      envPatch: { LUNA_AUTO_SEND_ENABLED: 'true' },
      seedNeedsHuman: true,
      pause: { lookup_error: false, global_paused: true, conversation_paused: false },
      channelModes: { email: 'auto', whatsapp: 'auto' },
    });
    check(
      'Global Pause does not mutate needs_human and does not send',
      paused.conv.needs_human === true
        && paused.ownerHarness.store.row.needs_human === true
        && providerSends(paused.ownerHarness) === 0
        && paused.projectionInputs.every((p) => !Object.prototype.hasOwnProperty.call(p, 'setNeedsHuman')),
      JSON.stringify({
        needs_human: paused.conv.needs_human,
        sends: providerSends(paused.ownerHarness),
      }),
    );

    const emergency = await runInboundComposition({
      envPatch: {
        LUNA_AUTO_SEND_ENABLED: 'true',
        LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
      },
      channelModes: { email: 'auto', whatsapp: 'auto' },
      autoImpl: async () => ({ status: 'sent', sent: true }),
    });
    check(
      'MAIL-MVP-003 emergency composition still projects setNeedsHuman=false when channel auto',
      emergency.projectionInputs.length >= 1
        && emergency.projectionInputs.every((p) => p.setNeedsHuman === false),
      JSON.stringify(emergency.projectionInputs.map((p) => p.setNeedsHuman)),
    );

    check(
      'event-store composition only suppresses needs_human on MAIL-MVP-003 emergency, not 004',
      /if \(autoFlagsOn \|\| sameDeskOn\)/.test(compSrc) === false
        && /sameDesk: sameDeskOn/.test(compSrc) === false
        && /if \(autoFlagsOn\)/.test(compSrc),
    );
    check(
      'delta composition only suppresses needs_human on MAIL-MVP-003 emergency, not 004',
      /if \(autoFlagsOn \|\| sameDeskOn\)/.test(deltaSrc) === false
        && /sameDesk: sameDeskOn/.test(deltaSrc) === false,
    );
  }

  console.log('\n[7] HIGH 1 — generic staff/SMTP drafts restored; dedicated auto-send claim');
  {
    const msInsert = sqlConst(inboxSrc, 'SQL_INSERT_DRAFT');
    const smtpInsert = sqlConst(inboxSrc, 'SQL_INSERT_DRAFT_SMTP');
    const persistFn = inboxSrc.match(/async function persistNewDraftThroughStaffOwner[\s\S]*?async function persistUpdatedDraftThroughStaffOwner/)?.[0] || '';
    check(
      'generic Microsoft staff draft insert has no inbound ON CONFLICT',
      /INSERT INTO tenant_email_reply_approvals/.test(msInsert)
        && !/ON CONFLICT/.test(msInsert)
        && /RETURNING approval_id/.test(msInsert),
    );
    check(
      'SMTP staff draft insert is unchanged (no inbound ON CONFLICT)',
      /INSERT INTO tenant_email_reply_approvals/.test(smtpInsert)
        && /'imap_smtp'/.test(smtpInsert)
        && !/ON CONFLICT/.test(smtpInsert)
        && /RETURNING approval_id/.test(smtpInsert),
    );
    check(
      'generic staff draft owner does not return draft_identity_claimed',
      /draft_insert_failed/.test(persistFn)
        && !/draft_identity_claimed/.test(persistFn)
        && !/23505/.test(persistFn),
    );
    check(
      'dedicated SAME-DESK-004 claim owner/table exists and is auto-only',
      fs.existsSync(MIG_100_UP)
        && fs.existsSync(MIG_100_DOWN)
        && fs.existsSync(CLAIM_OWNER_ABS)
        && fs.readFileSync(MIG_100_UP, 'utf8').includes(`CREATE TABLE ${CLAIM_TABLE}`)
        && fs.readFileSync(MIG_100_UP, 'utf8').includes(CLAIM_IDENTITY_UQ)
        && !/CREATE UNIQUE INDEX[\s\S]{0,160}?ON tenant_email_reply_approvals/.test(fs.readFileSync(MIG_100_UP, 'utf8'))
        && /tenant_email_same_desk_auto_send_claims/.test(fs.readFileSync(CLAIM_OWNER_ABS, 'utf8')),
    );
    check(
      'auto-send skips on dedicated claim loss, not generic draft_identity_claimed',
      /already_claimed/.test(autoSrc)
        && /claimSameDesk/.test(autoSrc)
        && !/draft_identity_claimed/.test(autoSrc)
        && !/draft_identity_claimed/.test(inboxSrc),
    );
    {
      const lost = await runSameDesk({ claimLost: true });
      check(
        'SAME-DESK auto skips when the dedicated claim is already owned (provider-inert)',
        lost.result.status === 'skipped'
          && lost.result.reason === 'already_claimed'
          && providerSends(lost) === 0
          && lost.approvals.length === 0
          && lost.drafts.length === 0,
        JSON.stringify({
          status: lost.result.status,
          reason: lost.result.reason,
          sends: providerSends(lost),
        }),
      );
    }

    const PGlite = tryLoadPglite();
    if (!PGlite) {
      check('PGlite available for dedicated-claim migration proof', false, 'PGlite unavailable');
    } else if (!fs.existsSync(MIG_100_UP) || !fs.existsSync(MIG_100_DOWN)) {
      check('PGlite dedicated-claim migration proof', false, 'migration 100 missing');
    } else {
      const db = new PGlite();
      try {
        await db.exec(`
          CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
          BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
          CREATE TABLE clients (id UUID PRIMARY KEY, slug TEXT);
          CREATE TABLE staff_users (id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), email TEXT, role TEXT, status TEXT, UNIQUE (client_id, id));
          CREATE TABLE conversations (id UUID PRIMARY KEY, client_id UUID NOT NULL, phone TEXT, UNIQUE (client_id, id));
          CREATE TABLE tenant_locations (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
          CREATE TABLE tenant_channel_endpoints (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
          CREATE TABLE tenant_email_inbound_events (id UUID PRIMARY KEY, client_id UUID NOT NULL, UNIQUE (client_id, id));
        `);
        await db.exec(fs.readFileSync(path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql'), 'utf8'));
        await db.exec(fs.readFileSync(MIG_100_UP, 'utf8'));
        const table = await db.query(
          `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = $1`,
          [CLAIM_TABLE],
        );
        const approvalsUq = await db.query(
          `SELECT indexname FROM pg_indexes WHERE tablename = 'tenant_email_reply_approvals' AND indexdef ILIKE '%source_inbound_event_id%' AND indexdef ILIKE '%UNIQUE%'`,
        );
        check('PGlite: dedicated claim table exists after 100', table.rows.length === 1);
        check(
          'PGlite: tenant_email_reply_approvals is not globally unique on inbound identity',
          approvalsUq.rows.length === 0,
          JSON.stringify(approvalsUq.rows),
        );

        await db.query('INSERT INTO clients (id, slug) VALUES ($1,$2)', [C, 'sunset']);
        await db.query('INSERT INTO staff_users (id, client_id, email, role, status) VALUES ($1,$2,$3,$4,$5)', [A, C, 'op@t', 'operator', 'active']);
        await db.query('INSERT INTO conversations (id, client_id, phone) VALUES ($1,$2,$3)', [V, C, 'emailv1:x']);
        await db.query('INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)', [L, C, 'sunset-somo']);
        await db.query('INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ($1,$2,$3)', [E, C, 'sunset-somo']);
        await db.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [M, C]);

        const digest = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
        const insApproval = `
          INSERT INTO tenant_email_reply_approvals (
            approval_id, operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
            source_inbound_event_id, provider, provider_mailbox_id, provider_source_message_id,
            draft_actor_staff_user_id, message_text, body_digest, state
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
          RETURNING approval_id::text AS approval_id
        `;
        const r1 = await db.query(insApproval, [crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, 'microsoft_graph', MAILBOX, SRC, A, BODY, digest]);
        const r2 = await db.query(insApproval, [crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, 'microsoft_graph', MAILBOX, SRC, A, BODY, digest]);
        await db.exec(`
          ALTER TABLE tenant_email_reply_approvals DROP CONSTRAINT tenant_email_reply_approvals_provider_values;
          ALTER TABLE tenant_email_reply_approvals ADD CONSTRAINT tenant_email_reply_approvals_provider_values
            CHECK (provider IN ('microsoft_graph', 'imap_smtp'));
        `);
        const s1 = await db.query(insApproval, [crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, 'imap_smtp', MAILBOX, SRC, A, BODY, digest]);
        const s2 = await db.query(insApproval, [crypto.randomUUID(), crypto.randomUUID(), C, L, 'sunset-somo', E, V, M, 'imap_smtp', MAILBOX, SRC, A, BODY, digest]);
        const approvalCount = await db.query(
          'SELECT count(*)::int AS n FROM tenant_email_reply_approvals WHERE client_id=$1 AND conversation_id=$2 AND source_inbound_event_id=$3',
          [C, V, M],
        );
        check(
          'PGlite: two generic Microsoft staff drafts plus two SMTP drafts remain allowed for the same inbound',
          r1.rows.length === 1 && r2.rows.length === 1 && s1.rows.length === 1 && s2.rows.length === 1
            && approvalCount.rows[0].n === 4,
          JSON.stringify({
            r1: r1.rows.length, r2: r2.rows.length, s1: s1.rows.length, s2: s2.rows.length, n: approvalCount.rows[0].n,
          }),
        );

        const insClaim = `
          INSERT INTO ${CLAIM_TABLE} (
            claim_id, client_id, conversation_id, source_inbound_event_id, claimant_staff_user_id, state
          ) VALUES ($1,$2,$3,$4,$5,'claimed')
          ON CONFLICT (client_id, conversation_id, source_inbound_event_id) DO NOTHING
          RETURNING claim_id::text AS claim_id
        `;
        const c1 = await db.query(insClaim, [crypto.randomUUID(), C, V, M, A]);
        const c2 = await db.query(insClaim, [crypto.randomUUID(), C, V, M, A]);
        const claimCount = await db.query(
          `SELECT count(*)::int AS n FROM ${CLAIM_TABLE} WHERE client_id=$1 AND conversation_id=$2 AND source_inbound_event_id=$3`,
          [C, V, M],
        );
        check(
          'PGlite: SAME-DESK auto claim allows exactly one durable winner for the inbound',
          c1.rows.length === 1 && c2.rows.length === 0 && claimCount.rows[0].n === 1,
          JSON.stringify({ c1: c1.rows.length, c2: c2.rows.length, n: claimCount.rows[0].n }),
        );

        try {
          await db.exec(fs.readFileSync(MIG_100_DOWN, 'utf8'));
          check('PGlite: nonempty 100 down refuses evidence loss', false, 'down succeeded with rows');
        } catch (downErr) {
          check(
            'PGlite: nonempty 100 down refuses evidence loss',
            /100_down_refused/.test(String(downErr && downErr.message || downErr)),
            String(downErr && downErr.message || downErr),
          );
          try { await db.exec('ROLLBACK'); } catch { /* */ }
        }
        await db.query(`DELETE FROM ${CLAIM_TABLE}`);
        await db.exec(fs.readFileSync(MIG_100_DOWN, 'utf8'));
        const gone = await db.query(
          `SELECT 1 AS ok FROM information_schema.tables WHERE table_name = $1`,
          [CLAIM_TABLE],
        );
        check('PGlite: empty 100 down drops dedicated claim table', gone.rows.length === 0);
      } catch (err) {
        check('PGlite dedicated-claim migration proof', false, String(err && err.message || err));
      } finally {
        try { await db.close(); } catch { /* */ }
      }
    }
  }

  console.log('\n[7b] HIGH 2 — authentic stock-PG two-connection claim contention (run twice)');
  {
    check(
      'stock-PG prove script is present (skip cannot count as PASS)',
      fs.existsSync(STOCK_PG_PROVE),
    );
    const src = fs.existsSync(STOCK_PG_PROVE) ? fs.readFileSync(STOCK_PG_PROVE, 'utf8') : '';
    check(
      'stock-PG prove uses two independent connections/transactions and lock timeouts',
      /new Client\(/.test(src)
        && /lock_timeout/.test(src)
        && /pg_backend_pid|pg_stat_activity/.test(src)
        && /embedded-postgres/.test(src)
        && !/require\(['"]@electric-sql\/pglite['"]\)/.test(src),
    );
    const first = runStockPgProof('stock-PG two-connection contention run 1');
    const second = runStockPgProof('stock-PG two-connection contention run 2');
    check('stock-PG contention proof ran successfully twice', first === true && second === true);
  }

  console.log('\n[8] Inbound composition wiring + isolation');
  check(
    'inbound composition invokes SAME-DESK-004 after projection when WhatsApp-like auto is on',
    /afterSameDeskEmailAutoSend/.test(compSrc) && /afterSameDeskEmailAutoSend/.test(deltaSrc),
  );
  check(
    'SAME-DESK-004 auto is Staff-API owned (not Hermes WhatsApp adapter)',
    /handleSameDeskProjectedInbound/.test(autoSrc)
      && !/WhatsAppCloudAdapter|_patched_whatsapp_cloud_send/.test(autoSrc),
  );
  const pkgScripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  check(
    'package.json exposes verify:luna-same-desk-email-auto-send',
    pkgScripts['verify:luna-same-desk-email-auto-send']
      === 'node scripts/verify-luna-same-desk-email-auto-send.js',
  );
  check(
    'package.json exposes prove:luna-same-desk-auto-send-claim-stock-pg',
    pkgScripts['prove:luna-same-desk-auto-send-claim-stock-pg']
      === 'node scripts/prove-luna-same-desk-auto-send-claim-stock-pg.js',
  );
  const probeOwner = createEmailLunaMicrosoftAutoCreateAndSend({
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    regenerateEmailLunaDraftOnStaffClick: async () => ({}),
    saveDraftThroughStaffOwner: async () => ({}),
    approveAndDispatchEmailOutbound: async () => ({}),
  });
  check(
    'owner exports handleSameDeskProjectedInbound',
    typeof probeOwner.handleSameDeskProjectedInbound === 'function'
      || typeof autoMod.afterSameDeskEmailAutoSend === 'function',
  );

  console.log(`\n── verify:luna-same-desk-email-auto-send ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
