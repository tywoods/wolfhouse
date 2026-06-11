'use strict';

/**
 * Stage 27j — Guest payment choice capture dry-run adapter.
 *
 * Recognizes deposit vs full vs arrival/cash/bank questions vs link requests after
 * a quote proposal (Stage 27h/27i context in guest_context).
 *
 * No booking writes, holds, payment drafts, Stripe links, WhatsApp, Meta, or n8n.
 */

const PAYMENT_CHOICE_SAFETY = Object.freeze({
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

const VALID_PAYMENT_CHOICES = Object.freeze([
  'deposit',
  'full_payment',
  'arrival_payment_question',
  'payment_link_request',
  'unclear',
]);

const VALID_NEXT_SAFE_STEPS = Object.freeze([
  'collect_payment_choice',
  'ready_for_hold_payment_draft',
  'answer_arrival_payment_question',
  'staff_handoff_required',
  'not_ready',
]);

/** Internal terms that must never appear in guest-facing proposed_luna_reply. */
const BANNED_INTERNAL_GUEST_COPY_RES = [
  /\bconfirmed quote\b/i,
  /\bpayment choice\b/i,
  /\bpayment_choice\b/i,
  /\bquote_status\b/i,
  /\bguest_context\b/i,
  /\bintake_state\b/i,
  /\breadiness_state\b/i,
  /\bautomation gate\b/i,
  /\bnext_safe_step\b/i,
  /\bdry run\b/i,
];

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    deposit_ready: 'Thanks — I noted you would like to pay the deposit. I am not confirming the booking, creating a hold, or sending a payment link yet.',
    full_ready: 'Thanks — I noted you would like to pay the full amount. I am not confirming the booking, creating a hold, or sending a payment link yet.',
    arrival: 'The remaining balance can be paid by cash, bank transfer, or pay online on arrival or at check-in. For the booking step now, would you prefer the deposit or the full amount?',
    link_request: 'I cannot send a payment link automatically yet. Would you prefer to pay the deposit or the full amount? I am not confirming the booking yet.',
    unclear: 'Thanks! Would you prefer to pay the deposit or the full amount for your stay?',
    not_ready_deposit: 'Perfect, deposit is fine 😊 First I just need to confirm the stay details so I can check the right option for you.',
    not_ready_general: 'Perfect 😊 I can help with that. First I’ll just confirm the stay details so I can check the right option for you.',
    ask_dates: 'What dates would you like to stay?',
    ask_guests: 'How many guests will be staying?',
    ask_package: 'Would you like one of our surf packages, or accommodation only?',
    non_booking: 'For payment or balance questions I need your booking code — our team will confirm the right next step.',
    staff_handoff: 'Thanks — I am handing this to our team so they can help with the next payment step.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    deposit_ready: 'Grazie — ho annotato che preferisci il deposito. Non sto confermando la prenotazione né inviando un link di pagamento.',
    full_ready: 'Grazie — ho annotato che preferisci pagare l\'importo intero. Non sto confermando la prenotazione né inviando un link.',
    arrival: 'Il saldo restante si può pagare in contanti, bonifico o pagamento online all\'arrivo o al check-in. Per ora preferisci il deposito o l\'importo intero?',
    link_request: 'Non posso inviare un link di pagamento automaticamente. Preferisci il deposito o l\'importo intero?',
    unclear: 'Grazie! Preferisci pagare il deposito o l\'importo intero?',
    not_ready_deposit: 'Perfetto, il deposito va bene 😊 Prima devo solo confermare i dettagli del soggiorno per verificare l\'opzione giusta per te.',
    not_ready_general: 'Perfetto 😊 Posso aiutarti. Prima confermo i dettagli del soggiorno per verificare l\'opzione giusta.',
    ask_dates: 'Quali date vorresti soggiornare?',
    ask_guests: 'Quanti ospiti sarete?',
    ask_package: 'Preferisci uno dei nostri pacchetti surf o solo alloggio?',
    non_booking: 'Per pagamenti o saldo mi serve il codice prenotazione — il team confermerà i prossimi passi.',
    staff_handoff: 'Grazie — passo al team per il prossimo passo di pagamento.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    deposit_ready: 'Gracias — anoté que prefieres el depósito. No confirmo la reserva ni envío un enlace de pago todavía.',
    full_ready: 'Gracias — anoté que prefieres pagar el importe completo. No confirmo la reserva ni envío un enlace todavía.',
    arrival: 'El saldo restante se puede pagar en efectivo, transferencia o pago online a la llegada o en el check-in. ¿Prefieres el depósito o el importe completo ahora?',
    link_request: 'No puedo enviar un enlace de pago automáticamente. ¿Prefieres el depósito o el importe completo?',
    unclear: '¡Gracias! ¿Prefieres pagar el depósito o el importe completo?',
    not_ready_deposit: 'Perfecto, el depósito está bien 😊 Primero solo necesito confirmar los detalles de la estancia para revisar la opción adecuada.',
    not_ready_general: 'Perfecto 😊 Puedo ayudarte. Primero confirmaré los detalles de la estancia para revisar la opción adecuada.',
    ask_dates: '¿Qué fechas te gustaría quedarte?',
    ask_guests: '¿Cuántos huéspedes serán?',
    ask_package: '¿Te gustaría uno de nuestros paquetes de surf o solo alojamiento?',
    non_booking: 'Para pagos o saldo necesito tu código de reserva — el equipo confirmará el siguiente paso.',
    staff_handoff: 'Gracias — paso esto al equipo para el siguiente paso de pago.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    deposit_ready: 'Danke — ich habe notiert, dass ihr die Anzahlung wählt. Ich bestätige die Buchung nicht und sende noch keinen Zahlungslink.',
    full_ready: 'Danke — ich habe notiert, dass ihr den vollen Betrag zahlen möchtet. Ich bestätige die Buchung nicht und sende noch keinen Link.',
    arrival: 'Der Restbetrag kann bar, per Überweisung oder online bei Ankunft oder Check-in gezahlt werden. Möchtet ihr jetzt die Anzahlung oder den vollen Betrag?',
    link_request: 'Ich kann noch keinen Zahlungslink automatisch senden. Anzahlung oder voller Betrag?',
    unclear: 'Danke! Möchtet ihr die Anzahlung oder den vollen Betrag zahlen?',
    not_ready_deposit: 'Perfekt, Anzahlung ist in Ordnung 😊 Zuerst bestätige ich nur die Aufenthaltsdetails, damit ich die passende Option prüfen kann.',
    not_ready_general: 'Perfekt 😊 Ich helfe euch gern. Zuerst bestätige ich die Aufenthaltsdetails, damit ich die passende Option prüfen kann.',
    ask_dates: 'Welche Daten möchtet ihr übernachten?',
    ask_guests: 'Wie viele Gäste seid ihr?',
    ask_package: 'Möchtet ihr eines unserer Surf-Pakete oder nur Unterkunft?',
    non_booking: 'Für Zahlung oder Restbetrag brauche ich eure Buchungsnummer — das Team bestätigt die nächsten Schritte.',
    staff_handoff: 'Danke — ich gebe das an unser Team für den nächsten Zahlungsschritt weiter.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    deposit_ready: 'Merci — j\'ai noté que vous choisissez l\'acompte. Je ne confirme pas la réservation et n\'envoie pas encore de lien de paiement.',
    full_ready: 'Merci — j\'ai noté que vous choisissez le montant complet. Je ne confirme pas la réservation et n\'envoie pas encore de lien.',
    arrival: 'Le solde restant peut être réglé en espèces, virement ou paiement en ligne à l\'arrivée ou au check-in. Préférez-vous l\'acompte ou le montant complet maintenant ?',
    link_request: 'Je ne peux pas encore envoyer de lien de paiement automatiquement. Acompte ou montant complet ?',
    unclear: 'Merci ! Préférez-vous payer l\'acompte ou le montant complet ?',
    not_ready_deposit: 'Parfait, l\'acompte convient 😊 D\'abord je dois confirmer les détails du séjour pour vérifier la bonne option.',
    not_ready_general: 'Parfait 😊 Je peux vous aider. D\'abord je confirme les détails du séjour pour vérifier la bonne option.',
    ask_dates: 'Quelles dates souhaitez-vous séjourner ?',
    ask_guests: 'Combien de personnes serez-vous ?',
    ask_package: 'Souhaitez-vous l\'un de nos forfaits surf ou l\'hébergement seul ?',
    non_booking: 'Pour le paiement ou le solde, j\'ai besoin de votre code de réservation — l\'équipe confirmera la suite.',
    staff_handoff: 'Merci — je transmets à l\'équipe pour la prochaine étape de paiement.',
  },
};

