'use strict';

/**
 * Phase 1 (Inbox redesign) — Luna effective mode resolver.
 *
 * One function that answers, for one conversation right now: is Luna allowed to
 * reply by herself (`auto`), only to compose for staff approval (`draft`), or
 * nothing at all (`off`) — and why.
 *
 * Today that answer is spread across `bot_pause_states`, `conversations.needs_human`,
 * `LUNA_AUTO_SEND_ENABLED`, `WHATSAPP_DRY_RUN`, the send-eligibility classifier, the
 * legacy JS webhook route (`luna-guest-reply-send-route.js`), the Staff API gate
 * (`POST /staff/bot/check-guest-automation-gate`) and the Hermes Python pause gate.
 * Nobody can state it without reading all of them. This module is the one place the
 * rules are written down; `scripts/verify-luna-effective-mode.js` proves it agrees
 * with those shipped paths on every combination of inputs that exists today.
 *
 * Contract:
 *
 *   - **Pure.** No `process.env`, no clock, no database, no I/O. The caller gathers
 *     state and passes it in; this module only decides. That is what lets the gate
 *     enumerate the whole input space offline, and what lets the Hermes Python side
 *     adopt the same rules later.
 *   - **Reasons, not just a verdict.** `reason` is the deciding reason in
 *     operator-facing words; `blocked_reasons` is every applicable reason in the
 *     vocabulary the shipped send route already emits, so the Inbox and the audit
 *     log can speak one language; `advisory_reasons` is state that is true but does
 *     *not* decide on the path being modelled (see needs_human below).
 *   - **Behaviour-preserving.** Every rule below mirrors shipped code. Where two
 *     shipped paths disagree, the JS path wins here and the disagreement is called
 *     out in the comment and asserted by the gate, rather than being quietly split.
 *
 * Deliberate non-goals, so the boundary is not guessed at later:
 *
 *   - No per-conversation draft preference. That storage arrives with migration 079;
 *     `draft` is reachable today only through the Sunset staff email draft route,
 *     which is draft-only by contract (`draft_only: true`, `auto_send_allowed: false`
 *     in `scripts/lib/staff-email-luna-draft-route.js`).
 *   - Per-message write flags (`draft.creates_booking`, `draft_creates_payment`, …)
 *     are properties of one candidate reply, not of the conversation, so the route
 *     keeps owning them and they are not inputs here.
 *   - Nothing calls this yet. Adoption in the send paths is a separate change, so a
 *     mistake here cannot stop a guest getting a reply.
 *
 * @module luna-effective-mode
 */

const { isWhatsappDryRun } = require('./luna-guest-reply-send-eligibility');
const { isEmailLunaGenerateDraftEnabled } = require('./staff-email-luna-draft-route');

/** The three states of the Inbox mode control (migration 079 will persist these). */
const LUNA_EFFECTIVE_MODES = Object.freeze(['auto', 'draft', 'off']);

/** Channels the resolver knows about; anything else is treated as WhatsApp. */
const LUNA_EFFECTIVE_MODE_CHANNELS = Object.freeze(['whatsapp', 'email']);

/**
 * Options the Inbox thread-header control may offer *today*, without faking a
 * mode the send path cannot honour. WhatsApp has no approval step (migration
 * 078); email never auto-sends (`draft_only: true`). Off is pause on both.
 *
 * @param {'whatsapp'|'email'|string} [channel]
 * @returns {ReadonlyArray<'auto'|'draft'|'off'>}
 */
function lunaModeControlOptions(channel) {
  if (normalizeChannel(channel) === 'email') return Object.freeze(['draft', 'off']);
  return Object.freeze(['auto', 'off']);
}

/**
 * Tenant the shipped staff email Luna draft route is hard-bound to
 * (`SQL_LOAD_EMAIL_LUNA_GENERATION_CONTEXT` filters `cl.slug='sunset'`).
 */
const EMAIL_DRAFT_TENANT = 'sunset';

/** Send kind that models the staff Inbox explicit send (bypasses the auto-send flag). */
const STAFF_REPLY_SEND_KIND = 'staff_reply';

