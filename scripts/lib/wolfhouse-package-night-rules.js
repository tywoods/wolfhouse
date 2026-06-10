'use strict';

/**
 * Stage 28i.1 — Weekly surf-package stay rules (Malibu / Uluwatu / Waimea).
 *
 * Shared by Luna guest intake and Staff Portal manual booking.
 * Weekly surf packages require a 7-night stay (half-open check_in → check_out).
 */

const { buildPackageExplainerReply } = require('./luna-guest-package-explainer');

const WEEKLY_SURF_PACKAGES = new Set(['malibu', 'uluwatu', 'waimea']);
const WEEKLY_PACKAGE_MIN_NIGHTS = 7;

const STAFF_PACKAGE_VALIDATION_MSG =
  'Packages require a 7-night stay. For shorter stays, use accommodation/services/add-ons instead.';

function normalizePackageCode(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c || c === 'package_none' || c === 'no_package') return null;
  if (c === 'accommodation_only' || c === 'custom') return c;
  return c;
}

function isWeeklySurfPackage(code) {
  const c = normalizePackageCode(code);
  return c != null && WEEKLY_SURF_PACKAGES.has(c);
}

function isAccommodationOnlyIntent(code) {
  const c = normalizePackageCode(code);
  return c === 'accommodation_only' || c === 'no_package' || c === 'custom';
}

/** Half-open stay length: check_out − check_in in calendar days. */
function computeStayNights(checkIn, checkOut) {
  if (!checkIn || !checkOut) return null;
  const a = new Date(`${String(checkIn).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(checkOut).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const ms = b.getTime() - a.getTime();
  if (ms <= 0) return null;
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

/**
 * Evaluate package-night eligibility for a booking intake context.
 *
 * @param {object} fields  extracted_fields { check_in, check_out, package_interest }
 * @param {object} [options]
 * @param {boolean} [options.guest_directly_named_package]  guest named Malibu/Uluwatu/Waimea this turn
 * @returns {object}
 */
function evaluatePackageNightContext(fields, options) {
  const opts = options || {};
  const extracted = fields || {};
  const nights = computeStayNights(extracted.check_in, extracted.check_out);
  const pkg = normalizePackageCode(extracted.package_interest);
  const hasDates = nights != null;
  const guestDirect = opts.guest_directly_named_package === true;

  if (!hasDates) {
    return {
      nights: null,
      rule: 'defer_dates_unknown',
      package_code: pkg,
      blocks_weekly_package_quote: false,
      needs_short_stay_guidance: false,
      needs_package_explanation: false,
      ready_for_package_quote: false,
    };
  }

  if (isWeeklySurfPackage(pkg) && nights < WEEKLY_PACKAGE_MIN_NIGHTS) {
    return {
      nights,
      rule: 'weekly_package_blocked',
      package_code: pkg,
      blocks_weekly_package_quote: true,
      needs_short_stay_guidance: true,
      needs_package_explanation: false,
      ready_for_package_quote: false,
    };
  }

  if (nights < WEEKLY_PACKAGE_MIN_NIGHTS) {
    const hasStayIntent = isAccommodationOnlyIntent(pkg);
    return {
      nights,
      rule: hasStayIntent ? 'short_stay_accommodation' : 'short_stay_guidance',
      package_code: pkg,
      blocks_weekly_package_quote: false,
      needs_short_stay_guidance: !hasStayIntent,
      needs_package_explanation: false,
      ready_for_package_quote: hasStayIntent,
    };
  }

  // nights >= 7
  if (isWeeklySurfPackage(pkg)) {
    return {
      nights,
      rule: guestDirect ? 'weekly_direct_choice' : 'weekly_ready',
      package_code: pkg,
      blocks_weekly_package_quote: false,
      needs_short_stay_guidance: false,
      needs_package_explanation: false,
      ready_for_package_quote: true,
    };
  }

  if (isAccommodationOnlyIntent(pkg)) {
    return {
      nights,
      rule: 'weekly_accommodation_only',
      package_code: pkg,
      blocks_weekly_package_quote: false,
      needs_short_stay_guidance: false,
      needs_package_explanation: false,
      ready_for_package_quote: true,
    };
  }

  // 7+ nights, package not chosen yet
  return {
    nights,
    rule: guestDirect ? 'weekly_direct_choice' : 'weekly_explain_before_choice',
    package_code: null,
    blocks_weekly_package_quote: false,
    needs_short_stay_guidance: false,
    needs_package_explanation: !guestDirect,
    ready_for_package_quote: false,
  };
}

function validateStaffPackageNightRule(checkIn, checkOut, packageCode) {
  const nights = computeStayNights(checkIn, checkOut);
  const pkg = normalizePackageCode(packageCode);
  if (nights != null && isWeeklySurfPackage(pkg) && nights < WEEKLY_PACKAGE_MIN_NIGHTS) {
    return { ok: false, error: STAFF_PACKAGE_VALIDATION_MSG, nights, package_code: pkg };
  }
  return { ok: true, nights, package_code: pkg };
}

const LUNA_REPLIES = {
  en: {
    weekly_blocked: (pkg) => `For stays under 7 nights, we don't book the Malibu/Uluwatu/Waimea weekly packages${pkg ? ` (including ${pkg.charAt(0).toUpperCase() + pkg.slice(1)})` : ''}. We can still help with accommodation and add-ons like wetsuit, board rental, or surf lessons. Would you like accommodation only, or do you want to add lessons/gear?`,
    short_stay_guidance: 'For stays under 7 nights, our weekly surf packages (Malibu, Uluwatu, Waimea) aren\'t available — they\'re for 7-night stays. We can still help with accommodation and add-ons like wetsuit, board rental, or surf lessons. Would you like accommodation only, or do you want to add lessons/gear?',
    explain_choice: 'Which one sounds best: Malibu, Uluwatu, or Waimea?',
  },
  it: {
    weekly_blocked: (pkg) => `Per soggiorni sotto le 7 notti non prenotiamo i pacchetti settimanali Malibu/Uluwatu/Waimea${pkg ? ` (incluso ${pkg.charAt(0).toUpperCase() + pkg.slice(1)})` : ''}. Possiamo comunque aiutarti con pernottamento e extra come muta, noleggio tavola o lezioni di surf. Preferisci solo pernottamento o vuoi aggiungere lezioni/attrezzatura?`,
    short_stay_guidance: 'Per soggiorni sotto le 7 notti i pacchetti surf settimanali (Malibu, Uluwatu, Waimea) non sono disponibili — sono per 7 notti. Possiamo comunque aiutarti con pernottamento e extra come muta, noleggio tavola o lezioni. Preferisci solo pernottamento o vuoi aggiungere lezioni/attrezzatura?',
    explain_choice: 'Quale ti sembra più adatto: Malibu, Uluwatu o Waimea?',
  },
  es: {
    weekly_blocked: (pkg) => `Para estancias de menos de 7 noches no reservamos los paquetes semanales Malibu/Uluwatu/Waimea${pkg ? ` (incluido ${pkg.charAt(0).toUpperCase() + pkg.slice(1)})` : ''}. Aun así podemos ayudarte con alojamiento y extras como neopreno, alquiler de tabla o clases de surf. ¿Prefieres solo alojamiento o quieres añadir clases/material?`,
    short_stay_guidance: 'Para estancias de menos de 7 noches los paquetes surf semanales (Malibu, Uluwatu, Waimea) no están disponibles — son para 7 noches. Aun así podemos ayudarte con alojamiento y extras como neopreno, alquiler de tabla o clases. ¿Prefieres solo alojamiento o quieres añadir clases/material?',
    explain_choice: '¿Cuál te encaja más: Malibu, Uluwatu o Waimea?',
  },
  de: {
    weekly_blocked: (pkg) => `Für Aufenthalte unter 7 Nächten buchen wir keine wöchentlichen Malibu/Uluwatu/Waimea-Pakete${pkg ? ` (einschließlich ${pkg.charAt(0).toUpperCase() + pkg.slice(1)})` : ''}. Wir können trotzdem mit Unterkunft und Extras wie Neopren, Brett-Verleih oder Surfkursen helfen. Nur Unterkunft oder Kurse/Equipment dazu?`,
    short_stay_guidance: 'Für Aufenthalte unter 7 Nächten sind die wöchentlichen Surfpakete (Malibu, Uluwatu, Waimea) nicht verfügbar — die gelten für 7 Nächte. Wir können trotzdem mit Unterkunft und Extras wie Neopren, Brett-Verleih oder Surfkursen helfen. Nur Unterkunft oder Kurse/Equipment dazu?',
    explain_choice: 'Was passt am ehesten: Malibu, Uluwatu oder Waimea?',
  },
  fr: {
    weekly_blocked: (pkg) => `Pour les séjours de moins de 7 nuits, nous ne réservons pas les forfaits hebdomadaires Malibu/Uluwatu/Waimea${pkg ? ` (y compris ${pkg.charAt(0).toUpperCase() + pkg.slice(1)})` : ''}. Nous pouvons quand même vous aider avec l'hébergement et des extras comme combinaison, location de planche ou cours de surf. Hébergement seul ou cours/matériel en plus ?`,
    short_stay_guidance: 'Pour les séjours de moins de 7 nuits, les forfaits surf hebdomadaires (Malibu, Uluwatu, Waimea) ne sont pas disponibles — ils sont pour 7 nuits. Nous pouvons quand même vous aider avec l\'hébergement et des extras comme combinaison, location de planche ou cours. Hébergement seul ou cours/matériel en plus ?',
    explain_choice: 'Lequel vous semble le plus adapté : Malibu, Uluwatu ou Waimea ?',
  },
};

