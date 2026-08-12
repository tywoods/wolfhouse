'use strict';

/**
 * Browser Inbox modules for staff-query-api buildUiHtml() injection.
 *
 * The Inbox front-end used to live inline inside the buildUiHtml template literal.
 * That template consumed single-backslash regex escapes before the JS reached the
 * browser (/\s+/ shipped as /s+/), so this code now lives in real .js files and is
 * injected at markers after the template is evaluated.
 *
 * Injection is byte-exact: each marker occupies its own line and is replaced by the
 * module body with one trailing newline removed, so the rendered document is
 * identical to the pre-extraction output. scripts/verify-inbox-ui-parity.js gates it.
 *
 * @module inbox-browser-source
 */

const fs = require('fs');
const path = require('path');

const BROWSER_DIR = path.join(__dirname, '..', 'browser');

const CUSTOMERS_FILTERS_MODULE = path.join(BROWSER_DIR, 'inbox-customers-filters.js');
const CUSTOMERS_OUTREACH_MODULE = path.join(BROWSER_DIR, 'inbox-customers-outreach.js');
const CUSTOMERS_PROFILE_MODULE = path.join(BROWSER_DIR, 'inbox-customers-profile.js');
const LIST_MODULE = path.join(BROWSER_DIR, 'inbox-list.js');
const THREAD_MODULE = path.join(BROWSER_DIR, 'inbox-thread.js');

const INBOX_CUSTOMERS_FILTERS_INJECT_MARKER = '/* INJECT:inbox-customers-filters */';
const INBOX_CUSTOMERS_OUTREACH_INJECT_MARKER = '/* INJECT:inbox-customers-outreach */';
const INBOX_CUSTOMERS_PROFILE_INJECT_MARKER = '/* INJECT:inbox-customers-profile */';
const INBOX_LIST_INJECT_MARKER = '/* INJECT:inbox-list */';
const INBOX_THREAD_INJECT_MARKER = '/* INJECT:inbox-thread */';

/**
 * Read a browser module for injection.
 *
 * The trailing newline is stripped because the marker sits on its own line: the
 * surrounding newlines already come from the template, so keeping the file's own
 * trailing newline would add a blank line to the rendered script.
 *
 * @param {string} file absolute path to the module
 * @returns {string} module body ready to splice in place of a marker
 */
function readBrowserModule(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
}

function getInboxCustomersFiltersBrowserSource() {
  return readBrowserModule(CUSTOMERS_FILTERS_MODULE);
}

function getInboxCustomersOutreachBrowserSource() {
  return readBrowserModule(CUSTOMERS_OUTREACH_MODULE);
}

function getInboxCustomersProfileBrowserSource() {
  return readBrowserModule(CUSTOMERS_PROFILE_MODULE);
}

function getInboxListBrowserSource() {
  return readBrowserModule(LIST_MODULE);
}

function getInboxThreadBrowserSource() {
  return readBrowserModule(THREAD_MODULE);
}

/** Permissive: missing marker → return html unchanged (do not throw). */
function injectAtMarker(html, marker, moduleJs) {
  const idx = html.indexOf(marker);
  if (idx < 0) return html;
  return html.slice(0, idx) + moduleJs + html.slice(idx + marker.length);
}

/**
 * Splice every Inbox browser module into the built portal HTML.
 *
 * @param {string} html output of the buildUiHtml template literal
 * @returns {string} html with Inbox modules injected
 */
function injectInboxBrowserModules(html) {
  html = injectAtMarker(html, INBOX_CUSTOMERS_FILTERS_INJECT_MARKER, getInboxCustomersFiltersBrowserSource());
  html = injectAtMarker(html, INBOX_CUSTOMERS_OUTREACH_INJECT_MARKER, getInboxCustomersOutreachBrowserSource());
  html = injectAtMarker(html, INBOX_CUSTOMERS_PROFILE_INJECT_MARKER, getInboxCustomersProfileBrowserSource());
  html = injectAtMarker(html, INBOX_LIST_INJECT_MARKER, getInboxListBrowserSource());
  return injectAtMarker(html, INBOX_THREAD_INJECT_MARKER, getInboxThreadBrowserSource());
}

module.exports = {
  getInboxCustomersFiltersBrowserSource,
  getInboxCustomersOutreachBrowserSource,
  getInboxCustomersProfileBrowserSource,
  getInboxListBrowserSource,
  getInboxThreadBrowserSource,
  injectInboxBrowserModules,
  injectAtMarker,
  readBrowserModule,
  CUSTOMERS_FILTERS_MODULE,
  CUSTOMERS_OUTREACH_MODULE,
  CUSTOMERS_PROFILE_MODULE,
  LIST_MODULE,
  THREAD_MODULE,
  INBOX_CUSTOMERS_FILTERS_INJECT_MARKER,
  INBOX_CUSTOMERS_OUTREACH_INJECT_MARKER,
  INBOX_CUSTOMERS_PROFILE_INJECT_MARKER,
  INBOX_LIST_INJECT_MARKER,
  INBOX_THREAD_INJECT_MARKER,
};
