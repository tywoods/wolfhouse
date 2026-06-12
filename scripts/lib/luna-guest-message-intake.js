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
  luglo: 7, luglioo: 7,
  julyy: 7,
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

/** "solo alloggio" / "solo stay" — accommodation-only, not guest_count=1. */
function isSoloAccommodationStayPhrase(text) {
  const t = String(text || '').toLowerCase();
  return /\b(?:solo|solamente|sólo|only|just)\s+(?:alloggio|alojamiento|il\s+soggiorno|estad[ií]a|estancia|accommodation|the\s+stay|stay|pernottamento)\b/i.test(t)
    || /\b(?:only|just)\s+the\s+stay\b/i.test(t)
    || /\bno\s+pack(?:age)?[,.\s]+(?:solo|only)\s+stay\b/i.test(t);
}

/** Accommodation-only / no-package stay phrasing (not guest_count=1). */
function detectStayAccommodationOnlyText(text) {
  const t = String(text || '').toLowerCase();
  if (isSoloAccommodationStayPhrase(t)) return true;
  return /\b(?:accommodation\s+only|room\s+only|just\s+accommodation|just\s+the\s+stay|only\s+stay|stay\s+only)\b/i.test(t)
    || /\bno\s+pack(?:age)?\s+just\s+stay\b/i.test(t)
    || /\bnur\s+(?:unterkunft|übernachtung|uebernachtung)\b/i.test(t);
}

/** Guest messages that select a package tier — never valid booking names. */
function isPackageTierGuestMessage(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (extractPackageCode(t) || inferPackageFromGearSignals(t)) return true;
  return /\b(?:stay\s+only|gear\s+included|lessons?\s+included|accommodation\s+only|room\s+only|just\s+(?:the\s+)?(?:stay|accommodation))\b/i.test(t)
    || /^(?:malibu|uluwatu|waimea)$/i.test(t);
}

/** Strip emoji + normalize common hammer-test date typos before parsing. */
function normalizeHammerDateText(text) {
  return String(text || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\bjulyy\b/gi, 'july')
    .replace(/\bjulyyy\b/gi, 'july')
    .replace(/\bluglioo\b/gi, 'luglio')
    .replace(/\bluglo\b/gi, 'luglio')
    .replace(/\bsiamoo\b/gi, 'siamo')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Valid solo-traveller guest count (not accommodation-only "solo"). */
function isSoloTravellerGuestCountPhrase(text) {
  const t = String(text || '').toLowerCase();
  if (isSoloAccommodationStayPhrase(t)) return false;
  return /\b(?:solo\s+(?:io|travell(?:er|er)?)|sono\s+solo|vengo\s+da\s+solo|viajo\s+solo|voy\s+solo)\b/i.test(t)
    || /\b(?:just me|only me|one person|1 person)\b/i.test(t)
    || /^(?:me|solo)$/i.test(t.trim());
}

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
  const refMonth = ref.getMonth() + 1;
  const refDay = ref.getDate();
  // Calendar-day compare avoids timezone skew (e.g. June 11 ref vs June 11 check-in same year).
  if (month > refMonth || (month === refMonth && day >= refDay)) return y;
  return y + 1;
}

function monthFromName(name) {
  return MONTH_MAP[String(name || '').toLowerCase()] || null;
}

function dayMonthToIso(day, month, ref) {
  if (!month || !day) return null;
  return toIsoDate(inferYear(month, day, ref), month, day);
}

