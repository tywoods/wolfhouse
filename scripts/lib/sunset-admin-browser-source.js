'use strict';

/**
 * Browser Admin UI module source for staff-query-api.js buildUiHtml() injection.
 * @module sunset-admin-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_UI = path.join(__dirname, '..', 'browser', 'sunset-admin-ui.js');

function getSunsetAdminUiBrowserSource() {
  return fs.readFileSync(BROWSER_UI, 'utf8');
}

module.exports = {
  getSunsetAdminUiBrowserSource,
  BROWSER_UI,
};
