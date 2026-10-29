'use strict';

const assert = require('assert/strict');
const {
  CLOSED_SEASON_COPY,
  buildBotClosedSeasonReply,
} = require('./lib/bot-guest-safe-copy');

for (const locale of ['en', 'de', 'fr', 'it', 'es']) {
  const withoutDates = buildBotClosedSeasonReply({ language: locale });
  assert.equal(withoutDates.reply_draft, CLOSED_SEASON_COPY[locale]);

  const withDates = buildBotClosedSeasonReply({
    language: locale,
    nearest_open_dates: { check_in: '2027-04-01', check_out: '2027-04-08' },
  });
  assert.match(withDates.reply_draft, /2027-04-01/);
  assert.match(withDates.reply_draft, /2027-04-08/);
  assert.equal(withDates.reply_draft, withDates.guest_safe_next_action);
}

assert.match(CLOSED_SEASON_COPY.de, /In dem Zeitraum haben wir leider geschlossen/);
assert.doesNotMatch(CLOSED_SEASON_COPY.de, /an diesen Daten/i);
assert.equal(buildBotClosedSeasonReply({
  language: 'de',
  nearest_open_dates: { check_in: 'invalid', check_out: '2027-04-08' },
}).reply_draft, CLOSED_SEASON_COPY.de);

console.log('PASS verify-bot-guest-safe-copy');
