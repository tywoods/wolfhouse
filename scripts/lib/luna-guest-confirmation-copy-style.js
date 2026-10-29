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
const { formatGuestPropertyAddress } = require('./luna-guest-property-address');
const { guestCopy, language: catalogLanguage } = require('./luna-guest-copy-catalog');

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

const ROOM_KINDS = Object.freeze(['mixed','women_shared','men_shared','shared','women','men','private','private_or_mixed','fallback']);
const LABEL_KEYS = Object.freeze(['booking','dates','room','guests','package','paidToday','paid','total','owed','checkIn','shuttle']);
function nativeTemplate(copy, key, values) { return String(copy[key] || '').replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')); }
function confirmationCopy(language) {
  const flat = guestCopy(language);
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, flat[`confirmation_label_${key}`]]));
  const rooms = Object.fromEntries(ROOM_KINDS.map((key) => [key, flat[`confirmation_room_${key}`]]));
  rooms.many = Object.fromEntries(ROOM_KINDS.map((key) => [key, (count) => nativeTemplate(flat, `confirmation_room_many_${key}`, { count })]));
  rooms.privateFor = (count) => nativeTemplate(flat, 'confirmation_room_privateFor', { count });
  rooms.and = flat.confirmation_room_and;
  return {
    hello: (name) => name ? nativeTemplate(flat, 'confirmation_hello_named', { name }) : flat.confirmation_hello_anon,
    headline: flat.confirmation_paid_headline, labels, shared: flat.confirmation_shared, private: flat.confirmation_private,
    nights: (count) => nativeTemplate(flat, count === 1 ? 'confirmation_nights_one' : 'confirmation_nights_many', { count }),
    owedWhere: flat.confirmation_owedWhere, fullyPaid: flat.confirmation_fullyPaid, nothingOwed: flat.confirmation_nothingOwed,
    from: flat.confirmation_from, closing: [flat.confirmation_closing_1, flat.confirmation_closing_2],
    shuttlePickup: (date) => nativeTemplate(flat, 'confirmation_shuttlePickup', { date }), shuttleBooked: flat.confirmation_shuttleBooked,
    weekdays: Array.from({length:7}, (_,i) => flat[`confirmation_weekday_${i}`]), months: Array.from({length:12}, (_,i) => flat[`confirmation_month_${i}`]),
    rooms, receptionTiming: flat.confirmation_reception_timing, arrivalTiming: flat.confirmation_arrival_timing,
    arrivalMethods: flat.confirmation_arrival_methods,
  };
}


function isWolfhousePaidConfirmationClient(clientSlug) {
  const slug = trimStr(clientSlug).toLowerCase();
  return slug === 'wolfhouse-somo' || slug === 'wolfhouse';
}

function quoteStyleLanguage(language) {
  return catalogLanguage(language);
}

function formatConfirmationEuro(cents) {
  if (cents == null || cents === '') return '';
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

function knownCents(value) {
  if (value == null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount);
}

function classifyRoomToken(value) {
  const text = trimStr(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!text) return null;
  if (/private or mixed|matrimonial or mixed/.test(text)) return 'private_or_mixed';
  const women = /\b(?:women|female|girls?|mujeres|frauen|femmes|donne)\b/.test(text);
  const men = /\b(?:men|male|guys?|hombres|manner|männer|hommes|uomini)\b/.test(text);
  const mixed = /\b(?:mixed|mixta|mixte|mista|gemischt)\b/.test(text);
  const shared = /\b(?:shared|dorm|mehrbett|compartid\w*|partag\w*|condivis\w*)\b/.test(text);
  const isPrivate = /\b(?:private|privad\w*|privat\w*|prive|privé|matrimonial|couple|singol\w*)\b/.test(text);
  if (women && !men && !mixed) return shared ? 'women_shared' : 'women';
  if (men && !women && !mixed) return shared ? 'men_shared' : 'men';
  if (mixed && !women && !men) return 'mixed';
  if (isPrivate && !shared && !women && !men) return 'private';
  if (shared && !women && !men && !mixed) return 'shared';
  return null;
}

function roomPhrase(lines, kind, count, fields) {
  if (count > 1) return (lines.many[kind] || lines.many.fallback)(count);
  if (kind === 'private') {
    const guests = Number(fields && fields.guest_count);
    if (Number.isInteger(guests) && guests > 1) return lines.privateFor(guests);
  }
  return lines[kind] || lines.fallback;
}

function kindSlot(value) {
  const text = trimStr(value).toLowerCase();
  if (!text || text === 'unclassified' || text === 'unknown') return 'unknown';
  return classifyRoomToken(value) || 'unknown';
}

function joinRoomPhrases(parts, lines) {
  return parts.map((phrase, index) => (
    index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1)
  )).join(` ${lines.and} `);
}

