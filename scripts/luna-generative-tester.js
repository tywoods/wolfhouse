#!/usr/bin/env node
/**
 * Luna generative tester — robustness plan, step 5.
 *
 * Systematically sweeps a CURATED BANK of realistic + edge-case guest
 * conversations through the simulate-guest-turn harness and flags failures,
 * replacing the owner's manual WhatsApp spot-testing with a repeatable batch.
 *
 * It does NOT re-implement detectors: every Luna reply already passes through
 * wolfhouse.output_guard.guard_reply inside the container, and the simulate
 * route returns the resulting `guard_findings` (leak / provider_error / unsourced
 * price / language mismatch) per turn. This tester CONSUMES those findings and
 * layers domain detectors on top (needless handoff, lesson/room mis-count,
 * missing tool calls, forbidden phrases).
 *
 * Severity model (mirrors the guard):
 *   - guard finding severity "block"  (leak, provider_error)   -> FAIL always
 *   - guard finding severity "warn"   (unsourced_price, lang)  -> WARN by default,
 *       promoted to FAIL only when a scenario opts in (forbid_unsourced_price /
 *       require_lang) — keeps derived-total false positives out of the red.
 *   - domain detectors (below)                                 -> FAIL
 *
 * BOUNDED BY DESIGN. Every turn is a real gpt-5.5 call (quota + cost), and the
 * orchestrator is co-resident on this box (~2.2 GB free → the golden --gate
 * OOM-kills). So this runs SEQUENTIALLY, one docker exec at a time, never in
 * parallel, with a hard --max cap. It is a curated sweep, not an always-on
 * firehose. Default cap is intentionally small; raise --max deliberately.
 *
 * Usage:
 *   SIM_DOCKER="sudo docker" SIM_TURN_TIMEOUT_MS=300000 \
 *     node scripts/luna-generative-tester.js                 # run default batch (--max 8)
 *   ... node scripts/luna-generative-tester.js --only off-season-leak-it
 *   ... node scripts/luna-generative-tester.js --max 14      # full bank
 *   ... node scripts/luna-generative-tester.js --tag language # filter by tag
 *   ... node scripts/luna-generative-tester.js --list        # list scenarios, run nothing
 *   ... node scripts/luna-generative-tester.js --verbose     # echo each reply
 *
 * Scenarios are READ-ONLY (no --allow-writes): none drive create_booking_from_plan,
 * so no Stripe-TEST rows and no teardown. Create-path assertions live in the
 * golden suite (mixed-couple-private-supplement-on-bill), not here.
 *
 * Exit code: 0 = no FAILs (WARN allowed), 1 = at least one FAIL, 2 = bad args.
 */

const { execFileSync, execSync } = require('child_process');

// ---- harness drivers (shared shape with luna-golden-conversations.js) --------

const INTER_TURN_MS = Number(process.env.SIM_INTER_TURN_MS || 2500);
const pace = () => { try { execSync(`sleep ${(INTER_TURN_MS / 1000).toFixed(1)}`); } catch (_) {} };
const CONTAINER = process.env.HERMES_CONTAINER || 'hermes-luna';
const TURN_TIMEOUT_MS = Number(process.env.SIM_TURN_TIMEOUT_MS || 300000);
const DOCKER = (process.env.SIM_DOCKER || 'docker').trim().split(/\s+/);
const dockerArgs = (rest) => [...DOCKER.slice(1), ...rest];

function simulate(thread, text, { lang } = {}) {
  const args = ['exec', CONTAINER, 'python3', '-m', 'wolfhouse.simulate_guest_turn',
    '--thread', thread, '--text', text, '--json'];
  if (lang) args.push('--lang', lang);
  const out = execFileSync(DOCKER[0], dockerArgs(args), { encoding: 'utf8', timeout: TURN_TIMEOUT_MS });
  return JSON.parse(out);
}

// ---- curated scenario bank ---------------------------------------------------
// Each scenario: { name, lang, tags[], turns[<string>], ...detector opts }
// Detector opts (all optional):
//   no_handoff: true            -> flag_needs_human in ANY turn = FAIL (needless handoff)
//   forbid_unsourced_price: true-> promote unsourced_price warn -> FAIL (fabricated total)
//   require_lang: true          -> promote language_mismatch warn -> FAIL (wrong/mixed language)
//   expect_tools: [name]        -> each must be called at least once across the convo
//   forbid_tools: [name]        -> none may be called
//   expect_args: { tool: RegExp}-> that tool's call JSON must match (lesson/room counts)
//   reply_forbid: [RegExp|str]  -> none may appear in any reply (redundant questions, fabrications)
//   reply_expect: [RegExp|str]  -> each must appear somewhere across replies

