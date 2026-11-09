'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    process.exitCode = 1;
  } else {
    console.log('PASS:', message);
  }
}

for (const id of ['svc-f-luna', 'svc-f-block-rooms']) {
  const input = `<input type="checkbox" id="${id}"`;
  assert(source.includes(input), `${id} checkbox is rendered`);
  const destructiveParent = new RegExp(`<label[^>]*data-i18n=[^>]*>[^<]*<input[^>]*id="${id}"`);
  assert(!destructiveParent.test(source), `${id} is not nested in a label whose translation replaces child controls`);
}

assert(/<input type="checkbox" id="svc-f-luna"[^>]*>\s*<span[^>]*data-i18n="admin\.wh\.services\.lunaOffer"/.test(source), 'Luna visibility translation is isolated in a child span');
assert(/<input type="checkbox" id="svc-f-block-rooms"[^>]*>\s*<span[^>]*data-i18n="admin\.wh\.services\.blockRooms"/.test(source), 'room-block translation is isolated in a child span');
assert(/class="portal-schedule-create-drawer portal-services-drawer"/.test(source), 'services dialog owns a scoped drawer class');
assert(/\.portal-services-drawer\{[^}]*padding:16px 22px 28px[^}]*overflow-y:auto/.test(source), 'services drawer fields have a consistent horizontal inset and remain scrollable');

if (process.exitCode) process.exit(process.exitCode);
console.log('Wolfhouse services drawer i18n control verification passed.');
