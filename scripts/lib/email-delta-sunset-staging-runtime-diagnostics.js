'use strict';

/**
 * Bounded Sunset delta poller/runtime diagnostic telemetry.
 *
 * Logs only a closed-enum stage + sanitized closed-enum code at the
 * scheduler/runtime tick boundary. Never logs tokens, URLs/cursors,
 * Graph bodies, mailbox/message IDs, email addresses, subjects, headers,
 * secrets, exception messages/stacks, or arbitrary provider payloads.
 *
 * Exact event schema:
 *   { event: 'email_delta_runtime_tick_failed', stage: <allowlisted>, code: <allowlisted> }
 *
 * @module email-delta-sunset-staging-runtime-diagnostics
 */

const {
  readTrustedGraphStage,
  readTrustedGraphRowValueFieldClass,
  readTrustedGraphRowValueBranchClass,
  readTrustedMessagesDeltaOutcome,
} = require('./email-microsoft-graph-messages-delta-page-transport');

const EVENT_NAME = 'email_delta_runtime_tick_failed';

const STAGES = Object.freeze([
  'schema',
  'query',
  'grant',
  'cursor',
  'transport',
  'store',
  'page',
  'project',
  'tick',
  'authority',
  'status',
  'lease',
  'seal',
  'release',
]);

const CODES = Object.freeze([
  'dead_grant',
  'unauthorized',
  'cursor',
  'query',
  'transport',
  'store',
  'unknown',
  'authority',
  'status',
  'lease',
  'grant',
  'seal',
  'release',
  'open',
  'secret',
  'token',
  'response',
  'reseal',
  'commit',
  'bad_request',
  'forbidden',
  'not_found',
  'timeout',
  'throttled',
  'server_error',
  'request_error',
  'response_surface_invalid',
  'http_status_not_200',
  'content_type_invalid',
  'stream_invalid',
  'stream_aborted',
  'response_too_large',
  'utf8_invalid',
  'json_invalid',
  'top_shape_invalid',
  'row_keyset_invalid',
  'row_value_invalid',
  'row_value_id',
  'row_value_from',
  'row_value_received_time',
  'row_value_read_state',
  'row_value_conversation',
  'row_value_internet_message_id',
  'row_value_etag',
  'row_branch_subject_metadata',
  'row_branch_odata_unrecognized_type',
  'row_branch_odata_invalid_metadata',
  'row_branch_duplicate_message_identity',
  'row_branch_tombstone_envelope_collision',
  'row_branch_invariant_mapper_shape',
]);

const EVENT_KEYS = Object.freeze(['event', 'stage', 'code']);
const NOTE_KEYS = Object.freeze(['stage', 'code']);

const STAGE_SET = new Set(STAGES);
const CODE_SET = new Set(CODES);
const GRAPH_FAILURE_STAGE_SET = new Set([
  'request_error',
  'timeout',
  'response_surface_invalid',
  'http_status_not_200',
  'content_type_invalid',
  'stream_invalid',
  'stream_aborted',
  'response_too_large',
  'utf8_invalid',
  'json_invalid',
  'top_shape_invalid',
  'row_keyset_invalid',
  'row_value_invalid',
]);

const GRAPH_ROW_VALUE_FIELD_CODES = Object.freeze({
  id: 'row_value_id',
  from: 'row_value_from',
  received_time: 'row_value_received_time',
  read_state: 'row_value_read_state',
  conversation: 'row_value_conversation',
  internet_message_id: 'row_value_internet_message_id',
  etag: 'row_value_etag',
});

const GRAPH_ROW_VALUE_BRANCH_CODES = Object.freeze({
  subject_metadata: 'row_branch_subject_metadata',
  odata_unrecognized_type: 'row_branch_odata_unrecognized_type',
  odata_invalid_metadata: 'row_branch_odata_invalid_metadata',
  duplicate_message_identity: 'row_branch_duplicate_message_identity',
  tombstone_envelope_collision: 'row_branch_tombstone_envelope_collision',
  invariant_mapper_shape: 'row_branch_invariant_mapper_shape',
});

const GRANT_STATUS_DEAD = 'reauthorization_required';
const GRANT_STATUS_UNAVAILABLE = 'unavailable';
const GRANT_STATUS_UNCERTAIN = 'uncertain';

