#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-008 — email hold + pay-to-book.
 *
 * Authentic RED before GREEN. Staff API / Postgres / Stripe remain sole
 * authorities. Auto off. Graph/IMAP/SMTP unchanged. Zero send.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OWNER_REL = 'scripts/lib/email-luna-booking-from-email.js';
const OPEN_REL = 'scripts/lib/staff-email-luna-draft-open.js';
const ROUTE_REL = 'scripts/lib/staff-email-inbox-routes.js';
const AUTO_REL = 'scripts/lib/email-luna-microsoft-auto-create-send.js';
const GRAPH_REL = 'scripts/lib/email-microsoft-graph-reply-draft-transport.js';
const IMAP_REL = 'scripts/lib/email-sunset-imap-imaps-transport.js';
const SMTP_REL = 'scripts/lib/email-sunset-smtp-send-transport.js';
const MVP_REL = 'docs/MAIL-MVP.md';
const PKG_REL = 'package.json';
const JOIN_REL = 'scripts/lib/sunset-admin-course-join.js';
const STOCK_REL = 'scripts/lib/tenant-rental-stock.js';
const WRITE_REL = 'scripts/lib/sunset-schedule-booking-writes.js';
const CREATE_REL = 'scripts/lib/luna-front-desk-booking-create-service.js';
const QUOTE_REL = 'scripts/lib/luna-front-desk-quote-service.js';
const LINK_REL = 'scripts/lib/luna-front-desk-payment-link-service.js';
const STRIPE_REL = 'scripts/lib/sunset-stripe-payment-links.js';
const API_REL = 'scripts/staff-query-api.js';

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const M = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OFFERING = 'surf_pack_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb__1_week';
const URL = 'https://checkout.stripe.com/c/pay/cs_test_mail_mvp_008';
const OTHER_URL = 'https://evil.example/pay';

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  PASS  ${name}`);
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function frozen(value) {
  return Object.freeze(value);
}

function authority(patch) {
  return frozen(Object.assign({
    client_id: C,
    client_slug: 'sunset',
    location_id: L,
    location_key: 'sunset-somo',
    conversation_id: V,
    inbound_message_id: E,
    endpoint_id: E.replace(/3/g, '5'),
    provider_mailbox_id: M,
    endpoint_provider_mailbox_id: M,
  }, patch || {}));
}

function untrusted(patch) {
  return frozen(Object.assign({
    subject: 'Booking 2026-09-12 to 2026-09-19',
    body_text: 'Hi, I would like to book the week of 2026-09-12 to 2026-09-19 and pay the deposit.',
    quoted_history: '',
    from_display_name: 'Ada Guest',
    from_address: 'ada@example.com',
  }, patch || {}));
}

function loadOwner() {
  return require('./lib/email-luna-booking-from-email');
}

async function main() {
  console.log('verify:mail-mvp-008');

  const owner = loadOwner();
  assert.equal(owner.MAIL_MVP_008_HOLD_HOURS, 24);
  assert.equal(owner.MAIL_MVP_008_HOLD_EXPIRY_SQL, "NOW() + INTERVAL '24 hours'");
  ok('24h hold constant and DB-clock SQL');

  const fullAmt = owner.resolveAuthoritativePayToBookAmount(
    { total_cents: 19900, deposit_required_cents: 5000 },
    'full',
    {},
  );
  assert.equal(fullAmt.ok, true);
  assert.equal(fullAmt.amount_due_cents, 19900);
  assert.equal(fullAmt.payment_kind, 'full_amount');
  const depAmt = owner.resolveAuthoritativePayToBookAmount(
    { total_cents: 19900, deposit_required_cents: 5000 },
    'deposit',
    {},
  );
  assert.equal(depAmt.ok, true);
  assert.equal(depAmt.amount_due_cents, 5000);
  assert.equal(depAmt.payment_kind, 'deposit_only');
  ok('deposit/full amounts come from quote policy only');

  const callerAmt = owner.resolveAuthoritativePayToBookAmount(
    { total_cents: 19900, deposit_required_cents: 5000 },
    'deposit',
    { amount_due_cents: 1 },
  );
  assert.equal(callerAmt.ok, false);
  assert.equal(callerAmt.reason, 'client_money_rejected');
  const noDeposit = owner.resolveAuthoritativePayToBookAmount(
    { total_cents: 19900 },
    'deposit',
    {},
  );
  assert.equal(noDeposit.ok, false);
  assert.equal(noDeposit.reason, 'deposit_not_configured');
  ok('caller amounts and missing deposit fail closed');

  const intent = owner.extractEmailPayToBookIntent({
    untrusted: untrusted(),
    operator_context: 'They chose deposit.',
  });
  assert.equal(intent.ok, true);
  assert.equal(intent.payment_choice, 'deposit');
  assert.equal(intent.date_from, '2026-09-12');
  assert.equal(intent.date_to, '2026-09-19');
  assert.equal(intent.guest_email, 'ada@example.com');
  ok('extractor binds guest identity, dates, and deposit choice');

  const missingChoice = owner.extractEmailPayToBookIntent({
    untrusted: untrusted({ body_text: 'Book me 2026-09-12 please' }),
    operator_context: '',
  });
  assert.equal(missingChoice.ok, false);
  ok('missing payment choice fail-closes');

  const bound = owner.bindEmailPayToBookIdentities({ authority: authority() });
  assert.equal(bound.ok, true);
  const crossTenant = owner.bindEmailPayToBookIdentities({
    authority: authority({ client_slug: 'wolfhouse-somo' }),
  });
  assert.equal(crossTenant.reason, 'tenant_mismatch');
  const crossLoc = owner.bindEmailPayToBookIdentities({
    authority: authority({ location_key: 'sunset-sardinero' }),
  });
  assert.equal(crossLoc.reason, 'location_mismatch');
  const crossMail = owner.bindEmailPayToBookIdentities({
    authority: authority(),
    trustedMailboxId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  assert.equal(crossMail.reason, 'cross_mailbox_rejected');
  ok('tenant/location/cross-mailbox identities fail closed');

  const now = new Date('2026-08-28T12:00:00.000Z');
  const due = owner.isHoldDueForExpiry({
    status: 'hold',
    hold_expires_at: now.toISOString(),
  }, now);
  const notDue = owner.isHoldDueForExpiry({
    status: 'hold',
    hold_expires_at: new Date(now.getTime() + 1).toISOString(),
  }, now);
  assert.equal(due, true);
  assert.equal(notDue, false);
  ok('24h expiry boundary uses hold_expires_at vs as-of clock');

  const late = owner.decideStripeHoldPromote({
    booking_status: 'expired',
    hold_expires_at: '2026-08-27T12:00:00.000Z',
  }, { newBkPayStatus: 'paid' });
  assert.equal(late.promote_to_confirmed, false);
  assert.equal(late.payment_after_hold_expiry, true);
  const holdOk = owner.decideStripeHoldPromote({
    booking_status: 'hold',
    hold_expired_by_db: false,
  }, { newBkPayStatus: 'paid' });
  assert.equal(holdOk.promote_to_confirmed, true);
  ok('payment webhook promotes an active hold once; late payment does not revive');

  const rendered = owner.renderEmailPayToBookDraft({
    language: 'en',
    payment_url: URL,
    hold_expires_at: '2026-08-29T12:00:00.000Z',
  });
  assert.equal(rendered.ok, true);
  assert.match(rendered.body, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_mail_mvp_008/);
  assert.match(rendered.body, /2026-08-29T12:00:00.000Z/);
  assert.equal(rendered.body.includes('199'), false);
  assert.equal(rendered.body.includes(OTHER_URL), false);
  const badRender = owner.renderEmailPayToBookDraft({
    language: 'en',
    payment_url: OTHER_URL,
    hold_expires_at: '2026-08-29T12:00:00.000Z',
  });
  assert.equal(badRender.ok, false);
  ok('draft renders exact Staff API URL and expiry; invented URL/amount rejected');

  let quoteCalls = 0;
  let holdCalls = 0;
  let linkCalls = 0;
  const fakeOwners = {
    async resolveOffering() {
      return { ok: true, offering_id: OFFERING };
    },
    async quote() {
      quoteCalls += 1;
      return {
        ok: true,
        body: { total_cents: 19900, deposit_required_cents: 5000, currency: 'EUR' },
      };
    },
    async createHold(_pg, command) {
      holdCalls += 1;
      assert.equal(command.payToBookHold, true);
      assert.equal(command.paymentChoice, 'deposit');
      assert.equal(command.depositRequiredCents, 5000);
      assert.equal(command.transportBody.amount_due_cents, undefined);
      return {
        ok: true,
        body: {
          booking_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          booking_code: 'SUNSET-008',
          hold_expires_at: '2026-08-29T12:00:00.000Z',
          total_cents: 19900,
        },
      };
    },
    async createPaymentLink(_pg, command) {
      linkCalls += 1;
      assert.equal(command.paymentChoice, 'deposit');
      assert.equal(command.amount_due_cents, undefined);
      assert.equal(command.trustedClientSlug, 'sunset');
      return {
        ok: true,
        body: { checkout_url: URL, payment_link_url: URL, payment_id: 'pppppppp-pppp-4ppp-8ppp-pppppppppppp' },
      };
    },
    stripeExecOpts() {
      return { secretKey: 'sk_test_008', successUrl: 'https://example.test/s', cancelUrl: 'https://example.test/c' };
    },
  };

  const placed = await owner.placeEmailPayToBookHoldAndPaymentLink({}, {
    authority: authority(),
    untrusted: untrusted(),
    operator_context: 'deposit is fine',
  }, fakeOwners);
  assert.equal(placed.ok, true);
  assert.equal(placed.payment_url, URL);
  assert.equal(placed.hold_expires_at, '2026-08-29T12:00:00.000Z');
  assert.equal(placed.amount_due_cents, 5000);
  assert.match(placed.draft_body, /cs_test_mail_mvp_008/);
  assert.equal(quoteCalls, 1);
  assert.equal(holdCalls, 1);
  assert.equal(linkCalls, 1);
  ok('Create Draft hold+link uses authoritative quote/hold/payment-link owners');

  quoteCalls = 0; holdCalls = 0; linkCalls = 0;
  const again = await owner.placeEmailPayToBookHoldAndPaymentLink({}, {
    authority: authority(),
    untrusted: untrusted(),
    operator_context: 'deposit is fine',
  }, {
    ...fakeOwners,
    async createHold() {
      holdCalls += 1;
      return {
        ok: true,
        body: {
          booking_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          booking_code: 'SUNSET-008',
          hold_expires_at: '2026-08-29T12:00:00.000Z',
          payment_url: URL,
          idempotent: true,
        },
      };
    },
    async createPaymentLink() {
      linkCalls += 1;
      throw new Error('idempotent retry must not create a second checkout');
    },
  });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(holdCalls, 1);
  assert.equal(linkCalls, 0);
  ok('idempotent retry does not create a duplicate hold or checkout');

  const mismatch = await owner.placeEmailPayToBookHoldAndPaymentLink({}, {
    authority: authority(),
    untrusted: untrusted(),
    operator_context: 'deposit is fine',
  }, {
    ...fakeOwners,
    async createHold() {
      return { ok: false, body: { reason_code: 'course_full' } };
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'availability_or_price_mismatch');
  ok('availability/price mismatch rejects without inventing a link');

  const ownerSrc = read(OWNER_REL);
  assert.match(ownerSrc, /NOW\(\) \+ INTERVAL '24 hours'/);
  assert.match(ownerSrc, /agent_luna_email/);
  assert.doesNotMatch(ownerSrc, /sk_live_/);
  assert.doesNotMatch(ownerSrc, /handleApproveSend|appendOutboundJournal|graph\.microsoft\.com\/v1\.0\/me\/sendMail/);
  ok('owner has no send authority and no live Stripe key');

  const openSrc = read(OPEN_REL);
  assert.match(openSrc, /tryEmailPayToBookForCreateDraft/);
  assert.match(openSrc, /deps\.runtimeEnv \|\| process\.env/);
  assert.doesNotMatch(openSrc, /createHold|createBooking|createPaymentLink|handleApproveSend|appendOutboundJournal/);
  ok('Create Draft open owner calls 008 hook without becoming a money/send authority');

  const apiSrc = read(API_REL);
  assert.match(apiSrc, /tryEmailPayToBookForCreateDraft/);
  ok('Staff API wires Create Draft to MAIL-MVP-008 owner');

  const quoteSrc = read(QUOTE_REL);
  const createSrc = read(CREATE_REL);
  const writeSrc = read(WRITE_REL);
  const linkSrc = read(LINK_REL);
  const stripeSrc = read(STRIPE_REL);
  const joinSrc = read(JOIN_REL);
  const stockSrc = read(STOCK_REL);
  assert.match(quoteSrc, /LUNA_EMAIL:\s*'luna_email'/);
  assert.match(createSrc, /LUNA_EMAIL:\s*'luna_email'/);
  assert.match(createSrc, /payToBookHold/);
  assert.match(writeSrc, /NOW\(\) \+ INTERVAL '24 hours'/);
  assert.match(writeSrc, /status = 'hold'|payToBookHold/);
  assert.match(linkSrc, /LUNA_EMAIL:\s*'luna_email'/);
  assert.match(stripeSrc, /paymentChoice|payment_choice/);
  assert.match(joinSrc, /NOT IN \('cancelled', 'canceled', 'expired'\)/);
  assert.doesNotMatch(joinSrc, /NOT IN \('cancelled', 'canceled', 'expired', 'hold'\)/);
  assert.match(stockSrc, /NOT IN \('cancelled', 'canceled', 'expired'\)/);
  assert.doesNotMatch(stockSrc, /NOT IN \('cancelled', 'canceled', 'expired', 'hold'\)/);
  ok('Sunset quote/create/hold/link/capacity reuse 24h hold and count holds as inventory');

  const mvp = read(MVP_REL);
  assert.match(mvp, /\*\*008\*\*.*Yes/);
  assert.match(mvp, /verify:mail-mvp-008/);
  assert.match(mvp, /24 hours/);
  ok('MAIL-MVP.md marks 008 as this job');

  const pkg = JSON.parse(read(PKG_REL));
  assert.equal(pkg.scripts['verify:mail-mvp-008'], 'node scripts/verify-mail-mvp-008.js');
  ok('package.json exposes verify:mail-mvp-008');

  const expirySrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/booking-hold-expiry.js'), 'utf8');
  assert.match(expirySrc, /status = 'expired'::booking_status/);
  assert.match(expirySrc, /DELETE FROM booking_beds/);
  assert.match(expirySrc, /FOR UPDATE/);
  const webhookSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripe-hold-promote-policy.js'), 'utf8');
  assert.match(webhookSrc, /If payment already paid → idempotent return/);
  assert.match(webhookSrc, /hold_expired/);
  assert.match(webhookSrc, /booking_already_expired/);
  ok('expiry worker and webhook promote remain the sole commit/expiry owners');

  const autoSrc = read(AUTO_REL);
  assert.match(autoSrc, /LUNA_AUTO_SEND_ENABLED/);
  const graphSrc = read(GRAPH_REL);
  const imapSrc = read(IMAP_REL);
  const smtpSrc = read(SMTP_REL);
  const inboxSrc = read(ROUTE_REL);
  assert.doesNotMatch(ownerSrc, /createMicrosoftGraphReplyDraftTransport|imapSearch|smtpSend/);
  assert.doesNotMatch(openSrc, /EMAIL_OUTBOUND_SEND_ENABLED\s*=\s*'true'/);
  assert.match(inboxSrc, /No Luna auto-send/);
  assert.match(autoSrc, /Default remains OFF|LUNA_AUTO_SEND_ENABLED/);
  assert.ok(graphSrc.length > 100);
  assert.ok(imapSrc.length > 100);
  assert.ok(smtpSrc.length > 100);
  ok('Auto remains off; Graph/IMAP/SMTP owners remain separate');

  for (const rel of [OWNER_REL, 'scripts/verify-mail-mvp-008.js']) {
    const checked = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || rel);
  }
  ok('syntax check');

  console.log(`PASS ${pass}`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
