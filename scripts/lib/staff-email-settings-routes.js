'use strict';

const registry = require('./email-tenant-channel-registry');
const smtpSecretContract = require('./email-sunset-smtp-secret-ref-contract');
const imapSecretContract = require('./email-sunset-imap-secret-ref-contract');
const { createSunsetSmtpIdentityRegister } = require('./email-sunset-smtp-identity-register');
const { createSunsetSmtpIdentityDisconnect } = require('./email-sunset-smtp-identity-disconnect');
const { createSunsetSmtpLiveVerify } = require('./email-sunset-smtp-live-verify');
const { createSunsetImapLiveVerify } = require('./email-sunset-imap-live-verify');

const EMAIL_SETTINGS_PATH = '/staff/admin/email-settings';
const EMAIL_SMTP_IDENTITY_PATH = smtpSecretContract.EMAIL_SMTP_IDENTITY_PATH;
const EMAIL_SMTP_VERIFY_PATH = smtpSecretContract.EMAIL_SMTP_VERIFY_PATH;
const EMAIL_SMTP_DISCONNECT_PATH = smtpSecretContract.EMAIL_SMTP_DISCONNECT_PATH;
const EMAIL_IMAP_VERIFY_PATH = imapSecretContract.EMAIL_IMAP_VERIFY_PATH;
const SMTP_POST_BODY_KEYS = Object.freeze(['location_id', 'public_address']);
const SMTP_VERIFY_BODY_KEYS = Object.freeze(['location_id']);
const SMTP_DISCONNECT_BODY_KEYS = Object.freeze(['location_id', 'endpoint_id']);
const IMAP_VERIFY_BODY_KEYS = Object.freeze(['location_id']);
const SMTP_ALLOWED_ROLES = Object.freeze(['admin', 'owner']);
const UUID_RE_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUNSET_CLIENT_SLUG = 'sunset';
/** Independently owned disconnect gate env (matches oauth disconnect route). */
const DISCONNECT_ENABLED_ENV = 'LUNA_EMAIL_OAUTH_DISCONNECT_ENABLED';
/** Independently owned Phase B reauth start gate env (matches B3a2a; not imported). */
const PHASE_B_REAUTH_START_ENABLED_ENV = 'LUNA_EMAIL_PHASE_B_REAUTH_START_ENABLED';

/**
 * Hard cardinality bound for set-based Phase B reauth eligibility rows.
 * Aligned with registry-scale tenant endpoint counts; max+1 SQL LIMIT fail-closed.
 */
const PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS = 100;

/**
 * Set-based atomic eligibility SELECT for Phase B reauth (one statement snapshot).
 * Returns every eligibility fact for all endpoints of a client UUID from the same
 * statement: endpoint provider/auth/connector/binding/active/address/location,
 * tenant_locations ownership + location_active, and grant present/status/reconcile/
 * scope_version/generation + lease-null facts.
 * Never projected into public DTO (scope/lease/generation stay server-local).
 * Params: [client_id] only. No browser authority.
 * LIMIT max+1 so callers can fail closed when cardinality is exceeded.
 */
const SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS = `
SELECT e.id::text AS endpoint_id,
       e.location_id::text AS location_id,
       e.provider::text AS provider,
       e.auth_mode::text AS auth_mode,
       e.connector_mode::text AS connector_mode,
       e.binding_status::text AS binding_status,
       e.public_address AS public_address,
       e.active AS endpoint_active,
       l.active AS location_active,
       (g.endpoint_id IS NOT NULL) AS grant_present,
       g.grant_status::text AS grant_status,
       g.reconcile_state::text AS reconcile_state,
       g.scope_version::text AS scope_version,
       g.grant_generation AS grant_generation,
       (g.grant_status = 'lease_held' AND g.grant_lease_token IS NOT NULL) AS has_active_lease,
       (g.grant_lease_token IS NULL) AS lease_token_null,
       (g.grant_lease_owner IS NULL) AS lease_owner_null,
       (g.grant_lease_until IS NULL) AS lease_until_null
  FROM tenant_channel_endpoints e
  LEFT JOIN tenant_locations l
    ON l.client_id = e.client_id
   AND l.location_id = e.location_id
  LEFT JOIN tenant_email_delegated_grants g
    ON g.client_id = e.client_id
   AND g.endpoint_id = e.id
 WHERE e.client_id = $1::uuid
 ORDER BY e.id ASC
 LIMIT ${PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS + 1}`.replace(/\s+/g, ' ').trim();

/**
 * Real Microsoft last-sync: current sealed delta cursor → committed page_commit journal.
 * Never uses delta_states.updated_at (lease renew/pause also bump it).
 * Never invents a clock when no committed page_commit backs the current cursor.
 * Params: [client_id] only. Microsoft provider rows only.
 */
const SQL_MICROSOFT_ENDPOINT_LAST_SYNC = `
SELECT d.endpoint_id::text AS endpoint_id,
       to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_sync
  FROM tenant_email_inbound_delta_states d
  INNER JOIN tenant_email_delta_recovery_operations r
    ON r.operation_id = d.cursor_operation_id
   AND r.client_id = d.client_id
   AND r.endpoint_id = d.endpoint_id
 WHERE d.client_id = $1::uuid
   AND d.is_current = true
   AND d.provider = 'microsoft_graph'
   AND d.cursor_operation_id IS NOT NULL
   AND r.operation_kind = 'page_commit'
   AND r.outcome = 'committed'`.replace(/\s+/g, ' ').trim();

/** Exact own-data keys expected on an atomic eligibility row (order fixed for authority checks). */
const ATOMIC_ELIGIBILITY_OWN_KEYS = Object.freeze([
  'endpoint_id',
  'location_id',
  'provider',
  'auth_mode',
  'connector_mode',
  'binding_status',
  'public_address',
  'endpoint_active',
  'location_active',
  'grant_present',
  'grant_status',
  'reconcile_state',
  'scope_version',
  'grant_generation',
  'has_active_lease',
  'lease_token_null',
  'lease_owner_null',
  'lease_until_null',
]);

function isSunsetEmailSettingsUiEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true';
}

function isSunsetEmailOAuthStartEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.LUNA_EMAIL_OAUTH_START_ENABLED === 'true' && src.LUNA_DEPLOYMENT === 'sunset-staging';
}

