'use strict';

/** Injector for the Wolfhouse Services admin browser module (parallels sunset-admin-browser-source.js). */

const fs = require('fs');
const path = require('path');

const BROWSER_SRC = path.join(__dirname, '..', 'browser', 'wolfhouse-services-admin.js');

function getWolfhouseServicesAdminSource() {
  return fs.readFileSync(BROWSER_SRC, 'utf8');
}

module.exports = { getWolfhouseServicesAdminSource, BROWSER_SRC };
