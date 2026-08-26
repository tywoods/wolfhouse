'use strict';

/**
 * Canonical ungounded hard-truth claim detector for MAIL-MVP-001 Create Draft.
 *
 * Staff API remains the only authority for prices, availability, payment URLs,
 * holds, and bookings. This owner is the shared fail-closed gate for:
 *   - private staff-goal filtering (extractPermittedOperatorGuidance)
 *   - freeform natural-author model-output validation
 *
 * Do not route freeform prose through the grounded template validator: that
 * path rejects valid natural drafts for unrelated template constraints, and
 * it allows prices/availability only when they already match grounded facts.
 *
 * Asking whether the guest wants to make a booking remains allowed.
 * Conversational “please hold while we check” is not an inventory hold.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;

const WORD_NUMBER = '(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien(?:to)?)';

// Currency symbols/codes, decimal amounts, price/cost words, and EN/ES
// currency word forms plus slang. Do not treat plain quantities/dates as money.
const PRICE_OR_MONEY = /€|\$|£|\b(?:eur|usd|gbp)\b|\d(?:eur|usd|gbp)\b|\b(?:eur|usd|gbp)\d|\b\d+[.,]\d{2}\b|\b(?:prices?|precios?|cost[eo]?s?|cuesta)\b|\b(?:euros?|dollars?|pounds?|d[oó]lar(?:es)?|libras?|bucks?|quid)\b|\d(?:euros?|dollars?|pounds?|d[oó]lar(?:es)?|libras?|bucks?|quid)\b/i;
const PRICE_RATE = new RegExp(
  String.raw`\b(?:\d{1,6}|${WORD_NUMBER})\s*(?:\/\s*|\s+(?:a|an|per|por|la)\s+)(?:nights?|noches?)\b`,
  'i',
);
const URLISH = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/i;
const PAYMENT_CLAIM = /\bpay\s+now\b|\bpaga(?:r)?\s+ahora\b|\bpayment\s+(?:link|url)\b|\benlace\s+de\s+pago\b|\blink\s+de\s+pago\b|\baqu[ií]\s+tienes\s+el\s+enlace\b|\bstripe\b|\bdeposits?\b|\bdep[oó]sitos?\b/i;
const AVAIL_CLAIM = /\bavailab(?:le|ility)\b|\bdisponib(?:le|ilidad)\b|\bhay\s+(?:disponibilidad|sitio|plaza|hueco|espacio)\b|\b(?:we\s+can\s+|can\s+)?fit\s+you\s+in\b|\bwe\s+(?:have|can\s+take)\s+(?:a\s+)?(?:room|bed|space|spot|availability)\b|\btenemos\s+(?:sitio|plaza|disponibilidad|habitaci[oó]n|cama)\b|\bpodemos\s+(?:alojarte|meterte|encajarte)\b/i;
const INVENTORY_HOLD_CLAIM = /\b(?:put|place|make)\s+(?:a\s+|the\s+)?hold\b|\bon\s+hold\b|\bhold(?:s|ing)?\s+(?:the\s+|your\s+|a\s+|una\s+|la\s+)?(?:room|bed|dates?|booking|reservation|spot|space|habitaci[oó]n|cama|reserva)\b|\b(?:room|bed|dates?|booking|reservation|habitaci[oó]n|cama|reserva)\s+(?:is\s+|est[aá]\s+)?(?:on\s+)?hold\b|\bwe(?:['’]re| are)\s+holding\s+(?:the\s+|a\s+|your\s+|una\s+|la\s+)?(?:room|bed|dates?|booking|reservation|spot|space|habitaci[oó]n|cama|reserva)\b|\b(?:retener|retenemos|retenido|retendremos)\b/i;
const BOOKING_AUTHORITY_CLAIM = /\bbooking\s+(?:is|code|confirmed|created|id)\b|\bcreate(?:d)?\s+the\s+booking\b|\bwe(?:['’]ve| have)\s+(?:booked|reserved)\b|\bi(?:['’]ve| have)?\s+booked\b|\b(?:your\s+)?(?:reservation|booking)\s+is\s+(?:all\s+set|confirmed|created|ready)\b|\b(?:la\s+|tu\s+)?reserva\s+est[aá]\s+(?:confirmada|lista|creada|hecha)\b|\bhemos\s+(?:reservado|creado\s+(?:la\s+)?reserva|confirmado\s+(?:la\s+)?reserva)\b|\bconfirm(?:s|ed|ing)?\s+(?:the\s+|your\s+|la\s+)?(?:booking|reservation|reserva)\b|\bconfirma(?:r)?\s+(?:la\s+)?(?:reserva|habitaci[oó]n)\b/i;

function asText(value) {
  if (typeof value !== 'string' || isProxy(value)) return '';
  try {
    return value.normalize('NFC');
  } catch {
    return value;
  }
}

function hasHardTruthClaim(value) {
  const text = asText(value);
  if (!text) return false;
  return PRICE_OR_MONEY.test(text)
    || PRICE_RATE.test(text)
    || URLISH.test(text)
    || PAYMENT_CLAIM.test(text)
    || AVAIL_CLAIM.test(text)
    || INVENTORY_HOLD_CLAIM.test(text)
    || BOOKING_AUTHORITY_CLAIM.test(text);
}

module.exports = freeze({
  hasHardTruthClaim,
});
