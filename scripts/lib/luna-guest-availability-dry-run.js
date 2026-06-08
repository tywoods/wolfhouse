'use strict';

/**
 * Stage 27f — Guest availability dry-run adapter.
 *
 * Gates on Stage 27e router readiness, then delegates bed availability to
 * runAvailabilityCheckDryRun (same engine as POST /staff/bot/availability-check).
 *
 * No booking writes, holds, quotes, payment drafts, Stripe, WhatsApp, Meta, or n8n.
 */

const {
  runAvailabilityCheckDryRun,
  DRY_RUN_ANCHOR_ROUTES,
} = require('./luna-guest-booking-dry-run');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const AVAILABILITY_SAFETY = Object.freeze({
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

const VALID_AVAILABILITY_STATUSES = new Set([
  'not_ready',
  'available',
  'unavailable',
  'needs_staff_review',
  'error',
]);

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    available: 'Thanks — I found a possible option for your dates. Our team can help with the next step. I am not confirming the booking yet.',
    unavailable: 'Thanks for your dates — I could not find enough beds free for that stay. I am passing this to our team so they can confirm options with you.',
    needs_review: 'Thanks — I need our team to double-check availability for your dates before the next step. Someone from Wolfhouse will follow up soon.',
    error: 'Thanks for your stay details — I hit a snag checking beds. Our team will confirm availability and follow up with you.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    available: 'Grazie — ho trovato una possibile opzione per le tue date. Il team può aiutarti con il prossimo passo. Non sto ancora confermando la prenotazione.',
    unavailable: 'Grazie per le date — non ho trovato abbastanza posti liberi per quel soggiorno. Passo al team così possono confermarti le opzioni.',
    needs_review: 'Grazie — serve al team una verifica extra sulla disponibilità per le tue date. Qualcuno di Wolfhouse ti scriverà presto.',
    error: 'Grazie per i dettagli — c’è stato un problema nel controllo letti. Il team confermerà la disponibilità e ti risponderà.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    available: 'Gracias — encontré una opción posible para tus fechas. El equipo puede ayudarte con el siguiente paso. Aún no confirmo la reserva.',
    unavailable: 'Gracias por las fechas — no encontré suficientes camas libres para esa estancia. Lo paso al equipo para que confirmen opciones contigo.',
    needs_review: 'Gracias — necesito que el equipo verifique la disponibilidad para tus fechas antes del siguiente paso. Alguien de Wolfhouse te escribirá pronto.',
    error: 'Gracias por los detalles — hubo un problema al revisar camas. El equipo confirmará disponibilidad y te responderá.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    available: 'Danke — ich habe eine mögliche Option für eure Daten gefunden. Unser Team hilft beim nächsten Schritt. Ich bestätige die Buchung noch nicht.',
    unavailable: 'Danke für die Daten — ich habe nicht genug freie Betten für den Aufenthalt gefunden. Ich gebe das an unser Team weiter.',
    needs_review: 'Danke — unser Team muss die Verfügbarkeit für eure Daten noch prüfen. Jemand von Wolfhouse meldet sich bald.',
    error: 'Danke für die Details — beim Betten-Check ist etwas schiefgelaufen. Das Team bestätigt die Verfügbarkeit und meldet sich.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    available: 'Merci — j’ai trouvé une option possible pour vos dates. L’équipe peut vous aider pour la suite. Je ne confirme pas encore la réservation.',
    unavailable: 'Merci pour vos dates — je n’ai pas assez de lits libres pour ce séjour. Je transmets à l’équipe pour qu’ils confirment les options.',
    needs_review: 'Merci — l’équipe doit vérifier la disponibilité pour vos dates avant la suite. Quelqu’un de Wolfhouse vous répondra bientôt.',
    error: 'Merci pour les détails — un souci est survenu lors du contrôle des lits. L’équipe confirmera la disponibilité et vous répondra.',
  },
};

function tpl(lang, key) {
  const L = REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
  return L[key] || REPLY_TEMPLATES.en[key] || '';
}

function shouldAttemptGuestAvailability(routerResult) {
  if (!routerResult || routerResult.success === false) return false;
  return routerResult.message_lane === 'new_booking_inquiry'
    && routerResult.booking_intake_ready === true
    && routerResult.readiness_state === 'ready_for_availability_check';
}

function mapRouterFieldsToAvailabilityInput(routerResult, context) {
  const ctx = context || {};
  const extracted = (routerResult && routerResult.extracted_fields) || {};
  const packageInterest = extracted.package_interest != null
    ? String(extracted.package_interest).trim().toLowerCase()
    : null;

  return {
    client_slug: String(ctx.client_slug || DEFAULT_CLIENT).trim(),
    check_in: extracted.check_in || null,
    check_out: extracted.check_out || null,
    guest_count: extracted.guest_count != null ? Number(extracted.guest_count) : null,
    package_code: packageInterest,
    room_type: String(extracted.room_type || ctx.room_type || 'shared').trim().toLowerCase(),
  };
}

