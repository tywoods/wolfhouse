/**
 * Browser-local money parse for Create/Edit custom lines.
 * Injected into /staff/ui via marker (NOT embedded in the buildUiHtml template
 * literal) so regex escapes are not consumed by template evaluation.
 *
 * Server revalidates with parseLocaleMoneyToCents on quote/create/update.
 * Browser globals; also runnable under Node vm for offline gates.
 */
'use strict';

/**
 * Parse a staff-entered money string (or integer cents number) to signed cents.
 * Accepts: 10, 10.0, 10.00, 10,50 (locale decimal), €10, -5, +3.5
 * Rejects: >2 decimal places, exponent forms, NaN text, non-finite numbers.
 */
function scheduleParseCreateMoneyToCents(raw) {
  if (raw == null) return { ok: false, error: 'amount_required' };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return { ok: false, error: 'amount_invalid' };
    return { ok: true, amount_cents: raw === 0 || Object.is(raw, -0) ? 0 : raw };
  }
  var s = String(raw).trim();
  if (!s) return { ok: false, error: 'amount_required' };
  // Strip currency symbols + NBSP + whitespace (keep sign for next step).
  s = s.replace(/[€$£\u00a0\s]/g, '');
  var neg = false;
  if (s.charAt(0) === '-') { neg = true; s = s.slice(1); }
  else if (s.charAt(0) === '+') { s = s.slice(1); }
  if (!s) return { ok: false, error: 'amount_required' };
  var lastDot = s.lastIndexOf('.');
  var lastComma = s.lastIndexOf(',');
  var normalized = s;
  if (lastDot >= 0 && lastComma >= 0) {
    normalized = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    var fracC = s.slice(lastComma + 1);
    normalized = (/^\d{1,2}$/.test(fracC) && s.indexOf(',') === lastComma)
      ? s.replace(',', '.')
      : s.replace(/,/g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return { ok: false, error: 'amount_invalid' };
  var parts = normalized.split('.');
  if (parts[1] != null && parts[1].length > 2) return { ok: false, error: 'amount_too_many_decimals' };
  var whole = parts[0] || '0';
  var frac = ((parts[1] || '') + '00').slice(0, 2);
  var cents = parseInt(whole, 10) * 100 + parseInt(frac, 10);
  if (!Number.isFinite(cents)) return { ok: false, error: 'amount_nan' };
  if (neg) cents = -cents;
  if (cents === 0) cents = 0;
  if (Math.abs(cents) > Number.MAX_SAFE_INTEGER) return { ok: false, error: 'amount_overflow' };
  return { ok: true, amount_cents: cents };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scheduleParseCreateMoneyToCents: scheduleParseCreateMoneyToCents,
  };
}
