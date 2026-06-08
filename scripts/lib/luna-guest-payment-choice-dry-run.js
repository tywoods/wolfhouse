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

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    deposit_ready: 'Thanks — I noted you would like to pay the deposit. I am not confirming the booking, creating a hold, or sending a payment link yet.',
    full_ready: 'Thanks — I noted you would like to pay the full amount. I am not confirming the booking, creating a hold, or sending a payment link yet.',
    arrival: 'The remaining balance can be paid by cash, bank transfer, or Stripe on arrival or at check-in. For the booking step now, would you prefer the deposit or the full amount?',
    link_request: 'I cannot send a payment link automatically yet. Would you prefer to pay the deposit or the full amount? I am not confirming the booking yet.',
    unclear: 'Thanks! Would you prefer to pay the deposit or the full amount for your stay?',
    not_ready: 'Thanks for your message — I need a confirmed quote before I can take your payment choice.',
    non_booking: 'For payment or balance questions I need your booking code — our team will confirm the right next step.',
    staff_handoff: 'Thanks — I am handing this to our team so they can help with the next payment step.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    deposit_ready: 'Grazie — ho annotato che preferisci il deposito. Non sto confermando la prenotazione né inviando un link di pagamento.',
    full_ready: 'Grazie — ho annotato che preferisci pagare l\'importo intero. Non sto confermando la prenotazione né inviando un link.',
    arrival: 'Il saldo restante si può pagare in contanti, bonifico o Stripe all\'arrivo o al check-in. Per ora preferisci il deposito o l\'importo intero?',
    link_request: 'Non posso inviare un link di pagamento automaticamente. Preferisci il deposito o l\'importo intero?',
    unclear: 'Grazie! Preferisci pagare il deposito o l\'importo intero?',
    not_ready: 'Grazie — serve un preventivo confermato prima di registrare la scelta di pagamento.',
    non_booking: 'Per pagamenti o saldo mi serve il codice prenotazione — il team confermerà i prossimi passi.',
    staff_handoff: 'Grazie — passo al team per il prossimo passo di pagamento.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    deposit_ready: 'Gracias — anoté que prefieres el depósito. No confirmo la reserva ni envío un enlace de pago todavía.',
    full_ready: 'Gracias — anoté que prefieres pagar el importe completo. No confirmo la reserva ni envío un enlace todavía.',
    arrival: 'El saldo restante se puede pagar en efectivo, transferencia o Stripe a la llegada o en el check-in. ¿Prefieres el depósito o el importe completo ahora?',
    link_request: 'No puedo enviar un enlace de pago automáticamente. ¿Prefieres el depósito o el importe completo?',
    unclear: '¡Gracias! ¿Prefieres pagar el depósito o el importe completo?',
    not_ready: 'Gracias — necesito un presupuesto confirmado antes de registrar tu elección de pago.',
    non_booking: 'Para pagos o saldo necesito tu código de reserva — el equipo confirmará el siguiente paso.',
    staff_handoff: 'Gracias — paso esto al equipo para el siguiente paso de pago.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    deposit_ready: 'Danke — ich habe notiert, dass ihr die Anzahlung wählt. Ich bestätige die Buchung nicht und sende noch keinen Zahlungslink.',
    full_ready: 'Danke — ich habe notiert, dass ihr den vollen Betrag zahlen möchtet. Ich bestätige die Buchung nicht und sende noch keinen Link.',
    arrival: 'Der Restbetrag kann bar, per Überweisung oder Stripe bei Ankunft oder Check-in gezahlt werden. Möchtet ihr jetzt die Anzahlung oder den vollen Betrag?',
    link_request: 'Ich kann noch keinen Zahlungslink automatisch senden. Anzahlung oder voller Betrag?',
    unclear: 'Danke! Möchtet ihr die Anzahlung oder den vollen Betrag zahlen?',
    not_ready: 'Danke — ich brauche ein bestätigtes Angebot, bevor ich eure Zahlungswahl aufnehmen kann.',
    non_booking: 'Für Zahlung oder Restbetrag brauche ich eure Buchungsnummer — das Team bestätigt die nächsten Schritte.',
    staff_handoff: 'Danke — ich gebe das an unser Team für den nächsten Zahlungsschritt weiter.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    deposit_ready: 'Merci — j\'ai noté que vous choisissez l\'acompte. Je ne confirme pas la réservation et n\'envoie pas encore de lien de paiement.',
    full_ready: 'Merci — j\'ai noté que vous choisissez le montant complet. Je ne confirme pas la réservation et n\'envoie pas encore de lien.',
    arrival: 'Le solde restant peut être réglé en espèces, virement ou Stripe à l\'arrivée ou au check-in. Préférez-vous l\'acompte ou le montant complet maintenant ?',
    link_request: 'Je ne peux pas encore envoyer de lien de paiement automatiquement. Acompte ou montant complet ?',
    unclear: 'Merci ! Préférez-vous payer l\'acompte ou le montant complet ?',
    not_ready: 'Merci — il me faut un devis confirmé avant d\'enregistrer votre choix de paiement.',
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

