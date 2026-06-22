'use strict';

/**
 * Slice C — deterministic SOUL per-guest conversational contract lock.
 *
 * The per-guest booking feature is live. This gate reads docker/hermes-staging/SOUL.md
 * and asserts that the per-guest conversational contract is still spelled out in the
 * prompt, so a future SOUL.md tweak that silently drops a rule fails LOUDLY here.
 *
 * It does NOT modify SOUL.md and does NOT run the engine — it is a pure text contract
 * check over the live prompt. Matching is tolerant of minor wording (substring/regex),
 * so harmless rephrasing keeps passing while a dropped rule fails.
 *
 * The contract (rules currently in docker/hermes-staging/SOUL.md):
 *   1. Collect ALL guest names (one per person), asked in the "how many people" step.
 *   2. Assign each guest a bed.
 *   3. Per-guest deposits: short stay (<7 nights) = €100/guest; package = €200/guest.
 *   4. Offer "pay in full, or a payment link each" (per-guest links vs whole-booking).
 *   5. "Only 1 person needs to pay the deposit to lock the booking."
 *   6. Packages: show price per person, make mix-and-match clear, do NOT name which
 *      guest has which package unless told.
 *   7. Never pass guest_phone to create_booking_from_plan (auto from WhatsApp sender).
 */

const fs = require('fs');
const path = require('path');

const SOUL_PATH = path.join(__dirname, '..', 'docker', 'hermes-staging', 'SOUL.md');
const soulRaw = fs.readFileSync(SOUL_PATH, 'utf8');
// Normalise whitespace so multi-line phrasings still match a single regex.
const soul = soulRaw.replace(/\s+/g, ' ');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-perguest-soul-contract.js\n');

section('Rule 1 — collect ALL guest names in the "how many people" step');
{
  // Every guest's name, one per person — not a single booking name.
  const everyName = /every (?:guest'?s? name|one'?s? (?:first )?names)|all (?:the )?(?:guest )?names|all guest names/i.test(soul)
    || /collect (?:every|all)[^.]*name/i.test(soul);
  check('R1a', everyName, 'SOUL instructs collecting every/all guest names (one per person)');

  // Names are gathered alongside the "how many / guest count" ask (Step 1), not later.
  const namesWithCount = /(?:how many|guest count|guests)[^.]*\bnames\b/i.test(soul)
    || /\bnames\b[^.]*(?:how many|guest count)/i.test(soul)
    || /dates \+ guest count \+ names/i.test(soul)
    || /everyone'?s (?:first )?names/i.test(soul);
  check('R1b', namesWithCount, 'names are asked together with the guest-count / "how many" step');

  // Passed as guests:[{name},…] (one per person) rather than a single booking name.
  const guestsArray = /guests\s*:\s*\[\s*\{\s*name/i.test(soul) || /guests:\[\{name/i.test(soul);
  check('R1c', guestsArray, 'names passed as guests:[{name},…] (per person, not one booking name)');
}

section('Rule 2 — assign each guest a bed');
{
  const bedEach = /per-guest[^.]*\bbed\b/i.test(soul)
    || /\ba bed each\b/i.test(soul)
    || /bed (?:each|per guest)/i.test(soul)
    || /enables[^.]*bed each/i.test(soul);
  check('R2', bedEach, 'SOUL ties per-guest names to a bed each / per-guest bed assignment');
}

section('Rule 3 — per-guest deposits €100 short stay, €200 package');
{
  const oneHundred = /€\s*100/.test(soul);
  const twoHundred = /€\s*200/.test(soul);
  check('R3a', oneHundred, 'short-stay per-guest deposit amount €100 present');
  check('R3b', twoHundred, 'package per-guest deposit amount €200 present');
  // The deposit is framed per guest / per person, not a single whole-booking amount.
  const perGuestFraming = /per[- ]guest deposits?/i.test(soul)
    || /enables per-guest deposits/i.test(soul)
    || /€\s*\d+[^.]*per (?:guest|person)/i.test(soul);
  check('R3c', perGuestFraming, 'deposits framed as per-guest / per-person');
}

section('Rule 4 — "pay in full, or a payment link each"');
{
  const payInFull = /pay in full/i.test(soul);
  // Per-guest link phrasing — tolerate "a link each" / "payment link each" / "each person their own".
  const linkEach = /\ba link each\b/i.test(soul)
    || /payment link (?:for )?each(?: person)?/i.test(soul)
    || /each person their own (?:payment )?link/i.test(soul)
    || /link for each person/i.test(soul);
  check('R4a', payInFull, 'SOUL offers a "pay in full" option');
  check('R4b', linkEach, 'SOUL offers a per-guest "a link each" / payment link per person option');
  check('R4c', payInFull && linkEach, 'the payment question offers BOTH pay-in-full AND a link each');
}

section('Rule 5 — only one person needs to pay the deposit to lock the booking');
{
  // one / 1 person + deposit + lock the booking
  const onePerson = /\b(?:one|1)\b[^.]*\bdeposit\b[^.]*\block\b/i.test(soul)
    || /\bdeposit\b[^.]*\block(?:s)? the booking/i.test(soul)
    || /(?:just |only )?(?:one|1) €?\s*\d*\s*deposit (?:locks|to lock)/i.test(soul);
  check('R5', onePerson, 'SOUL says one/1 deposit locks the booking (rest pay anytime)');
}

section('Rule 6 — packages: per-person price, mix & match, no per-guest package naming');
{
  const perPerson = /price per person|per[- ]person price|€\s*Y?\/person|\/person/i.test(soul);
  check('R6a', perPerson, 'packages shown at price per person');

  const mixMatch = /mix (?:and|&|-and-) match|mix & match|mix-and-match/i.test(soul);
  check('R6b', mixMatch, 'mix-and-match across guests is made clear');

  // Do NOT label which guest has which package unless the guest says who wants what.
  const noNaming = /(?:do ?n['o]?t (?:assign|label)|never (?:assign|label|name))[^.]*package[^.]*unless/i.test(soul)
    || /unless the guest (?:tells|names)[^.]*(?:who wants what|package)/i.test(soul)
    || /do ?n['o]?t (?:assign|label)[^.]*package to a specific person/i.test(soul);
  check('R6c', noNaming, 'do NOT name which guest has which package unless told');
}

section('Rule 7 — never pass guest_phone to create_booking_from_plan');
{
  const neverPhone = /never pass `?guest_phone`? to create_booking_from_plan/i.test(soul)
    || /never pass `?guest_phone`?/i.test(soul);
  check('R7a', neverPhone, 'SOUL forbids passing guest_phone to create_booking_from_plan');
  const autoFromSender = /(?:taken automatically|auto(?:matically)?)[^.]*(?:whatsapp )?sender/i.test(soul)
    || /from the whatsapp sender/i.test(soul);
  check('R7b', autoFromSender, 'guest_phone is taken automatically from the WhatsApp sender');
}

console.log(`\n── verify-luna-perguest-soul-contract ${failures ? 'FAILED' : 'PASSED'} (${passes}/${passes + failures}) ──\n`);
process.exit(failures > 0 ? 1 : 0);
