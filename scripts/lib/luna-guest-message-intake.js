'use strict';

/**
 * Phase 15b — Luna guest message intake (deterministic-first, read-only).
 *
 * Extracts structured booking fields from natural guest messages and validates
 * them for downstream dry-run. No writes, WhatsApp, n8n, or Stripe.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_CLIENT = 'wolfhouse-somo';

const KNOWN_PACKAGE_CODES = new Set(['malibu', 'uluwatu', 'waimea', 'custom']);
const KNOWN_ADDON_TYPES   = new Set(['yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard']);
const VALID_PAYMENT_CHOICES = new Set(['deposit', 'full']);

const DRY_RUN_CHAIN_FIELDS = [
  'client_slug',
  'phone',
  'check_in',
  'check_out',
  'guests',
  'package_code',
];

const ASK_NEXT_LABELS = {
  phone:          'your WhatsApp number',
  check_in:       'your check-in date',
  check_out:      'your check-out date',
  guests:         'how many guests will be staying',
  package_code:   'which package you prefer (Malibu, Uluwatu, or Waimea)',
  guest_name:     'your name',
  payment_choice: 'whether you prefer to pay a deposit or the full amount',
};

/** Phase 15d — localized ask_next prompts (deterministic, no AI). */
const ASK_NEXT_BY_LANG = {
  en: {
    dates:        'What dates would you like to stay?',
    package_code: 'Which package would you like?',
    guests:       'How many people are coming?',
    phone:        'What phone number should we use for the booking?',
  },
  it: {
    dates:        'In quali date vorresti soggiornare?',
    package_code: 'Quale pacchetto vorresti?',
    guests:       'Quante persone siete?',
    phone:        'Che numero di telefono possiamo usare per la prenotazione?',
  },
  es: {
    dates:        '¿Qué fechas te gustaría reservar?',
    package_code: '¿Qué paquete te gustaría?',
    guests:       '¿Cuántas personas vienen?',
    phone:        '¿Qué número de teléfono podemos usar para la reserva?',
  },
  fr: {
    dates:        'Quelles dates souhaitez-vous réserver ?',
    package_code: 'Quel forfait souhaitez-vous ?',
    guests:       'Combien de personnes viennent ?',
    phone:        'Quel numéro de téléphone pouvons-nous utiliser pour la réservation ?',
  },
  de: {
    dates:        'Für welche Daten möchtest du buchen?',
    package_code: 'Welches Paket möchtest du?',
    guests:       'Wie viele Personen kommen?',
    phone:        'Welche Telefonnummer sollen wir für die Buchung verwenden?',
  },
};

const HANDOFF_RE = /\b(?:talk to (?:a )?(?:human|person|someone)|speak to (?:a )?(?:human|person|someone)|human(?:\s+please)?|refund|rimborso|reembolso|cancel(?:led|lation)?(?:\s+(?:paid|my)\s+booking)?|complaint|reclamaci[oó]n|reclamo|remboursement|rückerstattung|stornieren|annullare|parlare\s+con\s+qualcuno|hablar\s+con\s+alguien|parler\s+(?:à|a)\s+quelqu[\w']+|mit\s+jemandem\s+sprechen)\b/i;

const INTAKE_SAFETY_FLAGS = {
  extraction_only:    true,
  preview_only:       true,
  no_write_performed: true,
  sends_whatsapp:     false,
  calls_n8n:          false,
  creates_booking:    false,
  creates_payment:    false,
  creates_stripe_link: false,
};

const MONTH_MAP = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
  april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
  // IT
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
  // ES
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  // DE
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
  // FR
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11, décembre: 12,
};

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
  uno: 1, due: 2, tre: 3, cuatro: 4, cinque: 5, sei: 6, zwei: 2, drei: 3,
  vier: 4, fünf: 5, funf: 5, deux: 2, trois: 3, quatre: 4, cinq: 5,
  // Phase 15c — multilingual guest-count words
  una: 1, quattro: 4, dos: 2, tres: 3, une: 1, eine: 1,
};

const AVAILABILITY_KEYWORDS_RE = /\b(?:posto|avete\s+posto|disponibilit[aà]|disponibile|disponibilidad|disponible|hay\s+sitio|disponibilit[eé]|verf[uü]gbar(?:keit)?|platz\s+frei|availability|available|disponib|libre|frei)\b/i;

const BOOKING_HINT_RE = /\b(?:vorremmo\s+venire|voglio\s+venire|want\s+to\s+come|we\s+want\s+to\s+come|quiero\s+venir|voglia\s+di\s+venire|souhaite(?:r|)\s+venir|möchte(?:n)?\s+kommen|moechte(?:n)?\s+kommen|book(?:ing)?|prenotare|reservar|réserver|reservieren)\b/i;

