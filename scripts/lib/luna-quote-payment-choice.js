'use strict';

/**
 * Whether a quote has balance remaining after the deposit tier (deposit vs full choice).
 */

function quoteHasRemainingBalanceAfterDeposit(quote) {
  if (!quote || typeof quote !== 'object') return false;
  const total = Number(
    quote.total_cents != null ? quote.total_cents : quote.quote_total_cents,
  );
  const deposit = Number(
    quote.deposit_required_cents != null
      ? quote.deposit_required_cents
      : (quote.deposit_options && quote.deposit_options.deposit_required_cents),
  );
  if (!Number.isFinite(total) || total <= 0) return false;
  if (!Number.isFinite(deposit) || deposit <= 0) return false;
  return deposit < total;
}

function quoteNeedsPaymentChoice(quote) {
  if (!quote || typeof quote !== 'object') return false;
  if (quote.quote_status && quote.quote_status !== 'ready') return false;
  return quoteHasRemainingBalanceAfterDeposit(quote);
}

module.exports = {
  quoteHasRemainingBalanceAfterDeposit,
  quoteNeedsPaymentChoice,
};
