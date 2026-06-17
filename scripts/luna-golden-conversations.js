'use strict';

/*
 * Luna golden-conversation regression suite.
 *
 * Drives the REAL Hermes Luna agent (gpt-5.5 + SOUL + tools) through scripted
 * multi-turn guest conversations via the simulate-guest-turn hook, and asserts
 * on both what Luna SAYS (reply_text) and what she DOES (exact tool args).
 *
 * Every bug we ship a fix for becomes a permanent fixture here, so a regression
 * cannot merge green. This is the deterministic net under a non-deterministic
 * agent — the cure for whack-a-mole.
 *
 * DEPENDENCY: the `wolfhouse.simulate_guest_turn` hook must be live in the
 * hermes-luna container (and committed to git). Run on Lunabox where docker is.
 *
 * Usage:
 *   node scripts/luna-golden-conversations.js                # run all
 *   node scripts/luna-golden-conversations.js --only fix5-no-internal-leak
 *   node scripts/luna-golden-conversations.js --verbose
 *   node scripts/luna-golden-conversations.js --gate         # deploy gate: skip --allow-writes fixtures
 *
 * Exit code 0 = all genuine fixtures pass, 1 = any unexpected failure (CI-gateable
 * on every deploy). A fixture with `expect_fail` pins a known, un-fixed bug: while
 * it fails it is reported as XFAIL and does NOT break the gate; if it ever PASSES it
 * is reported as a loud ⚠ XPASS (remove the marker — the bug is fixed).
 *
 * Assertion vocabulary (per turn `expect`):
 *   reply_contains:     [str|RegExp]  — every entry must appear in reply_text (str = case-insensitive substring)
 *   reply_not_contains: [str|RegExp]  — none may appear (leak phrases, wrong-language words, fabrications)
 *   tool_called:        str | [str]   — each named tool must be called this turn
 *   tool_not_called:    str | [str]   — none of these may be called (e.g. flag_needs_human)
 *   tool_args_include:  { tool: { key: val|RegExp } } — that tool's args must include these key/values
 */

const { execFileSync, execSync, spawnSync } = require('child_process');

// Pace between turns so a follow-up doesn't arrive while the agent is still
// finishing the previous turn (which returns an "interrupting current task" stub).
const INTER_TURN_MS = Number(process.env.SIM_INTER_TURN_MS || 2500);
const pace = () => { try { execSync(`sleep ${(INTER_TURN_MS / 1000).toFixed(1)}`); } catch (_) {} };

const CONTAINER = process.env.HERMES_CONTAINER || 'hermes-luna';
const TURN_TIMEOUT_MS = Number(process.env.SIM_TURN_TIMEOUT_MS || 240000);
// Docker invocation is configurable so the suite is portable: default `docker`,
// but on hosts where node lacks docker-group access use SIM_DOCKER="sudo docker".
const DOCKER = (process.env.SIM_DOCKER || 'docker').trim().split(/\s+/);
const dockerArgs = (rest) => [...DOCKER.slice(1), ...rest];

// ---- hook drivers -----------------------------------------------------------

function simulate(thread, text, { lang, allowWrites } = {}) {
  const args = ['exec', CONTAINER, 'python3', '-m', 'wolfhouse.simulate_guest_turn',
    '--thread', thread, '--text', text, '--json'];
  if (lang) args.push('--lang', lang);
  if (allowWrites) args.push('--allow-writes');
  const out = execFileSync(DOCKER[0], dockerArgs(args), { encoding: 'utf8', timeout: TURN_TIMEOUT_MS });
  return JSON.parse(out);
}

function freshStart(guestPhone) {
  if (!guestPhone) return;
  try {
    execFileSync(DOCKER[0], dockerArgs(['exec', CONTAINER, 'sh', '-lc',
      `curl -s -X POST http://127.0.0.1:8090/wolfhouse/guest-fresh-start ` +
      `-H "X-Luna-Bot-Token: $(grep LUNA_BOT_INTERNAL_TOKEN /opt/data/.env | cut -d= -f2)" ` +
      `-H "Content-Type: application/json" -d '{"guest_phone":"${guestPhone}","hard_delete":true}'`]),
      { encoding: 'utf8', timeout: 30000 });
  } catch (_) { /* teardown best-effort */ }
}

