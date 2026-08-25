'use strict';

/**
 * TEST-ONLY Chapter 4C helpers. Not reachable from Staff API, activation,
 * composition, provider-contract production exports, or the production
 * token-loan package surface. Planted-token Graph HTTP for Chapter 1 mapping
 * tests. Does not mint, refresh, or introspect a live token.
 *
 * @module email-luna-controlled-drafting-token-loan.test-support
 */

const {
  createEmailLunaControlledDraftingGraphDraftHttpConsumer,
} = require('./email-luna-controlled-drafting-graph-draft-transport');

function createTestControlledDraftingGraphDraftTransport(dependencies) {
  const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const factory = { httpsImpl: deps.httpsImpl };
  if (deps.timers !== undefined) factory.timers = deps.timers;
  const consumer = createEmailLunaControlledDraftingGraphDraftHttpConsumer(factory);
  const accessToken = deps.accessToken;
  return Object.freeze({
    createReplyDraft(command) {
      return consumer(accessToken, Object.freeze({
        kind: 'create_reply_draft',
        command,
      }));
    },
    reconcileDraft(command) {
      return consumer(accessToken, Object.freeze({
        kind: 'reconcile_draft',
        command,
      }));
    },
  });
}

module.exports = Object.freeze({
  createTestControlledDraftingGraphDraftTransport,
});
