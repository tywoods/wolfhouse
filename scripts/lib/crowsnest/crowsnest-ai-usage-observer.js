'use strict';

/**
 * Crowsnest AI usage source observer helper (Slice 4).
 * Pure, write-free bridge from technical provider snapshots → adapter → injected sink.
 *
 * Trusted identity (client_slug, tenant_id) must be supplied as explicit own-data
 * properties. Never inferred from env, observation payloads, or prototypes.
 * Accessors are never invoked. No persistence / network / storage.
 * Injected onEvent failures (sync throws and returned thenable/Promise
 * rejections) are isolated without awaiting the sink.
 */

const {
  adaptCrowsnestAiUsageSuccess,
  adaptCrowsnestAiUsageFailure,
} = require('./crowsnest-ai-usage-adapter');

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const SECRET_VALUE_RES = Object.freeze([
  /^sk-[A-Za-z0-9]{10,}/,
  /^sk-ant-[A-Za-z0-9_-]{10,}/,
  /^Bearer\s+/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
]);

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readOwnDataProperty(obj, key) {
  if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function')) {
    return { found: false };
  }
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  if (!desc) {
    return { found: false };
  }
  if ('get' in desc || 'set' in desc) {
    return { found: true, accessor: true };
  }
  return { found: true, accessor: false, value: desc.value };
}

function requireOwnDataValue(obj, key) {
  const read = readOwnDataProperty(obj, key);
  if (!read.found) {
    return { ok: false, missing: true };
  }
  if (read.accessor) {
    return { ok: false, accessor: true };
  }
  return { ok: true, value: read.value };
}

function isSafeNonNegInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeString(value, pattern) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  if (value !== value.trim()) return false;
  if (!(pattern || SAFE_ID_RE).test(value)) return false;
  for (const re of SECRET_VALUE_RES) {
    if (re.test(value)) return false;
  }
  return true;
}

function fail(errors) {
  return { ok: false, errors: errors.slice() };
}

function safeInvokeOnEvent(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    const result = onEvent(event);
    isolateCallbackResult(result);
  } catch (_) {
    /* callback failures isolated */
  }
}

/**
 * Isolate a callback return value that may be a Promise/thenable without awaiting
 * it and without letting hostile `then` accessors escape.
 */
function isolateCallbackResult(result) {
  if (result == null) return;
  const t = typeof result;
  if (t !== 'object' && t !== 'function') return;
  try {
    Promise.resolve(result).then(undefined, () => {});
  } catch (_) {
    /* hostile then / sync adoption failure */
  }
}

/**
 * Emit a Crowsnest AI usage event from a technical observation snapshot.
 *
 * Requires explicit own-data client_slug and tenant_id (separate trusted inputs).
 * Never reads env vars or observation.client_slug / observation.tenant_id.
 *
 * @param {object} input
 * @returns {{ ok: true, event: object } | { ok: false, errors: string[] }}
 */
