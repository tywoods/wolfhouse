'use strict';

/** Injector for the Wolfhouse (lodging) Admin browser modules. */

const fs = require('fs');
const path = require('path');

const BROWSER_SRC = path.join(__dirname, '..', 'browser', 'wolfhouse-admin-ui.js');
const PRICING_BROWSER_SRC = path.join(
  __dirname, '..', 'browser', 'wolfhouse-admin-pricing-ui.js',
);
// Shared with Sunset Admin — Luna Staff 3-card regroup (notes / numbers+alerts+autos / style+personality).
const LUNA_STAFF_CARDS_REGROUP = path.join(
  __dirname, '..', 'browser', 'sunset-admin-luna-cards-combine.js',
);
const LOCATION_BOOKING_SETTINGS_UI = path.join(
  __dirname, '..', 'browser', 'wolfhouse-location-booking-settings-ui.js',
);
const STAFF_PORTAL_FIELDS_UI = path.join(
  __dirname, '..', 'browser', 'wolfhouse-staff-portal-fields-ui.js',
);

function getWolfhouseAdminUiSource() {
  return [
    fs.readFileSync(LUNA_STAFF_CARDS_REGROUP, 'utf8'),
    fs.readFileSync(LOCATION_BOOKING_SETTINGS_UI, 'utf8'),
    fs.readFileSync(STAFF_PORTAL_FIELDS_UI, 'utf8'),
    fs.readFileSync(BROWSER_SRC, 'utf8'),
  ].join('\n');
}

function getWolfhousePricingUiSource() {
  return fs.readFileSync(PRICING_BROWSER_SRC, 'utf8');
}

module.exports = {
  getWolfhouseAdminUiSource,
  getWolfhousePricingUiSource,
  BROWSER_SRC,
  PRICING_BROWSER_SRC,
  LOCATION_BOOKING_SETTINGS_UI,
  STAFF_PORTAL_FIELDS_UI,
};