function isSunsetEmailGoogleOAuthStartEnabled(env) {
  const src = env && typeof env === 'object' ? env : process.env;
  return src.SUNSET_EMAIL_SETTINGS_UI_ENABLED === 'true'
    && src.LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED === 'true'
    && src.LUNA_DEPLOYMENT === 'sunset-staging';
}

/**
 * Exact dual gate for Settings reauthorize action projection:
 * settings UI on + Phase B reauth start on (sunset-staging + exact true).
 * Default-off; never broad truthy.
 */
function isPhaseBReauthSettingsActionEnabled(env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.SUNSET_EMAIL_SETTINGS_UI_ENABLED !== 'true') return false;
    if (env.LUNA_DEPLOYMENT !== 'sunset-staging') return false;
    if (env[PHASE_B_REAUTH_START_ENABLED_ENV] !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

function isDisconnectSettingsActionEnabled(env) {
  try {
    if (!env || typeof env !== 'object') return false;
    if (env.SUNSET_EMAIL_SETTINGS_UI_ENABLED !== 'true') return false;
    if (env.LUNA_DEPLOYMENT !== 'sunset-staging') return false;
    if (env[DISCONNECT_ENABLED_ENV] !== 'true') return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Eligible for OAuth start (existing prepare product): Microsoft delegated modes
 * + pre-verified binding + non-empty public_address. Matches start resolve SQL.
 */
function isEligibleMicrosoftEndpoint(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.provider !== 'microsoft_graph') return false;
  if (row.auth_mode !== 'delegated_authorization_code') return false;
  if (row.connector_mode !== 'microsoft_delegated_oauth') return false;
  if (row.binding_status !== 'unverified_offline'
      && row.binding_status !== 'pending_manual_validation') {
    return false;
  }
  const addr = row.public_address;
  return typeof addr === 'string' && addr.trim() !== '';
}

function isEligibleGmailEndpoint(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.provider !== 'gmail_api') return false;
  if (row.auth_mode !== 'delegated_authorization_code') return false;
  if (row.connector_mode !== 'google_delegated_oauth') return false;
  if (row.binding_status !== 'unverified_offline'
      && row.binding_status !== 'pending_manual_validation') return false;
  return typeof row.public_address === 'string' && row.public_address.trim() !== '';
}

function isEligibleUnverifiedDelegatedEndpoint(row) {
  return isEligibleMicrosoftEndpoint(row) || isEligibleGmailEndpoint(row);
}

function isEligibleDisconnectEndpoint(row, grantFact) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (!grantFact || typeof grantFact !== 'object' || Array.isArray(grantFact)) return false;
    // Registry activation is independent of grant revocability. A verified active
    // grant must remain disconnectable even while routing is intentionally inactive.
    if (row.location_active !== true) return false;
    if (row.provider !== 'microsoft_graph') return false;
    if (row.auth_mode !== 'delegated_authorization_code') return false;
    if (row.connector_mode !== 'microsoft_delegated_oauth') return false;
    if (row.binding_status !== 'verified' && row.binding_status !== 'reauthorization_required') return false;
    if (typeof row.public_address !== 'string' || row.public_address.trim() === '') return false;
    if (grantFact.grant_present !== true) return false;
    if (grantFact.grant_status === 'revoked') return false;
    if (grantFact.grant_status !== 'active' && grantFact.grant_status !== 'reauthorization_required') return false;
    if (grantFact.reconcile_state !== 'clean') return false;
    if (grantFact.has_active_lease === true) return false;
    if (grantFact.lease_clear !== true) return false;
    if (isEligibleUnverifiedDelegatedEndpoint(row) === true) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Registered-but-not-connected remove eligibility (leftover prepare / partial OAuth).
 * Microsoft + Gmail delegated endpoints with no grant. Same Disconnect chrome family.
 */
function isEligibleRegisteredEndpointRemove(row, grantFact) {
  try {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (!grantFact || typeof grantFact !== 'object' || Array.isArray(grantFact)) return false;
    if (row.location_active !== true) return false;
    if (row.provider !== 'microsoft_graph' && row.provider !== 'gmail_api') return false;
    if (row.auth_mode !== 'delegated_authorization_code') return false;
    if (row.provider === 'microsoft_graph'
        && row.connector_mode !== 'microsoft_delegated_oauth') return false;
    if (row.provider === 'gmail_api'
        && row.connector_mode !== 'google_delegated_oauth') return false;
    if (row.binding_status !== 'unverified_offline'
        && row.binding_status !== 'pending_manual_validation') return false;
    if (typeof row.public_address !== 'string' || row.public_address.trim() === '') return false;
    if (grantFact.grant_present === true) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Phase B reauthorize eligibility — retired (single-consent connect).
 * Kept for call-site stability; always false on live path.
 */
function isEligiblePhaseBReauthorizeEndpoint(_row, _grantFact) {
  return false;
}

/**
 * Snapshot grant fact for eligibility from a pure fact object (tests / pure path).
 * Never returns secrets; scope/lease used only for boolean eligibility.
 * Malformed/extra/proxy shapes fail closed (lease_clear false, scope null).
 * Production eligibility uses grantFactFromAtomicEligibilityRow (single SQL row).
 */
function snapshotPhaseBReauthGrantFact(publicGrant, internalRow) {
  try {
    if (!publicGrant || typeof publicGrant !== 'object' || Array.isArray(publicGrant)) {
      return Object.freeze({
        grant_present: false,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
        grant_generation: null,
        scope_version: null,
        lease_clear: false,
      });
    }
    const present = publicGrant.grant_present === true;
    let gen = null;
    if (typeof publicGrant.grant_generation === 'number'
        && Number.isInteger(publicGrant.grant_generation)
        && publicGrant.grant_generation >= 1) {
      gen = publicGrant.grant_generation;
    }
    let scope_version = null;
    let lease_clear = false;
    if (present && internalRow && typeof internalRow === 'object' && !Array.isArray(internalRow)) {
      if (typeof internalRow.scope_version === 'string') {
        scope_version = internalRow.scope_version;
      }
      if (internalRow.lease_token_null === true
          && internalRow.lease_owner_null === true
          && internalRow.lease_until_null === true) {
        lease_clear = true;
      }
      if (gen == null && internalRow.grant_generation != null) {
        const n = Number(internalRow.grant_generation);
        if (Number.isInteger(n) && n >= 1) gen = n;
      }
    }
    return Object.freeze({
      grant_present: present,
      grant_status: present ? (publicGrant.grant_status || null) : null,
      reconcile_state: present ? (publicGrant.reconcile_state || null) : null,
      has_active_lease: publicGrant.has_active_lease === true,
      grant_generation: gen,
      scope_version,
      lease_clear,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
      grant_generation: null,
      scope_version: null,
      lease_clear: false,
    });
  }
}

/**
 * Build eligibility grant fact solely from one atomic SQL row.
 * Fail-closed: never mixes prior public status or a second snapshot.
 */
function grantFactFromAtomicEligibilityRow(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) {
      return Object.freeze({
        grant_present: false,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
        grant_generation: null,
        scope_version: null,
        lease_clear: false,
      });
    }
    const present = atomicRow.grant_present === true;
    let gen = null;
    if (atomicRow.grant_generation != null) {
      const n = Number(atomicRow.grant_generation);
      if (Number.isInteger(n) && n >= 1) gen = n;
    }
    const lease_clear = present
      && atomicRow.lease_token_null === true
      && atomicRow.lease_owner_null === true
      && atomicRow.lease_until_null === true;
    return Object.freeze({
      grant_present: present,
      grant_status: present && typeof atomicRow.grant_status === 'string' ? atomicRow.grant_status : null,
      reconcile_state: present && typeof atomicRow.reconcile_state === 'string' ? atomicRow.reconcile_state : null,
      has_active_lease: atomicRow.has_active_lease === true,
      grant_generation: gen,
      scope_version: present && typeof atomicRow.scope_version === 'string' ? atomicRow.scope_version : null,
      lease_clear: lease_clear === true,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
      grant_generation: null,
      scope_version: null,
      lease_clear: false,
    });
  }
}

/**
 * Public connection-state grant view from the same atomic row (display only).
 * Eligibility must never use this alone without grantFactFromAtomicEligibilityRow.
 */
function publicGrantFromAtomicEligibilityRow(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) {
      return Object.freeze({
        grant_present: false,
        grant_generation: null,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
      });
    }
    if (atomicRow.grant_present !== true) {
      return Object.freeze({
        grant_present: false,
        grant_generation: null,
        grant_status: null,
        reconcile_state: null,
        has_active_lease: false,
      });
    }
    let gen = null;
    if (atomicRow.grant_generation != null) {
      const n = Number(atomicRow.grant_generation);
      if (Number.isInteger(n) && n >= 1) gen = n;
    }
    return Object.freeze({
      grant_present: true,
      grant_generation: gen,
      grant_status: typeof atomicRow.grant_status === 'string' ? atomicRow.grant_status : null,
      reconcile_state: typeof atomicRow.reconcile_state === 'string' ? atomicRow.reconcile_state : null,
      has_active_lease: atomicRow.has_active_lease === true,
    });
  } catch (_) {
    return Object.freeze({
      grant_present: false,
      grant_generation: null,
      grant_status: null,
      reconcile_state: null,
      has_active_lease: false,
    });
  }
}

