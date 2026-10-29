'use strict';

/**
 * Guest-safe copy for bot preview routes — no internal/system wording.
 * Dates in nearest_open_dates are authoritative Staff Pricing output; never infer them here.
 */
const CLOSED_SEASON_COPY = {
  en: 'We are unfortunately closed for that period. Would you like me to look for another date? 😊',
  de: 'In dem Zeitraum haben wir leider geschlossen. Soll ich nach einem anderen Termin schauen? 😊',
  fr: 'Nous sommes malheureusement fermés à cette période. Voulez-vous que je cherche une autre date ? 😊',
  it: 'Purtroppo siamo chiusi in quel periodo. Vuoi che cerchi un’altra data? 😊',
  es: 'Por desgracia, estamos cerrados en ese periodo. ¿Quieres que busque otra fecha? 😊',
};

const NEAREST_OPEN_DATES_COPY = {
  en: 'The nearest open dates are {check_in} to {check_out}.',
  de: 'Der nächstmögliche freie Zeitraum ist vom {check_in} bis zum {check_out}.',
  fr: 'Les prochaines dates disponibles sont du {check_in} au {check_out}.',
  it: 'Le prossime date disponibili sono dal {check_in} al {check_out}.',
  es: 'Las próximas fechas disponibles son del {check_in} al {check_out}.',
};

function normalizeGuestLang(language) {
  const lang = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return CLOSED_SEASON_COPY[lang] ? lang : 'en';
}

function isClosedSeasonQuote(quote) {
  return !!(quote && quote.closed_season);
}

function nearestOpenDatesLine(language, nearestOpenDates) {
  const dates = nearestOpenDates && typeof nearestOpenDates === 'object' ? nearestOpenDates : null;
  const checkIn = String(dates && dates.check_in || '').trim();
  const checkOut = String(dates && dates.check_out || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return '';
  return NEAREST_OPEN_DATES_COPY[normalizeGuestLang(language)]
    .replace('{check_in}', checkIn)
    .replace('{check_out}', checkOut);
}

function buildBotClosedSeasonReply({ language, nearest_open_dates: nearestOpenDates } = {}) {
  const lang = normalizeGuestLang(language);
  const nearestLine = nearestOpenDatesLine(lang, nearestOpenDates);
  const reply_draft = [CLOSED_SEASON_COPY[lang], nearestLine].filter(Boolean).join('\n');
  return {
    reply_draft,
    guest_safe_next_action: reply_draft,
  };
}

module.exports = {
  CLOSED_SEASON_COPY,
  NEAREST_OPEN_DATES_COPY,
  normalizeGuestLang,
  isClosedSeasonQuote,
  nearestOpenDatesLine,
  buildBotClosedSeasonReply,
};
