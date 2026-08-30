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

const ROOT = path.join(__dirname, '..');
const AUTO_REL = 'scripts/lib/email-luna-microsoft-auto-create-send.js';
const AUTO_ABS = path.join(ROOT, AUTO_REL);
const COMP_ABS = path.join(ROOT, 'scripts/lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js');
const DELTA_ABS = path.join(ROOT, 'scripts/lib/email-delta-sunset-staging-runtime-composition.js');
const WA_ROUTE_ABS = path.join(ROOT, 'scripts/lib/luna-guest-reply-send-route.js');
const WA_ELIG_ABS = path.join(ROOT, 'scripts/lib/luna-guest-reply-send-eligibility.js');
const INBOX_ROUTES_ABS = path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js');
const OPEN_ABS = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js');
const BOOKING_ABS = path.join(ROOT, 'scripts/lib/email-luna-booking-from-email.js');

const {
  createEmailLunaMicrosoftAutoCreateAndSend,
  isEmailMicrosoftAutoSendEmergencyEnabled,
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
  let inFlight = false;
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
      if (inFlight) return { status: 'conflict', draft_text: '', reason: 'in_progress' };
      inFlight = true;
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
    const h = makeOwner({});
    const a = sameDeskHandle(h.owner, {
      env: sameDeskEnv(), authority: authority(), envelope: envelope(), projection: projection(),
    });
    const b = sameDeskHandle(h.owner, {
      env: sameDeskEnv(),
      authority: authority(),
      envelope: envelope(),
      projection: projection({ status: 'already_projected' }),
    });
    const [ra, rb] = await Promise.all([a, b]);
    const sends = providerSends(h);
    check(
      'concurrent duplicate inbound: at most one provider send',
      sends === 1
        && ((ra.status === 'sent' && rb.status !== 'sent')
          || (rb.status === 'sent' && ra.status !== 'sent')
          || (ra.status === 'sent' && rb.status === 'skipped')
          || (rb.status === 'sent' && ra.status === 'skipped')
          || (ra.status === 'sent' && rb.status === 'sent' && h.providerCalls.length === 1)),
      JSON.stringify({ sends, a: ra.status, b: rb.status }),
    );
  }

  console.log('\n[6] Inbound composition wiring + isolation');
  check(
    'inbound composition invokes SAME-DESK-004 after projection when WhatsApp-like auto is on',
    /afterSameDeskEmailAutoSend/.test(compSrc) && /afterSameDeskEmailAutoSend/.test(deltaSrc),
  );
  check(
    'SAME-DESK-004 auto is Staff-API owned (not Hermes WhatsApp adapter)',
    /handleSameDeskProjectedInbound/.test(autoSrc)
      && !/WhatsAppCloudAdapter|_patched_whatsapp_cloud_send/.test(autoSrc),
  );
  check(
    'package.json exposes verify:luna-same-desk-email-auto-send',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      .scripts['verify:luna-same-desk-email-auto-send']
      === 'node scripts/verify-luna-same-desk-email-auto-send.js',
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