/**
 * Endpoint-shaped eligibility input taken only from the atomic row (same snapshot).
 * Includes location_active from the joined tenant_locations ownership fact.
 */
function endpointRowFromAtomicEligibility(atomicRow) {
  try {
    if (!atomicRow || typeof atomicRow !== 'object' || Array.isArray(atomicRow)) return null;
    return Object.freeze({
      id: typeof atomicRow.endpoint_id === 'string' ? atomicRow.endpoint_id : null,
      location_id: typeof atomicRow.location_id === 'string' ? atomicRow.location_id : null,
      provider: typeof atomicRow.provider === 'string' ? atomicRow.provider : null,
      auth_mode: typeof atomicRow.auth_mode === 'string' ? atomicRow.auth_mode : null,
      connector_mode: typeof atomicRow.connector_mode === 'string' ? atomicRow.connector_mode : null,
      binding_status: typeof atomicRow.binding_status === 'string' ? atomicRow.binding_status : null,
      public_address: typeof atomicRow.public_address === 'string' ? atomicRow.public_address : null,
      active: atomicRow.endpoint_active === true,
      location_active: atomicRow.location_active === true,
    });
  } catch (_) {
    return null;
  }
}

/**
 * Validate one SQL result row as an exact immutable own-data snapshot.
 * Exact own string key set only — no missing OR extra keys.
 * Rejects proxies, symbols, accessors, non-enumerable props, non-plain prototypes.
 * Extra secret_ref (or any unknown key) fails closed before projection.
 * Returns frozen plain own-data object or null (fail-closed).
 */
function normalizeAtomicEligibilityRow(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // Proxy brand check (native when available).
    try {
      const util = require('util');
      if (util && util.types && typeof util.types.isProxy === 'function' && util.types.isProxy(raw)) {
        return null;
      }
    } catch (_) { /* ignore util pin miss */ }
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(raw);
    const stringKeys = [];
    for (let i = 0; i < keys.length; i += 1) {
      if (typeof keys[i] === 'symbol') return null;
      if (typeof keys[i] !== 'string') return null;
      stringKeys.push(keys[i]);
    }
    // Exact own string key set: no missing and no extras (e.g. secret_ref).
    if (stringKeys.length !== ATOMIC_ELIGIBILITY_OWN_KEYS.length) return null;
    const expected = new Set(ATOMIC_ELIGIBILITY_OWN_KEYS);
    for (let i = 0; i < stringKeys.length; i += 1) {
      if (!expected.has(stringKeys[i])) return null;
    }
    const out = Object.create(null);
    for (let i = 0; i < ATOMIC_ELIGIBILITY_OWN_KEYS.length; i += 1) {
      const key = ATOMIC_ELIGIBILITY_OWN_KEYS[i];
      const desc = Object.getOwnPropertyDescriptor(raw, key);
      if (!desc
          || !Object.prototype.hasOwnProperty.call(desc, 'value')
          || desc.get
          || desc.set
          || desc.enumerable !== true) {
        return null;
      }
      out[key] = desc.value;
    }
    if (typeof out.endpoint_id !== 'string' || !out.endpoint_id) return null;
    // Canonical location_id required non-null for ownership join fact.
    if (typeof out.location_id !== 'string' || !out.location_id) return null;
    return Object.freeze(out);
  } catch (_) {
    return null;
  }
}

