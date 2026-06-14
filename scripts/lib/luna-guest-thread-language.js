'use strict';

/**
 * Sticky guest thread language — once DE/IT/ES/FR is established, short replies
 * like "deposit" or "Uluwatu" keep the thread language instead of flipping to EN.
 */

const SUPPORTED = new Set(['en', 'de', 'it', 'es', 'fr']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function normalizeLang(lang) {
  const l = trimStr(lang).toLowerCase().slice(0, 2);
  return SUPPORTED.has(l) ? l : 'en';
}

function detectEnglishPreference(text) {
  return /\b(?:i\s+don'?t\s+speak\s+(?:german|deutsch|italian|italiano|french|fran[cç]ais|spanish|espa[nñ]ol)|(?:speak|write|talk)\s+english|english\s+please|in\s+english|no\s+(?:german|deutsch|italian|french|spanish))\b/i.test(String(text || ''));
}

function detectMessageLanguage(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (detectEnglishPreference(t)) return 'en';
  const strongEs = /\b(?:hola|gracias|quiero|personas|septiembre|aeropuerto|necesito|qué|que paquetes|paquetes|tenéis|teneis|principiante|reservar|estancia)\b/;
  const strongIt = /\b(?:ciao|grazie|vorrei|persone|settembre|giugno|siamo|quali|pacchetto|pacchetti|principiante|prenot)\b/;
  const strongFr = /\b(?:bonjour|merci|personnes|septembre|août|aout|aimerions|voulons|r[eé]server|reserver|forfaits|quels)\b/;
  const strongDe = /\b(?:hallo|moin|servus|was\s+geht|wie\s+geht'?s|guten\s+(?:tag|morgen|abend)|gr[uü]ß|ich\s+will|wir\s+sind|zu\s+zweit|paket|pakete|anzahlung|buch(?:en)?|möchten|moechten|enthalten|einchecken|abflug|flughafen|übernachtung|unterkunft|personen|gäste|gaste|danke|guten)\b/;
  if (strongEs.test(t)) return 'es';
  if (strongIt.test(t)) return 'it';
  if (strongFr.test(t)) return 'fr';
  if (strongDe.test(t)) return 'de';
  return null;
}

function priorThreadLanguage(guestContext) {
  const ctx = guestContext || {};
  const fromCtx = trimStr(ctx.detected_language)
    || trimStr(ctx.result && ctx.result.detected_language);
  if (fromCtx) return normalizeLang(fromCtx);
  const transcript = Array.isArray(ctx.thread_transcript) ? ctx.thread_transcript : [];
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const turn = transcript[i];
    if (!turn || turn.role !== 'guest') continue;
    const lang = detectMessageLanguage(turn.text);
    if (lang && lang !== 'en') return lang;
  }
  return null;
}

/**
 * @param {string} messageText
 * @param {object} [guestContext]
 * @param {string|null} [hint]
 */
function resolveGuestThreadLanguage(messageText, guestContext, hint) {
  if (detectEnglishPreference(messageText)) return 'en';
  if (hint) {
    const h = normalizeLang(hint);
    if (h !== 'en') return h;
  }
  const fromMessage = detectMessageLanguage(messageText);
  if (fromMessage) return fromMessage;
  const sticky = priorThreadLanguage(guestContext);
  if (sticky && sticky !== 'en') return sticky;
  return 'en';
}

module.exports = {
  SUPPORTED,
  normalizeLang,
  detectEnglishPreference,
  detectMessageLanguage,
  priorThreadLanguage,
  resolveGuestThreadLanguage,
};
