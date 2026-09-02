'use strict';

/**
 * verify:sunset-soul-contract
 *
 * Durable behavioral gate for docker/hermes-sunset/SOUL.md — the Sunset Luna
 * voice + boundary contract. Tests RULES, not exact sentences: it fails if a
 * warmth/variation/emoji/tool-failure rule is removed, or if accidental
 * Wolfhouse/accommodation language or a guest-facing "Cami" identity slips in.
 *
 * Run:
 *   node scripts/verify-sunset-soul-contract.js
 */

const fs = require('fs');
const path = require('path');

const SOUL_PATH = path.join(__dirname, '..', 'docker', 'hermes-sunset', 'SOUL.md');
const soul = fs.readFileSync(SOUL_PATH, 'utf8');
const lower = soul.toLowerCase();

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

console.log('\nverify:sunset-soul-contract — Sunset Luna voice + boundary rules\n');

console.log('[Voice — variation & emoji restraint]');
assert('warmth is not emoji substitution',
  /warmth[\s\S]{0,120}(not|never)[\s\S]{0,80}(emoji|sprinkl)/i.test(soul)
  || /never from sprinkling an emoji/i.test(soul));
assert('no repeated emoji in consecutive replies',
  /(same emoji|repeat the same emoji)[\s\S]{0,60}consecutive|never repeat the same emoji/i.test(soul));
assert('😊 capped across three consecutive replies',
  /😊[\s\S]{0,80}(once|three consecutive)/i.test(soul) || /once in any three consecutive/i.test(soul));
assert('at least one of three replies uses no emoji',
  /no emoji at all/i.test(soul) || /use no emoji/i.test(soul));
assert('warmth must survive without emojis', /warmth must survive without emoji/i.test(soul));

console.log('\n[Voice — openers, checklist, names]');
assert('does not habitually open with stock celebrations',
  /do not habitually (begin|open)/i.test(soul)
  && /perfect/i.test(soul) && /great/i.test(soul));
assert('bans "Thanks [name]" / "Of course" / "No problem" openers',
  /thanks \[name\]/i.test(soul) && /of course/i.test(lower) && /no problem/i.test(lower));
assert('do not reuse the same opener consecutively',
  /never reuse the same opener|do not repeat the same opener/i.test(soul));
assert('avoid administrative checklist repetition',
  /checklist repetition|administrative checklist/i.test(soul));
assert('use names sparingly', /names?\s*—?\s*sparingly|use the guest'?s name only after/i.test(soul));

console.log('\n[First reply — hospitality before intake]');
assert('every fresh conversation starts with a human welcome',
  /every fresh conversation starts with a real human welcome/i.test(soul));
assert('bare greetings are not forced into lesson-versus-rental intake',
  /do not immediately force a lesson-versus-rental choice/i.test(soul));
assert('first reply may contain no intake question',
  /social first message may simply welcome|no intake question is allowed/i.test(soul));
assert('explicit booking intent still gets welcome plus one next detail',
  /explicit booking intent:[^\n]*welcome[^\n]*next missing detail/i.test(soul));
assert('clipped administrative first-line paraphrase is forbidden',
  /never make the first line a clipped administrative paraphrase/i.test(soul));

console.log('\n[Tool-failure ownership — no false confirmation]');
assert('calm tool-failure ownership copy present',
  /couldn'?t finish that booking just yet/i.test(soul) && /checking it with the team/i.test(soul));
assert('never falsely confirm on tool failure',
  /no false confirmation|never (imply|say)[\s\S]{0,60}(went through|created|confirmed)/i.test(soul)
  || /never confirm a booking is held without the create succeeding/i.test(soul));

console.log('\n[Preserved Sunset facts & boundaries]');
assert('one clear question per reply preserved', /one clear question (or next step )?per reply/i.test(soul));
assert('latest-message language matching preserved', /latest message/i.test(soul));
assert('peninsular/Castilian Spanish preserved', /peninsular|castilian|vosotros/i.test(soul));
assert('facts/prices/links only from tools', /only from these|come from tools\/config only|never invent/i.test(soul));
assert('no accommodation boundary intact',
  /no accommodation/i.test(soul) && /never import accommodation/i.test(soul));
assert('handoff only on explicit reasons', /only on explicit reasons/i.test(soul));

console.log('\n[Dates — omitted year]');
assert('Europe/Madrid omitted-year rule documented', /europe\/madrid/i.test(soul));
assert('never ask which year unless ambiguous', /never ask which year/i.test(soul));
assert('state inferred full date before booking', /state the full date naturally/i.test(soul));

console.log('\n[Lock-in + name — single step]');
assert('no separate shall I lock it in when intent clear', /do \*\*not\*\* ask a separate "shall i lock it in/i.test(soul));
assert('name-for-booking wording guidance', /name for the booking|nombre para la reserva/i.test(soul));
assert('quote-only must not create booking', /never create a booking from a quote request alone/i.test(soul));
assert('multilingual phrasing guidance', /guest'?s \*\*current language\*\*|current language/i.test(soul));

console.log('\n[Booking truth — Staff API, fail closed]');
assert('list_sunset_bookings is a documented tool', /list_sunset_bookings/.test(soul));
assert('never deny after successful create', /never say nothing is booked|never deny that booking/i.test(soul));
assert('ask rather than contradict when list is unclear', /ask rather than contradict/i.test(soul));
assert('take_request nothing-booked copy is scoped to no successful create',
  /take_request/.test(soul) && /already created|create_sunset_booking succeeds/i.test(soul));

console.log('\n[No accidental Wolfhouse / guest-facing Cami leakage]');
assert('Cami only appears in a never-mention boundary (not guest-facing identity)',
  !/cami/i.test(soul) || /never mention[^.\n]*cami/i.test(soul));
assert('Wolfhouse only referenced as a forbidden boundary',
  !/wolf-?house/i.test(soul) || /never mention[^.\n]*wolf-?house/i.test(soul));
assert('no guest-facing rooms/dorms/beds/nights offering',
  !/\b(book|reserve|offer)[^.\n]{0,40}\b(room|dorm|bed|nights?)\b/i.test(soul));

console.log(`\n── verify:sunset-soul-contract ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
if (fail > 0) process.exit(1);
