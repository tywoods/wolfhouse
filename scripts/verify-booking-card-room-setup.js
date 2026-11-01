#!/usr/bin/env node
'use strict';

/**
 * Booking card room classification vs private-room toggle.
 * Shared/dorm stays must not present PRIVATE ROOM as the room setup.
 * Toggle stays a separate control.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

/** Same unescaping a JS template literal applies when buildUiHtml emits /staff/ui. */
function emitAsBrowserTemplate(src) {
  return String(src).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(.)/g, (_, c) => {
      if (c === 'n') return '\n';
      if (c === 't') return '\t';
      if (c === 'r') return '\r';
      if (c === '\\') return '\\';
      return c;
    });
}

function tFactory(locale) {
  const pack = STAFF_PORTAL_STRINGS[locale] || STAFF_PORTAL_STRINGS.en;
  return function t(key) {
    return pack[key] || (STAFF_PORTAL_STRINGS.en && STAFF_PORTAL_STRINGS.en[key]) || key;
  };
}

function sandboxFor(locale) {
  const t = tFactory(locale);
  const box = {
    t,
    escHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },
  };
  vm.createContext(box);
  const fns = [
    'bcQuoteRoomSupplementCents',
    'bcQuoteRoomSupplementLine',
    'bcBookingPrivateRoomEnabled',
    'bcBookingRoomSetupKind',
    'bcAssignedRoomSetupCodes',
    'bcPrivateRoomSwitchHtml',
    'bcPrivateRoomReadKv',
    'bcRoomSetupReadKv',
  ].map((n) => emitAsBrowserTemplate(extractFunction(apiSrc, n))).join('\n');
  vm.runInContext(fns, box);
  return box;
}

assert.ok(apiSrc.includes('function bcBookingRoomSetupKind('), 'bcBookingRoomSetupKind exists');
assert.ok(apiSrc.includes('function bcRoomSetupReadKv('), 'bcRoomSetupReadKv exists');
assert.ok(
  /var packageKv = bcRoomSetupReadKv\(bk, \(data && data\.booking_guests\) \|\| \[\]\) \+ bcPrivateRoomReadKv\(bcBookingPrivateRoomEnabled\(bk\)\)/.test(apiSrc),
  'package group read row uses room setup, not private-room heading alone'
);
assert.ok(
  apiSrc.includes('bcPrivateRoomReadKv(bcBookingPrivateRoomEnabled(bk))'),
  'private-room toggle still rendered separately'
);
assert.ok(
  apiSrc.includes("bcRenderFieldEditPencilBtn('private_room'") === false,
  'no extra private_room pencil'
);

const sharedBk = {
  requested_room_type: 'mixed',
  room_preference: null,
  metadata: { quote_snapshot: { room_type: 'shared' } },
};
const privateBk = {
  requested_room_type: 'private',
  room_preference: 'couple_private',
  metadata: { quote_snapshot: { room_type: 'private', line_items: [{ code: 'room_supplement', total_cents: 7000 }] } },
};
const mixedBk = {
  requested_room_type: 'mixed',
  room_preference: 'mixed',
  metadata: {},
};
const unknownBk = {
  requested_room_type: null,
  room_preference: null,
  metadata: {},
};

const en = sandboxFor('en');
assert.equal(en.bcBookingRoomSetupKind(sharedBk), 'shared');
assert.equal(en.bcBookingRoomSetupKind(privateBk), 'private');
assert.equal(en.bcBookingRoomSetupKind(mixedBk), 'shared', 'mixed-gender dorm without quote stays Shared');
assert.equal(en.bcBookingRoomSetupKind(unknownBk), 'unknown');
assert.equal(en.bcBookingRoomSetupKind({
  requested_room_type: 'shared',
  room_preference: 'female_only',
  metadata: {},
}), 'shared', 'female_only must not mask shared');
assert.equal(en.bcBookingRoomSetupKind({
  requested_room_type: 'shared',
  room_preference: 'male_only',
  metadata: {},
}), 'shared', 'male_only must not mask shared');
assert.equal(en.bcBookingRoomSetupKind({
  requested_room_type: 'mixed',
  room_preference: 'mixed',
  metadata: {},
}), 'shared', 'requested mixed without quote is a mixed-gender dorm');