function tpl(lang) {
  return REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
}

function normalizeText(messageText) {
  return String(messageText || '').trim().toLowerCase();
}

function quoteContextReady(guestContext, messageText) {
  const ctx = guestContext || {};
  const quote = ctx.quote || {};
  const paymentChoiceNeeded = quote.payment_choice_needed === true
    || ctx.payment_choice_needed === true;
  const quoteStatus = quote.quote_status || ctx.quote_status;
  const lane = ctx.message_lane || (ctx.result && ctx.result.message_lane);
  const bookingPaymentLane = lane === 'new_booking_inquiry' || lane === 'payment_question';
  if (quoteStatus === 'ready' && messageText) {
    const sideQ = detectPaymentChoiceFromMessage(messageText);
    if (sideQ === 'arrival_payment_question' || sideQ === 'payment_link_request') {
      return true;
    }
  }
  return bookingPaymentLane
    && paymentChoiceNeeded
    && quoteStatus === 'ready';
}

function shouldAttemptGuestPaymentChoiceCapture(guestContext, messageText) {
  return quoteContextReady(guestContext, messageText);
}

/**
 * Stage 27k wire gate — prior guest_context from request body (second-turn payment choice).
 * Does not require current router lane; quote must be ready when quote object is present.
 */
function shouldAttemptGuestPaymentChoiceWire(guestContext, messageText) {
  const ctx = guestContext || {};
  const quote = ctx.quote;
  const quoteStatus = (quote && quote.quote_status) || ctx.quote_status;
  if (quoteStatus === 'ready' && messageText) {
    const sideQ = detectPaymentChoiceFromMessage(messageText);
    if (sideQ === 'arrival_payment_question') return true;
  }
  const paymentChoiceNeeded = (quote && quote.payment_choice_needed === true)
    || ctx.payment_choice_needed === true;
  if (!paymentChoiceNeeded) return false;
  if (quote && quote.quote_status != null && quote.quote_status !== 'ready') return false;
  if (quoteStatus != null && quoteStatus !== 'ready') return false;
  return true;
}

