#!/usr/bin/env node
'use strict';

/**
 * verify-luna-handoff-promise-detection
 *
 * Keeps Luna's handoff copy and the staff-facing handoff state in sync.
 *
 * A reply that promises a human takeover must also flag the conversation, or nobody
 * picks it up. The explicit `flag_needs_human` tool call is the trustworthy signal;
 * outbound-copy detection is the safety net. This gate asserts:
 *
 *   - the shared corpus (positives + negatives) against the JS owner module,
 *   - that the Hermes Python mirror carries byte-identical pattern sources,
 *   - that both mirror paths turn a detected promise into needs_human,
 *   - that SOUL makes the tool call mandatory whenever the copy promises a person.
 *
 * Offline: no database, no network, no test framework. Python is used only as an
 * optional cross-check and is skipped when no interpreter is present.
 *
 * Run: node scripts/verify-luna-handoff-promise-detection.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CORPUS_PATH = path.join(ROOT, 'fixtures/luna-handoff-promise-corpus.json');
const OWNER_PATH = path.join(ROOT, 'scripts/lib/luna-guest-handoff-promise.js');
const PY_MIRROR_PATH = path.join(ROOT, 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py');
const JS_MIRROR_PATH = path.join(ROOT, 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js');
const PERSIST_PATH = path.join(ROOT, 'scripts/lib/luna-guest-handoff-persist.js');
const CAMI_PATH = path.join(ROOT, 'scripts/lib/luna-guest-cami-reply-author.js');
const COACH_PATH = path.join(ROOT, 'scripts/lib/luna-guest-coach-evaluator.js');
const SOUL_WH_PATH = path.join(ROOT, 'docker/hermes-staging/SOUL.md');
const SOUL_SU_PATH = path.join(ROOT, 'docker/hermes-sunset/SOUL.md');

const LIVE_FAILURE_TEXT = 'a teammate will take over and sort those for you';

const PY_BEGIN = '# --- BEGIN LUNA_HANDOFF_PROMISE_PATTERNS ---';
const PY_END = '# --- END LUNA_HANDOFF_PROMISE_PATTERNS ---';

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

function short(text, max = 62) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

console.log('\nverify-luna-handoff-promise-detection — Luna handoff copy ⇄ needs_human state\n');

const corpus = JSON.parse(read(CORPUS_PATH));
const positives = corpus.positives || [];
const negatives = corpus.negatives || [];
const { HANDOFF_PROMISE_PATTERNS, detectHandoffPromise } = require('./lib/luna-guest-handoff-promise');

section('[1] Corpus shape');
check('corpus has positives and negatives', positives.length >= 20 && negatives.length >= 10,
  `${positives.length} positives, ${negatives.length} negatives`);
check('every corpus entry carries text + source',
  [...positives, ...negatives].every((e) => e && typeof e.text === 'string' && e.text.trim() && typeof e.source === 'string' && e.source.trim()));
const liveEntry = positives.find((e) => String(e.text).toLowerCase().includes(LIVE_FAILURE_TEXT));
check('corpus contains the live thread that stranded a guest', !!liveEntry, `missing: "${LIVE_FAILURE_TEXT}"`);
check('the live thread entry is marked live_failure', !!liveEntry && liveEntry.live_failure === true);
check('corpus names its owner module and gate',
  corpus.owner === 'scripts/lib/luna-guest-handoff-promise.js'
  && corpus.gate === 'scripts/verify-luna-handoff-promise-detection.js');

section('[2] Owner detector (scripts/lib/luna-guest-handoff-promise.js)');
{
  const missed = [];
  for (const entry of positives) {
    if (detectHandoffPromise(entry.text).handoff_promised !== true) missed.push(entry.text);
  }
  check(`all ${positives.length} handoff phrasings detected`, missed.length === 0,
    missed.map((t) => `\n          not detected: "${short(t)}"`).join(''));

  const overFired = [];
  for (const entry of negatives) {
    const res = detectHandoffPromise(entry.text);
    if (res.handoff_promised === true) overFired.push(`${res.pattern_id}: "${short(entry.text)}"`);
  }
  check(`none of the ${negatives.length} non-handoff phrasings fire`, overFired.length === 0,
    overFired.map((t) => `\n          over-fired ${t}`).join(''));

  check('blank input is not a handoff',
    detectHandoffPromise('').handoff_promised === false
    && detectHandoffPromise(null).handoff_promised === false
    && detectHandoffPromise('   ').handoff_promised === false);
  check('Hernan take_request copy is suppressed (passed request, nothing booked)',
    detectHandoffPromise(
      "I've passed your request to the team — nothing is booked yet.",
    ).handoff_promised === false
    && detectHandoffPromise(
      "I've passed your request to the team — nothing is booked yet.",
    ).suppressed_by === 'sunset_take_request_queue');
}

section('[3] Hermes Python mirror carries the same patterns');
const pySource = read(PY_MIRROR_PATH);
{
  const start = pySource.indexOf(PY_BEGIN);
  const end = pySource.indexOf(PY_END);
  check('pattern block markers present in wolfhouse_whatsapp_mirror.py', start !== -1 && end > start,
    `expected ${PY_BEGIN} … ${PY_END}`);

  const block = start !== -1 && end > start ? pySource.slice(start, end) : '';
  const extracted = [];
  const tupleRe = /\(\s*"([a-z0-9_]+)"\s*,\s*r"([^"]*)"\s*\)/g;
  let m;
  while ((m = tupleRe.exec(block)) !== null) extracted.push({ id: m[1], source: m[2] });

  check('python block lists the same number of patterns as the owner module',
    extracted.length === HANDOFF_PROMISE_PATTERNS.length,
    `python ${extracted.length} vs js ${HANDOFF_PROMISE_PATTERNS.length}`);

  const drifted = [];
  HANDOFF_PROMISE_PATTERNS.forEach((jsPattern, i) => {
    const pyPattern = extracted[i];
    if (!pyPattern || pyPattern.id !== jsPattern.id || pyPattern.source !== jsPattern.source) {
      drifted.push(jsPattern.id);
    }
  });
  check('python pattern sources are byte-identical to the owner module', drifted.length === 0,
    drifted.length ? `drifted: ${drifted.join(', ')}` : '');

  let compiled = null;
  try {
    compiled = extracted.map((p) => ({ id: p.id, re: new RegExp(p.source, 'i') }));
    pass('every python pattern source compiles');
  } catch (err) {
    fail('every python pattern source compiles', err.message);
  }

  if (compiled && compiled.length) {
    const detectWithPyPatterns = (text) => compiled.find((p) => p.re.test(String(text || '')));
    const missedRaw = positives.filter((e) => !detectWithPyPatterns(e.text)).map((e) => e.text);
    check('corpus positives match the python pattern sources (raw)', missedRaw.length === 0,
      missedRaw.map((t) => `\n          not detected: "${short(t)}"`).join(''));
  }

  check('python mirror applies sunset take_request safe harbor',
    /def is_sunset_take_request_queue_reply\(/.test(pySource)
    && /is_sunset_take_request_queue_reply\(raw\)/.test(pySource));
  check('a detected promise reports which pattern matched (JS owner)',
    detectHandoffPromise(LIVE_FAILURE_TEXT).pattern_id === 'human_subject_will_act');

  const { isSunsetTakeRequestQueueReply } = require('./lib/luna-guest-handoff-promise');
  const detectWithSafeHarbor = (text) => {
    const raw = String(text || '');
    if (isSunsetTakeRequestQueueReply(raw)) return null;
    return compiled.find((p) => p.re.test(raw));
  };
  if (compiled && compiled.length) {
    const overFired = negatives.filter((e) => detectWithSafeHarbor(e.text)).map((e) => e.text);
    check('corpus negatives survive python patterns + take_request safe harbor', overFired.length === 0,
      overFired.map((t) => `\n          over-fired: "${short(t)}"`).join(''));
  }
}

section('[4] A detected promise reaches conversations.needs_human');
{
  check('python mirror routes outbound text through detects_handoff_promise only after wamid',
    /def detects_handoff_promise\(/.test(pySource)
    && /direction == "outbound" and wa_id and detects_handoff_promise\(msg\)/.test(pySource));
  check('python mirror sets needs_human + handoff_reason on the payload',
    /payload\["needs_human"\] = True/.test(pySource)
    && /payload\["handoff_reason"\] = HANDOFF_PROMISE_REASON/.test(pySource));
  check('python mirror no longer keeps a second hardcoded phrase regex',
    !/_NEEDS_HUMAN_RE/.test(pySource));

  const jsMirror = read(JS_MIRROR_PATH);
  check('staff-side mirror writes needs_human = TRUE for a flagged outbound',
    /needs_human === true/.test(jsMirror) && /SET needs_human = TRUE/.test(jsMirror));
  check('staff-side mirror keeps a handoff reason on the conversation',
    /needs_human_reason/.test(jsMirror) && /luna_team_review_reply/.test(jsMirror));

  const persist = read(PERSIST_PATH);
  check('legacy JS reply path delegates to the owner module',
    /require\('\.\/luna-guest-handoff-promise'\)/.test(persist)
    && /function isGenuineLunaHandoffReply\(text\) \{\s*return isHandoffPromiseReply\(text\);/.test(persist));
  const { isGenuineLunaHandoffReply } = require('./lib/luna-guest-handoff-persist');
  check('legacy JS reply path detects the live thread phrasing',
    isGenuineLunaHandoffReply(LIVE_FAILURE_TEXT) === true);
  check('legacy JS reply path still ignores non-handoff team mentions',
    isGenuineLunaHandoffReply('If conditions change, the team will know the best window.') === false);
}

section('[5] No parallel handoff-copy detectors left');
{
  const cami = read(CAMI_PATH);
  check('Cami handoff-copy guard uses the owner module',
    /require\('\.\/luna-guest-handoff-promise'\)/.test(cami)
    && /isHandoffPromiseReply\(text\) && handoff\.handoff_required !== true/.test(cami)
    && !/HANDOFF_COPY_RE/.test(cami));

  const coach = read(COACH_PATH);
  check('coach evaluator uses the owner module',
    /require\('\.\/luna-guest-handoff-promise'\)/.test(coach) && !/HANDOFF_RE/.test(coach));
}

section('[6] SOUL makes flag_needs_human mandatory with the copy');
{
  const soulWh = read(SOUL_WH_PATH);
  const soulSu = read(SOUL_SU_PATH);
  for (const [label, soul] of [['Wolfhouse', soulWh], ['Sunset', soulSu]]) {
    check(`${label} SOUL forbids promising a person without flag_needs_human`,
      /Never promise a person without flagging it/i.test(soul)
      && /MUST call \*\*flag_needs_human\*\* in that same turn/i.test(soul));
    check(`${label} SOUL names the promise phrasings that require the tool`,
      /take\s+over/i.test(soul) && /get\s+back\s+to\s+them/i.test(soul) && /follow\s+up/i.test(soul));
    check(`${label} SOUL still tells Luna not to use the phrasing when she is not handing off`,
      /do not use that phrasing/i.test(soul));
  }
  check('Wolfhouse SOUL keeps the non-handoff exceptions intact',
    /never\**\s+a reason to hand off/i.test(soulWh)
    && /Never call flag_needs_human for private\/couple room requests/i.test(soulWh)
    && /Do \*\*not\*\* call \*\*flag_needs_human\*\*/i.test(soulWh));
}

