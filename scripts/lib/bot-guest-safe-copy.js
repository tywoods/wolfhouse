'use strict';

/**
 * Guest-safe copy for bot preview routes — no internal/system wording.
 */

const CLOSED_SEASON_COPY = {
  en: 'Hi! Wolf-House is closed for those dates, so we can\'t take a booking then. Would you like help finding different dates? 😊',
  it: 'Ciao! Wolf-House è chiusa per quelle date, quindi non possiamo accettare una prenotazione. Vuoi che cerchiamo altre date? 😊',
  es: '¡Hola! Wolf-House está cerrado para esas fechas, así que no podemos aceptar una reserva. ¿Quieres que busquemos otras fechas? 😊',
  de: 'Hallo! Wolf-House ist an diesen Daten geschlossen, daher können wir keine Buchung annehmen. Soll ich nach anderen Daten suchen? 😊',
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
