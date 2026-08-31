#!/usr/bin/env node
'use strict';

/**
 * verify-luna-effective-mode
 *
 * Proves `scripts/lib/luna-effective-mode.js` is a consolidation and not a behaviour
 * change: for every combination of the inputs that exist today, the resolver's
 * verdict is compared against what the shipped code actually decides.
 *
 * No expectation in this gate is hand-written. The oracles are the shipped decision
 * functions themselves:
 *
 *   WhatsApp  `evaluateGuestReplySendRouteWithPause` (scripts/lib/luna-guest-reply-send-route.js)
 *             driven with an in-memory `pg` and a mock WhatsApp sender, so "did Luna
 *             send by herself?" is answered by the real route, gates and provider.
 *   Eligibility
 *             `evaluateLunaGuestReplySendEligibility` produces the eligibility axis
 *             from real draft shapes rather than from typed-out booleans.
 *   Hermes    `checkGuestAutomationPauseState`, sliced out of `scripts/staff-query-api.js`
 *             (operator-owned, so it is read, never edited) and executed against the
 *             same in-memory `pg`. This is what `POST /staff/bot/check-guest-automation-gate`
 *             returns, i.e. exactly what Hermes sees.
 *   Python    `docker/hermes-staging/wolfhouse/pause_gate.py` itself, run against a
 *             loopback HTTP server that serves those real gate responses. Skipped when
 *             no python3 is present.
 *   Email     `isEmailLunaGenerateDraftEnabled` plus the draft-only contract asserted
 *             in the shipped staff email draft route source.
 *
 * Where the JS and Hermes paths disagree the gate does not pick a winner silently: it
 * pins the known disagreements and fails when the set changes, so a new divergence
 * surfaces as a failure rather than as drift.
 *
 * Offline: no database, no network beyond 127.0.0.1, no test framework.
 *
 * Run:
 *   node scripts/verify-luna-effective-mode.js            # gate
 *   node scripts/verify-luna-effective-mode.js --table     # + full truth table
 *   node scripts/verify-luna-effective-mode.js --table-out FILE
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const {
  resolveLunaEffectiveMode,
  readLunaEffectiveModeFlags,
  readLunaEffectiveModePauseInputsFromGateResponse,
  LUNA_EFFECTIVE_MODES,
  LUNA_EFFECTIVE_MODE_REASONS,
} = require('./lib/luna-effective-mode');
const {
  evaluateGuestReplySendRoute,
  evaluateGuestReplySendRouteWithPause,
} = require('./lib/luna-guest-reply-send-route');
const {
  evaluateLunaGuestReplySendEligibility,
  isWhatsappDryRun,
} = require('./lib/luna-guest-reply-send-eligibility');
const {
  GLOBAL_LUNA_PAUSE_CONVERSATION_ID,
  getPauseState,
  formatPauseStateRow,
} = require('./lib/staff-bot-pause-sql');
const { isEmailLunaGenerateDraftEnabled } = require('./lib/staff-email-luna-draft-route');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts/staff-query-api.js');
const EMAIL_DRAFT_ROUTE_PATH = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js');
const RESOLVER_PATH = path.join(ROOT, 'scripts/lib/luna-effective-mode.js');
const PAUSE_GATE_PY_PATH = path.join(ROOT, 'docker/hermes-staging/wolfhouse/pause_gate.py');
const HERMES_STAGING_DIR = path.join(ROOT, 'docker/hermes-staging');

const GATE_ANCHOR_STAFF_API = 'async function checkGuestAutomationPauseState(pg, input) {';

const TENANTS = ['wolfhouse-somo', 'sunset'];
const CHANNELS = ['whatsapp', 'email'];
const SEND_KINDS = ['ask_missing_field', 'staff_reply'];

let passes = 0;
let failures = 0;
let skips = 0;

function pass(label) {
  console.log(`  PASS  ${label}`);
  passes += 1;
}

function fail(label, detail) {
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failures += 1;
}

function check(label, condition, detail) {
  if (condition) pass(label);
  else fail(label, detail);
}

function skip(label, detail) {
  console.log(`  SKIP  ${label}${detail ? ` — ${detail}` : ''}`);
  skips += 1;
}

function section(title) {
  console.log(`\n${title}`);
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function sortedJoin(list) {
  return [...(list || [])].sort().join(',');
}

/** Comments describe the rules they implement, so purity is asserted on code only. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ─── in-memory pg ────────────────────────────────────────────────────────────────
// Answers only what the shipped decision paths ask for: bot_pause_states lookups and
// the conversations.needs_human lookup. guest_message_sends is reported absent, the
// way a machine without that table behaves, so the oracles decide without writing.

function missingTable(name) {
  const err = new Error(`relation "${name}" does not exist`);
  err.code = '42P01';
  return err;
}

// Audit columns only. The resolver never reads paused_at/created_at/updated_at — `paused: true`
// is what decides — so this is dated a day back purely so the row reads as an existing pause.
const PAUSE_FIXTURE_AUDIT_TS = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function pauseRow(clientSlug, scope) {
  return {
    id:              `pause-${scope}`,
    client_slug:     clientSlug,
    guest_phone:     scope === 'global' ? null : '+34600000404',
    conversation_id: scope === 'global' ? GLOBAL_LUNA_PAUSE_CONVERSATION_ID : 'conv-1',
    booking_id:      null,
    booking_code:    null,
    paused:          true,
    pause_reason:    `${scope} pause fixture`,
    paused_by:       'gate-fixture',
    paused_at:       PAUSE_FIXTURE_AUDIT_TS,
    resumed_by:      null,
    resumed_at:      null,
    metadata:        scope === 'global' ? { scope: 'global' } : {},
    created_at:      PAUSE_FIXTURE_AUDIT_TS,
    updated_at:      PAUSE_FIXTURE_AUDIT_TS,
  };
}

function makePg(state) {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/guest_message_sends/.test(s)) throw missingTable('guest_message_sends');

      if (/FROM bot_pause_states/.test(s)) {
        const isGlobalLookup = Array.isArray(params)
          && params[1] === GLOBAL_LUNA_PAUSE_CONVERSATION_ID
          && !/bot_pause_states bps/.test(s);
        if (isGlobalLookup) {
          return { rows: state.global_paused ? [pauseRow(state.client_slug, 'global')] : [] };
        }
        return { rows: state.conversation_paused ? [pauseRow(state.client_slug, 'conversation')] : [] };
      }

      if (/needs_human/.test(s) && /FROM conversations/.test(s)) {
        return {
          rows: [{
            needs_human:     state.needs_human === true,
            conversation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          }],
        };
      }

      if (/SELECT conv\.phone/.test(s)) return { rows: [{ phone: '+34600000404' }] };
      if (/inbox_channel_modes/.test(s) && /FROM clients/.test(s)) {
        const mode = state.whatsapp_channel_mode || 'auto';
        return { rows: [{ mode }] };
      }
      return { rows: [] };
    },
  };
}

// ─── oracle 1: the shipped WhatsApp send route ───────────────────────────────────

const DRAFT_FIXTURES = [
  {
    id: 'ask_missing_field',
    draft: {
      next_action:     'ask_missing_field',
      suggested_reply: 'Which dates were you thinking of?',
      extraction:      { intent: 'booking_inquiry' },
    },
  },
  {
    id: 'show_quote',
    draft: {
      next_action:     'show_quote',
      suggested_reply: '5 nights in a shared dorm comes to €130 total.',
      extraction:      { intent: 'booking_inquiry' },
      dry_run_plan:    { reply_draft: '5 nights in a shared dorm comes to €130 total.' },
    },
  },
  {
    id: 'handoff_required',
    draft: {
      next_action:     'handoff_to_staff',
      suggested_reply: 'Let me get a teammate to look at this.',
      extraction:      { intent: 'complaint', handoff_required: true },
    },
  },
  {
    id: 'missing_reply',
    draft: {
      next_action:     'ask_missing_field',
      suggested_reply: '',
      extraction:      { intent: 'booking_inquiry' },
    },
  },
];

/** Env profiles for the eligibility classifier (folds in its own live-send gates). */
const ELIGIBILITY_ENVS = [
  {
    id:  'live_open',
    env: {
      WHATSAPP_DRY_RUN:                    'false',
      WHATSAPP_LIVE_SENDS_ENABLED:         'true',
      LUNA_GUEST_LIVE_SEND_OWNER_APPROVED: 'true',
    },
  },
  { id: 'dry_run', env: { WHATSAPP_DRY_RUN: 'true' } },
];