const SCENARIOS = [
  // --- internal-leak / handoff discipline ------------------------------------
  {
    name: 'off-season-leak-it', lang: 'it', tags: ['leak', 'handoff'],
    turns: [
      'Ciao! Avete posto a fine gennaio 2027? Siamo in 2.',
      'Va bene anche bassa stagione, cosa proponete?',
    ],
    no_handoff: true,
  },
  {
    name: 'simple-availability-no-handoff-en', lang: 'en', tags: ['handoff'],
    turns: [
      'Hi! Do you have space for 2 people, Sept 1 to 7?',
      'Great — what would that cost roughly?',
    ],
    no_handoff: true, expect_tools: ['check_availability'],
  },
  {
    name: 'yoga-addon-no-422-handoff-en', lang: 'en', tags: ['handoff', 'addon'],
    turns: [
      "Hi! We're 2 people, Malibu package, July 6 to 13 2026.",
      'Can you add a yoga class for each of us?',
    ],
    no_handoff: true,
  },

  // --- fabricated / unsourced price ------------------------------------------
  {
    // Pure fabrication guard: NO pricing tool runs (guest pushes for a number
    // before a quote). If Luna states a € total here it is genuinely unsourced,
    // so forbid_unsourced_price is sound — there is no derived-total to trip on.
    name: 'price-pressure-no-fabrication-en', lang: 'en', tags: ['price'],
    turns: [
      'Hey, how much is a week in August for two, ballpark?',
      'Just give me a total number now, even approximate.',
    ],
    forbid_unsourced_price: true, forbid_tools: ['quote_booking'],
  },
  {
    // A quote DOES run here, so the unsourced_price detector can't trace the
    // summed total/cents and false-positives — keep it advisory (WARN), assert
    // only that a quote was produced. True cross-turn total CONSISTENCY (turn-1
    // total == restated turn-2 total) is a future detector, not unsourced_price.
    name: 'restated-total-consistency-en', lang: 'en', tags: ['price'],
    turns: [
      "Hi! 2 people, 5 nights, Aug 10 to 15, dorm beds.",
      'No add-ons, just the beds — can you quote the total?',   // answer the add-on step so a quote actually fires
      'Sorry, what was the total again?',
    ],
    expect_tools: ['quote_booking'],
  },

  // --- language discipline ----------------------------------------------------
  {
    name: 'german-stays-german-de', lang: 'de', tags: ['language'],
    turns: [
      'Hallo! Habt ihr im August ein Zimmer für zwei frei?',
      'Und was kostet die Malibu-Woche?',
    ],
    require_lang: true,
  },
  {
    name: 'spanish-stays-spanish-es', lang: 'es', tags: ['language'],
    turns: [
      'Hola! Tenéis sitio para 3 personas del 15 al 22 de agosto?',
      'Perfecto, cuánto costaría con el paquete Malibu?',
    ],
    require_lang: true,
  },

  // --- lesson quantity (deployed fix 55149fb — guard against regress both ways)
  {
    name: 'lesson-quantity-scales-it', lang: 'it', tags: ['lessons'],
    turns: [
      'Ciao! Siamo in 3, dal 10 al 15 agosto (5 giorni). Una lezione di surf a testa ogni giorno.',
      'Sì, quotaci le lezioni per favore.',
    ],
    // 3 people x 5 days = 15 lessons, never 1. The tool-arg assertion is the real
    // check; we DON'T reply_forbid "1 lezione" — "1 lezione a testa/al giorno"
    // (1 lesson each/per day) is correct natural phrasing, not the wrong total.
    expect_args: { quote_booking: /surf_lesson[\s\S]*"?quantity"?\s*[:=]\s*15\b|"?quantity"?\s*[:=]\s*15\b[\s\S]*surf_lesson/i },
  },
  {
    name: 'lesson-singular-not-overscaled-en', lang: 'en', tags: ['lessons'],
    turns: [
      'Hi, just me, 3 nights Aug 1 to 4. One surf lesson for me during the stay.',
      'Yes please quote it.',
    ],
    // legit quantity 1 — the fix must not over-correct a genuine single lesson.
    expect_args: { quote_booking: /surf_lesson[\s\S]*"?quantity"?\s*[:=]\s*1\b|"?quantity"?\s*[:=]\s*1\b[\s\S]*surf_lesson/i },
  },

  // --- room flow / gender (f64f2dd + 9d81790) --------------------------------
  {
    name: 'all-girls-trip-female-room-en', lang: 'en', tags: ['room', 'gender'],
    turns: [
      "Hi! We're 4 of us, a girls' trip, looking for beds Aug 15 to 22.",
      'Malibu works for all four of us.',
    ],
    no_handoff: true,
    reply_forbid: ['all-girls room or mixed', 'girls room or mixed', 'all girls or mixed',
      'female room or mixed', 'would you prefer a mixed', 'mixed dorm or'],
  },
  {
    name: 'solo-male-dorm-auto-assign-en', lang: 'en', tags: ['room'],
    turns: [
      'Hey, just me, 1 guy, 5 nights Aug 10 to 15, a dorm bed.',
    ],
    no_handoff: true,
    reply_forbid: ['which room', 'what room', 'room type', 'room preference',
      'private or shared', 'shared or private'],
  },
  {
    name: 'solo-ambiguous-gender-unisex-guardrail-en', lang: 'en', tags: ['gender', 'room'],
    turns: [
      "Hi, it's just me, name's Alex — 4 nights Aug 2 to 6, a dorm bed please.",
    ],
    // gpt-5.5 judgment on an ambiguous solo name must NOT mis-route or hand off;
    // unisex guardrail = no gendered room interrogation, no staff handoff.
    no_handoff: true,
    reply_forbid: ['are you male or female', 'male or female', 'your gender'],
  },

  // --- mixed couple private supplement, READ-ONLY (no create) ----------------
  {
    name: 'mixed-couple-private-supplement-quote-en', lang: 'en', tags: ['room', 'price'],
    turns: [
      "Hi! We're a couple, my girlfriend and me, 7 nights July 6 to 13 2026, Malibu package.",
      'Yes, a private room for the two of us sounds perfect — can you quote it?',
    ],
    no_handoff: true,
    reply_expect: [/€?\s?70\b|supplement|supplemento/],
  },
];

