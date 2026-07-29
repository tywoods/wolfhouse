'use strict';

const {
  normalizeEquipmentOptions,
  validateEquipmentSelection,
  normalizeSelection,
  activeScopedOfferingMap,
} = require('./sunset-course-equipment-options');

function checkedAdd(a, b, name = 'money total') {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) {
    throw new RangeError(`${name} overflow`);
  }
  return a + b;
}

function checkedMultiply(a, b, name = 'money total') {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a * b)) {
    throw new RangeError(`${name} overflow`);
  }
  return a * b;
}

/**
 * Course-owned multi-item equipment quote authority.
 * Charge once per booked course × selected quantity (never per course day).
 * During = qty × equipment_price_cents
 * All Day = qty × (equipment_price_cents + all_day_surcharge_cents); surcharge 0 remains valid.
 */
function quoteCourseEquipment({
  course,
  selection,
  surfers,
  offerings,
  clientSlug,
  locationId,
}) {
  const selected = validateEquipmentSelection(selection, surfers);
  const configured = new Map(
    ((course && Array.isArray(course.equipment_options)) ? course.equipment_options : [])
      .map((x) => [String(x.offering_key || '').trim(), x]),
  );
  const activeScoped = offerings
    ? activeScopedOfferingMap(offerings, { clientSlug, locationId })
    : null;

  const lines = [];
  let total_cents = 0;
  const transport = [];

  for (const item of selected) {
    const option = configured.get(item.offering_key);
    if (!option) throw new TypeError('equipment is not configured for selected course');
    if (activeScoped && !activeScoped.has(item.offering_key)) {
      throw new TypeError('equipment offering is not an active scoped rental');
    }

    const base = option.equipment_price_cents;
    const surcharge = option.all_day_surcharge_cents;
    if (!Number.isSafeInteger(base) || base < 0) throw new TypeError('equipment_price_cents invalid');
    if (!Number.isSafeInteger(surcharge) || surcharge < 0) throw new TypeError('all_day_surcharge_cents invalid');

    const unit = checkedAdd(base, item.all_day ? surcharge : 0, 'equipment unit');
    const total = checkedMultiply(unit, item.quantity, 'equipment line');
    total_cents = checkedAdd(total_cents, total, 'equipment total');

    const mode = item.all_day ? 'all_day' : 'during_course';
    const active = activeScoped && activeScoped.get(item.offering_key);
    const label = String(
      (active && (active.label || active.display_name))
      || option.label
      || item.offering_key,
    );

    transport.push({ offering_key: item.offering_key, mode, quantity: item.quantity });
    lines.push({
      offering_key: item.offering_key,
      label,
      quantity: item.quantity,
      all_day: item.all_day,
      mode,
      base_amount_cents: base,
      base_unit_cents: base,
      all_day_surcharge_cents: surcharge,
      all_day_surcharge_unit_cents: surcharge,
      amount_cents: unit,
      unit_amount_cents: unit,
      total_cents: total,
      course_equipment: true,
      course_equipment_mode: mode,
      billing_unit: 'person_per_course',
      price_source: 'course_owned_equipment',
      metadata: {
        offering_key: item.offering_key,
        course_id: (course && (course.course_id || course.pack_id)) || null,
        course_equipment: true,
        course_equipment_mode: mode,
        price_basis: 'per_person_per_course',
        pricing_provenance: 'course_owned_equipment',
        base_unit_cents: base,
        all_day_surcharge_unit_cents: surcharge,
      },
    });
  }

  return {
    total_cents,
    lines,
    selections: selected,
    course_equipment: transport,
  };
}

function invoiceLines(quote) {
  return ((quote && quote.lines) || []).map((line) => ({
    description: `${line.label} — ${line.all_day ? 'All Day' : 'During Course'}`,
    quantity: line.quantity,
    unit_amount_cents: line.amount_cents,
    total_cents: line.total_cents,
    offering_key: line.offering_key,
  }));
}

// Transitional validator for the obsolete location-shared Admin route only.
// Current quote/create callers must use course-owned equipment_options above.
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid course equipment pricing');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'all_day') throw new TypeError('unknown course_equipment_pricing field');
  }
  const row = value.all_day;
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new TypeError('all_day must be an object');
  }
  for (const key of Object.keys(row)) {
    if (!['enabled', 'surfboard_cents', 'wetsuit_cents'].includes(key)) {
      throw new TypeError('unknown all_day field');
    }
  }
  if (typeof row.enabled !== 'boolean') throw new TypeError('all_day.enabled must be boolean');
  if (!Number.isSafeInteger(row.surfboard_cents) || row.surfboard_cents < 0) {
    throw new TypeError('all_day.surfboard_cents must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(row.wetsuit_cents) || row.wetsuit_cents < 0) {
    throw new TypeError('all_day.wetsuit_cents must be a non-negative safe integer');
  }
  return {
    all_day: {
      enabled: row.enabled,
      surfboard_cents: row.surfboard_cents,
      wetsuit_cents: row.wetsuit_cents,
    },
  };
}

module.exports = {
  checkedAdd,
  checkedMultiply,
  quoteCourseEquipment,
  invoiceLines,
  validateConfig,
  normalizeSelection,
  validateEquipmentSelection,
  normalizeEquipmentOptions,
};
