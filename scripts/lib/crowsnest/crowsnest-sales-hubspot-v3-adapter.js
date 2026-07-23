'use strict';

/**
 * Isolated HubSpot CRM v3 adapter for approved Luna Sales CRM sync.
 *
 * Translates a provider-neutral approved CRM sync command into HubSpot v3
 * Company + optional Contact creates. Uses an injected fetch transport only —
 * never reads process.env, never falls back to global fetch, never creates
 * Deals, never claims automatic sync.
 *
 * Timeouts use AbortController. Errors and results are sanitized: never return
 * or echo access tokens or raw provider payloads.
 */

const {
  APPROVED_CRM_SYNC_OPERATOR_COMMAND,
  COMPANY_CORRELATION_PROPERTY,
} = require('./crowsnest-sales-approved-crm-sync-contract');

const HUBSPOT_API_BASE = 'https://api.hubapi.com';
const DEFAULT_TIMEOUT_MS = 10000;
const PROVIDER_NAME = 'hubspot';

/** Safe error categories exposed to callers — never raw HubSpot bodies. */
const ERROR_CATEGORIES = Object.freeze({
  transport_required: 'transport_required',
  invalid_command: 'invalid_command',
  automatic_forbidden: 'automatic_forbidden',
  deal_forbidden: 'deal_forbidden',
  auth_failed: 'auth_failed',
  rate_limited: 'rate_limited',
  timeout: 'timeout',
  provider_rejected: 'provider_rejected',
  transport_failed: 'transport_failed',
});

function trimString(value) {
  return value == null ? '' : String(value).trim();
}

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Sanitize adapter failures. Strips tokens and raw provider text.
 */
function sanitizeHubSpotAdapterError(err, context = {}) {
  const status = Number(context.status) || null;
  const name = err && err.name ? String(err.name) : '';
  const message = err && err.message ? String(err.message) : '';

  let code = ERROR_CATEGORIES.transport_failed;
  let error = 'HubSpot approved CRM sync failed.';

  if (name === 'AbortError' || /abort|timeout/i.test(message) || context.timedOut === true) {
    code = ERROR_CATEGORIES.timeout;
    error = 'HubSpot approved CRM sync timed out.';
  } else if (status === 401 || status === 403 || context.code === ERROR_CATEGORIES.auth_failed) {
    code = ERROR_CATEGORIES.auth_failed;
    error = 'HubSpot authentication failed.';
  } else if (status === 429 || context.code === ERROR_CATEGORIES.rate_limited) {
    code = ERROR_CATEGORIES.rate_limited;
    error = 'HubSpot rate limit reached.';
  } else if (context.code && ERROR_CATEGORIES[context.code]) {
    code = context.code;
    error = trimString(context.error) || error;
  } else if (status && status >= 400) {
    code = ERROR_CATEGORIES.provider_rejected;
    error = 'HubSpot rejected the approved CRM sync request.';
  }

  return {
    ok: false,
    status: status && status >= 400 ? status : 502,
    code,
    error_category: code,
    error,
  };
}

function splitFullName(fullName) {
  const parts = trimString(fullName).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstname: '', lastname: '' };
  if (parts.length === 1) return { firstname: parts[0], lastname: '' };
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(' '),
  };
}

function validateCommand(command) {
  if (!isPlainObject(command)) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.invalid_command,
      error: 'Approved CRM sync command is required.',
    };
  }
  if (command.automatic === true) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.automatic_forbidden,
      error: 'Automatic HubSpot sync is forbidden; explicit operator command only.',
    };
  }
  if (command.deal != null) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.deal_forbidden,
      error: 'Deal objects are forbidden for approved CRM sync; Company and Contacts only.',
    };
  }
  if (trimString(command.operator_command) !== APPROVED_CRM_SYNC_OPERATOR_COMMAND) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.invalid_command,
      error: 'Approved CRM sync requires the explicit operator command.',
    };
  }
  if (!trimString(command.idempotency_key)) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.invalid_command,
      error: 'Approved CRM sync command requires an idempotency key.',
    };
  }
  if (!isPlainObject(command.company) || !trimString(command.company.name)) {
    return {
      ok: false,
      code: ERROR_CATEGORIES.invalid_command,
      error: 'Approved CRM sync command requires a Company.',
    };
  }
  return { ok: true };
}

function buildCompanyProperties(command) {
  const company = command.company;
  const correlation = isPlainObject(company.correlation) ? company.correlation : {};
  const properties = {
    name: trimString(company.name),
    lifecyclestage: 'lead',
  };
  const domain = trimString(company.domain);
  if (domain) properties.domain = domain;
  const website = trimString(company.website_url || company.website);
  if (website) properties.website = website;

  const statusValue = company.properties && company.properties['Luna Sales Status']
    ? trimString(company.properties['Luna Sales Status'])
    : 'Qualified Prospect';
  properties.luna_sales_status = statusValue;

  const prospectCorrelation = trimString(
    correlation[COMPANY_CORRELATION_PROPERTY]
      || correlation.crowsnest_sales_prospect_id
      || command.prospect_id,
  );
  if (prospectCorrelation) {
    properties[COMPANY_CORRELATION_PROPERTY] = prospectCorrelation;
  }

  return properties;
}

