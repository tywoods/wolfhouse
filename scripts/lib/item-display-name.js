'use strict';

/**
 * Shared authoritative display-name resolver for booking items / offerings.
 *
 * One owner for list/expand/schedule drawer/invoice/Luna guest-copy labels:
 *   - Rentals: resolve by offering_key via rental catalog (rental-offering-label)
 *   - Accommodation: package name, then room/bed fallbacks
 *   - Lessons/courses: course_label / private_lesson_label
 *   - Historical snapshots (label, offering_label, display_name) when current
 *     catalog identity is absent
 *
 * Never hardcode user-created item names (bundle labels, custom offerings) —
 * those must come from the catalog fixture / Admin label map.
 *
 * @module item-display-name
 */

const {
  resolveRentalOfferingFriendlyLabel,
  buildRentalCatalogLabelMap,
  lookupCatalogLabel,
} = require('./rental-offering-label');

function parseMeta(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : {};
    } catch (_e) {
      return {};
    }
  }
  return typeof raw === 'object' ? raw : {};
}

function firstNonEmpty(...candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const v = candidates[i];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function isAccommodation(meta, serviceType) {
  const m = meta || {};
  const st = String(serviceType || '').toLowerCase();
  const component = String(m.component || '').toLowerCase();
  const staffUi = String(m.staff_ui_service_type || '').toLowerCase();
  const source = String(m.source || '').toLowerCase();
  if (m.staff_accommodation === true) return true;
  if (source === 'staff_accommodation') return true;
  if (component === 'staff_accommodation' || staffUi === 'staff_accommodation') return true;
  if (st === 'accommodation' || st === 'lodging' || st === 'stay') return true;
  return false;
}

function isRentalLike(meta, serviceType) {
  const m = meta || {};
  const st = String(serviceType || '').toLowerCase();
  if (m.course_equipment === true) return true;
  if (m.rental_offering === true || m.generic_rental === true) return true;
  if (m.offering_key && (m.duration_key || m.item_code || m.unit_cents != null)) return true;
  if (st === 'surfboard' || st === 'wetsuit' || st === 'rental' || st === 'addon_service') return true;
  const component = String(m.component || '').toLowerCase();
  if (component.includes('rental') || component === 'surfboard' || component === 'wetsuit') return true;
  return false;
}

/**
 * Accommodation display name: package → room → bed → "Accommodation".
 * Uses historical snapshot fields when present.
 */
function resolveAccommodationDisplayName(meta, opts) {
  const m = meta || {};
  const o = opts || {};
  const packageName = firstNonEmpty(
    o.packageName,
    m.package_name,
    m.package_label,
    m.package_title,
    m.accommodation_package,
    m.product_name,
  );
  if (packageName) return packageName;

  const room = firstNonEmpty(
    o.roomName,
    m.room_name,
    m.room_label,
    m.room_code,
    m.assigned_room_code,
    m.requested_room_type,
    m.room_type,
  );
  const bed = firstNonEmpty(
    o.bedName,
    m.bed_name,
    m.bed_label,
    m.bed_code,
    m.assigned_bed_code,
  );
  if (room && bed) return `${room} · ${bed}`;
  if (room) return room;
  if (bed) return bed;

  const snapshot = firstNonEmpty(m.label, m.display_name, m.service_name, m.offering_label);
  if (snapshot && !/^staff[_\s-]?accommodation$/i.test(snapshot) && snapshot.toLowerCase() !== 'accommodation') {
    return snapshot;
  }
  return 'Accommodation';
}

/**
 * Resolve a single item/service display name from authoritative data.
 *
 * @param {object|null} itemOrService  service row or line item
 * @param {object} [opts]
 * @param {object} [opts.metadata]     override metadata
 * @param {string} [opts.serviceType]
 * @param {string} [opts.offeringKey]
 * @param {string} [opts.catalogLabel]
 * @param {Map|Record} [opts.catalogLabelMap]
 * @param {string} [opts.packageName]
 * @param {string} [opts.roomName]
 * @param {string} [opts.bedName]
 * @returns {string}
 */
function resolveItemDisplayName(itemOrService, opts) {
  const o = opts || {};
  const row = itemOrService && typeof itemOrService === 'object' ? itemOrService : {};
  const meta = o.metadata != null ? parseMeta(o.metadata) : parseMeta(row.metadata || row._meta || row);
  const serviceType = o.serviceType != null
    ? o.serviceType
    : (row.service_type || meta.service_type || null);

  // Custom staff lines: free-text label is the identity.
  if (
    meta.source === 'staff_custom_line'
    || meta.staff_custom_line === true
    || meta.component === 'staff_custom_line'
  ) {
    return firstNonEmpty(meta.label, meta.display_name, 'Custom line');
  }

  if (isAccommodation(meta, serviceType)) {
    return resolveAccommodationDisplayName(meta, o);
  }

  // Lessons / courses
  const component = String(meta.component || '').toLowerCase();
  const st = String(serviceType || '').toLowerCase();
  if (component === 'course' || component === 'private_lesson'
    || st === 'surf_lesson' || st === 'course' || st === 'private_lesson') {
    const lessonName = firstNonEmpty(
      meta.course_label,
      meta.private_lesson_label,
      meta.label,
      meta.display_name,
      component === 'private_lesson' ? 'Private Course' : null,
      st === 'private_lesson' ? 'Private Course' : null,
      'Group Course',
    );
    return lessonName;
  }

  if (isRentalLike(meta, serviceType)) {
    const key = String(
      o.offeringKey != null ? o.offeringKey : (meta.offering_key || row.offering_key || ''),
    ).trim();
    return resolveRentalOfferingFriendlyLabel(meta, {
      offeringKey: key,
      itemCode: meta.item_code || meta.offering_item_code || null,
      catalogLabel: o.catalogLabel,
      catalogLabelMap: o.catalogLabelMap,
    });
  }

  // Generic fallback: historical snapshot → service type
  return firstNonEmpty(
    meta.catalog_label,
    meta.offering_label,
    meta.display_name,
    meta.label,
    meta.service_name,
    meta.course_label,
    meta.staff_ui_service_type,
    serviceType,
    row.label,
  );
}

module.exports = {
  resolveItemDisplayName,
  resolveAccommodationDisplayName,
  buildRentalCatalogLabelMap,
  lookupCatalogLabel,
  resolveRentalOfferingFriendlyLabel,
  isAccommodation,
  isRentalLike,
  parseMeta,
};
