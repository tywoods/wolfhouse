'use strict';

/**
 * Browser Schedule portal + drawer view module sources for staff-query-api buildUiHtml() injection.
 * @module sunset-schedule-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-portal-module.js');
const DRAWER_VIEW_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-view-ui.js');

function getSunsetSchedulePortalBrowserSource() {
  return fs.readFileSync(BROWSER_MODULE, 'utf8');
}

function getSunsetScheduleDrawerViewBrowserSource() {
  return fs.readFileSync(DRAWER_VIEW_MODULE, 'utf8');
}

function injectAtMarker(html, marker, moduleJs) {
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  return html.slice(0, idx) + moduleJs + html.slice(idx + marker.length);
}

function injectSunsetSchedulePortalModule(html) {
  const portalJs = getSunsetSchedulePortalBrowserSource();
  html = injectAtMarker(html, SCHEDULE_PORTAL_INJECT_MARKER, portalJs);
  const drawerViewJs = getSunsetScheduleDrawerViewBrowserSource();
  return injectAtMarker(html, SCHEDULE_DRAWER_VIEW_INJECT_MARKER, drawerViewJs);
}

const SCHEDULE_PORTAL_INJECT_MARKER = '/* INJECT:sunset-schedule-portal-module */';
const SCHEDULE_DRAWER_VIEW_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-view-ui */';

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  getSunsetScheduleDrawerViewBrowserSource,
  injectSunsetSchedulePortalModule,
  injectAtMarker,
  BROWSER_MODULE,
  DRAWER_VIEW_MODULE,
  SCHEDULE_PORTAL_INJECT_MARKER,
  SCHEDULE_DRAWER_VIEW_INJECT_MARKER,
};
