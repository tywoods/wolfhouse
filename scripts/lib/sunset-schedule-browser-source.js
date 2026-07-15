'use strict';

/**
 * Browser Schedule portal + drawer view + edit + payment module sources for staff-query-api buildUiHtml() injection.
 * @module sunset-schedule-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-portal-module.js');
const DRAWER_VIEW_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-view-ui.js');
const DRAWER_EDIT_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const DRAWER_PAYMENT_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-payment-ui.js');

function getSunsetSchedulePortalBrowserSource() {
  return fs.readFileSync(BROWSER_MODULE, 'utf8');
}

function getSunsetScheduleDrawerViewBrowserSource() {
  return fs.readFileSync(DRAWER_VIEW_MODULE, 'utf8');
}

function getSunsetScheduleDrawerEditBrowserSource() {
  return fs.readFileSync(DRAWER_EDIT_MODULE, 'utf8');
}

function getSunsetScheduleDrawerPaymentBrowserSource() {
  return fs.readFileSync(DRAWER_PAYMENT_MODULE, 'utf8');
}

function injectAtMarker(html, marker, moduleJs) {
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  return html.slice(0, idx) + moduleJs + html.slice(idx + marker.length);
}

function injectSunsetSchedulePortalModule(html) {
  html = injectAtMarker(html, SCHEDULE_PORTAL_INJECT_MARKER, getSunsetSchedulePortalBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DRAWER_VIEW_INJECT_MARKER, getSunsetScheduleDrawerViewBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DRAWER_EDIT_INJECT_MARKER, getSunsetScheduleDrawerEditBrowserSource());
  return injectAtMarker(html, SCHEDULE_PAYMENT_INJECT_MARKER, getSunsetScheduleDrawerPaymentBrowserSource());
}

const SCHEDULE_PORTAL_INJECT_MARKER = '/* INJECT:sunset-schedule-portal-module */';
const SCHEDULE_DRAWER_VIEW_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-view-ui */';
const SCHEDULE_DRAWER_EDIT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-edit-ui */';
const SCHEDULE_PAYMENT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-payment-ui */';

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  getSunsetScheduleDrawerViewBrowserSource,
  getSunsetScheduleDrawerEditBrowserSource,
  getSunsetScheduleDrawerPaymentBrowserSource,
  injectSunsetSchedulePortalModule,
  injectAtMarker,
  BROWSER_MODULE,
  DRAWER_VIEW_MODULE,
  DRAWER_EDIT_MODULE,
  DRAWER_PAYMENT_MODULE,
  SCHEDULE_PORTAL_INJECT_MARKER,
  SCHEDULE_DRAWER_VIEW_INJECT_MARKER,
  SCHEDULE_DRAWER_EDIT_INJECT_MARKER,
  SCHEDULE_PAYMENT_INJECT_MARKER,
};