/**
 * Merge request guest_context with current handler chain for payment choice evaluation.
 * Preserves prior booking lane so second-turn payment_question messages still count.
 */
function buildPaymentChoiceWireContext(bodyGuestContext, result, availability, quote) {
  const prior = bodyGuestContext || {};
  const priorQuote = prior.quote && typeof prior.quote === 'object' ? prior.quote : {};
  const freshQuote = quote && typeof quote === 'object' ? quote : {};
  const { shouldPreservePriorReadyQuote, quoteChainIsStale } = require('./luna-booking-state-transitions');
  const preservePrior = shouldPreservePriorReadyQuote(prior);
  const stalePrior = quoteChainIsStale(prior) || prior.previous_quote_invalidated === true;

  let mergedQuote;
  if (preservePrior && priorQuote.quote_status === 'ready' && freshQuote.quote_status !== 'ready') {
    mergedQuote = { ...priorQuote, ...freshQuote, quote_status: 'ready' };
  } else if (stalePrior) {
    mergedQuote = { ...freshQuote };
  } else {
    mergedQuote = {
      ...(Object.keys(priorQuote).length ? priorQuote : {}),
      ...freshQuote,
    };
  }
  return {
    ...prior,
    message_lane: prior.message_lane || 'new_booking_inquiry',
    result: prior.result || result,
    availability: prior.availability || availability,
    quote: mergedQuote,
    quote_status: mergedQuote.quote_status || prior.quote_status || (quote && quote.quote_status),
    payment_choice_needed: priorQuote.payment_choice_needed === true
      || prior.payment_choice_needed === true
      || (quote && quote.payment_choice_needed === true),
    detected_language: prior.detected_language || (result && result.detected_language),
  };
}

