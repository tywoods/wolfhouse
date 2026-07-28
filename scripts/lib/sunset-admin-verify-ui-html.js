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

function loadWolfhouseServicesAdmin() {
  return require('./wolfhouse-services-browser-source');
}

function buildVerifyStaffUiHtml() {
  const {
    getStaffPortalThemeEarlyScript,
    getStaffPortalI18nBootstrapScript,
  } = loadStaffPortalI18n();
  const { getWolfhouseServicesAdminSource } = loadWolfhouseServicesAdmin();
  const { getSunsetAdminBrowserHelperSource } = require('./sunset-admin-ui-helpers');
  const { getSunsetAdminUiBrowserSource } = require('./sunset-admin-browser-source');
  const { staffPortalDevTabsEnabled } = require('./staff-portal-clients');
  const { MESSAGE_MIN: OUTREACH_MESSAGE_MIN } = require('./staff-customer-outreach-send');
  const {
    CRM_TAG_KEYS,
    CUSTOMER_AUTO_TAG_KEYS,
    CUSTOMER_DISPLAY_TAG_ORDER,
  } = require('./staff-customer-queries');

  const apiPath = path.join(__dirname, '..', 'staff-query-api.js');
  const apiSrc = fs.readFileSync(apiPath, 'utf8');
  // Signature may include portalDeployClient and other args — match the declaration only.
  const fnStart = apiSrc.search(/function buildUiHtml\s*\(/);
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

  const portalDevTabsEnabled = staffPortalDevTabsEnabled();
  const portalBodyOpen = '<body class="portal-profile-pending"'
    + (portalDevTabsEnabled ? '' : ' portal-no-dev-tabs') + '>';
  const bookUiClass = String(process.env.STAFF_PORTAL_BOOK_UI || 'true').trim().toLowerCase() === 'false'
    ? ''
    : ' book-ui';
  const portalDefaultClient = String(process.env.DEFAULT_CLIENT_SLUG || 'sunset').trim() || 'sunset';

  const replacements = [
    ['${getStaffPortalThemeEarlyScript()}', getStaffPortalThemeEarlyScript()],
    ['${getStaffPortalI18nBootstrapScript(STAFF_PORTAL_LOCALES)}', getStaffPortalI18nBootstrapScript(locales)],
    ['${getWolfhouseServicesAdminSource()}', getWolfhouseServicesAdminSource()],
    ['${getSunsetAdminBrowserHelperSource()}', getSunsetAdminBrowserHelperSource()],
    ['${getSunsetAdminUiBrowserSource()}', getSunsetAdminUiBrowserSource()],
    ['${JSON.stringify(portalDefaultClient)}', JSON.stringify(portalDefaultClient)],
    ['${portalBodyOpen}', portalBodyOpen],
    ['${bookUiClass}', bookUiClass],
    ['${OUTREACH_MESSAGE_MIN}', String(OUTREACH_MESSAGE_MIN)],
    ['${JSON.stringify(CRM_TAG_KEYS)}', JSON.stringify(CRM_TAG_KEYS)],
    ['${JSON.stringify(CUSTOMER_AUTO_TAG_KEYS)}', JSON.stringify(CUSTOMER_AUTO_TAG_KEYS)],
    ['${JSON.stringify(CUSTOMER_DISPLAY_TAG_ORDER)}', JSON.stringify(CUSTOMER_DISPLAY_TAG_ORDER)],
    ['${portalDevTabsEnabled ? \'true\' : \'false\'}', portalDevTabsEnabled ? 'true' : 'false'],
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
