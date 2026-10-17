'use strict';

const { computeWolfhouseCreatorFinance, pageWolfhouseCreatorFinance } = require('./sunset-finance-summary');

const FIXED_NOW = '2026-10-17T12:00:00.000Z';
const BASE_REQUEST = {
  method: 'GET',
  path: '/staff/admin/finance/summary',
  query: { client: 'wolfhouse-somo', granularity: 'month', anchor: '2026-10-17' },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function producerInput(overrides = {}) {
  return {
    bookings: [
      { booking_id: 'b-luna', created_at: '2026-10-01T22:30:00Z', check_in: '2026-10-10', check_out: '2026-10-17', total_amount_cents: 10000, metadata: { bot_source: 'luna_whatsapp' }, status: 'confirmed', currency: 'EUR' },
      { booking_id: 'b-staff', created_at: '2026-10-03T09:00:00Z', check_in: '2026-10-20', check_out: '2026-10-22', total_amount_cents: 20000, metadata: { created_by_staff: true }, status: 'confirmed', currency: 'EUR' },
    ],
    payments: [
      { payment_id: 'p1', booking_id: 'b-luna', amount_paid_cents: 3000, paid_at: '2026-10-02T00:30:00Z', payment_kind: 'full_amount', metadata: { paid_amount_type: 'deposit' }, currency: 'EUR', booking_metadata: { bot_source: 'luna_whatsapp' } },
      { payment_id: 'p2', booking_id: 'b-staff', amount_paid_cents: 5000, paid_at: '2026-10-03T10:00:00Z', payment_kind: 'balance', metadata: {}, currency: 'EUR', booking_metadata: { created_by_staff: true } },
      { payment_id: 'p3', booking_id: 'b-luna', amount_paid_cents: 7000, paid_at: '2026-10-04T10:00:00Z', payment_kind: 'balance', metadata: {}, currency: 'EUR', booking_metadata: { bot_source: 'luna_whatsapp' } },
    ],
    bsr: [
      { service_record_id: 'service-1', booking_id: 'b-luna', service_date: '2026-10-10', service_type: 'accommodation', quantity: 1, amount_due_cents: 10000, metadata: { package_code: 'stay', package_name: 'Stay' } },
      { service_record_id: 'service-2', booking_id: 'b-staff', service_date: '2026-10-20', service_type: 'accommodation', quantity: 1, amount_due_cents: 20000, metadata: { package_code: 'stay', package_name: 'Stay' } },
    ],
    refund_records: [
      { refund_id: 'r1', booking_id: 'b-luna', amount_cents: 500, effective_date: '2026-10-06', currency: 'EUR', booking_metadata: { bot_source: 'luna_whatsapp' } },
    ],
    data_quality: { malformed: [] },
    refund_ledger_unavailable: false,
    ...clone(overrides),
  };
}

function project(input) {
  return computeWolfhouseCreatorFinance({
    ...clone(input),
    now: new Date(FIXED_NOW),
    view: { granularity: 'month', anchor: '2026-10-17' },
    clientSlug: 'wolfhouse-somo',
    locationId: '',
  });
}

function summaryFixture(label, input) {
  return {
    label,
    input: clone(input),
    request: clone(BASE_REQUEST),
    response: {
      status: 200,
      body: {
        success: true,
        client: 'wolfhouse-somo',
        location_id: '',
        wolfhouse_creator_finance: clone(project(input)),
      },
    },
  };
}

function buildWolfhouseFinanceCreatorFixtures() {
  const successInput = producerInput({ data_quality: { malformed: [{ source: 'payment.amount_paid_cents', reason: 'malformed_money', payment_id: 'p-bad' }] } });
  const emptyInput = producerInput({ bookings: [], payments: [], bsr: [], refund_records: [] });
  const partialInput = producerInput({
    payments: [
      ...successInput.payments,
      { payment_id: 'p-usd', booking_id: 'b-staff', amount_paid_cents: 900, paid_at: '2026-10-05T10:00:00Z', payment_kind: 'deposit', metadata: {}, currency: 'USD', booking_metadata: { created_by_staff: true } },
    ],
  });
  const unavailableInput = producerInput({ refund_ledger_unavailable: true });
  const multiInput = producerInput();
  const multiProjection = project(multiInput);
  const detailQuery = { kind: 'payments', currency: 'EUR', cohort_id: multiProjection.cohort_id, limit: 2 };
  const page1 = pageWolfhouseCreatorFinance(multiProjection, detailQuery);
  const page2Query = { ...detailQuery, cursor: page1.detail.page.next_cursor };
  const page2 = pageWolfhouseCreatorFinance(multiProjection, page2Query);

  const successFixture = summaryFixture('synthetic complete success', successInput);
  const successProjection = project(successInput);
  successFixture.detail_examples = Object.fromEntries(
    ['payments', 'bookings', 'outstanding', 'refunds', 'products', 'warnings', 'arrival'].map(kind => [kind, {
      request: { kind, currency: 'EUR', cohort_id: successProjection.cohort_id, limit: 100 },
      response: { status: 200, body: { success: true, wolfhouse_creator_finance: clone(pageWolfhouseCreatorFinance(successProjection, { kind, currency: 'EUR', cohort_id: successProjection.cohort_id, limit: 100 })) } },
    }]),
  );

  return {
    'success.json': successFixture,
    'complete-empty.json': summaryFixture('synthetic complete empty cohort', emptyInput),
    'partial.json': summaryFixture('synthetic partial currency coverage', partialInput),
    'unavailable-refunds.json': summaryFixture('synthetic unavailable refund ledger', unavailableInput),
    'multi-page.json': {
      label: 'synthetic multiple contributor pages',
      input: clone(multiInput),
      request: clone(BASE_REQUEST),
      response: {
        status: 200,
        body: {
          success: true,
          client: 'wolfhouse-somo',
          location_id: '',
          wolfhouse_creator_finance: clone(multiProjection),
        },
      },
      detail_pages: [
        { request: clone(detailQuery), response: { status: 200, body: { success: true, wolfhouse_creator_finance: clone(page1) } } },
        { request: clone(page2Query), response: { status: 200, body: { success: true, wolfhouse_creator_finance: clone(page2) } } },
      ],
    },
  };
}

module.exports = { buildWolfhouseFinanceCreatorFixtures };
