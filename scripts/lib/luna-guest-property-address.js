'use strict';

/**
 * Guest-facing property address. WhatsApp treats bare 5-digit postcodes as
 * phone numbers, so Luna never prints the postcode. Maps link stays exact.
 *
 * Classification is by label and position, not a street-word list:
 * labelled C.P./CP/CAP/ZIP, postcode-before-city on a later component,
 * house number next to a street name (first component) or standing alone
 * before the postcode-city.
 */

const POSTCODE_TOKEN = '(?:\\d{5}(?:-\\d{4})?|[A-Z]{1,2}\\d[A-Z\\d]?\\s*\\d[A-Z]{2}|[A-Z]\\d[A-Z]\\s*\\d[A-Z]\\d)';
const POSTCODE_ONLY = new RegExp('^' + POSTCODE_TOKEN + '$', 'i');
const LEADING_POSTCODE = new RegExp('^(' + POSTCODE_TOKEN + ')\\s+(.+)$', 'i');
const TRAILING_POSTCODE = new RegExp('^(.+?)\\s+(' + POSTCODE_TOKEN + ')$', 'i');
const POSTAL_LABEL = /^(?:c\.?\s*p\.?|cp|cap|zip(?:\s*code)?|c[oó]digo\s*postal)\s*[:.\-]?\s*/i;

function splitPostalLabel(part) {
  const text = String(part || '').trim();
  const match = text.match(POSTAL_LABEL);
  if (!match || match.index !== 0) return { labelled: false, text };
  return { labelled: true, text: text.slice(match[0].length).trim() };
}

function isPostcodeBeforeCity(text) {
  return Boolean(String(text || '').trim().match(LEADING_POSTCODE));
}

function formatGuestPropertyAddress(address) {
  const raw = address == null ? '' : String(address).trim();
  if (!raw) return '';
  const comps = raw.split(/[,\n]/).map((part) => splitPostalLabel(part)).filter((row) => row.text || row.labelled);
  const last = comps.length - 1;
  const kept = [];
  for (let i = 0; i < comps.length; i += 1) {
    let text = comps[i].text;
    if (!text) continue;
    if (comps[i].labelled) {
      if (POSTCODE_ONLY.test(text)) continue;
      const leading = text.match(LEADING_POSTCODE);
      if (leading) text = String(leading[2] || '').trim();
      if (text) kept.push(text);
      continue;
    }
    if (POSTCODE_ONLY.test(text)) {
      const next = comps[i + 1];
      const houseBeforeStreet = i === 0 && last > 0;
      const houseBeforePostcodeCity = next && isPostcodeBeforeCity(next.text);
      const houseBeforeLaterLocality = i > 0 && i < last;
      if (houseBeforeStreet || houseBeforePostcodeCity || houseBeforeLaterLocality) {
        kept.push(text);
      }
      continue;
    }
    const leading = text.match(LEADING_POSTCODE);
    if (leading) {
      if (i === 0) kept.push(text);
      else {
        const city = String(leading[2] || '').trim();
        if (city) kept.push(city);
      }
      continue;
    }
    const trailing = text.match(TRAILING_POSTCODE);
    if (trailing && i !== 0) {
      const locality = String(trailing[1] || '').trim();
      if (locality) kept.push(locality);
      continue;
    }
    kept.push(text);
  }
  return kept.join(', ');
}

module.exports = {
  formatGuestPropertyAddress,
};