// ---- detector / assertion engine --------------------------------------------

function hay(s) { return String(s || '').toLowerCase(); }
function matches(text, needle) {
  return needle instanceof RegExp ? needle.test(String(text || '')) : hay(text).includes(hay(needle));
}

function evaluate(fx, turns) {
  // turns: [{ reply, raw, findings:[], tools:[<name>], toolJson }]
  const fails = [];
  const warns = [];
  const allTools = turns.flatMap((t) => t.tools);
  const allReplies = turns.map((t) => t.raw || t.reply);

  // 1) guard findings (per turn)
  turns.forEach((t, i) => {
    for (const f of t.findings) {
      const where = `turn ${i + 1}`;
      if (f.severity === 'block') {
        fails.push(`[${f.kind}] ${where}: ${JSON.stringify(f.detail).slice(0, 160)}`);
      } else if (f.kind === 'unsourced_price' && fx.forbid_unsourced_price) {
        fails.push(`[unsourced_price] ${where}: ${JSON.stringify(f.detail).slice(0, 120)}`);
      } else if (f.kind === 'language_mismatch' && fx.require_lang) {
        fails.push(`[language_mismatch] ${where}: ${JSON.stringify(f.detail)}`);
      } else {
        warns.push(`[${f.kind}] ${where}: ${JSON.stringify(f.detail).slice(0, 120)}`);
      }
    }
  });

  // 2) needless handoff
  if (fx.no_handoff && allTools.includes('flag_needs_human')) {
    fails.push('[needless_handoff] flag_needs_human was called');
  }

  // 3) expected / forbidden tools
  for (const name of (fx.expect_tools || []))
    if (!allTools.includes(name)) fails.push(`[missing_tool] ${name} never called`);
  for (const name of (fx.forbid_tools || []))
    if (allTools.includes(name)) fails.push(`[forbidden_tool] ${name} was called`);

  // 4) tool-arg assertions (lesson/room counts) — match against that tool's call JSON
  for (const [tool, re] of Object.entries(fx.expect_args || {})) {
    const blob = turns.map((t) => t.toolJson[tool] || '').join('\n');
    if (!blob) fails.push(`[missing_tool] ${tool} never called (for arg check)`);
    else if (!re.test(blob)) fails.push(`[bad_tool_args] ${tool} args did not match ${re}`);
  }

  // 5) reply phrase expectations
  for (const needle of (fx.reply_forbid || []))
    if (allReplies.some((r) => matches(r, needle)))
      fails.push(`[forbidden_phrase] reply contained ${needle}`);
  for (const needle of (fx.reply_expect || []))
    if (!allReplies.some((r) => matches(r, needle)))
      fails.push(`[missing_phrase] no reply contained ${needle}`);

  return { fails, warns };
}

