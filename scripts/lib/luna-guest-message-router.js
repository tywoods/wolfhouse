'use strict';

/**
 * Stage 27b/27e — Guest message router + booking intake readiness gate (dry-run only).
 *
 * Classifies inbound guest messages into lanes; extracts booking fields only for
 * new_booking_inquiry. No writes, Stripe, WhatsApp, Meta, n8n, or live automation.
 */

const { extractLunaGuestMessageIntake } = require('./luna-guest-message-intake');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const VALID_LANES = new Set([
  'new_booking_inquiry',
  'existing_booking_question',
  'add_service_request',
  'transfer_request',
  'payment_question',
  'checkin_house_info_question',
  'cancel_or_change_request',
  'general_question',
  'staff_handoff_required',
]);

const VALID_INTAKE_STATES = new Set([
  'inquiry_received',
  'collecting_required_details',
  'ready_for_availability_check',
  'staff_handoff_required',
]);

const VALID_READINESS_STATES = new Set([
  'collecting_required_details',
  'ready_for_availability_check',
  'staff_handoff_required',
]);

const ROUTER_SAFETY = {
  dry_run: true,
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  live_send_blocked: true,
  whatsapp_sent: false,
  calls_n8n: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  payment_link_sent: false,
};

const BOOKING_FIELD_PRIORITY = ['dates', 'guest_count', 'package_interest'];

const STAFF_HANDOFF_REASONS = new Set([
  'paid_cancellation_or_reschedule',
  'date_change_different_nights',
  'unclear_availability',
  'uncertain_package_or_pricing',
  'transfer_exception',
  'bilbao_no_package_request',
  'bad_weather_lesson_refund',
  'low_confidence_language_or_intent',
  'outside_policy_question',
  'payment_state_mismatch',
  'cancel_or_change_request',
]);

