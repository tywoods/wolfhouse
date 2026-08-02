'use strict';

/**
 * Shared production resolver for rental offering display labels.
 *
 * Precedence: offering_label → catalog_label → display_name → label → humanized key.
 * Rejects identity-like candidates (equal to offering_key / item_code).
 * Never prefer bare offering_key when a friendly label can be derived.
 *
 * Browser day-ops / portal must keep behavioral parity (same rules); they cannot
 * require() this module, so keep the algorithm trivial and mirrored in tests.
 */

/**
 * @param {string} offeringKey
 * @returns {string}
 */
function humanizeRentalOfferingKey(offeringKey) {
  const key = String(offeringKey || '').trim();
  if (!key) return '';
  return key
    .replace(/_rental$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * True when a candidate label is just an identity key/code (not human-friendly).
 * Reject so callers fall through to catalog or humanized title-case.
 */
function isIdentityLikeRentalLabel(text, offeringKey, itemCode) {
  const t = String(text == null ? '' : text).trim().toLowerCase();
  if (!t) return true;
  if (t === 'addon_service' || t === 'rental') return true;
  const key = String(offeringKey == null ? '' : offeringKey).trim().toLowerCase();
  if (key && t === key) return true;
  const code = String(itemCode == null ? '' : itemCode).trim().toLowerCase();
  if (code && t === code) return true;
  // item_code style offering__duration stamped as a label
  if (key && t.startsWith(`${key}__`)) return true;
  return false;
}

/**
 * Resolve a friendly rental label from metadata fields and/or offering key.
 *
 * @param {object|string|null} metaOrFields
 * @param {object} [opts]
 * @param {string} [opts.offeringKey]
 * @param {string} [opts.itemCode]
 * @returns {string}
 */
function resolveRentalOfferingFriendlyLabel(metaOrFields, opts) {
  const o = opts || {};
  let meta = metaOrFields;
  if (meta == null) meta = {};
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  if (typeof meta !== 'object') meta = {};

  const key = String(
    o.offeringKey != null ? o.offeringKey : (meta.offering_key || ''),
  ).trim();
  const itemCode = String(
    o.itemCode != null ? o.itemCode : (meta.item_code || meta.offering_item_code || ''),
  ).trim();

  const candidates = [
    meta.offering_label,
    meta.catalog_label,
    meta.display_name,
    // Historical CE / quote snapshots often stamp `label` only.
    meta.label,
    meta.service_name,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (isIdentityLikeRentalLabel(text, key, itemCode)) continue;
    return text;
  }

  if (!key) return '';
  // Known component-lane fallbacks (Admin catalog often omits these).
  if (key === 'board_rental') return 'Surfboard';
  if (key === 'wetsuit_rental') return 'Wetsuit';
  const human = humanizeRentalOfferingKey(key);
  return human || key;
}

module.exports = {
  humanizeRentalOfferingKey,
  isIdentityLikeRentalLabel,
  resolveRentalOfferingFriendlyLabel,
};
