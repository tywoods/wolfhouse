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
const DRAWER_ACTIONS_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-actions.js');
const DRAWER_CONTROLLER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-drawer-controller.js');
const DAY_OPS_BOARD_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const DAY_COCKPIT_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-day-cockpit-ui.js');
const FORECAST_CARDS_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-forecast-cards-ui.js');
const VIEW_GRID_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-view-grid-ui.js');
const NAVIGATION_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-navigation-ui.js');
const RUNTIME_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-runtime.js');
const ROW_NORMALIZER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-row-normalizer.js');
const DATA_LOADER_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-data-loader.js');
const RENTAL_AVAILABILITY_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-rental-availability.js');
const MONEY_PARSE_MODULE = path.join(__dirname, '..', 'browser', 'sunset-schedule-money-parse.js');

function getSunsetSchedulePortalBrowserSource() {
  return fs.readFileSync(BROWSER_MODULE, 'utf8');
}

function getSunsetScheduleRentalAvailabilityBrowserSource() {
  return fs.readFileSync(RENTAL_AVAILABILITY_MODULE, 'utf8');
}

function getSunsetScheduleMoneyParseBrowserSource() {
  return fs.readFileSync(MONEY_PARSE_MODULE, 'utf8');
}

function getSunsetScheduleDrawerViewBrowserSource() {
  return fs.readFileSync(DRAWER_VIEW_MODULE, 'utf8');
}

function getSunsetScheduleDrawerEditBrowserSource() {
  return fs.readFileSync(DRAWER_EDIT_MODULE, 'utf8');
}

function getSunsetScheduleDrawerActionsBrowserSource() {
  return fs.readFileSync(DRAWER_ACTIONS_MODULE, 'utf8');
}

function getSunsetScheduleDrawerControllerBrowserSource() {
  return fs.readFileSync(DRAWER_CONTROLLER_MODULE, 'utf8');
}

function getSunsetScheduleDayOpsBoardBrowserSource() {
  return fs.readFileSync(DAY_OPS_BOARD_MODULE, 'utf8');
}

function getSunsetScheduleDayCockpitBrowserSource() {
  return fs.readFileSync(DAY_COCKPIT_MODULE, 'utf8');
}

function getSunsetScheduleForecastCardsBrowserSource() {
  return fs.readFileSync(FORECAST_CARDS_MODULE, 'utf8');
}

function getSunsetScheduleViewGridBrowserSource() {
  return fs.readFileSync(VIEW_GRID_MODULE, 'utf8');
}

function getSunsetScheduleNavigationBrowserSource() {
  return fs.readFileSync(NAVIGATION_MODULE, 'utf8');
}

function getSunsetScheduleRuntimeBrowserSource() {
  return fs.readFileSync(RUNTIME_MODULE, 'utf8');
}

function getSunsetScheduleRowNormalizerBrowserSource() {
  return fs.readFileSync(ROW_NORMALIZER_MODULE, 'utf8');
}

function getSunsetScheduleDataLoaderBrowserSource() {
  return fs.readFileSync(DATA_LOADER_MODULE, 'utf8');
}

/** Permissive: missing marker → return html unchanged (do not throw). */
function injectAtMarker(html, marker, moduleJs) {
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  return html.slice(0, idx) + moduleJs + html.slice(idx + marker.length);
}

function injectSunsetSchedulePortalModule(html) {
  // Money parse first: Create/Edit custom lines call scheduleParseCreateMoneyToCents
  // as a global. Must not live inside the buildUiHtml template literal (\\d escapes
  // are consumed → /^d+(.d+)?$/ and amount_invalid for "10").
  html = injectAtMarker(html, SCHEDULE_MONEY_PARSE_INJECT_MARKER, getSunsetScheduleMoneyParseBrowserSource());
  html = injectAtMarker(html, SCHEDULE_RENTAL_AVAILABILITY_INJECT_MARKER, getSunsetScheduleRentalAvailabilityBrowserSource());
  html = injectAtMarker(html, SCHEDULE_PORTAL_INJECT_MARKER, getSunsetSchedulePortalBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DRAWER_VIEW_INJECT_MARKER, getSunsetScheduleDrawerViewBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DRAWER_EDIT_INJECT_MARKER, getSunsetScheduleDrawerEditBrowserSource());
  html = injectAtMarker(html, SCHEDULE_ACTIONS_INJECT_MARKER, getSunsetScheduleDrawerActionsBrowserSource());
  html = injectAtMarker(html, SCHEDULE_CONTROLLER_INJECT_MARKER, getSunsetScheduleDrawerControllerBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER, getSunsetScheduleDayOpsBoardBrowserSource());
  html = injectAtMarker(html, SCHEDULE_DAY_COCKPIT_INJECT_MARKER, getSunsetScheduleDayCockpitBrowserSource());
  html = injectAtMarker(html, SCHEDULE_FORECAST_CARDS_INJECT_MARKER, getSunsetScheduleForecastCardsBrowserSource());
  html = injectAtMarker(html, SCHEDULE_VIEW_GRID_INJECT_MARKER, getSunsetScheduleViewGridBrowserSource());
  html = injectAtMarker(html, SCHEDULE_RUNTIME_INJECT_MARKER, getSunsetScheduleRuntimeBrowserSource());
  html = injectAtMarker(html, SCHEDULE_NAVIGATION_INJECT_MARKER, getSunsetScheduleNavigationBrowserSource());
  html = injectAtMarker(html, SCHEDULE_ROW_NORMALIZER_INJECT_MARKER, getSunsetScheduleRowNormalizerBrowserSource());
  return injectAtMarker(html, SCHEDULE_DATA_LOADER_INJECT_MARKER, getSunsetScheduleDataLoaderBrowserSource());
}

