'use strict';

/**
 * Stage 27m — Guest hold + payment draft planner (dry-run, no writes).
 *
 * Takes the completed Stage 27 chain and produces a structured plan for
 * booking/hold + quote snapshot + payment draft — without DB or API writes.
 */

const crypto = require('crypto');

const PLANNER_SAFETY = Object.freeze({
  dry_run: true,
  preview_only: true,
  no_write_performed: true,
  live_send_blocked: true,
  sends_whatsapp: false,
  whatsapp_sent: false,
  calls_n8n: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  payment_link_sent: false,
  creates_hold: false,
});

const VALID_PLAN_STATUSES = Object.freeze([
  'not_ready',
  'ready',
  'needs_staff_review',
  'error',
]);

const VALID_PAYMENT_KINDS = Object.freeze([
  'deposit',
  'full_payment',
]);

const HOLD_EXPIRES_IN_HOURS = 6;

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    ready: 'Thanks — the next step would be preparing your secure payment. I am not confirming the booking, creating a hold, or sending a payment link yet.',
    not_ready: 'Thanks for your message — I still need a confirmed quote and payment choice before I can plan the next booking step.',
    handoff: 'Thanks — I am handing this to our team so they can confirm the details before the next payment step.',
    error: 'Thanks — something did not line up with the quote or payment plan. Our team will help with the next step.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    ready: 'Grazie — il prossimo passo sarebbe preparare il pagamento sicuro. Non sto confermando la prenotazione né inviando un link.',
    not_ready: 'Grazie — serve un preventivo e una scelta di pagamento confermati prima del prossimo passo.',
    handoff: 'Grazie — passo al team per confermare i dettagli prima del pagamento.',
    error: 'Grazie — qualcosa non coincide con preventivo o pagamento. Il team aiuterà.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    ready: 'Gracias — el siguiente paso sería preparar tu pago seguro. No confirmo la reserva ni envío un enlace todavía.',
    not_ready: 'Gracias — necesito presupuesto y elección de pago confirmados antes del siguiente paso.',
    handoff: 'Gracias — paso esto al equipo para confirmar los detalles antes del pago.',
    error: 'Gracias — algo no cuadra con el presupuesto o el pago. El equipo ayudará.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    ready: 'Danke — der nächste Schritt wäre die sichere Zahlung vorzubereiten. Ich bestätige die Buchung nicht und sende noch keinen Link.',
    not_ready: 'Danke — ich brauche ein bestätigtes Angebot und Zahlungswahl vor dem nächsten Schritt.',
    handoff: 'Danke — ich gebe das an unser Team weiter, damit die Details vor der Zahlung bestätigt werden.',
    error: 'Danke — etwas passt nicht zum Angebot oder Zahlungsplan. Das Team hilft weiter.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    ready: 'Merci — la prochaine étape serait de préparer votre paiement sécurisé. Je ne confirme pas la réservation et n\'envoie pas encore de lien.',
    not_ready: 'Merci — il me faut un devis et un choix de paiement confirmés avant la suite.',
    handoff: 'Merci — je transmets à l\'équipe pour confirmer les détails avant le paiement.',
    error: 'Merci — quelque chose ne correspond pas au devis ou au plan de paiement. L\'équipe vous aidera.',
  },
};

function tpl(lang) {
  return REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
}

function buildReply(lang, key) {
  const L = tpl(lang);
  return `${L.intro} 🌊 — ${L[key]}`;
}

function resolveLang(chainResult) {
  const result = chainResult && chainResult.result;
  return (result && result.detected_language) || 'en';
}

function normalizeChain(chainResult) {
  const c = chainResult || {};
  return {
    result: c.result || c,
    availability: c.availability || {},
    quote: c.quote || {},
    payment_choice: c.payment_choice || {},
  };
}

/**
 * Stage 27m entry gate — all chain gates must pass.
 */
function shouldAttemptGuestHoldPaymentDraftPlan(chainResult) {
  const { result, availability, quote, payment_choice: pc } = normalizeChain(chainResult);
  if (!result || result.success === false) return false;
  return result.message_lane === 'new_booking_inquiry'
    && result.booking_intake_ready === true
    && result.readiness_state === 'ready_for_availability_check'
    && availability.availability_status === 'available'
    && quote.quote_status === 'ready'
    && pc.payment_choice_ready === true
    && pc.next_safe_step === 'ready_for_hold_payment_draft';
}

function mapPackageCode(fields) {
  const p = fields.package_interest || fields.package_code || '';
  if (p === 'accommodation_only' || p === 'custom') return 'no_package';
  return String(p || 'no_package').trim().toLowerCase();
}

function validateIntakeFields(result) {
  const fields = (result && result.extracted_fields) || {};
  const missing = [];
  if (!fields.check_in) missing.push('check_in');
  if (!fields.check_out) missing.push('check_out');
  if (fields.guest_count == null || Number(fields.guest_count) < 1) missing.push('guest_count');
  const pkg = mapPackageCode(fields);
  if (!pkg) missing.push('package_interest');
  return { fields, missing, package_code: pkg };
}