// ---- assertion engine -------------------------------------------------------

function hay(s) { return String(s || '').toLowerCase(); }
function matches(text, needle) {
  if (needle instanceof RegExp) return needle.test(text);
  return hay(text).includes(hay(needle));
}
function toolCallsByName(res) {
  const m = {};
  for (const t of (res.tool_calls || [])) (m[t.name] = m[t.name] || []).push(t);
  return m;
}
function argMatches(actual, expected) {
  if (expected instanceof RegExp) return expected.test(JSON.stringify(actual));
  if (Array.isArray(expected)) {
    // every expected element must be found somewhere in the actual array (by JSON substring)
    const blob = JSON.stringify(actual);
    return expected.every((e) => blob.includes(typeof e === 'string' ? e : JSON.stringify(e).slice(1, -1)));
  }
  if (expected && typeof expected === 'object') {
    return Object.entries(expected).every(([k, v]) => argMatches(actual ? actual[k] : undefined, v));
  }
  return hay(JSON.stringify(actual)).includes(hay(expected));
}

function checkTurn(res, expect, fails) {
  if (!expect) return;
  const reply = res.reply_text || '';
  const byName = toolCallsByName(res);

  for (const n of [].concat(expect.tool_called || []))
    if (!byName[n]) fails.push(`expected tool_called "${n}" — called: [${Object.keys(byName).join(', ') || 'none'}]`);

  for (const n of [].concat(expect.tool_not_called || []))
    if (byName[n]) fails.push(`tool "${n}" should NOT have been called`);

  for (const [tool, wantArgs] of Object.entries(expect.tool_args_include || {})) {
    const calls = byName[tool];
    if (!calls) { fails.push(`tool_args_include: "${tool}" was never called`); continue; }
    const ok = calls.some((c) => Object.entries(wantArgs).every(([k, v]) => argMatches(c.args ? c.args[k] : undefined, v)));
    if (!ok) fails.push(`tool "${tool}" args missing ${JSON.stringify(wantArgs)} — got ${JSON.stringify(calls.map((c) => c.args))}`);
  }

  for (const n of (expect.reply_contains || []))
    if (!matches(reply, n)) fails.push(`reply should contain ${n} — got: "${reply.slice(0, 160)}…"`);

  for (const n of (expect.reply_not_contains || []))
    if (matches(reply, n)) fails.push(`reply should NOT contain ${n} (LEAK/REGRESSION) — got: "${reply.slice(0, 200)}…"`);
}

// ---- the golden fixtures ----------------------------------------------------
// Texts are the literal guest messages; assertions pin the behavior we fixed.

const LEAK_PHRASES = ['il sistema', 'sistema non', 'preventivo che mi arriva',
  'the system', 'quote tool', 'the tool', 'backend', 'tool call', 'plugin'];

