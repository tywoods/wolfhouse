'use strict';

/**
 * Stage 37b — Cami/Wolfhouse confirmation preview copy from personality config.
 * Facts-only: booking code, paid/balance, room label, gate, maps link, lesson rhythm.
 */

const {
  resolveActivePersonality,
  pickLangTemplates,
  interpolateTemplate,
} = require('./luna-guest-personality-config');
const {
  loadLessonScheduleConfig,
  bookingDraftIncludesSurfLessons,
  buildLessonScheduleGuestSection,
  formatPlaybookEuro,
} = require('./luna-guest-lesson-schedule-config');

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

// Localized labels for the factual confirmation lines. en/it/de/es match the
// languages available in the Cami personality reply_templates. Unknown languages
// fall back to English. (Translations are brand-neutral; review if tone matters.)
const CONFIRMATION_LABELS = {
  en: { booking: 'Booking', paid: 'Paid', balance: 'Balance', location: 'Location', gate_code: 'Gate code', room: 'Room' },
  it: { booking: 'Prenotazione', paid: 'Pagato', balance: 'Saldo', location: 'Posizione', gate_code: 'Codice cancello', room: 'Camera' },
  de: { booking: 'Buchung', paid: 'Bezahlt', balance: 'Restbetrag', location: 'Standort', gate_code: 'Torcode', room: 'Zimmer' },
  es: { booking: 'Reserva', paid: 'Pagado', balance: 'Saldo pendiente', location: 'Ubicación', gate_code: 'Código de la puerta', room: 'Habitación' },
};

function pickLabels(language) {
  const lang = trimStr(language).slice(0, 2).toLowerCase() || 'en';
  return CONFIRMATION_LABELS[lang] || CONFIRMATION_LABELS.en;
}

function buildBalancePaymentSection(fields, language) {
  if (!fields || !fields.include_balance_link || !fields.balance_payment_link) return '';
  const lang = trimStr(language).slice(0, 2).toLowerCase() || 'en';
  const link = fields.balance_payment_link;
  if (lang === 'it') return `Se volete saldare il saldo con carta prima dell'arrivo: ${link}`;
  if (lang === 'de') return `Wenn ihr den Restbetrag vor der Anreise per Karte zahlen möchtet: ${link}`;
  if (lang === 'es') return `Si quieres pagar el saldo restante con tarjeta antes de llegar: ${link}`;
  return `If you'd like to settle the remaining balance by card before arrival: ${link}`;
}

function buildCamiConfirmationPreview(clientSlug, language, fields) {
  const resolved = resolveActivePersonality(clientSlug);
  if (!resolved.personality || resolved.active_personality_id !== 'cami') {
    return { ok: false, source: 'personality_not_cami' };
  }

  const personality = resolved.personality;
  const tpl = pickLangTemplates(personality, language);
  const lessonCfg = loadLessonScheduleConfig(clientSlug);
  const draft = fields && fields.draft ? fields.draft : fields;

  const bookingCode = trimStr(fields && fields.booking_code);
  const paid = formatPlaybookEuro(fields && fields.amount_paid_cents);
  const balanceDueCents = fields && fields.balance_due_cents != null
    ? Number(fields.balance_due_cents)
    : 0;
  const balance = balanceDueCents > 0 ? formatPlaybookEuro(balanceDueCents) : '';
  const roomLabel = trimStr(fields && fields.room_number);
  const gateCode = trimStr(fields && fields.gate_code) || '2684#';
  const mapsLink = lessonCfg.maps_link;
  const guestName = trimStr(fields && fields.guest_name);

  const intro = tpl && tpl.confirmation_intro
    ? interpolateTemplate(tpl.confirmation_intro, { guest_name: guestName })
    : 'Yesss, you\'re officially part of the Wolfhouse family 🌊❤️';

  const chunks = [intro];
  const L = pickLabels(language);

  const summaryLines = [];
  if (bookingCode) summaryLines.push(`${L.booking}: ${bookingCode}`);
  if (paid) summaryLines.push(`${L.paid}: ${paid}`);
  if (balance) summaryLines.push(`${L.balance}: ${balance}`);
  if (summaryLines.length) chunks.push(summaryLines.join('\n'));

  const arrivalLines = [];
  if (mapsLink) arrivalLines.push(`${L.location}: ${mapsLink}`);
  if (gateCode) arrivalLines.push(`${L.gate_code}: ${gateCode}`);
  if (roomLabel) arrivalLines.push(`${L.room}: ${roomLabel}`);
  if (arrivalLines.length) chunks.push(arrivalLines.join('\n'));

  const lessonSection = buildLessonScheduleGuestSection(clientSlug, language, draft);
  if (lessonSection) chunks.push(lessonSection);

  const balanceSection = buildBalancePaymentSection(fields, language);
  if (balanceSection) chunks.push(balanceSection);

  const close = tpl && tpl.confirmation_close
    ? tpl.confirmation_close
    : 'Can\'t wait to welcome you in Somo ☀️';
  chunks.push(close);

  let message = chunks.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    ok: true,
    message,
    source: 'personality_confirmation',
    template_source: 'personalities.cami.confirmation_templates',
    includes_lessons: bookingDraftIncludesSurfLessons(draft),
    maps_link: mapsLink,
    personality_id: resolved.active_personality_id,
  };
}

module.exports = {
  buildCamiConfirmationPreview,
  buildBalancePaymentSection,
};