function parseYearFromText(text) {
  const m = String(text || '').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

function dayMonthYearToIso(day, month, year, ref) {
  if (!month || !day) return null;
  const y = year || inferYear(month, day, ref);
  return toIsoDate(y, month, day);
}

function parseNamedDate(text, ref) {
  const t = String(text || '').toLowerCase();
  const explicitYear = parseYearFromText(t);
  const patterns = [
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-zéûäöüáíóúñ]+)\b/i,
    /\b([a-zéûäöüáíóúñ]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
    // Phase 15e.2 — ES day de month, DE day. month
    /\b(\d{1,2})\s+de\s+([a-záéíóúüñ]+)\b/i,
    /\b(\d{1,2})\.\s*([a-zäöüß]+)\b/i,
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
    const month = monthFromName(monthName);
    if (!month) continue;
    return dayMonthYearToIso(day, month, explicitYear, ref);
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

/**
 * Slash date ranges — Wolfhouse/Europe default: DD/MM when ambiguous (Stage 27test-m).
 * e.g. 10/7 to 17/7 → 10 Jul–17 Jul; 7/10 to 7/17 → shared-month M/D (Jul 10–17).
 */
function extractSlashDateRange(text, ref) {
  const t = String(text || '');
  const explicitYear = parseYearFromText(t);
  const patterns = [
    /\b(\d{1,2})\/(\d{1,2})\s*(?:to|thru|through|–|-)\s*(\d{1,2})\/(\d{1,2})\b/i,
    /\b(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const a1 = Number(m[1]);
    const b1 = Number(m[2]);
    const a2 = Number(m[3]);
    const b2 = Number(m[4]);
    let dayIn; let monthIn; let dayOut; let monthOut;
    if (b1 === b2 && b1 >= 1 && b1 <= 12) {
      dayIn = a1; monthIn = b1;
      dayOut = a2; monthOut = b2;
    } else if (a1 === a2 && a1 >= 1 && a1 <= 12) {
      monthIn = a1; dayIn = b1;
      monthOut = a2; dayOut = b2;
    } else {
      dayIn = a1; monthIn = b1;
      dayOut = a2; monthOut = b2;
    }
    const checkIn = dayMonthYearToIso(dayIn, monthIn, explicitYear, ref);
    const checkOut = dayMonthYearToIso(dayOut, monthOut, explicitYear, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }
  return null;
}

function extractNamedDateRange(text, ref) {
  const t = normalizeHammerDateText(text);
  const explicitYear = parseYearFromText(t);

  const slashRange = extractSlashDateRange(t, ref);
  if (slashRange) return slashRange;

  // EN compact — jul 10 thru jul 17 / july 1st to 5th / julyy 10-17 / July 1 - 5
  const MONTH_ALT = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|julyy|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const enCompactMonthFirst = t.match(
    new RegExp(`\\b(?:from\\s+|for\\s+)?(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:thru|through|to|–|-)\\s*(?:(${MONTH_ALT})\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
  );
  if (enCompactMonthFirst) {
    const monthIn = monthFromName(enCompactMonthFirst[1]);
    const monthOut = enCompactMonthFirst[3] ? monthFromName(enCompactMonthFirst[3]) : monthIn;
    const year = explicitYear;
    const checkIn = dayMonthYearToIso(Number(enCompactMonthFirst[2]), monthIn, year, ref);
    const checkOut = dayMonthYearToIso(Number(enCompactMonthFirst[4]), monthOut || monthIn, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // EN compact — 10 jul to 17 jul
  const enCompactDayFirst = t.match(
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:to|thru|through|–|-)\s*(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  );
  if (enCompactDayFirst) {
    const m1 = monthFromName(enCompactDayFirst[2]);
    const m2 = monthFromName(enCompactDayFirst[4]);
    const month = m2 || m1;
    const year = explicitYear;
    const checkIn = dayMonthYearToIso(Number(enCompactDayFirst[1]), m1 || month, year, ref);
    const checkOut = dayMonthYearToIso(Number(enCompactDayFirst[3]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // IT — dal 10 al 17 luglio 2026
  const itRange = t.match(
    /\b(?:dal|da)\s+(\d{1,2})\s+al\s+(\d{1,2})\s+([a-zàèéìòù]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (itRange) {
    const month = monthFromName(itRange[3]);
    const year = itRange[4] ? Number(itRange[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(itRange[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(itRange[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // IT — dal 1 luglio al 5 / dal 1 luglo al 5 (optional trailing month)
  const itDalAl = t.match(
    /\b(?:dal|da)\s+(\d{1,2})\s+([a-zàèéìòù]+)\s+al\s+(\d{1,2})(?:\s+([a-zàèéìòù]+))?(?:\s+(20\d{2}))?\b/i,
  );
  if (itDalAl) {
    const m1 = monthFromName(itDalAl[2]);
    const m2 = itDalAl[4] ? monthFromName(itDalAl[4]) : m1;
    const year = itDalAl[5] ? Number(itDalAl[5]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(itDalAl[1]), m1, year, ref);
    const checkOut = dayMonthYearToIso(Number(itDalAl[3]), m2 || m1, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // IT compact — 1-5 luglio / 10-17 luglio
  const itCompactDayMonth = t.match(
    /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([a-zàèéìòù]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (itCompactDayMonth) {
    const month = monthFromName(itCompactDayMonth[3]);
    const year = itCompactDayMonth[4] ? Number(itCompactDayMonth[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(itCompactDayMonth[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(itCompactDayMonth[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // IT — 1 luglio al 5 luglio
  const itDayToDay = t.match(
    /\b(\d{1,2})\s+([a-zàèéìòù]+)\s+al\s+(\d{1,2})\s+([a-zàèéìòù]+)\b/i,
  );
  if (itDayToDay) {
    const m1 = monthFromName(itDayToDay[2]);
    const m2 = monthFromName(itDayToDay[4]);
    const month = m2 || m1;
    const checkIn = dayMonthYearToIso(Number(itDayToDay[1]), m1 || month, explicitYear, ref);
    const checkOut = dayMonthYearToIso(Number(itDayToDay[3]), month, explicitYear, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // IT/ES slash+month — 1/5 luglio
  const slashSingleMonth = t.match(/\b(\d{1,2})\/(\d{1,2})\s+([a-zàèéìòùáéíóúüñ]+)\b/i);
  if (slashSingleMonth) {
    const month = monthFromName(slashSingleMonth[3]);
    const checkIn = dayMonthYearToIso(Number(slashSingleMonth[1]), month, explicitYear, ref);
    const checkOut = dayMonthYearToIso(Number(slashSingleMonth[2]), month, explicitYear, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // ES — del 10 al 17 de julio de 2026
  const esRangeSingleMonth = t.match(
    /\b(?:del|de)\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúüñ]+)(?:\s+de\s+(20\d{2}))?\b/i,
  );
  if (esRangeSingleMonth) {
    const month = monthFromName(esRangeSingleMonth[3]);
    const year = esRangeSingleMonth[4] ? Number(esRangeSingleMonth[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(esRangeSingleMonth[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(esRangeSingleMonth[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // ES compact — 1-5 julio / 10-17 julio
  const esCompactDayMonth = t.match(
    /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúüñ]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (esCompactDayMonth) {
    const month = monthFromName(esCompactDayMonth[3]);
    const year = esCompactDayMonth[4] ? Number(esCompactDayMonth[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(esCompactDayMonth[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(esCompactDayMonth[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // ES — del 1 al 5 julio (without "de" before month)
  const esDelAlMonth = t.match(
    /\b(?:del|de)\s+(\d{1,2})\s+al\s+(\d{1,2})\s+([a-záéíóúüñ]+)(?:\s+de\s+(20\d{2}))?\b/i,
  );
  if (esDelAlMonth) {
    const month = monthFromName(esDelAlMonth[3]);
    const year = esDelAlMonth[4] ? Number(esDelAlMonth[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(esDelAlMonth[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(esDelAlMonth[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // Phase 15e.2 — ES native: del/de 24 de septiembre al/a 27 de septiembre
  const esRange = t.match(
    /\b(?:del|de)\s+(\d{1,2})\s+de\s+([a-záéíóúüñ]+)\s+(?:al|a)\s+(\d{1,2})\s+de\s+([a-záéíóúüñ]+)\b/i,
  );
  if (esRange) {
    const m1 = monthFromName(esRange[2]);
    const m2 = monthFromName(esRange[4]);
    const checkIn  = dayMonthYearToIso(Number(esRange[1]), m1, explicitYear, ref);
    const checkOut = dayMonthYearToIso(Number(esRange[3]), m2, explicitYear, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // FR — du 10 au 17 juillet 2026
  const frRange = t.match(
    /\bdu\s+(\d{1,2})\s+au\s+(\d{1,2})\s+([a-zàâäéèêëïîôùûüç]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (frRange) {
    const month = monthFromName(frRange[3]);
    const year = frRange[4] ? Number(frRange[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(frRange[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(frRange[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // DE — 10. bis 17. Juli 2026
  const deRangeCompact = t.match(
    /\b(\d{1,2})\.\s*bis\s+(\d{1,2})\.\s*([a-zäöüß]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (deRangeCompact) {
    const month = monthFromName(deRangeCompact[3]);
    const year = deRangeCompact[4] ? Number(deRangeCompact[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(deRangeCompact[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(deRangeCompact[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // DE — vom 10. bis 17. Juli 2026
  const deRangeVom = t.match(
    /\b(?:vom|von)\s+(\d{1,2})\.\s*bis\s+(\d{1,2})\.\s*([a-zäöüß]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (deRangeVom) {
    const month = monthFromName(deRangeVom[3]);
    const year = deRangeVom[4] ? Number(deRangeVom[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(deRangeVom[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(deRangeVom[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // DE — vom 10. bis 17. Juli (single trailing month)
  const deVomBisMonth = t.match(
    /\b(?:vom|von)\s+(\d{1,2})\.?\s*bis\s+(\d{1,2})\.?\s+([a-zäöüß]+)(?:\s+(20\d{2}))?\b/i,
  );
  if (deVomBisMonth) {
    const month = monthFromName(deVomBisMonth[3]);
    const year = deVomBisMonth[4] ? Number(deVomBisMonth[4]) : explicitYear;
    const checkIn = dayMonthYearToIso(Number(deVomBisMonth[1]), month, year, ref);
    const checkOut = dayMonthYearToIso(Number(deVomBisMonth[2]), month, year, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  // Phase 15e.2 — DE native: vom/von 24. September bis 27. September
  const deRange = t.match(
    /\b(?:vom|von)\s+(\d{1,2})\.?\s*([a-zäöüß]+)\s+bis\s+(\d{1,2})\.?\s*([a-zäöüß]+)\b/i,
  );
  if (deRange) {
    const m1 = monthFromName(deRange[2]);
    const m2 = monthFromName(deRange[4]);
    const checkIn  = dayMonthYearToIso(Number(deRange[1]), m1, explicitYear, ref);
    const checkOut = dayMonthYearToIso(Number(deRange[3]), m2, explicitYear, ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }

  const rangeRe = /([a-zéûäöüáíóúñ]+\s+\d{1,2}|\d{1,2}\s+[a-zéûäöüáíóúñ]+|\d{1,2}\.\s*[a-zäöüß]+)\s*(?:to|until|through|-|–|—|al|au|bis|hasta)\s*([a-zéûäöüáíóúñ]+\s+\d{1,2}|\d{1,2}\s+[a-zéûäöüáíóúñ]+|\d{1,2}\.\s*[a-zäöüß]+)/i;
  const rm = t.match(rangeRe);
  if (rm) {
    const checkIn  = parseNamedDate(rm[1], ref);
    const checkOut = parseNamedDate(rm[2], ref);
    if (checkIn && checkOut) return { check_in: checkIn, check_out: checkOut };
  }
  const singles = [];
  const namedRe = /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[a-zéûäöüáíóúñ]+|\d{1,2}\s+de\s+[a-záéíóúüñ]+|\d{1,2}\.\s*[a-zäöüß]+|[a-zéûäöüáíóúñ]+\s+\d{1,2}(?:st|nd|rd|th)?)\b/gi;
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

function parseIsoDateParts(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * Guest answered with a day only ("15th", "the 15th") while check-in is already known.
 * Infer checkout in the same month/year as check-in.
 */
function inferCheckoutDayFromPriorCheckIn(text, checkInIso, ref) {
  const checkIn = parseIsoDateParts(checkInIso);
  if (!checkIn) return null;
  const t = normalizeHammerDateText(text).trim();
  if (!t) return null;

  const MONTH_ALT = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  const monthDay = t.match(
    new RegExp(`^(?:the\\s+)?(?:on\\s+)?(${MONTH_ALT})?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\.?$`, 'i'),
  );
  if (!monthDay) return null;

  const monthToken = monthDay[1] ? monthFromName(monthDay[1]) : checkIn.month;
  const day = Number(monthDay[2]);
  if (!monthToken || !Number.isFinite(day) || day < 1 || day > 31) return null;

  const year = checkIn.year;
  const checkOut = dayMonthYearToIso(day, monthToken, year, ref);
  if (!checkOut) return null;

  const outParts = parseIsoDateParts(checkOut);
  const inParts = parseIsoDateParts(checkInIso);
  if (outParts && inParts) {
    const outKey = outParts.year * 10000 + outParts.month * 100 + outParts.day;
    const inKey = inParts.year * 10000 + inParts.month * 100 + inParts.day;
    if (outKey <= inKey) return null;
  }
  return checkOut;
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
  if (isSoloTravellerGuestCountPhrase(t)) return 1;
  if (/^(?:me)$/i.test(t.trim())) return 1;
  if (/\btwo\s+of\s+us\b/i.test(t)) return 2;
  if (/\bcouple\b/i.test(t)) return 2;
  if (/\bme and my (?:partner|girlfriend|boyfriend|friend|wife|husband)\b/i.test(t)) return 2;
  const familyOf = t.match(/\bfamily of (\d{1,2})\b/i);
  if (familyOf) return Number(familyOf[1]);
  const patterns = [
    /\b(\d{1,2})\s+of\s+us\b/i,
    /\b(\d{1,2})\s+ppl\b/i,
    /\b(\d{1,2})\s*(?:people|persons|guests|pax|persone|personas|personnes|gäste|gaste)\b/i,
    /\b(?:for|per|para|pour|für|we are|we're|somos|siamo{1,2}|nous sommes|wir sind|wir w(?:ä|a)ren)\s+(\d{1,2})\b/i,
    /\b(?:siamo+|somos+)\s+in\s+(\d{1,2})\b/i,
    /\bsiamo\s+(due|tre|quattro|cinque)\b/i,
    /\bsiamo\s+(\d{1,2})\s+non\s+(\d{1,2})\b/i,
    /\bsiamo\s+in\s+(due|tre|quattro|cinque|\d{1,2})\b/i,
    /\b(\d{1,2})\s*(?:persone|personas|personnes|personen)\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      if (m[1] && !/^\d+$/.test(m[1])) {
        const n = wordToGuestCount(m[1]);
        if (n) return n;
      }
      return Number(m[1]);
    }
  }
  const zuCount = t.match(/\bwir\s+sind\s+zu\s+(zweit|dritt|viert|fünft|funft)\b/i);
  if (zuCount) {
    const map = { zweit: 2, dritt: 3, viert: 4, fünft: 5, funft: 5 };
    return map[zuCount[1].toLowerCase()] || null;
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

/** Parse a short guest-name answer when Luna asked for the booking name. */
function parseGuestNameAnswer(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 60) return null;
  if (/^\d+$/.test(raw)) return null;
  if (isSoloAccommodationStayPhrase(raw)) return null;
  if (isPackageTierGuestMessage(raw)) return null;
  if (/\b(?:deposit|full(?:\s+payment)?|just\s+(?:me|the\s+stay)|accommodation(?:\s+only)?|no\s+package|no\s+add(?:\s+|-)?nothing|nothing\s+extra|no\s+extras?|i\s+have\s+my\s+own(?:\s+stuff)?|malibu|uluwatu|waimea|wetsuit|surfboard|lessons?|yoga|book(?:ing)?\s+(?:a\s+)?stay)\b/i.test(raw)) {
    return null;
  }
  if (/^(?:hi|hello|hey|thanks|thank\s+you|yes|no|ok(?:ay)?|sure)$/i.test(raw)) return null;

  const clean = (s) => {
    const t = String(s || '').trim().replace(/\s+/g, ' ');
    if (!t || t.length < 1 || t.length > 50) return null;
    return t;
  };

  const im = raw.match(/\b(?:i'?m|i\s+am)\s+([a-z][a-z'\- ]{0,40})/i);
  if (im) return clean(im[1]);

  const nameIs = raw.match(/\b(?:my\s+name\s+is|name\s+is|call\s+me|it'?s)\s+([a-z][a-z'\- ]{0,40})/i);
  if (nameIs) return clean(nameIs[1]);

  if (/^[a-z][a-z'\-]*(?:\s+[a-z][a-z'\-]*){0,2}$/i.test(raw) && raw.split(/\s+/).length <= 3) {
    return clean(raw);
  }
  return null;
}

function extractPackageCode(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:custom\s+pack(?:age)?|custom)\b/.test(t)) return 'custom';
  if (/\b(?:malibu(?:\s*[-–]?\s*paket)?|paket\s+malibu)\b/.test(t)) return 'malibu';
  if (/\b(?:uluwatu(?:\s*[-–]?\s*paket)?|paket\s+uluwatu)\b/.test(t)) return 'uluwatu';
  if (/\b(?:waimea(?:\s*[-–]?\s*paket)?|paket\s+waimea)\b/.test(t)) return 'waimea';
  if (/\bmalibu\b/.test(t)) return 'malibu';
  if (/\buluwatu\b/.test(t)) return 'uluwatu';
  if (/\bwaimea\b/.test(t)) return 'waimea';
  return null;
}

/** Infer weekly package from gear language when guest does not name a package code. */
function inferPackageFromGearSignals(text) {
  const explicit = extractPackageCode(text);
  if (explicit) return explicit;

  const t = String(text || '').toLowerCase();
  const hasWetsuit = /\b(?:wetsuit|wesuit|muta|neopren)\b/.test(t);
  const hasBoard = /\b(?:surfboards?|surf\s+boards?|soft\s+board|hard\s+board|tabla(?:\s+de\s+surf)?|tavola|planche)\b/.test(t)
    || (/\bboard\b/.test(t) && /\b(?:surf|wetsuit|wesuit|gear|rental)\b/.test(t));
  const hasLessons = /\b(?:surf\s+lessons?|lessons?|surfstunde|surfunterricht|surfkurs|lezioni|clase(?:s)?\s+de\s+surf|clases?\s+de\s+surf|cours\s+de\s+surf)\b/.test(t);
  const stayOnly = /\b(?:stay\s+only|accommodation\s+only|just\s+(?:the\s+)?(?:stay|room|accommodation)|room\s+only|only\s+(?:the\s+)?stay)\b/.test(t)
    || /\b(?:no\s+(?:lessons?|surf\s+lessons?)|without\s+lessons?)\b/.test(t);
  const gearIncluded = /\bgear\s+included\b/.test(t);
  const lessonsIncluded = /\blessons?\s+included\b/.test(t);

  if (stayOnly && !hasLessons && !hasBoard && !hasWetsuit) return 'malibu';
  if (lessonsIncluded) return 'waimea';
  if (gearIncluded) return 'uluwatu';
  if (hasLessons) return 'waimea';
  if (hasBoard && hasWetsuit) return 'uluwatu';
  if ((hasBoard || hasWetsuit) && /\b(?:need|want|yes|yeah|yea|i\s+need)\b/.test(t)) return 'uluwatu';
  return null;
}

function detectPackageMutationIntent(text) {
  const t = String(text || '');
  if (!/\b(?:switch|change|make it|instead|rather|actually)\b/i.test(t)) return null;
  const pkg = extractPackageCode(t);
  if (!pkg) return null;
  if (/\b(?:switch|change|make it|instead)\b/i.test(t)) return pkg;
  if (/\bactually\b/i.test(t) && pkg) return pkg;
  return null;
}

function extractPaymentChoice(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(?:pay(?:\s+the)?\s+deposit|deposit|dep[oó]sito|deposito|acconto|anzahlung|l'?acompte|acompte)\b/.test(t)) {
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
  if (/\b(?:surf\s+lesson|surfstunde|surfunterricht|surfkurs|lessons?|lezione|lezioni|clase(?:s)?\s+de\s+surf|clases?\s+de\s+surf|cours\s+de\s+surf)\b/.test(t)) found.add('surf_lesson');
  if (/\b(?:wetsuit|wesuit|muta)\b/.test(t)) found.add('wetsuit');
  if (/\b(?:surfboard|soft\s+board|hard\s+board|board|tabla|tavola|planche)\b/.test(t)) found.add('surfboard');
  return [...found];
}

function detectLanguage(text, inputLang) {
  if (inputLang) return String(inputLang).trim().slice(0, 10) || 'en';
  const t = String(text || '').toLowerCase();
  if (/\b(?:hola|gracias|quiero|personas|septiembre)\b/.test(t)) return 'es';
  if (/\b(?:ciao|grazie|vorrei|persone|settembre)\b/.test(t)) return 'it';
  if (/\b(?:bonjour|merci|personnes|septembre)\b/.test(t)) return 'fr';
  if (/\b(?:hallo|danke|gäste|gaste|anzahlung|buch(?:en)?|personen|übernachtung|unterkunft|möchten|moechten)\b/.test(t)) return 'de';
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
  const messageText = normalizeHammerDateText(
    src.message_text != null ? String(src.message_text).trim() : '',
  );
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
  const packageCode    = extractPackageCode(messageText) || inferPackageFromGearSignals(messageText);
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
  detectPackageMutationIntent,
  inferPackageFromGearSignals,
  extractPackageCode,
  parseGuestNameAnswer,
  isSoloAccommodationStayPhrase,
  isSoloTravellerGuestCountPhrase,
  detectStayAccommodationOnlyText,
  isPackageTierGuestMessage,
  normalizeHammerDateText,
  inferCheckoutDayFromPriorCheckIn,
  INTAKE_SAFETY_FLAGS,
  KNOWN_PACKAGE_CODES,
  KNOWN_ADDON_TYPES,
  DRY_RUN_CHAIN_FIELDS,
};
