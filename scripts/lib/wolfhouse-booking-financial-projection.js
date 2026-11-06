'use strict';

const { wolfhouseBookingDepositCents } = require('./wolfhouse-stay-deposit');
const { bookingDepositCollectionFacts } = require('./booking-deposit-payment-link');
const { bookingLedgerInvoicePaidBalance } = require('./booking-invoice-totals');

// Inputs are server-loaded, admitted booking facts, never request money. Receipt
// scopes are intentionally distinct. No receipt reader or payment write lives here.
function wolfhouseBookingFinancialProjection({ booking, rates, currency = null,
  depositRatesProvenance = 'unknown:rates_provenance_not_supplied',
  serviceDueCents, additionalServiceCents, transferDueCents, displayPaidCents,
  serviceRecordsAvailable, transfersAvailable,
  invoiceInputsAvailable = true, collectionRows = null, collectionIdentityEstablished = false }) {
  // Operational owner sums, NOT allocations of the historical accepted invoice.
  // Only explicit successful loading plus valid integer cents establishes a fact.
  const serviceTotal = serviceRecordsAvailable === true && Number.isSafeInteger(serviceDueCents) && serviceDueCents >= 0
    ? serviceDueCents : null;
  const transferTotal = transfersAvailable === true && Number.isSafeInteger(transferDueCents) && transferDueCents >= 0
    ? transferDueCents : null;
  const ledger = bookingLedgerInvoicePaidBalance(booking, serviceDueCents,
    displayPaidCents, transferDueCents, additionalServiceCents);
  const invoice = invoiceInputsAvailable ? ledger.invoice_total_cents : null;
  const paid = displayPaidCents == null ? null : ledger.paid_total_cents;
  const deposit = wolfhouseBookingDepositCents(booking, rates);
  const collection = bookingDepositCollectionFacts(deposit, invoice,
    collectionIdentityEstablished === true ? collectionRows : null);
  const collectionSource = collectionIdentityEstablished === true && collectionRows != null
    ? 'collection_owner:identity_attested_complete_receipt_set'
    : 'unknown:collection_receipt_identity_unattested';
  const collectionSources = Object.fromEntries(Object.keys(collection).map(key => [key,
    key === 'deposit_display_cents'
      ? (collection[key] == null ? 'unknown' : 'collection_owner:invoice_cap_before_receipts')
      : (collection[key] == null && collectionSource[0] !== 'u' ? 'unknown:required_owner_input' : collectionSource)]));
  return {
    schema_version: 1, currency,
    service_total_cents: serviceTotal, transfer_total_cents: transferTotal,
    invoice_total_cents: invoice, paid_total_cents: paid,
    balance_due_cents: invoice == null || paid == null ? null : ledger.balance_due_cents,
    deposit_required_cents: deposit,
    ...collection,
    needs_refund: invoice == null || paid == null ? null : ledger.needs_refund,
    value_sources: {
      service_total_cents: serviceTotal == null ? 'unknown:service_owner_input_unavailable_or_invalid' : 'service_owner:operational_section_sum_not_historical_allocation',
      transfer_total_cents: transferTotal == null ? 'unknown:transfer_owner_input_unavailable_or_invalid' : 'transfer_owner:operational_section_sum_not_historical_allocation',
      currency: currency == null ? 'unknown' : 'authoritative_booking_or_config',
      invoice_total_cents: invoice == null ? 'unknown' : 'booking_invoice_owner:persisted_booking_snapshot_and_later_charges',
      paid_total_cents: paid == null ? 'unknown' : 'display_eligible_receipt_ledger',
      balance_due_cents: invoice == null || paid == null ? 'unknown' : 'booking_invoice_owner:display_eligible_receipts',
      deposit_required_cents: deposit == null ? 'unknown' : 'stay_deposit_owner:stored_history_or_package_policy_with_persisted_person_caps',
      deposit_rates: depositRatesProvenance,
      ...collectionSources,
      needs_refund: invoice == null || paid == null ? 'unknown' : 'booking_invoice_owner:display_accounting_fact_not_refund_authorization',
    },
  };
}
module.exports = { wolfhouseBookingFinancialProjection };
