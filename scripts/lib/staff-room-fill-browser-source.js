'use strict';

const fs = require('fs');
const path = require('path');

const STAFF_ROOM_FILL_INJECT_MARKER = '/* INJECT:staff-room-fill */';

function getStaffRoomFillBrowserSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'browser', 'staff-room-fill.js'), 'utf8');
}

function injectStaffRoomFillModule(html) {
  const idx = String(html || '').indexOf(STAFF_ROOM_FILL_INJECT_MARKER);
  if (idx < 0) return html;
  return html.slice(0, idx) + getStaffRoomFillBrowserSource() + html.slice(idx + STAFF_ROOM_FILL_INJECT_MARKER.length);
}

module.exports = {
  STAFF_ROOM_FILL_INJECT_MARKER,
  getStaffRoomFillBrowserSource,
  injectStaffRoomFillModule,
};
