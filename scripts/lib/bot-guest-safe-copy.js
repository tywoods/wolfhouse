'use strict';

/**
 * Guest-safe copy for bot preview routes — no internal/system wording.
 */

const CLOSED_SEASON_COPY = {
  en: 'Hi! Wolf-House is closed in November, December, January, and February — we can\'t take bookings for those dates. I\'d love to help you find dates during our open season (March through October) 😊',
  it: 'Ciao! A Wolf-House siamo chiusi a novembre, dicembre, gennaio e febbraio — quelle date non sono prenotabili online. Se vuoi, possiamo trovare date in stagione (da marzo a ottobre) 😊',
  es: '¡Hola! En Wolf-House estamos cerrados en noviembre, diciembre, enero y febrero — esas fechas no se pueden reservar online. Si quieres, podemos buscar fechas en temporada (de marzo a octubre) 😊',
  de: 'Hallo! Im Wolf-House haben wir im November, Dezember, Januar und Februar geschlossen — für diese Daten können wir leider keine Online-Buchung annehmen. Wenn du magst, finden wir gerne Termine in der Saison (März bis Oktober) 😊',
};

function normalizeGuestLang(language) {
  const lang = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return CLOSED_SEASON_COPY[lang] ? lang : 'en';
}

function isClosedSeasonQuote(quote) {
  return !!(quote && quote.closed_season);
}

function buildBotClosedSeasonReply({ language } = {}) {
  const lang = normalizeGuestLang(language);
  const reply_draft = CLOSED_SEASON_COPY[lang];
  return {
    reply_draft,
    guest_safe_next_action: reply_draft,
  };
}

module.exports = {
  CLOSED_SEASON_COPY,
  normalizeGuestLang,
  isClosedSeasonQuote,
  buildBotClosedSeasonReply,
};