const FIXTURES = [
  {
    // Benito repro — bug A (package itemization) + bug E (never leak internals).
    name: 'fix2-fix5-package-breakdown-no-leak',
    lang: 'it',
    turns: [
      { text: 'Ciao! Siamo in 2 dal 15 al 22 agosto. Vorremmo noleggiare tavole soft top e mute per tutto il soggiorno.',
        expect: { tool_called: 'check_availability',
          tool_args_include: { check_availability: { guest_count: 2, check_in: '2026-08-15', check_out: '2026-08-22' } } } },
      { text: 'Malibu va bene',
        // Luna may legitimately re-explain packages before re-quoting — don't pin tool timing here.
        expect: {} },
      { text: 'Quanto costa il pacchetto e il noleggio tavole e mute separando le cose?',
        expect: {
          tool_called: 'quote_booking',
          tool_args_include: { quote_booking: { package_code: 'malibu' } },
          // Itemized = she names the distinct components separately. Exact € is
          // asserted deterministically at the endpoint level (booking-preview),
          // not here — the LLM legitimately varies number formatting.
          reply_contains: ['malibu', /tavola|soft.?top/i, /mut[ae]/i],
          tool_not_called: 'flag_needs_human',                 // no staff handoff
        } },
    ],
    invariants: { reply_not_contains: [...LEAK_PHRASES, 'system'] },  // never leak internals, any turn
  },
  {
    // Bug: hard board add-on. Luna must send canonical hard_board_rental (never
    // hard_top_rental). Exact €120 combo is asserted at the endpoint level.
    name: 'fix1-hard-board-combo',
    lang: 'en',
    turns: [
      { text: '2 people, 3 nights Aug 15 to 18. We each want a hard board and a wetsuit, all 3 days.', expect: {} },
      { text: 'Yes please, go ahead and quote it.', expect: {} },
    ],
    expect_overall: {
      tool_called: 'quote_booking',
      tool_args_include: { quote_booking: { add_ons: ['hard_board_rental', 'wetsuit_rental'] } },
      reply_not_contains: ['hard_top_rental', ...LEAK_PHRASES],
    },
    invariants: { reply_not_contains: ['hard_top_rental'] },
  },
  {
    // Bug B — post-booking add-on. Adding yoga to an existing booking must
    // succeed via alias (yoga_class→yoga), NOT 422 → staff handoff.
    //
    // KNOWN-RED = REAL CATCH (Fix1b GAP, 2026-06-17). The alias fix landed
    // (agent now sends canonical service_type=yoga), but the add-on STILL
    // staff-handoffs via a DIFFERENT 422: the agent calls add_service_to_booking
    // with confirm:true and NO quantity; resolveBotAddonRequestContext returns
    // the soft kind='ask_quantity', and the CREATE handler (staff-query-api.js
    // ~L8763) flattens ANY non-'ready' kind into HTTP 422 → plugin reads 422 as
    // staff_review_needed → flag_needs_human → handoff. Proven via
    // addon-request-preview: no-qty→ask_quantity, quantity:1→ready (€15, clean).
    // Fix (Cursor): default qty=1 for yoga/single-lesson AND/OR don't map the
    // ask_* states to 422 — relay them to the guest. Flip to green once fixed.
    name: 'fix1b-post-booking-yoga-alias',
    lang: 'it',
    allow_writes: true,                                        // creates a Stripe-TEST booking
    // KNOWN-RED, tracked: this fixture catches a REAL un-fixed Luna bug, so it is
    // marked expect_fail — the suite stays green on the genuine passes while keeping
    // this loud. It flips to a ⚠ XPASS (remove-this-marker) the moment Cursor lands
    // the fix. Excluded from the deploy --gate because --allow-writes creates real
    // Stripe-TEST bookings with no clean teardown.
    expect_fail: 'Fix1b GAP — add_service_to_booking(yoga) with no quantity → create '
      + 'endpoint flattens ask_quantity into HTTP 422 (staff-query-api.js:8763) → '
      + 'staff_review_needed → flag_needs_human → staff handoff. Fix (Cursor): default '
      + 'qty=1 for single-lesson and/or relay ask_* states to the guest, not 422.',
    turns: [
      { text: '2 persone, 3 notti dal 15 al 18 agosto, senza pacchetto, e una tavola soft top a testa.', expect: {} },
      { text: 'Va bene il prezzo, procediamo. Mi chiamo Marco e paghiamo la caparra.', expect: {} },
      { text: 'Siamo due ragazzi.', expect: {} },              // composition
      { text: 'Sì, crea pure la prenotazione.', expect: {} },
      { text: 'Perfetto. Posso anche aggiungere una lezione di yoga?', expect: {} },
      // Luna asks one question per reply (date for the class) before firing the
      // tool — give a concrete in-stay date so add_service_to_booking lands.
      { text: 'Sì, facciamola il 16 agosto.', expect: {} },
    ],
    expect_overall: {
      tool_called: ['create_booking_from_plan', 'add_service_to_booking'],
      tool_not_called: 'flag_needs_human',                     // add-on must NOT hand off
    },
    invariants: { reply_not_contains: LEAK_PHRASES },
  },
  {
    // Bug C — private room. With R6 free, accepting "private" must re-quote WITH
    // the supplement (€10/night/person), surfaced to the guest.
    // (Negative case — no private offer when R6 is booked — is unit-tested in
    //  verify-per-person-gear-room-pref.js G3; can't block R6 from the hook.)
    name: 'fix3-private-room-supplement-requote',
    lang: 'it',
    turns: [
      { text: 'Ciao, siamo una coppia, 7 notti dal 6 al 13 luglio 2026, pacchetto Malibu.', expect: {} },
      { text: 'Vorremmo una stanza privata per noi due.', expect: {} },
      { text: 'Mi chiamo Luca.', expect: {} },
      { text: 'Sì, va bene il supplemento, procediamo.', expect: {} },
    ],
    // KNOWN-RED pending investigation: across runs the agent either (a) collects
    // the name without ever surfacing the +€10/night supplement, or (b) hands the
    // private-room request off to staff (flag_needs_human). Neither matches Fix 3's
    // intent — Luna should check R6 herself (private_room_available flag) and
    // re-quote WITH the supplement. Server side is verified (booking-preview returns
    // room_supplement €140); this fixture pins the agent-side gap.
    expect_overall: {
      tool_called: 'quote_booking',
      tool_args_include: { quote_booking: { room_preference: /private|couple|matrimonial|double/i } },
      tool_not_called: 'flag_needs_human',                     // must NOT hand private off to staff
      reply_contains: [/€?\s?10\b|supplement|supplemento|140/], // the supplement amount must be surfaced
    },
    invariants: { reply_not_contains: LEAK_PHRASES },
  },
  {
    // Flow order (2bd1fa8) — composition must be asked LATER (after payment + name),
    // never right after the availability check.
    name: 'fix-flow-composition-after-payment-not-availability',
    lang: 'en',
    turns: [
      { text: '4 of us, Aug 15 to 22, looking for beds.',
        expect: {
          tool_called: 'check_availability',
          // must NOT interrogate group composition immediately after availability
          reply_not_contains: ['all girls', 'all guys', 'all boys', 'mixed group', 'all girls or', 'girls or guys'],
        } },
      { text: 'Malibu for all of us, looks good.', expect: {} },
      { text: 'No airport shuttle needed, thanks.', expect: {} },
      { text: 'We will pay the deposit. The name for the booking is Sam.', expect: {} },
      { text: 'Yes, go ahead and set it up.', expect: {} },
      { text: 'Sure, whatever you need.', expect: {} },
    ],
    // by SOME later turn (after quote + transfer + payment + name) composition IS the right question
    expect_overall: { reply_contains: [/girls|guys|boys|mixed|composition|same group|all of you|all women|all men/i] },
  },
];

