'use strict';
// Offline query fixture; executes the actual Finance adapter and summary, no DB/network.
const assert = require('assert');
const { fetchLodgingFinanceData } = require('./lib/sunset-finance-data');
const { computeSunsetFinanceSummary } = require('./lib/sunset-finance-summary');
const base = { service_record_id: 'booking-a', booking_id: 'booking-a', service_date: '2026-10-10',
  service_type: 'accommodation', quantity: 1, amount_due_cents: 11000, source: 'staff',
  metadata: { quote_snapshot: { total_cents: 11000, line_items: [
    { code: 'accommodation_only', total_cents: 10000 }, { code: 'yoga_class', total_cents: 1000 } ] } } };
const service = (id, code, amount, inclusion) => ({ service_record_id: id, booking_id: 'booking-a',
  client_slug: 'wolfhouse-somo', amount_due_cents: amount, status: 'confirmed',
  payment_status: 'pending', source: 'staff_manual', metadata: {
    source_quote_line_code: code, ...(inclusion ? { invoice_total_inclusion: inclusion } : {}) } });
async function run(services, projection = base) {
  const queries = [];
  const pg = { async query(sql, params) {
    queries.push({ sql, params });
    if (/FROM booking_service_records bsr/.test(sql)) {
      assert.deepStrictEqual(params, ['wolfhouse-somo']);
      assert.match(sql, /JOIN bookings b ON b.id = bsr.booking_id/);
      assert.match(sql, /bsr.client_slug = c.slug/);
      assert.match(sql, /c.slug = \$1/);
      assert.match(sql, /b.status::text NOT IN/);
      assert.match(sql, /staff_calendar_block/);
      assert.match(sql, /private_room_companion/);
      assert.match(sql, /external_calendar/);
      assert.match(sql, /b.check_in IS NOT NULL OR b.created_at IS NOT NULL/);
      assert.doesNotMatch(sql, /amount_paid_cents|paid_at/);
      return { rows: services };
    }
    if (/AS service_record_id/.test(sql)) return { rows: [projection] };
    if (/b.total_amount_cents/.test(sql)) return { rows: [{ booking_id: 'booking-a', total_amount_cents: 11000 }] };
    if (/FROM payments p/.test(sql)) return { rows: [{ payment_id: 'receipt', booking_id: 'booking-a', amount_paid_cents: 200, paid_at: '2026-10-14T12:00:00Z' }] };
    return { rows: [] };
  } };
  const data = await fetchLodgingFinanceData(pg, { clientSlug: 'wolfhouse-somo' });
  const result = computeSunsetFinanceSummary({ ...data, now: new Date('2026-10-14T12:00:00Z'),
    productMode: 'lodging_packages', view: { granularity: 'month', anchor: '2026-10-14' } });
  return { result, queries, data, rows: result.redesign.revenue_by_product };
}
const cents = (out, key) => out.rows.find(row => row.key === key).cents;
(async () => {
  const embedded = service('embedded', 'yoga_class', '1000');
  const additional = service('later', 'yoga_class', '500', 'additional');
  const first = await run([embedded, additional]);
  assert.strictEqual(cents(first, 'services'), 1500, 'later saved commercial service is additional even with the same quote code');
  assert.strictEqual(cents(first, 'accommodation'), 10000);
  assert.strictEqual(cents(first, 'camps'), 0);
  assert.ok(first.queries.some(q => /FROM booking_service_records bsr/.test(q.sql)), 'actual adapter must read attached records');
  const original = await run([]);
  const laterStaff = { ...additional, status: 'requested', payment_status: 'not_requested',
    metadata: { pricing_addon_code: 'yoga_class', invoice_total_inclusion: 'additional',
      staff_portal: true, schedule_mode: 'single', unit_cents: 500 } };
  assert.deepStrictEqual((await run([embedded, laterStaff])).rows, first.rows,
    'later Staff producer persists pricing_addon_code and a positive not_requested amount');
  const comboZero = service('combo-zero', 'wetsuit_soft_top_combo', 0);
  comboZero.payment_status = 'not_requested'; comboZero.metadata.combo_part = 'wetsuit';
  const comboBoard = service('combo-board', 'wetsuit_soft_top_combo', 300);
  comboBoard.metadata.combo_part = 'surfboard';
  const comboBase = { ...base, amount_due_cents: 11300, metadata: { quote_snapshot: {
    total_cents: 11300, line_items: [...base.metadata.quote_snapshot.line_items,
      { code: 'wetsuit_soft_top_combo', total_cents: 300 }] } } };
  const combo = await run([embedded, comboZero, comboBoard], comboBase);
  assert.strictEqual(cents(combo, 'services'), 1300, 'saved combo charged once, zero gear component is not a new sale');
  assert.deepStrictEqual(first.result.redesign.net, original.result.redesign.net, 'Net collected is untouched');
  assert.deepStrictEqual((await run([embedded, additional, additional])).rows, first.rows, 'stable record identity deduplicates');
  const unrelated = { ...additional, service_record_id: 'foreign', booking_id: 'booking-other' };
  const tenant = { ...additional, service_record_id: 'tenant', client_slug: 'other' };
  assert.deepStrictEqual((await run([embedded, additional, unrelated, tenant])).rows, first.rows);
  for (const amount of [true, null, '1.2', '01']) {
    const bad = await run([service('bad', 'yoga_class', amount, 'additional')]);
    assert.strictEqual(bad.rows.find(r => r.key === 'services').status, 'partial');
    assert.strictEqual(cents(bad, 'camps'), null, 'malformed row cannot establish category absence');
  }
  const pending = service('pending', 'yoga_class', 0, 'additional');
  pending.payment_status = 'not_requested';
  pending.metadata.pending_origin = 'luna_guest_pending_service';
  assert.strictEqual((await run([pending])).rows.find(r => r.key === 'services').status, 'partial');
  const conflict = await run([additional, { ...additional, amount_due_cents: 501 }]);
  assert.strictEqual(conflict.rows.find(r => r.key === 'services').status, 'partial');
  const noSnapshot = { ...base, metadata: {} };
  const partial = await run([embedded, additional], noSnapshot);
  assert.strictEqual(cents(partial, 'services'), 1500);
  assert.strictEqual(cents(partial, 'unclassified'), 10000, 'embedded services deducted once from unsplit base');
  assert.strictEqual(cents(partial, 'camps'), null);
  const mismatch = await run([service('mismatch', 'yoga_class', 999)]);
  assert.strictEqual(mismatch.rows.find(r => r.key === 'services').status, 'partial');
  const signed = service('signed', 'saved_adjustment', 0, 'additional');
  signed.metadata.staff_custom_line = true; signed.metadata.amount_cents = -100;
  const adjustment = await run([signed]);
  assert.strictEqual(cents(adjustment, 'unclassified'), -100);
  assert.strictEqual(cents(adjustment, 'camps'), null);
  const outside = { ...base, service_date: '2026-11-10' };
  assert.ok((await run([additional], outside)).rows.every(r => r.cents === null), 'service date/payment date cannot shift booked cohort');
  // Existing sanitized source warnings are retained, not cleared by categorization.
  const malformedBase = await run([], { ...base, amount_due_cents: true });
  assert.ok(malformedBase.data.data_quality.malformed_count > 0);
  console.log('PASS verify-finance-attached-services (offline adapter + summary)');
})().catch(err => { console.error(err); process.exitCode = 1; });
