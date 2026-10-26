'use strict';

/**
 * BOOKING-CODE-WH-PREFIX-001
 *
 * New Wolfhouse codes are WH-<YYYYMMDD>-<4 digits>.
 * Stored 8-digit WH- suffixes and MB-WOLFHO-<date>-<6 hex> still resolve.
 * Staff display maps that legacy form to WH-<date>-<suffix>.
 * Sunset codes (SUNSET- / ELSARDI- / MB-SUNSET-) are not renamed.
 */
const SUFFIX_RE = '(?:\\d{4}|\\d{8}|[0-9a-fA-F]{6})';
const LEGACY_RE = new RegExp('^MB-WOLFHO-(\\d{8}-' + SUFFIX_RE + ')$', 'i');
const MODERN_RE = new RegExp('^WH-(\\d{8}-' + SUFFIX_RE + ')$', 'i');

function trimCode(code) {
  return String(code == null ? '' : code).trim();
}

function displayWolfhouseBookingCode(code) {
  const s = trimCode(code);
  const legacy = s.match(LEGACY_RE);
  if (!legacy) return s;
  return `WH-${legacy[1]}`;
}

function wolfhouseBookingCodeAliases(code) {
  const s = trimCode(code);
  if (!s) return [];
  const out = [s];
  const legacy = s.match(LEGACY_RE);
  if (legacy) out.push(`WH-${legacy[1]}`);
  const modern = s.match(MODERN_RE);
  if (modern) out.push(`MB-WOLFHO-${modern[1]}`);
  return [...new Set(out)];
}

function isWolfhouseBookingCodeClient(clientSlug) {
  const slug = String(clientSlug || '').trim().toLowerCase();
  return slug === 'wolfhouse-somo' || slug === 'wolfhouse' || slug.startsWith('wolfhouse-');
}

/**
 * Prefer the row that already matches the caller's string, else the legacy twin.
 * Case-insensitive so a copied WH- form still finds MB-WOLFHO-… in Postgres.
 */
async function resolveStoredWolfhouseBookingCode(pg, clientSlug, code) {
  const aliases = wolfhouseBookingCodeAliases(code);
  if (!pg || !aliases.length) return trimCode(code);
  const upper = [...new Set(aliases.map((item) => item.toUpperCase()))];
  const result = await pg.query(
    `SELECT b.booking_code
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND UPPER(b.booking_code) = ANY($2::text[])
      ORDER BY CASE WHEN UPPER(b.booking_code) = UPPER($3) THEN 0 ELSE 1 END,
               b.booking_code
      LIMIT 1`,
    [String(clientSlug || '').trim(), upper, trimCode(code)]
  );
  const stored = result && result.rows && result.rows[0] && result.rows[0].booking_code;
  return stored ? String(stored) : trimCode(code);
}

module.exports = {
  LEGACY_RE,
  MODERN_RE,
  displayWolfhouseBookingCode,
  wolfhouseBookingCodeAliases,
  isWolfhouseBookingCodeClient,
  resolveStoredWolfhouseBookingCode,
};