function buildGuestPaymentChoiceWireSkippedResponse(guestContext) {
  const ctx = guestContext || {};
  const hasQuoteHints = !!(ctx.quote || ctx.payment_choice_needed != null || ctx.quote_status);
  return {
    success: true,
    ...PAYMENT_CHOICE_SAFETY,
    payment_choice_capture_attempted: false,
    payment_choice_detected: false,
    payment_choice: null,
    payment_choice_ready: false,
    payment_choice_reasons: hasQuoteHints ? ['payment_choice_gate_not_met'] : ['not_ready'],
    next_safe_step: hasQuoteHints ? 'collect_payment_choice' : 'not_ready',
  };
}

/**
 * Deterministic payment choice detection from guest message text.
 * @returns {'deposit'|'full_payment'|'arrival_payment_question'|'payment_link_request'|'unclear'|null}
 */
function detectPaymentChoiceFromMessage(messageText) {
  const t = normalizeText(messageText);
  if (!t) return null;

  if (/\b(?:send(?:\s+me)?\s+(?:the\s+)?(?:payment\s+)?link|send\s+link|payment\s+link|checkout\s+link|pay(?:ment)?\s+link|link\s+to\s+pay|link\s+after\s+quote|invia(?:mi)?\s+(?:il\s+)?link|link\s+de\s+pago|lien\s+de\s+paiement|zahlungslink)\b/i.test(t)) {
    return 'payment_link_request';
  }

  if (/\b(?:pay\s+cash|cash\s+(?:on\s+)?(?:arrival|when\s+i\s+arrive|at\s+check[\s-]?in)|cash\s+payment|payment\s+(?:by\s+)?cash|cash\s+(?:is\s+)?ok|cash\s+ok)\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:pay\s+cash|cash\s+(?:on\s+)?(?:arrival|when\s+i\s+arrive|at\s+check[\s-]?in)|bank\s+transfer|wire\s+transfer|transferencia|bonifico|virement|überweisung|ueberweisung|efectivo|all'arrivo|à\s+l'arrivée|a\s+l'arrivee|bei\s+ankunft|pay\s+when\s+i\s+arrive|on\s+arrival|at\s+check[\s-]?in|(?:do you )?accept\s+bank\s+transfer|accept\s+bank\s+transfer|contanti|in\s+contanti|pag(?:are|amento)\s+(?:in\s+)?contanti|bar\s+(?:bezahlen|zahlen)|in\s+bar(?:\s+zahlen)?|pago\s+en\s+efectivo)\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:poss(?:o|iamo)\s+pagare|(?:si|se)\s+paga|pued(?:o|es|en)|podemos|se\s+puede)\b.*\b(?:contanti|cash|efectivo|met[aá]lico|transferencia|tarjeta)\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:pagar|pago)\s+(?:al llegar|a la llegada|en\s+efectivo|en\s+met[aá]lico|por\s+transferencia|con\s+tarjeta)\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\bkann\s+ich\s+bar\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:can i )?pay later|pagar m[aá]s tarde|pagar depois|payer plus tard|sp[aä]ter bezahlen\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:full\s+amount|pay\s+in\s+full|pay\s+the\s+full|will pay the full|want to pay (?:the )?full|entire\s+amount|whole\s+amount|total\s+amount|importo\s+intero|pago\s+completo|montant\s+complet|voller\s+betrag|alles\s+bezahlen|i(?:'|’)?ll\s+pay\s+(?:the\s+)?full)\b/i.test(t)) {
    return 'full_payment';
  }

  if (/^deposit$/i.test(t)) {
    return 'deposit';
  }

  if (/^full$/i.test(t)) {
    return 'full_payment';
  }

  if (/\b(?:deposit\s+is\s+fine|pay\s+(?:the\s+)?deposit|just\s+(?:the\s+)?deposit|deposit\s+please|(?:a|the)\s+deposit|anzahlung|dep[oó]sito|deposito|l'?acompte|acompte|acconto|va\s+bene\s+(?:il\s+)?deposito|dep[oó]sito\s+est[aá]\s+bien|anzahlung\s+ist\s+ok|l'?acompte\s+me\s+convient)\b/i.test(t)) {
    return 'deposit';
  }

  if (/^(?:yes|yeah|yep|ok(?:ay)?|sure|maybe|sounds\s+good|fine|perfect|great)[!.?\s]*$/i.test(t)) {
    return 'unclear';
  }

  return null;
}