function routeEnv(lunaAutoSend, dryRun) {
  return {
    LUNA_AUTO_SEND_ENABLED: lunaAutoSend ? 'true' : 'false',
    WHATSAPP_DRY_RUN:       dryRun ? 'true' : 'false',
  };
}

async function runShippedRoute(combo, eligibility) {
  const out = await evaluateGuestReplySendRouteWithPause({
    client_slug:      combo.client_slug,
    to:               '+34600000404',
    suggested_reply:  'Which dates were you thinking of?',
    send_kind:        combo.send_kind,
    idempotency_key:  `gate:${combo.key}`,
    source:           'verify-luna-effective-mode',
    draft:            {},
    send_eligibility: eligibility,
  }, {
    pg:  makePg(combo),
    env: routeEnv(combo.luna_auto_send_enabled, combo.whatsapp_dry_run),
    // Provider stand-in: proves the route reached the send, without a Graph API call.
    sendMessage: async () => ({ success: true, whatsapp_message_id: 'wamid.GATE' }),
  });
  return {
    mode:            out.result && out.result.success === true ? 'auto' : 'off',
    blocked_reasons: (out.result && out.result.blocked_reasons) || [],
  };
}

// ─── oracle 2: the Staff API gate Hermes calls ───────────────────────────────────

function sliceAsyncFunction(src, anchor) {
  const start = src.indexOf(anchor);
  if (start < 0) throw new Error(`anchor not found: ${anchor}`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function for anchor: ${anchor}`);
}

function loadShippedGuestAutomationGate() {
  const body = sliceAsyncFunction(read(STAFF_API_PATH), GATE_ANCHOR_STAFF_API);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'getPauseState',
    'formatPauseStateRow',
    'DEFAULT_CLIENT',
    `${body}\nreturn checkGuestAutomationPauseState;`,
  );
  return factory(getPauseState, formatPauseStateRow, 'wolfhouse-somo');
}

/** Mirror of `buildGuestAutomationGateResponse`'s decision fields, from the same file. */
function gateResponseFor(gate) {
  const blocked = !!(gate.bot_paused || gate.live_send_blocked);
  return {
    success:                       true,
    bot_paused:                    !!gate.bot_paused,
    live_send_blocked:             !!gate.live_send_blocked,
    can_continue_guest_automation: !blocked,
    source:                        gate.source,
    paused:                        blocked,
    global_paused:                 !!gate.global_paused,
    conversation_paused:           !!gate.conversation_paused,
    needs_human:                   !!gate.needs_human,
    effective_scope:               gate.effective_scope || null,
    whatsapp_channel_mode:         gate.whatsapp_channel_mode || null,
  };
}

// ─── the cross-product ───────────────────────────────────────────────────────────

function buildCombos() {
  const combos = [];
  for (const client_slug of TENANTS) {
    for (const channel of CHANNELS) {
      for (const fixture of DRAFT_FIXTURES) {
        for (const eligibilityEnv of ELIGIBILITY_ENVS) {
          for (const send_kind of SEND_KINDS) {
            for (const luna_auto_send_enabled of [true, false]) {
              for (const whatsapp_dry_run of [false, true]) {
                for (const global_paused of [false, true]) {
                  for (const conversation_paused of [false, true]) {
                    for (const needs_human of [false, true]) {
                      for (const email_staff_luna_draft_enabled of [false, true]) {
                        combos.push({
                          key: [
                            client_slug, channel, fixture.id, eligibilityEnv.id, send_kind,
                            `auto_send=${luna_auto_send_enabled}`, `dry_run=${whatsapp_dry_run}`,
                            `global_pause=${global_paused}`, `conv_pause=${conversation_paused}`,
                            `needs_human=${needs_human}`, `email_draft=${email_staff_luna_draft_enabled}`,
                          ].join('|'),
                          client_slug,
                          channel,
                          fixture,
                          eligibilityEnv,
                          send_kind,
                          luna_auto_send_enabled,
                          whatsapp_dry_run,
                          global_paused,
                          conversation_paused,
                          needs_human,
                          email_staff_luna_draft_enabled,
                        });
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return combos;
}

// ─── the truth table, collapsed without losing anything ──────────────────────────
// 4096 rows is an enumeration, not something an operator can read. These are the axes
// the resolver actually branches on: the four draft fixtures and two eligibility envs
// collapse to the three outcomes the classifier can return, and `send_kind` folds into
// the auto-send flag because the route exempts the staff Inbox send from it. Grouping
// on these and then eliding any axis whose whole domain appears loses nothing, and
// `collapseToRules` proves that rather than assuming it: a rule that spans more states
// than it covers is an over-generalisation, and the gate fails on it.

const RULE_AXES = [
  'tenant', 'channel', 'eligibility', 'env_gate',
  'dry_run', 'pause', 'needs_human', 'email_draft',
];

const ELIGIBILITY_LABEL_TRIPLES = new Map();

/**
 * Name the classifier's outcome. The triple behind each name is recorded so the gate
 * can prove the naming is injective — otherwise a collapsed row could hide two
 * different eligibility states under one label.
 */
function eligibilityLabel(eligibility) {
  const label = eligibility.requires_staff === true
    ? 'requires_staff'
    : eligibility.auto_send_ready === false
      ? 'auto_send_not_ready'
      : 'clear';
  const triple = [
    `requires_staff=${eligibility.requires_staff}`,
    `send_allowed_later=${eligibility.send_allowed_later}`,
    `auto_send_ready=${eligibility.auto_send_ready}`,
  ].join(' ');
  const seen = ELIGIBILITY_LABEL_TRIPLES.get(label);
  if (seen == null) ELIGIBILITY_LABEL_TRIPLES.set(label, triple);
  else if (seen !== triple) ELIGIBILITY_LABEL_TRIPLES.set(label, `AMBIGUOUS: ${seen} vs ${triple}`);
  return label;
}

function ruleAxesFor(combo, eligibility) {
  return {
    tenant:       combo.client_slug,
    channel:      combo.channel,
    eligibility:  eligibilityLabel(eligibility),
    // The route's env gate as the route reads it: the flag, or the staff Inbox send.
    env_gate:     combo.luna_auto_send_enabled || combo.send_kind === 'staff_reply' ? 'open' : 'closed',
    dry_run:      String(combo.whatsapp_dry_run),
    // One axis, because a global pause short-circuits: a global row with a
    // conversation row on top of it decides nothing the global row did not.
    pause:        combo.global_paused ? 'global' : combo.conversation_paused ? 'conversation' : 'none',
    needs_human:  String(combo.needs_human),
    email_draft:  String(combo.email_staff_luna_draft_enabled),
  };
}

function collapseToRules(rows) {
  const byState = new Map();
  const conflicts = [];
  for (const row of rows) {
    const key = RULE_AXES.map((axis) => row.axes[axis]).join('|');
    const verdict = [row.mode, row.reason, row.blocked, row.advisory].join('|');
    const seen = byState.get(key);
    if (seen == null) byState.set(key, { verdict, axes: row.axes });
    else if (seen.verdict !== verdict) conflicts.push(`${key}: ${seen.verdict} vs ${verdict}`);
  }

  const domains = RULE_AXES.map(() => new Set());
  for (const state of byState.values()) {
    RULE_AXES.forEach((axis, i) => domains[i].add(state.axes[axis]));
  }

  const groups = new Map();
  for (const state of byState.values()) {
    if (!groups.has(state.verdict)) {
      groups.set(state.verdict, { states: 0, sets: RULE_AXES.map(() => new Set()) });
    }
    const group = groups.get(state.verdict);
    group.states += 1;
    RULE_AXES.forEach((axis, i) => group.sets[i].add(state.axes[axis]));
  }

  const rules = [...groups.entries()]
    .map(([verdict, group]) => ({
      verdict,
      states:  group.states,
      // A rule is exact when its listed values span precisely the states it covers.
      spanned: group.sets.reduce((n, set) => n * set.size, 1),
      values:  group.sets.map((set, i) => (set.size === domains[i].size ? '*' : [...set].sort().join('/'))),
    }))
    .sort((a, b) => a.verdict.localeCompare(b.verdict));

  return { rules, stateCount: byState.size, conflicts };
}

function printRuleTable(rules) {
  const header = ['mode', 'reason', 'blocked_reasons', 'advisory', ...RULE_AXES];
  const table = [header, ...rules.map((rule) => {
    const [mode, reason, blocked, advisory] = rule.verdict.split('|');
    return [mode, reason, blocked, advisory, ...rule.values];
  })];
  const widths = header.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const row of table) {
    console.log(`        ${row.map((cell, i) => cell.padEnd(widths[i])).join('  ')}`);
  }
}

function resolverInputsFor(combo, eligibility) {
  return {
    client_slug:      combo.client_slug,
    channel:          combo.channel,
    send_kind:        combo.send_kind,
    global_paused:    combo.global_paused,
    conversation_paused: combo.conversation_paused,
    needs_human:      combo.needs_human,
    send_eligibility: eligibility,
    flags: {
      luna_auto_send_enabled:         combo.luna_auto_send_enabled,
      whatsapp_dry_run:               combo.whatsapp_dry_run,
      email_staff_luna_draft_enabled: combo.email_staff_luna_draft_enabled,
    },
  };
}

async function main() {
  console.log('\nverify-luna-effective-mode — one answer to "will Luna reply by herself?"\n');

  // ── [1] Module contract ───────────────────────────────────────────────────────
  section('[1] Resolver contract');
  {
    const src = stripComments(read(RESOLVER_PATH));
    check('resolver reads no process.env', !/process\.env/.test(src));
    check('resolver reads no clock', !/Date\.now|new Date\(/.test(src));
    check('resolver performs no I/O', !/require\('(?:fs|http|https|child_process|pg)'\)/.test(src));

    const reasons = Object.entries(LUNA_EFFECTIVE_MODE_REASONS);
    check('every reason declares a known mode',
      reasons.every(([, spec]) => LUNA_EFFECTIVE_MODES.includes(spec.mode)),
      reasons.filter(([, spec]) => !LUNA_EFFECTIVE_MODES.includes(spec.mode)).map(([r]) => r).join(', '));
    check('all three modes are reachable from the reason table',
      LUNA_EFFECTIVE_MODES.every((mode) => reasons.some(([, spec]) => spec.mode === mode)));

    // Purity under a hostile ambient environment: the answer must not move.
    const inputs = {
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      send_kind: 'ask_missing_field',
      send_eligibility: { requires_staff: false, send_allowed_later: true, auto_send_ready: true },
      flags: { luna_auto_send_enabled: false, whatsapp_dry_run: false },
    };
    const before = resolveLunaEffectiveMode(inputs);
    const saved = {
      LUNA_AUTO_SEND_ENABLED: process.env.LUNA_AUTO_SEND_ENABLED,
      WHATSAPP_DRY_RUN: process.env.WHATSAPP_DRY_RUN,
    };
    process.env.LUNA_AUTO_SEND_ENABLED = 'true';
    process.env.WHATSAPP_DRY_RUN = 'false';
    const after = resolveLunaEffectiveMode(inputs);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    check('ambient env cannot change the verdict',
      before.mode === after.mode && before.reason === after.reason,
      `${before.mode}/${before.reason} → ${after.mode}/${after.reason}`);
    check('flags-only auto-send gate blocks', before.mode === 'off' && before.reason === 'luna_auto_send_not_enabled',
      JSON.stringify(before));

    check('unknown channel falls back to whatsapp',
      resolveLunaEffectiveMode({ ...inputs, channel: 'telegram' }).channel === 'whatsapp');
    check('missing guest phone is off',
      resolveLunaEffectiveMode({
        ...inputs,
        guest_phone_present: false,
        flags: { luna_auto_send_enabled: true, whatsapp_dry_run: false },
      }).reason === 'guest_phone_missing');
  }

  // ── [2] Flag readers agree with the shipped predicates ────────────────────────
  section('[2] Flag reader ⇄ shipped env predicates');
  {
    const envs = [
      {},
      { LUNA_AUTO_SEND_ENABLED: 'true', WHATSAPP_DRY_RUN: 'false' },
      { LUNA_AUTO_SEND_ENABLED: 'TRUE', WHATSAPP_DRY_RUN: 'FALSE' },
      { LUNA_AUTO_SEND_ENABLED: ' true ', WHATSAPP_DRY_RUN: '  false ' },
      { LUNA_AUTO_SEND_ENABLED: '1', WHATSAPP_DRY_RUN: '0' },
      {
        LUNA_DEPLOYMENT: 'sunset-staging',
        EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
        EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
      },
      { LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true' },
    ];
    const dryRunDrift = [];
    const emailDrift = [];
    const autoSendDrift = [];
    for (const env of envs) {
      const flags = readLunaEffectiveModeFlags(env);
      if (flags.whatsapp_dry_run !== isWhatsappDryRun(env)) dryRunDrift.push(JSON.stringify(env));
      if (flags.email_staff_luna_draft_enabled !== (isEmailLunaGenerateDraftEnabled(env) === true)) {
        emailDrift.push(JSON.stringify(env));
      }
      // The shipped route accepts only the literal string `true`, case-insensitively.
      const expectAutoSend = String(env.LUNA_AUTO_SEND_ENABLED || '').trim().toLowerCase() === 'true';
      if (flags.luna_auto_send_enabled !== expectAutoSend) autoSendDrift.push(JSON.stringify(env));
    }
    check('whatsapp_dry_run matches isWhatsappDryRun (default-on)', dryRunDrift.length === 0, dryRunDrift.join(' '));
    check('email draft flag matches isEmailLunaGenerateDraftEnabled', emailDrift.length === 0, emailDrift.join(' '));
    check('auto-send flag matches the route\'s literal-true parse', autoSendDrift.length === 0, autoSendDrift.join(' '));
    check('WHATSAPP_DRY_RUN unset means dry run', readLunaEffectiveModeFlags({}).whatsapp_dry_run === true);
  }

  // ── [3] Full cross-product against the shipped paths ─────────────────────────
  section('[3] Cross-product — resolver ⇄ shipped decision paths');
  const combos = buildCombos();
  const gate = loadShippedGuestAutomationGate();
  const rows = [];
  const modeMismatches = [];
  const reasonSetMismatches = [];
  const divergences = new Map();
  const eligibilityOutcomes = new Set();

  for (const combo of combos) {
    const eligibility = evaluateLunaGuestReplySendEligibility(
      combo.fixture.draft,
      {},
      combo.eligibilityEnv.env,
    );
    eligibilityOutcomes.add([
      `requires_staff=${eligibility.requires_staff}`,
      `send_allowed_later=${eligibility.send_allowed_later}`,
      `auto_send_ready=${eligibility.auto_send_ready}`,
    ].join(' '));

    const resolved = resolveLunaEffectiveMode(resolverInputsFor(combo, eligibility));

    // Hermes arm: the real Staff API gate, on the same state.
    const hermesGate = await gate(makePg(combo), {
      client_slug: combo.client_slug,
      guest_phone: '+34600000404',
    });
    const hermesResponse = gateResponseFor(hermesGate);
    const hermesBlocked = hermesResponse.bot_paused === true
      || hermesResponse.live_send_blocked === true
      || hermesResponse.can_continue_guest_automation === false
      || hermesResponse.needs_human === true
      || hermesResponse.paused === true;

    let shipped = null;
    if (combo.channel === 'whatsapp') {
      shipped = await runShippedRoute(combo, eligibility);
      if (resolved.mode !== shipped.mode) {
        modeMismatches.push(`${combo.key} → resolver ${resolved.mode} vs route ${shipped.mode}`);
      }
      if (sortedJoin(resolved.blocked_reasons) !== sortedJoin(shipped.blocked_reasons)) {
        reasonSetMismatches.push(
          `${combo.key} → resolver [${sortedJoin(resolved.blocked_reasons)}] vs route [${sortedJoin(shipped.blocked_reasons)}]`,
        );
      }

      // Compare the two live paths on the rule they both implement: pause state.
      // Only cells where every other gate is open are comparable, because the
      // Hermes path has no counterpart to the env or eligibility gates at all
      // (asserted separately below) — outside those cells the paths are not
      // deciding the same question.
      const gatesOtherwiseOpen = combo.luna_auto_send_enabled
        && !combo.whatsapp_dry_run
        && eligibility.auto_send_ready === true;
      if (gatesOtherwiseOpen && (resolved.mode === 'auto') === hermesBlocked) {
        const cause = combo.needs_human && !combo.global_paused && !combo.conversation_paused
          ? `needs_human_without_pause_row:${combo.client_slug}`
          : `unclassified:${combo.key}`;
        if (!divergences.has(cause)) divergences.set(cause, { count: 0, example: combo.key });
        divergences.get(cause).count += 1;
      }
    }

    rows.push({
      key: combo.key,
      axes: ruleAxesFor(combo, eligibility),
      mode: resolved.mode,
      reason: resolved.reason,
      blocked: resolved.blocked_reasons.join('+') || '-',
      advisory: resolved.advisory_reasons.join('+') || '-',
      shipped_mode: shipped ? shipped.mode : 'n/a',
      hermes_blocked: hermesBlocked,
    });
  }

  check(`cross-product covers ${combos.length} input combinations`, combos.length === 4096, `${combos.length} rows`);
  check('eligibility axis came from the shipped classifier — the 3 outcomes it can return',
    sortedJoin([...eligibilityOutcomes]) === sortedJoin([
      'requires_staff=false send_allowed_later=true auto_send_ready=true',
      'requires_staff=false send_allowed_later=true auto_send_ready=false',
      'requires_staff=true send_allowed_later=false auto_send_ready=false',
    ]),
    [...eligibilityOutcomes].join(' | '));
  check(`resolver mode matches the shipped WhatsApp route on all ${combos.length / 2} WhatsApp cells`,
    modeMismatches.length === 0,
    modeMismatches.slice(0, 5).join('\n          '));
  check('resolver blocked_reasons match the route\'s blocked_reasons exactly',
    reasonSetMismatches.length === 0,
    reasonSetMismatches.slice(0, 5).join('\n          '));

  const modesSeen = new Set(rows.map((r) => r.mode));
  check('all three modes occur in the table', LUNA_EFFECTIVE_MODES.every((m) => modesSeen.has(m)),
    [...modesSeen].join(', '));

  // Two route outcomes the classifier cannot produce on its own, because it never
  // returns send_allowed_later: false with requires_staff: false, and because the
  // cross-product always carries a phone. Callers hand-build eligibility objects
  // (`buildStaffInboxGuestReplyBody` does), and a conversation can lack a phone, so
  // both reasons stay live and both are still checked against the shipped route.
  section('[3b] Route outcomes outside the classifier\'s range');
  for (const probe of [
    {
      label: 'send_allowed_later: false without requires_staff',
      reason: 'send_not_allowed_later',
      to: '+34600000404',
      eligibility: { requires_staff: false, send_allowed_later: false, auto_send_ready: true },
    },
    {
      label: 'conversation with no sendable phone',
      reason: 'guest_phone_missing',
      to: '',
      eligibility: { requires_staff: false, send_allowed_later: true, auto_send_ready: true },
    },
  ]) {
    const env = routeEnv(true, false);
    const routed = await evaluateGuestReplySendRouteWithPause({
      client_slug:      'wolfhouse-somo',
      to:               probe.to,
      suggested_reply:  'Which dates were you thinking of?',
      send_kind:        'ask_missing_field',
      idempotency_key:  `gate:probe:${probe.reason}`,
      draft:            {},
      send_eligibility: probe.eligibility,
    }, {
      pg:  makePg({ client_slug: 'wolfhouse-somo' }),
      env,
      sendMessage: async () => ({ success: true, whatsapp_message_id: 'wamid.GATE' }),
    });
    const resolved = resolveLunaEffectiveMode({
      client_slug:         'wolfhouse-somo',
      channel:             'whatsapp',
      send_kind:           'ask_missing_field',
      guest_phone_present: probe.to !== '',
      send_eligibility:    probe.eligibility,
      flags:               readLunaEffectiveModeFlags(env),
    });
    const routeMode = routed.result.success === true ? 'auto' : 'off';
    check(`${probe.label} → ${probe.reason}, matching the route`,
      resolved.mode === routeMode
      && resolved.reason === probe.reason
      && sortedJoin(resolved.blocked_reasons) === sortedJoin(routed.result.blocked_reasons),
      `resolver ${resolved.mode}/${resolved.reason} [${sortedJoin(resolved.blocked_reasons)}] vs route ${routeMode} [${sortedJoin(routed.result.blocked_reasons)}]`);
  }

  // ── [4] Email arm ⇄ shipped staff email draft route ──────────────────────────
  section('[4] Email arm ⇄ shipped staff email draft route');
  {
    const routeSrc = read(EMAIL_DRAFT_ROUTE_PATH);
    check('shipped email route is draft-only by contract',
      /draft_only\s*!==\s*true/.test(routeSrc)
      && /requires_staff_review\s*!==\s*true/.test(routeSrc)
      && /send_allowed\s*!==\s*false/.test(routeSrc)
      && /auto_send_allowed\s*!==\s*false/.test(routeSrc));
    check('shipped email route is bound to one tenant', /cl\.slug='sunset'/.test(routeSrc));

    const emailRows = rows.filter((r) => r.key.includes('|email|'));
    const draftRows = emailRows.filter((r) => r.mode === 'draft');
    check('email is never auto', emailRows.every((r) => r.mode !== 'auto'));
    check('email draft needs the shipped tenant and env flags',
      draftRows.every((r) => r.key.startsWith('sunset|') && r.key.includes('email_draft=true')),
      draftRows.filter((r) => !(r.key.startsWith('sunset|') && r.key.includes('email_draft=true'))).slice(0, 3).map((r) => r.key).join(' '));
    check('every sunset email cell with the flags on is draft',
      emailRows
        .filter((r) => r.key.startsWith('sunset|') && r.key.includes('email_draft=true'))
        .every((r) => r.mode === 'draft'));
    check('non-sunset email is off for want of the channel',
      emailRows.filter((r) => r.key.startsWith('wolfhouse-somo|'))
        .every((r) => r.mode === 'off' && r.reason === 'email_channel_not_available'));

    // The WhatsApp route refuses email identities outright, so email cannot be auto there either.
    const refused = evaluateGuestReplySendRoute({
      client_slug: 'sunset',
      to: 'emailv1:9f2c',
      suggested_reply: 'hello',
      send_kind: 'ask_missing_field',
      idempotency_key: 'gate:email-namespace',
    }, routeEnv(true, false));
    check('WhatsApp send route rejects email identities',
      refused.status === 400 && refused.result.error === 'email_channel_send_not_supported',
      JSON.stringify(refused.result && refused.result.error));
  }

  // ── [5] Hermes arm: the gate response the Python side consumes ────────────────
  section('[5] Hermes arm ⇄ POST /staff/bot/check-guest-automation-gate');
  const hermesCells = [];
  for (const client_slug of TENANTS) {
    for (const global_paused of [false, true]) {
      for (const conversation_paused of [false, true]) {
        for (const needs_human of [false, true]) {
          const state = { client_slug, global_paused, conversation_paused, needs_human };
          const g = await gate(makePg(state), { client_slug, guest_phone: '+34600000404' });
          const response = gateResponseFor(g);
          hermesCells.push({ ...state, response });
        }
      }
    }
  }
  check('gate slice ran for every pause/needs_human/tenant cell', hermesCells.length === 16);
  check('pause rows are an effective pause for both tenants',
    hermesCells.filter((c) => c.global_paused || c.conversation_paused).every((c) => c.response.bot_paused === true));
  check('gate keeps the Sunset needs_human carve-out (bot_paused stays false)',
    hermesCells.filter((c) => c.client_slug === 'sunset' && c.needs_human && !c.global_paused && !c.conversation_paused)
      .every((c) => c.response.bot_paused === false && c.response.can_continue_guest_automation === true));
  check('gate treats needs_human as an effective pause for wolfhouse-somo',
    hermesCells.filter((c) => c.client_slug === 'wolfhouse-somo' && c.needs_human && !c.global_paused && !c.conversation_paused)
      .every((c) => c.response.bot_paused === true && c.response.source === 'conversations_needs_human'));
  check('gate still reports raw needs_human on the Sunset carve-out response',
    hermesCells.filter((c) => c.client_slug === 'sunset' && c.needs_human && !c.global_paused && !c.conversation_paused)
      .every((c) => c.response.needs_human === true));
  // Found, not changed: once a pause row exists the gate returns early with a
  // hardcoded needs_human: false, so a paused-and-flagged thread is indistinguishable
  // from a merely paused one in this response.
  check('gate reports needs_human: false whenever a pause row exists, flagged or not',
    hermesCells.filter((c) => c.needs_human && (c.global_paused || c.conversation_paused))
      .every((c) => c.response.needs_human === false));

  {
    const draftGate = await gate(
      makePg({ client_slug: 'sunset', whatsapp_channel_mode: 'draft' }),
      { client_slug: 'sunset', guest_phone: '+34600000404' },
    );
    const draftResponse = gateResponseFor(draftGate);
    check('WhatsApp Draft channel mode blocks Hermes auto-send',
      draftResponse.bot_paused === true
      && draftResponse.live_send_blocked === true
      && draftResponse.can_continue_guest_automation === false
      && draftResponse.source === 'inbox_channel_mode_draft'
      && draftResponse.whatsapp_channel_mode === 'draft');
    const offGate = await gate(
      makePg({ client_slug: 'sunset', whatsapp_channel_mode: 'off' }),
      { client_slug: 'sunset', guest_phone: '+34600000404' },
    );
    check('WhatsApp Off channel mode blocks Hermes auto-send',
      gateResponseFor(offGate).source === 'inbox_channel_mode_off'
      && gateResponseFor(offGate).can_continue_guest_automation === false);
    const autoGate = await gate(
      makePg({ client_slug: 'sunset', whatsapp_channel_mode: 'auto' }),
      { client_slug: 'sunset', guest_phone: '+34600000404' },
    );
    check('WhatsApp Auto channel mode leaves gate open when pause/needs_human clear',
      gateResponseFor(autoGate).can_continue_guest_automation === true
      && gateResponseFor(autoGate).source === 'default_active');
  }

  {
    const readerDrift = hermesCells.filter((c) => {
      const derived = readLunaEffectiveModePauseInputsFromGateResponse(c.response);
      const paused = derived.global_paused || derived.conversation_paused;
      return paused !== (c.response.bot_paused === true) || derived.needs_human !== c.response.needs_human;
    });
    check('gate-response reader reproduces the gate\'s own pause verdict', readerDrift.length === 0,
      readerDrift.slice(0, 3).map((c) => JSON.stringify(c.response)).join(' '));
    const failClosed = readLunaEffectiveModePauseInputsFromGateResponse({ lookup_error: true });
    check('gate-response reader fails closed on an unusable response', failClosed.global_paused === true);

    // What adopting the resolver on the Hermes side would mean, written down rather
    // than discovered later: piping the gate response through the reader keeps
    // Hermes's current verdict everywhere the gate has an opinion, and hands the
    // Sunset needs_human thread back to Luna — which is the carve-out the Staff API
    // asks for and the Python OR currently overrides. That is a behaviour change and
    // needs a decision, so it stays a finding, not a patch.
    const openFlags = { luna_auto_send_enabled: true, whatsapp_dry_run: false };
    const clearEligibility = { requires_staff: false, send_allowed_later: true, auto_send_ready: true };
    const viaGate = (cell) => resolveLunaEffectiveMode({
      client_slug: cell.client_slug,
      channel: 'whatsapp',
      send_kind: 'ask_missing_field',
      send_eligibility: clearEligibility,
      flags: openFlags,
      ...readLunaEffectiveModePauseInputsFromGateResponse(cell.response),
    });
    const whNeedsHuman = hermesCells.find((c) => c.client_slug === 'wolfhouse-somo'
      && c.needs_human && !c.global_paused && !c.conversation_paused);
    const sunsetNeedsHuman = hermesCells.find((c) => c.client_slug === 'sunset'
      && c.needs_human && !c.global_paused && !c.conversation_paused);
    check('gate response + resolver keeps Luna off on a wolfhouse needs_human thread',
      viaGate(whNeedsHuman).mode === 'off', JSON.stringify(viaGate(whNeedsHuman)));
    check('gate response + resolver returns the Sunset needs_human thread to auto (carve-out honoured)',
      viaGate(sunsetNeedsHuman).mode === 'auto'
      && viaGate(sunsetNeedsHuman).advisory_reasons.includes('needs_human'),
      JSON.stringify(viaGate(sunsetNeedsHuman)));
  }

  // ── [6] The Python gate itself ────────────────────────────────────────────────
  section('[6] Hermes Python pause gate (optional cross-check)');
  await pythonPauseGateCrossCheck(hermesCells);

  // ── [7] Divergences: pinned, so a new one fails the gate ─────────────────────
  section('[7] JS ⇄ Hermes divergences');
  {
    const found = [...divergences.entries()]
      .map(([cause, info]) => `${cause} (${info.count} cells, e.g. ${info.example})`)
      .sort();
    const expected = [
      'needs_human_without_pause_row:sunset',
      'needs_human_without_pause_row:wolfhouse-somo',
    ];
    const foundCauses = [...divergences.keys()].sort();
    for (const line of found) console.log(`        divergence: ${line}`);
    check('on the pause rule, the only JS ⇄ Hermes disagreement is needs_human without a pause row',
      foundCauses.join(',') === expected.join(','),
      `found [${foundCauses.join(', ')}] expected [${expected.join(', ')}]`);
    check('resolver follows the JS path on the divergent cells (needs_human is advisory)',
      rows.filter((r) => r.key.includes('needs_human=true') && r.mode === 'auto')
        .every((r) => r.advisory.includes('needs_human')),
      'a needs_human cell resolved auto without recording the advisory reason');

    // The other divergence used to be an absence: the JS env gates had no Hermes
    // counterpart, so on staging neither flag could stop a send. They do now. Only
    // the wiring is asserted here — the behaviour (both flags honoured, fail-closed,
    // on the real patched send) is proved by scripts/verify-hermes-send-flags.js,
    // which runs that function against a recording provider rather than reading it.
    const patchSrc = read(path.join(HERMES_STAGING_DIR, 'apply_gateway_patches.py'));
    const hermesPy = fs.readdirSync(path.join(HERMES_STAGING_DIR, 'wolfhouse'))
      .filter((f) => f.endsWith('.py'))
      .map((f) => read(path.join(HERMES_STAGING_DIR, 'wolfhouse', f)))
      .concat(patchSrc)
      .join('\n');
    check('Hermes reads LUNA_AUTO_SEND_ENABLED and WHATSAPP_DRY_RUN',
      /LUNA_AUTO_SEND_ENABLED/.test(hermesPy) && /WHATSAPP_DRY_RUN/.test(hermesPy));
    const flagCall = patchSrc.indexOf('guest_whatsapp_send_flag_block(chat_id)');
    const pauseCall = patchSrc.indexOf('from wolfhouse.pause_gate import whatsapp_send_blocked');
    check('the Hermes send patch consults the kill switches, before the pause gate',
      flagCall > -1 && pauseCall > flagCall, `flags@${flagCall} pause@${pauseCall}`);
    check('and still consults the pause gate', pauseCall > -1);
    check('the behavioural proof of the kill switch exists',
      fs.existsSync(path.join(ROOT, 'scripts/verify-hermes-send-flags.js')));
  }

  // ── [8] Truth table ──────────────────────────────────────────────────────────
  section('[8] Truth table');
  {
    const ladder = new Map();
    for (const row of rows) {
      const k = `${row.mode}|${row.reason}`;
      ladder.set(k, (ladder.get(k) || 0) + 1);
    }
    console.log('        mode   reason                            cells');
    for (const [k, count] of [...ladder.entries()].sort()) {
      const [mode, reason] = k.split('|');
      console.log(`        ${mode.padEnd(6)} ${reason.padEnd(33)} ${String(count).padStart(5)}`);
    }
    check('every deciding reason in the table is a declared reason',
      [...ladder.keys()].every((k) => !!LUNA_EFFECTIVE_MODE_REASONS[k.split('|')[1]]));

    const ambiguous = [...ELIGIBILITY_LABEL_TRIPLES.entries()].filter(([, t]) => t.startsWith('AMBIGUOUS'));
    check('each eligibility label names exactly one classifier outcome', ambiguous.length === 0,
      ambiguous.map(([label, t]) => `${label} → ${t}`).join(' '));

    const collapsed = collapseToRules(rows);
    check(`the resolver's branching axes determine the verdict on all ${collapsed.stateCount} distinct states`,
      collapsed.conflicts.length === 0, collapsed.conflicts.slice(0, 3).join(' | '));
    const inexact = collapsed.rules.filter((rule) => rule.spanned !== rule.states);
    check(`truth table collapses to ${collapsed.rules.length} exact rules (no approximation)`,
      inexact.length === 0,
      inexact.map((rule) => `${rule.verdict} covers ${rule.states} states but spans ${rule.spanned}`).join(' | '));
    console.log('');
    printRuleTable(collapsed.rules);
    console.log('');

    const outIdx = process.argv.indexOf('--table-out');
    const outPath = outIdx > -1 ? process.argv[outIdx + 1] : null;
    if (outPath) {
      const header = 'mode\treason\tblocked_reasons\tadvisory_reasons\tshipped_route_mode\thermes_blocked\tinputs';
      const body = rows.map((r) => [
        r.mode, r.reason, r.blocked, r.advisory, r.shipped_mode, r.hermes_blocked, r.key,
      ].join('\t')).join('\n');
      fs.writeFileSync(outPath, `${header}\n${body}\n`, 'utf8');
      console.log(`        wrote ${rows.length} rows to ${outPath}`);
    }
    if (process.argv.includes('--table')) {
      for (const r of rows) {
        console.log(`        ${r.mode.padEnd(5)} ${r.reason.padEnd(30)} ${r.key}`);
      }
    }
  }

  console.log(`\nverify-luna-effective-mode: ${passes} passed, ${failures} failed${skips ? `, ${skips} skipped` : ''}\n`);
  process.exit(failures > 0 ? 1 : 0);
}

