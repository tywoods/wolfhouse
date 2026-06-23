'use strict';

/**
 * Extract inline Admin helper function sources from staff-query-api.js for browser parity eval.
 * Does not modify staff-query-api.js — read-only slice of embedded browser JS.
 */

const fs = require('fs');
const path = require('path');
const { getSunsetAdminBrowserHelperSource } = require('./sunset-admin-ui-helpers');

const STAFF_API = path.join(__dirname, '..', 'staff-query-api.js');

function extractFunctionSource(src, name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) throw new Error(`Could not find ${sig} in staff-query-api.js`);
  const brace = src.indexOf('{', start);
  if (brace < 0) throw new Error(`Could not find body for ${name}`);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unterminated function ${name}`);
}

function extractAdminTimeHmReLine(src) {
  const needle = "var ADMIN_TIME_HM_RE = new RegExp('^([01][0-9]|2[0-3]):[0-5][0-9]$');";
  if (!src.includes(needle)) {
    throw new Error('ADMIN_TIME_HM_RE line missing or changed in staff-query-api.js');
  }
  return needle;
}

/**
 * Build evaluable browser snippet from injected helper source (parity with live portal HTML).
 */
function buildInlineAdminHelperSnippet() {
  return getSunsetAdminBrowserHelperSource();
}

function loadInlineAdminHelperSnippet() {
  const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
  if (!apiSrc.includes('getSunsetAdminBrowserHelperSource()')) {
    throw new Error('staff-query-api.js missing getSunsetAdminBrowserHelperSource() injection');
  }
  return buildInlineAdminHelperSnippet();
}

module.exports = {
  extractFunctionSource,
  buildInlineAdminHelperSnippet,
  loadInlineAdminHelperSnippet,
  STAFF_API,
};