const assignedSrc = extractFunction(apiSrc, 'bcAssignedRoomSetupCodes');
assert.match(assignedSrc, /\.match\(\/\^R\[0-9\]\+\/i\)/, 'room-code regex uses [0-9] so the template cannot eat \\d');
assert.doesNotMatch(emitAsBrowserTemplate(assignedSrc), /\/\^Rd\+\//);

function headingAndValue(html) {
  const k = (html.match(/<span class="k">([^<]*)<\/span>/) || [])[1] || '';
  const v = (html.match(/<span class="v"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
  return { k, v: v.replace(/<[^>]+>/g, '').trim() };
}

const sharedHtml = en.bcRoomSetupReadKv(sharedBk, [{ assigned_bed_code: 'R3-B4' }, { assigned_bed_code: 'R3-B5' }]);
const sharedHv = headingAndValue(sharedHtml);
assert.equal(sharedHv.k, 'Room');
assert.match(sharedHv.v, /Shared/);
assert.match(sharedHtml, /R3/);
assert.doesNotMatch(sharedHtml, />Private Room</);

const privateHtml = en.bcRoomSetupReadKv(privateBk, [{ assigned_room_code: 'R6' }]);
const privateHv = headingAndValue(privateHtml);
assert.equal(privateHv.k, 'Room');
assert.match(privateHv.v, /Private/);
assert.doesNotMatch(privateHtml, /Shared/);

const mixedHtml = en.bcRoomSetupReadKv(mixedBk, []);
assert.match(mixedHtml, />Shared</);
assert.doesNotMatch(mixedHtml, />Mixed</);

const genderHtml = en.bcRoomSetupReadKv({
  requested_room_type: 'shared',
  room_preference: 'female_only',
  metadata: {},
}, [{ assigned_bed_code: 'R3-B4' }, { assigned_bed_code: 'R3-B5' }]);
assert.match(genderHtml, />Shared/);
assert.match(genderHtml, /R3/);
assert.doesNotMatch(genderHtml, />Unknown</);
assert.doesNotMatch(genderHtml, />Mixed</);

const unknownHtml = en.bcRoomSetupReadKv(unknownBk, []);
assert.match(unknownHtml, />Unknown</);

const toggle = en.bcPrivateRoomReadKv(false);
assert.match(toggle, /id="bc-field-private-room-read-kv"/);
assert.match(toggle, /bc-field-private-room-read-switch/);
assert.doesNotMatch(toggle, /<span class="k">Private Room<\/span>/);

['es', 'it'].forEach((locale) => {
  const box = sandboxFor(locale);
  const html = box.bcRoomSetupReadKv(sharedBk, [{ assigned_bed_code: 'R3-B1' }]);
  const hv = headingAndValue(html);
  assert.notEqual(hv.k, 'Private Room', locale + ' heading is not Private Room');
  assert.notEqual(hv.k, 'PRIVATE ROOM', locale + ' heading is not PRIVATE ROOM');
  assert.ok(hv.k && hv.k !== 'drawer.field.roomSetup', locale + ' room heading translated: ' + hv.k);
  assert.doesNotMatch(html, />Private Room</);
  assert.doesNotMatch(html, />Malibu</);
  const priv = box.bcRoomSetupReadKv(privateBk, []);
  const ph = headingAndValue(priv);
  assert.equal(ph.k, hv.k, locale + ' heading stable');
  assert.notEqual(ph.v, headingAndValue(html).v, locale + ' private value differs from shared');
});

assert.ok(STAFF_PORTAL_STRINGS.en['drawer.field.roomSetup'] === 'Room');
assert.ok(STAFF_PORTAL_STRINGS.es['drawer.field.roomSetupShared'] || STAFF_PORTAL_STRINGS.en['drawer.field.roomSetupShared']);
console.log('ok booking-card room setup vs private-room toggle');