/**
 * Deciding reasons, in the order the resolver tests them.
 *
 * `blocked` is how the shipped route names the same condition in
 * `result.blocked_reasons`; keeping both means the operator gets a readable reason
 * and the audit trail keeps the vocabulary it already has.
 */
const LUNA_EFFECTIVE_MODE_REASONS = Object.freeze({
  luna_globally_paused:                { mode: 'off',   blocked: 'gate_bot_paused' },
  conversation_paused:                 { mode: 'off',   blocked: 'gate_bot_paused' },
  guest_phone_missing:                 { mode: 'off',   blocked: 'to_required' },
  requires_staff:                      { mode: 'off',   blocked: 'requires_staff' },
  send_not_allowed_later:              { mode: 'off',   blocked: 'send_not_allowed_later' },
  auto_send_not_ready:                 { mode: 'off',   blocked: 'auto_send_not_ready' },
  luna_auto_send_not_enabled:          { mode: 'off',   blocked: 'luna_auto_send_not_enabled' },
  whatsapp_dry_run_active:             { mode: 'off',   blocked: 'whatsapp_dry_run_active' },
  auto_send_ready:                     { mode: 'auto',  blocked: null },
  email_channel_not_available:         { mode: 'off',   blocked: 'email_channel_send_not_supported' },
  email_luna_draft_not_enabled:        { mode: 'off',   blocked: 'email_channel_send_not_supported' },
  email_staff_draft_only:              { mode: 'draft', blocked: 'email_channel_send_not_supported' },
});

function asBool(v) {
  return v === true;
}

