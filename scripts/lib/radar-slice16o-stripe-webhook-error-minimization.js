'use strict';

/**
 * radar-slice16o-stripe-webhook-error-minimization — RADAR Slice 16O locks.
 *
 * Source-partial progress only: minimize public Stripe webhook error responses
 * for all pre-verification failures (raw-body read, missing webhook secret,
 * SDK load, signature verification). No live deploy. Deployment and privacy
 * drill remain open.
 */

const path = require('path');

const MASTER_BASIS = '3e94498321cd26e64394984a5926d7a583226692';
const SLICE = 'RADAR-16O';
const OUTCOME_ID = '16O_stripe_webhook_error_minimization';
const GATE_ID = 'G08_retention_privacy';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16o-stripe-webhook-error-minimization';

const STAFF_API_REL = 'scripts/staff-query-api.js';
const PUBLIC_ERRORS_LIB_REL = 'scripts/lib/stripe-webhook-public-errors.js';

const OWNED_RELS = Object.freeze([
  PUBLIC_ERRORS_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16o-stripe-webhook-error-minimization.js',
  'scripts/verify-radar-slice16o-stripe-webhook-error-minimization.js',
  'fixtures/radar-operations/slice16o-expected-contract.json',
]);

const MUST_NOT_OWN = Object.freeze([
  'live_deploy',
  'privacy_drill_execution',
  'migration',
  'stripe_webhook_skip_verify_true',
  'tenant_binding_change',
  'event_claim_txn_change',
  'ignored_unmatched_behavior_change',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  STAFF_API_REL,
  PUBLIC_ERRORS_LIB_REL,
  OWNED_RELS,
  MUST_NOT_OWN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