const REPLY_TEMPLATES = {
  en: {
    intro: "Hi! I'm Luna from Wolfhouse",
    ask_dates: 'What check-in and check-out dates are you thinking of?',
    ask_guests: 'How many guests will be staying?',
    ask_package: 'Are you interested in one of our packages (Malibu, Uluwatu, Waimea) or a custom stay without a package?',
    handoff: "Thanks for your message — I'm passing this to our team so they can help you properly. Someone from Wolfhouse will follow up soon.",
    ask_booking_code: 'Could you share your booking code or the name on the reservation so I can look this up with the team?',
    transfer_no_booking: 'Happy to note airport transfer interest. Could you share your booking code or stay dates so we can help with transfer details?',
    service_no_booking: 'I can note wetsuit, board, lesson, or yoga interest — could you share your booking code or reservation name first?',
    checkin_info: "Check-in details depend on your booking — I'll ask our team to confirm the exact time and house info for you.",
    payment_help: "For payment or balance questions I'll need your booking code — could you send that, and our team will confirm the right next step?",
    pay_now: "I can't send a payment link automatically yet — our team will confirm your booking and payment status and follow up with you.",
    general: "Thanks for reaching out to Wolfhouse! I'll flag this for our team so they can answer you properly.",
    cancel: "Changes or cancellations after payment need our team — I'm handing this over so they can help you directly.",
    ready_next_check: 'Thanks — I have your stay details. Next I can look into the best option for your dates and let you know. I am not confirming availability yet.',
  },
  it: {
    intro: 'Ciao! Sono Luna di Wolfhouse',
    ask_dates: 'Per quali date di check-in e check-out stai pensando di venire?',
    ask_guests: 'Quante persone sarete?',
    ask_package: 'Ti interessa un pacchetto (Malibu, Uluwatu, Waimea) o un soggiorno custom senza pacchetto?',
    handoff: 'Grazie per il messaggio — passo la richiesta al team così possiamo aiutarti al meglio. Qualcuno di Wolfhouse ti risponderà presto.',
    ask_booking_code: 'Puoi inviarmi il codice prenotazione o il nome sulla prenotazione?',
    transfer_no_booking: 'Volentieri per il transfer aeroporto — puoi condividere il codice prenotazione o le date del soggiorno?',
    service_no_booking: 'Posso segnalare interesse per muta, tavola, lezione o yoga — hai un codice prenotazione o nome prenotazione?',
    checkin_info: 'I dettagli del check-in dipendono dalla prenotazione — chiedo al team di confermare orario e info casa.',
    payment_help: 'Per pagamenti o saldo mi serve il codice prenotazione — puoi inviarlo? Il team confermerà i prossimi passi.',
    pay_now: 'Non posso inviare un link di pagamento in automatico — il team confermerà prenotazione e pagamento e ti scriverà.',
    general: 'Grazie per aver scritto a Wolfhouse! Segnalo al team così possono risponderti.',
    cancel: 'Modifiche o cancellazioni dopo il pagamento richiedono il team — passo la conversazione a loro.',
    ready_next_check: 'Grazie — ho i dettagli del soggiorno. Prossimo passo: posso valutare la migliore opzione per le tue date e farti sapere. Non sto ancora confermando disponibilità.',
  },
  es: {
    intro: '¡Hola! Soy Luna de Wolfhouse',
    ask_dates: '¿Qué fechas de entrada y salida tienes en mente?',
    ask_guests: '¿Cuántas personas serán?',
    ask_package: '¿Te interesa un paquete (Malibu, Uluwatu, Waimea) o una estancia custom sin paquete?',
    handoff: 'Gracias por tu mensaje — lo paso al equipo para ayudarte bien. Alguien de Wolfhouse te responderá pronto.',
    ask_booking_code: '¿Puedes compartir tu código de reserva o el nombre de la reserva?',
    transfer_no_booking: 'Con gusto anoto el transfer del aeropuerto — ¿tienes código de reserva o fechas de estancia?',
    service_no_booking: 'Puedo anotar interés en wetsuit, tabla, clase o yoga — ¿tienes código de reserva o nombre?',
    checkin_info: 'Los detalles de check-in dependen de tu reserva — pediré al equipo que confirme hora e info de la casa.',
    payment_help: 'Para pagos o saldo necesito tu código de reserva — ¿puedes enviarlo? El equipo confirmará el siguiente paso.',
    pay_now: 'No puedo enviar un enlace de pago automáticamente — el equipo confirmará reserva y pago y te escribirá.',
    general: '¡Gracias por escribir a Wolfhouse! Lo señalo al equipo para que te respondan.',
    cancel: 'Cambios o cancelaciones después del pago necesitan al equipo — les paso la conversación.',
    ready_next_check: 'Gracias — tengo los detalles de la estancia. El siguiente paso es revisar la mejor opción para tus fechas y avisarte. Aún no confirmo disponibilidad.',
  },
  de: {
    intro: 'Hallo! Ich bin Luna von Wolfhouse',
    ask_dates: 'Welche Check-in- und Check-out-Daten schweben dir vor?',
    ask_guests: 'Wie viele Gäste seid ihr?',
    ask_package: 'Interessiert dich ein Paket (Malibu, Uluwatu, Waimea) oder ein Custom-Aufenthalt ohne Paket?',
    handoff: 'Danke für deine Nachricht — ich gebe das an unser Team weiter. Jemand von Wolfhouse meldet sich bald.',
    ask_booking_code: 'Kannst du deine Buchungsnummer oder den Namen auf der Buchung senden?',
    transfer_no_booking: 'Transfer vom Flughafen notiere ich gern — hast du eine Buchungsnummer oder Aufenthaltsdaten?',
    service_no_booking: 'Wetsuit, Board, Lesson oder Yoga kann ich notieren — hast du eine Buchungsnummer oder den Namen?',
    checkin_info: 'Check-in-Details hängen von deiner Buchung ab — ich lasse das Team Zeit und Hausinfos bestätigen.',
    payment_help: 'Für Zahlung oder Restbetrag brauche ich deine Buchungsnummer — kannst du die senden?',
    pay_now: 'Ich kann noch keinen Zahlungslink automatisch senden — das Team klärt Buchung und Zahlung und meldet sich.',
    general: 'Danke für deine Nachricht an Wolfhouse! Ich leite das an unser Team weiter.',
    cancel: 'Änderungen oder Stornos nach Zahlung brauchen unser Team — ich gebe das weiter.',
    ready_next_check: 'Danke — ich habe eure Aufenthaltsdetails. Als Nächstes kann ich die beste Option für eure Daten prüfen und Bescheid geben. Ich bestätige noch keine Verfügbarkeit.',
  },
  fr: {
    intro: 'Bonjour ! Je suis Luna de Wolfhouse',
    ask_dates: 'Quelles dates d’arrivée et de départ envisagez-vous ?',
    ask_guests: 'Combien de personnes serez-vous ?',
    ask_package: 'Souhaitez-vous un forfait (Malibu, Uluwatu, Waimea) ou un séjour custom sans forfait ?',
    handoff: 'Merci pour votre message — je transmets à l’équipe pour vous aider au mieux. Quelqu’un de Wolfhouse vous répondra bientôt.',
    ask_booking_code: 'Pouvez-vous partager votre code de réservation ou le nom sur la réservation ?',
    transfer_no_booking: 'Je note volontiers un transfert aéroport — avez-vous un code de réservation ou des dates de séjour ?',
    service_no_booking: 'Je peux noter wetsuit, planche, cours ou yoga — avez-vous un code ou un nom de réservation ?',
    checkin_info: 'Les détails d’arrivée dépendent de votre réservation — je demande à l’équipe de confirmer l’heure et les infos maison.',
    payment_help: 'Pour le paiement ou le solde, j’ai besoin de votre code de réservation — pouvez-vous l’envoyer ?',
    pay_now: 'Je ne peux pas envoyer de lien de paiement automatiquement — l’équipe confirmera réservation et paiement.',
    general: 'Merci d’avoir contacté Wolfhouse ! Je signale cela à l’équipe pour qu’ils vous répondent.',
    cancel: 'Les changements ou annulations après paiement passent par l’équipe — je leur transmets la conversation.',
    ready_next_check: 'Merci — j’ai les détails du séjour. Prochaine étape : je peux regarder la meilleure option pour vos dates et vous revenir. Je ne confirme pas encore la disponibilité.',
  },
};

