'use strict';

const MODES = Object.freeze(['during_course', 'all_day']);
const COMPONENTS = Object.freeze(['surfboard', 'wetsuit']);
const DEFAULT_CONFIG = Object.freeze({
  all_day: Object.freeze({ enabled: false, surfboard_cents: 0, wetsuit_cents: 0 }),
});

function cloneDefault() {
  return { all_day: { ...DEFAULT_CONFIG.all_day } };
}
function strictObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`unknown ${name} field: ${key}`);
}
function cents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}
function checkedAdd(a, b, name = 'money total') {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) throw new RangeError(`${name} overflow`);
  return a + b;
}
function checkedMultiply(a, b, name = 'money total') {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a * b)) throw new RangeError(`${name} overflow`);
  return a * b;
}
/** Strict write validator. Free policy canonicalizes both during-course prices to zero. */
function validateConfig(value) {
  strictObject(value, ['all_day'], 'course_equipment_pricing');
  strictObject(value.all_day, ['enabled', 'surfboard_cents', 'wetsuit_cents'], 'all_day');
  const out = cloneDefault();
  if (typeof value.all_day.enabled !== 'boolean') throw new TypeError('all_day.enabled must be boolean');
  out.all_day.enabled = value.all_day.enabled;
  out.all_day.surfboard_cents = cents(value.all_day.surfboard_cents, 'all_day.surfboard_cents');
  out.all_day.wetsuit_cents = cents(value.all_day.wetsuit_cents, 'all_day.wetsuit_cents');
  return out;
}
/** Read boundary is fail-safe: absent/malformed legacy config sells nothing and never invents money. */
function normalizeConfig(value) {
  try { return validateConfig(value); } catch (_) {
    try {
      if (value && value.all_day) return validateConfig({ all_day: { enabled: true, surfboard_cents: value.all_day.surfboard_cents, wetsuit_cents: value.all_day.wetsuit_cents } });
    } catch (_) {}
    return cloneDefault();
  }
}
function normalizeDates(dates) {
  if (!Array.isArray(dates)) throw new TypeError('booking_dates must be an array');
  const out = [...new Set(dates.map(String))];
  if (!out.length || out.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new TypeError('booking_dates must contain YYYY-MM-DD dates');
  return out;
}
function normalizeSelection(selection, surfers) {
  if (selection == null) return null;
  strictObject(selection, ['mode', 'quantity'], 'course_equipment');
  if (!MODES.includes(selection.mode)) throw new TypeError('invalid course equipment mode');
  if (!Number.isInteger(surfers) || surfers < 1) throw new TypeError('surfers must be a positive integer');
  if (!Number.isInteger(selection.quantity) || selection.quantity < 1 || selection.quantity > surfers) throw new TypeError('course equipment quantity must be between 1 and surfers');
  return { mode: selection.mode, quantity: selection.quantity };
}
function clampSelection(selection, surfers) {
  if (!selection || !Number.isInteger(surfers) || surfers < 1) return null;
  if (!MODES.includes(selection.mode)) return null;
  return { mode: selection.mode, quantity: Math.max(1, Math.min(surfers, Number.isInteger(selection.quantity) ? selection.quantity : surfers)) };
}
/** Server-authoritative quote and persistence lines; browser submits mode+quantity only. */
function quoteCourseEquipment({ config, course, selection, surfers, booking_dates: dates }) {
  const selected = normalizeSelection(selection, surfers);
  if (!selected) return { total_cents: 0, unit_cents: 0, lines: [], inventory: [] };
  const cfg = normalizeConfig(config);
  const bookingDates = normalizeDates(dates);
  let prices;
  if (selected.mode === 'during_course') {
    if (!course || course.equipment_included !== true) throw new TypeError('course equipment not included');
    prices = { surfboard_cents: cents(Number(course.equipment_price_cents || 0), 'equipment_price_cents'), wetsuit_cents: 0 };
  } else {
    if (cfg.all_day.enabled !== true) throw new TypeError('all-day equipment disabled');
    prices = cfg.all_day;
  }
  const unit = checkedAdd(cents(prices.surfboard_cents, 'surfboard_cents'), cents(prices.wetsuit_cents, 'wetsuit_cents'), 'course equipment unit');
  const lines = [];
  const inventory = [];
  for (const service_date of bookingDates) {
    for (const component of COMPONENTS) {
      const amount_cents = prices[`${component}_cents`];
      lines.push({ component, service_date, quantity: selected.quantity, amount_cents,
        total_cents: checkedMultiply(amount_cents, selected.quantity, 'course equipment line'),
        metadata: { component, course_equipment_mode: selected.mode, price_basis: 'per_person_per_booking_day' } });
      inventory.push({ component, service_date, quantity: selected.quantity, source: 'course_equipment' });
    }
  }
  return { mode: selected.mode, quantity: selected.quantity, booking_dates: bookingDates,
    unit_cents: unit,
    total_cents: checkedMultiply(checkedMultiply(unit, selected.quantity, 'course equipment quantity'), bookingDates.length, 'course equipment booking'),
    lines, inventory };
}
/** Physical demand is deduped by component/date using max, never additive double inventory. */
function dedupeInventory(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row || !COMPONENTS.includes(row.component) || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.service_date))) continue;
    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) continue;
    const key = `${row.component}|${row.service_date}`;
    const prior = map.get(key);
    if (!prior || quantity > prior.quantity) map.set(key, { component: row.component, service_date: String(row.service_date), quantity });
  }
  return [...map.values()].sort((a, b) => `${a.service_date}|${a.component}`.localeCompare(`${b.service_date}|${b.component}`));
}
function invoiceLines(quote) {
  return (quote && quote.lines || []).map((line) => ({
    description: `${line.component === 'surfboard' ? 'Surfboard' : 'Wetsuit'} — ${quote.mode === 'all_day' ? 'All Day' : 'During Course'} — ${line.service_date}`,
    quantity: line.quantity, unit_amount_cents: line.amount_cents, total_cents: line.total_cents,
  }));
}
module.exports = { MODES, COMPONENTS, DEFAULT_CONFIG, validateConfig, normalizeConfig, normalizeSelection, clampSelection, checkedAdd, checkedMultiply, quoteCourseEquipment, dedupeInventory, invoiceLines };
