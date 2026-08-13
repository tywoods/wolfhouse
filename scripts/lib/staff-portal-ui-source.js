'use strict';

/**
 * Read the full Staff Portal front-end source for static gates.
 *
 * The portal UI is no longer a single file: buildUiHtml() in scripts/staff-query-api.js
 * emits the shell, and the front-end lives in scripts/browser/*.js modules that are
 * injected at markers (see lib/inbox-browser-source.js, lib/sunset-schedule-browser-source.js
 * and siblings). A gate that greps only staff-query-api.js will miss anything that has been
 * extracted, so gates asserting on portal JavaScript should read this instead.
 *
 * Browser modules are discovered from disk, so future extraction rounds are picked up
 * without touching every gate.
 *
 * @module staff-portal-ui-source
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const BROWSER_DIR = path.join(ROOT, 'scripts', 'browser');

/** Absolute paths of the browser modules injected into /staff/ui, sorted. */
function listInjectedBrowserModules() {
  return fs
    .readdirSync(BROWSER_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(BROWSER_DIR, f));
}

/** Absolute paths of the Inbox browser modules only. */
function listInboxBrowserModules() {
  return listInjectedBrowserModules()
    .filter((p) => path.basename(p).startsWith('inbox-'));
}

/**
 * Template source plus every injected browser module, newline-joined.
 *
 * @returns {string} portal front-end source for regex assertions
 */
function readStaffPortalUiSource() {
  return [STAFF_API, ...listInjectedBrowserModules()]
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');
}

module.exports = {
  readStaffPortalUiSource,
  listInjectedBrowserModules,
  listInboxBrowserModules,
  STAFF_API,
  BROWSER_DIR,
};
