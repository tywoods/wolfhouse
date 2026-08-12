'use strict';

/** Injector for the Wolfhouse (lodging) Admin browser modules. */

const fs = require('fs');
const path = require('path');

const BROWSER_SRC = path.join(__dirname, '..', 'browser', 'wolfhouse-admin-ui.js');
const PRICING_BROWSER_SRC = path.join(
  __dirname, '..', 'browser', 'wolfhouse-admin-pricing-ui.js',
);

function getWolfhouseAdminUiSource() {
  return fs.readFileSync(BROWSER_SRC, 'utf8');
}

function getWolfhousePricingUiSource() {
  return fs.readFileSync(PRICING_BROWSER_SRC, 'utf8');
}

module.exports = {
  getWolfhouseAdminUiSource,
  getWolfhousePricingUiSource,
  BROWSER_SRC,
  PRICING_BROWSER_SRC,
};