// ---- runner -----------------------------------------------------------------

function runFixture(fx, { verbose }) {
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;
  const thread = `sim:golden-${fx.name}-${stamp}`;
  const fails = [];
  let guestPhone = null;
  const allTools = [];
  const allReplies = [];
  process.stdout.write(`\n▶ ${fx.name} (${fx.lang}${fx.allow_writes ? ', writes' : ''})\n`);
  try {
    fx.turns.forEach((turn, i) => {
      if (i > 0) pace();
      const res = simulate(thread, turn.text, { lang: fx.lang, allowWrites: fx.allow_writes });
      guestPhone = res.guest_phone || guestPhone;
      allTools.push(...(res.tool_calls || []));
      allReplies.push(res.reply_text || '');
      const before = fails.length;
      checkTurn(res, turn.expect, fails);
      // Fixture-level invariants are enforced on EVERY turn (e.g. never leak internals).
      if (fx.invariants) {
        for (const n of (fx.invariants.reply_not_contains || []))
          if (matches(res.reply_text || '', n)) fails.push(`INVARIANT: reply must never contain ${n} — turn ${i + 1}: "${(res.reply_text || '').slice(0, 160)}…"`);
      }
      const tools = (res.tool_calls || []).map((t) => t.name).join(', ') || '—';
      const mark = fails.length === before ? '✓' : '✗';
      process.stdout.write(`  ${mark} turn ${i + 1}: [${tools}]${verbose ? `  «${(res.reply_text || '').slice(0, 120)}»` : ''}\n`);
      for (const f of fails.slice(before)) process.stdout.write(`      - ${f}\n`);
    });
    // Conversation-level assertions: evaluated against ALL tool calls + the joined
    // replies, so they're robust to which turn the agent chooses to act on.
    if (fx.expect_overall) {
      const before = fails.length;
      checkTurn({ tool_calls: allTools, reply_text: allReplies.join('\n') }, fx.expect_overall, fails);
      const mark = fails.length === before ? '✓' : '✗';
      process.stdout.write(`  ${mark} overall: [${allTools.map((t) => t.name).join(', ') || '—'}]\n`);
      for (const f of fails.slice(before)) process.stdout.write(`      - ${f}\n`);
    }
  } catch (e) {
    fails.push(`hook error: ${e.message.split('\n')[0]}`);
  } finally {
    // Always tear down the simulated guest so stale context can't leak into a
    // later fixture that reuses the same derived phone.
    freshStart(guestPhone);
  }
  return fails;
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const gate = argv.includes('--gate');               // pre-deploy: read-only fixtures only
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  // Gate mode (deploy prebuild) runs each read-only fixture in its OWN node
  // subprocess, sequentially. A single process replaying every multi-turn agent
  // conversation accumulates memory and gets OOM-killed (exit 137) on the 3.9GB
  // box — per-fixture isolation releases memory between fixtures.
  if (gate && !only) {
    const names = FIXTURES.filter((f) => !f.allow_writes).map((f) => f.name);
    let failed = 0;
    for (const name of names) {
      const childArgs = [__filename, '--only', name];
      if (verbose) childArgs.push('--verbose');
      const r = spawnSync(process.execPath, childArgs, { stdio: 'inherit', env: process.env });
      if (r.status !== 0) { failed++; process.stdout.write(`  ✗ gate fixture FAILED (exit ${r.status == null ? 'killed' : r.status}): ${name}\n`); }
    }
    console.log(`\n${failed ? '✗' : '✓'} golden gate: ${names.length - failed}/${names.length} passed (per-fixture isolation)`);
    process.exit(failed ? 1 : 0);
  }

  let fixtures = only ? FIXTURES.filter((f) => f.name === only) : FIXTURES;
  // Belt-and-suspenders: even a non-gate run must never auto-create real
  // (Stripe-TEST) bookings unless a fixture is explicitly selected by --only.
  if (gate) fixtures = fixtures.filter((f) => !f.allow_writes);
  if (!fixtures.length) { console.error(`no fixture named "${only}"`); process.exit(2); }

  let passed = 0, failed = 0, xfail = 0, xpass = 0;
  for (const fx of fixtures) {
    const fails = runFixture(fx, { verbose });
    if (fx.expect_fail) {
      if (fails.length) { xfail++; process.stdout.write(`  ⊘ XFAIL (known bug, tracked): ${fx.expect_fail}\n`); }
      else { xpass++; process.stdout.write(`  ⚠ XPASS — ${fx.name} now PASSES! Remove its expect_fail marker (the bug is fixed).\n`); }
    } else if (fails.length) { failed++; } else { passed++; }
  }
  const parts = [`${passed} passed`];
  if (xfail) parts.push(`${xfail} xfail`);
  if (xpass) parts.push(`${xpass} XPASS⚠`);
  if (failed) parts.push(`${failed} FAILED`);
  console.log(`\n${failed ? '✗' : '✓'} golden conversations: ${parts.join(', ')} (${fixtures.length} run${gate ? ', gate mode' : ''})`);
  process.exit(failed ? 1 : 0);                        // xfail/xpass never break the gate
}

if (require.main === module) main();

module.exports = { FIXTURES, simulate, checkTurn };
