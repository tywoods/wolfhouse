'use strict';

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  handoffWarmNoteText,
  isHandoffWarmNote,
} = require('./lib/luna-guest-handoff-warm-note');

const EMPTY_EN = "I'm getting a staff member to help you, they'll be with you shortly.";
const EMPTY_ES = 'Voy a buscar a alguien del equipo para ayudarte, enseguida estarán contigo.';
const EMPTY_IT = 'Sto chiamando un membro del team per aiutarti, saranno da te a breve.';
const EMPTY_DE = 'Ich hole ein Teammitglied, das dir hilft — jemand ist gleich bei dir.';
const EMPTY_FR = "Je vais chercher quelqu'un de l'equipe pour t'aider, ils seront la tout de suite.";

assert.equal(handoffWarmNoteText('en'), EMPTY_EN);
assert.equal(handoffWarmNoteText('en', ''), EMPTY_EN);
assert.equal(handoffWarmNoteText('en', '   '), EMPTY_EN);
assert.equal(handoffWarmNoteText('es'), EMPTY_ES);
assert.equal(handoffWarmNoteText('it'), EMPTY_IT);
assert.equal(handoffWarmNoteText('de'), EMPTY_DE);
assert.equal(handoffWarmNoteText('fr'), EMPTY_FR);

assert.equal(
  handoffWarmNoteText('en', 'Camila'),
  "I'm getting Camila to help you, they'll be with you shortly.",
);
assert.equal(
  handoffWarmNoteText('es', 'Camila'),
  'Voy a buscar a Camila para ayudarte, enseguida estará contigo.',
);
assert.equal(
  handoffWarmNoteText('it', 'Camila'),
  'Sto chiamando Camila per aiutarti, sarà da te a breve.',
);
assert.equal(
  handoffWarmNoteText('de', 'Camila'),
  'Ich hole Camila, der dir hilft — jemand ist gleich bei dir.',
);
assert.equal(
  handoffWarmNoteText('fr', 'Camila'),
  "Je vais chercher Camila pour t'aider, iels seront la tout de suite.",
);
assert.equal(isHandoffWarmNote(handoffWarmNoteText('en', 'Camila')), true);
assert.equal(isHandoffWarmNote(EMPTY_EN), true);

const py = spawnSync('python3', ['-c', `
from wolfhouse_staff_api.handoff_guest_note import default_guest_note
empty = "I'm getting a staff member to help you, they'll be with you shortly."
assert default_guest_note('en') == empty
assert default_guest_note('en', '') == empty
assert default_guest_note('en', 'Camila') == (
    "I'm getting Camila to help you, they'll be with you shortly."
)
assert default_guest_note('es', 'Camila') == 'Voy a buscar a Camila para ayudarte, enseguida estará contigo.'
from wolfhouse_staff_api.handoff_guest_note import resolve_guest_note, STAFF_INFO_BOT_PATH
assert STAFF_INFO_BOT_PATH == '/staff/bot/staff-info'
called = {'n': 0}
def fake_fetch():
    called['n'] += 1
    return {'success': True, 'staff_member_name': 'Camila'}
note = resolve_guest_note({'language': 'en'}, None, fetch_staff_info=fake_fetch)
assert note == "I'm getting Camila to help you, they'll be with you shortly.", note
assert called['n'] == 1
stale = resolve_guest_note({'language': 'en'}, 'Your booking has not been saved. Please try again shortly.')
assert stale == empty
empty_note = resolve_guest_note({'language': 'en'}, None, fetch_staff_info=lambda: {'staff_member_name': ''})
assert empty_note == empty
print('python_ok')
`], {
  cwd: path.join(__dirname, '..', 'docker', 'hermes-staging'),
  env: { ...process.env, PYTHONPATH: '.:plugins' },
  encoding: 'utf8',
});
assert.equal(py.status, 0, py.stderr || py.stdout);
assert.match(py.stdout || '', /python_ok/);

console.log('verify-staff-info-name: PASS');