function buildAvailabilitySummary(status, availResult, fields) {
  if (status === 'not_ready') {
    return 'Availability check skipped — booking intake not ready.';
  }
  if (status === 'error') {
    return availResult && availResult.error
      ? `Availability check error: ${availResult.error}`
      : 'Availability check failed.';
  }
  if (status === 'needs_staff_review') {
    return availResult && availResult.reason
      ? `Availability check skipped: ${availResult.reason}`
      : 'Availability check requires staff review.';
  }
  const nights = fields.check_in && fields.check_out
    ? `${fields.check_in} to ${fields.check_out}`
    : 'requested dates';
  if (status === 'available') {
    const beds = availResult && availResult.selected_bed_codes
      ? availResult.selected_bed_codes.join(', ')
      : 'beds';
    return `Possible beds found for ${nights} (${fields.guest_count} guest(s)): ${beds}.`;
  }
  return `Not enough beds for ${nights} (${fields.guest_count} guest(s)).`;
}

function buildAvailabilityReply(lang, status) {
  const intro = `${tpl(lang, 'intro')} 🌊`;
  let body;
  if (status === 'available') body = tpl(lang, 'available');
  else if (status === 'unavailable') body = tpl(lang, 'unavailable');
  else if (status === 'error') body = tpl(lang, 'error');
  else body = tpl(lang, 'needs_review');
  return `${intro} — ${body}`;
}

function resolveAvailabilityOutcome(availResult) {
  if (!availResult || availResult.skipped) {
    const reason = availResult && availResult.reason;
    if (reason === 'missing_dates_or_guest_count' || reason === 'invalid_date_range') {
      return {
        status: 'not_ready',
        handoff: false,
        reasons: [reason],
      };
    }
    return {
      status: 'needs_staff_review',
      handoff: true,
      reasons: [reason || 'availability_skipped'],
    };
  }
  if (availResult.has_enough_beds) {
    return {
      status: 'available',
      handoff: false,
      reasons: [],
    };
  }
  return {
    status: 'unavailable',
    handoff: true,
    reasons: availResult.blockers && availResult.blockers.length
      ? [...availResult.blockers]
      : ['not_enough_available_beds'],
  };
}

function buildGuestAvailabilitySkippedResponse(routerResult) {
  const lang = (routerResult && routerResult.detected_language) || 'en';
  return {
    success: true,
    ...AVAILABILITY_SAFETY,
    availability_check_attempted: false,
    availability_status: 'not_ready',
    availability_result_summary: buildAvailabilitySummary('not_ready'),
    availability_handoff_required: !!routerResult?.safe_handoff_required,
    availability_handoff_reasons: routerResult?.safe_handoff_required
      ? [...(routerResult.handoff_reasons || [])]
      : ['booking_intake_not_ready'],
    proposed_luna_reply: routerResult?.proposed_luna_reply || `${tpl(lang, 'intro')} 🌊`,
    reused_helper: 'runAvailabilityCheckDryRun',
    anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
    availability_detail: null,
  };
}

/**
 * Stage 27f guest availability dry-run adapter.
 *
 * @param {object} routerResult - output from runLunaGuestMessageRouterDryRun
 * @param {object} [context] - { pg?, client_slug?, room_type? }
 */
async function runGuestAvailabilityDryRun(routerResult, context) {
  const ctx = context || {};
  const lang = (routerResult && routerResult.detected_language) || 'en';

  if (!shouldAttemptGuestAvailability(routerResult)) {
    return buildGuestAvailabilitySkippedResponse(routerResult);
  }

  const fields = mapRouterFieldsToAvailabilityInput(routerResult, ctx);
  let availResult;
  try {
    availResult = await runAvailabilityCheckDryRun(fields, ctx.pg || null);
  } catch (err) {
    return {
      success: true,
      ...AVAILABILITY_SAFETY,
      availability_check_attempted: true,
      availability_status: 'error',
      availability_result_summary: buildAvailabilitySummary('error', { error: err.message }),
      availability_handoff_required: true,
      availability_handoff_reasons: ['availability_check_error'],
      proposed_luna_reply: buildAvailabilityReply(lang, 'error'),
      reused_helper: 'runAvailabilityCheckDryRun',
      anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
      availability_detail: { error: err.message },
    };
  }

  const outcome = resolveAvailabilityOutcome(availResult);
  return {
    success: true,
    ...AVAILABILITY_SAFETY,
    availability_check_attempted: true,
    availability_status: outcome.status,
    availability_result_summary: buildAvailabilitySummary(outcome.status, availResult, fields),
    availability_handoff_required: outcome.handoff,
    availability_handoff_reasons: outcome.reasons,
    proposed_luna_reply: buildAvailabilityReply(lang, outcome.status),
    reused_helper: 'runAvailabilityCheckDryRun',
    anchor_route: DRY_RUN_ANCHOR_ROUTES.availability,
    availability_detail: availResult,
  };
}

module.exports = {
  runGuestAvailabilityDryRun,
  shouldAttemptGuestAvailability,
  buildGuestAvailabilitySkippedResponse,
  mapRouterFieldsToAvailabilityInput,
  VALID_AVAILABILITY_STATUSES,
  AVAILABILITY_SAFETY,
  REPLY_TEMPLATES,
};
