'use strict';

/**
 * Stage 30c — Luna confirmation preview/send guest copy style contract.
 *
 * Reuses luna-guest-reply-style-contract sanitization on existing preview facts.
 * Does not regenerate confirmation content or alter payment truth.
 */

const {
  sanitizeGuestReply,
  isForbiddenGuestCopy,
  isFormDevCopy,
  FORBIDDEN_GUEST_PHRASES,
  MAX_REPLY_CHARS,
} = require('./luna-guest-reply-style-contract');

const MAX_CONFIRMATION_CHARS = 900;

const CONFIRMATION_INTERNAL_PHRASES = Object.freeze([
  'staff review',
  'staff notice',
  'preview only',
  'preview ready',
  'dry run',
  'dry-run',
  'confirmation_sent_at',
  'send gate',
  'go/no-go',
  'go no-go',
  'automation gate',
  'no_write_performed',
  'await explicit',
  'handoff notice',
  'not sent to guest',
  'blocked_dry_run',
  'staff_review_confirmation',
]);

const CONFIRMATION_INTERNAL_LINE_RE = new RegExp(
  CONFIRMATION_INTERNAL_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

const GATE_CODE_REQUIRED = '2684#';
const BED_CODE_RE = /(?:DEMO-R\d+-B\d+|\bB[1-9]\b)/i;
const BED_NUMBER_RE = /\bbed\s*(?:number|#|no\.?)?\s*:?\s*\d/i;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function stripConfirmationInternalCopy(text) {
  let s = trimStr(text);
  if (!s) return s;

  s = s.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !CONFIRMATION_INTERNAL_LINE_RE.test(line))
    .join('\n\n');

  for (const phrase of CONFIRMATION_INTERNAL_PHRASES) {
    s = s.replace(new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }

  return s
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .filter((line) => line && !/^[^\n:]{1,32}:\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Apply Luna style contract to existing confirmation preview/send copy.
 * @param {string} message
 * @returns {string}
 */
function polishConfirmationGuestCopy(message) {
  const stripped = stripConfirmationInternalCopy(message);
  if (!stripped) return stripped;
  return sanitizeGuestReply(stripped) || stripped;
}

function messageHasBedLeak(message) {
  if (!message) return false;
  return BED_CODE_RE.test(message) || BED_NUMBER_RE.test(message);
}

const CONFIRMATION_ONLY_ENV = 'LUNA_CONFIRMATION_AUTO_SEND_ENABLED';

const QUOTE_STYLE_COPY = Object.freeze({
  en: {
    hello: (name) => name ? `Hi ${name}! 🌊` : 'Hi there! 🌊',
    headline: "Payment received — you're officially part of the Wolfhouse family!",
    labels: { booking: 'Booking', dates: 'Dates', room: 'Room', guests: 'Guests', package: 'Package', paidToday: 'Paid today', paid: 'Paid', total: 'Total', owed: 'Still to pay', checkIn: 'Check-in', shuttle: 'Shuttle' },
    shared: 'A bed in our mixed shared room', private: 'Private room',
    nights: (n) => `${n} ${n === 1 ? 'night' : 'nights'}`,
    owedWhere: 'on arrival, at reception', fullyPaid: 'Fully paid', nothingOwed: 'nothing left to pay', from: 'from',
    closing: ['If you need anything before you arrive, just message me here 😊', 'See you in the water! 🤙'],
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  es: {
    hello: (name) => name ? `¡Hola ${name}! 🌊` : '¡Hola! 🌊',
    headline: 'Pago recibido — ¡ya formas parte de la familia Wolfhouse!',
    labels: { booking: 'Reserva', dates: 'Fechas', room: 'Habitación', guests: 'Huéspedes', package: 'Paquete', paidToday: 'Pagado hoy', paid: 'Pagado', total: 'Total', owed: 'Pendiente', checkIn: 'Check-in', shuttle: 'Traslado' },
    shared: 'Una cama en nuestra habitación compartida mixta', private: 'Habitación privada',
    nights: (n) => `${n} ${n === 1 ? 'noche' : 'noches'}`,
    owedWhere: 'a tu llegada, en recepción', fullyPaid: 'Pagado por completo', nothingOwed: 'no queda nada por pagar', from: 'desde las',
    closing: ['Si necesitas algo antes de llegar, escríbeme aquí 😊', '¡Nos vemos pronto! 🤙'],
    weekdays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  },
  de: {
    hello: (name) => name ? `Hallo ${name}! 🌊` : 'Hallo! 🌊',
    headline: 'Zahlung erhalten — du gehörst jetzt zur Wolfhouse-Familie!',
    labels: { booking: 'Buchung', dates: 'Daten', room: 'Zimmer', guests: 'Gäste', package: 'Paket', paidToday: 'Heute bezahlt', paid: 'Bezahlt', total: 'Gesamt', owed: 'Noch offen', checkIn: 'Check-in', shuttle: 'Shuttle' },
    shared: 'Ein Bett in unserem gemischten Mehrbettzimmer', private: 'Privatzimmer',
    nights: (n) => `${n} ${n === 1 ? 'Nacht' : 'Nächte'}`,
    owedWhere: 'bei Ankunft, an der Rezeption', fullyPaid: 'Vollständig bezahlt', nothingOwed: 'nichts mehr zu bezahlen', from: 'ab',
    closing: ['Wenn du vor deiner Ankunft etwas brauchst, schreib mir einfach hier 😊', 'Bis bald! 🤙'],
    weekdays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    months: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  },
  fr: {
    hello: (name) => name ? `Bonjour ${name} ! 🌊` : 'Bonjour ! 🌊',
    headline: 'Paiement reçu — tu fais officiellement partie de la famille Wolfhouse !',
    labels: { booking: 'Réservation', dates: 'Dates', room: 'Chambre', guests: 'Voyageurs', package: 'Formule', paidToday: "Payé aujourd'hui", paid: 'Payé', total: 'Total', owed: 'Reste à payer', checkIn: 'Arrivée', shuttle: 'Navette' },
    shared: 'Un lit dans notre chambre partagée mixte', private: 'Chambre privée',
    nights: (n) => `${n} ${n === 1 ? 'nuit' : 'nuits'}`,
    owedWhere: "à l'arrivée, à la réception", fullyPaid: 'Entièrement payé', nothingOwed: 'plus rien à payer', from: 'à partir de',
    closing: ["Si tu as besoin de quoi que ce soit avant ton arrivée, écris-moi ici 😊", 'À bientôt ! 🤙'],
    weekdays: ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'],
    months: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
  },
  it: {
    hello: (name) => name ? `Ciao ${name}! 🌊` : 'Ciao! 🌊',
    headline: 'Pagamento ricevuto — ora fai ufficialmente parte della famiglia Wolfhouse!',
    labels: { booking: 'Prenotazione', dates: 'Date', room: 'Camera', guests: 'Ospiti', package: 'Pacchetto', paidToday: 'Pagato oggi', paid: 'Pagato', total: 'Totale', owed: 'Da pagare', checkIn: 'Check-in', shuttle: 'Navetta' },
    shared: 'Un letto nella nostra camera condivisa mista', private: 'Camera privata',
    nights: (n) => `${n} ${n === 1 ? 'notte' : 'notti'}`,
    owedWhere: "all'arrivo, alla reception", fullyPaid: 'Pagato per intero', nothingOwed: 'non resta nulla da pagare', from: 'dalle',
    closing: ["Se hai bisogno di qualcosa prima dell'arrivo, scrivimi qui 😊", 'A presto! 🤙'],
    weekdays: ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'],
    months: ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'],
  },
});

function isWolfhousePaidConfirmationClient(clientSlug) {
  const slug = trimStr(clientSlug).toLowerCase();
  return slug === 'wolfhouse-somo' || slug === 'wolfhouse';
}

function quoteStyleLanguage(language) {
  const lang = trimStr(language).slice(0, 2).toLowerCase();
  return QUOTE_STYLE_COPY[lang] ? lang : 'en';
}

function formatConfirmationEuro(cents) {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return '';
  const euros = amount / 100;
  if (Number.isInteger(euros)) return `€${euros}`;
  const text = euros.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `€${text}`;
}

function parseConfirmationDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimStr(value));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatConfirmationDate(value, copy) {
  const date = parseConfirmationDate(value);
  if (!date) return '';
  const weekday = copy.weekdays[date.getUTCDay()];
  const month = copy.months[date.getUTCMonth()];
  return `${weekday} ${date.getUTCDate()} ${month}`;
}

function confirmationRoomSentence(fields, copy) {
  const kind = [
    fields && fields.room_kind,
    fields && fields.requested_room_type,
    fields && fields.room_preference,
  ].map(trimStr).join(' ').toLowerCase();
  const shared = /mixed|shared|dorm|mehrbett|compartid|partag|condivis/.test(kind);
  const isPrivate = /private|privad|privat|privé|prive|singol/.test(kind) && !shared;
  const guestCount = Number(fields && fields.guest_count);
  if (shared) return copy.shared;
  if (isPrivate) return Number.isInteger(guestCount) && guestCount > 0
    ? `${copy.private} ${copy.labels.guests.toLowerCase()} ${guestCount}`
    : copy.private;
  return '';
}

function confirmationFirstName(value) {
  const name = trimStr(value);
  if (!name || /^(?:guest|null|undefined)$/i.test(name)) return '';
  return name.split(/\s+/)[0];
}

function confirmationNightCount(checkIn, checkOut) {
  const arrival = parseConfirmationDate(checkIn);
  const departure = parseConfirmationDate(checkOut);
  if (!arrival || !departure) return null;
  const nights = Math.round((departure.getTime() - arrival.getTime()) / 86400000);
  return nights > 0 ? nights : null;
}

function confirmationGuestValue(fields) {
  const count = Number(fields && fields.guest_count);
  if (!Number.isInteger(count) || count < 1) return '';
  const names = Array.isArray(fields && fields.guest_names)
    ? fields.guest_names.map(trimStr).filter(Boolean)
    : [];
  return names.length > 1 ? `${count} · ${names.join(', ')}` : String(count);
}

function confirmationFact(emoji, label, value) {
  return value ? `${emoji} *${label}:* ${value}` : '';
}

/**
 * Wolfhouse guest confirmation in the approved WhatsApp style.
 * Facts only: values are included only when supplied or safely derived.
 * @param {object} fields
 * @returns {string}
 */
function buildWolfhousePaidConfirmationCopy(fields) {
  const src = fields || {};
  const copy = QUOTE_STYLE_COPY[quoteStyleLanguage(src.language)];
  const paidCents = Number(src.amount_paid_cents);
  const balanceCents = src.balance_due_cents == null ? 0 : Number(src.balance_due_cents);
  const suppliedTotal = Number(src.total_amount_cents);
  const derivedTotal = Number.isFinite(paidCents) && Number.isFinite(balanceCents)
    ? paidCents + Math.max(0, balanceCents)
    : NaN;
  const totalCents = Number.isFinite(suppliedTotal) && suppliedTotal >= 0 ? suppliedTotal : derivedTotal;
  const paid = formatConfirmationEuro(paidCents);
  const balance = balanceCents > 0 ? formatConfirmationEuro(balanceCents) : '';
  const total = formatConfirmationEuro(totalCents);
  const deposit = trimStr(src.payment_status) === 'deposit_paid' && balanceCents > 0;

  const arrival = formatConfirmationDate(src.check_in, copy);
  const departure = formatConfirmationDate(src.check_out, copy);
  const nights = confirmationNightCount(src.check_in, src.check_out);
  const dateValue = arrival && departure
    ? `${arrival} – ${departure}${nights ? ` (${copy.nights(nights)})` : ''}`
    : arrival || departure;

  const facts = [
    confirmationFact('📌', copy.labels.booking, trimStr(src.booking_code)),
    confirmationFact('📅', copy.labels.dates, dateValue),
    confirmationFact('🛏️', copy.labels.room, confirmationRoomSentence(src, copy)),
    confirmationFact('👥', copy.labels.guests, confirmationGuestValue(src)),
    confirmationFact('🏄', copy.labels.package, trimStr(src.package_name || src.package)),
  ].filter(Boolean);

  if (paid) facts.push(confirmationFact('💶', deposit ? copy.labels.paidToday : copy.labels.paid, paid));
  if (total) facts.push(confirmationFact('💳', copy.labels.total, total));
  if (deposit && balance) {
    const timing = trimStr(src.balance_due_timing) ? ` ${copy.owedWhere}` : '';
    facts.push(confirmationFact('⏳', copy.labels.owed, `${balance}${timing}`));
  } else if (paid && balanceCents <= 0) {
    facts.push(`✅ *${copy.fullyPaid}*, ${copy.nothingOwed}`);
  }

  const arrivalBits = [];
  const checkInTime = trimStr(src.check_in_time);
  const address = trimStr(src.address);
  if (checkInTime) arrivalBits.push(`${copy.from} ${checkInTime}`);
  if (address) arrivalBits.push(address);
  const arrivalLines = [];
  if (arrivalBits.length) arrivalLines.push(confirmationFact('📍', copy.labels.checkIn, arrivalBits.join(' · ')));
  const maps = trimStr(src.maps_link);
  if (maps && maps !== address) arrivalLines.push(`🗺️ ${maps}`);
  const shuttle = trimStr(src.shuttle_copy);
  if (src.shuttle_booked === true && shuttle) arrivalLines.push(confirmationFact('🚐', copy.labels.shuttle, shuttle));
  const gate = trimStr(src.gate_code);
  if (gate) arrivalLines.push(`🔑 ${gate}`);

  const sections = [
    copy.hello(confirmationFirstName(src.guest_name)),
    `*${copy.headline}* 🎉`,
    facts.join('\n'),
    arrivalLines.join('\n'),
    copy.closing.join('\n'),
  ].filter(Boolean);
  return sections.join('\n\n');
}

/**
 * Validate confirmation guest copy against style + grounding rules.
 * @param {string} message
 * @param {{ booking_code?: string, amount_paid_cents?: number, balance_due_cents?: number }} context
 */
function passesConfirmationStyleContract(message, context) {
  const ctx = context || {};
  const reasons = [];
  const msg = trimStr(message);

  if (!msg) {
    reasons.push('empty_message');
    return { ok: false, reasons };
  }
  if (isForbiddenGuestCopy(msg)) reasons.push('forbidden_guest_copy');
  if (isFormDevCopy(msg)) reasons.push('form_dev_copy');
  for (const phrase of CONFIRMATION_INTERNAL_PHRASES) {
    if (new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(msg)) {
      reasons.push(`internal_phrase:${phrase}`);
    }
  }
  if (msg.length > MAX_CONFIRMATION_CHARS) reasons.push('too_long');
  if (!/\b(?:luna|wolfhouse)\b/i.test(msg.slice(0, 160))) reasons.push('missing_luna_identity');
  if (messageHasBedLeak(msg)) reasons.push('bed_number_leak');
  if (!msg.includes(GATE_CODE_REQUIRED)) reasons.push('missing_gate_code');
  if (ctx.booking_code && !msg.includes(trimStr(ctx.booking_code))) {
    reasons.push('missing_booking_code');
  }
  if (ctx.amount_paid_cents != null) {
    const euros = `€${(Number(ctx.amount_paid_cents) / 100).toFixed(0)}`;
    if (!msg.includes(euros) && !msg.includes(String(ctx.amount_paid_cents))) {
      reasons.push('missing_paid_amount');
    }
  }
  if (ctx.balance_due_cents != null && Number(ctx.balance_due_cents) > 0) {
    const euros = `€${(Number(ctx.balance_due_cents) / 100).toFixed(0)}`;
    if (!/balance|saldo|remaining/i.test(msg) && !msg.includes(euros)) {
      reasons.push('missing_balance_due');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

module.exports = {
  CONFIRMATION_INTERNAL_PHRASES,
  CONFIRMATION_ONLY_ENV,
  FORBIDDEN_GUEST_PHRASES,
  GATE_CODE_REQUIRED,
  MAX_CONFIRMATION_CHARS,
  QUOTE_STYLE_COPY,
  buildWolfhousePaidConfirmationCopy,
  formatConfirmationEuro,
  isWolfhousePaidConfirmationClient,
  polishConfirmationGuestCopy,
  stripConfirmationInternalCopy,
  passesConfirmationStyleContract,
  messageHasBedLeak,
};
