'use strict';

/**
 * Stage 56 Milestone A — Load real WhatsApp thread transcript for guest automation.
 */

const { getConversationMessagesQuery } = require('./staff-conversation-queries');

const DEFAULT_LIMIT = 20;
const BRAIN_HISTORY_LIMIT = 8;

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function directionToRole(direction) {
  const d = trimStr(direction).toLowerCase();
  if (d === 'inbound') return 'guest';
  if (d === 'outbound') return 'assistant';
  return 'system';
}

function normalizeTranscriptTurn(row) {
  const text = trimStr(row && row.message_text);
  if (!text) return null;
  return {
    role: directionToRole(row.direction),
    text: text.slice(0, 800),
    at: row.created_at || null,
    source: row.source || null,
    message_id: row.message_id || null,
  };
}

/**
 * Build transcript from fixture/injected guest_context (dry-run without DB).
 */
function transcriptFromGuestContext(guestContext) {
  const ctx = guestContext || {};
  if (Array.isArray(ctx.thread_transcript) && ctx.thread_transcript.length) {
    return { transcript: ctx.thread_transcript.slice(-DEFAULT_LIMIT), source: 'injected_context' };
  }
  if (Array.isArray(ctx.recent_history) && ctx.recent_history.length) {
    return { transcript: ctx.recent_history.slice(-DEFAULT_LIMIT), source: 'injected_recent_history' };
  }
  const lastOut = trimStr(ctx.result && ctx.result.proposed_luna_reply);
  const turns = [];
  if (lastOut) turns.push({ role: 'assistant', text: lastOut.slice(0, 800), at: null, source: 'prior_context' });
  return { transcript: turns, source: turns.length ? 'prior_context_fallback' : 'empty' };
}

/**
 * @param {object} pg
 * @param {{ client_slug: string, conversation_id: string, limit?: number }} input
 */
async function loadGuestThreadTranscript(pg, input) {
  const src = input || {};
  const clientSlug = trimStr(src.client_slug);
  const conversationId = trimStr(src.conversation_id);
  const limit = Number(src.limit) > 0 ? Math.min(Number(src.limit), 50) : DEFAULT_LIMIT;

  const empty = {
    transcript: [],
    recent_history: [],
    message_count: 0,
    source: 'empty',
    last_assistant_reply: null,
    last_guest_message: null,
  };

  if (!pg || !clientSlug || !conversationId) return empty;

  try {
    const q = getConversationMessagesQuery();
    const r = await pg.query(q, [clientSlug, conversationId]);
    const rows = (r.rows || []).slice(-limit);
    const transcript = rows.map(normalizeTranscriptTurn).filter(Boolean);
    const recentHistory = transcript.slice(-BRAIN_HISTORY_LIMIT).map((t) => ({
      role: t.role,
      text: t.text,
    }));

    let lastAssistant = null;
    let lastGuest = null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (!lastAssistant && transcript[i].role === 'assistant') lastAssistant = transcript[i].text;
      if (!lastGuest && transcript[i].role === 'guest') lastGuest = transcript[i].text;
      if (lastAssistant && lastGuest) break;
    }

    return {
      transcript,
      recent_history: recentHistory,
      message_count: transcript.length,
      source: 'messages_table',
      last_assistant_reply: lastAssistant,
      last_guest_message: lastGuest,
    };
  } catch (_) {
    return { ...empty, source: 'load_error' };
  }
}

/**
 * Resolve transcript: DB when possible, else guest_context injection/fallback.
 */
async function resolveGuestThreadTranscript(pg, input) {
  const src = input || {};
  const fromCtx = transcriptFromGuestContext(src.prior_guest_context);
  if (!pg || !trimStr(src.conversation_id)) {
    return {
      ...fromCtx,
      recent_history: (fromCtx.transcript || []).slice(-BRAIN_HISTORY_LIMIT).map((t) => ({
        role: t.role,
        text: t.text,
      })),
      message_count: (fromCtx.transcript || []).length,
      last_assistant_reply: [...(fromCtx.transcript || [])].reverse().find((t) => t.role === 'assistant')?.text || null,
      last_guest_message: trimStr(src.message_text) || null,
    };
  }
  const loaded = await loadGuestThreadTranscript(pg, {
    client_slug: src.client_slug,
    conversation_id: src.conversation_id,
    limit: src.limit,
  });
  if (loaded.message_count > 0) return loaded;
  return {
    ...fromCtx,
    recent_history: (fromCtx.transcript || []).slice(-BRAIN_HISTORY_LIMIT).map((t) => ({
      role: t.role,
      text: t.text,
    })),
    message_count: (fromCtx.transcript || []).length,
    source: fromCtx.source || 'context_fallback',
    last_assistant_reply: [...(fromCtx.transcript || [])].reverse().find((t) => t.role === 'assistant')?.text || null,
    last_guest_message: trimStr(src.message_text) || null,
  };
}

module.exports = {
  DEFAULT_LIMIT,
  BRAIN_HISTORY_LIMIT,
  loadGuestThreadTranscript,
  resolveGuestThreadTranscript,
  transcriptFromGuestContext,
  directionToRole,
};
