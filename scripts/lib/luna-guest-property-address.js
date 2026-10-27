'use strict';

/**
 * Guest-facing property address. WhatsApp treats bare 5-digit postcodes as
 * phone numbers, so Luna never prints the postcode. Maps link stays exact.
 *
 * Postal-role recognition: whole-word labels (C.P., CP, CAP, ZIP, código
 * postal), country-prefixed E-39140, and 5-digit tokens before a locality.
 * House numbers stay when they start the first line or sit before a
 * postcode-city. Labels never eat street or town names.
 */

const DIGIT_POSTCODE = /^(?:[A-Z]-)?\d{5}(?:-\d{4})?$/i;
const UK_OUTWARD = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const UK_INWARD = /^\d[A-Z]{2}$/i;
const CA_FORWARD = /^[A-Z]\d[A-Z]$/i;
const CA_INWARD = /^\d[A-Z]\d$/i;
const POSTAL_LABEL = /^(C\.?\s*P\.?|CP|CAP|ZIP(?:\s+CODE)?|C[OÓ]DIGO\s+POSTAL)(?![A-Za-zÁÉÍÓÚÜáéíóúüÑñ])\s*[:.\-]?\s*/i;

function splitPostalLabel(part) {
  const text = String(part || '').trim();
  const match = text.match(POSTAL_LABEL);
  if (!match) return { labelled: false, text };
  return { labelled: true, text: text.slice(match[0].length).trim() };
}

function isDigitPostcode(tok) {
  return DIGIT_POSTCODE.test(String(tok || ''));
}

function isTwoTokenPostcode(tok, next) {
  if (!next) return false;
  return (UK_OUTWARD.test(tok) && UK_INWARD.test(next))
    || (CA_FORWARD.test(tok) && CA_INWARD.test(next));
}

function partHasHouseNumber(text) {
  const value = String(text || '').trim();
  if (/^\d+[A-Za-z]?$/.test(value)) return true;
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return false;
  const last = tokens[tokens.length - 1];
  if (!/^\d+[A-Za-z]?$/.test(last)) return false;
  const head = tokens.slice(0, -1);
  // "Highway 1" / "Calle 42": the number is the street name, not the house.
  if (head.length === 1 && /^(?:C\.|Calle|V[ií]a|Highway|Hwy|Route|Rte|Road|Rd\.?|Street|St\.?|Avenue|Ave\.?|Av\.|Rue|Plaza|Paseo|Camino|Carrera|Strada)$/i.test(head[0])) {
    return false;
  }
  return true;
}

function isPostalToken(tok) {
  return isDigitPostcode(tok);
}

function fragmentsFromComponent(text, isFirst, isLast, labelled, preserveTrailingPostal = false) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  if (labelled) {
    while (tokens.length && (isPostalToken(tokens[0]) || isTwoTokenPostcode(tokens[0], tokens[1]))) {
      if (isTwoTokenPostcode(tokens[0], tokens[1])) tokens.splice(0, 2);
      else tokens.shift();
    }
    return tokens.length ? [tokens.join(' ')] : [];
  }
  const frags = [];
  let buf = [];
  const flush = () => {
    if (buf.length) {
      frags.push(buf.join(' '));
      buf = [];
    }
  };
  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    const next = tokens[t + 1];
    // Plain text proves a postal role only in the final comma/newline segment,
    // immediately before a locality. All other five-digit values are retained.
    if (isTwoTokenPostcode(tok, next) && isLast && t === 0 && tokens[t + 2]) {
      flush();
      t += 1;
      continue;
    }
    if (isPostalToken(tok)) {
      const postalBeforeTown = (!isFirst || t > 0) && next
        && !isPostalToken(next) && !isTwoTokenPostcode(next, tokens[t + 2]);
      const postalAfterRegion = isLast && t === tokens.length - 1 && /^[A-Z]{2}$/.test(tokens[t - 1] || '');
      if (postalBeforeTown || postalAfterRegion) {
        flush();
        continue;
      }
      buf.push(tok);
      continue;
    }
    buf.push(tok);
  }
  flush();
  return frags;
}

function formatGuestPropertyAddress(address, { alreadyFormatted = false } = {}) {
  const raw = address == null ? '' : String(address).trim();
  if (!raw || alreadyFormatted) return raw;
  const parts = raw.split(/[,\n]/).map((part) => splitPostalLabel(part)).filter((row) => row.text || row.labelled);
  const kept = [];
  for (let i = 0; i < parts.length; i += 1) {
    const isFirst = i === 0 && kept.length === 0;
    const nextPart = parts[i + 1];
    const nextText = nextPart ? nextPart.text : '';
    const nextStartsWithPostcode = nextText && (isPostalToken(nextText.split(/\s+/)[0]) || isTwoTokenPostcode(
      nextText.split(/\s+/)[0],
      nextText.split(/\s+/)[1],
    ));
    const partIsPostal = !parts[i].labelled && isPostalToken(String(parts[i].text || '').trim());
    const previousHasHouseNumber = i > 0 && partHasHouseNumber(parts[i - 1].text);
    const nextStartsWithTown = nextText && !isPostalToken(nextText.split(/\s+/)[0]) && !isTwoTokenPostcode(
      nextText.split(/\s+/)[0], nextText.split(/\s+/)[1],
    );
    if (partIsPostal && !isFirst && previousHasHouseNumber) continue;
    // A standalone five-digit component without a preceding house number has
    // no durable postal-role evidence after a prior formatting pass.
    if (partIsPostal && nextStartsWithPostcode) {
      kept.push(parts[i].text.trim());
      continue;
    }
    const frags = fragmentsFromComponent(parts[i].text, isFirst, i === parts.length - 1, parts[i].labelled, Boolean(nextStartsWithPostcode));
    for (const frag of frags) kept.push(frag);
  }
  return kept.join(', ');
}

module.exports = {
  formatGuestPropertyAddress,
};