function emitCrowsnestAiUsageFromObservation(input) {
  const errors = [];
  if (!isPlainObject(input)) {
    return fail(['input: must_be_object']);
  }

  const clientRead = requireOwnDataValue(input, 'client_slug');
  if (!clientRead.ok) {
    errors.push(clientRead.accessor
      ? 'client_slug: must_be_own_data_property'
      : 'client_slug: required_non_empty_string');
  } else if (!assertSafeString(clientRead.value, SAFE_ID_RE)) {
    errors.push('client_slug: unsafe_or_invalid');
  }

  const tenantRead = requireOwnDataValue(input, 'tenant_id');
  if (!tenantRead.ok) {
    errors.push(tenantRead.accessor
      ? 'tenant_id: must_be_own_data_property'
      : 'tenant_id: required_non_empty_string');
  } else if (!assertSafeString(tenantRead.value, SAFE_ID_RE)) {
    errors.push('tenant_id: unsafe_or_invalid');
  }

  const sourceRead = requireOwnDataValue(input, 'source_service');
  if (!sourceRead.ok || !assertSafeString(sourceRead.value, SAFE_LABEL_RE)) {
    errors.push('source_service: required_safe_label');
  }

  const operationRead = requireOwnDataValue(input, 'operation');
  if (!operationRead.ok || !assertSafeString(operationRead.value, SAFE_LABEL_RE)) {
    errors.push('operation: required_safe_label');
  }

  const eventIdRead = requireOwnDataValue(input, 'event_id');
  if (!eventIdRead.ok || !assertSafeString(eventIdRead.value, SAFE_ID_RE)) {
    errors.push('event_id: required_safe_id');
  }

  const occurredRead = requireOwnDataValue(input, 'occurred_at');
  if (!occurredRead.ok
    || typeof occurredRead.value !== 'string'
    || !ISO_UTC_RE.test(occurredRead.value)) {
    errors.push('occurred_at: must_be_utc_iso_z');
  }

  const observationRead = requireOwnDataValue(input, 'observation');
  if (!observationRead.ok) {
    errors.push(observationRead.accessor
      ? 'observation: must_be_own_data_property'
      : 'observation: required');
  } else if (!isPlainObject(observationRead.value)) {
    errors.push('observation: must_be_object');
  }

  const onEventRead = readOwnDataProperty(input, 'onEvent');
  let onEvent = null;
  if (onEventRead.found) {
    if (onEventRead.accessor) {
      errors.push('onEvent: must_be_own_data_property');
    } else if (typeof onEventRead.value === 'function') {
      onEvent = onEventRead.value;
    } else if (onEventRead.value != null) {
      errors.push('onEvent: must_be_function_or_omitted');
    }
  }

  if (errors.length) {
    return fail(errors);
  }

  const observation = observationRead.value;
  const statusRead = requireOwnDataValue(observation, 'status');
  if (!statusRead.ok || (statusRead.value !== 'succeeded' && statusRead.value !== 'failed')) {
    return fail(['observation.status: must_be_succeeded_or_failed']);
  }

  const providerRead = requireOwnDataValue(observation, 'provider');
  if (!providerRead.ok || (providerRead.value !== 'openai' && providerRead.value !== 'anthropic')) {
    return fail(['observation.provider: must_be_openai_or_anthropic']);
  }

  const latencyRead = requireOwnDataValue(observation, 'latency_ms');
  if (!latencyRead.ok || !isSafeNonNegInt(latencyRead.value)) {
    return fail(['observation.latency_ms: must_be_non_negative_integer']);
  }

  const trusted = {
    client_slug: clientRead.value,
    tenant_id: tenantRead.value,
    source_service: sourceRead.value,
    operation: operationRead.value,
    event_id: eventIdRead.value,
    occurred_at: occurredRead.value,
    provider: providerRead.value,
    latency_ms: latencyRead.value,
  };

  let adapted;
  if (statusRead.value === 'succeeded') {
    const responseModelRead = readOwnDataProperty(observation, 'response_model');
    const requestModelRead = readOwnDataProperty(observation, 'request_model');
    let model = null;
    if (responseModelRead.found && !responseModelRead.accessor
      && typeof responseModelRead.value === 'string') {
      model = responseModelRead.value;
    } else if (requestModelRead.found && !requestModelRead.accessor
      && typeof requestModelRead.value === 'string') {
      model = requestModelRead.value;
    }
    if (model == null) {
      return fail(['observation.model: required_for_success']);
    }

    const response = { model };
    const usageRead = readOwnDataProperty(observation, 'usage');
    if (usageRead.found && !usageRead.accessor && isPlainObject(usageRead.value)) {
      response.usage = usageRead.value;
    }

    adapted = adaptCrowsnestAiUsageSuccess({
      ...trusted,
      response,
    });
  } else {
    const errorCodeRead = requireOwnDataValue(observation, 'error_code');
    if (!errorCodeRead.ok || !assertSafeString(errorCodeRead.value, SAFE_ID_RE)) {
      return fail(['observation.error_code: required_safe_opaque']);
    }
    const requestModelRead = readOwnDataProperty(observation, 'request_model');
    const responseModelRead = readOwnDataProperty(observation, 'response_model');
    let model = null;
    if (requestModelRead.found && !requestModelRead.accessor
      && typeof requestModelRead.value === 'string') {
      model = requestModelRead.value;
    } else if (responseModelRead.found && !responseModelRead.accessor
      && typeof responseModelRead.value === 'string') {
      model = responseModelRead.value;
    }
    if (model == null || !assertSafeString(model, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/)) {
      return fail(['observation.model: required_for_failure']);
    }

    adapted = adaptCrowsnestAiUsageFailure({
      ...trusted,
      model,
      error_code: errorCodeRead.value,
    });
  }

  if (!adapted || adapted.ok !== true || !adapted.event) {
    return adapted && adapted.ok === false
      ? fail(adapted.errors || ['adapter: rejected'])
      : fail(['adapter: rejected']);
  }

  safeInvokeOnEvent(onEvent, adapted.event);
  return { ok: true, event: adapted.event };
}

module.exports = {
  emitCrowsnestAiUsageFromObservation,
};
