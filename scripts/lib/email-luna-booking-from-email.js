'use strict';

/**
 * MAIL-MVP-008 — Luna Front Desk email hold + pay-to-book.
 *
 * Staff Create Draft may include a Staff-API-created payment URL and the
 * truthful 24-hour hold expiry. Amounts, availability, checkout URLs, and
 * booking/payment state come only from Staff API / Postgres / Stripe owners.
 * The model cannot supply money, links, or inventory facts. No send.
 */

const crypto = require('node:crypto');
const util = require('node:util');

const { decideStripeHoldPromote } = require('./stripe-hold-promote-policy');
const { isHoldDueForExpiry } = require('./booking-hold-expiry');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuote,
  QUOTE_CHANNELS,
  rejectClientSuppliedMoney,
} = require('./luna-front-desk-quote-service');
const {
  BOOKING_CREATE_CHANNELS,
  buildSunsetBookingCreateCommand,
  executeSunsetBookingCreate,
} = require('./luna-front-desk-booking-create-service');
const {
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
  buildPaymentLinkCommand,
  createPaymentLink,
} = require('./luna-front-desk-payment-link-service');
const { SUNSET_CLIENT_SLUG } = require('./sunset-stripe-payment-links');
const {
  CATALOG_CHANNELS,
  buildSunsetCatalogCommand,
  executeSunsetCatalog,
} = require('./luna-front-desk-catalog-service');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;

