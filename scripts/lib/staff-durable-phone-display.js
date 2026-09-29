'use strict';

/**
 * Staff-visible guest phone.
 *
 * Lab/simulator guests are stored under a durable +999 identity. A display or
 * metadata path must not mask that as an ordinary live number (+34…). When any
 * candidate is a durable lab phone, that string wins and stays — no blank, no
 * flicker, no opaque rewrite. Ordinary guests are unchanged.
 *
 * Never reads display_phone or simulator_source_phone. Those fields are the mask.
 */

function staffChromeHonestPhone(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (!p) return '';
  if (p.indexOf('staff:') === 0) return '';
  if (/^(emailcust1|emailv1|email):/i.test(p)) return '';
  if (/[A-Za-z]/.test(p)) return '';
  let digits = '';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p.charAt(i);
    if (ch >= '0' && ch <= '9') digits += ch;
  }
  if (digits.length < 6 || digits.length > 15) return '';
  return p;
}

function staffChromeCompactPhone(raw) {
  const p = staffChromeHonestPhone(raw);
  if (!p) return '';
  let digits = '';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p.charAt(i);
    if (ch >= '0' && ch <= '9') digits += ch;
  }
  return `+${digits}`;
}

function staffChromeIsDurableLabPhone(raw) {
  const compact = staffChromeCompactPhone(raw);
  return compact.indexOf('+999') === 0 && compact.length >= 8;
}

const STAFF_CHROME_PHONE_KEYS = Object.freeze([
  'durable_phone',
  'durablePhone',
  'phone',
  'guest_phone',
  'booking_phone',
  'customer_phone',
]);

function staffChromeCollectPhones(src, out, depth) {
  if (src == null || depth > 3) return;
  if (typeof src === 'string' || typeof src === 'number') {
    const n = staffChromeHonestPhone(src);
    if (n) out.push(n);
    return;
  }
  if (typeof src !== 'object') return;
  for (let i = 0; i < STAFF_CHROME_PHONE_KEYS.length; i += 1) {
    const key = STAFF_CHROME_PHONE_KEYS[i];
    if (src[key] != null && typeof src[key] !== 'object') {
      staffChromeCollectPhones(src[key], out, depth + 1);
    }
  }
  if (src.identity) staffChromeCollectPhones(src.identity, out, depth + 1);
  if (src.conversation) staffChromeCollectPhones(src.conversation, out, depth + 1);
  if (src.booking) staffChromeCollectPhones(src.booking, out, depth + 1);
}

/**
 * @param {...(string|object|null)} sources
 * @returns {string} durable lab phone when present, otherwise the first honest phone
 */
function staffChromeDurablePhone() {
  const found = [];
  for (let i = 0; i < arguments.length; i += 1) {
    staffChromeCollectPhones(arguments[i], found, 0);
  }
  for (let d = 0; d < found.length; d += 1) {
    if (staffChromeIsDurableLabPhone(found[d])) return found[d];
  }
  return found[0] || '';
}

module.exports = {
  staffChromeHonestPhone,
  staffChromeIsDurableLabPhone,
  staffChromeDurablePhone,
};
