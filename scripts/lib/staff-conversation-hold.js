'use strict';

/**
 * One hold state for guest automation.
 * Hold = bot_pause_states. needs_human is the Inbox flag.
 * Payment-link failures must not hold (keep talking + retry).
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function isPaymentLinkFailureReason(reason) {
  const r = trimStr(reason).toLowerCase();
  if (!r) return false;
  if (/payment[_-]?link/.test(r)) return true;
  if (/create_payment_link/.test(r)) return true;
  if (/balance_payment_link/.test(r)) return true;
  if (/stripe.*checkout|checkout.*session/.test(r) && /fail|error|unavail/.test(r)) return true;
  return false;
}

function shouldPauseForHandoffReason(reason) {
  if (isPaymentLinkFailureReason(reason)) return false;
  return true;
}

module.exports = {
  isPaymentLinkFailureReason,
  shouldPauseForHandoffReason,
};
