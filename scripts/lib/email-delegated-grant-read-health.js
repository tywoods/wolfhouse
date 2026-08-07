'use strict';

/**
 * Delegated grant read-health orchestrator (Sunset staging).
 *
 * Behavior-byte-compatible wrapper over the shared access-session lifecycle
 * (lease → open → MS refresh → reseal → CAS) with a session callback that
 * performs one bounded Graph Mail.ReadBasic /me/messages envelope count.
 *
 * No send, subscriptions, polling, activation, automation, bodies,
 * attachments, or persistence. Public result never includes tokens,
 * addresses, subjects, Graph IDs, or raw errors.
 *
 * @module email-delegated-grant-read-health
 */

const {
  createDelegatedGrantAccessSession,
  SUNSET_DEPLOYMENT: SESSION_SUNSET,
  STATUS_REAUTH: SESSION_STATUS_REAUTH,
  STATUS_UNCERTAIN: SESSION_STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE: SESSION_STATUS_UNAVAILABLE,
} = require('./email-delegated-grant-access-session');
const {
  GRAPH_STAGES,
  readTrustedGraphStage,
} = require('./email-microsoft-graph-delegated-messages-transport');

const FAILURE_CODE = 'delegated_grant_read_health_failed';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-read-health';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPENDENCY_KEYS = Object.freeze([
  'deployment',
  'applicationClientId',
  'client',
  'envelopeProvider',
  'secretProvider',
  'transport',
  'graphMessages',
]);
const GRAPH_STAGE_SET = new Set(GRAPH_STAGES);

const STATUS_HEALTHY = 'healthy';
const STATUS_REAUTH = 'reauthorization_required';
const STATUS_UNCERTAIN = 'uncertain';
const STATUS_UNAVAILABLE = 'unavailable';

if (SESSION_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('read_health_sunset_deployment_mismatch');
}
if (SESSION_STATUS_REAUTH !== STATUS_REAUTH
    || SESSION_STATUS_UNCERTAIN !== STATUS_UNCERTAIN
    || SESSION_STATUS_UNAVAILABLE !== STATUS_UNAVAILABLE) {
  throw new Error('read_health_session_status_mismatch');
}

function failure() {
  const error = new Error(FAILURE_CODE);
  error.code = FAILURE_CODE;
  return error;
}

function ownData(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function exactPlainData(object, keys) {
  if (!object || Object.getPrototypeOf(object) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && !descriptor.get && !descriptor.set;
  });
}

function exactGraphMessages(object) {
  return object && Object.isFrozen(object)
    && Object.getPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['listMessageEnvelopeCount'])
    && typeof ownData(object, 'listMessageEnvelopeCount') === 'function';
}

function snapshotIds(input) {
  if (!exactPlainData(input, ['clientId', 'endpointId'])) return null;
  const clientId = ownData(input, 'clientId');
  const endpointId = ownData(input, 'endpointId');
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) return null;
  if (typeof endpointId !== 'string' || !UUID_RE.test(endpointId)) return null;
  return Object.freeze({
    clientId: clientId.trim().toLowerCase(),
    endpointId: endpointId.trim().toLowerCase(),
  });
}

function sanitizeGraphStage(stage) {
  if (stage == null) return null;
  if (typeof stage === 'string' && GRAPH_STAGE_SET.has(stage)) return stage;
  return null;
}

function publicResult({
  status,
  grantGeneration,
  graphReachable,
  messageCountBounded,
  graphStage,
}) {
  return Object.freeze({
    status: String(status),
    grant_generation: grantGeneration == null ? null : Number(grantGeneration),
    graph_reachable: graphReachable === true,
    message_count_bounded: messageCountBounded == null ? null : Number(messageCountBounded),
    graph_stage: sanitizeGraphStage(graphStage),
  });
}

function early(status, grantGeneration) {
  return publicResult({
    status,
    grantGeneration,
    graphReachable: false,
    messageCountBounded: null,
    graphStage: null,
  });
}

