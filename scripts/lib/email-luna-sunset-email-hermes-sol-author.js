'use strict';

/**
 * MAIL-MVP-007 — Hermes Sol closed-plan author for Sunset email drafts.
 *
 * Reuses FIX-3 parse/render/compile. Never falls back to 4o-mini.
 * Unavailable → FIX-3 deterministic compile. Timeout/malformed/provenance
 * mismatch fail closed.
 */

const util = require('node:util');
const {
  createEmailLunaCreateDraftNaturalAuthor,
  compileCreateDraftNaturalPlanJson,
} = require('./email-luna-create-draft-natural-author');
const { createEmailLunaDraftAuthor } = require('./email-luna-draft-author');
const {
  createEmailLunaSunsetEmailHermesSolClient,
} = require('./email-luna-sunset-email-hermes-sol-client');

const isProxy = util.types.isProxy.bind(undefined);
const freeze = Object.freeze;
const ownData = (value, key) => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable
      && !descriptor.get && !descriptor.set
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
};

function parseCanonicalUser(prompt) {
  const user = prompt && typeof prompt.user === 'string' ? prompt.user : '';
  const match = /BEGIN CANONICAL JSON DATA\n([\s\S]*?)\nEND CANONICAL JSON DATA/.exec(user);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function createHermesNaturalCallModel(client, authority) {
  return async function hermesNaturalCallModel(prompt) {
    const payload = parseCanonicalUser(prompt);
    if (!payload || typeof payload !== 'object' || isProxy(payload)) {
      throw new Error('malformed');
    }
    const goalsBox = payload.private_staff_goals;
    const goals = goalsBox && typeof goalsBox.goals === 'string' ? goalsBox.goals : '';
    const result = await client.requestNaturalPlan({
      authority,
      untrusted_email: payload.untrusted_email,
      language: payload.language,
      goals,
    });
    if (!result || result.status === 'unavailable') return null;
    if (result.status !== 'ok' || typeof result.planJson !== 'string') {
      const error = new Error(result && result.reason ? result.reason : 'hermes_rejected');
      if (result && result.reason === 'timeout') error.code = 'EMAIL_LUNA_AUTHOR_TIMEOUT';
      throw error;
    }
    hermesNaturalCallModel.lastMarker = result.marker;
    if (result.authenticity && result.authenticity.hmac_verified === true
        && typeof result.authenticity.request_id === 'string') {
      hermesNaturalCallModel.lastAuthenticity = result.authenticity;
    }
    return result.planJson;
  };
}

function createHermesTemplateCallModel(client) {
  return async function hermesTemplateCallModel(prompt) {
    const payload = parseCanonicalUser(prompt);
    if (!payload || typeof payload !== 'object' || isProxy(payload)) {
      throw new Error('malformed');
    }
    const result = await client.requestTemplatePlan({
      authority: payload.authority,
      untrusted_email: payload.untrusted_email,
      language: ownData(payload, 'language') || (payload.authority && payload.authority.language),
      goals: '',
    });
    if (!result || result.status === 'unavailable') return null;
    if (result.status !== 'ok' || typeof result.planJson !== 'string') {
      const error = new Error(result && result.reason ? result.reason : 'hermes_rejected');
      if (result && result.reason === 'timeout') error.code = 'EMAIL_LUNA_AUTHOR_TIMEOUT';
      throw error;
    }
    return result.planJson;
  };
}

function createEmailLunaSunsetEmailHermesSolAuthors(configuration) {
  const client = configuration && configuration.client
    ? configuration.client
    : createEmailLunaSunsetEmailHermesSolClient(configuration);
  if (!client || typeof client.requestNaturalPlan !== 'function'
      || typeof client.requestTemplatePlan !== 'function') {
    throw new Error('email_luna_hermes_sol_author_invalid');
  }
  const templateConfig = { callModel: createHermesTemplateCallModel(client) };
  if (configuration && Number.isSafeInteger(configuration.timeoutMs)) {
    templateConfig.timeoutMs = configuration.timeoutMs;
  }
  const template = createEmailLunaDraftAuthor(templateConfig);

  async function authorNaturalGuestReply(input) {
    const authority = input && input.authority;
    const callModel = createHermesNaturalCallModel(client, authority);
    const naturalConfig = { callModel };
    if (configuration && Number.isSafeInteger(configuration.timeoutMs)) {
      naturalConfig.timeoutMs = configuration.timeoutMs;
    }
    const natural = createEmailLunaCreateDraftNaturalAuthor(naturalConfig);
    const authored = await natural.authorNaturalGuestReply(input);
    if (authored && typeof authored === 'object' && authored.compile_replacement === true) {
      return authored;
    }
    if (authored && typeof authored === 'object' && callModel.lastMarker) {
      const extra = { marker: callModel.lastMarker };
      if (callModel.lastAuthenticity) extra.authenticity = callModel.lastAuthenticity;
      return freeze({ ...authored, ...extra });
    }
    return authored;
  }

  return freeze({
    authorDraft: template.authorDraft,
    authorNaturalGuestReply,
    compileCreateDraftNaturalPlanJson,
  });
}

module.exports = freeze({
  createEmailLunaSunsetEmailHermesSolAuthors,
  parseCanonicalUser,
});
