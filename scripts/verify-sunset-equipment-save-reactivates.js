'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const writesPath = path.join(__dirname, 'lib', 'tenant-admin-writes.js');
const src = fs.readFileSync(writesPath, 'utf8');

assert.doesNotMatch(src, /Group is fully OFF[^\n]*insert inactive/,
  'groupless Admin Save must not inherit retired OFF group state');
assert.doesNotMatch(src, /normalize group availability before adding a duration/,
  'groupless Admin Save must not reject an exact price because sibling rows have mixed activity');
assert.match(src, /async function createRentalPriceRule[\s\S]*?const newRowActive = true;[\s\S]*?upsertConfigPriceRule/,
  'saving an exact equipment price must explicitly make that price active');
const createBody = src.match(/async function createRentalPriceRule[\s\S]*?\n}\n/)[0];
assert.doesNotMatch(createBody, /assertBoardWetsuitShortParityAfterMutation|short_duration_mismatch/,
  'Surfboard and Wetsuit must be independently saveable like every other equipment item');

console.log('PASS saved equipment price is active independently of historical group state');