function resolveLanguage(input, guestContext) {
  if (input && input.language_hint) return String(input.language_hint).trim().toLowerCase();
  const ctx = guestContext || {};
  if (ctx.detected_language) return ctx.detected_language;
  if (ctx.result && ctx.result.detected_language) return ctx.result.detected_language;
  return 'en';
}

function buildReply(lang, key) {
  const L = tpl(lang);
  return `${L.intro} 🌊 — ${L[key]}`;
}

function containsBannedInternalGuestCopy(text) {
  const s = String(text || '');
  return BANNED_INTERNAL_GUEST_COPY_RES.some((re) => re.test(s));
}

function extractMissingStayDetails(guestContext) {
  const ctx = guestContext || {};
  const extracted = ctx.extracted_fields
    || (ctx.result && ctx.result.extracted_fields)
    || {};
  const missing = ctx.missing_required_fields
    || (ctx.result && ctx.result.missing_required_fields)
    || [];

  const needsDates = !extracted.check_in || !extracted.check_out
    || missing.includes('check_in')
    || missing.includes('check_out')
    || missing.includes('dates');
  const needsGuests = extracted.guest_count == null
    || missing.includes('guest_count');
  const needsPackage = (extracted.package_interest == null && extracted.accommodation_only !== true)
    || missing.includes('package_interest');

  return { needsDates, needsGuests, needsPackage };
}

/**
 * Guest-facing reply when payment preference is detected but quote context is not ready.
 */
function buildPaymentChoiceNotReadyReply(lang, guestContext, detected) {
  const L = tpl(lang);
  const intro = `${L.intro} 🌊 — `;
  const { needsDates, needsGuests, needsPackage } = extractMissingStayDetails(guestContext);
  const paymentPrefDetected = detected === 'deposit' || detected === 'full_payment';

  if (needsDates) return intro + L.ask_dates;
  if (needsGuests) return intro + L.ask_guests;
  if (needsPackage) return intro + L.ask_package;
  if (paymentPrefDetected) return intro + L.not_ready_deposit;
  return intro + L.not_ready_general;
}

function sanitizeLunaGuestReply(text, fallback) {
  const s = String(text || '').trim();
  if (!s || containsBannedInternalGuestCopy(s)) {
    return fallback || `${tpl('en').intro} 🌊 — ${tpl('en').not_ready_general}`;
  }
  return s;
}