function resolveReferenceDate(context) {
  const raw = context && context.reference_date;
  if (raw) {
    const d = new Date(String(raw));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function detectLanguage(text, hint) {
  if (hint) {
    const h = String(hint).trim().toLowerCase().slice(0, 2);
    if (REPLY_TEMPLATES[h]) return h;
  }
  const t = String(text || '').toLowerCase();
  if (/\b(?:hola|gracias|quiero|personas|septiembre|aeropuerto|necesito)\b/.test(t)) return 'es';
  if (/\b(?:ciao|grazie|vorrei|persone|settembre|giugno|siamo)\b/.test(t)) return 'it';
  if (/\b(?:bonjour|merci|personnes|septembre|août|aout|aimerions|voulons|réserver|reserver)\b/.test(t)) return 'fr';
  if (/\b(?:hallo|danke|gäste|gaste|september|surfbrett|wetsuit|mieten|möchten|moechten|buchen)\b/.test(t)) return 'de';
  return 'en';
}

function tpl(lang, key) {
  const L = REPLY_TEMPLATES[lang] || REPLY_TEMPLATES.en;
  return L[key] || REPLY_TEMPLATES.en[key] || '';
}

function hasExplicitDates(text) {
  const monthDay = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre|januar|februar|m[aä]rz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
  return /\b\d{4}-\d{2}-\d{2}\b/.test(text)
    || /\b\d{1,2}\s+(?:de\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)/i.test(text)
    || monthDay.test(text)
    || /\b(?:from|dal|del|vom|from)\s+\d{1,2}/i.test(text)
    || /\b(?:from|to)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/i.test(text);
}

function hasBookingCode(text) {
  return /\bMB-WOLFHO[-\w]+\b/i.test(text)
    || /\b(?:my booking|my reservation|ma réservation|mi reserva|meine buchung|codice prenotazione| código de reserva)\b/i.test(text);
}

function detectTransferInterest(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(?:transfer|airport|aeropuerto|aeroporto|flughafen|aéroport|aeroport|pick.?up|flight|Santander|Bilbao|SDR|BIO)\b/.test(t)) {
    return null;
  }
  const interest = { interested: true };
  if (/\bbilbao\b|\bBIO\b/i.test(t)) interest.airport_code = 'BIO';
  else if (/\bsantander\b|\bSDR\b/i.test(t)) interest.airport_code = 'SDR';
  if (/\b(?:arrival|arrivo|llegada|arrivée|arrivee|ankunft)\b/i.test(t)) interest.direction = 'arrival';
  if (/\b(?:departure|partenza|salida|départ|depart|abflug)\b/i.test(t)) interest.direction = 'departure';
  const flight = t.match(/\b([A-Z]{2}\s?\d{2,4})\b/i);
  if (flight) interest.flight_number = flight[1].replace(/\s+/g, '').toUpperCase();
  return interest;
}

function detectNoPackageIntent(text) {
  return /\b(?:no package|not booking a package|sin paquete|sans forfait|ohne paket|custom stay|without a package)\b/i.test(String(text || ''));
}

function detectAccommodationOnlyIntent(text) {
  return /\b(?:accommodation only|room only|just accommodation|solo alojamiento|nur unterkunft|logement seulement|solo pernottamento|bed only)\b/i.test(String(text || ''));
}

function hasPackageOrStayIntent(extracted) {
  const pi = extracted && extracted.package_interest;
  if (!pi || typeof pi !== 'string') return false;
  const normalized = pi.trim().toLowerCase();
  return normalized === 'no_package'
    || normalized === 'accommodation_only'
    || normalized === 'custom'
    || ['malibu', 'uluwatu', 'waimea'].includes(normalized);
}

function classifyMessageLane(text, guestContext) {
  const t = String(text || '');
  const ctx = guestContext || {};
  const hasCode = hasBookingCode(t) || !!(ctx.booking_code || ctx.booking_id);

  if (/\b(?:cancel|refund|rimborso|reembolso|stornier|annull|rembours|rückerstattung|ruckerstattung|reschedule|change my dates|cambiar fechas|modifier mes dates)\b/i.test(t)) {
    return {
      lane: 'cancel_or_change_request',
      handoff: true,
      reasons: [/\b(?:refund|paid|already paid|deposit paid)\b/i.test(t) ? 'paid_cancellation_or_reschedule' : 'cancel_or_change_request'],
      confidence: 0.92,
    };
  }

  if (/\bbilbao\b|\bBIO\b/i.test(t) && /\b(?:transfer|airport|pickup|recogida|aeropuerto|aéroport|aeroport)\b/i.test(t)) {
    if (detectNoPackageIntent(t) || !/\b(?:malibu|uluwatu|waimea|package|paquete|forfait|paket|pacchetto)\b/i.test(t)) {
      return {
        lane: 'staff_handoff_required',
        handoff: true,
        reasons: ['bilbao_no_package_request'],
        confidence: 0.88,
      };
    }
  }

  if (/\b(?:check[- ]?in time|check in time|what time.*check|gate code|wifi|house rules|luggage storage|hora de entrada|ora di check|heure d'arrivée|heure d arrivee|check-in uhrzeit)\b/i.test(t)) {
    return { lane: 'checkin_house_info_question', handoff: false, reasons: [], confidence: 0.9 };
  }

  if (/\b(?:pay now|payment link|checkout link|paying now|pagar ahora|payer maintenant|jetzt bezahlen|link de pago|lien de paiement)\b/i.test(t)) {
    return {
      lane: 'payment_question',
      handoff: true,
      reasons: ['payment_state_mismatch'],
      confidence: 0.9,
    };
  }

  if (/\b(?:remaining balance|balance due|still owe|how much.*owe|cuánto debo|saldo restante|reste à payer|reste a payer|noch zu zahlen|saldo rimanente)\b/i.test(t)) {
    return {
      lane: 'payment_question',
      handoff: !hasCode,
      reasons: hasCode ? [] : ['needs_booking_identification'],
      confidence: 0.88,
    };
  }

  if (hasCode && !/\b(?:book|reserve|stay from|vorremmo venire|quiero reservar|nous aimerions)\b/i.test(t)) {
    return { lane: 'existing_booking_question', handoff: false, reasons: [], confidence: 0.85 };
  }

  const serviceOnly = /\b(?:wetsuit|surfboard|surf board|surfbrett|muta|tabla de surf|planche|surf lesson|surfstunde|clase de surf|cours de surf|yoga)\b/i.test(t);
  const bookingMix = /\b(?:book|stay|nights|check.in|package|vorremmo|venir|reserv|giugno|june|juni|malibu)\b/i.test(t);
  if (serviceOnly && !bookingMix) {
    return { lane: 'add_service_request', handoff: false, reasons: [], confidence: 0.87 };
  }

  const transferOnly = /\b(?:airport transfer|transfer from|pick.?up from|flight number|aeropuerto de|aeroporto di|flughafen|transfert aéroport|transfer vom)\b/i.test(t)
    || (/\b(?:Santander|Bilbao|SDR|BIO)\b/i.test(t) && /\b(?:transfer|aeropuerto|airport|flughafen)\b/i.test(t));
  if (transferOnly && !bookingMix) {
    return { lane: 'transfer_request', handoff: false, reasons: [], confidence: 0.86 };
  }

  const priceOnly = /^(?:how much|what(?:'s| is) the price|price\?|cuánto cuesta|quanto costa|combien|was kostet)\s*[?.!]?$/i.test(t.trim())
    || (/\b(?:how much does it cost|what(?:'s| is) the price|how much is it)\b/i.test(t) && !hasExplicitDates(t) && !/\b\d+\s+(?:people|guests|persone|personas|personnes|personen)\b/i.test(t));
  if (priceOnly) {
    return {
      lane: 'new_booking_inquiry',
      handoff: true,
      reasons: ['uncertain_package_or_pricing'],
      confidence: 0.55,
    };
  }

  if (/\b(?:room available|have a room|any availability|disponibilidad|hay sitio|posto libre|chambre libre|zimmer frei)\b/i.test(t)) {
    const unclear = !hasExplicitDates(t);
    return {
      lane: 'new_booking_inquiry',
      handoff: unclear,
      reasons: unclear ? ['unclear_availability'] : [],
      confidence: unclear ? 0.6 : 0.78,
    };
  }

  if (/\b(?:book|booking|reserve|reservation|stay|want to come|looking to stay|vorremmo venire|voglio venire|quiero reservar|souhaite.*venir|möchte.*kommen|moechte.*kommen|möchten\s+buchen|moechten\s+buchen|wir\s+möchten\s+buchen|wir\s+moechten\s+buchen|nous\s+aimerions\s+venir|nous\s+voulons\s+réserver|nous\s+voulons\s+reserver|estancia)\b/i.test(t)
    || hasExplicitDates(t)
    || /\b\d+\s+(?:people|guests|persone|personas|personnes|personen)\b/i.test(t)) {
    return { lane: 'new_booking_inquiry', handoff: false, reasons: [], confidence: 0.82 };
  }

  if (/\b(?:pets|parking|dogs|cats|allowed to bring)\b/i.test(t)) {
    return {
      lane: 'general_question',
      handoff: true,
      reasons: ['outside_policy_question'],
      confidence: 0.7,
    };
  }

  return {
    lane: 'general_question',
    handoff: true,
    reasons: ['low_confidence_language_or_intent'],
    confidence: 0.4,
  };
}

function extractBookingFields(messageText, context, priorFields) {
  const prior = priorFields || {};
  const intake = extractLunaGuestMessageIntake(
    {
      client_slug: DEFAULT_CLIENT,
      message_text: messageText,
      language: context.language_hint,
      from: context.guest_phone || null,
    },
    { reference_date: context.reference_date },
  );

  const extracted = {
    check_in: intake.check_in || prior.check_in || null,
    check_out: intake.check_out || prior.check_out || null,
    guest_count: intake.guests != null ? intake.guests : (prior.guest_count != null ? prior.guest_count : null),
    package_interest: intake.package_code || prior.package_interest || null,
    transfer_interest: detectTransferInterest(messageText) || prior.transfer_interest || null,
    service_interest: (intake.add_ons && intake.add_ons.length)
      ? intake.add_ons
      : (prior.service_interest || []),
    payment_preference: intake.payment_choice || prior.payment_preference || null,
  };

  if (detectNoPackageIntent(messageText)) {
    extracted.package_interest = 'no_package';
  } else if (!extracted.package_interest && detectAccommodationOnlyIntent(messageText)) {
    extracted.package_interest = 'accommodation_only';
  }

  return extracted;
}

function computeReadinessMissingFields(extracted) {
  const missing = [];
  if (!extracted.check_in) missing.push('check_in');
  if (!extracted.check_out) missing.push('check_out');
  if (extracted.guest_count == null || extracted.guest_count < 1) missing.push('guest_count');
  if (!hasPackageOrStayIntent(extracted)) missing.push('package_interest');
  return missing;
}

/**
 * Stage 27e — booking intake readiness gate (new_booking_inquiry only).
 */
function computeBookingIntakeReadiness(lane, extracted, safeHandoffRequired, handoffReasons) {
  const reasons = [];
  const handoffList = handoffReasons || [];

  if (lane !== 'new_booking_inquiry') {
    return {
      booking_intake_ready: false,
      readiness_state: 'collecting_required_details',
      readiness_missing_fields: [],
      readiness_reasons: ['not_booking_inquiry_lane'],
    };
  }

  if (handoffList.includes('uncertain_package_or_pricing')) {
    reasons.push('price_before_required_details');
  }
  if (handoffList.includes('unclear_availability')) {
    reasons.push('availability_before_required_details');
  }

  if (safeHandoffRequired) {
    return {
      booking_intake_ready: false,
      readiness_state: 'staff_handoff_required',
      readiness_missing_fields: computeReadinessMissingFields(extracted || {}),
      readiness_reasons: reasons.length ? reasons : [...handoffList],
    };
  }

  const missing = computeReadinessMissingFields(extracted || {});
  if (missing.length === 0) {
    return {
      booking_intake_ready: true,
      readiness_state: 'ready_for_availability_check',
      readiness_missing_fields: [],
      readiness_reasons: reasons,
    };
  }

  return {
    booking_intake_ready: false,
    readiness_state: 'collecting_required_details',
    readiness_missing_fields: missing,
    readiness_reasons: reasons.length ? reasons : ['missing_required_fields'],
  };
}

function computeMissingRequired(extracted) {
  const missing = [];
  if (!extracted.check_in || !extracted.check_out) missing.push('dates');
  if (extracted.guest_count == null || extracted.guest_count < 1) missing.push('guest_count');
  if (!extracted.package_interest) missing.push('package_interest');
  return missing;
}

function resolveIntakeState(lane, missing, handoff, priorState, hasPriorFields, readiness) {
  if (handoff || (readiness && readiness.readiness_state === 'staff_handoff_required')) {
    return 'staff_handoff_required';
  }
  if (lane !== 'new_booking_inquiry') return priorState || 'inquiry_received';
  if (readiness && readiness.readiness_state === 'ready_for_availability_check') {
    return 'ready_for_availability_check';
  }
  if (missing.length === BOOKING_FIELD_PRIORITY.length && !hasPriorFields) return 'inquiry_received';
  return 'collecting_required_details';
}

function buildBookingReply(lang, readiness, extracted) {
  const parts = [tpl(lang, 'intro') + ' 🌊'];
  if (readiness.readiness_state === 'ready_for_availability_check') {
    parts.push(tpl(lang, 'ready_next_check'));
    return parts.join(' ');
  }
  const missing = readiness.readiness_missing_fields || [];
  const next = missing[0];
  if (next === 'check_in' || next === 'check_out') parts.push(tpl(lang, 'ask_dates'));
  else if (next === 'guest_count') parts.push(tpl(lang, 'ask_guests'));
  else if (next === 'package_interest') parts.push(tpl(lang, 'ask_package'));
  else if (extracted.transfer_interest) {
    parts.push(tpl(lang, 'transfer_no_booking'));
  } else {
    parts.push(tpl(lang, 'ask_dates'));
  }
  return parts.join(' ');
}

function buildLaneReply(lane, lang, handoff, reasons) {
  const intro = `${tpl(lang, 'intro')} 🌊`;
  if (handoff || lane === 'staff_handoff_required') {
    if (reasons.includes('paid_cancellation_or_reschedule') || lane === 'cancel_or_change_request') {
      return `${intro} — ${tpl(lang, 'cancel')}`;
    }
    return `${intro} — ${tpl(lang, 'handoff')}`;
  }
  switch (lane) {
    case 'existing_booking_question':
      return `${intro} — ${tpl(lang, 'ask_booking_code')}`;
    case 'add_service_request':
      return `${intro} — ${tpl(lang, 'service_no_booking')}`;
    case 'transfer_request':
      return `${intro} — ${tpl(lang, 'transfer_no_booking')}`;
    case 'payment_question':
      if (reasons.includes('payment_state_mismatch')) return `${intro} — ${tpl(lang, 'pay_now')}`;
      return `${intro} — ${tpl(lang, 'payment_help')}`;
    case 'checkin_house_info_question':
      return `${intro} — ${tpl(lang, 'checkin_info')}`;
    case 'cancel_or_change_request':
      return `${intro} — ${tpl(lang, 'cancel')}`;
    case 'general_question':
      return `${intro} — ${tpl(lang, 'general')}`;
    default:
      return `${intro} — ${tpl(lang, 'general')}`;
  }
}

function buildAllowedNextActions(lane, intakeState, missing, handoff, readiness) {
  const actions = ['await_guest_reply'];
  if (handoff || intakeState === 'staff_handoff_required') {
    return ['staff_handoff', 'await_staff_review'];
  }
  if (lane === 'new_booking_inquiry') {
    if (readiness && readiness.readiness_state === 'ready_for_availability_check') {
      return ['ready_for_availability_check_deferred', 'await_guest_reply', 'classify_only'];
    }
    const readinessMissing = (readiness && readiness.readiness_missing_fields) || [];
    if (readinessMissing.includes('check_in') || readinessMissing.includes('check_out') || missing.includes('dates')) {
      actions.unshift('ask_dates');
    } else if (readinessMissing.includes('guest_count') || missing.includes('guest_count')) {
      actions.unshift('ask_guest_count');
    } else if (readinessMissing.includes('package_interest') || missing.includes('package_interest')) {
      actions.unshift('ask_package_interest');
    } else {
      actions.unshift('collect_complete_await_stage27c');
    }
    actions.push('classify_only');
  } else {
    actions.unshift('classify_only', 'request_booking_identification');
  }
  return [...new Set(actions)];
}

/**
 * Stage 27b guest message router dry-run.
 *
 * @param {object} input - { message_text, language_hint?, guest_context? }
 * @param {object} [context] - { reference_date?, guest_phone? }
 */
function runLunaGuestMessageRouterDryRun(input, context) {
  const src = input || {};
  const ctx = context || {};
  const messageText = src.message_text != null ? String(src.message_text).trim() : '';
  const guestContext = src.guest_context || {};
  const priorExtracted = guestContext.extracted_fields || {};

  if (!messageText) {
    return {
      success: false,
      error: 'message_text required',
      ...ROUTER_SAFETY,
    };
  }

  const detectedLanguage = detectLanguage(messageText, src.language_hint || guestContext.language);
  const classification = classifyMessageLane(messageText, guestContext);
  let { lane, handoff, reasons, confidence } = classification;

  let extractedFields = {};
  let missingRequired = [];

  if (lane === 'new_booking_inquiry') {
    extractedFields = extractBookingFields(messageText, {
      language_hint: detectedLanguage,
      reference_date: ctx.reference_date,
      guest_phone: ctx.guest_phone || guestContext.guest_phone,
    }, priorExtracted);
    missingRequired = computeMissingRequired(extractedFields);

    if (reasons.includes('unclear_availability')) handoff = true;
    if (reasons.includes('uncertain_package_or_pricing')) handoff = true;

    if (!handoff && missingRequired.length === 0 && confidence < 0.75) {
      handoff = true;
      reasons = reasons.concat(['low_confidence_language_or_intent']);
    }

    const hasMonthOnly = /\b(?:august|août|aout|agosto|sommer|été|ete|summer)\b/i.test(messageText)
      && !extractedFields.check_in;
    if (hasMonthOnly && !handoff) {
      handoff = true;
      if (!reasons.includes('unclear_availability')) reasons.push('unclear_availability');
    }
  } else if (lane !== 'staff_handoff_required') {
    extractedFields = {};
    missingRequired = [];
    if (handoff && !reasons.length) reasons = ['needs_booking_identification'];
  } else {
    extractedFields = {};
    missingRequired = [];
  }

  const safeHandoffRequired = lane === 'staff_handoff_required'
    || handoff
    || reasons.some((r) => STAFF_HANDOFF_REASONS.has(r));

  const readiness = computeBookingIntakeReadiness(
    lane,
    extractedFields,
    safeHandoffRequired,
    reasons,
  );

  const hasPriorFields = Object.keys(priorExtracted).some((k) => priorExtracted[k] != null
    && (Array.isArray(priorExtracted[k]) ? priorExtracted[k].length : true));

  let intakeState = resolveIntakeState(
    lane,
    missingRequired,
    safeHandoffRequired,
    guestContext.intake_state,
    hasPriorFields,
    readiness,
  );

  if (reasons.includes('needs_booking_identification') && !safeHandoffRequired) {
    intakeState = guestContext.intake_state || 'inquiry_received';
    handoff = false;
  }

  let proposedReply;
  if (safeHandoffRequired) {
    proposedReply = buildLaneReply(
      lane === 'cancel_or_change_request' ? lane : 'staff_handoff_required',
      detectedLanguage,
      true,
      reasons,
    );
  } else if (lane === 'new_booking_inquiry') {
    proposedReply = buildBookingReply(detectedLanguage, readiness, extractedFields);
  } else {
    proposedReply = buildLaneReply(lane, detectedLanguage, false, reasons);
  }

  const allowedNextActions = buildAllowedNextActions(
    lane,
    intakeState,
    missingRequired,
    safeHandoffRequired,
    readiness,
  );

  const readinessOutput = lane === 'new_booking_inquiry'
    ? {
      booking_intake_ready: readiness.booking_intake_ready,
      readiness_state: readiness.readiness_state,
      readiness_missing_fields: readiness.readiness_missing_fields,
      readiness_reasons: readiness.readiness_reasons,
    }
    : {
      booking_intake_ready: false,
      readiness_state: safeHandoffRequired ? 'staff_handoff_required' : 'collecting_required_details',
      readiness_missing_fields: [],
      readiness_reasons: ['not_booking_inquiry_lane'],
    };

  return {
    success: true,
    ...ROUTER_SAFETY,
    message_lane: lane,
    intake_state: intakeState,
    detected_language: detectedLanguage,
    confidence,
    extracted_fields: lane === 'new_booking_inquiry' ? extractedFields : {},
    missing_required_fields: lane === 'new_booking_inquiry' ? missingRequired : [],
    ...readinessOutput,
    safe_handoff_required: safeHandoffRequired,
    handoff_reasons: [...reasons],
    proposed_luna_reply: proposedReply,
    allowed_next_actions: allowedNextActions,
  };
}

module.exports = {
  runLunaGuestMessageRouterDryRun,
  classifyMessageLane,
  detectLanguage,
  computeMissingRequired,
  computeReadinessMissingFields,
  computeBookingIntakeReadiness,
  hasPackageOrStayIntent,
  VALID_LANES,
  VALID_INTAKE_STATES,
  VALID_READINESS_STATES,
  ROUTER_SAFETY,
  REPLY_TEMPLATES,
};
