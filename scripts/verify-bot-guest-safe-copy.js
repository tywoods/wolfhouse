'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { buildBotClosedSeasonReply } = require('./lib/bot-guest-safe-copy');

for (const language of ['en', 'de', 'fr', 'it', 'es']) {
  const result = buildBotClosedSeasonReply({
    language,
    nearest_open_dates: { check_in: '2027-04-01', check_out: '2027-04-08' },
    partial_open_dates: { check_in: '2026-10-30', check_out: '2026-11-01', closed_from: '2026-11-01' },
    closed_nights: ['2026-11-01'],
    season_reopens_on: '2027-04-01',
  });
  assert.equal(result.reply_draft, null);
  assert.equal(result.guest_safe_next_action, null);
  assert.equal(result.structured_guest_context.language, language);
  assert.deepEqual(result.structured_guest_context.closed_nights, ['2026-11-01']);
  assert.match(result.prompt_instruction, /preserve the established form of address and register/);
}

const source = fs.readFileSync(path.join(__dirname, 'lib/bot-guest-safe-copy.js'), 'utf8');
assert.doesNotMatch(source, /DateTimeFormat|month.*name|CLOSED_SEASON_COPY|NEAREST_OPEN_DATES_COPY|Für eure|We are closed/);
console.log('PASS verify-bot-guest-safe-copy');