function normalizeLang(lang) {
  const l = String(lang || 'en').trim().toLowerCase().slice(0, 2);
  return LUNA_REPLIES[l] ? l : 'en';
}

function buildWeeklyPackageBlockedReply(lang, blockedPackage) {
  const L = LUNA_REPLIES[normalizeLang(lang)];
  return L.weekly_blocked(blockedPackage || null);
}

function buildShortStayAccommodationGuidanceReply(lang) {
  const L = LUNA_REPLIES[normalizeLang(lang)];
  return L.short_stay_guidance;
}

function buildWeeklyPackageExplanationReply(lang) {
  const L = LUNA_REPLIES[normalizeLang(lang)];
  const overview = buildPackageExplainerReply(normalizeLang(lang), 'overview', { bookingInProgress: false });
  return `${overview}\n\n${L.explain_choice}`;
}

function packageNightRuleBlocksQuote(rule) {
  return rule === 'weekly_package_blocked'
    || rule === 'short_stay_guidance'
    || rule === 'weekly_explain_before_choice';
}

module.exports = {
  WEEKLY_SURF_PACKAGES,
  WEEKLY_PACKAGE_MIN_NIGHTS,
  STAFF_PACKAGE_VALIDATION_MSG,
  normalizePackageCode,
  isWeeklySurfPackage,
  isAccommodationOnlyIntent,
  computeStayNights,
  evaluatePackageNightContext,
  validateStaffPackageNightRule,
  buildWeeklyPackageBlockedReply,
  buildShortStayAccommodationGuidanceReply,
  buildWeeklyPackageExplanationReply,
  packageNightRuleBlocksQuote,
};
