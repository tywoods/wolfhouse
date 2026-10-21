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
    opening: "Payment received — you're officially part of the Wolfhouse family 🌊",
    guest: 'guest',
    guests: 'guests',
    shared: 'A bed in a shared room',
    private: 'A private room',
    room: 'Room',
    deposit: 'Deposit received',
    paid: 'Payment received',
    left: (amount) => `${amount} is left for when you arrive.`,
    weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
  es: {
    opening: 'Pago recibido — ya formas parte de la familia Wolfhouse 🌊',
    guest: 'huésped',
    guests: 'huéspedes',
    shared: 'Una cama en una habitación compartida',
    private: 'Una habitación privada',
    room: 'Habitación',
    deposit: 'Depósito recibido',
    paid: 'Pago recibido',
    left: (amount) => `Quedan ${amount} para cuando llegues.`,
    weekdays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  },
  de: {
    opening: 'Zahlung erhalten — du gehörst jetzt zur Wolfhouse-Familie 🌊',
    guest: 'Gast',
    guests: 'Gäste',
    shared: 'Ein Bett in einem Mehrbettzimmer',
    private: 'Ein Privatzimmer',
    room: 'Zimmer',
    deposit: 'Anzahlung erhalten',
    paid: 'Zahlung erhalten',
    left: (amount) => `${amount} bleiben bis zu deiner Ankunft.`,
    weekdays: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
    months: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'],
  },
  fr: {
    opening: 'Paiement reçu — tu fais partie de la famille Wolfhouse 🌊',
    guest: 'voyageur',
    guests: 'voyageurs',
    shared: 'Un lit dans une chambre partagée',
    private: 'Une chambre privée',
    room: 'Chambre',
    deposit: 'Acompte reçu',
    paid: 'Paiement reçu',
    left: (amount) => `Il reste ${amount} à ton arrivée.`,
    weekdays: ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'],
    months: ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'],
  },
  it: {
    opening: 'Pagamento ricevuto — fai parte della famiglia Wolfhouse 🌊',
    guest: 'ospite',
    guests: 'ospiti',
    shared: 'Un letto in una camera condivisa',
    private: 'Una camera privata',
    room: 'Camera',
    deposit: 'Acconto ricevuto',
    paid: 'Pagamento ricevuto',
    left: (amount) => `Restano ${amount} per quando arrivi.`,
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
  const code = trimStr(fields && fields.room_number).replace(/\s+/g, ' ');
  if (shared) return code ? `${copy.shared} · ${code}` : copy.shared;
  if (isPrivate) return code ? `${copy.private} · ${code}` : copy.private;
  if (code) return `${copy.room} ${code}`;
  return '';
}

/**
 * Wolfhouse guest confirmation in the approved quote style.
 * Facts only: dates, room, money, one reference. Says the payment was received.
 * @param {object} fields
 * @returns {string}
 */
function buildWolfhousePaidConfirmationCopy(fields) {
  const src = fields || {};
  const copy = QUOTE_STYLE_COPY[quoteStyleLanguage(src.language)];
  const paidCents = Number(src.amount_paid_cents);
  const balanceCents = src.balance_due_cents == null ? 0 : Number(src.balance_due_cents);
  const paid = formatConfirmationEuro(paidCents);
  const balance = balanceCents > 0 ? formatConfirmationEuro(balanceCents) : '';
  const deposit = trimStr(src.payment_status) === 'deposit_paid' && balanceCents > 0;
  const lines = [copy.opening];

  const arrival = formatConfirmationDate(src.check_in, copy);
  const departure = formatConfirmationDate(src.check_out, copy);
  const guestCount = Number(src.guest_count);
  const guestBit = Number.isInteger(guestCount) && guestCount > 0
    ? `${guestCount} ${guestCount === 1 ? copy.guest : copy.guests}`
    : '';
  if (arrival && departure) {
    lines.push(`📅 ${arrival} – ${departure}${guestBit ? ` · ${guestBit}` : ''}`);
  } else if (guestBit) {
    lines.push(`📅 ${guestBit}`);
  }

  const room = confirmationRoomSentence(src, copy);
  if (room) lines.push(`🛏️ ${room}`);
  if (paid) lines.push(`💶 ${deposit ? copy.deposit : copy.paid}: ${paid}`);
  const code = trimStr(src.booking_code);
  if (code) lines.push(`📌 ${code}`);

  const tail = [];
  if (deposit && balance) tail.push(copy.left(balance));
  const address = trimStr(src.address);
  if (address) tail.push(`📍 ${address}`);
  const maps = trimStr(src.maps_link);
  if (maps && maps !== address) tail.push(`📍 ${maps}`);
  const gate = trimStr(src.gate_code);
  if (gate) tail.push(`🔑 ${gate}`);

  return stripConfirmationInternalCopy([lines.join('\n'), tail.join('\n')].filter(Boolean).join('\n\n'));
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
