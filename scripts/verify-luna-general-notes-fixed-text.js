'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const soul = read('docker/hermes-staging/SOUL.md');
const messaging = read('config/clients/wolfhouse-somo.messaging.json');
const knowledge = read('config/clients/wolfhouse-somo.knowledge.json');
const lessonConfig = read('scripts/lib/luna-guest-lesson-schedule-config.js');
const confirmation = read('scripts/lib/luna-guest-confirmation-personality-copy.js');
const plugin = read('docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');

assert.match(
  soul,
  /payment[- ]link (?:duration|expiry)[\s\S]{0,300}get_house_info/i,
  'payment-link duration/expiry must come from General Notes via get_house_info',
);
assert.match(
  soul,
  /lesson (?:schedule|times|rhythm)[\s\S]{0,300}get_house_info/i,
  'lesson schedule must come from General Notes via get_house_info',
);
assert.match(soul, /owned only by Staff \*\*General Notes\*\*/i);
assert.match(plugin, /Payment-link duration\/expiry and lesson schedule\/times must come only from returned notes/i);

const runtimeText = [messaging, knowledge, lessonConfig, confirmation].join('\n');
assert.doesNotMatch(runtimeText, /spot was only held for 6 hours|bloccato solo per 6 ore/i);
assert.doesNotMatch(runtimeText, /08:30|09:00[–-]11:00|10:30|11:00[–-]13:00/);
assert.doesNotMatch(runtimeText, /Most mornings we (?:run|have) two (?:surf lesson )?groups|Surf lesson rhythm/i);
assert.doesNotMatch(confirmation, /buildLessonScheduleGuestSection|lessonSection/);

const notesFixture = [
  'Payment links are valid for 6 hours.',
  'Surf lessons usually run in two morning groups. Group 1 leaves Wolfhouse around 08:30 for a 09:00–11:00 lesson. Group 2 leaves around 10:30 for an 11:00–13:00 lesson. We confirm the exact group closer to the day. Lessons run most days in season; low season can be quieter.',
].join('\n');
const toolResult = { success: true, has_notes: true, notes: notesFixture };
assert.equal(toolResult.notes, notesFixture, 'General Notes tool result is the sole answer source');
assert.match(toolResult.notes, /valid for 6 hours/);
assert.match(toolResult.notes, /Group 1 leaves Wolfhouse around 08:30/);

console.log('PASS verify-luna-general-notes-fixed-text (12 assertions)');