const MAIL_MVP_008_HOLD_HOURS = 24;
const MAIL_MVP_008_HOLD_EXPIRY_SQL = "NOW() + INTERVAL '24 hours'";
const MAIL_MVP_008_SOURCE = 'mail_mvp_008_email_pay_to_book';
const MAIL_MVP_008_ACTOR_SOURCE = 'agent_luna_email';
const PAYMENT_CHOICES = freeze(['deposit', 'full']);
const CLIENT_MONEY_FIELDS = freeze([
  'amount_due_cents',
  'amount_paid_cents',
  'total_cents',
  'total_amount_cents',
  'deposit_required_cents',
  'deposit_amount_cents',
  'balance_due_cents',
  'payment_link_amount_cents',
  'unit_amount_cents',
  'currency',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRIPE_CHECKOUT_RE = /^https:\/\/checkout\.stripe\.com\/(?:c\/pay\/|pay\/)[A-Za-z0-9_=?&%-]+$/;

const DEPOSIT_RE = /\bdeposits?\b|\bdep[oó]sitos?\b/;
const FULL_RE = /\bfull(?:\s+payment|\s+amount)\b|\bpay(?:ing|ment)?\s+in\s+full\b|\bpago\s+completo\b|\bimporte\s+completo\b/;

const RENDER_COPY = freeze({
  en: freeze({
    hello: 'Hi,',
    thanks: 'Thanks for your message.',
    pay: 'To complete this booking, please use this payment link from our desk:',
    hold: 'Your dates are held until',
    late: 'Payment after that time will not automatically complete the booking.',
    signoff: 'Warm regards,',
    signature: 'Luna',
  }),
  es: freeze({
    hello: 'Hola,',
    thanks: 'Gracias por tu mensaje.',
    pay: 'Para completar esta reserva, usa este enlace de pago de recepción:',
    hold: 'Tus fechas quedan retenidas hasta',
    late: 'Un pago después de esa hora no completará la reserva automáticamente.',
    signoff: 'Un saludo cálido,',
    signature: 'Luna',
  }),
});

function fail(reason, extra) {
  return freeze({
    ok: false,
    reason: reason || 'email_pay_to_book_not_ready',
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}

function asText(value) {
  if (typeof value !== 'string' || isProxy(value)) return '';
  try {
    return value.normalize('NFC');
  } catch {
    return value;
  }
}

function clip(value, max) {
  const text = asText(value);
  return text.length > max ? text.slice(0, max) : text;
}

function uuid(value) {
  const text = asText(value).trim();
  return UUID_RE.test(text) ? text.toLowerCase() : '';
}

function rejectCallerMoney(body) {
  const src = body && typeof body === 'object' && !isProxy(body) ? body : {};
  for (const key of CLIENT_MONEY_FIELDS) {
    if (src[key] !== undefined && src[key] !== null && src[key] !== '') {
      return { ok: false, field: key };
    }
  }
  if (src.quote && typeof src.quote === 'object') {
    for (const key of CLIENT_MONEY_FIELDS) {
      if (src.quote[key] !== undefined && src.quote[key] !== null && src.quote[key] !== '') {
        return { ok: false, field: `quote.${key}` };
      }
    }
  }
  if (src.checkout_url || src.payment_link_url || src.payment_url) {
    return { ok: false, field: 'payment_url' };
  }
  return { ok: true };
}

function extractPaymentChoice(text) {
  const raw = asText(text).toLowerCase();
  if (!raw) return fail('payment_choice_missing');
  const deposit = DEPOSIT_RE.test(raw);
  const full = FULL_RE.test(raw);
  if (deposit && full) return fail('payment_choice_ambiguous');
  if (deposit) return freeze({ ok: true, payment_choice: 'deposit' });
  if (full) return freeze({ ok: true, payment_choice: 'full' });
  return fail('payment_choice_missing');
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function inclusiveIsoSpan(from, to, cap) {
  if (!from || !to || to < from) return null;
  const out = [];
  let cur = from;
  while (cur <= to && out.length < cap) {
    out.push(cur);
    const next = addDaysIso(cur, 1);
    if (!next || next === cur) break;
    cur = next;
  }
  if (out[out.length - 1] !== to) return null;
  return out;
}

function extractIsoDates(text) {
  const raw = asText(text);
  const range = /\b(20\d{2}-\d{2}-\d{2})\s*(?:to|until|through|thru|-|–|—|al|hasta)\s*(20\d{2}-\d{2}-\d{2})\b/i.exec(raw);
  if (range) {
    const span = inclusiveIsoSpan(range[1], range[2], 14);
    if (!span) return freeze([]);
    return freeze(span.slice());
  }
  const found = [];
  const seen = Object.create(null);
  ISO_DATE_RE.lastIndex = 0;
  let match = ISO_DATE_RE.exec(raw);
  while (match) {
    const day = match[1];
    if (!seen[day]) {
      seen[day] = true;
      found.push(day);
    }
    match = ISO_DATE_RE.exec(raw);
  }
  found.sort();
  if (found.length > 2) return freeze([]);
  return freeze(found.slice());
}

function extractGuestQuantity(text) {
  const raw = asText(text).toLowerCase();
  const hits = [];
  const re = /\b(\d{1,2})\s*(?:people|persons|personas|guests|guest|surfers|surfer|pax|adults|adultos)\b/g;
  let m = re.exec(raw);
  while (m) {
    hits.push(Number(m[1]));
    m = re.exec(raw);
  }
  const unique = [...new Set(hits.filter((n) => Number.isInteger(n) && n >= 1 && n <= 24))];
  if (unique.length > 1) return fail('quantity_ambiguous');
  if (unique.length === 1) return freeze({ ok: true, quantity: unique[0] });
  return freeze({ ok: true, quantity: 1 });
}

function staffRequestedPayToBook(operatorContext) {
  const raw = asText(operatorContext).toLowerCase();
  if (!raw.trim()) return false;
  return /\b(?:deposit|dep[oó]sito|full payment|pay in full|pago completo|payment link|enlace de pago|hold (?:the |their |these )?dates|reten|book them|send (?:them )?(?:the )?(?:deposit |full )?link|m[áa]ndales?(?: el)? (?:link|enlace))\b/.test(raw);
}

function extractEmailPayToBookIntent(input) {
  const untrusted = input && input.untrusted && typeof input.untrusted === 'object'
    ? input.untrusted : {};
  const operator = clip(input && input.operator_context, 4000);
  const subject = clip(untrusted.subject, 998);
  const body = clip(untrusted.body_text, 64000);
  const fromName = clip(untrusted.from_display_name, 200).trim();
  const fromAddress = clip(untrusted.from_address, 320).trim().toLowerCase();
  const combined = `${operator}\n${subject}\n${body}`;

  const money = rejectCallerMoney(untrusted);
  if (!money.ok) return fail('client_money_rejected', { field: money.field });
  const noteMoney = rejectCallerMoney({ operator_context: operator });
  if (!noteMoney.ok) return fail('client_money_rejected', { field: noteMoney.field });

  if (!fromName) return fail('guest_name_missing');
  if (!EMAIL_RE.test(fromAddress)) return fail('guest_email_missing');

  if (!staffRequestedPayToBook(operator)) return fail('staff_pay_to_book_not_requested');

  const choice = extractPaymentChoice(combined);
  if (!choice.ok) return choice;

  const dates = extractIsoDates(combined);
  if (!dates.length) return fail('dates_missing');

  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];
  if (dateTo < dateFrom) return fail('dates_invalid');

  const qty = extractGuestQuantity(combined);
  if (!qty.ok) return qty;

  return freeze({
    ok: true,
    payment_choice: choice.payment_choice,
    guest_name: fromName,
    guest_email: fromAddress,
    date_from: dateFrom,
    date_to: dateTo,
    service_dates: dates,
    quantity: qty.quantity,
    text: combined,
  });
}

function resolveAuthoritativePayToBookAmount(quote, paymentChoice, caller) {
  const callerCheck = rejectCallerMoney(caller || {});
  if (!callerCheck.ok) return fail('client_money_rejected', { field: callerCheck.field });
  const choice = asText(paymentChoice).trim();
  if (!PAYMENT_CHOICES.includes(choice)) return fail('invalid_payment_choice');
  if (!quote || typeof quote !== 'object' || isProxy(quote)) return fail('quote_missing');
  const total = Number(quote.total_cents);
  if (!Number.isSafeInteger(total) || total <= 0) return fail('quote_total_invalid');
  if (choice === 'full') {
    return freeze({
      ok: true,
      payment_choice: 'full',
      payment_kind: 'full_amount',
      amount_due_cents: total,
      deposit_required_cents: null,
    });
  }
  const deposit = Number(quote.deposit_required_cents);
  if (!Number.isSafeInteger(deposit) || deposit <= 0) return fail('deposit_not_configured');
  if (deposit > total) return fail('deposit_exceeds_total');
  return freeze({
    ok: true,
    payment_choice: 'deposit',
    payment_kind: 'deposit_only',
    amount_due_cents: deposit,
    deposit_required_cents: deposit,
  });
}

function bindEmailPayToBookIdentities(input) {
  const authority = input && input.authority && typeof input.authority === 'object'
    ? input.authority : {};
  const clientId = uuid(authority.client_id);
  const conversationId = uuid(authority.conversation_id);
  const inboundEventId = uuid(authority.inbound_message_id || authority.inbound_event_id);
  const endpointId = uuid(authority.endpoint_id);
  const locationId = asText(authority.location_key || authority.location_id).trim();
  const mailboxId = asText(authority.provider_mailbox_id || authority.endpoint_provider_mailbox_id).trim();
  const clientSlug = asText(authority.client_slug).trim() || SUNSET_CLIENT_SLUG;
  if (!clientId || !conversationId || !inboundEventId || !endpointId) {
    return fail('identity_incomplete');
  }
  if (clientSlug !== SUNSET_CLIENT_SLUG) return fail('tenant_mismatch');
  if (locationId !== 'sunset-somo') return fail('location_mismatch');
  if (!mailboxId) return fail('mailbox_missing');
  if (input.trustedClientSlug && asText(input.trustedClientSlug).trim() !== clientSlug) {
    return fail('tenant_mismatch');
  }
  if (input.trustedLocationId && asText(input.trustedLocationId).trim() !== locationId) {
    return fail('location_mismatch');
  }
  if (input.trustedMailboxId && asText(input.trustedMailboxId).trim() !== mailboxId) {
    return fail('cross_mailbox_rejected');
  }
  if (input.trustedConversationId && uuid(input.trustedConversationId) !== conversationId) {
    return fail('conversation_mismatch');
  }
  return freeze({
    ok: true,
    client_id: clientId,
    client_slug: clientSlug,
    location_id: locationId,
    conversation_id: conversationId,
    inbound_event_id: inboundEventId,
    endpoint_id: endpointId,
    mailbox_id: mailboxId,
  });
}

function buildEmailPayToBookIdempotencyKey(bound, intent, offeringId) {
  const payload = JSON.stringify({
    source: MAIL_MVP_008_SOURCE,
    client_id: bound.client_id,
    location_id: bound.location_id,
    conversation_id: bound.conversation_id,
    endpoint_id: bound.endpoint_id,
    mailbox_id: bound.mailbox_id,
    payment_choice: intent.payment_choice,
    date_from: intent.date_from,
    date_to: intent.date_to,
    quantity: intent.quantity,
    offering_id: asText(offeringId).trim(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function holdExpiryIsoFromDb(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = asText(value).trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

function isExactStaffPaymentUrl(url) {
  const text = asText(url).trim();
  if (!text || isProxy(url)) return false;
  if (/\s/.test(text)) return false;
  return STRIPE_CHECKOUT_RE.test(text);
}

function detectDraftLanguage(subject, body) {
  const text = `${asText(subject)}\n${asText(body)}`;
  if (/[áéíóúñü¿¡]/i.test(text) || /\b(hola|gracias|reserva|pago|fechas)\b/i.test(text)) return 'es';
  return 'en';
}

function renderEmailPayToBookDraft(opts) {
  const language = opts && opts.language === 'es' ? 'es' : 'en';
  const url = asText(opts && opts.payment_url).trim();
  const expiry = holdExpiryIsoFromDb(opts && opts.hold_expires_at);
  if (!isExactStaffPaymentUrl(url)) return fail('payment_url_unusable');
  if (!expiry) return fail('hold_expires_at_unusable');
  const copy = RENDER_COPY[language];
  const body = [
    copy.hello,
    '',
    copy.thanks,
    copy.pay,
    url,
    '',
    `${copy.hold} ${expiry}.`,
    copy.late,
    '',
    copy.signoff,
    copy.signature,
  ].join('\n');
  if (hasInventedMoney(body, url)) return fail('invented_amount_in_draft');
  return freeze({
    ok: true,
    language,
    body,
    payment_url: url,
    hold_expires_at: expiry,
  });
}

function hasInventedMoney(body, allowedUrl) {
  const withoutUrl = asText(body).split(allowedUrl).join('');
  const withoutExpiry = withoutUrl.replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    '',
  );
  if (/€|\$|£|\b(?:eur|usd|gbp)\b|\d+[.,]\d{2}\s*(?:€|\$|£|\b(?:eur|usd|gbp)\b)/i.test(withoutExpiry)) {
    return true;
  }
  const urls = asText(body).match(/https?:\/\/[^\s]+/g) || [];
  return urls.some((item) => item !== allowedUrl);
}

function quoteTransportFromIntent(intent, offering) {
  const expanded = offering && offering.components
    ? offering
    : expandCatalogOfferingForWrite(offering, intent);
  if (!expanded || expanded.ok === false) return null;
  const transport = {
    guest_name: intent.guest_name,
    date_from: intent.date_from,
    date_to: intent.date_to,
    service_dates: intent.service_dates.slice(),
    quantity: intent.quantity,
  };
  if (expanded.offering_id) transport.offering_id = expanded.offering_id;
  if (expanded.course_id) transport.course_id = expanded.course_id;
  if (expanded.components) transport.components = expanded.components;
  if (Array.isArray(expanded.rentals)) transport.rentals = expanded.rentals;
  return transport;
}

function stripeExecOptsFromEnv(env) {
  const src = env && typeof env === 'object' ? env : {};
  return {
    staffActionsEnabled: true,
    stripeLinksEnabled: String(src.STRIPE_PAYMENT_LINKS_ENABLED || 'true') !== 'false',
    secretKey: src.STRIPE_SECRET_KEY || '',
    successUrl: src.STRIPE_SUCCESS_URL || src.STRIPE_CHECKOUT_SUCCESS_URL || '',
    cancelUrl: src.STRIPE_CANCEL_URL || src.STRIPE_CHECKOUT_CANCEL_URL || '',
    publicPaymentBaseUrl: src.SUNSET_PUBLIC_PAYMENT_BASE_URL || '',
    expectedMode: 'test',
    env: src,
  };
}

function offeringMentionedInText(offering, text) {
  const hay = asText(text).toLowerCase();
  if (!hay) return false;
  const id = asText(offering && offering.offering_id).trim().toLowerCase();
  const label = asText(offering && offering.label).trim().toLowerCase();
  if (id && UUID_RE.test(id) && hay.includes(id)) return true;
  if (label && label.length >= 8) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(hay)) return true;
  }
  return false;
}

function expandCatalogOfferingForWrite(offering, intent) {
  if (!offering || offering.ok === false) return fail('offering_unresolved');
  const offeringId = asText(offering.offering_id).trim();
  const type = asText(offering.offering_type).trim();
  const quantity = intent.quantity;
  if (!offeringId || !Number.isInteger(quantity) || quantity < 1) return fail('offering_unresolved');
  if (type === 'course') {
    const courseId = asText(offering.course_id).trim();
    const tierKey = asText(offering.tier_key || (offering.tier && offering.tier.key)).trim();
    if (!courseId || !tierKey) return fail('offering_unresolved');
    return freeze({
      ok: true,
      offering_id: offeringId,
      offering_type: 'course',
      course_id: courseId,
      quantity,
      components: freeze({
        course: freeze({
          course_id: courseId,
          tier_key: tierKey,
          quantity,
        }),
      }),
    });
  }
  if (type === 'rental') {
    const offeringKey = asText(offering.offering_key || offering.item_code || offeringId).trim();
    const durationKey = asText(offering.duration_key || offering.billing_unit || offering.price && offering.price.unit).trim();
    if (!offeringKey || !durationKey) return fail('offering_unresolved');
    return freeze({
      ok: true,
      offering_id: offeringId,
      offering_type: 'rental',
      quantity,
      rentals: freeze([freeze({
        offering_key: offeringKey,
        duration_key: durationKey,
        quantity,
      })]),
    });
  }
  if (type === 'private_lesson') {
    const sessions = intent.service_dates.map((date) => freeze({ date }));
    return freeze({
      ok: true,
      offering_id: offeringId,
      offering_type: 'private_lesson',
      quantity,
      components: freeze({
        private_lesson: freeze({
          quantity,
          surfer_count: quantity,
          sessions,
        }),
      }),
    });
  }
  return fail('offering_unresolved');
}

async function resolveOfferingFromCatalog(pg, bound, intent) {
  const catalogCmd = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_EMAIL || CATALOG_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: bound.location_id,
    transportBody: {
      date_from: intent.date_from,
      date_to: intent.date_to,
      service_dates: intent.service_dates.slice(),
    },
  });
  if (!catalogCmd.ok) return fail('offering_unresolved');
  const catalog = await executeSunsetCatalog(pg, catalogCmd.command);
  if (!catalog || catalog.ok !== true) return fail('offering_unresolved');
  const offerings = Array.isArray(catalog.body && catalog.body.offerings)
    ? catalog.body.offerings
    : [];
  const matches = offerings.filter((row) => (
    row && row.bookable === true && offeringMentionedInText(row, intent.text)
  ));
  if (matches.length !== 1) return fail('offering_unresolved');
  const row = matches[0];
  return freeze({
    ok: true,
    offering_id: asText(row.offering_id).trim(),
    offering_type: asText(row.offering_type).trim() || null,
    course_id: asText(row.course_id).trim() || null,
    tier_key: asText(row.tier_key || (row.tier && row.tier.key)).trim() || null,
    offering_key: asText(row.offering_key || row.item_code).trim() || null,
    duration_key: asText(row.duration_key || row.billing_unit).trim() || null,
    label: asText(row.label).trim() || null,
  });
}

async function defaultResolveOffering(pg, bound, intent, owners) {
  if (owners && typeof owners.resolveOffering === 'function') {
    return owners.resolveOffering(pg, bound, intent);
  }
  return resolveOfferingFromCatalog(pg, bound, intent);
}

async function placeEmailPayToBookHoldAndPaymentLink(pg, input, owners) {
  const deps = owners && typeof owners === 'object' ? owners : {};
  const money = rejectCallerMoney(input);
  if (!money.ok) return fail('client_money_rejected', { field: money.field });

  const bound = bindEmailPayToBookIdentities(input);
  if (!bound.ok) return bound;

  const intent = extractEmailPayToBookIntent(input);
  if (!intent.ok) return intent;

  const offering = await defaultResolveOffering(pg, bound, intent, deps);
  if (!offering || offering.ok === false) {
    return offering && offering.reason ? offering : fail('offering_unresolved');
  }
  const offeringId = asText(offering.offering_id).trim();
  if (!offeringId) return fail('offering_unresolved');

  const quoteFn = typeof deps.quote === 'function' ? deps.quote : executeSunsetQuote;
  const createHoldFn = typeof deps.createHold === 'function'
    ? deps.createHold : executeSunsetBookingCreate;
  const createLinkFn = typeof deps.createPaymentLink === 'function'
    ? deps.createPaymentLink : createPaymentLink;

  const transport = quoteTransportFromIntent(intent, offering);
  if (!transport) return fail('offering_unresolved');
  const quoteCmd = buildSunsetQuoteCommand({
    channel: QUOTE_CHANNELS.LUNA_EMAIL || 'luna_email',
    trustedLocationId: bound.location_id,
    transportBody: transport,
    now: input.now instanceof Date ? input.now : new Date(),
  });
  if (!quoteCmd.ok) return fail(quoteCmd.body && quoteCmd.body.reason_code || 'quote_command_failed');
  const quoted = await quoteFn(pg, quoteCmd.command, deps.quoteOpts || {});
  if (!quoted || quoted.ok !== true) {
    return fail((quoted && quoted.body && (quoted.body.reason_code || quoted.body.reason || quoted.body.error))
      || 'quote_failed');
  }
  const quoteBody = quoted.body || {};
  const priced = resolveAuthoritativePayToBookAmount(quoteBody, intent.payment_choice, input);
  if (!priced.ok) return priced;
  if (quoteBody.total_cents != null && Number(quoteBody.total_cents) !== Number(quoteBody.total_cents)) {
    return fail('quote_total_invalid');
  }

  const idempotencyKey = buildEmailPayToBookIdempotencyKey(bound, intent, offeringId);
  const createCmd = buildSunsetBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_EMAIL || 'luna_email',
    trustedLocationId: bound.location_id,
    actorHints: { source: MAIL_MVP_008_ACTOR_SOURCE },
    now: input.now instanceof Date ? input.now : new Date(),
    transportBody: {
      ...transport,
      guest_name: intent.guest_name,
      guest_email: intent.guest_email,
      payment_status: 'unpaid',
      idempotency_key: idempotencyKey,
      quote_provenance: quoteBody.quote_provenance || quoteBody.provenance || null,
    },
  });
  if (!createCmd.ok) return fail(createCmd.body && createCmd.body.reason_code || 'hold_command_failed');
  createCmd.command.payToBookHold = true;
  createCmd.command.payToBookHoldHours = MAIL_MVP_008_HOLD_HOURS;
  createCmd.command.depositRequiredCents = priced.deposit_required_cents;
  createCmd.command.paymentChoice = priced.payment_choice;
  createCmd.command.mailMvp008 = freeze({
    source: MAIL_MVP_008_SOURCE,
    conversation_id: bound.conversation_id,
    inbound_event_id: bound.inbound_event_id,
    endpoint_id: bound.endpoint_id,
    mailbox_id: bound.mailbox_id,
    payment_choice: priced.payment_choice,
    quote_total_cents: quoteBody.total_cents,
  });

  let held = await createHoldFn(pg, createCmd.command, deps.createHoldOpts || {});
  if ((!held || held.ok !== true)
      && held && held.body && held.body.reason_code === 'idempotency_key_expired') {
    createCmd.command.transportBody.idempotency_key = `${idempotencyKey}:post_expiry`;
    held = await createHoldFn(pg, createCmd.command, deps.createHoldOpts || {});
  }
  if (!held || held.ok !== true) {
    const code = held && held.body && (held.body.reason_code || held.body.error || held.body.reason);
    if (/availab|course_full|stock|mismatch|price/i.test(String(code || ''))) {
      return fail('availability_or_price_mismatch', { detail: code });
    }
    return fail(code || 'hold_failed');
  }
  const holdBody = held.body || {};
  const bookingId = holdBody.booking_id || (holdBody.booking && holdBody.booking.booking_id);
  const bookingCode = holdBody.booking_code || (holdBody.booking && holdBody.booking.booking_code);
  const holdExpiresAt = holdExpiryIsoFromDb(
    holdBody.hold_expires_at
    || (holdBody.booking && holdBody.booking.hold_expires_at),
  );
  if (!bookingId || !holdExpiresAt) return fail('hold_identity_missing');

  if (holdBody.idempotent === true && holdBody.payment_url && isExactStaffPaymentUrl(holdBody.payment_url)) {
    const reused = renderEmailPayToBookDraft({
      language: detectDraftLanguage(input.untrusted && input.untrusted.subject, input.untrusted && input.untrusted.body_text),
      payment_url: holdBody.payment_url,
      hold_expires_at: holdExpiresAt,
    });
    if (!reused.ok) return reused;
    return freeze({
      ok: true,
      idempotent: true,
      booking_id: bookingId,
      booking_code: bookingCode || null,
      payment_url: reused.payment_url,
      hold_expires_at: reused.hold_expires_at,
      payment_choice: priced.payment_choice,
      amount_due_cents: priced.amount_due_cents,
      draft_body: reused.body,
    });
  }

  const linkBuilt = buildPaymentLinkCommand({
    operation: PAYMENT_LINK_OPERATIONS.CREATE,
    trustedClientSlug: bound.client_slug,
    locationId: bound.location_id,
    channel: PAYMENT_LINK_CHANNELS.LUNA_EMAIL || 'luna_email',
    bookingId,
    bookingCode,
    idempotencyKey,
    actor: { source: MAIL_MVP_008_ACTOR_SOURCE },
    transportBody: {
      payment_choice: priced.payment_choice,
    },
  });
  if (!linkBuilt.ok) return fail(linkBuilt.body && linkBuilt.body.reason_code || 'payment_link_command_failed');
  linkBuilt.command.paymentChoice = priced.payment_choice;
  const execOpts = typeof deps.stripeExecOpts === 'function'
    ? deps.stripeExecOpts(input.env)
    : stripeExecOptsFromEnv(input.env);
  const linked = await createLinkFn(pg, linkBuilt.command, execOpts);
  if (!linked || linked.ok !== true) {
    return fail((linked && linked.body && (linked.body.reason_code || linked.body.error)) || 'payment_link_failed', {
      block_natural_fallback: true,
      booking_id: bookingId,
    });
  }
  const paymentUrl = asText(
    (linked.body && (linked.body.checkout_url || linked.body.payment_link_url)) || '',
  ).trim();
  if (!isExactStaffPaymentUrl(paymentUrl)) {
    return fail('payment_url_unusable', {
      block_natural_fallback: true,
      booking_id: bookingId,
    });
  }

  const rendered = renderEmailPayToBookDraft({
    language: detectDraftLanguage(input.untrusted && input.untrusted.subject, input.untrusted && input.untrusted.body_text),
    payment_url: paymentUrl,
    hold_expires_at: holdExpiresAt,
  });
  if (!rendered.ok) return rendered;

  return freeze({
    ok: true,
    idempotent: linked.body && linked.body.idempotent === true,
    booking_id: bookingId,
    booking_code: bookingCode || null,
    payment_id: (linked.body && linked.body.payment_id) || null,
    payment_url: rendered.payment_url,
    hold_expires_at: rendered.hold_expires_at,
    payment_choice: priced.payment_choice,
    amount_due_cents: priced.amount_due_cents,
    draft_body: rendered.body,
  });
}

async function tryEmailPayToBookForCreateDraft(input) {
  const withPgClient = input && input.withPgClient;
  const owners = (input && input.owners) || undefined;
  if (typeof withPgClient !== 'function') return fail('pg_unavailable');
  try {
    return await withPgClient(async (pg) => (
      placeEmailPayToBookHoldAndPaymentLink(pg, input, owners)
    ));
  } catch {
    return fail('email_pay_to_book_failed');
  }
}

module.exports = freeze({
  MAIL_MVP_008_HOLD_HOURS,
  MAIL_MVP_008_HOLD_EXPIRY_SQL,
  MAIL_MVP_008_SOURCE,
  MAIL_MVP_008_ACTOR_SOURCE,
  PAYMENT_CHOICES,
  extractPaymentChoice,
  extractIsoDates,
  extractGuestQuantity,
  staffRequestedPayToBook,
  expandCatalogOfferingForWrite,
  extractEmailPayToBookIntent,
  resolveAuthoritativePayToBookAmount,
  bindEmailPayToBookIdentities,
  buildEmailPayToBookIdempotencyKey,
  renderEmailPayToBookDraft,
  isExactStaffPaymentUrl,
  rejectCallerMoney,
  placeEmailPayToBookHoldAndPaymentLink,
  tryEmailPayToBookForCreateDraft,
  decideStripeHoldPromote,
  isHoldDueForExpiry,
});