function createDelegatedGrantReadHealthService(deps) {
  let graphMessages;
  let listMessageEnvelopeCount;
  let session;
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) throw failure();
    const applicationClientId = ownData(deps, 'applicationClientId');
    const client = ownData(deps, 'client');
    const envelopeProvider = ownData(deps, 'envelopeProvider');
    const secretProvider = ownData(deps, 'secretProvider');
    const transport = ownData(deps, 'transport');
    graphMessages = ownData(deps, 'graphMessages');
    if (typeof applicationClientId !== 'string' || !UUID_RE.test(applicationClientId)) {
      throw failure();
    }
    if (!exactGraphMessages(graphMessages)) throw failure();
    listMessageEnvelopeCount = ownData(graphMessages, 'listMessageEnvelopeCount');

    // Shared access-session owns lease→open→refresh→reseal→CAS. Worker id
    // preserved for exact lease ownership continuity with prior read-health.
    session = createDelegatedGrantAccessSession(Object.freeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId,
      client,
      envelopeProvider,
      secretProvider,
      transport,
      workerId: WORKER_ID,
    }));
  } catch (err) {
    if (err && err.code === FAILURE_CODE) throw err;
    throw failure();
  }

  let used = false;

  async function runReadHealth(input) {
    if (used) throw failure();
    used = true;
    const ids = snapshotIds(input);
    if (!ids) throw failure();

    try {
      const sessionOut = await session.runWithAccessTokenOnce(
        ids,
        async (loan) => {
          // Unchanged count transport: mutable input owns the token until finally.
          let graphInput = null;
          try {
            const accessToken = loan && typeof loan.accessToken === 'string'
              ? loan.accessToken
              : null;
            if (typeof accessToken !== 'string' || !accessToken) {
              return Object.freeze({
                kind: 'soft_fail',
              });
            }
            graphInput = { accessToken };
            try { loan.accessToken = null; } catch { /* */ }

            const graphResult = await Reflect.apply(
              listMessageEnvelopeCount,
              graphMessages,
              [graphInput],
            );
            if (!graphResult || !Object.isFrozen(graphResult)
                || Object.getPrototypeOf(graphResult) !== Object.prototype
                || Reflect.ownKeys(graphResult).length !== 2
                || typeof ownData(graphResult, 'message_count_bounded') !== 'number'
                || !Number.isInteger(graphResult.message_count_bounded)
                || graphResult.message_count_bounded < 0
                || graphResult.message_count_bounded > 5
                || ownData(graphResult, 'graph_stage') !== 'success') {
              return Object.freeze({ kind: 'soft_fail' });
            }
            return Object.freeze({
              kind: 'healthy',
              message_count_bounded: graphResult.message_count_bounded,
            });
          } catch (graphErr) {
            return Object.freeze({
              kind: 'graph_err',
              graph_stage: readTrustedGraphStage(graphErr),
            });
          } finally {
            if (graphInput) {
              try { graphInput.accessToken = null; } catch { /* */ }
              graphInput = null;
            }
            if (loan) {
              try { loan.accessToken = null; } catch { /* */ }
            }
          }
        },
      );

      if (!sessionOut || sessionOut.ok !== true) {
        const status = sessionOut && typeof sessionOut.status === 'string'
          ? sessionOut.status
          : STATUS_UNCERTAIN;
        const gen = sessionOut ? sessionOut.grant_generation : null;
        if (status === STATUS_REAUTH
            || status === STATUS_UNAVAILABLE
            || status === STATUS_UNCERTAIN) {
          return early(status, gen);
        }
        return early(STATUS_UNCERTAIN, gen);
      }

      const grantGeneration = sessionOut.grant_generation;
      const graphOutcome = sessionOut.value;
      if (!graphOutcome || typeof graphOutcome !== 'object') {
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration,
          graphReachable: false,
          messageCountBounded: null,
          graphStage: null,
        });
      }

      if (graphOutcome.kind === 'healthy') {
        return publicResult({
          status: STATUS_HEALTHY,
          grantGeneration,
          graphReachable: true,
          messageCountBounded: graphOutcome.message_count_bounded,
          graphStage: 'success',
        });
      }

      if (graphOutcome.kind === 'graph_err') {
        return publicResult({
          status: STATUS_UNCERTAIN,
          grantGeneration,
          graphReachable: false,
          messageCountBounded: null,
          graphStage: graphOutcome.graph_stage,
        });
      }

      // soft_fail and any other post-CAS graph shape → uncertain, no stage.
      return publicResult({
        status: STATUS_UNCERTAIN,
        grantGeneration,
        graphReachable: false,
        messageCountBounded: null,
        graphStage: null,
      });
    } catch (err) {
      if (err && err.code === FAILURE_CODE) throw err;
      throw failure();
    }
  }

  return Object.freeze({ runReadHealth });
}

module.exports = Object.freeze({
  FAILURE_CODE,
  SUNSET_DEPLOYMENT,
  WORKER_ID,
  DEPENDENCY_KEYS,
  STATUS_HEALTHY,
  STATUS_REAUTH,
  STATUS_UNCERTAIN,
  STATUS_UNAVAILABLE,
  GRAPH_STAGES,
  createDelegatedGrantReadHealthService,
});