/**
 * Exact-map atomic rows by endpoint_id for the listed endpoint set.
 * Fail-closed on cardinality exceed, duplicate, missing, extra, mutable/proxy/accessor/symbol rows.
 * Requires exact one normalized row per listed endpoint (no duplicates/missing/extras).
 * @returns {{ ok: true, map: ReadonlyMap<string, object> } | { ok: false }}
 */
function indexAtomicEligibilityRows(atomicRows, expectedEndpointIds) {
  try {
    if (!Array.isArray(atomicRows) || !Array.isArray(expectedEndpointIds)) {
      return { ok: false };
    }
    if (atomicRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
      return { ok: false };
    }
    if (expectedEndpointIds.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
      return { ok: false };
    }
    const expected = new Set();
    for (let i = 0; i < expectedEndpointIds.length; i += 1) {
      const id = expectedEndpointIds[i];
      if (typeof id !== 'string' || !id) return { ok: false };
      if (expected.has(id)) return { ok: false }; // duplicate expected ids
      expected.add(id);
    }
    // Exact cardinality: one atomic row per listed endpoint.
    if (atomicRows.length !== expectedEndpointIds.length) {
      return { ok: false };
    }
    const map = new Map();
    for (let i = 0; i < atomicRows.length; i += 1) {
      const norm = normalizeAtomicEligibilityRow(atomicRows[i]);
      if (!norm) return { ok: false };
      if (map.has(norm.endpoint_id)) return { ok: false }; // duplicate atomic
      if (!expected.has(norm.endpoint_id)) return { ok: false }; // extra
      map.set(norm.endpoint_id, norm);
    }
    for (const id of expected) {
      if (!map.has(id)) return { ok: false }; // missing
    }
    return { ok: true, map };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Load set-based atomic eligibility facts for one client UUID.
 * One SQL statement; never composes two snapshots.
 * Fail-closed when result length exceeds PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS
 * (SQL LIMIT max+1 makes over-bound visible before normalization).
 */
async function loadPhaseBReauthEligibilityFacts(pg, clientId) {
  try {
    if (!pg || typeof pg.query !== 'function') return null;
    if (typeof clientId !== 'string' || !clientId) return null;
    const found = await pg.query(SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS, [clientId]);
    if (!found || !Array.isArray(found.rows)) return null;
    if (found.rows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) return null;
    return found.rows;
  } catch (_) {
    return null;
  }
}

/**
 * Normalize a stored last-sync value to a finite ISO-8601 string, or null.
 * Accepts Date or parseable string; rejects empty / invalid / non-finite.
 */
function normalizeLastSyncIso(raw) {
  try {
    if (raw == null) return null;
    if (raw instanceof Date) {
      const ms = raw.getTime();
      if (!Number.isFinite(ms)) return null;
      return raw.toISOString();
    }
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
}

/**
 * Load Microsoft last_sync map for one client UUID from durable poller evidence.
 * Key = endpoint_id text; value = ISO string. Empty map when none / fail-soft.
 * Never fabricates timestamps. Gmail/IMAP are never present in this query.
 */
async function loadMicrosoftEndpointLastSyncMap(pg, clientId) {
  const empty = new Map();
  try {
    if (!pg || typeof pg.query !== 'function') return empty;
    if (typeof clientId !== 'string' || !clientId) return empty;
    const found = await pg.query(SQL_MICROSOFT_ENDPOINT_LAST_SYNC, [clientId]);
    if (!found || !Array.isArray(found.rows)) return empty;
    const map = new Map();
    for (let i = 0; i < found.rows.length; i += 1) {
      const row = found.rows[i];
      if (!row || typeof row !== 'object') continue;
      const endpointId = typeof row.endpoint_id === 'string' ? row.endpoint_id : '';
      const lastSync = normalizeLastSyncIso(row.last_sync);
      if (!endpointId || !lastSync) continue;
      map.set(endpointId, lastSync);
    }
    return map;
  } catch (_) {
    return empty;
  }
}

/** Fail-closed own enumerable data boolean — never inherited, getter, or truthy-other. */
function ownExactTrue(o, key) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    const d = Object.getOwnPropertyDescriptor(o, key);
    return !!(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable === true
      && !d.get && !d.set && d.value === true);
  } catch (_) {
    return false;
  }
}

/** Fail-closed own enumerable string equals expected. */
function ownExactString(o, key, expected) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof expected !== 'string') return false;
    const d = Object.getOwnPropertyDescriptor(o, key);
    return !!(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable === true
      && !d.get && !d.set && d.value === expected);
  } catch (_) {
    return false;
  }
}

function publicState(endpoint, grant) {
  if (!endpoint) return 'disconnected';
  if (endpoint.provider === 'imap_smtp' && (
    endpoint.binding_status === 'revoked'
    || endpoint.provider_resource_id === 'disconnected'
  )) return 'disconnected';
  if (endpoint.provider === 'imap_smtp' && grant
      && (grant.smtp_verified === true || grant.imap_verified === true)) {
    return 'connected_health';
  }
  if (!grant || grant.grant_present !== true) return 'registered_not_connected';
  if (grant.grant_status === 'revoked') return 'revoked';
  if (grant.grant_status === 'reauthorization_required' || endpoint.binding_status === 'reauthorization_required') return 'reauth_required';
  if (grant.grant_status === 'active' || grant.grant_status === 'lease_held') return 'connected_health';
  return 'error';
}

/**
 * Public endpoint DTO. reauthorize_eligible is a boolean fact only — never
 * generation, scope strings, lease internals, tokens, or provider payloads.
 * When options.atomicRow is provided, eligibility is built solely from that row.
 * last_sync is Microsoft-only and omitted unless options.lastSync is a real ISO.
 */
