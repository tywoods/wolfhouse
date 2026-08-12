'use strict';

/** Injector for the Wolfhouse (lodging) Admin browser module. */

const fs = require('fs');
const path = require('path');

const BROWSER_SRC = path.join(__dirname, '..', 'browser', 'wolfhouse-admin-ui.js');

function getWolfhouseAdminUiSource() {
  return fs.readFileSync(BROWSER_SRC, 'utf8');
}

module.exports = { getWolfhouseAdminUiSource, BROWSER_SRC };
