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

// ---- rolling dates + private-room pre-flight --------------------------------
// Private-room fixtures used to hardcode July 6-13. The --allow-writes create
// fixture books R6 on those dates every green run and never cleans it up, so
// once R6 fills the fixture can never reach the private-room offer again — it
// wedges itself into a permanent (and misleading) red. Two defenses:
//   (1) rolling dates — each fixture targets the 6th->13th of a future month
//       that shifts ~hourly, so consecutive runs rarely reuse the same week;
//   (2) a pre-flight availability check — if R6 is already occupied for the
//       chosen week, SKIP the fixture with a clear message instead of emitting
//       a false FAIL. (True non-accumulation also needs a staff-auth cancel in
//       teardown — bot token can't cancel — speced separately to the API lane.)

const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const IT_MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// A 7-night window on the 6th->13th of a rolling future month. 6->13 is always
// 7 nights inside a single month (every month has >=28 days), so the natural-
// language phrasing stays single-month in both languages. `offsetMonths` lets
// two fixtures target distinct weeks so one's create can't block the other.
function rollingPrivateWeek(offsetMonths = 0) {
  const now = new Date();
  // 5..12 months out, advancing each hour → distinct weeks across back-to-back runs.
  const base = 5 + (Math.floor(Date.now() / 3600000) % 8);
  const d = new Date(now.getFullYear(), now.getMonth() + base + offsetMonths, 6);
  const y = d.getFullYear(), m = d.getMonth();
  const iso = (day) => `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    ciISO: iso(6), coISO: iso(13),
    en: `${EN_MONTHS[m]} 6 to 13, ${y}`,
    it: `dal 6 al 13 ${IT_MONTHS[m]} ${y}`,
  };
}

// Returns true (free) / false (occupied) / null (couldn't determine). Mirrors the
// freshStart docker-exec pattern; hits the same bot endpoint Luna's check uses.
function privateRoomAvailable(ciISO, coISO) {
  try {
    const out = execFileSync(DOCKER[0], dockerArgs(['exec', CONTAINER, 'sh', '-lc',
      `BASE=$(grep '^WOLFHOUSE_STAFF_API_BASE_URL=' /opt/data/.env | cut -d= -f2); ` +
      `TOK=$(grep '^LUNA_BOT_INTERNAL_TOKEN=' /opt/data/.env | cut -d= -f2); ` +
      `curl -s -X POST "$BASE/staff/bot/availability-check" -H "X-Luna-Bot-Token: $TOK" ` +
      `-H 'Content-Type: application/json' ` +
      `-d '{"client_slug":"wolfhouse-somo","check_in":"${ciISO}","check_out":"${coISO}","guest_count":2}'`]),
      { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(out);
    return j && typeof j.private_room_available === 'boolean' ? j.private_room_available : null;
  } catch (_) { return null; }
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
  'verifica manuale', 'richiede verifica',
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
    // Post-booking yoga add-on: ask_quantity relay + balance link (c9ffd75 + 5f653e4).
    // Service adds clean at €15/1 lesson; create_balance_payment_link must succeed
    // without flag_needs_human.
    name: 'fix1b-post-booking-yoga-alias',
    lang: 'it',
    allow_writes: true,                                        // creates a Stripe-TEST booking
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
    needs_private_room: 2,                                      // rolling week, offset 2 months from the create golden
    turns: [
      { text: 'Ciao, siamo una coppia, 7 notti {{WEEK_IT}}, pacchetto Malibu.', expect: {} },
      { text: 'Vorremmo una stanza privata per noi due.', expect: {} },
      { text: 'Mi chiamo Luca.', expect: {} },
      { text: 'Sì, va bene il supplemento, procediamo.', expect: {} },
    ],
    // WAS KNOWN-RED (agent-side gap): the agent used to either collect the name without
    // surfacing the +€10/night supplement, or hand the private-room request off to staff
    // (flag_needs_human). NOW GREEN as of 2026-06-18 on image 94fddb14 — the deployed
    // couple_private re-quote SOUL logic closed the gap: Luna checks R6 herself
    // (private_room_available), re-quotes WITH the supplement, no handoff. (We could only
    // observe this once needs_private_room rolling-dates unblocked the formerly-wedged week.)
    expect_overall: {
      tool_called: 'quote_booking',
      tool_args_include: { quote_booking: { room_preference: /private|couple|matrimonial|double/i } },
      tool_not_called: 'flag_needs_human',                     // must NOT hand private off to staff
      reply_contains: [/€?\s?10\b|supplement|supplemento|70/], // flat €10/night × 7n = €70
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

  // ---- 2026-06-18 robustness fixtures: lock today's fixes so they can't silently regress.
  // (a)/(b) pin behavior baked by the QUEUED SOUL build (55149fb lessons-by-quantity);
  // they are RED until that Hermes image is deployed, then go green — that IS the net.
  // VALIDATE + tune assertions per-fixture against the freshly-deployed container before trusting.
  {
    // 55149fb — lessons/yoga/meals bill per QUANTITY = total count, never `days`.
    // 2 guests × 4 lesson-days = 8 lessons (NOT the old silent default of 1).
    name: 'lessons-priced-by-quantity-not-days',
    lang: 'it',
    turns: [
      { text: 'Ciao! Siamo in 2, dal 15 al 19 agosto (4 giorni). Vorremmo una lezione di surf a testa ogni giorno.', expect: {} },
      { text: 'Sì, quotaci le lezioni per favore.',
        expect: {
          tool_called: 'quote_booking',
          // lesson add-on present AND quantity = 8, in any field/element order.
          tool_args_include: { quote_booking: { add_ons: /surf_lesson[\s\S]*"?quantity"?\s*[:=]\s*8\b|"?quantity"?\s*[:=]\s*8\b[\s\S]*surf_lesson/i } },
          tool_not_called: 'flag_needs_human',
          reply_contains: [/8\s*lezion/i],            // she states 8 lessons, never 1
        } },
    ],
    invariants: { reply_not_contains: LEAK_PHRASES },
  },
  {
    // Mixed couple → proactive private offer → accept → create → €70 FLAT room
    // supplement on the bill, end-to-end (real Stripe-TEST create). Stronger than
    // fix3-private-room-supplement-requote (read-only requote): asserts the supplement
    // survives onto the created booking. --allow-writes → excluded from --gate.
    // TEARDOWN CAVEAT: guest-fresh-start clears the session, NOT the booking ROW
    // (known gap) — each green run leaves a synthetic R6 booking. MITIGATED here by
    // needs_private_room: rolling dates put each run on a fresh week, and the pre-flight
    // SKIPS (not FAILs) if that week's R6 is already taken — so the fixture can no longer
    // wedge itself into a false red. Full non-accumulation still needs a staff-auth cancel
    // in teardown (bot token can't cancel) — speced to the Staff API lane.
    name: 'mixed-couple-private-supplement-on-bill',
    lang: 'en',
    allow_writes: true,
    needs_private_room: 0,                                      // rolling week (base offset)
    turns: [
      { text: "Hi! We're a couple — my girlfriend and me — 7 nights, {{WEEK_EN}}, Malibu package.", expect: {} },
      { text: 'Yes, a private room for the two of us sounds perfect.', expect: {} },
      { text: "I'm Robin, and we'll pay the deposit.", expect: {} },
      { text: 'Yes, go ahead and create the booking.', expect: {} },
    ],
    expect_overall: {
      tool_called: ['quote_booking', 'create_booking_from_plan'],
      tool_args_include: { quote_booking: { room_preference: /private|couple|matrimonial|double/i } },
      tool_not_called: 'flag_needs_human',
      reply_contains: [/€?\s?70\b|supplement|supplemento/],   // €10/night × 7n = €70 flat ROOM
    },
    invariants: { reply_not_contains: LEAK_PHRASES },
  },
  {
    // Room flow (f64f2dd) + gender (9d81790): all-girls group → female dorm, with NO
    // redundant second room question ("all-girls room or mixed?"). Composition asked
    // once from the group statement; Luna must not re-interrogate room gender after.
    name: 'all-girls-group-female-room-no-second-question',
    lang: 'en',
    turns: [
      { text: 'Hi! There are 3 of us, all girls, looking for beds Aug 15 to 22.',
        expect: {
          tool_called: 'check_availability',
          reply_not_contains: ['all-girls room or mixed', 'girls room or mixed', 'all girls or mixed',
            'female room or mixed', 'would you prefer a mixed', 'mixed dorm or'],
        } },
      { text: 'Malibu works for all three of us.', expect: {} },
    ],
    expect_overall: {
      tool_not_called: 'flag_needs_human',
      reply_not_contains: ['all-girls room or mixed', 'girls room or mixed', 'all girls or mixed', 'female room or mixed'],
    },
    invariants: { reply_not_contains: LEAK_PHRASES },
  },
  {
    // Room flow (f64f2dd): auto-assign the dorm — no redundant "which room type / what
    // room preference?" for a standard solo dorm booking (no private offer to a solo).
    name: 'auto-assign-dorm-no-redundant-room-question',
    lang: 'en',
    turns: [
      { text: 'Hey, just me — 1 person, 5 nights, Aug 10 to 15, looking for a dorm bed.',
        expect: {
          tool_called: 'check_availability',
          reply_not_contains: ['which room', 'what room', 'room type', 'room preference',
            'which dorm', 'private or shared', 'shared or private'],
        } },
    ],
    invariants: { reply_not_contains: LEAK_PHRASES },
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

  // Private-room fixtures: roll to a future week, then skip cleanly (not FAIL)
  // if R6 is already occupied for it — a wedged precondition is not a regression.
  let turns = fx.turns;
  if (fx.needs_private_room != null) {
    const week = rollingPrivateWeek(fx.needs_private_room);
    turns = fx.turns.map((t) => ({ ...t,
      text: t.text.replace('{{WEEK_EN}}', week.en).replace('{{WEEK_IT}}', week.it) }));
    const avail = privateRoomAvailable(week.ciISO, week.coISO);
    if (avail !== true) {
      const why = avail === false
        ? `private room (R6) already booked for ${week.ciISO}..${week.coISO}`
        : `could not confirm private-room availability for ${week.ciISO}..${week.coISO}`;
      process.stdout.write(`  ⊝ SKIP — ${why}\n`);
      return { fails: [], skipped: true };
    }
    process.stdout.write(`  · private room free for ${week.ciISO}..${week.coISO} ✓\n`);
  }

  try {
    turns.forEach((turn, i) => {
      if (i > 0) pace();
      const res = simulate(thread, turn.text, { lang: fx.lang, allowWrites: fx.allow_writes });
      guestPhone = res.guest_phone || guestPhone;
      allTools.push(...(res.tool_calls || []));
      allReplies.push(res.reply_text || '');
      // The output-guard scrubs leaks from reply_text, so assert leak invariants
      // against the RAW (pre-guard) reply — otherwise the guard would mask a real
      // Luna regression. Falls back to reply_text on pre-guard containers.
      const rawReply = res.raw_reply_text != null ? res.raw_reply_text : (res.reply_text || '');
      const before = fails.length;
      checkTurn(res, turn.expect, fails);
      // Fixture-level invariants are enforced on EVERY turn (e.g. never leak internals).
      if (fx.invariants) {
        for (const n of (fx.invariants.reply_not_contains || []))
          if (matches(rawReply, n)) fails.push(`INVARIANT: reply must never contain ${n} — turn ${i + 1}: "${rawReply.slice(0, 160)}…"`);
      }
      // Guard-emitted block findings (e.g. a leak it had to scrub) are hard fails:
      // the guest was protected, but Luna's underlying behavior still regressed.
      for (const g of (res.guard_findings || []))
        if (g && g.severity === 'block') fails.push(`GUARD ${g.kind} (blocked) — turn ${i + 1}: ${JSON.stringify(g.detail)}`);
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
  return { fails, skipped: false };
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

  let passed = 0, failed = 0, xfail = 0, xpass = 0, skipped = 0;
  for (const fx of fixtures) {
    const { fails, skipped: sk } = runFixture(fx, { verbose });
    if (sk) { skipped++; continue; }
    if (fx.expect_fail) {
      if (fails.length) { xfail++; process.stdout.write(`  ⊘ XFAIL (known bug, tracked): ${fx.expect_fail}\n`); }
      else { xpass++; process.stdout.write(`  ⚠ XPASS — ${fx.name} now PASSES! Remove its expect_fail marker (the bug is fixed).\n`); }
    } else if (fails.length) { failed++; } else { passed++; }
  }
  const parts = [`${passed} passed`];
  if (xfail) parts.push(`${xfail} xfail`);
  if (xpass) parts.push(`${xpass} XPASS⚠`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(`${failed} FAILED`);
  console.log(`\n${failed ? '✗' : '✓'} golden conversations: ${parts.join(', ')} (${fixtures.length} run${gate ? ', gate mode' : ''})`);
  process.exit(failed ? 1 : 0);                        // xfail/xpass never break the gate
}

if (require.main === module) main();

module.exports = { FIXTURES, simulate, checkTurn };
