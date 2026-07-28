'use strict';

/**
 * Return the exact production buildUiHtml output for offline browser gates.
 * The production module exposes this narrow seam only under a test-only dual gate;
 * no template, placeholder, localization, CSS, or post-processing is reconstructed.
 */
function buildVerifyStaffUiHtml() {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.DEFAULT_CLIENT_SLUG = process.env.DEFAULT_CLIENT_SLUG || 'sunset';
  const api = require('../staff-query-api');
  if (typeof api.buildUiHtmlForOfflineTest !== 'function') {
    throw new Error('Production staff UI builder seam is unavailable');
  }
  return api.buildUiHtmlForOfflineTest(0, process.env.DEFAULT_CLIENT_SLUG || 'sunset');
}

module.exports = { buildVerifyStaffUiHtml };
