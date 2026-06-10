'use strict';

/**
 * Stage 27h — Guest quote proposal dry-run adapter.
 *
 * Gates on Stage 27e readiness + Stage 27f availability, then delegates pricing to
 * runBookingPreviewDryRun → shared wolfhouse quote engine (same as
 * POST /staff/bot/booking-preview).
 *
 * No booking writes, holds, payment drafts, Stripe links, WhatsApp, Meta, or n8n.
 */

const {
  runBookingPreviewDryRun,
  DRY_RUN_ANCHOR_ROUTES,
} = require('./luna-guest-booking-dry-run');
const {
  isWeeklySurfPackage,
  computeStayNights,
  WEEKLY_PACKAGE_MIN_NIGHTS,
} = require('./wolfhouse-package-night-rules');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const QUOTE_SAFETY = Object.freeze({
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
});

const VALID_QUOTE_STATUSES = new Set([
  'not_ready',
  'ready',
  'needs_staff_review',
  'error',
]);

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    ready: (totalEur, depositEur) => `Thanks — for your stay I estimate a total of €${totalEur}. Would you prefer to pay a €${depositEur} deposit or the full amount? I am not confirming or holding the booking yet and I cannot send a payment link yet.`,
    needs_review: 'Thanks — I need our team to confirm pricing details for your stay before the next step. Someone from Wolfhouse will follow up soon.',
    error: 'Thanks for your stay details — I hit a snag preparing a quote. Our team will confirm pricing and follow up with you.',
    not_ready: 'Thanks for your message — I still need a few details before I can prepare a quote.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    ready: (totalEur, depositEur) => `Grazie — per il soggiorno stimo un totale di €${totalEur}. Preferisci pagare un deposito di €${depositEur} o l'importo intero? Non sto confermando la prenotazione e non posso ancora inviare un link di pagamento.`,
    needs_review: 'Grazie — serve al team una conferma sui prezzi prima del prossimo passo. Qualcuno di Wolfhouse ti scriverà presto.',
    error: 'Grazie per i dettagli — c’è stato un problema nel preventivo. Il team confermerà i prezzi e ti risponderà.',
    not_ready: 'Grazie per il messaggio — mi servono ancora alcuni dettagli prima del preventivo.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    ready: (totalEur, depositEur) => `Gracias — para tu estancia estimo un total de €${totalEur}. ¿Prefieres pagar un depósito de €${depositEur} o el importe completo? No confirmo la reserva y aún no puedo enviar un enlace de pago.`,
    needs_review: 'Gracias — necesito que el equipo confirme el precio antes del siguiente paso. Alguien de Wolfhouse te escribirá pronto.',
    error: 'Gracias por los detalles — hubo un problema al preparar el presupuesto. El equipo confirmará precios y te responderá.',
    not_ready: 'Gracias por tu mensaje — aún necesito algunos detalles antes del presupuesto.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    ready: (totalEur, depositEur) => `Danke — für euren Aufenthalt schätze ich insgesamt €${totalEur}. Möchtet ihr eine Anzahlung von €${depositEur} oder den vollen Betrag zahlen? Ich bestätige die Buchung nicht und kann noch keinen Zahlungslink senden.`,
    needs_review: 'Danke — unser Team muss die Preise für euren Aufenthalt bestätigen. Jemand von Wolfhouse meldet sich bald.',
    error: 'Danke für die Details — beim Angebot ist etwas schiefgelaufen. Das Team klärt die Preise und meldet sich.',
    not_ready: 'Danke für eure Nachricht — mir fehlen noch ein paar Details für ein Angebot.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    ready: (totalEur, depositEur) => `Merci — pour votre séjour j’estime un total de €${totalEur}. Préférez-vous payer un acompte de €${depositEur} ou le montant complet ? Je ne confirme pas la réservation et je ne peux pas encore envoyer de lien de paiement.`,
    needs_review: 'Merci — l’équipe doit confirmer le tarif avant la suite. Quelqu’un de Wolfhouse vous répondra bientôt.',
    error: 'Merci pour les détails — un souci est survenu pour le devis. L’équipe confirmera les prix et vous répondra.',
    not_ready: 'Merci pour votre message — il me manque encore quelques détails avant un devis.',
  },
};

function tpl(lang) {
  return REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
}

function shouldAttemptGuestQuoteProposal(routerResult, availabilityResult) {
  if (!routerResult || routerResult.success === false) return false;
  if (!availabilityResult) return false;
  const nights = computeStayNights(
    routerResult.extracted_fields && routerResult.extracted_fields.check_in,
    routerResult.extracted_fields && routerResult.extracted_fields.check_out,
  );
  const pkg = routerResult.extracted_fields && routerResult.extracted_fields.package_interest;
  if (nights != null && isWeeklySurfPackage(pkg) && nights < WEEKLY_PACKAGE_MIN_NIGHTS) {
    return false;
  }
  return routerResult.message_lane === 'new_booking_inquiry'
    && routerResult.booking_intake_ready === true
    && routerResult.readiness_state === 'ready_for_availability_check'
    && availabilityResult.availability_check_attempted === true
    && availabilityResult.availability_status === 'available';
}

function mapPackageInterest(packageInterest) {
  const p = String(packageInterest || '').trim().toLowerCase();
  if (p === 'accommodation_only' || p === 'custom') return 'no_package';
  return p || null;
}

function normalizeAddOns(serviceInterest) {
  if (!Array.isArray(serviceInterest)) return [];
  return serviceInterest
    .filter((item) => item && typeof item === 'object' && item.code)
    .map((item) => ({
      code: String(item.code).trim(),
      days: item.days != null ? Number(item.days) : undefined,
      quantity: item.quantity != null ? Number(item.quantity) : undefined,
    }));
}

function mapRouterToQuoteFields(routerResult, context) {
  const ctx = context || {};
  const extracted = (routerResult && routerResult.extracted_fields) || {};
  return {
    client_slug: String(ctx.client_slug || DEFAULT_CLIENT).trim(),
    check_in: extracted.check_in || null,
    check_out: extracted.check_out || null,
    guest_count: extracted.guest_count != null ? Number(extracted.guest_count) : null,
    package_code: mapPackageInterest(extracted.package_interest),
    room_type: String(extracted.room_type || ctx.room_type || 'shared').trim(),
    payment_choice: 'deposit',
    add_ons: normalizeAddOns(extracted.service_interest),
    transfer_interest: extracted.transfer_interest || null,
  };
}

function buildDepositOptions(quote) {
  if (!quote || !quote.success) return null;
  const depositCents = quote.deposit_required_cents || 0;
  const isWeekly = quote.nights === 7;
  return {
    deposit_required_cents: depositCents,
    weekly_package_deposit_cents: isWeekly ? depositCents : 20000,
    custom_short_stay_deposit_cents: isWeekly ? 10000 : depositCents,
    payment_options: Array.isArray(quote.payment_options) ? quote.payment_options : ['deposit', 'full'],
  };
}

function buildQuoteSummary(status, preview, fields) {
  if (status === 'not_ready') {
    return 'Quote proposal skipped — intake or availability not ready.';
  }
  if (status === 'error') {
    return preview && preview.quote_error
      ? `Quote error: ${preview.quote_error}`
      : 'Quote calculation failed.';
  }
  if (status === 'needs_staff_review') {
    const blockers = preview && preview.quote && preview.quote.blockers;
    if (blockers && blockers.length) return `Quote needs staff review: ${blockers.join('; ')}`;
    if (fields.transfer_interest && fields.transfer_interest.interested) {
      return 'Quote needs staff review: transfer pricing not included in automated quote.';
    }
    return 'Quote needs staff review.';
  }
  const q = preview && preview.quote;
  if (!q) return 'Quote ready.';
  const totalEur = (q.total_cents / 100).toFixed(2);
  const depositEur = (q.deposit_required_cents / 100).toFixed(2);
  let summary = `Estimated total €${totalEur}; deposit option €${depositEur} (${q.nights === 7 ? 'weekly package tier' : 'custom/shorter stay tier'}).`;
  if (fields.transfer_interest && fields.transfer_interest.interested) {
    summary += ' Transfer interest noted — team to confirm transfer price separately.';
  }
  return summary;
}

function buildQuoteReply(lang, status, preview) {
  const L = tpl(lang);
  const intro = `${L.intro} 🌊`;
  if (status === 'ready' && preview && preview.quote) {
    const totalEur = (preview.quote.total_cents / 100).toFixed(2);
    const depositEur = (preview.quote.deposit_required_cents / 100).toFixed(2);
    return `${intro} — ${L.ready(totalEur, depositEur)}`;
  }
  if (status === 'error') return `${intro} — ${L.error}`;
  if (status === 'needs_staff_review') return `${intro} — ${L.needs_review}`;
  return `${intro} — ${L.not_ready}`;
}

function resolveQuoteOutcome(preview, fields) {
  if (preview.quote_error) {
    return {
      status: 'error',
      handoff: true,
      reasons: ['quote_calculation_error'],
    };
  }
  const quote = preview.quote;
  if (!quote || !quote.success) {
    return {
      status: 'needs_staff_review',
      handoff: true,
      reasons: (quote && quote.blockers && quote.blockers.length)
        ? quote.blockers.slice(0, 3)
        : ['quote_not_available'],
    };
  }
  if (quote.staff_review_required) {
    return {
      status: 'needs_staff_review',
      handoff: true,
      reasons: quote.warnings && quote.warnings.length
        ? quote.warnings.slice(0, 3)
        : ['staff_review_required'],
    };
  }
  if (fields.transfer_interest && fields.transfer_interest.interested) {
    return {
      status: 'ready',
      handoff: false,
      reasons: ['transfer_pricing_deferred_to_staff'],
    };
  }
  return {
    status: 'ready',
    handoff: false,
    reasons: [],
  };
}

function buildGuestQuoteSkippedResponse(routerResult, availabilityResult) {
  const lang = (routerResult && routerResult.detected_language) || 'en';
  const L = tpl(lang);
  const fallbackReply = (availabilityResult && availabilityResult.proposed_luna_reply)
    || (routerResult && routerResult.proposed_luna_reply)
    || `${L.intro} 🌊 — ${L.not_ready}`;
  const reasons = [];
  if (!availabilityResult || availabilityResult.availability_status !== 'available') {
    reasons.push('availability_not_available');
  }
  if (!routerResult || !routerResult.booking_intake_ready) {
    reasons.push('booking_intake_not_ready');
  }
  if (reasons.length === 0) reasons.push('quote_gate_not_met');

  return {
    success: true,
    ...QUOTE_SAFETY,
    quote_proposal_attempted: false,
    quote_status: 'not_ready',
    quote_result_summary: buildQuoteSummary('not_ready'),
    quote_total_cents: null,
    deposit_options: null,
    payment_choice_needed: false,
    quote_handoff_required: !!routerResult?.safe_handoff_required,
    quote_handoff_reasons: reasons,
    proposed_luna_reply: fallbackReply,
    reused_helper: 'runBookingPreviewDryRun',
    anchor_route: DRY_RUN_ANCHOR_ROUTES.booking_preview,
    quote_detail: null,
  };
}

/**
 * Stage 27h guest quote proposal dry-run adapter.
 *
 * @param {object} routerResult - output from runLunaGuestMessageRouterDryRun
 * @param {object} availabilityResult - output from runGuestAvailabilityDryRun
 * @param {object} [context] - { client_slug?, room_type? }
 */
function runGuestQuoteProposalDryRun(routerResult, availabilityResult, context) {
  if (!shouldAttemptGuestQuoteProposal(routerResult, availabilityResult)) {
    return buildGuestQuoteSkippedResponse(routerResult, availabilityResult);
  }

  const fields = mapRouterToQuoteFields(routerResult, context);
  let preview;
  try {
    preview = runBookingPreviewDryRun(fields);
  } catch (err) {
    return {
      success: true,
      ...QUOTE_SAFETY,
      quote_proposal_attempted: true,
      quote_status: 'error',
      quote_result_summary: buildQuoteSummary('error', { quote_error: err.message }),
      quote_total_cents: null,
      deposit_options: null,
      payment_choice_needed: false,
      quote_handoff_required: true,
      quote_handoff_reasons: ['quote_calculation_error'],
      proposed_luna_reply: buildQuoteReply(
        routerResult.detected_language || 'en',
        'error',
        null,
      ),
      reused_helper: 'runBookingPreviewDryRun',
      anchor_route: DRY_RUN_ANCHOR_ROUTES.booking_preview,
      quote_detail: { error: err.message },
    };
  }

  const outcome = resolveQuoteOutcome(preview, fields);
  const quote = preview.quote;
  const depositOptions = outcome.status === 'ready' ? buildDepositOptions(quote) : null;

  return {
    success: true,
    ...QUOTE_SAFETY,
    quote_proposal_attempted: true,
    quote_status: outcome.status,
    quote_result_summary: buildQuoteSummary(outcome.status, preview, fields),
    quote_total_cents: quote && quote.success ? quote.total_cents : null,
    deposit_options: depositOptions,
    payment_choice_needed: outcome.status === 'ready',
    quote_handoff_required: outcome.handoff,
    quote_handoff_reasons: outcome.reasons,
    proposed_luna_reply: buildQuoteReply(
      routerResult.detected_language || 'en',
      outcome.status,
      preview,
    ),
    reused_helper: 'runBookingPreviewDryRun',
    anchor_route: DRY_RUN_ANCHOR_ROUTES.booking_preview,
    quote_detail: preview,
  };
}

module.exports = {
  runGuestQuoteProposalDryRun,
  shouldAttemptGuestQuoteProposal,
  buildGuestQuoteSkippedResponse,
  mapRouterToQuoteFields,
  VALID_QUOTE_STATUSES,
  QUOTE_SAFETY,
  REPLY_TEMPLATES,
};
