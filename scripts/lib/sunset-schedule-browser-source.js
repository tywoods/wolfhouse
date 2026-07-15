'use strict';

/**
 * Browser Schedule portal + drawer modules for staff-query-api buildUiHtml() injection.
 * @module sunset-schedule-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-portal-module.js');
const DRAWER_VIEW_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-view-ui.js');
const DRAWER_EDIT_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-edit-ui.js');
const DRAWER_PAYMENT_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-payment-ui.js');
const DRAWER_WAIVER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-waiver-ui.js');
const DRAWER_CONTROLLER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-controller.js');

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

function getSunsetScheduleDrawerWaiverBrowserSource() {
  return fs.readFileSync(DRAWER_WAIVER_MODULE, 'utf8');
}

function getSunsetScheduleDrawerControllerBrowserSource() {
  return fs.readFileSync(DRAWER_CONTROLLER_MODULE, 'utf8');
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
  html = injectAtMarker(html, SCHEDULE_PAYMENT_INJECT_MARKER, getSunsetScheduleDrawerPaymentBrowserSource());
  html = injectAtMarker(html, SCHEDULE_WAIVER_INJECT_MARKER, getSunsetScheduleDrawerWaiverBrowserSource());
  return injectAtMarker(html, SCHEDULE_CONTROLLER_INJECT_MARKER, getSunsetScheduleDrawerControllerBrowserSource());
}

const SCHEDULE_PORTAL_INJECT_MARKER = '/* INJECT:sunset-schedule-portal-module */';
const SCHEDULE_DRAWER_VIEW_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-view-ui */';
const SCHEDULE_DRAWER_EDIT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-edit-ui */';
const SCHEDULE_PAYMENT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-payment-ui */';
const SCHEDULE_WAIVER_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-waiver-ui */';
const SCHEDULE_CONTROLLER_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-controller */';

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  getSunsetScheduleDrawerViewBrowserSource,
  getSunsetScheduleDrawerEditBrowserSource,
  getSunsetScheduleDrawerPaymentBrowserSource,
  getSunsetScheduleDrawerWaiverBrowserSource,
  getSunsetScheduleDrawerControllerBrowserSource,
  injectSunsetSchedulePortalModule,
  injectAtMarker,
  BROWSER_MODULE,
  DRAWER_VIEW_MODULE,
  DRAWER_EDIT_MODULE,
  DRAWER_PAYMENT_MODULE,
  DRAWER_WAIVER_MODULE,
  DRAWER_CONTROLLER_MODULE,
  SCHEDULE_PORTAL_INJECT_MARKER,
  SCHEDULE_DRAWER_VIEW_INJECT_MARKER,
  SCHEDULE_DRAWER_EDIT_INJECT_MARKER,
  SCHEDULE_PAYMENT_INJECT_MARKER,
  SCHEDULE_WAIVER_INJECT_MARKER,
  SCHEDULE_CONTROLLER_INJECT_MARKER,
};
