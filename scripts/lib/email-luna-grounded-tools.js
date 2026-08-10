'use strict';

const MISSING_FACT = 'missing_fact';
const HANDOFF_REQUIRED = 'handoff_required';

const FACT_FIELDS = Object.freeze({
  catalog: Object.freeze(['item', 'label', 'currency', 'amount_cents', 'active']),
  availability: Object.freeze(['item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: Object.freeze(['label', 'policy_key', 'policy_text']),
  booking: Object.freeze(['label', 'booking_code', 'booking_status', 'check_in', 'check_out', 'guest_count']),
  payment: Object.freeze(['label', 'currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents']),
});
const COMMON_FIELDS = Object.freeze(['type', 'fact', 'status', 'reason', 'client_id', 'location_id']);
const AUTHORITY_KEYS = new Set([
  'authority', 'serverauthority', 'scope', 'clientscope', 'locationscope',
  'client', 'clientid', 'clientslug', 'tenant', 'tenantid', 'tenantslug',
  'location', 'locationid', 'locationslug',
]);

function normalizedKey(key) {
  return String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function containsAuthorityOverride(value, seen = new Set()) {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (AUTHORITY_KEYS.has(normalizedKey(key))) return true;
    if (containsAuthorityOverride(value[key], seen)) return true;
  }
  return false;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function typed(type, fact, reason, authority) {
  return {
    type,
    fact,
    status: type,
    ...(reason ? { reason } : {}),
    client_id: authority.client_id,
    location_id: authority.location_id,
  };
}

function sanitizeRow(row, fact, authority) {
  if (!isPlainRecord(row)) return { kind: MISSING_FACT };
  if (row.fact !== fact || row.status !== 'found') return { kind: MISSING_FACT };
  if (row.client_id !== authority.client_id || row.location_id !== authority.location_id) {
    return { kind: HANDOFF_REQUIRED };
  }

  const allowed = new Set([...COMMON_FIELDS, ...FACT_FIELDS[fact]]);
  const clean = {};
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    if (!safeScalar(row[key])) return { kind: MISSING_FACT };
    clean[key] = row[key];
  }
  return { kind: 'found', value: clean };
}

function normalizeOwnerResult(result) {
  if (Array.isArray(result)) return { rows: result, shape: 'array' };
  if (isPlainRecord(result) && Array.isArray(result.rows)) return { rows: result.rows, shape: 'rows' };
  return { rows: [result], shape: 'single' };
}

function createEmailLunaGroundedTools({ authority, queryOwners } = {}) {
  if (!isPlainRecord(authority)
      || typeof authority.client_id !== 'string' || !authority.client_id.trim()
      || typeof authority.location_id !== 'string' || !authority.location_id.trim()
      || !isPlainRecord(queryOwners)) {
    throw new TypeError('invalid_grounded_tools_configuration');
  }

  const pinnedAuthority = Object.freeze({
    client_id: authority.client_id,
    location_id: authority.location_id,
  });

  async function query(fact, args = {}) {
    const factName = typeof fact === 'string' ? fact : 'unknown_fact';
    if (!isPlainRecord(args)) throw new TypeError('invalid_query_arguments');
    if (containsAuthorityOverride(args)) throw new Error('authority_override_rejected');
    if (!Object.prototype.hasOwnProperty.call(FACT_FIELDS, factName)
        || typeof queryOwners[factName] !== 'function') {
      return typed(MISSING_FACT, factName, 'unknown_fact', pinnedAuthority);
    }

    let raw;
    try {
      raw = await queryOwners[factName](pinnedAuthority, args);
    } catch (_) {
      return typed(HANDOFF_REQUIRED, factName, 'tool_error', pinnedAuthority);
    }

    const normalized = normalizeOwnerResult(raw);
    if (!normalized.rows.length) return typed(MISSING_FACT, factName, 'not_found', pinnedAuthority);
    const values = [];
    for (const row of normalized.rows) {
      const checked = sanitizeRow(row, factName, pinnedAuthority);
      if (checked.kind === HANDOFF_REQUIRED) {
        return typed(HANDOFF_REQUIRED, factName, 'authority_mismatch', pinnedAuthority);
      }
      if (checked.kind === MISSING_FACT) {
        return typed(MISSING_FACT, factName, 'malformed_fact', pinnedAuthority);
      }
      values.push(checked.value);
    }
    if (normalized.shape === 'array') return values;
    if (normalized.shape === 'rows') return { rows: values };
    return values[0];
  }

  return Object.freeze({ authority: pinnedAuthority, query });
}

module.exports = { createEmailLunaGroundedTools, MISSING_FACT, HANDOFF_REQUIRED };
