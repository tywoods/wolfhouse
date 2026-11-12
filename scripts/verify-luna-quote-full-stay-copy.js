'use strict';

/**
 * Waimea 4n (under default 6) must not offer full-stay-only shuttle.
 * Quote wording states total + deposit; never a shall-I-book question.
 * Run: node scripts/verify-luna-quote-full-stay-copy.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildBotQuoteReplyDraft,
  shouldSkipShuttleInQuoteReply,
} = require('./lib/bot-booking-package-normalize');
const {
  packageQuoteCopy,
  quoteTotalAndDepositLine,
} = require('./lib/luna-package-includes-copy');

const waimea = {
  code: 'waimea',
  name: 'Waimea',
  default_nights: 6,
  includes: [
    { text: 'a bed in a mixed shared room', full_stay_only: false },
    { text: 'Free Santander airport shuttle', full_stay_only: true },
    { text: 'surf lessons', full_stay_only: false },
  ],
};

const under = packageQuoteCopy(waimea, 4, 'shared');
assert.equal(under.package_includes.some((row) => /shuttle/i.test(row.text)), false,
  '4n must omit full-stay-only shuttle');
const atDefault = packageQuoteCopy(waimea, 6, 'shared');
assert.equal(atDefault.package_includes.some((row) => /shuttle/i.test(row.text)), true,
  '6n still includes shuttle');

const quote4 = {
  total_cents: 34900,
  deposit_required_cents: 20000,
  package_includes: under.package_includes,
};
const quote6 = {
  total_cents: 49900,
  deposit_required_cents: 20000,
  package_includes: atDefault.package_includes,
};

assert.equal(shouldSkipShuttleInQuoteReply({
  isShortStay: false, isNoPackage: false, packageCode: 'waimea', quotePackageCode: 'waimea',
  nights: 4, defaultNights: 6, quote: quote4,
}), true);
assert.equal(shouldSkipShuttleInQuoteReply({
  isShortStay: false, isNoPackage: false, packageCode: 'waimea', quotePackageCode: 'waimea',
  nights: 6, defaultNights: 6, quote: quote6,
}), false);

const draft4 = buildBotQuoteReplyDraft(quote4, {
  isShortStay: false, isNoPackage: false, quotePackageCode: 'waimea', nights: 4, defaultNights: 6,
}, 'waimea');
assert.match(draft4, /estimated total is €349\.00/);
assert.match(draft4, /deposit is €200\.00/);
assert.doesNotMatch(draft4, /shuttle/i);
assert.doesNotMatch(draft4, /shall I book|look good|\?/i, 'no shall-I-book / extra consent question');

const draft6 = buildBotQuoteReplyDraft(quote6, {
  isShortStay: false, isNoPackage: false, quotePackageCode: 'waimea', nights: 6, defaultNights: 6,
}, 'waimea');
assert.match(draft6, /estimated total is €499\.00/);
assert.match(draft6, /Do you need the free Santander airport shuttle/);

assert.equal(
  quoteTotalAndDepositLine(34900, 20000),
  'For those dates, the estimated total is €349.00. The deposit is €200.00.',
);

const quoteGuide = fs.readFileSync(
  path.join(__dirname, '../docker/hermes-staging/soul-guides/05-quote.md'), 'utf8');
assert.match(quoteGuide, /State the total and the deposit/);
assert.match(quoteGuide, /wording only/i);
assert.match(quoteGuide, /never a .shall I book/i);

const greeting = fs.readFileSync(
  path.join(__dirname, '../docker/hermes-staging/soul-guides/02-greeting-intake.md'), 'utf8');
assert.match(greeting, /full name/i);
assert.match(greeting, /surname/i);
assert.match(greeting, /never block a save/i);

console.log('PASS 4n Waimea omits shuttle; 6n offers it; quote states total+deposit; full-name ask never blocks save');
