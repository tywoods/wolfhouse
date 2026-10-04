'use strict';

const assert = require('node:assert/strict');
const { buildReplyForState } = require('./lib/luna-guest-reply-composer');

function reply(lang, scheduledCount) {
  return buildReplyForState('service_scheduled_ack', {
    lang,
    fields: {},
    live_outcomes: {
      serviceSchedule: {
        service_type: 'yoga',
        service_date: '2026-10-22',
        scheduled_count: scheduledCount,
      },
    },
  });
}

const en = reply('en', 3);
assert.match(en, /3 (?:guests|people)/i);
assert.doesNotMatch(en, /3 yoga classes/i);

const de = reply('de', 3);
assert.match(de, /3 (?:Gäste|Personen)/i);
assert.doesNotMatch(de, /3 Yoga-Klassen/i);

assert.match(reply('en', 1), /yoga/i);

console.log('verify:luna-yoga-attendee-wording PASS');