const SCHEDULE_MONEY_PARSE_INJECT_MARKER = '/* INJECT:sunset-schedule-money-parse */';
const SCHEDULE_RENTAL_AVAILABILITY_INJECT_MARKER = '/* INJECT:sunset-schedule-rental-availability */';
const SCHEDULE_PORTAL_INJECT_MARKER = '/* INJECT:sunset-schedule-portal-module */';
const SCHEDULE_DRAWER_VIEW_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-view-ui */';
const SCHEDULE_DRAWER_EDIT_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-edit-ui */';
const SCHEDULE_ACTIONS_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-actions */';
const SCHEDULE_CONTROLLER_INJECT_MARKER = '/* INJECT:sunset-schedule-drawer-controller */';
const SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER = '/* INJECT:sunset-schedule-day-ops-board-ui */';
const SCHEDULE_DAY_COCKPIT_INJECT_MARKER = '/* INJECT:sunset-schedule-day-cockpit */';
const SCHEDULE_FORECAST_CARDS_INJECT_MARKER = '/* INJECT:sunset-schedule-forecast-cards-ui */';
const SCHEDULE_VIEW_GRID_INJECT_MARKER = '/* INJECT:sunset-schedule-view-grid-ui */';
const SCHEDULE_RUNTIME_INJECT_MARKER = '/* INJECT:sunset-schedule-runtime */';
const SCHEDULE_NAVIGATION_INJECT_MARKER = '/* INJECT:sunset-schedule-navigation-ui */';
const SCHEDULE_ROW_NORMALIZER_INJECT_MARKER = '/* INJECT:sunset-schedule-row-normalizer */';
const SCHEDULE_DATA_LOADER_INJECT_MARKER = '/* INJECT:sunset-schedule-data-loader */';

module.exports = {
  getSunsetSchedulePortalBrowserSource,
  getSunsetScheduleRentalAvailabilityBrowserSource,
  getSunsetScheduleMoneyParseBrowserSource,
  getSunsetScheduleDrawerViewBrowserSource,
  getSunsetScheduleDrawerEditBrowserSource,
  getSunsetScheduleDrawerActionsBrowserSource,
  getSunsetScheduleDrawerControllerBrowserSource,
  getSunsetScheduleDayOpsBoardBrowserSource,
  getSunsetScheduleDayCockpitBrowserSource,
  getSunsetScheduleForecastCardsBrowserSource,
  getSunsetScheduleViewGridBrowserSource,
  getSunsetScheduleRuntimeBrowserSource,
  getSunsetScheduleNavigationBrowserSource,
  getSunsetScheduleRowNormalizerBrowserSource,
  getSunsetScheduleDataLoaderBrowserSource,
  injectSunsetSchedulePortalModule,
  injectAtMarker,
  BROWSER_MODULE,
  RENTAL_AVAILABILITY_MODULE,
  MONEY_PARSE_MODULE,
  DRAWER_VIEW_MODULE,
  DRAWER_EDIT_MODULE,
  DRAWER_ACTIONS_MODULE,
  DRAWER_CONTROLLER_MODULE,
  DAY_OPS_BOARD_MODULE,
  DAY_COCKPIT_MODULE,
  FORECAST_CARDS_MODULE,
  VIEW_GRID_MODULE,
  RUNTIME_MODULE,
  NAVIGATION_MODULE,
  ROW_NORMALIZER_MODULE,
  DATA_LOADER_MODULE,
  SCHEDULE_MONEY_PARSE_INJECT_MARKER,
  SCHEDULE_RENTAL_AVAILABILITY_INJECT_MARKER,
  SCHEDULE_PORTAL_INJECT_MARKER,
  SCHEDULE_DRAWER_VIEW_INJECT_MARKER,
  SCHEDULE_DRAWER_EDIT_INJECT_MARKER,
  SCHEDULE_ACTIONS_INJECT_MARKER,
  SCHEDULE_CONTROLLER_INJECT_MARKER,
  SCHEDULE_DAY_OPS_BOARD_INJECT_MARKER,
  SCHEDULE_DAY_COCKPIT_INJECT_MARKER,
  SCHEDULE_FORECAST_CARDS_INJECT_MARKER,
  SCHEDULE_VIEW_GRID_INJECT_MARKER,
  SCHEDULE_RUNTIME_INJECT_MARKER,
  SCHEDULE_NAVIGATION_INJECT_MARKER,
  SCHEDULE_ROW_NORMALIZER_INJECT_MARKER,
  SCHEDULE_DATA_LOADER_INJECT_MARKER,
};