const PRIORITY = Object.freeze({
  dead_grant: 80,
  unauthorized: 70,
  cursor: 70,
  bad_request: 70,
  forbidden: 70,
  not_found: 70,
  timeout: 70,
  throttled: 70,
  server_error: 70,
  request_error: 65,
  response_surface_invalid: 65,
  http_status_not_200: 65,
  content_type_invalid: 65,
  stream_invalid: 65,
  stream_aborted: 65,
  response_too_large: 65,
  utf8_invalid: 65,
  json_invalid: 65,
  top_shape_invalid: 65,
  row_keyset_invalid: 65,
  row_value_invalid: 65,
  row_value_id: 66,
  row_value_from: 66,
  row_value_received_time: 66,
  row_value_read_state: 66,
  row_value_conversation: 66,
  row_value_internet_message_id: 66,
  row_value_etag: 66,
  row_branch_subject_metadata: 66,
  row_branch_odata_unrecognized_type: 66,
  row_branch_odata_invalid_metadata: 66,
  row_branch_duplicate_message_identity: 66,
  row_branch_tombstone_envelope_collision: 66,
  row_branch_invariant_mapper_shape: 66,
  query: 60,
  authority: 50,
  status: 55,
  lease: 55,
  grant: 50,
  seal: 50,
  store: 50,
  release: 55,
  open: 55,
  secret: 55,
  token: 55,
  response: 55,
  reseal: 55,
  commit: 55,
  transport: 40,
  unknown: 0,
});

const GRANT_SESSION_INTERNAL_STAGES = Object.freeze([
  'status',
  'lease',
  'open',
  'secret',
  'token',
  'response',
  'dead_grant',
  'reseal',
  'commit',
  'release',
]);
const GRANT_SESSION_INTERNAL_STAGE_SET = new Set(GRANT_SESSION_INTERNAL_STAGES);

const PAGE_INTERNAL_STAGES = Object.freeze([
  'authority',
  'status',
  'lease',
  'grant',
  'transport',
  'seal',
  'store',
  'release',
]);
const INTERNAL_PAGE_STAGE_SET = new Set(PAGE_INTERNAL_STAGES);

const BRANDED = new WeakMap();

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor
      && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      && !descriptor.get
      && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  try {
    if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(object);
    if (actual.length !== keys.length
        || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return Boolean(
        descriptor
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && descriptor.enumerable
        && !descriptor.get
        && !descriptor.set,
      );
    });
  } catch {
    return false;
  }
}

function freezeNote(stage, code) {
  if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
  if (typeof code !== 'string' || !CODE_SET.has(code)) return null;
  const note = { stage, code };
  if (!exactPlainData(note, NOTE_KEYS)) return null;
  return Object.freeze(note);
}

