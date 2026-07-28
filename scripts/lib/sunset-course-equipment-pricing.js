'use strict';

const MODES = Object.freeze(['during_course', 'all_day']);
const COMPONENTS = Object.freeze(['surfboard', 'wetsuit']);
const DEFAULT_CONFIG = Object.freeze({
  during_course: Object.freeze({ policy: 'free_with_course', surfboard_cents: 0, wetsuit_cents: 0 }),
  all_day: Object.freeze({ surfboard_cents: 0, wetsuit_cents: 0 }),
});

function cloneDefault() {
  return { during_course: { ...DEFAULT_CONFIG.during_course }, all_day: { ...DEFAULT_CONFIG.all_day } };
}
function strictObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`unknown ${name} field: ${key}`);
}
function cents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}
/** Strict write validator. Free policy canonicalizes both during-course prices to zero. */
function validateConfig(value) {
  strictObject(value, ['during_course', 'all_day'], 'course_equipment_pricing');
  strictObject(value.during_course, ['policy', 'surfboard_cents', 'wetsuit_cents'], 'during_course');
  strictObject(value.all_day, ['surfboard_cents', 'wetsuit_cents'], 'all_day');
  const policy = value.during_course.policy;
  if (policy !== 'free_with_course' && policy !== 'extra') throw new TypeError('during_course.policy must be free_with_course or extra');
  const out = cloneDefault();
  out.during_course.policy = policy;
  out.during_course.surfboard_cents = policy === 'extra' ? cents(value.during_course.surfboard_cents, 'during_course.surfboard_cents') : 0;
  out.during_course.wetsuit_cents = policy === 'extra' ? cents(value.during_course.wetsuit_cents, 'during_course.wetsuit_cents') : 0;
  out.all_day.surfboard_cents = cents(value.all_day.surfboard_cents, 'all_day.surfboard_cents');
  out.all_day.wetsuit_cents = cents(value.all_day.wetsuit_cents, 'all_day.wetsuit_cents');
  return out;
}
/** Read boundary is fail-safe: absent/malformed legacy config sells nothing and never invents money. */
function normalizeConfig(value) {
  try { return validateConfig(value); } catch (_) { return cloneDefault(); }
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
function quoteCourseEquipment({ config, selection, surfers, booking_dates: dates }) {
  const selected = normalizeSelection(selection, surfers);
  if (!selected) return { total_cents: 0, unit_cents: 0, lines: [], inventory: [] };
  const cfg = normalizeConfig(config);
  const bookingDates = normalizeDates(dates);
  const prices = selected.mode === 'during_course' ? cfg.during_course : cfg.all_day;
  const unit = cents(prices.surfboard_cents, 'surfboard_cents') + cents(prices.wetsuit_cents, 'wetsuit_cents');
  const lines = [];
  const inventory = [];
  for (const service_date of bookingDates) {
    for (const component of COMPONENTS) {
      const amount_cents = prices[`${component}_cents`];
      lines.push({ component, service_date, quantity: selected.quantity, amount_cents,
        total_cents: amount_cents * selected.quantity,
        metadata: { component, course_equipment_mode: selected.mode, price_basis: 'per_person_per_booking_day' } });
      inventory.push({ component, service_date, quantity: selected.quantity, source: 'course_equipment' });
    }
  }
  return { mode: selected.mode, quantity: selected.quantity, booking_dates: bookingDates,
    unit_cents: unit, total_cents: unit * selected.quantity * bookingDates.length, lines, inventory };
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
module.exports = { MODES, COMPONENTS, DEFAULT_CONFIG, validateConfig, normalizeConfig, normalizeSelection, clampSelection, quoteCourseEquipment, dedupeInventory, invoiceLines };
