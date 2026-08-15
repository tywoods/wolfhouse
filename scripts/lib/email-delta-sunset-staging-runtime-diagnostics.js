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
]);

const CODES = Object.freeze([
  'dead_grant',
  'unauthorized',
  'cursor',
  'query',
  'transport',
  'store',
  'unknown',
]);

const EVENT_KEYS = Object.freeze(['event', 'stage', 'code']);
const NOTE_KEYS = Object.freeze(['stage', 'code']);

const STAGE_SET = new Set(STAGES);
const CODE_SET = new Set(CODES);

const GRANT_STATUS_DEAD = 'reauthorization_required';
const GRANT_STATUS_UNAVAILABLE = 'unavailable';
const GRANT_STATUS_UNCERTAIN = 'uncertain';

const PRIORITY = Object.freeze({
  dead_grant: 80,
  unauthorized: 70,
  cursor: 70,
  query: 60,
  store: 50,
  transport: 40,
  unknown: 0,
});

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
    if (status !== 401 && status !== 410) return null;
    if (status === 401) return freezeNote('transport', 'unauthorized');
    return freezeNote('cursor', 'cursor');
  } catch {
    return null;
  }
}

function classifyDeltaRuntimeTransportError(error) {
  try {
    const outcome = readTrustedMessagesDeltaOutcome(error);
    if (outcome === 'cursor_gone') return freezeNote('cursor', 'cursor');
    const graphStage = readTrustedGraphStage(error);
    if (typeof graphStage === 'string') return freezeNote('transport', 'transport');
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
  classifyDeltaRuntimeUnknown,
  buildDeltaRuntimeTickFailedEvent,
  assertSafeDeltaRuntimeTickFailedEvent,
  createDeltaRuntimeDiagnosticSink,
  emitDeltaRuntimeTickFailed,
  readTrustedDeltaRuntimeDiagnostic,
  brandDeltaRuntimeDiagnostic,
});