function classifyDeltaRuntimeGrantStatus(status) {
  try {
    if (typeof status !== 'string') return null;
    if (status === GRANT_STATUS_DEAD) return freezeNote('grant', 'dead_grant');
    if (status === GRANT_STATUS_UNAVAILABLE || status === GRANT_STATUS_UNCERTAIN) {
      return freezeNote('grant', 'unknown');
    }
    return null;
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeHttpStatus(status) {
  try {
    if (!Number.isInteger(status)) return null;
    if (status === 400) return freezeNote('transport', 'bad_request');
    if (status === 401) return freezeNote('transport', 'unauthorized');
    if (status === 403) return freezeNote('transport', 'forbidden');
    if (status === 404) return freezeNote('transport', 'not_found');
    if (status === 408) return freezeNote('transport', 'timeout');
    if (status === 410) return freezeNote('cursor', 'cursor');
    if (status === 429) return freezeNote('transport', 'throttled');
    if (status >= 500 && status <= 599) return freezeNote('transport', 'server_error');
    return null;
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeTransportError(error) {
  try {
    const outcome = readTrustedMessagesDeltaOutcome(error);
    if (outcome === 'cursor_gone') return freezeNote('cursor', 'cursor');
    const graphStage = readTrustedGraphStage(error);
    if (graphStage === 'timeout') return freezeNote('transport', 'timeout');
    if (graphStage === 'row_value_invalid'
        && typeof readTrustedGraphRowValueFieldClass === 'function') {
      const fieldClass = readTrustedGraphRowValueFieldClass(error);
      const code = ownData(GRAPH_ROW_VALUE_FIELD_CODES, fieldClass);
      if (typeof code === 'string' && CODE_SET.has(code)) return freezeNote('transport', code);
    }
    if (graphStage === 'row_value_invalid'
        && typeof readTrustedGraphRowValueBranchClass === 'function') {
      const branchClass = readTrustedGraphRowValueBranchClass(error);
      const branchCode = ownData(GRAPH_ROW_VALUE_BRANCH_CODES, branchClass);
      if (typeof branchCode === 'string') return freezeNote('transport', branchCode);
    }
    if (GRAPH_FAILURE_STAGE_SET.has(graphStage)) {
      return freezeNote('transport', graphStage);
    }
    return null;
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeQueryFailure() {
  return freezeNote('query', 'query');
}

function classifyDeltaRuntimePageFailure() {
  return freezeNote('store', 'store');
}

function classifyDeltaRuntimePageInternalStage(stage) {
  try {
    if (typeof stage !== 'string' || !INTERNAL_PAGE_STAGE_SET.has(stage)) return null;
    if (!STAGE_SET.has(stage) || !CODE_SET.has(stage)) return null;
    return freezeNote(stage, stage);
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeGrantSessionInternalStage(stage) {
  try {
    if (typeof stage !== 'string' || !GRANT_SESSION_INTERNAL_STAGE_SET.has(stage)) return null;
    if (stage === 'dead_grant') return freezeNote('grant', 'dead_grant');
    if (!CODE_SET.has(stage)) return null;
    return freezeNote('grant', stage);
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeUnknown() {
  return freezeNote('tick', 'unknown');
}

function buildDeltaRuntimeTickFailedEvent(fields) {
  try {
    if (!fields || typeof fields !== 'object') return null;
    const stage = ownData(fields, 'stage');
    const code = ownData(fields, 'code');
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
    if (typeof code !== 'string' || !CODE_SET.has(code)) return null;
    const record = {
      event: EVENT_NAME,
      stage,
      code,
    };
    if (!exactPlainData(record, EVENT_KEYS)) return null;
    return Object.freeze(record);
  } catch {
    return null;
  }
}

function assertSafeDeltaRuntimeTickFailedEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, detail: 'event_not_object' };
  }
  if (event.event !== EVENT_NAME) return { ok: false, detail: 'bad_event_name' };
  let keys;
  try {
    keys = Reflect.ownKeys(event);
  } catch {
    return { ok: false, detail: 'own_keys_failed' };
  }
  if (keys.length !== EVENT_KEYS.length) return { ok: false, detail: 'bad_key_count' };
  for (let i = 0; i < EVENT_KEYS.length; i += 1) {
    if (keys[i] !== EVENT_KEYS[i]) {
      return { ok: false, detail: `bad_key_order:${String(keys[i])}` };
    }
  }
  if (typeof event.stage !== 'string' || !STAGE_SET.has(event.stage)) {
    return { ok: false, detail: 'bad_stage' };
  }
  if (typeof event.code !== 'string' || !CODE_SET.has(event.code)) {
    return { ok: false, detail: 'bad_code' };
  }
  return { ok: true };
}

function notePriority(note) {
  if (!note || typeof note.code !== 'string') return -1;
  const value = PRIORITY[note.code];
  return Number.isInteger(value) ? value : -1;
}

function defaultDeltaRuntimeDiagnosticLogger(record) {
  console.error(JSON.stringify(record));
}

function emitDeltaRuntimeTickFailed(fields, logger) {
  try {
    const record = buildDeltaRuntimeTickFailedEvent(fields);
    if (!record) return;
    const log = typeof logger === 'function' ? logger : defaultDeltaRuntimeDiagnosticLogger;
    try {
      log(record);
    } catch {
      // Logger failure must never alter poller control flow.
    }
  } catch {
    // Emit is always fail-open for the tick path.
  }
}

function brandDeltaRuntimeDiagnostic(error, stage, code) {
  try {
    const note = freezeNote(stage, code);
    if (!note || error == null || (typeof error !== 'object' && typeof error !== 'function')) {
      return error;
    }
    BRANDED.set(error, note);
    return error;
  } catch {
    return error;
  }
}

function readTrustedDeltaRuntimeDiagnostic(error) {
  try {
    if (error == null || (typeof error !== 'object' && typeof error !== 'function')) {
      return null;
    }
    const note = BRANDED.get(error);
    if (!note) return null;
    return freezeNote(note.stage, note.code);
  } catch {
    return null;
  }
}

function createDeltaRuntimeDiagnosticSink(deps) {
  let logger = defaultDeltaRuntimeDiagnosticLogger;
  try {
    if (deps && typeof deps === 'object' && typeof ownData(deps, 'logger') === 'function') {
      logger = ownData(deps, 'logger');
    }
  } catch {
    logger = defaultDeltaRuntimeDiagnosticLogger;
  }

  let note = null;

  function record(next) {
    try {
      if (!next || typeof next.stage !== 'string' || typeof next.code !== 'string') return;
      const frozen = freezeNote(next.stage, next.code);
      if (!frozen) return;
      if (!note || notePriority(frozen) >= notePriority(note)) {
        note = frozen;
      }
    } catch {
      // ignore
    }
  }

  function snapshot() {
    return note || classifyDeltaRuntimeUnknown();
  }

  return Object.freeze({
    reset() {
      note = null;
    },
    snapshot,
    recordFromGrantStatus(status) {
      record(classifyDeltaRuntimeGrantStatus(status));
    },
    recordFromHttpStatus(status) {
      record(classifyDeltaRuntimeHttpStatus(status));
    },
    recordFromTransportError(error) {
      record(classifyDeltaRuntimeTransportError(error));
    },
    recordFromTransportBoundaryFailure() {
      record(freezeNote('transport', 'transport'));
    },
    recordFromQueryFailure() {
      record(classifyDeltaRuntimeQueryFailure());
    },
    recordFromPageFailure() {
      record(classifyDeltaRuntimePageFailure());
    },
    recordFromPageInternalStage(stage) {
      record(classifyDeltaRuntimePageInternalStage(stage));
    },
    recordFromGrantSessionInternalStage(stage) {
      record(classifyDeltaRuntimeGrantSessionInternalStage(stage));
    },
    recordFromTrustedGrantSessionResult(result, readTrusted) {
      try {
        const reader = typeof readTrusted === 'function' ? readTrusted : null;
        const internal = reader ? reader(result) : null;
        if (internal && typeof internal.stage === 'string') {
          record(classifyDeltaRuntimeGrantSessionInternalStage(internal.stage));
        }
      } catch {
        // ignore
      }
    },
    recordFromTrustedPageResult(result, readTrusted) {
      try {
        const reader = typeof readTrusted === 'function'
          ? readTrusted
          : null;
        const internal = reader ? reader(result) : null;
        if (internal && typeof internal.stage === 'string') {
          record(classifyDeltaRuntimePageInternalStage(internal.stage));
          return;
        }
      } catch {
        // ignore
      }
      if (note == null) {
        record(classifyDeltaRuntimePageFailure());
      }
    },
    recordFromSchemaFailure() {
      record(freezeNote('schema', 'unknown'));
    },
    recordFromThrown(error) {
      record(readTrustedDeltaRuntimeDiagnostic(error));
      try {
        const code = error && ownData(error, 'code');
        if (code === 'email_delta_activation_boundary_unavailable') {
          record(classifyDeltaRuntimeQueryFailure());
        }
      } catch {
        // ignore
      }
    },
    emitFailure() {
      emitDeltaRuntimeTickFailed(snapshot(), logger);
    },
  });
}

module.exports = Object.freeze({
  EVENT_NAME,
  STAGES,
  CODES,
  EVENT_KEYS,
  classifyDeltaRuntimeGrantStatus,
  classifyDeltaRuntimeHttpStatus,
  classifyDeltaRuntimeTransportError,
  classifyDeltaRuntimeQueryFailure,
  classifyDeltaRuntimePageFailure,
  classifyDeltaRuntimePageInternalStage,
  classifyDeltaRuntimeGrantSessionInternalStage,
  classifyDeltaRuntimeUnknown,
  buildDeltaRuntimeTickFailedEvent,
  assertSafeDeltaRuntimeTickFailedEvent,
  createDeltaRuntimeDiagnosticSink,
  emitDeltaRuntimeTickFailed,
  readTrustedDeltaRuntimeDiagnostic,
  brandDeltaRuntimeDiagnostic,
});
