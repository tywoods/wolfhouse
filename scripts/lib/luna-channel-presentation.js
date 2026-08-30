'use strict';

/**
 * SAME-DESK-002 — channel presentation seam.
 *
 * Factual authority stays on the existing owners (live Admin catalog, Staff API
 * quotes, payment/confirmation truth). This module only shapes already-grounded
 * facts for WhatsApp vs email. It never invents offerings, prices, availability,
 * stock, payment links, or confirmations, and it never approves or sends.
 */

const PRESENTATION_CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
});

const ASK_KEYS = Object.freeze(['dates', 'guest_count']);

const ASK_COPY = Object.freeze({
  dates: Object.freeze({
    en: 'What dates do you have in mind?',
    es: '¿Qué fechas tenéis en mente?',
  }),
  guest_count: Object.freeze({
    en: 'How many guests would there be?',
    es: '¿Cuántas personas seríais?',
  }),
  dates_and_guest_count: Object.freeze({
    en: 'What dates do you have in mind, and how many guests would there be?',
    es: '¿Qué fechas tenéis en mente y cuántas personas seríais?',
  }),
});

const HOSTILE_LABEL = /\b(confirmed|confirmation|paid|payment received|guaranteed|booking guaranteed|ignore|system:)\b/i;
const HOSTILE_URL = /https?:|www\.|\.test\b|\.com\b|\.org\b|evil\./i;
const SAFE_LABEL = /^[A-Za-z0-9ÁÉÍÓÚÑÜáéíóúñü'’+&().\-\s]+$/;

function guestSafeOfferingLabel(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length < 1 || text.length > 80) return null;
  if (HOSTILE_URL.test(text) || HOSTILE_LABEL.test(text)) return null;
  if (!SAFE_LABEL.test(text)) return null;
  return text;
}

function formatMoneyFromCents(cents, language) {
  if (!Number.isSafeInteger(cents) || cents < 0) return null;
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return language === 'es' ? `€${whole},${fraction}` : `€${whole}.${fraction}`;
}

function factCents(facts) {
  if (!facts || typeof facts !== 'object') return null;
  if (facts.quote_total_cents != null) return facts.quote_total_cents;
  if (facts.amount_cents != null) return facts.amount_cents;
  return null;
}

function compactEmailQuoteBlock(facts, language) {
  const label = guestSafeOfferingLabel(facts && facts.offering_label);
  const money = formatMoneyFromCents(factCents(facts), language);
  if (!label || !money) return null;
  const heading = language === 'es' ? 'Presupuesto' : 'Quote';
  const lines = [heading, label, money];
  if (typeof (facts && facts.date) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(facts.date)) {
    lines.push(facts.date);
  }
  if (Number.isSafeInteger(facts && facts.quantity) && facts.quantity > 0) {
    lines.push(language === 'es' ? `Cantidad: ${facts.quantity}` : `Qty: ${facts.quantity}`);
  }
  return lines.join('\n');
}

function isoDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function compactEmailPayToBookQuoteBlock(facts, language) {
  const src = facts && typeof facts === 'object' ? facts : {};
  const lang = language === 'es' ? 'es' : 'en';
  const heading = lang === 'es' ? 'Presupuesto' : 'Quote';
  const lines = [heading];
  const label = guestSafeOfferingLabel(src.offering_label);
  if (label) lines.push(label);
  const lineSummary = guestSafeOfferingLabel(src.line_summary);
  if (lineSummary && lineSummary !== label) lines.push(lineSummary);
  const total = formatMoneyFromCents(src.quote_total_cents, lang);
  if (total) lines.push(lang === 'es' ? `Total: ${total}` : `Total: ${total}`);
  const due = formatMoneyFromCents(src.amount_due_cents, lang);
  if (due) {
    const choice = src.payment_choice === 'full'
      ? (lang === 'es' ? 'completo' : 'full')
      : (lang === 'es' ? 'depósito' : 'deposit');
    lines.push(lang === 'es' ? `A pagar ahora (${choice}): ${due}` : `Due now (${choice}): ${due}`);
  }
  const from = isoDateOnly(src.date_from);
  const to = isoDateOnly(src.date_to);
  if (from && to && to !== from) lines.push(`${from} to ${to}`);
  else if (from) lines.push(from);
  else if (isoDateOnly(src.date)) lines.push(src.date);
  if (Number.isSafeInteger(src.quantity) && src.quantity > 0) {
    lines.push(lang === 'es' ? `Cantidad: ${src.quantity}` : `Qty: ${src.quantity}`);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

const PAY_TO_BOOK_COPY = Object.freeze({
  en: Object.freeze({
    hello: 'Hi,',
    thanks: 'Thanks for your message.',
    pay: 'To complete this booking, please use this payment link from our desk:',
    hold: 'Your dates are held until',
    late: 'Payment after that time will not automatically complete the booking.',
    signoff: 'Warm regards,',
    signature: 'Luna',
  }),
  es: Object.freeze({
    hello: 'Hola,',
    thanks: 'Gracias por tu mensaje.',
    pay: 'Para completar esta reserva, usa este enlace de pago de recepción:',
    hold: 'Tus fechas quedan retenidas hasta',
    late: 'Un pago después de esa hora no completará la reserva automáticamente.',
    signoff: 'Un saludo cálido,',
    signature: 'Luna',
  }),
});

function presentPayToBookEmailDraft(input) {
  const src = input && typeof input === 'object' ? input : {};
  const language = src.language === 'es' ? 'es' : 'en';
  const paymentUrl = typeof src.payment_url === 'string' ? src.payment_url.trim() : '';
  const holdExpiresAt = typeof src.hold_expires_at === 'string' ? src.hold_expires_at.trim() : '';
  if (!paymentUrl || !holdExpiresAt) {
    return Object.freeze({
      status: 'not_ready',
      channel: PRESENTATION_CHANNELS.EMAIL,
      language,
      body: '',
      fact_block: '',
      draft_only: true,
      requires_staff_review: true,
      send_allowed: false,
      auto_send_allowed: false,
    });
  }
  const quoteBlock = compactEmailPayToBookQuoteBlock(src, language);
  const copy = PAY_TO_BOOK_COPY[language];
  const parts = [copy.hello, '', copy.thanks];
  if (quoteBlock) {
    parts.push('');
    parts.push(quoteBlock);
  }
  parts.push('');
  parts.push(copy.pay);
  parts.push(paymentUrl);
  parts.push('');
  parts.push(`${copy.hold} ${holdExpiresAt}.`);
  parts.push(copy.late);
  parts.push('');
  parts.push(copy.signoff);
  parts.push(copy.signature);
  return Object.freeze({
    status: 'draft_ready',
    channel: PRESENTATION_CHANNELS.EMAIL,
    language,
    body: parts.join('\n'),
    fact_block: quoteBlock || '',
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
  });
}

function whatsappQuoteLine(facts, language) {
  const label = guestSafeOfferingLabel(facts && facts.offering_label);
  const money = formatMoneyFromCents(factCents(facts), language);
  if (!label || !money) return null;
  return language === 'es' ? `${label} sale a ${money}.` : `${label} comes to ${money}.`;
}

function normalizeAsks(asks) {
  if (!Array.isArray(asks)) return [];
  const out = [];
  for (let i = 0; i < asks.length; i += 1) {
    const key = asks[i];
    if (ASK_KEYS.indexOf(key) === -1) continue;
    if (out.indexOf(key) !== -1) continue;
    out.push(key);
  }
  return out.slice(0, 2);
}

function groupedEmailAsk(asks, language) {
  const lang = language === 'es' ? 'es' : 'en';
  const keys = normalizeAsks(asks);
  if (keys.length === 0) return '';
  if (keys.length === 1) return ASK_COPY[keys[0]][lang];
  if (keys.indexOf('dates') !== -1 && keys.indexOf('guest_count') !== -1) {
    return ASK_COPY.dates_and_guest_count[lang];
  }
  return ASK_COPY[keys[0]][lang];
}

function whatsappAsk(asks, language) {
  const lang = language === 'es' ? 'es' : 'en';
  const keys = normalizeAsks(asks);
  if (keys.length === 0) return '';
  return ASK_COPY[keys[0]][lang];
}

function presentGroundedReply(input) {
  const src = input && typeof input === 'object' ? input : {};
  const channel = src.channel === PRESENTATION_CHANNELS.EMAIL
    ? PRESENTATION_CHANNELS.EMAIL
    : PRESENTATION_CHANNELS.WHATSAPP;
  const language = src.language === 'es' ? 'es' : 'en';
  const facts = src.facts && typeof src.facts === 'object' ? src.facts : {};
  const asks = normalizeAsks(src.asks);
  const factBlock = channel === PRESENTATION_CHANNELS.EMAIL
    ? compactEmailQuoteBlock(facts, language)
    : whatsappQuoteLine(facts, language);
  const askBlock = channel === PRESENTATION_CHANNELS.EMAIL
    ? groupedEmailAsk(asks, language)
    : whatsappAsk(asks, language);
  const parts = [];
  if (channel === PRESENTATION_CHANNELS.EMAIL) {
    parts.push(language === 'es' ? 'Hola,' : 'Hi,');
    if (factBlock) parts.push(factBlock);
    if (askBlock) parts.push(askBlock);
    parts.push(language === 'es' ? 'Un saludo cálido,\nLuna' : 'Warm regards,\nLuna');
  } else {
    if (factBlock) parts.push(factBlock);
    if (askBlock) parts.push(askBlock);
  }
  const body = parts.join('\n\n');
  return Object.freeze({
    status: 'draft_ready',
    channel,
    language,
    body,
    fact_block: factBlock || '',
    ask_block: askBlock || '',
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
  });
}

/**
 * Whether Luna may prepare an email draft. Staff-initiated Generate/Create Draft
 * still requires Luna On and Global Pause off. Autonomous/open drafting also
 * requires Needs Human (matching the existing open-claim SQL). Never send.
 */
function emailDraftingAllowed(state) {
  const denied = (reason) => Object.freeze({
    allowed: false,
    reason,
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
  });
  const allowed = (reason) => Object.freeze({
    allowed: true,
    reason,
    draft_only: true,
    requires_staff_review: true,
    send_allowed: false,
    auto_send_allowed: false,
  });
  if (!state || typeof state !== 'object') return denied('malformed_state');
  const src = state;
  // Missing/malformed controls fail closed. Staff Create Draft may bypass
  // Needs Human only; Luna On and Global Pause still gate that path.
  if (src.global_pause !== false) return denied('global_pause');
  if (src.luna_on !== true) return denied('luna_off');
  if (src.staff_initiated === true) return allowed('staff_initiated');
  if (src.needs_human !== true) return denied('needs_human');
  return allowed('draft_ready');
}

module.exports = {
  PRESENTATION_CHANNELS,
  ASK_KEYS,
  guestSafeOfferingLabel,
  formatMoneyFromCents,
  compactEmailQuoteBlock,
  compactEmailPayToBookQuoteBlock,
  groupedEmailAsk,
  presentGroundedReply,
  presentPayToBookEmailDraft,
  emailDraftingAllowed,
};
