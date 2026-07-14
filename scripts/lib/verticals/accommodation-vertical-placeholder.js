'use strict';

/**
 * Accommodation vertical placeholder — Wolfhouse not migrated to Luna Front Desk
 * application layer yet (Slice 7 boundary). All operations fail closed.
 */

const { VERTICAL_IDS } = require('../luna-front-desk-vertical-scope');

const NOT_MIGRATED = Object.freeze({
  ok: false,
  status: 501,
  body: {
    success: false,
    ok: false,
    reason: 'not_migrated',
    reason_code: 'not_migrated',
    vertical_id: VERTICAL_IDS.ACCOMMODATION,
    error: 'Accommodation vertical is not migrated to the Luna Front Desk application layer.',
  },
});

function notMigrated() {
  return { ...NOT_MIGRATED, body: { ...NOT_MIGRATED.body } };
}

const accommodationVerticalPlaceholder = {
  verticalId: VERTICAL_IDS.ACCOMMODATION,
  supportedClientSlug: 'wolfhouse',

  async listOfferings() { return notMigrated(); },
  async quoteOffering() { return notMigrated(); },
  async createBooking() { return notMigrated(); },
  evaluateDates() { return notMigrated(); },
  async checkAvailability() { return notMigrated(); },
};

module.exports = {
  accommodationVerticalPlaceholder,
  notMigrated,
};