section('[7] Python engine cross-check (optional)');
{
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("wh_mirror", ${JSON.stringify(PY_MIRROR_PATH)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
corpus = json.load(open(${JSON.stringify(CORPUS_PATH)}, encoding="utf-8"))
out = {
  "missed": [e["text"] for e in corpus["positives"] if not mod.detects_handoff_promise(e["text"])],
  "over_fired": [e["text"] for e in corpus["negatives"] if mod.detects_handoff_promise(e["text"])],
}
print(json.dumps(out))
`;
  let raw = null;
  try {
    raw = execFileSync('python3', ['-c', script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || '').slice(0, 400);
    if (err && (err.code === 'ENOENT' || /not found/i.test(detail))) {
      skip('python3 corpus cross-check', 'no python3 interpreter on this machine');
    } else {
      fail('python3 corpus cross-check', detail);
    }
  }
  if (raw != null) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw.trim().split('\n').pop());
    } catch (err) {
      fail('python3 corpus cross-check output parses', err.message);
    }
    if (parsed) {
      check('python re engine detects every corpus positive', parsed.missed.length === 0,
        parsed.missed.map((t) => `\n          not detected: "${short(t)}"`).join(''));
      check('python re engine rejects every corpus negative', parsed.over_fired.length === 0,
        parsed.over_fired.map((t) => `\n          over-fired: "${short(t)}"`).join(''));
    }
  }
}

console.log(`\nverify-luna-handoff-promise-detection: ${passes} passed, ${failures} failed${skips ? `, ${skips} skipped` : ''}\n`);
process.exit(failures > 0 ? 1 : 0);
