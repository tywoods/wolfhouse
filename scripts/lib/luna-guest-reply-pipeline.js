'use strict';

/**
 * Luna guest reply pipeline — single owner for final guest copy.
 *
 * Order: composer/router candidate → agent brain (handoff/package repair only)
 *        → Cami author (quote/payment warmth only when composer did not own the turn).
 */

const { runLunaGuestAgentBrain, buildGuestAgentBrainObservability } = require('./luna-guest-agent-brain');
const {
  applyCamiReplyAuthorStage,
  isCamiReplyAuthorEnabled,
} = require('./luna-guest-cami-reply-author');
const {
  shouldSkipCamiAuthor,
} = require('./luna-guest-composer-ownership');
const { isFrontdeskAuthoringBriefLeak } = require('./luna-guest-frontdesk-reply');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * Resolve final guest reply through one pipeline.
 */
async function applyGuestReplyPipeline(args) {
  const a = args || {};
  const env = a.env || process.env;
  const payload = a.payload || {};
  let reply = trimStr(a.candidate_reply);
  let replySource = a.candidate_source || 'router';

  const agent = runLunaGuestAgentBrain({
    client_slug: a.client_slug,
    conversation_id: a.conversation_id,
    guest_phone: a.guest_phone,
    contact_name: a.contact_name,
    message_text: a.message_text,
    prior_guest_context: a.prior_guest_context,
    brain_decision: a.brain_decision,
    composed: a.composed,
    candidate_reply: reply,
    candidate_source: replySource,
    payload,
    channel_mode: a.channel_mode || 'orchestrator_dry_run',
    env,
  });
  const agentTook = agent.agent_brain_enabled === true
    && agent.fallback_used !== true
    && trimStr(agent.final_reply);
  const agentStage = {
    agent,
    reply: agentTook ? agent.final_reply : reply,
    reply_source: agentTook ? 'agent_brain' : replySource,
    observability: buildGuestAgentBrainObservability(agent),
  };

  reply = agentStage.reply;
  replySource = agentStage.reply_source;

  const camiSkip = shouldSkipCamiAuthor({
    composed: a.composed,
    payload,
    env,
    handoff_result: payload.result && payload.result.safe_handoff_required
      ? { handoff_required: true }
      : null,
  });

  let camiStage;
  if (camiSkip.skip || !isCamiReplyAuthorEnabled(env)) {
    camiStage = {
      reply,
      reply_source: replySource,
      author: {
        authored_reply: reply,
        author_used: false,
        rejection_reason: camiSkip.reason || 'author_disabled',
        fallback_used: true,
        safety_notes: camiSkip.skip ? [`pipeline_skip:${camiSkip.reason}`] : ['flag_off'],
      },
      observability: {
        cami_reply_author_enabled: isCamiReplyAuthorEnabled(env),
        cami_author_used: false,
        cami_author_fallback_used: true,
        cami_author_rejection_reason: camiSkip.reason || null,
        cami_author_safety_notes: camiSkip.skip ? [`pipeline_skip:${camiSkip.reason}`] : [],
      },
    };
  } else {
    camiStage = await applyCamiReplyAuthorStage({
      client_slug: a.client_slug,
      conversation_id: a.conversation_id,
      guest_phone: a.guest_phone,
      message_text: a.message_text,
      prior_guest_context: a.prior_guest_context,
      composed: a.composed,
      deterministic_reply: reply,
      deterministic_reply_source: replySource,
      allowed_next_action: a.allowed_next_action,
      payload,
      channel_mode: a.channel_mode || 'orchestrator_dry_run',
      env,
      authorCaller: a.authorCaller,
    });
  }

  let finalReply = trimStr(camiStage.reply);
  let finalSource = camiStage.reply_source;
  const guestSafeFallback = trimStr(a.candidate_reply)
    || (a.composed && trimStr(a.composed.reply));
  if (
    guestSafeFallback
    && (
      (a.composed && a.composed.cami_author_required === true && camiStage.observability.cami_author_used !== true)
      || isFrontdeskAuthoringBriefLeak(finalReply)
    )
    && isFrontdeskAuthoringBriefLeak(finalReply)
  ) {
    finalReply = guestSafeFallback;
    if (finalSource === 'frontdesk_planner' || finalSource === 'cami_reply_author') {
      finalSource = 'frontdesk_guest_fallback';
    }
  }

  return {
    reply: finalReply,
    reply_source: finalSource,
    composer_state: a.composed && a.composed.composer_state,
    cami_variation_history: camiStage.cami_variation_history
      || (a.composed && a.composed.cami_variation_history),
    reply_pipeline: {
      candidate_source: a.candidate_source,
      agent_brain_source: agentStage.reply_source,
      cami_skipped: camiSkip.skip === true,
      cami_skip_reason: camiSkip.reason,
      final_source: finalSource,
      guest_fallback_used: finalSource === 'frontdesk_guest_fallback',
    },
    guest_agent_brain: agentStage.observability,
    cami_reply_author: camiStage.observability,
  };
}

module.exports = {
  applyGuestReplyPipeline,
  // Re-export ownership helpers for tests/docs
  ...require('./luna-guest-composer-ownership'),
};
