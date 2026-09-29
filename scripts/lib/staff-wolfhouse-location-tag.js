'use strict';

/**
 * Staff-visible location identity.
 *
 * Wolfhouse lab guests must show the Wolfhouse location id (wolfhouse-somo).
 * A missing tag, or a Sunset school id stuffed in by a Sunset default, is not
 * that identity. Sunset guests keep sunset-somo / sunset-sardinero.
 *
 * Keep in step with staffChromeLocationTag in scripts/browser/inbox-columns.js.
 */

const WOLFHOUSE_LOCATION_ID = 'wolfhouse-somo';
const SUNSET_LOCATION_IDS = Object.freeze(['sunset-somo', 'sunset-sardinero']);

function staffChromeNormalizeLocationId(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

function staffChromeIsWolfhouseIdentity(raw) {
  const id = staffChromeNormalizeLocationId(raw);
  return id === 'wolfhouse-somo' || id === 'wolfhouse';
}

function staffChromeIsSunsetLocationId(raw) {
  const id = staffChromeNormalizeLocationId(raw);
  return id === 'sunset-somo' || id === 'sunset-sardinero';
}

function staffChromeKeepLocationId(raw) {
  const id = staffChromeNormalizeLocationId(raw);
  if (staffChromeIsWolfhouseIdentity(id) || staffChromeIsSunsetLocationId(id)) return id;
  return '';
}

const STAFF_CHROME_LOCATION_KEYS = Object.freeze([
  'location_id',
  'locationId',
  'location_key',
  'locationKey',
  'client_slug',
  'clientSlug',
]);

function staffChromeCollectLocationIds(src, out, depth) {
  if (src == null || depth > 3) return;
  if (typeof src === 'string' || typeof src === 'number') {
    const id = staffChromeKeepLocationId(src);
    if (id) out.push(id);
    return;
  }
  if (typeof src !== 'object') return;
  for (let i = 0; i < STAFF_CHROME_LOCATION_KEYS.length; i += 1) {
    const key = STAFF_CHROME_LOCATION_KEYS[i];
    if (src[key] != null && typeof src[key] !== 'object') {
      staffChromeCollectLocationIds(src[key], out, depth + 1);
    }
  }
  if (src.metadata) staffChromeCollectLocationIds(src.metadata, out, depth + 1);
  if (src.booking) staffChromeCollectLocationIds(src.booking, out, depth + 1);
  if (src.identity) staffChromeCollectLocationIds(src.identity, out, depth + 1);
  if (src.conversation) staffChromeCollectLocationIds(src.conversation, out, depth + 1);
  if (Array.isArray(src.bookings)) {
    for (let b = 0; b < src.bookings.length; b += 1) {
      staffChromeCollectLocationIds(src.bookings[b], out, depth + 1);
    }
  }
}

/**
 * @param {string} portalClient staff portal client (`getClient()`)
 * @param {...(string|object|null)} sources guest, booking, or conversation rows
 * @returns {string} wolfhouse-somo, a Sunset location id, or ''
 */
function staffChromeLocationTag(portalClient) {
  const found = [];
  if (staffChromeIsWolfhouseIdentity(portalClient)) found.push(WOLFHOUSE_LOCATION_ID);
  for (let i = 1; i < arguments.length; i += 1) {
    staffChromeCollectLocationIds(arguments[i], found, 0);
  }
  for (let w = 0; w < found.length; w += 1) {
    if (staffChromeIsWolfhouseIdentity(found[w])) return WOLFHOUSE_LOCATION_ID;
  }
  for (let s = 0; s < found.length; s += 1) {
    if (staffChromeIsSunsetLocationId(found[s])) return staffChromeNormalizeLocationId(found[s]);
  }
  return '';
}

module.exports = {
  WOLFHOUSE_LOCATION_ID,
  SUNSET_LOCATION_IDS,
  staffChromeLocationTag,
  staffChromeIsWolfhouseIdentity,
  staffChromeIsSunsetLocationId,
};
