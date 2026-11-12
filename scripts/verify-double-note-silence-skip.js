'use strict';

const assert = require('node:assert/strict');
const {
  shouldSendHandoffWarmNote,
  sendHandoffWarmNoteIfNeeded,
  handoffWarmNoteText,
} = require('./lib/luna-guest-handoff-warm-note');

const camilaNote = "I couldn't add Timmy's yoga class, so it hasn't been booked or charged, and no new payment link has been created. 🧘 I'm getting Camila to help with the class and payment link. 😊";

const silenceAfterHandoff = shouldSendHandoffWarmNote({
  language: 'en',
  recentOutboundTexts: [camilaNote],
  alreadyNeedsHuman: true,
  openHandoff: true,
});
assert.equal(silenceAfterHandoff.send, false, 'silence must not send a second note after Camila warm note');
assert.equal(silenceAfterHandoff.reason, 'already_sent');

let sent = 0;
async function sendGuestNote() {
  sent += 1;
  return { ok: true, sent: true };
}

async function run() {
const fired = await sendHandoffWarmNoteIfNeeded({
  language: 'en',
  recentOutboundTexts: [camilaNote],
  alreadyNeedsHuman: true,
  openHandoff: true,
  sendGuestNote,
});
assert.equal(fired.sent, false);
assert.equal(fired.skipped, 'already_sent');
assert.equal(sent, 0, 'silence timer must not send another guest message');

const firstNeedsHuman = shouldSendHandoffWarmNote({
  language: 'en',
  recentOutboundTexts: ['Yes — we can add one yoga class for Timmy.'],
  alreadyNeedsHuman: false,
  openHandoff: false,
});
assert.equal(firstNeedsHuman.send, true, 'first Needs human still gets the warm note');
assert.equal(firstNeedsHuman.text, handoffWarmNoteText('en'));

console.log('verify-double-note-silence-skip: PASS');
}
run().catch((err) => { console.error(err); process.exit(1); });
