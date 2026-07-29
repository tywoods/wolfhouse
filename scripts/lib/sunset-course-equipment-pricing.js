'use strict';

const { normalizeEquipmentOptions, validateEquipmentSelection } = require('./sunset-course-equipment-options');
function checkedAdd(a, b, name = 'money total') { if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) throw new RangeError(`${name} overflow`); return a + b; }
function checkedMultiply(a, b, name = 'money total') { if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a * b)) throw new RangeError(`${name} overflow`); return a * b; }
function quoteCourseEquipment({ course, selection, surfers }) {
  const selected = validateEquipmentSelection(selection, surfers);
  const configured = new Map(((course && Array.isArray(course.equipment_options)) ? course.equipment_options : []).map((x) => [String(x.offering_key || '').trim(), x]));
  const lines = [];
  let total_cents = 0;
  for (const item of selected) {
    const option = configured.get(item.offering_key);
    if (!option) throw new TypeError('equipment is not configured for selected course');
    const unit = checkedAdd(option.equipment_price_cents, item.all_day ? option.all_day_surcharge_cents : 0, 'equipment unit');
    const total = checkedMultiply(unit, item.quantity, 'equipment line');
    total_cents = checkedAdd(total_cents, total, 'equipment total');
    lines.push({ offering_key: item.offering_key, label: option.label || item.offering_key, quantity: item.quantity, all_day: item.all_day, base_amount_cents: option.equipment_price_cents, all_day_surcharge_cents: option.all_day_surcharge_cents, amount_cents: unit, total_cents: total, metadata: { offering_key: item.offering_key, course_id: course.course_id || course.pack_id || null, course_equipment: true, course_equipment_mode: item.all_day ? 'all_day' : 'during_course', price_basis: 'per_person_per_course', pricing_provenance: 'course_owned_equipment' } });
  }
  return { total_cents, lines, selections: selected };
}
function invoiceLines(quote) { return ((quote && quote.lines) || []).map((line) => ({ description: `${line.label} — ${line.all_day ? 'All Day' : 'During Course'}`, quantity: line.quantity, unit_amount_cents: line.amount_cents, total_cents: line.total_cents, offering_key: line.offering_key })); }
module.exports = { checkedAdd, checkedMultiply, quoteCourseEquipment, invoiceLines };
