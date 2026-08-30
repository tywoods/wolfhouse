'use strict';

/**
 * SAME-DESK-003 — email pay-to-book uses the same Staff-API-grounded booking
 * path as WhatsApp, shaped as one email (authoritative quote block + exact
 * Staff payment URL + 24h hold expiry). WhatsApp stays short/conversational.
 *
 * Draft-only. Approve & send remains required. Auto-send stays off.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  renderEmailPayToBookDraft,
  placeEmailPayToBookHoldAndPaymentLink,
  tryEmailPayToBookForCreateDraft,
  extractEmailPayToBookIntent,
  bindEmailPayToBookIdentities,
  decideStripeHoldPromote,
} = require('./lib/email-luna-booking-from-email');
const {
  PRESENTATION_CHANNELS,
  presentGroundedReply,
  emailDraftingAllowed,
} = require('./lib/luna-channel-presentation');
const {
  expireOneBookingHoldTx,
  isHoldDueForExpiry,
} = require('./lib/booking-hold-expiry');
const ownerMod = require('./lib/staff-email-luna-draft-open');
const { createStaffEmailLunaDraftOpen } = ownerMod;
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { runSunsetGuestSchoolTurnDryRun } = require('./lib/luna-guest-sunset-school-turn');

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

const URL = 'https://checkout.stripe.com/c/pay/cs_test_same_desk_003';
const OTHER_URL = 'https://evil.example/pay';
const EXPIRY = '2026-08-29T12:00:00.000Z';
const OFFERING = 'surf_pack_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb__1_week';
const BOOKING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  location_key: 'sunset-somo',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const STAFF_ID = '66666666-6666-4666-8666-666666666666';
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_ID = 'opaque/id+with=padding';

function frozen(value) {
  return Object.freeze(value);
}

function authority(patch) {
  return frozen(Object.assign({
    client_id: IDS.client_id,
    client_slug: 'sunset',
    location_id: IDS.location_id,
    location_key: 'sunset-somo',
    conversation_id: IDS.conversation_id,
    inbound_message_id: IDS.inbound_message_id,
    endpoint_id: IDS.endpoint_id,
    provider_mailbox_id: MAILBOX,
    endpoint_provider_mailbox_id: MAILBOX,
  }, patch || {}));
}

function untrusted(patch) {
  return frozen(Object.assign({
    subject: 'Booking 2026-09-12 to 2026-09-19',
    body_text: 'Hi, I would like to book the Weekend Course week of 2026-09-12 to 2026-09-19 and pay the deposit.',
    quoted_history: '',
    from_display_name: 'Ada Guest',
    from_address: 'ada@example.com',
  }, patch || {}));
}

function fakeOwners(patch) {
  return {
    async resolveOffering() {
      return {
        ok: true,
        offering_id: OFFERING,
        offering_type: 'course',
        course_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        tier_key: '1_week',
        label: 'Weekend Course',
      };
    },
    async quote() {
      return {
        ok: true,
        body: {
          total_cents: 19900,
          deposit_required_cents: 5000,
          currency: 'EUR',
          label: 'Weekend Course',
        },
      };
    },
    async createHold(_pg, command) {
      return {
        ok: true,
        body: {
          booking_id: BOOKING_ID,
          booking_code: 'SUNSET-008',
          hold_expires_at: EXPIRY,
          total_cents: 19900,
          status: 'hold',
          payment_status: 'unpaid',
          payment_status_from_command: command && command.transportBody
            && command.transportBody.payment_status,
        },
      };
    },
    async createPaymentLink() {
      return {
        ok: true,
        body: {
          checkout_url: URL,
          payment_link_url: URL,
          payment_id: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp',
        },
      };
    },
    stripeExecOpts() {
      return {
        secretKey: 'sk_test_003',
        successUrl: 'https://example.test/s',
        cancelUrl: 'https://example.test/c',
      };
    },
    ...patch,
  };
}

function payInput(patch) {
  return {
    authority: authority(),
    untrusted: untrusted(),
    operator_context: 'Send them the deposit link for Weekend Course.',
    trustedClientSlug: 'sunset',
    trustedLocationId: 'sunset-somo',
    trustedMailboxId: MAILBOX,
    trustedConversationId: IDS.conversation_id,
    ...patch,
  };
}

function actor() {
  return Object.freeze(Object.assign(Object.create(null), {
    staff_user_id: STAFF_ID,
    client_id: IDS.client_id,
    role: 'operator',
  }));
}

function gateOn() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: 'https://staff.sunset.test',
  };
}

function openContextRow(patch = {}) {
  return {
    client_id: IDS.client_id,
    client_slug: 'sunset',
    location_id: IDS.location_id,
    location_key: 'sunset-somo',
    endpoint_id: IDS.endpoint_id,
    conversation_id: IDS.conversation_id,
    inbound_message_id: IDS.inbound_message_id,
    channel: 'email',
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_source_message_id: GRAPH_ID,
    endpoint_provider_mailbox_id: MAILBOX,
    event_location_id: IDS.location_id,
    subject: 'Booking 2026-09-12 to 2026-09-19',
    body_text: '',
    quoted_history: '',
    from_display_name: 'Ada Guest',
    from_address: 'ada@example.com',
    conversation_deleted_at: null,
    conversation_status: 'open',
    needs_human: true,
    latest_message_id: IDS.inbound_message_id,
    staff_reply_draft: null,
    conversation_metadata: {},
    luna_draft_enabled: true,
    luna_on: true,
    global_pause: false,
    ...patch,
  };
}

function plan(templateId, tone, questionKey, ack) {
  return JSON.stringify({
    template_id: templateId,
    tone: tone || 'warm',
    question_key: questionKey || 'none',
    acknowledgment_key: ack || 'thanks',
  });
}

function makeDraftOpenHarness(options = {}) {
  const row = options.row || openContextRow();
  const store = {
    draft: row.staff_reply_draft != null ? String(row.staff_reply_draft) : '',
    meta: row.conversation_metadata ? { ...row.conversation_metadata } : {},
    needsHuman: row.needs_human,
    queryTexts: [],
    writes: [],
    claims: 0,
    tryPayCalls: [],
  };
  const owner = createStaffEmailLunaDraftOpen({
    runtimeEnv: gateOn(),
    now: () => Date.now(),
    randomUUID: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    callModel: options.callModel || (() => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks'))),
    createLunaRuntime: options.createLunaRuntime || (() => createEmailLunaDraftAuthor({
      callModel: options.callModel || (() => Promise.resolve(plan('catalog_reply', 'warm', 'ask_dates_and_guest_count', 'thanks'))),
    })),
    fetchCurrentMessageContent: async () => Object.freeze({
      latest_text: options.contentText || untrusted().body_text,
    }),
    tryEmailPayToBookForCreateDraft: options.tryEmailPayToBookForCreateDraft,
    withPgClient: async (fn) => {
      const pg = {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          store.queryTexts.push(text);
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_BEGIN || /^BEGIN\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_COMMIT || /^COMMIT\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK || /^ROLLBACK\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT) {
            const live = { ...row };
            live.staff_reply_draft = store.draft || null;
            live.conversation_metadata = { ...(live.conversation_metadata || {}), ...store.meta };
            live.needs_human = store.needsHuman;
            return { rows: [live] };
          }
          if (text === ownerMod.SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION) {
            if (store.needsHuman !== true) return { rows: [] };
            return {
              rows: [{
                conversation_id: IDS.conversation_id,
                inbound_event_id: IDS.inbound_message_id,
                provider: 'microsoft_graph',
                event_location_id: IDS.location_id,
                location_key: 'sunset-somo',
                provider_mailbox_id: MAILBOX,
                endpoint_provider_mailbox_id: MAILBOX,
              }],
            };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_CREATE_DRAFT) {
            return {
              rows: [{
                conversation_id: IDS.conversation_id,
                inbound_event_id: IDS.inbound_message_id,
                provider: 'microsoft_graph',
                event_location_id: IDS.location_id,
                location_key: 'sunset-somo',
                provider_mailbox_id: MAILBOX,
                endpoint_provider_mailbox_id: MAILBOX,
              }],
            };
          }
          if (text === ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT) {
            store.claims += 1;
            const nextMeta = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
            store.meta = { ...store.meta, ...(nextMeta || {}) };
            return { rows: [{ conversation_id: IDS.conversation_id }] };
          }
          if (text === ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CAS_EMAIL_LUNA_CREATE_DRAFT) {
            store.draft = params[2];
            const nextMeta = typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3];
            store.meta = { ...store.meta, ...(nextMeta || {}) };
            store.writes.push(params[2]);
            return { rows: [{ staff_reply_draft: params[2] }] };
          }
          if (text === ownerMod.SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM) {
            return { rows: [{ conversation_id: IDS.conversation_id }] };
          }
          return { rows: [] };
        },
      };
      return fn(pg);
    },
  });
  return { owner, store };
}

function wiredTryPay(store, owners) {
  return async (input) => {
    if (store) store.tryPayCalls.push(input);
    return placeEmailPayToBookHoldAndPaymentLink({}, input, owners || fakeOwners());
  };
}

function readOwner(rel) {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

function makeExpiryPg(seed) {
  const state = {
    booking: { ...seed.booking },
    beds: Array.isArray(seed.beds) ? seed.beds.slice() : [],
    paidCount: Number(seed.paidCount || 0),
    begun: false,
    committed: false,
    rolledBack: false,
  };
  return {
    state,
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      if (/^BEGIN\b/i.test(text)) {
        state.begun = true;
        return { rows: [] };
      }
      if (/^COMMIT\b/i.test(text)) {
        state.committed = true;
        return { rows: [] };
      }
      if (/^ROLLBACK\b/i.test(text)) {
        state.rolledBack = true;
        return { rows: [] };
      }
      if (/FOR UPDATE/.test(text)) {
        const id = params[0];
        const clientId = params[1];
        if (state.booking
            && state.booking.booking_id === id
            && state.booking.client_id === clientId) {
          return { rows: [state.booking] };
        }
        return { rows: [] };
      }
      if (/FROM payments/.test(text) && /COUNT/.test(text)) {
        return { rows: [{ n: state.paidCount }] };
      }
      if (/SET status = 'expired'::booking_status/.test(text)) {
        if (state.booking.status !== 'hold') return { rows: [] };
        state.booking.status = 'expired';
        return { rows: [{ booking_id: state.booking.booking_id }] };
      }
      if (/DELETE FROM booking_beds/.test(text)) {
        const released = state.beds.length;
        state.beds = [];
        return { rows: new Array(released).fill(0).map((_, i) => ({ bed_row_id: String(i) })), rowCount: released };
      }
      if (/UPDATE payments/.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
}

async function run() {
  console.log('\nverify:luna-same-desk-email-booking\n');

  console.log('[A] Authoritative email quote block from canonical facts');
  const rendered = renderEmailPayToBookDraft({
    language: 'en',
    payment_url: URL,
    hold_expires_at: EXPIRY,
    offering_label: 'Weekend Course',
    quote_total_cents: 19900,
    amount_due_cents: 5000,
    payment_choice: 'deposit',
    date_from: '2026-09-12',
    date_to: '2026-09-19',
    quantity: 1,
  });
  check('renderer accepts canonical quote facts', rendered && rendered.ok === true, JSON.stringify(rendered));
  const body = rendered && rendered.body ? rendered.body : '';
  check(
    'email draft includes compact Quote block with offering, total, due, dates, qty',
    /^Quote$/m.test(body)
      && body.includes('Weekend Course')
      && body.includes('€199.00')
      && body.includes('€50.00')
      && body.includes('2026-09-12')
      && body.includes('2026-09-19')
      && /Qty:\s*1/.test(body),
    body,
  );
  check(
    'email draft includes exact Staff URL, hold expiry, and pay-to-confirm copy',
    body.includes(URL)
      && body.includes(EXPIRY)
      && /held until/i.test(body)
      && /will not automatically complete/i.test(body)
      && (body.match(/\?/g) || []).length <= 2,
    body,
  );
  check(
    'email draft stays a reviewable letter, not a WhatsApp ping',
    body.startsWith('Hi,')
      && /Warm regards/i.test(body)
      && /^Quote$/m.test(body)
      && rendered.draft_only === true
      && rendered.send_allowed === false
      && rendered.auto_send_allowed === false,
    body,
  );
  const noMoney = renderEmailPayToBookDraft({
    language: 'en',
    payment_url: URL,
    hold_expires_at: EXPIRY,
    offering_label: 'Weekend Course',
    date_from: '2026-09-12',
    date_to: '2026-09-19',
    quantity: 1,
  });
  check(
    'missing canonical money is omitted, never invented',
    noMoney.ok === true
      && noMoney.body.includes('Weekend Course')
      && !/€/.test(noMoney.body)
      && !/199/.test(noMoney.body)
      && noMoney.body.includes(URL),
    noMoney.body,
  );
  const badUrl = renderEmailPayToBookDraft({
    language: 'en',
    payment_url: OTHER_URL,
    hold_expires_at: EXPIRY,
    quote_total_cents: 19900,
    amount_due_cents: 5000,
  });
  check('caller/non-Staff payment URL is rejected', badUrl.ok === false);

  console.log('\n[B] Hold+link path interpolates canonical quote/catalog facts');
  const placed = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners());
  check('hold+link succeeds without marking paid/confirmed', placed && placed.ok === true
    && placed.payment_url === URL
    && placed.amount_due_cents === 5000, JSON.stringify(placed));
  check(
    'hold+link draft interpolates catalog/quote cents and offering, not caller values',
    placed.draft_body.includes('Weekend Course')
      && placed.draft_body.includes('€199.00')
      && placed.draft_body.includes('€50.00')
      && placed.draft_body.includes(URL)
      && placed.draft_body.includes(EXPIRY)
      && !placed.draft_body.includes('€1.00')
      && !placed.draft_body.includes(OTHER_URL),
    placed.draft_body,
  );

  console.log('\n[C] Fail-closed authority, offering, quote, money, identity, link');
  const malformed = await placeEmailPayToBookHoldAndPaymentLink({}, payInput({
    authority: authority({ client_id: '', conversation_id: 'not-a-uuid' }),
  }), fakeOwners());
  check('missing/malformed authority fails closed', malformed.ok === false
    && malformed.reason === 'identity_incomplete', JSON.stringify(malformed));

  const unresolved = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async resolveOffering() { return { ok: false, reason: 'offering_unresolved' }; },
  }));
  check('unresolved offering fails closed', unresolved.ok === false
    && unresolved.reason === 'offering_unresolved', JSON.stringify(unresolved));

  const quoteFail = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async quote() { return { ok: false, body: { reason_code: 'stock_unverified' } }; },
  }));
  check('quote/availability failure fails closed', quoteFail.ok === false
    && quoteFail.reason === 'stock_unverified', JSON.stringify(quoteFail));

  const availFail = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async createHold() { return { ok: false, body: { reason_code: 'course_full' } }; },
  }));
  check('availability mismatch fails closed without a link', availFail.ok === false
    && availFail.reason === 'availability_or_price_mismatch'
    && !availFail.payment_url, JSON.stringify(availFail));

  const callerMoney = await placeEmailPayToBookHoldAndPaymentLink({}, payInput({
    amount_due_cents: 1,
  }), fakeOwners());
  check('caller-supplied money is rejected', callerMoney.ok === false
    && callerMoney.reason === 'client_money_rejected', JSON.stringify(callerMoney));

  const callerUrl = extractEmailPayToBookIntent({
    untrusted: untrusted({ payment_url: OTHER_URL }),
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check('caller-supplied payment URL is rejected', callerUrl.ok === false
    && callerUrl.reason === 'client_money_rejected', JSON.stringify(callerUrl));

  const tenant = bindEmailPayToBookIdentities({
    authority: authority({ client_slug: 'wolfhouse-somo' }),
    trustedClientSlug: 'sunset',
  });
  const loc = bindEmailPayToBookIdentities({
    authority: authority({ location_key: 'sunset-sardinero' }),
    trustedLocationId: 'sunset-somo',
  });
  const mailbox = bindEmailPayToBookIdentities({
    authority: authority(),
    trustedMailboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  const convo = bindEmailPayToBookIdentities({
    authority: authority(),
    trustedConversationId: '99999999-9999-4999-8999-999999999999',
  });
  check('wrong tenant/location/mailbox/conversation fail closed',
    tenant.reason === 'tenant_mismatch'
      && loc.reason === 'location_mismatch'
      && mailbox.reason === 'cross_mailbox_rejected'
      && convo.reason === 'conversation_mismatch');

  const linkFail = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async createPaymentLink() {
      return { ok: false, body: { reason_code: 'stripe_checkout_failed' } };
    },
  }));
  check('link creation failure fail-closes and blocks natural fallback',
    linkFail.ok === false
      && linkFail.reason === 'stripe_checkout_failed'
      && linkFail.block_natural_fallback === true
      && linkFail.booking_id === BOOKING_ID, JSON.stringify(linkFail));

  let holdCalls = 0;
  let linkCalls = 0;
  const again = await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async createHold() {
      holdCalls += 1;
      return {
        ok: true,
        body: {
          booking_id: BOOKING_ID,
          booking_code: 'SUNSET-008',
          hold_expires_at: EXPIRY,
          payment_url: URL,
          idempotent: true,
          status: 'hold',
          payment_status: 'unpaid',
        },
      };
    },
    async createPaymentLink() {
      linkCalls += 1;
      throw new Error('idempotent retry must not create a second checkout');
    },
  }));
  check('idempotent retry does not create a duplicate hold or checkout',
    again.ok === true && again.idempotent === true && holdCalls === 1 && linkCalls === 0
      && again.draft_body.includes('€199.00'), JSON.stringify({ holdCalls, linkCalls, ok: again.ok }));

  const holdCmd = [];
  await placeEmailPayToBookHoldAndPaymentLink({}, payInput(), fakeOwners({
    async createHold(_pg, command) {
      holdCmd.push(command);
      return fakeOwners().createHold(_pg, command);
    },
  }));
  check('hold create stays unpaid/unconfirmed',
    holdCmd[0]
      && holdCmd[0].payToBookHold === true
      && holdCmd[0].transportBody.payment_status === 'unpaid'
      && holdCmd[0].transportBody.amount_due_cents === undefined, JSON.stringify(holdCmd[0]));

  console.log('\n[D] Outer Create Draft composition (fails if helper is disconnected)');
  const tryPaySeen = [];
  const connected2 = makeDraftOpenHarness({
    contentText: untrusted().body_text,
    tryEmailPayToBookForCreateDraft: async (input) => {
      tryPaySeen.push(input);
      return placeEmailPayToBookHoldAndPaymentLink({}, input, fakeOwners());
    },
  });
  const created = await connected2.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check('Create Draft outer path invokes the pay-to-book helper', tryPaySeen.length === 1);
  check(
    'outer path binds locked Sunset tenant/location/mailbox/conversation',
    !!(tryPaySeen[0]
      && tryPaySeen[0].trustedClientSlug === 'sunset'
      && tryPaySeen[0].trustedLocationId === 'sunset-somo'
      && tryPaySeen[0].trustedMailboxId === MAILBOX
      && tryPaySeen[0].trustedConversationId === IDS.conversation_id),
    JSON.stringify(tryPaySeen[0] && {
      trustedClientSlug: tryPaySeen[0].trustedClientSlug,
      trustedLocationId: tryPaySeen[0].trustedLocationId,
      trustedMailboxId: tryPaySeen[0].trustedMailboxId,
      trustedConversationId: tryPaySeen[0].trustedConversationId,
    }),
  );
  check(
    'Create Draft persists Staff quote block + exact payment URL, still draft-only',
    created.status === 'draft_ready'
      && typeof created.draft_text === 'string'
      && created.draft_text.includes('Weekend Course')
      && created.draft_text.includes('€199.00')
      && created.draft_text.includes('€50.00')
      && created.draft_text.includes(URL)
      && created.draft_text.includes(EXPIRY)
      && created.send_allowed === false
      && created.auto_send_allowed === false
      && connected2.store.writes.length === 1,
    JSON.stringify({ status: created.status, body: created.draft_text, writes: connected2.store.writes.length }),
  );

  const disconnected = makeDraftOpenHarness({
    contentText: untrusted().body_text,
  });
  const disconnectedOut = await disconnected.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check(
    'disconnected helper cannot mint a Staff payment URL (composition must wire tryPay)',
    !(disconnectedOut.draft_text && disconnectedOut.draft_text.includes('checkout.stripe.com')),
    disconnectedOut.draft_text,
  );
  const apiSrc = readOwner('staff-query-api.js');
  const openSrc = readOwner('lib/staff-email-luna-draft-open.js');
  check(
    'Staff API production Create Draft still injects tryEmailPayToBookForCreateDraft',
    apiSrc.includes('tryEmailPayToBookForCreateDraft')
      && /createStaffEmailLunaDraftOpen\([\s\S]*tryEmailPayToBookForCreateDraft/.test(apiSrc),
  );
  check(
    'draft-open Create Draft calls the injected helper before natural fallback',
    openSrc.includes('deps.tryEmailPayToBookForCreateDraft')
      && openSrc.includes('block_natural_fallback')
      && openSrc.includes('mail_mvp_008_pay_to_book'),
  );

  let openHoldCalls = 0;
  const openHarness = makeDraftOpenHarness({
    contentText: untrusted().body_text,
    tryEmailPayToBookForCreateDraft: async () => {
      openHoldCalls += 1;
      throw new Error('generate-on-open must not create a hold');
    },
  });
  await openHarness.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: IDS.conversation_id,
  });
  check('generate-on-open does not create a hold or payment link', openHoldCalls === 0);

  const linkBlocked = makeDraftOpenHarness({
    contentText: untrusted().body_text,
    tryEmailPayToBookForCreateDraft: async () => ({
      ok: false,
      reason: 'stripe_checkout_failed',
      block_natural_fallback: true,
      booking_id: BOOKING_ID,
    }),
  });
  const blockedOut = await linkBlocked.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check(
    'outer Create Draft fail-closes on link failure without a natural fallback draft',
    blockedOut.status === 'pending' && linkBlocked.store.writes.length === 0,
    JSON.stringify({ status: blockedOut.status, writes: linkBlocked.store.writes }),
  );

  console.log('\n[E] Executable 24h expiry and payment-promotion races');
  const now = new Date('2026-08-29T12:00:00.000Z');
  check('due unpaid hold is expiry-eligible', isHoldDueForExpiry({
    status: 'hold',
    hold_expires_at: now.toISOString(),
  }, now) === true);
  check('future unpaid hold is not expiry-eligible', isHoldDueForExpiry({
    status: 'hold',
    hold_expires_at: new Date(now.getTime() + 1).toISOString(),
  }, now) === false);

  const unpaidPg = makeExpiryPg({
    booking: {
      booking_id: BOOKING_ID,
      client_id: IDS.client_id,
      status: 'hold',
      payment_status: 'waiting_payment',
      hold_expires_at: '2026-08-28T12:00:00.000Z',
      client_slug: 'sunset',
    },
    beds: ['bed-1'],
    paidCount: 0,
  });
  const expired = await expireOneBookingHoldTx(unpaidPg, {
    bookingId: BOOKING_ID,
    clientId: IDS.client_id,
    clientSlug: 'sunset',
    now,
    apply: true,
  });
  check(
    'unpaid due hold expires and releases inventory',
    expired.expired === 1
      && expired.beds_released === 1
      && unpaidPg.state.booking.status === 'expired'
      && unpaidPg.state.beds.length === 0
      && unpaidPg.state.committed === true,
    JSON.stringify(expired),
  );

  const paidPg = makeExpiryPg({
    booking: {
      booking_id: BOOKING_ID,
      client_id: IDS.client_id,
      status: 'hold',
      payment_status: 'paid',
      hold_expires_at: '2026-08-28T12:00:00.000Z',
      client_slug: 'sunset',
    },
    beds: ['bed-1'],
    paidCount: 1,
  });
  const skippedPaid = await expireOneBookingHoldTx(paidPg, {
    bookingId: BOOKING_ID,
    clientId: IDS.client_id,
    clientSlug: 'sunset',
    now,
    apply: true,
  });
  check(
    'paid/confirmed hold is not expired',
    skippedPaid.expired === 0
      && skippedPaid.skipped_paid === 1
      && paidPg.state.booking.status === 'hold'
      && paidPg.state.beds.length === 1,
    JSON.stringify(skippedPaid),
  );

  const late = decideStripeHoldPromote({
    booking_status: 'expired',
    hold_expires_at: '2026-08-27T12:00:00.000Z',
  }, { newBkPayStatus: 'paid' });
  const active = decideStripeHoldPromote({
    booking_status: 'hold',
    hold_expired_by_db: false,
  }, { newBkPayStatus: 'paid' });
  check(
    'late payment after expiry does not silently confirm; active hold promotes once',
    late.promote_to_confirmed === false
      && late.payment_after_hold_expiry === true
      && active.promote_to_confirmed === true,
  );

  console.log('\n[F] WhatsApp composer/path remains short and conversational');
  const waFacts = {
    offering_label: 'Kayak Pro',
    amount_cents: 4500,
    quote_total_cents: 4500,
    currency: 'EUR',
    date: '2026-07-18',
    quantity: 1,
  };
  const waPresented = presentGroundedReply({
    channel: PRESENTATION_CHANNELS.WHATSAPP,
    language: 'en',
    facts: waFacts,
    asks: ['dates', 'guest_count'],
  });
  check(
    'WhatsApp presentation stays one short line, not an email Quote letter',
    waPresented.fact_block === 'Kayak Pro comes to €45.00.'
      && !/^Quote$/m.test(waPresented.body)
      && !waPresented.body.startsWith('Hi,')
      && !/Warm regards/i.test(waPresented.body)
      && waPresented.ask_block === 'What dates do you have in mind?',
    waPresented.body,
  );
  const waTurn = await runSunsetGuestSchoolTurnDryRun({
    message_text: 'how much is a board rental for 1 day?',
    client_slug: 'sunset',
    conversation_metadata: { location_id: 'sunset-somo' },
  }, {}, { gate_status: 'allowed_dry_run' });
  const waReply = String(waTurn && waTurn.proposed_luna_reply || '');
  check(
    'WhatsApp production school-turn owner stays short/conversational',
    !!waReply
      && !/^Quote$/m.test(waReply)
      && !/Warm regards/i.test(waReply)
      && !waReply.startsWith('Hi,')
      && !waReply.includes('\n\nQuote\n'),
    waReply,
  );
  const composerSrc = readOwner('lib/luna-guest-reply-composer.js');
  check(
    'WhatsApp composer still owns conversational payment-link copy',
    composerSrc.includes("I've held your stay for the ${deposit} deposit.")
      && composerSrc.includes('Check the secure payment link I just sent.')
      && !composerSrc.includes('compactEmailPayToBookQuoteBlock')
      && !composerSrc.includes('presentPayToBookEmailDraft'),
  );

  console.log('\n[G] SAME-DESK-002 Luna On / Global Pause / Needs Human + no send');
  check(
    'global pause still blocks drafting',
    emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).allowed === false
      && emailDraftingAllowed({ luna_on: true, needs_human: true, global_pause: true }).reason === 'global_pause',
  );
  check(
    'Luna Off still blocks drafting',
    emailDraftingAllowed({ luna_on: false, needs_human: true, global_pause: false }).reason === 'luna_off',
  );
  check(
    'Needs Human still required for autonomous email drafting',
    emailDraftingAllowed({ luna_on: true, needs_human: false, global_pause: false }).reason === 'needs_human',
  );
  const staffOk = emailDraftingAllowed({
    luna_on: true, needs_human: false, global_pause: false, staff_initiated: true,
  });
  check(
    'staff-initiated Create Draft allowed when Luna is on / pause off, still no send',
    staffOk.allowed === true && staffOk.send_allowed === false && staffOk.auto_send_allowed === false,
  );
  const paused = makeDraftOpenHarness({
    row: openContextRow({ global_pause: true }),
    tryEmailPayToBookForCreateDraft: wiredTryPay(),
  });
  const pausedOut = await paused.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check(
    'Staff Create Draft still requires pause off before a hold/link draft',
    pausedOut.status === 'pending' && paused.store.claims === 0 && paused.store.writes.length === 0,
    JSON.stringify(pausedOut),
  );
  const lunaOff = makeDraftOpenHarness({
    row: openContextRow({ luna_on: false }),
    tryEmailPayToBookForCreateDraft: wiredTryPay(),
  });
  const lunaOffOut = await lunaOff.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: IDS.conversation_id,
    operator_context: 'Send them the deposit link for Weekend Course.',
  });
  check(
    'Staff Create Draft still requires Luna On',
    lunaOffOut.status === 'pending' && lunaOff.store.claims === 0,
    JSON.stringify(lunaOffOut),
  );

  const bookingOwnerSrc = readOwner('lib/email-luna-booking-from-email.js');
  const presentationSrc = readOwner('lib/luna-channel-presentation.js');
  check(
    'pay-to-book and presentation owners never send, approve, or outreach',
    !/handleApproveSend|appendOutboundJournal|sendMail|CUSTOMER_OUTREACH/.test(bookingOwnerSrc)
      && !/handleApproveSend|sendMail|createPaymentLink|stripe/i.test(presentationSrc)
      && bookingOwnerSrc.includes("NOW() + INTERVAL '24 hours'")
      && !bookingOwnerSrc.includes('sk_live_'),
  );
  check(
    'Create Draft still does not approve or dispatch',
    !/handleApproveSend|dispatchApprovedOutbound|createReply|sendDraft/.test(openSrc),
  );
  check(
    'tryEmailPayToBookForCreateDraft remains the production hook',
    typeof tryEmailPayToBookForCreateDraft === 'function',
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  check(
    'package.json exposes verify:luna-same-desk-email-booking',
    pkg.scripts['verify:luna-same-desk-email-booking'] === 'node scripts/verify-luna-same-desk-email-booking.js',
  );

  console.log(`\n── verify:luna-same-desk-email-booking ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
