'use strict';

/** Guest-safe copy for bot preview routes. Structured dates come from Staff truth. */
const CLOSED_SEASON_COPY = {
  en: 'We are closed for that period.',
  de: 'In diesem Zeitraum haben wir geschlossen.',
  fr: 'Nous sommes fermés à cette période.',
  it: 'In quel periodo siamo chiusi.',
  es: 'En ese periodo estamos cerrados.',
};
const REOPENS_COPY = {
  en: 'The season reopens on {date}.',
  de: 'Die Saison beginnt wieder am {date}.',
  fr: 'La saison reprend le {date}.',
  it: 'La stagione riapre il {date}.',
  es: 'La temporada vuelve a abrir el {date}.',
};
const NEAREST_OPEN_DATES_COPY = {
  en: 'For your group, the nearest available stay is {check_in} to {check_out}.',
  de: 'Für eure Gruppe ist der nächstmögliche verfügbare Aufenthalt vom {check_in} bis {check_out}.',
  fr: 'Pour votre groupe, le prochain séjour disponible va du {check_in} au {check_out}.',
  it: 'Per il vostro gruppo, il primo soggiorno disponibile va dal {check_in} al {check_out}.',
  es: 'Para vuestro grupo, la estancia disponible más próxima es del {check_in} al {check_out}.',
};
const PARTIAL_OPEN_COPY = {
  en: 'The open part of your requested stay is {check_in} to {check_out}; nights from {closed_from} are closed.',
  de: 'Der offene Teil eures gewünschten Aufenthalts ist vom {check_in} bis {check_out}; ab {closed_from} sind die Nächte geschlossen.',
  fr: 'La partie ouverte de votre séjour demandé va du {check_in} au {check_out} ; les nuits à partir du {closed_from} sont fermées.',
  it: 'La parte aperta del soggiorno richiesto va dal {check_in} al {check_out}; le notti dal {closed_from} sono chiuse.',
  es: 'La parte abierta de vuestra estancia solicitada es del {check_in} al {check_out}; las noches desde el {closed_from} están cerradas.',
};

function normalizeGuestLang(language) {
  const lang = String(language || 'en').trim().toLowerCase().slice(0, 2);
  return CLOSED_SEASON_COPY[lang] ? lang : 'en';
}
function isClosedSeasonQuote(quote) { return !!(quote && quote.closed_season); }
function naturalDate(iso, language, includeYear = false) {
  const text = String(iso || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const locales = { en: 'en-GB', de: 'de-DE', fr: 'fr-FR', it: 'it-IT', es: 'es-ES' };
  return new Intl.DateTimeFormat(locales[normalizeGuestLang(language)], {
    day: 'numeric', month: 'long', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(d);
}
function fillDates(template, language, dates) {
  let result = template;
  for (const [key, value] of Object.entries(dates || {})) {
    result = result.replace(`{${key}}`, naturalDate(value, language));
  }
  return result;
}
function nearestOpenDatesLine(language, nearestOpenDates) {
  const lang = normalizeGuestLang(language);
  const d = nearestOpenDates || {};
  if (!naturalDate(d.check_in, lang) || !naturalDate(d.check_out, lang)) return '';
  return fillDates(NEAREST_OPEN_DATES_COPY[lang], lang, d);
}
function buildBotClosedSeasonReply({ language, nearest_open_dates: nearest, season_reopens_on: reopens, partial_open_dates: partial } = {}) {
  const lang = normalizeGuestLang(language);
  const lines = [];
  if (partial && partial.check_in && partial.check_out && partial.closed_from) {
    lines.push(fillDates(PARTIAL_OPEN_COPY[lang], lang, partial));
  } else {
    lines.push(CLOSED_SEASON_COPY[lang]);
    if (reopens && naturalDate(reopens, lang)) lines.push(fillDates(REOPENS_COPY[lang], lang, { date: reopens }));
  }
  const nearestLine = nearestOpenDatesLine(lang, nearest);
  if (nearestLine) lines.push(nearestLine);
  const reply_draft = lines.filter(Boolean).join(' ');
  return { reply_draft, guest_safe_next_action: reply_draft };
}

module.exports = {
  CLOSED_SEASON_COPY, NEAREST_OPEN_DATES_COPY, normalizeGuestLang, isClosedSeasonQuote,
  naturalDate, nearestOpenDatesLine, buildBotClosedSeasonReply,
};
