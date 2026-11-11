'use strict';

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const {
  handoffWarmNoteText,
  isHandoffWarmNote,
} = require('./lib/luna-guest-handoff-warm-note');

const EMPTY_EN = 'A staff member will help you from here — someone from the team will write to you shortly.';
const EMPTY_ES = 'Una persona del equipo te va a ayudar — enseguida te escriben.';
const EMPTY_IT = 'Una persona del team ti aiuterà — ti scrivono a breve.';
const EMPTY_DE = 'Ein Teammitglied hilft dir weiter — jemand schreibt dir gleich.';
const EMPTY_FR = "Un membre de l'equipe va t'aider — quelqu'un t'ecrira tout de suite.";

assert.equal(handoffWarmNoteText('en'), EMPTY_EN);
assert.equal(handoffWarmNoteText('en', ''), EMPTY_EN);
assert.equal(handoffWarmNoteText('en', '   '), EMPTY_EN);
assert.equal(handoffWarmNoteText('es'), EMPTY_ES);
assert.equal(handoffWarmNoteText('it'), EMPTY_IT);
assert.equal(handoffWarmNoteText('de'), EMPTY_DE);
assert.equal(handoffWarmNoteText('fr'), EMPTY_FR);

assert.equal(
  handoffWarmNoteText('en', 'Camila'),
  'Camila from the team will help you from here — someone from the team will write to you shortly.',
);
assert.equal(
  handoffWarmNoteText('es', 'Camila'),
  'Camila del equipo te va a ayudar — enseguida te escriben.',
);
assert.equal(
  handoffWarmNoteText('it', 'Camila'),
  'Camila del team ti aiuterà — ti scrivono a breve.',
);
assert.equal(
  handoffWarmNoteText('de', 'Camila'),
  'Camila vom Team hilft dir weiter — jemand schreibt dir gleich.',
);
assert.equal(
  handoffWarmNoteText('fr', 'Camila'),
  "Camila de l'equipe va t'aider — quelqu'un t'ecrira tout de suite.",
);
assert.equal(isHandoffWarmNote(handoffWarmNoteText('en', 'Camila')), true);
assert.equal(isHandoffWarmNote(EMPTY_EN), true);

const py = spawnSync('python3', ['-c', `
from wolfhouse_staff_api.handoff_guest_note import default_guest_note
empty = 'A staff member will help you from here — someone from the team will write to you shortly.'
assert default_guest_note('en') == empty
assert default_guest_note('en', '') == empty
assert default_guest_note('en', 'Camila') == (
    'Camila from the team will help you from here — someone from the team will write to you shortly.'
)
assert default_guest_note('es', 'Camila') == 'Camila del equipo te va a ayudar — enseguida te escriben.'
from wolfhouse_staff_api.handoff_guest_note import resolve_guest_note, STAFF_INFO_BOT_PATH
assert STAFF_INFO_BOT_PATH == '/staff/bot/staff-info'
called = {'n': 0}
def fake_fetch():
    called['n'] += 1
    return {'success': True, 'staff_member_name': 'Camila'}
note = resolve_guest_note({'language': 'en'}, None, fetch_staff_info=fake_fetch)
assert note == 'Camila from the team will help you from here — someone from the team will write to you shortly.', note
assert called['n'] == 1
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
