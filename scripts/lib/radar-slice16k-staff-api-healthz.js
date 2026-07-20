'use strict';

/**
 * radar-slice16k-staff-api-healthz — RADAR Slice 16K locks.
 *
 * Source-partial progress only: minimize public Staff API /healthz for
 * privacy / operational safety. No live deploy. Deployment, log-retention
 * proof, and privacy drill remain open.
 */

const path = require('path');

const MASTER_BASIS = '0d7340865d34804562c0e955a6276cfeff90560d';
const SLICE = 'RADAR-16K';
const OUTCOME_ID = '16K_staff_api_healthz_minimization';
const GATE_ID = 'G08_retention_privacy';
const PROGRESS_CLASS = 'source_partial_progress_only';
const BRANCH = 'radar/slice-16k-healthz-minimization';

const HEALTHZ_SCHEMA = Object.freeze({
  status: 'ok',
  service: 'staff-api',
});

const AUTHENTICATED_DIAGNOSTICS = Object.freeze([
  'GET /staff/ask-luna/ai-status',
]);

const STAFF_API_REL = 'scripts/staff-query-api.js';
const HEALTHZ_LIB_REL = 'scripts/lib/staff-api-healthz.js';

const OWNED_RELS = Object.freeze([
  HEALTHZ_LIB_REL,
  STAFF_API_REL,
  'scripts/lib/radar-slice16k-staff-api-healthz.js',
  'scripts/verify-radar-slice16k-staff-api-healthz.js',
  'fixtures/radar-operations/slice16k-expected-contract.json',
]);

const MUST_NOT_OWN = Object.freeze([
  'readyz_behavior_change',
  'authenticated_diagnostics_change',
  'live_deploy',
  'log_retention_policy_freeze',
  'privacy_drill_execution',
  'db_dependency_on_healthz',
]);

module.exports = {
  MASTER_BASIS,
  SLICE,
  OUTCOME_ID,
  GATE_ID,
  PROGRESS_CLASS,
  BRANCH,
  HEALTHZ_SCHEMA,
  AUTHENTICATED_DIAGNOSTICS,
  STAFF_API_REL,
  HEALTHZ_LIB_REL,
  OWNED_RELS,
  MUST_NOT_OWN,
  rootJoin(...parts) {
    return path.join(__dirname, '..', '..', ...parts);
  },
};