function sentenceFromKindSlots(slots, fields, lines) {
  const classes = slots.map(kindSlot);
  const countRaw = Number(fields && fields.room_count);
  const extraUnknown = Number.isInteger(countRaw) && countRaw > classes.length
    ? countRaw - classes.length
    : 0;
  const known = classes.filter((kind) => kind !== 'unknown');
  const unknownCount = classes.length - known.length + extraUnknown;
  if (!known.length) {
    const count = unknownCount || 1;
    return count > 1 ? lines.many.fallback(count) : lines.fallback;
  }
  const unique = [...new Set(known)];
  if (unique.length === 1 && unknownCount === 0) {
    return roomPhrase(lines, unique[0], known.length, fields);
  }
  const parts = unique.map((kind) => roomPhrase(
    lines,
    kind,
    known.filter((item) => item === kind).length,
    fields,
  ));
  if (unknownCount === 1) parts.push(lines.fallback);
  else if (unknownCount > 1) parts.push(lines.many.fallback(unknownCount));
  return joinRoomPhrases(parts, lines);
}

function confirmationRoomSentence(fields, copy) {
  const lines = confirmationCopy(fields && fields.language).rooms;
  const explicit = Array.isArray(fields && fields.room_kinds)
    ? fields.room_kinds.map(trimStr).filter(Boolean)
    : [];
  if (explicit.length) return sentenceFromKindSlots(explicit, fields, lines);
  const assigned = [fields && fields.room_kind, fields && fields.requested_room_type].map(trimStr).filter(Boolean);
  const tokens = assigned.length
    ? assigned
    : [fields && fields.room_preference].map(trimStr).filter(Boolean);
  const classes = tokens.map(classifyRoomToken).filter(Boolean);
  const countRaw = Number(fields && fields.room_count);
  const count = Number.isInteger(countRaw) && countRaw > 1
    ? countRaw
    : (classes.length > 1 ? classes.length : 1);
  if (!classes.length) {
    if (!trimStr(fields && (fields.room_number || fields.room_label))) return '';
    return count > 1 ? lines.many.fallback(count) : lines.fallback;
  }
  const unique = [...new Set(classes)];
  if (unique.length > 1) {
    return joinRoomPhrases(unique.map((kind) => roomPhrase(lines, kind, 1, fields)), lines);
  }
  return roomPhrase(lines, unique[0], count, fields);
}