function quoteContextReady(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote || {};
  const paymentChoiceNeeded = quote.payment_choice_needed === true
    || ctx.payment_choice_needed === true;
  const quoteStatus = quote.quote_status || ctx.quote_status;
  return ctx.message_lane === 'new_booking_inquiry'
    && paymentChoiceNeeded
    && quoteStatus === 'ready';
}

function shouldAttemptGuestPaymentChoiceCapture(guestContext) {
  return quoteContextReady(guestContext);
}

/**
 * Stage 27k wire gate — prior guest_context from request body (second-turn payment choice).
 * Does not require current router lane; quote must be ready when quote object is present.
 */
function shouldAttemptGuestPaymentChoiceWire(guestContext) {
  const ctx = guestContext || {};
  const quote = ctx.quote;
  const paymentChoiceNeeded = (quote && quote.payment_choice_needed === true)
    || ctx.payment_choice_needed === true;
  if (!paymentChoiceNeeded) return false;
  if (quote && quote.quote_status != null && quote.quote_status !== 'ready') return false;
  const quoteStatus = (quote && quote.quote_status) || ctx.quote_status;
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
  const useCurrentQuote = quote && quote.quote_status === 'ready' && !Object.keys(priorQuote).length;
  const mergedQuote = Object.keys(priorQuote).length ? priorQuote : (useCurrentQuote ? quote : priorQuote);
  return {
    ...prior,
    message_lane: prior.message_lane || 'new_booking_inquiry',
    result: prior.result || result,
    availability: prior.availability || availability,
    quote: mergedQuote,
    quote_status: priorQuote.quote_status || prior.quote_status || (quote && quote.quote_status),
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

  if (/\b(?:send(?:\s+me)?\s+(?:the\s+)?(?:payment\s+)?link|payment\s+link|checkout\s+link|pay(?:ment)?\s+link|link\s+to\s+pay|invia(?:mi)?\s+(?:il\s+)?link|link\s+de\s+pago|lien\s+de\s+paiement|zahlungslink)\b/i.test(t)) {
    return 'payment_link_request';
  }

  if (/\b(?:pay\s+cash|cash\s+(?:on\s+)?(?:arrival|when\s+i\s+arrive|at\s+check[\s-]?in)|bank\s+transfer|wire\s+transfer|transferencia|bonifico|virement|überweisung|efectivo|all'arrivo|à\s+l'arrivée|bei\s+ankunft|pay\s+when\s+i\s+arrive|on\s+arrival|at\s+check[\s-]?in)\b/i.test(t)) {
    return 'arrival_payment_question';
  }

  if (/\b(?:full\s+amount|pay\s+in\s+full|pay\s+the\s+full|entire\s+amount|whole\s+amount|total\s+amount|importo\s+intero|pago\s+completo|montant\s+complet|voller\s+betrag|alles\s+bezahlen|i(?:'|’)?ll\s+pay\s+(?:the\s+)?full)\b/i.test(t)) {
    return 'full_payment';
  }

  if (/\b(?:deposit\s+is\s+fine|pay\s+(?:the\s+)?deposit|just\s+(?:the\s+)?deposit|deposit\s+please|(?:a|the)\s+deposit|anzahlung|dep[oó]sito|acompte|acconto)\b/i.test(t)) {
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

function buildOutcome(detected, guestContext) {
  const ctx = guestContext || {};
  const lane = ctx.message_lane || (ctx.result && ctx.result.message_lane);
  const quoteReady = quoteContextReady(ctx);

  if (lane && lane !== 'new_booking_inquiry') {
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

function buildGuestPaymentChoiceSkippedResponse(guestContext, detected) {
  const outcome = buildOutcome(detected ?? null, guestContext);
  const lang = resolveLanguage(null, guestContext);
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
    proposed_luna_reply: buildReply(lang, outcome.replyKey),
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

  if (!shouldAttemptGuestPaymentChoiceCapture(ctx) && !detected) {
    return buildGuestPaymentChoiceSkippedResponse(ctx, null);
  }

  const outcome = buildOutcome(detected, ctx);
  const captureAttempted = quoteContextReady(ctx) || detected != null;

  return {
    success: true,
    ...PAYMENT_CHOICE_SAFETY,
    payment_choice_capture_attempted: captureAttempted,
    payment_choice_detected: outcome.payment_choice_detected,
    payment_choice: outcome.payment_choice,
    payment_choice_ready: outcome.payment_choice_ready,
    payment_choice_reasons: outcome.payment_choice_reasons,
    next_safe_step: outcome.next_safe_step,
    proposed_luna_reply: buildReply(lang, outcome.replyKey),
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
  VALID_PAYMENT_CHOICES,
  VALID_NEXT_SAFE_STEPS,
  PAYMENT_CHOICE_SAFETY,
  REPLY_TEMPLATES,
};
