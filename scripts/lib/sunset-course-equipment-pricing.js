'use strict';

const {
  normalizeEquipmentOptions,
  resolveEquipmentOptionMoney,
  validateEquipmentSelection,
  normalizeSelection,
  activeScopedOfferingMap,
  uniqueCourseServiceDates,
  defaultFreeDuringCourseEquipmentSelection,
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
 *
 * During Course and All Day are independent total unit prices (never base + surcharge).
 * Total = selected mode price × equipment quantity × UNIQUE course service dates.
 *
 * Browser submits only {offering_key, mode, quantity}; server resolves course + option money.
 */
function quoteCourseEquipment({
  course,
  selection,
  surfers,
  offerings,
  clientSlug,
  locationId,
  serviceDates,
}) {
  const selected = validateEquipmentSelection(selection, surfers);
  if (selected.length === 0) {
    return { total_cents: 0, lines: [], selections: [], course_equipment: [] };
  }

  const dates = uniqueCourseServiceDates(serviceDates);
  if (dates.length < 1) {
    throw new TypeError('course equipment requires unique course service dates');
  }
  const dateCount = dates.length;

  const rawOptions = (course && Array.isArray(course.equipment_options))
    ? course.equipment_options
    : [];
  const configured = new Map();
  for (const raw of rawOptions) {
    let money;
    try {
      money = resolveEquipmentOptionMoney(raw);
    } catch (err) {
      throw new TypeError(`equipment option price invalid: ${err.message || err}`);
    }
    configured.set(money.offering_key, {
      ...money,
      label: raw && raw.label != null ? raw.label : undefined,
    });
  }

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

    const during = option.during_course_price_cents;
    const allDay = option.all_day_price_cents;
    if (!item.all_day && option.during_course_policy === 'unavailable') {
      throw new TypeError('during-course equipment is unavailable for selected course');
    }
    if (!Number.isSafeInteger(during) || during < 0) {
      throw new TypeError('during_course_price_cents invalid');
    }
    if (!Number.isSafeInteger(allDay) || allDay < 0) {
      throw new TypeError('all_day_price_cents invalid');
    }

    const unit = item.all_day ? allDay : during;
    const perDate = checkedMultiply(unit, item.quantity, 'equipment per-date');
    const total = checkedMultiply(perDate, dateCount, 'equipment line');
    total_cents = checkedAdd(total_cents, total, 'equipment total');

    const mode = item.all_day ? 'all_day' : 'during_course';
    const active = activeScoped && activeScoped.get(item.offering_key);
    const label = String(
      (active && (active.label || active.display_name))
      || option.label
      || item.offering_key,
    );
    const courseId = (course && (course.course_id || course.pack_id || course.id)) || null;

    transport.push({ offering_key: item.offering_key, mode, quantity: item.quantity });
    lines.push({
      offering_key: item.offering_key,
      label,
      quantity: item.quantity,
      all_day: item.all_day,
      mode,
      during_course_price_cents: during,
      during_course_policy: option.during_course_policy,
      all_day_price_cents: allDay,
      amount_cents: unit,
      unit_amount_cents: unit,
      total_cents: total,
      date_count: dateCount,
      service_dates: dates.slice(),
      course_equipment: true,
      course_equipment_mode: mode,
      billing_unit: 'person_per_course_date',
      price_source: 'course_owned_equipment',
      metadata: {
        offering_key: item.offering_key,
        course_id: courseId,
        course_equipment: true,
        course_equipment_mode: mode,
        price_basis: 'per_person_per_course_date',
        pricing_provenance: 'course_owned_equipment',
        during_course_price_cents: during,
        all_day_price_cents: allDay,
        unit_amount_cents: unit,
        date_count: dateCount,
        service_dates: dates.slice(),
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

/**
 * Multi-Group-course equipment authority.
 *
 * Shared selection must be authorized by EVERY selected Group course. Product
 * charges once per surfer per UNIQUE calendar day. When courses configure
 * different unit amounts for the same offering/mode, fail closed with a specific
 * configuration conflict — never pick the first course's price.
 *
 * Private still uses quoteCourseEquipment with its single Private entity.
 */
function quoteCourseEquipmentForLessonSet({
  courses,
  selection,
  surfers,
  offerings,
  clientSlug,
  locationId,
  serviceDates,
}) {
  const list = Array.isArray(courses) ? courses.filter(Boolean) : [];
  if (!list.length) {
    throw new TypeError('course equipment requires at least one course configuration');
  }
  if (list.length === 1) {
    return quoteCourseEquipment({
      course: list[0],
      selection,
      surfers,
      offerings,
      clientSlug,
      locationId,
      serviceDates,
    });
  }

  const selected = validateEquipmentSelection(selection, surfers);
  if (selected.length === 0) {
    return { total_cents: 0, lines: [], selections: [], course_equipment: [] };
  }

  const dates = uniqueCourseServiceDates(serviceDates);
  if (dates.length < 1) {
    throw new TypeError('course equipment requires unique course service dates');
  }
  const dateCount = dates.length;

  const activeScoped = offerings
    ? activeScopedOfferingMap(offerings, { clientSlug, locationId })
    : null;

  const courseConfigs = list.map((course) => {
    const rawOptions = (course && Array.isArray(course.equipment_options))
      ? course.equipment_options
      : [];
    const configured = new Map();
    for (const raw of rawOptions) {
      let money;
      try {
        money = resolveEquipmentOptionMoney(raw);
      } catch (err) {
        throw new TypeError(`equipment option price invalid: ${err.message || err}`);
      }
      configured.set(money.offering_key, {
        ...money,
        label: raw && raw.label != null ? raw.label : undefined,
      });
    }
    return {
      course_id: (course && (course.course_id || course.pack_id || course.id)) || null,
      configured,
    };
  });

  const lines = [];
  let total_cents = 0;
  const transport = [];

  for (const item of selected) {
    if (activeScoped && !activeScoped.has(item.offering_key)) {
      throw new TypeError('equipment offering is not an active scoped rental');
    }

    const resolved = [];
    for (const cfg of courseConfigs) {
      const option = cfg.configured.get(item.offering_key);
      if (!option) {
        const err = new TypeError(
          `equipment is not configured for every selected course (${item.offering_key})`,
        );
        err.reason = 'course_equipment_not_authorized_for_all_courses';
        throw err;
      }
      const during = option.during_course_price_cents;
      const allDay = option.all_day_price_cents;
      if (!Number.isSafeInteger(during) || during < 0) {
        throw new TypeError('during_course_price_cents invalid');
      }
      if (!Number.isSafeInteger(allDay) || allDay < 0) {
        throw new TypeError('all_day_price_cents invalid');
      }
      resolved.push({
        course_id: cfg.course_id,
        during,
        allDay,
        unit: item.all_day ? allDay : during,
        label: option.label,
      });
    }

    const units = resolved.map((r) => r.unit);
    const unit0 = units[0];
    if (units.some((u) => u !== unit0)) {
      const err = new TypeError(
        'course equipment price conflict across selected courses for the same offering/mode',
      );
      err.reason = 'course_equipment_price_conflict';
      err.detail = {
        offering_key: item.offering_key,
        mode: item.all_day ? 'all_day' : 'during_course',
        units_by_course: resolved.map((r) => ({
          course_id: r.course_id,
          unit_amount_cents: r.unit,
        })),
      };
      throw err;
    }

    const during0 = resolved[0].during;
    const allDay0 = resolved[0].allDay;
    // Equal-unit conflict check already passed; still require equal mode config
    // snapshots so we never invent a blended During/All Day pair.
    if (resolved.some((r) => r.during !== during0 || r.allDay !== allDay0)) {
      const err = new TypeError(
        'course equipment price conflict across selected courses for the same offering/mode',
      );
      err.reason = 'course_equipment_price_conflict';
      throw err;
    }

    const unit = unit0;
    const perDate = checkedMultiply(unit, item.quantity, 'equipment per-date');
    const total = checkedMultiply(perDate, dateCount, 'equipment line');
    total_cents = checkedAdd(total_cents, total, 'equipment total');

    const mode = item.all_day ? 'all_day' : 'during_course';
    const active = activeScoped && activeScoped.get(item.offering_key);
    const label = String(
      (active && (active.label || active.display_name))
      || resolved.find((r) => r.label)?.label
      || item.offering_key,
    );
    const courseIds = resolved.map((r) => r.course_id).filter(Boolean);

    transport.push({ offering_key: item.offering_key, mode, quantity: item.quantity });
    lines.push({
      offering_key: item.offering_key,
      label,
      quantity: item.quantity,
      all_day: item.all_day,
      mode,
      during_course_price_cents: during0,
      all_day_price_cents: allDay0,
      amount_cents: unit,
      unit_amount_cents: unit,
      total_cents: total,
      date_count: dateCount,
      service_dates: dates.slice(),
      course_equipment: true,
      course_equipment_mode: mode,
      billing_unit: 'person_per_course_date',
      price_source: 'course_owned_equipment',
      metadata: {
        offering_key: item.offering_key,
        course_id: courseIds.length === 1 ? courseIds[0] : null,
        course_ids: courseIds,
        course_equipment: true,
        course_equipment_mode: mode,
        price_basis: 'per_person_per_course_date',
        pricing_provenance: 'course_owned_equipment_multi_course',
        during_course_price_cents: during0,
        all_day_price_cents: allDay0,
        unit_amount_cents: unit,
        date_count: dateCount,
        service_dates: dates.slice(),
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
    date_count: line.date_count,
    service_dates: line.service_dates ? line.service_dates.slice() : undefined,
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
  quoteCourseEquipmentForLessonSet,
  invoiceLines,
  validateConfig,
  normalizeSelection,
  validateEquipmentSelection,
  normalizeEquipmentOptions,
  defaultFreeDuringCourseEquipmentSelection,
  resolveEquipmentOptionMoney,
  uniqueCourseServiceDates,
};
