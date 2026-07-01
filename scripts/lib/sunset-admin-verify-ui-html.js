'use strict';

/**
 * Build /staff/ui HTML for offline Admin verify runs without the full staff-query-api
 * dependency graph. Extracts the embedded template from staff-query-api.js and
 * substitutes known server-side placeholders.
 */

const fs = require('fs');
const path = require('path');

function loadStaffPortalI18n() {
  return require('./staff-portal-i18n');
}

function loadSunsetAdminBrowserHelpers() {
  return require('./sunset-admin-ui-helpers');
}

function loadSunsetAdminBrowserUi() {
  return require('./sunset-admin-browser-source');
}

function loadWolfhouseServicesAdmin() {
  return require('./wolfhouse-services-browser-source');
}

function buildVerifyStaffUiHtml() {
  const {
    getStaffPortalThemeEarlyScript,
    getStaffPortalI18nBootstrapScript,
  } = loadStaffPortalI18n();
  const { getSunsetAdminBrowserHelperSource } = loadSunsetAdminBrowserHelpers();
  const { getSunsetAdminUiBrowserSource } = loadSunsetAdminBrowserUi();
  const { getWolfhouseServicesAdminSource } = loadWolfhouseServicesAdmin();
  const apiPath = path.join(__dirname, '..', 'staff-query-api.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  const fnStart = apiSrc.indexOf('function buildUiHtml(port)');
  const retStart = apiSrc.indexOf('return `<!DOCTYPE html>', fnStart);
  const htmlStart = apiSrc.indexOf('<!DOCTYPE html>', fnStart);
  const htmlEnd = apiSrc.indexOf('</html>`;', htmlStart);
  if (fnStart < 0 || htmlStart < 0 || htmlEnd < 0) {
    throw new Error('Could not extract staff UI template from staff-query-api.js');
  }
  let html = apiSrc.slice(htmlStart, htmlEnd + '</html>'.length);

  const locales = String(process.env.STAFF_PORTAL_LOCALES || 'en')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const replacements = [
    ['${getStaffPortalThemeEarlyScript()}', getStaffPortalThemeEarlyScript()],
    ['${getStaffPortalI18nBootstrapScript(STAFF_PORTAL_LOCALES)}', getStaffPortalI18nBootstrapScript(locales)],
    ['${getSunsetAdminBrowserHelperSource()}', getSunsetAdminBrowserHelperSource()],
    ['${getSunsetAdminUiBrowserSource()}', getSunsetAdminUiBrowserSource()],
    ['${getWolfhouseServicesAdminSource()}', getWolfhouseServicesAdminSource()],
    ["portal-profile-pending${portalDevTabsEnabled ? '' : ' portal-no-dev-tabs'}", 'portal-profile-pending portal-no-dev-tabs'],
    ['${portalDevTabsEnabled ? \'true\' : \'false\'}', 'false'],
    ['${renderStaffLangSwitchButtons(false)}', ''],
    ['${renderStaffLangSwitchButtons(true)}', ''],
    ['${STAFF_ACTIONS_ENABLED}', 'false'],
    ['${MANUAL_BOOKING_ENABLED}', 'false'],
    ['${STRIPE_LINKS_ENABLED}', 'false'],
    ['${rentalDayRatesJson}', '[]'],
    ["${process.env.WHATSAPP_DRY_RUN === 'true'}", 'false'],
  ];
  for (const [needle, value] of replacements) {
    html = html.split(needle).join(value);
  }

  const unresolved = [...html.matchAll(/\$\{[^}]+\}/g)].map((m) => m[0]);
  if (unresolved.length) {
    throw new Error(`Unresolved staff UI placeholders: ${unresolved.slice(0, 8).join(', ')}`);
  }
  return html;
}

module.exports = {
  buildVerifyStaffUiHtml,
};
