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
const DRAWER_DELETE_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-delete-ui.js');
const DRAWER_CONTROLLER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-controller.js');
const DAY_OPS_BOARD_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const FORECAST_CARDS_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-forecast-cards-ui.js');
const VIEW_GRID_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-view-grid-ui.js');

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

function getSunsetScheduleDrawerDeleteBrowserSource() {
  return fs.readFileSync(DRAWER_DELETE_MODULE, 'utf8');
}

function getSunsetScheduleDrawerControllerBrowserSource() {
  return fs.readFileSync(DRAWER_CONTROLLER_MODULE, 'utf8');
}

function getSunsetScheduleDayOpsBoardBrowserSource() {
  return fs.readFileSync(DAY_OPS_BOARD_MODULE, 'utf8');
}

function getSunsetScheduleForecastCardsBrowserSource() {
  return fs.readFileSync(FORECAST_CARDS_MODULE, 'utf8');
}

function getSunsetScheduleViewGridBrowserSource() {
  return fs.readFileSync(VIEW_GRID_MODULE, 'utf8');
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
  html = injectAtMarker(html, SCHEDULE_DELETE_INJECT_MARKER, getSunsetScheduleDrawerDeleteBrowserSource());
  html = injectAtMarker(html, SCHEDULE_CONTROLLER_INJECT_MARKER, getSunsetScheduleDrawerControllerBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER, getSunsetScheduleDayOpsBoardBrowserSource());
  html = injectAtMarker(html, SCHEDULE_FORECAST_CARDS_INJECT_MARKER, getSunsetScheduleForecastCardsBrowserSource());
  return injectAtMarker(html, SCHEDULE_VIEW_GRID_INJECT_MARKER, getSunsetScheduleViewGridBrowserSource());
}

const SCHEDULE_PORTAL_INJECT_MARKER = '/* INJECT:sunset-schedule-portal-module */';
const SCHEDULE_DRAWER_VIEW_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-view-ui */';
const SCHEDULE_DRAWER_EDIT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-edit-ui */';
const SCHEDULE_PAYMENT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-payment-ui */';
const SCHEDULE_WAIVER_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-waiver-ui */';
const SCHEDULE_DELETE_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-delete-ui */';
const SCHEDULE_CONTROLLER_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-controller */';
const SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER = '/* INJECT:sunset-schedule-day-ops-board-ui */';
const SCHEDULE_FORECAST_CARDS_INJECT_MARKER = '/* INJECT:sunset-schedule-forecast-cards-ui */';
const SCHEDULE_VIEW_GRID_INJECT_MARKER = '/* INJECT:sunset-schedule-view-grid-ui */';

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  getSunsetScheduleDrawerViewBrowserSource,
  getSunsetScheduleDrawerEditBrowserSource,
  getSunsetScheduleDrawerPaymentBrowserSource,
  getSunsetScheduleDrawerWaiverBrowserSource,
  getSunsetScheduleDrawerDeleteBrowserSource,
  getSunsetScheduleDrawerControllerBrowserSource,
  getSunsetScheduleDayOpsBoardBrowserSource,
  getSunsetScheduleForecastCardsBrowserSource,
  getSunsetScheduleViewGridBrowserSource,
  injectSunsetSchedulePortalModule,
  injectAtMarker,
  BROWSER_MODULE,
  DRAWER_VIEW_MODULE,
  DRAWER_EDIT_MODULE,
  DRAWER_PAYMENT_MODULE,
  DRAWER_WAIVER_MODULE,
  DRAWER_DELETE_MODULE,
  DRAWER_CONTROLLER_MODULE,
  DAY_OPS_BOARD_MODULE,
  FORECAST_CARDS_MODULE,
  VIEW_GRID_MODULE,
  SCHEDULE_PORTAL_INJECT_MARKER,
  SCHEDULE_DRAWER_VIEW_INJECT_MARKER,
  SCHEDULE_DRAWER_EDIT_INJECT_MARKER,
  SCHEDULE_PAYMENT_INJECT_MARKER,
  SCHEDULE_WAIVER_INJECT_MARKER,
  SCHEDULE_DELETE_INJECT_MARKER,
  SCHEDULE_CONTROLLER_INJECT_MARKER,
  SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER,
  SCHEDULE_FORECAST_CARDS_INJECT_MARKER,
  SCHEDULE_VIEW_GRID_INJECT_MARKER,
};