function finalizeProposedLunaReply(lang, guestContext, outcome, detected) {
  const fallback = buildPaymentChoiceNotReadyReply(lang, guestContext, detected);
  if (outcome.replyKey === 'not_ready') {
    return sanitizeLunaGuestReply(fallback, fallback);
  }
  if (outcome.replyKey === 'arrival') {
    const clientSlug = guestContext.client_slug
      || (guestContext.result && guestContext.result.client_slug)
      || 'wolfhouse-somo';
    try {
      const { buildPersonalityPaymentSideReply } = require('./luna-guest-personality-config');
      const personalityReply = buildPersonalityPaymentSideReply(
        clientSlug,
        lang,
        'arrival_payment_question',
        { guestCtx: guestContext, quoteReady: quoteContextReady(guestContext) },
      );
      if (personalityReply) {
        return sanitizeLunaGuestReply(personalityReply, fallback);
      }
    } catch (_) {
      /* fall through to legacy template */
    }
  }
  const raw = buildReply(lang, outcome.replyKey);
  return sanitizeLunaGuestReply(raw, fallback);
}

function buildOutcome(detected, guestContext, messageText) {
  const ctx = guestContext || {};
  const { stalePaymentLinkBlocked } = require('./luna-booking-state-transitions');
  if (stalePaymentLinkBlocked(ctx)) {
    return {
      payment_choice_detected: detected != null,
      payment_choice: detected,
      payment_choice_ready: false,
      payment_choice_reasons: ['stale_quote_blocked'],
      next_safe_step: 'collect_payment_choice',
      replyKey: 'not_ready',
    };
  }
  const lane = ctx.message_lane || (ctx.result && ctx.result.message_lane);
  const quoteReady = quoteContextReady(ctx, messageText);

  if (lane && lane !== 'new_booking_inquiry' && lane !== 'payment_question') {
    return {
      payment_choice_detected: detected != null,
      payment_choice: detected,
      payment_choice_ready: false,
      payment_choice_reasons: ['non_booking_lane'],
      next_safe_step: 'staff_handoff_required',
      replyKey: 'non_booking',
    };
  }

  if (!quoteReady) {
    const reasons = ['quote_payment_choice_not_needed'];
    if (!ctx.quote && ctx.quote_status == null) reasons.push('missing_quote_context');
    if (ctx.quote && ctx.quote.quote_status !== 'ready') reasons.push('quote_not_ready');
    return {
      payment_choice_detected: detected != null,
      payment_choice: detected,
      payment_choice_ready: false,
      payment_choice_reasons: reasons,
      next_safe_step: detected ? 'collect_payment_choice' : 'collect_payment_choice',
      replyKey: 'not_ready',
    };
  }

  if (!detected) {
    return {
      payment_choice_detected: false,
      payment_choice: null,
      payment_choice_ready: false,
      payment_choice_reasons: ['no_payment_choice_detected'],
      next_safe_step: 'collect_payment_choice',
      replyKey: 'unclear',
    };
  }

  if (detected === 'deposit' || detected === 'full_payment') {
    return {
      payment_choice_detected: true,
      payment_choice: detected,
      payment_choice_ready: true,
      payment_choice_reasons: [],
      next_safe_step: 'ready_for_hold_payment_draft',
      replyKey: detected === 'deposit' ? 'deposit_ready' : 'full_ready',
    };
  }

  if (detected === 'arrival_payment_question') {
    return {
      payment_choice_detected: true,
      payment_choice: detected,
      payment_choice_ready: false,
      payment_choice_reasons: ['arrival_balance_question'],
      next_safe_step: 'answer_arrival_payment_question',
      replyKey: 'arrival',
    };
  }

  if (detected === 'payment_link_request') {
    return {
      payment_choice_detected: true,
      payment_choice: detected,
      payment_choice_ready: false,
      payment_choice_reasons: ['payment_link_not_available_in_dry_run'],
      next_safe_step: 'staff_handoff_required',
      replyKey: 'link_request',
    };
  }

  return {
    payment_choice_detected: true,
    payment_choice: 'unclear',
    payment_choice_ready: false,
    payment_choice_reasons: ['payment_choice_unclear'],
    next_safe_step: 'collect_payment_choice',
    replyKey: 'unclear',
  };
}

