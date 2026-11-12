'use strict';

/**
 * Every Needs-human path uses the one standard warm note.
 * Guest "I paid but got nothing" / "passed to the team" copy is never sent.
 * Run: node scripts/verify-handoff-standard-warm-note.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WARM_NOTE,
  handoffWarmNoteText,
  isHandoffWarmNote,
} = require('./lib/luna-guest-handoff-warm-note');

assert.match(WARM_NOTE.en, /getting a staff member to help you/i);
assert.match(WARM_NOTE.en, /shortly/);
assert.doesNotMatch(WARM_NOTE.en, /passed to the team|nothing booked|can't arrange/i);

assert.equal(
  handoffWarmNoteText('en'),
  "I'm getting a staff member to help you, they'll be with you shortly.",
);
assert.equal(isHandoffWarmNote(WARM_NOTE.en), true);
assert.equal(isHandoffWarmNote('Your discount request has been passed to the team for review'), false);
assert.equal(isHandoffWarmNote("I can't arrange staff help here"), false);

const py = fs.readFileSync(
  path.join(__dirname, '../docker/hermes-staging/plugins/wolfhouse_staff_api/handoff_guest_note.py'),
  'utf8',
);
assert.match(py, /I'm getting a staff member to help you/);
assert.match(py, /_PASSED_TO_TEAM_RE/);
assert.doesNotMatch(py, /reason == owner\.PAYMENT_REPORTED_UNRESOLVED/);

const persist = fs.readFileSync(
  path.join(__dirname, '../docker/hermes-staging/wolfhouse/explicit_human_handoff.py'),
  'utf8',
);
assert.match(persist, /Guest-reported payment problems/);
assert.doesNotMatch(
  persist,
  /if \(reason == PAYMENT_REPORTED_UNRESOLVED\s*\n\s*or re\.fullmatch/,
);

console.log('PASS standard warm note; payment-reported handoff no longer skipped');