/**
 * Serve the real gate responses on loopback and let `pause_gate.py` decide, so the
 * Python verdict comes from the shipped module rather than from a reading of it.
 */
async function pythonPauseGateCrossCheck(hermesCells) {
  const byPhone = new Map();
  const cases = hermesCells.map((cell, i) => {
    const phone = `+3460000${String(1000 + i)}`;
    byPhone.set(phone.replace(/\D/g, ''), cell);
    return { phone, client_slug: cell.client_slug, index: i };
  });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (_) {
        body = {};
      }
      const cell = byPhone.get(String(body.guest_phone || '').replace(/\D/g, ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cell ? cell.response : { success: false, lookup_error: true }));
    });
  });

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(HERMES_STAGING_DIR)})
from wolfhouse.pause_gate import guest_automation_paused
cases = json.loads(sys.argv[1])
out = []
for case in cases:
    paused = guest_automation_paused(case["phone"], client_slug=case["client_slug"], force_refresh=True)
    out.append({"index": case["index"], "paused": bool(paused)})
print(json.dumps(out))
`;

  let raw = null;
  try {
    // Async on purpose: pause_gate.py makes a real HTTP call to the server above, and
    // a synchronous child would deadlock the loop that has to answer it.
    const out = await execFileAsync('python3', ['-c', script, JSON.stringify(cases)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        HERMES_ROLE: 'luna',
        LUNA_CLIENT_SLUG: 'wolfhouse-somo',
        LUNA_BOT_INTERNAL_TOKEN: 'gate-token',
        WOLFHOUSE_STAFF_API_BASE_URL: `http://127.0.0.1:${port}`,
      },
    });
    raw = out.stdout;
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || '').slice(0, 400);
    if (err && (err.code === 'ENOENT' || /not found/i.test(detail))) {
      skip('python3 pause-gate cross-check', 'no python3 interpreter on this machine');
    } else {
      fail('python3 pause-gate cross-check', detail);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  if (raw == null) return;

  let parsed = null;
  try {
    parsed = JSON.parse(raw.trim().split('\n').pop());
  } catch (err) {
    fail('python3 pause-gate output parses', err.message);
    return;
  }

  const pySrc = read(PAUSE_GATE_PY_PATH);
  check('python gate ORs the raw needs_human field of the response',
    /data\.get\("needs_human"\) is True/.test(pySrc));

  const pyPaused = new Map(parsed.map((r) => [r.index, r.paused]));
  const disagreements = [];
  for (const c of cases) {
    const cell = hermesCells[c.index];
    const py = pyPaused.get(c.index);
    const gatePaused = cell.response.bot_paused === true;
    if (py !== gatePaused) {
      disagreements.push({
        cell,
        label: `${cell.client_slug} global=${cell.global_paused} conv=${cell.conversation_paused} needs_human=${cell.needs_human}: python ${py}, gate ${gatePaused}`,
      });
    }
  }
  for (const d of disagreements) console.log(`        python ⇄ gate: ${d.label}`);

  check('python blocks every cell the gate calls paused',
    cases.every((c) => (hermesCells[c.index].response.bot_paused !== true) || pyPaused.get(c.index) === true));
  check('python and gate agree wherever needs_human is false',
    cases.filter((c) => !hermesCells[c.index].needs_human)
      .every((c) => pyPaused.get(c.index) === (hermesCells[c.index].response.bot_paused === true)),
    disagreements.filter((d) => !d.cell.needs_human).map((d) => d.label).join(' | '));
  check('the Sunset needs_human carve-out is defeated in Python, and that is the only disagreement',
    disagreements.length === 1
    && disagreements[0].cell.client_slug === 'sunset'
    && disagreements[0].cell.needs_human === true
    && disagreements[0].cell.global_paused === false
    && disagreements[0].cell.conversation_paused === false,
    disagreements.map((d) => d.label).join(' | ') || 'no disagreement found — has the OR been removed?');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
