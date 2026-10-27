'use strict';

/**
 * Guest-facing property address. WhatsApp treats bare 5-digit postcodes as
 * phone numbers, so Luna never prints the postcode. Maps link stays exact.
 *
 * Each numeric token is house, street/route, or postcode from its neighbors:
 * labelled / glued-to-town / ZIP-after-state is postcode; a 5-digit before
 * another postcode is house; a 5-digit before a town is postcode only when
 * a house number already exists. The word immediately before a trailing
 * number is that number's role label (type → street/route, name → house).
 * Labels never eat street or town names.
 */

const DIGIT_POSTCODE = /^(?:[A-Z]-)?\d{5}(?:-\d{4})?$/i;
const UK_OUTWARD = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
const UK_INWARD = /^\d[A-Z]{2}$/i;
const CA_FORWARD = /^[A-Z]\d[A-Z]$/i;
const CA_INWARD = /^\d[A-Z]\d$/i;
const POSTAL_LABEL = /^(C\.?\s*P\.?|CP|CAP|ZIP(?:\s+CODE)?|C[OÓ]DIGO\s+POSTAL)(?![A-Za-zÁÉÍÓÚÜáéíóúüÑñ])\s*[:.\-]?\s*/i;
const STREET_TYPE = /^(?:C\.|Calle|Carrera|Highway|Hwy|Route|Rte|Road|Rd\.?|Street|St\.?|Avenue|Avenida|Ave\.?|Av\.|V[ií]a|Rue|Plaza|Paseo|Camino|Strada)$/i;

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

function tokensOf(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function firstToken(text) {
  return tokensOf(text)[0] || '';
}

function secondToken(text) {
  return tokensOf(text)[1] || '';
}

/**
 * Role of a trailing number on a comma/newline part.
 * bare `41` → house; `Highway 1` / `Avenida 42` / `State Route 1` → street
 * (the type word sits on the number); `Diagonal 123` / `Via Roma 12` → house
 * (the name sits on the number).
 */
function trailingNumberRole(text) {
  const tokens = tokensOf(text);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  if (!/^\d+[A-Za-z]?$/.test(last)) return null;
  if (tokens.length === 1) return 'house';
  if (isDigitPostcode(last)) return 'house';
  const label = tokens[tokens.length - 2];
  if (STREET_TYPE.test(label)) return 'street';
  return 'house';
}

function isPostalToken(tok) {
  return isDigitPostcode(tok);
}

function fragmentsFromComponent(text, isFirst, isLast, labelled) {
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
    const nextText = parts[i + 1] ? parts[i + 1].text : '';
    const nextStartsWithPostcode = nextText && (isPostalToken(firstToken(nextText)) || isTwoTokenPostcode(
      firstToken(nextText),
      secondToken(nextText),
    ));
    const partIsPostal = !parts[i].labelled && isPostalToken(String(parts[i].text || '').trim());
    const nextStartsWithTown = nextText && !isPostalToken(firstToken(nextText)) && !isTwoTokenPostcode(
      firstToken(nextText), secondToken(nextText),
    );
    // A 5-digit whose next part starts with a postcode is the house number.
    if (partIsPostal && nextStartsWithPostcode) {
      kept.push(parts[i].text.trim());
      continue;
    }
    const previousRole = i > 0 ? trailingNumberRole(parts[i - 1].text) : null;
    // 5-digit next to the town is a postcode only when a house number already exists.
    if (partIsPostal && !isFirst && nextStartsWithTown && previousRole === 'house') continue;
    const frags = fragmentsFromComponent(parts[i].text, isFirst, i === parts.length - 1, parts[i].labelled);
    for (const frag of frags) kept.push(frag);
  }
  return kept.join(', ');
}

module.exports = {
  formatGuestPropertyAddress,
};
