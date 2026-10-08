#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const soul = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');

assert.match(soul, /If `quote_booking` fails before returning an authoritative price/i);
assert.match(soul, /keep the dates, guest count, room choice, eligibility, names, package, services and payment choice already known/i);
assert.match(soul, /cannot show the verified price right now/i);
assert.match(soul, /Do not say.*booking system.*hiccup/i);
assert.match(soul, /do not restart booking intake/i);
assert.match(soul, /ask only for a detail the typed failure explicitly identifies as genuinely missing/i);

console.log('PASS proof-round-1 failure-recovery SOUL contract 6/6');
