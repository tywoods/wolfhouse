'use strict';

/**
 * Shared production resolver for rental offering display labels.
 *
 * P0e precedence (authoritative current Admin catalog wins):
 *   catalogLabel (opts / map / meta.catalog_label)
 *   → meaningful persisted (offering_label, display_name, label, service_name)
 *   → humanized key fallback
 *
 * Rejects identity-like candidates (equal to offering_key / item_code).
 * Never prefer bare offering_key when a friendly label can be derived.
 * Exact offering_key only — never borrow labels across alias keys.
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
 * Build offering_key → Admin label map from tenant_rental_offerings rows.
 * Exact offering_key only — never alias borrow across keys.
 *
 * Tenant/location isolation:
 *   - Reject foreign client_slug/tenant when opts.clientSlug is set.
 *   - Reject foreign location_id when opts.locationId is set (null/empty
 *     location = client-wide fallback allowed).
 *   - Prefer exact location match over client-wide for the same key.
 *
 * @param {Array<object>|null|undefined} offerings
 * @param {object} [opts]
 * @param {string} [opts.clientSlug]
 * @param {string} [opts.locationId]
 * @param {boolean} [opts.includeInactive=false] historical readers may set true
 * @returns {Record<string, string>}
 */
function buildRentalCatalogLabelMap(offerings, opts) {
  const o = opts || {};
  const wantClient = o.clientSlug != null ? String(o.clientSlug).trim() : '';
  const wantLoc = o.locationId != null ? String(o.locationId).trim() : '';
  const includeInactive = o.includeInactive === true;
  const map = Object.create(null);
  const rank = Object.create(null); // higher wins: exact location (2) > client-wide (1)
  const list = Array.isArray(offerings) ? offerings : [];
  for (let i = 0; i < list.length; i += 1) {
    const off = list[i];
    if (!off) continue;
    if (!includeInactive && off.active === false) continue;
    const key = String(off.offering_key || '').trim();
    if (!key) continue;
    const offClient = String(off.client_slug || off.tenant || '').trim();
    if (wantClient && offClient && offClient !== wantClient) continue;
    const offLoc = off.location_id != null && String(off.location_id).trim()
      ? String(off.location_id).trim()
      : '';
    if (wantLoc && offLoc && offLoc !== wantLoc) continue;
    const label = String(off.label || off.display_name || '').trim();
    if (!label) continue;
    // Exact location for this request ranks above client-wide (null location).
    const thisRank = (wantLoc && offLoc === wantLoc) ? 2 : 1;
    if (map[key] != null && (rank[key] || 0) >= thisRank) continue;
    map[key] = label;
    rank[key] = thisRank;
  }
  return map;
}

/**
 * Look up catalog label by exact offering_key (Map or plain object).
 * @param {Map<string,string>|Record<string,string>|null|undefined} catalogLabelMap
 * @param {string} offeringKey
 * @returns {string}
 */
function lookupCatalogLabel(catalogLabelMap, offeringKey) {
  if (!catalogLabelMap) return '';
  const key = String(offeringKey || '').trim();
  if (!key) return '';
  if (typeof catalogLabelMap.get === 'function') {
    const v = catalogLabelMap.get(key);
    return v != null ? String(v).trim() : '';
  }
  const v = catalogLabelMap[key];
  return v != null ? String(v).trim() : '';
}

/**
 * Resolve a friendly rental label from metadata fields and/or offering key.
 *
 * Precedence (P0e):
 *   1. opts.catalogLabel
 *   2. catalog map lookup by exact offering_key
 *   3. meta.catalog_label
 *   4. meaningful persisted: offering_label → display_name → label → service_name
 *   5. key fallback (board/wetsuit specials, then Title Case humanize)
 *
 * @param {object|string|null} metaOrFields
 * @param {object} [opts]
 * @param {string} [opts.offeringKey]
 * @param {string} [opts.itemCode]
 * @param {string} [opts.catalogLabel] authoritative Admin label for this key
 * @param {Map<string,string>|Record<string,string>} [opts.catalogLabelMap]
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

  // 1–3: authoritative current catalog label first (Admin rename updates immediately).
  const catalogCandidates = [
    o.catalogLabel,
    lookupCatalogLabel(o.catalogLabelMap, key) || null,
    meta.catalog_label,
  ];
  for (let i = 0; i < catalogCandidates.length; i += 1) {
    const raw = catalogCandidates[i];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (isIdentityLikeRentalLabel(text, key, itemCode)) continue;
    return text;
  }

  // 4: meaningful persisted snapshot (compatibility fallback only).
  const persistedCandidates = [
    meta.offering_label,
    meta.display_name,
    // Historical CE / quote snapshots often stamp `label` only.
    meta.label,
    meta.service_name,
  ];
  for (let i = 0; i < persistedCandidates.length; i += 1) {
    const raw = persistedCandidates[i];
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

/**
 * Overlay current catalog_label onto service-record metadata for display/readback.
 * Exact offering_key match only. Does not invent labels for unknown keys.
 * Clones rows/metadata so callers do not mutate DB-shaped sources unexpectedly.
 *
 * @param {Array<object>|null|undefined} rows
 * @param {Map<string,string>|Record<string,string>|null|undefined} catalogLabelMap
 * @returns {Array<object>}
 */
function enrichServiceRecordsWithCatalogLabels(rows, catalogLabelMap) {
  const list = Array.isArray(rows) ? rows : [];
  if (!catalogLabelMap) return list.slice();

  return list.map((row) => {
    if (!row || typeof row !== 'object') return row;
    let meta = row.metadata;
    if (meta == null) meta = row._meta;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
    }
    if (!meta || typeof meta !== 'object') meta = {};
    const key = String(meta.offering_key || '').trim();
    if (!key) return row;
    const catalogLabel = lookupCatalogLabel(catalogLabelMap, key);
    if (!catalogLabel) return row;
    // Always overlay current catalog label (Admin rename wins over stale snapshots).
    const nextMeta = { ...meta, catalog_label: catalogLabel };
    const next = { ...row, metadata: nextMeta };
    if (row._meta != null) next._meta = { ...nextMeta };
    return next;
  });
}

module.exports = {
  humanizeRentalOfferingKey,
  isIdentityLikeRentalLabel,
  buildRentalCatalogLabelMap,
  lookupCatalogLabel,
  resolveRentalOfferingFriendlyLabel,
  enrichServiceRecordsWithCatalogLabels,
};
