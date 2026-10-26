'use strict';

/**
 * Guest-facing property address. WhatsApp treats bare 5-digit postcodes as
 * phone numbers, so Luna never prints the postcode. Maps link stays exact.
 *
 * Drops postal *components* (labelled, standalone, or leading a locality).
 * Does not scrub every 5-digit token — house numbers stay.
 */

const POSTCODE_TOKEN = '(?:\\d{5}(?:-\\d{4})?|[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}|[A-Z]\\d[A-Z]\\s*\\d[A-Z]\\d)';
const POSTCODE_ONLY = new RegExp('^' + POSTCODE_TOKEN + '$', 'i');
const LEADING_POSTCODE = new RegExp('^(' + POSTCODE_TOKEN + ')\\s+(.+)$', 'i');
const TRAILING_POSTCODE = new RegExp('^(.+?)\\s+(' + POSTCODE_TOKEN + ')$', 'i');
const POSTAL_LABEL = /^(?:c\.?\s*p\.?|cp|zip(?:\s*code)?|c[oó]digo\s*postal)\s+/i;
const STREET_HINT = /\b(?:street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|lane|ln\.?|drive|dr\.?|way|rue|via|calle|camino|plaza|paseo|platz|strasse|straße|main)\b/i;

function isStreetComponent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (STREET_HINT.test(t)) return true;
  if (/^c\.\s+\S/i.test(t)) return true;
  return false;
}

function stripPostalFromComponent(part) {
  let text = String(part || '').trim();
  if (!text) return '';
  const unlabeled = text.replace(POSTAL_LABEL, '').trim();
  const hadLabel = unlabeled !== text;
  text = unlabeled;
  if (!text) return '';
  if (POSTCODE_ONLY.test(text)) return '';
  const leading = text.match(LEADING_POSTCODE);
  if (leading && (hadLabel || !isStreetComponent(leading[2]))) {
    text = String(leading[2] || '').trim();
  }
  if (!text || POSTCODE_ONLY.test(text)) return '';
  const trailing = text.match(TRAILING_POSTCODE);
  if (trailing && !isStreetComponent(text)) {
    text = String(trailing[1] || '').trim();
  }
  return text;
}

function formatGuestPropertyAddress(address) {
  const raw = address == null ? '' : String(address).trim();
  if (!raw) return '';
  const parts = raw.split(/[,\n]/).map((part) => String(part || '').trim()).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    const cleaned = stripPostalFromComponent(part);
    if (cleaned) kept.push(cleaned);
  }
  return kept.join(', ');
}

module.exports = {
  formatGuestPropertyAddress,
};
