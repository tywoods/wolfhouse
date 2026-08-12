'use strict';

/**
 * Owner file — "does this outbound Luna reply promise a human takeover?"
 *
 * Luna telling a guest that a teammate will take over is only half a handoff: the
 * conversation must also be flagged (`conversations.needs_human`) or nobody picks it up.
 * The trustworthy signal is the explicit `flag_needs_human` tool call; this module is the
 * safety net that catches a promise made without it.
 *
 * The pattern sources below are duplicated verbatim into the Hermes mirror
 * (`docker/hermes-staging/wolfhouse_whatsapp_mirror.py`) because that path runs in Python
 * inside the Hermes container. `scripts/verify-luna-handoff-promise-detection.js` asserts
 * the two copies stay identical and runs the shared corpus
 * (`fixtures/luna-handoff-promise-corpus.json`) through both.
 *
 * Patterns must stay inside the regex subset both engines share: no lookbehind, no named
 * groups, no `\p{...}`, no `\b` next to accented characters. Case-insensitivity is applied
 * by the caller's engine flag, not inside the pattern.
 */

const HANDOFF_PROMISE_PATTERNS = Object.freeze([
  // --- Luna says, in the first person, that she is escalating ---
  {
    id: 'escalate_looping_in',
    source: '(?:loop|looping|looped)\\s+in\\s+(?:a|an|our|the|one\\s+of\\s+our)?\\s*(?:wolf[\\s-]?house\\s+)?(?:team|teammate|colleague|human|someone)',
  },
  {
    id: 'escalate_connect_you_with_team',
    source: 'connect\\s+you\\s+(?:with|to)\\s+(?:our|the|a|one\\s+of\\s+our)\\s+(?:wolf[\\s-]?house\\s+)?(?:team|teammate|colleague|staff|human|someone)',
  },
  {
    id: 'escalate_passing_to_team',
    source: 'pass(?:ing|ed|es)?\\s+(?:this|it|that|you|your\\s+message|your\\s+details|your\\s+question|your\\s+request)?\\s*(?:along\\s+|on\\s+)?to\\s+(?:our|the|a|one\\s+of\\s+our)\\s+(?:team|teammate|colleague|staff|human)',
  },
  {
    id: 'escalate_passed_message_along',
    source: 'pass(?:ing|ed)\\s+your\\s+message\\s+along',
  },
  {
    id: 'escalate_flag_for_team',
    source: 'flag\\s+(?:this|it|that|your\\s+[a-z]+)\\s+(?:for|to|with)\\s+(?:our\\s+|the\\s+)?(?:team|staff)',
  },
  {
    id: 'escalate_hand_over_to_team',
    source: 'hand(?:ing|ed)?\\s+(?:this|it|that|you|your\\s+[a-z]+)\\s+(?:over\\s+|off\\s+)?to\\s+(?:our|the|a|one\\s+of\\s+our)\\s+(?:team|teammate|colleague|staff|human)',
  },
  {
    id: 'escalate_check_with_team',
    source: "(?:I['\u2019]ll|I\\s+will|I['\u2019]m\\s+going\\s+to|let\\s+me|going\\s+to)\\s+(?:just\\s+)?(?:check|double[\\s-]?check|confirm|run\\s+this)\\s+(?:this|that|it|these|those)?\\s*with\\s+(?:our|the)\\s+team",
  },
  {
    id: 'escalate_have_team_check',
    source: 'have\\s+(?:our|the)\\s+team\\s+(?:check|look|review|double[\\s-]?check|sort|confirm)',
  },
  {
    id: 'escalate_get_breakdown_from_team',
    source: "(?:let\\s+me|I['\u2019]ll|I\\s+will)\\s+get\\s+(?:you\\s+)?[^.!?]{0,40}from\\s+(?:our|the)\\s+team",
  },
  {
    id: 'escalate_get_team_to',
    source: 'get\\s+(?:our|the)\\s+team\\s+to\\s+(?:confirm|check|sort|look|help|answer)',
  },
  {
    id: 'escalate_follow_up_with_team',
    source: "(?:I['\u2019]ll|I\\s+will|I['\u2019]m\\s+going\\s+to)\\s+follow\\s+up\\s+with\\s+(?:our|the)\\s+team",
  },
  {
    id: 'escalate_let_team_know',
    source: "(?:I['\u2019]ve|I\\s+have|I['\u2019]ll|I\\s+will|let\\s+me)\\s+(?:just\\s+)?let\\s+(?:our|the)\\s+team\\s+know",
  },
  {
    id: 'escalate_asked_the_team',
    source: "(?:I['\u2019]ve|I\\s+have)\\s+asked\\s+(?:our|the)\\s+team",
  },
  {
    id: 'escalate_es_te_paso',
    source: 'te\\s+pas(?:o|ar[e\u00e9])\\s+con\\s+(?:alguien|una\\s+persona|el\\s+equipo|un\\s+compa[n\u00f1]ero)',
  },
  {
    id: 'escalate_es_paso_al_equipo',
    source: 'pas(?:o|ar|ar[e\u00e9])\\s+(?:tu\\s+mensaje|esto|tu\\s+consulta|tu\\s+caso)\\s+al\\s+equipo',
  },
  {
    id: 'escalate_it_ti_passo',
    source: 'ti\\s+pass(?:o|er[o\u00f2])\\s+(?:al\\s+team|allo\\s+staff|a\\s+un\\s+collega|a\\s+qualcuno)',
  },
  {
    id: 'escalate_it_passo_al_team',
    source: 'pass(?:o|er[o\u00f2])\\s+(?:il\\s+tuo\\s+messaggio|questo|la\\s+tua\\s+richiesta)\\s+al\\s+team',
  },

  // --- A human is promised to act for the guest ---
  {
    id: 'human_subject_will_act',
    source: '(?:(?:our|the|a|my|one\\s+of\\s+our)\\s+(?:wolf[\\s-]?house\\s+)?(?:team|teammates?|colleagues?|staff)(?:\\s+members?)?'
      + '|a\\s+team\\s+member'
      + '|(?:someone|somebody)\\s+from\\s+(?:the\\s+team|our\\s+team|wolf[\\s-]?house|the\\s+house|sunset)'
      + '|(?:someone|somebody)\\s+(?:on|in)\\s+(?:the|our)\\s+team'
      + '|staff)'
      + "\\s+(?:will|['\u2019]ll|is\\s+going\\s+to|are\\s+going\\s+to)\\s+(?:need\\s+to\\s+|have\\s+to\\s+)?"
      + '(?:take\\s+over|take\\s+it\\s+from\\s+here|jump\\s+in|get\\s+back\\s+to\\s+you|be\\s+in\\s+touch'
      + '|follow\\s+up|reach\\s+out|contact\\s+you|message\\s+you|write\\s+to\\s+you'
      + '|review\\s+(?:this|it|that|your)|check\\s+(?:this|it|that|those|these)|double[\\s-]?check'
      + '|sort\\s+(?:this|that|it|those|them|out)|answer\\s+you|look\\s+into\\s+(?:this|it|that)'
      + '|help\\s+(?:you\\s+)?with\\s+(?:this|that|it|the\\s+next\\s+step)'
      + '|confirm\\s+the\\s+right\\s+next\\s+step|confirm\\s+(?:your|the)\\s+(?:booking|payment|balance|refund|cancellation)'
      + '|send\\s+(?:you\\s+)?(?:your|the|it|them))',
  },
  {
    id: 'human_pronoun_will_act',
    source: "(?:they|someone|somebody|a\\s+teammate|a\\s+colleague|another\\s+teammate)(?:['\u2019]ll|\\s+will)"
      + '\\s+(?:take\\s+over|take\\s+it\\s+from\\s+here|jump\\s+in|get\\s+back\\s+to\\s+you|be\\s+in\\s+touch'
      + '|follow\\s+up|reach\\s+out|contact\\s+you|sort\\s+(?:this|that|it|those|them)\\s+out)',
  },
  {
    id: 'human_es_will_act',
    source: '(?:el\\s+equipo|alguien\\s+del\\s+equipo|un\\s+compa[n\u00f1]ero|una\\s+persona\\s+del\\s+equipo|mis\\s+compa[n\u00f1]eros)'
      + '[^.!?]{0,40}(?:te\\s+atender|te\\s+atienden|te\\s+contactar|te\\s+escribir|se\\s+pondr|te\\s+responder|lo\\s+revisar|se\\s+encargar)',
  },
  {
    id: 'human_it_will_act',
    source: '(?:il\\s+team|un\\s+collega|qualcuno\\s+del\\s+team|lo\\s+staff|i\\s+colleghi)'
      + '[^.!?]{0,40}(?:ti\\s+rispond|ti\\s+ricontatt|se\\s+ne\\s+occup|ti\\s+scriver|ti\\s+contatter)',
  },
]);

const COMPILED = HANDOFF_PROMISE_PATTERNS.map((p) => ({ id: p.id, re: new RegExp(p.source, 'i') }));

/**
 * @param {string} text outbound guest-facing reply
 * @returns {{ handoff_promised: boolean, pattern_id: string|null, matched_text: string|null }}
 */
function detectHandoffPromise(text) {
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) return { handoff_promised: false, pattern_id: null, matched_text: null };
  for (const { id, re } of COMPILED) {
    const m = re.exec(raw);
    if (m) return { handoff_promised: true, pattern_id: id, matched_text: m[0] };
  }
  return { handoff_promised: false, pattern_id: null, matched_text: null };
}

/** @returns {boolean} */
function isHandoffPromiseReply(text) {
  return detectHandoffPromise(text).handoff_promised === true;
}

module.exports = {
  HANDOFF_PROMISE_PATTERNS,
  detectHandoffPromise,
  isHandoffPromiseReply,
};