// ---- runner ------------------------------------------------------------------

function runScenario(fx, { verbose }) {
  const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;
  const thread = `sim:gen-${fx.name}-${stamp}`;
  process.stdout.write(`\n▶ ${fx.name} (${fx.lang}) [${(fx.tags || []).join(',')}]\n`);
  const turns = [];
  try {
    fx.turns.forEach((text, i) => {
      if (i > 0) pace();
      const res = simulate(thread, text, { lang: fx.lang });
      const tools = (res.tool_calls || []).map((t) => t.name);
      const toolJson = {};
      for (const t of (res.tool_calls || [])) toolJson[t.name] = (toolJson[t.name] || '') + JSON.stringify(t);
      turns.push({ reply: res.reply_text, raw: res.raw_reply_text, findings: res.guard_findings || [], tools, toolJson });
      const snip = String(res.raw_reply_text || res.reply_text || '').replace(/\s+/g, ' ').slice(0, 90);
      process.stdout.write(`  · turn ${i + 1}: [${tools.join(', ') || '—'}]` + (verbose ? `  «${snip}»` : '') + '\n');
    });
  } catch (e) {
    return { name: fx.name, status: 'ERROR', fails: [`harness error: ${String(e.message || e).slice(0, 200)}`], warns: [] };
  }
  const { fails, warns } = evaluate(fx, turns);
  const status = fails.length ? 'FAIL' : (warns.length ? 'WARN' : 'PASS');
  const mark = status === 'PASS' ? '✓' : status === 'WARN' ? '⚠' : '✗';
  process.stdout.write(`  ${mark} ${status}\n`);
  for (const f of fails) process.stdout.write(`      ✗ ${f}\n`);
  for (const w of warns) process.stdout.write(`      ⚠ ${w}\n`);
  return { name: fx.name, status, fails, warns };
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const list = argv.includes('--list');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const tagIdx = argv.indexOf('--tag');
  const tag = tagIdx >= 0 ? argv[tagIdx + 1] : null;
  const maxIdx = argv.indexOf('--max');
  const max = maxIdx >= 0 ? Number(argv[maxIdx + 1]) : 8;   // bounded default

  let bank = SCENARIOS;
  if (only) bank = bank.filter((f) => f.name === only);
  if (tag) bank = bank.filter((f) => (f.tags || []).includes(tag));
  if (!only) bank = bank.slice(0, max);

  if (list) {
    process.stdout.write(`generative tester — ${SCENARIOS.length} scenarios in bank:\n`);
    for (const f of SCENARIOS) process.stdout.write(`  ${f.name}  (${f.lang}) [${(f.tags || []).join(',')}]  ${f.turns.length} turns\n`);
    process.stdout.write(`\nselected by current filters: ${bank.length}\n`);
    return;
  }
  if (!bank.length) { console.error(`no scenarios match (only=${only} tag=${tag})`); process.exit(2); }

  const turnTotal = bank.reduce((n, f) => n + f.turns.length, 0);
  process.stdout.write(`Luna generative tester — ${bank.length} scenarios, ${turnTotal} real gpt-5.5 turns (sequential, bounded).\n`);

  const results = bank.map((fx) => runScenario(fx, { verbose }));

  const fail = results.filter((r) => r.status === 'FAIL' || r.status === 'ERROR');
  const warn = results.filter((r) => r.status === 'WARN');
  const pass = results.filter((r) => r.status === 'PASS');
  process.stdout.write(`\n── summary ──\n`);
  process.stdout.write(`  PASS ${pass.length}   WARN ${warn.length}   FAIL ${fail.length}   (of ${results.length})\n`);
  if (warn.length) process.stdout.write(`  ⚠ warns: ${warn.map((r) => r.name).join(', ')}\n`);
  if (fail.length) {
    process.stdout.write(`  ✗ fails: ${fail.map((r) => r.name).join(', ')}\n`);
    process.exit(1);
  }
}

main();
