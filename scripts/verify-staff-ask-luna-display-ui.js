/**
 * Ask Luna answer display — collapsed raw rows + readable prose (static UI verifier).
 *
 * Usage:
 *   npm run verify:staff-ask-luna-display-ui
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const API_PATH = path.join(__dirname, 'staff-query-api.js');
const PKG_PATH = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function pass(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, okMsg, failMsg) { if (cond) pass(okMsg); else fail(failMsg || okMsg); }
function has(src, re) { return re.test(src); }
function lacks(src, re) { return !re.test(src); }

console.log('\nverify-staff-ask-luna-display-ui.js\n');

const src = fs.readFileSync(API_PATH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-display-ui']
    === 'node scripts/verify-staff-ask-luna-display-ui.js',
  'package.json script registered',
);

const renderStart = src.indexOf('function alRenderResult(');
const renderEnd = src.indexOf('function alAsk(', renderStart);
const renderBlock = src.slice(renderStart, renderEnd);

check(has(renderBlock, /class="al-answer-prose"/), 'answer uses al-answer-prose');
check(has(src, /\.al-answer-prose\{[^}]*white-space:pre-wrap/), 'prose preserves line breaks (pre-wrap)');
check(has(src, /\.al-raw-wrap\{display:none/), 'raw wrap hidden by default');
check(has(src, /\.al-raw-wrap\.is-open\{display:block/), 'raw wrap visible when expanded');
check(has(renderBlock, /Show raw data/), 'Show raw data toggle label');
check(has(src, /Hide raw data/), 'Hide raw data toggle label in handler');
check(has(renderBlock, /class="al-raw-toggle"/), 'raw toggle button in render');
check(has(renderBlock, /class="al-raw-wrap"/), 'raw wrap container in render');
check(!has(renderBlock, /class="al-raw-wrap is-open"/), 'raw wrap not open by default in HTML');
check(has(src, /function alToggleRawData/), 'alToggleRawData handler');
check(has(src, /function alBuildRawRowsTableHtml/), 'raw table builder preserved');
check(has(src, /class="al-rows-table"/), 'al-rows-table still used when expanded');
check(has(renderBlock, /al-answer-rowcount/), 'subtle row count still rendered');
check(has(renderBlock, /alFormatAnswerHtml/), 'answer formatted via helper');
check(lacks(renderBlock, /al-answer-text.*escHtml\(data\.answer/), 'dense al-answer-text escHtml block removed from success path');

const alStart = src.indexOf('<!-- ── Ask Luna tab');
const alEnd = src.indexOf('</div><!-- /tab-ask-luna -->', alStart);
const alPanel = src.slice(alStart, alEnd);
check(has(alPanel, /id="al-examples"/), 'example chips unchanged');

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
