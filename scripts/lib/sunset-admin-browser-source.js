'use strict';

/**
 * Browser Admin UI module source for staff-query-api.js buildUiHtml() injection.
 * @module sunset-admin-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_UI = path.join(__dirname, '..', 'browser', 'sunset-admin-ui.js');
const FINANCE_REDESIGN = path.join(__dirname, '..', 'browser', 'sunset-admin-finance-redesign-ui.js');
const BOOKINGS_UI = path.join(__dirname, '..', 'browser', 'sunset-admin-bookings-ui.js');
const DURATION_MODEL = path.join(__dirname, '..', 'browser', 'sunset-rental-duration-model.js');
const EQUIPMENT_MODEL = path.join(__dirname, '..', 'browser', 'sunset-equipment-pricing-model.js');

function getSunsetAdminUiBrowserSource() {
  // Finance redesign + Bookings panel first so admin-ui can call their renderers.
  return [
    fs.readFileSync(FINANCE_REDESIGN, 'utf8'),
    fs.readFileSync(BOOKINGS_UI, 'utf8'),
    fs.readFileSync(BROWSER_UI, 'utf8'),
  ].join('\n');
}

// Pure data-model modules the Equipment Pricing tab renders from. Must be
// injected BEFORE sunset-admin-ui.js so their functions are page globals.
function getSunsetEquipmentPricingModelSource() {
  return `${fs.readFileSync(DURATION_MODEL, 'utf8')}\n${fs.readFileSync(EQUIPMENT_MODEL, 'utf8')}`;
}

module.exports = {
  getSunsetAdminUiBrowserSource,
  getSunsetEquipmentPricingModelSource,
  BROWSER_UI,
};