const PARTIAL_INTENTS = new Set(['availability_question', 'booking_inquiry']);

const MULTILINGUAL_GUEST_RE = /\b(?:siamo|somos|nous\s+sommes|wir\s+sind)\s+(una|due|tre|quattro|dos|tres|cuatro|une|deux|trois|quatre|eine|zwei|drei|vier)\s+(?:persone|personas|personnes|personen)\b/i;

const MULTILINGUAL_GUEST_STANDALONE_RES = [
  /\b(una|due|tre|quattro)\s+persone\b/i,
  /\b(una|dos|tres|cuatro)\s+personas?\b/i,
  /\b(une|deux|trois|quatre)\s+personnes\b/i,
  /\b(eine|zwei|drei|vier)\s+personen\b/i,
];

function isGuestIntakeAiEnabled(env) {
  const e = env || process.env;
  const v = String(e.LUNA_GUEST_INTAKE_AI_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveReferenceDate(context) {
  const raw = context && context.reference_date;
  if (raw) {
    const d = new Date(String(raw));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(year, month, day) {
  if (!year || !month || !day || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseIsoDate(s) {
  const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function inferYear(month, day, ref) {
  const y = ref.getFullYear();
  const candidate = new Date(y, month - 1, day);
  if (candidate < ref) return y + 1;
  return y;
}

function parseNamedDate(text, ref) {
  const t = String(text || '').toLowerCase();
  const patterns = [
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zéûäöü]+)\b/i,
    /\b([a-zéûäöü]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let day; let monthName;
    if (/^\d/.test(m[1])) {
      day = Number(m[1]);
      monthName = m[2].toLowerCase();
    } else {
      monthName = m[1].toLowerCase();
      day = Number(m[2]);
    }
    const month = MONTH_MAP[monthName];
    if (!month) continue;
    const year = inferYear(month, day, ref);
    return toIsoDate(year, month, day);
  }
  return null;
}

function extractIsoDates(text) {
  const found = [];
  const re = /\b(\d{4}-\d{2}-\d{2})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const iso = parseIsoDate(m[1]);
    if (iso) found.push(iso);
  }
  return found;
}

function extractNamedDateRange(text, ref) {
  const t = String(text || '');
  const rangeRe = /([a-zéûäöü]+\s+\d{1,2}|\d{1,2}\s+[a-zéûäöü]+)\s*(?:to|until|through|-|–|—|al|au|bis|hasta)\s*([a-zéûäöü]+\s+\d{1,2}|\d{1,2}\s+[a-zéûäöü]+)/i;
  const rm = t.match(rangeRe);
  if (rm) {
    const checkIn  = parseNamedDate(rm[1], ref);
    const checkOut = parseNamedDate(rm[2], ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }
  const singles = [];
  const namedRe = /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[a-zéûäöü]+|[a-zéûäöü]+\s+\d{1,2}(?:st|nd|rd|th)?)\b/gi;
  let nm;
  while ((nm = namedRe.exec(t)) !== null) {
    const iso = parseNamedDate(nm[0], ref);
    if (iso) singles.push(iso);
  }
  if (singles.length >= 2) {
    return { check_in: singles[0], check_out: singles[1] };
  }
  if (singles.length === 1) {
    return { check_in: singles[0], check_out: null };
  }
  return { check_in: null, check_out: null };
}

function wordToGuestCount(word) {
  const w = String(word || '').toLowerCase();
  return WORD_NUMBERS[w] != null ? WORD_NUMBERS[w] : null;
}

function hasAvailabilityKeywords(text) {
  return AVAILABILITY_KEYWORDS_RE.test(String(text || ''));
}

function hasBookingHint(text) {
  return BOOKING_HINT_RE.test(String(text || ''));
}

function hasMonthHint(text) {
  const t = String(text || '').toLowerCase();
  return Object.keys(MONTH_MAP).some((name) => new RegExp(`\\b${name}\\b`, 'i').test(t));
}

function hasPartialBookingSignal(fields, text) {
  const msg = String(text || '');
  const hasAnchor = !!(fields.phone || fields.guests || fields.check_in || hasMonthHint(msg));
  if (!hasAnchor) return false;
  if (hasAvailabilityKeywords(msg) || hasBookingHint(msg)) return true;
  if (fields.guests && (!fields.check_in || !fields.check_out)) return true;
  return false;
}

function extractGuests(text) {
  const t = String(text || '').toLowerCase();
  const patterns = [
    /\b(\d{1,2})\s*(?:people|persons|guests|pax|persone|personas|personnes|gäste|gaste)\b/i,
    /\b(?:for|we are|we're|somos|siamo|nous sommes|wir sind)\s+(\d{1,2})\b/i,
    /\b(\d{1,2})\s*(?:persone|personas|personnes)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return Number(m[1]);
  }
  const ml = t.match(MULTILINGUAL_GUEST_RE);
  if (ml) {
    const n = wordToGuestCount(ml[1]);
    if (n) return n;
  }
  for (const re of MULTILINGUAL_GUEST_STANDALONE_RES) {
    const m = t.match(re);
    if (m) {
      const n = wordToGuestCount(m[1]);
      if (n) return n;
    }
  }
  for (const re of [
    /\bfor\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:people|guests|persons)\b/i,
    /\b(?:we are|we're)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  ]) {
    const m = t.match(re);
    if (m && WORD_NUMBERS[m[1].toLowerCase()]) return WORD_NUMBERS[m[1].toLowerCase()];
  }
  return null;
}

function extractPackageCode(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:custom\s+pack(?:age)?|custom)\b/.test(t)) return 'custom';
  if (/\bmalibu\b/.test(t)) return 'malibu';
  if (/\buluwatu\b/.test(t)) return 'uluwatu';
  if (/\bwaimea\b/.test(t)) return 'waimea';
  return null;
}

function extractPaymentChoice(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:pay(?:\s+the)?\s+deposit|deposit|dep[oó]sito|acconto|anzahlung|acompte)\b/.test(t)) {
    return 'deposit';
  }
  if (/\b(?:pay\s+in\s+full|full(?:\s+amount)?|pago\s+completo|pagare\s+tutto|voll(?:ständig)?|paiement\s+complet)\b/.test(t)) {
    return 'full';
  }
  return null;
}

function extractAddOns(text) {
  const t = String(text || '').toLowerCase();
  const found = new Set();
  if (/\b(?:meal|meals|dinner|d[iî]ner|food|cena|comida|repas|abendessen)\b/.test(t)) found.add('meal');
  if (/\b(?:yoga)\b/.test(t)) found.add('yoga');
  if (/\b(?:surf\s+lesson|surfstunde|lessons?|lezione|clase\s+de\s+surf|cours\s+de\s+surf)\b/.test(t)) found.add('surf_lesson');
  if (/\b(?:wetsuit|muta)\b/.test(t)) found.add('wetsuit');
  if (/\b(?:surfboard|soft\s+board|hard\s+board|board|tabla|planche)\b/.test(t)) found.add('surfboard');
  return [...found];
}

function detectLanguage(text, inputLang) {
  if (inputLang) return String(inputLang).trim().slice(0, 10) || 'en';
  const t = String(text || '').toLowerCase();
  if (/\b(?:hola|gracias|quiero|personas|septiembre)\b/.test(t)) return 'es';
  if (/\b(?:ciao|grazie|vorrei|persone|settembre)\b/.test(t)) return 'it';
  if (/\b(?:bonjour|merci|personnes|septembre)\b/.test(t)) return 'fr';
  if (/\b(?:hallo|danke|gäste|gaste|september)\b/.test(t)) return 'de';
  return 'en';
}

function detectIntent(text, fields) {
  if (HANDOFF_RE.test(text)) {
    if (/\b(?:refund|rimborso|reembolso|rückerstattung|remboursement)\b/i.test(text)) return 'cancel_request';
    if (/\bcomplaint|reclamaci[oó]n|reclamo\b/i.test(text)) return 'complaint';
    return 'human_request';
  }
  const incompleteDates = !fields.check_in || !fields.check_out;
  const partialAnchor = fields.phone || fields.guests || fields.check_in || hasMonthHint(text);
  if (hasAvailabilityKeywords(text) && incompleteDates && partialAnchor) {
    return 'availability_question';
  }
  if (fields.add_ons && fields.add_ons.length && !fields.package_code) return 'addon_request';
  if (fields.payment_choice && !fields.check_in) return 'payment_choice';
  if (fields.package_code && !fields.check_in && /\b(?:price|cost|how much|cuánto|quanto|combien|preis)\b/i.test(text)) {
    return 'price_question';
  }
  if (hasBookingHint(text) && partialAnchor && incompleteDates) return 'booking_inquiry';
  if (fields.check_in || fields.guests || fields.package_code) return 'booking_inquiry';
  return 'unknown';
}

function computeConfidence(fields, intent) {
  let score = 0.3;
  if (fields.phone) score += 0.1;
  if (fields.guests) score += 0.1;
  if (fields.check_in) score += 0.15;
  if (fields.check_out) score += 0.15;
  if (fields.package_code) score += 0.15;
  if (fields.payment_choice) score += 0.05;
  if (intent === 'human_request' || intent === 'cancel_request' || intent === 'complaint') score = 0.9;
  if (intent === 'unknown') score = Math.min(score, 0.4);
  return Math.min(1, Math.round(score * 100) / 100);
}

function computeNights(checkIn, checkOut) {
  const a = parseIsoDate(checkIn);
  const b = parseIsoDate(checkOut);
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms <= 0) return null;
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * Deterministic extraction from guest message + channel metadata.
 */
function extractLunaGuestMessageIntake(input, context = {}) {
  const src         = input || {};
  const clientSlug  = String(src.client_slug || DEFAULT_CLIENT).trim();
  const messageText = src.message_text != null ? String(src.message_text).trim() : '';
  const ref         = resolveReferenceDate(context);

  const phone = String(src.from || src.phone || src.guest_phone || '').trim() || null;
  const guestName = src.guest_name != null ? String(src.guest_name).trim() || null : null;
  const language = detectLanguage(messageText, src.language);

  if (!clientSlug) {
    return {
      success: false,
      error: 'client_slug required',
      ...INTAKE_SAFETY_FLAGS,
      extraction_source: 'deterministic',
    };
  }
  if (!messageText) {
    return {
      success: false,
      error: 'message_text required',
      ...INTAKE_SAFETY_FLAGS,
      extraction_source: 'deterministic',
      blocked_reasons: ['message_text_missing'],
    };
  }

  const isoDates = extractIsoDates(messageText);
  const namedRange = extractNamedDateRange(messageText, ref);
  let checkIn  = isoDates[0] || namedRange.check_in || null;
  let checkOut = isoDates[1] || namedRange.check_out || null;

  const guests         = extractGuests(messageText);
  const packageCode    = extractPackageCode(messageText);
  const paymentChoice  = extractPaymentChoice(messageText);
  const addOns         = extractAddOns(messageText);
  const handoffMatch   = HANDOFF_RE.test(messageText);

  const draft = {
    intent: null,
    confidence: 0,
    language,
    extraction_source: 'deterministic',
    guest_name: guestName,
    phone,
    check_in: checkIn,
    check_out: checkOut,
    nights: computeNights(checkIn, checkOut),
    guests,
    package_code: packageCode,
    room_preference: null,
    payment_choice: paymentChoice,
    add_ons: addOns,
    missing_fields: [],
    ask_next: null,
    handoff_required: false,
    handoff_reason: null,
  };

  draft.intent = detectIntent(messageText, draft);
  draft.confidence = computeConfidence(draft, draft.intent);

  if (handoffMatch || draft.intent === 'human_request' || draft.intent === 'cancel_request' || draft.intent === 'complaint') {
    draft.handoff_required = true;
    draft.handoff_reason = draft.intent === 'cancel_request'
      ? 'cancel_or_refund_request'
      : (draft.intent === 'complaint' ? 'complaint' : 'human_requested');
  }

  // Optional AI fallback hook — disabled by default (Phase 15b).
  if (isGuestIntakeAiEnabled(context.env) && typeof context.aiExtract === 'function') {
    draft.extraction_source = 'hybrid';
  }

  return {
    success: true,
    client_slug: clientSlug,
    channel: src.channel || 'whatsapp',
    message_text: messageText,
    ...INTAKE_SAFETY_FLAGS,
    ...draft,
  };
}

function buildMissingFields(extraction) {
  const missing = [];
  if (!extraction.phone) missing.push('phone');
  if (!extraction.check_in) missing.push('check_in');
  if (!extraction.check_out) missing.push('check_out');
  if (!extraction.guests) missing.push('guests');
  if (!extraction.package_code) missing.push('package_code');
  return missing;
}

function resolvePromptLanguage(language) {
  const code = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return ASK_NEXT_BY_LANG[code] ? code : 'en';
}

function buildAskNext(missingFields, language) {
  if (!missingFields || !missingFields.length) return null;
  const field = missingFields[0];
  const lang = resolvePromptLanguage(language);
  const prompts = ASK_NEXT_BY_LANG[lang] || ASK_NEXT_BY_LANG.en;
  if (field === 'check_in' || field === 'check_out') return prompts.dates;
  if (field === 'package_code') return prompts.package_code;
  if (field === 'guests') return prompts.guests;
  if (field === 'phone') return prompts.phone;
  const label = ASK_NEXT_LABELS[field] || field.replace(/_/g, ' ');
  return `Could you share ${label}?`;
}

/**
 * Validate extraction; may set handoff, missing_fields, ask_next.
 */
function validateLunaGuestMessageIntake(extraction, context = {}) {
  const ex = Object.assign({}, extraction || {});
  const errors = [];
  const warnings = [];

  if (!ex.client_slug) errors.push('client_slug_required');
  if (!ex.message_text) errors.push('message_text_required');

  if (ex.guests != null && (Number(ex.guests) < 1 || !Number.isFinite(Number(ex.guests)))) {
    errors.push('invalid_guest_count');
    ex.guests = null;
  }

  if (ex.package_code && !KNOWN_PACKAGE_CODES.has(ex.package_code)) {
    errors.push('unknown_package_code');
    ex.package_code = null;
  }

  if (ex.payment_choice && !VALID_PAYMENT_CHOICES.has(ex.payment_choice)) {
    errors.push('invalid_payment_choice');
    ex.payment_choice = null;
  }

  if (Array.isArray(ex.add_ons)) {
    ex.add_ons = ex.add_ons.filter((a) => KNOWN_ADDON_TYPES.has(a));
  } else {
    ex.add_ons = [];
  }

  if (ex.check_in && ex.check_out) {
    const a = parseIsoDate(ex.check_in);
    const b = parseIsoDate(ex.check_out);
    if (!a || !b || b <= a) {
      errors.push('invalid_date_range');
      ex.check_out = null;
      ex.nights = null;
    } else {
      ex.nights = computeNights(ex.check_in, ex.check_out);
    }
  }

  const confidenceMin = Number(context.confidence_min) || 0.45;

  // Phase 15c — partial multilingual inquiries: prefer ask_next over low-confidence handoff.
  if (!ex.handoff_required && ex.intent === 'unknown' && hasPartialBookingSignal(ex, ex.message_text)) {
    ex.intent = hasAvailabilityKeywords(ex.message_text) ? 'availability_question' : 'booking_inquiry';
    ex.confidence = Math.max(Number(ex.confidence) || 0, confidenceMin);
    ex.handoff_required = false;
    ex.handoff_reason = null;
  }

  if (!ex.handoff_required
    && ex.intent === 'unknown'
    && ex.confidence < confidenceMin
    && !hasPartialBookingSignal(ex, ex.message_text)) {
    ex.handoff_required = true;
    ex.handoff_reason = 'low_confidence';
  }

  if (PARTIAL_INTENTS.has(ex.intent)) {
    ex.handoff_required = false;
    ex.handoff_reason = null;
  }

  if (!ex.handoff_required) {
    ex.missing_fields = buildMissingFields(ex);
    if (ex.missing_fields.length) {
      ex.ask_next = buildAskNext(ex.missing_fields, ex.language);
    } else {
      ex.ask_next = null;
    }
  }

  const valid = errors.length === 0 && ex.success !== false;

  return {
    valid,
    errors,
    warnings,
    extraction: ex,
    can_chain_dry_run: valid
      && !ex.handoff_required
      && DRY_RUN_CHAIN_FIELDS.every((f) => {
        if (f === 'guests') return ex.guests != null && ex.guests >= 1;
        if (f === 'phone') return !!ex.phone;
        return !!ex[f];
      }),
  };
}

function buildDryRunInputFromIntake(extraction, input = {}) {
  const ex = extraction || {};
  const src = input || {};
  return {
    client_slug:    ex.client_slug || src.client_slug || DEFAULT_CLIENT,
    guest_name:     ex.guest_name || src.guest_name || '',
    language:       ex.language || src.language || 'en',
    check_in:       ex.check_in || '',
    check_out:      ex.check_out || '',
    guest_count:    ex.guests,
    package_code:   ex.package_code,
    room_type:      'shared',
    payment_choice: ex.payment_choice || '',
    phone:          ex.phone || src.from || '',
    from:           ex.phone || src.from || '',
    add_ons:        ex.add_ons || [],
    message_text:   ex.message_text || src.message_text || null,
    conversation_id: src.conversation_id || null,
    source:         'luna_message_intake_preview',
  };
}

function hasEnoughFieldsForDryRun(extraction) {
  const v = validateLunaGuestMessageIntake(extraction);
  return v.can_chain_dry_run;
}

module.exports = {
  extractLunaGuestMessageIntake,
  validateLunaGuestMessageIntake,
  buildDryRunInputFromIntake,
  hasEnoughFieldsForDryRun,
  isGuestIntakeAiEnabled,
  INTAKE_SAFETY_FLAGS,
  KNOWN_PACKAGE_CODES,
  KNOWN_ADDON_TYPES,
  DRY_RUN_CHAIN_FIELDS,
};