function detectTransferAmbiguity(fields) {
  const ti = fields.transfer_interest;
  if (!ti || !ti.interested) return null;
  if (!ti.airport_code && !ti.direction) {
    return 'transfer_exception';
  }
  return null;
}

function detectServiceAmbiguity(fields) {
  const services = fields.service_interest;
  if (!Array.isArray(services) || services.length === 0) return null;
  const bad = services.some((s) => !s || !s.code);
  if (bad) return 'unclear_service_line_items';
  return null;
}

function resolvePaymentAmount(quote, paymentChoice) {
  const choice = paymentChoice && paymentChoice.payment_choice;
  const total = quote.quote_total_cents;
  if (total == null || total < 0) {
    return { error: 'missing_quote_total' };
  }
  if (choice === 'full_payment') {
    return {
      payment_kind: 'full_payment',
      payment_amount_cents: total,
      balance_due_after_payment_cents: 0,
    };
  }
  if (choice === 'deposit') {
    const depositOpts = quote.deposit_options || {};
    const depositCents = depositOpts.deposit_required_cents;
    if (depositCents == null || depositCents <= 0) {
      return { error: 'payment_amount_undetermined' };
    }
    return {
      payment_kind: 'deposit',
      payment_amount_cents: depositCents,
      balance_due_after_payment_cents: Math.max(0, total - depositCents),
    };
  }
  return { error: 'missing_or_unclear_payment_choice' };
}

