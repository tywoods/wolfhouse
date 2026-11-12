'use strict';
// Offline: no provider, guest send or business writes.
const assert = require('node:assert/strict');
const {
  handoffWarmNoteText, isHandoffWarmNote, shouldSendHandoffWarmNote,
  sendHandoffWarmNoteIfNeeded,
} = require('./lib/luna-guest-handoff-warm-note');

async function main() {
  const expected = {
    en: 'A staff member will help you from here.',
    es: 'Una persona del equipo te va a ayudar.',
    it: 'Una persona del team ti aiuterà.',
    de: 'Ein Teammitglied hilft dir weiter.',
    fr: "Un membre de l'equipe va t'aider.",
  };
  for (const [language, text] of Object.entries(expected)) {
    assert.equal(handoffWarmNoteText(language), text);
    for (const staff_member_name of ['', 'Ale']) {
      const note = handoffWarmNoteText(language, staff_member_name);
      assert.doesNotMatch(note, /shortly|enseguida|a breve|gleich|tout de suite/);
      assert.ok(isHandoffWarmNote(note));
      assert.equal(shouldSendHandoffWarmNote({ language, staff_member_name,
        recentOutboundTexts: [note] }).send, false);
    }
  }
  assert.equal(handoffWarmNoteText('unknown'), expected.en);
  assert.equal(shouldSendHandoffWarmNote({recentOutboundTexts: [
    'A staff member will help you from here — someone from the team will write to you shortly.',
  ]}).send, false, 'historical notes still suppress duplicates');
  const calls = [];
  const result = await sendHandoffWarmNoteIfNeeded({ language: 'en',
    sendGuestNote: async payload => { calls.push(payload.text); return { sent: true }; } });
  assert.equal(result.sent, true);
  assert.deepEqual(calls, [expected.en]);
  console.log('PASS warm handoff: five languages, named/unnamed, fallback, old/new dedup, offline sender');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
