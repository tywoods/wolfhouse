'use strict';

/**
 * Stage 31e — correlate hosted live-proof inbound turns to outbound Luna sends.
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function sendRowId(send) {
  return send && (send.id || send.send_id) ? String(send.id || send.send_id) : null;
}

/**
 * @param {Array<object>} events guest_message_events rows sorted asc by created_at
 * @param {Array<object>} sends guest_message_sends rows sorted asc by created_at
 * @returns {{ turns: object[], warnings: string[], reused_send_ids: string[] }}
 */
function correlateHostedProofTurns(events, sends) {
  const evs = (events || []).slice().sort((a, b) => (parseTime(a.created_at) || 0) - (parseTime(b.created_at) || 0));
  const outbound = (sends || []).slice().sort((a, b) => (parseTime(a.created_at) || 0) - (parseTime(b.created_at) || 0));
  const usedSendIds = new Set();
  const assignCounts = new Map();
  const warnings = [];
  const turns = [];

  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const evTime = parseTime(ev.created_at);
    const nextTime = i + 1 < evs.length ? parseTime(evs[i + 1].created_at) : null;
    const suggested = trimStr(ev.suggested_reply) || null;
    const wamid = trimStr(ev.wa_message_id || ev.inbound_message_id) || null;

    let matched = null;
    let matchMethod = 'suggested_reply';

    if (evTime != null) {
      const windowCandidates = outbound.filter((s) => {
        const sid = sendRowId(s);
        if (sid && usedSendIds.has(sid)) return false;
        const st = parseTime(s.created_at);
        if (st == null || st <= evTime) return false;
        if (nextTime != null && st >= nextTime) return false;
        return true;
      });
      if (windowCandidates.length >= 1) {
        matched = windowCandidates[0];
        matchMethod = windowCandidates.length === 1 ? 'inbound_window' : 'inbound_window_earliest';
      }
    }

    if (!matched && suggested) {
      const textMatch = outbound.find((s) => {
        const sid = sendRowId(s);
        if (sid && usedSendIds.has(sid)) return false;
        return trimStr(s.message_text) === suggested;
      });
      if (textMatch) {
        matched = textMatch;
        matchMethod = 'suggested_reply_text';
      }
    }

    const matchedId = sendRowId(matched);
    const duplicateSendReused = !!(matchedId && usedSendIds.has(matchedId));
    if (duplicateSendReused) {
      warnings.push(`duplicate_send_reused:${matchedId}:wamid:${wamid || i}`);
    }
    if (matchedId) {
      usedSendIds.add(matchedId);
      assignCounts.set(matchedId, (assignCounts.get(matchedId) || 0) + 1);
    }

    const actualSent = matched ? trimStr(matched.message_text) : null;
    if (!matched && !suggested) {
      warnings.push(`no_outbound:wamid:${wamid || i}`);
    }
    if (matched && suggested && actualSent && actualSent !== suggested) {
      warnings.push(`sent_differs_from_suggested:wamid:${wamid || i}`);
    }

    turns.push({
      inbound_wamid: wamid,
      inbound: ev.message_text,
      inbound_at: ev.created_at,
      suggested_reply: suggested,
      actual_sent_text: actualSent,
      luna: actualSent || suggested,
      match_method: matched ? matchMethod : 'suggested_reply',
      matched_send_id: matchedId,
      provider_message_id: matched ? (matched.provider_message_id || null) : null,
      send_created_at: matched ? matched.created_at : null,
      send_status: matched ? matched.status : null,
      duplicate_send_reused: duplicateSendReused,
    });
  }

  const reusedSendIds = [...assignCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  return { turns, warnings, reused_send_ids: reusedSendIds };
}

module.exports = {
  correlateHostedProofTurns,
  parseTime,
  sendRowId,
};
