'use strict';

/**
 * Crowsnest Luna Sales — approved CRM sync domain contract (provider-neutral).
 *
 * Pure eligibility + idempotency + command shaping for an explicit operator
 * "send approved CRM sync" action. No HTTP, no HubSpot SDK, no store, no env
 * secret reads, no automatic sync.
 *
 * Idempotency is derived only from prospect id + current CRM-review mark id.
 * Domain / company-name matching is never used as an idempotency substitute.
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 'crowsnest.sales.approved_crm_sync.v1';
const APPROVED_CRM_SYNC_OPERATOR_COMMAND = 'send_approved_crm_sync';
const COMPANY_CORRELATION_PROPERTY = 'crowsnest_sales_prospect_id';
const CRM_LIFECYCLE_STAGE = 'Lead';
const CRM_STATUS_PROPERTY = 'Luna Sales Status';
const CRM_STATUS_VALUE = 'Qualified Prospect';

function trimString(value) {
  return value == null ? '' : String(value).trim();
}

function extractCompanyDomain(websiteUrl) {
  const raw = trimString(websiteUrl);
  if (!raw) return '';
  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const hostname = new URL(withProtocol).hostname || '';
    return hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeCrmContactCandidates(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .map((contact) => {
      if (!contact || typeof contact !== 'object') return null;
      const email = trimString(contact.email);
      const fullName = trimString(
        contact.full_name != null ? contact.full_name : (contact.fullName || contact.name || ''),
      );
      const role = trimString(contact.role || contact.title || '');
      if (!email && !fullName) return null;
      return {
        full_name: fullName,
        email,
        role,
      };
    })
    .filter(Boolean);
}

/**
 * Stable idempotency key from prospect + current CRM-review mark only.
 * Never accepts domain/name as a substitute.
 *
 * @returns {string|{ok:false,error:string}}
 */
function buildApprovedCrmSyncIdempotencyKey(input = {}) {
  const prospectId = trimString(input.prospect_id || input.prospectId);
  const markId = trimString(input.crm_review_mark_id || input.crmReviewMarkId);

  // Domain / name inputs are intentionally ignored — they must never mint a key.
  if (!prospectId || !markId) {
    return {
      ok: false,
      error: 'prospect_id and crm_review_mark_id are required for approved CRM sync idempotency.',
    };
  }

  const material = `${SCHEMA_VERSION}|${prospectId}|${markId}`;
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return `acs_v1_${digest}`;
}

/**
 * Eligibility: qualified + current CRM-review mark + explicit operator command + operator id.
 */
function assessApprovedCrmSyncEligibility(input = {}) {
  const prospect = input.prospect || null;
  const qualification = input.qualification
    || input.latestQualification
    || input.latest_qualification
    || null;
  const mark = input.crm_review_mark
    || input.crmReviewMark
    || input.latest_crm_review_mark
    || null;
  const operatorId = trimString(input.operator_id || input.operatorId || input.actor);
  const operatorCommand = trimString(input.operator_command || input.operatorCommand);

  if (!prospect || !trimString(prospect.id)) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'prospect_required',
      error: 'Prospect is required for approved CRM sync.',
    };
  }
  if (!operatorId) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'operator_required',
      error: 'Operator identity is required for approved CRM sync.',
    };
  }
  if (operatorCommand !== APPROVED_CRM_SYNC_OPERATOR_COMMAND) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'explicit_operator_command_required',
      error: 'Approved CRM sync requires the explicit operator command send_approved_crm_sync.',
    };
  }
  if (!qualification || !trimString(qualification.id)) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'qualification_required',
      error: 'A current qualification assessment is required for approved CRM sync.',
    };
  }
  const decision = trimString(qualification.decision).toLowerCase();
  if (decision !== 'qualified') {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'not_qualified',
      error: 'Approved CRM sync requires the prospect’s latest qualification to be qualified.',
    };
  }
  if (!mark || !trimString(mark.id)) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'crm_review_mark_required',
      error: 'Approved CRM sync requires a current CRM-review-ready mark.',
    };
  }
  const markProspectId = trimString(mark.prospect_id || mark.prospectId);
  if (markProspectId && markProspectId !== trimString(prospect.id)) {
    return {
      ok: false,
      eligible: false,
      status: 400,
      code: 'crm_review_mark_mismatch',
      error: 'CRM-review mark does not belong to this prospect.',
    };
  }

  return {
    ok: true,
    eligible: true,
    prospect_id: trimString(prospect.id),
    qualification_assessment_id: trimString(qualification.id),
    crm_review_mark_id: trimString(mark.id),
    operator_id: operatorId,
    operator_command: APPROVED_CRM_SYNC_OPERATOR_COMMAND,
  };
}

/**
 * Build a provider-neutral approved CRM sync command.
 * One Company + zero-or-more Contacts; Deal always null; automatic always false.
 */
function buildApprovedCrmSyncCommand(input = {}) {
  const eligibility = assessApprovedCrmSyncEligibility(input);
  if (!eligibility.ok) {
    return eligibility;
  }

  const prospect = input.prospect;
  const qualification = input.qualification
    || input.latestQualification
    || input.latest_qualification;
  const mark = input.crm_review_mark
    || input.crmReviewMark
    || input.latest_crm_review_mark;
  const contacts = normalizeCrmContactCandidates(input.contacts);

  const idempotencyKey = buildApprovedCrmSyncIdempotencyKey({
    prospect_id: prospect.id,
    crm_review_mark_id: mark.id,
  });
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    return {
      ok: false,
      status: 400,
      code: 'idempotency_key_invalid',
      error: (idempotencyKey && idempotencyKey.error)
        || 'Unable to derive approved CRM sync idempotency key.',
    };
  }

  const websiteUrl = trimString(prospect.website_url);
  const companyName = trimString(prospect.canonical_name) || websiteUrl || trimString(prospect.id);
  const domain = extractCompanyDomain(websiteUrl);

  return {
    ok: true,
    command: {
      schema_version: SCHEMA_VERSION,
      operator_command: APPROVED_CRM_SYNC_OPERATOR_COMMAND,
      operator_id: eligibility.operator_id,
      idempotency_key: idempotencyKey,
      prospect_id: trimString(prospect.id),
      crm_review_mark_id: trimString(mark.id),
      qualification_assessment_id: trimString(qualification.id),
      automatic: false,
      record_sent: false,
      synced: false,
      company: {
        name: companyName,
        website_url: websiteUrl,
        domain,
        lifecycle_stage: CRM_LIFECYCLE_STAGE,
        properties: {
          [CRM_STATUS_PROPERTY]: CRM_STATUS_VALUE,
        },
        correlation: {
          [COMPANY_CORRELATION_PROPERTY]: trimString(prospect.id),
        },
      },
      contacts,
      deal: null,
      traceability: {
        rationale: trimString(qualification.rationale),
        evidence_ids: Array.isArray(qualification.evidence_ids)
          ? qualification.evidence_ids.map((id) => String(id))
          : [],
        qualification_reviewer_id: trimString(qualification.reviewer_id),
        crm_review_mark_reviewer_id: trimString(mark.reviewer_id),
      },
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  APPROVED_CRM_SYNC_OPERATOR_COMMAND,
  COMPANY_CORRELATION_PROPERTY,
  CRM_LIFECYCLE_STAGE,
  CRM_STATUS_PROPERTY,
  CRM_STATUS_VALUE,
  assessApprovedCrmSyncEligibility,
  buildApprovedCrmSyncIdempotencyKey,
  buildApprovedCrmSyncCommand,
  extractCompanyDomain,
  normalizeCrmContactCandidates,
};
