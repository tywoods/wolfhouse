'use strict';

/**
 * MAILBRIDGE provider-operation contract.
 *
 * Provider SDKs implement this boundary. Shared authority, custody, cursor,
 * approval and journal layers consume normalized descriptors/results only.
 * This module performs no provider I/O and contains no credentials.
 */

const {
  EMAIL_MAILBOX_PROVIDERS,
  validateEmailMailboxProviderId,
} = require('./email-mailbox-adapter-contract');

const MAILBRIDGE_OUTCOMES = Object.freeze([
  'committed',
  'not_committed',
  'outcome_unknown',
  'reauthorization_required',
  'conflict',
]);
const MAILBRIDGE_OUTBOUND_METHODS = Object.freeze([
  'prepareReply',
  'applyApprovedBody',
  'dispatch',
  'reconcile',
]);
const OUTCOME_SET = new Set(MAILBRIDGE_OUTCOMES);
const OUTBOUND_METHOD_SET = new Set(MAILBRIDGE_OUTBOUND_METHODS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const CURSOR_KEYS = Object.freeze([
  'provider',
  'endpoint_id',
  'provider_mailbox_id',
  'query_version',
  'cursor_kind',
  'opaque_cursor',
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function fail(error) { return Object.freeze({ ok: false, error }); }
function ok(value) { return Object.freeze({ ok: true, value }); }
function hasExactKeys(value, allowed) {
  const keys = Reflect.ownKeys(value);
  return keys.length === allowed.length
    && keys.every((key) => typeof key === 'string' && allowed.includes(key));
}
function boundedString(value, max = 255) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateProviderOutcome(outcome) {
  return OUTCOME_SET.has(outcome) ? ok(outcome) : fail('outcome_invalid');
}

function validateOutboundAdapterDescriptor(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ['provider', 'capabilities', 'methods'])) {
    return fail('outbound_descriptor_invalid');
  }
  const provider = validateEmailMailboxProviderId(input.provider);
  if (!provider.ok || !isPlainObject(input.capabilities)
      || !hasExactKeys(input.capabilities, ['remote_drafts', 'reconcile'])
      || typeof input.capabilities.remote_drafts !== 'boolean'
      || typeof input.capabilities.reconcile !== 'boolean'
      || !isPlainObject(input.methods)) {
    return fail('outbound_descriptor_invalid');
  }
  const methodKeys = Reflect.ownKeys(input.methods);
  if (methodKeys.some((key) => typeof key !== 'string'
      || !OUTBOUND_METHOD_SET.has(key)
      || typeof input.methods[key] !== 'function')) {
    return fail('outbound_methods_invalid');
  }
  if (typeof input.methods.dispatch !== 'function') return fail('dispatch_required');
  if (input.capabilities.remote_drafts) {
    if (typeof input.methods.prepareReply !== 'function'
        || typeof input.methods.applyApprovedBody !== 'function') {
      return fail('remote_draft_methods_required');
    }
  } else if ('prepareReply' in input.methods || 'applyApprovedBody' in input.methods) {
    return fail('remote_draft_methods_forbidden');
  }
  if (input.capabilities.reconcile !== (typeof input.methods.reconcile === 'function')) {
    return fail('reconcile_capability_mismatch');
  }
  const value = Object.freeze({
    provider: provider.value,
    capabilities: Object.freeze({ ...input.capabilities }),
    methods: Object.freeze({ ...input.methods }),
  });
  return ok(value);
}

function validateCursorDescriptor(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, CURSOR_KEYS)) {
    return fail('cursor_descriptor_invalid');
  }
  const provider = validateEmailMailboxProviderId(input.provider);
  if (!provider.ok || !UUID_RE.test(input.endpoint_id)
      || !boundedString(input.provider_mailbox_id)
      || !TOKEN_RE.test(input.query_version)
      || !TOKEN_RE.test(input.cursor_kind)
      || !boundedString(input.opaque_cursor, 4096)) {
    return fail('cursor_descriptor_invalid');
  }
  return ok(Object.freeze({ ...input, provider: provider.value }));
}

function validateRefreshStrategy(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, ['provider', 'refreshGrant'])) {
    return fail('refresh_strategy_invalid');
  }
  const provider = validateEmailMailboxProviderId(input.provider);
  if (!provider.ok || typeof input.refreshGrant !== 'function') {
    return fail('refresh_strategy_invalid');
  }
  return ok(Object.freeze({ provider: provider.value, refreshGrant: input.refreshGrant }));
}

module.exports = Object.freeze({
  MAILBRIDGE_OUTCOMES,
  MAILBRIDGE_OUTBOUND_METHODS,
  validateProviderOutcome,
  validateOutboundAdapterDescriptor,
  validateCursorDescriptor,
  validateRefreshStrategy,
  EMAIL_MAILBOX_PROVIDERS,
});
