'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const soul = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
assert.match(soul, /date-specific room availability[\s\S]{0,500}check_availability/i,
  'dated room claims must require authoritative availability');
assert.match(soul, /get_house_info[\s\S]{0,300}(?:cannot|not)[\s\S]{0,200}date-specific inventory/i,
  'house notes must not authorize dated availability claims');
assert.match(soul, /requested male(?:-only| pool)[\s\S]{0,500}mixed alternative/i,
  'requested male inventory must remain distinct from a mixed alternative');
console.log('PASS verify-sim10-room-grounding');
