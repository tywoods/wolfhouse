'use strict';

// Ale Launch Fix Pack item 7: Create Booking private-room supplement is
// per room, matching Staff Pricing (not +€10 per person).
const assert = require('node:assert/strict');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const src = readStaffPortalUiSource();
const option = src.slice(src.indexOf('id="bk-room-type"'), src.indexOf('id="bk-room-type"') + 900);
assert.match(option, /value="private"/, 'private option exists');
assert.match(option, /data-i18n="calendar.create.private"/);
assert.doesNotMatch(option, /person\/night/i, 'create form must not say per person');
assert.match(option, /room\/night/i, 'create form says per room / night');

const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const it = STAFF_PORTAL_STRINGS.it;
assert.equal(en['calendar.create.private'], 'Private (+€10/room/night)');
assert.doesNotMatch(en['calendar.create.private'], /person/i);
assert.doesNotMatch(es['calendar.create.private'], /persona/i);
assert.match(es['calendar.create.private'], /habitaci[oó]n/i);
assert.doesNotMatch(it['calendar.create.private'], /persona/i);
assert.match(it['calendar.create.private'], /camera/i);

console.log('PASS create booking private per room');