function endpointDto(row, grant, options) {
  const reauthGateOn = options && options.reauthGateOn === true;
  const disconnectGateOn = options && options.disconnectGateOn === true;
  const atomicRow = options && options.atomicRow ? options.atomicRow : null;
  const startEligible = isEligibleUnverifiedDelegatedEndpoint(row) === true;
  let reauthorizeEligible = false;
  let disconnectEligible = false;
  let publicGrant = grant;
  if (atomicRow) {
    // Eligibility depends solely on the atomic immutable own-data snapshot.
    const atomicEndpoint = endpointRowFromAtomicEligibility(atomicRow);
    const grantFact = grantFactFromAtomicEligibilityRow(atomicRow);
    publicGrant = publicGrantFromAtomicEligibilityRow(atomicRow);
    if (reauthGateOn && startEligible !== true && atomicEndpoint) {
      reauthorizeEligible = isEligiblePhaseBReauthorizeEndpoint(atomicEndpoint, grantFact) === true;
    }
    if (disconnectGateOn && atomicEndpoint) {
      // Connected revoke OR registered-not-connected remove (Connect + Remove may both show).
      disconnectEligible = isEligibleDisconnectEndpoint(atomicEndpoint, grantFact) === true
        || isEligibleRegisteredEndpointRemove(atomicEndpoint, grantFact) === true;
    }
  } else {
    // Pure/unit path without atomic SQL (tests of DTO projection only).
    const grantFact = options && options.grantFact
      ? options.grantFact
      : snapshotPhaseBReauthGrantFact(grant, null);
    if (reauthGateOn && startEligible !== true) {
      reauthorizeEligible = isEligiblePhaseBReauthorizeEndpoint(row, grantFact) === true;
    }
    if (disconnectGateOn) {
      disconnectEligible = isEligibleDisconnectEndpoint(row, grantFact) === true
        || isEligibleRegisteredEndpointRemove(row, grantFact) === true;
    }
  }
  if (row && row.provider === 'imap_smtp' && grant
      && (grant.smtp_verified === true || grant.imap_verified === true)) {
    publicGrant = grant;
  }
  const dto = {
    endpoint_id: row.id,
    location_id: row.location_id,
    provider: row.provider,
    public_address: row.public_address,
    connection_state: publicState(row, publicGrant),
    grant_status: publicGrant && publicGrant.grant_present ? publicGrant.grant_status : null,
    reconcile_state: publicGrant && publicGrant.grant_present ? publicGrant.reconcile_state : null,
    endpoint_active: ownExactTrue(row, 'active'),
    inbound_enabled: ownExactTrue(row, 'inbound_enabled'),
    outbound_enabled: ownExactTrue(row, 'outbound_enabled'),
    staff_replies_enabled: ownExactTrue(row, 'outbound_enabled'),
    automation_enabled: ownExactString(row, 'default_automation_mode', 'automatic'),
    start_eligible: startEligible,
    reauthorize_eligible: reauthorizeEligible === true,
    disconnect_eligible: disconnectEligible === true,
  };
  // Microsoft only: project a real poller timestamp when present; never invent.
  if (row && row.provider === 'microsoft_graph') {
    const lastSync = normalizeLastSyncIso(options && options.lastSync);
    if (lastSync) dto.last_sync = lastSync;
  }
  return Object.freeze(dto);
}

/**
 * Compute prepare vs connect vs reauthorize actions.
 * - prepare: start gate on + active location with no endpoint
 * - connect: start gate on + existing eligible unverified delegated endpoint
 * - reauthorize: Phase B settings dual gate on + eligible verified Phase A grant
 * Never both prepare/connect and reauthorize for the same endpoint (binding
 * status disjoint). Never auto-creates endpoints.
 */
function providerActions(startOn, reauthOn, disconnectOn, provider, locations, endpoints) {
  const providerEndpoints = endpoints.filter((endpoint) => endpoint.provider === provider);
  const hasEligible = startOn && providerEndpoints.some((endpoint) => endpoint.start_eligible === true);
  const hasActiveLocationWithoutEndpoint = locations.some((location) => location.active === true
    && !providerEndpoints.some((endpoint) => endpoint.location_id === location.location_id));
  const hasReauth = provider === 'microsoft_graph' && reauthOn
    && providerEndpoints.some((endpoint) => endpoint.reauthorize_eligible === true);
  const hasDisconnect = disconnectOn
    && providerEndpoints.some((endpoint) => endpoint.disconnect_eligible === true);
  const hasImapDisconnect = provider === 'imap_smtp' && providerEndpoints.length > 0;
  return Object.freeze({ prepare: startOn && hasActiveLocationWithoutEndpoint && !hasEligible,
    connect: hasEligible, disconnect: hasDisconnect || hasImapDisconnect, reauthorize: hasReauth });
}

function computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints) {
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const locs = Array.isArray(locations) ? locations : [];
  const smtpOn = smtpSecretContract.isSunsetEmailSmtpIdentityRegisterEnabled(runtimeEnv)
    && smtpSecretContract.evaluateSunsetSmtpSecretRefs(runtimeEnv).ok === true;
  const disconnectOn = isDisconnectSettingsActionEnabled(runtimeEnv);
  return Object.freeze({
    microsoft_graph: providerActions(isSunsetEmailOAuthStartEnabled(runtimeEnv),
      isPhaseBReauthSettingsActionEnabled(runtimeEnv),
      disconnectOn, 'microsoft_graph', locs, eps),
    // Gmail: prepare/connect from Google start gate; Remove uses shared disconnect gate.
    gmail_api: providerActions(isSunsetEmailGoogleOAuthStartEnabled(runtimeEnv), false, disconnectOn,
      'gmail_api', locs, eps),
    imap_smtp: providerActions(smtpOn, false, false, 'imap_smtp', locs, eps),
  });
}

function snapshotSmtpPostBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== SMTP_POST_BODY_KEYS.length) return null;
    for (let i = 0; i < SMTP_POST_BODY_KEYS.length; i += 1) {
      if (actual[i] !== SMTP_POST_BODY_KEYS[i] || typeof actual[i] !== 'string') return null;
    }
    const out = Object.create(null);
    for (const key of SMTP_POST_BODY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(body, key);
      if (!descriptor
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.get
          || descriptor.set
          || !descriptor.enumerable) {
        return null;
      }
      out[key] = descriptor.value;
    }
    if (typeof out.location_id !== 'string' || !LOCATION_SLUG_RE.test(out.location_id)) return null;
    if (typeof out.public_address !== 'string') return null;
    return Object.freeze({
      location_id: out.location_id,
      public_address: out.public_address,
    });
  } catch (_) {
    return null;
  }
}

function snapshotSmtpVerifyBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== 1 || actual[0] !== SMTP_VERIFY_BODY_KEYS[0]) return null;
    const descriptor = Object.getOwnPropertyDescriptor(body, 'location_id');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get || descriptor.set || !descriptor.enumerable
        || typeof descriptor.value !== 'string' || !LOCATION_SLUG_RE.test(descriptor.value)) return null;
    return Object.freeze({ location_id: descriptor.value });
  } catch (_) { return null; }
}

function snapshotImapVerifyBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== 1 || actual[0] !== IMAP_VERIFY_BODY_KEYS[0]) return null;
    const descriptor = Object.getOwnPropertyDescriptor(body, 'location_id');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.get || descriptor.set || !descriptor.enumerable
        || typeof descriptor.value !== 'string' || !LOCATION_SLUG_RE.test(descriptor.value)) return null;
    return Object.freeze({ location_id: descriptor.value });
  } catch (_) { return null; }
}

function snapshotSmtpDisconnectBody(body) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = Reflect.ownKeys(body);
    if (actual.length !== SMTP_DISCONNECT_BODY_KEYS.length) return null;
    for (let i = 0; i < SMTP_DISCONNECT_BODY_KEYS.length; i += 1) {
      if (actual[i] !== SMTP_DISCONNECT_BODY_KEYS[i]) return null;
    }
    const locationDesc = Object.getOwnPropertyDescriptor(body, 'location_id');
    const endpointDesc = Object.getOwnPropertyDescriptor(body, 'endpoint_id');
    if (!locationDesc || !endpointDesc
        || !Object.prototype.hasOwnProperty.call(locationDesc, 'value')
        || !Object.prototype.hasOwnProperty.call(endpointDesc, 'value')
        || locationDesc.get || locationDesc.set || endpointDesc.get || endpointDesc.set
        || !locationDesc.enumerable || !endpointDesc.enumerable
        || typeof locationDesc.value !== 'string' || !LOCATION_SLUG_RE.test(locationDesc.value)
        || typeof endpointDesc.value !== 'string' || !UUID_RE_CI.test(endpointDesc.value)) {
      return null;
    }
    return Object.freeze({
      location_id: locationDesc.value,
      endpoint_id: endpointDesc.value.toLowerCase(),
    });
  } catch (_) { return null; }
}

function smtpSecretStatusDto(runtimeEnv) {
  const refs = smtpSecretContract.evaluateSunsetSmtpSecretRefs(runtimeEnv);
  return Object.freeze({
    configured: refs.ok === true,
    missing_secret_names: Array.isArray(refs.missing_secret_names)
      ? refs.missing_secret_names.slice()
      : [],
  });
}

function defaultCreateSmtpIdentityRegister(client, env) {
  return createSunsetSmtpIdentityRegister(Object.freeze({
    client: Object.freeze({ query: client.query.bind(client) }),
    env,
  }));
}

function computeEmailSettingsActions(runtimeEnv, locations, endpoints) {
  return computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints).microsoft_graph;
}

