'use strict';

/**
 * Guest-facing property address. WhatsApp treats bare 5-digit postcodes as
 * phone numbers, so Luna never prints the postcode. Maps link stays exact.
 */

const POSTCODE_ONLY = /^(?:\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d)$/i;
const LEADING_POSTCODE = /^(?:\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d)\s+/i;
const TRAILING_POSTCODE = /\s+(?:\d{5}(?:-\d{4})?|[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|[A-Z]\d[A-Z]\s*\d[A-Z]\d)$/i;

function formatGuestPropertyAddress(address) {
  const raw = address == null ? '' : String(address).trim();
  if (!raw) return '';
  const parts = raw.split(',').map((part) => String(part || '').trim()).filter(Boolean);
  const kept = [];
  for (const part of parts) {
    if (POSTCODE_ONLY.test(part)) continue;
    const withoutLeading = part.replace(LEADING_POSTCODE, '').trim();
    const cleaned = withoutLeading.replace(TRAILING_POSTCODE, '').trim();
    if (cleaned) kept.push(cleaned);
  }
  return kept.join(', ');
}

module.exports = {
  formatGuestPropertyAddress,
};