function buildContactProperties(contact) {
  const names = splitFullName(contact.full_name || contact.name);
  const properties = {};
  if (names.firstname) properties.firstname = names.firstname;
  if (names.lastname) properties.lastname = names.lastname;
  const email = trimString(contact.email);
  if (email) properties.email = email;
  const role = trimString(contact.role || contact.title);
  if (role) properties.jobtitle = role;
  return properties;
}

async function readResponseBody(response) {
  if (!response || typeof response.json !== 'function') {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function providerObjectId(body) {
  if (!body || typeof body !== 'object') return '';
  return trimString(body.id);
}

/**
 * Perform one timed HubSpot request via injected fetch + AbortController.
 * Never retries automatically.
 */
async function hubspotRequest(fetchImpl, {
  path,
  method,
  accessToken,
  body,
  timeoutMs,
  idempotencyKey,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    if (idempotencyKey) {
      headers['X-Crowsnest-Idempotency-Key'] = idempotencyKey;
    }
    const response = await fetchImpl(`${HUBSPOT_API_BASE}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await readResponseBody(response);
    const status = Number(response && response.status) || 0;
    if (!response || status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        error: sanitizeHubSpotAdapterError(new Error('provider_rejected'), {
          status,
          code: status === 401 || status === 403
            ? ERROR_CATEGORIES.auth_failed
            : (status === 429 ? ERROR_CATEGORIES.rate_limited : ERROR_CATEGORIES.provider_rejected),
        }),
      };
    }
    const id = providerObjectId(payload);
    if (!id) {
      return {
        ok: false,
        status: 502,
        error: sanitizeHubSpotAdapterError(new Error('missing_provider_id'), {
          status: 502,
          code: ERROR_CATEGORIES.provider_rejected,
        }),
      };
    }
    return { ok: true, status, id };
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || controller.signal.aborted);
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: sanitizeHubSpotAdapterError(err, { timedOut, status: timedOut ? 504 : 502 }),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sync an approved CRM command to HubSpot v3 (Company + optional Contacts).
 * Deal creation is forbidden. fetch must be injected.
 *
 * @param {object} options
 * @param {object} options.command
 * @param {string} options.accessToken injected token (never read from env here)
 * @param {Function} options.fetch injected transport (required)
 * @param {number} [options.timeoutMs]
 */
async function syncApprovedCrmToHubSpotV3(options = {}) {
  const fetchImpl = options.fetch || options.fetchImpl || options.transport;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      status: 500,
      code: ERROR_CATEGORIES.transport_required,
      error_category: ERROR_CATEGORIES.transport_required,
      error: 'Injected fetch transport is required for HubSpot approved CRM sync.',
    };
  }

  const accessToken = trimString(options.accessToken || options.access_token);
  if (!accessToken) {
    return sanitizeHubSpotAdapterError(new Error('missing_token'), {
      status: 401,
      code: ERROR_CATEGORIES.auth_failed,
    });
  }

  const command = options.command;
  const validated = validateCommand(command);
  if (!validated.ok) {
    return {
      ok: false,
      status: 400,
      code: validated.code,
      error_category: validated.code,
      error: validated.error,
    };
  }

  const timeoutMs = Number(options.timeoutMs || options.timeout_ms) > 0
    ? Number(options.timeoutMs || options.timeout_ms)
    : DEFAULT_TIMEOUT_MS;

  const companyResult = await hubspotRequest(fetchImpl, {
    path: '/crm/v3/objects/companies',
    method: 'POST',
    accessToken,
    timeoutMs,
    idempotencyKey: command.idempotency_key,
    body: {
      properties: buildCompanyProperties(command),
    },
  });
  if (!companyResult.ok) {
    return companyResult.error;
  }

  const contactInputs = Array.isArray(command.contacts) ? command.contacts : [];
  const syncedContacts = [];
  for (const contact of contactInputs) {
    const contactResult = await hubspotRequest(fetchImpl, {
      path: '/crm/v3/objects/contacts',
      method: 'POST',
      accessToken,
      timeoutMs,
      idempotencyKey: `${command.idempotency_key}:contact:${trimString(contact.email || contact.full_name)}`,
      body: {
        properties: buildContactProperties(contact),
        associations: [
          {
            to: { id: companyResult.id },
            types: [
              {
                associationCategory: 'HUBSPOT_DEFINED',
                associationTypeId: 1,
              },
            ],
          },
        ],
      },
    });
    if (!contactResult.ok) {
      return contactResult.error;
    }
    syncedContacts.push({
      provider: PROVIDER_NAME,
      object_kind: 'contact',
      provider_object_id: contactResult.id,
    });
  }

  return {
    ok: true,
    result: {
      provider: PROVIDER_NAME,
      idempotency_key: command.idempotency_key,
      prospect_id: trimString(command.prospect_id),
      crm_review_mark_id: trimString(command.crm_review_mark_id),
      status: 'synced',
      company: {
        provider: PROVIDER_NAME,
        object_kind: 'company',
        provider_object_id: companyResult.id,
      },
      contacts: syncedContacts,
      // Deal creation is forbidden — always null; never POST a Deal object.
      deal: null,
    },
  };
}

module.exports = {
  HUBSPOT_API_BASE,
  DEFAULT_TIMEOUT_MS,
  ERROR_CATEGORIES,
  sanitizeHubSpotAdapterError,
  syncApprovedCrmToHubSpotV3,
};