function createEmailSettingsRoutes(deps) {
  const listLocations = deps.listTenantLocations || registry.listTenantLocations;
  const listEndpoints = deps.listTenantChannelEndpoints || registry.listTenantChannelEndpoints;
  const loadAtomicFacts = deps.loadPhaseBReauthEligibilityFacts || loadPhaseBReauthEligibilityFacts;
  const loadLastSyncMap = deps.loadMicrosoftEndpointLastSyncMap || loadMicrosoftEndpointLastSyncMap;
  const runtimeEnv = deps.runtimeEnv || process.env;
  const createSmtpRegister = typeof deps.createSmtpIdentityRegister === 'function'
    ? deps.createSmtpIdentityRegister
    : (client) => defaultCreateSmtpIdentityRegister(client, runtimeEnv);
  const createSmtpVerify = typeof deps.createSmtpLiveVerify === 'function'
    ? deps.createSmtpLiveVerify
    : (client) => createSunsetSmtpLiveVerify(Object.freeze({
      client: Object.freeze({ query: client.query.bind(client) }), env: runtimeEnv,
      secretProvider: deps.secretProvider, smtpTransport: deps.smtpTransport,
    }));
  const createImapVerify = typeof deps.createImapLiveVerify === 'function'
    ? deps.createImapLiveVerify
    : (client) => createSunsetImapLiveVerify(Object.freeze({
      client: Object.freeze({ query: client.query.bind(client) }), env: runtimeEnv,
      secretProvider: deps.imapSecretProvider, imapTransport: deps.imapTransport,
    }));
  const createSmtpDisconnect = typeof deps.createSmtpIdentityDisconnect === 'function'
    ? deps.createSmtpIdentityDisconnect
    : (client) => createSunsetSmtpIdentityDisconnect(Object.freeze({
      client: Object.freeze({ query: client.query.bind(client) }),
      env: runtimeEnv,
    }));

  async function handleGet(query, req, res, user) {
    if (!isSunsetEmailSettingsUiEnabled(runtimeEnv)) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    const slug = String((query && (query.client || query.client_slug)) || '').trim();
    if (slug !== SUNSET_CLIENT_SLUG) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    if (!deps.assertStaffClientAccess(user, slug, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({ clientSlug: slug, method: 'GET', pathname: EMAIL_SETTINGS_PATH, env: runtimeEnv });
    if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    try {
      return await deps.withPgClient(async (pg) => {
        const found = await pg.query('SELECT id::text AS client_id FROM clients WHERE slug=$1 LIMIT 1', [slug]);
        const clientId = found.rows && found.rows[0] && String(found.rows[0].client_id || '');
        if (!clientId) return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
        const [locationsResult, endpointsResult] = await Promise.all([
          listLocations({ clientId, includeInactive: true }, { db: pg }),
          listEndpoints({ clientId, includeInactive: true }, { db: pg }),
        ]);
        if (!locationsResult.ok || !endpointsResult.ok) throw new Error('aggregate_failed');
        const reauthGateOn = isPhaseBReauthSettingsActionEnabled(runtimeEnv);
        const disconnectGateOn = isDisconnectSettingsActionEnabled(runtimeEnv);
        const endpointRows = Array.isArray(endpointsResult.value) ? endpointsResult.value : [];
        if (endpointRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
          throw new Error('aggregate_failed');
        }
        const expectedIds = endpointRows.map((row) => String(row.id));

        // ONE set-based atomic statement for all endpoints (no per-endpoint two-read merge).
        let atomicIndex = null;
        if (endpointRows.length > 0) {
          const atomicRows = await loadAtomicFacts(pg, clientId);
          if (!Array.isArray(atomicRows)) throw new Error('aggregate_failed');
          if (atomicRows.length > PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS) {
            throw new Error('aggregate_failed');
          }
          const indexed = indexAtomicEligibilityRows(atomicRows, expectedIds);
          if (!indexed.ok) throw new Error('aggregate_failed');
          atomicIndex = indexed.map;
        }

        // Optional Microsoft last_sync from durable page_commit evidence (fail-soft → omit).
        const lastSyncMap = endpointRows.length > 0
          ? await loadLastSyncMap(pg, clientId)
          : new Map();
        const lastSyncByEndpoint = lastSyncMap instanceof Map ? lastSyncMap : new Map();

        const endpoints = [];
        for (const row of endpointRows) {
          const atomicRow = atomicIndex ? atomicIndex.get(String(row.id)) : null;
          if (endpointRows.length > 0 && !atomicRow) throw new Error('aggregate_failed');
          // Public display + reauthorize_eligible both derive from the same atomic row.
          // Eligibility is computed inside endpointDto solely from atomicRow when present.
          const publicGrant = atomicRow
            ? publicGrantFromAtomicEligibilityRow(atomicRow)
            : Object.freeze({
              grant_present: false,
              grant_generation: null,
              grant_status: null,
              reconcile_state: null,
              has_active_lease: false,
            });
          const lastSync = lastSyncByEndpoint.get(String(row.id));
          let projectionGrant = publicGrant;
          if (row.provider === 'imap_smtp') {
            const smtpHealthy = row.smtp_health_verified_at != null;
            const imapHealthy = row.imap_health_verified_at != null;
            if (smtpHealthy || imapHealthy) {
              projectionGrant = Object.freeze({
                smtp_verified: smtpHealthy === true,
                imap_verified: imapHealthy === true,
              });
            }
          }
          const dto = endpointDto(row, projectionGrant, {
            atomicRow,
            reauthGateOn,
            disconnectGateOn,
            lastSync,
          });
          if (dto.provider === 'imap_smtp' && dto.connection_state === 'disconnected') continue;
          endpoints.push(dto);
        }
        const locations = locationsResult.value.map((row) => Object.freeze({
          location_id: row.location_id, display_name: row.display_name, active: row.active === true,
        }));
        const providerActionsDto = computeProviderEmailSettingsActions(runtimeEnv, locations, endpoints);
        const actions = providerActionsDto.microsoft_graph;
        const body = {
          success: true,
          client: SUNSET_CLIENT_SLUG,
          read_only: true,
          actions,
          provider_actions: providerActionsDto,
          locations,
          endpoints,
        };
        if (smtpSecretContract.isSunsetEmailSmtpIdentityRegisterEnabled(runtimeEnv)) {
          const status = smtpSecretStatusDto(runtimeEnv);
          body.smtp_secret_status = {
            configured: status.configured,
            missing_secret_names: status.missing_secret_names,
          };
        }
        return deps.sendJSON(res, 200, body);
      });
    } catch (_) {
      return deps.sendJSON(res, 500, { success: false, error: 'email_settings_unavailable' });
    }
  }

  async function handlePost(body, req, res, user) {
    if (!smtpSecretContract.isSunsetEmailSmtpIdentityRegisterEnabled(runtimeEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const role = user && typeof user.role === 'string' ? user.role : '';
    if (SMTP_ALLOWED_ROLES.indexOf(role) < 0) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, SUNSET_CLIENT_SLUG, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: SUNSET_CLIENT_SLUG,
      method: 'POST',
      pathname: EMAIL_SMTP_IDENTITY_PATH,
      env: runtimeEnv,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotSmtpPostBody(body);
    if (!bodySnap) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
    const secrets = smtpSecretContract.evaluateSunsetSmtpSecretRefs(runtimeEnv);
    if (!secrets.ok) {
      return deps.sendJSON(res, 400, {
        success: false,
        error: 'missing_secret_refs',
        missing_secret_names: Array.isArray(secrets.missing_secret_names)
          ? secrets.missing_secret_names.slice()
          : [],
      });
    }
    const actor = user && typeof user.staff_user_id === 'string' ? user.staff_user_id : '';
    const clientId = user && typeof user.client_id === 'string' ? user.client_id : '';
    if (!UUID_RE_CI.test(actor) || !UUID_RE_CI.test(clientId)) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const register = createSmtpRegister(pg);
        const ordered = Object.freeze({
          clientId: clientId.toLowerCase(),
          locationId: bodySnap.location_id,
          publicAddress: bodySnap.public_address,
          actorStaffUserId: actor.toLowerCase(),
        });
        const ack = await register.registerDisabledImapSmtpIdentity(ordered);
        return deps.sendJSON(res, 200, {
          success: true,
          endpoint_id: ack && typeof ack.endpointId === 'string' ? ack.endpointId : '',
          provider: 'imap_smtp',
          inbound_enabled: false,
          outbound_enabled: false,
          active: false,
          default_automation_mode: 'off',
        });
      });
    } catch (err) {
      if (err && Array.isArray(err.missing_secret_names)) {
        return deps.sendJSON(res, 400, {
          success: false,
          error: 'missing_secret_refs',
          missing_secret_names: err.missing_secret_names.slice(),
        });
      }
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
  }

  async function handleVerifyPost(body, req, res, user) {
    if (!smtpSecretContract.isSunsetEmailSmtpVerifyEnabled(runtimeEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || SMTP_ALLOWED_ROLES.indexOf(user.role) < 0) return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    if (!deps.assertStaffClientAccess(user, SUNSET_CLIENT_SLUG, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({ clientSlug: SUNSET_CLIENT_SLUG,
      method: 'POST', pathname: EMAIL_SMTP_VERIFY_PATH, env: runtimeEnv });
    if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    const input = snapshotSmtpVerifyBody(body);
    if (!input) return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    const locationId = input.location_id;
    try {
      return await deps.withPgClient(async (pg) => {
        const ack = await createSmtpVerify(pg).verifyExistingImapSmtpEndpoint(Object.freeze({
          clientId: user.client_id, locationId, actorStaffUserId: user.staff_user_id,
        }));
        return deps.sendJSON(res, 200, { success: true, endpoint_id: ack.endpointId,
          provider: 'imap_smtp', connection_state: 'connected_health', inbound_enabled: false,
          outbound_enabled: false, active: false });
      });
    } catch (err) {
      const out = { success: false, error: 'smtp_verify_failed', connection_state: 'registered_not_connected' };
      if (err && Array.isArray(err.missing_secret_names)) out.missing_secret_names = err.missing_secret_names.slice();
      if (err && Array.isArray(err.failed_secret_names)) out.failed_secret_names = err.failed_secret_names.slice();
      return deps.sendJSON(res, 400, out);
    }
  }

  async function handleImapVerifyPost(body, req, res, user) {
    if (!imapSecretContract.isSunsetEmailImapVerifyEnabled(runtimeEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    if (!user || SMTP_ALLOWED_ROLES.indexOf(user.role) < 0) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, SUNSET_CLIENT_SLUG, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: SUNSET_CLIENT_SLUG,
      method: 'POST',
      pathname: EMAIL_IMAP_VERIFY_PATH,
      env: runtimeEnv,
    });
    if (!authz.ok) return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    const snap = snapshotImapVerifyBody(body);
    if (!snap) return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    try {
      return await deps.withPgClient(async (pg) => {
        const ack = await createImapVerify(pg).verifyExistingImapSmtpEndpoint(Object.freeze({
          clientId: user.client_id, locationId: snap.location_id, actorStaffUserId: user.staff_user_id,
        }));
        return deps.sendJSON(res, 200, {
          success: true,
          endpoint_id: ack.endpointId,
          provider: 'imap_smtp',
          connection_state: 'connected_health',
          inbound_enabled: false,
          outbound_enabled: false,
          active: false,
        });
      });
    } catch (err) {
      const out = { success: false, error: 'imap_verify_failed', connection_state: 'registered_not_connected' };
      if (err && Array.isArray(err.missing_secret_names)) out.missing_secret_names = err.missing_secret_names.slice();
      if (err && Array.isArray(err.failed_secret_names)) out.failed_secret_names = err.failed_secret_names.slice();
      return deps.sendJSON(res, 400, out);
    }
  }

  async function handleDisconnectPost(body, req, res, user) {
    if (!smtpSecretContract.isSunsetEmailSmtpIdentityRegisterEnabled(runtimeEnv)) {
      return deps.sendJSON(res, 404, { success: false, error: 'not_found' });
    }
    const role = user && typeof user.role === 'string' ? user.role : '';
    if (SMTP_ALLOWED_ROLES.indexOf(role) < 0) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    if (!deps.assertStaffClientAccess(user, SUNSET_CLIENT_SLUG, res)) return;
    const authz = deps.authorizeAuthenticatedStaffRoute({
      clientSlug: SUNSET_CLIENT_SLUG,
      method: 'POST',
      pathname: EMAIL_SMTP_DISCONNECT_PATH,
      env: runtimeEnv,
    });
    if (!authz.ok) {
      return deps.sendJSON(res, authz.status || 403, authz.body || { success: false, error: 'forbidden' });
    }
    const bodySnap = snapshotSmtpDisconnectBody(body);
    if (!bodySnap) return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    const actor = user && typeof user.staff_user_id === 'string' ? user.staff_user_id : '';
    const clientId = user && typeof user.client_id === 'string' ? user.client_id : '';
    if (!UUID_RE_CI.test(actor) || !UUID_RE_CI.test(clientId)) {
      return deps.sendJSON(res, 403, { success: false, error: 'forbidden' });
    }
    try {
      return await deps.withPgClient(async (pg) => {
        const service = createSmtpDisconnect(pg);
        const ack = await service.disconnectImapSmtpIdentity(Object.freeze({
          clientId: clientId.toLowerCase(),
          locationId: bodySnap.location_id,
          endpointId: bodySnap.endpoint_id,
          actorStaffUserId: actor.toLowerCase(),
        }));
        return deps.sendJSON(res, 200, {
          success: true,
          status: ack && ack.status === 'disconnected' ? 'disconnected' : 'disconnected',
          endpoint_id: ack && typeof ack.endpointId === 'string' ? ack.endpointId : bodySnap.endpoint_id,
          provider: 'imap_smtp',
        });
      });
    } catch (_) {
      return deps.sendJSON(res, 400, { success: false, error: 'invalid_request' });
    }
  }

  return { handleGet, handlePost, handleVerifyPost, handleImapVerifyPost, handleDisconnectPost };
}

module.exports = {
  EMAIL_SETTINGS_PATH,
  EMAIL_SMTP_IDENTITY_PATH,
  EMAIL_SMTP_VERIFY_PATH,
  EMAIL_SMTP_DISCONNECT_PATH,
  EMAIL_IMAP_VERIFY_PATH,
  SMTP_IDENTITY_REGISTER_ENABLED_ENV: smtpSecretContract.SMTP_IDENTITY_REGISTER_ENABLED_ENV,
  isSunsetEmailSmtpIdentityRegisterEnabled:
    smtpSecretContract.isSunsetEmailSmtpIdentityRegisterEnabled,
  isSunsetEmailImapVerifyEnabled: imapSecretContract.isSunsetEmailImapVerifyEnabled,
  SUNSET_CLIENT_SLUG,
  DISCONNECT_ENABLED_ENV,
  PHASE_B_REAUTH_START_ENABLED_ENV,
  PHASE_B_REAUTH_ELIGIBILITY_MAX_ENDPOINTS,
  SQL_PHASE_B_REAUTH_ELIGIBILITY_FACTS,
  SQL_MICROSOFT_ENDPOINT_LAST_SYNC,
  ATOMIC_ELIGIBILITY_OWN_KEYS,
  isSunsetEmailSettingsUiEnabled,
  isSunsetEmailOAuthStartEnabled,
  isSunsetEmailGoogleOAuthStartEnabled,
  isPhaseBReauthSettingsActionEnabled,
  isDisconnectSettingsActionEnabled,
  isEligibleDisconnectEndpoint,
  isEligibleRegisteredEndpointRemove,
  isEligibleUnverifiedDelegatedEndpoint,
  isEligibleMicrosoftEndpoint,
  isEligibleGmailEndpoint,
  isEligiblePhaseBReauthorizeEndpoint,
  snapshotPhaseBReauthGrantFact,
  grantFactFromAtomicEligibilityRow,
  publicGrantFromAtomicEligibilityRow,
  endpointRowFromAtomicEligibility,
  normalizeAtomicEligibilityRow,
  normalizeLastSyncIso,
  indexAtomicEligibilityRows,
  loadPhaseBReauthEligibilityFacts,
  loadMicrosoftEndpointLastSyncMap,
  computeEmailSettingsActions,
  computeProviderEmailSettingsActions,
  publicState,
  endpointDto,
  createEmailSettingsRoutes,
};
