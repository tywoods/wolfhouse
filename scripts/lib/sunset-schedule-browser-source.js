'use strict';

/**
 * Browser Schedule portal module source for staff-query-api buildUiHtml() injection.
 * @module sunset-schedule-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-portal-module.js');

function getSunsetSchedulePortalBrowserSource() {
  return fs.readFileSync(BROWSER_MODULE, 'utf8');
}

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  BROWSER_MODULE,
  SCHEDULE_PORTAL_INJECT_MARKER: '/* INJECT:sunset-schedule-portal-module */',
};