function trimLower(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function normalizeChannel(channel) {
  const c = trimLower(channel);
  if (!c) return 'whatsapp';
  return LUNA_EFFECTIVE_MODE_CHANNELS.includes(c) ? c : 'whatsapp';
}

function decide(reason, extra) {
  const spec = LUNA_EFFECTIVE_MODE_REASONS[reason];
  if (!spec) throw new Error(`luna-effective-mode: unknown reason ${reason}`);
  return { mode: spec.mode, reason, ...(extra || {}) };
}

/**
 * WhatsApp ladder. Order matters twice over: it picks the deciding `reason`, and it
 * reproduces the shipped route's outcome, where the pause read happens after gate
 * evaluation and short-circuits before the provider, and the dry-run block is only
 * ever reported when everything else already passed.
 *
 * Mirrors `evaluateGuestReplySendRouteWithPause` in
 * `scripts/lib/luna-guest-reply-send-route.js`.
 */
function whatsappLadder(state) {
  const ladder = [];

  // Pause first: bot_pause_states (global row, then conversation/phone row).
  if (state.global_paused) ladder.push('luna_globally_paused');
  if (state.conversation_paused) ladder.push('conversation_paused');

  // Route validation + send-eligibility classifier outcome.
  if (!state.guest_phone_present) ladder.push('guest_phone_missing');
  if (state.requires_staff) ladder.push('requires_staff');
  if (state.send_allowed_later === false) ladder.push('send_not_allowed_later');
  if (state.auto_send_ready === false) ladder.push('auto_send_not_ready');

  // Env gate. The staff Inbox explicit send is exempt, exactly as the route is.
  if (!state.staff_initiated && !state.luna_auto_send_enabled) ladder.push('luna_auto_send_not_enabled');

  // Provider gate. Only reachable when nothing above blocked, because the route
  // never invokes the provider otherwise.
  if (ladder.length === 0 && state.whatsapp_dry_run) ladder.push('whatsapp_dry_run_active');

  return ladder;
}

/**
 * Email ladder. The shipped staff email draft route is draft-only by contract and
 * exists for one tenant behind three env flags; it never auto-sends, and the
 * WhatsApp send route refuses email identities outright
 * (`email_channel_send_not_supported`). So email is `draft` or `off`, never `auto`.
 */
function emailLadder(state) {
  if (state.client_slug !== EMAIL_DRAFT_TENANT) return ['email_channel_not_available'];
  if (!state.email_staff_luna_draft_enabled) return ['email_luna_draft_not_enabled'];
  return ['email_staff_draft_only'];
}

/**
 * Reasons that are true but do not decide on the path being modelled. They exist so
 * the Inbox can say "Luna is on, but this thread is flagged for a human" without a
 * caller re-deriving state, and so the two known cross-path disagreements stay
 * visible instead of being averaged away:
 *
 *   1. `needs_human` — the legacy JS route never reads it, so it does not block here.
 *      The Staff API gate (`checkGuestAutomationPauseState`) reports it as an
 *      effective pause for every tenant except `sunset`, and the Hermes Python gate
 *      then ORs the raw `needs_human` field, so on staging Luna *is* silent on a
 *      needs_human thread — for Sunset too, defeating that carve-out. Reported, not
 *      resolved: see the PR that introduced this module.
 *      The two env flags used to be the third disagreement — absent from Hermes
 *      entirely — and are not any more: `docker/hermes-staging/wolfhouse/send_flags.py`
 *      reads both with these exact semantics, proved against these predicates by
 *      `scripts/verify-hermes-send-flags.js`.
 *   2. `gate_bot_paused` on email — the staff email draft route never reads
 *      `bot_pause_states`, so a paused thread can still get a staff-initiated Luna
 *      email draft today. The redesign wants Off to mean off on both channel
 *      selectors; until that is decided, pause is advisory on the email arm.
 */
function advisoryReasons(state, channel, blockedReasons) {
  const advisory = [];
  if (state.needs_human && !blockedReasons.includes('gate_bot_paused')) {
    advisory.push('needs_human');
  }
  if (channel === 'email' && (state.global_paused || state.conversation_paused)) {
    advisory.push('gate_bot_paused');
  }
  return advisory;
}

/**
 * Resolve what Luna is allowed to do on one conversation right now.
 *
 * Every input is explicit. Booleans are read strictly (`=== true`), so a missing
 * field is a safe absence rather than a coincidence of truthiness; the one exception
 * is `send_eligibility.send_allowed_later` / `.auto_send_ready`, which block only on
 * an explicit `false`, matching how the route reads them.
 *
 * @param {object} inputs
 * @param {string} [inputs.client_slug] tenant slug, e.g. `wolfhouse-somo` / `sunset`
 * @param {'whatsapp'|'email'} [inputs.channel='whatsapp'] conversation channel
 * @param {string} [inputs.send_kind] route send kind; `staff_reply` marks the staff
 *   Inbox explicit send, which the shipped route exempts from the auto-send flag
 * @param {boolean} [inputs.guest_phone_present=true] conversation has a sendable phone
 * @param {boolean} [inputs.global_paused] client-wide `bot_pause_states` pause
 * @param {boolean} [inputs.conversation_paused] `bot_pause_states` row for this
 *   conversation or guest phone
 * @param {boolean} [inputs.needs_human] `conversations.needs_human` (advisory here)
 * @param {object} [inputs.send_eligibility] outcome of
 *   `evaluateLunaGuestReplySendEligibility` — `{ requires_staff, send_allowed_later,
 *   auto_send_ready }`
 * @param {object} [inputs.flags] pre-read flags; see `readLunaEffectiveModeFlags`
 * @returns {{
 *   mode: 'auto'|'draft'|'off',
 *   reason: string,
 *   blocked_reasons: string[],
 *   advisory_reasons: string[],
 *   channel: 'whatsapp'|'email',
 *   client_slug: string,
 * }}
 */
function resolveLunaEffectiveMode(inputs) {
  const src = inputs || {};
  const eligibility = src.send_eligibility || {};
  const flags = src.flags || {};
  const channel = normalizeChannel(src.channel);

  const state = {
    client_slug:                    String(src.client_slug == null ? '' : src.client_slug).trim(),
    global_paused:                  asBool(src.global_paused),
    conversation_paused:            asBool(src.conversation_paused),
    needs_human:                    asBool(src.needs_human),
    guest_phone_present:            src.guest_phone_present !== false,
    staff_initiated:                trimLower(src.send_kind) === STAFF_REPLY_SEND_KIND,
    requires_staff:                 asBool(eligibility.requires_staff),
    send_allowed_later:             eligibility.send_allowed_later !== false,
    auto_send_ready:                eligibility.auto_send_ready !== false,
    luna_auto_send_enabled:         asBool(flags.luna_auto_send_enabled),
    whatsapp_dry_run:               asBool(flags.whatsapp_dry_run),
    email_staff_luna_draft_enabled: asBool(flags.email_staff_luna_draft_enabled),
  };

  const ladder = channel === 'email' ? emailLadder(state) : whatsappLadder(state);
  const decidingReason = ladder.length ? ladder[0] : 'auto_send_ready';
  const blockedReasons = [...new Set(
    (ladder.length ? ladder : [])
      .map((reason) => LUNA_EFFECTIVE_MODE_REASONS[reason].blocked)
      .filter(Boolean),
  )];

  return decide(decidingReason, {
    blocked_reasons:  blockedReasons,
    advisory_reasons: advisoryReasons(state, channel, blockedReasons),
    channel,
    client_slug:      state.client_slug,
  });
}

/**
 * Read the env-level flags the resolver needs, using the same predicates the
 * shipped code uses, so the caller never re-implements env parsing (which is where
 * `WHATSAPP_DRY_RUN` defaulting to true, and `LUNA_AUTO_SEND_ENABLED` requiring the
 * literal string `true`, would otherwise get lost).
 *
 * This is the only function here that touches an env object, and it is handed one
 * rather than reaching for `process.env`.
 *
 * @param {object} env
 * @returns {{ luna_auto_send_enabled: boolean, whatsapp_dry_run: boolean, email_staff_luna_draft_enabled: boolean }}
 */
function readLunaEffectiveModeFlags(env) {
  const src = env || {};
  return {
    luna_auto_send_enabled:         trimLower(src.LUNA_AUTO_SEND_ENABLED) === 'true',
    whatsapp_dry_run:               isWhatsappDryRun(src),
    email_staff_luna_draft_enabled: isEmailLunaGenerateDraftEnabled(src) === true,
  };
}

/**
 * Map a `POST /staff/bot/check-guest-automation-gate` response onto resolver inputs.
 *
 * Hermes already calls that endpoint from `docker/hermes-staging/wolfhouse/pause_gate.py`,
 * so this is the seam through which the Python side can adopt these rules without
 * inventing a second reading of the same payload.
 *
 * `lookup_error` / `success === false` is reported as a global pause: the shipped
 * Python gate fails closed on an unusable response, and so must anything replacing it.
 *
 * Reading the gate's own verdict — rather than re-deciding from `needs_human` — is what
 * lets each path keep its present behaviour while sharing one resolver: where the gate
 * calls a thread paused (including `needs_human` on every tenant but Sunset) the
 * resolver is handed `conversation_paused` and answers `off`.
 *
 * @param {object} response parsed gate response body
 * @returns {{ global_paused: boolean, conversation_paused: boolean, needs_human: boolean }}
 */
function readLunaEffectiveModePauseInputsFromGateResponse(response) {
  const src = response || {};
  const unusable = src.lookup_error === true || src.success === false;
  return {
    global_paused:       unusable || src.global_paused === true,
    conversation_paused: src.conversation_paused === true
      || (src.bot_paused === true && src.global_paused !== true)
      || src.live_send_blocked === true
      || src.can_continue_guest_automation === false,
    needs_human:         src.needs_human === true,
  };
}

module.exports = {
  resolveLunaEffectiveMode,
  readLunaEffectiveModeFlags,
  readLunaEffectiveModePauseInputsFromGateResponse,
  lunaModeControlOptions,
  LUNA_EFFECTIVE_MODES,
  LUNA_EFFECTIVE_MODE_CHANNELS,
  LUNA_EFFECTIVE_MODE_REASONS,
  EMAIL_DRAFT_TENANT,
  STAFF_REPLY_SEND_KIND,
};
