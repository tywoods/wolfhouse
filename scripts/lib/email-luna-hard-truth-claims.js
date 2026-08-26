'use strict';

/**
 * Defense-in-depth ungounded hard-truth claim detector for MAIL-MVP-001.
 *
 * Staff API remains the only authority for prices, availability, payment URLs,
 * holds, and bookings. The Create Draft safety boundary is the closed
 * enumerated plan schema plus the deterministic renderer. This owner is a
 * shared extra gate for:
 *   - private staff-goal filtering (extractPermittedOperatorGuidance)
 *   - bounded topic labels and renderer output
 *
 * Do not treat this catalog as the primary safety boundary, and do not route
 * freeform model prose through the grounded template validator.
 *
 * Asking whether the guest wants to make a booking remains allowed.
 * Conversational “please hold while we check” is not an inventory hold.
 * Conversational “I’m available if you need anything” is not inventory.
 * Dates such as 26.08 and times such as 12.00 are not money.
 */

const util = require('node:util');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;

const WORD_NUMBER = '(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien(?:to)?)';
const INVENTORY = '(?:rooms?|beds?|spaces?|spots?|stays?|nights?|habitaci[oó]n(?:es)?|camas?|plazas?|sitios?|huecos?|disponibilidad)';

// Currency symbols/codes, price/cost words, and EN/ES currency word forms plus
// slang. Do not treat plain quantities, calendar dates (26.08), or clock times
// (12.00) as money. Decimal amounts count only when a currency marker is near.
const PRICE_OR_MONEY = /€|\$|£|\b(?:eur|usd|gbp)\b|\d(?:eur|usd|gbp)\b|\b(?:eur|usd|gbp)\d|\b(?:prices?|precios?|cost[eo]?s?|cuesta)\b|\b(?:euros?|dollars?|pounds?|d[oó]lar(?:es)?|libras?|bucks?|quid)\b|\d(?:euros?|dollars?|pounds?|d[oó]lar(?:es)?|libras?|bucks?|quid)\b|(?:€|\$|£)\s*\d+[.,]\d{2}|\d+[.,]\d{2}\s*(?:€|\$|£|\b(?:eur|usd|gbp|euros?|dollars?|pounds?|d[oó]lar(?:es)?|libras?|bucks?|quid)\b)/i;
const PRICE_RATE = new RegExp(
  String.raw`\b(?:\d{1,6}|${WORD_NUMBER})\s*(?:\/\s*|\s+(?:a|an|per|por|la)\s+)(?:nights?|noches?)\b|\b(?:\d{1,6}|${WORD_NUMBER})\s+nightly\b|\b(?:\d{1,6}|${WORD_NUMBER})\s+por\s+la\s+noche\b`,
  'i',
);
const URLISH = /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b|\b[a-z0-9-]{2,}\.[a-z]{2,}\/[^\s]*/i;
const PAYMENT_CLAIM = /\bpay\s+now\b|\bpaga(?:r)?\s+ahora\b|\bpaga\s+ya\b|\bpayment\s+(?:link|url)\b|\benlace\s+de\s+pago\b|\blink\s+de\s+pago\b|\baqu[ií]\s+tienes\s+el\s+enlace\b|\bhere(?:['’]s|\s+is)\s+(?:the\s+)?link\s+to\s+pay\b|\blink\s+to\s+pay\b|\bstripe\b|\bdeposits?\b|\bdep[oó]sitos?\b/i;
const AVAIL_CLAIM = new RegExp(
  String.raw`(?:\b(?:availab(?:le|ility)|disponib(?:le|ilidad))\b[^.]{0,48}\b${INVENTORY}\b|\b${INVENTORY}\b[^.]{0,48}\b(?:availab(?:le|ility)|disponib(?:le|ilidad))\b|\bhay\s+(?:disponibilidad|sitio|plaza|hueco|espacio|camas?|habitaci[oó]n(?:es)?)\b|\b(?:we\s+can\s+|can\s+)?fit\s+you\s+in\b|\bwe\s+(?:have|can\s+take)\s+(?:a\s+)?(?:room|bed|space|spot|availability)\b|\btenemos\s+(?:sitio|plaza|disponibilidad|habitaci[oó]n|cama)\b|\bpodemos\s+(?:alojarte|meterte|encajarte)\b)`,
  'i',
);
const INVENTORY_HOLD_CLAIM = /\b(?:put|place|make)\s+(?:a\s+|the\s+)?hold\b|\bon\s+hold\b|\bhold(?:s|ing)?\s+(?:the\s+|your\s+|a\s+|una\s+|la\s+)?(?:room|bed|dates?|booking|reservation|spot|space|habitaci[oó]n|cama|reserva)\b|\b(?:room|bed|dates?|booking|reservation|habitaci[oó]n|cama|reserva)\s+(?:is\s+|est[aá]\s+)?(?:on\s+)?hold\b|\bwe(?:['’]re| are)\s+holding\s+(?:the\s+|a\s+|your\s+|una\s+|la\s+)?(?:room|bed|dates?|booking|reservation|spot|space|habitaci[oó]n|cama|reserva)\b|\b(?:retener|retenemos|retenido|retendremos)\b|\bte\s+guardamos\s+(?:la\s+)?(?:habitaci[oó]n|cama|reserva)\b|\bguardamos\s+(?:la\s+)?(?:habitaci[oó]n|cama)\b/i;
const BOOKING_AUTHORITY_CLAIM = /\bbooking\s+(?:is|code|confirmed|created|id)\b|\bcreate(?:d)?\s+the\s+booking\b|\bwe(?:['’]ve| have)\s+(?:booked|reserved)\b|\bi(?:['’]ve| have)?\s+(?:booked|reserved)\b|\b(?:your\s+)?(?:reservation|booking|stay)\s+is\s+(?:all\s+set|confirmed|created|ready)\b|\b(?:la\s+|tu\s+)?reserva\s+est[aá]\s+(?:confirmada|lista|creada|hecha)\b|\breserva\s+confirmada\b|\bhemos\s+(?:reservado|creado\s+(?:la\s+)?reserva|confirmado\s+(?:la\s+)?reserva)\b|\bte\s+confirmamos\s+(?:la\s+)?reserva\b|\bconfirm(?:s|ed|ing)?\s+(?:the\s+|your\s+|la\s+)?(?:booking|reservation|reserva|stay|room)\b|\bconfirma(?:r|mos)?\s+(?:la\s+)?(?:reserva|habitaci[oó]n)\b/i;

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