function buildIdempotencyKeyPreview(context, fields, paymentKind, clientSlug) {
  const ctx = context || {};
  const parts = [
    'guest-hold-payment-draft',
    clientSlug || ctx.client_slug || 'wolfhouse-somo',
    fields.check_in || '',
    fields.check_out || '',
    String(fields.guest_count ?? ''),
    mapPackageCode(fields),
    paymentKind || '',
    ctx.guest_phone || fields.guest_phone || fields.phone || '',
    ctx.conversation_id || ctx.thread_id || '',
  ];
  const raw = parts.join('|');
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

function buildPlannedRecords(fields, quote, payment, context) {
  const roomType = fields.room_type || fields.requested_room_type || 'shared';
  const records = {
    booking_hold: {
      check_in: fields.check_in,
      check_out: fields.check_out,
      guest_count: fields.guest_count,
      package_code: mapPackageCode(fields),
      room_type: roomType,
      hold_expires_in_hours: HOLD_EXPIRES_IN_HOURS,
      client_slug: (context && context.client_slug) || 'wolfhouse-somo',
    },
    quote_snapshot: {
      quote_total_cents: quote.quote_total_cents,
      deposit_options: quote.deposit_options || null,
      quote_status: quote.quote_status,
      source: 'calculateWolfhouseQuote',
    },
    payment_draft: {
      payment_kind: payment.payment_kind,
      payment_amount_cents: payment.payment_amount_cents,
      balance_due_after_payment_cents: payment.balance_due_after_payment_cents,
      status: 'draft_planned',
      is_payment_truth: false,
    },
  };

  const services = fields.service_interest;
  if (Array.isArray(services) && services.length > 0) {
    records.service_lines = services
      .filter((s) => s && s.code)
      .map((s) => ({
        code: String(s.code),
        days: s.days,
        quantity: s.quantity,
      }));
  }

  const transfer = fields.transfer_interest;
  if (transfer && transfer.interested) {
    records.transfer_lines = [{
      airport_code: transfer.airport_code || null,
      direction: transfer.direction || null,
      flight_number: transfer.flight_number || null,
      pricing_status: 'deferred_to_staff',
    }];
  }

  return records;
}

function buildGuestHoldPaymentDraftPlannerSkippedResponse(chainResult, reasons) {
  const lang = resolveLang(chainResult);
  const r = reasons && reasons.length ? reasons : ['plan_gate_not_met'];
  return {
    success: true,
    ...PLANNER_SAFETY,
    hold_payment_draft_plan_attempted: false,
    plan_status: 'not_ready',
    would_create_hold: false,
    would_create_quote_snapshot: false,
    would_create_payment_draft: false,
    would_create_stripe_link: false,
    hold_expires_in_hours: null,
    payment_amount_cents: null,
    payment_kind: null,
    balance_due_after_payment_cents: null,
    idempotency_key_preview: null,
    planned_records: null,
    plan_handoff_required: false,
    plan_handoff_reasons: r,
    proposed_luna_reply: buildReply(lang, 'not_ready'),
  };
}

/**
 * Stage 27m hold + payment draft planner dry-run.
 *
 * @param {object} chainResult - { result, availability, quote, payment_choice }
 * @param {object} [context] - { client_slug?, guest_phone?, conversation_id? }
 */
function runGuestHoldPaymentDraftPlannerDryRun(chainResult, context) {
  const chain = normalizeChain(chainResult);
  const lang = resolveLang(chainResult);
  const ctx = context || {};

  if (!shouldAttemptGuestHoldPaymentDraftPlan(chainResult)) {
    const reasons = [];
    const { result, availability, quote, payment_choice: pc } = chain;
    if (!result || result.message_lane !== 'new_booking_inquiry') reasons.push('wrong_message_lane');
    if (!result || !result.booking_intake_ready) reasons.push('booking_intake_not_ready');
    if (!result || result.readiness_state !== 'ready_for_availability_check') {
      reasons.push('readiness_not_ready_for_availability');
    }
    if (availability.availability_status !== 'available') reasons.push('availability_not_available');
    if (quote.quote_status !== 'ready') reasons.push('quote_not_ready');
    if (!pc.payment_choice_ready) reasons.push('payment_choice_not_ready');
    if (pc.next_safe_step !== 'ready_for_hold_payment_draft') {
      reasons.push('next_safe_step_not_ready_for_hold_payment_draft');
    }
    if (reasons.length === 0) reasons.push('plan_gate_not_met');
    return buildGuestHoldPaymentDraftPlannerSkippedResponse(chainResult, reasons);
  }

  const { result, quote, payment_choice: pc } = chain;
  const { fields, missing } = validateIntakeFields(result);
  const handoffReasons = [];

  if (missing.length > 0) {
    handoffReasons.push('missing_required_intake_fields', ...missing.map((f) => `missing_${f}`));
  }

  const transferIssue = detectTransferAmbiguity(fields);
  if (transferIssue) handoffReasons.push(transferIssue);

  const serviceIssue = detectServiceAmbiguity(fields);
  if (serviceIssue) handoffReasons.push(serviceIssue);

  if (quote.quote_handoff_required === true) {
    const qr = quote.quote_handoff_reasons || [];
    if (qr.some((r) => /transfer/i.test(String(r)))) {
      handoffReasons.push('transfer_pricing_deferred');
    }
  }

  const payment = resolvePaymentAmount(quote, pc);
  if (payment.error) {
    handoffReasons.push(payment.error);
  }

  if (handoffReasons.length > 0) {
    const needsReview = handoffReasons.some((r) => r.includes('transfer')
      || r.includes('service')
      || r === 'transfer_exception'
      || r === 'unclear_service_line_items'
      || r === 'transfer_pricing_deferred');
    return {
      success: true,
      ...PLANNER_SAFETY,
      hold_payment_draft_plan_attempted: true,
      plan_status: needsReview ? 'needs_staff_review' : 'error',
      would_create_hold: false,
      would_create_quote_snapshot: false,
      would_create_payment_draft: false,
      would_create_stripe_link: false,
      hold_expires_in_hours: null,
      payment_amount_cents: payment.payment_amount_cents ?? null,
      payment_kind: payment.payment_kind ?? null,
      balance_due_after_payment_cents: payment.balance_due_after_payment_cents ?? null,
      idempotency_key_preview: null,
      planned_records: null,
      plan_handoff_required: true,
      plan_handoff_reasons: [...new Set(handoffReasons)],
      proposed_luna_reply: buildReply(lang, needsReview ? 'handoff' : 'error'),
    };
  }

  const clientSlug = ctx.client_slug || 'wolfhouse-somo';
  const idempotencyKey = buildIdempotencyKeyPreview(ctx, fields, payment.payment_kind, clientSlug);
  const plannedRecords = buildPlannedRecords(fields, quote, payment, ctx);

  return {
    success: true,
    ...PLANNER_SAFETY,
    hold_payment_draft_plan_attempted: true,
    plan_status: 'ready',
    would_create_hold: true,
    would_create_quote_snapshot: true,
    would_create_payment_draft: true,
    would_create_stripe_link: false,
    hold_expires_in_hours: HOLD_EXPIRES_IN_HOURS,
    payment_amount_cents: payment.payment_amount_cents,
    payment_kind: payment.payment_kind,
    balance_due_after_payment_cents: payment.balance_due_after_payment_cents,
    idempotency_key_preview: idempotencyKey,
    planned_records: plannedRecords,
    plan_handoff_required: false,
    plan_handoff_reasons: [],
    proposed_luna_reply: buildReply(lang, 'ready'),
  };
}

module.exports = {
  runGuestHoldPaymentDraftPlannerDryRun,
  shouldAttemptGuestHoldPaymentDraftPlan,
  buildGuestHoldPaymentDraftPlannerSkippedResponse,
  buildIdempotencyKeyPreview,
  resolvePaymentAmount,
  VALID_PLAN_STATUSES,
  VALID_PAYMENT_KINDS,
  HOLD_EXPIRES_IN_HOURS,
  PLANNER_SAFETY,
};
