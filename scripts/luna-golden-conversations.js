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
 *
 * Exit code 0 = all pass, 1 = any failure (CI-gateable on every deploy).
 *
 * Assertion vocabulary (per turn `expect`):
 *   reply_contains:     [str|RegExp]  — every entry must appear in reply_text (str = case-insensitive substring)
 *   reply_not_contains: [str|RegExp]  — none may appear (leak phrases, wrong-language words, fabrications)
 *   tool_called:        str | [str]   — each named tool must be called this turn
 *   tool_not_called:    str | [str]   — none of these may be called (e.g. flag_needs_human)
 *   tool_args_include:  { tool: { key: val|RegExp } } — that tool's args must include these key/values
 */

const { execFileSync } = require('child_process');

const CONTAINER = process.env.HERMES_CONTAINER || 'hermes-luna';
const TURN_TIMEOUT_MS = Number(process.env.SIM_TURN_TIMEOUT_MS || 180000);
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
    // hard_top_rental), and the quote must be the €120 wetsuit+hard-board combo.
    name: 'fix1-hard-board-combo',
    lang: 'en',
    turns: [
      { text: '2 people, 3 nights Aug 15 to 18. We each want a hard board and a wetsuit.',
        expect: { tool_called: 'check_availability', tool_args_include: { check_availability: { guest_count: 2 } } } },
      { text: 'Yes, hard board and wetsuit for all 3 days please.',
        expect: {
          tool_called: 'quote_booking',
          tool_args_include: { quote_booking: { add_ons: ['hard_board_rental', 'wetsuit_rental'] } },
          reply_not_contains: ['hard_top_rental', ...LEAK_PHRASES],
          reply_contains: [/120/],                             // €120 combo
        } },
    ],
  },
  {
    // Bug B — post-booking add-on. Adding yoga to an existing booking must
    // succeed via alias (yoga_class→yoga), NOT 422 → staff handoff.
    name: 'fix1b-post-booking-yoga-alias',
    lang: 'it',
    allow_writes: true,                                        // creates a Stripe-TEST booking
    turns: [
      { text: '2 persone, 3 notti dal 15 al 18 agosto, senza pacchetto.',
        expect: { tool_called: 'check_availability' } },
      { text: 'Va bene, procediamo. Mi chiamo Marco. Paghiamo la caparra.',
        expect: {} },                                          // name + payment choice
      { text: 'Siamo due ragazzi.', expect: {} },              // composition
      { text: 'Sì crea la prenotazione',
        expect: { tool_called: 'create_booking_from_plan' } },
      { text: 'Posso aggiungere una lezione di yoga?',
        expect: {
          tool_called: 'add_service_to_booking',
          tool_not_called: 'flag_needs_human',
          reply_not_contains: [...LEAK_PHRASES, 'team will', 'passo al team'],
        } },
    ],
  },
  {
    // Bug C — private room. With R6 free, accepting "private" must re-quote WITH
    // the supplement line (€10/night/person), not silently skip it.
    // (Negative case — no private offer when R6 is booked — is unit-tested in
    //  verify-per-person-gear-room-pref.js G3; can't block R6 from the hook.)
    name: 'fix3-private-room-supplement-requote',
    lang: 'it',
    turns: [
      { text: 'Ciao, siamo una coppia, 7 notti dal 1 al 8 novembre 2027.',
        expect: { tool_called: 'check_availability', tool_args_include: { check_availability: { guest_count: 2 } } } },
      { text: 'Malibu va bene', expect: { tool_called: 'quote_booking' } },
      { text: 'Vorremmo una stanza privata per noi due',
        expect: {
          tool_called: 'quote_booking',
          tool_args_include: { quote_booking: { room_preference: /private|couple_private|matrimonial/i } },
          reply_contains: [/10|supplement|supplemento|140/],   // supplement surfaced
          reply_not_contains: LEAK_PHRASES,
        } },
    ],
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
          reply_not_contains: ['all girls', 'all guys', 'all boys', 'mixed group', 'ragazzi', 'ragazze'],
        } },
      { text: 'Malibu for all of us', expect: { tool_called: 'quote_booking' } },
      { text: 'Looks good, we will pay the deposit. Names: Sam.',
        expect: {} },
      { text: 'Yes please continue',
        // by now (after quote + name + payment intent) composition is the right question
        expect: { reply_contains: [/girls|guys|boys|mixed|composition/i] } },
    ],
  },
];

// ---- runner -----------------------------------------------------------------

function runFixture(fx, { verbose }) {
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;
  const thread = `sim:golden-${fx.name}-${stamp}`;
  const fails = [];
  let guestPhone = null;
  process.stdout.write(`\n▶ ${fx.name} (${fx.lang}${fx.allow_writes ? ', writes' : ''})\n`);
  try {
    fx.turns.forEach((turn, i) => {
      const res = simulate(thread, turn.text, { lang: fx.lang, allowWrites: fx.allow_writes });
      guestPhone = res.guest_phone || guestPhone;
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
  } catch (e) {
    fails.push(`hook error: ${e.message.split('\n')[0]}`);
  } finally {
    if (fx.allow_writes) freshStart(guestPhone);
  }
  return fails;
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const fixtures = only ? FIXTURES.filter((f) => f.name === only) : FIXTURES;
  if (!fixtures.length) { console.error(`no fixture named "${only}"`); process.exit(2); }

  let failed = 0;
  for (const fx of fixtures) {
    const fails = runFixture(fx, { verbose });
    if (fails.length) failed++;
  }
  console.log(`\n${failed ? '✗' : '✓'} golden conversations: ${fixtures.length - failed}/${fixtures.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) main();

module.exports = { FIXTURES, simulate, checkTurn };