function normalizeTiming(value) {
  return trimStr(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

const METHOD_KEYS = Object.freeze(['cash', 'bank_transfer', 'stripe']);
function canonicalPaymentMethod(value) {
  const text = normalizeTiming(value);
  if (!text) return null;
  if (/^(?:cash|efectivo|bar|especes|espèces|contanti)$/.test(text)) return 'cash';
  if (/^(?:bank transfer|transfer|wire|virement|bonifico|uberweisung|überweisung|transferencia)$/.test(text)) return 'bank_transfer';
  if (/^(?:stripe|payment link|card|enlace de pago|zahlungslink|lien de paiement|link di pagamento)$/.test(text)) return 'stripe';
  return null;
}

function listedPaymentMethods(methods) {
  const list = [];
  for (const item of Array.isArray(methods) ? methods : []) {
    const key = canonicalPaymentMethod(item);
    if (key && !list.includes(key)) list.push(key);
  }
  return list;
}

function joinMethodParts(parts, lang) {
  const copy = guestCopy(lang);
  const prefix = copy.confirmation_method_prefix;
  if (parts.length === 1) return [prefix, parts[0]].filter(Boolean).join(' ');
  const conjunction = copy.confirmation_method_join;
  const joined = parts.length === 2
    ? `${parts[0]} ${conjunction} ${parts[1]}`
    : `${parts.slice(0, -1).join(', ')}, ${conjunction} ${parts[parts.length - 1]}`;
  return [prefix, joined].filter(Boolean).join(' ');
}

function arrivalMethodsPhrase(methods, lang) {
  const list = listedPaymentMethods(methods);
  if (!list.length) return '';
  if (METHOD_KEYS.every((key) => list.includes(key))) return confirmationCopy(lang).arrivalMethods;
  const phrases = Object.fromEntries(METHOD_KEYS.map((key) => [key, guestCopy(lang)[`confirmation_method_${key}`]]));
  return joinMethodParts(list.map((key) => phrases[key]), lang);
}

function confirmationBalanceTiming(src, language) {
  const raw = trimStr(src && src.balance_due_timing);
  if (!raw) return '';
  const lang = quoteStyleLanguage(language);
  const norm = normalizeTiming(raw);
  if (['en','es','de','fr','it'].some((locale) => normalizeTiming(confirmationCopy(locale).receptionTiming) === norm)) {
    return ` ${confirmationCopy(lang).receptionTiming}`;
  }
  if (norm === 'at arrival or checkin' || norm === 'on arrival' || norm === 'when you arrive' || norm === 'at arrival') {
    const methods = arrivalMethodsPhrase(src && src.balance_payment_methods, lang);
    return ` ${confirmationCopy(lang).arrivalTiming}${methods ? `, ${methods}` : ''}`;
  }
  return ` ${raw}`;
}

const SHUTTLE_ASK_RE = /(?:^|[,.!?]|\s)\s*(?:just\s+|please\s+|por favor\s+|bitte\s+)*(?:send(?:\s+me|\s+your)?|tell me|let me know|env[ií]a(?:me)?|m[aá]ndame|schick(?:\s+mir)?|envoie(?:-moi)?|mandami|scrivimi)\b[\s\S]*$/i;

function stripShuttleAsk(value) {
  const text = trimStr(value);
  const match = SHUTTLE_ASK_RE.exec(text);
  if (!match) return text;
  return trimStr(text.slice(0, match.index).replace(/[,\s]+$/g, ''));
}

function ownedPickupDate(factual, src) {
  const normalized = trimStr(factual).replace(/\s*✈️\s*$/u, '').toLowerCase();
  for (const value of [src && src.check_in, src && src.check_out]) {
    const enDate = formatConfirmationDate(value, confirmationCopy('en'));
    if (enDate && normalized === `pick-up on ${enDate}`.toLowerCase()) return value;
  }
  return null;
}

function confirmationShuttleValue(src, copy) {
  if (!src || src.shuttle_booked !== true) return '';
  const raw = trimStr(src.shuttle_copy);
  if (!raw) return '';
  if (!SHUTTLE_ASK_RE.test(raw)) return raw;
  const factual = stripShuttleAsk(raw);
  const owned = factual ? ownedPickupDate(factual, src) : null;
  if (owned) {
    const localDate = formatConfirmationDate(owned, copy);
    return localDate ? copy.shuttlePickup(localDate) : copy.shuttleBooked;
  }
  if (factual) return factual;
  return copy.shuttleBooked;
}

function resolveConfirmationMoney(src) {
  const paidCents = knownCents(src && src.amount_paid_cents);
  const balanceCents = knownCents(src && src.balance_due_cents);
  const balanceKnown = src && src.balance_due_cents != null && src.balance_due_cents !== '' && balanceCents != null;
  const suppliedTotal = knownCents(src && src.total_amount_cents);
  let totalCents = null;
  if (paidCents != null && balanceKnown && balanceCents >= 0) {
    const derived = paidCents + balanceCents;
    if (suppliedTotal == null || suppliedTotal === derived) totalCents = derived;
  } else if (suppliedTotal != null && suppliedTotal > 0) {
    totalCents = suppliedTotal;
  } else if (suppliedTotal === 0 && paidCents === 0 && balanceKnown && balanceCents === 0) {
    totalCents = 0;
  }
  const deposit = trimStr(src && src.payment_status) === 'deposit_paid' && balanceKnown && balanceCents > 0;
  const fullyPaid = !!(paidCents != null && balanceKnown && balanceCents === 0
    && (suppliedTotal == null || suppliedTotal === paidCents));
  return { paidCents, balanceCents, balanceKnown, totalCents, deposit, fullyPaid };
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
  const copy = confirmationCopy(src.language);
  const money = resolveConfirmationMoney(src);
  const paid = money.paidCents == null ? '' : formatConfirmationEuro(money.paidCents);
  const balance = money.balanceKnown && money.balanceCents > 0
    ? formatConfirmationEuro(money.balanceCents)
    : '';
  const total = money.totalCents == null ? '' : formatConfirmationEuro(money.totalCents);

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

  if (paid) facts.push(confirmationFact('💶', money.deposit ? copy.labels.paidToday : copy.labels.paid, paid));
  if (total) facts.push(confirmationFact('💳', copy.labels.total, total));
  if (money.deposit && balance) {
    const timing = confirmationBalanceTiming(src, src.language);
    facts.push(confirmationFact('⏳', copy.labels.owed, `${balance}${timing}`));
  } else if (money.fullyPaid && paid) {
    facts.push(`✅ *${copy.fullyPaid}*, ${copy.nothingOwed}`);
  }

  const arrivalBits = [];
  const checkInTime = trimStr(src.check_in_time);
  const address = formatGuestPropertyAddress(src.address);
  if (checkInTime) arrivalBits.push(`${copy.from} ${checkInTime}`);
  if (address) arrivalBits.push(address);
  const arrivalLines = [];
  if (arrivalBits.length) arrivalLines.push(confirmationFact('📍', copy.labels.checkIn, arrivalBits.join(' · ')));
  const maps = trimStr(src.maps_link);
  if (maps && maps !== address) arrivalLines.push(`🗺️ ${maps}`);
  const shuttle = confirmationShuttleValue(src, copy);
  if (shuttle) arrivalLines.push(confirmationFact('🚐', copy.labels.shuttle, shuttle));
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
  buildWolfhousePaidConfirmationCopy,
  formatConfirmationEuro,
  isWolfhousePaidConfirmationClient,
  polishConfirmationGuestCopy,
  stripConfirmationInternalCopy,
  passesConfirmationStyleContract,
  messageHasBedLeak,
};
