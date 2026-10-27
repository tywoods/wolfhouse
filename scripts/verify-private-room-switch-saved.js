'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

assert.match(api, /function bcFieldEditResetPrivateRoomSwitchToSaved\(/);
assert.match(
  api,
  /function bcFieldEditCloseAll\(\)\{[\s\S]{0,900}bcFieldEditResetPrivateRoomSwitchToSaved\(/,
  'Cancel/close must restore the saved Private room switch'
);
assert.match(
  api,
  /Private room update failed[\s\S]{0,500}bcFieldEditResetPrivateRoomSwitchToSaved\(/,
  'refused private-room save must restore the saved switch'
);
assert.match(
  api,
  /Save failed[\s\S]{0,350}bcFieldEditResetPrivateRoomSwitchToSaved\(/,
  'failed inline save must restore the saved switch'
);
assert.match(
  api,
  /function bcFieldEditSetPrivateRoomToggle\(on\)\{[\s\S]{0,400}bc-field-private-room-read-switch/,
  'toggle helper must set the visible Invoice switch, not only the hidden edit input'
);

console.log('PASS private-room switch saved value');