function buildGuestPaymentChoiceSkippedResponse(guestContext, detected, messageText) {
  const outcome = buildOutcome(detected ?? null, guestContext, messageText);
  const lang = resolveLanguage(null, guestContext);
  const ctx = guestContext || {};
  return {
    success: true,
    ...PAYMENT_CHOICE_SAFETY,
    payment_choice_capture_attempted: false,
    payment_choice_detected: outcome.payment_choice_detected,
    payment_choice: outcome.payment_choice,
    payment_choice_ready: false,
    payment_choice_reasons: outcome.payment_choice_reasons.length
      ? outcome.payment_choice_reasons
      : ['payment_choice_gate_not_met'],
    next_safe_step: outcome.next_safe_step,
    proposed_luna_reply: finalizeProposedLunaReply(lang, ctx, outcome, detected ?? null),
  };
}

/**
 * Stage 27j guest payment choice dry-run adapter.
 *
 * @param {{ message_text: string, language_hint?: string }} input
 * @param {object} [guestContext] - prior dry-run chain (quote, availability, message_lane, etc.)
 */
function runGuestPaymentChoiceDryRun(input, guestContext) {
  const messageText = input && input.message_text != null ? String(input.message_text).trim() : '';
  const detected = detectPaymentChoiceFromMessage(messageText);
  const lang = resolveLanguage(input, guestContext);
  const ctx = guestContext || {};

  let resetIntent = false;
  try {
    const { detectNewBookingResetIntent, buildNewBookingResetReply } = require('./luna-guest-message-router');
    resetIntent = detectNewBookingResetIntent(messageText);
    if (resetIntent && quoteContextReady(ctx)) {
      return {
        success: true,
        ...PAYMENT_CHOICE_SAFETY,
        payment_choice_capture_attempted: false,
        payment_choice_detected: false,
        payment_choice: null,
        payment_choice_ready: false,
        payment_choice_reasons: ['new_booking_reset'],
        next_safe_step: 'not_ready',
        proposed_luna_reply: buildNewBookingResetReply(lang),
      };
    }
  } catch (_) {
    resetIntent = false;
  }

  if (!shouldAttemptGuestPaymentChoiceCapture(ctx, messageText) && !detected) {
    return buildGuestPaymentChoiceSkippedResponse(ctx, null, messageText);
  }

  const outcome = buildOutcome(detected, ctx, messageText);
  const captureAttempted = quoteContextReady(ctx, messageText) || detected != null;

  return {
    success: true,
    ...PAYMENT_CHOICE_SAFETY,
    payment_choice_capture_attempted: captureAttempted,
    payment_choice_detected: outcome.payment_choice_detected,
    payment_choice: outcome.payment_choice,
    payment_choice_ready: outcome.payment_choice_ready,
    payment_choice_reasons: outcome.payment_choice_reasons,
    next_safe_step: outcome.next_safe_step,
    proposed_luna_reply: finalizeProposedLunaReply(lang, ctx, outcome, detected),
  };
}

module.exports = {
  runGuestPaymentChoiceDryRun,
  shouldAttemptGuestPaymentChoiceCapture,
  shouldAttemptGuestPaymentChoiceWire,
  buildPaymentChoiceWireContext,
  buildGuestPaymentChoiceSkippedResponse,
  buildGuestPaymentChoiceWireSkippedResponse,
  detectPaymentChoiceFromMessage,
  quoteContextReady,
  containsBannedInternalGuestCopy,
  sanitizeLunaGuestReply,
  buildPaymentChoiceNotReadyReply,
  BANNED_INTERNAL_GUEST_COPY_RES,
  VALID_PAYMENT_CHOICES,
  VALID_NEXT_SAFE_STEPS,
  PAYMENT_CHOICE_SAFETY,
  REPLY_TEMPLATES,
};
